#!/usr/bin/env node
// local-task-allocator.test.mjs — tests for packages/task-intake/local-task-allocator.mjs
// (Phase A, Local Task Identity v0). No framework. Exit 0 = PASS, 1 = FAIL.
// Real filesystem only; no git, no network, no executor spawn.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import {
  allocateLocalTaskNumber, sequencePathFor, lockPathFor,
  LOCAL_TASK_NUMBER_BASE, LOCAL_TASK_SEQUENCE_SCHEMA_VERSION,
} from '../packages/task-intake/local-task-allocator.mjs';

const checks = [];
const eq = (n, g, w) => checks.push({ name: n, ok: g === w, got: g, want: w });
const tru = (n, g) => checks.push({ name: n, ok: Boolean(g), got: g });
const falsy = (n, g) => checks.push({ name: n, ok: !g, got: g });

const TMP = mkdtempSync(path.join(os.tmpdir(), 'soc-local-task-alloc-'));
const fresh = (name) => path.join(TMP, name);

// 1) fresh install: first allocation = base; state persisted burn-before-use ---
{
  const S = fresh('a1');
  const r = allocateLocalTaskNumber({ stateDir: S });
  tru('alloc: fresh ok', r.ok);
  eq('alloc: first number = LOCAL_TASK_NUMBER_BASE', r.number, LOCAL_TASK_NUMBER_BASE);
  tru('alloc: >= 9_000_000 (above GitHub range)', r.number >= 9000000);
  const seq = JSON.parse(readFileSync(sequencePathFor({ stateDir: S }), 'utf8'));
  eq('alloc: burned before use (persisted = handed out)', seq.lastAllocated, r.number);
  eq('alloc: schema version persisted', seq.schemaVersion, LOCAL_TASK_SEQUENCE_SCHEMA_VERSION);
  falsy('alloc: lock released after run', existsSync(lockPathFor({ stateDir: S })));
  falsy('alloc: no tmp residue in local-tasks dir', fs.readdirSync(path.dirname(sequencePathFor({ stateDir: S }))).some((f) => f.endsWith('.tmp')));
}

// 2) monotonic, strictly increasing, contiguous across repeated allocations ---
{
  const S = fresh('mono');
  const nums = [];
  for (let i = 0; i < 5; i++) nums.push(allocateLocalTaskNumber({ stateDir: S }).number);
  tru('mono: strictly increasing', nums.every((n, i) => i === 0 || n > nums[i - 1]));
  eq('mono: contiguous', nums[4] - nums[0], 4);
  eq('mono: starts at base', nums[0], LOCAL_TASK_NUMBER_BASE);
}

// 3) restart-safe: same stateDir keeps counting after "process restart" --------
{
  const S = fresh('restart');
  const prev = allocateLocalTaskNumber({ stateDir: S }).number;
  const next = allocateLocalTaskNumber({ stateDir: S }).number;
  eq('restart: continues at prev+1', next, prev + 1);
}

// 4) corrupt persisted state fails closed (no silent self-heal) ----------------
{
  const S = fresh('corrupt');
  mkdirSync(path.dirname(sequencePathFor({ stateDir: S })), { recursive: true });
  writeFileSync(sequencePathFor({ stateDir: S }), '{ not json', 'utf8');
  const r1 = allocateLocalTaskNumber({ stateDir: S });
  eq('corrupt: invalid JSON fails closed', r1.ok, false);
  eq('corrupt: reason', r1.reason, 'LOCAL_TASK_STATE_CORRUPT');
  falsy('corrupt: no lock left behind', existsSync(lockPathFor({ stateDir: S })));

  writeFileSync(sequencePathFor({ stateDir: S }), JSON.stringify({ lastAllocated: 5 }), 'utf8');
  eq('corrupt: schema mismatch fails closed', allocateLocalTaskNumber({ stateDir: S }).reason, 'LOCAL_TASK_STATE_CORRUPT');

  writeFileSync(sequencePathFor({ stateDir: S }), JSON.stringify({ schemaVersion: LOCAL_TASK_SEQUENCE_SCHEMA_VERSION, lastAllocated: 10 }), 'utf8');
  eq('corrupt: below-base state fails closed', allocateLocalTaskNumber({ stateDir: S }).reason, 'LOCAL_TASK_STATE_CORRUPT');
}

// 5) stale lock (dead owner pid) is broken exactly once, allocation proceeds ---
{
  const S = fresh('stale-lock');
  mkdirSync(path.dirname(lockPathFor({ stateDir: S })), { recursive: true });
  writeFileSync(lockPathFor({ stateDir: S }), JSON.stringify({ pid: 999999999, acquiredAt: '2026-01-01T00:00:00.000Z' }), 'utf8');
  const r = allocateLocalTaskNumber({ stateDir: S });
  tru('stale-lock: dead-owner lock broken, alloc ok', r.ok);
  falsy('stale-lock: lock released after run', existsSync(lockPathFor({ stateDir: S })));
}

// 6) live foreign owner fails closed ALLOCATOR_LOCKED (lock never stolen) ------
{
  const S = fresh('live-lock');
  mkdirSync(path.dirname(lockPathFor({ stateDir: S })), { recursive: true });
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' });
  try {
    writeFileSync(lockPathFor({ stateDir: S }), JSON.stringify({ pid: sleeper.pid, acquiredAt: '2026-01-01T00:00:00.000Z' }), 'utf8');
    const r = allocateLocalTaskNumber({ stateDir: S });
    eq('live-lock: contended lock fails closed', r.reason, 'ALLOCATOR_LOCKED');
    eq('live-lock: holder lock untouched', JSON.parse(readFileSync(lockPathFor({ stateDir: S }), 'utf8')).pid, sleeper.pid);
  } finally {
    sleeper.kill();
  }
}

// 7) argument + environment guards ---------------------------------------------
{
  eq('args: missing stateDir fails closed', allocateLocalTaskNumber({}).ok, false);
  eq('args: undefined opts fails closed', allocateLocalTaskNumber().ok, false);
}

// 8) cross-instance: two allocators on the same stateDir never duplicate -------
{
  const S = fresh('dup');
  const a = allocateLocalTaskNumber({ stateDir: S }).number;
  const b = allocateLocalTaskNumber({ stateDir: S }).number;
  tru('dup: no duplicate across sequential calls', a !== b);
  eq('dup: monotonic', b, a + 1);
}

const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? 'ok' : 'FAIL'}  ${c.name}${c.ok ? '' : `  got=${JSON.stringify(c.got)} want=${JSON.stringify(c.want)}`}`);
console.log(`local-task-allocator.test: ${checks.length - failed.length}/${checks.length} checks passed`);
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* windows handle lag */ }
if (failed.length) process.exit(1);
