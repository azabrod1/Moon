// Solar-eclipse capture via the vantage-swap flow: land(Moon) -> Observatory ->
// jumpEvent(solar-eclipse) -> swapVantage ("Stand on Earth") -> lookUp -> zoom.
// Companion to eclipse-shot.mjs (which lands on Earth directly): the swap path
// exercises the landed-state handoff, which eclipse-shot's direct path skips.
// Prereq: dev server on :5174 (or pass --url=).
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}

const url = arg('url', 'http://localhost:5174');
const label = arg('label', 'swap');
const outDir = path.join('/tmp/moon-shots', label);
const offsets = arg('offsets', '0,180').split(',').map(Number);

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PW_CHROMIUM || undefined,
  args: ['--use-gl=angle', '--use-angle=vulkan', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});

try {
  const context = await browser.newContext({ viewport: { width: 900, height: 1600 }, deviceScaleFactor: 1 });
  await context.addInitScript(() => {
    try {
      localStorage.clear();
      sessionStorage.clear();
      indexedDB.deleteDatabase('orbital-sim-storage');
      localStorage.setItem('planetarium-help-seen', '1');
      localStorage.setItem('planetarium-surface-hint-seen', '1');
    } catch { /* ignore */ }
  });

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(`${url}/?auto=planetarium`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__moon && window.__moon.ready && window.__moon.ready()), { timeout: 60000 });
  await page.waitForFunction(() => {
    const ls = document.getElementById('loading-screen');
    return !ls || ls.classList.contains('hidden');
  }, { timeout: 60000 }).catch(() => {});

  // The user's flow: standing on the Moon first.
  await page.evaluate(() => window.__moon.land('Moon'));
  await page.waitForTimeout(4000);
  await page.evaluate(() => window.__moon.openObservatory());
  await page.waitForTimeout(1500);
  console.log('[swap] jumpEvent ->', await page.evaluate(() => window.__moon.jumpEvent('solar-eclipse', 1)));
  await page.waitForTimeout(3000);
  // "Stand on Earth"
  console.log('[swap] swapVantage ->', await page.evaluate(() => window.__moon.swapVantage()));
  await page.waitForTimeout(6000);
  console.log('[swap] lookUp ->', await page.evaluate(() => window.__moon.lookUp()));
  await page.waitForTimeout(4000);

  // Zoom in with wheel events.
  await page.mouse.move(450, 800);
  for (let i = 0; i < 40; i++) {
    await page.mouse.wheel(0, -240);
    await page.waitForTimeout(80);
    const fov = (await page.evaluate(() => window.__moon.probeLanded()))?.surfaceFovDeg ?? 99;
    if (fov <= 2.1) break;
  }
  await page.waitForTimeout(1500);

  const baseMs = await page.evaluate(() => window.__moon.getTimeMs());
  const settleFrames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  for (const off of offsets) {
    await page.evaluate((t) => window.__moon.setTimeMs(t), baseMs + off * 1000);
    await page.waitForTimeout(1500);
    await settleFrames();
    const file = path.join(outDir, `t${off >= 0 ? '+' : ''}${off}.png`);
    await page.screenshot({ path: file });
    console.log('[probeLanded]', JSON.stringify(await page.evaluate(() => window.__moon.probeLanded())));
    console.log('[sun]', JSON.stringify(await page.evaluate(() => window.__moon.sunAppearance())));
    console.log('[swap]', new Date(baseMs + off * 1000).toISOString(), '->', file);
  }

  if (errors.length) {
    console.log(`[swap] page errors (${errors.length}):`);
    for (const e of errors.slice(0, 10)) console.log('    ', e);
  }
} finally {
  await browser.close();
}
