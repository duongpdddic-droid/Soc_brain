# Soc_brain — ChatGPT Secure MCP Tunnel (PoC, Issue #34)

Dedicated read-only stdio MCP server for the ChatGPT reviewer. Connects to ChatGPT
via the OpenAI Secure MCP Tunnel (`tunnel-client` v0.0.14, tunnel display name
`Soc_brain Review Tunnel`).

## Scope (deliberate)

- Exposes EXACTLY ONE tool: `review.ping` → `{ok:true, service:"soc_brain", mode:"review-readonly"}`.
- READ-ONLY: no GitHub, write, command/broker/execution or filesystem capability.
- Does NOT reuse the runtime-sandbox execution boundary. Imports nothing from
  `packages/runtime-sandbox`, `packages/execution-broker`, `packages/safe-git`,
  `packages/temp-hygiene`. Self-contained stdio JSON-RPC 2.0 newline-delimited server.
- No TCP listener. Read from stdin, write to stdout, exit 0 on EOF.

## Files

- `packages/review-mcp/review-mcp.mjs` — the server (ESM, no dependencies).
- `tests/review-mcp.test.mjs` — node:test unit + real-stdio e2e (runs via `npm test`).

## Local verification

```powershell
Push-Location C:/Users/Admin/.soc-brain/worktrees/agent/poc-secure-mcp-tunnel
node --test tests/review-mcp.test.mjs
Pop-Location
```

Expected: 6 tests / 6 pass.

## MCP launch command (what `--mcp.command` points at)

```powershell
node "C:/Users/Admin/.soc-brain/worktrees/agent/poc-secure-mcp-tunnel/packages/review-mcp/review-mcp.mjs"
```

## Connect to the tunnel (one line; secrets via env vars, never inline)

Tunnel display name `Soc_brain Review Tunnel` is assigned when the tunnel is created
(one-time, via Tunnels management) and yields a `tunnel_...` id. The run command
references that id and the API key through environment variables only.

```powershell
tunnel-client run --mcp.command "node `"C:/Users/Admin/.soc-brain/worktrees/agent/poc-secure-mcp-tunnel/packages/review-mcp/review-mcp.mjs`"" --control-plane.tunnel-id $env:CONTROL_PLANE_TUNNEL_ID --control-plane.api-key env:CONTROL_PLANE_API_KEY
```

Set the secrets first (outside this repo / from a secret store):

```powershell
$env:CONTROL_PLANE_TUNNEL_ID = "<tunnel_...id>"
$env:CONTROL_PLANE_API_KEY = "<api-key>"
```
