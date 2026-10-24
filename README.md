# Soc_brain

Shared Second Brain Agent Platform. Private repository. No automatic merge or
deployment.

## Overview

Soc_brain is a control-loop orchestrator for AI coding agents. ControlLoop
(`packages/control-loop/`) walks each canonical task through a fixed FSM
(`ACCEPTED → ROUTED → EXECUTING → VERIFYING → PRE_REVIEWING → FINAL_REVIEWING →
DECIDING → {REWORK | DELIVERING | BLOCKED}`) and is the only component that may
terminalize a task, via a session-bound token that adapters never hold. See
`packages/control-loop/README.md` for the hard invariants.

Entrypoints:

- `packages/control-loop/run.js` — direct ControlLoop run (dry-run by default).
- `bin/soc-control-loop.mjs` — operator CLI (e.g. `--issue N`, `--bootstrap`,
  `--reconcile-pre-submit`).
- `start-control-ui.cmd` — double-click launcher for the Control UI.

## Prerequisites

- **Node.js >= 22** (`package.json` `engines`). Runtime dependency: `ws`
  (`npm install`).
- **Windows + PowerShell.** `start-control-ui.cmd` is a Windows batch file that
  runs a helper through `powershell.exe`; repo scripts under `scripts/` are
  PowerShell.
- Optional live transports: `GEMINI_API_KEY` (Gemini pre-review) and
  `SOC_CWA_FINAL_REVIEW=1` with `SOC_CWA_*` settings (ChatGPT Web Adapter final
  review). Without them the seams fail closed; see
  `docs/control-loop-runbook.md` §3.

## Quick start

```powershell
npm test            # T0 smoke tier (scripts/run-tier-tests.mjs t0)
npm run test:t1
npm run test:t2
npm run test:t3
npm run test:all    # all tiers; the script itself passes --authorize-full

# ControlLoop dry-run: binds, transitions, refuses to terminalize; nothing executes
node packages/control-loop/run.js --issue N --dry-run

# Real run (both --instruction and --lane are required with --no-dry-run)
node packages/control-loop/run.js --issue N --no-dry-run --instruction "TEXT" --lane LANE

# Control UI on http://127.0.0.1:3117/
.\start-control-ui.cmd
```

## Documentation

- [AGENTS.md](AGENTS.md) — executor rules (R1–R9).
- [docs/NORTH_STAR_v2.1.0.md](docs/NORTH_STAR_v2.1.0.md) — product north star.
- [docs/MASTER_ROADMAP_v2.md](docs/MASTER_ROADMAP_v2.md) — master roadmap.
- [docs/control-loop-runbook.md](docs/control-loop-runbook.md) — ControlLoop
  operator runbook (launch, FSM, evidence, operating environment).
- `docs/archive/` — archived, no longer current documents.
