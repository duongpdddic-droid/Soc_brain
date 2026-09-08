#!/usr/bin/env node
// task-progress.test.mjs — P1-0 (Issue #90) acceptance coverage.
// Deterministic, filesystem-backed: real session records at canonical
// control-plane locations (readSessionRecord binding), real progress ledger.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import {
  PROGRESS_SCHEMA_VERSION, STEP_STATUSES, PROGRESS_MARKER,
  applyTaskProgressUpdate, readProgressRecord, renderTaskProgress,
} from '../packages/task-progress/task-progress.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';

const results = [];
const eq = (n, g, w) => results.push({ name: n, pass: g === w });
const tru = (n, g) => results.push({ name: n, pass: Boolean(g) });

const TMP = mkdtempSync(path.join(os.tmpdir(), 'soc-tp-'));
const STATE = path.join(TMP, '_state');
const CANON = 'duongpdddic-droid/Soc_brain';

// Deterministic clock (ordering must never depend on executor wall clock).
const T0 = Date.parse('2026-09-07T00:00:00.000Z');
let tick = 0;
const now = () => new Date(T0 + ++tick * 1000).toISOString();

function mkSession({ repo = CANON, issueNumber = 90, state = 'SESSION_ACTIVE' } = {}) {
  const id = identityHash({ repo, issueNumber });
  assert.ok(id, 'fixture identityHash');
  const dir = path.join(STATE, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const sessionPath = path.join(dir, `${id}.json`);
  writeFileSync(sessionPath, JSON.stringify({
    schemaVersion: '1', repo, issueNumber, state,
    lifecycle: [], controlPlane: { stateDir: STATE }, createdAt: now(),
  }, null, 2), 'utf8');
  return { id, sessionPath, repo, issueNumber };
}

const plan3 = (statuses = ['COMPLETED', 'IN_PROGRESS', 'PENDING'], names = ['Inspect', 'Implement', 'Verify']) =>
  statuses.map((status, i) => ({ index: i + 1, name: names[i], status }));

const upd = (over = {}) => ({
  repo: CANON, issueNumber: 90, executorId: 'cline:session-a', executorKind: 'cline',
  executionEpoch: 1, currentStep: 2, totalSteps: 3,
  steps: plan3(), message: 'implementing', ...over,
});

const s = mkSession(); // main fixture, issue #90
const beforeBytes = readFileSync(s.sessionPath, 'utf8');

// ---- 1. module surface ---------------------------------------------------------
eq('schema version', PROGRESS_SCHEMA_VERSION, '1');
eq('step statuses', STEP_STATUSES.join('|'), 'PENDING|IN_PROGRESS|BLOCKED|COMPLETED');
tru('statuses frozen', Object.isFrozen(STEP_STATUSES));
eq('markers', Object.keys(PROGRESS_MARKER).sort().join('|'), 'BLOCKED|COMPLETED|IN_PROGRESS|PENDING');

// ---- 2. fresh plan --------------------------------------------------------------
const r1 = applyTaskProgressUpdate({ stateDir: STATE, update: upd(), now });
eq('fresh plan ok', r1.ok, true);
eq('fresh updateCount', r1.progress.updateCount, 1);
eq('fresh taskId', r1.progress.taskId, `${CANON}#90`);
eq('fresh identity binding', r1.progress.identityHash, s.id);
eq('fresh currentStep', r1.progress.currentStep, 2);
eq('history appended', r1.historyAppendOk, true);
const hist = readFileSync(path.join(STATE, 'task-progress', `${s.id}.jsonl`), 'utf8').trim().split('\n');
eq('history rows', hist.length, 1);
eq('history kind', JSON.parse(hist[0]).kind, 'EPOCH_BUMP');

// ---- 3. same-epoch monotonic patch + projection ---------------------------------
const r2 = applyTaskProgressUpdate({ stateDir: STATE, update: upd({
  currentStep: 3, steps: plan3(['COMPLETED', 'COMPLETED', 'IN_PROGRESS']),
}), now });
eq('patch ok', r2.ok, true);
eq('patch updateCount', r2.progress.updateCount, 2);
const proj = renderTaskProgress({ stateDir: STATE, sessionPath: s.sessionPath });
eq('projection ok', proj.ok, true);
eq('projection task line', proj.text.split('\n')[0], 'Task: Issue #90');
eq('projection canonical line', proj.text.split('\n')[1], 'Canonical: SESSION_ACTIVE');
tru('projection step 1 done', proj.text.includes('✓ Bước 1/3 — Inspect'));
tru('projection step 2 done', proj.text.includes('✓ Bước 2/3 — Implement'));
tru('projection step 3 current', proj.text.includes('▶ Bước 3/3 — Verify'));
tru('projection message', proj.text.includes('implementing'));
eq('projection canonicalState field', proj.canonicalState, 'SESSION_ACTIVE');

// ---- 4. duplicate update is deterministic (idempotent rewrite, no corruption) ---
const r4 = applyTaskProgressUpdate({ stateDir: STATE, update: upd({
  currentStep: 3, steps: plan3(['COMPLETED', 'COMPLETED', 'IN_PROGRESS']),
}), now });
eq('duplicate ok', r4.ok, true);
eq('duplicate updateCount', r4.progress.updateCount, 3);
eq('duplicate content stable', JSON.stringify(r4.progress.steps), JSON.stringify(r2.progress.steps));

// ---- 5. out-of-order / backward fail-closed -------------------------------------
eq('currentStep regression rejected',
  applyTaskProgressUpdate({ stateDir: STATE, update: upd({ currentStep: 1 }), now }).code, 'OUT_OF_ORDER_STEP');
eq('step backward rejected',
  applyTaskProgressUpdate({ stateDir: STATE, update: upd({
    currentStep: 3, steps: plan3(['COMPLETED', 'IN_PROGRESS', 'IN_PROGRESS']),
  }), now }).code, 'STEP_BACKWARD');
eq('completed is terminal',
  applyTaskProgressUpdate({ stateDir: STATE, update: upd({
    currentStep: 3, steps: plan3(['COMPLETED', 'PENDING', 'IN_PROGRESS']),
  }), now }).code, 'STEP_BACKWARD');

// ---- 6. epoch rules (crash/restart vs stale/replacement) ------------------------
// Higher epoch = new executor run after crash/restart: fresh plan replaces.
const r6 = applyTaskProgressUpdate({ stateDir: STATE, update: upd({
  executorId: 'cline:session-a-restarted', executionEpoch: 2, currentStep: 2,
  steps: plan3(['COMPLETED', 'IN_PROGRESS', 'PENDING']),
}), now });
eq('epoch bump ok', r6.ok, true);
eq('epoch bump updateCount continues (telemetry ledger lifetime)', r6.progress.updateCount, 4);
eq('epoch bump executor rebind', r6.progress.executorId, 'cline:session-a-restarted');
const hist2 = readFileSync(path.join(STATE, 'task-progress', `${s.id}.jsonl`), 'utf8').trim().split('\n');
eq('history rows after bump', hist2.length, 4);
eq('history last kind', JSON.parse(hist2[3]).kind, 'EPOCH_BUMP');
// Lower epoch = stale retry from the dead run: rejected.
eq('stale epoch rejected',
  applyTaskProgressUpdate({ stateDir: STATE, update: upd({ executorId: 'cline:session-a', executionEpoch: 1, currentStep: 3 }), now }).code,
  'OUT_OF_ORDER_EXECUTION_EPOCH');
// Replacement by a different executor kind at higher epoch re-binds cleanly.
const r6b = applyTaskProgressUpdate({ stateDir: STATE, update: upd({
  executorId: 'opencode@sess-1', executorKind: 'opencode', executionEpoch: 3, currentStep: 1,
  steps: plan3(['IN_PROGRESS', 'PENDING', 'PENDING'], ['Re-inspect', 'Re-implement', 'Re-verify']),
}), now });
eq('executor replacement ok', r6b.ok, true);
eq('replacement kind', r6b.progress.executorKind, 'opencode');

// ---- 7. blocked step -------------------------------------------------------------
const r7 = applyTaskProgressUpdate({ stateDir: STATE, update: upd({
  executorId: 'opencode@sess-1', executionEpoch: 3, currentStep: 1,
  steps: plan3(['BLOCKED', 'PENDING', 'PENDING']), message: 'blocked on API key',
}), now });
eq('blocked ok', r7.ok, true);
const proj7 = renderTaskProgress({ stateDir: STATE, sessionPath: s.sessionPath });
tru('blocked marker', proj7.text.includes('⊗ Bước 1/3 — Inspect'));
tru('blocked message', proj7.text.includes('blocked on API key'));
// BLOCKED -> PENDING is backward.
eq('blocked->pending rejected',
  applyTaskProgressUpdate({ stateDir: STATE, update: upd({
    executorId: 'opencode@sess-1', executionEpoch: 3, currentStep: 1,
    steps: plan3(['PENDING', 'PENDING', 'PENDING']),
  }), now }).code, 'STEP_BACKWARD');

// ---- 8. malformed payload fail-closed (never applied) ---------------------------
const malformed = [
  ['not an object', null],
  ['missing executorId', { ...upd(), executorId: undefined }],
  ['bad executorId', { ...upd(), executorId: 'bad id!!' }],
  ['zero epoch', { ...upd(), executionEpoch: 0 }],
  ['totalSteps 0', { ...upd(), totalSteps: 0 }],
  ['currentStep > total', { ...upd(), currentStep: 4 }],
  ['steps length mismatch', { ...upd(), steps: plan3().slice(0, 2) }],
  ['dup step index', { ...upd(), steps: [plan3()[0], plan3()[0], plan3()[2]] }],
  ['bad status', { ...upd(), steps: plan3(['COMPLETED', 'RUNNING', 'PENDING']) }],
  ['step name empty', { ...upd(), steps: plan3().map((x, i) => (i === 1 ? { ...x, name: '  ' } : x)) }],
  ['message too long', { ...upd(), message: 'x'.repeat(501) }],
];
for (const [name, payload] of malformed) {
  const r = applyTaskProgressUpdate({ stateDir: STATE, update: payload, now });
  tru(`malformed rejected: ${name}`, r.ok === false && r.code);
}
// Unbound: no session record for this identity.
const ghost = mkSession({ issueNumber: 999 });
fs.rmSync(ghost.sessionPath);
eq('unbound rejected',
  applyTaskProgressUpdate({ stateDir: STATE, update: upd({ issueNumber: 999 }), now }).code, 'SESSION_UNBOUND');
// Canonical terminal states refuse new telemetry.
for (const st of ['COMPLETED', 'FAILED', 'BLOCKED']) {
  const t = mkSession({ issueNumber: 800 + ['COMPLETED', 'FAILED', 'BLOCKED'].indexOf(st) });
  writeFileSync(t.sessionPath, JSON.stringify({
    schemaVersion: '1', repo: CANON, issueNumber: t.issueNumber, state: st, lifecycle: [],
  }, null, 2), 'utf8');
  const r = applyTaskProgressUpdate({ stateDir: STATE, update: upd({ issueNumber: t.issueNumber }), now });
  eq(`terminal ${st} refuses telemetry`, `${r.ok}:${r.code}`, `false:SESSION_TERMINAL`);
}
// Missing stateDir.
tru('missing stateDir rejected',
  applyTaskProgressUpdate({ update: upd(), now }).ok === false);

// ---- 9. canonical FSM invariants -----------------------------------------------
// Session record byte-identical after every operation above (telemetry never
// touches the canonical FSM).
eq('session record untouched', readFileSync(s.sessionPath, 'utf8'), beforeBytes);
// No lifecycle event vocabulary may leak into the progress record/history.
const progressText = readFileSync(path.join(STATE, 'task-progress', `${s.id}.json`), 'utf8')
  + readFileSync(path.join(STATE, 'task-progress', `${s.id}.jsonl`), 'utf8');
tru('no TASK_COMPLETED in telemetry', !progressText.includes('TASK_COMPLETED'));
tru('no lifecycle dispatch fields', !progressText.includes('lifecycle'));
// Projection renders NO_SESSION when only telemetry exists (canonical stays authority).
const ghost2 = mkSession({ issueNumber: 777 });
fs.rmSync(ghost2.sessionPath);
const noSess = renderTaskProgress({ stateDir: STATE, identityHash: ghost2.id });
eq('NO_SESSION projection ok', noSess.ok, true);
eq('NO_SESSION canonical marker', noSess.canonicalState, 'NO_SESSION');
tru('NO_SESSION in text', noSess.text.includes('Canonical: NO_SESSION'));
// Corrupt progress ledger -> fail-closed, never fabricated.
writeFileSync(path.join(STATE, 'task-progress', `${s.id}.json`), '{oops', 'utf8');
eq('corrupt ledger fail-closed', renderTaskProgress({ stateDir: STATE, sessionPath: s.sessionPath }).code, 'PROGRESS_RECORD_CORRUPT');
// Projection request malformed.
eq('projection needs stateDir', renderTaskProgress({ sessionPath: s.sessionPath }).ok, false);
eq('projection needs anchor', renderTaskProgress({ stateDir: STATE }).ok, false);
// readProgressRecord missing file is not an error (fresh task).
eq('missing ledger = null', readProgressRecord({ stateDir: STATE, identityHash: ghost2.id }).progress, null);

// ---- summary ---------------------------------------------------------------------
const failed = results.filter((r) => !r.pass);
for (const r of failed) console.error(`FAIL ${r.name}`);
console.log(`task-progress.test: ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
