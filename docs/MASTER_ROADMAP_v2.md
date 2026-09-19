# Soc_brain Master Roadmap v2 — Bootstrap to Self-Improvement

Status: Proposed canonical roadmap  
Date: 2026-09-19  
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

### S3 — Restore usable Web2API

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

### S4 — Final Review transaction

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

### S5 — Bootstrap Exit: one real autonomous delivery

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
