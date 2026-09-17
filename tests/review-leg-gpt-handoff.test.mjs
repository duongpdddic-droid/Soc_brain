// review-leg-gpt-handoff.test.mjs — Issue #4D: GPT final handoff consumes
// ReviewEvidence v1 as informational secondary (no verdict). No framework.
import {
  buildFinalReviewPrompt,
  renderSecondaryPreReview,
  unwrapReviewEvidence,
} from '../packages/control-loop/gpt-final-review.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const checks = [];
const eq = (n, g, w) => checks.push({ name: n, ok: g === w, got: g, want: w });
const tru = (n, g) => checks.push({ name: n, ok: Boolean(g), got: g });

function mkStateDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'rlg-')); }

const session = {
  repo: 'duongpdddic-droid/soc_brain',
  issueNumber: 77,
  baseSha: 'b'.repeat(40),
  headSha: 'c'.repeat(40),
  state: 'SESSION_ACTIVE',
};
const packet = { ok: true, name: 'packet.md', excerpt: 'Canonical packet body\nrepository: duongpdddic-droid/soc_brain', truncated: false };
const report = { verdict: 'PASS', findings: [] };
const ledger = [{ from: 'PRE_REVIEWING', to: 'FINAL_REVIEWING', reason: 'ok' }];

function mkEvidence() {
  return {
    source: 'ocr-review-leg',
    schemaVersion: '1',
    canonical: {
      schemaVersion: '1',
      source: 'ocr-delegate+opencode-host',
      binding: { identityHash: 'a'.repeat(32), repo: session.repo, issueNumber: 77, baseSha: session.baseSha, headSha: session.headSha },
      target: { mode: 'range', from: session.baseSha, to: session.headSha },
      ocr: { version: '1.12.4', ruleGroups: 3 },
      reviewableFiles: ['src/a.mjs', 'src/b.mjs'],
      excludedFiles: [{ path: 'dist/x.js', reason: 'generated' }],
      reviewedFiles: ['src/a.mjs', 'src/b.mjs'],
      skippedFiles: [],
      coverageRate: 1,
      findings: [{ path: 'src/a.mjs', content: 'null check missing', startLine: 10, endLine: 12, category: 'bug', severity: 'high' }],
      reflectionCompleted: true,
      durationMs: 42,
    },
    digest: 'd'.repeat(64),
    findingsCount: 1,
  };
}

// ---- unwrap ----
tru('unwrap leg value', unwrapReviewEvidence(mkEvidence()) !== null);
eq('unwrap digest', unwrapReviewEvidence(mkEvidence()).digest, 'd'.repeat(64));
eq('unwrap legacy null', unwrapReviewEvidence({ verdict: 'PASS', findings: [], confidence: 1, metadata: {} }), null);
eq('unwrap null null', unwrapReviewEvidence(null), null);

// ---- secondary rendering ----
{
  const sec = renderSecondaryPreReview(mkEvidence()).join('\n');
  tru('evidence section labeled informational', sec.includes('INFORMATIONAL') || sec.includes('informational'));
  tru('no verdict carried', !/verdict/i.test(sec.replace('NO verdict exists', '')));
  tru('binding facts present', sec.includes('duongpdddic-droid/soc_brain#77'));
  tru('target facts present', sec.includes('range'));
  tru('scope facts present', sec.includes('2 reviewable') && sec.includes('skipped []') && sec.includes('coverageRate 1'));
  tru('exclusion reason present', sec.includes('generated'));
  tru('finding content present', sec.includes('null check missing'));
  tru('digest present', sec.includes('d'.repeat(64)));
  tru('reflection present', sec.includes('reflectionCompleted: true'));
  const legacy = renderSecondaryPreReview({ verdict: 'REWORK', findings: ['x'], confidence: 0.5, metadata: {} }).join('\n');
  tru('legacy dead-compat renders', legacy.includes('Gemini pre-review verdict'));
  const none = renderSecondaryPreReview(null).join('\n');
  tru('unavailable note', none.includes('unavailable'));
}

// ---- full prompt: canonical FIRST, evidence SECONDARY, GPT sole authority ----
{
  const p = buildFinalReviewPrompt({ session, report, ledger, packet, preReview: mkEvidence() });
  const iPacket = p.indexOf('Canonical packet body');
  const iSecondary = p.indexOf('SECONDARY');
  tru('canonical first', iPacket >= 0 && iPacket < iSecondary);
  tru('sole-authority language', p.includes('Your verdict is the only review authority'));
  tru('do-not-anchor', p.includes('do not') && p.includes('anchor'));
  tru('may be wrong', p.includes('may be wrong'));
  tru('evidence digest in prompt', p.includes('d'.repeat(64)));
  // No pre-review verdict anywhere in the evidence section.
  const sec = p.slice(iSecondary);
  tru('no verdict field in evidence handoff', !/"verdict"\s*:/.test(sec));
  // Binding echo targets unchanged.
  tru('binding echo intact', p.includes('"repository": "duongpdddic-droid/soc_brain"') && p.includes('"issue": 77'));
  // Legacy still renders dead-compat (existing regression intact).
  const pl = buildFinalReviewPrompt({ session, report, ledger, packet, preReview: { verdict: 'REWORK', findings: ['gemini-thinks-x'], confidence: 0.4, metadata: {} } });
  tru('legacy compat intact', pl.includes('gemini-thinks-x'));
  void mkStateDir;
}

// ---- summary ----
const failed = checks.filter((c) => !c.ok);
for (const c of checks) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : ` | got=${JSON.stringify(c.got)} want=${JSON.stringify(c.want)}`}`);
}
console.log(`review-leg-gpt-handoff: ${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
