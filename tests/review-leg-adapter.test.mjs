// review-leg-adapter.test.mjs — Issue #4C/#4E: review-leg control-loop adapter.
// No framework. Exit 0 = PASS, 1 = FAIL.
import {
  evidencePathFor,
  saveReviewEvidence,
  loadReviewEvidence,
  isFreshEvidence,
  isGenuineLegacyPreReview,
  deriveReviewTarget,
  resolveResumePreReview,
  reviewLegPreReviewAdapter,
  REVIEW_LEG_ADAPTER_VERSION,
} from '../packages/control-loop/review-leg-adapter.mjs';
import { RESUME_PRE_REVIEW_SHAPE_MISMATCH } from '../packages/control-loop/review-delegate-evidence.mjs';
import { ocrRulesDigest } from '../packages/review-leg/review-only.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const checks = [];
const eq = (n, g, w) => checks.push({ name: n, ok: g === w, got: g, want: w });
const tru = (n, g) => checks.push({ name: n, ok: Boolean(g), got: g });

const BIND = {
  repo: 'duongpdddic-droid/soc_brain',
  issueNumber: 75,
  baseSha: 'b'.repeat(40),
  headSha: 'c'.repeat(40),
};
const ID = identityHash(BIND);
const TARGET = { mode: 'range', from: BIND.baseSha, to: BIND.headSha };

function mkStateDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'rla-')); }

function mkSession(stateDir, over = {}) {
  const sessionPath = path.join(stateDir, 'sessions', `${ID}.json`);
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  const session = {
    schemaVersion: '1',
    state: 'SESSION_ACTIVE',
    lifecycle: [],
    taskId: `${BIND.repo}#${BIND.issueNumber}`,
    repo: BIND.repo,
    issueNumber: BIND.issueNumber,
    baseSha: BIND.baseSha,
    headSha: BIND.headSha,
    worktreePath: path.join(stateDir, 'wt'),
    worktreesRoot: stateDir,
    controlPlane: { stateDir },
    ...over,
  };
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
  return { sessionPath, session };
}

function mkCanonical(over = {}) {
  return {
    schemaVersion: '1',
    source: 'ocr-delegate+opencode-host',
    binding: { identityHash: ID, ...BIND },
    target: { ...TARGET },
    ocr: { version: '1.12.4', ruleGroups: 2 },
    reviewableFiles: ['src/a.mjs'],
    excludedFiles: [],
    reviewedFiles: ['src/a.mjs'],
    skippedFiles: [],
    coverageRate: 1,
    findings: [],
    reflectionCompleted: true,
    durationMs: 10,
    ...over,
  };
}

function mkValue(canonical = mkCanonical()) {
  return { source: 'ocr-review-leg', schemaVersion: '1', canonical, digest: 'd'.repeat(64), findingsCount: 0, batch: null };
}

const RULE_GROUPS = [{ group_id: 1, source: 'system', pattern: '**/*.mjs', files: ['src/a.mjs'], rule: 'No ==.' }];
const RULE_DIGEST = ocrRulesDigest(RULE_GROUPS);
const OCR_VERSION_OUT = 'open-code-review v1.12.4 (f1101fd7f) windows/amd64';

// Fake deterministic OCR exec: version + rule only (no model/provider).
function mkOcrExec({ groups = RULE_GROUPS, version = OCR_VERSION_OUT, calls = [] } = {}) {
  return function ocrExec(exe, args, opts) {
    calls.push({ exe, args: [...args] });
    if (args.includes('version')) return version;
    if (args[0] === 'delegate' || args.includes('delegate')) {
      return JSON.stringify({ schema_version: '1', groups });
    }
    throw new Error(`unexpected ocr call: ${exe} ${args.join(' ')}`);
  };
}

eq('adapter version', REVIEW_LEG_ADAPTER_VERSION, '1');

// ---- persistence (cache envelope with rulesDigest) ----
{
  const sd = mkStateDir();
  eq('evidence path shape', evidencePathFor({ stateDir: sd, identityHash: ID }).endsWith(path.join('review-evidence', `${ID}.json`)), true);
  eq('save ok', saveReviewEvidence({ stateDir: sd, identityHash: ID, record: mkValue(), rulesDigest: RULE_DIGEST }).ok, true);
  eq('save rejects bad digest', saveReviewEvidence({ stateDir: sd, identityHash: ID, record: mkValue(), rulesDigest: 'nope' }).code, 'REVIEW_EVIDENCE_SAVE_FAILED');
  const loaded = loadReviewEvidence({ stateDir: sd, identityHash: ID });
  eq('load ok', loaded.ok, true);
  eq('load digest', loaded.value.digest, 'd'.repeat(64));
  eq('load rulesDigest', loaded.rulesDigest, RULE_DIGEST);
  eq('load absent', loadReviewEvidence({ stateDir: mkStateDir(), identityHash: ID }).code, 'REVIEW_EVIDENCE_ABSENT');
  const badDir = mkStateDir();
  fs.mkdirSync(path.dirname(evidencePathFor({ stateDir: badDir, identityHash: ID })), { recursive: true });
  fs.writeFileSync(evidencePathFor({ stateDir: badDir, identityHash: ID }), 'not json', 'utf8');
  eq('load malformed', loadReviewEvidence({ stateDir: badDir, identityHash: ID }).code, 'REVIEW_EVIDENCE_MALFORMED');
  // Old envelope without rulesDigest -> stale (rerun, never convert).
  const oldDir = mkStateDir();
  fs.mkdirSync(path.dirname(evidencePathFor({ stateDir: oldDir, identityHash: ID })), { recursive: true });
  fs.writeFileSync(evidencePathFor({ stateDir: oldDir, identityHash: ID }), JSON.stringify({ schemaVersion: '1', savedAt: 'x', value: mkValue() }), 'utf8');
  eq('load missing digest stale', loadReviewEvidence({ stateDir: oldDir, identityHash: ID }).code, 'REVIEW_EVIDENCE_STALE');
  const malDir = mkStateDir();
  fs.mkdirSync(path.dirname(evidencePathFor({ stateDir: malDir, identityHash: ID })), { recursive: true });
  fs.writeFileSync(evidencePathFor({ stateDir: malDir, identityHash: ID }), JSON.stringify({ schemaVersion: '1', savedAt: 'x', rulesDigest: 'zz', value: mkValue() }), 'utf8');
  eq('load malformed digest stale', loadReviewEvidence({ stateDir: malDir, identityHash: ID }).code, 'REVIEW_EVIDENCE_STALE');
}

// ---- freshness gate ----
{
  const c = mkCanonical();
  const fresh = { binding: { identityHash: ID, ...BIND }, target: { ...TARGET } };
  eq('fresh exact', isFreshEvidence(c, fresh), true);
  eq('stale head', isFreshEvidence(c, { binding: { ...fresh.binding, headSha: 'd'.repeat(40) }, target: fresh.target }), false);
  eq('stale base', isFreshEvidence(c, { binding: { ...fresh.binding, baseSha: 'd'.repeat(40) }, target: fresh.target }), false);
  eq('target mismatch', isFreshEvidence(c, { binding: fresh.binding, target: { mode: 'commit', commit: BIND.headSha } }), false);
  eq('wrong issue', isFreshEvidence(c, { binding: { ...fresh.binding, issueNumber: 76 }, target: fresh.target }), false);
  eq('ocr version drift', isFreshEvidence(mkCanonical({ ocr: { version: '9.9.9', ruleGroups: 2 } }), { ...fresh, ocrVersion: '1.12.4' }), false);
  eq('target derive', deriveReviewTarget({ baseSha: BIND.baseSha, headSha: BIND.headSha }).target.mode, 'range');
  eq('target missing head', deriveReviewTarget({ baseSha: BIND.baseSha }).code, 'REVIEW_TARGET_UNAVAILABLE');
}

// ---- adapter: fresh run + rulesDigest-bound reuse + rerun ----
{
  const sd = mkStateDir();
  const { sessionPath } = mkSession(sd);
  const ocrCalls = [];
  const ocr = { exe: 'ocr', prefix: [] };
  let runs = 0;
  const runLeg = () => {
    runs += 1;
    return { ok: true, value: { canonical: mkCanonical(), digest: 'e'.repeat(64), findingsCount: 0 }, batch: { batched: false, batches: 1 }, rulesDigest: RULE_DIGEST };
  };
  const pre = reviewLegPreReviewAdapter({ controlRepo: sd, runLeg, ocr, ocrExec: mkOcrExec({ calls: ocrCalls }) });
  const r1 = await pre({ sessionPath, report: { verdict: 'PASS' } });
  eq('adapter fresh ok', r1.ok, true);
  eq('adapter value source', r1.value.source, 'ocr-review-leg');
  eq('leg ran once', runs, 1);
  // Cache envelope saved the exact current rulesDigest.
  const savedDoc = JSON.parse(fs.readFileSync(evidencePathFor({ stateDir: sd, identityHash: ID }), 'utf8'));
  eq('envelope kind is cache', savedDoc.kind, 'review-evidence-cache');
  eq('envelope rulesDigest exact', savedDoc.rulesDigest, RULE_DIGEST);
  const r2 = await pre({ sessionPath, report: { verdict: 'PASS' } });
  eq('adapter reuse ok', r2.ok, true);
  eq('no duplicate dispatch on reuse', runs, 1);
  eq('reuse same digest', r2.value.digest, r1.value.digest);
  tru('reuse re-derived rules via OCR', ocrCalls.some((c) => c.args.includes('delegate')));
  // Changed rule content (same version, same group count) -> NO reuse.
  const ocrCalls2 = [];
  const preChanged = reviewLegPreReviewAdapter({
    controlRepo: sd, runLeg, ocr,
    ocrExec: mkOcrExec({ calls: ocrCalls2, groups: [{ group_id: 1, source: 'system', pattern: '**/*.mjs', files: ['src/a.mjs'], rule: 'CHANGED rule text.' }] }),
  });
  const rChanged = await preChanged({ sessionPath, report: null });
  eq('rule change reruns leg', rChanged.ok, true);
  eq('rerun dispatched on rule change', runs, 2);
  // New head invalidates -> rerun.
  mkSession(sd, { headSha: 'd'.repeat(40) });
  const r3 = await pre({ sessionPath, report: { verdict: 'PASS' } });
  eq('stale head reruns', r3.ok, true);
  eq('rerun dispatched on stale head', runs, 3);
}

// ---- adapter: leg failure passthrough, session byte-identical ----
{
  const sd = mkStateDir();
  const { sessionPath } = mkSession(sd);
  const before = fs.readFileSync(sessionPath, 'utf8');
  const pre = reviewLegPreReviewAdapter({ controlRepo: sd, runLeg: () => ({ ok: false, code: 'REVIEW_TIMEOUT' }) });
  const r = await pre({ sessionPath, report: null });
  eq('leg failure code', r.code, 'REVIEW_TIMEOUT');
  eq('session untouched', fs.readFileSync(sessionPath, 'utf8'), before);
  eq('missing session', (await reviewLegPreReviewAdapter({ runLeg: () => ({ ok: true }) })({ sessionPath: path.join(sd, 'sessions', 'nope.json') })).ok, false);
}

// ---- resolveResumePreReview: legacy never converts ----
{
  const legacy = { verdict: 'PASS', findings: ['f'], confidence: 0.9, metadata: {} };
  let reran = 0;
  const dep = async () => { reran += 1; return { ok: true, value: mkValue() }; };
  const rr = await resolveResumePreReview({ preReviewDep: dep, sessionPath: 's', report: null, reviewReadyDir: null, pRecEvidence: legacy });
  eq('legacy reruns leg', rr.ok, true);
  eq('reran once', reran, 1);
  tru('rerun value is leg evidence', rr.preReview && rr.preReview.source === 'ocr-review-leg');
  const failDep = async () => ({ ok: false, code: 'REVIEW_TIMEOUT' });
  const rb = await resolveResumePreReview({ preReviewDep: failDep, sessionPath: 's', report: null, reviewReadyDir: null, pRecEvidence: legacy });
  eq('failed rerun code', rb.code, RESUME_PRE_REVIEW_SHAPE_MISMATCH);
  const freshEv = mkValue();
  const rf = await resolveResumePreReview({ preReviewDep: dep, sessionPath: 's', report: null, reviewReadyDir: null, pRecEvidence: freshEv });
  eq('fresh evidence passthrough', rf.ok && rf.preReview, freshEv);
  eq('no dep call for fresh', reran, 1);
  const rn = await resolveResumePreReview({ preReviewDep: dep, sessionPath: 's', report: null, reviewReadyDir: null, pRecEvidence: null });
  eq('null passthrough', rn.ok && rn.preReview, null);
  // Decision-shaped ledger evidence (rework rounds store the GPT decision as
  // the latest PRE->FINAL evidence) is NOT legacy: passthrough, no rerun.
  const decisionShaped = { verdict: 'REWORK', findings: ['f'], confidence: 0.8, metadata: {}, binding: { repository: 'r', issue: 1, headSha: 'c'.repeat(40) }, evidenceRequests: [] };
  eq('decision-shaped not genuine legacy', isGenuineLegacyPreReview(decisionShaped), false);
  eq('genuine legacy detected', isGenuineLegacyPreReview(legacy), true);
  const rd = await resolveResumePreReview({ preReviewDep: dep, sessionPath: 's', report: null, reviewReadyDir: null, pRecEvidence: decisionShaped });
  eq('decision passthrough ok', rd.ok, true);
  eq('decision passthrough no rerun', reran, 1);
  eq('decision object preserved', rd.preReview, decisionShaped);
}

// ---- telemetry best-effort + cache-save failure never blocks (F02) ----
{
  const sd = mkStateDir();
  const { sessionPath } = mkSession(sd);
  const events = [];
  const throwing = { record: () => { throw new Error('sink down'); } };
  const ocr = { exe: 'ocr', prefix: [] };
  const pre = reviewLegPreReviewAdapter({
    controlRepo: sd,
    runLeg: () => ({ ok: true, value: { canonical: mkCanonical(), digest: 'f'.repeat(64), findingsCount: 0 }, rulesDigest: RULE_DIGEST }),
    ocr,
    ocrExec: mkOcrExec(),
    telemetry: throwing,
  });
  eq('throwing telemetry still ok', (await pre({ sessionPath, report: null })).ok, true);
  const rec = { record: (e, d) => events.push([e, d]) };
  const pre2 = reviewLegPreReviewAdapter({
    controlRepo: sd,
    runLeg: () => { throw new Error('must not rerun'); },
    ocr,
    ocrExec: mkOcrExec(),
    telemetry: rec,
  });
  await pre2({ sessionPath, report: null });
  tru('reuse telemetry recorded', events.some(([e]) => e === 'REVIEW_LEG_REUSED'));
  // Cache save failure (unwritable stateDir) still reaches the leg result:
  // the JSON envelope is a dedup cache, not the authoritative resume state.
  const fileAsDir = path.join(mkStateDir(), 'not-a-dir');
  fs.writeFileSync(fileAsDir, 'x', 'utf8');
  const { sessionPath: sp3 } = mkSession(sd);
  const pre3 = reviewLegPreReviewAdapter({
    controlRepo: sd,
    runLeg: () => ({ ok: true, value: { canonical: mkCanonical(), digest: '9'.repeat(64), findingsCount: 0 }, rulesDigest: RULE_DIGEST }),
    ocr,
    ocrExec: mkOcrExec(),
    telemetry: throwing,
  });
  // Force the cache write to fail by pointing stateDir at a file path via a
  // session whose controlPlane.stateDir is unusable, while the leg still runs.
  const badSession = JSON.parse(fs.readFileSync(sp3, 'utf8'));
  badSession.controlPlane = { stateDir: fileAsDir };
  fs.writeFileSync(sp3, JSON.stringify(badSession), 'utf8');
  const r3 = await pre3({ sessionPath: sp3, report: null });
  eq('cache save failure still returns leg evidence', r3.ok, true);
  eq('no SAVE_FAILED blocker code', r3.code ?? null, null);
}

// ---- authority hardening ----
{
  const rawSrc = fs.readFileSync(new URL('../packages/control-loop/review-leg-adapter.mjs', import.meta.url), 'utf8');
  const code = rawSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const banned of ['taskFinish', 'taskBlock', 'terminalize', 'delivery.mjs', 'leaseToken', 'fetch(', 'spawn(', 'merge', 'pushBranch', 'shell: true']) {
    checks.push({ name: `no ${banned} in adapter`, ok: !code.includes(banned), got: code.includes(banned) });
  }
  tru('adapter uses execFileSync only for deterministic OCR derivation', code.includes('execFileSync'));
}

// ---- summary ----
const failed = checks.filter((c) => !c.ok);
for (const c of checks) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : ` | got=${JSON.stringify(c.got)} want=${JSON.stringify(c.want)}`}`);
}
console.log(`review-leg-adapter: ${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
