#!/usr/bin/env node
// registered-test-registration.test.mjs — Issue #37 canonical registration path.
// Proves registerRegisteredTest (the AUTHORIZED control-plane API) updates a live
// session's testRegistry without hand-editing the authoritative session JSON:
//   - binds to the correct task/session/repo/executionRoot (authority re-derived
//     via verifySessionAuthority),
//   - rejects unknown / stale / foreign / tampered sessions,
//   - rejects malformed / unsafe definitions (same Broker contract),
//   - idempotent for the same canonical definition, conflicts fail-closed,
//   - persists atomically so a rejected operation never corrupts the existing
//     session record (byte-identical), and a successful one stays canonical
//     (verifySessionAuthority still passes),
//   - the persisted registry is consumed correctly by run_registered_test.
// Real-FS tests (provisioned worktree + disposable snapshot) like the other
// runtime-sandbox / execution-broker suites.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import {
  taskStart, registerRegisteredTest, readSessionRecord, verifySessionAuthority,
} from '../packages/runtime-sandbox/runtime-sandbox.mjs';
import {
  createExecutionBroker, BROKER_SCHEMA_VERSION, SAFE_TEST_ID_RE, validateRegistryEntry,
} from '../packages/execution-broker/execution-broker.mjs';
import { identityHash, worktreePathFor, bindingPathFor } from '../packages/workspace/workspace.mjs';

const checks = [];
const eq = (n, g, w) => checks.push({ name: n, ok: g === w, got: g, want: w });
const tru = (n, g) => checks.push({ name: n, ok: Boolean(g), got: g });
const falsy = (n, g) => checks.push({ name: n, ok: !g, got: g });

const CANON = 'duongpdddic-droid/Soc_brain';
const TMP = mkdtempSync(path.join(os.tmpdir(), 'soc-reg-'));
const TMP_ROOT = path.join(TMP, 'worktrees');
mkdirSync(TMP_ROOT, { recursive: true });

function makeRepo() {
  const dir = mkdtempSync(path.join(TMP, 'repo-'));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'tester', GIT_AUTHOR_EMAIL: 't@e.x',
    GIT_COMMITTER_NAME: 'tester', GIT_COMMITTER_EMAIL: 't@e.x',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  };
  const run = (args) => {
    try {
      return execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      const stderr = (e.stderr || '') + ' | ' + (e.stdout || '');
      throw new Error('git ' + args.join(' ') + ' failed: ' + (stderr || e.message));
    }
  };
  run(['init', '--initial-branch=main', dir]);
  run(['config', 'user.email', 't@e.x']);
  run(['config', 'user.name', 'tester']);
  return {
    dir, run,
    commit: (file, content, msg = 'c') => {
      const fp = path.join(dir, file);
      const parent = path.dirname(fp);
      if (parent !== dir) mkdirSync(parent, { recursive: true });
      writeFileSync(fp, content);
      run(['add', file]);
      run(['commit', '-m', msg]);
      return run(['rev-parse', 'HEAD']).trim();
    },
    setRemote: (name, url) => {
      try { run(['remote', 'remove', name]); } catch {}
      run(['remote', 'add', name, url]);
    },
    dispose: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

function cleanupBound(issueNumber) {
  const h = identityHash({ repo: CANON, issueNumber });
  const wt = worktreePathFor({ worktreesRoot: TMP_ROOT, identityHash: h });
  const bp = bindingPathFor({ worktreesRoot: TMP_ROOT, identityHash: h });
  try { rmSync(wt, { recursive: true, force: true }); } catch {}
  try { rmSync(bp, { recursive: true, force: true }); } catch {}
}

// Provision a real session for `issueNumber` with a deterministic fixture in the
// worktree snapshot, and return the handles needed for registration + reboot.
function makeLive(issueNumber, stateDir) {
  const repo = makeRepo();
  repo.commit('rt-perm.cjs', 'process.stdout.write("perm-ok")');
  const baseSha = repo.commit('BASE.md', 'base\n');
  repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
  const start = taskStart({
    repo: CANON, issueNumber, baseSha, worktreesRoot: TMP_ROOT, stateDir, controlCwd: repo.dir, testRegistry: {},
  });
  return { repo, baseSha, start, dispose: () => { cleanupBound(issueNumber); repo.dispose(); } };
}

function regReq(sessionPath, leaseToken, testId, definition, controlCwd) {
  return { sessionPath, leaseToken, testId, definition, controlCwd };
}

// ---- Group A: valid registration + persisted registry consumed + canonical ----
{
  const stateDir = path.join(TMP, '_state_a');
  const { repo, baseSha, start, dispose } = makeLive(301, stateDir);
  try {
    tru('A taskStart ok', start.ok);
    if (start.ok) {
      const sp = start.session.path;
      const lease = start.session.leaseToken;
      const r = registerRegisteredTest(regReq(sp, lease, 'perm', { executable: 'node', argv: ['rt-perm.cjs'] }, repo.dir));
      tru('A register ok', r.ok);
      eq('A idempotent false', r.idempotent, false);
      eq('A testId echoed', r.testId, 'perm');
      eq('A persisted entry executable', r.definition.executable, 'node');

      // Persisted registry: testRegistry[perm] is present and normalized.
      const rs = readSessionRecord(sp);
      tru('A reread ok', rs.ok);
      if (rs.ok) {
        tru('A registry has perm', rs.session.testRegistry && rs.session.testRegistry.perm);
        eq('A entry argv[0]', rs.session.testRegistry.perm.argv[0], 'rt-perm.cjs');
      }

      // Not corrupted: the persisted record is still an authoritative session.
      const va = verifySessionAuthority({ sessionPath: sp, leaseToken: lease, controlCwd: repo.dir });
      tru('A authority still passes after register', va.ok);
      if (va.ok) tru('A lease token preserved', va.session.lease.token === lease);

      // Persisted registry consumed correctly by run_registered_test (reboot the
      // broker from session state, exactly as a live MCP server does).
      const rb = readSessionRecord(sp);
      if (rb.ok && rb.session.testRegistry) {
        const broker = createExecutionBroker({
          worktreesRoot: rb.session.worktreesRoot, controlCwd: repo.dir, testRegistry: rb.session.testRegistry,
        });
        const t = broker.executeBrokerRequest({
          schemaVersion: BROKER_SCHEMA_VERSION, operation: 'run_registered_test',
          repo: CANON, issueNumber: 301, baseSha, args: { testId: 'perm' },
        });
        tru('A run_registered_test ok', t.ok);
        if (t.ok) {
          eq('A run stdout', t.data.stdout, 'perm-ok');
          eq('A run exitCode 0', t.data.exitCode, 0);
          eq('A run timedOut false', t.data.timedOut, false);
          eq('A worktreeUnchanged true', t.evidence.worktreeUnchanged, true);
        }
      }
    }
  } finally { dispose(); }
}

// ---- Group B: idempotent same registration + conflict fail-closed -------------
{
  const stateDir = path.join(TMP, '_state_b');
  const { repo, start, dispose } = makeLive(302, stateDir);
  try {
    if (start.ok) {
      const sp = start.session.path;
      const lease = start.session.leaseToken;
      const def = { executable: 'node', argv: ['rt-perm.cjs'] };
      const r1 = registerRegisteredTest(regReq(sp, lease, 'perm', def, repo.dir));
      tru('B r1 ok', r1.ok);
      eq('B r1 idempotent false', r1.idempotent, false);

      const r2 = registerRegisteredTest(regReq(sp, lease, 'perm', def, repo.dir));
      tru('B r2 ok', r2.ok);
      eq('B r2 idempotent true', r2.idempotent, true);

      // Different argv (still a valid definition) -> conflict, fail-closed.
      const r3 = registerRegisteredTest(regReq(sp, lease, 'perm', { executable: 'node', argv: ['rt-perm.cjs', '--extra'] }, repo.dir));
      eq('B conflict reason', r3.reason, 'REGISTRY_REDEFINITION_CONFLICT');

      // Original is intact after the failed redefinition.
      const rs = readSessionRecord(sp);
      if (rs.ok) eq('B original argv length intact', rs.session.testRegistry.perm.argv.length, 1);
    }
  } finally { dispose(); }
}

// ---- Group C: wrong task / stale lease / unknown session rejected -------------
{
  const stateDir = path.join(TMP, '_state_c');
  const { repo, start, dispose } = makeLive(303, stateDir);
  try {
    if (start.ok) {
      const sp = start.session.path;
      const lease = start.session.leaseToken;
      const def = { executable: 'node', argv: ['rt-perm.cjs'] };

      // Stale lease -> authority denied (STALE_TASK_LEASE).
      const stale = registerRegisteredTest(regReq(sp, 'deadbeef', 'perm', def, repo.dir));
      eq('C stale reason', stale.reason, 'REGISTRATION_AUTHORITY_DENIED');
      eq('C stale authReason', stale.authReason, 'STALE_TASK_LEASE');

      // Unknown session (nonexistent canonical session file) -> authority denied.
      const unknown = registerRegisteredTest(regReq(path.join(stateDir, 'sessions', '0000000000000000000000000000000000000000.json'), 'x', 'perm', def, repo.dir));
      eq('C unknown reason', unknown.reason, 'REGISTRATION_AUTHORITY_DENIED');
      eq('C unknown authReason', unknown.authReason, 'SESSION_NOT_FOUND');

      // Neither rejected call mutated the registry.
      const rs = readSessionRecord(sp);
      if (rs.ok) eq('C registry still empty', Object.keys(rs.session.testRegistry || {}).length, 0);
    }
  } finally { dispose(); }
}

// ---- Group D: foreign / tampered execution root rejected ----------------------
{
  const stateDir = path.join(TMP, '_state_d');
  const { repo, start, dispose } = makeLive(304, stateDir);
  try {
    if (start.ok) {
      const sp = start.session.path;
      const lease = start.session.leaseToken;
      const rs = readSessionRecord(sp);
      if (rs.ok) {
        // Point the session's execution root at a foreign path outside the
        // authorized worktree root; it is NOT the task worktree.
        const tampered = { ...rs.session, worktreePath: path.join(os.tmpdir(), 'foreign-exec-root-305') };
        writeFileSync(sp, `${JSON.stringify(tampered, null, 2)}\n`, 'utf8');
        const r = registerRegisteredTest(regReq(sp, lease, 'perm', { executable: 'node', argv: ['rt-perm.cjs'] }, repo.dir));
        falsy('D foreign execRoot rejected', r.ok);
        eq('D foreign execRoot reason', r.reason, 'REGISTRATION_AUTHORITY_DENIED');
        tru('D authReason present', Boolean(r.authReason));
      }
    }
  } finally { dispose(); }
}

// ---- Group E: malformed / unsafe definition rejected + no corruption ----------
{
  const stateDir = path.join(TMP, '_state_e');
  const { repo, start, dispose } = makeLive(305, stateDir);
  try {
    if (start.ok) {
      const sp = start.session.path;
      const lease = start.session.leaseToken;
      const before = fs.readFileSync(sp);
      const cases = [
        { def: { executable: 'bash', argv: ['x'] }, want: 'FORBIDDEN_EXECUTABLE' },
        { def: { executable: 'node', argv: ['-e', 'process.exit(0)'] }, want: 'FORBIDDEN_EVAL_FLAG' },
        { def: { executable: 'node', argv: ['/etc/passwd'] }, want: 'FORBIDDEN_SCRIPT_PATH' },
        { def: { executable: 'node', argv: ['rt-perm.cjs'], env: { API_KEY: 'x' } }, want: 'FORBIDDEN_ENV_KEY' },
        { def: { executable: 'node', argv: ['rt-perm.cjs'], shell: true }, want: 'MALFORMED_REGISTRY_ENTRY' },
      ];
      for (const c of cases) {
        const r = registerRegisteredTest(regReq(sp, lease, 'perm', c.def, repo.dir));
        eq('E ' + c.want + ' reason', r.reason, 'UNAUTHORIZED_DEFINITION');
        eq('E ' + c.want + ' definitionReason', r.definitionReason, c.want);
      }
      // Never corrupted: every rejected definition left the session byte-identical.
      eq('E session byte-identical', fs.readFileSync(sp).equals(before), true);
    }
  } finally { dispose(); }
}

// ---- Group F: registry is session-scoped (does not leak to another session) ---
{
  const stateDir = path.join(TMP, '_state_f');
  const a = makeLive(306, stateDir);
  const b = makeLive(307, stateDir);
  try {
    if (a.start.ok) {
      const ra = registerRegisteredTest(regReq(a.start.session.path, a.start.session.leaseToken, 'perm', { executable: 'node', argv: ['rt-perm.cjs'] }, a.repo.dir));
      tru('F register on A ok', ra.ok);
      if (b.start.ok) {
        const rsB = readSessionRecord(b.start.session.path);
        if (rsB.ok) eq('F unrelated session B registry empty', Object.keys(rsB.session.testRegistry || {}).length, 0);
      }
    }
  } finally { a.dispose(); b.dispose(); }
}

// ---- summary ----------------------------------------------------------------
const pass = checks.filter((c) => c.ok).length;
for (const c of checks) if (!c.ok) console.log('FAIL', c.name, '=>', JSON.stringify(c.got), 'want', JSON.stringify(c.want));
console.log('\nTotal: ' + pass + '/' + checks.length + ' PASS');
// Best-effort cleanup
try { rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(pass === checks.length ? 0 : 1);
