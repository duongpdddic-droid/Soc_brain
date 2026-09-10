// cline-livesmoke-child.mjs — child runner for the abnormal-termination phase
// of tests/cline-sdk-adapter.livesmoke.test.mjs. Started by the parent, killed
// mid-run (SIGKILL) to leave a non-terminal ExecutionRecord + SDK artifacts.
// NOT part of the deterministic suite.
import fs from 'node:fs';
import { createClineSdkExecutor } from '../packages/cline-sdk-adapter/cline-sdk-adapter.mjs';

const [stateDir, sessionPath, idh, worktree] = process.argv.slice(2);
console.log(`CHILD_PID=${process.pid}`);
const adapter = createClineSdkExecutor({
  stateDir,
  enabled: true,
  env: { ...process.env, SOC_CLINE_SDK_ADAPTER: '1' },
  verifyAuthority: () => ({ ok: true }),
  provider: { providerId: 'gemini', apiKeyEnv: 'GEMINI_API_KEY', modelId: process.env.POC_MODEL || 'gemini-3.5-flash-lite' },
}).value;
const r = await adapter.start({
  sessionPath,
  session: { leaseToken: 'child-tok' },
  binding: { identityHash: idh, taskId: 'o/r#2', repo: 'o/r', issueNumber: 2, baseSha: 'c'.repeat(40), branch: 'soc/live', path: worktree },
  instruction: 'Create counting.txt with the numbers 1 to 400, one per line, using the editor tool. Then read it back and report the line count.',
  mutation: 'allow',
  maxIterations: 60,
});
console.log(`CHILD_START_OK=${r.ok}`);
setInterval(() => {}, 1000); // keep alive until the parent kills us
