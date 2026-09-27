#!/usr/bin/env node
// model-resolution.mjs — ONE deterministic model resolver shared by the
// soc_control CLI router, the client route-worker and the executor launcher
// (SOC_BRAIN_TASK_HARNESS_HARDENING_AUTO_RECOVERY section B).
//
// Contract:
//   * A model is identified ONLY by the canonical OpenCode `provider/model-id`
//     string. A display name ("MiMo-V2.6-Flash Free OpenCode Zen") is NEVER
//     accepted as evidence that a model exists.
//   * Availability must be PROVEN against a real availability set
//     (`opencode models` output, an injected probe, or an operator-pinned
//     set). A syntactically valid string with no proven availability is
//     MODEL_UNRESOLVED — never a silent pass-through.
//   * Resolution order (explicit, documented, no provider hop):
//       1. task override (explicit `override` argument, else SOC_MODEL env)
//       2. validated config: worktree opencode.json, then repo opencode.json
//       3. configured + validated fallback (explicit `fallback` argument,
//          else SOC_MODEL_FALLBACK env, else `soc_model_fallback` in config,
//          else DEFAULT_FALLBACK_MODEL)
//   * Typed pre-spawn failures: MODEL_INVALID / MODEL_UNAVAILABLE /
//     MODEL_UNRESOLVED. No token, API key or secret is ever read or written.
//
// NOTE ON `fallback_model`: the OpenCode config schema pinned by `$schema`
// (https://opencode.ai/config.json) declares NO `fallback_model` key, and
// `opencode debug config` drops it from the resolved config on the pinned
// runtime. It is therefore NOT a valid configuration/availability source
// here; the fallback lives in the Soc_brain-owned resolution chain above.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Canonical `provider/model-id` shape (OpenCode `-m` / `--model` interface).
// Two or more `/`-separated segments are legal (`openrouter/xiaomi/mimo-v2.5`),
// but at least one slash is REQUIRED: a bare name or a display string is never
// a model id.
export const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:-]*)+$/;

export const MODEL_OVERRIDE_ENV = 'SOC_MODEL';
export const MODEL_FALLBACK_ENV = 'SOC_MODEL_FALLBACK';
export const MODELS_AVAILABLE_ENV = 'SOC_MODELS_AVAILABLE';

// Last-resort configured values (still availability-validated like everything
// else). The worktree/repo config normally supplies the primary model.
export const DEFAULT_MODEL = 'opencode/mimo-v2.6-flash-free';
export const DEFAULT_FALLBACK_MODEL = 'nine-router/Soc_OR_free_act';

export const MODEL_CONFIG_KEY = 'model';
export const MODEL_FALLBACK_CONFIG_KEY = 'soc_model_fallback';

export const MODEL_CODES = Object.freeze({
  INVALID: 'MODEL_INVALID',
  UNAVAILABLE: 'MODEL_UNAVAILABLE',
  UNRESOLVED: 'MODEL_UNRESOLVED',
});

function fail(code, detail) { return { ok: false, code, detail: detail ?? null }; }

// ---- candidate validation (format only; availability is separate) ----------
export function validateModelId(value) {
  if (typeof value !== 'string') {
    return fail(MODEL_CODES.INVALID, 'model must be a string, got ' + (value === null ? 'null' : typeof value));
  }
  const v = value.trim();
  if (!v) return fail(MODEL_CODES.INVALID, 'model must be a non-empty provider/model-id');
  if (v.length > 192) return fail(MODEL_CODES.INVALID, 'model id too long (' + v.length + ')');
  if (!MODEL_ID_RE.test(v)) {
    return fail(MODEL_CODES.INVALID, 'not a provider/model-id: ' + JSON.stringify(v.slice(0, 96)));
  }
  return { ok: true, value: v };
}

// ---- availability set parsing ----------------------------------------------
// `opencode models` emits one `provider/model-id` per line (possibly ANSI
// highlighted when stdout is a TTY). ANSI sequences and any trailing
// decoration are stripped; anything that is still not a canonical id is
// ignored (never treated as availability evidence).
const ANSI_RE = /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function parseModelList(stdout) {
  const out = new Set();
  const cleaned = String(stdout ?? '').replace(ANSI_RE, '');
  for (const raw of cleaned.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (MODEL_ID_RE.test(line)) out.add(line);
  }
  return out;
}

export function availableModelsFromEnv(env = process.env) {
  const raw = env && typeof env[MODELS_AVAILABLE_ENV] === 'string' ? env[MODELS_AVAILABLE_ENV] : '';
  if (!raw.trim()) return null;
  return parseModelList(raw.replace(/[,\s]+/g, '\n'));
}

// ---- config readers ---------------------------------------------------------
// Reads ONLY the Soc_brain-owned model keys. Unknown/ignored OpenCode keys
// are never used as evidence.
export function readModelConfig(configPath) {
  const out = { path: configPath, present: false, model: null, fallback: null, parseError: null };
  if (typeof configPath !== 'string' || !configPath) return out;
  let raw;
  try { raw = fs.readFileSync(configPath, 'utf8'); } catch (e) {
    out.parseError = String((e && e.message) || e);
    return out;
  }
  try {
    const cfg = JSON.parse(raw);
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
      out.parseError = 'config is not a JSON object';
      return out;
    }
    out.present = true;
    if (typeof cfg[MODEL_CONFIG_KEY] === 'string') out.model = cfg[MODEL_CONFIG_KEY].trim() || null;
    if (typeof cfg[MODEL_FALLBACK_CONFIG_KEY] === 'string') out.fallback = cfg[MODEL_FALLBACK_CONFIG_KEY].trim() || null;
  } catch (e) {
    out.parseError = String((e && e.message) || e);
  }
  return out;
}

// ---- availability probe -----------------------------------------------------
// Memoised per executable: spawning `opencode models` on every resolution
// call would add seconds to each pre-spawn gate. The cache is process-local
// and never persists an availability claim across restarts.
const probeCache = new Map();

export function clearModelProbeCache() { probeCache.clear(); }

export function probeAvailableModels({ executable, env = process.env, exec = execFileSync, force = false } = {}) {
  if (typeof executable !== 'string' || !executable) {
    return fail(MODEL_CODES.UNRESOLVED, 'no opencode executable available for the model probe');
  }
  const key = executable;
  if (!force && probeCache.has(key)) return probeCache.get(key);
  let stdout = '';
  try {
    stdout = exec(executable, ['models'], {
      encoding: 'utf8', env, windowsHide: true, timeout: 60000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    // A failed probe is NOT cached: a transient failure must not poison later
    // resolutions (fail-closed now, retryable on the next gate).
    return fail(MODEL_CODES.UNRESOLVED, 'model probe failed: ' + String((e && e.message) || e).slice(0, 300));
  }
  const set = parseModelList(stdout);
  if (set.size === 0) {
    return fail(MODEL_CODES.UNRESOLVED, 'model probe returned no provider/model-id entries');
  }
  const r = { ok: true, value: set };
  probeCache.set(key, r);
  return r;
}

// Availability source order: injected probe -> operator-pinned env set ->
// real `opencode models` probe. Nothing else counts as proof.
export function resolveAvailableModels({
  listModels = null, env = process.env, executable = null, exec = execFileSync, force = false,
} = {}) {
  if (typeof listModels === 'function') {
    let set;
    try { set = listModels(); } catch (e) {
      return fail(MODEL_CODES.UNRESOLVED, 'listModels threw: ' + String((e && e.message) || e));
    }
    if (set instanceof Set) return { ok: true, value: set, source: 'injected' };
    if (Array.isArray(set)) return { ok: true, value: new Set(set.filter((m) => MODEL_ID_RE.test(m))), source: 'injected' };
    if (typeof set === 'string') return { ok: true, value: parseModelList(set), source: 'injected' };
    return fail(MODEL_CODES.UNRESOLVED, 'listModels returned no usable model set');
  }
  const fromEnv = availableModelsFromEnv(env);
  if (fromEnv && fromEnv.size > 0) return { ok: true, value: fromEnv, source: 'env' };
  return probeAvailableModels({ executable, env, exec, force });
}

function readConfigChain(configPaths) {
  return (Array.isArray(configPaths) ? configPaths : [])
    .filter((p) => typeof p === 'string' && p)
    .map((p) => readModelConfig(p));
}

function pickCandidate({ configs, fallback, env }) {
  for (const c of configs) {
    if (c.model) return { candidate: c.model, source: 'config:' + c.path };
  }
  if (typeof fallback === 'string' && fallback.trim()) return { candidate: fallback.trim(), source: 'arg:fallback' };
  const envFallback = env && typeof env[MODEL_FALLBACK_ENV] === 'string' ? env[MODEL_FALLBACK_ENV].trim() : '';
  if (envFallback) return { candidate: envFallback, source: 'env:' + MODEL_FALLBACK_ENV };
  for (const c of configs) {
    if (c.fallback) return { candidate: c.fallback, source: 'config-fallback:' + c.path };
  }
  return { candidate: DEFAULT_FALLBACK_MODEL, source: 'const:DEFAULT_FALLBACK_MODEL' };
}

// resolveModel({ override, configPaths, fallback, listModels, env, executable, exec })
//   -> { ok:true, value:{ model, source, availableFrom } }
//   |  { ok:false, code: MODEL_INVALID|MODEL_UNAVAILABLE|MODEL_UNRESOLVED, detail }
export function resolveModel({
  override = null,
  configPaths = [],
  fallback = null,
  listModels = null,
  env = process.env,
  executable = null,
  exec = execFileSync,
} = {}) {
  const configs = readConfigChain(configPaths);

  let candidate = null;
  let source = null;
  const argOverride = typeof override === 'string' && override.trim() ? override.trim() : null;
  const envOverride = env && typeof env[MODEL_OVERRIDE_ENV] === 'string' && env[MODEL_OVERRIDE_ENV].trim()
    ? env[MODEL_OVERRIDE_ENV].trim() : null;
  if (argOverride) { candidate = argOverride; source = 'arg:override'; }
  else if (envOverride) { candidate = envOverride; source = 'env:' + MODEL_OVERRIDE_ENV; }
  else {
    const picked = pickCandidate({ configs, fallback, env });
    candidate = picked.candidate;
    source = picked.source;
  }

  if (candidate === null || candidate === undefined || !String(candidate).trim()) {
    return fail(MODEL_CODES.UNRESOLVED, 'no model configured (override, config model or fallback)');
  }

  const v = validateModelId(candidate);
  if (!v.ok) return v;

  const avail = resolveAvailableModels({ listModels, env, executable, exec });
  if (!avail.ok) return avail; // MODEL_UNRESOLVED: availability not provable
  if (!avail.value.has(v.value)) {
    return fail(MODEL_CODES.UNAVAILABLE,
      v.value + ' (from ' + source + ') is not in the verified availability set ('
      + avail.value.size + ' models, source=' + avail.source + ')');
  }
  return { ok: true, value: { model: v.value, source, availableFrom: avail.source } };
}

// Convenience for launchers that already hold a binding / control cwd.
export function resolveModelForLaunch({
  model = null,
  binding = null,
  controlCwd = null,
  configPaths = null,
  listModels = null,
  env = process.env,
  executable = null,
  exec = execFileSync,
} = {}) {
  const paths = Array.isArray(configPaths) && configPaths.length
    ? configPaths
    : [
      binding && binding.path ? path.join(binding.path, 'opencode.json') : null,
      controlCwd ? path.join(controlCwd, '.opencode', 'opencode.json') : null,
    ].filter(Boolean);
  return resolveModel({ override: model, configPaths: paths, listModels, env, executable, exec });
}
