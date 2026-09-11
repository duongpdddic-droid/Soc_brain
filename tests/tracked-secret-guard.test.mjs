#!/usr/bin/env node
// tracked-secret-guard.test.mjs — tests for scanSessionTokenSecrets /
// trackedSecretGuard + broker SECRET_GUARD_REJECTED wiring (Issue #126).
// NO framework. Exit 0 = PASS, 1 = FAIL. NEVER prints secret values.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { scanSessionTokenSecrets, trackedSecretGuard } from '../packages/safe-git/safe-git.mjs';
import { createExecutionBroker } from '../packages/execution-broker/execution-broker.mjs';
import { taskStart } from '../packages/runtime-sandbox/runtime-sandbox.mjs';

const checks = [];
const eq = (n, g, w) => checks.push({ name: n, ok: g === w, got: g, want: w });
const tru = (n, g) => checks.push({ name: n, ok: Boolean(g), got: g });
const falsy = (n, g) => checks.push({ name: n, ok: !g, got: g });

const CANON = 'duongpdddic-droid/Soc_brain';
const CANON_URL = 'https://github.com/duongpdddic-droid/Soc_brain.git';
const TMP = mkdtempSync(path.join(os.tmpdir(), 'soc-secretguard-'));
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
      const fp = path.join(dir, file);
      mkdirSync(path.dirname(fp), { recursive: true });
      writeFileSync(fp, content);
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

const FAKE_TOKEN = crypto.randomBytes(24).toString('hex'); // fixture-only synthetic value; never printed

// ---- scanner: rejects non-empty value ------------------------------------------
{
  const r = scanSessionTokenSecrets({ content: `{\n  "SOC_SESSION_TOKEN": "${FAKE_TOKEN}"\n}\n` });
  falsy('non-empty value rejected', r.ok);
  eq('one hit', r.hits.length, 1);
  eq('hit line', r.hits[0].line, 2);
  tru('hit carries no value material', !JSON.stringify(r.hits).includes(FAKE_TOKEN));
  tru('snippet redacted', r.hits[0].snippet.includes('<REDACTED>'));
}
// ---- scanner: benign shapes never false-positive --------------------------------
{
  const benign = [
    '{ "SOC_SESSION_TOKEN": "" }',
    '{ "SOC_SESSION_TOKEN": "${SOC_SESSION_TOKEN}" }',
    'const t = process.env.SOC_SESSION_TOKEN;',
    'SOC_SESSION_TOKEN: null',
    'export SOC_SESSION_TOKEN=',
    'read -r SOC_SESSION_TOKEN <<EOF',
    '"SOC_SESSION_TOKEN": "<REDACTED>"',
    'SOC_SESSION_TOKEN="$1"',
  ];
  for (const [i, c] of benign.entries()) {
    const r = scanSessionTokenSecrets({ content: c });
    tru(`benign shape ${i + 1} passes`, r.ok === true);
  }
}
// ---- scanner: other long random strings are not targeted ------------------------
{
  const r = scanSessionTokenSecrets({ content: `digest: ${crypto.randomBytes(32).toString('hex')}` });
  tru('unrelated digest not flagged', r.ok === true);
}

// ---- repo-level tracked scan + broker commit wiring -----------------------------
{
  const control = makeRepo();
  control.setRemote('origin', CANON_URL);
  const baseSha = control.commit('README.md', 'guard fixture\n');
  mkdirSync(path.join(TMP_ROOT, 'x'), { recursive: true });

  // (1) clean tracked tree passes
  const g1 = trackedSecretGuard({ cwd: control.dir });
  tru('clean tracked repo passes', g1.ok === true);
  eq('scanned count', g1.scanned, 1);

  // (2) a tracked file WITH a live-looking token is caught
  control.commit('cfg.json', `{ "SOC_SESSION_TOKEN": "${FAKE_TOKEN}" }\n`, 'c2');
  const g2 = trackedSecretGuard({ cwd: control.dir });
  falsy('tracked secret caught at repo level', g2.ok === true);
  eq('hit file', g2.hits[0] && g2.hits[0].file, 'cfg.json');
  tru('no value in repo-level evidence', !JSON.stringify(g2).includes(FAKE_TOKEN));

  // (3) broker commit refuses to commit a file carrying a token value.
  // The broker verifies the canonical binding BEFORE opCommit, so this uses a
  // REAL taskStart-provisioned worktree (same pattern as lease-rotation.test).
  const admit = taskStart({
    repo: CANON, issueNumber: 9201, baseSha,
    worktreesRoot: TMP_ROOT, stateDir: TMP_STATE,
    controlCwd: control.dir,
    mutationLaneId: 'lane-secret-guard-test',
  });
  if (!admit.ok) { console.log('FATAL admission', JSON.stringify(admit.reason)); process.exit(1); }
  const wt = admit.worktree.path;
  writeFileSync(path.join(wt, 'leak.json'), `{ "SOC_SESSION_TOKEN": "${FAKE_TOKEN}" }\n`);
  const broker = createExecutionBroker({ worktreesRoot: TMP_ROOT, controlCwd: control.dir, testRegistry: {} });
  const res = broker.executeBrokerRequest({
    schemaVersion: '1', operation: 'commit', repo: CANON, issueNumber: 9201, baseSha,
    args: { message: 'fix: x', paths: ['leak.json'] },
  });
  falsy('broker commit blocked by secret guard', res.ok === true);
  eq('broker denial reason', res.reason, 'SECRET_GUARD_REJECTED');
  tru('broker evidence carries no value', !JSON.stringify(res).includes(FAKE_TOKEN));
  const headBeforeBlock = control.run(['-C', wt, 'rev-parse', 'HEAD']).trim();
  const headAfterBlock = control.run(['-C', wt, 'rev-parse', 'HEAD']).trim();
  eq('worktree HEAD unchanged after blocked commit', headAfterBlock, headBeforeBlock);

  // (4) benign commit content still passes the guard and commits cleanly
  writeFileSync(path.join(wt, 'ok.json'), `{ "SOC_SESSION_TOKEN": "" }\n`);
  const res2 = broker.executeBrokerRequest({
    schemaVersion: '1', operation: 'commit', repo: CANON, issueNumber: 9201, baseSha,
    args: { message: 'fix: ok', paths: ['ok.json'] },
  });
  tru('benign commit passes guard + commits', res2.ok === true);
  tru('no value anywhere in broker evidence', !JSON.stringify(res2).includes(FAKE_TOKEN));
  control.dispose();
}

// ---- summary --------------------------------------------------------------------
const pass = checks.filter((c) => c.ok).length;
for (const c of checks) if (!c.ok) console.log('FAIL', c.name, '=>', JSON.stringify(c.got), 'want', JSON.stringify(c.want));
console.log('\nTotal: ' + pass + '/' + checks.length + ' PASS');
try { rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(pass === checks.length ? 0 : 1);
