// The lens proximity ramp's moving A/B, as still frames: the original lens and
// the fade at every stop of a real approach, from one page and one pose.
//
// The fade (shared/math/lensProximity.ts, `?lensramp=1`) ships OFF until a
// recording of an approach, a departure and a look-away has been judged on a
// real GPU and a phone. This is the sheet that recording is judged against,
// and the part of it a headless box can make: the SAME approach flown once,
// every stop captured twice — the ramp switched off, which is the original
// lens exactly (an off ramp multiplies the strength by 1), then on — with the
// ramp's own readout beside each frame and two things measured off the
// pixels: the share of the frame the body fills, and the share of the bottom
// row it spans (the limb's last contact with the frame edge, which is where
// the two projections part). Stops are evenly spaced in log altitude, which is
// how the speed governor paces a real approach, so the frames play back like
// one. Exposure is pinned and the clock frozen, so nothing but the projection
// differs inside a pair.
//
// The ramp runs only in real cruise flight — a frame() pose skips it by design
// — so the ship is taken there the way a user is: Earth by a real postcard
// jump to the top of the run (sunward, nose on the centre), the Moon by a real
// Travel and 45 s of the real autopilot to swing the nose on (its cruise is
// too slow to wait out on a software renderer); from there the ship is stepped
// straight in along its line to the body (`__moon.nudge` moves the ship and
// nothing else), so the chase camera, the safety pass and the ramp run exactly
// as in flight. `--lookaround` adds two real mouse drags at the park, both
// arms, which is the look-away the lens exists for.
//
// With --assert the run fails on: a refused jump, travel or pilot; the
// ramp-off arm reading anything but full strength; the ramp-on arm off the
// law at any stop (the two knees are copied here, as approach-probe does: the
// unit test pins the module, this pins the plumbing); a run that never reached
// the band (no stop under 0.5); a stop more than 1 % off the altitude it was
// sent to; a look-around that moved the ramp; or an uncaught page error. A
// pair whose two arms hold different textures (a tile or a tier that arrived
// between the shots) is settled again and retaken, twice at most, and one
// that still differs is noted, not failed — the surface is read, not waited
// for, past a short settle.
//
// Limits: stills, not motion — how the projection change reads mid-descent is
// what the recording is for. On a software renderer the app takes the
// `limited` profile (no close-range tiles, the atmosphere tables unavailable,
// so no haze over the ground), and the cloud deck's detail term needs
// tools/cloud-magnify-probe.mjs's fix to draw magnified clouds; `--nodetail`
// takes that term out of both arms.
//
// Prereq: npm run dev -- --port 5174
//   node tools/lens-ab-capture.mjs --assert --sheet
//   node tools/lens-ab-capture.mjs --body=Moon --frames=48 --top=1500 --lookaround
//   node tools/lens-ab-capture.mjs --url=http://localhost:5173 --software --nodetail --out=planning/lens-ab-capture
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { takeBrowserLock } from './browserLock.mjs';

function arg(name, fallback) {
  const found = process.argv.find((value) => value.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
}
const baseUrl = arg('url', 'http://localhost:5174');
const BODY = arg('body', 'Earth');
const outDir = arg('out', `planning/lens-ab-capture/${BODY.toLowerCase()}`);
const assertMode = process.argv.includes('--assert');
const useGpu = !process.argv.includes('--software');
const NO_DETAIL = process.argv.includes('--nodetail');
const LOOK_AROUND = process.argv.includes('--lookaround');
const SHEET = process.argv.includes('--sheet');
const FRAME_COUNT = Number(arg('frames', BODY === 'Moon' ? '48' : '60'));
const TOP_KM = Number(arg('top', BODY === 'Moon' ? '1500' : '8000'));
// 0 takes the body's park: 198 km over Earth (the postcard's floor at k = 0.126
// on the approach-probe ladder), 78 km over the Moon (the autopilot's).
const BOTTOM_KM = Number(arg('bottom', '0')) || (BODY === 'Moon' ? 78 : 198);
const VIEWPORT_WIDTH = Number(arg('w', '1280'));
const VIEWPORT_HEIGHT = Number(arg('h', '720'));
const CLOCK = arg('time', '2026-06-14T18:40:00Z');
const PILOT_SWING_MS = Number(arg('pilot-ms', '45000'));
const KM_PER_AU = 149_597_870.7;

// --- the ramp, as shared/math/lensProximity.ts defines it ---------------------
const LENS_PROXIMITY_FULL_DEG = 45;
const LENS_PROXIMITY_OFF_DEG = 70;
function lensProximityFactor(angularRadiusDeg) {
  if (!(angularRadiusDeg > LENS_PROXIMITY_FULL_DEG)) return 1;
  if (angularRadiusDeg >= LENS_PROXIMITY_OFF_DEG) return 0;
  const t = (angularRadiusDeg - LENS_PROXIMITY_FULL_DEG) / (LENS_PROXIMITY_OFF_DEG - LENS_PROXIMITY_FULL_DEG);
  return 1 - t * t * (3 - 2 * t);
}

await mkdir(outDir, { recursive: true });
const releaseLock = await takeBrowserLock('lens-ab-capture');
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PW_CHROMIUM || undefined,
  args: useGpu
    ? ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader']
    : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const failures = [];
const notes = [];
const fail = (message) => { failures.push(message); console.log(`  FAIL  ${message}`); };
const check = (condition, message) => { if (!condition) fail(message); };
const note = (message) => { notes.push(message); console.log(`  note  ${message}`); };
const records = [];
const looks = [];
const pageErrors = [];
const diagnostics = {};
const writeRecords = () => writeFile(path.join(outDir, 'records.json'), JSON.stringify({
  baseUrl, body: BODY, viewport: [VIEWPORT_WIDTH, VIEWPORT_HEIGHT], clock: CLOCK, topKm: TOP_KM, bottomKm: BOTTOM_KM,
  frameCount: FRAME_COUNT, noDetail: NO_DETAIL, diagnostics, records, looks, notes, failures, pageErrors,
}, null, 2));

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
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.goto(`${baseUrl}/?auto=planetarium&quality=medium&lensramp=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__moon && window.__moon.ready && window.__moon.ready()), { timeout: 180000 });
  await page.waitForFunction(() => {
    const loading = document.getElementById('loading-screen');
    return !loading || loading.classList.contains('hidden');
  }, { timeout: 180000 }).catch(() => {});
  const drawn = (frames = 2) => page.evaluate((n) => window.__moon.waitForDraw(n), frames);
  const rampState = () => page.evaluate(() => window.__moon.lensRamp());
  const bodyProbe = () => page.evaluate((name) => window.__moon.probe(name), BODY);
  await page.evaluate((clock) => {
    window.__moon.setChrome(false);
    window.__moon.setShipVisible(true);
    window.__moon.setBeltVisible(false);
    window.__moon.setAutoExposure(false);
    window.__moon.setTimeMs(Date.parse(clock));
    window.__moon.setTimeRate(0);
  }, CLOCK);
  if (NO_DETAIL) {
    const armed = await page.evaluate(() => window.__moon.perfArm('cloud-probe-detail', true));
    check(armed === true, 'the cloud-probe-detail switch refused');
  }
  diagnostics.device = await page.evaluate(() => window.__moon.device());
  diagnostics.atmoState = await page.evaluate(() => window.__moon.atmoState()?.state ?? null);

  // What else could differ between two shots of a pair: the sector tiles and
  // the globe map's tier. Recorded with every shot, settled briefly after a move.
  const surfaceState = () => page.evaluate((name) => {
    const stats = window.__moon.sectors();
    const own = stats?.bodies?.[name];
    const rungs = (window.__moon.ladder()?.rungs ?? [])
      .filter((entry) => entry.key.toLowerCase().includes(name.toLowerCase()))
      .map((entry) => `${entry.key}:${entry.tier}`).sort();
    return { loading: stats?.loading ?? null, resident: own ? [...own.resident].sort() : [], tiers: rungs.join(' ') };
  }, BODY);
  async function settleSurface(limitMs) {
    const started = Date.now();
    let previous = null;
    let stableReads = 0;
    while (Date.now() - started < limitMs) {
      const now = await surfaceState();
      const key = JSON.stringify([now.resident, now.tiers]);
      stableReads = previous === key && now.loading === 0 ? stableReads + 1 : 0;
      if (stableReads >= 2) return now;
      previous = key;
      await page.waitForTimeout(400);
    }
    return surfaceState();
  }
  const surfaceKey = (state) => JSON.stringify([state.resident, state.tiers]);

  // The pixels: the body (or the ship on it) against black space — any channel
  // past 32; stars are single pixels and do not move the share.
  async function shoot(label, arm) {
    await page.evaluate((on) => window.__moon.setLensRamp(on), arm === 'ramp');
    await drawn(2);
    const surface = await surfaceState();
    const buffer = await page.screenshot({ type: 'jpeg', quality: 88 });
    const file = `${label}-${arm}.jpg`;
    await writeFile(path.join(outDir, file), buffer);
    const measured = await page.evaluate(async (base64) => {
      const image = await new Promise((resolve, reject) => {
        const candidate = new Image();
        candidate.onload = () => resolve(candidate);
        candidate.onerror = reject;
        candidate.src = `data:image/jpeg;base64,${base64}`;
      });
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(image, 0, 0);
      const { width, height } = canvas;
      const pixels = ctx.getImageData(0, 0, width, height).data;
      const lit = (index) => Math.max(pixels[index], pixels[index + 1], pixels[index + 2]) > 32;
      let litCount = 0;
      for (let index = 0; index < pixels.length; index += 4) if (lit(index)) litCount++;
      let bottomLit = 0;
      const bottomRow = (height - 1) * width * 4;
      for (let x = 0; x < width; x++) if (lit(bottomRow + x * 4)) bottomLit++;
      return { share: litCount / (width * height), bottomChord: bottomLit / width };
    }, buffer.toString('base64'));
    return { file, surface, ramp: await rampState(), ...measured };
  }

  // ---- to the top of the run ---------------------------------------------------
  const first = await bodyProbe();
  check(first?.found !== false && first?.radiusAU > 0, `probe('${BODY}') found nothing`);
  const radiusKm = first.radiusAU * KM_PER_AU;
  if (BODY === 'Moon') {
    // A paused clock holds the ship with the world, so the flight runs the
    // clock; it is frozen again once the nose is on the Moon.
    await page.evaluate(() => window.__moon.setTimeRate(1));
    check((await page.evaluate((name) => window.__moon.travelTo(name), BODY)) === true, 'travelTo refused');
    await page.waitForTimeout(500);
    await page.waitForFunction(() => {
      const veil = document.getElementById('arrival-veil');
      return !veil || !veil.classList.contains('covering');
    }, { timeout: 120000 });
    await drawn(3);
    check((await page.evaluate((name) => window.__moon.pilotTo(name), BODY)) === true, 'pilotTo refused');
    await page.waitForTimeout(PILOT_SWING_MS);
    await page.evaluate(() => window.__moon.setTimeRate(0));
    await drawn(3);
  } else {
    const kTop = (radiusKm + TOP_KM) / (8 * radiusKm);
    check((await page.evaluate((a) => window.__moon.jumpTo(a.body, a.k), { body: BODY, k: kTop })) === true, `jumpTo(${BODY}, ${kTop.toFixed(5)}) refused`);
    await page.waitForTimeout(300);
    await page.waitForFunction(() => {
      const veil = document.getElementById('arrival-veil');
      return !veil || !veil.classList.contains('covering');
    }, { timeout: 90000 });
    await drawn(3);
  }
  await page.evaluate(() => window.__moon.setShipVisible(true));
  const arrived = await bodyProbe();
  console.log(`[0] ${BODY} radius ${radiusKm.toFixed(1)} km; ${(arrived.distToBodyAU * KM_PER_AU - radiusKm).toFixed(0)} km up; device ${diagnostics.device?.profile}, tables ${diagnostics.atmoState}`);

  // ---- the stops ----------------------------------------------------------------
  console.log(`[1] ${FRAME_COUNT} stops, ${TOP_KM} → ${BOTTOM_KM} km, both arms at each`);
  const altitudes = Array.from({ length: FRAME_COUNT }, (_, index) =>
    TOP_KM * Math.pow(BOTTOM_KM / TOP_KM, index / Math.max(1, FRAME_COUNT - 1)));
  let lowestRamp = 1;
  for (const [index, altitudeKm] of altitudes.entries()) {
    const started = Date.now();
    const probe = await bodyProbe();
    const dx = probe.bodyAbs.x - probe.playerAbs.x;
    const dy = probe.bodyAbs.y - probe.playerAbs.y;
    const dz = probe.bodyAbs.z - probe.playerAbs.z;
    const distanceAU = Math.hypot(dx, dy, dz);
    const stepAU = distanceAU - (radiusKm + altitudeKm) / KM_PER_AU;
    if (Math.abs(stepAU) * KM_PER_AU > 0.001) {
      await page.evaluate((move) => window.__moon.nudge(move.x, move.y, move.z),
        { x: (dx / distanceAU) * stepAU, y: (dy / distanceAU) * stepAU, z: (dz / distanceAU) * stepAU });
    }
    await drawn(2);
    await settleSurface(20000);
    const reachedKm = (await bodyProbe()).distToBodyAU * KM_PER_AU - radiusKm;
    const label = `f${String(index).padStart(2, '0')}`;
    // A pair whose two arms hold different textures (a rung or a tile that
    // landed between the shots) is settled again and retaken, twice at most;
    // one that still differs is noted, because the surface is read, not
    // waited for.
    let lens = null;
    let ramp = null;
    let sameSurface = false;
    let retakes = 0;
    for (; retakes < 3 && !sameSurface; retakes++) {
      if (retakes > 0) await settleSurface(20000);
      lens = await shoot(label, 'lens');
      ramp = await shoot(label, 'ramp');
      sameSurface = surfaceKey(lens.surface) === surfaceKey(ramp.surface);
    }
    retakes -= 1;
    lowestRamp = Math.min(lowestRamp, ramp.ramp.applied);
    check(Math.abs(reachedKm - altitudeKm) <= altitudeKm * 0.01 + 0.5, `${label}: sent to ${altitudeKm.toFixed(1)} km, reached ${reachedKm.toFixed(1)}`);
    check(Math.abs(lens.ramp.applied - 1) < 1e-6, `${label}: the ramp-off arm read ${lens.ramp.applied.toFixed(4)}, not the original lens`);
    check(lens.ramp.devPose === false && ramp.ramp.devPose === false, `${label}: a dev pose skipped the ramp`);
    const law = lensProximityFactor(ramp.ramp.angularRadiusDeg);
    check(Math.abs(ramp.ramp.applied - law) < 1e-4, `${label}: the ramp-on arm read ${ramp.ramp.applied.toFixed(4)} against the law's ${law.toFixed(4)} at ${ramp.ramp.angularRadiusDeg.toFixed(2)}°`);
    if (!sameSurface) note(`${label}: the two arms still hold different textures after ${retakes} retake(s) (${lens.surface.tiers} | ${ramp.surface.tiers}; ${lens.surface.resident.length}/${ramp.surface.resident.length} tiles)`);
    records.push({ index, label, altitudeKm, reachedKm, lens, ramp, sameSurface, retakes, wallMs: Date.now() - started });
    console.log(`  ${label} ${reachedKm.toFixed(0).padStart(5)} km  driving ${ramp.ramp.angularRadiusDeg.toFixed(2)}°  applied ${lens.ramp.applied.toFixed(3)} | ${ramp.ramp.applied.toFixed(4)}  fills ${(lens.share * 100).toFixed(1)}% | ${(ramp.share * 100).toFixed(1)}%  bottom ${(lens.bottomChord * 100).toFixed(0)}% | ${(ramp.bottomChord * 100).toFixed(0)}%${retakes ? `  retaken ×${retakes}` : ''}  ${((Date.now() - started) / 1000).toFixed(1)}s`);
    await writeRecords();
  }
  check(lowestRamp < 0.5, `the run never reached the band: the ramp's lowest reading was ${lowestRamp.toFixed(3)}`);

  // ---- the look-away at the park -------------------------------------------------
  if (LOOK_AROUND) {
    console.log('[2] look-away at the park: real drags, both arms');
    const centreX = Math.floor(VIEWPORT_WIDTH / 2);
    const centreY = Math.floor(VIEWPORT_HEIGHT / 2);
    const parked = await rampState();
    for (const [name, dx, dy] of [['quarter', Math.round(VIEWPORT_HEIGHT / 4), 0], ['quarter-low', 0, -Math.round(VIEWPORT_HEIGHT / 12)]]) {
      await page.evaluate(() => window.__moon.setLensRamp(true));
      await drawn(2);
      await page.mouse.move(centreX, centreY);
      await page.mouse.down();
      await page.mouse.move(centreX + dx, centreY + dy, { steps: 12 });
      await page.mouse.up();
      await page.waitForTimeout(1500);
      await drawn(3);
      const lens = await shoot(`look-${name}`, 'lens');
      const ramp = await shoot(`look-${name}`, 'ramp');
      check(ramp.ramp.camOwner === 'orbit', `look ${name}: the drag did not take the camera (owner ${ramp.ramp.camOwner})`);
      check(Math.abs(ramp.ramp.applied - parked.applied) < 1e-4, `look ${name}: the look moved the ramp ${parked.applied.toFixed(4)} -> ${ramp.ramp.applied.toFixed(4)}`);
      looks.push({ look: name, lens, ramp });
      console.log(`  ${name}: owner ${ramp.ramp.camOwner}, applied ${lens.ramp.applied.toFixed(3)} | ${ramp.ramp.applied.toFixed(4)}, camera's own angle ${ramp.ramp.cameraAngularRadiusDeg.toFixed(2)}°`);
      await writeRecords();
    }
  }

  // ---- a contact sheet ------------------------------------------------------------
  if (SHEET && records.length) {
    const picks = Array.from(new Set([0, 1, 2, 3, 4, 5].map((i) => Math.round((i / 5) * (records.length - 1)))));
    const rows = [];
    for (const index of picks) {
      const record = records[index];
      const read = async (file) => (await import('node:fs/promises')).readFile(path.join(outDir, file)).then((b) => b.toString('base64'));
      rows.push({ label: `${record.reachedKm.toFixed(0)} km`, lens: await read(record.lens.file), ramp: await read(record.ramp.file),
        lensLabel: `original lens ${record.lens.ramp.applied.toFixed(2)}`, rampLabel: `fade ${record.ramp.ramp.applied.toFixed(2)}` });
    }
    const dataUrl = await page.evaluate(async (sheet) => {
      const cellWidth = 560;
      const cellHeight = Math.round(cellWidth * sheet.height / sheet.width);
      const gap = 10;
      const labelHeight = 26;
      const canvas = document.createElement('canvas');
      canvas.width = gap + 2 * (cellWidth + gap);
      canvas.height = gap + sheet.rows.length * (labelHeight + cellHeight + gap);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#101216';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const load = (src) => new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = `data:image/jpeg;base64,${src}`;
      });
      for (const [rowIndex, row] of sheet.rows.entries()) {
        const top = gap + rowIndex * (labelHeight + cellHeight + gap);
        for (const [column, key] of [[0, 'lens'], [1, 'ramp']]) {
          const left = gap + column * (cellWidth + gap);
          ctx.fillStyle = '#c9ced8';
          ctx.font = '600 15px system-ui, sans-serif';
          ctx.fillText(`${row.label}  ${row[`${key}Label`]}`, left, top + 18);
          ctx.drawImage(await load(row[key]), left, top + labelHeight, cellWidth, cellHeight);
        }
      }
      return canvas.toDataURL('image/jpeg', 0.88);
    }, { rows, width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });
    await writeFile(path.join(outDir, 'sheet.jpg'), Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log(`[3] sheet of ${rows.length} stops → ${path.join(outDir, 'sheet.jpg')}`);
  }

  check(pageErrors.length === 0, `${pageErrors.length} uncaught page error(s): ${pageErrors[0] ?? ''}`);
  await writeRecords();
} finally {
  await writeRecords().catch(() => {});
  await browser.close();
  releaseLock();
}
console.log(`\n${failures.length ? `${failures.length} failure(s)` : 'all checks passed'}${notes.length ? `, ${notes.length} note(s)` : ''} — ${outDir}`);
if (assertMode && failures.length) process.exit(1);
