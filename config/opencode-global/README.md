# OpenCode global build hook

`plugins/build-superpowers-hook.ts` is the versioned source of the Operator's global hook at `%USERPROFILE%\.config\opencode\plugins\build-superpowers-hook.ts`.

This directory is outside OpenCode's project plugin discovery directory. Keeping the source here does not register a second hook. Install it by copying the file to the global path. Reload the OpenCode server only after active work has reached a safe checkpoint.

The hook targets the OpenCode v2.0.26 `session.hook("context")` contract, applies only to the `build` agent, and avoids duplicate context injection. It reminds build to load existing native skills; it does not install skills, change permissions, or prove a skill was invoked. Its instruction matches `SOC_BUILD_SUPERPOWERS_V2` in `.opencode/agents/build.md`.

## 9remote MCP removal

On 2026-10-18 the Operator supplied config read-back showing zero MCP keys normalized to `9remote` or `nineremote` in the global config and the checked Soc_brain/project-worktree configs. The tracked `.opencode/opencode.json` at this change's base contains only `soc-brain-gateway`; there is no tracked 9remote entry to delete. The machine-local root config and global config are not copied into this repository.

This records the configuration state. Runtime disconnection has not been verified and no server restart is performed by this change.

## OCR V2 repair

`plugins/open-code-review.ts` replaces the inspected global no-op stub, using OpenCode **v2.0.26** `tool.transform`, `ToolContext.signal`, session location and command APIs. It has no legacy plugin dependency. The global plugin remains outside project autoload until explicitly installed. Source derived from the Operator's Apache-2.0 backup; V1 support is intentionally excluded.

The runner executes the installed OCR Node wrapper without a shell. It drains both output streams, limits combined output to 10 MiB, applies a **3 minute default overall deadline** (explicit override 1–30 minutes) distinct from OCR's per-file `--timeout`, and propagates cancellation. It waits for child close and Windows taskkill completion, reporting `CLEANUP_UNVERIFIED` after 5 seconds if cleanup cannot be confirmed. No automatic retries. Empty or malformed output and health errors cannot become a clean review. JSON is preserved as OCR evidence; the plugin does not invent an approval verdict or validate every OCR result schema.

The latency commits `e7380b1` and `daee235` were already ancestors of the Operator's local HEAD. They affect the separate repo review transport, not this global `ocr review` invocation. Reducing a deadline bounds waiting; it does not demonstrate faster model execution. Configured provider/model readiness and live latency remain unverified here.

Run targeted checks with Node >=22:

```powershell
node --test config/opencode-global/tests/open-code-review.test.mjs
```

From the pinned source checkout, `install-ocr.ps1` checks the original stub hash (or an already installed identical source), preflights all targets, backs up the original bytes, upserts only `SOC_INTERNAL_REVIEW_CHAIN_V2` into global/project/task build files and verifies written bytes. Other policies are preserved. It does not edit provider secrets, restart servers, merge, or change task code. Use `-TaskWorktree ''` only when that worktree is intentionally not a target. Windows runtime checks are still required; local tests exercise POSIX processes and API mocks.

At a safe checkpoint after installation, reload using the existing authorized server procedure, verify the `ocr_review` / `ocr_health` tools exist, then invoke health, preview and a bounded real review on exact base/candidate SHAs. Check cancellation and that the owned native child is gone. Record elapsed time and the actual OCR findings/coverage. A missing configured model is a blocker; configure the intended provider/model through the Operator's existing process rather than silently choosing another model. Do not claim this workflow ran from file-install output alone.

`internal-review-chain.md` is the managed build instruction: OCR pre-review → rework → read-only soc_review → rework → independent final review across the whole task. It explicitly supersedes optional OCR for code tasks and grants only the soc_review review exception to the old no-subagent rule. These are instructions, not a new control-loop engine or final-approval authority.
