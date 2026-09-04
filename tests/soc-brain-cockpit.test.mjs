#!/usr/bin/env node
// soc-brain-cockpit.test.mjs — tests for packages/soc-brain-cockpit
// (Issue #33, SOC_BRAIN_COCKPIT_V0). No framework. Exit 0 = PASS, 1 = FAIL.
// Disposable temp directories (same convention as soc-score.test.mjs /
// runtime-sandbox.test.mjs). Read-only module: the test writes ONLY inside its
// own temp dirs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  SOC_BRAIN_COCKPIT_VERSION,
  resolveSessionPath, readSessionRecord, renderCockpit,
} from '../packages/soc-brain-cockpit/soc-brain-cockpit.mjs';

const checks = [];
const eq = (n, g, w) => checks.push({ name: n, ok: g === w, got: g, want: w });
const tru = (n, g) => checks.push({ name: n, ok: Boolean(g), got: g });
const falsy = (n, g) => checks.push({ name: n, ok: !g, got: g });
const deepEq = (n, g, w) => checks.push({ name: n, ok: JSON.stringify(g) === JSON.stringify(w), got: g, want: w });

const TMP = mkdtempSync(path.join(os.tmpdir(), 'soc-brain-cockpit-'));

// Canonical-shape session record fixture (fields mirror the authoritative
// record written by runtime-sandbox taskStart — schemaVersion/state/taskId/
// repo/issueNumber/baseSha/branch/headSha/worktreePath/capabilities/
// controlPlane/lifecycle). The lease token is deliberately present to prove
// the cockpit NEVER renders it.
const LEASE_TOKEN = 'lease-token-secret-0123456789abcdef';
const sessionRecord = {
  schemaVersion: '1',
  state: 'SESSION_ACTIVE',
  taskId: 'duongpdddic-droid/soc_brain#33',
  repo: 'duongpdddic-droid/Soc_brain',
  issueNumber: 33,
  baseSha: '2a6d20f423ee7eb18cccec91ed4b55d9fd5fafa3',
  branch: 'soc/task-abc123',
  headSha: 'a'.repeat(40),
  worktreePath: path.join(TMP, 'wt'),
  lease: { token: LEASE_TOKEN, issuedAt: '2026-09-04T00:00:00.000Z' },
  capabilities: ['status', 'diff', 'run_registered_test', 'commit'],
  controlPlane: {
    stateDir: TMP,
    sessionPath: 'CONTROL_PLANE_SESSION_PATH',
    bindingPath: path.join(TMP, 'binding.json'),
    worktreesRoot: path.join(TMP, 'worktrees'),
  },
  lifecycle: [
    { event: 'TASK_START_REQUESTED', at: '2026-09-04T00:00:00.000Z', detail: 'identity abc' },
    { event: 'SESSION_ACTIVE', at: '2026-09-04T00:00:01.000Z', detail: 'lease deadbeef…' },
  ],
};

// Broker-result fixtures mirroring soc_broker_status / soc_broker_diff output.
const brokerStatus = {
  ok: true,
  operation: 'status',
  data: { entries: [{ code: '??', path: 'opencode.json' }], truncated: false, outputBytes: 17 },
  evidence: { redactionApplied: true },
};
const brokerDiff = {
  ok: true,
  operation: 'diff',
  mode: 'working_tree',
  data: { output: 'diff --git a/x b/x', truncated: false, outputBytes: 18 },
  evidence: { redactionApplied: true },
};

// ---- 1. constants ------------------------------------------------------------
eq('SOC_BRAIN_COCKPIT_VERSION is "0"', SOC_BRAIN_COCKPIT_VERSION, '0');

// ---- 2. resolveSessionPath: explicit wins, env fallback, else null -----------
{
  eq('explicit path wins',
    resolveSessionPath({ sessionPath: 'C:/explicit/session.json', env: { SOC_SESSION_PATH: 'C:/env/x.json' } }),
    'C:/explicit/session.json');
  eq('env fallback when no explicit path',
    resolveSessionPath({ env: { SOC_SESSION_PATH: 'C:/env/x.json' } }),
    'C:/env/x.json');
  eq('null when neither explicit nor env', resolveSessionPath({ env: {} }), null);
  eq('null when env empty string', resolveSessionPath({ env: { SOC_SESSION_PATH: '' } }), null);
  eq('null when env object missing', resolveSessionPath({}), null);
}

// ---- 3. readSessionRecord: fail-closed read + parse --------------------------
{
  falsy('missing path -> ok=false', readSessionRecord('').ok);
  eq('missing path reason', readSessionRecord('').reason, 'SESSION_PATH_MISSING');
  const missing = readSessionRecord(path.join(TMP, 'does-not-exist.json'));
  falsy('missing file -> ok=false', missing.ok);
  eq('missing file reason', missing.reason, 'SESSION_READ_FAILED');
  const badFile = path.join(TMP, 'bad.json');
  fs.writeFileSync(badFile, '{not json', 'utf8');
  const bad = readSessionRecord(badFile);
  falsy('invalid JSON -> ok=false', bad.ok);
  eq('invalid JSON reason', bad.reason, 'SESSION_PARSE_FAILED');
  const arrFile = path.join(TMP, 'arr.json');
  fs.writeFileSync(arrFile, '[1,2]', 'utf8');
  falsy('non-object JSON -> ok=false', readSessionRecord(arrFile).ok);

  const goodFile = path.join(TMP, 'session.json');
  fs.writeFileSync(goodFile, JSON.stringify(sessionRecord, null, 2), 'utf8');
  const good = readSessionRecord(goodFile);
  tru('valid record -> ok=true', good.ok);
  eq('valid record round-trips state', good.session.state, 'SESSION_ACTIVE');
  eq('valid record returns its path', good.sessionPath, goodFile);
}

// ---- 4. renderCockpit: deterministic canonical view --------------------------
{
  const v1 = renderCockpit({ session: sessionRecord, sessionPath: 'CONTROL_PLANE_SESSION_PATH', status: brokerStatus, diff: brokerDiff });
  tru('render ok', v1.ok);
  const j = v1.json;
  eq('cockpitVersion', j.cockpitVersion, '0');
  eq('kind', j.kind, 'soc-brain-cockpit');
  eq('session.state', j.session.state, 'SESSION_ACTIVE');
  eq('session.repo', j.session.repo, 'duongpdddic-droid/Soc_brain');
  eq('session.issueNumber', j.session.issueNumber, 33);
  eq('session.baseSha', j.session.baseSha, '2a6d20f423ee7eb18cccec91ed4b55d9fd5fafa3');
  eq('session.branch', j.session.branch, 'soc/task-abc123');
  eq('session.headSha', j.session.headSha, 'a'.repeat(40));
  eq('session.taskId', j.session.taskId, 'duongpdddic-droid/soc_brain#33');
  deepEq('capabilities verbatim', j.session.capabilities, ['status', 'diff', 'run_registered_test', 'commit']);
  deepEq('lifecycle verbatim (no invented state)', j.session.lifecycle, [
    { event: 'TASK_START_REQUESTED', at: '2026-09-04T00:00:00.000Z', detail: 'identity abc' },
    { event: 'SESSION_ACTIVE', at: '2026-09-04T00:00:01.000Z', detail: 'lease deadbeef…' },
  ]);
  // Broker git facts surfaced verbatim/bounded.
  deepEq('status entries verbatim', j.worktree.status.entries, [{ code: '??', path: 'opencode.json' }]);
  eq('status truncated flag', j.worktree.status.truncated, false);
  eq('status outputBytes', j.worktree.status.outputBytes, 17);
  eq('diff mode', j.worktree.diff.mode, 'working_tree');
  eq('diff truncated flag', j.worktree.diff.truncated, false);
  eq('diff outputBytes', j.worktree.diff.outputBytes, 18);
  falsy('diff body never rendered (minimal)', j.worktree.diff.output);

  // Secrets never rendered.
  tru('lease token absent from json', !JSON.stringify(j).includes(LEASE_TOKEN));
  tru('lease token absent from text', !v1.text.includes(LEASE_TOKEN));

  // Determinism: identical inputs -> byte-identical output.
  const v2 = renderCockpit({ session: sessionRecord, sessionPath: 'CONTROL_PLANE_SESSION_PATH', status: brokerStatus, diff: brokerDiff });
  eq('deterministic json', JSON.stringify(v1.json), JSON.stringify(v2.json));
  eq('deterministic text', v1.text, v2.text);

  // Text view carries the canonical facts.
  tru('text header', v1.text.startsWith('SOC_BRAIN_COCKPIT v0 (read-only)'));
  tru('text task line', v1.text.includes('task: duongpdddic-droid/Soc_brain#33 state=SESSION_ACTIVE'));
  tru('text status entry', v1.text.includes('?? opencode.json'));
  tru('text status summary', v1.text.includes('status: 1 entries (truncated=false, bytes=17)'));
  tru('text diff summary', v1.text.includes('diff: mode=working_tree truncated=false bytes=18'));
  tru('text lifecycle line', v1.text.includes('- TASK_START_REQUESTED 2026-09-04T00:00:00.000Z identity abc'));
  tru('text lifecycle state line', v1.text.includes('- SESSION_ACTIVE'));
}

// ---- 5. renderCockpit: absent inputs are honest, not fabricated --------------
{
  const v = renderCockpit({ session: sessionRecord, sessionPath: 'P' });
  tru('ok without broker facts', v.ok);
  eq('status section null when absent', v.json.worktree.status, null);
  eq('diff section null when absent', v.json.worktree.diff, null);
  tru('text says status not provided', v.text.includes('status: (not provided)'));
  tru('text says diff not provided', v.text.includes('diff: (not provided)'));
  eq('session.path falls back to record controlPlane pointer',
    renderCockpit({ session: sessionRecord }).json.session.path, 'CONTROL_PLANE_SESSION_PATH');
}

// ---- 6. renderCockpit: missing session fails closed --------------------------
{
  const v = renderCockpit({});
  falsy('no session -> ok=false', v.ok);
  eq('no session reason', v.reason, 'SESSION_UNAVAILABLE');
  eq('no session json ok=false', v.json.ok, false);
  tru('text states unavailability', v.text.includes('session: unavailable (SESSION_UNAVAILABLE)'));
  const broken = renderCockpit({ session: 'not an object' });
  falsy('non-object session -> ok=false', broken.ok);
}

// ---- 7. CLI: renders from SOC_SESSION_PATH, fails closed, --json -------------
{
  const modulePath = path.resolve('packages/soc-brain-cockpit/soc-brain-cockpit.mjs');
  const goodFile = path.join(TMP, 'session.json');
  const baseEnv = { ...process.env };

  const okRun = spawnSync(process.execPath, [modulePath, '--json'], {
    encoding: 'utf8', shell: false, env: { ...baseEnv, SOC_SESSION_PATH: goodFile },
  });
  eq('CLI exit 0 with canonical session', okRun.status, 0);
  let parsed = null;
  try { parsed = JSON.parse(okRun.stdout); } catch { /* captured below */ }
  tru('CLI --json emits parseable view', parsed && typeof parsed === 'object');
  if (parsed) {
    eq('CLI view kind', parsed.kind, 'soc-brain-cockpit');
    eq('CLI view state', parsed.session && parsed.session.state, 'SESSION_ACTIVE');
    eq('CLI view issueNumber', parsed.session && parsed.session.issueNumber, 33);
  }
  tru('CLI json view hides lease token', !okRun.stdout.includes(LEASE_TOKEN));

  const textRun = spawnSync(process.execPath, [modulePath], {
    encoding: 'utf8', shell: false, env: { ...baseEnv, SOC_SESSION_PATH: goodFile },
  });
  eq('CLI text mode exit 0', textRun.status, 0);
  tru('CLI text header', textRun.stdout.startsWith('SOC_BRAIN_COCKPIT v0 (read-only)'));

  const noEnvRun = spawnSync(process.execPath, [modulePath], {
    encoding: 'utf8', shell: false, env: { ...baseEnv, SOC_SESSION_PATH: '' },
  });
  eq('CLI fails closed without session pointer', noEnvRun.status, 1);
  tru('CLI fail-closed text', noEnvRun.stdout.includes('session: unavailable'));

  const missingRun = spawnSync(process.execPath, [modulePath], {
    encoding: 'utf8', shell: false, env: { ...baseEnv, SOC_SESSION_PATH: path.join(TMP, 'nope.json') },
  });
  eq('CLI fails closed on unreadable session', missingRun.status, 1);
  tru('CLI missing-session text', missingRun.stdout.includes('session: unavailable'));
}

// ---- cleanup -----------------------------------------------------------------
for (const dir of [TMP]) { try { rmSync(dir, { recursive: true, force: true }); } catch {} }

// ---- summary -----------------------------------------------------------------
let failed = 0;
for (const c of checks) {
  if (!c.ok) { failed++; console.error(`FAIL ${c.name} got=${JSON.stringify(c.got)} want=${JSON.stringify(c.want)}`); }
}
console.log(`soc-brain-cockpit: ${checks.length - failed}/${checks.length} passed`);
process.exit(failed === 0 ? 0 : 1);
