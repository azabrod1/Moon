// Orbit-line probe: does an orbit line hold still on screen while the ship
// flies along it?
//
// A line is the one thing in the scene that has no business moving when the
// camera translates along it: the ship's motion is parallel to the line, the
// heading is fixed, the clock is frozen. So the probe parks the camera a few
// radii from a body with its orbit line across the frame and the body's own
// disc pushed off-screen (its parallax would otherwise be the biggest thing
// that moves), hides everything but the lines, then nudges the ship along the
// body's orbital velocity a few km at a time and reads where the line sits in
// every frame. Any motion is the renderer's. The lines used to be heliocentric
// float32 vertices translated by a float32 −ship, and at Pluto's distance that
// difference steps by ~285 km at a time — tens of pixels for a camera a few
// thousand km from the line. src/planetarium/orbitLineAnchor.ts is the fix;
// `?orbitanchor=0` is the old pose, and the control run must fail on it.
//
//   node tools/orbit-line-probe.mjs --url=http://localhost:5690 --bodies=Pluto,Neptune
//   node tools/orbit-line-probe.mjs --url=... --extra='&orbitanchor=0' --expect=fail   # the control
//
// The reading: in every column of the left half of the frame, the row of the
// brightest ridge (luma-weighted over its neighbours, so it resolves below a
// pixel); the frame's displacement is the median over columns of that row's
// change since the first scored frame. A line that translates along itself
// reads zero; one that shifts across itself reads the shift. Stars and moons
// take a few columns each and the median ignores them.
//
// PASS: the displacement changes by less than JUMP_MAX_PX between consecutive
// steps and stays within RANGE_MAX_PX of zero over the run, for every body.
// `--expect=fail` inverts the exit code so the control proves the probe sees
// the defect (Pluto alone is enough: at Neptune's distance a tick is a couple
// of pixels and the run may not cross one). GPU flags as every battery; takes
// /tmp/moon-browser.lock. The first, worst and last frames land in
// /tmp/moon-shots/<label>/ beside a JSON of every reading.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { takeBrowserLock } from './browserLock.mjs';
import { decodePng } from './pngDecode.mjs';

const arg = (k, d) => { const m = process.argv.find((a) => a.startsWith(`--${k}=`)); return m ? m.slice(k.length + 3) : d; };
const URL = arg('url', 'http://localhost:5173');
const BODIES = arg('bodies', 'Pluto,Neptune').split(',').map((s) => s.trim()).filter(Boolean);
const EXPECT = arg('expect', 'pass');
const EXTRA = arg('extra', '');
const LABEL = arg('label', 'orbit-line');
const STEP_KM = Number(arg('step', '5'));
const STEPS = Number(arg('steps', '200'));
const FILL = Number(arg('fill', '0.5'));
const PHASE = Number(arg('phase', '90'));
const DIST_MUL = Number(arg('dist', '4'));
const OFF_NDC_X = Number(arg('off', '1.8')); // the disc sits here: off the right edge, and stays off as parallax walks it left
const W = Number(arg('w', '1200'));
const H = Number(arg('h', '800'));
const JUMP_MAX_PX = Number(arg('jump', '0.5'));
const RANGE_MAX_PX = Number(arg('range', '1'));
const RIDGE_MIN_LUMA = 15;
const RIDGE_MAX_LUMA = 200; // brighter than any line: a star
const WARM_STEPS = 3; // readings before the pose has settled are not scored
const KM_PER_AU = 149_597_870.7;
const OUT = `/tmp/moon-shots/${LABEL}`;
mkdirSync(OUT, { recursive: true });

const GPU_ARGS = ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frames = (page, n) => page.evaluate((count) => new Promise((resolve) => {
  let i = 0;
  const tick = () => { if (++i >= count) resolve(); else requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}), n);

/** Per column of the left half: the sub-pixel row of the brightest ridge, or
 *  NaN where there is none (or where it is a star). */
function ridgeRows(png) {
  const { width, height, channels, pixels } = png;
  const luma = (x, y) => { const i = (y * width + x) * channels; return 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2]; };
  const rows = [];
  for (let x = 20; x < width / 2; x++) {
    let best = -1, bestY = 0;
    for (let y = 0; y < height; y++) { const l = luma(x, y); if (l > best) { best = l; bestY = y; } }
    if (best < RIDGE_MIN_LUMA || best > RIDGE_MAX_LUMA) { rows.push(NaN); continue; }
    let s = 0, m = 0;
    for (let y = Math.max(0, bestY - 4); y <= Math.min(height - 1, bestY + 4); y++) { const l = luma(x, y); s += y * l; m += l; }
    rows.push(s / m);
  }
  return rows;
}
const median = (a) => { const s = a.filter(Number.isFinite).sort((p, q) => p - q); return s.length ? s[s.length >> 1] : NaN; };

const release = await takeBrowserLock('orbit-line');
const browser = await chromium.launch({ headless: true, args: GPU_ARGS });
let allPass = true;
const report = {};
try {
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await context.addInitScript(() => {
    try {
      localStorage.clear();
      sessionStorage.clear();
      indexedDB.deleteDatabase('orbital-sim-storage');
      localStorage.setItem('planetarium-help-seen', '1');
    } catch {}
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`[orbit-line] page error: ${e.message}`));
  await page.goto(`${URL}/?auto=planetarium${EXTRA}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__moon?.ready?.(), null, { timeout: 90_000 });
  await sleep(1500);

  for (const body of BODIES) {
    // The clock runs while the pose settles: the body's velocity is differenced
    // from its motion frame to frame, and a paused clock reports none. It is
    // frozen only once the direction has been read.
    const posed = await page.evaluate(({ body, fill, phase, dist, off }) => {
      const m = window.__moon;
      m.setTimePaused(false);
      const ok = m.frame(body, fill, phase, dist, off, 0);
      m.setChrome(false);
      m.setOrbitLines(true);
      return ok;
    }, { body, fill: FILL, phase: PHASE, dist: DIST_MUL, off: OFF_NDC_X });
    if (!posed) { console.log(`[orbit-line] ${body}: could not pose`); allPass = false; continue; }
    await sleep(1200);
    await frames(page, 3);
    const probe = await page.evaluate((b) => window.__moon.probe(b), body);
    await page.evaluate(() => window.__moon.setTimePaused(true));
    await frames(page, 2);
    const v = probe?.velAUPerS;
    const speed = v ? Math.hypot(v.x, v.y, v.z) : 0;
    if (!(speed > 0)) { console.log(`[orbit-line] ${body}: no orbital velocity from probe()`); allPass = false; continue; }
    const step = STEP_KM / KM_PER_AU;
    const d = { x: (v.x / speed) * step, y: (v.y / speed) * step, z: (v.z / speed) * step };
    const distKm = probe.distToBodyAU * KM_PER_AU;

    const readings = []; // per step: displacement (px) of the line since the first scored frame, and the columns it was read from
    let baseRows = null;
    let first = null, last = null, worst = { jump: 0, at: -1, png: null };
    for (let k = 0; k <= STEPS; k++) {
      if (k > 0) await page.evaluate((dd) => window.__moon.nudge(dd.x, dd.y, dd.z), d);
      await frames(page, 2);
      const png = await page.screenshot({ type: 'png' });
      const rows = ridgeRows(decodePng(png));
      if (k === 0) first = png;
      last = png;
      if (k < WARM_STEPS) { readings.push(null); continue; }
      if (!baseRows) baseRows = rows;
      const deltas = rows.map((r, i) => r - baseRows[i]);
      const cols = deltas.filter(Number.isFinite).length;
      const shift = median(deltas);
      readings.push({ shift, cols });
      const prev = readings[k - 1];
      if (prev && Number.isFinite(shift)) {
        const jump = Math.abs(shift - prev.shift);
        if (jump > worst.jump) worst = { jump, at: k, png };
      }
    }
    const scored = readings.filter(Boolean);
    let maxJump = 0, range = 0, minCols = Infinity;
    for (let i = 0; i < scored.length; i++) {
      const c = scored[i];
      minCols = Math.min(minCols, c.cols);
      if (!Number.isFinite(c.shift)) continue;
      range = Math.max(range, Math.abs(c.shift));
      if (i > 0 && Number.isFinite(scored[i - 1].shift)) maxJump = Math.max(maxJump, Math.abs(c.shift - scored[i - 1].shift));
    }
    const seen = scored.length === STEPS + 1 - WARM_STEPS && minCols >= 100 && scored.every((c) => Number.isFinite(c.shift));
    const pass = seen && maxJump < JUMP_MAX_PX && range < RANGE_MAX_PX;
    allPass &&= pass;
    report[body] = { pass, seen, maxJump, range, minCols, steps: STEPS, stepKm: STEP_KM, distKm, fov: probe.fov, readings };
    console.log(
      `[orbit-line] ${body.padEnd(8)} ${pass ? 'PASS' : 'FAIL'}  ` +
      `camera ${distKm.toFixed(0)} km from the body, ${STEPS} steps of ${STEP_KM} km along its orbit, ` +
      `line read in ≥ ${minCols} columns: worst step ${maxJump.toFixed(2)} px (at step ${worst.at}), farthest from start ${range.toFixed(2)} px` +
      (seen ? '' : '  — line not read in every frame'),
    );
    writeFileSync(`${OUT}/${body}-first.png`, first);
    writeFileSync(`${OUT}/${body}-last.png`, last);
    if (worst.png) writeFileSync(`${OUT}/${body}-worst-step${worst.at}.png`, worst.png);
  }
} finally {
  await browser.close();
  release();
}
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
const ok = EXPECT === 'fail' ? !allPass : allPass;
console.log(`[orbit-line] ${ok ? 'OK' : 'NOT OK'} (expected ${EXPECT}; frames in ${OUT})`);
process.exit(ok ? 0 : 1);
