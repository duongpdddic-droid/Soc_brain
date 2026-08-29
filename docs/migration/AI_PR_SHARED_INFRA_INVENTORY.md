# AI_PR_REVIEWER Shared Infrastructure Inventory

## Source pin

- Repository: `duongpdddic-droid/AI_PR_REVIEWER`
- Immutable source SHA: `9c104c88dddb3e9aad0388447e9be6ff74f78a06`
- Soc_brain runtime root: `C:\Users\Admin\.soc-brain\`
- Only files and symbols verified at the immutable source SHA are listed below.

## Ownership boundary

- **Soc_brain:** shared project identity, registry, safe execution primitives, runtime hygiene, task intake, orchestration, and adapters.
- **AI_PR_REVIEWER:** reviewer policy, approval protocol, review-specific HEAD lock, full reviewer verification, and Test Evidence.
- **Runtime and secrets:** stay outside both source repositories. Tokens, state, cache, artifacts, worktrees, and temporary files must never be committed.
- **Migration rule:** port or adapt symbols with provenance and parity fixtures; do not copy entire directories or rule sets verbatim.

## Discarded audit assumptions

These paths do not exist at the source SHA and are not valid provenance:

- `scripts/registry-identity.mjs`
- `scripts/git-guards.mjs`
- `scripts/head-read-back.mjs`
- `scripts/secret-guard.mjs`

No replacement or relocation is inferred from their absence. Relevant behavior must be traced to real symbols before migration.

## Migration matrix

| Source file / symbols | Classification | Verified dependencies | Soc_brain decision | Required adaptation | Parity requirement | Phase |
|---|---|---|---|---|---|---|
| `scripts/project-registry.mjs`: `validateManifest`, `scanForSecrets`, `scanForAbsolutePaths`, `detectConflicts`, `assertWorkspaceRemote`, `registerProject`, `assertSingleOwner`, `registryOutsideWorktree`, `migrateManifest` | Shared | Node built-ins: `fs`, `path`, `os`, `crypto`, `url`; project manifest schema | Port/adapt into project identity and registry | Change machine-local root from `.ai-pr-reviewer` to `.soc-brain`; preserve fail-closed validation and ownership rules | Adapt fixtures and rerun equivalent assertions from `scripts/test-project-registry.mjs` | 1 |
| `scripts/project-manifest-schema.json` and `scripts/fixtures/project-registry/*` | Shared fixtures/schema | `project-registry.mjs` | Port only the schema and fixtures needed for parity | Preserve existing multi-project fixtures; add a separate Soc_brain fixture rather than replacing QLDA fixtures | Validate positive, negative, conflict, path, secret, ownership, and migration cases | 1 |
| `scripts/github-task-intake.mjs`: `normalizeRemoteUrl`, `parseRepoFromRemoteUrl`, `remoteIsCanonical`, `branchSafetyCheck`, `baseSyncCheck`, `worktreeBlockers`, `runPreflight` | Mixed | Node built-ins and Git/GitHub CLI execution | Extract only tool-independent identity and safe-Git primitives | Remove hard-coded reviewer repository, labels, claim state, and Cline-specific behavior; keep fail-closed remote, branch, worktree, and base-SHA checks | Build focused Soc_brain fixtures for wrong remote, detached/active branch, dirty worktree, stale base, and sibling workspace | 2 and 4 |
| `scripts/pre-push-guard.mjs` | Review-specific/mixed | `review-contract.mjs`, `effective-policy.mjs`, Git and GitHub CLI | Keep in AI_PR during Kernel v0 | Do not port the guard wholesale. Any later generic push protection must be independently specified and tested | Use `scripts/test-pre-push-guard.mjs` only as source behavior evidence; create separate Soc_brain parity tests for extracted generic rules | 2 |
| `scripts/temp-hygiene.mjs`: `createSessionManager`, `cleanupSession`, `recoverSession`, ownership-marker, canonical-path, workspace-snapshot, and process-identity helpers | Shared | Node built-ins: `fs`, `path`, `os`, `child_process`, `crypto` | Port/adapt into runtime hygiene | Namespace under `.soc-brain` runtime; retain ownership checks, canonical containment, PID-scoped cleanup, recovery, and idempotency | Adapt and rerun equivalent assertions from `scripts/test-temp-hygiene.mjs` | 3 |
| `.clinerules/04-security-and-secrets.md`, `.clinerules/05-terminal-safety.md`, `.clinerules/08-temp-hygiene.md` | Mixed policy documents | None assumed | Extract tool-independent constraints only | Convert principles into Soc_brain contracts/tests; do not port Cline-specific wording or files verbatim | Trace every adopted rule to a deterministic check or explicit human gate | 2 and 3 |
| `scripts/telegram-gateway/*` | Shared transport with AI_PR-specific adapter | Dependencies must be verified from imports before implementation | Call through the existing gateway via a Soc_brain adapter during Kernel v0 | Keep Telegram auxiliary: final summary and NEEDS_INPUT only; no intake, approval, CI, merge, or deploy authority | Verify adapter contract and reuse source behavior from `scripts/test-telegram-gateway.mjs` without copying runtime credentials | 5 |
| `mcp-task-server/*` | Mixed orchestration/review integration | Dependencies must be verified from imports before implementation | Defer migration until shared and review-specific behavior is decomposed | Preserve read-only task queries separately from claim/approval/reviewer behavior | Use `mcp-task-server/test-server.mjs` as source evidence; define Soc_brain contract tests before porting | 5 |
| `scripts/full-verify.mjs`, `scripts/gpt-approval.mjs`, reviewer policy, approval protocol, and Test Evidence | Review-specific | AI_PR reviewer runtime and policy | Keep in AI_PR during the transition | Expose only an adapter/CLI contract to Soc_brain | AI_PR remains responsible for its own verification and HEAD-locked evidence | Not migrated |

## Migration phases

1. **Project identity and registry:** schema, validation, registry storage, ownership, conflicts, and canonical remote.
2. **Safe Git and HEAD read-back:** extract generic preflight primitives; do not move review-specific freeze/approval behavior.
3. **Runtime, temp, and shared secret hygiene:** external runtime root, containment, cleanup, recovery, and deterministic checks.
4. **Task intake primitives and AI_PR adapter:** shared intake after identity passes end to end; AI_PR stays an external reviewer.
5. **Telegram and MCP boundaries:** adapter/call-through first; decomposition or migration only after Kernel stability.

## Explicit exclusions for Kernel v0

- AI_PR reviewer policy and severity decisions
- GPT/human approval protocol
- Review-specific branch freeze and approval markers
- Full reviewer verification
- Test Evidence implementation and PR #24
- Memory Bank copied verbatim
- Cline rule files copied verbatim
- Router, Worktree Manager, CLI implementation, merge, and deployment

## Fixture and parity contract

- Preserve existing source fixtures; do not rewrite a QLDA fixture into a Soc_brain fixture.
- Add Soc_brain-specific fixtures separately.
- A source test name is provenance, not proof that adapted Soc_brain behavior passes.
- Each migration PR must record source file, source SHA, selected symbols, dependency changes, adaptation, deterministic parity command, and result.
- No module may claim parity until its adapted fixtures run against the PR HEAD.
- Verification must address the immutable full source SHA directly; do not rely on `HEAD`, working-tree state, or `FETCH_HEAD`.
