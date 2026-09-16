import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { identityHash } from '../packages/workspace/workspace.mjs';
import { sessionPathFor, HUMAN_GATE_STATES } from '../packages/runtime-sandbox/runtime-sandbox.mjs';
import { executionRecordPath } from '../packages/executor-launcher/executor-launcher.mjs';
import { reconcileExecutorExit } from '../packages/control-loop/executor-exit-projection.mjs';
import { pinFollow } from '../packages/client-mcp/follow-binding.mjs';

const REPO = 'duongpdddic-droid/soc_brain';
const BASE = '1aded9a3bba83473c5ab6432c7c42669a10fe34e';
const HEAD = '0b29a1011111111111111111111111111111aaaa';
const w = (o) => JSON.stringify(o);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'soc-ocplugin-'));
const clock = () => '2026-09-16T00:00:00.000Z';

function lay({ stateDir, issueNumber, session = {} }) {
  const id = identityHash({ repo: REPO, issueNumber });
  fs.mkdirSync(path.join(stateDir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'executions'), { recursive: true });
  const sp = sessionPathFor({ stateDir, identityHash: id });
  const wt = path.join(stateDir, 'wt', id);
  fs.writeFileSync(sp, w({
    schemaVersion: '1', taskId: `${REPO}#${issueNumber}`, repo: REPO, issueNumber,
    state: 'SESSION_ACTIVE', baseSha: BASE, branch: `agent/${id}`, worktreePath: wt, headSha: BASE,
    executionMode: 'executor', mutationOwner: { laneId: 'client-plane', acquiredVia: 'ADMISSION' },
    lease: { token: 'lt-' + id }, lifecycle: [], controlPlane: { stateDir }, ...session,
  }) + '\n', 'utf8');
  fs.writeFileSync(executionRecordPath({ stateDir, identityHash: id }), w({
    schemaVersion: '1', kind: 'ExecutionRecord', identityHash: id, taskId: `${REPO}#${issueNumber}`,
    repo: REPO, issueNumber, baseSha: BASE, branch: `agent/${id}`, worktreePath: wt, executor: 'opencode',
    pid: 4242, startedAt: 1, finishedAt: 2, exitCode: 0, signal: null, terminalStatus: 'EXITED', finalized: true, processStartTime: 111,
  }) + '\n', 'utf8');
  return { id, wt };
}

// Faithful double of the OpenCode 1.18.27 V1 SDK `client` surface the plugin uses
// (signatures per @opencode-ai/sdk/dist/gen/sdk.gen.d.ts): session.get/update
// (title via body.title — there is no session.rename) and tui.showToast.
function makeClient() {
  const titles = {}; const toasts = [];
  return {
    _titles: titles, _toasts: toasts,
    session: {
      async get({ path: p }) { return { data: { id: p.id, title: titles[p.id] ?? 'Soc_brain task' } }; },
      async update({ path: p, body }) { titles[p.id] = body.title; return { data: { id: p.id, title: body.title } }; },
    },
    tui: { async showToast({ body }) { toasts.push(body); return {}; } },
  };
}

async function withIntervalCaptured(fn) {
  const realSI = global.setInterval; const realCI = global.clearInterval;
  const cbs = [];
  global.setInterval = (cb) => { cbs.push(cb); return { __fake: true, unref() {} }; };
  global.clearInterval = (h) => { if (h && h.__fake) cbs.splice(cbs.indexOf(() => {}), 0); };
  try { return await fn(cbs); } finally { global.setInterval = realSI; global.clearInterval = realCI; }
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

async function loadPlugin() { return import('../.opencode/plugins/soc-attached-observability.js'); }

test('F4 plugin: real OpenCode V1 client receives the automatic surface (session.update title + toast) with ZERO status polling', async () => {
  const stateDir = tmp(); const issueNumber = 9000801;
  const { id } = lay({ stateDir, issueNumber });
  await reconcileExecutorExit({ stateDir, repo: REPO, issueNumber, headReader: () => BASE, livenessProbe: (r) => ({ liveness: r.terminalStatus, identityProven: true }), now: clock });
  pinFollow({ stateDir, repo: REPO, issueNumber, identityHash: id });
  process.env.SOC_CONTROL_STATE_DIR = stateDir;
  const client = makeClient();
  const mod = await loadPlugin();
  await withIntervalCaptured(async (cbs) => {
    const hooks = await mod.SocAttachedObservabilityPlugin({ client });
    // ONE submit in this session -> follower attaches; NO get_task/get_progress/follow call by the user.
    await hooks['tool.execute.after'](
      { tool: 'soc-brain-client_soc.submit_goal', sessionID: 'sessA', callID: 'c1', args: {} },
      { title: '', output: w({ ok: true, repo: REPO, issueNumber, identityHash: id }), metadata: { ok: true, repo: REPO, issueNumber, identityHash: id } },
    );
    assert.ok(cbs.length >= 1, 'follower registered an automatic watch (interval), not a user poll');
    cbs.forEach((cb) => cb()); // advance time
    await flush();
    const title = client._titles.sessA || '';
    assert.match(title, /#9000801/, 'session title carries the task');
    assert.match(title, /BLOCKED \(recoverable\)/, 'session title surfaces the RECOVERABLE_BLOCKED state automatically');
    assert.ok(client._toasts.some((t) => /RECOVERABLE_BLOCKED/.test(t.title)), 'a real toast shows the transition');
    // dedupe: re-tick with unchanged durable state adds no new title update churn
    const before = client._titles.sessA; cbs.forEach((cb) => cb()); await flush();
    assert.equal(client._titles.sessA, before, 'unchanged seq -> no repeated surface (dedupe)');
    if (hooks.dispose) await hooks.dispose();
  });
});

test('F4 plugin: READY_FOR_REVIEW surfaces automatically after a committed+verified exit (no polling)', async () => {
  const stateDir = tmp(); const issueNumber = 9000802;
  const { id } = lay({ stateDir, issueNumber });
  await reconcileExecutorExit({ stateDir, repo: REPO, issueNumber, headReader: () => HEAD, livenessProbe: (r) => ({ liveness: r.terminalStatus, identityProven: true }), now: clock });
  pinFollow({ stateDir, repo: REPO, issueNumber, identityHash: id });
  process.env.SOC_CONTROL_STATE_DIR = stateDir;
  const client = makeClient();
  const mod = await loadPlugin();
  await withIntervalCaptured(async (cbs) => {
    const hooks = await mod.SocAttachedObservabilityPlugin({ client });
    await hooks['tool.execute.after']({ tool: 'soc-brain-client_soc.submit_goal', sessionID: 'sessB', callID: 'c', args: {} }, { output: w({ ok: true, repo: REPO, issueNumber, identityHash: id }), metadata: { repo: REPO, issueNumber, identityHash: id } });
    cbs.forEach((cb) => cb()); await flush();
    assert.match(client._titles.sessB || '', /READY_FOR_REVIEW/);
    assert.ok(client._toasts.some((t) => /READY_FOR_REVIEW/.test(t.title)));
    if (hooks.dispose) await hooks.dispose();
  });
});

test('F4 plugin: operational fields only — no chain-of-thought ever rendered', async () => {
  const stateDir = tmp(); const issueNumber = 9000803;
  const { id } = lay({ stateDir, issueNumber });
  pinFollow({ stateDir, repo: REPO, issueNumber, identityHash: id });
  process.env.SOC_CONTROL_STATE_DIR = stateDir;
  const client = makeClient();
  const mod = await loadPlugin();
  await withIntervalCaptured(async (cbs) => {
    const hooks = await mod.SocAttachedObservabilityPlugin({ client });
    await hooks['tool.execute.after']({ tool: 'soc.recover', sessionID: 'sessC', callID: 'c', args: {} }, { output: w({ ok: true, repo: REPO, issueNumber, identityHash: id, currentTaskIdentity: { repo: REPO, issueNumber, identityHash: id } }), metadata: {} });
    cbs.forEach((cb) => cb()); await flush();
    const blob = JSON.stringify(client._titles) + JSON.stringify(client._toasts);
    assert.ok(!/thinking|reasoning|chain[_ ]of[_ ]thought|<thinking>/i.test(blob), 'no reasoning content surfaced');
    if (hooks.dispose) await hooks.dispose();
  });
});

test('F4 plugin: per-session isolation (two OpenCode sessions follow different tasks)', async () => {
  const stateDir = tmp();
  const A = 9000804, B = 9000805;
  const a = lay({ stateDir, issueNumber: A });
  lay({ stateDir, issueNumber: B, session: { state: 'WAITING_FOR_INPUT', humanGate: { state: 'WAITING_FOR_INPUT', at: 'g' } } });
  await reconcileExecutorExit({ stateDir, repo: REPO, issueNumber: A, headReader: () => HEAD, livenessProbe: (r) => ({ liveness: r.terminalStatus, identityProven: true }), now: clock });
  process.env.SOC_CONTROL_STATE_DIR = stateDir;
  const client = makeClient();
  const mod = await loadPlugin();
  await withIntervalCaptured(async (cbs) => {
    const hooks = await mod.SocAttachedObservabilityPlugin({ client });
    await hooks['tool.execute.after']({ tool: 'soc.submit_goal', sessionID: 'sA', callID: '1', args: {} }, { output: w({ ok: true, repo: REPO, issueNumber: A, identityHash: a.id }), metadata: { repo: REPO, issueNumber: A, identityHash: a.id } });
    await hooks['tool.execute.after']({ tool: 'soc.submit_goal', sessionID: 'sB', callID: '2', args: {} }, { output: w({ ok: true, repo: REPO, issueNumber: B, identityHash: identityHash({ repo: REPO, issueNumber: B }) }), metadata: { repo: REPO, issueNumber: B, identityHash: identityHash({ repo: REPO, issueNumber: B }) } });
    cbs.forEach((cb) => cb()); await flush();
    assert.match(client._titles.sA, /READY_FOR_REVIEW/);
    assert.match(client._titles.sB, /HUMAN GATE/);
    assert.ok(!/READY/.test(client._titles.sB) && !/GATE/.test(client._titles.sA), 'no cross-stream contamination');
    if (hooks.dispose) await hooks.dispose();
  });
});

test('F4 negative+positive (real OpenCode 1.18.27 API): no MCP-notification hook; session.update(title) + toast are the real surfaces', async (t) => {
  const pluginDir = process.env.OPENCODE_PLUGIN_DIR || 'C:\\Users\\Admin\\Soc_brain\\.opencode\\node_modules\\@opencode-ai\\plugin\\dist';
  const sdkDir = process.env.OPENCODE_SDK_DIR || 'C:\\Users\\Admin\\Soc_brain\\.opencode\\node_modules\\@opencode-ai\\sdk\\dist\\gen';
  if (!fs.existsSync(path.join(pluginDir, 'index.d.ts')) || !fs.existsSync(path.join(sdkDir, 'sdk.gen.d.ts'))) {
    return t.skip('installed OpenCode 1.18.27 packages not present in this environment');
  }
  const hooks = fs.readFileSync(path.join(pluginDir, 'index.d.ts'), 'utf8');
  const sdk = fs.readFileSync(path.join(sdkDir, 'sdk.gen.d.ts'), 'utf8');
  const types = fs.readFileSync(path.join(sdkDir, 'types.gen.d.ts'), 'utf8');
  // The real Hooks interface is exactly these hooks and contains NO MCP
  // notifications/message handler -> notifications/message is not a guaranteed UI
  // surface (justifies the session.update/toast approach in this plugin).
  assert.match(hooks, /"tool\.execute\.after"\?/, 'real Hooks has tool.execute.after');
  assert.ok(!/notifications\/message/.test(hooks), 'real plugin Hooks has NO MCP notifications/message handler');
  // session.update carrying title IS a real, first-class OpenCode surface.
  assert.match(sdk, /SessionUpdateResponses/, 'real SDK exposes session update');
  assert.match(types, /title\?\s*:/, 'session update carries a title property (types.gen)');
});
