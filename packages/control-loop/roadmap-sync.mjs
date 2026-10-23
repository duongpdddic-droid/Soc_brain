// roadmap-sync.mjs — post-merge roadmap sync (Bố's A+C decision).
//
// A: after a human-authorized merge is read back, create a SEPARATE docs-only
//    roadmap PR. Never mutate the reviewed task branch or main directly.
// C: automate that PR from the ControlLoop/task-server delivery boundary.
//
// Deterministic scope: update Date + append a post-merge evidence line. The
// semantic R9 status is NOT guessed here; the generated line marks it as
// "pending operator stamp" until a human/control owner reviews the PR.
//
// Fail-closed: every mutation has a read-back; unknown transport results are
// ambiguous and are never retried blindly. An existing PR for the same branch
// is adopted instead of duplicated.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const ROADMAP_PATH = 'docs/MASTER_ROADMAP_v2.md';
const HEAD_SHA_40 = /^[0-9a-fA-F]{40}$/;
const DATE_YYYY_MM_DD = /^\d{4}-\d{2}-\d{2}$/;

function fail(code, detail) { return { ok: false, code, detail: detail ?? null }; }
function ok(v) { return { ok: true, value: v }; }

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
  return { unknown: false, code: Number(out.code), stdout: String((out && out.stdout) || ''), stderr: String((out && out.stderr) || '') };
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

function ghRaw(gh, args, env) {
  const r = runGh(gh, args, env);
  if (r.unknown) return { unknown: true, error: r.error };
  if (r.code !== 0) return { ok: false, code: r.code, stdout: r.stdout, stderr: r.stderr };
  return { ok: true, stdout: r.stdout, stderr: r.stderr };
}

export function roadmapSyncBranch({ issue, prNumber, mergeCommitSha } = {}) {
  const i = Number(issue);
  const p = Number(prNumber);
  const sha = String(mergeCommitSha || '').toLowerCase();
  if (!Number.isInteger(i) || i <= 0) return fail('ROADMAP_SYNC_INPUT_INVALID', 'issue must be a positive integer');
  if (!Number.isInteger(p) || p <= 0) return fail('ROADMAP_SYNC_INPUT_INVALID', 'prNumber must be a positive integer');
  if (!HEAD_SHA_40.test(sha)) return fail('ROADMAP_SYNC_INPUT_INVALID', 'mergeCommitSha must be a 40-hex SHA');
  return ok(`roadmap/sync-${i}-${sha.slice(0, 7)}`);
}

export function stampRoadmap(text, { date, issue, prNumber, mergeCommitSha } = {}) {
  if (typeof text !== 'string' || !text.trim()) return fail('ROADMAP_SYNC_CONTENT_INVALID', 'roadmap content is empty');
  const i = Number(issue);
  const p = Number(prNumber);
  const sha = String(mergeCommitSha || '').toLowerCase();
  if (!Number.isInteger(i) || i <= 0) return fail('ROADMAP_SYNC_INPUT_INVALID', 'issue must be a positive integer');
  if (!Number.isInteger(p) || p <= 0) return fail('ROADMAP_SYNC_INPUT_INVALID', 'prNumber must be a positive integer');
  if (!HEAD_SHA_40.test(sha)) return fail('ROADMAP_SYNC_INPUT_INVALID', 'mergeCommitSha must be a 40-hex SHA');
  if (typeof date !== 'string' || !DATE_YYYY_MM_DD.test(date)) return fail('ROADMAP_SYNC_INPUT_INVALID', 'date must be YYYY-MM-DD');

  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const dateIdx = lines.findIndex((line) => /^Date:\s*\d{4}-\d{2}-\d{2}\s*$/.test(line));
  if (dateIdx < 0) return fail('ROADMAP_SYNC_ANCHOR_MISSING', 'no Date: YYYY-MM-DD header line');

  // Idempotent only on the exact post-merge evidence line for this merge SHA.
  // A SHA appearing elsewhere (e.g. a historical remote-main note) must not
  // suppress the required Date/evidence stamp.
  const postMergeForSha = new RegExp(`^Last synchronized \\(post-merge\\):.*merge SHA ${sha};`);
  if (lines.some((line) => postMergeForSha.test(line))) {
    return ok({ changed: false, text, line: null });
  }

  const line = `Last synchronized (post-merge): ${date} - Issue #${i} / PR #${p}, merge SHA ${sha}; status: pending operator stamp.`;

  // Keep exactly one post-merge line: a later merge replaces the previous
  // evidence instead of growing the header forever.
  const postMergeIdx = lines.findIndex((l) => /^Last synchronized \(post-merge\):/.test(l));
  if (postMergeIdx >= 0) {
    lines[dateIdx] = `Date: ${date}`;
    lines[postMergeIdx] = line;
    return ok({ changed: true, text: lines.join(nl), line });
  }

  let anchor = -1;
  for (let n = 0; n < lines.length; n += 1) {
    if (/^(Last|Previous) synchronized\b/.test(lines[n])) anchor = n;
  }
  if (anchor < 0) {
    const northStar = lines.findIndex((line) => /^North Star:/.test(line));
    anchor = northStar >= 0 ? northStar : dateIdx;
  }

  lines[dateIdx] = `Date: ${date}`;
  lines.splice(anchor + 1, 0, line);
  return ok({ changed: true, text: lines.join(nl), line });
}

export function roadmapSyncPrBody({ issue, prNumber, mergeCommitSha, date } = {}) {
  return [
    `Post-merge roadmap sync for Issue #${issue} / PR #${prNumber}.`,
    '',
    `- Merge SHA: \`${mergeCommitSha}\``,
    `- Date: ${date}`,
    '- Scope: `docs/MASTER_ROADMAP_v2.md` only',
    '- Semantic status: **pending operator stamp** (this PR must not guess R9 status)',
    '',
    'Created automatically after a human-authorized merge. Review the status/evidence before merging this docs-only PR.',
  ].join('\n');
}

function sameSha(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

// Operating-date helper: roadmap evidence follows the local operating day, not
// UTC, so a late-evening VN merge does not get yesterday's date.
export function localDateYmd(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function readRoadmapFile({ gh, repo, roadmapPath, ref, env }) {
  const file = ghJson(gh, ['api', `repos/${repo}/contents/${roadmapPath}?ref=${encodeURIComponent(ref)}`], env);
  if (file.unknown) return { ambiguous: true, code: 'ROADMAP_SYNC_FILE_READ_UNKNOWN', detail: file.error };
  if (!file.ok) return fail('ROADMAP_SYNC_FILE_READ_FAILED', `gh exit ${file.code}: ${file.stderr}`);
  const content = file.data && typeof file.data.content === 'string' ? file.data.content : null;
  const sha = file.data && typeof file.data.sha === 'string' ? file.data.sha : null;
  if (!content || !sha) return fail('ROADMAP_SYNC_FILE_READ_INVALID', 'missing content/sha');
  try {
    return ok({ text: Buffer.from(content.replace(/\s+/g, ''), 'base64').toString('utf8'), sha });
  } catch (e) {
    return fail('ROADMAP_SYNC_FILE_DECODE_FAILED', String((e && e.message) || e));
  }
}

function deleteRef({ gh, repo, branch, env }) {
  const r = ghRaw(gh, ['api', '-X', 'DELETE', `repos/${repo}/git/refs/heads/${branch}`], env);
  return !!(r && r.ok === true);
}

/**
 * Create (or adopt) the post-merge docs-only roadmap PR.
 * Every mutation is followed by a read-back; a branch/PR conflict fails closed.
 */
export async function createRoadmapSyncPr({
  repo,
  issue,
  prNumber,
  mergeCommitSha,
  baseBranch = 'main',
  date,
  roadmapPath = ROADMAP_PATH,
  gh = null,
  env = null,
  stateDir = null,
} = {}) {
  const b = roadmapSyncBranch({ issue, prNumber, mergeCommitSha });
  if (!b.ok) return b;
  const branch = b.value;
  if (typeof repo !== 'string' || !repo.includes('/')) return fail('ROADMAP_SYNC_INPUT_INVALID', 'repo must be owner/name');
  if (typeof baseBranch !== 'string' || !baseBranch.trim()) return fail('ROADMAP_SYNC_INPUT_INVALID', 'baseBranch is required');
  if (typeof date !== 'string' || !DATE_YYYY_MM_DD.test(date)) return fail('ROADMAP_SYNC_INPUT_INVALID', 'date must be YYYY-MM-DD');

  // 1) Adopt an existing PR for this exact branch, but prove its identity:
  // --head is a filter, not evidence that this is the docs-only roadmap PR.
  const listed = ghJson(gh, ['pr', 'list', '--repo', repo, '--head', branch, '--state', 'all', '--json', 'number,state,headRefOid,headRefName,baseRefName'], env);
  if (listed.unknown) return { ambiguous: true, code: 'ROADMAP_SYNC_PR_LIST_UNKNOWN', detail: listed.error };
  if (!listed.ok) return fail('ROADMAP_SYNC_PR_LIST_FAILED', `gh exit ${listed.code}: ${listed.stderr}`);
  const entries = Array.isArray(listed.data) ? listed.data : [];
  const existing = entries.find((e) => e && Number.isInteger(Number(e.number)));
  if (existing) {
    const state = String(existing.state || '').toUpperCase();
    if (state !== 'OPEN' && state !== 'MERGED') {
      return fail('ROADMAP_SYNC_PR_STATE_INVALID', `existing PR #${existing.number} state=${state || 'UNKNOWN'}`);
    }
    const headRefName = typeof existing.headRefName === 'string' ? existing.headRefName : '';
    const baseRefName = typeof existing.baseRefName === 'string' ? existing.baseRefName : '';
    if (headRefName !== branch || baseRefName !== baseBranch) {
      return fail('ROADMAP_SYNC_PR_IDENTITY_INVALID', JSON.stringify({
        number: existing.number, headRefName, baseRefName, expectedHead: branch, expectedBase: baseBranch,
      }));
    }
    return ok({
      changed: false,
      adopted: true,
      branch,
      prNumber: Number(existing.number),
      state,
      headSha: typeof existing.headRefOid === 'string' ? existing.headRefOid.toLowerCase() : null,
      headRefName,
      baseRefName,
    });
  }

  // 2) Read the current roadmap from the base branch for an early idempotency
  // check. The commit itself is based on the branch copy below.
  const baseRead = readRoadmapFile({ gh, repo, roadmapPath, ref: baseBranch, env });
  if (baseRead.ambiguous) return baseRead;
  if (!baseRead.ok) return baseRead;
  const stamped = stampRoadmap(baseRead.value.text, { date, issue, prNumber, mergeCommitSha });
  if (!stamped.ok) return stamped;
  if (!stamped.value.changed) {
    return ok({ changed: false, skipped: true, reason: 'already-stamped', branch, prNumber: null, headSha: null });
  }

  // 3) Recover or create the docs-only branch. A ref left by a crash is not a
  // blind retry: if it points at the merge commit (no stamp yet) or already
  // contains our exact evidence, continue from it. Anything else fails closed.
  const probe = ghRaw(gh, ['api', `repos/${repo}/git/ref/heads/${branch}`], env);
  if (probe.unknown) return { ambiguous: true, code: 'ROADMAP_SYNC_BRANCH_PROBE_UNKNOWN', detail: probe.error };
  let branchExists = false;
  let branchExistedBefore = false;
  let branchHead = null;
  let createdRef = false;
  if (probe.ok) {
    let parsed;
    try { parsed = JSON.parse(probe.stdout); } catch (e) {
      return { ambiguous: true, code: 'ROADMAP_SYNC_BRANCH_PROBE_PARSE', detail: String((e && e.message) || e) };
    }
    branchHead = parsed && parsed.object && typeof parsed.object.sha === 'string'
      ? parsed.object.sha.toLowerCase() : null;
    if (!branchHead || !HEAD_SHA_40.test(branchHead)) {
      return { ambiguous: true, code: 'ROADMAP_SYNC_BRANCH_PROBE_INVALID', detail: JSON.stringify(parsed && parsed.object) };
    }
    branchExists = true;
    branchExistedBefore = true;
  } else {
    const detail = (probe.stderr || probe.stdout || '').trim().slice(0, 400);
    const missing = Number(probe.code) === 404 || /not found|404/i.test(detail);
    if (!missing) return fail('ROADMAP_SYNC_BRANCH_PROBE_FAILED', `gh exit ${probe.code}: ${detail}`);
  }

  if (!branchExists) {
    const ref = ghRaw(gh, [
      'api', '-X', 'POST', `repos/${repo}/git/refs`,
      '-f', `ref=refs/heads/${branch}`,
      '-f', `sha=${String(mergeCommitSha).toLowerCase()}`,
    ], env);
    if (ref.unknown) return { ambiguous: true, code: 'ROADMAP_SYNC_BRANCH_UNKNOWN', detail: ref.error };
    if (ref.ok) {
      createdRef = true;
      branchHead = String(mergeCommitSha).toLowerCase();
      branchExists = true;
    } else {
      const detail = (ref.stderr || ref.stdout || '').trim().slice(0, 400);
      const conflict = Number(ref.code) === 422 || /already exists|reference already exists/i.test(detail);
      if (!conflict) return fail('ROADMAP_SYNC_BRANCH_CREATE_FAILED', `gh exit ${ref.code}: ${detail}`);
      const retry = ghRaw(gh, ['api', `repos/${repo}/git/ref/heads/${branch}`], env);
      if (retry.unknown) return { ambiguous: true, code: 'ROADMAP_SYNC_BRANCH_PROBE_UNKNOWN', detail: retry.error };
      if (!retry.ok) return fail('ROADMAP_SYNC_BRANCH_CREATE_FAILED', `gh exit ${ref.code}: ${detail}`);
      let parsed;
      try { parsed = JSON.parse(retry.stdout); } catch (e) {
        return { ambiguous: true, code: 'ROADMAP_SYNC_BRANCH_PROBE_PARSE', detail: String((e && e.message) || e) };
      }
      branchHead = parsed && parsed.object && typeof parsed.object.sha === 'string'
        ? parsed.object.sha.toLowerCase() : null;
      if (!branchHead || !HEAD_SHA_40.test(branchHead)) {
        return { ambiguous: true, code: 'ROADMAP_SYNC_BRANCH_PROBE_INVALID', detail: JSON.stringify(parsed && parsed.object) };
      }
      branchExists = true;
      branchExistedBefore = true;
    }
  }

  // 4) Read and stamp the branch copy (not the base copy). Using the branch
  // blob's sha removes the 409 class caused by committing a stale base sha.
  const branchRead = readRoadmapFile({ gh, repo, roadmapPath, ref: branch, env });
  if (branchRead.ambiguous) {
    if (createdRef) deleteRef({ gh, repo, branch, env });
    return branchRead;
  }
  if (!branchRead.ok) {
    if (createdRef) deleteRef({ gh, repo, branch, env });
    return branchRead;
  }
  const effectiveFileSha = branchRead.value.sha;
  const branchStamped = stampRoadmap(branchRead.value.text, { date, issue, prNumber, mergeCommitSha });
  if (!branchStamped.ok) {
    if (createdRef) deleteRef({ gh, repo, branch, env });
    return branchStamped;
  }

  let commitSha = null;
  let recoveredBranch = branchExistedBefore;
  if (!branchStamped.value.changed) {
    commitSha = branchHead;
    if (!commitSha || !HEAD_SHA_40.test(commitSha)) {
      return { ambiguous: true, code: 'ROADMAP_SYNC_COMMIT_READBACK_INVALID', detail: JSON.stringify({ branchHead }) };
    }
  } else {
    // A pre-existing branch at another commit without our stamp is foreign or
    // stale; never overwrite it blindly.
    if (branchExists && !createdRef && !sameSha(branchHead, mergeCommitSha)) {
      return fail('ROADMAP_SYNC_BRANCH_FOREIGN', `branch ${branch} head ${branchHead} != ${mergeCommitSha}`);
    }
    const payload = {
      message: `docs(roadmap): sync post-merge evidence for #${Number(issue)}`,
      content: Buffer.from(branchStamped.value.text, 'utf8').toString('base64'),
      sha: effectiveFileSha,
      branch,
    };
    const tmp = path.join(stateDir || os.tmpdir(), `roadmap-sync-${randomUUID()}.json`);
    let updated;
    try {
      fs.mkdirSync(path.dirname(tmp), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
      updated = ghRaw(gh, ['api', '-X', 'PUT', `repos/${repo}/contents/${roadmapPath}`, '--input', tmp], env);
    } catch (e) {
      if (createdRef) deleteRef({ gh, repo, branch, env });
      return fail('ROADMAP_SYNC_PAYLOAD_FAILED', String((e && e.message) || e));
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    }
    if (updated.unknown) return { ambiguous: true, code: 'ROADMAP_SYNC_COMMIT_UNKNOWN', detail: updated.error };
    if (!updated.ok) {
      if (createdRef) deleteRef({ gh, repo, branch, env });
      return fail('ROADMAP_SYNC_COMMIT_FAILED', `gh exit ${updated.code}: ${(updated.stderr || updated.stdout).trim().slice(0, 400)}`);
    }
    let committed;
    try { committed = JSON.parse(updated.stdout); } catch (e) {
      return { ambiguous: true, code: 'ROADMAP_SYNC_COMMIT_PARSE', detail: String((e && e.message) || e) };
    }
    commitSha = committed && committed.commit && typeof committed.commit.sha === 'string'
      ? committed.commit.sha.toLowerCase() : null;
    if (!commitSha || !HEAD_SHA_40.test(commitSha)) {
      return { ambiguous: true, code: 'ROADMAP_SYNC_COMMIT_READBACK_INVALID', detail: JSON.stringify(committed && committed.commit) };
    }
  }

  // 5) Open the PR and read it back. Exit code is never the evidence.
  const title = `docs(roadmap): sync post-merge evidence (#${Number(issue)})`;
  const body = roadmapSyncPrBody({ issue, prNumber, mergeCommitSha, date });
  const created = ghRaw(gh, [
    'pr', 'create', '--repo', repo, '--base', baseBranch, '--head', branch,
    '--title', title, '--body', body,
  ], env);
  if (created.unknown) return { ambiguous: true, code: 'ROADMAP_SYNC_PR_CREATE_UNKNOWN', detail: created.error };
  if (!created.ok) return fail('ROADMAP_SYNC_PR_CREATE_FAILED', `gh exit ${created.code}: ${(created.stderr || created.stdout).trim().slice(0, 400)}`);
  const m = String(created.stdout || '').match(/\/pull\/(\d+)/);
  if (!m) return { ambiguous: true, code: 'ROADMAP_SYNC_PR_CREATE_PARSE', detail: String(created.stdout || '').slice(0, 200) };
  const createdNumber = Number(m[1]);
  const view = ghJson(gh, ['pr', 'view', String(createdNumber), '--repo', repo, '--json', 'state,number,headRefOid,headRefName,baseRefName'], env);
  if (view.unknown) return { ambiguous: true, code: 'ROADMAP_SYNC_PR_READBACK_UNKNOWN', detail: view.error };
  if (!view.ok) return fail('ROADMAP_SYNC_PR_READBACK_FAILED', `gh exit ${view.code}: ${view.stderr}`);
  const p = view.data;
  const headRefName = typeof p.headRefName === 'string' ? p.headRefName : '';
  const baseRefName = typeof p.baseRefName === 'string' ? p.baseRefName : '';
  if (String(p.state).toUpperCase() !== 'OPEN' || !sameSha(p.headRefOid, commitSha) || Number(p.number) !== createdNumber
    || headRefName !== branch || baseRefName !== baseBranch) {
    return { ambiguous: true, code: 'ROADMAP_SYNC_PR_READBACK_MISMATCH', detail: JSON.stringify({ state: p.state, head: p.headRefOid ?? null, expected: commitSha, number: p.number, expectedNumber: createdNumber, headRefName, baseRefName, expectedHead: branch, expectedBase: baseBranch }) };
  }

  return ok({
    changed: true,
    adopted: false,
    branch,
    prNumber: createdNumber,
    state: 'OPEN',
    headSha: commitSha,
    fileSha: effectiveFileSha,
    headRefName,
    baseRefName,
    recoveredBranch,
  });
}
