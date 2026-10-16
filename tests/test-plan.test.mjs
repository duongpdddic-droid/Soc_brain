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
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  loadManifestForRoot, buildTestPlan, validateTestPlan, testPlanGateCommand,
  recomputePlanDigest, computeChangedPaths, TEST_PLAN_CODES, TEST_PLAN_NO_TESTS_REASONS,
  buildImportGraph, selectAffectedTests, computePlanContentBinding,
  selectorDigest, TEST_PLAN_SELECTOR_VERSION, hasOpaqueDynamicImport,
  parseImportSpecs, stripCommentsAndStrings,
} from '../packages/executor-launcher/test-plan.mjs';
import crypto from 'node:crypto';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Fixture repos live in the OS temp dir. ONE test hook removes them all, so an
// assertion failure (or an early `return`) can never leave a tree — and its git
// objects — behind on the machine running the gate.
const TMP_FIXTURES = new Set();
after(() => {
  for (const d of TMP_FIXTURES) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  TMP_FIXTURES.clear();
});

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  }).trim();
}

// A miniature but structurally complete repo: every selection feature the
// planner claims has a real file + real import edge here.
//
// `tag` makes a fixture GENUINELY distinct (extra committed file + its own
// commit message). Two untagged fixtures share tree/author/committer and — at
// git's one-second timestamp resolution — can hash to the SAME commit SHA, so
// a "foreign BASE" must never be built from an untagged second fixture.
function mkPlanRepo({ tag = null } = {}) {
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
  // A tagged fixture carries its OWN committed file, so its tree hash (and
  // therefore its commit SHA) can never collide with an untagged fixture —
  // independent of GIT_AUTHOR_DATE / GIT_COMMITTER_DATE.
  if (tag) w(`fixture-tag-${tag}.md`, `foreign fixture: ${tag}\n`);
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.email=tpl@t', '-c', 'user.name=tpl', 'commit', '-m', tag ? `base ${tag}` : 'base']);
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

  // base from ANOTHER repository (unrelated object database). The foreign
  // fixture is built with its OWN committed content + commit message, so its
  // SHA is genuinely different even when git's second-resolution timestamps
  // coincide (fixed GIT_AUTHOR_DATE/GIT_COMMITTER_DATE must not alias them).
  const other = mkPlanRepo({ tag: 'foreign' });
  assert.notEqual(other.base, base,
    'fixture precondition: the foreign BASE must be a DIFFERENT commit');
  let foreignResolves = true;
  try {
    foreignResolves = git(dir, ['rev-parse', '--verify', '--quiet', `${other.base}^{commit}`]) === other.base;
  } catch { foreignResolves = false; }
  assert.equal(foreignResolves, false,
    'fixture precondition: the foreign SHA is absent from THIS repository');
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

// ---------------------------------------------------------------------------
// Round-3 rework regression (review R3-02): a changed source with BOTH a
// static consumer and an OPAQUE (non-literal) dynamic consumer. The pre-fix
// selector only fell back when the CHANGED file itself was opaque, so a
// nonempty static closure certified a plan that silently dropped the opaque
// consumer — a false green (the dropped test fails on the very change).
// ---------------------------------------------------------------------------
function mkOpaqueConsumerRepo({ dynamicBody = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-opq-'));
  TMP_FIXTURES.add(dir);
  git(dir, ['init']);
  const w = (rel, content) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  };
  w('packages/sample/value.mjs', 'export const n = 1;\n');
  // static consumer: the value is imported literally.
  w('tests/static.test.mjs',
    "import test from 'node:test';\nimport { n } from '../packages/sample/value.mjs';\ntest('static consumer', () => { if (typeof n !== 'number') throw new Error('n'); });\n");
  // opaque consumer: the specifier cannot be resolved from the graph, so the
  // edge is invisible — and this test FAILS when the export changes. The body
  // is a parameter so each non-literal FORM (variable, concatenation, template
  // interpolation, nested interpolation) is exercised by the same fixture.
  w('tests/dynamic.test.mjs', dynamicBody || "import test from 'node:test';\nimport assert from 'node:assert/strict';\nconst target = '../packages/sample/value.mjs';\ntest('opaque dynamic consumer', async () => { assert.equal((await import(target)).n, 1); });\n");
  // unrelated test: must NOT be swept in by the conservative union.
  w('tests/plain.test.mjs', "import test from 'node:test';\ntest('unrelated', () => {});\n");
  w('docs/readme.md', '# docs\n');
  w('tests/tiers.json', `${JSON.stringify({
    version: '1',
    always: [],
    smoke: [],
    pathMappings: {},
    fullTriggerPaths: [],
    fullTriggerPrefixes: [],
    ignorePrefixes: ['docs/'],
    ignoreSuffixes: [],
    coreSubsystems: {},
    tiers: { t1: { minTests: 1, files: ['static.test.mjs', 'dynamic.test.mjs', 'plain.test.mjs'] } },
  }, null, 2)}\n`);
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.email=opq@t', '-c', 'user.name=opq', 'commit', '-m', 'base']);
  return { dir, base: git(dir, ['rev-parse', 'HEAD']) };
}

test('rework3(R3-02): an opaque dynamic consumer is never dropped when the changed source ALSO has a static consumer', async () => {
  const { dir, base } = mkOpaqueConsumerRepo();
  await assertFixturePassesBeforeTheChange(dir);
  fs.writeFileSync(path.join(dir, 'packages', 'sample', 'value.mjs'), 'export const n = 2;\n');
  const p = planOf(dir, base);
  assert.equal(p.mode, 'affected');
  assert.ok(p.files.includes('tests/static.test.mjs'), 'the static consumer is selected');
  assert.ok(p.files.includes('tests/dynamic.test.mjs'),
    'the OPAQUE dynamic consumer is selected too — the pre-fix selector dropped it and certified a false green');
  assert.equal(p.files.includes('tests/plain.test.mjs'), false,
    'an unrelated test is not swept in: the union is bounded, not a blanket FULL');
  assert.match(p.reasons['tests/dynamic.test.mjs'], /^opaque-importer:/,
    'the selection reason names the opaque importer');
});

test('rework3(R3-02): an opaque importer is read from CODE — prose that merely mentions import( is not one', () => {
  // A comment / string mentioning a dynamic import is not a dynamic import.
  assert.equal(hasOpaqueDynamicImport('// see import(), require()\nconst s = "call import (x) here";\n'), false);
  assert.equal(hasOpaqueDynamicImport("const spec = './x.mjs';\nawait import(spec);\n"), true,
    'a real non-literal dynamic import is opaque');
  assert.equal(hasOpaqueDynamicImport("await import('./x.mjs');\n"), false,
    'a literal dynamic import is not opaque');
  // ...and the real repo keeps a SMALL opaque set because of that: a prose-only
  // mention never marks a file as an unbounded importer.
  const g = buildImportGraph(REPO_ROOT);
  assert.equal(g.opaque.has('packages/runtime-sandbox/runtime-sandbox.mjs'), false,
    'a file whose only "import (" is a comment is NOT an opaque importer');
  assert.equal(g.opaque.has('packages/client-mcp/route-worker.mjs'), true,
    'a real non-literal dynamic import IS an opaque importer');
});

test('rework3(R3-02): the real repo does not degenerate — a JS change selects a bounded affected set, not FULL', () => {
  const g = buildImportGraph(REPO_ROOT);
  const lm = loadManifestForRoot(REPO_ROOT);
  const sel = selectAffectedTests({ manifest: lm, graph: g, changed: ['packages/runtime-sandbox/activity-lease.mjs'] });
  assert.equal(sel.fallback, false,
    `a normal source change must not fall back to FULL because of an unrelated opaque importer: ${JSON.stringify(sel.fullReasons)}`);
  const opaqueReasons = Object.values(sel.reasons).filter((w) => /^opaque-/.test(w));
  assert.ok(opaqueReasons.length >= 1, 'the opaque consumers are included, with an explicit reason');
  assert.ok(opaqueReasons.length <= 10,
    `the opaque union must stay bounded (got ${opaqueReasons.length}): a policy that forces FULL on every change would not be acceptable`);
  for (const w of opaqueReasons) assert.match(w, /^opaque-(importer|consumer):packages\//,
    'every opaque reason names the code-level opaque importer');
});

// ---------------------------------------------------------------------------
// Round-4 rework (review R3-02 RESIDUAL): the detector must read the COMPLETE
// import argument. A literal PREFIX followed by a concatenation, and an
// import() buried in a template's `${...}` interpolation, both resolve NO
// static edge — and the previous detector treated them as safe, so a changed
// source's dynamic consumer was dropped and the reduced selection went GREEN
// while the full fixture FAILED. The proofs below RUN both sets for real.
// ---------------------------------------------------------------------------
const OPQ_CONCAT_BODY = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "const name = 'value.mjs';",
  "test('opaque consumer via concatenation', async () => { assert.equal((await import('../packages/sample/' + name)).n, 1); });",
  '',
].join('\n');
const OPQ_TEMPLATE_BODY = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "const target = '../packages/sample/value.mjs';",
  "test('opaque consumer inside a template interpolation', async () => { const text = `${(await import(target)).n}`; assert.equal(text, '1'); });",
  '',
].join('\n');
const OPQ_NESTED_BODY = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "const target = '../packages/sample/value.mjs';",
  "test('opaque consumer inside a NESTED interpolation', async () => { const s = `a${ `b` }${ (await import(target)).n }`; assert.equal(s, 'ab1'); });",
  '',
].join('\n');

// A REAL run of a test set in the fixture: returns the actual process exit
// code, the captured stdout+stderr, and HOW the run ended — never a mocked TAP.
//
// A nested `node --test` would otherwise inherit NODE_TEST_CONTEXT=child-v8
// from this very test runner and then NOT act as a runner at all (it exits 0
// having executed nothing) — which would silently turn every "did it fail?"
// check into a no-op. The variable is stripped so the child is a real,
// independent run, `--test-reporter=tap` is requested EXPLICITLY, and the TAP
// summary is parsed so a silent no-op can never masquerade as a pass.
//
// The child runs under a FINITE deadline and is spawned (not execFileSync) so
// that deadline can RECLAIM the process TREE the fixture owns: `node --test`
// runs one child per test file, so killing only the direct child would orphan
// its grandchildren. A run that hits the deadline is reported as `timedOut`,
// is never evidence, and has already been reclaimed when it resolves.
const CHILD_TEST_DEADLINE_MS = 60000;

function reclaimChildTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch { /* the tree is already gone */ }
}

function runNodeTests(cwd, files, { deadlineMs = CHILD_TEST_DEADLINE_MS } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', ...files], {
      cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { out += String(d); });
    let timedOut = false;
    let spawnError = null;
    const timer = setTimeout(() => {
      timedOut = true;
      reclaimChildTree(child.pid); // the OWNED tree, root still alive at this point
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, deadlineMs);
    child.on('error', (e) => { spawnError = e; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, out, pid: child.pid, timedOut, spawnError, deadlineMs });
    });
  });
}

function tapSummary(text) {
  const pick = (k) => {
    const m = new RegExp(`^# ${k} (\\d+)\\s*$`, 'm').exec(text);
    return m ? Number(m[1]) : null;
  };
  return { tests: pick('tests'), pass: pick('pass'), fail: pick('fail') };
}

// A correct plan either SELECTS the opaque consumer or falls back to FULL — a
// conservative FULL fallback is acceptable and must not be asserted away.
function assertOpaqueConsumerIsCovered(plan) {
  const covered = plan.mode === 'full' || plan.files.includes('tests/dynamic.test.mjs');
  assert.ok(covered,
    `the opaque dynamic consumer must be selected, or the plan must fall back to FULL (mode=${plan.mode} files=${JSON.stringify(plan.files)})`);
}

// Does this TAP output show the DYNAMIC consumer failing on its OWN assertion?
// Returns `null` when it does, or a human reason when it does NOT.
//
// A non-zero exit plus a `fail` count is NOT enough: a SyntaxError, an
// unresolved module or a runner-level failure exits non-zero with a `fail`
// count too (measured: they surface as `failureType: 'testCodeFailure'` with
// `code: 'ERR_TEST_FAILURE'` and a FILE-LEVEL `not ok` label). Evidence must be
// the dynamic consumer's own ERR_ASSERTION, so everything else is rejected.
function dynamicAssertionFailureRejection(out) {
  const failed = [...out.matchAll(/^not ok \d+ - (.+?)\r?$/gm)].map((m) => m[1].trim());
  if (failed.length !== 1) return `exactly ONE failing subtest is expected, got ${JSON.stringify(failed)}`;
  if (!/^\s+failureType: 'testCodeFailure'\r?$/m.test(out)) return 'this is not a test-code failure';
  if (/^\s+code: 'ERR_TEST_FAILURE'\r?$/m.test(out)) return 'a runner-level ERR_TEST_FAILURE, not an assertion';
  if (!/^\s+code: 'ERR_ASSERTION'\r?$/m.test(out)) return 'no ERR_ASSERTION — the dynamic assertion was never reached';
  if (!/^\s+name: 'AssertionError'\r?$/m.test(out)) return 'the reported error is not an AssertionError';
  for (const wrong of ['ERR_MODULE_NOT_FOUND', 'SyntaxError:']) {
    if (out.includes(wrong)) return `a ${wrong} is not an assertion`;
  }
  if (/(^|[\\/])[^\\/]+\.mjs$/.test(failed[0])) return `the failing entry is a FILE-LEVEL error, not a test (${failed[0]})`;
  // TAP renders the `location` value as a JS string literal, so Windows
  // separators arrive DOUBLED (`tests\\dynamic.test.mjs`) — normalise first.
  const loc = [...out.matchAll(/^\s+location: '(.+?)'\r?$/gm)].map((m) => m[1].replace(/\\\\/g, '\\'));
  if (!loc.some((l) => /tests[\\/]dynamic\.test\.mjs/.test(l))) {
    return `the failure is not inside the DYNAMIC consumer file (locations=${JSON.stringify(loc)})`;
  }
  if (!/^ok \d+ - static consumer\r?$/m.test(out)) return 'the always-present static consumer did not pass';
  return null;
}

function assertDynamicAssertionFailure(out, label) {
  const reason = dynamicAssertionFailureRejection(out);
  assert.equal(reason, null,
    `${label}: the failure must be the DYNAMIC consumer's own assertion — ${reason}\n${out.slice(-900)}`);
}

// A run is evidence ONLY when it finished inside its deadline, was spawned,
// exited non-zero, really executed, and failed on the dynamic assertion.
function assertRunFailedWithDynamicAssertion(run, label) {
  assert.equal(run.timedOut, false,
    `${label}: the child hit its ${run.deadlineMs}ms deadline — a hung run is NOT evidence\n${run.out.slice(-400)}`);
  assert.equal(run.spawnError, null,
    `${label}: the child could not be spawned (${run.spawnError && run.spawnError.message})`);
  assert.notEqual(run.code, 0,
    `${label}: must FAIL for real, not report a false green (exit ${run.code})\n${run.out.slice(-500)}`);
  const sum = tapSummary(run.out);
  assert.ok(sum.tests > 0 && sum.fail > 0,
    `${label}: must really execute and really fail, not silently no-op (summary=${JSON.stringify(sum)})`);
  assertDynamicAssertionFailure(run.out, label);
}

// The false-green proof: with n flipped 1 -> 2 the selected set and the full
// fixture set must BOTH fail for real, and both must fail on the DYNAMIC
// consumer's OWN assertion. A list-only assertion cannot show this.
async function assertReducedSelectionIsNotFalselyGreen(dir, plan) {
  const selected = plan.mode === 'full'
    ? ['tests/static.test.mjs', 'tests/dynamic.test.mjs', 'tests/plain.test.mjs']
    : plan.files;
  const sel = await runNodeTests(dir, selected);
  const full = await runNodeTests(dir, ['tests/static.test.mjs', 'tests/dynamic.test.mjs']);
  assertRunFailedWithDynamicAssertion(sel, 'selected set');
  assertRunFailedWithDynamicAssertion(full, 'full fixture set');
}

// Before the source change the SAME fixture must be genuinely GREEN. Without
// this control a fixture that was already broken (a syntax error, a missing
// module) would make "it fails after the change" prove nothing at all.
async function assertFixturePassesBeforeTheChange(dir) {
  const before = await runNodeTests(dir, ['tests/static.test.mjs', 'tests/dynamic.test.mjs']);
  assert.equal(before.timedOut, false, `the control run hit its deadline\n${before.out.slice(-400)}`);
  assert.equal(before.code, 0,
    `the fixture must be VALID and PASS before the change (exit ${before.code})\n${before.out.slice(-900)}`);
  const sum = tapSummary(before.out);
  assert.ok(sum.tests >= 2 && sum.fail === 0,
    `the control run must really execute BOTH consumers and pass (summary=${JSON.stringify(sum)})`);
}

test('rework4(R3-02): the detector reads the WHOLE argument — a literal prefix, a template interpolation or any unprovable argument is opaque', () => {
  assert.equal(hasOpaqueDynamicImport("await import('./x.mjs');\n"), false, 'a complete literal is not opaque');
  assert.equal(hasOpaqueDynamicImport("await import ( './x.mjs' ) ;\n"), false, 'spacing does not change a complete literal');
  assert.equal(hasOpaqueDynamicImport("await import('../x/' + name);\n"), true,
    'a literal PREFIX concatenated with an expression resolves no edge and MUST be opaque');
  assert.equal(hasOpaqueDynamicImport('const s = `${await import(t)}`;\n'), true,
    'an import inside a template interpolation is still a dynamic import');
  assert.equal(hasOpaqueDynamicImport('const s = `a${ `b${ await import(t) }` }`;\n'), true,
    'a NESTED template interpolation is still real code');
  assert.equal(hasOpaqueDynamicImport('const s = `${ { a: `${ await import(t) }` } }`;\n'), true,
    'nesting an object between interpolations must not hide the import');
  assert.equal(hasOpaqueDynamicImport('const s = `${ 1 + 1 }`;\n'), false,
    'an interpolation with no import is not opaque');
  assert.equal(hasOpaqueDynamicImport('await import(`./x.mjs`);\n'), true,
    'a template-literal argument is not resolvable by the literal extractor, so it is opaque (fail-closed)');
  assert.equal(hasOpaqueDynamicImport('await import(t);\n'), true, 'an identifier argument is opaque');
  assert.equal(hasOpaqueDynamicImport('await import(getSpec());\n'), true, 'a call argument is opaque');
  assert.equal(hasOpaqueDynamicImport('const u = import.meta.url;\n'), false, 'import.meta is not a dynamic import');
  assert.equal(hasOpaqueDynamicImport('// mentions import(x) in prose\nconst s = "and import(y) in a string";\n'), false,
    'prose that merely mentions import( is never opaque');
  assert.equal(hasOpaqueDynamicImport("import test from 'node:test';\n"), false, 'a static import is not a dynamic import');
});

test('rework4(R3-02): a CONCATENATED dynamic consumer is never dropped — the reduced selection FAILS like the full set', async () => {
  const { dir, base } = mkOpaqueConsumerRepo({ dynamicBody: OPQ_CONCAT_BODY });
  fs.writeFileSync(path.join(dir, 'packages', 'sample', 'value.mjs'), 'export const n = 2;\n');
  const p = planOf(dir, base);
  assertOpaqueConsumerIsCovered(p);
  if (p.mode === 'affected') {
    assert.equal(p.files.includes('tests/plain.test.mjs'), false, 'the union stays bounded (no unrelated test)');
  }
  await assertReducedSelectionIsNotFalselyGreen(dir, p);
});

test('rework4(R3-02): a dynamic consumer inside a TEMPLATE INTERPOLATION is never dropped', async () => {
  const { dir, base } = mkOpaqueConsumerRepo({ dynamicBody: OPQ_TEMPLATE_BODY });
  fs.writeFileSync(path.join(dir, 'packages', 'sample', 'value.mjs'), 'export const n = 2;\n');
  const p = planOf(dir, base);
  assertOpaqueConsumerIsCovered(p);
  await assertReducedSelectionIsNotFalselyGreen(dir, p);
});

test('rework4(R3-02): a dynamic consumer inside a NESTED interpolation is never dropped', async () => {
  const { dir, base } = mkOpaqueConsumerRepo({ dynamicBody: OPQ_NESTED_BODY });
  fs.writeFileSync(path.join(dir, 'packages', 'sample', 'value.mjs'), 'export const n = 2;\n');
  const p = planOf(dir, base);
  assertOpaqueConsumerIsCovered(p);
  await assertReducedSelectionIsNotFalselyGreen(dir, p);
});

// ---------------------------------------------------------------------------
// Round-5 rework (review R3-02 residual, round 2): THREE more false-negative
// paths, closed by ONE change — the opaque detector and the specifier extractor
// now consume the SAME lexer output, and that lexer gets lexical context right
// (a) when it enters a `${...}` EXPRESSION and (b) after a postfix `++`/`--`.
// Every group is proven with a REAL reduced-vs-full run: a list-only assertion
// cannot show a false green.
// ---------------------------------------------------------------------------
const R302B_REGEX_CLOSE_BODY = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "const target = '../packages/sample/value.mjs';",
  "test('opaque consumer after a regex that starts an interpolation', async () => {",
  "  const s = `${ /}/.test('}') ? (await import(target)).n : 0 }`;",
  "  assert.equal(Number(s), 1);",
  "});",
  '',
].join('\n');
const R302B_REGEX_CLASS_BODY = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "const target = '../packages/sample/value.mjs';",
  "test('opaque consumer after a regex CLASS that starts an interpolation', async () => {",
  "  const s = `${ /[}]/.test('}') ? (await import(target)).n : 0 }`;",
  "  assert.equal(Number(s), 1);",
  "});",
  '',
].join('\n');
const R302B_NESTED_REGEX_BODY = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "const target = '../packages/sample/value.mjs';",
  "test('nested interpolation whose inner regex contains a brace', async () => {",
  "  const s = `${ `x${ /[}]+/.test('}}') ? 1 : 0 }` }${ (await import(target)).n }`;",
  "  assert.equal(s, 'x11');",
  "});",
  '',
].join('\n');
const R302B_POSTFIX_BODY = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "const target = '../packages/sample/value.mjs';",
  "test('postfix increment followed by division must not swallow the next line', async () => {",
  "  let n = 0;",
  "  n++ / 2;",
  "  assert.equal((await import(target)).n, 1);",
  "});",
  '',
].join('\n');
const R302B_COMMENT_BEFORE_BODY = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "test('comment before the literal argument', async () => {",
  "  assert.equal((await import(/* keep */ '../packages/sample/value.mjs')).n, 1);",
  "});",
  '',
].join('\n');
const R302B_COMMENT_AFTER_BODY = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "test('comment after the literal argument', async () => {",
  "  assert.equal((await import('../packages/sample/value.mjs' /* keep */)).n, 1);",
  "});",
  '',
].join('\n');
const R302B_ESCAPED_BODY = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "test('escaped literal resolves to the REAL module', async () => {",
  "  assert.equal((await import('../packages/sample/val\\u0075e.mjs')).n, 1);",
  "});",
  '',
].join('\n');

test('rework5(R3-02): a regex at the START of a `${...}` expression cannot hide a dynamic import', () => {
  assert.equal(
    hasOpaqueDynamicImport("const s = `${ /}/.test('}') ? (await import(target)).n : 0 }`;\n"),
    true,
    'the `}` INSIDE the regex /}/ must not close the interpolation early and blank the real import');
  assert.equal(
    hasOpaqueDynamicImport("const s = `${ /[}]/.test('}') ? (await import(target)).n : 0 }`;\n"),
    true,
    'a regex CHARACTER CLASS containing `}` is equally opaque');
  assert.equal(
    hasOpaqueDynamicImport("const s = `${ `x${ /[}]+/.test('}}') ? 1 : 0 }` }${ await import(target) }`;\n"),
    true,
    'a brace inside the regex of a NESTED interpolation must not blank the outer import');
  // controls: a regex IS code, but its BODY is prose and must stay blanked
  assert.equal(hasOpaqueDynamicImport("const r = /}/;\n"), false, 'a lone regex is not a dynamic import');
  assert.equal(hasOpaqueDynamicImport("const r = /import\\(x\\)/;\n"), false,
    'a regex that MENTIONS import( is not a call site — its body is blanked like any literal');
  assert.equal(hasOpaqueDynamicImport('const s = `${ 1 + 1 }`;\n'), false, 'an interpolation with no import is not opaque');
  assert.equal(hasOpaqueDynamicImport("const s = `${ 'a${b}' }`;\n"), false,
    'an interpolation that only contains a STRING mentioning ${...} is not opaque');
});

test('rework5(R3-02): a postfix `++`/`--` is a DIVISION context, not a regex that blanks the next statement', () => {
  assert.equal(
    hasOpaqueDynamicImport("let n = 0;\nn++ / 2;\nawait import(target);\n"),
    true,
    '`n++ / 2` must lex the `/` as DIVISION so the import on the NEXT line stays visible');
  assert.equal(
    hasOpaqueDynamicImport("let n = 2;\nn-- / 2;\nawait import('./x.mjs');\n"),
    false,
    'the same for `--`; a LITERAL import stays non-opaque');
  // control: a plain division never hides an import either
  assert.equal(hasOpaqueDynamicImport("const a = 4;\nconst b = a / 2;\nawait import(target);\n"), true);
  // control: a binary/unary `+` still OPENS an expression, where `/` IS a regex
  assert.equal(hasOpaqueDynamicImport('const a = 4;\nconst r = a + /}/;\n'), false);
});

test('rework5(R3-02): a comment inside the import argument is resolved by detector AND extractor together', () => {
  // The extractor must emit the specifier EXACTLY when the detector says the
  // call site is resolvable: `opaque === false` with NO edge was the false green.
  const before = "await import(/* keep */ '../packages/value.mjs');\n";
  const after = "await import('../packages/value.mjs' /* keep */);\n";
  const multiline = "await import(\n  /* keep\n     going */\n  '../packages/value.mjs'\n);\n";
  for (const src of [before, after, multiline]) {
    assert.equal(hasOpaqueDynamicImport(src), false, `a commented literal is resolvable: ${JSON.stringify(src)}`);
    assert.deepEqual(parseImportSpecs(src), ['../packages/value.mjs'],
      `the extractor must emit the SAME specifier the detector certified: ${JSON.stringify(src)}`);
  }
});

test('rework5(R3-02): an ESCAPED literal resolves to the REAL module, and an undecodable escape is opaque', () => {
  const escaped = "await import('../packages/val\\u0075e.mjs');\n";
  assert.equal(hasOpaqueDynamicImport(escaped), false, 'a decodable escape is still a resolvable literal');
  assert.deepEqual(parseImportSpecs(escaped), ['../packages/value.mjs'],
    'the edge must point at the module JS really loads, not the raw-escape phantom path');
  // A malformed escape cannot be PROVEN -> OPAQUE (fail-closed), never a wrong edge.
  const bad = "await import('../packages/value\\u00zz.mjs');\n";
  assert.equal(hasOpaqueDynamicImport(bad), true, 'an undecodable escape is opaque');
  assert.deepEqual(parseImportSpecs(bad), [], 'an undecodable literal contributes NO edge');
});

test('rework5(R3-02): detector and extractor agree — `!opaque` on a dynamic import always yields an edge', () => {
  // The invariant the finding is about: a call site may only be read as
  // "resolvable" when the extractor ACTUALLY produces the dependency; otherwise
  // the plan silently drops the consumer. Non-opaque dynamic imports in these
  // samples are all backed by a real specifier edge.
  const samples = [
    "await import('./x.mjs');\n",
    "await import(/* c */ './x.mjs');\n",
    "await import('./x.mjs' /* c */);\n",
    "await import('../packages/val\\u0075e.mjs');\n",
  ];
  for (const src of samples) {
    assert.equal(hasOpaqueDynamicImport(src), false, `resolvable: ${JSON.stringify(src)}`);
    assert.ok(parseImportSpecs(src).length >= 1,
      `a non-opaque dynamic import MUST produce an edge, else it is a false green: ${JSON.stringify(src)}`);
  }
  // ...and the opaque ones prove the detector does not "resolve" them by accident.
  for (const src of [
    "const s = `${ /}/.test('}') ? (await import(t)).n : 0 }`;\n",
    "let n=0;\nn++ / 2;\nawait import(t);\n",
    "await import('../x/' + name);\n",
    'await import(`./x.mjs`);\n',
  ]) {
    assert.equal(hasOpaqueDynamicImport(src), true, `opaque: ${JSON.stringify(src)}`);
  }
});

test('rework5(R3-02): a regex-`}` interpolation consumer is never dropped — reduced selection FAILS like full', async () => {
  const { dir, base } = mkOpaqueConsumerRepo({ dynamicBody: R302B_REGEX_CLOSE_BODY });
  fs.writeFileSync(path.join(dir, 'packages', 'sample', 'value.mjs'), 'export const n = 2;\n');
  const p = planOf(dir, base);
  assertOpaqueConsumerIsCovered(p);
  await assertReducedSelectionIsNotFalselyGreen(dir, p);
});

test('rework5(R3-02): a regex-class interpolation consumer is never dropped — reduced selection FAILS like full', async () => {
  const { dir, base } = mkOpaqueConsumerRepo({ dynamicBody: R302B_REGEX_CLASS_BODY });
  fs.writeFileSync(path.join(dir, 'packages', 'sample', 'value.mjs'), 'export const n = 2;\n');
  const p = planOf(dir, base);
  assertOpaqueConsumerIsCovered(p);
  await assertReducedSelectionIsNotFalselyGreen(dir, p);
});

test('rework5(R3-02): a NESTED-regex interpolation consumer is never dropped — reduced selection FAILS like full', async () => {
  const { dir, base } = mkOpaqueConsumerRepo({ dynamicBody: R302B_NESTED_REGEX_BODY });
  fs.writeFileSync(path.join(dir, 'packages', 'sample', 'value.mjs'), 'export const n = 2;\n');
  const p = planOf(dir, base);
  assertOpaqueConsumerIsCovered(p);
  await assertReducedSelectionIsNotFalselyGreen(dir, p);
});

test('rework5(R3-02): a postfix-division consumer is never dropped — reduced selection FAILS like full', async () => {
  const { dir, base } = mkOpaqueConsumerRepo({ dynamicBody: R302B_POSTFIX_BODY });
  fs.writeFileSync(path.join(dir, 'packages', 'sample', 'value.mjs'), 'export const n = 2;\n');
  const p = planOf(dir, base);
  assertOpaqueConsumerIsCovered(p);
  assert.equal(p.mode, 'affected');
  assert.match(p.reasons['tests/dynamic.test.mjs'], /^opaque-importer:/,
    'the consumer is kept because the file is a proven opaque importer');
  await assertReducedSelectionIsNotFalselyGreen(dir, p);
});

test('rework5(R3-02): a comment-before-argument consumer is selected by a REAL edge — reduced selection FAILS like full', async () => {
  const { dir, base } = mkOpaqueConsumerRepo({ dynamicBody: R302B_COMMENT_BEFORE_BODY });
  fs.writeFileSync(path.join(dir, 'packages', 'sample', 'value.mjs'), 'export const n = 2;\n');
  const p = planOf(dir, base);
  assert.equal(p.mode, 'affected');
  assert.ok(p.files.includes('tests/dynamic.test.mjs'), 'the resolved edge selects the dynamic consumer');
  assert.match(p.reasons['tests/dynamic.test.mjs'], /^dependency:/,
    'the call site is RESOLVED (comment before the literal), not merely opaque');
  await assertReducedSelectionIsNotFalselyGreen(dir, p);
});

test('rework5(R3-02): a comment-after-argument consumer is selected by a REAL edge — reduced selection FAILS like full', async () => {
  const { dir, base } = mkOpaqueConsumerRepo({ dynamicBody: R302B_COMMENT_AFTER_BODY });
  fs.writeFileSync(path.join(dir, 'packages', 'sample', 'value.mjs'), 'export const n = 2;\n');
  const p = planOf(dir, base);
  assert.equal(p.mode, 'affected');
  assert.ok(p.files.includes('tests/dynamic.test.mjs'), 'the resolved edge selects the dynamic consumer');
  assert.match(p.reasons['tests/dynamic.test.mjs'], /^dependency:/,
    'the call site is RESOLVED (comment after the literal), not merely opaque');
  await assertReducedSelectionIsNotFalselyGreen(dir, p);
});

test('rework5(R3-02): an ESCAPED-literal consumer is selected by a REAL edge — reduced selection FAILS like full', async () => {
  const { dir, base } = mkOpaqueConsumerRepo({ dynamicBody: R302B_ESCAPED_BODY });
  fs.writeFileSync(path.join(dir, 'packages', 'sample', 'value.mjs'), 'export const n = 2;\n');
  const p = planOf(dir, base);
  assert.equal(p.mode, 'affected');
  assert.ok(p.files.includes('tests/dynamic.test.mjs'), 'the DECODED edge selects the dynamic consumer');
  assert.match(p.reasons['tests/dynamic.test.mjs'], /^dependency:/,
    'the escaped specifier resolves to the real module, not a phantom path');
  await assertReducedSelectionIsNotFalselyGreen(dir, p);
});

test('rework5(R3-02): the code view keeps static/dynamic/require semantics and prose stays blanked', () => {
  const view = stripCommentsAndStrings(
    "// import('x')\nconst s = \"import('y')\";\nconst r = /import\\('z'\\)/;\nimport a from './a.mjs';\nawait import('./b.mjs');\nconst c = require('./c.cjs');\n");
  assert.equal(view.includes("import('x')"), false, 'a line comment is blanked');
  assert.equal(view.includes("import('y')"), false, 'a string literal body is blanked');
  assert.equal(view.includes("import('z')"), false, 'a regex body is blanked');
  assert.ok(view.includes("import('"), 'a REAL dynamic import call site keeps its opener');
  assert.equal(view.includes('./a.mjs'), false, 'a static specifier body is blanked (quotes kept)');
  assert.deepEqual(
    parseImportSpecs("import a from './a.mjs';\nexport * from './b.mjs';\nawait import('./c.mjs');\nconst d = require('./d.cjs');\n"),
    ['./a.mjs', './b.mjs', './c.mjs', './d.cjs'],
    'static from, re-export, literal dynamic and require all still resolve');
});


test('rework4(R3-02): the round-3 VARIABLE consumer is still covered and still not falsely green', async () => {
  const { dir, base } = mkOpaqueConsumerRepo();
  await assertFixturePassesBeforeTheChange(dir);
  fs.writeFileSync(path.join(dir, 'packages', 'sample', 'value.mjs'), 'export const n = 2;\n');
  const p = planOf(dir, base);
  assert.equal(p.mode, 'affected');
  assert.ok(p.files.includes('tests/dynamic.test.mjs'), 'the variable-form opaque consumer is selected');
  await assertReducedSelectionIsNotFalselyGreen(dir, p);
});

// ---------------------------------------------------------------------------
// Round-6 rework (review R3-02 residual, round 3). The previous lexer decided
// regex-vs-division from a whitespace-STRIPPED character tail, which cost it
// two lexical facts:
//   * `+ +` (two unary operators) was glued into the postfix `++` token, so
//     `/` after it was read as DIVISION and the `}` INSIDE the regex closed the
//     interpolation early — blanking the real import after it;
//   * a `}` that closes an OBJECT literal (`const n = {} / 2`) was treated as a
//     regex context, so the following `/` swallowed the rest of the line.
// Both certified "no dynamic import" and produced a FALSE GREEN (selected set
// exit 0, full fixture exit 1). The context is now the previous TOKEN's kind,
// and a context that cannot be PROVEN makes the file OPAQUE instead of blanked.
// ---------------------------------------------------------------------------
const R6_UNARY_PLUS_BODY = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "const target = '../packages/sample/value.mjs';",
  "test('opaque consumer after two unary operators and a brace-regex', async () => {",
  "  const s = `${ + + /}/, (await import(target)).n }`;",
  "  assert.equal(Number(s), 1);",
  "});",
  '',
].join('\n');
const R6_OBJECT_DIV_BODY = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "const target = '../packages/sample/value.mjs';",
  "test('opaque consumer after an object expression divided by a number', async () => {",
  "  const n = {} / 2;",
  "  assert.equal((await import(target)).n, 1);",
  "});",
  '',
].join('\n');

test('rework6(R3-02): regex-vs-division follows the previous TOKEN, never glued characters', () => {
  const opaque = (src, why) => assert.equal(hasOpaqueDynamicImport(src), true, `${why}: ${JSON.stringify(src)}`);
  const notOpaque = (src, why) => assert.equal(hasOpaqueDynamicImport(src), false, `${why}: ${JSON.stringify(src)}`);

  // (1) two unary operators are NOT the `++` token -> `/` OPENS a regex, so the
  //     `}` inside it must not close the interpolation and blank the import.
  opaque("const s = `${ + + /}/, (await import(target)).n }`;\n",
    'unary + + then a brace-regex must not hide the import');
  opaque("const s = `${ - - /}/, (await import(target)).n }`;\n",
    'unary - - then a brace-regex must not hide the import');
  opaque("const n = 1;\nn + + /}/;\nawait import(target);\n",
    'the same pair OUTSIDE a template');
  // (2) a `}` that closes an OBJECT literal leaves an expression behind, so the
  //     `/` is DIVISION and everything after it stays visible.
  opaque("const n = {} / 2;\nawait import(target);\n",
    'an object literal divided by a number must not blank the next statement');
  opaque("f({} / 2);\nawait import(target);\n",
    'the same object division as a call argument');
  opaque("test('x', async () => { const n = {} / 2; await import(target); });\n",
    'an object division inside an arrow BLOCK body');
  opaque("const s = `${ { a: 1 } / 2 ? (await import(target)).n : 0 }`;\n",
    'an object division inside an interpolation');
  // (3) the discriminating pair for the SAME characters: ADJACENT `++` ends an
  //     expression (division) while a SPACED `+ +` opens a fresh one (regex).
  opaque("let n = 0;\nn++ / 2;\nawait import(target);\n",
    'an ADJACENT postfix ++ is a division context');
  notOpaque("let n = 0;\nn++ / 2;\n", 'a postfix ++ with no import after it is not opaque');
  notOpaque('const a = 4;\nconst r = a + /}/;\n', 'a binary + still OPENS an expression (regex is not a call site)');
  // (4) block-`}` and object-`}` must BOTH stay visible
  opaque("function f() {}\nconst r = /a}/;\nawait import(target);\n",
    'a `}` that closes a BLOCK does not swallow the following statements');
  // controls: genuinely-import-free code must NOT be blanket-marked opaque
  notOpaque("const n = {} / 2;\n", 'an object division with no import is not opaque');
  notOpaque("const s = `${ 1 + 1 }${ 2 / 2 }`;\n", 'interpolations with no import are not opaque');
  notOpaque("const r = /}/;\n", 'a lone regex is not a dynamic import');
  notOpaque("const s = `${ /}/.test('}') ? 1 : 0 }`;\n", 'a brace-regex with no import is not opaque');
});

test('rework6(R3-02): a `+ +` brace-regex consumer is never dropped — reduced selection FAILS like full', async () => {
  const { dir, base } = mkOpaqueConsumerRepo({ dynamicBody: R6_UNARY_PLUS_BODY });
  await assertFixturePassesBeforeTheChange(dir); // the fixture is VALID and GREEN before the change
  fs.writeFileSync(path.join(dir, 'packages', 'sample', 'value.mjs'), 'export const n = 2;\n');
  const p = planOf(dir, base);
  assertOpaqueConsumerIsCovered(p);
  assert.equal(p.mode, 'affected', 'the plan stays bounded, it does not degenerate to FULL');
  await assertReducedSelectionIsNotFalselyGreen(dir, p);
});

test('rework6(R3-02): an object-division consumer is never dropped — reduced selection FAILS like full', async () => {
  const { dir, base } = mkOpaqueConsumerRepo({ dynamicBody: R6_OBJECT_DIV_BODY });
  await assertFixturePassesBeforeTheChange(dir);
  fs.writeFileSync(path.join(dir, 'packages', 'sample', 'value.mjs'), 'export const n = 2;\n');
  const p = planOf(dir, base);
  assertOpaqueConsumerIsCovered(p);
  assert.equal(p.mode, 'affected');
  await assertReducedSelectionIsNotFalselyGreen(dir, p);
});

test('rework6(R3-02): the real repo does not degenerate — the opaque set stays bounded and explained', () => {
  const g = buildImportGraph(REPO_ROOT);
  // The measured set is unchanged by this round (3 files). The assertion is a
  // BOUND, not a frozen count: a wider set would have to be explained by source.
  // Whatever its size, every member must be a REAL opaque importer.
  assert.ok(g.opaque.has('packages/client-mcp/route-worker.mjs'),
    'the real non-literal dynamic importer is still detected');
  assert.equal(g.opaque.has('packages/runtime-sandbox/runtime-sandbox.mjs'), false,
    'a file whose only "import (" is a comment/prose is still NOT an opaque importer');
  assert.ok(g.opaque.size <= 5,
    `the opaque set must stay bounded, not blanket every file (got ${g.opaque.size}: ${JSON.stringify([...g.opaque].sort())})`);
  const lm = loadManifestForRoot(REPO_ROOT);
  const sel = selectAffectedTests({ manifest: lm, graph: g, changed: ['packages/runtime-sandbox/activity-lease.mjs'] });
  assert.equal(sel.fallback, false,
    `a normal source change must not fall back to FULL because of an opaque importer: ${JSON.stringify(sel.fullReasons)}`);
});

// The regression helper is part of the evidence chain, so it gets its own
// controls: a hung child, a module-load failure and a syntax error must ALL be
// rejected — none of them may be mistaken for the dynamic consumer's assertion.
const R6_HANGING_BODY = [
  "import test from 'node:test';",
  "test('a fixture that never finishes', async () => { await new Promise((r) => setTimeout(r, 30000)); });",
  '',
].join('\n');
const R6_MISSING_MODULE_BODY = [
  "import test from 'node:test';",
  "import '../packages/sample/does-not-exist.mjs';",
  "const target = '../packages/sample/value.mjs';",
  "test('never reached', async () => { await import(target); });",
  '',
].join('\n');
const R6_SYNTAX_ERROR_BODY = [
  "import test from 'node:test';",
  "const = broken;",
  '',
].join('\n');

function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('rework6(R3-02): a child that hits the deadline is classified AND rejected as evidence (and reclaimed)', async () => {
  const { dir } = mkOpaqueConsumerRepo({ dynamicBody: R6_HANGING_BODY });
  const run = await runNodeTests(dir, ['tests/dynamic.test.mjs'], { deadlineMs: 1500 });
  assert.equal(run.timedOut, true, 'the finite deadline really fired');
  assert.equal(processIsAlive(run.pid), false, 'the deadline reclaimed the child it owned');
  assert.throws(() => assertRunFailedWithDynamicAssertion(run, 'deadline-probe'), /deadline/,
    'a hung run must never be accepted as assertion evidence');
});

test('rework6(R3-02): a module-load failure is rejected — it is not the dynamic consumer\'s assertion', async () => {
  const { dir } = mkOpaqueConsumerRepo({ dynamicBody: R6_MISSING_MODULE_BODY });
  const run = await runNodeTests(dir, ['tests/static.test.mjs', 'tests/dynamic.test.mjs']);
  assert.equal(run.timedOut, false, 'the child finished on its own');
  assert.notEqual(run.code, 0, 'a module-load failure does exit non-zero...');
  assert.notEqual(dynamicAssertionFailureRejection(run.out), null,
    '...but the helper must still reject it');
  assert.throws(() => assertRunFailedWithDynamicAssertion(run, 'module-load-probe'), /assertion|assertion|NOT evidence|ERR_ASSERTION/i);
});

test('rework6(R3-02): a syntax error is rejected — it is not the dynamic consumer\'s assertion', async () => {
  const { dir } = mkOpaqueConsumerRepo({ dynamicBody: R6_SYNTAX_ERROR_BODY });
  const run = await runNodeTests(dir, ['tests/static.test.mjs', 'tests/dynamic.test.mjs']);
  assert.equal(run.timedOut, false);
  assert.notEqual(run.code, 0);
  assert.notEqual(dynamicAssertionFailureRejection(run.out), null,
    'a syntax error must never be counted as a failing dynamic assertion');
  assert.throws(() => assertRunFailedWithDynamicAssertion(run, 'syntax-probe'), /assertion|NOT evidence|ERR_ASSERTION/i);
});
