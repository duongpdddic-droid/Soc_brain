# AI_PR_REVIEWER Shared Infrastructure Inventory

## Source Pin
- **Repository**: `duongpdddic-droid/AI_PR_REVIEWER`
- **Immutable source SHA**: `9c104c88dddb3e9aad0388447e9be6ff74f78a06`
- **Runtime Target**: `C:\Users\Admin\.soc-brain\`

## Boundary Definition
- **Soc_brain**: runtime, identity, and orchestration for personal AI assistant.
- **AI_PR_REVIEWER**: reviewer-specific policy, approval, verification, and review evidence.
- **Shared**: components that provide infrastructure (identity, guards, hygiene, intake, orchestration) usable by both.
- **Review-specific**: components tied exclusively to PR review workflow (policy, approval, verify, evidence).

## Explicit Exclusions (Verified Non-Existent at Source SHA)
The following source paths existed in AI_PR_REVIEWER at `9c104c88` but are **NOT ported** to Soc_brain:
- `scripts/registry-identity.mjs` — not present in source SHA
- `scripts/git-guards.mjs` — replaced by `pre-push-guard.mjs` and related hooks
- `scripts/head-read-back.mjs` — functionality folded into Git guard mechanisms
- `scripts/secret-guard.mjs` — moved to `.clinerules/04-security-and-secrets.md` policy

## Runtime/Source/Secrets Boundary
- **Runtime/Soc_brain**: orchestration, identity layer, session management, temp hygiene
- **Source/AI_PR_REVIEWER**: pre-push guard, GitHub task intake, telegram gateway, MCP task server
- **Secrets**: governed by `.clinerules/04-security-and-secrets.md` (tool-independent, not ported verbatim)

## Migration Phases (Consensus)

| Phase | Target | Description |
|-------|--------|-------------|
| Phase 1 | Identity | Port `project-registry.mjs` + fixtures; adapt remote paths |
| Phase 2 | Git Safety | Extract/push `pre-push-guard.mjs` from shared Git guard |
| Phase 3 | Cleanup | Port `temp-hygiene.mjs` and adapt token paths |

## Inventory at File/Symbol Level

### Source Files from `9c104c88dddb3e9aad0388447e9be6ff74f78a06` (Verified Present)

| File | Classification | Dependencies | Target Proposal | Adaptation | Parity Fixture/Test | Migration Phase |
|------|---------------|-------------|-----------------|------------|---------------------|-----------------|
| `scripts/project-registry.mjs` | **Registry** (Shared) | `node`, `fs`, `path`; uses `HOME%\.ai-pr-reviewer\registry.json` | Soc_brain identity layer | Replace `\.ai-pr-reviewer` with `\.soc-brain\registry.json`; keep schema and ownership matrix | `test-project-registry.mjs` 43/43 PASS | Phase 1 |
| `scripts/fixtures/project-registry/*.json` | **Registry** (Shared) | `project-registry.mjs` | Soc_brain identity layer | Replace remote `duongpdddic-droid/QLDA_DTXD` with canonical Soc_brain remote; keep schema | `test-project-registry.mjs` 43/43 PASS | Phase 1 |
| `scripts/pre-push-guard.mjs` | **Git Safety** | `node`, `child_process`, `project-registry.mjs` | Soc_brain safe Git guards | Keep guard logic; adapt remote canonical check | `test-pre-push-guard.mjs` (new, evidence required) | Phase 2 |
| `scripts/temp-hygiene.mjs` | **Cleanup** (Shared) | `node`, `fs`, `path`, `process` | Soc_brain runtime hygiene | Replace session root with Soc_brain temp directory; keep ownership marker pattern | `test-temp-hygiene.mjs` 43/43 PASS | Phase 3 |
| `scripts/github-task-intake.mjs` | **Task Intake** (Shared, pre-port) | `node`, `child_process`, `project-registry.mjs` | Soc_brain task intake | Parse before porting; extract shared patterns | New fixture for Soc_brain task intake | Phase 1-2 |
| `scripts/telegram-gateway/*` | **Messaging** (Adapter/Call-through) | `node`, `axios`, `telegram-bot-sdk` | Soc_brain notification layer | Adapter pattern; call-through to telegram API | `test-telegram-gateway.mjs` | Phase 2 |
| `mcp-task-server/*` | **MCP Tools** (Shared, split) | `node`, `mcp`, `stdio` | Review-specific MCP server | Split shared from review-specific configurations | `test-server.mjs` | Phase 2-3 |
| `.clinerules/*` | **Policy Documents** | (tool-independent) | Extract rules, do not port verbatim | Convert to Soc_brain conventions | Documentation only | Phase 1 |
| `scripts/full-verify.mjs` | **Review-Specific** | `node`, `child_process`, `gpt-approval.mjs` | AI_PR review workflow | Keep at AI_PR repository | Test evidence files only | N/A (stay in AI_PR) |
| `scripts/gpt-approval.mjs` | **Review-Specific** | `openai`, `node` | AI_PR approval gate | Keep at AI_PR repository | Test evidence files only | N/A (stay in AI_PR) |

## Parity Test Evidence Files (Exclusions Only)

Test evidence files exist at source SHA but are **excluded from Soc_brain parity tests**:
- `mcp-test-evidence/server.mjs` — review-specific evidence
- `scripts/test-evidence-*.mjs` — review workflow evidence
- `scripts/test-*.mjs` — existing source tests (not ported)

## Fixture Preservation

**Do NOT replace QLDA project fixture with Soc_brain.**
- Keep original fixture: `scripts/fixtures/project-registry/qlda-dtxd.json`
- Add new fixture: `scripts/fixtures/project-registry/soc-brain.json`

## Verification Required

Parity tests must be created before claiming PASS. All test fixtures and evidence files must have corresponding verification in Soc_brain.

---
*Note: This inventory was verified at immutable SHA `9c104c88` before documentation. Source paths confirmed via `git ls-tree -r --name-only FETCH_HEAD`.*