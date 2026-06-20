// Landed-mode moon captures (frame() only knows planets). Lands on each moon so
// the landed framing fills the disc, hides chrome, and screenshots — for the
// colourspace/banding parity eyeball and to confirm photos still beat the floor.
//   node tools/moon-shot.mjs --url=http://localhost:5190 --bodies=Titania,Rhea,Io,Moon,Europa
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
const url = process.argv.find((a) => a.startsWith('--url='))?.slice(6) || 'http://localhost:5190';
const bodies = (process.argv.find((a) => a.startsWith('--bodies='))?.slice(9) || 'Titania,Rhea,Io,Moon,Europa').split(',');
const cpu = process.argv.includes('--cpu'); // force the old CPU paint path for A/B looks
const outDir = cpu ? '/tmp/moon-shots/gpu-landed-cpu' : '/tmp/moon-shots/gpu-landed';
await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 1200 }, deviceScaleFactor: 1 });
  await ctx.addInitScript((fc) => { try { localStorage.clear(); sessionStorage.clear(); indexedDB.deleteDatabase('orbital-sim-storage'); localStorage.setItem('planetarium-help-seen','1'); localStorage.setItem('planetarium-surface-hint-seen','1'); if (fc) window.__forceCpuMoonPaint = true; } catch {} }, cpu);
  const page = await ctx.newPage();
  await page.goto(`${url}/?auto=planetarium`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__moon && window.__moon.ready && window.__moon.ready()), { timeout: 45000 });
  await page.waitForFunction(() => { const ls = document.getElementById('loading-screen'); return !ls || ls.classList.contains('hidden'); }, { timeout: 45000 }).catch(()=>{});
  await page.evaluate((t) => window.__moon.setTimeMs(t), Date.parse('2026-06-17T00:00:00Z'));
  await page.evaluate(() => window.__moon.setChrome(false));
  const settle = async (w) => { await page.waitForTimeout(w); await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))); };
  await settle(600);
  for (const b of bodies) {
    await page.evaluate((name) => { window.__moon.exitSurface(); window.__moon.land(name); }, b);
    await settle(900);
    await page.evaluate(() => window.__moon.setChrome(false));
    await settle(150);
    await page.screenshot({ path: path.join(outDir, `${b}.png`) });
    console.log(`${b} -> ${path.join(outDir, b + '.png')}  ${JSON.stringify(await page.evaluate(() => window.__gpuMoonStats || null))}`);
  }
} finally { await browser.close(); }
