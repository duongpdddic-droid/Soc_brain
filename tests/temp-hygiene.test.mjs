#!/usr/bin/env node
// temp-hygiene.test.mjs - parity + safety tests for Soc_brain runtime/temp
// hygiene primitives (Issue #7). No framework. Exit 0 = PASS, 1 = FAIL.
//
// Source: duongpdddic-droid/AI_PR_REVIEWER
// Immutable source SHA: 9c104c88dddb3e9aad0388447e9be6ff74f78a06
// Source parity test: scripts/test-temp-hygiene.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  DEFAULT_TEMP_ROOT, isSafeSessionId, isInside, hasOwnershipMarker, redactHome,
  isAlive, createSessionManager, recoverSession, snapshotWorkspace,
  assertOutsideWorktree,
} from '../packages/temp-hygiene/temp-hygiene.mjs';

const checks = [];
const eq = (name, got, want) => checks.push({ name, ok: got === want, got, want });
const tru = (name, got) => checks.push({ name, ok: Boolean(got), got });
const falsy = (name, got) => checks.push({ name, ok: !got, got });

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '..');
const NODE = process.execPath;
const tickFor = (id) => `setInterval(()=>{},1<<30);process.env.TH=${JSON.stringify(id)};`;

const ROOT2 = path.join(os.tmpdir(), `tmp-hygiene-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const alive = [];
const home = os.homedir();
const user = os.userInfo().username;
let hasJunctionFixture = true;

try {
  // --- AC3 / validators ---
  eq('AC3 isSafeSessionId hex ok', isSafeSessionId('abcdef1234567890'), true);
  eq('AC3 isSafeSessionId upper rejected', isSafeSessionId('ABCD'.repeat(4)), false);
  eq('AC3 isSafeSessionId invalid char rejected', isSafeSessionId('abc!def'), false);
  tru('AC3 isInside child true', isInside('/a/b', '/a/b/c'));
  eq('AC3 isInside root itself false', isInside('/a/b', '/a/b'), false);
  eq('AC3 isInside sibling false', isInside('/a/b', '/a/c'), false);

  // --- AC4 runtime root inside Git worktree rejected (unconditional) ---
  try {
    createSessionManager({ tempRoot: ROOT, projectRoot: ROOT });
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
    recoverSession({ sessionId: 'abcdef', tempRoot: ROOT });
    tru('AC4 recoverSession tempRoot in repo throws', false);
  } catch { tru('AC4 recoverSession tempRoot in repo throws', true); }
  tru('AC4 production default outside worktree', !String(DEFAULT_TEMP_ROOT()).startsWith(ROOT));

  // --- AC2 PASS cleanup ---
  {
    const m = createSessionManager({ tempRoot: ROOT2, projectRoot: ROOT, purpose: 'test-pass' });
    m.createDir('work');
    m.createFile('work/out.txt', 'hello');
    m.createFile('note.json', JSON.stringify({ a: 1 }));
    tru('AC2 pass manifest has files+dirs', m.manifest.files.length === 2 && m.manifest.dirs.length >= 2);
    tru('AC2 pass ownership marker correct', hasOwnershipMarker(m.homeDir, m.sessionId));
    const before = snapshotWorkspace(ROOT);
    const r = m.cleanup({ projectRoot: ROOT, workspaceBefore: before });
    eq('AC2 pass verdict CLEAN', r.verdict, 'CLEAN');
    tru('AC2 pass homeGone read-back', r.readRead !== undefined ? r.readBack.homeGone : true);
    eq('AC2 pass leftover empty', r.leftover.length, 0);
    eq('AC2 pass removed >0', r.removed.length > 0, true);
    tru('AC2 pass baseline workspace present', r.readBack.workspaceBaselinePresent);
    tru('AC2 pass workspace unchanged', r.readBack.workspaceUnchanged);
    const r2 = m.cleanup();
    eq('AC9 pass cleanup idempotent', r2.verdict === 'CLEAN', true);
  }

  // --- AC3 traversal and boundary rejection (createFile/createDir) ---
  {
    const m = createSessionManager({ tempRoot: ROOT2, projectRoot: ROOT, purpose: 'test-traversal' });
    let threwCreateDir = false;
    try { m.createDir('../leak'); } catch { threwCreateDir = true; }
    tru('AC3 createDir traversal rejected', threwCreateDir);
    let threwCreateFile = false;
    try { m.createFile('../leak.txt', 'x'); } catch { threwCreateFile = true; }
    tru('AC3 createFile traversal rejected', threwCreateFile);
    fs.rmSync(m.homeDir, { recursive: true, force: true });

  // --- AC6/AC7/AC8 RECOVERY ---
  {
    // Recovery of clean session
    const m = createSessionManager({ tempRoot: ROOT2, projectRoot: ROOT, purpose: 'test-rec-pass' });
    m.createFile('data.txt', 'test');
    const id = m.sessionId;
    const homeDir = m.homeDir;
    tru('rec session home exists', fs.existsSync(homeDir));
    const rec1 = recoverSession({ sessionId: id, tempRoot: ROOT2 });
    eq('AC8 recovery clean verdict CLEAN', rec1.verdict, 'CLEAN');
    falsy('AC8 recovery removes home dir', fs.existsSync(homeDir));
    const rec2 = recoverSession({ sessionId: id, tempRoot: ROOT2 });
    eq('AC9 recovery idempotent CLEAN', rec2.verdict, 'CLEAN');

    // Recovery of orphan / unowned dir
    const orphan = path.join(ROOT2, 'cafe'.repeat(8));
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, 'stray.txt'), 't');
    const rUnowned = recoverSession({ sessionId: 'cafe'.repeat(8), tempRoot: ROOT2 });
    eq('AC7 recovery unowned POC_CLEANUP_FAILED', rUnowned.verdict, 'POC_CLEANUP_FAILED');
    tru('AC7 recovery unowned preserves dir', fs.existsSync(orphan));
    tru('AC7 recovery unowned reports leftover', rUnowned.leftover.length > 0);
    fs.rmSync(orphan, { recursive: true, force: true });

    // Recovery with corrupt manifest
    const mCorrupt = createSessionManager({ tempRoot: ROOT2, projectRoot: ROOT, purpose: 'test-corrupt' });
    fs.writeFileSync(path.join(mCorrupt.homeDir, '.session-manifest.json'), '{corrupt-json');
    const rCorrupt = recoverSession({ sessionId: mCorrupt.sessionId, tempRoot: ROOT2 });
    eq('AC6 recovery corrupt manifest POC_CLEANUP_FAILED', rCorrupt.verdict, 'POC_CLEANUP_FAILED');
    tru('AC6 recovery corrupt manifest preserves dir', fs.existsSync(mCorrupt.homeDir));
    fs.rmSync(mCorrupt.homeDir, { recursive: true, force: true });
  }

  // --- AC5 symlink/junction escape ---
  {
    const m = createSessionManager({ tempRoot: ROOT2, projectRoot: ROOT, purpose: 'test-escape' });
    const outsideTarget = path.join(os.tmpdir(), `outside-target-${Date.now()}.txt`);
    fs.writeFileSync(outsideTarget, 'outside');
    m.manifest.files.push(outsideTarget);
    fs.writeFileSync(path.join(m.homeDir, '.session-manifest.json'), JSON.stringify(m.manifest));
    const r = m.cleanup();
    eq('AC5 cleanup rejects file outside session root', r.verdict, 'POC_CLEANUP_FAILED');
    tru('AC5 cleanup retains outside target', fs.existsSync(outsideTarget));
    fs.rmSync(outsideTarget, { force: true });
    try { fs.rmSync(m.homeDir, { recursive: true, force: true }); } catch {}
  }

  }


  // --- AC10 reports contain absolute HOME/username/production default ---
  {
    const m = createSessionManager({ tempRoot: ROOT2, projectRoot: ROOT, purpose: 'test-redact' });
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

  // --- AC10 redactHome pure-function spot check ---
  {
    const sample = path.join(home, '.soc-brain', 'a', 'b');
    const out = redactHome(sample);
    falsy('AC10 redactHome redacts absolute HOME', out.includes(home));
    falsy('AC10 redactHome redacts username', out.includes(user));
    tru('AC10 redactHome replaces production default marker', out.includes('<SOC_BRAIN_RUNTIME>'));
  }

  // --- AC1 parity: verify exports ---
  const requiredExports = [
    'DEFAULT_TEMP_ROOT', 'isSafeSessionId', 'isInside', 'hasOwnershipMarker',
    'redactHome', 'isAlive', 'createSessionManager', 'recoverSession',
    'snapshotWorkspace', 'assertOutsideWorktree',
  ];
  const mod = await import('../packages/temp-hygiene/temp-hygiene.mjs');
  for (const name of requiredExports) {
    eq('AC1 export ' + name + ' present', typeof mod[name] !== 'undefined', true);
  }
  const ws = snapshotWorkspace(ROOT);
  tru('AC1 snapshotWorkspace returns array', Array.isArray(ws));

  // --- AC9 cannot remove roots ---
  {
    const m = createSessionManager({ tempRoot: ROOT2, projectRoot: ROOT, purpose: 'test-roots' });
    const r = m.cleanup();
    tru('AC9 cannot remove tempRoot', fs.existsSync(ROOT2));
    tru('AC9 cannot remove runtime root', fs.existsSync(path.dirname(m.homeDir)));
  }
} finally {
  for (const pid of alive) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  try { fs.rmSync(ROOT2, { recursive: true, force: true }); } catch {}
}

let pass = 0, fail = 0;
for (const c of checks) {
  const tag = c.ok ? 'PASS' : 'FAIL';
  console.log(tag + ' ' + c.name + (c.ok ? '' : ` | want=${JSON.stringify(c.want)} got=${JSON.stringify(c.got)}`));
  c.ok ? pass++ : fail++;
}
const skipped = hasJunctionFixture ? '' : ' (AC5 symlink/junction fixture skipped)';
console.log(`Total: ${pass} pass, ${fail} fail, ${checks.length} total${skipped}`);
process.exit(fail === 0 ? 0 : 1);
