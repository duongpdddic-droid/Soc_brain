#!/usr/bin/env node
// execution-broker-circuit-breaker.test.mjs — tests for the Repeated-Action
// Circuit Breaker v0 (Issue #61) in packages/execution-broker.
// Part 1 (pure, no FS): identity normalization, threshold bounds, per-action
// state machine (trip exactly once, success resets, different actions never
// merge, malformed identity fail-safe).
// Part 2 (real-FS, same fixture style as execution-broker.test.mjs): the
// breaker wired into createExecutionBroker — identical failing registered
// tests trip after the threshold and are then blocked WITHOUT execution
// (no data/evidence fields), other actions keep running, a same-identity
// success clears stale failure history, bounded config flows through.
// NO framework. Exit 0 = PASS, 1 = FAIL.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createExecutionBroker,
  normalizeBrokerActionIdentity,
  createCircuitBreaker,
  CB_DEFAULT_THRESHOLD,
  CB_MIN_THRESHOLD,
  CB_MAX_THRESHOLD,
  BROKER_SCHEMA_VERSION,
} from '../packages/execution-broker/execution-broker.mjs';
import { provision, identityHash, worktreePathFor, bindingPathFor } from '../packages/workspace/workspace.mjs';

const checks = [];
const eq = (n, g, w) => checks.push({ name: n, ok: g === w, got: g, want: w });
const tru = (n, g) => checks.push({ name: n, ok: Boolean(g), got: g });
const falsy = (n, g) => checks.push({ name: n, ok: !g, got: g });

const CANON = 'duongpdddic-droid/Soc_brain';
const TMP = mkdtempSync(path.join(os.tmpdir(), 'soc-ebcb-'));
const TMP_ROOT = path.join(TMP, 'worktrees');

// ---- Part 1: pure module ----------------------------------------------------

// Normalization: identical action -> identical identity.
{
  const a = normalizeBrokerActionIdentity({ operation: 'status', repo: 'o/r', issueNumber: 1, baseSha: 'a'.repeat(40) });
  const b = normalizeBrokerActionIdentity({ operation: 'status', repo: 'o/r', issueNumber: 1, baseSha: 'a'.repeat(40) });
  tru('N1 status identity stable', a.ok && b.ok && a.key === b.key && a.keyHash === b.keyHash);

  const s1 = normalizeBrokerActionIdentity({ operation: 'diff', diffMode: 'working_tree' });
  const s2 = normalizeBrokerActionIdentity({ operation: 'diff', diffMode: 'staged' });
  tru('N2 diff mode differs -> different identity', s1.ok && s2.ok && s1.keyHash !== s2.keyHash);

  const t1 = normalizeBrokerActionIdentity({ operation: 'run_registered_test', testId: 'a' });
  const t2 = normalizeBrokerActionIdentity({ operation: 'run_registered_test', testId: 'b' });
  tru('N3 testId differs -> different identity', t1.ok && t2.ok && t1.keyHash !== t2.keyHash);
  tru('N3a same testId -> same identity', t1.keyHash === normalizeBrokerActionIdentity({ operation: 'run_registered_test', testId: 'a' }).keyHash);

  // Commit paths are SET semantics: order-insensitive, message/paths matter.
  const c1 = normalizeBrokerActionIdentity({ operation: 'commit', message: 'fix: x', paths: ['a.txt', 'b.txt'] });
  const c2 = normalizeBrokerActionIdentity({ operation: 'commit', message: 'fix: x', paths: ['b.txt', 'a.txt'] });
  const c3 = normalizeBrokerActionIdentity({ operation: 'commit', message: 'fix: y', paths: ['a.txt', 'b.txt'] });
  const c4 = normalizeBrokerActionIdentity({ operation: 'commit', message: 'fix: x', paths: ['a.txt'] });
  tru('N4 commit path order-insensitive', c1.ok && c2.ok && c1.keyHash === c2.keyHash);
  tru('N4a different message -> different identity', c1.keyHash !== c3.keyHash);
  tru('N4b different path set -> different identity', c1.keyHash !== c4.keyHash);

  // Different operations NEVER merge, even with equal canonical args.
  const st = normalizeBrokerActionIdentity({ operation: 'status' });
  const df = normalizeBrokerActionIdentity({ operation: 'diff', diffMode: undefined });
  tru('N5 status vs diff never merge', st.keyHash !== df.keyHash);

  // Malformed/missing identity: fail-safe (ok:false, no throw, no crash).
  for (const bad of [null, undefined, 42, 'x', {}, { operation: 7 }, { operation: 'commit', paths: null }]) {
    const r = normalizeBrokerActionIdentity(bad);
    falsy(`N6 malformed identity (${JSON.stringify(bad)}) -> ok:false`, r.ok);
  }
  // Hostile/extra fields (incl. circular) are ignored: identity reads ONLY the
  // validated normalized fields, so a weird object can never crash the
  // normalization and never changes the identity of the same operation+args.
  const circ = { operation: 'status' };
  circ.self = circ;
  const circId = normalizeBrokerActionIdentity(circ);
  tru('N7 hostile object with circular field: no crash, ok:true', circId.ok);
  tru('N7a extra fields do not change identity', circId.keyHash === normalizeBrokerActionIdentity({ operation: 'status' }).keyHash);
}

// Threshold bounds: bounded config, safe default, never crash.
{
  eq('T1 default threshold', createCircuitBreaker().threshold, CB_DEFAULT_THRESHOLD);
  for (const bad of [0, 1, CB_MAX_THRESHOLD + 1, NaN, Infinity, '3', null, 3.5]) {
    eq(`T2 invalid threshold (${String(bad)}) -> default`, createCircuitBreaker({ threshold: bad }).threshold, CB_DEFAULT_THRESHOLD);
  }
  eq('T3 min bound accepted', createCircuitBreaker({ threshold: CB_MIN_THRESHOLD }).threshold, CB_MIN_THRESHOLD);
  eq('T4 max bound accepted', createCircuitBreaker({ threshold: CB_MAX_THRESHOLD }).threshold, CB_MAX_THRESHOLD);
}

// State machine: below-threshold, trip exactly once, per-action isolation,
// success reset, malformed-key fail-safe.
{
  const cb = createCircuitBreaker({ threshold: 3 });
  const K = 'op-a';
  const K2 = 'op-b';
  let st = cb.recordFailure(K, 'X1');
  falsy('S1 below threshold: no trip', st.tripped);
  st = cb.recordFailure(K, 'X1');
  falsy('S1a below threshold: still no trip', st.tripped);
  eq('S1b counter tracks', cb.stateFor(K).failures, 2);
  falsy('S1c not open', cb.isOpen(K));

  st = cb.recordFailure(K, 'X1');
  tru('S2 threshold reached: trip', st.tripped === true && st.failures === 3 && st.threshold === 3);
  tru('S2a trip evidence carries lastReason + keyHash', st.lastReason === 'X1' && /^[0-9a-f]{64}$/.test(st.keyHash));
  tru('S2b state open', cb.isOpen(K));

  st = cb.recordFailure(K, 'X1');
  falsy('S3 already open: NO second trip', st.tripped);
  tru('S3a still open', cb.isOpen(K));

  // Different action -> separate counter, no merge, still runnable.
  st = cb.recordFailure(K2, 'Y1');
  falsy('S4 other action unaffected by open A', st.tripped && st.alreadyOpen);
  eq('S4a other action counter independent', cb.stateFor(K2).failures, 1);

  // Success of the SAME identity resets history; another identity's success
  // does not clear A.
  cb.recordSuccess(K2);
  eq('S5 success clears own history', cb.stateFor(K2).failures, 0);
  tru('S5a A still open after B success', cb.isOpen(K));
  const cb2 = createCircuitBreaker({ threshold: 3 });
  cb2.recordFailure('k', 'r'); cb2.recordFailure('k', 'r');
  cb2.recordSuccess('k');
  eq('S6 success resets consecutive count', cb2.stateFor('k').failures, 0);
  cb2.recordFailure('k', 'r'); cb2.recordFailure('k', 'r');
  falsy('S6a 2 more failures after reset: no trip (4 total, never 3 consecutive)', cb2.isOpen('k'));
  tru('S6b 3rd consecutive after reset trips fresh', cb2.recordFailure('k', 'r').tripped);

  // Malformed key: fail-safe, no crash.
  falsy('S7 malformed key failure -> ok:false', cb.recordFailure(null, 'r').ok);
  falsy('S7a malformed key success -> ok:false', cb.recordSuccess(42).ok);
  falsy('S7b empty key -> ok:false', cb.recordSuccess('').ok);
  tru('S7c breaker still functional after malformed keys', cb.recordFailure('fresh', 'r').ok);
}

// ---- Part 2: integration through createExecutionBroker ----------------------

// Minimal real-FS fixture (same shape as execution-broker.test.mjs).
const FIXTURES = {
  'rt-fail.cjs': 'process.exit(3)',
  'rt-hello.cjs': 'process.stdout.write("hi")',
};
function makeRepo() {
  const dir = mkdtempSync(path.join(TMP, 'repo-'));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'tester', GIT_AUTHOR_EMAIL: 't@e.x',
    GIT_COMMITTER_NAME: 'tester', GIT_COMMITTER_EMAIL: 't@e.x',
    GIT_CONFIG_GLOBAL: os.platform() === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_SYSTEM: os.platform() === 'win32' ? 'NUL' : '/dev/null',
  };
  const run = (args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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
    setRemote: (name, url) => { try { run(['remote', 'remove', name]); } catch {} run(['remote', 'add', name, url]); },
    dispose: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}
function cleanupBound(issueNumber) {
  const h = identityHash({ repo: CANON, issueNumber });
  try { rmSync(worktreePathFor({ worktreesRoot: TMP_ROOT, identityHash: h }), { recursive: true, force: true }); } catch {}
  try { rmSync(bindingPathFor({ worktreesRoot: TMP_ROOT, identityHash: h }), { recursive: true, force: true }); } catch {}
}
function makeBound(issueNumber) {
  const repo = makeRepo();
  for (const [name, code] of Object.entries(FIXTURES)) repo.commit(name, code);
  const baseSha = repo.commit('BASE.md', 'base\n');
  repo.setRemote('origin', 'https://github.com/duongpdddic-droid/Soc_brain.git');
  const p = provision({ worktreesRoot: TMP_ROOT, repo: CANON, issueNumber, baseSha, cwd: repo.dir });
  if (!p.ok) throw new Error('provision failed: ' + p.reason + ' ' + (p.detail || ''));
  const req = (operation, args) => ({
    schemaVersion: BROKER_SCHEMA_VERSION, operation, repo: CANON, issueNumber, baseSha, args: args || {},
  });
  return { repo, req };
}

// Group A: identical failing action trips once, then blocks without executing.
{
  const { repo, req } = makeBound(6101);
  try {
    const reg = { fail: { executable: 'node', argv: ['rt-fail.cjs'] }, hello: { executable: 'node', argv: ['rt-hello.cjs'] } };
    const broker = createExecutionBroker({ worktreesRoot: TMP_ROOT, controlCwd: repo.dir, testRegistry: reg, circuitBreakerThreshold: 3 });
    const f1 = broker.executeBrokerRequest(req('run_registered_test', { testId: 'fail' }));
    const f2 = broker.executeBrokerRequest(req('run_registered_test', { testId: 'fail' }));
    tru('A1 identical failing action below threshold: real result', f1.ok === false && f2.ok === false && f1.reason === 'TEST_NONZERO_EXIT');
    falsy('A1a no circuitBreaker evidence below threshold', f1.circuitBreaker || f2.circuitBreaker);

    const f3 = broker.executeBrokerRequest(req('run_registered_test', { testId: 'fail' }));
    tru('A2 threshold reached: REAL result preserved', f3.ok === false && f3.reason === 'TEST_NONZERO_EXIT');
    tru('A2a trip evidence attached', Boolean(f3.circuitBreaker) && f3.circuitBreaker.tripped === true);
    eq('A2b trip evidence fields', `${f3.circuitBreaker.failures}/${f3.circuitBreaker.threshold}/${f3.circuitBreaker.reason}/${f3.circuitBreaker.lastReason}`, '3/3/REPEATED_IDENTICAL_FAILURE/TEST_NONZERO_EXIT');
    tru('A2c stable actionKeyHash', /^[0-9a-f]{64}$/.test(f3.circuitBreaker.actionKeyHash));

    const f4 = broker.executeBrokerRequest(req('run_registered_test', { testId: 'fail' }));
    eq('A3 identical retry blocked', f4.reason, 'CIRCUIT_BREAKER_TRIPPED');
    eq('A3a same actionKeyHash', f4.circuitBreaker.actionKeyHash, f3.circuitBreaker.actionKeyHash);
    falsy('A3b blocked WITHOUT executing (no data/evidence)', f4.data || f4.evidence);
    const f5 = broker.executeBrokerRequest(req('run_registered_test', { testId: 'fail' }));
    eq('A3c still blocked, trip NOT re-emitted', f5.reason, 'CIRCUIT_BREAKER_TRIPPED');
    falsy('A3d blocked response is not a second trip', f5.circuitBreaker && f5.circuitBreaker.tripped === true);

    // Other actions still run on the same broker.
    const s = broker.executeBrokerRequest(req('status'));
    tru('A4 different action (status) unaffected', s.ok === true && !s.circuitBreaker);
    const h = broker.executeBrokerRequest(req('run_registered_test', { testId: 'hello' }));
    tru('A4a different testId unaffected', h.ok === true && h.data.exitCode === 0);
  } finally { repo.dispose(); cleanupBound(6101); }
}

// Group B: same-identity success clears stale failure history (commit loop).
{
  const { repo, req } = makeBound(6102);
  try {
    const broker = createExecutionBroker({ worktreesRoot: TMP_ROOT, controlCwd: repo.dir, circuitBreakerThreshold: 3 });
    const commitReq = () => req('commit', { message: 'fix: repeated loop probe', paths: ['BASE.md'] });
    const c1 = broker.executeBrokerRequest(commitReq());
    const c2 = broker.executeBrokerRequest(commitReq());
    tru('B1 identical commit fails deterministically (NOTHING_TO_COMMIT)', c1.ok === false && c1.reason === 'NOTHING_TO_COMMIT' && c2.ok === false && c2.reason === 'NOTHING_TO_COMMIT');

    // Worktree change makes the SAME identity succeed -> history cleared.
    const wt = worktreePathFor({ worktreesRoot: TMP_ROOT, identityHash: identityHash({ repo: CANON, issueNumber: 6102 }) });
    writeFileSync(path.join(wt, 'BASE.md'), 'base\nchanged\n');
    const c3 = broker.executeBrokerRequest(commitReq());
    tru('B2 same identity now succeeds', c3.ok === true);

    // Back to clean: two more failures must NOT trip (2 < 3 after reset).
    execFileSync('git', ['checkout', '--', 'BASE.md'], { cwd: wt, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const c4 = broker.executeBrokerRequest(commitReq());
    const c5 = broker.executeBrokerRequest(commitReq());
    tru('B3 stale history not counted after success', c4.ok === false && c4.reason === 'NOTHING_TO_COMMIT' && !c4.circuitBreaker && !c5.circuitBreaker);
  } finally { repo.dispose(); cleanupBound(6102); }
}

// Group C: bounded config flows through; invalid config falls back to default.
{
  const { repo, req } = makeBound(6103);
  try {
    const reg = { fail: { executable: 'node', argv: ['rt-fail.cjs'] } };
    const brokerMax = createExecutionBroker({ worktreesRoot: TMP_ROOT, controlCwd: repo.dir, testRegistry: reg, circuitBreakerThreshold: 10 });
    for (let i = 0; i < 3; i++) brokerMax.executeBrokerRequest(req('run_registered_test', { testId: 'fail' }));
    const last = brokerMax.executeBrokerRequest(req('run_registered_test', { testId: 'fail' }));
    tru('C1 threshold=10: 4 failures do not trip', last.ok === false && last.reason === 'TEST_NONZERO_EXIT' && !last.circuitBreaker);

    const brokerBad = createExecutionBroker({ worktreesRoot: TMP_ROOT, controlCwd: repo.dir, testRegistry: reg, circuitBreakerThreshold: 999 });
    const b1 = brokerBad.executeBrokerRequest(req('run_registered_test', { testId: 'fail' }));
    const b2 = brokerBad.executeBrokerRequest(req('run_registered_test', { testId: 'fail' }));
    const b3 = brokerBad.executeBrokerRequest(req('run_registered_test', { testId: 'fail' }));
    tru('C2 invalid config -> safe default 3 trips', b3.ok === false && Boolean(b3.circuitBreaker) && b3.circuitBreaker.tripped === true && b3.circuitBreaker.threshold === 3);
    falsy('C2a below threshold no evidence', b1.circuitBreaker || b2.circuitBreaker);
    const b4 = brokerBad.executeBrokerRequest(req('run_registered_test', { testId: 'fail' }));
    eq('C3 blocked after default-threshold trip', b4.reason, 'CIRCUIT_BREAKER_TRIPPED');
  } finally { repo.dispose(); cleanupBound(6103); }
}

// ---- summary ----------------------------------------------------------------

let failed = 0;
for (const c of checks) {
  if (!c.ok) {
    failed++;
    console.error(`FAIL ${c.name}${'got' in c ? ` | got=${JSON.stringify(c.got)}${'want' in c ? ` want=${JSON.stringify(c.want)}` : ''}` : ''}`);
  }
}
console.log(`execution-broker-circuit-breaker: ${checks.length - failed}/${checks.length} checks passed`);
try { rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(failed ? 1 : 0);





