#!/usr/bin/env node
// scripts/export-step-guide.mjs — render docs/step-transition-guide.md from
// the step-contract schema (single source of truth).
//
//   node scripts/export-step-guide.mjs           regenerate the guide
//   node scripts/export-step-guide.mjs --check   exit 1 if the guide drifted
//
// The guide is the context-loading document for Reviewers (AI/Human) and the
// operator: transition cycle, per-step prerequisite/field catalog with format
// norms, and the REMEDIATION_REQUIRED fill-in playbook. It is GENERATED — the
// test suite (T8) byte-compares it against renderStepGuide() so the document
// can never drift from the schema.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  STEP_CONTRACT,
  STEP_STATE_RELATIVE_PATH,
  STEP_STATE_SAMPLE_RELATIVE_PATH,
  STEP_STATE_STATUSES,
  STEP_SESSION_PHASES,
  STEP_CONTRACT_SCHEMA_VERSION,
  FIELDS,
  FIELD_FORMATS,
} from '../packages/control-loop/step-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const GUIDE_PATH = path.join(ROOT, 'docs', 'step-transition-guide.md');

export function renderStepGuide() {
  const L = [];
  L.push('# Step Transition Guide — tự bổ sung tại chỗ, không dừng, không Block');
  L.push('');
  L.push('> GENERATED từ `packages/control-loop/step-contract.mjs` bởi');
  L.push('> `node scripts/export-step-guide.mjs` — **không sửa tay** (test T8 byte-so khớp).');
  L.push('> Document nạp context cho Reviewer (AI/Human) và Bố Dương.');
  L.push('');
  L.push(`- schemaVersion: \`${STEP_CONTRACT_SCHEMA_VERSION}\``);
  L.push(`- sổ cái trạng thái: \`${STEP_STATE_RELATIVE_PATH}\``);
  L.push(`- status hợp lệ: ${STEP_STATE_STATUSES.map((s) => `\`${s}\``).join(', ')} (không có \`BLOCKED\`)`);
  L.push(`- sessionPhase: ${STEP_SESSION_PHASES.map((s) => `\`${s}\``).join(', ')}`);
  L.push('');

  L.push('## 1. Triết lý: Fail đâu bổ sung đó — Remediation over Blocking');
  L.push('');
  L.push('Khi preflight chuyển bước phát hiện trường **thiếu** hoặc **sai format**, hệ thống:');
  L.push('');
  L.push('1. **Không** ném lỗi hard-stop, **không** ghi `BLOCKED`;');
  L.push('2. Ghi sổ cái `.soc/step-state.json` với `status: REMEDIATION_REQUIRED`,');
  L.push('   `sessionPhase: AWAITING_FIELDS`, giữ nguyên `currentStep` (không nhảy cóc),');
  L.push('   nêu đích danh `missingFields` / `invalidFields` kèm `remediationHint`;');
  L.push('3. Executor điền đúng các trường đó rồi **gọi lại cùng transition** —');
  L.push('   trường đã hợp lệ trước đó được **merge cộng dồn (additive)**, không mất gì;');
  L.push('4. Ngay khi preflight pass 100% → `status: READY`, `currentStep` tiến bước,');
  L.push('   transition chạy tiếp mượt mà — không khởi động lại từ đầu.');
  L.push('');

  L.push('## 2. Sơ đồ chu trình chuyển bước & cơ chế tự bổ sung tại chỗ');
  L.push('');
  L.push('```');
  L.push('ACCEPTED → ROUTED → EXECUTING → VERIFYING → PRE_REVIEWING → FINAL_REVIEWING');
  L.push('                                                                  ↓');
  L.push('              COMPLETED ← DELIVERING ← DECIDING ←─────────────────┘');
  L.push('');
  L.push('  verdict PASS:   DECIDING → DELIVERING → COMPLETED');
  L.push('  rework legs:    VERIFYING / DECIDING / BLOCKED → REWORK → EXECUTING');
  L.push('  escalation:     any live step → BLOCKED (canonical FSM edge only)');
  L.push('```');
  L.push('');
  L.push('Cơ chế tự bổ sung (in-place remediation loop):');
  L.push('');
  L.push('```');
  L.push(' attemptStepTransition(from, to, fields)');
  L.push('        │');
  L.push('        ├─ field thiếu/sai ──► status=REMEDIATION_REQUIRED');
  L.push('        │                      sessionPhase=AWAITING_FIELDS');
  L.push('        │                      currentStep=from (giữ chỗ, không nhảy cóc)');
  L.push('        │                      ghi .soc/step-state.json ──► executor điền trường');
  L.push('        │                              │');
  L.push('        │                              └── gọi lại attempt (merge additive) ──┐');
  L.push('        │                                                                      │');
  L.push('        └─ field đủ & đúng ──► status=READY, currentStep=to ◄─────────────────┘');
  L.push('                                transition hợp lệ được phép thực thi');
  L.push('```');
  L.push('');

  L.push('## 3. Danh mục từng bước (tên bước · điều kiện tiên quyết · trường bắt buộc)');
  L.push('');
  for (const step of STEP_CONTRACT) {
    L.push(`### ${step.name}`);
    L.push('');
    const prereq = step.prerequisites.length
      ? step.prerequisites.map((p) => `\`${p}\``).join(', ')
      : '_(entry — không có bước trước)_';
    L.push(`- **Điều kiện tiên quyết:** ${prereq}`);
    L.push('- **Trường bắt buộc:**');
    L.push('');
    L.push('| Trường | Format (quy chuẩn) | Mô tả |');
    L.push('| --- | --- | --- |');
    for (const name of step.fields) {
      const spec = FIELDS[name];
      const fmt = FIELD_FORMATS[spec.format];
      const values = spec.values ? ` · nhận ${spec.values.map((v) => `\`${v}\``).join(' \\| ')}` : '';
      L.push(`| \`${name}\` | ${fmt.label}${values} | ${spec.description} |`);
    }
    L.push('');
  }

  L.push('## 4. Bảng quy chuẩn format (toàn bộ)');
  L.push('');
  L.push('| Format id | Quy chuẩn | Áp dụng cho |');
  L.push('| --- | --- | --- |');
  for (const [id, fmt] of Object.entries(FIELD_FORMATS)) {
    const names = Object.entries(FIELDS).filter(([, s]) => s.format === id).map(([n]) => `\`${n}\``);
    L.push(`| \`${id}\` | ${fmt.label} | ${names.join(', ')} |`);
  }
  L.push('');
  L.push('Ghi chú chung:');
  L.push('');
  L.push('- `40-hex SHA` / `SHA-256`: 40/64 ký tự hex, không phân biệt hoa thường (thuần về chữ thường khi lưu);');
  L.push('- `integer PID` / `exit code` / `positive integer`: phải là **số nguyên** (chuỗi số bị từ chối);');
  L.push('- `path`: chuỗi khác rỗng, không chứa NUL;');
  L.push('- `verdict`: enum đóng, phân biệt hoa thường;');
  L.push('- trường lạ (không có trong registry) không bao giờ được thu thập.');
  L.push('');

  L.push(`## 5. Xử lý \`${'REMEDIATION_REQUIRED'}\` — cách bù thông tin để chạy tiếp`);
  L.push('');
  L.push(`1. Đọc \`${STEP_STATE_RELATIVE_PATH}\` (JSON):`);
  L.push('   - `currentStep` / `targetStep`: bước đang giữ và bước định chuyển tới;');
  L.push('   - `missingFields`: danh sách trường **chưa có** — cần cấp đủ;');
  L.push('   - `invalidFields`: các trường **đã cấp nhưng sai format** — từng entry kèm lý do cụ thể;');
  L.push('   - `remediationHint`: chỉ dẫn ngắn gọn cách cấp đúng để pass;');
  L.push('   - `collectedFields`: các trường đã hợp lệ từ lần thử trước (đã lưu, không mất).');
  L.push('2. Bổ sung/sửa đúng các trường đó theo bảng quy chuẩn ở mục 3–4.');
  L.push('3. Gọi lại `attemptStepTransition` với **cùng** `from`/`to` — giá trị mới hợp lệ');
  L.push('   được validate trước khi ghi đè `collectedFields` (merge cộng dồn: trường hợp lệ');
  L.push('   cũ được giữ, chỉ giá trị mới hợp lệ mới thay thế); giá trị sai của lần gọi hiện');
  L.push('   tại bị báo `invalidFields` + `REMEDIATION_REQUIRED` nhưng **không xóa** trường');
  L.push('   hợp lệ đã thu — preflight lại và tự chuyển bước khi đạt, **không cần khởi động');
  L.push('   lại tiến trình**.');
  L.push('4. Không bao giờ tự ý nhảy cóc: transition sang bước không thuộc');
  L.push('   `prerequisites` của đích bị từ chối typed (`STEP_TRANSITION_INVALID`),');
  L.push('   bản ghi remediation đang giữ không bị ghi đè.');
  L.push('');
  L.push(`Ví dụ bản ghi mẫu (fixture \`${STEP_STATE_SAMPLE_RELATIVE_PATH}\` — trạng thái runtime KHÔNG được commit):`);
  L.push('');
  L.push('```json');
  const sample = JSON.parse(fs.readFileSync(path.join(ROOT, STEP_STATE_SAMPLE_RELATIVE_PATH), 'utf8'));
  L.push(JSON.stringify(sample, null, 2));
  L.push('```');
  L.push('');
  L.push('---');
  L.push('');
  L.push('_Sổ cái `.soc/step-state.json` chỉ là kênh điều phối preflight giữa Executor');
  L.push('và Soc Control Loop: nó không cấp thẩm quyền, không tự chuyển FSM, không');
  L.push('thay thế ledger phiên. Trạng thái vòng đời canonical vẫn do control-loop.mjs');
  L.push('(LOOP_STATES / ALLOWED_TRANSITIONS) quản lý — test T11 khóa đồng bộ giữa');
  L.push('hai bảng này, test T8 khóa đồng bộ giữa tài liệu này và schema._');

  return `${L.join('\n')}\n`;
}

function main() {
  const check = process.argv.includes('--check');
  const rendered = renderStepGuide();
  if (check) {
    let onDisk = '';
    try {
      onDisk = fs.readFileSync(GUIDE_PATH, 'utf8');
    } catch {
      console.error(`[export-step-guide] MISSING ${path.relative(ROOT, GUIDE_PATH)} — run: node scripts/export-step-guide.mjs`);
      process.exit(1);
    }
    if (onDisk.replace(/\r\n/g, '\n') !== rendered.replace(/\r\n/g, '\n')) {
      console.error(`[export-step-guide] DRIFT ${path.relative(ROOT, GUIDE_PATH)} — run: node scripts/export-step-guide.mjs`);
      process.exit(1);
    }
    console.log(`[export-step-guide] OK ${path.relative(ROOT, GUIDE_PATH)} in sync`);
    return;
  }
  fs.mkdirSync(path.dirname(GUIDE_PATH), { recursive: true });
  fs.writeFileSync(GUIDE_PATH, rendered, 'utf8');
  console.log(`[export-step-guide] wrote ${path.relative(ROOT, GUIDE_PATH)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
