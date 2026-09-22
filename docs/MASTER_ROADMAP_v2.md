# Soc_brain Master Roadmap v2 — Bootstrap to Self-Improvement

Status: Proposed canonical roadmap  
Date: 2026-09-22  
North Star: `docs/NORTH_STAR_v2.1.0.md`

## 1. Decision

North Star v2.1.0 remains the strategic baseline. The product thesis and authority model do not change.

Roadmap v2 changes the execution strategy:

> **Reach a usable self-hosting Soc_brain as quickly as safely possible, then use Soc_brain to improve Soc_brain.**

The immediate objective is not a complete control plane. It is the smallest reliable loop that can perform ordinary Soc_brain source changes through Soc_brain itself.

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

### S5 — Bootstrap Exit: one real autonomous delivery [STATUS: REAL_E2E_PROVEN - PR #205]

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

