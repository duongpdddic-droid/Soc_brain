# @soc-brain/idle-supervisor

Idle Sleep Supervisor — companion service of the Soc_brain runtime. Read-only
over the canonical control plane; when the whole canonical workload is provably
idle for the policy grace it puts Windows to Sleep (never Hibernate).

## Invariants

1. **Read-only observer.** Never mutates session records, FSM ledgers, GitHub,
   workspaces or sessions. Its only writes live under
   `~/.soc-brain/state/idle-supervisor/` (evidence + bounded log).
2. **Canonical authority only.** Activity is derived from canonical session
   records, the control-loop transition ledger and canonical execution records.
   Process names/PIDs are never an authority (supplemental projection only).
3. **Fail-closed on UNKNOWN.** Any unreadable/ambiguous/malformed canonical
   state => `SLEEP_DENIED_UNKNOWN_ACTIVITY` => no sleep.
4. **Exactly one sleep per decision.** Durable evidence
   (`sleep-evidence.json`, `event=SLEEP_IDLE_CONFIRMED`) is persisted BEFORE
   the OS call; a crash between evidence and dispatch suppresses any further
   request until the machine demonstrably resumes.
5. **Sleep only.** `SetSuspendState 0,1,0` — Hibernate flag is 0. The real
   power action requires the explicit production flag
   `SOC_IDLE_SLEEP_ALLOW_REAL_SLEEP=1`; without it the request is a dry-run.
6. **Machine-global singleton.** Exactly one supervisor owns the sleep
   authority per machine. The lock (`pid + processStartTime + bootId +
   acquiredAt + owner metadata`) lives in the machine namespace
   `~/.soc-brain/machine/idle-supervisor/supervisor.lock` — never keyed on a
   per-repo/worktree `SOC_STATE_DIR`. A live foreign owner makes a second
   daemon exit harmlessly (no kill, no unlink); stale reclaim requires proof
   (dead pid / startTime mismatch / bootId mismatch) and is SERIALIZED by
   generation-immutable reclaim authority (`supervisor.reclaim/lease-*.lock`,
   authority = OLDEST LIVE record — a late claimant can never preempt an
   established authority; corrupt/dead records are deleted only by their exact
   immutable paths) — concurrent reclaim yields or fails closed, and no live
   authority is ever unlinked.
   Launchers pre-check the lock before spawning.

## Policy

- ACTIVE canonical states: `EXECUTING VERIFYING PRE_REVIEWING FINAL_REVIEWING
  REWORK DECIDING DELIVERING RECOVERING MCP_RECOVERING`, plus any pending
  executor dispatch / CWA review-finality / delivery / recovery / ownership
  window (all surfaced through ledger tail + execution record).
- INACTIVE: `COMPLETED FAILED BLOCKED HUMAN_GATE_REQUIRED WAITING_FOR_INPUT`.
- DAY (default 06:00–00:00, Windows local timezone): clean + user idle >= 20m.
- NIGHT (default 00:00–06:00): clean + continuously clean >= 10m; user idle
  NOT required; new work resets the countdown.
- Before sleep: fresh final canonical read-back re-confirms every
  zero-condition; one UNKNOWN aborts.

## Config (env)

| Var | Default | Meaning |
| --- | --- | --- |
| `SOC_IDLE_SLEEP` | `0` | `1` explicitly enables the supervisor |
| `SOC_IDLE_SLEEP_DAY_GRACE_MIN` | `20` | DAY user-idle grace (minutes) |
| `SOC_IDLE_SLEEP_NIGHT_START` | `00:00` | NIGHT window start (local) |
| `SOC_IDLE_SLEEP_NIGHT_END` | `06:00` | NIGHT window end (local) |
| `SOC_IDLE_SLEEP_NIGHT_GRACE_MIN` | `10` | NIGHT continuous-clean grace |
| `SOC_IDLE_SLEEP_POLL_SEC` | `30` | poll interval |
| `SOC_IDLE_SLEEP_ALLOW_REAL_SLEEP` | `0` | production flag: allow the real OS Sleep |
| `SOC_STATE_DIR` | `~/.soc-brain/state` | canonical control-plane state dir |
| `SOC_IDLE_SUPERVISOR_MACHINE_DIR` | `~/.soc-brain/machine/idle-supervisor` | singleton lock namespace (machine-global; override for tests only) |

## Run

```powershell
# companion mode (spawned by the control-ui launcher when SOC_IDLE_SLEEP=1)
node packages/idle-supervisor/run.mjs --daemon

# single read-only tick (never sleeps; power action is dry-run without the flag)
node packages/idle-supervisor/run.mjs --once

# activation read-back (enabled=true expected after SOC_IDLE_SLEEP=1 + restart)
node packages/idle-supervisor/run.mjs --status
```

After wake the supervisor re-reads boot identity, re-scans canonical state and
health, and restarts every idle window. Automated tests inject a fake power
executor; they can never sleep the real machine.
