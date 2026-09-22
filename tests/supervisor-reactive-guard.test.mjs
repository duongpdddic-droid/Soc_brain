// tests/supervisor-reactive-guard.test.mjs — Supervisor Reactive Engine & Drift Guard.
// 100% offline: no network, no live GitHub, no Telegram. All fixtures in tmp dirs.
//
// Group A — Reactive Transitions (EventEmitter chain, zero polling latency)
// Group B — Scope & Drift Guard (OUT_OF_BOUNDS_MUTATION + test integrity)
// Group C — Anti-Loop & Thrashing (>3 repeated no-ops => flag)
// Group D — 3-Way Integrity (Session == Ledger == Disk, fail-closed on any drift)
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

import {
  createReactiveEngine,
  REACTIVE_CHAIN,
  ZERO_LATENCY_BUDGET_MS,
  REACTIVE_EVENTS,
} from '../packages/supervisor/reactive-engine.mjs';
import {
  checkScope,
  checkTestIntegrity,
  captureTestBaseline,
  createBehaviorGuard,
  DRIFT_CODES,
} from '../packages/supervisor/drift-guard.mjs';
import {
  audit3Way,
  makeAuditFn,
  AUDIT_CODES,
} from '../packages/supervisor/integrity-audit.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';

const REPO = 'duongpdddic-droid/Soc_brain';
const ISSUE = 9000099;
const HEAD40 = 'a'.repeat(40);

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function mkIdentity() {
  return identityHash({ repo: REPO, issueNumber: ISSUE });
}

// ---------------------------------------------------------------------------
// Group A — Reactive Transitions
// ---------------------------------------------------------------------------
test('A1: runChain walks ROUTED->EXECUTING->VERIFYING->FINAL_REVIEWING in one sync tick with no polling', () => {
  const stateDir = mkTmp('sup-a1-');
  const id = mkIdentity();
  const engine = createReactiveEngine({ stateDir, identityHash: id });

  const seen = [];
  engine.onTransition((rec) => seen.push(`${rec.from}->${rec.to}`));

  // Monotonic clock is Date.now (real). Full chain must complete under budget
  // with NO sleep/setInterval — measured end-to-end.
  const result = engine.runChain({ startState: 'ACCEPTED' });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.blocked, false);
  assert.deepEqual(seen, [
    'ACCEPTED->ROUTED',
    'ROUTED->EXECUTING',
    'EXECUTING->VERIFYING',
    'VERIFYING->FINAL_REVIEWING',
  ]);
  // Zero-latency contract: entire chain under 200ms.
  assert.ok(result.elapsedMs < ZERO_LATENCY_BUDGET_MS,
    `chain took ${result.elapsedMs}ms, budget ${ZERO_LATENCY_BUDGET_MS}ms`);
  assert.equal(result.latencyWithinBudget, true);
  // Execution-finalized fires exactly once when EXECUTING->VERIFYING lands.
  assert.equal(result.executionFinalized, true);
  assert.equal(engine.wasExecutionFinalized(), true);
});

test('A2: transitions are event-driven — onExecutionFinalized fires synchronously during the chain', () => {
  const stateDir = mkTmp('sup-a2-');
  const id = mkIdentity();
  const engine = createReactiveEngine({ stateDir, identityHash: id });

  let finalized = null;
  let order = [];
  engine.onTransition((rec) => order.push(`t:${rec.to}`));
  engine.onExecutionFinalized((rec) => { finalized = rec; order.push('finalized'); });

  const r = engine.runChain({ startState: 'ACCEPTED' });
  assert.equal(r.ok, true);
  assert.ok(finalized, 'executionFinalized must have fired');
  assert.equal(finalized.from, 'EXECUTING');
  assert.equal(finalized.to, 'VERIFYING');
  // Engine contract: the EXECUTING->VERIFYING transition event fires first,
  // then executionFinalized for that same hop, then the chain continues to
  // FINAL_REVIEWING. finalized sits between t:VERIFYING and t:FINAL_REVIEWING.
  const idxVerify = order.indexOf('t:VERIFYING');
  const idxFin = order.indexOf('finalized');
  const idxFinal = order.indexOf('t:FINAL_REVIEWING');
  assert.ok(idxVerify >= 0 && idxFin >= 0 && idxFinal >= 0, `order=${JSON.stringify(order)}`);
  assert.ok(idxVerify < idxFin, `finalized must follow the VERIFYING transition: ${JSON.stringify(order)}`);
  assert.ok(idxFin < idxFinal, `finalized must precede FINAL_REVIEWING: ${JSON.stringify(order)}`);
});

test('A3: chain is fully synchronous — no await boundary between hops (latency == 0 with injected clocks)', () => {
  const stateDir = mkTmp('sup-a3-');
  const id = mkIdentity();
  // Inject a frozen monotonic clock: any real timer/poll would still advance
  // Date.now, but our frozen clock proves the engine does NOT depend on wall
  // time between hops (elapsedMs is exactly 0 when time is frozen).
  let frozen = 1000;
  const engine = createReactiveEngine({
    stateDir, identityHash: id,
    monotonic: () => frozen, // never advances
    now: () => new Date(0).toISOString(),
  });
  const r = engine.runChain({ startState: 'ACCEPTED' });
  assert.equal(r.ok, true);
  assert.equal(r.elapsedMs, 0, 'frozen clock => 0ms means no wall-clock wait between hops');
  assert.equal(engine.history().length, 4);
});

test('A4: illegal transition blocks the engine and emits onBlocked', () => {
  const stateDir = mkTmp('sup-a4-');
  const id = mkIdentity();
  const engine = createReactiveEngine({ stateDir, identityHash: id });
  let blockedPayload = null;
  engine.onBlocked((p) => { blockedPayload = p; });

  const bad = engine.transition({ from: 'ACCEPTED', to: 'COMPLETED' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'ILLEGAL_TRANSITION');
  assert.equal(engine.isBlocked(), true);
  assert.ok(blockedPayload);
  assert.equal(blockedPayload.code, 'ILLEGAL_TRANSITION');

  // Further transitions are refused fail-closed.
  const after = engine.transition({ from: 'ACCEPTED', to: 'ROUTED' });
  assert.equal(after.ok, false);
  assert.equal(after.code, 'ENGINE_BLOCKED');
});

test('A5: ledger read-back — every hop is persisted to transitions.jsonl before success is claimed', () => {
  const stateDir = mkTmp('sup-a5-');
  const id = mkIdentity();
  const engine = createReactiveEngine({ stateDir, identityHash: id });
  const r = engine.runChain({ startState: 'ACCEPTED' });
  assert.equal(r.ok, true);

  const fp = path.join(stateDir, 'control-loop', id, 'transitions.jsonl');
  assert.ok(fs.existsSync(fp), 'ledger file must exist');
  const lines = fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 4);
  const parsed = lines.map((l) => JSON.parse(l));
  assert.deepEqual(parsed.map((p) => p.to), ['ROUTED', 'EXECUTING', 'VERIFYING', 'FINAL_REVIEWING']);
  assert.equal(parsed[0].identityHash, id);
});

// ---------------------------------------------------------------------------
// Group B — Scope & Drift Guard
// ---------------------------------------------------------------------------
test('B1: OUT_OF_BOUNDS_MUTATION — file outside Task Contract scope is caught', () => {
  const allowed = ['packages/supervisor/', 'tests/supervisor-reactive-guard.test.mjs'];

  const inScope = checkScope({
    allowedPaths: allowed,
    mutatedPaths: ['packages/supervisor/reactive-engine.mjs', 'tests/supervisor-reactive-guard.test.mjs'],
  });
  assert.equal(inScope.ok, true);

  const oob = checkScope({
    allowedPaths: allowed,
    mutatedPaths: ['packages/supervisor/reactive-engine.mjs', 'packages/control-loop/control-loop.mjs'],
  });
  assert.equal(oob.ok, false);
  assert.equal(oob.code, DRIFT_CODES.OUT_OF_BOUNDS_MUTATION);
  assert.deepEqual(oob.detail.violations, ['packages/control-loop/control-loop.mjs']);
});

test('B2: SCOPE_UNDECLARED — empty/missing allowedPaths fails closed', () => {
  const r1 = checkScope({ allowedPaths: [], mutatedPaths: ['x.js'] });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, DRIFT_CODES.SCOPE_UNDECLARED);
  const r2 = checkScope({ allowedPaths: null, mutatedPaths: [] });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, DRIFT_CODES.SCOPE_UNDECLARED);
});

test('B3: TEST_INTEGRITY_VIOLATION — deleted test file or removed test cases are caught', () => {
  const root = mkTmp('sup-b3-');
  const testsDir = path.join(root, 'tests');
  fs.mkdirSync(testsDir, { recursive: true });
  const fp = path.join(testsDir, 'legacy.test.mjs');
  fs.writeFileSync(fp, [
    "import { test } from 'node:test';",
    "import assert from 'node:assert';",
    "test('one', () => { assert.equal(1, 1); });",
    "test('two', () => { assert.equal(2, 2); });",
    "test('three', () => { assert.ok(true); assert.ok(false); });",
  ].join('\n'), 'utf8');

  const baseline = captureTestBaseline({ rootDir: root, testGlobDirs: ['tests'] });
  assert.equal(baseline['tests/legacy.test.mjs'].testCount, 3);
  assert.ok(baseline['tests/legacy.test.mjs'].assertCount >= 4);

  // Healthy tree passes.
  const healthy = checkTestIntegrity({ rootDir: root, baseline });
  assert.equal(healthy.ok, true);

  // Remove one test case => violation.
  fs.writeFileSync(fp, [
    "import { test } from 'node:test';",
    "import assert from 'node:assert';",
    "test('one', () => { assert.equal(1, 1); });",
    "test('two', () => { assert.equal(2, 2); });",
  ].join('\n'), 'utf8');
  const removed = checkTestIntegrity({ rootDir: root, baseline });
  assert.equal(removed.ok, false);
  assert.equal(removed.code, DRIFT_CODES.TEST_INTEGRITY_VIOLATION);
  assert.ok(removed.detail.violations.some((v) => v.reason === 'TEST_CASES_REMOVED'));

  // Delete the whole file => violation.
  fs.unlinkSync(fp);
  const deleted = checkTestIntegrity({ rootDir: root, baseline });
  assert.equal(deleted.ok, false);
  assert.ok(deleted.detail.violations.some((v) => v.reason === 'TEST_FILE_DELETED'));
});

test('B4: TEST_INTEGRITY_VIOLATION — weakened asserts (fewer assert calls) are caught', () => {
  const root = mkTmp('sup-b4-');
  const testsDir = path.join(root, 'tests');
  fs.mkdirSync(testsDir, { recursive: true });
  const fp = path.join(testsDir, 'old.test.mjs');
  fs.writeFileSync(fp, [
    "import { test } from 'node:test';",
    "import assert from 'node:assert';",
    "test('strict', () => { assert.equal(1, 1); assert.ok(true); assert.deepEqual([1], [1]); });",
  ].join('\n'), 'utf8');

  const baseline = captureTestBaseline({ rootDir: root, testGlobDirs: ['tests'] });
  const baseAsserts = baseline['tests/old.test.mjs'].assertCount;
  assert.ok(baseAsserts >= 3);

  // Weaken: drop two assert calls but keep the test() so testCount is unchanged.
  fs.writeFileSync(fp, [
    "import { test } from 'node:test';",
    "import assert from 'node:assert';",
    "test('strict', () => { assert.ok(true); });",
  ].join('\n'), 'utf8');
  const r = checkTestIntegrity({ rootDir: root, baseline });
  assert.equal(r.ok, false);
  assert.equal(r.code, DRIFT_CODES.TEST_INTEGRITY_VIOLATION);
  assert.ok(r.detail.violations.some((v) => v.reason === 'ASSERTS_WEAKENED'));
});

// ---------------------------------------------------------------------------
// Group C — Anti-Loop & Thrashing
// ---------------------------------------------------------------------------
test('C1: >3 identical glob/read calls with no new code flags THRASHING_NO_OP', () => {
  const guard = createBehaviorGuard({ repeatThreshold: 3 });

  // First three identical reads: still under threshold (streak 1..3).
  let s = guard.observe({ tool: 'glob', pattern: 'tests/*.test.mjs' });
  assert.equal(s.thrashing, false, `streak after 1: flags=${s.flags}`);
  s = guard.observe({ tool: 'glob', pattern: 'tests/*.test.mjs' });
  assert.equal(s.thrashing, false, `streak after 2: flags=${s.flags}`);
  s = guard.observe({ tool: 'glob', pattern: 'tests/*.test.mjs' });
  assert.equal(s.thrashing, false, `streak after 3: flags=${s.flags}`);

  // 4th identical read (>3) with no productive code action => thrashing.
  s = guard.observe({ tool: 'glob', pattern: 'tests/*.test.mjs' });
  assert.equal(s.thrashing, true, `streak after 4 should thrash: ${JSON.stringify(s)}`);
  assert.ok(s.flags.includes(DRIFT_CODES.THRASHING_NO_OP));
});

test('C2: a productive write/edit resets the no-op streak (no false thrashing)', () => {
  const guard = createBehaviorGuard({ repeatThreshold: 3 });
  guard.observe({ tool: 'read', pattern: 'a.mjs' });
  guard.observe({ tool: 'read', pattern: 'a.mjs' });
  guard.observe({ tool: 'read', pattern: 'a.mjs' });
  // Produce code — resets streak.
  guard.observe({ tool: 'edit', pattern: 'a.mjs', producedNewCode: true });
  let s = guard.observe({ tool: 'read', pattern: 'a.mjs' });
  assert.equal(s.thrashing, false, JSON.stringify(s));
  s = guard.observe({ tool: 'read', pattern: 'a.mjs' });
  assert.equal(s.thrashing, false, JSON.stringify(s));
  s = guard.observe({ tool: 'read', pattern: 'a.mjs' });
  assert.equal(s.thrashing, false, JSON.stringify(s));
  s = guard.observe({ tool: 'read', pattern: 'a.mjs' });
  // This is the 4th read since the edit — SHOULD thrash again (>3 with no code).
  assert.equal(s.thrashing, true, JSON.stringify(s));
});

test('C3: different patterns do not accumulate into one streak', () => {
  const guard = createBehaviorGuard({ repeatThreshold: 3 });
  guard.observe({ tool: 'glob', pattern: 'x/**' });
  guard.observe({ tool: 'glob', pattern: 'y/**' });
  guard.observe({ tool: 'glob', pattern: 'z/**' });
  guard.observe({ tool: 'glob', pattern: 'x/**' }); // pattern changed => streak restarts at 1
  const s = guard.observe({ tool: 'glob', pattern: 'x/**' }); // streak 2
  assert.equal(s.thrashing, false, JSON.stringify(s));
});

test('C4: >3 consecutive fix attempts without fail-count reduction flags STUCK_NO_IMPROVEMENT', () => {
  const guard = createBehaviorGuard({ fixThreshold: 3 });

  // failCount stays at 5 across attempts: streak grows 1,2,3,4.
  let s = guard.observe({ tool: 'edit', failCount: 5 });
  assert.equal(s.stuck, false, JSON.stringify(s));
  s = guard.observe({ tool: 'edit', failCount: 5 });
  assert.equal(s.stuck, false, JSON.stringify(s));
  s = guard.observe({ tool: 'edit', failCount: 5 });
  assert.equal(s.stuck, false, JSON.stringify(s));
  s = guard.observe({ tool: 'edit', failCount: 5 }); // 4th without improvement (>3)
  assert.equal(s.stuck, true, JSON.stringify(s));
  assert.ok(s.flags.includes(DRIFT_CODES.STUCK_NO_IMPROVEMENT));
});

test('C5: decreasing failCount resets the stuck streak (recovery clears the path)', () => {
  const guard = createBehaviorGuard({ fixThreshold: 3 });
  guard.observe({ tool: 'edit', failCount: 10 });
  guard.observe({ tool: 'edit', failCount: 10 });
  guard.observe({ tool: 'edit', failCount: 10 });
  // Improvement: 10 -> 7 resets streak to 1.
  let s = guard.observe({ tool: 'edit', failCount: 7 });
  assert.equal(s.stuck, false, JSON.stringify(s));
  s = guard.observe({ tool: 'edit', failCount: 7 });
  assert.equal(s.stuck, false, JSON.stringify(s));
  s = guard.observe({ tool: 'edit', failCount: 7 });
  assert.equal(s.stuck, false, JSON.stringify(s));
  s = guard.observe({ tool: 'edit', failCount: 7 });
  assert.equal(s.stuck, true, JSON.stringify(s));
});

// ---------------------------------------------------------------------------
// Group D — 3-Way Integrity (fail-closed)
// ---------------------------------------------------------------------------

// Build a complete, consistent 3-way fixture: real git worktree (disk HEAD),
// session record with matching headSha, and a ledger whose tail agrees.
function mkConsistentFixture() {
  const stateDir = mkTmp('sup-d-');
  const id = mkIdentity();
  const wt = path.join(stateDir, 'wt');
  fs.mkdirSync(wt, { recursive: true });
  execSync('git init', { cwd: wt, stdio: 'ignore' });
  execSync('git config user.email t@t.local', { cwd: wt, stdio: 'ignore' });
  execSync('git config user.name t', { cwd: wt, stdio: 'ignore' });
  fs.writeFileSync(path.join(wt, 'README.md'), 'hello\n');
  execSync('git add .', { cwd: wt, stdio: 'ignore' });
  execSync('git commit -m init', { cwd: wt, stdio: 'ignore' });
  const head = execSync('git rev-parse HEAD', { cwd: wt, encoding: 'utf8' }).trim().toLowerCase();

  // Session record
  const sessionsDir = path.join(stateDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const session = {
    schemaVersion: '1',
    state: 'SESSION_ACTIVE',
    taskId: `${REPO}#${ISSUE}`,
    repo: REPO,
    issueNumber: ISSUE,
    identityHash: id,
    headSha: head,
    baseSha: 'f'.repeat(40),
    worktreePath: wt,
    worktreesRoot: path.join(stateDir, 'worktrees'),
  };
  fs.writeFileSync(path.join(sessionsDir, `${id}.json`), JSON.stringify(session, null, 2));

  // Ledger with one tail record carrying the same headSha.
  const loopDir = path.join(stateDir, 'control-loop', id);
  fs.mkdirSync(loopDir, { recursive: true });
  const tailRec = {
    schemaVersion: '1',
    ts: new Date().toISOString(),
    from: 'ROUTED', to: 'EXECUTING', reason: 'test',
    evidence: { headSha: head },
    identityHash: id,
    sessionPath: path.join(sessionsDir, `${id}.json`),
  };
  fs.writeFileSync(path.join(loopDir, 'transitions.jsonl'), JSON.stringify(tailRec) + '\n');

  return { stateDir, id, wt, head, session };
}

test('D1: consistent Session + Ledger + Disk => audit passes', () => {
  const f = mkConsistentFixture();
  const r = audit3Way({ stateDir: f.stateDir, identityHash: f.id });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.code, AUDIT_CODES.AUDIT_OK);
  assert.equal(r.detail.headSha, f.head);
});

test('D2: Session headSha != Disk HEAD => FIELD_MISMATCH fail-closed', () => {
  const f = mkConsistentFixture();
  // Tamper the session headSha.
  const sp = path.join(f.stateDir, 'sessions', `${f.id}.json`);
  const s = JSON.parse(fs.readFileSync(sp, 'utf8'));
  s.headSha = 'b'.repeat(40);
  fs.writeFileSync(sp, JSON.stringify(s, null, 2));

  const r = audit3Way({ stateDir: f.stateDir, identityHash: f.id });
  assert.equal(r.ok, false);
  assert.equal(r.code, AUDIT_CODES.FIELD_MISMATCH);
  assert.ok(r.detail.mismatches.some((m) => m.field === 'headSha'));
});

test('D3: Session missing => SESSION_MISSING fail-closed', () => {
  const f = mkConsistentFixture();
  fs.unlinkSync(path.join(f.stateDir, 'sessions', `${f.id}.json`));
  const r = audit3Way({ stateDir: f.stateDir, identityHash: f.id });
  assert.equal(r.ok, false);
  assert.equal(r.code, AUDIT_CODES.SESSION_MISSING);
});

test('D4: Ledger missing => LEDGER_MISSING fail-closed', () => {
  const f = mkConsistentFixture();
  fs.rmSync(path.join(f.stateDir, 'control-loop', f.id), { recursive: true, force: true });
  const r = audit3Way({ stateDir: f.stateDir, identityHash: f.id });
  assert.equal(r.ok, false);
  assert.equal(r.code, AUDIT_CODES.LEDGER_MISSING);
});

test('D5: Disk worktree missing => DISK_EVIDENCE_MISSING fail-closed', () => {
  const f = mkConsistentFixture();
  fs.rmSync(f.wt, { recursive: true, force: true });
  const r = audit3Way({ stateDir: f.stateDir, identityHash: f.id });
  assert.equal(r.ok, false);
  assert.equal(r.code, AUDIT_CODES.DISK_EVIDENCE_MISSING);
});

test('D6: reactive engine wired to audit3Way aborts chain on 3-way drift and emits onBlocked', () => {
  const f = mkConsistentFixture();
  // Introduce drift BEFORE the engine runs: session headSha no longer matches disk.
  const sp = path.join(f.stateDir, 'sessions', `${f.id}.json`);
  const s = JSON.parse(fs.readFileSync(sp, 'utf8'));
  s.headSha = 'c'.repeat(40);
  fs.writeFileSync(sp, JSON.stringify(s, null, 2));

  const engine = createReactiveEngine({
    stateDir: f.stateDir,
    identityHash: f.id,
    audit3Way: makeAuditFn({ stateDir: f.stateDir, identityHash: f.id }),
  });
  let blocked = null;
  engine.onBlocked((p) => { blocked = p; });

  const r = engine.runChain({ startState: 'ACCEPTED' });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.blocked, true);
  assert.equal(r.code, AUDIT_CODES.FIELD_MISMATCH);
  assert.ok(blocked, 'onBlocked must fire');
  assert.equal(blocked.code, AUDIT_CODES.FIELD_MISMATCH);
  assert.equal(engine.isBlocked(), true);
  // Engine history must be empty: the audit gate failed BEFORE any hop ran.
  // (The fixture seeds one ledger record for the audit sources; the engine
  // itself must not have appended anything on top of it.)
  assert.equal(engine.history().length, 0, 'engine must record zero transitions when audit fails');
  const ledger = engine.readLedger();
  assert.equal(ledger.filter((rec) => rec.from === 'ACCEPTED').length, 0,
    'no ACCEPTED->ROUTED hop may be recorded when audit fails');
});

test('D7: reactive engine with healthy 3-way fixture completes the full chain', () => {
  const f = mkConsistentFixture();
  const engine = createReactiveEngine({
    stateDir: f.stateDir,
    identityHash: f.id,
    audit3Way: makeAuditFn({ stateDir: f.stateDir, identityHash: f.id }),
  });
  const r = engine.runChain({ startState: 'ACCEPTED' });
  assert.equal(r.ok, true, JSON.stringify(r));
  // Fixture seeds 1 audit-source record; the engine chain adds 4 hops.
  assert.equal(engine.history().length, 4, 'engine history must contain the 4 chain hops');
  assert.equal(engine.readLedger().length, 5, 'ledger = 1 fixture seed + 4 engine hops');
  assert.equal(engine.isBlocked(), false);
});
