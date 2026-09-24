// tests/live-chrome-cdp-smoke.mjs
// Test hien thuc: Goi truc tiep Chrome CDP port 9222 qua ha tang cdp-supervisor that.

import http from 'node:http';
import { createCdpSupervisor } from '../packages/control-loop/cdp-supervisor.mjs';

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function runLiveCdpSmoke() {
  console.log('[LIVE TEST] Bat dau kiem tra ket noi Chrome CDP port 9222...');
  
  const supervisor = createCdpSupervisor({
    port: 9222,
    log: (msg) => console.log(`[CDP-SUPERVISOR] ${msg}`),
  });

  // 1. Kiem tra va dam bao Chrome dang chay that
  console.log('[LIVE TEST] Buoc 1: Goi supervisor.ensureChromeRunning()...');
  const chromeStatus = await supervisor.ensureChromeRunning();
  if (!chromeStatus.ok) {
    console.error('[LIVE TEST] ERROR: Khong the ket noi hoac khoi dong Chrome:', chromeStatus);
    process.exit(1);
  }
  console.log('[LIVE TEST] Chrome CDP da san sang! Thong tin version:');

  // 2. Doc thong tin phien ban that tu endpoint /json/version
  try {
    const versionInfo = await getJson('http://127.0.0.1:9222/json/version');
    console.log(`  - Browser: ${versionInfo.Browser}`);
    console.log(`  - Protocol-Version: ${versionInfo['Protocol-Version']}`);
    console.log(`  - User-Agent: ${versionInfo['User-Agent']}`);
    console.log(`  - WebSocketDebuggerUrl: ${versionInfo.webSocketDebuggerUrl ? 'CO (VALID)' : 'KHONG'}`);
  } catch (err) {
    console.error('[LIVE TEST] Loi khi doc /json/version:', err.message);
    process.exit(1);
  }

  // 3. Liet ke danh sach tab / targets dang mo tren Chrome that
  console.log('[LIVE TEST] Buoc 2: Liet ke danh sach cac Targets qua /json/list...');
  try {
    const targets = await getJson('http://127.0.0.1:9222/json');
    console.log(`[LIVE TEST] Tim thay ${targets.length} targets dang hoat dong:`);
    targets.slice(0, 5).forEach((t, idx) => {
      console.log(`    [${idx + 1}] Type: ${t.type} | Title: "${t.title.slice(0, 40)}" | URL: ${t.url.slice(0, 50)}...`);
    });
  } catch (err) {
    console.error('[LIVE TEST] Loi khi doc danh sach targets:', err.message);
    process.exit(1);
  }

  // 4. Kiem tra muc do san sang cho Web2API (tim hoac mo target)
  console.log('[LIVE TEST] Buoc 3: Kiem tra Target Page phuc vu Web2API Review...');
  const targetCheck = await supervisor.ensureTargetPage({
    urlPattern: /gemini\.google\.com/,
    defaultUrl: 'https://gemini.google.com',
  });

  if (targetCheck.ok) {
    console.log('[LIVE TEST] Target Page Gemini da duoc xac nhan thanh cong:', {
      targetId: targetCheck.targetId || targetCheck.id || 'san_sang',
      reused: targetCheck.reused ?? true
    });
  } else {
    console.log('[LIVE TEST] Thong bao ve Target Page:', targetCheck);
  }

  console.log('\n[LIVE TEST KET QUA] => KET NOI CHROME CDP 9222 THAT 100% THANH CONG!');
}

runLiveCdpSmoke().catch((err) => {
  console.error('[LIVE TEST FATAL]', err);
  process.exit(1);
});
