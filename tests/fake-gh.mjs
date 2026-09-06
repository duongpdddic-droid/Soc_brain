// tests/fake-gh.mjs — deterministic in-memory gh CLI for the P0-F canonical
// delivery lifecycle tests. Implements exactly the subcommands
// packages/control-loop/delivery.mjs invokes, with one shared mutable state
// object so tests can simulate ambiguity, failures and crash/replay windows.
// `order` records every invocation (including test-side markers) so delivery
// ORDERING can be asserted; `state` records the simulated remote world.
export function fakeGh({
  issue = 81,
  headSha = 'a'.repeat(40),
  baseSha = 'f'.repeat(40),
  prNumber = 80,
  order = [],
  createBehavior = null,
  mergeBehavior = null,
  closeBehavior = null,
  readPullBehavior = null,
  apiBehavior = null,
} = {}) {
  const state = { merged: false, closed: false, mergeCommitOid: null, prHead: headSha, prNumber };
  const j = (code, obj, stderr = '') => ({ code, stdout: obj === undefined ? '' : JSON.stringify(obj), stderr });
  function gh(args) {
    const a = args.map(String);
    order.push(a.join(' '));
    if (a[0] === 'pr' && a[1] === 'create') {
      if (createBehavior) { const r = createBehavior(state); if (r === 'THROW') throw new Error('create THREW'); return r; }
      return { code: 0, stdout: `https://github.com/duongpdddic-droid/Soc_brain/pull/${state.prNumber}\n`, stderr: '' };
    }
    if (a[0] === 'pr' && a[1] === 'list') {
      const list = state.merged ? [{ number: state.prNumber, state: 'MERGED', headRefOid: state.prHead }] : [];
      return j(0, list);
    }
    if (a[0] === 'pr' && a[1] === 'view') {
      if (readPullBehavior) { const r = readPullBehavior(state); if (r === 'THROW') throw new Error('view THREW'); return r; }
      return j(0, {
        number: state.prNumber,
        state: state.merged ? 'MERGED' : 'OPEN',
        headRefName: 'feature/x', headRefOid: state.prHead,
        mergeable: true, mergeStateStatus: 'CLEAN', baseRefName: 'main',
        mergeCommit: state.merged ? { oid: state.mergeCommitOid } : null,
      });
    }
    if (a[0] === 'pr' && a[1] === 'merge') {
      if (mergeBehavior) { const r = mergeBehavior(state); if (r === 'THROW') throw new Error('merge THREW'); return r; }
      state.merged = true;
      state.mergeCommitOid = 'd'.repeat(40);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (a[0] === 'issue' && a[1] === 'view') {
      return j(0, { number: issue, state: state.closed ? 'CLOSED' : 'OPEN' });
    }
    if (a[0] === 'issue' && a[1] === 'close') {
      if (closeBehavior) { const r = closeBehavior(state); if (r === 'THROW') throw new Error('close THREW'); return r; }
      state.closed = true;
      return { code: 0, stdout: '', stderr: '' };
    }
    if (a[0] === 'api') {
      if (apiBehavior) { const r = apiBehavior(a[1], a); if (r === 'THROW') throw new Error('api THREW'); return r; }
      const p = a[1];
      if (/\/commits\/[0-9a-f]{40}$/.test(p)) {
        const oid = p.slice(-40);
        return j(0, { sha: oid, commit: { message: `feat: canonical task delivery (#${issue})\n\nCloses #${issue}` }, parents: [{ sha: baseSha }, { sha: headSha }] });
      }
      if (/\/branches\//.test(p)) {
        return j(0, { name: 'main', commit: { sha: state.merged ? state.mergeCommitOid : baseSha } });
      }
      if (/\/commits$/.test(p)) {
        const list = state.merged ? [state.mergeCommitOid, headSha, baseSha] : [baseSha];
        return j(0, list.map((sha) => ({ sha })));
      }
      throw new Error(`UNMOCKED api: ${p}`);
    }
    throw new Error(`UNMOCKED gh: ${a.join(' ')}`);
  }
  return { gh, state, order };
}