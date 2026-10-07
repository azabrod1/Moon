// The Moon's sector relief from the 64 px/deg LOLA grid, in physical units.
//
// The relief the Moon's sectors carry today is cut from the 2880-wide close
// map (3.8 km a texel at the equator) while the colour tiles are 16256 wide
// (0.67 km): magnified under the chase camera the craters shade as soft
// blobs over a crisp albedo, and near the terminator the steep facets of a
// 1.39× exaggerated map go black. This writes the relief at a width of its
// own from NASA's finer grid, so the sector crops (tools/gen-tiles.mjs, the
// `moon-normal/8k` entry) can match the colour's ladder.
//
// Source: ldem_64_uint.tif from the SVS CGI Moon Kit (svs.gsfc.nasa.gov/4720,
// 23040x11520, uint16, elevation in HALF-METRES — the offset does not matter
// to a slope). Dropped in .moon-data-cache/ by hand, like the other sources.
//
// The pipeline, all in Node (sharp for the file, no browser canvas, which
// could not hold a map this size):
//   1. read the grid (tools/uint16Tiff.mjs);
//   2. area-average it to the output width in km (reliefNormals.ts —
//      every output texel the mean of the source area it covers, so the
//      2.835 : 1 ratio aliases nothing);
//   3. normals from physical slope: height difference over the texel's own
//      spacing, the longitude spacing shrunk by cos(lat), times ONE named
//      exaggeration — the shipped 1.39 by default, so a rung is the same
//      relief sharper and the ladder's swap is not a pop (`--exaggeration=1`
//      is the physics, and a different number means a re-cut of every tier);
//   4. a lossless webp in the cache, the file gen-tiles crops.
//
// Usage (from the repo root):
//   node tools/gen-moon-relief.mjs                       # 8128 wide → .moon-data-cache/moon-normal-8k.webp
//   node tools/gen-moon-relief.mjs --width=16256 --tier=16k
//   node tools/gen-moon-relief.mjs --src=/path/to/ldem_64_uint.tif --out=/tmp/x.webp
//   node tools/gen-moon-relief.mjs --exaggeration=1
// Then: node tools/gen-tiles.mjs moon --crops   (the 8k set lands beside the 4k)
//
// Prereq: npm i --no-save sharp@0.35.4
import { readFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { readUint16Tiff } from './uint16Tiff.mjs';
import {
  SHIPPED_RELIEF_EXAGGERATION,
  areaResampleHeights,
  encodeReliefNormals,
  equatorTexelKm,
} from '../src/planetarium/world/reliefNormals.ts';

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const MOON_RADIUS_KM = 1737.4;
const HALF_METRE_KM = 0.0005;
const CACHE = path.resolve(arg('cache', '.moon-data-cache'));
const tier = arg('tier', '8k');
const width = Number(arg('width', '8128'));
const exaggeration = Number(arg('exaggeration', String(SHIPPED_RELIEF_EXAGGERATION)));
const src = path.resolve(arg('src', path.join(CACHE, 'ldem_64_uint.tif')));
const out = path.resolve(arg('out', path.join(CACHE, `moon-normal-${tier}.webp`)));

// The tile cutter's grid is 8 sectors of longitude: the width must split into them.
if (!Number.isInteger(width) || width % 8 !== 0 || width < 8) throw new Error(`--width must be a multiple of 8, got ${width}`);
if (!(exaggeration > 0)) throw new Error(`--exaggeration must be positive, got ${exaggeration}`);
const height = width / 2;

const t0 = Date.now();
const buf = await readFile(src);
const tif = readUint16Tiff(buf);
console.log(`${path.basename(src)}: ${tif.width}x${tif.height} uint16, ${(buf.length / 1e6).toFixed(0)} MB, read in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
if (tif.width !== 2 * tif.height) throw new Error(`not a whole-globe equirect: ${tif.width}x${tif.height}`);
if (width > tif.width) throw new Error(`--width ${width} is wider than the source's ${tif.width}: a relief map is never upsampled`);

const t1 = Date.now();
const heightsKm = areaResampleHeights(tif.data, tif.width, tif.height, width, height, HALF_METRE_KM);
let min = Infinity;
let max = -Infinity;
for (const h of heightsKm) { if (h < min) min = h; if (h > max) max = h; }
console.log(`resampled to ${width}x${height} in ${((Date.now() - t1) / 1000).toFixed(1)} s; relief spans ${(max - min).toFixed(2)} km`);

const t2 = Date.now();
const texelKm = equatorTexelKm(width, MOON_RADIUS_KM);
const rgb = encodeReliefNormals(heightsKm, width, height, { bodyRadiusKm: MOON_RADIUS_KM, exaggeration });
// Where the slopes sit, read back off the bytes: the distribution a re-cut
// at another exaggeration is compared against.
const tilts = new Float64Array(width * height);
for (let i = 0; i < tilts.length; i++) {
  const nz = rgb[i * 3 + 2] / 255 * 2 - 1;
  tilts[i] = Math.acos(Math.min(1, Math.max(-1, nz))) * 180 / Math.PI;
}
tilts.sort();
const q = (p) => tilts[Math.min(tilts.length - 1, Math.floor(p * tilts.length))].toFixed(1);
console.log(`normals at ${texelKm.toFixed(2)} km a texel, exaggeration ${exaggeration}: tilt p50 ${q(0.5)}°, p90 ${q(0.9)}°, p99 ${q(0.99)}°, max ${q(1)}° (${((Date.now() - t2) / 1000).toFixed(1)} s)`);

await mkdir(path.dirname(out), { recursive: true });
await sharp(Buffer.from(rgb.buffer, rgb.byteOffset, rgb.byteLength), { raw: { width, height, channels: 3 }, limitInputPixels: false })
  .webp({ lossless: true, effort: 5 })
  .toFile(out);
console.log(`${out}: ${((await stat(out)).size / 1e6).toFixed(1)} MB lossless, ${((Date.now() - t0) / 1000).toFixed(0)} s in all`);
console.log(`next: node tools/gen-tiles.mjs moon --crops   (cuts moon-normal/${tier})`);
