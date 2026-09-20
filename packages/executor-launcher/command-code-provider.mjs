import fs from 'node:fs';
import path from 'node:path';

export const COMMAND_CODE_EXECUTOR_ID = 'command-code';
export const COMMAND_CODE_MAX_TURNS = 100;

const MUTATION_TOOLS = new Set(['write_file', 'edit_file', 'shell_command', 'powershell']);
const REDACTED_EVENT_TYPES = new Set(['thinking_start', 'thinking_delta', 'thinking_end', 'message_update']);

function isRealFile(candidate, exists = fs.existsSync) {
  try { return exists(candidate) && fs.statSync(candidate).isFile(); } catch { return false; }
}

// Resolve npm/NVM without spawning cmdc.ps1/cmdc.cmd
// The launcher executes: node.exe <command-code/dist/index.mjs> ...args
export function resolveCommandCodeExecutable({
  env = process.env,
  exists = fs.existsSync,
  nodeExecutable = process.execPath,
} = {}) {
  const candidates = [];
  if (env.SOC_COMMAND_CODE_ENTRYPOINT) {
    candidates.push({
      executable: env.SOC_COMMAND_CODE_NODE || nodeExecutable,
      entrypoint: env.SOC_COMMAND_CODE_ENTRYPOINT,
      source: 'env:SOC_COMMAND_CODE_ENTRYPOINT',
    });
  }
  for (const rawDir of String(env.PATH || '').split(path.delimiter)) {
    const dir = String(rawDir || '').replace(/^"+|"+$/g, '');
    if (!dir) continue;
    const servesShim = ['cmdc.ps1', 'cmdc.cmd', 'cmdc', 'command-code.ps1', 'command-code.cmd', 'command-code']
      .some((name) => exists(path.join(dir, name)));
    if (!servesShim) continue;
    const localNode = path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node');
    candidates.push({
      executable: isRealFile(localNode, exists) ? localNode : nodeExecutable,
      entrypoint: path.join(dir, 'node_modules', 'command-code', 'dist', 'index.mjs'),
      source: 'path:npm-global',
    });
  }
  if (env.APPDATA) {
    const dir = path.join(env.APPDATA, 'npm');
    const servesShim = ['cmdc.ps1', 'cmdc.cmd', 'cmdc'].some((name) => exists(path.join(dir, name)));
    if (servesShim) candidates.push({
      executable: nodeExecutable,
      entrypoint: path.join(dir, 'node_modules', 'command-code', 'dist', 'index.mjs'),
      source: 'appdata:npm-global',
    });
  }
  for (const candidate of candidates) {
    if (isRealFile(candidate.executable, exists) && isRealFile(candidate.entrypoint, exists)) {
      return {
        ok: true,
        executable: candidate.executable,
        argvPrefix: [candidate.entrypoint],
        entrypoint: candidate.entrypoint,
        source: candidate.source,
        candidates,
      };
    }
  }
  return {
    ok: false,
    reason: 'COMMAND_CODE_UNAVAILABLE',
    detail: 'Could not resolve node executable plus command-code/dist/index.mjs.',
    candidates,
  };
}

export function buildCommandCodeLaunchArgv({ instruction, model = null, resumeSessionId = null, maxTurns = COMMAND_CODE_MAX_TURNS } = {}) {
  if (typeof instruction !== 'string' || !instruction.trim()) return { ok: false, reason: 'INSTRUCTION_INVALID', detail: 'instruction must be a non-empty string.' };
  if (model !== null && !(typeof model === 'string' && model.trim())) return { ok: false, reason: 'MODEL_INVALID', model };
  if (resumeSessionId !== null && !(typeof resumeSessionId === 'string' && /^[A-Za-z0-9-]+$/.test(resumeSessionId))) return { ok: false, reason: 'COMMAND_CODE_SESSION_INVALID' };
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 1000) return { ok: false, reason: 'COMMAND_CODE_MAX_TURNS_INVALID' };
  const argv = ['-p'];
  if (resumeSessionId) argv.push('--resume', resumeSessionId);
  argv.push('--output-format', 'json', '--yolo', '--skip-onboarding', '--max-turns', String(maxTurns));
  if (model) argv.push('--model', model);
  argv.push(instruction);
  return { ok: true, argv };
}

export function classifyCommandCodeEvent(line) {
  const source = String(line);
  if (!source.trim()) return null;
  try {
    const frame = JSON.parse(source);
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('not object');
    if (frame.type === 'result') return { kind: 'result', event: frame, sessionId: typeof frame.sessionId === 'string' ? frame.sessionId : null };
    if (frame.type !== 'event' || !frame.event || typeof frame.event !== 'object') return { kind: 'event', event: frame };
    const event = frame.event;
    if (REDACTED_EVENT_TYPES.has(event.type)) return null;
    if (event.type === 'run_start') {
      return { kind: 'run_start', event: { type: 'event', event: { type: 'run_start', sessionId: event.sessionId ?? null } }, sessionId: typeof event.sessionId === 'string' ? event.sessionId : null };
    }
    if (event.type === 'turn_start') return { kind: 'step_start', event: frame, turnNumber: event.turnNumber ?? null };
    if (event.type === 'turn_end') return { kind: 'step_finish', event: frame, turnNumber: event.turnNumber ?? null };
    if (event.type === 'tool_running') return { kind: 'tool', event: frame, tool: event.toolName ?? null, toolCallId: event.toolCallId ?? null };
    if (event.type === 'run_end') {
      const result = event.result || {};
      const sessionId = typeof result.nextState?.sessionId === 'string' ? result.nextState.sessionId : null;
      return {
        kind: 'run_end',
        event: { type: 'event', event: { type: 'run_end', result: { finalText: result.finalText ?? '', stopReason: result.stopReason ?? null, turnCount: result.turnCount ?? null, usage: result.usage ?? null, interrupted: result.nextState?.interrupted ?? null, sessionId } } },
        sessionId,
      };
    }
    if (event.type === 'message_end') {
      const content = Array.isArray(event.content) ? event.content.filter((item) => item?.type === 'text') : [];
      return { kind: 'text', event: { type: 'event', event: { type: 'message_end', content } }, text: content.map((item) => item.text || '').join('') };
    }
    return { kind: 'event', event: frame };
  } catch {
    return { kind: 'output', line: source };
  }
}

export function classifyCommandCodeOutcome({ exitCode, signal = null, result = null } = {}) {
  if (signal || exitCode === 130) return { terminalStatus: 'FAILED', executionOutcome: 'INTERRUPTED', retryable: true, reason: 'COMMAND_CODE_INTERRUPTED' };
  if (exitCode === 0 && result?.subtype === 'success') return { terminalStatus: 'EXITED', executionOutcome: 'COMPLETED', retryable: false, reason: null };
  if (exitCode === 0) return { terminalStatus: 'FAILED', executionOutcome: 'FAILED_PROTOCOL', retryable: false, reason: 'COMMAND_CODE_RESULT_MISSING_OR_INVALID' };
  const outcomes = {
    3: ['BLOCKED_AUTH', false], 4: ['BLOCKED_PERMISSION', false],
    5: ['RETRYABLE_RATE_LIMIT', true], 6: ['RETRYABLE_NETWORK', true],
    7: ['RETRYABLE_PROVIDER', true], 8: ['PAUSED_MAX_TURNS', true],
    9: ['RETRYABLE_NO_RESPONSE', true], 10: ['BLOCKED_BUDGET', false],
  };
  const [executionOutcome, retryable] = outcomes[exitCode] || ['FAILED', false];
  return { terminalStatus: 'FAILED', executionOutcome, retryable, reason: `COMMAND_CODE_EXIT_${exitCode ?? 'null'}` };
}

export function isCommandCodeMutationCandidate(classified) {
  return classified?.kind === 'tool' && MUTATION_TOOLS.has(classified.tool);
}