#!/usr/bin/env node
// capability-declaration.mjs — Soc_brain: declarative executor capability
// model with tri-state verification (DECLARED / VERIFIED / UNKNOWN).
//
// Ported (Node/ESM adaptation) from Omnigent
// (https://github.com/omnigent-ai/omnigent)
// omnigent/harness_capabilities.py @ 12a0d5c8737571980b84869c2df00b17d0b42c9b.
// Copyright (2026) Databricks, Inc. Licensed under the Apache License 2.0.
//
// Why this exists (proven gap): Soc_brain had no declared-shape answer to
// "what can this executor do?" — only `evaluateCodingCapabilities` (a binary
// allow/missing check on the worktree permission projection) and a
// diagnostic-only version probe. Feature questions (steering, live queue,
// images, compaction) had nowhere to live, and there was no vocabulary to
// separate a CLAIM from PROVEN behavior.
//
// Core invariants (ported semantics):
//   - A capability field is `null` when nothing is claimed => status UNKNOWN.
//     UNKNOWN is never silently upgraded or downgraded.
//   - A boolean field is a DECLARED claim. Declaring is NOT verifying:
//     status stays DECLARED until a live probe supplies evidence.
//   - Status becomes VERIFIED ONLY from explicit probe evidence with
//     proven===true. A declaration is NEVER auto-VERIFIED (mocks, tests,
//     or caller assertion do not count — the evidence object must come from
//     a real probe call site such as probeOpenCodeCapabilities).
//   - When probe evidence contradicts the declaration (observed !==
//     declared), the status stays DECLARED and `drift` is flagged — the
//     declaration is reported, not rewritten (fail-closed reporting).
//
// Pure: no I/O except the explicit version probe helper (injectable
// spawnSync). No framework. Node >= 22.

import { spawnSync as nodeSpawnSync } from 'node:child_process';

// ---- tri-state vocabulary ----------------------------------------------------
// VERIFIED: declared AND live-probe-proven. DECLARED: claimed, unproven (or
// drifted). UNKNOWN: no claim, invalid claim, or no usable evidence.
export const CAPABILITY_STATUS = Object.freeze({
  VERIFIED: 'VERIFIED',
  DECLARED: 'DECLARED',
  UNKNOWN: 'UNKNOWN',
});

// Declared-value vocabulary (subset of the Omnigent axes that make sense for
// Soc_brain's single, control-plane-owned executor path). Values mirror the
// upstream strings so cross-repo reads stay comparable.
export const IntegrationMode = Object.freeze({
  CLI_SUBPROCESS: 'cli-subprocess', // `opencode run` one-shot subprocess (Soc_brain today)
});
export const Elicitation = Object.freeze({
  NONE: 'none', // headless: permission policy is pre-projected into opencode.json
});
export const Resume = Object.freeze({
  COLD_ONLY: 'cold-only', // `opencode run` has no warm session reattach
});
export const InstructionDelivery = Object.freeze({
  NOT_DELIVERED: 'not-delivered',
  UNKNOWN: 'unknown',
});

// ---- the declared record (frozen; declaration only, never verification) ------
// Mirrors HarnessCapabilities.as_dict(). `null` = no claim = UNKNOWN.
// Claims here are structural facts of the current Soc_brain executor path:
//   - integrationMode cli-subprocess: buildLaunchArgv builds an `opencode run`
//     argv; executor-launcher spawns it shell-less.
//   - elicitation none: the worktree opencode.json projection pins explicit
//     allow keys and has no ask keys (0 prompts by construction; enforced by
//     the launch preflight).
//   - interrupt true: the subprocess can be terminated mid-turn by the
//     control plane (terminateAndProveCleanup).
//   - streaming true: `--format json` emits NDJSON per-part events.
//   - steering/liveQueue/images/compaction: no claim => null => UNKNOWN.
//     (Mid-turn queue is explicitly NOT steering: `opencode run` accepts one
//     instruction per process; do not infer either capability from the other.)
export const OPENCODE_CLI_EXECUTOR_CAPABILITIES = Object.freeze({
  integrationMode: IntegrationMode.CLI_SUBPROCESS,
  elicitation: Elicitation.NONE,
  resume: Resume.COLD_ONLY,
  modelFamily: 'multi',
  auth: 'own-auth',
  subagents: true,
  interrupt: true,
  streaming: true,
  steering: null,
  liveQueue: null,
  images: null,
  compaction: null,
  instructionDelivery: InstructionDelivery.UNKNOWN,
});

// The axes reported in the capability report (declaration -> status map).
export const CAPABILITY_AXES = Object.freeze([
  'integrationMode', 'elicitation', 'resume', 'modelFamily', 'auth',
  'subagents', 'interrupt', 'streaming',
  'steering', 'liveQueue', 'images', 'compaction', 'instructionDelivery',
]);

// ---- probe evidence shape -----------------------------------------------------
// A probe returns { proven, observed?, ...diagnostics }. `proven:true` means
// the probe actually ran and established the observed fact. `proven:false`
// means the probe ran and could NOT establish it (e.g. version probe failed).
// Absence of evidence is UNKNOWN; a contradicted claim is DECLARED + drift.
function validEvidence(e) {
  return !!e && typeof e === 'object' && !Array.isArray(e)
    && (e.proven === true || e.proven === false);
}

// Resolve ONE axis: declared value + optional probe evidence -> status.
// Pure. Never throws. The tri-state rules above are the whole contract.
export function resolveCapabilityStatus(declared, evidence) {
  if (declared === null || declared === undefined) {
    // No claim: UNKNOWN regardless of evidence (a probe cannot verify a
    // claim that was never made).
    return { declared: null, status: CAPABILITY_STATUS.UNKNOWN, drift: false };
  }
  if (typeof declared !== 'boolean' && typeof declared !== 'string') {
    // Invalid declaration shape: fail closed to UNKNOWN (reported, not fixed).
    return { declared: null, status: CAPABILITY_STATUS.UNKNOWN, drift: false, reason: 'INVALID_DECLARATION' };
  }
  if (!validEvidence(evidence)) {
    return { declared, status: CAPABILITY_STATUS.DECLARED, drift: false };
  }
  const observed = typeof evidence.observed === 'boolean' ? evidence.observed : undefined;
  if (evidence.proven === true) {
    // `observed` is the probe's BOOLEAN verdict on the claim (true = the
    // probe confirmed the claim holds, false = it refuted it) — not a
    // reproduction of a string-enum declared value. A non-boolean claim
    // (e.g. 'cli-subprocess') is affirmed by observed:true.
    const claimTruth = typeof declared === 'boolean' ? declared : true;
    if (observed === claimTruth) {
      return { declared, status: CAPABILITY_STATUS.VERIFIED, drift: false };
    }
    if (observed !== undefined) {
      // Probed, ran fine, and the observation CONTRADICTS the claim: the
      // claim is NOT verified — it stays DECLARED with drift flagged
      // (fail-closed reporting: never upgrade on contradiction).
      return { declared, status: CAPABILITY_STATUS.DECLARED, drift: true };
    }
    // Proven probe without an observed verdict: nothing was established
    // about the claim, so it is not verified (and not rewritten either).
    return { declared, status: CAPABILITY_STATUS.DECLARED, drift: false, probeFailed: true };
  }
  // Probed but unproven: the claim is NOT verified and NOT rewritten.
  return { declared, status: CAPABILITY_STATUS.DECLARED, drift: false, probeFailed: true };
}

// Build the full per-axis capability report: { axis: { declared, status,
// drift } }. `probes` maps axis -> probe evidence (only axes with evidence
// can reach VERIFIED). Pure.
export function capabilityReport(capabilities = OPENCODE_CLI_EXECUTOR_CAPABILITIES, probes = {}) {
  const report = {};
  for (const axis of CAPABILITY_AXES) {
    const declared = capabilities && typeof capabilities === 'object' ? capabilities[axis] : undefined;
    report[axis] = resolveCapabilityStatus(declared, probes[axis]);
  }
  return report;
}

// JSON-serializable view (port of HarnessCapabilities.as_dict()): declared
// values only — status/drift live in capabilityReport, keeping the declared
// record and the verification record separable.
export function capabilitiesAsDict(capabilities = OPENCODE_CLI_EXECUTOR_CAPABILITIES) {
  const out = {};
  for (const axis of CAPABILITY_AXES) {
    const v = capabilities && typeof capabilities === 'object' ? capabilities[axis] : undefined;
    out[axis] = v === undefined ? null : v;
  }
  return out;
}

// ---- live probe (the ONLY path to VERIFIED) -----------------------------------
// Probes the resolved OpenCode executable with `--version` (the cheapest real
// signal that the cli-subprocess path exists and runs). The probe only ever
// VERIFIES what a successful run can establish: version parseable + inside
// the supported window. A failed/unparseable probe yields proven:false and
// the declaration stays DECLARED (fail-closed: never upgrade on failure,
// never downgrade the claim either).
export const OPENCODE_SUPPORTED_MIN_VERSION = '1.17.7';
export const OPENCODE_SUPPORTED_MAX_VERSION_EXCLUSIVE = '1.19.0';

export function parseSemver(v) {
  const m = String(v || '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function versionInSupportedWindow(v) {
  const cur = parseSemver(v);
  const min = parseSemver(OPENCODE_SUPPORTED_MIN_VERSION);
  const max = parseSemver(OPENCODE_SUPPORTED_MAX_VERSION_EXCLUSIVE);
  if (!cur || !min || !max) return false;
  const cmp = (a, b) => (a.major - b.major) || (a.minor - b.minor) || (a.patch - b.patch);
  return cmp(cur, min) >= 0 && cmp(cur, max) < 0;
}

// Real probe against the executable. Returns per-axis probe evidence; the
// ONLY evidence shape that can produce VERIFIED. Injectable spawnSync for
// tests, but note: evidence produced by an injected spawn is still explicit
// evidence AT THE CALL SITE — callers must never fabricate `proven:true`
// objects from mock data (that is the auto-VERIFY hole this port closes).
export function probeOpenCodeCapabilities({ executable, spawnSync = nodeSpawnSync } = {}) {
  const probes = {};
  if (typeof executable !== 'string' || !executable) {
    return { ok: false, probes, detail: 'executable path required' };
  }
  let version = null;
  let proven = false;
  let error = null;
  try {
    const r = spawnSync(executable, ['--version'], { timeout: 10000, windowsHide: true, encoding: 'utf8' });
    const m = String((r && r.stdout) || '').match(/(\d+\.\d+\.\d+)/);
    if (m && r && !r.error) { version = m[1]; proven = true; }
    else error = 'version output not parseable';
  } catch (e) {
    error = String((e && e.message) || e);
  }
  // cli-subprocess integration: a successful version run IS the executable
  // existing and executing — the structural claim proven at the process level.
  // The supported-window check gates which version facts are asserted.
  const inWindow = proven && versionInSupportedWindow(version);
  probes.integrationMode = {
    proven,
    // observed = the probe's boolean verdict on the claim (true = the run
    // proved the cli-subprocess integration holds).
    observed: proven ? true : undefined,
    version,
    versionInSupportedWindow: inWindow,
    probedAt: new Date().toISOString(),
    ...(error ? { error } : {}),
  };
  return { ok: proven, probes, version, versionInSupportedWindow: inWindow };
}

// Convenience: declaration + probes -> report (per-axis tri-state).
export function probeCapabilityReport({ executable, spawnSync, capabilities = OPENCODE_CLI_EXECUTOR_CAPABILITIES } = {}) {
  const p = probeOpenCodeCapabilities({ executable, spawnSync });
  return { ok: p.ok, version: p.version || null, report: capabilityReport(capabilities, p.probes) };
}
