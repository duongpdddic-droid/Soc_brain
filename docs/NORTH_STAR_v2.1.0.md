# Soc_brain North Star v2.1.0

Status: Canonical strategic baseline  
Version: 2.1.0  
Published: 2026-09-10

## 1. North Star

> **Soc_brain is the user's sole personal AI control plane: it understands the user's goal, turns that goal into executable work, selects and orchestrates the appropriate AI/tools, verifies outcomes and safely completes the lifecycle, then learns from validated experience so the next execution is faster, more accurate, cheaper, and requires less human intervention.**

Operational shorthand:

> **Give the goal once → execute to completion → verify → learn so the next run is better.**

The long-term product test is simple:

> **“Soc_brain, xử lý tiếp.”**

Soc_brain should know what “next” means from canonical project/task state, policy, prior validated experience, and the user's goals, without requiring the user to manually coordinate agents.

## 2. What Soc_brain is

Soc_brain is not another coding model and is not a wrapper around one executor. It is the persistent control plane above replaceable models, executors, tools, and communication channels.

Soc_brain owns:

- goal/task interpretation and canonical task state;
- Task FSM, policy, registry, routing, workspace/worktree/session authority;
- context construction and capability disclosure;
- execution orchestration;
- deterministic verification and evidence management;
- review orchestration and decision consumption;
- rework, delivery, read-back, cleanup, and terminalization;
- lifecycle notifications and Human Gate handling;
- memory coordination, evaluation, attribution, and validated learning;
- executor/model selection based on evidence rather than preference.

## 3. Authority model

### Soc_brain

**Sole control-plane authority.** Only Soc_brain may mutate canonical lifecycle state or terminalize a canonical task.

### User

Owns goals, business/value decisions, credentials or owner-only actions, destructive/security-sensitive approvals, and other true Human Gates.

### GPT-5.6 Sol

Advisor for strategic/complex reasoning and Final Reviewer when Soc_brain invokes it. GPT has high semantic influence but no direct lifecycle, merge, terminalization, or executor-dispatch authority.

### Gemini

Cheap sidecar/pre-reviewer and second opinion. Gemini may classify, summarize, pre-review, or prepare context. Gemini PASS is never final approval.

### Cline / OpenCode / future executors

Replaceable execution backends. They implement work and return structured results/evidence. They do not own canonical task completion.

## 4. Canonical control loop

```text
User goal
   ↓
Soc_brain admit / plan / route
   ↓
Canonical task + workspace/session
   ↓
Cline | OpenCode | future executor
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

GPT does not spontaneously push work to an executor. Soc_brain actively invokes reasoning/review services, validates their output, and decides what happens next.

## 5. Learning loop

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
Memory | Skill | Policy | Routing | Context strategy
        ↓
Re-evaluation on future tasks
```

Raw conversation history, accidental success, unverified model claims, and transient failures must not directly become behavioral policy.

Learning must be evidence-backed, attributable, reversible where practical, and measurable against future outcomes.

## 6. Core invariants

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
15. **A canonical task attempt has at most one active mutation owner.** Concurrent executors may observe or advise, but may not mutate the same attempt/workspace/branch unless Soc_brain explicitly transfers ownership. Ownership conflicts fail closed.

## 7. Engineering principles

### Harness over model dependence

Soc_brain's durable advantage should come from context engineering, interfaces, constraints, verification, recovery, observability, and learning—not from dependence on one model.

### Design for replacement, optimize for the current executor

Cline, OpenCode, GPT, Gemini, transports, and external services can change. Keep authority and canonical state in Soc_brain; optimize current integrations without coupling the architecture to them.

### Minimum sufficient change

Current Issue/task scope outranks speculative architecture. Build the smallest change that advances the current capability and preserves invariants.

### Goal-oriented capability design

Place a capability at the correct layer:

- core invariant/state authority → Soc_brain code/policy;
- dangerous or structured authority boundary → dedicated tool;
- repeatable procedural knowledge → Skill;
- exploratory/general execution → generic executor;
- semantic reasoning → model;
- machine-checkable fact → deterministic verifier.

Do not MCP-ize every capability.

### Minimum sufficient context

Models should receive the smallest context and capability surface that preserves task success. Persist full artifacts outside the prompt and disclose them on demand.

### Evidence before intuition

Routing, model selection, recovery, and learning should progressively move from preference to measured evidence.

### Artifact-driven progression

Canonical artifacts and validated state transitions—not prompts, chat history, or operator copy-paste—must drive the lifecycle. When an artifact satisfies a gate, Soc_brain determines and triggers the next policy-authorized action itself.

### Durable institutional knowledge

Reusable knowledge that affects execution quality must be moved from transient conversation into versioned, machine-readable, attributable artifacts: policy, Skills, contracts, evals, validated experience, or equivalent. Executor context is a working cache, not a system of record.

### Behavior is versioned and evaluated

Changes to models, prompts, Skills, policies, routing, context strategy, recovery logic, or any other behavior-shaping artifact must be versioned, attributable, and evaluated on representative real tasks before becoming trusted defaults. Deterministic evaluation is preferred wherever it is sufficient; AI review is not required for every change.

### Event-driven autonomy

Long-running work must survive model/executor/session interruption. Canonical state, checkpoints, evidence, and events—not a single long conversation—are the continuity mechanism.

Validated operational signals—incidents, control-band breaches, failed deliveries, recurring recovery patterns, or other policy-defined events—may create or reprioritize canonical work without requiring the user to manually restart the lifecycle. Such signals remain subject to the same authority, policy, and Human Gate boundaries.

### Human attention is scarce

The user should set goals and resolve genuine business/security/owner gates, not act as message bus, process supervisor, or technical router.

## 8. Product success criteria

Soc_brain succeeds when increasingly broad real tasks can satisfy all of the following:

- the user states the outcome once;
- Soc_brain determines or validates the plan;
- the correct executor/model/tool is selected without manual setup;
- workspace and task identity remain canonical;
- execution is observable and resumable;
- results are deterministically verified where possible;
- semantic review is invoked only where useful;
- rework is automatically routed;
- delivery, read-back, cleanup, and terminalization are correct;
- only true Human Gates interrupt the user;
- each trajectory produces evaluable evidence;
- validated experience improves later routing/context/procedures;
- quality improves while human intervention, latency, token use, and cost trend downward for comparable task classes.

## 9. Scope discipline

This North Star is a decision framework, not a requirement to implement every capability immediately.

Precedence for implementation decisions:

1. current canonical Issue/task;
2. technical contracts and safety invariants;
3. current milestone exit criteria;
4. Master Roadmap;
5. this North Star.

The North Star should prevent architectural drift without forcing premature generalization.

## 10. Explicit non-goals for the current horizon

- no generic swarm/multi-agent framework without measured need;
- no model post-training while harness improvements offer materially higher ROI;
- no SuperAssistant dependency in the critical path;
- no requirement that OpenCode or Cline be permanently primary;
- no uncontrolled proliferation of MCP tools;
- no raw-memory-to-policy learning;
- no automation that removes meaningful Human Gates;
- no speculative platform framework ahead of the next proven capability.

---

**North Star v2.1.0 strengthens artifact-driven progression, durable knowledge, behavioral evaluation, operational feedback, and single-owner execution without changing the v2 control-plane thesis.**
