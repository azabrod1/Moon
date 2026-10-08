// Cloud HD probe: does what the ground shows under Earth's cloud deck agree
// with the deck as it is drawn?
//
// `--scenario=shadow` is the battery for the cloud shadows (world/
// surfaceShading, the CLOUD_SHADOW switch, on unless `?cloudshadows=0`), read
// off the deck's base sheet (`?cloudtiles=0`, so no page lands between two
// captures of one frame): a shadow has to lie where the Sun's ray to that
// ground crosses the cloud as the deck DRAWS it — the 10 km shell, in the
// deck's own drifting frame — or it reads as a second, offset copy of the
// cloud pattern rather than as its shadow.
//
// Each Sun height is one frozen nadir frame (`limbView` straight down, the
// lens and the bloom off, the exposure pinned), captured three times out of
// one page load:
//   A  the ground alone (the deck's colour writes off, the deck still drawn,
//      so the shadow's per-frame gate stays open), shadows off;
//   B  the same, shadows on (`__moon.cloudShadow({on: true})`);
//   D  the deck drawn, shadows off, with its relief map and its close-range
//      detail probed off (`cloud-probe-relief`, `cloud-probe-detail`): at a low
//      Sun the deck's own relief shades it in ridges that have nothing to do
//      with where it stands, and the shadow reads the deck's map, not its
//      eroded edge, so the cloud's signal is its coverage and little else.
// The shadow's own signal is A − B (where the ground went darker), the
// cloud's is D − A (where the deck put light). The cloud image is first
// scaled about the nadir by the parallax of a 10 km layer seen from the
// camera's height, so both are read in the ground's own screen coordinates;
// both are high-passed; and the shift that best correlates the cloud with the
// shadow is found (coarse search, then a full-resolution refine with a
// parabolic peak). That shift is held against the EXACT geometry: the shell
// point at the frame's centre, the ground point whose ray toward the Sun
// passes through it (spherical, not h·cot e), both projected through the
// camera the pose built. PASS: the vector error is within `--tol` (0.2) of the
// expected length and the peak correlation at least `--mincorr` (0.5).
//
// `--scenario=field` is the same three Sun heights with Earth's cloud field
// on (the default, world/cloudField): the deck draws its 1.2 km pages and
// the ground's shadow reads the same pages at the pierce point, so the bar is
// the shadow under the SHARP cloud. After each pose it waits for the field to
// settle — nothing in the pipe, nothing fading, every page the residency
// wants (the deck's and the shadows') in the table at full fade — and fails a
// height whose frame never had a page resident, which would test the base
// sheet again. No hour: the clock's drift is the base scenario's question.
//
// `--hour` (on by default; `--hour=0` skips it) runs the clock: at the middle
// Sun height, from an hour of its own, it runs at `--rate` (default 900×) for four
// wall-time stretches of a simulated quarter hour each, re-poses after each,
// and holds every stop to the same bar, so a shadow read in a frame that drifts
// apart from the deck's would show as a growing error.
//
//   node tools/cloud-hd-probe.mjs --url=http://localhost:5743 --scenario=shadow
//   node tools/cloud-hd-probe.mjs --url=http://localhost:5743 --scenario=field
//
// GPU flags as every battery; takes /tmp/moon-browser.lock. Captures, signal
// maps and a JSON of every reading land in /tmp/moon-shots/<label>/.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { takeBrowserLock } from './browserLock.mjs';
import { decodePng } from './pngDecode.mjs';
import { encodePng } from './pngEncode.mjs';

const arg = (k, d) => { const m = process.argv.find((a) => a.startsWith(`--${k}=`)); return m ? m.slice(k.length + 3) : d; };
const URL = arg('url', 'http://localhost:5743');
const EXTRA = arg('extra', '');
const LABEL = arg('label', 'cloud-hd-probe');
const SCENARIOS = arg('scenario', 'shadow').split(',').map((s) => s.trim()).filter(Boolean);
const W = Number(arg('w', '1100'));
const H = Number(arg('h', '700'));
const TOL = Number(arg('tol', '0.2'));
const MIN_CORR = Number(arg('mincorr', '0.5'));
const RATE = Number(arg('rate', '900'));
const HOUR = arg('hour', '1') !== '0';
const HP = Number(arg('hp', '24'));
// The cloud signal's RMS (8-bit grey, high-passed) under which a frame is
// called cloudless and not scored.
const MIN_CLOUD_RMS = Number(arg('mincloud', '2'));
// The December solstice, at an hour local noon stands over the Atlantic: the
// subsolar point is at 23.4 S, and limbView's phase swings the stand point
// north along its meridian, so the three Sun heights below land at 7 N, 47 N
// and 59 N over open ocean. Ground with texture of its own (snow on a coast)
// correlates with nothing the deck draws and is kept out of frame. Each height
// names its own hour, because the frame needs cloud with texture at its own
// scale under it: the deck's base sheet is an area average of the cloud
// master, soft at these magnifications, and a stop over a smooth veil has no
// signal to register (noon over 39 W for the two higher Suns, over 30 W for
// the lowest). `--time=` puts every height at one hour instead.
const TIME_ARG = arg('time', null);
/** The hour a height is posed at. */
const timeOf = (cfg) => Date.parse(TIME_ARG ?? cfg.time);
/** Where the running hour starts: noon over 160 E, so its five stops at the
 *  middle height walk west across 15 degrees of textured cloud over the open
 *  north Pacific. */
const HOUR_START = Date.parse(TIME_ARG ?? '2025-12-21T01:20:00Z');
const CLOUD_TOP_KM = 10;
const KM_PER_AU = 149597870.7;
const OUT = path.join('/tmp/moon-shots', LABEL);
mkdirSync(OUT, { recursive: true });

/** The Sun heights, each with a frame that puts its shadow a readable number
 *  of pixels off without the cloud field blurring into one blob. */
const HEIGHTS = [
  { name: 'sun60', elevDeg: 60, altKm: 400, fovDeg: 20, time: '2025-12-21T14:35:00Z' },
  { name: 'sun20', elevDeg: 20, altKm: 400, fovDeg: 30, time: '2025-12-21T14:35:00Z' },
  { name: 'sun8', elevDeg: 8, altKm: 600, fovDeg: 40, time: '2025-12-21T14:00:00Z' },
];

const GPU_ARGS = ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'];

// ------------------------------------------------------------ vector helpers
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul3 = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (a) => mul3(a, 1 / Math.hypot(a[0], a[1], a[2]));

/** Nearest t > 0 where origin + t·dir meets the sphere of radius r about c. */
function raySphere(origin, dir, c, r) {
  const oc = sub3(origin, c);
  const b = dot3(oc, dir);
  const q = dot3(oc, oc) - r * r;
  const disc = b * b - q;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  const t0 = -b - s;
  const t1 = -b + s;
  return t0 > 1e-15 ? t0 : (t1 > 1e-15 ? t1 : null);
}

/**
 * The exact geometry of one frame. The camera is the pose limbView builds:
 * at the player, looking at the nadir, world-up as its up, a pinhole of the
 * vertical field of view it reports (the lens is off). The shell point under
 * the frame's centre is where the centre ray meets the drawn deck; its shadow
 * is the ground point whose ray toward the Sun passes through it.
 */
function geometry(probe) {
  const B = [probe.bodyAbs.x, probe.bodyAbs.y, probe.bodyAbs.z];
  const P = [probe.playerAbs.x, probe.playerAbs.y, probe.playerAbs.z];
  const R = probe.radiusAU;
  const h = CLOUD_TOP_KM / KM_PER_AU;
  const L = norm3(mul3(B, -1));
  const z = norm3(sub3(P, B));
  const x = norm3(cross3([0, 1, 0], z));
  const y = cross3(z, x);
  const tanHalf = Math.tan((probe.projFovDeg * Math.PI) / 360);
  const proj = (X) => {
    const d = sub3(X, P);
    const zc = -dot3(d, z);
    return [((dot3(d, x) / zc / (tanHalf * (W / H)) + 1) * W) / 2, ((1 - dot3(d, y) / zc / tanHalf) * H) / 2];
  };
  const centreRay = mul3(z, -1);
  const S0 = add3(P, mul3(centreRay, raySphere(P, centreRay, B, R + h)));
  const tG = raySphere(S0, mul3(L, -1), B, R);
  const G0 = add3(S0, mul3(L, -tG));
  const ps = proj(S0);
  const pg = proj(G0);
  const nG = norm3(sub3(G0, B));
  const altitudeAU = Math.hypot(...sub3(P, B)) - R;
  return {
    expected: [pg[0] - ps[0], pg[1] - ps[1]],
    centre: ps,
    sunElevDeg: (Math.asin(dot3(nG, L)) * 180) / Math.PI,
    groundOffsetKm: Math.hypot(...sub3(G0, add3(B, mul3(norm3(sub3(S0, B)), R)))) * KM_PER_AU,
    altitudeKm: altitudeAU * KM_PER_AU,
    // A layer at h seen from this height is magnified about the nadir by this
    // much against the ground under it.
    parallax: altitudeAU / (altitudeAU - h),
    kmPerPx: (2 * altitudeAU * tanHalf * KM_PER_AU) / H,
  };
}

// ------------------------------------------------------------ image helpers
function gray(img) {
  const { width, height, channels, pixels } = img;
  const g = new Float32Array(width * height);
  for (let i = 0, k = 0; i < g.length; i++, k += channels) g[i] = 0.299 * pixels[k] + 0.587 * pixels[k + 1] + 0.114 * pixels[k + 2];
  return g;
}
function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let s = 0;
    for (let x = -r; x <= r; x++) s += src[o + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) { tmp[o + x] = s / n; s += src[o + Math.min(w - 1, x + r + 1)] - src[o + Math.max(0, x - r)]; }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) { out[y * w + x] = s / n; s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]; }
  }
  return out;
}
function highpass(g, w, h, r) {
  const b = boxBlur(boxBlur(g, w, h, r), w, h, r);
  const o = new Float32Array(g.length);
  for (let i = 0; i < g.length; i++) o[i] = g[i] - b[i];
  return o;
}
function bilinear(g, w, h, x, y) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) return NaN;
  const fx = x - x0;
  const fy = y - y0;
  const i = y0 * w + x0;
  return (g[i] * (1 - fx) + g[i + 1] * fx) * (1 - fy) + (g[i + w] * (1 - fx) + g[i + w + 1] * fx) * fy;
}
/** g scaled about (cx, cy) by k: out(p) = g(c + (p − c)·k). */
function scaleAbout(g, w, h, cx, cy, k) {
  const o = new Float32Array(g.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) o[y * w + x] = bilinear(g, w, h, cx + (x - cx) * k, cy + (y - cy) * k);
  return o;
}
function downsample(g, w, h, f) {
  const W2 = Math.floor(w / f);
  const H2 = Math.floor(h / f);
  const o = new Float32Array(W2 * H2);
  for (let y = 0; y < H2; y++) {
    for (let x = 0; x < W2; x++) {
      let s = 0;
      let n = 0;
      for (let v = 0; v < f; v++) for (let u = 0; u < f; u++) { const val = g[(y * f + v) * w + x * f + u]; if (Number.isFinite(val)) { s += val; n++; } }
      o[y * W2 + x] = n ? s / n : NaN;
    }
  }
  return { g: o, w: W2, h: H2 };
}
/** NCC of a over the window against b read at (x + dx, y + dy). */
function nccAt(a, b, w, h, win, dx, dy) {
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let y = win.y0; y < win.y1; y++) {
    for (let x = win.x0; x < win.x1; x++) {
      const va = a[y * w + x];
      const vb = Number.isInteger(dx) && Number.isInteger(dy) ? b[(y + dy) * w + x + dx] : bilinear(b, w, h, x + dx, y + dy);
      if (!Number.isFinite(va) || !Number.isFinite(vb)) continue;
      n++; sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb;
    }
  }
  if (n < 64) return -2;
  const ca = saa - (sa * sa) / n;
  const cb = sbb - (sb * sb) / n;
  return (sab - (sa * sb) / n) / Math.sqrt(Math.max(1e-9, ca * cb));
}
/**
 * The shift s with shadow(x + s) ≈ cloud(x), searched over |s| ≤ range about
 * zero (a coarse pass at a quarter of the resolution, then ±4 px at full
 * resolution and a parabolic peak).
 */
function findShift(cloud, shadow, w, h, range) {
  const f = 4;
  const A = downsample(cloud, w, h, f);
  const B = downsample(shadow, w, h, f);
  const r = Math.ceil(range / f);
  const m = r + 2;
  const winC = { x0: m, x1: A.w - m, y0: m, y1: A.h - m };
  let best = { c: -2, sx: 0, sy: 0 };
  for (let sy = -r; sy <= r; sy++) {
    for (let sx = -r; sx <= r; sx++) {
      if (sx * sx + sy * sy > r * r) continue;
      const c = nccAt(A.g, B.g, A.w, A.h, winC, sx, sy);
      if (c > best.c) best = { c, sx, sy };
    }
  }
  const M = Math.ceil(range) + 12;
  const win = { x0: M, x1: w - M, y0: M, y1: h - M };
  let fine = { c: -2, dx: best.sx * f, dy: best.sy * f };
  for (let dy = best.sy * f - f; dy <= best.sy * f + f; dy++) {
    for (let dx = best.sx * f - f; dx <= best.sx * f + f; dx++) {
      const c = nccAt(cloud, shadow, w, h, win, dx, dy);
      if (c > fine.c) fine = { c, dx, dy };
    }
  }
  const peak = (mn, c0, p) => { const d = mn - 2 * c0 + p; return d < 0 ? (0.5 * (mn - p)) / d : 0; };
  const px = peak(nccAt(cloud, shadow, w, h, win, fine.dx - 1, fine.dy), fine.c, nccAt(cloud, shadow, w, h, win, fine.dx + 1, fine.dy));
  const py = peak(nccAt(cloud, shadow, w, h, win, fine.dx, fine.dy - 1), fine.c, nccAt(cloud, shadow, w, h, win, fine.dx, fine.dy + 1));
  // How sharply the shadow says where it is: the correlation at no shift at
  // all, which is what a straight-down read would give.
  const atZero = nccAt(cloud, shadow, w, h, win, 0, 0);
  return { dx: fine.dx + px, dy: fine.dy + py, corr: fine.c, corrAtZero: atZero };
}
/** A signal map as a PNG: grey 128 at zero, gain k. */
function signalPng(g, w, h, k) {
  const px = new Uint8Array(w * h * 3);
  for (let i = 0; i < g.length; i++) {
    const v = Number.isFinite(g[i]) ? Math.max(0, Math.min(255, 128 + g[i] * k)) : 0;
    px[i * 3] = px[i * 3 + 1] = px[i * 3 + 2] = v;
  }
  return encodePng(w, h, 3, px);
}

// -------------------------------------------------------------- the page
async function openPage(browser) {
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
  return { page, errors };
}

/** The lens strength the pass runs at once it is asked for none. */
let lensStrength = NaN;

async function boot(page, query = '') {
  await page.goto(`${URL}/?auto=planetarium&quality=medium${EXTRA}${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__moon?.ready?.(), null, { timeout: 90_000 });
  await page.waitForFunction(() => {
    const ls = document.getElementById('loading-screen');
    return !ls || ls.classList.contains('hidden');
  }, null, { timeout: 90_000 }).catch(() => {});
  await page.evaluate(() => {
    const m = window.__moon;
    m.setChrome(false);
    m.setShipVisible(false);
    m.setTimeRate(0);
    m.setAutoExposure(false);
    m.setBloom(false);
    m.pinCapture({ near: 1e-7, exposure: 1, pixelRatio: 1 });
  });
  lensStrength = await page.evaluate(() => window.__moon.setLens(0));
  // The air's tables bake a few seconds after the reveal and change the sea's
  // colour when they land: every capture is taken after them.
  const t0 = Date.now();
  for (;;) {
    const s = await page.evaluate(() => window.__moon.atmoState?.()?.state ?? null);
    if (s === 'ready' || s === null || Date.now() - t0 > 45_000) break;
    await page.waitForTimeout(500);
  }
}

async function still(page) {
  const draw = (n) => page.evaluate((k) => window.__moon.waitForDraw(k), n);
  await draw(4);
  let last = await page.screenshot({ type: 'png' });
  for (let i = 0; i < 14; i++) {
    await draw(2);
    await page.waitForTimeout(250);
    const next = await page.screenshot({ type: 'png' });
    if (Buffer.compare(last, next) === 0) return next;
    last = next;
  }
  console.log('[hd-probe] a frame never held still; using the last');
  return last;
}

/**
 * Wait for the cloud field to settle at this pose: nothing in the pipe,
 * nothing fading, every wanted page in the table at full fade, the table
 * unmoved for a second and a half. Returns what it saw.
 */
async function settleField(page, maxMs = 40_000) {
  return page.evaluate(async (limit) => {
    const m = window.__moon;
    const start = performance.now();
    let lastKey = null;
    let lastChange = 0;
    for (;;) {
      const t = performance.now() - start;
      const st = await m.cloudField();
      const r = st.residency;
      const full = new Set(st.pool.table.filter((e) => e.fade === 1).map((e) => e.page));
      const key = st.pool.table.map((e) => `${e.page}:${e.fade}`).join(' ');
      if (key !== lastKey) { lastKey = key; lastChange = t; }
      const allIn = r.wantedPages.every((w) => full.has(w.page));
      const settled = r.pipe === 'idle' && r.fading === 0 && allIn && t - lastChange >= 1500;
      if (settled || t >= limit) {
        return { settled, ms: Math.round(t), resident: r.resident, full: full.size, wanted: r.wantedPages.map((w) => w.page) };
      }
      await new Promise((res) => setTimeout(res, 150));
    }
  }, maxMs);
}

async function deckColour(page, on) {
  return page.evaluate((v) => {
    let n = 0;
    window.__moon.scene().traverse((o) => {
      if (o.isMesh && /clouds$/.test(o.name ?? '')) { o.material.colorWrite = v; n++; }
    });
    return n;
  }, on);
}

async function poseAt(page, cfg) {
  const R = 6371;
  const ok = await page.evaluate(([k, fov, phase]) => window.__moon.limbView('Earth', k, fov, phase, 0),
    [1 + cfg.altKm / R, cfg.fovDeg, 90 - cfg.elevDeg]);
  if (!ok) throw new Error(`limbView refused for ${cfg.name}`);
  await page.waitForTimeout(3000);
  const t0 = Date.now();
  for (;;) {
    const busy = await page.evaluate(() => window.__moon.sectors?.()?.inflight ?? 0);
    if (!busy || Date.now() - t0 > 30_000) break;
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(800);
}

/** The three captures of one frozen frame, the readings, and the verdict. */
async function measure(page, cfg, tag) {
  const p = await page.evaluate(() => window.__moon.probe('Earth'));
  const lens = lensStrength;
  // The lens is off, so the frame is a pinhole of the camera's own field.
  const probe = { ...p, projFovDeg: lens === 0 ? p.overscanFov : NaN };
  const geo = geometry(probe);
  const decks = await deckColour(page, false);
  if (decks < 1) throw new Error('no cloud deck in the scene');
  await page.evaluate(() => window.__moon.cloudShadow({ on: false }));
  const A = await still(page);
  const st = await page.evaluate(() => window.__moon.cloudShadow({ on: true }));
  if (!st || st.compiled < 1) throw new Error(`the shadow did not compile: ${JSON.stringify(st)}`);
  const Bp = await still(page);
  await page.evaluate(() => window.__moon.cloudShadow({ on: false }));
  await deckColour(page, true);
  await page.evaluate(() => { window.__moon.perfArm('cloud-probe-relief', true); window.__moon.perfArm('cloud-probe-detail', true); });
  const D = await still(page);
  await page.evaluate(() => { window.__moon.perfArm('cloud-probe-relief', false); window.__moon.perfArm('cloud-probe-detail', false); });
  writeFileSync(path.join(OUT, `${tag}.ground.png`), A);
  writeFileSync(path.join(OUT, `${tag}.shadowed.png`), Bp);
  writeFileSync(path.join(OUT, `${tag}.deck.png`), D);
  const a = gray(decodePng(A));
  const b = gray(decodePng(Bp));
  const d = gray(decodePng(D));
  const shadowRaw = new Float32Array(a.length);
  const cloudRaw = new Float32Array(a.length);
  let shadowSum = 0;
  for (let i = 0; i < a.length; i++) { shadowRaw[i] = a[i] - b[i]; cloudRaw[i] = d[i] - a[i]; shadowSum += shadowRaw[i]; }
  // The cloud seen at 10 km, put back over the ground it stands above.
  const [cx, cy] = geo.centre;
  const cloudFoot = scaleAbout(cloudRaw, W, H, cx, cy, geo.parallax);
  const cloudHp = highpass(cloudFoot.map((v) => (Number.isFinite(v) ? v : 0)), W, H, HP);
  const shadowHp = highpass(shadowRaw, W, H, HP);
  writeFileSync(path.join(OUT, `${tag}.signal-cloud.png`), signalPng(cloudHp, W, H, 2));
  writeFileSync(path.join(OUT, `${tag}.signal-shadow.png`), signalPng(shadowHp, W, H, 8));
  // A frame with no cloud in it has nothing to say about where a shadow lies:
  // reported, not scored.
  let cloudRms = 0;
  for (let y = 100; y < H - 100; y++) for (let x = 100; x < W - 100; x++) cloudRms += cloudHp[y * W + x] ** 2;
  cloudRms = Math.sqrt(cloudRms / ((W - 200) * (H - 200)));
  const E = geo.expected;
  const lenE = Math.hypot(E[0], E[1]);
  const range = Math.min(Math.max(1.6 * lenE, 40), Math.min(W, H) / 3);
  const s = findShift(cloudHp, shadowHp, W, H, range);
  const err = Math.hypot(s.dx - E[0], s.dy - E[1]);
  const lenM = Math.hypot(s.dx, s.dy);
  const angleErrDeg = (Math.acos(Math.max(-1, Math.min(1, (s.dx * E[0] + s.dy * E[1]) / Math.max(1e-9, lenM * lenE)))) * 180) / Math.PI;
  const scored = cloudRms >= MIN_CLOUD_RMS;
  const pass = !scored || (err <= TOL * lenE && s.corr >= MIN_CORR);
  return {
    tag,
    pass,
    scored,
    cloudRms: +cloudRms.toFixed(2),
    sunElevDeg: +geo.sunElevDeg.toFixed(2),
    altitudeKm: +geo.altitudeKm.toFixed(1),
    kmPerPx: +geo.kmPerPx.toFixed(4),
    fov: { displayed: p.fov, projection: p.overscanFov, lens },
    expectedPx: E.map((v) => +v.toFixed(2)),
    expectedKm: +geo.groundOffsetKm.toFixed(2),
    measuredPx: [+s.dx.toFixed(2), +s.dy.toFixed(2)],
    lengthRatio: +(lenM / lenE).toFixed(3),
    angleErrDeg: +angleErrDeg.toFixed(2),
    vectorErrFrac: +(err / lenE).toFixed(3),
    corr: +s.corr.toFixed(3),
    corrAtZeroShift: +s.corrAtZero.toFixed(3),
    meanDarkening: +(shadowSum / a.length).toFixed(3),
  };
}

// ---------------------------------------------------------------- the run
const release = await takeBrowserLock(LABEL);
const browser = await chromium.launch({ headless: true, args: GPU_ARGS });
const report = { url: URL, extra: EXTRA, time: TIME_ARG ?? Object.fromEntries(HEIGHTS.map((h) => [h.name, h.time])), tol: TOL, minCorr: MIN_CORR, rows: [], hour: [] };
let failures = 0;
try {
  const { page, errors } = await openPage(browser);
  report.errors = errors;
  if (SCENARIOS.includes('field')) {
    // Its own boot, the default one: the field is settled at boot and cannot
    // be switched on later.
    await boot(page);
    const on = await page.evaluate(async () => (await window.__moon.cloudField())?.pool?.layers ?? 0);
    console.log(`[hd-probe] field booted, ${on} pool layers`);
    if (!on) { failures++; console.log('[hd-probe] field: FAIL, the session has no cloud field'); }
    for (const cfg of HEIGHTS) {
      await page.evaluate((t) => window.__moon.setTimeMs(t), timeOf(cfg));
      await poseAt(page, cfg);
      // The shadow's own demand joins only while the shadow is compiled: on
      // for the wait, then measure() takes its captures.
      await page.evaluate(() => window.__moon.cloudShadow({ on: true }));
      const field = await settleField(page);
      const row = { ...(await measure(page, cfg, `field-${cfg.name}`)), field };
      const paged = field.settled && field.full > 0;
      if (!paged) row.pass = false;
      report.rows.push(row);
      if (!row.pass || !row.scored) failures++;
      console.log(`[hd-probe] field-${cfg.name}: ${!paged ? 'FAIL (no page resident: the base sheet, not the field)' : !row.scored ? 'NO CLOUD (a height must be scored)' : row.pass ? 'PASS' : 'FAIL'} `
        + `pages ${field.full} at full fade (settled ${field.settled}, ${field.ms} ms), sun ${row.sunElevDeg}°, expected ${row.expectedPx} px, `
        + `measured ${row.measuredPx} px, length x${row.lengthRatio}, angle ${row.angleErrDeg}°, err ${(row.vectorErrFrac * 100).toFixed(1)} %, `
        + `corr ${row.corr} (at zero shift ${row.corrAtZeroShift})`);
    }
  }
  if (SCENARIOS.includes('shadow')) {
    // The base sheet's battery: with the field on, a page fading in between
    // the three captures of one frame would read as a shadow.
    await boot(page, '&cloudtiles=0');
    console.log('[hd-probe] booted', JSON.stringify(await page.evaluate(() => window.__moon.cloudShadow())));
    for (const cfg of HEIGHTS) {
      await page.evaluate((t) => window.__moon.setTimeMs(t), timeOf(cfg));
      await poseAt(page, cfg);
      const row = await measure(page, cfg, cfg.name);
      report.rows.push(row);
      if (!row.pass || !row.scored) failures++;
      console.log(`[hd-probe] ${cfg.name}: ${!row.scored ? 'NO CLOUD (a height must be scored)' : row.pass ? 'PASS' : 'FAIL'} sun ${row.sunElevDeg}°, expected ${row.expectedPx} px (${row.expectedKm} km), `
        + `measured ${row.measuredPx} px, length x${row.lengthRatio}, angle ${row.angleErrDeg}°, err ${(row.vectorErrFrac * 100).toFixed(1)} %, `
        + `corr ${row.corr} (at zero shift ${row.corrAtZeroShift})`);
    }
    if (HOUR) {
      // The clock running: a simulated hour at the middle height, in four
      // stretches, re-posed and measured after each.
      const cfg = HEIGHTS[1];
      await page.evaluate((t) => window.__moon.setTimeMs(t), HOUR_START);
      await poseAt(page, cfg);
      const first = await measure(page, cfg, 'hour0');
      report.hour.push({ ...first, simMin: 0 });
      console.log(`[hd-probe] hour +0 min: ${!first.scored ? 'no cloud, unscored' : first.pass ? 'PASS' : 'FAIL'} measured ${first.measuredPx} vs ${first.expectedPx}, err ${(first.vectorErrFrac * 100).toFixed(1)} %, corr ${first.corr}`);
      if (!first.pass) failures++;
      for (let k = 1; k <= 4; k++) {
        const before = await page.evaluate(() => window.__moon.timeState?.()?.currentUtcMs ?? null);
        await page.evaluate((r) => window.__moon.setTimeRate(r), RATE);
        await page.waitForTimeout((15 * 60 * 1000) / RATE);
        await page.evaluate(() => window.__moon.setTimeRate(0));
        // Land the stop on the quarter exactly: the wall wait carries jitter.
        await page.evaluate((t) => window.__moon.setTimeMs(t), HOUR_START + k * 15 * 60 * 1000);
        await poseAt(page, cfg);
        const row = await measure(page, cfg, `hour${k}`);
        report.hour.push({ ...row, simMin: k * 15, clockBefore: before });
        if (!row.pass) failures++;
        console.log(`[hd-probe] hour +${k * 15} min: ${!row.scored ? 'no cloud, unscored' : row.pass ? 'PASS' : 'FAIL'} measured ${row.measuredPx} vs ${row.expectedPx}, err ${(row.vectorErrFrac * 100).toFixed(1)} %, corr ${row.corr}`);
      }
      const scoredStops = report.hour.filter((r) => r.scored).length;
      console.log(`[hd-probe] hour: ${scoredStops} of ${report.hour.length} stops had cloud to score`);
      if (scoredStops < 3) { failures++; console.log('[hd-probe] hour: FAIL, fewer than three stops scored'); }
    }
  }
} finally {
  writeFileSync(path.join(OUT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
  release();
}
console.log(`[hd-probe] ${failures ? `FAIL (${failures})` : 'PASS'}; frames and report in ${OUT}`);
process.exit(failures ? 1 : 0);
