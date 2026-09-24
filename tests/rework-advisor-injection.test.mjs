import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReworkRecord, buildReworkInstruction } from '../packages/control-loop/rework.mjs';

test('REWORK: buildReworkInstruction renders advisorGuidance when present', () => {
  const session = { repo: 'duongpdddic-droid/Soc_brain', issueNumber: 101 };
  const record = buildReworkRecord({
    identityHash: 'hash123',
    round: 1,
    digest: 'digest4567890123',
    decision: {
      binding: { headSha: 'abcdef123456' },
      findings: ['Test assertion failure at line 42'],
      evidenceRequests: [],
      advisorGuidance: 'Sua dong 42: thay status 500 bang 200 de khop contract monorepo.'
    }
  });

  assert.equal(record.advisorGuidance, 'Sua dong 42: thay status 500 bang 200 de khop contract monorepo.');

  const instruction = buildReworkInstruction({ session, record });
  assert.match(instruction, /Advisor Guidance \(Root Cause Analysis & Direct Fix\):/);
  assert.match(instruction, /Sua dong 42: thay status 500 bang 200/);
  assert.match(instruction, /Findings \(verbatim from the validated review\):/);
});

test('REWORK: buildReworkInstruction preserves legacy format when advisorGuidance is absent', () => {
  const session = { repo: 'duongpdddic-droid/Soc_brain', issueNumber: 102 };
  const record = buildReworkRecord({
    identityHash: 'hash456',
    round: 1,
    digest: 'digest9876543210',
    decision: {
      binding: { headSha: 'fedcba654321' },
      findings: ['Legacy finding without advisor'],
      evidenceRequests: []
    }
  });

  assert.equal(record.advisorGuidance, null);
  const instruction = buildReworkInstruction({ session, record });
  assert.doesNotMatch(instruction, /Advisor Guidance/);
  assert.match(instruction, /Legacy finding without advisor/);
});
