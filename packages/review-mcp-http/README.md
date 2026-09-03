# review-mcp-http — Soc_brain Review MCP (Phase 1 = Issue #39, Phase 2 = Issue #41)

MCP server **đọc-only**, mở đúng **ba tool** Phase 2:
`review.ping`, `review.get_request`, `review.get_evidence`. Đây là transport
phía server; **MCP-SuperAssistant (Chrome extension)** là **browser transport
shim** nối trang Web LLM (Gemini/ChatGPT/…) với `localhost` (model-generated
JSONL → extension capture → manual Run → local MCP → result). Không phải native
ChatGPT MCP/tool calling, không phải authority/control plane.

Mục tiêu Phase 1: chứng minh Browser (Web) ↔ MCP-SuperAssistant ↔ localhost
Streamable HTTP ↔ Soc_brain Review MCP **round-trip được** (generic browser
transport). Evidence trên **cả Gemini Web lẫn ChatGPT Web** đều đã PASS.

Mục tiêu Phase 2 (Issue #41): mở rộng từ `review.ping` thành **canonical
request + bounded evidence transport** cho browser reviewer. Identity triple
`(repository, issue, headSha)` được browser cung cấp; server resolve duy nhất
1 file MD đã được `packages/review-ready` gate tạo ra từ canonical handoff
report (`REVIEW HANDOFF CONTRACT v1.0.0`) — KHÔNG nhận arbitrary path/repo/
file/GitHub URL.

Chuỗi bảo mật bị ép cứng:

- **Loopback-only**: nếu `REVIEW_MCP_HOST` không phải loopback (`127.0.0.1`, `::1`,
  `localhost`) thì server ném lỗi ngay khi khởi động (fail-closed). Không
  `0.0.0.0`, không LAN IP, không public host, **không tunnel/proxy**.
- **Read-only**: không có tool ghi/exec/GitHub/broker/runtime/shell.
- **Không mở rộng authority ngoài `review.ping`**.

## Chạy

```bash
# Stdio — nối qua một MCP client stdio (như xterm/Claude/…)
node review-mcp-http.mjs

# HTTP loopback (Streamable HTTP tại /mcp — POST + GET SSE)
node review-mcp-http.mjs --http
# → lắng nghe 127.0.0.1:8100/mcp (port đổi qua env REVIEW_MCP_PORT)
# /mcp: POST = JSON-RPC (client→server), GET = SSE stream (server→client).
# CORS reflect Origin + validate Origin (chặn DNS-rebinding) → tương thích Chrome.
```

## Cấu hình MCP-SuperAssistant (HUMAN GATE)

- Connect type: **Streamable HTTP**.
- URL: `http://127.0.0.1:8100/mcp`
  - Chỉ dùng `127.0.0.1`/`localhost` — không dùng IP mạng nội bộ, không `0.0.0.0`,
    không host công khai.
- Port mặc định `8100`; nếu cần đổi, set `REVIEW_MCP_PORT` rồi dùng đúng port trong URL.
- **Sau khi đổi config phải bấm Save & Reconnect** trong extension; chỉ Reconnect
  mà chưa Save thì extension giữ cấu hình cũ và sẽ báo lỗi không phải do transport.
  - Auto Execute / Auto Submit: **OFF** (manual Run).
- Cấu hình server đã lưu được **tái dùng chung** cho mọi trang Web mà extension hỗ
  trợ (Gemini, ChatGPT, …) — không cần setup lại theo từng site.

## Vòng lặp kiểm thử thủ công (Bố)

1. Chạy server:
   `node packages/review-mcp-http/review-mcp-http.mjs --http`
2. Mở **Gemini Web** hoặc **ChatGPT Web** (Chrome) → mở **MCP-SuperAssistant
   sidebar** → **Add MCP Server** với URL `http://127.0.0.1:8100/mcp` → **Save &
   Reconnect**.
3. Trong hội thoại, insert MCP instructions để extension nhận tool → model sinh
   JSONL call `review.ping` → extension capture thành nút **Run** → bấm **Run**
   thủ công.
4. Kết quả mong đợi trả về Web:
   `{"ok":true,"service":"soc_brain","mode":"review-readonly"}`

### Test tự động (deterministic)

```bash
node --test tests/review-mcp-http.test.mjs   # 18 PASS
# Không chạy full-suite 'tests/*.test.mjs' trong worktree vì known harness tạo
# nhiều git worktree và làm shared-terminal mất shell-integration. Phạm vi của
# #39 chỉ là review-mcp-http, file này PASS xanh là đủ evidence cho diff này.
```

## Evidence

| Hạng mục | Kết quả |
| --- | --- |
| `node --check` server + test | PASS (cú pháp hợp lệ) |
| `node --test tests/review-mcp-http.test.mjs` | **PASS 18/18** (gồm 6 test CORS/Origin/SSE) |
| Preflight `OPTIONS /mcp` (origin `chrome-extension://…`) | **PASS** → 204, ACAO reflect origin, `Access-Control-Allow-Credentials:true`, `Vary:Origin` |
| `POST /mcp` `initialize` | **PASS** → 200, `serverInfo.name=soc-brain-review`, `Mcp-Session-Id` |
| `POST /mcp` `tools/call review.ping` | **PASS** → `{"ok":true,"service":"soc_brain","mode":"review-readonly"}` |
| `GET /mcp` (Accept: `text/event-stream`) | **PASS** → 200 `text/event-stream`, stream mở (server→client SSE) |
| Origin không hợp lệ (`https://evil.example.test`) | **PASS** → 403, không ACAO (fail-closed chặn DNS-rebinding) |
| **Generic browser transport (Streamable HTTP + CORS/Origin)** | **PASS** (node test + smoke trên `127.0.0.1`) |
| **Gemini Web ↔ MCP-SuperAssistant ↔ localhost round-trip** | **PASS** (Bố: Server Connected, tool discovery 1/1, manual Run → `{"ok":true,"service":"soc_brain","mode":"review-readonly"}`) |
| **ChatGPT Web ↔ MCP-SuperAssistant ↔ localhost round-trip** | **PASS** (Bố: cùng server config reuse, manual Run → `{"ok":true,"service":"soc_brain","mode":"review-readonly"}`, Execution History ghi success) |
| `review.ping` (dấu chấm) qua tool discovery | **PASS** — không cần đổi tên |
| Extension-level server config reuse across sites | **PASS** (observed) |

### Ghi chú gốc về lần reconnect FAIL trước

- Lần Reconnect trước vẫn báo `SSE error: Failed to fetch` vì **config MCP-SuperAssistant
  chưa được Save & Reconnect sau khi đổi URL** (UI extension không hiển thị rõ
  trạng thái Save). **Không phải lỗi server, không phải lỗi CORS/protocol.** Sau
  khi Save & Reconnect: Server Connected, tool discovery 1/1, manual Run PASS.
- `GET /mcp` SSE + CORS reflect/validate Origin là **compatibility requirement hợp
  lệ theo MCP Streamable HTTP (2025-03-26) + Chrome browser** — giữ để transport
  tương thích mọi client spec-compliant. **Không ghi rằng chúng đã fix lần
  reconnect FAIL** (root cause đúng là Save & Reconnect).

### Root cause & fix transport (compatibility, không gắn với lỗi Reconnect trước)

- **Lý do cần `GET /mcp` SSE**: MCP Streamable HTTP (2025-03-26) bắt buộc endpoint
  hỗ trợ cả POST và GET; GET mở SSE stream server→client. Cần cho mọi client
  spec-compliant.
- **Lý do cần CORS reflect + validate Origin**: Chrome browser từ trang HTTPS gọi
  tới loopback HTTP — phải trả ACAO = Origin (không `*`) khi có credentials, và
  phải validate Origin để chặn DNS-rebinding.
- **Fix trong #39** (giữ loopback-only; không mở LAN/public; không proxy; không
  mở rộng authority): thêm `GET /mcp` → `text/event-stream` (keep-alive);
  preflight `OPTIONS` reflect `Origin` + `Access-Control-Request-Headers`;
  `validate Origin` (origin lạ → 403, chặn DNS-rebinding).
- `protocolVersion` = `2025-03-26`.

## Trạng thái Issue #39 (cuối README)

- **Generic browser transport (Streamable HTTP + CORS/Origin)**: **PASS** — đã
  chứng minh bằng deterministic test (18/18) + smoke trên `127.0.0.1:8123`.
- **Gemini Web** qua MCP-SuperAssistant: **PASS** — Bố chạy manual Run, exact
  result `{"ok":true,"service":"soc_brain","mode":"review-readonly"}`.
- **ChatGPT Web** qua MCP-SuperAssistant: **PASS** — Bố chạy manual Run, exact
  result `{"ok":true,"service":"soc_brain","mode":"review-readonly"}`, Execution
  History ghi success. Cùng config server reuse từ Gemini.
- **MCP-SuperAssistant** là **transport shim**, không phải authority/control plane.
  Không mô tả `review.ping` là native ChatGPT MCP/tool calling.

## Phase 2 (Issue #41) — canonical request + bounded evidence

Thêm 2 tool đọc-only (giữ `review.ping`):

| Tool | Input | Trả về |
| --- | --- | --- |
| `review.ping` | (none) | `{ ok:true, service:"soc_brain", mode:"review-readonly" }` |
| `review.get_request` | `{ repository, issue, headSha }` | Canonical request payload (identity + terminalStatus + objective + acceptanceCriteria + reportDigest). KHÔNG re-expose evidence body. |
| `review.get_evidence` | `{ repository, issue, headSha }` | Bounded markdown content (cap 256 KiB) + secret-redact. |

### Canonical source (SSOT)

Resolution pipeline (no parallel store):

1. Browser cung cấp identity triple `(repository, issue, headSha)`.
2. Server scan canonical dir `~/.soc-brain/review-ready/` (hoặc
   `REVIEW_MCP_REQUEST_DIR`) theo pattern:
   `<slug>_Issue-<n>_PR-<any>_<shortHead>_review-ready.md`.
3. Validate identity trong section `## Identity` của file (40-hex headSha,
   repository, issue khớp exact). 0 match → `ARTIFACT_NOT_FOUND`; >1 match →
   `AMBIGUOUS_REQUEST`. Cả hai fail-closed.
4. Trả payload (get_request chỉ metadata, get_evidence trả bounded content).

Các file này **đã được `packages/review-ready` gate từ Issue #32** validate
bằng `REVIEW HANDOFF CONTRACT v1.0.0` (terminalStatus phải là
`READY_FOR_REVIEW`). MCP server KHÔNG re-validate handoff — chỉ resolve theo
identity đã được canonical layer chuẩn hoá trước đó.

### Authority boundary

- **Read-only tuyệt đối**: không tool `submit_decision`, `write_decision`,
  `merge`, `approve`. Không import/bind state machine của task/issue.
- **Không nhận arbitrary path/repo/file**: 3 field nghiêm ngặt
  (`additionalProperties: false`). `path`, `file`, `pr`, `branch` từ browser
  đều bị `ARGS_INVALID` ngay tại boundary.
- **Identity gate**: `repository` phải match `owner/name` không chứa `..`,
  không segment bắt đầu `.`; `issue` phải là số nguyên dương; `headSha`
  phải là sha1 hex 40 ký tự.
- **Stale-HEAD guard**: file chứa headSha khác với identity → `HEAD_SHA_MISMATCH`
  fail-closed (chặn đọc nhầm artifact cũ).
- **Cross-task/cross-repo guard**: identity (repo, issue) khác với section
  Identity trong file → `REPO_MISMATCH` / `ISSUE_MISMATCH` fail-closed.
- **Bounded payload**: file > 256 KiB → `BOUNDED_PAYLOAD_EXCEEDED` fail-closed.
- **Secret-safe**: `redactSecrets` thay mọi token-like substring (Bearer,
  `ghp_…`, `gho_…`, `ghs_…`, `github_pat_…`, `xoxb-…`, `AIza…`, `AKIA…`) bằng
  `[REDACTED]` trước khi trả về browser.
- **Loopback-only** + Origin/CORS boundary từ Phase 1 giữ nguyên.

### Tests

```bash
node --test tests/review-mcp-http.test.mjs          # 18 PASS (Phase 1 regression)
node --test tests/review-mcp-http.phase2.test.mjs   # 34 PASS (Phase 2)
```

Coverage Phase 2 (§1..§8 trong test file): capability surface chính xác 3
tool; parseRequestIdentity malformed/extra-fields/leading-dot/path-traversal;
loadReviewReadyArtifact resolve + stale + cross-task + oversized; no arbitrary
file/path; buildRequestPayload no body re-expose; buildEvidencePayload bounded
+ secret-safe; in-process handler từng fail-closed path; HTTP loopback
round-trip với `tools/list` + `get_request` + `get_evidence`.

### Human Gate (Phase 2)

Sau khi deterministic tests PASS, Bố chạy manual trên ChatGPT Web:

1. Bật server: `node packages/review-mcp-http/review-mcp-http.mjs --http`.
2. Có sẵn 1 file canonical:
   ```
   ~/.soc-brain/review-ready/duongpdddic-droid_Soc_brain_Issue-41_PR-<n>_<shortHEAD>_review-ready.md
   ```
   (Bố generate bằng `writeReviewReady(sampleReport, …)` từ
   `packages/review-ready` với identity đúng `HEAD` hiện tại của branch).
3. Mở ChatGPT Web → MCP-SuperAssistant sidebar → bấm **Run** trên
   `review.get_request` với arguments:
   ```json
   { "repository": "duongpdddic-droid/Soc_brain",
     "issue": 41,
     "headSha": "<short-or-full 40-hex HEAD của branch agent/issue-41-review-evidence>" }
   ```
4. Verify payload trả về có `terminalStatus=READY_FOR_REVIEW`, `objective` =
   "Phase 2 PoC", `acceptanceCriteria` chứa "canonical request resolved".
5. Sau đó bấm **Run** trên `review.get_evidence` với cùng arguments.
6. Verify content markdown trả về có section `## Identity`, `## Scope`,
   `## Terminal status`. Nếu có `Bearer xxx` test → phải thấy `[REDACTED]`.
7. Auto Execute / Auto Submit **OFF** — chỉ Manual Run.


