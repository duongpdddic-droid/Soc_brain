// autonomous-delivery.mjs — ONE shared autonomous delivery controller (v1).
//
// Canonical owner of the repository-wide autonomous delivery chain for ALL
// future code tasks (AUTONOMOUS_DELIVERY_CONTRACT.md v1):
//   TESTING -> COMMITTING -> PUSHING -> PR_DRAFT -> PR_READBACK
//     -> FINAL_REVIEWING -> { REWORK -> TESTING (bounded) | EVIDENCE_GUARD }
//     -> AWAITING_HUMAN_MERGE_DECISION (stop, never merge here).
//
// Design (mirrors review-loop-budget.mjs precedent):
// - Pure, authority-free, dependency-free (zero imports): no FSM terminalize,
//   no spawn, no network, no session/ledger write, no verdict authority.
//   Side effects live in the runners (run.js / executor terminal handler /
//   startup); they perform the step, verify the read-back, then feed the
//   verified EVENT back into advance(). This module only decides.
// - The FIVE entries (foregroundBuild, canonicalExecutorDispatch,
//   resumeDelivery, startupRecover, onTerminalEvent) all delegate to the same
//   advance() core with the same transition table and ownership. No forked
//   logic, no per-entry transport, no narrative input.
// - The controller NEVER merges/deploys/closes/cleans up. Terminal success
//   here is AWAITING_HUMAN_MERGE_DECISION (non-terminal pause for the human
//   merge decision), proven by the evidence guard.
// - Bounds consumed, not redefined: outer REWORK max 3 rounds (parity with
//   control-loop MAX_REWORK_ROUNDS), inner OCR max 2 passes/epoch (parity
//   with review-loop-budget OCR_MAX_PASSES_PER_EPOCH).

export const AUTONOMOUS_DELIVERY_VERSION = '1';
export const CONTROLLER_OWNER = 'autonomous-delivery-v1';
export const FIXED_FINAL_REVIEW_PROVIDER = 'chatgpt-plus-web2api-copy';

// Outer REWORK convergence bound (parity: control-loop MAX_REWORK_ROUNDS).
export const MAX_REWORK_ROUNDS = 3;
export const REWORK_BUDGET_EXHAUSTED = 'REWORK_BUDGET_EXHAUSTED';

export const DELIVERY_CHAIN_STATES = Object.freeze([
  'TESTING',
  'COMMITTING',
  'PUSHING',
  'PR_DRAFT',
  'PR_READBACK',
  'FINAL_REVIEWING',
  'REWORK',
  'EVIDENCE_GUARD',
  'AWAITING_HUMAN_MERGE_DECISION',
  'AWAITING_HUMAN',
  'BLOCKED',
]);

// Non-terminal pause awaiting the human merge decision (PASS proven).
export const AWAITING_HUMAN_MERGE_DECISION = 'AWAITING_HUMAN_MERGE_DECISION';
// Terminal pause — ONLY on a TRUE human gate.
export const AWAITING_HUMAN = 'AWAITING_HUMAN';
export const TERMINAL_DELIVERY_PAUSE = AWAITING_HUMAN;

// TRUE gates (pause allowed). Anything else MUST yield a machine action.
export const TRUE_HUMAN_GATES = Object.freeze([
  'CREDENTIAL_REQUIRED',
  'PERMISSION_REQUIRED',
  'BUSINESS_DECISION_REQUIRED',
  'DESTRUCTIVE_PRODUCTION_AUTHORITY',
  'BRON_DATA_REQUIRED',
]);

// Machine-solvable — NEVER a human gate.
export const NON_HUMAN_GATES = Object.freeze([
  'EXECUTOR_EXITED',
  'STALE_SESSION_ACTIVE',
  'REVIEW_REWORK',
  'TEST_FAIL',
  'EVIDENCE_TRANSPORT_FAIL',
  'HANDOFF_PERSIST_FAIL',
  'WORKTREE_INFRA',
  'MACHINE_SOLVABLE_DEPENDENCY',
  'REPAIR_TASK_REQUIRED',
]);

export function isTrueHumanGate(reasonCode) {
  return TRUE_HUMAN_GATES.includes(reasonCode);
}

const HEAD_SHA_40 = /^[0-9a-f]{40}$/;

function fail(code, detail) {
  return { ok: false, code, detail: detail ?? null };
}
function ok(value) {
  return { ok: true, value };
}

function checkOwnership(record) {
  if (!record || typeof record !== 'object') return fail('DELIVERY_RECORD_REQUIRED');
  if (record.controllerOwner !== CONTROLLER_OWNER) {
    return fail('DELIVERY_OWNER_CONFLICT', `expected ${CONTROLLER_OWNER}, got ${record.controllerOwner ?? null}`);
  }
  return ok(record);
}

// ---- Record ---------------------------------------------------------------
export function createDeliveryRecord({ taskId, repo, issue, baseSha = null } = {}) {
  if (typeof taskId !== 'string' || !taskId.trim()) return fail('DELIVERY_IDENTITY_INVALID', 'taskId required');
  if (typeof repo !== 'string' || !repo.trim()) return fail('DELIVERY_IDENTITY_INVALID', 'repo required');
  if (!Number.isInteger(issue) || issue <= 0) return fail('DELIVERY_IDENTITY_INVALID', 'issue must be positive integer');
  if (baseSha !== null && (typeof baseSha !== 'string' || !HEAD_SHA_40.test(baseSha.toLowerCase()))) {
    return fail('DELIVERY_IDENTITY_INVALID', 'baseSha must be 40-hex or null');
  }
  return ok({
    schemaVersion: AUTONOMOUS_DELIVERY_VERSION,
    kind: 'autonomous-delivery',
    controllerOwner: CONTROLLER_OWNER,
    taskId: taskId.trim(),
    repo: repo.trim(),
    issue,
    baseSha: baseSha ? baseSha.toLowerCase() : null,
    state: 'TESTING',
    chain: [],
    evidence: {},
    reworkRounds: 0,
    ocrPassesUsed: 0,
    finalReviewProvider: FIXED_FINAL_REVIEW_PROVIDER,
    humanGate: null,
    migratedFrom: null,
    updatedAt: new Date().toISOString(),
  });
}

// ---- Deterministic invariant: what MUST the machine do next? --------------
export function nextMachineAction(record) {
  const own = checkOwnership(record);
  if (!own.ok) return own;
  const r = record;
  if (r.state === AWAITING_HUMAN_MERGE_DECISION) {
    return ok({ do: 'WAIT_HUMAN_MERGE_DECISION', state: r.state, pause: true });
  }
  if (r.state === AWAITING_HUMAN) {
    return ok({ do: 'WAIT_TRUE_HUMAN_GATE', state: r.state, pause: true, gate: r.humanGate });
  }
  if (r.state === 'BLOCKED') {
    return ok({ do: 'REPORT_BLOCKED', state: r.state, pause: true });
  }
  const stepAction = {
    TESTING: 'RUN_TARGETED_TESTS',
    COMMITTING: 'COMMIT_WORKTREE_HEAD',
    PUSHING: 'PUSH_EXACT_HEAD',
    PR_DRAFT: 'OPEN_DRAFT_PR',
    PR_READBACK: 'READBACK_PR_HEAD',
    FINAL_REVIEWING: 'REQUEST_WEB2API_REVIEW',
    REWORK: 'REPAIR_BATCH_THEN_REVERIFY',
    EVIDENCE_GUARD: 'VERIFY_MERGE_DECISION_EVIDENCE',
  }[r.state];
  if (!stepAction) return fail('DELIVERY_STATE_UNKNOWN', r.state);
  return ok({ do: stepAction, state: r.state, pause: false });
}

// ---- Pure transition: verified EVENT -> next record ------------------------
export function advance(record, event = {}) {
  const own = checkOwnership(record);
  if (!own.ok) return own;
  if (!event || typeof event !== 'object') return fail('DELIVERY_EVENT_REQUIRED');
  const { type } = event;
  const at = new Date().toISOString();

  const step = (nextState, evidencePatch = {}) => ok({
    ...record,
    state: nextState,
    chain: [...record.chain, { from: record.state, to: nextState, event: type ?? null, at }],
    evidence: { ...record.evidence, ...evidencePatch },
    updatedAt: at,
  });

  switch (record.state) {
    case 'TESTING': {
      if (type === 'TEST_PASSED') {
        if (!event.testEvidence || typeof event.testEvidence !== 'object') {
          return fail('DELIVERY_EVIDENCE_INVALID', 'TEST_PASSED requires testEvidence');
        }
        return step('COMMITTING', { testEvidence: event.testEvidence });
      }
      if (type === 'TEST_FAILED') return step('REWORK', { lastTestFailure: event.detail ?? null });
      if (type === 'TRUE_GATE') return gatePause(record, event, at);
      return fail('DELIVERY_EVENT_UNEXPECTED', `${record.state} cannot handle ${type}`);
    }
    case 'COMMITTING': {
      if (type === 'COMMITTED') {
        const head = String(event.headSha || '').toLowerCase();
        if (!HEAD_SHA_40.test(head)) return fail('DELIVERY_EVIDENCE_INVALID', 'COMMITTED requires 40-hex headSha');
        return step('PUSHING', { headSha: head });
      }
      if (type === 'TRUE_GATE') return gatePause(record, event, at);
      return fail('DELIVERY_EVENT_UNEXPECTED', `${record.state} cannot handle ${type}`);
    }
    case 'PUSHING': {
      if (type === 'PUSHED') {
        const remote = String(event.remoteSha || '').toLowerCase();
        if (!HEAD_SHA_40.test(remote)) return fail('DELIVERY_EVIDENCE_INVALID', 'PUSHED requires 40-hex remoteSha');
        if (record.evidence.headSha && remote !== record.evidence.headSha) {
          return fail('DELIVERY_BIND_STALE', `remote ${remote} != head ${record.evidence.headSha}`);
        }
        return step('PR_DRAFT', { remoteSha: remote });
      }
      if (type === 'TRUE_GATE') return gatePause(record, event, at);
      return fail('DELIVERY_EVENT_UNEXPECTED', `${record.state} cannot handle ${type}`);
    }
    case 'PR_DRAFT': {
      if (type === 'PR_DRAFTED') {
        if (!Number.isInteger(event.prNumber) || event.prNumber <= 0) {
          return fail('DELIVERY_EVIDENCE_INVALID', 'PR_DRAFTED requires prNumber');
        }
        return step('PR_READBACK', { prNumber: event.prNumber, prDraft: event.draft === true });
      }
      if (type === 'TRUE_GATE') return gatePause(record, event, at);
      return fail('DELIVERY_EVENT_UNEXPECTED', `${record.state} cannot handle ${type}`);
    }
    case 'PR_READBACK': {
      if (type === 'PR_READBACK_OK') {
        const prHead = String(event.prHeadSha || '').toLowerCase();
        if (!HEAD_SHA_40.test(prHead)) return fail('DELIVERY_EVIDENCE_INVALID', 'PR_READBACK_OK requires 40-hex prHeadSha');
        if (record.evidence.headSha && prHead !== record.evidence.headSha) {
          return fail('DELIVERY_BIND_STALE', `PR head ${prHead} != approved ${record.evidence.headSha}`);
        }
        if (String(event.prState || '').toUpperCase() !== 'OPEN') {
          return fail('DELIVERY_EVIDENCE_INVALID', 'PR must be OPEN at read-back');
        }
        return step('FINAL_REVIEWING', { prHeadSha: prHead, prState: 'OPEN' });
      }
      if (type === 'TRUE_GATE') return gatePause(record, event, at);
      return fail('DELIVERY_EVENT_UNEXPECTED', `${record.state} cannot handle ${type}`);
    }
    case 'FINAL_REVIEWING': {
      if (type === 'REVIEW_PASS') {
        const b = event.binding || {};
        const head = String(b.headSha || '').toLowerCase();
        if (String(event.verdict || '').toUpperCase() !== 'PASS') {
          return fail('DELIVERY_EVIDENCE_INVALID', 'REVIEW_PASS requires verdict PASS');
        }
        if (record.evidence.headSha && head !== record.evidence.headSha) {
          return fail('DELIVERY_BIND_STALE', `review binding head ${head} != approved ${record.evidence.headSha}`);
        }
        return step('EVIDENCE_GUARD', { reviewVerdict: 'PASS', reviewBinding: b });
      }
      if (type === 'REVIEW_REWORK') {
        const rounds = record.reworkRounds + 1;
        if (rounds > MAX_REWORK_ROUNDS) {
          return ok({
            ...record,
            state: AWAITING_HUMAN,
            chain: [...record.chain, { from: record.state, to: AWAITING_HUMAN, event: type, at }],
            humanGate: { reasonCode: 'BUSINESS_DECISION_REQUIRED', detail: REWORK_BUDGET_EXHAUSTED, rounds },
            updatedAt: at,
          });
        }
        return ok({
          ...record,
          state: 'REWORK',
          chain: [...record.chain, { from: record.state, to: 'REWORK', event: type, at }],
          evidence: { ...record.evidence, lastReworkFindings: event.findings ?? [] },
          reworkRounds: rounds,
          ocrPassesUsed: 0,
          updatedAt: at,
        });
      }
      if (type === 'REVIEW_BLOCKED') {
        return step('BLOCKED', { reviewBlocked: event.detail ?? null });
      }
      if (type === 'TRUE_GATE') return gatePause(record, event, at);
      return fail('DELIVERY_EVENT_UNEXPECTED', `${record.state} cannot handle ${type}`);
    }
    case 'REWORK': {
      if (type === 'REPAIR_VERIFIED') {
        return step('TESTING', { lastRepairEpoch: record.reworkRounds });
      }
      if (type === 'TRUE_GATE') return gatePause(record, event, at);
      return fail('DELIVERY_EVENT_UNEXPECTED', `${record.state} cannot handle ${type}`);
    }
    case 'EVIDENCE_GUARD': {
      if (type === 'EVIDENCE_VERIFIED') {
        const g = requireMergeDecisionEvidence(record);
        if (!g.ok) return g;
        return step(AWAITING_HUMAN_MERGE_DECISION, {});
      }
      if (type === 'TRUE_GATE') return gatePause(record, event, at);
      return fail('DELIVERY_EVENT_UNEXPECTED', `${record.state} cannot handle ${type}`);
    }
    case AWAITING_HUMAN_MERGE_DECISION:
    case AWAITING_HUMAN:
    case 'BLOCKED': {
      if (type === 'RESUME_HUMAN_DECISION' && record.state === AWAITING_HUMAN) {
        return fail('DELIVERY_HUMAN_GATE_HELD', 'human gate holds until the true gate clears outside the controller');
      }
      return fail('DELIVERY_PAUSE_HELD', `${record.state} holds; the controller never self-resumes a pause`);
    }
    default:
      return fail('DELIVERY_STATE_UNKNOWN', record.state);
  }
}

function gatePause(record, event, at) {
  const reasonCode = event.reasonCode;
  if (!isTrueHumanGate(reasonCode)) {
    return fail('DELIVERY_NOT_A_HUMAN_GATE', `${reasonCode ?? null} is machine-solvable and must yield a machine action`);
  }
  return ok({
    ...record,
    state: AWAITING_HUMAN,
    chain: [...record.chain, { from: record.state, to: AWAITING_HUMAN, event: 'TRUE_GATE', at }],
    humanGate: { reasonCode, detail: event.detail ?? null },
    updatedAt: at,
  });
}

// ---- Evidence guard: the ONLY gate into AWAITING_HUMAN_MERGE_DECISION ------
export function requireMergeDecisionEvidence(record) {
  const own = checkOwnership(record);
  if (!own.ok) return own;
  const e = record.evidence || {};
  const missing = [];
  if (!e.testEvidence || typeof e.testEvidence !== 'object') missing.push('testEvidence');
  if (typeof e.headSha !== 'string' || !HEAD_SHA_40.test(e.headSha)) missing.push('headSha');
  if (typeof e.remoteSha !== 'string' || e.remoteSha !== e.headSha) missing.push('remoteSha==headSha');
  if (!Number.isInteger(e.prNumber) || e.prNumber <= 0) missing.push('prNumber');
  if (e.prHeadSha !== e.headSha) missing.push('prHeadSha==headSha');
  if (e.prState !== 'OPEN') missing.push('prState==OPEN');
  if (e.prDraft !== true) missing.push('prDraft==true');
  if (e.reviewVerdict !== 'PASS') missing.push('reviewVerdict==PASS');
  const b = e.reviewBinding || {};
  if (String(b.headSha || '').toLowerCase() !== e.headSha) missing.push('reviewBinding.headSha');
  if (Number(b.issue) !== record.issue) missing.push('reviewBinding.issue');
  if (typeof b.repository !== 'string' || b.repository.toLowerCase() !== String(record.repo).toLowerCase()) {
    missing.push('reviewBinding.repository');
  }
  if (record.reworkRounds > MAX_REWORK_ROUNDS) missing.push('reworkRounds<=3');
  if (record.finalReviewProvider !== FIXED_FINAL_REVIEW_PROVIDER) missing.push('finalReviewProvider==fixed');
  if (missing.length) return fail('MERGE_DECISION_EVIDENCE_INCOMPLETE', { missing });
  return ok({ ready: true, state: 'EVIDENCE_GUARD' });
}

// ---- UI/reporting: canonical state ONLY (narrative never enters) ------------
export function deriveReport(record) {
  const own = checkOwnership(record);
  if (!own.ok) return own;
  const e = record.evidence || {};
  return ok({
    schemaVersion: AUTONOMOUS_DELIVERY_VERSION,
    taskId: record.taskId,
    repo: record.repo,
    issue: record.issue,
    state: record.state,
    chain: record.chain.map((t) => ({ from: t.from, to: t.to, event: t.event, at: t.at })),
    evidenceSummary: {
      tested: e.testEvidence ? true : false,
      headSha: e.headSha ?? null,
      pushed: typeof e.remoteSha === 'string' && e.remoteSha === e.headSha,
      draftPr: Number.isInteger(e.prNumber) ? e.prNumber : null,
      prVerified: e.prHeadSha === e.headSha && e.prState === 'OPEN',
      reviewVerdict: e.reviewVerdict ?? null,
      reworkRounds: record.reworkRounds,
    },
    humanGate: record.humanGate,
    finalReviewProvider: record.finalReviewProvider,
    next: (() => { const n = nextMachineAction(record); return n.ok ? n.value : { do: 'REPORT_ERROR', code: n.code }; })(),
    updatedAt: record.updatedAt,
  });
}

// ---- Migration for existing tasks -------------------------------------------
export function migrateLegacyTask(legacy = {}) {
  if (!legacy || typeof legacy !== 'object') return fail('MIGRATION_INPUT_INVALID');
  const { taskId, repo, issue, baseSha = null, headSha = null, prNumber = null, provider = null, state = null } = legacy;
  if (typeof taskId !== 'string' || !taskId.trim()) return fail('MIGRATION_BIND_FAILED', 'taskId');
  if (typeof repo !== 'string' || !repo.trim()) return fail('MIGRATION_BIND_FAILED', 'repo');
  if (!Number.isInteger(issue) || issue <= 0) return fail('MIGRATION_BIND_FAILED', 'issue');
  const created = createDeliveryRecord({ taskId, repo, issue, baseSha });
  if (!created.ok) return fail('MIGRATION_BIND_FAILED', created.detail);
  const record = created.value;
  if (typeof headSha === 'string' && HEAD_SHA_40.test(headSha.toLowerCase())) {
    record.evidence.headSha = headSha.toLowerCase();
  }
  if (Number.isInteger(prNumber) && prNumber > 0) record.evidence.prNumber = prNumber;
  // Legacy verdicts from another transport are NEVER reused as PASS: the
  // migrated task always needs a fresh Web2API review.
  record.state = 'FINAL_REVIEWING';
  record.migratedFrom = { provider: provider ?? null, state: state ?? null };
  record.finalReviewProvider = FIXED_FINAL_REVIEW_PROVIDER;
  record.updatedAt = new Date().toISOString();
  return ok({ record, migrated: { fromProvider: provider ?? null, toProvider: FIXED_FINAL_REVIEW_PROVIDER } });
}

// ---- The FIVE shared entries (one core: advance/nextMachineAction) -----------
function entryResult(record, event, entry) {
  const own = checkOwnership(record);
  if (!own.ok) return own;
  const r = advance(record, event);
  if (!r.ok) return r;
  return ok({ entry, record: r.value });
}

// Build foreground (OpenCode daily-driver direct implementation).
export function foregroundBuild({ record, event } = {}) {
  return entryResult(record, event, 'foregroundBuild');
}

// Canonical executor dispatch (Cline/OpenCode/future via ControlLoop).
export function canonicalExecutorDispatch({ record, event } = {}) {
  return entryResult(record, event, 'canonicalExecutorDispatch');
}

// Resume from canonical persisted state (never re-runs verified checkpoints:
// advance() only moves forward on NEW verified events; re-fed old events for
// an already-passed state fail closed as DELIVERY_EVENT_UNEXPECTED instead of
// duplicating side effects).
export function resumeDelivery({ record, event } = {}) {
  return entryResult(record, event, 'resumeDelivery');
}

// Startup recovery after crash/restart (same forward-only core as resume).
export function startupRecover({ record, event } = {}) {
  return entryResult(record, event, 'startupRecover');
}

// Terminal-event wake: executor reached a terminal execution status.
// Only canonical terminal evidence wakes the chain; narrative "done" never does.
export function onTerminalEvent({ record, terminalEvidence } = {}) {
  const own = checkOwnership(record);
  if (!own.ok) return own;
  if (!terminalEvidence || typeof terminalEvidence !== 'object') return fail('DELIVERY_EVENT_REQUIRED');
  const status = String(terminalEvidence.executionStatus || '').toUpperCase();
  if (!['EXITED', 'FAILED', 'TIMEOUT'].includes(status)) {
    return fail('DELIVERY_NOT_A_TERMINAL_EVENT', status || null);
  }
  const event = status === 'EXITED' && terminalEvidence.testEvidence
    ? { type: 'TEST_PASSED', testEvidence: terminalEvidence.testEvidence }
    : status === 'EXITED'
      ? { type: 'TEST_PASSED', testEvidence: { executionStatus: 'EXITED', terminal: true } }
      : { type: 'TEST_FAILED', detail: `${status}: ${(terminalEvidence.detail || '').slice(0, 200)}` };
  return entryResult(record, event, 'onTerminalEvent');
}
