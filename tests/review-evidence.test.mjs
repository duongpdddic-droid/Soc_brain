// review-evidence.test.mjs — Issue #1 (OCR migration): behavior equivalence
// between review-evidence.mjs and gemini-pre-review.mjs re-exports.
// No framework. Exit 0 = PASS, 1 = FAIL.
import {
  parsePacketIdentity as parseNew,
  collectPreReviewEvidence as collectNew,
  PRE_REVIEW_PACKET_MAX_BYTES as MAX_NEW,
  PRE_REVIEW_LEDGER_MAX as LEDGER_NEW,
} from '../packages/control-loop/review-evidence.mjs';
import {
  parsePacketIdentity as parseOld,
  collectPreReviewEvidence as collectOld,
  PRE_REVIEW_PACKET_MAX_BYTES as MAX_OLD,
  PRE_REVIEW_LEDGER_MAX as LEDGER_OLD,
} from '../packages/control-loop/gemini-pre-review.mjs';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { identityHash } from '../packages/workspace/workspace.mjs';

const checks = [];
const eq = (n, g, w) => checks.push({ name: n, ok: g === w, got: g, want: w });
const tru = (n, g) => checks.push({ name: n, ok: Boolean(g), got: g });
const falsy = (n, g) => checks.push({ name: n, ok: !g, got: g });

function mkStateDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'rev-ev-')); }

function mkSession(stateDir, overrides = {}) {
  const repo = overrides.repo || 'duongpdddic-droid/soc_brain';
  const issueNumber = overrides.issueNumber || 75;
  const id = identityHash({ repo, issueNumber });
  const sessionPath = path.join(stateDir, 'sessions', `${id}.json`);
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  const session = {
    schemaVersion: '1',
    state: 'SESSION_ACTIVE',
    lifecycle: [],
    taskId: `${repo}#${issueNumber}`,
    repo,
    issueNumber,
    headSha: 'a'.repeat(40),
    baseSha: 'f'.repeat(40),
    worktreePath: path.join(stateDir, `wt-issue-${issueNumber}`),
    worktreesRoot: stateDir,
    ...overrides,
  };
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf8');
  return { sessionPath, session, id };
}

function mkPacket(stateDir, session, body = null) {
  const dir = path.join(stateDir, 'review-ready');
  fs.mkdirSync(dir, { recursive: true });
  const slug = String(session.repo).replace(/\//g, '_');
  const name = `${slug}_Issue-${session.issueNumber}_PR-76_abcdef0_review-ready.md`;
  const head = typeof session.headSha === 'string' && /^[0-9a-f]{40}$/i.test(session.headSha)
    ? session.headSha.toLowerCase()
    : 'a'.repeat(40);
  const content = body === null
    ? [
        `# Review Ready — ${session.repo} Issue #${session.issueNumber} · PR #76`,
        '',
        '## Identity',
        `- repository: ${session.repo}`,
        `- issue: ${session.issueNumber}`,
        '- pullRequest: 76',
        '- branch: agent/test',
        `- headSha: ${head} (short ${head.slice(0, 7)})`,
        `- baseSha: ${'b'.repeat(40)}`,
        '- prState: OPEN',
        '',
        'Canonical packet body for review-evidence equivalence.',
      ].join('\n')
    : body;
  fs.writeFileSync(path.join(dir, name), content, 'utf8');
  return { dir, name, content };
}

// ---- 1. bounds identity ----
eq('bounds PACKET_MAX_BYTES identical', MAX_NEW, MAX_OLD);
eq('bounds LEDGER_MAX identical', LEDGER_NEW, LEDGER_OLD);
eq('bounds PACKET_MAX_BYTES value', MAX_NEW, 64 * 1024);
eq('bounds LEDGER_MAX value', LEDGER_NEW, 50);

// ---- 2. packet identity parity ----
{
  const good = [
    '# Review Ready — duongpdddic-droid/soc_brain Issue #75 · PR #76', '',
    '## Identity', '- repository: duongpdddic-droid/soc_brain', '- issue: 75',
    '- pullRequest: 76', '- branch: agent/test',
    `- headSha: ${'A'.repeat(40)} (short aaaaaaa)`, `- baseSha: ${'b'.repeat(40)}`, '- prState: OPEN',
  ].join('\n');
  eq('identity valid equivalent', JSON.stringify(parseNew(good)), JSON.stringify(parseOld(good)));
  eq('identity lowercases headSha', parseNew(good).headSha, 'a'.repeat(40));
  for (const bad of ['', 'no identity', '- repository: x\n- issue: 1\n']) {
    eq(`identity invalid equivalent (${JSON.stringify(bad).slice(0, 24)})`,
      JSON.stringify(parseNew(bad)), JSON.stringify(parseOld(bad)));
  }
  falsy('identity invalid ok=false', parseNew('no identity block').ok);
}

// ---- 3. collection parity: valid / bounded / fail-closed ----
{
  const stateDir = mkStateDir();
  const { sessionPath, session } = mkSession(stateDir);
  const noDir = path.join(stateDir, 'no-such-dir');
  eq('collect no-packet equivalent',
    JSON.stringify(collectNew({ sessionPath, report: {}, reviewReadyDir: noDir })),
    JSON.stringify(collectOld({ sessionPath, report: {}, reviewReadyDir: noDir })));
  eq('collect no-packet code', collectNew({ sessionPath, report: {}, reviewReadyDir: noDir }).code, 'NO_REVIEW_PACKET');

  const packet = mkPacket(stateDir, session);
  const evN = collectNew({ sessionPath, report: { verdict: 'PASS', findings: [] }, reviewReadyDir: packet.dir });
  const evO = collectOld({ sessionPath, report: { verdict: 'PASS', findings: [] }, reviewReadyDir: packet.dir });
  tru('collect valid ok', evN.ok === true && evO.ok === true);
  eq('collect excerpt verbatim + equivalent', evN.packet.excerpt, packet.content);
  eq('collect excerpt equivalent', evN.packet.excerpt, evO.packet.excerpt);
  eq('collect name equivalent', evN.packet.name, evO.packet.name);
  eq('collect truncated equivalent', evN.packet.truncated, evO.packet.truncated);
  eq('collect ledger equivalent', JSON.stringify(evN.ledger), JSON.stringify(evO.ledger));

  const big = packet.content + '\n' + 'B'.repeat(MAX_NEW + 123);
  fs.writeFileSync(path.join(packet.dir, packet.name), big, 'utf8');
  const evB = collectNew({ sessionPath, report: {}, reviewReadyDir: packet.dir });
  tru('collect bounded', evB.packet.excerpt.length <= MAX_NEW);
  tru('collect truncation flagged', evB.packet.truncated === true);

  const foreign = [
    '# Review Ready — someone-else/repo Issue #1 · PR #76', '', '## Identity',
    '- repository: someone-else/repo', '- issue: 1', '- pullRequest: 76', '- branch: x',
    `- headSha: ${'a'.repeat(40)} (short aaaaaaa)`, `- baseSha: ${'b'.repeat(40)}`, '- prState: OPEN', '', 'foreign',
  ].join('\n');
  fs.writeFileSync(path.join(packet.dir, packet.name), foreign, 'utf8');
  const evF = collectNew({ sessionPath, report: {}, reviewReadyDir: packet.dir });
  eq('collect foreign code', evF.code, 'REVIEW_PACKET_IDENTITY_MISMATCH');
  eq('collect foreign equivalent', JSON.stringify(evF), JSON.stringify(collectOld({ sessionPath, report: {}, reviewReadyDir: packet.dir })));

  fs.writeFileSync(path.join(packet.dir, packet.name), 'no identity block here', 'utf8');
  eq('collect identity-less code', collectNew({ sessionPath, report: {}, reviewReadyDir: packet.dir }).code, 'REVIEW_PACKET_IDENTITY_MISMATCH');
}

// ---- 4. report normalization parity ----
{
  const stateDir = mkStateDir();
  const { sessionPath, session } = mkSession(stateDir);
  const packet = mkPacket(stateDir, session);
  for (const report of [null, 'str', { verdict: 'PASS' }]) {
    eq(`collect report parity (${JSON.stringify(report)})`,
      JSON.stringify(collectNew({ sessionPath, report, reviewReadyDir: packet.dir }).report),
      JSON.stringify(collectOld({ sessionPath, report, reviewReadyDir: packet.dir }).report));
  }
}

// ---- 5. Issue 1R: evidence graph acyclic along the review path ----
// review-evidence -> {control-loop (readTransitions), review-packet}; it must
// never import adapters/gemini/gpt. review-packet is a leaf: only stdlib +
// runtime-sandbox + review-ready. adapters -> gemini/gpt factories stay the
// only factory edge; control-loop no longer imports adapters.
{
  const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
  const evSrc = read('../packages/control-loop/review-evidence.mjs');
  const pktSrc = read('../packages/control-loop/review-packet.mjs');
  const loopSrc = read('../packages/control-loop/control-loop.mjs');
  // Match import statements only (comments may legitimately name modules).
  const importsOf = (src, mod) => new RegExp(`^\\s*import[\\s\\S]*?['"]\\./${mod}['"]`, 'm').test(src)
    || new RegExp(`export\\s*\\{[\\s\\S]*?\\}\\s*from\\s*['"]\\./${mod}['"]`, 'm').test(src);
  for (const mod of ['adapters.mjs', 'gemini-pre-review.mjs', 'gpt-final-review.mjs']) {
    falsy(`review-evidence never imports ${mod}`, importsOf(evSrc, mod));
    falsy(`review-packet never imports ${mod}`, importsOf(pktSrc, mod));
  }
  falsy('review-evidence never imports review-packet cycle back (packet is leaf)',
    importsOf(pktSrc, 'review-evidence.mjs'));
  tru('review-evidence reads ledger via control-loop', importsOf(evSrc, 'control-loop.mjs'));
  tru('review-evidence resolves packets via leaf review-packet', importsOf(evSrc, 'review-packet.mjs'));
  tru('control-loop resolves packets via leaf review-packet (not adapters)', importsOf(loopSrc, 'review-packet.mjs'));
  falsy('control-loop no longer imports adapters', importsOf(loopSrc, 'adapters.mjs'));
  // Single definition: no duplicate implementation of either symbol.
  const evDefs = (evSrc.match(/export function (parsePacketIdentity|collectPreReviewEvidence)/g) || []).length;
  const pktDefs = (pktSrc.match(/export function packetPathFor/g) || []).length;
  eq('single definition: evidence fns defined once', evDefs, 2);
  eq('single definition: packetPathFor defined once', pktDefs, 1);
}

// ---- summary ----
const failed = checks.filter((c) => !c.ok);
for (const c of checks) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : ` | got=${JSON.stringify(c.got)} want=${JSON.stringify(c.want)}`}`);
}
console.log(`review-evidence: ${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
