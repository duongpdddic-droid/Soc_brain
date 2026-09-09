#!/usr/bin/env node
// gh-refs.mjs — GitHub-backed Issue/PR title projection (Issue #136, steps 1+2).
//
// Presentation adapter ONLY: resolves real GitHub titles so the UI can show
// "Issue #N · <title>" / "PR #P → Issue #N · <title>". It NEVER invents
// titles: an unavailable index yields null and the UI falls back to
// `Issue #N` / `PR #N` verbatim. Titles never feed back into the control
// plane (read-only, display-only).
//
// Transport is injectable for tests (no network, no gh binary). Production
// transport shells out to `gh` (same CLI the canonical delivery chain uses)
// with a bounded timeout; failures degrade to nulls, never crashes.
//
// Local tasks (issueNumber >= 9_000_000) come from the local allocator and
// have no GitHub counterpart: isLocalTaskNumber() guards the lookup path in
// the control plane, so no gh call ever runs for them.

import { execFile as childExecFile } from 'node:child_process';

export const LOCAL_TASK_NUMBER_BASE = 9_000_000;
export const REFS_TTL_MS = 120_000; // 2 min: titles are stable; bounded gh load
const INDEX_LIMIT = '300'; // bounded batch size per gh call

export function isLocalTaskNumber(n) {
  return Number.isInteger(n) && n >= LOCAL_TASK_NUMBER_BASE;
}

function indexByNumber(rows) {
  const m = new Map();
  if (Array.isArray(rows)) {
    for (const r of rows) {
      if (r && Number.isInteger(r.number) && typeof r.title === 'string') m.set(r.number, r.title);
    }
  }
  return m;
}

// Pure projection from raw index rows -> { issueTitle, prTitle } (nulls when absent).
// prNumber is the canonical PR binding (session.prNumber); a PR title is only
// ever resolved through it — never guessed from the issue number.
export function resolveIssueRef({ index, issueNumber, prNumber } = {}) {
  const empty = { issueTitle: null, prTitle: null };
  if (!index || !index.issues || !index.prs) return empty;
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) return empty;
  return {
    issueTitle: index.issues.get(issueNumber) ?? null,
    prTitle: Number.isInteger(prNumber) && prNumber > 0 ? (index.prs.get(prNumber) ?? null) : null,
  };
}

// In-memory TTL cache, one index per repo. Injectable store for tests.
export function createRefsCache({ ttlMs = REFS_TTL_MS, maxEntries = 50, now = Date.now } = {}) {
  const store = new Map();
  async function ensure({ repo, listIssues, listPrs }) {
    if (typeof repo !== 'string' || !repo) return null;
    const hit = store.get(repo);
    if (hit && now() - hit.at < ttlMs) return hit;
    const entry = hit || { at: 0, issues: new Map(), prs: new Map() };
    // Fail-isolated batch fetch: a failed lookup keeps the previous index (or
    // empty maps) and is retried only after the TTL. No fabrication.
    const [issueRows, prRows] = await Promise.all([
      listIssues().catch(() => null),
      listPrs().catch(() => null),
    ]);
    if (Array.isArray(issueRows)) entry.issues = indexByNumber(issueRows);
    if (Array.isArray(prRows)) entry.prs = indexByNumber(prRows);
    entry.at = now();
    if (!store.has(repo) && store.size >= maxEntries) {
      const oldest = [...store.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) store.delete(oldest[0]);
    }
    store.set(repo, entry);
    return entry;
  }
  function peek(repo) { return store.get(repo) || null; }
  return { ensure, peek };
}

// Default production transport (bounded, fail-closed). Returns [] on any failure.
export function defaultGhList(args, { timeoutMs = 6000 } = {}) {
  return new Promise((resolve) => {
    childExecFile('gh', args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([]);
      try { resolve(JSON.parse(String(stdout || '[]'))); } catch { resolve([]); }
    });
  });
}

export function defaultListers() {
  return {
    listIssues: (repo) => defaultGhList(['issue', 'list', '--repo', repo, '--state', 'all', '--limit', INDEX_LIMIT, '--json', 'number,title']),
    listPrs: (repo) => defaultGhList(['pr', 'list', '--repo', repo, '--state', 'all', '--limit', INDEX_LIMIT, '--json', 'number,title']),
  };
}

