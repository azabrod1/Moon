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
// sector is exactly the base's relief.
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
 * Ocean grade for the plain Blue Marble NG: its deep water is nearly black
 * (mean ≈ 3,5,20), which in the app's lighting reads as a dark ball with
 * clouds. NASA Eyes ships the same product with its ocean lifted to a
 * saturated blue (≈ 2,30,83, measured on their 4096 faces); this reproduces
 * that. Deep-water pixels — blue-dominant and dark — are shifted by the
 * difference of the two means, through a soft mask so coasts and shallow
 * shelves (brighter, less blue-dominant) blend rather than step. Land, ice
 * and cloud are untouched; the BMNG's own ocean variation survives.
 */
function gradeOceanInPlace(raw) {
  const OCEAN_SRC = [3, 5, 20];
  const OCEAN_DST = [2, 30, 83];
  const shift = OCEAN_DST.map((d, i) => d - OCEAN_SRC[i]);
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  for (let i = 0; i < raw.length; i += 3) {
    const r = raw[i], g = raw[i + 1], b = raw[i + 2];
    const blueDom = clamp01((b - Math.max(r, g) - 4) / 8);
    const dark = clamp01((110 - Math.max(r, g, b)) / 40);
    const m = blueDom * dark;
    if (m <= 0) continue;
    raw[i] = Math.max(0, Math.min(255, Math.round(r + m * shift[0])));
    raw[i + 1] = Math.max(0, Math.min(255, Math.round(g + m * shift[1])));
    raw[i + 2] = Math.max(0, Math.min(255, Math.round(b + m * shift[2])));
  }
}

async function writeWebp(pipeline, out) {
  await mkdir(path.dirname(out), { recursive: true });
  await pipeline.webp(PHOTO_WEBP).toFile(out);
  const size = (await stat(out)).size;
  console.log(`  ${path.relative(TEX, out).padEnd(34)} ${(size / 1024).toFixed(0).padStart(6)} KB`);
  return size;
}

/** Pad an equirect raw buffer by `g` on every side: wrap horizontally (the
 *  left gutter is the map's right edge and vice versa), clamp vertically. */
async function padWrapClamp(raw, w, h, channels, g) {
  const wrapped = await sharp(raw, { raw: { width: w, height: h, channels }, limitInputPixels: false })
    .extend({ left: g, right: g, extendWith: 'repeat' })
    .raw().toBuffer();
  return sharp(wrapped, { raw: { width: w + 2 * g, height: h, channels }, limitInputPixels: false })
    .extend({ top: g, bottom: g, extendWith: 'copy' })
    .raw().toBuffer();
}

/** Cut an equirect (w × h, `content` px per sector) into gutter-padded
 *  sector tiles of `content + 2·gutter` px under tiles/<key>/<tier>/. */
async function cutGrid(raw, w, h, channels, content, key, tier, webpOpts) {
  const g = GRID.gutter;
  if (w !== GRID.cols * content || h !== GRID.rows * content) {
    throw new Error(`${key}: ${w}x${h} is not ${GRID.cols}x${GRID.rows} sectors of ${content}`);
  }
  const padded = await padWrapClamp(raw, w, h, channels, g);
  const size = content + 2 * g;
  let total = 0;
  for (let r = 0; r < GRID.rows; r++) {
    for (let c = 0; c < GRID.cols; c++) {
      const out = path.join(TEX, 'tiles', key, tier, `${c}_${r}.webp`);
      const pipeline = sharp(padded, { raw: { width: w + 2 * g, height: h + 2 * g, channels }, limitInputPixels: false })
        .extract({ left: c * content, top: r * content, width: size, height: size });
      await mkdir(path.dirname(out), { recursive: true });
      await pipeline.webp(webpOpts).toFile(out);
      total += (await stat(out)).size;
    }
  }
  console.log(`  tiles/${key}/${tier}: ${GRID.cols * GRID.rows} × ${size}² ${(total / 1e6).toFixed(1)} MB`);
}

const cutTiles = (raw, key, webpOpts = PHOTO_WEBP) => cutGrid(raw, FULL_W, FULL_H, 3, CONTENT, key, '16k', webpOpts);

/** Data-map crops: the base map (e.g. 2048×1024) cut into sector crops with
 *  the same gutter, losslessly — never resampled, so a sector's relief is
 *  bit-for-bit the base's. `tier` names the base map's tier folder. */
async function cutDataCrops(srcPath, key, tier) {
  const { data, info } = await sharp(srcPath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const content = info.width / GRID.cols;
  await cutGrid(data, info.width, info.height, info.channels, content, key, tier, DATA_WEBP);
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
    key: 'earth-day',
    src: () => path.join(CACHE, 'bmng_200408_21600.jpg'),
    grade: gradeOceanInPlace,
    downsamples: [{ w: 4096, h: 2048, out: path.join(TEX, 'earth-day.webp') }],
    ref: path.join(TEX, 'earth-day.webp'),
    // Run `node gen-maps.mjs earth-roughness` between the boot map and this
    // job so the roughness crops come from the regenerated mask.
    dataCrops: [
      { src: path.join(TEX, 'earth-bump.webp'), key: 'earth-bump', tier: '2k' },
      { src: path.join(TEX, 'earth-roughness.webp'), key: 'earth-roughness', tier: '2k' },
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
    dataCrops: [{ src: path.join(TEX, '4k', 'moon-normal.webp'), key: 'moon-normal', tier: '4k' }],
  },
  // USGS Mars Viking MDIM 2.1 colour mosaic via WMS (what NASA Eyes ships).
  // The service's tone is a muted brown-grey (mean 122,97,95); NASA Eyes
  // grades the same mosaic to a warmer salmon (164,104,90 on their 4096
  // faces), and so does this — the gains are that ratio. The old Solar
  // System Scope map was a far more saturated orange (183,98,71).
  mars: {
    key: 'mars',
    raw: marsRaw,
    grade: gradeGains([164 / 122, 104 / 97, 90 / 95]),
    // The Viking mosaic's grain is not detail: q75 tiles read identically to
    // q85 at 2× (A/B'd on Kasei Valles) for a third fewer bytes (35 → ~22 MB).
    webp: { quality: 75, effort: 5 },
    downsamples: [
      { w: 4096, h: 2048, out: path.join(TEX, '4k', 'mars.webp') },
      { w: 2048, h: 1024, out: path.join(TEX, 'mars.webp') },
    ],
    ref: path.join(TEX, '4k', 'mars.webp'),
    dataCrops: [{ src: path.join(TEX, 'mars-normal.webp'), key: 'mars-normal', tier: '2k' }],
  },
  // Solar System Scope 4K steps for the planets whose 8K/4K sources passed the
  // same-product gate against the shipped 2K boot maps (RMS 3.6 / 1.6 / 1.6).
  mercury: { flat: { src: () => path.join(CACHE, 'sss_8k_mercury.jpg'), out: path.join(TEX, '4k', 'mercury.webp') } },
  venus: { flat: { src: () => path.join(CACHE, 'sss_4k_venus_atmosphere.jpg'), out: path.join(TEX, '4k', 'venus.webp') } },
  saturn: { flat: { src: () => path.join(CACHE, 'sss_8k_saturn.jpg'), out: path.join(TEX, '4k', 'saturn.webp') } },
};

const names = flag('all') ? Object.keys(JOBS) : jobsWanted;
if (names.length === 0) {
  console.error('usage: node tools/gen-tiles.mjs <job...> | --all  [--verify] [--cache=dir]');
  process.exit(2);
}
for (const name of names) {
  const job = JOBS[name];
  if (!job) { console.error(`unknown job ${name}`); process.exit(2); }
  const t0 = Date.now();
  console.log(`== ${name}`);
  if (job.flat) {
    await writeWebp(sharp(job.flat.src(), { limitInputPixels: false }).removeAlpha()
      .resize(4096, 2048, { fit: 'fill', kernel: 'lanczos3' }), job.flat.out);
  } else if (flag('verify')) {
    await verify(job.key, job.ref);
  } else {
    const raw = job.raw ? await job.raw() : await fullRaw(job.src(), job.match);
    if (job.grade) job.grade(raw);
    await writeDownsamples(raw, job.downsamples);
    await cutTiles(raw, job.key, job.webp);
    await verify(job.key, job.ref);
    for (const d of job.dataCrops ?? []) await cutDataCrops(d.src, d.key, d.tier);
  }
  console.log(`  ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
