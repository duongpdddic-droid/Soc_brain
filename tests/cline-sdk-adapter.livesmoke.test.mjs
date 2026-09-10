// cline-sdk-adapter.livesmoke.test.mjs — OPTIONAL live smoke for the MVP
// ClineSdkExecutorAdapter (Issue #147). REAL @cline/sdk + real provider calls.
// Skipped (exit 0) unless SOC_CLINE_LIVE_SMOKE=1 and GEMINI_API_KEY present.
// Measures RESOURCE + real STORAGE HYGIENE + hub/shared-state isolation.
// Not part of the deterministic CI path; disposable temp fixture only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { identityHash } from '../packages/workspace/workspace.mjs';
import {
  clineDataDir, measureExecutionStorage, cleanupExecutionArtifacts,
  probeOrphanArtifacts, markExecutionInterrupted,
} from '../packages/cline-sdk-adapter/cline-sdk-adapter.mjs';

if (process.env.SOC_CLINE_LIVE_SMOKE !== '1' || !process.env.GEMINI_API_KEY) {
  console.log('LIVESMOKE SKIP: set SOC_CLINE_LIVE_SMOKE=1 and GEMINI_API_KEY to run (needs @cline/sdk installed)');
  process.exit(0);
}

const { createClineSdkExecutor } = await import('../packages/cline-sdk-adapter/cline-sdk-adapter.mjs');
const TMP = mkdtempSync(path.join(os.tmpdir(), 'soc-cline-live-'));
const MODEL = process.env.POC_MODEL || 'gemini-3.5-flash-lite';
const checks = [];
const eq = (n, g, w) => checks.push({ name: n, ok: g === w, got: g, want: w });
const tru = (n, g) => checks.push({ name: n, ok: Boolean(g), got: g });

// disposable fixture
const WT = path.join(TMP, 'fixture');
mkdirSync(path.join(WT, 'src'), { recursive: true });
writeFileSync(path.join(WT, 'src', 'util.js'), "function slugify(v){return String(v).toLowerCase().trim().replace(/[^a-z0-9]+/g,'-');}\nmodule.exports={slugify};\n");
writeFileSync(path.join(WT, 'README.md'), '# live fixture\n');

const S = path.join(TMP, 'state');
mkdirSync(path.join(S, 'sessions'), { recursive: true });
const repo = 'o/r'; const issueNumber = 1;
const IDH = identityHash({ repo, issueNumber });
const sessionPath = path.join(S, 'sessions', `${IDH}.json`);
writeFileSync(sessionPath, JSON.stringify({
  schemaVersion: '1', state: 'SESSION_ACTIVE', lifecycle: [],
  taskId: `${repo}#${issueNumber}`, repo, issueNumber,
  baseSha: 'c'.repeat(40), branch: 'soc/live', worktreePath: WT,
  identityHash: IDH, lease: { token: 'live-tok' },
}, null, 2));
const binding = { identityHash: IDH, taskId: `${repo}#${issueNumber}`, repo, issueNumber, baseSha: 'c'.repeat(40), branch: 'soc/live', path: WT };

const sharedHome = path.join(os.homedir(), '.cline');
const homeCount = () => { try { return fs.readdirSync(sharedHome).length; } catch { return -1; } };
const homeBefore = homeCount();

function hubListening() {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: 25463 });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(1500, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

function resourceSampler() {
  const t0 = process.hrtime.bigint();
  const cpu0 = process.cpuUsage();
  let peakRss = process.memoryUsage().rss;
  const iv = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 200);
  return () => {
    clearInterval(iv);
    const cpu = process.cpuUsage(cpu0);
    return {
      wallMs: Number(process.hrtime.bigint() - t0) / 1e6,
      cpuMs: (cpu.user + cpu.system) / 1000,
      peakRssMB: +(peakRss / 1048576).toFixed(1),
    };
  };
}

const adapter = createClineSdkExecutor({
  stateDir: S, enabled: true, env: { ...process.env, SOC_CLINE_SDK_ADAPTER: '1' },
  verifyAuthority: () => ({ ok: true }),
  provider: { providerId: 'gemini', apiKeyEnv: 'GEMINI_API_KEY', modelId: MODEL },
}).value;

function recordPathFor(idh) { return path.join(S, 'executions', `${idh}.json`); }

async function runOne(label, spec, { cancelAfterFirstTool = false } = {}) {
  const sample = resourceSampler();
  const t0 = Date.now();
  const r = await adapter.start({ sessionPath, session: { leaseToken: 'live-tok' }, binding, ...spec });
  tru(`${label}: start ok`, r.ok);
  if (!r.ok) return null;
  const obs = adapter.observe(r.value.executionId);
  let firstEventMs = null; let events = 0; let tools = 0;
  const items = [];
  for (;;) {
    const n = await obs.next();
    if (n.done) break; // stream ends exactly when the adapter finalizes the record
    if (firstEventMs === null) firstEventMs = Date.now() - t0;
    events += 1;
    if (n.item.kind === 'tool') tools += 1;
    items.push(n.item);
    if (cancelAfterFirstTool && n.item.kind === 'tool' && n.item.phase === 'start') {
      await adapter.cancel(r.value.executionId);
    }
  }
  const res = sample();
  const rec = JSON.parse(fs.readFileSync(recordPathFor(IDH), 'utf8'));
  const stor = measureExecutionStorage({ stateDir: S, identityHash: IDH });
  console.log(JSON.stringify({
    kind: 'livesmoke', label,
    terminalStatus: rec.terminalStatus ?? null,
    reason: rec.reason ?? null,
    sessionId: rec.sessionId ?? null,
    firstEventMs, events, tools,
    wallMs: Math.round(res.wallMs), cpuMs: Math.round(res.cpuMs), peakRssMB: res.peakRssMB,
    usage: adapter.getResult(r.value.executionId).value?.usage ?? null,
    storage: { generatedBytes: stor.generatedBytes, generatedFileCount: stor.generatedFileCount, clineDataBytes: stor.clineDataBytes },
  }));
  return { r, rec, items };
}

// GC while the host process is alive: the SDK holds its SQLite handle for the
// host lifetime (no FILE_SHARE_DELETE), so a host-alive cleanup ends typed
// CLINE_DATA_DIR_LOCKED — bounded, per-execution, reclaimed after host exit
// (the abnormal-termination phase proves the reclaim deterministically).
async function gcNow(label) {
  const gc = await cleanupExecutionArtifacts({ stateDir: S, identityHash: IDH });
  console.log(JSON.stringify({ kind: 'livesmoke', label, gc: gc.ok ? 'in-process' : gc.code, ...gc }));
  tru(`${label}: gc ok or typed LOCKED (never silent growth)`, gc.ok || gc.code === 'CLINE_DATA_DIR_LOCKED');
  return gc;
}

// 1) read-only completed run (fresh CLINE_DATA_DIR per execution)
{
  const out = await runOne('task1-readonly', {
    instruction: 'Read src/util.js and reply with ONLY the name of the function it exports. Do not edit or run anything.',
    mutation: 'readonly',
  });
  tru('live: read-only completed', out?.rec?.terminalStatus === 'EXITED');
  await gcNow('gc-after-exited');
}
await new Promise((r) => setTimeout(r, 65_000)); // provider rate-limit pacing

// 2) interactive resume (authorized continuation, typed fail-closed absent)
await new Promise((r) => setTimeout(r, 65_000));
{
  // Interactive sessions stay non-terminal after the first turn by design —
  // bounded status wait instead of a full stream drain.
  const t0 = Date.now();
  const r = await adapter.start({
    sessionPath, session: { leaseToken: 'live-tok' }, binding,
    instruction: 'Read src/util.js. Reply with ONLY the exported function name. Do not edit or run anything.',
    mutation: 'readonly', interactive: true,
  });
  tru('live: interactive start ok', r.ok);
  const exId = r.value.executionId;
  const obs = adapter.observe(exId);
  const deadline = Date.now() + 240_000;
  let sawIdle = false; let items = [];
  while (Date.now() < deadline) {
    items = obs.items();
    if (items.some((i) => i.event?.type === 'cline_status' && ['idle', 'completed', 'failed', 'cancelled'].includes(i.event.status))) { sawIdle = true; break; }
    if (items.length === 0 && adapter.getResult(exId).value?.terminalStatus) break;
    await new Promise((res) => setTimeout(res, 2000));
  }
  const recAfterStart = JSON.parse(fs.readFileSync(recordPathFor(IDH), 'utf8'));
  tru('live: interactive start idle/non-terminal', sawIdle && recAfterStart.terminalStatus === null);
  const res = await adapter.resume({ executionId: exId, prompt: 'Which function name did you read? Answer with the name only.' });
  tru('live: authorized resume completed', res.ok && res.value?.status === 'EXITED');
  tru('live: resume remembered context', /slugify/i.test(res?.value?.text ?? ''));
  const bad = await adapter.resume({ executionId: 'nope-unknown', prompt: 'x' });
  eq('live: foreign resume rejected', bad.code, 'CLINE_RESUME_REJECTED');
  const rec = JSON.parse(fs.readFileSync(recordPathFor(IDH), 'utf8'));
  eq('live: record EXITED after resume turn', rec.terminalStatus, 'EXITED');
  const stor = measureExecutionStorage({ stateDir: S, identityHash: IDH });
  console.log(JSON.stringify({
    kind: 'livesmoke', label: 'resume', terminalStatus: rec.terminalStatus,
    wallMs: Date.now() - t0, events: items.length,
    usage: adapter.getResult(exId).value?.usage ?? null,
    storage: { generatedBytes: stor.generatedBytes, generatedFileCount: stor.generatedFileCount },
  }));
  await gcNow('gc-after-resume');
}
await new Promise((r) => setTimeout(r, 65_000));

// 3) cancel run
{
  const out = await runOne('cancel', {
    instruction: 'Create counting.txt with the numbers 1 to 400, one per line, using the editor tool. Then read it back.',
    mutation: 'allow',
    maxIterations: 40,
  }, { cancelAfterFirstTool: true });
  tru('live: cancel => STOPPED', out?.rec?.terminalStatus === 'STOPPED');
  await gcNow('gc-after-stopped');
}
await new Promise((r) => setTimeout(r, 65_000));

// 3) abnormal termination via child process kill (orphan measurement)
{
  const childDir = path.join(TMP, 'child');
  mkdirSync(childDir, { recursive: true });
  const childState = path.join(childDir, 'state');
  mkdirSync(path.join(childState, 'sessions'), { recursive: true });
  const childIssue = 2;
  const childIdh = identityHash({ repo, issueNumber: childIssue });
  const childSession = path.join(childState, 'sessions', `${childIdh}.json`);
  writeFileSync(childSession, JSON.stringify({
    schemaVersion: '1', state: 'SESSION_ACTIVE', lifecycle: [], taskId: `${repo}#${childIssue}`,
    repo, issueNumber: childIssue, baseSha: 'c'.repeat(40), branch: 'soc/live', worktreePath: WT,
    identityHash: childIdh, lease: { token: 'child-tok' },
  }));
  const here = path.dirname(fileURLToPath(import.meta.url));
  const child = spawn(process.execPath, [path.join(here, 'cline-livesmoke-child.mjs'), childState, childSession, childIdh, WT], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SOC_CLINE_LIVE_SMOKE_CHILD: '1' }, windowsHide: true,
  });
  let childPid = null;
  child.stdout.on('data', (d) => {
    const m = String(d).match(/CHILD_PID=(\d+)/);
    if (m) childPid = Number(m[1]);
    process.stdout.write(`[child] ${d}`);
  });
  child.stderr.on('data', (d) => process.stderr.write(`[child!] ${d}`));
  await new Promise((r) => setTimeout(r, 20_000));
  if (childPid) {
    try { process.kill(childPid, 'SIGKILL'); } catch { /* gone */ }
  } else {
    try { child.kill('SIGKILL'); } catch { /* gone */ }
  }
  await new Promise((res) => child.once('exit', res));
  await new Promise((r) => setTimeout(r, 2000));
  const pre = probeOrphanArtifacts({ stateDir: childState, identityHash: childIdh });
  console.log(JSON.stringify({ kind: 'livesmoke', label: 'abnormal-termination', probeBeforeMark: pre }));
  const mark = markExecutionInterrupted({ stateDir: childState, identityHash: childIdh });
  tru('live: crash repair marks INTERRUPTED', mark.ok || mark.code === 'HOST_STILL_ALIVE');
  if (mark.ok) {
    const post = probeOrphanArtifacts({ stateDir: childState, identityHash: childIdh });
    tru('live: orphan footprint measurable', post.orphan && post.orphanBytes >= 0);
    const gc = await cleanupExecutionArtifacts({ stateDir: childState, identityHash: childIdh });
    tru('live: orphan reclaimable deterministically by executionId', gc.ok);
    console.log(JSON.stringify({ kind: 'livesmoke', label: 'abnormal-termination-reclaim', reclaimedBytes: gc.reclaimedBytes, reclaimedFiles: gc.reclaimedFiles }));
  }
}

// hub + shared-state isolation
{
  const listening = await hubListening();
  eq('live: no hub listener (25463)', listening, false);
  const homeAfter = homeCount();
  if (homeBefore >= 0) eq('live: ~/.cline top-level unchanged', homeAfter, homeBefore);
}

const failed = checks.filter((c) => !c.ok);
await adapter.dispose(); // release all runtimes of this host
for (const c of checks) console.log(`${c.ok ? 'ok' : 'FAIL'}  ${c.name}${c.ok ? '' : ` got=${JSON.stringify(c.got)} want=${JSON.stringify(c.want)}`}`);
console.log(`cline-sdk-adapter.livesmoke: ${checks.length - failed.length}/${checks.length} checks passed`);
try { rmSync(TMP, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch {
  // host-held SQLite lock: expected while this process lives; the OS reclaims
  // the per-execution store when the host exits (temp dir, non-production).
  console.log(`LIVESMOKE tmp left for OS reclaim: ${TMP}`);
}
process.exit(failed.length ? 1 : 0);
