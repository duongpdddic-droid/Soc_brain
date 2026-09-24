import path from 'node:path';
import fs from 'node:fs';
import { runSocControlLoop } from '../bin/soc-control-loop.mjs';
import { identityHash } from '../packages/workspace/workspace.mjs';
import { createGeminiWeb2ApiReviewTransport } from '../packages/control-loop/gemini-plus-web2api-copy.mjs';
import { createCdpSupervisor } from '../packages/control-loop/cdp-supervisor.mjs';

async function main() {
  const repo = 'duongpdddic-droid/soc_brain';
  const issueNumber = 231;
  const goal = 'docs: add feasibility spike verification note for PR 230 cdp loop';
  const stateDir = 'C:\\Users\\Admin\\.soc-brain\\state';
  const id = identityHash({ repo, issueNumber });

  // 1. Khoi tao ledger transitions.jsonl voi trang thai ROUTED
  const loopDir = path.join(stateDir, 'control-loop', id);
  fs.mkdirSync(loopDir, { recursive: true });
  const transFile = path.join(loopDir, 'transitions.jsonl');
  
  const initialTransition = JSON.stringify({
    schemaVersion: '1',
    ts: new Date().toISOString(),
    from: 'ACCEPTED',
    to: 'ROUTED',
    reason: 'loop-bind',
    evidence: { boundAt: new Date().toISOString() },
    identityHash: id
  }) + '\n';
  fs.writeFileSync(transFile, initialTransition, 'utf8');

  // 2. Khoi tao session record
  const sessDir = path.join(stateDir, 'sessions');
  fs.mkdirSync(sessDir, { recursive: true });
  const sessionPath = path.join(sessDir, `${id}.json`);
  fs.writeFileSync(sessionPath, JSON.stringify({
    schemaVersion: '1',
    repo,
    issueNumber,
    taskId: `${repo}#${issueNumber}`,
    state: 'ROUTED',
    createdAt: new Date().toISOString(),
    controlPlane: { stateDir }
  }, null, 2), 'utf8');

  // 3. Doc diff thuc te an toan tu ben ngoai
  const diffPath = path.resolve('artifacts/diffs/pr-231-changes.diff');
  let diffContent = 'Spike diff placeholder';
  try {
    if (fs.existsSync(diffPath)) {
      diffContent = fs.readFileSync(diffPath, 'utf8');
    }
  } catch { /* fallback */ }

  // 4. Lap rap deps: Mock cac buoc dau, cau hinh bridge prompt chuan cho finalReview CDP
  let defaultTransport = null;
  const deps = {
    router: () => ({
      ok: true,
      value: { executorKind: 'spike-mock', model: 'gpt-5.6-sol' }
    }),
    executor: async () => {
      console.log('[SPIKE-STEP] EXECUTING pass-through.');
      return { ok: true, value: { status: 'COMPLETED' } };
    },
    verifier: async () => {
      console.log('[SPIKE-STEP] VERIFYING pass-through.');
      return { ok: true, value: { verdict: 'PASS', report: 'Deterministic verifier passed' } };
    },
    preReview: async () => {
      console.log('[SPIKE-STEP] PRE_REVIEWING mock passed (Simulated Mechanical Gate).');
      return { ok: true, value: { verdict: 'PASS', findings: [] } };
    },
    finalReview: async (ctx) => {
      console.log('[SPIKE-STEP] FINAL_REVIEWING: Dang khoi tao CDP Supervisor de ket noi Chrome 9222...');
      const supervisor = createCdpSupervisor({
        port: 9222,
        log: (msg) => console.log(`[cdp-supervisor] ${msg}`)
      });
      const chrome = await supervisor.ensureChromeRunning();
      if (!chrome.ok) {
        return { ok: false, code: 'CDP_CHROME_UNAVAILABLE', verdict: 'BLOCKED', detail: chrome.error };
      }
      const target = await supervisor.ensureTargetPage({
        urlPattern: /gemini\.google\.com/,
        defaultUrl: 'https://gemini.google.com'
      });
      if (!target.ok) {
        return { ok: false, code: 'CDP_TARGET_UNAVAILABLE', verdict: 'BLOCKED', detail: target.error };
      }

      if (!defaultTransport) {
        defaultTransport = await createGeminiWeb2ApiReviewTransport({
          cdpPort: 9222,
          host: '127.0.0.1',
          log: (msg) => console.log(`[gemini-review] ${msg}`)
        });
      }

      const validPrompt = ctx.reviewPrompt || ctx.prompt || `Review PR #231 for Soc_brain:\nGoal: ${goal}\nDiff:\n${diffContent}`;
      console.log(`[SPIKE-STEP] Dang ban prompt vao tab Gemini qua Clipboard (${validPrompt.length} ky tu)...`);
      return defaultTransport({ ...ctx, prompt: validPrompt });
    }
  };

  console.log('[SPIKE-START] Kich hoat FSM Control Loop...');
  const res = await runSocControlLoop({
    repo,
    issueNumber,
    goal,
    bootstrap: false,
    deps
  });

  console.log('SPIKE_FINAL_RESULT:', JSON.stringify(res, null, 2));
}

main().catch(err => {
  console.error('SPIKE_FATAL:', err);
  process.exit(1);
});
