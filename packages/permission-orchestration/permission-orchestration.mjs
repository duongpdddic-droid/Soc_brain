#!/usr/bin/env node
// permission-orchestration.mjs — Soc_brain: executor-independent permission
// orchestration + executor/worktree recovery (Issue #32 / task contract).
//
// This module is the DETERMINISTIC, EXECUTOR-INDEPENDENT rule layer. It has no
// OpenCode / Cline / runtime adapter dependency and performs no I/O: given an
// operation and (for path-sensitive ops) a target path plus the verified
// execution-root facts, it returns exactly one of three verdicts:
//
//   ALLOW             — statically authorized, safe inside the bound
//                       executionRoot, may run unattended.
//   DENY_AND_RECOVER  — the operation targets a MISMATCHED execution root
//                       (another issue's worktree, the primary checkout /
//                       canonical repo, or foreign control-plane state under
//                       worktreesRoot). Deterministic recovery: reroute to the
//                       canonical executionRoot. Never mutates; a later retry on
//                       the canonical root is safe.
//   BLOCKED_HUMAN_GATE— unknown / destructive / network / credential /
//                       outside-worktree operation, or a path-sensitive op with
//                       no explicit target. Requires human authorization; there
//                       is no automatic reroute.
//
// Scope mapping (task contract):
//   1. binding               -> `bindingOk`/`bindingReason` facts (never self-verdict).
//   2. safe inside root      -> ALLOW verdict for statically-authorized ops.
//   3. statically authorized -> `OPERATION_RULES` allowlist; unknown => closed.
//   4. deny-or-gate          -> BLOCKED_HUMAN_GATE for the gate-classes.
//   5. mismatch semantics    -> ALLOW / DENY_AND_RECOVER / BLOCKED_HUMAN_GATE.
//   6. deterministic recover -> DENY_AND_RECOVER produces rerouteRoot.
//
// Reuse: packages/temp-hygiene::isInside for Windows-safe containment; never
// restates safe-git / binding / session authority here (those remain in
// packages/workspace, packages/safe-git, packages/runtime-sandbox).

import path from 'node:path';
import { isInside } from '../temp-hygiene/temp-hygiene.mjs';

export const OP_OUTCOME = Object.freeze({
  ALLOW: 'ALLOW',
  DENY_AND_RECOVER: 'DENY_AND_RECOVER',
  BLOCKED_HUMAN_GATE: 'BLOCKED_HUMAN_GATE',
});

// ---- deterministic safe local command rule (executor-independent) -----------
// A safe local command is `node <repo-relative script> [opts]` executed ONCE in
// a disposable snapshot, never through a shell. Executable is allowlisted to the
// Node runtime; argv is a structured array (never a shell string) with no
// eval/print flags, no shell metacharacters, and argv[0] a repo-relative path
// that resolves inside the bound executionRoot. Anything else is closed.
export const ALLOWED_COMMAND_EXECUTABLES = Object.freeze(['node', 'node.exe']);
const SAFE_CMD_NODE_EVAL_FLAG_RE = /^(-e|--eval|-p|--print|-pe|-i|--interactive)(=.*)?$/;
const SAFE_CMD_CONTROL_RE = /[\x00-\x1f\x7f]/;
const SAFE_CMD_SHELL_META_RE = /[&|;<>`$()\n\r]/;
const SAFE_CMD_SECRET_RE = /(token|secret|passwd|password|api[_-]?key|authorization|credential|private[_-]?key)/i;

// Deterministic executor-independent classification of a canonical operation
// kind (or tool name). Executor-specific names (soc_broker_status, etc.) are
// mapped at the adapter (runtime-sandbox), never restated here. Unknown kinds
// and the gate-classes (shell / network / credential / destructive / out-of-tree)
// are BLOCKED_HUMAN_GATE — there is no allow-by-default.
export const OPERATION_RULES = Object.freeze({
  // read-only broker views: statically authorized, unattended safe.
  status: { outcome: OP_OUTCOME.ALLOW },
  diff: { outcome: OP_OUTCOME.ALLOW },
  run_registered_test: { outcome: OP_OUTCOME.ALLOW }, // snapshot-isolated by the broker
  run_safe_command: { outcome: OP_OUTCOME.ALLOW, safeCommand: true }, // authorize via classifySafeCommand; executes exactly once
  // executor file operations: ALLOW only after path-gating (bound worktree).
  edit: { outcome: OP_OUTCOME.ALLOW, pathSensitive: true },
  write: { outcome: OP_OUTCOME.ALLOW, pathSensitive: true },
  read: { outcome: OP_OUTCOME.ALLOW, pathSensitive: true },
  // gate-classes: no automatic authorization, human required.
  bash: { outcome: OP_OUTCOME.BLOCKED_HUMAN_GATE, detail: 'shell execution requires human authorization' },
  command: { outcome: OP_OUTCOME.BLOCKED_HUMAN_GATE, detail: 'arbitrary command requires human authorization' },
  shell: { outcome: OP_OUTCOME.BLOCKED_HUMAN_GATE, detail: 'shell execution requires human authorization' },
  webfetch: { outcome: OP_OUTCOME.BLOCKED_HUMAN_GATE, detail: 'network access requires human authorization' },
  network: { outcome: OP_OUTCOME.BLOCKED_HUMAN_GATE, detail: 'network access requires human authorization' },
  credential: { outcome: OP_OUTCOME.BLOCKED_HUMAN_GATE, detail: 'credential access requires human authorization' },
  destructive: { outcome: OP_OUTCOME.BLOCKED_HUMAN_GATE, detail: 'destructive operation requires human authorization' },
  delete: { outcome: OP_OUTCOME.BLOCKED_HUMAN_GATE, detail: 'destructive operation requires human authorization' },
  reset: { outcome: OP_OUTCOME.BLOCKED_HUMAN_GATE, detail: 'destructive operation requires human authorization' },
  cleanup: { outcome: OP_OUTCOME.BLOCKED_HUMAN_GATE, detail: 'cleanup operation requires human authorization' },
  external_directory: { outcome: OP_OUTCOME.BLOCKED_HUMAN_GATE, detail: 'outside-worktree access requires human authorization' },
});
const UNKNOWN_RULE = Object.freeze({ outcome: OP_OUTCOME.BLOCKED_HUMAN_GATE, detail: 'unknown operation requires human authorization' });

// Classify a single operation by its canonical kind/name. Returns the rule
// (frozen) or the deterministic UNKNOWN_RULE. Never throws.
export function classifyOperation(operation) {
  if (typeof operation !== 'string' || !operation) return UNKNOWN_RULE;
  return OPERATION_RULES[operation] || UNKNOWN_RULE;
}

// Windows-safe resolved-equality: isInside treats equal as false, so equality
// is checked separately and case-insensitively on win32.
function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  if (process.platform === 'win32') return ra.toLowerCase() === rb.toLowerCase();
  return ra === rb;
}

export const TARGET_KIND = Object.freeze({
  BOUND: 'bound',           // inside the executionRoot -> ALLOW
  PRIMARY: 'primary',       // inside the primary/canonical checkout -> DENY_AND_RECOVER
  FOREIGN: 'foreign',       // inside worktreesRoot but not the executionRoot -> DENY_AND_RECOVER
  OUTSIDE: 'outside',       // outside every known root -> BLOCKED_HUMAN_GATE
  MISSING: 'missing',       // no targetPath -> BLOCKED_HUMAN_GATE
});

// Deterministic path gating: classify where a target path lands relative to the
// verified executionRoot, the primary/canonical checkout, and worktreesRoot.
//   - inside the executionRoot (or the root itself)            -> ALLOW (bound)
//   - inside the primary checkout or a foreign worktree/state  -> DENY_AND_RECOVER
//   - outside every known root, or missing target              -> BLOCKED_HUMAN_GATE
// Containment is Windows-case-insensitive via temp-hygiene isInside.
export function classifyPath({ targetPath, executionRoot, primaryCheckout, worktreesRoot }) {
  if (typeof targetPath !== 'string' || !targetPath) {
    return { verdict: OP_OUTCOME.BLOCKED_HUMAN_GATE, targetKind: TARGET_KIND.MISSING, detail: 'path-sensitive operation requires an explicit target path' };
  }
  if (typeof executionRoot !== 'string' || !executionRoot) {
    return { verdict: OP_OUTCOME.BLOCKED_HUMAN_GATE, targetKind: TARGET_KIND.OUTSIDE, detail: 'no verified execution root' };
  }
  const t = path.resolve(targetPath);
  const root = path.resolve(executionRoot);
  if (samePath(t, root) || isInside(root, t)) {
    return { verdict: OP_OUTCOME.ALLOW, targetKind: TARGET_KIND.BOUND, detail: 'target is inside the bound executionRoot' };
  }
  if (typeof primaryCheckout === 'string' && primaryCheckout) {
    const p = path.resolve(primaryCheckout);
    if (samePath(t, p) || isInside(p, t)) {
      return { verdict: OP_OUTCOME.DENY_AND_RECOVER, targetKind: TARGET_KIND.PRIMARY, detail: 'target is the primary/canonical checkout; reroute to the bound executionRoot' };
    }
  }
  if (typeof worktreesRoot === 'string' && worktreesRoot) {
    const w = path.resolve(worktreesRoot);
    if (samePath(t, w) || isInside(w, t)) {
      return { verdict: OP_OUTCOME.DENY_AND_RECOVER, targetKind: TARGET_KIND.FOREIGN, detail: 'target is foreign workspace state under worktreesRoot; reroute to the bound executionRoot' };
    }
  }
  return { verdict: OP_OUTCOME.BLOCKED_HUMAN_GATE, targetKind: TARGET_KIND.OUTSIDE, detail: 'target is outside every known execution root' };
}

// Repo-relative safe script path for a safe local command (argv[0]): no option
// token, no URL, no drive letter, no backslash, no traversal, no absolute root.
// Mirrors the broker's validateScriptPath invariants; kept here so the
// deterministic rule layer is self-contained (no cycle into execution-broker).
function isRepoRelativeSafePath(p) {
  if (typeof p !== 'string' || !p) return false;
  if (p.startsWith('-')) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(p)) return false;
  if (/^[a-zA-Z]:/.test(p)) return false;
  if (p.includes('\\')) return false;
  if (p.startsWith('/')) return false;
  if (p.split('/').includes('..')) return false;
  return true;
}

// Deterministic static authorization for a safe local command (`node <script>`).
// Pure: no I/O. Rejects executable outside the Node allowlist, argv that is not a
// structured array, eval/print flags, shell metacharacters, secret-looking
// tokens, and a script path that is not repo-relative-safely-bound inside the
// executionRoot. NEVER executes. Executes-exactly-once is a broker guarantee.
export function classifySafeCommand({ executable, argv, cwd, executionRoot, primaryCheckout, worktreesRoot } = {}) {
  if (typeof executable !== 'string' || !executable || !ALLOWED_COMMAND_EXECUTABLES.includes(executable)) {
    return { verdict: OP_OUTCOME.BLOCKED_HUMAN_GATE, reason: 'FORBIDDEN_EXECUTABLE', detail: `Safe-command executables are allowlisted to the Node runtime; got: ${String(executable)}.` };
  }
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== 'string')) {
    return { verdict: OP_OUTCOME.BLOCKED_HUMAN_GATE, reason: 'MALFORMED_ARGV', detail: 'Safe-command argv must be a non-empty array of strings.' };
  }
  for (const a of argv) {
    if (SAFE_CMD_CONTROL_RE.test(a) || a.length > 1024) {
      return { verdict: OP_OUTCOME.BLOCKED_HUMAN_GATE, reason: 'MALFORMED_ARGV', detail: 'argv entry carries control characters or exceeds 1024 chars.' };
    }
    if (SAFE_CMD_NODE_EVAL_FLAG_RE.test(a)) {
      return { verdict: OP_OUTCOME.BLOCKED_HUMAN_GATE, reason: 'FORBIDDEN_EVAL_FLAG', flag: a, detail: 'Safe-command argv must not carry eval/code flags (e.g. node -e/--eval, -p/--print).' };
    }
    if (SAFE_CMD_SHELL_META_RE.test(a)) {
      return { verdict: OP_OUTCOME.BLOCKED_HUMAN_GATE, reason: 'FORBIDDEN_SHELL_META', argv: a, detail: 'Safe-command argv must not carry shell metacharacters / chaining / redirection / substitution.' };
    }
    if (SAFE_CMD_SECRET_RE.test(a)) {
      return { verdict: OP_OUTCOME.BLOCKED_HUMAN_GATE, reason: 'FORBIDDEN_SECRET', detail: 'Safe-command argv must not carry secret-looking tokens.' };
    }
  }
  const script = argv[0];
  if (!isRepoRelativeSafePath(script)) {
    return { verdict: OP_OUTCOME.BLOCKED_HUMAN_GATE, reason: 'FORBIDDEN_SCRIPT_PATH', detail: `Safe-command script path (argv[0]) must be repo-relative without traversal/URL/absolute/option/stdin; got: ${script}.` };
  }
  // Containment: the resolved script must land inside the bound executionRoot
  // (or an explicit cwd when supplied). A primary/foreign/outside landing maps to
  // DENY_AND_RECOVER / BLOCKED_HUMAN_GATE with the same recovery semantics.
  const base = (typeof cwd === 'string' && cwd) ? cwd : (typeof executionRoot === 'string' ? executionRoot : null);
  if (base) {
    const target = path.resolve(base, script);
    const cp = classifyPath({ targetPath: target, executionRoot, primaryCheckout, worktreesRoot });
    if (cp.verdict !== OP_OUTCOME.ALLOW) {
      return {
        verdict: cp.verdict,
        reason: 'PATH_NOT_BOUND',
        targetKind: cp.targetKind,
        detail: cp.detail,
        rerouteRoot: cp.verdict === OP_OUTCOME.DENY_AND_RECOVER ? executionRoot : undefined,
      };
    }
  }
  return { verdict: OP_OUTCOME.ALLOW, reason: 'SAFE_COMMAND', exec: { executable, argv: argv.slice() }, detail: 'Statically authorized safe local command; executes exactly once in the isolated snapshot.' };
}

// Single auditable verdict for one executor operation. Pure: authority facts
// (bindingOk/bindingReason) are supplied by the caller (runtime-sandbox
// verifySessionAuthority), never re-derived here. Returns one of the three
// verdicts; DENY_AND_RECOVER always carries rerouteRoot (the canonical
// executionRoot) so the caller can deterministically recover/reroute.
export function guardOperation({
  operation,
  kind,
  targetPath,
  executable,
  argv,
  executionRoot,
  primaryCheckout,
  worktreesRoot,
  bindingOk = true,
  bindingReason = null,
} = {}) {
  if (!bindingOk) {
    return {
      verdict: OP_OUTCOME.DENY_AND_RECOVER,
      detail: 'authority/binding mismatch; reroute to the canonical executionRoot',
      bindingReason: bindingReason || null,
      rerouteRoot: executionRoot || null,
    };
  }
  if (typeof executionRoot !== 'string' || !executionRoot) {
    return { verdict: OP_OUTCOME.BLOCKED_HUMAN_GATE, detail: 'no verified execution root' };
  }
  const rule = typeof kind === 'string' && kind ? classifyOperation(kind) : classifyOperation(operation);
  if (rule.outcome === OP_OUTCOME.BLOCKED_HUMAN_GATE) {
    return { verdict: OP_OUTCOME.BLOCKED_HUMAN_GATE, operation: operation || null, detail: rule.detail };
  }
  if (rule.safeCommand) {
    const c = classifySafeCommand({ executable, argv, executionRoot, primaryCheckout, worktreesRoot });
    if (c.verdict === OP_OUTCOME.DENY_AND_RECOVER) {
      return { verdict: c.verdict, operation: operation || null, reason: c.reason, detail: c.detail, rerouteRoot: c.rerouteRoot };
    }
    if (c.verdict !== OP_OUTCOME.ALLOW) {
      return { verdict: c.verdict, operation: operation || null, reason: c.reason, detail: c.detail };
    }
    return { verdict: OP_OUTCOME.ALLOW, operation: operation || null, exec: c.exec, detail: c.detail };
  }
  if (rule.pathSensitive) {
    const c = classifyPath({ targetPath, executionRoot, primaryCheckout, worktreesRoot });
    return {
      verdict: c.verdict,
      operation: operation || null,
      targetPath: targetPath || null,
      targetKind: c.targetKind,
      detail: c.detail,
      rerouteRoot: c.verdict === OP_OUTCOME.DENY_AND_RECOVER ? executionRoot : undefined,
    };
  }
  return { verdict: OP_OUTCOME.ALLOW, operation: operation || null, detail: rule.detail || 'statically authorized' };
}
