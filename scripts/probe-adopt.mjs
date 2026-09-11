import { adoptLegacyTaskForReview } from '../packages/control-loop/legacy-adoption.mjs';

const ghCall = (args) => {
  const a = args.map(String);
  if (a[0] === 'pr' && a[1] === 'view' && a[2] === '77') return { code: 0, stdout: JSON.stringify({ state: 'OPEN', headRefOid: 'a'.repeat(40), headRefName: 'task/x' }), stderr: '' };
  return { code: 1, stdout: '', stderr: 'unmocked' };
};
const gitCall = (args, { cwd } = {}) => {
  const a = args.map(String);
  if (a[0] === 'rev-parse' && a[1] === '--show-toplevel') return { code: 0, stdout: cwd + '\n', stderr: '' };
  if (a[0] === 'rev-parse' && a[1] === '--abbrev-ref') return { code: 0, stdout: 'task/x\n', stderr: '' };
  if (a[0] === 'rev-parse' && a[1] === 'HEAD') return { code: 0, stdout: 'a'.repeat(40) + '\n', stderr: '' };
  if (a[0] === 'remote' && a[1] === 'get-url') return { code: 0, stdout: 'https://github.com/duongpdddic-droid/Soc_brain.git\n', stderr: '' };
  return { code: 1, stdout: '', stderr: 'unmocked git' };
};
try {
  const r = adoptLegacyTaskForReview({
    repo: 'duongpdddic-droid/Soc_brain', issueNumber: 999, pullRequestNumber: 77,
    branch: 'task/x', headSha: 'a'.repeat(40),
    stateDir: new URL('./tmp-probe-state/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    adoptedBy: 'probe',
    ghCall, gitCall,
  });
  console.log(JSON.stringify({ ok: r.ok, code: r.code ?? null, reason: r.reason ?? null }).slice(0, 300));
} catch (e) {
  console.log('THREW:', String(e.message).slice(0, 200));
}
