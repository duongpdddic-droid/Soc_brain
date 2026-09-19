#!/usr/bin/env node
// smoke-gpt-final-review.test.mjs — deterministic tests for the side-effect-free
// final-review smoke harness. Covers: missing input fail-closed, malformed
// packet, stale identity, digest missing, provider gate, fake transport happy
// path, binding mismatch fail-closed, and the static side-effect-free proof
// (no lifecycle/mutation/write surfaces imported or invoked).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { runSmokeHarness } from '../scripts/smoke-gpt-final-review.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';
import { SESSION_SCHEMA_VERSION } from '../packages/runtime-sandbox/runtime-sandbox.mjs';

const checks = [];
const eq = (n, g, w) => checks.push({ name: n, ok: g === w, got: g, want: w });
const tru = (n, g) => checks.push({ name: n, ok: Boolean(g), got: g });
const falsy = (n, g) => checks.push({ name: n, ok: !g, got: g });

// ---- canonical fixture ---------------------------------------------------------
const HEAD = 'a'.repeat(40);
const PR = 999;
const ISSUE = 888;
const REPO = 'duongpdddic-droid/Soc_brain';
const REPORT = { identity: { repository: REPO, issue: ISSUE, pullRequest: PR, headSha: HEAD, branch: 'x', baseSha: 'b'.repeat(40) }, terminalStatus: { status: 'READY_FOR_REVIEW' } };

function makeSession(tmp, { head = HEAD } = {}) {
  const stateDir = path.join(os.tmpdir(), `smoke-harness-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const h = identityHash({ repo: REPO.toLowerCase(), issueNumber: ISSUE });
  const sessions = path.join(stateDir, 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const sessionPath = path.join(sessions, `${h}.json`);
  fs.writeFileSync(sessionPath, JSON.stringify({
    schemaVersion: SESSION_SCHEMA_VERSION,
    repo: REPO.toLowerCase(),
    issueNumber: ISSUE,
    headSha: head,
    baseSha: 'c'.repeat(40),
    state: 'READY_FOR_REVIEW',
    prNumber: PR,
  }), 'utf8');
  fs.mkdirSync(path.join(stateDir, 'control-loop', h), { recursive: true });
  return { stateDir, sessionPath, identityHash: h };
}

function packet({ head = HEAD, repo = REPO, issue = ISSUE } = {}) {
  // Auto-stamped with the REAL canonical digest (sha256 over the stamp-less
  // rendering), so fixtures exercise the production verification path.
  const lines = [
    `# Review Ready — ${repo} Issue #${issue} · PR #${PR}`,
    '',
    '## Identity',
    `- repository: ${repo}`,
    `- issue: ${issue}`,
    `- pullRequest: ${PR}`,
    `- headSha: ${head} (short ${head.slice(0, 7)})`,
    `- baseSha: ${'c'.repeat(40)}`,
    `- prState: OPEN`,
    '',
    '## Terminal status',
    '- status: **READY_FOR_REVIEW**',
  ];
  const body = lines.join('\n');
  const digest = createHash('sha256').update(body, 'utf8').digest('hex');
  const at = lines.findIndex((l) => /^- prState:/.test(l));
  lines.splice(at + 1, 0, `- reportDigest: ${digest}`);
  return lines.join('\n');
}

function packetDigest(text) {
  const m = /- reportDigest:\s*([0-9a-f]{64})/i.exec(text);
  return m ? m[1] : null;
}

function writeReviewReadyDir(stateDir, content, { head = HEAD } = {}) {
  const dir = path.join(stateDir, 'review-ready');
  fs.mkdirSync(dir, { recursive: true });
  const name = `duongpdddic-droid_Soc_brain_Issue-${ISSUE}_PR-${PR}_${head.slice(0, 7)}_review-ready.md`;
  fs.writeFileSync(path.join(dir, name), content, 'utf8');
  return dir;
}

// Deterministic valid reply carrying metadata.requestDigest (the provider
// echoes the anti-stale token in metadata) + the canonical five-coordinate
// binding echo (P0 trust anchor). DIGEST is the REAL stamp of the default
// packet, so the happy path exercises full verification.
const DIGEST = packetDigest(packet({}));
const replyOk = JSON.stringify({
  verdict: 'PASS',
  findings: [],
  evidenceRequests: [],
  confidence: 0.95,
  metadata: { source: 'chatgpt-web-final-review', requestDigest: DIGEST },
  binding: { repository: REPO, issue: ISSUE, pullRequest: PR, headSha: HEAD, requestDigest: DIGEST },
});

const fakeTransport = (response) => async ({ prompt }) => {
  eq('fixture: prompt carries canonical anti-stale digest', prompt.includes(`"requestDigest": "${DIGEST}"`), true);
  return { ok: true, text: response, conversationId: 'conv-smoke-1', modelSlug: 'auto', canonicalRequestId: DIGEST, transportMeta: { provider: 'chatgpt-plus-web2api-copy', schemaVersion: '1', turnId: 'B', shortcutAttempts: 1, submitUncertain: false, copyLatencyMs: 5, interference: 0, collectorSeq: 13 } };
};

// 1. missing session => fail BEFORE submit, provider untouched.
{
  const r = await runSmokeHarness({ sessionPath: '', evidence: '/tmp/whatever' });
  falsy('1 missing session not ok', r.ok);
  eq('1 code', r.code, 'SMOKE_SESSION_REQUIRED');
  eq('1 submitStatus', r.submitStatus, 'NOT_SUBMITTED');
  eq('1 provider untouched', r.provider, null);
}

// 2. missing evidence => fail BEFORE submit.
{
  const { sessionPath } = makeSession();
  const r = await runSmokeHarness({ sessionPath, evidence: '' });
  falsy('2 missing evidence not ok', r.ok);
  eq('2 code', r.code, 'SMOKE_EVIDENCE_REQUIRED');
  eq('2 submitStatus', r.submitStatus, 'NOT_SUBMITTED');
}

// 3. session not found => fail before submit.
{
  const r = await runSmokeHarness({ sessionPath: path.join(os.tmpdir(), 'does-not-exist.json'), evidence: os.tmpdir() });
  falsy('3 missing session file not ok', r.ok);
  eq('3 code', r.code, 'SMOKE_SESSION_INVALID');
}

// 4. malformed canonical packet (no Identity block) => fail before submit.
{
  const { stateDir, sessionPath } = makeSession();
  const dir = writeReviewReadyDir(stateDir, 'no identity here', {});
  const r = await runSmokeHarness({ sessionPath, evidence: dir });
  falsy('4 malformed packet not ok', r.ok);
  eq('4 code', r.code, 'SMOKE_PACKET_IDENTITY_INVALID');
}

// 5. identity mismatch (packet for another issue) => fail before submit.
{
  const { stateDir, sessionPath } = makeSession();
  const dir = writeReviewReadyDir(stateDir, packet({ issue: 7777 }));
  const r = await runSmokeHarness({ sessionPath, evidence: dir });
  falsy('5 identity mismatch not ok', r.ok);
  eq('5 code', r.code, 'SMOKE_IDENTITY_MISMATCH');
}

// 6. stale packet head => fail before submit.
{
  const { stateDir, sessionPath } = makeSession();
  const dir = writeReviewReadyDir(stateDir, packet({ head: 'f'.repeat(40) }));
  const r = await runSmokeHarness({ sessionPath, evidence: dir });
  falsy('6 stale packet not ok', r.ok);
  eq('6 code', r.code, 'SMOKE_PACKET_STALE');
}

// 7. digest stamp missing => fail before submit.
{
  const { stateDir, sessionPath } = makeSession();
  const raw = packet({});
  const stripped = raw.split('\n').filter((l) => !l.includes('reportDigest')).join('\n');
  const dir = writeReviewReadyDir(stateDir, stripped);
  const r = await runSmokeHarness({ sessionPath, evidence: dir });
  falsy('7 digest missing not ok', r.ok);
  eq('7 code', r.code, 'SMOKE_DIGEST_MISSING');
}

// 8. explicit file evidence that the resolver does NOT select => fail-closed.
{
  const { stateDir, sessionPath } = makeSession();
  const dir = writeReviewReadyDir(stateDir, packet({}));
  const foreign = path.join(dir, `duongpdddic-droid_Soc_brain_Issue-${ISSUE}_PR-998_${HEAD.slice(0, 7)}_review-ready.md`);
  fs.writeFileSync(foreign, packet({ issue: 7777 }), 'utf8');
  const r = await runSmokeHarness({ sessionPath, evidence: foreign });
  falsy('8 non-canonical file not ok', r.ok);
  eq('8 code', r.code, 'SMOKE_EVIDENCE_NOT_CANONICAL');
}

// 9. provider gate: absent/other provider => no submit (side-effect guard).
// Packet carries the digest so the gate ORDER is proven: provider gate fires
// only after all canonical-input gates pass.
{
  const { stateDir, sessionPath } = makeSession();
  const dir = writeReviewReadyDir(stateDir, packet({}));
  const r = await runSmokeHarness({ sessionPath, evidence: dir, env: {} });
  falsy('9 no provider not ok', r.ok);
  eq('9 code', r.code, 'SMOKE_PROVIDER_UNSUPPORTED');
}

// 10. fake transport happy path: reaches strict parser + binding gate.
{
  const { stateDir, sessionPath } = makeSession();
  const dir = writeReviewReadyDir(stateDir, packet({}));
  const r = await runSmokeHarness({ sessionPath, evidence: dir, env: { SOC_FINAL_REVIEW_PROVIDER: 'chatgpt-plus-web2api-copy' }, transportOverride: fakeTransport(replyOk) });
  eq('10 ok', r.ok, true);
  eq('10 provider', r.provider, 'web2api-copy');
  eq('10 requestDigest', r.requestDigest, DIGEST);
  eq('10 binding repo', r.binding.repository, REPO);
  eq('10 binding issue', r.binding.issue, ISSUE);
  eq('10 binding head', r.binding.headSha, HEAD);
  eq('10 submitStatus', r.submitStatus, 'SUBMITTED');
  eq('10 conversationId', r.conversationId, 'conv-smoke-1');
  eq('10 assistantTurnId', r.assistantTurnId, 'B');
  eq('10 clipboardAttempts', r.clipboardAttempts, 1);
  eq('10 parserOk', r.parserOk, true);
  eq('10 bindingOk', r.bindingOk, true);
  eq('10 verdict', r.verdict, 'PASS');
  eq('10 latency', typeof r.latencyMs, 'number');
}

// 11. binding mismatch (reply echoes foreign binding) => parser OK, binding FAIL.
{
  const { stateDir, sessionPath } = makeSession();
  const dir = writeReviewReadyDir(stateDir, packet({}));
  const bad = JSON.stringify({
    verdict: 'PASS', findings: [], evidenceRequests: [], confidence: 0.9,
    metadata: { requestDigest: DIGEST },
    binding: { repository: 'evil/repo', issue: ISSUE, pullRequest: PR, headSha: HEAD, requestDigest: DIGEST },
  });
  const r = await runSmokeHarness({ sessionPath, evidence: dir, env: { SOC_FINAL_REVIEW_PROVIDER: 'chatgpt-plus-web2api-copy' }, transportOverride: fakeTransport(bad) });
  falsy('11 mismatch not ok', r.ok);
  eq('11 bindingOk', r.bindingOk, false);
  eq('11 parserOk', r.parserOk, true);
  eq('11 bindingCode', r.code, 'GPT_BINDING_MISMATCH');
}

// 12. malformed reply => parserOk=false, binding unjudged.
{
  const { stateDir, sessionPath } = makeSession();
  const dir = writeReviewReadyDir(stateDir, packet({}));
  const r = await runSmokeHarness({ sessionPath, evidence: dir, env: { SOC_FINAL_REVIEW_PROVIDER: 'chatgpt-plus-web2api-copy' }, transportOverride: fakeTransport('not json at all') });
  falsy('12 malformed not ok', r.ok);
  eq('12 parserOk', r.parserOk, false);
  eq('12 bindingOk', r.bindingOk, null);
  eq('12 code', r.code, 'GPT_RESPONSE_MALFORMED');
}

// 13. stale digest echo (wrong metadata.requestDigest) => canonical parser does
// NOT treat metadata as authority (digest authority is binding.requestDigest
// vs the packet stamp — the real transport rejects stale digests itself,
// proven by provider tests T15/T22). PASS-level gate: parser ok, binding ok.
{
  const { stateDir, sessionPath } = makeSession();
  const dir = writeReviewReadyDir(stateDir, packet({}));
  const stale = JSON.stringify({
    verdict: 'PASS', findings: [], evidenceRequests: [], confidence: 0.9,
    metadata: { requestDigest: 'e'.repeat(64) },
    binding: { repository: REPO, issue: ISSUE, pullRequest: PR, headSha: HEAD, requestDigest: DIGEST },
  });
  const r = await runSmokeHarness({ sessionPath, evidence: dir, env: { SOC_FINAL_REVIEW_PROVIDER: 'chatgpt-plus-web2api-copy' }, transportOverride: fakeTransport(stale) });
  eq('13 stale accepted by canonical parser (authority=binding)', r.ok, true);
  eq('13 verdict', r.verdict, 'PASS');
}

// 13b. P0: wrong binding.requestDigest fails closed at the canonical gate.
{
  const { stateDir, sessionPath } = makeSession();
  const dir = writeReviewReadyDir(stateDir, packet({}));
  const wrongDigest = JSON.stringify({
    verdict: 'PASS', findings: [], evidenceRequests: [], confidence: 0.9,
    metadata: {},
    binding: { repository: REPO, issue: ISSUE, pullRequest: PR, headSha: HEAD, requestDigest: 'e'.repeat(64) },
  });
  const r = await runSmokeHarness({ sessionPath, evidence: dir, env: { SOC_FINAL_REVIEW_PROVIDER: 'chatgpt-plus-web2api-copy' }, transportOverride: fakeTransport(wrongDigest) });
  falsy('13b wrong binding digest not ok', r.ok);
  eq('13b code', r.code, 'GPT_BINDING_MISMATCH');
  eq('13b bindingOk', r.bindingOk, false);
}

// 13c. P0: wrong binding.pullRequest fails closed at the canonical gate.
{
  const { stateDir, sessionPath } = makeSession();
  const dir = writeReviewReadyDir(stateDir, packet({}));
  const wrongPr = JSON.stringify({
    verdict: 'PASS', findings: [], evidenceRequests: [], confidence: 0.9,
    metadata: {},
    binding: { repository: REPO, issue: ISSUE, pullRequest: PR + 1, headSha: HEAD, requestDigest: DIGEST },
  });
  const r = await runSmokeHarness({ sessionPath, evidence: dir, env: { SOC_FINAL_REVIEW_PROVIDER: 'chatgpt-plus-web2api-copy' }, transportOverride: fakeTransport(wrongPr) });
  falsy('13c wrong binding PR not ok', r.ok);
  eq('13c code', r.code, 'GPT_BINDING_MISMATCH');
}

// 14. SIDE-EFFECT-FREE PROOF (static): strip comments, then scan the CODE for
// lifecycle/mutation/write surfaces. Comments are prose, not behavior.
{
  const srcPath = path.resolve(import.meta.dirname, '../scripts/smoke-gpt-final-review.mjs');
  const raw = fs.readFileSync(srcPath, 'utf8');
  const code = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const forbidden of ['writeFileSync', 'mkdirSync', 'rmSync', 'renameSync', 'appendFileSync', 'execSync', 'execFileSync', 'spawnSync', 'taskStart', 'terminalize', 'dispatch', 'deliver', 'telegram', 'pushBranch', 'merge', 'cleanupCanonical', 'updateSession', 'spawn(', 'child_process']) {
    eq(`14 no ${forbidden}`, code.includes(forbidden), false);
  }
  for (const required of ['readSessionRecord', 'packetPathFor', 'parsePacketIdentity', 'createGptFinalReview', 'selectGptTransport']) {
    tru(`14 uses ${required}`, code.includes(required));
  }
  // Binding authority lives INSIDE createGptFinalReview (canonical path);
  // the harness re-implements no binding gate.
  tru('14 binding via canonical factory only', code.includes('assertFinalBinding') === false && code.includes('createGptFinalReview'));
}

// 15. harness called with a transport override that THROWS => fail-closed, typed.
{
  const { stateDir, sessionPath } = makeSession();
  const dir = writeReviewReadyDir(stateDir, packet({}));
  const r = await runSmokeHarness({ sessionPath, evidence: dir, env: { SOC_FINAL_REVIEW_PROVIDER: 'chatgpt-plus-web2api-copy' }, transportOverride: async () => { throw new Error('boom'); } });
  falsy('15 throw not ok', r.ok);
  eq('15 code', r.code, 'GPT_TRANSPORT_THROW');
}

// ---- summary ------------------------------------------------------------------
let failed = 0;
for (const c of checks) {
  if (!c.ok) failed++;
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : ` — got=${JSON.stringify(c.got)} want=${JSON.stringify(c.want)}`}`);
}
console.log(`smoke-harness: ${checks.length - failed}/${checks.length} checks passed`);
if (failed) process.exit(1);
assert.ok(true);
// end of smoke-gpt-final-review.test.mjs — no trailing marker.
