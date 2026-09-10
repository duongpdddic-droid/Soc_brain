// push.mjs — canonical push primitive for the ControlLoop (Issue #83 P0-G).
//
// Gap closed (evidence at 6c9aee634, Issue #83): after the executor commit the
// task branch existed ONLY locally — nothing in the runtime pushed it to the
// remote, so canonical delivery (`gh pr create --head <branch>`) failed closed
// with PR_CREATE_FAILED. This module adds the missing mutation AFTER the
// executor commit and BEFORE delivery:
//   local HEAD read-back -> push -> REMOTE read-back of the exact pushed SHA.
// The git exit code is NEVER the evidence; only the remote ref carrying the
// exact local HEAD 40-hex SHA counts as pushed.
//
// Fail-closed semantics (no duplicate side effects):
//   - Reads happen BEFORE any mutation; a remote that already carries the
//     exact SHA short-circuits as alreadyPresent (idempotent re-entry).
//   - Ambiguity (spawn throw, signal kill, unknown exit) returns ok:false with
//     `ambiguous: true` — callers must not blind-retry (same policy as
//     delivery.mjs): the push may or may not have landed; the next entry
//     re-derives truth from the pre-mutation remote read-back.
//   - Scope guards: ONLY the session's own worktree is pushed, ONLY its
//     canonical session branch (agent/<identityHash>), and only committed
//     state travels. Runtime dirt (opencode.json projection, .soc control
//     plane pointers) is NOT committed by the executor and is excluded from
//     the clean check — it must never reach the remote.
import { spawnSync } from 'node:child_process';

export const PUSH_SCHEMA_VERSION = '1';

// Runtime projections that live in the worktree but are never part of the
// canonical task change. A dirty tree consisting ONLY of these is pushable.
const RUNTIME_DIRT = new Set(['opencode.json', '.soc', '.opencode']);

// Issue #110: the ONLY proven generated residue allowed beyond RUNTIME_DIRT —
// the Issue #67 e2e reverse-control harness creates exactly
// `.soc-e2e-<digits>/marker-<nonce>.<ext>` in the task worktree
// (scripts/e2e-reverse-control-leg.mjs:75 and :218). Exact shape only: any
// other filename inside .soc-e2e-*, non-numeric dirs, and all unknown
// untracked paths stay foreign (PUSH_DIRTY_FOREIGN).
const E2E_MARKER_RESIDUE = /^\.soc-e2e-\d+\/marker-[^/]+\.[A-Za-z0-9]+$/;
// Issue #120: git status --porcelain collapses a WHOLLY-untracked dir to the
// bare dir path (`.soc-e2e-67`) — same proven Issue #67 harness residue.
const E2E_DIR_RESIDUE = /^\.soc-e2e-\d+$/;

const HEAD_SHA_40 = /^[0-9a-f]{40}$/;

function run(cwd, args, exec = null) {
  const fn = exec || ((cmd, opts) => {
    const r = spawnSync(cmd, opts.args, { cwd: opts.cwd, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error ?? null };
  });
  let r;
  try { r = fn('git', { args, cwd }); } catch (e) { return { unknown: true, error: String((e && e.message) || e) }; }
  if (!r || typeof r !== 'object') return { unknown: true, error: 'transport returned no result' };
  if (r.error) return { unknown: true, error: String(r.error.message || r.error) };
  return {
    unknown: false,
    code: Number.isInteger(r.status) ? r.status : null,
    signal: r.signal ?? null,
    stdout: String(r.stdout ?? ''),
    stderr: String(r.stderr ?? ''),
  };
}
export function cleanPathspecsForPush(paths) {
  const out = [];
  for (const p of Array.isArray(paths) ? paths : []) {
    if (typeof p !== 'string' || !p.trim()) continue;
    const norm = p.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (RUNTIME_DIRT.has(norm) || RUNTIME_DIRT.has(norm.split('/')[0])) continue;
    if (E2E_MARKER_RESIDUE.test(norm) || E2E_DIR_RESIDUE.test(norm)) continue;
    out.push(norm);
  }
  return out;
}

export function pushBranch({ session, remote = 'origin', exec = null } = {}) {
  if (!session || typeof session !== 'object') return { ok: false, code: 'PUSH_BIND_FAILED', detail: 'session required' };
  const worktree = session.worktreePath;
  const branch = session.branch;
  if (typeof worktree !== 'string' || !worktree) return { ok: false, code: 'PUSH_BIND_FAILED', detail: 'session.worktreePath missing' };
  if (typeof branch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes('..')) {
    return { ok: false, code: 'PUSH_BIND_FAILED', detail: `session.branch is not a canonical task branch: ${String(branch)}` };
  }

  // (1) LOCAL read-back: the push evidence anchor. Fail closed when the local
  // HEAD is not an exact 40-hex SHA (never push a guessed ref).
  const h = run(worktree, ['rev-parse', 'HEAD'], exec);
  if (h.unknown) return { ok: false, code: 'PUSH_AMBIGUOUS', ambiguous: true, step: 'head', detail: h.error };
  if (h.code !== 0) return { ok: false, code: 'PUSH_HEAD_UNRESOLVED', detail: (h.stderr || h.stdout).trim() };
  const headSha = h.stdout.trim().toLowerCase();
  if (!HEAD_SHA_40.test(headSha)) return { ok: false, code: 'PUSH_HEAD_UNRESOLVED', detail: `local HEAD not 40-hex: ${headSha}` };
  // (2) Scope guard: committed state must differ from base; dirty state must
  // be runtime-only (opencode.json / .soc projections — never committed by
  // the canonical soc_broker_commit primitive). Anything else is foreign
  // mutation in the task worktree -> fail closed, nothing leaves the machine.
  const st = run(worktree, ['status', '--porcelain'], exec);
  if (st.unknown) return { ok: false, code: 'PUSH_AMBIGUOUS', ambiguous: true, step: 'status', detail: st.error };
  if (st.code !== 0) return { ok: false, code: 'PUSH_STATUS_FAILED', detail: (st.stderr || st.stdout).trim() };
  const dirtyPaths = st.stdout.split('\n').map((l) => l.slice(3).trim().replaceAll('"', '')).filter(Boolean);
  const foreignDirt = cleanPathspecsForPush(dirtyPaths);
  if (foreignDirt.length) {
    return { ok: false, code: 'PUSH_DIRTY_FOREIGN', detail: { foreignPaths: foreignDirt } };
  }
  const d = run(worktree, ['diff', '--quiet', session.baseSha + '..HEAD'], exec);
  if (d.unknown) return { ok: false, code: 'PUSH_AMBIGUOUS', ambiguous: true, step: 'diff', detail: d.error };
  if (d.code === 0) return { ok: false, code: 'PUSH_NOTHING_TO_PUSH', detail: `HEAD ${headSha} has no diff vs baseSha` };
  if (d.code !== 1) return { ok: false, code: 'PUSH_DIFF_FAILED', detail: (d.stderr || d.stdout).trim() };
  // (3) Pre-mutation remote read-back: idempotent re-entry — the exact SHA
  // already on the remote counts as pushed (crash between push and caller).
  const q = run(worktree, ['ls-remote', remote, 'refs/heads/' + branch], exec);
  if (q.unknown) return { ok: false, code: 'PUSH_AMBIGUOUS', ambiguous: true, step: 'pre-readback', detail: q.error };
  if (q.code !== 0) return { ok: false, code: 'PUSH_PRE_READBACK_FAILED', detail: (q.stderr || q.stdout).trim() };
  const remoteLine = q.stdout.split('\n').map((l) => l.trim()).find((l) => l.endsWith('refs/heads/' + branch));
  const remotePre = remoteLine ? remoteLine.split(/\s+/)[0].toLowerCase() : null;
  if (remotePre === headSha) {
    return { ok: true, value: { pushed: true, alreadyPresent: true, branch, headSha, remote } };
  }

  // (4) The mutation: push the EXACT local HEAD to the session branch.
  const p = run(worktree, ['push', remote, headSha + ':refs/heads/' + branch], exec);
  if (p.unknown) return { ok: false, code: 'PUSH_AMBIGUOUS', ambiguous: true, step: 'push', detail: p.error };
  if (p.signal) return { ok: false, code: 'PUSH_AMBIGUOUS', ambiguous: true, step: 'push', detail: 'signal ' + p.signal };
  if (p.code !== 0) {
    // A non-zero exit may still have landed the ref (network cut mid-reply):
    // AMBIGUOUS, resolved by the next entry's pre-mutation read-back.
    return { ok: false, code: 'PUSH_AMBIGUOUS', ambiguous: true, step: 'push', detail: (p.stderr || p.stdout).trim() };
  }
  // (5) REMOTE read-back — the ONLY push evidence. Exit code never counts.
  const v = run(worktree, ['ls-remote', remote, 'refs/heads/' + branch], exec);
  if (v.unknown) return { ok: false, code: 'PUSH_AMBIGUOUS', ambiguous: true, step: 'readback', detail: v.error };
  if (v.code !== 0) return { ok: false, code: 'PUSH_READBACK_FAILED', detail: (v.stderr || v.stdout).trim() };
  const line = v.stdout.split('\n').map((l) => l.trim()).find((l) => l.endsWith('refs/heads/' + branch));
  const remoteSha = line ? line.split(/\s+/)[0].toLowerCase() : null;
  if (remoteSha !== headSha) {
    return { ok: false, code: 'PUSH_READBACK_MISMATCH', detail: { remote: remoteSha, local: headSha } };
  }
  return { ok: true, value: { pushed: true, alreadyPresent: false, branch, headSha, remote } };
}