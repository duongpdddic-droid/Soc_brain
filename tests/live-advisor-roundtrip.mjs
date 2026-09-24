import { buildAdvisorConsultationPrompt, parseAdvisorResponse } from '../packages/control-loop/advisor-payload.mjs';
import { createGeminiWeb2ApiAdvisorTransport } from '../packages/control-loop/gemini-plus-web2api-copy.mjs';

async function run() {
  console.log('[LIVE ADVISOR] Bat dau gui yeu cau tham van den Gemini qua Chrome CDP 9222...');
  
  const session = {
    repo: 'duongpdddic-droid/Soc_brain',
    issueNumber: 105,
    prNumber: 99,
    goal: 'Test Live Web2API Advisor Consultation',
    headSha: 'c0ffee1234567890'
  };

  const pack = buildAdvisorConsultationPrompt({
    session,
    errorSummary: 'Module not found during runner execution',
    testLog: 'not ok 1 - Cannot find module advisor-payload.mjs',
    diff: '+ const x = 1;',
    question: 'Huong dan cach sua duong dan import chuan monorepo.'
  });

  const transport = await createGeminiWeb2ApiAdvisorTransport({
    cdpPort: 9222,
    log: (msg) => console.log(`[CDP] ${msg}`)
  });

  const startTime = Date.now();
  const res = await transport({
    prompt: pack.value.prompt,
    reviewPrompt: pack.value.prompt,
    session
  });

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`[LIVE ADVISOR] Nhan ket qua sau ${durationSec}s. Status ok=${res.ok}`);

  if (res.ok) {
    const parsed = parseAdvisorResponse(res.guidance || res.text);
    console.log('\n=== [TRICH DOAN CHI DAN CUA ADVISOR] ===');
    console.log(parsed.value.guidance.slice(0, 400) + '...\n');
    console.log('[KET LUAN] => HOAN TAT VONG LAP THAM VAN ADVISOR KHONG CAN VERDICT!');
  } else {
    console.error('[LIVE ADVISOR ERROR]', res);
    process.exit(1);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
