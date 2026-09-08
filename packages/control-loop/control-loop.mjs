// control-loop.mjs — Soc_brain ControlLoop v0 (Issue #69).
// See Issue #69 body for full contract. Composes existing primitives.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  taskFinish,
  taskBlock,
  readSessionRecord,
} from '../runtime-sandbox/runtime-sandbox.mjs';
import {
  dispatchLifecycleEvent,
  recoverLifecycleEvent,
} from '../telegram-dispatch/telegram-dispatch.mjs';
import { readExecutionRecord } from '../executor-launcher/executor-launcher.mjs';
import {
  decisionDigest as reworkDigest,
  buildReworkRecord,
  buildReworkInstruction,
} from './rework.mjs';
import { packetPathFor } from './adapters.mjs';
import { runDeliveryLifecycle, deliverySpec } from './delivery.mjs';
import { pushBranch } from './push.mjs';
import { writeReviewReady } from '../review-ready/review-ready.mjs';

// ---- P0-G (Issue #83) canonical HEAD refresh --------------------------------
// Gap A (head binding): taskStart pins session.headSha = baseSha (the
// admission base). The canonical review-ready packet and the delivery binding
// must reference the POST-COMMIT HEAD; without a refresh every downstream
// identity gate (collectPreReviewEvidence REVIEW_PACKET_STALE,
// assertReworkBinding REWORK_BINDING_STALE, delivery DELIVERY_BIND_STALE)
// compares against a stale admission SHA. refreshCanonicalHead() reads the
// worktree HEAD AFTER the executor commit, refuses to move backwards or to
// the admission base, persists the record atomically and verifies the
// read-back; history is kept additively for the duration evidence trail.
function execGit(exec, cwd, args) {
  if (typeof exec === 'function') {
    try {
      const r = exec(args, { cwd });
      if (!r || !Number.isInteger(r.status)) return { unknown: true, error: 'GIT_NO_EXIT_STATUS' };
      return { unknown: false, status: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
    } catch (e) {
      return { unknown: true, error: String((e && e.message) || e) };
    }
  }
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.error) return { unknown: true, error: String(r.error.message || r.error) };
  return { unknown: false, status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function refreshCanonicalHead({ sessionPath, stateDir = defaultStateDir(), exec = null, now = () => new Date().toISOString() } = {}) {
  const rs = readSessionByHash({ stateDir, identityHash: path.basename(sessionPath, '.json') });
  if (!rs.ok) return fail('SESSION_READ_FAILED', rs.reason);
  const session = rs.session;
  if (session.state === 'COMPLETED' || session.state === 'FAILED' || session.state === 'BLOCKED') {
    return fail('HEAD_REFRESH_TERMINAL_REFUSED', session.state);
  }
  const worktree = session.worktreePath;
  if (typeof worktree !== 'string' || !worktree) return fail('HEAD_REFRESH_BIND_FAILED', 'session.worktreePath missing');
  const h = execGit(exec, worktree, ['rev-parse', 'HEAD']);
  if (h.unknown) return fail('HEAD_REFRESH_AMBIGUOUS', h.error);
  if (h.status !== 0) return fail('HEAD_REFRESH_HEAD_UNRESOLVED', (h.stderr || h.stdout).trim());
  const headSha = h.stdout.trim().toLowerCase();
  if (!HEAD_SHA_40.test(headSha)) return fail('HEAD_REFRESH_HEAD_UNRESOLVED', `local HEAD not 40-hex: ${headSha}`);
  if (headSha === String(session.headSha || '').toLowerCase()) {
    return ok({ refreshed: false, headSha, previous: session.headSha });
  }
  if (headSha === String(session.baseSha || '').toLowerCase()) {
    return fail('HEAD_REFRESH_REFUSED_BASE', `HEAD ${headSha} equals the admission baseSha — the executor produced no canonical commit`);
  }
  const anc = execGit(exec, worktree, ['merge-base', '--is-ancestor', String(session.baseSha), headSha]);
  if (anc.unknown) return fail('HEAD_REFRESH_AMBIGUOUS', anc.error);
  if (anc.status !== 0) {
    return fail('HEAD_REFRESH_REFUSED_LINEAGE', `HEAD ${headSha} does not descend from the admitted baseSha ${session.baseSha}`);
  }
  const previous = session.headSha ?? null;
  session.headSha = headSha;
  session.controlLoop = session.controlLoop && typeof session.controlLoop === 'object' ? session.controlLoop : {};
  session.controlLoop.headHistory = Array.isArray(session.controlLoop.headHistory) ? session.controlLoop.headHistory : [];
  session.controlLoop.headHistory.push({ headSha, previous, at: now() });
  const p = persistSessionRecord(sessionPath, session);
  if (!p.ok) return fail('HEAD_REFRESH_PERSIST_FAILED', p.detail);
  let back;
  try { back = JSON.parse(fs.readFileSync(sessionPath, 'utf8')); } catch { back = null; }
  if (!back || back.headSha !== headSha) {
    return fail('HEAD_REFRESH_VERIFY_FAILED', `persisted headSha=${back && back.headSha}`);
  }
  return ok({ refreshed: true, headSha, previous });
}
// Gap B (packet projection): `writeReviewReady` existed only in tests before
// this fix — nothing in the runtime projected the canonical review-ready
// packet, so PRE_REVIEWING failed closed with NO_REVIEW_PACKET (the packet is
// REQUIRED and identity-gated). projectReviewReadyPacket() renders the
// handoff report from the CANONICAL session + transition evidence only, and
// writes it outside the worktree via the review-ready primitive's own
// fail-closed gate. Honest at projection time: deterministic verification and
// the semantic reviews have NOT run yet — the packet states exactly that.
export function projectReviewReadyPacket({ sessionPath, stateDir = defaultStateDir(), outputDir = null, now = () => new Date().toISOString(), exec = null, gh = null, verifyEvidence = null } = {}) {
  const rs = readSessionByHash({ stateDir, identityHash: path.basename(sessionPath, '.json') });
  if (!rs.ok) return fail('SESSION_READ_FAILED', rs.reason);
  const session = rs.session;
  if (session.state === 'COMPLETED' || session.state === 'FAILED' || session.state === 'BLOCKED') {
    return fail('PACKET_TERMINAL_REFUSED', session.state);
  }
  const headSha = session.headSha;
  if (typeof headSha !== 'string' || !HEAD_SHA_40.test(headSha)) {
    return fail('PACKET_HEAD_UNBOUND', `session.headSha must be the refreshed post-commit 40-hex HEAD, got ${String(headSha)}`);
  }
  if (!Number.isInteger(session.issueNumber) || session.issueNumber <= 0) return fail('PACKET_IDENTITY_INVALID', 'issueNumber');
  if (!Number.isInteger(session.prNumber) || session.prNumber <= 0) {
    return fail('PACKET_PR_UNBOUND', 'session.prNumber must carry the canonical PR number before the packet is projected');
  }
  // P0-G (Issue #83): the final reviewer must receive REAL evidence — the
  // canonical git delta (diff stat / changed files / commits) and, when the
  // deterministic verifier has already run, its verdict + execution record
  // path. Placeholder-only packets made the real GPT final review fail closed
  // with "insufficient canonical evidence" (legitimate finding). Every gather
  // below is best-effort + bounded: an unavailable piece degrades to an
  // explicit UNAVAILABLE item, never fabricates evidence.
  const codeEvidenceItems = [{ committedHead: headSha.slice(0, 12), base: String(session.baseSha || '').slice(0, 12), committedBy: 'soc_broker_commit inside the bound task worktree' }];
  if (typeof session.worktreePath === 'string' && session.worktreePath && typeof session.baseSha === 'string') {
    const range = `${session.baseSha}..${headSha}`;
    const stat = execGit(exec, session.worktreePath, ['diff', '--stat', range]);
    if (!stat.unknown && stat.status === 0 && stat.stdout.trim()) codeEvidenceItems.push({ diffStat: stat.stdout.trim().slice(0, 4000) });
    const files = execGit(exec, session.worktreePath, ['diff', '--name-only', range]);
    if (!files.unknown && files.status === 0 && files.stdout.trim()) codeEvidenceItems.push({ changedFiles: files.stdout.trim().split(/\r?\n/).slice(0, 100).join(', ') });
    const log = execGit(exec, session.worktreePath, ['log', '--oneline', range]);
    if (!log.unknown && log.status === 0 && log.stdout.trim()) codeEvidenceItems.push({ commits: log.stdout.trim().split(/\r?\n/).slice(0, 50).join(' | ') });
    // P0-G leg-7 finding: diff stats alone cannot support a semantic review —
    // the reviewer needs the CONTENT of the changed files. `git show` at the
    // committed head is canonical evidence (read-only, bounded per file).
    const changedList = files.unknown || files.status !== 0 ? '' : String(files.stdout || '').trim();
    if (changedList) {
      for (const f of changedList.split(/\r?\n/).slice(0, 20)) {
        const show = execGit(exec, session.worktreePath, ['show', `${headSha}:${f}`]);
        if (!show.unknown && show.status === 0 && typeof show.stdout === 'string' && show.stdout.length) {
          codeEvidenceItems.push({ [`fileContent ${f}`]: show.stdout.length > 16000 ? `${show.stdout.slice(0, 16000)}\n…(truncated at 16000 of ${show.stdout.length} bytes)` : show.stdout });
        }
      }
    }
  }
  const scopeItems = [{ taskId: session.taskId, executor: 'canonical opencode executor (P0-A)' }];
  // Real-run gh transport: deps.gh is null in production (spawnSync), a
  // function only in tests. Without the spawnSync path the objective gather
  // silently degraded to UNAVAILABLE (real GPT finding, leg 7).
  const ghCall = (args) => {
    if (typeof gh === 'function') {
      try { return gh(args); } catch (e) { return { unknown: true, error: String((e && e.message) || e) }; }
    }
    const r = spawnSync('gh', args, { encoding: 'utf8', windowsHide: true });
    if (r.error) return { unknown: true, error: String(r.error.code || r.error.message || r.error) };
    return { unknown: false, code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  try {
    const r = ghCall(['issue', 'view', String(session.issueNumber), '--repo', session.repo, '--json', 'title,body']);
    if (r && !r.unknown && Number(r.code) === 0) {
      const data = JSON.parse(String(r.stdout || ''));
      if (data && (typeof data.title === 'string' || typeof data.body === 'string')) {
        scopeItems.push({ issueObjective: String(data.title || '').slice(0, 500), acceptanceCriteria: String(data.body || '').slice(0, 4000) });
      }
    }
  } catch { /* best-effort: objective unavailable → reviewer sees it explicitly */ }
  if (!scopeItems.some((x) => x.issueObjective !== undefined)) {
    scopeItems.push({ issueObjective: 'UNAVAILABLE_AT_PROJECTION_TIME' });
  }
  const verificationItems = [{ deterministicVerify: 'PENDING_AT_PACKET_TIME' }];
  if (verifyEvidence && typeof verifyEvidence === 'object' && verifyEvidence.verdict) {
    verificationItems.unshift({
      deterministicVerify: verifyEvidence.verdict,
      exitCode: verifyEvidence.exitCode ?? null,
      recordPath: verifyEvidence.executionRecordPath ?? null,
      source: 'control-loop VERIFYING leg (canonical readExecutionRecord)',
    });
  }
  const report = {
    identity: {
      repository: session.repo,
      issue: session.issueNumber,
      pullRequest: session.prNumber,
      branch: session.branch ?? null,
      headSha,
      baseSha: session.baseSha ?? null,
      prState: 'OPEN',
    },
    terminalStatus: { status: 'READY_FOR_REVIEW' },
    scope: { items: scopeItems },
    codeEvidence: { items: codeEvidenceItems },
    findingResolution: { items: [{ note: 'first canonical pass — no prior review findings yet' }] },
    tests: { items: [{ note: 'deterministic verification runs in VERIFYING right after this projection; its verdict is carried by the control-loop evidence chain' }] },
    verification: { items: verificationItems },
    safety: { items: [
      { invariant: 'only ControlLoop terminalizes; executor/Gemini/GPT never merge, close or sync' },
      { mutationScope: 'push (canonical git push primitive) + PR read-back; merge/close owned by the P0-F delivery lifecycle after PASS' },
    ] },
    unverifiedRisks: { items: ['semantic review pending (Gemini pre-review, GPT-5.6 Sol final review)'] },
    delivery: { items: [
      { pr: session.prNumber, prState: 'OPEN', baseBranch: 'main' },
      { mergePolicy: 'squash merge with read-back, only after validated PASS verdict' },
    ] },
  };
  const dir = outputDir || path.join(stateDir, 'review-ready');
  const w = writeReviewReady(report, { outputDir: dir });
  if (!w.ok) return fail('REVIEW_PACKET_WRITE_REJECTED', w.errors ?? null);
  return ok({
    packet: { filename: w.filename, filePath: w.filePath, headSha, pr: session.prNumber },
    projectedAt: now(),
  });
}
// ---- P0-G (Issue #83): pre-review publish chain ------------------------------
// The canonical review-ready packet is identity-gated on pullRequest, so a PR
// bound to the approved head MUST exist before the reviewers run. Chain (each
// step fail-closed, each with its own read-back):
//   refreshCanonicalHead -> pushBranch (remote read-back evidence)
//   -> PR adopt-or-create (gh read-back evidence) -> session.prNumber persist
//   -> canonical packet projection (same-head overwrite is idempotent).
// The delivery lifecycle stays the owner of merge/close: its ensurePr adopts
// the session-bound PR, and push re-entry is an alreadyPresent short-circuit.
// Gate: the chain runs ONLY when deps.pushExec is provided (run.js injects
// null = real git via spawnSync); fixtures without pushExec keep the legacy
// loop shape (no git, no remote — their reviewers/delivery are stubs).
function bindPullRequest({ session, gh, env }) {
  if (!session || typeof session !== 'object') return fail('PR_BIND_FAILED', 'session required');
  if (typeof session.worktreePath !== 'string' || !session.worktreePath) return fail('PR_BIND_FAILED', 'session.worktreePath missing');
  const spec = deliverySpec({ issue: session.issueNumber, headSha: session.headSha, branch: session.branch ?? undefined });
  if (!spec.ok) return fail(spec.code, spec.detail);
  const s = spec.value;
  const call = (args) => {
    if (typeof gh === 'function') {
      try { return gh(args); } catch (e) { return { unknown: true, error: String((e && e.message) || e) }; }
    }
    const r = spawnSync('gh', args, { encoding: 'utf8', windowsHide: true, env: env || undefined });
    if (r.error) return { unknown: true, error: String(r.error.code || r.error.message || r.error) };
    return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  const json = (args) => {
    const out = call(args);
    if (out.unknown) return { unknown: true, error: out.error };
    if (Number(out.code) !== 0) return { code: Number(out.code), stderr: String(out.stderr || '').slice(0, 300) };
    try { return { data: JSON.parse(String(out.stdout || '')) }; } catch (e) { return { unknown: true, error: `GH_JSON_PARSE: ${String((e && e.message) || e)}` }; }
  };
  // (a) Adopt: an already-bound session PR, verified OPEN at the exact head.
  if (Number.isInteger(session.prNumber) && session.prNumber > 0) {
    const v = json(['pr', 'view', String(session.prNumber), '--repo', s.repo, '--json', 'state,number,headRefOid']);
    if (v.unknown) return fail('PR_BIND_UNKNOWN', v.error);
    if (v.code != null) return fail('PR_BIND_VIEW_FAILED', `gh exit ${v.code}: ${v.stderr}`);
    if (Number(v.data.number) !== session.prNumber) return fail('PR_BIND_IDENTITY_MISMATCH', `view number=${v.data.number} session=${session.prNumber}`);
    if (String(v.data.state).toUpperCase() !== 'OPEN') return fail('PR_BIND_STATE_INVALID', `PR #${v.data.number} state=${v.data.state}`);
    if (String(v.data.headRefOid || '').toLowerCase() !== s.headSha) return fail('PR_BIND_HEAD_MISMATCH', `PR head=${v.data.headRefOid} approved=${s.headSha}`);
    return ok({ prNumber: v.data.number, adopted: true });
  }
  // (b) Crash-recovery adoption: a PR for THIS exact head (branch + SHA) from
  // a previous interrupted attempt is adopted, never re-created.
  const l = json(['pr', 'list', '--repo', s.repo, '--head', s.branch, '--state', 'all', '--json', 'number,state,headRefOid']);
  if (l.unknown) return fail('PR_BIND_UNKNOWN', l.error);
  if (l.code != null) return fail('PR_BIND_SEARCH_FAILED', `gh exit ${l.code}: ${l.stderr}`);
  const mine = (Array.isArray(l.data) ? l.data : []).find((p) => p && String(p.headRefOid || '').toLowerCase() === s.headSha
    && ['OPEN', 'MERGED'].includes(String(p.state || '').toUpperCase()));
  if (mine) return ok({ prNumber: Number(mine.number), adopted: true });
  // (c) Create: the approved head is already pushed; the read-back is the
  // only create evidence (state OPEN at the approved head).
  const c = call(['pr', 'create', '--repo', s.repo, '--base', s.baseBranch, '--head', s.branch, '--title', s.title, '--body', s.body]);
  if (c.unknown) return fail('PR_BIND_UNKNOWN', c.error);
  if (Number(c.code) !== 0) return fail('PR_BIND_CREATE_FAILED', String((c.stderr || c.stdout) || '').trim().slice(0, 300));
  const m = String(c.stdout ?? '').match(/\/pull\/(\d+)/);
  if (!m) return fail('PR_BIND_UNKNOWN', `create output unparseable: ${String(c.stdout ?? '').slice(0, 120)}`);
  const v = json(['pr', 'view', m[1], '--repo', s.repo, '--json', 'state,number,headRefOid']);
  if (v.unknown) return fail('PR_BIND_UNKNOWN', v.error);
  if (v.code != null) return fail('PR_BIND_READBACK_FAILED', `gh exit ${v.code}: ${v.stderr}`);
  if (String(v.data.state).toUpperCase() !== 'OPEN' || String(v.data.headRefOid || '').toLowerCase() !== s.headSha) {
    return fail('PR_BIND_READBACK_MISMATCH', JSON.stringify({ state: v.data.state ?? null, head: v.data.headRefOid ?? null, expected: s.headSha }));
  }
  return ok({ prNumber: Number(v.data.number), adopted: false });
}

// Session record persistence for the controlLoop metadata block. The canonical
// FSM transitions (taskFinish/taskBlock) still own their own persistence inside
// runtime-sandbox; this helper only persists the token binding additively.
function persistSessionRecord(sessionPath, session) {
  const tmp = `${sessionPath}.tmp-${randomUUID()}`;
  fs.writeFileSync(tmp, JSON.stringify(session, null, 2), 'utf8');
  fs.renameSync(tmp, sessionPath);
  return { ok: true };
}

// Issue #83: persist the bound PR number additively (prHistory) with a
// read-back verify. FSM transitions and canonical session states remain owned
// by the runtime-sandbox primitives; this only adds binding metadata.
function persistPrNumber(sessionPath, prNumber) {
  let session;
  try { session = JSON.parse(fs.readFileSync(sessionPath, 'utf8')); } catch (e) { return fail('PR_BIND_PERSIST_FAILED', String((e && e.message) || e)); }
  if (!session || typeof session !== 'object') return fail('PR_BIND_PERSIST_FAILED', 'session unreadable');
  session.prNumber = prNumber;
  session.controlLoop = session.controlLoop && typeof session.controlLoop === 'object' ? session.controlLoop : {};
  session.controlLoop.prHistory = Array.isArray(session.controlLoop.prHistory) ? session.controlLoop.prHistory : [];
  session.controlLoop.prHistory.push({ prNumber, at: new Date().toISOString() });
  try {
    persistSessionRecord(sessionPath, session); // hoisted function declaration below
  } catch (e) {
    return fail('PR_BIND_PERSIST_FAILED', String((e && e.message) || e));
  }
  let back;
  try { back = JSON.parse(fs.readFileSync(sessionPath, 'utf8')); } catch { back = null; }
  if (!back || back.prNumber !== prNumber) return fail('PR_BIND_VERIFY_FAILED', `persisted prNumber=${back && back.prNumber}`);
  return ok({ persisted: true });
}

// The publish chain used by the fresh EXECUTING leg AND every rework leg (each
// produces a commit that must be published before reviewers see it). Push is
// ALWAYS attempted: pushBranch's pre-mutation remote read-back makes a
// re-entry for an unchanged head a cheap alreadyPresent short-circuit, which
// also covers a crash between refresh and push.
function runPublishChain({ sessionPath, stateDir, identityHash: id, deps } = {}) {
  const hr = refreshCanonicalHead({ sessionPath, stateDir, exec: deps.pushExec ?? null });
  if (!hr.ok) return { ok: false, code: hr.code, detail: hr.detail, step: 'head-refresh' };
  const rs2 = readSessionByHash({ stateDir, identityHash: id });
  if (!rs2.ok) return { ok: false, code: 'SESSION_READ_FAILED', detail: rs2.reason, step: 'session-read' };
  const session = rs2.session;
  const ps = pushBranch({
    session: { worktreePath: session.worktreePath, branch: session.branch, baseSha: session.baseSha },
    exec: deps.pushExec ?? null,
  });
  if (!ps.ok) return { ok: false, code: ps.code, detail: ps.detail, step: 'push' };
  const pb = bindPullRequest({ session, gh: deps.gh ?? null, env: deps.ghEnv ?? null });
  if (!pb.ok) return { ok: false, code: pb.code, detail: pb.detail, step: 'pr-bind' };
  const pp = persistPrNumber(sessionPath, pb.value.prNumber);
  if (!pp.ok) return { ok: false, code: pp.code, detail: pp.detail, step: 'pr-persist' };
  const pk = projectReviewReadyPacket({ sessionPath, stateDir, exec: deps.pushExec ?? null, gh: deps.gh ?? null });
  if (!pk.ok) return { ok: false, code: pk.code, detail: pk.detail, step: 'packet' };
  return ok({
    headSha: hr.value.headSha,
    headRefreshed: hr.value.refreshed === true,
    push: { branch: ps.value.branch, headSha: ps.value.headSha, alreadyPresent: ps.value.alreadyPresent === true },
    pr: { number: pb.value.prNumber, adopted: pb.value.adopted === true },
    packet: pk.value.packet,
  });
}

export const CONTROL_LOOP_SCHEMA_VERSION = '1';

// ControlLoop is Soc_brain's own orchestrator: it only terminalizes canonical
// tasks of THIS repository. Foreign sessions are refused before any transition.
export const CONTROL_LOOP_CANONICAL_REPO = 'duongpdddic-droid/soc_brain';

export const LOOP_STATES = Object.freeze([
  'ACCEPTED', 'ROUTED', 'EXECUTING', 'VERIFYING', 'PRE_REVIEWING',
  'FINAL_REVIEWING', 'DECIDING', 'REWORK', 'DELIVERING', 'COMPLETED', 'BLOCKED',
]);
export const TERMINAL_STATES = Object.freeze(new Set(['COMPLETED', 'BLOCKED']));

// P0-E (Issue #79): bounded rework budget. Each validated GPT REWORK verdict
// may drive AT MOST ONE executor re-dispatch; the budget counts the persisted
// rework decision records (crash-safe, not in-memory), and exhaustion is a
// canonical BLOCKED escalation — never a silent infinite rework loop and
// never a technical failure dressed up as a Human Gate.
export const MAX_REWORK_ROUNDS = 3;

const ALLOWED_TRANSITIONS = Object.freeze({
  ACCEPTED: new Set(['ROUTED', 'BLOCKED']),
  ROUTED: new Set(['EXECUTING', 'BLOCKED']),
  EXECUTING: new Set(['VERIFYING', 'BLOCKED']),
  VERIFYING: new Set(['PRE_REVIEWING', 'BLOCKED']),
  PRE_REVIEWING: new Set(['FINAL_REVIEWING', 'BLOCKED']),
  FINAL_REVIEWING: new Set(['DECIDING', 'BLOCKED']),
  DECIDING: new Set(['REWORK', 'DELIVERING', 'BLOCKED']),
  REWORK: new Set(['EXECUTING', 'BLOCKED']),
  DELIVERING: new Set(['COMPLETED', 'BLOCKED']),
  COMPLETED: new Set(),
  BLOCKED: new Set(),
});

function ok(v, extra = {}) { return { ok: true, value: v, ...extra }; }
function fail(code, detail) { return { ok: false, code, detail: detail ?? null }; }

function defaultStateDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.USERPROFILE || 'C:\\Users\\Admin', '.soc-brain', 'state');
  }
  return path.join(process.env.HOME || '/root', '.soc-brain', 'state');
}

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); return p; }

function loopDirFor({ stateDir = defaultStateDir(), identityHash: id }) {
  return ensureDir(path.join(stateDir, 'control-loop', id));
}

function transitionsPathFor({ stateDir = defaultStateDir(), identityHash: id }) {
  return path.join(loopDirFor({ stateDir, identityHash: id }), 'transitions.jsonl');
}

// ---- READY_FOR_REVIEW notification obligation (review round-2 blocker) ------
// Lifecycle contract: the canonical boundary transition to DELIVERING (the
// READY_FOR_REVIEW boundary) carries a REQUIRED notification side-effect that
// must be satisfied BEFORE the loop may continue to COMPLETED. Ordering:
//   boundary transition -> notification side-effect -> delivery evidence
//   -> only then dependent lifecycle continuation.
// Ownership: ControlLoop itself owns the dispatch (via the telegram-dispatch
// primitive) — never the executor/model's memory. Idempotency is owned by the
// dispatch ledger: ONLY API_ACCEPTED is terminal delivery evidence and
// permanently dedupes; DELIVERY_FAILED/NOT_ATTEMPTED stay recoverable through
// the bounded recoverLifecycleEvent() budget (MAX_DELIVERY_ATTEMPTS).
// Fail-closed: no persistent delivery evidence -> DELIVER_FAILED; the loop
// never claims notification delivered when it was not.
const READY_FOR_REVIEW_EVENT = 'READY_FOR_REVIEW';

function readinessNotificationEvidence({ session, stateDir, spawn = null, configPath = null, now = null, note = null, packetPath = null }) {
  const args = { session, event: READY_FOR_REVIEW_EVENT, stateDir, allowNonCanonicalStateRoot: true, now, note };
  let r;
  try {
    r = spawn
      ? dispatchLifecycleEvent({ ...args, spawn, configPath, documentPath: packetPath || null })
      : dispatchLifecycleEvent({ ...args, configPath, documentPath: packetPath || null });
  } catch (e) {
    return { status: 'NOT_ATTEMPTED', reason: 'DISPATCH_INTERNAL_ERROR', error: String((e && e.message) || e) };
  }
  const status = r && typeof r.status === 'string' ? r.status : 'NOT_ATTEMPTED';
  if (status === 'API_ACCEPTED') {
    return { status, messageId: r.messageId ?? null, recordsPath: r.recordsPath ?? null };
  }
  return {
    status,
    reason: r ? ((r.reason ?? r.error) ?? null) : null,
    attempts: r && Number.isInteger(r.attempts) ? r.attempts : null,
    recovery: r && typeof r.recovery === 'string' ? r.recovery : null,
    recordsPath: r && r.recordsPath ? r.recordsPath : null,
  };
}

function appendTransition({ stateDir, identityHash: id, record }) {
  const fp = transitionsPathFor({ stateDir, identityHash: id });
  ensureDir(path.dirname(fp));
  fs.appendFileSync(fp, JSON.stringify({ schemaVersion: CONTROL_LOOP_SCHEMA_VERSION, ...record }) + '\n', 'utf8');
  return { ok: true, path: fp };
}

export function readTransitions({ stateDir = defaultStateDir(), identityHash: id } = {}) {
  const fp = transitionsPathFor({ stateDir, identityHash: id });
  if (!fs.existsSync(fp)) return [];
  return fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function readSessionByHash({ stateDir = defaultStateDir(), identityHash: id }) {
  const sp = path.join(stateDir, 'sessions', `${id}.json`);
  return readSessionRecord(sp);
}

function newLoopToken({ identityHash: id, sessionPath }) {
  return createHash('sha256')
    .update(`${CONTROL_LOOP_SCHEMA_VERSION}|${id}|${sessionPath}|${randomUUID()}`)
    .digest('hex');
}

export function bindLoop({ sessionPath, identityHash: id, stateDir = defaultStateDir(), now = () => new Date().toISOString() } = {}) {
  if (typeof sessionPath !== 'string' || !sessionPath) return fail('MISSING_SESSION_PATH');
  if (typeof id !== 'string' || !id) return fail('MISSING_IDENTITY_HASH');
  const token = newLoopToken({ identityHash: id, sessionPath });

  function transition({ from, to, reason = null, evidence = null, extras = {} }) {
    if (!ALLOWED_TRANSITIONS[from] || !ALLOWED_TRANSITIONS[from].has(to)) {
      return fail('ILLEGAL_TRANSITION', `from=${from} to=${to}`);
    }
    const record = {
      ts: now(), from, to, reason, evidence,
      identityHash: id, sessionPath, ...extras,
    };
    appendTransition({ stateDir, identityHash: id, record });
    return ok({ state: to, record });
  }

  function terminalize({ outcome, decision, dispatchOptions = {} }) {
    // Defense-in-depth: refuse unless THIS loop bound the session token first.
    const auth = assertTerminalizationAuthorized({ sessionPath, identityHash: id, presentedToken: token, stateDir });
    if (!auth.ok) return auth;
    if (typeof outcome !== 'string') return fail('MISSING_OUTCOME');
    if (outcome === 'COMPLETED' || outcome === 'FAILED') {
      return taskFinish({ sessionPath, outcome, dispatchOptions });
    }
    if (outcome === 'BLOCKED') {
      return taskBlock({ sessionPath, dispatchOptions });
    }
    return fail('INVALID_OUTCOME', `outcome=${outcome}`);
  }

  async function step({ name, from, to, run, reason = null, capture = 'ok' }) {
    const prior = readTransitions({ stateDir, identityHash: id });
    const last = prior[prior.length - 1];
    if (last && last.from === from && last.to === to) {
      return { ok: true, state: to, result: { resumed: true, record: last } };
    }
    if (!last || last.to !== from) {
      return fail('LOOP_NOT_AT_STATE', `expected last.to=${from}, got ${last && last.to}`);
    }
    let result;
    try {
      result = await run({ sessionPath });
    } catch (e) {
      transition({ from, to: 'BLOCKED', reason: `${name}:THREW`, evidence: String((e && e.message) || e) });
      return fail('STEP_THREW', `${name}: ${(e && e.message) || e}`);
    }
    if (!result || result.ok !== true) {
      transition({ from, to: 'BLOCKED', reason: `${name}:FAIL`, evidence: result || null });
      return fail(`${name}_FAILED`, result);
    }
    transition({ from, to, reason, evidence: capture === 'full' ? result : (result[capture] ?? null) });
    return { ok: true, state: to, result };
  }

  return Object.freeze({
    schemaVersion: CONTROL_LOOP_SCHEMA_VERSION,
    identityHash: id,
    sessionPath,
    stateDir,
    token,
    states: LOOP_STATES,
    transition,
    terminalize,
    step,
    readTransitions: () => readTransitions({ stateDir, identityHash: id }),
  });
}

// ---- P0-E rework leg (Issue #79) ---------------------------------------------
// REWORK binding gate (fail-closed): a rework decision may only be dispatched
// when it echoes the canonical identity of the bound session — repository and
// issue ALWAYS, headSha whenever the session pins one. A stale, foreign or
// malformed binding returns a deterministic failure and NEVER dispatches.
const HEAD_SHA_40 = /^[0-9a-f]{40}$/i;

export function assertReworkBinding({ session, decision }) {
  const b = decision && typeof decision.binding === 'object' && decision.binding !== null
    ? decision.binding
    : null;
  if (!b) return fail('REWORK_BINDING_MISSING', 'decision.binding (repository/issue/headSha echo) is required');
  const repo = typeof b.repository === 'string' ? b.repository.toLowerCase() : '';
  const issue = Number(b.issue);
  if (!repo || !Number.isInteger(issue) || issue <= 0
    || typeof b.headSha !== 'string' || !HEAD_SHA_40.test(b.headSha)) {
    return fail('REWORK_BINDING_MISSING', 'decision.binding must carry repository, issue and a 40-hex headSha');
  }
  if (repo !== String(session.repo).toLowerCase() || issue !== Number(session.issueNumber)) {
    return fail('REWORK_BINDING_MISMATCH', `decision=${b.repository}#${b.issue} session=${session.repo}#${session.issueNumber}`);
  }
  if (typeof session.headSha === 'string' && HEAD_SHA_40.test(session.headSha)
    && session.headSha.toLowerCase() !== b.headSha.toLowerCase()) {
    return fail('REWORK_BINDING_STALE', `decision head=${b.headSha.toLowerCase()} session head=${session.headSha.toLowerCase()}`);
  }
  return ok({ binding: { repository: repo, issue, headSha: b.headSha.toLowerCase() } });
}

// Persisted rework decisions are the crash-safe budget/replay ledger:
// <stateDir>/control-loop/<identityHash>/rework/<digest>.json (tmp + rename).
function listReworkDigests({ stateDir, identityHash: id }) {
  const dir = path.join(loopDirFor({ stateDir, identityHash: id }), 'rework');
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  } catch { return []; }
}

function persistReworkRecord({ stateDir, identityHash: id, record }) {
  const fp = path.join(loopDirFor({ stateDir, identityHash: id }), 'rework', `${record.digest}.json`);
  const tmp = `${fp}.tmp-${randomUUID()}`;
  try {
    ensureDir(path.dirname(fp));
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
    fs.renameSync(tmp, fp);
    return { ok: true, path: fp };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    return { ok: false, detail: String((e && e.message) || e) };
  }
}

// Consumes a VALIDATED GPT ReviewResult with verdict REWORK: Soc_brain itself
// decides, persists a provenance-carrying rework record, re-dispatches THE
// SAME executor authority bound to this loop, read-backs the fresh execution
// record at its canonical location, and re-runs verification/pre-review/
// final-review before handing the follow-up decision back to the DECIDING
// policy. GPT stays advisory: it can never dispatch, mutate the FSM, merge or
// terminalize — only ControlLoop walks this leg.
async function runReworkLeg({
  loop, deps, stateDir, identityHash: id, session, routeValue, decision,
  executor, verifier, preReview, finalReview,
}) {
  const bind = assertReworkBinding({ session, decision });
  if (!bind.ok) return bind; // stale/wrong/missing binding: fail-closed, no dispatch, recoverable
  const digest = reworkDigest({ identityHash: id, decision });
  const ledger = readTransitions({ stateDir, identityHash: id });
  // Dispatch marker = the DECIDING->REWORK record for THIS digest immediately
  // followed by its REWORK->EXECUTING dispatch record. A replayed/duplicated
  // decision whose dispatch already ran never dispatches again; a crash
  // BETWEEN the persist and the executor step (transition recorded, no
  // dispatch record) stays retryable — exactly-once dispatch.
  const alreadyDispatched = ledger.some((r, i) => (
    r.from === 'DECIDING' && r.to === 'REWORK'
    && r.evidence && r.evidence.digest === digest
    && ledger[i + 1] && ledger[i + 1].from === 'REWORK' && ledger[i + 1].to === 'EXECUTING'
  ));
  if (alreadyDispatched) {
    return fail('REWORK_ALREADY_DISPATCHED', { digest });
  }
  const round = listReworkDigests({ stateDir, identityHash: id }).length + 1;
  if (round > MAX_REWORK_ROUNDS) {
    // Budget exhaustion = the reviewer keeps rejecting fresh work. That is a
    // genuine escalation, not a technical failure: canonical BLOCKED.
    loop.transition({
      from: 'DECIDING', to: 'BLOCKED', reason: 'rework-budget-exhausted',
      evidence: { digest, rounds: round - 1, max: MAX_REWORK_ROUNDS },
    });
    const term = loop.terminalize({ outcome: 'BLOCKED', decision });
    return ok({ state: 'BLOCKED', reason: 'REWORK_BUDGET_EXHAUSTED', terminalize: term, loopToken: loop.token });
  }
  const record = buildReworkRecord({ identityHash: id, round, digest, decision });
  const pr = persistReworkRecord({ stateDir, identityHash: id, record });
  if (!pr.ok) return fail('REWORK_PERSIST_FAILED', pr.detail);
  const tw = loop.transition({
    from: 'DECIDING', to: 'REWORK', reason: 'final-review-rework',
    evidence: {
      digest, round, reworkPath: pr.path, binding: record.binding,
      findings: record.findings, evidenceRequests: record.evidenceRequests,
    },
  });
  if (!tw.ok) return fail('TRANSITION_FAILED', tw.code);
  const instruction = buildReworkInstruction({ session, record });
  const execR = await loop.step({
    name: 'rework-execute', from: 'REWORK', to: 'EXECUTING',
    run: (ctx) => executor({
      ...ctx,
      model: (routeValue && routeValue.model) ?? null,
      executorKind: (routeValue && routeValue.executorKind) ?? 'opencode',
      reworkInstruction: instruction,
      reworkCwd: deps.reworkCwd ?? null,
      reworkModel: deps.reworkModel ?? null,
    }),
    capture: 'value',
  });
  if (!execR.ok) {
    // Recoverable: the ledger holds the failed attempt (step() marks the loop
    // ledger, never the canonical session); the rework record stays persisted
    // for provenance. No terminalize happened.
    return fail('REWORK_EXECUTE_FAILED', execR.code || null);
  }
  const execPath = execR.result.value && execR.result.value.executionRecordPath;
  const cpDir = session && session.controlPlane && session.controlPlane.stateDir;
  if (!execPath || typeof cpDir !== 'string' || !cpDir) {
    return fail('REWORK_DISPATCH_READBACK_FAILED', { executionRecordPath: execPath ?? null, controlPlaneStateDir: cpDir ?? null });
  }
  // Sequential mutation + read-back: the fresh execution record must exist at
  // its canonical location and belong to THIS identity before the loop may
  // continue to verification.
  const rb = readExecutionRecord({ stateDir: cpDir, repo: session.repo, issueNumber: session.issueNumber });
  if (!rb.ok || rb.path !== execPath || !rb.record || rb.record.identityHash !== id) {
    return fail('REWORK_DISPATCH_READBACK_FAILED', {
      reason: rb.ok ? 'identity-or-path-mismatch' : (rb.reason ?? null),
      expected: execPath, got: rb.path ?? null,
    });
  }
  const vR = await loop.step({
    name: 'rework-verify', from: 'EXECUTING', to: 'VERIFYING',
    run: (ctx) => verifier({ ...ctx, executionRecordPath: rb.path }), capture: 'value',
  });
  if (!vR.ok) return fail('REWORK_VERIFY_FAILED', vR.code || null);
  // P0-G (Issue #83): rework legs commit NEW work — the same publish chain as
  // the fresh leg (refresh/push are idempotent short-circuits for an unchanged
  // head; the PR bind adopts the already-bound PR; the packet is re-projected
  // at the NEW head so packetPathFor's exact-head match always wins).
  if (deps.pushExec !== undefined) {
    const pub = runPublishChain({ sessionPath: loop.sessionPath, stateDir, identityHash: id, deps });
    if (!pub.ok) return fail(pub.code || 'PUBLISH_CHAIN_FAILED', { step: pub.step ?? null, detail: pub.detail ?? null });
  }
  const pR = await loop.step({
    name: 'rework-preReview', from: 'VERIFYING', to: 'PRE_REVIEWING',
    run: (ctx) => preReview({ ...ctx, report: vR.result.value, reviewReadyDir: deps.reviewReadyDir ?? null }),
    capture: 'value',
  });
  if (!pR.ok) return fail('REWORK_PRE_REVIEW_FAILED', pR.code || null);
  const fR = await loop.step({
    name: 'rework-finalReview', from: 'PRE_REVIEWING', to: 'FINAL_REVIEWING',
    run: (ctx) => finalReview({ ...ctx, report: vR.result.value, preReview: pR.result.value }),
    capture: 'value',
  });
  if (!fR.ok) return fail('REWORK_FINAL_REVIEW_FAILED', fR.code || null);
  return ok({ decision: fR.result.value });
}

export async function runControlLoop({ sessionPath, identityHash: id, stateDir = defaultStateDir(), deps = {} } = {}) {
  const rs = readSessionByHash({ stateDir, identityHash: id });
  if (!rs.ok) return fail('SESSION_READ_FAILED', rs.reason || null);
  if (rs.session.repo !== CONTROL_LOOP_CANONICAL_REPO
      || rs.session.taskId !== `${CONTROL_LOOP_CANONICAL_REPO}#${rs.session.issueNumber}`) {
    return fail('IDENTITY_MISMATCH', `taskId=${rs.session.taskId} identityHash=${id}`);
  }
  if (rs.session.state === 'COMPLETED' || rs.session.state === 'FAILED' || rs.session.state === 'BLOCKED') {
    return fail('ALREADY_TERMINAL', rs.session.state);
  }
  const loop = bindLoop({ sessionPath, identityHash: id, stateDir });
  // Bind THIS loop's terminalize token into the canonical session record. The
  // guard inside loop.terminalize then refuses any terminal transition unless
  // this exact loop instance is bound — adapters and external scripts have no
  // access to the token.
  const bnd = bindTerminalizeTokenToSession({ sessionPath, identityHash: id, token: loop.token, stateDir });
  if (!bnd.ok) return fail('TERMINALIZE_BIND_FAILED', bnd.code);

  // Adapter seams are resolved up-front so the P0-E resume branch below can
  // re-enter the decision policy without re-running the executor prefix.
  let routeValue = null; // assigned by the ROUTED step; the resume branch reuses the ledger instead
  const executor = deps.executor || (() => ({ ok: false, code: 'NO_EXECUTOR' }));
  const verifier = deps.verifier || (() => ({ ok: false, code: 'NO_VERIFIER' }));
  const preReview = deps.preReview || (() => ({ ok: false, code: 'NO_PRE_REVIEW' }));
  const finalReview = deps.finalReview || (() => ({ ok: false, code: 'NO_FINAL_REVIEW' }));

  const prior = readTransitions({ stateDir, identityHash: id });
  if (prior.length === 0) {
    loop.transition({ from: 'ACCEPTED', to: 'ROUTED', reason: 'loop-bind', evidence: { boundAt: new Date().toISOString() } });
  } else if (prior[prior.length - 1].to === 'DECIDING' || prior[prior.length - 1].to === 'FINAL_REVIEWING') {
    // P0-E rework-leg resume (Issue #79): the ledger ends at DECIDING (round
    // review consumed but the loop was interrupted before the decision policy
    // returned) or at FINAL_REVIEWING (re-review verdict not yet consumed).
    // Re-obtain the review ONCE and re-enter the decision policy — the rework
    // dispatch-marker guard then dedupes any already-dispatched verdict, so a
    // retry can never double-dispatch. Mid-round crashes (tail inside the
    // executor/verification prefix) still fail closed at the route step
    // without dispatching anything (documented P0-E ceiling; full resume walk
    // deferred).
    const vRec = [...prior].reverse().find((r) => r.from === 'VERIFYING');
    const pRec = [...prior].reverse().find((r) => r.from === 'PRE_REVIEWING');
    // Issue #107 item 5(b): reconstruct routeValue from the ledger ROUTED->EXECUTING
    // evidence ({model, executorKind}) so a resumed rework dispatch keeps the
    // routed transport parameters instead of falling back to defaults.
    const rRec = [...prior].reverse().find((r) => r.from === 'ROUTED' && r.to === 'EXECUTING');
    const rEv = rRec && rRec.evidence && typeof rRec.evidence === 'object' ? rRec.evidence : null;
    routeValue = {
      model: (rEv && rEv.model) ?? null,
      executorKind: (rEv && rEv.executorKind) ?? 'opencode',
    };
    let finDecision;
    try {
      const r = await finalReview({ sessionPath, report: vRec ? vRec.evidence : null, preReview: pRec ? pRec.evidence : null });
      if (!r || r.ok !== true) return fail('FINAL_REVIEW_FAILED', (r && r.code) || null);
      finDecision = r.value;
    } catch (e) {
      return fail('FINAL_REVIEW_FAILED', String((e && e.message) || e));
    }
    loop.transition({ from: 'FINAL_REVIEWING', to: 'DECIDING', reason: 'rework-leg-resume-review', evidence: finDecision });
    return await decide({ decision: finDecision });
  } else if (prior[prior.length - 1].to === 'DELIVERING') {
    // P0-F (Issue #81) delivery resume: the PASS decision was consumed at the
    // boundary; replay the PERSISTED boundary decision (never re-ask the
    // reviewer — a late REWORK verdict must never enter delivery). The
    // notification dispatch ledger dedupes (no re-send), the delivery adapter
    // is ledger-first (no duplicate merge/close/cleanup), and the terminal
    // transition is exactly-once via the canonical session guard.
    const b = [...prior].reverse().find((r) => r.from === 'DECIDING' && r.to === 'DELIVERING');
    const d = b && b.evidence && typeof b.evidence === 'object' ? b.evidence : null;
    if (!d || d.verdict !== 'PASS') return fail('DELIVERY_RESUME_INVALID_DECISION', b ? (b.evidence ?? null) : null);
    return await deliveryContinuation({ decision: d });
  }

  // ROUTED
  const router = deps.router || (() => ({ ok: false, code: 'NO_ROUTER' }));
  const routeR = await loop.step({
    name: 'route', from: 'ROUTED', to: 'EXECUTING', run: router, capture: 'value',
  }).catch((e) => ({ ok: false, code: 'ROUTE_THREW', detail: String((e && e.message) || e) }));
  if (!routeR.ok) return fail('ROUTE_FAILED', routeR.code || null);
  routeValue = routeR.result.value;

  // EXECUTING
  const execR = await loop.step({
    name: 'execute', from: 'EXECUTING', to: 'VERIFYING',
    run: (ctx) => executor({ ...ctx, model: routeValue.model, executorKind: routeValue.executorKind }),
    capture: 'value',
  });
  if (!execR.ok) return fail('EXECUTE_FAILED', execR.code || null);
  const executionRecordPath = execR.result.value.executionRecordPath;

  // P0-G (Issue #83): canonical publish chain — refresh the post-commit HEAD,
  // push the task branch, bind/adopt the PR at the exact pushed head, and
  // project the canonical review-ready packet BEFORE the reviewers resolve it
  // (the packet is identity-gated on pullRequest; delivery later re-adopts
  // the same PR as its own ledger-first side effect). Active only when the
  // caller injects a git transport (deps.pushExec); legacy fixtures keep the
  // previous behavior end-to-end (admission headSha stands, no git/remote).
  if (deps.pushExec !== undefined) {
    const pub = runPublishChain({ sessionPath, stateDir, identityHash: id, deps });
    if (!pub.ok) return fail(pub.code || 'PUBLISH_CHAIN_FAILED', { step: pub.step ?? null, detail: pub.detail ?? null });
  }

  // VERIFYING
  const verifyR = await loop.step({
    name: 'verify', from: 'VERIFYING', to: 'PRE_REVIEWING',
    run: (ctx) => verifier({ ...ctx, executionRecordPath }),
    capture: 'value',
  });
  if (!verifyR.ok) return fail('VERIFY_FAILED', verifyR.code || null);
  const verifyReport = verifyR.result.value;

  // P0-G (Issue #83): re-project the canonical packet AFTER deterministic
  // verification so reviewers receive the verify verdict + execution record
  // path alongside the real git delta (the real GPT final review legitimately
  // blocked a placeholder-only packet with "insufficient canonical evidence").
  // Same-head overwrite is the designed idempotent re-entry of
  // writeReviewReady; best-effort — the publish-chain packet already satisfies
  // the NO_REVIEW_PACKET identity gate if this degrades.
  if (deps.pushExec !== undefined) {
    try {
      projectReviewReadyPacket({
        sessionPath, stateDir,
        exec: deps.pushExec ?? null,
        gh: deps.gh ?? null,
        verifyEvidence: verifyReport && typeof verifyReport === 'object'
          ? { verdict: verifyReport.verdict ?? null, exitCode: verifyReport.evidence && verifyReport.evidence.exitCode != null ? verifyReport.evidence.exitCode : null, executionRecordPath: verifyReport.evidence && verifyReport.evidence.executionRecordPath ? verifyReport.evidence.executionRecordPath : null }
          : null,
      });
    } catch { /* pre-review still has the publish-chain packet */ }
  }

  // PRE_REVIEWING
  // reviewReadyDir is plumbed into the pre-review step the same way DELIVERING
  // (line ~298) uses it: the canonical review-ready projection must be
  // resolvable for Gemini pre-review; absent / stale / foreign packets fail
  // closed inside the pre-review adapter itself.
  const preR = await loop.step({
    name: 'preReview', from: 'PRE_REVIEWING', to: 'FINAL_REVIEWING',
    run: (ctx) => preReview({ ...ctx, report: verifyReport, reviewReadyDir: deps.reviewReadyDir ?? null }),
    capture: 'value',
  });
  if (!preR.ok) return fail('PRE_REVIEW_FAILED', preR.code || null);
  const preReviewValue = preR.result.value;

  // FINAL_REVIEWING
  const finR = await loop.step({
    name: 'finalReview', from: 'FINAL_REVIEWING', to: 'DECIDING',
    run: (ctx) => finalReview({ ...ctx, report: verifyReport, preReview: preReviewValue }),
    capture: 'value',
  });
  if (!finR.ok) return fail('FINAL_REVIEW_FAILED', finR.code || null);
  const decision = finR.result.value;

  // DECIDING — single decision policy, re-entered after each rework leg.
  // Function declaration (hoisted): the P0-E resume branch above re-enters it
  // before the executor prefix steps are reached.
  async function decide({ decision: d }) {
    if (d.verdict === 'REWORK') {
    // P0-E (Issue #79): Soc_brain (never GPT) consumes the validated REWORK
    // verdict — persist decision + findings/evidenceRequests with provenance,
    // re-dispatch the SAME bound executor authority, read-back, and re-run
    // verification/review. Returns either the follow-up decision (hand it to
    // DECIDING again) or a fail-closed/recoverable error.
    // Issue #107 item 5(c): re-read the persisted session FIRST —
    // refreshCanonicalHead may have persisted a new head mid-loop, so the
    // session captured at loop entry can carry a stale canonical headSha and
    // the rework binding guard would wrongly fail-closed fresh work
    // (Issue #92 crash 2026-09-08).
    const rsFresh = readSessionByHash({ stateDir, identityHash: id });
    if (!rsFresh.ok) return fail('SESSION_READ_FAILED', rsFresh.reason || null);
    const rw = await runReworkLeg({
      loop, deps, stateDir, identityHash: id, session: rsFresh.session, routeValue, decision: d,
      executor, verifier, preReview, finalReview,
    });
    if (!rw.ok) return rw;
    if (rw.value && rw.value.state === 'BLOCKED') return ok(rw.value); // budget escalation: already transitioned + terminalized
    return await decide({ decision: rw.value.decision });
  }
  if (d.verdict === 'BLOCKED') {
    loop.transition({ from: 'DECIDING', to: 'BLOCKED', reason: 'final-review-blocked', evidence: d });
    const term = loop.terminalize({ outcome: 'BLOCKED', decision: d });
    return ok({ state: 'BLOCKED', terminalize: term, loopToken: loop.token });
  }

  // DELIVERING — REQUIRED READY_FOR_REVIEW notification obligation.
  // (1) canonical boundary transition DECIDING->DELIVERING;
  const tw = loop.transition({ from: 'DECIDING', to: 'DELIVERING', reason: 'ready-for-review-boundary', evidence: d });
  if (!tw.ok) return fail('TRANSITION_FAILED', tw.code);
  return await deliveryContinuation({ decision: d });
  }

  // P0-F (Issue #81): shared DELIVERING continuation — notification evidence
  // gate, then the Soc_brain-owned canonical delivery (deps.delivery), then
  // the canonical terminal transition verified against the PERSISTED session
  // record. Used by the fresh PASS path AND the DELIVERING-tail resume path
  // (crash between boundary and completion), so recovery replays exactly-once:
  // the dispatch ledger dedupes the notification, the delivery adapter is
  // ledger-first (no duplicate merge/close/cleanup), and terminalization is
  // guarded by the canonical session itself. A failure anywhere leaves the
  // loop at the DELIVERING tail (recoverable) — never a fabricated COMPLETED.
  async function deliveryContinuation({ decision: d }) {
  // (2) required notification side-effect — owned by ControlLoop itself, never
  // by executor/model memory; idempotent via the dispatch evidence ledger
  // (only API_ACCEPTED dedupes; failed/not-attempted stay recoverable).
  // The message carries the canonical review-ready packet when resolvable;
  // an unresolvable packet degrades to status-only (documented deviation).
  const packet = packetPathFor({ sessionPath, reviewReadyDir: deps.reviewReadyDir ?? null });
  const ev = readinessNotificationEvidence({
    session: rs.session, stateDir, spawn: deps.telegramSpawn ?? null,
    configPath: deps.telegramConfigPath ?? null, note: d && d.verdict,
    packetPath: packet.ok ? packet.packetPath : null,
  });
  let evidence = ev.status === 'API_ACCEPTED'
    ? { notification: { status: ev.status, messageId: ev.messageId ?? null, recordsPath: ev.recordsPath ?? null, packet: packet.ok ? packet.filename : null } }
    : null;
  // (2b) transport dead -> deterministic bounded recovery from the persisted
  // ledger (only if a prior attempt left evidence; recovery never fabricates).
  if (!evidence && deps.telegramRecovery !== false) {
    const rec = recoverLifecycleEvent({
      session: rs.session, event: READY_FOR_REVIEW_EVENT, stateDir,
      ...(deps.telegramSpawn ? { spawn: deps.telegramSpawn } : {}),
      ...(deps.telegramConfigPath ? { configPath: deps.telegramConfigPath } : {}),
      note: d && d.verdict,
      documentPath: packet.ok ? packet.packetPath : null,
    });
    if (rec && rec.status === 'API_ACCEPTED') {
      evidence = { notification: { status: 'API_ACCEPTED', messageId: rec.messageId ?? null, recordsPath: rec.recordsPath ?? null, recovered: true, packet: packet.ok ? packet.filename : null } };
    } else if (rec) {
      evidence = { notification: { status: rec.status, reason: rec.reason ?? rec.error ?? null, recovery: rec.status === 'DELIVERY_FAILED' ? 'DELIVERY_FAILED' : 'NOT_RECOVERABLE', recordsPath: rec.recordsPath ?? ev.recordsPath ?? null } };
    }
  }
  // (3) delivery evidence gate — fail closed: without terminal evidence the
  // obligation is NOT satisfied and the loop must not continue to COMPLETED.
  if (!evidence || evidence.notification.status !== 'API_ACCEPTED') {
    return fail('DELIVER_FAILED', evidence || ev);
  }
  // (4) canonical delivery (P0-F): REVIEW_PASS + notification evidence are
  // necessary, NEVER sufficient — the ControlLoop-owned delivery lifecycle
  // must actually complete before the terminal transition. No loop.step here:
  // a failed/ambiguous delivery must leave the loop at the DELIVERING tail
  // (recoverable via the resume path), not auto-BLOCKED.
  if (!deps.delivery) return fail('DELIVER_STEP_FAILED', 'delivery lifecycle adapter is required after validated PASS');
  let deliveryValue = null;
  try {
    const r = await deps.delivery({ sessionPath, decision: d, notification: evidence.notification });
    if (!r || r.ok !== true) return fail('DELIVER_STEP_FAILED', r || null);
    deliveryValue = r.value;
  } catch (e) {
    return fail('DELIVER_STEP_FAILED', String((e && e.message) || e));
  }
  // (5) canonical terminal transition + REAL state read-back. TASK_COMPLETED
  // is a canonical session state, not a computed verdict: the terminalize
  // result is verified against the persisted session record before the loop
  // may report COMPLETED; anything else fails closed (no fake terminal state).
  loop.transition({ from: 'DELIVERING', to: 'COMPLETED', reason: 'canonical-delivery-verified', evidence: { notification: evidence.notification, delivery: deliveryValue } });
  const term = loop.terminalize({ outcome: 'COMPLETED', decision: d });
  if (!term || term.ok !== true) return fail('TERMINALIZE_FAILED', term || null);
  let persisted = null;
  try { persisted = JSON.parse(fs.readFileSync(sessionPath, 'utf8')); } catch { /* read-back fails closed below */ }
  if (!persisted || persisted.state !== 'COMPLETED') {
    return fail('TERMINAL_STATE_VERIFY_FAILED', { expected: 'COMPLETED', got: persisted ? persisted.state : null });
  }
  return ok({ state: 'COMPLETED', notification: evidence.notification, delivery: deliveryValue, terminalize: term, loopToken: loop.token });
  }
  return await decide({ decision });
}

export function assertTerminalizationAuthorized({ sessionPath, identityHash: id, presentedToken, stateDir = defaultStateDir() }) {
  const rs = readSessionByHash({ stateDir, identityHash: id });
  if (!rs.ok) return fail('SESSION_READ_FAILED', rs.reason);
  const expected = rs.session.controlLoop && rs.session.controlLoop.terminalizeToken;
  if (!expected) return fail('NOT_CONTROL_LOOP_BOUND', 'session.controlLoop.terminalizeToken missing');
  if (typeof presentedToken !== 'string' || presentedToken !== expected) {
    return fail('TERMINALIZATION_TOKEN_MISMATCH', 'presented token does not match session-bound token');
  }
  return ok({ authorized: true, expected });
}

export function bindTerminalizeTokenToSession({ sessionPath, identityHash: id, token, stateDir = defaultStateDir(), now = () => new Date().toISOString() }) {
  const rs = readSessionByHash({ stateDir, identityHash: id });
  if (!rs.ok) return fail('SESSION_READ_FAILED', rs.reason);
  rs.session.controlLoop = rs.session.controlLoop || {};
  rs.session.controlLoop.terminalizeToken = token;
  rs.session.controlLoop.boundAt = now();
  rs.session.controlLoop.identityHash = id;
  const p = persistSessionRecord(sessionPath, rs.session);
  if (!p.ok) return fail('PERSIST_FAILED', p.detail);
  return ok({ bound: true });
}
