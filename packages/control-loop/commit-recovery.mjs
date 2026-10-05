// commit-recovery.mjs — Issue #264 option C: canonical recovery for
// "the executor finished, but its task output is still uncommitted" at the
// VERIFYING checkpoint.
//
// The closed loop this closes (reproduced offline before the fix, evidence at
// evidence/pr-263/<head>/commit-recovery-repro.log):
//
//   EXECUTING->VERIFYING  ->  runPublishChain
//                          ->  pushBranch scope guard
//                          ->  PUSH_DIRTY_FOREIGN  { foreignPaths }
//                          ->  publishChainFailure (recoverable:false,
//                              resumeState:'VERIFYING')
//   resume                 ->  same tail -> same chain -> same failure ...
//
// ALLOWED_TRANSITIONS.VERIFYING = { PRE_REVIEWING, BLOCKED }: there is no edge
// back to EXECUTING and no edge to DECIDING, so a resume can NEVER reach a
// rework dispatch. The executor is never told to commit, and the uncommitted
// task output can never reach review — an unbounded, non-progressing state.
//
// Scope of this module (deliberately narrow — Issue #264 option C):
//   * PUSH_DIRTY_FOREIGN itself is UNCHANGED: a dirty worktree is still never
//     pushed (push.mjs remains the sole gate, and this module never bypasses,
//     softens or re-classifies it).
//   * NO FSM state is added and NO transition is emitted: the VERIFYING
//     checkpoint and every prior evidence record are preserved byte-for-byte.
//     The recovery attempt is recorded by a CANONICAL API instead (atomic
//     tmp+rename under control-loop/<identityHash>/commit-recovery/), which is
//     the same persistence seam rework decisions already use.
//   * Dispatch reuses the EXISTING executor adapter channel
//     (deps.executor + reworkInstruction), i.e. the same primitive runReworkLeg
//     uses — admission (taskStart) is NOT an executor dispatch and is never
//     used here as a stand-in for one.
//
// Fail-closed contract — every refusal is typed, records nothing and dispatches
// nothing:
//   COMMIT_RECOVERY_SCOPE_UNDECLARED   no canonical scope/whitelist is declared
//                                      for this session (drift-guard
//                                      SCOPE_UNDECLARED) — a tracked path is
//                                      NEVER proof of scope on its own
//   COMMIT_RECOVERY_SCOPE_AUTHORITY_UNPROVEN
//                                      the worktree contract claim is not bound
//                                      to THIS task/identity, or its canonical
//                                      source is missing/unreadable — a heading
//                                      the executor typed is never authority
//   COMMIT_RECOVERY_BINDING_INCOMPLETE the canonical binding tuple is absent,
//                                      empty ({}) or missing/invalid on ANY of
//                                      its four mandatory fields (taskId,
//                                      identityHash, repo, issueNumber). It
//                                      refuses BEFORE any comparison, so an
//                                      incomplete binding can never be read as
//                                      "no mismatch found" -> ok:true.
//   COMMIT_RECOVERY_SCOPE_WIDENED      the declared whitelist reaches outside
//                                      the canonical scope/whitelist
//   COMMIT_RECOVERY_SCOPE_VIOLATION    a dirty path is outside the declared
//                                      canonical task scope
//   COMMIT_RECOVERY_SCOPE_EMPTY        nothing in-scope to commit
//   COMMIT_RECOVERY_AUTHORITY_UNPROVEN no ExecutionRecord / identity mismatch /
//                                      pending bind-or-cleanup latch
//   COMMIT_RECOVERY_EXECUTOR_NOT_TERMINAL  the prior executor is still alive or
//                                      its liveness is unprovable
//   COMMIT_RECOVERY_ALREADY_DISPATCHED the idempotency lock already covers this
//                                      dirty set (relaunch/replay never spawns
//                                      a second recovery executor)
//   COMMIT_RECOVERY_BUDGET_EXHAUSTED   per-identity attempt budget reached
//   COMMIT_RECOVERY_PERSIST_FAILED     the canonical attempt record could not be
//                                      written (attempt never starts)
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  reconcileExecutorLiveness,
  classifyExecutor,
  pendingExecutorLatch,
} from '../executor-launcher/executor-reconcile.mjs';
import { checkScope, normalizeRelPath, DRIFT_CODES, TASK_CONTRACT_SCOPE_HEADINGS, parseTaskContractScope } from '../supervisor/drift-guard.mjs';

// The Task Contract parser is owned by drift-guard (a leaf) so the control
// plane can bind the CANONICAL declaration at projection time and this module
// can reconcile the worktree copy against it with the SAME parser.
export { TASK_CONTRACT_SCOPE_HEADINGS, parseTaskContractScope };

export const COMMIT_RECOVERY_SCHEMA_VERSION = '1';

// Exactly-once per dirty set, bounded per identity — the same budget shape the
// rework leg uses (MAX_REWORK_ROUNDS) so a pathological loop cannot spin
// forever on dispatches.
export const MAX_COMMIT_RECOVERY_ATTEMPTS = 3;

// The liveness values for which reconcileExecutorLiveness + classifyExecutor
// both say the prior executor is finished and can no longer mutate. Anything
// else (STARTING / RUNNING / PID_REUSED / OWNERSHIP_UNKNOWN / an unknown
// terminalStatus string) is NOT a proven terminal executor and typed-blocks.
export const TERMINAL_EXECUTOR_LIVENESS = Object.freeze(
  new Set(['EXITED', 'FAILED', 'STOPPED', 'INTERRUPTED']),
);

export const COMMIT_RECOVERY_CODES = Object.freeze([
  'COMMIT_RECOVERY_SCOPE_UNDECLARED',
  'COMMIT_RECOVERY_SCOPE_VIOLATION',
  'COMMIT_RECOVERY_SCOPE_EMPTY',
  'COMMIT_RECOVERY_SCOPE_AUTHORITY_UNPROVEN',
  'COMMIT_RECOVERY_SCOPE_WIDENED',
  'COMMIT_RECOVERY_BINDING_INCOMPLETE',
  'COMMIT_RECOVERY_STATUS_FAILED',
  'COMMIT_RECOVERY_AMBIGUOUS',
  'COMMIT_RECOVERY_AUTHORITY_UNPROVEN',
  'COMMIT_RECOVERY_EXECUTOR_NOT_TERMINAL',
  'COMMIT_RECOVERY_ALREADY_DISPATCHED',
  'COMMIT_RECOVERY_BUDGET_EXHAUSTED',
  'COMMIT_RECOVERY_PERSIST_FAILED',
  'COMMIT_RECOVERY_ROUTE_UNAVAILABLE',
  'COMMIT_RECOVERY_NO_EXECUTOR',
  'COMMIT_RECOVERY_DISPATCH_THREW',
  'COMMIT_RECOVERY_DISPATCH_FAILED',
  'COMMIT_RECOVERY_INCOMPLETE',
]);

const MAX_PATHS_IN_SCOPE = 200;
const MAX_NAMED_PATHS = 2000;

function ok(v) { return { ok: true, value: v }; }
function fail(code, detail) { return { ok: false, code, detail: detail ?? null }; }

// ---- pathspec normalization ------------------------------------------------
// Mirrors push.mjs cleanPathspecsForPush so a path classified in-scope here is
// byte-identical to the path push.mjs refused.
export function normalizePathspec(p) {
  if (typeof p !== 'string') return null;
  const n = p.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
  return n || null;
}

// A recovery commit may only ever touch a path INSIDE the bound worktree.
// Absolute paths, drive letters, `..` traversal and `.git` internals are
// refused outright — never presented as merely "out of scope".
export function isSafePathspec(p) {
  const n = normalizePathspec(p);
  if (!n) return false;
  if (n.startsWith('/') || /^[A-Za-z]:/.test(n)) return false;
  if (n.split('/').some((seg) => seg === '..')) return false;
  if (n === '.git' || n.startsWith('.git/')) return false;
  return true;
}

// ---- canonical scope -------------------------------------------------------
// Issue #263 reviewer finding 1: a TRACKED path is NOT automatically in task
// scope. Git tracking only says "this path is already in this worktree's
// index/HEAD" — it says nothing about who authorized touching it. The ONLY
// authority for a recovery commit is the declared canonical scope/whitelist
// (drift-guard checkScope, whose allowedPaths come from the Task Contract),
// reconciled against the CANONICAL authorization source below. Recovery never
// guesses scope, and reviewer prose is never scraped for path-shaped tokens to
// synthesize one.
//
// The canonical source is `session.taskContract`, written by the CONTROL PLANE
// at projection time (runtime-sandbox `writeTaskContract`, the same seam that
// already binds `digests.opencodeConfig`). It lives in the canonical session
// record outside the worktree, so it is never executor-writable: a `## Scope`
// heading the executor typed into `.soc/task-contract.md` is a CLAIM, and only
// a claim that is bound to this task/identity and still inside the canonical
// whitelist can authorize a recovery commit.
export const TASK_CONTRACT_BINDING_RE = /^#\s*Task Contract\s*[-—]\s*(.+)$/m;

// The four mandatory fields of the canonical binding tuple. ALL of them must be
// present and type-correct; a partial binding carries no authority whatsoever
// because every later comparison is a `!= null && ...` guard — with one field
// absent the mismatch list simply stays empty and the old code fell through to
// ok:true. Completeness is therefore checked FIRST, on its own, before any
// value is ever compared.
export const TASK_CONTRACT_BINDING_FIELDS = Object.freeze(['taskId', 'identityHash', 'repo', 'issueNumber']);

function isBindingFieldComplete(field, value) {
  if (field === 'issueNumber') {
    // A positive integer, or a string that denotes one (JSON round-trips in
    // some ledgers keep issue numbers as text).
    const n = (typeof value === 'string' && value.trim()) ? Number(value.trim()) : value;
    return Number.isInteger(n) && n > 0;
  }
  return typeof value === 'string' && value.trim().length > 0;
}

// Fail-closed: absent (null/undefined/non-object), empty ({}) or partial all
// land here, with the offending field names so the reviewer sees exactly which
// part of the tuple was not proven. There is no path from this function to
// ok:true.
function bindingIncomplete(fields) {
  return {
    ok: false,
    code: 'COMMIT_RECOVERY_BINDING_INCOMPLETE',
    reason: 'AUTHORITY_UNPROVEN',
    authority: 'TASK_CONTRACT_BINDING_INCOMPLETE',
    field: 'session.taskContract.binding',
    fields: [...fields],
    allowedPaths: null,
  };
}

function authorityRefusal(reason, extra = {}) {
  return { ok: false, code: 'COMMIT_RECOVERY_SCOPE_AUTHORITY_UNPROVEN', reason, ...extra };
}
function undeclared(authority, detail = null) {
  return { ok: false, code: 'COMMIT_RECOVERY_SCOPE_UNDECLARED', reason: DRIFT_CODES.SCOPE_UNDECLARED, authority, detail, allowedPaths: null };
}

/**
 * Resolve the canonical whitelist for a recovery commit.
 *   ok:false -> the caller MUST typed-block before any record/transition/
 *               dispatch/commit/push. There is no "best effort" path.
 *   ok:true  -> `value.allowedPaths` is the worktree-declared whitelist, proven
 *               non-empty AND a subset of the canonical whitelist.
 *
 * Reviewer regressions enforced here:
 *   (a) a `## Scope` claim with no binding          -> TASK_CONTRACT_BINDING_MISSING
 *   (b) a binding for ANOTHER task / identity       -> TASK_CONTRACT_BINDING_MISMATCH
 *   (c) a whitelist widened past the canonical one  -> COMMIT_RECOVERY_SCOPE_WIDENED
 *   (d) a valid canonical scope                     -> ok, classifyCommitScope decides
 *   (e) an ABSENT / EMPTY / PARTIAL binding tuple   -> COMMIT_RECOVERY_BINDING_INCOMPLETE
 *       (checked before any comparison, so it can never fall through to ok)
 */
export function resolveRecoveryScope({ session = null, identityHash = null, readFile = null } = {}) {
  const rd = typeof readFile === 'function' ? readFile : (p) => fs.readFileSync(p, 'utf8');
  const s = (session && typeof session === 'object' && !Array.isArray(session)) ? session : null;
  if (!s) return authorityRefusal('SESSION_ABSENT');
  if (typeof s.worktreePath !== 'string' || !s.worktreePath) return authorityRefusal('WORKTREE_UNBOUND');

  const tc = (s.taskContract && typeof s.taskContract === 'object' && !Array.isArray(s.taskContract))
    ? s.taskContract : null;
  // No canonical binding at all -> nothing declared. Reported as SCOPE_UNDECLARED
  // (the pre-existing typed block) with the authority reason kept separate.
  if (!tc) return undeclared('TASK_CONTRACT_UNBOUND', 'the control plane never bound a Task Contract for this session');

  // (e) the canonical binding tuple must be COMPLETE before anything is
  //     compared against it. Every mismatch check below is guarded by
  //     `value != null && ...`, so with a field absent the mismatch list stayed
  //     empty and the old code fell through to ok:true — an empty `{}`
  //     binding looked like "perfectly matching". Completeness is decided
  //     here, first, and refuses outright: no fallback, no best effort.
  const b = (tc.binding && typeof tc.binding === 'object' && !Array.isArray(tc.binding)) ? tc.binding : null;
  if (!b) return bindingIncomplete(TASK_CONTRACT_BINDING_FIELDS);
  const incomplete = TASK_CONTRACT_BINDING_FIELDS.filter((f) => !isBindingFieldComplete(f, b[f]));
  if (incomplete.length) return bindingIncomplete(incomplete);

  // (b) canonical binding must be THIS task and THIS identity.
  const boundIdentity = identityHash || s.identityHash || null;
  const mism = [];
  if (b.identityHash != null && b.identityHash !== boundIdentity) mism.push('identityHash');
  if (b.taskId != null && s.taskId != null && b.taskId !== s.taskId) mism.push('taskId');
  if (b.repo != null && s.repo != null && b.repo !== s.repo) mism.push('repo');
  if (b.issueNumber != null && s.issueNumber != null && Number(b.issueNumber) !== Number(s.issueNumber)) mism.push('issueNumber');
  if (mism.length) return authorityRefusal('TASK_CONTRACT_BINDING_MISMATCH', { field: 'session.taskContract.binding', fields: mism });

  const canonicalTitle = typeof tc.title === 'string' ? tc.title.trim() : '';
  if (!canonicalTitle) return authorityRefusal('TASK_CONTRACT_BINDING_MISSING', { field: 'session.taskContract.title' });

  const canonicalScope = (Array.isArray(tc.scope) ? tc.scope : [])
    .map((p) => normalizeRelPath(String(p))).filter(Boolean);
  if (!canonicalScope.length) return undeclared('CANONICAL_SCOPE_UNDECLARED', 'the canonical Task Contract declares no scope/whitelist');

  const rel = (typeof tc.path === 'string' && tc.path.trim()) ? tc.path.trim() : '.soc/task-contract.md';
  if (!isSafePathspec(rel)) return authorityRefusal('TASK_CONTRACT_PATH_UNSAFE', { field: rel });
  const fp = path.join(s.worktreePath, ...rel.split('/'));
  let text = null;
  try { text = rd(fp); } catch (e) {
    return authorityRefusal('TASK_CONTRACT_MISSING', { path: rel, detail: String((e && e.message) || e) });
  }
  if (typeof text !== 'string' || !text.trim()) return authorityRefusal('TASK_CONTRACT_MISSING', { path: rel });

  // (a) the worktree copy must carry its binding heading — a bare `## Scope`
  // is a claim with no provenance.
  const m = TASK_CONTRACT_BINDING_RE.exec(text);
  if (!m) return authorityRefusal('TASK_CONTRACT_BINDING_MISSING', { path: rel, field: 'heading' });
  const headingTitle = m[1].trim();
  if (headingTitle !== canonicalTitle) {
    return authorityRefusal('TASK_CONTRACT_BINDING_MISMATCH', { path: rel, field: 'heading', expected: canonicalTitle, got: headingTitle });
  }

  const declared = parseTaskContractScope(text);
  if (!Array.isArray(declared) || !declared.length) return undeclared('WORKTREE_SCOPE_UNDECLARED', `no declared scope block in ${rel}`);

  // (c) the declared whitelist may never exceed the canonical one. Reuses the
  // SAME drift-guard checkScope the dirty-set classification uses.
  const chk = checkScope({ allowedPaths: canonicalScope, mutatedPaths: declared });
  if (!chk.ok) {
    if (chk.code === DRIFT_CODES.OUT_OF_BOUNDS_MUTATION) {
      return { ok: false, code: 'COMMIT_RECOVERY_SCOPE_WIDENED', reason: DRIFT_CODES.OUT_OF_BOUNDS_MUTATION, detail: chk.detail, allowedPaths: null, canonicalScope, declared };
    }
    return undeclared('WORKTREE_SCOPE_UNDECLARED', String(chk.detail ?? ''));
  }

  // (d) bound + inside the canonical whitelist: this claim authorizes exactly
  // what it declares (never the wider canonical list).
  return {
    ok: true,
    allowedPaths: declared,
    authority: {
      source: 'session.taskContract (control-plane projection)',
      path: rel,
      title: canonicalTitle,
      binding: b,
      canonicalScope,
      declared,
    },
  };
}

// Scope decision for the dirty set push.mjs just refused.
//   allowedPaths == null/[]  -> SCOPE_UNDECLARED (typed-block, nothing runs)
//   any path outside scope   -> SCOPE_VIOLATION   (typed-block, nothing runs)
//   nothing left in scope    -> SCOPE_EMPTY       (typed-block, nothing runs)
// Tracked-ness is reported for evidence only and never authorizes anything.
export function classifyCommitScope({ statusLines = [], foreignPaths = [], allowedPaths = null } = {}) {
  const xyByPath = new Map();
  for (const raw of Array.isArray(statusLines) ? statusLines : []) {
    if (typeof raw !== 'string' || raw.length < 4) continue;
    const p = normalizePathspec(raw.slice(3));
    if (p) xyByPath.set(p, raw.slice(0, 2));
  }
  const declared = (Array.isArray(allowedPaths) ? allowedPaths : [])
    .map((p) => normalizeRelPath(p))
    .filter(Boolean)
    .slice(0, MAX_NAMED_PATHS);
  if (!declared.length) {
    return {
      ok: false,
      code: 'COMMIT_RECOVERY_SCOPE_UNDECLARED',
      reason: DRIFT_CODES.SCOPE_UNDECLARED,
      inScope: [], outScope: [], unclassified: [],
      trackedInScope: [],
    };
  }
  const inScope = [];
  const outScope = [];
  const unclassified = [];
  const trackedInScope = [];
  for (const raw of Array.isArray(foreignPaths) ? foreignPaths : []) {
    const p = normalizePathspec(raw);
    // Absolute / traversal / .git paths are never "out of scope" candidates —
    // they are refused outright and block before any classification.
    if (!p || !isSafePathspec(p)) { unclassified.push(String(raw)); continue; }
    const check = checkScope({ allowedPaths: declared, mutatedPaths: [p] });
    if (check.ok) {
      inScope.push(p);
      const xy = xyByPath.get(p);
      if (xy !== undefined && xy !== '??') trackedInScope.push(p);
      continue;
    }
    if (check.code === DRIFT_CODES.OUT_OF_BOUNDS_MUTATION) outScope.push(p);
    else unclassified.push(p);
  }
  if (outScope.length || unclassified.length) {
    return { ok: false, code: 'COMMIT_RECOVERY_SCOPE_VIOLATION', inScope, outScope, unclassified, trackedInScope, allowedPaths: declared };
  }
  if (!inScope.length) {
    return { ok: false, code: 'COMMIT_RECOVERY_SCOPE_EMPTY', inScope, outScope, unclassified, trackedInScope, allowedPaths: declared };
  }
  return {
    ok: true,
    inScope: inScope.slice(0, MAX_PATHS_IN_SCOPE),
    outScope, unclassified,
    trackedInScope: trackedInScope.slice(0, MAX_PATHS_IN_SCOPE),
    allowedPaths: declared,
  };
}

// ---- prior-executor authority ---------------------------------------------
// Pure: the caller supplies the canonical ExecutionRecord read back from the
// ONE record location. Never proves absence as permission — a missing record is
// unproven, not "no executor".
export function assertPriorExecutorRelinquished({ identityHash = null, record = null } = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return fail('COMMIT_RECOVERY_AUTHORITY_UNPROVEN', { reason: 'EXECUTION_RECORD_MISSING' });
  }
  if (identityHash && record.identityHash && record.identityHash !== identityHash) {
    return fail('COMMIT_RECOVERY_AUTHORITY_UNPROVEN', {
      reason: 'IDENTITY_MISMATCH', expected: identityHash, got: record.identityHash,
    });
  }
  if (pendingExecutorLatch(record)) {
    return fail('COMMIT_RECOVERY_AUTHORITY_UNPROVEN', { reason: 'PENDING_BIND_OR_CLEANUP' });
  }
  const lv = reconcileExecutorLiveness(record);
  const cls = classifyExecutor({ record, liveness: lv.liveness });
  if (!TERMINAL_EXECUTOR_LIVENESS.has(lv.liveness) || cls.canMutate !== false) {
    return fail('COMMIT_RECOVERY_EXECUTOR_NOT_TERMINAL', {
      liveness: lv.liveness ?? null,
      classification: cls.classification ?? null,
      identityProven: lv.identityProven === true,
      reason: lv.reason ?? null,
      pid: record.pid ?? null,
    });
  }
  return ok({
    liveness: lv.liveness,
    classification: cls.classification,
    identityProven: lv.identityProven === true,
    terminalStatus: record.terminalStatus ?? null,
    exitCode: Number.isInteger(record.exitCode) ? record.exitCode : null,
    finalized: record.finalized === true,
  });
}

// ---- idempotency lock ------------------------------------------------------
export function recoveryDigest({ identityHash = '', headSha = '', foreignPaths = [] } = {}) {
  const list = [...foreignPaths].map((p) => normalizePathspec(p)).filter(Boolean).sort();
  return createHash('sha256')
    .update(`${COMMIT_RECOVERY_SCHEMA_VERSION}|${identityHash}|${String(headSha).toLowerCase()}|${list.join('\n')}`)
    .digest('hex');
}

// Exactly-once: the same (identity, head, dirty set) may be dispatched at most
// once for the life of the task, and the whole task has a bounded budget. A
// relaunch in the middle of a recovery, or a resume after one, reads the same
// records and never spawns a second executor.
export function evaluateRecoveryLock({ records = [], digest = '', maxAttempts = MAX_COMMIT_RECOVERY_ATTEMPTS } = {}) {
  const list = Array.isArray(records) ? records.filter((r) => r && typeof r === 'object') : [];
  const same = list.filter((r) => r.digest === digest);
  if (same.length) {
    return fail('COMMIT_RECOVERY_ALREADY_DISPATCHED', {
      digest, attempt: same[0].attempt ?? null,
      status: same[0].status ?? null, dispatchedAt: same[0].dispatchedAt ?? null,
    });
  }
  if (list.length >= maxAttempts) {
    return fail('COMMIT_RECOVERY_BUDGET_EXHAUSTED', {
      attempts: list.length, maxAttempts,
      digests: list.map((r) => String(r.digest).slice(0, 12)),
    });
  }
  return ok({ attempt: list.length + 1 });
}

// ---- canonical attempt record ---------------------------------------------
export function commitRecoveryDirFor({ stateDir, identityHash: id }) {
  const dir = path.join(stateDir, 'control-loop', String(id), 'commit-recovery');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function listCommitRecoveryRecords({ stateDir, identityHash: id }) {
  let files;
  try { files = fs.readdirSync(commitRecoveryDirFor({ stateDir, identityHash: id })); }
  catch { return []; }
  const out = [];
  for (const f of files.filter((n) => n.endsWith('.json')).sort()) {
    try { out.push(JSON.parse(fs.readFileSync(path.join(commitRecoveryDirFor({ stateDir, identityHash: id }), f), 'utf8'))); }
    catch { /* an unreadable sibling never authorizes anything */ }
  }
  return out;
}

export function readCommitRecoveryRecord({ stateDir, identityHash: id, digest }) {
  const fp = path.join(commitRecoveryDirFor({ stateDir, identityHash: id }), `${digest}.json`);
  try { return { ok: true, path: fp, record: JSON.parse(fs.readFileSync(fp, 'utf8')) }; }
  catch (e) { return { ok: false, path: fp, reason: String((e && e.message) || e) }; }
}

// Same seam as persistReworkRecord (control-loop.mjs:841): tmp + rename is the
// only write; a crash leaves the old file or nothing, never a torn record.
export function persistCommitRecoveryRecord({ stateDir, identityHash: id, record }) {
  const fp = path.join(commitRecoveryDirFor({ stateDir, identityHash: id }), `${record.digest}.json`);
  const tmp = `${fp}.tmp-${randomUUID()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
    fs.renameSync(tmp, fp);
    return { ok: true, path: fp };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    return { ok: false, path: fp, detail: String((e && e.message) || e) };
  }
}

// Best-effort outcome stamp. The LOCK does not depend on this write: the record
// exists with status DISPATCHING before the executor is spawned, so a crash
// anywhere after that still burns the attempt instead of risking a duplicate.
export function stampCommitRecoveryOutcome({ stateDir, identityHash: id, digest, outcome }) {
  const cur = readCommitRecoveryRecord({ stateDir, identityHash: id, digest });
  if (!cur.ok) return { ok: false, reason: cur.reason };
  const next = { ...cur.record, ...outcome, updatedAt: new Date().toISOString() };
  const tmp = `${cur.path}.tmp-${randomUUID()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, cur.path);
    return { ok: true, path: cur.path };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

export function buildCommitRecoveryRecord({
  identityHash, attempt, digest, session, scope, priorExecution, route,
  now = () => new Date().toISOString(),
}) {
  return {
    schemaVersion: COMMIT_RECOVERY_SCHEMA_VERSION,
    kind: 'commit-recovery-attempt',
    identityHash,
    taskId: session.taskId ?? null,
    repo: session.repo ?? null,
    issueNumber: session.issueNumber ?? null,
    attempt,
    digest,
    status: 'DISPATCHING',
    createdAt: now(),
    dispatchedAt: null,
    checkpoint: {
      // The FSM checkpoint is NOT touched by recovery: this is the exact tail
      // the attempt started from, kept as evidence.
      state: 'VERIFYING',
      headSha: session.headSha ?? null,
      baseSha: session.baseSha ?? null,
      branch: session.branch ?? null,
      worktreePath: session.worktreePath ?? null,
    },
    scope: {
      inScope: scope.inScope,
      outScope: scope.outScope,
      unclassified: scope.unclassified,
      // The declared canonical whitelist the decision was made against, plus
      // which in-scope paths merely happen to be tracked. Tracked-ness is
      // recorded as evidence only — it never authorized the commit.
      allowedPaths: scope.allowedPaths ?? null,
      trackedInScope: scope.trackedInScope ?? [],
      // The canonical authorization source the whitelist was reconciled
      // against (session.taskContract). Never derivable from the worktree.
      authority: scope.authority ?? null,
    },
    priorExecution: priorExecution ?? null,
    route: route ?? null,
    provenance: {
      source: 'Soc_brain ControlLoop commit-recovery (Issue #264 option C)',
      dispatchAuthority: 'Soc_brain ControlLoop only; admission (taskStart) is never used as an executor dispatch',
      pushGuard: 'push.mjs PUSH_DIRTY_FOREIGN unchanged — recovery commits, it never bypasses the dirty-worktree guard',
      fsmTransition: 'none — the VERIFYING checkpoint and all prior evidence records are preserved',
      scopeAuthority: 'session.taskContract (control-plane projection) bound to this identity + drift-guard checkScope over its declared scope; a worktree heading, tracked-ness and reviewer prose never authorize a path',
    },
  };
}

// ---- bounded dispatch instruction -----------------------------------------
// Deliberately mirrors buildReworkInstruction's shape (the same adapter channel
// consumes it) and carries the same COMMIT OBLIGATION the rework instruction
// gained in this PR, scoped to the proven in-scope paths only.
export function buildCommitRecoveryInstruction({ session, record }) {
  const head = String((record.checkpoint && record.checkpoint.headSha) || 'unpinned').slice(0, 12);
  const paths = (record.scope && record.scope.inScope) || [];
  const shown = paths.slice(0, 50);
  const lines = [
    `COMMIT RECOVERY attempt ${record.attempt} for ${session.repo}#${session.issueNumber} @ head ${head} (digest ${record.digest.slice(0, 12)}).`,
    'Your previous execution finished, but its task output was left UNCOMMITTED in the bound task worktree. '
      + 'The canonical publish chain refuses to push a dirty worktree (PUSH_DIRTY_FOREIGN), so that output '
      + 'can never reach review until it is committed.',
    'Recovery scope: commit ONLY the paths listed below. Any other uncommitted path is OUT OF SCOPE and stays '
      + 'blocked — do not add, rename or touch it.',
    'Uncommitted task output in scope:',
    ...shown.map((p, i) => `  ${i + 1}. ${p}`),
    ...(paths.length > shown.length ? [`  ... and ${paths.length - shown.length} more (see the commit-recovery record)`] : []),
    'Steps:',
    '1. Re-read every in-scope path and KEEP the valid changes — do not discard or revert them.',
    '2. Run the tests required for these changes (targeted tests for what you touched, then the affected gate).',
    '3. Commit exactly those paths: `soc_broker_commit`, or `git add <path> && git commit`.',
    '4. Read back `git rev-parse HEAD` and report the NEW HEAD in your report. If HEAD did not move, you have not delivered.',
    '5. `artifacts/**` is gitignored: export bundles there as EVIDENCE ONLY. NEVER `git add` an `artifacts/**` path.',
    '6. Do NOT modify, skip or weaken tests to make a finding disappear.',
    'You are the executor: work in the bound task worktree only. '
      + 'Do NOT merge, do NOT terminalize, do NOT dispatch other executors.',
  ];
  return lines.join('\n');
}
