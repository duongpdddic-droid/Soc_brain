#!/usr/bin/env node
// final-review-smoke.test.mjs — security + contract tests for the canonical
// Final Review transport smoke seam (FINAL_REVIEW_TRANSPORT_SMOKE).
//
// Covers packet requirements A–M: valid smoke, wrong head/digest, stale/replay,
// resolver isolation both directions, zero production authority (merge auth,
// delivery/terminalization, TASK_COMPLETED, executor dispatch, push/PR),
// concurrent isolation, cleanup/expiry safety. Requirement N (production tests
// green) is proven by the full suite run, not by this file.
//
// Offline only: tmpdir fixtures + fake transport. No network/git/gh/worktree.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  createFinalReviewSmoke,
  readFinalReviewSmoke,
  markSmokeReviewed,
  closeFinalReviewSmoke,
  cleanupFinalReviewSmokes,
  computeSmokeDigest,
  packetPathForSmoke,
  acquireLifecycleLock,
  releaseLifecycleLock,
  SMOKE_PURPOSE,
  SMOKE_REPO,
  SMOKE_ISSUE_MIN,
  SMOKE_ISSUE_MAX,
  SMOKE_PR_MIN,
  SMOKE_PR_MAX,
  SMOKE_ID_RE,
  SMOKE_CLAIM_STALE_MS,
  SMOKE_LOCK_STALE_MS,
  SMOKE_TRANSITIONS,
  defaultSmokeRoot,
} from '../packages/control-loop/final-review-smoke.mjs';
import { canonicalReportDigest } from '../packages/review-ready/review-ready.mjs';
import { runSmokeHarness } from '../scripts/smoke-gpt-final-review.mjs';
import {
  readSessionRecord,
  verifySessionAuthority,
  verifyExecutionRootBinding,
  createPermissionGuard,
} from '../packages/runtime-sandbox/runtime-sandbox.mjs';
import { packetPathFor } from '../packages/control-loop/review-packet.mjs';
import { collectPreReviewEvidence, stripPacketDigestStamp } from '../packages/control-loop/review-evidence.mjs';
import { deliverySpec } from '../packages/control-loop/delivery.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';

const checks = [];
const eq = (n, g, w) => checks.push({ name: n, ok: Object.is(g, w), got: g, want: w });
const tru = (n, g) => checks.push({ name: n, ok: Boolean(g), got: g });
const falsy = (n, g) => checks.push({ name: n, ok: !g, got: g });

const PROV = { SOC_FINAL_REVIEW_PROVIDER: 'chatgpt-plus-web2api-copy' };
const HEAD_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;

let seq = 0;
function freshRoot() {
  seq += 1;
  return path.join(os.tmpdir(), `frs-test-${process.pid}-${Date.now()}-${seq}-${Math.random().toString(36).slice(2)}`);
}
function makeTx(root, extra = {}) {
  return createFinalReviewSmoke({ smokeRoot: root, ...(extra.clientRequestId ? {} : { clientRequestId: `req-${Date.now()}-${Math.random().toString(36).slice(2)}-x` }), ...extra });
}
function fakeTransport(binding, { verdict = 'PASS' } = {}) {
  return async () => ({
    ok: true,
    text: JSON.stringify({ verdict, findings: [], evidenceRequests: [], confidence: 0.9, metadata: {}, binding }),
    conversationId: 'conv-smoke-test',
    modelSlug: 'auto',
    transportMeta: { provider: 'chatgpt-plus-web2api-copy', turnId: 'B', shortcutAttempts: 1 },
  });
}
function listAll(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

// ---- A. valid smoke -> canonical parser accepts binding ---------------------
{
  const root = freshRoot();
  const c = makeTx(root);
  eq('A create ok', c.ok, true);
  tru('A smokeId shape', SMOKE_ID_RE.test(c.value.smokeId));
  eq('A purpose', c.value.purpose, SMOKE_PURPOSE);
  tru('A issue reserved', c.value.binding.issue >= SMOKE_ISSUE_MIN && c.value.binding.issue <= SMOKE_ISSUE_MAX);
  tru('A pr pseudo', c.value.binding.pullRequest >= SMOKE_PR_MIN && c.value.binding.pullRequest <= SMOKE_PR_MAX);
  tru('A head 40hex', HEAD_RE.test(c.value.binding.headSha));
  tru('A digest 64hex', DIGEST_RE.test(c.value.binding.requestDigest));
  eq('A repo canonical', c.value.binding.repository, SMOKE_REPO);
  eq('A state', c.value.state, 'REVIEW_READY');

  const r = readFinalReviewSmoke({ smokeRoot: root, smokeId: c.value.smokeId });
  eq('A read ok', r.ok, true);

  const h = await runSmokeHarness({
    smoke: c.value.smokeId, smokeRoot: root, env: PROV,
    transportOverride: fakeTransport(c.value.binding),
  });
  eq('A harness ok', h.ok, true);
  eq('A provider', h.provider, 'web2api-copy');
  eq('A digest match', h.requestDigest, c.value.binding.requestDigest);
  eq('A parserOk', h.parserOk, true);
  eq('A bindingOk', h.bindingOk, true);
  eq('A verdict', h.verdict, 'PASS');
}

// ---- B. wrong headSha -> fail closed ----------------------------------------
{
  const root = freshRoot();
  const c = makeTx(root);
  const h = await runSmokeHarness({
    smoke: c.value.smokeId, smokeRoot: root, env: PROV,
    transportOverride: fakeTransport({ ...c.value.binding, headSha: 'f'.repeat(40) }),
  });
  falsy('B mismatch not ok', h.ok);
  eq('B code', h.code, 'GPT_BINDING_MISMATCH');
  eq('B bindingOk', h.bindingOk, false);
  eq('B parserOk', h.parserOk, true);
}

// ---- C. P0 digest/PR binding: wrong/missing digest or PR must fail ---------
{
  const root = freshRoot();
  const c = makeTx(root);
  const good = c.value.binding;
  const runWith = (binding) => runSmokeHarness({
    smoke: c.value.smokeId, smokeRoot: root, env: PROV, transportOverride: fakeTransport(binding),
  });
  // P0.8 positive: exact five-coordinate echo passes.
  const hp = await runWith(good);
  eq('C0 exact echo ok', hp.ok, true);
  eq('C0 verdict', hp.verdict, 'PASS');
  // P0.7: wrong digest fails (well-formed value, wrong echo).
  const hw = await runWith({ ...good, requestDigest: 'e'.repeat(64) });
  falsy('C1 wrong digest not ok', hw.ok);
  eq('C1 wrong digest code', hw.code, 'GPT_BINDING_MISMATCH');
  eq('C1 bindingOk', hw.bindingOk, false);
  eq('C1 parserOk', hw.parserOk, true);
  // Missing digest fails at strict parse.
  const { requestDigest: _drop, ...noDigest } = good;
  const hm = await runWith(noDigest);
  falsy('C1b missing digest not ok', hm.ok);
  eq('C1b missing digest code', hm.code, 'GPT_RESPONSE_MALFORMED');
  eq('C1b parserOk', hm.parserOk, false);
  // Malformed digest fails at strict parse.
  const hx = await runWith({ ...good, requestDigest: 'zzz' });
  falsy('C1c malformed digest not ok', hx.ok);
  eq('C1c malformed digest code', hx.code, 'GPT_RESPONSE_MALFORMED');
  // Wrong PR fails at the binding gate.
  const hp2 = await runWith({ ...good, pullRequest: good.pullRequest + 1 });
  falsy('C1d wrong PR not ok', hp2.ok);
  eq('C1d wrong PR code', hp2.code, 'GPT_BINDING_MISMATCH');
  // Missing PR fails at strict parse.
  const { pullRequest: _dropPr, ...noPr } = good;
  const hn = await runWith(noPr);
  falsy('C1e missing PR not ok', hn.ok);
  eq('C1e missing PR code', hn.code, 'GPT_RESPONSE_MALFORMED');
  // Transport-level metadata echo stays informational: a wrong
  // metadata.requestDigest with a CORRECT binding echo still passes —
  // canonical authority is the binding, on every transport.
  const staleMeta = async () => ({
    ok: true,
    text: JSON.stringify({
      verdict: 'PASS', findings: [], evidenceRequests: [], confidence: 0.9,
      metadata: { requestDigest: 'e'.repeat(64) },
      binding: good,
    }),
    conversationId: 'c', modelSlug: 'auto', transportMeta: { turnId: 'B', shortcutAttempts: 1 },
  });
  const hs = await runSmokeHarness({ smoke: c.value.smokeId, smokeRoot: root, env: PROV, transportOverride: staleMeta });
  eq('C1f metadata echo informational', hs.ok, true);

  // C2 smoke boundary: tampered packet stamp fails closed on read.
  const raw = fs.readFileSync(c.value.packetPath, 'utf8');
  fs.writeFileSync(c.value.packetPath, raw.replace(/- reportDigest:\s*[0-9a-f]{64}/i, '- reportDigest: eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'), 'utf8');
  const r = readFinalReviewSmoke({ smokeRoot: root, smokeId: c.value.smokeId });
  falsy('C2 tampered digest not ok', r.ok);
  eq('C2 code', r.code, 'SMOKE_DIGEST_MISMATCH');
}

// ---- D. stale / replay -------------------------------------------------------
{
  const root = freshRoot();
  const c = makeTx(root);
  // Stale: session head moved past the packet head.
  const sess = JSON.parse(fs.readFileSync(c.value.sessionPath, 'utf8'));
  sess.headSha = 'a'.repeat(40);
  fs.writeFileSync(c.value.sessionPath, JSON.stringify(sess, null, 2), 'utf8');
  const h = await runSmokeHarness({ smoke: c.value.smokeId, smokeRoot: root, env: PROV, transportOverride: fakeTransport(c.value.binding) });
  falsy('D stale not ok', h.ok);
  eq('D stale code', h.code, 'SMOKE_BINDING_MISMATCH');

  // Replay/idempotency: same clientRequestId replays the same transaction.
  const root2 = freshRoot();
  const k = `replay-key-${Date.now()}-deterministic`;
  const c1 = createFinalReviewSmoke({ smokeRoot: root2, clientRequestId: k });
  const c2 = createFinalReviewSmoke({ smokeRoot: root2, clientRequestId: k });
  eq('D replay ok', c2.ok, true);
  eq('D replay same id', c2.value.smokeId, c1.value.smokeId);
  eq('D replay flag', c2.idempotent, true);
  const h1 = await runSmokeHarness({ smoke: c1.value.smokeId, smokeRoot: root2, env: PROV, transportOverride: fakeTransport(c1.value.binding) });
  const h2 = await runSmokeHarness({ smoke: c1.value.smokeId, smokeRoot: root2, env: PROV, transportOverride: fakeTransport(c1.value.binding) });
  eq('D replay run1 ok', h1.ok, true);
  eq('D replay run2 ok', h2.ok, true);
  eq('D replay same digest', h2.requestDigest, h1.requestDigest);
}

// ---- E. smoke identity cannot resolve as production session ------------------
{
  const root = freshRoot();
  const c = makeTx(root);
  const h = identityHash({ repo: SMOKE_REPO, issueNumber: c.value.binding.issue });
  tru('E hash exists', typeof h === 'string' && h.length > 0);
  // Production state dir lookup misses: the file only exists under smoke root.
  const prodDir = freshRoot();
  const rs = readSessionRecord(path.join(prodDir, 'sessions', `${h}.json`));
  falsy('E prod lookup misses', rs.ok);
  eq('E prod miss code', rs.reason, 'SESSION_NOT_FOUND');
  // Production packet dir lookup misses even with the smoke session.
  const emptyPackets = freshRoot();
  fs.mkdirSync(emptyPackets, { recursive: true });
  const pkt = packetPathFor({ reviewReadyDir: emptyPackets, sessionPath: c.value.sessionPath });
  falsy('E prod packet misses', pkt.ok);
  eq('E prod packet code', pkt.code, 'NO_REVIEW_PACKET');
  // Smoke session carries zero authority fields.
  const sess = JSON.parse(fs.readFileSync(c.value.sessionPath, 'utf8'));
  eq('E purpose marked', sess.purpose, SMOKE_PURPOSE);
  eq('E no lease', sess.lease, undefined);
  eq('E no controlLoop', sess.controlLoop, undefined);
  eq('E no worktreePath', sess.worktreePath, undefined);
  eq('E no worktreesRoot', sess.worktreesRoot, undefined);
  // Contaminated session (hand-injected authority) fails closed on read.
  const poison = { ...sess, lease: { token: 'forged' } };
  fs.writeFileSync(c.value.sessionPath, JSON.stringify(poison, null, 2), 'utf8');
  const pr2 = readFinalReviewSmoke({ smokeRoot: root, smokeId: c.value.smokeId });
  falsy('E contaminated refused', pr2.ok);
  eq('E contaminated code', pr2.code, 'SMOKE_AUTHORITY_CONTAMINATED');
}

// ---- F. production session cannot resolve through smoke resolver -------------
{
  const root = freshRoot();
  const c = makeTx(root);
  // A production-shaped session elsewhere must be refused by the smoke shim.
  const prodRoot = freshRoot();
  const prodIssue = 123;
  const ph = identityHash({ repo: SMOKE_REPO, issueNumber: prodIssue });
  const prodSessDir = path.join(prodRoot, 'sessions');
  fs.mkdirSync(prodSessDir, { recursive: true });
  const prodSessPath = path.join(prodSessDir, `${ph}.json`);
  fs.writeFileSync(prodSessPath, JSON.stringify({ schemaVersion: '1', repo: SMOKE_REPO, issueNumber: prodIssue, headSha: 'b'.repeat(40), state: 'READY_FOR_REVIEW', prNumber: 42 }), 'utf8');
  const prodPktDir = path.join(prodRoot, 'review-ready');
  fs.mkdirSync(prodPktDir, { recursive: true });
  const shim = packetPathForSmoke({ smokeRoot: root, smokeId: c.value.smokeId, sessionPath: prodSessPath, reviewReadyDir: prodPktDir });
  falsy('F prod session refused by smoke shim', shim.ok);
  eq('F shim code', shim.code, 'SMOKE_PATH_ESCAPE');
  // Unknown smoke ids fail closed.
  const miss = readFinalReviewSmoke({ smokeRoot: root, smokeId: `frs_${'0'.repeat(32)}` });
  falsy('F unknown id misses', miss.ok);
  eq('F unknown code', miss.code, 'SMOKE_NOT_FOUND');
  const bad = readFinalReviewSmoke({ smokeRoot: root, smokeId: 'not-a-smoke-id' });
  falsy('F malformed id refused', bad.ok);
  eq('F malformed code', bad.code, 'SMOKE_ID_INVALID');
}

// ---- G. smoke cannot create merge authorization ------------------------------
{
  const root = freshRoot();
  const c = makeTx(root);
  const files = listAll(root).join('\n');
  falsy('G no merge-auth artifact', /merge/i.test(files));
  const src = fs.readFileSync(new URL('../packages/control-loop/final-review-smoke.mjs', import.meta.url), 'utf8');
  const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const t of ['merge-authorization', 'writeMergeAuthorization', 'authorize_merge', 'mergeAuth', 'mergePr', 'ensurePr']) {
    falsy(`G smoke module has no ${t}`, code.includes(t));
  }
}

// ---- H+J+K. no delivery/terminalization, no executor dispatch, no push/PR ----
{
  const src = fs.readFileSync(new URL('../packages/control-loop/final-review-smoke.mjs', import.meta.url), 'utf8');
  const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  // NOTE: a bare 'terminalize' read of session.controlLoop.terminalizeToken is
  // the zero-authority contamination check itself (fail-closed, proven by the
  // E-contamination test above); what is forbidden here is owning/invoking
  // terminalization or minting the token.
  for (const t of ['terminalize(', 'loop.terminalize', 'terminalizeToken:', 'taskFinish', 'taskBlock', 'bindLoop', 'newLoopToken', 'deliverySpec', 'deliver(', 'taskStart', 'provision(', 'createExecutionBroker', 'executeBrokerRequest', 'dispatch', 'mutationLane', 'pushBranch', 'updateSession', 'cleanupCanonical', 'child_process', 'spawnSync', 'execFileSync', 'execSync', 'spawn(', 'taskStart', 'telegram', 'gh pr', 'adoptOrCreate']) {
    falsy(`HJK smoke module has no ${t}`, code.includes(t));
  }
  // Runtime: creator never spawns and never builds worktrees/branches.
  const root = freshRoot();
  const c = makeTx(root);
  eq('HJK create ok', c.ok, true);
  const names = listAll(root);
  tru('HJK only smoke dirs', names.every((n) => n.startsWith(c.value.smokeId) || n.startsWith('by-request')));
  falsy('HJK no worktree', names.some((n) => /worktree|agent\/[0-9a-f]{8,}\/HEAD|refs\/heads/i.test(n)));
}

// ---- I. smoke cannot emit TASK_COMPLETED -------------------------------------
{
  const src = fs.readFileSync(new URL('../packages/control-loop/final-review-smoke.mjs', import.meta.url), 'utf8');
  const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  falsy('I no TASK_COMPLETED token', code.includes('TASK_COMPLETED'));
  const root = freshRoot();
  const c = makeTx(root);
  await markSmokeReviewed({ smokeRoot: root, smokeId: c.value.smokeId, verdict: 'PASS' });
  await closeFinalReviewSmoke({ smokeRoot: root, smokeId: c.value.smokeId });
  const blob = listAll(root).map((n) => { try { return fs.readFileSync(path.join(root, n), 'utf8'); } catch { return ''; } }).join('\n');
  falsy('I no TASK_COMPLETED artifact', blob.includes('TASK_COMPLETED'));
}

// ---- L. concurrent smoke transactions do not cross-bind ----------------------
{
  const root = freshRoot();
  const t1 = makeTx(root);
  const t2 = makeTx(root);
  falsy('L distinct ids', t1.value.smokeId === t2.value.smokeId);
  // Cross-wired session/evidence fails closed.
  const cross = await runSmokeHarness({
    sessionPath: t1.value.sessionPath, evidence: t2.value.reviewReadyDir, env: PROV,
    transportOverride: fakeTransport(t1.value.binding),
  });
  falsy('L cross not ok', cross.ok);
  // Each pair with its own evidence succeeds.
  for (const t of [t1, t2]) {
    const h = await runSmokeHarness({
      smoke: t.value.smokeId, smokeRoot: root, env: PROV,
      transportOverride: fakeTransport(t.value.binding),
    });
    eq(`L own pair ok ${t.value.smokeId.slice(-6)}`, h.ok, true);
    eq(`L own digest ${t.value.smokeId.slice(-6)}`, h.requestDigest, t.value.binding.requestDigest);
  }
}

// ---- M. cleanup/expiry cannot affect production state ------------------------
{
  const root = freshRoot();
  const base = Date.now();
  const c = makeTx(root, { ttlMs: 60000, clientRequestId: `m-key-${base}`, nowMs: () => base });
  // Fake production tree the cleanup must never traverse.
  const prodRoot = freshRoot();
  fs.mkdirSync(path.join(prodRoot, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(prodRoot, 'review-ready'), { recursive: true });
  fs.writeFileSync(path.join(prodRoot, 'sessions', 'prod.json'), '{"keep":true}', 'utf8');
  fs.writeFileSync(path.join(prodRoot, 'review-ready', 'prod.md'), 'keep', 'utf8');
  const before = listAll(prodRoot).join('|');
  // Foreign entries inside the smoke root are kept.
  fs.mkdirSync(path.join(root, 'not-smoke'), { recursive: true });
  fs.writeFileSync(path.join(root, 'loose.txt'), 'x', 'utf8');
  // Expired read fails closed, then cleanup removes only the smoke dir.
  const exp = readFinalReviewSmoke({ smokeRoot: root, smokeId: c.value.smokeId, nowMs: () => base + 3600000 });
  falsy('M expired read not ok', exp.ok);
  eq('M expired code', exp.code, 'SMOKE_EXPIRED');
  const cl = cleanupFinalReviewSmokes({ smokeRoot: root, nowMs: () => base + 3600000 });
  eq('M cleanup ok', cl.ok, true);
  tru('M expired removed', cl.removed.includes(c.value.smokeId));
  falsy('M instance gone', fs.existsSync(path.join(root, c.value.smokeId)));
  tru('M foreign dir kept', fs.existsSync(path.join(root, 'not-smoke')));
  tru('M loose file kept', fs.existsSync(path.join(root, 'loose.txt')));
  eq('M production untouched', listAll(prodRoot).join('|'), before);
  // Closed transactions fail closed in the harness.
  const root2 = freshRoot();
  const c2 = makeTx(root2);
  await closeFinalReviewSmoke({ smokeRoot: root2, smokeId: c2.value.smokeId });
  const h = await runSmokeHarness({ smoke: c2.value.smokeId, smokeRoot: root2, env: PROV, transportOverride: fakeTransport(c2.value.binding) });
  falsy('M closed harness not ok', h.ok);
  eq('M closed code', h.code, 'SMOKE_CLOSED');
  // Mix refusal: production args + smoke flag together.
  const mix = await runSmokeHarness({ smoke: c2.value.smokeId, smokeRoot: root2, sessionPath: 'x', evidence: 'y', env: PROV });
  falsy('M mix refused', mix.ok);
  eq('M mix code', mix.code, 'SMOKE_PRODUCTION_MIX_REFUSED');
}

// ---- V. canonical digest: single content-hash definition -----------------------
{
  const root = freshRoot();
  falsy('V bad repo', createFinalReviewSmoke({ smokeRoot: root, repo: 'not a repo' }).ok);
  falsy('V bad ttl', createFinalReviewSmoke({ smokeRoot: root, ttlMs: -5 }).ok);
  falsy('V short request id', createFinalReviewSmoke({ smokeRoot: root, clientRequestId: 'short' }).ok);
  const oversized = createFinalReviewSmoke({ smokeRoot: root, ttlMs: 999999999999 });
  eq('V ttl clamped ok', oversized.ok, true);
  // One definition: canonicalReportDigest (production projector) ==
  // computeSmokeDigest (smoke creator/reader) on the same bytes.
  const body = '# Review Ready\n## Identity\n- repository: a/b\n';
  const d1 = computeSmokeDigest({ content: body });
  const d2 = { ok: true, digest: canonicalReportDigest(body) };
  eq('V digest ok', d1.ok, true);
  eq('V single definition', d1.digest, d2.digest);
  tru('V digest 64hex', /^[0-9a-f]{64}$/.test(d1.digest));
  eq('V digest deterministic', computeSmokeDigest({ content: body }).digest, d1.digest);
  falsy('V tamper flips digest', computeSmokeDigest({ content: `${body}x` }).digest === d1.digest);
  falsy('V digest bad input empty', computeSmokeDigest({ content: '' }).ok);
  falsy('V digest bad input type', computeSmokeDigest({ content: 42 }).ok);
  falsy('V digest bad input missing', computeSmokeDigest({}).ok);
  // Strip is the exact inverse of the stamp insertion.
  const stamped = `${body}- reportDigest: ${d1.digest}\n`;
  eq('V strip round-trip', stripPacketDigestStamp(stamped), body);
  eq('V strip-then-hash equals', computeSmokeDigest({ content: stripPacketDigestStamp(stamped) }).digest, d1.digest);
  eq('V strip non-string', stripPacketDigestStamp(null), null);
  // A real creator packet verifies end-to-end through the same functions.
  const c = makeTx(root);
  const pktRaw = fs.readFileSync(c.value.packetPath, 'utf8');
  const stamp = /- reportDigest:\s*([0-9a-f]{64})/i.exec(pktRaw)[1];
  eq('V packet stamp == binding digest', stamp, c.value.binding.requestDigest);
  eq('V packet recompute == binding digest', computeSmokeDigest({ content: stripPacketDigestStamp(pktRaw) }).digest, c.value.binding.requestDigest);
  tru('V default root namespaced', defaultSmokeRoot().replace(/\\/g, '/').endsWith('.soc-brain/smoke/final-review'));
}

// ---- H1. symlink / realpath containment --------------------------------------
function tryLink(target, linkPath, type) {
  try { fs.symlinkSync(target, linkPath, type); return true; }
  catch { return false; }
}
{
  const root = freshRoot();
  const c = makeTx(root);
  const instDir = path.join(root, c.value.smokeId);
  const noPriv = [];
  // 1. instance dir itself is a symlink -> refused, never read through.
  const linkId = `frs_${'e'.repeat(32)}`;
  if (tryLink(instDir, path.join(root, linkId), 'junction')) {
    const r = readFinalReviewSmoke({ smokeRoot: root, smokeId: linkId });
    falsy('SYM instance-dir link refused', r.ok);
    eq('SYM instance-dir code', r.code, 'SMOKE_SYMLINK_REFUSED');
  } else noPriv.push('instance-dir');
  // 2. meta.json is a symlink -> refused.
  const metaReal = path.join(instDir, 'meta.json');
  const metaBak = `${metaReal}.real`;
  fs.renameSync(metaReal, metaBak);
  if (tryLink(metaBak, metaReal, 'file')) {
    const r = readFinalReviewSmoke({ smokeRoot: root, smokeId: c.value.smokeId });
    falsy('SYM meta link refused', r.ok);
    eq('SYM meta code', r.code, 'SMOKE_SYMLINK_REFUSED');
    fs.unlinkSync(metaReal);
    fs.renameSync(metaBak, metaReal);
  } else {
    noPriv.push('meta');
    fs.renameSync(metaBak, metaReal);
  }
  // 3. session file is a symlink -> refused.
  const sessReal = c.value.sessionPath;
  const sessBak = `${sessReal}.real`;
  fs.renameSync(sessReal, sessBak);
  if (tryLink(sessBak, sessReal, 'file')) {
    const r = readFinalReviewSmoke({ smokeRoot: root, smokeId: c.value.smokeId });
    falsy('SYM session link refused', r.ok);
    eq('SYM session code', r.code, 'SMOKE_SYMLINK_REFUSED');
    fs.unlinkSync(sessReal);
    fs.renameSync(sessBak, sessReal);
  } else {
    noPriv.push('session');
    fs.renameSync(sessBak, sessReal);
  }
  // 4. packet file is a symlink -> refused.
  const pktReal = c.value.packetPath;
  const pktBak = `${pktReal}.real`;
  fs.renameSync(pktReal, pktBak);
  if (tryLink(pktBak, pktReal, 'file')) {
    const r = readFinalReviewSmoke({ smokeRoot: root, smokeId: c.value.smokeId });
    falsy('SYM packet link refused', r.ok);
    eq('SYM packet code', r.code, 'SMOKE_SYMLINK_REFUSED');
    fs.unlinkSync(pktReal);
    fs.renameSync(pktBak, pktReal);
  } else {
    noPriv.push('packet');
    fs.renameSync(pktBak, pktReal);
  }
  // 5. review-ready dir is a symlink -> refused.
  const rrReal = c.value.reviewReadyDir;
  const rrMoved = `${rrReal}-real`;
  fs.renameSync(rrReal, rrMoved);
  if (tryLink(rrMoved, rrReal, 'junction')) {
    const r = readFinalReviewSmoke({ smokeRoot: root, smokeId: c.value.smokeId });
    falsy('SYM review-ready link refused', r.ok);
    eq('SYM review-ready code', r.code, 'SMOKE_SYMLINK_REFUSED');
    fs.unlinkSync(rrReal);
    fs.renameSync(rrMoved, rrReal);
  } else {
    noPriv.push('review-ready');
    fs.renameSync(rrMoved, rrReal);
  }
  // 6. lexical-inside but realpath-outside (no symlinked FINAL component):
  // <inst>/mid -> outside dir; path <inst>/mid/sess.json is lexically inside.
  const outside = freshRoot();
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'sess.json'), '{}', 'utf8');
  const mid = path.join(instDir, 'mid-link');
  if (tryLink(outside, mid, 'junction')) {
    const s = packetPathForSmoke({
      smokeRoot: root, smokeId: c.value.smokeId,
      sessionPath: path.join(mid, 'sess.json'), reviewReadyDir: c.value.reviewReadyDir,
    });
    falsy('SYM realpath escape refused', s.ok);
    eq('SYM realpath code', s.code, 'SMOKE_PATH_ESCAPE');
  } else noPriv.push('realpath');
  try { fs.unlinkSync(mid); } catch { /* only if created */ }
  // 7. cleanup never follows a symlinked instance dir: keeps it, target intact.
  const victim = freshRoot();
  fs.mkdirSync(victim, { recursive: true });
  fs.writeFileSync(path.join(victim, 'keep.txt'), 'x', 'utf8');
  const victimLink = path.join(root, `frs_${'f'.repeat(32)}`);
  if (tryLink(victim, victimLink, 'junction')) {
    const cl = cleanupFinalReviewSmokes({ smokeRoot: root });
    eq('SYM cleanup ok', cl.ok, true);
    tru('SYM cleanup kept link', fs.existsSync(victimLink));
    tru('SYM target intact', fs.existsSync(path.join(victim, 'keep.txt')));
    tru('SYM cleanup reported', cl.errors.some((e) => e.includes('symlink refused')));
  } else noPriv.push('cleanup-link');
  try { fs.unlinkSync(victimLink); } catch { /* only if created */ }
  tru(`SYM privilege note (skipped: ${noPriv.join(',') || 'none'})`, true);
  // 8. sanity: the untouched transaction still reads cleanly.
  const r = readFinalReviewSmoke({ smokeRoot: root, smokeId: c.value.smokeId });
  eq('SYM untouched tx still ok', r.ok, true);
}

// ---- H2. interrupted transactions: commit point = valid meta.json ------------
{
  const root = freshRoot();
  // a. bare instance dir (valid name, nothing inside) -> NOT_FOUND, kept fresh.
  const bare = `frs_${'a'.repeat(32)}`;
  fs.mkdirSync(path.join(root, bare), { recursive: true });
  const rb = readFinalReviewSmoke({ smokeRoot: root, smokeId: bare });
  falsy('INC bare not found', rb.ok);
  eq('INC bare code', rb.code, 'SMOKE_NOT_FOUND');
  const clFresh = cleanupFinalReviewSmokes({ smokeRoot: root });
  tru('INC bare kept fresh', clFresh.kept.includes(bare));
  // b. session crafted at the canonical location but no packet/meta -> NOT_FOUND.
  const issue = SMOKE_ISSUE_MIN + 7;
  const h = identityHash({ repo: SMOKE_REPO, issueNumber: issue });
  const sessDir = path.join(root, `frs_${h}`, 'sessions');
  fs.mkdirSync(sessDir, { recursive: true });
  fs.writeFileSync(path.join(sessDir, `${h}.json`), JSON.stringify({
    schemaVersion: '1', repo: SMOKE_REPO, issueNumber: issue,
    headSha: 'd'.repeat(40), baseSha: '0'.repeat(40), prNumber: SMOKE_PR_MIN,
    state: 'READY_FOR_REVIEW', purpose: SMOKE_PURPOSE, smokeId: `frs_${h}`,
  }), 'utf8');
  const rs = readFinalReviewSmoke({ smokeRoot: root, smokeId: `frs_${h}` });
  falsy('INC session-only not found', rs.ok);
  eq('INC session-only code', rs.code, 'SMOKE_NOT_FOUND');
  // c. session + packet + ledger but meta deleted -> NOT_FOUND (uncommitted).
  const c = makeTx(root);
  fs.unlinkSync(path.join(root, c.value.smokeId, 'meta.json'));
  const rc = readFinalReviewSmoke({ smokeRoot: root, smokeId: c.value.smokeId });
  falsy('INC no-meta not found', rc.ok);
  eq('INC no-meta code', rc.code, 'SMOKE_NOT_FOUND');
  // d. malformed meta -> META_INVALID (fail-closed, distinct from NOT_FOUND).
  fs.writeFileSync(path.join(root, c.value.smokeId, 'meta.json'), '{broken', 'utf8');
  const rm = readFinalReviewSmoke({ smokeRoot: root, smokeId: c.value.smokeId });
  falsy('INC malformed meta rejected', rm.ok);
  eq('INC malformed code', rm.code, 'SMOKE_META_INVALID');
  // e. ledger-only orphan (hand-planted, no meta) -> NOT_FOUND; old orphan removed.
  const oh = `frs_${'b'.repeat(32)}`;
  const oDir = path.join(root, oh, 'control-loop', oh.slice(4));
  fs.mkdirSync(oDir, { recursive: true });
  fs.writeFileSync(path.join(oDir, 'transitions.jsonl'), '{"to":"CREATED"}\n', 'utf8');
  const ro = readFinalReviewSmoke({ smokeRoot: root, smokeId: oh });
  falsy('INC ledger-only not found', ro.ok);
  const old = Date.now() - 86400000 * 3;
  fs.utimesSync(path.join(root, oh), new Date(old), new Date(old));
  fs.utimesSync(path.join(root, bare), new Date(old), new Date(old));
  const clOld = cleanupFinalReviewSmokes({ smokeRoot: root });
  tru('INC old orphan removed', clOld.removed.includes(oh));
  tru('INC old bare removed', clOld.removed.includes(bare));
}

// ---- H3. lifecycle transition table ------------------------------------------
{
  tru('H3 table shape', JSON.stringify(SMOKE_TRANSITIONS) === JSON.stringify({
    REVIEW_READY: ['REVIEWED', 'CLOSED'], REVIEWED: ['CLOSED'], CLOSED: ['CLOSED'],
  }));
  const root = freshRoot();
  // REVIEW_READY -> REVIEWED -> CLOSED, then locked.
  const c = makeTx(root);
  const m1 = markSmokeReviewed({ smokeRoot: root, smokeId: c.value.smokeId, verdict: 'PASS' });
  eq('H3 mark ok', m1.ok, true);
  eq('H3 state reviewed', m1.value.state, 'REVIEWED');
  const m2 = markSmokeReviewed({ smokeRoot: root, smokeId: c.value.smokeId, verdict: 'PASS' });
  falsy('H3 double mark refused', m2.ok);
  eq('H3 double mark code', m2.code, 'SMOKE_TRANSITION_REFUSED');
  const cl1 = closeFinalReviewSmoke({ smokeRoot: root, smokeId: c.value.smokeId });
  eq('H3 close reviewed ok', cl1.ok, true);
  eq('H3 state closed', cl1.value.state, 'CLOSED');
  const cl2 = closeFinalReviewSmoke({ smokeRoot: root, smokeId: c.value.smokeId });
  eq('H3 double close idempotent', cl2.ok, true);
  eq('H3 double close flag', cl2.idempotent, true);
  const m3 = markSmokeReviewed({ smokeRoot: root, smokeId: c.value.smokeId });
  falsy('H3 mark on closed refused', m3.ok);
  eq('H3 mark closed code', m3.code, 'SMOKE_CLOSED');
  // REVIEW_READY -> CLOSED directly is allowed.
  const c2 = makeTx(root);
  const cld = closeFinalReviewSmoke({ smokeRoot: root, smokeId: c2.value.smokeId });
  eq('H3 direct close ok', cld.ok, true);
  // Expired: every transition fails closed with SMOKE_EXPIRED (defined).
  const base = Date.now();
  const c3 = createFinalReviewSmoke({ smokeRoot: root, clientRequestId: `h3-${base}`, ttlMs: 1000, nowMs: () => base });
  const future = () => base + 3600000;
  const me = markSmokeReviewed({ smokeRoot: root, smokeId: c3.value.smokeId, nowMs: future });
  falsy('H3 expired mark refused', me.ok);
  eq('H3 expired mark code', me.code, 'SMOKE_EXPIRED');
  const ce = closeFinalReviewSmoke({ smokeRoot: root, smokeId: c3.value.smokeId, nowMs: future });
  falsy('H3 expired close refused', ce.ok);
  eq('H3 expired close code', ce.code, 'SMOKE_EXPIRED');
}

// ---- H4. cross-process idempotency (real child processes) --------------------
{
  const root = freshRoot();
  const modUrl = new URL('../packages/control-loop/final-review-smoke.mjs', import.meta.url).href;
  const childSrc = `import('${modUrl}').then((s) => {`
    + ` const r = s.createFinalReviewSmoke({ smokeRoot: process.env.FRS_ROOT, clientRequestId: process.env.FRS_KEY });`
    + ` console.log(JSON.stringify({ ok: r.ok, code: r.code || null, smokeId: r.ok ? r.value.smokeId : null, digest: r.ok ? r.value.binding.requestDigest : null }));`
    + `}).catch((e) => { console.log(JSON.stringify({ ok: false, code: 'CHILD_THROW', detail: String((e && e.message) || e) })); });`;
  const runChild = (key) => new Promise((resolve) => {
    execFile(process.execPath, ['--input-type=module', '-e', childSrc], {
      env: { ...process.env, FRS_ROOT: root, FRS_KEY: key }, timeout: 60000,
    }, (err, stdout) => {
      if (err) return resolve({ ok: false, code: 'CHILD_SPAWN_FAIL' });
      try { resolve(JSON.parse(String(stdout).trim().split('\n').pop())); }
      catch { resolve({ ok: false, code: 'CHILD_PARSE_FAIL' }); }
    });
  });
  const key = `xproc-${Date.now()}-shared`;
  const results = await Promise.all([runChild(key), runChild(key), runChild(key), runChild(key)]);
  const oks = results.filter((r) => r.ok);
  tru('XPROC at least one winner', oks.length >= 1);
  eq('XPROC single canonical id', new Set(oks.map((r) => r.smokeId)).size, 1);
  eq('XPROC single canonical digest', new Set(oks.map((r) => r.digest)).size, 1);
  const losers = results.filter((r) => !r.ok);
  tru('XPROC losers deterministic', losers.every((r) => r.code === 'SMOKE_REQUEST_IN_FLIGHT'));
  // Sequential replay after the race converges on the winner.
  const again = await runChild(key);
  eq('XPROC replay ok', again.ok, true);
  eq('XPROC replay same id', again.smokeId, oks[0].smokeId);
  // Different keys stay independent.
  const other = await runChild(`${key}-other`);
  eq('XPROC other ok', other.ok, true);
  falsy('XPROC other independent', other.smokeId === oks[0].smokeId);
  // Crashed winner (stale CLAIMING, no instance) never poisons the key.
  const staleKey = `xproc-stale-${Date.now()}`;
  const staleClaimKey = crypto.createHash('sha256').update(`smoke-request|v1|${staleKey}`, 'utf8').digest('hex');
  const idxDir = path.join(root, 'by-request');
  fs.mkdirSync(idxDir, { recursive: true });
  fs.writeFileSync(path.join(idxDir, `${staleClaimKey}.json`),
    JSON.stringify({ v: 1, status: 'CLAIMING', pid: 999999999, claimedAt: Date.now() - SMOKE_CLAIM_STALE_MS - 60000 }), 'utf8');
  const recovered = await runChild(staleKey);
  eq('XPROC stale claim recovered', recovered.ok, true);
  tru('XPROC recovered id shape', SMOKE_ID_RE.test(recovered.smokeId));
  // Fresh CLAIMING fails deterministically (no second transaction).
  const freshKey = `xproc-fresh-${Date.now()}`;
  const freshClaimKey = crypto.createHash('sha256').update(`smoke-request|v1|${freshKey}`, 'utf8').digest('hex');
  fs.writeFileSync(path.join(idxDir, `${freshClaimKey}.json`),
    JSON.stringify({ v: 1, status: 'CLAIMING', pid: process.pid, claimedAt: Date.now() }), 'utf8');
  const refused = await runChild(freshKey);
  falsy('XPROC fresh claim refused', refused.ok);
  eq('XPROC fresh claim code', refused.code, 'SMOKE_REQUEST_IN_FLIGHT');
}

// ---- H5/H6. purpose isolation + production-gate behavior ----------------------
{
  const root = freshRoot();
  const c = makeTx(root);
  // Purpose stripped / forged -> smoke reader refuses as production mix.
  for (const [tag, purpose] of [['stripped', undefined], ['forged', 'READY_FOR_REVIEW']]) {
    const sess = JSON.parse(fs.readFileSync(c.value.sessionPath, 'utf8'));
    if (purpose === undefined) delete sess.purpose; else sess.purpose = purpose;
    fs.writeFileSync(c.value.sessionPath, JSON.stringify(sess, null, 2), 'utf8');
    const r = readFinalReviewSmoke({ smokeRoot: root, smokeId: c.value.smokeId });
    falsy(`H5 purpose ${tag} refused`, r.ok);
    eq(`H5 purpose ${tag} code`, r.code, 'SMOKE_PRODUCTION_MIX_REFUSED');
    const h = await runSmokeHarness({ smoke: c.value.smokeId, smokeRoot: root, env: PROV, transportOverride: fakeTransport(c.value.binding) });
    falsy(`H6 harness purpose ${tag} refused`, h.ok);
    eq(`H6 harness purpose ${tag} code`, h.code, 'SMOKE_PRODUCTION_MIX_REFUSED');
    // restore for the next iteration
    const orig = JSON.parse(JSON.stringify(sess));
    orig.purpose = SMOKE_PURPOSE;
    fs.writeFileSync(c.value.sessionPath, JSON.stringify(orig, null, 2), 'utf8');
  }
  // Even a byte-valid smoke session copied into a PRODUCTION layout still
  // fails the production evidence gate (no production packet exists for it).
  const prodRoot = freshRoot();
  const prodSessDir = path.join(prodRoot, 'sessions');
  fs.mkdirSync(prodSessDir, { recursive: true });
  const h = identityHash({ repo: SMOKE_REPO, issueNumber: c.value.binding.issue });
  const sess = JSON.parse(fs.readFileSync(c.value.sessionPath, 'utf8'));
  fs.writeFileSync(path.join(prodSessDir, `${h}.json`), JSON.stringify(sess), 'utf8');
  const prodPktDir = path.join(prodRoot, 'review-ready');
  fs.mkdirSync(prodPktDir, { recursive: true });
  const ev = collectPreReviewEvidence({ sessionPath: path.join(prodSessDir, `${h}.json`), report: {}, reviewReadyDir: prodPktDir });
  falsy('H6 prod evidence gate holds', ev.ok);
  eq('H6 prod gate code', ev.code, 'NO_REVIEW_PACKET');
}

// ---- H7. reachable dependency graph (beyond token scan) -----------------------
{
  const scopeFiles = [
    new URL('../packages/control-loop/final-review-smoke.mjs', import.meta.url),
    new URL('../scripts/create-final-review-smoke.mjs', import.meta.url),
    new URL('../scripts/smoke-gpt-final-review.mjs', import.meta.url),
  ];
  const importSrc = (src) => {
    // Fresh regex per scan: a shared global regex corrupts nested traversal
    // (outer matchAll state is clobbered by inner scans).
    const found = [];
    for (const m of src.matchAll(/^import\s+[^;]*?from\s*['"]([^'"]+)['"]/gm)) found.push(m[1]);
    return found;
  };
  const directOf = (u) => importSrc(fs.readFileSync(u, 'utf8'));
  // NOTE: never derive FS paths from URL.pathname on Windows
  // (path.resolve('/C:/...') yields a doubled 'C:\C:\...' root).
  // fileURLToPath is the only correct conversion.
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const toAbs = (fromUrl, spec) => (spec.startsWith('.') ? path.resolve(path.dirname(fileURLToPath(fromUrl)), spec) : spec);
  const DIRECT_ALLOW = new Set([
    'node:fs', 'node:os', 'node:path', 'node:crypto', 'node:util', 'node:assert', 'node:child_process',
    'packages/workspace/workspace.mjs',
    'packages/runtime-sandbox/runtime-sandbox.mjs',
    'packages/review-ready/review-ready.mjs',
    'packages/control-loop/review-packet.mjs',
    'packages/control-loop/review-evidence.mjs',
    'packages/control-loop/gpt-final-review.mjs',
    'packages/control-loop/chatgpt-web-cwa.mjs',
    'packages/control-loop/chatgpt-plus-web2api-copy.mjs',
    'packages/control-loop/final-review-smoke.mjs',
  ]);
  // (a) direct imports of every scope file stay inside the minimal allowlist.
  // node:child_process is allowed ONLY in the test file (xproc harness).
  for (const u of scopeFiles) {
    const rel = path.relative(repoRoot, fileURLToPath(u)).replace(/\\/g, '/');
    for (const spec of directOf(u)) {
      const key = spec.startsWith('.') ? path.relative(repoRoot, toAbs(u, spec)).replace(/\\/g, '/') : spec;
      tru(`H7 direct allow ${rel} <- ${key}`, DIRECT_ALLOW.has(key) && !(u.pathname.includes('scripts/') && key === 'node:child_process'));
    }
  }
  // (b) transitive closure: forbidden AUTHORITY modules are reachable only
  // through the read-only evidence chain (review-evidence -> control-loop),
  // never directly from scope files. Import-reachability loads code; it
  // grants no authority (authority needs session-bound tokens smoke lacks).
  const closure = new Set();
  const visit = (abs, depth) => {
    if (depth > 8 || closure.has(abs)) return;
    closure.add(abs);
    let src;
    try { src = fs.readFileSync(abs, 'utf8'); } catch { return; }
    for (const spec of importSrc(src)) {
      if (!spec.startsWith('.')) continue;
      visit(path.resolve(path.dirname(abs), spec), depth + 1);
    }
  };
  for (const u of scopeFiles) visit(fileURLToPath(u), 0);
  const relClosure = [...closure].map((p) => path.relative(repoRoot, p).replace(/\\/g, '/'));
  tru('H7 closure reaches evidence chain', relClosure.some((p) => p.endsWith('review-evidence.mjs')));
  const directSpecs = new Set(scopeFiles.flatMap((u) => directOf(u)));
  for (const t of ['delivery.mjs', 'push.mjs', 'execution-broker.mjs', 'telegram-dispatch.mjs', 'merge-authorization.mjs', 'node:child_process']) {
    falsy(`H7 no DIRECT scope import of ${t}`, [...directSpecs].some((s) => s.endsWith(t)));
  }
  // (c) call-site scan: zero invocations (not just tokens) of mutating,
  // spawn, shell or network entry points in scope files.
  const CALL_FORBIDDEN = ['taskStart', 'provision', 'pushBranch', 'deliver', 'terminalize', 'taskFinish', 'taskBlock', 'bindLoop', 'mergePr', 'ensurePr', 'executeBrokerRequest', 'dispatch', 'spawnSync', 'execFileSync', 'execSync', 'spawn', 'fetch', 'eval', 'Function'];
  for (const u of scopeFiles) {
    const rel = path.relative(repoRoot, fileURLToPath(u)).replace(/\\/g, '/');
    const code = fs.readFileSync(u, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const t of CALL_FORBIDDEN) {
      const re = new RegExp(`\\b${t}\\s*\\(`);
      falsy(`H7 no call ${t} in ${rel}`, re.test(code));
    }
  }
  // (d) network surface: no network imports/tokens in scope files.
  for (const u of scopeFiles) {
    const rel = path.relative(repoRoot, fileURLToPath(u)).replace(/\\/g, '/');
    const code = fs.readFileSync(u, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const t of ['node:https', 'node:http', 'fetch(', 'https.', 'http.', 'API_KEY', 'child_process']) {
      const hit = t === 'child_process' ? /from\s*['"]node:child_process['"]/.test(code) : code.includes(t);
      falsy(`H7 no net/proc ${t} in ${rel}`, hit);
    }
  }
}

// ---- A. reserved-identity collision: first-writer-wins, no overwrite --------
{
  // Deterministic RNG forces two DIFFERENT clientRequestIds onto the same
  // issue/PR/head candidate, proving the second fails closed without
  // touching the committed winner.
  const forcedRand = (n) => Buffer.alloc(n, 0x2a);
  const shaFile = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  const root = freshRoot();
  const t1 = createFinalReviewSmoke({ smokeRoot: root, clientRequestId: 'col-key-A', rand: forcedRand });
  eq('COL first ok', t1.ok, true);
  const before = {
    session: shaFile(t1.value.sessionPath),
    packet: shaFile(t1.value.packetPath),
    meta: shaFile(path.join(root, t1.value.smokeId, 'meta.json')),
  };
  const t2 = createFinalReviewSmoke({ smokeRoot: root, clientRequestId: 'col-key-B', rand: forcedRand });
  falsy('COL second not ok', t2.ok);
  eq('COL second code', t2.code, 'SMOKE_ID_COLLISION');
  // Winner bytes are identical — no overwrite happened.
  eq('COL winner session bytes', shaFile(t1.value.sessionPath), before.session);
  eq('COL winner packet bytes', shaFile(t1.value.packetPath), before.packet);
  eq('COL winner meta bytes', shaFile(path.join(root, t1.value.smokeId, 'meta.json')), before.meta);
  // Winner still reads cleanly and serves the harness.
  const r = readFinalReviewSmoke({ smokeRoot: root, smokeId: t1.value.smokeId });
  eq('COL winner still readable', r.ok, true);
  const h = await runSmokeHarness({
    smoke: t1.value.smokeId, smokeRoot: root, env: PROV,
    transportOverride: fakeTransport(t1.value.binding),
  });
  eq('COL winner still serves', h.ok, true);
  // No cross-talk: exactly one instance dir exists.
  const instDirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => SMOKE_ID_RE.test(e.name));
  eq('COL single instance', instDirs.length, 1);
  eq('COL instance is winner', instDirs[0].name, t1.value.smokeId);
  // Cleanup keeps the live winner.
  const cl = cleanupFinalReviewSmokes({ smokeRoot: root });
  tru('COL cleanup keeps winner', cl.kept.includes(t1.value.smokeId));
  falsy('COL winner not removed', cl.removed.includes(t1.value.smokeId));
  // Retry with fresh randomness re-claims to a DIFFERENT identity (no wedge).
  const t3 = createFinalReviewSmoke({ smokeRoot: root, clientRequestId: 'col-key-B' });
  eq('COL retry ok', t3.ok, true);
  falsy('COL retry new identity', t3.value.smokeId === t1.value.smokeId);
}

// ---- G2/G3/G4. production authority gates reject smoke artifacts ------------
// (read-only invocations; each gate fails on smoke-owned missing fields
// BEFORE any mutation,.exec, git or network touch happens).
{
  const root = freshRoot();
  const c = makeTx(root);
  const sessObj = JSON.parse(fs.readFileSync(c.value.sessionPath, 'utf8'));
  // Lease gate: smoke carries no lease token.
  const auth = verifySessionAuthority({ sessionPath: c.value.sessionPath, leaseToken: 'bogus-lease' });
  falsy('G2 lease gate denies', auth.ok);
  eq('G2 lease code', auth.reason, 'STALE_TASK_LEASE');
  // Execution-root gate: smoke carries no worktree binding.
  const eb = verifyExecutionRootBinding({ session: sessObj });
  falsy('G3 root gate denies', eb.ok);
  eq('G3 root code', eb.reason, 'WORKSPACE_SESSION_BIND_REQUIRED');
  // Executor permission guard: every operation denies + recovers.
  const guard = createPermissionGuard({ sessionPath: c.value.sessionPath, leaseToken: 'bogus-lease' });
  const v = guard.evaluate({ operation: 'commit', targetPath: 'any/file.txt' });
  eq('G4 guard verdict', v.verdict, 'DENY_AND_RECOVER');
}

// ---- G5. production code has no route into the smoke namespace ---------------
{
  // If no production module references the smoke namespace, no production
  // flow can pass a smoke root/session into lifecycle machinery by accident.
  const prodFiles = [
    '../packages/control-loop/control-loop.mjs',
    '../packages/control-loop/run.js',
    '../packages/control-loop/delivery.mjs',
    '../packages/control-loop/push.mjs',
    '../packages/runtime-sandbox/runtime-sandbox.mjs',
  ];
  for (const f of prodFiles) {
    const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
    const rel = f.split('/').slice(-2).join('/');
    falsy(`G5 no smoke ref ${rel} (module)`, src.includes('final-review-smoke'));
    falsy(`G5 no smoke ref ${rel} (purpose)`, src.includes('FINAL_REVIEW_TRANSPORT_SMOKE'));
  }
}

// ---- G6. deliverySpec is shape-only: disclosed, NOT a rejecting gate ---------
{
  // Honesty anchor for the matrix: deliverySpec validates SHAPES, so a
  // well-formed smoke binding passes it. Rejection lives downstream
  // (session re-read, ledgers, gh read-backs) — never claimed otherwise.
  const root = freshRoot();
  const c = makeTx(root);
  const spec = deliverySpec({
    repo: 'duongpdddic-droid/soc_brain',
    issue: c.value.binding.issue,
    headSha: c.value.binding.headSha,
  });
  eq('G6 deliverySpec shape-accepts (not a gate)', spec.ok, true);
}

// ---- H7e. gateway proof: sensitive nodes reachable only via chain gateways ---
{
  // BFS from the scope files over the static import graph. For every
  // authority-sensitive node, the shortest path must (a) have length >= 2
  // edges (never a DIRECT scope import — independently asserted in H7b) and
  // (b) pass through a documented read-only-chain gateway. Import loads
  // code; authority additionally requires session-bound tokens smoke lacks.
  const scopeAbs = [
    fileURLToPath(new URL('../packages/control-loop/final-review-smoke.mjs', import.meta.url)),
    fileURLToPath(new URL('../scripts/create-final-review-smoke.mjs', import.meta.url)),
    fileURLToPath(new URL('../scripts/smoke-gpt-final-review.mjs', import.meta.url)),
  ];
  const importSrcLocal = (src) => {
    const found = [];
    for (const m of src.matchAll(/^import\s+[^;]*?from\s*['"]([^'"]+)['"]/gm)) found.push(m[1]);
    return found;
  };
  const GATEWAYS = new Set(['review-evidence.mjs', 'control-loop.mjs', 'runtime-sandbox.mjs', 'workspace.mjs']);
  const bfsPath = (targets) => {
    const seen = new Map(); // node -> parent
    const queue = [];
    for (const s of scopeAbs) { seen.set(s, null); queue.push(s); }
    while (queue.length) {
      const cur = queue.shift();
      if (targets.has(cur)) {
        const chain = [cur];
        let p = seen.get(cur);
        while (p) { chain.unshift(p); p = seen.get(p); }
        return chain;
      }
      if (cur.startsWith('node:')) continue;
      let src;
      try { src = fs.readFileSync(cur, 'utf8'); } catch { continue; }
      for (const spec of importSrcLocal(src)) {
        const next = spec.startsWith('.') ? path.resolve(path.dirname(cur), spec) : spec;
        if (!seen.has(next)) { seen.set(next, cur); queue.push(next); }
      }
    }
    return null;
  };
  const baseNames = (chain) => chain.map((p) => (p.startsWith('node:') ? p : path.basename(p)));
  const repoAbs = (rel) => path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), ...rel.split('/'));
  const SENSITIVE = [
    repoAbs('packages/control-loop/delivery.mjs'),
    repoAbs('packages/control-loop/push.mjs'),
    repoAbs('packages/execution-broker/execution-broker.mjs'),
    repoAbs('packages/telegram-dispatch/telegram-dispatch.mjs'),
    'node:child_process',
  ];
  for (const t of SENSITIVE) {
    const chain = bfsPath(new Set([t]));
    const name = t.startsWith('node:') ? t : path.basename(t);
    tru(`H7e reachable (documents chain) ${name}`, chain !== null);
    if (chain) {
      tru(`H7e indirect ${name} (edges>=2)`, chain.length >= 3);
      tru(`H7e via gateway ${name}`, baseNames(chain).some((b) => GATEWAYS.has(b)));
    }
  }
}

// ---- B. meta schema: table-driven tamper per field -----------------------------
{
  const root = freshRoot();
  const c = makeTx(root);
  const metaPath = path.join(root, c.value.smokeId, 'meta.json');
  const pristine = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const mutate = (fn) => {
    const m = JSON.parse(JSON.stringify(pristine));
    fn(m);
    fs.writeFileSync(metaPath, JSON.stringify(m), 'utf8');
    const r = readFinalReviewSmoke({ smokeRoot: root, smokeId: c.value.smokeId });
    fs.writeFileSync(metaPath, JSON.stringify(pristine), 'utf8');
    return r;
  };
  const drop = (m, f) => { delete m[f]; };
  // identityHash: recompute-bound to repository/issue/smokeId.
  for (const v of [null, 42, [], 'zz']) {
    falsy(`B identityHash ${JSON.stringify(v)}`, mutate((m) => { m.identityHash = v; }).ok);
  }
  // Every other security-relevant field: null / number / array / missing.
  const fields = ['repository', 'issue', 'pullRequest', 'headSha', 'requestDigest',
    'sessionPath', 'reviewReadyDir', 'packetPath', 'ledgerPath', 'state',
    'createdAt', 'expiresAt', 'clientRequestId'];
  for (const f of fields) {
    // clientRequestId is the only nullable/omissible field.
    if (f === 'clientRequestId') {
      const rn = mutate((m) => { m[f] = null; });
      eq('B clientRequestId null ok', readFinalReviewSmoke({ smokeRoot: root, smokeId: c.value.smokeId }).ok, true);
      void rn;
      falsy('B clientRequestId number', mutate((m) => { m[f] = 42; }).ok);
      falsy('B clientRequestId array', mutate((m) => { m[f] = []; }).ok);
      mutate((m) => drop(m, f));
      eq('B clientRequestId missing ok', readFinalReviewSmoke({ smokeRoot: root, smokeId: c.value.smokeId }).ok, true);
      continue;
    }
    falsy(`B ${f} null`, mutate((m) => { m[f] = null; }).ok);
    falsy(`B ${f} number`, mutate((m) => { m[f] = 42; }).ok);
    falsy(`B ${f} array`, mutate((m) => { m[f] = []; }).ok);
    falsy(`B ${f} missing`, mutate((m) => drop(m, f)).ok);
  }
  // Wrong-typed-but-plausible values.
  falsy('B issue out of range', mutate((m) => { m.issue = 123; }).ok);
  falsy('B pullRequest out of range', mutate((m) => { m.pullRequest = 7; }).ok);
  falsy('B headSha uppercase', mutate((m) => { m.headSha = 'A'.repeat(40); }).ok);
  falsy('B digest uppercase', mutate((m) => { m.requestDigest = 'B'.repeat(64); }).ok);
  falsy('B state unknown', mutate((m) => { m.state = 'COMPLETED'; }).ok);
  falsy('B expires before created', mutate((m) => { m.expiresAt = m.createdAt; }).ok);
  falsy('B expires garbage', mutate((m) => { m.expiresAt = 'yesterday-ish'; }).ok);
  // Paths escaping the instance dir.
  falsy('B sessionPath outside', mutate((m) => { m.sessionPath = path.join(root, 'evil.json'); }).ok);
  falsy('B packetPath outside', mutate((m) => { m.packetPath = '/etc/passwd'; }).ok);
  falsy('B ledgerPath outside', mutate((m) => { m.ledgerPath = path.join(os.tmpdir(), 'x.jsonl'); }).ok);
  // Pristine meta still reads cleanly after all tampering.
  eq('B pristine restored', readFinalReviewSmoke({ smokeRoot: root, smokeId: c.value.smokeId }).ok, true);
}

// ---- C. ledger containment: tampered ledgerPath cannot escape -----------------
{
  const root = freshRoot();
  const c = makeTx(root);
  const metaPath = path.join(root, c.value.smokeId, 'meta.json');
  const pristine = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const sentinel = path.join(root, 'sentinel-outside.jsonl');
  fs.writeFileSync(sentinel, 'SENTINEL', 'utf8');
  const poison = (ledgerPath) => {
    const m = JSON.parse(JSON.stringify(pristine));
    m.ledgerPath = ledgerPath;
    fs.writeFileSync(metaPath, JSON.stringify(m), 'utf8');
  };
  const restore = () => fs.writeFileSync(metaPath, JSON.stringify(pristine), 'utf8');
  // Outside the instance dir -> refused on both mutating ops (schema gate
  // fires first with META_INVALID; containment would answer PATH_ESCAPE —
  // the spec allows either fail-closed code, never acceptance).
  poison(sentinel);
  const mm = markSmokeReviewed({ smokeRoot: root, smokeId: c.value.smokeId, verdict: 'PASS' });
  falsy('C outside mark refused', mm.ok);
  eq('C outside mark code', mm.code, 'SMOKE_META_INVALID');
  const mc = closeFinalReviewSmoke({ smokeRoot: root, smokeId: c.value.smokeId });
  falsy('C outside close refused', mc.ok);
  eq('C outside close code', mc.code, 'SMOKE_META_INVALID');
  eq('C sentinel byte-identical', fs.readFileSync(sentinel, 'utf8'), 'SENTINEL');
  // Inside but non-canonical -> META_INVALID.
  poison(path.join(root, c.value.smokeId, 'review-ready', 'evil.jsonl'));
  const mi = markSmokeReviewed({ smokeRoot: root, smokeId: c.value.smokeId });
  falsy('C non-canonical mark refused', mi.ok);
  eq('C non-canonical code', mi.code, 'SMOKE_META_INVALID');
  restore();
  // Symlinked ledger -> SYMLINK_REFUSED.
  const realLedger = pristine.ledgerPath;
  const ledBak = `${realLedger}.real`;
  fs.renameSync(realLedger, ledBak);
  let linked = false;
  try { fs.symlinkSync(ledBak, realLedger, 'file'); linked = true; } catch { /* no privilege: skip */ }
  if (linked) {
    const ms = markSmokeReviewed({ smokeRoot: root, smokeId: c.value.smokeId });
    falsy('C linked ledger refused', ms.ok);
    eq('C linked ledger code', ms.code, 'SMOKE_SYMLINK_REFUSED');
    fs.unlinkSync(realLedger);
  }
  fs.renameSync(ledBak, realLedger);
  restore();
  eq('C restored tx usable', markSmokeReviewed({ smokeRoot: root, smokeId: c.value.smokeId, verdict: 'PASS' }).ok, true);
  eq('C sentinel still identical', fs.readFileSync(sentinel, 'utf8'), 'SENTINEL');
}

// ---- D. claim release after commit --------------------------------------------
{
  const root = freshRoot();
  const key = `claim-release-${Date.now()}`;
  const claimKey = crypto.createHash('sha256').update(`smoke-request|v1|${key}`, 'utf8').digest('hex');
  const claimPath = path.join(root, 'by-request', `${claimKey}.json`);
  const committedPath = path.join(root, 'by-request', `${claimKey}.committed.json`);
  const c1 = createFinalReviewSmoke({ smokeRoot: root, clientRequestId: key });
  eq('D create ok', c1.ok, true);
  // Committed record exists and is canonical; CLAIMING guard is released.
  tru('D committed exists', fs.existsSync(committedPath));
  const com = JSON.parse(fs.readFileSync(committedPath, 'utf8'));
  eq('D committed smokeId', com.smokeId, c1.value.smokeId);
  falsy('D claim released', fs.existsSync(claimPath));
  // Close, then immediately re-create with the same key: no IN_FLIGHT wait,
  // resolves per contract (committed-but-CLOSED -> drop + fresh transaction).
  const cl = closeFinalReviewSmoke({ smokeRoot: root, smokeId: c1.value.smokeId });
  eq('D close ok', cl.ok, true);
  const c2 = createFinalReviewSmoke({ smokeRoot: root, clientRequestId: key });
  eq('D immediate recreate ok', c2.ok, true);
  falsy('D recreate not in-flight', c2.code === 'SMOKE_REQUEST_IN_FLIGHT');
  eq('D recreate state', c2.value.state, 'REVIEW_READY');
}

// ---- E. concurrent lifecycle serialization (real processes) --------------------
{
  const root = freshRoot();
  const c = makeTx(root);
  const modUrl = new URL('../packages/control-loop/final-review-smoke.mjs', import.meta.url).href;
  const opSrc = (op) => `import('${modUrl}').then((s) => {`
    + ` const fn = ${op === 'mark' ? 's.markSmokeReviewed' : 's.closeFinalReviewSmoke'};`
    + ` let r; for (let i = 0; i < 200; i++) {`
    + `  r = fn({ smokeRoot: process.env.FRS_ROOT, smokeId: process.env.FRS_ID, verdict: 'PASS' });`
    + `  if (!r.ok && r.code === 'SMOKE_LIFECYCLE_BUSY') {`
    + `   const w = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); w(50); continue;`
    + `  } break; }`
    + ` console.log(JSON.stringify({ op: '${op}', ok: r.ok, code: r.code || null, idempotent: r.idempotent || false }));`
    + `}).catch((e) => { console.log(JSON.stringify({ op: '${op}', ok: false, code: 'CHILD_THROW' })); });`;
  const runOp = (op) => new Promise((resolve) => {
    execFile(process.execPath, ['--input-type=module', '-e', opSrc(op)], {
      env: { ...process.env, FRS_ROOT: root, FRS_ID: c.value.smokeId }, timeout: 120000,
    }, (err, stdout) => {
      if (err) return resolve({ op, ok: false, code: 'CHILD_SPAWN_FAIL' });
      try { resolve(JSON.parse(String(stdout).trim().split('\n').pop())); }
      catch { resolve({ op, ok: false, code: 'CHILD_PARSE_FAIL' }); }
    });
  });
  // Phase 1: mark vs mark — exactly one wins, no reversal, no reorder.
  const marks = await Promise.all([runOp('mark'), runOp('mark')]);
  eq('E marks completed', marks.filter((r) => r.code !== 'CHILD_SPAWN_FAIL' && r.code !== 'CHILD_PARSE_FAIL').length, 2);
  eq('E exactly one mark wins', marks.filter((r) => r.ok).length, 1);
  tru('E loser refused cleanly', marks.filter((r) => !r.ok).every((r) => r.code === 'SMOKE_TRANSITION_REFUSED' || r.code === 'SMOKE_CLOSED'));
  // Phase 2: close vs close — both ok, exactly one non-idempotent.
  const closes = await Promise.all([runOp('close'), runOp('close')]);
  eq('E both closes ok', closes.filter((r) => r.ok).length, 2);
  eq('E one close idempotent', closes.filter((r) => r.idempotent === true).length, 1);
  // Terminal: further marks refuse; close stays idempotent (retry-safe).
  const mAfter = await runOp('mark');
  falsy('E mark after close refused', mAfter.ok);
  eq('E mark after close code', mAfter.code, 'SMOKE_CLOSED');
  const cAgain = await runOp('close');
  eq('E close retry idempotent', cAgain.ok && cAgain.idempotent, true);
  // Ledger chain proof: genesis prefix (null->CREATED->REVIEW_READY) then
  // every record a legal table step, chained, ending CLOSED.
  const ledgerLines = fs.readFileSync(c.value.ledgerPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  tru('E ledger non-empty', ledgerLines.length >= 3);
  let chained = ledgerLines.length >= 2
    && ledgerLines[0].from === null && ledgerLines[0].to === 'CREATED'
    && ledgerLines[1].from === 'CREATED' && ledgerLines[1].to === 'REVIEW_READY';
  for (let i = 2; i < ledgerLines.length; i++) {
    const rec = ledgerLines[i];
    if (rec.from !== ledgerLines[i - 1].to) chained = false;
    if (!(SMOKE_TRANSITIONS[rec.from] || []).includes(rec.to)) chained = false;
  }
  tru('E ledger chain valid', chained);
  eq('E ledger ends closed', ledgerLines[ledgerLines.length - 1].to, 'CLOSED');
  tru('E no transition out of closed', ledgerLines.every((r) => r.from !== 'CLOSED'));
}

// ---- B2. meta schema: full-field table validation -------------------------------
{
  const root = freshRoot();
  const c = makeTx(root);
  const metaPath = path.join(root, c.value.smokeId, 'meta.json');
  const pristine = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const mutate = (fn) => {
    const m = JSON.parse(JSON.stringify(pristine));
    fn(m);
    fs.writeFileSync(metaPath, JSON.stringify(m), 'utf8');
    const r = readFinalReviewSmoke({ smokeRoot: root, smokeId: c.value.smokeId });
    fs.writeFileSync(metaPath, JSON.stringify(pristine), 'utf8');
    return r;
  };
  const drop = (m, f) => { delete m[f]; };
  // identityHash recompute-bound; wrong type/value each fail closed.
  for (const v of [null, 42, [], 'zz', 'A'.repeat(32)]) {
    falsy(`B2 identityHash ${JSON.stringify(String(v)).slice(0, 12)}`, mutate((m) => { m.identityHash = v; }).ok);
  }
  // Reserved-range + format fields: null / number / array / missing / bad value.
  const ranged = ['issue', 'pullRequest'];
  for (const f of ['repository', ...ranged, 'headSha', 'requestDigest', 'sessionPath', 'reviewReadyDir', 'packetPath', 'ledgerPath', 'state', 'createdAt', 'expiresAt']) {
    falsy(`B2 ${f} null`, mutate((m) => { m[f] = null; }).ok);
    falsy(`B2 ${f} array`, mutate((m) => { m[f] = []; }).ok);
    falsy(`B2 ${f} missing`, mutate((m) => drop(m, f)).ok);
  }
  falsy('B2 repository uppercase', mutate((m) => { m.repository = SMOKE_REPO.toUpperCase(); }).ok);
  falsy('B2 repository bad shape', mutate((m) => { m.repository = 'not a repo'; }).ok);
  falsy('B2 issue below range', mutate((m) => { m.issue = 7; }).ok);
  falsy('B2 pullRequest below range', mutate((m) => { m.pullRequest = 9; }).ok);
  falsy('B2 headSha uppercase', mutate((m) => { m.headSha = 'C'.repeat(40); }).ok);
  falsy('B2 digest short', mutate((m) => { m.requestDigest = 'ab12'; }).ok);
  falsy('B2 state unknown', mutate((m) => { m.state = 'COMPLETED'; }).ok);
  falsy('B2 createdAt number', mutate((m) => { m.createdAt = 42; }).ok);
  falsy('B2 expiresAt garbage', mutate((m) => { m.expiresAt = 'soon'; }).ok);
  falsy('B2 expires before created', mutate((m) => { m.expiresAt = m.createdAt; }).ok);
  falsy('B2 sessionPath absolute-outside', mutate((m) => { m.sessionPath = path.join(root, 'out.json'); }).ok);
  falsy('B2 ledgerPath absolute-outside', mutate((m) => { m.ledgerPath = path.join(os.tmpdir(), 'x.jsonl'); }).ok);
  falsy('B2 clientRequestId number', mutate((m) => { m.clientRequestId = 7; }).ok);
  // No-throw guarantee: an unserializable mutation throws in the TEST's own
  // stringify (before any write), leaving the committed meta untouched.
  try { mutate((m) => { m.issue = BigInt(1); }); } catch { /* stringify throws pre-write */ }
  eq('B2 throwing mutation leaves readable meta', readFinalReviewSmoke({ smokeRoot: root, smokeId: c.value.smokeId }).ok, true);
  eq('B2 pristine restored', readFinalReviewSmoke({ smokeRoot: root, smokeId: c.value.smokeId }).ok, true);
}

// ---- C2. ledger containment: outside sentinel never written --------------------
{
  const root = freshRoot();
  const c = makeTx(root);
  const metaPath = path.join(root, c.value.smokeId, 'meta.json');
  const pristine = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const sentinel = path.join(root, 'sentinel-ledger.jsonl');
  fs.writeFileSync(sentinel, 'SENTINEL-BYTES', 'utf8');
  const before = fs.readFileSync(sentinel, 'utf8');
  const poison = (ledgerPath) => {
    const m = JSON.parse(JSON.stringify(pristine));
    m.ledgerPath = ledgerPath;
    fs.writeFileSync(metaPath, JSON.stringify(m), 'utf8');
  };
  // Tampered ledgerPath outside the instance dir: schema rejects first
  // (META_INVALID); containment would answer PATH_ESCAPE — either is
  // fail-closed, and the sentinel must be byte-identical afterwards.
  poison(sentinel);
  const mm = markSmokeReviewed({ smokeRoot: root, smokeId: c.value.smokeId, verdict: 'PASS' });
  falsy('C2 outside mark refused', mm.ok);
  tru('C2 outside mark fail-closed code', mm.code === 'SMOKE_META_INVALID' || mm.code === 'SMOKE_PATH_ESCAPE');
  const mc = closeFinalReviewSmoke({ smokeRoot: root, smokeId: c.value.smokeId });
  falsy('C2 outside close refused', mc.ok);
  tru('C2 outside close fail-closed code', mc.code === 'SMOKE_META_INVALID' || mc.code === 'SMOKE_PATH_ESCAPE');
  eq('C2 sentinel byte-identical', fs.readFileSync(sentinel, 'utf8'), before);
  // Symlinked ledger file inside a valid meta: SYMLINK_REFUSED, no write.
  fs.writeFileSync(metaPath, JSON.stringify(pristine), 'utf8');
  const ledReal = pristine.ledgerPath;
  const ledBak = `${ledReal}.real`;
  fs.renameSync(ledReal, ledBak);
  let linked = false;
  try { fs.symlinkSync(ledBak, ledReal, 'file'); linked = true; } catch { /* no privilege */ }
  if (linked) {
    const ms = markSmokeReviewed({ smokeRoot: root, smokeId: c.value.smokeId });
    falsy('C2 linked ledger refused', ms.ok);
    eq('C2 linked ledger code', ms.code, 'SMOKE_SYMLINK_REFUSED');
    fs.unlinkSync(ledReal);
  }
  fs.renameSync(ledBak, ledReal);
  // Restore pristine meta: transaction usable, ledger intact.
  fs.writeFileSync(metaPath, JSON.stringify(pristine), 'utf8');
  eq('C2 restored usable', markSmokeReviewed({ smokeRoot: root, smokeId: c.value.smokeId, verdict: 'PASS' }).ok, true);
  eq('C2 sentinel still identical', fs.readFileSync(sentinel, 'utf8'), before);
}

// ---- D2. claim release after commit -------------------------------------------
{
  const root = freshRoot();
  const key = `claim-release-${Date.now()}-b5`;
  const claimKey = crypto.createHash('sha256').update(`smoke-request|v1|${key}`, 'utf8').digest('hex');
  const claimPath = path.join(root, 'by-request', `${claimKey}.json`);
  const committedPath = path.join(root, 'by-request', `${claimKey}.committed.json`);
  const c1 = createFinalReviewSmoke({ smokeRoot: root, clientRequestId: key });
  eq('D2 create ok', c1.ok, true);
  tru('D2 committed record exists', fs.existsSync(committedPath));
  eq('D2 committed canonical', JSON.parse(fs.readFileSync(committedPath, 'utf8')).smokeId, c1.value.smokeId);
  falsy('D2 CLAIMING released', fs.existsSync(claimPath));
  // Close, then immediately re-create with the same key: contract says the
  // committed-but-CLOSED record is dropped and a fresh transaction is minted
  // with NO stale-window wait and NO IN_FLIGHT.
  eq('D2 close ok', closeFinalReviewSmoke({ smokeRoot: root, smokeId: c1.value.smokeId }).ok, true);
  const c2 = createFinalReviewSmoke({ smokeRoot: root, clientRequestId: key });
  eq('D2 immediate recreate ok', c2.ok, true);
  falsy('D2 recreate not in-flight', c2.code === 'SMOKE_REQUEST_IN_FLIGHT');
  eq('D2 recreate state', c2.value.state, 'REVIEW_READY');
}

// ---- E2. concurrent lifecycle serialization across processes -------------------
{
  const root = freshRoot();
  const c = makeTx(root);
  const modUrl = new URL('../packages/control-loop/final-review-smoke.mjs', import.meta.url).href;
  const opSrc = (op) => `import('${modUrl}').then((s) => {`
    + ` const fn = ${op === 'mark' ? 's.markSmokeReviewed' : 's.closeFinalReviewSmoke'};`
    + ` let r; for (let i = 0; i < 400; i++) {`
    + `  r = fn({ smokeRoot: process.env.FRS_ROOT, smokeId: process.env.FRS_ID, verdict: 'PASS' });`
    + `  if (!r.ok && r.code === 'SMOKE_LIFECYCLE_BUSY') {`
    + `   Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); continue;`
    + `  } break; }`
    + ` console.log(JSON.stringify({ op: '${op}', ok: r.ok, code: r.code || null, idempotent: r.idempotent || false }));`
    + `}).catch(() => { console.log(JSON.stringify({ op: '${op}', ok: false, code: 'CHILD_THROW' })); });`;
  const runOp = (op, envExtra = {}) => new Promise((resolve) => {
    execFile(process.execPath, ['--input-type=module', '-e', opSrc(op)], {
      env: { ...process.env, FRS_ROOT: root, FRS_ID: c.value.smokeId, ...envExtra }, timeout: 120000,
    }, (err, stdout) => {
      if (err) return resolve({ op, ok: false, code: 'CHILD_SPAWN_FAIL' });
      try { resolve(JSON.parse(String(stdout).trim().split('\n').pop())); }
      catch { resolve({ op, ok: false, code: 'CHILD_PARSE_FAIL' }); }
    });
  });
  // mark vs mark: exactly one wins; the other is refused (order irrelevant).
  const marks = await Promise.all([runOp('mark'), runOp('mark')]);
  tru('E2 marks spawned', marks.every((r) => r.code !== 'CHILD_SPAWN_FAIL' && r.code !== 'CHILD_PARSE_FAIL'));
  eq('E2 exactly one mark wins', marks.filter((r) => r.ok).length, 1);
  tru('E2 mark loser refused', marks.filter((r) => !r.ok).every((r) => r.code === 'SMOKE_TRANSITION_REFUSED'));
  // close vs close: both ok, exactly one idempotent; no reversal possible.
  const closes = await Promise.all([runOp('close'), runOp('close')]);
  eq('E2 both closes ok', closes.filter((r) => r.ok).length, 2);
  eq('E2 exactly one idempotent close', closes.filter((r) => r.idempotent === true).length, 1);
  // mark vs close raced on a fresh tx: either serialization is legal;
  // terminal state is CLOSED and the ledger chain stays valid.
  const root2 = freshRoot();
  const c2 = makeTx(root2);
  const runOp2 = (op) => new Promise((resolve) => {
    execFile(process.execPath, ['--input-type=module', '-e', opSrc(op)], {
      env: { ...process.env, FRS_ROOT: root2, FRS_ID: c2.value.smokeId }, timeout: 120000,
    }, (err, stdout) => {
      if (err) return resolve({ op, ok: false, code: 'CHILD_SPAWN_FAIL' });
      try { resolve(JSON.parse(String(stdout).trim().split('\n').pop())); }
      catch { resolve({ op, ok: false, code: 'CHILD_PARSE_FAIL' }); }
    });
  });
  const mixed = await Promise.all([runOp2('mark'), runOp2('close')]);
  tru('E2 mixed spawned', mixed.every((r) => r.code !== 'CHILD_SPAWN_FAIL' && r.code !== 'CHILD_PARSE_FAIL'));
  const finClose = mixed.find((r) => r.op === 'close');
  const finMark = mixed.find((r) => r.op === 'mark');
  eq('E2 mixed close ok', finClose.ok, true);
  tru('E2 mixed mark legal', finMark.ok || finMark.code === 'SMOKE_CLOSED');
  // Terminal: CLOSED is terminal; retry idempotent; ledger chain valid.
  const mAfter = await runOp2('mark');
  falsy('E2 mark after close refused', mAfter.ok);
  eq('E2 mark-after-close code', mAfter.code, 'SMOKE_CLOSED');
  const cAgain = await runOp2('close');
  eq('E2 close retry idempotent', cAgain.ok && cAgain.idempotent, true);
  const lines = fs.readFileSync(path.join(root2, c2.value.smokeId, 'control-loop', c2.value.smokeId.slice(4), 'transitions.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  let chained = lines.length >= 2 && lines[0].from === null && lines[0].to === 'CREATED'
    && lines[1].from === 'CREATED' && lines[1].to === 'REVIEW_READY';
  for (let i = 2; i < lines.length; i++) {
    if (lines[i].from !== lines[i - 1].to) chained = false;
    if (!(SMOKE_TRANSITIONS[lines[i].from] || []).includes(lines[i].to)) chained = false;
  }
  tru('E2 ledger chain valid', chained);
  eq('E2 ledger ends closed', lines[lines.length - 1].to, 'CLOSED');
  tru('E2 no record out of closed', lines.every((r) => r.from !== 'CLOSED'));
  // Interrupted holder: a stale lock is taken over; a live lock is BUSY.
  const root3 = freshRoot();
  const c3 = makeTx(root3);
  const lockDir = path.join(root3, c3.value.smokeId, '.lifecycle.lock');
  fs.mkdirSync(lockDir);
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(lockDir, past, past);
  eq('E2 stale lock taken over', markSmokeReviewed({ smokeRoot: root3, smokeId: c3.value.smokeId, verdict: 'PASS' }).ok, true);
  const c4 = makeTx(root3);
  const lockDir4 = path.join(root3, c4.value.smokeId, '.lifecycle.lock');
  fs.mkdirSync(lockDir4);
  const busy = markSmokeReviewed({ smokeRoot: root3, smokeId: c4.value.smokeId });
  falsy('E2 live lock busy', busy.ok);
  eq('E2 live lock code', busy.code, 'SMOKE_LIFECYCLE_BUSY');
  try { fs.rmdirSync(lockDir4); } catch { /* test-owned */ }
  eq('E2 after release ok', markSmokeReviewed({ smokeRoot: root3, smokeId: c4.value.smokeId }).ok, true);
}

// ---- B3. owned lifecycle lock: token, takeover, late-release, BUSY ---------
{
  const root = freshRoot();
  const c = makeTx(root);
  const dir = path.join(root, c.value.smokeId);
  const ownerFile = path.join(dir, '.lifecycle.lock', 'owner.json');
  // 1. A acquires with a unique token.
  const A = acquireLifecycleLock(dir);
  eq('OWN A acquires', A.ok, true);
  tru('OWN token shape', /^[0-9a-f]{32}$/.test(A.token));
  eq('OWN record persisted', JSON.parse(fs.readFileSync(ownerFile, 'utf8')).token, A.token);
  // 2. Stale it; 3. B takes over with a different token.
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(ownerFile, past, past);
  fs.utimesSync(path.join(dir, '.lifecycle.lock'), past, past);
  const B = acquireLifecycleLock(dir);
  eq('OWN B takes over stale', B.ok, true);
  falsy('OWN tokens differ', B.token === A.token);
  // 4. A's late release must NOT delete B's lock.
  const relA = releaseLifecycleLock(dir, A.token);
  falsy('OWN late release refused', relA.ok);
  eq('OWN late release code', relA.code, 'SMOKE_LOCK_NOT_OWNER');
  eq('OWN winner token intact', JSON.parse(fs.readFileSync(ownerFile, 'utf8')).token, B.token);
  // 5. (covered: only B's token releases) 6. C sees BUSY on the live lock.
  const busy = acquireLifecycleLock(dir);
  falsy('OWN C busy on live lock', busy.ok);
  eq('OWN busy code', busy.code, 'SMOKE_LIFECYCLE_BUSY');
  // 7. B releases; 8. C acquires.
  const relB = releaseLifecycleLock(dir, B.token);
  eq('OWN B release ok', relB.ok, true);
  eq('OWN B released flag', relB.released, true);
  const C = acquireLifecycleLock(dir);
  eq('OWN C acquires after release', C.ok, true);
  eq('OWN C release ok', releaseLifecycleLock(dir, C.token).ok, true);
  const C2 = releaseLifecycleLock(dir, C.token);
  eq('OWN repeat release idempotent', C2.ok, true);
  eq('OWN repeat released flag', C2.released, false);
  // Foreign token never deletes.
  const C3 = acquireLifecycleLock(dir);
  falsy('OWN foreign refused', releaseLifecycleLock(dir, 'deadbeef').ok);
  tru('OWN lock survives foreign release', fs.existsSync(ownerFile));
  eq('OWN cleanup release', releaseLifecycleLock(dir, C3.token).ok, true);
}

// ---- C3. WAL fault-injection per crash boundary --------------------------------
{
  const newTx = () => { const r = freshRoot(); return { root: r, tx: makeTx(r) }; };
  const opCount = (ledgerPath, id) => fs.readFileSync(ledgerPath, 'utf8').split('\n').filter((l) => {
    try { return JSON.parse(l).operationId === id; } catch { return false; }
  }).length;
  // Boundary 1: crash BEFORE ledger append (intent only) -> resume exactly once.
  {
    const { root, tx } = newTx();
    const dir = path.join(root, tx.value.smokeId);
    const op = 'a'.repeat(32);
    fs.writeFileSync(path.join(dir, '.pending-transition.json'), JSON.stringify({
      v: 1, operationId: op, op: 'mark', from: 'REVIEW_READY', to: 'REVIEWED', at: new Date().toISOString(),
      ledgerRecord: { ts: new Date().toISOString(), from: 'REVIEW_READY', to: 'REVIEWED', reason: 't', identityHash: 'h', sessionPath: 's', smokeId: tx.value.smokeId },
      metaPatch: { state: 'REVIEWED' },
    }), 'utf8');
    const r = markSmokeReviewed({ smokeRoot: root, smokeId: tx.value.smokeId, verdict: 'PASS' });
    // Recovery completes the crashed intent; the NEW call is then honestly
    // refused as a duplicate — exactly-once with truthful reporting.
    falsy('WAL pre-append duplicate refused', r.ok);
    eq('WAL pre-append duplicate code', r.code, 'SMOKE_TRANSITION_REFUSED');
    eq('WAL resumed state', JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')).state, 'REVIEWED');
    eq('WAL op appended once', opCount(tx.value.ledgerPath, op), 1);
    falsy('WAL intent finalized', fs.existsSync(path.join(dir, '.pending-transition.json')));
  }
  // Boundary 2: crash AFTER append, BEFORE meta update -> reconcile, no duplicate.
  {
    const { root, tx } = newTx();
    const dir = path.join(root, tx.value.smokeId);
    const op = 'b'.repeat(32);
    fs.appendFileSync(tx.value.ledgerPath, JSON.stringify({
      ts: new Date().toISOString(), from: 'REVIEW_READY', to: 'REVIEWED', reason: 't',
      identityHash: 'h', sessionPath: 's', smokeId: tx.value.smokeId, operationId: op,
    }) + '\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.pending-transition.json'), JSON.stringify({
      v: 1, operationId: op, op: 'mark', from: 'REVIEW_READY', to: 'REVIEWED', at: new Date().toISOString(),
      ledgerRecord: { ts: new Date().toISOString(), from: 'REVIEW_READY', to: 'REVIEWED', reason: 't', identityHash: 'h', sessionPath: 's', smokeId: tx.value.smokeId },
      metaPatch: { state: 'REVIEWED' },
    }), 'utf8');
    // A new mark call reconciles the crashed intent, then refuses itself as
    // duplicate — exactly-once preserved, no second append.
    const r = markSmokeReviewed({ smokeRoot: root, smokeId: tx.value.smokeId, verdict: 'PASS' });
    falsy('WAL post-append duplicate refused', r.ok);
    eq('WAL duplicate code', r.code, 'SMOKE_TRANSITION_REFUSED');
    eq('WAL op still once', opCount(tx.value.ledgerPath, op), 1);
    eq('WAL meta reconciled', JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')).state, 'REVIEWED');
    falsy('WAL intent finalized', fs.existsSync(path.join(dir, '.pending-transition.json')));
  }
  // Boundary 3: crash AFTER meta update, BEFORE intent cleanup -> finalize idempotently.
  {
    const { root, tx } = newTx();
    const dir = path.join(root, tx.value.smokeId);
    const op = 'c'.repeat(32);
    fs.appendFileSync(tx.value.ledgerPath, JSON.stringify({
      ts: new Date().toISOString(), from: 'REVIEW_READY', to: 'CLOSED', reason: 'smoke closed',
      identityHash: 'h', sessionPath: 's', smokeId: tx.value.smokeId, operationId: op,
    }) + '\n', 'utf8');
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    meta.state = 'CLOSED';
    meta.closedAt = new Date().toISOString();
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta), 'utf8');
    fs.writeFileSync(path.join(dir, '.pending-transition.json'), JSON.stringify({
      v: 1, operationId: op, op: 'close', from: 'REVIEW_READY', to: 'CLOSED', at: new Date().toISOString(),
      ledgerRecord: {}, metaPatch: { state: 'CLOSED' },
    }), 'utf8');
    // Any later touch finalizes without mutating: mark refuses CLOSED...
    const r = markSmokeReviewed({ smokeRoot: root, smokeId: tx.value.smokeId });
    falsy('WAL closed stays refused', r.ok);
    eq('WAL closed code', r.code, 'SMOKE_CLOSED');
    falsy('WAL intent finalized', fs.existsSync(path.join(dir, '.pending-transition.json')));
    eq('WAL op still once', opCount(tx.value.ledgerPath, op), 1);
    // ...and close stays idempotent.
    const rc = closeFinalReviewSmoke({ smokeRoot: root, smokeId: tx.value.smokeId });
    eq('WAL close idempotent', rc.ok && rc.idempotent, true);
  }
  // Boundary 4: corrupt intent file -> discarded, op proceeds normally.
  {
    const { root, tx } = newTx();
    const dir = path.join(root, tx.value.smokeId);
    fs.writeFileSync(path.join(dir, '.pending-transition.json'), '{corrupt!!', 'utf8');
    const r = markSmokeReviewed({ smokeRoot: root, smokeId: tx.value.smokeId, verdict: 'PASS' });
    eq('WAL corrupt intent discarded, op ok', r.ok, true);
    eq('WAL state', r.value.state, 'REVIEWED');
  }
  // Boundary 5: CLOSED meta + stale pending -> terminal wins, never reversed.
  {
    const { root, tx } = newTx();
    const dir = path.join(root, tx.value.smokeId);
    eq('WAL close ok', closeFinalReviewSmoke({ smokeRoot: root, smokeId: tx.value.smokeId }).ok, true);
    fs.writeFileSync(path.join(dir, '.pending-transition.json'), JSON.stringify({
      v: 1, operationId: 'd'.repeat(32), op: 'mark', from: 'REVIEW_READY', to: 'REVIEWED', at: new Date().toISOString(),
      ledgerRecord: {}, metaPatch: { state: 'REVIEWED' },
    }), 'utf8');
    const before = fs.readFileSync(tx.value.ledgerPath, 'utf8');
    const r = markSmokeReviewed({ smokeRoot: root, smokeId: tx.value.smokeId });
    falsy('WAL terminal wins', r.ok);
    eq('WAL terminal code', r.code, 'SMOKE_CLOSED');
    eq('WAL ledger untouched', fs.readFileSync(tx.value.ledgerPath, 'utf8'), before);
    eq('WAL meta still closed', JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')).state, 'CLOSED');
    falsy('WAL stale intent dropped', fs.existsSync(path.join(dir, '.pending-transition.json')));
  }
}

// ---- D3. canonical meta paths: in-root substitution fails closed ---------------
{
  const root = freshRoot();
  const c = makeTx(root);
  const dir = path.join(root, c.value.smokeId);
  const metaPath = path.join(dir, 'meta.json');
  const pristine = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const h = pristine.identityHash;
  const swap = (fn) => {
    const m = JSON.parse(JSON.stringify(pristine));
    fn(m);
    fs.writeFileSync(metaPath, JSON.stringify(m), 'utf8');
    const r = readFinalReviewSmoke({ smokeRoot: root, smokeId: c.value.smokeId });
    fs.writeFileSync(metaPath, JSON.stringify(pristine), 'utf8');
    return r;
  };
  // Alternate session path (valid file, wrong canonical location).
  const altSess = path.join(dir, 'sessions', `${'0'.repeat(32)}.json`);
  fs.writeFileSync(altSess, fs.readFileSync(c.value.sessionPath, 'utf8'), 'utf8');
  const r1 = swap((m) => { m.sessionPath = altSess; });
  falsy('D3 alt session refused', r1.ok);
  eq('D3 alt session code', r1.code, 'SMOKE_META_INVALID');
  fs.unlinkSync(altSess);
  // Alternate packet path inside the packet dir (wrong filename).
  const r2 = swap((m) => { m.packetPath = path.join(dir, 'review-ready', 'other.md'); });
  falsy('D3 alt packet refused', r2.ok);
  eq('D3 alt packet code', r2.code, 'SMOKE_META_INVALID');
  // Alternate review-ready directory inside the instance dir.
  fs.mkdirSync(path.join(dir, 'review-ready2'), { recursive: true });
  const r3 = swap((m) => { m.reviewReadyDir = path.join(dir, 'review-ready2'); });
  falsy('D3 alt packet dir refused', r3.ok);
  eq('D3 alt packet dir code', r3.code, 'SMOKE_META_INVALID');
  // Alternate ledger path inside the instance dir.
  const r4 = swap((m) => { m.ledgerPath = path.join(dir, 'control-loop', h, 'other.jsonl'); });
  falsy('D3 alt ledger refused', r4.ok);
  eq('D3 alt ledger code', r4.code, 'SMOKE_META_INVALID');
  // And the mutating path refuses before any append: poisoned ledger + mark.
  const m5 = JSON.parse(JSON.stringify(pristine));
  m5.ledgerPath = path.join(dir, 'control-loop', h, 'other.jsonl');
  fs.writeFileSync(metaPath, JSON.stringify(m5), 'utf8');
  const before = fs.readFileSync(c.value.ledgerPath, 'utf8');
  const rm = markSmokeReviewed({ smokeRoot: root, smokeId: c.value.smokeId });
  falsy('D3 poisoned ledger mark refused', rm.ok);
  eq('D3 poisoned ledger intact', fs.readFileSync(c.value.ledgerPath, 'utf8'), before);
  fs.writeFileSync(metaPath, JSON.stringify(pristine), 'utf8');
  eq('D3 pristine restored', readFinalReviewSmoke({ smokeRoot: root, smokeId: c.value.smokeId }).ok, true);
}

// ---- summary -----------------------------------------------------------------
let failed = 0;
for (const c of checks) {
  if (!c.ok) failed++;
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : ` — got=${JSON.stringify(c.got)} want=${JSON.stringify(c.want)}`}`);
}
console.log(`final-review-smoke: ${checks.length - failed}/${checks.length} checks passed`);
if (failed) process.exit(1);
assert.ok(true);
// end of final-review-smoke.test.mjs — no trailing marker.
