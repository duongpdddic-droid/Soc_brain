# Triad Handoff Protocol

Status: proposal for future Soc_brain tasks. The deterministic validators and current runtime schemas remain authoritative. This document does not change an in-flight task or grant merge/deploy authority.

## Purpose

Give Executor, Reviewer, Advisor, ControlLoop and Operator one small communication contract. Keep evidence precise enough to reproduce failures while avoiding ceremony that does not reduce a concrete risk.

## Authority

| Actor | May do | May not do |
| --- | --- | --- |
| Executor | Implement within task scope, test, commit/push a task branch, submit review evidence and rework | Self-approve, bypass ownership/binding, merge or deploy |
| Reviewer | Independently inspect the exact changeset and evidence, report PASS/REWORK/BLOCKED through the runtime schema | Infer success from an Executor summary alone; merge or deploy |
| Advisor | Diagnose a verified finding and recommend a concrete repair preserving invariants | Override a deterministic gate or present an unverified guess as fact |
| ControlLoop | Validate binding, route states, retry only where policy allows, deliver the review result | Invent evidence or silently convert uncertainty into PASS |
| Operator | Authorize merge/deploy and decide architectural exceptions | None delegated by this document |

A PASS is a review decision, not merge authorization. The runtime human gate remains mandatory.

## 1. Executor handoff

Use the current task contract and review-ready producer. Include:
- Repository, issue (when one exists), PR, task branch, exact local and remote HEAD, and the binding expected by the review transport.
- Source access: PR/diff for that HEAD. A summary without inspectable source is insufficient.
- Verification: command, environment relevant to interpretation, exit code, counts and log/artifact path. Report failures, skips and tests not run explicitly.
- Exceptions: classify each failed test as a changeset regression, a demonstrated pre-existing failure, an environmental failure, or UNKNOWN; attach the distinguishing evidence. UNKNOWN is never silently called PASS.
- Scope and remaining risk, in a short summary. Narrative is welcome for orientation but does not replace evidence.

Run affected targeted tests and required repository gates. Expand only for a concrete risk or a required gate. A full suite with failures needs classification; do not claim an unconditional all-tests PASS.

Bind each review payload to one exact HEAD and request digest. A later code commit creates a new review version: refresh the diff/evidence/digest and read back remote HEAD. Do not review a stale bundle. This is a version rule, not a ban on rework commits.

## 2. Independent review

Verify the PR's actual HEAD and changeset before interpreting reports. Distinguish FACT (read back), INFERENCE (reasoned from facts), and UNKNOWN (not established). Review all substantive findings in one pass and rank them; return at most the ten most consequential actionable findings to avoid overloading the FSM.

Use the parser's current strict response schema. At this revision it accepts verdict `PASS`, `REWORK` or `BLOCKED`; `findings` and `evidenceRequests` are string arrays; `confidence` is a number; the exact binding is echoed in `binding`; `requestDigest` is echoed in `metadata.requestDigest`. Do not substitute `APPROVED`/`CHANGES_REQUESTED` for the FSM verdict or put the digest in a different field. If the parser changes, update its producer, consumer and tests together; this document does not define a competing JSON schema.

A changeset regression or breached invariant warrants REWORK/BLOCKED according to the runtime decision contract. A demonstrated pre-existing or environmental failure is reported with its limits; do not assign it to the changeset. Missing critical evidence prevents PASS, with a specific evidence request. Do not require an independent terminal log for every task unless the acceptance criteria or identified risk needs one.

## 3. Advisor consultation

For each verified finding, state: observed behavior and evidence; root cause or UNKNOWN; one preferred minimal repair; precise affected files/seams; invariants to retain; and a regression test that would fail before the repair and pass after it. More than one file may be necessary for a correct repair.

When evidence does not distinguish two causes, request the smallest diagnostic check first. Do not force a one-file patch or a thin wrapper where it would bypass a guard. Never recommend weakening worktree containment, owner identity, session admission, token fencing or test requirements to make a task appear green.

## 4. Human gate

After validated PASS and matching HEAD/binding, ControlLoop may produce a concise handoff with PR, exact HEAD, review decision, test summary and residual risks. Stop at the existing human gate; the Operator alone authorizes merge/deploy. Review-requested labels do not mean approved, and approval does not trigger an automatic merge.

## Evolution

Keep this document small. Stable roles and evidence rules live here; exact JSON shapes, state names, limits and retry logic are enforced and tested in their owning modules. Change the protocol when a reproduced failure shows the current rule is insufficient, and measure improvement by fewer avoidable rework rounds and shorter time to a correct handoff.
