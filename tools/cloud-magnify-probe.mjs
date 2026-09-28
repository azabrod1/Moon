// Do magnified clouds stay white when the surface air never bound?
//
// Earth's cloud deck carries a close-range detail term — ragged edges and a
// relief bump — that switches on once the cloud map is magnified past ~0.6
// noise texels per pixel: the last few hundred km of an approach at the frame
// centre, a narrowed field of view, or a plain pinhole's stretched edges. The
// bump turns its relief, a fraction of the body's radius, back into kilometres
// by multiplying with the surface air's uPlanetRadius. Until
// surfaceShading.seatSurfaceAirRadius, the only writer of that uniform was
// the air's own binding, which runs once the body's atmosphere tables exist;
// with no tables it held its default of 1, one AU, and the bump drew 70,000 km
// of relief where 3 were authored — normals pointing anywhere, clouds lit
// black wherever the map was magnified. Every air lookup is gated on the
// density, so nothing else ever read the default, and a device that bakes its
// tables never showed it: the bind seated the radius first. The devices that
// showed it are the ones whose bake is unavailable (a software renderer, a
// slow device) and, for a moment after boot, the rest.
//
// So this probe holds the tables away on purpose — `__moon.atmoTier('analytic')`
// keeps every surface's air off, whatever the device would bake — and checks
// the two things that matter, on the real renderer:
//   1. the deck's COMPILED program binds the body's radius (read from the
//      renderer's own uniform bindings, not the module's intent), with the
//      air density at 0 to prove the condition was reached;
//   2. clouds magnified two ways — a plain pinhole at the design field of view
//      (the edges) and the shipped lens zoomed to 10° (the centre) — stay
//      white: each pose is captured with the detail term on and, through the
//      `cloud-probe-detail` switch, off, and the pair is measured per pixel:
//      the share of the region whose luminance fell by more than 60 (of 255)
//      from the reference to the detail-on frame. The term's own erosion
//      never moves a pixel that far — it thins cloud edges by at most 45 % —
//      where a cloud lit black drops by 150 or more. On a software renderer
//      the bug darkened 3.0 % of the pinhole frame and 1.3 % of the zoomed
//      centre that way; the fix 0.000 % of both. The pair is a per-pixel
//      comparison, so both shots must hold the same maps: the surface is
//      settled first (no tile loading, the colour ladder quiet for two reads)
//      and a pair whose maps changed between its shots — an 8k rung landing
//      seconds after the jump on a slow renderer, which moved 0.4 % of the
//      frame past the bar with the clouds white — is settled again and
//      retaken, twice at most.
//
// With --assert the run fails on: a refused jump or tier override; air that
// bound anyway; a deck radius off the body's by more than 1e-9 relative;
// more than 0.3 % of a region darkened past 60; a pair whose maps still
// differ after the retakes; a reference with almost no cloud in it (a pose
// that tests nothing); or an uncaught page error.
//
// Prereq: npm run dev -- --port 5174
//   node tools/cloud-magnify-probe.mjs --assert
//   node tools/cloud-magnify-probe.mjs --url=http://localhost:5173 --software --out=planning/cloud-magnify-probe
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { takeBrowserLock } from './browserLock.mjs';

function arg(name, fallback) {
  const found = process.argv.find((value) => value.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
}
const baseUrl = arg('url', 'http://localhost:5174');
const outDir = arg('out', 'planning/cloud-magnify-probe');
const assertMode = process.argv.includes('--assert');
const useGpu = !process.argv.includes('--software');
const VIEWPORT_WIDTH = Number(arg('w', '1280'));
const VIEWPORT_HEIGHT = Number(arg('h', '720'));
// 771 km over central Mexico on the sunward radial at this clock: high enough
// that the design field of view holds the whole continent, low enough that a
// pinhole's edges and a 10° centre both magnify the deck past the term's knee.
const ALTITUDE_KM = Number(arg('altitude', '771'));
const CLOCK = arg('time', '2026-06-14T18:40:00Z');
const KM_PER_AU = 149_597_870.7;
const DARKENED_LIMIT = 0.003;
const DARKENING_STEP = 60;
const CLOUD_LUMINANCE = 150;
const RADIUS_TOLERANCE = 1e-9;

await mkdir(outDir, { recursive: true });
const releaseLock = await takeBrowserLock('cloud-magnify-probe');
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PW_CHROMIUM || undefined,
  args: useGpu
    ? ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader']
    : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const failures = [];
const fail = (message) => { failures.push(message); console.log(`  FAIL  ${message}`); };
const check = (condition, message) => { if (!condition) fail(message); };
const report = { baseUrl, viewport: [VIEWPORT_WIDTH, VIEWPORT_HEIGHT], altitudeKm: ALTITUDE_KM, clock: CLOCK, poses: [] };

try {
  const context = await browser.newContext({ viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT }, deviceScaleFactor: 1 });
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
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.goto(`${baseUrl}/?auto=planetarium&quality=medium`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__moon && window.__moon.ready && window.__moon.ready()), { timeout: 180000 });
  await page.waitForFunction(() => {
    const loading = document.getElementById('loading-screen');
    return !loading || loading.classList.contains('hidden');
  }, { timeout: 180000 }).catch(() => {});
  const drawn = (frames = 2) => page.evaluate((n) => window.__moon.waitForDraw(n), frames);

  // What could differ between the two shots of a pair besides the term: the
  // sector tiles and the globe maps' tiers. Read with every shot, settled
  // before a pair.
  const surfaceState = () => page.evaluate(() => {
    const stats = window.__moon.sectors();
    const own = stats?.bodies?.Earth;
    const rungs = (window.__moon.ladder()?.rungs ?? [])
      .filter((entry) => entry.key.toLowerCase().includes('earth'))
      .map((entry) => `${entry.key}:${entry.tier}`).sort();
    return { loading: stats?.loading ?? null, resident: own ? [...own.resident].sort() : [], tiers: rungs.join(' ') };
  });
  const surfaceKey = (state) => JSON.stringify([state.resident, state.tiers]);
  async function settleSurface(limitMs) {
    const started = Date.now();
    let previous = null;
    let stableReads = 0;
    while (Date.now() - started < limitMs) {
      const now = await surfaceState();
      const key = surfaceKey(now);
      stableReads = previous === key && now.loading === 0 ? stableReads + 1 : 0;
      if (stableReads >= 2) return now;
      previous = key;
      await page.waitForTimeout(400);
    }
    return surfaceState();
  }

  // The condition: every surface's air held off, whatever this device bakes.
  const tier = await page.evaluate((clock) => {
    window.__moon.setChrome(false);
    window.__moon.setShipVisible(true);
    window.__moon.setBeltVisible(false);
    window.__moon.setAutoExposure(false);
    window.__moon.setTimeMs(Date.parse(clock));
    window.__moon.setTimeRate(0);
    return window.__moon.atmoTier('analytic');
  }, CLOCK);
  check(tier !== null, 'atmoTier(\'analytic\') refused — the surface air could not be held off');
  report.tier = tier;
  report.atmoState = await page.evaluate(() => window.__moon.atmoState());

  const earth = await page.evaluate(() => window.__moon.probe('Earth'));
  const radiusKm = earth.radiusAU * KM_PER_AU;
  const k = (radiusKm + ALTITUDE_KM) / (8 * radiusKm);
  const jumped = await page.evaluate((multiplier) => window.__moon.jumpTo('Earth', multiplier), k);
  check(jumped === true, `jumpTo('Earth', ${k.toFixed(5)}) refused`);
  await page.waitForTimeout(300);
  await page.waitForFunction(() => {
    const veil = document.getElementById('arrival-veil');
    return !veil || !veil.classList.contains('covering');
  }, { timeout: 90000 });
  await drawn(3);
  await page.evaluate(() => window.__moon.setShipVisible(true));
  const reached = await page.evaluate(() => window.__moon.probe('Earth'));
  console.log(`[1] parked ${(reached.distToBodyAU * KM_PER_AU - radiusKm).toFixed(0)} km over Earth, tables ${report.atmoState?.state ?? '?'}, tier ${JSON.stringify(tier)}`);

  // ---- 1. what the deck's compiled program binds --------------------------
  const bindings = await page.evaluate(async () => {
    const renderer = window.__moonRenderer;
    if (!renderer) return { error: 'no renderer on the bridge' };
    const scenes = new Set();
    const original = renderer.render.bind(renderer);
    renderer.render = (scene, camera) => { scenes.add(scene); return original(scene, camera); };
    await window.__moon.waitForDraw(2);
    renderer.render = original;
    const rows = [];
    for (const scene of scenes) {
      scene.traverse((object) => {
        if (!object.isMesh || !/^Earth( surface| night| clouds)?$/.test(object.name)) return;
        const uniforms = renderer.properties.get(object.material)?.uniforms;
        if (!uniforms?.uPlanetRadius) return;
        rows.push({
          mesh: object.name,
          uPlanetRadius: uniforms.uPlanetRadius.value,
          uAirDensity: uniforms.uAirDensity?.value ?? null,
          uCloudDeck: uniforms.uCloudDeck?.value ?? null,
          uCloudDetailRelief: uniforms.uCloudDetailRelief?.value ?? null,
        });
      });
    }
    return { rows, renderer: renderer.getContext().getParameter(renderer.getContext().RENDERER) };
  });
  report.bindings = bindings;
  check(!bindings.error, bindings.error ?? '');
  const deck = bindings.rows?.find((row) => row.uCloudDeck === 1);
  check(!!deck, 'no compiled program with the deck archetype was found among Earth\'s meshes');
  if (deck) {
    const relative = Math.abs(deck.uPlanetRadius - earth.radiusAU) / earth.radiusAU;
    console.log(`  ${deck.mesh}: uPlanetRadius ${deck.uPlanetRadius} (body ${earth.radiusAU}, off by ${relative.toExponential(2)}), uAirDensity ${deck.uAirDensity}, relief ${deck.uCloudDetailRelief}`);
    check(deck.uAirDensity === 0, `the deck's air bound anyway (uAirDensity ${deck.uAirDensity}) — the condition was not reached`);
    check(relative <= RADIUS_TOLERANCE, `the deck's program binds a radius of ${deck.uPlanetRadius}, not the body's ${earth.radiusAU}: the bump would draw ${(deck.uPlanetRadius / earth.radiusAU * 3).toExponential(2)} km of relief for 3`);
    for (const row of bindings.rows) if (row !== deck) console.log(`  ${row.mesh}: uPlanetRadius ${row.uPlanetRadius}, uAirDensity ${row.uAirDensity}`);
  }

  // ---- 2. magnified clouds, detail on against off ---------------------------
  async function capture(label) {
    const file = path.join(outDir, `${label}.jpg`);
    const buffer = await page.screenshot({ type: 'jpeg', quality: 90 });
    await writeFile(file, buffer);
    return { file, base64: buffer.toString('base64') };
  }
  async function compare(onShot, offShot, crop) {
    return page.evaluate(async ({ on, off, region, step, cloudLuminance }) => {
      const load = (src) => new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = `data:image/jpeg;base64,${src}`;
      });
      const [a, b] = await Promise.all([load(on), load(off)]);
      const read = (image) => {
        const canvas = document.createElement('canvas');
        canvas.width = region[2];
        canvas.height = region[3];
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(image, region[0], region[1], region[2], region[3], 0, 0, region[2], region[3]);
        return ctx.getImageData(0, 0, region[2], region[3]).data;
      };
      const pa = read(a);
      const pb = read(b);
      const n = region[2] * region[3];
      const luminance = (p, i) => 0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2];
      let cloudOff = 0;
      let cloudOn = 0;
      let darkened = 0;
      for (let i = 0; i < pa.length; i += 4) {
        const off = luminance(pb, i);
        const on = luminance(pa, i);
        if (off > cloudLuminance) cloudOff++;
        if (on > cloudLuminance) cloudOn++;
        if (off - on > step) darkened++;
      }
      return { pixels: n, cloudOn: cloudOn / n, cloudOff: cloudOff / n, darkened: darkened / n };
    }, { on: onShot.base64, off: offShot.base64, region: crop, step: DARKENING_STEP, cloudLuminance: CLOUD_LUMINANCE });
  }
  const detail = (on) => page.evaluate((value) => window.__moon.perfArm('cloud-probe-detail', value), on);
  async function pose(label, setup, crop, teardown) {
    await page.evaluate(setup);
    await drawn(3);
    await page.waitForTimeout(300);
    await drawn(1);
    let onShot = null;
    let offShot = null;
    let before = null;
    let after = null;
    let retakes = 0;
    for (; retakes < 3; retakes++) {
      before = await settleSurface(20000);
      onShot = await capture(`${label}-detail-on`);
      check((await detail(true)) === true, `${label}: the cloud-probe-detail switch refused`);
      await drawn(3);
      offShot = await capture(`${label}-detail-off`);
      after = await surfaceState();
      await detail(false);
      await drawn(2);
      if (surfaceKey(before) === surfaceKey(after)) break;
    }
    const sameSurface = surfaceKey(before) === surfaceKey(after);
    if (!sameSurface) retakes -= 1;
    if (teardown) { await page.evaluate(teardown); await drawn(2); }
    const measured = await compare(onShot, offShot, crop);
    console.log(`  ${label}: cloud ${(measured.cloudOff * 100).toFixed(2)}% of the region with the term off, ${(measured.cloudOn * 100).toFixed(2)}% with it on; darkened past ${DARKENING_STEP}: ${(measured.darkened * 100).toFixed(3)}%${retakes ? ` (retaken ×${retakes})` : ''}`);
    check(sameSurface, `${label}: the maps changed between the two shots after ${retakes} retake(s) (${before.tiers} | ${after.tiers}; ${before.resident.length}/${after.resident.length} tiles), so the pair cannot be compared`);
    if (sameSurface) check(measured.darkened <= DARKENED_LIMIT, `${label}: ${(measured.darkened * 100).toFixed(2)}% of the region lost more than ${DARKENING_STEP} of luminance under the detail term — clouds drawn dark`);
    check(measured.cloudOff > 0.005, `${label}: the reference shows almost no cloud (${(measured.cloudOff * 100).toFixed(2)}%) — the pose is not testing clouds`);
    report.poses.push({ label, crop, ...measured, retakes, sameSurface, surface: after, on: onShot.file, off: offShot.file });
  }
  console.log('[2] magnified clouds, the detail term on against off');
  await pose('pinhole-60deg', () => window.__moon.setLens(0), [0, 0, VIEWPORT_WIDTH, VIEWPORT_HEIGHT], () => window.__moon.setLens());
  await pose('lens-10deg-centre', () => window.__moon.setFov(10),
    [Math.floor(VIEWPORT_WIDTH * 0.25), Math.floor(VIEWPORT_HEIGHT * 0.25), Math.floor(VIEWPORT_WIDTH * 0.5), Math.floor(VIEWPORT_HEIGHT * 0.5)],
    () => window.__moon.setFov(60));

  report.pageErrors = pageErrors;
  check(pageErrors.length === 0, `${pageErrors.length} uncaught page error(s): ${pageErrors[0] ?? ''}`);
  report.failures = failures;
  await writeFile(path.join(outDir, 'cloud-magnify-probe.json'), JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  releaseLock();
}
console.log(`\n${failures.length ? `${failures.length} failure(s)` : 'all checks passed'} — ${outDir}`);
if (assertMode && failures.length) process.exit(1);
