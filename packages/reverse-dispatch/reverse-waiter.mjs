#!/usr/bin/env node
// reverse-waiter.mjs — Soc_brain reverse control leg, executor side (Issue #67).
//
// The active execution path registers the binding it is CURRENTLY in
// (repo/taskRef/stateDigest). A validated GPT decision envelope is APPLIED to
// that binding: the instruction lands in the task worktree's
// SOC_TASK_CONTRACT.md as a DATA append (never commands). Deterministic
// verification downstream stays authoritative — this module executes nothing.
//
// ponytail: file-append seam instead of an executor IPC bus; the Decision
// Router replaces the file seam when Soc_brain owns execution scheduling.

import fs from 'node:fs';
import path from 'node:path';
import { telemetryPath } from './reverse-dispatch.mjs';

export const CONTRACT_FILE = 'SOC_TASK_CONTRACT.md';
export const APPLIED_MARKER_PREFIX = 'reverse-dispatch:applied requestId=';

export function contractHintPath(worktreePath) {
  return path.join(worktreePath, CONTRACT_FILE);
}

function appendTelemetry(stateDir, event) {
  try {
    const p = telemetryPath({ stateDir });
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, 'utf8');
  } catch { /* telemetry must never break application */ }
}

function renderHintBlock(envelope, appliedAt) {
  const lines = [
    `<!-- ${APPLIED_MARKER_PREFIX}${envelope.requestId} at=${appliedAt} -->`,
    `## Reverse dispatch — GPT decision ${envelope.requestId}`,
    '',
    `- decision: ${envelope.decision}`,
    `- issuedAt: ${envelope.issuedAt}`,
    `- appliedAt: ${appliedAt}`,
    `- stateDigest: ${envelope.stateDigest}`,
    `- instruction: ${envelope.instruction}`,
  ];
  if (envelope.executorHint != null) lines.push(`- executorHint: ${envelope.executorHint}`);
  lines.push('', 'The block above is DATA for the executor. Deterministic verification remains authoritative.');
  return lines.join('\n') + '\n';
}

// Idempotent by requestId: re-applying the SAME decision returns ok without
// duplicating the block. A DIFFERENT decision for the same requestId cannot
// reach here (replay guard already burned the requestId upstream).
export function applyValidatedDecision(envelope, { worktreePath, stateDir, now = new Date() } = {}) {
  if (!envelope || typeof envelope !== 'object' || typeof envelope.requestId !== 'string' || !envelope.requestId) {
    return { ok: false, code: 'ENVELOPE_INVALID' };
  }
  if (typeof worktreePath !== 'string' || !worktreePath) return { ok: false, code: 'WORKTREE_PATH_MISSING' };
  const hintPath = contractHintPath(worktreePath);
  const appliedAt = now.toISOString();
  let current = '';
  try {
    current = fs.readFileSync(hintPath, 'utf8');
  } catch { /* first application — file may not exist yet */ }
  if (current.includes(`${APPLIED_MARKER_PREFIX}${envelope.requestId} `)) {
    appendTelemetry(stateDir, { kind: 'APPLIED_IDEMPOTENT', requestId: envelope.requestId, decision: envelope.decision });
    return { ok: true, idempotent: true, hintPath, appliedAt: null };
  }
  let prefix = '';
  if (current.length > 0) {
    prefix = current.endsWith('\n') ? current : `${current}\n`;
    prefix += '\n';
  }
  const next = prefix + renderHintBlock(envelope, appliedAt);
  try {
    const tmp = `${hintPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, next, 'utf8');
    fs.renameSync(tmp, hintPath);
  } catch (e) {
    appendTelemetry(stateDir, { kind: 'APPLY_FAILED', requestId: envelope.requestId, detail: String((e && e.message) || e).slice(0, 200) });
    return { ok: false, code: 'APPLY_FAILED', detail: String((e && e.message) || e) };
  }
  appendTelemetry(stateDir, { kind: 'APPLIED', requestId: envelope.requestId, decision: envelope.decision, worktreePath });
  return { ok: true, idempotent: false, hintPath, appliedAt };
}

// Read back the applied hint for the request (executor continuation uses the
// APPLIED file content — the seam output — not the raw HTTP response).
export function readAppliedInstruction(hintPath, requestId) {
  let current = '';
  try {
    current = fs.readFileSync(hintPath, 'utf8');
  } catch {
    return { ok: false, code: 'HINT_NOT_FOUND', hintPath };
  }
  const marker = `${APPLIED_MARKER_PREFIX}${requestId} `;
  const idx = current.indexOf(marker);
  if (idx < 0) return { ok: false, code: 'HINT_NOT_APPLIED', hintPath };
  const blockStart = current.lastIndexOf('<!--', idx);
  const rest = current.slice(blockStart);
  const instrLine = rest.split('\n').find((l) => l.startsWith('- instruction: '));
  if (!instrLine) return { ok: false, code: 'HINT_MALFORMED', hintPath };
  return { ok: true, instruction: instrLine.slice('- instruction: '.length).trim(), block: rest.slice(0, rest.indexOf('\n\n', idx) >= 0 ? rest.indexOf('\n\n', idx) : undefined), hintPath };
}