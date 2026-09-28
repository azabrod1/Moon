// The wind over the sea, as the two-channel map Earth's ocean reads its glint
// from (src/planetarium/world/seaWind.ts), generated here and baked by
// tools/gen-seawind.mjs into public/textures/earth-seawind.v1.webp.
//
// A glint is a picture of the wind. Where the wind field varies faster than
// the mirror lobe is wide (about 20 degrees of facet tilt at trade winds), the
// glint's shape is the field's; where it varies slower, the shape is the
// lobe's, which on a sphere is a circle. A wind field authored as a zonal mean
// plus broad noise (the first version of this map) drew the circle: a
// featureless round glow. What the EPIC frames show instead is a broad faint
// sheen from the trade-wind sea, a bright irregular core wherever a calm
// region sits under the specular point, and dark calm lanes off-centre —
// structure at every scale from a continent down to a few tens of kilometres.
//
// So the field here is bimodal and streaked: a zonal climatology (the
// doldrums calm, the trades steady, the subtropical highs light, the
// westerlies and the Southern Ocean strong), domain-warped so nothing runs
// along a parallel; broad structure and fine grain on top; calm LANES a few
// texels wide at a per-latitude share of the sea; calm REGIONS hundreds of
// kilometres across where the sea drops to glassy and the lane mask inverts
// into gusts. The streaked terms are stretched three to one and tilted
// 22 degrees, mirrored across the equator, the way wind streaks lie.
//
// What is stored, and why two maps. A texel is not one wind but a MIXTURE
// of a glassy calm lobe and a windy lobe:
//   the CALM map: the calm weight w in [0, 1], the share of the texel's sea
//      that is glassy, measured against a reference lobe (Cox-Munk at
//      calmReferenceWindMs). Reflectance is linear in w, so a box-filtered mip
//      of this map is exact at every angle — which averaging a wind is not:
//      a 4x4 block of 1.5 m/s and 7 m/s texels averaged to 4.25 m/s renders
//      at two thirds of the brightness the block really has.
//   the WINDY map: the windy speed U_w / SEA_WIND_MAX_MS of the rest of the
//      texel — the open-sea field alone (climatology and broad structure),
//      which has nothing finer than a degree in it and is stored at half the
//      calm map's size, so its mips are near-exact too.
// Two files rather than one two-channel file because the bytes said so: the
// calm weight is 0.4 MB lossless at 2048x1024, and the windy speed beside it
// at the same size cost a megabyte — a smooth field at 8 bits has a residual
// in every texel — while at 1024x512 it is 0.2 MB. Each is a grey picture,
// so each goes through the app's one-channel map path (world/texturePolicy's
// 'mask' kind) with nothing decoded by hand.
// The shader mixes two Beckmann lobes, w * lobe(calm) + (1 - w) * lobe(U_w),
// and a calm lane at half a texel's width is half a texel's calm weight rather
// than a sharp edge or nothing. The conversion from the single-wind design
// (a lane textured between 0.3 and 2 m/s, a region sea at 0.18 of its wind)
// to a weight is a PEAK match: the weight that gives the mixture the same
// brightness at the centre of the glint as the single lobe would, which is
// exact there and a little narrow in the tail.
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
// the structure, the lane and region shares and the streak angle are look
// choices made in an offline simulator against EPIC frames, not measurements.
// A gridded climatology or a real wind day can replace the field through the
// same map format (the DEV `?seawindmap=` override reads one).
//
// Everything here is plain arithmetic on plain arrays, so the same code runs
// under Node for the bake and under vitest for the tests; the types live in
// seaWindField.d.mts because tools/ sits outside the TypeScript project.

/** Cox-Munk's mean-square slope of a clean sea: this at no wind, and this
 *  much more per metre a second. world/seaWind.ts carries the same two
 *  numbers, and its test holds them to these. */
export const COX_MUNK_SLOPE_CALM = 0.003;
export const COX_MUNK_SLOPE_PER_MS = 0.00512;

/** The wind the windy channel's full scale stands for, m/s: past a gale the
 *  sheen has stopped changing. world/seaWind.ts reads the byte back by it. */
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

/** The quantile function of a noise over the seas' latitudes, from a fixed
 *  sample, so a share of the sea can be turned into a threshold. */
function noiseQuantile(sampler, count = 200000) {
  const samples = new Float32Array(count);
  let state = 12345;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  for (let index = 0; index < count; index++) samples[index] = sampler(random() * 360 - 180, random() * 140 - 70);
  samples.sort();
  return (quantile) => samples[clamp(Math.floor(quantile * count), 0, count - 1)];
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
 *  made against EPIC frames in the offline simulator except the climatology,
 *  which is read off scatterometer means, good to about a metre a second. */
export const DEFAULTS = Object.freeze({
  /** Zonal mean wind by latitude, m/s at 10 m, north positive. */
  zonal: [
    [90, 8.0], [70, 9.0], [55, 9.5], [45, 9.0], [35, 6.5], [25, 6.0], [15, 7.0], [8, 5.5], [3, 3.6],
    [0, 3.3],
    [-3, 3.6], [-8, 5.5], [-15, 7.0], [-25, 6.0], [-35, 8.0], [-45, 10.5], [-55, 11.5], [-65, 10.5],
    [-90, 8.0],
  ],
  /** The share of the sea that is calm lane, by zonal wind. */
  laneFractionByWind: [[11, 0], [9, 0.03], [7, 0.09], [5, 0.18], [3, 0.30]],
  /** The share of the sea inside a calm region, by zonal wind. */
  regionFractionByWind: [[9, 0.02], [7, 0.07], [5, 0.15], [3, 0.25]],
  /** One scale on both shares: the calm-frequency knob. */
  calmScale: 1,
  /** The streaked terms: stretch along the streak and the tangent of the
   *  streak's tilt from the parallels, mirrored across the equator. */
  stretch: 3,
  tilt: 0.4,
  /** Broad structure as a fraction of the zonal mean (four octaves from 8
   *  degree cells, clamped at two sigma), and a fine grain on the open sea:
   *  its fraction, its cell and its octaves. Off as shipped — the grain was
   *  a hair of texture at the disc scale and the whole cost of the windy
   *  map, which holds nothing finer than a degree without it; a candidate
   *  with one is `--set=grain:0.1,grainCell:1.2,grainOctaves:1`. */
  broadSpread: 0.45,
  grain: 0,
  grainCell: 1.2,
  grainOctaves: 1,
  /** The lanes: their cells and octaves, and the width of their edge in noise
   *  units; the regions the same. */
  laneCell: 1.5,
  laneOctaves: 4,
  laneEdge: 0.04,
  regionCell: 6,
  regionEdge: 0.025,
  /** Inside a region the sea drops to this fraction of its wind, floored by
   *  the slick texture at 0.3 to 1.2 m/s. */
  regionWindScale: 0.18,
  /** The glassy lobe the calm weight is measured against: Cox-Munk at this
   *  wind. A weight of one is a sea this calm; a lane textured between 0.3
   *  and 2 m/s becomes a weight between one and about a half. */
  calmReferenceWindMs: 0.6,
  /** The n x n box of points a texel averages, so a lane narrower than a
   *  texel is a fraction of its calm weight rather than an edge. */
  supersample: 2,
  /** The windy map is this many times smaller than the calm map on each
   *  side, each of its texels the windy-weighted mean of the block. */
  windyDownsample: 2,
});

/** The per-latitude terms, computed once per row. */
function latitudeTerms(params, quantiles, latDeg) {
  const zonal = interpolateTable(params.zonal, latDeg);
  const laneFraction = clamp(interpolateTable(params.laneFractionByWind, zonal) * params.calmScale, 0, 0.6);
  const regionFraction = clamp(interpolateTable(params.regionFractionByWind, zonal) * params.calmScale, 0, 0.6);
  return {
    zonal,
    laneFraction,
    laneLevel: laneFraction > 0 ? quantiles.lane(1 - laneFraction) : Infinity,
    regionFraction,
    regionLevel: regionFraction > 0 ? quantiles.region(1 - regionFraction) : Infinity,
    // The streaks tilt one way north of the equator and the other south of
    // it, blended over eight degrees so the seam is not a crease.
    northWeight: smoothstep(-4, 4, latDeg),
  };
}

/** Every noise term at a point, for one sign of the tilt. */
function noiseTerms(params, lonDeg, latDeg, tilt) {
  // A warp of about five degrees at thirty-degree cells on everything, and a
  // finer one of about a degree on the lanes and the slick texture, so no
  // structure runs along a parallel.
  const warpLon = 5 * streakedNoise(lonDeg, latDeg, 30, 1, 0, 3, 7);
  const warpLat = 5 * streakedNoise(lonDeg, latDeg, 30, 1, 0, 3, 8);
  const lonWarped = lonDeg + warpLon;
  const latWarped = latDeg + warpLat;
  const laneWarpLon = 1.2 * streakedNoise(lonDeg, latDeg, 5, 1, 0, 2, 9);
  const laneWarpLat = 1.2 * streakedNoise(lonDeg, latDeg, 5, 1, 0, 2, 10);
  const lonLane = lonWarped + laneWarpLon;
  const latLane = latWarped + laneWarpLat;
  return {
    broad: streakedNoise(lonWarped, latWarped, 8, params.stretch, tilt, 4, 1) / 0.3,
    lane: streakedNoise(lonLane, latLane, params.laneCell, params.stretch, tilt, params.laneOctaves, 2),
    region: streakedNoise(lonWarped, latWarped, params.regionCell, params.stretch, tilt, 3, 4),
    slick: streakedNoise(lonLane, latLane, 0.5, params.stretch, tilt, 2, 3),
    grain: params.grain > 0
      ? streakedNoise(lonLane, latLane, params.grainCell, params.stretch, tilt, params.grainOctaves, 5) / 0.3
      : 0,
  };
}

/**
 * The weight of a glassy reference lobe that gives a mixture of it with a
 * windy lobe the same brightness at the centre of the glint as one lobe at
 * `windMs` would: the peak of a Gaussian lobe goes as 1 / mss, so this is a
 * ratio of reciprocals. One for a sea calmer than the reference, zero for one
 * as windy as the windy lobe.
 */
export function calmWeightForWind(windMs, windyMs, referenceWindMs) {
  const peak = 1 / meanSquareSlope(windMs);
  const peakWindy = 1 / meanSquareSlope(windyMs);
  const peakReference = 1 / meanSquareSlope(referenceWindMs);
  if (peakReference <= peakWindy) return 0;
  return clamp((peak - peakWindy) / (peakReference - peakWindy), 0, 1);
}

/** One point of the field. `windMs` is the single-wind design the mixture
 *  stands in for; `calmWeight` and `windyMs` are what the map stores. */
function fieldAtPoint(params, latTerms, lonDeg, latDeg) {
  const { northWeight } = latTerms;
  let terms;
  if (northWeight >= 1) terms = noiseTerms(params, lonDeg, latDeg, params.tilt);
  else if (northWeight <= 0) terms = noiseTerms(params, lonDeg, latDeg, -params.tilt);
  else {
    const north = noiseTerms(params, lonDeg, latDeg, params.tilt);
    const south = noiseTerms(params, lonDeg, latDeg, -params.tilt);
    terms = {};
    for (const key of Object.keys(north)) terms[key] = north[key] * northWeight + south[key] * (1 - northWeight);
  }
  // The open sea: the climatology with its broad structure and grain.
  const blown = clamp(
    latTerms.zonal
      * (1 + params.broadSpread * clamp(terms.broad, -2, 2))
      * (1 + params.grain * clamp(terms.grain, -2, 2)),
    0.1, SEA_WIND_MAX_MS,
  );
  // The lanes and the regions: masks with soft edges, and a slick texture
  // that grades the calm inside them.
  const laneWeight = latTerms.laneFraction > 0
    ? smoothstep(latTerms.laneLevel - params.laneEdge, latTerms.laneLevel + params.laneEdge, terms.lane)
    : 0;
  const regionWeight = latTerms.regionFraction > 0
    ? smoothstep(latTerms.regionLevel - params.regionEdge, latTerms.regionLevel + params.regionEdge, terms.region)
    : 0;
  const slickUnit = clamp(0.5 + terms.slick, 0, 1);
  const laneWindMs = 0.3 + 1.7 * slickUnit;
  const regionSeaMs = Math.max(blown * params.regionWindScale, 0.3 + 0.9 * slickUnit);
  // Outside a region a lane is calm in a windy sea; inside one the sea is
  // calm and the lane mask inverts into gusts of the open wind.
  const openWindMs = blown * (1 - laneWeight) + laneWindMs * laneWeight;
  const regionWindMs = regionSeaMs * (1 - laneWeight) + blown * laneWeight;
  const windMs = clamp(openWindMs * (1 - regionWeight) + regionWindMs * regionWeight, 0.1, SEA_WIND_MAX_MS);
  const laneCalm = calmWeightForWind(laneWindMs, blown, params.calmReferenceWindMs);
  const regionCalm = calmWeightForWind(regionSeaMs, blown, params.calmReferenceWindMs);
  const calmWeight = clamp(
    (1 - regionWeight) * laneWeight * laneCalm + regionWeight * (1 - laneWeight) * regionCalm,
    0, 1,
  );
  return { windMs, calmWeight, windyMs: blown };
}

function makeQuantiles(params) {
  return {
    lane: noiseQuantile((lon, lat) =>
      streakedNoise(lon, lat, params.laneCell, params.stretch, params.tilt, params.laneOctaves, 2)),
    region: noiseQuantile((lon, lat) =>
      streakedNoise(lon, lat, params.regionCell, params.stretch, params.tilt, 3, 4)),
  };
}

/**
 * A point evaluator sharing the builder's arithmetic exactly, for the
 * periodicity and the mip tests: (longitude, latitude) in degrees to the
 * point's single-wind design, calm weight and windy speed.
 */
export function pointEvaluator(params = {}) {
  const merged = { ...DEFAULTS, ...params };
  const quantiles = makeQuantiles(merged);
  return (lonDeg, latDeg) => fieldAtPoint(merged, latitudeTerms(merged, quantiles, latDeg), lonDeg, latDeg);
}

/**
 * The field at `width` x `height`, row 0 the south pole (the layout three
 * samples a picture in with v = 0 at its bottom, and the shader reads): per
 * texel the calm weight and the single-wind design's mean for the statistics,
 * and at `windyDownsample` times fewer texels a side the windy speed — the
 * windy-weighted mean over the block, so a block that is half lane carries the
 * open sea's wind beside it and not the lane's. An n x n box of points per
 * calm texel.
 */
export function buildField(width, height, params = {}) {
  const merged = { ...DEFAULTS, ...params };
  const quantiles = makeQuantiles(merged);
  const calmWeight = new Float32Array(width * height);
  const windMs = new Float32Array(width * height);
  const windyWeightedSum = new Float32Array(width * height);
  const windyWeightSum = new Float32Array(width * height);
  const windyPlainSum = new Float32Array(width * height);
  const n = merged.supersample;
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      let calmSum = 0;
      let windSum = 0;
      const index = row * width + column;
      for (let subRow = 0; subRow < n; subRow++) {
        const latDeg = ((row + (subRow + 0.5) / n) / height) * 180 - 90;
        const latTerms = latitudeTerms(merged, quantiles, latDeg);
        for (let subColumn = 0; subColumn < n; subColumn++) {
          const lonDeg = ((column + (subColumn + 0.5) / n) / width) * 360 - 180;
          const point = fieldAtPoint(merged, latTerms, lonDeg, latDeg);
          calmSum += point.calmWeight;
          windSum += point.windMs;
          windyWeightedSum[index] += (1 - point.calmWeight) * point.windyMs;
          windyWeightSum[index] += 1 - point.calmWeight;
          windyPlainSum[index] += point.windyMs;
        }
      }
      calmWeight[index] = calmSum / (n * n);
      windMs[index] = windSum / (n * n);
    }
  }
  const down = merged.windyDownsample;
  if (!Number.isInteger(down) || down < 1 || width % down !== 0 || height % down !== 0) {
    throw new Error(`sea wind field: ${width}x${height} does not divide by a windy downsample of ${down}`);
  }
  const windyWidth = width / down;
  const windyHeight = height / down;
  const windyMs = new Float32Array(windyWidth * windyHeight);
  for (let row = 0; row < windyHeight; row++) {
    for (let column = 0; column < windyWidth; column++) {
      let weighted = 0;
      let weight = 0;
      let plain = 0;
      for (let subRow = 0; subRow < down; subRow++) {
        for (let subColumn = 0; subColumn < down; subColumn++) {
          const index = (row * down + subRow) * width + column * down + subColumn;
          weighted += windyWeightedSum[index];
          weight += windyWeightSum[index];
          plain += windyPlainSum[index];
        }
      }
      windyMs[row * windyWidth + column] = weight > 1e-6 ? weighted / weight : plain / (down * down * n * n);
    }
  }
  return { width, height, calmWeight, windMs, windyWidth, windyHeight, windyMs };
}

/** A map as grey picture bytes, three a texel and NORTH-UP — a picture's first
 *  row is its top — for a PNG the app reads as a one-channel mask. */
function encodeGrey(values, width, height, scale) {
  const rgb = new Uint8Array(width * height * 3);
  for (let row = 0; row < height; row++) {
    const pictureRow = height - 1 - row;
    for (let column = 0; column < width; column++) {
      const byte = Math.round(clamp(values[row * width + column] * scale, 0, 1) * 255);
      const to = (pictureRow * width + column) * 3;
      rgb[to] = byte;
      rgb[to + 1] = byte;
      rgb[to + 2] = byte;
    }
  }
  return rgb;
}

/** The calm map as a grey picture: the weight over [0, 1]. */
export function encodeCalmGrey(field) {
  return encodeGrey(field.calmWeight, field.width, field.height, 1);
}

/** The windy map as a grey picture: the speed over SEA_WIND_MAX_MS. */
export function encodeWindyGrey(field) {
  return encodeGrey(field.windyMs, field.windyWidth, field.windyHeight, 1 / SEA_WIND_MAX_MS);
}

/**
 * Both maps in one picture at the calm map's size, north-up: red the calm
 * weight, green the windy speed (bilinear between its own texels) over
 * SEA_WIND_MAX_MS, blue nothing. The form the DEV `?seawindmap=` override
 * and the offline simulator read a candidate in.
 */
export function encodeSeaWindRgb(field) {
  const { width, height, calmWeight, windyWidth, windyHeight, windyMs } = field;
  const rgb = new Uint8Array(width * height * 3);
  const sampleWindy = (u, v) => {
    const x = u * windyWidth - 0.5;
    const y = clamp(v * windyHeight - 0.5, 0, windyHeight - 1);
    const column = Math.floor(x);
    const row = Math.floor(y);
    const fractionX = x - column;
    const fractionY = y - row;
    const wrap = (index) => ((index % windyWidth) + windyWidth) % windyWidth;
    const rowNext = Math.min(row + 1, windyHeight - 1);
    const lower = windyMs[row * windyWidth + wrap(column)] * (1 - fractionX) + windyMs[row * windyWidth + wrap(column + 1)] * fractionX;
    const upper = windyMs[rowNext * windyWidth + wrap(column)] * (1 - fractionX) + windyMs[rowNext * windyWidth + wrap(column + 1)] * fractionX;
    return lower + (upper - lower) * fractionY;
  };
  for (let row = 0; row < height; row++) {
    const pictureRow = height - 1 - row;
    for (let column = 0; column < width; column++) {
      const from = row * width + column;
      const to = (pictureRow * width + column) * 3;
      rgb[to] = Math.round(clamp(calmWeight[from], 0, 1) * 255);
      rgb[to + 1] = Math.round(clamp(sampleWindy((column + 0.5) / width, (row + 0.5) / height) / SEA_WIND_MAX_MS, 0, 1) * 255);
      rgb[to + 2] = 0;
    }
  }
  return rgb;
}

/**
 * Area-weighted statistics of the single-wind design by band of |latitude|,
 * for the bake's log and the tests: the mean wind, the share under one and
 * under two metres a second, and the mean calm weight. Land included — no
 * ocean mask is read here — so the calm shares are upper bounds on the sea's.
 */
export function bandStatistics(field, latLowDeg, latHighDeg) {
  const { width, height, calmWeight, windMs } = field;
  let weight = 0;
  let windSum = 0;
  let calmSum = 0;
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
      calmSum += rowWeight * calmWeight[index];
      if (windMs[index] < 1) under1 += rowWeight;
      if (windMs[index] < 2) under2 += rowWeight;
    }
  }
  return {
    meanWindMs: windSum / weight,
    meanCalmWeight: calmSum / weight,
    under1Fraction: under1 / weight,
    under2Fraction: under2 / weight,
  };
}
