// Landed-on-Earth orbit view, dragged around to the sunward hemisphere so the
// shadow spot is face-on (the pose Alex's screenshot shows).
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}
const url = arg('url', 'http://localhost:5174');
const label = arg('label', 'drag');
const timeIso = arg('time', '2027-08-02T10:06:00Z');
const dragX = Number(arg('dx', '-420'));   // px, negative = orbit east
const dragY = Number(arg('dy', '40'));
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
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text().slice(0, 2000));
  });
  await page.goto(`${url}/?auto=planetarium`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__moon && window.__moon.ready && window.__moon.ready()), { timeout: 45000 });
  await page.waitForFunction(() => {
    const ls = document.getElementById('loading-screen');
    return !ls || ls.classList.contains('hidden');
  }, { timeout: 45000 }).catch(() => {});
  await page.evaluate((iso) => {
    window.__moon.setTimeMs(Date.parse(iso));
    window.__moon.land('Earth');
    window.__moon.setChrome(false);
  }, timeIso);
  await page.waitForTimeout(6000);
  // Orbit-drag on the canvas: steps so OrbitControls damping tracks smoothly.
  const cx = 700, cy = 500;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  const steps = 24;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(cx + (dragX * i) / steps, cy + (dragY * i) / steps);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  await page.waitForTimeout(2500);
  if (errors.length) console.log('[errors]', errors.slice(0, 5));
  const file = path.join(outDir, 'Earth.png');
  await page.screenshot({ path: file });
  console.log('[saved]', file);
} finally { await browser.close(); }
