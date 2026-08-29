// Sector tile sets + re-based boot maps for the streamed hero bodies.
//
// A body's surface ships as a PYRAMID of tile sets. Level 0 is an 8x4 grid of
// 2048x2048 WebP tiles (8-px gutter, 2032² content) cut from a 16256x8128
// equirect; level k is the same grid doubled k times, cut from an equirect
// twice as wide again (16x8 of 2032² content = 32512 px). Tile {c}_{r} of a
// level covers longitude [-180 + 360c/cols, -180 + 360(c+1)/cols] and latitude
// [90 - 180r/rows, 90 - 180(r+1)/rows] — column 0 is the western edge of the
// map, row 0 the north — exactly the sub-rectangle of the equirect the same
// body texture maps to, so a sector mesh with GLOBAL equirect UVs and the
// tile's offset/repeat transform samples the identical surface point
// (world/sectorGrid.ts pins the math; `--verify` here reassembles the written
// tiles and gates them against the boot map with the same numbers
// tools/texdiff.mjs uses).
//
// Every body's boot map, 4K step and tiles come from ONE source in ONE pass,
// so each step up the ladder is a pure sharpen (the same-product rule in
// PlanetFactory's TEXTURE_UPGRADE_TIERS comment). Sources are cached under
// .moon-data-cache/ (gitignored); the Mars source is fetched from the USGS WMS
// as 2048x2048 GetMap tiles (their max is 4096 wide, the 232 m mosaic is 12 GB).
//
// A tile's gutter is always its NEIGHBOUR's pixels — wrapping across the ±180°
// seam, clamped at the poles — never a repeat of its own edge: that is what
// lets bilinear, mip and anisotropic sampling read across a sector boundary
// without a visible line. Every level is therefore cut from ONE resampled
// equirect rather than from per-tile resizes of the sources, and for the
// finer levels that equirect is too big to hold (32512x16256 RGB is 1.6 GB),
// so it is built on disk one tile row at a time. Its resample is seamless the
// same way: a source tile is resized inside a halo of its true neighbours,
// and the halo is chosen so the padded piece lands on the SAME sample grid a
// resize of the whole map would have used (see buildMosaicLevelRaw).
//
// A set lives in a folder named for its own contents —
// tiles/<key>/<tier>.<setHash8>/ — so a tile pathname is a promise about the
// bytes behind it: either those exact bytes or a 404, never a re-cut set
// under a name something already cached. The hash itself lives in
// tools/tileSetHash.mjs, shared with tools/publish-tiles.mjs so a set is
// published under the same name it was cut under. Every run rewrites
// <root>/sets.v1.json and src/planetarium/world/sectorSets.generated.ts from
// the folders on disk, which is where the app reads the hashes it puts in URLs.
//
// Every gate here throws, and that is the whole failure discipline: the index
// step at the bottom is what puts a set's name in front of the app, so a gate
// that reported a failure and returned would publish the name of a set that
// failed it. See the Gates section.
//
// Prereq (not a package.json dependency — this runs once per asset drop):
//   npm i --no-save sharp@0.35.4
// Usage:
//   node tools/gen-tiles.mjs earth              # one job, every level it declares
//   node tools/gen-tiles.mjs earth --level=1    # one level of it
//   node tools/gen-tiles.mjs --all              # every job
//   node tools/gen-tiles.mjs earth --verify     # reassemble + gate only
//   node tools/gen-tiles.mjs --index            # re-hash the sets on disk only
//   --cache=<dir>  source cache (default .moon-data-cache)
//   --root=<dir>   tiles root (default public/textures/tiles). A level too
//                  big to ship inside the app is cut into a staging root —
//                  a full tiles root of its own, holding symlinks to the
//                  published level-0 folders plus the new ones — and
//                  `--index --root=<staging>` writes the table from THAT
//                  root, so the app names every set wherever it is served.
import sharp from 'sharp';
import { mkdir, writeFile, access, stat, readFile, readdir, rename, rm, open } from 'node:fs/promises';
import path from 'node:path';
import { fileDigest, setHash8, tileNames } from './tileSetHash.mjs';

sharp.cache(false);
sharp.concurrency(0);

const TEX = path.resolve('public/textures');
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => { const h = args.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const CACHE = path.resolve(opt('cache', '.moon-data-cache'));
const TILES = path.resolve(opt('root', path.join(TEX, 'tiles')));
// Pathname-versioned because it sits inside a service-worker data directory,
// where a file's name has to promise its format (the swPlugin manifest
// invariant): a shape change ships as sets.v2.json.
const SETS_JSON = path.join(TILES, 'sets.v1.json');
const GENERATED_TS = path.resolve('src/planetarium/world/sectorSets.generated.ts');
const jobsWanted = args.filter((a) => !a.startsWith('--'));

// Colour tiles carry an 8-px gutter on every side (content 2032² inside a
// 2048² tile): bilinear, mip and anisotropic sampling near a sector edge then
// read real neighbouring texels instead of a clamped repeat of the edge row,
// and the sector's UV transform maps onto the tile's interior
// (world/sectorGrid.ts SECTOR_TILE). Data-map crops (bump / normal /
// roughness) are pure crops of the base maps with the same gutter, so the
// relief under a sector is exactly the base's relief; normal-map crops are cut
// two sectors wide so their UV transform is uniform (sectorGrid explains the
// tangent frame reason). Earth's ocean-gloss mask is not a base map but a
// DERIVED one: classified per 16K source pixel (the same classifier that
// grades the ocean colour, so gloss and blue agree at every coast),
// area-averaged to 4096 for its crops and to 2048 for the boot file.
const GUTTER = 8;
// The grid every level 0 ships in, and the one every finer level is a
// doubling of (world/sectorGrid.ts SECTOR_GRID_16K).
const GRID_16K = { cols: 8, rows: 4 };
// Surface px per sector inside the gutter, for a colour level of any grid: the
// tile size is fixed at 2048², so the equirect a level is cut from is
// cols × CONTENT wide.
const CONTENT = 2032;
const PHOTO_WEBP = { quality: 85, effort: 5 };
const DATA_WEBP = { lossless: true, effort: 5 };

const USGS_MARS_WMS = 'https://planetarymaps.usgs.gov/cgi-bin/mapserv?map=/maps/mars/mars_simp_cyl.map';

const exists = async (p) => { try { await access(p); return true; } catch { return false; } };
const doubled = (grid, times) => ({ cols: grid.cols * 2 ** times, rows: grid.rows * 2 ** times });
const gridSize = (grid, content) => ({ width: grid.cols * content, height: grid.rows * content });

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

/** The source digests the shipped sets were cut from (gen-tiles.sources.json).
 *  A source that fails its digest is refused: the same product re-downloaded
 *  after an upstream change would otherwise re-cut a set silently, and six
 *  months on nobody could say which bytes a tile came from. A source the
 *  manifest does not list is used as is (the WMS cache is many files).
 *
 *  Streamed, not read whole: the level-1 sources are 45–500 MB each and a
 *  readFile of the set would be gigabytes of resident buffer for a hash. */
async function checkSourceDigest(srcPath) {
  const manifest = JSON.parse(await readFile(new URL('./gen-tiles.sources.json', import.meta.url), 'utf8'));
  const entry = manifest[path.basename(srcPath)];
  if (!entry) return;
  const digest = await fileDigest(srcPath);
  if (digest !== entry.sha256) {
    throw new Error(`${path.basename(srcPath)}: sha256 ${digest} is not the manifest's ${entry.sha256} — a different source; update gen-tiles.sources.json together with the assets cut from it`);
  }
}

async function fullRaw(srcPath, width, height, matchRef) {
  await checkSourceDigest(srcPath);
  let p = sharp(srcPath, { limitInputPixels: false }).removeAlpha();
  if (matchRef) {
    const { k, b } = await colormatchOp(p, matchRef);
    p = p.linear(k, b);
  }
  const { data, info } = await p
    .resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error(`expected 3 channels, got ${info.channels}`);
  return data;
}

const rawOf = (buf, width, height) => sharp(buf, { raw: { width, height, channels: 3 }, limitInputPixels: false });

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
 * Every term is a function of one pixel, so a band of a finer level grades
 * exactly as the whole map would — which is what lets a child's water match
 * its parent's without either being graded against the other.
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

/**
 * Black Marble's no-data fill, keyed on the SOURCE pixels and replaced with
 * the map's own background.
 *
 * The VIIRS composite has no night-lights data over Antarctica and paints it
 * a flat blue. On an additive night shell that draws as a bright cap over a
 * continent that should be dark — 10 % of the map, from -70.3 deg to the pole,
 * with 137 stray pixels in the north and none at the north cap, which is
 * ordinary background.
 *
 * Measured on the 500 m tifs, the fill is not one colour but FOUR, in a fixed
 * 2x2 chroma dither: (43,51,85), (42,50,84), (43,50,84), (43,51,84) and
 * nothing else — 100 % of three Antarctic samples 400 px across, taken a
 * hemisphere apart. The background dithers the same way, around (4,5,14)
 * (mid-ocean and the Arctic: (3,4,14), (4,5,15), (4,5,14), (3,5,14)), which
 * is what a masked pixel becomes: the value the map's own open ocean
 * resamples to, so the cap joins the sea instead of becoming a black
 * silhouette against it — the same artifact the other way round.
 *
 * The key is those four values and nothing near them. Greenland's ice sheet
 * is the nearest thing on the map, at (41,49,80)-(42,50,81): three counts
 * away in blue, and a tolerance wide enough to be comfortable about the fill
 * would start taking the ice. There is no latitude band either — the fill is
 * a continent, not a cap, and a +/-85 deg rule would leave 15 deg of blue at
 * the south while zeroing Arctic OCEAN that was never no-data.
 *
 * It runs on source pixels, before the resample, so no target pixel is ever
 * a blend of fill and ground: a mask applied afterwards would have to key
 * blended values, and 3.6 % of the resampled cap sits a count off the fill
 * colour from the dither alone.
 */
const BLACK_MARBLE_NODATA = [
  [43, 51, 85], [42, 50, 84], [43, 50, 84], [43, 51, 84],
];
const BLACK_MARBLE_BACKGROUND = [
  [3, 4, 14], [4, 5, 15], [4, 5, 14], [3, 5, 14],
];
/** What the four background values average to, and what a region of them
 *  resamples to: the value the masked cap has to read as. */
const BLACK_MARBLE_BACKGROUND_MEAN = [4, 5, 14];

/** Fill dither in, background dither out, value for value. Not one flat
 *  colour: the encoder quantises a dead-flat field differently from a dithered
 *  one, and a flat patch of the background's mean came back two counts of blue
 *  away from the sea beside it in the 4K rung. Swapping the pattern instead
 *  leaves the cap statistically identical to open water. */
function maskNoDataInPlace(raw) {
  let hits = 0;
  for (let i = 0; i < raw.length; i += 3) {
    const r = raw[i], g = raw[i + 1], b = raw[i + 2];
    for (let k = 0; k < BLACK_MARBLE_NODATA.length; k++) {
      const [fr, fg, fb] = BLACK_MARBLE_NODATA[k];
      if (r !== fr || g !== fg || b !== fb) continue;
      const [br, bg, bb] = BLACK_MARBLE_BACKGROUND[k];
      raw[i] = br; raw[i + 1] = bg; raw[i + 2] = bb;
      hits++;
      break;
    }
  }
  return hits;
}

/** Within a count of the fill on every channel. Not a test for the fill on its
 *  own — Greenland's ice sheet resamples to the same neighbourhood, which is
 *  the whole reason the key is exact — but a measure of how much of the map is
 *  that colour: 10 % before the mask, 0.007 % after, and what is left is
 *  Greenland. */
function nearNoData(r, g, b) {
  const [fr, fg, fb] = BLACK_MARBLE_NODATA[0];
  return Math.abs(r - fr) <= 1 && Math.abs(g - fg) <= 1 && Math.abs(b - fb) <= 1;
}

/** Above this fraction of the map, the fill-coloured pixels are the fill and
 *  not the ice sheets: an unmasked cut is 10 %, a masked one 0.007 %. */
const NODATA_RESIDUE_MAX = 0.0005;

/** The first row of a `height`-row equirect at or below 80 deg south — the
 *  latitude past which the composite is nothing but no-data fill. Every level
 *  cut here is a full-sphere 2:1 equirect, which is the only shape this
 *  arithmetic is right for; a latitude-cropped product would have to say so
 *  rather than have the gate silently measure the wrong band. */
const antarcticRow = (width, height) => {
  if (width !== 2 * height) throw new Error(`polar band: ${width}x${height} is not a full-sphere 2:1 equirect`);
  return Math.ceil(((90 + 80) / 180) * height);
};

/**
 * The mask ran, asserted on the pixels every artifact of this cut is made
 * from. Two measurements, because the fill is a place as well as a colour:
 * below 80 deg south the composite is nothing BUT fill, so after the mask that
 * band is the background and nothing else; and over the whole map the
 * fill-coloured pixels drop from 10 % to a rounding error, all of it Greenland
 * ice the exact key deliberately spares. This is the one step of the night cut
 * with nothing downstream to notice it was skipped — a set cut without it
 * looks plausible everywhere except over a continent nobody photographs.
 */
function noDataGateRaw(raw, width, height, what) {
  const [r1, g1, b1] = BLACK_MARBLE_BACKGROUND_MEAN;
  let left = 0;
  for (let i = 0; i < raw.length; i += 3) {
    if (nearNoData(raw[i], raw[i + 1], raw[i + 2])) left++;
  }
  const y0 = antarcticRow(width, height);
  let notBackground = 0;
  for (let y = y0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      // A count of slack: a resample of a flat field rounds.
      if (Math.abs(raw[i] - r1) > 1 || Math.abs(raw[i + 1] - g1) > 1 || Math.abs(raw[i + 2] - b1) > 1) notBackground++;
    }
  }
  const band = (height - y0) * width;
  const residue = left / (width * height);
  if (notBackground > 0 || residue > NODATA_RESIDUE_MAX) {
    throw new Error(`${what}: ${notBackground} of ${band} px below 80S are not ${BLACK_MARBLE_BACKGROUND_MEAN} and ${(100 * residue).toFixed(3)} % of the map is within a count of ${BLACK_MARBLE_NODATA[0]} — the no-data mask did not run`);
  }
  console.log(`  no-data gate ${what.padEnd(26)} PASS (${band} px below 80S all background; ${left} px (${(100 * residue).toFixed(4)} %) near the fill colour, the ice sheets)`);
}

/**
 * And the same thing seen on a file the app actually draws. Not against a
 * fixed value — a lossy encode of a flat navy field comes back a couple of
 * counts off, and by a different couple at each size — but against the map's
 * OWN open ocean, read out of the same file: after the mask Antarctica has to
 * read like empty sea and nothing like the fill.
 */
async function polarBandGate(file) {
  const { data, info } = await sharp(file, { limitInputPixels: false })
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const meanOf = (x0, y0, x1, y1) => {
    const m = [0, 0, 0];
    let n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * info.width + x) * 3;
        m[0] += data[i]; m[1] += data[i + 1]; m[2] += data[i + 2];
        n++;
      }
    }
    return m.map((v) => v / n);
  };
  const cap = meanOf(0, antarcticRow(info.width, info.height), info.width, info.height);
  // Mid-Pacific, 5 deg either side of the equator: the emptiest water there is.
  const sea = meanOf(
    Math.round(info.width * ((-170 + 180) / 360)), Math.round(info.height * (85 / 180)),
    Math.round(info.width * ((-150 + 180) / 360)), Math.round(info.height * (95 / 180)),
  );
  const off = Math.max(...cap.map((v, k) => Math.abs(v - sea[k])));
  const fromFill = Math.max(...cap.map((v, k) => Math.abs(v - BLACK_MARBLE_NODATA[0][k])));
  const name = path.relative(TEX, file);
  const say = (m) => m.map((v) => v.toFixed(1)).join(',');
  if (off > 1) {
    throw new Error(`${name}: below 80S the mean is (${say(cap)}) against open ocean at (${say(sea)}) — ${off.toFixed(1)} counts apart, and the no-data fill is ${say(BLACK_MARBLE_NODATA[0].map(Number))}`);
  }
  console.log(`  polar band  ${name.padEnd(26)} PASS (cap ${say(cap)} vs ocean ${say(sea)}, ${off.toFixed(1)} counts apart; ${fromFill.toFixed(0)} from the fill)`);
}

/**
 * And the same thing on the TILES of one level, which is the only way a level
 * past the first can be checked at all: its equirect is gigabytes and the
 * whole-map gate above needs the whole map in memory. The bottom row of a cut
 * holds every pixel below 80 deg south, so the band is read out of those
 * tiles' own bytes: after the mask it is the map's background and holds not
 * one pixel of the fill. The tolerance is 3 counts against a fixed value
 * rather than the 1 the raw gate uses — a lossy encode of a flat dithered
 * field lands a couple of counts off, and by a different couple at each size
 * (the 16K tiles come back at 4,5,14 for the 4,5,16 they were cut from).
 */
async function polarTileGate(key, tier, grid, content) {
  const dir = await setDir(key, tier);
  const { width, height } = gridSize(grid, content);
  const tileW = content + 2 * GUTTER;
  // The gate's band, in rows of the bottom tile's own image: its content
  // starts one gutter in, and carries the level's last `content` rows.
  const y0 = GUTTER + Math.max(0, antarcticRow(width, height) - (grid.rows - 1) * content);
  const mean = [0, 0, 0];
  let n = 0;
  let fill = 0;
  for (let c = 0; c < grid.cols; c++) {
    const file = path.join(dir, `${c}_${grid.rows - 1}.webp`);
    const data = await sharp(file, { limitInputPixels: false }).removeAlpha().raw().toBuffer();
    for (let y = y0; y < GUTTER + content; y++) {
      for (let x = GUTTER; x < GUTTER + content; x++) {
        const i = (y * tileW + x) * 3;
        mean[0] += data[i]; mean[1] += data[i + 1]; mean[2] += data[i + 2];
        if (nearNoData(data[i], data[i + 1], data[i + 2])) fill++;
        n++;
      }
    }
  }
  const say = (m) => m.map((v) => v.toFixed(1)).join(',');
  const band = mean.map((v) => v / n);
  const off = Math.max(...band.map((v, k) => Math.abs(v - BLACK_MARBLE_BACKGROUND_MEAN[k])));
  if (off > 3 || fill > 0) {
    throw new Error(`${key}/${tier}: below 80S the tiles mean (${say(band)}) against the map's background at (${say(BLACK_MARBLE_BACKGROUND_MEAN)}) with ${fill} of ${n} px still within a count of the fill ${BLACK_MARBLE_NODATA[0]} — the no-data mask did not reach this level`);
  }
  console.log(`  polar tiles ${`${key}/${tier}`.padEnd(26)} PASS (${n} px below 80S mean ${say(band)}, ${off.toFixed(1)} off the background; ${fill} near the fill)`);
}

async function writeWebp(pipeline, out) {
  await mkdir(path.dirname(out), { recursive: true });
  await pipeline.webp(PHOTO_WEBP).toFile(out);
  const size = (await stat(out)).size;
  console.log(`  ${path.relative(TEX, out).padEnd(34)} ${(size / 1024).toFixed(0).padStart(6)} KB`);
  return size;
}

// ---------------------------------------------------------------------------
// Row sources: an equirect read by row band
// ---------------------------------------------------------------------------

/**
 * The pixels of one equirect, addressed by row band — the one thing the tile
 * cutter needs of a level's image, so a level whose equirect fits in memory
 * (level 0's, which the downsamples and the derived maps are made from) and
 * one that does not (32512x16256 RGB is 1.6 GB, on disk) are cut by the same
 * code.
 *
 * `read(y0, rows)` may ask for rows above the north pole or below the south:
 * those CLAMP to the edge row, which is what a tile's vertical gutter is
 * padded with — the pole is a point, so there is no neighbour to wrap to.
 * Longitude wrapping is the cutter's job, because only it knows where a tile's
 * columns fall.
 */
function memoryRows(raw, width, height, channels) {
  const stride = width * channels;
  return {
    width,
    height,
    channels,
    read(y0, rows) {
      const out = Buffer.allocUnsafe(rows * stride);
      for (let i = 0; i < rows; i++) {
        const y = Math.max(0, Math.min(height - 1, y0 + i));
        raw.copy(out, i * stride, y * stride, (y + 1) * stride);
      }
      return out;
    },
  };
}

function memoryRowSource(raw, width, height, channels = 3) {
  const rows = memoryRows(raw, width, height, channels);
  return { ...rows, whole: async () => raw, close: async () => {} };
}

/** The same, over a raw file — how a level too big to hold is read. */
async function fileRowSource(file, width, height, channels = 3) {
  const stride = width * channels;
  const fd = await open(file, 'r');
  const size = (await fd.stat()).size;
  if (size !== stride * height) {
    throw new Error(`${file}: ${size} bytes is not ${width}x${height}x${channels}`);
  }
  return {
    width,
    height,
    channels,
    close: () => fd.close(),
    whole: () => readAt(fd, 0, stride * height),
    async read(y0, rows) {
      const out = Buffer.allocUnsafe(rows * stride);
      let i = 0;
      while (i < rows) {
        const y = y0 + i;
        if (y >= 0 && y < height) {
          // Rows inside the image are contiguous on disk, so a whole run of
          // them is one read.
          const run = Math.min(rows - i, height - y);
          await fd.read(out, i * stride, run * stride, y * stride);
          i += run;
        } else {
          // Above the north pole or below the south: the edge row, repeated.
          const edge = y < 0 ? 0 : height - 1;
          await fd.read(out, i * stride, stride, edge * stride);
          i += 1;
        }
      }
      return out;
    },
  };
}

async function readAt(fd, position, length) {
  const buf = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await fd.read(buf, read, Math.min(length - read, 1 << 30), position + read);
    if (bytesRead === 0) throw new Error('short read');
    read += bytesRead;
  }
  return buf;
}

// ---------------------------------------------------------------------------
// The tile cutter
// ---------------------------------------------------------------------------

/**
 * Cut one level's equirect into gutter-padded tiles under
 * tiles/<key>/<tier>.<setHash8>/ (key = the base map's file stem, so a
 * re-based map's new name carries its tiles' paths with it): each
 * `spanU · content + 2·gutter` px wide (the sector plus (spanU−1)/2 of a
 * neighbour each side — normal maps use 2, see world/sectorGrid.ts) and
 * `content + 2·gutter` px tall.
 *
 * One row band is read at a time: a level-1 band is 32512 × 2048 px, and the
 * whole equirect would be 1.6 GB. Columns wrap across the ±180° seam, rows
 * clamp at the poles (the row source does that), so every tile's gutter is
 * the surface that actually adjoins it.
 */
async function cutGrid(rows, grid, content, key, tier, webpOpts, spanU = 1) {
  const { width, height } = gridSize(grid, content);
  if (rows.width !== width || rows.height !== height) {
    throw new Error(`${key}/${tier}: rows are ${rows.width}x${rows.height}, not ${grid.cols}x${grid.rows} sectors of ${content}`);
  }
  const ch = rows.channels;
  const lead = ((spanU - 1) / 2) * content; // px of neighbour before the sector's own edge
  const gx = spanU * GUTTER; // horizontal gutter scales with the span: equal gutter FRACTION on both axes
  const tileW = spanU * (content + 2 * GUTTER);
  const tileH = content + 2 * GUTTER;
  // Staged first, moved into place under the hash of what was written: the
  // folder can never name a set that is still half there.
  const staging = path.join(TILES, key, `${tier}.staging`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  let total = 0;
  for (let r = 0; r < grid.rows; r++) {
    const band = await rows.read(r * content - GUTTER, tileH);
    const bandStride = width * ch;
    for (let c = 0; c < grid.cols; c++) {
      const x0 = c * content - lead - gx;
      const tile = Buffer.allocUnsafe(tileW * tileH * ch);
      for (let y = 0; y < tileH; y++) {
        const src = y * bandStride;
        const dst = y * tileW * ch;
        // Longitude wraps: copy the run that stays inside the map, then start
        // again at the far edge. Two runs at most, because a tile plus its
        // gutter is narrower than the map.
        let x = ((x0 % width) + width) % width;
        let done = 0;
        while (done < tileW) {
          const run = Math.min(tileW - done, width - x);
          band.copy(tile, dst + done * ch, src + x * ch, src + (x + run) * ch);
          done += run;
          x = (x + run) % width;
        }
      }
      const out = path.join(staging, `${c}_${r}.webp`);
      await sharp(tile, { raw: { width: tileW, height: tileH, channels: ch }, limitInputPixels: false })
        .webp(webpOpts).toFile(out);
      total += (await stat(out)).size;
    }
    process.stdout.write(`  cut ${key}/${tier} row ${r + 1}/${grid.rows}\r`);
  }
  const dir = await finalizeSet(key, tier, staging);
  console.log(`  tiles/${key}/${path.basename(dir)}: ${grid.cols * grid.rows} × ${tileW}×${tileH} ${(total / 1e6).toFixed(1)} MB`);
  return { dir, bytes: total };
}

/** Data-map crops: the base map (e.g. 2048×1024) cut into sector crops with
 *  the same gutter, losslessly — never resampled, so a sector's relief is
 *  bit-for-bit the base's. Crops belong to level 0, whose grid they are cut
 *  on. `tier` names the base map's tier folder. */
async function cutDataCrops(srcPath, key, tier, spanU = 1) {
  const { data, info } = await sharp(srcPath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const content = info.width / GRID_16K.cols;
  const rows = memoryRows(data, info.width, info.height, info.channels);
  await cutGrid(rows, GRID_16K, content, key, tier, DATA_WEBP, spanU);
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
async function deriveEarthRoughness(water, srcWidth, srcHeight) {
  const ROUGH_LAND = 0.92, ROUGH_WATER = 0.45, LEVELS = 16;
  const W = 4096, H = 2048;
  // sharp hands a one-channel raw input back as three channels unless told
  // to keep it grey; a three-channel score read as one scrambles the map.
  const scoreAt = async (w, h) => {
    const score = await sharp(water, { raw: { width: srcWidth, height: srcHeight, channels: 1 }, limitInputPixels: false })
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
  const rough = roughOf(await scoreAt(W, H));
  await cutGrid(memoryRows(rough, W, H, 3), GRID_16K, W / GRID_16K.cols, 'earth-roughness.v2', '4k', DATA_WEBP);
}

async function writeDownsamples(raw, width, height, outs) {
  for (const { w, h, out } of outs) {
    await writeWebp(rawOf(raw, width, height).resize(w, h, { fit: 'fill', kernel: 'lanczos3' }), out);
  }
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
  // Against the level ladder, not against itself: the highest indices only say
  // how far the tiles that exist reach, so a set missing its whole last column
  // measures as a complete 7x4 and would publish a layout the app then samples
  // every sector with. A level is the 8x4 grid doubled a whole number of
  // times, and no deeper than the app can build a mesh for
  // (sectorStreamer's SECTOR_MAX_LEVEL).
  const level = Math.log2(cols / GRID_16K.cols);
  if (!Number.isInteger(level) || level < 0 || level > MAX_LEVEL || rows !== GRID_16K.rows * 2 ** level) {
    throw new Error(`${dir}: ${cols}x${rows} tiles, not the ${GRID_16K.cols}x${GRID_16K.rows} grid doubled 0..${MAX_LEVEL} times`);
  }
  let size;
  for (const name of files) {
    const { width, height } = await sharp(path.join(dir, name)).metadata();
    if (!size) size = { width, height };
    else if (width !== size.width || height !== size.height) {
      throw new Error(`${dir}: ${name} is ${width}x${height}, not ${size.width}x${size.height}`);
    }
  }
  const content = size.height - 2 * GUTTER;
  // Width is spanU whole sectors plus the same gutter FRACTION as the height
  // (world/sectorGrid.ts), so the ratio is the span exactly.
  if (size.width % size.height !== 0) {
    throw new Error(`${dir}: ${size.width}x${size.height} is not a whole number of sectors wide`);
  }
  return {
    grid: { cols, rows },
    content,
    gutter: GUTTER,
    tileWidth: size.width,
    tileHeight: size.height,
    baseWidth: content * cols,
    spanU: size.width / size.height,
    fileCount: files.length,
  };
}

/** The deepest level a set may be cut at — the same ceiling
 *  world/sectorStreamer.ts refuses a spec above, because a sector's mesh
 *  halves its segments per level and runs out of lattice below it. */
const MAX_LEVEL = 2;

/** The generated table the app reads its set hashes from. The object literal
 *  is emitted as JSON between markers so tools/swPlugin.mjs can read the same
 *  table at build time without a TypeScript toolchain. */
function generatedSource(sets) {
  return `/**
 * GENERATED — written by \`node tools/gen-tiles.mjs\` from the tile sets on
 * disk (and mirrored in that tiles root's sets.v1.json). Never edit by hand.
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
 * Rewrite the tiles root's sets.v1.json and the generated table from the sets
 * on disk, moving any set whose folder name is not its own hash (which is how
 * a set cut before this naming, or edited in place, is adopted).
 */
async function indexSets() {
  // Every folder is hashed before any of them is moved. A rename is a
  // destructive operation on a sibling's name, so the two folders of one
  // <key>/<tier> have to be caught while both are still on disk — renaming
  // as we walk would delete whichever folder already held the real hash name
  // and leave the run to die on the missing directory.
  const found = [];
  const byId = new Map();
  for (const key of (await readdir(TILES)).sort()) {
    const keyDir = path.join(TILES, key);
    if (!(await stat(keyDir)).isDirectory()) continue;
    for (const folder of (await readdir(keyDir)).sort()) {
      const dir = path.join(keyDir, folder);
      if (!(await stat(dir)).isDirectory()) continue;
      const tier = folder.split('.')[0];
      const files = tileNames(await readdir(dir));
      if (files.length === 0) throw new Error(`${dir}: no tiles`);
      const id = `${key}/${tier}`;
      const seen = byId.get(id);
      if (seen) {
        throw new Error(`${id}: two set folders, ${seen} and ${folder} — delete the stale one`);
      }
      byId.set(id, folder);
      // Hash and measure while nothing has moved: a set that fails its grid
      // or dimension check must fail with its folder where it was found, not
      // already renamed to a content hash that names a broken set.
      found.push({
        id, key, tier, folder, keyDir, dir, files,
        setHash: await setHash8(dir, files),
        layout: await describeSet(dir, files),
      });
    }
  }

  const sets = {};
  for (const set of found) {
    if (set.folder !== `${set.tier}.${set.setHash}`) {
      await rename(set.dir, path.join(set.keyDir, `${set.tier}.${set.setHash}`));
      console.log(`  ${set.key}/${set.folder} -> ${set.tier}.${set.setHash}`);
    }
    sets[set.id] = { setHash8: set.setHash, ...set.layout };
  }
  await writeFile(SETS_JSON, `${JSON.stringify(sets, null, 2)}\n`);
  await writeFile(GENERATED_TS, generatedSource(sets));
  console.log(`  indexed ${Object.keys(sets).length} sets -> ${path.relative(process.cwd(), SETS_JSON)}`);
}

// ---------------------------------------------------------------------------
// Gates
//
// One failure discipline for all of them, geometry and no-data alike: a gate
// that does not pass throws, and the run stops there.
//
// It has to. A set is renamed into the folder its own hash names as soon as it
// is cut (finalizeSet), and the last thing every run does — whatever ran, and
// whether or not anything was cut — is write the folders on disk into
// sets.v1.json and into the table the app reads its URLs out of. A gate that
// merely flagged a failure and let the run continue would reach that index
// step, so the app would name, and a CDN would cache forever, a set whose own
// check said its tiles are in the wrong places. A content address is a promise
// about bytes; it cannot be handed out over bytes nothing vouches for.
//
// The cost is that a failing run reports the first bad gate rather than all of
// them. Re-run with --verify after a fix: it re-checks without re-encoding.
// ---------------------------------------------------------------------------

/** Per-channel mean delta and RMS between two equal-size RGB rasters, in
 *  0-255 units — the tools/texdiff.mjs numbers, thresholds mean <= 2,
 *  RMS <= 6. */
function rasterDiff(a, b, pixels) {
  const sum = [0, 0, 0];
  let sq = 0;
  let worst = 0;
  for (let i = 0; i < pixels; i++) {
    for (let ch = 0; ch < 3; ch++) {
      const d = a[i * 3 + ch] - b[i * 3 + ch];
      sum[ch] += d;
      sq += d * d;
      const abs = d < 0 ? -d : d;
      if (abs > worst) worst = abs;
    }
  }
  const mean = sum.map((s) => s / pixels);
  const rms = Math.sqrt(sq / (pixels * 3));
  return { mean, rms, worst, ok: mean.every((m) => Math.abs(m) <= 2) && rms <= 6 };
}

/** Reassemble a level's written tiles into a mosaic at quarter of a LEVEL-0
 *  sector's content — 4064x2032 whatever the level, which is the scale the
 *  boot/4K map it is compared against actually carries — and gate the two with
 *  the texdiff numbers. A tile written in the wrong slot or orientation fails
 *  this by tens of units. Comparing a finer level at its own resolution would
 *  instead measure the detail it was cut to add. */
async function verify(key, tier, grid, content, refPath) {
  const q = (content / 4) / (grid.cols / GRID_16K.cols);
  if (!Number.isInteger(q)) throw new Error(`${key}/${tier}: ${grid.cols}x${grid.rows} of ${content} has no whole-pixel quarter-scale mosaic`);
  const W = grid.cols * q;
  const H = grid.rows * q;
  const dir = await setDir(key, tier);
  const composites = [];
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const tile = path.join(dir, `${c}_${r}.webp`);
      composites.push({
        input: await sharp(tile)
          .extract({ left: GUTTER, top: GUTTER, width: content, height: content })
          .resize(q, q, { kernel: 'lanczos3' }).raw().toBuffer(),
        raw: { width: q, height: q, channels: 3 },
        left: c * q,
        top: r * q,
      });
    }
  }
  // composite() always yields an alpha channel; strip it or the stride below
  // reads every pixel off by one channel and the gate fails by ~40 units.
  const mosaic = await sharp({ create: { width: W, height: H, channels: 3, background: '#000' }, limitInputPixels: false })
    .composite(composites).removeAlpha().raw().toBuffer();
  const ref = await sharp(refPath, { limitInputPixels: false })
    .removeAlpha().resize(W, H, { fit: 'fill', kernel: 'lanczos3' }).raw().toBuffer();
  const d = rasterDiff(mosaic, ref, W * H);
  console.log(`  verify ${key}/${tier}: mean delta [${d.mean.map((m) => m.toFixed(2))}] RMS ${d.rms.toFixed(2)} -> ${d.ok ? 'PASS' : 'FAIL'}`);
  if (!d.ok) {
    throw new Error(`${key}/${tier}: the tiles reassemble to mean [${d.mean.map((m) => m.toFixed(2))}] RMS ${d.rms.toFixed(2)} against ${path.relative(process.cwd(), refPath)} (limits 2 and 6) — a tile is in the wrong slot or the wrong orientation`);
  }
}

/**
 * Every tile's gutter against the neighbour it claims to hold. A gutter is
 * the adjoining sector's first 8 columns (or rows) of content, so the two
 * agree pixel for pixel up to WebP's own loss — while a gutter faked from a
 * per-tile resize (a repeat of the tile's own edge, or a lanczos clamp) is
 * off by tens of units at any coastline. A whole-level RMS is blind to a
 * 3-px band; this is not. Longitude wraps, so the seam at ±180° is checked
 * like any other; the poles have no neighbour and are skipped.
 */
async function seamGate(key, tier, grid, content) {
  const dir = await setDir(key, tier);
  const tileW = content + 2 * GUTTER;
  const raw = async (c, r) => sharp(path.join(dir, `${c}_${r}.webp`)).removeAlpha().raw().toBuffer();
  // A gutter strip against the content strip it mirrors: mean |Δ| per channel.
  const strip = (buf, x0, y0, w, h) => {
    const out = Buffer.allocUnsafe(w * h * 3);
    for (let y = 0; y < h; y++) {
      buf.copy(out, y * w * 3, ((y0 + y) * tileW + x0) * 3, ((y0 + y) * tileW + x0 + w) * 3);
    }
    return out;
  };
  const meanAbs = (a, b) => {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
    return s / a.length;
  };
  let worstV = 0;
  let worstH = 0;
  let worstAt = '';
  for (let r = 0; r < grid.rows; r++) {
    const row = [];
    for (let c = 0; c < grid.cols; c++) row.push(await raw(c, r));
    for (let c = 0; c < grid.cols; c++) {
      const next = (c + 1) % grid.cols;
      // The right gutter of c is the first GUTTER content columns of c+1.
      const d = meanAbs(
        strip(row[c], content + GUTTER, GUTTER, GUTTER, content),
        strip(row[next], GUTTER, GUTTER, GUTTER, content),
      );
      if (d > worstV) { worstV = d; worstAt = `${c}_${r}|${next}_${r}`; }
    }
    if (r + 1 < grid.rows) {
      for (let c = 0; c < grid.cols; c++) {
        const below = await raw(c, r + 1);
        const d = meanAbs(
          strip(row[c], GUTTER, content + GUTTER, content, GUTTER),
          strip(below, GUTTER, GUTTER, content, GUTTER),
        );
        if (d > worstH) { worstH = d; worstAt = `${c}_${r}|${c}_${r + 1}`; }
      }
    }
  }
  const limit = 3;
  const ok = worstV <= limit && worstH <= limit;
  console.log(`  seams ${key}/${tier}: worst mean |Δ| vertical ${worstV.toFixed(2)} horizontal ${worstH.toFixed(2)} (${worstAt}) -> ${ok ? 'PASS' : 'FAIL'}`);
  if (!ok) {
    throw new Error(`${key}/${tier}: worst gutter mean |Δ| vertical ${worstV.toFixed(2)} horizontal ${worstH.toFixed(2)} at ${worstAt}, over the limit of ${limit} — a gutter does not hold the neighbouring pixels it claims to`);
  }
}

/**
 * Every group of four children against the parent tile they sit on. A child
 * level is a different resample of a different source file, so the two only
 * agree if the geometry, the grade and the product all line up — and the
 * check is per GROUP, because a whole-level mean hides one bad quadrant
 * completely. Thresholds are texdiff's: mean <= 2, RMS <= 6.
 */
async function childGroupGate(key, parentTier, parentGrid, parentContent, childTier, childContent) {
  const parentDir = await setDir(key, parentTier);
  const childDir = await setDir(key, childTier);
  const half = parentContent / 2;
  if (!Number.isInteger(half)) throw new Error(`${key}: parent content ${parentContent} is odd`);
  let failed = 0;
  let worst = null;
  for (let r = 0; r < parentGrid.rows; r++) {
    for (let c = 0; c < parentGrid.cols; c++) {
      const composites = [];
      for (let dr = 0; dr < 2; dr++) {
        for (let dc = 0; dc < 2; dc++) {
          composites.push({
            input: await sharp(path.join(childDir, `${2 * c + dc}_${2 * r + dr}.webp`))
              .extract({ left: GUTTER, top: GUTTER, width: childContent, height: childContent })
              .resize(half, half, { kernel: 'lanczos3' }).raw().toBuffer(),
            raw: { width: half, height: half, channels: 3 },
            left: dc * half,
            top: dr * half,
          });
        }
      }
      const group = await sharp({ create: { width: parentContent, height: parentContent, channels: 3, background: '#000' }, limitInputPixels: false })
        .composite(composites).removeAlpha().raw().toBuffer();
      const parent = await sharp(path.join(parentDir, `${c}_${r}.webp`))
        .extract({ left: GUTTER, top: GUTTER, width: parentContent, height: parentContent })
        .removeAlpha().raw().toBuffer();
      const d = rasterDiff(group, parent, parentContent * parentContent);
      if (!worst || d.rms > worst.d.rms) worst = { c, r, d };
      if (!d.ok) {
        failed++;
        console.log(`    child group ${c}_${r}: mean [${d.mean.map((m) => m.toFixed(2))}] RMS ${d.rms.toFixed(2)} FAIL`);
      }
    }
  }
  console.log(`  child groups ${key}/${childTier} vs ${parentTier}: ${parentGrid.cols * parentGrid.rows - failed}/${parentGrid.cols * parentGrid.rows} pass; worst ${worst.c}_${worst.r} mean [${worst.d.mean.map((m) => m.toFixed(2))}] RMS ${worst.d.rms.toFixed(2)} max |Δ| ${worst.d.worst} -> ${failed ? 'FAIL' : 'PASS'}`);
  if (failed) {
    throw new Error(`${key}/${childTier} vs ${parentTier}: ${failed} of ${parentGrid.cols * parentGrid.rows} child groups do not resample onto the parent tile they sit on — the two levels are not the same world`);
  }
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
  const { width: W, height: H } = gridSize(GRID_16K, CONTENT);
  const composites = [];
  for (let r = 0; r < GRID_16K.rows; r++) {
    for (let c = 0; c < GRID_16K.cols; c++) {
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
  return sharp({ create: { width: W, height: H, channels: 3, background: '#000' }, limitInputPixels: false })
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

// ---------------------------------------------------------------------------
// Mosaic sources: a level resampled from source tiles, on disk
// ---------------------------------------------------------------------------

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

/**
 * A source that arrives as a grid of equal tiles (NASA ships both the 500 m
 * Blue Marble and Black Marble as 4 columns × 2 rows of 21600² images, west to
 * east and north to south). Each tile is decoded ONCE into a raw file beside
 * it in the cache: a level is read out of the mosaic thousands of times, and
 * re-decoding a 466-megapixel JPEG per read would be hours per level.
 */
async function mosaicSource(files, across, down) {
  const parts = [];
  let tileWidth = 0;
  let tileHeight = 0;
  for (const file of files) {
    await checkSourceDigest(file);
    const meta = await sharp(file, { limitInputPixels: false }).metadata();
    if (!tileWidth) { tileWidth = meta.width; tileHeight = meta.height; }
    if (meta.width !== tileWidth || meta.height !== tileHeight) {
      throw new Error(`${path.basename(file)}: ${meta.width}x${meta.height}, not ${tileWidth}x${tileHeight} like its siblings`);
    }
    const rawFile = path.join(CACHE, 'raw', `${path.basename(file)}.rgb`);
    const want = tileWidth * tileHeight * 3;
    if (!(await exists(rawFile)) || (await stat(rawFile)).size !== want) {
      await mkdir(path.dirname(rawFile), { recursive: true });
      process.stdout.write(`  decode ${path.basename(file)}\r`);
      const { data, info } = await sharp(file, { limitInputPixels: false })
        .removeAlpha().raw().toBuffer({ resolveWithObject: true });
      if (info.channels !== 3 || info.width !== tileWidth || info.height !== tileHeight) {
        throw new Error(`${path.basename(file)}: decoded ${info.width}x${info.height}x${info.channels}`);
      }
      await writeFile(`${rawFile}.part`, data);
      await rename(`${rawFile}.part`, rawFile);
    }
    parts.push(await open(rawFile, 'r'));
  }
  console.log(`  mosaic ${across}x${down} × ${tileWidth}x${tileHeight} = ${across * tileWidth}x${down * tileHeight}`);
  const width = across * tileWidth;
  const height = down * tileHeight;
  return {
    across,
    down,
    tileWidth,
    tileHeight,
    width,
    height,
    async close() { for (const fd of parts) await fd.close(); },
    /** A region of the whole mosaic as packed RGB. Longitude wraps; latitude
     *  clamps at the poles, the same padding a tile's gutter gets. */
    async read(x0, y0, w, h) {
      const out = Buffer.allocUnsafe(w * h * 3);
      for (let i = 0; i < h; i++) {
        const y = Math.max(0, Math.min(height - 1, y0 + i));
        const tr = Math.floor(y / tileHeight);
        const ly = y - tr * tileHeight;
        let x = ((x0 % width) + width) % width;
        let done = 0;
        while (done < w) {
          const tc = Math.floor(x / tileWidth);
          const lx = x - tc * tileWidth;
          const run = Math.min(w - done, tileWidth - lx);
          const fd = parts[tr * across + tc];
          await fd.read(out, (i * w + done) * 3, run * 3, (ly * tileWidth + lx) * 3);
          done += run;
          x = (x + run) % width;
        }
      }
      return out;
    },
  };
}

/**
 * Resample a mosaic into one equirect at a level's own resolution, on disk,
 * one tile row at a time.
 *
 * The resample is done per source COLUMN inside a halo of that column's true
 * neighbours, and the halo is what makes the pieces join invisibly: with the
 * scale reduced to p/q (target/source), a halo of q SOURCE px is exactly p
 * TARGET px, so the padded piece resizes onto the SAME sample grid a resize
 * of the whole map would have used — its edge columns are then real, and
 * trimming p px off each side leaves a piece that continues its neighbour
 * pixel for pixel. Resizing each source tile on its own instead would clamp
 * the kernel at the tile's edge, and those edges land exactly on tile
 * boundaries of the level being cut.
 *
 * A per-pixel grade (the ocean lift) is applied to each band as it is
 * written, which is the same thing as grading the whole map — that is what
 * makes a child's water match its parent's. A per-pixel MASK (the night
 * lights' no-data fill) runs a step earlier, on the source region itself,
 * because what it keys on only exists before the resample blends it.
 */
async function buildMosaicLevelRaw(mosaic, grid, content, outFile, grade, mask) {
  const { width, height } = gridSize(grid, content);
  const shareW = width / mosaic.across;
  const g = gcd(width, mosaic.width);
  const p = width / g;
  const q = mosaic.width / g;
  const integers = {
    'target width per source column': width % mosaic.across,
    'target height per source row': height % mosaic.down,
    'source rows per band': (content * q) % p,
    'source px per source column': (shareW * q) % p,
  };
  for (const [what, rem] of Object.entries(integers)) {
    if (rem !== 0) throw new Error(`${outFile}: ${what} is not a whole number (${width}x${height} from ${mosaic.width}x${mosaic.height})`);
  }
  if (height * mosaic.width !== width * mosaic.height) {
    throw new Error(`${outFile}: ${width}x${height} is not the aspect of ${mosaic.width}x${mosaic.height}`);
  }
  if ((shareW * q) / p !== mosaic.tileWidth) {
    throw new Error(`${outFile}: a source column does not resample to one target column`);
  }
  const srcPerBand = (content * q) / p;
  console.log(`  resample ${mosaic.width}x${mosaic.height} -> ${width}x${height} (scale ${p}/${q}, halo ${q} source px = ${p} target px)`);
  const out = await open(`${outFile}.part`, 'w');
  const t0 = Date.now();
  try {
    for (let r = 0; r < grid.rows; r++) {
      const band = Buffer.allocUnsafe(width * content * 3);
      const sy0 = r * srcPerBand;
      for (let sc = 0; sc < mosaic.across; sc++) {
        const region = await mosaic.read(
          sc * mosaic.tileWidth - q, sy0 - q, mosaic.tileWidth + 2 * q, srcPerBand + 2 * q,
        );
        // Keyed on source values, before the resample: afterwards every pixel
        // near the boundary is a blend and there is nothing exact to key on.
        if (mask) mask(region);
        const piece = await sharp(region, {
          raw: { width: mosaic.tileWidth + 2 * q, height: srcPerBand + 2 * q, channels: 3 },
          limitInputPixels: false,
        })
          .resize(shareW + 2 * p, content + 2 * p, { fit: 'fill', kernel: 'lanczos3' })
          .extract({ left: p, top: p, width: shareW, height: content })
          .raw().toBuffer();
        for (let y = 0; y < content; y++) {
          piece.copy(band, (y * width + sc * shareW) * 3, y * shareW * 3, (y + 1) * shareW * 3);
        }
      }
      if (grade) grade(band);
      await out.write(band, 0, band.length, r * width * content * 3);
      process.stdout.write(`  resample band ${r + 1}/${grid.rows} (${((Date.now() - t0) / 1000).toFixed(0)} s)\r`);
    }
  } finally {
    await out.close();
  }
  await rename(`${outFile}.part`, outFile);
  console.log(`  resampled -> ${path.relative(process.cwd(), outFile)} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  return outFile;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

const cache = (...p) => path.join(CACHE, ...p);
/** NASA's 500 m products ship as 4 columns A–D (west to east) × 2 rows 1–2
 *  (north to south) of 21600² tiles — the whole equirect is 86400x43200. */
const NASA_500M_TILES = (name) => ['A1', 'B1', 'C1', 'D1', 'A2', 'B2', 'C2', 'D2'].map((t) => cache(name(t)));

const JOBS = {
  // Blue Marble Next Generation, August 2004, plain (flat ocean) — the NASA
  // product NASA Eyes ships. Level 0 from the 21600x10800 whole-world JPEG,
  // level 1 from the eight 500 m tiles (86400x43200), both
  // assets.science.nasa.gov.
  earth: {
    key: 'earth-day.v2',
    grade: gradeOceanInPlace,
    // The grade runs inside the resample, so it is part of the bytes the
    // level cache holds and the cache's name has to say so.
    rawToken: 'ocean-grade.v1',
    levels: [
      { tier: '16k', grid: GRID_16K, source: { kind: 'single', file: () => cache('bmng_200408_21600.jpg') } },
      {
        tier: '32k',
        grid: doubled(GRID_16K, 1),
        source: { kind: 'mosaic', files: () => NASA_500M_TILES((t) => `bmng_200408_21600x21600_${t}.jpg`), across: 4, down: 2 },
      },
    ],
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
  // NASA Black Marble 2016, the VIIRS night-lights composite, as its own map
  // family beside the day one: the shipped 2K night map is 20 km per pixel,
  // which from the near band is a smear where a coastline of lit cities
  // should be. Same eight-tile 500 m layout as the day product, so it rides
  // the same pipeline; no grade — the lights are the measurement.
  'earth-night': {
    key: 'earth-night.v2',
    // Antarctica's no-data fill, keyed on source values and replaced before
    // the resample (see maskNoDataInPlace) — so it IS baked into the cached
    // level, and the token below is what keeps a machine that already holds
    // an unmasked one from cutting through it again.
    mask: maskNoDataInPlace,
    rawToken: 'no-data.v1',
    levels: [
      {
        tier: '16k',
        grid: GRID_16K,
        source: { kind: 'mosaic', files: () => NASA_500M_TILES((t) => `BlackMarble_2016_${t}_geo.tif`), across: 4, down: 2 },
      },
      {
        tier: '32k',
        grid: doubled(GRID_16K, 1),
        source: { kind: 'mosaic', files: () => NASA_500M_TILES((t) => `BlackMarble_2016_${t}_geo.tif`), across: 4, down: 2 },
      },
    ],
    // Boot map and one rung. No 8K: the tier ladder stops at 4K for the night
    // lights (an uncompressed 8K map is 170.7 MiB of the sector memory
    // envelope), so an 8K file here would ship bytes nothing fetches.
    downsamples: [
      { w: 4096, h: 2048, out: path.join(TEX, '4k', 'earth-night.v2.webp') },
      { w: 2048, h: 1024, out: path.join(TEX, 'earth-night.v2.webp') },
    ],
    ref: path.join(TEX, '4k', 'earth-night.v2.webp'),
  },
  // LROC WAC colour (NASA SVS CGI Moon Kit lroc_color_poles_16k.tif), the same
  // albedo product as the shipped 2K/4K, colour-matched to the shipped 4K grade.
  moon: {
    key: 'moon',
    match: path.join(TEX, '4k', 'moon.webp'),
    levels: [
      { tier: '16k', grid: GRID_16K, source: { kind: 'single', file: () => cache('lroc_color_poles_16k.tif') } },
    ],
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
    grade: gradeGains([164 / 122, 104 / 97, 90 / 95]),
    levels: [{ tier: '16k', grid: GRID_16K, source: { kind: 'wms' } }],
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
  mercury: { flat: { src: () => cache('sss_8k_mercury.jpg'), out: path.join(TEX, '4k', 'mercury.webp') } },
  venus: { flat: { src: () => cache('sss_4k_venus_atmosphere.jpg'), out: path.join(TEX, '4k', 'venus.webp') } },
  saturn: { flat: { src: () => cache('sss_8k_saturn.jpg'), out: path.join(TEX, '4k', 'saturn.webp') } },
};

/** The equirect one level is cut from, as a row source. Level 0's fits in
 *  memory — the downsamples and the derived gloss mask are made from the same
 *  buffer — and a finer level's is written to the source cache as a raw file
 *  first, because it is gigabytes. */
async function levelRowSource(job, level) {
  const { width, height } = gridSize(level.grid, CONTENT);
  const src = level.source;
  // A mask keys SOURCE values, and these two branches only ever see a source
  // that has already been resampled (sharp resizes inside the decode), where
  // the key would be matching blends. No job declares one; say so rather than
  // quietly masking the wrong pixels.
  if (job.mask && src.kind !== 'mosaic') {
    throw new Error(`${job.key}: a no-data mask needs source pixels, which a ${src.kind} source is not read at`);
  }
  if (src.kind === 'single') {
    const raw = await fullRaw(src.file(), width, height, job.match);
    const water = job.grade ? job.grade(raw) : undefined;
    return { rows: memoryRowSource(raw, width, height), water };
  }
  if (src.kind === 'wms') {
    const raw = await marsRaw();
    const water = job.grade ? job.grade(raw) : undefined;
    return { rows: memoryRowSource(raw, width, height), water };
  }
  // The cached resample's NAME states every transform baked into it, so
  // changing one cannot be silently skipped by a machine that already holds
  // the old bytes. The per-pixel no-data mask is one of them: it keys SOURCE
  // values, so it has to run before the resample blends them away, which puts
  // it inside these cached bytes. `rawToken` is the only thing standing
  // between a stale cache and a re-published set with the mask missing from
  // it, so it changes whenever the mask does.
  const stem = [job.key, level.tier, `${width}x${height}`, job.rawToken].filter(Boolean).join('.');
  const out = cache('levels', `${stem}.rgb`);
  await mkdir(path.dirname(out), { recursive: true });
  if ((await exists(out)) && (await stat(out)).size === width * height * 3) {
    console.log(`  resampled equirect already in the cache: ${path.relative(process.cwd(), out)}`);
    // The cached bytes only mean anything as "these sources at this size", so
    // the digests are still checked — but the source planes are not decoded
    // for a mosaic nothing is going to read.
    for (const file of src.files()) await checkSourceDigest(file);
    return { rows: await fileRowSource(out, width, height) };
  }
  const mosaic = await mosaicSource(src.files(), src.across, src.down);
  try {
    await buildMosaicLevelRaw(mosaic, level.grid, CONTENT, out, job.grade, job.mask);
  } finally {
    await mosaic.close();
  }
  return { rows: await fileRowSource(out, width, height) };
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

const wantedLevel = opt('level', null);
const levelsOf = (job) => (job.levels ?? []).filter((_, i) => wantedLevel === null || Number(wantedLevel) === i);

const names = flag('all') ? Object.keys(JOBS) : jobsWanted;
if (names.length === 0 && !flag('index')) {
  console.error('usage: node tools/gen-tiles.mjs <job...> | --all | --index  [--verify | --crops] [--level=n] [--cache=dir] [--root=dir]');
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
    if (!job.flat) {
      for (const level of levelsOf(job)) {
        await verify(job.key, level.tier, level.grid, CONTENT, job.ref);
        await seamGate(job.key, level.tier, level.grid, CONTENT);
        if (job.mask) await polarTileGate(job.key, level.tier, level.grid, CONTENT);
      }
      // A level against the one it sits on: both have to be on disk, so a
      // run pinned to one level checks only that level's own gates.
      for (let i = 1; wantedLevel === null && i < (job.levels ?? []).length; i++) {
        await childGroupGate(job.key, job.levels[i - 1].tier, job.levels[i - 1].grid, CONTENT, job.levels[i].tier, CONTENT);
      }
    }
  } else if (flag('crops')) {
    // Data crops only: a relief / roughness map changed under an unchanged
    // colour set (the tiles and downsamples are left alone). A derived map
    // needs the graded source again, but not its tiles.
    for (const d of job.dataCrops ?? []) await cutDataCrops(d.src, d.key, d.tier, d.spanU ?? 1);
    if (job.derive && job.grade && job.levels?.[0]) {
      const { rows, water } = await levelRowSource(job, job.levels[0]);
      await job.derive(water, rows.width, rows.height);
      await rows.close();
    }
  } else if (job.flat) {
    await writeWebp(sharp(job.flat.src(), { limitInputPixels: false }).removeAlpha()
      .resize(4096, 2048, { fit: 'fill', kernel: 'lanczos3' }), job.flat.out);
  } else {
    for (const [index, level] of (job.levels ?? []).entries()) {
      if (wantedLevel !== null && Number(wantedLevel) !== index) continue;
      console.log(`-- level ${index} (${level.tier}, ${level.grid.cols}x${level.grid.rows})`);
      const { rows, water } = await levelRowSource(job, level);
      try {
        // The boot map and the ladder rungs come from level 0: they are the
        // same product one resample coarser, which is what makes every step
        // up the ladder a pure sharpen.
        if (index === 0) {
          // One read of the level: the mask makes a fresh masked copy per
          // call, and this one is a third of a gigabyte.
          const whole = await rows.whole();
          if (job.mask) noDataGateRaw(whole, rows.width, rows.height, `${job.key} level 0`);
          await writeDownsamples(whole, rows.width, rows.height, job.downsamples ?? []);
          if (job.mask) for (const d of job.downsamples ?? []) await polarBandGate(d.out);
        }
        await cutGrid(rows, level.grid, CONTENT, job.key, level.tier, job.webp ?? PHOTO_WEBP);
        // Every level, not only the one the whole-map gate can read: the mask
        // runs for all of them, and a run pinned to a finer level with
        // --level=n has nothing else standing between it and an unmasked cap.
        if (job.mask) await polarTileGate(job.key, level.tier, level.grid, CONTENT);
        await verify(job.key, level.tier, level.grid, CONTENT, job.ref);
        await seamGate(job.key, level.tier, level.grid, CONTENT);
        if (index > 0) {
          await childGroupGate(job.key, job.levels[index - 1].tier, job.levels[index - 1].grid, CONTENT, level.tier, CONTENT);
        }
        if (index === 0 && job.derive) await job.derive(water, rows.width, rows.height);
      } finally {
        await rows.close();
      }
    }
    // Crops belong to level 0 (mesh uvs are global, so every level samples
    // the level-0 ancestor's crop), so a run for a finer level alone leaves
    // them where they are.
    if (wantedLevel === null || Number(wantedLevel) === 0) {
      for (const d of job.dataCrops ?? []) await cutDataCrops(d.src, d.key, d.tier, d.spanU ?? 1);
    }
  }
  console.log(`  ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
// Always last, whatever ran: the app reads its set hashes out of the
// generated table, so a cut that did not refresh it would leave every URL
// pointing at the set it replaced.
console.log('== index');
await indexSets();
