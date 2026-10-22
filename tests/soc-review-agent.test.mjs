// tests/soc-review-agent.test.mjs — soc_review instruction contract.
// Locks the Operator-mandated review posture: adversarial in-scope finding hunt
// for review/final review, no trust in executor reports or OCR, and a read-only
// shell allowlist (OpenCode V2 `permissions`, action `shell`).
// Offline only: reads the checked-in agent file, no network, no mutation.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const AGENT_PATH = path.join(ROOT, '.opencode', 'agents', 'soc_review.md');

function readAgent() {
  assert.ok(fs.existsSync(AGENT_PATH), `missing agent file: ${AGENT_PATH}`);
  return fs.readFileSync(AGENT_PATH, 'utf8');
}

function allowsShell(raw, commandPattern) {
  const escaped = commandPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `action:\\s*shell[\\s\\S]{0,80}?resource:\\s*"${escaped}"[\\s\\S]{0,40}?effect:\\s*allow`,
  ).test(raw);
}

function deniesShell(raw, resourcePattern) {
  const escaped = resourcePattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`resource:\\s*"${escaped}"[\\s\\S]{0,40}?effect:\\s*deny`).test(raw);
}

test('R1. reviewer posture: adversarial finding hunt in scope, primary + subagent', () => {
  const raw = readAgent();
  assert.match(raw, /^mode:\s*all\s*$/m,
    'soc_review must stay usable as both primary and subagent');
  assert.match(raw, /REVIEW POSTURE/i, 'must define an explicit review-posture section');
  assert.match(raw, /soi mói|adversarial/i,
    'must require an adversarial hunt for findings, not confirmation of the patch');
  assert.match(raw, /final review/i, 'must cover final review explicitly');
  assert.match(raw, /caller\/consumer|callers?|consumers?/i,
    'must extend the hunt to directly affected callers/consumers');
  assert.match(raw, /trong scope|in scope/i,
    'must bound the hunt to the assigned scope');
  assert.match(raw, /không bịa|do not invent|never invent/i,
    'must forbid invented findings, line numbers or SHAs');
});

test('R2. reviewer must not trust executor reports or OCR evidence', () => {
  const raw = readAgent();
  assert.match(raw, /không tin|do not trust|never trust/i,
    'must state that executor reports are not trusted');
  assert.match(raw, /OCR/i, 'must name OCR explicitly');
  assert.match(raw, /tool_calls\s*=\s*0/, 'must name the weak OCR signal');
  assert.match(raw, /WEAK/i, 'must classify a 0-finding/tool_calls=0 result as WEAK');
  assert.match(raw, /UNAVAILABLE \(weak evidence\)/,
    'must record weak evidence as UNAVAILABLE (weak evidence)');
  assert.match(raw, /báo cáo|reports?/i, 'must name reports as leads, never as evidence');
  assert.match(raw, /FACT[\s\S]{0,40}INFERENCE[\s\S]{0,40}UNKNOWN/i,
    'must keep the FACT / INFERENCE / UNKNOWN honesty split');
  assert.doesNotMatch(raw, /Shell execution is denied in this profile/i,
    'the old blanket shell denial must not survive');
});

test('R4. project config exposes soc_review as primary as well as subagent', () => {
  const cfgPath = path.join(ROOT, '.opencode', 'opencode.json');
  assert.ok(fs.existsSync(cfgPath), `missing project config: ${cfgPath}`);
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const agents = cfg.agents || cfg.agent || {};
  const agent = agents.soc_review;
  assert.ok(agent, 'project config must define agents.soc_review');
  assert.equal(agent.mode, 'all',
    'agents.soc_review.mode must be "all" so the Operator can run it as primary and as subagent');
});

test('R5. shell allowlist cannot be chained or escalated into mutation/exec', () => {
  const raw = readAgent();
  // A prefix allowlist is only fail-closed if chaining/splicing metacharacters
  // and argument-level execution flags are re-denied AFTER the allows.
  const forbidden = [
    '*;*', '*&&*', '*&*', '*|*', '*$(*', '*`*', '*>*', '*<*',
    '*--pre*', '*--import*', '*--require*', '*--loader*', '*--output*',
  ];
  for (const pattern of forbidden) {
    assert.ok(deniesShell(raw, pattern),
      `shell resource pattern "${pattern}" must stay denied after the allowlist`);
  }
  // No blanket shell allow may exist at all.
  assert.doesNotMatch(raw, /action:\s*shell\s*\n\s*resource:\s*"\*"\s*\n\s*effect:\s*allow/,
    'a blanket shell allow would defeat the whole read-only boundary');
});

test('R3. read-only shell is allowed by V2 permissions; mutation stays denied', () => {
  const raw = readAgent();
  // Read-only inspection commands the reviewer may run to verify evidence.
  for (const cmd of ['git status *', 'git diff *', 'git show *', 'git log *',
    'git rev-parse *', 'git merge-base *', 'gh pr view *', 'node --test *',
    'Get-Content *', 'Select-String *']) {
    assert.ok(allowsShell(raw, cmd), `read-only shell allowlist must permit "${cmd}"`);
  }
  // Still read-only overall: edits denied and obvious write paths denied.
  assert.match(raw, /action:\s*edit[\s\S]{0,40}?effect:\s*deny/,
    'edit must stay denied');
  assert.ok(raw.includes('"*--output*"'),
    'shell writes via --output must be denied explicitly');
  assert.match(raw, /--output[\s\S]{0,60}?effect:\s*deny/,
    'the --output deny must take effect after the allowlist');
  // The body must state the mutation ban and the read-only boundary.
  for (const banned of ['git push', 'git reset', 'git clean', 'git checkout', 'git commit']) {
    assert.ok(raw.includes(banned), `mutation ban must name "${banned}"`);
  }
  assert.match(raw, /shell chỉ đọc|read-only shell/i,
    'body must state that only read-only shell is allowed');
  assert.match(raw, /không chắc read-only|not sure|unsure|mutation/i,
    'body must require stopping when a command may mutate');
});
