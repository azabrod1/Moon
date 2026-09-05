// Station probe: does a ship with its dial at zero hold its ground over a body?
//
// The ship's position is heliocentric and only its own thrust moves it, so a
// ship parked on a body's collision shell can be swept along by the body's
// orbital motion — the ground streams past at orbital speed while the readout
// says 0 km/s. This battery flies the real pilot inputs (arrow keys to aim the
// nose at the body — to the screen mark the flight direction projects at, which
// sits above the centre under the lifted chase camera — W down to the shell, S
// to zero) and then watches two things
// for a settle window: the altitude above the rendered surface, and how far the
// body's centre drifts across a fixed heading (the ship's angular walk around
// the shell, calibrated from the disc's pixel diameter at the aimed distance).
// It does not look at ground pixels: the ground turns under a hover at the
// body's spin, which is not what this probe judges.
//
//   node tools/station-probe.mjs --url=http://localhost:5670 --bodies=Earth,Moon,Io
//   node tools/station-probe.mjs --url=... --expect=fail --extra='&ride=0'   # the control
//   node tools/station-probe.mjs --url=... --bodies=Earth --scenario=park,warp,seams
//
// PASS: centre drift < DRIFT_MAX_DEG_S and altitude swing < ALT_MAX_KM over the
// window. `--expect=fail` inverts the exit code so a control run proves the probe
// sees the defect. GPU flags as every battery; takes /tmp/moon-browser.lock.
import { chromium } from 'playwright';
import { takeBrowserLock } from './browserLock.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const arg = (k, d) => { const m = process.argv.find((a) => a.startsWith(`--${k}=`)); return m ? m.slice(k.length + 3) : d; };
const URL = arg('url', 'http://localhost:5173');
const BODIES = arg('bodies', 'Earth,Moon,Io').split(',');
const EXPECT = arg('expect', 'pass');
const EXTRA = arg('extra', '');
const LABEL = arg('label', 'station');
const WINDOW_S = Number(arg('window', '10'));
const VERBOSE = process.argv.includes('--verbose');
// Legs per body — `park` (the settle window) always runs, the others add to it: `warp` (hover at 1 h/s, 1 day/s
// and 1 yr/s — the ship must stay with the body, so the altitude holds; the
// body's bearing legitimately turns as the ship rides its orbit with an
// inertial heading), `seams` (rate changes, clock jumps, the Land prompt
// persisting, and — at Mars — no orbit-crossing toasts while riding at warp).
const SCENARIOS = new Set(arg('scenario', 'park').split(','));
const DRIFT_MAX_DEG_S = 0.02;
const ALT_MAX_KM = 1;
const OUT = `/tmp/moon-shots/${LABEL}`;
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GPU_ARGS = ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'];
const MOON_PARENT = { Moon: 'Earth', Phobos: 'Mars', Deimos: 'Mars', Io: 'Jupiter', Europa: 'Jupiter', Ganymede: 'Jupiter', Callisto: 'Jupiter', Titan: 'Saturn', Enceladus: 'Saturn', Triton: 'Neptune', Charon: 'Pluto' };

const release = await takeBrowserLock('station');
const browser = await chromium.launch({ headless: true, args: GPU_ARGS });
const rows = [];
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await context.addInitScript(() => {
    try {
      localStorage.clear(); sessionStorage.clear(); indexedDB.deleteDatabase('orbital-sim-storage');
      localStorage.setItem('planetarium-help-seen', '1'); localStorage.setItem('planetarium-surface-hint-seen', '1');
    } catch {}
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(`${URL}/?auto=planetarium${EXTRA}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__moon?.ready?.(), null, { timeout: 120_000 });
  await page.waitForFunction(() => { const s = document.getElementById('loading-screen'); return !s || s.classList.contains('hidden') || getComputedStyle(s).display === 'none'; }, null, { timeout: 120_000 });
  await sleep(2500);

  const probe = (name) => page.evaluate((n) => {
    const p = window.__moon.probe(n);
    if (!p || !p.found) return null;
    return { radii: p.distToBodyAU / p.radiusAU, altKm: (p.distToBodyAU - p.radiusAU) * 149597870.7, centreKm: p.distToBodyAU * 149597870.7,
      inFrame: p.screen?.inFrame ?? false, ndcX: p.screen?.ndcX ?? 9, ndcY: p.screen?.ndcY ?? 9, sx: p.screen?.x ?? 0, sy: p.screen?.y ?? 0,
      diameterPx: p.screen?.diameterPx ?? 0, radiusAU: p.radiusAU, distAU: p.distToBodyAU, moving: p.moving, look: p.look ?? null,
      speed: document.getElementById('planetarium-speed-value')?.textContent ?? null };
  }, name);
  const hold = async (key, ms) => { await page.keyboard.down(key); await sleep(ms); await page.keyboard.up(key); };
  const keys = { x: ['ArrowLeft', 'ArrowRight'], y: ['ArrowUp', 'ArrowDown'] };

  // Where the nose points on screen. The chase camera sits behind and above
  // the ship and looks at the ship, so the flight direction projects well
  // above the frame's centre — and not exactly where a posed body sits.
  // Measure it from motion: fly straight at Earth for a few seconds; a body
  // off the nose by a fixed angle slides across the screen as 1/distance, so
  // two samples (m0 at d0, m1 at d1) give the fixed point n = (m1·d1 − m0·d0)/(d1 − d0).
  await page.evaluate(() => window.__moon.jumpTo('Earth', 1)); await sleep(300);
  const pe = await probe('Earth');
  await page.evaluate((m) => window.__moon.jumpTo('Earth', m), 2.4 / pe.radii); await sleep(1800);
  const m0 = await probe('Earth');
  await page.keyboard.down('w'); await sleep(4500); await page.keyboard.up('w'); await sleep(300);
  const m1 = await probe('Earth');
  const NOSE = { x: (m1.ndcX * m1.radii - m0.ndcX * m0.radii) / (m1.radii - m0.radii), y: (m1.ndcY * m1.radii - m0.ndcY * m0.radii) / (m1.radii - m0.radii) };
  if (VERBOSE) console.log('[nose] mark', JSON.stringify({ x: +NOSE.x.toFixed(3), y: +NOSE.y.toFixed(3), from: [+m0.ndcX.toFixed(3), +m0.ndcY.toFixed(3), +m0.radii.toFixed(3)], to: [+m1.ndcX.toFixed(3), +m1.ndcY.toFixed(3), +m1.radii.toFixed(3)] }));
  await page.keyboard.down('s'); await sleep(6000); await page.keyboard.up('s');

  // Aim the nose at the body's centre with the real steering keys. One
  // steering nudge first: a posed camera may not sit behind the nose, and the
  // screen position the probe reports is the camera's; any flight input hands
  // the camera back to the chase pose, after which the loop reads the nose.
  const aimAt = async (body, tol, budgetMs = 70_000) => {
    let p = await probe(body);
    // A parked ship (every jump pose parks it) ignores the stick until the
    // throttle revives it: one short tap, then the brake takes the speed back.
    if (p && p.moving === false) { await hold('w', 80); await hold('s', 1200); }
    await page.keyboard.down('s'); // the brake stays on while the nose turns
    try {
    await hold('ArrowLeft', 60); await sleep(1200);
    const flip = { x: 0, y: 0 };
    const t0 = Date.now();
    while (Date.now() - t0 < budgetMs) {
      p = await probe(body);
      if (VERBOSE) console.log('[aim]', body, JSON.stringify({ inFrame: p.inFrame, ndcX: +p.ndcX.toFixed(3), ndcY: +p.ndcY.toFixed(3), radii: +p.radii.toFixed(3), diameterPx: Math.round(p.diameterPx), moving: p.moving, speed: p.speed }));
      if (!p.inFrame) {
        // Not in frame. A body BEHIND the camera projects to coordinates that
        // look in range (the projection flips through the camera), so in-range
        // but not in frame means behind: yaw a long way. Out of range means in
        // front but outside the frame: the projection still says which way.
        const behind = Math.abs(p.ndcX) < 1.3 && Math.abs(p.ndcY) < 1.3;
        if (behind) { await hold('ArrowRight', 1500); }
        else {
          await hold(keys.x[((p.ndcX - NOSE.x > 0 ? 1 : 0) ^ flip.x)], Math.min(500, 100 + Math.abs(p.ndcX) * 120));
          await hold(keys.y[((p.ndcY - NOSE.y > 0 ? 1 : 0) ^ flip.y)], Math.min(400, 100 + Math.abs(p.ndcY) * 120));
        }
        await sleep(500); continue;
      }
      if (Math.abs(p.ndcX - NOSE.x) < tol && Math.abs(p.ndcY - NOSE.y) < tol) {
        // The chase camera lags the nose after a turn; a mark that reads
        // settled right after a key pulse may still be the camera catching up.
        // Let it settle and read again before trusting it.
        await sleep(2500);
        const q = await probe(body);
        if (VERBOSE) console.log('[aim] settled?', body, JSON.stringify({ ndcX: +q.ndcX.toFixed(3), ndcY: +q.ndcY.toFixed(3) }));
        if (Math.abs(q.ndcX - NOSE.x) < tol && Math.abs(q.ndcY - NOSE.y) < tol) { p = q; break; }
        p = q; continue;
      }
      for (const axis of ['x', 'y']) {
        const e = axis === 'x' ? p.ndcX - NOSE.x : p.ndcY - NOSE.y;
        if (Math.abs(e) < tol) continue;
        await hold(keys[axis][((e > 0 ? 1 : 0) ^ flip[axis])], Math.max(16, Math.min(350, Math.abs(e) * 700))); await sleep(450);
        const q = await probe(body); const e2 = axis === 'x' ? q.ndcX - NOSE.x : q.ndcY - NOSE.y;
        if (Math.abs(e2) > Math.abs(e)) flip[axis] ^= 1;
        p = q;
      }
    }
    } finally { await page.keyboard.up('s'); }
    return p;
  };
  // Hold S until the dial reads zero and STAYS zero: the app has a cruise dial
  // and a planet-system dial, S cuts whichever is active, and a flyby leaves
  // the cruise dial at light speed — a momentary zero inside a system is the
  // system dial alone, and the cruise dial comes back as the ship drifts out.
  const killSpeed = async (body) => {
    const t0 = Date.now(); let zeroSince = null; await page.keyboard.down('s');
    try {
      while (Date.now() - t0 < 30_000) {
        const q = await probe(body);
        if (q.speed === '0 km/s') { zeroSince ??= Date.now(); if (Date.now() - zeroSince > 1500) break; } else zeroSince = null;
        await sleep(250);
      }
    } finally { await page.keyboard.up('s'); }
    await sleep(300);
  };
  // Close in stages: aim, fly until the distance drops by two thirds, stop,
  // re-aim — a one-degree aim error at a hundred radii is a two-radii miss and
  // a pass, so the nose is corrected as the body grows.
  const closeIn = async (body) => {
    let p = await probe(body);
    for (let stage = 0; stage < 12 && p.radii > 4; stage++) {
      p = await aimAt(body, 0.02);
      if (!p.inFrame) return p;
      const target = Math.max(4, p.radii / 3);
      await page.keyboard.down('w');
      try {
        // Stop the burn when the body slides off the nose mark: the aim was off
        // and flying on only turns the error into a pass.
        await page.evaluate(async ({ b, target, ms, nose }) => { const nap = (m) => new Promise((r) => setTimeout(r, m)); const t0 = performance.now(); while (performance.now() - t0 < ms) { const q = window.__moon.probe(b); if (q.distToBodyAU / q.radiusAU <= target) break; const sc = q.screen; if (sc && Math.hypot(sc.ndcX - nose.x, sc.ndcY - nose.y) > 0.12) break; await nap(200); } }, { b: body, target, ms: 20_000, nose: NOSE });
      } finally { await page.keyboard.up('w'); }
      await killSpeed(body);
      p = await probe(body);
      if (VERBOSE) console.log('[close-in] stage', stage, 'radii', p.radii.toFixed(2));
    }
    return p;
  };
  // W down to the shell until the descent stalls.
  const descend = async (body) => {
    await page.keyboard.down('w');
    try {
      return await page.evaluate(async (b) => {
        const nap = (m) => new Promise((r) => setTimeout(r, m));
        const rad = () => { const p = window.__moon.probe(b); return p.distToBodyAU / p.radiusAU; };
        const t0 = performance.now(); let last = rad(); let lastT = t0;
        while (performance.now() - t0 < 150_000) {
          await nap(250); const r = rad();
          if (performance.now() - lastT > 2000) { if (Math.abs(r - last) < 2e-5 && r < 1.6) break; last = r; lastT = performance.now(); }
        }
        return rad();
      }, body);
    } finally { await page.keyboard.up('w'); }
  };

  for (const body of BODIES) {
    const isMoon = body in MOON_PARENT;
    if (!isMoon) {
      // Planets: the postcard pose at 2.2 radii, nose already on the body.
      await page.evaluate((b) => window.__moon.jumpTo(b, 1), body); await sleep(300);
      const p0 = await probe(body);
      await page.evaluate(({ b, m }) => window.__moon.jumpTo(b, m), { b: body, m: 2.2 / p0.radii }); await sleep(1500);
    } else {
      // Moons: the app's own autopilot (the deck's Pilot verb through the dev
      // bridge). It steers with the real heading law, glides on the approach
      // law and parks at the standoff with the nose on the body — the pose a
      // pilot arrives in. The travel pipeline instead flies PAST a moon with
      // the camera looking back at it, and the dev framing hook parks the
      // camera under a free camera that skips collisions.
      // From the parent's postcard, so the autopilot flies a moon system,
      // not a cross-system cruise that outlasts the leg.
      await page.evaluate((b) => window.__moon.jumpTo(b, 1), MOON_PARENT[body]); await sleep(1500);
      const engaged = await page.evaluate((b) => window.__moon.pilotTo?.(b) ?? false, body);
      if (!engaged) { rows.push({ body, verdict: 'FAIL', why: 'no pilotTo on this build' }); console.log(`[station] FAIL ${body} no pilotTo on this build`); continue; }
      // The autopilot steers and caps but never raises the dial: a pilot
      // engages it and throttles up, and the glide law does the braking.
      await hold('w', 6000);
      const tArr = Date.now(); let arrived = false;
      while (Date.now() - tArr < 240_000) {
        const st = await probe(body);
        if (VERBOSE && st && (Date.now() - tArr) % 4000 < 300) console.log('[pilot]', body, ((Date.now() - tArr) / 1000).toFixed(0) + 's', JSON.stringify({ radii: +st.radii.toFixed(2), moving: st.moving, speed: st.speed }));
        if (st && st.moving === false && st.radii < 60) { arrived = true; break; }
        await sleep(250);
      }
      if (!arrived) { rows.push({ body, verdict: 'FAIL', why: 'autopilot never arrived' }); console.log(`[station] FAIL ${body} autopilot never arrived`); continue; }
      await sleep(1500);
    }
    await killSpeed(body);
    let p = await closeIn(body);
    p = await aimAt(body, 0.03);
    if (!p.inFrame || p.diameterPx <= 0) { rows.push({ body, verdict: 'FAIL', why: 'could not aim at the body' }); console.log(`[station] FAIL ${body} could not aim at the body`); continue; }
    const pxPerRad = p.diameterPx / (2 * Math.asin(Math.min(1, p.radiusAU / p.distAU)));
    const floor = await descend(body);
    if (VERBOSE) console.log('[descent] stalled at radii', floor.toFixed(4));
    await killSpeed(body);
    // The settle window.
    const a = await probe(body);
    writeFileSync(`${OUT}/${body}-0.png`, await page.screenshot({ type: 'png' }));
    const rowsIn = await page.evaluate(async ({ b, ms }) => {
      const nap = (m) => new Promise((r) => setTimeout(r, m)); const out = []; const t0 = performance.now();
      while (performance.now() - t0 < ms) { const p = window.__moon.probe(b); out.push({ t: (performance.now() - t0) / 1000, alt: (p.distToBodyAU - p.radiusAU) * 149597870.7, sx: p.screen?.x ?? 0, sy: p.screen?.y ?? 0 }); await nap(250); }
      return out;
    }, { b: body, ms: WINDOW_S * 1000 });
    writeFileSync(`${OUT}/${body}-1.png`, await page.screenshot({ type: 'png' }));
    const first = rowsIn[0], last = rowsIn.at(-1);
    const driftDegS = Math.hypot(last.sx - first.sx, last.sy - first.sy) / pxPerRad / (last.t - first.t) * 180 / Math.PI;
    const altSwing = Math.max(...rowsIn.map((r) => r.alt)) - Math.min(...rowsIn.map((r) => r.alt));
    const ok = driftDegS < DRIFT_MAX_DEG_S && altSwing < ALT_MAX_KM;
    rows.push({ body, verdict: ok ? 'PASS' : 'FAIL', floorRadii: floor, altKm: a.altKm, driftDegS, walkKmS: driftDegS * Math.PI / 180 * a.centreKm, altSwingKm: altSwing, speed: a.speed });
    console.log(`[station] ${ok ? 'PASS' : 'FAIL'} ${body.padEnd(8)} floor ${a.altKm.toFixed(1)} km; centre drift ${driftDegS.toFixed(3)} deg/s (~${(driftDegS * Math.PI / 180 * a.centreKm).toFixed(1)} km/s along the shell); altitude swing ${altSwing.toFixed(2)} km; readout '${a.speed}'`);

    // Altitude over a window, with the clock driven from inside the page.
    const altitudeSwing = async (ms, drive) => page.evaluate(async ({ b, ms, drive }) => {
      const nap = (m) => new Promise((r) => setTimeout(r, m));
      const alt = () => { const p = window.__moon.probe(b); return (p.distToBodyAU - p.radiusAU) * 149597870.7; };
      if (drive) new Function('moon', drive)(window.__moon);
      // A clock set moves the bodies at once and the ship on the next frame:
      // sample from the frame after, never the tick of the set itself.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      let lo = Infinity, hi = -Infinity; const t0 = performance.now();
      while (performance.now() - t0 < ms) { const v = alt(); lo = Math.min(lo, v); hi = Math.max(hi, v); await nap(100); }
      return { lo, hi, swing: hi - lo };
    }, { b: body, ms, drive });
    const leg = (tag, ok, detail) => { rows.push({ body, leg: tag, verdict: ok ? 'PASS' : 'FAIL', detail }); console.log(`[station] ${ok ? 'PASS' : 'FAIL'} ${body.padEnd(8)} ${tag}: ${detail}`); };

    if (SCENARIOS.has('warp')) {
      for (const rate of [3600, 86400, 31557600]) {
        const r = await altitudeSwing(8000, `moon.setTimeRate(${rate});`);
        await page.evaluate(() => window.__moon.setTimeRate(1)); await sleep(1000);
        leg(`warp ${rate}x`, r.swing < 5, `altitude ${r.lo.toFixed(1)}–${r.hi.toFixed(1)} km over 8 s`);
      }
    }
    if (SCENARIOS.has('seams')) {
      // Rate changes mid-hover.
      const rc = await altitudeSwing(9000, `let i = 0; const rates = [60, 3600, 1]; const id = setInterval(() => { moon.setTimeRate(rates[i++ % 3]); if (i > 9) clearInterval(id); }, 1000);`);
      await page.evaluate(() => window.__moon.setTimeRate(1)); await sleep(800);
      leg('rate changes 1/60/3600', rc.swing < 1, `altitude swing ${rc.swing.toFixed(2)} km over 9 s`);
      // Clock jumps: the ship must teleport with the body.
      const j1 = await altitudeSwing(3000, `moon.setTimeMs(moon.getTimeMs() + 30 * 86400e3);`);
      leg('clock jump +30 d', j1.swing < 1, `altitude swing ${j1.swing.toFixed(2)} km`);
      const j2 = await altitudeSwing(3000, `moon.setTimeMs(moon.getTimeMs() - 100 * 86400e3);`);
      leg('clock jump -100 d', j2.swing < 1, `altitude swing ${j2.swing.toFixed(2)} km`);
      // The Land prompt must persist through a hover.
      const seen = await page.evaluate(async ({ ms }) => {
        const nap = (m) => new Promise((r) => setTimeout(r, m)); let shown = 0, total = 0; const t0 = performance.now();
        while (performance.now() - t0 < ms) { const el = document.getElementById('planetarium-btn-land'); const on = !!el && !el.hidden && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden'; shown += on ? 1 : 0; total++; await nap(500); }
        return { shown, total, label: document.getElementById('land-body-name')?.textContent ?? null };
      }, { ms: 8000 });
      leg('land prompt persists', seen.shown === seen.total && (seen.label ?? '').includes(body), `${seen.shown}/${seen.total} samples, label '${seen.label}'`);
      // Orbit-crossing toasts while riding at warp: none.
      const toasts = await page.evaluate(async ({ ms }) => {
        const nap = (m) => new Promise((r) => setTimeout(r, m)); const el = document.getElementById('planetarium-notification');
        let last = el?.textContent ?? ''; let count = 0; window.__moon.setTimeRate(86400); const t0 = performance.now();
        while (performance.now() - t0 < ms) { const t = el?.textContent ?? ''; if (t !== last && /orbit/i.test(t)) count++; last = t; await nap(100); }
        window.__moon.setTimeRate(1); return count;
      }, { ms: 20000 });
      leg('no orbit toasts at 1 day/s', toasts === 0, `${toasts} toasts in 20 s`);
    }
  }
} finally { await browser.close(); release(); }
writeFileSync(`${OUT}/report.json`, JSON.stringify({ url: URL, extra: EXTRA, expect: EXPECT, rows }, null, 2));
const fails = rows.filter((r) => r.verdict !== 'PASS').length;
// A FAIL row proves the defect only when it MEASURED it (a drift or an
// altitude); a leg that never reached the body is an infrastructure failure
// and must fail the run whatever was expected.
const measuredFails = rows.filter((r) => r.verdict !== 'PASS' && typeof r.driftDegS === 'number').length;
const infraFails = rows.filter((r) => r.verdict !== 'PASS' && r.why).length;
const outcome = fails === 0 ? 'pass' : 'fail';
const success = EXPECT === 'fail' ? measuredFails > 0 && infraFails === 0 : fails === 0;
console.log(`[station] ${rows.length} rows, ${fails} FAIL (${measuredFails} measured, ${infraFails} infrastructure) -> ${OUT}/report.json; expected ${EXPECT}, got ${outcome}${success ? '' : ' — RUN FAILED'}`);
process.exit(success ? 0 : 1);
