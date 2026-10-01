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
        // A timeout round whose late reply of the SAME turn was reconciled is
        // fully resolvable: reuse it instead of ever resubmitting (Issue #263).
        const latePath = path.join(storeDir, `${previous.requestId}.response.late.json`);
        if (fs.existsSync(latePath)) {
          try {
            const primary = JSON.parse(fs.readFileSync(previousResponse, 'utf8'));
            const late = JSON.parse(fs.readFileSync(latePath, 'utf8'));
            if (isTimeoutReviewResponse(primary)
              && late.requestId === previous.requestId
              && late.requestDigest === previous.requestDigest
              && late.attemptId === previous.attemptId
              && late.newTurnId === primary.newTurnId
              && typeof late.rawText === 'string'
              && stripReplyLabels(late.rawText).trim()) {
              return { ok: true, value: { binding, requestId: previous.requestId, attemptId: previous.attemptId, requestDigest: previous.requestDigest, requestPath: path.join(storeDir, name), responsePath: previousResponse, lateResponsePath: latePath }, prompt: previous.submittedPrompt, reconciliation: 'LATE_RESPONSE_RECONCILED' };
            }
          } catch { /* a broken late link falls back to the plain reuse below */ }
        }
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
    // Late-aware: a reconciled late reply of the SAME turn replaces the
    // timeout snapshot as the effective response; every check below then runs
    // against it with NO guard lowered (Issue #263).
    const effective = readEffectiveReviewResponse(request);
    if (!effective.ok) return effective;
    const response = effective.value;
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

// A persisted response is a TIMEOUT snapshot when it claims a poll timeout or
// carries no usable reply text (both persisted shapes: run #5's
// {ok:true, pollTimeout, text:''} and the fail-closed {ok:false,
// code:REVIEW_TIMEOUT, timeout}). Only such rounds may be reconciled.
export function isTimeoutReviewResponse(response) {
  if (!response || typeof response !== 'object') return false;
  if (response.pollTimeout === true || response.timeout === true || response.ok === false) return true;
  const text = typeof response.text === 'string' && response.text
    ? response.text
    : stripReplyLabels(typeof response.rawText === 'string' ? response.rawText : '');
  return !text.trim();
}

// The effective response for a request: the persisted primary snapshot, or —
// when that primary is a timeout AND a verified late reply of the SAME turn
// was reconciled — the late reply merged over it. Link failures fail closed;
// they never fall back to silently dropping the late evidence.
export function readEffectiveReviewResponse(request) {
  const dir = path.dirname(request.requestPath);
  const primary = JSON.parse(fs.readFileSync(path.join(dir, `${request.requestId}.response.json`), 'utf8'));
  if (!isTimeoutReviewResponse(primary)) return { ok: true, value: primary };
  const latePath = path.join(dir, `${request.requestId}.response.late.json`);
  if (!fs.existsSync(latePath)) return { ok: true, value: primary };
  let late;
  try { late = JSON.parse(fs.readFileSync(latePath, 'utf8')); }
  catch { return fail('REVIEW_RESPONSE_LINK_INVALID', 'late response unreadable'); }
  if (late.requestId !== primary.requestId
    || late.requestDigest !== primary.requestDigest
    || late.attemptId !== primary.attemptId
    || late.newTurnId !== primary.newTurnId
    || typeof late.rawText !== 'string'
    || !late.rawText.trim()) {
    return fail('REVIEW_RESPONSE_LINK_INVALID', 'late response does not link to the persisted record');
  }
  return { ok: true, value: {
    ...primary,
    metadata: { ...(primary.metadata || {}), pollTimeout: false },
    ok: true,
    pollTimeout: false,
    timeout: false,
    lateReconciled: true,
    text: stripReplyLabels(late.rawText),
    rawText: late.rawText,
    newTurnId: late.newTurnId,
    targetId: late.targetId || primary.targetId,
    conversationId: late.conversationId || primary.conversationId,
    beforeTurnIds: Array.isArray(late.beforeTurnIds) ? late.beforeTurnIds : primary.beforeTurnIds,
    afterTurnIds: Array.isArray(late.afterTurnIds) ? late.afterTurnIds : primary.afterTurnIds,
    receivedAt: late.receivedAt || primary.receivedAt,
  } };
}

// Canonical recovery of a reviewer reply that completed AFTER the poll
// deadline on the SAME turn (Issue #263 run #5): verify the reply against the
// immutable request/attempt record, then persist it as a separate
// `.response.late.json` evidence file. The timeout snapshot is NEVER
// overwritten, the late file is write-once (conflicting content fails
// closed), and no browser submit happens on this path.
export function reconcileLateReviewResponse({ request, late }) {
  if (!request?.requestPath || !request?.requestId || !request?.requestDigest || !request?.attemptId) return fail('REVIEW_PROVENANCE_MISSING');
  const dir = path.dirname(request.requestPath);
  try {
    const record = JSON.parse(fs.readFileSync(request.requestPath, 'utf8'));
    const responsePath = path.join(dir, `${request.requestId}.response.json`);
    if (!fs.existsSync(responsePath)) return fail('REVIEW_LATE_RESPONSE_NOT_PENDING', 'no persisted response');
    const primary = JSON.parse(fs.readFileSync(responsePath, 'utf8'));
    if (!isTimeoutReviewResponse(primary)) return fail('REVIEW_LATE_RESPONSE_NOT_PENDING', 'round already resolved');
    const rawText = typeof late?.rawText === 'string' ? late.rawText : '';
    const text = stripReplyLabels(rawText);
    if (!text.trim()) return fail('REVIEW_LATE_RESPONSE_INVALID', 'late reply carries no review content');
    const parsed = parseWeb2ApiReview(text);
    if (!parsed.ok) return { ok: false, code: parsed.code || 'REVIEW_LATE_RESPONSE_INVALID', detail: parsed.detail ?? null };
    const payload = parsed.value.payload;
    if (!equal(payload.binding, record.binding) || payload.requestId !== record.requestId || payload.attemptId !== record.attemptId || payload.requestDigest !== record.requestDigest) {
      return fail('REVIEW_RESPONSE_REQUEST_MISMATCH', 'late reply echo does not match the request record');
    }
    const newTurnId = typeof late?.newTurnId === 'string' ? late.newTurnId : '';
    if (!newTurnId || newTurnId !== primary.newTurnId) return fail('REVIEW_RESPONSE_TURN_MISMATCH', 'late reply belongs to a different turn');
    const lateRecord = {
      schemaVersion: 1,
      source: WEB2API_REVIEW_SOURCE,
      reconciledAt: new Date().toISOString(),
      receivedAt: typeof late?.receivedAt === 'string' ? late.receivedAt : new Date().toISOString(),
      requestId: record.requestId,
      requestDigest: record.requestDigest,
      attemptId: record.attemptId,
      newTurnId,
      rawText,
      text,
      targetId: late?.targetId || primary.targetId || null,
      conversationId: late?.conversationId || primary.conversationId || null,
      beforeTurnIds: Array.isArray(late?.beforeTurnIds) ? late.beforeTurnIds : (primary.beforeTurnIds || []),
      afterTurnIds: Array.isArray(late?.afterTurnIds) ? late.afterTurnIds : (primary.afterTurnIds || []),
      pollTimeout: false,
      timeout: false,
      ok: true,
      lateReconciled: true,
    };
    const latePath = path.join(dir, `${request.requestId}.response.late.json`);
    try {
      fs.writeFileSync(latePath, JSON.stringify(lateRecord), { encoding: 'utf8', flag: 'wx' });
      recordReviewAttempt({ request, state: 'LATE_RESPONSE_RECONCILED', detail: { lateResponsePath: latePath } });
    } catch (e) {
      if (e.code !== 'EEXIST') return fail('REVIEW_LATE_RESPONSE_PERSIST_FAILED', e.code);
      const existing = JSON.parse(fs.readFileSync(latePath, 'utf8'));
      if (existing.rawText !== rawText) return fail('REVIEW_LATE_RESPONSE_CONFLICT', 'a different late reply is already recorded');
      return { ok: true, value: { lateResponsePath: latePath, text: existing.text, newTurnId: existing.newTurnId, verdict: parsed.value.rawVerdict, idempotent: true } };
    }
    return { ok: true, value: { lateResponsePath: latePath, text, newTurnId, verdict: parsed.value.rawVerdict } };
  } catch (e) { return fail('REVIEW_PROVENANCE_UNREADABLE', e.code || e.name); }
}
