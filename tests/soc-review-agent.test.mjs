// tests/soc-review-agent.test.mjs — soc_review instruction contract.
// Locks the Operator-mandated review posture: adversarial in-scope finding hunt
// for review/final review, no trust in executor reports or OCR, and a read-only
// shell allowlist (OpenCode V2 `permissions`, action `shell`).
// The allowlist is classified with the documented V2 semantics (whole-value
// wildcards, last match wins, no match => ask), so a moved/reordered rule or a
// wildcard regression makes these tests fail instead of passing on raw text.
// Offline only: reads the checked-in agent file, no network, no mutation.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const AGENT_PATH = path.join(ROOT, '.opencode', 'agents', 'soc_review.md');
const CONFIG_PATH = path.join(ROOT, '.opencode', 'opencode.json');

function readAgent() {
  assert.ok(fs.existsSync(AGENT_PATH), `missing agent file: ${AGENT_PATH}`);
  return fs.readFileSync(AGENT_PATH, 'utf8');
}

function readProjectAgentConfig() {
  assert.ok(fs.existsSync(CONFIG_PATH), `missing project config: ${CONFIG_PATH}`);
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const agents = cfg.agents || cfg.agent || {};
  return { cfg, agent: agents.soc_review };
}

function clean(value) {
  return value.trim().replace(/^["']|["']$/g, '');
}

// Minimal parser for the agent's V2 permission rule-list. It reads only the
// frontmatter block and only the three documented fields.
function parseFrontmatterRules(raw) {
  const frontmatter = raw.split(/^---$/m)[1] || '';
  const rules = [];
  let current = null;
  for (const line of frontmatter.split(/\r?\n/)) {
    const action = line.match(/^\s*-\s*action:\s*(.+?)\s*$/);
    if (action) {
      if (current) rules.push(current);
      current = { action: clean(action[1]) };
      continue;
    }
    const resource = line.match(/^\s*resource:\s*(.+?)\s*$/);
    if (resource && current) { current.resource = clean(resource[1]); continue; }
    const effect = line.match(/^\s*effect:\s*(.+?)\s*$/);
    if (effect && current) { current.effect = clean(effect[1]); continue; }
  }
  if (current) rules.push(current);
  return rules;
}

function globToRegExp(pattern) {
  let out = '^';
  for (const ch of pattern) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${out}$`, 'i');
}

function resourceMatches(pattern, value) {
  // Documented V2 special case: a shell pattern ending in " *" also matches
  // the command without arguments.
  if (pattern.endsWith(' *') && value === pattern.slice(0, -2)) return true;
  return globToRegExp(pattern).test(value);
}

function classify(rules, action, resource) {
  let effect = 'ask'; // documented V2 default when no rule matches
  for (const rule of rules) {
    if (rule.action !== '*' && rule.action !== action) continue;
    if (!resourceMatches(rule.resource, resource)) continue;
    effect = rule.effect; // last match wins
  }
  return effect;
}

// Effective policy = config agent rules (lower priority) + agent file rules
// (appended last), exactly as OpenCode documents the merge order.
function effectiveRules() {
  const { agent } = readProjectAgentConfig();
  const configRules = Array.isArray(agent.permissions) ? agent.permissions : [];
  return [...configRules, ...parseFrontmatterRules(readAgent())];
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

test('R3. project config exposes soc_review as primary as well as subagent', () => {
  const { agent } = readProjectAgentConfig();
  assert.ok(agent, 'project config must define agents.soc_review');
  assert.equal(agent.mode, 'all',
    'agents.soc_review.mode must be "all" so the Operator can run it as primary and as subagent');
});

test('R4. a single permission source: no V1 wildcard map beside the V2 rule-list', () => {
  const { agent } = readProjectAgentConfig();
  assert.equal(agent.permission, undefined,
    'the V1 permission map ("*": "allow", terminal: "allow") contradicts the deny-first rule-list');
  assert.equal(agent.permissions, undefined,
    'duplicating rules in config makes the effective order ambiguous; the agent file stays the single source');
});

test('R5. read-only shell is allowed; mutation, exec and test runs are denied', () => {
  const rules = effectiveRules();
  for (const cmd of ['git status', 'git status --short', 'git diff --stat',
    'git show HEAD', 'git log -1', 'git rev-parse HEAD', 'git merge-base origin/main HEAD',
    'gh pr view 311', 'Get-ChildItem .', 'Test-Path README.md', 'Get-FileHash README.md']) {
    assert.equal(classify(rules, 'shell', cmd), 'allow', `read-only shell must allow "${cmd}"`);
  }
  for (const cmd of ['git push', 'git commit -m x', 'git checkout main', 'git reset --hard',
    'git clean -fd', 'git status; git push', 'Get-Content x | Remove-Item y',
    'Out-File x', 'git diff --output=x', 'node --test tests/x.test.mjs',
    'rg --pre calc x', 'rg -uu .', 'rg x', 'Get-Content README.md', 'Get-Content *',
    'Select-String -Path x -Pattern y', 'Select-String -Path * -Pattern .',
    'Get-Content (Remove-Item -LiteralPath x -Force)', 'Test-Path (git push)',
    'git remote -v', 'git config --list', 'git config --get user.name',
    'Get-ChildItem Env:', 'Get-Item Env:GH_TOKEN', 'Get-Item HKCU:\\Environment',
    'Get-Content .env', 'Get-Content server.pem', 'Get-Content id_rsa']) {
    assert.equal(classify(rules, 'shell', cmd), 'deny', `shell must deny "${cmd}"`);
  }
  // Test execution is code execution, not read-only.
  assert.equal(allowsShell(readAgent(), 'node --test *'), false,
    'node --test must not remain in the read-only allowlist');
});

test('R6. secret read boundary is enforced by config, not only prose', () => {
  const rules = effectiveRules();
  assert.equal(classify(rules, 'read', '.env'), 'deny');
  assert.equal(classify(rules, 'read', 'config/.env.local'), 'deny');
  assert.equal(classify(rules, 'read', 'server.pem'), 'deny');
  assert.equal(classify(rules, 'read', 'server.key'), 'deny');
  assert.equal(classify(rules, 'read', '.env.example'), 'allow',
    'a template without secrets stays reviewable');
  assert.equal(classify(rules, 'read', 'src/app.js'), 'allow');
});

test('R8. multi-line shell text is never classified as allow (F6 probe)', () => {
  const rules = effectiveRules();
  // `*` is a documented whole-value wildcard; a newline in the command must
  // never silently satisfy an allow rule. "ask" is acceptable fail-closed
  // behaviour for a non-interactive reviewer; "allow" is not.
  assert.notEqual(classify(rules, 'shell', 'git status\ngit push'), 'allow');
  assert.notEqual(classify(rules, 'shell', 'git status\r\ngit push'), 'allow');
});

test('R7. chaining/exec deny rules are ordered after the allowlist (last match wins)', () => {
  const raw = readAgent();
  const lastAllow = raw.lastIndexOf('effect: allow');
  assert.ok(lastAllow > 0, 'the allowlist must exist');
  const forbidden = [
    '*;*', '*&&*', '*&*', '*|*', '*$(*', '*`*', '*>*', '*<*', '*(*', '*)*',
    '*--pre*', '*--import*', '*--require*', '*--loader*', '*--test-reporter*',
    '*--ext-diff*', '*--textconv*', '*--output*', '*--hidden*', '*--unrestricted*',
    '*--no-ignore*', '*-uu*', '*Env:*', '*Variable:*', '*HKCU:*', '*HKLM:*', '*Cert:*',
    '*.env*', '*.pem*', '*.key*', '*.pfx*', '*.p12*', '*id_rsa*', '*id_ed25519*',
  ];
  for (const pattern of forbidden) {
    assert.ok(deniesShell(raw, pattern),
      `shell resource pattern "${pattern}" must be denied`);
    assert.ok(raw.indexOf(`resource: "${pattern}"`) > lastAllow,
      `deny "${pattern}" must come AFTER the allowlist (last match wins)`);
  }
  // No blanket shell allow may exist at all.
  assert.doesNotMatch(raw, /action:\s*shell\s*\n\s*resource:\s*"\*"\s*\n\s*effect:\s*allow/,
    'a blanket shell allow would defeat the whole read-only boundary');
});
