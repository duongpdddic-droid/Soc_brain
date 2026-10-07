// session-hydration.mjs — Session Auto-Hydration từ GitHub cho Control Loop
// (FAIL-CLOSED). Khi file session local bị mất (state dir bị dọn / máy mới)
// nhưng PR vẫn còn trên GitHub, runner có thể khôi phục METADATA binding của
// task — KHÔNG BAO GIỜ tự suy diễn hay "tẩy" identity cho PR lạ.
//
// BẤT BIẾN:
//   1. Strict identity verification (No-Laundering): chỉ hydrate khi PR body
//      chứa marker đúng `<!-- soc-brain:identity=<identityHash(repo,issue)> -->`.
//      expectedId được tính tất định từ identityHash({ repo, issueNumber });
//      thiếu marker hoặc marker mang hash khác -> HYDRATION_IDENTITY_MISMATCH,
//      không ghi bất cứ thứ gì.
//   2. Metadata & head binding: headSha <- headRefOid, baseSha <- baseRefOid,
//      branch <- headRefName, prNumber <- số PR thực tế, issueNumber trích từ
//      body PR (mẫu `Closes #<issue>` / liên kết issue chính thức) hoặc từ
//      --issue của caller (cùng xuất hiện thì bắt buộc khớp).
//   3. Atomic & durable write: seed 8 field chuẩn schemaVersion '1' + goal
//      (từ PR title/body, null khi PR không có mục tiêu nào) ghi ra
//      $stateDir/sessions/<identityHash>.json (tmp + link = no-clobber), rồi
//      READ-BACK VERIFY (tồn tại + parse được + khớp từng field) trước khi
//      trả ok. Slot đã có session -> HYDRATION_SESSION_EXISTS (không đè).
//   4. Windows & process safety (LOOP-01 Finding #3): mọi spawnSync('gh',...)
//      kẹp timeout 10000 + windowsHide + killSignal SIGTERM; r.error bắt và
//      map sang mã typed (HYDRATION_GH_TIMEOUT / HYDRATION_GH_FAILED), không
//      bao giờ throw hay treo tiến trình Node.
//
// Seed là METADATA phục hồi, KHÔNG phải session canonical (thiếu lease/
// worktree/controlPlane). packages/control-loop/session-provisioning.mjs nâng
// seed lên session canonical qua đúng primitive taskStart khi runner admission.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { identityHash } from '../workspace/workspace.mjs';
import { sessionPathFor } from '../runtime-sandbox/runtime-sandbox.mjs';

export const HYDRATION_SESSION_SCHEMA_VERSION = '1';
// 8 field METADATA binding là bắt buộc (hợp đồng cũ, không đổi). `goal` là
// field tùy chọn: seed cũ 8 field vẫn là seed hợp lệ (backward compatible),
// seed mới thêm goal (string|null) để runner tự khôi phục instruction khi
// máy mới không còn route claim local (INSTRUCTION_SOURCE_MISSING fix).
export const HYDRATION_SEED_FIELDS = Object.freeze([
  'schemaVersion', 'identityHash', 'repo', 'issueNumber', 'prNumber', 'headSha', 'baseSha', 'branch',
]);
export const HYDRATION_OPTIONAL_SEED_FIELDS = Object.freeze(['goal']);
export const GH_SPAWN_TIMEOUT_MS = 10000;
export const GH_PR_LIST_LIMIT = 200;
// Ngân sách instruction của runner (resolveRunnerInstruction ký hợp đồng
// 8192 byte cho instruction base): goal trích từ PR dài hơn ngân sách này
// không bao giờ được tự bịa thành instruction — trả null, gate fail-closed.
export const HYDRATION_GOAL_MAX_BYTES = 8192;

const SHA40_RE = /^[0-9a-f]{40}$/i;
// gh pr view/list --json field set: đủ để dựng seed + trích issue linkage
// + trích goal (title) từ PR metadata.
const PR_JSON_FIELDS = 'state,number,title,body,headRefOid,baseRefOid,headRefName';

function fail(code, detail) { return { ok: false, code, detail: detail ?? null }; }
function ok(value) { return { ok: true, value }; }

// ---- identity marker --------------------------------------------------------
export function identityMarkerFor(identityHashId) {
  return `<!-- soc-brain:identity=${identityHashId} -->`;
}

// Issue linkage trong body PR: (a) mẫu Closes/Fixes/Resolves #<n>,
// (b) liên kết issue chính thức https://github.com/<repo>/issues/<n>.
// Trả về TẤT CẢ issue được liên kết (không trùng, closes-links đứng trước):
// một PR có thể đóng NHIỀU issue — so sánh "issue đầu tiên" sẽ hiểu nhầm là
// xung đột khi issue của chúng ta không đứng đầu danh sách.
export function extractIssueNumbersFromBody({ body, repo } = {}) {
  const text = typeof body === 'string' ? body : '';
  if (!text) return [];
  const out = [];
  const push = (n) => {
    const v = Number.parseInt(n, 10);
    if (Number.isInteger(v) && v > 0 && !out.includes(v)) out.push(v);
  };
  const relRe = /(?:closes|fixes|resolves|closed|fixed|resolved)\s*:?\s*#(\d+)\b/gi;
  for (const m of text.matchAll(relRe)) push(m[1]);
  if (typeof repo === 'string' && repo.trim()) {
    const esc = repo.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const urlRe = new RegExp(`github\\.com/${esc}/issues/(\\d+)\\b`, 'gi');
    for (const m of text.matchAll(urlRe)) push(m[1]);
  }
  return out;
}

// Issue đầu tiên được liên kết (hợp đồng cũ, giữ nguyên hành vi).
export function extractIssueNumberFromBody(args = {}) {
  const list = extractIssueNumbersFromBody(args);
  return list.length ? list[0] : null;
}

// ---- goal extraction (nguồn 4 của instruction gate) --------------------------
// PR metadata là BẰNG CHỨNG hydrate đã qua strict identity marker, nên title/
// body của đúng PR đó được dùng làm goal khả dụng khi runner không có
// --goal / --instruction-file / route claim (máy mới, stateDir bị dọn).
// Bộ luật (không bao giờ tự bịa văn bản):
//   1. ƯU TIÊN pr.title: sanitize (bước 3) rồi cắt gọn an toàn về ngân sách
//      byte — title có ý nghĩa KHÔNG BAO GIỜ bị trả null chỉ vì dài (tránh
//      false negative INSTRUCTION_SOURCE_MISSING).
//   2. thiếu title hợp lệ -> dòng tóm tắt ĐẦU TIÊN từ body qua sanitize;
//      dòng sanitize rỗng hoặc VƯỢT NGÂN SÁCH 8192 bị BỎ QUA (continue quét
//      tiếp — một dòng rác không được phép giết chết cả chu trình trích xuất);
//   3. sanitize (untrusted input chống prompt-injection / phá cấu trúc):
//      strip escape sequence ANSI (CSI/OSC/simple) + ký tự điều khiển C0/DEL,
//      CRLF/newline -> khoảng trắng (goal LUÔN một dòng — không thể giả mạo
//      cấu trúc .soc/task-contract.md), collapse khoảng trắng, gọt tiền tố
//      Markdown chồng nhau (blockquote `>`, list `-/*/`, checkbox
//      `[ ]/[x]`) và backticks bao ngoài;
//   4. dòng CHỈ chứa issue linkage (Closes/Fixes/... + #N) bị loại trên cả
//      dạng gốc lẫn dạng sau sanitize (strip keyword + #N còn rỗng mới là
//      linkage thuần — một dòng goal "Fixed #12 trong parser" không bị bỏ nhầm);
//   5. không có gì khả dụng sau sanitize -> null (fail-closed: gate vẫn báo
//      INSTRUCTION_SOURCE_MISSING thay vì bịa goal).
const GOAL_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const GOAL_ANSI_CSI_RE = /\u001B\[[0-9;:?]*[ -\/]*[@-~]/g;
const GOAL_ANSI_OSC_RE = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g;
const GOAL_ANSI_SIMPLE_RE = /\u001B[@-Z\\-_]/g;

function sanitizeGoalText(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw;
  // Escape sequences TRƯỚC khi bỏ ký tự điều khiển (ESC nằm trong lớp control,
  // nếu bỏ trước sẽ để lại residue "[31m").
  s = s.replace(GOAL_ANSI_OSC_RE, '');
  s = s.replace(GOAL_ANSI_CSI_RE, '');
  s = s.replace(GOAL_ANSI_SIMPLE_RE, '');
  s = s.replace(GOAL_CONTROL_RE, '');
  s = s.replace(/[\r\n]+/g, ' ');
  s = s.replace(/[ \t]+/g, ' ');
  // Tiền tố Markdown có thể xếp chồng ("- [ ] > Refactor X") -> lặp có chặn
  // (bounded) cho tới khi ổn định.
  for (let i = 0; i < 6; i++) {
    const before = s;
    s = s.replace(/^\s*>\s*/, '').replace(/^\s*[-*+]\s*(?:\[[ xX]\]\s*)?/, '').trim();
    if (s === before) break;
  }
  // Backticks bao quanh toàn bộ chuỗi -> gỡ một lớp.
  if (s.length >= 2 && s.startsWith('`') && s.endsWith('`')) s = s.slice(1, -1).trim();
  return s.trim();
}

// Cắt theo ranh giới ký tự UTF-8 an toàn trong ngân sách byte (không bao giờ
// cắt giữa một code point), rồi trim.
function truncateToBudget(s, maxBytes = HYDRATION_GOAL_MAX_BYTES) {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  let out = '';
  let bytes = 0;
  for (const ch of s) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (bytes + b > maxBytes) break;
    out += ch;
    bytes += b;
  }
  return out.trim();
}

// Dòng CHỈ chứa issue linkage (Closes/Fixes/... + #N, có thể nhiều ref).
function isPureLinkageLine(line) {
  if (typeof line !== 'string' || !line.trim()) return false;
  const bare = line
    .replace(/(?:closes|fixes|resolves|closed|fixed|resolved)\s*:?\s*/gi, '')
    .replace(/#\d+/g, '')
    .replace(/[\s,.;:()]+/g, '');
  return bare === '';
}

export function extractGoalFromPr({ title, body } = {}) {
  const t = sanitizeGoalText(title);
  if (t) return truncateToBudget(t);
  const text = typeof body === 'string' ? body : '';
  if (!text.trim()) return null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('<!--')) continue; // identity marker / html comment
    if (/^#{1,6}\s/.test(line)) continue; // markdown heading (không phải goal)
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line)) continue; // separator markup
    if (/^`{3,}/.test(line)) continue; // code fence ``` (markdown artifact, không phải goal)
    if (isPureLinkageLine(line)) continue; // linkage thuần (dạng gốc)
    const g = sanitizeGoalText(line);
    if (!g) continue; // rác sau sanitize -> quét tiếp
    if (/^`+$/.test(g)) continue; // chỉ toàn backtick -> không bao giờ là goal
    if (isPureLinkageLine(g)) continue; // linkage thuần sau sanitize ("- [ ] Closes #77")
    // FD-NEW-1: dòng vượt ngân sách -> bỏ qua, quét tiếp (không return null)
    if (Buffer.byteLength(g, 'utf8') > HYDRATION_GOAL_MAX_BYTES) continue;
    return g;
  }
  return null;
}

// Seed = đúng 8 field hydration (bắt buộc) + goal tùy chọn, identity khớp,
// không có trường canonical. Record canonical (state/lease/controlPlane...)
// hoặc record legacy thiếu trường đều KHÔNG phải seed — upgrade không bao
// giờ "ăn" nhầm chúng. Field lạ (không thuộc 8 bắt buộc + goal) cũng loại.
export function isHydrationSeedRecord({ session, identityHash: expectedId } = {}) {
  if (!session || typeof session !== 'object' || Array.isArray(session)) return false;
  if (session.schemaVersion !== HYDRATION_SESSION_SCHEMA_VERSION) return false;
  if (!expectedId || session.identityHash !== expectedId) return false;
  for (const k of HYDRATION_SEED_FIELDS) {
    if (!Object.hasOwn(session, k)) return false;
  }
  const known = new Set([...HYDRATION_SEED_FIELDS, ...HYDRATION_OPTIONAL_SEED_FIELDS]);
  for (const k of Object.keys(session)) {
    if (!known.has(k)) return false;
  }
  if (Object.hasOwn(session, 'goal')) {
    // goal vắng mặt (seed cũ) hợp lệ; nếu có mặt thì phải null hoặc string
    // không rỗng — string rỗng/không phải string không phải goal.
    if (session.goal !== null && typeof session.goal !== 'string') return false;
    if (typeof session.goal === 'string' && !session.goal.trim()) return false;
  }
  if (typeof session.repo !== 'string' || !session.repo.trim()) return false;
  if (!Number.isInteger(session.issueNumber) || session.issueNumber <= 0) return false;
  if (!Number.isInteger(session.prNumber) || session.prNumber <= 0) return false;
  if (typeof session.headSha !== 'string' || !SHA40_RE.test(session.headSha)) return false;
  if (typeof session.baseSha !== 'string' || !SHA40_RE.test(session.baseSha)) return false;
  if (typeof session.branch !== 'string' || !session.branch.trim()) return false;
  return true;
}

// ---- bounded gh transport (LOOP-01 Finding #3) ------------------------------
// `gh` là test seam (nhận args -> {code,stdout,stderr} | {unknown,error});
// khi không inject, spawnSync luôn bị kẹp timeout 10s + windowsHide + SIGTERM.
function makeGhCall({ gh = null, spawnImpl = null } = {}) {
  if (typeof gh === 'function') return gh;
  const spawn = typeof spawnImpl === 'function' ? spawnImpl : spawnSync;
  return function callGh(args) {
    try {
      const r = spawn('gh', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        timeout: GH_SPAWN_TIMEOUT_MS,
        killSignal: 'SIGTERM',
        maxBuffer: 32 * 1024 * 1024,
      });
      // Timeout/kill/network stall surface ở r.error — map typed, không throw.
      if (r && r.error) {
        return { unknown: true, error: String(r.error.code || r.error.message || r.error) };
      }
      return { code: r && typeof r.status === 'number' ? r.status : null, stdout: String((r && r.stdout) || ''), stderr: String((r && r.stderr) || '') };
    } catch (e) {
      return { unknown: true, error: String((e && (e.code || e.message)) || e) };
    }
  };
}

function interpretGh(res, stage) {
  if (res && res.unknown === true) {
    const err = String(res.error || '');
    const timedOut = /ETIMEDOUT|TIMEDOUT|TIMEOUT|KILLED|SIGTERM/i.test(err);
    return fail(timedOut ? 'HYDRATION_GH_TIMEOUT' : 'HYDRATION_GH_FAILED', err.slice(0, 300));
  }
  if (!res || typeof res.code !== 'number' || res.code !== 0) {
    const code = stage === 'list' ? 'HYDRATION_PR_LIST_FAILED' : 'HYDRATION_PR_VIEW_FAILED';
    return fail(code, String((res && res.stderr) || 'gh exited non-zero').slice(0, 300));
  }
  return ok(String(res.stdout || ''));
}

function parseGhJson(stdout, stage) {
  try {
    return ok(JSON.parse(stdout));
  } catch (e) {
    const code = stage === 'list' ? 'HYDRATION_PR_LIST_PARSE_FAILED' : 'HYDRATION_PR_VIEW_PARSE_FAILED';
    return fail(code, String((e && e.message) || e).slice(0, 200));
  }
}

function viewArgs({ repo, prNumber }) {
  return ['pr', 'view', String(prNumber), '--repo', repo, '--json', PR_JSON_FIELDS];
}

function listArgs({ repo }) {
  return ['pr', 'list', '--repo', repo, '--state', 'all', '--limit', String(GH_PR_LIST_LIMIT), '--json', PR_JSON_FIELDS];
}

// ---- slot pre-check (không tốn mạng khi slot đã bị chiếm) --------------------
function seedSlotPath({ repo, issueNumber, stateDir }) {
  const h = identityHash({ repo, issueNumber });
  if (!h) return null;
  try {
    return sessionPathFor({ stateDir, identityHash: h });
  } catch {
    return null;
  }
}

// ---- fetch ------------------------------------------------------------------
function fetchPrByNumber({ repo, prNumber, callGh }) {
  const res = interpretGh(callGh(viewArgs({ repo, prNumber })), 'view');
  if (!res.ok) return res;
  const parsed = parseGhJson(res.value, 'view');
  if (!parsed.ok) return parsed;
  const pr = parsed.value;
  if (!pr || typeof pr !== 'object' || Array.isArray(pr)) {
    return fail('HYDRATION_PR_VIEW_PARSE_FAILED', 'gh pr view did not return an object');
  }
  if (Number(pr.number) !== Number(prNumber)) {
    return fail('HYDRATION_PR_NUMBER_MISMATCH', `requested PR #${prNumber}, gh returned #${pr && pr.number}`);
  }
  return ok(pr);
}

// Issue-only: tìm PR mang marker identity này; fallback duy nhất được phép
// là "không có bằng chứng PR" (PR_NOT_FOUND) — PR đóng issue nhưng thiếu
// marker vẫn được đưa vào verify để fail-closed đúng mẫu.
function findPrForIssue({ repo, issueNumber, stateDir, callGh }) {
  const expected = identityHash({ repo, issueNumber });
  if (!expected) return fail('ARGS_INVALID', 'cannot derive identity for issue lookup');
  const slot = seedSlotPath({ repo, issueNumber, stateDir });
  if (slot && fs.existsSync(slot)) return fail('HYDRATION_SESSION_EXISTS', slot);

  const res = interpretGh(callGh(listArgs({ repo })), 'list');
  if (!res.ok) return res;
  const parsed = parseGhJson(res.value, 'list');
  if (!parsed.ok) return parsed;
  if (!Array.isArray(parsed.value)) return fail('HYDRATION_PR_LIST_PARSE_FAILED', 'gh pr list did not return an array');
  const list = parsed.value.filter((p) => p && typeof p === 'object' && Number.isInteger(Number(p.number)));

  const markerStr = identityMarkerFor(expected);
  const marked = list.filter((p) => String(p.body || '').includes(markerStr));
  if (marked.length === 1) return ok(marked[0]);
  if (marked.length > 1) {
    // Một attempt cũ đã đóng + attempt mở cùng marker không phải mơ hồ:
    // đúng một PR OPEN mang marker thì đó là PR hiện hành.
    const open = marked.filter((p) => String(p.state || '').toUpperCase() === 'OPEN');
    if (open.length === 1) return ok(open[0]);
    return fail('HYDRATION_PR_AMBIGUOUS', `${marked.length} PRs carry identity marker ${expected}`);
  }
  const linked = list.filter((p) => extractIssueNumbersFromBody({ body: p.body, repo }).includes(Number(issueNumber)));
  if (linked.length === 0) {
    return fail('HYDRATION_PR_NOT_FOUND', `no GitHub PR evidence for ${repo}#${issueNumber}`);
  }
  if (linked.length > 1) {
    return fail('HYDRATION_PR_AMBIGUOUS', `${linked.length} PRs reference #${issueNumber} and none carries the identity marker — pass --pr explicitly`);
  }
  // Đúng một PR closes issue này nhưng KHÔNG mang marker identity nào:
  // đây chỉ là linkage lỏng (PR đời trước / PR của bên khác) — KHÔNG phải
  // bằng chứng hydrate được cho identity này (và cũng không phải xung đột
  // identity vì không có claim nào cả) -> coi như không có evidence (absence),
  // giữ nguyên hợp đồng SESSION_NOT_FOUND cũ. PR có claim identity KHÁC thì
  // mới là xung đột thật sự -> fail-closed qua verify bên dưới.
  const single = linked[0];
  const singleBody = String(single.body || '');
  if (!singleBody.includes('soc-brain:identity=')) {
    return fail('HYDRATION_PR_NOT_FOUND',
      `PR #${single.number} links ${repo}#${issueNumber} but carries no identity marker — not hydration evidence`);
  }
  return ok(single); // verify marker phía dưới fail-closed nếu marker sai identity
}

// Chọn issue "chủ đề" từ danh sách linkage khi KHÔNG có --issue:
//   - đúng 1 issue mang marker identity của chính nó -> đó là chủ đề;
//   - nhiều issue cùng mang marker -> PR claim nhiều identity -> xung đột;
//   - không issue nào mang marker -> link đầu tiên (verify marker strict
//     phía sau sẽ fail-closed nếu marker không khớp).
export function pickIssueFromLinks({ links, body, repo } = {}) {
  if (!Array.isArray(links) || links.length === 0) {
    return fail('HYDRATION_ISSUE_UNRESOLVED', 'PR body carries no Closes/issue linkage and no --issue was supplied');
  }
  if (links.length === 1) return ok(links[0]);
  const marked = links.filter((n) => typeof body === 'string' && body.includes(identityMarkerFor(identityHash({ repo, issueNumber: n }))));
  if (marked.length > 1) {
    return fail('HYDRATION_ISSUE_MISMATCH', `PR body carries identity markers for #${marked.join(', #')} — conflicting identity claims`);
  }
  return ok(marked.length === 1 ? marked[0] : links[0]);
}

// ---- verify + build seed record ---------------------------------------------
function buildSeedRecord({ repo, pr, callerIssueNumber = null }) {
  if (!pr || typeof pr !== 'object' || Array.isArray(pr)) {
    return fail('HYDRATION_PR_VIEW_PARSE_FAILED', 'PR payload is not an object');
  }
  const prNumber = Number(pr.number);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return fail('HYDRATION_PR_VIEW_PARSE_FAILED', 'PR payload carries no valid number');
  }
  const body = typeof pr.body === 'string' ? pr.body : '';
  const links = extractIssueNumbersFromBody({ body, repo });
  const callerIssue = Number.isInteger(callerIssueNumber) && callerIssueNumber > 0 ? Number(callerIssueNumber) : null;
  let issueNumber = null;
  if (callerIssue !== null) {
    // Cross-check là KIỂM TRA THÀNH VIÊN trên TẤT CẢ linkage: body liên kết
    // issue KHÁC issue của caller -> mismatch. PR đóng NHIỀU issue không bị
    // hiểu nhầm là sai chỉ vì issue của chúng ta không đứng đầu danh sách.
    if (links.length && !links.includes(callerIssue)) {
      return fail('HYDRATION_ISSUE_MISMATCH', `PR body links #${links.join(', #')}, caller says #${callerIssue}`);
    }
    issueNumber = callerIssue;
  } else if (links.length === 0) {
    return fail('HYDRATION_ISSUE_UNRESOLVED', 'PR body carries no Closes/issue linkage and no --issue was supplied');
  } else {
    // Nhiều linkage, không có --issue: cùng một bộ luật với resolver CLI
    // (--pr không --issue) — dùng pickIssueFromLinks để hai đường không bao
    // giờ chọn ra hai issue khác nhau cho cùng một PR.
    const picked = pickIssueFromLinks({ links, body, repo });
    if (!picked.ok) return picked;
    issueNumber = picked.value;
  }
  const expectedId = identityHash({ repo, issueNumber });
  if (!expectedId) {
    return fail('HYDRATION_ISSUE_UNRESOLVED', `identityHash could not be derived for ${repo}#${issueNumber}`);
  }
  // ---- Strict Identity Verification (No-Laundering) -------------------------
  const markerStr = identityMarkerFor(expectedId);
  if (!body.includes(markerStr)) {
    return fail('HYDRATION_IDENTITY_MISMATCH', `PR body lacks the canonical identity marker ${markerStr}`);
  }
  const headSha = typeof pr.headRefOid === 'string' ? pr.headRefOid.trim() : '';
  const baseSha = typeof pr.baseRefOid === 'string' ? pr.baseRefOid.trim() : '';
  const branch = typeof pr.headRefName === 'string' ? pr.headRefName.trim() : '';
  if (!SHA40_RE.test(headSha) || !SHA40_RE.test(baseSha) || !branch) {
    return fail('HYDRATION_INVALID_PR_METADATA', `headRefOid/baseRefOid/headRefName invalid: headRefOid=${pr.headRefOid} baseRefOid=${pr.baseRefOid} headRefName=${pr.headRefName}`);
  }
  // Goal khả dụng từ PR metadata (title trước, tóm tắt body sau) — null khi
  // không có gì để trích (không bao giờ tự bịa). Seed mang theo để upgrade
  // truyền vào taskStart và runner dùng làm nguồn 4 của instruction gate.
  const goal = extractGoalFromPr({ title: pr.title, body });
  return ok({
    record: {
      schemaVersion: HYDRATION_SESSION_SCHEMA_VERSION,
      identityHash: expectedId,
      repo,
      issueNumber,
      prNumber,
      headSha,
      baseSha,
      branch,
      goal,
    },
  });
}

// ---- atomic write + read-back verify ----------------------------------------
function writeSeedSession({ stateDir, record }) {
  let sp = null;
  try {
    sp = sessionPathFor({ stateDir, identityHash: record.identityHash });
  } catch (e) {
    return fail('ARGS_INVALID', `stateDir invalid: ${String((e && e.message) || e)}`);
  }
  if (fs.existsSync(sp)) return fail('HYDRATION_SESSION_EXISTS', sp);
  const dir = path.dirname(sp);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    return fail('HYDRATION_WRITE_FAILED', String((e && e.message) || e));
  }
  const tmp = path.join(dir, `.${path.basename(sp)}.${process.pid.toString(16)}${Date.now().toString(16)}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
    return fail('HYDRATION_WRITE_FAILED', String((e && e.message) || e));
  }
  try {
    fs.linkSync(tmp, sp); // atomic no-clobber: EEXIST khi slot đã bị chiếm
  } catch (e) {
    if (e && e.code === 'EEXIST') return fail('HYDRATION_SESSION_EXISTS', sp);
    return fail('HYDRATION_WRITE_FAILED', String((e && e.message) || e));
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
  }

  // ---- READ-BACK VERIFY: file tồn tại, parse được, khớp từng field --------
  let raw = null;
  try {
    raw = fs.readFileSync(sp, 'utf8');
  } catch (e) {
    return fail('HYDRATION_READBACK_FAILED', `session unreadable after write: ${String((e && e.message) || e)}`);
  }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return fail('HYDRATION_READBACK_FAILED', `session not valid JSON after write: ${String((e && e.message) || e)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail('HYDRATION_READBACK_FAILED', 'session is not an object after write');
  }
  for (const k of HYDRATION_SEED_FIELDS) {
    if (parsed[k] !== record[k]) {
      return fail('HYDRATION_READBACK_FAILED', `field ${k} mismatch after write: wrote ${JSON.stringify(record[k])}, read ${JSON.stringify(parsed[k])}`);
    }
  }
  // goal là optional field: chỉ verify khi record có ghi (seed cũ không có).
  if (Object.hasOwn(record, 'goal') && parsed.goal !== record.goal) {
    return fail('HYDRATION_READBACK_FAILED', `field goal mismatch after write: wrote ${JSON.stringify(record.goal)}, read ${JSON.stringify(parsed.goal)}`);
  }
  return ok({
    sessionPath: sp,
    session: parsed,
    identityHash: record.identityHash,
    repo: record.repo,
    issueNumber: record.issueNumber,
    prNumber: record.prNumber,
    headSha: record.headSha,
    baseSha: record.baseSha,
    branch: record.branch,
    goal: typeof record.goal === 'string' && record.goal.trim() ? record.goal : null,
  });
}

// ---- hydrateSessionFromGitHub ------------------------------------------------
/**
 * Khôi phục seed session từ GitHub PR (fail-closed).
 *
 * @param {object}   args
 * @param {string}   args.repo         owner/name (bắt buộc)
 * @param {number}  [args.issueNumber] issue đã biết (--issue); khi cả body PR
 *                                      và caller cùng nêu issue thì phải khớp
 * @param {number}  [args.prNumber]    PR tường minh (--pr) -> gh pr view;
 *                                      chỉ có issue -> gh pr list (tìm theo marker)
 * @param {string}   args.stateDir     state dir chứa $stateDir/sessions/
 * @param {function}[args.gh]          seam gh(args) -> {code,stdout,stderr}|{unknown,error}
 * @param {function}[args.spawnImpl]   seam spawnSync (khi không inject gh)
 * @returns {{ok:true, value:object}|{ok:false, code:string, detail:*}}
 */
export function hydrateSessionFromGitHub({
  repo, issueNumber = null, prNumber = null, stateDir, gh = null, spawnImpl = null,
} = {}) {
  if (typeof repo !== 'string' || !repo.trim()) return fail('ARGS_INVALID', 'repo is required');
  if (typeof stateDir !== 'string' || !stateDir) return fail('ARGS_INVALID', 'stateDir is required');
  const wantPr = Number.isInteger(prNumber) && prNumber > 0 ? Number(prNumber) : null;
  const callerIssue = Number.isInteger(issueNumber) && issueNumber > 0 ? Number(issueNumber) : null;
  if (wantPr === null && callerIssue === null) {
    return fail('ARGS_INVALID', 'prNumber or issueNumber is required');
  }

  // Slot đã có session -> từ chối TRƯỚC mọi lệnh gọi mạng (không bao giờ đè).
  if (callerIssue !== null) {
    const slot = seedSlotPath({ repo, issueNumber: callerIssue, stateDir });
    if (slot && fs.existsSync(slot)) return fail('HYDRATION_SESSION_EXISTS', slot);
  }

  const callGh = makeGhCall({ gh, spawnImpl });
  let pr = null;
  if (wantPr !== null) {
    const f = fetchPrByNumber({ repo, prNumber: wantPr, callGh });
    if (!f.ok) return f;
    pr = f.value;
  } else {
    const f = findPrForIssue({ repo, issueNumber: callerIssue, stateDir, callGh });
    if (!f.ok) return f;
    pr = f.value;
  }

  const b = buildSeedRecord({ repo, pr, callerIssueNumber: callerIssue });
  if (!b.ok) return b;
  return writeSeedSession({ stateDir, record: b.value.record });
}

// ---- resolveIssueNumberFromPullRequest (read-only, cho --pr mà không --issue) -
// Chỉ đọc PR để rút issueNumber (chưa ghi gì): seed write luôn diễn ra SAU
// khi phiên bản đã được Session Admission fence bảo vệ.
export function resolveIssueNumberFromPullRequest({
  repo, prNumber, gh = null, spawnImpl = null,
} = {}) {
  if (typeof repo !== 'string' || !repo.trim()) return fail('ARGS_INVALID', 'repo is required');
  const wantPr = Number(prNumber);
  if (!Number.isInteger(wantPr) || wantPr <= 0) return fail('ARGS_INVALID', 'prNumber must be a positive integer');
  const callGh = makeGhCall({ gh, spawnImpl });
  const f = fetchPrByNumber({ repo, prNumber: wantPr, callGh });
  if (!f.ok) return f;
  const body = typeof f.value.body === 'string' ? f.value.body : '';
  // Dùng CÙNG bộ luật multi-link với buildSeedRecord: PR đóng nhiều issue
  // resolve ra đúng issue mang marker, không phải link đầu tiên.
  const links = extractIssueNumbersFromBody({ body, repo });
  const picked = pickIssueFromLinks({ links, body, repo });
  if (!picked.ok) return picked;
  return ok({ prNumber: wantPr, issueNumber: picked.value });
}

// end of session-hydration.mjs
