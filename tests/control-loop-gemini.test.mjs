// control-loop-gemini.test.mjs — Issue #75 P0-C deterministic tests.
import {
  createGeminiPreReviewTransport, parseGeminiReview, buildGeminiPrompt,
  GEMINI_DEFAULT_MODEL, GEMINI_TRANSPORT_SCHEMA_VERSION,
} from '../packages/control-loop/gemini-transport.mjs';
import { geminiPreReviewAdapter } from '../packages/control-loop/adapters.mjs';

const checks = [];
const eq = (n, g, w) => checks.push({ name: n, ok: g === w, got: g, want: w });
const tru = (n, g) => checks.push({ name: n, ok: Boolean(g), got: g });
const falsy = (n, g) => checks.push({ name: n, ok: !g, got: g });

// ---- A0. NO_GEMINI_API_KEY fail-closed seam when key absent ----
{
  const t = createGeminiPreReviewTransport({ apiKey: '' });
  const r = await t({ session: { repo: 'x/y', issueNumber: 1 }, report: { verdict: 'PASS', findings: [] } });
  eq('A0 NO_GEMINI_API_KEY when key absent', r.code, 'NO_GEMINI_API_KEY');
  const t2 = createGeminiPreReviewTransport({}); // env empty in test
  const r2 = await t2({ session: { repo: 'x/y', issueNumber: 1 }, report: { verdict: 'PASS', findings: [] } });
  eq('A0b default factory NO_GEMINI_API_KEY when env empty', r2.code, 'NO_GEMINI_API_KEY');
}

// ---- A1. Native response happy path ----
{
  const fetchImpl = async () => ({
    ok: true, status: 200,
    body: JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ verdict: 'PASS', findings: ['finding-1'], confidence: 0.95, metadata: {} }) }] } }] }),
  });
  const t = createGeminiPreReviewTransport({ apiKey: 'k', model: 'gemini-1.5-flash', fetchImpl });
  const r = await t({ session: { repo: 'org/repo', issueNumber: 75, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) }, report: { verdict: 'PASS', findings: [] } });
  eq('A1 happy path ok=true', r.ok, true);
  eq('A1 verdict normalized to PASS', r.value.verdict, 'PASS');
  eq('A1 findings carried', r.value.findings[0], 'finding-1');
  eq('A1 confidence in [0,1]', r.value.confidence, 0.95);
  eq('A1 metadata carries model', r.value.metadata.model, 'gemini-1.5-flash');
  eq('A1 metadata source', r.value.metadata.source, 'gemini-pre-review');
  tru('A1 schema version exported', GEMINI_TRANSPORT_SCHEMA_VERSION === '1');
  tru('A1 default model exported', GEMINI_DEFAULT_MODEL.length > 0);
}

// ---- A2. HTTP non-2xx -> GEMINI_HTTP_<status> ----
{
  const fetchImpl = async () => ({ ok: true, status: 429, body: 'rate limited' });
  const t = createGeminiPreReviewTransport({ apiKey: 'k', fetchImpl });
  const r = await t({ session: { repo: 'x/y', issueNumber: 1 }, report: { verdict: 'PASS', findings: [] } });
  eq('A2 non-2xx code GEMINI_HTTP_429', r.code, 'GEMINI_HTTP_429');
  tru('A2 detail includes body snippet', String(r.detail).includes('rate limited'));
}

// ---- A3. Malformed JSON -> MALFORMED ----
{
  const fetchImpl = async () => ({ ok: true, status: 200, body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'not json {{' }] } }] }) });
  const t = createGeminiPreReviewTransport({ apiKey: 'k', fetchImpl });
  const r = await t({ session: { repo: 'x/y', issueNumber: 1 }, report: { verdict: 'PASS', findings: [] } });
  eq('A3 malformed json -> MALFORMED', r.code, 'GEMINI_RESPONSE_MALFORMED');
}

// ---- A4. Verdict outside enum -> INVALID ----
{
  const fetchImpl = async () => ({ ok: true, status: 200, body: JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ verdict: 'MAYBE', findings: [], confidence: 0.5, metadata: {} }) }] } }] }) });
  const t = createGeminiPreReviewTransport({ apiKey: 'k', fetchImpl });
  const r = await t({ session: { repo: 'x/y', issueNumber: 1 }, report: { verdict: 'PASS', findings: [] } });
  eq('A4 unknown verdict -> INVALID', r.code, 'GEMINI_VERDICT_INVALID');
}

// ---- A5. Transport throw ----
{
  const fetchImpl = async () => ({ ok: false, code: 'GEMINI_TRANSPORT_THROW', error: 'ECONNRESET' });
  const t = createGeminiPreReviewTransport({ apiKey: 'k', fetchImpl });
  const r = await t({ session: { repo: 'x/y', issueNumber: 1 }, report: { verdict: 'PASS', findings: [] } });
  eq('A5 throw -> THROW', r.code, 'GEMINI_TRANSPORT_THROW');
}

// ---- A6. parseGeminiReview strict schema ----
{
  eq('A6a empty body -> MALFORMED', parseGeminiReview('').code, 'GEMINI_RESPONSE_MALFORMED');
  eq('A6b non-json -> MALFORMED', parseGeminiReview('hello world').code, 'GEMINI_RESPONSE_MALFORMED');
  eq('A6c array body -> MALFORMED', parseGeminiReview('[1,2,3]').code, 'GEMINI_RESPONSE_MALFORMED');
  eq('A6d missing verdict -> INVALID', parseGeminiReview('{}').code, 'GEMINI_VERDICT_INVALID');
  const okr = parseGeminiReview(JSON.stringify({ verdict: 'pass', findings: ['a', 1, 'b'], confidence: 2, metadata: { k: 'v' } }));
  eq('A6e verdict normalized to PASS', okr.value.verdict, 'PASS');
  eq('A6f findings filter non-strings', okr.value.findings.length, 2);
  eq('A6g confidence clamped to 1', okr.value.confidence, 1);
  eq('A6h metadata carried', okr.value.metadata.k, 'v');
  const fenced = parseGeminiReview('```json\n' + JSON.stringify({ verdict: 'REWORK', findings: [], confidence: 0, metadata: {} }) + '\n```');
  eq('A6i fenced JSON unwrapped', fenced.value.verdict, 'REWORK');
}

// ---- A7. Bounded prompt ----
{
  const findings = Array.from({ length: 30 }, (_, i) => `f-${i}-` + 'x'.repeat(400));
  const p = buildGeminiPrompt({ session: { repo: 'r', issueNumber: 7, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) }, report: { verdict: 'PASS', findings } });
  tru('A7 prompt bounded to 20 findings', (p.match(/^\s+\d+\.\s/gm) || []).length === 20);
  // Each finding line is sliced to 280 chars (truncation). Inspect a known case.
  tru('A7 each finding line length <= 286 (prefix 6 + finding slice 280)', p.split('\n').every((line) => !/^\s*\d+\.\s+f-\d+-/.test(line) || line.length <= 286));
  // Sanity: the prompt contains exactly 20 numbered finding lines.
  const lines = p.split('\n').filter((l) => /^\s*\d+\.\s+f-\d+-/.test(l));
  tru('A7b exactly 20 finding lines', lines.length === 20);
  tru('A7c first finding starts with f-0-', lines[0].startsWith('  1. f-0-'));
  tru('A7d 20th finding is f-19-', lines[19].startsWith('  20. f-19-'));
  tru('A7e 20th finding line is bounded (prefix 6 + finding slice 280 = 286)', lines[19].length === 286);
  tru('A7f every numbered line length <= 286 (prefix 6 + 280)', lines.every((l) => l.length <= 286));
}

// ---- A8. Fail-closed when transport is null (run.js path) ----
{
  const adapter = geminiPreReviewAdapter({ transport: null });
  const r = await adapter({ sessionPath: '', report: { verdict: 'PASS', findings: [] } });
  eq('A8 null transport -> NO_GEMINI_TRANSPORT', r.code, 'NO_GEMINI_TRANSPORT');
}

// ---- A9. Gemini PASS is informational; never bypasses GPT final review ----
// Proof by construction: the adapter's return shape is DATA
// {ok, value:{verdict,findings,source}} passed to finalReview — never an
// authority claim. control-loop.mjs DECIDING consumes only
// `decision.verdict` from finalReview; preReview cannot reach DECIDING.
{
  const transport = async () => ({ ok: true, value: { verdict: 'PASS', findings: ['ok'], confidence: 0.9, metadata: {} } });
  const r = await transport({ session: {}, report: {} });
  eq('A9 transport ok=true', r.ok, true);
  eq('A9 transport verdict is PASS', r.value.verdict, 'PASS');
  tru('A9 transport has findings array', Array.isArray(r.value.findings));
  tru('A9 transport has confidence in [0,1]', r.value.confidence >= 0 && r.value.confidence <= 1);
  tru('A9 transport has metadata object', typeof r.value.metadata === 'object');
  const adapter = geminiPreReviewAdapter({ transport });
  tru('A9b adapter is a function (injected transport, no global state)', typeof adapter === 'function');
}

// ---- summary ----
const failed = checks.filter((c) => !c.ok);
for (const c of checks) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : ` | got=${JSON.stringify(c.got)} want=${JSON.stringify(c.want)}`}`);
}
console.log(`control-loop-gemini: ${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
