# Soc_brain Master Roadmap v2 — Bootstrap to Self-Improvement

Status: Khung roadmap v2 được Bố duyệt ngày 2026-09-29; sẵn sàng giao thi công P0. File đã được theo dõi trong Git (`docs/MASTER_ROADMAP_v2.md`); câu "chưa nhập vào Git repo" ở bản 2026-09-29 không còn đúng.
Date: 2026-10-06
Last synchronized (historical record): 2026-09-27 (Issue #155 / PR #156, HEAD 0a1c202)
Last synchronized (GitHub read-back): 2026-10-06 (vòng 2) — remote main `d6f01c8766a4df91ae25a71ee2c70f0cba51da51`; chi tiết tại mục 21
Source audit: remote HEAD `b10498176add3d6662091894af21a683b129ac87` tại 2026-09-29; chỉ đọc, không chạy runtime trên Windows, không push/merge.
North Star: `docs/NORTH_STAR_v2.1.0.md`

**Cách đọc:** Các mục PR/test có ngày ở phần cũ là bằng chứng lịch sử cho đúng commit được ghi, không mặc nhiên xác nhận trạng thái hiện tại. Đối chiếu hiện trạng và thứ tự thực thi tại mục 13–17. Các nhãn `IMPLEMENTED`, `INTEGRATED` trong mục mới dựa trên mã nguồn; `REAL_E2E_PROVEN` chỉ dùng khi có log chạy thực tế đúng HEAD.

## 1. Decision

North Star v2.1.0 remains the strategic baseline. The product thesis and authority model do not change.

Roadmap v2 changes the execution strategy:

> **Reach a usable self-hosting Soc_brain as quickly as safely possible, then use Soc_brain to improve Soc_brain.**

The immediate objective is not a complete control plane. It is the smallest reliable loop that can perform ordinary Soc_brain source changes through Soc_brain itself.


### Spike #231: CDP Autonomous Control Loop (PR #233)
- **Status**: REAL_E2E_PROVEN (2026-09-24, SHA 34c87a7)
- **Evidence**: 777/777 offline tests pass (0 fail), FSM terminalize verified on Chrome 9222, diff bundle pr-231-diff.zip archived.
- **PR**: #233 (status:approved)

## 2. Operating principle

> **Build the smallest usable capability → prove the affected boundary → use it immediately → harden only from real evidence.**

Rules:

- usable-first, incremental hardening;
- minimum sufficient scope and process proportional to actual risk;
- do not build speculative frameworks, guards, dashboards, recovery matrices, or abstractions ahead of demonstrated need;
- do not require every known edge case to be solved before dogfooding;
- a real blocker, observed failure, or directly value-unlocking capability outranks speculative completeness;
- after the bootstrap exit, improvements to Soc_brain should normally be executed through Soc_brain itself.

## 3. Authority and evidence invariants

These remain non-negotiable:

- Soc_brain is the sole canonical lifecycle authority.
- User owns true Human Gates and explicit merge/deploy authorization.
- Executors, models, clients, UI and review transports are replaceable execution/transport components, not canonical authorities.
- Every canonical source mutation intended for Soc_brain must be admitted/owned through `soc_control`; external work is not canonical merely because it exists.
- One canonical task attempt has at most one active mutation owner.
- Exact task/repository/worktree/HEAD binding is required before mutation.
- Current canonical/read-back evidence outranks narrative, chat history and stale records.
- `SESSION_ACTIVE` is not executor liveness.
- Process/server alive is not proof that the capability is healthy.
- Exit code 0 alone is not PASS; a dead runner with zero failing assertions is not PASS.
- Unknown remains UNKNOWN. Do not invent identity, state, verdict, ownership or evidence.
- Do not blind-retry a mutation whose side effect is uncertain.
- Technical recovery is not a Human Gate when Soc_brain can safely resolve it itself.
- No self-review authority, self-merge or self-deploy.

## 4. Development mode during bootstrap

Until the Bootstrap Exit Criterion is proven:

- **one architecture-changing mutation lane at a time** for control-loop, recovery, review transport, delivery and canonical-state work;
- read-only research and Git archaeology may run in parallel;
- do not open the next mutation lane until the current minimum exit gate is proven;
- this is a temporary stabilization policy, not a permanent scheduler architecture;
- long-term scheduling remains resource-aware rather than a hard-coded small concurrency limit.

## 5. Verification policy

Do not optimize for ceremony.

Default progression:

```text
changed scope
→ targeted verification
→ related regression subset when warranted
→ one full-suite run before a high-risk handoff/final review when warranted
```

For long/process-backed tests capture real process evidence: command, PID/process identity where available, startedAt, progress/log evidence, exit code, totals and complete not-ok set.

Classify failures rather than collapsing them into FAIL:

`ASSERTION_FAILED | PROCESS_DIED | PROCESS_HUNG | PROCESS_CANCELLED | ENVIRONMENT_FAILURE | RESOURCE_CONTENTION | TRANSPORT_FAILURE | UNKNOWN`.

No blind full-suite reruns, timeout inflation, test skipping, behavior-losing mocks, or forced whole-suite serialization merely to make the run green.

## 6. Bootstrap track

The S-stages below are **minimum viable gates**, not projects that must be perfected before use.

### S0 — Canonical baseline and policy reset

Goal: establish enough canonical truth to stop building on stale assumptions.

Minimum work:

- inventory current `main` capabilities and the relevant open PRs;
- classify them as `IMPLEMENTED`, `VERIFIED`, `INTEGRATED`, `REAL_E2E_PROVEN`, `CANONICAL`, `DEGRADED`, `SUPERSEDED` or `OPEN_CANDIDATE`;
- reconcile executor-independent policy, including the R4a test-execution intent;
- treat PRs #184–#190 as candidate/evidence sources until individually adopted or superseded;
- do not merge broad overlapping PRs merely to clear backlog.

Exit: one trusted baseline and policy set sufficient to start S1. Do not spend multiple implementation cycles polishing documentation.

### S1 — Execution truth

Goal: Soc_brain must not silently misclassify executor/test-runner state.

Minimum capability:

- distinguish task state, executor state and test-runner outcome;
- prove alive/dead/exit status from real evidence;
- distinguish assertion failure from runner death/hang/cancel/environment failure;
- retain enough progress/log evidence to diagnose the observed process-backed failures.

Exit: controlled PASS, assertion-fail, hang and killed-runner cases are classified truthfully.

Stop there. Advanced resource analytics and dashboards are deferred until evidence requires them.

### S2 — Resume instead of restart

Goal: ordinary interruption does not force the user to reconstruct or restart a task.

Minimum recovery:

```text
exact canonical identity
→ mutation owner
→ exact worktree
→ real executor liveness
→ existing patch/evidence
→ smallest incomplete action
→ continue
```

Requirements:

- `SESSION_ACTIVE != RUNNING`;
- live executor → reattach/observe, never launch a second owner;
- exited executor → inspect and reuse valid work/evidence;
- ambiguous identity/ownership → fail closed;
- recoverable technical interruption should not be escalated to the user.

Exit: interrupt a real task/client/runtime component, restart the control surface, recover the same task without duplicate executor or lost patch, and continue.

### S3 — Restore usable Web2API [STATUS: REAL_E2E_PROVEN - PR #205]

Goal: restore the known-good Web2API architecture before expanding Final Review.

First perform bounded Git/local-artifact archaeology to identify the smallest reproducible known-good snapshot. Do not assume #188 or #190 is that snapshot.

Target path:

```text
Soc_brain
→ Web2API
→ Chrome / ChatGPT
→ submitted turn
→ final response
→ ChatGPT native Copy / keyboard shortcut
→ clipboard
→ Web2API
```

Health is layered: server → Chrome → CDP → owned tab → composer → submit → turn → response → copy. A healthy server/port alone is insufficient.

Initially prove only the failure/recovery cases required for practical use, especially interruption before submit, confirmed post-submit recovery without resubmit, and fail-closed reconciliation for uncertain submit. Add further recovery cases from observed failures rather than speculative completeness.

Exit: bounded live send/readback smoke passes and common interruption recovery does not create duplicate ChatGPT turns.

### S4 — Final Review transaction [STATUS: IMPLEMENTED - PR #207]

Goal: connect proven Web2API to the canonical review loop.

Minimum contract:

- fresh review interaction from canonical evidence;
- GPT Final Reviewer independently derives `PASS | REWORK | BLOCKED`;
- strict response parsing;
- exact binding:
  `repository + issue + pullRequest + headSha + requestDigest`;
- stale/mismatched/malformed responses fail closed;
- `SUBMIT_UNCERTAIN` reconciles before any retry;
- no silent CWA/other transport fallback;
- pre-review/OCR may advise but has no Final Review authority.

Selectively reuse proven parts of #188; do not require wholesale adoption of its broad changeset.

Exit: one exact-HEAD review transaction completes through Web2API with validated binding and no manual response copy/paste.

**Implementation (PR #207):**
- Created `packages/control-loop/review-payload.mjs` with `buildReviewPrompt()` and `createReviewPayload()` functions
- Full diff injection from `artifacts/diffs/pr-[PR_NUMBER]-changes.diff` into review prompt
- Structured prompt with header (PR Number, Head SHA, Timestamp), AGENTS.md rules, full diff block, verdict requirement
- Fail-closed verification: missing diff → `REVIEW_DIFF_PAYLOAD_MISSING`, empty diff → `REVIEW_DIFF_EMPTY`, oversized prompt → `REVIEW_PROMPT_TOO_LARGE`
- Added `createGeminiFinalReviewWithDiffTransport()` in `gemini-plus-web2api-copy.mjs` for safe clipboard integration with size checking
- Unit tests in `tests/review-payload.test.mjs` (15 tests covering structure, validation, fail-closed paths, AGENTS.md rule inclusion)
- All verification gates pass: `review-payload.test.mjs`, `cdp-supervisor.test.mjs`, `control-loop-gemini-web2api-copy.test.mjs`, `git diff --check`

Evidence: PR #207, commit SHA 04b273c9bd42e2039ee7f3adce3580e0a734f47a, completed 2026-09-22

**Verdict-parser auto-transition — IMPLEMENTED (PR #208):**
- Created `packages/control-loop/verdict-parser.mjs`: `parseReviewVerdict()` + `normalizeReviewDecision()` map raw `VERDICT: APPROVED|CHANGES_REQUESTED|BLOCKED` reply text (and structured JSON) to FSM `PASS|REWORK|BLOCKED`, fail-closed `VERDICT_*` codes, findings bounded 50x500
- Integrated at the single `decide()` entry seam in `control-loop.mjs` (fresh walk + rework leg + all resume paths); structured GPT decisions remain byte-identical (echoed-binding gate intact); raw REWORK binding stamped from canonical session (`metadata.source=verdict-parser`)
- Fixes structured `{verdict:CHANGES_REQUESTED}` falling through to DELIVERING; unknown verdicts fail `VERDICT_UNKNOWN`
- Tests: `tests/verdict-parser.test.mjs` (24 tests: parse/normalize unit + 4 `runControlLoop` integration)
- Stale-mock repairs (test-only): R9 rework + P0-D adapters echo `metadata.requestDigest` (pre-existing on main `3497fa3`, proven in `artifacts/baseline-pre-existing-failures.log`)
- Baseline debt opened as separate Issue: `control-loop-gemini.test.mjs` TypeError + SR13b load-flake (not touched here, R4)

Evidence: PR #208, commit SHA 136f67d736eb88ac9f3a46f6f57ad838a382845b, completed 2026-09-22

**Baseline debt Issue #209 — DETERMINISTIC_VERIFIED (PR #210):**
- `tests/control-loop-gemini.test.mjs` D5: stale mock replies lacked the always-on `metadata.requestDigest` echo → `GPT_REQUEST_DIGEST_MISMATCH` → `runControlLoop` returned no `value` → TypeError at the BLOCKED assertion. Fix: `digestEchoTransport` echoes the prompt digest + `res.value && res.value.state` guard (D8o pattern). Test-only; fail-closed product path unchanged.
- `tests/client-mcp-supervisor.test.mjs` SR13b: adapter-written `transport.json` observable before parent handshake set `f.current` → `'no live adapter'` race under parallel load. Fix: bounded `until(() => Boolean(f.current), 30000)` before manual `soc.recover`. Test-only sequencing; process cleanup contract unchanged.
- Untracked-file check (`git status --short`) clean (no debug residue).
- Verification (offline): targeted gemini PASS (exit 0); `cdp-supervisor.test.mjs` 21/21; regression subset 24/24; full suite **671/671 pass, 0 fail, 0 unhandledRejection, not-ok=0**, 548114ms (`$env:TEMP\opencode\issue209-full-final.log`); `git diff --check` exit 0.
- R5: `artifacts/diffs/pr-210-changes.diff` + `artifacts/diffs/pr-210-diff.zip` (against `origin/main`).

Evidence: PR #210, commit SHA f1cb8e3a8d1964541250cbf931de15db3e634075, completed 2026-09-22

**soc_control orchestrator agent + runner CLI — IMPLEMENTED (PR #211):**
- Created `.opencode/agents/soc_control.md`: primary Orchestrator agent (`mode: primary`; `edit: deny` with bash/read/glob/grep allow) documenting the ControlLoop FSM orchestration role and R2 authority boundary
- Created `bin/soc-control-loop.mjs`: runner CLI integrating `runControlLoop`, `verdict-parser` (`normalizeReviewDecision`), and `review-payload` (`createReviewPayload`); Human Gate delivery adapter returns `HUMAN_GATE_AWAITING_MERGE` so APPROVED stops at `DELIVERING` (`SESSION_ACTIVE`) and never reaches `COMPLETED` without explicit human merge authorization; `CHANGES_REQUESTED` auto re-dispatches REWORK via the FSM (bounded by `MAX_REWORK_ROUNDS`)
- Created `tests/soc-control-agent.test.mjs`: 10 tests — agent frontmatter/config validation, `parseArgs`, offline E2E APPROVED→Human-Gate DELIVERING, offline E2E CHANGES_REQUESTED→REWORK→APPROVED→DELIVERING, fail-closed unparseable verdict, arg validation
- Verification (offline): targeted `soc-control-agent.test.mjs` 10/10; regression `verdict-parser` 24/24, `control-loop-rework` 9/9, `control-loop-gemini` 124/124; full suite **681/681 pass, 0 fail, not-ok=0**, exit 0, 621s (`artifacts/logs/full-suite-20260922-213245.log`); `git diff --check` exit 0
- R5: `artifacts/diffs/pr-211-changes.diff` (25369 bytes) + `artifacts/diffs/pr-211-diff.zip` (7249 bytes) against `origin/main`

Evidence: PR #211, commit SHA 7e7fdf2b2e01c16bd23a671c758840cb2b5eabd0, completed 2026-09-22

**Granular FSM milestone Telegram telemetry — DETERMINISTIC_VERIFIED (PR #213):**
- Extended `packages/telegram-dispatch/telegram-dispatch.mjs`: `NOTIFIABLE_EVENTS` += `ROUTED, EXECUTING, VERIFYING, FINAL_REVIEWING, DECIDING, DELIVERING`; human-first `HUMAN_TEMPLATES` with distinct icons (🚀 ⚙️ 🧪 🔍 ⚖️ 🛑)
- Added `GRANULAR_MILESTONE_EVENTS` export + fail-safe `dispatchGranularMilestone()` in `packages/control-loop/control-loop.mjs` (never throws into FSM; persists truthful `NOT_ATTEMPTED`/`DELIVERY_FAILED` evidence only)
- `bin/soc-control-loop.mjs` parseArgs: `--telegram-config` / `--telegram-spawn` injectable transport seams
- New offline suite `tests/telegram-telemetry.test.mjs` (15 tests): contract surface, icon/identity formatting + HTML-escape/bounds, FSM sample-chain walk dispatches all 6 in order via mocked spawn (intent+result ledger), transport resilience (throwing + HTTP 429 never escape dispatch; FSM reaches `COMPLETED` with all 6 sends failed), dedupe after `API_ACCEPTED`, fail-closed identity/not-notifiable gates
- Legacy `tests/telegram-dispatch.test.mjs` A0 assertion updated for 13 events (7 legacy + 6 granular)
- Verification (offline, exit 0): `telegram-telemetry` 15/15; `telegram-dispatch` 131/131; `soc-control-agent` 10/10; `verdict-parser` 24/24; `git diff --check` exit 0 (logs: `artifacts/regression-*.log`)
- R5: `artifacts/diffs/pr-213-changes.diff` + `artifacts/diffs/pr-213-diff.zip` against `origin/main`

Evidence: PR #213, commit SHA dc4f1e6, completed 2026-09-22

**Supervisor Reactive Engine + Drift Guard — DETERMINISTIC_VERIFIED (PR #215):**
- Created `packages/supervisor/reactive-engine.mjs`: EventEmitter-driven zero-latency FSM chain (`ROUTED -> EXECUTING -> VERIFYING -> FINAL_REVIEWING`); every hop persists `transitions.jsonl` with read-back before success is claimed; no sleep/setInterval polling; budget `ZERO_LATENCY_BUDGET_MS = 200`; `onTransition`/`onExecutionFinalized`/`onBlocked` hooks; illegal transition or failed ledger write blocks fail-closed
- Created `packages/supervisor/drift-guard.mjs`: `checkScope` → `OUT_OF_BOUNDS_MUTATION` (or `SCOPE_UNDECLARED` fail-closed); `captureTestBaseline`/`checkTestIntegrity` → `TEST_INTEGRITY_VIOLATION` on deleted test files, removed test cases, or weakened asserts; `createBehaviorGuard` → `THRASHING_NO_OP` (>3 identical glob/read with no new code) and `STUCK_NO_IMPROVEMENT` (>3 fix attempts without fail-count reduction)
- Created `packages/supervisor/integrity-audit.mjs`: 3-way reconciliation (Session Record == Transition Ledger tail == Disk Evidence worktree HEAD) before each transition; any mismatch/missing source returns `ok:false` and the reactive engine transitions to `BLOCKED`
- New offline suite `tests/supervisor-reactive-guard.test.mjs` (21 tests): Group A reactive chain latency/event order, Group B scope + test-integrity, Group C anti-loop/thrashing, Group D 3-way fail-closed
- Verification (offline, exit 0): `supervisor-reactive-guard` 21/21; regression subset `telegram-telemetry` 15/15, `telegram-dispatch` PASS, `soc-control-agent` 10/10, `verdict-parser` 24/24; full suite **717/717 pass, 0 fail, not-ok=0** (`artifacts/full-suite-20260922-235949.log`); `git diff --check` exit 0

Evidence: PR #215, commit SHA 117b05b, completed 2026-09-23

**CL-GEMINI-PRIMARY-REVIEWER: standardized Gemini Web2API final reviewer + evidence-packed Diff-First review payload — DETERMINISTIC_VERIFIED:**
- `packages/control-loop/review-payload.mjs`: `buildReviewPromptForSession({session,testLog,bundleInfo,diff})` — 5-block prompt ([TASK CONTEXT] → [DELIVERY ARTIFACTS VERIFICATION] → [TEST SUITE EXECUTION EVIDENCE] → [DIFF CONTENT] → [INSTRUCTION TO REVIEWER]); fail-closed empty/whitespace/non-string diff → `{ ok:false, code:'EMPTY_DIFF_CONTENT', verdict:'BLOCKED' }` (new `REVIEW_PAYLOAD_CODES.EMPTY_DIFF_CONTENT`); Diff-First 2-part response contract (`DIFF ANALYSIS & CODE INSPECTION` mandatory then `FINAL VERDICT` as the single last `VERDICT:` line, compatible with `parseReviewVerdict`); R9 split-authority rule spelled out (roadmap outside executor whitelist ≠ BLOCKED; inside expanded whitelist = part of handoff)
- `packages/control-loop/gemini-plus-web2api-copy.mjs`: `createGeminiWeb2ApiReviewTransport` defaults `cdpPort 9222 / 127.0.0.1`; CDP polling extraction loop (2s poll, 3s stability, 120s timeout → `REVIEW_TIMEOUT` + fail-closed `BLOCKED`); streaming-safe readiness poll (180s) + footer copy button (loại trừ nút copy code) + `.message-content` innerText-first; verdict via `parseReviewVerdict()` fail-closed
- `bin/soc-control-loop.mjs`: default final reviewer = Gemini Web2API transport, LAZY-initialized on first real review call (`deps.finalReview || (await createGeminiWeb2ApiReviewTransport(...))`) — no CDP/browser construction on mocked runs; wrapper packages `buildReviewPromptForSession` into `reviewPrompt`/`prompt`, degrades to `null` offline → transport fail-closes
- Verification (offline, exit 0): `review-payload` 15/15; `control-loop-gemini-web2api-copy` 31/31; `soc-control-agent` 12/12; full suite **719/719 pass, 0 fail, 0 unhandledRejection, not-ok=0** (`artifacts/full-suite-test-2.log`); `git diff --check` exit 0
- R5 bundle: `artifacts/diffs/pr-gemini-reviewer-changes.diff` + `artifacts/diffs/pr-gemini-reviewer-diff.zip` (regenerated against `origin/main` after final commit)

Evidence: task CL-GEMINI-PRIMARY-REVIEWER, commits 07daa39 + cae1858 + 54ce207 + f3914c2, completed 2026-09-23

### S5 — Bootstrap Exit: one real autonomous delivery [STATUS: INTEGRATED - PR #229]

Goal: prove Soc_brain is useful enough to develop itself.

Required real flow:

```text
user goal
→ canonical admission
→ isolated worktree
→ executor
→ deterministic verification
→ Web2API Final Review
→ automatic REWORK loop when needed
→ PASS
→ AWAITING_HUMAN_MERGE_DECISION
→ explicit human authorization
→ delivery
→ read-back
→ close/sync/cleanup
→ COMPLETED
```

During the proof, ordinary client/control interruption must not require the user to remember PID, worktree, session, manually poll state, recreate the task, or manually transfer the review.

**Bootstrap Exit Criterion:**

> Soc_brain is reliable enough that an ordinary Soc_brain source improvement can be implemented, verified, reviewed and delivered through Soc_brain itself, with the user involved only for genuine Human Gates and merge/deploy authority.

At this point stop infrastructure-first development and dogfood.

**Telegram dispatch stability hardening — INTEGRATED - IN_PROGRESS (PR #226):**
- Added an invariant FIFO dispatch gap of 400 ms using synchronous `Atomics.wait`; environment values cannot weaken the production minimum.
- Added entity-safe and UTF-16-safe Telegram bounding for `&amp;`, `&lt;`, `&gt;`, and surrogate pairs before delivery.
- Added bounded worker retries with delays `[1000, 2000, 4000]`: only HTTP 429 and classified transient network errors retry; each request has a hard 5-second `AbortSignal.timeout`, timeout returns `DELIVERY_FAILED` without retry, and the import-safe main guard supports offline tests.
- Verification (offline, exit 0): `telegram-dispatch` 164/164; `telegram-telemetry` 27/27; `soc-control-agent` 12/12; `supervisor-reactive-guard` 21/21; full `tests/*.test.mjs` 731/731 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo; `git diff --check` exit 0.
- R5 handoff bundle is generated from `origin/main` for PR #226.

Evidence: PR #226, commit SHA 83b7ed018e00c6cb07c0edef9cafe7b8b401e6d9, completed 2026-09-23

**Task Bootstrapper hardening (real-PR chicken-egg fix) — DETERMINISTIC_VERIFIED - IN_PROGRESS (PR #227):**
- New `scripts/Invoke-SocTask.ps1` inherits the existing `bin/soc-task-bootstrap.mjs` flow and closes the chicken-and-egg PR trap in fail-closed order: clean-primary check → `checkout -b` → `git commit --allow-empty -m "chore: initialize task under AGENTS.md"` → `git push -u origin <branch>` → `gh pr list` resume probe else `gh pr create` → `gh pr edit <PR> --add-label "status:in-progress"` → restore primary ref → isolated `git worktree add worktrees/<task-name>` → `SOC_TASK_CONTRACT.md` + `TASK_PROMPT.md` rendered with the REAL PR number (runtime guard rejects any bracketed placeholder, so `[SỐ_PR]`-style tokens cannot reach the worktree). Parameters `-Goal` (required), `-IssueNumber`, `-Base` (default `origin/main`); branch/task forms `task/<goal-slug>-<yyyyMMdd-HHmmss>` or `fix/issue-<id>-<goal-slug>` (NFD diacritic-stripping slug); ASCII-only script source + UTF-8-no-BOM writes run identically on PowerShell 5.1 and pwsh with explicit `$LASTEXITCODE` checks (exit 2 bad args / exit 1 step failure); `-DryRun` emits a JSON plan with zero git/gh processes; no force-push path; never self-applies `status:approved`/`status:blocked`.
- New offline regression `tests/task-bootstrapper.test.mjs` (12 tests): source invariants, slug/branch unit rules (dot-sourced), DryRun contract rendering, fail-closed argument exits, full PATH-shadowed mock flow asserting the exact chicken-and-egg ORDER (empty commit → push → PR create → label → restore → worktree → contracts with PR 4242), dirty-primary fail-closed, existing-PR resume without duplicate create, Windows PowerShell 5.1 smoke.
- Verification (offline, exit 0): `task-bootstrapper` 12/12 (`artifacts/task-bootstrapper-test.log`); regression gates `telegram-dispatch` file-level 1/1, `telegram-telemetry` 27/27, `soc-control-agent` 12/12, `supervisor-reactive-guard` 21/21; exactly one full `tests/*.test.mjs` run → **743/743 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo, not-ok=0** (`artifacts/full-suite-test-2.log`, PID 20960, 641105 ms); `git diff --check` exit 0.
- R5 handoff bundle: `artifacts/diffs/pr-227-changes.diff` + `artifacts/diffs/pr-227-diff.zip` (generated against `origin/main`).

Evidence: PR #227, commit SHA 58ce795056efb6db861d4d71ecd1e8993abf577c, completed 2026-09-24

**Task Bootstrapper → ControlLoop autonomous intake — INTEGRATED (PR #229):**
- New `packages/control-loop/task-ingestion.mjs`: `buildBootstrapperArgs` (always prefixes safe PowerShell flags `-NoProfile -NonInteractive -ExecutionPolicy Bypass -File`), `parseBootstrapOutput` (BOOTSTRAP_OK → prNumber/branch/worktreePath/contract/prUrl), `classifyBootstrapFailure` (PRIMARY_DIRTY / STEP_FAILED(network gh) / BAD_ARGS / FAILED / SPAWN_ERROR / EXIT_NONZERO), `runTaskBootstrapper` (async `child_process.spawn` with injectable offline `spawnImpl`), `assignBootstrapToSession` (ownership-safe write of `session.prNumber`/`branch`/`worktreePath` + `controlLoop.bootstrapper` evidence with previous-value audit, read-back verified), `ingestGoalViaBootstrapper` (spawn → parse → assign orchestration); structured fail-closed JSONL logs to `<stateDir>/logs/task-ingestion.jsonl` (`TASK_INGESTION_FAILED` / `TASK_INGESTION_OK`)
- `bin/soc-control-loop.mjs`: new opt-in `--bootstrap` / `--no-bootstrap` CLI flags and `bootstrap` option on `runSocControlLoop` — when a NEW Goal arrives with bootstrap enabled, the control loop itself invokes `scripts/Invoke-SocTask.ps1` and assigns PR/branch/worktree directly onto the Session lease (no manual operator bootstrap); any bootstrapper error stops intake BEFORE the FSM with a structured `BOOTSTRAP_*`/`SESSION_*` code (fail-closed, session untouched)
- Tests (offline, 0 network): `tests/soc-control-agent.test.mjs` Group H (+9: parseArgs flags, safe-flag argv, BOOTSTRAP_OK parse, failure classification, E2E mock-spawn intake→lease assignment→FSM Human Gate, exit≠0 fail-closed with structured log + no FSM, missing-goal gate, unparsable stdout no-write, missing-session gate → **21/21**); `tests/task-bootstrapper.test.mjs` Group I (+8: safe-flag argv, parse, classify, runTaskBootstrapper mock-spawn success/dirty/spawn-error/unparsable, lease assignment with previous-value audit, dirty no-touch session, assign validation, **PATH-shadow E2E** spawning the REAL `Invoke-SocTask.ps1` offline via mock git/gh → session gets pr 4242/branch/worktree → **20/20**)
- Verification (offline, exit 0): `task-bootstrapper` 20/20; `soc-control-agent` 21/21; `telegram-dispatch` PASS; `telegram-telemetry` 27/27; exactly one full `tests/*.test.mjs` run; `git diff --check` exit 0
- R5 handoff bundle: `artifacts/diffs/pr-229-changes.diff` + `artifacts/diffs/pr-229-diff.zip` (against `origin/main`)

Evidence: PR #229, commit SHA bb56a80bc42aa88b65a4d103d726ba8875cf4382, completed 2026-09-24

**Autonomous CDP supervisor + Telegram self-healing dispatch — DETERMINISTIC_VERIFIED (PR #230):**
- `packages/control-loop/cdp-supervisor.mjs`: settled-latch idempotent `waitForDomReady` + `createTargetViaWs` (fixes stack overflow on repeated poll); fail-fast WS error/close; `ensureChromeRunning({force})` + force-restart for `OPERATION_HANG` in tier-B recovery; port 9222; `/json` primary + `/json/version` fallback; isolated Chrome profile at `os.tmpdir()/soc-brain-cdp-profile`; injectable `spawnImpl`/`WebSocketImpl` seams; WS `Target.createTarget` + HTTP `/json/new` fallback; 2-tier recovery with `backoffFor(attempt) = min(base * 2^attempt, 30000)`
- `packages/telegram-dispatch/telegram-worker.mjs`: `readConfig` resolution order = explicit `configPath` > env `TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID` (both required) > `AI_PR_REVIEWER_TG_CONFIG` > `~/.ai-pr-reviewer/tg.json`; export `telegramHealthcheck(configPath)` → `{ok, status, hasToken, hasChatId}` (no network, no token leak)
- `packages/telegram-dispatch/telegram-dispatch.mjs`: durable JSONL spool at `stateDir/telegram-spool/pending.jsonl`; parks ONLY transient `DELIVERY_FAILED` (`HTTP_429`/`NETWORK_ECONNRESET`/`NETWORK_ETIMEDOUT`); `TELEGRAM_SPOOL_MAX_ITEMS=200`, `MAX_PER_FLUSH=5`, `BACKOFF_BASE_MS=5000`; re-entrancy guard `spoolFlushInProgress`; flush piggybacked AFTER the gate check (gated dispatch never flushes/spawns); `NOT_ATTEMPTED` stays ledger-only (no budget burn); no background loop (Issue #65 req 10)
- `packages/control-loop/control-loop.mjs`: `dispatchGranularMilestone` → `allowNonCanonicalStateRoot: Boolean(spawn)`; `bindLoop` gains fail-soft `onTransition` param (observer throw never breaks the FSM); `runControlLoop` wires `milestoneObserver` gated by `deps.telegramMilestones === true`
- `bin/soc-control-loop.mjs`: lazy CDP supervisor wiring in `finalReviewInner` — `createCdpSupervisor({port:9222})` → `ensureChromeRunning()` → `ensureTargetPage({urlPattern:/gemini\.google\.com/})` → fail → `{ok:false, code:CDP_SUPERVISOR_UNAVAILABLE|CDP_TARGET_UNAVAILABLE, verdict:'BLOCKED'}` fail-closed → `createGeminiWeb2ApiReviewTransport({cdpPort:9222, host:'127.0.0.1'})`; `runDeps.telegramMilestones = deps.telegramMilestones !== false`
- Tests (offline, 0 network): `tests/cdp-supervisor.test.mjs` 36/36 (settled-latch recursion fix + spawn/crash/recover chain); `tests/telegram-dispatch.test.mjs` +block S (spool: 429→parked, backoff skip, force-due→flush→empty, HTTP_502 not spooled) + block W (healthcheck shape/no-leak/env-pair/half-env) + C2 isolation (fake home/env so explicit bad configPath cannot fall through to a real token) → **198/198**; `tests/telegram-telemetry.test.mjs` +C4a/C4b (bindLoop onTransition fail-soft / zero-cost) → **29/29**
- Verification (offline, exit 0): `cdp-supervisor` 36/36; `telegram-dispatch` 198/198; `telegram-telemetry` 29/29; `task-bootstrapper` 20/20; `soc-control-agent` 21/21; `control-loop` 28/28; `control-loop-delivery` 12/12; full suite first run 776/777 with one known-flaky `client-mcp-supervisor` SR1 race (file not in this PR diff) → targeted diagnosis → exactly one full rerun **777/777 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo, not-ok=0** (`artifacts/full-suite-test-rerun.log`, 1101614 ms); `git diff --check` exit 0
- R5 handoff bundle: `artifacts/diffs/pr-230-changes.diff` + `artifacts/diffs/pr-230-diff.zip` (against `origin/main`)

Evidence: PR #230, commit SHA ee3dcc0, completed 2026-09-24

**OpenCode Sandboxed MCP Bridge & Unified CDP Supervisor — DETERMINISTIC_VERIFIED:**
- `.opencode/agents/build.md`: Mở khóa thẩm quyền `mcp: allow` cho Executor thi công trong Worktree, cho phép sử dụng trọn vẹn bộ tool Broker an toàn (`soc_broker_status`, `soc_broker_diff`, `soc_broker_run_registered_test`, `soc_broker_commit`).
- `.opencode/agents/soc_control.md`: Thiết lập Command Execution Protocol chuẩn mực, phân định rạch ròi vai trò Orchestrator (`edit: deny`, `bash: allow`) giúp Bố điều phối toàn bộ guồng máy trực tiếp 100% từ giao diện OpenCode.
- `bin/soc-control-loop.mjs`: Sắp xếp lại thứ tự kiểm tra và tự động khởi tạo Session lease hợp lệ trước khi kích hoạt `--bootstrap`, triệt tiêu hoàn toàn lỗi `SESSION_NOT_FOUND` khi tiếp nhận Goal mới toanh.
- `packages/control-loop/chatgpt-plus-web2api-copy.mjs`: Chuẩn hóa đồng bộ cổng kết nối CDP supervisor từ 9224 về cổng mặc định duy nhất 9222, thống nhất toàn bộ transport review (Gemini Web2API lẫn ChatGPT fallback) trỏ chung vào Chrome supervisor.
- Verification (offline, exit 0): `soc-control-agent` 21/21, `task-bootstrapper` 20/20, `control-loop-gemini-web2api-copy` 31/31, `control-loop-web2api-copy` 50+/50+; `git diff --check` exit 0.

Evidence: task OPENCODE-SANDBOX-MCP-INTEGRATION, completed 2026-09-25

**Backlog Triage and Audit Report - INTEGRATED:**
- Deliverable: `docs/backlog-triage-audit.md` (new, 223 lines) - read-only audit classifying all 16 OPEN Issues + 19 OPEN PRs (7 draft) against `NORTH_STAR_v2.1.0` and Roadmap section 9; deviation findings (PR #186 carrying the #185 changeset, twin PRs #221/#222, #189 is an Issue, flaky SR11b #218); P0/P1/P2 proposals. Zero remote mutations (no close/merge/label).
- ControlLoop end-to-end (local task #9000023, head `737670206835603f9a6693fea89a6fd06cc6d5d2`): executor `opencode/mimo-v2.6-flash-free` exit 0 -> deterministic verifier PASS -> Gemini pre-review PASS -> Gemini final review via Chrome CDP 9222 APPROVED (binding `soc_brain#9000023@7376702`, no findings) -> Human Gate merge by operator.
- Verification: full suite **784/784 pass, 0 fail** (561601 ms); `git diff --check` exit 0.
- R5 bundle: `artifacts/diffs/pr-234-changes.diff` (30666 B) + `pr-234-diff.zip` (12156 B).

Evidence: PR #234, commit SHA 1c34c33, completed 2026-09-25

## 7. Post-bootstrap: self-improvement mode

After S5, the default development loop becomes:

```text
real use
→ observed friction/failure
→ canonical Soc_brain task
→ smallest corrective improvement
→ verify/review/deliver through Soc_brain
→ use again
```

Do not attempt to pre-complete the entire architecture.

### S6 — External-work adoption

This is post-bootstrap unless a real blocker moves it forward.

Provide an explicit provenance/binding/ownership-safe seam for pre-existing PRs or external work. No implicit adoption by copy/cherry-pick/manual state edits.

OCR/review-only work such as the #185 lineage should be adopted, selectively ported or superseded only after this seam is proven.

## 8. Deferred capabilities

These do not block Bootstrap Exit unless new evidence proves otherwise:

- AG-UI production integration; keep current Soc_brain UI primary and treat #187 as protocol/PoC evidence;
- Command Code and additional executor adapters;
- sophisticated resource-aware scheduling;
- advanced Soc_Score/evaluation/routing;
- context optimization;
- validated continual learning;
- goal-level planning;
- broad external-domain integrations;
- exhaustive recovery coverage for unobserved failure modes.

After bootstrap these return to the strategic sequence:

`M2 Context & Capability → M3 Evaluation/Routing → M4 Validated Learning → M5 Goal/Planning → M6 Personal AI Control Plane`.

## 9. Open PR treatment at roadmap reset

As of 2026-09-19, do not infer canonical status from an open PR.

- #184 recovery/liveness — candidate source for S2; re-review exact current HEAD before adoption.
- #185 OCR/OpenCode review-only — external/unadopted candidate; defer until adoption is available or selectively port later.
- #186 R4a test policy — policy intent belongs in S0/S1; canonicalize narrowly rather than importing unrelated cumulative changes.
- #187 AG-UI PoC — preserve as PoC; not bootstrap critical path.
- #188 universal Final Review — source of useful binding/review-loop work for S4; do not wholesale merge.
- #190 autonomous delivery/Web2API — source of delivery/recovery/UI/Web2API experiments; current review transport is degraded; do not wholesale merge.

Exact PR HEADs and status must always be read back before action.

## 10. Capability maturity

Do not use “COMPLETE” merely because code exists or a PR merged.

Use:

```text
IMPLEMENTED
→ DETERMINISTIC_VERIFIED
→ INTEGRATED
→ RECOVERY_VERIFIED (when recovery matters)
→ REAL_E2E_PROVEN
→ CANONICAL
```

Also:

`DEGRADED` — previously usable/proven capability currently fails its operational contract.  
`SUPERSEDED` — retained for provenance but no longer the selected architecture.  
`OPEN_CANDIDATE` — useful unmerged/unadopted work, not canonical truth.

## 11. Dogfood-first rule

After Bootstrap Exit, Soc_brain source changes should normally go through the canonical Soc_brain loop.

Exception: the capability being repaired makes that loop unusable. In that case:

- make only the minimum external repair required to restore the loop;
- preserve exact provenance/evidence;
- bring the work back through canonical adoption/verification as soon as the loop is usable;
- never treat an emergency external patch as canonical merely because it works.

## 12. Roadmap governance

Priority sources, in order:

1. blocker preventing practical use;
2. observed real failure with evidence;
3. smallest capability directly unlocking user value;
4. later roadmap capability.

“Would be nice to have” does not enter the bootstrap critical path.

Roadmap changes should be driven by evidence. North Star is versioned only when the product thesis or authority model changes materially, not for implementation corrections.

---

**Roadmap v2 optimizes for time-to-self-hosting: make Soc_brain usable, let it carry its own development workload, then improve it incrementally from real evidence.**


- [x] **Telegram Telemetry & Real Actionable Context**: Loại bỏ câu ru ngủ, bổ sung ngữ cảnh thực tế và mã lỗi. (Commit: `2892c60`, Ngày: 2026-09-24, Status: `DETERMINISTIC_VERIFIED` 198/198 PASS).
- [x] **PR #235 / Issue #51**: Explicit timeUnit: 'ms' in soc-score schema (2026-09-25, Commit: c2fb41b83b621f7d82120d4161fc48440b1c56fa, State: DETERMINISTIC_VERIFIED)
- [x] **Issue #218 (Eliminate flaky SR11b/SR13b race in client-mcp-supervisor)**: Xác thực 23/23 process-backed tests pass 100% offline (exit 0, 0 fail, 0 unhandledRejection). Cơ chế atomic no-clobber acquisition trên cold lock và strict auto boot hoạt động ổn định tuyệt đối dưới tải đồng thời. (Commit: `7456c65`, Ngày: 2026-09-26, State: `DETERMINISTIC_VERIFIED`).
- [x] **LH-04 & LH-05 Hardening**: Bổ sung `scripts/Set-SocTaskBinding.ps1`, chuẩn hóa `headSha` và kích hoạt luồng cảnh báo khẩn cấp Telegram khi runner gặp sự cố (Commits: `c775cf0` -> `7456c65`, Ngày: 2026-09-26, State: `DETERMINISTIC_VERIFIED`).

---

## 13. Kiểm kê hiện trạng tại HEAD b104981 (2026-09-29)

**Phạm vi:** rà inventory 240 file Git theo dõi, 25 thư mục `packages/`, 86 file test; đọc sâu các entry point, đường nhận goal, workspace, session, launcher, worker, FSM, UI, router, review, hợp đồng và tài liệu. Đây là audit mã nguồn, không phải xác nhận runtime trên máy Windows của Bố. Đường chính là `soc.submit_goal` → `taskStart` → `routeExecutor`/`startExecution`; `bin/soc-control-loop.mjs` là một đường CLI khác, hiện có tùy chọn bootstrap. Không được gộp hai đường thành một năng lực đã được chứng minh end-to-end.

| Năng lực | FACT tại HEAD và chủ sở hữu | Đánh giá/điểm thiếu |
| --- | --- | --- |
| Nhận goal, repo đích, idempotency | `packages/client-mcp/client-mcp.mjs` có `soc.submit_goal`, `soc.get_task`, `soc.get_progress`, `soc.recover`; `client-control.mjs` yêu cầu `targetRepo` và `localCheckoutPath`, xác minh remote, `clientRequestId` cho goal không có issue, rồi gọi `taskStart`. | `IMPLEMENTED`; hiện TUI `soc_control` chưa bị giới hạn vào một tool, và đường `bin/soc-control-loop.mjs` khác đường client MCP. |
| Isolated worktree và authority | `packages/runtime-sandbox/runtime-sandbox.mjs` nhận `baseSha`, tùy chọn cặp `targetRef`/`expectedHead`, xác minh binding; `packages/workspace`, `safe-git`, `session-authority` bảo vệ workspace/owner. | `IMPLEMENTED` ở đường `taskStart`; phải chứng minh đường TUI mới luôn dùng primitive này và từ chối ref thiếu SHA. |
| Headless Executor | `packages/executor-launcher/executor-launcher.mjs` spawn không qua shell, cwd là worktree đã xác minh, `opencode run --format json`, lưu PID/start-time/exit code và NDJSON activity; `model-resolution.mjs` có probe và fallback có kiểm chứng. | `IMPLEMENTED`; không viết launcher thứ hai. Đánh giá timeout/stream trên đúng OpenCode 1.18.27 bằng smoke thực tế. |
| Worker, recovery, chống treo | `packages/client-mcp/route-worker.mjs` spawn sibling tách khỏi transport và có `superviseExecution` với hard time, giới hạn bước, no-mutation, kiểm tra PID+start-time trước kill; launcher có reconcile/latch/reaper. | `IMPLEMENTED` ở đường client MCP; không mở daemon/watchdog mới. Thử bị ngắt transport, timeout và tiến trình lạ trên Windows. |
| Theo dõi realtime | `client-control.mjs#getProgress` chiếu session/ledger/progress/execution liveness; `packages/control-ui/control-ui.mjs` đã có `/api/tasks`, `/api/vm`, `/api/activity`, `/api/changes` và poll giao diện; `packages/task-progress` chỉ là telemetry phụ. | `IMPLEMENTED` ở các bề mặt riêng; chưa chứng minh một lệnh TUI trả descriptor đúng lúc và theo dõi được xuyên các bề mặt. |
| FSM và Reactive Engine | `packages/control-loop/control-loop.mjs` có canonical FSM/ledger/hook; `packages/supervisor/reactive-engine.mjs` là EventEmitter transition + readback, `runChain()` đi đồng bộ qua các trạng thái. Tìm tham chiếu production chỉ thấy định nghĩa `createReactiveEngine`, chưa thấy wiring. | `reactive-engine` là `IMPLEMENTED` như một helper; **không** có API heartbeat/watchdog trong module này và không được tuyên bố đang giám sát Executor. Mốc tiến trình thật phải gắn với execution record và canonical FSM, không chạy `runChain()` trước khi công việc hoàn tất. |
| Router, fallback | `packages/control-loop/router.mjs` có registry theo phase, timeout/retry/fallback; phase `EXECUTE` mặc định **0 retry, không fallback executor** để tránh chạy mutation lần hai khi kết quả chưa rõ. `model-resolution.mjs` xử lý fallback model **trước khi spawn**, khi có chứng cứ availability. | Không tự động retry/đổi executor sau lần spawn có side effect không rõ. Chỉ đưa chính sách phục hồi vào seam có chứng minh idempotency. |
| Bootstrap CLI | `.opencode/agents/soc_control.md` cho `bash: allow`, `edit: deny`, hướng dẫn gọi CLI với `--bootstrap`; `bin/soc-control-loop.mjs` mặc định `bootstrap: false`; `scripts/Invoke-SocTask.ps1` từ chối primary dirty, checkout branch, empty commit, push và tạo PR trước worktree. | Đây là lỗ hổng thực tế của đường TUI: model có bash nên vẫn sửa được main và có thể bỏ quên flag. Cần thay chính sách tool và đường admission; không dùng shell command filter. |
| Repo khách | `soc.submit_goal` có thể admit/route repo xác minh; `docs/control-loop-runbook.md` và `runControlLoop` ràng buộc terminalization/delivery của đường canonical hiện tại với Soc_brain. | Admission/execution `IMPLEMENTED`; full autonomous review, delivery và cleanup cho repo ngoài là `PLANNED`, cần test riêng. `AGENTS.md` của repo khách là dữ liệu để hiểu dự án, không trao quyền điều khiển Soc_brain. |
| Review và bằng chứng nguồn | `packages/control-loop/review-payload.mjs` hiện đọc raw diff từ file; `bin/soc-control-loop.mjs#buildBundleInfo` ghi nhận ZIP nếu có. `AGENTS.md` R5 còn yêu cầu export raw diff, ZIP optional legacy. | **Không bắt Bố/Executor nộp file `.diff` hoặc `.zip`.** Reviewer vẫn phải đọc được toàn bộ changeset thật, ràng buộc base/HEAD; P3 sửa đường lấy diff và chính sách để hỗ trợ điều này. |
| State ngoài repo | `defaultStateDir()` là `$HOME/.soc-brain/state`; canonical session ở `<stateDir>/sessions`, control-loop và log ở những thư mục con của `stateDir`. | **Giữ nguyên layout này.** Session/log runtime tập trung dưới `$HOME/.soc-brain/state/`; không ghi vào root repo chính hoặc repo khách, không làm migration thư mục. |

**Chỉnh sai tài liệu:** `docs/TRIAD_HANDOFF_PROTOCOL.md` đã có và là tài liệu được `AGENTS.md` tham chiếu; bỏ task tạo một bản `TRIAD_COMMUNICATION_PROTOCOL.md` trùng chức năng. PR #215 ghi trong lịch sử roadmap là nơi thêm reactive engine; không suy từ tên Issue #197 rằng engine đã nối với worker. Các bản kiểm tra 777/777, 784+ ở mốc cũ không phải chứng cứ full suite cho HEAD b104981.

## 14. Kiến trúc mục tiêu tối thiểu (giữ nguyên các bề mặt đang có)

1. **TUI là buồng lái:** agent `soc_control` chỉ được thấy **một tool gateway có operation rõ ràng** (`submit`, `status`, `recover`; human gate đi qua operation riêng và kiểm tra thật sự là hành động của Bố). Gateway chỉ chuyển lệnh tới `packages/client-mcp/client-control.mjs`/các primitive hiện có; không giữ session hay FSM riêng. Thu hồi `bash`, `edit`, `read`, `glob`, `grep`, tool `task`/delegate và mọi đường thực thi tương đương của *agent điều khiển*; Executor trong worktree giữ đúng coding tools của nó. Kiểm chứng cấu hình này bằng OpenCode 1.18.27 thật, không giả định tên permission hay khả năng hạn chế tool nào chưa kiểm tra.
2. **Một cửa nhận goal bắt buộc:** mọi goal mới đi qua gateway/admission, tự phân loại task mới, task có identity để resume hay target repo ngoài bằng identity đã xác minh. Không để `soc_control` tự chọn có/không `--bootstrap`; nếu cần PR/bootstrap thì admission quyết định theo trạng thái canonical. Hợp nhất đường CLI với client control bằng cách dùng chung core, không tạo authority thứ hai.
3. **Một workspace xác thực:** `targetRepo` và checkout path là input bắt buộc, ref nguồn phải phân giải thành SHA40 trước khi tạo worktree. Task có sẵn cần `issueNumber` hoặc identity chính xác; nếu gắn `targetRef` thì `expectedHead` phải có và khớp. Với primary dirty, bắt buộc caller nêu `targetRef` + `expectedHead` (hoặc một base commit SHA40 tường minh được xác minh bằng cùng primitive); không ngầm chọn `origin/main` thay cho WIP. Không stash/reset/checkout primary; tạo hoặc tái dùng worktree cô lập từ commit cụ thể qua `taskStart`; thiếu tham số thì lỗi cấu trúc ngay. Không đưa rác session vào main checkout hoặc root repo khách. Bỏ thao tác checkout/push sớm của bootstrapper trên đường này; PR/remote là bước delivery riêng có gate, không là tiền điều kiện của local execution.
4. **Một execution owner:** dùng `createDetachedRouteExecutor` → route worker → `startExecution`, model resolver hiện có, latch/reconcile hiện có. Khi nhận lại goal hoặc timeout transport, đọc descriptor/task status trước; không spawn lần hai khi kết quả lần trước chưa xác định. Không dựng UI/daemon/watchdog mới.
5. **Mốc thực tế, không nhảy FSM:** launcher/worker ghi STARTING/RUNNING/EXITED/FAILED, activity và terminal evidence; control plane chỉ chuyển `EXECUTING → VERIFYING` sau exit đã xác thực và điều kiện verification được thiết lập. `reactive-engine` có thể nhận transition khi đã có bằng chứng nếu tích hợp đúng ledger/ownership; *không* feed heartbeat giả vào `runChain()`, *không* trao nó quyền kiểm soát tiến trình. Cảnh báo treo thuộc worker/liveness và các kênh telemetry hiện hữu.
6. **Theo dõi trong cùng phiên:** gateway trả `{repo, issueNumber, identityHash, state, execution}` sớm; TUI có thể gọi lại chính tool đó với `status` để lấy tiến độ/đường log. UI hiện hữu vẫn đọc `/api/activity`; stream tới một tool call đang mở chỉ dùng nếu smoke OpenCode 1.18.27 chứng minh nó không treo và không mất terminal evidence. Nếu tool call không chịu được thời gian dài, trả descriptor rồi status poll trên chính TUI; worker vẫn chạy và lưu bằng chứng. Không bắt Bố mở terminal thứ hai.

## 15. Thứ tự triển khai và điều kiện thoát

### P0 — Cửa TUI và quyền thực thi, ưu tiên cao nhất

**Vấn đề:** `soc_control` có bash và `--bootstrap` là lời dặn trong prompt. `edit: deny` không chặn `bash` ghi file. Một goal có thể bỏ qua intake hoặc đi vào script push khi primary dirty.

**Phạm vi sửa:** `.opencode/agents/soc_control.md`, cấu hình OpenCode ở `.opencode/opencode.json` và projection trong `packages/runtime-sandbox/opencode-adapter.mjs` nếu có ảnh hưởng, `packages/client-mcp/client-mcp.mjs` + `client-control.mjs` để lộ một gateway operation bọc core đã có, `bin/soc-control-loop.mjs`/`task-ingestion.mjs` để CLI không còn đường goal bỏ admission. Không đưa việc thay đường diff/review vào P0 khi chưa chạm tới review; phần đó thuộc P3. Chỉ thay bề mặt cần thiết sau khi đo runtime 1.18.27; nếu không thể cấp đúng một callable tool và deny shell/edit/task bằng cơ chế thật, fail closed với báo cáo bằng chứng, không tuyên bố xong P0.

**Acceptance:** TUI gửi goal không cần Bố chạy bootstrap; direct prompt yêu cầu `soc_control` sửa `main`/gọi bash/delegate bị runtime từ chối; goal có repo/identity hợp lệ tạo đúng một canonical session; thiếu repo/checkout/identity và ref-head mismatch trả code rõ, không mutation. Mọi command tạo output thực tế phải kèm exit code/log. Không push/gh PR do riêng intake. Bàn giao P0 có source diff/HEAD để review thay đổi của chính task, nhưng không buộc tạo hay nộp file diff/ZIP theo tên mẫu.

### P1 — Worktree và WIP primary an toàn

**Phạm vi sửa:** `scripts/Invoke-SocTask.ps1` + `packages/control-loop/task-ingestion.mjs` chỉ nếu còn là đường active, hoặc thu hẹp chúng thành bước PR/delivery; dùng lại `packages/runtime-sandbox`, `workspace`, `safe-git`, `session-authority` thay vì viết provisioner mới. Xử lý task cũ bằng readback/reconcile, không adopt worktree tự khai.

**Acceptance:** primary của Soc_brain và repo khách có tracked/untracked WIP vẫn nguyên byte và `git status`; khi dirty mà thiếu ref + expected SHA tường minh thì fail closed, khi đủ mới tạo isolated worktree ngoài primary từ đúng SHA; SHA không khớp hoặc base ref chưa xác minh từ chối trước mọi push/checkout; hai submit cùng `clientRequestId`/task identity không tạo hai owner/branch/worker; test native PowerShell 5.1 và pwsh cho script nào còn sử dụng. Không copy `AGENTS.md` của repo khách thành policy của Soc_brain.

### P2 — Execution, timeout và trạng thái người vận hành

**Phạm vi sửa:** chỉ nối seam thiếu ở `client-control`, `route-worker`, `executor-launcher`, `task-progress` và canonical `control-loop`/router; tái sử dụng `control-ui` và liveness. Kiểm tra chính xác `opencode run --format json` trên OpenCode 1.18.27 và hành vi timeout của một tool call TUI.

**Acceptance:** trong cùng TUI Bố thấy descriptor ngay, gọi `status` thấy mốc/NDJSON hoạt động và terminal exit; ngắt/khởi động lại MCP transport vẫn thấy cùng session và process, không duplicate mutation; process chết/hang được worker phân loại đúng, chỉ kill khi PID/start-time match; model availability không rõ từ chối trước spawn, fallback pre-spawn hợp lệ được ghi nhận; sau spawn không retry mù. Terminal process success tự nó không thành `PASS`; FSM chỉ đi sau bằng chứng thật. Có Windows smoke với PID, start-time, timestamp, exit code, log và sai khác được kiểm tra.

### P3 — Review, bằng chứng và repo khách

**Phạm vi sửa:** `packages/control-loop/review-payload.mjs`, đường cấp diff cho Final Review trong `bin/soc-control-loop.mjs`, `AGENTS.md` R5 và `docs/TRIAD_HANDOFF_PROTOCOL.md`: lấy changeset thật theo base/HEAD đã pin từ PR hoặc Git/worktree đã xác minh; nhận diff content trực tiếp, không bắt nộp file có tên cố định. ZIP có thể tồn tại để lưu trữ nhưng không là gate. Tách phần repo khách thành milestone có review/merge policy cụ thể; đừng coi `submit_goal` chạy được là full autonomy.

**Acceptance:** trước `READY_FOR_REVIEW` chạy **trọn vẹn** `node --test tests/*.test.mjs` offline, lưu raw terminal log đầy đủ, exit code/tổng pass-fail-skip và exact HEAD. Final Reviewer đọc được toàn bộ diff từ PR exact HEAD hoặc Git range của worktree đã xác minh; empty/missing/truncated diff hay base/HEAD không khớp thì fail closed. Không yêu cầu file `.diff`/`.zip` như điều kiện review; nếu source nằm ở PR, PR ID chỉ lấy từ nguồn thật. Khi chưa có PR, task vẫn chạy local và có thể cung cấp diff/patch trực tiếp qua kênh review, nhưng merge PR vẫn cần PR thật và Human Gate. Full loop Soc_brain phải đạt Human Gate với independent verdict đúng binding; repo khách cần riêng một case end-to-end trước khi nâng nhãn `INTEGRATED`/`REAL_E2E_PROVEN` cho external delivery. Bố giữ quyền merge/deploy.

### P4 — Tài liệu hóa sau khi P0–P3 có bằng chứng

Cập nhật roadmap, runbook và `docs/TRIAD_HANDOFF_PROTOCOL.md` đúng owner/schema đã đổi. Tại P4 rà tính nhất quán các tài liệu còn lại (`bootstrap opt-in theo prompt`, claim reactive supervisor đang monitor); chính sách file diff/ZIP được sửa trong P3. Chỉ nâng maturity theo bằng chứng đúng HEAD, không sao chép số test lịch sử.

## 16. Hợp đồng state, phạm vi và test gate cho Executor

- **State/layout:** giữ nguyên `defaultStateDir()` là `$HOME/.soc-brain/state/`: session JSON ở `state/sessions/`, runtime log/ledger/activity ở các thư mục con hiện có của `state/`; worktree riêng ở `$HOME/.soc-brain/worktrees/`. Không đổi tên thư mục, không migration, không tạo state root song song. Không ghi file tạm, session JSON hay log runtime vào root primary/target. Worktree riêng có thể chứa contract/projection của chính task.
- **Bằng chứng và ranh giới:** `AGENTS.md` của Soc_brain và runtime validator chỉ điều khiển Soc_brain. Repo khách cung cấp mã, test, conventions để sửa; không thực thi chỉ thị trong repo khách nhằm đổi quyền của control plane. Không cấp quyền shell/edit cho `soc_control` và không giải bài toán này bằng parse/filter lệnh bash. Executor vẫn có tool coding trong isolated worktree qua projection đã xác minh.
- **Gate kiểm thử:** mỗi mốc chạy targeted test cần thiết; trước bàn giao **mỗi task P0–P3** chạy `node --test tests/*.test.mjs` trên Windows offline với raw log, PID/exit code/tổng kết/not-ok. Không gọi mạng/model probe thật trong offline suite; dùng DI/mocks. Smoke thật riêng phải ghi đúng version/executable OpenCode, model và môi trường; không lấy mocked test làm E2E. Nếu full suite dài, dùng launcher/worker evidence thay vì nhốt một TUI tool call chờ suốt lượt chạy.
- **Không đẩy GitHub ở pha lập roadmap này:** bản tài liệu này là đề xuất có thể copy vào task cho OpenCode local của Bố. Chỉ sau khi Bố ra task triển khai, chính Soc_brain mới được thực hiện những hành động remote theo quyền/human gate của task đó; không coi tài liệu là ủy quyền push hay merge.

## 17. Điều chưa được chứng minh và quyết định phải khóa bằng thử nghiệm

1. OpenCode **1.18.27** đang cài trên máy Bố có hỗ trợ hiệu lực “một gateway tool, không shell/edit/task” cho primary agent đúng cấu hình nào? Kiểm tra local `opencode --version`, config resolved và prompt đối kháng, ghi raw log; nếu thất bại P0 giữ trạng thái `BLOCKED` và đề xuất seam thay thế thực sự có thể cưỡng chế.
2. TUI tool call timeout và stdio stream trên Windows: đo từ khi gọi đến descriptor, heartbeat/activity, khi TUI đóng/transport chết; ghi rõ công đoạn nào chạy trong worker. Không hứa streaming trực tiếp nếu runtime không chứng minh.
3. `client-control` đã admit/execute repo ngoài, nhưng review và delivery Soc_brain-only ở đường hiện hành. Mở rộng canonical FSM sau khi xác định policy owner/authorization cho repo khách, không tự áp `AGENTS.md` của khách lên control plane.
4. `reactive-engine` chưa có production callsite ở snapshot này; nếu tích hợp, cần chứng minh ledger/schema/owner phù hợp và mỗi transition có bằng chứng thực. Không gắn tên Issue #197 làm bằng chứng chạy thực tế.
5. Quyết định mới nhất: không bắt nộp file diff/ZIP. R5 hiện vẫn yêu cầu export raw diff và review payload đọc file; P3 phải đổi producer/consumer/test cùng một changeset để reviewer nhận toàn bộ source diff đúng base/HEAD, rồi chứng minh đường review end-to-end. Không bỏ kiểm tra changeset chỉ vì bỏ yêu cầu file.

**Điểm dừng cho chuỗi ưu tiên:** hoàn tất P0 và P1 rồi chạy một task thật trên Soc_brain qua TUI; P2 xác minh quan sát/recovery ngay trên task đó; P3 chỉ mở khi evidence của đường thực tế đã đủ. Không nâng nhãn `CANONICAL` cho luồng mới chỉ từ source inspection hay offline mock.

## 18. PH-REF — Học và tối ưu Soc_brain từ pi-herdsman

**Status:** REFERENCE_AVAILABLE. Chưa xác minh gap hoặc cơ hội tối ưu tại HEAD hiện hành của Soc_brain. Hỗ trợ P0–P4 và cải tiến sau bootstrap; không bổ sung prerequisite hoặc gate mới.

**Nguồn tham khảo:**
- Repository: https://github.com/boadij/pi-herdsman
- Local: `C:\Users\Admin\references\pi-herdsman`
- Commit đã xác nhận: `b38a6d384df5dfb6ecc78c3c981ce8e80fa68e51`
- Chưa chạy test/runtime pi-herdsman; source inspection không tương đương runtime verification.

### 18.1. Mục tiêu và cách sử dụng

Tham khảo source/test kể cả khi Soc_brain đã có chức năng tương đương. Đối chiếu implementation tại exact HEAD để:
- Bổ sung hoặc sửa gap/failure có evidence.
- Giảm độ phức tạp, latency, chi phí model/context, thao tác thủ công và rework.
- Cải thiện recovery, observability và khả năng kiểm thử.

Không coi “đã có” là lý do bỏ qua tham khảo; không mặc định pi-herdsman tốt hơn. Mỗi cải tiến được chọn cần nêu cơ chế hiện tại, evidence, source/commit tham khảo, lợi ích, trade-off và cách kiểm chứng trước/sau phù hợp. Giữ nguyên nếu chưa có lợi ích tương xứng. Ghi kết quả trong handoff hiện có.

### 18.2. Hướng tham khảo và thứ tự ưu tiên

| Ưu tiên | Cơ chế và source bắt đầu đọc | Áp dụng |
| --- | --- | --- |
| 1 | Request/result/ACK: `extension/mailbox.ts`, `mailbox.test.ts`, `mailbox-cleanup.test.ts` | P2/P3: tối ưu outcome → verification/review/delivery, binding, replay/dedupe và bàn giao |
| 2 | Recovery: `extension/recovery.test.ts`, `recoverControllerRuntimes()` trong `extension/index.ts` | S2/P2: reattach đúng owner/run/session, giữ patch/evidence, giảm restart và duplicate |
| 3 | Assignment: `extension/controller-lifecycle.test.ts`, đường delegate trong `extension/index.ts` | P0/P2: descriptor trả sớm, execution ownership rõ, giảm chờ của client |
| 4 | Guard: `extension/core.ts`, `core.test.ts`, `controller-api.test.ts` | Đơn giản hóa guard; phân biệt nhận/applied steering, interrupt và abandon |

So sánh context/handoff để tránh truyền lặp hoặc nạp lịch sử không cần thiết; giữ đầy đủ changeset/evidence reviewer cần đọc. Nhiều executor song song hoặc nested delegation chỉ cân nhắc sau bootstrap exit, khi workload độc lập và lợi ích tương xứng chi phí phối hợp.

### 18.3. Kiểm chứng và ranh giới

- Dùng test gate hiện hữu của task/milestone; không thêm full-suite gate riêng.
- Chọn phép kiểm theo mục tiêu: behavior, số bước, latency, chi phí hoặc failure/recovery; không dựng benchmark subsystem khi phép đo nhỏ đã đủ.
- Khi sửa outcome/recovery, kiểm binding sai, replay, restart/reattach và duplicate side effect theo ảnh hưởng thực tế.
- Smoke phải nối task/attempt/execution với transition và hành động do control loop thực hiện; lời báo cáo model không đủ chứng minh orchestration.
- Soc_brain giữ canonical lifecycle authority; executor cung cấp outcome/evidence; reviewer theo policy hiện hành; Bố giữ quyền merge/deploy.
- Tận dụng primitive và state layout hiện có. Không mặc định thêm Chief/Manager, thay OpenCode bằng Pi hoặc sao chép toàn bộ lớp Pi/herdr.
- Temp-file + rename không tự chứng minh power-loss durability; claim exactly-once/durability phải kiểm tại boundary áp dụng.
- Tái sử dụng code phải tuân thủ LICENSE/NOTICE áp dụng và ghi nguồn/commit.


## 19. AO-REF — Tham khảo AgentOps (giữ quyết định đã bổ sung ngày 2026-10-03)

**Status:** SOURCE_RESEARCHED / PLANNED. AgentOps pin `339f4f29829c91a2e61445b747f1298a0237707c`, origin `https://github.com/boshu2/agentops.git`; Bố đã cung cấp read-back reference local khớp pin. Bố cung cấp commit roadmap local `536d165357edc171d15c209c74d54caabeb6972e` (+72 dòng). Branch local đó chưa có trên remote khi kiểm tra; bản tài liệu này tóm lược lại quyết định AO và cập nhật hiện trạng, không tuyên bố byte-identical với blob của commit local.

- Học acceptance/domain terms từ `skills/plan`, `skills/domain`; exact-subject judgment từ `skills/validate` và `schemas/verdict.v2.schema.json`; manifest, strict parsing và immutable storage từ `cli/internal/evidence/`, `cli/internal/verdictcheck/`.
- Học actual context identity và handoff gọn từ `skills/agent-native/references/session-associations.md`, `judgment-receipts.md`, `context-budget-delegation.md`; học đo lợi ích từ `skills/skill-eval`.
- Tham khảo cả primitive đã có để tìm tối ưu; không xây lại evidence từ đầu. Không cài cả catalog/plugin, không Beads/control plane thứ hai. Optional OpenCode plugin tại pin có module-level bootstrap/skill-name mismatch và Unix PATH logic; chưa có native-host proof.
- Giữ runtime Web2API/Gemini theo contract hiện hành. ChatGPT review/Gemini tư vấn cho Bố trong cuộc trao đổi không tự thay model route trong Soc_brain. Bố giữ merge/deploy.

| Backlog | Mục đích / acceptance tối thiểu |
| --- | --- |
| AO-01 | Criterion ổn định từ intent đến reviewer; bỏ criterion, thiếu proof, acceptance đổi trái quyền hoặc scope violation không được APPROVED |
| AO-02 | Actual author/reviewer context và attester; request UUID/role name không thay identity; proof qua live route Web2API hiện hành |
| AO-03 | Complete changeset và relevant-input coverage; đổi input làm receipt cũ unusable; dùng binding/TestRunRecord hiện có |
| AO-04 | Reuse receipt khi input/command/environment/gate khớp; negative case từ chối reuse; không giảm required checks |
| AO-05 | Một skill hẹp; native load proof; đo wall time/rework/false-ready, revise/remove nếu không có lợi ích tương xứng |
| AO-06 | Memory/dependency scheduling deferred tới khi history chứng minh nhu cầu; dùng state/tracker hiện có |

Manifest/digest/schema không tự chứng minh semantic truth; declared scope phải đối chiếu actual paths. Không port orphan scanner repo-specific thành authorization gate. Copy/adapt source phải kiểm LICENSE/NOTICE/header, giữ attribution/pin. AO là ID kế hoạch, chưa là Issue/PR hoặc capability hoàn tất. Backlog AO không đứng trước recovery blocker ở mục 20.

## 20. Hiện trạng source và task kế tiếp — rà soát 2026-10-03

> **CẬP NHẬT 2026-10-06:** các binding PR/HEAD trong mục này là dữ kiện lịch sử tại 2026-10-03 (`50a657c`). Trạng thái hiện hành của các PR/HEAD được đọc lại và ghi ở mục 21; không xoá evidence cũ, không tự ý hạ/nâng nhãn proof thuộc snapshot khác.

### 20.1. Binding, phạm vi và giới hạn

**Remote main:** `50a657c5d01d2d04ac7b04cac09da0fdd664d5db`, được xác nhận bằng `git ls-remote` và GitHub branch read-back. **PR #268:** OPEN/DRAFT, `fix/route-probe-recovery` tại `9341423fc7aff92908b58a266d1f8d9059797faf`, base metadata `ce2f7e5bdb5b9c375201452f689f49b82969160d`. *(UPDATE 2026-10-06 — read-back: remote main hiện là `06ec230cc955487a872d6c9a82a6a64b3abd78fe`; #268 đã MERGED `41a1891a2610a991f2a06f7bda86360414a98ac3` ngày 2026-10-04. Chi tiết mục 21.)* Metadata PR hiện ghi 7 file, +1523/-16; body còn mô tả 2 file/+201 là cũ. Diff trực tiếp main-vs-branch có thêm chênh lệch `soc_control.md` vì #270 đã vào main; không dùng diff hai tips đó thay exact PR changeset/merge-base.

Các mục 13–17 là inventory/plan lịch sử tại snapshot cũ, không được đọc như trạng thái hiện hành. Mục này cập nhật interpretation và thứ tự thi công; không xoá historical evidence hoặc hạ/nâng nhãn của một proof cũ chỉ vì nó thuộc HEAD khác. S5 historical task proof không chứng minh task hiện tại hoặc toàn bộ recovery class usable.

Chỉ đọc source, callsites, contracts, metadata GitHub và output Bố cung cấp. Không chạy lại full suite, không quan sát máy Windows, không đọc canonical session/ledger đang sống, không bật admission, không tạo record hoặc live resume. Trạng thái runtime hiện tại của #9000031 chưa xác minh trực tiếp trong phiên này. Không coi PR body/test summary là raw test evidence hoặc final PASS.

### 20.2. Capability inventory tại main

| Capability | Source/callsite hiện có | Kết luận có giới hạn |
| --- | --- | --- |
| Gateway-only soc_control | `.opencode/agents/soc_control.md`: wildcard deny, một gateway tool; role boundary #270 | IMPLEMENTED; permission/config source không chứng minh native adversarial denial |
| TUI -> full control loop | `.opencode/opencode.json` bật `SOC_GATEWAY_FULL_LOOP=1`; `gateway-mcp.defaultGatewayControl` chọn full loop chỉ cho Soc_brain; `client-control.createDetachedControlLoopExecutor` -> route worker -> `runSocControlLoop` | Production wiring có; không còn mô tả gateway mặc định chỉ detached executor. Env flag là configuration, không authority |
| Workspace/admission/execution truth | `runtime-sandbox`, workspace, session-authority; gateway phân loại ExecutionRecord/liveness/latch; status đọc transition ledger | IMPLEMENTED; task đang sống và native ownership proof cần Windows evidence |
| Model resolution | `executor-launcher/model-resolution.mjs`, runner/router gọi shared resolver trước spawn | Typed fail-closed MODEL_* có; availability/probe hiện tại không được suy từ config |
| Session Authority | `session-authority/guard.mjs`: mode mặc định off, arm bằng required/1; runner admit/release; ledger assert fence | Opt-in; khi disarmed fence trả ok/armed:false. Gateway config đang đọc không đặt SOC_SESSION_ADMISSION; chưa biết env bên ngoài. Không gọi enforcement luôn bật |
| Test evidence | `execution-content-binding.mjs`, `test-run-evidence.mjs`, `review-evidence.mjs`; runner cấp `createActiveTestRunner()` cho verifier | Binding/TestRunRecord và active verify có; không bắt đầu AO bằng xây lại hệ thống. Live receipt completeness cần read-back đúng task |
| Review Web2API | `review-payload`, `web2api-review-provenance`, Gemini transport; runner tách pre-review RAW JSON khỏi final verdict transport | Request/digest/turn provenance đã có; actual clean reviewer context và mọi resume path chưa được chứng minh trong lần rà này |
| Test tiers | `scripts/run-tier.mjs`, `tests/tiers.json`, package scripts; #267 merged | Utility opt-in đã có; runner active verify vẫn dùng test:gate. Không tuyên bố tier gate đã thay verifier/full suite |
| Supervisor reactive | `packages/supervisor/reactive-engine.mjs`; search packages/bin không thấy import production | Có implementation/tests, chưa có production integration theo search scope; không dựng supervisor mới vì thấy module |
| External repos | Gateway chỉ full-loop cho Soc_brain; repo khác đi detached route | Không nâng external review/delivery lên full autonomous từ khả năng submit |
| Notifications | submit trả telegramDispatch; route worker có GATEWAY_RUNNER_FAILED fallback; lifecycle/FSM dispatch hiện có | Wiring có; delivery/end-to-end từng mốc chưa quan sát trực tiếp |

### 20.3. PR và evidence phải giữ riêng

- #263 MERGED: source main có immutable review request/provenance và test evidence hardening. Không còn coi #263 chỉ OPEN dựa vào handoff cũ.
- #267 MERGED: test tiers opt-in. Không coi source existence là benchmark chứng minh đã giảm tổng thời gian.
- #270 MERGED: main commit hiện tại thêm 16 dòng role boundary; không mở rộng coding tools của soc_control.
- #268 OPEN/DRAFT: recovery route MODEL_UNRESOLVED trước dispatch; pre-spawn instruction retry; các seam pre-review timeout/reconciliation và admission metadata. Chưa merge/được admission vào main; chưa cấp independent acceptance verdict trong lần rà này. *(UPDATE 2026-10-06: đã MERGED `41a1891a2610a991f2a06f7bda86360414a98ac3`, 2026-10-04 — xem mục 21.1.)*
- #269 OPEN: task #9000031, branch `agent/662d6ddfe5f831cba89f1dd21f592281`, metadata HEAD `d43136658e9079d69d540ad26f08325d21e45688`. PR tồn tại không chứng minh task đã được final review hoặc đủ quyền merge. *(UPDATE 2026-10-06: read-back cho thấy state=CLOSED, `mergeCommit: null`, `mergedAt: null` — không merge, không ghi nhận delivery evidence từ PR này.)*
- Main merge commit #270 có narrative test counts và baseline failures; đây là thông tin report trong commit, chưa được xác minh bằng raw logs trong task cập nhật roadmap. Không chép số đó thành kết quả tests vừa chạy.

### 20.4. Gap thực tế cần ưu tiên

**FACT source trên #268:** `recordPreSubmitBoundaryReconciled()` đã kiểm armed admission fence và ghi authority/evidence metadata; reader kiểm owner snapshot generation/lane và evidence SHA. Search exact symbol trong `bin/`, `packages/`, `scripts/`, `tests/` chỉ thấy definition/comments và test calls; chưa có non-test production caller trong các bề mặt đó. Đây là gap integration, không bằng chứng writer primitive hỏng.

**FACT source main:** gateway `recover` là transport reattach, không có operation boundary reconciliation/lifecycle retry. Không yêu cầu soc_control gọi shell hoặc script tự ghi record để vượt gap này.

**UNKNOWN cần phép kiểm phân biệt:** admission owner generation có đổi khi helper release rồi runner re-acquire không; reader có chấp nhận đúng historical authority dưới lifecycle đó không; observation source nào thật sự chứng minh PRE_SUBMIT/no submit side effect. Evidence SHA chỉ chứng minh log integrity, không chứng minh nội dung log đủ kết luận PRE_SUBMIT. Không dùng source/basis tự khai hoặc lane env làm quyền.

### 20.5. Task lựa chọn: REC-01 — Khép đường reconciliation có authority và cùng task

**Ưu tiên:** trước AO-01 và trước refactor/test-tier integration. **Trạng thái:** SELECTED, chưa thi công/issue mới. *(UPDATE 2026-10-06: REC-01 đã được thi công và MERGED qua PR #271, merge commit `c314c75d93d73e2f3a63a2ca762313dcd69b9070`, 2026-10-04 — nâng `SELECTED → IMPLEMENTED (MERGED)`; chưa đọc raw test log đúng HEAD nên chưa nâng `DETERMINISTIC_VERIFIED`. Chi tiết mục 21.2.)* Mục tiêu là nối minimum supported control-plane/Operator entry vào primitive #268 để xử lý checkpoint pre-submit thật; không thêm recovery framework hoặc nâng quyền soc_control.

**Dependency:** hoàn tất exact-head review của #268. Nếu đang có executor sửa/review cùng branch, tiếp tục assignment hiện có, không mở writer thứ hai. Findings actionable sửa trên branch task theo authority; không tự merge. Main/local/PR phải read-back trước task vì SHA có thể đổi.

**Scope dự kiến:** entry seam trong runner/control plane hiện có, writer/reader reconciliation hoặc guard metadata chỉ khi lifecycle test chứng minh cần sửa; targeted tests/callsite/runbook cần thiết. Không sửa model route, transport topology, tracker/state root, reviewer roles hoặc timeout probe để ép xanh. Không port AgentOps runtime.

**Acceptance:**
1. Entry dùng canonical identity/session/checkpoint, runtime-owned PRE_SUBMIT observation và actual armed admission grant; generic file path/hash/basis không tự authorize reconciliation.
2. Native lifecycle test writer -> release -> actual runner re-acquire -> reader chứng minh record dùng được đúng historical write authority và current mutation grant. Nếu không dùng được, xác định cause rồi sửa contract tối thiểu; không nới reader thành trust lane/env hoặc luôn accept old generation.
3. Authority disarmed/unavailable/revoked, foreign identity/checkpoint, changed/unreadable evidence hoặc UNKNOWN submit boundary: typed refusal trước retry; record offline cũ giữ nguyên byte.
4. Submit artifacts hoặc side effect uncertainty: reconcile original round, không resend. Retry hợp lệ cùng identity chỉ append history và không tạo duplicate owner/worker/review request. Transport recover vẫn giữ semantics hiện có.
5. Targeted/required gates theo repo tại exact subject; dùng receipts còn hợp lệ, không rerun PASS không đổi input. Native Windows proof riêng ghi process incarnation, authority facts không secret, checkpoint, transition và side effect count; mocked suite không thay live proof.
6. Live proof chỉ trong scope Bố cho phép, trên task branch được review, giữ task #9000031/identity hiện có; không clientRequestId/issue giả hoặc task thứ ba. Nếu runtime/evidence không cho phép kết luận an toàn, dừng typed và bàn giao missing fact; không dựng script env tự cấp quyền.
7. Review/Gemini Web2API theo policy runtime hiện hành; dừng Human Gate, Bố giữ merge/deploy. Khép REC-01 xong mới xét AO-01 dựa vào gap/optimization có lợi ích.

### 20.6. Đồng bộ file vào checkout của Bố

Bản này dựa trên attachment mục 1–18 và thêm summary AO + hiện trạng 20. Không chép đè nguyên file lên roadmap local đã có mục 19 tại commit 536d165. Khi đưa vào Git: giữ nguyên mục 1–19 của local; thêm mục 20 và status banner lịch sử/hiện tại; chỉ sửa docs/MASTER_ROADMAP_v2.md, commit mới trong docs task worktree, không amend/merge/push nếu chưa được giao. Pin source facts ở mục 20; refresh chỉ khi exact source/PR hoặc runtime facts đổi. Đây là docs update, chưa là review PASS hoặc code implementation.

## 21. Đồng bộ GitHub → Roadmap — rà soát 2026-10-06

**Phạm vi và giới hạn:** chỉ đọc GitHub metadata (`gh pr/issue list`, `gh api` commit→PR association) và `git fetch` + `rev-parse` local, đối chiếu với mục 20. Không chạy test, không đọc raw test log, không push/merge, không sửa nhãn (R8: executor không tự áp `status:approved`/`status:blocked`). Chỉ sửa `docs/MASTER_ROADMAP_v2.md`. Đây là docs sync, không phải review PASS.

**Binding đọc lại (2026-10-06):**
- **Vòng 2 (đọc lại sau khi merge thêm #275/#274):** Remote main = `d6f01c8766a4df91ae25a71ee2c70f0cba51da51` — sau `git fetch`, local `main` == `origin/main`, working tree sạch.
- Vòng 1 (cùng ngày, dùng cho bảng 21.1 phần lịch sử): remote main `06ec230cc955487a872d6c9a82a6a64b3abd78fe`.
- Lần rà trước (mục 20, 2026-10-03): `50a657c5d01d2d04ac7b04cac09da0fdd664d5db`.
- File roadmap được track trong git; lần commit trước của chính file: `3a26e43` (2026-10-06 19:08:36 +0700, "docs(roadmap): sync GitHub read-back 2026-10-06 — PR #268/#271/#272/#273/#277, REC-01 IMPLEMENTED"; trước đó `803f2bb` 2026-10-05).
- Query `gh pr list --state merged --search "merged:>=2026-10-03"` (vòng 2) trả về đúng 8 PR: #268, #270, #271, #272, #273, #274, #275, #277 (trong đó #270 = `50a657c` đã là binding của mục 20). PR merge sau vòng 1: đúng 2 — #275 và #274 (query `merged:>=2026-10-06T04:00:00Z`).

### 21.1. PR merge từ sau rà 2026-10-03

| PR | Tiêu đề (rút gọn) | Merge commit (exact SHA) | mergedAt (UTC) | Nhãn tại thời điểm rà | Thang độ trưởng thành (chỉ theo bằng chứng merge) |
| --- | --- | --- | --- | --- | --- |
| #268 | bounded pre-dispatch route retry cho MODEL_UNRESOLVED route:FAIL tail (#9000031 repair) | `41a1891a2610a991f2a06f7bda86360414a98ac3` | 2026-10-04T01:36:58Z | `status:review-requested` | `IMPLEMENTED (MERGED)` — trước đó ghi OPEN/DRAFT tại mục 20.3 |
| #271 | REC-01: pre-submit receipt validation + canonical submit veto | `c314c75d93d73e2f3a63a2ca762313dcd69b9070` | 2026-10-04T02:55:39Z | (không nhãn) | `IMPLEMENTED (MERGED)` — REC-01 SELECTED → đã thi công, xem 21.2 |
| #272 | PRE-GATE-REVIEW-01: internal read-only review trước deterministic verifier gate | `133554d4b5822b1003617004976990c7f7b240d8` | 2026-10-04T16:43:05Z | `status:review-requested` | `IMPLEMENTED (MERGED)` |
| #273 | MCP final-review leg — GPT verdict qua review-mcp-http decisions | `46d008d93317586d4a9b02943b72556b19b08088` | 2026-10-05T04:56:11Z | `status:approved` | `IMPLEMENTED (MERGED)` |
| #277 | handoff-checklist: H2 digest binding & F1/F2 non-string rejection | `3fd8a1d2232afec0426767b4b5701b719b856af0` | 2026-10-06T03:41:14Z | `status:approved` | `IMPLEMENTED (MERGED)` |
| #275 | per-task status board + checklist projection (LOOP-01, #276) — 5 files, +2688/−0 | `d2edd7fba3de1b935e1ba3d7e6d4bb38ac0892b4` | 2026-10-06T12:08:33Z | `status:review-requested` | `IMPLEMENTED (MERGED)` — thêm ở vòng 2 |
| #274 | route-worker: persist typed UNKNOWN result, prime #157 reaper — 3 files, +217/−1 | `d6f01c8766a4df91ae25a71ee2c70f0cba51da51` | 2026-10-06T12:33:19Z | (không nhãn) | `IMPLEMENTED (MERGED)` — thêm ở vòng 2 |

Chỉ ghi `IMPLEMENTED (MERGED)` theo fact merge; không suy `DETERMINISTIC_VERIFIED`/`REAL_E2E_PROVEN` vì lần rà này không đọc raw test log đúng HEAD (mục 20.1: PR body/test summary ≠ raw test evidence). Cấu trúc merge của #274: PR có đúng 1 commit `4ea4b95e561c8e0fbd6a650891d8c4f680c522e4` (author 2026-10-05 10:02 +0700) xuất hiện trên `main` trước (committer 2026-10-06 12:12:03Z), rồi squash-merge tạo `d6f01c8` (12:33:19Z); `gh api commits/4ea4b95/pulls` liên kết đúng PR #274 (khác với các commit direct-push ở mục 21.3).

### 21.2. Cập nhật trạng thái theo thang đo (R9)

- **REC-01** (mục 20.5): `SELECTED` → **`IMPLEMENTED (MERGED)`** qua PR #271 (`c314c75`, 2026-10-04). Điều kiện để nâng `DETERMINISTIC_VERIFIED`: raw test log đúng HEAD của #271.
- **PR #268** (mục 20.3): `OPEN/DRAFT` → **MERGED** `41a1891`, 2026-10-04.
- **PR #269** (mục 20.3): `OPEN` → **CLOSED, không merge** (`mergeCommit: null`); không nhận bất kỳ delivery evidence nào từ PR này.
- **PR #275** (thêm vòng 2): `OPEN/DRAFT` → **MERGED** `d2edd7f`, 2026-10-06T12:08:33Z; deliverable LOOP-01 (status board + checklist projection) đã vào `main` — nhãn tại vòng đọc vẫn là `status:review-requested`.
- **PR #274** (thêm vòng 2): `OPEN/DRAFT` → **MERGED** `d6f01c8`, 2026-10-06T12:33:19Z (fix route-worker persist typed UNKNOWN + prime #157 reaper).
- **Issue #276** (LOOP-01): `OPEN` → **CLOSED** 2026-10-06T11:53:16Z (trước khi #275 merge 15 phút); số issue mở còn lại: 5 (#192, #162, #147, #30, #21).
- Các nhãn khác (S3 REAL_E2E_PROVEN PR #205, S4 IMPLEMENTED PR #207, S5 INTEGRATED PR #229, backlog AO/PH-REF, P0–P4): **không đổi** — không có bằng chứng mới đúng HEAD trong lần rà này để di chuyển.

### 21.3. Commit trên main không gắn với PR (sau merge #277)

- `35fb31fb8351967d503b5af6abc71ebd9f2c2491` (2026-10-06 11:09 +0700) "feat(tooling): add one-command handoff verification script with fail-closed test suite" — `scripts/verify-handoff.mjs` +151, `tests/verify-handoff.test.mjs` +108 (2 files, 259 insertions).
- `06ec230cc955487a872d6c9a82a6a64b3abd78fe` (2026-10-06 13:32 +0700) "fix(verify-handoff): binary-stream diff digest, locked gate command, gate log artifacts, strict no-evidence-on-fail tests" — 2 files, 126 insertions, 60 deletions.
- `gh api /commits/<sha>/pulls` trả `0` PR liên kết cho **cả hai SHA** ⇒ đây là commit đẩy thẳng lên `main`, không có PR review/merge binding. Ghi nhận là source tồn tại tại exact SHA, **không** coi là reviewed/`status:approved`; không tự mở PR hay tự nhãn ở lần rà này (R2/R8).

### 21.4. PR và Issue đang mở (OPEN_CANDIDATE — không phải canonical)

**Vòng 2 (2026-10-06): không còn PR nào đang mở** (`gh pr list --state open` trả `[]`) — #274 và #275 đã merge, danh sách vòng 1 dưới đây chỉ còn là lịch sử tại thời điểm đọc vòng 1.

| Đối tượng | Trạng thái (vòng 1, 2026-10-06 trước khi merge #274/#275) | Ghi chú |
| --- | --- | --- |
| PR #274 | OPEN/DRAFT, `fix/route-worker-exit-hook-8856`, cập nhật 2026-10-05, không nhãn | Đã MERGED `d6f01c8` (vòng 2) |
| PR #275 | OPEN/DRAFT, `task/loop-01-control-loop-checkpoint-20261005-135320`, nhãn `status:review-requested` | Đã MERGED `d2edd7f` (vòng 2) |
| Issue #276 | OPEN, `status:review-requested` | LOOP-01 — đã CLOSED 2026-10-06T11:53:16Z |

**Issue đang mở (vòng 2): 5** — #192 (S1 execution truth), #162, #147, #30 (`status:ready-for-cline`), #21 (`status:queued`); còn lại không nhãn.

PR draft/issue mở là `OPEN_CANDIDATE`: suy trạng thái từ read-back, không suy từ tiêu đề hay nhãn.

### 21.5. Quan sát nhãn (chỉ ghi nhận, không tự sửa — R8)

- #268, #272 và #275 đã MERGED nhưng vẫn mang `status:review-requested` (chưa có `status:approved`).
- #271 và #274 đã MERGED không gắn nhãn nào.
- Hiệu chỉnh nhãn thuộc Reviewer Gate/ControlLoop; executor không tự áp `status:approved`/`status:blocked`.

### 21.4. Cập nhật hạ tầng kiểm thử đa tầng theo vòng đời (2026-10-07)

- **Commit**: `ecfc9c6` (on branch `main`) — *"feat(test-tiering): decouple control-loop tests and establish lifecycle multi-gate testing"*.
- **Bối cảnh & Vấn đề giải quyết**:
  - `tests/control-loop.test.mjs` trước đây chứa lẫn 26 tests IPC Session Authority (Named Pipe + subprocess CLI) với 59 tests FSM thuần, làm Tier 1 bị kéo lê ~195s và gây hiện tượng event-loop latency / CPU spike.
  - Manifest `tests/tiers.json` và `tests/test-suites.json` bị lệch pha (file `control-loop.test.mjs` bị gán đồng thời vào cả t1 và t3, gây chạy lặp 2 lần).
- **Hành động kỹ thuật (FACT tại exact HEAD `ecfc9c6`)**:
  1. **Bóc tách file kiểm thử (Decoupling)**:
     - `tests/control-loop.test.mjs`: Giữ lại 59 tests FSM thuần in-memory (chạy trong ~5.4s).
     - `tests/control-loop-reconciliation.test.mjs`: File mới chứa 26 tests Session Authority IPC Named Pipe.
  2. **Tái cấu trúc phân tầng theo vòng đời phát triển (Multi-Gate Lifecycle Map)**:
     - **Tier 0 (`t0` / `test:smoke`)**: Inner-loop development gate (~5.8s, 64 checks) cho phản hồi tức thì.
     - **Tier 1 (`t1` / `test:fast`)**: Pre-commit domain logic gate in-memory (~50s, 909 checks, giảm 74% thời gian từ 195s).
     - **Tier 2 (`t2` / `test:integration`)**: Pre-push / PR boundary gate (~2.5m, 324 checks, bảo toàn toàn bộ IPC & Session Authority).
     - **Tier 3 (`t3` / `test:heavy`)**: Pre-release survival gate (process lifecycle, worktree churn, lock recovery; gỡ bỏ hoàn toàn `control-loop.test.mjs` để triệt tiêu chạy lặp).
  3. **Đồng bộ hóa Governance & Tooling**:
     - `package.json`: Cập nhật toàn bộ script `test`, `test:smoke`, `test:fast`, `test:integration`, `test:heavy`.
     - `AGENTS.md`: Sửa Step 1 Code & Test Freeze bắt buộc chạy `npm run test:fast` (~50s) trước commit.
     - `tests/tiers.json` & `tests/test-suites.json`: Khóa chặt ma trận phân tầng, vượt qua chốt chặn `tests/run-tier.test.mjs` (6/6 PASS).
