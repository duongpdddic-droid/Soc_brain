#!/usr/bin/env node
// project-registry.mjs — Soc_brain: Project Identity & Registry dùng chung (Issue #3).
// Source: duongpdddic-droid/AI_PR_REVIEWER
// Immutable source SHA: 9c104c88dddb3e9aad0388447e9be6ff74f78a06
// Fail-closed: validator trả {ok:false, errors} khi vi phạm; không throw ngoài test cố ý.
// Registry machine-local NGOÀI worktree (không commit vào Git). Không chạm Claude Mem hooks/retrieval.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as _issue17 from './registry-storage.mjs';

export const SUPPORTED_SCHEMA_VERSION = '1.0';
export const MIN_SCHEMA_VERSION = '1.0';

// Machine-local registry path (NGOÀI worktree, ngoài Git).
export const DEFAULT_REGISTRY_DIR = path.join(os.homedir(), '.soc-brain', 'registry');
export const DEFAULT_REGISTRY_PATH = path.join(DEFAULT_REGISTRY_DIR, 'registry.json');
export const SCHEMA_URL = new URL('./project-manifest-schema.json', import.meta.url);
export const SCHEMA_PATH = fileURLToPath(SCHEMA_URL);

// Ownership matrix: mỗi capability có ĐÚNG MỘT canonical owner.
export const OWNERSHIP_MATRIX = [
  { capability: 'telegram-transport', owner: 'platform', ownerRef: 'shared-telegram-gateway' },
  { capability: 'telegram-routing', owner: 'platform', ownerRef: 'shared-telegram-gateway' },
  { capability: 'github-intake', owner: 'platform', ownerRef: 'agent-platform' },
  { capability: 'label-state-machine', owner: 'platform', ownerRef: 'agent-platform' },
  { capability: 'context-routing', owner: 'platform', ownerRef: 'agent-platform' },
  { capability: 'project-manifest', owner: 'platform', ownerRef: 'agent-platform' },
  { capability: 'product-code', owner: 'project', ownerRef: 'project-repo' },
  { capability: 'deploy-adapter', owner: 'project', ownerRef: 'project-repo' },
  { capability: 'verify-adapter', owner: 'project', ownerRef: 'project-repo' },
  { capability: 'claude-mem-namespace', owner: 'project', ownerRef: 'claude-mem' },
];

// Project overrides bị giới hạn bằng allowlist.
export const ALLOWED_OVERRIDES = ['policy', 'verifyAdapter', 'telegramRoute', 'deploy.humanAuthorization'];
export function isAllowedOverride(key) { return ALLOWED_OVERRIDES.includes(key); }

// Secret patterns (fail-closed: phát hiện -> reject).
const SECRET_PATTERNS = [
  /(api[_-]?key|apikey)\s*[:=]\s*['"][A-Za-z0-9]{8,}/i,
  /AKIA[0-9A-Z]{16}/,
  /(password|secret|token|private[_-]?key)\s*[:=]\s*['"][^'"]{6,}/i,
  /-----BEGIN (RSA |EC |)PRIVATE KEY-----/,
  /(mongodb|postgres|mysql|redis):\/\/[^\s:]+:[^\s@]+@/i,
];
// Absolute machine path patterns (fail-closed: không commit path máy).
const SECRET_KEY_RE = /(token|secret|password|apikey|privatekey)/i;

const ABSOLUTE_PATH_PATTERNS = [/^[A-Za-z]:[\\/]/, /^\/(?:home|Users|root|mnt|var|etc|tmp)\b/, /^~[\\/]/];

function scanStrings(value, patterns) {
  const hits = [];
  const walk = (v) => {
    if (typeof v === 'string') { for (const p of patterns) if (p.test(v)) hits.push(v); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(value);
  return hits;
}
export function scanForSecrets(value) {
  const hits = [];
  const walk = (v, key) => {
    if (typeof key === 'string' && SECRET_KEY_RE.test(key)) hits.push(`secret-key:${key}`);
    if (typeof v === 'string') { for (const p of SECRET_PATTERNS) if (p.test(v)) hits.push(v); }
    else if (Array.isArray(v)) v.forEach((it) => walk(it));
    else if (v && typeof v === 'object') for (const [k, val] of Object.entries(v)) walk(val, k);
  };
  walk(value);
  return hits;
}
export function scanForAbsolutePaths(value) { return scanStrings(value, ABSOLUTE_PATH_PATTERNS); }

export function compareVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

// Fail-closed validation. Thiếu repo identity -> reject. Secret/absolute path -> reject. Stale schema -> cần migrate.
export function validateManifest(manifest, opts = {}) {
  const errors = [];
  const m = manifest && typeof manifest === 'object' ? manifest : {};
  const minV = opts.minSchemaVersion || MIN_SCHEMA_VERSION;
  if (!/^\d+\.\d+$/.test(String(m.schemaVersion || ''))) errors.push('SCHEMA_VERSION_INVALID');
  if (!m.projectId || typeof m.projectId !== 'string') errors.push('MISSING_PROJECT_ID');
  if (!m.repository || typeof m.repository !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(m.repository))
    errors.push('MISSING_REPO_IDENTITY');
  if (!m.workspace || typeof m.workspace !== 'object' || !m.workspace.workspaceId) errors.push('MISSING_WORKSPACE_ID');
  if (!m.projectType) errors.push('MISSING_PROJECT_TYPE');
  // Manifest phải khai báo policy.version (project tự pin policy của mình). Không ép match canonical version.
  if (!m.policy || !m.policy.version) errors.push('MISSING_POLICY_PIN');
  if (!m.verify || !m.verify.adapter) errors.push('MISSING_VERIFY_ADAPTER');
  if (!m.deploy || typeof m.deploy.humanAuthorization !== 'boolean') errors.push('MISSING_DEPLOY_AUTHZ');
  if (!m.telegram || !m.telegram.route) errors.push('MISSING_TELEGRAM_ROUTE');
  if (!m.memory || !m.memory.provider || !m.memory.namespace) errors.push('MISSING_MEMORY_NAMESPACE');
  const secrets = scanForSecrets(m);
  if (secrets.length) errors.push('CONTAINS_SECRET:' + secrets.length);
  const abs = scanForAbsolutePaths(m);
  if (abs.length) errors.push('CONTAINS_ABSOLUTE_PATH:' + abs.length);
  if (m.schemaVersion && compareVersion(m.schemaVersion, minV) < 0) errors.push('STALE_SCHEMA:' + m.schemaVersion);
  if (m.schemaVersion && compareVersion(m.schemaVersion, SUPPORTED_SCHEMA_VERSION) > 0) errors.push('UNSUPPORTED_SCHEMA_VERSION:' + m.schemaVersion);
  if (Array.isArray(m.allowedOverrides))
    for (const k of m.allowedOverrides) if (!isAllowedOverride(k)) errors.push('OVERRIDE_NOT_ALLOWED:' + k);
  // [GPT-REV-070] JSON Schema enforcement — fail-closed: schema lỗi/mất -> reject (không silent-skip).
  let schema = null;
  try { schema = loadSchema(); } catch (e) { errors.push('MANIFEST_SCHEMA_UNAVAILABLE:' + ((e && e.code) || 'parse')); }
  if (schema) errors.push(...validateAgainstSchema(m, schema));
  return { ok: errors.length === 0, errors, manifest: m };
}

// Fail-closed: ném nếu schema file thiếu/không parse được (không trả null).
function loadSchema() {
  return JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
}

// Thực thi JSON Schema đệ quy: required, type, pattern, enum, minLength, nested object/array (đầy đủ).
function validateAgainstSchema(root, schema) {
  const errs = [];
  validateNode(root, schema, '', errs);
  return errs;
}
function validateNode(value, def, path, errs) {
  if (!def) return;
  const name = path ? path.toUpperCase() : 'ROOT';
  if (def.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) { errs.push('SCHEMA_TYPE_' + name); return; }
    for (const rk of (def.required || [])) if (!(rk in value)) errs.push('SCHEMA_MISSING_' + (path ? path.toUpperCase() + '_' : '') + String(rk).toUpperCase());
    const props = def.properties || {};
    for (const [pk, pdef] of Object.entries(props)) {
      if (!(pk in value)) continue;
      validateNode(value[pk], pdef, path ? path + '.' + pk : pk, errs);
    }
    return;
  }
  if (def.type === 'array') {
    if (!Array.isArray(value)) { errs.push('SCHEMA_TYPE_' + name); return; }
    if (def.items) for (const it of value) validateNode(it, def.items, path, errs);
    return;
  }
  if (def.type === 'string') {
    if (typeof value !== 'string') { errs.push('SCHEMA_TYPE_' + name); return; }
    if (def.pattern && !new RegExp(def.pattern).test(value)) errs.push('SCHEMA_PATTERN_' + name);
    if (def.enum && !def.enum.includes(value)) errs.push('SCHEMA_ENUM_' + name);
    if (def.minLength && value.length < def.minLength) errs.push('SCHEMA_MINLEN_' + name);
    return;
  }
  if (def.type && typeof value !== def.type) errs.push('SCHEMA_TYPE_' + name);
}

export function loadRegistry({ registryPath = DEFAULT_REGISTRY_PATH } = {}) {
  try {
    const obj = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    if (!obj.projects) obj.projects = [];
    return obj;
  } catch (e) {
    if (e.code === 'ENOENT') return { schemaVersion: SUPPORTED_SCHEMA_VERSION, projects: [] };
    throw e;
  }
}

export function saveRegistry({ registry, registryPath = DEFAULT_REGISTRY_PATH } = {}) {
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n', 'utf8');
}

// Phát hiện projectId / repository / telegramRoute / workspaceId trùng.
export function detectConflicts({ registry, manifest }) {
  const conflicts = [];
  const projects = (registry && registry.projects) || [];
  for (const p of projects) {
    if (p.projectId && manifest.projectId && p.projectId === manifest.projectId) {
      // Cùng project (update/idempotent): chỉ conflict nếu repository (identity) khác -> collision.
      if (p.repository !== manifest.repository) conflicts.push({ type: 'projectId', value: manifest.projectId });
      continue;
    }
    if (p.repository && manifest.repository && p.repository === manifest.repository) conflicts.push({ type: 'repository', value: manifest.repository });
    if (p.telegram && manifest.telegram && p.telegram.route && manifest.telegram.route && p.telegram.route === manifest.telegram.route) conflicts.push({ type: 'telegramRoute', value: manifest.telegram.route });
    if (p.workspace && manifest.workspace && p.workspace.workspaceId && manifest.workspace.workspaceId && p.workspace.workspaceId === manifest.workspace.workspaceId) conflicts.push({ type: 'workspaceId', value: manifest.workspace.workspaceId });
  }
  return conflicts;
}

// Workspace remote phải khớp manifest trước mọi mutation.
export function assertWorkspaceRemote({ manifest, actualRemote, canonicalRemote }) {
  const expected = canonicalRemote || (manifest.repository ? 'https://github.com/' + manifest.repository + '.git' : null);
  if (!expected) return { ok: false, reason: 'NO_EXPECTED_REMOTE' };
  if (actualRemote !== expected) return { ok: false, reason: 'REMOTE_MISMATCH', actual: actualRemote, expected };
  return { ok: true };
}

export function registerProject({ manifest, registry, registryPath = DEFAULT_REGISTRY_PATH, actualRemote, canonicalRemote }) {
  // AC3: remote phải khớp TRƯỚC mọi mutation. Các bước validate/conflict/remote là read-only,
  // KHÔNG mutate input manifest (tránh đè metadata trước khi remote verify — GPT-REV-074).
  const v = validateManifest(manifest);
  if (!v.ok) return { ok: false, stage: 'validate', errors: v.errors };
  const conflicts = detectConflicts({ registry, manifest });
  if (conflicts.length) return { ok: false, stage: 'conflict', conflicts };
  const rc = assertWorkspaceRemote({ manifest, actualRemote, canonicalRemote });
  if (!rc.ok) return { ok: false, stage: 'remote', ...rc };
  // Sau khi remote khớp: deep-clone và lưu NGUYÊN clone. Không strip bất kỳ extension field nào
  // (schema additionalProperties:true -> __migrationAdded có thể là dữ liệu extension hợp lệ — GPT-REV-073).
  const clean = JSON.parse(JSON.stringify(manifest));
  registry.projects = registry.projects || [];
  const idx = registry.projects.findIndex((p) => p.projectId === clean.projectId);
  if (idx >= 0) registry.projects[idx] = clean; else registry.projects.push(clean);
  saveRegistry({ registry, registryPath });
  return { ok: true, registry };
}

// Migration 0.9 -> 1.0 (up) và 1.0 -> 0.9 (rollback). Reversible: down(up(original)) === original (lossless).
// Rollback metadata = rollbackPlan versioned do up() phát hành, BẮT fingerprint của manifest sau up
// và addedKeys bị chặn allowlist — down() không nhận danh sách key tùy ý (GPT-REV-073/075).
// [GPT-REV-076] Path migration BỊ GIỚI HẠN CHÍNH XÁC 0.9 <-> 1.0; mọi path khác (vd 0.9->2.0, 1.0->2.0,
// 2.0->1.0, nguồn/source không phải 0.9) fail-closed (UNSUPPORTED_MIGRATION_PATH). rollbackPlan.toVersion
// phải khớp manifest.schemaVersion sau up; plan phải mang hướng chính xác 1.0 -> 0.9.
// Không đọc/ghi/xóa __migrationAdded trên payload; extension field của user bảo toàn tuyệt đối.
export const ROLLBACK_PLAN_VERSION = 1;
// Duy nhất các key mà migration 0.9 -> 1.0 được phép thêm; mọi key khác trong plan là illegal.
export const UPGRADE_ALLOWED_ADDED_KEYS = ['workspace', 'policy', 'verify', 'deploy', 'telegram', 'memory', 'allowedOverrides'];
// [GPT-REV-076] Path migration duy nhất được hỗ trợ (fail-closed mọi path khác).
export const MIGRATION_FROM_VERSION = '0.9';
export const MIGRATION_TO_VERSION = '1.0';
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

// ponytail: fingerprint nhạy thứ-tu-key JSON.stringify — đủ vì up tự sinh manifest; nâng canonical stringify nếu cần cross-serialization.
// Fingerprint bám CẢ manifest sau up LẪN plan core (hướng + addedKeys): sửa bất kỳ thành phần nào -> mismatch.
function rollbackPlanFingerprint(m, planCore) {
  return crypto.createHash('sha256').update(JSON.stringify({ manifest: m, ...planCore })).digest('hex');
}

export function migrateManifest({ manifest, toVersion = MIGRATION_TO_VERSION, rollbackPlan = null }) {
  const m = JSON.parse(JSON.stringify(manifest || {}));
  const from = m.schemaVersion || MIGRATION_FROM_VERSION;
  if (compareVersion(toVersion, from) > 0) {
    // [GPT-REV-076] UP CHỈ hỗ trợ path chính xác 0.9 -> 1.0. Mọi source/đích khác fail-closed.
    if (toVersion !== MIGRATION_TO_VERSION || from !== MIGRATION_FROM_VERSION) {
      return { ok: false, direction: 'up', reason: 'UNSUPPORTED_MIGRATION_PATH' };
    }
    m.schemaVersion = toVersion;
    const addedKeys = [];
    const ensure = (key, value) => { if (!(key in m)) { m[key] = value; addedKeys.push(key); } };
    ensure('workspace', { workspaceId: m.projectId || 'unknown' });
    ensure('policy', { version: '1.0.0' });
    ensure('verify', { adapter: 'pnpm-verify' });
    ensure('deploy', { capability: false, humanAuthorization: true });
    ensure('telegram', { route: 'default' });
    ensure('memory', { provider: 'claude-mem', namespace: m.projectId || 'unknown' });
    if (!Array.isArray(m.allowedOverrides)) { m.allowedOverrides = []; addedKeys.push('allowedOverrides'); }
    // Không ghi m.__migrationAdded (sẽ đè extension field). Trả rollbackPlan versioned + fingerprint-bound.
    const planCore = { fromVersion: from, toVersion, addedKeys: [...addedKeys] };
    // [GPT-REV-076] rollbackPlan.toVersion phải khớp manifest.schemaVersion sau up.
    if (planCore.toVersion !== m.schemaVersion) return { ok: false, direction: 'up', reason: 'ROLLBACK_PLAN_VERSION_MISMATCH' };
    return {
      ok: true,
      direction: 'up',
      manifest: m,
      rollbackPlan: {
        planVersion: ROLLBACK_PLAN_VERSION,
        ...planCore,
        fingerprint: rollbackPlanFingerprint(m, planCore),
      },
    };
  }
  if (compareVersion(toVersion, from) < 0) {
    // [GPT-REV-076] DOWN CHỈ hỗ trợ path chính xác 1.0 -> 0.9. Mọi source/đích khác fail-closed.
    if (toVersion !== MIGRATION_FROM_VERSION || from !== MIGRATION_TO_VERSION) {
      return { ok: false, direction: 'down', reason: 'UNSUPPORTED_MIGRATION_PATH' };
    }
    // Rollback CHỈ thực thi rollbackPlan do up() phát hành: đúng schema/version, đúng hướng (1.0->0.9),
    // khớp fingerprint manifest đầu vào, addedKeys ⊆ allowlist 0.9->1.0. Mọi vi phạm fail-closed,
    // input không bị mutate (mutation chỉ diễn ra trên clone sau khi mọi gate PASS).
    const bad = (reason, extra) => ({ ok: false, direction: 'down', reason, ...extra });
    if (!rollbackPlan || typeof rollbackPlan !== 'object' || Array.isArray(rollbackPlan)) return bad('ROLLBACK_PLAN_REQUIRED');
    if (rollbackPlan.planVersion !== ROLLBACK_PLAN_VERSION
      || typeof rollbackPlan.fromVersion !== 'string'
      || typeof rollbackPlan.toVersion !== 'string') return bad('ROLLBACK_PLAN_VERSION_INVALID');
    // [GPT-REV-076] hướng plan phải chính xác 1.0 -> 0.9: plan.toVersion (== 1.0) phải khớp manifest.schemaVersion
    // hiện tại, plan.fromVersion (== 0.9) là đích rollback. Vi phạm -> DIRECTION_MISMATCH.
    if (rollbackPlan.toVersion !== from
      || rollbackPlan.fromVersion !== MIGRATION_FROM_VERSION) return bad('ROLLBACK_PLAN_DIRECTION_MISMATCH');
    const ak = rollbackPlan.addedKeys;
    if (!Array.isArray(ak) || ak.length === 0 || ak.some((k) => typeof k !== 'string' || k === '')) return bad('ROLLBACK_PLAN_KEYS_INVALID');
    const illegal = [...new Set(ak.filter((k) => !UPGRADE_ALLOWED_ADDED_KEYS.includes(k)))];
    if (illegal.length) return bad('ROLLBACK_PLAN_ILLEGAL_KEY', { keys: illegal });
    if (typeof rollbackPlan.fingerprint !== 'string' || !SHA256_HEX_RE.test(rollbackPlan.fingerprint)) return bad('ROLLBACK_PLAN_FINGERPRINT_INVALID');
    const verifyCore = { fromVersion: rollbackPlan.fromVersion, toVersion: rollbackPlan.toVersion, addedKeys: ak };
    if (rollbackPlanFingerprint(m, verifyCore) !== rollbackPlan.fingerprint) return bad('ROLLBACK_PLAN_FINGERPRINT_MISMATCH');
    for (const k of new Set(ak)) delete m[k];
    m.schemaVersion = MIGRATION_FROM_VERSION;
    return { ok: true, direction: 'down', manifest: m, removedKeys: [...new Set(ak)] };
  }
  // [GPT-REV-076] Chỉ 1.0 -> 1.0 mới idempotent (none). Mọi version lạ bằng nhau (0.8->0.8, 0.9->0.9,
  // 2.0->2.0) fail-closed — không được nhận là no-op.
  if (from === MIGRATION_TO_VERSION && toVersion === MIGRATION_TO_VERSION) {
    return { ok: true, direction: 'none', manifest: m };
  }
  return { ok: false, reason: 'UNSUPPORTED_MIGRATION_PATH' };
}

// Đảm bảo mỗi capability có đúng 1 canonical owner.
export function assertSingleOwner(matrix = OWNERSHIP_MATRIX) {
  const seen = new Map();
  for (const e of matrix) {
    if (seen.has(e.capability)) return { ok: false, duplicate: e.capability };
    seen.set(e.capability, e.owner);
  }
  return { ok: true, count: seen.size };
}

// Registry lưu ngoài worktree (không commit vào Git).
export function registryOutsideWorktree(registryPath = DEFAULT_REGISTRY_PATH, cwd = process.cwd()) {
  const abs = path.resolve(registryPath);
  const rel = path.relative(cwd, abs);
  const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  return { outside: !inside, path: abs };
}

// ---- Issue #17: Canonical Project Registry physical SSOT (additive re-exports) ----
// Consumers (@soc/project-registry artifact) import the Issue #17 API from this module
// alongside the Issue #3 manifest API. Issue #3 surface is unchanged.
export const SUPPORTED_REGISTRY_SCHEMA = _issue17.SUPPORTED_REGISTRY_SCHEMA;
export const MIGRATION_CONTRACT_VERSION = _issue17.MIGRATION_CONTRACT_VERSION;
export const DEFAULT_CANONICAL_REGISTRY_DIR = _issue17.DEFAULT_CANONICAL_REGISTRY_DIR;
export const DEFAULT_CANONICAL_REGISTRY_PATH = _issue17.DEFAULT_CANONICAL_REGISTRY_PATH;
export const DEFAULT_CANONICAL_LOCK_DIR = _issue17.DEFAULT_CANONICAL_LOCK_DIR;
export const LEGACY_REGISTRY_PATH = _issue17.LEGACY_REGISTRY_PATH;
export const REGISTRY_DIGEST_RE = _issue17.REGISTRY_DIGEST_RE;
export const REPO_RE = _issue17.REPO_RE;
export const PROJECT_ID_RE = _issue17.PROJECT_ID_RE;
export const canonicalStringify = _issue17.canonicalStringify;
export const computeRegistryDigest = _issue17.computeRegistryDigest;
export const runJCSSelfCheck = _issue17.runJCSSelfCheck;
export const readCanonicalRegistry = _issue17.readCanonicalRegistry;
export const validateCanonicalRegistry = _issue17.validateCanonicalRegistry;
export const createCanonicalRegistry = _issue17.createCanonicalRegistry;
export const nextRevision = _issue17.nextRevision;
export const writeCanonicalRegistry = _issue17.writeCanonicalRegistry;
export const commitCanonicalRegistry = _issue17.commitCanonicalRegistry;
export const acquireRegistryLock = _issue17.acquireRegistryLock;
export const releaseRegistryLock = _issue17.releaseRegistryLock;
export const readLegacyRegistry = _issue17.readLegacyRegistry;
export const detectSplitBrain = _issue17.detectSplitBrain;
export const migrateLegacyRegistry = _issue17.migrateLegacyRegistry;
export const resolveCanonicalRegistry = _issue17.resolveCanonicalRegistry;
export const verifyCanonicalRoot = _issue17.verifyCanonicalRoot;
export const reconcileLegacyRegistry = _issue17.reconcileLegacyRegistry;

