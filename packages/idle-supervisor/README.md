# @soc-brain/idle-supervisor

Idle Hibernate Supervisor — companion service of the Soc_brain runtime. Read-only
over the canonical control plane; when the whole canonical workload is provably
idle for the policy grace it puts Windows into Hibernate. There is no Sleep/S3
action and no Sleep fallback.

## Invariants

1. **Read-only observer.** Never mutates session records, FSM ledgers, GitHub,
   workspaces or sessions. Its only writes live under
   `~/.soc-brain/state/idle-supervisor/` (evidence + bounded log).
2. **Canonical + liveness authority.** Activity is derived from canonical session
   records, the control-loop transition ledger, canonical execution records AND a
   set of registered executor/agent liveness leases
   (`~/.soc-brain/state/activity/live/<identityHash>.json`). A lease is trusted
   only when its process identity is proven (pid + immutable Win32
   `processStartTime` + boot id) — a bare PID is never authority (PID-reuse-safe).
   A positively-live registered executor keeps the machine BUSY even when no
   control-loop ledger / execution lifecycle record was materialized (Issue #172
   F1: the incident executor left no lifecycle footprint and was invisible). The
   supervisor only READS the registry; it never writes/clears leases and never
   becomes a mutation owner.
3. **Fail-closed on UNKNOWN.** Any unreadable/ambiguous/malformed canonical or
   lease state => `HIBERNATE_DENIED_UNKNOWN_ACTIVITY` => no hibernate. An old
   `SESSION_ACTIVE` record with no ledger/execution/lease is treated as
   UNKNOWN (deny), never INACTIVE "by age": a session is settled INACTIVE only by
   authoritative terminal / proven-gone (reaper) proof (Issue #172 F3).
4. **Exactly one hibernate per decision.** Durable evidence
   (`hibernate-evidence.json`, `event=HIBERNATE_IDLE_CONFIRMED`) is persisted
   BEFORE the OS call; a crash between evidence and dispatch suppresses any
   further request until the machine demonstrably resumes.
5. **Hibernate only.** `SetSuspendState 1,1,0` — Hibernate flag is 1, Sleep is
   never requested. A non-mutating `powercfg /a` capability preflight runs
   BEFORE any evidence/dispatch: if Hibernate is unavailable the decision fails
   closed as `HUMAN_GATE_REQUIRED` (the admin action `powercfg /hibernate on` is
   REPORTED, never executed by the supervisor) and no Sleep is attempted. The
   real power action additionally requires the explicit production flag
   `SOC_IDLE_HIBERNATE_ALLOW_REAL=1`; without it the request is a dry-run.
6. **Machine-global singleton.** Exactly one supervisor owns the hibernate
   authority per machine. The lock (`pid + processStartTime + bootId +
   acquiredAt + owner metadata`) lives in the machine namespace
   `~/.soc-brain/machine/idle-supervisor/supervisor.lock` — never keyed on a
   per-repo/worktree `SOC_STATE_DIR`. A live foreign owner makes a second
   daemon exit harmlessly (no kill, no unlink); stale reclaim requires proof
   (dead pid / startTime mismatch / bootId mismatch) and is SERIALIZED by a
   DIRECTORY-EPOCH reclaim authority (`supervisor.reclaim/authority.slot.d/`
   with generation-bound claim names): stale claims are retired only through
   their own name (bytes preserved via quarantine-link), epochs open/close
   through mkdir/rmdir CAS (rmdir's ENOTEMPTY atomically fences live claims),
   and a stale decision structurally cannot reach a replacement generation —
   no shared mutable name, no wall-clock/pid/name ordering, concurrent
   reclaim fails closed.
    Launchers pre-check the lock before spawning.
7. **Machine/action authority (Issue #172 F5).** A machine-GLOBAL power action is
   only authorized when the daemon governs a machine-GLOBAL activity view:
   `assertPowerAuthority` grants real power ONLY for the canonical single
   `~/.soc-brain/state` root, so a daemon pointed at a non-canonical
   `SOC_STATE_DIR` (a worktree/override root) is forced to a dry-run and never
   touches the OS. `assertActionAuthority` binds the deployed action to the
   authorized mode: the running build's only power verb must be Hibernate; a
   stale build that exposes a Sleep verb (or lacks Hibernate) cannot hold
   Hibernate authority (fails closed). The eligibility decision is bound to a
   monotonic activity `generation`; a finalize whose generation no longer matches
   (activity appeared after eligibility), or whose final scan is stale
   (`scannedAt` older than 30s vs the decision), or that sees any UNKNOWN/active
   record / live lease, is rejected — no delayed reuse of an earlier PASS (F4).

## Contract

```
IDLE
  -> HIBERNATE_ELIGIBLE        (clean canonical + live-lease + operator idle (DAY/NIGHT both) >= grace)
  -> preflight powercfg /a      (F4: FIRST, so the probe never widens scan->OS; else HUMAN_GATE_REQUIRED)
  -> FINAL machine-authority scan (F4: fresh, bound to eligibility generation)
  -> persist hibernate-evidence (BEFORE any OS call; carries bound generation)
  -> HIBERNATE_REQUESTED        (REQUEST_HIBERNATE dispatched exactly once)
  -> OS Hibernate
  -> RESUME_REINITIALIZED       (boot id re-read, canonical re-scan, windows restart)
```

## Policy

- ACTIVE canonical states: `EXECUTING VERIFYING PRE_REVIEWING FINAL_REVIEWING
  REWORK DECIDING DELIVERING RECOVERING MCP_RECOVERING`, plus any pending
  executor dispatch / CWA review-finality / delivery / recovery / ownership
  window (all surfaced through ledger tail + execution record), AND any
  positively-live registered executor lease (F1).
- INACTIVE: `COMPLETED FAILED BLOCKED HUMAN_GATE_REQUIRED WAITING_FOR_INPUT` —
  only via authoritative terminal / proven-gone proof (F3).
- DAY (default 06:00–00:00, Windows local timezone): clean + operator idle >= 20m.
- NIGHT (default 00:00–06:00): clean + continuously clean >= 10m AND operator
  idle >= 10m. NIGHT keeps its shorter canonical-clean grace but NEVER overrides
  recent human input (F2, Issue #172): an unmeasurable idle probe is never idle.
- Before hibernate: the capability preflight runs first, then a FRESH final
  canonical read-back re-confirms every zero-condition on the machine-authority
  scan, bound to the eligibility generation; one UNKNOWN / active lease / stale
  scan / generation drift aborts (F4).

## Config (env)

Canonical names use `SOC_IDLE_HIBERNATE*`. The legacy `SOC_IDLE_SLEEP*` names are
still READ as a compatibility alias (deprecated, not removed) so an existing
production daemon keeps supervising after upgrade — now with Hibernate and no
Sleep fallback.

| Var | Default | Meaning |
| --- | --- | --- |
| `SOC_IDLE_HIBERNATE` | `0` | `1` explicitly enables the supervisor (alias: `SOC_IDLE_SLEEP`) |
| `SOC_IDLE_HIBERNATE_DAY_GRACE_MIN` | `20` | DAY user-idle grace (minutes) |
| `SOC_IDLE_HIBERNATE_NIGHT_START` | `00:00` | NIGHT window start (local) |
| `SOC_IDLE_HIBERNATE_NIGHT_END` | `06:00` | NIGHT window end (local) |
| `SOC_IDLE_HIBERNATE_NIGHT_GRACE_MIN` | `10` | NIGHT continuous-clean grace |
| `SOC_IDLE_HIBERNATE_POLL_SEC` | `30` | poll interval |
| `SOC_IDLE_HIBERNATE_ALLOW_REAL` | `0` | production flag: allow the real OS Hibernate (alias: `SOC_IDLE_SLEEP_ALLOW_REAL_SLEEP`) |
| `SOC_STATE_DIR` | `~/.soc-brain/state` | canonical control-plane state dir |
| `SOC_IDLE_SUPERVISOR_MACHINE_DIR` | `~/.soc-brain/machine/idle-supervisor` | singleton lock namespace (machine-global; override for tests only) |

## Run

```powershell
# non-mutating capability read-back (never enables/disables anything)
powercfg /a

# companion mode (spawned by the control-ui launcher when SOC_IDLE_HIBERNATE=1)
node packages/idle-supervisor/run.mjs --daemon

# single read-only tick (never hibernates; power action is dry-run without the flag)
node packages/idle-supervisor/run.mjs --once

# activation read-back (enabled=true expected after SOC_IDLE_HIBERNATE=1 + restart)
node packages/idle-supervisor/run.mjs --status
```

After wake the supervisor re-reads boot identity, re-scans canonical state and
health, and restarts every idle window. Automated tests inject a fake power
executor; they can never hibernate the real machine.

## Why the previous auto-sleep did not fire (Issue #172 investigation)

The auto action can fail to dispatch for reasons that are all outside the
eligibility logic itself, and all remain true after the Hibernate switch:

1. **Daemon not running.** The companion only spawns when the control-ui
   launcher runs with `SOC_IDLE_SLEEP=1` (now `SOC_IDLE_HIBERNATE=1`). If the
   env is not set in the launching shell/service, nothing supervises.
2. **Inert power action (double gate).** Even while running, the OS action is a
   dry-run unless the separate `..._ALLOW_REAL_SLEEP=1` (now
   `SOC_IDLE_HIBERNATE_ALLOW_REAL=1`) flag is set — the request is logged but
   the machine is never powered down.
3. **Fail-closed on any UNKNOWN.** A single unreadable/ambiguous canonical
   session record (leftover worktree/session, torn ledger) sets
   `known=false` and denies the action indefinitely.
4. **DAY idle never measured.** In DAY policy the OS user-idle probe
   (`GetLastInputInfo`) must return >= 20m; a null/unmeasurable probe keeps the
   state at `WAIT_USER_IDLE`.

## Issue #172 safety rework (live S3-over-running-task incident)

A production daemon (built from a pre-#172 SLEEP build, not this Hibernate build)
put the machine to **S3 Sleep** while an interactive executor was live: the
canonical scan reported 0 active for ~10 minutes because the running task had NO
canonical lifecycle footprint and the NIGHT policy ignored OS user-idle. This
rework closes it (all deterministic, no real OS power in tests):

- **F1** the scan now also observes registered executor/agent liveness leases
  (`activity/live/<identityHash>.json`, PID-reuse-safe identity) — a live lease is
  BUSY even with no lifecycle record.
- **F2** operator presence is required in NIGHT too; recent input never sleeps.
- **F3** abandoned `SESSION_ACTIVE` records are UNKNOWN/deny, never INACTIVE by
  age; only authoritative terminal / proven-gone settles them.
- **F4** preflight runs before the final machine-authority scan, which is bound to
  an activity generation; stale PASS / generation drift / UNKNOWN → no OS call.
- **F5** real power requires the canonical single stateDir root AND an action
  identity that is Hibernate-only (a Sleep build cannot masquerade).

Writer responsibility (implemented): the shared MCP broker boundary —
`packages/runtime-sandbox/mcp-server.mjs` (which OpenCode AND Cline both connect to
for every canonical mutation) registers a lease in its production entry (`main()`)
via `packages/runtime-sandbox/activity-lease.mjs`: `createExecutorLiveness()`
publishes `activity/live/<identityHash>.json` (`{ identityHash, repo, issueNumber,
pid, processStartTime, bootId, heartbeatAt }`) at the authoritative
`verifySessionAuthority` bind, refreshes it on each handled request, and retires it
(identity-guarded) on clean exit / stdin close / SIGTERM / SIGINT. The supervisor
remains a strict reader; the writer owns no mutation authority and never touches
the FSM. A crashed broker's lease is settled by the reader as `GONE` (pid dead) or
`REUSED`/`UNPROVEN` (identity unbound), so a lingering file can never falsely hold
the machine BUSY forever nor be blind-deleted over a newer incarnation.
