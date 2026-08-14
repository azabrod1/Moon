// The real Observatory flow: stand on the Moon, jump to a solar eclipse,
// step through the window (relocates to Earth's shadow spot, aimed), then
// exit to the landed orbit view parked above the spot.
//
// The window is CLICKED rather than driven through the bridge's lookUp():
// only the click carries the relocation, so lookUp() would enter surface
// view still standing on the Moon and never reach Earth's shadow spot.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}
const url = arg('url', 'http://localhost:5174');
const label = arg('label', 'jump');
const jumps = Number(arg('jumps', '2'));
const outDir = path.join('/tmp/moon-shots/eclipse-spot', label);
await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 1 });
  await context.addInitScript(() => {
    try {
      localStorage.clear(); sessionStorage.clear();
      indexedDB.deleteDatabase('orbital-sim-storage');
      localStorage.setItem('planetarium-help-seen', '1');
      localStorage.setItem('planetarium-surface-hint-seen', '1');
    } catch {}
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 500)); });
  await page.goto(`${url}/?auto=planetarium`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__moon && window.__moon.ready && window.__moon.ready()), { timeout: 45000 });
  await page.waitForFunction(() => {
    const ls = document.getElementById('loading-screen');
    return !ls || ls.classList.contains('hidden');
  }, { timeout: 45000 }).catch(() => {});
  await page.evaluate(() => { window.__moon.land('Moon'); });
  await page.waitForTimeout(5000);
  await page.evaluate(() => { window.__moon.openObservatory(); });
  await page.waitForTimeout(1500);
  for (let i = 0; i < jumps; i++) {
    await page.evaluate(() => { window.__moon.jumpEvent('solar-eclipse', 1); });
    await page.waitForTimeout(2500);
  }
  console.log('[time]', await page.evaluate(() => new Date(window.__moon.getTimeMs()).toISOString()));
  await page.click('#observatory-lookup');
  await page.waitForTimeout(7000);
  console.log('[surface]', await page.evaluate(() => JSON.stringify(window.__moon.probeLanded())));
  await page.evaluate(() => { window.__moon.setChrome(false); });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(outDir, 'surface.png') });
  await page.evaluate(() => { window.__moon.exitSurface(); });
  await page.waitForTimeout(5000);
  console.log('[orbit]', await page.evaluate(() => JSON.stringify(window.__moon.probeLanded())));
  await page.screenshot({ path: path.join(outDir, 'orbit.png') });
  if (errors.length) console.log('[errors]', errors.slice(0, 5));
  console.log('[saved]', outDir);
} finally { await browser.close(); }
