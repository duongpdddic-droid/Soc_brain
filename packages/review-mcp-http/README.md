# review-mcp-http — Soc_brain Review MCP (Phase 1, Issue #39)

MCP server **đọc-only**, mở đúng **một tool**: `review.ping`. Đây là transport
phía server; **MCP-SuperAssistant (Chrome extension)** là **browser transport
shim** nối trang Web LLM (Gemini/ChatGPT/…) với `localhost` (model-generated
JSONL → extension capture → manual Run → local MCP → result). Không phải native
ChatGPT MCP/tool calling, không phải authority/control plane.

Mục tiêu Phase 1: chứng minh Browser (Web) ↔ MCP-SuperAssistant ↔ localhost
Streamable HTTP ↔ Soc_brain Review MCP **round-trip được** (generic browser
transport). Evidence trên **cả Gemini Web lẫn ChatGPT Web** đều đã PASS.

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

