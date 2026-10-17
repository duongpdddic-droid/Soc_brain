# OpenCode global build hook

`plugins/build-superpowers-hook.ts` is the versioned source of the Operator's global hook at `%USERPROFILE%\.config\opencode\plugins\build-superpowers-hook.ts`.

This directory is outside OpenCode's project plugin discovery directory. Keeping the source here does not register a second hook. Install it by copying the file to the global path. Reload the OpenCode server only after active work has reached a safe checkpoint.

The hook targets the OpenCode v2.0.26 `session.hook("context")` contract, applies only to the `build` agent, and avoids duplicate context injection. It reminds build to load existing native skills; it does not install skills, change permissions, or prove a skill was invoked. Its instruction matches `SOC_BUILD_SUPERPOWERS_V2` in `.opencode/agents/build.md`.

## 9remote MCP removal

On 2026-10-18 the Operator supplied config read-back showing zero MCP keys normalized to `9remote` or `nineremote` in the global config and the checked Soc_brain/project-worktree configs. The tracked `.opencode/opencode.json` at this change's base contains only `soc-brain-gateway`; there is no tracked 9remote entry to delete. The machine-local root config and global config are not copied into this repository.

This records the configuration state. Runtime disconnection has not been verified and no server restart is performed by this change.
