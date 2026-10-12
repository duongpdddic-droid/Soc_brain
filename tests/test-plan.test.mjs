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
  buildImportGraph, selectAffectedTests, computePlanContentBinding,
  selectorDigest, TEST_PLAN_SELECTOR_VERSION,
} from '../packages/executor-launcher/test-plan.mjs';
import crypto from 'node:crypto';

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
  w('tests/y-outer.test.mjs', "import '../packages/y/y.mjs';\n");   // importer OUTSIDE the subsystem mapping
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
    'renamed.test.mjs', 'instr.test.mjs', 'y-outer.test.mjs',
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
  assert.equal(lm.onDisk.length, 12, 'every fixture test is in the inventory');
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
  assert.equal(p.files.length, 12, 'full = the whole inventory, never a T1+T2 subset');
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
  assert.equal(p.files.length, 12);
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
// (3b) Rework regressions — the four review findings, each proven by a test
// that FAILS on the pre-rework code (unbound content, closure swallowed by a
// mapping, digest blind to nested values, a self-asserted BASE).
// ---------------------------------------------------------------------------
test('rework/F1: a plan binds its CONTENT — drift or a new untracked file before execution is STALE', () => {
  const { dir, base } = mkPlanRepo();
  const p = planOf(dir, base);
  assert.match(p.contentBinding.digest, /^[0-9a-f]{64}$/, 'the plan carries a content binding');
  assert.match(p.contentBinding.contentDigest, /^[0-9a-f]{64}$/);

  // (a) nothing changed: the fresh observation equals the claim.
  let live = computePlanContentBinding({ root: dir });
  assert.equal(live.ok, true, JSON.stringify(live));
  assert.equal(live.value.digest, p.contentBinding.digest, 'live == planned while the content holds');
  let v = validateTestPlan({ root: dir, plan: p, liveContent: live.value });
  assert.equal(v.ok, true, JSON.stringify(v));

  // (b) tracked content changes AFTER planning -> typed PLAN_STALE, and the
  //     gate command is refused before any spawn could be derived.
  fs.appendFileSync(path.join(dir, 'packages', 'x', 'a.mjs'), '// drifted after planning\n');
  live = computePlanContentBinding({ root: dir });
  v = validateTestPlan({ root: dir, plan: p, liveContent: live.value });
  assert.equal(v.ok, false, 'drifted content is never valid for a stale selection');
  assert.equal(v.code, TEST_PLAN_CODES.PLAN_STALE);
  assert.match(v.reason, /drift/);
  const cmd = testPlanGateCommand({ root: dir, plan: p, liveContent: live.value });
  assert.equal(cmd.ok, false, 'the single spawn bridge refuses it too');

  // (c) an untracked source appearing after planning moves the binding.
  fs.writeFileSync(path.join(dir, 'packages', 'x', 'late-untracked.mjs'), 'export const l = 1;\n');
  const live2 = computePlanContentBinding({ root: dir });
  assert.equal(live2.ok, true, JSON.stringify(live2));
  assert.notEqual(live2.value.digest, p.contentBinding.digest,
    'a new untracked file changes the content binding');
  assert.equal(live2.value.untrackedCount > p.contentBinding.untrackedCount, true);

  // (d) a plan WITHOUT a content binding is not a plan — refused even when
  //     every other digest re-hashes cleanly.
  const bare = JSON.parse(JSON.stringify(p));
  delete bare.contentBinding;
  bare.planDigest = recomputePlanDigest(bare);
  v = validateTestPlan({ root: dir, plan: bare, liveContent: live2.value });
  assert.equal(v.ok, false);
  assert.equal(v.code, TEST_PLAN_CODES.PLAN_INVALID);
  assert.match(v.reason, /contentBinding/);
});

test('rework/F2: a mapping UNIONs with the reverse import closure — it never replaces it', () => {
  const { dir, base } = mkPlanRepo();
  // packages/y/ is a coreSubsystem mapped to t3, BUT y.mjs is also imported
  // by tests/y-outer.test.mjs — that graph-derived importer must be selected
  // TOO instead of being swallowed by the mapping's early exit.
  fs.writeFileSync(path.join(dir, 'packages', 'y', 'y.mjs'), 'export const y = 2;\n');
  const p = planOf(dir, base);
  assert.equal(p.mode, 'affected');
  assert.ok(p.files.includes('tests/t3.test.mjs'), 'the mapped consumer is selected');
  assert.ok(p.files.includes('tests/y-outer.test.mjs'),
    'the importer OUTSIDE the mapping is selected too (union, not replacement)');
  assert.ok(p.files.includes('tests/always.test.mjs'), 'the always tier is untouched');
  assert.equal(p.reasons['tests/t3.test.mjs'], 'core-subsystem:packages/y/');
  assert.equal(p.reasons['tests/y-outer.test.mjs'], 'dependency:packages/y/y.mjs');
});

test('rework/F2: a path mapping also unions with the closure (a real importer is never dropped)', () => {
  const { dir, base } = mkPlanRepo();
  // tests/fixtures/data.json is path-mapped to fixture.test.mjs; the fixture
  // file itself is only imported by fixture.test.mjs — but prove the same
  // union semantics on a MAPPED non-JS input whose consumer ALSO shows up in
  // the graph via its directory mapping target.
  fs.writeFileSync(path.join(dir, 'tests', 'fixtures', 'data.json'), '{"d":3}\n');
  const p = planOf(dir, base);
  assert.equal(p.mode, 'affected');
  assert.ok(p.files.includes('tests/fixture.test.mjs'), 'the mapping target is selected');
  assert.ok(p.files.includes('tests/always.test.mjs'), 'always tier holds');
});

test('rework/F3: the plan digest canonicalizes RECURSIVELY — nested reasons and key order are bound', () => {
  const { dir, base } = mkPlanRepo();
  fs.appendFileSync(path.join(dir, 'packages', 'x', 'a.mjs'), '// touch\n');
  const p = planOf(dir, base);
  assert.ok(p.reasons && Object.keys(p.reasons).length >= 1, 'a real selection carries reasons');
  const d0 = recomputePlanDigest(p);
  assert.equal(d0, p.planDigest, 'the stored digest IS the canonical digest');

  // (a) a NESTED reason value changes -> the digest MUST move. The old
  //     replacer-array canonicalization dropped nested keys entirely, so this
  //     tamper used to re-hash to the SAME value.
  const tampered = JSON.parse(JSON.stringify(p));
  const k = Object.keys(tampered.reasons)[0];
  tampered.reasons[k] = `${tampered.reasons[k]} [tampered]`;
  assert.notEqual(recomputePlanDigest(tampered), d0,
    'nested values are bound by the digest (recursive canonicalization)');

  // (b) key insertion ORDER never moves the digest — every object level is
  //     sorted, at every depth.
  const reasonsReversed = JSON.parse(JSON.stringify(p));
  reasonsReversed.reasons = Object.fromEntries(Object.entries(reasonsReversed.reasons).reverse());
  assert.equal(recomputePlanDigest(reasonsReversed), d0, 'nested key order is irrelevant');
  const topReversed = {};
  for (const key of Object.keys(p).reverse()) topReversed[key] = p[key];
  assert.equal(recomputePlanDigest(topReversed), d0, 'top-level key order is irrelevant');

  // (c) array ORDER is semantic and bound.
  const filesReversed = JSON.parse(JSON.stringify(p));
  filesReversed.files = [...filesReversed.files].reverse();
  assert.notEqual(recomputePlanDigest(filesReversed), d0, 'array order is bound');
});

test('rework/F3: the selector digest hashes the IMPLEMENTATION source bytes, not a constant', () => {
  const src = fs.readFileSync(
    fileURLToPath(new URL('../packages/executor-launcher/test-plan.mjs', import.meta.url)),
  );
  const expected = crypto.createHash('sha256')
    .update(`${TEST_PLAN_SELECTOR_VERSION}\0${src}`).digest('hex');
  assert.equal(selectorDigest(), expected,
    'the digest is version + this module source: editing the selector moves it');
  assert.match(selectorDigest(), /^[0-9a-f]{64}$/);
  // A constant-only hash (the pre-rework implementation) can never match it.
  const constantOnly = crypto.createHash('sha256')
    .update(JSON.stringify({ v: TEST_PLAN_SELECTOR_VERSION })).digest('hex');
  assert.notEqual(selectorDigest(), constantOnly);
});

test('rework/F4: expectedBaseSha from the TASK binding refuses a plan built from another base', () => {
  const { dir, base } = mkPlanRepo();
  // A second commit -> a different canonical BASE.
  fs.appendFileSync(path.join(dir, 'notes.txt'), 'moved on\n');
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.email=tpl@t', '-c', 'user.name=tpl', 'commit', '-m', 'base2']);
  const base2 = git(dir, ['rev-parse', 'HEAD']);
  assert.notEqual(base, base2);

  // The plan is self-consistent against ITS base...
  const p = planOf(dir, base);
  let v = validateTestPlan({ root: dir, plan: p, expectedBaseSha: base });
  assert.equal(v.ok, true, JSON.stringify(v));
  // ...but the task binding says the BASE is base2 -> typed refusal.
  v = validateTestPlan({ root: dir, plan: p, expectedBaseSha: base2 });
  assert.equal(v.ok, false, 'a plan from another base never executes for THIS task');
  assert.equal(v.code, TEST_PLAN_CODES.BASE_MISMATCH);
  assert.match(v.reason, /task BASE/);
  const cmd = testPlanGateCommand({ root: dir, plan: p, expectedBaseSha: base2 });
  assert.equal(cmd.ok, false, 'the spawn bridge refuses it');
  // A malformed expected base is an invalid PARAMETER, never a pass-through.
  v = validateTestPlan({ root: dir, plan: p, expectedBaseSha: 'not-a-sha' });
  assert.equal(v.ok, false);
  assert.equal(v.code, TEST_PLAN_CODES.PLAN_INVALID);
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

// ---------------------------------------------------------------------------
// Round-2 rework regression (F1): content that changes WHILE the plan is
// being computed is refused. The bracket is bindingBefore (before the
// manifest/changed-path/graph reads) .. bindingAfter (at assembly); the drift
// is REAL filesystem drift injected at the import-graph read — exactly between
// the changed-path scan and the single final snapshot the pre-fix code took.
// ---------------------------------------------------------------------------
test('rework2(F1): content that changes DURING planning is TEST_PLAN_PLAN_STALE — never a plan, on every branch', () => {
  const { dir, base } = mkPlanRepo();
  const probe = path.join(dir, 'during-plan-drift.mjs');
  const realRead = fs.readFileSync;
  let aReads = 0;
  let driftInjected = false;
  fs.readFileSync = function patchedRead(p, ...rest) {
    const out = realRead.call(this, p, ...rest);
    const norm = String(p).split(path.sep).join('/');
    if (norm.endsWith('packages/x/a.mjs')) {
      aReads += 1;
      // read #1 = bindingBefore's tracked hash; read #2 = the import-graph
      // read — AFTER the changed-path scan, BEFORE the final snapshot.
      if (aReads === 2 && !driftInjected) {
        driftInjected = true;
        fs.writeFileSync(probe, 'export const duringPlanDrift = 1;\n', 'utf8');
      }
    }
    return out;
  };
  try {
    const r = buildTestPlan({ root: dir, base, mode: 'auto' });
    assert.equal(driftInjected, true, 'the drift really happened mid-planning');
    assert.equal(r.ok, false, `a plan built across a moving byte must be refused: ${JSON.stringify(r)}`);
    assert.equal(r.code, TEST_PLAN_CODES.PLAN_STALE);
    assert.match(String(r.detail), /worktree content changed while the plan was being built/);
    assert.equal(fs.existsSync(probe), true, 'the probe is real untracked drift on disk');
  } finally {
    fs.readFileSync = realRead;
    if (fs.existsSync(probe)) fs.unlinkSync(probe);
  }
});
