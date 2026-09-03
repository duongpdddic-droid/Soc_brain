#!/usr/bin/env node
// review-mcp-http.mjs — Soc_brain: read-only localhost Review MCP for the
// ChatGPT Web reviewer transport via MCP-SuperAssistant (Phase 1 = Issue #39,
// Phase 2 = Issue #41).
//
// Transport: network mode exposes the MCP Streamable HTTP transport on a
// loopback-only server (POST /mcp). The stdio mode is the JSON-RPC 2.0 server
// reused verbatim from the Issue #34 PoC shape (so a stdio-bridging local
// proxy can spawn it). BOTH expose the SAME read-only tool surface:
//   `review.ping`        -> {ok:true, service:"soc_brain", mode:"review-readonly"}
//   `review.get_request` -> canonical review request resolved by Soc_brain
//   `review.get_evidence`-> bounded evidence belonging to that request
//
// Authority boundary (deliberate):
//   - READ-ONLY. No GitHub, no write, no command/broker/execution capability,
//     no filesystem browsing, no task/issue mutation, no review decision.
//   - The browser NEVER supplies an arbitrary path/repo/file/GitHub URL.
//     Both read tools accept ONLY the canonical identity triple
//     (repository, issue, headSha) and resolve ONE pre-gated artifact:
//     <DEFAULT_REVIEW_READY_DIR>/<repo>_Issue-<n>_PR-<n>_<shortHEAD>_review-ready.md
//     produced by `packages/review-ready` after a handoff report
//     (REVIEW HANDOFF CONTRACT v1.0.0) validated as READY_FOR_REVIEW.
//   - Loopback ONLY. The HTTP path refuses any host that is not a loopback
//     address (fail-closed); it never binds 0.0.0.0 / a LAN interface.
//   - stdio mode never listens on TCP; reads stdin, writes stdout, exits 0.
//   - No dependency beyond node:http / node:crypto / node:path / node:url
//     / node:fs (read-only on a single canonical dir) / packages/review-ready
//     (filename builder is SSOT).
//
// Modes (run directly):
//   node review-mcp-http.mjs           -> stdio JSON-RPC server (Issue #34 shape)
//   node review-mcp-http.mjs --http    -> loopback HTTP server (Streamable HTTP)
//     host: env REVIEW_MCP_HOST,  default 127.0.0.1 (must be loopback; else fail)
//     port: env REVIEW_MCP_PORT,  default 8100
//     dir:  env REVIEW_MCP_REQUEST_DIR, default ~/.soc-brain/review-ready/
//
// CORS: the loopback server answers the extension's browser fetch (OPTIONS
// preflight + permissive Access-Control-Allow-*). This is transport plumbing,
// not an authority expansion: the only exposed capability is read-only review.
//
// Tool name note (inherited from #34): `review.ping` contains a dot. MCP prose
// (2025-03-26) does not forbid it, but the stricter TS-SDK regex
// ^[a-zA-Z0-9_-]{1,64}$ does. If MCP-SuperAssistant rejects the dot name,
// rename TOOL_NAMES entries (single place) — no other changes.
// ponytail: the transport is intentionally dependency-free hand-rolled MCP;
// upgrade to @modelcontextprotocol/sdk only if a client requires a strict SDK
// negotiation feature (e.g. resource subscription), which is out of scope.

import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_REVIEW_READY_DIR,
} from '../review-ready/review-ready.mjs';
import {
  processSubmitDecision,
} from './submit-decision.mjs';

export const MCP_SERVER_VERSION = '0.3.0';
export const MCP_PROTOCOL_VERSION = '2025-03-26';
export const TOOL_NAMES = {
  ping: 'review.ping',
  getRequest: 'review.get_request',
  getEvidence: 'review.get_evidence',
  submitDecision: 'review.submit_decision',
};
// Backward-compat re-export cho tests cũ (single-tool surface).
export const TOOL_NAME = TOOL_NAMES.ping;

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8100;
// Cap evidence payload size (bytes). Trên = trả lỗi BOUNDED_PAYLOAD_EXCEEDED.
const EVIDENCE_MAX_BYTES = 256 * 1024;
// Tên repo (canonical) phải khớp cùng pattern `packages/review-ready` dùng,
// NHƯNG chặn segment `..` (path traversal) và segment bắt đầu `.` (ẩn file).
const REPO_RE = /^(?!\.)(?!.*\.\.)[A-Za-z0-9_.-]+\/(?!\.)(?!.*\.\.)[A-Za-z0-9_.-]+$/;
const HEAD_SHA_RE = /^[0-9a-f]{40}$/;

// ---- loopback-only host check (fail-closed) --------------------------------
export function isLoopbackHost(host) {
  if (typeof host !== 'string') return false;
  if (host === 'localhost') return true;
  if (host === '::1') return true;
  // 127.0.0.0/8 — but each octet must be a valid 0..255 value.
  // The previous regex `/^127(?:\.\d{1,3}){3}$/` accepted malformed inputs like
  // "127.999.999.999" (octet > 255) as trusted loopback; reject them.
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  for (let i = 1; i <= 3; i++) {
    const n = Number(m[i]);
    if (!Number.isInteger(n) || n < 0 || n > 255) return false;
  }
  return true;
}

// ---- canonical request / evidence resolution (Issue #41, Phase 2) -----------
// Trả canonical review request + bounded evidence cho browser reviewer
// (MCP-SuperAssistant → ChatGPT/Gemini Web). KHÔNG nhận arbitrary path/repo/file:
// chỉ nhận identity triple (repository, issue, headSha) và resolve duy nhất 1
// file đã được `packages/review-ready` gate tạo ra từ canonical handoff report.
// Mọi lệch canonical → fail-closed { ok:false, error: { code, message } }.
// Secret-safety: thay mọi chuỗi giống secret (Bearer…, ghp_…, gho_…, AIza…,
// xoxb-…, AWS access key…) bằng "[REDACTED]" trước khi trả về. Không in env.

export function parseRequestIdentity(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, error: { code: 'ARGS_INVALID', message: 'args phải là object { repository, issue, headSha }' } };
  }
  const keys = Object.keys(args);
  if (keys.length !== 3 || !keys.includes('repository') || !keys.includes('issue') || !keys.includes('headSha')) {
    return { ok: false, error: { code: 'ARGS_INVALID', message: 'chỉ chấp nhận đúng 3 field: repository, issue, headSha' } };
  }
  const { repository, issue, headSha } = args;
  if (typeof repository !== 'string' || !REPO_RE.test(repository)) {
    return { ok: false, error: { code: 'REPO_INVALID', message: `repository phải dạng owner/name (canonical): ${String(repository)}` } };
  }
  const issueNum = Number(issue);
  if (!Number.isInteger(issueNum) || issueNum <= 0) {
    return { ok: false, error: { code: 'ISSUE_INVALID', message: `issue phải là số nguyên dương: ${String(issue)}` } };
  }
  if (typeof headSha !== 'string' || !HEAD_SHA_RE.test(headSha.toLowerCase())) {
    return { ok: false, error: { code: 'HEAD_SHA_INVALID', message: `headSha phải là sha1 hex 40 ký tự: ${String(headSha)}` } };
  }
  return { ok: true, identity: { repository, issue: issueNum, headSha: headSha.toLowerCase() } };
}

// Resolve file theo canonical filename (SSOT từ packages/review-ready).
// Browser KHÔNG truyền `pullRequest` (Issue #41 minimum identity = repository +
// issue + headSha), nên ta scan dir theo pattern:
//   <slug>_Issue-<n>_PR-<any>_<shortHead>_review-ready.md
// và match đúng identity bằng cách check `## Identity` block. Có nhiều hơn 1
// match cho cùng (slug, issue, shortHead) → AMBIGUOUS_REQUEST fail-closed.
// Bounded read: từ chối file > EVIDENCE_MAX_BYTES. Trả { ok, filePath, content,
// bytes, filename } hoặc { ok:false, error }.
export function loadReviewReadyArtifact(identity, { dir, maxBytes = EVIDENCE_MAX_BYTES } = {}) {
  const slug = identity.repository.replace(/\//g, '_');
  const shortHead = identity.headSha.slice(0, 7);
  const fileRe = new RegExp(
    `^${escapeRe(slug)}_Issue-${identity.issue}_PR-\\d+_${shortHead}_review-ready\\.md$`,
  );
  const baseDir = path.resolve(dir || DEFAULT_REVIEW_READY_DIR());
  // dùng lstatSync để chặn symlink dir (GPT-REV-134: artifact entry phải là
  // real entry trực tiếp, không follow symbolic link).
  let dirSt;
  try { dirSt = fs.lstatSync(baseDir); } catch { dirSt = null; }
  if (!dirSt || !dirSt.isDirectory()) {
    return { ok: false, error: { code: 'ARTIFACT_NOT_FOUND', message: `canonical dir không tồn tại: ${baseDir}` } };
  }
  const matches = [];
  for (const name of fs.readdirSync(baseDir)) {
    if (!fileRe.test(name)) continue;
    if (name.includes('/') || name.includes('\\') || name.startsWith('.')) continue;
    if (name.includes('..')) continue;
    matches.push(name);
  }
  if (matches.length === 0) {
    return { ok: false, error: { code: 'ARTIFACT_NOT_FOUND', message: `không có review-ready artifact khớp identity (repo=${identity.repository}, issue=${identity.issue}, headSha=${identity.headSha})` } };
  }
  if (matches.length > 1) {
    return { ok: false, error: { code: 'AMBIGUOUS_REQUEST', message: `nhiều artifact match identity: ${matches.join(', ')}` } };
  }
  const filename = matches[0];
  const filePath = path.join(baseDir, filename);
  // Path containment re-check.
  const rel = path.relative(baseDir, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, error: { code: 'PATH_ESCAPE', message: 'resolved path nằm ngoài canonical dir' } };
  }
  // GPT-REV-134: artifact entry phải là regular file trực tiếp, KHÔNG được là
  // symbolic link (tránh theo đường dẫn tới file ngoài canonical dir).
  // dùng lstatSync để KHÔNG follow symlink, rồi check isFile trên chính entry.
  let stat;
  try { stat = fs.lstatSync(filePath); } catch (e) {
    return { ok: false, error: { code: 'ARTIFACT_NOT_FOUND', message: `artifact entry không stat được: ${(e && e.message) || e}` } };
  }
  if (stat.isSymbolicLink()) {
    return { ok: false, error: { code: 'ARTIFACT_IS_SYMLINK', message: 'artifact entry là symbolic link, không được phép (chỉ chấp nhận regular file trực tiếp)' } };
  }
  if (!stat.isFile()) {
    return { ok: false, error: { code: 'ARTIFACT_NOT_FILE', message: 'artifact path không phải regular file' } };
  }
  if (stat.size > maxBytes) {
    return { ok: false, error: { code: 'BOUNDED_PAYLOAD_EXCEEDED', message: `artifact vượt cap ${maxBytes} bytes (size=${stat.size})` } };
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  // Stale-HEAD guard: identity trong content phải khớp EXACT (40-hex).
  if (!raw.includes(`headSha: ${identity.headSha}`)) {
    return { ok: false, error: { code: 'HEAD_SHA_MISMATCH', message: 'artifact không chứa headSha canonical (stale/wrong file)' } };
  }
  if (!raw.includes(`- repository: ${identity.repository}`)) {
    return { ok: false, error: { code: 'REPO_MISMATCH', message: 'artifact không chứa repository canonical' } };
  }
  if (!raw.includes(`- issue: ${identity.issue}`)) {
    return { ok: false, error: { code: 'ISSUE_MISMATCH', message: 'artifact không chứa issue canonical' } };
  }
  return { ok: true, filePath, filename, content: raw, bytes: stat.size };
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Redact token-like substrings để đảm bảo secret-safe.
export function redactSecrets(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [REDACTED]')
    .replace(/\bghp_[A-Za-z0-9]{20,}\b/g, 'ghp_[REDACTED]')
    .replace(/\bgho_[A-Za-z0-9]{20,}\b/g, 'gho_[REDACTED]')
    .replace(/\bghs_[A-Za-z0-9]{20,}\b/g, 'ghs_[REDACTED]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, 'github_pat_[REDACTED]')
    .replace(/\bxoxb-[A-Za-z0-9-]{20,}\b/g, 'xoxb-[REDACTED]')
    .replace(/\bAIza[0-9A-Za-z_-]{30,}\b/g, 'AIza[REDACTED]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA[REDACTED]');
}

// Trả canonical request payload (chỉ metadata + bounded trích từ section
// Identity/Scope). KHÔNG re-expose raw evidence body tại get_request —
// browser phải gọi get_evidence riêng.
export function buildRequestPayload(identity, opts) {
  const loaded = loadReviewReadyArtifact(identity, opts);
  if (!loaded.ok) return loaded;
  const text = loaded.content;
  const head = {
    identity: { ...identity },
    artifact: { filename: loaded.filename, bytes: loaded.bytes, truncated: false },
  };
  const m = /- reportDigest:\s*([0-9a-f]{64})/.exec(text);
  if (m) head.artifact.reportDigest = m[1];
  const ts = /- status:\s*\*\*([A-Z_]+)\*\*/.exec(text);
  if (ts) head.artifact.terminalStatus = ts[1];
  const obj = /- objective:\s*(.+)/.exec(text);
  if (obj) head.artifact.objective = obj[1].trim();
  const acc = text.match(/- acceptanceCriteria:\s*\n((?:\s*-\s+.+\n?)+)/);
  if (acc) {
    head.artifact.acceptanceCriteria = acc[1]
      .split('\n')
      .map((l) => l.replace(/^\s*-\s+/, '').trim())
      .filter(Boolean)
      .slice(0, 64)
      .join('\n');
  }
  return { ok: true, request: head };
}

export function buildEvidencePayload(identity, opts) {
  const loaded = loadReviewReadyArtifact(identity, opts);
  if (!loaded.ok) return loaded;
  return {
    ok: true,
    evidence: {
      identity: { ...identity },
      artifact: { filename: loaded.filename, bytes: loaded.bytes },
      contentType: 'text/markdown',
      content: redactSecrets(loaded.content),
    },
  };
}

// ---- shared MCP handler (Issue #34 shape, reused verbatim) -----------------
export function createReviewMcp({ requestDir } = {}) {
  // Exactly three read-only tools. No execution/write/GitHub capability is exposed.
  const tools = [
    {
      name: TOOL_NAMES.ping,
      description:
        'Read-only liveness probe for the Soc_brain ChatGPT review MCP. Returns service identity.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: TOOL_NAMES.getRequest,
      description:
        'Return the canonical Soc_brain review request selected by identity (repository, issue, headSha). Read-only; the browser cannot supply an arbitrary path/repo/file. Resolves the pre-gated review-ready artifact (REVIEW HANDOFF CONTRACT v1.0.0).',
      inputSchema: {
        type: 'object',
        properties: {
          repository: { type: 'string', description: 'owner/name (canonical)' },
          issue: { type: 'integer', minimum: 1, description: 'GitHub issue number' },
          headSha: { type: 'string', description: 'exact 40-hex sha1' },
        },
        required: ['repository', 'issue', 'headSha'],
        additionalProperties: false,
      },
    },
    {
      name: TOOL_NAMES.getEvidence,
      description:
        'Return bounded evidence (markdown content) for the canonical review request selected by identity. Read-only; capped at 256 KiB; secret-safe (token-like substrings are redacted).',
      inputSchema: {
        type: 'object',
        properties: {
          repository: { type: 'string', description: 'owner/name (canonical)' },
          issue: { type: 'integer', minimum: 1, description: 'GitHub issue number' },
          headSha: { type: 'string', description: 'exact 40-hex sha1' },
        },
        required: ['repository', 'issue', 'headSha'],
        additionalProperties: false,
      },
    },
    {
      name: TOOL_NAMES.submitDecision,
      description:
        'Submit a canonical review decision for the pre-gated review-ready artifact selected by identity (repository, issue, headSha). Browser only — no GitHub IO. Verdict at boundary = PASS / REWORK / BLOCKED. Idempotent at the deterministic path; identical payload → DUPLICATE_NOOP, different payload at same path → DUPLICATE_CONFLICT. Writes ONE file under <dir>/_decisions/ with payload digest and timestamps; atomic write; 256 KiB cap; symlink guard; secret redaction.',
      inputSchema: {
        type: 'object',
        properties: {
          repository: { type: 'string', description: 'owner/name (canonical)' },
          issue: { type: 'integer', minimum: 1, description: 'GitHub issue number' },
          headSha: { type: 'string', description: 'exact 40-hex sha1' },
          requestDigest: { type: 'string', description: 'sha256 hex 64 chars (matches artifact reportDigest)' },
          contentDigest: { type: 'string', description: 'sha256 hex 64 chars (matches artifact content bytes)' },
          verdict: { type: 'string', enum: ['PASS', 'REWORK', 'BLOCKED'] },
          findings: { type: 'array', description: 'optional findings list (max 64 entries)' },
          evidenceRequests: { type: 'array', description: 'optional evidence request list (max 32 entries)' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          metadata: { type: 'object', description: 'opaque 1-level metadata' },
          submittedBy: { type: 'string', description: 'opaque label, not an authority' },
        },
        required: ['repository', 'issue', 'headSha', 'requestDigest', 'contentDigest', 'verdict'],
        additionalProperties: false,
      },
    },
  ];

  function toolError(id, code, message) {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32602, message, data: { toolError: code } },
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

  function handleRequest(request) {
    if (!request || typeof request !== 'object') return null;
    const { id, method } = request;

    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          serverInfo: { name: 'soc-brain-review', version: MCP_SERVER_VERSION },
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
        return toolResult(id, { ok: true, service: 'soc_brain', mode: 'review-readonly' });
      }
      if (name === TOOL_NAMES.getRequest) {
        const parsed = parseRequestIdentity(args);
        if (!parsed.ok) return toolError(id, parsed.error.code, parsed.error.message);
        const built = buildRequestPayload(parsed.identity, { dir: requestDir });
        if (!built.ok) return toolError(id, built.error.code, built.error.message);
        return toolResult(id, built);
      }
      if (name === TOOL_NAMES.getEvidence) {
        const parsed = parseRequestIdentity(args);
        if (!parsed.ok) return toolError(id, parsed.error.code, parsed.error.message);
        const built = buildEvidencePayload(parsed.identity, { dir: requestDir });
        if (!built.ok) return toolError(id, built.error.code, built.error.message);
        return toolResult(id, built);
      }
      if (name === TOOL_NAMES.submitDecision) {
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          return toolError(id, 'ARGS_INVALID', 'args phải là object');
        }
        // submitDecision's identity is a SUBSET of args (it also carries requestDigest/contentDigest/verdict/...).
        // We do NOT pre-validate identity here; processSubmitDecision is the single validator and
        // returns precise codes (REPO_INVALID / ISSUE_INVALID / HEAD_SHA_INVALID).
        const baseDir = requestDir || DEFAULT_REVIEW_READY_DIR();
        const result = processSubmitDecision(args, {
          redactSecrets,
          loadArtifact: (ident, opts) => loadReviewReadyArtifact(ident, opts),
          baseDir,
        });
        if (!result.ok) {
          if (result.errors) {
            return {
              jsonrpc: '2.0',
              id,
              error: {
                code: -32602,
                message: 'Validation failed',
                data: { toolError: 'VALIDATION_FAILED', errors: result.errors },
              },
            };
          }
          return toolError(id, result.code, result.message);
        }
        return toolResult(id, {
          ok: true,
          persisted: !!result.persisted,
          code: result.code || 'PERSISTED',
          decision: result.decision,
          filePath: result.filePath,
          bytes: result.bytes,
        });
      }
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: `Unknown tool: ${name}` },
      };
    }
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    };
  }

  return { tools, handleRequest };
}

// ---- loopback HTTP server (MCP Streamable HTTP transport) ------------------
// Streamable HTTP (2025-03-26): one MCP endpoint that supports BOTH POST
// (client->server JSON-RPC) and GET (server->client SSE stream). Servers MUST
// validate the Origin header on every connection (DNS-rebinding guard) and must
// expose browser-compatible CORS so a Chrome extension / web page can reach it.

// Origins we are willing to serve. No-Origin is a non-browser client (curl/node).
const LOOPBACK_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const ALLOWED_WEB_HOSTS = [
  'chatgpt.com',
  'chat.openai.com',
  'gemini.google.com',
  'aistudio.google.com',
  'perplexity.ai',
  'grok.com',
  'openrouter.ai',
  'deepseek.com',
];

export function isAllowedOrigin(origin) {
  if (typeof origin !== 'string' || origin === '') return true; // non-browser client
  if (LOOPBACK_ORIGIN_RE.test(origin)) return true; // the server's own origin
  if (origin.startsWith('chrome-extension://')) return true; // MCP-SuperAssistant
  let host;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  return ALLOWED_WEB_HOSTS.some((w) => host === w || host.endsWith('.' + w));
}

// Browser-compatible CORS. Reflects the request Origin (validated above) instead
// of hard-coding `*`, so credentialed requests work; reflects the exact headers
// the preflight asks for so any extension header list is accepted.
export function corsHeaders(req) {
  const origin = req.headers.origin;
  const allowOrigin = origin && isAllowedOrigin(origin) ? origin : '*';
  const requested = req.headers['access-control-request-headers'];
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    ...(origin ? { Vary: 'Origin' } : {}),
    'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
      requested || 'content-type, mcp-session-id, accept, authorization, last-event-id, x-request-id',
    'Access-Control-Max-Age': '3600',
    ...(origin ? { 'Access-Control-Allow-Credentials': 'true' } : {}),
  };
}

function httpJson(req, res, status, obj, extra) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...corsHeaders(req), ...(extra || {}) });
  res.end(JSON.stringify(obj));
}

function readBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      chunks.push(c);
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleMcpRequest(req, res, server) {
  const accept = String(req.headers.accept || '');
  const clientSession = req.headers['mcp-session-id'];

  const body = await readBody(req).catch(() => null);
  let parsed;
  try {
    parsed = body && body.trim() ? JSON.parse(body) : null;
  } catch (e) {
    return httpJson(req, res, 400, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error', detail: String((e && e.message) || e) },
    });
  }
  if (parsed == null || typeof parsed !== 'object') {
    return httpJson(req, res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
  }

  const messages = Array.isArray(parsed) ? parsed : [parsed];
  const responses = [];
  let seenInitialize = false;
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    if (msg.method === 'initialize') seenInitialize = true;
    const r = server.handleRequest(msg);
    if (r) responses.push(r);
  }

  // Only notifications (no id) -> 202 Accepted, no body.
  if (responses.length === 0) {
    res.writeHead(202, { 'Content-Type': 'text/plain', ...corsHeaders(req) });
    res.end('');
    return;
  }

  const bodyText = JSON.stringify(responses.length === 1 ? responses[0] : responses);
  const session = clientSession || crypto.randomUUID();
  const wantsJson = accept.includes('application/json') || !accept.includes('text/event-stream');

  if (wantsJson) {
    const extra = seenInitialize ? { 'Mcp-Session-Id': session } : {};
    httpJson(req, res, 200, JSON.parse(bodyText), extra);
    return;
  }

  // SSE — single event then close.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'close',
    ...corsHeaders(req),
    ...(seenInitialize ? { 'Mcp-Session-Id': session } : {}),
  });
  res.write(`data: ${bodyText}\n\n`);
  res.end();
}

export function startHttpServer({ host = DEFAULT_HOST, port = DEFAULT_PORT, requestDir = null } = {}) {
  if (!isLoopbackHost(host)) {
    throw new Error(
      `REVIEW_MCP_HOST ${JSON.stringify(host)} is not a loopback address; refusing to bind (loopback-only PoC, Issue #39).`,
    );
  }
  const server = createReviewMcp({ requestDir });
  const isMcpPath = (u) => u.pathname === '/mcp';

  const httpServer = http.createServer((req, res) => {
    const u = new URL(req.url, `http://${host}`);

    // Streamable HTTP MUST validate the Origin header on every incoming
    // connection to prevent DNS-rebinding. Disallowed -> 403 with no
    // Access-Control-Allow-Origin so a browser treats the request as CORS-failed
    // (fail-closed, no data leaks to a foreign page).
    const origin = req.headers.origin;
    if (origin && !isAllowedOrigin(origin)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Origin not allowed', detail: origin } }));
      return;
    }

    if (req.method === 'OPTIONS' && isMcpPath(u)) {
      res.writeHead(204, corsHeaders(req));
      res.end();
      return;
    }

    if (req.method === 'POST' && isMcpPath(u)) {
      handleMcpRequest(req, res, server).catch((e) => {
        if (!res.headersSent) {
          httpJson(req, res, 500, {
            jsonrpc: '2.0',
            id: null,
            error: { code: -32603, message: 'Internal error', detail: String((e && e.message) || e) },
          });
        } else {
          res.end();
        }
      });
      return;
    }

    // Streamable HTTP GET: server->client SSE stream, kept open for the session.
    if (req.method === 'GET' && isMcpPath(u)) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...corsHeaders(req),
      });
      res.write(': connected\n\n');
      let alive = true;
      const keepAlive = setInterval(() => {
        if (!alive) return clearInterval(keepAlive);
        try {
          res.write(': keep-alive\n\n');
        } catch {
          alive = false;
          clearInterval(keepAlive);
        }
      }, 15_000);
      const stop = () => {
        alive = false;
        clearInterval(keepAlive);
      };
      req.on('close', stop);
      res.on('close', stop);
      return;
    }

    httpJson(req, res, 405, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32601, message: `Not allowed: ${req.method} ${u.pathname}` },
    }, { Allow: 'POST /mcp, GET /mcp, OPTIONS /mcp' });
  });

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      const addr = httpServer.address();
      resolve({
        host: addr.address,
        port: addr.port,
        url: `http://127.0.0.1:${addr.port}/mcp`,
        server: httpServer,
        close: () => new Promise((r) => httpServer.close(() => r())),
      });
    });
  });
}


// ---- stdio entry point (Issue #34 shape) -----------------------------------
function main() {
  const server = createReviewMcp();
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      let req;
      try {
        req = JSON.parse(t);
      } catch (e) {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Parse error', detail: String((e && e.message) || e) },
          }) + '\n',
        );
        continue;
      }
      const res = server.handleRequest(req);
      if (res) process.stdout.write(JSON.stringify(res) + '\n');
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

async function httpMain() {
  try {
    const host = process.env.REVIEW_MCP_HOST || DEFAULT_HOST;
    const port = Number(process.env.REVIEW_MCP_PORT || DEFAULT_PORT);
    const requestDir = process.env.REVIEW_MCP_REQUEST_DIR || null;
    const s = await startHttpServer({ host, port, requestDir });
    process.stderr.write(`soc-brain review MCP (HTTP) listening on ${s.url}\n`);
  } catch (e) {
    process.stderr.write(`soc-brain review MCP HTTP startup failed: ${(e && e.message) || e}\n`);
    process.exit(1);
  }
}

// Run directly: node review-mcp-http.mjs [--http] (GPT-REV-138-style check).
const isDirect =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirect) {
  if (process.argv.includes('--http')) httpMain();
  else main();
}

