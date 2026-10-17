// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
// OpenCode V2.0.26. JavaScript-compatible TypeScript; no plugin runtime dependency.
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

export const DEFAULT_TIMEOUT_MS = 180_000;
const OUTPUT_CAP = 10 * 1024 * 1024;

export function resolveInvocation(env = process.env, platform = process.platform) {
  // Execute the installed JS wrapper through Node, never a PowerShell/cmd shim.
  const entries = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  const nodeName = platform === 'win32' ? 'node.exe' : 'node';
  const node = entries.map(p => join(p.replace(/^"|"$/g, ''), nodeName)).find(existsSync);
  for (const entry of entries) {
    const directory = entry.replace(/^"|"$/g, '');
    const candidate = join(directory, 'node_modules', '@alibaba-group', 'open-code-review', 'bin', 'ocr.js');
    let wrapper = existsSync(candidate) ? candidate : undefined;
    if (!wrapper && platform !== 'win32' && existsSync(join(directory, 'ocr'))) {
      const target = realpathSync(join(directory, 'ocr'));
      if (target.endsWith('/bin/ocr.js')) wrapper = target;
    }
    if (node && wrapper) return { command: node, prefixArgs: [wrapper] };
  }
  throw new Error('OCR Node wrapper or Node executable not found on PATH. Verify the existing OCR installation; no shell fallback was used.');
}

function pushValue(args, flag, value) {
  if (value !== undefined && value !== '') args.push(flag, String(value));
}
function buildReviewArgs(input, repo) {
  const hasRange = input.from !== undefined || input.to !== undefined
  if (hasRange && (!input.from || !input.to)) {
    throw new Error("Both 'from' and 'to' are required for a branch comparison.")
  }
  if (input.commit && hasRange) {
    throw new Error("Use either 'commit' or a 'from'/'to' range, not both.")
  }
  if (input.resume && (input.commit || hasRange)) {
    throw new Error("'resume' cannot be combined with 'commit' or a 'from'/'to' range.")
  }
  if (input.preview && input.resume) {
    throw new Error("'preview' and 'resume' cannot be used together.")
  }
  // Reject ambiguous context rather than silently letting the file win.
  if (input.background && input.backgroundFile) {
    throw new Error("Use either 'background' or 'backgroundFile', not both.")
  }

  const args = ["review", "--audience", "agent"]
  if (!input.preview) {
    args.push("--format", "json")
  }
  args.push("--repo", repo)

  pushValue(args, "--commit", input.commit)
  pushValue(args, "--from", input.from)
  pushValue(args, "--to", input.to)
  pushValue(args, "--resume", input.resume)
  pushValue(args, "--background", input.background)
  pushValue(args, "--background-file", input.backgroundFile)
  pushValue(args, "--exclude", input.exclude)
  pushValue(args, "--model", input.model)
  pushValue(args, "--concurrency", input.concurrency)
  pushValue(args, "--timeout", input.timeoutMinutes)
  pushValue(args, "--max-tools", input.maxTools)
  pushValue(args, "--max-git-procs", input.maxGitProcesses)

  if (input.preview) {
    args.push("--preview")
  }
  return args
}


export async function runOcr(args, options) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? OUTPUT_CAP;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new Error('Invalid OCR deadline');
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) throw new Error('Invalid OCR output cap');
  options.signal?.throwIfAborted();
  const invocation = options.invocation ?? resolveInvocation();
  const started = performance.now();
  return new Promise((resolveResult, reject) => {
    const child = spawn(invocation.command, [...invocation.prefixArgs, ...args], {
      cwd: options.cwd, env: process.env, shell: false, detached: true,
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = { stdout: [], stderr: [] };
    let size = 0, reason, closed = false, treeDone = true, cleanupError;
    let code = null, exitSignal = null, settled = false, cleanupTimer;
    const result = () => ({
      stdout: Buffer.concat(chunks.stdout).toString('utf8').trim(),
      stderr: Buffer.concat(chunks.stderr).toString('utf8').trim(),
      exitCode: code, signal: exitSignal, elapsedMs: Math.round(performance.now() - started),
    });
    const finish = (force = false) => {
      if (settled || (!force && (!closed || !treeDone))) return;
      settled = true;
      clearTimeout(deadline); clearTimeout(cleanupTimer);
      options.signal?.removeEventListener('abort', abort);
      const output = result();
      if (reason || code !== 0 || cleanupError) {
        const diagnostic = !reason && code !== 0 ? (output.stderr || output.stdout).slice(0, 4096) : '';
        const error = new Error([reason ?? `OCR exited with code ${code}, signal ${exitSignal}`, diagnostic, cleanupError].filter(Boolean).join('; '));
        Object.assign(error, output, { cleanupConfirmed: closed && treeDone && !cleanupError });
        reject(error);
      } else resolveResult(output);
    };
    const stop = (message) => {
      if (reason || settled) return;
      reason = message;
      if (child.pid !== undefined) {
        if (process.platform === 'win32') {
          treeDone = false;
          const killer = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
            ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          killer.on('error', error => { cleanupError = `taskkill failed: ${error.message}`; treeDone = true; finish(); });
          killer.on('close', value => { if (value !== 0) cleanupError = `taskkill exit ${value}`; treeDone = true; finish(); });
        } else {
          try { process.kill(-child.pid, 'SIGKILL'); }
          catch (error) { if (error.code !== 'ESRCH') cleanupError = `process-group kill failed: ${error.message}`; }
        }
      }
      cleanupTimer = setTimeout(() => {
        cleanupError = 'CLEANUP_UNVERIFIED: child/process-tree termination was not confirmed; do not retry automatically';
        finish(true);
      }, 5_000);
      finish();
    };
    for (const channel of ['stdout', 'stderr']) child[channel].on('data', chunk => {
      if (reason || settled) return;
      size += chunk.byteLength;
      if (size > maxOutputBytes) return stop(`OCR output exceeded ${maxOutputBytes} bytes`);
      chunks[channel].push(chunk);
    });
    child.on('error', error => { reason ??= `OCR spawn failed: ${error.message}`; });
    child.on('close', (value, signal) => { closed = true; code = value; exitSignal = signal; finish(); });
    const abort = () => stop('OCR cancelled by OpenCode');
    const deadline = setTimeout(() => stop(`OCR timed out after ${timeoutMs} ms`), timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}

export function formatReviewResult(result, preview) {
  if (!result.stdout) throw new Error('OCR returned empty output; review coverage is UNKNOWN');
  if (preview) return result.stdout;
  let parsed;
  try { parsed = JSON.parse(result.stdout); }
  catch { throw new Error('OCR returned invalid JSON; review coverage is UNKNOWN'); }
  if (parsed === null || typeof parsed !== 'object') throw new Error('OCR returned a non-structured result; review coverage is UNKNOWN');
  return parsed;
}

export async function resolveSessionCwd(ctx, sessionID) {
  const session = await ctx.session.get({ sessionID });
  const directory = session?.location?.directory;
  if (typeof directory !== 'string' || !isAbsolute(directory)) throw new Error('Session directory unavailable; OCR will not use a fallback repository');
  return resolve(directory, session.subpath ?? '');
}

export function createPlugin(run = runOcr) {
  return {
    id: 'open-code-review',
    async setup(ctx) {
      if (typeof ctx.tool?.transform !== 'function') throw new Error('OCR requires OpenCode V2 tool.transform');
      await ctx.tool.transform(editor => {
        editor.add({name: 'ocr_review', description: 'OCR internal pre-review evidence, never final approval. Use exact from/to commit SHAs for task coverage; preview does not call an LLM.', input: reviewInputSchema,
          execute: async (input, toolCtx) => {
            const cwd = await resolveSessionCwd(ctx, toolCtx.sessionID);
            const minutes = input.overallTimeoutMinutes ?? 3;
            if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 30) throw new Error('overallTimeoutMinutes must be 1..30');
            const result = await run(buildReviewArgs(input, cwd), {cwd, signal: toolCtx.signal, timeoutMs: minutes * 60_000});
            return {content: JSON.stringify({kind: input.preview ? 'OCR_PREVIEW' : 'OCR_REVIEW_EVIDENCE', repository: cwd, target: {commit: input.commit, from: input.from, to: input.to, resume: input.resume}, elapsedMs: result.elapsedMs, stderr: result.stderr, result: formatReviewResult(result, input.preview === true)})};
          }});
        editor.add({name: 'ocr_health', description: 'Check the OCR version and configured LLM. Throws on failure; does not repair or replace model configuration.', input: {type:'object',properties:{},additionalProperties:false},
          execute: async (_input, toolCtx) => {
            const cwd = await resolveSessionCwd(ctx, toolCtx.sessionID);
            const results = await Promise.allSettled([
              run(['version'], {cwd,signal:toolCtx.signal,timeoutMs:30_000}),
              run(['llm','test'], {cwd,signal:toolCtx.signal,timeoutMs:60_000}),
            ]);
            const failures = results.filter(r=>r.status === 'rejected');
            if (failures.length) throw new Error('OCR health failed: ' + failures.map(r=>r.reason?.message ?? String(r.reason)).join('; '));
            if (results.some(r=>!(r.value.stdout || r.value.stderr))) throw new Error('OCR health returned empty probe output; health is UNKNOWN');
            return {content: JSON.stringify({kind:'OCR_HEALTH',checks:results.map(r=>r.value)})};
          }});
      });
      const registered = await ctx.command.list();
      const names = new Set(registered.data.map(command=>command.name));
      await ctx.command.transform(editor => {
        for (const [name, text] of [['ocr-review','Use ocr_review for internal pre-review. Bind exact task base and candidate SHAs.'],['ocr-health','Use ocr_health and report configuration failures.']]) {
          if (!names.has(name)) editor.add({name, description:text, execute:async ({sessionID,prompt,delivery}) => {
            await ctx.session.prompt({sessionID,text:text + '\n' + (prompt.text ?? ''),delivery});
          }});
        }
      });
    },
  };
}

export default createPlugin();
const reviewInputSchema = {
  type: "object",
  properties: {
    commit: { type: "string", description: "Review one commit against its parent." },
    from: { type: "string", description: "Base ref for a branch/range comparison. Must be paired with 'to'." },
    to: { type: "string", description: "Target ref for a branch/range comparison. Must be paired with 'from'." },
    resume: { type: "string", description: "Resume a previous OCR review session by ID." },
    background: { type: "string", description: "Business or requirement context that the implementation should satisfy." },
    backgroundFile: { type: "string", description: "Path to a Markdown file holding the review background, for context too long to pass inline. A relative path resolves against the repository root; an absolute path is used as given. Cannot be combined with 'background'." },
    exclude: { type: "string", description: "Comma-separated gitignore-style exclusion patterns." },
    model: { type: "string", description: "Override the model configured in OpenCodeReview." },
    concurrency: { type: "integer", minimum: 1, description: "Maximum concurrent file reviews." },
    timeoutMinutes: { type: "integer", minimum: 1, description: "Per-file OCR timeout in minutes." },
    overallTimeoutMinutes: { type: "integer", minimum: 1, maximum: 30, description: "Default 3 minutes; maximum 30. Explicit wall-clock timeout for the complete OCR process in minutes." },
    maxTools: { type: "integer", minimum: 1, description: "Maximum tool-call rounds per subtask; OCR enforces a minimum of 50." },
    maxGitProcesses: { type: "integer", minimum: 1, description: "Maximum concurrent Git subprocesses." },
    preview: { type: "boolean", description: "List the files that would be reviewed without calling an LLM." },
  },
  required: [],
  additionalProperties: false,
}

