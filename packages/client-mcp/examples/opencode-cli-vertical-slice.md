# OpenCode CLI vertical slice — client/operator UX contract (post-#175)

OpenCode (or any MCP client) is the operator **UI/client**, never the lifecycle
authority. This is the baseline CLI UX — no new UI, no custom copy button. Every
step is one `soc.*` tool call on the same stdio MCP surface that
`packages/client-mcp/client-mcp.mjs` exposes; OpenCode's existing
"copy last message" shortcut is enough to hand the final packet to offline review.

## Flow → tool mapping (OpenCode is a thin client)

| operator intent | OpenCode action | canonical effect |
|---|---|---|
| submit a goal | `soc.submit_goal { targetRepo, localCheckoutPath, goal, [issueNumber\|clientRequestId] }` | `taskStart` admission → ONE canonical task/session on disk; client is NOT the mutation owner; a **lane-bound** control-plane admission routes the task to the canonical executor launch via `routeExecutor` → `executor-launcher.startExecution` (an unbound interactive client stays admitted-only and spawns nothing) |
| read state | `soc.get_task { repo, issueNumber }` | read-only `projectSession` (redacts lease token + absolute paths) |
| watch progress / liveness | `soc.get_progress { repo, issueNumber }` | read-only loop tail + step telemetry + `reconcileExecutorLiveness` (PID + Win32 PROCESS_START_TIME; never infers RUNNING) |
| answer a Human Gate | `soc.answer_human_gate { repo, issueNumber, checkpointAt, response }` | relay through `runtime-sandbox.answerHumanGate`; exact checkpoint; accepted once |
| request review | `soc.request_review { repo, issueNumber }` | NON-authoritative handoff projection; carries no verdict |
| authorize merge (human) | `soc.authorize_merge { repo, issueNumber, pullRequest, reviewedHeadSha, authorizedBy, clientRequestId }` | writes the exact HEAD-bound record `delivery.mergePr` consumes; performs NO merge |

## Client death / reconnect contract (the point of this slice)

- The client surface is **stateless**: all task/session/execution state is
  canonical, on disk (`~/.soc-brain/state`). Closing, killing, or restarting the
  OpenCode process loses only the **transport**, never the **lifecycle**.
- `client-mcp.mjs` spawns no children and registers no liveness lease; the real
  executor is launched by the control plane as an **independent sibling process**,
  so a client death cannot cancel it and cannot mint a second mutation owner.
- A fresh OpenCode process reconnects with `{ repo, issueNumber }` and recovers the
  SAME task / session / identity / owner / execution / Human-Gate checkpoint.
- Post-#181: the canonical reattach seam is `soc.recover` (call it with NO
  arguments to attach to the single active task — no identity re-entry; with two+
  active tasks it fails closed and demands the exact `{repo, issueNumber}`).
  OpenCode 1.18.x has no per-server runtime restart, so "RESTART MCP" = quit and
  relaunch OpenCode: the adapter respawns from config; the task/executor never
  restart. Full operator procedure: `packages/client-mcp/README.md` →
  "OPERATOR RECOVERY PROCEDURE".
- Proof is process-backed, not mocked:
  `tests/client-mcp-process-lifecycle.test.mjs` drives `soc.submit_goal` through the
  production route seam, so **`startExecution` (production code)** launches a real
  executor OS process and creates the canonical `ExecutionRecord` + sets
  `executionMode='executor'` (the test fabricates neither); it then kills a real
  client-mcp OS process, shows the executor survives, and reconnects from a fresh
  client-mcp OS process to the SAME task/session/identity/owner/execution/PID.

## Offline-review final message (reuse, do not rebuild)

When the loop reaches a review state, the operator's final message is ONE
copyable block. It reuses the canonical handoff sections
(`packages/review-ready` → REVIEW HANDOFF CONTRACT: scope / codeEvidence /
findingResolution / tests / verification / safety / unverifiedRisks / delivery);
this template is the same content re-labelled for offline reading, so no separate
packet framework is introduced:

```
PACKET_IDENTITY:      <repo>#<issue> · identityHash=<h> · taskId=<id> · headSha=<sha> · PR=<pr>
REVIEW_MODE:          reviewOnly | full            (canonical review mode; client never sets PASS)
SCOPE:                <what this change touches; what is explicitly out of scope>
IMPLEMENTATION_SUMMARY:<files/symbols changed; the minimum diff>
ACCEPTANCE_MAPPING:   <A1..An -> file:test -> observed result>
SOURCE/DIFF EVIDENCE: <git diff --check result; diffstat; HEAD before/after>
TEST EVIDENCE:        <targeted test commands + pass counts; full-suite result>
KNOWN_LIMITATIONS:    <honest gaps; anything only logic- (not process-) backed>
READY_FOR_FINAL_REVIEW: <yes|no>   (never self-approved; never claims GPT/reviewer PASS; no merge)
```

Authority invariants unchanged: the client cannot terminalize, cannot merge,
cannot set a review verdict, cannot become the mutation owner, and cannot synthesize
Human-Gate approval. Review/merge gates and #157/#160/#167 lifecycle behavior stay
exactly as the canonical control-loop defines them.
