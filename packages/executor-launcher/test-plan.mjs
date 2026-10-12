// packages/executor-launcher/test-plan.mjs — the CANONICAL, deterministic
// affected-test planner shared by every test entrypoint of this repo
// (scripts/run-tier.mjs `gate:tier`, scripts/run-tier-tests.mjs tier
// wrapper, and the control-plane ACTIVE test gate in
// executor-launcher/test-run-evidence.mjs).
//
// Responsibilities (ONE source, ONE selector):
//   * load + fail-closed validate the single manifest `tests/tiers.json`
//     (one owner tier per file; orphan/duplicate/ghost/malformed-smoke
//     references are rejected — never silently repaired);
//   * resolve the BASE binding to an exact 40-hex SHA inside THIS repo and
//     prove the candidate has a real git relationship to it (merge-base);
//   * compute the changed set = merge-base -> candidate, PLUS tracked
//     dirty content and untracked files (so a PRE-COMMIT candidate is
//     planned against what is actually there), ignoring only
//     artifacts/logs that are PROVEN non-runtime (manifest ignore rules);
//   * build the reverse dependency closure over static imports/re-exports,
//     literal dynamic `import('...')` and `require('...')`: a test is
//     selected when its import closure CONTAINS a changed file, so
//     A -> B -> C chains, cycles, renames and deletions all resolve;
//   * anything that cannot be PROVEN to have no effect (unknown
//     extension, no resolvable dependency, shared runtime/selector/manifest
//     change, entrypoint change) selects the FULL inventory with an
//     explicit reason — never a silent T1+T2 subset;
//   * bind the plan: mode, status, base/candidate SHA, selected files,
//     reasons, manifest digest, selector version+digest and a planDigest,
//     so a stale/tampered plan can be refused before execution.
//
// The planner NEVER executes anything and never trusts caller-provided
// argv: `validateTestPlan` + `testPlanGateCommand` are the only bridge to
// execution, and both re-derive the spawn argv from validated files.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const TEST_PLAN_SELECTOR_VERSION = '1';

export const TEST_PLAN_CODES = Object.freeze({
  MANIFEST_INVALID: 'TEST_PLAN_MANIFEST_INVALID',
  BASE_UNRESOLVED: 'TEST_PLAN_BASE_UNRESOLVED',
  BASE_UNRELATED: 'TEST_PLAN_BASE_UNRELATED',
  CANDIDATE_UNKNOWN: 'TEST_PLAN_CANDIDATE_UNKNOWN',
  PLAN_INVALID: 'TEST_PLAN_INVALID',
  PLAN_STALE: 'TEST_PLAN_PLAN_STALE',
  PATH_ESCAPE: 'TEST_PLAN_PATH_ESCAPE',
  PATH_NOT_TEST: 'TEST_PLAN_PATH_NOT_TEST',
  TAP_SUMMARY_INVALID: 'TEST_PLAN_TAP_SUMMARY_INVALID',
});

export const TEST_PLAN_NO_TESTS_REASONS = Object.freeze({
  DOCS_ONLY: 'docs-only: every changed path is a proven non-runtime doc/artifact',
  NO_CHANGES: 'empty changeset',
});

// Directories never walked for the import graph. `worktrees` holds OTHER
// tasks' isolated workspaces — importing from there would break isolation.
const SKIP_DIRS = new Set(['.git', 'node_modules', 'worktrees', 'artifacts', 'coverage', '.codex', '.tmp']);
const JS_EXT = ['.mjs', '.js', '.cjs'];

const SPEC_RES = [
  // import ... from 'spec' | export ... from 'spec'
  /(?:^|[\s;)])(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"\n]+)['"]/g,
  // literal dynamic import('spec')
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  // bare side-effect import 'spec'
  /\bimport\s*['"]([^'"\n]+)['"]/g,
  // require('spec') (defence in depth: .cjs helpers in this repo)
  /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
];
// A dynamic import whose argument is NOT a string literal: its dependency
// set is incomplete, so any change to such a file cannot be reasoned about.
const OPAQUE_DYNAMIC_RE = /\bimport\s*\(\s*(?!['"])/g;

const HEX40 = /^[0-9a-f]{40}$/;

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

const toPosix = (p) => p.split(path.sep).join('/');

function git(args, { root, allowFail = false } = {}) {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', '-C', root, ...args], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) {
    if (allowFail) return null;
    return null;
  }
  return r.stdout;
}

// ---------------------------------------------------------------------------
// (1) Manifest — ONE source: tests/tiers.json. Every entrypoint resolves it
// against its OWN root (never the process CWD).
// ---------------------------------------------------------------------------
export function manifestPath(root) {
  return path.join(root, 'tests', 'tiers.json');
}

export function loadManifestForRoot(root) {
  const { readFileSync, readdirSync } = fs; // eslint-disable-line no-unused-vars
  const fp = manifestPath(root);
  let m;
  try {
    m = JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch (e) {
    return { ok: false, reason: `manifest unreadable at ${fp}: ${String((e && e.message) || e)}` };
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) {
    return { ok: false, reason: 'manifest is not an object' };
  }
  if (!m.tiers || typeof m.tiers !== 'object') {
    return { ok: false, reason: 'manifest has no `tiers` object' };
  }
  for (const t of Object.keys(m.tiers)) {
    const def = m.tiers[t];
    if (!def || !Array.isArray(def.files)) {
      return { ok: false, reason: `tier '${t}' has no files[] array` };
    }
  }
  // `all` is NEVER stored: it is the filesystem inventory, derived below.
  if (Array.isArray(m.all)) {
    return { ok: false, reason: 'manifest must not store an independent `all` list (all is derived from inventory)' };
  }
  let onDisk;
  try {
    onDisk = fs.readdirSync(path.join(root, 'tests'))
      .filter((f) => f.endsWith('.test.mjs') && fs.statSync(path.join(root, 'tests', f)).isFile())
      .sort();
  } catch (e) {
    return { ok: false, reason: `tests/ unreadable: ${String((e && e.message) || e)}` };
  }
  const owner = new Map();
  for (const [tier, def] of Object.entries(m.tiers)) {
    for (const f of def.files) {
      if (owner.has(f)) return { ok: false, reason: `${f} is assigned to both ${owner.get(f)} and ${tier}` };
      owner.set(f, tier);
    }
  }
  const orphans = onDisk.filter((f) => !owner.has(f));
  if (orphans.length) return { ok: false, reason: `test files with no tier (fail-closed): ${orphans.join(', ')}` };
  const ghosts = [...owner.keys()].filter((f) => !onDisk.includes(f));
  if (ghosts.length) return { ok: false, reason: `manifest lists files that do not exist: ${ghosts.join(', ')}` };
  for (const f of m.always || []) if (!owner.has(f)) return { ok: false, reason: `always[] lists unknown test ${f}` };
  // Smoke is a REFERENCE subset, never a second ownership tier.
  const smoke = Array.isArray(m.smoke) ? m.smoke.slice() : [];
  for (const f of smoke) {
    if (!owner.has(f)) return { ok: false, reason: `smoke[] references unknown test ${f}` };
  }
  if (new Set(smoke).size !== smoke.length) return { ok: false, reason: 'smoke[] contains duplicates' };
  // Explicit path mapping: files read through fs/spawn (not import) whose
  // affected tests CANNOT be derived from the import graph.
  const pathMappings = {};
  for (const [k, v] of Object.entries(m.pathMappings || {})) {
    if (!Array.isArray(v) || v.some((t) => !owner.has(t))) {
      return { ok: false, reason: `pathMappings['${k}'] must list known test files` };
    }
    pathMappings[k] = v.slice();
  }
  const fullTriggerPaths = Array.isArray(m.fullTriggerPaths) ? m.fullTriggerPaths.slice() : [];
  const fullTriggerPrefixes = Array.isArray(m.fullTriggerPrefixes) ? m.fullTriggerPrefixes.slice() : [];
  const ignorePrefixes = Array.isArray(m.ignorePrefixes) ? m.ignorePrefixes.slice() : [];
  // Extension-only ignores are DELIBERATELY unsupported: docs/.md have to be
  // proven non-runtime by path, not by extension.
  const ignoreSuffixes = Array.isArray(m.ignoreSuffixes) ? m.ignoreSuffixes.slice() : [];
  if (ignoreSuffixes.includes('.md') || ignoreSuffixes.includes('.txt')) {
    return { ok: false, reason: 'ignoreSuffixes must not blanket-ignore .md/.txt (runtime instruction files are inputs)' };
  }
  const manifestDigest = sha256(fs.readFileSync(fp));
  return {
    ok: true,
    root, manifestDigest, onDisk, owner, smoke, pathMappings,
    fullTriggerPaths, fullTriggerPrefixes, ignorePrefixes, ignoreSuffixes,
    tiers: m.tiers, always: (m.always || []).slice(), coreSubsystems: m.coreSubsystems || {},
  };
}

export function loadManifest(root) {
  const r = loadManifestForRoot(root);
  if (!r.ok) throw new Error(`TEST_PLAN_MANIFEST_INVALID: ${r.reason}`);
  return r;
}

// ---------------------------------------------------------------------------
// (2) Git — BASE/candidate binding. The base ALWAYS comes from the task
// binding (session.baseSha / execution record), resolved to an exact SHA.
// ---------------------------------------------------------------------------
/**
 * BASE always comes from the task binding (session.baseSha / execution
 * record) or an explicit ref; it is resolved to an EXACT 40-hex commit
 * inside this repository. The `^{commit}` suffix keeps the argument from
 * ever being read as a git option; anything that does not resolve fails
 * closed (wrong repo / unresolvable / unrelated history).
 */
export function resolveBaseSha(root, base) {
  if (typeof base !== 'string' || !base.trim()) {
    return { ok: false, reason: `base is empty: ${base}` };
  }
  const b = base.trim();
  const r = spawnSync('git', ['-c', 'core.quotepath=off', '-C', root, 'rev-parse', '--verify', '--quiet', `${b}^{commit}`], {
    encoding: 'utf8', windowsHide: true,
  });
  const out = (r.stdout || '').trim();
  if (r.status !== 0 || !HEX40.test(out)) {
    return { ok: false, reason: `base '${b}' does not resolve to a commit in ${root}` };
  }
  return { ok: true, value: out };
}

export function resolveCandidateSha(root) {
  const out = git(['rev-parse', 'HEAD'], { root });
  if (typeof out !== 'string' || !HEX40.test(out.trim())) {
    return { ok: false, reason: `candidate HEAD is unresolvable in ${root}` };
  }
  return { ok: true, value: out.trim() };
}

function parseNameStatus(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    const [status, ...rest] = line.split('\t');
    const files = rest.filter(Boolean).map((s) => s.trim()).filter(Boolean);
    if (!files.length) continue;
    if (status.startsWith('R') || status.startsWith('C')) {
      // rename/copy: BOTH sides are part of the change
      for (const f of files) out.push(f);
    } else {
      out.push(files[0]);
    }
  }
  return out;
}

/**
 * The changed set for BASE..candidate, PLUS tracked dirty content and
 * untracked source (so a pre-commit candidate is planned against reality).
 * Generated runner artifacts (evidence JSON / raw logs) are excluded at the
 * manifest ignore rules — they can never masquerade as changed source.
 */
export function computeChangedPaths({ root, baseSha, candidateSha, manifest }) {
  const mb = git(['merge-base', baseSha, candidateSha], { root, allowFail: true });
  if (typeof mb !== 'string' || !HEX40.test(mb.trim())) {
    return { ok: false, reason: `no merge-base between ${baseSha} and ${candidateSha} in ${root} (unrelated repositories or missing object)` };
  }
  const mergeBase = mb.trim();
  const committed = parseNameStatus(git(['diff', '--name-status', '-M', `${mergeBase}..${candidateSha}`], { root, allowFail: true }));
  const dirty = parseNameStatus(git(['diff', '--name-status', '-M', 'HEAD'], { root, allowFail: true }));
  const untracked = String(git(['ls-files', '--others', '--exclude-standard'], { root, allowFail: true }) || '')
    .split('\n').map((s) => s.trim()).filter(Boolean);
  const all = [...new Set([...committed, ...dirty, ...untracked])]
    .map((p) => toPosix(p.trim()))
    .filter(Boolean)
    .sort();
  const ignorePrefixes = manifest.ignorePrefixes;
  const ignoreSuffixes = manifest.ignoreSuffixes;
  const isIgnored = (p) => ignorePrefixes.some((x) => p.startsWith(x)) || ignoreSuffixes.some((x) => p.endsWith(x));
  return {
    ok: true,
    mergeBase,
    changed: all.filter((p) => !isIgnored(p)),
    ignored: all.filter(isIgnored),
  };
}

// ---------------------------------------------------------------------------
// (3) Import graph — static imports/re-exports, literal dynamic import(),
// require(); a visited set makes cycles finite. Deleted/renamed targets
// stay in the graph as literal edges, so their importers are still found.
// ---------------------------------------------------------------------------
export function parseImportSpecs(source) {
  const specs = [];
  for (const re of SPEC_RES) {
    re.lastIndex = 0;
    for (const m of source.matchAll(re)) specs.push(m[1]);
  }
  return specs;
}

export function hasOpaqueDynamicImport(source) {
  OPAQUE_DYNAMIC_RE.lastIndex = 0;
  return OPAQUE_DYNAMIC_RE.test(source);
}

function walkRepoFiles(root) {
  const out = [];
  const walk = (rel) => {
    const abs = path.join(root, rel);
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        walk(childRel);
      } else if (ent.isFile() && JS_EXT.includes(path.extname(ent.name))) {
        out.push(childRel);
      }
    }
  };
  walk('');
  return out.sort();
}

function resolveSpecToCandidates(importerRel, spec) {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return null; // bare/external
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(importerRel), spec));
  const cands = [joined];
  if (!JS_EXT.includes(path.posix.extname(joined))) {
    cands.push(`${joined}.mjs`, `${joined}.js`, `${joined}.cjs`);
    cands.push(path.posix.join(joined, 'index.mjs'), path.posix.join(joined, 'index.js'));
  }
  return [...new Set(cands)];
}

/**
 * Build the reverse graph for `root`: every repo JS file's dependencies.
 * Returned `nodes` = existing files; `edges` = importer -> spec candidates
 * (literals kept even when the target no longer exists, for deletions).
 */
export function buildImportGraph(root) {
  const files = walkRepoFiles(root);
  const fileSet = new Set(files);
  const edges = new Map(); // importer -> Set(candidate paths)
  const opaque = new Set(); // importer has a non-literal dynamic import
  for (const rel of files) {
    let source;
    try { source = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { continue; }
    if (hasOpaqueDynamicImport(source)) opaque.add(rel);
    const targets = new Set();
    for (const spec of parseImportSpecs(source)) {
      for (const cand of (resolveSpecToCandidates(rel, spec) || [])) targets.add(cand);
    }
    edges.set(rel, targets);
  }
  // dependents: target -> importers (target may be a literal that no
  // longer exists on disk — rename/delete still resolves to consumers).
  const dependents = new Map();
  for (const [importer, targets] of edges) {
    for (const t of targets) {
      if (!dependents.has(t)) dependents.set(t, new Set());
      dependents.get(t).add(importer);
    }
  }
  return { root, files: fileSet, edges, dependents, opaque };
}

export function impactedTestsOf(graph, changedPath) {
  // BFS upward over importers with a visited set (cycles terminate).
  const seen = new Set();
  const stack = [changedPath];
  while (stack.length) {
    const cur = stack.pop();
    for (const importer of (graph.dependents.get(cur) || [])) {
      if (seen.has(importer)) continue;
      seen.add(importer);
      stack.push(importer);
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------
// (4) Selection — the ONE selector behind every entrypoint.
// ---------------------------------------------------------------------------
export function selectAffectedTests({ manifest, graph, changed }) {
  const picked = new Map();
  const add = (f, why) => { if (manifest.owner.has(f) && !picked.has(f)) picked.set(f, why); };

  // `always` is the manifest's unconditional subset (smoke-grade regressions).
  // Smoke itself is a REFERENCE subset (used by the t0 entrypoint), never
  // silently added to every plan — plans select by effect only + `always`.
  for (const f of manifest.always) add(f, 'always');

  const fullReasons = [];
  const sources = [];
  const ignored = [];
  for (const p of changed) {
    const ign = manifest.ignorePrefixes.some((x) => p.startsWith(x)) || manifest.ignoreSuffixes.some((x) => p.endsWith(x));
    if (ign) { ignored.push(p); continue; }
    sources.push(p);
  }

  for (const p of sources) {
    // A changed test file is selected directly.
    if (p.startsWith('tests/') && p.endsWith('.test.mjs') && !p.slice('tests/'.length).includes('/') && manifest.owner.has(p.slice('tests/'.length))) {
      add(p.slice('tests/'.length), 'changed-test');
      continue;
    }
    // Shared runtime/selector/manifest => FULL with an explicit reason.
    if (manifest.fullTriggerPaths.includes(p)) { fullReasons.push(`full-trigger:${p}`); continue; }
    if (manifest.fullTriggerPrefixes.some((x) => p.startsWith(x))) { fullReasons.push(`full-trigger:${p}`); continue; }
    // Explicit fs/spawn mapping: proven consumers of a non-imported file.
    let mapped = false;
    for (const [key, tests] of Object.entries(manifest.pathMappings)) {
      if (p === key || (key.endsWith('/') && p.startsWith(key))) {
        for (const t of tests) add(t, `path-mapping:${key}`);
        mapped = true;
      }
    }
    if (mapped) continue;
    // Subsystem mapping (explicit, for config-style subsystems).
    let sub = false;
    for (const [subsystemPath, targetTests] of Object.entries(manifest.coreSubsystems)) {
      if (p.startsWith(subsystemPath)) {
        for (const t of targetTests) add(t, `core-subsystem:${subsystemPath}`);
        sub = true;
      }
    }
    if (sub) continue;
    // Import-derived closure. A DELETED or renamed-away file is still fully
    // resolvable: its importers' literal edges remain in the graph, so both
    // the old and the new path of a change keep finding their consumers.
    if (!JS_EXT.includes(path.posix.extname(p))) { fullReasons.push(`unclassified-change:${p}`); continue; }
    const hasDependents = graph.dependents.has(p);
    if (!graph.files.has(p) && !hasDependents) {
      // Not on disk, imported by nobody in the graph: its loading semantics
      // cannot be proven (fs/spawn/side effect) -> full fallback, with a
      // reason. Never a silent "no test touches it".
      fullReasons.push(`unresolved-dependency:${p}`);
      continue;
    }
    if (graph.files.has(p) && graph.opaque.has(p)) {
      // The changed file itself carries a non-literal dynamic import: its
      // real dependency set cannot be enumerated from the text.
      fullReasons.push(`opaque-dynamic-import:${p}`);
      continue;
    }
    const tests = [...impactedTestsOf(graph, p)].filter((n) => {
      if (!n.startsWith('tests/') || !n.endsWith('.test.mjs')) return false;
      const rest = n.slice('tests/'.length); // top-level only: manifest keys are basenames
      return !rest.includes('/');
    });
    if (!tests.length) { fullReasons.push(`unresolved-dependency:${p}`); continue; }
    for (const t of tests) {
      const f = t.slice('tests/'.length); // owner keys are basenames (manifest format)
      if (!picked.has(f)) add(f, `dependency:${p}`);
    }
  }

  return {
    sources,
    ignored,
    selected: [...picked.keys()].sort(),
    reasons: Object.fromEntries(picked),
    fullReasons,
    fallback: fullReasons.length > 0,
  };
}

// ---------------------------------------------------------------------------
// (5) Plan — deterministic, deduplicated, digest-bound.
// ---------------------------------------------------------------------------
function canonicalPlanForDigest(plan) {
  const clone = JSON.parse(JSON.stringify(plan));
  delete clone.planDigest;
  return JSON.stringify(clone, Object.keys(clone).sort());
}

export function recomputePlanDigest(plan) {
  return sha256(canonicalPlanForDigest(plan));
}

export function buildTestPlan({ root, base, mode = 'auto' } = {}) {
  if (typeof root !== 'string' || !root || !path.isAbsolute(root) && root !== path.resolve(root)) {
    return { ok: false, code: TEST_PLAN_CODES.PLAN_INVALID, detail: 'root must be an absolute path' };
  }
  const manifest = loadManifestForRoot(root);
  if (!manifest.ok) return { ok: false, code: TEST_PLAN_CODES.MANIFEST_INVALID, detail: manifest.reason };

  const baseResolved = resolveBaseSha(root, base);
  if (!baseResolved.ok) return { ok: false, code: TEST_PLAN_CODES.BASE_UNRESOLVED, detail: baseResolved.reason };
  const baseSha = baseResolved.value;

  const candidate = resolveCandidateSha(root);
  if (!candidate.ok) return { ok: false, code: TEST_PLAN_CODES.CANDIDATE_UNKNOWN, detail: candidate.reason };
  const candidateSha = candidate.value;

  const changed = computeChangedPaths({ root, baseSha, candidateSha, manifest });
  if (!changed.ok) return { ok: false, code: TEST_PLAN_CODES.BASE_UNRELATED, detail: changed.reason };

  const requestedMode = ['auto', 'affected', 'full'].includes(mode) ? mode : 'auto';
  // plan.files are ALWAYS repo-relative `tests/<name>` paths: they are the
  // exact spawn argv, validated against the manifest inventory by basename.
  const toPlanPath = (f) => (f.startsWith('tests/') ? f : `tests/${f}`);
  const fullFiles = manifest.onDisk.map(toPlanPath);
  const fullReasons = Object.fromEntries(fullFiles.map((f) => [f, 'full']));
  if (requestedMode === 'full') {
    const plan = {
      version: TEST_PLAN_SELECTOR_VERSION,
      mode: 'full',
      status: 'READY',
      fullReason: 'requested-full',
      base, baseSha, candidateSha,
      changedCount: changed.changed.length,
      changedPaths: changed.changed,
      ignoredPaths: changed.ignored,
      files: fullFiles,
      reasons: fullReasons,
      manifestDigest: manifest.manifestDigest,
      selectorVersion: TEST_PLAN_SELECTOR_VERSION,
      selectorDigest: selectorDigest(),
    };
    return { ok: true, plan: { ...plan, planDigest: recomputePlanDigest(plan) } };
  }

  const graph = buildImportGraph(root);
  const sel = selectAffectedTests({ manifest, graph, changed: changed.changed });
  if (sel.fallback) {
    const plan = {
      version: TEST_PLAN_SELECTOR_VERSION,
      mode: 'full',
      status: 'READY',
      fullReason: sel.fullReasons.join('; '),
      base, baseSha, candidateSha,
      changedCount: changed.changed.length,
      changedPaths: changed.changed,
      ignoredPaths: changed.ignored,
      files: fullFiles,
      reasons: fullReasons,
      manifestDigest: manifest.manifestDigest,
      selectorVersion: TEST_PLAN_SELECTOR_VERSION,
      selectorDigest: selectorDigest(),
    };
    return { ok: true, plan: { ...plan, planDigest: recomputePlanDigest(plan) } };
  }
  if (!changed.changed.length) {
    // Two DISTINCT explicit no-tests states: a genuinely empty changeset, or
    // a docs/artifact-only changeset (every changed path was proven
    // non-runtime by the manifest ignore rules). Neither is ever a PASS.
    const docsOnly = changed.ignored.length > 0;
    const plan = {
      version: TEST_PLAN_SELECTOR_VERSION,
      mode: 'affected',
      status: 'NO_TESTS',
      fullReason: docsOnly ? TEST_PLAN_NO_TESTS_REASONS.DOCS_ONLY : TEST_PLAN_NO_TESTS_REASONS.NO_CHANGES,
      base, baseSha, candidateSha,
      changedCount: 0,
      changedPaths: [],
      ignoredPaths: changed.ignored,
      files: [],
      reasons: {},
      manifestDigest: manifest.manifestDigest,
      selectorVersion: TEST_PLAN_SELECTOR_VERSION,
      selectorDigest: selectorDigest(),
    };
    return { ok: true, plan: { ...plan, planDigest: recomputePlanDigest(plan) } };
  }
  if (!sel.selected.length) {
    const plan = {
      version: TEST_PLAN_SELECTOR_VERSION,
      mode: 'affected',
      status: 'NO_TESTS',
      fullReason: TEST_PLAN_NO_TESTS_REASONS.DOCS_ONLY,
      base, baseSha, candidateSha,
      changedCount: changed.changed.length,
      changedPaths: changed.changed,
      ignoredPaths: changed.ignored,
      files: [],
      reasons: {},
      manifestDigest: manifest.manifestDigest,
      selectorVersion: TEST_PLAN_SELECTOR_VERSION,
      selectorDigest: selectorDigest(),
    };
    return { ok: true, plan: { ...plan, planDigest: recomputePlanDigest(plan) } };
  }
  const plan = {
    version: TEST_PLAN_SELECTOR_VERSION,
    mode: 'affected',
    status: 'READY',
    fullReason: null,
    base, baseSha, candidateSha,
    changedCount: changed.changed.length,
    changedPaths: changed.changed,
    ignoredPaths: changed.ignored,
    files: sel.selected.map(toPlanPath),
    reasons: Object.fromEntries(
      Object.entries(sel.reasons).map(([f, w]) => [toPlanPath(f), w]),
    ),
    manifestDigest: manifest.manifestDigest,
    selectorVersion: TEST_PLAN_SELECTOR_VERSION,
    selectorDigest: selectorDigest(),
  };
  return { ok: true, plan: { ...plan, planDigest: recomputePlanDigest(plan) } };
}

let SELECTOR_DIGEST = null;
export function selectorDigest() {
  if (!SELECTOR_DIGEST) {
    SELECTOR_DIGEST = sha256(JSON.stringify({ v: TEST_PLAN_SELECTOR_VERSION, specs: SPEC_RES.map(String), skip: [...SKIP_DIRS] }));
  }
  return SELECTOR_DIGEST;
}

// ---------------------------------------------------------------------------
// (6) Validation at the execution boundary + the ONLY spawn argv builder.
// Nothing in this file executes tests: a plan is data, validated and turned
// into argv HERE or not at all.
// ---------------------------------------------------------------------------
export function isSafeTestPath(root, file) {
  if (typeof file !== 'string' || !file) return { ok: false, reason: 'empty path' };
  if (file.includes('\\') || file.includes('\0')) return { ok: false, reason: 'backslash/NUL in path' };
  if (path.isAbsolute(file) || file.startsWith('/')) return { ok: false, reason: 'absolute path' };
  if (file.startsWith('-')) return { ok: false, reason: 'option-like path' };
  const parts = file.split('/');
  if (parts.some((p) => p === '..')) return { ok: false, reason: 'traversal segment' };
  if (!/^tests\/[A-Za-z0-9._@%+=-]+\.test\.mjs$/.test(file)) return { ok: false, reason: 'not a top-level tests/*.test.mjs path' };
  const abs = path.resolve(root, file);
  if (!abs.startsWith(path.resolve(root) + path.sep)) return { ok: false, reason: 'escapes the repo root' };
  if (fs.existsSync(abs)) {
    const real = fs.realpathSync(abs);
    if (!real.startsWith(fs.realpathSync(path.resolve(root)) + path.sep)) return { ok: false, reason: 'symlink escape' };
    if (!fs.statSync(abs).isFile()) return { ok: false, reason: 'not a file' };
  }
  return { ok: true, abs };
}

export function validateTestPlan({ root, plan, expectHeadSha = undefined, inventory = null } = {}) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return { ok: false, code: TEST_PLAN_CODES.PLAN_INVALID, reason: 'plan is not an object' };
  }
  const manifest = loadManifestForRoot(root);
  if (!manifest.ok) return { ok: false, code: TEST_PLAN_CODES.MANIFEST_INVALID, reason: manifest.reason };
  if (plan.manifestDigest !== manifest.manifestDigest) {
    return { ok: false, code: TEST_PLAN_CODES.PLAN_STALE, reason: 'manifest changed since the plan was built' };
  }
  if (plan.selectorDigest !== selectorDigest()) {
    return { ok: false, code: TEST_PLAN_CODES.PLAN_STALE, reason: 'selector changed since the plan was built' };
  }
  if (recomputePlanDigest(plan) !== plan.planDigest) {
    return { ok: false, code: TEST_PLAN_CODES.PLAN_INVALID, reason: 'planDigest does not match plan content (tampered plan)' };
  }
  if (!HEX40.test(plan.baseSha || '')) {
    return { ok: false, code: TEST_PLAN_CODES.PLAN_INVALID, reason: 'plan.baseSha is not a 40-hex SHA' };
  }
  if (!HEX40.test(plan.candidateSha || '')) {
    return { ok: false, code: TEST_PLAN_CODES.PLAN_INVALID, reason: 'plan.candidateSha is not a 40-hex SHA' };
  }
  const baseResolved = resolveBaseSha(root, plan.baseSha);
  if (!baseResolved.ok) return { ok: false, code: TEST_PLAN_CODES.BASE_UNRESOLVED, reason: baseResolved.reason };
  const head = resolveCandidateSha(root);
  if (!head.ok) return { ok: false, code: TEST_PLAN_CODES.CANDIDATE_UNKNOWN, reason: head.reason };
  // A plan is ALWAYS bound to its own candidate by default: if HEAD moved
  // after the plan was built, it is stale and must be rebuilt, not reused.
  const boundHead = expectHeadSha === undefined || expectHeadSha === null ? plan.candidateSha : expectHeadSha;
  if (boundHead && boundHead !== head.value) {
    return { ok: false, code: TEST_PLAN_CODES.PLAN_STALE, reason: `candidate HEAD moved (${String(boundHead).slice(0, 12)} -> ${head.value.slice(0, 12)}): replan before execution` };
  }
  const mb = git(['merge-base', plan.baseSha, plan.candidateSha], { root, allowFail: true });
  if (typeof mb !== 'string' || !HEX40.test(mb.trim())) {
    return { ok: false, code: TEST_PLAN_CODES.BASE_UNRELATED, reason: 'base and candidate have no merge-base in this repository' };
  }
  const owner = inventory || manifest.owner;
  for (const f of plan.files || []) {
    const safe = isSafeTestPath(root, f);
    if (!safe.ok) return { ok: false, code: TEST_PLAN_CODES.PATH_ESCAPE, reason: `${f}: ${safe.reason}` };
    if (!owner.has(f.slice('tests/'.length))) {
      return { ok: false, code: TEST_PLAN_CODES.PATH_NOT_TEST, reason: `${f} is not a manifest-owned test` };
    }
    if (!fs.existsSync(path.join(root, f))) {
      return { ok: false, code: TEST_PLAN_CODES.PLAN_STALE, reason: `${f} no longer exists` };
    }
  }
  if (plan.status !== 'READY' && plan.status !== 'NO_TESTS') {
    return { ok: false, code: TEST_PLAN_CODES.PLAN_INVALID, reason: `unknown plan status ${plan.status}` };
  }
  if (plan.status === 'READY' && (!Array.isArray(plan.files) || !plan.files.length)) {
    return { ok: false, code: TEST_PLAN_CODES.PLAN_INVALID, reason: 'READY plan has no files' };
  }
  if (plan.status === 'NO_TESTS' && Array.isArray(plan.files) && plan.files.length) {
    return { ok: false, code: TEST_PLAN_CODES.PLAN_INVALID, reason: 'NO_TESTS plan must select nothing' };
  }
  if (!plan.planDigest || recomputePlanDigest(plan) !== plan.planDigest) {
    return { ok: false, code: TEST_PLAN_CODES.PLAN_STALE, reason: 'plan is stale against its recorded digest' };
  }
  return { ok: true, manifest, headSha: head.value };
}

/** The single bridge from a validated plan to a spawnable command. The plan
 * is bound to ITS EXACT candidate HEAD: a plan built before a later commit
 * is stale and is refused, never silently re-used. */
export function testPlanGateCommand({ root, plan }) {
  const v = validateTestPlan({ root, plan, expectHeadSha: plan && plan.candidateSha });
  if (!v.ok) return { ok: false, code: v.code, reason: v.reason };
  if (plan.status !== 'READY') {
    return { ok: false, code: TEST_PLAN_CODES.PLAN_INVALID, reason: `plan status ${plan.status} cannot be executed`, status: plan.status, fullReason: plan.fullReason };
  }
  const argv = ['--test', '--test-reporter=tap', ...plan.files];
  return { ok: true, command: `node --test --test-reporter=tap ${plan.files.join(' ')}`, executable: process.execPath, argv, plan };
}

// ---------------------------------------------------------------------------
// (7) TAP evaluation — exit code alone is NEVER proof of a run.
// ---------------------------------------------------------------------------
export function parseTapSummary(text) {
  const s = {};
  for (const m of String(text || '').matchAll(/^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)\s*$/gm)) {
    s[m[1]] = Number(m[2]);
  }
  return s;
}

export function evaluateSummary({ exitCode, summary, fileCount, minTests = 0 }) {
  const reasons = [];
  for (const k of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    if (!Number.isInteger(summary[k])) reasons.push(`TAP summary is missing '${k}' (unproven run)`);
  }
  if (reasons.length) return { ok: false, reasons };
  if (exitCode !== 0) reasons.push(`exit code ${exitCode}`);
  if (summary.tests === 0) reasons.push('0 tests executed');
  if (summary.tests < fileCount) reasons.push(`${summary.tests} tests total for ${fileCount} files (aggregate check failed)`);
  if (summary.tests < minTests) reasons.push(`${summary.tests} tests < minTests ${minTests}`);
  if (summary.fail > 0) reasons.push(`${summary.fail} failed`);
  if (summary.cancelled > 0) reasons.push(`${summary.cancelled} cancelled`);
  if (summary.skipped > 0) reasons.push(`${summary.skipped} skipped (skip is not allowed)`);
  if (summary.todo > 0) reasons.push(`${summary.todo} todo (todo is not allowed)`);
  if (summary.pass !== summary.tests) reasons.push(`pass ${summary.pass} != tests ${summary.tests}`);
  return { ok: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// (8) Back-compat helpers kept for existing callers of scripts/run-tier.mjs.
// ---------------------------------------------------------------------------
export function unitOf(p) {
  const parts = p.split('/');
  return parts[0] === 'packages' && parts.length > 2 ? `packages/${parts[1]}/` : p;
}

export function unitsImportedBy(testRelPath, source) {
  const units = new Set();
  const base = path.posix.dirname(testRelPath);
  const add = (spec) => {
    const rel = path.posix.normalize(path.posix.join(base, spec));
    if (!rel.startsWith('..')) units.add(unitOf(rel));
  };
  for (const spec of parseImportSpecs(source)) {
    if (spec.startsWith('./') || spec.startsWith('../')) add(spec);
  }
  return units;
}
