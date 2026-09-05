#!/usr/bin/env node
// e2e-advisor-control-path.mjs — REAL control-loop E2E for Issue #63.
//
// Proves the full bounded loop with REAL models (no mock, no fake):
//   1. Cline-side client spawns the advisor MCP over stdio (exact transport Cline uses).
//   2. advisor.ping  -> health.
//   3. Canonical task packet built from REAL git facts of this worktree;
//      stateDigest = sha256(canonical state text).
//   4. advisor.ask (REAL GPT via OpenRouter) -> structured decision, echo binding verified.
//   5. Cline follows the decision: deterministic verification runs
//      (`node --test tests/advisor-mcp.test.mjs` in this worktree).
//   6. advisor.second_opinion (REAL Gemini via OpenRouter) — mandated by the
//      bootstrap policy (at least one explicit second opinion per E2E).
//   7. Canonical checkpoint persisted OUTSIDE the repo (~/.soc-brain/e2e/),
//      atomic write, includes every binding + exit code. Telegram TASK_COMPLETED
//      is sent by the orchestrating executor AFTER this script exits 0.
//
// Exit 0 = every step verified. Exit 1 = fail-closed at the first unverified step.

import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKTREE = path.resolve(HERE, '..');
const SERVER = path.join(WORKTREE, 'packages', 'advisor-mcp', 'advisor-mcp.mjs');
const REPO = 'duongpdddic-droid/Soc_brain';
const TASK_REF = 'Issue #63';
const OUT_DIR = path.join(os.homedir(), '.soc-brain', 'e2e');

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail: String(detail).slice(0, 300) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) throw new Error('E2E_FAIL: ' + name);
}

// ---- stdio MCP client (same JSON-RPC line protocol as Cline uses) -----------

function startServer() {
  const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const resolve = pending.get(msg.id);
      if (resolve) { pending.delete(msg.id); resolve(msg); }
    }
  });
  child.stderr.on('data', (d) => process.stderr.write('[advisor-mcp stderr] ' + d));
  let nextId = 1;
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)); } }, 180_000);
  });
  return { child, call };
}

function toolPayload(res) {
  if (res.error) throw new Error(`toolError ${res.error?.data?.toolError || ''}: ${res.error.message}`);
  return JSON.parse(res.result.content[0].text);
}

// ---- canonical packet from REAL worktree facts -------------------------------

function git(args) {
  return execFileSync('git', args, { cwd: WORKTREE, encoding: 'utf8' }).trim();
}

function buildPacket() {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = git(['rev-parse', 'HEAD']);
  const dirty = git(['status', '--porcelain']);
  const state = JSON.stringify({ repo: REPO, taskRef: TASK_REF, branch, head, dirty }, null, 0);
  return {
    requestId: 'e2e-' + crypto.randomUUID(),
    repo: REPO,
    taskRef: TASK_REF,
    stateDigest: crypto.createHash('sha256').update(state).digest('hex'),
    evidence: state,
    _branch: branch,
    _head: head,
    _dirty: dirty,
  };
}

// ---- main --------------------------------------------------------------------

async function main() {
  const { child, call } = startServer();
  const evidence = { startedAt: new Date().toISOString(), repo: REPO, taskRef: TASK_REF };
  try {
    const init = await call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'e2e-advisor-control-path', version: '0.1.0' } });
    check('initialize', init.result?.serverInfo?.name === 'soc-brain-advisor', init.result?.serverInfo?.version);

    const ping = toolPayload(await call('tools/call', { name: 'advisor.ping', arguments: {} }));
    check('advisor.ping', ping.ok === true && ping.apiKeyPresent === true, JSON.stringify(ping.models));

    const pkt = buildPacket();
    evidence.packet = { requestId: pkt.requestId, stateDigest: pkt.stateDigest, branch: pkt._branch, head: pkt._head };
    check('canonical packet built', /^[0-9a-f]{64}$/.test(pkt.stateDigest), `branch=${pkt._branch} head=${pkt._head.slice(0, 12)}`);

    const ask = toolPayload(await call('tools/call', {
      name: 'advisor.ask',
      arguments: {
        requestId: pkt.requestId,
        repo: pkt.repo,
        taskRef: pkt.taskRef,
        stateDigest: pkt.stateDigest,
        question: 'The advisor MCP package + tests are implemented and 16/16 unit tests PASS in the task worktree. Next steps: register the MCP server in Cline config, run this real E2E, commit, push, open PR, request review. Decision?',
        evidence: pkt.evidence,
      },
    }));
    evidence.gptDecision = ask;
    check('GPT decision valid', ask.ok === true && typeof ask.decision === 'string', `${ask.decision} (model=${ask.modelUsed})`);
    check('GPT binding echo', ask.binds?.stateDigest === pkt.stateDigest && ask.binds?.taskRef === pkt.taskRef && ask.binds?.repo === pkt.repo && ask.requestId === pkt.requestId, 'anti-stale binding verified');
    check('real GPT model', /^openai\//.test(String(ask.modelUsed)), ask.modelUsed);
    console.log(`GPT decision: ${ask.decision} — ${ask.nextAction} (confidence ${ask.confidence})`);
    return { child, call, evidence, pkt, ask, verify: null };
  } finally {
    // caller continues; child closed by runMain
  }
}

// __E2E_PART5__

async function runMain() {
  const started = await main();
  const { child, call, evidence, pkt, ask } = started;

  try {
    // Cline follows the decision: deterministic verification step.
    let verify;
    try {
      const out = execFileSync(process.execPath, ['--test', 'tests/advisor-mcp.test.mjs'], { cwd: WORKTREE, encoding: 'utf8' });
      verify = { code: 0, out };
    } catch (e) {
      verify = { code: e.status ?? 1, out: String(e.stdout || e.message).slice(0, 2000) };
    }
    evidence.verification = { command: 'node --test tests/advisor-mcp.test.mjs', exitCode: verify.code };
    check('deterministic verification (follow decision)', verify.code === 0, 'exit=' + verify.code);

    // Explicit second opinion (Gemini) — mandated once per E2E by bootstrap policy.
    const so = toolPayload(await call('tools/call', {
      name: 'advisor.second_opinion',
      arguments: {
        requestId: 'e2e-so-' + crypto.randomUUID(),
        repo: pkt.repo,
        taskRef: pkt.taskRef,
        stateDigest: pkt.stateDigest,
        question: `GPT decided: ${ask.decision}. Verification exit code: ${verify.code}. Do you concur with continuing the handoff (commit, push, PR, review)?`,
        evidence: pkt.evidence,
      },
    }));
    evidence.geminiSecondOpinion = so;
    check('Gemini second opinion valid', so.ok === true && typeof so.decision === 'string', `${so.decision} (model=${so.modelUsed})`);
    check('real Gemini model', /^google\//.test(String(so.modelUsed)), so.modelUsed);
    console.log(`Gemini second opinion: ${so.decision} — ${so.nextAction} (confidence ${so.confidence})`);

    // Persist canonical checkpoint OUTSIDE the repo (atomic write).
    fs.mkdirSync(OUT_DIR, { recursive: true });
    evidence.completedAt = new Date().toISOString();
    evidence.exitCode = 0;
    const out = path.join(OUT_DIR, `advisor-e2e-${Date.now()}.json`);
    const tmp = out + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(evidence, null, 2));
    fs.renameSync(tmp, out);
    console.log('CHECKPOINT_PERSISTED ' + out);
    console.log('E2E_PASS');
  } finally {
    child.kill();
  }
}

runMain().catch((e) => {
  console.error(String((e && e.message) || e));
  process.exit(1);
});


