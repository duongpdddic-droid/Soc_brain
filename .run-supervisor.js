const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const log = process.argv[2];
const runs = Number(process.argv[3] || 4);
let acc = '';
for (let i = 1; i <= runs; i++) {
  let out = '';
  try { out = execFileSync('node', ['--test', '--test-concurrency=1', 'tests/client-mcp-supervisor.test.mjs'], { encoding: 'utf8', timeout: 240000 }); }
  catch (e) { out = (e && e.stdout || '') + '\n' + (e && e.stderr || ''); }
  const lines = out.split('\n');
  const sum = lines.filter((l) => /^# (tests|pass|fail|cancelled|skipped) /.test(l)).join(' | ');
  const nok = lines.filter((l) => /^not ok /.test(l)).map((l) => l.replace(/^not ok \d+ - /, '')).join(' ; ') || '(none)';
  acc += `=== RUN ${i} ===\n${sum}\nnot-ok: ${nok}\n`;
  fs.writeFileSync(log, acc, 'utf8');
}
process.exit(0);