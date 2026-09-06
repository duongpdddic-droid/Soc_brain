// delivery.mjs — P0-F canonical delivery lifecycle (Issue #81).
//
// Single responsibility: AFTER a validated PASS verdict AND the REQUIRED
// READY_FOR_REVIEW notification evidence, the Soc_brain ControlLoop performs
// the delivery mutations in strict order, each dependent mutation followed by
// a read-back before the next step:
//   PR create/read-back -> squash merge/read-back -> Issue close/read-back
//   -> canonical main sync/projection -> task worktree cleanup.
//
// Hard invariants (Issue #81):
//   - Only the Soc_brain ControlLoop reaches this module; executor/GPT/Gemini
//     never merge, close, sync or clean up.
//   - Every mutation is bound to (repo=Soc_brain, issue, approved 40-hex
//     headSha); the binding is re-checked against the canonical session
//     BEFORE each mutating step and against the live remote state at
//     read-back. Wrong/stale binding -> no mutation, fail closed.
//   - Every completed side effect is recorded in the crash-safe delivery
//     ledger (<stateDir>/control-loop/<id>/delivery.json) ONLY after its
//     read-back verified the real state. Resume is ledger-first: a recorded
//     side effect is never repeated, an unrecorded one is re-derived from
//     read-backs (a PR already MERGED by a crashed attempt is adopted, never
//     re-merged). Ambiguous results (unknown exit, signal kill, unparseable
//     success) fail closed with DELIVERY_AMBIGUOUS — the caller re-enters the
//     lifecycle to re-derive state, and the ledger guards make that replay
//     exactly-once. No blind retries.
//   - Cleanup runs LAST and can never destroy canonical delivery evidence:
//     the ledger, transition ledger, session and dispatch records all live in
//     the state dir, never inside the worktree.
//   - TASK_COMPLETED is NOT emitted here: this module performs no FSM
//     transition and no terminalization; control-loop.mjs owns the canonical
//     terminal transition and verifies the persisted session state afterwards.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cleanup as workspaceCleanup } from '../workspace/workspace.mjs';
import { pushBranch } from './push.mjs';

export const DELIVERY_SCHEMA_VERSION = '1';

// Canonical delivery scope: Soc_brain is the only repo whose canonical tasks
// this lifecycle may merge (parity with CONTROL_LOOP_CANONICAL_REPO in
// control-loop.mjs; duplicated to keep delivery.mjs import-light).
export const DELIVERY_CANONICAL_REPO = 'duongpdddic-droid/soc_brain';
export const DELIVERY_BASE_BRANCH = 'main';
export const DELIVERY_DEFAULT_BRANCH = 'feature/p0-f-delivery-lifecycle';

const HEAD_SHA_40 = /^[0-9a-fA-F]{40}$/;

function fail(code, detail) { return { ok: false, code, detail: detail ?? null }; }
function ok(v) { return { ok: true, value: v }; }

// ---------------------------------------------------------------------------
// Delivery ledger — the crash-safe, exactly-once side-effect record.
// ---------------------------------------------------------------------------
function deliveryLedgerPath({ stateDir, identityHash: id }) {
  return path.join(stateDir, 'control-loop', id, 'delivery.json');
}

export function readDeliveryLedger({ stateDir, identityHash: id }) {
  try {
    const raw = JSON.parse(fs.readFileSync(deliveryLedgerPath({ stateDir, identityHash: id }), 'utf8'));
    if (!raw || raw.schemaVersion !== DELIVERY_SCHEMA_VERSION || raw.identityHash !== id) return null;
    return raw;
  } catch { return null; }
}

function writeLedger({ stateDir, identityHash: id }, patch) {
  const fp = deliveryLedgerPath({ stateDir, identityHash: id });
  const prev = readDeliveryLedger({ stateDir, identityHash: id }) || { schemaVersion: DELIVERY_SCHEMA_VERSION, kind: 'delivery-ledger', identityHash: id };
  const next = { ...prev, ...patch, updatedAt: new Date().toISOString() };
  const tmp = `${fp}.tmp-${randomUUID()}`;
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, fp);
    return { ok: true, ledger: next, path: fp };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    return { ok: false, detail: String((e && e.message) || e) };
  }
}

// ---------------------------------------------------------------------------
// Canonical binding: session re-read + binding re-check before each step.
// ---------------------------------------------------------------------------
function readSessionAt(sessionPath) {
  try {
    const s = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    if (!s || s.repo !== DELIVERY_CANONICAL_REPO || !Number.isInteger(s.issueNumber) || s.issueNumber <= 0) {
      return fail('DELIVERY_BIND_FAILED', 'session is not a canonical Soc_brain task');
    }
    return { ok: true, session: s };
  } catch (e) {
    return fail('DELIVERY_BIND_FAILED', String((e && e.message) || e));
  }
}

function checkBinding({ session, expect }) {
  if (expect.issue != null && session.issueNumber !== expect.issue) {
    return fail('DELIVERY_BIND_FAILED', `issue mismatch: session=${session.issueNumber} expected=${expect.issue}`);
  }
  if (expect.headSha) {
    if (typeof session.headSha !== 'string' || !HEAD_SHA_40.test(session.headSha)) {
      return fail('DELIVERY_BIND_STALE', 'session has no pinned approved headSha');
    }
    if (session.headSha.toLowerCase() !== expect.headSha.toLowerCase()) {
      return fail('DELIVERY_BIND_STALE', `session head=${session.headSha.toLowerCase()} approved head=${expect.headSha.toLowerCase()}`);
    }
  }
  if (expect.pr != null && Number(session.prNumber) !== expect.pr) {
    return fail('DELIVERY_BIND_FAILED', `PR mismatch: session=${session.prNumber ?? null} expected=${expect.pr}`);
  }
  return { ok: true };
}

// Idempotent delivery input projection (canonical scope enforced here).
export function deliverySpec({ repo = DELIVERY_CANONICAL_REPO, issue, headSha, branch = DELIVERY_DEFAULT_BRANCH, baseBranch = DELIVERY_BASE_BRANCH, title, body } = {}) {
  if (typeof repo !== 'string' || repo.toLowerCase() !== DELIVERY_CANONICAL_REPO) {
    return fail('DELIVERY_SPEC_INVALID', `repo must be ${DELIVERY_CANONICAL_REPO}`);
  }
  if (!Number.isInteger(issue) || issue <= 0) return fail('DELIVERY_SPEC_INVALID', 'issue must be a positive integer');
  if (typeof headSha !== 'string' || !HEAD_SHA_40.test(headSha)) return fail('DELIVERY_SPEC_INVALID', 'headSha must be a 40-hex SHA');
  const clean = (s, fb) => (typeof s === 'string' && s.trim() ? s.trim() : fb);
  return ok({
    repo: DELIVERY_CANONICAL_REPO, issue, headSha: headSha.toLowerCase(),
    branch: clean(branch, DELIVERY_DEFAULT_BRANCH),
    baseBranch: clean(baseBranch, DELIVERY_BASE_BRANCH),
    title: clean(title, `feat: canonical task delivery (#${issue})`),
    body: clean(body, `Closes #${issue}`),
  });
}

// ---------------------------------------------------------------------------
// gh transport. A transport error without an exit status (ENOENT, signal
// kill, throw) is AMBIGUOUS for mutations: the side effect may or may not
// have happened, so callers fail closed instead of retrying blindly.
// ---------------------------------------------------------------------------
function runGh(gh, args, env) {
  let out;
  if (typeof gh === 'function') {
    try { out = gh(args); } catch (e) { return { unknown: true, error: String((e && e.message) || e) }; }
  } else {
    const r = spawnSync('gh', args, { encoding: 'utf8', windowsHide: true, env: env || undefined });
    if (r.error) return { unknown: true, error: String(r.error.code || r.error.message || r.error) };
    out = { code: r.status, stdout: r.stdout, stderr: r.stderr };
  }
  if (out && out.unknown) return { unknown: true, error: String(out.error || 'TRANSPORT_UNKNOWN') };
  if (!out || !Number.isInteger(Number(out.code))) {
    return { unknown: true, error: `GH_NO_EXIT_STATUS(${JSON.stringify(out && out.code)})` };
  }
  const code = Number(out.code);
  return { unknown: false, code, stdout: String((out && out.stdout) || ''), stderr: String((out && out.stderr) || '') };
}

function ghJson(gh, args, env) {
  const r = runGh(gh, args, env);
  if (r.unknown) return { unknown: true, error: r.error };
  if (r.code !== 0) return { ok: false, code: r.code, stderr: r.stderr.slice(0, 400) };
  try {
    return { ok: true, data: JSON.parse(r.stdout) };
  } catch (e) {
    return { unknown: true, error: `GH_JSON_PARSE: ${String((e && e.message) || e)}` };
  }
}

// Raw runner for TEXT-output mutation subcommands (pr create / pr merge /
// issue close): their stdout is NOT JSON. Exit status is still never treated
// as success evidence by the callers — every mutation keeps its read-back.
function ghRaw(gh, args, env) {
  const r = runGh(gh, args, env);
  if (r.unknown) return { unknown: true, error: r.error };
  if (r.code !== 0) return { ok: false, code: r.code, stdout: r.stdout, stderr: r.stderr };
  return { ok: true, stdout: r.stdout, stderr: r.stderr };
}

// ---------------------------------------------------------------------------
// Step 0: canonical push primitive (Issue #83 P0-G). After the executor commit
// the task branch exists ONLY locally; delivery's `gh pr create --head
// <branch>` requires the REMOTE branch. The push runs against the session's
// own worktree and the session/spec branch, with a remote read-back of the
// exact HEAD as the only evidence (exit codes are never evidence). Idempotent:
// a remote already carrying the exact SHA short-circuits (alreadyPresent) —
// no duplicate side effects on re-entry. An ambiguous push fails the delivery
// without blind retries (same policy as every other delivery mutation).
function pushTaskBranch({ spec, session, deps }) {
  return pushBranch({
    session: {
      worktreePath: session.worktreePath,
      branch: (typeof session.branch === 'string' && session.branch) ? session.branch : spec.branch,
      baseSha: session.baseSha,
    },
    exec: deps.pushExec,
  });
}

// ---------------------------------------------------------------------------
// Delivery steps (each = one dependent mutation + immediate read-back).
// ---------------------------------------------------------------------------

// Step 1: canonical PR create + read-back. Idempotent: when the session is
// already bound to a PR (prNumber), the PR is ADOPTED after verifying it is
// OPEN at the approved head; never re-created blindly. A create whose success
// output cannot be parsed back (PR number extract + verify) is AMBIGUOUS,
// never retried inside this run.
function ensurePr({ spec, session, gh, env }) {
  if (session.prNumber) {
    const v = ghJson(gh, ['pr', 'view', String(session.prNumber), '--repo', spec.repo, '--json', 'state,number,headRefName,headRefOid'], env);
    if (v.unknown) return { ambiguous: true, code: 'PR_VERIFY_UNKNOWN', detail: v.error };
    if (!v.ok) return { code: 'PR_VERIFY_FAILED', detail: `gh exit ${v.code}: ${v.stderr}` };
    const p = v.data;
    if (Number(p.number) !== session.prNumber) return { code: 'PR_IDENTITY_MISMATCH', detail: `view number=${p.number} session=${session.prNumber}` };
    if (String(p.state).toUpperCase() !== 'OPEN') return { code: 'PR_STATE_INVALID', detail: `PR #${p.number} state=${p.state}` };
    if (String(p.headRefOid || '').toLowerCase() !== spec.headSha) return { code: 'PR_HEAD_MISMATCH', detail: `PR head=${p.headRefOid} approved=${spec.headSha}` };
    return ok({ pr: { number: p.number, headRefOid: String(p.headRefOid).toLowerCase() } });
  }
  // Crash-recovery adoption: a PR for THIS exact head (branch + approved SHA)
  // may already exist from a previous crashed attempt. Adopt it — never
  // create a duplicate. A MERGED entry at the approved head flows into the
  // merge read-back path (mergePr precheck), an OPEN one is delivered as-is.
  const s = ghJson(gh, ['pr', 'list', '--repo', spec.repo, '--head', spec.branch, '--state', 'all', '--json', 'number,state,headRefOid'], env);
  if (s.unknown) return { ambiguous: true, code: 'PR_SEARCH_UNKNOWN', detail: s.error };
  if (!s.ok) return { code: 'PR_SEARCH_FAILED', detail: `gh exit ${s.code}: ${s.stderr}` };
  const entries = Array.isArray(s.data) ? s.data : [];
  const mine = entries.find((p) => p && String(p.headRefOid || '').toLowerCase() === spec.headSha
    && ['OPEN', 'MERGED'].includes(String(p.state || '').toUpperCase()));
  if (mine) return ok({ pr: { number: Number(mine.number), headRefOid: spec.headSha } });
  const c = ghRaw(gh, [
    'pr', 'create', '--repo', spec.repo, '--base', spec.baseBranch, '--head', spec.branch,
    '--title', spec.title, '--body', spec.body,
  ], env);
  if (c.unknown) return { ambiguous: true, code: 'PR_CREATE_UNKNOWN', detail: c.error };
  if (!c.ok) return { code: 'PR_CREATE_FAILED', detail: `gh exit ${c.code}: ${(c.stderr || c.stdout).trim()}` };
  const m = String(c.stdout ?? '').match(/\/pull\/(\d+)/);
  if (!m) return { ambiguous: true, code: 'PR_CREATE_PARSE', detail: String(c.stdout ?? '').slice(0, 200) };
  const number = Number(m[1]);
  const v = ghJson(gh, ['pr', 'view', String(number), '--repo', spec.repo, '--json', 'state,number,headRefOid'], env);
  if (v.unknown) return { ambiguous: true, code: 'PR_CREATE_READBACK_UNKNOWN', detail: v.error };
  if (!v.ok) return { code: 'PR_CREATE_READBACK_FAILED', detail: `gh exit ${v.code}: ${v.stderr}` };
  const p = v.data;
  if (String(p.state).toUpperCase() !== 'OPEN' || String(p.headRefOid || '').toLowerCase() !== spec.headSha) {
    return { code: 'PR_CREATE_READBACK_MISMATCH', detail: JSON.stringify({ state: p.state, head: p.headRefOid ?? null, expected: spec.headSha }) };
  }
  return ok({ pr: { number: p.number, headRefOid: String(p.headRefOid).toLowerCase() } });
}

// Step 2: squash merge. The gh exit code is NEVER the merge evidence: a
// non-zero exit may still have merged, a zero exit may be swallowed by the
// API. Only the remote read-back (PR state MERGED) is evidence.
function mergePr({ spec, pr, gh, env }) {
  const pre = ghJson(gh, ['pr', 'view', String(pr.number), '--repo', spec.repo, '--json', 'state,number,headRefOid'], env);
  if (pre.unknown) return { ambiguous: true, code: 'MERGE_PRECHECK_UNKNOWN', detail: pre.error };
  if (!pre.ok) return { code: 'MERGE_PRECHECK_FAILED', detail: `gh exit ${pre.code}: ${pre.stderr}` };
  const p = pre.data;
  const state = String(p.state || '').toUpperCase();
  if (state === 'MERGED') {
    // Deterministic crash recovery: a prior attempt already merged THIS PR.
    const rb = readBackMerge({ spec, prNumber: pr.number, gh, env });
    return rb.ambiguous ? { ambiguous: true, code: rb.code, detail: rb.detail } : rb;
  }
  if (state !== 'OPEN') return { code: 'MERGE_STATE_INVALID', detail: `PR state=${state}` };
  if (String(p.headRefOid || '').toLowerCase() !== spec.headSha) {
    return { code: 'MERGE_HEAD_MISMATCH', detail: `PR head=${p.headRefOid} approved head=${spec.headSha}` };
  }
  const m = ghRaw(gh, ['pr', 'merge', String(pr.number), '--repo', spec.repo, '--squash'], env);
  if (m.unknown) return { ambiguous: true, code: 'MERGE_AMBIGUOUS', detail: m.error };
  if (!m.ok) return { code: 'MERGE_FAILED', detail: `gh exit ${m.code}: ${(m.stderr || m.stdout).trim()}` };
  const rb = readBackMerge({ spec, prNumber: pr.number, gh, env });
  return rb.ambiguous ? { ambiguous: true, code: rb.code, detail: rb.detail } : rb;
}

// Merge read-back: the ONLY merge evidence is THIS PR reporting MERGED with a
// 40-hex merge commit whose SHA is verified through a SECOND canonical read
// (gh api commits/<oid> must exist). Binding stays airtight even when the
// caller re-enters after a crash.
function readBackMerge({ spec, prNumber, gh, env }) {
  const v = ghJson(gh, ['pr', 'view', String(prNumber), '--repo', spec.repo, '--json', 'state,mergeCommit'], env);
  if (v.unknown) return { ambiguous: true, code: 'MERGE_READBACK_UNKNOWN', detail: v.error };
  if (!v.ok) return { code: 'MERGE_READBACK_FAILED', detail: `gh exit ${v.code}: ${v.stderr}` };
  const p = v.data;
  const oid = p.mergeCommit && p.mergeCommit.oid ? String(p.mergeCommit.oid).toLowerCase() : null;
  if (String(p.state).toUpperCase() !== 'MERGED' || !oid || !HEAD_SHA_40.test(oid)) {
    return { code: 'MERGE_READBACK_INVALID', detail: JSON.stringify({ state: p.state ?? null, mergeCommit: oid }) };
  }
  const c = ghJson(gh, ['api', `repos/${spec.repo}/commits/${oid}`], env);
  if (c.unknown) return { ambiguous: true, code: 'MERGE_READBACK_UNKNOWN', detail: c.error };
  if (!c.ok) return { code: 'MERGE_READBACK_FAILED', detail: `gh exit ${c.code}: ${c.stderr}` };
  if (String((c.data && c.data.sha) || '').toLowerCase() !== oid) {
    return { code: 'MERGE_READBACK_INVALID', detail: `commit read-back sha mismatch for ${oid}` };
  }
  return ok({ merged: { mergeCommitSha: oid, prNumber } });
}

// Step 3: Issue close + read-back (idempotent: CLOSED is terminal on GitHub).
function closeIssue({ spec, gh, env }) {
  const v = ghJson(gh, ['issue', 'view', String(spec.issue), '--repo', spec.repo, '--json', 'state,number'], env);
  if (v.unknown) return { ambiguous: true, code: 'ISSUE_PRECHECK_UNKNOWN', detail: v.error };
  if (!v.ok) return { code: 'ISSUE_PRECHECK_FAILED', detail: `gh exit ${v.code}: ${v.stderr}` };
  if (String(v.data.state).toUpperCase() === 'CLOSED') return ok({ closed: { issueNumber: spec.issue }, resumed: true });
  const c = ghRaw(gh, ['issue', 'close', String(spec.issue), '--repo', spec.repo], env);
  if (c.unknown) return { ambiguous: true, code: 'ISSUE_CLOSE_UNKNOWN', detail: c.error };
  if (!c.ok) return { code: 'ISSUE_CLOSE_FAILED', detail: `gh exit ${c.code}: ${(c.stderr || c.stdout).trim()}` };
  const rb = ghJson(gh, ['issue', 'view', String(spec.issue), '--repo', spec.repo, '--json', 'state,number'], env);
  if (rb.unknown) return { ambiguous: true, code: 'ISSUE_CLOSE_READBACK_UNKNOWN', detail: rb.error };
  if (!rb.ok) return { code: 'ISSUE_CLOSE_READBACK_FAILED', detail: `gh exit ${rb.code}: ${rb.stderr}` };
  if (String(rb.data.state).toUpperCase() !== 'CLOSED') return { code: 'ISSUE_CLOSE_READBACK_INVALID', detail: `state=${rb.data.state}` };
  return ok({ closed: { issueNumber: spec.issue } });
}

// Step 4: canonical main sync/projection (read-only scan, fail-closed). The
// projection records WHERE canonical main stands AFTER delivery: base branch
// head + reachability of the merge commit and the approved head within the
// bounded commit window touching the loop's own bound file. No local checkout
// is touched.
function scanMainProjection({ spec, mergeCommitSha, gh, env }) {
  const q = ghJson(gh, ['api', `repos/${spec.repo}/branches/${spec.baseBranch}`], env);
  if (q.unknown) return { ambiguous: true, code: 'MAIN_PROJECTION_UNKNOWN', detail: q.error };
  if (!q.ok) return { code: 'MAIN_PROJECTION_FAILED', detail: `gh exit ${q.code}: ${q.stderr}` };
  const head = q.data && q.data.commit && q.data.commit.sha ? String(q.data.commit.sha).toLowerCase() : null;
  if (!head || !HEAD_SHA_40.test(head)) return { code: 'MAIN_PROJECTION_INVALID', detail: 'base branch head unresolved' };
  const scan = ghJson(gh, ['api', `repos/${spec.repo}/commits?sha=${spec.baseBranch}&per_page=30`], env);
  if (scan.unknown) return { ambiguous: true, code: 'MAIN_PROJECTION_UNKNOWN', detail: scan.error };
  if (!scan.ok) return { code: 'MAIN_PROJECTION_FAILED', detail: `gh exit ${scan.code}: ${scan.stderr}` };
  const list = Array.isArray(scan.data) ? scan.data : [];
  const shas = new Set(list.map((c) => String((c && c.sha) || '').toLowerCase()));
  if (!shas.has(spec.headSha)) {
    // Issue #83: unbounded path filter — the original scan filtered commits by
    // path=packages/control-loop/control-loop.mjs, which silently breaks
    // delivery for any task touching other files (e.g. docs/) as soon as the
    // bounded window of 30 commits ages past the last control-loop change.
    // The approved head is now asserted against the UNFILTERED branch history
    // window; full reachability is already proven by mergePr's second read
    // (repos/<repo>/commits/<mergeCommit>).
    return { code: 'MAIN_PROJECTION_HEAD_MISSING', detail: `approved head ${spec.headSha} not reachable in the last ${list.length} commits on ${spec.baseBranch}` };
  }
  if (!shas.has(String(mergeCommitSha).toLowerCase())) {
    return { code: 'MAIN_PROJECTION_MERGE_MISSING', detail: `merge commit ${mergeCommitSha} not reachable in the last ${list.length} commits on ${spec.baseBranch}` };
  }
  return ok({ projection: { baseBranch: spec.baseBranch, head, mergeCommitReachable: true, approvedHeadReachable: true } });
}

// Step 5: task worktree cleanup via the canonical workspace primitive
// (fail-closed inside). Runs LAST; a failure never destroys the canonical
// delivery evidence recorded above — it only leaves a residual worktree and
// the caller returns a recoverable failure.
function cleanupWorktree({ session, deps }) {
  const wt = session.worktreePath;
  if (!wt) return ok({ skipped: true, reason: 'NO_TASK_WORKTREE_BOUND' });
  // Issue #83 (P0-G): the opencode.json projection is CONTROL-PLANE-owned
  // (runtime-sandbox writes it at taskStart via tmp+rename; its content pins
  // this identity's session/MCP env, so it always differs from the tracked
  // default on a real run). Restore it to HEAD before cleanup so the
  // fail-closed dirty-worktree guard only ever protects real executor work.
  try {
    spawnSync('git', ['checkout', '--', 'opencode.json'], { cwd: wt, encoding: 'utf8', windowsHide: true });
  } catch { /* cleanup still fail-closed if restore is impossible */ }
  const run = deps.cleanup || workspaceCleanup;
  let r;
  try {
    r = run({
      worktreesRoot: session.worktreesRoot,
      repo: session.repo,
      issueNumber: session.issueNumber,
      baseSha: session.baseSha,
      cwd: process.cwd(),
    });
  } catch (e) {
    return { code: 'CLEANUP_FAILED', detail: String((e && e.message) || e), residual: { worktree: wt } };
  }
  if (!r || r.ok !== true) {
    return { code: 'CLEANUP_FAILED', detail: `${(r && r.reason) || 'CLEANUP_REFUSED'}: ${(r && r.detail) || ''}`.trim(), residual: { worktree: wt } };
  }
  return ok({ cleanup: { removed: Array.isArray(r.removed) ? r.removed : [], keptBranch: r.keptBranch ?? null, idempotent: r.idempotent === true } });
}

// ---------------------------------------------------------------------------
// Orchestrator: sequential dependent mutations, ledger-first resume.
// ---------------------------------------------------------------------------
export async function runDeliveryLifecycle({
  sessionPath, identityHash: id, stateDir,
  issue, headSha, branch, baseBranch, title, body,
  deps = {},
} = {}) {
  if (typeof sessionPath !== 'string' || !sessionPath) return fail('MISSING_SESSION_PATH');
  if (typeof id !== 'string' || !id) return fail('MISSING_IDENTITY_HASH');
  if (!stateDir) return fail('MISSING_STATE_DIR');
  const sp = deliverySpec({ issue, headSha, branch, baseBranch, title, body });
  if (!sp.ok) return fail(sp.code, sp.detail);
  const spec = sp.value;

  // (0) Canonical binding re-check BEFORE any mutation.
  const sb = readSessionAt(sessionPath);
  if (!sb.ok) return sb;
  const bind = checkBinding({ session: sb.session, expect: { issue: spec.issue, headSha: spec.headSha } });
  if (!bind.ok) return bind;

  // (1) Ledger-first idempotency input. A ledger whose spec CONTRADICTS the
  // requested delivery is stale/foreign -> fail closed, never blind-retry.
  const ledger = readDeliveryLedger({ stateDir, identityHash: id });
  if (ledger && ledger.spec) {
    const s = ledger.spec;
    if (s.issue !== spec.issue || String(s.headSha).toLowerCase() !== spec.headSha || String(s.repo).toLowerCase() !== spec.repo) {
      return fail('DELIVERY_LEDGER_CONFLICT', JSON.stringify({
        ledger: { issue: s.issue, headSha: s.headSha, repo: s.repo },
        requested: { issue: spec.issue, headSha: spec.headSha, repo: spec.repo },
      }));
    }
  }
  const gh = deps.gh ?? null;
  const env = deps.env ?? null;
  let book = {
    spec,
    pushed: (ledger && ledger.pushed) || null,
    pr: (ledger && ledger.pr) || null,
    merged: (ledger && ledger.merged) || null,
    closed: (ledger && ledger.closed) || null,
    synced: (ledger && ledger.synced) || null,
    cleanup: (ledger && ledger.cleanup) || null,
  };

  // (1.5) Canonical push (Issue #83 P0-G): the remote branch MUST carry the
  // approved head BEFORE `gh pr create --head <branch>`; otherwise delivery
  // fails closed with PR_CREATE_FAILED (the branch never existed remotely).
  // Ledger-first like every other side effect: a recorded push that matches
  // the spec is never re-pushed; a mismatched record is a hard conflict.
  let pushed = book.pushed;
  // Issue #83: the push only runs when pushExec is WIRED (presence, not value
  // — null means "use real git"). The ControlLoop's pre-review publish chain
  // pushes + binds the PR before the reviewers run; delivery's ensurePr then
  // ADOPTS that PR (session.prNumber) instead of creating a duplicate. Fixtures
  // without pushExec keep the P0-F shape (PR created here, first mutation).
  if (!pushed && deps.pushExec !== undefined) {
    const ps = pushTaskBranch({ spec, session: sb.session, deps });
    if (!ps.ok) return fail(ps.code, ps.detail);
    const w = writeLedger({ stateDir, identityHash: id }, { pushed: { branch: ps.value.branch, headSha: ps.value.headSha, remote: ps.value.remote, alreadyPresent: ps.value.alreadyPresent === true } });
    if (!w.ok) return fail('DELIVERY_LEDGER_WRITE_FAILED', w.detail);
    book = w.ledger;
    pushed = book.pushed;
  }
  if (pushed && (pushed.branch !== spec.branch || pushed.headSha !== spec.headSha)) {
    return fail('DELIVERY_LEDGER_CONFLICT', JSON.stringify({ ledger: { pushed }, requested: { branch: spec.branch, headSha: spec.headSha } }));
  }

  // (2) PR bound to the approved head.
  let pr = book.pr;
  if (!pr || !Number.isInteger(pr.number)) {
    const r = ensurePr({ spec, session: sb.session, gh, env });
    if (r.ambiguous) return fail('DELIVERY_AMBIGUOUS', { step: 'pr', code: r.code, detail: r.detail });
    if (!r.ok) return fail(r.code, r.detail);
    pr = r.value.pr;
    const w = writeLedger({ stateDir, identityHash: id }, { spec, pr });
    if (!w.ok) return fail('DELIVERY_LEDGER_WRITE_FAILED', w.detail);
    book = w.ledger;
  }

  // (3) Squash merge + read-back (MERGED resumes via read-back, never re-merged).
  let merged = book.merged;
  if (!merged || !HEAD_SHA_40.test(String(merged.mergeCommitSha || ''))) {
    const r = mergePr({ spec, pr, gh, env });
    if (r.ambiguous) return fail('DELIVERY_AMBIGUOUS', { step: 'merge', code: r.code, detail: r.detail });
    if (!r.ok) return fail(r.code, r.detail);
    merged = r.value.merged;
    const w = writeLedger({ stateDir, identityHash: id }, { merged });
    if (!w.ok) return fail('DELIVERY_LEDGER_WRITE_FAILED', w.detail);
    book = w.ledger;
  }

  // (4) Issue close + read-back.
  let closed = book.closed;
  if (!closed) {
    const r = closeIssue({ spec, gh, env });
    if (r.ambiguous) return fail('DELIVERY_AMBIGUOUS', { step: 'close', code: r.code, detail: r.detail });
    if (!r.ok) return fail(r.code, r.detail);
    closed = r.value.closed;
    const w = writeLedger({ stateDir, identityHash: id }, { closed });
    if (!w.ok) return fail('DELIVERY_LEDGER_WRITE_FAILED', w.detail);
    book = w.ledger;
  }

  // (5) Canonical main sync/projection (read-only scan).
  let synced = book.synced;
  if (!synced) {
    const r = scanMainProjection({ spec, mergeCommitSha: merged.mergeCommitSha, gh, env });
    if (r.ambiguous) return fail('DELIVERY_AMBIGUOUS', { step: 'sync', code: r.code, detail: r.detail });
    if (!r.ok) return fail(r.code, r.detail);
    synced = r.value.projection;
    const w = writeLedger({ stateDir, identityHash: id }, { synced });
    if (!w.ok) return fail('DELIVERY_LEDGER_WRITE_FAILED', w.detail);
    book = w.ledger;
  }

  // (6) Task worktree cleanup — LAST; failure keeps all delivery evidence.
  let cl = book.cleanup;
  if (!cl) {
    const r = cleanupWorktree({ session: sb.session, deps });
    if (!r.ok) return fail(r.code, r.detail);
    cl = r.value.cleanup || { skipped: true, reason: r.value.reason };
    const w = writeLedger({ stateDir, identityHash: id }, { cleanup: cl });
    if (!w.ok) return fail('DELIVERY_LEDGER_WRITE_FAILED', w.detail);
    book = w.ledger;
  }

  return ok({
    state: 'DELIVERED',
    spec,
    pushed: book.pushed,
    pr: book.pr, merged: book.merged, closed: book.closed,
    synced: book.synced, cleanup: book.cleanup,
    ledgerPath: deliveryLedgerPath({ stateDir, identityHash: id }),
  });
}