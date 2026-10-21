// packages/review-leg/doc-only-scope.mjs — the ONLY sanctioned way a candidate
// whose OCR reviewable set is empty can still reach the gate.
//
// The OCR preview deliberately refuses to claim coverage over zero files
// ("0/0 is never 100% coverage", review-only.mjs). This module does NOT weaken
// that invariant: it adds a LOCAL proof, computed from the candidate's own git
// range, that every changed path is documentation. The proof never trusts the
// reviewer's exclusion filters — one code path in the changeset keeps the
// review refusal (REVIEW_SCOPE_EMPTY), so a filtered-out source file can never
// be laundered as "nothing to review".
//
// Allowlist (operator decision): docs/** , artifacts/** , any *.md — EXCEPT
// runtime-instruction docs: `.opencode/agents/*.md` and any `AGENTS.md`.
//
// This module is a dependency-free leaf (node builtins only) so the review leg,
// the OCR transport and the handoff gate can all share ONE allowlist instead
// of re-deriving it.

import { execFileSync } from 'node:child_process';

export const DOC_ONLY_RULE = 'DOCS_ONLY_V1';
// Same refusal code the preview emits: a failed proof is never a new outcome,
// it simply keeps the caller's original typed refusal.
export const DOC_ONLY_REFUSAL = 'REVIEW_SCOPE_EMPTY';

const SHA40_RE = /^[0-9a-f]{40}$/;
const DOC_PREFIXES = Object.freeze(['docs/', 'artifacts/']);
const RUNTIME_AGENT_PREFIX = '.opencode/agents/';

function fail(detail) {
  return { ok: false, code: DOC_ONLY_REFUSAL, detail: String(detail) };
}

// A repository-relative, POSIX-shaped path that belongs to the documentation
// allowlist. Absolute paths, backslashes, traversal segments and the two
// runtime-instruction exceptions are refused.
export function isDocOnlyPath(p) {
  if (typeof p !== 'string' || !p || p !== p.trim() || p.includes('\0')) return false;
  if (p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:/.test(p) || p.includes('\\')) return false;
  if (p === '.' || p.startsWith('./') || p.startsWith('../')) return false;
  if (p.split('/').some((s) => s === '' || s === '.' || s === '..')) return false;
  const lower = p.toLowerCase();
  if (lower.split('/').pop() === 'agents.md') return false;
  if (lower.startsWith(RUNTIME_AGENT_PREFIX)) return false;
  if (DOC_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true;
  return lower.endsWith('.md');
}

// Prove base..head touches documentation only. `exec` is injectable so the
// proof is deterministic offline; production uses execFileSync. Every failure
// carries the SAME code as the preview refusal, with the reason in `detail`.
export function proveDocOnlyScope({ repo, baseSha, headSha, exec = execFileSync } = {}) {
  if (typeof repo !== 'string' || !repo) return fail('repo required for the doc-only scope proof');
  if (typeof baseSha !== 'string' || !SHA40_RE.test(baseSha)) return fail('baseSha must be a 40-hex commit');
  if (typeof headSha !== 'string' || !SHA40_RE.test(headSha)) return fail('headSha must be a 40-hex commit');
  if (typeof exec !== 'function') return fail('exec is required for the doc-only scope proof');

  let raw;
  try {
    raw = exec('git', ['-C', repo, 'diff', '--name-only', '-z', `${baseSha}..${headSha}`], {
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (e) {
    return fail(`git diff failed: ${String((e && e.message) || e)}`);
  }

  const changedPaths = String(raw == null ? '' : raw).split('\0').filter((s) => s.length > 0).sort();
  if (changedPaths.length === 0) return fail('empty changeset is not a doc-only candidate');
  const offender = changedPaths.find((p) => !isDocOnlyPath(p));
  if (offender) return fail(`non-doc path in changeset: ${offender}`);
  return {
    ok: true,
    value: {
      rule: DOC_ONLY_RULE,
      baseSha: baseSha.toLowerCase(),
      headSha: headSha.toLowerCase(),
      changedPaths,
    },
  };
}

// Structural + semantic validation of a proof that travels through evidence.
// `expected` binds the proof to the candidate being handed off; when provided,
// a different base/head is refused.
export function isValidScopeProof(proof, expected = null) {
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) return false;
  if (proof.rule !== DOC_ONLY_RULE) return false;
  if (typeof proof.baseSha !== 'string' || !SHA40_RE.test(proof.baseSha)) return false;
  if (typeof proof.headSha !== 'string' || !SHA40_RE.test(proof.headSha)) return false;
  const paths = proof.changedPaths;
  if (!Array.isArray(paths) || paths.length === 0) return false;
  if (!paths.every((p) => isDocOnlyPath(p))) return false;
  if (new Set(paths).size !== paths.length) return false;
  if (expected && typeof expected === 'object') {
    if (typeof expected.baseSha === 'string' && proof.baseSha !== expected.baseSha.toLowerCase()) return false;
    if (typeof expected.headSha === 'string' && proof.headSha !== expected.headSha.toLowerCase()) return false;
  }
  return true;
}
