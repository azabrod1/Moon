// Bake the sea's wind map, earth-seawind.v2.webp: R the wind's annual mean
// scalar speed, G and B the wind's axis (tools/seaWindMap.mjs says how they
// are stored and why), from NOAA NCEI's Blended Sea Winds monthly climatology.
//
//   npm run gen:seawind [-- --png=planning/data.png]
//     -> public/textures/earth-seawind.v2.webp            1024x512, lossless, alpha opaque
//        tools/goldens/seawind/earth-seawind.v2.stats.json  what the bake measured, the bars it passed
//        tools/goldens/seawind/earth-seawind.v2.points.json ten named points, the source's values beside the map's bytes
//   node --max-old-space-size=6144 tools/gen-seawind.mjs --out=planning/data --png=planning/data.png
//     -> a candidate of the same arm (<out>.webp, <out>.stats.json, <out>.points.json)
//   node --max-old-space-size=6144 tools/gen-seawind.mjs --synthetic --out=planning/synthetic --png=planning/synthetic.png [--set=broadSpread:0.6] [--width=2048]
//     -> the authored field (tools/seaWindField.mjs) as before, its speed byte
//        for byte the old earth-seawind.v1.webp's, with a zonal axis
//        (seaWindMap.mjs `syntheticAxis`); a candidate only
//   node --max-old-space-size=6144 tools/gen-seawind.mjs --synthetic-speed --out=planning/synthetic-speed --png=…
//     -> the authored speed with the data's axis: the data's accumulator a
//        divided by d at the authored speed, so d(R) x is still a; a candidate only
//
// Every arm writes the same RGBA map through one encoder (seaWindMap.mjs
// `encodeWindMap`), so the DEV `?seawindmap=` override reads any of them;
// `--png=` writes the same map as an RGB PNG (its G and B carry the axis, so
// it is not grey), the form that override reads. Every arm also measures what
// it wrote — the mip-bias statistics, the sea's band means, the seams — from
// the webp decoded back, and the shipped arm refuses to finish unless every
// bar passes (a candidate's failed bar is reported and written down). Every
// arm reads the source: the synthetic arm for the ocean mask its statistics
// are weighted by.
//
// The source, `.moon-data-cache/NBS_v02_wind_climmonthly_s1991_e2020_c20221206.nc`
// (NetCDF-4, so HDF5), is named with its URL and digest in
// tools/gen-seawind.sources.json; a file whose sha256 differs is refused. It
// is read with h5wasm, the whole file written into its virtual file system and
// one month of one variable sliced at a time; h5wasm and sharp are installed
// for the run and not saved, in ONE command (a second `--no-save` install
// prunes the first):
//
//   npm i --no-save sharp@0.35.4 h5wasm@0.10.3
//
// What the file holds is checked before anything is computed — the dataset
// names, shapes, types, fill and scale, the grid, the mask's classes and
// their counts — and the bake stops if any differs from what it was written
// against. The steps, in order:
//
// 1. Per cell and month, valid when the product's mask says ocean, lake or
//    river and u, v and the scalar speed w are all finite: the steadiness k =
//    |(u, v)| / w (w is the mean of the scalar speeds, so k is under one; it
//    is clamped at one and the cells over it counted), and the accumulator
//    k d(w) (cos 2 theta, sin 2 theta). A cell with fewer than six valid
//    months is unfilled; R is the mean of w over the valid months and a the
//    mean of the accumulator over the same months. (A mean over fewer months
//    would lean to the months that have data — under seasonal ice, to the
//    open-water season — but in this file every ocean, lake and river cell
//    has all twelve, so nothing leans.)
// 2. The source starts at 0 degrees and the map at -180: the grid is rolled
//    by half its width, and everything after is periodic in longitude — the
//    source's own seam (0 degrees) lands on the map's centre column, over the
//    open Gulf of Guinea, where the glint goes.
// 3. Unfilled cells (land, and none else in this file) take R and a from the
//    nearest cell of the open sea (seaWindMap.mjs `nearestFilledIndex`),
//    never a constant: a constant leaves a calm fringe along every coast once
//    the mips blur it. The open sea is the filled ocean cells joined, 8 ways
//    and around the date line, into a body of at least OPEN_SEA_MIN_CELLS
//    (`largeBodies`): the product classes inland water as ocean too (the
//    Amazon, Lake Malawi, Siberia's lakes, at 1-4 m/s), and seeded from it a
//    continent took those light winds and the coarse mips carried the calm
//    out over the coast. Every water cell keeps its own values: a lake the
//    app's water mask calls water reads the product's where the product has
//    it, and the open sea's nearest where it does not.
// 4. R and a are area-averaged to the map's grid (cos(latitude) times the
//    cells' overlap, from the quarter-degree cells' own bounds), and only
//    then a is divided by d at the speed the map stores (its byte read back),
//    so the shader's d(R) x is a again to within the axis's byte.
//
// Re-run it after any change to the generator, the field or the source, and
// move the pin in seaWind.test.ts (the shipped file's sha256, which the stats
// file names too) deliberately. A re-bake whose bytes differ after shipping
// ships under a new name (earth-seawind.v3.webp), as every data file the
// service worker caches does.
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { encodePng } from './pngEncode.mjs';
import { DEFAULTS, SEA_WIND_MAX_MS, bandStatistics, buildField } from './seaWindField.mjs';
import {
  AXIS_DIVISOR_FLOOR, MIP_BIAS_BARS, axisFromAccumulator, accumulateMonth, areaAverager, byteToAxis, byteToWind,
  createAccumulator, decodeWindMap, encodeWindMap, fillFromNearest, finishAccumulator, histogramQuantiles, largeBodies,
  latitudeOfRow, mipBias, nearestFilledIndex, rgbFromRgba, rollColumns, seamNumbers, slopeAnisotropy,
  syntheticAxis, windToByte, SYNTHETIC_STEADINESS, W_BINS_PER_MS,
} from './seaWindMap.mjs';

/** The shipped map: its size, name and the files the bake commits beside it. */
const SHIPPED_WIDTH = 1024;
const SHIPPED_MAP = 'public/textures/earth-seawind.v2.webp';
const GOLDENS = 'tools/goldens/seawind';
const SOURCE_FILE = 'NBS_v02_wind_climmonthly_s1991_e2020_c20221206.nc';
const SOURCE_PATH = path.join('.moon-data-cache', SOURCE_FILE);
/** A cell needs this many valid months to be filled. */
const MIN_VALID_MONTHS = 6;
/** The open sea, which alone seeds the land's fill: bodies of filled ocean
 *  cells at least this many quarter-degree cells (about 770,000 km² at the
 *  equator), larger than any lake. */
const OPEN_SEA_MIN_CELLS = 1000;

/** What the file held when the bake was written; any difference stops it. */
const EXPECTED = Object.freeze({
  datasets: ['crs', 'lat', 'lon', 'mask', 'month', 'u_wind', 'v_wind', 'windspeed', 'zlev'],
  gridShape: [12, 1, 719, 1440],
  dtypes: { u_wind: '<f', v_wind: '<f', windspeed: '<f', mask: '<d' },
  lat: { count: 719, first: -89.75, step: 0.25 },
  lon: { count: 1440, first: 0, step: 0.25 },
  months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  zlev: [10],
  maskCounts: { 0: 338697, 1: 694835, 2: 1827, 3: 1 },
});

/** The ten named points the tests read. A wind toward the angle theta (east
 *  0, north 90) has the axis (cos 2 theta, sin 2 theta): toward the
 *  south-west (the pure NE trade) (0, +1), toward the north-west (the pure SE
 *  trade) (0, -1), toward the east or the west (1, 0). The seam points sit at
 *  the centres of the shipped map's columns either side of 0 and of 180
 *  degrees. Each meaning says why the point was chosen; what the data hold
 *  there is in the numbers beside it. */
const POINTS = [
  { name: 'ne-trades', latDeg: 15, lonDeg: -150, meaning: 'the NE trades, central North Pacific: a wind from the north-east to east, x2 > 0' },
  { name: 'se-trades', latDeg: -15, lonDeg: -150, meaning: 'the SE trades, its mirror across the equator: a wind from the south-east to east, x2 <= 0' },
  { name: 'southern-westerly', latDeg: -55, lonDeg: 90, meaning: 'a Southern Ocean westerly, toward the east: x1 > 0, x2 near 0' },
  { name: 'arabian-sea', latDeg: 15, lonDeg: 62, meaning: 'the Arabian Sea: the NE monsoon (toward the south-west) and the SW monsoon (toward the north-east), each steady, share one axis in doubled angle, where a plain mean of the vectors would cancel' },
  { name: 'doldrums', latDeg: 5, lonDeg: -140, meaning: 'the point the plan named for the doldrums, expected light and unsteady (a small |x|)' },
  { name: 'south-china-sea', latDeg: 12, lonDeg: 113, meaning: 'the South China Sea: another monsoon sea whose wind reverses with the season' },
  { name: 'seam-centre-west', latDeg: 0, lonDeg: -180 + 511.5 * (360 / 1024), meaning: 'the map column just west of 0 degrees, where the source\'s own seam lands, open Gulf of Guinea' },
  { name: 'seam-centre-east', latDeg: 0, lonDeg: -180 + 512.5 * (360 / 1024), meaning: 'the map column just east of 0 degrees' },
  { name: 'seam-edge-west', latDeg: 30, lonDeg: -180 + 1023.5 * (360 / 1024), meaning: 'the map\'s last column, just west of 180 degrees, open North Pacific' },
  { name: 'seam-edge-east', latDeg: 30, lonDeg: -180 + 0.5 * (360 / 1024), meaning: 'the map\'s first column, just east of -180 degrees' },
];

function arg(name, fallback) {
  const hit = process.argv.find((candidate) => candidate.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);
const fail = (message) => {
  console.error(`[gen-seawind] ${message}`);
  process.exit(1);
};

const arm = flag('synthetic-speed') ? 'synthetic-speed' : flag('synthetic') ? 'synthetic' : 'data';
const out = arg('out', '');
const shipped = !out;
const width = Number(arg('width', String(SHIPPED_WIDTH)));
const height = width / 2;
const pngPath = arg('png', '');
if (shipped && arm !== 'data') fail(`the ${arm} arm is a candidate only: give it --out=<path prefix>`);
if (!Number.isInteger(width) || !Number.isInteger(height) || width < 4) fail(`width ${width} is not an even positive integer`);
if (shipped && width !== SHIPPED_WIDTH) fail(`the shipped map is ${SHIPPED_WIDTH}x${SHIPPED_WIDTH / 2}: bake a candidate with --out=`);
/** `--set=key:value,...` overrides numeric DEFAULTS of the authored field for
 *  a synthetic candidate. */
const overrides = Object.fromEntries(
  arg('set', '').split(',').filter(Boolean).map((pair) => {
    const [key, value] = pair.split(':');
    if (!(key in DEFAULTS) || typeof DEFAULTS[key] !== 'number' || !Number.isFinite(Number(value))) fail(`--set: ${pair} is not a numeric DEFAULTS key`);
    return [key, Number(value)];
  }),
);
if (Object.keys(overrides).length && arm === 'data') fail('--set moves the authored field: give it --synthetic or --synthetic-speed');
const webpPath = shipped ? path.resolve(SHIPPED_MAP) : `${path.resolve(out)}.webp`;
const statsPath = shipped ? path.resolve(GOLDENS, 'earth-seawind.v2.stats.json') : `${path.resolve(out)}.stats.json`;
const pointsPath = shipped ? path.resolve(GOLDENS, 'earth-seawind.v2.points.json') : `${path.resolve(out)}.points.json`;

let sharp;
let h5wasm;
try {
  sharp = (await import('sharp')).default;
  h5wasm = (await import('h5wasm')).default;
} catch {
  fail('sharp or h5wasm is not installed: `npm i --no-save sharp@0.35.4 h5wasm@0.10.3` (one command) and re-run.');
}

const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)} s`;
const log = (line) => console.log(`[gen-seawind] ${line}`);
const fixed = (value, digits = 3) => Number(value.toFixed(digits));

// ---------------------------------------------------------------------------
// The source: digest, facts, the months into the accumulator.

const manifest = JSON.parse(await readFile(new URL('./gen-seawind.sources.json', import.meta.url), 'utf8'));
const sourceEntry = manifest[SOURCE_FILE];
if (!sourceEntry) fail(`gen-seawind.sources.json names no ${SOURCE_FILE}`);
let sourceBytes;
try {
  sourceBytes = await readFile(SOURCE_PATH);
} catch {
  fail(`${SOURCE_PATH} is missing: fetch ${sourceEntry.url} into .moon-data-cache/`);
}
const sourceDigest = createHash('sha256').update(sourceBytes).digest('hex');
if (sourceDigest !== sourceEntry.sha256 || sourceBytes.length !== sourceEntry.bytes) {
  fail(`${SOURCE_FILE}: sha256 ${sourceDigest} (${sourceBytes.length} bytes) is not the manifest's ${sourceEntry.sha256} (${sourceEntry.bytes}) — a different source; update gen-seawind.sources.json together with the map baked from it`);
}
log(`${SOURCE_FILE}: ${sourceBytes.length} bytes, sha256 ${sourceDigest} (the manifest's)`);

const { FS } = await h5wasm.ready;
FS.writeFile('clim.nc', new Uint8Array(sourceBytes.buffer, sourceBytes.byteOffset, sourceBytes.byteLength));
sourceBytes = null;
const file = new h5wasm.File('clim.nc', 'r');
const attribute = (dataset, name) => {
  const value = dataset.attrs?.[name]?.value;
  return ArrayBuffer.isView(value) || Array.isArray(value) ? Number(value[0]) : value;
};

const facts = {};
const mismatches = [];
const expectEqual = (label, actual, expected) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) mismatches.push(`${label}: ${JSON.stringify(actual)}, written against ${JSON.stringify(expected)}`);
};
facts.datasets = [...file.keys()].sort();
expectEqual('datasets', facts.datasets, EXPECTED.datasets);
facts.variables = {};
for (const name of ['u_wind', 'v_wind', 'windspeed', 'mask']) {
  const dataset = file.get(name);
  const entry = {
    shape: dataset.shape,
    dtype: dataset.dtype,
    fillValue: String(attribute(dataset, '_FillValue')),
    scaleFactor: attribute(dataset, 'scale_factor') ?? 1,
    addOffset: attribute(dataset, 'add_offset') ?? 0,
  };
  facts.variables[name] = entry;
  expectEqual(`${name} shape`, entry.shape, EXPECTED.gridShape);
  expectEqual(`${name} dtype`, entry.dtype, EXPECTED.dtypes[name]);
  if (name !== 'mask') {
    expectEqual(`${name} _FillValue`, entry.fillValue, 'NaN');
    expectEqual(`${name} scale_factor`, entry.scaleFactor, 1);
    expectEqual(`${name} add_offset`, entry.addOffset, 0);
  }
}
const latitudes = Float64Array.from(file.get('lat').value);
const longitudes = Float64Array.from(file.get('lon').value);
const gridCheck = (values, { count, first, step }) => values.length === count
  && values.every((value, index) => Math.abs(value - (first + index * step)) < 1e-6);
facts.lat = { count: latitudes.length, first: latitudes[0], last: latitudes[latitudes.length - 1] };
facts.lon = { count: longitudes.length, first: longitudes[0], last: longitudes[longitudes.length - 1] };
if (!gridCheck(latitudes, EXPECTED.lat)) mismatches.push(`lat: ${JSON.stringify(facts.lat)} is not ${JSON.stringify(EXPECTED.lat)} at every point`);
if (!gridCheck(longitudes, EXPECTED.lon)) mismatches.push(`lon: ${JSON.stringify(facts.lon)} is not ${JSON.stringify(EXPECTED.lon)} at every point`);
facts.months = Array.from(file.get('month').value, Number);
facts.zlev = Array.from(file.get('zlev').value, Number);
expectEqual('month', facts.months, EXPECTED.months);
expectEqual('zlev', facts.zlev, EXPECTED.zlev);
log(`datasets ${facts.datasets.join(', ')}`);
for (const [name, entry] of Object.entries(facts.variables)) {
  log(`  ${name}: shape [${entry.shape}] ${entry.dtype}, _FillValue ${entry.fillValue}, scale_factor ${entry.scaleFactor}, add_offset ${entry.addOffset}`);
}
log(`  lat ${facts.lat.count} points ${facts.lat.first}..${facts.lat.last}; lon ${facts.lon.count} points ${facts.lon.first}..${facts.lon.last}; months ${facts.months.join(',')}; zlev ${facts.zlev}`);

const SRC_HEIGHT = latitudes.length;
const SRC_WIDTH = longitudes.length;
const CELLS = SRC_WIDTH * SRC_HEIGHT;
const slab = (name, month) => file.get(name).slice([[month, month + 1], [0, 1], [0, SRC_HEIGHT], [0, SRC_WIDTH]]);
/** The source cell nearest a point (the grid's points are whole quarter
 *  degrees from -89.75 and from 0). */
const sourceCellOf = (latDeg, lonDeg) => {
  const row = Math.round((latDeg - latitudes[0]) / 0.25);
  const column = Math.round((((lonDeg % 360) + 360) % 360) / 0.25) % SRC_WIDTH;
  return row * SRC_WIDTH + column;
};
const pointCells = POINTS.map((point) => sourceCellOf(point.latDeg, point.lonDeg));

const accumulator = createAccumulator(CELLS);
const monthly = [];
let maskClasses = null;
const kPooled = new Float64Array(10001);
for (let month = 0; month < 12; month++) {
  const mask = slab('mask', month);
  const counts = {};
  for (const value of mask) counts[value] = (counts[value] ?? 0) + 1;
  expectEqual(`mask classes, month ${month + 1}`, counts, EXPECTED.maskCounts);
  if (!maskClasses) maskClasses = Uint8Array.from(mask);
  let changed = 0;
  for (let cell = 0; cell < CELLS; cell++) if (mask[cell] !== maskClasses[cell]) changed++;
  const variables = facts.variables;
  const result = accumulateMonth(accumulator, {
    u: slab('u_wind', month), v: slab('v_wind', month), w: slab('windspeed', month), mask,
    uScale: variables.u_wind.scaleFactor, uOffset: variables.u_wind.addOffset,
    vScale: variables.v_wind.scaleFactor, vOffset: variables.v_wind.addOffset,
    wScale: variables.windspeed.scaleFactor, wOffset: variables.windspeed.addOffset,
  }, pointCells);
  result.kHistogram.forEach((count, bin) => { kPooled[bin] += count; });
  const [p05, p50, p95] = histogramQuantiles(result.kHistogram, [0.05, 0.5, 0.95]);
  const [windP50, windP95] = histogramQuantiles(result.windHistogram, [0.5, 0.95], W_BINS_PER_MS);
  monthly.push({
    month: month + 1,
    validCells: result.valid,
    k: { p05, p50, p95, overOne: result.kOverOne },
    windMs: { p50: windP50, p95: windP95, max: fixed(result.windMax, 2) },
    nonFiniteByClass: result.nonFinite,
    maskChangedCells: changed,
    watched: result.watched,
  });
  log(`month ${String(month + 1).padStart(2)}: ${result.valid} valid cells, k p05 ${p05.toFixed(2)} median ${p50.toFixed(2)} p95 ${p95.toFixed(2)}, ${result.kOverOne} over one; `
    + `w median ${windP50.toFixed(2)} p95 ${windP95.toFixed(2)} max ${result.windMax.toFixed(2)} m/s; non-finite by class ${JSON.stringify(result.nonFinite)}; mask changed at ${changed} cells (${elapsed()})`);
}
file.close();
facts.maskCounts = Object.fromEntries(Object.entries(EXPECTED.maskCounts).map(([cls]) => [cls, maskClasses.filter((value) => value === Number(cls)).length]));
for (const month of [1, 7]) {
  const nonLand = Object.entries(monthly[month - 1].nonFiniteByClass).filter(([cls]) => cls !== '0').reduce((sum, [, count]) => sum + count, 0);
  if (nonLand) mismatches.push(`month ${month}: ${nonLand} non-land cells are not finite, where every one was`);
}
if (mismatches.length) {
  for (const line of mismatches) console.error(`[gen-seawind] the source differs from what the bake was written against: ${line}`);
  process.exit(1);
}
log(`mask classes ${JSON.stringify(facts.maskCounts)}, the same in every month: the source is what the bake was written against`);
const [kP05, kP50, kP95] = histogramQuantiles(kPooled, [0.05, 0.5, 0.95]);
log(`k over every valid cell-month: p05 ${kP05.toFixed(2)}, median ${kP50.toFixed(2)}, p95 ${kP95.toFixed(2)}`);

const finished = finishAccumulator(accumulator, MIN_VALID_MONTHS);
const classCounts = {};
for (let cell = 0; cell < CELLS; cell++) {
  const cls = maskClasses[cell];
  const entry = (classCounts[cls] ??= { cells: 0, filled: 0, unfilled: 0, validMonths: 0 });
  entry.cells++;
  entry.validMonths += accumulator.months[cell];
  if (finished.filled[cell]) entry.filled++;
  else entry.unfilled++;
}
const filledCount = finished.filled.reduce((sum, value) => sum + value, 0);
log(`cells by class (filled with >= ${MIN_VALID_MONTHS} valid months / unfilled / valid cell-months): `
  + Object.entries(classCounts).map(([cls, entry]) => `${cls}: ${entry.filled}/${entry.unfilled}/${entry.validMonths}`).join(', ')
  + `; ${CELLS - filledCount} unfilled in all`);
const filledWinds = Array.from(finished.windMs).filter((_, cell) => finished.filled[cell]).sort((x, y) => x - y);
const quantileOf = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
const annual = {
  medianMs: fixed(quantileOf(filledWinds, 0.5), 2),
  p95Ms: fixed(quantileOf(filledWinds, 0.95), 2),
  maxMs: fixed(filledWinds[filledWinds.length - 1], 2),
  overFullScale: filledWinds.filter((wind) => wind > SEA_WIND_MAX_MS).length,
};
log(`the annual mean speed over the filled cells: median ${annual.medianMs} m/s, p95 ${annual.p95Ms}, max ${annual.maxMs} (${annual.overFullScale} cells over ${SEA_WIND_MAX_MS} m/s clamp at 255)`);

// ---------------------------------------------------------------------------
// The grid: roll to -180, fill, area-average.

const HALF = SRC_WIDTH / 2;
const rolled = {
  windMs: rollColumns(finished.windMs, SRC_WIDTH, SRC_HEIGHT, HALF),
  a1: rollColumns(finished.a1, SRC_WIDTH, SRC_HEIGHT, HALF),
  a2: rollColumns(finished.a2, SRC_WIDTH, SRC_HEIGHT, HALF),
  filled: rollColumns(finished.filled, SRC_WIDTH, SRC_HEIGHT, HALF),
  ocean: rollColumns(Float64Array.from(maskClasses, (cls) => (cls === 1 ? 1 : 0)), SRC_WIDTH, SRC_HEIGHT, HALF),
};
const openSea = largeBodies(rolled.filled.map((value, cell) => (value && rolled.ocean[cell] === 1 ? 1 : 0)), SRC_WIDTH, SRC_HEIGHT, OPEN_SEA_MIN_CELLS);
const nearest = nearestFilledIndex(openSea.kept, SRC_WIDTH, SRC_HEIGHT);
fillFromNearest([rolled.windMs, rolled.a1, rolled.a2], rolled.filled, nearest);
log(`rolled by ${HALF} columns to start at -180; the open sea is ${openSea.bodiesKept} bodies of filled ocean cells of ${OPEN_SEA_MIN_CELLS} or more, `
  + `${openSea.bodiesDropped} smaller ones (${openSea.cellsDropped} cells: inland water the product classes as ocean) keep their values and seed nothing; the unfilled cells filled from the nearest open sea (${elapsed()})`);

const average = areaAverager({
  srcWidth: SRC_WIDTH, srcHeight: SRC_HEIGHT,
  // Rolled, the first cell is centred on -180 and straddles the date line.
  srcWestEdgeDeg: -180 - 0.125, srcLatCentreDeg: (row) => latitudes[row], srcRowHeightDeg: 0.25,
  dstWidth: width, dstHeight: height,
});
const dataWind = average(rolled.windMs);
const dataA1 = average(rolled.a1);
const dataA2 = average(rolled.a2);
const sea = average(rolled.ocean);
log(`area-averaged to ${width}x${height} (${elapsed()})`);

// ---------------------------------------------------------------------------
// The arm's speed and axis.

let windMs;
if (arm === 'data') {
  windMs = dataWind;
} else {
  windMs = buildField(width, height, overrides).windMs;
  log(`the authored field at ${width}x${height}${Object.keys(overrides).length ? ` with ${JSON.stringify(overrides)}` : ''} built (${elapsed()})`);
}
const axisX = new Float64Array(width * height);
const axisY = new Float64Array(width * height);
for (let row = 0; row < height; row++) {
  const zonal = syntheticAxis(latitudeOfRow(row, height));
  for (let column = 0; column < width; column++) {
    const texel = row * width + column;
    // The divisor is d at the speed the map stores, so the shader's d(R) x
    // rebuilds a to within the axis byte.
    const [x1, x2] = arm === 'synthetic' ? zonal : axisFromAccumulator(dataA1[texel], dataA2[texel], byteToWind(windToByte(windMs[texel])));
    axisX[texel] = x1;
    axisY[texel] = x2;
  }
}

// ---------------------------------------------------------------------------
// The files: the webp, verified to decode to the bytes encoded, and the PNG.

const rgba = encodeWindMap({ width, height, windMs, axisX, axisY });
await mkdir(path.dirname(webpPath), { recursive: true });
await sharp(Buffer.from(rgba), { raw: { width, height, channels: 4 } }).webp({ lossless: true, effort: 6 }).toFile(webpPath);
const decodedFile = await sharp(webpPath).raw().toBuffer({ resolveWithObject: true });
const channels = decodedFile.info.channels;
let mismatch = decodedFile.info.width !== width || decodedFile.info.height !== height;
for (let texel = 0; texel < width * height && !mismatch; texel++) {
  for (let channel = 0; channel < 4; channel++) {
    const expected = rgba[texel * 4 + channel];
    const actual = channel < channels ? decodedFile.data[texel * channels + channel] : 255;
    if (actual !== expected) {
      mismatch = true;
      break;
    }
  }
}
if (mismatch) {
  await unlink(webpPath);
  fail(`${webpPath} does not decode to the bytes encoded`);
}
const mapFileBytes = await readFile(webpPath);
const mapSha256 = createHash('sha256').update(mapFileBytes).digest('hex');
log(`${path.relative(process.cwd(), webpPath)}: ${width}x${height}, ${(mapFileBytes.length / 1024).toFixed(0)} KB lossless webp (${channels} channels decoded, alpha 255), sha256 ${mapSha256}`);
if (pngPath) {
  const png = encodePng(width, height, 3, rgbFromRgba(rgba));
  await mkdir(path.dirname(path.resolve(pngPath)), { recursive: true });
  await writeFile(pngPath, png);
  log(`${pngPath}: the same map as an RGB PNG, ${(png.length / 1024).toFixed(0)} KB`);
}

// ---------------------------------------------------------------------------
// What the bake measures on the map it wrote, decoded back.

const decoded = decodeWindMap(decodedFile.data, width, height, channels);
const bands = [['0-15', 0, 15], ['15-30', 15, 30], ['30-45', 30, 45], ['45-60', 45, 60], ['60-90', 60, 90.01], ['0-25', 0, 25]].map(([label, low, high]) => {
  const stats = bandStatistics({ width, height, windMs: decoded.windMs }, low, high, sea);
  log(`|lat| ${label}: sea mean ${stats.meanWindMs.toFixed(2)} m/s, under 1 m/s ${(100 * stats.under1Fraction).toFixed(2)} %, under 2 m/s ${(100 * stats.under2Fraction).toFixed(2)} % (cos(latitude) x ocean share)`);
  return { band: label, meanWindMs: fixed(stats.meanWindMs), under1Fraction: fixed(stats.under1Fraction, 5), under2Fraction: fixed(stats.under2Fraction, 5) };
});

const mapSeams = seamNumbers(
  { width, height, channels: { R: decoded.red, G: decoded.green, B: decoded.blue }, sea },
  { 'edge (+-180)': width - 1, 'centre (0)': width / 2 - 1 },
);
const sourceSeams = seamNumbers(
  { width: SRC_WIDTH, height: SRC_HEIGHT, channels: { R: rolled.windMs, a1: rolled.a1, a2: rolled.a2 }, sea: rolled.ocean },
  { 'edge (+-180)': SRC_WIDTH - 1, 'source seam (0)': HALF - 1 },
);
const seamLines = (label, report) => {
  for (const [name, entry] of Object.entries(report)) {
    const channelsText = Object.entries(entry).filter(([key]) => !['columns', 'lonDeg'].includes(key))
      .map(([key, value]) => `${key} ${value.meanAbsDiff.toFixed(4)} (others median ${value.othersMedian.toFixed(4)}, p95 ${value.othersP95.toFixed(4)}, max ${value.othersMax.toFixed(4)}; percentile ${(100 * value.percentile).toFixed(0)})`)
      .join('; ');
    log(`seam ${label} ${name}, columns ${entry.columns.join('|')}: mean |difference| ${channelsText}`);
  }
};
seamLines('map', mapSeams);
seamLines('source (quarter-degree, after the roll and fill)', sourceSeams);
const seamsPass = [mapSeams, sourceSeams].every((report) => Object.values(report).every((entry) => Object.entries(entry)
  .filter(([key]) => !['columns', 'lonDeg'].includes(key)).every(([, value]) => value.pass)));

const bias = mipBias({ width, height, windMs: decoded.windMs, axisX: decoded.axisX, axisY: decoded.axisY, sea });
for (const entry of bias.levels) {
  for (const row of entry.speed) {
    log(`mip ${entry.level} (${entry.blockTexels}x${entry.blockTexels}, ${entry.blocks} blocks) speed at ${row.tiltDeg} deg: mean ${row.mean.toFixed(4)}, p99 ${row.p99.toFixed(4)}, max ${row.max.toFixed(4)} at ${row.maxAtLatLon.map((v) => v.toFixed(1)).join(', ')}, ${row.over10Percent} over 0.10 — ${row.pass ? 'pass' : 'FAIL'}`);
  }
  for (const row of entry.anisotropy) {
    log(`mip ${entry.level} anisotropy x${row.component}: mean ${row.mean.toFixed(4)}, p99 ${row.p99.toFixed(4)}, max ${row.max.toFixed(4)} at ${row.maxAtLatLon.map((v) => v.toFixed(1)).join(', ')} — ${row.pass ? 'pass' : 'FAIL'}`);
  }
}
log(`mip bias against the bars (weighted mean under ${MIP_BIAS_BARS.mean}, weighted p99 under ${MIP_BIAS_BARS.p99}): ${bias.pass ? 'every level and tilt passes' : 'FAILS'}`);

// The ten points. Per point the quarter-degree cell nearest it, and the
// texel's footprint averaged straight from the UNROLLED source (its own loop
// over the cells' longitudes in 0..360, not the roll or the resampler above),
// beside the map's bytes at that texel read back from the decoded webp: the
// map must be its footprint to within a byte, which a roll, a row flip or a
// G/B swap in the file breaks. The nearest cell is not the texel: where the
// wind turns inside a texel (the equator, the doldrums) the two differ by a
// few bytes, so the cell is a reference and the footprint the check.
const pointColumn = (lonDeg) => ((Math.floor(((lonDeg + 180) / 360) * width) % width) + width) % width;
const pointRow = (latDeg) => Math.min(height - 1, Math.floor(((latDeg + 90) / 180) * height));
function footprintOf(column, row) {
  const west = -180 + (column * 360) / width;
  const east = west + 360 / width;
  const south = -90 + (row * 180) / height;
  const north = south + 180 / height;
  let weightSum = 0;
  let windSum = 0;
  let a1Sum = 0;
  let a2Sum = 0;
  let cells = 0;
  let unfilled = 0;
  for (let sourceRow = 0; sourceRow < SRC_HEIGHT; sourceRow++) {
    const lat = latitudes[sourceRow];
    const latOverlap = Math.min(north, lat + 0.125) - Math.max(south, lat - 0.125);
    if (latOverlap <= 0) continue;
    for (let sourceColumn = 0; sourceColumn < SRC_WIDTH; sourceColumn++) {
      for (const shift of [-360, 0, 360]) {
        const lon = longitudes[sourceColumn] + shift;
        const lonOverlap = Math.min(east, lon + 0.125) - Math.max(west, lon - 0.125);
        if (lonOverlap <= 0) continue;
        const cell = sourceRow * SRC_WIDTH + sourceColumn;
        const weight = Math.cos((lat * Math.PI) / 180) * latOverlap * lonOverlap;
        cells++;
        if (!finished.filled[cell]) unfilled++;
        weightSum += weight;
        windSum += weight * finished.windMs[cell];
        a1Sum += weight * finished.a1[cell];
        a2Sum += weight * finished.a2[cell];
      }
    }
  }
  const footprintWind = windSum / weightSum;
  const [x1, x2] = axisFromAccumulator(a1Sum / weightSum, a2Sum / weightSum, byteToWind(windToByte(footprintWind)));
  return { cells, unfilled, windMs: fixed(footprintWind, 4), x1: fixed(x1, 4), x2: fixed(x2, 4) };
}
const points = POINTS.map((point, index) => {
  const cell = pointCells[index];
  const sourceRow = Math.floor(cell / SRC_WIDTH);
  const sourceColumn = cell % SRC_WIDTH;
  const sourceWind = finished.windMs[cell];
  const [x1, x2] = axisFromAccumulator(finished.a1[cell], finished.a2[cell], sourceWind);
  const monthsOfPoint = monthly.map((entry) => entry.watched[index]);
  const column = pointColumn(point.lonDeg);
  const row = pointRow(point.latDeg);
  const pictureRow = height - 1 - row;
  const at = (pictureRow * width + column) * channels;
  const bytes = [decodedFile.data[at], decodedFile.data[at + 1], decodedFile.data[at + 2], channels === 4 ? decodedFile.data[at + 3] : 255];
  return {
    name: point.name,
    meaning: point.meaning,
    latDeg: point.latDeg,
    lonDeg: point.lonDeg,
    nearestCell: {
      row: sourceRow, column: sourceColumn, latDeg: latitudes[sourceRow], lonDeg: longitudes[sourceColumn],
      filled: finished.filled[cell] === 1, validMonths: accumulator.months[cell],
      windMs: fixed(sourceWind, 4), x1: fixed(x1, 4), x2: fixed(x2, 4), anisotropy: fixed(slopeAnisotropy(sourceWind), 6),
      kByMonth: monthsOfPoint.map((entry) => fixed(entry.k, 3)),
      towardDegByMonth: monthsOfPoint.map((entry) => fixed(entry.towardDeg, 1)),
    },
    footprint: footprintOf(column, row),
    map: {
      column, row, pictureRow, bytes,
      windMs: fixed(byteToWind(bytes[0]), 4), x1: fixed(byteToAxis(bytes[1]), 4), x2: fixed(byteToAxis(bytes[2]), 4),
    },
  };
});
let pointsHold = true;
for (const point of points) {
  const { nearestCell, footprint, map } = point;
  const cellGap = Math.max(Math.abs(map.x1 - nearestCell.x1), Math.abs(map.x2 - nearestCell.x2)) * 127;
  const footprintGap = Math.max(Math.abs(map.x1 - footprint.x1), Math.abs(map.x2 - footprint.x2)) * 127;
  const windGap = (Math.abs(map.windMs - footprint.windMs) / SEA_WIND_MAX_MS) * 255;
  const holds = footprint.unfilled === 0 && footprintGap <= 1.001 && windGap <= 1.001;
  if (arm === 'data' && !holds) pointsHold = false;
  log(`point ${point.name} (${point.latDeg}, ${point.lonDeg.toFixed(3)}): nearest cell R ${nearestCell.windMs.toFixed(2)} m/s x (${nearestCell.x1.toFixed(3)}, ${nearestCell.x2.toFixed(3)}), k Jan ${nearestCell.kByMonth[0]} Jul ${nearestCell.kByMonth[6]}; `
    + `footprint (${footprint.cells} cells) R ${footprint.windMs.toFixed(2)} x (${footprint.x1.toFixed(3)}, ${footprint.x2.toFixed(3)}); `
    + `map texel (${map.column}, ${map.row}) bytes [${map.bytes}] = ${map.windMs.toFixed(2)} m/s x (${map.x1.toFixed(3)}, ${map.x2.toFixed(3)}); `
    + `axis gap ${footprintGap.toFixed(2)} bytes to the footprint, ${cellGap.toFixed(2)} to the nearest cell, speed gap ${windGap.toFixed(2)} bytes${arm === 'data' && !holds ? ' -- THE MAP IS NOT ITS FOOTPRINT' : ''}`);
}

// ---------------------------------------------------------------------------
// The record.

const allBarsPassed = bias.pass && seamsPass && pointsHold;
const stats = {
  _: 'Written by tools/gen-seawind.mjs; seaWind.test.ts checks that the shipped map is the file named here and that every bar passed. Every number is measured on the map decoded back from the webp, except the source facts and the source seams.',
  arm,
  map: { file: shipped ? path.basename(SHIPPED_MAP) : path.relative(process.cwd(), webpPath), width, height, bytes: mapFileBytes.length, sha256: mapSha256, channelsDecoded: channels },
  source: { file: SOURCE_FILE, sha256: sourceDigest, url: sourceEntry.url, reader: 'h5wasm 0.10.3' },
  facts,
  steadiness: {
    note: 'k = |(u, v)| / w over the valid cells of each month; clamped at one, the cells over it counted',
    pooled: { p05: kP05, p50: kP50, p95: kP95 },
    byMonth: monthly.map((entry) => ({ month: entry.month, ...entry.k })),
  },
  cells: {
    minValidMonths: MIN_VALID_MONTHS,
    byClass: classCounts,
    unfilled: CELLS - filledCount,
    nonFiniteByMonthAndClass: monthly.map((entry) => ({ month: entry.month, ...entry.nonFiniteByClass })),
  },
  speedByMonth: monthly.map((entry) => ({ month: entry.month, ...entry.windMs })),
  annualSpeed: annual,
  speedSmoothing: { sigmaSourceCells: 0, note: 'none applied' },
  fill: {
    rule: 'unfilled cells (land) take R and a from the nearest open-sea cell, in the quarter-degree grid\'s own metric, longitude periodic; every water cell keeps its own values',
    openSeaMinCells: OPEN_SEA_MIN_CELLS,
    openSeaBodies: openSea.bodiesKept,
    smallerOceanBodies: openSea.bodiesDropped,
    smallerOceanCells: openSea.cellsDropped,
  },
  axis: {
    law: 'x = mean over valid months of k_m d(w_m) (cos 2 theta_m, sin 2 theta_m), area-averaged, divided by d(R) at the stored speed, clamped to the unit disc; d(U) = 0.00316 U - (0.003 + 0.00192 U)',
    divisorFloor: AXIS_DIVISOR_FLOOR,
    syntheticSteadiness: arm === 'synthetic' ? SYNTHETIC_STEADINESS : undefined,
  },
  bands,
  seams: { map: mapSeams, source: arm === 'data' ? sourceSeams : undefined, pass: seamsPass },
  pointsHold: arm === 'data' ? pointsHold : undefined,
  mipBias: bias,
  allBarsPassed,
};
await mkdir(path.dirname(statsPath), { recursive: true });
await writeFile(statsPath, `${JSON.stringify(stats, null, 1)}\n`);
log(`${path.relative(process.cwd(), statsPath)}: the statistics`);
await writeFile(pointsPath, `${JSON.stringify({
  _: 'Written by tools/gen-seawind.mjs: per point the quarter-degree source cell nearest it (its R, its axis x = a / d(R), its steadiness k and the angle its mean wind blows toward, each month), the texel\'s footprint averaged straight from the unrolled source, beside the shipped map\'s bytes at the texel holding the point, read back from the decoded webp. surfaceMaps.test.ts holds the bytes to the footprint to within a byte, and to the nearest cell within a few.',
  map: stats.map.file, sha256: mapSha256, width, height, points,
}, null, 1)}\n`);
log(`${path.relative(process.cwd(), pointsPath)}: the ten points`);
const barsLine = `mip bias ${bias.pass ? 'pass' : 'FAIL'}, seams ${seamsPass ? 'pass' : 'FAIL'}, points ${pointsHold ? 'hold' : 'FAIL'}`;
// The shipped map must pass every bar; a candidate's failure is a number for
// the look, reported and written down, not a reason to stop.
if (!allBarsPassed && shipped) fail(`a bar failed (${barsLine}): see ${statsPath}`);
log(allBarsPassed ? `every bar passed (${elapsed()})` : `a bar failed (${barsLine}), reported in ${path.relative(process.cwd(), statsPath)}: a candidate, not shipped (${elapsed()})`);
