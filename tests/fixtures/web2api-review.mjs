import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { persistReviewRequest, persistReviewResponse, claimReviewSubmit } from '../../packages/control-loop/web2api-review-provenance.mjs';
import { normalizeExtractedReply } from '../../packages/control-loop/gemini-plus-web2api-copy.mjs';

export function reviewFixture({ session = { repo: 'duongpdddic-droid/soc_brain', issueNumber: 69, prNumber: 263, headSha: 'a'.repeat(40) }, findings = ['Finding 1: defect'], remediation = ['Repair the defect completely.'], evidenceRequests = [], confidence = null, verdict = 'CHANGES_REQUESTED', analysis = 'DIFF ANALYSIS & CODE INSPECTION', payloadOverrides = {} } = {}) {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web2api-review-test-'));
  const prepared = persistReviewRequest({ session, prompt: 'Full diff and tests', storeDir });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const { requestPath, responsePath, ...echo } = prepared.value;
  const payload = { ...echo, findings, remediation, evidenceRequests, confidence, ...payloadOverrides };
  const rawText = `Gemini đã nói\n${analysis}\nREVIEW_PAYLOAD_BEGIN\n${JSON.stringify(payload)}\nREVIEW_PAYLOAD_END\nVERDICT: ${verdict}`;
  const response = { ok: true, rawText, text: normalizeExtractedReply(rawText), newTurnId: 'r-new', targetId: 'target-review', conversationId: 'conversation-review', beforeTurnIds: ['r-old'], afterTurnIds: ['r-old', 'r-new'], metadata: { pollTimeout: false } };
  return { storeDir, session, payload, response, ctx: { session, prompt: prepared.prompt, reviewRequest: prepared.value }, cleanup: () => fs.rmSync(storeDir, { recursive: true, force: true }) };
}

export function persistedDecision(fixture) {
  assert.equal(claimReviewSubmit(fixture.ctx.reviewRequest).ok, true);
  assert.equal(persistReviewResponse({ request: fixture.ctx.reviewRequest, response: fixture.response }).ok, true);
  return { verdict: fixture.response.rawText.endsWith('APPROVED') ? 'PASS' : 'REWORK', rawText: fixture.response.rawText, newTurnId: fixture.response.newTurnId, provenance: fixture.ctx.reviewRequest, binding: fixture.payload.binding, findings: fixture.payload.findings, remediation: fixture.payload.remediation, evidenceRequests: fixture.payload.evidenceRequests, confidence: fixture.payload.confidence };
}
