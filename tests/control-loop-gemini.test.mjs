// control-loop-gemini.test.mjs — Issue #75 P0-C deterministic tests
// (rework round 2: transport-only seam, strict pre-review parsing, and
// loop-level authority tests via runControlLoop).
import {
  createGeminiTransport, extractCandidateText, GEMINI_DEFAULT_MODEL,
  GEMINI_TRANSPORT_SCHEMA_VERSION,
} from '../packages/control-loop/gemini-transport.mjs';
import {
  parseGeminiReview, buildPreReviewPrompt, collectPreReviewEvidence,
  createGeminiPreReview, PRE_REVIEW_PACKET_MAX_BYTES,
} from '../packages/control-loop/gemini-pre-review.mjs';
import { geminiPreReviewAdapter, gptFinalReviewAdapter } from '../packages/control-loop/adapters.mjs';
import { runControlLoop, readTransitions, bindLoop } from '../packages/control-loop/control-loop.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const checks = [];
const eq = (n, g, w) => checks.push({ name: n, ok: g === w, got: g, want: w });
const tru = (n, g) => checks.push({ name: n, ok: Boolean(g), got: g });
const falsy = (n, g) => checks.push({ name: n, ok: !g, got: g });

function mkStateDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'clg-')); }

// Build a canonical session record mirroring runtime-sandbox taskStart output
// (readSessionRecord enforces the canonical control-plane location: the file
// name must be the real identityHash of (repo, issueNumber)).
function mkSession(stateDir, overrides = {}) {
  const repo = overrides.repo || 'duongpdddic-droid/soc_brain';
  const issueNumber = overrides.issueNumber || 75;
  const id = identityHash({ repo, issueNumber });
  const sessionPath = path.join(stateDir, 'sessions', `${id}.json`);
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  const session = {
    schemaVersion: '1',
    state: 'SESSION_ACTIVE',
    lifecycle: [],
    taskId: `${repo}#${issueNumber}`,
    repo,
    issueNumber,
    ...overrides,
  };
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
  return { sessionPath, session, id };
}

// Canonical review-ready packet fixture: filename mirrors review-ready's
// buildReviewReadyFilename prefix scheme used by packetPathFor; the default
// body mirrors renderReviewReady's Identity block (packets must self-identify
// — repository/issue/headSha — to count as canonical evidence, D8).
function mkPacket(stateDir, session, body = null) {
  const dir = path.join(stateDir, 'review-ready');
  fs.mkdirSync(dir, { recursive: true });
  const slug = String(session.repo).replace(/\//g, '_');
  const name = `${slug}_Issue-${session.issueNumber}_PR-76_abcdef0_review-ready.md`;
  const head = typeof session.headSha === 'string' && /^[0-9a-f]{40}$/i.test(session.headSha)
    ? session.headSha.toLowerCase()
    : 'a'.repeat(40);
  const content = body === null
    ? [
        `# Review Ready — ${session.repo} Issue #${session.issueNumber} · PR #76`,
        '',
        '## Identity',
        `- repository: ${session.repo}`,
        `- issue: ${session.issueNumber}`,
        '- pullRequest: 76',
        '- branch: agent/test',
        `- headSha: ${head} (short ${head.slice(0, 7)})`,
        `- baseSha: ${'b'.repeat(40)}`,
        '- prState: OPEN',
        '',
        'Canonical packet body for semantic pre-review.',
      ].join('\n')
    : body;
  fs.writeFileSync(path.join(dir, name), content, 'utf8');
  return { dir, name, content };
}

// Seed helper removed: runControlLoop requires an empty ledger (it seeds
// ACCEPTED->ROUTED itself) — loop-level tests use full fake deps instead.

// ---- A0. transport-only seam: key absent, prompt validation ----
{
  const t = createGeminiTransport({ apiKey: '' });
  const r = await t({ prompt: 'p' });
  eq('A0 NO_GEMINI_API_KEY when key absent', r.code, 'NO_GEMINI_API_KEY');
  const t2 = createGeminiTransport({}); // env empty in test
  const r2 = await t2({ prompt: 'p' });
  eq('A0b default factory NO_GEMINI_API_KEY when env empty', r2.code, 'NO_GEMINI_API_KEY');
  const t3 = createGeminiTransport({ apiKey: 'k' });
  const r3 = await t3({});
  eq('A0c missing prompt -> GEMINI_PROMPT_INVALID', r3.code, 'GEMINI_PROMPT_INVALID');
  const r4 = await t3({ prompt: '   ' });
  eq('A0d blank prompt -> GEMINI_PROMPT_INVALID', r4.code, 'GEMINI_PROMPT_INVALID');
  // Transport contract: takes {prompt} only — it cannot receive or mutate
  // canonical state (session records / loop tokens never cross this seam).
  tru('A0e transport model carried on fn', createGeminiTransport({ apiKey: 'k', model: 'm1' }).modelName === 'm1');
  tru('A0f schema version exported', GEMINI_TRANSPORT_SCHEMA_VERSION === '1');
  tru('A0g default model exported', GEMINI_DEFAULT_MODEL.length > 0);
}

// ---- A1. transport happy path + native envelope extraction ----
{
  const modelJson = JSON.stringify({ verdict: 'PASS', findings: ['finding-1'], confidence: 0.95, metadata: {} });
  const fetchImpl = async () => ({
    ok: true, status: 200,
    body: JSON.stringify({ candidates: [{ content: { parts: [{ text: modelJson }] } }] }),
  });
  const t = createGeminiTransport({ apiKey: 'k', model: 'gemini-1.5-flash', fetchImpl });
  const r = await t({ prompt: 'review this' });
  eq('A1 transport ok=true', r.ok, true);
  eq('A1 status 200', r.status, 200);
  eq('A1 text is model JSON', r.text, modelJson);
  eq('A1 extractCandidateText extracts first part text', extractCandidateText({ candidates: [{ content: { parts: [{ text: 'x' }] } }] }), 'x');
  eq('A1b extractCandidateText null on missing envelope', extractCandidateText({}), null);
  eq('A1b extractCandidateText null on non-string text', extractCandidateText({ candidates: [{ content: { parts: [{ text: 5 }] } }] }), null);
}

// ---- A2. non-2xx -> GEMINI_HTTP_<status> ----
{
  const fetchImpl = async () => ({ ok: true, status: 429, body: 'rate limited' });
  const t = createGeminiTransport({ apiKey: 'k', fetchImpl });
  const r = await t({ prompt: 'p' });
  eq('A2 non-2xx code GEMINI_HTTP_429', r.code, 'GEMINI_HTTP_429');
  tru('A2 detail includes body snippet', String(r.detail).includes('rate limited'));
}

// ---- A3. fetchImpl throw / api envelope malformed ----
{
  const t1 = createGeminiTransport({ apiKey: 'k', fetchImpl: async () => { throw new Error('net down'); } });
  const r1 = await t1({ prompt: 'p' });
  eq('A3 fetchImpl throw -> GEMINI_TRANSPORT_THROW', r1.code, 'GEMINI_TRANSPORT_THROW');
  const t2 = createGeminiTransport({ apiKey: 'k', fetchImpl: async () => ({ ok: true, status: 200, body: 'not json {{' }) });
  const r2 = await t2({ prompt: 'p' });
  eq('A3b api envelope json parse fail -> MALFORMED', r2.code, 'GEMINI_RESPONSE_MALFORMED');
  const t3 = createGeminiTransport({ apiKey: 'k', fetchImpl: async () => ({ ok: true, status: 200, body: JSON.stringify({ candidates: [] }) }) });
  const r3 = await t3({ prompt: 'p' });
  eq('A3c no candidate text -> MALFORMED', r3.code, 'GEMINI_RESPONSE_MALFORMED');
}

// ---- A4. strict semantic validation: missing/wrong-type -> MALFORMED ----
{
  const okShape = { verdict: 'PASS', findings: [], confidence: 0.5, metadata: {} };
  const cases = [
    ['missing verdict', { findings: [], confidence: 0.5, metadata: {} }],
    ['verdict wrong type (number)', { verdict: 7, findings: [], confidence: 0.5, metadata: {} }],
    ['missing findings', { verdict: 'PASS', confidence: 0.5, metadata: {} }],
    ['findings wrong type (string)', { verdict: 'PASS', findings: 'none', confidence: 0.5, metadata: {} }],
    ['findings element non-string', { verdict: 'PASS', findings: ['a', 1], confidence: 0.5, metadata: {} }],
    ['missing confidence', { verdict: 'PASS', findings: [], metadata: {} }],
    ['confidence wrong type (string)', { verdict: 'PASS', findings: [], confidence: '0.5', metadata: {} }],
    ['confidence NaN', { verdict: 'PASS', findings: [], confidence: NaN, metadata: {} }],
    ['missing metadata', { verdict: 'PASS', findings: [], confidence: 0.5 }],
    ['metadata wrong type (array)', { verdict: 'PASS', findings: [], confidence: 0.5, metadata: [] }],
    ['whole body is array', ['PASS']],
    ['whole body is string', 'PASS'],
  ];
  for (const [name, shape] of cases) {
    const r = parseGeminiReview(JSON.stringify(shape));
    eq(`A4 ${name} -> GEMINI_RESPONSE_MALFORMED`, r.code, 'GEMINI_RESPONSE_MALFORMED');
  }
  const rEmpty = parseGeminiReview('');
  eq('A4 empty body -> MALFORMED', rEmpty.code, 'GEMINI_RESPONSE_MALFORMED');
  // Wrong enum value: structural shape fine -> distinct code.
  const rEnum = parseGeminiReview(JSON.stringify({ verdict: 'MAYBE', findings: [], confidence: 0.5, metadata: {} }));
  eq('A4b verdict outside {PASS,REWORK} -> GEMINI_VERDICT_INVALID', rEnum.code, 'GEMINI_VERDICT_INVALID');
  // Defaults are NOT allowed to rescue a strict shape check.
  const rDef = parseGeminiReview(JSON.stringify({ verdict: 'PASS', findings: [] }));
  eq('A4c absent confidence+metadata -> MALFORMED (no defaults)', rDef.code, 'GEMINI_RESPONSE_MALFORMED');
}

// ---- A5. valid responses normalize within bounds ----
{
  const r = parseGeminiReview(JSON.stringify({ verdict: 'pass', findings: ['a', 'b'], confidence: 2, metadata: { k: 'v' } }));
  eq('A5 verdict normalized to PASS', r.value.verdict, 'PASS');
  eq('A5 findings preserved', r.value.findings.length, 2);
  eq('A5 confidence clamped to 1', r.value.confidence, 1);
  eq('A5 metadata carried', r.value.metadata.k, 'v');
  const r2 = parseGeminiReview(JSON.stringify({ verdict: 'REWORK', findings: ['x'], confidence: -3, metadata: {} }));
  eq('A5b confidence clamped to 0', r2.value.confidence, 0);
  eq('A5c verdict REWORK preserved', r2.value.verdict, 'REWORK');
  const fenced = parseGeminiReview('```json\n' + JSON.stringify({ verdict: 'REWORK', findings: [], confidence: 0, metadata: {} }) + '\n```');
  eq('A5d fenced JSON unwrapped', fenced.value.verdict, 'REWORK');
  const long50 = Array.from({ length: 60 }, (_, i) => `f-${i}`);
  const r3 = parseGeminiReview(JSON.stringify({ verdict: 'PASS', findings: long50, confidence: 0.5, metadata: {} }));
  eq('A5e findings bounded to 50', r3.value.findings.length, 50);
  const r4 = parseGeminiReview(JSON.stringify({ verdict: 'PASS', findings: ['x'.repeat(900)], confidence: 0.5, metadata: {} }));
  eq('A5f finding sliced to 500 chars', r4.value.findings[0].length, 500);
}

// ---- B. canonical evidence selection (no parallel truth) ----
{
  const stateDir = mkStateDir();
  const { sessionPath, session, id: ID } = mkSession(stateDir);

  // No packet yet: evidence FAILS CLOSED (D8) — no canonical review packet,
  // no Gemini evidence. No substitute is fabricated.
  const ev0 = collectPreReviewEvidence({ sessionPath, report: { verdict: 'PASS', findings: [] }, reviewReadyDir: path.join(stateDir, 'no-such-dir') });
  falsy('B0 evidence fail-closed without canonical packet', ev0.ok);
  eq('B0b code NO_REVIEW_PACKET', ev0.code, 'NO_REVIEW_PACKET');
  eq('B0c no packet info emitted', ev0.packet, undefined);

  // Canonical packet (self-identifying): included VERBATIM (bounded), never
  // regenerated.
  const packet = mkPacket(stateDir, session);
  const ev1 = collectPreReviewEvidence({ sessionPath, report: {}, reviewReadyDir: packet.dir });
  tru('B1 packet resolved', ev1.packet.ok === true);
  eq('B1b packet excerpt verbatim', ev1.packet.excerpt, packet.content);
  eq('B1c packet name carried', ev1.packet.name, packet.name);
  tru('B1d not truncated', ev1.packet.truncated === false);

  // Bounded: 8KiB head slice, deterministic (identity block kept so the
  // packet still passes the canonical identity gate).
  const big = packet.content + '\n' + 'B'.repeat(PRE_REVIEW_PACKET_MAX_BYTES + 123);
  fs.writeFileSync(path.join(packet.dir, packet.name), big, 'utf8');
  const ev2 = collectPreReviewEvidence({ sessionPath, report: {}, reviewReadyDir: packet.dir });
  eq('B2 excerpt bounded to 8KiB', ev2.packet.excerpt.length <= PRE_REVIEW_PACKET_MAX_BYTES, true);
  tru('B2b truncation flagged', ev2.packet.truncated === true);

  // Binding: a session file NOT at its canonical identity location is refused
  // (readSessionRecord fail-closed) — no foreign evidence can be smuggled in.
  const decoy = path.join(stateDir, 'sessions', 'decoy.json');
  fs.writeFileSync(decoy, JSON.stringify({ schemaVersion: '1', state: 'SESSION_ACTIVE', repo: 'someone-else/repo', issueNumber: 1 }), 'utf8');
  const ev3 = collectPreReviewEvidence({ sessionPath: decoy, report: {} });
  falsy('B3 decoy/misplaced session refused', ev3.ok);
  eq('B3b refusal code', ev3.code, 'SESSION_STATE_INVALID');
}

// ---- B4. bounded deterministic prompt over canonical evidence ----
{
  const stateDir = mkStateDir();
  const { sessionPath, session } = mkSession(stateDir);
  const base = mkPacket(stateDir, session);
  // 8192 budget minus a tiny gap; canonical packet adds ~50 bytes of identity
  // text, so seed the content slice to land within PRE_REVIEW_PACKET_MAX_BYTES.
  const baseLen = Buffer.byteLength(base.content, 'utf8');
  const slice = base.content.slice(0, Math.min(8192, baseLen));
  const packet = mkPacket(stateDir, session, slice + '\nPACKET-EXCERPT-MARKER');
  const ev = collectPreReviewEvidence({
    sessionPath,
    report: { verdict: 'PASS', findings: Array.from({ length: 30 }, (_, i) => `f-${i}-` + 'x'.repeat(400)) },
    reviewReadyDir: packet.dir,
  });
  const p = buildPreReviewPrompt(ev);
  tru('B4 context line has repo/issue/state', p.includes('repo=duongpdddic-droid/soc_brain issue=#75') && p.includes('sessionState=SESSION_ACTIVE'));
  const findingLines = p.split('\n').filter((l) => /^\s+\d+\.\s+f-\d+-/.test(l));
  eq('B4b findings bounded to 20', findingLines.length, 20);
  tru('B4c each finding line <= 286 (prefix + 280)', findingLines.every((l) => l.length <= 286));
  tru('B4d packet excerpt included verbatim', p.includes('PACKET-EXCERPT-MARKER'));
  tru('B4e packet named', p.includes(packet.name));
  let packetGuardThrew = false;
  try { buildPreReviewPrompt({ session, report: {}, ledger: [], packet: { ok: false, code: 'NO_REVIEW_PACKET' } }); }
  catch { packetGuardThrew = true; }
  tru('B4f prompt refuses non-ok packet (fail-closed, no fallback evidence)', packetGuardThrew);
  falsy('B4g no NOT-YET-PROJECTED fallback wording', p.includes('NOT YET PROJECTED'));
  tru('B4h prompt pins the strict schema', p.includes('"verdict": "PASS" | "REWORK"') && p.includes('"confidence": number'));
}

// ---- C. preReview adapter: fail-closed seams, strict verdict mapping ----
{
  eq('C1 null transport -> NO_GEMINI_TRANSPORT', (await geminiPreReviewAdapter({})({ sessionPath: '', report: {} })).code, 'NO_GEMINI_TRANSPORT');
  const stateDir = mkStateDir();
  const { sessionPath } = mkSession(stateDir);
  const passText = () => JSON.stringify({ verdict: 'PASS', findings: ['finding-1'], confidence: 0.95, metadata: {} });
  const good = createGeminiTransport({ apiKey: 'k', model: 'm1', fetchImpl: async () => ({ ok: true, status: 200, body: JSON.stringify({ candidates: [{ content: { parts: [{ text: passText() }] } }] }) }) });
  const rrC = mkPacket(stateDir, { repo: 'duongpdddic-droid/soc_brain', issueNumber: 75 });
  const r = await geminiPreReviewAdapter({ transport: good, reviewReadyDir: rrC.dir })({ sessionPath, report: { verdict: 'PASS', findings: [] } });
  eq('C2 happy ok=true', r.ok, true);
  eq('C2b verdict PASS', r.value.verdict, 'PASS');
  eq('C2c source tag', r.value.metadata.source, 'gemini-pre-review');
  eq('C2d model tag from transport', r.value.metadata.model, 'm1');
  tru('C2e value is DATA (no token/authority/terminalize fields)', !('token' in r.value) && !('terminalize' in r.value) && !('transition' in r.value));
  eq('C3 no-key passthrough', (await geminiPreReviewAdapter({ transport: createGeminiTransport({ apiKey: '' }), reviewReadyDir: rrC.dir })({ sessionPath, report: {} })).code, 'NO_GEMINI_API_KEY');
  eq('C4 transport failure passthrough', (await geminiPreReviewAdapter({ transport: async () => ({ ok: false, code: 'GEMINI_TIMEOUT' }), reviewReadyDir: rrC.dir })({ sessionPath, report: {} })).code, 'GEMINI_TIMEOUT');
  const rMal = await geminiPreReviewAdapter({ transport: async () => ({ ok: true, text: 'not json {{' }), reviewReadyDir: rrC.dir })({ sessionPath, report: {} });
  eq('C5 malformed -> MALFORMED', rMal.code, 'GEMINI_RESPONSE_MALFORMED');
  const rNonPass = await geminiPreReviewAdapter({ transport: async () => ({ ok: true, text: JSON.stringify({ verdict: 'ISSUES', findings: ['f'], confidence: 0.5, metadata: {} }) }), reviewReadyDir: rrC.dir })({ sessionPath, report: {} });
  eq('C6 non-PASS/REWORK verdict fail-closed (never lenient-mapped)', rNonPass.code, 'GEMINI_VERDICT_INVALID');
}

// ---- D. LOOP-LEVEL authority (runControlLoop, deterministic fake transport) ----
// runControlLoop requires an EMPTY ledger (it seeds ACCEPTED->ROUTED itself);
// baseDeps fakes router/executor/verifier so the loop reaches PRE_REVIEWING
// with the REAL gemini pre-review adapter in the chain.
function baseDeps(stateDir, calls, transport) {
  const rr = mkPacket(stateDir, { repo: 'duongpdddic-droid/soc_brain', issueNumber: 75 }); // canonical packet REQUIRED for PRE_REVIEWING (D8)
  return {
    reviewReadyDir: rr.dir,
    router: () => { calls.push('router'); return { ok: true, value: { executorKind: 'opencode', model: 'x' } }; },
    executor: () => { calls.push('executor'); return { ok: true, value: { executionRecordPath: '/fake/execution.json' } }; },
    verifier: () => { calls.push('verifier'); return { ok: true, value: { verdict: 'PASS', findings: [], report: 'ok' } }; },
    preReview: geminiPreReviewAdapter({ transport, reviewReadyDir: rr.dir }),
    finalReview: () => { calls.push('finalReview'); return { ok: true, value: { verdict: 'PASS', findings: [] } }; },
    delivery: () => { calls.push('delivery'); return { ok: true, value: { shipped: true } }; },
    telegramSpawn: () => ({ stdout: `${JSON.stringify({ ok: true, status: 'API_ACCEPTED', messageId: 900 })}\n` }),
  };
}

// D1: real Gemini transport PASS always reaches FINAL_REVIEWING; delivery/
// COMPLETED still requires GPT final review PASS. The Gemini value is data:
// finalReview receives it, DECIDING consumes only decision.verdict.
{
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  const calls = [];
  const seen = [];
  const transport = async (arg) => { seen.push(Object.keys(arg || {})); calls.push('transport'); return { ok: true, text: JSON.stringify({ verdict: 'PASS', findings: [], confidence: 0.9, metadata: {} }) }; };
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: baseDeps(stateDir, calls, transport) });
  eq('D1 completed', res.value && res.value.state, 'COMPLETED');
  const iTr = calls.indexOf('transport'); const iFr = calls.indexOf('finalReview'); const iDe = calls.indexOf('delivery');
  tru('D1b transport ran before finalReview before delivery', iTr !== -1 && iFr !== -1 && iDe !== -1 && iTr < iFr && iFr < iDe);
  const ledger = readTransitions({ stateDir, identityHash: ID });
  const tos = ledger.map((r) => r.to);
  tru('D1c PRE_REVIEWING -> FINAL_REVIEWING on Gemini PASS', ledger.some((r) => r.from === 'PRE_REVIEWING' && r.to === 'FINAL_REVIEWING'));
  const iPr = ledger.findIndex((r) => r.from === 'PRE_REVIEWING' && r.to === 'FINAL_REVIEWING');
  const iFrL = ledger.findIndex((r) => r.from === 'FINAL_REVIEWING' && r.to === 'DECIDING');
  tru('D1d pre-review precedes final review in the canonical ledger', iPr !== -1 && iFrL !== -1 && iPr < iFrL);
  eq('D1e transport receives ONLY {prompt} (no session/token/authority)', seen[0].join(','), 'prompt');
}

// D2: Gemini PASS alone never reaches DELIVERING/COMPLETED — only finalReview
// PASS allows delivery. Malformed pre-review response -> fail-closed before
// FINAL_REVIEWING; finalReview and delivery are never invoked.
{
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  const calls = [];
  const deps = baseDeps(stateDir, calls, async () => ({ ok: true, text: 'not json {{' }));
  deps.finalReview = () => { calls.push('finalReview'); return { ok: true, value: { verdict: 'PASS', findings: [] } }; };
  deps.delivery = () => { calls.push('delivery'); return { ok: true, value: { shipped: true } }; };
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  falsy('D2 malformed pre-review -> loop fail-closed', res.ok);
  eq('D2b fail code', res.code, 'PRE_REVIEW_FAILED');
  const ledger = readTransitions({ stateDir, identityHash: ID });
  const tos = ledger.map((r) => r.to);
  falsy('D2c DELIVERING unreachable on pre-review failure', tos.includes('DELIVERING'));
  falsy('D2d COMPLETED unreachable on pre-review failure', tos.includes('COMPLETED'));
  falsy('D2e finalReview never invoked on pre-review failure', calls.includes('finalReview'));
  falsy('D2f delivery never invoked on pre-review failure', calls.includes('delivery'));
}

// D3: Gemini transport throw -> loop fail-closed; session NOT terminalized.
{
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  const res = await runControlLoop({
    sessionPath, identityHash: ID, stateDir,
    deps: baseDeps(stateDir, [], async () => { throw new Error('socket exploded'); }),
  });
  falsy('D3 transport throw -> loop fail-closed', res.ok);
  eq('D3b fail code PRE_REVIEW_FAILED', res.code, 'PRE_REVIEW_FAILED');
  const tos = readTransitions({ stateDir, identityHash: ID }).map((r) => r.to);
  falsy('D3c no DELIVERING/COMPLETED', tos.includes('DELIVERING') || tos.includes('COMPLETED'));
  const rec = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  eq('D3d session not terminalized by pre-review', rec.state, 'SESSION_ACTIVE');
}

// D6: foreign session refused before any transition (binding authority).
{
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir, { taskId: 'someone-else/repo#1', repo: 'someone-else/repo', issueNumber: 1 });
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: baseDeps(stateDir, [], async () => ({ ok: true, text: '{"verdict":"PASS"}' })) });
  falsy('D6 foreign session refused', res.ok);
  eq('D6b IDENTITY_MISMATCH', res.code, 'IDENTITY_MISMATCH');
  eq('D6c zero canonical transitions written', readTransitions({ stateDir, identityHash: ID }).length, 0);
}

// D7: pre-review adapter cannot terminalize or mutate canonical task state.
// It has no loop token; terminalize requires the session-bound token minted
// inside bindLoop (assertTerminalizationAuthorized).
{
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  const loop = bindLoop({ sessionPath, identityHash: ID, stateDir });
  // Standalone adapter test: seed the ledger up to VERIFYING directly.
  loop.transition({ from: 'ACCEPTED', to: 'ROUTED', reason: 'seed' });
  loop.transition({ from: 'ROUTED', to: 'EXECUTING', reason: 'seed' });
  loop.transition({ from: 'EXECUTING', to: 'VERIFYING', reason: 'seed' });
  const adapter = geminiPreReviewAdapter({
    transport: async () => ({ ok: true, text: JSON.stringify({ verdict: 'PASS', findings: [], confidence: 1, metadata: {} }) }),
    reviewReadyDir: mkPacket(stateDir, { repo: 'duongpdddic-droid/soc_brain', issueNumber: 75 }).dir,
  });
  const before = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  const r = await adapter({ sessionPath, report: { verdict: 'PASS', findings: [] } });
  eq('D7 pre-review ok on PASS', r.ok, true);
  const after = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  eq('D7b session record byte-identical after pre-review', JSON.stringify(after), JSON.stringify(before));
  eq('D7c ledger untouched by pre-review adapter', readTransitions({ stateDir, identityHash: ID }).length, 3);
  const t = loop.terminalize({ outcome: 'COMPLETED', decision: r.value });
  // loop here is an UNBOUND binder (bindLoop mints the token but only
  // runControlLoop binds it into the session) — exactly the position an
  // adapter/transport is in: no bound token -> terminalize refused.
  falsy('D7d terminalize refused', t.ok);
  eq('D7e refusal code NOT_CONTROL_LOOP_BOUND', t.code, 'NOT_CONTROL_LOOP_BOUND');
  const rec2 = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  eq('D7f session still not terminal', rec2.state, 'SESSION_ACTIVE');
}

// D4: finalReview REWORK drives REWORK even when Gemini said PASS; delivery
// is never attempted on REWORK.
{
  const stateDir = mkStateDir();
  const { sessionPath, id: ID } = mkSession(stateDir);
  const calls = [];
  const deps = baseDeps(stateDir, calls, async () => ({ ok: true, text: JSON.stringify({ verdict: 'PASS', findings: [], confidence: 0.99, metadata: {} }) }));
  deps.finalReview = () => { calls.push('finalReview'); return { ok: true, value: { verdict: 'REWORK', findings: ['fix-me'] } }; };
  deps.delivery = () => { calls.push('delivery'); return { ok: true, value: { shipped: true } }; };
  const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
  tru('D4 loop ok', res.ok);
  eq('D4b state REWORK (Gemini PASS did not bypass GPT rework)', res.value.state, 'REWORK');
  const ledger = readTransitions({ stateDir, identityHash: ID });
  tru('D4c REWORK transition driven by final-review-rework', ledger.some((r) => r.to === 'REWORK' && r.reason === 'final-review-rework'));
  falsy('D4d no delivery on REWORK', calls.includes('delivery'));
}

// D5: finalReview PASS is the ONLY review verdict that can allow delivery.
{
  for (const blockerVerdict of ['REWORK', 'BLOCKED', 'GARBAGE']) {
    const stateDir = mkStateDir();
    const { sessionPath, id: ID } = mkSession(stateDir);
    const deps = baseDeps(stateDir, [], async () => ({ ok: true, text: JSON.stringify({ verdict: 'PASS', findings: [], confidence: 0.9, metadata: {} }) }));
    // Real final-review adapter in the chain: REWORK/BLOCKED pass through,
    // anything outside {PASS,REWORK,BLOCKED} is rejected fail-closed.
    deps.finalReview = gptFinalReviewAdapter({ transport: async () => ({ ok: true, value: { verdict: blockerVerdict, findings: [] } }) });
    deps.delivery = () => ({ ok: true, value: { shipped: true } });
    const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
    if (blockerVerdict === 'BLOCKED') {
      eq(`D5 finalReview ${blockerVerdict} -> BLOCKED`, res.value.state, 'BLOCKED');
    } else if (blockerVerdict === 'REWORK') {
      eq(`D5 finalReview ${blockerVerdict} -> REWORK`, res.value.state, 'REWORK');
    } else {
      falsy(`D5 finalReview ${blockerVerdict} -> loop fail-closed (no COMPLETED)`, res.ok);
    }
    const tos = readTransitions({ stateDir, identityHash: ID }).map((r) => r.to);
    eq(`D5b finalReview ${blockerVerdict}: no DELIVERING/COMPLETED`, tos.includes('DELIVERING') || tos.includes('COMPLETED'), false);
  }
}

// D8: the canonical review-ready packet is REQUIRED semantic review evidence.
// Missing / unreadable / identity-mismatched / stale packets fail closed
// BEFORE Gemini is invoked; a valid canonical packet lets it through.
{
  const passText = () => JSON.stringify({ verdict: 'PASS', findings: [], confidence: 0.9, metadata: {} });
  // D8a: valid canonical packet -> Gemini called exactly once, loop completes.
  {
    const stateDir = mkStateDir();
    const { sessionPath, id: ID } = mkSession(stateDir);
    const calls = [];
    const transport = async () => { calls.push('transport'); return { ok: true, text: passText() }; };
    const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps: baseDeps(stateDir, calls, transport) });
    eq('D8a valid packet -> Gemini called, loop COMPLETED', res.value && res.value.state, 'COMPLETED');
    eq('D8b transport invoked exactly once', calls.filter((c) => c === 'transport').length, 1);
  }
  // D8c: missing packet -> fail closed, Gemini NOT called, no FINAL_REVIEWING.
  {
    const stateDir = mkStateDir();
    const { sessionPath, id: ID } = mkSession(stateDir);
    const calls = [];
    const deps = baseDeps(stateDir, calls, async () => { calls.push('transport'); return { ok: true, text: passText() }; });
    // After baseDeps seeded the canonical packet, remove it so PRE_REVIEWING sees no evidence.
    const rrDir = deps.reviewReadyDir;
    const ls = fs.readdirSync(rrDir);
    for (const f of ls) fs.rmSync(path.join(rrDir, f));
    const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
    falsy('D8c missing packet -> loop fail-closed', res.ok);
    eq('D8d fail code PRE_REVIEW_FAILED', res.code, 'PRE_REVIEW_FAILED');
    falsy('D8e Gemini NOT called without packet', calls.includes('transport'));
    falsy('D8f no FINAL_REVIEWING reached', readTransitions({ stateDir, identityHash: ID }).map((r) => r.to).includes('FINAL_REVIEWING'));
  }
  // D8g: unreadable packet (non-UTF8 binary garbage) -> fail closed.
  {
    const stateDir = mkStateDir();
    const { sessionPath, id: ID } = mkSession(stateDir);
    const calls = [];
    const deps = baseDeps(stateDir, calls, async () => { calls.push('transport'); return { ok: true, text: passText() }; });
    const rrDir = deps.reviewReadyDir;
    for (const f of fs.readdirSync(rrDir)) fs.writeFileSync(path.join(rrDir, f), Buffer.from([0xff, 0xfe, 0x00, 0x01]));
    const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
    falsy('D8g unreadable packet -> fail-closed', res.ok);
    falsy('D8h Gemini NOT called on unreadable packet', calls.includes('transport'));
  }

  // D8i: foreign-identity packet (canonical filename, foreign Identity block)
  // -> fail closed, Gemini NOT called.
  {
    const stateDir = mkStateDir();
    const { sessionPath, id: ID } = mkSession(stateDir);
    const calls = [];
    const deps = baseDeps(stateDir, calls, async () => { calls.push('transport'); return { ok: true, text: passText() }; });
    const rrDir = deps.reviewReadyDir;
    const foreign = [
      '# Review Ready — someone-else/repo Issue #1 · PR #76', '', '## Identity',
      '- repository: someone-else/repo', '- issue: 1', '- pullRequest: 76', '- branch: x',
      `- headSha: ${'a'.repeat(40)} (short aaaaaaa)`, `- baseSha: ${'b'.repeat(40)}`, '- prState: OPEN', '', 'foreign body',
    ].join('\n');
    for (const f of fs.readdirSync(rrDir)) fs.writeFileSync(path.join(rrDir, f), foreign, 'utf8');
    const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
    falsy('D8i foreign-identity packet -> fail-closed', res.ok);
    falsy('D8j Gemini NOT called on foreign packet', calls.includes('transport'));
  }
  // D8k: identity-less packet body -> fail closed, Gemini NOT called.
  {
    const stateDir = mkStateDir();
    const { sessionPath, id: ID } = mkSession(stateDir);
    const calls = [];
    const deps = baseDeps(stateDir, calls, async () => { calls.push('transport'); return { ok: true, text: passText() }; });
    const rrDir = deps.reviewReadyDir;
    for (const f of fs.readdirSync(rrDir)) fs.writeFileSync(path.join(rrDir, f), 'no identity block here', 'utf8');
    const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
    falsy('D8k identity-less packet -> fail-closed', res.ok);
    falsy('D8l Gemini NOT called on identity-less packet', calls.includes('transport'));
  }
  // D8m: stale headSha (session pins a newer HEAD than the packet) -> fail closed.
  {
    const stateDir = mkStateDir();
    const { sessionPath, id: ID } = mkSession(stateDir, { headSha: 'c'.repeat(40) });
    const calls = [];
    const deps = baseDeps(stateDir, calls, async () => { calls.push('transport'); return { ok: true, text: passText() }; });
    // baseDeps seeds a packet with headSha=aaaa (default); session pins cccc -> STALE.
    const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
    falsy('D8m stale headSha packet -> fail-closed', res.ok);
    falsy('D8n Gemini NOT called on stale packet', calls.includes('transport'));
  }
  // D8o: packet headSha matching the session HEAD -> Gemini called.
  {
    const stateDir = mkStateDir();
    const { sessionPath, id: ID } = mkSession(stateDir, { headSha: 'c'.repeat(40) });
    const calls = [];
    const deps = baseDeps(stateDir, calls, async () => { calls.push('transport'); return { ok: true, text: passText() }; });
    // Rewrite the seeded packet so its headSha matches the session.
    const rrDir = deps.reviewReadyDir;
    const matching = [
      '# Review Ready — duongpdddic-droid/soc_brain Issue #75 · PR #76', '', '## Identity',
      '- repository: duongpdddic-droid/soc_brain', '- issue: 75', '- pullRequest: 76', '- branch: agent/test',
      `- headSha: ${'c'.repeat(40)} (short ccccccc)`, `- baseSha: ${'b'.repeat(40)}`, '- prState: OPEN', '', 'matching body',
    ].join('\n');
    for (const f of fs.readdirSync(rrDir)) fs.writeFileSync(path.join(rrDir, f), matching, 'utf8');
    const res = await runControlLoop({ sessionPath, identityHash: ID, stateDir, deps });
    eq('D8o matching headSha -> Gemini called, COMPLETED', res.value && res.value.state, 'COMPLETED');
  }
}

// ---- summary ----
const failed = checks.filter((c) => !c.ok);
for (const c of checks) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : ` | got=${JSON.stringify(c.got)} want=${JSON.stringify(c.want)}`}`);
}
console.log(`control-loop-gemini: ${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
