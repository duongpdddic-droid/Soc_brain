// merge-authorization.mjs - Issue #175 REWORK: the canonical, durable human
// merge-authorization record + the fail-closed gate the delivery leg CONSUMES
// before it may perform a squash merge.
//
// WHY THIS EXISTS: a validated GPT final PASS is a machine verdict; it is NOT a
// human authorization to merge (AGENTS.md R2: "No merge without explicit human
// authorization"; the Issue #175 hard invariant "GPT PASS must not substitute
// for human merge authorization"). The client control surface records an
// explicit human authorization via soc.authorize_merge; delivery must consume +
// verify it - bound EXACTLY to repository + issue + PR + the reviewed/merged
// HEAD - or the merge never happens.
//
// REWORK F1 (this revision): the identityHash is STABLE while the reviewed HEAD
// may legitimately move (re-review -> PASS at a newer HEAD). The first revision
// stored ONE create-only file per identityHash, so after authorizing H1, HEAD->H2
// correctly made H1 stale, but authorizing H2 hit MERGE_AUTH_DUPLICATE_CONFLICT
// and delivery could never recover. Fix: store each authorization as an IMMUTABLE
// record keyed by canonical identity + exact binding digest:
//     merge-authorization/<identityHash>/<sha256(repository|issue|pullRequest|reviewedHeadSha)>.json
// so an authorization for a NEW HEAD is a NEW immutable file (H1 is never
// overwritten or removed). Invariants preserved:
//   * auth@H1 can never authorize H2 (verify keys on the exact binding digest);
//   * authorizing H2 after a valid PASS@H2 succeeds (no duplicate-conflict);
//   * an identical replay of the SAME binding is idempotent (same digest path);
//   * a conflicting replay (SAME HEAD, different repo/issue/PR) still fails
//     closed with MERGE_AUTH_DUPLICATE_CONFLICT - you cannot redefine what was
//     authorized for a specific HEAD, but a different HEAD is a new record;
//   * old records are immutable (create-only, never overwritten);
//   * delivery consumes ONLY the record whose binding equals the exact
//     repo+issue+PR+reviewedHeadSha being merged;
//   * no blind retry / no duplicate merge / no mutation-ownership change.
//
// ONE source of truth: the SAME module is the producer (writeMergeAuthorization,
// called by the client / control plane) and the consumer (verifyMergeAuthorization,
// called by delivery.mjs#mergePr), so the record schema + binding + idempotent/
// conflict semantics cannot drift between the two sides.
//
// Authority model (unchanged):
//   * an authorization NEVER substitutes for GPT final PASS - delivery is only
//     reached on a validated PASS (control-loop), and this record does not
//     produce a verdict;
//   * GPT PASS NEVER substitutes for the authorization - mergePr refuses to issue
//     `gh pr merge` without an exact-bound record;
//   * the record is DATA only (performsMerge:false); it is not a lifecycle state
//     and grants no mutation ownership;
//   * missing / stale head / wrong PR / wrong issue / wrong repo / corrupt =>
//     fail closed, zero merge.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MERGE_AUTH_SCHEMA_VERSION = '1';
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SHA40_RE = /^[0-9a-f]{40}$/;
const CLIENT_REQUEST_ID_RE = /^[A-Za-z0-9._:@-]{8,128}$/;
const DIGEST_RE = /^[0-9a-f]{64}\.json$/; // an immutable per-binding record file name

function sha256hex(s) { return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex'); }
function bindingDigest(b) { return sha256hex(JSON.stringify([b.repository, b.issue, b.pullRequest, b.reviewedHeadSha])); }
function normRepo(r) { return String(r == null ? '' : r).toLowerCase(); }

// Directory layout (REWORK F1): one DIRECTORY per canonical identity; inside it,
// one immutable file per exact binding digest. This lets several HEADs coexist
// without ever overwriting an older authorization.
export function mergeAuthDirFor({ stateDir }) { return path.join(path.resolve(stateDir), 'merge-authorization'); }
export function mergeAuthIdentityDirFor({ stateDir, identityHash: id }) { return path.join(mergeAuthDirFor({ stateDir }), id); }
export function mergeAuthPathFor({ stateDir, identityHash: id, bound }) {
  return path.join(mergeAuthIdentityDirFor({ stateDir, identityHash: id }), `${bindingDigest(bound)}.json`);
}

// Canonicalize + validate a merge-authorization binding. All four coordinates
// are mandatory and strictly shaped; anything else fails closed.
export function normalizeMergeBinding({ repo, issue, pullRequest, reviewedHeadSha } = {}) {
  const repository = normRepo(repo);
  if (!REPO_RE.test(repository)) return { ok: false, code: 'MERGE_AUTH_REPO_INVALID', detail: 'repository must be owner/name' };
  if (!Number.isInteger(issue) || issue <= 0) return { ok: false, code: 'MERGE_AUTH_ISSUE_INVALID' };
  if (!Number.isInteger(pullRequest) || pullRequest <= 0) return { ok: false, code: 'MERGE_AUTH_PR_INVALID' };
  if (typeof reviewedHeadSha !== 'string' || !SHA40_RE.test(reviewedHeadSha.toLowerCase())) return { ok: false, code: 'MERGE_AUTH_HEAD_INVALID', detail: 'reviewedHeadSha must be a 40-hex SHA' };
  return { ok: true, bound: { repository, issue, pullRequest, reviewedHeadSha: reviewedHeadSha.toLowerCase() } };
}

// Windows-safe create-only write: temp + linkSync (link fails EEXIST when the
// final path exists, so an established authorization can NEVER be overwritten).
function createOnlyJson(finalPath, value) {
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  const tmp = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    try { fs.linkSync(tmp, finalPath); return { created: true }; }
    catch (e) { if (e && e.code === 'EEXIST') return { created: false }; throw e; }
  } finally { try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ } }
}

function readRecord(p) {
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); }
  catch (e) { if (e && e.code === 'ENOENT') return { missing: true }; return { corrupt: true }; }
  let v; try { v = JSON.parse(raw); } catch { return { corrupt: true }; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { corrupt: true };
  return { value: v };
}

// Read every immutable record for one canonical identity (best-effort; corrupt
// files are skipped here and handled by the caller's classification).
function listRecords({ stateDir, identityHash: id }) {
  const dir = mergeAuthIdentityDirFor({ stateDir, identityHash: id });
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => DIGEST_RE.test(n)); }
  catch (e) { return []; } // ENOENT -> no records yet
  const out = [];
  for (const n of names) {
    const r = readRecord(path.join(dir, n));
    if (!r.corrupt && r.value) out.push(r.value);
  }
  return out;
}

// True when `a` and `b` are the same repository+issue+pullRequest (the immutable
// "attempt target"); reviewedHeadSha is allowed to differ (that is the whole
// point of REWORK F1).
function sameTarget(a, b) {
  return normRepo(a.repository) === normRepo(b.repository)
    && Number(a.issue) === Number(b.issue)
    && Number(a.pullRequest) === Number(b.pullRequest);
}

// PRODUCER. Records an explicit human merge authorization for one EXACT binding
// (identity + repository + issue + PR + reviewedHeadSha) as an immutable file.
// Re-authorizing at a different HEAD creates a NEW record (F1); an identical
// replay is idempotent; a conflicting replay (same HEAD, different binding) fails
// closed. Does NOT merge, terminalize or own mutation.
export function writeMergeAuthorization({
  stateDir, identityHash: id, repo, issue, issueNumber,
  pullRequest, reviewedHeadSha, authorizedBy, clientRequestId,
  now = () => new Date().toISOString(),
} = {}) {
  if (!stateDir) return { ok: false, code: 'MISSING_STATE_DIR' };
  if (typeof id !== 'string' || !id) return { ok: false, code: 'MISSING_IDENTITY_HASH' };
  if (typeof authorizedBy !== 'string' || !authorizedBy.trim()) return { ok: false, code: 'MERGE_AUTH_MISSING_AUTHORIZED_BY', detail: 'merge authorization must name the authorizing human' };
  if (typeof clientRequestId !== 'string' || !CLIENT_REQUEST_ID_RE.test(clientRequestId)) return { ok: false, code: 'MERGE_AUTH_MISSING_CLIENT_REQUEST_ID', detail: 'a stable clientRequestId (>=8 chars) is required for exactly-once replay safety' };
  const issueNum = Number.isInteger(issue) ? issue : issueNumber;
  const nb = normalizeMergeBinding({ repo, issue: issueNum, pullRequest, reviewedHeadSha });
  if (!nb.ok) return nb;

  const record = {
    schemaVersion: MERGE_AUTH_SCHEMA_VERSION, kind: 'MERGE_AUTHORIZATION', identityHash: id,
    bound: nb.bound, authorizedBy, clientRequestId, at: now(),
    performsMerge: false, digest: bindingDigest(nb.bound),
  };

  // A conflicting replay = an EXISTING authorization for the SAME HEAD whose
  // binding is otherwise different. A different HEAD is NOT a conflict (F1).
  for (const rec of listRecords({ stateDir, identityHash: id })) {
    const b = rec.bound;
    if (!b || typeof b !== 'object') continue;
    if (String(b.reviewedHeadSha).toLowerCase() === nb.bound.reviewedHeadSha && !sameTarget(b, nb.bound)) {
      return { ok: false, code: 'MERGE_AUTH_DUPLICATE_CONFLICT', detail: 'a different merge authorization already exists for this exact reviewed HEAD', existingBound: b };
    }
  }

  const p = mergeAuthPathFor({ stateDir, identityHash: id, bound: nb.bound });
  const w = createOnlyJson(p, record);
  if (!w.created) {
    const cur = readRecord(p);
    if (cur.corrupt) return { ok: false, code: 'MERGE_AUTH_RECORD_CORRUPT' };
    if (cur.value && cur.value.digest === record.digest) {
      return { ok: true, recorded: true, replayed: true, bound: nb.bound, identityHash: id };
    }
    // Same digest path but non-matching content cannot occur (path == digest);
    // belt-and-braces fail closed rather than overwrite.
    return { ok: false, code: 'MERGE_AUTH_DUPLICATE_CONFLICT', detail: 'authorization path collision', existingBound: (cur.value && cur.value.bound) || null };
  }
  return { ok: true, recorded: true, replayed: false, bound: nb.bound, identityHash: id };
}

// CONSUMER gate. Returns {ok:true,record} ONLY when a durable authorization binds
// EXACTLY to this repository + issue + PR + reviewed/merged HEAD. Every other
// outcome (absent / corrupt / foreign identity / repo/issue/PR mismatch / stale
// or wrong head) fails closed so the caller performs NO merge.
export function verifyMergeAuthorization({ stateDir, identityHash: id, repo, issue, pullRequest, reviewedHeadSha } = {}) {
  if (!stateDir || typeof id !== 'string' || !id) return { ok: false, code: 'MERGE_AUTHORIZATION_REQUIRED', detail: 'authorization store unaddressable (no stateDir/identity)' };
  const nb = normalizeMergeBinding({ repo, issue, pullRequest, reviewedHeadSha });
  if (!nb.ok) return { ok: false, code: nb.code, detail: nb.detail ?? null };

  // Exact binding record present -> authorize the merge.
  const exact = readRecord(mergeAuthPathFor({ stateDir, identityHash: id, bound: nb.bound }));
  if (exact.value) {
    const rec = exact.value; const b = rec.bound;
    if (!b || typeof b !== 'object') return { ok: false, code: 'MERGE_AUTH_RECORD_CORRUPT' };
    if (rec.identityHash !== id) return { ok: false, code: 'MERGE_AUTH_IDENTITY_MISMATCH', detail: 'authorization is bound to a different canonical identity' };
    if (normRepo(b.repository) !== nb.bound.repository) return { ok: false, code: 'MERGE_AUTH_REPO_MISMATCH', detail: `authorized repo=${b.repository} != merge repo=${nb.bound.repository}` };
    if (Number(b.issue) !== nb.bound.issue) return { ok: false, code: 'MERGE_AUTH_ISSUE_MISMATCH', detail: `authorized issue=${b.issue} != merge issue=${nb.bound.issue}` };
    if (Number(b.pullRequest) !== nb.bound.pullRequest) return { ok: false, code: 'MERGE_AUTH_PR_MISMATCH', detail: `authorized PR=${b.pullRequest} != merge PR=${nb.bound.pullRequest}` };
    if (String(b.reviewedHeadSha).toLowerCase() !== nb.bound.reviewedHeadSha) return { ok: false, code: 'MERGE_AUTH_HEAD_STALE', detail: `authorized head=${b.reviewedHeadSha} != merge head=${nb.bound.reviewedHeadSha}` };
    if (rec.performsMerge !== false) return { ok: false, code: 'MERGE_AUTH_RECORD_CORRUPT', detail: 'an authorization must never claim to merge' };
    return { ok: true, record: rec };
  }
  if (exact.corrupt) return { ok: false, code: 'MERGE_AUTH_RECORD_CORRUPT', detail: 'the authorization record is unreadable; fail closed' };

  // No exact record. Classify against the immutable records that DO exist for
  // this identity, so an older HEAD / wrong target yields a precise, truthful
  // fail-closed code (auth@H1 must never authorize H2, but never merges silently).
  const records = listRecords({ stateDir, identityHash: id });
  if (records.length === 0) return { ok: false, code: 'MERGE_AUTHORIZATION_REQUIRED', detail: 'no human merge authorization exists for this canonical attempt' };
  const matches = (r, pred) => r.bound && pred(r.bound);
  if (records.some((r) => matches(r, (b) => normRepo(b.repository) !== nb.bound.repository))) {
    return { ok: false, code: 'MERGE_AUTH_REPO_MISMATCH', detail: `no authorization for merge repo=${nb.bound.repository}` };
  }
  if (records.some((r) => matches(r, (b) => normRepo(b.repository) === nb.bound.repository && Number(b.issue) !== nb.bound.issue))) {
    return { ok: false, code: 'MERGE_AUTH_ISSUE_MISMATCH', detail: `no authorization for merge issue=${nb.bound.issue}` };
  }
  if (records.some((r) => matches(r, (b) => normRepo(b.repository) === nb.bound.repository && Number(b.issue) === nb.bound.issue && Number(b.pullRequest) !== nb.bound.pullRequest))) {
    return { ok: false, code: 'MERGE_AUTH_PR_MISMATCH', detail: `no authorization for merge PR=${nb.bound.pullRequest}` };
  }
  // Same repo+issue+PR present but a different reviewed HEAD -> stale.
  if (records.some((r) => matches(r, (b) => sameTarget(b, nb.bound)))) {
    return { ok: false, code: 'MERGE_AUTH_HEAD_STALE', detail: `authorized head(s) != merge head=${nb.bound.reviewedHeadSha}` };
  }
  return { ok: false, code: 'MERGE_AUTHORIZATION_REQUIRED', detail: 'no matching human merge authorization for this exact binding' };
}

// Read-only projection of the authorization(s) for one identity. Returns the most
// recent immutable record (by `at`, tie-break digest) so an observer can see the
// currently authorized HEAD. Never mutates.
export function readMergeAuthorization({ stateDir, identityHash: id } = {}) {
  if (!stateDir || typeof id !== 'string' || !id) return { ok: false, code: 'MERGE_AUTH_NOT_FOUND' };
  const dir = mergeAuthIdentityDirFor({ stateDir, identityHash: id });
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => DIGEST_RE.test(n)); }
  catch { return { ok: false, code: 'MERGE_AUTH_NOT_FOUND' }; }
  if (names.length === 0) return { ok: false, code: 'MERGE_AUTH_NOT_FOUND' };
  const recs = [];
  for (const n of names) { const r = readRecord(path.join(dir, n)); if (r.value) recs.push(r.value); }
  if (recs.length === 0) return { ok: false, code: 'MERGE_AUTH_RECORD_CORRUPT' };
  recs.sort((x, y) => {
    const ax = Date.parse(x.at || '') || 0, ay = Date.parse(y.at || '') || 0;
    if (ax !== ay) return ax - ay;
    return String(x.digest || '').localeCompare(String(y.digest || ''));
  });
  return { ok: true, record: recs[recs.length - 1], records: recs };
}
