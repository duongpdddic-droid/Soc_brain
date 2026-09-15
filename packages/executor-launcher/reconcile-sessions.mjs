#!/usr/bin/env node
// reconcile-sessions.mjs — Issue #9000005 operator maintenance entrypoint.
//
// ONE deterministic canonical path that scans the SESSION lifecycle dimension,
// classifies each session ACTIVE / STALE_RECONCILABLE / PARKED / TERMINAL /
// UNKNOWN (reusing the exact same invariant recovery discovery uses), prints a
// before/after table, and — ONLY with an explicit --apply — parks the positively-
// proven stale sessions through the canonical ownership-safe seam (parkStaleSession).
//
// Dry-run by default. It never deletes a session, never rewrites JSON outside the
// seam, never releases a mutationOwner, never terminalizes UNKNOWN, never touches
// a live executor or a Human Gate, and never auto-resumes a BLOCKED task.
//
//   node packages/executor-launcher/reconcile-sessions.mjs                 # dry-run, default state dir
//   node packages/executor-launcher/reconcile-sessions.mjs --repo o/r      # restrict to one repo
//   node packages/executor-launcher/reconcile-sessions.mjs --stateDir <p>  # explicit state dir
//   node packages/executor-launcher/reconcile-sessions.mjs --apply         # mutate (explicit only)
import { reconcileStaleSessions } from './executor-recovery.mjs';
import { enumerateActiveTasks } from '../client-mcp/recovery.mjs';
import { defaultStateDir } from '../runtime-sandbox/runtime-sandbox.mjs';

function parseArgs(argv) {
  const out = { stateDir: defaultStateDir(), repo: null, apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--repo') out.repo = argv[++i] ?? null;
    else if (a === '--stateDir' || a === '--state-dir') out.stateDir = argv[++i] ?? out.stateDir;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write('usage: node reconcile-sessions.mjs [--stateDir <path>] [--repo owner/name] [--apply]\n');
    process.exit(0);
  }
  const before = enumerateActiveTasks({ stateDir: args.stateDir });
  const r = reconcileStaleSessions({ stateDir: args.stateDir, repo: args.repo, apply: args.apply });
  if (!r.ok) {
    process.stdout.write(`reconcile failed: ${r.reason}${r.detail ? ` — ${r.detail}` : ''}\n`);
    process.exit(1);
  }
  const after = args.apply ? enumerateActiveTasks({ stateDir: args.stateDir }) : before;
  const header = ['issue', 'sessionState', 'loopTail', 'exec', 'promoted', 'owner', 'classification', 'action', 'wouldMutate', 'after', 'reason'].join('\t');
  const lines = r.evidence.results.map((x) => [
    x.issueNumber ?? '?', x.sessionState ?? '-', x.loopTail ?? '-', x.executionLiveness ?? '-',
    x.promotedExecutor ? 'Y' : 'n', x.mutationOwner ?? '-', x.classification, x.proposedAction,
    x.wouldMutate ? 'YES' : 'NO', x.after ?? '-', x.reason ?? '',
  ].join('\t'));
  process.stdout.write(`${args.apply ? 'APPLY' : 'DRY-RUN'} stateDir=${args.stateDir} repo=${args.repo ?? '(all)'}\n`);
  process.stdout.write(`scanned=${r.evidence.scanned} mutated=${r.evidence.mutated} counts=${JSON.stringify(r.evidence.counts)}\n`);
  process.stdout.write(`recovery-active BEFORE=${before.tasks.length} AFTER=${after.tasks.length} (unreadable=${before.unreadable} unknown=${before.unknown})\n`);
  process.stdout.write(`${header}\n${lines.join('\n')}\n`);
  if (before.tasks.length !== after.tasks.length) {
    process.stdout.write(`\nACTIVE before: ${before.tasks.map((t) => `${t.repo}#${t.issueNumber}(${t.state})`).join(', ') || '(none)'}\n`);
    process.stdout.write(`ACTIVE after : ${after.tasks.map((t) => `${t.repo}#${t.issueNumber}(${t.state})`).join(', ') || '(none)'}\n`);
  }
  if (!args.apply) process.stdout.write('\ndry-run: nothing mutated. Re-run with --apply to park the STALE_RECONCILABLE sessions.\n');
  process.exit(0);
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('reconcile-sessions.mjs')) main();
