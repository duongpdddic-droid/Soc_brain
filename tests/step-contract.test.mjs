// tests/step-contract.test.mjs — in-flight self-healing step transition &
// context guidance (TDD Red/Green matrix).
//
// Covers, with the real step-contract module and the generated guide:
//   T1  preflight with missing fields -> REMEDIATION_REQUIRED (no throw, no
//       BLOCKED) carrying currentStep/targetStep/missingFields/invalidFields/
//       remediationHint + sessionPhase AWAITING_FIELDS
//   T2  present-but-invalid fields -> invalidFields with per-field REASONS
//       (raw values are never echoed), valid sibling fields still reported
//   T3  all required fields valid -> READY, currentStep advanced, no pending
//       target
//   T4  on-disk remediation loop: attempt 1 (partial) writes
//       .soc/step-state.json; attempt 2 supplies ONLY the missing field and
//       passes because collected fields merge additively (nothing lost)
//   T5  no phantom transition: an illegal edge / unknown step is refused with
//       a typed code and does NOT rewrite the persisted remediation record
//   T6  idempotent re-attempt with the same fields -> same READY outcome,
//       collected fields unchanged
//   T7  format validators (40-hex SHA, SHA-256, integer PID, exit code, path,
//       repo, positive int, non-empty string, enum) accept/reject correctly
//       and normalize case where the contract says so
//   T8  docs/step-transition-guide.md is byte-synced (modulo EOL) with
//       renderStepGuide() and catalogs every step, field and format label
//   T9  the fixture sample (tests/fixtures/step-state.sample.json) is
//       schema-consistent: its missingFields + invalidFields keys are exactly
//       the preflight result recomputed from its collectedFields, and the
//       runtime ledger path is never TRACKED in the Git index (a valid local
//       runtime ledger at the working-tree root is legitimate)
//   T10 handoff checklist projects stepState read-only: items stay exactly
//       CHECKLIST_ITEM_IDS, status stays driven by the checklist items only,
//       and the Markdown view surfaces the remediation record
//   T11 the step catalog prerequisites stay in sync with the canonical FSM
//       ALLOWED_TRANSITIONS/LOOP_STATES of control-loop.mjs
//   T12 export-step-guide.mjs --check exits 0 while the guide is in sync
//   T13 null/invalid arguments produce typed refusals, never a TypeError
//   T14 a held remediation pair is never clobbered by a different attempt
//       (STEP_REMEDIATION_PENDING guard, no phantom transitions)
//   T15 an isolated fresh root starts with no ledger; ACCEPTED -> ROUTED with
//       valid fields returns READY and persists the record; the held-pair
//       guard is still enforced once a REAL hold exists
//   T16 F2 additive merge: an invalid current value is reported and held but
//       never evicts a previously collected valid field; the next call that
//       omits the bad field and supplies the missing one goes READY (three-call
//       chain asserted on the result AND on disk read-back)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  STEP_CONTRACT,
  STEP_STATE_RELATIVE_PATH,
  STEP_STATE_SAMPLE_RELATIVE_PATH,
  STEP_STATE_STATUSES,
  STEP_SESSION_PHASES,
  FIELDS,
  FIELD_FORMATS,
  validateField,
  preflightStepTransition,
  attemptStepTransition,
  readStepState,
  writeStepState,
  stepStatePath,
} from '../packages/control-loop/step-contract.mjs';
import { renderStepGuide } from '../scripts/export-step-guide.mjs';
import {
  buildHandoffChecklist,
  projectHandoffChecklist,
  CHECKLIST_ITEM_IDS,
} from '../packages/control-loop/handoff-checklist.mjs';
import { ALLOWED_TRANSITIONS, LOOP_STATES } from '../packages/control-loop/control-loop.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SHA40_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const SHA40_B = '0123456789abcdef0123456789abcdef01234567';
const SHA256_OK = 'f'.repeat(64);
const ISO = '2026-10-08T00:00:00.000Z';

function mkRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'step-contract-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const fixedNow = () => ISO;
const norm = (s) => s.replace(/\r\n/g, '\n');

test('T1 preflight with missing fields -> REMEDIATION_REQUIRED, never throw, never BLOCKED', () => {
  const r = preflightStepTransition({ from: 'VERIFYING', to: 'PRE_REVIEWING', fields: {}, now: fixedNow });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'REMEDIATION_REQUIRED');
  const s = r.value;
  assert.equal(s.status, 'REMEDIATION_REQUIRED');
  assert.equal(s.sessionPhase, 'AWAITING_FIELDS');
  assert.equal(s.currentStep, 'VERIFYING', 'the holding step is preserved (no phantom advance)');
  assert.equal(s.targetStep, 'PRE_REVIEWING');
  assert.deepEqual(s.missingFields, ['headSha', 'contentDigest']);
  assert.deepEqual(s.invalidFields, {});
  assert.match(s.remediationHint, /headSha/);
  assert.match(s.remediationHint, /40-hex SHA/);
  assert.match(s.remediationHint, /contentDigest/);
  assert.match(s.remediationHint, /no restart/i);
  assert.notEqual(s.status, 'BLOCKED');
  assert.equal(s.updatedAt, ISO, 'now() is injectable for deterministic records');
  assert.deepEqual(STEP_STATE_STATUSES, ['READY', 'REMEDIATION_REQUIRED'], 'BLOCKED is not a step-state status');
  assert.deepEqual(STEP_SESSION_PHASES, ['IN_STEP', 'AWAITING_FIELDS']);
});

test('T2 present-but-invalid fields -> invalidFields with reasons; valid siblings unaffected', () => {
  const r = preflightStepTransition({
    from: 'VERIFYING',
    to: 'PRE_REVIEWING',
    fields: { headSha: 'ZZZ', contentDigest: 123 },
    now: fixedNow,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'REMEDIATION_REQUIRED');
  assert.deepEqual(r.value.missingFields, [], 'supplied-but-invalid is NOT missing (F1 classify, never collapse)');
  assert.equal(typeof r.value.invalidFields.headSha, 'string');
  assert.match(r.value.invalidFields.headSha, /40-hex SHA/);
  assert.match(r.value.invalidFields.headSha, /received number|not a 40-hex/);
  assert.equal(typeof r.value.invalidFields.contentDigest, 'string');
  assert.match(r.value.invalidFields.contentDigest, /SHA-256/);
  const serialized = JSON.stringify(r.value);
  assert.equal(serialized.includes('ZZZ'), false, 'the raw invalid value is never echoed into the record');

  const partial = preflightStepTransition({
    from: 'VERIFYING',
    to: 'PRE_REVIEWING',
    fields: { headSha: SHA40_A },
    now: fixedNow,
  });
  assert.equal(partial.ok, false);
  assert.deepEqual(partial.value.missingFields, ['contentDigest'], 'valid sibling field counts as collected');
  assert.deepEqual(partial.value.invalidFields, {});
});

test('T3 all required fields valid -> READY with currentStep advanced and no pending target', () => {
  const r = preflightStepTransition({
    from: 'VERIFYING',
    to: 'PRE_REVIEWING',
    fields: { headSha: SHA40_A, contentDigest: SHA256_OK },
    now: fixedNow,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  const s = r.value;
  assert.equal(s.status, 'READY');
  assert.equal(s.sessionPhase, 'IN_STEP');
  assert.equal(s.currentStep, 'PRE_REVIEWING');
  assert.equal(s.targetStep, null);
  assert.deepEqual(s.missingFields, []);
  assert.deepEqual(s.invalidFields, {});
  assert.equal(s.remediationHint, null);
  assert.equal(s.collectedFields.headSha, SHA40_A, 'validated fields are collected for additive reuse');
});

test('T4 on-disk remediation loop: partial attempt persists, second attempt supplies only the missing field and passes', async (t) => {
  const root = mkRoot(t);
  const first = attemptStepTransition({
    rootDir: root,
    from: 'VERIFYING',
    to: 'PRE_REVIEWING',
    fields: { headSha: SHA40_A },
    now: fixedNow,
  });
  assert.equal(first.ok, false);
  assert.equal(first.code, 'REMEDIATION_REQUIRED');
  const file = stepStatePath(root);
  assert.equal(file, path.join(root, STEP_STATE_RELATIVE_PATH));
  assert.equal(fs.existsSync(file), true, 'the state ledger is written for the executor to read back');

  const readBack = readStepState(root);
  assert.equal(readBack.ok, true);
  assert.equal(readBack.value.status, 'REMEDIATION_REQUIRED');
  assert.equal(readBack.value.currentStep, 'VERIFYING');
  assert.deepEqual(readBack.value.missingFields, ['contentDigest']);
  assert.equal(readBack.value.collectedFields.headSha, SHA40_A);

  // Idempotent & safe remediation: ONLY the missing field is re-supplied.
  const second = attemptStepTransition({
    rootDir: root,
    from: 'VERIFYING',
    to: 'PRE_REVIEWING',
    fields: { contentDigest: SHA256_OK },
    now: fixedNow,
  });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.value.status, 'READY');
  assert.equal(second.value.currentStep, 'PRE_REVIEWING');
  assert.equal(second.value.collectedFields.headSha, SHA40_A, 'previously valid field survived the merge');
  assert.equal(second.value.collectedFields.contentDigest, SHA256_OK);
  const after = readStepState(root);
  assert.equal(after.value.status, 'READY');
  assert.deepEqual(after.value.missingFields, []);
});

test('T5 no phantom transitions: illegal edge / unknown step refused typed, ledger untouched', async (t) => {
  const root = mkRoot(t);
  const held = attemptStepTransition({
    rootDir: root,
    from: 'VERIFYING',
    to: 'PRE_REVIEWING',
    fields: {},
    now: fixedNow,
  });
  assert.equal(held.ok, false);
  const before = fs.readFileSync(stepStatePath(root), 'utf8');

  const illegal = attemptStepTransition({
    rootDir: root,
    from: 'VERIFYING',
    to: 'COMPLETED',
    fields: { headSha: SHA40_A, contentDigest: SHA256_OK },
    now: fixedNow,
  });
  assert.equal(illegal.ok, false);
  assert.equal(illegal.code, 'STEP_TRANSITION_INVALID');
  assert.deepEqual(illegal.detail.allowedFrom, ['DELIVERING']);

  const unknown = attemptStepTransition({
    rootDir: root,
    from: 'NOPE',
    to: 'PRE_REVIEWING',
    fields: {},
    now: fixedNow,
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'STEP_UNKNOWN');

  const unknownTarget = preflightStepTransition({ from: 'VERIFYING', to: 'NOPE', fields: {} });
  assert.equal(unknownTarget.ok, false);
  assert.equal(unknownTarget.code, 'STEP_UNKNOWN');

  const after = fs.readFileSync(stepStatePath(root), 'utf8');
  assert.equal(after, before, 'a refused transition never rewrites the held remediation record');
  const rec = JSON.parse(after);
  assert.equal(rec.status, 'REMEDIATION_REQUIRED');
  assert.equal(rec.currentStep, 'VERIFYING');
});

test('T6 idempotent re-attempt with the same fields -> identical READY outcome', async (t) => {
  const root = mkRoot(t);
  const fields = { headSha: SHA40_A, contentDigest: SHA256_OK };
  const a = attemptStepTransition({ rootDir: root, from: 'VERIFYING', to: 'PRE_REVIEWING', fields, now: fixedNow });
  const b = attemptStepTransition({ rootDir: root, from: 'VERIFYING', to: 'PRE_REVIEWING', fields, now: fixedNow });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.deepEqual(b.value, a.value, 're-running the same attempt is a no-op on the record');
  assert.deepEqual(Object.keys(b.value.collectedFields).sort(), ['contentDigest', 'headSha']);
});

test('T7 format validators accept valid shapes and reject invalid ones with reasons', () => {
  assert.deepEqual(validateField('headSha', SHA40_A), { valid: true, reason: null, value: SHA40_A });
  assert.equal(validateField('headSha', SHA40_A.toUpperCase()).value, SHA40_A, 'hex normalizes to lowercase');
  assert.equal(validateField('headSha', 'abc').valid, false);
  assert.match(validateField('headSha', 'abc').reason, /40-hex SHA/);
  assert.match(validateField('headSha', 42).reason, /received number/);
  assert.equal(validateField('contentDigest', 'f'.repeat(63)).valid, false);
  assert.equal(validateField('contentDigest', SHA256_OK).valid, true);
  assert.equal(validateField('executorPid', 4242).valid, true);
  assert.equal(validateField('executorPid', 0).valid, false);
  assert.equal(validateField('executorPid', -1).valid, false);
  assert.equal(validateField('executorPid', '4242').valid, false, 'a PID is an integer, not a numeric string');
  assert.equal(validateField('exitCode', 0).valid, true);
  assert.equal(validateField('exitCode', 1).valid, true);
  assert.equal(validateField('exitCode', -1).valid, false);
  assert.equal(validateField('exitCode', '0').valid, false);
  assert.equal(validateField('worktreePath', 'C:/wt/task').valid, true);
  assert.equal(validateField('worktreePath', '').valid, false);
  assert.equal(validateField('worktreePath', 'a\u0000b').valid, false, 'NUL is never a path');
  assert.equal(validateField('repo', 'owner/name').valid, true);
  assert.equal(validateField('repo', 'noslash').valid, false);
  assert.equal(validateField('issueNumber', 42).valid, true);
  assert.equal(validateField('issueNumber', 0).valid, false);
  assert.equal(validateField('branch', 'task/x').valid, true);
  assert.equal(validateField('branch', '   ').valid, false);
  assert.equal(validateField('verdict', 'PASS').valid, true);
  assert.equal(validateField('verdict', 'pass').valid, false, 'verdict enum is case-sensitive');
  assert.equal(validateField('unknownFieldZzz', 'x').valid, false, 'unregistered fields are not collectable');
  assert.equal(FIELD_FORMATS.sha40.label.includes('40-hex'), true);
  assert.equal(FIELD_FORMATS.sha256.label.includes('SHA-256'), true);
  assert.equal(FIELD_FORMATS.pid.label.includes('PID'), true);
  assert.equal(FIELD_FORMATS.path.label.toLowerCase().includes('path'), true);
});

test('T8 docs/step-transition-guide.md is byte-synced with the schema renderer', () => {
  const guidePath = path.join(REPO_ROOT, 'docs', 'step-transition-guide.md');
  assert.equal(fs.existsSync(guidePath), true, 'the guide is committed');
  const onDisk = norm(fs.readFileSync(guidePath, 'utf8'));
  const rendered = norm(renderStepGuide());
  assert.equal(onDisk, rendered, 'guide drifted from the schema — run `node scripts/export-step-guide.mjs`');
  for (const step of STEP_CONTRACT) assert.ok(onDisk.includes(`### ${step.name}`), `guide catalogs ${step.name}`);
  for (const name of Object.keys(FIELDS)) assert.ok(onDisk.includes(name), `guide lists field ${name}`);
  for (const f of Object.values(FIELD_FORMATS)) assert.ok(onDisk.includes(f.label), `guide shows format label ${f.label}`);
  assert.ok(onDisk.includes('REMEDIATION_REQUIRED'));
  assert.ok(onDisk.includes('AWAITING_FIELDS'));
  assert.ok(onDisk.includes(STEP_STATE_RELATIVE_PATH));
  assert.ok(onDisk.includes('remediationHint'));
});

test('T9 fixture sample is schema-consistent with the preflight contract (runtime ledger never tracked)', () => {
  const fixturePath = path.join(REPO_ROOT, STEP_STATE_SAMPLE_RELATIVE_PATH);
  assert.equal(fs.existsSync(fixturePath), true, 'the schema sample lives in tests/fixtures/');
  // F1/F3: a VALID runtime ledger at the working-tree root is legitimate (the
  // runtime may own .soc/step-state.json) — the protected property is that it
  // is never TRACKED in the Git index, so no state ships into a fresh checkout.
  const trackedSoc = spawnSync('git', ['ls-files', '--', '.soc/'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(trackedSoc.status, 0, `git ls-files failed: ${trackedSoc.stderr}`);
  assert.equal(trackedSoc.stdout.trim(), '', 'no runtime state file may be tracked in the index');
  const sample = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  assert.equal(sample.status, 'REMEDIATION_REQUIRED');
  assert.equal(sample.sessionPhase, 'AWAITING_FIELDS');
  for (const key of ['schemaVersion', 'status', 'sessionPhase', 'currentStep', 'targetStep', 'missingFields', 'invalidFields', 'remediationHint', 'collectedFields', 'updatedAt']) {
    assert.ok(Object.prototype.hasOwnProperty.call(sample, key), `sample carries ${key}`);
  }
  assert.ok(Array.isArray(sample.missingFields));
  assert.equal(typeof sample.invalidFields, 'object');
  assert.ok(sample.remediationHint.includes(sample.missingFields[0]), 'the hint names a missing field');
  const recomputed = preflightStepTransition({
    from: sample.currentStep,
    to: sample.targetStep,
    fields: sample.collectedFields,
    now: fixedNow,
  });
  assert.equal(recomputed.ok, false, 'the sample really is a held remediation record');
  const expected = [...recomputed.value.missingFields].sort();
  const declared = [...sample.missingFields, ...Object.keys(sample.invalidFields)].sort();
  assert.deepEqual(declared, expected, 'declared missing+invalid keys match a fresh preflight over collectedFields');
  assert.deepEqual(Object.keys(recomputed.value.invalidFields), [], 'stored collectedFields only ever hold valid values');
  assert.deepEqual(sample.collectedFields, {}, 'the sample collects NOTHING — a fabricated value here would satisfy real preflights on a fresh checkout');
  for (const name of sample.missingFields) assert.ok(STEP_CONTRACT.find((s) => s.name === sample.targetStep).fields.includes(name));
});

test('T10 handoff checklist projects stepState read-only without changing the contracted items', async (t) => {
  const stateDir = mkRoot(t);
  const session = {
    schemaVersion: '1', state: 'SESSION_ACTIVE',
    taskId: 'duongpdddic-droid/soc_brain#9002', repo: 'duongpdddic-droid/soc_brain', issueNumber: 9002,
    prNumber: 4243, headSha: SHA40_A, baseSha: SHA40_B, branch: 'soc/issue-9002-step',
    worktreePath: path.join(stateDir, 'wt'), worktreesRoot: stateDir,
    controlPlane: { stateDir },
  };
  const base = {
    stateDir,
    session,
    identityHash: 'step-contract-identity',
    transitions: [],
    internalReviewGate: { ok: false, code: 'INTERNAL_REVIEW_PENDING', detail: { reason: 'none' } },
    now: fixedNow,
  };

  const plain = buildHandoffChecklist(base);
  assert.equal(plain.ok, true);
  assert.equal(plain.value.stepState, null, 'no state file -> null projection, nothing invented');

  const root = mkRoot(t);
  writeStepState(root, JSON.parse(fs.readFileSync(path.join(REPO_ROOT, STEP_STATE_SAMPLE_RELATIVE_PATH), 'utf8')));
  const withState = buildHandoffChecklist({ ...base, stepStatePath: stepStatePath(root) });
  assert.equal(withState.ok, true);
  assert.equal(withState.value.stepState.status, 'REMEDIATION_REQUIRED');
  assert.equal(withState.value.stepState.currentStep, 'EXECUTING');
  assert.deepEqual(withState.value.items.map((i) => i.id), [...CHECKLIST_ITEM_IDS], 'no checklist item is added or removed');
  assert.equal(withState.value.status, 'IN_PROGRESS', 'stepState never flips the checklist status on its own');

  const pj = projectHandoffChecklist({ ...base, stepStatePath: stepStatePath(root) });
  assert.equal(pj.ok, true, JSON.stringify(pj));
  const md = fs.readFileSync(pj.value.mdPath, 'utf8');
  assert.ok(md.includes('stepState'), 'the Markdown view surfaces the held remediation record');
  assert.ok(md.includes('REMEDIATION_REQUIRED'));
  const json = JSON.parse(fs.readFileSync(pj.value.jsonPath, 'utf8'));
  assert.equal(json.stepState.targetStep, 'VERIFYING');
});

test('T11 step catalog prerequisites stay in sync with the canonical FSM edges', () => {
  const reverse = new Map(LOOP_STATES.map((s) => [s, []]));
  for (const [from, tos] of Object.entries(ALLOWED_TRANSITIONS)) {
    for (const to of tos) {
      assert.ok(reverse.has(to), `${to} is a declared loop state`);
      reverse.get(to).push(from);
    }
  }
  assert.deepEqual(STEP_CONTRACT.length, LOOP_STATES.length, 'every loop state has exactly one contract entry');
  for (const step of STEP_CONTRACT) {
    assert.ok(LOOP_STATES.includes(step.name), `${step.name} is a canonical loop state`);
    const expected = [...reverse.get(step.name)].sort();
    assert.deepEqual([...step.prerequisites].sort(), expected, `${step.name} prerequisites mirror ALLOWED_TRANSITIONS`);
    for (const field of step.fields) {
      assert.ok(FIELDS[field], `${step.name} references registered field ${field}`);
    }
    assert.equal(new Set(step.fields).size, step.fields.length, `${step.name} has no duplicate fields`);
  }
});

test('T12 export-step-guide.mjs --check exits 0 while the guide is in sync', () => {
  const r = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'export-step-guide.mjs'), '--check'], {
    cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(r.status, 0, `--check failed:\n${r.stdout}\n${r.stderr}`);
});

test('T13 null/invalid arguments produce typed refusals, never a TypeError', async (t) => {
  const pfNull = preflightStepTransition(null);
  assert.equal(pfNull.ok, false);
  assert.equal(pfNull.code, 'STEP_UNKNOWN');
  const pfArr = preflightStepTransition([1, 2]);
  assert.equal(pfArr.code, 'STEP_UNKNOWN');
  const atNull = attemptStepTransition(null);
  assert.equal(atNull.ok, false);
  assert.equal(atNull.code, 'STEP_STATE_ROOT_INVALID');
  const atNoRoot = attemptStepTransition({ from: 'VERIFYING', to: 'PRE_REVIEWING', fields: {} });
  assert.equal(atNoRoot.code, 'STEP_STATE_ROOT_INVALID');
  const rdBad = readStepState(null);
  assert.equal(rdBad.ok, false);
  assert.equal(rdBad.code, 'STEP_STATE_ROOT_INVALID');
  const wrBad = writeStepState(undefined, { x: 1 });
  assert.equal(wrBad.ok, false);
  assert.equal(wrBad.code, 'STEP_STATE_ROOT_INVALID');
  // sanity: the normal path still works right after the refusals
  const root = mkRoot(t);
  const ok = attemptStepTransition({
    rootDir: root, from: 'VERIFYING', to: 'PRE_REVIEWING',
    fields: { headSha: SHA40_A, contentDigest: SHA256_OK }, now: fixedNow,
  });
  assert.equal(ok.ok, true, JSON.stringify(ok));
});

test('T14 a held remediation pair is never clobbered by a different attempt (no phantom transitions)', async (t) => {
  const root = mkRoot(t);
  const held = attemptStepTransition({
    rootDir: root,
    from: 'VERIFYING',
    to: 'PRE_REVIEWING',
    fields: { headSha: SHA40_A }, // still missing contentDigest
    now: fixedNow,
  });
  assert.equal(held.ok, false);
  const before = fs.readFileSync(stepStatePath(root), 'utf8');

  // A DIFFERENT legal pair with fully valid fields must not overwrite the hold.
  const other = attemptStepTransition({
    rootDir: root,
    from: 'PRE_REVIEWING',
    to: 'FINAL_REVIEWING',
    fields: { headSha: SHA40_A, contentDigest: SHA256_OK, reviewRunId: 'run-7' },
    now: fixedNow,
  });
  assert.equal(other.ok, false);
  assert.equal(other.code, 'STEP_REMEDIATION_PENDING');
  assert.deepEqual(other.detail.held, { currentStep: 'VERIFYING', targetStep: 'PRE_REVIEWING' });
  assert.match(other.detail.remediationHint, /contentDigest/);
  const after = fs.readFileSync(stepStatePath(root), 'utf8');
  assert.equal(after, before, 'the held record survives byte-for-byte');

  // Resolving the SAME held pair still completes (no deadlock).
  const resumed = attemptStepTransition({
    rootDir: root,
    from: 'VERIFYING',
    to: 'PRE_REVIEWING',
    fields: { contentDigest: SHA256_OK },
    now: fixedNow,
  });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.equal(resumed.value.status, 'READY');

  // After READY the ledger may move on to a new pair freely.
  const next = attemptStepTransition({
    rootDir: root,
    from: 'PRE_REVIEWING',
    to: 'FINAL_REVIEWING',
    fields: { headSha: SHA40_A, contentDigest: SHA256_OK, reviewRunId: 'run-7' },
    now: fixedNow,
  });
  assert.equal(next.ok, true, JSON.stringify(next));
  assert.equal(next.value.currentStep, 'FINAL_REVIEWING');
});

test('T15 fresh checkout root starts without a ledger; ACCEPTED -> ROUTED with valid fields goes READY and persists', async (t) => {
  // F3: the working tree may legitimately hold a runtime ledger — the
  // fresh-checkout property is verified on an ISOLATED temp root that starts
  // with no ledger at all (and by the never-tracked assertion in T9).
  const root = mkRoot(t);
  const initial = readStepState(root);
  assert.equal(initial.ok, true);
  assert.equal(initial.value, null, 'the isolated fresh root starts with no ledger');

  // F1 (4): run the FIRST real transition against that clean root.
  const first = attemptStepTransition({
    rootDir: root,
    from: 'ACCEPTED',
    to: 'ROUTED',
    fields: { branch: 'task/step-transition-self-healing', headSha: SHA40_A },
    now: fixedNow,
  });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.value.status, 'READY');
  assert.equal(first.value.currentStep, 'ROUTED');
  assert.equal(first.value.targetStep, null);
  assert.deepEqual(first.value.missingFields, []);
  assert.deepEqual(first.value.invalidFields, {});
  // persisted exactly (read-back from disk)
  const back = readStepState(root);
  assert.equal(back.ok, true);
  assert.equal(back.value.status, 'READY');
  assert.equal(back.value.currentStep, 'ROUTED');
  assert.equal(back.value.collectedFields.branch, 'task/step-transition-self-healing');
  assert.equal(back.value.collectedFields.headSha, SHA40_A);

  // F1 (5): once a REAL hold exists, the held-pair guard is still enforced —
  // the fix must not weaken STEP_REMEDIATION_PENDING.
  const held = attemptStepTransition({ rootDir: root, from: 'ROUTED', to: 'EXECUTING', fields: {}, now: fixedNow });
  assert.equal(held.ok, false);
  assert.equal(held.code, 'REMEDIATION_REQUIRED');
  const other = attemptStepTransition({
    rootDir: root, from: 'ACCEPTED', to: 'ROUTED',
    fields: { branch: 'task/other', headSha: SHA40_B }, now: fixedNow,
  });
  assert.equal(other.ok, false);
  assert.equal(other.code, 'STEP_REMEDIATION_PENDING');
});

test('T16 F2: an invalid current value never evicts a collected valid field (3-call chain, result + disk)', async (t) => {
  const root = mkRoot(t);
  const pair = { rootDir: root, from: 'VERIFYING', to: 'PRE_REVIEWING', now: fixedNow };

  // (a) valid headSha -> held for contentDigest, headSha collected
  const a = attemptStepTransition({ ...pair, fields: { headSha: SHA40_A } });
  assert.equal(a.ok, false);
  assert.equal(a.code, 'REMEDIATION_REQUIRED');
  assert.deepEqual(a.value.missingFields, ['contentDigest']);
  assert.equal(a.value.collectedFields.headSha, SHA40_A);

  // (b) same pair, BAD headSha -> reported invalid + held (never READY), and
  //     the previously collected valid headSha survives; raw value never echoed
  const b = attemptStepTransition({ ...pair, fields: { headSha: 'bad' } });
  assert.equal(b.ok, false);
  assert.equal(b.code, 'REMEDIATION_REQUIRED');
  assert.notEqual(b.value.status, 'READY', 'the current input error must never be masked into READY');
  assert.equal(typeof b.value.invalidFields.headSha, 'string');
  assert.match(b.value.invalidFields.headSha, /40-hex/);
  assert.equal(b.value.collectedFields.headSha, SHA40_A, 'F2: the valid prior value survives the invalid current value');
  assert.equal(JSON.stringify(b.value).includes('"bad"'), false, 'raw invalid value never echoed');
  const diskB = readStepState(root);
  assert.equal(diskB.value.status, 'REMEDIATION_REQUIRED');
  assert.equal(diskB.value.collectedFields.headSha, SHA40_A, 'F2: read-back keeps the valid collected field');
  assert.equal(JSON.stringify(diskB.value).includes('"bad"'), false, 'raw invalid value never persisted');

  // (c) omit the bad field, supply the missing one -> READY on the kept collection
  const c = attemptStepTransition({ ...pair, fields: { contentDigest: SHA256_OK } });
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.equal(c.value.status, 'READY');
  assert.equal(c.value.currentStep, 'PRE_REVIEWING');
  assert.equal(c.value.collectedFields.headSha, SHA40_A);
  assert.equal(c.value.collectedFields.contentDigest, SHA256_OK);
  const diskC = readStepState(root);
  assert.equal(diskC.value.status, 'READY');
  assert.equal(diskC.value.collectedFields.headSha, SHA40_A);
  assert.equal(diskC.value.collectedFields.contentDigest, SHA256_OK);

  // requirement 5: a NEW valid value may still replace the old one
  const d = attemptStepTransition({ ...pair, fields: { headSha: SHA40_B, contentDigest: SHA256_OK } });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(d.value.collectedFields.headSha, SHA40_B, 'a fresh valid value updates the collection');

  // requirement 5: null keeps current semantics — no update attempt, no eviction
  const e = attemptStepTransition({ ...pair, fields: { headSha: null, contentDigest: SHA256_OK } });
  assert.equal(e.ok, true, JSON.stringify(e));
  assert.equal(e.value.collectedFields.headSha, SHA40_B, 'null never evicts the collected value');

  // F2 widened contract: an invalid CURRENT value of a REGISTERED field
  // outside the target contract is reported too (never silently dropped) and
  // holds the transition, while the valid sibling stays collected.
  const f = attemptStepTransition({ ...pair, fields: { contentDigest: SHA256_OK, executorPid: -1 } });
  assert.equal(f.ok, false);
  assert.equal(f.code, 'REMEDIATION_REQUIRED');
  assert.equal(typeof f.value.invalidFields.executorPid, 'string');
  assert.equal(f.value.collectedFields.contentDigest, SHA256_OK, 'the valid sibling survives');
  assert.equal(JSON.stringify(f.value).includes('"-1"'), false, 'raw invalid value never echoed');
});
