#!/usr/bin/env node
// advisor-mcp.mjs — Soc_brain: bounded GPT/Gemini advisor MCP (Issue #63).
//
// WHY: Soc_brain North Star = "AI chỉ tư vấn". Bootstrap cần control path để
// Cline CHỦ ĐỘNG hỏi GPT (delegated technical decision authority tạm thời) và
// Gemini (second opinion / research / fallback) TRONG LÚC làm task, không phụ
// thuộc browser shim (MCP-SuperAssistant) hay Cline conversation history.
//
// Transport: provider OpenAI-compatible chat/completions. Mặc định OpenRouter
// (key: SOC_ADVISOR_API_KEY hoặc OPENROUTER_API_KEY); thay provider bằng
// SOC_ADVISOR_BASE_URL (vd gateway 9Router local) — contract (echo binding +
// decision enum) KHÔNG đổi. Không browser, không shell, không mutation:
// advisor hỏi-đáp thuần.
//
// Bounded tool surface (đúng 3 tools):
//   advisor.ping           -> health + models config
//   advisor.ask            -> GPT decision (canonical packet in, decision out)
//   advisor.second_opinion -> Gemini second opinion (canonical packet in)
//
// Anti-stale / anti-replay binding (contract của Issue #63):
//   - Caller cấp `requestId` (không rỗng, unique). Prompt BẮT BUỘC model echo
//     lại requestId. Response thiếu/sai -> fail-closed.
//   - `binds = { repo, taskRef, stateDigest }` BẮT BUỘC model echo khớp
//     request. Mismatch -> BINDING_MISMATCH, không trả decision.
//   - `stateDigest` = sha256 hex 64 của canonical task state text; server
//     KHÔNG tự tính (caller bind đúng state caller đang thấy) nhưng ÉP format.
//
// Decision contract (GPT phải trả ĐÚNG 1 trong các giá trị):
//   CONTINUE | REWORK | USE_OTHER_EXECUTOR | ASK_GEMINI | HUMAN_GATE_REQUIRED
//   | TASK_ACCEPTED
// Sai enum -> DECISION_INVALID (fail-closed).
//
// Fail-closed: mọi parse/validate lỗi -> tool error, KHÔNG tự chế decision,
// KHÔNG fallback sang LLM khác. Không log secret; chỉ log metadata.
//
// Modes (run directly):
//   node advisor-mcp.mjs -> stdio JSON-RPC server (đăng ký trong Cline)
//
// ponytail: dependency-free hand-rolled MCP JSON-RPC (reused shape from
// packages/review-mcp-http, Issue #34/#39) + native fetch. Upgrade to
// @modelcontextprotocol/sdk only if a client needs strict SDK features.

import process from 'node:process';
import readline from 'node:readline';

export const MCP_SERVER_VERSION = '0.1.0';
export const MCP_PROTOCOL_VERSION = '2025-03-26';
export const TOOL_NAMES = {
  ping: 'advisor.ping',
  ask: 'advisor.ask',
  secondOpinion: 'advisor.second_opinion',
};

// Default GPT: openai/gpt-oss-120b (OpenAI's open-weight GPT-OSS family, served
// via Groq as a free OpenAI-compatible route on 9Router). Why this default:
//   - 100% OpenAI upstream model (gpt-oss-120b, Apache-2.0 open-weight GPT family
//     released by OpenAI in 2025), not a relabeled DeepSeek/Gemini/etc.
//   - No OpenAI credit required (Groq free tier), so the "actual GPT control
//     path" is achievable without buying OpenRouter credit.
//   - Reasoning model -> bounded generation must leave room for reasoning
//     tokens; MAX_TOKENS=800 fits comfortably (verified: ~339 tokens used for
//     a 1-line decision JSON including ~210 reasoning tokens).
//   - Override any time via SOC_ADVISOR_GPT_MODEL / SOC_ADVISOR_BASE_URL
//     (e.g. openai/gpt-5-nano via OpenRouter when the user has credit).
export const DEFAULT_GPT_MODEL = 'groq/openai/gpt-oss-120b';
// Gemini default targets the working 9Router route (`gemini/…` prefix). The
// `google/…` id form is the OpenRouter-native format and 404s on 9Router with
// "No active credentials for provider: google" — override via
// SOC_ADVISOR_GEMINI_MODEL when pointing SOC_ADVISOR_BASE_URL at OpenRouter.
export const DEFAULT_GEMINI_MODEL = 'gemini/gemini-3.8-flash';
// Provider-replaceable: mọi gateway OpenAI-compatible /chat/completions.
// Default giữ nguyên OpenRouter; 9Router (free gateway local) qua env override.
export const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

export function chatCompletionsUrl(baseUrl) {
  return `${String(baseUrl || '').replace(/\/+$/, '')}/chat/completions`;
}

export const DECISIONS = [
  'CONTINUE',
  'REWORK',
  'USE_OTHER_EXECUTOR',
  'ASK_GEMINI',
  'HUMAN_GATE_REQUIRED',
  'TASK_ACCEPTED',
];

// Bounded payload: question + evidence gộp lại không vượt quá 64 KiB.
export const PACKET_MAX_BYTES = 64 * 1024;
// Bounded generation: temperature 0, max_tokens 800 — advisor trả JSON ngắn.
export const MAX_TOKENS = 800;
const FETCH_TIMEOUT_MS = 120_000;

const REQUEST_ID_RE = /^[A-Za-z0-9._:@-]{8,128}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TASK_REF_RE = /^[A-Za-z0-9._#:\-\s]{1,128}$/;

export function advisorEnv(env = process.env) {
  return {
    apiKey: env.SOC_ADVISOR_API_KEY || env.OPENROUTER_API_KEY || '',
    baseUrl: env.SOC_ADVISOR_BASE_URL || DEFAULT_BASE_URL,
    gptModel: env.SOC_ADVISOR_GPT_MODEL || DEFAULT_GPT_MODEL,
    geminiModel: env.SOC_ADVISOR_GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
  };
}

// ---- input validation -------------------------------------------------------

export function validateAskArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, code: 'ARGS_INVALID', message: 'args must be an object' };
  }
  const required = ['requestId', 'repo', 'taskRef', 'stateDigest', 'question', 'evidence'];
  const keys = Object.keys(args);
  if (keys.length !== required.length || !required.every((k) => keys.includes(k))) {
    return { ok: false, code: 'ARGS_INVALID', message: `accept exactly: ${required.join(', ')}` };
  }
  if (typeof args.requestId !== 'string' || !REQUEST_ID_RE.test(args.requestId)) {
    return { ok: false, code: 'REQUEST_ID_INVALID', message: 'requestId: 8..128 chars [A-Za-z0-9._:@-]' };
  }
  if (typeof args.repo !== 'string' || !REPO_RE.test(args.repo)) {
    return { ok: false, code: 'REPO_INVALID', message: `repo must be owner/name: ${String(args.repo)}` };
  }
  if (typeof args.taskRef !== 'string' || !TASK_REF_RE.test(args.taskRef)) {
    return { ok: false, code: 'TASK_REF_INVALID', message: 'taskRef: 1..128 chars [A-Za-z0-9._#:-]' };
  }
  if (typeof args.stateDigest !== 'string' || !SHA256_RE.test(args.stateDigest.toLowerCase())) {
    return { ok: false, code: 'STATE_DIGEST_INVALID', message: 'stateDigest must be sha256 hex 64' };
  }
  if (typeof args.question !== 'string' || args.question.trim().length === 0) {
    return { ok: false, code: 'QUESTION_INVALID', message: 'question must be a non-empty string' };
  }
  if (typeof args.evidence !== 'string' || args.evidence.trim().length === 0) {
    return { ok: false, code: 'EVIDENCE_INVALID', message: 'evidence must be a non-empty string' };
  }
  if (Buffer.byteLength(args.question, 'utf8') + Buffer.byteLength(args.evidence, 'utf8') > PACKET_MAX_BYTES) {
    return { ok: false, code: 'BOUNDED_PAYLOAD_EXCEEDED', message: `question + evidence over ${PACKET_MAX_BYTES} bytes; compact the packet` };
  }
  return {
    ok: true,
    packet: {
      requestId: args.requestId,
      repo: args.repo,
      taskRef: args.taskRef,
      stateDigest: args.stateDigest.toLowerCase(),
      question: args.question,
      evidence: args.evidence,
    },
  };
}

// ---- prompt building --------------------------------------------------------

// Một prompt duy nhất cho cả ask (GPT) và second_opinion (Gemini); khác nhau
// ở role: ask = decision authority, second_opinion = independent reviewer.
export function buildPrompt(packet, { mode }) {
  const role = mode === 'second_opinion'
    ? 'You are an INDEPENDENT SECOND-OPINION reviewer. Assess the decision/question below on its merits. You have NO authority; advise only.'
    : 'You are the delegated technical DECISION authority. Judge only from the packet below; do not assume any other context.';
  return [
    role,
    'Reply with ONLY one JSON object (no markdown, no prose) with EXACTLY these fields:',
    '{"requestId":"<echo request field>","decision":"CONTINUE|REWORK|USE_OTHER_EXECUTOR|ASK_GEMINI|HUMAN_GATE_REQUIRED|TASK_ACCEPTED","reasoning":"<max 80 words>","nextAction":"<one imperative sentence>","confidence":<0..1>,"binds":{"repo":"<echo>","taskRef":"<echo>","stateDigest":"<echo>"}}',
    mode === 'second_opinion'
      ? 'For second opinion, decision reflects your independent verdict on the packet.'
      : 'decision must be exactly one of the listed enum values.',
    '',
    'REQUEST:',
    JSON.stringify({
      requestId: packet.requestId,
      repo: packet.repo,
      taskRef: packet.taskRef,
      stateDigest: packet.stateDigest,
    }),
    '',
    'EVIDENCE (canonical, bounded):',
    packet.evidence,
    '',
    'QUESTION:',
    packet.question,
  ].join('\n');
}

// ---- response validation (anti-stale / anti-replay) -------------------------

export function parseModelJson(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, code: 'EMPTY_RESPONSE', message: 'model returned empty text' };
  }
  let raw = text.trim();
  // Tolerate one fenced ```json block; anything else must be pure JSON.
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(raw);
  if (fence) raw = fence[1].trim();
  let obj;
  try { obj = JSON.parse(raw); } catch {
    return { ok: false, code: 'JSON_PARSE_FAILED', message: 'model reply is not pure JSON (fenced or plain)' };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, code: 'JSON_PARSE_FAILED', message: 'model reply is not a JSON object' };
  }
  return { ok: true, obj };
}

export function validateDecisionReply(obj, packet) {
  if (typeof obj.requestId !== 'string' || obj.requestId !== packet.requestId) {
    return { ok: false, code: 'REQUEST_ID_MISMATCH', message: `reply requestId does not echo ${packet.requestId}` };
  }
  const binds = obj.binds;
  if (!binds || typeof binds !== 'object' || Array.isArray(binds)) {
    return { ok: false, code: 'BINDING_MISMATCH', message: 'reply missing binds object' };
  }
  for (const k of ['repo', 'taskRef', 'stateDigest']) {
    if (binds[k] !== packet[k]) {
      return { ok: false, code: 'BINDING_MISMATCH', message: `binds.${k} does not echo request value` };
    }
  }
  if (!DECISIONS.includes(obj.decision)) {
    return { ok: false, code: 'DECISION_INVALID', message: `decision must be one of: ${DECISIONS.join(' | ')}` };
  }
  const confidence = Number(obj.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { ok: false, code: 'CONFIDENCE_INVALID', message: 'confidence must be 0..1' };
  }
  return {
    ok: true,
    decision: {
      requestId: obj.requestId,
      decision: obj.decision,
      reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : '',
      nextAction: typeof obj.nextAction === 'string' ? obj.nextAction : '',
      confidence,
      binds,
    },
  };
}

// ---- OpenRouter client ------------------------------------------------------

async function chatCompletion({ model, prompt, apiKey, baseUrl, fetchImpl = fetch }) {
  if (!apiKey) {
    return { ok: false, code: 'MISSING_API_KEY', message: 'advisor API key missing: set SOC_ADVISOR_API_KEY (or OPENROUTER_API_KEY) in this process env' };
  }
  let res;
  try {
    res = await fetchImpl(chatCompletionsUrl(baseUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'You are a terse JSON-only advisor. Never output anything outside one JSON object.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0,
        max_tokens: MAX_TOKENS,
        stream: false,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, code: 'TRANSPORT_FAILED', message: `advisor provider request failed: ${(e && e.message) || e}` };
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 300);
    return { ok: false, code: 'PROVIDER_ERROR', message: `advisor provider HTTP ${res.status}: ${body}` };
  }
  let data;
  try { data = await res.json(); } catch {
    return { ok: false, code: 'PROVIDER_ERROR', message: 'advisor provider returned non-JSON body' };
  }
  const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
  const text = choice && choice.message ? choice.message.content : null;
  if (typeof text !== 'string' || text.length === 0) {
    return { ok: false, code: 'PROVIDER_ERROR', message: 'advisor provider response missing choices[0].message.content' };
  }
  return { ok: true, text, modelUsed: data.model || model };
}

// askAdvisor: pipeline chung; khác model + mode (role trong prompt).
export async function askAdvisor(packet, { mode, apiKey, baseUrl, model, fetchImpl }) {
  const prompt = buildPrompt(packet, { mode });
  const completion = await chatCompletion({ model, prompt, apiKey, baseUrl, fetchImpl });
  if (!completion.ok) return completion;
  const parsed = parseModelJson(completion.text);
  if (!parsed.ok) return parsed;
  const validated = validateDecisionReply(parsed.obj, packet);
  if (!validated.ok) return validated;
  return { ok: true, decision: validated.decision, modelUsed: completion.modelUsed };
}

// ---- MCP JSON-RPC (stdio) — shape reused from packages/review-mcp-http ------

function toolError(id, code, message) {
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32603, message, data: { toolError: code } },
  };
}

function toolResult(id, payload) {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      isError: false,
    },
  };
}

export function createAdvisorMcp({
  apiKey = advisorEnv().apiKey,
  baseUrl = advisorEnv().baseUrl,
  gptModel = advisorEnv().gptModel,
  geminiModel = advisorEnv().geminiModel,
  fetchImpl = fetch,
} = {}) {
  const askProps = {
    requestId: { type: 'string', description: 'fresh unique id for this call (never reuse)' },
    repo: { type: 'string', description: 'owner/name canonical' },
    taskRef: { type: 'string', description: 'task identity, e.g. Issue #63' },
    stateDigest: { type: 'string', description: 'sha256 hex 64 of canonical task state text' },
    question: { type: 'string' },
    evidence: { type: 'string', description: 'compact canonical state/evidence text' },
  };

  const tools = [
    {
      name: TOOL_NAMES.ping,
      description: 'Health probe for the Soc_brain advisor MCP. Returns service identity and configured models. No LLM call.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: TOOL_NAMES.ask,
      description:
        'Ask the configured GPT-role model (delegated decision authority) for a bounded structured decision on a canonical task packet. '
        + 'Returns { decision: CONTINUE|REWORK|USE_OTHER_EXECUTOR|ASK_GEMINI|HUMAN_GATE_REQUIRED|TASK_ACCEPTED, reasoning, nextAction, confidence, binds }. '
        + 'The reply MUST echo requestId and binds{repo,taskRef,stateDigest}; mismatch -> fail-closed error. GPT has NO shell/exec authority.',
      inputSchema: {
        type: 'object',
        properties: askProps,
        required: ['requestId', 'repo', 'taskRef', 'stateDigest', 'question', 'evidence'],
        additionalProperties: false,
      },
    },
    {
      name: TOOL_NAMES.secondOpinion,
      description:
        'Ask the configured Gemini-role model for an independent second opinion / research check on the same canonical packet shape as advisor.ask. '
        + 'Same echo binding and fail-closed validation. Gemini has NO lifecycle authority.',
      inputSchema: {
        type: 'object',
        properties: askProps,
        required: ['requestId', 'repo', 'taskRef', 'stateDigest', 'question', 'evidence'],
        additionalProperties: false,
      },
    },
  ];

  function handleRequest(request) {
    if (!request || typeof request !== 'object') return null;
    const { id, method } = request;

    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          serverInfo: { name: 'soc-brain-advisor', version: MCP_SERVER_VERSION },
          capabilities: { tools: {} },
        },
      };
    }
    if (method === 'notifications/initialized') return null;
    if (method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools } };
    }
    if (method === 'tools/call') {
      const name = (request.params && request.params.name) || '';
      const args = (request.params && request.params.arguments) || null;
      if (name === TOOL_NAMES.ping) {
        return toolResult(id, {
          ok: true,
          service: 'soc_brain',
          mode: 'advisor',
          models: { gpt: gptModel, gemini: geminiModel },
          baseUrl,
          apiKeyPresent: Boolean(apiKey),
        });
      }
      if (name === TOOL_NAMES.ask || name === TOOL_NAMES.secondOpinion) {
        const v = validateAskArgs(args);
        if (!v.ok) return toolError(id, v.code, v.message);
        const mode = name === TOOL_NAMES.ask ? 'decision' : 'second_opinion';
        const model = name === TOOL_NAMES.ask ? gptModel : geminiModel;
        return askAdvisor(v.packet, { mode, model, apiKey, baseUrl, fetchImpl }).then((r) => {
          if (!r.ok) return toolError(id, r.code, r.message);
          return toolResult(id, {
            ok: true,
            mode,
            requestId: r.decision.requestId,
            decision: r.decision.decision,
            reasoning: r.decision.reasoning,
            nextAction: r.decision.nextAction,
            confidence: r.decision.confidence,
            binds: r.decision.binds,
            modelUsed: r.modelUsed,
          });
        });
      }
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Unknown tool: ${name}` },
      };
    }
    return {
      jsonrpc: '2.0',
      id: request.id ?? null,
      error: { code: -32601, message: `Method not found: ${method}` },
    };
  }

  return { handleRequest };
}

// ---- stdio entry ------------------------------------------------------------

export function startStdioServer(deps = {}) {
  // ponytail: readline line-loop đủ cho stdio MCP một-request-một-line; đổi
  // sang framing theo spec (Content-Length) chỉ khi client cần.
  const mcp = createAdvisorMcp(deps);
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let request;
    try { request = JSON.parse(trimmed); } catch { return; }
    Promise.resolve(mcp.handleRequest(request)).then((response) => {
      if (response) process.stdout.write(JSON.stringify(response) + '\n');
    });
  });
  return { rl };
}

// Chỉ chạy CLI khi được gọi trực tiếp (import từ test không kích hoạt stdio).
const isDirectRun = process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href;
if (isDirectRun) startStdioServer();




