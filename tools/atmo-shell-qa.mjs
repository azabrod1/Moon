// Golden capture for the atmosphere shell — three sessions: the analytic tier
// pinned on, the LUT tier, and the no-float fallback device (?nofloat=1, which
// has no composer, no bloom and no tables).
//
// The poses are the ones the campaign is judged on: the whole-disc limb from
// 8 R, the near band from 1.05 R aimed over the horizon, the terminator edge-on
// from 1.5 R, the night side past it, one pose INSIDE the air (only a dev pose
// can reach it), and the volume-compare ghost, whose shell is pinned analytic.
//
// Every capture runs through __moon.pinCapture: the near plane, the tone-mapping
// exposure and the pixel ratio are all driven per frame by things that have
// nothing to do with the atmosphere (the cruise governor, the Sun's on-screen
// state, the display), and a golden that moves with them is not a golden.
//
//   npx vite --port 5640 --strictPort
//   node tools/atmo-shell-qa.mjs --out=tools/goldens/atmosphere
//   node tools/atmo-shell-qa.mjs --out=/tmp/moon-shots/atmo2 --w=1600 --h=900 --hero
//
// Writes <pose>.<tier>.png plus <pose>.<tier>.json — 20 sampled radiances on a
// fixed grid and a 41-point scan across the limb, which is the part a test can
// hold without a GPU. Re-recording them is deliberate: the numbers are pinned
// in src/planetarium/world/atmosphereGoldens.pinned.ts, and a re-record that
// moves a radiance has to move that file too, in a diff someone reads.
import { chromium, webkit } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}
const flag = (name) => process.argv.includes(`--${name}`);

const url = arg('url', 'http://localhost:5640');
const outDir = arg('out', 'tools/goldens/atmosphere');
const W = Number(arg('w', '512'));
const H = Number(arg('h', '512'));
const hero = flag('hero'); // wide framing set for the side-by-side, not the goldens
const only = arg('tiers', 'analytic,lut,nofloat').split(',');
// Default near plane, in AU. Per pose, because the right value depends on how
// close the camera is: 1e-6 AU is 149.6 km, which is fine at 1.05 R (the camera
// is 319 km up) and clips the globe and half the shell away at 1.008 R (51 km
// up). Each pose carries its own and the JSON records the one it used.
const NEAR_AU = Number(arg('near', '1e-6'));
// The clock is part of the pose: Earth's spin, its clouds and its terminator
// are all in the frame, so a golden taken at wall-clock time compares against
// nothing. 2026-03-20 12:00 UTC — an equinox noon, the terminator through the
// poles.
const TIME_MS = Date.parse(arg('time', '2026-03-20T12:00:00Z'));
const EXPOSURE = Number(arg('exposure', '1'));
const BAKE_TIMEOUT_MS = 45000;

// Fixed sample grid, in fractions of the frame: 5 across x 4 down — the frame
// as a whole, so a change anywhere in it shows.
const GRID = [];
for (let y = 0; y < 4; y++) {
  for (let x = 0; x < 5; x++) GRID.push([0.1 + x * 0.2, 0.15 + y * 0.2333]);
}
// And the thing this commit actually changes: a scan across the limb on the
// centre row. Every pose here frames the limb near the middle of the frame, and
// at 8 R the whole air is about one pixel wide — a scattered grid misses it
// entirely, which is how two tiers can post identical numbers and different
// pictures.
const LIMB_SCAN = [];
for (let i = 0; i <= 40; i++) LIMB_SCAN.push([0.35 + (i * 0.3) / 40, 0.5]);

const POSES = [
  { name: 'limb-8r', kRadii: 8, fov: 50, phase: 0 },
  { name: 'limb-1.05r', kRadii: 1.05, fov: 60, phase: 0 },
  { name: 'terminator-1.5r', kRadii: 1.5, fov: 50, phase: 90 },
  { name: 'night-1.05r', kRadii: 1.05, fov: 60, phase: 150 },
  // Inside the air: 1.008 R is 51 km up, under the 100 km top. No camera the
  // app steers can be here — this is the only exercise the inside branch gets,
  // and it needs a near plane under 51 km or the frame is mostly clipped globe:
  // 1e-8 AU is 1.5 km.
  { name: 'inside-air', kRadii: 1.008, fov: 70, phase: 0, near: 1e-8 },
];

// The three sessions a capture set covers. `nofloat` is the fallback device:
// no float render targets, so no composer, no bloom and no tables — the
// analytic shell drawn straight to the canvas. It is captured because that
// path is what most of the world's weakest hardware sees, and because the
// shell's draw order moved: the fallback is what it always was EXCEPT for the
// cloud-deck notch across the innermost band of the limb, which is gone on
// purpose. Nothing else about it changed, and this is where that is recorded.
const TIER_URLS = {
  analytic: '/?auto=planetarium',
  lut: '/?auto=planetarium',
  nofloat: '/?auto=planetarium&nofloat=1',
};

// WebKit is the Safari/iOS oracle: the once-in-a-while breakers in a shader
// like this are Metal NaNs and a driver that compiles the same GLSL differently,
// not frame time.
const browser = flag('webkit')
  ? await webkit.launch({ headless: true })
  : await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
  });

async function newSession() {
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
  return { context, page, errors };
}

/** Decode a PNG buffer in the page and read the fixed grid — no native image
 *  library is installed, which is the same reason texdiff.mjs decodes here. */
async function sample(page, buffer, grid = GRID) {
  return page.evaluate(async ({ uri, grid }) => {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('decode failed'));
      i.src = uri;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return grid.map(([fx, fy]) => {
      const x = Math.min(canvas.width - 1, Math.round(fx * canvas.width));
      const y = Math.min(canvas.height - 1, Math.round(fy * canvas.height));
      const d = ctx.getImageData(x, y, 1, 1).data;
      return [d[0], d[1], d[2]];
    });
  }, { uri: `data:image/png;base64,${buffer.toString('base64')}`, grid });
}

async function capture(page, file, poseMeta) {
  const buffer = await page.screenshot();
  await writeFile(`${file}.png`, buffer);
  const samples = await sample(page, buffer);
  const limbScan = await sample(page, buffer, LIMB_SCAN);
  await writeFile(`${file}.json`, `${JSON.stringify({
    ...poseMeta,
    width: W,
    height: H,
    grid: GRID.map(([x, y]) => [Number(x.toFixed(4)), Number(y.toFixed(4))]),
    samples,
    limbScanRow: 0.5,
    limbScanX: LIMB_SCAN.map(([x]) => Number(x.toFixed(4))),
    limbScan,
  }, null, 2)}\n`);
  return samples;
}

await mkdir(outDir, { recursive: true });
const summary = [];

try {
  for (const tier of only) {
    const { context, page, errors } = await newSession();
    await page.goto(`${url}${TIER_URLS[tier]}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window.__moon && window.__moon.ready && window.__moon.ready()), { timeout: 60000 });
    await page.waitForFunction(() => {
      const ls = document.getElementById('loading-screen');
      return !ls || ls.classList.contains('hidden');
    }, { timeout: 60000 }).catch(() => {});
    await page.evaluate(() => window.__moon.setChrome(false));
    await page.evaluate((t) => window.__moon.setTimeMs(t), TIME_MS);
    await page.evaluate(() => window.__moon.setTimeRate(0));

    // The bake runs in the boot idle; the two float sessions wait for it, so
    // the only difference between them is which material the shell wears. The
    // nofloat session has no tables to wait for and must not pretend otherwise.
    const state = tier === 'nofloat' ? null : await page.waitForFunction(
      () => (window.__moon.atmoState()?.state === 'ready' ? window.__moon.atmoState() : null),
      { timeout: BAKE_TIMEOUT_MS },
    ).then((h) => h.jsonValue()).catch(() => null);
    const wearing = await page.evaluate((t) => window.__moon.atmoTier(t === 'lut' ? null : 'analytic'), tier);
    console.log(`[atmo-qa] ${tier}: tables ${state ? 'ready' : 'none'}, shell Earth=${wearing?.Earth}`);
    if (tier === 'lut' && wearing?.Earth !== 'lut') throw new Error('LUT tier never switched on');
    if (tier !== 'lut' && wearing?.Earth !== 'analytic') throw new Error(`${tier}: shell is not analytic`);
    if (tier === 'nofloat') {
      const forced = await page.evaluate(() => window.__moon.atmoState());
      if (forced && forced.state === 'ready') throw new Error('nofloat session baked tables');
    }

    for (const pose of POSES) {
      const ok = await page.evaluate(
        ([k, f, p]) => window.__moon.limbView('Earth', k, f, p),
        [pose.kRadii, hero ? pose.fov : pose.fov, pose.phase],
      );
      if (!ok) throw new Error(`pose ${pose.name} refused`);
      // Pin after the pose: a framing hook is free to touch the near plane, and
      // the value is the pose's own.
      const pinned = await page.evaluate(
        ([near, exposure]) => window.__moon.pinCapture({ near, exposure, pixelRatio: 1 }),
        [pose.near ?? NEAR_AU, EXPOSURE],
      );
      await page.evaluate((t) => window.__moon.setTimeMs(t), TIME_MS);
      await page.waitForTimeout(1200);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const samples = await capture(page, path.join(outDir, `${pose.name}.${tier}`), {
        pose: pose.name, tier, body: 'Earth', kRadii: pose.kRadii, fovDeg: pose.fov,
        phaseDeg: pose.phase, near: pinned.near, exposure: pinned.exposure, pixelRatio: 1,
        timeUtcMs: TIME_MS,
      });
      const mean = samples.flat().reduce((a, b) => a + b, 0) / (samples.length * 3);
      const peak = Math.max(...samples.flat());
      summary.push(`${pose.name.padEnd(16)} ${tier.padEnd(9)} mean ${mean.toFixed(2).padStart(6)}  peak ${String(peak).padStart(3)}`);
      console.log(`[atmo-qa] ${pose.name} ${tier} -> mean ${mean.toFixed(2)} peak ${peak}`);
    }
    if (errors.length) {
      console.log(`[atmo-qa] page errors (${errors.length}):`);
      for (const e of errors.slice(0, 8)) console.log('    ', e);
    }
    await context.close();
  }

  // The compare ghost: its own mode, its own scene, and a shell that is pinned
  // to the analytic tier in code — captured so that pin cannot rot unnoticed.
  if (!hero) {
    const { context, page, errors } = await newSession();
    await page.goto(`${url}/?auto=volumeCompare`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__moon, { timeout: 60000 });
    await page.waitForTimeout(6000);
    await capture(page, path.join(outDir, 'volume-compare.analytic'), {
      pose: 'volume-compare', tier: 'analytic', body: 'ghost',
      near: null, exposure: 1, pixelRatio: 1, timeUtcMs: null,
    });
    console.log('[atmo-qa] volume-compare ghost captured');
    if (errors.length) for (const e of errors.slice(0, 5)) console.log('     ', e);
    await context.close();
  }
} finally {
  await browser.close();
}

console.log(`\n[atmo-qa] ${outDir}`);
for (const line of summary) console.log('  ', line);
