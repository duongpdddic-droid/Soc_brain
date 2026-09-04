#!/usr/bin/env node
// soc-brain-cockpit.mjs — Soc_brain: minimal read-only cockpit (SOC_BRAIN_COCKPIT_V0, Issue #33).
//
// Purpose: render ONE deterministic text/JSON view of the current task from
// canonical state only:
//   - the authoritative session record, read from the canonical control-plane
//     path (the same trusted pointer the broker MCP server behind
//     soc_broker_status is bound to: SOC_SESSION_PATH at
//     <stateDir>/sessions/<identityHash>.json);
//   - the worktree git facts the broker tools surface (soc_broker_status /
//     soc_broker_diff result objects, passed in verbatim by the caller).
//
// Read-only: the only IO this module performs is READING the session record
// file. It never writes, never runs git, never mutates state. State/lifecycle
// are rendered verbatim from the canonical record — no lifecycle state is
// invented or derived. Fail-closed: every export returns a result object and
// never throws into the caller. Secrets (lease tokens, digests) are never
// rendered. Node built-ins only; no dependencies.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOC_BRAIN_COCKPIT_VERSION = '0';

// Resolve the canonical session record path. Explicit input wins; otherwise the
// trusted control-plane pointer the broker status tool itself is bound to
// (SOC_SESSION_PATH). Never guessed from cwd or worktree files. Returns null
// when unavailable — the caller fails closed instead of fabricating a view.
export function resolveSessionPath({ sessionPath, env = process.env } = {}) {
  if (typeof sessionPath === 'string' && sessionPath.trim()) return sessionPath;
  const fromEnv = env && typeof env === 'object' ? env.SOC_SESSION_PATH : undefined;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv;
  return null;
}

// Read + parse the canonical session record. Read-only, fail-closed, no
// authority decisions (validation stays in packages/runtime-sandbox).
export function readSessionRecord(sessionPath) {
  if (typeof sessionPath !== 'string' || !sessionPath) {
    return { ok: false, reason: 'SESSION_PATH_MISSING' };
  }
  let raw;
  try { raw = fs.readFileSync(sessionPath, 'utf8'); }
  catch (e) { return { ok: false, reason: 'SESSION_READ_FAILED', detail: String((e && e.code) || e) }; }
  let session;
  try { session = JSON.parse(raw); }
  catch (e) { return { ok: false, reason: 'SESSION_PARSE_FAILED', detail: String((e && e.message) || e) }; }
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    return { ok: false, reason: 'SESSION_PARSE_FAILED', detail: 'Session record is not a JSON object.' };
  }
  return { ok: true, session, sessionPath };
}

// Broker status fact projection: entries verbatim (code+path) plus the bounded
// size flags the tool surfaces. Absent/malformed input -> null section.
function statusView(status) {
  if (!status || typeof status !== 'object') return null;
  const d = status.data && typeof status.data === 'object' ? status.data : {};
  return {
    ok: status.ok === true,
    reason: status.ok === true ? null : (status.reason ?? 'STATUS_UNAVAILABLE'),
    entries: Array.isArray(d.entries)
      ? d.entries.map((e) => ({ code: e && e.code != null ? String(e.code) : null, path: e && e.path != null ? String(e.path) : null }))
      : null,
    truncated: d.truncated === true,
    outputBytes: Number.isInteger(d.outputBytes) ? d.outputBytes : null,
  };
}

// Broker diff fact projection: bounded summary only (never the full diff body).
function diffView(diff) {
  if (!diff || typeof diff !== 'object') return null;
  const d = diff.data && typeof diff.data === 'object' ? diff.data : {};
  return {
    ok: diff.ok === true,
    reason: diff.ok === true ? null : (diff.reason ?? 'DIFF_UNAVAILABLE'),
    mode: diff.mode ?? null,
    truncated: d.truncated === true,
    outputBytes: Number.isInteger(d.outputBytes) ? d.outputBytes : null,
  };
}

// Render the cockpit view. Pure (no IO): deterministic given the same inputs —
// fixed key order, no clocks, no randomness. Renders ONLY what the canonical
// session record and broker results contain.
export function renderCockpit({ session, sessionPath, status, diff } = {}) {
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    const reason = 'SESSION_UNAVAILABLE';
    return {
      ok: false,
      reason,
      json: { cockpitVersion: SOC_BRAIN_COCKPIT_VERSION, kind: 'soc-brain-cockpit', ok: false, reason },
      text: `SOC_BRAIN_COCKPIT v${SOC_BRAIN_COCKPIT_VERSION} (read-only)\nsession: unavailable (${reason})\n`,
    };
  }
  const json = {
    cockpitVersion: SOC_BRAIN_COCKPIT_VERSION,
    kind: 'soc-brain-cockpit',
    ok: true,
    session: {
      path: sessionPath ?? (session.controlPlane && session.controlPlane.sessionPath) ?? null,
      schemaVersion: session.schemaVersion ?? null,
      state: session.state ?? null,
      taskId: session.taskId ?? null,
      repo: session.repo ?? null,
      issueNumber: session.issueNumber ?? null,
      baseSha: session.baseSha ?? null,
      branch: session.branch ?? null,
      headSha: session.headSha ?? null,
      worktreePath: session.worktreePath ?? null,
      capabilities: Array.isArray(session.capabilities) ? session.capabilities.slice() : null,
      lifecycle: Array.isArray(session.lifecycle)
        ? session.lifecycle.map((e) => ({
            event: e && e.event != null ? e.event : null,
            at: e && e.at != null ? e.at : null,
            detail: e && e.detail != null ? e.detail : null,
          }))
        : null,
    },
    worktree: {
      status: statusView(status),
      diff: diffView(diff),
    },
  };
  const s = json.session;
  const lines = [];
  lines.push(`SOC_BRAIN_COCKPIT v${SOC_BRAIN_COCKPIT_VERSION} (read-only)`);
  lines.push(`task: ${s.repo ?? '?'}#${s.issueNumber ?? '?'} state=${s.state ?? '?'}`);
  lines.push(`taskId: ${s.taskId ?? '?'}`);
  lines.push(`baseSha: ${s.baseSha ?? '?'}`);
  lines.push(`branch: ${s.branch ?? '?'}`);
  lines.push(`headSha: ${s.headSha ?? '?'}`);
  lines.push(`worktree: ${s.worktreePath ?? '?'}`);
  lines.push(`session: ${s.path ?? '?'}`);
  lines.push(`capabilities: ${Array.isArray(s.capabilities) ? s.capabilities.join(',') : '?'}`);
  lines.push('lifecycle:');
  if (s.lifecycle === null) lines.push('  (not recorded)');
  else if (s.lifecycle.length === 0) lines.push('  (empty)');
  else for (const e of s.lifecycle) lines.push(`  - ${e.event} ${e.at ?? ''} ${e.detail ?? ''}`.trimEnd());
  lines.push('worktree facts (broker tools):');
  const st = json.worktree.status;
  if (!st) lines.push('  status: (not provided)');
  else {
    lines.push(`  status: ${st.entries ? st.entries.length : '?'} entries (truncated=${st.truncated}, bytes=${st.outputBytes ?? '?'})`);
    if (st.entries) for (const en of st.entries) lines.push(`    ${en.code} ${en.path}`);
  }
  const df = json.worktree.diff;
  if (!df) lines.push('  diff: (not provided)');
  else lines.push(`  diff: mode=${df.mode ?? '?'} truncated=${df.truncated} bytes=${df.outputBytes ?? '?'}`);
  return { ok: true, json, text: `${lines.join('\n')}\n` };
}

// ---- CLI (read-only) -----------------------------------------------------------
// node soc-brain-cockpit.mjs [--json]
// Resolves the canonical session record via SOC_SESSION_PATH (the broker's own
// trusted pointer), reads it, renders the view. Exit 0 = rendered, 1 = the
// canonical session was unavailable (never fabricates a view).
function main(argv = process.argv.slice(2)) {
  const asJson = argv.includes('--json');
  const sessionPath = resolveSessionPath({});
  const loaded = sessionPath
    ? readSessionRecord(sessionPath)
    : { ok: false, reason: 'SESSION_PATH_MISSING' };
  const view = renderCockpit({
    session: loaded.ok ? loaded.session : null,
    sessionPath: loaded.ok ? loaded.sessionPath : sessionPath,
  });
  process.stdout.write(asJson ? `${JSON.stringify(view.json, null, 2)}\n` : view.text);
  process.exit(view.ok ? 0 : 1);
}

const isDirect = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirect) main();
