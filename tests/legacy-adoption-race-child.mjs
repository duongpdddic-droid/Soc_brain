// legacy-adoption-race-child.mjs — concurrent adopter for the F1 barrier
// regression of tests/legacy-adoption.test.mjs. Performs ONE adoption against
// the SHARED stateDir/worktreesRoot with its own (pr, head, worktree) and
// writes the typed result JSON to outPath. Not part of the deterministic
// single-process suite by itself — spawned by the parent test.
import fs from 'node:fs';
import { adoptLegacyTaskForReview } from '../packages/control-loop/legacy-adoption.mjs';

const [stateDir, worktreesRoot, wtDir, prNumber, headSha, branch, outPath] = process.argv.slice(2);
const REPO = 'duongpdddic-droid/soc_brain';
const ISSUE = 147;

const ghState = { issue: { number: ISSUE, state: 'OPEN' }, pr: { number: Number(prNumber), state: 'OPEN', headRefName: branch, headRefOid: headSha } };
const ghCall = (args) => {
  if (args[0] === 'issue' && args[1] === 'view') return { code: 0, stdout: JSON.stringify(ghState.issue) };
  if (args[0] === 'pr' && args[1] === 'view') {
    const requested = Number(args[2]);
    return { code: 0, stdout: JSON.stringify({ ...ghState.pr, number: requested, comments: [] }) };
  }
  if (args[0] === 'pr' && args[1] === 'list') return { code: 0, stdout: JSON.stringify([ghState.pr]) };
  return { code: 1, stderr: 'unexpected' };
};
const gitCall = (args, { cwd } = {}) => {
  const dir = cwd || wtDir;
  if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return { code: 0, stdout: dir + '\n' };
  if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return { code: 0, stdout: branch + '\n' };
  if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { code: 0, stdout: headSha + '\n' };
  if (args[0] === 'remote' && args[1] === 'get-url') return { code: 0, stdout: `https://github.com/${REPO}.git\n` };
  return { code: 1, stdout: '', stderr: 'unexpected' };
};

let r;
try {
  r = await adoptLegacyTaskForReview({
    repo: REPO, issueNumber: ISSUE, pullRequestNumber: Number(prNumber), branch, headSha,
    worktreePath: wtDir, evidence: [], stateDir, worktreesRoot,
    adoptedBy: `race-${prNumber}`, ghCall, gitCall,
  });
} catch (e) {
  r = { ok: false, code: 'CHILD_THROWN', detail: String(e?.message ?? e) };
}
fs.writeFileSync(outPath, JSON.stringify(r), 'utf8');
