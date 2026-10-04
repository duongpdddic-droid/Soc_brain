// review-only.test.mjs — Issue #3: REVIEW-ONLY OpenCode execution role.
// No framework. Exit 0 = PASS, 1 = FAIL. All transports injected (no real
// OpenCode/OCR/git/process spawned).
import {
  buildReviewOnlyConfig,
  evaluateReviewOnlyCapabilities,
  buildReviewArgv,
  normalizeOcr,
  resolveOcrExecutable,
  canonicalizeOcrRules,
  ocrRulesDigest,
  REVIEW_MAX_FINDINGS,
  ocrPreviewArgv,
  ocrRuleArgv,
  runOcrPreview,
  runOcrRule,
  readOcrVersion,
  isReadOnlyGitArgs,
  readRangeDiff,
  readRangeFileList,
  readFileDiff,
  planReviewBatches,
  chunkDiffText,
  buildBatchPrompt,
  buildReflectionPrompt,
  createReviewSnapshot,
  buildReviewPrompt,
  extractLastJsonBlock,
  checkReviewerResult,
  assembleReviewEvidence,
  checkReviewBinding,
  runReviewOnlyLeg,
  REVIEW_AGENT,
  REVIEW_LEG_SCHEMA_VERSION,
} from '../packages/review-leg/review-only.mjs';
import fs from 'node:fs';

const checks = [];
const eq = (n, g, w) => checks.push({ name: n, ok: g === w, got: g, want: w });
const tru = (n, g) => checks.push({ name: n, ok: Boolean(g), got: g });

const BIND = {
  repo: 'duongpdddic-droid/soc_brain',
  issueNumber: 75,
  identityHash: 'a'.repeat(32),
  baseSha: 'b'.repeat(40),
  headSha: 'c'.repeat(40),
};
const SCOPE = ['src/a.mjs', 'src/b.mjs'];

function validReviewerResult() {
  return {
    reviewedFiles: ['src/a.mjs', 'src/b.mjs'],
    findings: [{ path: 'src/a.mjs', content: 'null check missing', startLine: 10, endLine: 12, category: 'bug', severity: 'high' }],
    reflectionCompleted: true,
  };
}

function previewJson(over = {}) {
  return JSON.stringify({
    schema_version: '1',
    mode: 'range',
    repository: 'C:/Users/Admin/Soc_brain',
    from: BIND.baseSha,
    to: BIND.headSha,
    merge_base: 'd'.repeat(40),
    total_files: 3,
    reviewable_count: 2,
    excluded_count: 1,
    reviewable_files: [{ path: 'src/a.mjs', status: 'modified', insertions: 4, deletions: 0 }, { path: 'src/b.mjs', status: 'added', insertions: 10, deletions: 0 }],
    excluded_files: [{ path: 'dist/bundle.js', status: 'added', insertions: 5, deletions: 0, exclude_reason: 'generated' }],
    ...over,
  });
}

function ruleJson(groups = [{ group_id: 1, source: 'system', pattern: '**/*.mjs', rule: 'No ==.' }]) {
  return JSON.stringify({ schema_version: '1', groups });
}

// Fake exec router: handlers keyed by `${exe}::${args[0]}::${args[1]||''}`.
function makeFakeExec({ preview = previewJson(), rule = ruleJson(), version = 'open-code-review v1.12.4 (f1101fd7f) windows/amd64', diff = 'diff --git a/src/a.mjs b/src/a.mjs\n+x', fileDiffs = null, calls = [] } = {}) {
  return function fakeExec(exe, args, opts) {
    calls.push({ exe, args: [...args], opts });
    if (exe === 'ocr' && args[0] === 'delegate' && args[1] === 'preview') return preview;
    if (exe === 'ocr' && args[0] === 'delegate' && args[1] === 'rule') return rule;
    if (exe === 'ocr' && args[0] === 'version') return version;
    if (exe === 'git' && args[0] === 'diff') {
      if (fileDiffs && args.includes('--')) return fileDiffs[args[args.length - 1]] ?? '';
      return diff;
    }
    if (exe === 'git' && args[0] === 'worktree') return '';
    throw new Error(`unexpected call: ${exe} ${args.join(' ')}`);
  };
}

function ndjsonStdout(finalText) {
  const ev = (t) => JSON.stringify({ type: 'text', part: { text: t } });
  return [ev('reading files...'), ev(finalText)].join('\n') + '\n';
}

function fencedResult(obj = validReviewerResult()) {
  return `review done\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;
}

// ---- A. enforcement: projection + preflight ----
{
  const cfg = buildReviewOnlyConfig();
  eq('schema version', REVIEW_LEG_SCHEMA_VERSION, '1');
  eq('edit deny', cfg.permission.edit, 'deny');
  eq('bash deny', cfg.permission.bash, 'deny');
  eq('external_directory deny', cfg.permission.external_directory, 'deny');
  eq('webfetch deny', cfg.permission.webfetch, 'deny');
  eq('websearch deny', cfg.permission.websearch, 'deny');
  eq('task deny (no subagents)', cfg.permission.task, 'deny');
  eq('no mcp section', ('mcp' in cfg), false);
  tru('read allow map', cfg.permission.read['*'] === 'allow');
  eq('preflight accepts review cfg', evaluateReviewOnlyCapabilities(cfg).ok, true);
  eq('preflight rejects coding profile', evaluateReviewOnlyCapabilities({ permission: { ...cfg.permission, edit: 'allow', bash: 'allow' } }).code, 'REVIEW_PREFLIGHT_FAILED');
  eq('preflight rejects ask profile', evaluateReviewOnlyCapabilities({ permission: { ...cfg.permission, bash: 'ask' } }).code, 'REVIEW_PREFLIGHT_FAILED');
  eq('preflight rejects task allow', evaluateReviewOnlyCapabilities({ permission: { ...cfg.permission, task: 'allow' } }).code, 'REVIEW_PREFLIGHT_FAILED');
  eq('preflight rejects mcp section', evaluateReviewOnlyCapabilities({ ...cfg, mcp: { 'soc-brain': {} } }).code, 'REVIEW_PREFLIGHT_FAILED');
  eq('preflight rejects broker key', evaluateReviewOnlyCapabilities({ permission: { ...cfg.permission, 'soc-brain_soc_broker_commit': 'allow' } }).code, 'REVIEW_PREFLIGHT_FAILED');
  eq('default agent plan', REVIEW_AGENT, 'plan');
  const av = buildReviewArgv({ instruction: 'review this' });
  tru('argv ok', av.ok);
  tru('argv pins plan', av.argv.includes('--agent') && av.argv[av.argv.indexOf('--agent') + 1] === 'plan');
  tru('argv no --auto', !av.argv.includes('--auto'));
  tru('argv instruction single tail', av.argv[av.argv.length - 1] === 'review this');
  eq('argv oversize rejected', buildReviewArgv({ instruction: 'x'.repeat(9000) }).code, 'REVIEW_INSTRUCTION_INVALID');
}

// ---- B. target ----
eq('binding valid', checkReviewBinding(BIND).ok, true);
eq('binding bad repo', checkReviewBinding({ ...BIND, repo: 'x' }).code, 'REVIEW_BINDING_INVALID');
eq('workspace forbidden', runReviewOnlyLeg({ ...BIND, controlRepo: 'C:/r', targetMode: 'workspace' }).code, 'REVIEW_WORKSPACE_FORBIDDEN');
{
  // Snapshot pins headSha detached; dirty content never copied (fake exec only
  // implements git worktree + read verbs; any cp/copy call would throw).
  const calls = [];
  const r = createReviewSnapshot({
    repo: 'C:/r', headSha: BIND.headSha, exec: makeFakeExec({ calls }),
    mkdtemp: () => 'C:/tmp/soc-review-x',
    writeConfig: ({ snapshotPath, config }) => {
      eq('snapshot config path', snapshotPath, 'C:/tmp/soc-review-x');
      return evaluateReviewOnlyCapabilities(config).ok ? { ok: true } : { ok: false, reason: 'BAD' };
    },
  });
  eq('snapshot ok', r.ok, true);
  const wt = calls.find((c) => c.exe === 'git' && c.args[0] === 'worktree');
  tru('worktree add --detach headSha', wt && wt.args.includes('--detach') && wt.args.includes(BIND.headSha));
  tru('no file copy in snapshot', !calls.some((c) => /^(cp|copy|xcopy|robocopy)$/i.test(String(c.exe))));
}

// ---- C. OCR contract ----
{
  const [, pargs] = ocrPreviewArgv({ ocrBin: 'ocr', repo: 'C:/r', from: BIND.baseSha, to: BIND.headSha });
  tru('preview uses delegate', pargs[0] === 'delegate' && pargs[1] === 'preview');
  tru('preview no llm/review/model flags', !pargs.some((a) => /^(review|llm|scan)$/.test(a) || a.startsWith('--model') || a.startsWith('--provider')));
  const [, rargs] = ocrRuleArgv({ ocrBin: 'ocr', repo: 'C:/r', from: BIND.baseSha, to: BIND.headSha, paths: SCOPE });
  tru('rule uses delegate', rargs[0] === 'delegate' && rargs[1] === 'rule');
  const p = runOcrPreview({ repo: 'C:/r', from: BIND.baseSha, to: BIND.headSha, exec: makeFakeExec() });
  eq('preview ok', p.ok, true);
  eq('preview reviewable', JSON.stringify(p.value.reviewableFiles), JSON.stringify(SCOPE));
  eq('preview exclusion reason mapped', p.value.excludedFiles[0].reason, 'generated');
  eq('preview wrong from', runOcrPreview({ repo: 'C:/r', from: 'd'.repeat(40), to: BIND.headSha, exec: makeFakeExec() }).code, 'REVIEW_TARGET_MISMATCH');
  eq('preview workspace mode', runOcrPreview({ repo: 'C:/r', from: BIND.baseSha, to: BIND.headSha, exec: makeFakeExec({ preview: previewJson({ mode: 'workspace' }) }) }).code, 'REVIEW_TARGET_MISMATCH');
  eq('preview malformed', runOcrPreview({ repo: 'C:/r', from: BIND.baseSha, to: BIND.headSha, exec: makeFakeExec({ preview: 'not json' }) }).code, 'REVIEW_PREVIEW_MALFORMED');
  eq('preview empty scope', runOcrPreview({ repo: 'C:/r', from: BIND.baseSha, to: BIND.headSha, exec: makeFakeExec({ preview: previewJson({ reviewable_files: [], reviewable_count: 0 }) }) }).code, 'REVIEW_SCOPE_EMPTY');
  const enoent = () => { const e = new Error('not found'); e.code = 'ENOENT'; throw e; };
  eq('preview missing bin', runOcrPreview({ repo: 'C:/r', from: BIND.baseSha, to: BIND.headSha, exec: enoent }).code, 'REVIEW_OCR_UNAVAILABLE');
  const rule = runOcrRule({ repo: 'C:/r', from: BIND.baseSha, to: BIND.headSha, paths: SCOPE, exec: makeFakeExec() });
  eq('rule ok', rule.ok, true);
  eq('rule groups counted', rule.value.ruleGroups, 1);
  eq('rule malformed', runOcrRule({ repo: 'C:/r', from: BIND.baseSha, to: BIND.headSha, paths: SCOPE, exec: makeFakeExec({ rule: 'xx' }) }).code, 'REVIEW_RULE_MALFORMED');
  eq('ocr version ok', readOcrVersion({ exec: makeFakeExec() }).version, '1.12.4');
  eq('ocr version bad', readOcrVersion({ exec: makeFakeExec({ version: 'garbage' }) }).code, 'REVIEW_OCR_UNAVAILABLE');
}

// ---- C3. OCR rule canonicalization/digest (F01) ----
{
  const g1 = [{ group_id: 1, source: 'system', pattern: '**/*.mjs', files: ['b', 'a'], rule: 'R', extra: 'ignored-telemetry-ish' }];
  const g2 = [{ rule: 'R', files: ['a', 'b'], pattern: '**/*.mjs', source: 'system', group_id: 1 }];
  tru('canonical drops non-semantic keys', JSON.stringify(canonicalizeOcrRules(g1)).includes('extra') === false);
  eq('key/order equivalent same digest', ocrRulesDigest(g1), ocrRulesDigest(g2));
  tru('digest 64-hex', /^[0-9a-f]{64}$/.test(ocrRulesDigest(g1)));
  const g3 = [{ group_id: 1, source: 'system', pattern: '**/*.mjs', files: ['a', 'b'], rule: 'CHANGED' }];
  tru('semantic change flips digest', ocrRulesDigest(g3) !== ocrRulesDigest(g1));
  eq('malformed groups null', ocrRulesDigest([{ nope: 1 }]), null);
  eq('rule result carries digest', typeof runOcrRule({ repo: 'C:/r', from: BIND.baseSha, to: BIND.headSha, paths: SCOPE, exec: makeFakeExec() }).value.rulesDigest, 'string');
}

// ---- C2. OCR executable resolution (npm-shim safe) ----
{
  const verOut = 'open-code-review v1.12.4 (f1101fd7f) windows/amd64';
  const okProbe = (exe) => { if (exe === 'ocr') return verOut; throw Object.assign(new Error('nf'), { code: 'ENOENT' }); };
  const r1 = resolveOcrExecutable({ exec: okProbe, exists: () => false, env: {} });
  eq('resolver prefers PATH exe', r1.ok && r1.ocr.exe, 'ocr');
  const enoentExec = () => { throw Object.assign(new Error('nf'), { code: 'ENOENT' }); };
  const r2 = resolveOcrExecutable({ exec: enoentExec, exists: (p) => String(p).endsWith('ocr.js'), env: {} });
  eq('resolver falls back node+ocr.js', r2.ok, true);
  tru('fallback prefix carries ocr.js', r2.ok && r2.ocr.prefix.some((a) => String(a).endsWith('ocr.js')));
  const r3 = resolveOcrExecutable({ exec: enoentExec, exists: () => false, env: {} });
  eq('resolver absent fail-closed', r3.code, 'REVIEW_OCR_UNAVAILABLE');
  const r4 = resolveOcrExecutable({ exec: enoentExec, exists: (p) => p === 'C:/ocr-real', env: { SOC_OCR_BIN: 'C:/ocr-real' } });
  eq('resolver honors SOC_OCR_BIN', r4.ok && r4.ocr.exe, 'C:/ocr-real');
  // node+ocr.js prefix still speaks delegate-only argv.
  const [exe, args] = ocrPreviewArgv({ ocr: { exe: 'node', prefix: ['C:/x/ocr.js'] }, repo: 'C:/r', from: BIND.baseSha, to: BIND.headSha });
  eq('prefixed preview exe', exe, 'node');
  tru('prefixed preview delegate first', args[1] === 'delegate' && args[2] === 'preview');
}

// ---- git allowlist ----
tru('git diff allowed', isReadOnlyGitArgs(['diff', '--name-only', 'a', 'b']));
tru('git show allowed', isReadOnlyGitArgs(['show', 'abc:path']));
tru('git log allowed', isReadOnlyGitArgs(['log', '--oneline']));
for (const v of ['commit', 'push', 'merge', 'reset', 'checkout', 'stash', 'add', 'fetch', 'pull', 'worktree']) {
  tru(`git ${v} forbidden`, !isReadOnlyGitArgs([v]));
}
eq('range diff ok', readRangeDiff({ repo: 'C:/r', from: BIND.baseSha, to: BIND.headSha, paths: SCOPE, exec: makeFakeExec() }).ok, true);
eq('range file list ok', readRangeFileList({ repo: 'C:/r', from: BIND.baseSha, to: BIND.headSha, exec: makeFakeExec({ diff: 'src/a.mjs\nsrc/b.mjs\n' }) }).files.length, 2);

// ---- D. evidence ----
{
  const target = { mode: 'range', from: BIND.baseSha, to: BIND.headSha };
  const good = assembleReviewEvidence({
    binding: BIND, target, ocr: { version: '1.12.4', ruleGroups: 1 },
    reviewableFiles: SCOPE, excludedFiles: [{ path: 'dist/bundle.js', reason: 'generated' }],
    reviewerResult: validReviewerResult(), durationMs: 5,
  });
  eq('assemble valid PASS', good.ok, true);
  tru('digest 64-hex', /^[0-9a-f]{64}$/.test(good.value.digest));
  eq('reviewed mismatch', assembleReviewEvidence({
    binding: BIND, target, ocr: { version: '1.12.4', ruleGroups: 1 },
    reviewableFiles: SCOPE, excludedFiles: [],
    reviewerResult: { ...validReviewerResult(), reviewedFiles: ['src/a.mjs'] }, durationMs: 5,
  }).code, 'REVIEW_EVIDENCE_INVALID');
  eq('workspace target', assembleReviewEvidence({
    binding: BIND, target: { mode: 'workspace' }, ocr: { version: '1.12.4', ruleGroups: 1 },
    reviewableFiles: SCOPE, excludedFiles: [], reviewerResult: validReviewerResult(), durationMs: 5,
  }).code, 'REVIEW_WORKSPACE_FORBIDDEN');
  eq('reflection false', assembleReviewEvidence({
    binding: BIND, target, ocr: { version: '1.12.4', ruleGroups: 1 },
    reviewableFiles: SCOPE, excludedFiles: [],
    reviewerResult: { ...validReviewerResult(), reflectionCompleted: false }, durationMs: 5,
  }).code, 'REVIEW_EVIDENCE_INVALID');
  eq('empty scope', assembleReviewEvidence({
    binding: BIND, target, ocr: { version: '1.12.4', ruleGroups: 1 },
    reviewableFiles: [], excludedFiles: [],
    reviewerResult: { reviewedFiles: [], findings: [], reflectionCompleted: true }, durationMs: 5,
  }).code, 'REVIEW_EVIDENCE_INVALID');
  const d1 = assembleReviewEvidence({
    binding: BIND, target, ocr: { version: '1.12.4', ruleGroups: 1 },
    reviewableFiles: SCOPE, excludedFiles: [], reviewerResult: validReviewerResult(), durationMs: 1,
  }).value.digest;
  const d2 = assembleReviewEvidence({
    binding: BIND, target, ocr: { version: '1.12.4', ruleGroups: 1 },
    reviewableFiles: [...SCOPE].reverse(), excludedFiles: [],
    reviewerResult: { ...validReviewerResult(), reviewedFiles: [...SCOPE].reverse() }, durationMs: 999,
  }).value.digest;
  eq('digest deterministic', d1, d2);
  eq('findings bound constant', REVIEW_MAX_FINDINGS, 500);

// ---- D2. findings aggregate bound (F1): no truncation, fail-closed ----
{
  const mkFindings = (n, p = 'src/a.mjs') => Array.from({ length: n }, (_, i) => ({ path: p, content: `finding-${i}`, category: 'bug', severity: 'low' }));
  const target = { mode: 'range', from: BIND.baseSha, to: BIND.headSha };
  const base = {
    binding: BIND, target, ocr: { version: '1.12.4', ruleGroups: 1 },
    reviewableFiles: SCOPE, excludedFiles: [],
    durationMs: 5,
  };
  const ok500 = assembleReviewEvidence({ ...base, reviewerResult: { reviewedFiles: [...SCOPE], findings: mkFindings(500), reflectionCompleted: true } });
  eq('500 findings PASS', ok500.ok, true);
  const over501 = assembleReviewEvidence({ ...base, reviewerResult: { reviewedFiles: [...SCOPE], findings: mkFindings(501), reflectionCompleted: true } });
  eq('501 findings FAIL', over501.code, 'REVIEW_EVIDENCE_INVALID');
  tru('501 no evidence', !over501.value);
}
  eq('reviewer verdict forbidden', checkReviewerResult({ ...validReviewerResult(), verdict: 'PASS' }).code, 'REVIEW_RESULT_VERDICT_FORBIDDEN');
  eq('reviewer metadata rejected', checkReviewerResult({ ...validReviewerResult(), metadata: {} }).code, 'REVIEW_RESULT_MALFORMED');
  eq('no fence rejected', extractLastJsonBlock('plain prose').code, 'REVIEW_RESULT_MALFORMED');
  const prompt = buildReviewPrompt({ binding: BIND, target, reviewableFiles: SCOPE, excludedFiles: [], rulesText: 'r', rulesTruncated: false, diffText: 'd' });
  tru('prompt pins 100% coverage', prompt.includes('100% coverage'));
  tru('prompt forbids mutation', prompt.includes('NO mutation authority'));
  tru('prompt forbids subagents', prompt.includes('delegate to subagents'));
  tru('prompt carries OCR provenance', prompt.includes('Alibaba OCR Delegate CLI'));
  tru('prompt: skill not a runtime dependency', prompt.includes('NOT a runtime dependency'));
  tru('prompt: no child-loads-skill claim', !prompt.includes('Load the host skill'));
}

// ---- E. host: full leg with fakes ----
{
  // Deterministic full-leg PASS using a seeded snapshot dir + fake worktree ops.
  const base = fs.mkdtempSync(`${process.env.TEMP || process.env.TMP || '.'}/soc-review-leg-`);
  const snapPath = `${base}-snap`;
  fs.mkdirSync(snapPath, { recursive: true });
  fs.writeFileSync(`${snapPath}/opencode.json`, JSON.stringify(buildReviewOnlyConfig()), 'utf8');
  const spawnCalls = [];
  const exec = makeFakeExec();
  const r = runReviewOnlyLeg({
    ...BIND,
    controlRepo: 'C:/ctrl',
    ocrBin: 'ocr',
    clock: (() => { let t = 1000; return () => (t += 10); })(),
    exec,
    mkdtemp: () => snapPath,
    resolveExecutable: () => ({ ok: true, executable: 'C:/opencode.exe' }),
    timeoutMs: 5000,
    env: { PATH: 'p', NINE_ROUTER_API_KEY: 'k', SOC_SESSION_PATH: 'X', SOC_SESSION_TOKEN: 'X', SOC_CONTROL_CWD: 'X', SOC_LANE_ID: 'X' },
    spawnReview: (exe, argv, opts) => {
      spawnCalls.push({ exe, argv: [...argv], opts: { ...opts, env: { ...opts.env } } });
      return { status: 0, stdout: ndjsonStdout(fencedResult()), stderr: '' };
    },
  });
  // mkdtemp returns existing snapPath -> mkdtempSync fake must not throw; our
  // createReviewSnapshot calls mkdtemp() which returns snapPath (exists) then
  // fake worktree add ok, then writes opencode.json (overwrite, fine).
  eq('full leg PASS', r.ok, true);
  tru('full leg digest', r.ok && /^[0-9a-f]{64}$/.test(r.value.digest));
  const sc = spawnCalls[0];
  tru('spawn cwd is snapshot', sc && sc.opts.cwd === snapPath);
  tru('no session token in child env', sc && !('SOC_SESSION_PATH' in sc.opts.env) && !('SOC_SESSION_TOKEN' in sc.opts.env) && !('SOC_CONTROL_CWD' in sc.opts.env) && !('SOC_LANE_ID' in sc.opts.env));
  tru('provider key passes through', sc && sc.opts.env.NINE_ROUTER_API_KEY === 'k');
  tru('argv agent plan', sc && sc.argv.includes('plan'));
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(snapPath, { recursive: true, force: true }); } catch { /* ignore */ }
}
{
  // Timeout fail-closed with no fabricated findings.
  const snapPath = fs.mkdtempSync(`${process.env.TEMP || process.env.TMP || '.'}/soc-review-to-`);
  fs.writeFileSync(`${snapPath}/opencode.json`, JSON.stringify(buildReviewOnlyConfig()), 'utf8');
  const r = runReviewOnlyLeg({
    ...BIND, controlRepo: 'C:/ctrl', clock: () => 0,
    exec: makeFakeExec(), mkdtemp: () => snapPath,
    resolveExecutable: () => ({ ok: true, executable: 'C:/opencode.exe' }),
    spawnReview: () => ({ status: null, error: { code: 'ETIMEDOUT' }, stdout: '', stderr: '' }),
  });
  eq('timeout fail-closed', r.code, 'REVIEW_TIMEOUT');
  tru('no fabricated evidence on timeout', !r.value);
  try { fs.rmSync(snapPath, { recursive: true, force: true }); } catch { /* ignore */ }
}
{
  // F3: stdout overflow is explicit, not a timeout; real timeout unchanged.
  const mkSeeded = () => {
    const p = fs.mkdtempSync(`${process.env.TEMP || process.env.TMP || '.'}/soc-review-o-`);
    fs.writeFileSync(`${p}/opencode.json`, JSON.stringify(buildReviewOnlyConfig()), 'utf8');
    return p;
  };
  const s1 = mkSeeded();
  const ro = runReviewOnlyLeg({
    ...BIND, controlRepo: 'C:/ctrl', clock: () => 0, exec: makeFakeExec(), mkdtemp: () => s1,
    resolveExecutable: () => ({ ok: true, executable: 'C:/opencode.exe' }),
    spawnReview: () => ({ status: null, error: { code: 'ENOBUFS' }, stdout: '', stderr: '' }),
  });
  eq('ENOBUFS explicit code', ro.code, 'REVIEW_OUTPUT_OVERFLOW');
  tru('ENOBUFS no evidence', !ro.value);
  const s2 = mkSeeded();
  const rt = runReviewOnlyLeg({
    ...BIND, controlRepo: 'C:/ctrl', clock: () => 0, exec: makeFakeExec(), mkdtemp: () => s2,
    resolveExecutable: () => ({ ok: true, executable: 'C:/opencode.exe' }),
    spawnReview: () => ({ status: null, error: { code: 'ETIMEDOUT' }, stdout: '', stderr: '' }),
  });
  eq('real timeout still REVIEW_TIMEOUT', rt.code, 'REVIEW_TIMEOUT');
  for (const p of [s1, s2]) try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}
{
  // Non-zero exit + non-JSON fail-closed.
  const mkSeeded = () => {
    const p = fs.mkdtempSync(`${process.env.TEMP || process.env.TMP || '.'}/soc-review-e-`);
    fs.writeFileSync(`${p}/opencode.json`, JSON.stringify(buildReviewOnlyConfig()), 'utf8');
    return p;
  };
  const s1 = mkSeeded();
  eq('nonzero exit fail', runReviewOnlyLeg({
    ...BIND, controlRepo: 'C:/ctrl', clock: () => 0, exec: makeFakeExec(), mkdtemp: () => s1,
    resolveExecutable: () => ({ ok: true, executable: 'C:/opencode.exe' }),
    spawnReview: () => ({ status: 1, stdout: '', stderr: 'boom' }),
  }).code, 'REVIEW_EXIT_NONZERO');
  const s2 = mkSeeded();
  const nz = runReviewOnlyLeg({
    ...BIND, controlRepo: 'C:/ctrl', clock: () => 0, exec: makeFakeExec(), mkdtemp: () => s2,
    resolveExecutable: () => ({ ok: true, executable: 'C:/opencode.exe' }),
    spawnReview: () => ({ status: 0, stdout: ndjsonStdout('just prose no fence'), stderr: '' }),
  });
  eq('non-JSON fail', nz.code, 'REVIEW_RESULT_MALFORMED');
  tru('no fabricated evidence on malformed', !nz.value);
  for (const p of [s1, s2]) try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ---- G. batching (4B): no truncation, exact coverage, fail-closed ----
{
  const kb = (n) => n * 1024;
  eq('planner single batch', planReviewBatches([{ path: 'a', bytes: 100 }, { path: 'b', bytes: 200 }]).batches.length, 1);
  const many = Array.from({ length: 5 }, (_, i) => ({ path: `f${i}`, bytes: kb(20) }));
  eq('planner file-boundary batches', planReviewBatches(many).batches.length, 3);
  const bigText = `${'x'.repeat(kb(40))}\n${'y'.repeat(kb(40))}\n${'z'.repeat(kb(20))}`;
  const big = planReviewBatches([{ path: 'big.mjs', bytes: Buffer.byteLength(bigText, 'utf8'), text: bigText }]);
  tru('oversized file chunked', big.ok && big.batches.every((b) => b.chunked) && big.batches.every((b) => typeof b.chunkText === 'string'));
  tru('chunk texts rejoin lossless', big.batches.map((b) => b.chunkText).join('\n') === bigText);
  tru('chunks bounded', big.batches.every((b) => Buffer.byteLength(b.chunkText, 'utf8') <= 48 * 1024));
  eq('oversized without text fails closed', planReviewBatches([{ path: 'big.mjs', bytes: kb(100) }]).code, 'REVIEW_BATCH_FAILED');
  // Adversarial line packing (F2): lines just over half the bound pack one
  // per chunk while naive ceil predicts ~two per chunk. Plan and execution
  // share the single splitter, so they agree exactly and complete.
  const advLine = 'q'.repeat(24 * 1024 + 1);
  const advText = [advLine, advLine, advLine, advLine].join('\n');
  const advBytes = Buffer.byteLength(advText, 'utf8');
  const naiveCeil = Math.ceil(advBytes / (48 * 1024));
  const adv = planReviewBatches([{ path: 'adv.mjs', bytes: advBytes, text: advText }]);
  tru('adversarial plan ok', adv.ok);
  tru('adversarial actual chunks exceed naive ceil', adv.batches.length > naiveCeil);
  tru('adversarial rejoin lossless', adv.batches.map((b) => b.chunkText).join('\n') === advText);
  tru('adversarial chunks bounded', adv.batches.every((b) => Buffer.byteLength(b.chunkText, 'utf8') <= 48 * 1024));
  tru('adversarial provenance actual N', adv.batches.every((b) => b.files[0].chunks === adv.batches.length));
  const over = planReviewBatches(Array.from({ length: 40 }, (_, i) => ({ path: `g${i}`, bytes: kb(30) })));
  eq('batch limit explicit', over.code, 'REVIEW_BATCH_LIMIT_EXCEEDED');
  const chunks = chunkDiffText('l1\nl2\nl3\nl4', 5);
  tru('chunks rejoin lossless', chunks.join('\n') === 'l1\nl2\nl3\nl4');
  tru('chunks bounded', chunks.every((c) => Buffer.byteLength(c, 'utf8') <= 8));
  const bp = buildBatchPrompt({ binding: BIND, target: { mode: 'range', from: BIND.baseSha, to: BIND.headSha }, batchFiles: ['src/a.mjs'], batchLabel: '1/2', diffRel: '.soc-review/diff-batch-1.diff', rulesRel: '.soc-review/rules.md', excludedFiles: [], remainingCount: 1 });
  tru('batch prompt references diff file', bp.includes('.soc-review/diff-batch-1.diff'));
  tru('batch prompt no inline diff requirement', !bp.includes('Range diff (base..head, read-only context; always read each full file before judging):'));
  const rp = buildReflectionPrompt({ binding: BIND, target: { mode: 'range', from: BIND.baseSha, to: BIND.headSha }, reviewableFiles: SCOPE, excludedFiles: [], rulesRel: '.soc-review/rules.md', candidatesRel: '.soc-review/candidates.json', batchCount: 2 });
  tru('reflection prompt references candidates', rp.includes('.soc-review/candidates.json'));
}
{
  // Multi-batch leg: 3 files x 20KiB diffs -> 2 batches + reflection.
  const kb = (n) => n * 1024;
  const files = ['src/a.mjs', 'src/b.mjs', 'src/c.mjs'];
  const fdiff = {};
  for (const f of files) fdiff[f] = `diff ${f}\n` + 'x'.repeat(kb(20));
  const pv = JSON.parse(previewJson());
  pv.reviewable_files = files.map((p) => ({ path: p, status: 'modified', insertions: 1, deletions: 0 }));
  pv.reviewable_count = 3;
  const exec = makeFakeExec({ preview: JSON.stringify(pv), fileDiffs: fdiff });
  const seen = [];
  const spawnReview = (exe, argv, opts) => {
    seen.push(argv[argv.length - 1]);
    const n = seen.length;
    const mk = (reviewed, findings) => ({ status: 0, stdout: ndjsonStdout(fencedResult({ reviewedFiles: reviewed, findings, reflectionCompleted: true })), stderr: '' });
    if (n === 1) return mk(['src/a.mjs', 'src/b.mjs'], [{ path: 'src/a.mjs', content: 'f1', category: 'bug', severity: 'low' }]);
    if (n === 2) return mk(['src/c.mjs'], [{ path: 'src/c.mjs', content: 'f2', category: 'style', severity: 'low' }]);
    return mk(files, [
      { path: 'src/a.mjs', content: 'f1', category: 'bug', severity: 'low' },
      { path: 'src/c.mjs', content: 'f2', category: 'style', severity: 'low' },
    ]);
  };
  const r = runReviewOnlyLeg({
    ...BIND, controlRepo: 'C:/ctrl', clock: (() => { let t = 0; return () => (t += 5); })(),
    exec, spawnReview, resolveExecutable: () => ({ ok: true, executable: 'C:/opencode.exe' }),
  });
  eq('batched leg PASS', r.ok, true);
  eq('batched spawn count (2 batches + reflection)', seen.length, 3);
  tru('batched digest', r.ok && /^[0-9a-f]{64}$/.test(r.value.digest));
  eq('batched findings aggregate', r.ok && r.value.findingsCount, 2);
  tru('batched meta', r.ok && r.batch && r.batch.batched === true && r.batch.batches === 2);
  // Determinism: rerun with fresh fakes -> same digest.
  const exec2 = makeFakeExec({ preview: JSON.stringify(pv), fileDiffs: fdiff });
  const seen2 = [];
  const r2 = runReviewOnlyLeg({
    ...BIND, controlRepo: 'C:/ctrl', clock: (() => { let t = 0; return () => (t += 5); })(),
    exec: exec2,
    spawnReview: (exe, argv, opts) => {
      seen2.push(1);
      const n = seen2.length;
      const mk = (reviewed, findings) => ({ status: 0, stdout: ndjsonStdout(fencedResult({ reviewedFiles: reviewed, findings, reflectionCompleted: true })), stderr: '' });
      if (n === 1) return mk(['src/a.mjs', 'src/b.mjs'], [{ path: 'src/a.mjs', content: 'f1', category: 'bug', severity: 'low' }]);
      if (n === 2) return mk(['src/c.mjs'], [{ path: 'src/c.mjs', content: 'f2', category: 'style', severity: 'low' }]);
      return mk(files, [
        { path: 'src/a.mjs', content: 'f1', category: 'bug', severity: 'low' },
        { path: 'src/c.mjs', content: 'f2', category: 'style', severity: 'low' },
      ]);
    },
    resolveExecutable: () => ({ ok: true, executable: 'C:/opencode.exe' }),
  });
  eq('batched digest deterministic', r2.ok && r2.value.digest, r.value.digest);
}
{
  // One batch failure fails the whole leg with no evidence.
  const kb = (n) => n * 1024;
  const files = ['src/a.mjs', 'src/b.mjs'];
  const fdiff = { 'src/a.mjs': 'd\n' + 'x'.repeat(kb(30)), 'src/b.mjs': 'd\n' + 'y'.repeat(kb(30)) };
  const pv = JSON.parse(previewJson());
  pv.reviewable_files = files.map((p) => ({ path: p, status: 'modified', insertions: 1, deletions: 0 }));
  pv.reviewable_count = 2;
  // 30+30=60KiB > 48KiB -> 2 batches; fail the second.
  let n = 0;
  const r = runReviewOnlyLeg({
    ...BIND, controlRepo: 'C:/ctrl', clock: () => 0,
    exec: makeFakeExec({ preview: JSON.stringify(pv), fileDiffs: fdiff }),
    spawnReview: () => {
      n += 1;
      if (n === 2) return { status: 1, stdout: '', stderr: 'boom' };
      return { status: 0, stdout: ndjsonStdout(fencedResult({ reviewedFiles: ['src/a.mjs'], findings: [], reflectionCompleted: true })), stderr: '' };
    },
    resolveExecutable: () => ({ ok: true, executable: 'C:/opencode.exe' }),
  });
  eq('batch failure fails leg', r.code, 'REVIEW_BATCH_FAILED');
  tru('no partial evidence', !r.value);
}
{
  // Hard safety bound: explicit failure, never truncation.
  const huge = 'z'.repeat(600 * 1024);
  const r = runReviewOnlyLeg({
    ...BIND, controlRepo: 'C:/ctrl', clock: () => 0,
    exec: makeFakeExec({ fileDiffs: { 'src/a.mjs': huge, 'src/b.mjs': 'small' } }),
    spawnReview: () => ({ status: 0, stdout: '', stderr: '' }),
    resolveExecutable: () => ({ ok: true, executable: 'C:/opencode.exe' }),
  });
  eq('hard bound explicit', r.code, 'REVIEW_DIFF_TOO_LARGE');
}
{
  // Batch aggregate bound (F1): 300+201=501 -> REVIEW_BATCH_FAILED, no evidence.
  const kb = (n) => n * 1024;
  const files = ['src/a.mjs', 'src/b.mjs'];
  const fdiff = { 'src/a.mjs': 'd\n' + 'x'.repeat(kb(30)), 'src/b.mjs': 'd\n' + 'y'.repeat(kb(30)) };
  const pv = JSON.parse(previewJson());
  pv.reviewable_files = files.map((p) => ({ path: p, status: 'modified', insertions: 1, deletions: 0 }));
  pv.reviewable_count = 2;
  const mkF = (n, p) => Array.from({ length: n }, (_, i) => ({ path: p, content: `g-${i}`, category: 'bug', severity: 'low' }));
  let n = 0;
  const r = runReviewOnlyLeg({
    ...BIND, controlRepo: 'C:/ctrl', clock: () => 0,
    exec: makeFakeExec({ preview: JSON.stringify(pv), fileDiffs: fdiff }),
    spawnReview: () => {
      n += 1;
      if (n === 1) return { status: 0, stdout: ndjsonStdout(fencedResult({ reviewedFiles: ['src/a.mjs'], findings: mkF(300, 'src/a.mjs'), reflectionCompleted: true })), stderr: '' };
      return { status: 0, stdout: ndjsonStdout(fencedResult({ reviewedFiles: ['src/b.mjs'], findings: mkF(201, 'src/b.mjs'), reflectionCompleted: true })), stderr: '' };
    },
    resolveExecutable: () => ({ ok: true, executable: 'C:/opencode.exe' }),
  });
  eq('batch aggregate 501 fails leg', r.code, 'REVIEW_BATCH_FAILED');
  tru('batch aggregate no partial evidence', !r.value);
}

// ---- H. telemetry best-effort, non-authoritative ----
{
  const mkSeeded = () => {
    const p = fs.mkdtempSync(`${process.env.TEMP || process.env.TMP || '.'}/soc-review-t-`);
    fs.writeFileSync(`${p}/opencode.json`, JSON.stringify(buildReviewOnlyConfig()), 'utf8');
    return p;
  };
  const s1 = mkSeeded();
  const r1 = runReviewOnlyLeg({
    ...BIND, controlRepo: 'C:/ctrl', clock: () => 0, exec: makeFakeExec(), mkdtemp: () => s1,
    resolveExecutable: () => ({ ok: true, executable: 'C:/opencode.exe' }),
    spawnReview: () => ({ status: 0, stdout: ndjsonStdout(fencedResult()), stderr: '' }),
    telemetry: { record: () => { throw new Error('sink down'); } },
  });
  eq('throwing telemetry still ok', r1.ok, true);
  const s2 = mkSeeded();
  const events = [];
  const r2 = runReviewOnlyLeg({
    ...BIND, controlRepo: 'C:/ctrl', clock: () => 0, exec: makeFakeExec(), mkdtemp: () => s2,
    resolveExecutable: () => ({ ok: true, executable: 'C:/opencode.exe' }),
    spawnReview: () => ({ status: 0, stdout: ndjsonStdout(fencedResult()), stderr: '' }),
    telemetry: { record: (e, d) => events.push([e, d]) },
  });
  eq('telemetry ok', r2.ok, true);
  tru('REVIEW_LEG_FINISHED recorded', events.some(([e, d]) => e === 'REVIEW_LEG_FINISHED' && d.ok === true && typeof d.digest === 'string'));
  for (const p of [s1, s2]) try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ---- F. authority/source hardening ----
{
  const rawSrc = fs.readFileSync(new URL('../packages/review-leg/review-only.mjs', import.meta.url), 'utf8');
  const code = rawSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const imports = code.split('\n').filter((l) => l.trim().startsWith('import '));
  tru('imports bounded (<=7: fs/os/path/crypto + 2 leaves)', imports.length <= 7);
  tru('imports validator', code.includes('review-delegate-evidence.mjs'));
  for (const banned of ['taskFinish', 'taskBlock', 'delivery.mjs', 'terminalize', 'leaseToken', 'sessionPath', 'SESSION_AUTHORITY', 'fetch(', 'https.get', 'http.get', 'API_KEY', '--auto', 'shell: true', "shell:true", 'ocr review', 'ocr llm', '--provider'] ) {
    checks.push({ name: `no ${banned} in module`, ok: !code.includes(banned), got: code.includes(banned) });
  }
  tru('no verdict key emission', !code.includes('verdict:'));
  tru('no child-loads-skill claim in module', !rawSrc.includes('Load the host skill'));
}

// ---- summary ----
const failed = checks.filter((c) => !c.ok);
for (const c of checks) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : ` | got=${JSON.stringify(c.got)} want=${JSON.stringify(c.want)}`}`);
}
console.log(`review-only: ${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
