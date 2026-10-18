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
  TMP_FIXTURES.add(dir); // registered like every other fixture repo: the
  // single `after()` hook reclaims it — this creator leaked ~36 temp trees
  // per full run before (PR285 R3-02 round 7 hygiene), never a disk hoard.
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
//
// (PR285-R3-02 round 8) The metadata checks bind to THE FAILING RECORD's own
// metadata block — never to the whole output. Measured on 240f7d7: every other
// consumer's failure also carries `failureType`/`code`/`name` lines, a passing
// or failing record can mention `location: '...\\tests\\dynamic.test.mjs:1:1'`
// inside its rendered error MESSAGE, and helper checks that scan the WHOLE TAP
// output accepted such a non-dynamic failure as dynamic-assertion evidence.
// Record metadata lines are EXACTLY two-space indented; anything deeper (the
// `error: |-` message body, a stack frame) is content and can never satisfy a
// metadata check.
function tapFailingRecords(out) {
  // Column-0 `not ok` records only — the same records the `failed` regex saw.
  const lines = out.split(/\r?\n/);
  const records = [];
  for (let idx = 0; idx < lines.length; idx += 1) {
    const m = /^not ok \d+ - (.+?)\s*$/.exec(lines[idx]);
    if (!m) continue;
    const raw = [];
    for (let k = idx + 1; k < lines.length; k += 1) {
      // The block ends at the next column-0 record/heading line.
      if (/^(ok |not ok |TAP |1\.\.|# )/.test(lines[k])) break;
      raw.push(lines[k]);
    }
    records.push({ label: m[1].trim(), raw });
  }
  return records;
}

const FAILURE_META_RE = {
  failureType: /^  failureType: '(.*)'\s*$/,
  code: /^  code: '(.*)'\s*$/,
  name: /^  name: '(.*)'\s*$/,
  location: /^  location: '(.*)'\s*$/,
};

function failureRecordMeta(raw, field) {
  for (const line of raw) {
    const m = FAILURE_META_RE[field].exec(line);
    if (m) return m[1].replace(/''/g, "'");
  }
  return null;
}

function dynamicAssertionFailureRejection(out) {
  const failed = [...out.matchAll(/^not ok \d+ - (.+?)\r?$/gm)].map((m) => m[1].trim());
  if (failed.length !== 1) return `exactly ONE failing subtest is expected, got ${JSON.stringify(failed)}`;
  if (/(^|[\\/])[^\\/]+\.mjs$/.test(failed[0])) return `the failing entry is a FILE-LEVEL error, not a test (${failed[0]})`;
  const [record] = tapFailingRecords(out);
  if (!record) return 'the failing record has no own TAP metadata block';
  // All four facts must come from THE FAILING RECORD's own metadata block.
  const failureType = failureRecordMeta(record.raw, 'failureType');
  if (failureType === null) return "the failing record does not carry its own 'failureType' metadata";
  if (failureType !== 'testCodeFailure') return `this is not a test-code failure (own failureType=${JSON.stringify(failureType)})`;
  const code = failureRecordMeta(record.raw, 'code');
  if (code === 'ERR_TEST_FAILURE') return 'a runner-level ERR_TEST_FAILURE, not an assertion';
  if (code !== 'ERR_ASSERTION') return `no ERR_ASSERTION — the dynamic assertion was never reached (own code=${JSON.stringify(code)})`;
  const name = failureRecordMeta(record.raw, 'name');
  if (name !== 'AssertionError') return `the reported error is not an AssertionError (own name=${JSON.stringify(name)})`;
  for (const wrong of ['ERR_MODULE_NOT_FOUND', 'SyntaxError:']) {
    if (out.includes(wrong)) return `a ${wrong} is not an assertion`;
  }
  // The location is the failing record's OWN metadata — TAP renders it as a
  // JS string literal, so Windows separators arrive DOUBLED — normalise first.
  // End-anchored so a neighbouring file whose name merely CONTAINS the
  // dynamic file's name (`dynamic.test.mjs.copy.mjs`) cannot qualify.
  const location = failureRecordMeta(record.raw, 'location');
  if (location === null) return 'the failing record does not carry its own location metadata';
  const normalised = location.replace(/\\\\/g, '\\');
  if (!/(?:^|[\\/])tests[\\/]dynamic\.test\.mjs(?::\d+:\d+)?$/.test(normalised)) {
    return `the failure is not inside the DYNAMIC consumer file (own location=${JSON.stringify(normalised)})`;
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

// ---------------------------------------------------------------------------
// Round-7 rework (review R3-02 residual — MEMBER ACCESS). A reserved word used
// as a PROPERTY NAME (`o.default / 2`) was still classified by classifyWord()
// as an expression-opening keyword, so the `/` after it opened a REGEX that
// blanked the rest of the file and hid the real `await import(...)`. Measured
// on the round-6 candidate 70f09d5 (probe r7): 6/6 member-access triggers were
// false-green (opaque=false -> plan drops the dynamic consumer -> selected
// exit 0, full exit 1). The context is now the `.` of the member access
// itself: an identifier after `.` (including optional `?.`, comments and
// whitespace between them, and the private-name `#`) is a PROPERTY NAME — an
// operand, never a keyword — while a keyword in its own keyword position keeps
// classifyWord. No per-word whitelist.
// ---------------------------------------------------------------------------
test('rework7(R3-02): a reserved-word PROPERTY is an operand — the trailing division never blanks the import', () => {
  // ONLY these fail on the pre-fix module: the reserved property opened a
  // phantom regex that swallowed the literal `await import('./x.mjs')` behind
  // it (opaque=false AND no edge -> a false green).
  const reserved = [
    'const o = { default: 2 };\no.default / 2;\nawait import(\'./x.mjs\');\n',
    'const obj = { return: 4 };\nobj.return / 2;\nawait import(\'./x.mjs\');\n',
    'const obj = { static: 6 };\nobj.static / 2;\nawait import(\'./x.mjs\');\n',
    'const o = { case: 1 };\no.case / 2;\nawait import(\'./x.mjs\');\n',
    'const o = { default: 2 };\no?.default / 2;\nawait import(\'./x.mjs\');\n',
    'const o = { default: 2 };\no ?. return / 2;\nawait import(\'./x.mjs\');\n',
    'const o = { default: 2 };\no./* keep */default / 2;\nawait import(\'./x.mjs\');\n',
    'const h = { import: 3 };\nh.import / 2;\nawait import(\'./x.mjs\');\n',
    'const o = { default: 2, holding: { import: 3 } };\no.holding.import / 2;\nawait import(\'./x.mjs\');\n',
    'const o = { instanceof: 8 };\no.instanceof / 2;\nawait import(\'./x.mjs\');\n',
  ];
  for (const src of reserved) {
    assert.equal(hasOpaqueDynamicImport(src), false,
      `a member-division call site with a COMPLETE literal is resolvable: ${JSON.stringify(src)}`);
    assert.deepEqual(parseImportSpecs(src), ['./x.mjs'],
      `detector and extractor agree: the edge MUST exist when the detector says not-opaque: ${JSON.stringify(src)}`);
  }
  // If any of these could legitimately still be OPAQUE, the detector may say
  // so — but then it must NOT have had to blank a real import; check a few of
  // the same forms with an identifier argument stay OPAQUE via fail-closed.
  assert.equal(hasOpaqueDynamicImport('const o = { default: 2 };\no.default / 2;\nawait import(t);\n'), true,
    'an identifier argument is opaque (the import itself stays visible, not blanked)');
});

test('rework7(R3-02): the CODE VIEW keeps a member-division expression and everything after it', () => {
  const view = stripCommentsAndStrings('const o = { default: 2 };\no.default / 2;\nawait import(t);\n');
  assert.ok(view.includes('/ 2;'), `the division after a reserved property stays CODE: ${JSON.stringify(view)}`);
  assert.ok(view.includes('await import(t)'), `the dynamic import stays visible: ${JSON.stringify(view)}`);
  // optional chain, comment-between, and the private-name `#` forms:
  const opt = stripCommentsAndStrings('const o = { default: 2 };\no?.default / 2;\nawait import(t);\n');
  assert.ok(opt.includes('/ 2;') && opt.includes('await import(t)'), JSON.stringify(opt));
  const cmt = stripCommentsAndStrings('const o = { default: 2 };\no./* keep */default / 2;\nawait import(t);\n');
  assert.ok(cmt.includes('/ 2;') && cmt.includes('await import(t)'), JSON.stringify(cmt));
  const priv = stripCommentsAndStrings('class C { #default = 2; f() { return this.#default / 2; } };\nawait import(t);\n');
  assert.ok(priv.includes('this.#default / 2'), JSON.stringify(priv));
  assert.equal(hasOpaqueDynamicImport('class C { #default = 2; f() { return this.#default / 2; } };\nawait import(t);\n'), true,
    'a private-name member division keeps the import visible too');
});

test('rework7(R3-02): a KEYWORD not after a dot keeps its statement behavior — the fix is contextual, not a whitelist', () => {
  // `return` in a statement position STILL opens an expression: `/re/` is a
  // regex and its body is blanked (delimiters kept) — exactly as before.
  const kw = 'function f(x) { return /re/.test(x); }\nawait import(t);\n';
  const view = stripCommentsAndStrings(kw);
  assert.equal(view.includes('/re'), false, `a regex after a real KEYWORD stays blanked: ${JSON.stringify(view)}`);
  assert.ok(view.includes('.test(x)'), `the code after the regex stays visible: ${JSON.stringify(view)}`);
  assert.equal(hasOpaqueDynamicImport(kw), true);
  // object-literal property NAMES are unchanged outside member access:
  assert.equal(hasOpaqueDynamicImport('const r = { return: /ok/ };\nawait import(t);\n'), true,
    'a regex VALUE inside an object literal is not a call site, the import stays visible');
  assert.equal(hasOpaqueDynamicImport('switch (x) { case 1: y = x / 2; break; default: await import(t); }\n'), true,
    'a `default:` LABEL case keeps its keyword behavior and does not hide the import');
});

const R7_MEMBER_DEFAULT_BODY = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "const target = '../packages/sample/value.mjs';",
  "test('opaque consumer after a reserved-word property division', async () => {",
  '  const o = { default: 2 };',
  '  o.default / 2;',
  '  assert.equal((await import(target)).n, 1);',
  '});',
  '',
].join('\n');

test('rework7(R3-02): a reserved-word property-division consumer is never dropped — reduced selection FAILS like full', async () => {
  const { dir, base } = mkOpaqueConsumerRepo({ dynamicBody: R7_MEMBER_DEFAULT_BODY });
  await assertFixturePassesBeforeTheChange(dir); // the fixture is VALID and GREEN before the change
  fs.writeFileSync(path.join(dir, 'packages', 'sample', 'value.mjs'), 'export const n = 2;\n');
  const p = planOf(dir, base);
  assertOpaqueConsumerIsCovered(p);
  assert.equal(p.mode, 'affected', 'the plan stays bounded, it does not degenerate to FULL');
  assert.ok(p.files.includes('tests/static.test.mjs'), 'the static consumer is selected by its literal edge');
  assert.ok(p.files.includes('tests/dynamic.test.mjs'),
    'the pre-fix planner certified files=["tests/static.test.mjs"] ONLY — the dropped dynamic consumer was a false green');
  assert.match(p.reasons['tests/dynamic.test.mjs'], /^opaque-importer:/,
    'the consumer is kept because the file is a proven opaque importer');
  await assertReducedSelectionIsNotFalselyGreen(dir, p);
});

// ==== PR-285 ROUND-8 REWORK8 SECTION (extract-from-here for falsification) ====
// ---------------------------------------------------------------------------
// Round-8 rework — TWO residuals of the same review in one scoped round:
//
// FINDING 1 (R3-02 HIGH) — FUNCTION-EXPRESSION DIVISION. The `}` closing a
// function-EXPRESSION body was classified like a plain BLOCK (statement
// continues), so `const n = function () {} / 2` opened a phantom regex that
// blanked the real `await import(...)` behind it (probe r8 on 240f7d7: 5/6
// expression triggers false-green). The fix (test-plan.mjs) follows the
// `function` keyword with a pending ARM (shape: keyword, optional generator
// `*`, optional NAME, counted `(...)` params, then the body `{`) and gives the
// body's closing `}` the kind PROVEN from the token BEFORE the keyword: an
// expression leaves an operand behind (division), a declaration leaves a
// statement start (regex legal), and an unprovable context (`export default
// function`) fails CLOSED — the first `/` after the body makes the file
// OPAQUE instead of blanking anything.
//
// FINDING 2 (MEDIUM) — the failure-evidence helper `dynamicAssertionFailureRejection`
// scanned the WHOLE TAP output, so a DIFFERENT consumer's failure was accepted
// as the dynamic consumer's own assertion as soon as its rendered error message
// (or a neighbouring file name) carried a `tests/dynamic.test.mjs` location
// line (reviewer-measured on 240f7d7 with REAL TAP). The helper now binds all
// four facts (`failureType`, `code`, `name`, `location`) to THE FAILING
// RECORD's own metadata block, which node:test renders at exactly two-space
// indentation — message body / stack frames are content (4+ spaces) and can
// never satisfy a metadata check.
// ---------------------------------------------------------------------------
const R8_EXPR_DIV_SOURCES = [
  ['anonymous', "const n = function () {} / 2;\nawait import('./x.mjs');\n"],
  ['named', "const n = function go () {} / 2;\nawait import('./x.mjs');\n"],
  ['async', "const n = async function () {} / 2;\nawait import('./x.mjs');\n"],
  ['async-named', "const q = async function zed () {} / 2;\nawait import('./x.mjs');\n"],
  ['async-composite-comment', "const q = async /* sp */ function () {} / 2;\nawait import('./x.mjs');\n"],
  ['generator', "const g = function* () {} / 2;\nawait import('./x.mjs');\n"],
  ['call-position', "wrap(function () {} / 2);\nawait import('./x.mjs');\n"],
  ['newline-between-tokens', "const n =\n  function () {} /* sp */ / 2;\nawait import('./x.mjs');\n"],
  [
    'import-hidden-inside-nested-outer-body',
    "const deep = function () { const n = function () {} / 2; await import('./x.mjs'); return n; } / 2;\n",
  ],
  ['object-property-value', "const box = { fn: function () {} / 2 };\nawait import('./x.mjs');\n"],
];

test('rework8(R3-02): a FUNCTION-EXPRESSION body close is an operand — the division after it never blanks the import', () => {
  for (const [label, src] of R8_EXPR_DIV_SOURCES) {
    assert.equal(hasOpaqueDynamicImport(src), false,
      `${label}: a function-EXPRESSION division with a COMPLETE literal argument resolves resolvably (${JSON.stringify(src)})`);
    assert.deepEqual(parseImportSpecs(src), ['./x.mjs'],
      `${label}: detector and extractor agree on the edge behind a function-expression division: ${JSON.stringify(src)}`);
  }
  // The identifier-argument forms stay OPAQUE for the right reason: the import
  // ITSELF stays visible (never blanked by a phantom regex).
  for (const [label, src] of [
    ['anonymous-id-arg', 'const n = function () {} / 2;\nawait import(t);\n'],
    ['nested-id-arg', 'const deep = function () { const n = function () {} / 2; await import(t); return n; } / 2;\n'],
  ]) {
    assert.equal(hasOpaqueDynamicImport(src), true, `${label}: an identifier argument keeps the import OPAQUE`);
    assert.ok(stripCommentsAndStrings(src).includes('await import(t)'), `${label}: the import call stays in the code view`);
  }
});

test('rework8(R3-02): the code view keeps the division after a function expression and everything after it', () => {
  const view = stripCommentsAndStrings('const n = function () {} / 2;\nawait import(t);\n');
  assert.ok(view.includes('/ 2;'), `the division after the function-expression body stays CODE: ${JSON.stringify(view)}`);
  assert.ok(view.includes('await import'), `the dynamic import stays visible: ${JSON.stringify(view)}`);
});

test('rework8(R3-02): an unprovable `export default function ...` body close fails CLOSED instead of blanking', () => {
  const unprovable = "export default function () {} / 2;\nawait import('./x.mjs');\n";
  assert.equal(hasOpaqueDynamicImport(unprovable), true,
    'the expression-vs-declaration context of `export default function` cannot be proven — opaque, never a swallowed import');
  assert.deepEqual(parseImportSpecs(unprovable), [],
    'an unprovable context never certifies an edge');
  assert.equal(hasOpaqueDynamicImport("export default function named() {}\nawait import('./x.mjs');\n"), false,
    'a default-EXPORTED declaration with no trailing division leaves the import resolvable');
});

test('rework8(R3-02): function-DECLARATION bodies keep their statement behavior — a regex after the body stays a regex', () => {
  // These are controls: they passed on the PRE-fix module too, and must keep
  // passing — the expression/declaration distinction must not overreach.
  for (const [label, src] of [
    ['plain-declaration', "function declaredFn() {}\nconst r = /a}/;\nawait import('./x.mjs');\n"],
    ['async-declaration', "async function onDone() {}\nconst r = /a}/;\nawait import('./x.mjs');\n"],
    ['generator-declaration', "function* gg() {}\nconst r = /a}/;\nawait import('./x.mjs');\n"],
    ['export-declaration', "export function plusOne(x2) { return x2 + 1; }\nconst r = /a}/;\nawait import('./x.mjs');\n"],
  ]) {
    const view = stripCommentsAndStrings(src);
    assert.equal(view.includes('/a}'), false,
      `${label}: a regex statement after a DECLARED function body is still a REGEX (body blanked): ${JSON.stringify(view)}`);
    assert.ok(view.includes('await import'), `${label}: the import after the regex statement stays visible: ${JSON.stringify(view)}`);
    assert.deepEqual(parseImportSpecs(src), ['./x.mjs'], `${label}: the edge is still extracted`);
  }
  // A regex INSIDE the declared body is unchanged (the round-7 keyword control).
  assert.equal(hasOpaqueDynamicImport("function f(x) { return /re/.test(x); }\nawait import(t);\n"), true);
  assert.ok(stripCommentsAndStrings("function f(x) { return /re/.test(x); }\nawait import(t);\n").includes('.test(x)'));
});

const R8_FUNCTION_EXPR_BODY = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "const target = '../packages/sample/value.mjs';",
  "test('opaque consumer after a function-expression division', async () => {",
  '  const n = function () {} / 2;',
  '  assert.equal((await import(target)).n, 1);',
  '});',
  '',
].join('\n');

test('rework8(R3-02): an OPERATOR-TRIGGERED function-expression-division consumer is never dropped — selected and full sets both FAIL', async () => {
  const { dir, base } = mkOpaqueConsumerRepo({ dynamicBody: R8_FUNCTION_EXPR_BODY });
  await assertFixturePassesBeforeTheChange(dir); // the fixture is VALID and GREEN before the change
  fs.writeFileSync(path.join(dir, 'packages', 'sample', 'value.mjs'), 'export const n = 2;\n');
  const p = planOf(dir, base);
  assertOpaqueConsumerIsCovered(p);
  assert.equal(p.mode, 'affected', 'the plan stays bounded, it does not degenerate to FULL');
  assert.ok(p.files.includes('tests/static.test.mjs'), 'the static consumer is selected by its literal edge');
  assert.ok(p.files.includes('tests/dynamic.test.mjs'),
    'the pre-fix planner certified files=["tests/static.test.mjs"] ONLY — the dropped dynamic consumer was a false green');
  assert.match(p.reasons['tests/dynamic.test.mjs'], /^opaque-importer:/,
    'the consumer is kept because the file is a proven opaque importer');
  await assertReducedSelectionIsNotFalselyGreen(dir, p);
});

// ---------------------------------------------------------------------------
// Round-8 rework — FINDING 2 (MEDIUM): the failure-evidence helper binds to the
// failing record's OWN metadata block. All controls below run REAL TAP (real
// node --test children on real fixture repos) — no hand-forged TAP text.
// ---------------------------------------------------------------------------

// A fixture like the opaque-consumer one, plus a THIRD test file whose
// consumer fails and whose file/message can carry misleading location text.
function mkMismatchedConsumerRepo({ otherRel, otherBody, nValue = 1 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-r8-'));
  TMP_FIXTURES.add(dir);
  git(dir, ['init']);
  const w = (rel, content) => {
    const p2 = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p2), { recursive: true });
    fs.writeFileSync(p2, content, 'utf8');
  };
  w('packages/sample/value.mjs', `export const n = ${nValue};\n`);
  w('tests/static.test.mjs',
    "import test from 'node:test';\nimport { n } from '../packages/sample/value.mjs';\ntest('static consumer', () => { if (typeof n !== 'number') throw new Error('n'); });\n");
  w('tests/dynamic.test.mjs',
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nconst target = '../packages/sample/value.mjs';\ntest('opaque dynamic consumer', async () => { assert.equal((await import(target)).n, 1); });\n");
  w(otherRel, otherBody);
  w('tests/tiers.json', `${JSON.stringify({
    version: '1',
    always: [],
    smoke: [],
    pathMappings: {},
    fullTriggerPaths: [],
    fullTriggerPrefixes: [],
    ignorePrefixes: [],
    ignoreSuffixes: [],
    coreSubsystems: {},
    tiers: { t1: { minTests: 1, files: ['static.test.mjs', 'dynamic.test.mjs', 'other-mismatch.test.mjs'] } },
  }, null, 2)}\n`);
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.email=r8@t', '-c', 'user.name=r8', 'commit', '-m', 'base']);
  return { dir, base: git(dir, ['rev-parse', 'HEAD']) };
}

test('rework8(MEDIUM): control — a REAL dynamic-consumer assertion failure is accepted (null)', async () => {
  // n=1 -> 2 makes the dynamic consumer fail on its OWN assertion; the static
  // consumer keeps passing; no other file fails. Accepted, as before.
  const { dir } = mkMismatchedConsumerRepo({
    otherRel: 'tests/other-mismatch.test.mjs',
    otherBody: "import test from 'node:test';\ntest('unrelated green consumer', () => {});\n",
    nValue: 2,
  });
  const run = await runNodeTests(dir, ['tests/static.test.mjs', 'tests/dynamic.test.mjs']);
  assert.equal(run.timedOut, false);
  assert.notEqual(run.code, 0, 'the dynamic consumer really fails');
  const sum = tapSummary(run.out);
  assert.ok(sum.fail === 1, `exactly one subtest fails (summary=${JSON.stringify(sum)})`);
  assert.equal(dynamicAssertionFailureRejection(run.out), null,
    `the dynamic consumer's own assertion must stay accepted\n${run.out.slice(-900)}`);
  assertDynamicAssertionFailure(run.out, 'real-dynamic-assertion-control');
});

test('rework8(MEDIUM): an OTHER consumer\'s failure is rejected even when its error message embeds a fake dynamic location', async () => {
  // The reviewer-measured trap: the OTHER consumer fails with ERR_ASSERTION and
  // its rendered MESSAGE contains `location: '<abs>\\tests\\dynamic.test.mjs:1:1'`.
  // The dynamic consumer PASSES. The whole-output helper accepted this; the
  // record-bound helper must reject (the failing record's OWN location is the
  // other file).
  const R8_FAKE_LOCATION_BODY = [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import path from 'node:path';",
    "test('other consumer', () => {",
    "  const fake = `other blew up unrelated\\nlocation: '${path.resolve(import.meta.dirname, 'dynamic.test.mjs')}:1:1'`;",
    '  assert.equal(2, 1, fake);',
    '});',
    '',
  ].join('\n');
  const { dir } = mkMismatchedConsumerRepo({
    otherRel: 'tests/other-mismatch.test.mjs',
    otherBody: R8_FAKE_LOCATION_BODY,
    nValue: 1, // the dynamic consumer PASSES — that is the reviewer's scenario
  });
  const run = await runNodeTests(dir, ['tests/static.test.mjs', 'tests/dynamic.test.mjs', 'tests/other-mismatch.test.mjs']);
  assert.equal(run.timedOut, false);
  assert.notEqual(run.code, 0, 'the other consumer really fails');
  const reason = dynamicAssertionFailureRejection(run.out);
  assert.ok(reason, 'a non-dynamic failure must NEVER be accepted as dynamic-assertion evidence');
  assert.match(reason, /other-mismatch\.test\.mjs/,
    `the rejection binds to the failing record's OWN location (${reason})`);
  assert.throws(() => assertDynamicAssertionFailure(run.out, 'fake-location-probe'),
    'the end-to-end evidence assertion must throw for the other consumer\'s failure');
});

test('rework8(MEDIUM): a neighbouring file whose name merely CONTAINS the dynamic file name is rejected', async () => {
  // The failing record's own location ends in `...tests\dynamic.test.mjs.copy.mjs`
  // — a substring match over the whole output would have accepted this as the
  // dynamic consumer's failure; exact end-anchored binding does not.
  const R8_COPY_FILE_BODY = [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "test('consumer of the copy file', () => { assert.equal(2, 1, 'the copy consumer blew up'); });",
    '',
  ].join('\n');
  const { dir } = mkMismatchedConsumerRepo({
    otherRel: 'tests/dynamic.test.mjs.copy.mjs',
    otherBody: R8_COPY_FILE_BODY,
    nValue: 1,
  });
  const run = await runNodeTests(dir, ['tests/static.test.mjs', 'tests/dynamic.test.mjs', 'tests/dynamic.test.mjs.copy.mjs']);
  assert.equal(run.timedOut, false);
  assert.notEqual(run.code, 0);
  const reason = dynamicAssertionFailureRejection(run.out);
  assert.ok(reason, 'a substring-confusing file name must not count as the dynamic consumer\'s failure');
  assert.match(reason, /dynamic\.test\.mjs\.copy\.mjs/, `the rejection names the copy file (${reason})`);
});

test('rework8(MEDIUM): two failing subtests are rejected even when one is genuinely the dynamic consumer', async () => {
  // A genuinely failing dynamic consumer PLUS an other consumer failing: the
  // helper must never pick evidence from one record while the scenario is not
  // the accepted single-dynamic-failure shape.
  const R8_PLAIN_OTHER_BODY = [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "test('other consumer', () => { assert.equal(2, 1, 'anchor'); });",
    '',
  ].join('\n');
  const { dir } = mkMismatchedConsumerRepo({
    otherRel: 'tests/other-mismatch.test.mjs',
    otherBody: R8_PLAIN_OTHER_BODY,
    nValue: 2, // the dynamic consumer fails on its own assertion TOO
  });
  const run = await runNodeTests(dir, ['tests/static.test.mjs', 'tests/dynamic.test.mjs', 'tests/other-mismatch.test.mjs']);
  assert.equal(run.timedOut, false);
  assert.notEqual(run.code, 0);
  const reason = dynamicAssertionFailureRejection(run.out);
  assert.ok(reason, 'an ambiguous two-failure run is not the accepted shape');
  assert.match(reason, /exactly ONE failing subtest/, `the pre-existing rejection stays (${reason})`);
});

// ==== PR-285 ROUND-9 REWORK9 SECTION (extract-from-here for falsification) ====
// ---------------------------------------------------------------------------
// Round-9 rework (R3-02 HIGH, reviewer-confirmed on fd4399f): the HEAD of a
// template interpolation is an EXPRESSION position, but it shared the
// EMPTY-token sentinel with a program/statement start, so a `function` there
// armed a DECLARATION: `${ function () {} / 2 }` closed its body leaving a
// statement start and the `/ 2` opened a phantom regex that blanked the real
// `await import(...)` behind it with NO uncertain flag. The interpolation
// entry now leaves the `'${'` sentinel (in FN_EXPR_BOUNDARY). The same round
// closes the round-8-review Unicode residuals: Unicode identifiers in
// function headers and bare Unicode variables under `/` are now FULLY lexed,
// and any header shape that is still unlexable (e.g. an escape-identifier
// `f\u006f`) drops its arm FAIL-CLOSED (uncertain -> OPAQUE) instead of
// silently returning to block semantics.
// ---------------------------------------------------------------------------
const R9_INTERP_HEAD_SOURCES = [
  ['anonymous', "const n = `${function () {} / 2}`;\nawait import('./x.mjs');\n"],
  ['named', "const n = `${function go () {} / 2}`;\nawait import('./x.mjs');\n"],
  ['async', "const n = `${async function () {} / 2}`;\nawait import('./x.mjs');\n"],
  ['async-named', "const q = `${async function zed () {} / 2}`;\nawait import('./x.mjs');\n"],
  ['generator', "const g = `${function* () {} / 2}`;\nawait import('./x.mjs');\n"],
  ['generator-named', "const g = `${function* zz () {} / 2}`;\nawait import('./x.mjs');\n"],
  ['nested-interpolation', "const n = `${ `${function () {} / 2}` }`;\nawait import('./x.mjs');\n"],
  ['comments-and-whitespace', "const n = `${ function /* c */ (/* d */ a2) {} / 2 }`;\nawait import('./x.mjs');\n"],
];

test('rework9(R3-02): a function-expression at the HEAD of an interpolation is division — the import behind it is a real edge', () => {
  for (const [label, src] of R9_INTERP_HEAD_SOURCES) {
    assert.equal(hasOpaqueDynamicImport(src), false,
      `${label}: the interpolation-head function-expression closes as an operand — no phantom regex, no uncertified view (${JSON.stringify(src)})`);
    assert.deepEqual(parseImportSpecs(src), ['./x.mjs'],
      `${label}: detector and extractor both see the LITERAL import behind the interpolation-head division: ${JSON.stringify(src)}`);
  }
});

test('rework9(R3-02): the code view keeps the interpolation-head division and everything after it', () => {
  const view = stripCommentsAndStrings("const n = `${function () {} / 2}`;\nawait import(t);\n");
  assert.ok(view.includes('/ 2}`;'), `the interpolation-head division stays CODE: ${JSON.stringify(view)}`);
  assert.ok(view.includes('await import'), `the import behind it stays visible: ${JSON.stringify(view)}`);
  // IDENTIFIER-argument feeding stays OPAQUE for the right reason (the import
  // itself survived, it is not blanked by a phantom regex).
  assert.equal(hasOpaqueDynamicImport("const n = `${function () {} / 2}`;\nawait import(t);\n"), true,
    'an identifier argument keeps the file a proven OPAQUE importer');
});

test('rework9(R3-02): CONTROLS — interpolation object head, and declarations at program/statement start keep regex-after-body behavior', () => {
  // `${` sentinel must not overreach: an object literal at the interpolation
  // head divided by 2 was already proven (round-6 family) and stays proven.
  assert.equal(hasOpaqueDynamicImport("const n = `${ ({}) / 2 }`;\nawait import('./x.mjs');\n"), false);
  assert.deepEqual(parseImportSpecs("const n = `${ ({}) / 2 }`;\nawait import('./x.mjs');\n"), ['./x.mjs']);
  // A real function DECLARATION at program start / statement start keeps the
  // round-8 verdict: a `/` after its body is a REGEX, not division.
  for (const [label, src] of [
    ['program-start', "function declaredFn() {}\nconst r = /a}/;\nawait import('./x.mjs');\n"],
    ['block-statement', "if (true) { function blockFn() {} }\nconst r = /b}/;\nawait import('./x.mjs');\n"],
  ]) {
    const view = stripCommentsAndStrings(src);
    assert.equal(view.includes('/a}') || view.includes('/b}'), false,
      `${label}: a regex after a DECLARED body is still a REGEX (its content is blanked): ${JSON.stringify(view)}`);
    assert.ok(view.includes('await import'), `${label}: the import after the regex stays visible`);
    assert.deepEqual(parseImportSpecs(src), ['./x.mjs'], `${label}: the edge is still extracted`);
  }
  // A literal-import INSIDE the template text (blanked prose) is still not
  // invented out of thin air, and an interpolation-body dynamic import stays
  // visible (the round-4 nested-template control locks this).
  assert.deepEqual(parseImportSpecs("const s = `not a code import('./wi-Fi.mjs')`;\nawait import(t);\n"), [],
    'blanked template PROSE must not produce a specifier');
});

test('rework9(R3-02): UNICODE identifiers are fully lexed — function-expression division and bare-variable division stay proven edges', () => {
  for (const [label, src] of [
    ['unicode-function-name-expression', "const n = function caf\u00e9() {} / 2;\nawait import('./x.mjs');\n"],
    ['unicode-function-name-in-interp', "const n = `${function caf\u00e9() {} / 2}`;\nawait import('./x.mjs');\n"],
    ['bare-unicode-variable-division', "const gi\u00e1 = 1;\nconst r2 = gi\u00e1 / 2;\nawait import('./x.mjs');\n"],
    ['unicode-property-division', "const r3 = box.d\u00e9faut / 2;\nawait import('./x.mjs');\n"],
  ]) {
    assert.equal(hasOpaqueDynamicImport(src), false,
      `${label}: a Unicode identifier is not a reason to lose the edge (${JSON.stringify(src)})`);
    assert.deepEqual(parseImportSpecs(src), ['./x.mjs'],
      `${label}: extractor and detector agree (${JSON.stringify(src)})`);
  }
  // A Unicode-named DECLARATION keeps declaration behavior (regex after body,
  // contents blanked — the same direction as the round-8 declaration control).
  const decl = "function caf\u00e9() {}\nconst r = /u}/;\nawait import('./x.mjs');\n";
  const declView = stripCommentsAndStrings(decl);
  assert.equal(declView.includes('/u}'), false, `a Unicode-named declared body still lexes the / as a REGEX (content blanked): ${JSON.stringify(declView)}`);
  assert.deepEqual(parseImportSpecs(decl), ['./x.mjs'], 'the edge after the Unicode declaration stays extracted');
});

test('rework9(R3-02): a header shape that CANNOT be lexed (escape-identifier, stray band token) drops its arm FAIL-CLOSED — never certified clean', () => {
  for (const [label, src] of [
    ['escape-identifier-header', "const n = function f\\u006f() {} / 2;\nawait import('./x.mjs');\n"],
    ['bare-escape-identifier', "const n2 = function f\\u006f() {};\nconst r = /q}/;\n"],
    ['string-in-header-band', "const n = function 'x' () {} / 2;\nawait import('./x.mjs');\n"],
  ]) {
    assert.equal(hasOpaqueDynamicImport(src), true,
      `${label}: an unlexable header shape makes the file OPAQUE, never a silently blanked view (${JSON.stringify(src)})`);
    assert.deepEqual(parseImportSpecs(src), [],
      `${label}: a failed-proof context never certifies an edge (${JSON.stringify(src)})`);
  }
});

const R9_INTERP_HEAD_BODY = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "const target = '../packages/sample/value.mjs';",
  "test('interpolation-head function-expression consumer', async () => {",
  '  const n = `${function () {} / 2}`;',
  '  assert.equal((await import(target)).n, 1);',
  '});',
  '',
].join('\n');

test('rework9(R3-02): an OPERATOR-TRIGGERED interpolation-head function-expression consumer is never dropped — selected and full sets both FAIL', async () => {
  const { dir, base } = mkOpaqueConsumerRepo({ dynamicBody: R9_INTERP_HEAD_BODY });
  await assertFixturePassesBeforeTheChange(dir); // the fixture is VALID and GREEN before the change
  fs.writeFileSync(path.join(dir, 'packages', 'sample', 'value.mjs'), 'export const n = 2;\n');
  const p = planOf(dir, base);
  assertOpaqueConsumerIsCovered(p);
  assert.equal(p.mode, 'affected', 'the plan stays bounded, it does not degenerate to FULL');
  assert.ok(p.files.includes('tests/static.test.mjs'), 'the static consumer is selected by its literal edge');
  assert.ok(p.files.includes('tests/dynamic.test.mjs'),
    'the pre-fix planner certified files=["tests/static.test.mjs"] ONLY — the dropped dynamic consumer was a false green (fd4399f)');
  assert.match(p.reasons['tests/dynamic.test.mjs'], /^opaque-importer:/,
    'the consumer is kept because the file is a proven opaque importer');
  await assertReducedSelectionIsNotFalselyGreen(dir, p);
});

const R9_INTERP_HEAD_LITERAL_BODY = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "test('literal interpolation-head consumer', async () => {",
  '  const tag2 = `${function () {} / 2}`;',
  "  assert.equal((await import('../packages/sample/value.mjs')).n, 1);",
  "  assert.equal(tag2, 'NaN');",
  '});',
  '',
].join('\n');

test('rework9(R3-02): a LITERAL edge behind the interpolation-head division drives selection — green before, failing after the change', async () => {
  const { dir, base } = mkOpaqueConsumerRepo({ dynamicBody: R9_INTERP_HEAD_LITERAL_BODY });
  await assertFixturePassesBeforeTheChange(dir); // GREEN before the dependency change
  fs.writeFileSync(path.join(dir, 'packages', 'sample', 'value.mjs'), 'export const n = 2;\n');
  const p = planOf(dir, base);
  assert.equal(p.mode, 'affected', 'the literal edge behind the proven division is a real edge — no FULL fallback');
  assert.ok(p.files.includes('tests/dynamic.test.mjs'),
    'the selector picks the literal-edge consumer');
  await assertReducedSelectionIsNotFalselyGreen(dir, p);
});
// ==== END PR-285 ROUND-9 REWORK9 SECTION ====

// ==== PR-285 ROUND-10 REWORK10 SECTION (extract-from-here for falsification) ====
// ---------------------------------------------------------------------------
// Round-10 rework (REVIEW verdict on 90a5d83): the round-9 identifier scanner
// still SHED characters while reading a LEGAL identifier, and the shed char
// fell to the single-char fallback (exprOpen) with NO uncertain — because no
// function arm is pending — so a following `/` opened a phantom regex over
// the real `await import(...)`. Three concrete shapes, all REAL characters in
// the source (built at runtime from code points so no invisible char is
// pasted into this file):
//   1. U+200C/ZWNJ and U+200D/ZWJ — valid ID_Continue characters — remaining
//      at the TAIL of an identifier used in a division.
//   2. An astral-plane identifier (surrogate PAIR like U+10331 GOTHIC AHSA)
//      split into two lone code units by the per-unit scan.
//   3. Unsupported token shapes (a lone High surrogate) must fail CLOSED —
//      uncertain (OPAQUE) even with no function arm pending.
// The fix gives lexJs the standard ID_Start/ID_Continue shape scanned BY CODE
// POINT (identAdvance consumes valid surrogate pairs whole; ZWJ/ZWNJ and the
// standard Other_ID_* exception code points are covered), and any non-ASCII
// character that survives every scanner fails CLOSED (uncertain) regardless
// of a pending arm. ASCII structural characters keep their exact classes.
// ---------------------------------------------------------------------------
const R10_ZWNJ = String.fromCodePoint(0x200c);
const R10_ZWJ = String.fromCodePoint(0x200d);
const R10_ASTRAL = String.fromCodePoint(0x10331); // GOTHIC AHSA — a surrogate PAIR
const R10_LONE = String.fromCharCode(0xd800); // lone High surrogate — never legal

test('rework10(R3-02): ZWJ/ZWNJ-continued identifiers divide PROVABLY — literal edge and opaque identifier-argument both intact', () => {
  // TRAILING continuation (the reviewer's shape): the ZWNJ/ZWJ is the last
  // char of the identifier being divided.
  for (const [label, joiner] of [['zwnj', R10_ZWNJ], ['zwj', R10_ZWJ]]) {
    const literal = `const a${joiner} = 1;\nconst n = a${joiner} / 2;\nawait import('./x.mjs');\n`;
    assert.equal(hasOpaqueDynamicImport(literal), false,
      `${label}: a ZWNJ/ZWJ identifier tail must not re-open a phantom regex (${JSON.stringify(literal)})`);
    assert.deepEqual(parseImportSpecs(literal), ['./x.mjs'],
      `${label}: the literal edge behind the division stays extracted (${JSON.stringify(literal)})`);
    const identifier = `const a${joiner} = 1;\nconst n = a${joiner} / 2;\nawait import(t);\n`;
    assert.equal(hasOpaqueDynamicImport(identifier), true,
      `${label}: an identifier argument stays OPAQUE and the import stays VISIBLE (${JSON.stringify(identifier)})`);
    assert.ok(stripCommentsAndStrings(identifier).includes('await import(t)'),
      `${label}: the import call survives in the code view (${JSON.stringify(identifier)})`);
    // MID-identifier continuation must keep previous verdicts too.
    const mid = `const a${joiner}b = 1;\nconst r2 = a${joiner}b / 2;\nawait import('./x.mjs');\n`;
    assert.deepEqual(parseImportSpecs(mid), ['./x.mjs'], `${label}: mid-identifier use stays a proven edge (${JSON.stringify(mid)})`);
  }
});

test('rework10(R3-02): astral identifiers are scanned BY CODE POINT — the surrogate pair stays whole and the division is proven', () => {
  const literal = `const ${R10_ASTRAL} = 1;\nconst n = ${R10_ASTRAL} / 2;\nawait import('./x.mjs');\n`;
  assert.equal(hasOpaqueDynamicImport(literal), false,
    `an astral identifier must not split into lone surrogates (${JSON.stringify(literal)})`);
  assert.deepEqual(parseImportSpecs(literal), ['./x.mjs'],
    `the edge behind an astral-identifier division stays extracted (${JSON.stringify(literal)})`);
  const identifier = `const ${R10_ASTRAL} = 1;\nconst n = ${R10_ASTRAL} / 2;\nawait import(t);\n`;
  assert.equal(hasOpaqueDynamicImport(identifier), true,
    'an identifier argument stays OPAQUE with the import visible');
  assert.ok(stripCommentsAndStrings(identifier).includes('await import(t)'), 'the import call survives');
  // Property access with an astral name divides too.
  assert.deepEqual(parseImportSpecs(`const r3 = box.${R10_ASTRAL}x / 2;\nawait import('./x.mjs');\n`), ['./x.mjs'],
    'an astral PROPERTY name divides provably');
});

test('rework10(R3-02): unsupported token shapes fail CLOSED (uncertain -> OPAQUE) even with NO function arm pending', () => {
  const escapeHeader = "const n = function f\\u006f() {} / 2;\nawait import('./x.mjs');\n";
  assert.equal(hasOpaqueDynamicImport(escapeHeader), true,
    'an unlexable header shape makes the file OPAQUE, never a silently blanked view');
  assert.deepEqual(parseImportSpecs(escapeHeader), [],
    'a failed-proof context with a division shape never certifies an edge');
  // A lone High surrogate can never form a legal identifier (it is not even a
  // source-valid identifier character), so nothing provable can be asserted
  // about its context: the DETECTOR fails CLOSED (OPAQUE) with no function arm
  // pending. The extractor may still see the literal import itself (this body
  // has no division, so no phantom blanking) — the OPAQUE classification is
  // the fail-closed instrument, and nothing of the import call is silently
  // ERASED from the code view.
  const lone = `const a${R10_LONE} = 1;\nawait import('./x.mjs');\n`;
  assert.equal(hasOpaqueDynamicImport(lone), true,
    'a lone surrogate token char keeps the context UNPROVEN: OPAQUE (no function arm needed)');
  assert.ok(stripCommentsAndStrings(lone).includes('await import('),
    `the import call itself is not silently erased from the view: ${JSON.stringify(stripCommentsAndStrings(lone))}`);
});

test('rework10(R3-02): CONTROLS — prior rounds keep their verdicts (café division, interpolation-head division, declaration regex, Other_ID_Continue)', () => {
  assert.deepEqual(parseImportSpecs("const n = function caf\u00e9() {} / 2;\nawait import('./x.mjs');\n"), ['./x.mjs'],
    'the round-9 café division control keeps its proven edge');
  assert.deepEqual(parseImportSpecs("const n = `${function () {} / 2}`;\nawait import('./x.mjs');\n"), ['./x.mjs'],
    'the round-9 interpolation-head control keeps its proven edge');
  const decl = `function caf${R10_ZWJ}x() {}\nconst r = /a}/;\nawait import('./x.mjs');\n`;
  const declView = stripCommentsAndStrings(decl);
  // The name carries a ZWJ but the DECLARATION boundary behavior is identical
  // to a plain name: the regex after the body is blanked (content gone, the
  // final `/` delimiter kept — the same established shape as prior rounds).
  assert.equal(declView.includes('/a}'), false,
    `a ZWJ-named declared body still lexes the / as a REGEX (content blanked): ${JSON.stringify(declView)}`);
  const plainDeclView = stripCommentsAndStrings("function declaredFn() {}\nconst r = /a}/;\nawait import('./x.mjs');\n");
  assert.equal(declView.split('{}')[1], plainDeclView.split('{}')[1],
    `the post-body view is IDENTICAL to a plain-named declaration: ${JSON.stringify(declView.split('{}')[1])} vs ${JSON.stringify(plainDeclView.split('{}')[1])}`);
  assert.deepEqual(parseImportSpecs(decl), ['./x.mjs'], 'the edge after the ZWJ declaration stays extracted');
  // U+00B7 (Other_ID_Continue) inside an identifier: standard exception set.
  assert.deepEqual(parseImportSpecs("const b\u00b7c = 1;\nconst r4 = b\u00b7c / 2;\nawait import('./x.mjs');\n"), ['./x.mjs'],
    'the U+00B7 Other_ID_Continue exception and a following division stay proven');
});

const R10_ZWJ_BODY_MK = () => [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "const target = '../packages/sample/value.mjs';",
  `const id${String.fromCodePoint(0x200d)}z = 1;`,
  "test('ZWJ-identifier-division consumer', async () => {",
  `  const n = id${String.fromCodePoint(0x200d)}z / 2;`,
  '  assert.equal((await import(target)).n, 1);',
  '});',
  '',
].join('\n');

test('rework10(R3-02): an OPERATOR-REVIEW SHAPED ZWJ-division consumer keeps a bounded plan with the dynamic consumer — selected and full FAIL', async () => {
  const { dir, base } = mkOpaqueConsumerRepo({ dynamicBody: R10_ZWJ_BODY_MK() });
  await assertFixturePassesBeforeTheChange(dir); // the fixture is VALID and GREEN before the change
  fs.writeFileSync(path.join(dir, 'packages', 'sample', 'value.mjs'), 'export const n = 2;\n');
  const p = planOf(dir, base);
  assertOpaqueConsumerIsCovered(p);
  assert.equal(p.mode, 'affected', 'the plan stays bounded, it does not degenerate to FULL');
  assert.ok(p.files.includes('tests/static.test.mjs'), 'the static consumer is selected by its literal edge');
  assert.ok(p.files.includes('tests/dynamic.test.mjs'),
    'the PRE-fix planner certified files=["tests/static.test.mjs"] ONLY — the dropped dynamic consumer was a false green (90a5d83)');
  assert.match(p.reasons['tests/dynamic.test.mjs'], /^opaque-importer:/,
    'the consumer is kept because the file is a proven opaque importer');
  await assertReducedSelectionIsNotFalselyGreen(dir, p);
});
// ==== PR-285 ROUND-11 MECHANISM MATRIX ====
// Findings from the mechanism review: line comments must end at EVERY
// ECMAScript LineTerminator; present-but-wrong-type manifest fields must be
// refused instead of silently defaulted; contextual / escaped tokens must
// fail closed without swallowing a real import.

test('rework11: `//` comment ends at LF, CR, CRLF, U+2028 and U+2029 alike', () => {
  const LS = String.fromCodePoint(0x2028);
  const PS = String.fromCodePoint(0x2029);
  for (const term of ['\n', '\r', '\r\n', LS, PS]) {
    const src = `// decoy import('./decoy.mjs')${term}import('./real.mjs');`;
    assert.deepEqual(parseImportSpecs(src), ['./real.mjs'],
      `the real import must survive a // terminated by ${JSON.stringify(term)}`);
    assert.equal(hasOpaqueDynamicImport(src), false,
      `a literal import after ${JSON.stringify(term)} is still a proven literal edge`);
  }
});

test('rework11: LS/PS line continuations inside a specifier decode to the loaded module', () => {
  const LS = String.fromCodePoint(0x2028);
  const PS = String.fromCodePoint(0x2029);
  for (const term of [LS, PS]) {
    const src = `import('./val\\${term}ue.mjs');`;
    assert.deepEqual(parseImportSpecs(src), ['./value.mjs'],
      `backslash+${JSON.stringify(term)} is a line continuation, not a separator in the specifier`);
  }
});

test('rework11: an unmodelled identifier escape fails closed without losing the import edge', () => {
  const backslashEscape = 'const a\\u{200C} = 1;\nconst n = a\\u{200C} / 2;\nawait import(t);';
  assert.equal(hasOpaqueDynamicImport(backslashEscape), true,
    'an identifier escape the lexer cannot model must leave the slash context unproven (OPAQUE)');
  const literalAfterEscape = 'const a\\u{200C} = 1;\nimport("./real.mjs");';
  assert.deepEqual(parseImportSpecs(literalAfterEscape), ['./real.mjs'],
    'fail-closed must not swallow a real literal import that follows the escape');
});

test('rework11: contextual `of` is an identifier in expression position, a keyword in for-of', () => {
  const variable = 'const of = 2;\nconst n = of / 2;\nawait import(t);';
  assert.equal(hasOpaqueDynamicImport(variable), true,
    '`of / 2` must be division, so the real dynamic import after it stays visible');
  // (review R2, finding E) ASI ends the declaration before the second `of`;
  // a bare prevKind rule still saw an operand and turned it into a keyword.
  const asi = 'const of = 2\nof / 2;\nimport("./real.mjs");';
  assert.deepEqual(parseImportSpecs(asi), ['./real.mjs'],
    'after ASI `of / 2` is division, so the real literal import stays certified');
  assert.equal(hasOpaqueDynamicImport(asi), false,
    'the ASI case is PROVEN, not opaque: no unproven information is used to drop the consumer');
  const forOf = 'for (const x of /a/) {}\nawait import(t);';
  assert.equal(hasOpaqueDynamicImport(forOf), true,
    'a for-of head still lets a regex literal follow and must not hide the import either');
  const literalEdge = 'const of = 2;\nconst n = of / 2;\nimport("./real.mjs");';
  assert.deepEqual(parseImportSpecs(literalEdge), ['./real.mjs']);
  // (review R3, finding E residual) the for-head context must NOT leak into a
  // function/arrow body nested in the head: that body is its own statement
  // scope, so `of / 2` there is division and the real import stays certified.
  const nestedArrow = 'for (let x = (() => { const of = 2\nof / 2;\nimport("./real.mjs"); return 0; })(); false;) {}';
  assert.deepEqual(parseImportSpecs(nestedArrow), ['./real.mjs'],
    'an arrow body inside a for-head is a separate statement scope');
  assert.equal(hasOpaqueDynamicImport(nestedArrow), false,
    'the nested-arrow case is PROVEN, not opaque');
  const nestedFn = 'for (let x = function () { const of = 2\nof / 2;\nimport("./real.mjs"); }; false;) {}';
  assert.deepEqual(parseImportSpecs(nestedFn), ['./real.mjs'],
    'a function body inside a for-head is a separate statement scope');
});

test('rework11: a class body close cannot certify statement context', () => {
  for (const src of [
    'const n = class C {} / 2;\nawait import(t);',
    'class C {} / 2;\nawait import(t);',
    // (review R2, finding F) nested class / object literal / function inside
    // the `extends` expression used to consume the OUTER pending body `{`.
    'const C = class extends (class {}) {} / 2;\nawait import(t);',
    'class A extends ({}) {} / 2;\nawait import(t);',
    'class A extends function() {} {} / 2;\nawait import(t);',
  ]) {
    assert.equal(hasOpaqueDynamicImport(src), true,
      `class body followed by / is unproven and must fail closed: ${src.split('\n')[0]}`);
  }
  // The conservative fallback is the CONTRACT for a class body whose
  // expression/declaration context is unproven: no edge is certified, and
  // the opaque flag is what keeps the consumer in the affected set.
  assert.deepEqual(parseImportSpecs('const n = class C {} / 2;\nimport("./real.mjs");'), [],
    'an unprovable class-body context never certifies an edge (opaque fallback instead)');
  assert.deepEqual(parseImportSpecs('const C = class extends (class {}) {} / 2;\nimport("./real.mjs");'), [],
    'the nested-extends case stays opaque, never certifies an edge');
  // (review R2 / real-repo regression) `class` as an object KEY or METHOD name
  // is a reserved-word property, NOT a class header. Pushing a pending header
  // there fail-closed the object's own `}` and marked real repo files opaque.
  assert.equal(hasOpaqueDynamicImport('const o = { class: 1, of: 2 };\nimport("./real.mjs");'), false,
    'a `class:` property key must not open a pending class header');
  assert.deepEqual(parseImportSpecs('const o = { class: 1, of: 2 };\nimport("./real.mjs");'), ['./real.mjs']);
  assert.equal(hasOpaqueDynamicImport('const o = { class() { return 1; } };\nimport("./real.mjs");'), false,
    'a `class()` method name must not open a pending class header');
  // (review R3, finding F residual) a `${...}` interpolation inside the
  // `extends` expression must not consume the OUTER pending class body.
  const templateHeritage = 'const tag = () => Object;\nconst C = class extends tag`${ {} }` {} / 2;\nimport("./real.mjs");';
  assert.equal(hasOpaqueDynamicImport(templateHeritage), true,
    'a template interpolation in heritage is unproven and must fail closed');
  assert.deepEqual(parseImportSpecs(templateHeritage), [],
    'a template interpolation in heritage never certifies an edge');
  const templateNested = 'const tag = () => Object;\nconst C = class extends tag`${ { a: `${ {} }` } }` {} / 2;\nimport("./real.mjs");';
  assert.equal(hasOpaqueDynamicImport(templateNested), true,
    'a nested template interpolation in heritage must also fail closed');
});

test('rework11: present-but-wrong-type manifest fields are refused, missing fields keep defaults', () => {
  const { dir } = mkPlanRepo();
  const mp = path.join(dir, 'tests', 'tiers.json');
  const base0 = JSON.parse(fs.readFileSync(mp, 'utf8'));
  const write = (o) => fs.writeFileSync(mp, JSON.stringify(o), 'utf8');
  const expectBad = (mutate, needle, label) => {
    const m = JSON.parse(JSON.stringify(base0));
    mutate(m);
    write(m);
    const r = loadManifestForRoot(dir);
    assert.equal(r.ok, false, `${label} must fail closed`);
    assert.match(r.reason, needle, `${label} reason must name the field`);
  };

  expectBad((m) => { m.smoke = 'a.test.mjs'; }, /smoke/, 'smoke:string');
  expectBad((m) => { m.always = 'always.test.mjs'; }, /always/, 'always:string');
  expectBad((m) => { m.pathMappings = []; }, /pathMappings/, 'pathMappings:array');
  expectBad((m) => { m.fullTriggerPaths = 5; }, /fullTriggerPaths/, 'fullTriggerPaths:number');
  expectBad((m) => { m.fullTriggerPrefixes = {}; }, /fullTriggerPrefixes/, 'fullTriggerPrefixes:object');
  expectBad((m) => { m.ignorePrefixes = {}; }, /ignorePrefixes/, 'ignorePrefixes:object');
  expectBad((m) => { m.ignoreSuffixes = {}; }, /ignoreSuffixes/, 'ignoreSuffixes:object');
  expectBad((m) => { m.coreSubsystems = { 'packages/y/': ['ghost.test.mjs'] }; }, /coreSubsystems/, 'coreSubsystems:unknown-test');
  expectBad((m) => { m.tiers.t1.files = [1]; }, /files\[\]/, 'tiers.files:number');

  const ok = JSON.parse(JSON.stringify(base0));
  delete ok.smoke; delete ok.always; delete ok.pathMappings;
  delete ok.coreSubsystems; delete ok.fullTriggerPaths; delete ok.fullTriggerPrefixes;
  write(ok);
  assert.equal(loadManifestForRoot(dir).ok, true, 'omitting optional fields keeps the contract defaults');
});
// ==== END PR-285 ROUND-11 MECHANISM MATRIX ====

// ==== END PR-285 ROUND-10 REWORK10 SECTION ====

// ==== PR-285 ROUND-12 — final-review findings F1/F2 ====
// F1: which `(` opened a paren decides what its `)` leaves behind. A CONTROL
//     head (`if/while/for/with/switch/catch`) leaves statement position, so the
//     `/` after it is a REGEX body; a grouping/call `(` leaves expression
//     position, so the `/` after it is DIVISION; an unbalanced `)` proves
//     nothing and fails closed.
// F2: an ESM specifier is a URL (query/fragment dropped, percent-decoding
//     applied) while a CJS `require()` argument stays a raw filesystem path.

test('rework12(F1): a control head `)` proves statement position — its regex body never blanks the imports behind it', () => {
  for (const [label, head] of [
    ['if', 'if (true)'],
    ['while', 'while (false)'],
    ['for', 'for (;;)'],
    ['nested parens', 'if ((true))'],
  ]) {
    const src = `${head} /a+b/;\nimport('./real.mjs');`;
    assert.deepEqual(parseImportSpecs(src), ['./real.mjs'],
      `${label}: the control body regex must not blank the literal import behind it (${src.split('\n')[0]})`);
    assert.equal(hasOpaqueDynamicImport(src), false,
      `${label}: the statement context is PROVEN, so the edge is certified — not a fail-closed loss`);
    const opaque = `${head} /a+b/;\nawait import(spec);`;
    assert.equal(hasOpaqueDynamicImport(opaque), true,
      `${label}: a non-literal specifier behind a proven context still fails closed (consumer kept, never dropped)`);
  }
  // CONTROLS — a call/group `)` leaves EXPRESSION position: the `/` after it
  // stays DIVISION, so the real edge behind it survives. A property name is
  // never a control head, even when the property IS a reserved word.
  for (const [label, src] of [
    ['call', "const n = f(x) / 2;\nimport('./real.mjs');"],
    ['group', "const n = (a + b) / 2;\nimport('./real.mjs');"],
    ['reserved-word property call', "const n = o.switch(x) / 2;\nimport('./real.mjs');"],
    ['optional-chained property call', "const n = o?.catch(x) / 2;\nimport('./real.mjs');"],
  ]) {
    assert.deepEqual(parseImportSpecs(src), ['./real.mjs'],
      `${label}: division context must keep the real edge (${src.split('\n')[0]})`);
    assert.equal(hasOpaqueDynamicImport(src), false, `${label}: proven, not opaque`);
  }
  // An unbalanced `)` proves nothing: the `/` after it is UNPROVEN, so the file
  // fails closed (opaque) instead of certifying a regex-vs-division guess the
  // lexer never made — and the consumer behind it is kept, never dropped.
  const unbalanced = 'const n = a) / b;\nimport("./real.mjs");';
  assert.equal(hasOpaqueDynamicImport(unbalanced), true,
    'an unbalanced `)` must fail closed (opaque), never a silently dropped edge');
});

const R12_URL_BODY = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "test('dynamic consumer', async () => {",
  "  const m = await import('../packages/sample/value.mjs?probe=1');",
  '  assert.equal(m.n, 1);',
  '});',
  '',
].join('\n');

test('rework12(F2): a URL-shaped specifier resolves to the FILE it names — the query consumer is selected, never a false green', async () => {
  // Node really loads `value.mjs?probe=1` as `value.mjs` (the query is part of
  // the URL, not the filename), so this consumer breaks when the file changes.
  // PRE-fix the edge was keyed on the RAW specifier: `packages/sample/value.mjs?probe=1`
  // was a graph key no change could ever match, the consumer was dropped (it is
  // a literal, hence not opaque) and the reduced selection went GREEN.
  const { dir, base } = mkOpaqueConsumerRepo({ dynamicBody: R12_URL_BODY });
  await assertFixturePassesBeforeTheChange(dir); // GREEN before the dependency change
  fs.writeFileSync(path.join(dir, 'packages', 'sample', 'value.mjs'), 'export const n = 2;\n');
  const p = planOf(dir, base);
  assert.equal(p.mode, 'affected', 'the URL consumer is a real edge — no FULL fallback and no dropped consumer');
  assert.ok(p.files.includes('tests/dynamic.test.mjs'),
    'the consumer of `value.mjs?probe=1` IS a consumer of `value.mjs`');
  assert.equal(p.files.includes('tests/plain.test.mjs'), false,
    'the union stays bounded (no unrelated test)');
  await assertReducedSelectionIsNotFalselyGreen(dir, p);
});

test('rework12(F2): ESM resolves as a URL, require() as a raw path, an unprovable specifier fails closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-url-'));
  TMP_FIXTURES.add(dir);
  const w = (rel, content) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  };
  w('packages/value.mjs', 'export const n = 1;\n');
  w('tests/url.test.mjs', "import test from 'node:test';\nconst m = await import('../packages/value.mjs?probe=1');\ntest('u', () => { if (m.n !== 1) throw new Error('n'); });\n");
  w('tests/frag.test.mjs', "await import('../packages/value.mjs#frag');\n");
  w('tests/enc.test.mjs', "await import('../packages/%76alue.mjs');\n"); // %76 decodes to `v`
  w('tests/cjs.test.cjs', "require('../packages/value.mjs?raw');\n");
  w('tests/bad.test.mjs', "await import('../packages/%zz.mjs');\n"); // malformed escape
  w('tests/bare.test.mjs', "import 'node:path';\n");

  const g = buildImportGraph(dir);
  const deps = [...(g.dependents.get('packages/value.mjs') || [])];
  for (const c of ['tests/url.test.mjs', 'tests/frag.test.mjs', 'tests/enc.test.mjs']) {
    assert.ok(deps.includes(c),
      `${c} must be a dependent of the FILE its specifier really names (${JSON.stringify(deps)})`);
  }
  assert.ok(!deps.includes('tests/cjs.test.cjs'),
    'a require() query is part of the FILENAME — it must not alias onto the clean file');
  // (F2) No ESM consumer may leave a query/fragment-shaped key behind — the
  // reviewer's repro saw `packages/value.mjs?probe=1` (plus bogus extension
  // candidates) polluting the graph. The ONE raw key that may remain is the
  // CJS one: for require() `value.mjs?raw` IS the filename.
  for (const key of g.dependents.keys()) {
    // The CJS raw path (`...?raw`) and the extension candidates derived from
    // it are the only keys allowed to carry a `?`: for require() that string
    // IS the filename, and the graph keeps non-existent targets on purpose
    // (deletion planning).
    if (key.startsWith('packages/value.mjs?raw')) continue;
    assert.ok(!/[?#]/.test(key),
      `ESM graph keys are file identities, never query/fragment strings: ${key}`);
  }
  assert.equal(g.dependents.has('packages/value.mjs?probe=1'), false,
    'the query-shaped key of the reviewer repro must not exist');
  assert.equal(g.dependents.has('packages/value.mjs#frag'), false,
    'the fragment-shaped key must not exist');
  const cjsEdges = g.edges.get('tests/cjs.test.cjs') || new Set();
  assert.ok(cjsEdges.has('packages/value.mjs?raw'), 'require() keeps its argument verbatim as a path');
  assert.equal(cjsEdges.has('packages/value.mjs'), false, 'require() is never URL-split or percent-decoded');
  assert.equal(g.opaque.has('tests/bad.test.mjs'), true,
    'a malformed %-escape cannot be proven to a path — fail closed to opaque instead of dropping the edge');
  assert.equal(g.opaque.has('tests/bare.test.mjs'), false,
    'a bare specifier is neither an edge nor an uncertainty');
});
// ==== END PR-285 ROUND-12 ====

// ==== PR-285 ROUND-16 ====
// Final-review findings F1 (statement-position block lexing), F2 (ESM URL
// semantics: tab/LF/CR removal, backslash as a path separator, trailing trim)
// and N2 (quoted ModuleExportName in a static import/re-export). Each one
// dropped a REAL consumer while leaving the file NON-opaque — no edge AND no
// fail-closed signal — so a reduced selection went green over a dependency it
// never re-ran.

const R16_BLOCK_BODY = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "const spec = '../packages/sample/value.mjs';",
  '{}',
  '/a+/;',
  "test('consumer behind a standalone block', async () => { assert.equal((await import(spec)).n, 1); });",
  '',
].join('\n');

const R16_TAB_BODY = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "test('tab specifier consumer', async () => { assert.equal((await import('../packages/sample/va\tlue.mjs')).n, 1); });",
  '',
].join('\n');

test('rework16(F1): a STANDALONE block statement is a block — the regex after it never blanks a real import', () => {
  // Reviewer repro. `{}` in STATEMENT position was classified as an object
  // literal, so its `}` left expression position and the `/` of `/a+/` was read
  // as DIVISION. The phantom regex pair then blanked the whole rest of the file
  // — including `await import(spec)` — while the file stayed NON-opaque: the
  // consumer was neither an edge nor a fail-closed uncertainty.
  const repro = "const spec = './value.mjs';\n{}\n/a+/;\nawait import(spec);\n";
  assert.equal(hasOpaqueDynamicImport(repro), true,
    'the import behind the standalone block must be READ, never swallowed by a phantom regex');
  assert.match(stripCommentsAndStrings(repro), /await import\(spec\)/,
    'the statement after the block really survives in the code view');
  // Every shape that RESTORES statement position, not just `;`.
  for (const [label, src] of [
    ['program start', "{}\n/a+/;\nawait import(spec);\n"],
    ['after a statement `;`', "const a = 1;\n{}\n/a+/;\nawait import(spec);\n"],
    ['after a block close', "if (x) {}\n{}\n/a+/;\nawait import(spec);\n"],
    ['two blocks in a row', "{}\n{}\n/a+/;\nawait import(spec);\n"],
    ['inside a function body', "function f() {\n{}\n/a+/;\nawait import(spec);\n}\n"],
  ]) {
    assert.equal(hasOpaqueDynamicImport(src), true,
      `${label}: a statement-position block leaves regex position, so the import behind it is read`);
  }
  // CONTROLS — an object literal in EXPRESSION position still DIVIDES, so the
  // real edge behind it survives. The fix is context, not a blanket
  // "brace means block".
  for (const [label, src] of [
    ['empty object', "const n = {} / 2;\nimport('./real.mjs');\n"],
    ['object with a property', "const n = {a: 1} / 2;\nimport('./real.mjs');\n"],
    ['object argument in a call', "f({} / 2);\nimport('./real.mjs');\n"],
  ]) {
    assert.deepEqual(parseImportSpecs(src), ['./real.mjs'],
      `${label}: expression-position braces keep DIVISION, so the real edge stays (${src.split('\n')[0]})`);
    assert.equal(hasOpaqueDynamicImport(src), false, `${label}: proven, not opaque`);
  }
});

test('rework16(F1): the block-lexing consumer is never dropped — the reduced selection FAILS like the full set', async () => {
  const { dir, base } = mkOpaqueConsumerRepo({ dynamicBody: R16_BLOCK_BODY });
  await assertFixturePassesBeforeTheChange(dir); // GREEN before the dependency change
  fs.writeFileSync(path.join(dir, 'packages', 'sample', 'value.mjs'), 'export const n = 2;\n');
  const p = planOf(dir, base);
  assert.equal(p.mode, 'affected', 'the block consumer is a real consumer — no FULL fallback');
  assertOpaqueConsumerIsCovered(p);
  assert.match(p.reasons['tests/dynamic.test.mjs'], /^opaque-importer:/,
    'the selection reason names the opaque importer instead of dropping it silently');
  await assertReducedSelectionIsNotFalselyGreen(dir, p);
});

test('rework16(F2): tab/LF/CR are REMOVED and a backslash is a path separator — the graph keys the file Node loads', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-r16url-'));
  TMP_FIXTURES.add(dir);
  const w = (rel, content) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  };
  w('packages/value.mjs', 'export const n = 1;\n');
  w('packages/va/lue.mjs', 'export const n = 99;\n');
  w('packages/va lue.mjs', 'export const n = 7;\n');
  // A raw tab inside a string literal is legal JS; `\n`/`\r`/`\t` escapes decode
  // to the real control characters. Node's URL parser removes tab/LF/CR from
  // the specifier BEFORE resolving, so all three name `value.mjs`.
  w('tests/tab-raw.test.mjs', "await import('../packages/va\tlue.mjs');\n");
  w('tests/tab-esc.test.mjs', "await import('../packages/va\\tlue.mjs');\n");
  w('tests/lf.test.mjs', "await import('../packages/va\\nlue.mjs');\n");
  w('tests/cr.test.mjs', "await import('../packages/va\\rlue.mjs');\n");
  // A trailing run of spaces is trimmed by the URL parser…
  w('tests/trailing.test.mjs', "await import('../packages/value.mjs ');\n");
  // …an INTERNAL space is part of the filename…
  w('tests/inner-space.test.mjs', "await import('../packages/va lue.mjs');\n");
  // …and a backslash is a path separator for a file: URL.
  w('tests/bslash.test.mjs', String.raw`await import('..\\packages\\value.mjs');` + '\n');
  // CONTROLS: require() takes its argument VERBATIM (no URL processing at all),
  // and a leading space makes the specifier BARE, exactly as Node does.
  w('tests/cjs.test.cjs', "require('../packages/va\\tlue.cjs');\n");
  w('tests/leading-space.test.mjs', "await import(' ../packages/value.mjs');\n");

  const g = buildImportGraph(dir);
  const deps = (f) => [...(g.dependents.get(f) || [])];
  for (const c of ['tests/tab-raw.test.mjs', 'tests/tab-esc.test.mjs', 'tests/lf.test.mjs',
    'tests/cr.test.mjs', 'tests/trailing.test.mjs', 'tests/bslash.test.mjs']) {
    assert.ok(deps('packages/value.mjs').includes(c),
      `${c} must depend on value.mjs — the file Node really loads (${JSON.stringify(deps('packages/value.mjs'))})`);
    assert.equal(g.opaque.has(c), false, `${c} is a PROVEN edge, not a fail-closed uncertainty`);
  }
  assert.ok(deps('packages/va lue.mjs').includes('tests/inner-space.test.mjs'),
    'an INTERNAL space stays part of the filename');
  assert.equal(g.opaque.has('tests/inner-space.test.mjs'), false, 'a resolvable internal space is not opaque');
  assert.equal(deps('packages/value.mjs').includes('tests/leading-space.test.mjs'), false,
    'a leading space makes the specifier bare (Node treats it as a package name, not a relative URL)');
  assert.equal(g.opaque.has('tests/leading-space.test.mjs'), false,
    'a bare specifier is neither an edge nor an uncertainty');
  const cjsEdges = g.edges.get('tests/cjs.test.cjs') || new Set();
  assert.equal(cjsEdges.has('packages/value.mjs'), false,
    'require() is never URL-processed: its tab-bearing argument is a filename, not `value.mjs`');
  // No ESM-resolved graph key may carry a control character that the URL
  // pipeline removes. The CJS edge above is the ONE exception by design: for
  // require() that string IS the filename.
  for (const [importer, targets] of g.edges) {
    if (importer.endsWith('.cjs')) continue;
    for (const t of targets) {
      assert.ok(!/[\t\n\r]/.test(t),
        `${importer}: no ESM key may keep a tab/LF/CR the loader strips: ${JSON.stringify(t)}`);
    }
  }
});

test('rework16(F2): the tab-specifier consumer is never dropped — selected by a REAL edge, and the reduced selection FAILS like full', async () => {
  const { dir, base } = mkOpaqueConsumerRepo({ dynamicBody: R16_TAB_BODY });
  await assertFixturePassesBeforeTheChange(dir); // GREEN before the dependency change
  fs.writeFileSync(path.join(dir, 'packages', 'sample', 'value.mjs'), 'export const n = 2;\n');
  const p = planOf(dir, base);
  assert.equal(p.mode, 'affected', 'the tab consumer is a real edge — no FULL fallback and no dropped consumer');
  assert.ok(p.files.includes('tests/dynamic.test.mjs'),
    'a literal `va\\tlue.mjs` is a consumer of `value.mjs`, so it is selected by the closure');
  await assertReducedSelectionIsNotFalselyGreen(dir, p);
});

test('rework16(N2): a QUOTED ModuleExportName keeps its static edge — never a silent drop at opaque=false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-r16quoted-'));
  TMP_FIXTURES.add(dir);
  const w = (rel, content) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  };
  w('packages/a.mjs', 'export const n = 1;\n');
  w('packages/b.mjs', 'export const n = 2;\n');
  // ES2022 arbitrary module namespace names: the EXPORTED/IMPORTED NAME may be a
  // string literal. The clause between the keyword and `from` therefore contains
  // a quote, and the old matcher (`[^;'"]*?`) refused to cross it — the edge was
  // silently MISSED while the file stayed NON-opaque.
  w('tests/quoted-import.test.mjs', "import { \"n\" as n } from '../packages/a.mjs';\nexport const got = n;\n");
  w('tests/quoted-reexport.test.mjs', 'export { n as "value" } from \'../packages/b.mjs\';\n');
  w('tests/multiline.test.mjs', "import {\n  \"n\" as n,\n} from '../packages/a.mjs';\nexport const got = n;\n");
  // CONTROLS: ordinary clauses still match, and prose inside a blanked string is
  // never read as a clause (the quote is kept, its CONTENT is not).
  w('tests/plain.test.mjs', "import { n } from '../packages/a.mjs';\nexport const got = n;\n");
  w('tests/prose.test.mjs', "const s = \"import from './nope.mjs'\";\nimport '../packages/a.mjs';\n");

  const g = buildImportGraph(dir);
  const deps = (f) => [...(g.dependents.get(f) || [])];
  for (const c of ['tests/quoted-import.test.mjs', 'tests/multiline.test.mjs', 'tests/plain.test.mjs', 'tests/prose.test.mjs']) {
    assert.ok(deps('packages/a.mjs').includes(c),
      `${c} must depend on a.mjs (${JSON.stringify(deps('packages/a.mjs'))})`);
    assert.equal(g.opaque.has(c), false, `${c}: a proven static edge is not opaque`);
  }
  assert.ok(deps('packages/b.mjs').includes('tests/quoted-reexport.test.mjs'),
    'a quoted RE-EXPORT name keeps its edge too');
  // No phantom target may be invented from the prose inside the string.
  for (const key of g.dependents.keys()) {
    assert.ok(!/nope\.mjs/.test(key), `prose inside a string is never a specifier: ${key}`);
  }
});
// ==== END PR-285 ROUND-16 ====

// ==== PR-285 ROUND-17 ====
// Final-review (rework16) finding F1b, same root cause as F1: a colon in
// STATEMENT position (`case 1:`, `default:`, `label:`) also restores statement
// position, and it was not in BLOCK_AFTER. A `{}` right after it was read as an
// OBJECT, its `}` left 'operand', the following `/` was read as DIVISION — and
// when a LATER `/` re-opened a regex that TERMINATED before EOF, the file stayed
// NON-opaque while a real `await import(spec)` between the slashes was blanked:
// a dropped consumer with no fail-closed signal (a false green), the one shape
// the rework16 EOF backstop does NOT catch.

const R17_CASE_BODY = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "const spec = '../packages/sample/value.mjs';",
  'let seen = null;',
  'switch (1) {',
  '  case 1:',
  '    {}',
  '    /a+/;',
  '    seen = (await import(spec)).n;', // the ONLY consumer of the changed module
  '    /b/;',                          // terminates the phantom regex BEFORE EOF
  '    break;',
  '  default:',
  '    break;',
  '}',
  "test('case-clause consumer', () => { assert.equal(seen, 1); });",
  '',
].join('\n');

test('rework17(F1b): a `:` clause colon restores STATEMENT position — the phantom regex can never blank a real import', () => {
  // The reviewer's shape, verbatim: the phantom regex is TERMINATED before EOF
  // (`/b/;` follows), so the rework16 EOF backstop cannot save it. PRE-fix the
  // second `/` opened a regex that blanked `await import(spec);` while
  // `hasOpaqueDynamicImport` stayed FALSE — a dropped consumer, no uncertainty.
  const repro = [
    'switch (x) { case 1:',
    '{}',
    '/a+/',
    'await import(spec);',
    '/b/;',
    'const q = 1;',
    '}',
    '',
  ].join('\n');
  assert.equal(hasOpaqueDynamicImport(repro), true,
    'the non-literal import behind the case clause must be READ, never blanked by a phantom regex');
  assert.match(stripCommentsAndStrings(repro), /await import\(spec\)/,
    'the statement after the case clause really survives in the code view');
  // Every STATEMENT-position `:` shape, not just `case 1:`.
  for (const [label, src] of [
    ['case with a literal label', "switch (x) { case 'a':\n{}\n/a+/\nawait import(spec);\n/b/;\nconst q = 1;\n}\n"],
    ['default', "switch (x) { default:\n{}\n/a+/\nawait import(spec);\n/b/;\nconst q = 1;\n}\n"],
    ['labelled statement', "outer:\n{}\n/a+/\nawait import(spec);\n/b/;\nconst q = 1;\n"],
    ['label inside a block', "if (x) {\nouter:\n{}\n/a+/\nawait import(spec);\n/b/;\n}\n"],
    ['case inside a function body', "function f(x) {\nswitch (x) { case 1:\n{}\n/a+/\nawait import(spec);\n/b/;\n}\n}\n"],
  ]) {
    assert.equal(hasOpaqueDynamicImport(src), true,
      `${label}: a statement-position colon leaves regex position, so the import behind it is read`);
  }
  // CONTROLS — the OTHER two colons are EXPRESSION positions, so a `{` after
  // them is still an OBJECT whose `}` leaves DIVISION and the real edge behind
  // it survives. The fix is context, never a blanket "colon means statement".
  for (const [label, src] of [
    ['ternary of empty objects', "const y = c ? {} : {} / 2;\nimport('./real.mjs');\n"],
    ['ternary of valued objects', "const y = c ? {a: 1} : {b: 2};\nimport('./real.mjs');\n"],
    ['object between `?` and its `:`', "const y = c ? {a: 1} : {} / 2;\nimport('./real.mjs');\n"],
    ['ternary INSIDE a property value', "const o = {a: c ? 1 : 2};\nimport('./real.mjs');\n"],
    ['nested object property colon', "const o = {a: {b: 1}};\nimport('./real.mjs');\n"],
    ['regex as a property value', "const o = {a: /x/};\nimport('./real.mjs');\n"],
    ['optional chaining + nullish are not ternaries', "const y = (a?.b ?? {}) / 2;\nimport('./real.mjs');\n"],
    ['function as a ternary alternative', "const f = a ? function () {} : function () {};\nimport('./real.mjs');\n"],
  ]) {
    assert.deepEqual(parseImportSpecs(src), ['./real.mjs'],
      `${label}: an expression-position colon keeps DIVISION/OBJECT, so the real edge stays (${src.split('\n')[0]})`);
    assert.equal(hasOpaqueDynamicImport(src), false, `${label}: proven, not opaque`);
  }
});

test('rework17(F1b): the case-clause consumer is never dropped — the reduced selection FAILS like the full set', async () => {
  const { dir, base } = mkOpaqueConsumerRepo({ dynamicBody: R17_CASE_BODY });
  await assertFixturePassesBeforeTheChange(dir); // GREEN before the dependency change
  fs.writeFileSync(path.join(dir, 'packages', 'sample', 'value.mjs'), 'export const n = 2;\n');
  const p = planOf(dir, base);
  assert.equal(p.mode, 'affected', 'the case-clause consumer is a real consumer — no dropped file, no blanket FULL');
  assertOpaqueConsumerIsCovered(p);
  assert.match(p.reasons['tests/dynamic.test.mjs'], /^opaque-importer:/,
    'the selection reason names the opaque importer instead of dropping it silently');
  await assertReducedSelectionIsNotFalselyGreen(dir, p);
});
// ==== END PR-285 ROUND-17 ====

// ==== PR-285 ROUND-18 ====
// Three residuals of the SAME class (a dropped consumer with NO fail-closed
// signal — the false green the whole gate exists to prevent), all in the one
// selector:
//   F1b   a FunctionDeclaration after a STATEMENT-position `:` (`case 1:`) was
//         still read as an EXPRESSION, so its body `}` left DIVISION and the
//         next `/` opened a phantom regex over the real `await import(spec)`;
//   CJS   `require(<non-literal>)` produced no edge AND no opacity — the CJS
//         consumer was dropped silently;
//   ALIAS a `#`-prefixed subpath import (package.json `imports`) was treated as
//         EXTERNAL — its in-repo target was never an edge either.

const R18_CASE_FN_BODY = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "const spec = '../packages/sample/value.mjs';",
  'let seen;',
  'switch (1) {',
  '  case 1: function f() {}',
  '    /a+/;',
  '    seen = (await import(spec)).n;', // the ONLY consumer of the changed module
  '    /b/;',                           // terminates the phantom regex BEFORE EOF
  '    break;',
  '}',
  "test('case-clause function-declaration consumer', () => { assert.equal(seen, 1); });",
  '',
].join('\n');

test('rework18(F1b): a FunctionDeclaration after a STATEMENT-position `:` keeps statement position', () => {
  // The reviewer's shape, verbatim: PRE-fix the `function` after `case 1:` was
  // classified as an EXPRESSION (':' was an expression boundary), its body `}`
  // left 'operand', the following `/a+/` was read as DIVISION — and the later
  // `/b/` re-opened a regex that blanked `await import(spec);` while
  // `hasOpaqueDynamicImport` stayed FALSE. Terminated before EOF, so the
  // rework16 EOF backstop cannot catch it.
  const repro = [
    'switch (x) { case 1: function f() {}',
    '/a+/',
    'await import(spec);',
    '/b/;',
    'const q = 1;',
    '}',
    '',
  ].join('\n');
  assert.equal(hasOpaqueDynamicImport(repro), true,
    'a function DECLARATION in a case clause leaves statement position, so the import behind it is READ');
  assert.match(stripCommentsAndStrings(repro), /await import\(spec\)/,
    'the statement after the function declaration really survives in the code view');
  // Every STATEMENT-position colon that can carry a FunctionDeclaration.
  for (const [label, src] of [
    ['case with a numeric label', "switch (x) { case 1: function f() {}\n/a+/\nawait import(spec);\n/b/;\nconst q = 1;\n}\n"],
    ['case with a string label', "switch (x) { case 'a': function f() {}\n/a+/\nawait import(spec);\n/b/;\nconst q = 1;\n}\n"],
    ['default clause', "switch (x) { default: function f() {}\n/a+/\nawait import(spec);\n/b/;\nconst q = 1;\n}\n"],
    ['case clause inside a function body', "function g(x) {\nswitch (x) { case 1: function f() {}\n/a+/\nawait import(spec);\n/b/;\n}\n}\n"],
  ]) {
    assert.equal(hasOpaqueDynamicImport(src), true,
      `${label}: a statement-position colon restores statement position for a function DECLARATION too`);
  }
  // CONTROLS — the fix distinguishes the CONTEXT, never "colon == declaration":
  // after an EXPRESSION-position colon a `function` is an EXPRESSION whose body
  // `}` leaves DIVISION, so the real edge behind it must stay proven.
  for (const [label, src] of [
    ['object property value', "const o = {a: function () {}};\nimport('./real.mjs');\n"],
    ['ternary alternative', "const f = a ? function () {} : function () {};\nimport('./real.mjs');\n"],
    ['template interpolation head', 'const s = `${ function () {} }`;\nimport(\'./real.mjs\');\n'],
  ]) {
    assert.deepEqual(parseImportSpecs(src), ['./real.mjs'],
      `${label}: an expression-position function body keeps DIVISION, so the real edge stays`);
    assert.equal(hasOpaqueDynamicImport(src), false, `${label}: proven, not opaque`);
  }
});

test('rework18(F1b): the case-clause FUNCTION-DECLARATION consumer is never dropped — the reduced selection FAILS like the full set', async () => {
  const { dir, base } = mkOpaqueConsumerRepo({ dynamicBody: R18_CASE_FN_BODY });
  await assertFixturePassesBeforeTheChange(dir); // GREEN before the dependency change
  fs.writeFileSync(path.join(dir, 'packages', 'sample', 'value.mjs'), 'export const n = 2;\n');
  const p = planOf(dir, base);
  assert.equal(p.mode, 'affected', 'the case-clause consumer is a real consumer — no dropped file, no blanket FULL');
  assertOpaqueConsumerIsCovered(p);
  assert.match(p.reasons['tests/dynamic.test.mjs'], /^opaque-importer:/,
    'the selection reason names the opaque importer instead of dropping it silently');
  await assertReducedSelectionIsNotFalselyGreen(dir, p);
});

// ONE fixture for the two remaining residuals: a changed source with a PROVEN
// static consumer AND a consumer the detector must not drop. The proven edge
// keeps the plan in AFFECTED mode either way, so the dropped file shows up as
// "selected = the static consumer only" — green selected, red full fixture.
function mkR18ConsumerRepo({ sourceRel, source, staticBody, dynamicBody, extraFiles = [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-r18-'));
  TMP_FIXTURES.add(dir);
  git(dir, ['init']);
  const w = (rel, content) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  };
  w(sourceRel, source);
  for (const [rel, content] of extraFiles) w(rel, content);
  w('tests/static.test.mjs', staticBody);
  w('tests/dynamic.test.mjs', dynamicBody);
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
  git(dir, ['-c', 'user.email=r18@t', '-c', 'user.name=r18', 'commit', '-m', 'base']);
  return { dir, base: git(dir, ['rev-parse', 'HEAD']) };
}

const R18_CJS_REL = 'packages/cjs/value.cjs';
const R18_CJS_STATIC_BODY = [
  "import test from 'node:test';",
  "import { createRequire } from 'node:module';",
  'const require = createRequire(import.meta.url);',
  "const { n } = require('../packages/cjs/value.cjs');",
  "test('static consumer', () => { if (typeof n !== 'number') throw new Error('n'); });",
  '',
].join('\n');
const R18_CJS_DYNAMIC_BODY = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { createRequire } from 'node:module';",
  'const require = createRequire(import.meta.url);',
  "const spec = '../packages/cjs/value.cjs';",
  'const { n } = require(spec);', // non-literal: NO edge is derivable — fail closed
  "test('opaque cjs consumer', () => { assert.equal(n, 1); });",
  '',
].join('\n');

test('rework18(NEW-CJS): a require() whose argument is not a plain literal is OPAQUE — never a silently dropped CJS consumer', () => {
  // A COMPLETE literal keeps its proof AND its CJS path semantics.
  assert.equal(hasOpaqueDynamicImport("const m = require('./x.cjs');\n"), false,
    'a literal require is a proven edge, not an uncertainty');
  assert.deepEqual(parseImportSpecs("const m = require('./x.cjs');\n"), ['./x.cjs'],
    'the literal require edge is unchanged');
  // Every other argument shape: an edge we cannot write down => OPAQUE.
  for (const [label, src] of [
    ['an identifier', "const spec = './x.cjs';\nconst m = require(spec);\n"],
    ['a concatenation', "const m = require('./x' + '.cjs');\n"],
    ['a template literal', 'const m = require(`./x.cjs`);\n'],
    ['a call', 'const m = require(getSpec());\n'],
    ['an unterminated literal', "const m = require('./x.cjs';\n"],
  ]) {
    assert.equal(hasOpaqueDynamicImport(src), true, `${label}: require() proves no complete edge — fail closed`);
  }
  // A comment inside the call is blanked to WHITESPACE by the code view, so the
  // literal behind it is still a complete argument — proven, not opaque.
  assert.equal(hasOpaqueDynamicImport("const m = require(/* keep */ './x.cjs');\n"), false,
    'a comment before the literal does not turn a proven require into an uncertainty');
  assert.deepEqual(parseImportSpecs("const m = require(/* keep */ './x.cjs');\n"), ['./x.cjs'],
    'the literal behind a blanked comment is still extracted');
  // CONTROLS — prose and non-calls are untouched.
  assert.equal(hasOpaqueDynamicImport('// require(spec) in prose\n'), false, 'prose is never a call site');
  assert.equal(hasOpaqueDynamicImport("const s = 'require(spec)';\n"), false, 'a string is never a call site');
  assert.equal(hasOpaqueDynamicImport('const m = createRequire(import.meta.url);\n'), false,
    'createRequire is not a require() call');
  assert.equal(hasOpaqueDynamicImport("const m = obj.require('./x.cjs');\n"), false,
    'a complete literal argument stays proven even behind a member access');
});

test('rework18(NEW-CJS): the require(spec) consumer is never dropped — the reduced selection FAILS like the full set', async () => {
  const { dir, base } = mkR18ConsumerRepo({
    sourceRel: R18_CJS_REL,
    source: 'module.exports = { n: 1 };\n',
    staticBody: R18_CJS_STATIC_BODY,
    dynamicBody: R18_CJS_DYNAMIC_BODY,
  });
  await assertFixturePassesBeforeTheChange(dir); // GREEN before the dependency change
  fs.writeFileSync(path.join(dir, 'packages', 'cjs', 'value.cjs'), 'module.exports = { n: 2 };\n');
  const p = planOf(dir, base);
  assert.equal(p.mode, 'affected', 'the proven literal require edge keeps the plan AFFECTED');
  assert.ok(p.files.includes('tests/static.test.mjs'), 'the proven static consumer is selected');
  assert.ok(p.files.includes('tests/dynamic.test.mjs'),
    'the non-literal require() consumer is selected (fail-closed) — the pre-fix selector dropped it and certified a false green');
  assert.equal(p.files.includes('tests/plain.test.mjs'), false, 'an unrelated test is not swept in');
  assert.match(p.reasons['tests/dynamic.test.mjs'], /^opaque-importer:/,
    'the selection reason names the opaque importer');
  await assertReducedSelectionIsNotFalselyGreen(dir, p);
});

test('rework18(NEW-ALIAS): a `#`-prefixed subpath import resolves through package.json `imports` — proven, or OPAQUE', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-alias-'));
  TMP_FIXTURES.add(dir);
  const w = (rel, content) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  };
  w('package.json', `${JSON.stringify({
    name: 'alias-fixture',
    private: true,
    type: 'module',
    imports: { '#value': './packages/value.cjs', '#deep/*': './packages/deep/*.mjs' },
  }, null, 2)}\n`);
  w('packages/value.cjs', 'module.exports = { n: 1 };\n');
  w('packages/deep/impl.mjs', 'export const n = 1;\n');
  // A NESTED package.json owns the map for the files under it (Node's rule).
  w('sub/package.json', `${JSON.stringify({ name: 'sub', private: true, imports: { '#local': './local.mjs' } }, null, 2)}\n`);
  w('sub/local.mjs', 'export const n = 1;\n');
  w('tests/exact.test.mjs', "import { n } from '#value';\nexport const got = n;\n");
  w('tests/pattern.test.mjs', "import { n } from '#deep/impl';\nexport const got = n;\n");
  w('sub/use.test.mjs', "import { n } from '#local';\nexport const got = n;\n");
  // CONTROLS: an unprovable `#` specifier fails CLOSED; a bare specifier is still
  // neither an edge nor an uncertainty.
  w('tests/unproven.test.mjs', "import { n } from '#missing';\nexport const got = n;\n");
  w('tests/bare.test.mjs', "import 'node:path';\n");

  const g = buildImportGraph(dir);
  const deps = (f) => [...(g.dependents.get(f) || [])];
  assert.ok(deps('packages/value.cjs').includes('tests/exact.test.mjs'),
    `the exact '#value' subpath import must be an edge to the file Node loads (${JSON.stringify(deps('packages/value.cjs'))})`);
  assert.ok(deps('packages/deep/impl.mjs').includes('tests/pattern.test.mjs'),
    'the `#deep/*` pattern form is resolved too');
  assert.ok(deps('sub/local.mjs').includes('sub/use.test.mjs'),
    'the NEAREST package.json owns the subpath map');
  assert.equal(g.opaque.has('tests/exact.test.mjs'), false, 'a PROVEN subpath import is an edge, not an uncertainty');
  assert.equal(g.opaque.has('tests/pattern.test.mjs'), false, 'a PROVEN pattern subpath import is an edge');
  assert.equal(g.opaque.has('sub/use.test.mjs'), false, 'a PROVEN nested-package subpath import is an edge');
  assert.equal(g.opaque.has('tests/unproven.test.mjs'), true,
    'a `#` specifier no package.json can prove must fail CLOSED, never be read as external');
  assert.equal(g.opaque.has('tests/bare.test.mjs'), false,
    'a bare/external specifier is still neither an edge nor an uncertainty');
});

const R18_ALIAS_PKG = `${JSON.stringify({
  name: 'alias-fixture',
  private: true,
  type: 'module',
  imports: { '#value': './packages/value.mjs' },
}, null, 2)}\n`;
const R18_ALIAS_STATIC_BODY = [
  "import test from 'node:test';",
  "import { n } from '../packages/value.mjs';",
  "test('static consumer', () => { if (typeof n !== 'number') throw new Error('n'); });",
  '',
].join('\n');
const R18_ALIAS_DYNAMIC_BODY = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { n } from '#value';", // in-repo source behind a subpath import
  "test('subpath-import consumer', () => { assert.equal(n, 1); });",
  '',
].join('\n');

test('rework18(NEW-ALIAS): the `#value` consumer is never dropped — the reduced selection FAILS like the full set', async () => {
  const { dir, base } = mkR18ConsumerRepo({
    sourceRel: 'packages/value.mjs',
    source: 'export const n = 1;\n',
    staticBody: R18_ALIAS_STATIC_BODY,
    dynamicBody: R18_ALIAS_DYNAMIC_BODY,
    extraFiles: [['package.json', R18_ALIAS_PKG]],
  });
  await assertFixturePassesBeforeTheChange(dir); // GREEN before the dependency change
  fs.writeFileSync(path.join(dir, 'packages', 'value.mjs'), 'export const n = 2;\n');
  const p = planOf(dir, base);
  assert.equal(p.mode, 'affected', 'the proven static edge keeps the plan AFFECTED');
  assert.ok(p.files.includes('tests/static.test.mjs'), 'the static consumer is selected');
  assert.ok(p.files.includes('tests/dynamic.test.mjs'),
    'the `#value` consumer is an in-repo consumer — the pre-fix resolver read it as external and dropped it');
  assert.equal(p.files.includes('tests/plain.test.mjs'), false, 'an unrelated test is not swept in');
  await assertReducedSelectionIsNotFalselyGreen(dir, p);
});
// ==== END PR-285 ROUND-18 ====

// ==== PR-285 ROUND-19 ====
// (rework19 NEW-ALIAS residual) A package `imports` map must be resolved the way
// NODE resolves it. Measured on Node v22.23.2 in this environment:
//   * `#x/special/value` matches the MOST SPECIFIC key even when the broader
//     `#x/*` is listed FIRST (=> the specific target is what Node loads);
//   * a `?query` / `#fragment` inside the TARGET is not part of the file name;
//   * EVERY `*` in the target is substituted, not only the first one.
// Certifying the wrong edge drops a real consumer while its importer stays
// NON-opaque: the exact false-green class this PR exists to close.

const R19_ALIAS_SPECIFICITY_PKG = `${JSON.stringify({
  name: 'alias-fixture',
  private: true,
  type: 'module',
  imports: { '#x/*': './packages/broad/*.mjs', '#x/special/*': './packages/special/*.mjs' },
}, null, 2)}\n`;

const R19_ALIAS_STATIC_BODY = [
  "import test from 'node:test';",
  "import { n } from '../packages/special/value.mjs';",
  "test('static consumer', () => { if (typeof n !== 'number') throw new Error('n'); });",
  '',
].join('\n');
const R19_ALIAS_SPECIFIC_DYNAMIC_BODY = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { n } from '#x/special/value';",
  "test('specific-pattern consumer', () => { assert.equal(n, 1); });",
  '',
].join('\n');

test('rework19(NEW-ALIAS): the MOST SPECIFIC `#` pattern wins even when a broader key is listed first', async () => {
  const { dir, base } = mkR18ConsumerRepo({
    sourceRel: 'packages/special/value.mjs',
    source: 'export const n = 1;\n',
    staticBody: R19_ALIAS_STATIC_BODY,
    dynamicBody: R19_ALIAS_SPECIFIC_DYNAMIC_BODY,
    extraFiles: [
      ['package.json', R19_ALIAS_SPECIFICITY_PKG],
      // The BROAD target EXISTS, so the pre-fix resolver certified a real-looking
      // edge to the WRONG file instead of failing closed.
      ['packages/broad/special/value.mjs', 'export const n = 99;\n'],
    ],
  });
  await assertFixturePassesBeforeTheChange(dir); // GREEN before the dependency change
  fs.writeFileSync(path.join(dir, 'packages', 'special', 'value.mjs'), 'export const n = 2;\n');
  const p = planOf(dir, base);
  assert.equal(p.mode, 'affected', 'the proven static edge keeps the plan AFFECTED');
  assert.ok(p.files.includes('tests/static.test.mjs'), 'the static consumer is selected');
  assert.ok(p.files.includes('tests/dynamic.test.mjs'),
    'the specific-pattern consumer is an in-repo consumer — the pre-fix resolver followed the BROAD key listed first and dropped it');
  assert.equal(p.files.includes('tests/plain.test.mjs'), false, 'an unrelated test is not swept in');
  await assertReducedSelectionIsNotFalselyGreen(dir, p);
});

const R19_ALIAS_URL_PKG = `${JSON.stringify({
  name: 'alias-fixture',
  private: true,
  type: 'module',
  imports: { '#q': './packages/q/value.mjs?probe=1' },
}, null, 2)}\n`;
const R19_ALIAS_Q_STATIC_BODY = [
  "import test from 'node:test';",
  "import { n } from '../packages/q/value.mjs';",
  "test('static consumer', () => { if (typeof n !== 'number') throw new Error('n'); });",
  '',
].join('\n');
const R19_ALIAS_Q_DYNAMIC_BODY = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { n } from '#q';",
  "test('query-target consumer', () => { assert.equal(n, 1); });",
  '',
].join('\n');

test('rework19(NEW-ALIAS): a `?query` in the target is not a file name — the consumer is never dropped', async () => {
  const { dir, base } = mkR18ConsumerRepo({
    sourceRel: 'packages/q/value.mjs',
    source: 'export const n = 1;\n',
    staticBody: R19_ALIAS_Q_STATIC_BODY,
    dynamicBody: R19_ALIAS_Q_DYNAMIC_BODY,
    extraFiles: [['package.json', R19_ALIAS_URL_PKG]],
  });
  await assertFixturePassesBeforeTheChange(dir);
  fs.writeFileSync(path.join(dir, 'packages', 'q', 'value.mjs'), 'export const n = 2;\n');
  const p = planOf(dir, base);
  assert.equal(p.mode, 'affected', 'the proven static edge keeps the plan AFFECTED');
  assert.ok(p.files.includes('tests/dynamic.test.mjs'),
    'the `#q` consumer resolves to the file Node loads — the pre-fix resolver kept `?probe=1` in the path and dropped it');
  await assertReducedSelectionIsNotFalselyGreen(dir, p);
});

const R19_ALIAS_MULTI_PKG = `${JSON.stringify({
  name: 'alias-fixture',
  private: true,
  type: 'module',
  imports: { '#m/*': './packages/m/*/x-*.mjs' },
}, null, 2)}\n`;
const R19_ALIAS_M_STATIC_BODY = [
  "import test from 'node:test';",
  "import { n } from '../packages/m/foo/x-foo.mjs';",
  "test('static consumer', () => { if (typeof n !== 'number') throw new Error('n'); });",
  '',
].join('\n');
const R19_ALIAS_M_DYNAMIC_BODY = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { n } from '#m/foo';",
  "test('repeated-wildcard consumer', () => { assert.equal(n, 1); });",
  '',
].join('\n');

test('rework19(NEW-ALIAS): EVERY `*` in the target is substituted — the consumer is never dropped', async () => {
  const { dir, base } = mkR18ConsumerRepo({
    sourceRel: 'packages/m/foo/x-foo.mjs',
    source: 'export const n = 1;\n',
    staticBody: R19_ALIAS_M_STATIC_BODY,
    dynamicBody: R19_ALIAS_M_DYNAMIC_BODY,
    extraFiles: [['package.json', R19_ALIAS_MULTI_PKG]],
  });
  await assertFixturePassesBeforeTheChange(dir);
  fs.writeFileSync(path.join(dir, 'packages', 'm', 'foo', 'x-foo.mjs'), 'export const n = 2;\n');
  const p = planOf(dir, base);
  assert.equal(p.mode, 'affected', 'the proven static edge keeps the plan AFFECTED');
  assert.ok(p.files.includes('tests/dynamic.test.mjs'),
    'the repeated-wildcard consumer resolves to `packages/m/foo/x-foo.mjs` — the pre-fix resolver left the second `*` literal and dropped it');
  await assertReducedSelectionIsNotFalselyGreen(dir, p);
});

test('rework19(NEW-ALIAS): specificity, URL targets and repeated wildcards mirror NODE resolution in the graph', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-alias19-'));
  TMP_FIXTURES.add(dir);
  const w = (rel, content) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  };
  w('package.json', `${JSON.stringify({
    name: 'alias19',
    private: true,
    type: 'module',
    imports: {
      '#x/*': './packages/broad/*.mjs',
      '#x/special/*': './packages/special/*.mjs',
      '#q': './packages/q/value.mjs?probe=1',
      '#f': './packages/f/value.mjs#frag',
      '#m/*': './packages/m/*/x-*.mjs',
      '#abs': 'pkg/whatever.mjs',
      // (rework19) A matching pattern whose target needs NO substitution, and one
      // whose target is a CONDITIONS object — Node resolves BOTH through the MOST
      // SPECIFIC key; it never falls back to a broader key.
      '#w/*': './packages/broad/w.mjs',
      '#w/special/*': './packages/fixed-w.mjs',
      '#v/*': './packages/broad/v.mjs',
      '#v/special/*': { default: './packages/special-v.mjs' },
      // (rework19b) A control character can reach a target through a `\t`/`\n`/
      // `\r`/`\u0009` ESCAPE in package.json. The URL parser strips those and trims
      // a TRAILING C0/space (all measured), but a LEADING one fails the loader's
      // own `./` test before any URL processing; `%09`/`%20` name a FILE with that
      // byte and are never the stripped path.
      '#wst': './packages/ws/va\tlue.mjs',
      '#wss': './packages/ws/value.mjs ',
      '#wsp': './packages/ws/va%09lue.mjs',
      '#wsl': ' ./packages/ws/value.mjs',
      '#wbs': './packages/ws/nested\\lue.mjs',
      // (rework19c) The URL parser converts its input to a USVString FIRST: an
      // UNPAIRED surrogate becomes U+FFFD while a VALID pair is untouched (both
      // measured on Node v22.23.2); a PERCENT-ENCODED surrogate is refused by the
      // loader outright (`URI malformed`), so it is never a path.
      '#wsur': './packages/ws/\uD800.mjs',
      '#wsurmid': './packages/ws/va\uD800lue.mjs',
      '#wpair': './packages/ws/\uD83D\uDE00.mjs',
      '#wpctsur': './packages/ws/va%ED%A0%80lue.mjs',
    },
  }, null, 2)}\n`);
  w('packages/broad/special/value.mjs', 'export const n = 99;\n');
  w('packages/special/value.mjs', 'export const n = 1;\n');
  w('packages/q/value.mjs', 'export const n = 1;\n');
  w('packages/f/value.mjs', 'export const n = 1;\n');
  w('packages/m/foo/x-foo.mjs', 'export const n = 1;\n');
  w('packages/broad/w.mjs', 'export const n = 99;\n');
  w('packages/fixed-w.mjs', 'export const n = 1;\n');
  w('packages/broad/v.mjs', 'export const n = 99;\n');
  w('packages/special-v.mjs', 'export const n = 1;\n');
  w('packages/ws/value.mjs', 'export const n = 1;\n');
  w('packages/ws/nested/lue.mjs', 'export const n = 1;\n');
  w('packages/ws/\uFFFD.mjs', 'export const n = 1;\n');
  w('packages/ws/va\uFFFDlue.mjs', 'export const n = 1;\n');
  w('packages/ws/\uD83D\uDE00.mjs', 'export const n = 1;\n');
  w('tests/va\uFFFDlue.mjs', 'export const n = 1;\n');
  w('tests/specific.test.mjs', "import { n } from '#x/special/value';\nexport const got = n;\n");
  w('tests/query.test.mjs', "import { n } from '#q';\nexport const got = n;\n");
  w('tests/fragment.test.mjs', "import { n } from '#f';\nexport const got = n;\n");
  w('tests/multi.test.mjs', "import { n } from '#m/foo';\nexport const got = n;\n");
  w('tests/fixed-target.test.mjs', "import { n } from '#w/special/anything';\nexport const got = n;\n");
  w('tests/cond-target.test.mjs', "import { n } from '#v/special/value';\nexport const got = n;\n");
  w('tests/abs.test.mjs', "import { n } from '#abs';\nexport const got = n;\n");
  w('tests/ws-tab.test.mjs', "import { n } from '#wst';\nexport const got = n;\n");
  w('tests/ws-space.test.mjs', "import { n } from '#wss';\nexport const got = n;\n");
  w('tests/ws-pct.test.mjs', "import { n } from '#wsp';\nexport const got = n;\n");
  w('tests/ws-lead.test.mjs', "import { n } from '#wsl';\nexport const got = n;\n");
  w('tests/ws-bs.test.mjs', "import { n } from '#wbs';\nexport const got = n;\n");
  w('tests/ws-sur.test.mjs', "import { n } from '#wsur';\nexport const got = n;\n");
  w('tests/ws-surmid.test.mjs', "import { n } from '#wsurmid';\nexport const got = n;\n");
  w('tests/ws-pair.test.mjs', "import { n } from '#wpair';\nexport const got = n;\n");
  w('tests/ws-pctsur.test.mjs', "import { n } from '#wpctsur';\nexport const got = n;\n");
  w('tests/ws-relsur.test.mjs', "import { n } from './va\\uD800lue.mjs';\nexport const got = n;\n");

  const g = buildImportGraph(dir);
  const deps = (f) => [...(g.dependents.get(f) || [])];
  assert.ok(deps('packages/special/value.mjs').includes('tests/specific.test.mjs'),
    `the MOST SPECIFIC pattern must be the edge Node loads (${JSON.stringify(deps('packages/special/value.mjs'))})`);
  assert.equal(deps('packages/broad/special/value.mjs').includes('tests/specific.test.mjs'), false,
    'the broader key listed first must never steal the match Node gives the specific key');
  assert.ok(deps('packages/q/value.mjs').includes('tests/query.test.mjs'),
    '`?probe=1` in the target is a URL query, not part of the file name');
  assert.ok(deps('packages/f/value.mjs').includes('tests/fragment.test.mjs'),
    '`#frag` in the target is a URL fragment, not part of the file name');
  assert.ok(deps('packages/m/foo/x-foo.mjs').includes('tests/multi.test.mjs'),
    'EVERY `*` in the target is substituted (Node substitutes all of them)');
  assert.equal(g.opaque.has('tests/specific.test.mjs'), false, 'a PROVEN specific-pattern match is an edge');
  assert.ok(deps('packages/fixed-w.mjs').includes('tests/fixed-target.test.mjs'),
    'a matching pattern whose target needs NO `*` resolves that target VERBATIM — the loader loads it, so it is the edge');
  assert.equal(deps('packages/broad/w.mjs').includes('tests/fixed-target.test.mjs'), false,
    'the broader key must never be used once the more specific key has matched');
  assert.equal(g.opaque.has('tests/cond-target.test.mjs'), true,
    'a CONDITIONS-object target cannot be proven here: fail CLOSED — never fall back to the broader key');
  assert.equal(deps('packages/broad/v.mjs').includes('tests/cond-target.test.mjs'), false,
    'the broader key must never be used for an unprovable, more specific key');
  assert.equal(g.opaque.has('tests/abs.test.mjs'), true,
    'a NON-RELATIVE (bare/absolute) target can never be proven here: fail CLOSED');
  assert.ok(deps('packages/ws/value.mjs').includes('tests/ws-tab.test.mjs'),
    'a RAW control character in the target is STRIPPED by the URL parser (`./p/va\\tlue.mjs` loads `./p/value.mjs` — measured), so that file is the edge the loader creates');
  assert.ok(deps('packages/ws/value.mjs').includes('tests/ws-space.test.mjs'),
    'a TRAILING C0/space in the target is TRIMMED by the URL parser (`./p/value.mjs ` loads `./p/value.mjs` — measured)');
  assert.equal(g.opaque.has('tests/ws-tab.test.mjs'), false,
    'the stripped target is PROVEN, not opaque — the consumer must not be widened either');
  assert.equal(deps('packages/ws/value.mjs').includes('tests/ws-pct.test.mjs'), false,
    'a PERCENT-ENCODED control byte (`%09`) names a FILE with that byte and must never be normalized into the stripped path');
  assert.equal(deps('packages/ws/value.mjs').includes('tests/ws-lead.test.mjs'), false,
    'a LEADING control character fails the loader own `./` test before any URL processing (measured ERR_MODULE_NOT_FOUND): it must never be trimmed into an edge');
  assert.equal(g.opaque.has('tests/ws-lead.test.mjs'), true,
    'and such a target fails CLOSED — the importer is OPAQUE, never a silently dropped consumer');
  assert.ok(deps('packages/ws/nested/lue.mjs').includes('tests/ws-bs.test.mjs'),
    'a BACKSLASH in the target is a URL path separator for `file:` (measured: `./p/va\\\\lue.mjs` loads `./p/va/lue.mjs`) — mirrored like the relative-ESM branch, not refused');
  assert.equal(g.opaque.has('tests/ws-bs.test.mjs'), false, 'the backslash target is PROVEN, not opaque');
  assert.ok(deps('packages/ws/\uFFFD.mjs').includes('tests/ws-sur.test.mjs'),
    'an UNPAIRED surrogate in the target becomes U+FFFD in the URL parser (measured: `./p/\\ud800.mjs` loads `./p/\\uFFFD.mjs`), so the U+FFFD file is the edge the loader creates');
  assert.equal(g.opaque.has('tests/ws-sur.test.mjs'), false,
    'the USV-converted target is PROVEN, not opaque — the consumer must not be widened either');
  assert.ok(deps('packages/ws/va\uFFFDlue.mjs').includes('tests/ws-surmid.test.mjs'),
    'the surrogate conversion happens ANYWHERE in the path (measured), not only at its end');
  assert.ok(deps('packages/ws/\uD83D\uDE00.mjs').includes('tests/ws-pair.test.mjs'),
    'a VALID surrogate PAIR is untouched by the conversion (measured: the loader loads the astral file)');
  assert.equal(deps('packages/ws/va\uFFFDlue.mjs').includes('tests/ws-pctsur.test.mjs'), false,
    'a PERCENT-ENCODED surrogate is REFUSED by the loader (measured `URI malformed`): it must never become an edge');
  assert.equal(g.opaque.has('tests/ws-pctsur.test.mjs'), true,
    'and that refused shape fails CLOSED — OPAQUE, never a silently dropped consumer');
  assert.ok(deps('tests/va\uFFFDlue.mjs').includes('tests/ws-relsur.test.mjs'),
    'a RELATIVE ESM specifier is URL-resolved too (measured), so it gets the SAME USV conversion, never a raw-surrogate key');
});

// ==== PR-285 ROUND-19b ====
// (rework19b NEW-ALIAS residual) A control character inside an `imports` TARGET is
// not part of the path the loader uses: the URL parser strips ASCII tab/LF/CR and
// trims a trailing C0/space. Resolving the raw string instead certifies an edge to
// a path that does not exist, so the real consumer is dropped while the importer
// stays NON-opaque — the same false-green class, reached through a `\t` escape in
// package.json. Measured on Node v22.23.2 in this environment.

const R19B_WS_PKG = `${JSON.stringify({
  name: 'alias-fixture',
  private: true,
  type: 'module',
  // JSON.stringify escapes the TAB as `\t`; after parsing, the target really does
  // contain a raw control character while the loader still loads `value.mjs`.
  imports: { '#ws': './packages/ws/va\tlue.mjs' },
}, null, 2)}\n`;

const R19B_WS_STATIC_BODY = [
  "import test from 'node:test';",
  "import { n } from '../packages/ws/value.mjs';",
  "test('static consumer', () => { if (typeof n !== 'number') throw new Error('n'); });",
  '',
].join('\n');
const R19B_WS_DYNAMIC_BODY = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { n } from '#ws';",
  "test('control-character-target consumer', () => { assert.equal(n, 1); });",
  '',
].join('\n');

test('rework19b(NEW-ALIAS): a control character in the target is stripped like the URL parser — the consumer is never dropped', async () => {
  const { dir, base } = mkR18ConsumerRepo({
    sourceRel: 'packages/ws/value.mjs',
    source: 'export const n = 1;\n',
    staticBody: R19B_WS_STATIC_BODY,
    dynamicBody: R19B_WS_DYNAMIC_BODY,
    extraFiles: [['package.json', R19B_WS_PKG]],
  });
  // The fixture only passes if REAL Node resolves `#ws` to `packages/ws/value.mjs`
  // (the stripped path) — that is the file the graph must then key the edge on.
  await assertFixturePassesBeforeTheChange(dir);
  fs.writeFileSync(path.join(dir, 'packages', 'ws', 'value.mjs'), 'export const n = 2;\n');
  const p = planOf(dir, base);
  assert.equal(p.mode, 'affected', 'the proven static edge keeps the plan AFFECTED');
  assert.ok(p.files.includes('tests/dynamic.test.mjs'),
    'the `#ws` consumer resolves to the file the loader loads (`./packages/ws/va\\tlue.mjs` -> `./packages/ws/value.mjs`) — the raw-string resolver certified a path that does not exist and dropped it');
  await assertReducedSelectionIsNotFalselyGreen(dir, p);
});

// ==== PR-285 ROUND-19c ====
// (rework19c NEW-ALIAS residual) The round-19b re-review found two things still open in
// this class: (a) LF / CR / trailing space had only GRAPH-unit coverage — the required
// real-Node fixtures existed for TAB alone; (b) the URL parser's USVString conversion was
// not modelled at all: an UNPAIRED surrogate becomes U+FFFD, a VALID pair is untouched,
// and a PERCENT-ENCODED surrogate is refused outright. All measured on Node v22.23.2 in
// this environment (`./p/va\ud800lue.mjs` really loads `./p/va\uFFFDlue.mjs`).

const R19C_SHAPES = [
  { id: 'LF', target: './packages/ws/va\nlue.mjs', loaded: 'packages/ws/value.mjs' },
  { id: 'CR', target: './packages/ws/va\rlue.mjs', loaded: 'packages/ws/value.mjs' },
  { id: 'trailing space', target: './packages/ws/value.mjs ', loaded: 'packages/ws/value.mjs' },
  { id: 'lone surrogate', target: './packages/ws/va\uD800lue.mjs', loaded: 'packages/ws/va\uFFFDlue.mjs' },
];

const r19cStaticBody = (loadedRel) => [
  "import test from 'node:test';",
  `import { n } from '../${loadedRel}';`,
  "test('static consumer', () => { if (typeof n !== 'number') throw new Error('n'); });",
  '',
].join('\n');

test('rework19c(NEW-ALIAS): every URL-exact target shape (LF/CR/trailing space/lone surrogate) keeps the consumer on the file REAL Node loads', async () => {
  for (const shape of R19C_SHAPES) {
    const pkg = `${JSON.stringify({
      name: 'alias-fixture',
      private: true,
      type: 'module',
      imports: { '#ws': shape.target },
    }, null, 2)}\n`;
    const { dir, base } = mkR18ConsumerRepo({
      sourceRel: shape.loaded,
      source: 'export const n = 1;\n',
      staticBody: r19cStaticBody(shape.loaded),
      dynamicBody: R19B_WS_DYNAMIC_BODY,
      extraFiles: [['package.json', pkg]],
    });
    // The fixture only passes if REAL Node resolves `#ws` to `shape.loaded` — that is
    // the file the graph must then key the edge on.
    await assertFixturePassesBeforeTheChange(dir);
    fs.writeFileSync(path.join(dir, shape.loaded), 'export const n = 2;\n');
    const p = planOf(dir, base);
    assert.equal(p.mode, 'affected', `[${shape.id}] the proven static edge keeps the plan AFFECTED`);
    assert.ok(p.files.includes('tests/dynamic.test.mjs'),
      `[${shape.id}] the '#ws' consumer must resolve to the file the loader loads (${JSON.stringify(shape.target)} -> ${shape.loaded}); keying the raw target certified a path that does not exist and dropped it`);
    await assertReducedSelectionIsNotFalselyGreen(dir, p);
  }
});

// ==== PR-285 ROUND-19d ====
// (rework19d NEW-ALIAS, operator budget override round 4, NUL item only) A NUL that
// percent-decoding leaves in the target is REFUSED by the loader (measured on Node
// v22.23.2: `./packages/ws/va%00lue.mjs` -> ERR_MODULE_NOT_FOUND, no file loaded at
// all), so it must never become a graph edge. `subpathImportCandidates` only checked
// the RAW target for NUL (:1475) and handed decoded candidates back unchecked - the
// relative-ESM branch already had a post-decode guard (:1587), so this mirrors it.
test('rework19d(NEW-ALIAS): a target whose percent-decoding yields a NUL is refused - OPAQUE, never an unopenable edge', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-nul19d-'));
  TMP_FIXTURES.add(dir);
  const w = (rel, content) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  };
  w('package.json', `${JSON.stringify({
    name: 'nul19d',
    private: true,
    type: 'module',
    imports: { '#nul': './packages/ws/va%00lue.mjs' },
  }, null, 2)}\n`);
  w('packages/ws/value.mjs', 'export const n = 1;\n');
  w('tests/nul.test.mjs', "import { n } from '#nul';\nexport const got = n;\n");
  const g = buildImportGraph(dir);
  const deps = (f) => [...(g.dependents.get(f) || [])];
  const nulKey = [...g.dependents.keys()].filter((k) => k.includes('\0')).map((k) => k.replace(/\0/g, '<NUL>'));
  assert.deepEqual(nulKey, [],
    'a decoded NUL names NO file: never an edge to a name the loader refuses to open');
  assert.equal(deps('packages/ws/value.mjs').includes('tests/nul.test.mjs'), false,
    'the refused shape must not be laundered into an edge on some other existing file either');
  assert.equal(g.opaque.has('tests/nul.test.mjs'), true,
    'the refused shape fails CLOSED like every other unprovable target, not dropped silently');
});

// (rework19d NEW-FS-CASE) On a filesystem PROVEN case-insensitive, a specifier or
// `imports` target whose case differs from the inventory names the REAL file the
// loader loads - spelling a phantom-case key dropped the real consumer while the
// importer stayed non-opaque (reviewer round-19c finding 2). The helper must
// canonicalize an edge ONLY where the OS proves the identity, and mark the importer
// OPAQUE everywhere else, so that seeming probes never fall back to byte-spelled
// keys. Here the case parity IS proven by `fs.realpathSync.native` (the OS answer,
// never a platform guess), so the edge must exist - and on a case-SENSITIVE
// filesystem the same spelling must refuse rather than merge two identities.
test('rework19d(NEW-FS-CASE): OS-proven same-identity case-mismatch keys the exact inventory entry; unproven parity refuses closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-fscase19d-'));
  TMP_FIXTURES.add(dir);
  const w = (rel, content) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  };
  w('package.json', `${JSON.stringify({
    name: 'fscase19d',
    private: true,
    type: 'module',
    imports: { '#case': './PACKAGES/ws/value.mjs', '#exact': './packages/ws/value.mjs' },
  }, null, 2)}\n`);
  w('packages/ws/value.mjs', 'export const n = 1;\n');
  w('tests/case.test.mjs', "import { n } from '#case';\nexport const got = n;\n");
  w('tests/exact.test.mjs', "import { n } from '#exact';\nexport const got = n;\n");
  const g = buildImportGraph(dir);
  const deps = (f) => [...(g.dependents.get(f) || [])];
  // The case-variant spelling of the REAL file is probed by the OS itself - that is
  // the measured semantics of THIS filesystem (no process.platform reading).
  const realExact = fs.realpathSync.native(path.join(dir, 'packages/ws/value.mjs'));
  let realSpelled = null;
  try { realSpelled = fs.realpathSync.native(path.join(dir, 'PACKAGES/ws/value.mjs')); } catch { realSpelled = null; }
  const sameIdentity = realSpelled !== null && realSpelled === realExact;
  if (sameIdentity) {
    // Case-insensitive filesystem, measured right here: the OS opens the SAME file
    // for both spellings. The graph must key the edge on the byte-exact inventory
    // entry (never a phantom-case key that no change can ever hit).
    assert.ok(deps('packages/ws/value.mjs').includes('tests/case.test.mjs'),
      `the OS proves './PACKAGES/ws/value.mjs' and 'packages/ws/value.mjs' are ONE identity; the graph must hold the edge on the exact inventory key, not drop the consumer`);
    assert.equal(g.opaque.has('tests/case.test.mjs'), false, 'a proven same-identity edge is never widened to OPAQUE');
    // A blind case-fold would invent the key 'PACKAGES/ws/value.mjs' (or fold the
    // inventory itself); the graph must know ONE identity, spelled the way the
    // inventory spells it, and no phantom-case keys may survive.
    assert.deepEqual([...g.dependents.keys()].filter((k) => k.toUpperCase() === 'PACKAGES/WS/VALUE.MJS').map((k) => k.toLowerCase()),
      ['packages/ws/value.mjs'],
      'the only key for that identity is the byte-exact inventory spelling - no case-folded phantom key was invented');
  } else {
    // (rework19d round-2 per re-review) The OS REFUSES the spelling with
    // ENOENT: it names NOTHING openable, and the loader refuses it at runtime
    // the same way. Per the contract, this 'absent' shape keeps the LITERAL
    // edge (the delete/rename convention - old-path changes still reach their
    // consumers), never forges an edge onto the differently-cased real file,
    // and is only promoted to OPAQUE when the probe could not answer at all
    // (an error class other than ENOENT), which this fixture cannot produce.
    assert.ok([...(g.dependents.get('PACKAGES/ws/value.mjs') || [])].includes('tests/case.test.mjs'),
      'a spelling the OS refuses with ENOENT keeps its LITERAL edge (delete/rename convention), so changes to that old path still reach the consumer');
    assert.equal(deps('packages/ws/value.mjs').includes('tests/case.test.mjs'), false,
      'the identity was refused by the OS, so no edge to the differently-cased real file may be forged');
  }
  // The EXACT-case edge is unchanged by any of this (control).
  assert.ok(deps('packages/ws/value.mjs').includes('tests/exact.test.mjs'),
    'the byte-exact spelling keeps its edge; canonicalization never narrows proven shapes');
});

// (rework19d NEW-FS-CASE) The reviewer-required REAL end-to-end false-green proof,
// with the filesystem semantics MEASURED IN THE FIXTURE (a twin-file read-back, no
// process.platform reading): where the OS opens the same file for two casings, a
// case-mismatched `#imports` consumer loads the real file at baseline ("green
// before the change"), changing the real file must SELECT that consumer, and the
// reduced selection must FAIL like the full fixture set on that consumer's OWN
// assertion. Previously the edge keyed the phantom-case spelling, so the consumer
// was dropped and the reduced selection stayed green while the full set failed.
test('rework19d(NEW-FS-CASE): baseline green through a case-mismatched spelling, then the change selects the consumer - reduced selection FAILS like full', async (t) => {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-fscase-probe-'));
  TMP_FIXTURES.add(probe);
  fs.mkdirSync(path.join(probe, 'ws'), { recursive: true });
  fs.writeFileSync(path.join(probe, 'ws', 'twin.mjs'), 'export const v = "lower";\n');
  let caseInsensitive = true;
  try {
    fs.writeFileSync(path.join(probe, 'ws', 'TWIN.mjs'), 'export const v = "UPPER";\n');
    caseInsensitive = fs.readFileSync(path.join(probe, 'ws', 'twin.mjs'), 'utf8').includes('UPPER');
    fs.unlinkSync(path.join(probe, 'ws', 'TWIN.mjs'));
  } catch { caseInsensitive = false; }
  if (!caseInsensitive) {
    // This branch is measured OFF on this volume: a fixture on a case-SENSITIVE
    // filesystem would REFUSE the case-mismatched import at runtime (a loud
    // failure, never a false green). The graph-level counterpart in the test above
    // asserts the refusal semantics; there is no honestly-runnable runtime
    // green-baseline scenario to drive here, so this test says so explicitly.
    t.skip('this filesystem distinguishes case spellings; the green-baseline runtime fixture cannot exist here');
    return;
  }
  const { dir, base } = mkR18ConsumerRepo({
    sourceRel: 'packages/ws/value.mjs',
    source: 'export const n = 1;\n',
    staticBody: R19B_WS_STATIC_BODY,
    dynamicBody: R19B_WS_DYNAMIC_BODY,
    extraFiles: [['package.json', `${JSON.stringify({
      name: 'alias-fixture',
      private: true,
      type: 'module',
      imports: { '#ws': './PACKAGES/ws/value.mjs' },
    }, null, 2)}\n`]],
  });
  // Baseline must REALLY be green through the mismatched spelling: the loader
  // opening 'PACKAGES/ws/value.mjs' is the runtime proof of the same identity.
  await assertFixturePassesBeforeTheChange(dir);
  fs.writeFileSync(path.join(dir, 'packages/ws/value.mjs'), 'export const n = 2;\n');
  const p = planOf(dir, base);
  assert.equal(p.mode, 'affected', 'the proven same-identity edge (plus its exact-case consumer) keeps the plan AFFECTED');
  assert.ok(p.files.includes('tests/dynamic.test.mjs'),
    "the case-mismatched '#case' consumer resolves to the file the loader REALLY loads, so the change must select it - not the phantom-case key it used to be keyed on");
  await assertReducedSelectionIsNotFalselyGreen(dir, p);
});

// (rework19d NEW-FS-CASE) The no-blind-fold proof: the inventory's OWN spelling is
// odd (`ValUe.mjs`), and a target spelled `value.mjs` still loads IT on this
// volume. Canonicalization by OS identity keys the edge on the BYTE-EXACT entry -
// a blind case-fold would have invented or normalized a 'value.mjs' key that no
// inventory entry (and no change) can ever spell.
test('rework19d(NEW-FS-CASE): canonicalization keys the byte-exact inventory spelling - never a blind case-folded key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-notfold19d-'));
  TMP_FIXTURES.add(dir);
  const w = (rel, content) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  };
  w('package.json', `${JSON.stringify({
    name: 'notfold19d',
    private: true,
    type: 'module',
    imports: { '#mixed': './packages/ws/value.mjs', '#literal-req': './packages/ws/REQ.cjs' },
  }, null, 2)}\n`);
  w('packages/ws/ValUe.mjs', 'export const n = 1;\n');
  w('packages/ws/reQ.cjs', 'module.exports = { n: 1 };\n');
  w('tests/mix.test.mjs', "import { n } from '#mixed';\nexport const got = n;\n");
  w('tests/mixrel.test.mjs', "import { n } from '../packages/ws/value.mjs';\nexport const got = n;\n");
  w('tests/mixreq.test.mjs', "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nconst { n } = require('../packages/ws/req.cjs');\nexport const got = n;\n");
  const g = buildImportGraph(dir);
  const deps = (f) => [...(g.dependents.get(f) || [])];
  const spelledValue = fs.realpathSync.native(path.join(dir, 'packages/ws/ValUe.mjs'));
  let spelledProbe = null;
  try { spelledProbe = fs.realpathSync.native(path.join(dir, 'packages/ws/value.mjs')); } catch { spelledProbe = null; }
  const sameIdentity = spelledProbe !== null && spelledProbe === spelledValue;
  if (sameIdentity) {
    assert.deepEqual([...g.files].filter((f) => f.toLowerCase() === 'packages/ws/value.mjs'),
      ['packages/ws/ValUe.mjs'],
      'the inventory keeps its own byte-exact spelling; canonicalization NEVER folded it or invented a parallel key');
    assert.ok(deps('packages/ws/ValUe.mjs').includes('tests/mix.test.mjs')
      && deps('packages/ws/ValUe.mjs').includes('tests/mixrel.test.mjs'),
      'both the `#imports` and the RELATIVE ESM spelling open the SAME file (OS-measured), so both consumers key the true inventory entry');
  } else {
    // (rework19d round-2 per re-review) The OS refuses the `#imports` spelling
    // with ENOENT: keep the LITERAL edge (delete/rename convention), do not
    // forge an edge onto the differently-cased real file, and reserve OPAQUE
    // for probes that could not answer at all (non-ENOENT refusals).
    assert.ok([...(g.dependents.get('packages/ws/value.mjs') || [])].includes('tests/mix.test.mjs'),
      'an #imports spelling the OS refuses with ENOENT keeps its LITERAL edge - changes to that old path still reach the consumer');
    assert.equal(deps('packages/ws/ValUe.mjs').includes('tests/mix.test.mjs'), false,
      'the refused spelling must not be forged onto the differently-cased real entry');
    assert.equal(g.opaque.has('tests/mixrel.test.mjs'), false,
      'the relative spelling still resolves on its own FILESYSTEM terms (unchanged, unproven here is refused above)');
  }
  // The LITERAL require() path shares the same boundary: its odd spelled target
  // is canonicalized to... the exact inventory entry `reQ.cjs`.
  const spelledReqProbe = fs.realpathSync.native(path.join(dir, 'packages/ws/reQ.cjs'));
  let spelledReq = null;
  try { spelledReq = fs.realpathSync.native(path.join(dir, 'packages/ws/req.cjs')); } catch { spelledReq = null; }
  if (spelledReq !== null && spelledReq === spelledReqProbe) {
    assert.ok(deps('packages/ws/reQ.cjs').includes('tests/mixreq.test.mjs'),
      'a literal require() through the SAME boundary keys the byte-exact inventory entry too');
  } else {
    // (rework19d round-2 per re-review) A require() spelling the OS refuses with
    // ENOENT: LITERAL edge kept, no forged edge, no invented key. OPAQUE is
    // only for probes that cannot answer at all (non-ENOENT refusals).
    assert.ok([...(g.dependents.get('packages/ws/req.cjs') || [])].includes('tests/mixreq.test.mjs'),
      'a require() spelling the OS refuses with ENOENT keeps its LITERAL edge (delete/rename convention)');
    assert.equal(deps('packages/ws/reQ.cjs').includes('tests/mixreq.test.mjs'), false,
      'the refused spelling must not be forged onto the differently-cased real entry');
  }
  // No phantom key was invented for either identity, whatever this volume decided.
  for (const invented of ['packages/ws/value.cjs', 'packages/ws/req.mjs']) {
    assert.equal(g.dependents.has(invented), false,
      `no invented cross-extension/phantom key '${invented}' may appear`);
  }
});

// (rework19d round-2 per re-review) The coexistence discriminator, with the
// filesystem semantics MEASURED IN THE FIXTURE (a two-file read-back, no
// process.platform reading): on a filesystem that KEEPS two sources that differ
// only in case, the graph must hold TWO byte-exactly distinct identities - each
// spelling keys its OWN entry, consumers stay separated, no merging, no
// folding. On a filesystem that REFUSES the coexistence (measured here: the
// second write overwrites the first), there is exactly ONE identity on disk and
// the graph must key it byte-exactly - never a parallel case-variant key.
test('rework19d(NEW-FS-CASE): case-variant coexistence is measured, not assumed - two sources stay two identities or the OS proves only one exists', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-pair19d-'));
  TMP_FIXTURES.add(dir);
  const w = (rel, content) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  };
  const LOWER = 'export const v = "lower";\n';
  const UPPER = 'export const v = "upper";\n';
  w('src/a/value.mjs', LOWER);
  let coexists = false;
  try {
    fs.writeFileSync(path.join(dir, 'src/a/VALUE.mjs'), UPPER);
    coexists = fs.readFileSync(path.join(dir, 'src/a/value.mjs'), 'utf8') === LOWER
      && fs.existsSync(path.join(dir, 'src/a/VALUE.mjs'))
      && fs.readFileSync(path.join(dir, 'src/a/VALUE.mjs'), 'utf8') === UPPER;
    if (!coexists) {
      fs.unlinkSync(path.join(dir, 'src/a/VALUE.mjs'));
      // On a case-insensitive volume the twin IS the same inode: restoring the
      // lower-case content keeps the fixture honest either way.
      fs.writeFileSync(path.join(dir, 'src/a/value.mjs'), LOWER);
    }
  } catch { coexists = false; }
  w('package.json', `${JSON.stringify({
    name: 'pair19d',
    private: true,
    type: 'module',
    imports: { '#up': './src/a/VALUE.mjs' },
  }, null, 2)}\n`);
  w('tests/consumer-low.test.mjs', "import { v } from '../src/a/value.mjs';\nexport const got = v;\n");
  w('tests/consumer-up.test.mjs', "import { v } from '#up';\nexport const got = v;\n");
  const g = buildImportGraph(dir);
  const deps = (f) => [...(g.dependents.get(f) || [])];
  const both = [...g.files].filter((f) => f.toLowerCase() === 'src/a/value.mjs');
  if (coexists) {
    // Case-SENSITIVE filesystem, measured: BOTH sources exist with distinct
    // contents. They are TWO identities - the graph must keep them apart.
    assert.deepEqual(both, ['src/a/VALUE.mjs', 'src/a/value.mjs'],
      'both byte-exactly distinct spellings stay in the inventory; nothing is merged or folded');
    assert.deepEqual(deps('src/a/value.mjs'), ['tests/consumer-low.test.mjs'],
      'the lower-case entry keys exactly its own consumer');
    assert.deepEqual(deps('src/a/VALUE.mjs'), ['tests/consumer-up.test.mjs'],
      'the upper-case entry keys exactly its own consumer - no cross-identity folding');
    assert.equal(g.opaque.has('tests/consumer-low.test.mjs'), false, 'a proven exact-case edge is never OPAQUE');
    assert.equal(g.opaque.has('tests/consumer-up.test.mjs'), false, 'a proven exact-case edge is never OPAQUE');
  } else {
    // Case-INSENSITIVE filesystem, measured by the overwrite read-back: the OS
    // refuses two coexisting sources, so EXACTLY ONE identity exists on disk.
    assert.equal(both.length, 1, 'the OS proved the coexistence impossible; one identity survives');
    assert.deepEqual(both, ['src/a/value.mjs'], 'the survivor keeps its byte-exact inventory spelling');
    assert.deepEqual([...g.dependents.keys()].filter((k) => k.toLowerCase() === 'src/a/value.mjs'),
      ['src/a/value.mjs'],
      'the one identity is keyed on its byte-exact spelling alone - no parallel case-variant key');
    assert.ok(deps('src/a/value.mjs').includes('tests/consumer-low.test.mjs')
      && deps('src/a/value.mjs').includes('tests/consumer-up.test.mjs'),
      'both spellings open the SAME file (measured overwrite proof); both consumers key the one identity');
    assert.equal(g.opaque.has('tests/consumer-low.test.mjs'), false, 'a proven same-identity edge is never widened to OPAQUE');
    assert.equal(g.opaque.has('tests/consumer-up.test.mjs'), false, 'a proven same-identity edge is never widened to OPAQUE');
  }
});

// ==== END PR-285 ROUND-19 ====
