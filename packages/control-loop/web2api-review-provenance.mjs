import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseReviewVerdict } from './verdict-parser.mjs';

const hash = (v) => createHash('sha256').update(v).digest('hex');
const fail = (code, detail = null) => ({ ok: false, code, detail });
export const WEB2API_REVIEW_SOURCE = 'gemini-web2api-review';
const canonicalBinding = (s) => ({ repository: String(s?.repo || '').toLowerCase(), issue: s?.issueNumber, pullRequest: s?.prNumber, headSha: String(s?.headSha || '').toLowerCase() });
const equal = isDeepStrictEqual;

export function stripReplyLabels(rawText) {
  const text = typeof rawText === 'string' ? rawText : '';
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && (!lines[i].trim() || /^(?:Gemini (?:said|đã nói)|JSON)$/i.test(lines[i].trim()))) i += 1;
  return i === 0 ? text : lines.slice(i).join('\n').trim();
}

// The immutable artifact is created BEFORE any browser submit. Never infer it
// from a prior response, session snapshot or legacy transition.
export function persistReviewRequest({ session, prompt, storeDir }) {
  const binding = canonicalBinding(session);
  if (!binding.repository || !Number.isInteger(binding.issue) || binding.issue <= 0 || !Number.isInteger(binding.pullRequest) || binding.pullRequest <= 0 || !/^[a-f0-9]{40}$/.test(binding.headSha) || typeof prompt !== 'string' || !prompt.trim() || !storeDir) return fail('REVIEW_REQUEST_INVALID');
  const requestId = randomUUID();
  const attemptId = randomUUID();
  const normalizedRequest = { binding, requestId, attemptId, content: prompt };
  const requestDigest = hash(JSON.stringify(normalizedRequest));
  const echo = { binding, requestId, attemptId, requestDigest };
  const submittedPrompt = `${prompt}\n\n[WEB2API REVIEW RESPONSE CONTRACT]\nBefore the final VERDICT line, emit exactly one block delimited by REVIEW_PAYLOAD_BEGIN and REVIEW_PAYLOAD_END. Its content must be one JSON object with: findings (string[] of concrete defects only), remediation (string[] of complete repair instructions), evidenceRequests (string[]), confidence (number 0..1 or null), and these exact echoed fields: ${JSON.stringify(echo)}. Keep diff analysis outside this block. No truncation. CHANGES_REQUESTED requires at least one finding. The final VERDICT line must remain last.`;
  if (submittedPrompt.length > 1_000_000) return fail('REVIEW_REQUEST_PROMPT_TOO_LARGE');
  const record = { schemaVersion: 1, source: WEB2API_REVIEW_SOURCE, createdAt: new Date().toISOString(), ...echo, normalizedRequest, submittedPrompt, submittedPromptDigest: hash(submittedPrompt) };
  const requestPath = path.join(storeDir, `${requestId}.request.json`);
  try {
    fs.mkdirSync(storeDir, { recursive: true });
    for (const name of fs.readdirSync(storeDir).filter((name) => name.endsWith('.request.json'))) {
      const previous = JSON.parse(fs.readFileSync(path.join(storeDir, name), 'utf8'));
      if (!equal(previous.binding, binding)) continue;
      const previousSubmit = path.join(storeDir, `${previous.requestId}.submit.json`);
      const previousResponse = path.join(storeDir, `${previous.requestId}.response.json`);
      if (!fs.existsSync(previousSubmit) && previous.normalizedRequest?.content === prompt && hash(previous.submittedPrompt) === previous.submittedPromptDigest) {
        return { ok: true, value: { binding, requestId: previous.requestId, attemptId: previous.attemptId, requestDigest: previous.requestDigest, requestPath: path.join(storeDir, name), responsePath: previousResponse }, prompt: previous.submittedPrompt, reused: true };
      }
      if (fs.existsSync(previousResponse) && previous.normalizedRequest?.content === prompt) {
        return { ok: true, value: { binding, requestId: previous.requestId, attemptId: previous.attemptId, requestDigest: previous.requestDigest, requestPath: path.join(storeDir, name), responsePath: previousResponse }, prompt: previous.submittedPrompt, reconciliation: 'RESPONSE_PERSISTED' };
      }
      // Fail closed ONLY for a round that is genuinely in flight: it claimed
      // its submit but never produced a response, so a fresh submit of a
      // different prompt could double-send. Everything else is superseded:
      //  - submit + response -> the round is fully resolved, its turn is over
      //  - no submit.json    -> claimReviewSubmit writes that marker BEFORE any
      //                          Chrome/DOM interaction, so a record without it
      //                          provably never reached the browser and a later
      //                          round may take over (the old file is kept).
      if (fs.existsSync(previousSubmit) && !fs.existsSync(previousResponse)) return fail('REVIEW_REQUEST_UNRESOLVED', previous.requestId);
      continue;
    }
    fs.writeFileSync(requestPath, JSON.stringify(record), { encoding: 'utf8', flag: 'wx' });
  } catch (e) { return fail('REVIEW_REQUEST_PERSIST_FAILED', e.code); }
  return { ok: true, value: { ...echo, requestPath, responsePath: path.join(storeDir, `${requestId}.response.json`) }, prompt: submittedPrompt };
}

export function recordReviewAttempt({ request, state, code = null, detail = null }) {
  if (!request?.requestPath || !request?.requestId || !request?.requestDigest || !request?.attemptId) return fail('REVIEW_PROVENANCE_MISSING');
  try {
    const event = { at: new Date().toISOString(), requestId: request.requestId, attemptId: request.attemptId, requestDigest: request.requestDigest, state, code, detail };
    fs.appendFileSync(path.join(path.dirname(request.requestPath), `${request.requestId}.attempts.jsonl`), `${JSON.stringify(event)}\n`, 'utf8');
    return { ok: true, value: event };
  } catch (e) { return fail('REVIEW_ATTEMPT_PERSIST_FAILED', e.code || e.name); }
}

export function parseWeb2ApiReview(text) {
  const verdict = parseReviewVerdict(text, { requirePayload: true });
  if (!verdict.ok) return verdict;
  return verdict;
}

export function validateReviewProvenance({ decision, session, request = decision?.provenance, requireResponse = true, allowMissingContract = false }) {
  if (!request?.requestPath || !request?.requestId || !request?.requestDigest || !request?.attemptId) return fail('REVIEW_PROVENANCE_MISSING');
  if (path.basename(request.requestPath) !== `${request.requestId}.request.json` || request.responsePath !== path.join(path.dirname(request.requestPath), `${request.requestId}.response.json`)) return fail('REVIEW_PROVENANCE_MISMATCH');
  try {
    const record = JSON.parse(fs.readFileSync(request.requestPath, 'utf8'));
    if (typeof record.submittedPrompt !== 'string' || hash(record.submittedPrompt) !== record.submittedPromptDigest || decision?.binding && !equal(decision.binding, record.binding)) return fail('REVIEW_PROVENANCE_MISMATCH');
    if (record.source !== WEB2API_REVIEW_SOURCE || record.requestId !== request.requestId || record.attemptId !== request.attemptId || record.requestDigest !== request.requestDigest || hash(JSON.stringify(record.normalizedRequest)) !== record.requestDigest || !equal(record.binding, canonicalBinding(session)) || !equal(record.normalizedRequest.binding, record.binding) || record.normalizedRequest.requestId !== record.requestId || record.normalizedRequest.attemptId !== record.attemptId) return fail('REVIEW_PROVENANCE_MISMATCH');
    if (!requireResponse) return { ok: true, record };
    const responsePath = path.join(path.dirname(request.requestPath), `${request.requestId}.response.json`);
    if (request.responsePath !== responsePath) return fail('REVIEW_PROVENANCE_MISMATCH');
    const submit = JSON.parse(fs.readFileSync(path.join(path.dirname(request.requestPath), `${request.requestId}.submit.json`), 'utf8'));
    if (submit.requestId !== record.requestId || submit.requestDigest !== record.requestDigest || !submit.submitIntentAt) return fail('REVIEW_PROVENANCE_MISMATCH');
    const response = JSON.parse(fs.readFileSync(responsePath, 'utf8'));
    const chronology = [record.createdAt, submit.submitIntentAt, response.receivedAt].map(Date.parse);
    if (!chronology.every(Number.isFinite) || chronology[0] > chronology[1] || chronology[1] > chronology[2]) return fail('REVIEW_PROVENANCE_MISMATCH');
    if (response.text !== stripReplyLabels(response.rawText)) return fail('REVIEW_RESPONSE_LINK_INVALID');
    if (response.requestId !== record.requestId || response.requestDigest !== record.requestDigest || response.attemptId !== record.attemptId || response.rawText !== decision.rawText || response.newTurnId !== decision.newTurnId || !response.newTurnId || !response.targetId || !response.conversationId || response.pollTimeout || !Array.isArray(response.beforeTurnIds) || !Array.isArray(response.afterTurnIds) || response.beforeTurnIds.includes(response.newTurnId) || response.afterTurnIds.filter((id) => !response.beforeTurnIds.includes(id)).length !== 1 || !response.afterTurnIds.includes(response.newTurnId)) return fail('REVIEW_RESPONSE_LINK_INVALID');
    const parsed = parseWeb2ApiReview(response.text);
    if (!parsed.ok) return parsed;
    const payload = parsed.value.payload;
    if (!equal(payload.binding, record.binding) || payload.requestId !== record.requestId || payload.attemptId !== record.attemptId || payload.requestDigest !== record.requestDigest || parsed.value.verdict !== decision.verdict) return fail('REVIEW_RESPONSE_REQUEST_MISMATCH');
    for (const field of ['findings', 'remediation', 'evidenceRequests', 'confidence']) {
      if (!(field in decision) && !allowMissingContract) return fail('REVIEW_DECISION_PAYLOAD_MISSING', field);
      if (field in decision && !equal(decision[field], payload[field])) return fail('REVIEW_DECISION_PAYLOAD_MISMATCH', field);
    }
    return { ok: true, value: parsed.value, record };
  } catch (e) { return fail('REVIEW_PROVENANCE_UNREADABLE', e.code || e.name); }
}

export function claimReviewSubmit(request) {
  try {
    fs.writeFileSync(path.join(path.dirname(request.requestPath), `${request.requestId}.submit.json`), JSON.stringify({ requestId: request.requestId, requestDigest: request.requestDigest, submitIntentAt: new Date().toISOString() }), { encoding: 'utf8', flag: 'wx' });
    return { ok: true };
  } catch (e) { return fail(e.code === 'EEXIST' ? 'REVIEW_REQUEST_ALREADY_SUBMITTED' : 'REVIEW_SUBMIT_PERSIST_FAILED', e.code); }
}

export function persistReviewResponse({ request, response }) {
  try {
    fs.writeFileSync(request.responsePath, JSON.stringify({ ...response, requestId: request.requestId, requestDigest: request.requestDigest, attemptId: request.attemptId, receivedAt: new Date().toISOString() }), { encoding: 'utf8', flag: 'wx' });
    return { ok: true };
  } catch (e) { return fail('REVIEW_RESPONSE_PERSIST_FAILED', e.code); }
}
