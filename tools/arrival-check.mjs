// Regression check: teleport to the Moon, watch the approach distance, and
// log every tier fetch — verifies the arrival still parks and the stepwise
// ladder (4k -> 8k) plus the relief tier all fire. Dev server + __moon.
import { chromium } from 'playwright';

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PW_CHROMIUM || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => {
    try {
      localStorage.clear(); sessionStorage.clear();
      indexedDB.deleteDatabase('orbital-sim-storage');
      localStorage.setItem('planetarium-help-seen', '1');
      localStorage.setItem('planetarium-surface-hint-seen', '1');
    } catch { /* ignore */ }
  });
  const page = await context.newPage();
  page.on('response', (r) => {
    if (/textures\/(4k|8k)\//.test(r.url())) {
      console.log(`[tier] ${r.status()} ${r.url().split('/').slice(-2).join('/')}`);
    }
  });
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));

  await page.goto('http://localhost:5174/?auto=planetarium', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__moon?.ready?.(), { timeout: 90000 });
  await page.waitForFunction(() => {
    const ls = document.getElementById('loading-screen');
    return !ls || ls.classList.contains('hidden');
  }, { timeout: 60000 });
  await page.waitForTimeout(1500);
  const ok = await page.evaluate(() =>
    window.__moon.openMap() && window.__moon.mapPick('Moon') && window.__moon.mapCommit('travel'));
  console.log(`[probe] teleport: ${ok}`);

  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(4000);
    const p = await page.evaluate(() => {
      const pr = window.__moon.probe('Moon');
      return { d: pr?.distToBodyAU, moving: pr?.moving };
    });
    console.log(`[approach] t=${(i + 1) * 4}s dist=${p.d?.toExponential(3)} moving=${p.moving}`);
    if (p.d != null && p.d < 4e-5 && !p.moving) break;
  }
  // Linger so post-arrival triggers (8k after 4k applies) get frames to fire.
  await page.waitForTimeout(15000);
  console.log('[probe] done');
} finally {
  await browser.close();
}
