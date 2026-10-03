// Earth's cloud master: NASA's Blue Marble cloud hemispheres assembled into one
// whole-globe 43200x21600 field that is the same sky as the cloud sheet the app
// ships, with the numbers and the pictures that say how far that holds.
//
// The sheet the app ships (8192x4096, every rung cut from it) is a re-grade of
// NASA's Blue Marble Clouds composite, and NASA publishes the visible part of
// that composite as two 21600x21600 hemispheres, 0.93 km a texel: the same sky
// at five times the resolution. This tool turns them into ONE master that
// every finer cloud product can be cut from, so a step up the ladder stays a
// pure sharpen of the sky the far view already draws (the same-product rule in
// gen-tiles.mjs). It cuts nothing itself: no tiles, no rungs.
//
// The hemispheres are not the whole of that sky. Equatorward of 50 degrees the
// composite IS the hemispheres, code value for code value at its own grid.
// Poleward of 50 degrees NASA laid an infrared layer over the visible one: it
// brightens every cell, most where the visible is dark, from nothing at 50 to
// the whole of the field over the polar caps, Greenland and the other places
// the hemispheres hold no data at all (zero, which the app would draw as clear
// sky). A screen blend, composite = V + visible x (1 - V), reproduces that
// exactly for every cell's mean, because it is linear in the visible for a
// given V. So V is solved per 8192x4096 cell from the composite and the
// master's own mean there, upsampled (cubic) and applied to every master
// texel: the cell keeps NASA's brightness and the master's detail inside it,
// where the hemispheres have no data V is the composite itself (missing data
// never becomes clear sky), and equatorward of 50 degrees V is zero and the
// master is the hemispheres untouched. No separate gain is applied: the
// composite and the hemispheres share one scale (the report measures it).
// At the ragged rim of a hole the zero texels take V alone and their
// neighbours V plus their own light, so the rim reads as faint hard-edged
// patches at the master's texel, which NASA's 8K average hides; the cell
// means stay right.
//
// The hemispheres also carry single dark texels inside bright cloud (see
// repairRow), which become pinholes at the master's texel and are repaired
// before anything is measured. Thin straight dark lines along some swath
// edges, a few texels wide, are NASA's and are left as they are, and so is the
// hard seam at 180 degrees between the equator and 30 S, where NASA's daily
// passes on either side of the day boundary saw the clouds hours apart (its
// 8K composite has it too; the shipped sheet was retouched there).
//
// Then one transfer, stored' = clamp(a * stored^g + b), is fitted against the
// shipped sheet (both at 8192x4096, area-weighted by cos(latitude), on the
// cells the infrared layer leaves alone) and applied, because the shipped
// sheet is a re-grade and the app's coverage curve is authored against ITS
// stored values. The shipped sheet is not NASA's sky everywhere: over some
// land (the central United States most of all) it carries clouds NASA's
// composite does not, which no tone curve can reach, so the fit is taken by
// default only in the 5-degree blocks where the two agree. The report carries
// the fit, the correlations, where the two skies differ, and the alpha
// statistics the coverage curve turns into what is drawn, so whether the sky
// moved is a number and not an impression.
//
// Memory stays bounded: the full raster is 933 MB and is never held. The
// hemispheres are decoded in row bands (sharp re-reads a PNG from the top for
// each band, which is cheap next to holding it), the master is written to disk
// a band at a time and processed in place, and everything global — the
// longitude check, the infrared layer, the fit, the statistics — runs on
// 8192x4096 area averages accumulated as the bands go past.
//
// Output: one byte a texel, row 0 = +90 latitude, column 0 = -180 longitude,
// no header (`<name>.43200x21600.r8`), plus a JSON report beside it and a page
// of side-by-side pictures (shipped sheet left, master right, same region at
// the master's texel).
//
// Prereq (not a package.json dependency — this runs once per asset drop):
//   npm i --no-save sharp@0.35.4
// Usage:
//   node tools/gen-cloudmaster.mjs                 # the whole run
//   node tools/gen-cloudmaster.mjs --dry-run       # the plan and the input checks, writes nothing
//   node tools/gen-cloudmaster.mjs --pictures-only # the pictures again from a master on disk
//   --cache=<dir>     the source cache. Default: the MAIN checkout's
//                     .moon-data-cache, found through git, so a worktree reads
//                     the one copy of the sources (tools/devTilesPlugin.mjs
//                     resolves its staging root the same way)
//   --out=<file>      the master (default <cache>/levels/earth-clouds.v2.43200x21600.r8)
//   --pictures=<dir>  where the pictures go (default <main checkout>/planning/cloud-detail/master)
//   --no-pictures     skip them
//   --fit=<domain>    the cells the grade is fitted on: same-sky (default) or all
//   --band=<rows>     master rows per band (default 1080)
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import path from 'node:path';

sharp.cache(false);
sharp.concurrency(0);

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };

const HELP = `gen-cloudmaster — assemble NASA's Blue Marble cloud hemispheres into one 43200x21600 master

  node tools/gen-cloudmaster.mjs [--cache=<dir>] [--out=<file>] [--pictures=<dir>]
                                 [--fit=same-sky|all] [--band=<rows>]
                                 [--dry-run | --pictures-only | --no-pictures]

  --cache=<dir>     source cache (default: the main checkout's .moon-data-cache)
  --out=<file>      master path (default <cache>/levels/earth-clouds.v2.43200x21600.r8)
  --pictures=<dir>  picture folder (default <main checkout>/planning/cloud-detail/master)
  --no-pictures     write the master and the report only
  --pictures-only   redraw the pictures from the master already on disk
  --fit=<domain>    grade fitted on the cells where the shipped sheet is NASA's sky
                    (same-sky, the default) or on every cell the infrared leaves alone (all)
  --band=<rows>     master rows per processing band (default 1080, divides 21600)
  --dry-run         print the plan and check the inputs; write nothing
  --help            this text`;

if (flag('help')) { console.log(HELP); process.exit(0); }

/** The main checkout's root, through git's common dir, so a planning/.wt-*
 *  worktree finds the one cache instead of an empty copy of its own. */
function mainCheckoutRoot() {
  try {
    const gitDir = execSync('git rev-parse --path-format=absolute --git-common-dir', {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    return path.dirname(gitDir);
  } catch { return process.cwd(); }
}

const ROOT = mainCheckoutRoot();
const CACHE = path.resolve(opt('cache', path.join(ROOT, '.moon-data-cache')));
const OUT = path.resolve(opt('out', path.join(CACHE, 'levels', 'earth-clouds.v2.43200x21600.r8')));
const REPORT = OUT.replace(/\.r8$/, '') + '.json';
const PICTURES = path.resolve(opt('pictures', path.join(ROOT, 'planning', 'cloud-detail', 'master')));
const FIT_DOMAIN = opt('fit', 'same-sky');
const BAND = Number(opt('band', '1080'));

const SRC = {
  west: path.join(CACHE, 'cloud.W.2001210.21600x21600.png'),
  east: path.join(CACHE, 'cloud.E.2001210.21600x21600.png'),
  composite: path.join(CACHE, 'cloud_combined_8192.tif'),
  shipped: path.join(CACHE, 'sss_8k_earth_clouds.jpg'),
};
// The 2K rung the app draws first, read for its statistics only (the header
// of src/planetarium/world/cloudDeck.ts quotes its numbers).
const SHIPPED_2K = path.resolve('public/textures/earth-clouds.webp');

// The master's grid and the 8K grid every global measurement runs on. The
// ratio is 5.2734375 on both axes, so an 8K cell is the same patch of sky in
// both directions and a 2K cell is exactly 4x4 of them.
const HW = 21600;
const MW = 2 * HW;
const MH = HW;
const W8 = 8192;
const H8 = 4096;
const R8 = MW / W8;

// The app's coverage curve (src/planetarium/world/cloudDeck.ts): the deck's
// alpha is smoothstep(LOW, HIGH, stored luminance), with "stored" recovered in
// the shader as pow(linear, 1 / 2.2) from an sRGB-decoded sample. The two
// readings differ only in the toe (sRGB's linear segment): stored, code 15 is
// the last clear one; recovered, code 6 is.
const COVERAGE_LOW = 0.06;
const COVERAGE_HIGH = 0.75;
const RECOVERY_GAMMA = 2.2;

// NASA's infrared layer starts at 50 degrees of latitude in both hemispheres
// (equatorward of 49.5 the composite's cell means sit within a fifth of a code
// of the hemispheres'). The layer solved below is gated over this band so the
// filter difference between NASA's downsample and this one — a few codes
// either way at cloud edges, everywhere — is never read as infrared.
const IR_GATE = [49.5, 50.5];

// "No data" for the report: an 8K cell whose 3x3 neighbourhood holds no
// master texel above zero while the composite draws cloud there (above the
// coverage curve's clear edge).
const NO_DATA_CODE = Math.floor(COVERAGE_LOW * 255);

// The longitude check searches this many texels either way at 2K, on the band
// of latitudes where both sheets hold data everywhere and the infrared layer
// is absent.
const SHIFT_SEARCH = 8;
const SHIFT_LAT = 45;

// Where the shipped sheet is NASA's sky: 5x5 degree blocks whose correlation
// between NASA's composite and the shipped sheet is at least this.
const SAME_SKY_BLOCK_DEG = 5;
const SAME_SKY_R = 0.95;

// Regions the pictures show, in degrees: [west, east, south, north]. Every
// one is drawn at the master's own texel (120 a degree).
const PICTURE_BOXES = [
  { name: 'italy', box: [10, 16, 40.5, 44], note: 'central Italy' },
  { name: 'pacific-trade-cumulus', box: [-128, -122, -22, -18], note: 'trade-wind cumulus, eastern Pacific' },
  { name: 'front-south-indian', box: [68, 78, -46, -40], note: 'a mid-latitude front, southern Indian Ocean' },
  { name: 'north-polar-edge', box: [-175, -165, 72, 80], note: 'where the hemispheres end, north' },
  { name: 'south-polar-edge', box: [60, 70, -71, -63], note: 'where the hemispheres end, south' },
  { name: 'infrared-onset-50n', box: [-35, -25, 46, 54], note: 'the infrared layer starting at 50 N' },
  { name: 'russia-no-data', box: [28, 40, 56, 63], note: 'a hole in the hemispheres away from the poles' },
  { name: 'usa-shipped-differs', box: [-105, -93, 34, 42], note: 'where the shipped sheet is not NASA\'s sky' },
  { name: 'greenwich-join', box: [-2, 2, 30, 50], note: 'the W|E join at 0 longitude' },
  { name: 'dateline-join', box: [178, 182, 30, 50], note: 'the E|W join at 180 longitude' },
  { name: 'dateline-join-south', box: [178, 182, -25, -5], note: 'the E|W join where NASA\'s day boundary shows' },
];
const GLOBE = { width: 4096, height: 2048 };

const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)} s`;
let peakRss = 0;
const log = (...m) => {
  const rss = process.memoryUsage().rss;
  peakRss = Math.max(peakRss, rss);
  console.log(`[${elapsed().padStart(7)} ${String(Math.round(rss / 1e6)).padStart(4)} MB]`, ...m);
};

const latOfRow = (row, height) => 90 - (180 * (row + 0.5)) / height;
const cosLat = (row, height) => Math.cos((latOfRow(row, height) * Math.PI) / 180);
const smoothstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const irGate = (lat) => smoothstep(IR_GATE[0], IR_GATE[1], Math.abs(lat));

async function sha256(file) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}

/** One-channel bytes from whatever sharp hands back, written into `out` at
 *  `offset`. A grey image can come back with 1, 3 or 4 channels depending on
 *  the format and the pipeline, so the stride is always info.channels. Three
 *  or more channels are reduced by Rec. 709 luma, whose weights sum to one,
 *  so a grey texel comes through as itself; returns whether every texel was
 *  grey. */
function intoGrey(data, info, label, out, offset = 0) {
  const ch = info.channels;
  const n = info.width * info.height;
  if (data.length !== n * ch) throw new Error(`${label}: ${data.length} bytes for ${info.width}x${info.height}x${ch}`);
  if (ch === 1) { out.set(data, offset); return true; }
  if (ch === 2) { for (let i = 0; i < n; i++) out[offset + i] = data[i * 2]; return true; }
  let grey = true;
  for (let i = 0, o = 0; i < n; i++, o += ch) {
    const r = data[o], g = data[o + 1], b = data[o + 2];
    if (r !== g || r !== b) grey = false;
    out[offset + i] = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
  }
  return grey;
}

/** A whole image as one channel, decoded a band of rows at a time so a
 *  three-channel 8K file never sits in memory at three bytes a texel. */
async function loadGrey(file, label, size) {
  const { width, height } = await sharp(file, { limitInputPixels: false }).metadata();
  if (size && (width !== size[0] || height !== size[1])) throw new Error(`${label}: ${width}x${height}, expected ${size.join('x')}`);
  const grey = new Uint8Array(width * height);
  const rows = 512;
  let allGrey = true;
  for (let top = 0; top < height; top += rows) {
    const h = Math.min(rows, height - top);
    const { data, info } = await sharp(file, { limitInputPixels: false, sequentialRead: true })
      .extract({ left: 0, top, width, height: h }).raw().toBuffer({ resolveWithObject: true });
    if (info.width !== width || info.height !== h) throw new Error(`${label} band ${top}: ${info.width}x${info.height}`);
    allGrey = intoGrey(data, info, label, grey, top * width) && allGrey;
  }
  if (!allGrey) log(`  ${label}: channels differ, reduced by Rec. 709 luma`);
  return { grey, width, height, allGrey };
}

/** One band of a hemisphere PNG, one channel. */
async function hemisphereBand(file, top, height) {
  const { data, info } = await sharp(file, { limitInputPixels: false, sequentialRead: true })
    .extract({ left: 0, top, width: HW, height })
    .extractChannel(0)
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== HW || info.height !== height) throw new Error(`${path.basename(file)} band ${top}: ${info.width}x${info.height}`);
  if (info.channels === 1) return data;
  const grey = new Uint8Array(HW * height);
  intoGrey(data, info, path.basename(file), grey);
  return grey;
}

/**
 * Exact area average of a byte raster fed one row at a time, onto a coarser
 * grid whose cells need not hold a whole number of source texels: each
 * source texel lands in at most two cells per axis with its overlap as the
 * weight. Optionally tracks each cell's max over every texel touching it.
 * `into` reuses a grid a finished pass no longer needs.
 */
class AreaAverage {
  constructor(srcW, srcH, dstW, dstH, { max = false, into = null } = {}) {
    Object.assign(this, { srcW, srcH, dstW, dstH });
    this.rx = srcW / dstW;
    this.ry = srcH / dstH;
    this.sum = into ? into.fill(0) : new Float32Array(dstW * dstH);
    this.col = new Int32Array(srcW);
    this.colW = new Float64Array(srcW);
    for (let x = 0; x < srcW; x++) {
      const j = Math.floor(x / this.rx);
      this.col[x] = j;
      this.colW[x] = Math.min(x + 1, (j + 1) * this.rx) - x;
    }
    this.acc = new Float64Array(dstW + 1);
    if (max) {
      this.max = new Uint8Array(dstW * dstH);
      this.rowMax = new Uint8Array(dstW + 1);
    }
  }

  addRow(y, row) {
    const { acc, col, colW, srcW } = this;
    acc.fill(0);
    const rowMax = this.rowMax;
    if (rowMax) rowMax.fill(0);
    for (let x = 0; x < srcW; x++) {
      const v = row[x], j = col[x], a = colW[x];
      acc[j] += v * a;
      if (a < 1) acc[j + 1] += v * (1 - a);
      if (rowMax) {
        if (v > rowMax[j]) rowMax[j] = v;
        if (a < 1 && v > rowMax[j + 1]) rowMax[j + 1] = v;
      }
    }
    const i = Math.floor(y / this.ry);
    const b = Math.min(y + 1, (i + 1) * this.ry) - y;
    this.#land(i, b);
    if (b < 1 && i + 1 < this.dstH) this.#land(i + 1, 1 - b);
  }

  #land(i, weight) {
    const { acc, dstW, sum } = this;
    const o = i * dstW;
    for (let j = 0; j < dstW; j++) sum[o + j] += acc[j] * weight;
    if (this.max) for (let j = 0; j < dstW; j++) if (this.rowMax[j] > this.max[o + j]) this.max[o + j] = this.rowMax[j];
  }

  /** The averages, in source code values. */
  finish() {
    const k = 1 / (this.rx * this.ry);
    for (let i = 0; i < this.sum.length; i++) this.sum[i] *= k;
    return this.sum;
  }
}

/** A 4x4 (or any f x f) box of a grid whose size divides by f: exact area
 *  averaging, because the coarse cell is the union of equal-area fine ones. */
function boxDown(src, w, h, f) {
  const dw = w / f, dh = h / f, out = new Float32Array(dw * dh), k = 1 / (f * f);
  for (let i = 0; i < h; i++) {
    const o = ((i / f) | 0) * dw;
    for (let j = 0; j < w; j++) out[o + ((j / f) | 0)] += src[i * w + j] * k;
  }
  return out;
}

/**
 * Catmull-Rom (Keys, a = -1/2) upsampling of a grid onto a finer one, one
 * destination row at a time, at texel centres: wrapped across the +-180
 * longitude seam, clamped at the poles. The filter sharp calls "cubic",
 * written out so the grid alignment and the wrap are exact rather than a
 * resize of an extract with its edges extended.
 */
class CubicUpsampler {
  constructor(src, sw, sh, dw, dh) {
    Object.assign(this, { src, sw, sh, dw, dh });
    this.taps = new Int32Array(dw * 4);
    this.weights = new Float32Array(dw * 4);
    for (let x = 0; x < dw; x++) {
      const u = ((x + 0.5) * sw) / dw - 0.5;
      const i0 = Math.floor(u);
      const w = CubicUpsampler.kernel(u - i0);
      for (let k = 0; k < 4; k++) {
        this.taps[x * 4 + k] = (((i0 - 1 + k) % sw) + sw) % sw;
        this.weights[x * 4 + k] = w[k];
      }
    }
    this.line = new Float32Array(sw);
  }

  static kernel(t) {
    const t2 = t * t, t3 = t2 * t;
    return [(-t3 + 2 * t2 - t) / 2, (3 * t3 - 5 * t2 + 2) / 2, (-3 * t3 + 4 * t2 + t) / 2, (t3 - t2) / 2];
  }

  /** Destination row `y` into `out` (Float32Array of dw), in the source's
   *  units, unclamped. */
  row(y, out) {
    const { src, sw, sh, line } = this;
    const v = ((y + 0.5) * sh) / this.dh - 0.5;
    const r0 = Math.floor(v);
    const wv = CubicUpsampler.kernel(v - r0);
    line.fill(0);
    for (let k = 0; k < 4; k++) {
      const r = Math.min(sh - 1, Math.max(0, r0 - 1 + k));
      const o = r * sw, wk = wv[k];
      for (let j = 0; j < sw; j++) line[j] += src[o + j] * wk;
    }
    const { taps, weights } = this;
    for (let x = 0, t = 0; x < this.dw; x++, t += 4) {
      out[x] = line[taps[t]] * weights[t] + line[taps[t + 1]] * weights[t + 1]
        + line[taps[t + 2]] * weights[t + 2] + line[taps[t + 3]] * weights[t + 3];
    }
    return out;
  }
}

/** Cos-latitude-weighted Pearson correlation of two grids over the rows
 *  `rowOk` admits (and the cells `cellOk` admits), with `b` read shifted by
 *  (dx, dy) cells, dx wrapping across the seam. */
function correlation(a, b, w, h, { dx = 0, dy = 0, rowOk = () => true, cellOk = null } = {}) {
  let sw = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let i = 0; i < h; i++) {
    if (!rowOk(i)) continue;
    const ib = i + dy;
    if (ib < 0 || ib >= h) continue;
    const wt = cosLat(i, h);
    for (let j = 0; j < w; j++) {
      const k = i * w + j;
      if (cellOk && !cellOk(k)) continue;
      const x = a[k], y = b[ib * w + ((((j + dx) % w) + w) % w)];
      sw += wt; sa += wt * x; sb += wt * y; saa += wt * x * x; sbb += wt * y * y; sab += wt * x * y;
    }
  }
  const ma = sa / sw, mb = sb / sw;
  return (sab / sw - ma * mb) / Math.sqrt((saa / sw - ma * ma) * (sbb / sw - mb * mb));
}

// ---------------------------------------------------------------------------
// Alpha statistics through the app's coverage curve.

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
/** Alpha per byte value, in the two readings of "stored" (see COVERAGE_LOW). */
const ALPHA_OF_BYTE = {
  stored: Float64Array.from({ length: 256 }, (_, v) => smoothstep(COVERAGE_LOW, COVERAGE_HIGH, v / 255)),
  recovered: Float64Array.from({ length: 256 }, (_, v) => smoothstep(COVERAGE_LOW, COVERAGE_HIGH, Math.pow(srgbToLinear(v / 255), 1 / RECOVERY_GAMMA))),
};

/** A cos(latitude)-weighted histogram of a grid's values rounded to bytes, as
 *  a stored 8-bit rung would hold them. */
function weightedHistogram(grid, w, h, cellOk = null) {
  const hist = new Float64Array(256);
  for (let i = 0; i < h; i++) {
    const wt = cosLat(i, h);
    for (let j = 0; j < w; j++) {
      if (cellOk && !cellOk(i * w + j)) continue;
      hist[Math.min(255, Math.max(0, Math.round(grid[i * w + j])))] += wt;
    }
  }
  return hist;
}

/** The share drawn as clear (alpha exactly 0), as opaque (exactly 1) and the
 *  mean alpha, by area, in both readings. */
function alphaStats(hist) {
  const out = {};
  for (const [reading, alpha] of Object.entries(ALPHA_OF_BYTE)) {
    let sw = 0, clear = 0, opaque = 0, mean = 0;
    for (let v = 0; v < 256; v++) {
      sw += hist[v];
      if (alpha[v] === 0) clear += hist[v];
      if (alpha[v] === 1) opaque += hist[v];
      mean += hist[v] * alpha[v];
    }
    out[reading] = { clear: clear / sw, opaque: opaque / sw, meanAlpha: mean / sw };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pass 1: assemble W|E into the master on disk, measuring as it goes.

/**
 * Dropouts. The hemispheres carry single dark texels inside bright cloud —
 * values from 0 to a few dozen where every neighbour is well over a hundred,
 * strung along swath edges — that NASA's own 8K composite averages away and
 * the master would draw as pinholes of clear sky. A texel is one when it is
 * under half of its second-darkest neighbour and that neighbour holds cloud
 * (PIT_FLANK and up): at 0.93 km a real clear hole that small, darker than
 * all its neighbours but one by a factor of two, is not a thing clouds do,
 * while a pair of dropouts side by side still qualifies. It takes the mean of
 * its six brightest neighbours. The test reads the hemispheres as they are,
 * never a repaired value, so the result does not depend on the scan order.
 */
const PIT_FLANK = 32;

function repairRow(up, row, down, out) {
  out.set(row);
  if (!up || !down) return 0;
  const nb = new Int32Array(8);
  let repaired = 0;
  for (let x = 0; x < MW; x++) {
    const v = row[x];
    if (v >= 128) continue;
    const xl = x === 0 ? MW - 1 : x - 1, xr = x === MW - 1 ? 0 : x + 1;
    nb[0] = row[xl]; nb[1] = row[xr]; nb[2] = up[xl]; nb[3] = up[x]; nb[4] = up[xr]; nb[5] = down[xl]; nb[6] = down[x]; nb[7] = down[xr];
    // Two neighbours at or under twice the texel and it is not a pit; most
    // texels leave on the first two.
    let dark = 0;
    for (let i = 0; i < 8 && dark < 2; i++) if (nb[i] <= 2 * v) dark++;
    if (dark >= 2) continue;
    nb.sort();
    if (nb[1] < PIT_FLANK) continue;
    out[x] = Math.round((nb[2] + nb[3] + nb[4] + nb[5] + nb[6] + nb[7]) / 6);
    repaired++;
  }
  return repaired;
}

async function assemble(partialPath) {
  const fd = await open(partialPath, 'w');
  const avg = new AreaAverage(MW, MH, W8, H8, { max: true });
  const rowNonZero = new Uint32Array(MH);
  const out = new Uint8Array(MW * BAND);
  const decode = async (y0) => {
    const [west, east] = await Promise.all([hemisphereBand(SRC.west, y0, BAND), hemisphereBand(SRC.east, y0, BAND)]);
    const band = new Uint8Array(MW * BAND);
    for (let k = 0; k < BAND; k++) {
      band.set(west.subarray(k * HW, (k + 1) * HW), k * MW);
      band.set(east.subarray(k * HW, (k + 1) * HW), k * MW + HW);
    }
    return band;
  };
  let pending = decode(0);
  let above = null;
  let pits = 0;
  try {
    for (let y0 = 0; y0 < MH; y0 += BAND) {
      const band = await pending;
      // The next band decodes while this one is processed; its first row is
      // the halo this band's last row is repaired against.
      pending = y0 + BAND < MH ? decode(y0 + BAND) : null;
      for (let k = 0; k < BAND; k++) {
        const y = y0 + k;
        const row = band.subarray(k * MW, (k + 1) * MW);
        const up = k > 0 ? band.subarray((k - 1) * MW, k * MW) : above;
        const down = k < BAND - 1 ? band.subarray((k + 1) * MW, (k + 2) * MW) : (pending ? (await pending).subarray(0, MW) : null);
        const fixed = out.subarray(k * MW, (k + 1) * MW);
        pits += repairRow(up, row, down, fixed);
        let n = 0;
        for (let x = 0; x < MW; x++) if (row[x]) n++;
        rowNonZero[y] = n;
        avg.addRow(y, fixed);
      }
      above = band.slice((BAND - 1) * MW);
      await fd.write(out, 0, out.length, y0 * MW);
      // The decoded bands are garbage now; collecting them here keeps the
      // process near its live set instead of a dozen bands above it (with
      // --expose-gc, which the npm script passes).
      globalThis.gc?.();
      log(`assemble: rows ${y0}..${y0 + BAND - 1} of ${MH} (${pits} dropouts repaired so far)`);
    }
  } finally {
    await fd.close();
  }
  return { mean8: avg.finish(), max8: avg.max, rowNonZero, pits };
}

// ---------------------------------------------------------------------------
// The longitude origin, by correlation against the shipped sheet.

function checkOrigin(mean8, shipped8) {
  const m2 = boxDown(mean8, W8, H8, 4), s2 = boxDown(shipped8, W8, H8, 4);
  const w2 = W8 / 4, h2 = H8 / 4;
  const rowOk = (i) => Math.abs(latOfRow(i, h2)) <= SHIFT_LAT;
  const r0 = correlation(m2, s2, w2, h2, { rowOk });
  const rHalf = correlation(m2, s2, w2, h2, { rowOk, dx: w2 / 2 });
  let best = { dx: 0, dy: 0, r: -Infinity };
  for (let dy = -SHIFT_SEARCH; dy <= SHIFT_SEARCH; dy++) {
    for (let dx = -SHIFT_SEARCH; dx <= SHIFT_SEARCH; dx++) {
      const r = correlation(m2, s2, w2, h2, { rowOk, dx, dy });
      if (r > best.r) best = { dx, dy, r };
    }
  }
  // The same search at the 8K grid, two texels either way: the grade below
  // compares cell for cell there, so a sub-2K offset would show up in it.
  const rowOk8 = (i) => Math.abs(latOfRow(i, H8)) <= SHIFT_LAT;
  let best8 = { dx: 0, dy: 0, r: -Infinity };
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const r = correlation(mean8, shipped8, W8, H8, { rowOk: rowOk8, dx, dy });
      if (r > best8.r) best8 = { dx, dy, r };
    }
  }
  return { grid2k: { r0, rHalfTurn: rHalf, best }, grid8k: { best: best8 }, latitudes: `|lat| <= ${SHIFT_LAT}`, weights: 'cos(latitude)' };
}

// ---------------------------------------------------------------------------
// Where the hemispheres' data ends, from the row sums.

function dataEdges(rowNonZero) {
  const frac = (y) => rowNonZero[y] / MW;
  const rowAt = (lat) => Math.round(((90 - lat) / 180) * MH);
  const median = (lo, hi) => {
    const v = [];
    for (let y = Math.min(rowAt(lo), rowAt(hi)); y < Math.max(rowAt(lo), rowAt(hi)); y++) v.push(frac(y));
    v.sort((p, q) => p - q);
    return v[v.length >> 1];
  };
  const edge = (north) => {
    const ref = north ? median(40, 50) : median(-50, -40);
    const step = north ? -1 : 1;
    let start = null, half = null;
    for (let y = north ? rowAt(45) : rowAt(-45); north ? y >= 0 : y < MH; y += step) {
      if (start === null && frac(y) < 0.9 * ref) start = y;
      if (half === null && frac(y) < 0.5 * ref) half = y;
    }
    let last = null;
    for (let y = north ? 0 : MH - 1; north ? y < MH : y >= 0; y -= step) if (rowNonZero[y] > 0) { last = y; break; }
    const lat = (r) => (r === null ? null : +latOfRow(r, MH).toFixed(3));
    return {
      referenceCoverage: +ref.toFixed(4),
      below90pctOfReferenceFrom: lat(start),
      below50pctOfReferenceFrom: lat(half),
      lastRowWithAnyData: lat(last),
    };
  };
  return {
    north: edge(true),
    south: edge(false),
    rule: 'row share of non-zero texels against its median over 40..50 degrees; clear sky is zero too, so the first two read the ragged edge, not a line',
  };
}

// ---------------------------------------------------------------------------
// The infrared layer, per 8K cell.

/** The 8K cells with no master data in their 3x3 neighbourhood where the
 *  composite draws cloud, grouped into connected pieces (wrapping in
 *  longitude) on a 4x-coarser grid, largest first. */
function noDataRegions(max8, composite8) {
  const w = W8 / 4, h = H8 / 4;
  const z = new Uint8Array(w * h);
  let cells = 0, area = 0, total = 0;
  for (let i = 0; i < H8; i++) {
    const wt = cosLat(i, H8);
    for (let j = 0; j < W8; j++) {
      total += wt;
      if (composite8[i * W8 + j] <= NO_DATA_CODE) continue;
      let empty = true;
      for (let di = -1; di <= 1 && empty; di++) {
        const ii = i + di;
        if (ii < 0 || ii >= H8) continue;
        for (let dj = -1; dj <= 1; dj++) if (max8[ii * W8 + (((j + dj) % W8) + W8) % W8]) { empty = false; break; }
      }
      if (empty) { cells++; area += wt; z[((i / 4) | 0) * w + ((j / 4) | 0)] = 1; }
    }
  }
  const seen = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  const regions = [];
  const cellKm2 = (i) => (40030 / w) * (20015 / h) * cosLat(i, h);
  for (let start = 0; start < z.length; start++) {
    if (!z[start] || seen[start]) continue;
    let head = 0, tail = 0, km2 = 0, latMin = 90, latMax = -90, sx = 0, sy = 0;
    queue[tail++] = start; seen[start] = 1;
    while (head < tail) {
      const k = queue[head++];
      const i = (k / w) | 0, j = k - i * w;
      const a = cellKm2(i), lat = latOfRow(i, h), lon = -180 + (360 * (j + 0.5)) / w;
      km2 += a; latMin = Math.min(latMin, lat); latMax = Math.max(latMax, lat);
      sx += a * Math.cos((lon * Math.PI) / 180); sy += a * Math.sin((lon * Math.PI) / 180);
      for (const n of [i * w + ((j + 1) % w), i * w + ((j - 1 + w) % w), i > 0 ? k - w : -1, i < h - 1 ? k + w : -1]) {
        if (n >= 0 && z[n] && !seen[n]) { seen[n] = 1; queue[tail++] = n; }
      }
    }
    regions.push({ areaKm2: Math.round(km2), latRange: [+latMin.toFixed(1), +latMax.toFixed(1)], meanLon: +((Math.atan2(sy, sx) * 180) / Math.PI).toFixed(1) });
  }
  regions.sort((p, q) => q.areaKm2 - p.areaKm2);
  return {
    rule: `composite > ${NO_DATA_CODE} with no master texel above zero in the 3x3 neighbourhood of 8192x4096 cells`,
    cells,
    areaFraction: +(area / total).toFixed(5),
    equatorwardMostLatitude: regions.length ? Math.min(...regions.map((r) => Math.min(Math.abs(r.latRange[0]), Math.abs(r.latRange[1])))) : null,
    pieces: regions.length,
    largest: regions.slice(0, 15),
  };
}

/**
 * V per 8K cell from the screen blend composite = V + mean x (1 - V): exact
 * for the cell mean whatever the texels inside it hold, because the blend is
 * linear in the visible value. Held as 16-bit (V x 65535) to keep the grid at
 * 67 MB. Also measures the scale the composite and the hemispheres share,
 * which is why no gain is applied.
 */
function infraredLayer(mean8, composite8) {
  const V = new Uint16Array(W8 * H8);
  const bands = {};
  let saturated = 0;
  for (let i = 0; i < H8; i++) {
    const lat = latOfRow(i, H8), g = irGate(lat), wt = cosLat(i, H8);
    const key = `${Math.floor(lat / 5) * 5}..${Math.floor(lat / 5) * 5 + 5}`;
    const b = (bands[key] ??= { area: 0, v: 0, lift: 0 });
    for (let j = 0; j < W8; j++) {
      const k = i * W8 + j;
      b.area += wt;
      if (g === 0) continue;
      const m = mean8[k] / 255, c = composite8[k] / 255;
      let v = 0;
      if (m < 0.999) v = Math.min(1, Math.max(0, (c - m) / (1 - m)));
      else saturated++;
      v *= g;
      V[k] = Math.round(v * 65535);
      b.v += wt * v * 255;
      b.lift += wt * v * (1 - m) * 255;
    }
  }
  // The shared scale, where both hold the same visible data and no infrared.
  let sw = 0, sm = 0, sc = 0, smm = 0, smc = 0;
  for (let i = 0; i < H8; i++) {
    const lat = Math.abs(latOfRow(i, H8));
    if (lat < 30 || lat > 48) continue;
    const wt = cosLat(i, H8);
    for (let j = 0; j < W8; j++) {
      const k = i * W8 + j, m = mean8[k], c = composite8[k];
      sw += wt; sm += wt * m; sc += wt * c; smm += wt * m * m; smc += wt * m * c;
    }
  }
  const slope = (smc / sw - (sm / sw) * (sc / sw)) / (smm / sw - (sm / sw) ** 2);
  const byBand = Object.fromEntries(Object.entries(bands)
    .sort((p, q) => parseFloat(q[0]) - parseFloat(p[0]))
    .filter(([, v]) => v.v > 0)
    .map(([k, v]) => [k, { meanLayerCode: +(v.v / v.area).toFixed(2), meanLiftCode: +(v.lift / v.area).toFixed(2) }]));
  return {
    V,
    report: {
      model: 'composite = V + visible x (1 - V) per 8192x4096 cell, V cubic-upsampled to every texel',
      gateLatitudes: IR_GATE,
      saturatedCells: saturated,
      byLatitudeBand: byBand,
      sharedScale: { meanRatio: sc / sm, slope, latitudes: '30..48 both hemispheres', applied: 'none (1.0)' },
    },
  };
}

// ---------------------------------------------------------------------------
// Where the shipped sheet is NASA's sky, and the grade.

/** Per block, the correlation between NASA's composite and the shipped sheet:
 *  the shipped sheet is a re-grade of the composite over most of the globe
 *  and a different sky over some land, which a tone curve cannot reach. */
function sameSkyBlocks(composite8, shipped8) {
  // 5 degrees is not a whole number of 8K cells, so a cell belongs to the
  // block its index falls in, and blocks differ by a cell in width.
  const cols = 360 / SAME_SKY_BLOCK_DEG, rows = 180 / SAME_SKY_BLOCK_DEG;
  const colStart = (bj) => Math.round((bj * W8) / cols), rowStart = (bi) => Math.round((bi * H8) / rows);
  const r = new Float32Array(cols * rows);
  let area = 0, below95 = 0, below90 = 0;
  const worst = [];
  for (let bi = 0; bi < rows; bi++) {
    for (let bj = 0; bj < cols; bj++) {
      let sw = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
      for (let i = rowStart(bi); i < rowStart(bi + 1); i++) {
        const wt = cosLat(i, H8);
        for (let j = colStart(bj); j < colStart(bj + 1); j++) {
          const k = i * W8 + j, x = composite8[k], y = shipped8[k];
          sw += wt; sa += wt * x; sb += wt * y; saa += wt * x * x; sbb += wt * y * y; sab += wt * x * y;
        }
      }
      const va = saa / sw - (sa / sw) ** 2, vb = sbb / sw - (sb / sw) ** 2;
      // A block with no variance on either side (a uniform polar cap) is the
      // same sky by any reading that matters here.
      const rr = va < 1 || vb < 1 ? 1 : (sab / sw - (sa / sw) * (sb / sw)) / Math.sqrt(va * vb);
      r[bi * cols + bj] = rr;
      area += sw;
      if (rr < SAME_SKY_R) below95 += sw;
      if (rr < 0.9) below90 += sw;
      worst.push({ r: +rr.toFixed(3), lat: 90 - (bi + 0.5) * SAME_SKY_BLOCK_DEG, lon: -180 + (bj + 0.5) * SAME_SKY_BLOCK_DEG });
    }
  }
  worst.sort((p, q) => p.r - q.r);
  const blockRow = new Int32Array(H8), blockCol = new Int32Array(W8);
  for (let bi = 0; bi < rows; bi++) for (let i = rowStart(bi); i < rowStart(bi + 1); i++) blockRow[i] = bi;
  for (let bj = 0; bj < cols; bj++) for (let j = colStart(bj); j < colStart(bj + 1); j++) blockCol[j] = bj;
  const blockOf = (k) => blockRow[(k / W8) | 0] * cols + blockCol[k % W8];
  return {
    sameSky: (k) => r[blockOf(k)] >= SAME_SKY_R,
    report: {
      blockDeg: SAME_SKY_BLOCK_DEG,
      threshold: SAME_SKY_R,
      areaBelowThreshold: +(below95 / area).toFixed(4),
      areaBelow090: +(below90 / area).toFixed(4),
      worstBlocks: worst.slice(0, 15),
    },
  };
}

function nelderMead(f, x0, steps, { iterations = 2000, tolerance = 1e-14 } = {}) {
  const n = x0.length;
  let simplex = [x0.slice()];
  for (let i = 0; i < n; i++) { const p = x0.slice(); p[i] += steps[i]; simplex.push(p); }
  let values = simplex.map(f);
  for (let it = 0; it < iterations; it++) {
    const order = values.map((v, i) => i).sort((p, q) => values[p] - values[q]);
    simplex = order.map((i) => simplex[i]); values = order.map((i) => values[i]);
    if (Math.abs(values[n] - values[0]) <= tolerance * (Math.abs(values[0]) + 1e-30)) break;
    const centroid = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) centroid[k] += simplex[i][k] / n;
    const along = (t) => centroid.map((c, k) => c + t * (simplex[n][k] - c));
    const reflected = along(-1), fr = f(reflected);
    if (fr < values[0]) {
      const expanded = along(-2), fe = f(expanded);
      if (fe < fr) { simplex[n] = expanded; values[n] = fe; } else { simplex[n] = reflected; values[n] = fr; }
    } else if (fr < values[n - 1]) {
      simplex[n] = reflected; values[n] = fr;
    } else {
      const contracted = fr < values[n] ? along(-0.5) : along(0.5), fc = f(contracted);
      if (fc < Math.min(fr, values[n])) { simplex[n] = contracted; values[n] = fc; } else {
        for (let i = 1; i <= n; i++) { simplex[i] = simplex[i].map((v, k) => simplex[0][k] + 0.5 * (v - simplex[0][k])); values[i] = f(simplex[i]); }
      }
    }
  }
  const best = values.indexOf(Math.min(...values));
  return { x: simplex[best], value: values[best] };
}

const gradeOf = ({ a, g, b }) => (s) => Math.min(1, Math.max(0, a * Math.pow(Math.max(0, s), g) + b));

/** Fit stored' = clamp(a * stored^g + b) to the shipped sheet on the cells
 *  `cellOk` admits, cos(latitude)-weighted, least squares on stored values. */
function fitGrade(mean8, shipped8, cellOk, domain) {
  // Binned at an eighth of a code value: the objective is then a sum over
  // 2041 bins instead of millions of cells, at a quantisation far below the
  // residual.
  const BINS = 255 * 8 + 1;
  const W = new Float64Array(BINS), S1 = new Float64Array(BINS), S2 = new Float64Array(BINS);
  let sw = 0, sm = 0, ss = 0, smm = 0, sss = 0, sms = 0, cells = 0;
  for (let i = 0; i < H8; i++) {
    const wt = cosLat(i, H8);
    for (let j = 0; j < W8; j++) {
      const k = i * W8 + j;
      if (!cellOk(k)) continue;
      const m = mean8[k] / 255, s = shipped8[k] / 255;
      const bin = Math.round(mean8[k] * 8);
      W[bin] += wt; S1[bin] += wt * s; S2[bin] += wt * s * s;
      sw += wt; sm += wt * m; ss += wt * s; smm += wt * m * m; sss += wt * s * s; sms += wt * m * s;
      cells++;
    }
  }
  const objective = ([a, g, b]) => {
    if (!(g > 0.05 && g < 20)) return Infinity;
    const f = gradeOf({ a, g, b });
    let e = 0;
    for (let bin = 0; bin < BINS; bin++) {
      if (!W[bin]) continue;
      const y = f(bin / 8 / 255);
      e += W[bin] * y * y - 2 * y * S1[bin] + S2[bin];
    }
    return e;
  };
  // Start from the straight line through the cloud of points, then let the
  // exponent move; a few starts so a shallow valley does not trap it.
  const slope = (sms / sw - (sm / sw) * (ss / sw)) / (smm / sw - (sm / sw) ** 2);
  const intercept = ss / sw - slope * (sm / sw);
  let best = null;
  for (const g0 of [1, 0.8, 1.25]) {
    const r = nelderMead(objective, [slope, g0, intercept], [0.1, 0.1, 0.02]);
    if (!best || r.value < best.value) best = r;
  }
  const [a, g, b] = best.x;
  const f = gradeOf({ a, g, b });
  let fw = 0, ff = 0, fs = 0;
  for (let bin = 0; bin < BINS; bin++) {
    if (!W[bin]) continue;
    const y = f(bin / 8 / 255);
    fw += W[bin] * y; ff += W[bin] * y * y; fs += y * S1[bin];
  }
  const corr = (xy, x, y, xx, yy) => (xy / sw - (x / sw) * (y / sw)) / Math.sqrt((xx / sw - (x / sw) ** 2) * (yy / sw - (y / sw) ** 2));
  return {
    domain,
    a, g, b,
    rmsResidualCode: Math.sqrt(Math.max(0, best.value) / sw) * 255,
    rmsBeforeCode: Math.sqrt(Math.max(0, (smm - 2 * sms + sss) / sw)) * 255,
    correlationBefore: corr(sms, sm, ss, smm, sss),
    correlationModel: corr(fs, fw, ss, ff, sss),
    meanMasterCode: (sm / sw) * 255,
    meanShippedCode: (ss / sw) * 255,
    meanModelCode: (fw / sw) * 255,
    cells,
  };
}

// ---------------------------------------------------------------------------
// Pass 2: the infrared layer and the grade, in place, band by band.

async function layerAndGrade(partialPath, V, grade, into) {
  const fd = await open(partialPath, 'r+');
  const hash = createHash('sha256');
  const avg = new AreaAverage(MW, MH, W8, H8, { into });
  const nativeHist = new Float64Array(256);
  const rowHist = new Uint32Array(256);
  const band = new Uint8Array(MW * BAND);
  const upsampler = new CubicUpsampler(V, W8, H8, MW, MH);
  const vRow = new Float32Array(MW);
  // The grade as a table: 256 entries for untouched bytes, and a fine one with
  // linear interpolation for the screened values, which are not whole codes.
  const f = gradeOf(grade);
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) lut[v] = Math.round(255 * f(v / 255));
  const FINE = 4096;
  const fine = Float32Array.from({ length: FINE + 1 }, (_, i) => 255 * f(i / FINE));
  const graded = (s) => { const u = s * FINE, i = Math.min(FINE - 1, u | 0), t = u - i; return Math.round(fine[i] + (fine[i + 1] - fine[i]) * t); };
  const rowHasLayer = new Uint8Array(H8);
  for (let i = 0; i < H8; i++) for (let j = 0; j < W8; j++) if (V[i * W8 + j]) { rowHasLayer[i] = 1; break; }
  let layered = 0, liftedCodes = 0;
  // The joins against any other pair of neighbouring columns: a seam would
  // show as a join whose step is larger than the field's own.
  const seams = { rows: 0, greenwich: 0, dateline: 0, interior: 0 };
  const interiorColumns = Math.ceil((MW - 499) / 1000);
  try {
    for (let y0 = 0; y0 < MH; y0 += BAND) {
      await fd.read(band, 0, band.length, y0 * MW);
      for (let k = 0; k < BAND; k++) {
        const y = y0 + k;
        const row = band.subarray(k * MW, (k + 1) * MW);
        // The cubic reads four 8K rows around the texel's own.
        const vi = Math.floor((y + 0.5) / R8 - 0.5);
        let any = false;
        for (let r = vi - 1; r <= vi + 2; r++) if (r >= 0 && r < H8 && rowHasLayer[r]) any = true;
        if (any) {
          upsampler.row(y, vRow);
          for (let x = 0; x < MW; x++) {
            const v = Math.min(1, Math.max(0, vRow[x] / 65535));
            if (v === 0) { row[x] = lut[row[x]]; continue; }
            const m = row[x] / 255;
            const s = v + m * (1 - v);
            layered++; liftedCodes += (s - m) * 255;
            row[x] = graded(s);
          }
        } else {
          for (let x = 0; x < MW; x++) row[x] = lut[row[x]];
        }
        if (Math.abs(latOfRow(y, MH)) < IR_GATE[0]) {
          seams.rows++;
          seams.greenwich += Math.abs(row[HW] - row[HW - 1]);
          seams.dateline += Math.abs(row[0] - row[MW - 1]);
          for (let c = 499; c < MW; c += 1000) seams.interior += Math.abs(row[c] - row[c - 1]);
        }
        avg.addRow(y, row);
        rowHist.fill(0);
        for (let x = 0; x < MW; x++) rowHist[row[x]]++;
        const c = cosLat(y, MH);
        for (let b = 0; b < 256; b++) nativeHist[b] += rowHist[b] * c;
      }
      await fd.write(band, 0, band.length, y0 * MW);
      hash.update(band);
      globalThis.gc?.();
      log(`infrared + grade: rows ${y0}..${y0 + BAND - 1} of ${MH}`);
    }
  } finally {
    await fd.close();
  }
  const joins = {
    meanStepCode: {
      greenwich: seams.greenwich / seams.rows,
      dateline: seams.dateline / seams.rows,
      anyOtherColumnPair: seams.interior / (seams.rows * interiorColumns),
    },
    rows: `|lat| < ${IR_GATE[0]}`,
  };
  return { graded8: avg.finish(), nativeHist, sha256: hash.digest('hex'), layered, meanLiftCode: layered ? liftedCodes / layered : 0, joins };
}

// ---------------------------------------------------------------------------
// Pictures: the shipped sheet (cubic-upsampled) left, the master right.

async function readMasterBox(fd, x0, y0, w, h) {
  const out = new Uint8Array(w * h);
  const line = new Uint8Array(MW);
  for (let r = 0; r < h; r++) {
    await fd.read(line, 0, MW, (y0 + r) * MW);
    for (let c = 0; c < w; c++) out[r * w + c] = line[(((x0 + c) % MW) + MW) % MW];
  }
  return out;
}

function shippedBox(upsampler, x0, y0, w, h) {
  const out = new Uint8Array(w * h);
  const line = new Float32Array(MW);
  for (let r = 0; r < h; r++) {
    upsampler.row(y0 + r, line);
    for (let c = 0; c < w; c++) out[r * w + c] = Math.min(255, Math.max(0, Math.round(line[(((x0 + c) % MW) + MW) % MW])));
  }
  return out;
}

const escapeXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/'/g, '&apos;');
const labelSvg = (text, width) => Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="26"><rect width="100%" height="100%" fill="#000" fill-opacity="0.55"/>`
  + `<text x="8" y="18" font-family="Helvetica, Arial, sans-serif" font-size="15" fill="#ffd166">${escapeXml(text)}</text></svg>`);

async function pictures(shipped8) {
  await mkdir(PICTURES, { recursive: true });
  const fd = await open(OUT, 'r');
  const upsampler = new CubicUpsampler(shipped8, W8, H8, MW, MH);
  const written = [];
  try {
    for (const { name, box: [west, east, south, north], note } of PICTURE_BOXES) {
      const x0 = Math.round(((west + 180) / 360) * MW), x1 = Math.round(((east + 180) / 360) * MW);
      const y0 = Math.round(((90 - north) / 180) * MH), y1 = Math.round(((90 - south) / 180) * MH);
      const w = x1 - x0, h = y1 - y0;
      const left = shippedBox(upsampler, x0, y0, w, h);
      const right = await readMasterBox(fd, x0, y0, w, h);
      const gap = 6;
      const file = path.join(PICTURES, `${name}.jpg`);
      const range = `${west}..${east} lon, ${south}..${north} lat`;
      await sharp({ create: { width: 2 * w + gap, height: h, channels: 3, background: '#7a1f1f' } })
        .composite([
          { input: Buffer.from(left), raw: { width: w, height: h, channels: 1 }, left: 0, top: 0 },
          { input: Buffer.from(right), raw: { width: w, height: h, channels: 1 }, left: w + gap, top: 0 },
          { input: labelSvg(`shipped 8K, cubic · ${range}`, Math.min(w, 520)), left: 0, top: 0 },
          { input: labelSvg(`master 43200 · ${note}`, Math.min(w, 520)), left: w + gap, top: 0 },
        ])
        .jpeg({ quality: 90 })
        .toFile(file);
      written.push({ file, box: [west, east, south, north], pixelsPerSide: [w, h], note });
      log(`picture: ${path.basename(file)} (${w}x${h} a side)`);
    }
  } finally {
    await fd.close();
  }
  // The whole globe, area-averaged from the master on disk.
  const avg = new AreaAverage(MW, MH, GLOBE.width, GLOBE.height);
  const gfd = await open(OUT, 'r');
  const band = new Uint8Array(MW * BAND);
  try {
    for (let y0 = 0; y0 < MH; y0 += BAND) {
      await gfd.read(band, 0, band.length, y0 * MW);
      for (let k = 0; k < BAND; k++) avg.addRow(y0 + k, band.subarray(k * MW, (k + 1) * MW));
    }
  } finally {
    await gfd.close();
  }
  const globe = avg.finish();
  const bytes = new Uint8Array(globe.length);
  for (let i = 0; i < globe.length; i++) bytes[i] = Math.min(255, Math.round(globe[i]));
  const globeFile = path.join(PICTURES, 'globe-master-4096.jpg');
  await sharp(Buffer.from(bytes), { raw: { width: GLOBE.width, height: GLOBE.height, channels: 1 } }).jpeg({ quality: 90 }).toFile(globeFile);
  written.push({ file: globeFile, pixels: [GLOBE.width, GLOBE.height], note: 'the whole master, area-averaged' });
  log(`picture: ${path.basename(globeFile)}`);
  return written;
}

// ---------------------------------------------------------------------------

async function inputChecks() {
  const out = {};
  for (const [key, file] of Object.entries(SRC)) {
    if (!existsSync(file)) throw new Error(`missing input ${file}`);
    const m = await sharp(file, { limitInputPixels: false }).metadata();
    out[key] = { file, bytes: (await stat(file)).size, width: m.width, height: m.height, channels: m.channels, format: m.format };
  }
  const want = { west: [HW, HW], east: [HW, HW], composite: [W8, H8], shipped: [W8, H8] };
  for (const [key, [w, h]] of Object.entries(want)) {
    if (out[key].width !== w || out[key].height !== h) throw new Error(`${key}: ${out[key].width}x${out[key].height}, expected ${w}x${h}`);
  }
  if (!(BAND > 0 && MH % BAND === 0)) throw new Error(`--band=${BAND} must divide ${MH}`);
  if (!['same-sky', 'all'].includes(FIT_DOMAIN)) throw new Error(`--fit=${FIT_DOMAIN}: same-sky or all`);
  await Promise.all(Object.keys(out).map(async (key) => { out[key].sha256 = await sha256(out[key].file); }));
  return out;
}

function printPlan(inputs) {
  log('plan:');
  for (const [key, v] of Object.entries(inputs)) log(`  ${key.padEnd(9)} ${v.file}  ${v.width}x${v.height}x${v.channels} ${v.format}  ${(v.bytes / 1e6).toFixed(1)} MB  sha256 ${v.sha256}`);
  log(`  master    ${OUT}  (${MW}x${MH}, 1 byte a texel, ${(MW * MH / 1e6).toFixed(0)} MB)`);
  log(`  report    ${REPORT}`);
  log(`  pictures  ${flag('no-pictures') ? '(skipped)' : PICTURES}`);
  log(`  bands of ${BAND} rows; infrared gate ${IR_GATE.join('..')} deg; grade fitted on ${FIT_DOMAIN}`);
}

const pct = (x) => `${(x * 100).toFixed(2)} %`;
const fmtAlpha = (s) => `clear ${pct(s.clear)}, opaque ${pct(s.opaque)}, mean ${s.meanAlpha.toFixed(4)}`;

async function main() {
  const inputs = await inputChecks();
  printPlan(inputs);
  if (flag('dry-run')) { log('--dry-run: nothing written'); return; }

  if (flag('pictures-only')) {
    if (!existsSync(OUT)) throw new Error(`--pictures-only: no master at ${OUT}`);
    const shipped8 = (await loadGrey(SRC.shipped, 'shipped', [W8, H8])).grey;
    await pictures(shipped8);
    return;
  }

  await mkdir(path.dirname(OUT), { recursive: true });
  const partial = `${OUT}.partial`;
  await rm(partial, { force: true });

  // One at a time: each decode holds a 100 MB three-channel buffer briefly.
  const composite8 = (await loadGrey(SRC.composite, 'composite', [W8, H8])).grey;
  const shipped8 = (await loadGrey(SRC.shipped, 'shipped', [W8, H8])).grey;
  globalThis.gc?.();
  log('inputs loaded; assembling');
  const pass1 = await assemble(partial);

  const origin = checkOrigin(pass1.mean8, shipped8);
  log(`origin: r(0) = ${origin.grid2k.r0.toFixed(5)}, r(half turn) = ${origin.grid2k.rHalfTurn.toFixed(5)}, best 2K shift (${origin.grid2k.best.dx}, ${origin.grid2k.best.dy}) r = ${origin.grid2k.best.r.toFixed(5)}; best 8K shift (${origin.grid8k.best.dx}, ${origin.grid8k.best.dy})`);
  if (origin.grid2k.best.dx !== 0 || origin.grid2k.best.dy !== 0) {
    throw new Error(`longitude origin: the best 2K shift is (${origin.grid2k.best.dx}, ${origin.grid2k.best.dy}), not (0, 0) — the hemispheres are not where the shipped sheet says they are`);
  }

  const edges = dataEdges(pass1.rowNonZero);
  log(`data edges (row sums): north ${JSON.stringify(edges.north)}`);
  log(`data edges (row sums): south ${JSON.stringify(edges.south)}`);
  const noData = noDataRegions(pass1.max8, composite8);
  pass1.max8 = null;
  globalThis.gc?.();
  log(`no data where the composite draws cloud: ${pct(noData.areaFraction)} of the globe in ${noData.pieces} pieces, reaching ${noData.equatorwardMostLatitude} deg`);

  const ir = infraredLayer(pass1.mean8, composite8);
  log(`infrared layer: shared scale ${ir.report.sharedScale.meanRatio.toFixed(4)} (ratio of means), slope ${ir.report.sharedScale.slope.toFixed(4)}; ${JSON.stringify(ir.report.byLatitudeBand)}`);

  const blocks = sameSkyBlocks(composite8, shipped8);
  log(`shipped vs NASA composite: ${pct(blocks.report.areaBelowThreshold)} of the globe in ${SAME_SKY_BLOCK_DEG} deg blocks below r ${SAME_SKY_R} (${pct(blocks.report.areaBelow090)} below 0.9)`);

  const untouched = (k) => ir.V[k] === 0 && Math.abs(latOfRow((k / W8) | 0, H8)) < IR_GATE[0];
  const fits = {
    all: fitGrade(pass1.mean8, shipped8, untouched, `every cell equatorward of ${IR_GATE[0]} deg (no infrared layer)`),
    'same-sky': fitGrade(pass1.mean8, shipped8, (k) => untouched(k) && blocks.sameSky(k), `the same, in ${SAME_SKY_BLOCK_DEG} deg blocks where composite and shipped correlate >= ${SAME_SKY_R}`),
  };
  for (const [name, fit] of Object.entries(fits)) {
    log(`grade (${name}): a ${fit.a.toFixed(5)}, g ${fit.g.toFixed(5)}, b ${fit.b.toFixed(5)}; rms ${fit.rmsResidualCode.toFixed(2)} codes (before ${fit.rmsBeforeCode.toFixed(2)}); r ${fit.correlationBefore.toFixed(5)} -> ${fit.correlationModel.toFixed(5)}; ${fit.cells} cells`);
  }
  const grade = fits[FIT_DOMAIN];
  if (![grade.a, grade.g, grade.b, grade.rmsResidualCode].every(Number.isFinite) || grade.cells < 1e6) {
    throw new Error(`grade (${FIT_DOMAIN}) did not fit: ${JSON.stringify(grade)}`);
  }
  const rBeforeWholeGlobe = correlation(pass1.mean8, shipped8, W8, H8);

  // The 8K mean is spent; pass 2 accumulates the graded master into it.
  const pass2 = await layerAndGrade(partial, ir.V, grade, pass1.mean8);
  const graded8 = pass2.graded8;
  const domainOk = FIT_DOMAIN === 'all' ? untouched : (k) => untouched(k) && blocks.sameSky(k);
  const correlations = {
    fitDomainBefore: grade.correlationBefore,
    fitDomainAfter: correlation(graded8, shipped8, W8, H8, { cellOk: domainOk }),
    wholeGlobeBefore: rBeforeWholeGlobe,
    wholeGlobeAfter: correlation(graded8, shipped8, W8, H8),
    wholeGlobeAfterAgainstComposite: correlation(graded8, composite8, W8, H8),
    note: 'before = the assembled hemispheres at 8K; after = the finished master at 8K (infrared layer and grade); cos(latitude) weights',
  };
  log(`joins (mean step between neighbouring columns, codes): Greenwich ${pass2.joins.meanStepCode.greenwich.toFixed(3)}, dateline ${pass2.joins.meanStepCode.dateline.toFixed(3)}, any other pair ${pass2.joins.meanStepCode.anyOtherColumnPair.toFixed(3)}`);
  log(`correlation with the shipped sheet: fit domain ${correlations.fitDomainBefore.toFixed(5)} -> ${correlations.fitDomainAfter.toFixed(5)}; whole globe ${correlations.wholeGlobeBefore.toFixed(5)} -> ${correlations.wholeGlobeAfter.toFixed(5)} (against NASA's composite ${correlations.wholeGlobeAfterAgainstComposite.toFixed(5)})`);

  const alpha = {
    curve: `smoothstep(${COVERAGE_LOW}, ${COVERAGE_HIGH}, s), cos(latitude) area weights; "stored" s = byte / 255, "recovered" s = pow(srgbToLinear(byte / 255), 1 / ${RECOVERY_GAMMA}) as the shader reads it`,
    shipped8k: alphaStats(weightedHistogram(shipped8, W8, H8)),
    master8k: alphaStats(weightedHistogram(graded8, W8, H8)),
    masterNative: alphaStats(pass2.nativeHist),
    // Like for like: only where the shipped sheet is NASA's sky (5 degree
    // blocks), so the content the shipped sheet carries and NASA's does not
    // is not counted as a change of grade.
    shipped8kSameSky: alphaStats(weightedHistogram(shipped8, W8, H8, blocks.sameSky)),
    master8kSameSky: alphaStats(weightedHistogram(graded8, W8, H8, blocks.sameSky)),
    appHeaderQuote: { clear: 0.217, opaque: 0.059, meanAlpha: 0.25, of: 'the shipped 2K rung, per src/planetarium/world/cloudDeck.ts' },
  };
  if (existsSync(SHIPPED_2K)) {
    const r2 = await loadGrey(SHIPPED_2K, 'shipped 2K rung');
    alpha.shipped2kRung = { file: SHIPPED_2K, ...alphaStats(weightedHistogram(r2.grey, r2.width, r2.height)) };
  }
  for (const [name, s] of Object.entries(alpha)) {
    if (s && s.stored) log(`alpha ${name.padEnd(17)} stored: ${fmtAlpha(s.stored)} | recovered: ${fmtAlpha(s.recovered)}`);
  }

  await rename(partial, OUT);
  const report = {
    tool: 'tools/gen-cloudmaster.mjs',
    written: new Date().toISOString(),
    output: { file: OUT, width: MW, height: MH, format: 'r8: one byte a texel, row 0 = +90 latitude, column 0 = -180 longitude, no header', bytes: MW * MH, sha256: pass2.sha256 },
    options: { cache: CACHE, out: OUT, pictures: flag('no-pictures') ? null : PICTURES, fit: FIT_DOMAIN, bandRows: BAND, infraredGate: IR_GATE, noDataCode: NO_DATA_CODE, shiftSearch: SHIFT_SEARCH, shiftLatitudes: SHIFT_LAT, sameSkyBlockDeg: SAME_SKY_BLOCK_DEG, sameSkyR: SAME_SKY_R },
    inputs,
    origin,
    dataEdges: edges,
    dropouts: { repaired: pass1.pits, perMillion: +((pass1.pits / (MW * MH)) * 1e6).toFixed(1), rule: `under half of the second-darkest of its 8 neighbours, that neighbour at least ${PIT_FLANK}; filled with the mean of the six brightest` },
    noData,
    infrared: { ...ir.report, texelsLayered: pass2.layered, meanLiftCodeOnLayeredTexels: pass2.meanLiftCode },
    shippedVsComposite: blocks.report,
    grade: { applied: FIT_DOMAIN, ...grade, alternatives: fits },
    correlations,
    joins: pass2.joins,
    alpha,
  };
  if (!flag('no-pictures')) report.pictures = await pictures(shipped8);
  report.wallSeconds = (Date.now() - t0) / 1000;
  report.peakRssMB = Math.round(Math.max(peakRss, process.memoryUsage().rss) / 1e6);
  await writeFile(REPORT, JSON.stringify(report, null, 2) + '\n');
  log(`wrote ${OUT}`);
  log(`wrote ${REPORT}`);
  log(`done in ${elapsed()}, peak resident ${report.peakRssMB} MB (sampled at each log line)`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
