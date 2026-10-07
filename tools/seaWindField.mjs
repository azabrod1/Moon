// The wind over the sea, as the one map Earth's ocean reads its glint from,
// generated here and baked by tools/gen-seawind.mjs into
// public/textures/earth-seawind.v1.webp: one byte a texel, the wind at 10 m
// over SEA_WIND_MAX_MS. Until the surface shader draws its single lobe from
// this map, the app still loads the pair this generator baked before
// (earth-seawind-calm.v1.webp, earth-seawind-windy.v1.webp), whose calm
// weight carried the lanes and regions described below.
//
// A glint is a picture of the wind. Where the wind field varies faster than
// the mirror lobe is wide (about 20 degrees of facet tilt at trade winds), the
// glint's shape is the field's; where it varies slower, the shape is the
// lobe's, which on a sphere is a circle.
//
// The field is a zonal climatology (the doldrums calm, the trades steady, the
// subtropical highs light, the westerlies and the Southern Ocean strong),
// domain-warped by about five degrees at thirty-degree cells so nothing runs
// along a parallel, with broad streaked structure on top: eight-degree cells,
// four octaves, stretched three to one along the streak and tilted 22 degrees
// from the parallels, mirrored across the equator and blended over eight
// degrees there, the way wind streaks lie. A finer grain can be added for a
// candidate (`grain`, off as shipped).
//
// Why there are no calm lanes or regions. The pair before this held a calm
// weight beside the windy speed: lanes a few texels wide and regions hundreds
// of kilometres across where the sea dropped to glassy, mixed in the shader
// as a second, glassy lobe. Set beside real GOES, VIIRS and ISS frames of the
// same day, the sea without them was the one that looked like the real one at
// every range; the lanes drew dark lines and the regions bright cores that no
// real frame showed. With no calm share the mixture is one lobe, so the map
// is one number a texel, the wind, and the sea is drawn with Cox-Munk's slope
// law at it.
//
// Why a mip of this map is fine. Averaging winds is biased where the field
// varies inside a block (the glint's peak goes as the reciprocal of the slope
// variance, which is convex in the wind), and that is what the calm weight
// existed to avoid. This field has nothing finer than its broad cells, so a
// block's mean wind keeps the glint's peak to within a few percent of the
// mean of its points' peaks; `seaWind.test.ts` measures it.
//
// Periodicity. Every noise is 2-D lattice gradient noise whose lattice hash
// wraps in BOTH axes with integer periods, so the field is seamless at the
// date line to the last bit: a streaked term samples
//   (x, y) = (lon / (S c), (lat - k lon) / c)
// with S the stretch, k = tan(tilt) and c the cell in degrees, and a lattice
// period of 360 / (S c) cells in x and 360 k / c in y (both chosen integers)
// makes a shift of lon by 360 land on the same lattice. The y period repeats
// the pattern every 360 k = 144 degrees of latitude, which no sea spans. The
// warps carry no tilt and need only the x period. `seaWind.test.ts` proves the
// equality f(lon) = f(lon + 360) at random points including the equatorial
// blend band.
//
// What is authored and what is measured. Cox-Munk's slope law is a fit; its
// zonal means are approximate values read off scatterometer climatologies;
// the broad structure's spread, cells and streak angle are look choices made
// against EPIC frames, not measurements. A gridded climatology or a real wind
// day can replace the field through the same map format (the DEV
// `?seawindmap=` override reads one).
//
// Everything here is plain arithmetic on plain arrays, so the same code runs
// under Node for the bake and under vitest for the tests; the types live in
// seaWindField.d.mts because tools/ sits outside the TypeScript project.

/** Cox-Munk's mean-square slope of a clean sea: this at no wind, and this
 *  much more per metre a second. world/seaWind.ts carries the same two
 *  numbers, and its test holds them to these. */
export const COX_MUNK_SLOPE_CALM = 0.003;
export const COX_MUNK_SLOPE_PER_MS = 0.00512;

/** The wind the map's full scale stands for, m/s: past a gale the sheen has
 *  stopped changing. world/seaWind.ts reads the byte back by it. */
export const SEA_WIND_MAX_MS = 16;

/** Cox-Munk's mean-square slope at a wind. */
export function meanSquareSlope(windMs) {
  return COX_MUNK_SLOPE_CALM + COX_MUNK_SLOPE_PER_MS * Math.max(windMs, 0);
}

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const smoothstep = (edgeFrom, edgeTo, x) => {
  const t = clamp((x - edgeFrom) / (edgeTo - edgeFrom), 0, 1);
  return t * t * (3 - 2 * t);
};

/** A lattice corner's value in [0, 1): an integer hash, seeded, so the field
 *  is the same field on every machine and in every build. */
function latticeHash(column, row, seed) {
  let hash = (Math.imul(column, 374761393) + Math.imul(row, 668265263) + Math.imul(seed, 1274126177)) | 0;
  hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 4294967296;
}

const quintic = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/** Gradient noise on a lattice that wraps every `periodX` cells in x and every
 *  `periodY` in y (0: no wrap), quintic-eased, scaled so one octave has a
 *  standard deviation near a third. */
function gradientNoise(x, y, seed, periodX, periodY) {
  const cellX = Math.floor(x);
  const cellY = Math.floor(y);
  const fractionX = x - cellX;
  const fractionY = y - cellY;
  const easeX = quintic(fractionX);
  const easeY = quintic(fractionY);
  const wrapX = (index) => ((index % periodX) + periodX) % periodX;
  const wrapY = periodY ? (index) => ((index % periodY) + periodY) % periodY : (index) => index;
  const corner = (column, row, dx, dy) => {
    const angle = latticeHash(wrapX(column), wrapY(row), seed) * 6.283185307179586;
    return Math.cos(angle) * dx + Math.sin(angle) * dy;
  };
  const corner00 = corner(cellX, cellY, fractionX, fractionY);
  const corner10 = corner(cellX + 1, cellY, fractionX - 1, fractionY);
  const corner01 = corner(cellX, cellY + 1, fractionX, fractionY - 1);
  const corner11 = corner(cellX + 1, cellY + 1, fractionX - 1, fractionY - 1);
  const lower = corner00 + (corner10 - corner00) * easeX;
  const upper = corner01 + (corner11 - corner01) * easeX;
  return (lower + (upper - lower) * easeY) * 1.4142;
}

/** Fractal noise (gain a half, lacunarity two) whose lattice periods double
 *  with each octave, so every octave wraps. */
function fractalNoise(x, y, octaves, seed, periodX, periodY) {
  let sum = 0;
  let amplitude = 1;
  let total = 0;
  let frequency = 1;
  for (let octave = 0; octave < octaves; octave++) {
    sum += amplitude * gradientNoise(
      x * frequency, y * frequency, seed + octave * 101, periodX * frequency, periodY * frequency,
    );
    total += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return sum / total;
}

/**
 * A streaked, tilted, periodic fractal noise over (longitude, latitude) in
 * degrees: cells `cellDeg` across, stretched `stretch` to one along the
 * streak, tilted by `tilt` (the tangent of the angle, signed). Throws for a
 * cell that would not wrap: the periods must be integers.
 */
function streakedNoise(lonDeg, latDeg, cellDeg, stretch, tilt, octaves, seed) {
  const periodX = 360 / (stretch * cellDeg);
  const periodY = tilt ? (360 * Math.abs(tilt)) / cellDeg : 0;
  if (Math.abs(periodX - Math.round(periodX)) > 1e-9 || Math.abs(periodY - Math.round(periodY)) > 1e-9) {
    throw new Error(`sea wind field: a cell of ${cellDeg} deg at stretch ${stretch}, tilt ${tilt} does not wrap`);
  }
  return fractalNoise(
    lonDeg / (stretch * cellDeg), (latDeg - tilt * lonDeg) / cellDeg, octaves, seed,
    Math.round(periodX), Math.round(periodY),
  );
}

/** Linear interpolation in a table of [key, value] rows sorted by key
 *  descending, clamped at both ends. */
function interpolateTable(table, key) {
  if (key >= table[0][0]) return table[0][1];
  for (let row = 1; row < table.length; row++) {
    const [keyHigh, valueHigh] = table[row - 1];
    const [keyLow, valueLow] = table[row];
    if (key >= keyLow) {
      const along = (key - keyLow) / (keyHigh - keyLow);
      return valueLow + (valueHigh - valueLow) * along;
    }
  }
  return table[table.length - 1][1];
}

/** The field's parameters, as shipped. Every number here is a look choice
 *  made against EPIC frames except the climatology, which is read off
 *  scatterometer means, good to about a metre a second. */
export const DEFAULTS = Object.freeze({
  /** Zonal mean wind by latitude, m/s at 10 m, north positive. */
  zonal: [
    [90, 8.0], [70, 9.0], [55, 9.5], [45, 9.0], [35, 6.5], [25, 6.0], [15, 7.0], [8, 5.5], [3, 3.6],
    [0, 3.3],
    [-3, 3.6], [-8, 5.5], [-15, 7.0], [-25, 6.0], [-35, 8.0], [-45, 10.5], [-55, 11.5], [-65, 10.5],
    [-90, 8.0],
  ],
  /** The streaked terms: stretch along the streak and the tangent of the
   *  streak's tilt from the parallels, mirrored across the equator. */
  stretch: 3,
  tilt: 0.4,
  /** Broad structure as a fraction of the zonal mean (four octaves from 8
   *  degree cells, clamped at two sigma), and a fine grain: its fraction, its
   *  cell and its octaves. The grain is off as shipped — a hair of texture at
   *  the disc scale, and the one term finer than a degree, which a mip of the
   *  map would average into a biased wind; a candidate with one is
   *  `--set=grain:0.1,grainCell:1.2,grainOctaves:1`. */
  broadSpread: 0.45,
  grain: 0,
  grainCell: 1.2,
  grainOctaves: 1,
  /** The n x n box of points a texel averages. At the shipped 1024x512, four
   *  a side is the same sixteen points each texel of the windy map before it
   *  averaged. */
  supersample: 4,
});

/** The per-latitude terms, computed once per row of points. */
function latitudeTerms(params, latDeg) {
  return {
    zonal: interpolateTable(params.zonal, latDeg),
    // The streaks tilt one way north of the equator and the other south of
    // it, blended over eight degrees so the seam is not a crease.
    northWeight: smoothstep(-4, 4, latDeg),
  };
}

/** Every noise term at a point, for one sign of the tilt. */
function noiseTerms(params, lonDeg, latDeg, tilt) {
  // A warp of about five degrees at thirty-degree cells, so no structure runs
  // along a parallel; the grain takes a finer one of about a degree on top.
  const warpLon = 5 * streakedNoise(lonDeg, latDeg, 30, 1, 0, 3, 7);
  const warpLat = 5 * streakedNoise(lonDeg, latDeg, 30, 1, 0, 3, 8);
  const lonWarped = lonDeg + warpLon;
  const latWarped = latDeg + warpLat;
  let grain = 0;
  if (params.grain > 0) {
    const lonFine = lonWarped + 1.2 * streakedNoise(lonDeg, latDeg, 5, 1, 0, 2, 9);
    const latFine = latWarped + 1.2 * streakedNoise(lonDeg, latDeg, 5, 1, 0, 2, 10);
    grain = streakedNoise(lonFine, latFine, params.grainCell, params.stretch, tilt, params.grainOctaves, 5) / 0.3;
  }
  return {
    broad: streakedNoise(lonWarped, latWarped, 8, params.stretch, tilt, 4, 1) / 0.3,
    grain,
  };
}

/** The wind at one point, m/s: the climatology with its broad structure and
 *  grain, floored at 0.1 and capped at the map's full scale. */
function windAtPoint(params, latTerms, lonDeg, latDeg) {
  const { northWeight } = latTerms;
  let broad;
  let grain;
  if (northWeight >= 1 || northWeight <= 0) {
    ({ broad, grain } = noiseTerms(params, lonDeg, latDeg, northWeight >= 1 ? params.tilt : -params.tilt));
  } else {
    const north = noiseTerms(params, lonDeg, latDeg, params.tilt);
    const south = noiseTerms(params, lonDeg, latDeg, -params.tilt);
    broad = north.broad * northWeight + south.broad * (1 - northWeight);
    grain = north.grain * northWeight + south.grain * (1 - northWeight);
  }
  return clamp(
    latTerms.zonal
      * (1 + params.broadSpread * clamp(broad, -2, 2))
      * (1 + params.grain * clamp(grain, -2, 2)),
    0.1, SEA_WIND_MAX_MS,
  );
}

/**
 * A point evaluator sharing the builder's arithmetic exactly, for the
 * periodicity and the mip tests: (longitude, latitude) in degrees to the
 * wind there, m/s.
 */
export function pointEvaluator(params = {}) {
  const merged = { ...DEFAULTS, ...params };
  return (lonDeg, latDeg) => windAtPoint(merged, latitudeTerms(merged, latDeg), lonDeg, latDeg);
}

/**
 * The field at `width` x `height`, row 0 the south pole (the layout three
 * samples a picture in with v = 0 at its bottom, and the shader reads): per
 * texel the mean wind over an n x n box of points.
 */
export function buildField(width, height, params = {}) {
  const merged = { ...DEFAULTS, ...params };
  const n = merged.supersample;
  if (!Number.isInteger(n) || n < 1) throw new Error(`sea wind field: a supersample of ${n} is not a positive integer`);
  const windMs = new Float32Array(width * height);
  const rowSum = new Float64Array(width);
  for (let row = 0; row < height; row++) {
    rowSum.fill(0);
    for (let subRow = 0; subRow < n; subRow++) {
      const latDeg = ((row + (subRow + 0.5) / n) / height) * 180 - 90;
      const latTerms = latitudeTerms(merged, latDeg);
      for (let column = 0; column < width; column++) {
        for (let subColumn = 0; subColumn < n; subColumn++) {
          const lonDeg = ((column + (subColumn + 0.5) / n) / width) * 360 - 180;
          rowSum[column] += windAtPoint(merged, latTerms, lonDeg, latDeg);
        }
      }
    }
    for (let column = 0; column < width; column++) windMs[row * width + column] = rowSum[column] / (n * n);
  }
  return { width, height, windMs };
}

/** The map as a grey picture, three bytes a texel and NORTH-UP — a picture's
 *  first row is its top — the wind over SEA_WIND_MAX_MS: the form the app
 *  reads as a one-channel mask. */
export function encodeWindGrey(field) {
  const { width, height, windMs } = field;
  const rgb = new Uint8Array(width * height * 3);
  for (let row = 0; row < height; row++) {
    const pictureRow = height - 1 - row;
    for (let column = 0; column < width; column++) {
      const byte = Math.round(clamp(windMs[row * width + column] / SEA_WIND_MAX_MS, 0, 1) * 255);
      const to = (pictureRow * width + column) * 3;
      rgb[to] = byte;
      rgb[to + 1] = byte;
      rgb[to + 2] = byte;
    }
  }
  return rgb;
}

/**
 * Area-weighted statistics of the wind by band of |latitude|, for the bake's
 * log and the tests: the mean wind, and the share under one and under two
 * metres a second. Land included — no ocean mask is read here.
 */
export function bandStatistics(field, latLowDeg, latHighDeg) {
  const { width, height, windMs } = field;
  let weight = 0;
  let windSum = 0;
  let under1 = 0;
  let under2 = 0;
  for (let row = 0; row < height; row++) {
    const latDeg = ((row + 0.5) / height) * 180 - 90;
    const absLat = Math.abs(latDeg);
    if (absLat < latLowDeg || absLat >= latHighDeg) continue;
    const rowWeight = Math.cos((latDeg * Math.PI) / 180);
    for (let column = 0; column < width; column++) {
      const index = row * width + column;
      weight += rowWeight;
      windSum += rowWeight * windMs[index];
      if (windMs[index] < 1) under1 += rowWeight;
      if (windMs[index] < 2) under2 += rowWeight;
    }
  }
  return {
    meanWindMs: windSum / weight,
    under1Fraction: under1 / weight,
    under2Fraction: under2 / weight,
  };
}
