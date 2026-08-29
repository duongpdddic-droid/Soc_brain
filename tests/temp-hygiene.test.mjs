#!/usr/bin/env node
// temp-hygiene.test.mjs - parity + safety tests for Soc_brain runtime/temp
// hygiene primitives (Issue #7). No framework. Exit 0 = PASS, 1 = FAIL.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  DEFAULT_TEMP_ROOT, isSafeSessionId, isSafeProjectId, isSafeTaskId, isInside, hasOwnershipMarker, redactHome,
  isAlive, createSessionManager, recoverSession, snapshotWorkspace,
  assertOutsideWorktree,
} from '../packages/temp-hygiene/temp-hygiene.mjs';

const checks = [];
const eq = (name, got, want) => checks.push({ name, ok: got === want, got, want });
const tru = (name, got) => checks.push({ name, ok: Boolean(got), got });
const falsy = (name, got) => checks.push({ name, ok: !got, got });
const skip = (name, why) => checks.push({ name, ok: true, got: 'SKIP', want: 'SKIP', skip: true, why });

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '..');
const NODE = process.execPath;
const tickFor = (id) => `setInterval(()=>{},1<<30);process.env.TH=${JSON.stringify(id)};`;
const hex = (n) => randomBytes(n).toString('hex');

const ROOT2 = path.join(os.tmpdir(), `tmp-hygiene-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
fs.mkdirSync(ROOT2, { recursive: true });
const alive = [];
const home = os.homedir();
const user = os.userInfo().username;
let hasJunctionFixture = true;
const skipReasons = [];

function tryCreateJunction(parent, name, target) {
  if (process.platform !== 'win32') return false;
  const link = path.join(parent, name);
  try { fs.rmSync(link, { recursive: true, force: true }); } catch {}
  const r = spawnSync('cmd.exe', ['/c', `mklink /J "${link}" "${target}"`], { encoding: 'utf8' });
  if (r.status === 0 && fs.existsSync(link)) return true;
  return false;
}
try {
  // --- AC3 / validators ---
  eq('AC3 isSafeSessionId hex ok', isSafeSessionId('abcdef1234567890'), true);
  eq('AC3 isSafeSessionId upper rejected', isSafeSessionId('ABCD'.repeat(4)), false);
  eq('AC3 isSafeSessionId invalid char rejected', isSafeSessionId('abc!def'), false);
  eq('AC3 isSafeProjectId hex ok', isSafeProjectId('abcdef1234567890'), true);
  eq('AC3 isSafeProjectId bad rejected', isSafeProjectId('not-a-project'), false);
  eq('AC3 isSafeTaskId hex ok', isSafeTaskId('deadbeef'), true);
  eq('AC3 isSafeTaskId bad rejected', isSafeTaskId('zzzz'), false);
  tru('AC3 isInside child true', isInside('/a/b', '/a/b/c'));
  eq('AC3 isInside root itself false', isInside('/a/b', '/a/b'), false);
  eq('AC3 isInside sibling false', isInside('/a/b', '/a/c'), false);

  // --- AC4 runtime root inside Git worktree rejected (unconditional) ---
  try {
    createSessionManager({ tempRoot: ROOT, projectRoot: ROOT, projectId: 'aa', taskId: 'bb' });
    tru('AC4 createSession tempRoot in repo throws', false);
  } catch { tru('AC4 createSession tempRoot in repo throws', true); }
  try {
    assertOutsideWorktree(ROOT);
    tru('AC4 assertOutsideWorktree(in repo) throws', false);
  } catch { tru('AC4 assertOutsideWorktree(in repo) throws', true); }
  try {
    assertOutsideWorktree(path.join(ROOT, 'packages', 'temp-hygiene'));
    tru('AC4 assertOutsideWorktree(in repo/packages) throws', false);
  } catch { tru('AC4 assertOutsideWorktree(in repo/packages) throws', true); }
  try {
    recoverSession({ projectId: 'aa', taskId: 'bb', tempRoot: ROOT });
    tru('AC4 recoverSession tempRoot in repo throws', false);
  } catch { tru('AC4 recoverSession tempRoot in repo throws', true); }
  tru('AC4 production default outside worktree', !String(DEFAULT_TEMP_ROOT()).startsWith(ROOT));

  // --- AC2 PASS cleanup (with explicit projectId + taskId namespace) ---
  {
    const projectId = hex(8);
    const taskId = hex(8);
    const m = createSessionManager({ tempRoot: ROOT2, projectRoot: ROOT, projectId, taskId, purpose: 'test-pass' });
    m.createDir('work');
    m.createFile('work/out.txt', 'hello');
    m.createFile('note.json', JSON.stringify({ a: 1 }));
    tru('AC2 pass manifest has files+dirs', m.manifest.files.length === 2 && m.manifest.dirs.length >= 2);
    tru('AC2 pass ownership marker correct', hasOwnershipMarker(m.homeDir, taskId));
    const before = snapshotWorkspace(ROOT);
    const r = m.cleanup({ projectRoot: ROOT, workspaceBefore: before });
    eq('AC2 pass verdict CLEAN', r.verdict, 'CLEAN');
    tru('AC2 pass home removed', !fs.existsSync(m.homeDir));
    tru('AC2 pass no errors', r.errors.length === 0);
  }

  // --- AC5 symlink/junction escape refused ---
  {
    const projectId = hex(8);
    const taskId = hex(8);
    const m = createSessionManager({ tempRoot: ROOT2, projectRoot: ROOT, projectId, taskId, purpose: 'test-symlink-escape' });
    const outsideTarget = path.join(os.tmpdir(), `outside-target-${Date.now()}.txt`);
    fs.writeFileSync(outsideTarget, 'outside');
    let writeBlocked = false;
    try {
      m.createFile(`work/${path.basename(outsideTarget)}`, 'should-not-leak');
      m.manifest.files.push(outsideTarget);
      fs.writeFileSync(path.join(m.homeDir, '.session-manifest.json'), JSON.stringify(m.manifest));
    } catch (e) {
      writeBlocked = true;
    }
    const r = m.cleanup();
    eq('AC5 cleanup rejects file outside project namespace', r.verdict, 'POC_CLEANUP_FAILED');
    tru('AC5 cleanup retains outside target', fs.existsSync(outsideTarget));
    eq('AC5 createFile under write-protected task refuses or cleanup rejects', writeBlocked || r.verdict === 'POC_CLEANUP_FAILED', true);
    fs.rmSync(outsideTarget, { force: true });
    try { fs.rmSync(m.homeDir, { recursive: true, force: true }); } catch {}
  }

  // --- AC5b real junction fixture: a junction inside homeDir that points outside ---
  {
    const projectId = hex(8);
    const taskId = hex(8);
    const m = createSessionManager({ tempRoot: ROOT2, projectRoot: ROOT, projectId, taskId, purpose: 'test-junction-fixture' });
    const realSubdir = path.join(ROOT2, `junc-target-${Date.now()}`);
    fs.mkdirSync(realSubdir, { recursive: true });
    const guarded = path.join(m.homeDir, 'guarded');
    fs.mkdirSync(guarded, { recursive: true });
    const juncOk = tryCreateJunction(guarded, 'escape', realSubdir);
    if (!juncOk) {
      hasJunctionFixture = false;
      const reason = 'mklink /J unavailable on this host; AC5b junction fixture deterministically skipped';
      skipReasons.push(reason);
      skip('AC5b real junction fixture', reason);
    } else {
      const sentinel = path.join(realSubdir, 'sentinel.txt');
      fs.writeFileSync(sentinel, 'sentinel-value');
      let writeRejected = false;
      let rejectMessage = '';
      try {
        m.createFile('guarded/escape/leak.txt', 'data');
      } catch (e) {
        writeRejected = true;
        rejectMessage = String((e && e.message) || e);
      }
      tru('AC5b write through junction refused', writeRejected);
      tru('AC5b write rejection mentions reparse point', /reparse|ancestor|escapes/i.test(rejectMessage));
      eq('AC5b sentinel outside session unchanged', fs.readFileSync(sentinel, 'utf8'), 'sentinel-value');
      try { fs.rmSync(m.homeDir, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(realSubdir, { recursive: true, force: true }); } catch {}
    }
  }


  // --- AC6 negative: missing/mismatched marker during cleanup ---
  {
    const projectId = hex(8);
    const taskId = hex(8);
    const m = createSessionManager({ tempRoot: ROOT2, projectRoot: ROOT, projectId, taskId, purpose: 'test-no-marker' });
    m.createFile('a.txt', 'x');
    try { fs.unlinkSync(path.join(m.homeDir, '.soc-brain-session-marker')); } catch {}
    const r = m.cleanup();
    eq('AC6 cleanup with missing marker refuses', r.verdict, 'POC_CLEANUP_FAILED');
    tru('AC6 cleanup with missing marker keeps home', fs.existsSync(m.homeDir));
    tru('AC6 cleanup with missing marker reports ownership error', r.errors.some((e) => /ownership/i.test(String(e))));
    try { fs.rmSync(m.homeDir, { recursive: true, force: true }); } catch {}
  }
  {
    const projectId = hex(8);
    const taskId = hex(8);
    const m = createSessionManager({ tempRoot: ROOT2, projectRoot: ROOT, projectId, taskId, purpose: 'test-mismatch' });
    m.createFile('a.txt', 'x');
    fs.writeFileSync(path.join(m.homeDir, '.soc-brain-session-marker'), 'soc-brain session owner marker:NOT-OURS');
    const r = m.cleanup();
    eq('AC6 cleanup with mismatched marker refuses', r.verdict, 'POC_CLEANUP_FAILED');
    tru('AC6 cleanup with mismatched marker keeps home', fs.existsSync(m.homeDir));
    try { fs.rmSync(m.homeDir, { recursive: true, force: true }); } catch {}
  }

  // --- AC7 negative: live and unverified owner block recovery ---
  {
    const projectId = hex(8);
    const taskId = hex(8);
    const m = createSessionManager({ tempRoot: ROOT2, projectRoot: ROOT, projectId, taskId, purpose: 'test-live-owner' });
    m.createFile('a.txt', 'x');
    const child = m.spawnProcess(NODE, ['-e', tickFor(m.sessionId)]);
    alive.push(child.pid);
    m.addProcess(child.pid);
    const r = recoverSession({ projectId, taskId, tempRoot: ROOT2 });
    eq('AC7 recovery blocked by live owner', r.verdict, 'POC_CLEANUP_FAILED');
    tru('AC7 recovery keeps home when live owner present', fs.existsSync(m.homeDir));
    tru('AC7 recovery did not kill live owner', isAlive(child.pid));
    try { process.kill(child.pid, 'SIGKILL'); } catch {}
    const idx = alive.indexOf(child.pid); if (idx >= 0) alive.splice(idx, 1);
    const r2 = recoverSession({ projectId, taskId, tempRoot: ROOT2 });
    eq('AC7 recovery succeeds once owner confirmed dead', r2.verdict, 'CLEAN');
    tru('AC7 recovery removes home once owner dead', !fs.existsSync(m.homeDir));
  }

  // --- AC8 namespace isolation: distinct projectId + taskId do not collide ---
  {
    const projectId = hex(8);
    const t1 = hex(8); const t2 = hex(8);
    const m1 = createSessionManager({ tempRoot: ROOT2, projectRoot: ROOT, projectId, taskId: t1, purpose: 'ns-1' });
    const m2 = createSessionManager({ tempRoot: ROOT2, projectRoot: ROOT, projectId, taskId: t2, purpose: 'ns-2' });
    eq('AC8 projectId namespace same', m1.projectId, m2.projectId);
    eq('AC8 taskId namespace distinct', m1.taskId !== m2.taskId, true);
    eq('AC8 home dirs distinct', m1.homeDir !== m2.homeDir, true);
    eq('AC8 sessionId distinct', m1.sessionId !== m2.sessionId, true);
    tru('AC8 task dir 1 exists', fs.existsSync(m1.homeDir));
    tru('AC8 task dir 2 exists', fs.existsSync(m2.homeDir));
    try { fs.rmSync(m1.homeDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(m2.homeDir, { recursive: true, force: true }); } catch {}
  }
  {
    const p1 = hex(8); const p2 = hex(8);
    const t = hex(8);
    const m1 = createSessionManager({ tempRoot: ROOT2, projectRoot: ROOT, projectId: p1, taskId: t, purpose: 'p-1' });
    const m2 = createSessionManager({ tempRoot: ROOT2, projectRoot: ROOT, projectId: p2, taskId: t, purpose: 'p-2' });
    tru('AC8 different projectId same taskId isolated', m1.homeDir !== m2.homeDir && fs.existsSync(m1.homeDir) && fs.existsSync(m2.homeDir));
    try { fs.rmSync(m1.homeDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(m2.homeDir, { recursive: true, force: true }); } catch {}
  }

  // --- AC9 cannot remove roots ---
  {
    const projectId = hex(8);
    const taskId = hex(8);
    const m = createSessionManager({ tempRoot: ROOT2, projectRoot: ROOT, projectId, taskId, purpose: 'test-roots' });
    const r = m.cleanup();
    tru('AC9 cannot remove tempRoot', fs.existsSync(ROOT2));
    tru('AC9 cannot remove project namespace', fs.existsSync(path.dirname(m.homeDir)));
  }


  // --- AC10 reports redact home/username/production default ---
  {
    const projectId = hex(8);
    const taskId = hex(8);
    const m = createSessionManager({ tempRoot: ROOT2, projectRoot: ROOT, projectId, taskId, purpose: 'test-redact' });
    const defaultRoot = DEFAULT_TEMP_ROOT();
    const insideDefault = path.join(defaultRoot, 'session-a', 'file.txt');
    m.manifest.files.push(home);
    m.manifest.files.push(insideDefault);
    const r = m.cleanup();
    const joined = JSON.stringify({ removed: r.removed, leftover: r.leftover, errors: r.errors });
    falsy('AC10 report does not contain absolute HOME', joined.includes(home));
    falsy('AC10 report does not contain username', joined.includes(user));
    falsy('AC10 report does not contain production default absolute', joined.includes(defaultRoot));
    tru('AC10 report contains production default marker', joined.includes('<SOC_BRAIN_RUNTIME>'));
    try { fs.rmSync(m.homeDir, { recursive: true, force: true }); } catch {}
  }
  {
    const sample = path.join(home, '.soc-brain', 'a', 'b');
    const out = redactHome(sample);
    falsy('AC10 redactHome redacts absolute HOME', out.includes(home));
    falsy('AC10 redactHome redacts username', out.includes(user));
    tru('AC10 redactHome replaces production default marker', out.includes('<SOC_BRAIN_RUNTIME>'));
  }

  // --- AC1 parity: verify exports and snapshot ---
  const requiredExports = [
    'DEFAULT_TEMP_ROOT', 'isSafeSessionId', 'isSafeProjectId', 'isSafeTaskId', 'isInside', 'hasOwnershipMarker',
    'redactHome', 'isAlive', 'createSessionManager', 'recoverSession',
    'snapshotWorkspace', 'assertOutsideWorktree', 'isSymlink', 'cleanupSession',
  ];
  const mod = await import('../packages/temp-hygiene/temp-hygiene.mjs');
  for (const name of requiredExports) {
    eq('AC1 export ' + name + ' present', typeof mod[name] !== 'undefined', true);
  }
  const ws = snapshotWorkspace(ROOT);
  tru('AC1 snapshotWorkspace returns array', Array.isArray(ws));
} finally {
  for (const pid of alive) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  try { fs.rmSync(ROOT2, { recursive: true, force: true }); } catch {}
}

let pass = 0, fail = 0, skipped = 0;
for (const c of checks) {
  if (c.skip) { skipped++; console.log('SKIP ' + c.name + ' | ' + (c.why || 'no reason given')); continue; }
  const tag = c.ok ? 'PASS' : 'FAIL';
  console.log(tag + ' ' + c.name + (c.ok ? '' : ` | want=${JSON.stringify(c.want)} got=${JSON.stringify(c.got)}`));
  c.ok ? pass++ : fail++;
}
const skipTag = skipped > 0 ? ` (skipped: ${skipped} - ${(skipReasons[0] || '')})` : '';
console.log(`Total: ${pass} pass, ${fail} fail, ${skipped} skipped, ${checks.length} total${skipTag}`);
process.exit(fail === 0 ? 0 : 1);

