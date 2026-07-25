// Ad-hoc probe: enter volume-compare, pick a pair, and capture a fixed-camera
// time series to see what (if anything) rotates on the container planet.
//   node tools/compare-rotation-probe.mjs --container=Jupiter --filler=Earth
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
const label = arg('label', `compare-${container}-${filler}`);
const outDir = path.join('/tmp/moon-shots', label);
const frames = Number(arg('frames', '5'));
const gapMs = Number(arg('gap', '1500'));
const pour = process.argv.includes('--pour');

await mkdir(outDir, { recursive: true });

const useGpu = !process.argv.includes('--software');
const browser = await chromium.launch({
  headless: true,
  executablePath: '/opt/pw-browsers/chromium', // pre-installed; repo's playwright pin differs

  args: useGpu
    ? ['--use-gl=angle', '--use-angle=vulkan', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader']
    : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
console.log(`[probe] renderer: ${useGpu ? 'GPU (ANGLE/Vulkan)' : 'software (SwiftShader)'}`);

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
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(`${url}/?auto=planetarium`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__moon && window.__moon.ready && window.__moon.ready()), { timeout: 45000 });
  await page.waitForFunction(() => {
    const ls = document.getElementById('loading-screen');
    return !ls || ls.classList.contains('hidden');
  }, { timeout: 45000 }).catch(() => {});

  await page.evaluate(() => window.__moon.compareOpen());
  await page.waitForTimeout(1000);
  const picked = await page.evaluate(([c, f]) => window.__moon.comparePick(c, f), [container, filler]);
  console.log(`[probe] pick ${filler} into ${container}: ${picked}`);
  await page.waitForFunction(() => {
    const s = window.__moon.compareState();
    return s && s.phase && s.phase !== 'loading';
  }, { timeout: 45000 });
  const state0 = await page.evaluate(() => window.__moon.compareState());
  console.log(`[probe] state after pick: ${JSON.stringify(state0)}`);

  if (pour) {
    await page.evaluate(() => window.__moon.compareSlider(1));
    console.log('[probe] pour started (slider=1)');
  }

  for (let i = 0; i < frames; i++) {
    await page.waitForTimeout(gapMs);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const s = await page.evaluate(() => window.__moon.compareState());
    const file = path.join(outDir, `t${String(i).padStart(2, '0')}.png`);
    await page.screenshot({ path: file });
    console.log(`[probe] frame ${i} phase=${s?.phase} poured=${s?.poured ?? '-'} -> ${file}`);
  }

  if (errors.length) {
    console.log(`[probe] page errors (${errors.length}):`);
    for (const e of errors.slice(0, 10)) console.log('    ', e);
  }
} finally {
  await browser.close();
}
console.log(`[probe] done -> ${outDir}`);
