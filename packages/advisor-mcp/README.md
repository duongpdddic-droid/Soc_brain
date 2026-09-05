# advisor-mcp — Soc_brain bounded GPT/Gemini advisor MCP (Issue #63)

MCP server **stdio JSON-RPC** exposing exactly 3 tools, zero dependencies:

| Tool | Provider | Vai trò |
| --- | --- | --- |
| `advisor.ping` | — | health + models config (no LLM call) |
| `advisor.ask` | OpenRouter `openai/gpt-5.6-sol` (default) | structured decision: `CONTINUE \| REWORK \| USE_OTHER_EXECUTOR \| ASK_GEMINI \| HUMAN_GATE_REQUIRED \| TASK_ACCEPTED` |
| `advisor.second_opinion` | OpenRouter `google/gemini-3.8-flash` (default) | independent second opinion / research check |

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

`cline_mcp_settings.json` (user-level, ngoài repo):

```json
"soc-brain-advisor": {
  "command": "node",
  "args": ["<repo-root>\\packages\\advisor-mcp\\advisor-mcp.mjs"],
  "env": { "OPENROUTER_API_KEY": "..." },
  "disabled": false
}
```

Env overrides: `SOC_ADVISOR_GPT_MODEL`, `SOC_ADVISOR_GEMINI_MODEL`.
Key thiếu → mọi call fail-closed `MISSING_API_KEY` (ping vẫn sống).

## Tests

```bash
node --test tests/advisor-mcp.test.mjs   # deterministic, mocked transport
node scripts/e2e-advisor-control-path.mjs  # REAL GPT + Gemini (không mock, tốn quota nhỏ)
```
