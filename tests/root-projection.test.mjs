#!/usr/bin/env node
// root-projection.test.mjs — tests for refreshRootOpenCodeProjection (Issue #126).
// Real-FS tests: fixture canonical repo + taskStart admission + root projection
// lifecycle. Follows the workspace.test.mjs pattern (makeRepo, checks, summary).
// NO framework. Exit 0 = PASS, 1 = FAIL. Never prints lease tokens.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import {
  taskStart, readSessionRecord, refreshRootOpenCodeProjection,
} from '../packages/runtime-sandbox/runtime-sandbox.mjs';
import { readOpenCodeConfigDigest } from '../packages/runtime-sandbox/opencode-adapter.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';

const checks = [];
const eq = (n, g, w) => checks.push({ name: n, ok: g === w, got: g, want: w });
const tru = (n, g) => checks.push({ name: n, ok: Boolean(g), got: g });
const falsy = (n, g) => checks.push({ name: n, ok: !g, got: g });

const CANON = 'duongpdddic-droid/Soc_brain';
const CANON_URL = 'https://github.com/duongpdddic-droid/Soc_brain.git';
const TMP = mkdtempSync(path.join(os.tmpdir(), 'soc-rootproj-'));
const TMP_ROOT = path.join(TMP, 'worktrees');
const TMP_STATE = path.join(TMP, 'state');
mkdirSync(TMP_ROOT, { recursive: true });
mkdirSync(TMP_STATE, { recursive: true });

function makeRepo() {
  const dir = mkdtempSync(path.join(TMP, 'repo-'));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'tester', GIT_AUTHOR_EMAIL: 't@e.x',
    GIT_COMMITTER_NAME: 'tester', GIT_COMMITTER_EMAIL: 't@e.x',
    GIT_CONFIG_GLOBAL: os.platform() === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_SYSTEM: os.platform() === 'win32' ? 'NUL' : '/dev/null',
  };
  const run = (args, cwd = dir) => {
    try {
      return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      throw new Error('git ' + args.join(' ') + ' failed: ' + ((e.stderr || '') + (e.stdout || '') + e.message));
    }
  };
  run(['init', '--initial-branch=main', dir]);
  run(['config', 'user.email', 't@e.x']);
  run(['config', 'user.name', 'tester']);
  return {
    dir, run,
    commit: (file, content, msg = 'c') => {
      const fp = path.join(dir, file);
      mkdirSync(path.dirname(fp), { recursive: true });
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

const LANES = [];
function withLane(lane, fn) {
  const prev = process.env.SOC_LANE_ID;
  if (lane === undefined) delete process.env.SOC_LANE_ID;
  else process.env.SOC_LANE_ID = lane;
  LANES.push(prev);
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.SOC_LANE_ID;
    else process.env.SOC_LANE_ID = prev;
  }
}

// ---- fixture: admitted maintenance session (Issue #126 shape) ----------------
const control = makeRepo();
control.setRemote('origin', CANON_URL);
const baseSha = control.commit('README.md', 'fixture repo for root projection tests\n');
const admit = taskStart({
  repo: CANON, issueNumber: 9001, baseSha,
  worktreesRoot: TMP_ROOT, stateDir: TMP_STATE,
  controlCwd: control.dir,
  mutationLaneId: 'lane-root-projection-test',
});
if (!admit.ok) {
  console.log('FATAL fixture admission failed', JSON.stringify(admit.reason));
  process.exit(1);
}
const sessionPath = admit.worktree.sessionPath;
const leaseToken = admit.session.leaseToken; // fixture-local synthetic token; never printed

const stripSecrets = (r) => JSON.stringify({ ...r, session: { ...r.session, leaseToken: undefined }, worktree: { ...r.worktree, leaseToken: undefined }, mcpEnv: undefined, openCodeConfig: undefined });
falsy('fixture: result carries no token', stripSecrets(admit).includes(leaseToken));

// ---- input validation ---------------------------------------------------------
falsy('missing sessionPath', refreshRootOpenCodeProjection({ leaseToken: 'x', controlCwd: control.dir }).ok === true);
falsy('missing leaseToken', refreshRootOpenCodeProjection({ sessionPath, controlCwd: control.dir }).ok === true);
falsy('missing controlCwd', refreshRootOpenCodeProjection({ sessionPath, leaseToken: 'x' }).ok === true);

// ---- lane gates (no arbitrary lane may mint root authority) -------------------
{
  const r = withLane(undefined, () => refreshRootOpenCodeProjection({ sessionPath, leaseToken, controlCwd: control.dir }));
  falsy('no caller lane -> denied', r.ok);
  eq('no caller lane reason', r.reason, 'MUTATION_OWNER_UNIDENTIFIED');
}
{
  const r = withLane('lane-foreign-attacker', () => refreshRootOpenCodeProjection({ sessionPath, leaseToken, controlCwd: control.dir }));
  falsy('foreign lane -> denied', r.ok);
  eq('foreign lane reason', r.reason, 'MUTATION_OWNER_CONFLICT');
  eq('foreign lane reports owner', r.ownerLaneId, 'lane-root-projection-test');
}

// ---- wrong-session / foreign-session fail-closed ------------------------------
{
  const r = withLane('lane-root-projection-test', () => refreshRootOpenCodeProjection({ sessionPath: path.join(TMP_STATE, 'does-not-exist.json'), leaseToken, controlCwd: control.dir }));
  falsy('nonexistent session path -> denied', r.ok);
  eq('nonexistent session reason', r.reason, 'SESSION_AUTHORITY_DENIED');
  eq('nonexistent session detail', r.detail, 'SESSION_NOT_FOUND');
}
{
  // Session file exists but is NOT at its canonical location -> readSessionRecord fails.
  const rogue = path.join(TMP, 'rogue-session.json');
  fs.copyFileSync(sessionPath, rogue);
  const r = withLane('lane-root-projection-test', () => refreshRootOpenCodeProjection({ sessionPath: rogue, leaseToken, controlCwd: control.dir }));
  falsy('rogue session location -> denied', r.ok);
  eq('rogue session reason', r.reason, 'SESSION_AUTHORITY_DENIED');
}

// ---- target guards: wrong repo / overlapping worktree -------------------------
{
  const evil = makeRepo();
  evil.setRemote('origin', 'https://github.com/other/SomeOtherRepo.git');
  evil.commit('README.md', 'evil\n');
  const r = withLane('lane-root-projection-test', () => refreshRootOpenCodeProjection({ sessionPath, leaseToken, controlCwd: evil.dir }));
  falsy('non-canonical control checkout -> denied', r.ok);
  eq('wrong repo reason', r.reason, 'CONTROL_CWD_WRONG_REPO');
  evil.dispose();
}
{
  const target = path.join(admit.worktree.path, 'opencode.json');
  const r = withLane('lane-root-projection-test', () => refreshRootOpenCodeProjection({ sessionPath, leaseToken, controlCwd: admit.worktree.path }));
  falsy('controlCwd = execution worktree -> denied', r.ok);
  // The canonical guard chain denies deterministically before the overlap
  // guard: mainCheckoutGuard sees controlCwd == worktree and rejects first.
  eq('overlap denied via authority chain', r.reason, 'SESSION_AUTHORITY_DENIED');
  eq('overlap denial detail', r.detail, 'FORBIDDEN_CANONICAL_CHECKOUT');
  falsy('denied refresh wrote no CONTROL projection', fs.existsSync(path.join(control.dir, 'opencode.json')));
}

// ---- entrypoint must exist inside the canonical checkout ----------------------
{
  const r = withLane('lane-root-projection-test', () => refreshRootOpenCodeProjection({ sessionPath, leaseToken, controlCwd: control.dir }));
  falsy('missing entrypoint in control checkout -> denied', r.ok);
  eq('entrypoint missing reason', r.reason, 'ROOT_PROJECTION_ENTRYPOINT_MISSING');
}

// ---- happy path: write + persist digest + read-back ---------------------------
{
  const pkgDir = path.join(control.dir, 'packages', 'runtime-sandbox');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(path.join(pkgDir, 'mcp-server.mjs'), '// stub entrypoint for fixture\n');
  const before = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  const r = withLane('lane-root-projection-test', () => refreshRootOpenCodeProjection({ sessionPath, leaseToken, controlCwd: control.dir }));
  tru('happy path ok', r.ok === true);
  if (r.ok) {
    eq('projection path', r.path, path.join(control.dir, 'opencode.json'));
    tru('projection file exists', fs.existsSync(r.path));
    const disk = readOpenCodeConfigDigest({ worktreePath: control.dir });
    eq('digest matches disk', r.digest, disk.digest);
    const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    eq('persisted digest', session.controlPlaneProjection.digest, r.digest);
    eq('persisted path', session.controlPlaneProjection.path, r.path);
    // Identity chain untouched
    eq('identityHash untouched', session.identityHash, before.identityHash);
    eq('state untouched', session.state, before.state);
    eq('worktree digest untouched', session.digests.opencodeConfig, before.digests.opencodeConfig);
    eq('owner untouched', JSON.stringify(session.mutationOwner), JSON.stringify(before.mutationOwner));
    eq('worktree projection digest field intact', r.digest !== session.digests.opencodeConfig, true);
    tru('result leaks no token', !JSON.stringify(r).includes(leaseToken));
    const cfg = JSON.parse(fs.readFileSync(r.path, 'utf8'));
    eq('mcp server key', cfg.mcp['soc-brain'].type, 'local');
    eq('mcp enabled', cfg.mcp['soc-brain'].enabled, true);
    eq('entrypoint inside control checkout', cfg.mcp['soc-brain'].command[1], path.join(control.dir, 'packages', 'runtime-sandbox', 'mcp-server.mjs'));
    eq('env session path', cfg.mcp['soc-brain'].environment.SOC_SESSION_PATH, path.resolve(sessionPath));
    eq('env lane', cfg.mcp['soc-brain'].environment.SOC_LANE_ID, 'lane-root-projection-test');
    eq('env control cwd', cfg.mcp['soc-brain'].environment.SOC_CONTROL_CWD, path.resolve(control.dir));
    tru('env token present', typeof cfg.mcp['soc-brain'].environment.SOC_SESSION_TOKEN === 'string' && cfg.mcp['soc-brain'].environment.SOC_SESSION_TOKEN.length > 0);
    tru('config leaks no token in report field', !JSON.stringify({ ...r, path: r.path, entrypoint: r.entrypoint }).includes(leaseToken));
  }
}

// ---- idempotent reconnect: same authority, no second owner --------------------
{
  const first = JSON.parse(fs.readFileSync(sessionPath, 'utf8')).controlPlaneProjection;
  const r = withLane('lane-root-projection-test', () => refreshRootOpenCodeProjection({ sessionPath, leaseToken, controlCwd: control.dir }));
  tru('reconnect ok', r.ok === true);
  eq('reconnect idempotent', r.idempotent, true);
  eq('reconnect same digest', r.digest, first.digest);
  const after = JSON.parse(fs.readFileSync(sessionPath, 'utf8')).controlPlaneProjection;
  eq('record untouched on idempotent refresh', after.at, first.at);
  const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  eq('still single owner', session.mutationOwner.laneId, 'lane-root-projection-test');
}

// ---- drift: hand-tampered authority artifacts fail closed (no silent fallback)
{
  const wtProj = path.join(admit.worktree.path, 'opencode.json');
  const orig = fs.readFileSync(wtProj, 'utf8');
  fs.writeFileSync(wtProj, orig + '\n// hand edit\n');
  const r = withLane('lane-root-projection-test', () => refreshRootOpenCodeProjection({ sessionPath, leaseToken, controlCwd: control.dir }));
  falsy('tampered worktree projection -> denied', r.ok);
  eq('drift reason', r.reason, 'SESSION_AUTHORITY_DENIED');
  eq('drift detail', r.detail, 'RUNTIME_CONFIGURATION_MISMATCH');
  fs.writeFileSync(wtProj, orig); // restore byte-identical
  const r2 = withLane('lane-root-projection-test', () => refreshRootOpenCodeProjection({ sessionPath, leaseToken, controlCwd: control.dir }));
  tru('authority restored after byte-identical repair', r2.ok === true);
}

// ---- active task isolation: primitive touches ONLY the control projection -----
{
  const wtProj = path.join(admit.worktree.path, 'opencode.json');
  const binding = path.join(TMP_ROOT, 'bindings', identityHash({ repo: CANON, issueNumber: 9001 }) + '.json');
  const beforeWt = crypto.createHash('sha256').update(fs.readFileSync(wtProj)).digest('hex');
  const beforeBinding = crypto.createHash('sha256').update(fs.readFileSync(binding)).digest('hex');
  const sessionBefore = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  withLane('lane-root-projection-test', () => refreshRootOpenCodeProjection({ sessionPath, leaseToken, controlCwd: control.dir }));
  const afterWt = crypto.createHash('sha256').update(fs.readFileSync(wtProj)).digest('hex');
  const afterBinding = crypto.createHash('sha256').update(fs.readFileSync(binding)).digest('hex');
  eq('task worktree projection untouched', afterWt, beforeWt);
  eq('binding untouched', afterBinding, beforeBinding);
  const sessionAfter = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  const strip = (s) => { const c = { ...s }; delete c.controlPlaneProjection; return JSON.stringify(c); };
  eq('session record changed ONLY by controlPlaneProjection', strip(sessionAfter), strip(sessionBefore));
}

// ---- unbound session grants root authority to nobody --------------------------
{
  const admit2 = taskStart({
    repo: CANON, issueNumber: 9002, baseSha,
    worktreesRoot: TMP_ROOT, stateDir: TMP_STATE,
    controlCwd: control.dir,
  });
  tru('unbound admission ok', admit2.ok === true);
  if (admit2.ok) {
    const r = withLane('lane-root-projection-test', () => refreshRootOpenCodeProjection({ sessionPath: admit2.worktree.sessionPath, leaseToken: admit2.session.leaseToken, controlCwd: control.dir }));
    falsy('unbound session -> no root authority', r.ok);
    eq('unbound reason', r.reason, 'MUTATION_OWNER_UNBOUND');
  }
}

// ---- summary --------------------------------------------------------------------
const pass = checks.filter((c) => c.ok).length;
for (const c of checks) if (!c.ok) console.log('FAIL', c.name, '=>', JSON.stringify(c.got), 'want', JSON.stringify(c.want));
console.log('\nTotal: ' + pass + '/' + checks.length + ' PASS');
try { rmSync(TMP, { recursive: true, force: true }); } catch {}
try { control.dispose(); } catch {}
process.exit(pass === checks.length ? 0 : 1);
