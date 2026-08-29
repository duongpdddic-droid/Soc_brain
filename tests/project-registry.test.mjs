#!/usr/bin/env node
// test-project-registry.mjs — integration tests cho Project Registry + versioned manifest (Issue #14).
// KHÔNG framework. Exit 0 = PASS, 1 = FAIL.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  validateManifest, scanForSecrets, scanForAbsolutePaths,
  loadRegistry, saveRegistry, detectConflicts, assertWorkspaceRemote,
  registerProject, migrateManifest, assertSingleOwner, registryOutsideWorktree,
  OWNERSHIP_MATRIX, isAllowedOverride, DEFAULT_REGISTRY_PATH,
  CANONICAL_POLICY_VERSION, SCHEMA_PATH,
  ROLLBACK_PLAN_VERSION, UPGRADE_ALLOWED_ADDED_KEYS,
  MIGRATION_FROM_VERSION, MIGRATION_TO_VERSION,
} from '../packages/project-registry/project-registry.mjs';

const checks = [];
const eq = (name, got, want) => checks.push({ name, ok: got === want, got, want });
const tru = (name, got) => checks.push({ name, ok: Boolean(got), got });
const falsy = (name, got) => checks.push({ name, ok: !got, got });

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(DIR, '..', 'packages', 'project-registry', 'fixtures');
const load = (f) => JSON.parse(readFileSync(path.join(FX, f), 'utf8'));
const tmpPath = path.join(os.tmpdir(), `reg-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

// AC1: schema versioned + fail-closed thiếu repo identity.
{
  const valid = load('ai-pr-reviewer.json');
  tru('AC1 valid manifest pass', validateManifest(valid).ok);
  const noRepo = { ...valid }; delete noRepo.repository;
  falsy('AC1 thiếu repository -> reject', validateManifest(noRepo).ok);
  const noId = { ...valid }; delete noId.projectId;
  falsy('AC1 thiếu projectId -> reject', validateManifest(noId).ok);
  const badRepo = { ...valid, repository: 'not-a-repo' };
  falsy('AC1 repository sai định dạng -> reject', validateManifest(badRepo).ok);
}

// AC2: registry phát hiện duplicate projectId / telegramRoute / workspace trùng.
{
  const reg = { schemaVersion: '1.0', projects: [load('ai-pr-reviewer.json')] };
  const dup = load('duplicate-id.json');
  const c = detectConflicts({ registry: reg, manifest: dup });
  tru('AC2 phát hiện duplicate projectId', c.some((x) => x.type === 'projectId'));
  const sameRoute = { ...load('generic.json'), telegram: { route: 'dm-boss' }, projectId: 'x1' };
  const c2 = detectConflicts({ registry: reg, manifest: sameRoute });
  tru('AC2 phát hiện duplicate telegramRoute', c2.some((x) => x.type === 'telegramRoute'));
  const sameWs = { ...load('generic.json'), workspace: { workspaceId: 'ai-pr-reviewer-main' }, projectId: 'x2' };
  const c3 = detectConflicts({ registry: reg, manifest: sameWs });
  tru('AC2 phát hiện duplicate workspaceId', c3.some((x) => x.type === 'workspaceId'));
}

// AC3: workspace remote phải khớp manifest trước mutation.
{
  const m = load('ai-pr-reviewer.json');
  tru('AC3 remote khớp -> ok', assertWorkspaceRemote({ manifest: m, actualRemote: 'https://github.com/duongpdddic-droid/AI_PR_REVIEWER.git' }).ok);
  falsy('AC3 remote lệch -> reject', assertWorkspaceRemote({ manifest: m, actualRemote: 'https://github.com/evil/repo.git' }).ok);
  const w = load('wrong-remote.json');
  falsy('AC3 wrong-remote fixture mismatch', assertWorkspaceRemote({ manifest: w, actualRemote: 'https://github.com/duongpdddic-droid/AI_PR_REVIEWER.git' }).ok);
}

// AC4: secrets + absolute paths không commit trong manifest.
{
  const fakeAwsKey = ['AKIAIOSFOD', 'NN7EXAMPLE'].join('');
  const withSecret = { repository: 'o/r', projectId: 'p', workspace: { workspaceId: 'w' }, secret: `apiKey = '${fakeAwsKey}'` };
  tru('AC4 key giả ghép đúng từ 2 đoạn', fakeAwsKey === ['AKIAIOSFOD', 'NN7EXAMPLE'].join(''));
  tru('AC4 phát hiện secret', scanForSecrets(withSecret).length >= 1);
  falsy('AC4 manifest chứa secret -> reject', validateManifest(withSecret).ok);
  const withAbs = { repository: 'o/r', projectId: 'p', workspace: { workspaceId: 'w' }, path: 'C:\\Users\\x\\cfg.json' };
  tru('AC4 phát hiện absolute path', scanForAbsolutePaths(withAbs).length >= 1);
  falsy('AC4 manifest chứa absolute path -> reject', validateManifest(withAbs).ok);
}

// AC5: machine registry lưu path local ngoài Git (default path không nằm trong cwd).
{
  const r = registryOutsideWorktree(DEFAULT_REGISTRY_PATH, process.cwd());
  tru('AC5 registry mặc định ngoài worktree', r.outside);
  const inside = registryOutsideWorktree(path.join(process.cwd(), '.agent', 'registry.json'), process.cwd());
  falsy('AC5 path trong worktree -> inside', inside.outside);
}

// AC6: migration N->N+1 và rollback.
{
  const stale = load('stale-schema.json');
  falsy('AC6 stale schema chưa migrate -> reject', validateManifest(stale).ok);
  const up = migrateManifest({ manifest: stale, toVersion: '1.0' });
  eq('AC6 migrate up direction', up.direction, 'up');
  tru('AC6 migrated manifest valid', validateManifest(up.manifest).ok);
  const down = migrateManifest({ manifest: up.manifest, toVersion: '0.9', rollbackPlan: up.rollbackPlan });
  eq('AC6 rollback direction', down.direction, 'down');
  eq('AC6 rollback giữ projectId', down.manifest.projectId, 'legacy-proj');
  falsy('AC6 up không gắn __migrationAdded lên manifest', '__migrationAdded' in up.manifest);
}

// AC7: platform capability đúng 1 canonical owner.
{
  const s = assertSingleOwner(OWNERSHIP_MATRIX);
  tru('AC7 mỗi capability 1 owner', s.ok);
  const dup = [...OWNERSHIP_MATRIX, OWNERSHIP_MATRIX[0]];
  falsy('AC7 trùng capability -> fail', assertSingleOwner(dup).ok);
}

// AC8: overrides giới hạn allowlist.
{
  tru('AC8 allowlist chứa policy', isAllowedOverride('policy'));
  falsy('AC8 override ngoài allowlist -> reject', isAllowedOverride('secret'));
  const m = load('ai-pr-reviewer.json');
  m.allowedOverrides = ['policy', 'hack'];
  falsy('AC8 manifest override trái phép -> reject', validateManifest(m).ok);
}

// AC9: fixtures valid (AI_PR, QLDA, generic) + load/save roundtrip + conflict.
{
  for (const f of ['ai-pr-reviewer.json', 'qlda-dtxd.json', 'generic.json']) {
    tru('AC9 ' + f + ' valid', validateManifest(load(f)).ok);
  }
  const reg = { schemaVersion: '1.0', projects: [] };
  const res = registerProject({ manifest: load('ai-pr-reviewer.json'), registry: reg, registryPath: tmpPath, actualRemote: 'https://github.com/duongpdddic-droid/AI_PR_REVIEWER.git' });
  tru('AC9 register ai-pr-reviewer', res.ok);
  const dupRes = registerProject({ manifest: load('duplicate-id.json'), registry: reg, registryPath: tmpPath, actualRemote: 'https://github.com/another-org/duplicate-project.git' });
  falsy('AC9 duplicate id -> conflict', dupRes.ok);
  const reloaded = loadRegistry({ registryPath: tmpPath });
  tru('AC9 roundtrip load', reloaded.projects.length === 1 && reloaded.projects[0].projectId === 'ai-pr-reviewer');
}

// AC10: idempotent re-registration + secret-in-key + unsupported version + route uniqueness + rollback preserves data.
{
  const reg = { schemaVersion: '1.0', projects: [] };
  const m1 = load('ai-pr-reviewer.json');
  const r1 = registerProject({ manifest: m1, registry: reg, registryPath: tmpPath, actualRemote: 'https://github.com/duongpdddic-droid/AI_PR_REVIEWER.git' });
  tru('AC10 register lần 1', r1.ok);
  const r2 = registerProject({ manifest: m1, registry: reg, registryPath: tmpPath, actualRemote: 'https://github.com/duongpdddic-droid/AI_PR_REVIEWER.git' });
  tru('AC10 register lại cùng project -> idempotent', r2.ok);
  const fakeApiKeyName = ['api', 'Key'].join('');
  const fakeApiKeyValue = ['sk-12345678', '90abcdef'].join('');
  const withApiKey = { ...m1, [fakeApiKeyName]: fakeApiKeyValue };
  tru('AC10 key/value apiKey giả ghép đúng', fakeApiKeyName === ['api', 'Key'].join('') && fakeApiKeyValue === ['sk-12345678', '90abcdef'].join(''));
  tru('AC10 phát hiện secret trong key apiKey', scanForSecrets(withApiKey).length >= 1);
  falsy('AC10 manifest có key apiKey -> reject', validateManifest(withApiKey).ok);
  const fakeBotTokenName = ['bot', 'Token'].join('');
  const fakeBotTokenValue = ['AKIAIOSFOD', 'NN7EXAMPLE'].join('');
  const withBotToken = { ...m1, [fakeBotTokenName]: fakeBotTokenValue };
  tru('AC10 key/value botToken giả ghép đúng', fakeBotTokenName === ['bot', 'Token'].join('') && fakeBotTokenValue === ['AKIAIOSFOD', 'NN7EXAMPLE'].join(''));
  tru('AC10 phát hiện secret trong key botToken', scanForSecrets(withBotToken).length >= 1);
  const future = { ...m1, schemaVersion: '2.0' };
  falsy('AC10 schemaVersion tương lai -> reject', validateManifest(future).ok);
  const other = { ...load('generic.json'), projectId: 'other-proj', repository: 'other/proj', telegram: { route: 'dm-boss' }, workspace: { workspaceId: 'other-ws' } };
  const rc = registerProject({ manifest: other, registry: reg, registryPath: tmpPath, actualRemote: 'https://github.com/other/proj.git' });
  falsy('AC10 different project cùng route -> conflict', rc.ok);
  const stale = load('stale-schema.json');
  const up = migrateManifest({ manifest: stale, toVersion: '1.0' });
  tru('AC10 up direction', up.direction === 'up');
  // [GPT-REV-073] marker added KHÔNG gắn lên manifest -> không đè extension field.
  falsy('AC10 up không gắn __migrationAdded lên manifest', '__migrationAdded' in up.manifest);
  // [GPT-REV-074] registerProject không mutate input trước remote.
  const down = migrateManifest({ manifest: up.manifest, toVersion: '0.9', rollbackPlan: up.rollbackPlan });
  eq('AC10 rollback direction', down.direction, 'down');
  eq('AC10 rollback schemaVersion', down.manifest.schemaVersion, '0.9');
  // [GPT-REV-073] round-trip lossless: down(up(original)) === original.
  eq('AC10 rollback khôi phục nguyên bản (lossless)', JSON.stringify(down.manifest), JSON.stringify(stale));
}

// AC11: [GPT-REV-069] gate policy version đối chiếu canonical; [GPT-REV-070] schema nested fail-closed.
{
  eq('AC11 canonical policyVersion là string hợp lệ', typeof CANONICAL_POLICY_VERSION, 'string');
  const badPV = { ...load('ai-pr-reviewer.json'), policy: { pin: 'ai-review-policy.json', version: '2026-08-22.6' } };
  const r = validateManifest(badPV);
  falsy('AC11 policy version lệch canonical -> reject', r.ok);
  tru('AC11 sinh POLICY_VERSION_MISMATCH', r.errors.some((e) => e.startsWith('POLICY_VERSION_MISMATCH')));
  tru('AC11 policy version đúng canonical -> pass', validateManifest(load('ai-pr-reviewer.json')).ok);
  tru('AC11 soc-brain manifest pass', validateManifest(load('soc-brain.json')).ok);
  // nested required: thiếu policy.version -> schema reject.
  const noPolVer = { ...load('ai-pr-reviewer.json') }; delete noPolVer.policy.version;
  const r2 = validateManifest(noPolVer);
  tru('AC11 nested thiếu policy.version -> SCHEMA_MISSING_POLICY_VERSION', r2.errors.includes('SCHEMA_MISSING_POLICY_VERSION'));
  // nested type: telegram.route phải là string.
  const badTel = { ...load('ai-pr-reviewer.json'), telegram: { route: 123 } };
  const r3 = validateManifest(badTel);
  tru('AC11 nested telegram.route sai type -> SCHEMA_TYPE_TELEGRAM', r3.errors.some((e) => e.startsWith('SCHEMA_TYPE_TELEGRAM')));
  // schema file hợp lệ (guard không corrupt -> không rơi vào MANIFEST_SCHEMA_UNAVAILABLE).
  const schemaOk = (() => { try { JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')); return true; } catch { return false; } })();
  tru('AC11 schema file hợp lệ (guard)', schemaOk);
}

// AC12: [GPT-REV-073] round-trip up->down lossless, extension field cùng tên metadata KHÔNG bị mất.
{
  const source = {
    schemaVersion: '0.9', projectId: 'ext-proj', repository: 'ext/proj',
    workspace: { workspaceId: 'ext-ws' }, projectType: 'product',
    policy: { version: CANONICAL_POLICY_VERSION }, verify: { adapter: 'pnpm-verify' },
    deploy: { capability: false, humanAuthorization: true },
    telegram: { route: 'default' }, memory: { provider: 'claude-mem', namespace: 'ext-proj' },
    __migrationAdded: { note: 'extension metadata gốc' },
    customExtension: { enabled: true, items: ['a', 'b'] },
  };
  const originalJson = JSON.stringify(source);
  const up = migrateManifest({ manifest: source, toVersion: '1.0' });
  tru('AC12 up ok', up.ok === true);
  // [GPT-REV-075] rollbackPlan versioned + fingerprint-bound, KHÔNG còn mảng `added` tự do.
  const plan = up.rollbackPlan;
  tru('AC12 rollbackPlan có planVersion', plan.planVersion === ROLLBACK_PLAN_VERSION);
  eq('AC12 plan fromVersion/toVersion đúng hướng', `${plan.fromVersion}>${plan.toVersion}`, '0.9>1.0');
  tru('AC12 addedKeys ⊆ allowlist 0.9→1.0', plan.addedKeys.length > 0 && plan.addedKeys.every((k) => UPGRADE_ALLOWED_ADDED_KEYS.includes(k)));
  tru('AC12 fingerprint là sha256 hex 64', /^[a-f0-9]{64}$/.test(plan.fingerprint));
  eq('AC12 fingerprint bám manifest sau up + plan core', plan.fingerprint,
    createHash('sha256').update(JSON.stringify({ manifest: up.manifest, fromVersion: plan.fromVersion, toVersion: plan.toVersion, addedKeys: plan.addedKeys })).digest('hex'));
  falsy('AC12 result không còn field `added` tự do', 'added' in up);
  const down = migrateManifest({ manifest: up.manifest, toVersion: '0.9', rollbackPlan: plan });
  tru('AC12 down ok', down.ok === true);
  eq('AC12 input không mutate sau up+down', JSON.stringify(source), originalJson);
  eq('AC12 down(up(original)) deep-equal tuyệt đối với original', JSON.stringify(down.manifest), originalJson);
  eq('AC12 __migrationAdded giữ nguyên object extension ban đầu',
    JSON.stringify(down.manifest.__migrationAdded), JSON.stringify({ note: 'extension metadata gốc' }));
  eq('AC12 customExtension giữ nguyên',
    JSON.stringify(down.manifest.customExtension), JSON.stringify({ enabled: true, items: ['a', 'b'] }));
  falsy('AC12 up không nhúng metadata rollback theo tên field', plan.addedKeys.includes('__migrationAdded'));
  eq('AC12 mọi key up thêm đều nằm trong addedKeys (không key ẩn)',
    Object.keys(up.manifest).length, Object.keys(source).length + plan.addedKeys.length);
}

// NEG [GPT-REV-075]: rollbackPlan thiếu/rỗng/sửa đổi/sai fingerprint/key lạ/không khớp manifest -> fail-closed, input bất biến.
{
  const srcUp = { schemaVersion: '0.9', projectId: 'rb-proj-2', customField: { v: 2 } };
  const snapUp = JSON.stringify(srcUp);
  const upD = migrateManifest({ manifest: srcUp, toVersion: '1.0' });
  tru('NEG setup up ok', upD.ok === true);
  const good = upD.rollbackPlan;

  // T1: plan thiếu/rỗng/null -> FAIL.
  const d1 = migrateManifest({ manifest: upD.manifest, toVersion: '0.9' });
  falsy('NEG-T1 thiếu plan -> fail-closed', d1.ok);
  eq('NEG-T1 reason ROLLBACK_PLAN_REQUIRED', d1.reason, 'ROLLBACK_PLAN_REQUIRED');
  const d2 = migrateManifest({ manifest: upD.manifest, toVersion: '0.9', rollbackPlan: { ...good, addedKeys: [] } });
  falsy('NEG-T1 addedKeys rỗng -> fail-closed', d2.ok);
  eq('NEG-T1 reason ROLLBACK_PLAN_KEYS_INVALID', d2.reason, 'ROLLBACK_PLAN_KEYS_INVALID');
  const d3 = migrateManifest({ manifest: upD.manifest, toVersion: '0.9', rollbackPlan: null });
  falsy('NEG-T1 plan null -> fail-closed', d3.ok);

  // T2: plan chứa key định danh/schema/extension user -> FAIL.
  for (const k of ['repository', 'projectId', 'schemaVersion', 'customField']) {
    const dk = migrateManifest({ manifest: upD.manifest, toVersion: '0.9', rollbackPlan: { ...good, addedKeys: [...good.addedKeys, k] } });
    falsy(`NEG-T2 plan chứa "${k}" -> fail-closed`, dk.ok);
    eq(`NEG-T2 "${k}" -> ROLLBACK_PLAN_ILLEGAL_KEY`, dk.reason, 'ROLLBACK_PLAN_ILLEGAL_KEY');
  }
  // T3: plan bị sửa key/fingerprint/version -> FAIL.
  const dk3 = migrateManifest({ manifest: upD.manifest, toVersion: '0.9', rollbackPlan: { ...good, addedKeys: ['workspace'] } });
  falsy('NEG-T3 sửa addedKeys -> fail-closed', dk3.ok);
  eq('NEG-T3 sửa addedKeys -> ROLLBACK_PLAN_FINGERPRINT_MISMATCH (fingerprint bám kết quả up)', dk3.reason, 'ROLLBACK_PLAN_FINGERPRINT_MISMATCH');
  const dfp = migrateManifest({ manifest: upD.manifest, toVersion: '0.9', rollbackPlan: { ...good, fingerprint: '0'.repeat(64) } });
  falsy('NEG-T3 sai fingerprint -> fail-closed', dfp.ok);
  eq('NEG-T3 reason ROLLBACK_PLAN_FINGERPRINT_MISMATCH', dfp.reason, 'ROLLBACK_PLAN_FINGERPRINT_MISMATCH');
  const dfpi = migrateManifest({ manifest: upD.manifest, toVersion: '0.9', rollbackPlan: { ...good, fingerprint: 'not-hex' } });
  falsy('NEG-T3 fingerprint sai định dạng -> fail-closed', dfpi.ok);
  eq('NEG-T3 reason ROLLBACK_PLAN_FINGERPRINT_INVALID', dfpi.reason, 'ROLLBACK_PLAN_FINGERPRINT_INVALID');
  const dpv = migrateManifest({ manifest: upD.manifest, toVersion: '0.9', rollbackPlan: { ...good, planVersion: ROLLBACK_PLAN_VERSION + 1 } });
  falsy('NEG-T3 planVersion lạ -> fail-closed', dpv.ok);
  eq('NEG-T3 reason ROLLBACK_PLAN_VERSION_INVALID', dpv.reason, 'ROLLBACK_PLAN_VERSION_INVALID');
  const pdm = migrateManifest({ manifest: upD.manifest, toVersion: '0.9', rollbackPlan: { ...good, toVersion: '1.0', fromVersion: '0.8' } });
  falsy('NEG-T3 hướng migration sai -> fail-closed', pdm.ok);
  eq('NEG-T3 reason ROLLBACK_PLAN_DIRECTION_MISMATCH', pdm.reason, 'ROLLBACK_PLAN_DIRECTION_MISMATCH');

  // T4: dùng plan của manifest A cho manifest B -> FAIL (fingerprint-bound).
  const otherUp = migrateManifest({ manifest: { schemaVersion: '0.9', projectId: 'rb-proj-B', extra: 7 }, toVersion: '1.0' });
  tru('NEG setup B up ok', otherUp.ok === true);
  const dA = migrateManifest({ manifest: upD.manifest, toVersion: '0.9', rollbackPlan: otherUp.rollbackPlan });
  falsy('NEG-T4 plan của B áp cho A -> fail-closed', dA.ok);
  eq('NEG-T4 reason ROLLBACK_PLAN_FINGERPRINT_MISMATCH', dA.reason, 'ROLLBACK_PLAN_FINGERPRINT_MISMATCH');

  // Plan nguyên vẹn do up() phát hành -> down ok, lossless; input bất biến qua mọi lần gọi.
  const dOk = migrateManifest({ manifest: upD.manifest, toVersion: '0.9', rollbackPlan: good });
  tru('NEG-T5 plan nguyên vẹn -> down ok', dOk.ok === true);
  eq('NEG-T5 down(up(original)) deep-equal tuyệt đối original', JSON.stringify(dOk.manifest), snapUp);
  eq('NEG source gốc 0.9 không bị down đụng tới', JSON.stringify(srcUp), snapUp);
}

// NEG [GPT-REV-076]: path migration bị giới hạn chính xác 0.9 <-> 1.0; mọi path khác fail-closed;
// rollbackPlan.toVersion phải khớp manifest.schemaVersion (sau up = 1.0) và plan mang hướng 1.0 -> 0.9.
{
  // UP: chỉ chấp nhận nguồn 0.9, đích 1.0.
  const up0_9 = migrateManifest({ manifest: { schemaVersion: '0.9', projectId: 'p-076a' }, toVersion: '1.0' });
  tru('076 up 0.9->1.0 ok', up0_9.ok === true);
  eq('076 good plan toVersion == 1.0 (khớp manifest.schemaVersion)', up0_9.rollbackPlan.toVersion, '1.0');
  const up0_9_2 = migrateManifest({ manifest: { schemaVersion: '0.9', projectId: 'p-076b' }, toVersion: '2.0' });
  falsy('076 up 0.9->2.0 (đích lạ) -> fail-closed', up0_9_2.ok);
  eq('076 reason UNSUPPORTED_MIGRATION_PATH (đích 2.0)', up0_9_2.reason, 'UNSUPPORTED_MIGRATION_PATH');
  const up1_0 = migrateManifest({ manifest: { schemaVersion: '1.0', projectId: 'p-076c' }, toVersion: '1.0' });
  tru('076 up nguồn 1.0, đích 1.0 -> none (đã ở đích, idempotent)', up1_0.ok === true && up1_0.direction === 'none');
  const up0_8 = migrateManifest({ manifest: { schemaVersion: '0.8', projectId: 'p-076c2' }, toVersion: '1.0' });
  falsy('076 up nguồn 0.8 (không phải 0.9) -> fail-closed', up0_8.ok);
  eq('076 reason UNSUPPORTED_MIGRATION_PATH (nguồn 0.8)', up0_8.reason, 'UNSUPPORTED_MIGRATION_PATH');
  // same-version paths: chỉ 1.0->1.0 idempotent; version lạ bằng nhau -> fail-closed + input bất biến.
  const snap0808 = JSON.stringify({ schemaVersion: '0.8', projectId: 'p-076f' });
  const s0808 = JSON.parse(snap0808);
  const m0808 = migrateManifest({ manifest: s0808, toVersion: '0.8' });
  falsy('076 up 0.8->0.8 (version lạ) -> fail-closed', m0808.ok);
  eq('076 reason UNSUPPORTED_MIGRATION_PATH (0.8->0.8)', m0808.reason, 'UNSUPPORTED_MIGRATION_PATH');
  eq('076 input 0.8->0.8 bất biến', JSON.stringify(s0808), snap0808);
  const snap0909 = JSON.stringify({ schemaVersion: '0.9', projectId: 'p-076g' });
  const s0909 = JSON.parse(snap0909);
  const m0909 = migrateManifest({ manifest: s0909, toVersion: '0.9' });
  falsy('076 up 0.9->0.9 (version lạ) -> fail-closed', m0909.ok);
  eq('076 reason UNSUPPORTED_MIGRATION_PATH (0.9->0.9)', m0909.reason, 'UNSUPPORTED_MIGRATION_PATH');
  eq('076 input 0.9->0.9 bất biến', JSON.stringify(s0909), snap0909);
  const snap2 = JSON.stringify({ schemaVersion: '2.0', projectId: 'p-076h' });
  const s2 = JSON.parse(snap2);
  const m2 = migrateManifest({ manifest: s2, toVersion: '2.0' });
  falsy('076 up 2.0->2.0 (version lạ) -> fail-closed', m2.ok);
  eq('076 reason UNSUPPORTED_MIGRATION_PATH (2.0->2.0)', m2.reason, 'UNSUPPORTED_MIGRATION_PATH');
  eq('076 input 2.0->2.0 bất biến', JSON.stringify(s2), snap2);
  const up2_0 = migrateManifest({ manifest: { schemaVersion: '2.0', projectId: 'p-076d' }, toVersion: '1.0' });
  falsy('076 up nguồn 2.0 -> fail-closed', up2_0.ok);
  eq('076 reason UNSUPPORTED_MIGRATION_PATH (nguồn 2.0)', up2_0.reason, 'UNSUPPORTED_MIGRATION_PATH');

  // DOWN: chỉ chấp nhận nguồn 1.0 (hiện tại), đích 0.9.
  const dSrc2 = migrateManifest({ manifest: { schemaVersion: '2.0', projectId: 'p-076e' }, toVersion: '0.9' });
  falsy('076 down nguồn 2.0 -> fail-closed', dSrc2.ok);
  eq('076 reason UNSUPPORTED_MIGRATION_PATH (down nguồn 2.0)', dSrc2.reason, 'UNSUPPORTED_MIGRATION_PATH');
  // plan mang đích 2.0 (dù từ 1.0) -> DIRECTION_MISMATCH.
  const dTo2 = migrateManifest({ manifest: up0_9.manifest, toVersion: '0.9', rollbackPlan: { ...up0_9.rollbackPlan, toVersion: '2.0' } });
  falsy('076 down 1.0->2.0 (đích lạ) -> fail-closed', dTo2.ok);
  eq('076 reason ROLLBACK_PLAN_DIRECTION_MISMATCH (đích 2.0)', dTo2.reason, 'ROLLBACK_PLAN_DIRECTION_MISMATCH');
  // plan mang hướng 0.9->2.0 -> DIRECTION_MISMATCH.
  const dPath0_9to2 = migrateManifest({ manifest: up0_9.manifest, toVersion: '0.9', rollbackPlan: { ...up0_9.rollbackPlan, fromVersion: '0.9', toVersion: '2.0' } });
  falsy('076 down plan 0.9->2.0 -> fail-closed', dPath0_9to2.ok);
  eq('076 reason ROLLBACK_PLAN_DIRECTION_MISMATCH (plan 0.9->2.0)', dPath0_9to2.reason, 'ROLLBACK_PLAN_DIRECTION_MISMATCH');
  // plan hợp lệ path 1.0->0.9 vẫn down ok (lossless).
  const dOk = migrateManifest({ manifest: up0_9.manifest, toVersion: '0.9', rollbackPlan: up0_9.rollbackPlan });
  tru('076 down path 1.0->0.9 (plan đúng) ok', dOk.ok === true);
  eq('076 down khôi phục schemaVersion 0.9', dOk.manifest.schemaVersion, '0.9');
}

// AC13: [GPT-REV-074] registerProject: input nguyên vẹn ở MỌI đường + persistence giữ extension field.
{
  const reg = { schemaVersion: '1.0', projects: [] };
  const base = {
    schemaVersion: '1.0', projectId: 'mut-proj', repository: 'mut/proj',
    workspace: { workspaceId: 'mut-ws' }, projectType: 'product',
    policy: { version: CANONICAL_POLICY_VERSION }, verify: { adapter: 'pnpm-verify' },
    deploy: { capability: false, humanAuthorization: true },
    telegram: { route: 'default' }, memory: { provider: 'claude-mem', namespace: 'mut-proj' },
    __migrationAdded: { note: 'extension hợp lệ' },
    customExtension: { keep: true },
  };
  const snapBase = JSON.stringify(base);
  // validation failure: input không mutate.
  const badVal = JSON.parse(snapBase); delete badVal.repository;
  const snapBadVal = JSON.stringify(badVal);
  const rv = registerProject({ manifest: badVal, registry: reg, registryPath: tmpPath, actualRemote: 'https://github.com/mut/proj.git' });
  falsy('AC13 validation failure -> reject', rv.ok);
  eq('AC13 input không mutate khi validation fail', JSON.stringify(badVal), snapBadVal);
  // conflict: input không mutate.
  const regDup = { schemaVersion: '1.0', projects: [JSON.parse(snapBase)] };
  const mConflict = JSON.parse(snapBase); mConflict.projectId = 'other-proj'; mConflict.telegram = { route: 'default' };
  const snapConflict = JSON.stringify(mConflict);
  const rc2 = registerProject({ manifest: mConflict, registry: regDup, registryPath: tmpPath, actualRemote: 'https://github.com/other/proj.git' });
  falsy('AC13 conflict telegramRoute -> reject', rc2.ok);
  eq('AC13 input không mutate khi conflict', JSON.stringify(mConflict), snapConflict);
  // remote mismatch: input không mutate.
  const mRemote = JSON.parse(snapBase);
  const rr = registerProject({ manifest: mRemote, registry: reg, registryPath: tmpPath, actualRemote: 'https://github.com/evil/repo.git' });
  falsy('AC13 remote lệch -> reject', rr.ok);
  eq('AC13 input không mutate khi remote mismatch', JSON.stringify(mRemote), snapBase);
  // registration thành công: input không mutate + persisted giữ nguyên extension field.
  const r2 = registerProject({ manifest: base, registry: reg, registryPath: tmpPath, actualRemote: 'https://github.com/mut/proj.git' });
  tru('AC13 remote đúng -> ok', r2.ok);
  eq('AC13 input không mutate sau register thành công', JSON.stringify(base), snapBase);
  const loaded = loadRegistry({ registryPath: tmpPath });
  const saved = loaded.projects.find((p) => p.projectId === 'mut-proj');
  tru('AC13 persisted tìm thấy project', Boolean(saved));
  eq('AC13 persisted __migrationAdded nguyên vẹn',
    JSON.stringify(saved.__migrationAdded), JSON.stringify({ note: 'extension hợp lệ' }));
  eq('AC13 persisted customExtension nguyên vẹn',
    JSON.stringify(saved.customExtension), JSON.stringify({ keep: true }));
}

const pass = checks.filter((c) => c.ok).length;
for (const c of checks) if (!c.ok) console.log('FAIL', c.name, '=>', JSON.stringify(c.got), 'want', JSON.stringify(c.want));
console.log(`\nTổng: ${pass}/${checks.length} PASS`);
process.exit(pass === checks.length ? 0 : 1);

