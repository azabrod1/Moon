// Mars relief from the USGS HRSC–MOLA blended DEM: the boot normal map, the
// close-approach 4K rung and the 8K map the sector crops are cut from, all
// three from ONE elevation model in one pass.
//
// Why this exists beside gen-maps.mjs: that tool pushes a height field through
// a browser canvas, which is fine for a 5760-wide MEGDR and hopeless for the
// 106,694 × 53,347 int16 blend (11.4 GB). This one streams the DEM a strip at a
// time, area-averages it onto the widest output grid, derives the narrower
// grids from that, and writes the normals from Node with no browser at all.
//
// The relief is PHYSICAL: slope in metres over metres at each texel's true
// ground spacing (the parallel shrinks by cos(lat) on an equirect), times one
// authored exaggeration. The shipped v2 map (gen-maps, MOLA 16 px/deg,
// `strength 2.4` on min–max-normalised heights) works out to almost exactly
// physical slope × 2.4 at its own texel spacing — the derivation is at
// MARS_RELIEF_EXAGGERATION in world/reliefNormals.ts — so the default
// reproduces its macro look, and every
// finer output is a sharper map of the same relief rather than a steeper one,
// which is what the relief ladder's "pure sharpen" rule needs. The tilt
// statistics of each output are printed beside the shipped map's so that
// claim is measured, not assumed.
//
// Source (not a package.json dependency — one asset drop):
//   Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif
//   https://planetarymaps.usgs.gov/mosaic/Mars/HRSC_MOLA_Blend/Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif
//   Fergason, R. L., Hare, T. M., & Laura, J. (2018). HRSC and MOLA Blended
//   Digital Elevation Model at 200m v2. USGS Astrogeology. MOLA: public domain
//   (CC0); HRSC: ESA/DLR/FU Berlin, CC BY-SA 3.0 IGO.
//   Simple cylindrical, −180..180 E (−180 at the left edge, like every Mars
//   colour map here), 16-bit signed metres above the areoid, nodata −32768.
//   Its SHA-256 is pinned in tools/gen-tiles.sources.json like every other
//   source: a changed upstream file is refused, never silently re-cut.
//
// Prereq: npm i --no-save sharp@0.35.4
// Usage:
//   node tools/gen-relief.mjs                       # all three outputs
//   node tools/gen-relief.mjs --strength=2.4        # the exaggeration (default 2.4)
//   node tools/gen-relief.mjs --cache=<dir>         # where the DEM sits and the 8K map goes
//   node tools/gen-relief.mjs --src=<file>          # the DEM itself
// Then: node tools/gen-tiles.mjs mars --crops       # cut the 8K map into sector crops
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
// The relief encoder the Moon's generator (tools/gen-moon-relief.mjs) uses,
// imported through Node's type stripping: one formula for both bodies' slopes.
import { MARS_RELIEF_EXAGGERATION, encodeReliefNormals } from '../src/planetarium/world/reliefNormals.ts';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const hit = args.find((entry) => entry.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const TEX = path.resolve('public/textures');
const CACHE = path.resolve(opt('cache', '.moon-data-cache'));
const SOURCE = path.resolve(opt('src', path.join(CACHE, 'Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif')));
// Physical slope times this: Mars's authored exaggeration, derived and
// recorded beside the Moon's in world/reliefNormals.ts. The material then
// halves it (PlanetFactory authors normalScale 0.5 for Mars).
const EXAGGERATION = Number(opt('strength', String(MARS_RELIEF_EXAGGERATION)));
const NODATA = -32768;

/** The three widths of one relief. The boot map and the 4K rung ship; the 8K
 *  map stays in the cache as the source gen-tiles cuts the sector crops from
 *  (`mars --crops`), exactly as Earth's roughness crops are cut from a 4096
 *  resize that never ships whole. 8192 rather than the colour tiles' 16256:
 *  a normal crop at 16K is 21.7 MiB of GPU memory a sector with its mips, as
 *  much again as the colour tile it sits under, where 8K is 5.5 MiB. */
const OUTPUTS = [
  { width: 8192, out: path.join(CACHE, 'mars-normal.v3-8192.png'), encode: 'png', role: 'sector crop source' },
  { width: 4096, out: path.join(TEX, '4k', 'mars-normal.v3.webp'), encode: 'webp', role: 'close-approach rung' },
  { width: 1440, out: path.join(TEX, 'mars-normal.v3.webp'), encode: 'webp', role: 'boot map' },
];
/** The map the new one replaces, for the tilt comparison printed at the end. */
const PREVIOUS_BOOT_MAP = path.join(TEX, 'mars-normal.v2.webp');

// ---------------------------------------------------------------------------
// The DEM: a classic or Big TIFF with one strip per row, read strip by strip.
// ---------------------------------------------------------------------------

/** Enough of a TIFF reader for an uncompressed single-band 16-bit GeoTIFF:
 *  the dimensions, the sample layout, the strip table and the georeferencing
 *  keys this tool checks. Anything else in the file is ignored. */
async function readTiffHeader(filePath) {
  const handle = await open(filePath, 'r');
  try {
    const head = Buffer.alloc(16);
    await handle.read(head, 0, 16, 0);
    const littleEndian = head.toString('ascii', 0, 2) === 'II';
    if (!littleEndian && head.toString('ascii', 0, 2) !== 'MM') throw new Error(`${filePath}: not a TIFF`);
    const read16 = (buffer, offset) => (littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset));
    const read32 = (buffer, offset) => (littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset));
    const read64 = (buffer, offset) => Number(littleEndian ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset));
    const readDouble = (buffer, offset) => (littleEndian ? buffer.readDoubleLE(offset) : buffer.readDoubleBE(offset));
    const magic = read16(head, 2);
    const bigTiff = magic === 43;
    if (!bigTiff && magic !== 42) throw new Error(`${filePath}: bad TIFF magic ${magic}`);
    const firstIfd = bigTiff ? read64(head, 8) : read32(head, 4);
    const countBuffer = Buffer.alloc(8);
    await handle.read(countBuffer, 0, 8, firstIfd);
    const entryCount = bigTiff ? read64(countBuffer, 0) : read16(countBuffer, 0);
    const entrySize = bigTiff ? 20 : 12;
    const entriesStart = firstIfd + (bigTiff ? 8 : 2);
    const entries = Buffer.alloc(entryCount * entrySize);
    await handle.read(entries, 0, entries.length, entriesStart);
    const typeSizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8, 17: 8, 18: 8 };
    const tags = new Map();
    for (let index = 0; index < entryCount; index++) {
      const at = index * entrySize;
      const tag = read16(entries, at);
      const type = read16(entries, at + 2);
      const count = bigTiff ? read64(entries, at + 4) : read32(entries, at + 4);
      const size = typeSizes[type] ?? 1;
      const inlineBytes = bigTiff ? 8 : 4;
      const valueField = at + (bigTiff ? 12 : 8);
      let valueBuffer;
      if (count * size <= inlineBytes) {
        valueBuffer = entries.subarray(valueField, valueField + count * size);
      } else {
        const valueOffset = bigTiff ? read64(entries, valueField) : read32(entries, valueField);
        valueBuffer = Buffer.alloc(count * size);
        await handle.read(valueBuffer, 0, valueBuffer.length, valueOffset);
      }
      const values = [];
      for (let item = 0; item < count; item++) {
        const offset = item * size;
        if (type === 2) values.push(String.fromCharCode(valueBuffer[offset]));
        else if (size === 1) values.push(valueBuffer[offset]);
        else if (size === 2) values.push(read16(valueBuffer, offset));
        else if (type === 11) values.push(littleEndian ? valueBuffer.readFloatLE(offset) : valueBuffer.readFloatBE(offset));
        else if (size === 4) values.push(read32(valueBuffer, offset));
        else if (type === 12) values.push(readDouble(valueBuffer, offset));
        else values.push(read64(valueBuffer, offset));
      }
      tags.set(tag, type === 2 ? [values.join('')] : values);
    }
    const one = (tag, fallback) => (tags.has(tag) ? tags.get(tag)[0] : fallback);
    const header = {
      littleEndian,
      width: one(256),
      height: one(257),
      bitsPerSample: one(258, 8),
      compression: one(259, 1),
      samplesPerPixel: one(277, 1),
      sampleFormat: one(339, 1),
      rowsPerStrip: one(278),
      stripOffsets: tags.get(273) ?? [],
      stripByteCounts: tags.get(279) ?? [],
      pixelScale: tags.get(33550) ?? [],
      tiepoint: tags.get(33922) ?? [],
      geoDoubles: tags.get(34736) ?? [],
      geoAscii: one(34737, ''),
      nodata: one(42113, ''),
    };
    if (header.bitsPerSample !== 16 || header.samplesPerPixel !== 1 || header.sampleFormat !== 2) {
      throw new Error(`${filePath}: expected one signed 16-bit band, got ${header.bitsPerSample}-bit ×${header.samplesPerPixel} format ${header.sampleFormat}`);
    }
    if (header.compression !== 1) throw new Error(`${filePath}: compression ${header.compression}; this reader takes uncompressed strips only`);
    if (header.rowsPerStrip !== 1) throw new Error(`${filePath}: ${header.rowsPerStrip} rows per strip; this reader expects one`);
    if (header.stripOffsets.length !== header.height) throw new Error(`${filePath}: ${header.stripOffsets.length} strips for ${header.height} rows`);
    return header;
  } finally {
    await handle.close();
  }
}

/** The source digests gen-tiles pins (tools/gen-tiles.sources.json), applied
 *  here too: the same product re-downloaded after an upstream change would
 *  otherwise regenerate every relief map silently. A source the manifest does
 *  not list is refused with its digest printed, so the entry can be added
 *  together with the assets made from it. */
async function checkSourceDigest(filePath) {
  const manifest = JSON.parse(await readFile(new URL('./gen-tiles.sources.json', import.meta.url), 'utf8'));
  const entry = manifest[path.basename(filePath)];
  const hash = createHash('sha256');
  const startedAt = Date.now();
  process.stdout.write(`  hashing ${path.basename(filePath)}\r`);
  await new Promise((resolve, reject) => {
    createReadStream(filePath, { highWaterMark: 1 << 24 })
      .on('data', (chunk) => hash.update(chunk))
      .on('end', resolve)
      .on('error', reject);
  });
  const digest = hash.digest('hex');
  const bytes = (await stat(filePath)).size;
  console.log(`  ${path.basename(filePath)}: sha256 ${digest} (${bytes} bytes, ${((Date.now() - startedAt) / 1000).toFixed(0)} s)`);
  if (!entry) {
    throw new Error(`${path.basename(filePath)} is not in tools/gen-tiles.sources.json — add it with the digest above, together with the maps cut from it`);
  }
  if (entry.sha256 !== digest || entry.bytes !== bytes) {
    throw new Error(`${path.basename(filePath)}: sha256 ${digest} / ${bytes} bytes, but the manifest pins ${entry.sha256} / ${entry.bytes}`);
  }
}

// ---------------------------------------------------------------------------
// Area-weighted resampling: every source texel's whole area lands in the
// target cells it overlaps, nodata texels excluded by weight. Exact for any
// ratio, which is what the 13.02× shrink to 8192 and the 5.69× to 1440 need —
// a kernel resize would alias the one and blur the other.
// ---------------------------------------------------------------------------

/** For each source column (or row) of `sourceCount` texels onto `targetCount`
 *  cells: the first cell it touches and the fraction of it that spills into
 *  the next (0 when it sits inside one cell). A downsample never spans more
 *  than two cells. */
function binning(sourceCount, targetCount) {
  const firstCell = new Int32Array(sourceCount);
  const spill = new Float64Array(sourceCount);
  const scale = targetCount / sourceCount;
  for (let source = 0; source < sourceCount; source++) {
    const start = source * scale;
    const end = (source + 1) * scale;
    let cell = Math.floor(start);
    if (cell >= targetCount) cell = targetCount - 1;
    firstCell[source] = cell;
    const boundary = cell + 1;
    spill[source] = end > boundary && cell + 1 < targetCount ? (end - boundary) / (end - start) : 0;
  }
  return { firstCell, spill };
}

/** Fold one source row (`values`, with `valid` weights 0/1) into target-width
 *  bins, returning the two running sums for that row. */
function foldRow(values, valid, columns, targetWidth, sums, weights) {
  sums.fill(0);
  weights.fill(0);
  const { firstCell, spill } = columns;
  for (let source = 0; source < values.length; source++) {
    const weight = valid[source];
    if (weight === 0) continue;
    const cell = firstCell[source];
    const part = spill[source];
    const value = values[source];
    sums[cell] += value * (1 - part);
    weights[cell] += 1 - part;
    if (part > 0) {
      sums[cell + 1] += value * part;
      weights[cell + 1] += part;
    }
  }
}

/** Stream the DEM onto a `targetWidth × targetHeight` grid of mean heights.
 *  Returns Float32 heights with nodata cells (no valid source texel at all)
 *  filled from their western neighbour — none exist in this DEM beyond its
 *  duplicated last column, but a hole must never become a cliff. */
async function resampleDem(header, filePath, targetWidth, targetHeight) {
  const { width, height, littleEndian, stripOffsets } = header;
  const columns = binning(width, targetWidth);
  const rows = binning(height, targetHeight);
  const sums = new Float64Array(targetWidth * targetHeight);
  const weights = new Float64Array(targetWidth * targetHeight);
  const rowSums = new Float64Array(targetWidth);
  const rowWeights = new Float64Array(targetWidth);
  const values = new Float64Array(width);
  const valid = new Uint8Array(width);
  const rowBytes = width * 2;
  const handle = await open(filePath, 'r');
  const startedAt = Date.now();
  try {
    const buffer = Buffer.alloc(rowBytes);
    for (let row = 0; row < height; row++) {
      await handle.read(buffer, 0, rowBytes, stripOffsets[row]);
      for (let column = 0; column < width; column++) {
        const sample = littleEndian ? buffer.readInt16LE(column * 2) : buffer.readInt16BE(column * 2);
        values[column] = sample;
        valid[column] = sample === NODATA ? 0 : 1;
      }
      foldRow(values, valid, columns, targetWidth, rowSums, rowWeights);
      const cell = rows.firstCell[row];
      const part = rows.spill[row];
      const base = cell * targetWidth;
      for (let target = 0; target < targetWidth; target++) {
        sums[base + target] += rowSums[target] * (1 - part);
        weights[base + target] += rowWeights[target] * (1 - part);
      }
      if (part > 0) {
        const next = (cell + 1) * targetWidth;
        for (let target = 0; target < targetWidth; target++) {
          sums[next + target] += rowSums[target] * part;
          weights[next + target] += rowWeights[target] * part;
        }
      }
      if (row % 1000 === 0) {
        process.stdout.write(`  resampling ${width}×${height} → ${targetWidth}×${targetHeight}: row ${row}/${height} (${((Date.now() - startedAt) / 1000).toFixed(0)} s)\r`);
      }
    }
  } finally {
    await handle.close();
  }
  console.log('');
  const heights = new Float32Array(targetWidth * targetHeight);
  let holes = 0;
  for (let index = 0; index < heights.length; index++) {
    if (weights[index] > 0) heights[index] = sums[index] / weights[index];
    else { heights[index] = index > 0 ? heights[index - 1] : 0; holes++; }
  }
  if (holes) console.log(`  ${holes} empty cells filled from their neighbour`);
  return heights;
}

/** The same fold applied to a grid already in memory (the 8192 map → 4096 and
 *  1440), so every output is one area average of the DEM and not an average of
 *  an average with a different footprint at each step than a direct one would
 *  have — close enough at these ratios, and it saves two more passes over the
 *  11 GB file. */
function resampleGrid(heights, width, height, targetWidth, targetHeight) {
  const columns = binning(width, targetWidth);
  const rows = binning(height, targetHeight);
  const sums = new Float64Array(targetWidth * targetHeight);
  const weights = new Float64Array(targetWidth * targetHeight);
  const rowSums = new Float64Array(targetWidth);
  const rowWeights = new Float64Array(targetWidth);
  const valid = new Uint8Array(width).fill(1);
  for (let row = 0; row < height; row++) {
    foldRow(heights.subarray(row * width, (row + 1) * width), valid, columns, targetWidth, rowSums, rowWeights);
    const cell = rows.firstCell[row];
    const part = rows.spill[row];
    for (let target = 0; target < targetWidth; target++) {
      sums[cell * targetWidth + target] += rowSums[target] * (1 - part);
      weights[cell * targetWidth + target] += rowWeights[target] * (1 - part);
      if (part > 0) {
        sums[(cell + 1) * targetWidth + target] += rowSums[target] * part;
        weights[(cell + 1) * targetWidth + target] += rowWeights[target] * part;
      }
    }
  }
  const out = new Float32Array(targetWidth * targetHeight);
  for (let index = 0; index < out.length; index++) out[index] = sums[index] / weights[index];
  return out;
}

// ---------------------------------------------------------------------------
// Heights → tangent-space normals, through the one relief encoder
// (world/reliefNormals.ts): physical slope at each texel's true spacing, the
// parallel shrunk by cos(lat) and clamped at a fifth, times the exaggeration,
// in the shipped maps' conventions (x east, y north, z out; ny = +∂h/∂south as
// the OpenGL maps three reads). The Moon's generator goes through the same
// function, so the two bodies' relief cannot drift apart in sign, clamp or
// rounding.
// ---------------------------------------------------------------------------

function normalsFromHeights(heightsMetres, width, height, radiusMetres, exaggeration) {
  const heightsKm = new Float32Array(heightsMetres.length);
  for (let index = 0; index < heightsKm.length; index++) heightsKm[index] = heightsMetres[index] * 0.001;
  return encodeReliefNormals(heightsKm, width, height, { bodyRadiusKm: radiusMetres * 0.001, exaggeration });
}

/** Median, 90th and 99th percentile tilt in degrees — the figure gen-maps
 *  judged its cloud relief by, printed per output so a change of exaggeration
 *  or source is a number beside the map it replaces rather than an
 *  impression. Read back from the ENCODED bytes, through x and y: the blue
 *  channel alone cannot tell a 4° tilt from a flat texel (cos 4° rounds to
 *  255), where the two centred channels resolve half a degree. */
function tiltStatisticsOfBytes(rgb) {
  const tilts = new Float32Array(rgb.length / 3);
  for (let index = 0; index < tilts.length; index++) {
    const normalX = (rgb[index * 3] / 255) * 2 - 1;
    const normalY = (rgb[index * 3 + 1] / 255) * 2 - 1;
    tilts[index] = Math.asin(Math.min(1, Math.hypot(normalX, normalY)));
  }
  const sorted = tilts.sort();
  const degrees = (radians) => ((radians * 180) / Math.PI).toFixed(2);
  return `median ${degrees(sorted[Math.floor(sorted.length * 0.5)])}°, p90 ${degrees(sorted[Math.floor(sorted.length * 0.9)])}°, p99 ${degrees(sorted[Math.floor(sorted.length * 0.99)])}°`;
}

/** The tilt distribution of an existing normal map, so the new boot map can
 *  be set beside the one it replaces. */
async function tiltStatisticsOfMap(filePath) {
  const { data, info } = await sharp(filePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return `${info.width}×${info.height}: ${tiltStatisticsOfBytes(data)}`;
}

async function writeNormalMap(rgb, width, height, output) {
  await mkdir(path.dirname(output.out), { recursive: true });
  const image = sharp(rgb, { raw: { width, height, channels: 3 }, limitInputPixels: false });
  if (output.encode === 'webp') await image.webp({ lossless: true, effort: 5 }).toFile(output.out);
  else await image.png({ compressionLevel: 6 }).toFile(output.out);
  const bytes = (await stat(output.out)).size;
  console.log(`  ${path.relative(process.cwd(), output.out).padEnd(44)} ${width}×${height} ${(bytes / 1024).toFixed(0).padStart(7)} KB  (${output.role})`);
}

async function main() {
  console.log(`== Mars relief from ${path.relative(process.cwd(), SOURCE)} (exaggeration ${EXAGGERATION})`);
  await checkSourceDigest(SOURCE);
  const header = await readTiffHeader(SOURCE);
  const radiusMetres = header.geoDoubles[0];
  if (!(radiusMetres > 3_000_000 && radiusMetres < 3_500_000)) throw new Error(`unexpected body radius ${radiusMetres} m in the GeoTIFF keys`);
  if (header.tiepoint[3] !== -180 || header.tiepoint[4] !== 90) {
    throw new Error(`the DEM's upper-left corner is (${header.tiepoint[3]}, ${header.tiepoint[4]}), not (−180, 90): its longitude domain would need rolling`);
  }
  if (!/Mars_2000_Sphere/.test(header.geoAscii)) throw new Error(`unexpected datum in the GeoTIFF keys: ${header.geoAscii}`);
  if (header.nodata.replace(/\0/g, '') !== String(NODATA)) throw new Error(`nodata is ${JSON.stringify(header.nodata)}, not ${NODATA}`);
  console.log(`  ${header.width}×${header.height}, ${header.pixelScale[0].toFixed(6)}°/px, radius ${radiusMetres} m, −180..180 E`);

  const [widest, ...narrower] = OUTPUTS;
  const widestHeight = widest.width / 2;
  const heights = await resampleDem(header, SOURCE, widest.width, widestHeight);
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const value of heights) { if (value < minimum) minimum = value; if (value > maximum) maximum = value; }
  console.log(`  heights ${minimum.toFixed(0)}..${maximum.toFixed(0)} m above the areoid on the ${widest.width} grid`);

  const grids = [{ output: widest, heights, width: widest.width, height: widestHeight }];
  for (const output of narrower) {
    const height = output.width / 2;
    grids.push({ output, heights: resampleGrid(heights, widest.width, widestHeight, output.width, height), width: output.width, height });
  }
  for (const grid of grids) {
    const rgb = normalsFromHeights(grid.heights, grid.width, grid.height, radiusMetres, EXAGGERATION);
    await writeNormalMap(rgb, grid.width, grid.height, grid.output);
    console.log(`    tilt ${tiltStatisticsOfBytes(rgb)}`);
  }
  try {
    console.log(`  shipped ${path.relative(process.cwd(), PREVIOUS_BOOT_MAP)} for comparison — ${await tiltStatisticsOfMap(PREVIOUS_BOOT_MAP)}`);
  } catch {
    console.log('  (no previous boot map to compare against)');
  }
  console.log('done — now: node tools/gen-tiles.mjs mars --crops');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
