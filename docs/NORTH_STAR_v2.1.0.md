# Soc_brain North Star v2.1.0

Status: Canonical strategic baseline  
Version: 2.1.0  
Published: 2026-09-07

## 1. North Star

> **Soc_brain is the user's sole personal AI control plane: it understands the user's goal, turns that goal into executable work, selects and orchestrates the appropriate AI/tools, remains continuously responsive and authoritative while work is executing, verifies outcomes and safely completes the lifecycle, then learns from validated experience so the next execution is faster, more accurate, cheaper, and requires less human intervention.**

Operational shorthand:

> **Give the goal once → execute to completion → stay responsive → verify → learn so the next run is better.**

The long-term product test is simple:

> **“Soc_brain, xử lý tiếp.”**

Soc_brain should know what “next” means from canonical project/task state, policy, prior validated experience, and the user's goals, without requiring the user to manually coordinate agents.

## 2. What Soc_brain is

Soc_brain is not another coding model and is not a wrapper around one executor. It is the persistent control plane above replaceable models, executors, tools, communication channels, services, applications, devices, and physical embodiments.

Soc_brain owns:

- goal/task interpretation and canonical task state;
- Task FSM, policy, registry, routing, workspace/worktree/session authority;
- context construction and capability disclosure;
- execution orchestration;
- continuous supervision and reception of new intent/evidence while execution is active;
- checkpoint, safe-interrupt, replan, resume, recovery, and termination decisions under policy;
- deterministic verification and evidence management;
- review orchestration and decision consumption;
- rework, delivery, read-back, cleanup, and terminalization;
- lifecycle notifications and Human Gate handling;
- memory coordination, evaluation, attribution, and validated learning;
- executor/model selection based on evidence rather than preference.

## 3. Authority model

### Soc_brain

**Sole control-plane authority.** Only Soc_brain may mutate canonical lifecycle state or terminalize a canonical task. Soc_brain remains authoritative and responsive regardless of whether an executor is busy, blocked, failed, restarted, disconnected, or replaced.

### User

Owns goals, business/value decisions, credentials or owner-only actions, destructive/security-sensitive approvals, and other true Human Gates.

### GPT-5.6 Sol

Advisor for strategic/complex reasoning and Final Reviewer when Soc_brain invokes it. GPT has high semantic influence but no direct lifecycle, merge, terminalization, or executor-dispatch authority.

### Gemini

Cheap sidecar/pre-reviewer and second opinion. Gemini may classify, summarize, pre-review, or prepare context. Gemini PASS is never final approval.

### Cline / OpenCode / future executors

Replaceable execution backends and capabilities. They implement work and return structured results/evidence. They do not own canonical task completion and their occupancy must never block the control plane.

### Software / services / devices / physical embodiments

Applications, services, devices, robots, and other physical or digital endpoints are capabilities under the same Soc_brain authority model. They do not create a second brain or a parallel canonical lifecycle.

## 4. Canonical control loop

```text
User goal / new intent / new evidence
   ↓
Soc_brain admit / plan / route
   ↓
Canonical task + workspace/session
   ↓
Cline | OpenCode | service | device | future capability
   ↓                         ↑
Execution telemetry ──→ supervisory loop
                         ├─ continue
                         ├─ checkpoint / safe interrupt
                         ├─ replan / resume
                         └─ policy-governed recovery / terminate
   ↓
Deterministic verification
   ↓
Gemini pre-review / sidecar
   ↓
GPT-5.6 Sol final review via Soc_brain-controlled transport
   ↓
Soc_brain validates and decides
   ├─ REWORK → executor
   ├─ BLOCKED → deterministic recovery / Advisor / true Human Gate
   └─ PASS → delivery → read-back → cleanup → COMPLETED
```

The execution loop and supervisory/cognitive loop are concurrent concerns. Soc_brain must be able to observe execution and receive new intent/evidence without depending on the executor's interactive channel becoming available.

GPT does not spontaneously push work to an executor. Soc_brain actively invokes reasoning/review services, validates their output, and decides what happens next.

## 5. Continuous cognitive availability

**Always Responsive.** Soc_brain must remain able to receive and classify new user intent, external evidence, lifecycle events, and supervisory signals while any executor or capability is running.

**Always Authoritative.** Canonical state and lifecycle authority must survive executor blocking, failure, restart, disconnection, or replacement.

**Continuously Supervising.** Execution must be observable independently of executor self-report. Where the capability supports it, Soc_brain should be able to checkpoint, queue a safe interrupt, replan, resume, recover, or terminate under policy.

New intent must not require unsafe prompt injection into a busy executor. It may be queued and applied at an appropriate safe point according to priority and policy.

Technical failures with deterministic, authorized recovery should be handled by policy-governed recovery rather than escalated to the user as false Human Gates.

## 6. Learning loop

Memory alone is not learning.

```text
Trajectory + canonical evidence
        ↓
Evaluation
        ↓
Attribution
        ↓
Validated experience
        ↓
Memory | Skill | Policy | Guard | Recovery | Routing | Context strategy
        ↓
Regression evidence + re-evaluation on future tasks
```

Raw conversation history, accidental success, unverified model claims, and transient failures must not directly become behavioral policy.

Learning must be evidence-backed, attributable, reversible where practical, and measurable against future outcomes.

A validated recurring failure should have a path to change future behavior through an appropriate guard, recovery recipe, routing/context improvement, skill, policy, or regression test. Recording an experience without affecting future behavior is incomplete learning.

## 7. Core invariants

1. **Only Soc_brain ControlLoop may terminalize a canonical task.**
2. `EXECUTION_SUCCESS != TASK_COMPLETED`.
3. `E2E_PASS != TASK_COMPLETED`.
4. `VERIFICATION_PASS != REVIEW_PASS`.
5. Machine-checkable facts are verified deterministically before model judgment where practical.
6. Dependent lifecycle mutations are sequential and followed by read-back.
7. No `WAITING_FOR_INPUT` without classification.
8. Technical/recoverable uncertainty is handled by deterministic recovery or Advisor; only a true Human Gate reaches the user.
9. Required lifecycle notifications are deterministic Soc_brain side effects, not executor memory.
10. A terminal notification corresponds to a real canonical terminal transition.
11. Review and execution evidence must be bound to canonical repository/task/issue/head/session identity and fail closed on mismatch.
12. Gemini PASS never substitutes for final review when final review is required.
13. Executors and reviewers are replaceable; canonical state is not.
14. No model output directly overrides policy, authority boundaries, or deterministic evidence.
15. **Executor occupancy, blocking, failure, restart, disconnection, or replacement must not block Soc_brain from receiving new intent/evidence or retaining canonical authority.**
16. **Canonical task/session/lifecycle authority must not depend on the lifetime or interactive availability of an executor process.**
17. **Projection is disposable; authority is not.** Runtime/config/context projections must be reconstructible from canonical authority where practical and must not silently become canonical truth.
18. Authority-bound runtime projections must fail closed on unauthorized divergence and recover only through policy-governed mechanisms.
19. Software agents, services, applications, devices, and physical embodiments remain capabilities under one Soc_brain control plane; they do not establish parallel canonical lifecycle authority.

## 8. Engineering principles

### Harness over model dependence

Soc_brain's durable advantage should come from context engineering, interfaces, constraints, verification, recovery, observability, and learning—not from dependence on one model.

### Design for replacement, optimize for the current executor

Cline, OpenCode, GPT, Gemini, transports, external services, and physical/digital capabilities can change. Keep authority and canonical state in Soc_brain; optimize current integrations without coupling the architecture to them.

### Minimum sufficient change

Current Issue/task scope outranks speculative architecture. Build the smallest change that advances the current capability and preserves invariants.

### Goal-oriented capability design

Place a capability at the correct layer:

- core invariant/state authority → Soc_brain code/policy;
- dangerous or structured authority boundary → dedicated tool;
- repeatable procedural knowledge → Skill;
- exploratory/general execution → generic executor;
- semantic reasoning → model;
- machine-checkable fact → deterministic verifier;
- physical or external action → replaceable capability/adapter under Soc_brain authority.

Do not MCP-ize every capability.

### Minimum sufficient context

Models should receive the smallest context and capability surface that preserves task success. Persist full artifacts outside the prompt and disclose them on demand.

### Evidence before intuition

Routing, model selection, recovery, and learning should progressively move from preference to measured evidence.

### Event-driven autonomy

Long-running work must survive model/executor/session interruption. Canonical state, checkpoints, evidence, and events—not a single long conversation—are the continuity mechanism.

### Continuous cognitive availability

Execution and cognition/supervision must not share a single blocking dependency. Soc_brain should be able to observe, receive new information, and make policy decisions while delegated work remains in progress.

### Policy-governed self-recovery

Recovery is an authority-bearing action. Automate deterministic recovery only when its preconditions, allowed mutations, verification, and failure behavior are explicit. Otherwise fail closed or escalate appropriately.

### Learning changes future behavior

Validated experience should improve future behavior through the narrowest appropriate mechanism and should produce regression/evaluation evidence where practical. Do not equate storage with learning.

### One brain, many capabilities

Coding is the first proving domain, not the architectural boundary. Software agents, tools, services, applications, devices, and robots may expose capabilities, while Soc_brain retains goal interpretation, policy, lifecycle authority, supervision, and canonical state.

### Human attention is scarce

The user should set goals and resolve genuine business/security/owner gates, not act as message bus, process supervisor, or technical router.

## 9. Product success criteria

Soc_brain succeeds when increasingly broad real tasks can satisfy all of the following:

- the user states the outcome once;
- Soc_brain determines or validates the plan;
- the correct executor/model/tool/capability is selected without manual setup;
- workspace and task identity remain canonical;
- execution is observable and resumable;
- Soc_brain remains responsive to new intent/evidence while delegated work is active;
- executor failure or occupancy does not remove control-plane authority;
- safe interruption/replanning/recovery is possible where supported and policy-authorized;
- results are deterministically verified where possible;
- semantic review is invoked only where useful;
- rework is automatically routed;
- delivery, read-back, cleanup, and terminalization are correct;
- only true Human Gates interrupt the user;
- each trajectory produces evaluable evidence;
- validated experience changes future behavior through appropriate mechanisms;
- recurring validated failures increasingly become guarded, recoverable, or regression-tested;
- quality improves while human intervention, latency, token use, and cost trend downward for comparable task classes.

## 10. Scope discipline

This North Star is a decision framework, not a requirement to implement every capability immediately.

Precedence for implementation decisions:

1. current canonical Issue/task;
2. technical contracts and safety invariants;
3. current milestone exit criteria;
4. Master Roadmap;
5. this North Star.

The North Star should prevent architectural drift without forcing premature generalization.

Continuous cognitive availability, physical capability abstraction, supervisory control, and self-recovery are strategic requirements, not instructions to expand the scope of an unrelated current Issue.

## 11. Explicit non-goals for the current horizon

- no generic swarm/multi-agent framework without measured need;
- no model post-training while harness improvements offer materially higher ROI;
- no SuperAssistant dependency in the critical path;
- no requirement that OpenCode or Cline be permanently primary;
- no uncontrolled proliferation of MCP tools;
- no raw-memory-to-policy learning;
- no automation that removes meaningful Human Gates;
- no speculative platform framework ahead of the next proven capability;
- no requirement to implement a full interrupt/supervisor subsystem before the current OpenCode proving path is stable;
- no device/robot-specific control plane parallel to Soc_brain.

---

**North Star v2.1.0 supersedes v2.0.0. It preserves the adaptive personal-AI control-plane direction while making continuous cognitive availability, independent supervision, policy-governed recovery, behavioral learning, projection/authority separation, and substrate-independent capabilities explicit strategic requirements.**
