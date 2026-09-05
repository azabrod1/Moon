// The visual sweep: what a tree LOOKS like, measured, before anyone is asked
// to look at it.
//
// The frame-time gate says whether a tree stutters; the atmosphere goldens
// pin one shader at twelve poses. Nothing looked at the surfaces themselves,
// and the bugs that reached the pilot were all of that kind: a sea glint that
// went negative under cloud and bloomed as a yellow core in a blue ring, a
// crater field that changed with the viewing angle, a patch on a map. This
// tool renders the bodies on the real GPU through the dev bridge and asks
// three questions a still sheet viewed at full-frame scale cannot answer.
//
//   stills   Every body at three close poses. Per frame, inside the body's
//            disc: pixels clipped to a saturated colour (a channel at white
//            with another near black — bloom over a negative or an infinity),
//            black holes in lit ground (a NaN), and bright saturated islands
//            whose hue disagrees with their surround (the glint signature).
//            The frame is captured twice, half a second apart, and has to
//            agree with itself: a frame still changing is a fade or a load
//            that had no business being in a capture. With --ref, the same
//            poses on a second tree: every 32-px tile is scored, and the
//            tiles that moved most are written out at 6x, candidate over
//            reference over amplified difference — a forced look at the
//            places that changed, at a scale where a ten-pixel artefact is
//            a thing and not a highlight.
//   tilt     The same patch of ground from six viewing angles. The camera
//            stands at a phase angle p from the sun line, so the sub-solar
//            ground — lit from straight above at every p, and airless ground
//            lit from above looks the same from every direction — sits p
//            degrees off the disc centre. Each tilted view of it is compared
//            with the face-on view re-projected through the sphere onto the
//            tilted camera, exactly: ground that is attached to the body
//            correlates with its own re-projection out to grazing angles;
//            detail that is attached to the VIEW does not. Run with and
//            without the close-range term (?synth=0), the term's own effect
//            on the correlation is the number. Shot on a tall frame, so the
//            tracked ground stays in view out to grazing angles at the
//            magnification a pilot flies at.
//   zoom     One fill doubling in 24 steps at the disc centre; consecutive
//            frames scored by high-pass correlation after registration.
//            Ground that magnifies scores near one; a scale rung that re-lays
//            its field scores a dip.
//
//   node tools/visual-sweep.mjs --url=http://localhost:5666 --ref=http://localhost:5668 \
//        --label=hdzoom --scenarios=stills,tilt,zoom
//   node tools/visual-sweep.mjs --url=... --scenarios=tilt --bodies=Amalthea,Titania
//   node tools/visual-sweep.mjs --inspect=/tmp/moon-shots/x/Earth.png   # invariants on one PNG
//
// Writes frames, sheets and report.json under --out (default
// /tmp/moon-shots/sweep-<label>), prints one row per check and exits 1 if any
// row FAILs. Renders on the GPU (ANGLE/Metal), one browser at a time, under
// the machine-wide browser lock. The clock is pinned: a body's rotation and
// terminator are in every frame, and two runs at wall-clock time compare
// nothing.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { decodePng } from './pngDecode.mjs';
import { encodePng } from './pngEncode.mjs';
import { takeBrowserLock } from './browserLock.mjs';

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}
const flag = (name) => process.argv.includes(`--${name}`);

const URL_BASE = arg('url', 'http://localhost:5174');
const REF_BASE = arg('ref', '');
const label = arg('label', 'sweep');
const OUT = arg('out', path.join('/tmp/moon-shots', `sweep-${label}`));
const SCENARIOS = arg('scenarios', 'stills,tilt').split(',').map((s) => s.trim()).filter(Boolean);
const W = Number(arg('w', '1400'));
const H = Number(arg('h', '900'));
const TIME_MS = Date.parse(arg('time', '2026-09-02T18:35:00Z'));
/** devFrameBody's camera distance, in rendered radii. The tilt re-projection
 *  is built on it, so it is passed explicitly rather than left to a default. */
const DIST_MUL = 5;

// Every body with a surface the close-range work touches: the planets with a
// map, the photo-mapped moons, and the procedural ones a pilot can fly to.
const STILL_BODIES = (arg('bodies', '') || [
  'Mercury', 'Venus', 'Earth', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto',
  'Moon', 'Phobos', 'Deimos', 'Io', 'Europa', 'Ganymede', 'Callisto', 'Amalthea',
  'Mimas', 'Enceladus', 'Tethys', 'Dione', 'Rhea', 'Titan', 'Hyperion', 'Iapetus', 'Phoebe',
  'Miranda', 'Ariel', 'Umbriel', 'Titania', 'Oberon', 'Puck', 'Triton', 'Charon',
].join(',')).split(',').map((s) => s.trim()).filter(Boolean);
// Three close poses: whole disc under a side light, the disc past the frame
// under a low sun, and the glancing pose that put the mosaic seams in front
// of the pilot.
const STILL_POSES = [
  { fill: 1.0, phase: 40 },
  { fill: 2.5, phase: 30 },
  { fill: 1.2, phase: 70 },
];
const TILT_BODIES = (arg('bodies', '') || 'Amalthea,Titania,Oberon,Hyperion,Callisto,Moon,Mercury')
  .split(',').map((s) => s.trim()).filter(Boolean);
const TILT_PHASES = (arg('tilt-phases', '0,20,35,50,60,70')).split(',').map(Number);
// The tilt frames are tall, so the tracked ground stays in frame out to
// grazing angles at the magnification a pilot flies at: a disc 0.96 of a
// 2400-px frame is the same pixels-per-ground as 2.5 of a 900-px one.
const TILT_H = Number(arg('tilt-h', '2400'));
const TILT_FILLS = (arg('tilt-fills', '0.375,0.96')).split(',').map(Number);
const ZOOM_BODIES = (arg('bodies', '') || 'Amalthea,Titania,Callisto,Moon')
  .split(',').map((s) => s.trim()).filter(Boolean);

const GPU_ARGS = ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
function row(scenario, body, pose, check, value, verdict, note = '') {
  rows.push({ scenario, body, pose, check, value, verdict, note });
  const v = typeof value === 'number' ? value.toFixed(3) : String(value);
  console.log(`[sweep] ${verdict.padEnd(4)} ${scenario.padEnd(6)} ${body.padEnd(9)} ${pose.padEnd(12)} ${check.padEnd(18)} ${v}${note ? `  ${note}` : ''}`);
}

// ---------------------------------------------------------------- pixels

/** Luminance as floats, row-major. */
function gray(img) {
  const { width, height, channels, pixels } = img;
  const g = new Float32Array(width * height);
  for (let i = 0, k = 0; i < g.length; i++, k += channels) {
    g[i] = 0.299 * pixels[k] + 0.587 * pixels[k + 1] + 0.114 * pixels[k + 2];
  }
  return g;
}

/** Box blur of radius r, separable, edges clamped. */
function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const rowOff = y * w;
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += src[rowOff + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[rowOff + x] = sum / n;
      sum += src[rowOff + Math.min(w - 1, x + r + 1)] - src[rowOff + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / n;
      sum += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/** Detail above a few pixels: the frame minus two box blurs of radius r. */
function highpass(g, w, h, r) {
  const b = boxBlur(boxBlur(g, w, h, r), w, h, r);
  const out = new Float32Array(g.length);
  for (let i = 0; i < g.length; i++) out[i] = g[i] - b[i];
  return out;
}

function sampleBilinear(g, w, h, x, y) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) return 0;
  const fx = x - x0;
  const fy = y - y0;
  const i = y0 * w + x0;
  return (g[i] * (1 - fx) + g[i + 1] * fx) * (1 - fy) + (g[i + w] * (1 - fx) + g[i + w + 1] * fx) * fy;
}

/** Root mean square of an array about its mean. */
function rms(a) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  const m = s / a.length;
  let q = 0;
  for (let i = 0; i < a.length; i++) q += (a[i] - m) * (a[i] - m);
  return Math.sqrt(q / a.length);
}

/** Normalised cross-correlation of two equal-length arrays. */
function ncc(a, b) {
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < a.length; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / a.length;
  const mb = sb / b.length;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  for (let i = 0; i < a.length; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    saa += da * da; sbb += db * db; sab += da * db;
  }
  return sab / Math.sqrt(Math.max(1e-9, saa * sbb));
}

/** A size x size window of g centred on (cx, cy), integer offsets, clamped. */
function windowAt(g, w, h, cx, cy, size) {
  const out = new Float32Array(size * size);
  const x0 = Math.round(cx - size / 2);
  const y0 = Math.round(cy - size / 2);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = Math.min(w - 1, Math.max(0, x0 + x));
      const sy = Math.min(h - 1, Math.max(0, y0 + y));
      out[y * size + x] = g[sy * w + sx];
    }
  }
  return out;
}

/** The best correlation of `ref` against windows of g around (cx, cy), the
 *  ground drifting a few pixels between poses: coarse steps then fine. */
function bestMatch(ref, g, w, h, cx, cy, size, range) {
  let best = { corr: -2, sx: 0, sy: 0 };
  for (let sy = -range; sy <= range; sy += 2) {
    for (let sx = -range; sx <= range; sx += 2) {
      const c = ncc(ref, windowAt(g, w, h, cx + sx, cy + sy, size));
      if (c > best.corr) best = { corr: c, sx, sy };
    }
  }
  const coarse = best;
  for (let sy = coarse.sy - 1; sy <= coarse.sy + 1; sy++) {
    for (let sx = coarse.sx - 1; sx <= coarse.sx + 1; sx++) {
      const c = ncc(ref, windowAt(g, w, h, cx + sx, cy + sy, size));
      if (c > best.corr) best = { corr: c, sx, sy };
    }
  }
  return best;
}

/** Mean absolute difference between two same-size frames, every 4th pixel. */
function meanAbsDiff(a, b) {
  const n = Math.min(a.pixels.length, b.pixels.length);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < n; i += 4 * a.channels) {
    sum += Math.abs(a.pixels[i] - b.pixels[i]) + Math.abs(a.pixels[i + 1] - b.pixels[i + 1]) + Math.abs(a.pixels[i + 2] - b.pixels[i + 2]);
    count += 3;
  }
  return sum / Math.max(1, count);
}

/** A sheet: RGB canvas the crops are blitted onto, nearest-neighbour. */
class Sheet {
  constructor(w, h) {
    this.w = w; this.h = h;
    this.px = new Uint8Array(w * h * 3).fill(28);
  }
  blitRgb(img, sx0, sy0, sw, sh, dx, dy, scale, amplify = null) {
    for (let y = 0; y < sh * scale; y++) {
      for (let x = 0; x < sw * scale; x++) {
        const sx = Math.min(img.width - 1, Math.max(0, sx0 + Math.floor(x / scale)));
        const sy = Math.min(img.height - 1, Math.max(0, sy0 + Math.floor(y / scale)));
        const si = (sy * img.width + sx) * img.channels;
        const tx = dx + x;
        const ty = dy + y;
        if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) continue;
        const di = (ty * this.w + tx) * 3;
        if (amplify) {
          const o = (sy * amplify.width + sx) * amplify.channels;
          for (let c = 0; c < 3; c++) this.px[di + c] = Math.min(255, Math.max(0, 128 + 4 * (img.pixels[si + c] - amplify.pixels[o + c])));
        } else {
          this.px[di] = img.pixels[si]; this.px[di + 1] = img.pixels[si + 1]; this.px[di + 2] = img.pixels[si + 2];
        }
      }
    }
  }
  blitGray(g, gw, gh, dx, dy, scale, gain = 1, offset = 0) {
    for (let y = 0; y < gh * scale; y++) {
      for (let x = 0; x < gw * scale; x++) {
        const v = Math.min(255, Math.max(0, offset + gain * g[Math.floor(y / scale) * gw + Math.floor(x / scale)]));
        const tx = dx + x;
        const ty = dy + y;
        if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) continue;
        const di = (ty * this.w + tx) * 3;
        this.px[di] = v; this.px[di + 1] = v; this.px[di + 2] = v;
      }
    }
  }
  save(file) { writeFileSync(file, encodePng(this.w, this.h, 3, this.px)); }
}

// ------------------------------------------------------------ invariants

/** The disc to inspect, from the probe's on-screen circle, shrunk a little so
 *  the anti-aliased limb and the sky stay out of it. A body past the frame
 *  is the whole frame less a margin. */
function discOf(probe, w, h) {
  const s = probe?.screen;
  if (!s || !(s.diameterPx > 0)) return { cx: w / 2, cy: h / 2, r: Math.min(w, h) / 2 - 4, whole: true };
  const r = s.diameterPx / 2;
  if (r > Math.hypot(w, h)) return { cx: s.x, cy: s.y, r, whole: true };
  return { cx: s.x, cy: s.y, r: r * 0.97, whole: false };
}

/** The pixel classes a healthy frame has none of, counted inside the disc. */
function inspect(img, disc) {
  const { width: w, height: h, channels, pixels } = img;
  const g = gray(img);
  const near = boxBlur(g, w, h, 2);
  // The surround's colour, for the hue test: a box wide enough that a
  // ten-pixel island is a minority of it.
  const R = 12;
  const chan = [0, 1, 2].map((c) => {
    const a = new Float32Array(w * h);
    for (let i = 0, k = c; i < a.length; i++, k += channels) a[i] = pixels[k];
    return boxBlur(a, w, h, R);
  });
  const out = { clipped: 0, holes: 0, islands: 0, examples: { clipped: [], holes: [], islands: [] } };
  const x0 = Math.max(2, Math.floor(disc.cx - disc.r));
  const x1 = Math.min(w - 3, Math.ceil(disc.cx + disc.r));
  const y0 = Math.max(2, Math.floor(disc.cy - disc.r));
  const y1 = Math.min(h - 3, Math.ceil(disc.cy + disc.r));
  const r2 = disc.r * disc.r;
  const cos30 = Math.cos(30 * Math.PI / 180);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - disc.cx;
      const dy = y - disc.cy;
      if (!disc.whole && dx * dx + dy * dy > r2) continue;
      const i = y * w + x;
      const k = i * channels;
      const r = pixels[k];
      const gg = pixels[k + 1];
      const b = pixels[k + 2];
      const v = Math.max(r, gg, b);
      const m = Math.min(r, gg, b);
      if (v >= 230 && m <= 0.35 * v) {
        out.clipped++;
        if (out.examples.clipped.length < 3) out.examples.clipped.push({ x, y, rgb: [r, gg, b] });
      }
      // A hole has lit ground on every side of it three pixels out; a star
      // with its bloom is bright on one side only, and the sky is not ground.
      if (v < 4 && near[i] > 50 && x >= 3 && y >= 3 && x < w - 3 && y < h - 3
          && g[i - 3] > 20 && g[i + 3] > 20 && g[i - 3 * w] > 20 && g[i + 3 * w] > 20) {
        out.holes++;
        if (out.examples.holes.length < 3) out.examples.holes.push({ x, y, rgb: [r, gg, b] });
      }
      if (v >= 190 && (v - m) / v >= 0.45) {
        const sr = chan[0][i];
        const sg = chan[1][i];
        const sb = chan[2][i];
        const dot = r * sr + gg * sg + b * sb;
        const cos = dot / Math.max(1e-6, Math.hypot(r, gg, b) * Math.hypot(sr, sg, sb));
        if (cos < cos30) {
          out.islands++;
          if (out.examples.islands.length < 3) out.examples.islands.push({ x, y, rgb: [r, gg, b], surround: [sr, sg, sb].map((q) => Math.round(q)) });
        }
      }
    }
  }
  return out;
}

/** Per 32-px tile, how far two frames are apart; sorted worst first. */
function tileDiff(a, b, T = 32) {
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  const tiles = [];
  for (let ty = 0; ty + T <= h; ty += T) {
    for (let tx = 0; tx + T <= w; tx += T) {
      let sum = 0;
      let max = 0;
      for (let y = ty; y < ty + T; y++) {
        for (let x = tx; x < tx + T; x++) {
          const ia = (y * a.width + x) * a.channels;
          const ib = (y * b.width + x) * b.channels;
          for (let c = 0; c < 3; c++) {
            const d = Math.abs(a.pixels[ia + c] - b.pixels[ib + c]);
            sum += d;
            if (d > max) max = d;
          }
        }
      }
      tiles.push({ x: tx, y: ty, mean: sum / (T * T * 3), max });
    }
  }
  tiles.sort((p, q) => q.mean - p.mean);
  return tiles;
}

/** The forced look: the five tiles that moved most, 64 px around each at 6x —
 *  candidate, reference, amplified difference. */
function diffSheet(cand, ref, tiles, file) {
  const CROP = 64;
  const SCALE = 6;
  const GAP = 8;
  const n = Math.min(5, tiles.length);
  if (n === 0) return;
  const sheet = new Sheet(n * (CROP * SCALE + GAP) + GAP, 3 * (CROP * SCALE + GAP) + GAP);
  for (let i = 0; i < n; i++) {
    const t = tiles[i];
    const sx0 = Math.min(cand.width - CROP, Math.max(0, t.x + 16 - CROP / 2));
    const sy0 = Math.min(cand.height - CROP, Math.max(0, t.y + 16 - CROP / 2));
    const dx = GAP + i * (CROP * SCALE + GAP);
    sheet.blitRgb(cand, sx0, sy0, CROP, CROP, dx, GAP, SCALE);
    sheet.blitRgb(ref, sx0, sy0, CROP, CROP, dx, GAP + (CROP * SCALE + GAP), SCALE);
    sheet.blitRgb(cand, sx0, sy0, CROP, CROP, dx, GAP + 2 * (CROP * SCALE + GAP), SCALE, ref);
  }
  sheet.save(file);
}

// --------------------------------------------------------------- browser

async function openPage(browser, { query = '', phone = false, height = H } = {}) {
  const context = await browser.newContext(phone
    ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }
    : { viewport: { width: W, height }, deviceScaleFactor: 1 });
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

async function boot(page, base, query) {
  await page.goto(`${base}/?auto=planetarium${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__moon && window.__moon.ready && window.__moon.ready()), { timeout: 60000 });
  await page.waitForFunction(() => {
    const ls = document.getElementById('loading-screen');
    return !ls || ls.classList.contains('hidden');
  }, { timeout: 60000 }).catch(() => {});
  await setUp(page);
  await page.waitForTimeout(1500);
}

/** The session's own setup: chrome off, the clock pinned and stopped, and a
 *  stamp on the page that says this setup is in force. */
async function setUp(page) {
  await page.evaluate((t) => {
    window.__moon.setChrome(false);
    window.__moon.setTimeMs(t);
    window.__moon.setTimeRate(0);
    window.__sweepStamp = t;
  }, TIME_MS);
}

/** A dev server pushes a full reload when a file it watches changes, and a
 *  reloaded page comes back with its chrome on and its clock running — every
 *  capture after that is of the wrong scene. The stamp is gone with the
 *  page, so its absence is the reload; the run is marked and set up again. */
async function guardSession(page, scenario, body) {
  const stamped = await page.evaluate(() => window.__sweepStamp === undefined ? false : true).catch(() => false);
  if (stamped) return;
  await page.waitForFunction(() => !!(window.__moon && window.__moon.ready && window.__moon.ready()), { timeout: 60000 });
  await setUp(page);
  await page.waitForTimeout(1500);
  row(scenario, body, '*', 'reloaded', 'page', 'FAIL', 'the page reloaded mid-run (a watched file changed?); setup re-applied, but the frames before this row on this body may be of the wrong scene');
}

const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))));

/** Pose the camera on a body and wait for everything the pose starts —
 *  streamed sectors, ladder upgrades, the relief envelope's ease-in — to
 *  finish. Returns the probe, or null when the bridge refuses the body. */
async function pose(page, body, fill, phase, offNdcX = 0, offNdcY = 0) {
  await guardSession(page, 'pose', body);
  const ok = await page.evaluate(([n, f, p, d, ox, oy]) => window.__moon.frame(n, f, p, d, ox, oy), [body, fill, phase, DIST_MUL, offNdcX, offNdcY]);
  if (!ok) return null;
  const t0 = Date.now();
  let probe = null;
  let atmoSeen = null;
  let settleUntil = 0;
  for (;;) {
    await page.waitForTimeout(500);
    const state = await page.evaluate((n) => {
      const s = window.__moon.sectors?.();
      const l = window.__moon.ladder?.();
      let atmo = null;
      try { atmo = window.__moon.atmoState?.()?.state ?? null; } catch { atmo = null; }
      return {
        busy: (s ? s.loading + s.inflight : 0) + (l ? l.restoreQueued + (l.releasing ? 1 : 0) : 0),
        atmo,
        probe: window.__moon.probe(n),
      };
    }, body);
    probe = state.probe;
    // A moon is drawn only once its painter has finished it; until then the
    // frame shows whatever stands behind it.
    const shown = probe?.shown !== false;
    // A body with air wears the analytic shell until its tables are baked,
    // then fades to them over a second: a capture before that is of the
    // stand-in. The baker's state is global, so a pose with no air to bake
    // sees the last body's 'ready'; the first pose of a session may find it
    // not yet started, which is waited on for a while and then let go.
    const baking = state.atmo === 'baking' || (state.atmo === 'unavailable' && Date.now() - t0 < 15000);
    if (!baking && state.atmo !== atmoSeen) { atmoSeen = state.atmo; settleUntil = Date.now() + 2000; }
    if (shown && state.busy === 0 && !baking && Date.now() > settleUntil && Date.now() - t0 > 1200) break;
    if (Date.now() - t0 > 30000) { if (!shown) row('pose', body, `f${fill} p${phase}`, 'shown', 'never', 'FAIL', 'body not drawn after 30 s'); break; }
  }
  await settle(page);
  return probe;
}

async function capture(page) {
  return decodePng(await page.screenshot({ type: 'png' }));
}

/** Two captures half a second apart that agree, or the last pair and how far
 *  apart they still were. */
async function steadyCapture(page) {
  let a = await capture(page);
  let diff = Infinity;
  let prev = a;
  for (let tries = 0; tries < 3; tries++) {
    await page.waitForTimeout(500);
    await settle(page);
    const b = await capture(page);
    diff = meanAbsDiff(a, b);
    prev = a;
    a = b;
    if (diff < 0.35) break;
    await page.waitForTimeout(1500);
  }
  // The pair an unsteady frame was judged on, for the diagnosis: what moved
  // between two captures half a second apart is the whole question.
  return { img: a, diff, prev: diff >= 0.35 ? prev : null };
}

// -------------------------------------------------------------- scenarios

async function stillsOn(browser, base, tag) {
  const dir = path.join(OUT, `stills-${tag}`);
  mkdirSync(dir, { recursive: true });
  const { context, page, errors } = await openPage(browser);
  const frames = new Map();
  try {
    await boot(page, base, '');
    for (const body of STILL_BODIES) {
      for (const p of STILL_POSES) {
        const key = `${body} f${p.fill} p${p.phase}`;
        const probe = await pose(page, body, p.fill, p.phase);
        if (!probe) { row('stills', body, `f${p.fill} p${p.phase}`, 'pose', 'refused', 'SKIP', tag); continue; }
        const { img, diff, prev } = await steadyCapture(page);
        const file = path.join(dir, `${body}-f${p.fill}-p${p.phase}.png`);
        writeFileSync(file, encodePng(img.width, img.height, img.channels, img.pixels));
        if (prev) {
          writeFileSync(file.replace(/\.png$/, '-prev.png'), encodePng(prev.width, prev.height, prev.channels, prev.pixels));
          const tiles = tileDiff(img, prev);
          diffSheet(img, prev, tiles, file.replace(/\.png$/, '-unsteady.png'));
        }
        const disc = discOf(probe, img.width, img.height);
        const found = inspect(img, disc);
        frames.set(key, { img, probe, disc, found, diff, file });
        // The pose itself: the disc has to be the size that was asked for and
        // the camera outside the body, or the frame shows something else.
        const fraction = probe.screen?.fraction ?? 0;
        const inside = probe.renderedRadiusAU != null && probe.distToBodyAU < probe.renderedRadiusAU;
        // An older tree's probe carries no screen block; its pose is not judged.
        const poseOk = !probe.screen || (!inside && Math.abs(fraction - p.fill) <= 0.15 * p.fill);
        if (!poseOk) row('stills', body, `f${p.fill} p${p.phase}`, 'pose-fill', fraction, 'FAIL', `${tag}: ${inside ? 'camera inside the body; ' : ''}rendered radius ${probe.renderedRadiusAU} at ${probe.distToBodyAU}`);
        process.stdout.write(`[sweep] ${tag} ${key}: steady ${diff.toFixed(2)} clipped ${found.clipped} holes ${found.holes} islands ${found.islands} fraction ${fraction.toFixed(2)}${inside ? ' INSIDE' : ''}\n`);
      }
    }
  } finally {
    await context.close();
  }
  if (errors.length) row('stills', '*', tag, 'page-errors', errors.length, 'FAIL', errors.slice(0, 3).join(' | ').slice(0, 300));
  return frames;
}

async function stills(browser) {
  const cand = await stillsOn(browser, URL_BASE, 'cand');
  const ref = REF_BASE ? await stillsOn(browser, REF_BASE, 'ref') : null;
  const sheets = path.join(OUT, 'diff-sheets');
  mkdirSync(sheets, { recursive: true });
  for (const [key, c] of cand) {
    const [body, ...rest] = key.split(' ');
    const poseName = rest.join(' ');
    const r = ref?.get(key) ?? null;
    row('stills', body, poseName, 'steady', c.diff, c.diff < 0.35 ? 'PASS' : 'FAIL', 'mean |Δ| between two captures, /255');
    for (const check of ['clipped', 'holes', 'islands']) {
      const n = c.found[check];
      const base = r ? r.found[check] : 0;
      // Without a reference, a body's own night lights leave dark gaps that
      // read as holes; only a count well past that is a hole in the ground.
      const allowed = r ? base + 8 : (check === 'holes' ? 30 : 8);
      const ex = c.found.examples[check][0];
      row('stills', body, poseName, check, n, n <= allowed ? 'PASS' : 'FAIL',
        (r ? `ref ${base}; ` : '') + (ex ? `e.g. (${ex.x},${ex.y}) rgb ${ex.rgb.join(',')}` : ''));
    }
    if (r) {
      const tiles = tileDiff(c.img, r.img);
      const changed = tiles.filter((t) => t.mean > 2).length / Math.max(1, tiles.length);
      const top = tiles[0];
      const look = tiles.some((t) => t.max >= 40 && t.mean >= 6);
      const file = path.join(sheets, `${body}-${poseName.replace(/ /g, '-')}.png`);
      if (look) diffSheet(c.img, r.img, tiles, file);
      row('stills', body, poseName, 'vs-ref', changed, look ? 'LOOK' : 'PASS',
        `tiles changed >2/255: ${(changed * 100).toFixed(0)}%; worst tile (${top.x},${top.y}) mean ${top.mean.toFixed(1)} max ${top.max}${look ? `; sheet ${path.basename(file)}` : ''}`);
    }
  }
}

/** Where the Sun is on screen: the disc's brightness leans toward it. */
function sunAxis(g, w, h, disc) {
  let sx = 0;
  let sy = 0;
  const r2 = (disc.r * 0.95) ** 2;
  for (let y = Math.max(0, Math.floor(disc.cy - disc.r)); y < Math.min(h, disc.cy + disc.r); y++) {
    for (let x = Math.max(0, Math.floor(disc.cx - disc.r)); x < Math.min(w, disc.cx + disc.r); x++) {
      const dx = x - disc.cx;
      const dy = y - disc.cy;
      if (dx * dx + dy * dy > r2) continue;
      const v = g[y * w + x];
      sx += v * dx;
      sy += v * dy;
    }
  }
  const len = Math.hypot(sx, sy);
  return len > 1e-6 ? [sx / len, sy / len] : [0, -1];
}

/** The framing hook tilts the camera about a screen axis, so the Sun leans
 *  along the other one exactly and only the direction is measured. */
const TILT_AXIS = [0, -1];

/** Pinhole focal length in pixels for the display FOV a pose gets. */
const focalPx = (fovDeg, h) => (h / 2) / Math.tan((fovDeg / 2) * Math.PI / 180);
/** The display FOV the framing hook sets for a fill at DIST_MUL radii. */
const fovForFill = (fill) => (2 * Math.atan(1 / DIST_MUL) * 180 / Math.PI) / fill;

/** Where a sphere's centre sits in camera space, from where it sits on
 *  screen: the camera looks along +z, x right, y up, the centre DIST_MUL
 *  radii away in that direction. */
function sphereCentre(cx, cy, w, h, f) {
  const dx = (cx - w / 2) / f;
  const dy = -(cy - h / 2) / f;
  const n = Math.hypot(dx, dy, 1);
  return [DIST_MUL * dx / n, DIST_MUL * dy / n, DIST_MUL / n];
}

/** Rotate a point about the sphere's centre by the phase, in the plane of the
 *  sun axis and the view: the sub-solar point, at angle p toward the Sun on
 *  the tilted view, goes to the front of the sphere where the face-on camera
 *  saw it. */
function unTilt([hx, hy, hz], phaseDeg) {
  const p = phaseDeg * Math.PI / 180;
  const sx = TILT_AXIS[0];
  const sy = -TILT_AXIS[1];
  const along = hx * sx + hy * sy;
  const across = hx * -sy + hy * sx;
  const along0 = along * Math.cos(p) + hz * Math.sin(p);
  const z0 = -along * Math.sin(p) + hz * Math.cos(p);
  return [along0 * sx + across * -sy, along0 * sy + across * sx, z0];
}

/** Where the sub-solar ground lands on a tilted frame whose disc centre is
 *  at (cx, cy). */
function subSolarOnScreen(phaseDeg, cx, cy, w, h, f) {
  const p = phaseDeg * Math.PI / 180;
  const c = sphereCentre(cx, cy, w, h, f);
  const sx = TILT_AXIS[0];
  const sy = -TILT_AXIS[1];
  const x = c[0] + Math.sin(p) * sx;
  const y = c[1] + Math.sin(p) * sy;
  const z = c[2] - Math.cos(p);
  return [w / 2 + f * x / z, h / 2 - f * y / z];
}

/** The face-on frame seen through the tilted camera: for every pixel of a
 *  window on the tilted frame, the ground under it, rotated back to where
 *  the face-on camera saw it, sampled from the face-on high-pass. Pinhole,
 *  both cameras DIST_MUL radii from the centre; the lens pass bends this by
 *  under a percent near the frame centre, which the shift search absorbs. */
function reprojectFaceOn(hp0, w, h, f, centreT, centre0, phaseDeg, cx, cy, size) {
  const cT = sphereCentre(centreT[0], centreT[1], w, h, f);
  const c0 = sphereCentre(centre0[0], centre0[1], w, h, f);
  const cT2 = cT[0] * cT[0] + cT[1] * cT[1] + cT[2] * cT[2];
  const out = new Float32Array(size * size);
  for (let v = 0; v < size; v++) {
    for (let u = 0; u < size; u++) {
      const px = cx - size / 2 + u + 0.5;
      const py = cy - size / 2 + v + 0.5;
      let dx = (px - w / 2) / f;
      let dy = -(py - h / 2) / f;
      let dz = 1;
      const dl = Math.hypot(dx, dy, dz);
      dx /= dl; dy /= dl; dz /= dl;
      // Unit sphere at cT: nearest hit along the ray.
      const b = dx * cT[0] + dy * cT[1] + dz * cT[2];
      const disc2 = b * b - (cT2 - 1);
      if (disc2 < 0) { out[v * size + u] = 0; continue; }
      const t = b - Math.sqrt(disc2);
      const hit = unTilt([dx * t - cT[0], dy * t - cT[1], dz * t - cT[2]], phaseDeg);
      const x0 = c0[0] + hit[0];
      const y0 = c0[1] + hit[1];
      const z0 = c0[2] + hit[2];
      out[v * size + u] = sampleBilinear(hp0, w, h, w / 2 + f * x0 / z0, h / 2 - f * y0 / z0);
    }
  }
  return out;
}

/** Shoot one body through the tilt phases at one fill, on the tall frame. */
async function tiltArm(browser, base, body, query, tag, dir, fill) {
  const { context, page, errors } = await openPage(browser, { height: TILT_H });
  const shots = [];
  const f = focalPx(fovForFill(fill), TILT_H);
  try {
    await boot(page, base, query);
    // Rectilinear for these frames: the re-projection is a pinhole model,
    // and the lens pass bends a wide frame by more than the shift search
    // can absorb. The surface term is what is measured here, not the lens.
    await page.evaluate(() => window.__moon.setLens(0));
    for (const phase of TILT_PHASES) {
      const probe = await pose(page, body, fill, phase);
      if (!probe) return null;
      await page.waitForTimeout(400);
      await settle(page);
      const img = await capture(page);
      writeFileSync(path.join(dir, `${body}-f${fill}-${tag}-p${phase}.png`), encodePng(img.width, img.height, img.channels, img.pixels));
      shots.push({ phase, img, probe, f });
    }
  } finally {
    await context.close();
  }
  if (errors.length) row('tilt', body, tag, 'page-errors', errors.length, 'FAIL', errors.slice(0, 2).join(' | ').slice(0, 200));
  return shots;
}

function tiltScore(shots) {
  const SIZE = 96;
  const first = shots[0];
  const w = first.img.width;
  const h = first.img.height;
  const f = first.f;
  const hp = shots.map((s) => highpass(gray(s.img), w, h, 3));
  const centre0 = [first.probe.screen.x, first.probe.screen.y];
  const results = [];
  for (let i = 0; i < shots.length; i++) {
    const centreT = [shots[i].probe.screen.x, shots[i].probe.screen.y];
    const [cx, cy] = subSolarOnScreen(shots[i].phase, centreT[0], centreT[1], w, h, f);
    const expected = reprojectFaceOn(hp[0], w, h, f, centreT, centre0, shots[i].phase, cx, cy, SIZE);
    const match = bestMatch(expected, hp[i], w, h, cx, cy, SIZE, 16);
    const actual = windowAt(hp[i], w, h, cx + match.sx, cy + match.sy, SIZE);
    results.push({ phase: shots[i].phase, corr: match.corr, shift: [match.sx, match.sy], cx, cy, expected, actual });
  }
  return results;
}

/** The whole-disc pose says which way the Sun leans; the model assumes it. */
function leanCheck(shots) {
  const lean = shots.find((s) => s.phase >= 50) ?? shots[shots.length - 1];
  const disc = discOf(lean.probe, lean.img.width, lean.img.height);
  const dir = sunAxis(gray(lean.img), lean.img.width, lean.img.height, disc);
  const snapped = Math.abs(dir[0]) > Math.abs(dir[1]) ? [Math.sign(dir[0]), 0] : [0, Math.sign(dir[1])];
  return { dir, ok: snapped[0] === TILT_AXIS[0] && snapped[1] === TILT_AXIS[1] };
}

async function tilt(browser) {
  const dir = path.join(OUT, 'tilt');
  mkdirSync(dir, { recursive: true });
  const SIZE = 96;
  const SCALE = 3;
  const GAP = 6;
  for (const body of TILT_BODIES) {
    for (const fill of TILT_FILLS) {
      const on = await tiltArm(browser, URL_BASE, body, '', 'on', dir, fill);
      if (!on) { row('tilt', body, `f${fill}`, 'pose', 'refused', 'SKIP'); break; }
      if (fill === TILT_FILLS[0]) {
        const lean = leanCheck(on);
        row('tilt', body, `f${fill}`, 'sun-lean', lean.dir.map((a) => a.toFixed(2)).join(','), lean.ok ? 'PASS' : 'FAIL', 'the model assumes the Sun leans straight up the frame');
        if (!lean.ok) break;
      }
      const off = await tiltArm(browser, URL_BASE, body, '&synth=0', 'off', dir, fill);
      const so = tiltScore(on);
      const sf = off ? tiltScore(off) : null;
      const sheet = new Sheet(GAP + TILT_PHASES.length * (SIZE * SCALE + GAP), GAP + 4 * (SIZE * SCALE + GAP));
      for (let i = 0; i < so.length; i++) {
        const dx = GAP + i * (SIZE * SCALE + GAP);
        const r = so[i];
        sheet.blitGray(r.actual, SIZE, SIZE, dx, GAP, SCALE, 4, 128);
        sheet.blitGray(r.expected, SIZE, SIZE, dx, GAP + (SIZE * SCALE + GAP), SCALE, 4, 128);
        if (sf) {
          sheet.blitGray(sf[i].actual, SIZE, SIZE, dx, GAP + 2 * (SIZE * SCALE + GAP), SCALE, 4, 128);
          sheet.blitGray(sf[i].expected, SIZE, SIZE, dx, GAP + 3 * (SIZE * SCALE + GAP), SCALE, 4, 128);
        }
        const corrOff = sf ? sf[i].corr : null;
        // How much of the detail in the window the term itself drew: past the
        // map's texels the map has none, and the term is the only crater
        // source, so it is judged against its own re-projection; where the
        // map still carries the detail, against the map's own tracking.
        const rmsOn = rms(r.actual);
        const rmsOff = sf ? rms(sf[i].actual) : 0;
        const termShare = rmsOn > 0 ? Math.max(0, 1 - rmsOff / rmsOn) : 0;
        // Grazing views lose detail to the pixel footprint on both arms; the
        // term is judged where the ground still resolves.
        const judged = r.phase >= 20 && r.phase <= 60;
        const floor = r.phase <= 50 ? 0.5 : 0.4;
        const bad = termShare > 0.3 || corrOff === null
          ? r.corr < floor
          : corrOff - r.corr > 0.2;
        const verdict = !judged ? 'INFO' : bad ? 'FAIL' : 'PASS';
        row('tilt', body, `f${fill} p${r.phase}`, 'ground-corr', r.corr, verdict,
          `${corrOff === null ? '' : `term off ${corrOff.toFixed(3)}; `}term share ${termShare.toFixed(2)}; shift ${r.shift.join(',')}`);
      }
      sheet.save(path.join(dir, `${body}-f${fill}-sheet.png`));
    }
  }
}

async function zoom(browser) {
  const dir = path.join(OUT, 'zoom');
  mkdirSync(dir, { recursive: true });
  const STEPS = 24;
  const CROP = 320;
  for (const body of ZOOM_BODIES) {
    const { context, page, errors } = await openPage(browser);
    const crops = [];
    try {
      await boot(page, URL_BASE, '');
      for (let i = 0; i <= STEPS; i++) {
        const fill = 0.7 * 2 ** (i / STEPS);
        const probe = await pose(page, body, fill, 40);
        if (!probe) break;
        const img = await capture(page);
        crops.push(highpass(gray(img), img.width, img.height, 6));
        if (i % 6 === 0 || i === STEPS) writeFileSync(path.join(dir, `${body}-step${i}.png`), encodePng(img.width, img.height, img.channels, img.pixels));
      }
    } finally {
      await context.close();
    }
    if (errors.length) row('zoom', body, '*', 'page-errors', errors.length, 'FAIL', errors.slice(0, 2).join(' | ').slice(0, 200));
    if (crops.length < 2) { row('zoom', body, '*', 'pose', 'refused', 'SKIP'); continue; }
    const corrs = [];
    const ratio = 2 ** (1 / STEPS);
    for (let i = 0; i + 1 < crops.length; i++) {
      // One step magnifies the ground by 2.9% about the disc centre, which is
      // nearly five pixels at the edge of the scored window: the earlier
      // frame is scaled up by the step before the shift search, so what is
      // scored is the ground and not the zoom.
      const ref = new Float32Array(CROP * CROP);
      for (let v = 0; v < CROP; v++) {
        for (let u = 0; u < CROP; u++) {
          ref[v * CROP + u] = sampleBilinear(crops[i], W, H,
            W / 2 + (u + 0.5 - CROP / 2) / ratio, H / 2 + (v + 0.5 - CROP / 2) / ratio);
        }
      }
      corrs.push(bestMatch(ref, crops[i + 1], W, H, W / 2, H / 2, CROP, 12).corr);
    }
    const sorted = [...corrs].sort((a, b) => a - b);
    const min = sorted[0];
    const median = sorted[Math.floor(sorted.length / 2)];
    row('zoom', body, 'fill 0.7→1.4', 'step-corr-min', min, min >= 0.85 ? 'PASS' : 'FAIL', `median ${median.toFixed(3)}; lowest at step ${corrs.indexOf(min)}`);
  }
}

// ------------------------------------------------------------------ main

if (arg('inspect', '')) {
  const img = decodePng(readFileSync(arg('inspect', '')));
  const found = inspect(img, discOf(null, img.width, img.height));
  console.log(JSON.stringify(found, null, 1));
  process.exit(0);
}

mkdirSync(OUT, { recursive: true });
const release = await takeBrowserLock('sweep');
const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true, args: GPU_ARGS });
const started = Date.now();
try {
  console.log(`[sweep] ${URL_BASE}${REF_BASE ? ` vs ${REF_BASE}` : ''} -> ${OUT}; scenarios ${SCENARIOS.join(',')}`);
  if (SCENARIOS.includes('stills')) await stills(browser);
  if (SCENARIOS.includes('tilt')) await tilt(browser);
  if (SCENARIOS.includes('zoom')) await zoom(browser);
} finally {
  await browser.close();
  release();
}
const fails = rows.filter((r) => r.verdict === 'FAIL');
const looks = rows.filter((r) => r.verdict === 'LOOK');
writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ url: URL_BASE, ref: REF_BASE, time: TIME_MS, rows }, null, 1));
console.log(`[sweep] ${rows.length} rows, ${fails.length} FAIL, ${looks.length} LOOK, ${((Date.now() - started) / 60000).toFixed(1)} min -> ${OUT}/report.json`);
for (const r of fails) console.log(`[sweep] FAIL ${r.scenario} ${r.body} ${r.pose} ${r.check} ${typeof r.value === 'number' ? r.value.toFixed(3) : r.value} ${r.note}`);
process.exit(fails.length ? 1 : 0);
