// Sector tile sets + re-based boot maps for the streamed hero bodies.
//
// A sector set is an 8x4 grid of 2048x2048 WebP tiles (8-px gutter, 2032²
// content) cut from a 16256x8128 equirect: tile {c}_{r} covers longitude
// [-180 + 45c, -135 + 45c] and latitude
// [90 - 45r, 45 - 45r] — column 0 is the western edge of the map, row 0 the
// north — exactly the sub-rectangle of the equirect the same body texture maps
// to, so a sector mesh with GLOBAL equirect UVs and the tile's offset/repeat
// transform samples the identical surface point (world/sectorGrid.ts pins the
// math; `--verify` here reassembles the written tiles and gates them against
// the boot map with the same numbers tools/texdiff.mjs uses).
//
// Every body's boot map, 4K step and tiles come from ONE source in ONE pass,
// so each step up the ladder is a pure sharpen (the same-product rule in
// PlanetFactory's TEXTURE_UPGRADE_TIERS comment). Sources are cached under
// .moon-data-cache/ (gitignored); the Mars source is fetched from the USGS WMS
// as 2048x2048 GetMap tiles (their max is 4096 wide, the 232 m mosaic is 12 GB).
//
// Prereq (not a package.json dependency — this runs once per asset drop):
//   npm i --no-save sharp
// Usage:
//   node tools/gen-tiles.mjs earth            # one job
//   node tools/gen-tiles.mjs --all            # every job
//   node tools/gen-tiles.mjs earth --verify   # reassemble + gate only
//   --cache=<dir>  source cache (default .moon-data-cache)
import sharp from 'sharp';
import { mkdir, writeFile, access, stat } from 'node:fs/promises';
import path from 'node:path';

sharp.cache(false);
sharp.concurrency(0);

const TEX = path.resolve('public/textures');
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const CACHE = path.resolve(opt('cache', '.moon-data-cache'));
const jobsWanted = args.filter((a) => !a.startsWith('--'));

// Colour tiles are 2048² INCLUDING an 8-px gutter on every side (content
// 2032²): bilinear, mip and anisotropic sampling near a sector edge then read
// real neighbouring texels instead of a clamped repeat of the edge row, and
// the sector's UV transform maps onto the tile's interior (world/sectorGrid.ts
// SECTOR_TILE). Horizontal gutters wrap across the ±180° seam; vertical ones
// clamp at the poles. Data-map crops (bump / normal / roughness) are pure
// crops of the base maps with the same 8-px gutter, so the relief under a
// sector is exactly the base's relief; normal-map crops are cut two sectors
// wide so their UV transform is uniform (sectorGrid explains the tangent
// frame reason). Earth's ocean-gloss mask is not a base map but a DERIVED
// one: classified per 16K source pixel (the same classifier that grades the
// ocean colour, so gloss and blue agree at every coast), area-averaged to
// 4096 for its crops and to 2048 for the boot file.
export const GRID = { cols: 8, rows: 4, tile: 2048, gutter: 8 };
const CONTENT = GRID.tile - 2 * GRID.gutter; // 2032
const FULL_W = GRID.cols * CONTENT; // 16256
const FULL_H = GRID.rows * CONTENT; // 8128
const PHOTO_WEBP = { quality: 85, effort: 5 };
const DATA_WEBP = { lossless: true, effort: 5 };

const USGS_MARS_WMS = 'https://planetarymaps.usgs.gov/cgi-bin/mapserv?map=/maps/mars/mars_simp_cyl.map';

const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

/** Per-channel Reinhard transfer of `src` onto `ref`'s mean/std (the
 *  tools/colormatch.mjs recipe, in sharp's linear op: out = k*src + b). Stats
 *  are taken on 2048-wide downsamples — the moments barely move with scale and
 *  a 16K stats pass is minutes for nothing. */
async function colormatchOp(srcPipeline, refPath) {
  const stats = async (p) => {
    const s = await p.clone().resize(2048, 1024, { fit: 'fill', kernel: 'lanczos3' }).removeAlpha().stats();
    return s.channels.slice(0, 3).map((c) => ({ mean: c.mean, std: c.stdev }));
  };
  const [src, ref] = await Promise.all([stats(srcPipeline), stats(sharp(refPath))]);
  const k = src.map((s, i) => ref[i].std / Math.max(s.std, 1e-6));
  const b = src.map((s, i) => ref[i].mean - s.mean * k[i]);
  console.log(`  colormatch k=[${k.map((v) => v.toFixed(3))}] b=[${b.map((v) => v.toFixed(1))}]`);
  return { k, b };
}

/** Decode a source into a 16384x8192 RGB raw buffer (Lanczos), optionally
 *  colour-matched. One decode + resize per job; the tiles are cut from this. */
async function fullRaw(srcPath, matchRef) {
  let p = sharp(srcPath, { limitInputPixels: false }).removeAlpha();
  if (matchRef) {
    const { k, b } = await colormatchOp(p, matchRef);
    p = p.linear(k, b);
  }
  const { data, info } = await p
    .resize(FULL_W, FULL_H, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error(`expected 3 channels, got ${info.channels}`);
  return data;
}

const rawOf = (buf) => sharp(buf, { raw: { width: FULL_W, height: FULL_H, channels: 3 }, limitInputPixels: false });

/**
 * Ocean grade for the plain Blue Marble NG, and the water mask its gloss
 * comes from, in one pass. The product's deep water is nearly black (mean
 * ≈ 3,5,20), which in the app's lighting reads as a dark ball with clouds;
 * NASA Eyes ships the same product with its ocean lifted to a saturated blue
 * (≈ 2,30,83, measured on their 4096 faces), reproduced here by shifting
 * dark-water pixels by the difference of the two means, so the BMNG's own
 * ocean variation survives.
 *
 * Water is classified on the source pixel, two ways. DARK: the flat-ocean
 * product paints every sea and large lake close to black — the open ocean
 * (2,5,20) but also the Persian Gulf, Caspian, Baltic and Yellow Sea at
 * (0,3,4), which a blue-dominance test misses and would leave as black holes
 * beside a blue ocean. Land never gets that dark (the darkest rainforest
 * sits at luminance 25+, water under 12), so a luminance ramp splits them;
 * the greenest of the dark forest pixels, which reach into the ramp, are
 * held back by a green-over-blue term that dark lakes (Superior 9,18,8) do
 * not trip. SHALLOW: the bright turquoise banks and reef shelves
 * (Bahamas 8,127,151) are water too, and gloss over them is the sun glint
 * the real coast shows; blue-over-red finds them, and nothing on land is
 * blue-over-red by more than a few units (ice, snow and salt are neutral).
 * Only the dark class takes the colour shift: the shelves are already lit.
 *
 * Returns the water score per pixel (0..255), full resolution, for the
 * roughness mask.
 */
function gradeOceanInPlace(raw) {
  const OCEAN_SRC = [3, 5, 20];
  const OCEAN_DST = [2, 30, 83];
  const shift = OCEAN_DST.map((d, i) => d - OCEAN_SRC[i]);
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const water = new Uint8Array(raw.length / 3);
  for (let i = 0, p = 0; i < raw.length; i += 3, p++) {
    const r = raw[i], g = raw[i + 1], b = raw[i + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const veg = clamp01((g - b - 8) / 8);
    const dark = clamp01((22 - lum) / 10) * (1 - veg);
    const shallow = clamp01((b - r - 25) / 20);
    water[p] = Math.round(Math.max(dark, shallow) * 255);
    if (dark <= 0) continue;
    raw[i] = Math.max(0, Math.min(255, Math.round(r + dark * shift[0])));
    raw[i + 1] = Math.max(0, Math.min(255, Math.round(g + dark * shift[1])));
    raw[i + 2] = Math.max(0, Math.min(255, Math.round(b + dark * shift[2])));
  }
  return water;
}

async function writeWebp(pipeline, out) {
  await mkdir(path.dirname(out), { recursive: true });
  await pipeline.webp(PHOTO_WEBP).toFile(out);
  const size = (await stat(out)).size;
  console.log(`  ${path.relative(TEX, out).padEnd(34)} ${(size / 1024).toFixed(0).padStart(6)} KB`);
  return size;
}

/** Pad an equirect raw buffer: `gx` px each side horizontally by WRAPPING
 *  (the left pad is the map's right edge and vice versa), `gy` px top and
 *  bottom by clamping. */
async function padWrapClamp(raw, w, h, channels, gx, gy) {
  const wrapped = await sharp(raw, { raw: { width: w, height: h, channels }, limitInputPixels: false })
    .extend({ left: gx, right: gx, extendWith: 'repeat' })
    .raw().toBuffer();
  return sharp(wrapped, { raw: { width: w + 2 * gx, height: h, channels }, limitInputPixels: false })
    .extend({ top: gy, bottom: gy, extendWith: 'copy' })
    .raw().toBuffer();
}

/**
 * Cut an equirect (w × h, `content` px per sector) into gutter-padded sector
 * images under tiles/<key>/<tier>/ (key = the base map's file stem, so a
 * re-based map's new name carries its tiles' paths with it): each
 * `spanU · content + 2·gutter` px wide
 * (the sector plus (spanU−1)/2 of a neighbour each side — normal maps use 2,
 * see world/sectorGrid.ts) and `content + 2·gutter` px tall.
 */
async function cutGrid(raw, w, h, channels, content, key, tier, webpOpts, spanU = 1) {
  const g = GRID.gutter;
  if (w !== GRID.cols * content || h !== GRID.rows * content) {
    throw new Error(`${key}: ${w}x${h} is not ${GRID.cols}x${GRID.rows} sectors of ${content}`);
  }
  const lead = ((spanU - 1) / 2) * content; // px of neighbour before the sector's own edge
  const gx = spanU * g; // horizontal gutter scales with the span: equal gutter FRACTION on both axes
  const padded = await padWrapClamp(raw, w, h, channels, lead + gx, g);
  const width = spanU * (content + 2 * g);
  const height = content + 2 * g;
  let total = 0;
  for (let r = 0; r < GRID.rows; r++) {
    for (let c = 0; c < GRID.cols; c++) {
      const out = path.join(TEX, 'tiles', key, tier, `${c}_${r}.webp`);
      // The left pad is exactly lead + gx, so the crop for column c starts at
      // c·content in padded coordinates whatever its span.
      const pipeline = sharp(padded, { raw: { width: w + 2 * (lead + gx), height: h + 2 * g, channels }, limitInputPixels: false })
        .extract({ left: c * content, top: r * content, width, height });
      await mkdir(path.dirname(out), { recursive: true });
      await pipeline.webp(webpOpts).toFile(out);
      total += (await stat(out)).size;
    }
  }
  console.log(`  tiles/${key}/${tier}: ${GRID.cols * GRID.rows} × ${width}×${height} ${(total / 1e6).toFixed(1)} MB`);
}

const cutTiles = (raw, key, webpOpts = PHOTO_WEBP) => cutGrid(raw, FULL_W, FULL_H, 3, CONTENT, key, '16k', webpOpts);

/** Data-map crops: the base map (e.g. 2048×1024) cut into sector crops with
 *  the same gutter, losslessly — never resampled, so a sector's relief is
 *  bit-for-bit the base's. `tier` names the base map's tier folder. */
async function cutDataCrops(srcPath, key, tier, spanU = 1) {
  const { data, info } = await sharp(srcPath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const content = info.width / GRID.cols;
  await cutGrid(data, info.width, info.height, info.channels, content, key, tier, DATA_WEBP, spanU);
}

/** Earth's roughness map from the water score gradeOceanInPlace returns:
 *  water glossy (0.45 — a broad sun sheen, not a mirror dot), land matte
 *  (0.92), stored in every channel (MeshStandardMaterial reads .g). The
 *  full-resolution score is area-averaged down, so a coast is a soft
 *  fractional edge rather than a stair of 16K texels: to 4096 for the
 *  sector crops (a quarter of the colour tiles' resolution is where the
 *  glint edge stops lagging the coast at any distance the rig allows), and
 *  to 2048 for the boot map the far view samples. The averaged score is
 *  quantised to 16 levels first: a coast edge in 16 steps of 0.03
 *  roughness is indistinguishable from a continuous one under the sheen,
 *  and the lossless boot file drops from 282 KB to 81 KB for it. */
async function deriveEarthRoughness(water) {
  const ROUGH_LAND = 0.92, ROUGH_WATER = 0.45, LEVELS = 16;
  const W = 4096, H = 2048;
  const scoreAt = (w, h) => sharp(water, { raw: { width: FULL_W, height: FULL_H, channels: 1 }, limitInputPixels: false })
    .resize(w, h, { fit: 'fill', kernel: 'mitchell' }).raw().toBuffer();
  const roughOf = (score) => {
    const rough = Buffer.alloc(score.length * 3);
    for (let p = 0; p < score.length; p++) {
      const q = Math.round((score[p] / 255) * (LEVELS - 1)) / (LEVELS - 1);
      const v = Math.round((ROUGH_LAND - q * (ROUGH_LAND - ROUGH_WATER)) * 255);
      rough[3 * p] = v; rough[3 * p + 1] = v; rough[3 * p + 2] = v;
    }
    return rough;
  };
  const out = path.join(TEX, 'earth-roughness.v2.webp');
  await sharp(roughOf(await scoreAt(W / 2, H / 2)), { raw: { width: W / 2, height: H / 2, channels: 3 } })
    .webp(DATA_WEBP).toFile(out);
  console.log(`  ${path.relative(TEX, out).padEnd(34)} ${((await stat(out)).size / 1024).toFixed(0).padStart(6)} KB`);
  await cutGrid(roughOf(await scoreAt(W, H)), W, H, 3, W / GRID.cols, 'earth-roughness.v2', '4k', DATA_WEBP);
}

async function writeDownsamples(raw, outs) {
  for (const { w, h, out } of outs) {
    await writeWebp(rawOf(raw).resize(w, h, { fit: 'fill', kernel: 'lanczos3' }), out);
  }
}

/** Reassemble the written tiles at 512px each into a 4096x2048 mosaic and
 *  compare it with the boot/4K map: per-channel mean delta and RMS in 0-255
 *  units, the tools/texdiff.mjs thresholds (mean <= 2, RMS <= 6). A tile
 *  written in the wrong slot or orientation fails this by tens of units. */
async function verify(key, refPath) {
  const q = CONTENT / 4; // 508: each sector's content at quarter scale
  const W = GRID.cols * q;
  const H = GRID.rows * q;
  const composites = [];
  for (let r = 0; r < GRID.rows; r++) {
    for (let c = 0; c < GRID.cols; c++) {
      const tile = path.join(TEX, 'tiles', key, '16k', `${c}_${r}.webp`);
      composites.push({
        input: await sharp(tile)
          .extract({ left: GRID.gutter, top: GRID.gutter, width: CONTENT, height: CONTENT })
          .resize(q, q, { kernel: 'lanczos3' }).raw().toBuffer(),
        raw: { width: q, height: q, channels: 3 },
        left: c * q,
        top: r * q,
      });
    }
  }
  // composite() always yields an alpha channel; strip it or the stride below
  // reads every pixel off by one channel and the gate fails by ~40 units.
  const mosaic = await sharp({ create: { width: W, height: H, channels: 3, background: '#000' } })
    .composite(composites).removeAlpha().raw().toBuffer();
  const ref = await sharp(refPath).removeAlpha().resize(W, H, { fit: 'fill', kernel: 'lanczos3' }).raw().toBuffer();
  const sum = [0, 0, 0];
  let sq = 0;
  const n = W * H;
  for (let i = 0; i < n; i++) {
    for (let ch = 0; ch < 3; ch++) {
      const d = mosaic[i * 3 + ch] - ref[i * 3 + ch];
      sum[ch] += d;
      sq += d * d;
    }
  }
  const mean = sum.map((s) => s / n);
  const rms = Math.sqrt(sq / (n * 3));
  const ok = mean.every((m) => Math.abs(m) <= 2) && rms <= 6;
  console.log(`  verify ${key}: mean delta [${mean.map((m) => m.toFixed(2))}] RMS ${rms.toFixed(2)} -> ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) process.exitCode = 1;
}

/** Fetch one WMS GetMap tile into the cache (skipped when cached). */
async function wmsTile(base, layer, bbox, w, h, cachePath) {
  if (await exists(cachePath)) return cachePath;
  const url = `${base}&service=WMS&request=GetMap&version=1.1.1&layers=${layer}&styles=&srs=EPSG:4326` +
    `&bbox=${bbox.join(',')}&width=${w}&height=${h}&format=image/png`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (moon planetarium asset build)' } });
    if (res.ok && (res.headers.get('content-type') ?? '').startsWith('image/')) {
      await mkdir(path.dirname(cachePath), { recursive: true });
      await writeFile(cachePath, Buffer.from(await res.arrayBuffer()));
      return cachePath;
    }
    console.log(`  wms ${path.basename(cachePath)} attempt ${attempt}: HTTP ${res.status} ${res.headers.get('content-type')}`);
  }
  throw new Error(`WMS fetch failed: ${url}`);
}

/** Mars source: the 32 sector tiles straight from the WMS at native 2048 (no
 *  resample — the service renders each bbox at exactly the tile size), then
 *  assembled into the same 16K raw buffer so the rest of the pipeline is
 *  body-agnostic (the boot/4K maps are downsamples of the assembled set). */
async function marsRaw() {
  const dir = path.join(CACHE, 'mars-wms');
  const composites = [];
  for (let r = 0; r < GRID.rows; r++) {
    for (let c = 0; c < GRID.cols; c++) {
      const lon0 = -180 + 45 * c;
      const lat1 = 90 - 45 * r;
      // The request size is in the cache name: a cached render of another
      // size would otherwise be read with the wrong row stride and turn the
      // whole map into streaks (it did, once).
      const file = await wmsTile(USGS_MARS_WMS, 'MDIM21_color', [lon0, lat1 - 45, lon0 + 45, lat1],
        CONTENT, CONTENT, path.join(dir, `${c}_${r}_${CONTENT}.png`));
      const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      if (info.width !== CONTENT || info.height !== CONTENT || info.channels !== 3) {
        throw new Error(`${file}: ${info.width}x${info.height}x${info.channels}, expected ${CONTENT}x${CONTENT}x3`);
      }
      composites.push({
        input: data,
        raw: { width: CONTENT, height: CONTENT, channels: 3 },
        left: c * CONTENT,
        top: r * CONTENT,
      });
      process.stdout.write(`  wms tile ${c}_${r}\r`);
    }
  }
  console.log('');
  // composite() adds an alpha channel; the pipeline's raw contract is 3-channel.
  return sharp({ create: { width: FULL_W, height: FULL_H, channels: 3, background: '#000' }, limitInputPixels: false })
    .composite(composites).removeAlpha().raw().toBuffer();
}

/**
 * Per-channel gain grade, for a source whose tone is right in shape but not
 * in level. Multiplicative so black stays black and the albedo contrast is
 * preserved; clipping only touches the brightest ice.
 */
const gradeGains = (gains) => (raw) => {
  for (let i = 0; i < raw.length; i += 3) {
    for (let ch = 0; ch < 3; ch++) {
      const v = raw[i + ch] * gains[ch];
      raw[i + ch] = v > 255 ? 255 : Math.round(v);
    }
  }
};

const JOBS = {
  // Blue Marble Next Generation, August 2004, plain (flat ocean) — the NASA
  // product NASA Eyes ships. 21600x10800 from assets.science.nasa.gov.
  earth: {
    key: 'earth-day.v2',
    src: () => path.join(CACHE, 'bmng_200408_21600.jpg'),
    grade: gradeOceanInPlace,
    // `.v2`: a re-based map ships under a NEW pathname. The service worker
    // serves the previous deploy's body for a pathname it already holds for
    // one boot, and a globe drawn from the old map under tiles cut from the
    // new one would show every sector as a rectangle of a different world.
    downsamples: [{ w: 4096, h: 2048, out: path.join(TEX, 'earth-day.v2.webp') }],
    ref: path.join(TEX, 'earth-day.v2.webp'),
    // The gloss mask and its crops come out of the grade pass (see
    // gradeOceanInPlace), not from a shipped base map.
    derive: deriveEarthRoughness,
    dataCrops: [
      { src: path.join(TEX, 'earth-bump.webp'), key: 'earth-bump', tier: '2k' },
    ],
  },
  // LROC WAC colour (NASA SVS CGI Moon Kit lroc_color_poles_16k.tif), the same
  // albedo product as the shipped 2K/4K, colour-matched to the shipped 4K grade.
  moon: {
    key: 'moon',
    src: () => path.join(CACHE, 'lroc_color_poles_16k.tif'),
    match: path.join(TEX, '4k', 'moon.webp'),
    downsamples: [],
    ref: path.join(TEX, '4k', 'moon.webp'),
    dataCrops: [{ src: path.join(TEX, '4k', 'moon-normal.webp'), key: 'moon-normal', tier: '4k', spanU: 2 }],
  },
  // USGS Mars Viking MDIM 2.1 colour mosaic via WMS (what NASA Eyes ships).
  // The service's tone is a muted brown-grey (mean 122,97,95); NASA Eyes
  // grades the same mosaic to a warmer salmon (164,104,90 on their 4096
  // faces), and so does this — the gains are that ratio. The old Solar
  // System Scope map was a far more saturated orange (183,98,71).
  mars: {
    key: 'mars.v2',
    raw: marsRaw,
    grade: gradeGains([164 / 122, 104 / 97, 90 / 95]),
    // The Viking mosaic's grain is not detail: q75 tiles read identically to
    // q85 at 2× (A/B'd on Kasei Valles) for a third fewer bytes (35 → ~22 MB).
    webp: { quality: 75, effort: 5 },
    downsamples: [
      { w: 4096, h: 2048, out: path.join(TEX, '4k', 'mars.v2.webp') },
      { w: 2048, h: 1024, out: path.join(TEX, 'mars.v2.webp') },
    ],
    ref: path.join(TEX, '4k', 'mars.v2.webp'),
    dataCrops: [{ src: path.join(TEX, 'mars-normal.v2.webp'), key: 'mars-normal.v2', tier: '2k', spanU: 2 }],
  },
  // Solar System Scope 4K steps for the planets whose 8K/4K sources passed the
  // same-product gate against the shipped 2K boot maps (RMS 3.6 / 1.6 / 1.6).
  mercury: { flat: { src: () => path.join(CACHE, 'sss_8k_mercury.jpg'), out: path.join(TEX, '4k', 'mercury.webp') } },
  venus: { flat: { src: () => path.join(CACHE, 'sss_4k_venus_atmosphere.jpg'), out: path.join(TEX, '4k', 'venus.webp') } },
  saturn: { flat: { src: () => path.join(CACHE, 'sss_8k_saturn.jpg'), out: path.join(TEX, '4k', 'saturn.webp') } },
};

const names = flag('all') ? Object.keys(JOBS) : jobsWanted;
if (names.length === 0) {
  console.error('usage: node tools/gen-tiles.mjs <job...> | --all  [--verify | --crops] [--cache=dir]');
  process.exit(2);
}
for (const name of names) {
  const job = JOBS[name];
  if (!job) { console.error(`unknown job ${name}`); process.exit(2); }
  const t0 = Date.now();
  console.log(`== ${name}`);
  if (flag('verify')) {
    // Check only: a flat job has no tile set to verify, and must not be
    // re-encoded by a verification run.
    if (!job.flat) await verify(job.key, job.ref);
  } else if (flag('crops')) {
    // Data crops only: a relief / roughness map changed under an unchanged
    // colour set (the tiles and downsamples are left alone). A derived map
    // needs the graded source again, but not its tiles.
    for (const d of job.dataCrops ?? []) await cutDataCrops(d.src, d.key, d.tier, d.spanU ?? 1);
    if (job.derive) await job.derive(job.grade(await fullRaw(job.src(), job.match)));
  } else if (job.flat) {
    await writeWebp(sharp(job.flat.src(), { limitInputPixels: false }).removeAlpha()
      .resize(4096, 2048, { fit: 'fill', kernel: 'lanczos3' }), job.flat.out);
  } else {
    const raw = job.raw ? await job.raw() : await fullRaw(job.src(), job.match);
    const derived = job.grade ? job.grade(raw) : undefined;
    await writeDownsamples(raw, job.downsamples);
    await cutTiles(raw, job.key, job.webp);
    await verify(job.key, job.ref);
    if (job.derive) await job.derive(derived);
    for (const d of job.dataCrops ?? []) await cutDataCrops(d.src, d.key, d.tier, d.spanU ?? 1);
  }
  console.log(`  ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
