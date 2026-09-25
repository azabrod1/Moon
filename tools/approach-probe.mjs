// Does the lens proximity ramp do what shared/math/lensProximity.ts says, on
// the real renderer, through the real flight path?
//
// The ramp never runs for a dev pose (frame(), limbView, …): the cruise camera
// pass that builds its body list returns early for devFreeCamera. So this
// battery poses with REAL jumps — `__moon.jumpTo(body, k)`, the legacy centred
// postcard at 8·k radii, which returns the camera to the cruise rig — and at
// every rung reads `__moon.lensRamp()`: the factor, the strength the shaders
// received (`applied`), the angular radius that drove it, and whether a dev
// pose skipped it.
//
// The chase camera trails the parked ship and tilts down, so the body sits
// ABOVE frame centre — an off-axis disc, whose drawn width is not the
// centred formula. The pixel check therefore never assumes a framing: at one
// pose it captures the disc with the ramp on and off, solves the tilt from
// the ramp-off frame (strength 1, whose law tools/oval-probe.mjs already
// pins), and predicts the ramp-on width from that same tilt through the
// exact silhouette of a cone under the blended radial map. That isolates the
// one thing left to prove: the ramped strength reaches the shaders, in the
// frame it was applied.
//
// With --assert it fails on any of:
//   - the ramp ON at boot without ?lensramp=1, or OFF after setLensRamp(true)
//     (the default and the live switch);
//   - devPose true on any sample — a run that silently used a dev pose is void;
//   - applied !== lensProximityFactor(α) at any rung (the probe carries its own
//     copy of the two knees: the unit test pins the module, this pins the
//     plumbing), α ≤ 45° without a 1, α ≥ 70° without a 0, applied not monotone
//     in α down the ladder, or the rebuild counter moving without a change;
//   - on the airless --pixels body, the ramp-on width off its prediction, or
//     not wider than the ramp-off width above 30° (a pinhole draws a big disc
//     larger than the lens does);
//   - landed, a factor other than 1 on the FIRST drawn landed frame from a
//     cruise factor below 1 (the landed update places every overlay before
//     the frame is drawn, so the reset has to precede it), or the ramp not
//     computing again after takeoff;
//   - a run that did not actually exercise what it claims: a ladder that
//     never reached the off knee or never sampled the band, fewer than three
//     pixel samples with the ramp meaningfully active, a landing the app
//     refused, or an uncaught page error. Without --assert those print as
//     notes and the run is exploratory; with it they fail the run, so a
//     regression that stops a path being exercised cannot report success.
//
// Prereq: npm run dev -- --port 5174
//   node tools/approach-probe.mjs --assert
//   node tools/approach-probe.mjs --url=http://localhost:5173 --software --out=planning/approach-probe
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { takeBrowserLock } from './browserLock.mjs';

function arg(name, fallback) {
  const found = process.argv.find((value) => value.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
}

const baseUrl = arg('url', 'http://localhost:5174');
const outDir = arg('out', 'planning/approach-probe');
const assertMode = process.argv.includes('--assert');
const stateBody = arg('body', 'Earth');
const pixelBody = arg('pixels', 'Mercury');
// Wide, so a disc deep in the ramp band still fits side to side; at 2.67:1
// the lens's source corner (74.6°) stays under its 80° cap, so the requested
// strength is honoured in full and `applied` is the ramp's number alone.
const VIEWPORT_WIDTH = Number(arg('w', '2400'));
const VIEWPORT_HEIGHT = Number(arg('h', '900'));
const DESIGN_FOV_DEG = 60;
// The postcard parks the SHIP at 8·k radii from the centre; the camera trails
// it, so the angular radius at each rung is read from the app, never assumed.
const LADDER = arg('ladder', '1,0.5,0.25,0.2,0.18,0.165,0.15,0.14,0.13,0.126')
  .split(',').map(Number);
const PIXEL_LADDER = arg('pixel-ladder', '0.165,0.16,0.155,0.152,0.15,0.148,0.145,0.14')
  .split(',').map(Number);
// Tolerance on the predicted ramp-on width: SwiftShader's edge on both
// frames and the tilt solve's own rounding.
const PIXEL_TOLERANCE = (expectedPx) => Math.max(3, expectedPx * 0.01);

// --- the ramp, as shared/math/lensProximity.ts defines it ---------------------
const DEG = Math.PI / 180;
const LENS_PROXIMITY_FULL_DEG = 45;
const LENS_PROXIMITY_OFF_DEG = 70;
function lensProximityFactor(angularRadiusDeg) {
  if (!(angularRadiusDeg > LENS_PROXIMITY_FULL_DEG)) return 1;
  if (angularRadiusDeg >= LENS_PROXIMITY_OFF_DEG) return 0;
  const t = (angularRadiusDeg - LENS_PROXIMITY_FULL_DEG) / (LENS_PROXIMITY_OFF_DEG - LENS_PROXIMITY_FULL_DEG);
  return 1 - t * t * (3 - 2 * t);
}

// --- the drawn silhouette of a sphere under the blended radial map -----------
const lensRadial = (theta, strength) => (1 - strength) * Math.tan(theta) + strength * 2 * Math.tan(theta / 2);
// Half-width, in frame half-heights, of the silhouette of a sphere whose
// centre sits `tiltRad` off the optical axis (in the vertical plane) and
// subtends `alphaRad`: the widest point of the cone's rim under the map.
// Symmetric about the vertical axis, so the widest ROW's half-extent is the
// rim's largest x.
function silhouetteHalfWidth(tiltRad, alphaRad, strength) {
  const edge = lensRadial((DESIGN_FOV_DEG / 2) * DEG, strength);
  const axisY = Math.sin(tiltRad);
  const axisZ = Math.cos(tiltRad);
  let widest = 0;
  const STEPS = 2000;
  for (let step = 0; step <= STEPS; step++) {
    const psi = (step / STEPS) * Math.PI;
    // rim point = cos α · axis + sin α · (cos ψ · e1 + sin ψ · e2), e1 across, e2 = axis × e1
    const x = Math.sin(alphaRad) * Math.cos(psi);
    const y = Math.cos(alphaRad) * axisY + Math.sin(alphaRad) * Math.sin(psi) * axisZ;
    const z = Math.cos(alphaRad) * axisZ - Math.sin(alphaRad) * Math.sin(psi) * axisY;
    if (!(z > 1e-9)) continue;
    const theta = Math.acos(Math.min(1, z));
    const sinTheta = Math.sin(theta);
    if (!(sinTheta > 1e-12)) continue;
    const screenX = (lensRadial(theta, strength) / edge) * (x / sinTheta);
    if (screenX > widest) widest = screenX;
    void y;
  }
  return widest;
}
// The tilt that draws a sphere of angular radius α this wide at full strength.
function solveTilt(alphaRad, halfWidthHalfHeights) {
  let low = 0;
  let high = 60 * DEG;
  for (let iteration = 0; iteration < 60; iteration++) {
    const middle = (low + high) / 2;
    if (silhouetteHalfWidth(middle, alphaRad, 1) < halfWidthHalfHeights) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

await mkdir(outDir, { recursive: true });
const releaseLock = await takeBrowserLock('approach-probe');
const useGpu = !process.argv.includes('--software');
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

try {
  const context = await browser.newContext({
    viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
    deviceScaleFactor: 1,
  });
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

  // Boot WITHOUT ?lensramp=1: the default is off, and the run proves it.
  await page.goto(`${baseUrl}/?auto=planetarium&quality=medium`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__moon && window.__moon.ready && window.__moon.ready()), { timeout: 120000 });
  await page.waitForFunction(() => {
    const loading = document.getElementById('loading-screen');
    return !loading || loading.classList.contains('hidden');
  }, { timeout: 120000 }).catch(() => {});
  await page.evaluate(() => {
    window.__moon.setChrome(false);
    window.__moon.setBloom(false);
    window.__moon.setAutoExposure(false);
    window.__moon.setShipVisible(false);
    window.__moon.setBeltVisible(false);
    window.__moon.setTimeMs(Date.parse('2026-06-14T00:00:00Z'));
    window.__moon.setTimeRate(0);
  });

  const drawn = (frames = 2) => page.evaluate((n) => window.__moon.waitForDraw(n), frames);
  const rampState = () => page.evaluate(() => window.__moon.lensRamp());
  const setRamp = (on) => page.evaluate((v) => window.__moon.setLensRamp(v), on);

  // A real jump, settled: the veil lifted, frames drawn after it.
  async function jump(body, distanceMultiplier) {
    const jumped = await page.evaluate((a) => window.__moon.jumpTo(a.body, a.k), { body, k: distanceMultiplier });
    if (!jumped) throw new Error(`jumpTo(${body}, ${distanceMultiplier}) refused`);
    await page.waitForTimeout(300);
    await page.waitForFunction(() => {
      const veil = document.getElementById('arrival-veil');
      return !veil || !veil.classList.contains('covering');
    }, { timeout: 60000 });
    await drawn(3);
    await page.waitForTimeout(150);
    return rampState();
  }

  // The drawn disc: flood over lit pixels from a seed inside it (a star would
  // blow a plain bounding box), then the widest row of that component. Its
  // half-extent is the rim's largest x — the disc is horizontally centred —
  // as long as the widest row is not the frame's own top or bottom edge.
  async function measureDisc() {
    const screenshot = await page.screenshot();
    return page.evaluate(async (png) => {
      const image = await new Promise((resolve, reject) => {
        const candidate = new Image();
        candidate.onload = () => resolve(candidate);
        candidate.onerror = reject;
        candidate.src = `data:image/png;base64,${png}`;
      });
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(image, 0, 0);
      const width = canvas.width;
      const height = canvas.height;
      const pixels = ctx.getImageData(0, 0, width, height).data;
      const lit = (x, y) => {
        const index = (y * width + x) * 4;
        return pixels[index] + pixels[index + 1] + pixels[index + 2] > 120;
      };
      // Seed down the vertical centre line, from the frame centre upward: the
      // chase tilt puts the body above centre.
      const column = Math.floor(width / 2);
      let seedY = -1;
      for (let y = Math.floor(height / 2); y >= 0; y -= 4) {
        if (lit(column, y)) { seedY = y; break; }
      }
      if (seedY < 0) return { error: 'nothing lit on the vertical centre line above the frame centre' };
      const seen = new Uint8Array(width * height);
      const queue = new Int32Array(width * height);
      const rowLeft = new Int32Array(height).fill(width);
      const rowRight = new Int32Array(height).fill(-1);
      let head = 0;
      let tail = 0;
      queue[tail++] = seedY * width + column;
      seen[seedY * width + column] = 1;
      let minY = seedY;
      let maxY = seedY;
      while (head < tail) {
        const index = queue[head++];
        const x = index % width;
        const y = (index - x) / width;
        if (x < rowLeft[y]) rowLeft[y] = x;
        if (x > rowRight[y]) rowRight[y] = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        const neighbours = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
        for (const [nx, ny] of neighbours) {
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const nIndex = ny * width + nx;
          if (seen[nIndex] || !lit(nx, ny)) continue;
          seen[nIndex] = 1;
          queue[tail++] = nIndex;
        }
      }
      let widestRow = -1;
      let widest = -1;
      for (let y = minY; y <= maxY; y++) {
        const extent = rowRight[y] - rowLeft[y];
        if (extent > widest) { widest = extent; widestRow = y; }
      }
      const touchesSides = rowLeft[widestRow] === 0 || rowRight[widestRow] === width - 1;
      // The widest row has to be a maximum INSIDE the frame: the component's
      // top and bottom rows both strictly narrower than it. A silhouette whose
      // widest part is off the top (or bottom) is widest AT that edge, and the
      // row measured there is a chord, not the diameter. Integer extents are
      // flat for dozens of rows around a big disc's centre, so no "narrower N
      // rows away" test can say this; the edge rows can.
      // A chord within sqrt(w/2) rows of a w-px disc's centre rounds to the
      // same integer as the diameter, so a widest row that close to the frame
      // edge could be either — a 1-px flip at the antialiased rim decided it
      // once. Only a widest row farther inside than that is the diameter.
      const extentAt = (y) => rowRight[y] - rowLeft[y];
      const flatTopRows = Math.sqrt(widest / 2);
      const interiorMaximum = widestRow - minY > flatTopRows && maxY - widestRow > flatTopRows
        && extentAt(minY) < widest && extentAt(maxY) < widest;
      return {
        halfWidthPx: widest / 2,
        centre: { x: (rowLeft[widestRow] + rowRight[widestRow]) / 2, y: widestRow },
        overflow: touchesSides || !interiorMaximum,
      };
    }, screenshot.toString('base64'));
  }

  const samples = [];

  // ---- 0. the default and the live switch ---------------------------------
  console.log('[0] default off, then the live switch');
  {
    const closeRung = LADDER[Math.max(0, LADDER.length - 3)];
    const off = await jump(stateBody, closeRung);
    console.log(`  boot default at k=${closeRung}: enabled=${off.enabled} factor=${off.factor} applied=${off.applied} alpha=${off.angularRadiusDeg.toFixed(1)}deg`);
    check(off.enabled === false, 'the ramp must be OFF at boot without ?lensramp=1');
    check(off.factor === 1 && off.applied === 1, `off by default: factor ${off.factor}, applied ${off.applied} (want 1, 1)`);
    check(off.devPose === false, 'devPose true on a real jump');
    const switched = await setRamp(true);
    check(switched === true, 'setLensRamp(true) did not report on');
    await drawn(2);
    const on = await rampState();
    console.log(`  after setLensRamp(true): enabled=${on.enabled} factor=${on.factor.toFixed(4)} applied=${on.applied.toFixed(4)} alpha=${on.angularRadiusDeg.toFixed(1)}deg body=${on.body}`);
    check(on.enabled === true, 'the live switch did not enable the ramp');
    check(on.angularRadiusDeg > LENS_PROXIMITY_FULL_DEG && on.factor < 1,
      `at k=${closeRung} the ramp should be engaged (alpha ${on.angularRadiusDeg.toFixed(1)}deg, factor ${on.factor})`);
    samples.push({ phase: 'switch', body: stateBody, k: closeRung, off, on });
  }

  // ---- 1. the ladder: applied strength against the law ---------------------
  console.log(`[1] ${stateBody}: applied strength down the ladder`);
  let previousAlpha = -1;
  let previousApplied = 2;
  let previousApplies = null;
  for (const k of LADDER) {
    const state = await jump(stateBody, k);
    const expected = lensProximityFactor(state.angularRadiusDeg);
    samples.push({ phase: 'ladder', body: stateBody, k, ...state, expectedFactor: expected });
    console.log(`  k=${String(k).padStart(6)}  alpha=${state.angularRadiusDeg.toFixed(2).padStart(6)}deg  body=${String(state.body).padEnd(8)}  factor=${state.factor.toFixed(4)}  applied=${state.applied.toFixed(4)}  expected=${expected.toFixed(4)}  applies=${state.applies}${state.devPose ? '  DEV POSE' : ''}`);
    check(state.devPose === false, `k=${k}: devPose — the ramp did not run`);
    check(state.enabled === true, `k=${k}: ramp reported off`);
    check(Math.abs(state.factor - expected) < 1e-9, `k=${k}: factor ${state.factor} != law ${expected} at alpha ${state.angularRadiusDeg}`);
    check(Math.abs(state.applied - state.factor) < 1e-9, `k=${k}: applied ${state.applied} != factor ${state.factor} (requested strength should be 1)`);
    if (state.angularRadiusDeg <= LENS_PROXIMITY_FULL_DEG) check(state.applied === 1, `k=${k}: alpha ${state.angularRadiusDeg.toFixed(2)} <= 45 but applied ${state.applied}`);
    if (state.angularRadiusDeg >= LENS_PROXIMITY_OFF_DEG) check(state.applied === 0, `k=${k}: alpha ${state.angularRadiusDeg.toFixed(2)} >= 70 but applied ${state.applied}`);
    if (previousAlpha >= 0) {
      check(state.angularRadiusDeg > previousAlpha, `k=${k}: alpha did not grow down the ladder (${previousAlpha.toFixed(2)} -> ${state.angularRadiusDeg.toFixed(2)})`);
      check(state.applied <= previousApplied + 1e-12, `k=${k}: applied rose down the ladder`);
    }
    if (previousApplies !== null) {
      const changed = Math.abs(state.applied - previousApplied) > 0;
      check(changed ? state.applies > previousApplies : state.applies === previousApplies,
        `k=${k}: applies ${previousApplies} -> ${state.applies} but the factor ${changed ? 'changed' : 'did not change'}`);
    }
    previousAlpha = state.angularRadiusDeg;
    previousApplied = state.applied;
    previousApplies = state.applies;
  }
  const reachedOff = samples.some((s) => s.phase === 'ladder' && s.angularRadiusDeg >= LENS_PROXIMITY_OFF_DEG);
  const reachedBand = samples.some((s) => s.phase === 'ladder' && s.angularRadiusDeg > LENS_PROXIMITY_FULL_DEG && s.angularRadiusDeg < LENS_PROXIMITY_OFF_DEG);
  const reachedFull = samples.some((s) => s.phase === 'ladder' && s.angularRadiusDeg <= LENS_PROXIMITY_FULL_DEG);
  check(reachedFull, 'the ladder never sampled at full strength (at or under the full knee)');
  check(reachedBand, 'the ladder never sampled inside the ramp band');
  check(reachedOff, 'the ladder never reached the off knee (alpha >= 70deg); lengthen the ladder toward the shell');

  // ---- 2. the drawn disc: the same pose with the ramp on and off -----------
  console.log(`[2] ${pixelBody}: the drawn disc, ramp on against ramp off at one pose`);
  let pixelSamplesJudged = 0;
  let pixelSamplesActive = 0;
  for (const k of PIXEL_LADDER) {
    const on = await jump(pixelBody, k);
    const drawnOn = await measureDisc();
    await page.screenshot({ path: path.join(outDir, `${pixelBody.toLowerCase()}-k${String(k).replace('.', 'p')}-on.png`) });
    await setRamp(false);
    await drawn(2);
    const off = await rampState();
    const drawnOff = await measureDisc();
    await page.screenshot({ path: path.join(outDir, `${pixelBody.toLowerCase()}-k${String(k).replace('.', 'p')}-off.png`) });
    await setRamp(true);
    await drawn(2);
    const alphaRad = on.angularRadiusDeg * DEG;
    const record = { phase: 'pixels', body: pixelBody, k, on, off, drawnOn, drawnOff };
    samples.push(record);
    const problem = drawnOn.error ?? drawnOff.error ?? (drawnOn.overflow || drawnOff.overflow ? 'disc overflows the frame' : null);
    check(on.devPose === false && off.devPose === false, `${pixelBody} k=${k}: devPose`);
    check(off.applied === 1 && off.enabled === false, `${pixelBody} k=${k}: ramp off but applied ${off.applied}, enabled ${off.enabled}`);
    // The off state computes no angle (a kill switch does no work); the pose
    // is the same jump, and the ramp-on read after the flip back says so.
    const back = await rampState();
    check(Math.abs(back.angularRadiusDeg - on.angularRadiusDeg) < 1e-6, `${pixelBody} k=${k}: the pose moved across the flip (${on.angularRadiusDeg} -> ${back.angularRadiusDeg})`);
    if (problem) {
      console.log(`  k=${String(k).padStart(6)}  alpha=${on.angularRadiusDeg.toFixed(2)}deg  ${problem} — not judged`);
      continue;
    }
    const tiltRad = solveTilt(alphaRad, drawnOff.halfWidthPx / (VIEWPORT_HEIGHT / 2));
    const predictedOn = silhouetteHalfWidth(tiltRad, alphaRad, on.applied) * (VIEWPORT_HEIGHT / 2);
    const delta = drawnOn.halfWidthPx - predictedOn;
    record.tiltDeg = tiltRad / DEG;
    record.predictedOnPx = predictedOn;
    console.log(`  k=${String(k).padStart(6)}  alpha=${on.angularRadiusDeg.toFixed(2).padStart(6)}deg  tilt=${(tiltRad / DEG).toFixed(2)}deg  off(s=1)=${drawnOff.halfWidthPx.toFixed(1).padStart(6)} px  on(s=${on.applied.toFixed(3)})=${drawnOn.halfWidthPx.toFixed(1).padStart(6)} px  predicted=${predictedOn.toFixed(1).padStart(6)} px  delta=${delta >= 0 ? '+' : ''}${delta.toFixed(1)}`);
    pixelSamplesJudged++;
    if (on.applied < 0.999) pixelSamplesActive++;
    check(Math.abs(delta) <= PIXEL_TOLERANCE(predictedOn),
      `${pixelBody} k=${k}: ramp-on width ${drawnOn.halfWidthPx.toFixed(1)} px vs predicted ${predictedOn.toFixed(1)} px at strength ${on.applied.toFixed(3)} (alpha ${on.angularRadiusDeg.toFixed(2)}deg, tilt ${(tiltRad / DEG).toFixed(2)}deg)`);
    if (predictedOn - drawnOff.halfWidthPx > 3 && on.angularRadiusDeg > 30) {
      check(drawnOn.halfWidthPx > drawnOff.halfWidthPx, `${pixelBody} k=${k}: with the ramp on the disc should draw WIDER than the lens draws it (${drawnOn.halfWidthPx} vs ${drawnOff.halfWidthPx})`);
    }
  }
  check(pixelSamplesJudged >= 3, `only ${pixelSamplesJudged} pixel sample(s) could be judged — widen the frame or move the pixel ladder`);
  check(pixelSamplesActive >= 3, `only ${pixelSamplesActive} judged pixel sample(s) had the ramp meaningfully active (applied < 0.999) — a disc that the ramp did not change proves nothing about it`);

  // ---- 3. the surface gate, and the ramp after takeoff ----------------------
  console.log('[3] landed: the ramp reads 1; after takeoff it computes again');
  {
    const closeRung = LADDER[LADDER.length - 1];
    const before = await jump(stateBody, closeRung);
    check(before.factor < 1, `the landing must start from a cruise factor below 1 (k=${closeRung} read ${before.factor})`);
    const landed = await page.evaluate((body) => window.__moon.land(body), stateBody);
    check(landed === true, 'land() refused — the surface gate was not exercised');
    if (!landed) {
      samples.push({ phase: 'landed', skipped: true });
    } else {
      // The FIRST drawn landed frame: the landed update places every overlay
      // through the lens before the frame is drawn, so the factor must already
      // read 1 on that frame, not after the rig has settled.
      await drawn(1);
      const firstFrame = await rampState();
      console.log(`  first drawn landed frame: factor=${firstFrame.factor} applied=${firstFrame.applied} (was ${before.factor.toFixed(4)} in cruise at k=${closeRung})`);
      check(firstFrame.factor === 1 && firstFrame.applied === 1, `first landed frame: factor ${firstFrame.factor}, applied ${firstFrame.applied} (want 1, 1)`);
      await page.waitForTimeout(600);
      await drawn(3);
      const onGround = await rampState();
      console.log(`  settled landed: factor=${onGround.factor} applied=${onGround.applied}`);
      check(onGround.factor === 1 && onGround.applied === 1, `landed: factor ${onGround.factor}, applied ${onGround.applied} (want 1, 1)`);
      const tookOff = await page.evaluate(() => window.__moon.takeoff());
      check(tookOff === true, 'takeoff() refused');
      await page.waitForTimeout(600);
      await drawn(3);
      const airborne = await rampState();
      console.log(`  after takeoff: body=${airborne.body} alpha=${airborne.angularRadiusDeg.toFixed(2)}deg factor=${airborne.factor.toFixed(4)} devPose=${airborne.devPose}`);
      check(airborne.devPose === false && airborne.body !== null, 'after takeoff the ramp is not computing again');
      const after = await jump(stateBody, closeRung);
      console.log(`  jumped back in: factor=${after.factor.toFixed(4)} applied=${after.applied.toFixed(4)}`);
      check(after.factor < 1, 'the ramp did not engage on a close jump after takeoff');
      samples.push({ phase: 'landed', before, firstFrame, onGround, airborne, after });
    }
  }

  check(pageErrors.length === 0, `${pageErrors.length} uncaught page error(s): ${pageErrors.slice(0, 3).join(' | ')}`);
  await writeFile(path.join(outDir, 'approach-probe.json'), JSON.stringify({ baseUrl, viewport: [VIEWPORT_WIDTH, VIEWPORT_HEIGHT], samples, failures, pageErrors }, null, 2));
} finally {
  await browser.close();
  releaseLock();
}

console.log(`\n${failures.length ? `${failures.length} failure(s)` : 'all checks passed'} — ${outDir}`);
if (assertMode && failures.length) process.exit(1);
