import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3210;
const BASE = 'http://127.0.0.1:' + PORT;
let server = null;
let browser = null;

const fail = (msg) => {
  throw new Error('SMOKE_FAIL: ' + msg);
};

try {
  execSync('npm run build', { cwd: here, timeout: 120000, stdio: 'pipe' });
  const { execSync: kill } = await import('child_process');
  await new Promise((r) => setTimeout(r, 100));
  server = spawn(process.execPath, ['server.mjs'], { cwd: here, env: { ...process.env, PORT: String(PORT) }, stdio: 'pipe' });
  server.stdout.on('data', (d) => process.stdout.write('[srv] ' + d));
  server.stderr.on('data', (d) => process.stderr.write('[srv-err] ' + d));
  const deadline = Date.now() + 15000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(BASE + '/api/snapshot');
      if (r.ok) { ready = true; break; }
    } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  if (!ready) fail('server not ready on ' + BASE);
  browser = await chromium.launch();
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(2000);
  const pageContent = await page.content();
  const debugDiv = await page.evaluate(() => document.getElementById('root')?.innerHTML?.slice(0, 500) || 'empty');
  process.stdout.write('DEBUG_PAGE:' + debugDiv + '\n');
  await page.waitForSelector('[data-testid="task-card-fixture-alpha"]', { timeout: 10000 });
  await page.waitForSelector('[data-testid="task-card-fixture-beta"]', { timeout: 10000 });
  await page.click('[data-testid="task-card-fixture-alpha"]');
  await page.waitForTimeout(1000);
  const before = await page.textContent('[data-testid="progress-fixture-alpha"]');
  await page.waitForFunction(
    (prev) => {
      const el = document.querySelector('[data-testid="progress-fixture-alpha"]');
      return el && el.textContent !== prev;
    },
    before,
    { timeout: 15000 },
  );
  await page.click('[data-testid="cmd-ping"]');
  await page.waitForTimeout(2000);
  await page.click('[data-testid="cmd-gate"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="gate-checkpoint-fixture-alpha"]') || document.querySelector('[data-testid="gate-status"]'), { timeout: 5000 });
  await page.click('[data-testid="btn-approve"]');
  await page.waitForTimeout(2000);
  await page.waitForSelector('[data-testid="gate-resolved"]', { timeout: 5000 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  await page.click('[data-testid="task-card-fixture-beta"]');
  await page.waitForSelector('[data-testid="detail-timeline"]', { timeout: 10000 });
  const timeline = await page.textContent('[data-testid="detail-timeline"]');
  if (!timeline || timeline.length < 10) fail('timeline did not recover after reload');
  if (consoleErrors.length > 0) fail('console errors: ' + consoleErrors.join(' | ').slice(0, 500));
  await page.screenshot({ path: path.join(here, 'dashboard.png') });
  process.stdout.write(JSON.stringify({ ok: true, url: BASE, consoleErrors: 0 }) + '\n');
} finally {
  if (browser) await browser.close();
  if (server) {
    server.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 1000));
    if (server.exitCode === null) server.kill('SIGKILL');
  }
}
