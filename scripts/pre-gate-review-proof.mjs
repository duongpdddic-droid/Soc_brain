// scripts/pre-gate-review-proof.mjs — bounded, disposable-fixture proof for
// PRE-GATE-REVIEW-01. Runs the REAL REVIEW-ONLY leg transport (ocr +
// opencode CLI, snapshot worktree, read-only permissions) on a throwaway
// repo and proves the composite contract:
//   CLEAN -> inner verifier exactly once; findings -> verifier never runs;
//   timeout / drift / binding mismatch -> typed refusal, no verifier call.
// Not part of any test tier; it is an operator-run evidence script.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { preGateReviewVerifierAdapter } from '../packages/control-loop/pre-gate-review.mjs';
import { createOcrReviewTransport } from '../packages/control-loop/ocr-review-transport.mjs';

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgr-proof-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'proof@example.com']);
  git(dir, ['config', 'user.name', 'proof']);
  const file = path.join(dir, 'calc.js');
  fs.writeFileSync(file, 'export function add(a, b) { return a + b; }\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'base']);
  const baseSha = git(dir, ['rev-parse', 'HEAD']);
  const poisoned = process.argv.includes('badfixture');
  const headContent = poisoned
    ? 'export function add(a, b) {\n  // SQL injection + eval of dynamic input\n  const q = "SELECT * FROM t WHERE id = \'" + a + "\'";\n  eval(a);\n  return a - b + q;\n}\n'
    : 'export function add(a, b) {\n  // guard\n  if (typeof a !== "number" || typeof b !== "number") throw new TypeError("numbers only");\n  return a + b;\n}\n';
  fs.writeFileSync(file, headContent);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'head']);
  const headSha = git(dir, ['rev-parse', 'HEAD']);
  return { dir, baseSha, headSha };
}

function hex32(s) {
  return s.replace(/[^0-9a-f]/gi, '').padEnd(32, '0').slice(0, 32);
}

function makeRegistry(dir) {
  const p = path.join(dir, 'registry.json');
  fs.writeFileSync(p, JSON.stringify({
    schemaVersion: '1',
    projects: [{ projectId: 'fixture', repository: 'owner/fixture' }],
  }));
  return p;
}

function buildIo({ dir, baseSha, headSha, digest }) {
  const record = {
    repo: 'owner/fixture', issueNumber: 1, taskId: 'task-proof',
    worktreePath: dir, baseSha, headSha,
    codeContentDigest: digest, codeContentFiles: 1,
  };
  return {
    readSession: () => ({
      ok: true,
      session: {
        repo: 'owner/fixture', issueNumber: 1, taskId: 'task-proof', prNumber: 1,
        worktreePath: dir, baseSha, headSha, identityHash: hex32(dir),
        controlPlane: { stateDir: dir },
      },
    }),
    readExecutionRecord: () => ({ ok: true, record }),
    computeBinding: () => computeDigest(dir),
    findProjectId: () => 'fixture',
    registryPath: null,
  };
}

import { computeWorktreeContentBinding } from '../packages/executor-launcher/execution-content-binding.mjs';
function computeDigest(dir) {
  return computeWorktreeContentBinding({ worktreePath: dir, headSha: git(dir, ['rev-parse', 'HEAD']) });
}

const HangingTransport = () => new Promise(() => {});

async function scenario(name, { dir, baseSha, headSha, digest, transportOverrides, compositeOverrides, transportFnDouble }) {
  let innerCalls = 0;
  const inner = async () => { innerCalls += 1; return { ok: true, value: { verdict: 'PASS' } }; };
  const io = buildIo({ dir, baseSha, headSha, digest });
  io.registryPath = makeRegistry(dir);
  const transport = transportFnDouble
    ? transportFnDouble
    : (transportOverrides === null ? null : createOcrReviewTransport({ ...transportOverrides }));
  const verifier = preGateReviewVerifierAdapter({
    innerVerifier: inner,
    transport,
    registryPath: io.registryPath,
    io,
    timeoutMs: (compositeOverrides && compositeOverrides.timeoutMs) ?? 600000,
  });
  const t0 = Date.now();
  const res = await verifier({ sessionPath: 'unused', executionRecordPath: 'unused' });
  const ms = Date.now() - t0;
  console.log(`\n=== ${name} ===`);
  console.log(`verdict: ok=${res.ok} code=${res.ok === false ? res.code : 'VERDICT_PASS'} innerVerifierCalls=${innerCalls} elapsed=${ms}ms`);
  console.log(`detail: ${JSON.stringify(res.ok === false ? res.detail : res.value)}`);
  return { ok: res.ok, code: res.ok === false ? res.code : null, innerCalls, ms };
}

const { dir, baseSha, headSha } = makeFixture();
const live = computeDigest(dir);
const digest = live.ok ? live.value.contentDigest : null;
if (!digest) { console.error('fixture digest failed'); process.exit(2); }
console.log(`fixture: ${dir}`);
console.log(`base=${baseSha} head=${headSha}`);

// 1) REAL leg run (synchronous leg; the composite timeout bounds it via the
//    adapter race timer for the verdict path).
const s1 = await scenario('real-leg clean fixture', { dir, baseSha, headSha, digest, transportOverrides: {}, compositeOverrides: {} });
// If the real leg produced no findings the contract requires innerVerifierCalls === 1;
// if it produced findings/refusal, innerVerifierCalls must be 0 and the code typed.
if (s1.ok && s1.code === null) console.log(`[check] real leg CLEAN -> inner verifier called ${s1.innerCalls} time(s) (expect 1)`);
else console.log(`[check] real leg produced ${s1.code} (findings or refusal) -> inner verifier called ${s1.innerCalls} time(s) (expect 0)`);

// 2a) Adapter boundary: hanging async transport -> composite TIMEOUT ->
//     typed refusal, verifier never runs.
const s2a = await scenario('adapter timeout bound', { dir, baseSha, headSha, digest, transportOverrides: null, compositeOverrides: { timeoutMs: 25 }, transportFnDouble: HangingTransport });
console.log(`[check] adapter timeout -> code=${s2a.code} inner=${s2a.innerCalls} (expect INTERNAL_REVIEW_TRANSPORT / 0)`);

// 2b) REAL leg-level timeout (spawn timeout bound) -> typed refusal,
//     verifier never runs.
const s2b = await scenario('real leg spawn timeout', { dir, baseSha, headSha, digest, transportOverrides: { timeoutMs: 1 }, compositeOverrides: {} });
console.log(`[check] real leg timeout -> code=${s2b.code} inner=${s2b.innerCalls} (expect typed refusal / 0)`);

// 3) Stale candidate: record digest != live digest -> typed refusal before review.
const s3 = await scenario('candidate drift', { dir, baseSha, headSha, digest: digest.slice(0, -1) + (digest.endsWith('a') ? 'b' : 'a'), transportOverrides: {}, compositeOverrides: {} });
console.log(`[check] drift -> code=${s3.code} inner=${s3.innerCalls} (expect INTERNAL_REVIEW_CANDIDATE_STALE / 0)`);

// 4) Unsupported default (no transport wired => fail closed, never CLEAN).
const s4 = await scenario('no transport (fail-closed)', { dir, baseSha, headSha, digest, transportOverrides: null, compositeOverrides: {} });
console.log(`[check] no transport -> code=${s4.code} inner=${s4.innerCalls} (expect INTERNAL_REVIEW_TRANSPORT / 0)`);

console.log('\nPROOF SCRIPT COMPLETE');
