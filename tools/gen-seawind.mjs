// Bake the sea's wind map (tools/seaWindField.mjs) into the shipped file:
//
//   npm run gen:seawind
//     -> public/textures/earth-seawind.v1.webp   1024x512, the wind over SEA_WIND_MAX_MS
//   node tools/gen-seawind.mjs --out=planning/candidate --set=broadSpread:0.6 --png=planning/candidate.png
//     -> a candidate (<out>.webp) with DEFAULTS overridden, at --width=<n> (the
//        height half of it) if given, and the same map as a grey PNG, the
//        form the DEV `?seawindmap=` override reads (its red)
//
// The map is a GREY picture, lossless: the shader reads it as a number
// through the one-channel mask path (world/texturePolicy), and a lossy webp
// would bend the wind it carries. The PNG is written with tools/pngEncode.mjs
// (no native image library is a dependency here) and turned into webp by
// sharp, installed for the run and not saved, as tools/encode-textures.mjs
// does it:
//
//   npm i --no-save sharp@0.35.4
//
// Re-run it after any change to the generator or its DEFAULTS, then move the
// pins in seaWind.test.ts that hold the shipped file to the generator (its
// hash) deliberately. A re-bake whose bytes differ ships under a new name
// (earth-seawind.v2.webp), as every data file the service worker caches
// does.
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { encodePng } from './pngEncode.mjs';
import { DEFAULTS, bandStatistics, buildField, encodeWindGrey } from './seaWindField.mjs';

/** The shipped map's width; its height is half of it. */
const SHIPPED_WIDTH = 1024;

function arg(name, fallback) {
  const hit = process.argv.find((candidate) => candidate.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const shipped = !process.argv.some((candidate) => candidate.startsWith('--out='));
const width = Number(arg('width', String(SHIPPED_WIDTH)));
const height = width / 2;
const webpPath = shipped ? path.resolve('public/textures/earth-seawind.v1.webp') : `${path.resolve(arg('out', ''))}.webp`;
const pngPath = arg('png', '');
if (!shipped && !arg('out', '')) {
  console.error('[gen-seawind] --out= needs a path prefix');
  process.exit(1);
}
if (!Number.isInteger(width) || !Number.isInteger(height) || width < 4) {
  console.error(`[gen-seawind] width ${width} is not an even positive integer`);
  process.exit(1);
}
/** `--set=key:value,...` overrides numeric DEFAULTS for a candidate bake; the
 *  shipped map is the DEFAULTS alone. */
const overrides = Object.fromEntries(
  arg('set', '').split(',').filter(Boolean).map((pair) => {
    const [key, value] = pair.split(':');
    if (!(key in DEFAULTS) || typeof DEFAULTS[key] !== 'number' || !Number.isFinite(Number(value))) {
      console.error(`[gen-seawind] --set: ${pair} is not a numeric DEFAULTS key`);
      process.exit(1);
    }
    return [key, Number(value)];
  }),
);
if (shipped && (Object.keys(overrides).length || width !== SHIPPED_WIDTH)) {
  console.error(`[gen-seawind] the shipped map is the DEFAULTS alone at ${SHIPPED_WIDTH}x${SHIPPED_WIDTH / 2}: bake a candidate with --out=`);
  process.exit(1);
}

let sharp;
try {
  sharp = (await import('sharp')).default;
} catch {
  console.error('[gen-seawind] sharp is not installed: `npm i --no-save sharp@0.35.4` and re-run.');
  process.exit(1);
}

const started = Date.now();
const field = buildField(width, height, overrides);
const supersample = overrides.supersample ?? DEFAULTS.supersample;
console.log(`[gen-seawind] ${width}x${height} at ${supersample}x${supersample}`
  + `${Object.keys(overrides).length ? ` with ${JSON.stringify(overrides)}` : ''} built in ${((Date.now() - started) / 1000).toFixed(1)} s`);
for (const [label, low, high] of [['0-15', 0, 15], ['15-30', 15, 30], ['30-45', 30, 45], ['45-60', 45, 60], ['0-25', 0, 25]]) {
  const stats = bandStatistics(field, low, high);
  console.log(`[gen-seawind] |lat| ${label}: mean ${stats.meanWindMs.toFixed(2)} m/s, `
    + `under 1 m/s ${(100 * stats.under1Fraction).toFixed(1)} %, under 2 m/s ${(100 * stats.under2Fraction).toFixed(1)} % (area-weighted, land included)`);
}

// The grey picture to a lossless webp beside the PNG it came from, verified
// to decode to the same bytes; the PNG kept only where --png asked for it.
const grey = encodeWindGrey(field);
const png = encodePng(width, height, 3, grey);
const stagingPng = webpPath.replace(/\.webp$/, '.png');
await mkdir(path.dirname(webpPath), { recursive: true });
await writeFile(stagingPng, png);
await sharp(stagingPng).webp({ lossless: true, effort: 6 }).toFile(webpPath);
const decoded = await sharp(webpPath).raw().toBuffer({ resolveWithObject: true });
const original = await sharp(stagingPng).raw().toBuffer();
await unlink(stagingPng);
if (decoded.info.width !== width || decoded.info.height !== height || Buffer.compare(decoded.data, original) !== 0) {
  console.error(`[gen-seawind] ${webpPath} does not decode to the PNG's bytes`);
  process.exit(1);
}
const size = (await stat(webpPath)).size;
const hash = createHash('sha256').update(await readFile(webpPath)).digest('hex');
console.log(`[gen-seawind] ${path.relative(process.cwd(), webpPath)}: ${width}x${height}, ${(size / 1024).toFixed(0)} KB lossless webp, sha256 ${hash}`);
if (pngPath) {
  await mkdir(path.dirname(path.resolve(pngPath)), { recursive: true });
  await writeFile(pngPath, png);
  console.log(`[gen-seawind] ${pngPath}: the map as a grey PNG, ${(png.length / 1024).toFixed(0)} KB`);
}
