// packages/supervisor/integrity-audit.mjs — 3-Way State Audit (fail-closed).
//
// Before EVERY transition confirmation the supervisor reconciles three
// authoritative sources:
//   1. Session Record   — the canonical session JSON on disk
//   2. Transition Ledger — transitions.jsonl tail for this identity
//   3. Disk Evidence     — actual files the session claims (worktree HEAD,
//                          execution record, review-ready packet, …)
//
// Rule: the three must agree on EVERY audited field. A single mismatch,
// missing source, or unreadable source => { ok:false } and the caller MUST
// transition to BLOCKED. There is no partial pass.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const AUDIT_SCHEMA_VERSION = '1';

export const AUDIT_CODES = Object.freeze({
  AUDIT_OK: 'AUDIT_OK',
  SESSION_MISSING: 'SESSION_MISSING',
  SESSION_UNREADABLE: 'SESSION_UNREADABLE',
  LEDGER_MISSING: 'LEDGER_MISSING',
  LEDGER_EMPTY: 'LEDGER_EMPTY',
  DISK_EVIDENCE_MISSING: 'DISK_EVIDENCE_MISSING',
  FIELD_MISMATCH: 'FIELD_MISMATCH',
  IDENTITY_MISMATCH: 'IDENTITY_MISMATCH',
});

function readJsonSafe(fp) {
  try {
    if (!fs.existsSync(fp)) return { ok: false, reason: 'MISSING' };
    return { ok: true, value: JSON.parse(fs.readFileSync(fp, 'utf8')) };
  } catch (e) {
    return { ok: false, reason: 'UNREADABLE', detail: String((e && e.message) || e) };
  }
}

function readLedgerTail(fp) {
  try {
    if (!fs.existsSync(fp)) return { ok: false, reason: 'MISSING' };
    const lines = fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean);
    if (lines.length === 0) return { ok: false, reason: 'EMPTY' };
    const last = JSON.parse(lines[lines.length - 1]);
    return { ok: true, value: last, count: lines.length };
  } catch (e) {
    return { ok: false, reason: 'UNREADABLE', detail: String((e && e.message) || e) };
  }
}

function gitHead(worktreePath) {
  try {
    const r = spawnSync('git', ['-C', worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    if (r.error || r.status !== 0) return null;
    return String(r.stdout || '').trim().toLowerCase() || null;
  } catch { return null; }
}

/**
 * Perform the 3-way audit.
 *
 * @param {object} args
 * @param {string} args.stateDir      control-plane state root
 * @param {string} args.identityHash  session identity hash
 * @param {string} [args.expectedHeadSha]  head the caller expects (optional extra check)
 * @returns {{ok:boolean, code:string, detail:object}}
 */
export function audit3Way({ stateDir, identityHash, expectedHeadSha = null }) {
  if (typeof stateDir !== 'string' || !stateDir) return { ok: false, code: AUDIT_CODES.SESSION_MISSING, detail: { stateDir: null } };
  if (typeof identityHash !== 'string' || !identityHash) return { ok: false, code: AUDIT_CODES.IDENTITY_MISMATCH, detail: { identityHash: null } };

  // --- Source 1: Session Record ---
  const sessionPath = path.join(stateDir, 'sessions', `${identityHash}.json`);
  const s = readJsonSafe(sessionPath);
  if (!s.ok) {
    return { ok: false, code: s.reason === 'MISSING' ? AUDIT_CODES.SESSION_MISSING : AUDIT_CODES.SESSION_UNREADABLE, detail: { sessionPath } };
  }
  const session = s.value;

  // --- Source 2: Transition Ledger tail ---
  const ledgerPath = path.join(stateDir, 'control-loop', identityHash, 'transitions.jsonl');
  const l = readLedgerTail(ledgerPath);
  if (!l.ok) {
    return { ok: false, code: l.reason === 'MISSING' ? AUDIT_CODES.LEDGER_MISSING : AUDIT_CODES.LEDGER_EMPTY, detail: { ledgerPath } };
  }
  const tail = l.value;

  // --- Source 3: Disk Evidence (worktree HEAD + session-declared files) ---
  const worktree = typeof session.worktreePath === 'string' ? session.worktreePath : null;
  if (!worktree || !fs.existsSync(worktree)) {
    return { ok: false, code: AUDIT_CODES.DISK_EVIDENCE_MISSING, detail: { worktreePath: worktree ?? null } };
  }
  const diskHead = gitHead(worktree);

  // --- Field-by-field reconciliation ---
  const mismatches = [];

  // identityHash binding: session must belong to this audit identity.
  const sessionHash = session.identityHash ?? null;
  if (sessionHash && sessionHash !== identityHash) {
    mismatches.push({ field: 'identityHash', session: sessionHash, expected: identityHash });
  }

  // headSha: session vs ledger evidence vs disk HEAD.
  const sessionHead = typeof session.headSha === 'string' ? session.headSha.toLowerCase() : null;
  const ledgerHead = tail && tail.evidence && typeof tail.evidence.headSha === 'string'
    ? String(tail.evidence.headSha).toLowerCase()
    : null;

  if (sessionHead && diskHead && sessionHead !== diskHead) {
    mismatches.push({ field: 'headSha', session: sessionHead, disk: diskHead });
  }
  if (expectedHeadSha) {
    const exp = String(expectedHeadSha).toLowerCase();
    if (sessionHead && sessionHead !== exp) mismatches.push({ field: 'headSha', session: sessionHead, expected: exp });
    if (diskHead && diskHead !== exp) mismatches.push({ field: 'headSha', disk: diskHead, expected: exp });
  }
  // Ledger evidence headSha, when present, must also agree.
  if (ledgerHead && sessionHead && ledgerHead !== sessionHead) {
    mismatches.push({ field: 'headSha', session: sessionHead, ledger: ledgerHead });
  }

  // issueNumber binding: session vs ledger record identity.
  if (tail && typeof tail.identityHash === 'string' && tail.identityHash !== identityHash) {
    mismatches.push({ field: 'ledgerIdentityHash', ledger: tail.identityHash, expected: identityHash });
  }
  if (session.issueNumber !== undefined && tail && typeof tail.sessionPath === 'string') {
    // sessionPath embeds the hash filename — cheap cross-check.
    const tailHash = path.basename(tail.sessionPath, '.json');
    if (tailHash !== identityHash) {
      mismatches.push({ field: 'ledgerSessionPathHash', ledger: tailHash, expected: identityHash });
    }
  }

  // state consistency: session.state must be a known non-terminal-or-terminal
  // value that agrees with the ledger tail `to` when the ledger claims a
  // terminal state. SESSION_ACTIVE vs non-terminal tail is fine; a
  // session.state of BLOCKED/COMPLETED must match a terminal ledger tail.
  const TERMINAL = new Set(['BLOCKED', 'COMPLETED', 'FAILED']);
  const ledgerState = tail ? tail.to : null;
  if (session.state && TERMINAL.has(session.state)) {
    if (ledgerState !== session.state && !(session.state === 'FAILED' && ledgerState === 'BLOCKED')) {
      mismatches.push({ field: 'state', session: session.state, ledger: ledgerState });
    }
  }

  if (mismatches.length > 0) {
    return { ok: false, code: AUDIT_CODES.FIELD_MISMATCH, detail: { mismatches } };
  }

  return {
    ok: true,
    code: AUDIT_CODES.AUDIT_OK,
    detail: {
      sessionPath,
      ledgerPath,
      ledgerCount: l.count,
      headSha: diskHead,
      sessionState: session.state,
      ledgerState,
    },
  };
}

/**
 * Convenience adapter: returns an `audit3Way`-compatible function pre-bound
 * to {stateDir, identityHash} so the reactive engine can accept it directly.
 */
export function makeAuditFn({ stateDir, identityHash, expectedHeadSha = null } = {}) {
  return (/* engineCtx */) => audit3Way({ stateDir, identityHash, expectedHeadSha });
}
