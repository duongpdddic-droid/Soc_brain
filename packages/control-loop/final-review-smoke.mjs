#!/usr/bin/env node
// final-review-smoke.mjs — canonical Final Review TRANSPORT smoke seam.
//
// Purpose: let Web2API/CWA transports be exercised against the REAL production
// Final Review evidence/parser/binding/digest contract WITHOUT any production
// lifecycle side effect.
//
// Trust model (structural, fail-closed — not caller convention):
// - The ONLY writer of smoke artifacts is createFinalReviewSmoke() in THIS
//   module. Callers never hand-craft session JSON, review-ready Markdown,
//   digests or binding data.
// - The packet is rendered by the PRODUCTION renderer
//   (review-ready.mjs: renderReviewReady) unchanged, and consumed by the
//   PRODUCTION evidence/parser/binding path (createGptFinalReview,
//   parsePacketIdentity, assertFinalBinding) unchanged.
// - Smoke state lives ONLY under <smokeRoot>/<smokeId>/ (default
//   ~/.soc-brain/smoke/final-review/). Production resolvers
//   (readSessionRecord via production stateDir, packetPathFor via the
//   production review-ready dir, collectPreReviewEvidence via production
//   session paths, delivery/terminalize gates) never receive the smoke root,
//   so there is NO fallback from production lookup into smoke storage.
// - The smoke session carries purpose=FINAL_REVIEW_TRANSPORT_SMOKE and holds
//   ZERO authority fields: no lease token, no controlLoop.terminalizeToken,
//   no worktreePath/worktreesRoot, no binding record. Every production
//   authority gate (lease check, terminalize-token bind, execution-root bind,
//   delivery binding, merge authorization) fails closed on it.
// - Reserved identity ranges (issue 900000000..999999999,
//   pseudo-PR 990000000..999999999, random 40-hex headSha) are DEFENSE IN
//   DEPTH only (H5): numeric ranges alone cannot prove non-collision. Primary
//   isolation is explicit purpose + smokeId + storage separation + mandatory
//   production rejection gates (production resolvers never receive the smoke
//   root; smoke sessions carry no lease/terminalize-token/worktree authority).
//   The pseudo-PR is never created via gh — no remote read-back could ever
//   confirm it.
//
// This module never imports or calls: taskStart/provision, execution broker,
// pushBranch, delivery/merge, terminalize/taskFinish/taskBlock, telegram
// dispatch, git/gh/network, merge-authorization. Static tests enforce this.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { identityHash } from '../workspace/workspace.mjs';
import { SESSION_SCHEMA_VERSION, readSessionRecord } from '../runtime-sandbox/runtime-sandbox.mjs';
import { renderReviewReady, canonicalReportDigest, buildReviewReadyFilename } from '../review-ready/review-ready.mjs';
import { packetPathFor } from './review-packet.mjs';
import { parsePacketIdentity, verifyPacketDigest } from './review-evidence.mjs';

export const SMOKE_PURPOSE = 'FINAL_REVIEW_TRANSPORT_SMOKE';
export const SMOKE_SCHEMA_VERSION = '1';
export const SMOKE_REPO = 'duongpdddic-droid/soc_brain';
export const SMOKE_ISSUE_MIN = 900000000;
export const SMOKE_ISSUE_MAX = 999999999;
export const SMOKE_PR_MIN = 990000000;
export const SMOKE_PR_MAX = 999999999;
export const SMOKE_ID_RE = /^frs_[0-9a-f]{32}$/;
export const SMOKE_DEFAULT_TTL_MS = 3600000; // 1h
export const SMOKE_MAX_TTL_MS = 86400000; // 24h
// Claim-first idempotency (H4): a CLAIMING record older than this is treated
// as a crashed winner and may be taken over; a fresh one fails the loser
// deterministically with SMOKE_REQUEST_IN_FLIGHT (no second transaction).
export const SMOKE_CLAIM_STALE_MS = 300000; // 5m
// Lifecycle table (H3) — the ONLY legal transitions. Anything else fails
// closed with SMOKE_TRANSITION_REFUSED (CLOSED→CLOSED stays idempotent ok,
// close-on-expired is SMOKE_EXPIRED by definition).
export const SMOKE_TRANSITIONS = Object.freeze({
  REVIEW_READY: Object.freeze(['REVIEWED', 'CLOSED']),
  REVIEWED: Object.freeze(['CLOSED']),
  CLOSED: Object.freeze(['CLOSED']),
});

const HEAD_SHA_RE = /^[0-9a-f]{40}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DIGEST_STAMP_RE = /- reportDigest:\s*([0-9a-f]{64})/i;

export function defaultSmokeRoot() {
  return path.join(os.homedir(), '.soc-brain', 'smoke', 'final-review');
}

function fail(code, detail) {
  return { ok: false, code, detail: detail ?? null };
}

// ---- digest: the single canonical definition ----------------------------------
// P0: THE canonical reportDigest is sha256 over the rendered packet content
// WITHOUT the stamp line — computed by the shared production primitive
// canonicalReportDigest (review-ready.mjs), stripped by the shared inverse
// stripPacketDigestStamp (review-evidence.mjs). No second scheme exists
// anywhere: creator, production projector, and every verifier share both.
export function computeSmokeDigest({ content } = {}) {
  if (typeof content !== 'string' || !content) return fail('SMOKE_DIGEST_INPUT_INVALID', 'content must be a non-empty string');
  const digest = canonicalReportDigest(content);
  if (!digest) return fail('SMOKE_DIGEST_INPUT_INVALID', 'digest computation failed');
  return { ok: true, digest };
}

// ---- internal helpers (no authority) ---------------------------------------

function atomicWriteFile(filePath, content) {
  const tmp = `${filePath}.tmp-${randomUUID()}`;
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, filePath);
    return { ok: true };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    return fail('SMOKE_WRITE_FAILED', `${filePath}: ${String((e && e.message) || e)}`);
  }
}

// First-writer-wins exclusive create (A): no transaction may overwrite
// another transaction's artifact. The reserved-issue pick loop avoids reuse,
// but two creators (different clientRequestId) can still pick the same
// candidate in the same instant; the 'wx' flag turns that window into a clean
// SMOKE_ID_COLLISION instead of a silent overwrite of a committed sibling.
function exclusiveWriteFile(filePath, content) {
  try {
    fs.writeFileSync(filePath, content, { flag: 'wx', encoding: 'utf8' });
    return { ok: true };
  } catch (e) {
    if (e && (e.code === 'EEXIST' || /EEXIST/.test(String((e && e.message) || e)))) {
      return fail('SMOKE_ID_COLLISION', `identity already owned: ${filePath}`);
    }
    return fail('SMOKE_WRITE_FAILED', `${filePath}: ${String((e && e.message) || e)}`);
  }
}

function instanceDirFor(smokeRoot, smokeId) {
  return path.join(path.resolve(smokeRoot), smokeId);
}

function assertInside(root, target) {
  const r = path.resolve(root);
  const t = path.resolve(target);
  return t === r || t.startsWith(r + path.sep);
}

// ---- symlink / realpath containment (H1) -----------------------------------
// Lexical checks alone cannot see through symlinks: a path can resolve inside
// the smoke root while its realpath escapes it. Every security-relevant path
// is therefore (a) refused when any FINAL component is a symlink, and (b)
// re-validated by realpath containment. Residual TOCTOU (swap between check
// and use) is documented: an actor able to rewrite the smoke root at will
// already owns the machine-local store; the checks below close the
// accidental/misconfiguration class and every statically-planted case.
function refuseSymlink(absPath) {
  let st;
  try { st = fs.lstatSync(absPath); } catch {
    return fail('SMOKE_NOT_FOUND', absPath);
  }
  if (st.isSymbolicLink()) return fail('SMOKE_SYMLINK_REFUSED', absPath);
  return { ok: true, stat: st };
}

function assertRealInside(root, target) {
  let realRoot;
  let realTarget;
  try { realRoot = fs.realpathSync(path.resolve(root)); } catch {
    return fail('SMOKE_ROOT_UNREADABLE', String(root));
  }
  try { realTarget = fs.realpathSync(path.resolve(target)); } catch {
    return fail('SMOKE_NOT_FOUND', String(target));
  }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
    return fail('SMOKE_PATH_ESCAPE', `${target} -> ${realTarget}`);
  }
  return { ok: true, realTarget };
}

function randInt(min, max, rand) {
  const span = max - min + 1;
  const buf = rand(4);
  return min + (buf.readUInt32BE(0) % span);
}

function readMeta(smokeRoot, smokeId) {
  if (!SMOKE_ID_RE.test(smokeId)) return fail('SMOKE_ID_INVALID', String(smokeId));
  const dir = instanceDirFor(smokeRoot, smokeId);
  if (!assertInside(smokeRoot, dir)) return fail('SMOKE_PATH_ESCAPE', dir);
  // H1: the instance dir itself must be a real directory inside the root —
  // a symlinked dir (even lexically inside) is refused before anything is read.
  const dj = refuseSymlink(dir);
  if (!dj.ok) return dj.code === 'SMOKE_NOT_FOUND' ? fail('SMOKE_NOT_FOUND', smokeId) : dj;
  if (!dj.stat.isDirectory()) return fail('SMOKE_NOT_FOUND', smokeId);
  const ri = assertRealInside(smokeRoot, dir);
  if (!ri.ok) return ri;
  const metaPath = path.join(dir, 'meta.json');
  const mj = refuseSymlink(metaPath);
  if (!mj.ok) return mj.code === 'SMOKE_NOT_FOUND' ? fail('SMOKE_NOT_FOUND', smokeId) : mj;
  let raw;
  try { raw = fs.readFileSync(metaPath, 'utf8'); } catch {
    return fail('SMOKE_NOT_FOUND', smokeId);
  }
  let meta;
  try { meta = JSON.parse(raw); } catch (e) {
    return fail('SMOKE_META_INVALID', String((e && e.message) || e));
  }
  if (!meta || meta.schemaVersion !== SMOKE_SCHEMA_VERSION || meta.purpose !== SMOKE_PURPOSE || meta.smokeId !== smokeId) {
    return fail('SMOKE_META_INVALID', 'schema/purpose/identity mismatch');
  }
  const schemaCheck = validateSmokeMetaSchema(meta, dir);
  if (!schemaCheck.ok) return schemaCheck;
  return { ok: true, meta, dir };
}

// ---- B: full security-relevant meta schema validation -----------------------
// Every field is type/format-checked BEFORE the meta is trusted; malformed
// JSON that parses still fails closed with structured SMOKE_META_INVALID
// (never throws). Path fields must stay lexically inside the instance dir
// (realpath is re-validated at each use site).
function validateSmokeMetaSchema(meta, dir) {
  const bad = (field, why) => fail('SMOKE_META_INVALID', `${field}: ${why}`);
  try {
    if (typeof meta.identityHash !== 'string' || !/^[0-9a-f]{32}$/.test(meta.identityHash)) {
      return bad('identityHash', 'must be 32-hex');
    }
    const recomputed = identityHash({ repo: meta.repository, issueNumber: meta.issue });
    if (recomputed !== meta.identityHash || meta.smokeId !== `frs_${meta.identityHash}`) {
      return bad('identityHash', 'does not match repository/issue/smokeId');
    }
    if (typeof meta.repository !== 'string' || !REPO_RE.test(meta.repository) || meta.repository !== meta.repository.toLowerCase()) {
      return bad('repository', 'must be lowercase owner/name');
    }
    if (!Number.isInteger(meta.issue) || meta.issue < SMOKE_ISSUE_MIN || meta.issue > SMOKE_ISSUE_MAX) {
      return bad('issue', `must be an integer in [${SMOKE_ISSUE_MIN}, ${SMOKE_ISSUE_MAX}]`);
    }
    if (!Number.isInteger(meta.pullRequest) || meta.pullRequest < SMOKE_PR_MIN || meta.pullRequest > SMOKE_PR_MAX) {
      return bad('pullRequest', `must be an integer in [${SMOKE_PR_MIN}, ${SMOKE_PR_MAX}]`);
    }
    if (typeof meta.headSha !== 'string' || !HEAD_SHA_RE.test(meta.headSha) || meta.headSha !== meta.headSha.toLowerCase()) {
      return bad('headSha', 'must be lowercase 40-hex');
    }
    if (typeof meta.requestDigest !== 'string' || !/^[0-9a-f]{64}$/.test(meta.requestDigest)) {
      return bad('requestDigest', 'must be 64-hex');
    }
    for (const f of ['sessionPath', 'reviewReadyDir', 'packetPath', 'ledgerPath']) {
      if (typeof meta[f] !== 'string' || !meta[f]) return bad(f, 'must be a non-empty string');
    }
    // D: exact canonical paths (not merely "inside the instance dir").
    if (path.resolve(meta.sessionPath) !== path.join(dir, 'sessions', `${meta.identityHash}.json`)) {
      return bad('sessionPath', 'must be the canonical session path');
    }
    if (path.resolve(meta.reviewReadyDir) !== path.join(dir, 'review-ready')) {
      return bad('reviewReadyDir', 'must be the canonical packet dir');
    }
    const file = buildReviewReadyFilename({
      repo: meta.repository, issue: meta.issue, pr: meta.pullRequest, headSha: meta.headSha,
    });
    if (!file || path.resolve(meta.packetPath) !== path.join(path.resolve(meta.reviewReadyDir), file)) {
      return bad('packetPath', 'must be the canonical packet filename inside reviewReadyDir');
    }
    if (path.resolve(meta.ledgerPath) !== path.join(dir, 'control-loop', meta.identityHash, 'transitions.jsonl')) {
      return bad('ledgerPath', 'must be the canonical ledger path');
    }
    if (!['REVIEW_READY', 'REVIEWED', 'CLOSED'].includes(meta.state)) {
      return bad('state', 'must be a canonical lifecycle state');
    }
    const created = Date.parse(meta.createdAt);
    const expires = Date.parse(meta.expiresAt);
    if (typeof meta.createdAt !== 'string' || !Number.isFinite(created)) return bad('createdAt', 'must be ISO time');
    if (typeof meta.expiresAt !== 'string' || !Number.isFinite(expires)) return bad('expiresAt', 'must be ISO time');
    if (!(expires > created)) return bad('expiresAt', 'must be after createdAt');
    if (meta.clientRequestId !== null && meta.clientRequestId !== undefined && typeof meta.clientRequestId !== 'string') {
      return bad('clientRequestId', 'must be a string or null');
    }
  } catch (e) {
    return bad('meta', `validator threw: ${String((e && e.message) || e)}`);
  }
  return { ok: true };
}

function isExpired(meta, nowMs) {
  const exp = Date.parse(meta.expiresAt);
  if (!Number.isFinite(exp)) return true; // unparseable expiry fails closed
  return Number(nowMs) >= exp;
}

// ---- creation (the ONLY smoke writer) --------------------------------------

export function createFinalReviewSmoke({
  repo = SMOKE_REPO,
  ttlMs = SMOKE_DEFAULT_TTL_MS,
  smokeRoot = defaultSmokeRoot(),
  clientRequestId = null,
  nowMs = () => Date.now(),
  rand = (n) => crypto.randomBytes(n),
} = {}) {
  const root = path.resolve(smokeRoot);
  const repoLower = typeof repo === 'string' ? repo.toLowerCase() : '';
  if (!REPO_RE.test(repoLower)) return fail('SMOKE_REPO_INVALID', String(repo));
  const ttl = Number(ttlMs);
  if (!Number.isFinite(ttl) || ttl <= 0) return fail('SMOKE_TTL_INVALID', String(ttlMs));
  const ttlClamped = Math.min(ttl, SMOKE_MAX_TTL_MS);
  if (clientRequestId !== null && clientRequestId !== undefined
    && (typeof clientRequestId !== 'string' || clientRequestId.length < 8)) {
    return fail('SMOKE_REQUEST_ID_INVALID', 'clientRequestId must be a string >= 8 chars');
  }
  const now = Number(nowMs());
  if (!Number.isFinite(now)) return fail('SMOKE_TIME_INVALID', String(now));

  try { fs.mkdirSync(root, { recursive: true }); } catch (e) {
    return fail('SMOKE_ROOT_UNWRITABLE', String((e && e.message) || e));
  }

  // Claim-first idempotency (H4): exactly one canonical transaction per
  // clientRequestId across processes. Two separate index records:
  //   by-request/<key>.json           CLAIMING guard (wx-created, dropped when stale)
  //   by-request/<key>.committed.json canonical result (wx-created ONCE, never
  //                                   overwritten or renamed-over)
  // Readers resolve ONLY through the committed record, which is written after
  // the transaction commit point (valid meta.json) exists. The committed file
  // is create-exclusive so concurrent committers converge: the wx-loser adopts
  // the existing canonical record and removes its own unresolvable orphan
  // (no reader could ever have resolved it). On Windows, rename-over with
  // concurrent readers fails with EPERM — hence wx-only, never replace.
  // Legacy { smokeId }-only <key>.json files (Bước 1/6) read back as COMMITTED.
  let claimPath = null;
  let committedPath = null;
  let mineRaw = null;
  if (clientRequestId) {
    const claimKey = crypto.createHash('sha256').update(`smoke-request|v1|${clientRequestId}`, 'utf8').digest('hex');
    const idxDir = path.join(root, 'by-request');
    try { fs.mkdirSync(idxDir, { recursive: true }); } catch (e) {
      return fail('SMOKE_WRITE_FAILED', String((e && e.message) || e));
    }
    claimPath = path.join(idxDir, `${claimKey}.json`);
    committedPath = path.join(idxDir, `${claimKey}.committed.json`);
    let claimed = false;
    for (let round = 0; round < 2 && !claimed; round++) {
      const com = readCommitted(committedPath, claimPath);
      if (com.kind === 'COMMITTED') {
        const rm = readMeta(root, com.smokeId);
        if (rm.ok && !isExpired(rm.meta, now) && rm.meta.state !== 'CLOSED') {
          return { ok: true, value: txValue(root, rm.meta), idempotent: true };
        }
        // Canonical record is gone/expired/closed: drop it if untouched and
        // fall through to a fresh claim within the bounded retry.
        dropClaimIfUnchanged(com.path, com.raw);
        continue;
      }
      const claim = readClaim(claimPath, now);
      if (claim.kind === 'CLAIMING_FRESH') {
        return fail('SMOKE_REQUEST_IN_FLIGHT', `clientRequestId is being claimed by pid ${claim.claim.pid}`);
      }
      if (claim.kind === 'CLAIMING_STALE') dropClaimIfUnchanged(claimPath, claim.raw);
      const mine = {
        v: 1, status: 'CLAIMING', pid: process.pid, claimedAt: now,
        clientRequestId: String(clientRequestId).slice(0, 128),
      };
      mineRaw = JSON.stringify(mine);
      try {
        fs.writeFileSync(claimPath, mineRaw, { flag: 'wx', encoding: 'utf8' });
        claimed = true;
      } catch (e) {
        // Lost the claim race: one deterministic re-read, then fail closed.
        const com2 = readCommitted(committedPath, claimPath);
        if (com2.kind === 'COMMITTED') {
          const rm = readMeta(root, com2.smokeId);
          if (rm.ok && !isExpired(rm.meta, now) && rm.meta.state !== 'CLOSED') {
            return { ok: true, value: txValue(root, rm.meta), idempotent: true };
          }
        }
        return fail('SMOKE_REQUEST_IN_FLIGHT', `lost claim race for clientRequestId: ${String((e && e.message) || e)}`);
      }
    }
    if (!claimed) return fail('SMOKE_REQUEST_IN_FLIGHT', 'claim not acquired after retry');
  }

  // A: collision exit — releases our own claim (content-matched only) so an
  // immediate retry re-claims instead of wedging, then fails closed WITHOUT
  // touching any artifact that may belong to the winning sibling.
  const collisionOut = (detail) => {
    if (claimPath && mineRaw) dropClaimIfUnchanged(claimPath, mineRaw);
    return fail('SMOKE_ID_COLLISION', detail);
  };

  // Collision-safe identity: random reserved issue -> deterministic hash.
  let issue = 0;
  let h = null;
  let smokeId = null;
  let dir = null;
  let picked = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const cand = randInt(SMOKE_ISSUE_MIN, SMOKE_ISSUE_MAX, rand);
    const candH = identityHash({ repo: repoLower, issueNumber: cand });
    if (!candH) return fail('SMOKE_IDENTITY_UNSTABLE', `${repoLower}#${cand}`);
    const candId = `frs_${candH}`;
    const candDir = instanceDirFor(root, candId);
    if (fs.existsSync(candDir)) {
      const rm = readMeta(root, candId);
      if (rm.ok && !isExpired(rm.meta, now)) continue; // live: pick another
      // Expired/stale dir occupies the name: remove it if it is a genuine
      // smoke dir, then reuse is still avoided by picking again next loop.
      continue;
    }
    issue = cand; h = candH; smokeId = candId; dir = candDir;
    picked = true;
    break;
  }
  if (!picked) return collisionOut('no free reserved identity after 100 attempts');

  const pr = randInt(SMOKE_PR_MIN, SMOKE_PR_MAX, rand);
  const headSha = rand(20).toString('hex').toLowerCase();
  if (!HEAD_SHA_RE.test(headSha)) return fail('SMOKE_RANDOM_FAILED', 'headSha');
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + ttlClamped).toISOString();

  const report = {
    identity: {
      repository: repoLower,
      issue,
      pullRequest: pr,
      headSha,
      branch: `smoke/${smokeId}`,
      baseSha: '0'.repeat(40),
      prState: 'OPEN',
    },
    terminalStatus: { status: 'READY_FOR_REVIEW' },
    scope: { items: [{ purpose: SMOKE_PURPOSE, smokeId, note: 'SMOKE — NOT A DELIVERABLE; Final Review transport exercise only' }] },
    codeEvidence: { items: [{ smokeFixture: 'synthetic packet for Final Review transport smoke; no worktree, no commit, no PR' }] },
    findingResolution: { items: [{ note: 'no prior findings (smoke)' }] },
    tests: { items: [{ note: 'transport smoke only; no deterministic verification' }] },
    verification: { items: [{ deterministicVerify: 'NOT_APPLICABLE_SMOKE' }] },
    safety: { items: [{ invariant: 'smoke transaction holds zero production authority' }] },
    unverifiedRisks: { items: ['synthetic evidence; any verdict has no delivery meaning'] },
    delivery: { items: [{ smoke: 'no delivery; the pseudo-PR is not a real GitHub PR' }] },
  };

  // Production renderer, unchanged — the single trust-preserving reuse.
  // P0 two-pass: digest = canonical sha256 over the stamp-less rendering.
  const content0 = renderReviewReady(report, {});
  if (!content0.ok) return fail('SMOKE_RENDER_FAILED', JSON.stringify(content0.errors ?? null));
  const dg = computeSmokeDigest({ content: content0.content });
  if (!dg.ok) return dg;
  const requestDigest = dg.digest;
  const rendered = renderReviewReady(report, { digest: requestDigest });
  if (!rendered.ok) return fail('SMOKE_RENDER_FAILED', JSON.stringify(rendered.errors ?? null));

  const sessionsDir = path.join(dir, 'sessions');
  const packetDir = path.join(dir, 'review-ready');
  const ledgerDir = path.join(dir, 'control-loop', h);
  try {
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(packetDir, { recursive: true });
    fs.mkdirSync(ledgerDir, { recursive: true });
  } catch (e) {
    return fail('SMOKE_WRITE_FAILED', String((e && e.message) || e));
  }

  // Smoke session: passes the production LOCATION gate (so the production
  // evidence path accepts it) but carries zero authority fields.
  // A: exclusive creates — a concurrent sibling that picked the same
  // candidate collides here instead of overwriting our artifacts.
  const session = {
    schemaVersion: SESSION_SCHEMA_VERSION,
    repo: repoLower,
    issueNumber: issue,
    headSha,
    baseSha: '0'.repeat(40),
    prNumber: pr,
    state: 'READY_FOR_REVIEW',
    purpose: SMOKE_PURPOSE,
    smokeId,
    createdAt,
    expiresAt,
  };
  const sessionPath = path.join(sessionsDir, `${h}.json`);
  let w = exclusiveWriteFile(sessionPath, JSON.stringify(session, null, 2));
  if (!w.ok) return w.code === 'SMOKE_ID_COLLISION' ? collisionOut(`identity already owned: ${smokeId}`) : w;

  const packetPath = path.join(packetDir, rendered.filename);
  w = exclusiveWriteFile(packetPath, rendered.content);
  if (!w.ok) return w.code === 'SMOKE_ID_COLLISION' ? collisionOut(`identity already owned: ${smokeId}`) : w;

  const verify = readSessionRecord(sessionPath);
  if (!verify.ok) return fail('SMOKE_SESSION_NOT_CANONICAL', verify.reason ?? null);

  const ledgerPath = path.join(ledgerDir, 'transitions.jsonl');
  const records = [
    { ts: createdAt, from: null, to: 'CREATED', reason: `${SMOKE_PURPOSE} created`, identityHash: h, sessionPath, smokeId },
    { ts: createdAt, from: 'CREATED', to: 'REVIEW_READY', reason: 'smoke packet projected', identityHash: h, sessionPath, smokeId },
  ];
  try {
    fs.writeFileSync(ledgerPath, records.map((r) => JSON.stringify(r)).join('\n') + '\n', { flag: 'wx', encoding: 'utf8' });
  } catch (e) {
    return fail('SMOKE_ID_COLLISION', `ledger race: ${String((e && e.message) || e)}`);
  }

  const meta = {
    schemaVersion: SMOKE_SCHEMA_VERSION,
    purpose: SMOKE_PURPOSE,
    smokeId,
    identityHash: h,
    repository: repoLower,
    issue,
    pullRequest: pr,
    headSha,
    requestDigest,
    sessionPath,
    reviewReadyDir: packetDir,
    packetPath,
    ledgerPath,
    state: 'REVIEW_READY',
    createdAt,
    expiresAt,
    clientRequestId: clientRequestId ?? null,
  };
  w = exclusiveWriteFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  if (!w.ok) return w.code === 'SMOKE_ID_COLLISION' ? collisionOut(`identity already owned: ${smokeId}`) : w;

  if (committedPath) {
    // Commit AFTER the transaction commit point (valid meta.json) exists.
    // wx-only: a concurrent committer (stale-takeover race) converges here —
    // the loser adopts the existing canonical record and removes its own
    // orphan, which no reader could have resolved yet. A crash before this
    // leaves CLAIMING, taken over after SMOKE_CLAIM_STALE_MS — never poisoned.
    const record = {
      v: 1, smokeId, committedAt: new Date(now).toISOString(), pid: process.pid,
      clientRequestId: String(clientRequestId).slice(0, 128),
    };
    try {
      fs.writeFileSync(committedPath, JSON.stringify(record), { flag: 'wx', encoding: 'utf8' });
    } catch (e) {
      const com = readCommitted(committedPath, claimPath);
      if (com.kind === 'COMMITTED') {
        const rm = readMeta(root, com.smokeId);
        if (rm.ok && !isExpired(rm.meta, now) && rm.meta.state !== 'CLOSED') {
          try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* orphan best-effort */ }
          if (claimPath && mineRaw) dropClaimIfUnchanged(claimPath, mineRaw);
          return { ok: true, value: txValue(root, rm.meta), idempotent: true, adopted: true };
        }
      }
      return fail('SMOKE_COMMIT_CONFLICT', `committed record race lost: ${String((e && e.message) || e)}`);
    }
    // D: release our CLAIMING guard (content-matched only — never another
    // process's claim). The committed record is now the canonical source, so
    // an immediate re-create with the same key replays instead of wedging on
    // IN_FLIGHT, with no SMOKE_CLAIM_STALE_MS wait.
    if (claimPath && mineRaw) dropClaimIfUnchanged(claimPath, mineRaw);
  }

  return { ok: true, value: txValue(root, meta), idempotent: false };
}

// ---- claim helpers (H4) -----------------------------------------------------
// Committed record: dedicated <key>.committed.json wins; legacy bare
// { smokeId } (or v1 COMMITTED) in <key>.json still reads back as COMMITTED.
function readCommitted(committedPath, claimPath) {
  for (const p of [committedPath, claimPath]) {
    if (!p) continue;
    let raw;
    try { raw = fs.readFileSync(p, 'utf8'); } catch { continue; }
    let c;
    try { c = JSON.parse(raw); } catch { continue; }
    if (c && typeof c === 'object' && typeof c.smokeId === 'string'
      && (c.status === undefined || c.status === 'COMMITTED')
      && SMOKE_ID_RE.test(c.smokeId)) {
      return { kind: 'COMMITTED', smokeId: c.smokeId, raw, path: p };
    }
  }
  return { kind: 'ABSENT', raw: null, path: null };
}
function readClaim(claimPath, now) {
  const at = Number(now);
  let raw;
  try { raw = fs.readFileSync(claimPath, 'utf8'); } catch {
    return { kind: 'ABSENT', raw: null };
  }
  let c;
  try { c = JSON.parse(raw); } catch {
    return { kind: 'ABSENT', raw };
  }
  // Legacy Bước 1/6 index: bare { smokeId } == COMMITTED.
  if (c && typeof c === 'object' && typeof c.smokeId === 'string' && !c.status) {
    return SMOKE_ID_RE.test(c.smokeId)
      ? { kind: 'COMMITTED', smokeId: c.smokeId, raw }
      : { kind: 'ABSENT', raw };
  }
  if (!c || c.v !== 1 || typeof c.status !== 'string') return { kind: 'ABSENT', raw };
  if (c.status === 'COMMITTED' && SMOKE_ID_RE.test(c.smokeId)) {
    return { kind: 'COMMITTED', smokeId: c.smokeId, raw };
  }
  if (c.status === 'CLAIMING') {
    const age = Number(at) - Number(c.claimedAt);
    if (Number.isFinite(age) && age < SMOKE_CLAIM_STALE_MS) {
      return { kind: 'CLAIMING_FRESH', claim: c, raw };
    }
    return { kind: 'CLAIMING_STALE', claim: c, raw };
  }
  return { kind: 'ABSENT', raw };
}

function dropClaimIfUnchanged(claimPath, raw) {
  try {
    const cur = fs.readFileSync(claimPath, 'utf8');
    if (raw !== null && cur !== raw) return; // someone else moved it; hands off
    fs.unlinkSync(claimPath);
  } catch { /* best effort */ }
}

function txValue(root, meta) {
  return {
    smokeId: meta.smokeId,
    purpose: meta.purpose,
    sessionPath: meta.sessionPath,
    reviewReadyDir: meta.reviewReadyDir,
    packetPath: meta.packetPath,
    ledgerPath: meta.ledgerPath,
    binding: {
      repository: meta.repository,
      issue: meta.issue,
      pullRequest: meta.pullRequest,
      headSha: meta.headSha,
      requestDigest: meta.requestDigest,
    },
    state: meta.state,
    createdAt: meta.createdAt,
    expiresAt: meta.expiresAt,
  };
}

// ---- read (smoke-namespace only; production resolvers untouched) -------------
// Commit point (H2): a transaction exists IFF a valid meta.json exists. An
// instance dir, session file, packet or ledger WITHOUT valid meta is an
// uncommitted (interrupted) transaction and reads back as SMOKE_NOT_FOUND —
// the reader never accepts partial state, and per-file atomic renames are
// explicitly NOT treated as transaction atomicity.
export function readFinalReviewSmoke({ smokeRoot = defaultSmokeRoot(), smokeId, nowMs = () => Date.now() } = {}) {
  const root = path.resolve(smokeRoot);
  if (!SMOKE_ID_RE.test(String(smokeId))) return fail('SMOKE_ID_INVALID', String(smokeId));
  const rm = readMeta(root, smokeId);
  if (!rm.ok) return rm;
  const { meta, dir } = rm;
  const now = Number(nowMs());
  if (isExpired(meta, now)) return fail('SMOKE_EXPIRED', `${smokeId} expired at ${meta.expiresAt}`);
  if (meta.state === 'CLOSED') return fail('SMOKE_CLOSED', smokeId);

  // Production session-location gate: proves the smoke session satisfies the
  // canonical placement invariant (same check production evidence relies on).
  // H1: every path below is symlink-refused + realpath-contained first.
  for (const p of [meta.sessionPath, meta.reviewReadyDir]) {
    const sj = refuseSymlink(p);
    if (!sj.ok) return sj.code === 'SMOKE_NOT_FOUND' ? fail('SMOKE_SESSION_INVALID', p) : sj;
    const ri = assertRealInside(dir, p);
    if (!ri.ok) return ri;
  }
  const rs = readSessionRecord(meta.sessionPath);
  if (!rs.ok) return fail('SMOKE_SESSION_INVALID', rs.reason ?? null);
  const s = rs.session;
  if (s.purpose !== SMOKE_PURPOSE || s.smokeId !== smokeId) {
    return fail('SMOKE_PRODUCTION_MIX_REFUSED', 'session is not a smoke transaction');
  }
  if (s.repo !== meta.repository || Number(s.issueNumber) !== Number(meta.issue)
    || String(s.headSha).toLowerCase() !== String(meta.headSha).toLowerCase()
    || Number(s.prNumber) !== Number(meta.pullRequest)) {
    return fail('SMOKE_BINDING_MISMATCH', 'session drifted from smoke meta');
  }
  // Zero-authority structural check: a smoke session must never carry
  // production authority fields, even if a caller hand-edited the file.
  if ((s.lease && s.lease.token) || (s.controlLoop && s.controlLoop.terminalizeToken)
    || s.worktreePath || s.worktreesRoot) {
    return fail('SMOKE_AUTHORITY_CONTAMINATED', 'smoke session carries production authority fields');
  }

  // Smoke-scoped packet resolution: the PRODUCTION resolver, but rooted
  // explicitly at the smoke packet dir. Production callers never pass a
  // smoke dir, so no production lookup can fall into smoke storage.
  const pkt = packetPathForSmoke({ smokeRoot: root, smokeId, sessionPath: meta.sessionPath, reviewReadyDir: meta.reviewReadyDir });
  if (!pkt.ok) return pkt;
  const pj = refuseSymlink(pkt.packetPath);
  if (!pj.ok) return pj.code === 'SMOKE_NOT_FOUND' ? fail('SMOKE_EVIDENCE_UNREADABLE', pkt.packetPath) : pj;
  const pr = assertRealInside(dir, pkt.packetPath);
  if (!pr.ok) return pr;
  let raw;
  try { raw = fs.readFileSync(pkt.packetPath, 'utf8'); } catch {
    return fail('SMOKE_EVIDENCE_UNREADABLE', pkt.packetPath);
  }
  const ident = parsePacketIdentity(raw);
  if (!ident.ok) return fail('SMOKE_PACKET_IDENTITY_INVALID', ident.detail ?? null);
  if (String(ident.repository).toLowerCase() !== String(meta.repository).toLowerCase()
    || Number(ident.issue) !== Number(meta.issue)) {
    return fail('SMOKE_IDENTITY_MISMATCH', `packet=${ident.repository}#${ident.issue}`);
  }
  if (ident.headSha !== String(meta.headSha).toLowerCase()) {
    return fail('SMOKE_PACKET_STALE', `packet headSha=${ident.headSha}`);
  }
  const stamp = DIGEST_STAMP_RE.exec(raw);
  if (!stamp) return fail('SMOKE_DIGEST_MISSING', 'packet lacks reportDigest stamp');
  // P0 canonical verify via the SHARED verifier (single definition):
  // exactly one well-formed stamp, recomputed over full content.
  const dv = verifyPacketDigest(raw);
  if (!dv.ok) {
    return dv.code === 'REVIEW_PACKET_DIGEST_MISSING'
      ? fail('SMOKE_DIGEST_MISSING', dv.detail)
      : fail('SMOKE_DIGEST_MISMATCH', dv.detail);
  }
  if (dv.stampedDigest !== meta.requestDigest.toLowerCase()) {
    return fail('SMOKE_DIGEST_MISMATCH', `packet=${dv.stampedDigest} meta=${meta.requestDigest}`);
  }

  return { ok: true, value: txValue(root, meta) };
}

// Explicit smoke-namespace packet resolver. Asserts smoke purpose FIRST,
// then delegates selection to the production resolver with the smoke dir.
// H1: caller-supplied paths are symlink-refused + realpath-contained inside
// the instance dir before the production resolver ever sees them.
export function packetPathForSmoke({ smokeRoot = defaultSmokeRoot(), smokeId, sessionPath, reviewReadyDir } = {}) {
  const root = path.resolve(smokeRoot);
  if (!SMOKE_ID_RE.test(String(smokeId))) return fail('SMOKE_ID_INVALID', String(smokeId));
  const dir = instanceDirFor(root, smokeId);
  if (!assertInside(root, dir)) {
    return fail('SMOKE_PATH_ESCAPE', `${sessionPath} / ${reviewReadyDir}`);
  }
  for (const p of [sessionPath, reviewReadyDir]) {
    if (typeof p !== 'string' || !p) return fail('SMOKE_PATH_INVALID', String(p));
    const sj = refuseSymlink(path.resolve(p));
    if (!sj.ok) return sj.code === 'SMOKE_NOT_FOUND' ? fail('SMOKE_NOT_FOUND', String(p)) : sj;
    if (!assertInside(dir, path.resolve(p))) {
      return fail('SMOKE_PATH_ESCAPE', `${sessionPath} / ${reviewReadyDir}`);
    }
    const ri = assertRealInside(dir, path.resolve(p));
    if (!ri.ok) return ri;
  }
  const rm = readMeta(root, smokeId);
  if (!rm.ok) return rm;
  if (rm.meta.state === 'CLOSED') return fail('SMOKE_CLOSED', smokeId);
  const found = packetPathFor({ reviewReadyDir, sessionPath });
  if (!found.ok) {
    // Deterministic symlink refusal (H1): the production resolver skips
    // non-regular entries with platform-dependent Dirent semantics — a
    // planted packet-shaped symlink must still be an explicit refusal,
    // never a silent miss that looks like "no packet".
    try {
      for (const e of fs.readdirSync(reviewReadyDir, { withFileTypes: true })) {
        if (!/_review-ready\.md$/i.test(e.name)) continue;
        let st;
        try { st = fs.lstatSync(path.join(reviewReadyDir, e.name)); } catch { continue; }
        if (st.isSymbolicLink()) return fail('SMOKE_SYMLINK_REFUSED', e.name);
      }
    } catch { /* fall through to the resolver's verdict */ }
    return found;
  }
  return found;
}

// ---- lifecycle: review mark, close, cleanup ---------------------------------

// Cross-process lifecycle serialization (E): an OWNED lockdir is the
// filesystem CAS primitive (mkdir is atomic on all platforms). The directory
// carries an owner record; release verifies the token, so a late release by
// an old owner can never delete a takeover winner's lock. Stale locks
// (crashed holder) are taken over by atomic rename-to-quarantine — never an
// unconditional rmdir on the live path. In-process calls are already atomic
// (all fs ops below are synchronous); the lockdir additionally covers
// cross-process races. Never an in-memory instance-object lock.
export const SMOKE_LOCK_STALE_MS = 30000;

function lockPathFor(dir) {
  return path.join(dir, '.lifecycle.lock');
}

function ownerPathFor(dir) {
  return path.join(lockPathFor(dir), 'owner.json');
}

function readOwnerRecord(dir) {
  let raw;
  try { raw = fs.readFileSync(ownerPathFor(dir), 'utf8'); } catch {
    return { ok: false, code: 'SMOKE_LOCK_NO_OWNER' };
  }
  try {
    const rec = JSON.parse(raw);
    if (!rec || typeof rec.token !== 'string' || !rec.token) return { ok: false, code: 'SMOKE_LOCK_CORRUPT' };
    return { ok: true, owner: rec, raw };
  } catch {
    return { ok: false, code: 'SMOKE_LOCK_CORRUPT' };
  }
}

function lockAgeMs(dir) {
  // Same clock domain on both sides (OS wall clock): FS mtime vs Date.now.
  // Injected logical clocks are deliberately NOT used here — staleness is a
  // liveness question about the real world, and mixing domains misjudges it.
  const nowReal = Date.now();
  try {
    const st = fs.statSync(ownerPathFor(dir));
    return nowReal - Number(st.mtimeMs);
  } catch { /* owner missing: fall back to dir mtime */ }
  try {
    const st = fs.statSync(lockPathFor(dir));
    return nowReal - Number(st.mtimeMs);
  } catch {
    return NaN;
  }
}

export function acquireLifecycleLock(dir) {
  const lp = lockPathFor(dir);
  const token = randomUUID().replace(/-/g, '');
  const writeOwner = () => {
    try {
      fs.writeFileSync(ownerPathFor(dir), JSON.stringify({ token, pid: process.pid, at: Date.now() }), { flag: 'wx', encoding: 'utf8' });
      return { ok: true, token };
    } catch (e) {
      try { fs.rmdirSync(lp); } catch { /* best effort rollback */ }
      return fail('SMOKE_WRITE_FAILED', `lifecycle lock owner: ${String((e && e.message) || e)}`);
    }
  };
  // Bounded spin: holders finish in milliseconds; spin max ~2s, then BUSY.
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      fs.mkdirSync(lp);
    } catch (e) {
      if (!e || e.code !== 'EEXIST') {
        return fail('SMOKE_WRITE_FAILED', `lifecycle lock: ${String((e && e.message) || e)}`);
      }
      const age = lockAgeMs(dir);
      if (Number.isFinite(age) && age > SMOKE_LOCK_STALE_MS) {
        // Atomic takeover: quarantine the stale lock aside, then claim fresh.
        // A rival doing the same either wins the rename (we retry as BUSY
        // path) or loses it (rename throws → we retry).
        const q = `${lp}.quarantined-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
        try { fs.renameSync(lp, q); } catch { /* rival moved first */ }
        continue;
      }
      if (Date.now() >= deadline) return fail('SMOKE_LIFECYCLE_BUSY', 'lifecycle op in flight by another process');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      continue;
    }
    return writeOwner();
  }
}

export function releaseLifecycleLock(dir, token) {
  if (typeof token !== 'string' || !token) return fail('SMOKE_LOCK_NOT_OWNER', 'owner token required');
  const op = ownerPathFor(dir);
  let cur;
  try { cur = fs.readFileSync(op, 'utf8'); } catch {
    return { ok: true, released: false }; // already gone — idempotent
  }
  let rec;
  try { rec = JSON.parse(cur); } catch {
    return fail('SMOKE_LOCK_NOT_OWNER', 'owner record unreadable — refusing to delete a foreign lock');
  }
  if (!rec || rec.token !== token) {
    return fail('SMOKE_LOCK_NOT_OWNER', 'lock owned by another process — refusing to delete');
  }
  // Delete the owner record first: rmdir only removes empty directories.
  try { fs.unlinkSync(op); } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, released: false };
    return fail('SMOKE_WRITE_FAILED', `lifecycle lock release: ${String((e && e.message) || e)}`);
  }
  try { fs.rmdirSync(lockPathFor(dir)); } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, released: false };
    return fail('SMOKE_WRITE_FAILED', `lifecycle lock release: ${String((e && e.message) || e)}`);
  }
  return { ok: true, released: true };
}

// ---- C: ledger containment --------------------------------------------------
// Before EVERY append, the ledger path must be exactly the canonical
// <instanceDir>/control-loop/<identityHash>/transitions.jsonl, lexically and
// really inside the instance dir, with no symlinked/junction-escaped
// component, and an existing regular file (never a dir/link/device).
// A tampered ledgerPath fails closed; NOTHING is ever written outside.
function assertLedgerContained(dir, ledgerPath, identityHash) {
  const canonical = path.join(dir, 'control-loop', identityHash, 'transitions.jsonl');
  if (typeof ledgerPath !== 'string' || !ledgerPath) return fail('SMOKE_META_INVALID', 'ledgerPath missing');
  if (path.resolve(ledgerPath) !== canonical) {
    if (!assertInside(dir, path.resolve(ledgerPath))) {
      return fail('SMOKE_PATH_ESCAPE', `ledgerPath escapes instance dir: ${ledgerPath}`);
    }
    return fail('SMOKE_META_INVALID', `ledgerPath is not canonical: ${ledgerPath}`);
  }
  // Walk every component from the instance dir down: no symlinks, realpath
  // stays inside. Then the file itself: must exist, regular, not a link.
  let cur = path.resolve(dir);
  const target = path.resolve(ledgerPath);
  const rel = path.relative(cur, target);
  for (const part of rel.split(path.sep)) {
    cur = path.join(cur, part);
    const isLast = cur === target;
    let st;
    try { st = fs.lstatSync(cur); } catch {
      return fail('SMOKE_META_INVALID', `ledger path missing: ${cur}`);
    }
    if (st.isSymbolicLink()) return fail('SMOKE_SYMLINK_REFUSED', cur);
    if (!isLast && !st.isDirectory()) return fail('SMOKE_META_INVALID', `ledger parent not a directory: ${cur}`);
    const ri = assertRealInside(dir, cur);
    if (!ri.ok) return ri;
  }
  let fst;
  try { fst = fs.lstatSync(target); } catch {
    return fail('SMOKE_META_INVALID', 'ledger file missing');
  }
  if (fst.isSymbolicLink()) return fail('SMOKE_SYMLINK_REFUSED', target);
  if (!fst.isFile()) return fail('SMOKE_META_INVALID', 'ledger is not a regular file');
  return { ok: true };
}

function appendLedger(ledgerPath, record) {
  try {
    fs.appendFileSync(ledgerPath, JSON.stringify(record) + '\n', 'utf8');
    return { ok: true };
  } catch (e) {
    return fail('SMOKE_WRITE_FAILED', String((e && e.message) || e));
  }
}

// ---- C: WAL pending-transition + recovery ------------------------------------
// Every lifecycle mutation follows:
//   read state -> record intent -> append ledger exactly once -> update meta
//   -> finalize (remove intent)
// The intent carries a stable operationId embedded in the ledger record, so a
// retry/crash-recovery can never append the same transition twice. Recovery
// runs under the owned lock before any new decision:
//   - no/corrupt/malformed intent  -> discard (crash pre-mutation: clean)
//   - intent + ledger lacks opId   -> resume: append (same opId) + fix meta
//   - intent + ledger has opId     -> reconcile meta to intent.to, finalize
//   - meta already CLOSED          -> terminal wins: discard intent, refuse
function pendingPathFor(dir) {
  return path.join(dir, '.pending-transition.json');
}

function recoverPendingTransition({ root, smokeId, dir, meta }) {
  let raw;
  try { raw = fs.readFileSync(pendingPathFor(dir), 'utf8'); } catch {
    return { ok: true, recovered: false };
  }
  let intent;
  try { intent = JSON.parse(raw); } catch {
    try { fs.unlinkSync(pendingPathFor(dir)); } catch { /* best effort */ }
    return { ok: true, recovered: true, action: 'discarded-corrupt' };
  }
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)
    || typeof intent.operationId !== 'string' || !intent.operationId
    || typeof intent.to !== 'string' || !intent.to
    || typeof intent.ledgerRecord !== 'object' || !intent.ledgerRecord || Array.isArray(intent.ledgerRecord)
    || typeof intent.metaPatch !== 'object' || !intent.metaPatch || Array.isArray(intent.metaPatch)) {
    try { fs.unlinkSync(pendingPathFor(dir)); } catch { /* best effort */ }
    return { ok: true, recovered: true, action: 'discarded-malformed' };
  }
  if (meta.state === 'CLOSED') {
    try { fs.unlinkSync(pendingPathFor(dir)); } catch { /* best effort */ }
    return { ok: true, recovered: true, action: 'terminal-kept' };
  }
  let present = false;
  try {
    const text = fs.readFileSync(meta.ledgerPath, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        if (JSON.parse(line).operationId === intent.operationId) { present = true; break; }
      } catch { /* skip bad lines */ }
    }
  } catch { /* unreadable here; containment re-checks before any write */ }
  if (!present) {
    const contained = assertLedgerContained(dir, meta.ledgerPath, meta.identityHash);
    if (!contained.ok) return contained;
    const rec = { ...intent.ledgerRecord, operationId: intent.operationId };
    const a = appendLedger(meta.ledgerPath, rec);
    if (!a.ok) return a;
  }
  const back = readMeta(root, smokeId);
  if (!back.ok) return back;
  if (back.meta.state !== intent.to) {
    const u = updateMetaState(dir, back.meta, intent.metaPatch);
    if (!u.ok) return u;
  }
  try { fs.unlinkSync(pendingPathFor(dir)); } catch { /* next op retries finalize idempotently */ }
  return { ok: true, recovered: true, action: present ? 'reconciled' : 'resumed' };
}

function writePendingTransition(dir, intent) {
  return atomicWriteFile(pendingPathFor(dir), JSON.stringify(intent));
}

function finalizePendingTransition(dir) {
  try { fs.unlinkSync(pendingPathFor(dir)); } catch { /* next op retries idempotently */ }
}

function updateMetaState(dir, meta, patch) {
  const next = { ...meta, ...patch };
  const w = atomicWriteFile(path.join(dir, 'meta.json'), JSON.stringify(next, null, 2));
  if (!w.ok) return w;
  return { ok: true, meta: next };
}

export function markSmokeReviewed({ smokeRoot = defaultSmokeRoot(), smokeId, verdict = 'UNKNOWN', nowMs = () => Date.now() } = {}) {
  const root = path.resolve(smokeRoot);
  const rm = readMeta(root, smokeId);
  if (!rm.ok) return rm;
  const now = Number(nowMs());
  if (isExpired(rm.meta, now)) return fail('SMOKE_EXPIRED', smokeId);
  const lock = acquireLifecycleLock(rm.dir);
  if (!lock.ok) return lock;
  try {
    // WAL recovery first — even on CLOSED (finalizes orphaned intents so no
    // crash residue lingers) — then decide on the reconciled state.
    const rec = recoverPendingTransition({ root, smokeId, dir: rm.dir, meta: rm.meta });
    if (!rec.ok) return rec;
    // Re-read under lock: recovery or a concurrent writer may have moved state.
    const fresh = readMeta(root, smokeId);
    if (!fresh.ok) return fresh;
    if (fresh.meta.state === 'CLOSED') return fail('SMOKE_CLOSED', smokeId);
    // H3: strict transition table — REVIEWED is reachable ONLY from REVIEW_READY.
    if (fresh.meta.state !== 'REVIEW_READY' || !SMOKE_TRANSITIONS.REVIEW_READY.includes('REVIEWED')) {
      return fail('SMOKE_TRANSITION_REFUSED', `${fresh.meta.state} -> REVIEWED`);
    }
    const at = new Date(now).toISOString();
    const contained = assertLedgerContained(rm.dir, fresh.meta.ledgerPath, fresh.meta.identityHash);
    if (!contained.ok) return contained;
    const operationId = randomUUID().replace(/-/g, '');
    const ledgerRecord = {
      ts: at, from: 'REVIEW_READY', to: 'REVIEWED', reason: `smoke reviewed: ${String(verdict).slice(0, 32)}`,
      identityHash: fresh.meta.identityHash, sessionPath: fresh.meta.sessionPath, smokeId, operationId,
    };
    const metaPatch = { state: 'REVIEWED', reviewedAt: at, reviewVerdict: String(verdict).slice(0, 32) };
    const wIntent = writePendingTransition(rm.dir, {
      v: 1, operationId, op: 'mark', from: 'REVIEW_READY', to: 'REVIEWED', at, ledgerRecord, metaPatch, smokeId,
    });
    if (!wIntent.ok) return wIntent;
    const a = appendLedger(fresh.meta.ledgerPath, ledgerRecord);
    if (!a.ok) return a;
    const u = updateMetaState(rm.dir, fresh.meta, metaPatch);
    if (!u.ok) return u;
    finalizePendingTransition(rm.dir);
    return { ok: true, value: txValue(root, u.meta) };
  } finally {
    releaseLifecycleLock(rm.dir, lock.token);
  }
}

export function closeFinalReviewSmoke({ smokeRoot = defaultSmokeRoot(), smokeId, nowMs = () => Date.now() } = {}) {
  const root = path.resolve(smokeRoot);
  const rm = readMeta(root, smokeId);
  if (!rm.ok) return rm;
  const now = Number(nowMs());
  // H3: close-on-expired is defined as SMOKE_EXPIRED (fail-closed; the
  // cleanup pass owns removal). CLOSED→CLOSED stays idempotent.
  if (isExpired(rm.meta, now)) return fail('SMOKE_EXPIRED', `${smokeId} expired at ${rm.meta.expiresAt}`);
  const lock = acquireLifecycleLock(rm.dir);
  if (!lock.ok) return lock;
  try {
    // Recovery runs even on CLOSED so orphaned intents finalize instead of
    // lingering; the terminal state itself never moves.
    const rec = recoverPendingTransition({ root, smokeId, dir: rm.dir, meta: rm.meta });
    if (!rec.ok) return rec;
    const fresh = readMeta(root, smokeId);
    if (!fresh.ok) return fresh;
    if (fresh.meta.state === 'CLOSED') return { ok: true, value: txValue(root, fresh.meta), idempotent: true };
    if (!SMOKE_TRANSITIONS[fresh.meta.state] || !SMOKE_TRANSITIONS[fresh.meta.state].includes('CLOSED')) {
      return fail('SMOKE_TRANSITION_REFUSED', `${fresh.meta.state} -> CLOSED`);
    }
    const at = new Date(now).toISOString();
    const contained = assertLedgerContained(rm.dir, fresh.meta.ledgerPath, fresh.meta.identityHash);
    if (!contained.ok) return contained;
    const operationId = randomUUID().replace(/-/g, '');
    const ledgerRecord = {
      ts: at, from: fresh.meta.state, to: 'CLOSED', reason: 'smoke closed', identityHash: fresh.meta.identityHash,
      sessionPath: fresh.meta.sessionPath, smokeId, operationId,
    };
    const metaPatch = { state: 'CLOSED', closedAt: at };
    const wIntent = writePendingTransition(rm.dir, {
      v: 1, operationId, op: 'close', from: fresh.meta.state, to: 'CLOSED', at, ledgerRecord, metaPatch, smokeId,
    });
    if (!wIntent.ok) return wIntent;
    const a = appendLedger(fresh.meta.ledgerPath, ledgerRecord);
    if (!a.ok) return a;
    const u = updateMetaState(rm.dir, fresh.meta, metaPatch);
    if (!u.ok) return u;
    finalizePendingTransition(rm.dir);
    return { ok: true, value: txValue(root, u.meta) };
  } finally {
    releaseLifecycleLock(rm.dir, lock.token);
  }
}

// Cleanup removes ONLY expired smoke instance dirs below the smoke root.
// Production state/review-ready/control-loop/_decisions/merge-authorization
// are never traversed: every target is validated to (a) match the smoke id
// shape and (b) resolve inside the smoke root before removal.
export function cleanupFinalReviewSmokes({ smokeRoot = defaultSmokeRoot(), nowMs = () => Date.now() } = {}) {
  const root = path.resolve(smokeRoot);
  const now = Number(nowMs());
  const out = { ok: true, removed: [], kept: [], errors: [] };
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    if (e && e.code === 'ENOENT') return out;
    return { ok: false, code: 'SMOKE_CLEANUP_FAILED', detail: String((e && e.message) || e) };
  }
  for (const e of entries) {
    if (!SMOKE_ID_RE.test(e.name)) continue; // never touch by-request/ or foreign entries
    const dir = path.join(root, e.name);
    if (!assertInside(root, dir)) { out.errors.push(`escape: ${e.name}`); continue; }
    // H1: lstat FIRST (Dirent type flags are platform-dependent for
    // junctions) — never follow a symlinked instance dir, neither to read
    // through it nor to remove it. Non-directories are kept + reported.
    let lst;
    try { lst = fs.lstatSync(dir); } catch (err) { out.errors.push(`${e.name}: ${String((err && err.message) || err)}`); continue; }
    if (lst.isSymbolicLink()) { out.errors.push(`symlink refused, kept: ${e.name}`); out.kept.push(e.name); continue; }
    if (!lst.isDirectory()) { out.errors.push(`not a directory, kept: ${e.name}`); out.kept.push(e.name); continue; }
    // Real dirs get a realpath re-check (junctions that lstat as plain
    // directories still cannot escape: realpath must stay inside the root).
    const ri = assertRealInside(root, dir);
    if (!ri.ok) { out.errors.push(`realpath escape, kept: ${e.name}`); out.kept.push(e.name); continue; }
    const rm = readMeta(root, e.name);
    if (!rm.ok) {
      // Orphan smoke-shaped dir without valid meta: remove only when old
      // enough that no live creation race can own it (past max TTL by mtime).
      // Uses the lstat (no-follow) mtime taken above — never stat through a
      // link.
      try {
        if (now - Number(lst.mtimeMs) > SMOKE_MAX_TTL_MS + 60000) {
          fs.rmSync(dir, { recursive: true, force: true });
          out.removed.push(e.name);
        } else { out.kept.push(e.name); }
      } catch (err) { out.errors.push(`${e.name}: ${String((err && err.message) || err)}`); }
      continue;
    }
    if (isExpired(rm.meta, now)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        out.removed.push(e.name);
        try {
          if (rm.meta.clientRequestId) {
            const key = crypto.createHash('sha256').update(`smoke-request|v1|${rm.meta.clientRequestId}`, 'utf8').digest('hex');
            // Drop both index records (unlink removes a link, never a target).
            try { fs.unlinkSync(path.join(root, 'by-request', `${key}.json`)); } catch { /* already gone */ }
            try { fs.unlinkSync(path.join(root, 'by-request', `${key}.committed.json`)); } catch { /* already gone */ }
          }
        } catch { /* index cleanup best-effort */ }
      } catch (err) { out.errors.push(`${e.name}: ${String((err && err.message) || err)}`); }
    } else { out.kept.push(e.name); }
  }
  return out;
}
// end of final-review-smoke.mjs — no trailing marker.
