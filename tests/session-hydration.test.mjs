#!/usr/bin/env node
// session-hydration.test.mjs — Session Auto-Hydration từ GitHub cho Control
// Loop (FAIL-CLOSED). Bao phủ:
//   A. hydrateSessionFromGitHub — unit thuần với gh/spawnImpl mock:
//      marker chuẩn -> ghi seed session 8 field chuẩn + read-back verify PASS;
//      thiếu marker / marker sai identityHash -> HYDRATION_IDENTITY_MISMATCH
//      (không ghi file); gh timeout/lỗi mạng -> mã typed, spawnSync luôn bị
//      kẹp timeout 10000 + windowsHide + killSignal SIGTERM (LOOP-01 Finding
//      #3); metadata PR sai -> HYDRATION_INVALID_PR_METADATA; slot đã có
//      session -> HYDRATION_SESSION_EXISTS và KHÔNG hề gọi gh.
//      PR đóng NHIỀU issue (multi-link): cross-check là membership, marker
//      quyết định issue chủ đề (A17–A19).
//   B. hydrateMissingSession (CLI policy trong bin/soc-control-loop.mjs):
//      session còn đó / chưa yêu cầu hydrate -> không gọi gh; --pr rõ ràng ->
//      strict fail-closed; issue-only -> fallback có kiểm soát khi KHÔNG có
//      bằng chứng PR, nhưng identity mismatch vẫn strict.
//   C. Seed -> canonical upgrade qua ensureCanonicalSession: taskStart tái
//      lập session canonical, merge prNumber + headSha từ seed, thất bại thì
//      RESTORE seed byte-identical (không mất bằng chứng); record cũ thiếu
//      trường vẫn SESSION_MINIMAL như cũ (không hồi quy hành vi legacy).
//   D. CLI flags & guards: parseArgs --pr, ARGS_INVALID trước admission,
//      gh seam ném exception -> HYDRATION_INTERNAL_FAILED strict.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  identityHash, worktreeBranchFor, worktreePathFor, bindingPathFor,
} from '../packages/workspace/workspace.mjs';
import { sessionPathFor, readSessionRecord } from '../packages/runtime-sandbox/runtime-sandbox.mjs';
import {
  hydrateSessionFromGitHub,
  resolveIssueNumberFromPullRequest,
  identityMarkerFor,
  extractIssueNumberFromBody,
  extractIssueNumbersFromBody,
  isHydrationSeedRecord,
} from '../packages/control-loop/session-hydration.mjs';
import {
  hydrateMissingSession, parseArgs, runSocControlLoop, resolveRunnerInstruction,
} from '../bin/soc-control-loop.mjs';
import { ensureCanonicalSession } from '../packages/control-loop/session-provisioning.mjs';

const REPO = 'duongpdddic-droid/Soc_brain';
const ISSUE = 77;
const ID = identityHash({ repo: REPO, issueNumber: ISSUE });
const HEAD = '1'.repeat(40);
const BASE = '2'.repeat(40);
const PR_NUMBER = 80;

function mkStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'soc-hydrate-'));
}

function marker(id = ID) {
  return `<!-- soc-brain:identity=${id} -->`;
}

function prBody({ issue = ISSUE, id = ID, closes = true } = {}) {
  const parts = ['Fix the thing'];
  if (closes) parts.push(`Closes #${issue}`);
  if (id) parts.push(marker(id));
  return `${parts.join('\n\n')}\n`;
}

function viewJson(overrides = {}) {
  return JSON.stringify({
    number: PR_NUMBER,
    state: 'OPEN',
    body: prBody(),
    headRefOid: HEAD,
    baseRefOid: BASE,
    headRefName: `agent/${ID}`,
    ...overrides,
  });
}

function spawnOk(stdout, { code = 0, stderr = '' } = {}) {
  return (cmd, args, opts) => ({ status: code, stdout, stderr, error: null, __opts: opts, __cmd: cmd, __args: args });
}

// ============================================================================
// A. hydrateSessionFromGitHub — unit fail-closed
// ============================================================================

test('A1: marker chuẩn -> ghi seed session đúng schema (8 field + goal), read-back verify PASS, spawnSync bị kẹp an toàn', () => {
  const stateDir = mkStateDir();
  const calls = [];
  const spawnImpl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { status: 0, stdout: viewJson(), stderr: '', error: null };
  };

  const r = hydrateSessionFromGitHub({ repo: REPO, prNumber: PR_NUMBER, stateDir, spawnImpl });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.prNumber, PR_NUMBER);
  assert.equal(r.value.issueNumber, ISSUE);
  assert.equal(r.value.identityHash, ID);
  assert.equal(r.value.headSha, HEAD);
  assert.equal(r.value.baseSha, BASE);
  assert.equal(r.value.branch, `agent/${ID}`);

  const sp = sessionPathFor({ stateDir, identityHash: ID });
  assert.equal(r.value.sessionPath, sp);
  assert.ok(fs.existsSync(sp), 'seed session file must exist after hydrate');
  const raw = JSON.parse(fs.readFileSync(sp, 'utf8'));
  assert.deepEqual(
    Object.keys(raw),
    ['schemaVersion', 'identityHash', 'repo', 'issueNumber', 'prNumber', 'headSha', 'baseSha', 'branch', 'goal'],
    'seed schema = canonical 8 fields + goal (null khi PR không có title/body)',
  );
  assert.equal(raw.goal, 'Fix the thing', 'PR không title -> goal lấy từ dòng tóm tắt đầu của body (không tự bịa)');
  assert.equal(raw.schemaVersion, '1', 'schemaVersion chuẩn của hệ thống');
  assert.equal(raw.identityHash, ID);
  assert.equal(raw.repo, REPO);
  assert.equal(raw.issueNumber, ISSUE);
  assert.equal(raw.prNumber, PR_NUMBER);
  assert.equal(raw.headSha, HEAD, 'headSha lấy từ headRefOid');
  assert.equal(raw.baseSha, BASE, 'baseSha lấy từ baseRefOid');
  assert.equal(raw.branch, `agent/${ID}`, 'branch lấy từ headRefName');

  // read-back verify qua chính runtime-sandbox reader (schema + canonical path)
  const rs = readSessionRecord(sp);
  assert.equal(rs.ok, true, JSON.stringify(rs));
  assert.equal(rs.session.identityHash, ID);

  // gh call: đúng subcommand + spawn safety (LOOP-01 Finding #3)
  assert.equal(calls.length, 1, 'exactly one gh view call');
  const c = calls[0];
  assert.equal(c.cmd, 'gh');
  assert.deepEqual(c.args.slice(0, 4), ['pr', 'view', String(PR_NUMBER), '--repo']);
  assert.ok(c.args.includes('--json'), 'gh pr view --json ...');
  assert.ok(
    String(c.args[c.args.indexOf('--json') + 1] || '').split(',').includes('title'),
    'PR_JSON_FIELDS must request title (goal extraction source)',
  );
  assert.equal(c.opts.timeout, 10000, 'gh spawnSync must be bounded at 10s');
  assert.equal(c.opts.windowsHide, true, 'windowsHide required');
  assert.equal(c.opts.killSignal, 'SIGTERM', 'killSignal required');
});

test('A2: PR thiếu identity marker -> HYDRATION_IDENTITY_MISMATCH, không ghi file', () => {
  const stateDir = mkStateDir();
  const sp = sessionPathFor({ stateDir, identityHash: ID });
  const gh = () => ({ code: 0, stdout: viewJson({ body: prBody({ id: null }) }), stderr: '' });

  const r = hydrateSessionFromGitHub({ repo: REPO, prNumber: PR_NUMBER, stateDir, gh });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, 'HYDRATION_IDENTITY_MISMATCH');
  assert.ok(!fs.existsSync(sp), 'no session file may be written without the marker');
});

test('A3: marker mang identityHash KHÁC expectedId -> HYDRATION_IDENTITY_MISMATCH, không ghi file', () => {
  const stateDir = mkStateDir();
  const sp = sessionPathFor({ stateDir, identityHash: ID });
  const foreign = identityHash({ repo: REPO, issueNumber: 999 });
  assert.notEqual(foreign, ID);
  const gh = () => ({ code: 0, stdout: viewJson({ body: prBody({ id: foreign }) }), stderr: '' });

  const r = hydrateSessionFromGitHub({ repo: REPO, prNumber: PR_NUMBER, issueNumber: ISSUE, stateDir, gh });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, 'HYDRATION_IDENTITY_MISMATCH');
  assert.ok(!fs.existsSync(sp), 'foreign identity must never be hydrated');
});

test('A4: gh timeout (spawnSync ETIMEDOUT) -> mã typed, không throw, không ghi file, spawn options chuẩn', () => {
  const stateDir = mkStateDir();
  const sp = sessionPathFor({ stateDir, identityHash: ID });
  const calls = [];
  const spawnImpl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { status: null, stdout: '', stderr: '', error: { code: 'ETIMEDOUT', message: 'spawnSync ETIMEDOUT' } };
  };

  const r = hydrateSessionFromGitHub({ repo: REPO, prNumber: PR_NUMBER, stateDir, spawnImpl });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, 'HYDRATION_GH_TIMEOUT');
  assert.ok(!fs.existsSync(sp));
  assert.equal(calls[0].opts.timeout, 10000);
  assert.equal(calls[0].opts.windowsHide, true);
  assert.equal(calls[0].opts.killSignal, 'SIGTERM');
});

test('A4b: gh spawn lỗi không phải timeout -> HYDRATION_GH_FAILED typed', () => {
  const stateDir = mkStateDir();
  const spawnImpl = () => ({ status: null, stdout: '', stderr: '', error: { code: 'ENOENT', message: 'spawnSync ENOENT' } });
  const r = hydrateSessionFromGitHub({ repo: REPO, prNumber: PR_NUMBER, stateDir, spawnImpl });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, 'HYDRATION_GH_FAILED');
});

test('A5: gh pr view exit khác 0 -> HYDRATION_PR_VIEW_FAILED, không ghi file', () => {
  const stateDir = mkStateDir();
  const gh = () => ({ code: 1, stdout: '', stderr: 'gh: could not resolve to a PullRequest' });
  const r = hydrateSessionFromGitHub({ repo: REPO, prNumber: PR_NUMBER, stateDir, gh });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, 'HYDRATION_PR_VIEW_FAILED');
  assert.ok(!fs.existsSync(sessionPathFor({ stateDir, identityHash: ID })));
});

test('A6: headRefOid không phải SHA-40 -> HYDRATION_INVALID_PR_METADATA', () => {
  const stateDir = mkStateDir();
  const gh = () => ({ code: 0, stdout: viewJson({ headRefOid: 'not-a-sha' }), stderr: '' });
  const r = hydrateSessionFromGitHub({ repo: REPO, prNumber: PR_NUMBER, stateDir, gh });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, 'HYDRATION_INVALID_PR_METADATA');
  assert.ok(!fs.existsSync(sessionPathFor({ stateDir, identityHash: ID })));
});

test('A7: slot đã có session -> HYDRATION_SESSION_EXISTS và KHÔNG gọi gh (không bao giờ đè session)', () => {
  const stateDir = mkStateDir();
  const sp = sessionPathFor({ stateDir, identityHash: ID });
  fs.mkdirSync(path.dirname(sp), { recursive: true });
  fs.writeFileSync(sp, '{"schemaVersion":"1","note":"existing"}\n', 'utf8');
  let ghCalls = 0;
  const gh = () => { ghCalls += 1; return { code: 0, stdout: viewJson(), stderr: '' }; };

  const r = hydrateSessionFromGitHub({ repo: REPO, prNumber: PR_NUMBER, issueNumber: ISSUE, stateDir, gh });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, 'HYDRATION_SESSION_EXISTS');
  assert.equal(ghCalls, 0, 'existing slot is refused before any network call');
  assert.equal(fs.readFileSync(sp, 'utf8'), '{"schemaVersion":"1","note":"existing"}\n');
});

test('A8: PR body không trích xuất được issue và caller không --issue -> HYDRATION_ISSUE_UNRESOLVED', () => {
  const stateDir = mkStateDir();
  const gh = () => ({ code: 0, stdout: viewJson({ body: `Some text\n\n${marker()}\n` }), stderr: '' });
  const r = hydrateSessionFromGitHub({ repo: REPO, prNumber: PR_NUMBER, stateDir, gh });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, 'HYDRATION_ISSUE_UNRESOLVED');
  assert.ok(!fs.existsSync(sessionPathFor({ stateDir, identityHash: ID })));
});

test('A9: body closes issue KHÁC --issue của caller -> HYDRATION_ISSUE_MISMATCH', () => {
  const stateDir = mkStateDir();
  const otherIssue = 99;
  const otherId = identityHash({ repo: REPO, issueNumber: otherIssue });
  const gh = () => ({ code: 0, stdout: viewJson({ body: prBody({ issue: otherIssue, id: otherId }) }), stderr: '' });
  const r = hydrateSessionFromGitHub({ repo: REPO, prNumber: PR_NUMBER, issueNumber: ISSUE, stateDir, gh });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, 'HYDRATION_ISSUE_MISMATCH');
  assert.ok(!fs.existsSync(sessionPathFor({ stateDir, identityHash: ID })));
});

test('A10: issue-only -> gh pr list, chọn PR mang marker đúng identity, hydrate thành công', () => {
  const stateDir = mkStateDir();
  const calls = [];
  const gh = (args) => {
    calls.push(args.join(' '));
    return {
      code: 0,
      stdout: JSON.stringify([
        { number: 81, state: 'OPEN', body: 'Unrelated PR', headRefOid: 'a'.repeat(40), baseRefOid: 'b'.repeat(40), headRefName: 'other/branch' },
        { number: PR_NUMBER, state: 'OPEN', body: prBody(), headRefOid: HEAD, baseRefOid: BASE, headRefName: `agent/${ID}` },
      ]),
      stderr: '',
    };
  };

  const r = hydrateSessionFromGitHub({ repo: REPO, issueNumber: ISSUE, stateDir, gh });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.prNumber, PR_NUMBER);
  assert.match(calls[0], /^pr list /, 'issue-only resolves the PR via gh pr list');
  const raw = JSON.parse(fs.readFileSync(sessionPathFor({ stateDir, identityHash: ID }), 'utf8'));
  assert.equal(raw.identityHash, ID);
  assert.equal(raw.prNumber, PR_NUMBER);
});

test('A11: issue-only -> PR closes issue nhưng mang identity marker KHÁC -> HYDRATION_IDENTITY_MISMATCH (fail-closed)', () => {
  const stateDir = mkStateDir();
  const foreign = identityHash({ repo: REPO, issueNumber: 999 });
  const gh = (args) => {
    if (String(args[0]) === 'pr' && String(args[1]) === 'list') {
      return {
        code: 0,
        stdout: JSON.stringify([{ number: PR_NUMBER, state: 'OPEN', body: `Closes #${ISSUE}\n\n${marker(foreign)}\n`, headRefOid: HEAD, baseRefOid: BASE, headRefName: 'agent/other' }]),
        stderr: '',
      };
    }
    throw new Error(`unexpected gh: ${args.join(' ')}`);
  };
  const r = hydrateSessionFromGitHub({ repo: REPO, issueNumber: ISSUE, stateDir, gh });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, 'HYDRATION_IDENTITY_MISMATCH', 'một claim identity KHÁC trên issue của mình là xung đột thật -> strict');
  assert.ok(!fs.existsSync(sessionPathFor({ stateDir, identityHash: ID })));
});

test('A11b: issue-only -> PR closes issue nhưng KHÔNG marker nào (PR đời trước) -> không phải evidence -> HYDRATION_PR_NOT_FOUND, không ghi file', () => {
  // PR #245 (merge đời trước, "Closes #9001" không marker) là mẫu ngoại켠
  // thật: linkage lỏng không được coi là bằng chứng hydrate, cũng không phải
  // xung đột identity -> giữ nguyên hợp đồng SESSION_NOT_FOUND cũ.
  const stateDir = mkStateDir();
  const gh = (args) => {
    if (String(args[0]) === 'pr' && String(args[1]) === 'list') {
      return {
        code: 0,
        stdout: JSON.stringify([{ number: PR_NUMBER, state: 'OPEN', body: `Closes #${ISSUE}\n`, headRefOid: HEAD, baseRefOid: BASE, headRefName: 'agent/other' }]),
        stderr: '',
      };
    }
    throw new Error(`unexpected gh: ${args.join(' ')}`);
  };
  const r = hydrateSessionFromGitHub({ repo: REPO, issueNumber: ISSUE, stateDir, gh });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, 'HYDRATION_PR_NOT_FOUND');
  assert.ok(!fs.existsSync(sessionPathFor({ stateDir, identityHash: ID })));
});

test('A12: issue-only -> không PR nào liên kết -> HYDRATION_PR_NOT_FOUND', () => {
  const stateDir = mkStateDir();
  const gh = () => ({ code: 0, stdout: JSON.stringify([]), stderr: '' });
  const r = hydrateSessionFromGitHub({ repo: REPO, issueNumber: ISSUE, stateDir, gh });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, 'HYDRATION_PR_NOT_FOUND');
  assert.ok(!fs.existsSync(sessionPathFor({ stateDir, identityHash: ID })));
});

test('A13: gh pr list exit khác 0 -> HYDRATION_PR_LIST_FAILED typed (lỗi mạng/mạng lưới không treo)', () => {
  const stateDir = mkStateDir();
  const gh = () => ({ code: 1, stdout: '', stderr: 'network timeout' });
  const r = hydrateSessionFromGitHub({ repo: REPO, issueNumber: ISSUE, stateDir, gh });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, 'HYDRATION_PR_LIST_FAILED');
});

test('A14: resolveIssueNumberFromPullRequest (read-only, --pr mà không --issue)', () => {
  const gh = () => ({ code: 0, stdout: viewJson(), stderr: '' });
  const r = resolveIssueNumberFromPullRequest({ repo: REPO, prNumber: PR_NUMBER, gh });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.issueNumber, ISSUE);
  assert.equal(r.value.prNumber, PR_NUMBER);

  const ghNone = () => ({ code: 0, stdout: viewJson({ body: `No linkage\n\n${marker()}\n` }), stderr: '' });
  const r2 = resolveIssueNumberFromPullRequest({ repo: REPO, prNumber: PR_NUMBER, gh: ghNone });
  assert.equal(r2.ok, false, JSON.stringify(r2));
  assert.equal(r2.code, 'HYDRATION_ISSUE_UNRESOLVED');
});

test('A15: helper thuần — identityMarkerFor + extractIssueNumberFromBody (Closes #N và issue URL)', () => {
  assert.equal(identityMarkerFor(ID), marker());
  assert.equal(extractIssueNumberFromBody({ body: `text\ncloses #123\nmore`, repo: REPO }), 123);
  assert.equal(extractIssueNumberFromBody({ body: `Fixes: #456`, repo: REPO }), 456);
  assert.equal(
    extractIssueNumberFromBody({ body: `See https://github.com/duongpdddic-droid/Soc_brain/issues/789`, repo: REPO }),
    789,
  );
  assert.equal(extractIssueNumberFromBody({ body: 'no linkage here', repo: REPO }), null);
  // #77 không được khớp tiền tố với #770
  assert.equal(extractIssueNumberFromBody({ body: 'Closes #770', repo: REPO }), 770);
  // plural: trả về ĐẦY ĐỦ linkage, closes trước, không trùng
  assert.deepEqual(
    extractIssueNumbersFromBody({ body: `Closes #78\n\nCloses #77\n\n${marker()}`, repo: REPO }),
    [78, ISSUE],
    'PR đa-issue giữ nguyên thứ tự, marker không phải issue đầu tiên',
  );
  assert.deepEqual(extractIssueNumbersFromBody({ body: 'no linkage here', repo: REPO }), []);
});

test('A20: resolveIssueNumberFromPullRequest với PR đa-issue -> chọn issue mang marker (không lấy link đầu tiên)', () => {
  const body = `Closes #${ISSUE + 1}\n\nCloses #${ISSUE}\n\n${marker()}\n`;
  const gh = () => ({ code: 0, stdout: viewJson({ body }), stderr: '' });
  const r = resolveIssueNumberFromPullRequest({ repo: REPO, prNumber: PR_NUMBER, gh });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.issueNumber, ISSUE, 'cùng bộ luật multi-link với buildSeedRecord');

  const ghConflict = () => ({
    code: 0,
    stdout: viewJson({
      body: `Closes #${ISSUE + 1}\n\nCloses #${ISSUE}\n\n${marker()}\n\n${marker(identityHash({ repo: REPO, issueNumber: ISSUE + 1 }))}\n`,
    }),
    stderr: '',
  });
  const r2 = resolveIssueNumberFromPullRequest({ repo: REPO, prNumber: PR_NUMBER, gh: ghConflict });
  assert.equal(r2.ok, false, JSON.stringify(r2));
  assert.equal(r2.code, 'HYDRATION_ISSUE_MISMATCH', 'nhiều marker -> xung đột identity, chặn');
});

test('A16: isHydrationSeedRecord — chỉ nhận đúng seed (8 field hoặc 8 field + goal), record canonical/legacy bị loại', () => {
  const seed = { schemaVersion: '1', identityHash: ID, repo: REPO, issueNumber: ISSUE, prNumber: PR_NUMBER, headSha: HEAD, baseSha: BASE, branch: `agent/${ID}` };
  assert.equal(isHydrationSeedRecord({ session: seed, identityHash: ID }), true);
  assert.equal(isHydrationSeedRecord({ session: { ...seed, goal: 'PR title là goal' }, identityHash: ID }), true, 'seed cũ 8 field vẫn là seed');
  assert.equal(isHydrationSeedRecord({ session: { ...seed, goal: null }, identityHash: ID }), true, 'goal null (PR không title/body) vẫn là seed');
  assert.equal(isHydrationSeedRecord({ session: { ...seed, goal: 42 }, identityHash: ID }), false, 'goal phải là null hoặc string');
  assert.equal(isHydrationSeedRecord({ session: { ...seed, goal: '   ' }, identityHash: ID }), false, 'goal string rỗng không phải goal');
  assert.equal(isHydrationSeedRecord({ session: { ...seed, goalNote: 'x' }, identityHash: ID }), false, 'key lạ không phải seed');
  assert.equal(isHydrationSeedRecord({ session: { ...seed, identityHash: 'f'.repeat(32) }, identityHash: ID }), false, 'identity phải khớp');
  assert.equal(isHydrationSeedRecord({ session: { ...seed, prNumber: 0 }, identityHash: ID }), false, 'prNumber phải là số dương');
  assert.equal(isHydrationSeedRecord({ session: { ...seed, baseSha: 'xyz' }, identityHash: ID }), false, 'baseSha phải SHA-40');
  assert.equal(
    isHydrationSeedRecord({ session: { ...seed, goal: 'g', state: 'SESSION_ACTIVE', lease: { token: 't' } }, identityHash: ID }),
    false,
    'record đã canonical KHÔNG phải seed',
  );
  assert.equal(isHydrationSeedRecord({ session: null, identityHash: ID }), false);
});

test('A17: --pr + --issue, body đóng NHIỀU issue và issue của ta KHÔNG đứng đầu -> vẫn hydrate đúng (cross-check = membership)', () => {
  const stateDir = mkStateDir();
  const body = `Closes #${ISSUE + 1}\n\nCloses #${ISSUE}\n\n${marker()}\n`;
  const gh = () => ({ code: 0, stdout: viewJson({ body }), stderr: '' });
  const r = hydrateSessionFromGitHub({ repo: REPO, prNumber: PR_NUMBER, issueNumber: ISSUE, stateDir, gh });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.issueNumber, ISSUE, 'issue của caller được giữ làm mốc khi body có nhiều linkage');
  assert.equal(r.value.identityHash, ID);
});

test('A18: --pr không --issue, body đóng nhiều issue -> chọn issue mang marker identity (không lấy link đầu tiên)', () => {
  const stateDir = mkStateDir();
  const body = `Closes #${ISSUE + 1}\n\nCloses #${ISSUE}\n\n${marker()}\n`;
  const gh = () => ({ code: 0, stdout: viewJson({ body }), stderr: '' });
  const r = hydrateSessionFromGitHub({ repo: REPO, prNumber: PR_NUMBER, stateDir, gh });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.issueNumber, ISSUE, 'marker quyết định issue nào là chủ đề hydration');
  assert.ok(fs.existsSync(sessionPathFor({ stateDir, identityHash: ID })));
});

test('A19: --pr không --issue, nhiều link nhưng không PR nào mang marker -> fail-closed HYDRATION_IDENTITY_MISMATCH', () => {
  const stateDir = mkStateDir();
  const body = `Closes #${ISSUE + 1}\n\nCloses #${ISSUE}\n`;
  const gh = () => ({ code: 0, stdout: viewJson({ body }), stderr: '' });
  const r = hydrateSessionFromGitHub({ repo: REPO, prNumber: PR_NUMBER, stateDir, gh });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, 'HYDRATION_IDENTITY_MISMATCH');
  assert.ok(!fs.existsSync(sessionPathFor({ stateDir, identityHash: ID })));
});

// ============================================================================
// B. hydrateMissingSession — CLI policy (bin/soc-control-loop.mjs)
// ============================================================================

test('B1: session đã tồn tại -> không gọi gh, không hydrate (no-op)', () => {
  const stateDir = mkStateDir();
  const sp = sessionPathFor({ stateDir, identityHash: ID });
  fs.mkdirSync(path.dirname(sp), { recursive: true });
  fs.writeFileSync(sp, '{"schemaVersion":"1"}', 'utf8');
  const gh = () => { throw new Error('gh must not be called when the slot is occupied'); };
  const r = hydrateMissingSession({ repo: REPO, issueNumber: ISSUE, prNumber: PR_NUMBER, sessionPath: sp, stateDir, hydrate: true, gh });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.hydrated, false);
  assert.equal(r.reason, 'SESSION_PRESENT');
});

test('B2: session thiếu + chưa yêu cầu hydrate -> giữ nguyên hợp đồng cũ (không gọi gh)', () => {
  const stateDir = mkStateDir();
  const sp = sessionPathFor({ stateDir, identityHash: ID });
  const gh = () => { throw new Error('gh must not be called when hydration is not requested'); };
  const r = hydrateMissingSession({ repo: REPO, issueNumber: ISSUE, prNumber: null, sessionPath: sp, stateDir, hydrate: false, gh });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.hydrated, false);
  assert.equal(r.reason, 'HYDRATION_NOT_REQUESTED');
});

test('B3: session thiếu + có --pr -> hydrate thành công qua policy, file seed nằm đúng canonical path', () => {
  const stateDir = mkStateDir();
  const sp = sessionPathFor({ stateDir, identityHash: ID });
  const gh = () => ({ code: 0, stdout: viewJson(), stderr: '' });
  const r = hydrateMissingSession({ repo: REPO, issueNumber: ISSUE, prNumber: PR_NUMBER, sessionPath: sp, stateDir, hydrate: true, gh });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.hydrated, true);
  assert.equal(r.value.sessionPath, sp);
  assert.ok(fs.existsSync(sp));
  assert.equal(isHydrationSeedRecord({ session: JSON.parse(fs.readFileSync(sp, 'utf8')), identityHash: ID }), true);
});

test('B4: issue-only + không tìm thấy PR (không bằng chứng) -> fallback fail-soft, phiên bản SESSION_NOT_FOUND cũ còn nguyên', () => {
  const stateDir = mkStateDir();
  const sp = sessionPathFor({ stateDir, identityHash: ID });
  const notes = [];
  const gh = () => ({ code: 0, stdout: JSON.stringify([]), stderr: '' });
  const r = hydrateMissingSession({
    repo: REPO, issueNumber: ISSUE, prNumber: null, sessionPath: sp, stateDir,
    hydrate: true, gh, log: (m) => notes.push(m),
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.hydrated, false);
  assert.equal(r.reason, 'HYDRATION_PR_NOT_FOUND');
  assert.equal(notes.length, 1, 'fallback phải được ghi nhận');
  assert.match(notes[0], /HYDRATION_PR_NOT_FOUND/);
  assert.ok(!fs.existsSync(sp), 'fallback không được ghi session');
});

test('B5: issue-only + PR mang identity marker KHÁC -> STRICT HYDRATION_IDENTITY_MISMATCH (không bao giờ fallback)', () => {
  const stateDir = mkStateDir();
  const sp = sessionPathFor({ stateDir, identityHash: ID });
  const foreign = identityHash({ repo: REPO, issueNumber: 999 });
  const gh = () => ({
    code: 0,
    stdout: JSON.stringify([{ number: PR_NUMBER, state: 'OPEN', body: `Closes #${ISSUE}\n\n${marker(foreign)}\n`, headRefOid: HEAD, baseRefOid: BASE, headRefName: 'agent/other' }]),
    stderr: '',
  });
  const r = hydrateMissingSession({ repo: REPO, issueNumber: ISSUE, prNumber: null, sessionPath: sp, stateDir, hydrate: true, gh });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, 'HYDRATION_IDENTITY_MISMATCH');
  assert.ok(!fs.existsSync(sp));
});

test('B5b: issue-only + PR closes issue nhưng không marker nào -> fallback fail-soft (PR không phải evidence của identity này)', () => {
  const stateDir = mkStateDir();
  const sp = sessionPathFor({ stateDir, identityHash: ID });
  const notes = [];
  const gh = () => ({
    code: 0,
    stdout: JSON.stringify([{ number: PR_NUMBER, state: 'OPEN', body: `Closes #${ISSUE}\n`, headRefOid: HEAD, baseRefOid: BASE, headRefName: 'agent/other' }]),
    stderr: '',
  });
  const r = hydrateMissingSession({
    repo: REPO, issueNumber: ISSUE, prNumber: null, sessionPath: sp, stateDir,
    hydrate: true, gh, log: (m) => notes.push(m),
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.hydrated, false);
  assert.equal(r.reason, 'HYDRATION_PR_NOT_FOUND');
  assert.equal(notes.length, 1, 'fallback phải được ghi nhận');
  assert.match(notes[0], /HYDRATION_PR_NOT_FOUND/);
  assert.ok(!fs.existsSync(sp), 'fallback không được ghi session');
});

test('B6: có --pr rõ ràng + gh lỗi -> STRICT fail-closed (không bao giờ im lặng fallback)', () => {
  const stateDir = mkStateDir();
  const sp = sessionPathFor({ stateDir, identityHash: ID });
  const gh = () => ({ code: 1, stdout: '', stderr: 'gh: network error' });
  const r = hydrateMissingSession({ repo: REPO, issueNumber: ISSUE, prNumber: PR_NUMBER, sessionPath: sp, stateDir, hydrate: true, gh });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, 'HYDRATION_PR_VIEW_FAILED');
  assert.ok(!fs.existsSync(sp));
});

test('D1: parseArgs trích xuất --pr (hợp lệ -> N; thiếu/sai -> null)', () => {
  assert.equal(parseArgs(['--repo', 'o/n', '--issue', '42', '--pr', '80']).pr, 80);
  assert.equal(parseArgs(['--repo', 'o/n', '--issue', '42']).pr, null, '--pr là opt-in');
  assert.equal(parseArgs(['--pr', 'abc']).pr, null, 'không phải số -> null');
  assert.equal(parseArgs(['--pr', '0']).pr, null, 'phải là số nguyên dương');
  assert.equal(parseArgs(['--pr', '-5']).pr, null);
});

test('D2: runSocControlLoop với prNumber không hợp lệ -> ARGS_INVALID TRƯỚC admission (offline, không side effect)', async () => {
  const stateDir = mkStateDir();
  const r = await runSocControlLoop({ repo: REPO, issueNumber: 1, prNumber: 0, stateDir, deps: {} });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, 'ARGS_INVALID');
  const r2 = await runSocControlLoop({ repo: REPO, issueNumber: 1, prNumber: 'x', stateDir, deps: {} });
  assert.equal(r2.ok, false, JSON.stringify(r2));
  assert.equal(r2.code, 'ARGS_INVALID');
});

test('D3: gh seam ném exception -> HYDRATION_INTERNAL_FAILED STRICT (không fallback, không ghi file)', () => {
  const stateDir = mkStateDir();
  const sp = sessionPathFor({ stateDir, identityHash: ID });
  const gh = () => { throw new Error('boom'); };
  const r = hydrateMissingSession({ repo: REPO, issueNumber: ISSUE, prNumber: null, sessionPath: sp, stateDir, hydrate: true, gh });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, 'HYDRATION_INTERNAL_FAILED', 'lỗi nội bộ KHÔNG bao giờ rơi vào fallback');
  assert.ok(!fs.existsSync(sp));
});

// ============================================================================
// C. Seed -> canonical upgrade qua ensureCanonicalSession
// ============================================================================

const SHA40 = /^[0-9a-f]{40}$/i;

function canonicalFixture({ stateDir, worktreesRoot, issueNumber = ISSUE, baseSha = BASE }) {
  const taskId = `${REPO}#${issueNumber}`;
  const branch = worktreeBranchFor({ identityHash: ID });
  const worktreePath = worktreePathFor({ worktreesRoot, identityHash: ID });
  const bindingPath = bindingPathFor({ worktreesRoot, identityHash: ID });
  const sessionPath = sessionPathFor({ stateDir, identityHash: ID });
  return { taskId, branch, worktreePath, bindingPath, sessionPath, issueNumber, baseSha };
}

function writeBinding(fx) {
  fs.mkdirSync(path.dirname(fx.bindingPath), { recursive: true });
  fs.writeFileSync(fx.bindingPath, `${JSON.stringify({
    schemaVersion: '1',
    taskId: fx.taskId,
    repo: REPO,
    issueNumber: fx.issueNumber,
    baseSha: fx.baseSha,
    branch: fx.branch,
    path: fx.worktreePath,
    identityHash: ID,
  }, null, 2)}\n`, 'utf8');
}

function fakeTaskStart({ stateDir, worktreesRoot, calls }) {
  return (args) => {
    calls.push(args);
    const fx = canonicalFixture({ stateDir, worktreesRoot, issueNumber: args.issueNumber, baseSha: args.baseSha });
    writeBinding(fx);
    fs.mkdirSync(path.dirname(fx.sessionPath), { recursive: true });
    fs.writeFileSync(fx.sessionPath, `${JSON.stringify({
      schemaVersion: '1',
      state: 'SESSION_ACTIVE',
      taskId: fx.taskId,
      identityHash: ID,
      repo: REPO,
      issueNumber: fx.issueNumber,
      baseSha: args.baseSha,
      branch: fx.branch,
      headSha: args.baseSha,
      worktreePath: fx.worktreePath,
      worktreesRoot: args.worktreesRoot,
      lease: { token: '0123456789abcdef0123456789abcdef0123456789abcdef', issuedAt: new Date().toISOString() },
      controlPlane: {
        stateDir: args.stateDir,
        sessionPath: fx.sessionPath,
        bindingPath: fx.bindingPath,
        worktreesRoot: args.worktreesRoot,
      },
      lifecycle: [],
    }, null, 2)}\n`, 'utf8');
    return { ok: true, reason: 'MOCK_TASK_START' };
  };
}

function writeSeed({ stateDir, issueNumber = ISSUE, baseSha = BASE }) {
  const record = {
    schemaVersion: '1',
    identityHash: ID,
    repo: REPO,
    issueNumber,
    prNumber: PR_NUMBER,
    headSha: HEAD,
    baseSha,
    branch: `agent/${ID}`,
  };
  const sp = sessionPathFor({ stateDir, identityHash: ID });
  fs.mkdirSync(path.dirname(sp), { recursive: true });
  const bytes = `${JSON.stringify(record, null, 2)}\n`;
  fs.writeFileSync(sp, bytes, 'utf8');
  return { sp, bytes, record };
}

function fakeExec(knownSha = BASE) {
  return (cmd, args) => {
    const argv = Array.isArray(args) ? args : [];
    if (argv.includes('rev-parse')) return `${knownSha}\n`;
    throw new Error(`unexpected git invocation: ${argv.join(' ')}`);
  };
}

test('C1: seed hydrate -> ensureCanonicalSession tái lập canonical session + merge prNumber, baseSha lấy từ PR (đã probe local)', async () => {
  const stateDir = mkStateDir();
  const worktreesRoot = path.join(stateDir, 'worktrees');
  fs.mkdirSync(worktreesRoot, { recursive: true });
  const { sp } = writeSeed({ stateDir });
  const calls = [];

  const r = await ensureCanonicalSession({
    repo: REPO,
    issueNumber: ISSUE,
    sessionPath: sp,
    stateDir,
    worktreesRoot,
    controlCwd: stateDir,
    taskStartImpl: fakeTaskStart({ stateDir, worktreesRoot, calls }),
    exec: fakeExec(BASE),
    baseRef: 'origin/main',
    laneId: 'soc_control',
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.created, true);
  assert.equal(r.value.hydrated, true, 'kết quả phải đánh dấu đã hydrate');
  assert.equal(calls.length, 1, 'taskStart chạy đúng một lần');
  assert.equal(calls[0].baseSha, BASE, 'baseSha ghim theo baseRefOid của PR khi còn resolvable local');
  const s = r.value.session;
  assert.equal(s.state, 'SESSION_ACTIVE');
  assert.equal(s.prNumber, PR_NUMBER, 'prNumber được merge từ seed');
  assert.equal(s.headSha, HEAD, 'headSha PR được merge từ seed (không để headSha=baseSha sai binding)');
  assert.ok(s.lease && s.lease.token, 'session canonical có lease');
  assert.equal(s.identityHash, ID);

  // seed KHÔNG còn — slot là session canonical hợp lệ
  const rs = readSessionRecord(sp);
  assert.equal(rs.ok, true, JSON.stringify(rs));
  assert.equal(rs.session.prNumber, PR_NUMBER);
  assert.equal(rs.session.headSha, HEAD, 'headSha survives read-back');
  assert.equal(isHydrationSeedRecord({ session: rs.session, identityHash: ID }), false);
});

test('C2: taskStart thất bại -> ensureCanonicalSession fail-closed và RESTORE seed byte-identical', async () => {
  const stateDir = mkStateDir();
  const worktreesRoot = path.join(stateDir, 'worktrees');
  fs.mkdirSync(worktreesRoot, { recursive: true });
  const { sp, bytes } = writeSeed({ stateDir });
  const calls = [];

  const r = await ensureCanonicalSession({
    repo: REPO,
    issueNumber: ISSUE,
    sessionPath: sp,
    stateDir,
    worktreesRoot,
    controlCwd: stateDir,
    taskStartImpl: (args) => { calls.push(args); return { ok: false, reason: 'WORKSPACE_ADMISSION_REJECTED', detail: 'provision refused' }; },
    exec: fakeExec(BASE),
    baseRef: 'origin/main',
  });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, 'WORKSPACE_ADMISSION_REJECTED');
  assert.equal(fs.readFileSync(sp, 'utf8'), bytes, 'seed phải được khôi phục nguyên vẹn — bằng chứng hydrate không được mất');
});

test('C3: record legacy thiếu trường (KHÔNG phải seed) -> vẫn SESSION_MINIMAL, taskStart không bị gọi (giữ hành vi cũ)', async () => {
  const stateDir = mkStateDir();
  const worktreesRoot = path.join(stateDir, 'worktrees');
  fs.mkdirSync(worktreesRoot, { recursive: true });
  const sp = sessionPathFor({ stateDir, identityHash: ID });
  fs.mkdirSync(path.dirname(sp), { recursive: true });
  const legacy = `${JSON.stringify({ schemaVersion: '1', repo: REPO, issueNumber: ISSUE }, null, 2)}\n`;
  fs.writeFileSync(sp, legacy, 'utf8');
  const calls = [];

  const r = await ensureCanonicalSession({
    repo: REPO,
    issueNumber: ISSUE,
    sessionPath: sp,
    stateDir,
    worktreesRoot,
    controlCwd: stateDir,
    taskStartImpl: (args) => { calls.push(args); return { ok: true }; },
    exec: fakeExec(BASE),
    baseRef: 'origin/main',
  });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, 'SESSION_MINIMAL');
  assert.equal(calls.length, 0, 'không có seed -> không tái lập qua taskStart');
  assert.equal(fs.readFileSync(sp, 'utf8'), legacy, 'record legacy không bị sửa');
});

test('C4: binding đã tồn tại với baseSha cũ -> ghim theo binding (idempotent reuse), KHÔNG dùng baseSha của PR', async () => {
  const stateDir = mkStateDir();
  const worktreesRoot = path.join(stateDir, 'worktrees');
  fs.mkdirSync(worktreesRoot, { recursive: true });
  const OLD_BASE = '3'.repeat(40);
  const fx = canonicalFixture({ stateDir, worktreesRoot, baseSha: OLD_BASE });
  writeBinding(fx);
  const { sp } = writeSeed({ stateDir, baseSha: BASE });
  const calls = [];

  const r = await ensureCanonicalSession({
    repo: REPO,
    issueNumber: ISSUE,
    sessionPath: sp,
    stateDir,
    worktreesRoot,
    controlCwd: stateDir,
    taskStartImpl: fakeTaskStart({ stateDir, worktreesRoot, calls }),
    exec: fakeExec(BASE),
    baseRef: 'origin/main',
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(calls[0].baseSha, OLD_BASE, 'binding là authority pin cho workspace đang tồn tại');
  assert.equal(r.value.session.prNumber, PR_NUMBER);
  assert.equal(r.value.session.baseSha, OLD_BASE);
});

// sanity: SHA40 helper thực sự dùng được (chống fixture sai chữ hoa/thường)
test('C5: fixture SHA40 hợp lệ', () => {
  assert.equal(SHA40.test(BASE), true);
});

// ============================================================================
// E. Goal từ PR metadata -> vượt gate instruction khi KHÔNG có --goal và
//    KHÔNG có route claim file (fix INSTRUCTION_SOURCE_MISSING trên máy mới
//    / stateDir bị dọn — PR #279). Bất biến: PR không title/body -> goal null
//    -> gate vẫn fail-closed INSTRUCTION_SOURCE_MISSING.
// ============================================================================

const PR_GOAL_TITLE = 'Fix INSTRUCTION_SOURCE_MISSING by hydrating goal from PR metadata';

test('E1: PR title -> seed.goal + hydrateMissingSession trả goal cho runner', () => {
  const stateDir = mkStateDir();
  const gh = () => ({ code: 0, stdout: viewJson({ title: PR_GOAL_TITLE }), stderr: '' });

  const r = hydrateSessionFromGitHub({ repo: REPO, prNumber: PR_NUMBER, stateDir, gh });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.goal, PR_GOAL_TITLE, 'hydration result must surface the PR title as goal');

  const raw = JSON.parse(fs.readFileSync(sessionPathFor({ stateDir, identityHash: ID }), 'utf8'));
  assert.equal(raw.goal, PR_GOAL_TITLE, 'seed record persists the extracted goal');
  assert.equal(isHydrationSeedRecord({ session: raw, identityHash: ID }), true, 'seed + goal vẫn nhận diện được là seed');

  // CLI policy surface: runner nhận cùng goal qua hydrateMissingSession
  const stateDir2 = mkStateDir();
  const hyd = hydrateMissingSession({
    repo: REPO, issueNumber: ISSUE, prNumber: PR_NUMBER,
    sessionPath: sessionPathFor({ stateDir: stateDir2, identityHash: ID }),
    stateDir: stateDir2, hydrate: true, gh,
  });
  assert.equal(hyd.ok, true, JSON.stringify(hyd));
  assert.equal(hyd.hydrated, true);
  assert.equal(hyd.value.goal, PR_GOAL_TITLE);
});

test('E2: PR thiếu title -> goal lấy từ tóm tắt body (loại identity marker / heading / linkage)', () => {
  const stateDir = mkStateDir();
  const body = `${marker()}\n\n## Mục tiêu\n\nTự động khôi phục goal khi auto-hydrate session\n\nCloses #${ISSUE}\n`;
  const gh = () => ({ code: 0, stdout: viewJson({ body }), stderr: '' });

  const r = hydrateSessionFromGitHub({ repo: REPO, prNumber: PR_NUMBER, stateDir, gh });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.goal, 'Tự động khôi phục goal khi auto-hydrate session');
  const raw = JSON.parse(fs.readFileSync(sessionPathFor({ stateDir, identityHash: ID }), 'utf8'));
  assert.equal(raw.goal, 'Tự động khôi phục goal khi auto-hydrate session');

  // Dòng goal mở đầu bằng keyword + #N KHÔNG được bỏ nhầm là linkage thuần
  const stateDir2 = mkStateDir();
  const body2 = `Fixed #12 trong parser\n\nCloses #${ISSUE}\n\n${marker()}\n`;
  const gh2 = () => ({ code: 0, stdout: viewJson({ body: body2 }), stderr: '' });
  const r2 = hydrateSessionFromGitHub({ repo: REPO, prNumber: PR_NUMBER, stateDir: stateDir2, gh: gh2 });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(r2.value.goal, 'Fixed #12 trong parser', 'chỉ dòng CHỈ chứa linkage mới bị loại');
});

test('E3: PR không có title/body goal + không route claim -> upgrade xong nhưng gate vẫn fail-closed INSTRUCTION_SOURCE_MISSING', async () => {
  const stateDir = mkStateDir();
  const worktreesRoot = path.join(stateDir, 'worktrees');
  fs.mkdirSync(worktreesRoot, { recursive: true });
  // body chỉ có linkage + marker: không có dòng mục tiêu nào -> goal null
  const body = `Closes #${ISSUE}\n\n${marker()}\n`;
  const gh = () => ({ code: 0, stdout: viewJson({ body, title: '' }), stderr: '' });

  const hyd = hydrateMissingSession({
    repo: REPO, issueNumber: ISSUE, prNumber: PR_NUMBER,
    sessionPath: sessionPathFor({ stateDir, identityHash: ID }),
    stateDir, hydrate: true, gh,
  });
  assert.equal(hyd.ok, true, JSON.stringify(hyd));
  assert.equal(hyd.hydrated, true);
  assert.equal(hyd.value.goal ?? null, null, 'không có title/body -> không bao giờ tự bịa goal');

  const sp = sessionPathFor({ stateDir, identityHash: ID });
  const calls = [];
  const admitted = await ensureCanonicalSession({
    repo: REPO, issueNumber: ISSUE, sessionPath: sp, stateDir, worktreesRoot,
    controlCwd: stateDir,
    taskStartImpl: fakeTaskStart({ stateDir, worktreesRoot, calls }),
    exec: fakeExec(BASE), baseRef: 'origin/main', laneId: 'soc_control',
  });
  assert.equal(admitted.ok, true, JSON.stringify(admitted));
  assert.equal(admitted.value.session.hydratedGoal, undefined, 'goal null -> không ghi hydratedGoal');
  assert.equal(calls[0].taskContract, null, 'không có goal -> taskStart không nhận taskContract (hành vi cũ)');

  assert.ok(!fs.existsSync(path.join(stateDir, 'client-mcp', 'routes', `${ID}.control-loop.json`)), 'route claim vắng mặt đúng như kịch bản máy mới');
  const gate = resolveRunnerInstruction({ instruction: null, goal: null, session: admitted.value.session, sessionPath: sp });
  assert.equal(gate && gate.ok, false, JSON.stringify(gate));
  assert.equal(gate.code, 'INSTRUCTION_SOURCE_MISSING', 'cả 4 nguồn đều vắng -> fail-closed đúng hợp đồng');
});

test('E4: hydrate từ PR title, KHÔNG --goal, KHÔNG route claim -> runner nhận goal từ PR metadata và vượt gate instruction', async () => {
  const stateDir = mkStateDir();
  const worktreesRoot = path.join(stateDir, 'worktrees');
  fs.mkdirSync(worktreesRoot, { recursive: true });
  const gh = () => ({ code: 0, stdout: viewJson({ title: PR_GOAL_TITLE }), stderr: '' });

  // (1) hydrate seed từ GitHub PR (mất session local, có PR) — không CLI --goal
  const hyd = hydrateMissingSession({
    repo: REPO, issueNumber: ISSUE, prNumber: PR_NUMBER,
    sessionPath: sessionPathFor({ stateDir, identityHash: ID }),
    stateDir, hydrate: true, gh,
  });
  assert.equal(hyd.ok, true, JSON.stringify(hyd));
  assert.equal(hyd.hydrated, true);
  assert.equal(hyd.value.goal, PR_GOAL_TITLE);

  // (2) nâng seed -> canonical: goal được truyền vào taskStart + merge vào session
  const sp = sessionPathFor({ stateDir, identityHash: ID });
  const calls = [];
  const admitted = await ensureCanonicalSession({
    repo: REPO, issueNumber: ISSUE, sessionPath: sp, stateDir, worktreesRoot,
    controlCwd: stateDir,
    taskStartImpl: fakeTaskStart({ stateDir, worktreesRoot, calls }),
    exec: fakeExec(BASE), baseRef: 'origin/main', laneId: 'soc_control',
  });
  assert.equal(admitted.ok, true, JSON.stringify(admitted));
  assert.equal(calls.length, 1, 'taskStart chạy đúng một lần');
  assert.deepEqual(
    calls[0].taskContract,
    { title: `Task #${ISSUE}`, body: PR_GOAL_TITLE },
    'upgrade truyền goal từ PR vào taskStart (session contract)',
  );
  assert.equal(admitted.value.session.hydratedGoal, PR_GOAL_TITLE, 'canonical session lưu goal hydrate từ PR');

  // (3) không có route claim file (máy mới) — gate instruction tự nhận goal từ session
  assert.ok(!fs.existsSync(path.join(stateDir, 'client-mcp', 'routes', `${ID}.control-loop.json`)));
  const gate = resolveRunnerInstruction({
    instruction: null, goal: null, session: admitted.value.session, sessionPath: sp,
  });
  assert.equal(typeof gate, 'string', `gate phải là instruction string, got ${JSON.stringify(gate)}`);
  assert.ok(gate.startsWith(PR_GOAL_TITLE), `goal từ PR title được dùng làm instruction, got ${JSON.stringify(gate)}`);
});
