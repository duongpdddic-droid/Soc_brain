import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAdvisorConsultationPrompt,
  parseAdvisorResponse
} from '../packages/control-loop/advisor-payload.mjs';

test('SMOKE: Advisor payload packaging on simulated verification failure', () => {
  // Gia lap mot session dang executing gap loi test
  const session = {
    repo: 'duongpdddic-droid/Soc_brain',
    issueNumber: 999,
    prNumber: 88,
    goal: 'Test autonomous advisor rework trigger'
  };

  const simulatedFailingLog = `
TAP version 13
# Subtest: critical logic test
not ok 1 - expected status 200 but got 500
  AssertionError: 500 == 200
    at verifyHandler (file:///app.mjs:42:10)
`;

  const simulatedDiff = `
diff --git a/app.mjs b/app.mjs
index 1111111..2222222 100644
--- a/app.mjs
+++ b/app.mjs
@@ -40,3 +40,3 @@
- return 200;
+ return 500;
`;

  // 1. Dong goi payload 5 khoi
  const packResult = buildAdvisorConsultationPrompt({
    session,
    errorSummary: 'Simulated HTTP 500 assertion failure',
    testLog: simulatedFailingLog,
    diff: simulatedDiff
  });

  assert.equal(packResult.ok, true, 'Packaging must succeed');
  assert.match(packResult.value.prompt, /HTTP 500 assertion failure/);
  assert.match(packResult.value.prompt, /return 500/);

  // 2. Gia lap phan hoi tu Advisor Web2API
  const advisorMockReply = 'Sua dong 42 trong app.mjs: thay return 500 thanh return 200 de khop status contract.';
  const parseResult = parseAdvisorResponse(advisorMockReply);

  assert.equal(parseResult.ok, true, 'Parsing advisor response must succeed');
  assert.match(parseResult.value.guidance, /return 200/);
});
