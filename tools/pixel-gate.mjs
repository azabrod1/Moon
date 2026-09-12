// The pixel gate for the GPU-efficiency switches (src/app/perfSwitches.ts).
//
// Every one of those switches claims a frame got cheaper without the picture
// changing. This is the only thing that can settle such a claim: park the app
// at a frozen pose, capture it with the switch OFF, flip the switch, capture it
// again, and difference the two PNGs. Both captures come out of ONE page load —
// one GPU, one clock, one set of resident tiles, one settled exposure — because
// two captures from two runs differ for a dozen reasons the shader had no part
// in.
//
// Requirement: ZERO differing pixels. A run that reports anything else is a
// change that must not ship as written.
//
// Usage (dev server on :5680, machine browser lock taken automatically):
//   node tools/pixel-gate.mjs --keys=night-early
//   node tools/pixel-gate.mjs --keys=night-early,cloud-clear --poses=night,terminator
//   node tools/pixel-gate.mjs --keys=fused-final --report      # E7: numbers, not a verdict
//   node tools/pixel-gate.mjs --engine=webkit --keys=night-early,cloud-clear,cloud-taps,glint-gate
import { chromium, webkit } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { decodePng } from './pngDecode.mjs';
import { encodePng } from './pngEncode.mjs';
import { takeBrowserLock } from './browserLock.mjs';

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}
const flag = (name) => process.argv.includes(`--${name}`);

const url = arg('url', 'http://localhost:5174');
const engine = arg('engine', 'chromium');
const outDir = arg('out', path.join('/tmp/moon-shots', `pixel-gate-${arg('label', engine)}`));
const W = Number(arg('w', '1100'));
const H = Number(arg('h', '700'));
const keys = arg('keys', 'night-early').split(',').map((s) => s.trim()).filter(Boolean);
const reportOnly = flag('report');
// The harness's own noise floor: take BOTH captures with the switch off, so a
// difference reported here is the rig moving between two frames and not the
// change under test. Every non-zero verdict has to be read against this.
const noiseFloor = flag('noise');
// Evidence that a pose actually crosses the bloom threshold, which is the one
// property of a pose that cannot be read off its name: bloom off against bloom
// on, and how much of the frame moves between them.
const bloomCheck = flag('bloomcheck');
// Forensic: take the cloud deck off screen before the A/B, so a difference the
// deck's own shader could not have made is separated from one it did.
const hideClouds = flag('hideclouds');
// A switch whose A/B cannot happen inside one page load — a texture's format is
// decided when it is uploaded — is captured across two loads instead, the
// second with `?perfoff=<key>`. The pose, the clock and the capture pins are
// the same both times, and each capture still waits for the frame to stop
// moving before it is taken.
const reloadKey = arg('reload', '');
const keepAll = flag('keep');
// The clock the whole run is frozen at. A pose is a camera and a date; nothing
// else may move between the two halves of a comparison.
const TIME_ISO = arg('time', '2026-03-21T09:20:00Z');
// Frames let through between posing and a capture. A frame the GPU has not
// finished answering for — a glare readback still a frame behind — is a
// difference nothing in the shader made.
const SETTLE_FRAMES = Number(arg('settle', '3'));

/**
 * The poses. Each one names the thing a switch could break, and between them
 * they cover both halves of the terminator, both kinds of ground under it, the
 * two states of the cloud deck, the limb, a resident tile's edge and a frame
 * with the Sun in it.
 *
 * `hold` is extra settle for a pose whose tiles have to arrive first.
 */
const POSES = {
  // Low orbit, fully sunlit: the deck, the ground, the tiles and the air all
  // at once, which is the frame the phone is slow in.
  'day-land': { call: ['limbView', 'Earth', 1.05, 55, 0, 0.35], time: '2026-03-21T09:20:00Z', hold: 2500 },
  'day-ocean': { call: ['limbView', 'Earth', 1.05, 55, 0, 0.35], time: '2026-03-21T21:40:00Z', hold: 2500 },
  // The terminator across the frame: the one place a mip chosen off a
  // neighbour that took an early-out would show.
  terminator: { call: ['limbView', 'Earth', 1.08, 60, 88, 0.5], time: '2026-03-21T09:20:00Z', hold: 2500 },
  // The night hemisphere: city lights, the night sectors over the shell.
  night: { call: ['limbView', 'Earth', 1.12, 60, 150, 0.4], time: '2026-03-21T09:20:00Z', hold: 2500 },
  // Whole disc from a distance: clear sky and cloud both in frame, with the
  // deck's coverage running the full range across it.
  disc: { call: ['frame', 'Earth', 0.75, 0], time: '2026-03-21T09:20:00Z', hold: 2000 },
  'disc-crescent': { call: ['frame', 'Earth', 0.75, 130], time: '2026-03-21T09:20:00Z', hold: 2000 },
  // The grazing limb: the air's longest column and the most foreshortened
  // ground on screen.
  limb: { call: ['limbView', 'Earth', 1.02, 45, 20, 1], time: '2026-03-21T09:20:00Z', hold: 3000 },
  // A pose the Sun is in, for the bloom threshold crossings.
  sun: { call: ['frameSun', 0.6, 40, -0.2, 0.1], time: '2026-03-21T09:20:00Z', hold: 1500 },
  // A second surface family, with no cloud deck and no night shell over it:
  // the ground shader's own terms with the Earth-only ones switched off.
  moon: { call: ['frame', 'Moon', 0.85, 30], time: '2026-03-21T09:20:00Z', hold: 2500 },
  mars: { call: ['frame', 'Mars', 0.8, 25], time: '2026-03-21T09:20:00Z', hold: 2000 },
};

const poseNames = arg('poses', Object.keys(POSES).join(','))
  .split(',').map((s) => s.trim()).filter(Boolean);

mkdirSync(outDir, { recursive: true });

/** Differing pixels between two PNG buffers, and where the worst one is. */
function diffPngs(a, b) {
  if (Buffer.compare(a, b) === 0) return { bytes: 'identical', pixels: 0, maxAbs: 0, meanAbs: 0 };
  const da = decodePng(a);
  const db = decodePng(b);
  if (da.width !== db.width || da.height !== db.height || da.channels !== db.channels) {
    return { pixels: -1, maxAbs: 255, meanAbs: 255, note: 'size mismatch' };
  }
  const ch = da.channels;
  let pixels = 0;
  let maxAbs = 0;
  let sumAbs = 0;
  let worst = { x: 0, y: 0 };
  for (let y = 0; y < da.height; y++) {
    for (let x = 0; x < da.width; x++) {
      const i = (y * da.width + x) * ch;
      let d = 0;
      for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(da.pixels[i + c] - db.pixels[i + c]));
      if (d > 0) {
        pixels++;
        sumAbs += d;
        if (d > maxAbs) { maxAbs = d; worst = { x, y }; }
      }
    }
  }
  return {
    pixels,
    maxAbs,
    meanAbs: pixels ? sumAbs / pixels : 0,
    meanOverFrame: sumAbs / (da.width * da.height),
    worst,
    width: da.width,
    height: da.height,
  };
}

/** The worst region at 6×, so a difference can be looked at rather than
 *  believed from a count. Nearest-neighbour on purpose: a resampled crop hides
 *  a one-pixel artefact, which is the thing being looked for. */
function worstCrop(a, b, at, file) {
  const da = decodePng(a);
  const db = decodePng(b);
  const S = 6;
  const CW = 48;
  const CH = 32;
  const x0 = Math.max(0, Math.min(da.width - CW, at.x - CW / 2));
  const y0 = Math.max(0, Math.min(da.height - CH, at.y - CH / 2));
  const OW = CW * S * 2;
  const out = Buffer.alloc(OW * CH * S * 3);
  for (let y = 0; y < CH * S; y++) {
    for (let x = 0; x < OW; x++) {
      const src = x < CW * S ? da : db;
      const sx = x0 + Math.floor((x % (CW * S)) / S);
      const sy = y0 + Math.floor(y / S);
      const si = (sy * src.width + sx) * src.channels;
      const di = (y * OW + x) * 3;
      out[di] = src.pixels[si];
      out[di + 1] = src.pixels[si + 1];
      out[di + 2] = src.pixels[si + 2];
    }
  }
  writeFileSync(file, encodePng(OW, CH * S, 3, out));
}

const release = await takeBrowserLock('pixel-gate');
const launcher = engine === 'webkit' ? webkit : chromium;
const browser = await launcher.launch({
  headless: true,
  args: engine === 'webkit'
    ? undefined
    : ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});

const rows = [];
let failures = 0;
let unstablePoses = 0;
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

  const boot = async (off) => {
    const q = off ? `&perfoff=${off}` : '';
    await page.goto(`${url}/?auto=planetarium${q}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window.__moon && window.__moon.ready && window.__moon.ready()), { timeout: 90000 });
    await page.waitForFunction(() => {
      const ls = document.getElementById('loading-screen');
      return !ls || ls.classList.contains('hidden');
    }, { timeout: 90000 }).catch(() => {});
    await page.evaluate(() => {
      window.__moon.setChrome(false);
      window.__moon.setShipVisible(false);
      window.__moon.setTimeRate(0);
      window.__moon.setAutoExposure(false);
      window.__moon.pinCapture({ near: 1e-7, exposure: 1, pixelRatio: 1 });
    });
  };

  await page.goto(`${url}/?auto=planetarium`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__moon && window.__moon.ready && window.__moon.ready()), { timeout: 90000 });
  await page.waitForFunction(() => {
    const ls = document.getElementById('loading-screen');
    return !ls || ls.classList.contains('hidden');
  }, { timeout: 90000 }).catch(() => {});

  await page.evaluate(() => {
    window.__moon.setChrome(false);
    window.__moon.setShipVisible(false);
    window.__moon.setTimeRate(0);
    window.__moon.setAutoExposure(false);
    // The three things a capture depends on that move on their own.
    window.__moon.pinCapture({ near: 1e-7, exposure: 1, pixelRatio: 1 });
  });

  if (hideClouds) {
    const hidden = await page.evaluate(() => {
      let n = 0;
      window.__moon.scene().traverse((o) => {
        const m = o.material;
        if (o.isMesh && m && m.transparent === true && m.depthWrite === false && m.normalScale) {
          m.colorWrite = false;
          n++;
        }
      });
      return n;
    });
    console.log(`[gate] cloud decks hidden: ${hidden}`);
  }

  // A boot has work still to land after the loading screen goes: the
  // atmosphere tables finish baking and fade their haze in over the whole
  // disc, and the colour ladder walks a body up its rungs. Both change the
  // frame globally, and a comparison that straddles one of them reports the
  // scene settling as though a switch had done it. So the first pose is held
  // for a while before anything is captured.
  const WARM_MS = Number(arg('warm', '25000'));

  const settleFrames = async (n = 4) => {
    for (let i = 0; i < n; i++) {
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    }
  };

  const shoot = async () => {
    await settleFrames(SETTLE_FRAMES);
    return page.screenshot();
  };

  // Wait until two captures in a row are the same bytes. A rung of the colour
  // ladder that lands a second late, a tile that finishes its upload, a pass
  // whose program links on its first render after a rebuild — each is a
  // difference between two frames that no switch made.
  const settleUntilStill = async (what) => {
    let last = await shoot();
    for (let tries = 0; tries < 10; tries++) {
      const next = await shoot();
      if (Buffer.compare(last, next) === 0) return last;
      last = next;
      if (tries === 9) console.log(`[gate] ${what} never held still`);
      await page.waitForTimeout(1500);
    }
    return last;
  };

  if (reloadKey) {
    // Both halves of the A/B, pose by pose, out of two boots of the same page.
    const shots = [];
    for (const off of ['', reloadKey]) {
      await boot(off);
      const half = {};
      let warmedBoot = false;
      for (const poseName of poseNames) {
        const pose = POSES[poseName];
        if (!pose) continue;
        const [fn, ...args] = pose.call;
        await page.evaluate(([t]) => window.__moon.setTimeMs(t), [Date.parse(pose.time ?? TIME_ISO)]);
        const posed = await page.evaluate(([f, a]) => window.__moon[f](...a), [fn, args]);
        if (!posed) { console.log(`[gate] pose ${poseName} refused`); continue; }
        await page.waitForTimeout(pose.hold ?? 2000);
        await page.waitForFunction(() => {
          const st = window.__moon.sectors?.();
          return !st || st.inflight === 0;
        }, { timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(600);
        if (!warmedBoot) { warmedBoot = true; await page.waitForTimeout(WARM_MS); }
        half[poseName] = await settleUntilStill(poseName);
      }
      shots.push(half);
    }
    for (const poseName of poseNames) {
      const on = shots[0][poseName];
      const off = shots[1][poseName];
      if (!on || !off) continue;
      const d = diffPngs(off, on);
      const tag = `${reloadKey}__${poseName}`;
      const bad = d.pixels !== 0;
      if (bad || keepAll) {
        writeFileSync(path.join(outDir, `${tag}.off.png`), off);
        writeFileSync(path.join(outDir, `${tag}.on.png`), on);
        if (bad && d.worst) worstCrop(off, on, d.worst, path.join(outDir, `${tag}.worst6x.png`));
      }
      if (bad && !reportOnly) failures++;
      rows.push({ key: reloadKey, pose: poseName, diff: d });
      console.log(`[gate] ${engine} ${reloadKey} @ ${poseName}: ${d.pixels === 0 ? 'ZERO'
        : `${d.pixels} px, max ${d.maxAbs}, mean ${d.meanAbs.toFixed(2)} at ${d.worst.x},${d.worst.y}`}`);
    }
    poseNames.length = 0;
  }

  let warmed = false;
  for (const poseName of poseNames) {
    const pose = POSES[poseName];
    if (!pose) { console.log(`[gate] unknown pose ${poseName}`); continue; }
    const [fn, ...args] = pose.call;
    const iso = pose.time ?? TIME_ISO;
    await page.evaluate(([t]) => window.__moon.setTimeMs(t), [Date.parse(iso)]);
    const posed = await page.evaluate(([f, a]) => window.__moon[f](...a), [fn, args]);
    if (!posed) { console.log(`[gate] pose ${poseName} refused`); continue; }
    await page.waitForTimeout(pose.hold ?? 2000);
    // Tiles converged: nothing may land between the two halves of a comparison.
    await page.waitForFunction(() => {
      const s = window.__moon.sectors?.();
      return !s || s.inflight === 0;
    }, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(600);
    if (!warmed) { warmed = true; await page.waitForTimeout(WARM_MS); }
    await settleUntilStill(poseName);

    if (bloomCheck) {
      await page.evaluate(() => window.__moon.setBloom(false));
      const noBloom = await shoot();
      await page.evaluate(() => window.__moon.setBloom(true));
      const withBloom = await shoot();
      const d = diffPngs(noBloom, withBloom);
      console.log(`[gate] bloom @ ${poseName}: ${d.pixels} px touched, max ${d.maxAbs}`);
      rows.push({ key: 'bloom-engagement', pose: poseName, diff: d });
      continue;
    }

    for (const key of keys) {
      const armed = await page.evaluate(([k]) => window.__moon.perfArm(k, false), [key]);
      if (!armed) { console.log(`[gate] no switch named ${key}`); continue; }
      // Three captures, not two. The first pair is taken with NOTHING changed
      // between them, so the run measures its own noise at this very pose in
      // this very second — a ladder rung that arrived late, a star that
      // twinkles on the wall clock. A verdict of "the switch moved 300 pixels"
      // means nothing until that number is on the page beside it.
      const a = await settleUntilStill(`${poseName} with ${key} off`);
      const b = await shoot();
      const noise = diffPngs(a, b);
      await page.evaluate(([k, v]) => window.__moon.perfArm(k, v), [key, !noiseFloor]);
      const c = await settleUntilStill(`${poseName} with ${key} on`);
      // Put it back where the app defaults it, so one key's capture is never
      // taken with another one's state changed underneath it.
      await page.evaluate(([k]) => window.__moon.perfArm(k, true), [key]);

      const d = diffPngs(b, c);
      const tag = `${key}__${poseName}`;
      const bad = d.pixels !== 0;
      if (bad || keepAll) {
        writeFileSync(path.join(outDir, `${tag}.off.png`), b);
        writeFileSync(path.join(outDir, `${tag}.on.png`), c);
        if (bad && d.worst) worstCrop(b, c, d.worst, path.join(outDir, `${tag}.worst6x.png`));
      }
      // A pose that cannot hold still is not evidence either way: it is
      // reported and counted apart, never as a pass.
      const unstable = noise.pixels !== 0;
      if (bad && !unstable && !reportOnly) failures++;
      if (unstable) unstablePoses++;
      rows.push({ key, pose: poseName, noise, diff: d });
      const verdict = d.pixels === 0
        ? 'ZERO'
        : `${d.pixels} px, max ${d.maxAbs}, mean ${d.meanAbs.toFixed(2)} (over frame ${d.meanOverFrame.toExponential(2)}) at ${d.worst.x},${d.worst.y}`;
      const noiseNote = noise.pixels === 0 ? '' : `  [pose noise ${noise.pixels} px, max ${noise.maxAbs}]`;
      console.log(`[gate] ${engine} ${key} @ ${poseName}: ${verdict}${noiseNote}`);
    }
  }

  if (errors.length) {
    console.log(`[gate] page errors (${errors.length}):`);
    for (const e of errors.slice(0, 10)) console.log('    ', e);
  }
  await page.close();
} finally {
  await browser.close();
  release();
}

writeFileSync(path.join(outDir, 'rows.json'), JSON.stringify({ engine, url, W, H, rows }, null, 2));
console.log(`[gate] ${rows.length} comparisons, ${failures} with differing pixels, ${unstablePoses} at a pose that would not hold still -> ${outDir}`);
process.exit(failures > 0 ? 1 : 0);
