// The streamed ground's cut (src/planetarium/world/groundCull.ts) at the poses
// tools/pixel-gate.mjs cannot express: each needs the app driven between the
// pose and the capture. Out of ONE page load, each scenario is captured with the
// `ground-cull` switch off and on and the two frames differenced; the bar is
// zero differing pixels, and each scenario also proves its own premise from the
// streamer's stats (the tiles it is about are resident, and something was cut).
//
//   dateline  straight down from 400 km over the equator at the date line, where
//             the sector grid's first and last columns meet (u = 0 and 1)
//   pole      straight down from 400 km over the north pole at the June solstice,
//             where every column of every level converges
//   skip      a level-1 tile released and held out (`__moon.sectorHoldOut`) over a
//             coast at 400 km, so level-2 tiles draw over level 0 with nothing
//             between
//   trim      the sector budget squeezed through the globe maps' ledger at the end
//             of a sector pass (`__moon.sectorSqueeze(mib, true)`), i.e. after the
//             frame's cut and before its draw: that very frame is read back and
//             held against the same residency with the cut off
//
// Frames are read off the canvas in an animation callback queued behind the
// app's, so a capture is exactly one drawn frame. Usage (dev server, browser
// lock taken automatically):
//   node tools/ground-cull-probe.mjs --url=http://localhost:5749 [--scenarios=dateline,pole,skip,trim]
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { decodePng } from './pngDecode.mjs';
import { takeBrowserLock } from './browserLock.mjs';

const arg = (n, d) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const url = arg('url', 'http://localhost:5174');
const outDir = arg('out', '/tmp/moon-shots/ground-cull-probe');
const scenarios = arg('scenarios', 'dateline,pole,skip,trim').split(',').filter(Boolean);
const W = 1100;
const H = 700;
const ALT = 1 + 400 / 6378;
// 50 degrees of display field from 400 km: the disc's angular diameter over it.
const FILL = (2 * Math.atan(1 / ALT) * 180) / Math.PI / 50;
const COAST = ['frame', 'Earth', 1.4419497982578364, 6.857939438629981, 1.0627155848228285, 0, -1.6303735908928756, 34.39567913386282];
mkdirSync(outDir, { recursive: true });

function diff(a, b) {
  if (a === b) return 0;
  const da = decodePng(Buffer.from(a.split(',')[1], 'base64'));
  const db = decodePng(Buffer.from(b.split(',')[1], 'base64'));
  let n = 0;
  for (let i = 0; i < da.pixels.length; i += da.channels) {
    if (da.pixels[i] !== db.pixels[i] || da.pixels[i + 1] !== db.pixels[i + 1] || da.pixels[i + 2] !== db.pixels[i + 2]) n++;
  }
  return n;
}

const release = await takeBrowserLock('ground-cull-probe');
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const results = [];
let failures = 0;
try {
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await context.addInitScript(() => {
    try {
      localStorage.clear();
      localStorage.setItem('planetarium-help-seen', '1');
      localStorage.setItem('planetarium-surface-hint-seen', '1');
    } catch { /* storage blocked */ }
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${url}/?auto=planetarium`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__moon?.ready?.(), null, { timeout: 90000 });
  await page.waitForFunction(() => { const ls = document.getElementById('loading-screen'); return !ls || ls.classList.contains('hidden'); }, null, { timeout: 90000 }).catch(() => {});
  await page.evaluate(() => {
    const m = window.__moon;
    m.setChrome(false); m.setShipVisible(false); m.setTimeRate(0); m.setAutoExposure(false);
    m.pinCapture({ near: 1e-7, exposure: 1, pixelRatio: 1 });
  });

  /** One drawn frame, read in an animation callback queued behind the app's. */
  const readFrame = () => page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => resolve(document.querySelector('canvas.scene-canvas').toDataURL('image/png')));
  }));
  const settle = async () => {
    let last = await readFrame();
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(400);
      const next = await readFrame();
      if (next === last) return next;
      last = next;
    }
    return last;
  };
  const tilesSettled = () => page.waitForFunction(() => (window.__moon.sectors?.()?.inflight ?? 0) === 0, null, { timeout: 30000 }).catch(() => {});
  const stats = () => page.evaluate(() => {
    const s = window.__moon.sectors();
    return { resident: s.bodies.Earth?.resident ?? [], cut: s.groundCut };
  });
  const setCut = (on) => page.evaluate((v) => window.__moon.perfArm('ground-cull', v), on);
  const pose = async (time, call) => {
    await page.evaluate((t) => window.__moon.setTimeMs(t), Date.parse(time));
    await page.evaluate(() => window.__moon.waitForDraw(2));
    await page.evaluate((c) => window.__moon[c[0]](...c.slice(1)), call);
  };
  /** frame() arguments that put the camera `ALT` radii straight over Earth's
   *  surface point (u, v) of its map — solved in the page from the globe's own
   *  transform and the Sun, at the clock as it stands. */
  const nadirCall = (u, v) => page.evaluate(([u, v, alt, fill]) => {
    let earth = null;
    let sun = null;
    window.__moon.scene().traverse((o) => {
      if (o.name === 'Earth surface') earth = o;
      if (o.name === 'Sun' && !sun) sun = o;
    });
    earth.updateWorldMatrix(true, false);
    sun.updateWorldMatrix(true, false);
    const e = earth.matrixWorld.elements;
    const norm = (a) => { const l = Math.hypot(...a); return a.map((x) => x / l); };
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const phi = 2 * Math.PI * u;
    const th = Math.PI * v;
    const L = [-Math.cos(phi) * Math.sin(th), Math.cos(th), Math.sin(phi) * Math.sin(th)];
    const P = norm([e[0] * L[0] + e[4] * L[1] + e[8] * L[2], e[1] * L[0] + e[5] * L[1] + e[9] * L[2], e[2] * L[0] + e[6] * L[1] + e[10] * L[2]]);
    const s = sun.matrixWorld.elements;
    const S = norm([s[12] - e[12], s[13] - e[13], s[14] - e[14]]);
    const phase = Math.acos(Math.max(-1, Math.min(1, dot(P, S))));
    const k = norm(cross([0, 1, 0], S));
    const kv = cross(k, S);
    const d0 = S.map((x, i) => x * Math.cos(phase) + kv[i] * Math.sin(phase) + k[i] * dot(k, S) * (1 - Math.cos(phase)));
    const p0 = d0.map((x, i) => x - S[i] * dot(S, d0));
    const p1 = P.map((x, i) => x - S[i] * dot(S, P));
    const roll = Math.atan2(dot(S, cross(p0, p1)), dot(p0, p1));
    return ['frame', 'Earth', fill, (phase * 180) / Math.PI, alt, 0, 0, (roll * 180) / Math.PI];
  }, [u, v, ALT, FILL]);

  /** Off, then on, at whatever the page holds now. */
  const ab = async (name, premise) => {
    await setCut(false);
    const off = await settle();
    await setCut(true);
    const on = await settle();
    const st = await stats();
    const d = diff(off, on);
    const ok = d === 0 && premise.ok && st.cut.cut > 0 && st.cut.unbacked === 0;
    if (!ok) failures++;
    if (d !== 0) {
      writeFileSync(path.join(outDir, `${name}.off.png`), Buffer.from(off.split(',')[1], 'base64'));
      writeFileSync(path.join(outDir, `${name}.on.png`), Buffer.from(on.split(',')[1], 'base64'));
    }
    const drawnPct = ((100 * st.cut.drawnEntries) / Math.max(1, st.cut.fullEntries)).toFixed(1);
    console.log(`[cull] ${name}: ${d === 0 ? 'ZERO' : `${d} px differ`}; ${premise.note}; cut ${st.cut.cut}/${st.cut.meshes} meshes, ${drawnPct}% of their lists drawn, unbacked ${st.cut.unbacked}${ok ? '' : '  <-- FAIL'}`);
    results.push({ scenario: name, differing: d, premise, cut: st.cut });
  };
  const byLevel = (ids) => {
    const out = [[], [], []];
    for (const id of ids) {
      if (id.startsWith('night/')) continue;
      const m = /^(?:L(\d)\/)?(\d+)_(\d+)$/.exec(id);
      if (m) out[Number(m[1] ?? 0)].push({ c: +m[2], r: +m[3] });
    }
    return out;
  };

  let warmed = false;
  const hold = async (ms) => {
    await page.waitForTimeout(ms);
    await tilesSettled();
    if (!warmed) { warmed = true; await page.waitForTimeout(15000); await tilesSettled(); }
  };

  for (const sc of scenarios) {
    if (sc === 'dateline' || sc === 'pole') {
      const time = sc === 'dateline' ? '2026-03-21T00:00:00Z' : '2026-06-21T12:00:00Z';
      await page.evaluate((t) => window.__moon.setTimeMs(t), Date.parse(time));
      await page.evaluate(() => window.__moon.waitForDraw(2));
      const call = await nadirCall(0, sc === 'dateline' ? 0.5 : 0);
      await page.evaluate((c) => window.__moon[c[0]](...c.slice(1)), call);
      await hold(5000);
      const levels = byLevel((await stats()).resident);
      let note;
      let ok;
      if (sc === 'dateline') {
        const sides = levels.map((l, k) => {
          const last = (8 << k) - 1;
          return [l.filter((s) => s.c === 0).length, l.filter((s) => s.c === last).length];
        });
        ok = sides.some(([w, e]) => w > 0 && e > 0);
        note = `tiles each side of the seam by level ${sides.map(([w, e]) => `${w}|${e}`).join(' ')}`;
      } else {
        const polar = levels.map((l) => l.filter((s) => s.r === 0).length);
        ok = polar.some((n) => n > 1);
        note = `pole-row tiles by level ${polar.join(' ')}`;
      }
      await ab(sc, { ok, note });
    } else if (sc === 'skip') {
      await pose('2025-12-11T04:34:00Z', COAST);
      await hold(5000);
      const held = await page.evaluate(() => window.__moon.sectorHoldOut('skip'));
      await hold(2500);
      const levels = byLevel((await stats()).resident);
      const has = (k, c, r) => levels[k].some((s) => s.c === c && s.r === r);
      const orphans = levels[2].filter((s) => !has(1, s.c >> 1, s.r >> 1) && has(0, s.c >> 2, s.r >> 2)).length;
      await ab('skip', { ok: held !== null && orphans > 0, note: `held out ${held}, level-2 tiles over level 0 with no level 1: ${orphans}` });
      await page.evaluate(() => window.__moon.sectorHoldOut(null));
    } else if (sc === 'trim') {
      await pose('2025-12-11T04:34:00Z', COAST);
      await hold(5000);
      await settle();
      const before = await page.evaluate(() => window.__moon.sectors());
      // Enough that what the envelope leaves over the globe maps is half of
      // what the tiles hold (the budget is that, under the ceiling and over the
      // floor), so about half of them go in that one call.
      const squeezeMiB = Math.ceil((before.envelope - before.ladderBytes - before.budgetedBytes / 2) / (1024 * 1024));
      // Armed for the end of the next sector pass, then the very frame drawn
      // after it is read back with the cut readout beside it.
      const hazard = await page.evaluate((mib) => new Promise((resolve) => {
        window.__moon.sectorSqueeze(mib, true);
        requestAnimationFrame(() => {
          const s = window.__moon.sectors();
          resolve({
            frame: document.querySelector('canvas.scene-canvas').toDataURL('image/png'),
            resident: s.bodies.Earth?.resident ?? [],
            cut: s.groundCut,
          });
        });
      }), squeezeMiB);
      // The same residency drawn whole: the squeeze holds, nothing comes back.
      await setCut(false);
      const whole = await settle();
      const afterIds = (await stats()).resident;
      const same = afterIds.slice().sort().join() === hazard.resident.slice().sort().join();
      const d = diff(hazard.frame, whole);
      const released = before.bodies.Earth.resident.length - hazard.resident.length;
      const ok = d === 0 && same && released > 0 && hazard.cut.unbacked === 0;
      if (!ok) failures++;
      if (d !== 0) {
        writeFileSync(path.join(outDir, 'trim.hazard.png'), Buffer.from(hazard.frame.split(',')[1], 'base64'));
        writeFileSync(path.join(outDir, 'trim.whole.png'), Buffer.from(whole.split(',')[1], 'base64'));
      }
      console.log(`[cull] trim (the frame drawn right after the squeeze): ${d === 0 ? 'ZERO' : `${d} px differ`} against the same residency drawn whole; released ${released} of ${before.bodies.Earth.resident.length}, residency held ${same}; in that frame cut ${hazard.cut.cut}/${hazard.cut.meshes} meshes, unbacked ${hazard.cut.unbacked}${ok ? '' : '  <-- FAIL'}`);
      results.push({ scenario: 'trim-hazard', differing: d, released, same, cut: hazard.cut });
      await setCut(true);
      await ab('trim (settled under the squeeze)', { ok: true, note: `squeezed ${squeezeMiB} MiB` });
      await page.evaluate(() => window.__moon.sectorSqueeze(0));
    }
  }
  if (errors.length) console.log(`[cull] page errors: ${errors.slice(0, 5).join(' | ')}`);
  writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ url, results, errors }, null, 1));
} finally {
  await browser.close();
  release();
}
console.log(`[cull] ${results.length} captures, ${failures} failed -> ${outDir}`);
process.exit(failures ? 1 : 0);
