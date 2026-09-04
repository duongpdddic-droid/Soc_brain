#!/usr/bin/env node
// e2e-local-task-identity.mjs — Phase B E2E for Local Task Identity v0 (PR #59).
//
// Proves, against a REAL OpenCode headless run through the REAL control plane:
//   B1. /api/run accepts INSTRUCTION-ONLY input ({ instruction }) — no issueNumber;
//   B2. the local allocator burns a machine-local number >= 9_000_000
//       (burn-before-use) and returns an opaque 32-hex identityHash handle;
//   B3. the run reaches EXITED while observed EXCLUSIVELY through the
//       identityHash handle (no numeric ID in the polling path);
//   B4. backward compat: the legacy numeric issueNumber observes the SAME
//       session (state + activity) after the fact;
//   B5. real executor work: marker file + tracked diff visible via /api/changes.
//
// Identity: allocator-assigned LOCAL number (no GitHub issue created or
// contacted). Base = origin/main of the canonical repo (via Phase A branch).
// Evidence JSON is saved OUTSIDE the repo (temp dir). The task worktree is
// intentionally KEPT for human inspection (no destructive cleanup here).
//
// Usage: node scripts/e2e-local-task-identity.mjs [--repo owner/name] [--timeout-ms 240000]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createControlPlane, createControlUiServer, DEFAULT_MODEL } from '../packages/control-ui/control-ui.mjs';
import { defaultStateDir } from '../packages/runtime-sandbox/runtime-sandbox.mjs';
import { resolveOpenCodeExecutable } from '../packages/executor-launcher/executor-launcher.mjs';

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const REPO = argOf('--repo', 'duongpdddic-droid/Soc_brain');
const TIMEOUT_MS = Number(argOf('--timeout-ms', '240000'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const metrics = { pollCount: 0, stages: {} };
const evidence = { startedAt: new Date().toISOString(), repo: REPO, model: DEFAULT_MODEL, instructionOnly: true, checks: {}, metrics };
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
  // 2. B1+B2. RUN instruction-ONLY: no issueNumber, no model — allocator must
  // admit the task and burn a local number >= 9_000_000.
  const instruction = 'Create a file named SOC_E2E_MARKER.txt in the repository root containing exactly the single line: soc-e2e-ok. Then append a second line reading exactly: soc-e2e-ok, to the end of the existing README.md file in the repository root. Do not create, modify or delete anything else. When you are done, reply with the single word DONE.';
  const t0 = Date.now();
  const run = await api('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instruction }) });
  metrics.stages.runAcceptedMs = Date.now() - t0;
  const idh = run.body && typeof run.body.identityHash === 'string' ? run.body.identityHash : null;
  const allocated = run.body && Number.isInteger(run.body.issueNumber) ? run.body.issueNumber : null;
  allOk &= check('B1. instruction-only /api/run accepted', run.code === 200 && run.body?.ok === true && run.body?.localTask === true, JSON.stringify(run.body).slice(0, 300));
  allOk &= check('B2. allocator burned local number >= 9_000_000 + opaque 32-hex handle', allocated !== null && allocated >= 9_000_000 && idh !== null && /^[0-9a-f]{32}$/.test(idh), `issueNumber=${allocated} identityHash=${idh ? `${idh.slice(0, 8)}…` : 'null'}`);
  evidence.allocated = { issueNumber: allocated, identityHash: idh };
  if (!idh || !allocated) { console.error('[e2e] no handle — aborting before executor run'); process.exit(1); }

  // 3. B3. poll /api/state EXCLUSIVELY via the identityHash handle until terminal.
  let st = null;
  let interruptedSince = null;
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(2000);
    metrics.pollCount += 1;
    const s = await api(`/api/state?identityHash=${idh}`);
    if (!s.body || s.body.ok === false) continue;
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
  metrics.stages.terminalMs = elapsed;
  evidence.execution = st?.execution ?? null;
  allOk &= check('B3. run reached EXITED via identityHash-only polling', st?.execution?.status === 'EXITED', `status=${st?.execution?.status} elapsedMs=${elapsed} exit=${st?.execution?.exitCode} reason=${st?.execution?.reason || '-'}`);
  evidence.elapsedMs = elapsed;

  // 4. B4. backward compat: legacy numeric issueNumber observes the SAME session.
  const stLegacy = await api(`/api/state?issueNumber=${allocated}`);
  allOk &= check('B4. legacy issueNumber state matches handle session', stLegacy.code === 200 && stLegacy.body?.ok === true && stLegacy.body?.task?.issueNumber === allocated && stLegacy.body?.execution?.status === 'EXITED', `taskIssue=${stLegacy.body?.task?.issueNumber} status=${stLegacy.body?.execution?.status}`);
  const act = await api(`/api/activity?issueNumber=${allocated}&maxLines=200`);
  const kinds = act.body?.available ? [...new Set(act.body.items.map((i) => i.kind))] : [];
  const textItems = act.body?.available ? act.body.items.filter((i) => i.kind === 'text' && (i.text || '').trim().length > 0) : [];
  allOk &= check('B4. legacy activity stream non-empty', act.body?.available === true && act.body.items.length > 0, `kinds=${JSON.stringify(kinds)} totalLines=${act.body?.totalLines}`);
  allOk &= check('B4. at least one supported text event', textItems.length > 0, textItems.length ? `"${textItems[0].text.slice(0, 80)}"` : 'none');
  evidence.activity = { kinds, totalLines: act.body?.totalLines, sampleText: textItems.map((i) => i.text).join(' | ').slice(0, 300) };

  // 5. B5. real work: changed files + diff via the legacy numeric channel.
  const ch = await api(`/api/changes?issueNumber=${allocated}`);
  const marker = ch.body?.available && (ch.body.files || []).some((f) => f.path.includes('SOC_E2E_MARKER.txt'));
  allOk &= check('B5. changed files include SOC_E2E_MARKER.txt', marker === true, JSON.stringify((ch.body?.files || []).map((f) => f.path)).slice(0, 300));
  allOk &= check('B5. diff text contains marker content', (ch.body?.diff?.text || '').includes('soc-e2e-ok'), `diffBytes=${(ch.body?.diff?.text || '').length}`);
  evidence.changes = { files: (ch.body?.files || []).map((f) => f.path), diffBytes: (ch.body?.diff?.text || '').length };

  // 6. state projection hygiene (same contract as the Issue #53 smoke).
  const stateStr = JSON.stringify(st || {});
  allOk &= check('state projection: no lease token / no absolute paths', !stateStr.includes('lease') && !stateStr.includes('C:\\\\') && !stateStr.includes('.soc-brain'), `bytes=${stateStr.length}`);
} finally {
  try { srv.server.close(); } catch { /* ignore */ }
  // The task worktree is KEPT intentionally as human-inspectable evidence.
  // Removal happens later through the normal task lifecycle, never here
  // (no destructive git/worktree operations inside the E2E script).
}

evidence.finishedAt = new Date().toISOString();
evidence.allOk = !!allOk;
const evidencePath = path.join(os.tmpdir(), `soc-e2e-local-task-identity-${Date.now()}.json`);
try { fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), 'utf8'); } catch { /* print-only fallback */ }
console.log(`[e2e] evidence saved: ${evidencePath}`);
console.log(`[e2e] metrics: ${JSON.stringify(metrics)}`);
console.log(allOk ? '[e2e] RESULT: PASS' : '[e2e] RESULT: FAIL');
process.exit(allOk ? 0 : 1);
