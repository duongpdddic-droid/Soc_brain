// boot-milestone harness: spawn client-mcp.mjs (real adapter) for {worktree, nth},
// send JSON-RPC initialize + tools/list, measure ms until the tools/list response
// is received (adapter-ready), and total until process exit completes.
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const worktree = process.argv[2];
const runs = Number(process.argv[3] || 5);
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bootprobe-'));

function runOnce(n) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const child = spawn(process.execPath, [path.join(worktree, 'packages', 'client-mcp', 'client-mcp.mjs')], {
      env: {
        ...process.env,
        SOC_CONTROL_STATE_DIR: stateDir,
        SOC_CONTROL_WORKTREES_ROOT: path.join(stateDir, 'wt'),
        SOC_MCP_AUTO_RECOVER: '0',
        // marker so spawned adapters are identifiable/never lanched into lanes
        SOC_CONTROL_LANE: '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let readyMs = null;
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += String(d);
      const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) {
        if (!/tools\/list"|"id":1/.test(l)) continue;
        if (readyMs == null) readyMs = Number(process.hrtime.bigint() - t0) / 1e6;
      }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
    const watchdog = setTimeout(() => { try { child.kill(); } catch {} }, 20000);
    child.on('exit', () => {
      clearTimeout(watchdog);
      const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
      resolve({ n, readyMs, totalMs });
    });
    child.on('error', (e) => resolve({ n, error: String(e && e.message || e) }));
  });
}

const out = [];
for (let i = 1; i <= runs; i++) out.push(await runOnce(i));
const ready = out.filter((r) => r.readyMs != null).map((r) => r.readyMs);
const totals = out.map((r) => r.totalMs).filter(Number.isFinite);
const md = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
console.log(JSON.stringify({
  worktree, runs, stateDir,
  readyMs: { median: Math.round(md(ready) || 0), min: Math.round(Math.min(...ready) || 0), max: Math.round(Math.max(...ready) || 0), all: ready.map((x) => Math.round(x)) },
  totalMs: { median: Math.round(md(totals) || 0), all: totals.map((x) => Math.round(x)) },
  per: out,
}, null, 2));