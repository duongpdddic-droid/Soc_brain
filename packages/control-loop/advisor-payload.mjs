// packages/control-loop/advisor-payload.mjs
// Standardized Advisor Consultation Payload Builder & Parser for Soc_brain Web2API.

export const ADVISOR_PAYLOAD_SCHEMA_VERSION = '2';
const MAX_LOG_LENGTH = 8192;
const MAX_DIFF_LENGTH = 16384;

function ok(value, extra = {}) { return { ok: true, value, ...extra }; }
function fail(code, detail) { return { ok: false, code, detail: detail ?? null }; }

export function extractFailureLog(rawLog = '') {
  if (typeof rawLog !== 'string' || !rawLog.trim()) return '(no failure logs provided)';
  
  const lines = rawLog.split(/\r?\n/);
  const failureLines = [];
  let capturing = false;

  for (const line of lines) {
    const isFailHeader = /not ok|FAIL|Error:|AssertionError|failed with exit code/i.test(line);
    if (isFailHeader) capturing = true;
    if (capturing) {
      failureLines.push(line);
      if (failureLines.length >= 100) break;
    }
  }

  const result = failureLines.length > 0 ? failureLines.join('\n') : lines.slice(-50).join('\n');
  return result.length > MAX_LOG_LENGTH ? result.slice(0, MAX_LOG_LENGTH) + '\n... [TRUNCATED LOG]' : result;
}

export function buildAdvisorConsultationPrompt({
  session = {},
  errorSummary = '',
  testLog = '',
  diff = '',
  invariants = [],
  question = 'Chi ra nguyen nhan gay loi va dua ra huong sua doi toi uu nhat ma khong pha vo kien truc.'
} = {}) {
  const repo = session.repo || 'unknown/repo';
  const issueNumber = session.issueNumber || session.issue || 'N/A';
  const prNumber = session.prNumber || session.pullRequest || 'N/A';
  const goal = session.goal || '(no explicit goal)';
  const headSha = session.headSha || session.headCommitSha || 'HEAD';

  const cleanLog = extractFailureLog(testLog);
  const boundedDiff = typeof diff === 'string' && diff.trim()
    ? (diff.length > MAX_DIFF_LENGTH ? diff.slice(0, MAX_DIFF_LENGTH) + '\n... [TRUNCATED DIFF]' : diff)
    : '(no uncommitted or worktree diff)';

  const rules = Array.isArray(invariants) && invariants.length > 0
    ? invariants.map((r, i) => `${i + 1}.${r}`).join('\n')
    : '1. Khong sua doi file ngoai pham vi quy dinh.\n2. Khong sua test de che dau loi logic.\n3. Bao toan test suite hien co (0 regression).';

  const prompt = `[CONTEXT & CONTRACT]
- Repository: ${repo}
- Issue / Task: #${issueNumber}
- Pull Request: #${prNumber}
- Commit SHA: ${headSha}
- Objective (Goal): ${goal}

[EXACT BOTTLENECK / FAILURE LOG]
${errorSummary ? `Summary: ${errorSummary}\n` : ''}${cleanLog}

[CURRENT WORKTREE DIFF]
${boundedDiff}

[RULE INVARIANTS]
${rules}

[DIRECT QUESTION TO ADVISOR]
${question}

YEU CAU TRO GIUP (ADVISOR DIRECTIVE):
Advisor dua ra phan tich nguyen nhan goc re va huong dan sua loi truc tiep, ngan gon, co doan ma hoac chi dan ro rang de Executor tu dong ap dung trong luot Rework tiep theo. (Advisor khong can dua ra VERDICT).`;

  return ok({
    prompt,
    schemaVersion: ADVISOR_PAYLOAD_SCHEMA_VERSION,
    metadata: { repo, issueNumber, prNumber, headSha }
  });
}

export function parseAdvisorResponse(rawText = '') {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    return fail('ADVISOR_RESPONSE_EMPTY', 'Advisor returned empty response');
  }

  return ok({
    guidance: rawText.trim(),
    schemaVersion: ADVISOR_PAYLOAD_SCHEMA_VERSION
  });
}
