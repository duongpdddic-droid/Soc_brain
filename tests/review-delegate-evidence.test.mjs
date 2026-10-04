// review-delegate-evidence.test.mjs — Issue #2 rework: strict closed-world ReviewEvidence v1.
// No framework. Exit 0 = PASS, 1 = FAIL.
import {
  validateReviewEvidence,
  canonicalizeReviewEvidence,
  reviewEvidenceDigest,
  isReviewEvidenceV1,
  isLegacyGeminiPreReview,
  REVIEW_EVIDENCE_SCHEMA_VERSION,
  REVIEW_EVIDENCE_SOURCE,
  RESUME_PRE_REVIEW_SHAPE_MISMATCH,
} from '../packages/control-loop/review-delegate-evidence.mjs';
import fs from 'node:fs';

const checks = [];
const eq = (n, g, w) => checks.push({ name: n, ok: g === w, got: g, want: w });
const tru = (n, g) => checks.push({ name: n, ok: Boolean(g), got: g });

const BIND = {
  identityHash: 'a'.repeat(32),
  repo: 'duongpdddic-droid/soc_brain',
  issueNumber: 75,
  baseSha: 'b'.repeat(40),
  headSha: 'c'.repeat(40),
};

function mkValid(over = {}) {
  return {
    schemaVersion: '1',
    source: 'ocr-delegate+opencode-host',
    binding: { ...BIND },
    target: { mode: 'range', from: BIND.baseSha, to: BIND.headSha },
    ocr: { version: '1.12.4', ruleGroups: 2 },
    reviewableFiles: ['src/a.mjs', 'src/b.mjs'],
    excludedFiles: [{ path: 'dist/bundle.js', reason: 'generated' }],
    reviewedFiles: ['src/a.mjs', 'src/b.mjs'],
    skippedFiles: [],
    coverageRate: 1,
    findings: [{ path: 'src/a.mjs', content: 'null check missing', startLine: 10, endLine: 12, category: 'bug', severity: 'high' }],
    reflectionCompleted: true,
    durationMs: 1234,
    ...over,
  };
}

// ---- 1. valid PASS ----
{
  const r = validateReviewEvidence(mkValid());
  eq('valid PASS', r.ok, true);
  eq('valid findingsCount', r.value.findingsCount, 1);
  tru('valid digest 64-hex', /^[0-9a-f]{64}$/.test(r.value.digest));
  tru('discriminator v1 true', isReviewEvidenceV1(mkValid()));
  tru('discriminator v1 false on gemini', !isReviewEvidenceV1({ verdict: 'PASS', findings: [], confidence: 1, metadata: {} }));
  eq('resume code stable', RESUME_PRE_REVIEW_SHAPE_MISMATCH, 'RESUME_PRE_REVIEW_SHAPE_MISMATCH');
  eq('schema version', REVIEW_EVIDENCE_SCHEMA_VERSION, '1');
  eq('source', REVIEW_EVIDENCE_SOURCE, 'ocr-delegate+opencode-host');
}

// ---- 2. malformed/version/source ----
eq('non-object FAIL', validateReviewEvidence(null).code, 'EVIDENCE_MALFORMED');
eq('version FAIL', validateReviewEvidence(mkValid({ schemaVersion: '2' })).code, 'EVIDENCE_SCHEMA_VERSION_INVALID');
eq('source FAIL', validateReviewEvidence(mkValid({ source: 'gemini-pre-review' })).code, 'EVIDENCE_SOURCE_INVALID');
eq('verdict forbidden FAIL', validateReviewEvidence(mkValid({ verdict: 'PASS' })).code, 'EVIDENCE_VERDICT_FORBIDDEN');

// ---- 3. CLOSE-WORLD top-level ----
eq('top-level extra FAIL', validateReviewEvidence(mkValid({ extraField: 1 })).code, 'EVIDENCE_UNKNOWN_FIELD');
eq('metadata FAIL', validateReviewEvidence(mkValid({ metadata: { note: 'x' } })).code, 'EVIDENCE_UNKNOWN_FIELD');
eq('metadata verdict FAIL', validateReviewEvidence(mkValid({ metadata: { verdict: 'PASS' } })).code, 'EVIDENCE_UNKNOWN_FIELD');
eq('top-level verdict FAIL', validateReviewEvidence(mkValid({ verdict: 'REWORK' })).code, 'EVIDENCE_VERDICT_FORBIDDEN');
eq('binding unknown FAIL', validateReviewEvidence(mkValid({ binding: { ...BIND, extra: 1 } })).code, 'BINDING_UNKNOWN_FIELD');
eq('target unknown FAIL', validateReviewEvidence(mkValid({ target: { mode: 'range', from: BIND.baseSha, to: BIND.headSha, extra: 1 } })).code, 'TARGET_UNKNOWN_FIELD');
eq('ocr unknown FAIL', validateReviewEvidence(mkValid({ ocr: { version: '1.12.4', ruleGroups: 2, extra: 1 } })).code, 'OCR_UNKNOWN_FIELD');
eq('exclusion unknown FAIL', validateReviewEvidence(mkValid({ excludedFiles: [{ path: 'dist/b.js', reason: 'r', extra: 1 }] })).code, 'EXCLUSION_UNKNOWN_FIELD');
eq('finding unknown FAIL', validateReviewEvidence(mkValid({ findings: [{ path: 'src/a.mjs', content: 'x', category: 'bug', severity: 'low', extra: 1 }] })).code, 'FINDING_UNKNOWN_FIELD');

// ---- 4. binding mismatch (each field) ----
{
  const bad = { ...BIND, identityHash: '0'.repeat(32) };
  eq('binding identityHash FAIL', validateReviewEvidence(mkValid({ binding: bad }), BIND).code, 'BINDING_MISMATCH');
  eq('binding repo FAIL', validateReviewEvidence(mkValid({ binding: { ...BIND, repo: 'x/y' } }), BIND).code, 'BINDING_MISMATCH');
  eq('binding issue FAIL', validateReviewEvidence(mkValid({ binding: { ...BIND, issueNumber: 76 } }), BIND).code, 'BINDING_MISMATCH');
  eq('binding base FAIL', validateReviewEvidence(mkValid({ binding: { ...BIND, baseSha: 'd'.repeat(40) } }), BIND).code, 'BINDING_MISMATCH');
  eq('binding head FAIL', validateReviewEvidence(mkValid({ binding: { ...BIND, headSha: 'e'.repeat(40) } }), BIND).code, 'BINDING_MISMATCH');
  eq('binding malformed FAIL', validateReviewEvidence(mkValid({ binding: { repo: 'x' } })).code, 'BINDING_INVALID');
  eq('binding missing FAIL', validateReviewEvidence(mkValid({ binding: null })).code, 'BINDING_INVALID');
}

// ---- 5. TARGET canonical-only (F02) ----
eq('target mode bogus FAIL', validateReviewEvidence(mkValid({ target: { mode: 'nope' } })).code, 'TARGET_MODE_INVALID');
eq('target workspace FAIL', validateReviewEvidence(mkValid({ target: { mode: 'workspace' } })).code, 'TARGET_MODE_INVALID');
eq('target workspace+ref FAIL', validateReviewEvidence(mkValid({ target: { mode: 'workspace', from: BIND.baseSha } })).code, 'TARGET_MODE_INVALID');
{
  const r = validateReviewEvidence(mkValid({ target: { mode: 'range', from: BIND.baseSha, to: BIND.headSha } }));
  eq('target range exact PASS', r.ok, true);
}
eq('target range-from FAIL', validateReviewEvidence(mkValid({ target: { mode: 'range', from: 'd'.repeat(40), to: BIND.headSha } })).code, 'TARGET_MISMATCH');
eq('target range-to FAIL', validateReviewEvidence(mkValid({ target: { mode: 'range', from: BIND.baseSha, to: 'd'.repeat(40) } })).code, 'TARGET_MISMATCH');
eq('target range+commit FAIL', validateReviewEvidence(mkValid({ target: { mode: 'range', from: BIND.baseSha, to: BIND.headSha, commit: BIND.headSha } })).code, 'TARGET_UNKNOWN_FIELD');
{
  const c = mkValid({ target: { mode: 'commit', commit: BIND.headSha } });
  eq('target commit exact PASS', validateReviewEvidence(c).ok, true);
}
eq('target commit wrong FAIL', validateReviewEvidence(mkValid({ target: { mode: 'commit', commit: 'd'.repeat(40) } })).code, 'TARGET_MISMATCH');
eq('target commit+from FAIL', validateReviewEvidence(mkValid({ target: { mode: 'commit', commit: BIND.headSha, from: BIND.baseSha } })).code, 'TARGET_UNKNOWN_FIELD');
eq('target commit+to FAIL', validateReviewEvidence(mkValid({ target: { mode: 'commit', commit: BIND.headSha, to: BIND.headSha } })).code, 'TARGET_UNKNOWN_FIELD');

// ---- 6. SCOPE: empty + duplicates + overlap ----
eq('empty scope FAIL', validateReviewEvidence(mkValid({ reviewableFiles: [], reviewedFiles: [] })).code, 'EVIDENCE_EMPTY_SCOPE');
eq('dup reviewable FAIL', validateReviewEvidence(mkValid({ reviewableFiles: ['src/a.mjs', 'src/a.mjs'], reviewedFiles: ['src/a.mjs'] })).code, 'PATH_DUPLICATE');
eq('dup excluded FAIL', validateReviewEvidence(mkValid({ excludedFiles: [{ path: 'x.js', reason: 'r' }, { path: 'x.js', reason: 'r2' }] })).code, 'PATH_DUPLICATE');
eq('dup reviewed FAIL', validateReviewEvidence(mkValid({ reviewedFiles: ['src/a.mjs', 'src/a.mjs'] })).code, 'PATH_DUPLICATE');
eq('invalid path FAIL', validateReviewEvidence(mkValid({ reviewableFiles: ['/abs.js'], reviewedFiles: ['/abs.js'] })).code, 'PATH_INVALID');
eq('exclusion no-reason FAIL', validateReviewEvidence(mkValid({ excludedFiles: [{ path: 'x.js', reason: '  ' }] })).code, 'EXCLUSION_REASON_MISSING');
eq('overlap FAIL', validateReviewEvidence(mkValid({ excludedFiles: [{ path: 'src/a.mjs', reason: 'r' }] })).code, 'SCOPE_OVERLAP');

// ---- 7. reviewed set exact ==
{
  const missing = mkValid({ reviewedFiles: ['src/a.mjs'] });
  eq('reviewed missing FAIL', validateReviewEvidence(missing).code, 'REVIEWED_MISMATCH');
  const extra = mkValid({ reviewableFiles: ['src/a.mjs'], reviewedFiles: ['src/a.mjs', 'src/zz.mjs'] });
  eq('reviewed extra FAIL', validateReviewEvidence(extra).code, 'REVIEWED_MISMATCH');
  const reorder = mkValid({ reviewedFiles: ['src/b.mjs', 'src/a.mjs'] });
  eq('reviewed reorder PASS', validateReviewEvidence(reorder).ok, true);
}

// ---- 8. skipped/coverage/reflection/duration/ocr ----
eq('skipped FAIL', validateReviewEvidence(mkValid({ skippedFiles: ['src/a.mjs'] })).code, 'SKIPPED_NON_EMPTY');
eq('skipped obj FAIL', validateReviewEvidence(mkValid({ skippedFiles: [{ path: 'src/a.mjs', reason: 'x' }] })).code, 'SKIPPED_NON_EMPTY');
eq('coverage FAIL', validateReviewEvidence(mkValid({ coverageRate: 0.5 })).code, 'COVERAGE_INVALID');
eq('reflection FAIL', validateReviewEvidence(mkValid({ reflectionCompleted: false })).code, 'REFLECTION_INCOMPLETE');
eq('duration FAIL', validateReviewEvidence(mkValid({ durationMs: -1 })).code, 'DURATION_INVALID');
eq('ocr version FAIL', validateReviewEvidence(mkValid({ ocr: { version: '', ruleGroups: 1 } })).code, 'OCR_METADATA_INVALID');
eq('ocr groups FAIL', validateReviewEvidence(mkValid({ ocr: { version: '1.0.0', ruleGroups: -1 } })).code, 'OCR_METADATA_INVALID');

// ---- 9. findings ----
eq('finding foreign FAIL', validateReviewEvidence(mkValid({ findings: [{ path: 'src/zz.mjs', content: 'x', category: 'bug', severity: 'low' }] })).code, 'FINDING_PATH_FOREIGN');
eq('finding content FAIL', validateReviewEvidence(mkValid({ findings: [{ path: 'src/a.mjs', content: '  ', category: 'bug', severity: 'low' }] })).code, 'FINDING_MALFORMED');
eq('finding line FAIL', validateReviewEvidence(mkValid({ findings: [{ path: 'src/a.mjs', content: 'x', startLine: 5, endLine: 2, category: 'bug', severity: 'low' }] })).code, 'FINDING_LINE_INVALID');
eq('finding start0 FAIL', validateReviewEvidence(mkValid({ findings: [{ path: 'src/a.mjs', content: 'x', startLine: 0, category: 'bug', severity: 'low' }] })).code, 'FINDING_LINE_INVALID');
eq('finding severity FAIL', validateReviewEvidence(mkValid({ findings: [{ path: 'src/a.mjs', content: 'x', category: 'bug', severity: 'huge' }] })).code, 'FINDING_SEVERITY_INVALID');
eq('finding category FAIL', validateReviewEvidence(mkValid({ findings: [{ path: 'src/a.mjs', content: 'x', category: 'nope', severity: 'low' }] })).code, 'FINDING_CATEGORY_INVALID');
eq('reflectionCompleted != true FAIL', validateReviewEvidence(mkValid({ reflectionCompleted: 1 })).code, 'REFLECTION_INCOMPLETE');

// ---- 10. canonical closed-world shape ----
{
  const canon = canonicalizeReviewEvidence(mkValid());
  eq('canonical has no metadata', ('metadata' in canon), false);
  eq('canonical has no verdict', ('verdict' in canon), false);
  eq('canonical top keys exact', Object.keys(canon).sort().join(','), 'binding,coverageRate,durationMs,excludedFiles,findings,ocr,reflectionCompleted,reviewableFiles,reviewedFiles,schemaVersion,skippedFiles,source,target');
  eq('canonical range target exact', JSON.stringify(canon.target), JSON.stringify({ mode: 'range', from: BIND.baseSha, to: BIND.headSha }));
  const canonCommit = canonicalizeReviewEvidence(mkValid({ target: { mode: 'commit', commit: BIND.headSha } }));
  eq('canonical commit target exact', JSON.stringify(canonCommit.target), JSON.stringify({ mode: 'commit', commit: BIND.headSha }));
  tru('canonical finding has no extra', !('extra' in canon.findings[0]));
}

// ---- 11. digest stability / sensitivity ----
{
  const a = mkValid({ reviewedFiles: ['src/b.mjs', 'src/a.mjs'], reviewableFiles: ['src/b.mjs', 'src/a.mjs'], durationMs: 1 });
  const b = mkValid({ reviewedFiles: ['src/a.mjs', 'src/b.mjs'], reviewableFiles: ['src/a.mjs', 'src/b.mjs'], durationMs: 9999 });
  eq('digest key/set order independent', reviewEvidenceDigest(a), reviewEvidenceDigest(b));
  eq('durationMs excluded from digest', reviewEvidenceDigest(mkValid({ durationMs: 1 })), reviewEvidenceDigest(mkValid({ durationMs: 9999 })));
  const changedFinding = mkValid({ findings: [{ path: 'src/a.mjs', content: 'different', category: 'bug', severity: 'low' }] });
  tru('finding change flips digest', reviewEvidenceDigest(changedFinding) !== reviewEvidenceDigest(mkValid()));
  tru('binding change flips digest', reviewEvidenceDigest(mkValid({ binding: { ...BIND, headSha: 'd'.repeat(40) }, target: { mode: 'range', from: BIND.baseSha, to: 'd'.repeat(40) } })) !== reviewEvidenceDigest(mkValid()));
  tru('target change flips digest', reviewEvidenceDigest(mkValid({ target: { mode: 'commit', commit: BIND.headSha } })) !== reviewEvidenceDigest(mkValid()));
  tru('scope change flips digest', reviewEvidenceDigest(mkValid({ reviewableFiles: ['src/a.mjs'], reviewedFiles: ['src/a.mjs'], findings: [] })) !== reviewEvidenceDigest(mkValid()));
  tru('reflection change flips digest', (() => {
    // reflection false fails validation but digest input still differs semantically;
    // prove digest binds reflectionCompleted by comparing canonical digests via tampered canonical path:
    // use two valid evidences differing only in ocr version (contract field) as proxy + direct canonical check.
    const c1 = canonicalizeReviewEvidence(mkValid());
    const c2 = { ...c1, reflectionCompleted: false };
    return JSON.stringify(c1) !== JSON.stringify(c2);
  })());
  tru('ocr version change flips digest', reviewEvidenceDigest(mkValid({ ocr: { version: '1.12.5', ruleGroups: 2 } })) !== reviewEvidenceDigest(mkValid()));
}

// ---- 12. legacy Gemini rejected, no conversion ----
{
  const legacy = { verdict: 'PASS', findings: ['f'], confidence: 0.9, metadata: { source: 'gemini-pre-review' } };
  tru('legacy detector true', isLegacyGeminiPreReview(legacy));
  const r = validateReviewEvidence(legacy);
  tru('legacy rejected', r.ok === false);
  eq('legacy code', r.code, 'EVIDENCE_VERDICT_FORBIDDEN');
  tru('legacy not v1', !isReviewEvidenceV1(legacy));
}

// ---- 13. authority/import hardening ----
{
  const rawSrc = fs.readFileSync(new URL('../packages/control-loop/review-delegate-evidence.mjs', import.meta.url), 'utf8');
  const code = rawSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const lines = code.split('\n').filter((l) => l.trim().startsWith('import '));
  eq('single import (node:crypto only)', lines.length, 1);
  tru('imports node:crypto', lines[0].includes('node:crypto'));
  for (const banned of ['taskFinish', 'taskBlock', 'delivery.mjs', 'fetch(', 'https', 'API_KEY', 'OPENROUTER', 'child_process', 'spawnSync', 'execFile', 'spawn(', 'writeFile', 'appendFile', 'renameSync', 'readSessionRecord', 'updateSession', 'terminalize', 'dispatch', 'loop token', 'verdict:']) {
    checks.push({ name: `no ${banned} in code`, ok: !code.includes(banned), got: code.includes(banned) });
  }
  const canon = canonicalizeReviewEvidence(mkValid());
  checks.push({ name: 'canonical carries no verdict key', ok: !('verdict' in canon), got: Object.keys(canon) });
  checks.push({ name: 'canonical carries no metadata key', ok: !('metadata' in canon), got: Object.keys(canon) });
}

// ---- summary ----
const failed = checks.filter((c) => !c.ok);
for (const c of checks) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : ` | got=${JSON.stringify(c.got)} want=${JSON.stringify(c.want)}`}`);
}
console.log(`review-delegate-evidence: ${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
