# client-mcp — Soc_brain client control surface (Issue #175)

Use an existing **Cline** or **OpenCode** (or any MCP) client as the human-facing
UI for Soc_brain **without building a separate launcher/UI**. Soc_brain remains
the sole lifecycle authority; the client only submits goals, observes progress,
relays Human-Gate answers, requests review, and records explicit merge
authorization.

```
Human → Cline UI | OpenCode TUI | thin CLI
      → MCP/local control surface   (this package: stdio JSON-RPC MCP)
      → Soc_brain canonical task/session/control-loop
      → executor routing (OpenCode/Cline/other)
```

Closing / restarting the client **never** terminates or loses the task: the
surface is stateless and every capability reads/writes the canonical persisted
state (`~/.soc-brain/state`), so a second client reconnects to the same task.

## Modules

- `client-mcp.mjs` — stdio MCP server (transport only). `node packages/client-mcp/client-mcp.mjs`.
- `client-control.mjs` — the reusable, dependency-injectable control core that
  maps each capability onto an EXISTING canonical primitive. Shared by Cline and
  OpenCode — there is no second, client-specific API.

## Reused canonical primitives (no parallel abstraction)

| capability | maps to |
|---|---|
| `soc.submit_goal` | `safe-git` repo identity → `task-intake/local-task-allocator` → `runtime-sandbox.taskStart` → `workspace.provision` |
| `soc.get_task` | `task-intake.readCanonicalTask` / `runtime-sandbox.readSessionRecord` |
| `soc.get_progress` | `control-loop.readTransitions` + `task-progress.readProgressRecord` + `executor-launcher`/`executor-reconcile.reconcileExecutorLiveness` (#160) |
| `soc.answer_human_gate` | **new** canonical seam `runtime-sandbox.answerHumanGate` (the resume edge the client relays) |
| `soc.request_review` | read-only projection of the canonical review handoff (no verdict) |
| `soc.authorize_merge` | exact `{repository,issue,pullRequest,reviewedHeadSha}` validation against the authoritative session (mirrors `control-loop/delivery` binding); records an authorization — performs **no merge** |
| `soc.cancel_task` | **fails closed** — no canonical cancellation path exists to reuse |

## Authority model — what the client CANNOT do (enforced in `client-control.mjs`)

- Cannot terminalize (`taskFinish`/`taskBlock` are unreachable from this surface).
- Cannot merge (no `delivery`/`mergePr`/`gh pr merge` reachable).
- Cannot set review PASS (no verdict parameter exists).
- Cannot become the mutation owner (admission binds the control-plane lane from
  trusted config, never caller input; observation is read-only; the single-owner
  gate `#145` rejects a second lane).
- Repo identity is **explicit** (`targetRepo` + `localCheckoutPath`, origin must
  match) — there is **no `process.cwd()` fallback** once a canonical repo is known.
- Stale task / session / checkpoint / HEAD binds fail closed.
- Mutating calls are idempotent / reconcile-safe (`clientRequestId` ledger +
  state-guard exactly-once + create-only records). No blind retry.

## Configuration (trusted — set by the control plane that LAUNCHES the server)

| env | meaning | default |
|---|---|---|
| `SOC_CONTROL_STATE_DIR` | canonical control-plane state dir | `~/.soc-brain/state` |
| `SOC_CONTROL_WORKTREES_ROOT` | canonical worktrees root | `~/.soc-brain/worktrees` |
| `SOC_CONTROL_LANE` | mutation-owner lane a control-plane admission binds (the client is never the owner; leave unset for an unbound admission) | unset (unbound) |

Tool callers never supply these.

## Cline (client)

Register `client-mcp.mjs` as a stdio MCP server (see
`examples/cline-mcp_settings.example.json` → merge into Cline's
`mcp_settings.json`). Then type a normal goal; Cline calls `soc.submit_goal`
against a disposable/external repo instead of executing the product task itself.
Cline acting as client has no lifecycle authority (it may separately be chosen
as an *executor* later — different surface, `executor-launcher`).

## OpenCode (client)

Same contract, no OpenCode-specific API — see
`examples/opencode-config.example.json` (OpenCode `mcp` local-server block). If a
thin adapter is wanted, it must just forward to this same local surface.

## Human Gate

1. The **executor** (not the client) reaches `HUMAN_GATE_REQUIRED` via the
   broker tool `soc_broker_request_human_gate`.
2. A client `soc.get_task` shows `humanGate.at` (the checkpoint) + note.
3. The client `soc.answer_human_gate` **relays** the human's reply with the exact
   `{repo, issueNumber, checkpointAt}`. The canonical seam transitions the
   session back to `SESSION_ACTIVE` (the ControlLoop resume precondition) and
   stores the reply as DATA. Accepted exactly once; stale/wrong/duplicate → fail
   closed. The client cannot synthesize approval or skip verification/review.

## Review / merge authorization

- `soc.request_review` is non-authoritative: it returns the review handoff bound
  to `{repository, issue, pullRequest, headSha}` and carries **no verdict**.
  PASS/REWORK/BLOCKED come only from the reviewer / GPT-final surfaces.
- `soc.authorize_merge` records an explicit human authorization bound to exact
  `{repository, issue, pullRequest, reviewedHeadSha}` after validating it against
  the authoritative session (`HEAD_STALE` / `PR_MISMATCH` / foreign repo →
  rejected). It performs **no merge**. The canonical delivery leg stays the only
  merge executor and requires a validated PASS at the same exact head.

## Tests

`node --test tests/client-mcp.test.mjs` — A1 admission, A2 external execution,
A3 reconnect, A4 Human Gate, A5 merge authorization, A6 client-death,
A7 cross-project safety, the cancel fail-closed case, repo-identity resolution,
the raw `answerHumanGate` seam, the MCP wire round-trip, and the full
vertical-slice E2E. Deterministic disposable git fixtures (github.com origin), no
gh / network / real executor.

## Known limitations (honest scope)

- **No cancel.** No canonical cancellation path exists; `soc.cancel_task` fails
  closed rather than inventing a lifecycle. The nearest terminals
  (`taskFinish(FAILED)` / `taskBlock(BLOCKED)`) are lifecycle authority the client
  must not hold.
- **Merge-authorization consumption.** `authorize_merge` records + validates an
  exact-head human authorization but the canonical `delivery` leg currently
  self-merges on a validated PASS (structural authorization). Wiring delivery to
  *require* an external authorization record is deliberately NOT done here to
  avoid regressing #159/#161. Documented, not silently half-wired.
- **External-repo delivery.** Canonical review/delivery/merge is bound to the
  Soc_brain repo (like `run.js` / `DELIVERY_CANONICAL_REPO`). External repos are
  admitted + executed (Phase A2/A7) but terminate via session lifecycle, not the
  auto-delivery leg. `authorize_merge` rejects a foreign repo.
- **Loopback/local only.** stdio transport; no remote/public control API.
