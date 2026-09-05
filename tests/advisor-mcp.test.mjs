#!/usr/bin/env node
// advisor-mcp.test.mjs — tests for packages/advisor-mcp (Issue #63).
// Proves: bounded 3-tool surface; strict input validation; anti-stale/anti-replay
// echo binding (requestId + binds{repo,taskRef,stateDigest}); decision enum
// contract; fail-closed error codes; MCP JSON-RPC round-trip with a MOCKED
// transport (no network, no secrets in tests). Real-model E2E lives in
// scripts/e2e-advisor-control-path.mjs (never run by `pnpm test`).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DECISIONS,
  TOOL_NAMES,
  advisorEnv,
  askAdvisor,
  buildPrompt,
  chatCompletionsUrl,
  createAdvisorMcp,
  parseModelJson,
  validateAskArgs,
  validateDecisionReply,
} from '../packages/advisor-mcp/advisor-mcp.mjs';

const PKT = {
  requestId: 'req-2026-09-05-001',
  repo: 'duongpdddic-droid/Soc_brain',
  taskRef: 'Issue #63',
  stateDigest: 'a'.repeat(64),
  question: 'Continue implementation or stop?',
  evidence: 'branch agent/x @ base 4e65213; tests 12 PASS',
};

const GOOD_REPLY = {
  requestId: PKT.requestId,
  decision: 'CONTINUE',
  reasoning: 'Acceptance criteria not yet met.',
  nextAction: 'Finish the E2E script and run it.',
  confidence: 0.8,
  binds: { repo: PKT.repo, taskRef: PKT.taskRef, stateDigest: PKT.stateDigest },
};

function okFetch(text) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ model: 'mock/model', choices: [{ message: { content: text } }] }),
    text: async () => text,
  });
}

// ---- unit: env + validation -------------------------------------------------

test('unit: advisorEnv reads key + base URL + model overrides', () => {
  const env = advisorEnv({
    SOC_ADVISOR_API_KEY: 'k',
    SOC_ADVISOR_BASE_URL: 'http://127.0.0.1:20128/v1',
    SOC_ADVISOR_GPT_MODEL: 'openai/x',
    SOC_ADVISOR_GEMINI_MODEL: 'google/y',
  });
  assert.deepEqual(env, {
    apiKey: 'k',
    baseUrl: 'http://127.0.0.1:20128/v1',
    gptModel: 'openai/x',
    geminiModel: 'google/y',
  });
  const empty = advisorEnv({});
  assert.equal(empty.apiKey, '');
  assert.equal(empty.baseUrl, 'https://openrouter.ai/api/v1');
  // Default GPT = OpenAI's open-weight gpt-oss-120b served via Groq (free
  // tier, actual OpenAI upstream — see advisor-mcp.mjs DEFAULT_GPT_MODEL note).
  assert.equal(empty.gptModel, 'groq/openai/gpt-oss-120b');
  assert.equal(empty.geminiModel, 'gemini/gemini-3.8-flash');
  const legacy = advisorEnv({ OPENROUTER_API_KEY: 'legacy' });
  assert.equal(legacy.apiKey, 'legacy');
  assert.equal(chatCompletionsUrl('http://127.0.0.1:20128/v1/'), 'http://127.0.0.1:20128/v1/chat/completions');
});

test('unit: validateAskArgs accepts a valid packet and rejects every malformed field', () => {
  const ok = validateAskArgs({ ...PKT });
  assert.equal(ok.ok, true);
  assert.equal(ok.packet.stateDigest, PKT.stateDigest);
  const rejects = (label, args, code) => {
    const r = validateAskArgs(args);
    assert.equal(r.ok, false, label);
    assert.equal(r.code, code, label);
  };
  rejects('null', null, 'ARGS_INVALID');
  rejects('array', [], 'ARGS_INVALID');
  rejects('extra key', { ...PKT, z: 1 }, 'ARGS_INVALID');
  rejects('missing key', (() => { const c = { ...PKT }; delete c.evidence; return c; })(), 'ARGS_INVALID');
  rejects('short requestId', { ...PKT, requestId: 'ab' }, 'REQUEST_ID_INVALID');
  rejects('bad repo', { ...PKT, repo: 'no-slash' }, 'REPO_INVALID');
  rejects('bad taskRef', { ...PKT, taskRef: 'bad|ref' }, 'TASK_REF_INVALID');
  rejects('bad digest', { ...PKT, stateDigest: 'zz' }, 'STATE_DIGEST_INVALID');
  rejects('empty question', { ...PKT, question: '  ' }, 'QUESTION_INVALID');
  rejects('empty evidence', { ...PKT, evidence: '' }, 'EVIDENCE_INVALID');
});

test('unit: bounded payload — oversized packet is rejected', () => {
  const r = validateAskArgs({ ...PKT, evidence: 'x'.repeat(64 * 1024 + 1) });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'BOUNDED_PAYLOAD_EXCEEDED');
});

// ---- unit: prompt + reply validation (anti-stale binding) -------------------

test('unit: buildPrompt embeds requestId, binds source values, role by mode', () => {
  const p1 = buildPrompt(PKT, { mode: 'decision' });
  assert.ok(p1.includes(PKT.requestId));
  assert.ok(p1.includes(PKT.repo) && p1.includes(PKT.taskRef) && p1.includes(PKT.stateDigest));
  assert.ok(p1.includes('DECISION authority'));
  const p2 = buildPrompt(PKT, { mode: 'second_opinion' });
  assert.ok(p2.includes('SECOND-OPINION'));
  assert.ok(!p2.includes('DECISION authority'));
});

test('unit: parseModelJson accepts pure JSON and one fenced block, rejects prose', () => {
  assert.equal(parseModelJson(JSON.stringify(GOOD_REPLY)).ok, true);
  assert.equal(parseModelJson('```json\n' + JSON.stringify(GOOD_REPLY) + '\n```').ok, true);
  assert.equal(parseModelJson('').code, 'EMPTY_RESPONSE');
  assert.equal(parseModelJson('I think CONTINUE is right').code, 'JSON_PARSE_FAILED');
  assert.equal(parseModelJson('[1,2]').code, 'JSON_PARSE_FAILED');
});

test('unit: validateDecisionReply — happy path', () => {
  const v = validateDecisionReply(GOOD_REPLY, PKT);
  assert.equal(v.ok, true);
  assert.equal(v.decision.decision, 'CONTINUE');
  assert.deepEqual(v.decision.binds, { repo: PKT.repo, taskRef: PKT.taskRef, stateDigest: PKT.stateDigest });
});

test('unit: validateDecisionReply — fail-closed on stale/malformed binding', () => {
  const bad = (label, obj) => {
    const r = validateDecisionReply(obj, PKT);
    assert.equal(r.ok, false, label);
    assert.ok(['REQUEST_ID_MISMATCH', 'BINDING_MISMATCH', 'DECISION_INVALID', 'CONFIDENCE_INVALID'].includes(r.code), label + ' code=' + r.code);
  };
  bad('stale requestId', { ...GOOD_REPLY, requestId: 'req-old-0000-999' });
  bad('missing requestId', (() => { const c = { ...GOOD_REPLY }; delete c.requestId; return c; })());
  bad('missing binds', (() => { const c = { ...GOOD_REPLY }; delete c.binds; return c; })());
  bad('stale repo', { ...GOOD_REPLY, binds: { ...PKT.binds, repo: 'other/repo' } });
  bad('stale digest', { ...GOOD_REPLY, binds: { ...PKT.binds, stateDigest: 'b'.repeat(64) } });
  bad('bad decision', { ...GOOD_REPLY, decision: 'MAYBE' });
  bad('bad confidence', { ...GOOD_REPLY, confidence: 7 });
});

test('unit: decision enum matches the bootstrap contract', () => {
  assert.deepEqual([...DECISIONS].sort(), ['ASK_GEMINI', 'CONTINUE', 'HUMAN_GATE_REQUIRED', 'REWORK', 'TASK_ACCEPTED', 'USE_OTHER_EXECUTOR']);
});

// ---- unit: askAdvisor pipeline with mocked fetch ----------------------------

test('unit: askAdvisor (mock) returns validated decision', async () => {
  const r = await askAdvisor(PKT, { mode: 'decision', model: 'mock/gpt', apiKey: 'k', fetchImpl: okFetch(JSON.stringify(GOOD_REPLY)) });
  assert.equal(r.ok, true);
  assert.equal(r.decision.decision, 'CONTINUE');
  assert.equal(r.modelUsed, 'mock/model');
});

test('unit: askAdvisor (mock) fail-closed on every malformed provider reply', async () => {
  const cases = [
    ['non-JSON', okFetch('CONTINUE, obviously')],
    ['fenced-with-prose', okFetch('Here is my answer:\n```json\n' + JSON.stringify(GOOD_REPLY) + '\n```')],
    ['stale-bind', okFetch(JSON.stringify({ ...GOOD_REPLY, binds: { ...PKT.binds, taskRef: 'Issue #1' } }))],
  ];
  for (const [label, impl] of cases) {
    const r = await askAdvisor(PKT, { mode: 'decision', model: 'mock/gpt', apiKey: 'k', fetchImpl: impl });
    assert.equal(r.ok, false, label);
  }
  const noKey = await askAdvisor(PKT, { mode: 'decision', model: 'mock/gpt', apiKey: '', fetchImpl: okFetch(JSON.stringify(GOOD_REPLY)) });
  assert.equal(noKey.code, 'MISSING_API_KEY');
  const httpErr = await askAdvisor(PKT, { mode: 'decision', model: 'mock/gpt', apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'no auth' }) });
  assert.equal(httpErr.code, 'PROVIDER_ERROR');
});

// ---- unit: MCP JSON-RPC surface ---------------------------------------------

test('unit: tools/list exposes exactly the 3 bounded tools', () => {
  const mcp = createAdvisorMcp({ apiKey: 'k', gptModel: 'openai/x', geminiModel: 'google/y' });
  const names = mcp.handleRequest({ id: 1, method: 'tools/list' }).result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['advisor.ask', 'advisor.ping', 'advisor.second_opinion']);
});

test('unit: ping payload is deterministic and never leaks the key', () => {
  // baseUrl truyền tường minh: test không phụ thuộc process.env (E2E set override).
  const mcp = createAdvisorMcp({ apiKey: 'secret-key', baseUrl: 'https://openrouter.ai/api/v1', gptModel: 'openai/x', geminiModel: 'google/y' });
  const res = JSON.parse(mcp.handleRequest({ id: 2, method: 'tools/call', params: { name: TOOL_NAMES.ping } }).result.content[0].text);
  assert.deepEqual(res, {
    ok: true,
    service: 'soc_brain',
    mode: 'advisor',
    models: { gpt: 'openai/x', gemini: 'google/y' },
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyPresent: true,
  });
  assert.ok(!JSON.stringify(res).includes('secret-key'));
});

test('unit: initialize + unknown method negotiation', () => {
  const mcp = createAdvisorMcp({ apiKey: 'k' });
  const init = mcp.handleRequest({ id: 3, method: 'initialize', params: {} }).result;
  assert.equal(init.serverInfo.name, 'soc-brain-advisor');
  assert.equal(mcp.handleRequest({ id: 4, method: 'notifications/initialized' }), null);
  assert.equal(mcp.handleRequest({ id: 5, method: 'tools/call', params: { name: 'nope' } }).error.code, -32601);
});

test('unit: tools/call advisor.ask round-trip through mocked fetch', async () => {
  const mcp = createAdvisorMcp({ apiKey: 'k', gptModel: 'mock/gpt', geminiModel: 'mock/gemini', fetchImpl: okFetch(JSON.stringify(GOOD_REPLY)) });
  const res = await mcp.handleRequest({ id: 6, method: 'tools/call', params: { name: TOOL_NAMES.ask, arguments: { ...PKT } } });
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.ok, true);
  assert.equal(payload.decision, 'CONTINUE');
  assert.equal(payload.requestId, PKT.requestId);
  assert.equal(payload.modelUsed, 'mock/model');
});

test('unit: tools/call advisor.second_opinion routes to gemini model (mock)', async () => {
  let seenModel = '';
  const mcp = createAdvisorMcp({
    apiKey: 'k', gptModel: 'mock/gpt', geminiModel: 'mock/gemini',
    fetchImpl: async (_url, init) => {
      seenModel = JSON.parse(init.body).model;
      return { ok: true, status: 200, json: async () => ({ model: seenModel, choices: [{ message: { content: JSON.stringify(GOOD_REPLY) } }] }), text: async () => JSON.stringify(GOOD_REPLY) };
    },
  });
  const res = await mcp.handleRequest({ id: 7, method: 'tools/call', params: { name: TOOL_NAMES.secondOpinion, arguments: { ...PKT } } });
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.ok, true);
  assert.equal(seenModel, 'mock/gemini');
});

test('unit: tools/call validation failures -> toolError with precise codes', async () => {
  const mcp = createAdvisorMcp({ apiKey: 'k', gptModel: 'mock/gpt', geminiModel: 'mock/gemini', fetchImpl: okFetch(JSON.stringify(GOOD_REPLY)) });
  const bad = await mcp.handleRequest({ id: 8, method: 'tools/call', params: { name: TOOL_NAMES.ask, arguments: { ...PKT, stateDigest: 'nope' } } });
  assert.equal(bad.error.data.toolError, 'STATE_DIGEST_INVALID');
  // Provider reply stale (binds một packet khác) -> fail-closed, không trả decision.
  const stale = await mcp.handleRequest({
    id: 9, method: 'tools/call',
    params: {
      name: TOOL_NAMES.ask,
      arguments: { ...PKT },
      // (arguments giữ nguyên; staleness nằm ở phía fetch mock bên dưới)
    },
  });
  assert.equal(JSON.parse(stale.result.content[0].text).ok, true, 'echoed packet stays valid');
  const staleFetcher = async () => ({
    ok: true, status: 200,
    json: async () => ({ model: 'mock/model', choices: [{ message: { content: JSON.stringify({ ...GOOD_REPLY, binds: { ...PKT.binds, taskRef: 'Issue #1' } }) } }] }),
    text: async () => JSON.stringify({ ...GOOD_REPLY, binds: { ...PKT.binds, taskRef: 'Issue #1' } }),
  });
  const mcpStale = createAdvisorMcp({ apiKey: 'k', gptModel: 'mock/gpt', geminiModel: 'mock/gemini', fetchImpl: staleFetcher });
  const staleRes = await mcpStale.handleRequest({ id: 10, method: 'tools/call', params: { name: TOOL_NAMES.ask, arguments: { ...PKT } } });
  assert.equal(staleRes.error.data.toolError, 'BINDING_MISMATCH');
});

test('unit: baseUrl override routes the wire call + stream:false (provider-replaceable)', async () => {
  const seen = [];
  const mcp = createAdvisorMcp({
    apiKey: 'k',
    baseUrl: 'http://127.0.0.1:20128/v1',
    gptModel: 'mock/gpt',
    geminiModel: 'mock/gemini',
    fetchImpl: async (url, init) => {
      seen.push({ url: String(url), body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ model: 'mock/model', choices: [{ message: { content: JSON.stringify(GOOD_REPLY) } }] }), text: async () => JSON.stringify(GOOD_REPLY) };
    },
  });
  const res = await mcp.handleRequest({ id: 11, method: 'tools/call', params: { name: TOOL_NAMES.ask, arguments: { ...PKT } } });
  assert.equal(JSON.parse(res.result.content[0].text).ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'http://127.0.0.1:20128/v1/chat/completions');
  assert.equal(seen[0].body.stream, false);
});


