// Sun appearance QA: one run captures the Sun at the scales that matter —
// close-up photosphere study, mid approach (prominence band), Mercury, 1 AU.
//
// Prereq: dev server running (`npm run dev`). Then:
//   node tools/sun-shot.mjs --label=sun-before
//
// Same GPU (ANGLE/Metal) launch line as shoot.mjs; --software for SwiftShader.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}

const url = arg('url', 'http://localhost:5174');
const label = arg('label', 'sun');
const outDir = arg('out', path.join('/tmp/moon-shots', label));
const W = Number(arg('w', '1600'));
const H = Number(arg('h', '900'));
const settle = Number(arg('settle', '2500'));
// With solar rotation live, the facing hemisphere depends on the sim clock —
// pin it (ISO) for reproducible spot/filament placement across runs.
const timeIso = arg('time', '');

// Each pose either frames by fill (frame: disc fraction + camera radii) or by
// absolute distance (frameSun: AU + FOV). Radii poses sit outside the 2.6-radii
// whiteout so structure is actually visible.
const poses = [
  { name: 'close-study', frame: { fill: 0.75, distRadii: 2.8 } },
  // Sun slid far off-centre so the limb arc + off-limb sky (prominence band)
  // fills the frame. 0.014 AU ≈ 3 photosphere radii.
  { name: 'limb', frameSun: { distanceAU: 0.014, fovDeg: 40, offNdcX: -0.85 } },
  { name: 'mid-approach', frame: { fill: 0.28, distRadii: 8 } },
  // Same pose with every flare site's envelope pinned on (dev override).
  { name: 'flare', frame: { fill: 0.75, distRadii: 2.8 }, flare: 1 },
  // Peak prominence eruption pinned on (dev override), from the limb pose.
  { name: 'eruption', frameSun: { distanceAU: 0.014, fovDeg: 40, offNdcX: -0.85 }, eruption: 1 },
  // Collapse phase: arch mostly re-formed, coronal rain streaming down it.
  { name: 'rain', frameSun: { distanceAU: 0.014, fovDeg: 40, offNdcX: -0.85 }, eruption: 0.25, rain: 1 },
  { name: 'mercury', frameSun: { distanceAU: 0.39, fovDeg: 60 } },
  { name: 'earth', frameSun: { distanceAU: 1, fovDeg: 60 } },
];

await mkdir(outDir, { recursive: true });

const useGpu = !process.argv.includes('--software');
const browser = await chromium.launch({
  headless: true,
  args: useGpu
    ? ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader']
    : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
console.log(`[sun-shot] renderer: ${useGpu ? 'GPU (ANGLE/Metal)' : 'software (SwiftShader)'}`);

let captured = 0;
try {
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await context.addInitScript(() => {
    try {
      localStorage.clear();
      sessionStorage.clear();
      indexedDB.deleteDatabase('orbital-sim-storage');
      localStorage.setItem('planetarium-help-seen', '1');
      localStorage.setItem('planetarium-surface-hint-seen', '1');
    } catch { /* storage blocked — harmless */ }
  });

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  const target = `${url}/?auto=planetarium`;
  console.log(`[sun-shot] ${target} -> ${outDir}`);
  await page.goto(target, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__moon && window.__moon.ready && window.__moon.ready()), { timeout: 45000 });
  await page.waitForFunction(() => {
    const ls = document.getElementById('loading-screen');
    return !ls || ls.classList.contains('hidden');
  }, { timeout: 45000 }).catch(() => {});

  await page.evaluate(() => window.__moon.setChrome(false));
  if (timeIso) {
    const ms = Date.parse(timeIso);
    if (!Number.isNaN(ms)) await page.evaluate((t) => window.__moon.setTimeMs(t), ms);
  }
  await page.waitForTimeout(1500);
  const settleFrames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

  for (const pose of poses) {
    const ok = await page.evaluate((p) => {
      if (p.frame) return window.__moon.frame('Sun', p.frame.fill, 0, p.frame.distRadii);
      return window.__moon.frameSun(
        p.frameSun.distanceAU, p.frameSun.fovDeg,
        p.frameSun.offNdcX ?? 0, p.frameSun.offNdcY ?? 0,
      );
    }, pose);
    if (!ok) { console.log(`[sun-shot] SKIP ${pose.name}`); continue; }
    await page.evaluate((f) => window.__moon.sunFlare?.(f), pose.flare ?? null);
    await page.evaluate((e) => window.__moon.sunEruption?.(e), pose.eruption ?? null);
    await page.evaluate((r) => window.__moon.sunRain?.(r), pose.rain ?? null);
    await page.waitForTimeout(settle);
    await settleFrames();
    const file = path.join(outDir, `${pose.name}.png`);
    await page.screenshot({ path: file });
    captured++;
    console.log(`[sun-shot] ${pose.name} -> ${file}`);
  }

  if (errors.length) {
    console.log(`[sun-shot] page errors (${errors.length}):`);
    for (const e of errors.slice(0, 10)) console.log('    ', e);
  }
} finally {
  await browser.close();
}

console.log(`[sun-shot] done: ${captured}/${poses.length} captured in ${outDir}`);
if (captured === 0) process.exit(1);
