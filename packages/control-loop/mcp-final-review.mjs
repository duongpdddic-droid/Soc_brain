// mcp-final-review.mjs - FINAL_REVIEW leg nhận verdict qua MCP (ChatGPT Plus).
//
// Mô hình vận hành (đã chốt):
//   - Mỗi lượt review: Web2API kích hoạt GPT ĐÚNG MỘT LẦN với activation prompt
//     chứa identity triple + canonical digests của packet.
//   - GPT đọc evidence qua MCP server review-mcp-http (review.get_request /
//     review.get_evidence) rồi trả verdict qua review.submit_decision.
//   - Control-loop KHÔNG lấy verdict từ clipboard/HTTP response của Web2API;
//     chỉ poll file quyết định trong <packetDir>/_decisions/ rồi validate nghiêm
//     ngặt trước khi tiếp nhận vào FSM. Yêu cầu 5 (loại trừ trùng lặp): kết quả
//     clipboard và MCP KHÔNG BAO GIỜ cùng quyết định một lượt - trong nhánh mcp
//     verdict chỉ đến từ _decisions/, trong nhánh web2api verdict chỉ đến từ
//     clipboard (hai nhánh loại trừ lẫn nhau theo SOC_FINAL_REVIEW_VIA).
//
// Contract với review-mcp-http (KHÔNG sửa server - tái sử dụng nguyên vẹn):
//   - Packet là SSOT: server verifyCanonicalDigests yêu cầu artifact CÓ dòng
//     `- reportDigest:` (64 hex) và contentDigest = sha256(utf8 bytes).
//     Consumer tính cùng công thức trên CÙNG file -> chain digest khép kín:
//       packet.reportDigest  --activation--> GPT --> submit_decision.requestDigest
//       sha256(packet bytes) --activation--> GPT --> submit_decision.contentDigest
//     Packet KHÔNG có reportDigest -> fail-closed REVIEW_REQUEST_MCP_NO_REPORT_DIGEST
//     (producer đã được fix để stamp digest - projectReviewReadyPacket).
//   - DIR ALIGNMENT (bắt buộc, fail-closed): MCP server phải đọc/ghi CÙNG dir
//     với dir control-loop project packet. Consumer so sánh
//     env.REVIEW_MCP_REQUEST_DIR (server) với reviewReadyDir (control-loop)
//     và từ chối trước khi kích hoạt nếu lệch - nếu không GPT sẽ resolve
//     artifact cũ hoặc quyết định ghi sang dir không poll -> timeout mơ hồ.
//
// Trạng thái lỗi (R5: fail-closed, trạng thái rõ ràng):
//   - REVIEW_REQUEST_MCP_*  : blocker TRƯỚC FSM mutation (regex REVIEW_ trong
//     control-loop step() -> trả typed code, KHÔNG ghi transition BLOCKED).
//     PACKET_NOT_FOUND / PACKET_STALE / PACKET_NO_REPORT_DIGEST / PACKET_IDENTITY
//     / DIR_MISMATCH / JOURNAL_WRITE_FAILED / ACTIVATION_EXHAUSTED
//   - REVIEW_SUBMIT_MCP_*   : verdict đến nhưng không hợp lệ -> typed blocker,
//     không bao giờ vào FSM: BINDING_MISMATCH / DIGEST_MISMATCH / STALE /
//     DUPLICATE / VERDICT_INVALID
//   - MCP_ACTIVATION_FAILED : Web2API không nhận prompt (postCount=0) ->
//     step() ghi FINAL_REVIEWING->BLOCKED 'finalReview:FAIL' + evidence code
//     (hành vi GIỐNG transport timeout hiện hành; interpretResult unwrap code).
//   - MCP_VERDICT_TIMEOUT   : quá hạn chờ submit -> BLOCKED + evidence code,
//     relaunch retry được (finalReviewFailTail + retryOnOwnFail).
//
// Chống verdict cũ / trùng (at-most-once cho activation, KHÔNG claim
// exactly-once phía network - transport không có idempotency phía nhận):
//   - Journal activation ghi xuống đĩa (atomic: tmp + rename) TRƯỚC khi gọi
//     transport, với attempt phase='pending' -> crash sau POST mà chưa ghi
//     kết quả vẫn để lại dấu vết; resume thấy pending -> KHÔNG gửi thêm,
//     poll trong cửa sổ của attempt rồi trả MCP_ACTIVATION_UNCERTAIN (trung
//     thực: không chứng minh được đã/chưa gửi -> không bao giờ tự POST lại).
//   - Đã có attempt phase='sent' (postCount>0, chứng minh ĐÃ GỬI) cho packet
//     key -> timeout/resume KHÔNG BAO GIỜ tự POST lại: chỉ poll/consume,
//     hết cửa sổ -> MCP_VERDICT_TIMEOUT. Retry CHỈ khi chứng minh CHƯA gửi
//     (toàn attempt phase='failed', postCount=0), tối đa MCP_MAX_ACTIVATIONS.
//   - Journal unreadable (lỗi đọc khác ENOENT) / corrupt (JSON schema hỏng)
//     / binding-digests lệch key -> typed-fail REVIEW_REQUEST_MCP_JOURNAL_*,
//     KHÔNG reset, 0 POST mới.
//   - Mỗi attempt trong journal phải hợp lệ (object, timestamp `at`, phase/
//     postCount nhất quán): failed+postCount>0, sent+postCount<1, pending+
//     postCount!=null, phase lạ, thiếu `at`, không phải object -> JOURNAL_CORRUPT,
//     0 POST (attempt hỏng KHÔNG BAO GIỜ được coi là "chứng minh chưa gửi").
//   - Chỉ KẾT QUẢ transport trả về postCount NGUYÊN (integer) mới là bằng chứng:
//     0 -> CHƯA gửi (ghi failed, retry được); >0 -> ĐÃ GỬI (ghi sent, at-most-
//     once). Transport THROW / thiếu postCount / postCount không integer ->
//     KHÔNG chứng minh được gì -> attempt GIỮ pending trên đĩa, lượt trả
//     MCP_ACTIVATION_UNCERTAIN; resume thấy pending -> poll, KHÔNG gọi transport.
//   - Cũ: record.persistedAt < journal.firstActivatedAt -> REVIEW_SUBMIT_MCP_STALE.
//     Quyết định tồn tại mà CHƯA có journal (chưa từng kích hoạt) -> STALE.
//   - Baseline journal attempts=[] CHƯA ĐỦ để consume: quyết định cần >=1
//     attempt pending/sent hợp lệ cùng binding/digests -> thiếu ->
//     REVIEW_SUBMIT_MCP_NO_ACTIVATION.
//   - Trùng: server đã no-clobber (DUPLICATE_NOOP/CONFLICT); consumer thêm
//     payloadDigest đã consume -> trùng payload == replay idempotent (FSM resume
//     cần), payload KHÁC -> REVIEW_SUBMIT_MCP_DUPLICATE.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DEFAULT_REVIEW_READY_DIR } from '../review-ready/review-ready.mjs';
import {
  buildDecisionFilename,
  computePayloadDigest,
  BOUNDARY_VERDICTS,
} from '../review-mcp-http/submit-decision.mjs';
import { createChatGptPlusWeb2ApiCopyTransport } from './chatgpt-plus-web2api-copy.mjs';

export const MCP_REVIEW_SCHEMA_VERSION = '1';
export const MCP_REVIEW_VIA_ENV = 'SOC_FINAL_REVIEW_VIA';
export const MCP_VERDICT_TIMEOUT_ENV = 'SOC_MCP_VERDICT_TIMEOUT_MS';
export const MCP_MAX_ACTIVATIONS = 3;
export const MCP_DEFAULT_VERDICT_TIMEOUT_MS = 240_000;
export const MCP_DEFAULT_POLL_MS = 1_000;
export const MCP_REVIEW_SOURCE = 'mcp-final-review';

export const MCP_REVIEW_CODES = Object.freeze({
  REVIEW_VIA_INVALID: 'REVIEW_VIA_INVALID',
  PACKET_NOT_FOUND: 'REVIEW_REQUEST_MCP_PACKET_NOT_FOUND',
  PACKET_STALE: 'REVIEW_REQUEST_MCP_PACKET_STALE',
  PACKET_IDENTITY: 'REVIEW_REQUEST_MCP_PACKET_IDENTITY',
  PACKET_NO_REPORT_DIGEST: 'REVIEW_REQUEST_MCP_NO_REPORT_DIGEST',
  DIR_MISMATCH: 'REVIEW_REQUEST_MCP_DIR_MISMATCH',
  JOURNAL_WRITE_FAILED: 'REVIEW_REQUEST_MCP_JOURNAL_WRITE_FAILED',
  JOURNAL_UNREADABLE: 'REVIEW_REQUEST_MCP_JOURNAL_UNREADABLE',
  JOURNAL_CORRUPT: 'REVIEW_REQUEST_MCP_JOURNAL_CORRUPT',
  JOURNAL_MISMATCH: 'REVIEW_REQUEST_MCP_JOURNAL_MISMATCH',
  ACTIVATION_EXHAUSTED: 'REVIEW_REQUEST_MCP_ACTIVATION_EXHAUSTED',
  ACTIVATION_FAILED: 'MCP_ACTIVATION_FAILED',
  ACTIVATION_PENDING: 'MCP_ACTIVATION_UNCERTAIN',
  VERDICT_TIMEOUT: 'MCP_VERDICT_TIMEOUT',
  BINDING_MISMATCH: 'REVIEW_SUBMIT_MCP_BINDING_MISMATCH',
  DIGEST_MISMATCH: 'REVIEW_SUBMIT_MCP_DIGEST_MISMATCH',
  STALE: 'REVIEW_SUBMIT_MCP_STALE',
  DUPLICATE: 'REVIEW_SUBMIT_MCP_DUPLICATE',
  VERDICT_INVALID: 'REVIEW_SUBMIT_MCP_VERDICT_INVALID',
  NO_ACTIVATION: 'REVIEW_SUBMIT_MCP_NO_ACTIVATION',
});

const fail = (code, detail = null) => ({ ok: false, code, detail });

// ---- mode switch (env) -------------------------------------------------------
// SOC_FINAL_REVIEW_VIA: unset/''/'web2api' -> đường clipboard hiện hành (mặc
// định, không đổi hành vi production); 'mcp' -> nhánh MCP; khác -> fail-closed.
export function resolveReviewVia(env = process.env) {
  const raw = env[MCP_REVIEW_VIA_ENV];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { ok: true, via: 'web2api' };
  }
  const v = String(raw).trim().toLowerCase();
  if (v === 'mcp') return { ok: true, via: 'mcp' };
  if (v === 'web2api') return { ok: true, via: 'web2api' };
  return fail(MCP_REVIEW_CODES.REVIEW_VIA_INVALID,
    `${MCP_REVIEW_VIA_ENV}=${String(raw)} (chỉ chấp nhận: 'mcp', 'web2api' hoặc rỗng)`);
}

export function sha256Hex(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

// ---- packet meta (SSOT = file packet; regex đồng bộ với review-mcp-http) -----
export function parsePacketMeta(content) {
  if (typeof content !== 'string' || !content.trim()) {
    return fail(MCP_REVIEW_CODES.PACKET_NOT_FOUND, 'packet rỗng/không đọc được');
  }
  const grab = (re) => { const m = re.exec(content); return m ? m[1].trim() : null; };
  const repository = grab(/^- repository:\s*(\S[^\r\n]*?)\s*$/m);
  const issue = grab(/^- issue:\s*(\d+)\s*$/m);
  const pullRequest = grab(/^- pullRequest:\s*(\d+)\s*$/m);
  const headSha = grab(/^- headSha:\s*([0-9a-f]{40})\b/im);
  // Đồng bộ SSOT với submit-decision.verifyCanonicalDigests /
  // review-mcp-http.buildRequestPayload - KHÔNG đổi regex một phía.
  const reportDigest = grab(/^- reportDigest:\s*([0-9a-f]{64})\s*$/m);
  const terminalStatus = grab(/^- status:\s*\*\*([A-Z_]+)\*\*/m);
  if (!repository || !issue || !headSha) {
    return fail(MCP_REVIEW_CODES.PACKET_IDENTITY, 'packet thiếu Identity block (repository/issue/headSha)');
  }
  if (!pullRequest) {
    return fail(MCP_REVIEW_CODES.PACKET_IDENTITY, 'packet thiếu pullRequest canonical');
  }
  if (!reportDigest) {
    return fail(MCP_REVIEW_CODES.PACKET_NO_REPORT_DIGEST,
      'packet không có `- reportDigest:` - server sẽ từ chối submit_decision (REQUEST_DIGEST_MISMATCH). Producer phải stamp digest (projectReviewReadyPacket).');
  }
  if (terminalStatus !== 'READY_FOR_REVIEW') {
    return fail(MCP_REVIEW_CODES.PACKET_NOT_FOUND,
      `packet terminalStatus=${terminalStatus ?? 'missing'} (cần READY_FOR_REVIEW)`);
  }
  return {
    ok: true,
    meta: {
      repository,
      issue: Number(issue),
      pullRequest: Number(pullRequest),
      headSha: headSha.toLowerCase(),
      requestDigest: reportDigest.toLowerCase(),
      terminalStatus,
    },
  };
}

// ---- activation prompt -------------------------------------------------------
// Kích hoạt MỘT LẦN cho mỗi lượt review. Prompt KHÔNG chứa evidence (GPT tự
// đọc qua MCP), CHỈ chứa identity + digests + quy trình tool call. Verdict
// KHÔNG được trả trong chat reply - chỉ qua review.submit_decision (yêu cầu 5:
// clipboard không bao giờ là nguồn verdict của nhánh mcp).
export function buildMcpActivationPrompt({ meta, contentDigest }) {
  const id = { repository: meta.repository, issue: meta.issue, headSha: meta.headSha };
  const idJson = JSON.stringify(id);
  return [
    '[SOC_BRAIN MCP REVIEW ACTIVATION - ONE REVIEW TURN]',
    'You are the reviewer for one canonical Soc_brain handoff. The evidence is NOT in this message.',
    'Canonical identity (use EXACTLY these values in every tool call):',
    `  repository: ${meta.repository}`,
    `  issue: ${meta.issue}`,
    `  pullRequest: ${meta.pullRequest}`,
    `  headSha: ${meta.headSha}`,
    'Canonical digests of the review packet (bind your verdict to THIS packet):',
    `  requestDigest (reportDigest): ${meta.requestDigest}`,
    `  contentDigest (sha256 of packet bytes): ${contentDigest}`,
    '',
    'Required MCP tool calls, in order:',
    `1. review.get_request ${idJson} - confirm terminalStatus is READY_FOR_REVIEW and reportDigest equals the requestDigest above.`,
    `2. review.get_evidence ${idJson} - read the FULL evidence packet; review it against its acceptance criteria.`,
    '3. review.submit_decision with:',
    `   ${JSON.stringify({ ...id, requestDigest: meta.requestDigest, contentDigest })}`,
    '   plus: verdict (PASS | REWORK | BLOCKED), findings ([] for PASS; each {severity, code, text} for REWORK),',
    '   evidenceRequests, confidence (0..1 or null), submittedBy: "chatgpt-plus-mcp".',
    '   Use the requestDigest and contentDigest values above EXACTLY as given.',
    '',
    'After submit_decision returns success, reply to THIS message with EXACTLY ONE fenced JSON block:',
    '```json',
    `{ "ack": "mcp-review-activation", "requestDigest": "${meta.requestDigest}" }`,
    '```',
    'This reply is only an acknowledgement. The verdict travels ONLY through review.submit_decision,',
    'never through this chat reply.',
  ].join('\n');
}

// ---- expected decision path (SSOT: cùng builder với server) ------------------
export function expectedDecisionPath({ packetDir, meta }) {
  const submission = {
    identity: {
      repository: meta.repository,
      issue: meta.issue,
      pullRequest: meta.pullRequest,
      headSha: meta.headSha,
    },
    requestDigest: meta.requestDigest,
  };
  return path.join(packetDir, '_decisions', buildDecisionFilename(submission));
}

// ---- journal ----------------------------------------------------------------
function journalKey({ meta }) {
  const slug = meta.repository.replace(/[^A-Za-z0-9._-]+/g, '_');
  return `${slug}_Issue-${meta.issue}_${meta.headSha.slice(0, 7)}_${meta.requestDigest.slice(0, 12)}`;
}

function journalPathFor({ stateDir, meta }) {
  return path.join(stateDir, 'mcp-review', `${journalKey({ meta })}.json`);
}

// Trạng thái 1 attempt activation:
//   pending - đã ghi xuống đĩa TRƯỚC khi gọi transport, chưa rõ kết quả
//             (crash giữa POST và ghi kết quả -> treo ở đây, KHÔNG gửi lại).
//   sent    - transport báo postCount>0: chứng minh ĐÃ GỬI (at-most-once).
//   failed  - transport báo postCount=0: chứng minh CHƯA gửi -> retry được.
// Attempt journal cũ (thiếu phase) suy ra từ postCount; thiếu dữ liệu -> pending
// (hướng an toàn: coi như chưa rõ -> không gửi lại).
export function attemptPhase(a) {
  if (a && typeof a === 'object' && typeof a.phase === 'string'
      && ['pending', 'sent', 'failed'].includes(a.phase)) return a.phase;
  if (a && Number(a.postCount) > 0) return 'sent';
  if (a && Number(a.postCount) === 0) return 'failed';
  return 'pending';
}

// Journal phải có ÍT NHẤT một attempt pending/sent thì lượt review này (hoặc
// lượt trước cùng packet) đã thực sự bắt đầu kích hoạt - baseline attempts=[]
// KHÔNG đủ để consume một quyết định.
export function hasValidActivation(journal) {
  if (!journal || typeof journal !== 'object' || !Array.isArray(journal.attempts)) return false;
  return journal.attempts.some((a) => {
    const p = attemptPhase(a);
    return p === 'sent' || p === 'pending';
  });
}

// Validate TỪNG attempt của journal: object, timestamp, phase/postCount nhất
// quán. Attempt hỏng (malformed hoặc mâu thuẫn - điển hình failed+postCount>0:
// vừa bảo "chưa gửi" vừa khai "đã POST 3 lần") KHÔNG được coi là bằng chứng
// nào cả -> typed-fail JOURNAL_CORRUPT, không reset, 0 POST.
//   phase=pending   -> postCount phải null/undefined (chưa rõ kết quả).
//   phase=sent      -> postCount phải integer >= 1 (chứng minh ĐÃ GỬI).
//   phase=failed    -> postCount phải integer === 0 (chứng minh CHƯA gửi).
//   thiếu phase     -> journal cũ: chỉ postCount integer >= 0 mới suy ra được
//                      phase (0 -> failed, >0 -> sent); thiếu/sai -> corrupt.
function validateJournalAttempts(journalPath, attempts) {
  const corrupt = (index, error, attempt) => fail(MCP_REVIEW_CODES.JOURNAL_CORRUPT,
    { journalPath, index, error, attempt,
      note: 'attempt journal malformed/không nhất quán - typed-fail, không reset, không gửi activation' });
  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    if (!a || typeof a !== 'object' || Array.isArray(a)) {
      return corrupt(i, `attempt[${i}] không phải object JSON (${JSON.stringify(a)})`, a);
    }
    if (typeof a.at !== 'string' || !Number.isFinite(Date.parse(a.at))) {
      return corrupt(i, `attempt[${i}].at=${JSON.stringify(a.at)} không phải ISO timestamp hợp lệ`, a);
    }
    const hasPhase = a.phase !== undefined && a.phase !== null;
    if (hasPhase && !['pending', 'sent', 'failed'].includes(a.phase)) {
      return corrupt(i, `attempt[${i}].phase=${JSON.stringify(a.phase)} không hợp lệ (cần pending|sent|failed)`, a);
    }
    const pc = a.postCount;
    if (hasPhase && a.phase === 'pending') {
      if (pc !== null && pc !== undefined) {
        return corrupt(i, `attempt[${i}] phase=pending nhưng postCount=${JSON.stringify(pc)} (pending = chưa rõ kết quả nên postCount phải null)`, a);
      }
    } else if (hasPhase && a.phase === 'sent') {
      if (!Number.isInteger(pc) || pc < 1) {
        return corrupt(i, `attempt[${i}] phase=sent nhưng postCount=${JSON.stringify(pc)} (cần integer >= 1 để chứng minh ĐÃ GỬI)`, a);
      }
    } else if (hasPhase && a.phase === 'failed') {
      if (!Number.isInteger(pc) || pc !== 0) {
        return corrupt(i, `attempt[${i}] phase=failed nhưng postCount=${JSON.stringify(pc)} (chỉ integer 0 mới chứng minh CHƯA gửi)`, a);
      }
    } else if (!Number.isInteger(pc) || pc < 0) {
      // Thiếu phase (journal cũ): postCount integer là bằng chứng duy nhất.
      return corrupt(i, `attempt[${i}] thiếu phase và postCount=${JSON.stringify(pc)} không phải integer >= 0 - không suy ra được phase`, a);
    }
  }
  return null;
}

// Đọc journal phân biệt rõ 3 trạng thái:
//   { ok:true, journal:null }                    - ENOENT (chưa từng tạo) -> hợp lệ.
//   fail(REVIEW_REQUEST_MCP_JOURNAL_UNREADABLE)  - đọc lỗi KHÁC ENOENT.
//   fail(REVIEW_REQUEST_MCP_JOURNAL_CORRUPT)     - JSON hỏng / schema thiếu field.
// Journal hỏng typed-fail - KHÔNG BAO GIỜ reset rồi gửi lại.
function readJournal(journalPath) {
  let raw;
  try {
    raw = fs.readFileSync(journalPath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, journal: null };
    return fail(MCP_REVIEW_CODES.JOURNAL_UNREADABLE,
      { journalPath, error: String((e && e.message) || e),
        note: 'khác ENOENT (permission/EISDIR/IO...) - typed-fail, không gửi activation' });
  }
  let j;
  try {
    j = JSON.parse(raw);
  } catch (e) {
    return fail(MCP_REVIEW_CODES.JOURNAL_CORRUPT,
      { journalPath, error: `JSON.parse: ${String((e && e.message) || e)}`,
        note: 'journal corrupt - typed-fail, không reset, không gửi activation' });
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)
      || typeof j.firstActivatedAt !== 'string'
      || !Array.isArray(j.attempts)
      || typeof j.requestDigest !== 'string'
      || typeof j.contentDigest !== 'string'
      || !j.identity || typeof j.identity !== 'object') {
    return fail(MCP_REVIEW_CODES.JOURNAL_CORRUPT,
      { journalPath, error: 'schema journal thiếu field bắt buộc (firstActivatedAt/attempts/requestDigest/contentDigest/identity)',
        note: 'journal corrupt - typed-fail, không reset, không gửi activation' });
  }
  const attemptError = validateJournalAttempts(journalPath, j.attempts);
  if (attemptError) return attemptError;
  return { ok: true, journal: j };
}

// Ghi atomic: tmp file cùng dir rồi rename (thay thế đích). Giữa write và
// rename, crash để lại tmp rác chứ KHÔNG bao giờ để journal đích dở dang -
// çerçeve tai nạn (torn write) không thể tự sinh phase sai.
function writeJournal(journalPath, journal) {
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  const tmpPath = `${journalPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(journal, null, 2), 'utf8');
  try {
    fs.renameSync(tmpPath, journalPath);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch { /* tmp rác best-effort */ }
    throw e;
  }
}

// ---- decision validation ------------------------------------------------------
// expected: {repository, issue, pullRequest, headSha, requestDigest, contentDigest}
// journal : {firstActivatedAt, attempts, consumedPayloadDigest}
export function validateMcpDecision({ record, expected, journal }) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return fail(MCP_REVIEW_CODES.VERDICT_INVALID, 'decision file không phải object JSON');
  }
  const id = record.identity && typeof record.identity === 'object' ? record.identity : null;
  if (!id) return fail(MCP_REVIEW_CODES.VERDICT_INVALID, 'record thiếu identity');
  const sameRepo = typeof id.repository === 'string'
    && id.repository.toLowerCase() === expected.repository.toLowerCase();
  if (!sameRepo || Number(id.issue) !== expected.issue
      || Number(id.pullRequest) !== expected.pullRequest
      || typeof id.headSha !== 'string' || id.headSha.toLowerCase() !== expected.headSha) {
    return fail(MCP_REVIEW_CODES.BINDING_MISMATCH, {
      expected: { repository: expected.repository, issue: expected.issue, pullRequest: expected.pullRequest, headSha: expected.headSha },
      got: { repository: id.repository, issue: id.issue, pullRequest: id.pullRequest, headSha: id.headSha },
    });
  }
  if (typeof record.requestDigest !== 'string'
      || record.requestDigest.toLowerCase() !== expected.requestDigest) {
    return fail(MCP_REVIEW_CODES.DIGEST_MISMATCH, {
      field: 'requestDigest', expected: expected.requestDigest, got: record.requestDigest ?? null,
    });
  }
  if (typeof record.contentDigest !== 'string'
      || record.contentDigest.toLowerCase() !== expected.contentDigest) {
    return fail(MCP_REVIEW_CODES.DIGEST_MISMATCH, {
      field: 'contentDigest', expected: expected.contentDigest, got: record.contentDigest ?? null,
    });
  }
  const verdict = record.verdict;
  if (!BOUNDARY_VERDICTS.includes(verdict)) {
    return fail(MCP_REVIEW_CODES.VERDICT_INVALID, `verdict=${JSON.stringify(verdict)} (cần một trong ${BOUNDARY_VERDICTS.join(', ')})`);
  }
  const canonicalMap = { PASS: 'APPROVED', REWORK: 'CHANGES_REQUESTED', BLOCKED: 'BLOCKED' };
  if (record.canonicalVerdict !== canonicalMap[verdict]) {
    return fail(MCP_REVIEW_CODES.VERDICT_INVALID,
      `canonicalVerdict=${JSON.stringify(record.canonicalVerdict)} không khớp verdict=${verdict}`);
  }
  if (!Array.isArray(record.findings) || !Array.isArray(record.evidenceRequests)) {
    return fail(MCP_REVIEW_CODES.VERDICT_INVALID, 'findings/evidenceRequests phải là array');
  }
  if (record.confidence !== null
      && (typeof record.confidence !== 'number' || record.confidence < 0 || record.confidence > 1)) {
    return fail(MCP_REVIEW_CODES.VERDICT_INVALID, `confidence=${JSON.stringify(record.confidence)} (cần null hoặc 0..1)`);
  }
  // Integrity: payloadDigest tính lại phải khớp (chống sửa file thủ công).
  let recomputed = null;
  try { recomputed = computePayloadDigest(record); } catch { recomputed = null; }
  if (typeof record.payloadDigest !== 'string' || recomputed !== record.payloadDigest) {
    return fail(MCP_REVIEW_CODES.DIGEST_MISMATCH, {
      field: 'payloadDigest', expected: recomputed, got: record.payloadDigest ?? null,
      note: 'payloadDigest tính lại từ record không khớp - file bị sửa hoặc format lệch',
    });
  }
  const persistedAt = Date.parse(record.persistedAt);
  if (!Number.isFinite(persistedAt)) {
    return fail(MCP_REVIEW_CODES.VERDICT_INVALID, `persistedAt=${JSON.stringify(record.persistedAt)} không phải ISO timestamp`);
  }
  if (!journal || typeof journal.firstActivatedAt !== 'string') {
    return fail(MCP_REVIEW_CODES.STALE,
      { persistedAt: record.persistedAt, note: 'quyết định tồn tại trước khi lượt review này từng kích hoạt (chưa có journal) - verdict cũ/không được yêu cầu' });
  }
  // F3: journal PHẢI có ít nhất một attempt pending/sent (activation thật đã
  // bắt đầu, cùng binding/digests - leg đã verify journal khớp meta trước khi
  // consume). Baseline attempts=[] không đủ bằng chứng -> reject.
  if (!hasValidActivation(journal)) {
    return fail(MCP_REVIEW_CODES.NO_ACTIVATION,
      { persistedAt: record.persistedAt, attempts: Array.isArray(journal.attempts) ? journal.attempts.length : null,
        note: 'journal chưa từng kích hoạt (chỉ baseline attempts=[]) - quyết định không có activation tương ứng' });
  }
  const firstActivated = Date.parse(journal.firstActivatedAt);
  if (!Number.isFinite(firstActivated) || persistedAt < firstActivated) {
    return fail(MCP_REVIEW_CODES.STALE,
      { persistedAt: record.persistedAt, firstActivatedAt: journal.firstActivatedAt });
  }
  if (typeof journal.consumedPayloadDigest === 'string'
      && journal.consumedPayloadDigest !== record.payloadDigest) {
    return fail(MCP_REVIEW_CODES.DUPLICATE,
      { consumedPayloadDigest: journal.consumedPayloadDigest, got: record.payloadDigest,
        note: 'đã consume một payloadDigest KHÁC cho cùng lượt review (server no-clobber lẽ ra chặn)' });
  }
  // payloadDigest == consumed -> replay idempotent cho FSM resume (cùng record).
  const value = {
    verdict,
    findings: record.findings.map((f) => {
      const sev = f && typeof f === 'object' ? (f.severity || null) : null;
      const code = f && typeof f === 'object' ? (f.code || null) : null;
      const text = f && typeof f === 'object' ? String(f.text ?? '') : String(f ?? '');
      const tag = [sev, code].filter(Boolean).join('/');
      return tag ? `[${tag}] ${text}` : text;
    }),
    evidenceRequests: record.evidenceRequests.map((e) => {
      if (!e || typeof e !== 'object') return String(e ?? '');
      const kind = e.kind ? `${e.kind}: ` : '';
      return `${kind}${String(e.note ?? '')}`;
    }),
    remediation: [],
    confidence: typeof record.confidence === 'number' ? record.confidence : null,
    binding: {
      repository: expected.repository,
      issue: expected.issue,
      headSha: expected.headSha,
    },
    metadata: {
      source: MCP_REVIEW_SOURCE,
      requestDigest: expected.requestDigest,
      contentDigest: expected.contentDigest,
      submittedBy: typeof record.submittedBy === 'string' ? record.submittedBy : null,
      payloadDigest: record.payloadDigest,
      persistedAt: record.persistedAt,
      firstActivatedAt: journal.firstActivatedAt,
      activationAttempts: Array.isArray(journal.attempts) ? journal.attempts.length : 0,
    },
  };
  return { ok: true, value, payloadDigest: record.payloadDigest };
}

// ---- main leg ------------------------------------------------------------------
// Tạo một lần per runner; activation transport factory injectable cho test.
// Trả về async finalReview({sessionPath, report, preReview}) đúng contract
// của deps.finalReview: {ok:true, value} | {ok:false, code, detail}.
export function createMcpFinalReview({
  reviewReadyDir,
  stateDir,
  env = process.env,
  createActivationTransport = null,
  nowImpl = () => Date.now(),
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = null,
  pollMs = MCP_DEFAULT_POLL_MS,
  log = () => {},
} = {}) {
  if (typeof reviewReadyDir !== 'string' || !reviewReadyDir) {
    throw new Error('createMcpFinalReview: reviewReadyDir bắt buộc (dir control-loop project packet)');
  }
  if (typeof stateDir !== 'string' || !stateDir) {
    throw new Error('createMcpFinalReview: stateDir bắt buộc (journal nằm dưới đây)');
  }
  const packetDir = path.resolve(reviewReadyDir);
  const decisionsDir = path.join(packetDir, '_decisions');
  const configuredTimeout = timeoutMs !== null && Number.isFinite(Number(timeoutMs))
    ? Number(timeoutMs)
    : (Number(env[MCP_VERDICT_TIMEOUT_ENV]) > 0
      ? Number(env[MCP_VERDICT_TIMEOUT_ENV])
      : MCP_DEFAULT_VERDICT_TIMEOUT_MS);

  // DIR ALIGNMENT fail-closed: server (env) phải trỏ đúng dir ta poll.
  const serverDir = env.REVIEW_MCP_REQUEST_DIR
    ? path.resolve(String(env.REVIEW_MCP_REQUEST_DIR))
    : DEFAULT_REVIEW_READY_DIR();
  if (serverDir !== packetDir) {
    return async () => fail(MCP_REVIEW_CODES.DIR_MISMATCH, {
      serverRequestDir: serverDir,
      packetDir,
      hint: 'start review-mcp-http với REVIEW_MCP_REQUEST_DIR bằng đúng dir control-loop project packet (reviewReadyDir)',
    });
  }

  const makeActivationTransport = typeof createActivationTransport === 'function'
    ? createActivationTransport
    : () => createChatGptPlusWeb2ApiCopyTransport({}); // đọc SOC_W2A_HOST/PORT/CDP_PORT từ env

  return async function mcpFinalReview({ sessionPath, session } = {}) {
    if (!session || typeof session !== 'object') {
      const rs = sessionPath ? tryReadSession(sessionPath) : null;
      if (!rs) return fail('REVIEW_SESSION_UNREADABLE', 'session không đọc được cho MCP leg');
      session = rs;
    }
    // ---- 1. Packet resolution: đúng file mà server sẽ serve (exact-head match,
    // scheme khớp packetPathFor). Sau đó verify identity với session.
    const packet = resolvePacket({ packetDir, session });
    if (!packet.ok) return packet;

    // ---- 2. Meta + digests từ packet bytes (SSOT, cùng công thức với server).
    const metaR = parsePacketMeta(packet.content);
    if (!metaR.ok) return metaR;
    const meta = metaR.meta;
    if (meta.headSha !== String(session.headSha || '').toLowerCase()) {
      return fail(MCP_REVIEW_CODES.PACKET_STALE,
        { packetHeadSha: meta.headSha, sessionHeadSha: session.headSha });
    }
    if (Number(session.issueNumber) !== meta.issue) {
      return fail(MCP_REVIEW_CODES.PACKET_IDENTITY,
        { packetIssue: meta.issue, sessionIssue: session.issueNumber });
    }
    if (session.prNumber !== undefined && session.prNumber !== null
        && Number(session.prNumber) !== meta.pullRequest) {
      return fail(MCP_REVIEW_CODES.PACKET_IDENTITY,
        { packetPullRequest: meta.pullRequest, sessionPrNumber: session.prNumber });
    }
    const contentDigest = sha256Hex(packet.content);
    const decisionPath = expectedDecisionPath({ packetDir, meta });
    const journalPath = journalPathFor({ stateDir, meta });

    // ---- 3. Journal: đọc fail-closed, baseline tạo TRƯỚC activation.
    // Journal unreadable/corrupt -> typed-fail (0 POST, không reset).
    const journalR = readJournal(journalPath);
    if (!journalR.ok) return journalR;
    let journal = journalR.journal;
    if (!journal) {
      journal = {
        schemaVersion: MCP_REVIEW_SCHEMA_VERSION,
        key: journalKey({ meta }),
        identity: { repository: meta.repository, issue: meta.issue, pullRequest: meta.pullRequest, headSha: meta.headSha },
        requestDigest: meta.requestDigest,
        contentDigest,
        firstActivatedAt: new Date(nowImpl()).toISOString(),
        attempts: [],
        consumedPayloadDigest: null,
      };
      // Journal write fail-closed: không có baseline -> không thể chống verdict cũ.
      try { writeJournal(journalPath, journal); } catch (e) {
        return fail(MCP_REVIEW_CODES.JOURNAL_WRITE_FAILED,
          { journalPath, error: String((e && e.message) || e) });
      }
    } else if (String(journal.identity.repository ?? '').toLowerCase() !== meta.repository.toLowerCase()
        || Number(journal.identity.issue) !== meta.issue
        || Number(journal.identity.pullRequest) !== meta.pullRequest
        || String(journal.identity.headSha ?? '').toLowerCase() !== meta.headSha
        || journal.requestDigest !== meta.requestDigest
        || journal.contentDigest !== contentDigest) {
      // Key trùng nhưng binding/digests LỆCH (corrupt/foreign/48-bit collision
      // req12): KHÔNG reset, KHÔNG gửi lại - typed-fail để người điều hành xem.
      return fail(MCP_REVIEW_CODES.JOURNAL_MISMATCH,
        { journalPath,
          journal: { identity: journal.identity, requestDigest: journal.requestDigest, contentDigest: journal.contentDigest },
          packet: { identity: { repository: meta.repository, issue: meta.issue, pullRequest: meta.pullRequest, headSha: meta.headSha }, requestDigest: meta.requestDigest, contentDigest },
          note: 'journal không khớp packet hiện tại - không reset, không gửi activation' });
    }

    const expected = {
      repository: meta.repository,
      issue: meta.issue,
      pullRequest: meta.pullRequest,
      headSha: meta.headSha,
      requestDigest: meta.requestDigest,
      contentDigest,
    };

    const consumeExisting = () => {
      let record = null;
      try { record = JSON.parse(fs.readFileSync(decisionPath, 'utf8')); } catch (e) {
        return fail(MCP_REVIEW_CODES.VERDICT_INVALID,
          { decisionPath, error: String((e && e.message) || e) });
      }
      const v = validateMcpDecision({ record, expected, journal });
      if (!v.ok) return v;
      // Audit consume (best-effort: replay idempotent vẫn chấp nhận nếu ghi fail).
      try {
        writeJournal(journalPath, { ...journal, consumedPayloadDigest: v.payloadDigest, consumedAt: new Date(nowImpl()).toISOString() });
      } catch (e) { log(`journal consume write failed (không chặn replay): ${String((e && e.message) || e)}`); }
      log(`mcp verdict consumed: ${path.basename(decisionPath)} verdict=${v.value.verdict}`);
      return { ok: true, value: v.value };
    };

    // ---- 4. Quyết định đã tồn tại (resume/ lượt trước) -> consume, KHÔNG kích hoạt lại.
    if (fs.existsSync(decisionPath)) {
      return consumeExisting();
    }

    // ---- 5. Activation lifecycle - AT-MOST-ONCE cho packet key (không claim
    // exactly-once phía network; transport không có idempotency phía nhận):
    //   1) Journal còn attempt 'pending'  -> CHƯA rõ đã gửi hay chưa (crash giữa
    //      POST và ghi kết quả): KHÔNG gửi thêm; poll tới cửa sổ của attempt,
    //      hết -> MCP_ACTIVATION_UNCERTAIN (trung thực, không tự POST lại).
    //   2) Journal có attempt 'sent'      -> chứng minh ĐÃ GỬI: KHÔNG BAO GIỜ
    //      gửi lại dù timeout/resume; poll/consume, hết cửa sổ -> VERDICT_TIMEOUT.
    //   3) Chỉ toàn attempt 'failed'      -> chứng minh CHƯA GỬI (postCount=0):
    //      mới được retry, tối đa MCP_MAX_ACTIVATIONS attempt.
    const windowOf = (attempt) => {
      const at = Date.parse(attempt.at);
      return (Number.isFinite(at) ? at : nowImpl()) + configuredTimeout;
    };
    const pendingAttempt = journal.attempts.find((a) => attemptPhase(a) === 'pending');
    const sentAttempt = journal.attempts.find((a) => attemptPhase(a) === 'sent');

    if (pendingAttempt) {
      log(`mcp resume: attempt pending từ ${pendingAttempt.at} -> poll trong cửa sổ, KHÔNG gửi thêm (chưa rõ đã gửi hay chưa)`);
      for (;;) {
        if (fs.existsSync(decisionPath)) return consumeExisting();
        if (nowImpl() >= windowOf(pendingAttempt)) {
          return fail(MCP_REVIEW_CODES.ACTIVATION_PENDING,
            { decisionPath, pendingSince: pendingAttempt.at, attempts: journal.attempts.length,
              hint: 'attempt activation chưa có kết quả (crash/kill giữa POST và ghi journal) - KHÔNG chứng minh được đã/chưa gửi nên không tự gửi lại; nếu verdict về muộn, relaunch sẽ consume, nếu không thì cần người điều hành xác minh rồi can thiệp thủ công' });
        }
        await sleepImpl(pollMs);
      }
    }

    if (sentAttempt) {
      log(`mcp resume: đã có attempt sent ${sentAttempt.at} -> poll/consume, KHÔNG gửi lại (at-most-once)`);
      for (;;) {
        if (fs.existsSync(decisionPath)) return consumeExisting();
        if (nowImpl() >= windowOf(sentAttempt)) {
          return fail(MCP_REVIEW_CODES.VERDICT_TIMEOUT,
            { decisionPath, waitedMs: configuredTimeout,
              activatedAt: journal.firstActivatedAt,
              attempts: journal.attempts.length,
              lastActivation: sentAttempt,
              atMostOnce: true,
              hint: 'đã gửi activation đúng một lần cho lượt review này mà không thấy review.submit_decision - KHÔNG gửi lại (at-most-once); kiểm tra GPT có gọi được MCP (extension/connector) và MCP server có REVIEW_MCP_REQUEST_DIR trỏ đúng dir, relaunch sẽ consume nếu verdict về muộn' });
        }
        await sleepImpl(pollMs);
      }
    }

    // ---- 5b. Retry CHỈ khi chứng minh CHƯA gửi (toàn attempt 'failed').
    if (journal.attempts.length >= MCP_MAX_ACTIVATIONS) {
      return fail(MCP_REVIEW_CODES.ACTIVATION_EXHAUSTED,
        { decisionPath, attempts: journal.attempts.length, max: MCP_MAX_ACTIVATIONS,
          hint: 'không có quyết định sau nhiều lần kích hoạt (chỉ các lần chứng minh postCount=0 mới được tính lại) - kiểm tra Web2API/extension/MCP server trước khi relaunch' });
    }
    const activationPrompt = buildMcpActivationPrompt({ meta, contentDigest });

    // F2: ghi dấu PENDING xuống đĩa (atomic) TRƯỚC khi gọi transport. Crash
    // sau POST mà chưa ghi kết quả vẫn để lại dấu vết -> resume thấy pending
    // và KHÔNG BAO GIỜ gửi trùng.
    const attemptAt = new Date(nowImpl()).toISOString();
    const pendingAttemptNew = {
      at: attemptAt, phase: 'pending', postCount: null, ok: null,
      code: null, conversationId: null, modelSlug: null,
    };
    journal = { ...journal, attempts: [...journal.attempts, pendingAttemptNew] };
    try { writeJournal(journalPath, journal); } catch (e) {
      // Không có dấu pending -> KHÔNG gửi activation (fail-closed về phía chưa-gửi).
      return fail(MCP_REVIEW_CODES.JOURNAL_WRITE_FAILED,
        { journalPath, error: String((e && e.message) || e),
          note: 'không ghi được dấu pending trước transport - không gửi activation' });
    }

    let activationResult = null;
    let transportThrew = false;
    try {
      const transport = makeActivationTransport();
      activationResult = await transport({ prompt: activationPrompt });
    } catch (e) {
      // THROW KHÔNG phải bằng chứng "chưa gửi" (throw có thể đến SAU khi
      // POST) -> tuyệt đối không bịa postCount=0, không ghi phase=failed.
      transportThrew = true;
      activationResult = { ok: false, code: 'MCP_ACTIVATION_THROW', error: String((e && e.message) || e) };
    }
    // Chỉ postCount NGUYÊN trả về trực tiếp từ transport mới là bằng chứng:
    //   0  -> chứng minh CHƯA gửi (ghi failed, retry được)
    //   >0 -> chứng minh ĐÃ GỬI (ghi sent, at-most-once)
    // Throw / thiếu transportMeta.postCount / postCount không integer ->
    // KHÔNG chứng minh được gì: attempt pending đã ghi xuống đĩa TRƯỚC khi gọi
    // transport vẫn GIỮ nguyên, lượt trả MCP_ACTIVATION_UNCERTAIN (resume thấy
    // pending -> poll trong cửa sổ, KHÔNG gọi transport thêm).
    const rawPostCount = (!transportThrew && activationResult && activationResult.transportMeta)
      ? activationResult.transportMeta.postCount : undefined;
    const provenUnsent = Number.isInteger(rawPostCount) && rawPostCount === 0;
    const provenSent = Number.isInteger(rawPostCount) && rawPostCount > 0;
    if (!provenUnsent && !provenSent) {
      log(`mcp activation #${journal.attempts.length}: không có bằng chứng postCount (threw=${transportThrew} raw=${JSON.stringify(rawPostCount ?? null)}) -> giữ pending, trả UNCERTAIN`);
      return fail(MCP_REVIEW_CODES.ACTIVATION_PENDING,
        { decisionPath, pendingSince: attemptAt, attempts: journal.attempts.length,
          transportThrew,
          transportCode: activationResult && activationResult.code ? activationResult.code : null,
          transportError: activationResult && activationResult.error ? activationResult.error : null,
          rawPostCount: rawPostCount === undefined ? null : rawPostCount,
          hint: 'transport throw hoặc postCount thiếu/không phải integer -> chưa chứng minh được đã/chưa gửi: journal giữ pending, resume chỉ poll và KHÔNG gửi lại; nếu quá cửa sổ mà verdict chưa về thì cần người điều hành xác minh' });
    }
    const finalAttempt = {
      at: attemptAt,
      phase: provenSent ? 'sent' : 'failed',
      ok: activationResult && activationResult.ok === true,
      code: activationResult && activationResult.code ? activationResult.code : null,
      conversationId: activationResult && activationResult.conversationId ? activationResult.conversationId : null,
      postCount: rawPostCount,
      modelSlug: activationResult && activationResult.modelSlug ? activationResult.modelSlug : null,
    };
    journal = { ...journal, attempts: [...journal.attempts.slice(0, -1), finalAttempt] };
    try { writeJournal(journalPath, journal); } catch (e) {
      // POST có thể đã gửi nhưng không ghi được kết quả: journal vẫn 'pending'
      // -> resume sẽ uncertain, KHÔNG gửi lại. Fail-closed tại đây.
      return fail(MCP_REVIEW_CODES.JOURNAL_WRITE_FAILED,
        { journalPath, error: String((e && e.message) || e),
          note: 'không ghi được kết quả attempt - journal giữ pending, resume không gửi lại' });
    }
    if (provenUnsent) {
      // Chứng minh CHƯA gửi (transport trả về đúng integer postCount=0) -> retry được.
      return fail(MCP_REVIEW_CODES.ACTIVATION_FAILED,
        { transportCode: finalAttempt.code, error: activationResult && activationResult.error ? activationResult.error : null,
          attempts: journal.attempts.length, retryable: true });
    }
    // postCount integer > 0 -> phase='sent': từ đây vĩnh viễn không gửi lại cho packet key.
    log(`mcp activation #${journal.attempts.length}: ok=${finalAttempt.ok} code=${finalAttempt.code ?? '-'} postCount=${rawPostCount} (sent, at-most-once)`);

    // ---- 6. Poll quyết định (kết quả activation/ack KHÔNG BAO GIỜ là verdict).
    for (;;) {
      if (fs.existsSync(decisionPath)) return consumeExisting();
      if (nowImpl() >= windowOf(finalAttempt)) {
        return fail(MCP_REVIEW_CODES.VERDICT_TIMEOUT,
          { decisionPath, waitedMs: configuredTimeout,
            activatedAt: journal.firstActivatedAt,
            attempts: journal.attempts.length,
            lastActivation: finalAttempt,
            atMostOnce: true,
            hint: 'không thấy review.submit_decision trong thời hạn - activation đã gửi (không gửi lại); kiểm tra GPT có gọi được MCP (extension/connector) và MCP server có REVIEW_MCP_REQUEST_DIR trỏ đúng dir' });
      }
      await sleepImpl(pollMs);
    }
  };
}

function tryReadSession(sessionPath) {
  try { return JSON.parse(fs.readFileSync(sessionPath, 'utf8')); } catch { return null; }
}

// Packet resolution: query trực tiếp theo đúng scheme của packetPathFor
// (exact-head match, case-insensitive slug) + đọc bytes. Identity check với
// session nằm ngoài. KHÔNG import adapters.mjs (sẽ tạo cycle import).
function resolvePacket({ packetDir, session }) {
  const repo = typeof session.repo === 'string' ? session.repo : '';
  const issue = Number(session.issueNumber);
  if (!repo || !Number.isInteger(issue) || issue <= 0) {
    return fail(MCP_REVIEW_CODES.PACKET_IDENTITY, 'session.repo/issueNumber không hợp lệ');
  }
  const prefix = `${repo.replace(/\//g, '_').replace(/[^A-Za-z0-9._-]+/g, '_')}_Issue-${issue}_PR-`.toLowerCase();
  const currentHead = typeof session.headSha === 'string' ? session.headSha.toLowerCase() : null;
  let entries;
  try { entries = fs.readdirSync(packetDir, { withFileTypes: true }); } catch {
    return fail(MCP_REVIEW_CODES.PACKET_NOT_FOUND, { packetDir, note: 'chưa có dir packet (projectReviewReadyPacket chưa chạy?)' });
  }
  const matches = entries
    .filter((e) => e.isFile()
      && e.name.toLowerCase().startsWith(prefix)
      && e.name.toLowerCase().endsWith('_review-ready.md'))
    .map((e) => path.join(packetDir, e.name))
    .sort()
    .reverse();
  if (!matches.length) {
    return fail(MCP_REVIEW_CODES.PACKET_NOT_FOUND, { packetDir, prefix, head: currentHead });
  }
  const exact = currentHead
    ? matches.filter((p) => path.basename(p).toLowerCase().includes(`_${currentHead.slice(0, 7)}_`))
    : [];
  // Exact-head THẮT CHẶN (khác adapter fallback): không đọc packet cũ (stale).
  if (!exact.length) {
    return fail(MCP_REVIEW_CODES.PACKET_STALE,
      { packetDir, sessionHeadSha: currentHead, candidates: matches.map((p) => path.basename(p)) });
  }
  const packetPath = exact[0];
  let content = null;
  try { content = fs.readFileSync(packetPath, 'utf8'); } catch (e) {
    return fail(MCP_REVIEW_CODES.PACKET_NOT_FOUND, { packetPath, error: String((e && e.message) || e) });
  }
  return { ok: true, packetPath, content };
}
