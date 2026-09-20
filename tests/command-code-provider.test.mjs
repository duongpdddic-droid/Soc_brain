import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildCommandCodeLaunchArgv,
  classifyCommandCodeEvent,
  classifyCommandCodeOutcome,
  isCommandCodeMutationCandidate,
  resolveCommandCodeExecutable,
} from '../packages/executor-launcher/command-code-provider.mjs';

test('resolves npm shim to direct node entrypoint without cmd.exe', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdc-provider-'));
  try {
    const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
    const nodePath = path.join(dir, nodeName);
    const shimPath = path.join(dir, process.platform === 'win32' ? 'cmdc.ps1' : 'cmdc');
    const entrypoint = path.join(dir, 'node_modules', 'command-code', 'dist', 'index.mjs');
    fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
    fs.writeFileSync(nodePath, 'node');
    fs.writeFileSync(shimPath, 'shim');
    fs.writeFileSync(entrypoint, 'entry');
    const r = resolveCommandCodeExecutable({ env: { PATH: dir }, nodeExecutable: nodePath });
    assert.equal(r.ok, true);
    assert.equal(r.executable, nodePath);
    assert.deepEqual(r.argvPrefix, [entrypoint]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('builds exact headless resume argv', () => {
  const r = buildCommandCodeLaunchArgv({ instruction: 'fix test', resumeSessionId: 'abc-123', model: 'deepseek-v4' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.argv, ['-p', '--resume', 'abc-123', '--output-format', 'json', '--yolo', '--skip-onboarding', '--max-turns', '100', '--model', 'deepseek-v4', 'fix test']);
});

test('captures run_start session and redacts thinking events', () => {
  const start = classifyCommandCodeEvent('{"type":"event","event":{"type":"run_start","sessionId":"s-1"}}');
  assert.equal(start.sessionId, 's-1');
  assert.equal(classifyCommandCodeEvent('{"type":"event","event":{"type":"thinking_delta","delta":"secret"}}'), null);
});

test('sanitizes run_end nextState messages', () => {
  const c = classifyCommandCodeEvent('{"type":"event","event":{"type":"run_end","result":{"finalText":"ok","nextState":{"sessionId":"s-2","messages":[{"thinking":"secret"}]}}}}');
  assert.equal(c.sessionId, 's-2');
  assert.equal(JSON.stringify(c).includes('secret'), false);
});

test('classifies mutation candidates and documented outcomes', () => {
  const tool = classifyCommandCodeEvent('{"type":"event","event":{"type":"tool_running","toolCallId":"t1","toolName":"edit_file"}}');
  assert.equal(isCommandCodeMutationCandidate(tool), true);
  assert.equal(classifyCommandCodeOutcome({ exitCode: 0, result: { subtype: 'success' } }).executionOutcome, 'COMPLETED');
  assert.equal(classifyCommandCodeOutcome({ exitCode: 3 }).executionOutcome, 'BLOCKED_AUTH');
  assert.equal(classifyCommandCodeOutcome({ exitCode: 10 }).executionOutcome, 'BLOCKED_BUDGET');
});