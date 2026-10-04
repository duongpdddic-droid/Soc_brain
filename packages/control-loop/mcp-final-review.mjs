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
// Chống verdict cũ / trùng:
//   - Journal activation ghi TRƯỚC khi gửi prompt
//     (<stateDir>/mcp-review/<key>.json): firstActivatedAt, attempts, consumed.
//   - Cũ: record.persistedAt < journal.firstActivatedAt -> REVIEW_SUBMIT_MCP_STALE.
//     Quyết định tồn tại mà CHƯA có journal (chưa từng kích hoạt) -> STALE.
//   - Trùng: server đã no-clobber (DUPLICATE_NOOP/CONFLICT); consumer thêm
//     payloadDigest đã consume -> trùng payload == replay idempotent (FSM resume
//     cần), payload KHÁC -> REVIEW_SUBMIT_MCP_DUPLICATE.
//   - Activation tối đa MCP_MAX_ACTIVATIONS (default 3) mỗi key -> vượt ->
//     REVIEW_REQUEST_MCP_ACTIVATION_EXHAUSTED (không spam Web2API).
//   - Quyết định đã có từ lượt trước -> consume NGAY, KHÔNG kích hoạt lại
//     (một activation cho mỗi lượt review).

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
  ACTIVATION_EXHAUSTED: 'REVIEW_REQUEST_MCP_ACTIVATION_EXHAUSTED',
  ACTIVATION_FAILED: 'MCP_ACTIVATION_FAILED',
  VERDICT_TIMEOUT: 'MCP_VERDICT_TIMEOUT',
  BINDING_MISMATCH: 'REVIEW_SUBMIT_MCP_BINDING_MISMATCH',
  DIGEST_MISMATCH: 'REVIEW_SUBMIT_MCP_DIGEST_MISMATCH',
  STALE: 'REVIEW_SUBMIT_MCP_STALE',
  DUPLICATE: 'REVIEW_SUBMIT_MCP_DUPLICATE',
  VERDICT_INVALID: 'REVIEW_SUBMIT_MCP_VERDICT_INVALID',
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

function readJournal(journalPath) {
  try {
    const raw = fs.readFileSync(journalPath, 'utf8');
    const j = JSON.parse(raw);
    if (j && typeof j === 'object' && typeof j.firstActivatedAt === 'string') return j;
    return null;
  } catch { return null; }
}

function writeJournal(journalPath, journal) {
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  // Single-writer (execution-broker one-owner) -> ghi trực tiếp là đủ;
  // journal là bằng chứng kích hoạt, không phải khóa mutual-exclusion.
  fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2), 'utf8');
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

    // ---- 3. Journal: tạo TRƯỚC activation (crash-safe baseline cho stale check).
    let journal = readJournal(journalPath);
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
    } else if (journal.requestDigest !== meta.requestDigest
        || journal.contentDigest !== contentDigest) {
      // Packet đã re-project (report mới, digest khác) -> cùng key nhưng digest
      // khác -> reset journal (hệ quả của việc cùng identity+shortHead mới).
      journal = {
        ...journal,
        contentDigest,
        firstActivatedAt: new Date(nowImpl()).toISOString(),
        attempts: [],
        consumedPayloadDigest: null,
      };
      try { writeJournal(journalPath, journal); } catch (e) {
        return fail(MCP_REVIEW_CODES.JOURNAL_WRITE_FAILED,
          { journalPath, error: String((e && e.message) || e) });
      }
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

    // ---- 5. Chống gửi activation TRÙNG khi resume/retry: nếu lần kích hoạt
    // trước (postCount>0 - prompt đã POST đến Web2API) vẫn nằm trong cửa sổ
    // chờ verdict, tiếp tục poll lượt activation ĐÓ thay vì gửi prompt mới.
    // Một activation cho mỗi lượt review; retry chỉ khi cửa sổ đã hết hạn.
    const lastAttempt = journal.attempts.length > 0
      ? journal.attempts[journal.attempts.length - 1] : null;
    const lastAtMs = lastAttempt ? Date.parse(lastAttempt.at) : NaN;
    const stillAwaiting = Boolean(lastAttempt)
      && Number(lastAttempt.postCount) > 0
      && Number.isFinite(lastAtMs)
      && (nowImpl() - lastAtMs) < configuredTimeout;

    if (stillAwaiting) {
      log(`mcp resume trong cửa sổ activation #${journal.attempts.length} -> poll tiếp, KHÔNG gửi trùng prompt`);
      const deadlineResume = lastAtMs + configuredTimeout;
      for (;;) {
        if (fs.existsSync(decisionPath)) return consumeExisting();
        if (nowImpl() >= deadlineResume) {
          return fail(MCP_REVIEW_CODES.VERDICT_TIMEOUT,
            { decisionPath, waitedMs: configuredTimeout,
              activatedAt: journal.firstActivatedAt,
              attempts: journal.attempts.length,
              lastActivation: lastAttempt,
              hint: 'hết cửa sổ chờ sau resume mà không thấy review.submit_decision - kiểm tra GPT có gọi được MCP (extension/connector) và MCP server có REVIEW_MCP_REQUEST_DIR trỏ đúng dir' });
        }
        await sleepImpl(pollMs);
      }
    }

    // ---- 5b. Kích hoạt Web2API (tối đa MCP_MAX_ACTIVATIONS cho mỗi key).
    if (journal.attempts.length >= MCP_MAX_ACTIVATIONS) {
      return fail(MCP_REVIEW_CODES.ACTIVATION_EXHAUSTED,
        { decisionPath, attempts: journal.attempts.length, max: MCP_MAX_ACTIVATIONS,
          hint: 'không có quyết định sau nhiều lần kích hoạt - kiểm tra Web2API/extension/MCP server trước khi relaunch' });
    }
    const activationPrompt = buildMcpActivationPrompt({ meta, contentDigest });
    let activationResult;
    try {
      const transport = makeActivationTransport();
      activationResult = await transport({ prompt: activationPrompt });
    } catch (e) {
      activationResult = { ok: false, code: 'MCP_ACTIVATION_THROW', error: String((e && e.message) || e), transportMeta: { postCount: 0 } };
    }
    const postCount = activationResult && activationResult.transportMeta
      ? Number(activationResult.transportMeta.postCount) || 0 : 0;
    const attempt = {
      at: new Date(nowImpl()).toISOString(),
      ok: activationResult && activationResult.ok === true,
      code: activationResult && activationResult.code ? activationResult.code : null,
      conversationId: activationResult && activationResult.conversationId ? activationResult.conversationId : null,
      postCount,
      modelSlug: activationResult && activationResult.modelSlug ? activationResult.modelSlug : null,
    };
    journal = { ...journal, attempts: [...journal.attempts, attempt] };
    try { writeJournal(journalPath, journal); } catch (e) {
      return fail(MCP_REVIEW_CODES.JOURNAL_WRITE_FAILED,
        { journalPath, error: String((e && e.message) || e) });
    }
    if (!attempt.ok && postCount === 0) {
      // Prompt CHƯA đến Web2API (HTTP fail trước khi POST) -> không poll vô ích.
      return fail(MCP_REVIEW_CODES.ACTIVATION_FAILED,
        { transportCode: attempt.code, error: activationResult && activationResult.error ? activationResult.error : null,
          attempts: journal.attempts.length });
    }
    // postCount > 0: prompt đã POST (hoặc submit uncertain) -> có thể GPT đã thấy
    // -> kể cả copy/ack fail vẫn poll quyết định (ack không phải verdict).
    log(`mcp activation #${journal.attempts.length}: ok=${attempt.ok} code=${attempt.code ?? '-'} postCount=${postCount}`);

    // ---- 6. Poll quyết định (clipboard/kết quả activation KHÔNG bao giờ là verdict).
    const deadline = nowImpl() + configuredTimeout;
    for (;;) {
      if (fs.existsSync(decisionPath)) return consumeExisting();
      if (nowImpl() >= deadline) {
        return fail(MCP_REVIEW_CODES.VERDICT_TIMEOUT,
          { decisionPath, waitedMs: configuredTimeout,
            activatedAt: journal.firstActivatedAt,
            attempts: journal.attempts.length,
            lastActivation: attempt,
            hint: 'không thấy review.submit_decision trong thời hạn - kiểm tra GPT có gọi được MCP (extension/connector) và MCP server có REVIEW_MCP_REQUEST_DIR trỏ đúng dir' });
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
