#!/usr/bin/env node
// fast-path.mjs — Soc_brain: deterministic FAST_PATH router + latency telemetry (Issue #123).
//
// Scope-bounded: a PURE classifier routes a task to FAST_PATH only when every
// gate is explicitly satisfiable; anything missing or ambiguous falls back to
// STANDARD_PATH (fail-closed default). No AI, no hidden-state heuristics, no
// external watcher, no coarse polling, no auto-chain: runFastPath executes
// exactly ONE task and returns. Verification failure is fail-closed — the
// terminal outcome is FAIL_CLOSED and telemetry is still persisted.
//
// ponytail: classifier is a strict-AND over 6 declared descriptor fields; when
// a real admission surface exists (control-loop taskStart), replace the plain
// descriptor with the canonical task record and keep the gate order stable.
//
// Reuse: packages/workspace bindTask (canonical worktree provisioning).

import fs from 'node:fs';
import path from 'node:path';

export const FAST_ROUTE = 'FAST_PATH';
export const STANDARD_ROUTE = 'STANDARD_PATH';

// Latency fields mandated by Issue #123. reviewStartedAt is optional (stays
// null on the fast path — deterministic evidence is sufficient, no semantic
// AI review is invoked).
export const LATENCY_FIELDS = Object.freeze([
  'acceptedAt', 'routedAt', 'executorStartedAt', 'firstMeaningfulActivityAt',
  'implementationDoneAt', 'verificationStartedAt', 'verificationDoneAt',
  'reviewStartedAt', 'resultPersistedAt', 'completedAt',
]);

// ---- classifyRoute ----------------------------------------------------------
// FAST_PATH requires ALL of: clear scope note, declared deterministic
// acceptance tests, not security-sensitive, no schema/data migration, single
// repo, no destructive mutation, uncertainty explicitly 'low'. Any missing
// field is a reason to route STANDARD (never guessed).
export function classifyRoute(descriptor = {}) {
  const reasons = [];
  if (typeof descriptor.scopeNote !== 'string' || descriptor.scopeNote.trim() === '') reasons.push('SCOPE_UNCLEAR');
  if (!Array.isArray(descriptor.acceptanceTests) || descriptor.acceptanceTests.length === 0) reasons.push('NO_DETERMINISTIC_ACCEPTANCE');
  if (descriptor.securitySensitive === true) reasons.push('SECURITY_SENSITIVE');
  if (descriptor.schemaOrDataMigration === true) reasons.push('SCHEMA_OR_DATA_MIGRATION');
  if (descriptor.multiRepo === true) reasons.push('MULTI_REPO');
  if (descriptor.destructiveMutation === true) reasons.push('DESTRUCTIVE_MUTATION');
  if (descriptor.uncertainty !== 'low') reasons.push('UNCERTAINTY_NOT_LOW');
  return { route: reasons.length === 0 ? FAST_ROUTE : STANDARD_ROUTE, reasons };
}

// ---- telemetry --------------------------------------------------------------
// Canonical telemetry file location (single naming source shared by runFastPath
// and the ControlLoop fast-path wiring, Issue #125).
export function telemetryPathFor({ stateDir, repo, issueNumber }) {
  const taskId = `${repo}#${issueNumber}`;
  return path.join(stateDir, 'fast-path', `${taskId.replace(/[^\w.-]+/g, '_')}.json`);
}

export function createTelemetry({ acceptedAt = null } = {}) {
  const t = {
    fields: {},
    waits: { providerWaitMs: 0, pollingWaitMs: 0, recoveryWaitMs: 0 },
    set(field, value) { t.fields[field] = value; return value; },
    addWait(kind, ms) {
      if (!Number.isFinite(ms) || ms < 0) return t.waits[kind] ?? 0;
      t.waits[kind] = (t.waits[kind] ?? 0) + ms;
      return t.waits[kind];
    },
    snapshot() { return { ...t.fields, ...t.waits }; },
  };
  if (acceptedAt !== null) t.fields.acceptedAt = acceptedAt;
  return t;
}

const ms = (iso) => (iso ? new Date(iso).getTime() : NaN);
const dur = (a, b) => (Number.isFinite(ms(a)) && Number.isFinite(ms(b)) ? Math.max(0, ms(b) - ms(a)) : 0);

// Computes mandated aggregates from the timestamp fields + accumulated waits.
export function finalizeTelemetry(snapshot) {
  return {
    totalWallClockMs: dur(snapshot.acceptedAt, snapshot.completedAt),
    productiveMs: dur(snapshot.executorStartedAt, snapshot.implementationDoneAt)
      + dur(snapshot.verificationStartedAt, snapshot.verificationDoneAt),
    providerWaitMs: snapshot.providerWaitMs ?? 0,
    pollingWaitMs: snapshot.pollingWaitMs ?? 0,
    recoveryWaitMs: snapshot.recoveryWaitMs ?? 0,
  };
}

// Atomic JSON write (tmp + rename), then read-back helper.
export function persistTelemetry(telemetryPath, telemetry) {
  const dir = path.dirname(telemetryPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${telemetryPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(telemetry, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, telemetryPath);
  return telemetryPath;
}

// Fail-closed read-back: a missing telemetry file is an error, never a silent
// skip (deterministic read-back MUST NOT be bypassed — Issue #123 item E).
export function readTelemetry(telemetryPath) {
  let raw;
  try {
    raw = fs.readFileSync(telemetryPath, 'utf8');
  } catch {
    const e = new Error(`telemetry not persisted at ${telemetryPath}`);
    e.code = 'TELEMETRY_NOT_PERSISTED';
    throw e;
  }
  return JSON.parse(raw);
}

// ---- runFastPath ------------------------------------------------------------
// One task in, one outcome out. Stages stamp the mandated telemetry fields.
// STANDARD_PATH tasks are returned un-run (the caller's standard pipeline owns
// them); FAST_PATH tasks run inside the provisioned worktree, verify
// deterministically, persist telemetry (read-back backed), and terminate.
export async function runFastPath({
  descriptor = {},
  worktreesRoot,
  repo,
  issueNumber,
  baseSha,
  stateDir,
  provisionWorktree = defaultProvision,
  execute = async () => ({}),
  verify = async () => ({ ok: false, error: 'NO_VERIFIER' }),
  clock = () => new Date().toISOString(),
} = {}) {
  const acceptedAt = clock();
  const classify = classifyRoute(descriptor);
  const routedAt = clock();
  if (classify.route !== FAST_ROUTE) {
    return { route: STANDARD_ROUTE, terminal: 'ROUTED_STANDARD', ok: null, classify, telemetry: { acceptedAt, routedAt } };
  }

  const telemetryPath = telemetryPathFor({ stateDir, repo, issueNumber });
  const t = createTelemetry({ acceptedAt });
  t.set('routedAt', routedAt);

  let wt;
  try {
    wt = await provisionWorktree({ worktreesRoot, repo, issueNumber, baseSha });
  } catch (e) {
    t.set('completedAt', clock());
    const snap = { ...t.snapshot(), ...finalizeTelemetry(t.snapshot()) };
    persistTelemetry(telemetryPath, snap);
    return { route: FAST_ROUTE, terminal: 'FAIL_CLOSED', ok: false, semanticReviewInvoked: false, error: `WORKTREE_PROVISION_FAILED: ${String(e)}`, telemetry: snap, telemetryPath };
  }
  t.set('executorStartedAt', clock());

  await execute({ worktreePath: wt.path, branch: wt.branch, descriptor, telemetry: t });
  if (t.fields.firstMeaningfulActivityAt === undefined) t.set('firstMeaningfulActivityAt', clock());
  t.set('implementationDoneAt', clock());

  t.set('verificationStartedAt', clock());
  let verdict;
  try {
    verdict = await verify({ worktreePath: wt.path, branch: wt.branch, descriptor });
  } catch (e) {
    verdict = { ok: false, error: `VERIFIER_THREW: ${String(e)}` };
  }
  t.set('verificationDoneAt', clock());

  const ok = Boolean(verdict && verdict.ok);
  t.set('resultPersistedAt', clock());
  persistTelemetry(telemetryPath, { ...t.snapshot(), ...finalizeTelemetry(t.snapshot()) });

  t.set('completedAt', clock());
  const snap = { ...t.snapshot(), ...finalizeTelemetry(t.snapshot()) };
  persistTelemetry(telemetryPath, snap);

  return ok
    ? { route: FAST_ROUTE, terminal: 'HANDOFF_READY', ok: true, semanticReviewInvoked: false, evidence: verdict.evidence ?? null, telemetry: snap, telemetryPath, worktree: wt }
    : { route: FAST_ROUTE, terminal: 'FAIL_CLOSED', ok: false, semanticReviewInvoked: false, error: verdict?.error ?? 'VERIFICATION_FAILED', evidence: verdict?.evidence ?? null, telemetry: snap, telemetryPath, worktree: wt };
}

// Default provisioning uses the canonical workspace primitive (real runs).
async function defaultProvision({ worktreesRoot, repo, issueNumber, baseSha }) {
  const { bindTask } = await import('../workspace/workspace.mjs');
  const r = bindTask({ worktreesRoot, repo, issueNumber, baseSha });
  if (!r.ok) { const e = new Error(r.reason || 'BIND_TASK_FAILED'); e.detail = r.detail; throw e; }
  return { path: r.path, branch: r.branch, head: r.head };
}
