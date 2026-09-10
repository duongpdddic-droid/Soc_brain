# Soc_brain Master Roadmap v1

Status: Canonical strategic roadmap  
Published: 2026-09-06  
North Star: `docs/NORTH_STAR_v2.1.0.md`

## 1. Purpose

This roadmap translates North Star v2.0.0 into capability milestones. North Star v2.1.0 is additive (artifact-driven progression, durable institutional knowledge, evaluated behavior, operational feedback, single mutation owner) and is reconciled in the section following M0. It is intentionally not a frozen feature backlog.

Planning hierarchy:

```text
North Star
   ↓
Master Roadmap capabilities
   ↓
Current milestone
   ↓
Canonical Issues / tasks
```

Only the current milestone and the immediately following milestone should normally be decomposed into detailed Issues. Later milestones remain capability targets until evidence from earlier work justifies decomposition.

## 2. Global delivery rule

Every milestone must improve a measurable ability of Soc_brain. Avoid architecture work whose value cannot be demonstrated by a real task, deterministic test, controlled experiment, or observable reduction in failure/cost/human intervention.

Coding is the first proving domain, not the final product boundary.

---

# M0 — Autonomous Control Plane

**Objective:** Put Soc_brain itself in the canonical execution/review/delivery loop.

Canonical loop:

```text
Goal
→ Task
→ Route
→ Execute
→ Deterministic Verify
→ Gemini Pre-review
→ GPT Final Review
→ Soc_brain Decide
→ Rework or Deliver
→ Read-back
→ Cleanup
→ COMPLETED
```

## Current sequence

- **P0-A Real Executor Transport** — COMPLETE.
- **P0-B Deterministic Verifier** — COMPLETE.
- **P0-C Gemini native API pre-review** — COMPLETE.
- **P0-D GPT final review via existing ChatGPT Web CDP** — COMPLETE (#77). CDP later judged NOT_PRODUCTION_READY on Issue #107 evidence (repeated capture/timeout failures at round-4 final review); CDP code/evidence retained as legacy fallback only. The next final-review transport is selected on evidence; transports stay replaceable and never become North Star dependencies.
- **P0-E Rework Loop** — COMPLETE (#79); Soc_brain consumes REWORK and dispatches the selected executor; GPT never directly controls executor.
- **P0-F Canonical Delivery Lifecycle** — COMPLETE (#81); merge/delivery/read-back/close/sync/cleanup and terminalization remain Soc_brain-owned.
- **P0-G Real Autonomous Issue E2E** — COMPLETE (#83, post-#85 validation #88; ControlLoop runbook E2E log 2026-09-07).
- **P0 reliability track (post-E2E)** — OPEN: stall/liveness guards (#96/#105 lineage) delivered; #107 PART 0 in attempt-2 review (PR #144).
- **Reverse control leg** — OPEN: GPT structured decision → validated dispatch seam → executor continues without operator copy-paste (Issue #67, PR #68 in review).

## P0-D constraints

- reuse proven ChatGPT Web CDP transport;
- Soc_brain initiates and captures final-review interaction;
- canonical evidence first; Gemini result separately labeled;
- structured validated ReviewResult;
- fail closed on transport/parse/identity/binding/staleness errors;
- only validated GPT final output may feed DECIDING;
- GPT cannot terminalize, merge, mutate FSM, or directly dispatch executor;
- no SuperAssistant transport, generic reviewer framework, Soc_Score expansion, or P0-E scope creep.

## Exit criterion

A real canonical Issue demonstrates:

`TASK_STARTED → executor → deterministic verify → Gemini → GPT final review via CDP → Soc_brain decision → REWORK/PASS → delivery/read-back/cleanup → TASK_COMPLETED`

with no user intervention after initial admission except a genuine Human Gate.

---

# Reconciliation with North Star v2.1.0 (gap audit 2026-09-10)

Milestone structure unchanged. The five v2.1.0 strategic additions map onto existing milestones:

- **Artifact-driven progression** — largely landed by ControlLoop: the FSM walks from the persisted transitions ledger, and review/rework/delivery/resume are artifact-driven. Remaining gap: the reverse control leg (Issue #67) so GPT/advisor decisions reach the executor without operator copy-paste.
- **Durable institutional knowledge** — covered by M4 with Issue #21; review evaluation records are the missing substrate (Issue #103, umbrella #92). No new milestone.
- **Behavior is versioned and evaluated** — code behavior changes are versioned via git and evaluated by deterministic verification plus review on real tasks; attributable evaluation records for review/behavior-shaping changes arrive with #103. No new milestone.
- **Operational feedback closes the loop** — currently manual: incidents become Issues by operator decision (e.g. the #104–#120 hotfix chain). Event-driven creation/reprioritization of canonical work stays deferred toward M6 "event trigger"; do not automate before the loop is stable.
- **Single mutation owner** — session lease tokens fail closed for Soc_brain-dispatched lanes (`STALE_TASK_LEASE`), but Issue #107 attempt-2 observed a concurrent unidentified agent lane committing to the same task branch. Cross-lane ownership conflict detection and explicit ownership transfer remain missing; tracked as a dedicated P0-class Issue.

Landed-but-previously-untracked operational tooling (no separate milestone): Control UI v1/v2 + cockpit (#33/#53/#127/#130/#135/#136), deterministic Fast Path (#123/#125), unified task-server/worktree intake (#132), backlog reconciliation (#138).

---

# M1 — Observable & Resumable Agent

**Objective:** Make autonomous execution visible, diagnosable, resumable, and robust to executor/session failure.

## First task after P0-G

### P1-0 — Soc_brain Task Progress/Todo

**Status: COMPLETE (#90)** — canonical progress projection landed in `packages/task-progress`; executor Todo stays subordinate telemetry.

Build a canonical progress projection from FSM + evidence. Executor Todo is subordinate telemetry, never canonical task truth.

Example:

```text
Soc_brain #N — Task title
✓ Task admitted
✓ Workspace ready
✓ Executor started
▶ Implementing
○ Deterministic verification
○ Pre-review
○ Final review
○ Delivery
○ Cleanup
Current: EXECUTING
Executor: Cline
Elapsed: 08m 42s
```

## Capability targets

- canonical Task Progress/Todo projection;
- Cockpit progress projection;
- Telegram progress/checkpoint projection;
- executor liveness and process telemetry;
- no-progress detection based on evidence, not elapsed time alone;
- checkpoint and resume;
- bounded retry/recovery;
- disposable executor sessions;
- session rotation when context is exhausted;
- deterministic reroute when an executor is unhealthy;
- durable recovery after Soc_brain/executor/browser restart.

## Exit criterion

The user can see where a task is and why it has not finished; transient executor/session/process failures do not lose canonical work or require the user to reconstruct context.

---

# M2 — Context & Capability Intelligence

**Objective:** Give each model/executor the minimum sufficient context and capability surface required for the current task.

## Capability targets

### Context Builder

Construct task-specific context from canonical state:

- objective and constraints;
- current FSM state;
- relevant project policy;
- relevant files/evidence;
- unresolved findings;
- recent execution evidence;
- applicable Skills;
- validated historical lessons.

### Context efficiency

- stable reusable prompt prefix where beneficial;
- explicit context budget;
- deduplication;
- context compression with provenance;
- incremental context retrieval instead of full dump.

### Execution Artifact Compaction

Persist full outputs and disclose compact projections:

```text
ExecutionArtifact
  artifactId
  fullOutputPath/ref
  head
  tail
  structuredSummary
  exitCode
  sha256
  provenance/binding
```

### Capability Registry & Resolver

Separate capability representation from capability disclosure.

Use:

- Soc_brain core/policy for authority invariants;
- dedicated tools for dangerous/structured boundaries;
- Skills for repeatable procedures;
- generic shell/code executor for exploratory work;
- models for semantic reasoning;
- deterministic verifiers for machine-checkable facts.

Expose only the relevant subset to the active model/executor.

## Exit criterion

Comparable task success is maintained or improved while prompt/context size, irrelevant tool exposure, and context-related executor failures materially decrease.

---

# M3 — Evaluation & Routing Intelligence

**Objective:** Replace executor/model routing by intuition with evidence-driven selection.

**Status:** Soc_Score v0 telemetry landed (#45/#47; presentation defect #51 open); evidence-driven routing (#30 lineage) not yet landed.

## Soc_Score v1 evidence model

Capture at least:

- task class and complexity features;
- executor/model;
- context strategy;
- latency;
- token/cost where available;
- tool and transport failures;
- retry/recovery count;
- rework rounds;
- review findings;
- Human Gate/intervention count;
- deterministic verification result;
- final outcome;
- cleanup/delivery correctness.

## Evaluation principles

- evaluate both outcome and trajectory;
- distinguish executor quality from transport/tool/context failures;
- use comparable task classes;
- require sufficient evidence before changing routing policy;
- support controlled comparisons/ablation when practical;
- retain provenance for every score-driving observation.

## Routing target

```text
Task characteristics
      ↓
Soc_Score / evidence
      ↓
Executor + model + context strategy + verification depth
```

## Exit criterion

Soc_brain can explain, using recorded evidence, why a task was routed to Cline vs OpenCode, Gemini vs GPT, or a particular verification/context strategy, and measured routing changes improve aggregate outcomes.

---

# M4 — Validated Memory & Continual Learning

**Objective:** Turn task trajectories into validated, attributable improvements rather than merely storing history.

**Status:** Selective Experience Compiler v0 queued (Issue #21, gated on real evidence supply); review-eval records pending (#103/#92).

## Learning pipeline

```text
Trajectory + evidence
       ↓
Evaluation
       ↓
Failure/success attribution
       ↓
Lesson candidate
       ↓
Validation
       ↓
Memory | Skill | Policy | Routing | Context strategy
       ↓
Future measurement / re-evaluation
```

## Rules

- memory is not authority;
- raw conversation is not policy;
- accidental success is not a validated lesson;
- transient transport failure must not be attributed to executor reasoning quality;
- learned rules require provenance;
- behavior-changing lessons should be reversible or supersedable;
- stale lessons should decay or be revalidated when environment/model/executor versions change.

## Soc_mem target

Soc_mem should retain user/project knowledge and validated operational experience while keeping canonical repository/task state in authoritative systems.

## Exit criterion

Soc_brain demonstrably changes future behavior based on validated prior evidence, can explain why, and can measure whether the change improved comparable later tasks.

---

# M5 — Goal & Planning Intelligence

**Objective:** Move the user interface from task-level instructions toward outcome-level goals.

## Target flow

```text
User goal
   ↓
Soc_brain understands state and constraints
   ↓
Deterministic planning where sufficient
   ↓
GPT Advisor only when strategic/semantic reasoning adds value
   ↓
Roadmap / dependency graph / canonical tasks
   ↓
Execution through M0–M4 capabilities
   ↓
Roadmap progress evaluation
```

## Fast path

When the user has already approved a roadmap with GPT or supplied an authoritative plan:

```text
User-approved roadmap
→ Soc_brain validates dependencies/policy/invariants
→ canonicalizes
→ executes
```

Do not call GPT redundantly unless there is conflict, missing dependency, invariant violation, or material uncertainty.

## Exit criterion

The user can state an outcome rather than manually decomposing Issues, and Soc_brain can create/maintain a coherent executable plan while preserving Human Gates and authority boundaries.

---

# M6 — Personal AI Control Plane

**Objective:** Generalize the proven control-plane architecture beyond coding while retaining one canonical orchestration model.

Potential domains include:

- software/code repositories;
- project management;
- documents and knowledge;
- communications;
- calendar/scheduling;
- business workflows;
- external services and event sources.

Use a common capability taxonomy where useful:

- perception;
- execution;
- collaboration;
- user communication;
- event trigger.

Do not generalize a domain integration until the control-plane contract is proven by real use.

## Exit criterion

The phrase **“Soc_brain, xử lý tiếp.”** is sufficient for an increasing range of personal/work workflows because Soc_brain can infer the next valid action from canonical state, goals, policy, context, and validated experience.

---

# Cross-cutting contracts

These apply to every milestone.

## Authority

Only Soc_brain owns canonical lifecycle decisions and terminalization.

## Human Gate

Escalate only decisions requiring user value judgment, credentials/owner action, destructive/security approval, or genuinely non-resolvable ambiguity. Technical recoverable failures are not Human Gates.

## Notification

Required lifecycle notifications are deterministic side effects with durable/API acceptance evidence. Never claim a notification was sent without evidence.

Telegram task messages should project canonical task identity and useful content (Issue/title/objective/PR/executor/ref), not merely numeric IDs.

## Idempotency and mutation safety

Important mutations should use operation identity/idempotency where practical, expected-state checks, bounded retry, and read-back. Never blindly repeat an operation whose side effect is uncertain.

## Evidence

Canonical evidence is persisted outside model context and bound to task/repository/head/session identity. Models receive projections, not authority.

## Replaceability

Executors, models, transports, and external services remain replaceable. Avoid coupling canonical state to their proprietary session state.

## Cost

Use deterministic systems for deterministic facts, cheap models for cheap semantic work, and expensive reasoning only where it materially improves expected outcome.

---

# Explicit deferrals

The following are not current-roadmap priorities unless new evidence makes them necessary:

- generic multi-agent/swarm framework;
- model post-training/fine-tuning;
- SuperAssistant in the critical path;
- dual ChatGPT transports/failover without demonstrated need;
- hundreds of always-visible MCP tool schemas;
- executor-specific architecture that prevents replacement;
- automatic Idle Power Manager before one complete autonomous roadmap has been proven;
- speculative abstractions not required by the current/next milestone.

---

# Roadmap governance

## Decomposition rule

Normally create detailed Issues only for:

1. the current milestone;
2. the immediately following milestone when dependency planning requires it.

Later milestones remain capability-level targets.

## Change rule

The roadmap may change when new experiments, failures, costs, or user goals provide evidence. Changes should preserve the North Star or explicitly version the North Star if the product direction itself changes.

## Decision precedence

1. current canonical Issue/task;
2. safety/authority/technical contracts;
3. current milestone exit criterion;
4. Master Roadmap;
5. North Star.

## Immediate execution order at publication

```text
M0 / P0-D GPT final review via CDP
→ P0-E Rework Loop
→ P0-F Canonical Delivery Lifecycle
→ P0-G Real Autonomous Issue E2E
→ M1 / P1-0 Soc_brain Task Progress/Todo
```

Do not interrupt this sequence merely to implement later-roadmap ideas discovered during research.

---

**Master Roadmap v1 converts Soc_brain from an autonomous coding-agent orchestration project into a staged path toward an adaptive personal AI control plane, while preserving the immediate priority: first prove the canonical autonomous loop end-to-end.**
