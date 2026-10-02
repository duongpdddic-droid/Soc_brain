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
export function persistReviewRequest({ session, prompt, storeDir, consumedRequestIds = [] } = {}) {
  const binding = canonicalBinding(session);
  if (!binding.repository || !Number.isInteger(binding.issue) || binding.issue <= 0 || !Number.isInteger(binding.pullRequest) || binding.pullRequest <= 0 || !/^[a-f0-9]{40}$/.test(binding.headSha) || typeof prompt !== 'string' || !prompt.trim() || !storeDir) return fail('REVIEW_REQUEST_INVALID');
  const consumed = new Set((Array.isArray(consumedRequestIds) ? consumedRequestIds : []).filter((v) => typeof v === 'string' && v));
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
      // A round the FSM already consumed is finished: its response is never a
      // fallback target for a later round (Issue #263 reviewer finding 2).
      if (consumed.has(previous.requestId)) continue;
      const previousSubmit = path.join(storeDir, `${previous.requestId}.submit.json`);
      const previousResponse = path.join(storeDir, `${previous.requestId}.response.json`);
      const previousLate = path.join(storeDir, `${previous.requestId}.response.late.json`);
      if (!fs.existsSync(previousSubmit) && previous.normalizedRequest?.content === prompt && hash(previous.submittedPrompt) === previous.submittedPromptDigest) {
        return { ok: true, value: { binding, requestId: previous.requestId, attemptId: previous.attemptId, requestDigest: previous.requestDigest, requestPath: path.join(storeDir, name), responsePath: previousResponse }, prompt: previous.submittedPrompt, reused: true };
      }
      if (fs.existsSync(previousSubmit)) {
        // SENT: the browser may already hold this round. Exact prompt equality
        // can NEVER rescue it (the rebuild's `- timestamp:` header makes the
        // bytes differ), so a timeout round must be reconciled — late reply of
        // the SAME turn — or block. It is never silently superseded by a
        // brand-new request/submit just because the prompt text changed
        // (Issue #263 reviewer finding 2).
        if (!fs.existsSync(previousResponse)) return fail('REVIEW_REQUEST_UNRESOLVED', previous.requestId);
        let primary = null;
        try { primary = JSON.parse(fs.readFileSync(previousResponse, 'utf8')); }
        catch (e) { return fail('REVIEW_RESPONSE_PERSIST_FAILED', e.code); }
        const contentMatches = previous.normalizedRequest?.content === prompt;
        const usableLate = () => {
          if (!fs.existsSync(previousLate)) return false;
          try {
            const late = JSON.parse(fs.readFileSync(previousLate, 'utf8'));
            return late.requestId === previous.requestId
              && late.requestDigest === previous.requestDigest
              && late.attemptId === previous.attemptId
              && late.newTurnId === primary.newTurnId
              && typeof late.rawText === 'string'
              && stripReplyLabels(late.rawText).trim();
          } catch { return false; } // a broken late link never authorizes reuse
        };
        if (isTimeoutReviewResponse(primary)) {
          if (!usableLate()) return fail('REVIEW_REQUEST_UNRESOLVED', previous.requestId);
          if (contentMatches) {
            return { ok: true, value: { binding, requestId: previous.requestId, attemptId: previous.attemptId, requestDigest: previous.requestDigest, requestPath: path.join(storeDir, name), responsePath: previousResponse, lateResponsePath: previousLate }, prompt: previous.submittedPrompt, reconciliation: 'LATE_RESPONSE_RECONCILED' };
          }
          continue; // reconciled round of a DIFFERENT prompt: never re-selected
        }
        if (contentMatches) {
          return { ok: true, value: { binding, requestId: previous.requestId, attemptId: previous.attemptId, requestDigest: previous.requestDigest, requestPath: path.join(storeDir, name), responsePath: previousResponse }, prompt: previous.submittedPrompt, reconciliation: 'RESPONSE_PERSISTED' };
        }
        continue;
      }
      // Fail closed ONLY for a round that is genuinely in flight: it claimed
      // its submit but never produced a response, so a fresh submit of a
      // different prompt could double-send. Everything else is superseded:
      //  - submit + response -> the round is fully resolved, its turn is over
      //  - no submit.json    -> claimReviewSubmit writes that marker BEFORE any
      //                          Chrome/DOM interaction, so a record without it
      //                          provably never reached the browser and a later
      //                          round may take over (the old file is kept).
      continue;
    }
    fs.writeFileSync(requestPath, JSON.stringify(record), { encoding: 'utf8', flag: 'wx' });
  } catch (e) { return fail('REVIEW_REQUEST_PERSIST_FAILED', e.code); }
  return { ok: true, value: { ...echo, requestPath, responsePath: path.join(storeDir, `${requestId}.response.json`) }, prompt: submittedPrompt };
}

// ---- Issue #263: canonical resume of an ALREADY-SENT review round ------------
// The final-review prompt is rebuilt on every invocation and carries a fresh
// `- timestamp:` header line, so exact prompt equality can never find the round
// a FINAL_REVIEWING resume has to re-consume — without this the resume writes a
// brand-new request and fires a duplicate browser submit for a round the
// reviewer already answered.
//
// Round IDENTITY is never derived from that timestamp. It is the canonical
// binding (identity + repo/issue/PR/HEAD) PLUS the FSM checkpoint: the round
// must actually have been SENT (submit claim), must carry a response, and its
// requestId must never have appeared as a consumed decision evidence. Only
// then is the stored prompt compared byte for byte (mod its own header
// timestamp), and the round is returned with its ORIGINAL normalizedRequest /
// submittedPrompt / requestDigest so every downstream provenance check still
// validates against the OLD round — the resume never recomputes a digest from
// its own timestamped prompt, never picks the newest file by mtime and never
// pairs a response by HEAD alone. Two or more indistinguishable candidates fail
// closed BEFORE any request write or browser submit.
const PROMPT_HEAD_MARKER = '## [DELIVERY ARTIFACTS VERIFICATION]';

// Normalize ONLY the header timestamp, and only inside the header block: a
// `- timestamp:` line can legitimately appear again inside the fenced diff, and
// that byte belongs to the round content and must keep matching exactly. With
// no recognizable header there is no normalization at all (exact bytes only).
function promptRoundKey(text) {
  const src = typeof text === 'string' ? text : '';
  const head = src.indexOf(PROMPT_HEAD_MARKER);
  if (head < 0) return src;
  return `${src.slice(0, head).replace(/^- timestamp: .*$/m, '- timestamp: <volatile>')}${src.slice(head)}`;
}

export function resolveResumeReviewRound({ session, prompt, storeDir, consumedRequestIds = [] } = {}) {
  const binding = canonicalBinding(session);
  if (!binding.repository || !Number.isInteger(binding.issue) || binding.issue <= 0
    || !Number.isInteger(binding.pullRequest) || binding.pullRequest <= 0
    || !/^[a-f0-9]{40}$/.test(binding.headSha)
    || typeof prompt !== 'string' || !prompt.trim() || !storeDir) return fail('REVIEW_REQUEST_INVALID');
  const consumed = new Set((Array.isArray(consumedRequestIds) ? consumedRequestIds : []).filter((v) => typeof v === 'string' && v));
  const key = promptRoundKey(prompt);
  let names;
  try {
    names = fs.readdirSync(storeDir).filter((name) => name.endsWith('.request.json'));
  } catch (e) {
    // A store dir that does not exist YET is not a persistence failure: it is
    // simply a first round with zero candidates. Failing closed here would
    // make every virgin identity unable to open its first review round (and
    // would surface as REVIEW_REQUEST_PERSIST_FAILED/ENOENT before any write).
    if (e.code === 'ENOENT') return { ok: true, value: null };
    return fail('REVIEW_REQUEST_PERSIST_FAILED', e.code);
  }
  const candidates = [];
  const unresolved = [];
  for (const name of names) {
    let record;
    try { record = JSON.parse(fs.readFileSync(path.join(storeDir, name), 'utf8')); }
    catch { continue; } // an unreadable sibling never selects a round
    const rid = record?.requestId;
    if (typeof rid !== 'string' || !rid) continue;
    if (!equal(record.binding, binding)) continue; // canonical identity + repo/issue/PR/HEAD
    if (consumed.has(rid)) continue; // the FSM already consumed this round
    const requestPath = path.join(storeDir, name);
    const responsePath = path.join(storeDir, `${rid}.response.json`);
    const submitPath = path.join(storeDir, `${rid}.submit.json`);
    // Never claimed a submit: provably never reached the browser, so it may be
    // superseded (claimReviewSubmit writes that marker BEFORE any DOM touch).
    if (!fs.existsSync(submitPath)) continue;
    // SENT but no response yet. This round is NOT consumed and NOT invalid — it
    // is UNRESOLVED, and it must never be hidden from the resume pass: hiding
    // it (or treating it as "no candidate") is exactly what let a later round
    // create a brand-new request + submit purely because the rebuilt prompt's
    // `- timestamp:` header changed the bytes. Detect it BEFORE any prompt
    // content comparison for that reason.
    if (!fs.existsSync(responsePath)) { unresolved.push(rid); continue; }
    const content = record.normalizedRequest?.content;
    if (typeof content !== 'string' || typeof record.submittedPrompt !== 'string') continue;
    if (promptRoundKey(content) !== key) continue; // identity block, bundle sizes, test log and diff all match
    // The stored round is validated with ITS OWN bytes and digests — never with
    // anything recomputed from this turn's timestamped prompt.
    if (hash(JSON.stringify(record.normalizedRequest)) !== record.requestDigest
      || hash(record.submittedPrompt) !== record.submittedPromptDigest
      || !record.submittedPrompt.startsWith(content)
      || !equal(record.normalizedRequest.binding, record.binding)
      || record.normalizedRequest.requestId !== rid
      || record.normalizedRequest.attemptId !== record.attemptId) {
      return fail('REVIEW_RESUME_ROUND_INVALID', rid);
    }
    const request = { binding: record.binding, requestId: rid, attemptId: record.attemptId, requestDigest: record.requestDigest, requestPath, responsePath };
    let effective;
    try {
      effective = readEffectiveReviewResponse(request);
    } catch (e) { return fail('REVIEW_RESUME_ROUND_INVALID', `${rid}:${e.code || e.name}`); }
    if (!effective.ok) return fail(effective.code || 'REVIEW_RESUME_ROUND_INVALID', effective.detail); // broken late link: fail closed, never a fresh submit
    // Timeout snapshot with no usable late reply of the SAME turn: also
    // unresolved. It must be reconciled or block — never bypassed by opening a
    // newer round on the same binding (Issue #263 reviewer finding 2).
    if (isTimeoutReviewResponse(effective.value)) { unresolved.push(rid); continue; }
    candidates.push({ request, record, reconciled: effective.value.lateReconciled === true, lateResponsePath: path.join(storeDir, `${rid}.response.late.json`) });
  }
  // A resolvable round always wins: resuming it writes no request and fires no
  // submit, so progress is made and the stuck sibling stays stuck (it blocks on
  // the NEXT attempt, after this one is consumed).
  if (candidates.length === 0 && unresolved.length > 0) {
    return fail('REVIEW_ROUND_UNRESOLVED', [...new Set(unresolved)].sort());
  }
  if (candidates.length === 0) return { ok: true, value: null };
  if (candidates.length > 1) {
    return fail('REVIEW_RESUME_ROUND_AMBIGUOUS', candidates.map((c) => c.record.requestId).sort());
  }
  const chosen = candidates[0];
  return {
    ok: true,
    value: { ...chosen.request, ...(chosen.reconciled ? { lateResponsePath: chosen.lateResponsePath } : {}) },
    prompt: chosen.record.submittedPrompt, // the OLD exact submitted prompt
    reconciliation: chosen.reconciled ? 'LATE_RESPONSE_RECONCILED' : 'RESPONSE_PERSISTED',
    resumed: true,
  };
}

// Resume-first open: re-consume the unconsumed sent round when there is one,
// otherwise open the next round exactly as before. A typed failure here happens
// BEFORE any request record is written and before the transport can claim a
// browser submit.
export function openReviewRound({ session, prompt, storeDir, consumedRequestIds = [] } = {}) {
  const resumed = resolveResumeReviewRound({ session, prompt, storeDir, consumedRequestIds });
  if (!resumed.ok) return resumed;
  if (resumed.value) {
    return { ok: true, value: resumed.value, prompt: resumed.prompt, resumed: true, reconciliation: resumed.reconciliation };
  }
  // The consumed set is passed through so persistReviewRequest can never fall
  // back onto an already-consumed round when it walks the sibling records.
  const prepared = persistReviewRequest({ session, prompt, storeDir, consumedRequestIds });
  if (!prepared.ok) return prepared;
  return { ok: true, value: prepared.value, prompt: prepared.prompt, resumed: false };
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
  // Issue #263 reviewer finding 3: a timeout snapshot without full browser
  // provenance is never an acceptable `.response.json`. Blocking HERE (the
  // single write point) means no consumer can ever load such a round.
  const prov = assertTimeoutProvenance(response);
  if (!prov.ok) return prov;
  try {
    fs.writeFileSync(request.responsePath, JSON.stringify({ ...response, requestId: request.requestId, requestDigest: request.requestDigest, attemptId: request.attemptId, receivedAt: new Date().toISOString() }), { encoding: 'utf8', flag: 'wx' });
    return { ok: true };
  } catch (e) { return fail('REVIEW_RESPONSE_PERSIST_FAILED', e.code); }
}

// Narrow timeout predicate for PROVENANCE enforcement: the round is a poll
// deadline snapshot (the only shape whose provenance we require up front).
// Deliberately NOT `ok === false`: an ordinary transport failure must keep its
// own typed code instead of being relabeled a timeout.
export function isTimeoutSnapshot(response) {
  if (!response || typeof response !== 'object') return false;
  return response.pollTimeout === true
    || response.timeout === true
    || response.code === 'REVIEW_TIMEOUT'
    || response.metadata?.pollTimeout === true;
}

// Issue #263 reviewer finding 3: every timeout must keep the full provenance
// captured at submit time — newTurnId, targetId, conversationId,
// beforeTurnIds (the PRE-submit snapshot) and afterTurnIds — so a late reply
// of the SAME turn can be reconciled. Provenance is never rebuilt from a
// post-hoc DOM read: `beforeTurnIds` must not already contain the new turn,
// and `afterTurnIds` must contain exactly the one new turn.
export function assertTimeoutProvenance(response) {
  if (!isTimeoutSnapshot(response)) return { ok: true };
  const r = response && typeof response === 'object' ? response : {};
  const missing = [];
  if (typeof r.newTurnId !== 'string' || !r.newTurnId) missing.push('newTurnId');
  if (typeof r.targetId !== 'string' || !r.targetId) missing.push('targetId');
  if (typeof r.conversationId !== 'string' || !r.conversationId) missing.push('conversationId');
  if (!Array.isArray(r.beforeTurnIds) || !r.beforeTurnIds.length) missing.push('beforeTurnIds');
  if (!Array.isArray(r.afterTurnIds) || !r.afterTurnIds.length) missing.push('afterTurnIds');
  if (!missing.length) {
    // The pre-submit snapshot must not already contain the turn it claims to
    // precede; otherwise it was rebuilt after the fact and proves nothing.
    if (r.beforeTurnIds.includes(r.newTurnId)) missing.push('beforeTurnIds(preSubmit)');
    if (!r.afterTurnIds.includes(r.newTurnId)) missing.push('afterTurnIds(missingNewTurn)');
  }
  if (missing.length) return fail('REVIEW_TIMEOUT_PROVENANCE_MISSING', missing);
  return { ok: true };
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
