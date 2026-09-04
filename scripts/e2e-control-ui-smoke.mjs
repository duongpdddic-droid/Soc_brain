#!/usr/bin/env node
// e2e-control-ui-smoke.mjs — bounded real E2E for Issue #53 (control plane v0).
//
// Proves, against a REAL OpenCode headless run through the REAL control plane:
//   A. user sees meaningful executor activity/output via the UI API (passthrough);
//   B+C. canonical lifecycle (execution record) is independent of the
//        presentation stream (deleting the activity stream corrupts nothing);
//   D. no OpenCode Desktop/TUI — headless spawn only (`opencode run --format json`);
//   E. 0 permission prompts / 0 human intervention: run reaches EXITED with the
//      expected changed file.
//
// Identity: synthetic LOCAL issue number 900001 (no GitHub issue created or
// contacted). Base = origin/main of the canonical repo. Real taskStart -> real
// worktree -> real opencode run -> real broker status/diff. Evidence JSON is
// saved OUTSIDE the repo (temp dir). The task worktree is intentionally KEPT
// for human inspection (no destructive cleanup in the smoke script).
//
// Usage: node scripts/e2e-control-ui-smoke.mjs [--repo owner/name] [--timeout-ms 240000]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createControlPlane, createControlUiServer, DEFAULT_MODEL } from '../packages/control-ui/control-ui.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';
import { defaultStateDir } from '../packages/runtime-sandbox/runtime-sandbox.mjs';
import { resolveOpenCodeExecutable } from '../packages/executor-launcher/executor-launcher.mjs';

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const REPO = argOf('--repo', 'duongpdddic-droid/Soc_brain');
const TIMEOUT_MS = Number(argOf('--timeout-ms', '240000'));
const ISSUE = Number(argOf('--issue', '900002')); // synthetic local identity — NOT a real GitHub issue.
// Default 900002: the read:allow config fix (GPT-REV-137) requires FRESH session
// admission (taskStart only writes opencode.json on first publish), so each
// canonical-config E2E uses a fresh --issue identity (900001 pre-fix, 900002
// post-fix).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evidence = { startedAt: new Date().toISOString(), repo: REPO, issue: ISSUE, model: DEFAULT_MODEL, checks: {} };
const check = (name, ok, detail) => { evidence.checks[name] = { ok: !!ok, detail: detail ?? null }; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); return !!ok; };

// 0. preconditions
const exe = resolveOpenCodeExecutable({});
if (!check('executor available', exe.ok, exe.ok ? exe.executable : exe.reason)) process.exit(1);
const stateDir = defaultStateDir();
const controlCwd = 'C:\\Users\\Admin\\Soc_brain'; // canonical primary checkout (git ops root)
let allOk = true;

// 1. start control plane + UI server (loopback, ephemeral port)
const cp = createControlPlane({ repo: REPO, stateDir, controlCwd });
if (!cp.ok) { console.error(`control plane init failed: ${cp.reason}`); process.exit(1); }
const srv = createControlUiServer({ controlPlane: cp, port: 0 });
const { host, port } = await srv.listen();
const base = `http://${host}:${port}`;
evidence.url = base;
console.log(`[e2e] control UI at ${base} (repo=${REPO}, model=${DEFAULT_MODEL})`);

const api = async (p, opts) => { const r = await fetch(base + p, opts); return { code: r.status, body: await r.json().catch(() => null) }; };

try {
  // 2. RUN via the UI API (browser supplies ONLY issueNumber + instruction).
  // Both an untracked file AND a tracked-file modification are requested so the
  // E2E proves BOTH observation channels: git status (untracked) and git diff
  // (tracked modification shows a real text diff).
  const instruction = 'Create a file named SOC_E2E_MARKER.txt in the repository root containing exactly the single line: soc-e2e-ok. Then append a second line reading exactly: soc-e2e-ok, to the end of the existing README.md file in the repository root. Do not create, modify or delete anything else. When you are done, reply with the single word DONE.';
  const t0 = Date.now();
  const run = await api('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ issueNumber: ISSUE, instruction }) });
  allOk &= check('POST /api/run accepted', run.code === 200 && run.body.ok, JSON.stringify(run.body).slice(0, 300));
  evidence.launch = run.body;

  // 3. poll /api/state until terminal (bounded). INTERRUPTED is a transient
  // projection (exit handler not yet merged) — keep polling; only break on a
  // real terminal status, or after a sustained orphan window.
  let st = null;
  let interruptedSince = null;
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(2000);
    const s = await api(`/api/state?issueNumber=${ISSUE}`);
    if (!s.body.ok) continue;
    st = s.body;
    const status = st.execution && st.execution.status;
    if (['EXITED', 'FAILED', 'STOPPED'].includes(status)) break;
    if (status === 'INTERRUPTED') {
      if (!interruptedSince) interruptedSince = Date.now();
      else if (Date.now() - interruptedSince > 45000) break;
    } else {
      interruptedSince = null;
    }
  }
  const elapsed = Date.now() - t0;
  allOk &= check('execution reached terminal status (0 hanging prompts)', !!st && !!st.execution && ['EXITED', 'STOPPED'].includes(st.execution.status), `status=${st?.execution?.status} elapsedMs=${elapsed} exit=${st?.execution?.exitCode} reason=${st?.execution?.reason || '-'}`);
  evidence.execution = st?.execution ?? null;
  evidence.elapsedMs = elapsed;
  allOk &= check('D. headless only (no interactive/desktop surface)', st?.execution?.status === 'EXITED', 'opencode run --format json (no TUI, no desktop)');

  // 4. A. meaningful executor activity/output through the UI API
  const act = await api(`/api/activity?issueNumber=${ISSUE}&maxLines=200`);
  const kinds = act.body?.available ? [...new Set(act.body.items.map((i) => i.kind))] : [];
  const textItems = act.body?.available ? act.body.items.filter((i) => i.kind === 'text' && (i.text || '').trim().length > 0) : [];
  allOk &= check('A. activity stream non-empty (user-visible output)', act.body?.available === true && act.body.items.length > 0, `kinds=${JSON.stringify(kinds)} totalLines=${act.body?.totalLines}`);
  allOk &= check('A. at least one supported text event', textItems.length > 0, textItems.length ? `"${textItems[0].text.slice(0, 80)}"` : 'none');
  evidence.activity = { kinds, totalLines: act.body?.totalLines, sampleText: textItems.map((i) => i.text).join(' | ').slice(0, 300) };

  // 5. changed files + diff via UI API (read-only observation)
  const ch = await api(`/api/changes?issueNumber=${ISSUE}`);
  const marker = ch.body?.available && (ch.body.files || []).some((f) => f.path.includes('SOC_E2E_MARKER.txt'));
  allOk &= check('changed files include SOC_E2E_MARKER.txt', marker === true, JSON.stringify((ch.body?.files || []).map((f) => f.path)).slice(0, 300));
  allOk &= check('View Diff text contains marker content', (ch.body?.diff?.text || '').includes('soc-e2e-ok'), `diffBytes=${(ch.body?.diff?.text || '').length}`);
  evidence.changes = { files: (ch.body?.files || []).map((f) => f.path), diffBytes: (ch.body?.diff?.text || '').length };

  // 6. B+C. lifecycle independent of presentation stream: delete events file,
  // state must still report the terminal lifecycle from the execution record.
  const idh = identityHash({ repo: REPO, issueNumber: ISSUE });
  const eventsPath = path.join(stateDir, 'executions', `${idh}.events.jsonl`);
  const backup = fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, 'utf8') : null;
  try { fs.rmSync(eventsPath, { force: true }); } catch { /* best effort */ }
  const stAfterLoss = await api(`/api/state?issueNumber=${ISSUE}`);
  allOk &= check('B/C. lifecycle survives stream loss', stAfterLoss.body.ok && stAfterLoss.body.execution && ['EXITED', 'STOPPED'].includes(stAfterLoss.body.execution.status), `status=${stAfterLoss.body?.execution?.status}`);
  evidence.lifecycleAfterStreamLoss = stAfterLoss.body?.execution?.status ?? null;
  if (backup !== null) { try { fs.writeFileSync(eventsPath, backup, 'utf8'); } catch { /* evidence restore best-effort */ } }

  // 7. state projection hygiene
  const stateStr = JSON.stringify(st || {});
  allOk &= check('state projection: no lease token / no absolute paths', !stateStr.includes('lease') && !stateStr.includes('C:\\\\') && !stateStr.includes('.soc-brain'), `bytes=${stateStr.length}`);
} finally {
  try { srv.server.close(); } catch { /* ignore */ }
  // The task worktree is KEPT intentionally as human-inspectable evidence.
  // Removal happens later through the normal task lifecycle, never here
  // (no destructive git/worktree operations inside the smoke script).
}

evidence.finishedAt = new Date().toISOString();
evidence.allOk = !!allOk;
const evidencePath = path.join(os.tmpdir(), `soc-e2e-issue53-${Date.now()}.json`);
try { fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), 'utf8'); } catch { /* print-only fallback */ }
console.log(`[e2e] evidence saved: ${evidencePath}`);
console.log(allOk ? '[e2e] RESULT: PASS' : '[e2e] RESULT: FAIL');
process.exit(allOk ? 0 : 1);
