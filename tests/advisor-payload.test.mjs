import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADVISOR_PAYLOAD_SCHEMA_VERSION,
  extractFailureLog,
  buildAdvisorConsultationPrompt,
  parseAdvisorResponse
} from '../packages/control-loop/advisor-payload.mjs';

test('A1. extractFailureLog extracts not-ok lines and collapses noise', () => {
  const noisyLog = `
ok 1 - setup ok
ok 2 - fixture ready
not ok 3 - verifier failed with code 1
  AssertionError [ERR_ASSERTION]: Expected 0 == 1
    at TestContext.<anonymous> (file:///test.js:10:5)
ok 4 - cleanup ok
`;
  const extracted = extractFailureLog(noisyLog);
  assert.match(extracted, /not ok 3 - verifier failed/);
  assert.match(extracted, /AssertionError/);
  assert.doesNotMatch(extracted, /ok 1 - setup ok/);
});

test('A2. extractFailureLog handles empty input gracefully', () => {
  assert.equal(extractFailureLog(''), '(no failure logs provided)');
  assert.equal(extractFailureLog(null), '(no failure logs provided)');
});

test('B1. buildAdvisorConsultationPrompt structures the 5 canonical blocks', () => {
  const session = {
    repo: 'duongpdddic-droid/Soc_brain',
    issueNumber: 101,
    prNumber: 42,
    goal: 'Streamline Web2API transport'
  };
  const testLog = 'not ok 1 - syntax error in runner';
  const diff = '+ const bad = 1;';

  const res = buildAdvisorConsultationPrompt({
    session,
    errorSummary: 'Test suite failed on runner syntax',
    testLog,
    diff
  });

  assert.equal(res.ok, true);
  assert.equal(res.value.schemaVersion, ADVISOR_PAYLOAD_SCHEMA_VERSION);
  assert.match(res.value.prompt, /\[CONTEXT & CONTRACT\]/);
  assert.match(res.value.prompt, /duongpdddic-droid\/Soc_brain/);
  assert.match(res.value.prompt, /\[EXACT BOTTLENECK \/ FAILURE LOG\]/);
  assert.match(res.value.prompt, /Test suite failed on runner syntax/);
  assert.match(res.value.prompt, /\[CURRENT WORKTREE DIFF\]/);
  assert.match(res.value.prompt, /\+ const bad = 1;/);
  assert.match(res.value.prompt, /\[RULE INVARIANTS\]/);
  assert.match(res.value.prompt, /\[DIRECT QUESTION TO ADVISOR\]/);
});

test('C1. parseAdvisorResponse extracts clean guidance', () => {
  const sampleAdvice = 'Ban can sua lai phuong thuc extractFailureLog de bo sung regex.';
  const res = parseAdvisorResponse(sampleAdvice);
  assert.equal(res.ok, true);
  assert.equal(res.value.guidance, sampleAdvice);

  const emptyRes = parseAdvisorResponse('   ');
  assert.equal(emptyRes.ok, false);
  assert.equal(emptyRes.code, 'ADVISOR_RESPONSE_EMPTY');
});
