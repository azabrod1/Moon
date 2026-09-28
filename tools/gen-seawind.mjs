// Bake the sea's wind maps (tools/seaWindField.mjs) into the shipped pair:
//
//   npm run gen:seawind
//     -> public/textures/earth-seawind-calm.v1.webp   2048x1024, the calm weight
//        public/textures/earth-seawind-windy.v1.webp  1024x512, the windy speed over SEA_WIND_MAX_MS
//   node tools/gen-seawind.mjs --out=planning/candidate --set=calmScale:1.5 --rgb=planning/candidate.png
//     -> a candidate pair (<out>-calm.webp, <out>-windy.webp) with DEFAULTS overridden, and both
//        maps in one picture (red the calm weight, green the windy speed) for the DEV
//        `?seawindmap=` override and the offline simulator
//   --width=1024   the half-size pair (the windy map at 512x256)
//
// Each map is a GREY picture, lossless: the shader reads it as a number
// through the one-channel mask path (world/texturePolicy), and a lossy webp
// would ring at every calm lane's edge. The PNGs are written with
// tools/pngEncode.mjs (no native image library is a dependency here) and
// turned into webp by sharp, installed for the run and not saved, as
// tools/encode-textures.mjs does it:
//
//   npm i --no-save sharp@0.35.4
//
// The bake takes about a minute and a half: every calm texel is a box of four
// points, and each point is some twenty octaves of lattice noise. Re-run it
// after any change to the generator or its DEFAULTS, then move the pins in
// seaWind.test.ts that hold the shipped files to the generator (their hashes)
// deliberately.
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { encodePng } from './pngEncode.mjs';
import { DEFAULTS, bandStatistics, buildField, encodeCalmGrey, encodeSeaWindRgb, encodeWindyGrey } from './seaWindField.mjs';

function arg(name, fallback) {
  const hit = process.argv.find((candidate) => candidate.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const width = Number(arg('width', '2048'));
const height = width / 2;
const supersample = Number(arg('supersample', '2'));
const shipped = !process.argv.some((candidate) => candidate.startsWith('--out='));
const outPrefix = path.resolve(arg('out', 'public/textures/earth-seawind'));
const version = shipped ? '.v1' : '';
const rgbPath = arg('rgb', '');
if (!Number.isInteger(width) || !Number.isInteger(height) || width < 4) {
  console.error(`[gen-seawind] width ${width} is not an even positive integer`);
  process.exit(1);
}
/** `--set=key:value,...` overrides numeric DEFAULTS for a candidate bake; the
 *  shipped pair is the DEFAULTS alone. */
const overrides = Object.fromEntries(
  arg('set', '').split(',').filter(Boolean).map((pair) => {
    const [key, value] = pair.split(':');
    if (!(key in DEFAULTS) || !Number.isFinite(Number(value))) {
      console.error(`[gen-seawind] --set: ${pair} is not a numeric DEFAULTS key`);
      process.exit(1);
    }
    return [key, Number(value)];
  }),
);
if (shipped && Object.keys(overrides).length) {
  console.error('[gen-seawind] the shipped pair is the DEFAULTS alone: bake a candidate with --out=');
  process.exit(1);
}

const started = Date.now();
const field = buildField(width, height, { ...overrides, supersample });
console.log(`[gen-seawind] ${width}x${height} at ${supersample}x${supersample}`
  + `${Object.keys(overrides).length ? ` with ${JSON.stringify(overrides)}` : ''} built in ${((Date.now() - started) / 1000).toFixed(1)} s`);
for (const [label, low, high] of [['0-15', 0, 15], ['15-30', 15, 30], ['30-45', 30, 45], ['45-60', 45, 60], ['0-25', 0, 25]]) {
  const stats = bandStatistics(field, low, high);
  console.log(`[gen-seawind] |lat| ${label}: mean ${stats.meanWindMs.toFixed(2)} m/s, calm weight ${stats.meanCalmWeight.toFixed(3)}, `
    + `under 1 m/s ${(100 * stats.under1Fraction).toFixed(1)} %, under 2 m/s ${(100 * stats.under2Fraction).toFixed(1)} % (area-weighted, land included)`);
}

let sharp;
try {
  sharp = (await import('sharp')).default;
} catch {
  console.error('[gen-seawind] sharp is not installed: `npm i --no-save sharp@0.35.4` and re-run.');
  process.exit(1);
}
await mkdir(path.dirname(outPrefix), { recursive: true });

/** A grey picture to a lossless webp beside the PNG it came from, verified to
 *  decode to the same bytes, the PNG removed. */
async function writeMap(name, rgb, mapWidth, mapHeight) {
  const webpPath = `${outPrefix}-${name}${version}.webp`;
  const pngPath = webpPath.replace(/\.webp$/, '.png');
  const png = encodePng(mapWidth, mapHeight, 3, rgb);
  await writeFile(pngPath, png);
  await sharp(pngPath).webp({ lossless: true, effort: 6 }).toFile(webpPath);
  const decoded = await sharp(webpPath).raw().toBuffer({ resolveWithObject: true });
  const original = await sharp(pngPath).raw().toBuffer();
  if (decoded.info.width !== mapWidth || decoded.info.height !== mapHeight || Buffer.compare(decoded.data, original) !== 0) {
    console.error(`[gen-seawind] ${webpPath} does not decode to the PNG's bytes`);
    process.exit(1);
  }
  await unlink(pngPath);
  const size = (await stat(webpPath)).size;
  const hash = createHash('sha256').update(await readFile(webpPath)).digest('hex');
  console.log(`[gen-seawind] ${path.relative(process.cwd(), webpPath)}: ${mapWidth}x${mapHeight}, ${(size / 1024).toFixed(0)} KB lossless webp, sha256 ${hash}`);
}
await writeMap('calm', encodeCalmGrey(field), field.width, field.height);
await writeMap('windy', encodeWindyGrey(field), field.windyWidth, field.windyHeight);
if (rgbPath) {
  const png = encodePng(field.width, field.height, 3, encodeSeaWindRgb(field));
  await mkdir(path.dirname(path.resolve(rgbPath)), { recursive: true });
  await writeFile(rgbPath, png);
  console.log(`[gen-seawind] ${rgbPath}: both maps in one picture, ${(png.length / 1024).toFixed(0)} KB`);
}
