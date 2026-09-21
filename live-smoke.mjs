#!/usr/bin/env node
// live-smoke.mjs — Minimal bounded integration smoke for Issue #197 S3 bootstrap.
// Run on operator's Windows host with Web2API at 127.0.0.1:8081 and CDP at 127.0.0.1:9224.
// Uses CHINH production module: packages/control-loop/chatgpt-plus-web2api-copy.mjs.

import { createChatGptPlusWeb2ApiCopyTransport } from './packages/control-loop/chatgpt-plus-web2api-copy.mjs';

// Unique nonce for this smoke run (prevents stale clipboard/old response confusion)
const SMOKE_NONCE = `SMOKE-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

// EXPLICIT prompt: ChatGPT MUST output EXACTLY ONE fenced JSON code block with nonce+source.
// No prose, no markdown outside the fence, no extra code blocks.
const prompt = `OUTPUT ONLY THIS JSON CODE BLOCK - NOTHING ELSE:

\`\`\`json
{
  "nonce": "${SMOKE_NONCE}",
  "source": "s3-web2api-copy-smoke"
}
\`\`\`

RULES:
- Your ENTIRE response must be the code block above.
- NO text before, after, or outside the fence.
- NO explanations, NO apologies, NO formatting, NO markdown outside the fence.
- This is the ONLY code block in your response.`;

async function main() {
  console.log('=== S3 Bootstrap Live Smoke ===');
  console.log('Nonce:', SMOKE_NONCE);

  const transport = createChatGptPlusWeb2ApiCopyTransport({
    web2apiHost: '127.0.0.1',
    web2apiPort: 8081,
    cdpPort: 9224,
    model: 'auto',
    fetchImpl: globalThis.fetch,
  });

  try {
    console.log('Sending transport request (exactly ONE submit)...');
    const result = await transport({ prompt });

    console.log('Transport result:');
    console.log('  ok:', result.ok);
    console.log('  code:', result.code);
    console.log('  text (copied payload):', result.text);
    console.log('  conversationId:', result.conversationId);
    console.log('  modelSlug:', result.modelSlug);
    console.log('  submitUncertain:', result.submitUncertain);
    console.log('  reconcileRequired:', result.reconcileRequired);
    console.log('  safeToRetry:', result.safeToRetry);
    console.log('  transportMeta:', JSON.stringify(result.transportMeta, null, 2));

    let clipboardText = '';
    try {
      const { execSync } = await import('child_process');
      clipboardText = execSync('powershell.exe -NoProfile -NonInteractive -Command "Get-Clipboard -Raw"', {
        encoding: 'utf8',
        timeout: 10000,
      })
        .replace(/\r\n/g, '\n')
        .trim();
      console.log('Clipboard read (PowerShell):', clipboardText ? 'has content (' + clipboardText.length + ' chars)' : 'empty');
    } catch (e) {
      console.log('Clipboard read failed:', e.message);
    }

    const postCount = result.transportMeta && result.transportMeta.postCount !== undefined
      ? Number(result.transportMeta.postCount)
      : null;

    if (!Number.isInteger(postCount) || postCount < 0) {
      console.log('=== INSTRUMENTATION ERROR ===');
      console.log('postCount missing or non-integer:', result.transportMeta?.postCount);
      process.exit(3);
    }

    const submitCount = postCount;
    const resubmitCount = Math.max(0, postCount - 1);

    console.log('');
    console.log('=== VERIFICATION ===');
    console.log('postCount:', postCount);
    console.log('submitCount:', submitCount);
    console.log('resubmitCount:', resubmitCount);

    let parsedPayload = null;
    try {
      parsedPayload = JSON.parse(clipboardText);
    } catch {
      parsedPayload = null;
    }
    const nonceMatch = parsedPayload && parsedPayload.nonce === SMOKE_NONCE;
    const sourceMatch = parsedPayload && parsedPayload.source === 's3-web2api-copy-smoke';
    const verifiedPayload = nonceMatch && sourceMatch;

    console.log('Copied payload nonce matches:', nonceMatch ? 'PASS' : 'FAIL');
    console.log('Copied payload source matches:', sourceMatch ? 'PASS' : 'FAIL');
    console.log('Verified payload (nonce && source):', verifiedPayload ? 'PASS' : 'FAIL');

    console.log('');
    if (postCount === 1 && submitCount === 1 && resubmitCount === 0 && verifiedPayload) {
      console.log('=== LIVE SMOKE: PASS ===');
      console.log('All S3 transport mechanics verified exactly once.');
      process.exit(0);
    } else if (postCount === 1 && submitCount === 1 && resubmitCount === 0) {
      console.log('=== LIVE SMOKE: COPY/READBACK FAIL ===');
      console.log('Submit mechanics: PASS (postCount=1, resubmitCount=0)');
      console.log('Failure: expected nonce+source payload was not verified from clipboard.');
      console.log('This does NOT establish that the model failed to produce the fenced JSON.');
      console.log('Transport result code:', result.code || '(none)');
      process.exit(4);
    } else {
      console.log('=== LIVE SMOKE: FAIL ===');
      console.log('- postCount:', postCount, '(expected 1)');
      console.log('- submitCount:', submitCount, '(expected 1)');
      console.log('- resubmitCount:', resubmitCount, '(expected 0)');
      process.exit(2);
    }
  } catch (e) {
    console.error('Live smoke error:', e.message);
    if (e.stack) console.error(e.stack);
    process.exit(1);
  }
}

main();