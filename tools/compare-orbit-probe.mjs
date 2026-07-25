// Ad-hoc probe: orbit the compare-mode camera in azimuth steps and capture each
// pose — does the ghost planet behave like a solid sphere (features fixed in
// world space) or does it appear to rotate with the camera?
//   node tools/compare-orbit-probe.mjs --container=Jupiter --filler=Earth
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}

const url = arg('url', 'http://localhost:5173');
const container = arg('container', 'Jupiter');
const filler = arg('filler', 'Earth');
const label = arg('label', `compare-orbit-${container}`);
const outDir = path.join('/tmp/moon-shots', label);
const azimuths = arg('az', '0,30,60,90,135,180').split(',').map(Number);

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=vulkan', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});

try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
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
  await page.goto(`${url}/?auto=planetarium`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__moon && window.__moon.ready && window.__moon.ready()), { timeout: 45000 });
  await page.waitForFunction(() => {
    const ls = document.getElementById('loading-screen');
    return !ls || ls.classList.contains('hidden');
  }, { timeout: 45000 }).catch(() => {});

  await page.evaluate(() => window.__moon.compareOpen());
  await page.waitForFunction(() => window.__moon.compareState() !== null, { timeout: 45000 });
  const picked = await page.evaluate(([c, f]) => window.__moon.comparePick(c, f), [container, filler]);
  console.log(`[probe] pick ${filler} into ${container}: ${picked}`);
  await page.waitForFunction(() => {
    const s = window.__moon.compareState();
    return s && s.phase && s.phase !== 'loading';
  }, { timeout: 45000 });
  await page.waitForTimeout(1500);

  for (const az of azimuths) {
    await page.evaluate((a) => window.__moon.compareOrbit(a, 20), az);
    await page.waitForTimeout(400);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const file = path.join(outDir, `az${String(az).padStart(3, '0')}.png`);
    await page.screenshot({ path: file });
    console.log(`[probe] az=${az} -> ${file}`);
  }
} finally {
  await browser.close();
}
console.log(`[probe] done -> ${outDir}`);
