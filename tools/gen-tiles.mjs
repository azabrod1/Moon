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
// A set lives in a folder named for its own contents —
// tiles/<key>/<tier>.<setHash8>/ — so a tile pathname is a promise about the
// bytes behind it: either those exact bytes or a 404, never a re-cut set
// under a name something already cached. Every run rewrites
// tiles/sets.json and src/planetarium/world/sectorSets.generated.ts from the
// folders on disk, which is where the app reads the hashes it puts in URLs.
//
// Prereq (not a package.json dependency — this runs once per asset drop):
//   npm i --no-save sharp
// Usage:
//   node tools/gen-tiles.mjs earth            # one job
//   node tools/gen-tiles.mjs --all            # every job
//   node tools/gen-tiles.mjs earth --verify   # reassemble + gate only
//   node tools/gen-tiles.mjs --index          # re-hash the sets on disk only
//   --cache=<dir>  source cache (default .moon-data-cache)
import sharp from 'sharp';
import { mkdir, writeFile, access, stat, readFile, readdir, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

sharp.cache(false);
sharp.concurrency(0);

const TEX = path.resolve('public/textures');
const TILES = path.join(TEX, 'tiles');
const SETS_JSON = path.join(TILES, 'sets.json');
const GENERATED_TS = path.resolve('src/planetarium/world/sectorSets.generated.ts');
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
/** The source digests the shipped sets were cut from (gen-tiles.sources.json).
 *  A source that fails its digest is refused: the same product re-downloaded
 *  after an upstream change would otherwise re-cut a set silently, and six
 *  months on nobody could say which bytes a tile came from. A source the
 *  manifest does not list is used as is (the WMS cache is many files). */
async function checkSourceDigest(srcPath) {
  const manifest = JSON.parse(await readFile(new URL('./gen-tiles.sources.json', import.meta.url), 'utf8'));
  const entry = manifest[path.basename(srcPath)];
  if (!entry) return;
  const digest = createHash('sha256').update(await readFile(srcPath)).digest('hex');
  if (digest !== entry.sha256) {
    throw new Error(`${path.basename(srcPath)}: sha256 ${digest} is not the manifest's ${entry.sha256} — a different source; update gen-tiles.sources.json together with the assets cut from it`);
  }
}

async function fullRaw(srcPath, matchRef) {
  await checkSourceDigest(srcPath);
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
 * beside a blue ocean. Land never gets that dark: measured on the source,
 * water sits under luminance 12 and land above 22 (the darkest rainforest
 * 25+, with a thin band of dark highland forest reaching down to ~19), so
 * a ramp from 12 to 22 splits them, and a green-over-blue term holds back
 * the forest pixels inside the ramp (New Guinea highlands 13,24,5 -> 0)
 * while the dark lakes mostly keep their score (Superior 9,18,8 keeps 59%
 * of it at full resolution; at 4096 it averages to 0,5,12 and keeps all).
 * SHALLOW: the bright turquoise banks and reef shelves
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

const tileNames = (files) => files.filter((f) => /^\d+_\d+\.webp$/.test(f)).sort();

/**
 * A set's identity: the first 8 hex of a SHA-256 over the sorted
 * `<name>\0<file sha256>\n` list of every tile in it. Over the WHOLE set, so
 * one changed tile moves the folder — a partial re-cut cannot hide under a
 * name a client already has cached.
 */
async function setHash8(dir, files) {
  const h = createHash('sha256');
  for (const name of files) {
    h.update(`${name}\0${createHash('sha256').update(await readFile(path.join(dir, name))).digest('hex')}\n`);
  }
  return h.digest('hex').slice(0, 8);
}

/** The one folder holding a (key, tier) set. */
async function setDir(key, tier) {
  const keyDir = path.join(TILES, key);
  const found = (await readdir(keyDir)).filter((f) => f.split('.')[0] === tier);
  if (found.length !== 1) {
    throw new Error(`${key}: expected one ${tier} set folder, found ${found.join(', ') || 'none'}`);
  }
  return path.join(keyDir, found[0]);
}

/** Move a freshly cut set from its staging folder into the folder its own
 *  hash names, and drop whatever set of that (key, tier) was there before —
 *  the app names exactly one, and two would leave the index nothing to
 *  choose between. */
async function finalizeSet(key, tier, staging) {
  const files = tileNames(await readdir(staging));
  const hash = await setHash8(staging, files);
  const keyDir = path.join(TILES, key);
  for (const folder of await readdir(keyDir)) {
    if (folder.split('.')[0] === tier && folder !== `${tier}.staging`) {
      await rm(path.join(keyDir, folder), { recursive: true, force: true });
    }
  }
  const dir = path.join(keyDir, `${tier}.${hash}`);
  await rename(staging, dir);
  return dir;
}

/**
 * Cut an equirect (w × h, `content` px per sector) into gutter-padded sector
 * images under tiles/<key>/<tier>.<setHash8>/ (key = the base map's file
 * stem, so a re-based map's new name carries its tiles' paths with it): each
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
  // Staged first, moved into place under the hash of what was written: the
  // folder can never name a set that is still half there.
  const staging = path.join(TILES, key, `${tier}.staging`);
  await rm(staging, { recursive: true, force: true });
  let total = 0;
  for (let r = 0; r < GRID.rows; r++) {
    for (let c = 0; c < GRID.cols; c++) {
      const out = path.join(staging, `${c}_${r}.webp`);
      // The left pad is exactly lead + gx, so the crop for column c starts at
      // c·content in padded coordinates whatever its span.
      const pipeline = sharp(padded, { raw: { width: w + 2 * (lead + gx), height: h + 2 * g, channels }, limitInputPixels: false })
        .extract({ left: c * content, top: r * content, width, height });
      await mkdir(path.dirname(out), { recursive: true });
      await pipeline.webp(webpOpts).toFile(out);
      total += (await stat(out)).size;
    }
  }
  const dir = await finalizeSet(key, tier, staging);
  console.log(`  tiles/${key}/${path.basename(dir)}: ${GRID.cols * GRID.rows} × ${width}×${height} ${(total / 1e6).toFixed(1)} MB`);
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
 *  and the lossless boot file drops from 282 KB to 75 KB for it. */
async function deriveEarthRoughness(water) {
  const ROUGH_LAND = 0.92, ROUGH_WATER = 0.45, LEVELS = 16;
  const W = 4096, H = 2048;
  // sharp hands a one-channel raw input back as three channels unless told
  // to keep it grey; a three-channel score read as one scrambles the map.
  const scoreAt = async (w, h) => {
    const score = await sharp(water, { raw: { width: FULL_W, height: FULL_H, channels: 1 }, limitInputPixels: false })
      .resize(w, h, { fit: 'fill', kernel: 'mitchell' }).toColourspace('b-w').raw().toBuffer();
    if (score.length !== w * h) throw new Error(`water score at ${w}x${h}: ${score.length} bytes, not ${w * h}`);
    return score;
  };
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

/** The layout a set on disk actually has, read from its own files. The app
 *  holds the same numbers (world/sectorGrid.ts) and samples tiles through
 *  them, so they are measured here rather than assumed: a set cut at another
 *  gutter or grid has to fail a check, not shift every sector by a few
 *  texels. */
async function describeSet(dir, files) {
  let cols = 0;
  let rows = 0;
  for (const name of files) {
    const [c, r] = name.replace('.webp', '').split('_').map(Number);
    cols = Math.max(cols, c + 1);
    rows = Math.max(rows, r + 1);
  }
  if (files.length !== cols * rows) {
    throw new Error(`${dir}: ${files.length} tiles do not fill a ${cols}x${rows} grid`);
  }
  let size;
  for (const name of files) {
    const { width, height } = await sharp(path.join(dir, name)).metadata();
    if (!size) size = { width, height };
    else if (width !== size.width || height !== size.height) {
      throw new Error(`${dir}: ${name} is ${width}x${height}, not ${size.width}x${size.height}`);
    }
  }
  const gutter = GRID.gutter;
  const content = size.height - 2 * gutter;
  // Width is spanU whole sectors plus the same gutter FRACTION as the height
  // (world/sectorGrid.ts), so the ratio is the span exactly.
  if (size.width % size.height !== 0) {
    throw new Error(`${dir}: ${size.width}x${size.height} is not a whole number of sectors wide`);
  }
  return {
    grid: { cols, rows },
    content,
    gutter,
    tileWidth: size.width,
    tileHeight: size.height,
    baseWidth: content * cols,
    spanU: size.width / size.height,
    fileCount: files.length,
  };
}

/** The generated table the app reads its set hashes from. The object literal
 *  is emitted as JSON between markers so tools/swPlugin.mjs can read the same
 *  table at build time without a TypeScript toolchain. */
function generatedSource(sets) {
  return `/**
 * GENERATED — written by \`node tools/gen-tiles.mjs\` from the tile sets on
 * disk (and mirrored in public/textures/tiles/sets.json). Never edit by hand.
 *
 * A sector tile set is published under a folder named for its own contents,
 * tiles/<key>/<tier>.<setHash8>/, and this table is where the app reads that
 * hash. The set hash is what a tile pathname promises: those exact bytes or a
 * 404, never a re-cut set under a name a cache already holds — which is what
 * lets a tile be cached forever, on a CDN or in the service worker, without a
 * revalidation. The layout numbers are the ones the tiles were measured to
 * have; world/sectorGrid.ts samples them with the same arithmetic and
 * sectorTiles.assets.test.ts holds the two together.
 *
 * The literal below is JSON between its markers so tools/swPlugin.mjs can
 * read the same table at build time without a TypeScript toolchain.
 */

export interface GeneratedSectorSet {
  /** First 8 hex of SHA-256 over the sorted (file name, file SHA-256) list
   *  of the whole set — and the suffix of the folder it lives in. */
  setHash8: string;
  grid: { cols: number; rows: number };
  /** Surface px per sector inside the gutter. */
  content: number;
  gutter: number;
  tileWidth: number;
  tileHeight: number;
  /** Width of the equirect the set was cut from: content × cols. */
  baseWidth: number;
  /** Sectors of longitude one tile spans (normal-map crops: 2). */
  spanU: number;
  fileCount: number;
}

/** Every shipped set, keyed \`<key>/<tier>\`. */
export const SECTOR_SET_TABLE: Record<string, GeneratedSectorSet> = /* table:begin */ ${
    JSON.stringify(sets, null, 2)
  } /* table:end */;
`;
}

/**
 * Rewrite tiles/sets.json and the generated table from the sets on disk,
 * moving any set whose folder name is not its own hash (which is how a set
 * cut before this naming, or edited in place, is adopted).
 */
async function indexSets() {
  const sets = {};
  for (const key of (await readdir(TILES)).sort()) {
    const keyDir = path.join(TILES, key);
    if (!(await stat(keyDir)).isDirectory()) continue;
    for (const folder of (await readdir(keyDir)).sort()) {
      let dir = path.join(keyDir, folder);
      if (!(await stat(dir)).isDirectory()) continue;
      const tier = folder.split('.')[0];
      const files = tileNames(await readdir(dir));
      if (files.length === 0) throw new Error(`${dir}: no tiles`);
      const setHash = await setHash8(dir, files);
      if (folder !== `${tier}.${setHash}`) {
        const moved = path.join(keyDir, `${tier}.${setHash}`);
        await rm(moved, { recursive: true, force: true });
        await rename(dir, moved);
        console.log(`  ${key}/${folder} -> ${tier}.${setHash}`);
        dir = moved;
      }
      const id = `${key}/${tier}`;
      if (sets[id]) throw new Error(`${id}: two set folders — delete the stale one`);
      sets[id] = { setHash8: setHash, ...(await describeSet(dir, files)) };
    }
  }
  await writeFile(SETS_JSON, `${JSON.stringify(sets, null, 2)}\n`);
  await writeFile(GENERATED_TS, generatedSource(sets));
  console.log(`  indexed ${Object.keys(sets).length} sets -> ${path.relative(process.cwd(), SETS_JSON)}`);
}

/** Reassemble the written tiles at 512px each into a 4096x2048 mosaic and
 *  compare it with the boot/4K map: per-channel mean delta and RMS in 0-255
 *  units, the tools/texdiff.mjs thresholds (mean <= 2, RMS <= 6). A tile
 *  written in the wrong slot or orientation fails this by tens of units. */
async function verify(key, refPath) {
  const q = CONTENT / 4; // 508: each sector's content at quarter scale
  const W = GRID.cols * q;
  const H = GRID.rows * q;
  const dir = await setDir(key, '16k');
  const composites = [];
  for (let r = 0; r < GRID.rows; r++) {
    for (let c = 0; c < GRID.cols; c++) {
      const tile = path.join(dir, `${c}_${r}.webp`);
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
if (names.length === 0 && !flag('index')) {
  console.error('usage: node tools/gen-tiles.mjs <job...> | --all | --index  [--verify | --crops] [--cache=dir]');
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
    if (job.derive && job.grade && job.src) await job.derive(job.grade(await fullRaw(job.src(), job.match)));
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
// Always last, whatever ran: the app reads its set hashes out of the
// generated table, so a cut that did not refresh it would leave every URL
// pointing at the set it replaced.
console.log('== index');
await indexSets();
