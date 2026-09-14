// merge-authorization.mjs — Issue #175 REWORK: the canonical, durable human
// merge-authorization record + the fail-closed gate the delivery leg CONSUMES
// before it may perform a squash merge.
//
// WHY THIS EXISTS: a validated GPT final PASS is a machine verdict; it is NOT a
// human authorization to merge (AGENTS.md R2: "No merge without explicit human
// authorization"; the Issue #175 hard invariant "GPT PASS must not substitute
// for human merge authorization"). The client control surface records an
// explicit human authorization via soc.authorize_merge; delivery must consume +
// verify it — bound EXACTLY to repository + issue + PR + the reviewed/merged
// HEAD — or the merge never happens.
//
// ONE source of truth: the SAME module is the producer (writeMergeAuthorization,
// called by the client / control plane) and the consumer (verifyMergeAuthorization,
// called by delivery.mjs#mergePr), so the record schema + binding + idempotent/
// conflict semantics cannot drift between the two sides.
//
// Authority model (unchanged):
//   * an authorization NEVER substitutes for GPT final PASS — delivery is only
//     reached on a validated PASS (control-loop), and this record does not
//     produce a verdict;
//   * GPT PASS NEVER substitutes for the authorization — mergePr refuses to issue
//     `gh pr merge` without an exact-bound record;
//   * the record is DATA only (performsMerge:false); it is not a lifecycle state
//     and grants no mutation ownership;
//   * missing / stale head / wrong PR / wrong issue / wrong repo / corrupt =>
//     fail closed, zero merge;
//   * identical replay is idempotent; a conflicting replay fails closed (create-
//     only write, no overwrite — mirrors review submit-decision semantics).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MERGE_AUTH_SCHEMA_VERSION = '1';
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SHA40_RE = /^[0-9a-f]{40}$/;
const CLIENT_REQUEST_ID_RE = /^[A-Za-z0-9._:@-]{8,128}$/;

function sha256hex(s) { return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex'); }
function bindingDigest(b) { return sha256hex(JSON.stringify([b.repository, b.issue, b.pullRequest, b.reviewedHeadSha])); }
function normRepo(r) { return String(r == null ? '' : r).toLowerCase(); }

export function mergeAuthDirFor({ stateDir }) { return path.join(path.resolve(stateDir), 'merge-authorization'); }
export function mergeAuthPathFor({ stateDir, identityHash: id }) { return path.join(mergeAuthDirFor({ stateDir }), `${id}.json`); }

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

// PRODUCER. Records an explicit human merge authorization for a canonical
// attempt (identity-addressed). Does NOT merge, terminalize or own mutation.
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
  const p = mergeAuthPathFor({ stateDir, identityHash: id });
  const w = createOnlyJson(p, record);
  if (!w.created) {
    const cur = readRecord(p);
    if (cur.corrupt) return { ok: false, code: 'MERGE_AUTH_RECORD_CORRUPT' };
    if (cur.value && cur.value.digest === record.digest) {
      return { ok: true, recorded: true, replayed: true, bound: nb.bound, identityHash: id };
    }
    return { ok: false, code: 'MERGE_AUTH_DUPLICATE_CONFLICT', detail: 'a different merge authorization already exists for this canonical attempt', existingBound: (cur.value && cur.value.bound) || null };
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
  const cur = readRecord(mergeAuthPathFor({ stateDir, identityHash: id }));
  if (cur.missing) return { ok: false, code: 'MERGE_AUTHORIZATION_REQUIRED', detail: 'no human merge authorization exists for this canonical attempt' };
  if (cur.corrupt) return { ok: false, code: 'MERGE_AUTH_RECORD_CORRUPT', detail: 'the authorization record is unreadable; fail closed' };
  const rec = cur.value;
  const b = rec.bound;
  if (!b || typeof b !== 'object') return { ok: false, code: 'MERGE_AUTH_RECORD_CORRUPT' };
  if (rec.identityHash !== id) return { ok: false, code: 'MERGE_AUTH_IDENTITY_MISMATCH', detail: 'authorization is bound to a different canonical identity' };
  if (normRepo(b.repository) !== nb.bound.repository) return { ok: false, code: 'MERGE_AUTH_REPO_MISMATCH', detail: `authorized repo=${b.repository} != merge repo=${nb.bound.repository}` };
  if (Number(b.issue) !== nb.bound.issue) return { ok: false, code: 'MERGE_AUTH_ISSUE_MISMATCH', detail: `authorized issue=${b.issue} != merge issue=${nb.bound.issue}` };
  if (Number(b.pullRequest) !== nb.bound.pullRequest) return { ok: false, code: 'MERGE_AUTH_PR_MISMATCH', detail: `authorized PR=${b.pullRequest} != merge PR=${nb.bound.pullRequest}` };
  if (String(b.reviewedHeadSha).toLowerCase() !== nb.bound.reviewedHeadSha) return { ok: false, code: 'MERGE_AUTH_HEAD_STALE', detail: `authorized head=${b.reviewedHeadSha} != merge head=${nb.bound.reviewedHeadSha}` };
  if (rec.performsMerge !== false) return { ok: false, code: 'MERGE_AUTH_RECORD_CORRUPT', detail: 'an authorization must never claim to merge' };
  return { ok: true, record: rec };
}

export function readMergeAuthorization({ stateDir, identityHash: id } = {}) {
  const cur = readRecord(mergeAuthPathFor({ stateDir, identityHash: id }));
  if (cur.missing) return { ok: false, code: 'MERGE_AUTH_NOT_FOUND' };
  if (cur.corrupt) return { ok: false, code: 'MERGE_AUTH_RECORD_CORRUPT' };
  return { ok: true, record: cur.value };
}
