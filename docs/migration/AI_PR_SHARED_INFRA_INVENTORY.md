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

## Inventory at File/Symbol Level

### Source Files from `9c104c88dddb3e9aad0388447e9be6ff74f78a06`

| File | Classification | Dependencies | Target Proposal | Adaptation | Parity Fixture/Test | Migration Phase |
|------|---------------|-------------|-----------------|------------|---------------------|-----------------|
| `scripts/project-registry.mjs` | **Shared** | `node`, `fs`, `path`; uses `HOME%\.ai-pr-reviewer\registry.json` | Soc_brain identity layer | Replace `\.ai-pr-reviewer` with `\.soc-brain\registry.json`; keep schema and ownership matrix | `test-project-registry.mjs` 43/43 PASS | Phase 1 |
| `scripts/fixtures/project-registry/*.json` | **Shared** | `project-registry.mjs` | Soc_brain identity layer | Replace remote `duongpdddic-droid/QLDA_DTXD` with canonical Soc_brain remote; keep schema | `test-project-registry.mjs` | Phase 1 |
| `scripts/registry-identity.mjs` | **Shared** | `project-registry.mjs`, `node` | Soc_brain identity layer | Adapt to Soc_brain canonical remote | New fixture for Soc_brain identity | Phase 1 |
| `scripts/git-guards.mjs` | **Shared** | `node`, `child_process` | Soc_brain safe Git guards | Keep guard logic; adapt remote canonical check | `test-git-guards.mjs` (new) | Phase 2 |
| `scripts/head-read-back.mjs` | **Shared** | `node`, `child_process` | Soc_brain HEAD read-back | Keep SHA verification; adapt to Soc_brain refs | `test-head-read-back.mjs` (new) | Phase 2 |
| `scripts/temp-hygiene.mjs` | **Shared** | `node`, `fs`, `path`, `process` | Soc_brain runtime hygiene | Replace session root with Soc_brain temp directory; keep ownership marker pattern | `test-temp-hygiene.mjs` 43/43 PASS | Phase 3 |
| `scripts/secret-guard.mjs` | **Shared** | `node`, `fs`, `child_process` | Soc_brain shared secret hygiene | Keep regex patterns; adapt to Soc_brain token paths | `test-secret-guard.mjs` (new) | Phase 3 |