#!/usr/bin/env node
// opencode-permission.mjs — Soc_brain: OpenCode permission-event normalization
// + fail-closed decision mapping (the seam between OpenCode permission events
// and the Soc_brain permission-orchestration verdict model).
//
// Ported (Node/ESM adaptation) from Omnigent
// (https://github.com/omnigent-ai/omnigent)
// omnigent/harnesses/opencode_native/permissions.py @
// 12a0d5c8737571980b84869c2df00b17d0b42c9b.
// Copyright (2026) Databricks, Inc. Licensed under the Apache License 2.0.
//
// Why this exists (proven gap): Soc_brain's permission-orchestration engine
// takes canonical operation kinds, but nothing normalized OpenCode's raw
// permission-event shapes (v1 `permission.asked` / v2 `permission.v2.asked`)
// into that vocabulary. Reading only `action`/`type` left v1's `permission`
// field (the actual tool category) unread — upstream evidence: every tool
// reached the policy engine as the literal name "permission" and matched no
// policy. This module fixes that seam and keeps the fail-closed contract:
//   - unmapped/absent verdicts -> "ask" (no automatic reply);
//   - the reply token "always" is NEVER produced (OpenCode would persist it
//     into its local approved ruleset and stop re-asking, silently bypassing
//     the Soc_brain policy engine mid-session).
//
// Pure: no I/O. Node >= 22.

export const OPENCODE_PERMISSION_HARNESS = 'opencode-native';

// Normalized decisions (upstream PolicyDecision vocabulary).
export const PERMISSION_DECISION = Object.freeze({
  ALLOW_ONCE: 'allow_once',
  ALLOW_ALWAYS: 'allow_always',
  REJECT: 'reject',
  ASK: 'ask',
});

// OpenCode's accepted reply tokens (only these three are legal on the wire).
export const OPENCODE_REPLY = Object.freeze({
  ONCE: 'once',
  ALWAYS: 'always',
  REJECT: 'reject',
});

// Canonical operation kinds (packages/permission-orchestration vocabulary).
// OpenCode tool/category names are mapped here, never restated in the engine.
const TOOL_KIND_MAP = Object.freeze({
  bash: 'bash',
  shell: 'shell',
  command: 'command',
  edit: 'edit',
  write: 'write',
  read: 'read',
  glob: 'read',
  grep: 'read',
  list: 'read',
  webfetch: 'webfetch',
  websearch: 'webfetch',
  task: 'command',
  skill: 'command',
  external_directory: 'external_directory',
});

// Map an OpenCode permission action/tool/category to a canonical operation
// kind for permission-orchestration. Unknown -> null (the caller must treat
// null as BLOCKED_HUMAN_GATE via the engine's UNKNOWN_RULE; never allow).
export function mapActionToOperationKind(action) {
  if (typeof action !== 'string' || !action) return null;
  return TOOL_KIND_MAP[action] || null;
}

// ---- parse (port of parse_permission_request) ---------------------------------
// Accepts BOTH OpenCode permission event shapes (live-verified upstream
// against 1.17.7, which emits v1 `permission.asked`):
//   v1 (`permission.asked`): {id, sessionID, permission, patterns,
//     metadata, always, tool} — tool/category in `permission`, resources are
//     string `patterns`.
//   v2 (`permission.v2.asked`): {id, sessionID, action, resources, save,
//     metadata, source} — category in `action`.
// The category MUST be extracted (it becomes the policy-evaluation tool
// name); resources fall back v2 `resources` -> v1 `patterns`.
// Returns null when no request id is present (never throws, never guesses).
export function parsePermissionRequest(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const requestId = payload.id || payload.requestID || payload.request_id;
  if (typeof requestId !== 'string' || !requestId) return null;
  const sessionIdRaw = payload.sessionID || payload.session_id;
  const actionRaw = payload.action || payload.type || payload.permission;
  const resourcesRaw = payload.resources || payload.patterns;
  const metadataRaw = payload.metadata;
  const sourceRaw = payload.source;
  const metadata = (metadataRaw && typeof metadataRaw === 'object' && !Array.isArray(metadataRaw))
    ? { ...metadataRaw } // own enumerable string keys only (Object.entries keys are always strings)
    : {};
  return {
    requestId,
    sessionId: typeof sessionIdRaw === 'string' ? sessionIdRaw : null,
    action: typeof actionRaw === 'string' ? actionRaw : null,
    resources: Array.isArray(resourcesRaw) ? resourcesRaw.slice() : [],
    metadata,
    source: typeof sourceRaw === 'string' ? sourceRaw : null,
    raw: { ...payload },
  };
}

// ---- resource extraction (port of _extract_resource_fields) --------------------
// Pull concrete command/path/url out of a request's resources + metadata so
// policy can reason about the operation. Each field is null when absent.
export function extractResourceFields(request) {
  const req = request && typeof request === 'object' ? request : {};
  const candidates = [req.metadata];
  if (Array.isArray(req.resources)) {
    for (const r of req.resources) if (r && typeof r === 'object' && !Array.isArray(r)) candidates.push(r);
  }
  let command = null; let pathValue = null; let url = null;
  for (const src of candidates) {
    if (!src || typeof src !== 'object') continue;
    if (command === null && typeof src.command === 'string' && src.command) command = src.command;
    if (pathValue === null) {
      const p = src.path || src.filePath || src.file;
      if (typeof p === 'string' && p) pathValue = p;
    }
    if (url === null && typeof src.url === 'string' && src.url) url = src.url;
  }
  return { command, path: pathValue, url };
}

// ---- target enumeration (RV1: evaluate EVERY concrete target) -------------------
// One adjudicated reply covers the WHOLE payload, so every concrete target the
// request names must be evaluated — a single reply may never ride along on a
// co-target's ALLOW. Sources: every resource object (the actual operands) and
// the request metadata (descriptive context — it must NEVER shadow a resource
// target). String patterns are ambiguous (glob vs path): they never become a
// concrete path, and an uncovered one keeps the request unverifiable (ask).
export function extractPermissionTargets(request) {
  const req = request && typeof request === 'object' ? request : {};
  const paths = [];
  const addPath = (p) => { if (typeof p === 'string' && p && !paths.includes(p)) paths.push(p); };
  const pathOf = (src) => {
    if (!src || typeof src !== 'object' || Array.isArray(src)) return null;
    const p = src.path || src.filePath || src.file;
    return (typeof p === 'string' && p) ? p : null;
  };
  // Resources first (operands), metadata last (context) — ordering never
  // matters for the verdict (all are evaluated), only for `paths[0]` reads.
  if (Array.isArray(req.resources)) {
    for (const r of req.resources) addPath(pathOf(r));
  }
  addPath(pathOf(req.metadata));
  const ambiguous = [];
  if (Array.isArray(req.resources)) {
    for (const r of req.resources) {
      if (typeof r === 'string' && r && !paths.includes(r) && !ambiguous.includes(r)) ambiguous.push(r);
    }
  }
  return { paths, ambiguous };
}

// ---- normalize for policy (port of normalize_for_policy) ------------------------
// Flat policy-evaluation input: action + concrete command/path/url + binding
// facts. Soc_brain identity comes from the caller's verified session chain.
export function normalizeForPolicy(request, { identityHash = null, executionRoot = null } = {}) {
  const req = request && typeof request === 'object' ? request : {};
  const { command, path: pathValue, url } = extractResourceFields(req);
  return {
    harness: OPENCODE_PERMISSION_HARNESS,
    action: req.action || null,
    operationKind: mapActionToOperationKind(req.action),
    command,
    path: pathValue,
    url,
    executionRoot,
    identityHash,
    requestId: req.requestId || null,
    sessionId: req.sessionId || null,
    metadata: (req.metadata && typeof req.metadata === 'object') ? { ...req.metadata } : {},
  };
}

// ---- verdict mapping (port of map_verdict_to_decision) ---------------------------
// Recognizes {"decision":...} / {"action":...} / {"verdict":...} shapes and a
// bare string. Anything unrecognized -> "ask" (fail closed: a human decision
// is required before any reply). NEVER throws.
export function mapVerdictToDecision(verdict) {
  let raw = null;
  if (typeof verdict === 'string') raw = verdict;
  else if (verdict && typeof verdict === 'object' && !Array.isArray(verdict)) {
    raw = verdict.decision ?? verdict.action ?? verdict.verdict ?? null;
  }
  const token = raw === null || raw === undefined ? '' : String(raw).trim().toLowerCase();
  if (['allow_always', 'always', 'allow-always'].includes(token)) return PERMISSION_DECISION.ALLOW_ALWAYS;
  if (['allow', 'allow_once', 'approve', 'allowed', 'accept'].includes(token)) return PERMISSION_DECISION.ALLOW_ONCE;
  if (['deny', 'reject', 'block', 'blocked', 'denied'].includes(token)) return PERMISSION_DECISION.REJECT;
  return PERMISSION_DECISION.ASK;
}

// Map a permission-orchestration OP_OUTCOME verdict onto the normalized
// decision vocabulary. Soc_brain-specific adapter over mapVerdictToDecision:
// ALLOW -> allow_once; DENY_AND_RECOVER -> reject (the reroute happens at the
// operation layer, never as a permission reply); BLOCKED_HUMAN_GATE -> ask.
export function outcomeToDecision(outcome) {
  if (outcome === 'ALLOW') return PERMISSION_DECISION.ALLOW_ONCE;
  if (outcome === 'DENY_AND_RECOVER') return PERMISSION_DECISION.REJECT;
  return PERMISSION_DECISION.ASK;
}

// ---- reply mapping (port of decision_to_reply) -----------------------------------
// "always" is NEVER returned (upstream rationale, preserved): OpenCode
// persists an "always" reply into its local approved ruleset and then
// auto-allows every future matching tool WITHOUT re-emitting the permission
// event, which bypasses the Soc_brain policy engine and makes live policy
// changes unenforceable. Both allow_once and allow_always reply "once";
// ask -> null (no automatic reply — a human must decide).
export function decisionToReply(decision) {
  if (decision === PERMISSION_DECISION.ALLOW_ONCE || decision === PERMISSION_DECISION.ALLOW_ALWAYS) {
    return OPENCODE_REPLY.ONCE;
  }
  if (decision === PERMISSION_DECISION.REJECT) return OPENCODE_REPLY.REJECT;
  return null;
}

// Wire body for POST /permission/{requestID}/reply (port of reply_body).
// FAIL CLOSED: only single-shot tokens are wire-legal from this module.
// "always" is NEVER emitted here even though OpenCode accepts it on the
// wire — replying "always" persists a vendor-side auto-allow that bypasses
// the control-plane verdict engine (see decision_to_reply rationale).
export function replyBody(reply, { message = null } = {}) {
  if (reply !== OPENCODE_REPLY.ONCE && reply !== OPENCODE_REPLY.REJECT) {
    return null; // fail closed: never emit an unknown/"always" reply token
  }
  const body = { reply };
  if (message !== null && message !== undefined) body.message = String(message);
  return body;
}

// ---- one-shot convenience seam ------------------------------------------------------
// Parse + normalize + decide + map to a reply in one call, fail-closed end to
// end. `guard` is injected by the caller (permission-orchestration)
// to avoid a package cycle; when absent, every outcome degrades to ask/null.
// Severity order for combining per-target verdicts: the SINGLE reply covering
// the whole payload takes the most restrictive verdict of every evaluated
// target — DENY_AND_RECOVER (reject) > BLOCKED_HUMAN_GATE (ask) > ALLOW.
// An unknown verdict or a throwing guard maps to BLOCKED_HUMAN_GATE (fail
// closed: a broken authority evaluation can never widen the reply).
const VERDICT_RANK = Object.freeze({ ALLOW: 0, BLOCKED_HUMAN_GATE: 1, DENY_AND_RECOVER: 2 });
const RANK_NAME = Object.freeze(['ALLOW', 'BLOCKED_HUMAN_GATE', 'DENY_AND_RECOVER']);

export function adjudicatePermissionRequest(payload, {
  identityHash = null,
  executionRoot = null,
  primaryCheckout = null,
  worktreesRoot = null,
  guard = null,
} = {}) {
  const request = parsePermissionRequest(payload);
  if (!request) {
    return { ok: false, reason: 'PERMISSION_REQUEST_INVALID', decision: PERMISSION_DECISION.ASK, reply: null };
  }
  const policy = normalizeForPolicy(request, { identityHash, executionRoot });
  // RV1: evaluate EVERY concrete target (metadata never shadows a resource);
  // with no concrete target a single null-path evaluation still re-derives
  // authority (a path-sensitive op then fails closed via MISSING -> gate).
  const { paths, ambiguous } = extractPermissionTargets(request);
  let outcome = 'BLOCKED_HUMAN_GATE'; // default fail-closed (no guard)
  if (typeof guard === 'function') {
    let combined = null; // rank, null = no evaluation yet
    const targets = paths.length > 0 ? paths : [null];
    for (const targetPath of targets) {
      let rank;
      try {
        const v = guard({
          operation: policy.operationKind || 'permission',
          kind: policy.operationKind,
          targetPath,
          executionRoot,
          primaryCheckout,
          worktreesRoot,
        });
        const verdict = v && typeof v.verdict === 'string' ? v.verdict : null;
        rank = VERDICT_RANK[verdict] === undefined ? 1 : VERDICT_RANK[verdict]; // unknown -> gate
      } catch {
        combined = combined === null ? 1 : Math.max(combined, 1);
        break; // broken authority evaluation: fail closed, no further target
      }
      combined = combined === null ? rank : Math.max(combined, rank);
      // NOTE: no early exit — EVERY concrete target is evaluated (the reply
      // covers the whole payload), the combination only keeps the most
      // restrictive verdict.
    }
    outcome = RANK_NAME[combined === null ? 1 : combined];
  }
  // An uncovered string pattern names a target nobody classified: never allow
  // on partial knowledge — downgrade to the human gate (ask). Applies only
  // when concrete targets were evaluated; with none, the guard's null-path
  // verdict already fail-closed every path-sensitive operation.
  if (outcome === 'ALLOW' && paths.length > 0 && ambiguous.length > 0) {
    outcome = 'BLOCKED_HUMAN_GATE';
  }
  const decision = outcomeToDecision(outcome);
  const reply = decisionToReply(decision);
  return {
    ok: true,
    request,
    policy,
    outcome,
    decision,
    reply,
    replyBody: reply ? replyBody(reply) : null,
    targets: paths.slice(),
    ambiguousTargets: ambiguous.slice(),
  };
}
