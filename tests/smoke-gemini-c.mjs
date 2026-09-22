import assert from 'node:assert/strict';
import { createGeminiFinalReviewFallbackTransport } from '../packages/control-loop/gemini-plus-web2api-copy.mjs';

console.log('--- BẮT ĐẦU SMOKE TEST GEMINI FALLBACK TRANSPORT (CÁCH C) ---');

const transport = createGeminiFinalReviewFallbackTransport({ timeoutMs: 90000 });

const prompt = `Bạn là FINAL REVIEWER cho dự án Soc_brain (repo: duongpdddic-droid/Soc_brain). PR #204. Hãy đưa ra nhận xét theo AGENTS.md.`;

console.log('1. Đang gửi prompt review tới Gemini qua CDP...');
const res = await transport({ prompt });

console.log('2. Kết quả trả về từ Transport:');
console.log({
  ok: res.ok,
  conversationId: res.conversationId,
  modelSlug: res.modelSlug,
  textLength: res.text ? res.text.length : 0
});

assert.equal(res.ok, true, 'Transport phải trả về ok: true');
assert.ok(typeof res.text === 'string' && res.text.length > 0, 'Phải nhận được text từ clipboard');

// Kiểm tra nội dung Reviewer xuất ra theo đúng quy chuẩn AGENTS.md
assert.ok(res.text.includes('Fail-Closed') || res.text.includes('FAIL-CLOSED'), 'Phải thể hiện nguyên tắc Fail-Closed');
assert.ok(res.text.includes('pr-204-diff.zip'), 'Phải yêu cầu artifact pr-204-diff.zip');
assert.ok(res.text.includes('pr-204-changes.diff'), 'Phải yêu cầu artifact pr-204-changes.diff');
assert.ok(res.text.includes('status:in-progress'), 'Phải có chỉ dẫn nhãn status:in-progress');

console.log('\n>>> KẾT QUẢ: TEST CÁCH C THÀNH CÔNG 100%! TRANSPORT VẬN HÀNH HOÀN HẢO! <<<');
