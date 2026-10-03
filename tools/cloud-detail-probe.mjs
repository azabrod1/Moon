// Cloud-detail probe: does the cloud deck's close-range detail ride the cloud
// it belongs to?
//
// The deck's detail (world/cloudDetailNoise, read in world/surfaceShading's
// deck block) is a tileable field read at the deck's own longitude and
// latitude. It has to be read in the frame the cloud MAP is painted in — the
// deck mesh's, which turns with the planet and drifts on top of that — or the
// field stands still while the cloud moves under it and every carved edge
// crawls. `cloud-noise-frame` (app/perfSwitches.ts) is the fix; its OFF arm,
// `?perfoff=cloud-noise-frame`, is the old world-anchored frame, and the
// control run must fail on it.
//
//   node tools/cloud-detail-probe.mjs --url=http://localhost:5726 --scenario=anchor,crawl
//   node tools/cloud-detail-probe.mjs --url=... --scenario=anchor,crawl \
//     --extra='&perfoff=cloud-noise-frame' --expect=fail      # the control
//
// Every scenario draws the DECK ALONE: every other material in the scene has
// its colour writes off (depth still written, so nothing behind the globe
// shows), which is what keeps ground texture seen through a hole from being
// what the registration locks onto. Sector streaming is off (`&sectors=0`) —
// the ground is not drawn anyway — and the lens is off, so a translation of
// the sheet is a translation on screen. Bloom is off and the exposure pinned.
//
// The reading. The detail's own signal is D = ON − OFF, the deck with the
// detail term against the deck without it (`cloud-probe-detail`), both out of
// one frozen frame. Two moments are registered on the OFF pair — the cloud
// layer itself, so the planet's spin AND the deck's drift are in the shift —
// block by block (a 3 × 2 grid, so the slight rotation of a turning globe is
// a set of local translations), sub-pixel. Then the later moment's D is read
// at that shift and correlated with the earlier one's. A detail anchored to
// the sheet correlates near 1; one anchored anywhere else has moved relative
// to the cloud by the whole shift and does not. The high-pass of the ON pair
// alone is reported beside it (the map's own soft edges are in that one, so it
// cannot fall as far on the control).
//
// Scenarios:
//   anchor — the Italy pose (0.3 km a pixel, nadir, frozen clock): OFF and ON
//            at t0, then the clock set 90 s on and the same body-centred pose
//            taken again (a clock set may rebase the ride frame), OFF and ON
//            at t1. 90 s turns the globe 0.38° — about 110 px at this scale —
//            and drifts the deck a further 8 px.
//   crawl  — the same pose with the clock RUNNING at `--rate` (default 90×):
//            five stops a second of wall time apart, OFF and ON at each stop
//            with the clock held, consecutive stops scored as above. The shift
//            is whatever a second at that rate carries (~100 px at 90×).
//
// PASS: every scored pair's median block correlation of D is at least
// `--min` (default 0.9). `--expect=fail` inverts the exit code. GPU flags as
// every battery; takes /tmp/moon-browser.lock. Captures and a JSON of every
// reading land in /tmp/moon-shots/<label>/.
import { chromium, webkit } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { takeBrowserLock } from './browserLock.mjs';
import { decodePng } from './pngDecode.mjs';
import { encodePng } from './pngEncode.mjs';

const arg = (k, d) => { const m = process.argv.find((a) => a.startsWith(`--${k}=`)); return m ? m.slice(k.length + 3) : d; };
const URL = arg('url', 'http://localhost:5726');
const EXTRA = arg('extra', '');
const EXPECT = arg('expect', 'pass');
const ENGINE = arg('engine', 'chromium');
const LABEL = arg('label', `cloud-detail-probe-${ENGINE}`);
const SCENARIOS = arg('scenario', 'anchor,crawl').split(',').map((s) => s.trim()).filter(Boolean);
const W = Number(arg('w', '1100'));
const H = Number(arg('h', '700'));
const MIN_CORR = Number(arg('min', '0.9'));
const RATE = Number(arg('rate', '90'));
const JUMP_S = Number(arg('jump', '90'));
// The high-pass the detail's own signal is read through. D carries the
// envelope the term is weighted by — the coverage, which moves with the cloud
// in both arms — as well as the field's own pattern, and on its own that
// envelope correlates across a registration whichever frame the field is read
// in. Box radius in pixels, applied twice.
const DETAIL_HP = Number(arg('hp', '8'));
// `--rescore=<dir>` scores the PNGs a previous run left there, no browser.
const RESCORE = arg('rescore', '');
const OUT = path.join('/tmp/moon-shots', LABEL);
mkdirSync(OUT, { recursive: true });

/**
 * The Italy pose: a nadir frame 400 km over Lazio at the vernal equinox, the
 * Sun 48° up. At 1100 × 700 and ratio 1 the ground map reads 16.6 px a texel
 * there, which is 0.295 km a pixel — the scale the soft-cloud complaint was
 * made at. `limbView` stands on the sunward side and swings north by `phase`.
 */
const ITALY = { time: '2026-03-21T11:15:00Z', k: 1 + 400 / 6371, fov: 29.4, phase: 42, aim: 0 };

const GPU_ARGS = ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ image helpers

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
    const o = y * w;
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += src[o + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[o + x] = sum / n;
      sum += src[o + Math.min(w - 1, x + r + 1)] - src[o + Math.max(0, x - r)];
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

const sub = (a, b) => { const o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] - b[i]; return o; };

function sampleBilinear(g, w, h, x, y) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) return NaN;
  const fx = x - x0;
  const fy = y - y0;
  const i = y0 * w + x0;
  return (g[i] * (1 - fx) + g[i + 1] * fx) * (1 - fy) + (g[i + w] * (1 - fx) + g[i + w + 1] * fx) * fy;
}

/** Normalised cross-correlation over the entries both arrays define. */
function ncc(a, b) {
  let n = 0, sa = 0, sb = 0;
  for (let i = 0; i < a.length; i++) { if (Number.isNaN(a[i]) || Number.isNaN(b[i])) continue; sa += a[i]; sb += b[i]; n++; }
  if (n < 16) return NaN;
  const ma = sa / n, mb = sb / n;
  let saa = 0, sbb = 0, sab = 0;
  for (let i = 0; i < a.length; i++) {
    if (Number.isNaN(a[i]) || Number.isNaN(b[i])) continue;
    const da = a[i] - ma, db = b[i] - mb;
    saa += da * da; sbb += db * db; sab += da * db;
  }
  return sab / Math.sqrt(Math.max(1e-9, saa * sbb));
}

/** A size-square block of g at (x0, y0), read at a sub-pixel offset. */
function block(g, w, h, x0, y0, size, dx = 0, dy = 0) {
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) out[y * size + x] = sampleBilinear(g, w, h, x0 + x + dx, y0 + y + dy);
  }
  return out;
}

/** g reduced by an integer factor, box-averaged. */
function downsample(g, w, h, f) {
  const W2 = Math.floor(w / f), H2 = Math.floor(h / f);
  const out = new Float32Array(W2 * H2);
  for (let y = 0; y < H2; y++) {
    for (let x = 0; x < W2; x++) {
      let s = 0;
      for (let v = 0; v < f; v++) for (let u = 0; u < f; u++) s += g[(y * f + v) * w + x * f + u];
      out[y * W2 + x] = s / (f * f);
    }
  }
  return { g: out, w: W2, h: H2 };
}

/**
 * Where b's content sits relative to a's: the shift (dx, dy) such that
 * b(x + dx, y + dy) ≈ a(x, y). Searched at a quarter of the resolution over a
 * wide window first — a turning globe carries the sheet a hundred pixels or
 * more between two moments — then refined block by block at full resolution
 * with a parabolic sub-pixel peak, so a slight rotation across the frame is a
 * set of local shifts rather than one wrong one.
 */
function registerBlocks(a, b, w, h, { blocks = [3, 2], size = 192, rangeX = 220, rangeY = 120 } = {}) {
  const f = 4;
  const A = downsample(a, w, h, f);
  const B = downsample(b, w, h, f);
  const rx = Math.round(rangeX / f), ry = Math.round(rangeY / f);
  const mx = rx + 2, my = ry + 2;
  const inner = (sx, sy) => {
    const n = (A.w - 2 * mx) * (A.h - 2 * my);
    const pa = new Float32Array(n), pb = new Float32Array(n);
    let k = 0;
    for (let y = my; y < A.h - my; y++) {
      for (let x = mx; x < A.w - mx; x++) { pa[k] = A.g[y * A.w + x]; pb[k] = B.g[(y + sy) * B.w + x + sx]; k++; }
    }
    return ncc(pa, pb);
  };
  let global = { corr: -2, sx: 0, sy: 0 };
  for (let sy = -ry; sy <= ry; sy++) {
    for (let sx = -rx; sx <= rx; sx++) {
      const c = inner(sx, sy);
      if (c > global.corr) global = { corr: c, sx, sy };
    }
  }
  const gx = global.sx * f, gy = global.sy * f;
  const out = [];
  const [bx, by] = blocks;
  // Blocks laid over the part of a whose shifted partner is still on b.
  const x0 = Math.max(8, 8 - gx), x1 = Math.min(w - 8, w - 8 - gx);
  const y0 = Math.max(8, 8 - gy), y1 = Math.min(h - 8, h - 8 - gy);
  for (let j = 0; j < by; j++) {
    for (let i = 0; i < bx; i++) {
      const cx = Math.round(x0 + ((i + 0.5) * (x1 - x0)) / bx - size / 2);
      const cy = Math.round(y0 + ((j + 0.5) * (y1 - y0)) / by - size / 2);
      if (cx < 0 || cy < 0 || cx + size > w || cy + size > h) continue;
      const ref = block(a, w, h, cx, cy, size);
      const score = (dx, dy) => ncc(ref, block(b, w, h, cx, cy, size, dx, dy));
      let best = { corr: -2, dx: gx, dy: gy };
      for (let dy = gy - f; dy <= gy + f; dy++) {
        for (let dx = gx - f; dx <= gx + f; dx++) {
          const c = score(dx, dy);
          if (c > best.corr) best = { corr: c, dx, dy };
        }
      }
      const peak = (m, c0, p) => { const d = m - 2 * c0 + p; return d < 0 ? 0.5 * (m - p) / d : 0; };
      const sxp = peak(score(best.dx - 1, best.dy), best.corr, score(best.dx + 1, best.dy));
      const syp = peak(score(best.dx, best.dy - 1), best.corr, score(best.dx, best.dy + 1));
      out.push({ x: cx, y: cy, size, dx: best.dx + sxp, dy: best.dy + syp, regCorr: best.corr });
    }
  }
  return { global: { dx: gx, dy: gy, corr: global.corr }, blocks: out };
}

/** How much of a block is deck: the share of pixels brighter than black. */
function coverage(g, w, h, x0, y0, size, floor = 6) {
  let n = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (g[(y0 + y) * w + x0 + x] > floor) n++;
  return n / (size * size);
}

const median = (a) => { const s = a.filter(Number.isFinite).sort((p, q) => p - q); return s.length ? s[s.length >> 1] : NaN; };
const rmsOf = (a) => { let s = 0, n = 0, m = 0; for (const v of a) if (Number.isFinite(v)) { m += v; n++; } m /= n || 1; for (const v of a) if (Number.isFinite(v)) s += (v - m) * (v - m); return Math.sqrt(s / (n || 1)); };

/**
 * Score one pair of moments, each an {off, on} pair of grey frames. Registered
 * on OFF; D = ON − OFF correlated block by block at that registration, with
 * the ON pair's own high-pass beside it.
 */
function scorePair(m0, m1) {
  const reg = registerBlocks(m0.off, m1.off, W, H);
  const d0 = highpass(sub(m0.on, m0.off), W, H, DETAIL_HP);
  const d1 = highpass(sub(m1.on, m1.off), W, H, DETAIL_HP);
  const hp0 = highpass(m0.on, W, H, 4);
  const hp1 = highpass(m1.on, W, H, 4);
  const blocks = [];
  for (const bl of reg.blocks) {
    const cov = coverage(m0.off, W, H, bl.x, bl.y, bl.size);
    const dRef = block(d0, W, H, bl.x, bl.y, bl.size);
    const detailRms = rmsOf(dRef);
    blocks.push({
      ...bl,
      cov,
      detailRms,
      detailCorr: ncc(dRef, block(d1, W, H, bl.x, bl.y, bl.size, bl.dx, bl.dy)),
      hpOnCorr: ncc(block(hp0, W, H, bl.x, bl.y, bl.size), block(hp1, W, H, bl.x, bl.y, bl.size, bl.dx, bl.dy)),
    });
  }
  // A block that is mostly clear sky, or where the detail term changed almost
  // nothing, has no detail to track: it is reported and not scored.
  const scored = blocks.filter((b) => b.cov > 0.3 && b.detailRms > 0.5);
  return {
    global: reg.global,
    blocks,
    scoredBlocks: scored.length,
    detailCorr: median(scored.map((b) => b.detailCorr)),
    hpOnCorr: median(scored.map((b) => b.hpOnCorr)),
    shiftPx: median(reg.blocks.map((b) => Math.hypot(b.dx, b.dy))),
  };
}

// -------------------------------------------------------------- page helpers

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
  return { context, page, errors };
}

async function boot(page, query) {
  await page.goto(`${URL}/?auto=planetarium${query}${EXTRA}`, { waitUntil: 'domcontentloaded' });
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
    m.setLens(0);
    m.pinCapture({ near: 1e-7, exposure: 1, pixelRatio: 1 });
  });
}

async function pose(page, p, timeMs = Date.parse(p.time)) {
  return page.evaluate(({ p, timeMs }) => {
    window.__moon.setTimeMs(timeMs);
    return window.__moon.limbView('Earth', p.k, p.fov, p.phase, p.aim);
  }, { p, timeMs });
}

/** Wait until the deck wears the top rung it can reach, nothing is in flight,
 *  and the air's tables are either baked or known not to come — they fade a
 *  haze over the whole deck when they land, which no capture pair may
 *  straddle. */
async function waitDeck(page, timeoutMs = 60_000) {
  const t0 = Date.now();
  for (;;) {
    const st = await page.evaluate(() => {
      const rung = window.__moon.ladder()?.rungs?.find((r) => r.key === 'earthClouds');
      return {
        tier: rung?.tier ?? null,
        top: rung?.top ?? null,
        releasing: rung?.releasing ?? null,
        air: window.__moon.atmoState()?.state ?? null,
      };
    });
    if (st.tier && st.tier === st.top && !st.releasing && st.air !== 'baking') return st;
    if (Date.now() - t0 > timeoutMs) return { ...st, timedOut: true };
    await sleep(1000);
  }
}

/** Colour writes off on every material but the deck's (depth still written),
 *  so the frame is the deck over black. Run again before every capture: a
 *  mesh built since the last call starts with its colour on. */
async function deckOnly(page) {
  return page.evaluate(() => {
    let deck = 0;
    window.__moon.scene().traverse((o) => {
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of mats) {
        const isDeck = o.isMesh && m.defines && 'CLOUD_DECK' in m.defines;
        if (isDeck) { deck++; m.colorWrite = true; } else m.colorWrite = false;
      }
    });
    return deck;
  });
}

async function settle(page, n = 4) {
  for (let i = 0; i < n; i++) {
    await page.evaluate(() => (window.__moon.waitForDraw
      ? window.__moon.waitForDraw(2)
      : new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))));
  }
}

/** A capture that has stopped changing: two in a row the same bytes. */
async function stillShot(page) {
  await settle(page);
  let last = await page.screenshot();
  for (let i = 0; i < 8; i++) {
    await settle(page, 2);
    const next = await page.screenshot();
    if (Buffer.compare(last, next) === 0) return next;
    last = next;
  }
  return last;
}

/** The detail term off (the cost probe that removes it whole) or back on. */
const setDetail = (page, on) => page.evaluate((v) => window.__moon.perfArm('cloud-probe-detail', !v), on);

/** OFF and ON at this frozen moment, as grey frames, and the PNGs. */
async function moment(page, tag) {
  await deckOnly(page);
  await setDetail(page, false);
  const offPng = await stillShot(page);
  await setDetail(page, true);
  const onPng = await stillShot(page);
  writeFileSync(path.join(OUT, `${tag}.off.png`), offPng);
  writeFileSync(path.join(OUT, `${tag}.on.png`), onPng);
  return { off: gray(decodePng(offPng)), on: gray(decodePng(onPng)) };
}

/** D = ON − OFF of a moment written as an image, mid-grey at zero, ×4. */
function writeDetail(m, file) {
  const px = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    const v = Math.max(0, Math.min(255, 128 + 4 * (m.on[i] - m.off[i])));
    px[i * 3] = px[i * 3 + 1] = px[i * 3 + 2] = v;
  }
  writeFileSync(file, encodePng(W, H, 3, px));
}

// ---------------------------------------------------------------- scenarios

const report = { url: URL, extra: EXTRA, engine: ENGINE, W, H, scenarios: {} };
let allPass = true;

function verdict(name, pairs) {
  const worst = Math.min(...pairs.map((p) => p.detailCorr));
  const pass = pairs.length > 0 && pairs.every((p) => Number.isFinite(p.detailCorr) && p.detailCorr >= MIN_CORR && p.scoredBlocks >= 2);
  allPass &&= pass;
  const lines = pairs.map((p, i) => `pair ${i}: shift ${p.shiftPx.toFixed(1)} px, detail corr ${p.detailCorr.toFixed(3)}, high-pass ON corr ${p.hpOnCorr.toFixed(3)} over ${p.scoredBlocks} blocks`);
  console.log(`[cloud-probe] ${name} ${pass ? 'PASS' : 'FAIL'} (worst detail corr ${worst.toFixed(3)}, bar ${MIN_CORR})`);
  for (const l of lines) console.log(`[cloud-probe]   ${l}`);
  report.scenarios[name] = { pass, bar: MIN_CORR, pairs };
}

async function anchor(page) {
  const t0 = Date.parse(ITALY.time);
  await pose(page, ITALY, t0);
  await waitDeck(page);
  await sleep(1500);
  const m0 = await moment(page, 'anchor-t0');
  await pose(page, ITALY, t0 + JUMP_S * 1000);
  await sleep(1500);
  await waitDeck(page);
  const m1 = await moment(page, 'anchor-t1');
  writeDetail(m0, path.join(OUT, 'anchor-t0.detail.png'));
  writeDetail(m1, path.join(OUT, 'anchor-t1.detail.png'));
  verdict('anchor', [scorePair(m0, m1)]);
}

async function crawl(page) {
  const t0 = Date.parse(ITALY.time);
  await pose(page, ITALY, t0);
  await waitDeck(page);
  await sleep(1500);
  const moments = [await moment(page, 'crawl-0')];
  for (let k = 1; k < 5; k++) {
    // The clock runs through rendered frames — no clock set, so nothing
    // rebases — for a second of wall time, and is held for the pair.
    await page.evaluate((r) => window.__moon.setTimeRate(r), RATE);
    await sleep(1000);
    await page.evaluate(() => window.__moon.setTimeRate(0));
    moments.push(await moment(page, `crawl-${k}`));
  }
  writeDetail(moments[0], path.join(OUT, 'crawl-0.detail.png'));
  const pairs = [];
  for (let k = 0; k + 1 < moments.length; k++) pairs.push(scorePair(moments[k], moments[k + 1]));
  verdict('crawl', pairs);
}

// --------------------------------------------------------------------- main

if (RESCORE) {
  const { readFileSync, existsSync } = await import('node:fs');
  const load = (tag) => {
    const f = (arm) => path.join(RESCORE, `${tag}.${arm}.png`);
    if (!existsSync(f('off'))) return null;
    return { off: gray(decodePng(readFileSync(f('off')))), on: gray(decodePng(readFileSync(f('on')))) };
  };
  const a0 = load('anchor-t0');
  const a1 = load('anchor-t1');
  if (a0 && a1) verdict('anchor', [scorePair(a0, a1)]);
  const crawlMoments = [0, 1, 2, 3, 4].map((k) => load(`crawl-${k}`)).filter(Boolean);
  if (crawlMoments.length > 1) {
    const pairs = [];
    for (let k = 0; k + 1 < crawlMoments.length; k++) pairs.push(scorePair(crawlMoments[k], crawlMoments[k + 1]));
    verdict('crawl', pairs);
  }
  const ok = EXPECT === 'fail' ? !allPass : allPass;
  console.log(`[cloud-probe] rescored ${RESCORE} with a ${DETAIL_HP} px high-pass: ${ok ? 'OK' : 'NOT OK'} (expected ${EXPECT})`);
  process.exit(ok ? 0 : 1);
}

const release = await takeBrowserLock('cloud-probe');
const launcher = ENGINE === 'webkit' ? webkit : chromium;
const browser = await launcher.launch({ headless: true, args: ENGINE === 'webkit' ? undefined : GPU_ARGS });
try {
  for (const name of SCENARIOS) {
    const { context, page, errors } = await openPage(browser);
    try {
      await boot(page, '&sectors=0');
      if (name === 'anchor') await anchor(page);
      else if (name === 'crawl') await crawl(page);
      else { console.log(`[cloud-probe] no scenario named ${name}`); allPass = false; }
      if (errors.length) {
        console.log(`[cloud-probe] ${name}: ${errors.length} page errors: ${errors.slice(0, 3).join(' | ').slice(0, 300)}`);
        allPass = false;
      }
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
  release();
}
writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
const ok = EXPECT === 'fail' ? !allPass : allPass;
console.log(`[cloud-probe] ${ok ? 'OK' : 'NOT OK'} (expected ${EXPECT}; frames in ${OUT})`);
process.exit(ok ? 0 : 1);
