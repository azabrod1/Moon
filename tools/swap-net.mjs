// What does the first vantage swap fetch? Boot -> land Earth -> settle ->
// log every network request during the first swap to the Moon.
import { webkit } from 'playwright';
const url = process.argv[2] || 'http://localhost:5174';
const browser = await webkit.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1728, height: 1080 }, deviceScaleFactor: 2 });
  await context.addInitScript(() => {
    try {
      localStorage.clear(); sessionStorage.clear();
      indexedDB.deleteDatabase('orbital-sim-storage');
      localStorage.setItem('planetarium-help-seen', '1');
      localStorage.setItem('planetarium-surface-hint-seen', '1');
    } catch {}
  });
  const page = await context.newPage();
  await page.goto(`${url}/?auto=planetarium`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__moon && window.__moon.ready && window.__moon.ready()), { timeout: 60000 });
  await page.evaluate(() => { window.__moon.land('Earth'); });
  await page.waitForTimeout(8000);

  const reqs = [];
  page.on('response', async (res) => {
    try {
      const len = Number(res.headers()['content-length'] ?? 0);
      reqs.push({ url: res.url().split('/').slice(-2).join('/'), kb: Math.round(len / 1024), t: Date.now() });
    } catch {}
  });
  const t0 = Date.now();
  await page.evaluate(() => { window.__moon.swapVantage(); });
  await page.waitForTimeout(9000);
  for (const r of reqs) console.log(` +${String(r.t - t0).padStart(5)}ms ${String(r.kb).padStart(7)}KB ${r.url}`);
  console.log(`[total] ${reqs.length} requests, ${Math.round(reqs.reduce((s, r) => s + r.kb, 0) / 1024)}MB during first swap`);
} finally { await browser.close(); }
