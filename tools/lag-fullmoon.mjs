// (a) Capture the Moon from Earth at full phase (vs the current near-new) to
//     separate "2D/less-HD" caused by phase from caused by telephoto FOV.
// (b) Measure main-thread jank (rAF gaps) on a Jupiter moon with the Observatory
//     search running, vs Earth — to confirm the "Look up lags" report.
//   node tools/lag-fullmoon.mjs
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}
const url = arg('url', 'http://localhost:5181');
const outDir = '/tmp/moon-shots/lag-fullmoon';
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
console.log('[lf] renderer: GPU (ANGLE/Metal)');

try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  await context.addInitScript(() => {
    try {
      localStorage.clear(); sessionStorage.clear(); indexedDB.deleteDatabase('orbital-sim-storage');
      localStorage.setItem('planetarium-help-seen', '1'); localStorage.setItem('planetarium-surface-hint-seen', '1');
    } catch { /* */ }
  });
  const page = await context.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto(`${url}/?auto=planetarium`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__moon && window.__moon.ready && window.__moon.ready()), { timeout: 45000 });
  await page.waitForFunction(() => { const ls = document.getElementById('loading-screen'); return !ls || ls.classList.contains('hidden'); }, { timeout: 45000 }).catch(() => {});
  await page.evaluate((t) => window.__moon.setTimeMs(t), Date.parse('2026-06-17T00:00:00Z'));
  await page.waitForTimeout(800);
  const settle = async (w) => { await page.waitForTimeout(w); await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))); };

  // ---- (a) Full-moon vs near-new framing, both at ×4 ----
  await page.evaluate(() => window.__moon.land('Earth'));
  await settle(400);
  await page.evaluate(() => window.__moon.lookUp());
  await settle(1100);
  await page.evaluate(() => window.__moon.setChrome(false));
  await settle(200);
  console.log('near-new:', JSON.stringify(await page.evaluate(() => window.__moon.probeLanded())));
  await page.screenshot({ path: path.join(outDir, 'moon_near_new_x4.png') });
  // Jump to the next full moon (re-points the surface view) and re-shoot.
  await page.evaluate(() => window.__moon.jumpEvent('full-moon', 1));
  await settle(1200);
  console.log('full-moon:', JSON.stringify(await page.evaluate(() => window.__moon.probeLanded())));
  await page.screenshot({ path: path.join(outDir, 'moon_full_x4.png') });

  // ---- (b) Main-thread jank: Earth vs Io, Observatory search running ----
  const measureJank = (durMs) => page.evaluate((dur) => new Promise((resolve) => {
    const gaps = []; let last = performance.now(); const start = last;
    const tick = (now) => {
      gaps.push(now - last); last = now;
      if (now - start < dur) requestAnimationFrame(tick);
      else { gaps.shift();
        const max = Math.max(...gaps); const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        resolve({ frames: gaps.length, avgMs: +avg.toFixed(1), maxMs: +max.toFixed(1), janky50: gaps.filter((g) => g > 50).length, janky100: gaps.filter((g) => g > 100).length });
      }
    };
    requestAnimationFrame(tick);
  }), durMs);

  await page.evaluate(() => { window.__moon.exitSurface(); });
  await page.evaluate((t) => window.__moon.setTimeMs(t), Date.parse('2026-06-17T00:00:00Z'));
  for (const body of ['Earth', 'Io', 'Europa', 'Ganymede']) {
    await page.evaluate((b) => { window.__moon.exitSurface(); window.__moon.land(b); window.__moon.openObservatory(); }, body);
    const jank = await measureJank(3000); // search + paint churn while landed
    await page.evaluate(() => window.__moon.lookUp());
    const jankLook = await measureJank(1500); // during/after the surface glide
    console.log(`${body.padEnd(9)} landed: ${JSON.stringify(jank)}  | look: ${JSON.stringify(jankLook)}`);
  }

  if (errs.length) { console.log('errors:', errs.slice(0, 8)); }
  console.log('shots in', outDir);
} finally {
  await browser.close();
}
