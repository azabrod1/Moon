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
// before anything is measured. The shipped sheet had painted out more than
// that, and the RETOUCH does the same on the assembled field, each step its
// own pass and its own flag (--retouch), all before the infrared layer is
// solved and the grade fitted, so both see the repaired field:
//  - lines: straight scan lines of no data one or two texels wide inside
//    cloud (central Italy, the Atlantic at 52 N), filled across;
//  - rim: near the poles, the hard-edged holes NASA's missing data leaves
//    among the swaths (marked 0 to 2 inside cloud of 150 and more), which the
//    infrared layer turns into grey patches, filled from their edges with a
//    feather of a fifth of a degree;
//  - dateline: the seam at 180 degrees where NASA's daily passes either side
//    of the day boundary saw the clouds hours apart (its 8K composite has it
//    too), in four stretches the worst of them from 7 N to 17 S, replaced by a
//    multi-band join along a wandering boundary, with nothing duplicated;
//  - steps: swath edges across which one pass is brighter than the other,
//    measured and listed, not repaired.
// Each is described where it is defined; the report carries what each did
// and where, and the pictures show it before and after.
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
// Which is why the shipped sheet is NOT what the app should keep drawing: over
// about 18 % of the globe (central United States, the Gulf, the Drake
// Passage, the North Atlantic, the Amazon) it is not NASA's sky, so tiles cut
// from this master would not be a sharpen of it there. The direction taken is
// to cut the whole cloud ladder — the 2K, 4K and 8K rungs as well as the
// tiles — from this one master, and to judge the changed far view by eye.
//
// Memory stays bounded: the full raster is 933 MB and is never held. The
// hemispheres are decoded in row bands (sharp re-reads a PNG from the top for
// each band, which is cheap next to holding it), the master is written to disk
// a band at a time and processed in place (the banded retouch steps through a
// scratch file, each band read with the rows either side it needs), and
// everything global — the longitude check, the infrared layer, the fit, the
// statistics — runs on 8192x4096 area averages accumulated as the bands go
// past. A whole run takes about five minutes on an M5 Max, most of it the
// line search.
//
// Output: one byte a texel, row 0 = +90 latitude, column 0 = -180 longitude,
// no header (`<name>.43200x21600.r8`), plus a JSON report beside it, a page
// of side-by-side pictures (shipped sheet left, master right, same region at
// the master's texel) and, in retouch/ under it, the retouch before and after
// (against a master built with --retouch=none, kept as <name>.noretouch.r8).
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
//   --retouch=<steps> the retouch steps, comma-separated: lines, rim, dateline,
//                     steps (the last only measures); default all four, none
//                     for the master as NASA's hemispheres hold it
//   --compare=<file>  a master built without the retouch, for the before/after
//                     pictures (default <out>.noretouch.r8 beside it, if there)
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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
  --retouch=<steps> lines,rim,dateline,steps (default all; none to skip)
  --compare=<file>  the no-retouch master the retouch pictures compare against
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
const RETOUCH = opt('retouch', 'lines,rim,dateline,steps') === 'none' ? [] : opt('retouch', 'lines,rim,dateline,steps').split(',').map((v) => v.trim()).filter(Boolean);
const COMPARE = path.resolve(opt('compare', OUT.replace(/\.r8$/, '') + '.noretouch.r8'));

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

/** The step across a join column (between `c - 1` and `c`, wrapping) on one
 *  row, and the mean step of the eight column pairs around it: a seam is a
 *  join whose step stands out from its neighbours'. */
function joinStepAt(row, c) {
  const at = (x) => row[((x % MW) + MW) % MW];
  let ctl = 0;
  for (const o of [-8, -6, -4, -2, 2, 4, 6, 8]) ctl += Math.abs(at(c + o) - at(c + o - 1));
  return [Math.abs(at(c) - at(c - 1)), ctl / 8];
}

async function assemble(partialPath) {
  const fd = await open(partialPath, 'w');
  const avg = new AreaAverage(MW, MH, W8, H8, { max: true });
  const rowNonZero = new Uint32Array(MH);
  // Per row, the step across each hemisphere join and its neighbours' (the
  // dateline feather's gate is read from these).
  const joins = { dateline: new Float32Array(MH), datelineCtl: new Float32Array(MH), greenwich: new Float32Array(MH), greenwichCtl: new Float32Array(MH) };
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
        [joins.dateline[y], joins.datelineCtl[y]] = joinStepAt(fixed, 0);
        [joins.greenwich[y], joins.greenwichCtl[y]] = joinStepAt(fixed, HW);
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
  return { mean8: avg.finish(), max8: avg.max, rowNonZero, pits, joins };
}

// ---------------------------------------------------------------------------
// Retouch: the flaws NASA's hemispheres carry that the shipped sheet had
// painted out, repaired on the assembled visible field (after the dropouts,
// before the infrared layer is solved and the grade is fitted, so both see
// the repaired field). Each step is its own pass and its own flag.

/**
 * One streaming pass over a master-shaped file: each band of BAND rows is
 * read with `halo` rows either side (clamped at the poles), `fn(src, dst,
 * band)` writes the band's core rows into `dst` (pre-filled with them), and
 * the core is written to `outPath`. `src` row 0 is master row `band.top`.
 */
async function bandedPass(inPath, outPath, halo, fn, label) {
  const fin = await open(inPath, 'r');
  const fout = await open(outPath, 'w');
  const src = new Uint8Array(MW * (BAND + 2 * halo));
  const dst = new Uint8Array(MW * BAND);
  try {
    for (let y0 = 0; y0 < MH; y0 += BAND) {
      const top = Math.max(0, y0 - halo), bottom = Math.min(MH, y0 + BAND + halo);
      const rows = bottom - top;
      await fin.read(src, 0, rows * MW, top * MW);
      dst.set(src.subarray((y0 - top) * MW, (y0 - top + BAND) * MW));
      fn(src, dst, { top, rows, core: y0, coreOffset: y0 - top });
      await fout.write(dst, 0, dst.length, y0 * MW);
      globalThis.gc?.();
      if ((y0 / BAND) % 5 === 4 || y0 + BAND >= MH) log(`${label}: rows ${y0 + BAND} of ${MH}`);
    }
  } finally {
    await fin.close();
    await fout.close();
  }
}

/** A box blur of radius r, `passes` times each way, averaging (so values keep
 *  their range), edges clamped, in place on a w x h Float32Array. Three
 *  passes of a box are within a few per cent of a Gaussian. */
function boxBlur(a, w, h, r, passes, tmp) {
  const n = 2 * r + 1, line = new Float32Array(Math.max(w, h));
  const along = (src, dst, off, len, stride) => {
    for (let i = 0; i < len; i++) line[i] = src[off + i * stride];
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += line[Math.min(len - 1, Math.max(0, i))];
    for (let i = 0; i < len; i++) {
      dst[off + i * stride] = acc / n;
      acc += line[Math.min(len - 1, i + r + 1)] - line[Math.max(0, i - r)];
    }
  };
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) along(a, tmp, y * w, w, 1);
    for (let x = 0; x < w; x++) along(tmp, a, x, h, w);
  }
}

// --- 1. Thin dark lines ------------------------------------------------------
//
// Some swath edges carry a straight line one or two texels wide that is far
// darker than the cloud either side of it — a scan line of no data, zero in
// the hemispheres, which the shipped sheet's 8K average had smoothed away and
// the master draws as a hairline (central Italy; the Atlantic at 52 N). A
// texel is a CANDIDATE in one of four directions when it holds NASA's no-data
// value (LINE.valueMax or less — every line in a spread sample of the first
// runs was exactly 0, while the two kinds of false line found, a dark lane
// between cirrus streaks and a lake shore, were not) and, across it (two,
// three or four texels out on both sides, whichever is clearest, so a line up
// to four thick where its stair steps overlap qualifies),
// both sides hold cloud (LINE.sideMin and up) and the texel is under half of
// the darker side and LINE.contrastMin codes below it. A real gap between
// clouds passes that too, and so does every dark speck of a speckled haze;
// what neither does is run dead straight ALONE. Candidates become a LINE only
// where (a Hough transform per 128-texel tile, tiles every 64 texels on a grid
// fixed to the globe so every band decides a tile the same way; each peak's
// line then fitted to its candidates by least squares):
//  - at least LINE.coverage of the positions along LINE.minLength texels or
//    more hold a candidate within LINE.tolerance of the fitted line, with no
//    gap over LINE.maxGap, and
//  - the texels three and four out either side of the line are candidates at
//    no more than LINE.neighbourMax of those positions: a line is the one dark
//    thing in its neighbourhood, where a speckled field is dark everywhere and
//    a straight band through it collects candidates by chance.
// Once a line is confirmed, every candidate within LINE.fillBand of it along
// its run is filled, so a line two texels thick goes whole. A line texel takes
// the mean of the two sides it was measured against.
const LINE = { valueMax: 2, sideMin: 4, darkRatio: 0.5, contrastMin: 4, minLength: 64, coverage: 0.85, maxGap: 2, tolerance: 0.6, fillBand: 2, neighbourMax: 0.25, tile: 128, step: 64, halfRange: 22, thetaStep: 1 };
// The four directions, each with the normal its sides are read along and the
// direction (degrees from east, rows growing south) its lines run in.
const LINE_CLASSES = [
  { nx: 0, ny: 1, dir: 0 },
  { nx: 1, ny: 0, dir: 90 },
  { nx: 1, ny: 1, dir: -45 },
  { nx: 1, ny: -1, dir: 45 },
];

export function retouchLines(src, dst, band, stats) {
  const { rows, coreOffset } = band;
  const N = rows * MW;
  // Candidate bits per class (bit c), and for the fill the side distance (2,
  // 3 or 4) that won, per class, in two bits each.
  const bits = new Uint8Array(N);
  const kbits = new Uint8Array(N);
  const at = (y, x) => src[y * MW + (((x % MW) + MW) % MW)];
  // Per 64-texel block of the globe-fixed grid, candidates per class, so a
  // tile with too few is skipped without being scanned.
  const S = LINE.step, bw = MW / S, bh = Math.ceil(rows / S) + 1;
  const blockCount = new Uint32Array(4 * bw * bh);
  const blockRow0 = Math.floor(band.top / S) * S; // global row of block row 0
  const off2 = LINE_CLASSES.map(({ nx, ny }) => 2 * ny * MW + 2 * nx);
  const off3 = LINE_CLASSES.map(({ nx, ny }) => 3 * ny * MW + 3 * nx);
  const off4 = LINE_CLASSES.map(({ nx, ny }) => 4 * ny * MW + 4 * nx);
  for (let y = 4; y < rows - 4; y++) {
    const o = y * MW, brow = ((band.top + y - blockRow0) / S) | 0;
    for (let x = 0; x < MW; x++) {
      const i = o + x, v = src[i];
      if (v > LINE.valueMax) continue;
      let b = 0, kb = 0;
      const inside = x >= 4 && x < MW - 4;
      for (let c = 0; c < 4; c++) {
        let s2, s3, s4;
        if (inside) {
          s2 = Math.min(src[i + off2[c]], src[i - off2[c]]);
          s3 = Math.min(src[i + off3[c]], src[i - off3[c]]);
          s4 = Math.min(src[i + off4[c]], src[i - off4[c]]);
        } else {
          const { nx, ny } = LINE_CLASSES[c];
          s2 = Math.min(at(y + 2 * ny, x + 2 * nx), at(y - 2 * ny, x - 2 * nx));
          s3 = Math.min(at(y + 3 * ny, x + 3 * nx), at(y - 3 * ny, x - 3 * nx));
          s4 = Math.min(at(y + 4 * ny, x + 4 * nx), at(y - 4 * ny, x - 4 * nx));
        }
        // The side distance whose darker side is brightest: the one clear of
        // the line, for a line up to four texels thick.
        const k = s2 >= s3 && s2 >= s4 ? 0 : s3 >= s4 ? 1 : 2;
        const s = k === 0 ? s2 : k === 1 ? s3 : s4;
        if (s >= LINE.sideMin && v <= LINE.darkRatio * s && s - v >= LINE.contrastMin) {
          b |= 1 << c;
          kb |= k << (2 * c);
          blockCount[(c * bh + brow) * bw + ((x / S) | 0)]++;
        }
      }
      bits[i] = b;
      kbits[i] = kb;
    }
  }
  // Hough per tile, on the globe-fixed grid; only tiles that reach into the
  // core rows, all of them inside the halo.
  const T = LINE.tile;
  const nTheta = 2 * LINE.halfRange / LINE.thetaStep + 1;
  const RHO = Math.ceil(T * Math.SQRT2) + 2;
  const acc = new Uint16Array(nTheta * 2 * RHO);
  const cos = new Float64Array(4 * nTheta), sin = new Float64Array(4 * nTheta);
  for (let c = 0; c < 4; c++) for (let i = 0; i < nTheta; i++) {
    const a = ((LINE_CLASSES[c].dir - LINE.halfRange + i * LINE.thetaStep) * Math.PI) / 180;
    cos[c * nTheta + i] = Math.cos(a); sin[c * nTheta + i] = Math.sin(a);
  }
  const marked = new Uint8Array(N); // class + 1 of the line a texel belongs to
  const cx = [], cy = [];
  const firstTile = Math.floor((band.core - (T - 1)) / LINE.step) * LINE.step;
  for (let ty = Math.max(0, firstTile); ty < band.core + BAND && ty + T <= MH; ty += LINE.step) {
    const ly0 = ty - band.top;
    if (ly0 < 0 || ly0 + T > rows) continue;
    const brow = (ty - blockRow0) / S;
    for (let tx = 0; tx < MW; tx += LINE.step) {
      const bcol = tx / S, bcol2 = (bcol + 1) % bw;
      for (let c = 0; c < 4; c++) {
        const base = c * bh;
        const inTile = blockCount[(base + brow) * bw + bcol] + blockCount[(base + brow) * bw + bcol2]
          + blockCount[(base + brow + 1) * bw + bcol] + blockCount[(base + brow + 1) * bw + bcol2];
        if (inTile < LINE.minLength * LINE.coverage) continue;
        cx.length = 0; cy.length = 0;
        const bit = 1 << c;
        for (let j = 0; j < T; j++) {
          const o = (ly0 + j) * MW;
          for (let i = 0; i < T; i++) if (bits[o + ((tx + i) % MW)] & bit) { cx.push(i); cy.push(j); }
        }
        if (cx.length < LINE.minLength * LINE.coverage) continue;
        acc.fill(0);
        for (let ti = 0; ti < nTheta; ti++) {
          const cs = cos[c * nTheta + ti], sn = sin[c * nTheta + ti], base = ti * 2 * RHO + RHO;
          for (let k = 0; k < cx.length; k++) acc[base + Math.round(-cx[k] * sn + cy[k] * cs)]++;
        }
        for (let ti = 0; ti < nTheta; ti++) {
          const cs = cos[c * nTheta + ti], sn = sin[c * nTheta + ti], base = ti * 2 * RHO;
          for (let r = 1; r < 2 * RHO - 1; r++) {
            const votes = acc[base + r] + Math.max(acc[base + r - 1], acc[base + r + 1]);
            if (votes < LINE.minLength * LINE.coverage || acc[base + r] < acc[base + r - 1] || acc[base + r] < acc[base + r + 1]) continue;
            // The candidates within 1.5 texels of this line, its fit, and
            // those within the tolerance of the fit, along it.
            const rho = r - RHO;
            const near = [];
            for (let k = 0; k < cx.length; k++) {
              const d = -cx[k] * sn + cy[k] * cs - rho;
              if (Math.abs(d) <= 1.5) near.push([cx[k] * cs + cy[k] * sn, d, k]);
            }
            if (near.length < LINE.minLength * LINE.coverage) continue;
            let st = 0, sd = 0, stt = 0, std = 0;
            for (const [t, d] of near) { st += t; sd += d; stt += t * t; std += t * d; }
            const nn = near.length, den = nn * stt - st * st;
            const slope = den > 1e-9 ? (nn * std - st * sd) / den : 0, icept = (sd - slope * st) / nn;
            const along = near.filter(([t, d]) => Math.abs(d - (icept + slope * t)) <= LINE.tolerance).sort((p, q) => p[0] - q[0]);
            for (let s0 = 0; s0 < along.length;) {
              let e = s0;
              while (e + 1 < along.length && along[e + 1][0] - along[e][0] <= LINE.maxGap + 1) e++;
              const span = along[e][0] - along[s0][0] + 1;
              const positions = new Set();
              for (let q = s0; q <= e; q++) positions.add(Math.round(along[q][0]));
              if (span >= LINE.minLength && positions.size >= LINE.coverage * span) {
                // How dark the neighbourhood is: candidates of this class three
                // and four texels out either side, along the run.
                const { nx, ny } = LINE_CLASSES[c];
                let probes = 0, dark = 0;
                for (let t = Math.ceil(along[s0][0]); t <= along[e][0]; t++) {
                  const dd = rho + icept + slope * t;
                  const px = t * cs - dd * sn, py = t * sn + dd * cs;
                  for (const kk of [-4, -3, 3, 4]) {
                    const qy = ly0 + Math.round(py + kk * ny), qx = tx + Math.round(px + kk * nx);
                    if (qy < 0 || qy >= rows) continue;
                    probes++;
                    if (bits[qy * MW + ((qx % MW) + MW) % MW] & bit) dark++;
                  }
                }
                if (probes && dark / probes <= LINE.neighbourMax) {
                  // Confirmed on the strict band; filled on a wider one, so a
                  // line two texels thick where its stair steps overlap is
                  // filled whole rather than left as dashes.
                  stats.lines++;
                  // A register of every line for the report's sample: its
                  // middle, length, direction and the mean of its texels.
                  if (stats.register) {
                    const km = along[(s0 + e) >> 1][2];
                    let sv = 0;
                    for (let q = s0; q <= e; q++) { const k = along[q][2]; sv += src[(ly0 + cy[k]) * MW + ((tx + cx[k]) % MW)]; }
                    stats.register.push({ row: band.top + ly0 + cy[km], col: (tx + cx[km]) % MW, length: Math.round(span), dir: LINE_CLASSES[c].dir - LINE.halfRange + ti * LINE.thetaStep, meanValue: +(sv / (e - s0 + 1)).toFixed(1) });
                  }
                  const t0 = along[s0][0] - 1, t1 = along[e][0] + 1;
                  for (const [t, d, k] of near) {
                    if (t < t0 || t > t1 || Math.abs(d - (icept + slope * t)) > LINE.fillBand) continue;
                    marked[(ly0 + cy[k]) * MW + ((tx + cx[k]) % MW)] = c + 1;
                  }
                } else {
                  stats.rejectedSpeckle++;
                }
              }
              s0 = e + 1;
            }
          }
        }
      }
    }
  }
  // Fill the marked texels of the core from the sides they were measured on.
  let filled = 0;
  for (let j = 0; j < BAND; j++) {
    const y = coreOffset + j;
    for (let x = 0; x < MW; x++) {
      const m = marked[y * MW + x];
      if (!m) continue;
      const c = m - 1, { nx, ny } = LINE_CLASSES[c];
      const k = 2 + ((kbits[y * MW + x] >> (2 * c)) & 3);
      const v = Math.round((at(y + k * ny, x + k * nx) + at(y - k * ny, x - k * nx)) / 2);
      const was = src[y * MW + x];
      stats.valueHistogram[was === 0 ? '0' : was <= 2 ? '1-2' : was <= 8 ? '3-8' : was <= 32 ? '9-32' : '33+']++;
      stats.codesAdded += v - was;
      dst[j * MW + x] = v;
      filled++;
      const lat = latOfRow(band.core + j, MH), key = `${Math.floor(lat / 10) * 10}`;
      stats.byLatitude[key] = (stats.byLatitude[key] ?? 0) + 1;
      // A coarse register of where lines were found, for the report and the
      // pictures: one entry per 0.5-degree cell.
      const cell = `${Math.floor(lat * 2) / 2},${Math.floor((-180 + (360 * (x + 0.5)) / MW) * 2) / 2}`;
      stats.cells.set(cell, (stats.cells.get(cell) ?? 0) + 1);
    }
  }
  stats.texels += filled;
}

// --- 3. Ragged rims of the data ---------------------------------------------
//
// NASA marks missing data in the hemispheres with 0 to 2: the polar caps and
// the other holes the no-data report lists, and smaller holes with hard
// straight edges among the swaths near the rim, sitting in cloud of 150 and
// more. With the infrared layer on top, a hole takes the layer alone and the
// cloud around it the layer plus its own light, so every hole near the rim is
// a hard-edged grey patch at the master's texel. Real clear sky is 0 to 2 as
// well, so a texel's value cannot say which it is; the EDGE can. Clear sky
// meets cloud through partly-covered texels — of the zero texels on the edge
// of a zero region away from the rims, under 1 % have a neighbour over 48 —
// while a hole is cut straight out of cloud. So:
//  - a texel of RIM.emptyMax or less is EMPTY-OR-CLEAR; one with a neighbour
//    holding data is on an edge, and its HARDNESS ramps from 0 to 1 as the
//    brightest such neighbour goes from RIM.hardLo to RIM.hardHi;
//  - each empty-or-clear texel takes the local mean of the data around it
//    (two box passes of radius RIM.radius over the texels holding data), times
//    the mean hardness of the edges around it (the same filter over the edge
//    texels), times a feather that falls from 1 at the edge to 0 at
//    RIM.feather texels in (a chamfer distance): a hole in cloud fills from its
//    edges and a wide one keeps the infrared layer alone in its middle, the
//    rim of the polar no-data softens over a fifth of a degree, and clear sky,
//    whose edges are soft, is left as it is.
// A swath's own edge is often a ring of partly-covered texels against the
// hole; once the hole is filled, and the infrared layer re-solved smaller for
// the light it gained, that ring would stand as a dark hairline between filled
// texels and the patch. So a texel touching an empty one and darker than
// RIM.edgeShare of the local mean takes the fill too (it is data, so its
// distance is 0). The fill only ever
// raises a texel, and only where the infrared layer is
// (the same latitude gate, IR_GATE): equatorward of it a hole draws as clear
// sky in NASA's own composite too, and what the rule finds there is the
// hard-edged blocks the cloud product leaves over bright desert, which it
// would smear into halos. Because it runs before the infrared layer is
// solved, a cell that gains light in its holes takes a smaller layer and
// keeps NASA's brightness.
const RIM = { emptyMax: 2, edgeShare: 0.6, hardLo: 40, hardHi: 72, radius: 12, feather: 24, tileCols: 2048, margin: 48 };

export function retouchRim(src, dst, band, stats) {
  const { rows, coreOffset } = band;
  // Only where the infrared layer is: elsewhere a hole is drawn as the clear
  // sky its value says, the same as NASA's own composite draws it, and the
  // fill's one failure mode — the hard-edged blocks the cloud product leaves
  // over bright desert — is all it would find.
  if (irGate(latOfRow(band.core, MH)) === 0 && irGate(latOfRow(band.core + BAND - 1, MH)) === 0) return;
  const C = RIM.tileCols, M = RIM.margin, w = C + 2 * M;
  const n = rows * w;
  const valid = new Float32Array(n), sum = new Float32Array(n), edge = new Float32Array(n), hard = new Float32Array(n);
  const dist = new Uint8Array(n), tmp = new Float32Array(n);
  const lim = RIM.feather + 1;
  for (let c0 = 0; c0 < MW; c0 += C) {
    // The tile with its margin, wrapping in longitude.
    let anyHard = false;
    for (let y = 0; y < rows; y++) {
      const o = y * MW;
      for (let i = 0; i < w; i++) {
        const x = (c0 - M + i + MW) % MW, k = y * w + i, v = src[o + x];
        const ok = v > RIM.emptyMax ? 1 : 0;
        valid[k] = ok; sum[k] = ok * v; edge[k] = 0; hard[k] = 0;
      }
    }
    for (let y = 0; y < rows; y++) {
      for (let i = 0; i < w; i++) {
        const k = y * w + i;
        if (valid[k]) continue;
        let brightest = -1;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= rows) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const ii = i + dx;
            if (ii < 0 || ii >= w || (!dx && !dy)) continue;
            const kk = yy * w + ii;
            if (valid[kk] && sum[kk] > brightest) brightest = sum[kk];
          }
        }
        if (brightest < 0) continue;
        edge[k] = 1;
        const h = smoothstep(RIM.hardLo, RIM.hardHi, brightest);
        hard[k] = h;
        if (h > 0) anyHard = true;
      }
    }
    if (!anyHard) continue;
    // Chamfer (3-4) distance to the nearest texel holding data, in thirds of
    // a texel, capped.
    for (let k = 0; k < n; k++) dist[k] = valid[k] ? 0 : 255;
    const cap = 3 * lim;
    for (let y = 0; y < rows; y++) for (let i = 0; i < w; i++) {
      const k = y * w + i;
      if (!dist[k]) continue;
      let d = dist[k];
      if (i > 0) d = Math.min(d, dist[k - 1] + 3);
      if (y > 0) { d = Math.min(d, dist[k - w] + 3); if (i > 0) d = Math.min(d, dist[k - w - 1] + 4); if (i < w - 1) d = Math.min(d, dist[k - w + 1] + 4); }
      dist[k] = Math.min(d, cap);
    }
    for (let y = rows - 1; y >= 0; y--) for (let i = w - 1; i >= 0; i--) {
      const k = y * w + i;
      if (!dist[k]) continue;
      let d = dist[k];
      if (i < w - 1) d = Math.min(d, dist[k + 1] + 3);
      if (y < rows - 1) { d = Math.min(d, dist[k + w] + 3); if (i < w - 1) d = Math.min(d, dist[k + w + 1] + 4); if (i > 0) d = Math.min(d, dist[k + w - 1] + 4); }
      dist[k] = Math.min(d, cap);
    }
    boxBlur(valid, w, rows, RIM.radius, 2, tmp);
    boxBlur(sum, w, rows, RIM.radius, 2, tmp);
    boxBlur(edge, w, rows, RIM.radius, 2, tmp);
    boxBlur(hard, w, rows, RIM.radius, 2, tmp);
    for (let j = 0; j < BAND; j++) {
      const y = coreOffset + j;
      const lat = latOfRow(band.core + j, MH), key = `${Math.floor(lat / 10) * 10}`;
      const gate = irGate(lat);
      if (gate === 0) continue;
      for (let i = M; i < M + C && c0 + i - M < MW; i++) {
        const k = y * w + i, x = c0 + i - M, v = src[y * MW + x];
        if (valid[k] < 1e-6 || edge[k] < 1e-6) continue;
        if (v > RIM.emptyMax) {
          // Dark data: only on the edge of a hole.
          if (v >= RIM.edgeShare * (sum[k] / valid[k])) continue;
          let touches = false;
          for (let dy = -1; dy <= 1 && !touches; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= rows) continue;
            for (let dx = -1; dx <= 1; dx++) if (src[yy * MW + ((x + dx + MW) % MW)] <= RIM.emptyMax) { touches = true; break; }
          }
          if (!touches) continue;
        }
        const est = sum[k] / valid[k], h = hard[k] / edge[k];
        const f = 1 - smoothstep(0, RIM.feather, dist[k] / 3);
        const fill = Math.round(est * h * f * gate);
        if (fill <= v) continue;
        dst[j * MW + x] = Math.min(255, fill);
        stats.texels++;
        stats.codesAdded += fill - v;
        stats.byLatitude[key] = (stats.byLatitude[key] ?? 0) + 1;
        const cell = `${Math.floor(lat)},${Math.floor(-180 + (360 * (x + 0.5)) / MW)}`;
        stats.cells.set(cell, (stats.cells.get(cell) ?? 0) + fill - v);
      }
    }
  }
}

// --- 2. The dateline ---------------------------------------------------------
//
// The hemispheres join at 180 degrees where NASA's daily passes on either side
// of the day boundary saw the clouds hours apart, and in four stretches of it
// the clouds do not meet: a straight seam 10 degrees and more long, the worst
// between the equator and 17 S (a step of up to 65 times its neighbours').
// The two sides share no texel, so nothing can be blended until they overlap:
// each side is resampled (Catmull-Rom, reading only its own side) so that it
// reaches DATELINE.overlap past 180, a smooth stretch that starts
// DATELINE.stretch out (at most about 1.4 times, at the seam) — nothing is
// duplicated or mirrored in what is drawn. In the overlap each side is split
// into bands (Gaussians of DATELINE.sigmas) and every band switches from one
// side to the other across the same wandering boundary — fractal noise of up
// to about a degree, fixed per row — with a feather in proportion to its scale,
// from a couple of texels for the finest to the whole overlap for what is
// left above the broadest. So the join wanders, nothing straight survives at
// any scale, and both sides keep their full resolution.
//
// Only where there is a seam: per half degree of latitude, the step across
// 180 against its neighbours' (pass 1 measures both), on at
// DATELINE.gate.on times or more, with short gaps closed, short pieces
// dropped and a ramp INSIDE each stretch. A row that was continuous is never
// touched: stretching it would tear content apart. Greenwich is never in the
// strip, and the report checks that.
const DATELINE = {
  half: 1200, stretch: 960, overlap: 150,
  amp: 105, lambda: 300, octaves: 7, persistence: 0.6, seed: 0x5eed,
  sigmas: [1.5, 4, 12, 36], feathers: [2, 5, 14, 40],
  gate: { blockRows: 60, on: 2.5, close: 4, min: 4, ramp: 6 },
  halo: 160,
};

const hashInt = (i, seed) => {
  let h = (Math.imul(i | 0, 374761393) + Math.imul(seed | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
};
const valueNoise1 = (t, seed) => {
  const i = Math.floor(t), f = t - i, s = f * f * (3 - 2 * f);
  return (hashInt(i, seed) * (1 - s) + hashInt(i + 1, seed) * s) * 2 - 1;
};
/** The wandering boundary's offset from 180 at a master row, in texels. */
function datelineBoundary(row) {
  const p = DATELINE;
  let v = 0, amp = 1, norm = 0, t = row / p.lambda;
  for (let o = 0; o < p.octaves; o++) { v += amp * valueNoise1(t, p.seed + o * 101); norm += amp; amp *= p.persistence; t *= 2.03; }
  return Math.max(-0.85 * p.overlap, Math.min(0.85 * p.overlap, (1.6 * p.amp * v) / norm));
}

/** The gate per master row, from pass 1's join steps. */
function datelineGate(joins) {
  const { blockRows, on, close, min, ramp } = DATELINE.gate;
  const nb = MH / blockRows;
  const ratio = new Float64Array(nb);
  for (let b = 0; b < nb; b++) {
    let s = 0, c = 0;
    for (let y = b * blockRows; y < (b + 1) * blockRows; y++) { s += joins.dateline[y]; c += joins.datelineCtl[y]; }
    ratio[b] = s / Math.max(c, blockRows * 0.5);
  }
  const g = Array.from(ratio, (r) => (r >= on ? 1 : 0));
  for (let i = 0; i < nb; i++) {
    if (g[i]) continue;
    let a = i - 1; while (a >= 0 && !g[a]) a--;
    let b = i + 1; while (b < nb && !g[b]) b++;
    if (a >= 0 && b < nb && b - a - 1 <= close) for (let t = a + 1; t < b; t++) g[t] = 2;
  }
  for (let i = 0; i < nb; i++) g[i] = g[i] ? 1 : 0;
  for (let i = 0; i < nb;) {
    if (!g[i]) { i++; continue; }
    let j = i; while (j < nb && g[j]) j++;
    if (j - i < min) for (let t = i; t < j; t++) g[t] = 0;
    i = j;
  }
  const inward = new Float64Array(nb);
  for (let i = 0; i < nb; i++) inward[i] = g[i] ? (i > 0 ? inward[i - 1] + 1 : 1) : 0;
  for (let i = nb - 2; i >= 0; i--) if (g[i]) inward[i] = Math.min(inward[i], inward[i + 1] + 1);
  const gate = new Float32Array(MH);
  for (let y = 0; y < MH; y++) {
    const bf = (y + 0.5) / blockRows - 0.5;
    const i0 = Math.max(0, Math.min(nb - 1, Math.floor(bf))), i1 = Math.min(nb - 1, i0 + 1), t = Math.min(1, Math.max(0, bf - i0));
    if (!g[i0] && !g[i1]) continue;
    gate[y] = smoothstep(0.5, ramp, inward[i0] * (1 - t) + inward[i1] * t);
  }
  const segments = [];
  for (let i = 0; i < nb;) {
    if (!g[i]) { i++; continue; }
    let j = i; while (j < nb && g[j]) j++;
    let peak = 0;
    for (let t = i; t < j; t++) peak = Math.max(peak, ratio[t]);
    segments.push({ north: +(90 - (i * blockRows) / 120).toFixed(2), south: +(90 - (j * blockRows) / 120).toFixed(2), peakRatio: +peak.toFixed(1) });
    i = j;
  }
  return { gate, segments, ratio };
}

/** The feathered strip: see the comment above DATELINE. `strip` is H rows of
 *  2 x half texels centred on 180 (the first half east of the seam, lon < 180),
 *  strip row r is master row row0 + r. */
function featherStrip(strip, H, row0, gate) {
  const p = DATELINE, HALF = p.half, W = 2 * HALF;
  const cubicAt = (r, x, lo, hi) => {
    const i = Math.floor(x), t = x - i, o = r * W;
    const g = (k) => strip[o + Math.min(hi, Math.max(lo, i + k))];
    const t2 = t * t, t3 = t2 * t;
    return ((-t3 + 2 * t2 - t) * g(-1) + (3 * t3 - 5 * t2 + 2) * g(0) + (-3 * t3 + 4 * t2 + t) * g(1) + (t3 - t2) * g(2)) / 2;
  };
  // Where offset u past the seam (texel centres; -0.5 is this side's last
  // texel) reads from on its own side, for a gate of k.
  const sourceOffset = (u, k) => {
    const S = p.stretch, D = k * p.overlap, end = -0.5;
    if (u <= -S || D <= 0) return u <= end ? u : 2 * end - u;
    if (u > D) return end - (u - D); // only the blurs' support reads this far
    const A = (S + D - 0.5) / (S - 0.5), t = (u + S) / (S + D);
    return -S + (S - 0.5) * (A * t + (1 - A) * t * t);
  };
  const side = (east) => {
    const out = new Float32Array(W * H);
    for (let r = 0; r < H; r++) {
      const k = gate[row0 + r];
      for (let x = 0; x < W; x++) {
        const u = east ? x - HALF + 0.5 : HALF - 0.5 - x;
        const su = sourceOffset(u, k);
        out[r * W + x] = east ? cubicAt(r, su + HALF - 0.5, 0, HALF - 1) : cubicAt(r, HALF - 0.5 - su, HALF, W - 1);
      }
    }
    return out;
  };
  const E = side(true), Wd = side(false);
  const n = p.sigmas.length, tmp = new Float32Array(W * H);
  const blurred = (img, sigma) => {
    const out = Float32Array.from(img);
    boxBlur(out, W, H, Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2)), 3, tmp);
    return out;
  };
  const be = [E], bw = [Wd];
  for (const s of p.sigmas) { be.push(blurred(E, s)); bw.push(blurred(Wd, s)); }
  const out = Float32Array.from(strip);
  for (let r = 0; r < H; r++) {
    const row = row0 + r, k = gate[row];
    if (k <= 0) continue;
    const b = k * datelineBoundary(row), D = k * p.overlap;
    for (let x = 0; x < W; x++) {
      const i = r * W + x, u = x - HALF + 0.5;
      const mLow = smoothstep(-D, D, u - 0.5 * b);
      let v = (1 - mLow) * be[n][i] + mLow * bw[n][i];
      for (let j = 0; j < n; j++) {
        const f = Math.min(p.feathers[j], D);
        const m = smoothstep(-f, f, u - b);
        v += (1 - m) * (be[j][i] - be[j + 1][i]) + m * (bw[j][i] - bw[j + 1][i]);
      }
      out[i] = v;
    }
  }
  return out;
}

/** The dateline feather, in place on a master file: each gated stretch read
 *  as a strip with a halo, feathered, and its rows written back. */
async function retouchDateline(file, joins) {
  const { gate, segments, ratio } = datelineGate(joins);
  const p = DATELINE, HALF = p.half, W = 2 * HALF;
  const fd = await open(file, 'r+');
  const line = new Uint8Array(MW);
  let texels = 0, codes = 0;
  const colLo = MW - HALF, colHi = HALF; // the strip: [colLo, MW) and [0, colHi)
  try {
    for (const seg of segments) {
      const ra = Math.round(((90 - seg.north) / 180) * MH), rb = Math.round(((90 - seg.south) / 180) * MH);
      const top = Math.max(0, ra - p.halo), bottom = Math.min(MH, rb + p.halo), H = bottom - top;
      const strip = new Float32Array(W * H);
      for (let r = 0; r < H; r++) {
        await fd.read(line, 0, MW, (top + r) * MW);
        for (let x = 0; x < W; x++) strip[r * W + x] = line[(colLo + x) % MW];
      }
      const out = featherStrip(strip, H, top, gate);
      for (let r = ra - top; r < rb - top; r++) {
        await fd.read(line, 0, MW, (top + r) * MW);
        for (let x = 0; x < W; x++) {
          const c = (colLo + x) % MW, v = Math.min(255, Math.max(0, Math.round(out[r * W + x])));
          if (v !== line[c]) { texels++; codes += Math.abs(v - line[c]); line[c] = v; }
        }
        await fd.write(line, 0, MW, (top + r) * MW);
      }
      log(`dateline: ${seg.north}..${seg.south} deg feathered`);
    }
  } finally {
    await fd.close();
  }
  return {
    segments,
    columnsTouched: `[${colLo}, ${MW}) and [0, ${colHi}), i.e. ${(180 - (HALF * 360) / MW).toFixed(1)}..180 and -180..${(-180 + (HALF * 360) / MW).toFixed(1)} deg; Greenwich (column ${HW}) is ${HW - colHi} columns from the strip`,
    texelsChanged: texels,
    meanChangeCode: texels ? codes / texels : 0,
    ratioPerHalfDegree: Array.from(ratio, (r) => +r.toFixed(2)),
    rule: `per ${DATELINE.gate.blockRows / 120} deg block, the mean step across 180 over the mean of its 8 neighbouring column pairs' (pass 1, raw); on at ${DATELINE.gate.on} or more, gaps up to ${DATELINE.gate.close} blocks closed, pieces under ${DATELINE.gate.min} dropped, ${DATELINE.gate.ramp}-block ramp inside each piece`,
  };
}

/** Per 5-degree band, the mean step across a join column against its eight
 *  neighbouring pairs', read from a master file: the join statistic before
 *  and after. */
async function joinProfile(file) {
  const fd = await open(file, 'r');
  const band = new Uint8Array(MW * BAND);
  const out = {};
  try {
    for (let y0 = 0; y0 < MH; y0 += BAND) {
      await fd.read(band, 0, band.length, y0 * MW);
      for (let k = 0; k < BAND; k++) {
        const row = band.subarray(k * MW, (k + 1) * MW), lat = latOfRow(y0 + k, MH);
        const key = `${Math.floor(lat / 5) * 5}..${Math.floor(lat / 5) * 5 + 5}`;
        const b = (out[key] ??= { n: 0, dateline: 0, datelineNeighbours: 0, greenwich: 0, greenwichNeighbours: 0 });
        const [d, dc] = joinStepAt(row, 0), [g, gc] = joinStepAt(row, HW);
        b.n++; b.dateline += d; b.datelineNeighbours += dc; b.greenwich += g; b.greenwichNeighbours += gc;
      }
    }
  } finally {
    await fd.close();
  }
  return Object.fromEntries(Object.entries(out).map(([k, b]) => [k, {
    dateline: +(b.dateline / b.n).toFixed(2), datelineNeighbours: +(b.datelineNeighbours / b.n).toFixed(2),
    greenwich: +(b.greenwich / b.n).toFixed(2), greenwichNeighbours: +(b.greenwichNeighbours / b.n).toFixed(2),
  }]));
}

/** The 8K means of a master file, for the infrared layer and the grade once
 *  the retouch has changed the field. */
async function areaMean8(file) {
  const fd = await open(file, 'r');
  const avg = new AreaAverage(MW, MH, W8, H8);
  const band = new Uint8Array(MW * BAND);
  try {
    for (let y0 = 0; y0 < MH; y0 += BAND) {
      await fd.read(band, 0, band.length, y0 * MW);
      for (let k = 0; k < BAND; k++) avg.addRow(y0 + k, band.subarray(k * MW, (k + 1) * MW));
    }
  } finally {
    await fd.close();
  }
  return avg.finish();
}

const RETOUCH_STEPS = ['lines', 'rim', 'dateline', 'steps'];

/** Every retouch step the run asked for, on the assembled field in place
 *  (`partial`), through a scratch file for the banded steps. */
async function retouch(partial, pass1, steps) {
  const report = { steps };
  const scratch = `${partial}.retouch`;
  report.joinsBefore = await joinProfile(partial);
  if (steps.includes('lines')) {
    const stats = { texels: 0, codesAdded: 0, byLatitude: {}, cells: new Map(), lines: 0, rejectedSpeckle: 0, valueHistogram: { '0': 0, '1-2': 0, '3-8': 0, '9-32': 0, '33+': 0 } };
    await bandedPass(partial, scratch, LINE.tile, (src, dst, band) => retouchLines(src, dst, band, stats), 'lines');
    await rename(scratch, partial);
    const cells = [...stats.cells.entries()].sort((p, q) => q[1] - p[1]);
    report.lines = {
      rule: `a texel of ${LINE.valueMax} or less, at most ${LINE.darkRatio} of the darker of its two sides (read 2, 3 or 4 texels out across the line, whichever is clearest, both at least ${LINE.sideMin}) and ${LINE.contrastMin} codes under it, in one of four directions; a line where at least ${LINE.coverage * 100} % of the positions along ${LINE.minLength} texels or more hold such a texel within ${LINE.tolerance} of a fitted straight line, no gap over ${LINE.maxGap}, and the texels 3 and 4 out either side are such texels at no more than ${LINE.neighbourMax * 100} % of them; filled within ${LINE.fillBand} of the line (Hough per ${LINE.tile}-texel tile, every ${LINE.step} texels, ${LINE.thetaStep} deg steps); filled with the mean of its two sides`,
      texelsFilled: stats.texels,
      lineDetections: stats.lines,
      straightRunsRejectedAsSpeckle: stats.rejectedSpeckle,
      filledTexelsByOriginalValue: stats.valueHistogram,
      meanCodesAdded: stats.texels ? +(stats.codesAdded / stats.texels).toFixed(2) : 0,
      byLatitude10: stats.byLatitude,
      halfDegreeCellsWithLines: cells.length,
      busiestCells: cells.slice(0, 40).map(([k, v]) => ({ latLon: k, texels: v })),
    };
    log(`lines: ${stats.texels} texels filled in ${cells.length} half-degree cells`);
  }
  if (steps.includes('rim')) {
    const stats = { texels: 0, codesAdded: 0, byLatitude: {}, cells: new Map() };
    await bandedPass(partial, scratch, RIM.radius * 4 + RIM.feather + 8, (src, dst, band) => retouchRim(src, dst, band, stats), 'rim');
    await rename(scratch, partial);
    report.rim = {
      rule: `poleward of ${IR_GATE[0]} deg (the infrared layer's gate), texels of ${RIM.emptyMax} or less, and texels under ${RIM.edgeShare} of the local mean touching one, take (local mean of the data around them) x (mean hardness of the edges around them) x (1 - smoothstep(0, ${RIM.feather}, chamfer distance to data)); hardness = smoothstep(${RIM.hardLo}, ${RIM.hardHi}, brightest data neighbour) on edge texels; local means are two box passes of radius ${RIM.radius}; a texel is only ever raised`,
      texelsRaised: stats.texels,
      meanCodesAdded: stats.texels ? +(stats.codesAdded / stats.texels).toFixed(2) : 0,
      byLatitude10: stats.byLatitude,
      busiestDegreeCells: [...stats.cells.entries()].sort((p, q) => q[1] - p[1]).slice(0, 20).map(([k, v]) => ({ latLon: k, codesAdded: v })),
    };
    log(`rim: ${stats.texels} texels raised`);
  }
  if (steps.includes('dateline')) {
    report.dateline = await retouchDateline(partial, pass1.joins);
    log(`dateline: ${report.dateline.segments.length} stretches, ${report.dateline.texelsChanged} texels changed`);
  }
  report.joinsAfter = await joinProfile(partial);
  return report;
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
// 4. Swath brightness steps (measured, not repaired).
//
// Where two passes meet along a swath's side, one can be brighter than the
// other: a straight edge across which the SAME cloud field carries on at a
// different gain. Measured on the finished master's 8K means, along straight
// lines within STEPS.maxSlope of north-south (a swath side runs 8 degrees off
// north at the equator and leans further poleward, more again on this map),
// in windows of STEPS.window cells (10 degrees: a swath's side runs for
// thousands of kilometres, while the sunlit and shaded faces of cumulus cells
// — which a 2-degree window lists by the thousand, every cell brighter on its
// east face in a morning overpass — do not line up that far): across the line, the log
// ratio of the two sides two cells out, offset by STEPS.floor codes so clear
// sky does not divide by nothing, less the mean of the same ratio taken
// beside the line on each side (cells two and five out), so a broad gradient
// — the side of a cloud mass — cancels and a step does not. A window is a step when the cloud field is
// on both sides of it (both at least STEPS.cloud codes over STEPS.cloudShare
// of it), the mean log ratio is at least ln(STEPS.minGain), and it keeps its
// sign (|sum| over sum of magnitudes at least STEPS.consistency) — a cloud
// edge flips sign along a line, a gain step does not. Reported, worst first,
// one per 3 degrees. What it finds is a mix, and the report says so: real
// seams (the Greenwich join where its two days differ), swath steps, and
// long natural edges (a front, a coast's stratocumulus) it cannot tell from
// them. Not repaired: a gain matched along one straight line would need the
// line's ends, its width and the field on each side to be right, and a wrong
// one paints a band across real cloud.
const STEPS = { maxSlope: 0.8, slopeStep: 0.05, window: 228, floor: 8, cloud: 30, cloudShare: 0.3, minGain: 1.08, consistency: 0.8, separationDeg: 3 };

export function swathSteps(g8, opts = {}) {
  const P = { ...STEPS, ...opts };
  const L = P.window;
  // The strongest flagged window per 1-degree cell.
  const best = new Array(360 * 180).fill(null);
  let flagged = 0;
  // Per cell, the log ratio across a north-south line through it and
  // whether both sides hold cloud — independent of the slope, which only
  // decides which cells one line visits.
  const R = new Float32Array(W8 * H8), cloudy = new Uint8Array(W8 * H8);
  const wrap = (x) => (x + W8) % W8;
  const F = P.floor;
  for (let y = 0; y < H8; y++) {
    const o = y * W8, v = (x) => g8[o + wrap(x)];
    for (let x = 0; x < W8; x++) {
      const farLeft = (v(x - 5) + v(x - 4)) / 2, left = (v(x - 2) + v(x - 1)) / 2;
      const right = (v(x + 1) + v(x + 2)) / 2, farRight = (v(x + 4) + v(x + 5)) / 2;
      // The ratio across the line less the mean of the ratios beside it on
      // each side: a step keeps the first, a smooth gradient cancels.
      R[o + x] = Math.log((right + F) / (left + F)) - 0.5 * (Math.log((left + F) / (farLeft + F)) + Math.log((farRight + F) / (right + F)));
      cloudy[o + x] = Math.min(farLeft, left, right, farRight) >= P.cloud ? 1 : 0;
    }
  }
  const minMean = Math.log(P.minGain);
  const sr = new Float64Array(W8), ar = new Float64Array(W8), nc = new Int32Array(W8);
  const dxOf = new Int32Array(H8);
  for (let s = -P.maxSlope; s <= P.maxSlope + 1e-9; s += P.slopeStep) {
    for (let y = 0; y < H8; y++) dxOf[y] = Math.round(s * (y - H8 / 2));
    sr.fill(0); ar.fill(0); nc.fill(0);
    for (let y = 0; y < H8; y++) {
      const o = y * W8, dx = dxOf[y];
      const oOut = (y - L) * W8, dxOut = y >= L ? dxOf[y - L] : 0;
      for (let x0 = 0; x0 < W8; x0++) {
        const k = o + (((x0 + dx) % W8) + W8) % W8;
        sr[x0] += R[k]; ar[x0] += Math.abs(R[k]); nc[x0] += cloudy[k];
        if (y >= L) {
          const ko = oOut + (((x0 + dxOut) % W8) + W8) % W8;
          sr[x0] -= R[ko]; ar[x0] -= Math.abs(R[ko]); nc[x0] -= cloudy[ko];
        }
        if (y < L - 1 || nc[x0] < P.cloudShare * L) continue;
        const mean = sr[x0] / L;
        if (Math.abs(mean) < minMean || Math.abs(sr[x0]) < P.consistency * ar[x0]) continue;
        const yc = y - L / 2, xc = (((x0 + dxOf[Math.max(0, yc)]) % W8) + W8) % W8;
        flagged++;
        const lat = latOfRow(yc, H8), lon = -180 + (360 * (xc + 0.5)) / W8;
        const cell = Math.min(179, Math.floor(90 - lat)) * 360 + Math.min(359, Math.floor(lon + 180));
        const gain = Math.exp(Math.abs(mean));
        if (!best[cell] || gain > best[cell].gain) best[cell] = { gain, brighter: mean > 0 ? 'east' : 'west', consistency: Math.abs(sr[x0]) / ar[x0], slope: s, lat, lon };
      }
    }
  }
  const found = best.filter(Boolean).sort((p, q) => q.gain - p.gain);
  const worst = [];
  for (const f of found) {
    if (worst.some((w) => Math.abs(w.lat - f.lat) < P.separationDeg && Math.abs(((w.lon - f.lon + 540) % 360) - 180) < P.separationDeg)) continue;
    worst.push(f);
    if (worst.length >= 10) break;
  }
  return {
    rule: `8K means of the finished master; lines within ${P.maxSlope} cells east-west per cell north-south; windows of ${P.window} cells; log((east + ${P.floor}) / (west + ${P.floor})) two cells out, less the mean of the same ratio beside the line on each side; all four sampled sides at least ${P.cloud} codes over ${P.cloudShare * 100} % of the window; mean gain at least ${P.minGain}; consistency at least ${P.consistency}`,
    windowsFlagged: flagged,
    degreeCellsFlagged: found.length,
    worstTen: worst.map((w) => ({ lat: +w.lat.toFixed(2), lon: +w.lon.toFixed(2), gain: +w.gain.toFixed(3), brighterSide: w.brighter, consistency: +w.consistency.toFixed(2), leanDeg: +((Math.atan(w.slope) * 180) / Math.PI).toFixed(1) })),
    repaired: false,
  };
}

/** The places the retouch pictures show: the known sites, then the busiest
 *  cells each step found and the worst swath steps. */
function retouchSites(r) {
  const sites = [];
  if (r.dateline) {
    sites.push(
      { name: 'dateline-strip-overview', box: [170, 190, -35, 40], note: 'the dateline, 35 S to 40 N, at a quarter of the master\'s texel', zoom: 0.25 },
      { name: 'dateline-0-25s', box: [178, 182, -25, -5], note: 'the day boundary at its worst' },
      { name: 'dateline-23-34n', box: [178, 182, 23, 34], note: 'the northern stretch' },
      { name: 'dateline-polar-south', box: [176, 184, -75, -61], note: 'the southern polar stretch' },
      { name: 'dateline-gate-north-end', box: [178, 182, 3, 13], note: 'where the 7 N to 17 S stretch begins (rows north of it untouched)' },
      { name: 'dateline-detail-12s', box: [178.75, 181.25, -15, -10.5], note: 'at the master\'s texel, 2x', zoom: 2 },
      { name: 'greenwich-unchanged', box: [-1, 1, -20, 20], note: 'Greenwich: the dateline step never reaches it', zoom: 1 },
    );
  }
  if (r.lines) {
    sites.push(
      { name: 'lines-italy', box: [12.6, 14.2, 42.8, 43.5], note: 'central Italy, the known line', zoom: 4 },
      { name: 'lines-atlantic-52n', box: [-29.5, -25, 51.8, 53], note: 'the Atlantic at 52 N, the known line', zoom: 3 },
    );
    for (const { latLon } of r.lines.busiestCells.slice(0, 8)) {
      const [lat, lon] = latLon.split(',').map(Number);
      sites.push({ name: `lines-cell-${lat}_${lon}`, box: [lon - 0.25, lon + 0.75, lat - 0.25, lat + 0.75], note: `line texels in the half degree at ${lat}, ${lon}`, zoom: 3 });
    }
  }
  if (r.rim) {
    sites.push(
      { name: 'rim-dateline-holes', box: [179.5, 181.5, -68, -65.5], note: 'holes in cloud near the dateline, 66 S', zoom: 3 },
      { name: 'rim-south-polar-edge', box: [62, 66, -69, -66], note: 'where the hemispheres end, south', zoom: 2 },
    );
    for (const { latLon } of r.rim.busiestDegreeCells.slice(0, 6)) {
      const [lat, lon] = latLon.split(',').map(Number);
      sites.push({ name: `rim-cell-${lat}_${lon}`, box: [lon - 0.5, lon + 1.5, lat - 0.5, lat + 1.5], note: `the most raised degree at ${lat}, ${lon}`, zoom: 2 });
    }
  }
  if (r.swathSteps) {
    sites.push({ name: 'steps-usa', box: [-98, -92, 33, 39], note: 'the diagonal step in usa-shipped-differs' });
    r.swathSteps.worstTen.forEach((w, i) => sites.push({ name: `steps-${i + 1}`, box: [+(w.lon - 2).toFixed(2), +(w.lon + 2).toFixed(2), +(w.lat - 2).toFixed(2), +(w.lat + 2).toFixed(2)], note: `swath step ${i + 1}: gain ${w.gain}, ${w.brighterSide} side brighter`, zoom: 0.5 }));
  }
  return sites;
}

/** Before/after pictures of the retouch at the master's texel: the master as
 *  built without the retouch (`compare`, when it is on disk) left, this one
 *  right, each optionally magnified. */
async function retouchPictures(compare, sites) {
  const dir = path.join(PICTURES, 'retouch');
  await mkdir(dir, { recursive: true });
  const fa = existsSync(compare) ? await open(compare, 'r') : null;
  const fb = await open(OUT, 'r');
  const written = [];
  try {
    for (const { name, box: [west, east, south, north], note, zoom = 1 } of sites) {
      const x0 = Math.round(((west + 180) / 360) * MW), x1 = Math.round(((east + 180) / 360) * MW);
      const y0 = Math.max(0, Math.round(((90 - north) / 180) * MH)), y1 = Math.min(MH, Math.round(((90 - south) / 180) * MH));
      const w = x1 - x0, h = y1 - y0;
      const right = await readMasterBox(fb, x0, y0, w, h);
      const left = fa ? await readMasterBox(fa, x0, y0, w, h) : new Uint8Array(w * h);
      const W = Math.round(w * zoom), H = Math.round(h * zoom), gap = 6;
      const W2 = Math.round(w * zoom), H2 = Math.round(h * zoom);
      const big = async (buf) => sharp(Buffer.from(buf), { raw: { width: w, height: h, channels: 1 } }).resize(W2, H2, { kernel: zoom >= 1 ? 'nearest' : 'lanczos3' }).png().toBuffer();
      const file = path.join(dir, `${name}.jpg`);
      const range = `${west}..${east} lon, ${south}..${north} lat${zoom !== 1 ? `, ${zoom}x` : ''}`;
      await sharp({ create: { width: 2 * W + gap, height: H, channels: 3, background: '#7a1f1f' } })
        .composite([
          { input: await big(left), left: 0, top: 0 },
          { input: await big(right), left: W + gap, top: 0 },
          { input: labelSvg(fa ? `before (no retouch) · ${range}` : 'before: no comparison master on disk', Math.min(W, 520)), left: 0, top: 0 },
          { input: labelSvg(`after · ${note}`, Math.min(W, 520)), left: W + gap, top: 0 },
        ])
        .jpeg({ quality: 92 })
        .toFile(file);
      written.push({ file, box: [west, east, south, north], zoom, note });
      log(`retouch picture: ${path.basename(file)}`);
    }
  } finally {
    await fa?.close();
    await fb.close();
  }
  return written;
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
  for (const step of RETOUCH) if (!RETOUCH_STEPS.includes(step)) throw new Error(`--retouch=${step}: one of ${RETOUCH_STEPS.join(', ')} or none`);
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

  // The retouch, on the assembled field; the infrared layer and the grade are
  // then solved on what it leaves.
  let retouchReport = null;
  let mean8 = pass1.mean8;
  if (RETOUCH.some((step) => step !== 'steps')) {
    retouchReport = await retouch(partial, pass1, RETOUCH);
    mean8 = await areaMean8(partial);
    log('retouch done; 8K means taken again for the infrared layer and the grade');
  }
  const ir = infraredLayer(mean8, composite8);
  log(`infrared layer: shared scale ${ir.report.sharedScale.meanRatio.toFixed(4)} (ratio of means), slope ${ir.report.sharedScale.slope.toFixed(4)}; ${JSON.stringify(ir.report.byLatitudeBand)}`);

  const blocks = sameSkyBlocks(composite8, shipped8);
  log(`shipped vs NASA composite: ${pct(blocks.report.areaBelowThreshold)} of the globe in ${SAME_SKY_BLOCK_DEG} deg blocks below r ${SAME_SKY_R} (${pct(blocks.report.areaBelow090)} below 0.9)`);

  const untouched = (k) => ir.V[k] === 0 && Math.abs(latOfRow((k / W8) | 0, H8)) < IR_GATE[0];
  const fits = {
    all: fitGrade(mean8, shipped8, untouched, `every cell equatorward of ${IR_GATE[0]} deg (no infrared layer)`),
    'same-sky': fitGrade(mean8, shipped8, (k) => untouched(k) && blocks.sameSky(k), `the same, in ${SAME_SKY_BLOCK_DEG} deg blocks where composite and shipped correlate >= ${SAME_SKY_R}`),
  };
  for (const [name, fit] of Object.entries(fits)) {
    log(`grade (${name}): a ${fit.a.toFixed(5)}, g ${fit.g.toFixed(5)}, b ${fit.b.toFixed(5)}; rms ${fit.rmsResidualCode.toFixed(2)} codes (before ${fit.rmsBeforeCode.toFixed(2)}); r ${fit.correlationBefore.toFixed(5)} -> ${fit.correlationModel.toFixed(5)}; ${fit.cells} cells`);
  }
  const grade = fits[FIT_DOMAIN];
  if (![grade.a, grade.g, grade.b, grade.rmsResidualCode].every(Number.isFinite) || grade.cells < 1e6) {
    throw new Error(`grade (${FIT_DOMAIN}) did not fit: ${JSON.stringify(grade)}`);
  }
  const rBeforeWholeGlobe = correlation(pass1.mean8, shipped8, W8, H8);
  pass1.mean8 = null;

  // The 8K mean is spent; pass 2 accumulates the graded master into it.
  const pass2 = await layerAndGrade(partial, ir.V, grade, mean8);
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
  const stepsReport = RETOUCH.includes('steps') ? swathSteps(graded8) : null;
  if (stepsReport) log(`swath steps: ${stepsReport.windowsFlagged} windows flagged in ${stepsReport.degreeCellsFlagged} degree cells; worst ${JSON.stringify(stepsReport.worstTen.slice(0, 3))}`);
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
  if (retouchReport || stepsReport) {
    // The joins in the finished master's codes, against the master built
    // without the retouch when it is on disk (the previous report's 11.15).
    const finalJoins = await joinProfile(OUT);
    const compareJoins = existsSync(COMPARE) ? await joinProfile(COMPARE) : null;
    const meanOver = (prof, key, test) => { let s = 0, n = 0; for (const [band, v] of Object.entries(prof)) if (test(parseFloat(band))) { s += v[key]; n++; } return n ? +(s / n).toFixed(2) : null; };
    const summary = (prof) => prof && ({
      datelineUnder49: meanOver(prof, 'dateline', (b) => b >= -50 && b < 50),
      dateline0to30S: meanOver(prof, 'dateline', (b) => b >= -30 && b < 0),
      greenwichUnder49: meanOver(prof, 'greenwich', (b) => b >= -50 && b < 50),
      neighboursUnder49: meanOver(prof, 'datelineNeighbours', (b) => b >= -50 && b < 50),
    });
    report.retouch = {
      ...retouchReport,
      swathSteps: stepsReport,
      finalJoins: { compare: existsSync(COMPARE) ? COMPARE : null, before: compareJoins, after: finalJoins, summaryBefore: summary(compareJoins), summaryAfter: summary(finalJoins), note: 'mean step per 5-degree band across the dateline (columns 43199|0) and Greenwich (21599|21600), with the mean of the 8 neighbouring column pairs, in the finished master; summaries average the 5-degree bands' },
    };
    log(`joins, finished master: before ${JSON.stringify(summary(compareJoins))}, after ${JSON.stringify(summary(finalJoins))}`);
    if (!flag('no-pictures')) report.retouch.pictures = await retouchPictures(COMPARE, retouchSites(report.retouch));
  }
  if (!flag('no-pictures')) report.pictures = await pictures(shipped8);
  report.wallSeconds = (Date.now() - t0) / 1000;
  report.peakRssMB = Math.round(Math.max(peakRss, process.memoryUsage().rss) / 1e6);
  await writeFile(REPORT, JSON.stringify(report, null, 2) + '\n');
  log(`wrote ${OUT}`);
  log(`wrote ${REPORT}`);
  log(`done in ${elapsed()}, peak resident ${report.peakRssMB} MB (sampled at each log line)`);
}

// Run when executed, not when a study script imports the retouch steps.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
