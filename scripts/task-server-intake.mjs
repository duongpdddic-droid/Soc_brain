#!/usr/bin/env node
// task-server-intake.mjs — Issue #132 (rework step 1): the REAL task-server
// claim/start seam, repo-side.
//
// The MCP task server (external repo, AI_PR_REVIEWER) drives claim/handoff via
// `gh` + status labels. This script is the claim/start entrypoint of the SAME
// flow inside Soc_brain, in the required order:
//
//   claim (status flip + marker + read-back BEFORE any workspace mutation;
//   base = origin/main read at claim time) -> canonical workspace provision
//   (packages/workspace primitives) -> canonical sessionAtIntake() — the
//   session record EXISTS IMMEDIATELY after claim, with the ControlLoop
//   terminalize token bound at intake.
//
// Fail-closed: exactly-one claim with read-back, and NO session backfill for
// tasks that never entered this seam. No UI, no provider transports
// (Issue #132 non-goals).
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { provision, defaultWorktreesRoot } from '../packages/workspace/workspace.mjs';
import { defaultStateDir, sessionPathFor, readSessionRecord } from '../packages/runtime-sandbox/runtime-sandbox.mjs';
import { sessionAtIntake } from '../packages/task-intake/session-at-intake.mjs';

export const CANONICAL_REPO = 'duongpdddic-droid/Soc_brain';
const SHA40_RE = /^[0-9a-f]{40}$/;

const labelNames = (v) => (Array.isArray(v && v.labels) ? v.labels.map((l) => (typeof l === 'string' ? l : l && l.name)).filter(Boolean) : []);

// claimAndIntake — the seam orchestration with injected transports. Tests pass
// a fake gh + a fixture git root; the CLI passes real gh/git and the canonical
// defaults. Status contract: CLAIMED | ALREADY_CLAIMED | BLOCKED_* | ERROR_*.
export function claimAndIntake({
  repo = CANONICAL_REPO, issueNumber,
  gh, git, repoRoot,
  worktreesRoot = defaultWorktreesRoot(),
  stateDir = defaultStateDir(),
  dispatchOptions = {},
  laneId = 'task-server-intake',
} = {}) {
  const fail = (status, extra = {}) => ({ status, repo, issueNumber: issueNumber ?? null, ...extra });
  if (typeof repo !== 'string' || !repo) return fail('ERROR_REPO');
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) return fail('ERROR_ISSUE_NUMBER');
  if (typeof gh !== 'function' || typeof git !== 'function') return fail('ERROR_TRANSPORT');

  // (1) The issue must be an open, ready task (or already claimed by us).
  const issue = run(gh, ['issue', 'view', String(issueNumber), '--json', 'number,state,labels']);
  if (!issue.ok) return fail('ERROR_GH', { detail: issue.detail || null });
  let v;
  try { v = JSON.parse(issue.stdout || '{}'); } catch { return fail('ERROR_GH', { detail: 'issue view: unparsable output' }); }
  if (v.state !== 'OPEN') return fail('BLOCKED_ISSUE_NOT_OPEN', { labels: labelNames(v) });
  const labels = labelNames(v);
  const inProgress = labels.includes('status:in-progress');
  const ready = labels.includes('status:ready-for-cline');
  if (inProgress && ready) return fail('BLOCKED_LABEL_SPLIT_BRAIN', { labels });
  if (!inProgress && !ready) return fail('BLOCKED_NOT_READY', { labels });

  // (2) The admission base is origin/main RIGHT NOW — never a stale HEAD.
  const b = run(git, ['rev-parse', 'origin/main']);
  if (!b.ok || !SHA40_RE.test((b.stdout || '').trim())) {
    return fail('ERROR_BASE_SHA', { detail: b.detail || 'origin/main unreadable' });
  }
  const baseSha = (b.stdout || '').trim();

  // (3) Claim flip + marker + read-back BEFORE any workspace/session mutation.
  if (!inProgress) {
    const editArgs = ['issue', 'edit', String(issueNumber), '--remove-label', 'status:ready-for-cline'];
    for (const l of (labels.includes('agent:cline') ? ['status:in-progress'] : ['status:in-progress', 'agent:cline'])) {
      editArgs.push('--add-label', l);
    }
    const edit = run(gh, editArgs);
    if (!edit.ok) return fail('ERROR_CLAIM_MUTATION', { detail: edit.detail || null });
    const marker = run(gh, ['issue', 'comment', String(issueNumber), '--body', JSON.stringify({ claimedBy: 'soc-brain/task-server-intake', repo, issueNumber, baseSha, claimedAt: new Date().toISOString() })]);
    if (!marker.ok) return fail('ERROR_CLAIM_MARKER', { detail: marker.detail || null });
    const back = run(gh, ['issue', 'view', String(issueNumber), '--json', 'labels']);
    let bv = null;
    try { bv = JSON.parse(back.stdout || '{}'); } catch { bv = null; }
    const now = labelNames(bv);
    if (!back.ok || !now.includes('status:in-progress') || now.includes('status:ready-for-cline')) {
      return fail('BLOCKED_CLAIM_READBACK_MISMATCH', { labels: now });
    }
  }
  // (4) Canonical workspace provision (idempotent; transaction-owned).
  const p = provision({ worktreesRoot, repo, issueNumber, baseSha, cwd: repoRoot });
  if (!p.ok) return fail('BLOCKED_PROVISION_FAILED', { reason: p.reason || null, detail: p.detail || null });

  // (5) Canonical session AT INTAKE — the binding exists now, so
  // sessionAtIntake enters the canonical runtime (taskStart + token bind).
  // Issue #145: the claiming lane becomes the single mutation owner; a second
  // lane claiming the same issue fails closed at admission (MUTATION_OWNER_CONFLICT).
  const intake = sessionAtIntake({ repo, issueNumber, baseSha, worktreesRoot, stateDir, controlCwd: repoRoot, dispatchOptions, mutationLaneId: laneId });
  if (!intake.ok) {
    return fail('BLOCKED_INTAKE_FAILED', { reason: intake.reason || null, detail: intake.detail || null, chain: intake.chain || null });
  }

  // (6) THE seam proof: the session record exists on disk IMMEDIATELY after
  // claim — read back from its canonical identity-addressed location.
  const h = intake.sessionAtIntake.identityHash;
  const sPath = sessionPathFor({ stateDir: path.resolve(stateDir), identityHash: h });
  const rs = readSessionRecord(sPath);
  if (!rs.ok) return fail('BLOCKED_SESSION_READBACK_FAILED', { sessionPath: sPath, reason: rs.reason || null });

  return {
    status: inProgress ? 'ALREADY_CLAIMED' : 'CLAIMED',
    repo, issueNumber, baseSha,
    identityHash: h,
    sessionPath: sPath,
    worktreePath: intake.sessionAtIntake.worktreePath,
    branch: intake.sessionAtIntake.branch,
    tokenBound: intake.sessionAtIntake.tokenBound,
    session: { state: rs.session.state, taskId: rs.session.taskId },
  };
}

function run(fn, args) {
  try {
    const r = fn(args);
    // Issue #141: injected transports return the {ok,...} contract; the CLI
    // wires execFileSync-with-encoding, which returns a PLAIN STRING (or a
    // Buffer without encoding). Box everything else to {ok, stdout, stderr}
    // so production stdout is never dropped (pre-fix: BLOCKED_ISSUE_NOT_OPEN
    // with labels [] on a real `gh issue view`).
    if (r && typeof r === 'object' && 'ok' in r) return r;
    if (typeof r === 'string' || Buffer.isBuffer(r)) {
      return { ok: true, stdout: String(r), stderr: '' };
    }
    return { ok: true, stdout: String((r && r.stdout) ?? ''), stderr: String((r && r.stderr) ?? '') };
  } catch (e) {
    return { ok: false, detail: String((e && e.message) || e) };
  }
}

async function main() {
  const args = parseArgs({
    args: process.argv.slice(2),
    options: {
      claim: { type: 'string' },
      repo: { type: 'string', default: CANONICAL_REPO },
      'worktrees-root': { type: 'string' },
      'state-dir': { type: 'string' },
      // Issue #145: stable mutation-owner lane identity for this claim.
      lane: { type: 'string' },
    },
  });
  const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
  if (!args.values.claim) {
    out({ status: 'ERROR_USAGE', detail: 'usage: node scripts/task-server-intake.mjs --claim <issueNumber>' });
    process.exit(2);
  }
  const git = (gitArgs) => execFileSync('git', gitArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const gh = (ghArgs) => execFileSync('gh', ghArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  let repoRoot = null;
  try { repoRoot = git(['rev-parse', '--show-toplevel']).trim(); } catch { repoRoot = null; }
  if (!repoRoot) {
    out({ status: 'ERROR_REPO_ROOT', detail: 'git rev-parse --show-toplevel failed — run from inside the canonical checkout' });
    process.exit(1);
  }
  const res = claimAndIntake({
    repo: args.values.repo,
    issueNumber: Number(args.values.claim),
    gh, git, repoRoot,
    ...(args.values['worktrees-root'] ? { worktreesRoot: args.values['worktrees-root'] } : {}),
    ...(args.values['state-dir'] ? { stateDir: args.values['state-dir'] } : {}),
    ...(args.values.lane ? { laneId: args.values.lane } : {}),
  });
  out(res);
  process.exit(res.status === 'CLAIMED' || res.status === 'ALREADY_CLAIMED' ? 0 : 1);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename;
if (isMain) main().catch((e) => { process.stderr.write(`task-server-intake fatal: ${String((e && e.message) || e)}\n`); process.exit(1); });

