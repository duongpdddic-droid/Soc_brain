# advisor-mcp — Soc_brain bounded GPT/Gemini advisor MCP (Issue #63)

MCP server **stdio JSON-RPC** exposing exactly 3 tools, zero dependencies:

| Tool | Provider | Vai trò |
| --- | --- | --- |
| `advisor.ping` | — | health + models config (no LLM call) |
| `advisor.ask` | GPT-role model `groq/openai/gpt-oss-120b` (default — OpenAI's open-weight GPT-OSS family served via Groq free tier) | structured decision: `CONTINUE \| REWORK \| USE_OTHER_EXECUTOR \| ASK_GEMINI \| HUMAN_GATE_REQUIRED \| TASK_ACCEPTED` |
| `advisor.second_opinion` | Gemini-role model `google/gemini-3.8-flash` (default) qua provider cấu hình | independent second opinion / research check |

> **Why gpt-oss-120b as default** — it is an actual OpenAI upstream model
> (Apache-2.0 open-weight GPT family, 2025) served free via Groq. The previous
> default `openai/gpt-5.6-sol` was an OpenRouter credit-metered route that
> 429-fails when the user has no OpenRouter credit, and could be mistaken for a
> relabeled DeepSeek/etc. when the upstream quota is gone. `gpt-oss-120b`
> through Groq requires no paid credit, so a fresh Cline session immediately
> reaches an authentic OpenAI GPT model. Override any time with
> `SOC_ADVISOR_GPT_MODEL` + `SOC_ADVISOR_BASE_URL`.

## Ranh giới authority

- **Hỏi-đáp thuần**: không shell, không fs, không GitHub, không mutation. GPT là
  delegated decision authority TẠM THỜI do người dùng ủy quyền; Gemini không sở
  hữu lifecycle authority.
- **Anti-stale/anti-replay binding**: mỗi call yêu cầu `requestId` fresh; reply
  PHẢI echo `requestId` + `binds{repo,taskRef,stateDigest}` khớp request. Lệch →
  `REQUEST_ID_MISMATCH` / `BINDING_MISMATCH` (fail-closed).
- **Bounded payload**: `question + evidence` ≤ 64 KiB. **Bounded generation**:
  `temperature 0`, `max_tokens 800`, timeout 120s.
- **Không phụ thuộc conversation history**: mỗi call standalone với canonical packet.

## Input schema (ask / second_opinion)

```json
{
  "requestId": "fresh-unique-id",
  "repo": "owner/name",
  "taskRef": "Issue #63",
  "stateDigest": "<sha256 hex 64 của canonical task state text>",
  "question": "...",
  "evidence": "compact canonical state/evidence text"
}
```

## Chạy / đăng ký Cline

### Cài 1 lần (idempotent) cho fresh Cline session

Cline 3.x đọc `cline_mcp_settings.json` ở user-level. Script PowerShell dưới
đây merge entry `soc-brain-advisor` vào file đó **idempotent** (chạy bao
nhiêu lần cũng cho cùng kết quả), không ghi đè các entry khác, không commit
secret:

```powershell
# từ repo root
node scripts/install-advisor-mcp.mjs
```

Script tự detect `cline_mcp_settings.json` qua env `CLINE_MCP_SETTINGS` (override
được) hoặc qua `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\).
Có flag `--dry-run` để in diff, `--restore` để revert về file gốc nếu đã
backup. Không tự ghi file nếu diff rỗng.

Nếu chưa có `SOC_ADVISOR_API_KEY` trong env shell, script sẽ nhắc nhập 1 lần
và lưu vào file `.env.local` (gitignored) — KHÔNG nhúng vào
`cline_mcp_settings.json` để tránh commit lỡ secret.

### Cấu hình thủ công

`cline_mcp_settings.json` (user-level, ngoài repo):

```json
"soc-brain-advisor": {
  "command": "node",
  "args": ["<repo-root>\\packages\\advisor-mcp\\advisor-mcp.mjs"],
  "env": { "SOC_ADVISOR_API_KEY": "...", "SOC_ADVISOR_BASE_URL": "https://openrouter.ai/api/v1" },
  "disabled": false
}
```

## Env overrides (provider-replaceable)

| Env | Ý nghĩa | Mặc định |
| --- | --- | --- |
| `SOC_ADVISOR_API_KEY` | key của provider (fallback `OPENROUTER_API_KEY`) | — |
| `SOC_ADVISOR_BASE_URL` | base URL OpenAI-compatible, KHÔNG kèm `/chat/completions` | `https://openrouter.ai/api/v1` |
| `SOC_ADVISOR_GPT_MODEL` | model vai trò GPT (decision authority) | `groq/openai/gpt-oss-120b` |
| `SOC_ADVISOR_GEMINI_MODEL` | model vai trò Gemini (second opinion) | `google/gemini-3.8-flash` |

Ví dụ chạy qua **9Router** (gateway local OpenAI-compatible, free):

```json
"env": {
  "SOC_ADVISOR_API_KEY": "<NINE_ROUTER_API_KEY>",
  "SOC_ADVISOR_BASE_URL": "http://127.0.0.1:20128/v1",
  "SOC_ADVISOR_GPT_MODEL": "Soc_OR_act",
  "SOC_ADVISOR_GEMINI_MODEL": "gemini/gemini-3.8-flash"
}
```

Contract (echo binding + decision enum + bounded payload) KHÔNG đổi theo provider.
Key thiếu → mọi call fail-closed `MISSING_API_KEY` (ping vẫn sống).

## Tests

```bash
node --test tests/advisor-mcp.test.mjs   # deterministic, mocked transport
node scripts/e2e-advisor-control-path.mjs  # REAL GPT + Gemini (không mock, tốn quota nhỏ)
```
