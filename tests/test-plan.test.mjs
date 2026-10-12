// tests/test-plan.test.mjs — the deterministic affected-test planner matrix.
//
// Covers the contract this gate stands on:
//   * ONE canonical manifest (tests/tiers.json) with fail-closed validation,
//     `all` derived from the filesystem inventory, smoke as a REFERENCE
//     subset (never a second ownership tier), no stored `all` list;
//   * selection: direct change, deep A->B->C closure, re-exports, literal
//     dynamic import, cycles (visited set), fs-read fixture via explicit
//     path mapping, subsystem mapping, unknown -> FULL with a reason,
//     .md/.txt treated by PATH (never blanket-ignored), added/deleted/
//     renamed changes carrying BOTH the old and the new path;
//   * plan binding: base -> exact SHA, merge-base proof, digest binding
//     (manifest + selector + plan), stale/tampered/escaping plans refused,
//     NO_TESTS as an explicit state that is never a pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  loadManifestForRoot, buildTestPlan, validateTestPlan, testPlanGateCommand,
  recomputePlanDigest, computeChangedPaths, TEST_PLAN_CODES, TEST_PLAN_NO_TESTS_REASONS,
  buildImportGraph, selectAffectedTests,
} from '../packages/executor-launcher/test-plan.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  }).trim();
}

// A miniature but structurally complete repo: every selection feature the
// planner claims has a real file + real import edge here.
function mkPlanRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-'));
  git(dir, ['init']);
  const w = (rel, content) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  };
  // --- tests ---------------------------------------------------------------
  w('tests/a.test.mjs', "import '../packages/x/a.mjs';\n");
  w('tests/b.test.mjs', "import '../packages/x/b.mjs';\n");
  w('tests/chain.test.mjs', "import '../packages/x/c.mjs';\n");       // c.mjs -> b.mjs
  w('tests/reexport.test.mjs', "import '../packages/x/e.mjs';\n");    // e.mjs re-exports a.mjs
  w('tests/dyn.test.mjs', "const m = await import('../packages/x/dyn.mjs');\nexport default m;\n");
  w('tests/cycle.test.mjs', "import '../packages/x/cycle-a.mjs';\n"); // a <-> b cycle
  w('tests/fixture.test.mjs',
    "import { readFileSync } from 'node:fs';\nreadFileSync(new URL('./fixtures/data.json', import.meta.url));\n");
  w('tests/t3.test.mjs', "import '../packages/y/y.mjs';\n");
  w('tests/always.test.mjs', 'export const x = 1;\n');
  w('tests/renamed.test.mjs', "import '../packages/x/a2.mjs';\n");    // target arrives via git mv later
  w('tests/instr.test.mjs', "import '../packages/z/z.mjs';\n");
  // --- sources -------------------------------------------------------------
  w('packages/x/a.mjs', 'export const a = 1;\n');
  w('packages/x/b.mjs', 'export const b = 1;\n');
  w('packages/x/c.mjs', "import './b.mjs';\nexport const c = 1;\n");
  w('packages/x/e.mjs', "export * from './a.mjs';\n");
  w('packages/x/dyn.mjs', 'export const dyn = 1;\n');
  w('packages/x/cycle-a.mjs', "import './cycle-b.mjs';\nexport const ca = 1;\n");
  w('packages/x/cycle-b.mjs', "import './cycle-a.mjs';\nexport const cb = 1;\n");
  w('packages/y/y.mjs', 'export const y = 1;\n');
  w('packages/y/y-config.json', '{"k":1}\n');
  w('packages/z/z.mjs', 'export const z = 1;\n');
  w('packages/ind/ind.mjs', 'export const ind = 1;\n');              // imported by nobody
  w('tests/fixtures/data.json', '{"d":1}\n');
  w('docs/readme.md', '# docs only\n');
  w('runtime-instruction.md', '# consumed as a runtime instruction\n');
  w('notes.txt', 'scratch\n');
  // --- the ONE manifest ----------------------------------------------------
  const testFiles = [
    'a.test.mjs', 'b.test.mjs', 'chain.test.mjs', 'reexport.test.mjs', 'dyn.test.mjs',
    'cycle.test.mjs', 'fixture.test.mjs', 't3.test.mjs', 'always.test.mjs',
    'renamed.test.mjs', 'instr.test.mjs',
  ];
  w('tests/tiers.json', `${JSON.stringify({
    version: '1',
    always: ['always.test.mjs'],
    smoke: ['a.test.mjs', 'b.test.mjs'],
    pathMappings: { 'tests/fixtures/': ['fixture.test.mjs'] },
    fullTriggerPaths: ['package.json', 'tests/tiers.json'],
    fullTriggerPrefixes: ['.github/'],
    ignorePrefixes: ['docs/'],
    ignoreSuffixes: [],
    coreSubsystems: { 'packages/y/': ['t3.test.mjs'] },
    tiers: { t1: { minTests: 1, files: testFiles } },
  }, null, 2)}\n`);
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.email=tpl@t', '-c', 'user.name=tpl', 'commit', '-m', 'base']);
  const base = git(dir, ['rev-parse', 'HEAD']);
  return { dir, base, testFiles };
}

const planOf = (root, base, mode = 'auto') => {
  const r = buildTestPlan({ root, base, mode });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.plan;
};

// ---------------------------------------------------------------------------
// (1) Manifest — one canonical source, fail-closed validation.
// ---------------------------------------------------------------------------
test('manifest: the canonical source validates, `all` is DERIVED, smoke is a subset', () => {
  const { dir } = mkPlanRepo();
  const lm = loadManifestForRoot(dir);
  assert.equal(lm.ok, true, lm.reason);
  assert.deepEqual(lm.onDisk, lm.onDisk.slice().sort(), 'inventory is sorted');
  assert.equal(lm.onDisk.length, 11, 'every fixture test is in the inventory');
  assert.equal(lm.onDisk.includes('always.test.mjs'), true);
  for (const f of lm.smoke) assert.ok(lm.owner.has(f), 'smoke entries are tier-owned files');
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'tests', 'tiers.json'), 'utf8'));
  assert.equal('all' in raw, false, 'no independent stored `all` list exists');
  assert.ok(lm.manifestDigest && /^[0-9a-f]{64}$/.test(lm.manifestDigest));
});

test('manifest: duplicate owner / orphan / ghost / .md ignore-suffix / stored `all` are all refused', () => {
  const { dir } = mkPlanRepo();
  const mp = path.join(dir, 'tests', 'tiers.json');
  const base0 = JSON.parse(fs.readFileSync(mp, 'utf8'));
  const read = () => JSON.parse(JSON.stringify(base0)); // every case starts from the ORIGINAL
  const write = (o) => fs.writeFileSync(mp, JSON.stringify(o), 'utf8');
  const expectBad = (needle) => {
    const r = loadManifestForRoot(dir);
    assert.equal(r.ok, false, 'must fail closed');
    assert.match(r.reason, needle);
  };

  let m = read();
  m.tiers.t1.files = [...m.tiers.t1.files.slice(0, 3), m.tiers.t1.files[0]]; // duplicate
  write(m); expectBad(/assigned to both/);

  m = read();
  m.tiers.t1.files = m.tiers.t1.files.slice(0, 10); // drop one -> orphan on disk
  write(m); expectBad(/no tier/);

  m = read();
  m.tiers.t1.files = [...m.tiers.t1.files, 'ghost.test.mjs']; // nonexistent
  write(m); expectBad(/do not exist/);

  m = read();
  m.ignoreSuffixes = ['.md'];
  write(m); expectBad(/must not blanket-ignore \.md/);

  m = read();
  m.all = ['a.test.mjs'];
  write(m); expectBad(/independent `all`/);
});

// ---------------------------------------------------------------------------
// (2) Selection matrix.
// ---------------------------------------------------------------------------
test('selection: direct change selects exactly its test (+ always), never siblings', () => {
  const { dir, base } = mkPlanRepo();
  fs.writeFileSync(path.join(dir, 'packages', 'x', 'a.mjs'), 'export const a = 2;\n');
  const p = planOf(dir, base);
  assert.equal(p.mode, 'affected');
  assert.equal(p.status, 'READY');
  assert.deepEqual(p.files, ['tests/a.test.mjs', 'tests/always.test.mjs', 'tests/reexport.test.mjs'].sort());
  assert.equal(p.reasons['tests/a.test.mjs'], 'dependency:packages/x/a.mjs');
  assert.equal(p.files.includes('tests/b.test.mjs'), false, 'a sibling test must not be swept in');
  assert.equal(p.fullReason, null);
});

test('selection: A -> B -> C reverse closure reaches the deep test through the chain', () => {
  const { dir, base } = mkPlanRepo();
  fs.writeFileSync(path.join(dir, 'packages', 'x', 'b.mjs'), 'export const b = 2;\n');
  const p = planOf(dir, base);
  assert.equal(p.mode, 'affected');
  assert.ok(p.files.includes('tests/chain.test.mjs'), 'chain.test.mjs imports c.mjs which imports b.mjs');
  assert.ok(p.files.includes('tests/b.test.mjs'));
  assert.equal(p.files.includes('tests/a.test.mjs'), false, 'the unrelated branch stays out');
});

test('selection: a re-export edge propagates a.mjs -> e.mjs -> reexport.test.mjs', () => {
  const { dir, base } = mkPlanRepo();
  fs.writeFileSync(path.join(dir, 'packages', 'x', 'a.mjs'), 'export const a = 3;\n');
  const p = planOf(dir, base);
  assert.ok(p.files.includes('tests/reexport.test.mjs'), 'export ... from is a real dependency edge');
});

test('selection: literal dynamic import(...) is followed like a static import', () => {
  const { dir, base } = mkPlanRepo();
  fs.writeFileSync(path.join(dir, 'packages', 'x', 'dyn.mjs'), 'export const dyn = 2;\n');
  const p = planOf(dir, base);
  assert.equal(p.mode, 'affected');
  assert.ok(p.files.includes('tests/dyn.test.mjs'));
});

test('selection: an import cycle terminates (visited set) and still reaches the test', () => {
  const { dir, base } = mkPlanRepo();
  fs.writeFileSync(path.join(dir, 'packages', 'x', 'cycle-b.mjs'), 'export const cb = 2;\n');
  const p = planOf(dir, base);
  assert.equal(p.mode, 'affected');
  assert.ok(p.files.includes('tests/cycle.test.mjs'));
});

test('selection: an fs-read fixture resolves through EXPLICIT path mapping, not guessing', () => {
  const { dir, base } = mkPlanRepo();
  fs.writeFileSync(path.join(dir, 'tests', 'fixtures', 'data.json'), '{"d":2}\n');
  const p = planOf(dir, base);
  assert.equal(p.mode, 'affected', 'the mapping proves the consumer');
  assert.ok(p.files.includes('tests/fixture.test.mjs'));
  assert.equal(p.reasons['tests/fixture.test.mjs'], 'path-mapping:tests/fixtures/');
});

test('selection: core subsystem mapping covers non-import config inside the subsystem', () => {
  const { dir, base } = mkPlanRepo();
  fs.writeFileSync(path.join(dir, 'packages', 'y', 'y-config.json'), '{"k":2}\n');
  const p = planOf(dir, base);
  assert.equal(p.mode, 'affected');
  assert.ok(p.files.includes('tests/t3.test.mjs'));
  assert.equal(p.reasons['tests/t3.test.mjs'], 'core-subsystem:packages/y/');
});

test('selection: an unknown change selects the FULL inventory with an explicit reason', () => {
  const { dir, base } = mkPlanRepo();
  fs.mkdirSync(path.join(dir, 'unknown-folder'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'unknown-folder', 'foo.js'), 'export const foo = 1;\n');
  const p = planOf(dir, base);
  assert.equal(p.mode, 'full');
  assert.match(p.fullReason, /unresolved-dependency:unknown-folder\/foo\.js/);
  assert.equal(p.files.length, 11, 'full = the whole inventory, never a T1+T2 subset');
});

test('selection: a module nothing imports is UNPROVABLE loading semantics -> full, with a reason', () => {
  const { dir, base } = mkPlanRepo();
  fs.writeFileSync(path.join(dir, 'packages', 'ind', 'ind.mjs'), 'export const ind = 2;\n');
  const p = planOf(dir, base);
  assert.equal(p.mode, 'full', 'no importer proves nothing — fs/spawn loading is possible');
  assert.match(p.fullReason, /unresolved-dependency:packages\/ind\/ind\.mjs/);
});

test('selection: .md/.txt are judged by PATH — docs/ is proven non-runtime, root runtime .md is NOT', () => {
  const { dir, base } = mkPlanRepo();
  // (a) docs/ is an explicit ignore rule -> docs-only is an EXPLICIT state
  fs.writeFileSync(path.join(dir, 'docs', 'readme.md'), '# changed\n');
  const docsOnly = planOf(dir, base);
  assert.equal(docsOnly.status, 'NO_TESTS');
  assert.equal(docsOnly.fullReason, TEST_PLAN_NO_TESTS_REASONS.DOCS_ONLY);
  assert.deepEqual(docsOnly.files, [], 'no-tests is explicit, never an empty pass');

  // (b) a root-level .md is a runtime instruction file: UNKNOWN -> full
  fs.writeFileSync(path.join(dir, 'runtime-instruction.md'), '# changed\n');
  const md = planOf(dir, base);
  assert.equal(md.mode, 'full');
  assert.match(md.fullReason, /unclassified-change:runtime-instruction\.md/);

  // (c) .txt has no blanket protection either
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'scratch v2\n');
  const txt = planOf(dir, base);
  assert.equal(txt.mode, 'full');
  assert.match(txt.fullReason, /unclassified-change:notes\.txt/);
});

test('selection: a deleted file keeps finding its consumers through their literal edges', () => {
  const { dir, base } = mkPlanRepo();
  fs.rmSync(path.join(dir, 'packages', 'x', 'dyn.mjs'));
  const p = planOf(dir, base);
  assert.equal(p.mode, 'affected');
  assert.ok(p.files.includes('tests/dyn.test.mjs'), 'the importing test is still selected');
  assert.ok(p.changedPaths.includes('packages/x/dyn.mjs'), 'the old path is part of the change');
});

test('selection: a rename carries BOTH the old and the new path to their consumers', () => {
  const { dir, base } = mkPlanRepo();
  git(dir, ['mv', 'packages/x/a.mjs', 'packages/x/a2.mjs']);
  const p = planOf(dir, base);
  assert.ok(p.changedPaths.includes('packages/x/a.mjs'), 'old path recorded');
  assert.ok(p.changedPaths.includes('packages/x/a2.mjs'), 'new path recorded');
  assert.ok(p.files.includes('tests/a.test.mjs'), 'consumer of the OLD path stays selected');
  assert.ok(p.files.includes('tests/renamed.test.mjs'), 'consumer of the NEW path is selected');
});

test('selection: task-required `full` beats `affected` (requested-full reason)', () => {
  const { dir, base } = mkPlanRepo();
  fs.writeFileSync(path.join(dir, 'runtime-instruction.md'), '# changed\n');
  const p = planOf(dir, base, 'full');
  assert.equal(p.mode, 'full');
  assert.equal(p.fullReason, 'requested-full');
  assert.equal(p.files.length, 11);
});

test('selection: `always` runs in every affected plan; smoke is NOT auto-added', () => {
  const { dir, base } = mkPlanRepo();
  fs.writeFileSync(path.join(dir, 'packages', 'x', 'b.mjs'), 'export const b = 2;\n');
  const p = planOf(dir, base);
  assert.ok(p.files.includes('tests/always.test.mjs'), 'always is unconditional');
  // a.test.mjs is in smoke AND imports a.mjs (unchanged) -> must NOT be added
  assert.equal(p.files.includes('tests/a.test.mjs'), false, 'smoke is a reference subset, not a plan default');
});

test('selection: an empty changeset is an explicit NO_TESTS (NO_CHANGES), never a pass', () => {
  const { dir, base } = mkPlanRepo();
  const p = planOf(dir, base);
  assert.equal(p.status, 'NO_TESTS');
  assert.equal(p.fullReason, TEST_PLAN_NO_TESTS_REASONS.NO_CHANGES);
  const cmd = testPlanGateCommand({ root: dir, plan: p });
  assert.equal(cmd.ok, false, 'a NO_TESTS plan can never be executed as a pass');
});

// ---------------------------------------------------------------------------
// (3) Plan binding — digests, staleness, tampering, path safety, BASE.
// ---------------------------------------------------------------------------
test('binding: a valid plan maps to exact argv; base resolution fails closed', () => {
  const { dir, base } = mkPlanRepo();
  fs.writeFileSync(path.join(dir, 'packages', 'x', 'a.mjs'), 'export const a = 4;\n');
  const p = planOf(dir, base);
  const cmd = testPlanGateCommand({ root: dir, plan: p });
  assert.equal(cmd.ok, true, JSON.stringify(cmd));
  assert.deepEqual(cmd.argv, ['--test', '--test-reporter=tap', ...p.files]);
  assert.equal(cmd.executable, process.execPath);

  // unknown base SHA
  const r = buildTestPlan({ root: dir, base: '0'.repeat(40) });
  assert.equal(r.ok, false);
  assert.equal(r.code, TEST_PLAN_CODES.BASE_UNRESOLVED);

  // base from ANOTHER repository (unrelated object database)
  const other = mkPlanRepo();
  const r2 = buildTestPlan({ root: dir, base: other.base });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, TEST_PLAN_CODES.BASE_UNRESOLVED, 'a base that does not resolve HERE is refused');
});

test('binding: a tampered plan (files/argv edited) is refused by its planDigest', () => {
  const { dir, base } = mkPlanRepo();
  fs.writeFileSync(path.join(dir, 'packages', 'x', 'a.mjs'), 'export const a = 5;\n');
  const p = planOf(dir, base);
  const tampered = JSON.parse(JSON.stringify(p));
  tampered.files = ['tests/a.test.mjs']; // shrink the selection after the fact
  const v = validateTestPlan({ root: dir, plan: tampered });
  assert.equal(v.ok, false);
  assert.equal(v.code, TEST_PLAN_CODES.PLAN_INVALID);
  assert.match(v.reason, /planDigest/);

  const cmd = testPlanGateCommand({ root: dir, plan: tampered });
  assert.equal(cmd.ok, false, 'a tampered plan never becomes argv');
});

test('binding: a self-consistent but ESCAPING plan is refused by path safety', () => {
  const { dir, base } = mkPlanRepo();
  fs.writeFileSync(path.join(dir, 'packages', 'x', 'a.mjs'), 'export const a = 6;\n');
  const p = planOf(dir, base);
  const evil = { ...p, files: ['tests/../../evil.test.mjs'] };
  evil.planDigest = recomputePlanDigest(evil);
  const v = validateTestPlan({ root: dir, plan: evil });
  assert.equal(v.ok, false);
  assert.equal(v.code, TEST_PLAN_CODES.PATH_ESCAPE);

  const evil2 = { ...p, files: ['/etc/evil.test.mjs'] };
  evil2.planDigest = recomputePlanDigest(evil2);
  assert.equal(validateTestPlan({ root: dir, plan: evil2 }).code, TEST_PLAN_CODES.PATH_ESCAPE);

  const evil3 = { ...p, files: ['tests/not-owned.test.mjs'] };
  evil3.planDigest = recomputePlanDigest(evil3);
  const v3 = validateTestPlan({ root: dir, plan: evil3 });
  assert.equal(v3.ok, false, 'a path outside the manifest inventory is never spawned');
});

test('binding: a plan whose candidate HEAD moved is STALE — refused before spawn', () => {
  const { dir, base } = mkPlanRepo();
  fs.writeFileSync(path.join(dir, 'packages', 'x', 'a.mjs'), 'export const a = 7;\n');
  const p = planOf(dir, base);
  const stale = { ...p, candidateSha: '0'.repeat(40) }; // a different candidate
  stale.planDigest = recomputePlanDigest(stale);
  const v = validateTestPlan({ root: dir, plan: stale });
  assert.equal(v.ok, false);
  assert.equal(v.code, TEST_PLAN_CODES.PLAN_STALE);
  const cmd = testPlanGateCommand({ root: dir, plan: stale });
  assert.equal(cmd.ok, false);
});

test('binding: a manifest edited after planning makes the plan STALE', () => {
  const { dir, base } = mkPlanRepo();
  fs.writeFileSync(path.join(dir, 'packages', 'x', 'a.mjs'), 'export const a = 8;\n');
  const p = planOf(dir, base);
  const mp = path.join(dir, 'tests', 'tiers.json');
  const raw = fs.readFileSync(mp, 'utf8');
  const obj = JSON.parse(raw);
  // Same semantics, DIFFERENT bytes -> the manifest digest must move.
  fs.writeFileSync(mp, `${JSON.stringify(obj)}\n`, 'utf8');
  const v = validateTestPlan({ root: dir, plan: p });
  assert.equal(v.ok, false);
  assert.equal(v.code, TEST_PLAN_CODES.PLAN_STALE);
  assert.match(v.reason, /manifest/);
});

test('binding: dirty tracked content and untracked source are part of the planned change', () => {
  const { dir, base } = mkPlanRepo();
  fs.writeFileSync(path.join(dir, 'packages', 'x', 'a.mjs'), 'export const a = 9; // dirty\n');
  fs.writeFileSync(path.join(dir, 'packages', 'x', 'brand-new.mjs'), 'export const n = 1;\n');
  const lm = loadManifestForRoot(dir);
  const r = computeChangedPaths({
    root: dir, baseSha: base, candidateSha: git(dir, ['rev-parse', 'HEAD']), manifest: lm,
  });
  assert.equal(r.ok, true, r.reason);
  assert.ok(r.changed.includes('packages/x/a.mjs'), 'tracked dirty content counts');
  assert.ok(r.changed.includes('packages/x/brand-new.mjs'), 'untracked source counts');
});

// ---------------------------------------------------------------------------
// (4) The repo's own seams: one manifest, compatibility consumers.
// ---------------------------------------------------------------------------
test('repo: npm test:gate files and every tier entry are members of the SAME inventory', () => {
  const lm = loadManifestForRoot(REPO_ROOT);
  assert.equal(lm.ok, true, lm.reason);
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const gate = pkg.scripts && pkg.scripts['test:gate'];
  assert.equal(typeof gate, 'string', 'test:gate script exists (compatibility contract)');
  const gateFiles = gate.split(/\s+/).filter((t) => t.endsWith('.test.mjs'))
    .map((t) => path.posix.basename(t));
  assert.ok(gateFiles.length >= 1, 'test:gate names test files');
  for (const f of gateFiles) assert.ok(lm.onDisk.includes(f), `${f} is in the shared inventory`);
  for (const [tier, def] of Object.entries(lm.tiers)) {
    for (const f of def.files) assert.ok(lm.onDisk.includes(f), `${tier}/${f} exists on disk`);
  }
  const storedAll = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'tests', 'tiers.json'), 'utf8')).all;
  assert.equal(storedAll, undefined, 'the canonical manifest stores NO `all` list');
});

test('repo: the gate planner produces a bindable plan against THIS worktree', () => {
  const head = git(REPO_ROOT, ['rev-parse', 'HEAD']);
  const mb = git(REPO_ROOT, ['merge-base', 'origin/main', 'HEAD']);
  const lm = loadManifestForRoot(REPO_ROOT);
  const r = computeChangedPaths({ root: REPO_ROOT, baseSha: mb, candidateSha: head, manifest: lm });
  assert.equal(r.ok, true, r.reason);
  const built = buildTestPlan({ root: REPO_ROOT, base: mb, mode: 'auto' });
  assert.equal(built.ok, true, JSON.stringify(built));
  const p = built.plan;
  assert.ok(['affected', 'full'].includes(p.mode));
  assert.equal(p.status, 'READY');
  assert.ok(p.files.length >= 1, 'this task has real changes -> at least one test');
  // determinism: rebuilding from the same inputs yields the SAME digest
  const again = buildTestPlan({ root: REPO_ROOT, base: mb, mode: 'auto' });
  assert.equal(again.plan.planDigest, p.planDigest, 'the plan is deterministic');
  const v = validateTestPlan({ root: REPO_ROOT, plan: p });
  assert.equal(v.ok, true, v.reason);
});

test('repo: raw graph/select helpers stay importable and safe for legacy callers', () => {
  const g = buildImportGraph(REPO_ROOT);
  assert.ok(g.files.size > 100, 'the repo graph is built from real files');
  const lm = loadManifestForRoot(REPO_ROOT);
  const sel = selectAffectedTests({ manifest: lm, graph: g, changed: ['docs/anything.md'] });
  // docs/ is proven non-runtime -> ignored; the only selected files are the
  // manifest's unconditional `always` subset (smoke-grade regressions).
  assert.deepEqual(sel.selected, lm.always.slice().sort());
  assert.deepEqual(sel.ignored, ['docs/anything.md']);
  assert.equal(sel.fallback, false, 'a proven-non-runtime path never forces full');
});
