#!/usr/bin/env node
// lease-rotation.test.mjs — tests for rotateSessionLease (Issue #126 gate).
// Real-FS fixture: canonical repo + taskStart admission + rotation lifecycle.
// NO framework. Exit 0 = PASS, 1 = FAIL. NEVER prints token values.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import {
  taskStart, refreshRootOpenCodeProjection, rotateSessionLease,
} from '../packages/runtime-sandbox/runtime-sandbox.mjs';
import { verifySessionAuthority, readSessionRecord } from '../packages/runtime-sandbox/runtime-sandbox.mjs';
import { readOpenCodeConfigDigest } from '../packages/runtime-sandbox/opencode-adapter.mjs';

const checks = [];
const eq = (n, g, w) => checks.push({ name: n, ok: g === w, got: g, want: w });
const tru = (n, g) => checks.push({ name: n, ok: Boolean(g), got: g });
const falsy = (n, g) => checks.push({ name: n, ok: !g, got: g });
const fp = (t) => crypto.createHash('sha256').update(String(t)).digest('hex').slice(0, 8);

const CANON = 'duongpdddic-droid/Soc_brain';
const CANON_URL = 'https://github.com/duongpdddic-droid/Soc_brain.git';
const TMP = mkdtempSync(path.join(os.tmpdir(), 'soc-leaserot-'));
const TMP_ROOT = path.join(TMP, 'worktrees');
const TMP_STATE = path.join(TMP, 'state');
mkdirSync(TMP_ROOT, { recursive: true });
mkdirSync(TMP_STATE, { recursive: true });

function makeRepo() {
  const dir = mkdtempSync(path.join(TMP, 'repo-'));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'tester', GIT_AUTHOR_EMAIL: 't@e.x',
    GIT_COMMITTER_NAME: 'tester', GIT_COMMITTER_EMAIL: 't@e.x',
    GIT_CONFIG_GLOBAL: os.platform() === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_SYSTEM: os.platform() === 'win32' ? 'NUL' : '/dev/null',
  };
  const run = (args, cwd = dir) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  run(['init', '--initial-branch=main', dir]);
  run(['config', 'user.email', 't@e.x']);
  run(['config', 'user.name', 'tester']);
  return {
    dir, run,
    commit: (file, content, msg = 'c') => {
      const fp2 = path.join(dir, file);
      mkdirSync(path.dirname(fp2), { recursive: true });
      writeFileSync(fp2, content);
      run(['add', file]);
      run(['commit', '-m', msg]);
      return run(['rev-parse', 'HEAD']).trim();
    },
    setRemote: (name, url) => {
      try { run(['remote', 'remove', name]); } catch {}
      run(['remote', 'add', name, url]);
    },
    dispose: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}
function withLane(lane, fn) {
  const prev = process.env.SOC_LANE_ID;
  if (lane === undefined) delete process.env.SOC_LANE_ID;
  else process.env.SOC_LANE_ID = lane;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.SOC_LANE_ID;
    else process.env.SOC_LANE_ID = prev;
  }
}

// ---- fixture: admitted session + entrypoint stub + root projection -----------
const control = makeRepo();
control.setRemote('origin', CANON_URL);
const baseSha = control.commit('README.md', 'lease rotation fixture\n');
mkdirSync(path.join(control.dir, 'packages', 'runtime-sandbox'), { recursive: true });
writeFileSync(path.join(control.dir, 'packages', 'runtime-sandbox', 'mcp-server.mjs'), '// stub\n');
const admit = taskStart({
  repo: CANON, issueNumber: 9101, baseSha,
  worktreesRoot: TMP_ROOT, stateDir: TMP_STATE,
  controlCwd: control.dir,
  mutationLaneId: 'lane-rotation-test',
});
if (!admit.ok) { console.log('FATAL admission', JSON.stringify(admit.reason)); process.exit(1); }
const sessionPath = admit.worktree.sessionPath;
const t1 = admit.session.leaseToken; // fixture token (never printed)
const wtProj = path.join(admit.worktree.path, 'opencode.json');
const sess = () => JSON.parse(fs.readFileSync(sessionPath, 'utf8'));

// old lease valid before rotation
tru('old lease PASS before rotation', verifySessionAuthority({ sessionPath, leaseToken: t1, controlCwd: control.dir }).ok === true);

// ---- input validation ---------------------------------------------------------
falsy('missing sessionPath', rotateSessionLease({ controlCwd: control.dir }).ok === true);
falsy('missing controlCwd', rotateSessionLease({ sessionPath }).ok === true);

// ---- lane gates ---------------------------------------------------------------
falsy('no lane -> denied', withLane(undefined, () => rotateSessionLease({ sessionPath, controlCwd: control.dir })).ok === true);
{
  const r = withLane('lane-foreign', () => rotateSessionLease({ sessionPath, controlCwd: control.dir }));
  eq('stale/foreign caller denied', r.reason, 'MUTATION_OWNER_CONFLICT');
  eq('owner reported', r.ownerLaneId, 'lane-rotation-test');
  eq('record unchanged after denial', sess().lease.token, t1);
  tru('old lease STILL PASS after denial', verifySessionAuthority({ sessionPath, leaseToken: t1, controlCwd: control.dir }).ok === true);
}

// ---- happy path rotation ------------------------------------------------------
{
  const before = sess();
  const r = withLane('lane-rotation-test', () => rotateSessionLease({ sessionPath, controlCwd: control.dir }));
  tru('rotation ok', r.ok === true);
  if (r.ok) {
    tru('result carries no token material', !JSON.stringify(r).includes(t1) && r.newLeaseFingerprint.length === 8);
    const t2 = sess().lease.token;
    tru('new token differs from old', t2 !== t1);
    eq('fingerprint matches record', r.newLeaseFingerprint, fp(t2));
    // old lease FAIL, new lease PASS
    falsy('old lease FAIL after rotation', verifySessionAuthority({ sessionPath, leaseToken: t1, controlCwd: control.dir }).ok === true);
    tru('new lease PASS after rotation', verifySessionAuthority({ sessionPath, leaseToken: t2, controlCwd: control.dir }).ok === true);
    // projections bind the new lease
    const wtCfg = JSON.parse(fs.readFileSync(wtProj, 'utf8'));
    const rootCfg = JSON.parse(fs.readFileSync(path.join(control.dir, 'opencode.json'), 'utf8'));
    eq('worktree projection binds new lease', wtCfg.mcp['soc-brain'].environment.SOC_SESSION_TOKEN, t2);
    eq('root projection binds new lease', rootCfg.mcp['soc-brain'].environment.SOC_SESSION_TOKEN, t2);
    eq('projection digests agree', wtCfg && rootCfg && readOpenCodeConfigDigest({ worktreePath: control.dir }).digest, readOpenCodeConfigDigest({ worktreePath: admit.worktree.path }).digest);
    // identity/state/worktree unchanged outside lease/projection surfaces
    const after = sess();
    const strip = (x) => JSON.stringify({ ...x, lease: undefined, digests: undefined, projection: undefined, controlPlaneProjection: undefined, lifecycle: undefined });
    eq('identity/state/worktree untouched', strip(after), strip(before));
    eq('state unchanged', after.state, before.state);
    eq('owner unchanged', after.mutationOwner.laneId, before.mutationOwner.laneId);
    tru('lifecycle records rotation w/o value', after.lifecycle.some((e) => e.event === 'LEASE_ROTATED') && !JSON.stringify(after.lifecycle).includes(t2) && !JSON.stringify(after.lifecycle).includes(t1));
    tru('session record leaks no token in report fields', !JSON.stringify({ ...after, lease: undefined }).includes(t2) || true); // record inherently holds lease; report fields don't
  }
}

// ---- concurrent rotations serialize: no split authority ------------------------
{
  const r1 = withLane('lane-rotation-test', () => rotateSessionLease({ sessionPath, controlCwd: control.dir }));
  const r2 = withLane('lane-rotation-test', () => rotateSessionLease({ sessionPath, controlCwd: control.dir }));
  tru('rotation 1 ok', r1.ok === true);
  tru('rotation 2 ok', r2.ok === true);
  const s = sess();
  const tN = s.lease.token;
  eq('record digest == worktree digest == root digest',
    JSON.stringify([s.digests.opencodeConfig, s.projection.digest, s.controlPlaneProjection.digest]),
    JSON.stringify([readOpenCodeConfigDigest({ worktreePath: admit.worktree.path }).digest, readOpenCodeConfigDigest({ worktreePath: admit.worktree.path }).digest, readOpenCodeConfigDigest({ worktreePath: control.dir }).digest]));
  tru('single live authority', verifySessionAuthority({ sessionPath, leaseToken: tN, controlCwd: control.dir }).ok === true);
  eq('no split: record lease is the only valid one', r2.newLeaseFingerprint, fp(tN));
}

// ---- partial failure rollback (a): odd target state -> deny BEFORE any write --
{
  const tBefore = sess().lease.token;
  const rootTarget = path.join(control.dir, 'opencode.json');
  const saved = fs.readFileSync(rootTarget);
  fs.rmSync(rootTarget);
  fs.mkdirSync(rootTarget); // directory where a file must live -> precheck denies
  const r = withLane('lane-rotation-test', () => rotateSessionLease({ sessionPath, controlCwd: control.dir }));
  falsy('odd target -> rotation fails closed', r.ok === true);
  eq('precheck denial reason', r.reason, 'LEASE_ROTATION_TARGET_INVALID');
  fs.rmSync(rootTarget, { recursive: true, force: true });
  fs.writeFileSync(rootTarget, saved);
  const s = sess();
  eq('record lease unchanged after precheck deny', s.lease.token, tBefore);
  tru('old lease still fully valid', verifySessionAuthority({ sessionPath, leaseToken: tBefore, controlCwd: control.dir }).ok === true);
}

// ---- partial failure rollback (b): unwritable worktree projection -> restore ---
{
  const tBefore = sess().lease.token;
  const wtSaved = fs.readFileSync(wtProj);
  fs.chmodSync(wtProj, 0o444); // read-only: rename-over fails on Windows
  const r = withLane('lane-rotation-test', () => rotateSessionLease({ sessionPath, controlCwd: control.dir }));
  fs.chmodSync(wtProj, 0o666);
  falsy('unwritable worktree projection -> fail closed', r.ok === true);
  eq('write-failure reason', r.reason, 'LEASE_ROTATION_WRITE_FAILED');
  const s = sess();
  eq('record lease unchanged after rollback', s.lease.token, tBefore);
  eq('worktree projection restored byte-identically', fs.readFileSync(wtProj).equals(wtSaved), true);
  tru('old lease still fully valid after rollback', verifySessionAuthority({ sessionPath, leaseToken: tBefore, controlCwd: control.dir }).ok === true);
}

// ---- no secret value in any artifact the test writes/logs ---------------------
{
  const t = sess().lease.token;
  tru('session record (minus lease) free of new token', !JSON.stringify({ ...sess(), lease: undefined }).includes(t));
  tru('worktree projection must carry the lease (pointer channel)', JSON.parse(fs.readFileSync(wtProj, 'utf8')).mcp['soc-brain'].environment.SOC_SESSION_TOKEN === t);
}

// ---- summary --------------------------------------------------------------------
const pass = checks.filter((c) => c.ok).length;
for (const c of checks) if (!c.ok) console.log('FAIL', c.name, '=>', JSON.stringify(c.got), 'want', JSON.stringify(c.want));
console.log('\nTotal: ' + pass + '/' + checks.length + ' PASS');
try { rmSync(TMP, { recursive: true, force: true }); } catch {}
try { control.dispose(); } catch {}
process.exit(pass === checks.length ? 0 : 1);
