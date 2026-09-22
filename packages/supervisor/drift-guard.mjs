// packages/supervisor/drift-guard.mjs — Behavior, Anti-Loop & Drift Guard.
//
// Three independent detectors, each pure and offline:
//   1. Scope Boundary Enforcement  — OUT_OF_BOUNDS_MUTATION
//   2. Test Integrity Guard        — TEST_INTEGRITY_VIOLATION
//   3. Thrashing & No-Op Detection — THRASHING_NO_OP / STUCK_NO_IMPROVEMENT
//
// Fail-closed posture: any detector returning ok:false means the supervisor
// MUST stop the executor leg. Detectors never auto-clear themselves; a human
// or a higher authority resolves the flag.
import fs from 'node:fs';
import path from 'node:path';

export const DRIFT_GUARD_SCHEMA_VERSION = '1';

export const DRIFT_CODES = Object.freeze({
  OUT_OF_BOUNDS_MUTATION: 'OUT_OF_BOUNDS_MUTATION',
  TEST_INTEGRITY_VIOLATION: 'TEST_INTEGRITY_VIOLATION',
  THRASHING_NO_OP: 'THRASHING_NO_OP',
  STUCK_NO_IMPROVEMENT: 'STUCK_NO_IMPROVEMENT',
  SCOPE_UNDECLARED: 'SCOPE_UNDECLARED',
});

// ---- 1. Scope Boundary Enforcement ------------------------------------------
// `allowedPaths` is the explicit list from the Task Contract (repo-relative
// prefixes or exact files). Any mutated path outside the list is a violation.
// Paths are normalized to forward-slash, repo-relative form before comparison.
export function normalizeRelPath(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

export function checkScope({ allowedPaths = null, mutatedPaths = [] }) {
  if (!Array.isArray(allowedPaths) || allowedPaths.length === 0) {
    return { ok: false, code: DRIFT_CODES.SCOPE_UNDECLARED, detail: 'allowedPaths must be a non-empty array from the Task Contract' };
  }
  const allowed = allowedPaths.map(normalizeRelPath);
  const violations = [];
  for (const raw of mutatedPaths) {
    const p = normalizeRelPath(raw);
    const inScope = allowed.some((a) => p === a || p.startsWith(a.replace(/\/$/, '') + '/'));
    if (!inScope) violations.push(p);
  }
  if (violations.length > 0) {
    return { ok: false, code: DRIFT_CODES.OUT_OF_BOUNDS_MUTATION, detail: { violations, allowed } };
  }
  return { ok: true, violations: [] };
}

// ---- 2. Test Integrity Guard ------------------------------------------------
// Compares the CURRENT test-suite tree against a baseline snapshot captured
// before the executor started. Detects:
//   - a baseline test file that was deleted
//   - a test file whose `test(` / `it(` call count DROPPED (cases removed)
//   - a test file whose assertion count DROPPED (asserts weakened)
// Baseline entries: { relPath: { testCount, assertCount } }.
export function captureTestBaseline({ rootDir, testGlobDirs = ['tests'] }) {
  const baseline = {};
  for (const dirName of testGlobDirs) {
    const dir = path.join(rootDir, dirName);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.test.mjs')) continue;
      const fp = path.join(dir, name);
      const src = fs.readFileSync(fp, 'utf8');
      const rel = normalizeRelPath(path.join(dirName, name));
      baseline[rel] = {
        testCount: countTests(src),
        assertCount: countAsserts(src),
      };
    }
  }
  return baseline;
}

function countTests(src) {
  // node:test `test(`/`it(` top-level calls; ignore comments.
  const stripped = src.replace(/^\s*\/\/.*$/gm, '');
  const m = stripped.match(/\b(?:test|it)\s*\(/g);
  return m ? m.length : 0;
}

function countAsserts(src) {
  const stripped = src.replace(/^\s*\/\/.*$/gm, '');
  const m = stripped.match(/\bassert(?:\.\w+)?\s*\(/g);
  return m ? m.length : 0;
}

export function checkTestIntegrity({ rootDir, baseline }) {
  if (!baseline || typeof baseline !== 'object') {
    return { ok: false, code: DRIFT_CODES.TEST_INTEGRITY_VIOLATION, detail: 'baseline missing' };
  }
  const violations = [];
  for (const [rel, base] of Object.entries(baseline)) {
    const fp = path.join(rootDir, rel);
    if (!fs.existsSync(fp)) {
      violations.push({ file: rel, reason: 'TEST_FILE_DELETED' });
      continue;
    }
    const src = fs.readFileSync(fp, 'utf8');
    const nowTests = countTests(src);
    const nowAsserts = countAsserts(src);
    if (nowTests < base.testCount) {
      violations.push({ file: rel, reason: 'TEST_CASES_REMOVED', baseline: base.testCount, current: nowTests });
    }
    if (nowAsserts < base.assertCount) {
      violations.push({ file: rel, reason: 'ASSERTS_WEAKENED', baseline: base.assertCount, current: nowAsserts });
    }
  }
  if (violations.length > 0) {
    return { ok: false, code: DRIFT_CODES.TEST_INTEGRITY_VIOLATION, detail: { violations } };
  }
  return { ok: true, violations: [] };
}

// ---- 3. Thrashing & No-Op Detection ----------------------------------------
// Sequence-based detectors (stateful per guard instance).
//
// a) Repeated no-op reads: the same read-only tool call (glob/read) with the
//    SAME pattern repeated more than `repeatThreshold` times WITHOUT any
//    intervening code-producing action (write/edit that yields new content)
//    flags THRASHING_NO_OP.
//
// b) Stuck fix loop: more than `fixThreshold` consecutive code-fix attempts
//    where the failing-test count did NOT decrease flags STUCK_NO_IMPROVEMENT.
export function createBehaviorGuard({ repeatThreshold = 3, fixThreshold = 3 } = {}) {
  if (!Number.isInteger(repeatThreshold) || repeatThreshold < 1) throw new Error('repeatThreshold must be int >= 1');
  if (!Number.isInteger(fixThreshold) || fixThreshold < 1) throw new Error('fixThreshold must be int >= 1');

  let lastReadKey = null;
  let readStreak = 0;
  let producedCodeSinceStreak = false;

  let fixStreak = 0;
  let lastFailCount = null;
  let stuck = false;
  let thrashing = false;

  /**
   * Record a tool observation.
   * @param {object} obs
   * @param {'glob'|'read'|'grep'|'write'|'edit'|'other'} obs.tool
   * @param {string} [obs.pattern]  glob/read pattern (identity of the call)
   * @param {boolean} [obs.producedNewCode] true when a write/edit actually changed files
   * @param {number} [obs.failCount] for fix attempts: current failing-test count
   */
  function observe({ tool, pattern = null, producedNewCode = false, failCount = null } = {}) {
    const readOnly = tool === 'glob' || tool === 'read' || tool === 'grep';

    if (producedNewCode || tool === 'write' || tool === 'edit') {
      // A productive action resets the no-op read streak.
      if (tool === 'write' || tool === 'edit' || producedNewCode) {
        producedCodeSinceStreak = true;
        readStreak = 0;
        lastReadKey = null;
      }
    }

    if (readOnly) {
      const key = `${tool}::${pattern ?? ''}`;
      if (key === lastReadKey && !producedCodeSinceStreak) {
        readStreak += 1;
      } else {
        lastReadKey = key;
        readStreak = 1;
        producedCodeSinceStreak = false;
      }
      // More than `repeatThreshold` identical reads with no new code => thrashing.
      if (readStreak > repeatThreshold) {
        thrashing = true;
      }
    }

    // Fix-attempt tracking (only meaningful when a failCount is supplied).
    if (failCount !== null && Number.isFinite(failCount)) {
      if (lastFailCount !== null && failCount >= lastFailCount) {
        fixStreak += 1;
      } else {
        fixStreak = 1; // improvement (or first observation) restarts the streak
      }
      lastFailCount = failCount;
      if (fixStreak > fixThreshold) {
        stuck = true;
      }
    }

    return status();
  }

  function status() {
    return {
      thrashing,
      stuck,
      readStreak,
      fixStreak,
      flags: [
        ...(thrashing ? [DRIFT_CODES.THRASHING_NO_OP] : []),
        ...(stuck ? [DRIFT_CODES.STUCK_NO_IMPROVEMENT] : []),
      ],
    };
  }

  function reset() {
    lastReadKey = null;
    readStreak = 0;
    producedCodeSinceStreak = false;
    fixStreak = 0;
    lastFailCount = null;
    stuck = false;
    thrashing = false;
  }

  return Object.freeze({ observe, status, reset, repeatThreshold, fixThreshold });
}
