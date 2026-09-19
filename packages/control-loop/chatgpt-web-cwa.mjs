#!/usr/bin/env node
// chatgpt-web-cwa.mjs — production final-review transport over the CWA
// browser-owned plane (Issue #148). Replaces ChatGPT Web CDP on the ControlLoop
// final-review critical path.
//
// Contract preserved verbatim: transport({ prompt }) ->
//   { ok:true, text, conversationId, modelSlug, canonicalRequestId }
//   | { ok:false, code, ... }
// The binding/identity semantics required by gpt-final-review.mjs
// (repository, issueNumber, pullRequestNumber, exact headSha, evidenceDigest,
// canonicalRequestId) are enforced CWA-side by the durable transport this
// module invokes; this module adds NO retry, NO CDP fallback, and NO
// authority: the reply is DATA, parsed strictly by gpt-final-review.mjs.
//
// Pre-write readiness (never a live review request as a version probe): the
// CWA runtime_readiness probe proves bridge liveness + the request-bound SSE
// identity authority module's load sentinel (bundle + freshness vs extension
// source mtimes). Not-proven -> FAIL_CLOSED before any write (liveWriteCount
// stays 0 on the CWA side because the CLI is never invoked).

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readSessionRecord } from '../runtime-sandbox/runtime-sandbox.mjs';

export const CWA_DEFAULT_EXTENSION_ID = 'kjfnkhajljnkbhikmfijcchenlfglaie';
export const CWA_DEFAULT_BUNDLE = 'worktree-cwa-main-test';

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function defaultRunner({ command, args, cwd, env, timeoutMs }) {
  const r = spawnSync(command, args, {
    encoding: 'utf8',
    cwd: cwd || undefined,
    env: { ...process.env, ...(env || {}) },
    timeout: timeoutMs,
  });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// CWA binding identity is read fresh per invocation: a rework round moves the
// session headSha, and the binding must pin the CURRENT exact head.
export function cwaBindingFromSession(session) {
  const repository = typeof session.repo === 'string' ? session.repo : null;
  const issueNumber = Number(session.issueNumber);
  const pullRequestNumber = Number(session.prNumber);
  const headSha = typeof session.headSha === 'string' ? session.headSha : null;
  const problems = [];
  if (!repository || !Number.isInteger(issueNumber) || issueNumber <= 0) {
    problems.push('CWA_BINDING_IDENTITY_MISSING');
  }
  if (!Number.isInteger(pullRequestNumber) || pullRequestNumber <= 0) {
    problems.push('CWA_BINDING_PR_MISSING');
  }
  if (typeof headSha !== 'string' || !/^[0-9a-f]{40}$/i.test(headSha)) {
    problems.push('CWA_BINDING_HEAD_MISSING');
  }
  return problems.length
    ? { ok: false, code: problems[0], detail: problems }
    : { ok: true, repository, issueNumber, pullRequestNumber, headSha: headSha.toLowerCase() };
}

export function createChatGptWebCwaTransport({
  sessionPath,
  storeDir = null,
  pythonExe = process.env.SOC_CWA_PYTHON || null,
  cwaRoot = process.env.SOC_CWA_ROOT || null,
  userData = process.env.SOC_CWA_USER_DATA || null,
  profileDirectory = process.env.SOC_CWA_PROFILE || null,
  extensionId = process.env.SOC_CWA_EXTENSION_ID || CWA_DEFAULT_EXTENSION_ID,
  bundle = process.env.SOC_CWA_BUNDLE || CWA_DEFAULT_BUNDLE,
  repairOnStale = process.env.SOC_CWA_REPAIR === '1',
  runner = defaultRunner,
  readinessTimeoutMs = 180000,
  submitTimeoutMs = 600000,
} = {}) {
  return async function transport({ prompt }) {
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return { ok: false, code: 'CWA_PROMPT_INVALID' };
    }
    if (!pythonExe || !cwaRoot) return { ok: false, code: 'CWA_TRANSPORT_UNCONFIGURED' };
    if (!userData || !profileDirectory) {
      return { ok: false, code: 'CWA_READINESS_UNCONFIGURED' };
    }
    const rs = readSessionRecord(sessionPath);
    if (!rs.ok) return { ok: false, code: 'CWA_SESSION_RECORD_UNREADABLE', detail: rs.reason ?? null };
    const binding = cwaBindingFromSession(rs.session);
    if (!binding.ok) return binding;

    const srcDir = path.join(cwaRoot, 'src');
    const env = {
      PYTHONPATH: process.env.PYTHONPATH
        ? `${srcDir}${path.delimiter}${process.env.PYTHONPATH}`
        : srcDir,
    };
    const store = storeDir || path.join(path.dirname(sessionPath), 'cwa-final-review');
    fs.mkdirSync(store, { recursive: true });

    // Deterministic pre-write readiness: deployed runtime identity read-back.
    // Modules are invoked via -m + PYTHONPATH so the package dir never lands
    // on sys.path[0] (chatgpt_web_adapter.types would shadow stdlib types).
    let ready;
    try {
      const args = [
        '-m', 'chatgpt_web_adapter.browser_runtime_readiness',
        '--user-data', userData,
        '--profile', profileDirectory,
        '--extension-id', extensionId,
        '--bundle', bundle,
      ];
      if (repairOnStale) args.push('--repair');
      const r = runner({ command: pythonExe, args, cwd: cwaRoot, env, timeoutMs: readinessTimeoutMs });
      ready = JSON.parse(r.stdout || '{}');
      ready.__exit = r.status;
    } catch (e) {
      return { ok: false, code: 'CWA_READINESS_PROBE_FAILED', error: String((e && e.message) || e) };
    }
    if (ready.ready !== true) {
      return { ok: false, code: 'CWA_RUNTIME_NOT_READY', detail: ready };
    }

    const promptFile = path.join(store, `prompt-${sha256Hex(prompt).slice(0, 16)}.txt`);
    fs.writeFileSync(promptFile, prompt, 'utf8');
    // Issue #169 identity v3 inputs. reviewAttemptId pins the review round of
    // THIS canonical request; the pre-submit conversation is the session's
    // expected conversation only when one already exists (a fresh final-review
    // conversation is bound CWA-side by the canonical sentinel). Both become
    // part of the IMMUTABLE CWA request identity — this module never recomputes
    // or mutates identity after the durable journal is PREPARED.
    const reviewAttemptId = String(
      process.env.SOC_CWA_REVIEW_ATTEMPT_ID
        || rs.session?.reviewAttemptId
        || rs.session?.controlPlane?.reviewAttemptId
        || '1'
    );
    let submit;
    try {
      const r = runner({
        command: pythonExe,
        args: [
          '-m', 'chatgpt_web_adapter.final_review_cli',
          'submit',
          '--store', store,
          '--prompt-file', promptFile,
          '--repo', binding.repository,
          '--issue', String(binding.issueNumber),
          '--pr', String(binding.pullRequestNumber),
          '--head-sha', binding.headSha,
          '--current-head-sha', binding.headSha,
          '--review-attempt-id', reviewAttemptId,
        ],
        cwd: cwaRoot,
        env,
        timeoutMs: submitTimeoutMs,
      });
      submit = JSON.parse(r.stdout || '{}');
      submit.__exit = r.status;
    } catch (e) {
      // Spawn boundary loss: the CWA durable journal makes any committed write
      // reconcilable by the NEXT call (idempotent continue) — never re-issue
      // blindly here.
      return { ok: false, code: 'CWA_TRANSPORT_SPAWN_FAILED', error: String((e && e.message) || e) };
    }
    if (submit.ok === true && typeof submit.replyText === 'string' && submit.replyText.trim()) {
      return {
        ok: true,
        text: submit.replyText,
        conversationId: submit.conversationId ?? null,
        modelSlug: submit.modelSlug ?? null,
        canonicalRequestId: submit.canonicalRequestId ?? null,
        identityAuthority: submit.sseConversationIdentityAuthority ?? null,
        state: submit.state ?? null,
      };
    }
    // Transaction-safe failure surface (Issue #169): the durable CWA journal
    // state and its retry/reconcile gates are DATA passed through to the
    // ControlLoop verbatim. This module owns NO retry: WRITE_FINALITY_UNKNOWN
    // and AMBIGUOUS stay fail-closed here; only a CWA-persisted
    // NO_WRITE_PROVEN reports safeToRetry, and reconcileRequired forbids any
    // resend until the CWA journal has decided the write finality.
    return {
      ok: false,
      code: submit.code || 'CWA_SUBMIT_FAILED',
      detail: submit,
      state: submit.state ?? null,
      safeToRetry: submit.safeToRetry === true,
      reconcileRequired: submit.reconcileRequired === true,
    };
  };
}

// Production transport selection — SUPERSEDED by the fixed provider
// invariant (AUTONOMOUS_DELIVERY_CONTRACT.md §2). The ONLY selector is
// packages/autonomous-delivery/final-review-provider.mjs
// (selectFixedFinalReviewTransport): Web2API-copy or fail-closed. This legacy
// entry is kept for signature compatibility and ALWAYS refuses: executors
// cannot choose CWA, combine transports, or silently fallback. Callers must
// migrate to the fixed selector.
export function selectGptTransport({ env = process.env } = {}) {
  const flag = env && env.SOC_FINAL_REVIEW_PROVIDER;
  if (flag === 'chatgpt-plus-web2api-copy') {
    return { name: 'refused-use-fixed-selector', transport: null, code: 'FINAL_REVIEW_USE_FIXED_SELECTOR' };
  }
  return { name: 'none', transport: null, code: 'FINAL_REVIEW_PROVIDER_MISMATCH' };
}
// end of chatgpt-web-cwa.mjs — no trailing marker.
