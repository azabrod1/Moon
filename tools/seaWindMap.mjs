// The sea's wind map as the app reads it, and the arithmetic every arm of
// tools/gen-seawind.mjs bakes and measures it with. Plain arithmetic on plain
// arrays, so the bake runs it under Node and seaWind.test.ts under vitest;
// the types live in seaWindMap.d.mts because tools/ sits outside the
// TypeScript project.
//
// The map, 1024x512, row 0 the south pole (written to disk north-up, as a
// picture is), four bytes a texel:
//   R  the wind's annual mean scalar speed over SEA_WIND_MAX_MS;
//   G, B  the wind's AXIS x = (x1, x2) in the unit disc, in doubled angle,
//         stored 128 + round(127 x) and read back (byte - 128) / 127, so 128
//         is exactly no axis and the decode is affine (a mip of the bytes is
//         the mip of x);
//   A  opaque, 255, never data: a picture decoded through a 2D canvas is
//      premultiplied by its alpha, and lossless webp rewrites the colour of a
//      transparent texel unless told not to.
//
// The axis. Cox and Munk's slopes are wider along the wind than across it:
// sigma_u² = 0.00316 U upwind and sigma_c² = 0.003 + 0.00192 U crosswind, each
// the variance along ONE axis, so the signed anisotropy d(U) = sigma_u² -
// sigma_c² = 0.00124 U - 0.003 is negative below 2.42 m/s, where the crosswind
// slope is the wider. A wind toward the angle theta (east +u, north +v) has
// the axis (cos 2 theta, sin 2 theta): doubled, because the axis has no sign
// (a wind from the north-east and one from the south-west roughen the sea
// the same way), and doubling makes opposite winds add instead of cancel. The
// anisotropic part of the slope covariance is then d(R) x, and x is what a
// texel stores: the months' k_m d(w_m) (cos 2 theta_m, sin 2 theta_m) averaged
// (k_m the steadiness |mean vector| / mean speed), divided by d at the speed
// the map stores, clamped to the unit disc.
//
// Longitude: the map's column 0 starts at -180 degrees, as everywhere in the
// code (u = (lon + 180) / 360), and every operation here is periodic in it.
import { SEA_WIND_MAX_MS, meanSquareSlope } from './seaWindField.mjs';

/** Cox and Munk's slope variances along the wind and across it, each along
 *  one axis: sigma_u² = UPWIND_PER_MS U, sigma_c² = CROSSWIND_CALM +
 *  CROSSWIND_PER_MS U. */
export const COX_MUNK_UPWIND_PER_MS = 0.00316;
export const COX_MUNK_CROSSWIND_CALM = 0.003;
export const COX_MUNK_CROSSWIND_PER_MS = 0.00192;

/** The signed anisotropy of the slopes at a wind, sigma_u² - sigma_c²:
 *  0.00124 U - 0.003, negative below 2.42 m/s. */
export function slopeAnisotropy(windMs) {
  return COX_MUNK_UPWIND_PER_MS * windMs - (COX_MUNK_CROSSWIND_CALM + COX_MUNK_CROSSWIND_PER_MS * windMs);
}

/** The axis bytes: 128 + round(127 x), decoded (byte - 128) / 127. */
export const AXIS_ZERO = 128;
export const AXIS_SCALE = 127;
/** Where |d(R)| is under this the axis is stored as none: a wind near
 *  2.42 m/s has no anisotropy to carry, and dividing by it would only
 *  amplify the accumulator's noise. */
export const AXIS_DIVISOR_FLOOR = 1e-4;

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

/** The wind's byte: the speed over SEA_WIND_MAX_MS, clamped, rounded. */
export const windToByte = (windMs) => Math.round(clamp(windMs / SEA_WIND_MAX_MS, 0, 1) * 255);
export const byteToWind = (byte) => (byte / 255) * SEA_WIND_MAX_MS;
export const axisToByte = (x) => AXIS_ZERO + Math.round(AXIS_SCALE * clamp(x, -1, 1));
export const byteToAxis = (byte) => (byte - AXIS_ZERO) / AXIS_SCALE;

/** The axis a texel stores from its accumulator and the speed it stores:
 *  a / d(R), clamped to the unit disc, none where d(R) is near zero. */
export function axisFromAccumulator(a1, a2, windMs) {
  const d = slopeAnisotropy(windMs);
  if (Math.abs(d) < AXIS_DIVISOR_FLOOR) return [0, 0];
  let x1 = a1 / d;
  let x2 = a2 / d;
  const length = Math.hypot(x1, x2);
  if (length > 1) {
    x1 /= length;
    x2 /= length;
  }
  return [x1, x2];
}

/**
 * The map's RGBA bytes, NORTH-UP (a picture's first row is its top), from
 * fields laid out row 0 south: every arm writes through this one encoder.
 * `axisX`/`axisY` absent is a map with no axis, G = B = 128.
 */
export function encodeWindMap({ width, height, windMs, axisX = null, axisY = null }) {
  const rgba = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    const pictureRow = height - 1 - row;
    for (let column = 0; column < width; column++) {
      const from = row * width + column;
      const to = (pictureRow * width + column) * 4;
      rgba[to] = windToByte(windMs[from]);
      rgba[to + 1] = axisX ? axisToByte(axisX[from]) : AXIS_ZERO;
      rgba[to + 2] = axisY ? axisToByte(axisY[from]) : AXIS_ZERO;
      rgba[to + 3] = 255;
    }
  }
  return rgba;
}

/** A decoded picture of the map (north-up, `channels` a texel) back into
 *  fields, row 0 south: the speed, the axis, and the bytes themselves. */
export function decodeWindMap(pixels, width, height, channels = 4) {
  const count = width * height;
  const red = new Uint8Array(count);
  const green = new Uint8Array(count);
  const blue = new Uint8Array(count);
  const windMs = new Float64Array(count);
  const axisX = new Float64Array(count);
  const axisY = new Float64Array(count);
  for (let pictureRow = 0; pictureRow < height; pictureRow++) {
    const row = height - 1 - pictureRow;
    for (let column = 0; column < width; column++) {
      const from = (pictureRow * width + column) * channels;
      const to = row * width + column;
      red[to] = pixels[from];
      green[to] = pixels[from + 1];
      blue[to] = pixels[from + 2];
      windMs[to] = byteToWind(red[to]);
      axisX[to] = byteToAxis(green[to]);
      axisY[to] = byteToAxis(blue[to]);
    }
  }
  return { width, height, red, green, blue, windMs, axisX, axisY };
}

/** RGBA to RGB, for the `--png` the DEV override reads. */
export function rgbFromRgba(rgba) {
  const rgb = new Uint8Array((rgba.length / 4) * 3);
  for (let from = 0, to = 0; from < rgba.length; from += 4, to += 3) {
    rgb[to] = rgba[from];
    rgb[to + 1] = rgba[from + 1];
    rgb[to + 2] = rgba[from + 2];
  }
  return rgb;
}

const smoothstep = (edgeFrom, edgeTo, x) => {
  const t = clamp((x - edgeFrom) / (edgeTo - edgeFrom), 0, 1);
  return t * t * (3 - 2 * t);
};

/** The synthetic arm's steadiness: about the data's median k (0.51-0.53). */
export const SYNTHETIC_STEADINESS = 0.55;

/**
 * The synthetic arm's axis, a zonal rule: easterlies between 30 S and 30 N,
 * westerlies poleward of 35, the wind's east component blended between
 * (a smoothstep in |latitude|), with the steadiness SYNTHETIC_STEADINESS. An
 * easterly and a westerly have the same axis, east-west, (1, 0) in doubled
 * angle, so the rule is that axis at the steadiness times the length of the
 * blended mean vector: full in both belts, none at 32.5 degrees, where the
 * mean easterly and westerly cancel under the subtropical high.
 */
export function syntheticAxis(latDeg) {
  const east = -1 + 2 * smoothstep(30, 35, Math.abs(latDeg));
  return [SYNTHETIC_STEADINESS * Math.abs(east), 0];
}

// ---------------------------------------------------------------------------
// The data arm: the months into one accumulator per cell.

/** The product's mask classes a cell's month is read for: ocean, lake,
 *  river. Land (0) never is; "model" (6) is not in the file read. */
export const WATER_CLASSES = Object.freeze([1, 2, 3]);

/** k is histogrammed in bins of 1 / K_BINS over [0, 1], and w in bins of
 *  1 / W_BINS_PER_MS m/s up to W_HISTOGRAM_MAX_MS, for their quantiles. */
const K_BINS = 10000;
const W_BINS_PER_MS = 100;
const W_HISTOGRAM_MAX_MS = 40;

export function createAccumulator(cellCount) {
  return {
    cellCount,
    months: new Uint8Array(cellCount),
    windSum: new Float64Array(cellCount),
    a1Sum: new Float64Array(cellCount),
    a2Sum: new Float64Array(cellCount),
  };
}

/**
 * One month into the accumulator. `u`, `v`, `w` and `mask` are the month's
 * cells (the file's raw values; the scale and offset are applied here);
 * a cell counts when its mask is a water class and all three are finite.
 * Returns the month's own numbers: non-finite cells per mask class, k's
 * histogram over the valid cells and how many came out over one (clamped),
 * w's histogram, and per watched cell its w, k and wind angle.
 */
export function accumulateMonth(acc, { u, v, w, mask, uScale = 1, uOffset = 0, vScale = 1, vOffset = 0, wScale = 1, wOffset = 0 }, watch = []) {
  const kHistogram = new Float64Array(K_BINS + 1);
  const windHistogram = new Float64Array(W_HISTOGRAM_MAX_MS * W_BINS_PER_MS + 1);
  const nonFinite = {};
  let kOverOne = 0;
  let valid = 0;
  let windMax = 0;
  for (let cell = 0; cell < acc.cellCount; cell++) {
    const cls = mask[cell];
    const east = u[cell] * uScale + uOffset;
    const north = v[cell] * vScale + vOffset;
    const speed = w[cell] * wScale + wOffset;
    const finite = Number.isFinite(east) && Number.isFinite(north) && Number.isFinite(speed);
    if (!finite) nonFinite[cls] = (nonFinite[cls] ?? 0) + 1;
    if (!finite || !WATER_CLASSES.includes(cls)) continue;
    valid++;
    windMax = Math.max(windMax, speed);
    windHistogram[Math.round(clamp(speed, 0, W_HISTOGRAM_MAX_MS) * W_BINS_PER_MS)]++;
    const vectorLength = Math.hypot(east, north);
    let k = speed > 0 ? vectorLength / speed : 0;
    if (k > 1) {
      kOverOne++;
      k = 1;
    }
    kHistogram[Math.round(k * K_BINS)]++;
    // (cos 2 theta, sin 2 theta) without the angle: ((u² - v²), 2uv) / |uv|².
    if (vectorLength > 0) {
      const d = slopeAnisotropy(speed);
      const lengthSquared = vectorLength * vectorLength;
      acc.a1Sum[cell] += (k * d * (east * east - north * north)) / lengthSquared;
      acc.a2Sum[cell] += (k * d * (2 * east * north)) / lengthSquared;
    }
    acc.windSum[cell] += speed;
    acc.months[cell]++;
  }
  const watched = watch.map((cell) => {
    const east = u[cell] * uScale + uOffset;
    const north = v[cell] * vScale + vOffset;
    const speed = w[cell] * wScale + wOffset;
    return {
      cell,
      windMs: speed,
      k: speed > 0 ? Math.min(Math.hypot(east, north) / speed, 1) : 0,
      towardDeg: (Math.atan2(north, east) * 180) / Math.PI,
    };
  });
  return { kHistogram, windHistogram, kOverOne, nonFinite, valid, windMax, watched };
}

/** The accumulator's means over each cell's valid months: R (the mean
 *  scalar speed), a, and whether the cell is filled (at least `minMonths`). */
export function finishAccumulator(acc, minMonths) {
  const { cellCount } = acc;
  const windMs = new Float64Array(cellCount);
  const a1 = new Float64Array(cellCount);
  const a2 = new Float64Array(cellCount);
  const filled = new Uint8Array(cellCount);
  for (let cell = 0; cell < cellCount; cell++) {
    const months = acc.months[cell];
    if (months < minMonths) continue;
    filled[cell] = 1;
    windMs[cell] = acc.windSum[cell] / months;
    a1[cell] = acc.a1Sum[cell] / months;
    a2[cell] = acc.a2Sum[cell] / months;
  }
  return { windMs, a1, a2, filled };
}

/** Quantiles of a histogram from accumulateMonth: k's (bins of 1 / K_BINS)
 *  or, with `binsPerUnit` W_BINS_PER_MS, w's in m/s. */
export function histogramQuantiles(histogram, quantiles, binsPerUnit = K_BINS) {
  let total = 0;
  for (const count of histogram) total += count;
  return quantiles.map((q) => {
    const target = q * total;
    let running = 0;
    for (let bin = 0; bin < histogram.length; bin++) {
      running += histogram[bin];
      if (running >= target) return bin / binsPerUnit;
    }
    return (histogram.length - 1) / binsPerUnit;
  });
}
export { W_BINS_PER_MS };

// ---------------------------------------------------------------------------
// The grid: the roll, the fill, the smoothing, the area average.

/** Each row's columns moved `shift` to the right, wrapping: column c lands
 *  on (c + shift) mod width. A source whose column 0 is at 0 degrees,
 *  rolled by half its width, starts at -180 degrees. */
export function rollColumns(values, width, height, shift) {
  const out = new values.constructor(values.length);
  for (let row = 0; row < height; row++) {
    const base = row * width;
    for (let column = 0; column < width; column++) out[base + ((column + shift) % width + width) % width] = values[base + column];
  }
  return out;
}

/**
 * For every cell, the index of the nearest filled cell in the grid's own
 * metric (one cell a step in both axes; the source's cells are a quarter
 * degree each way), longitude periodic, latitude not: an exact Euclidean
 * distance transform (Felzenszwalb and Huttenlocher's lower envelope of
 * parabolas), a column pass then a row pass over the row laid out three
 * times so the envelope wraps. A filled cell is its own nearest.
 */
export function nearestFilledIndex(filled, width, height) {
  // Column pass: per cell, the nearest filled row in its own column.
  const nearestRow = new Int32Array(width * height).fill(-1);
  for (let column = 0; column < width; column++) {
    let last = -1;
    for (let row = 0; row < height; row++) {
      if (filled[row * width + column]) last = row;
      nearestRow[row * width + column] = last;
    }
    last = -1;
    for (let row = height - 1; row >= 0; row--) {
      const cell = row * width + column;
      if (filled[cell]) last = row;
      if (last >= 0 && (nearestRow[cell] < 0 || last - row < row - nearestRow[cell])) nearestRow[cell] = last;
    }
  }
  // Row pass over three copies of the row: sites at x - width, x, x + width.
  const span = 3 * width;
  const sites = new Int32Array(span);
  const bounds = new Float64Array(span + 1);
  const out = new Int32Array(width * height);
  const cost = new Float64Array(span);
  let anyFilled = false;
  for (let row = 0; row < height; row++) {
    let count = 0;
    for (let x = 0; x < span; x++) {
      const column = x % width;
      const nearest = nearestRow[row * width + column];
      if (nearest < 0) {
        cost[x] = Infinity;
        continue;
      }
      cost[x] = (nearest - row) * (nearest - row);
      // The envelope: drop sites the new parabola hides.
      let boundary = 0;
      while (count > 0) {
        const previous = sites[count - 1];
        boundary = ((cost[x] + x * x) - (cost[previous] + previous * previous)) / (2 * (x - previous));
        if (boundary <= bounds[count - 1]) count--;
        else break;
      }
      sites[count] = x;
      bounds[count] = count === 0 ? -Infinity : boundary;
      count++;
    }
    if (count === 0) continue;
    anyFilled = true;
    let segment = 0;
    for (let x = width; x < 2 * width; x++) {
      while (segment + 1 < count && bounds[segment + 1] <= x) segment++;
      const site = sites[segment];
      const column = site % width;
      out[row * width + (x - width)] = nearestRow[row * width + column] * width + column;
    }
  }
  if (!anyFilled) throw new Error('sea wind map: no filled cell to fill from');
  return out;
}

/** Every unfilled cell of each array takes its nearest filled cell's value. */
export function fillFromNearest(arrays, filled, nearest) {
  for (let cell = 0; cell < filled.length; cell++) {
    if (filled[cell]) continue;
    const from = nearest[cell];
    for (const values of arrays) values[cell] = values[from];
  }
}

/**
 * The area average of a field on a source grid onto the map's grid, both
 * periodic in longitude from -180 degrees: each map texel is the mean of the
 * source cells it overlaps, weighted by cos(the cell's latitude) times the
 * overlap in latitude times the overlap in longitude. The source's columns
 * are `srcWidth` across from `srcWestEdgeDeg` (a cell may straddle the date
 * line: its overlap is split across the seam); its rows are centred on
 * `srcLatCentreDeg(row)`, `srcRowHeightDeg` tall. Returns a function from a
 * source field to the map's field, row 0 south.
 */
export function areaAverager({ srcWidth, srcHeight, srcWestEdgeDeg, srcLatCentreDeg, srcRowHeightDeg, dstWidth, dstHeight }) {
  const srcColumnDeg = 360 / srcWidth;
  const dstColumnDeg = 360 / dstWidth;
  const dstRowDeg = 180 / dstHeight;
  // Longitude: per map column, its source columns and their overlaps.
  const lonTaps = Array.from({ length: dstWidth }, () => []);
  for (let column = 0; column < srcWidth; column++) {
    let west = srcWestEdgeDeg + column * srcColumnDeg;
    west = ((west + 180) % 360 + 360) % 360 - 180;
    const pieces = west + srcColumnDeg > 180
      ? [[west, 180], [-180, west + srcColumnDeg - 360]]
      : [[west, west + srcColumnDeg]];
    for (const [from, to] of pieces) {
      const first = Math.max(0, Math.floor((from + 180) / dstColumnDeg));
      const last = Math.min(dstWidth - 1, Math.ceil((to + 180) / dstColumnDeg) - 1);
      for (let target = first; target <= last; target++) {
        const overlap = Math.min(to, -180 + (target + 1) * dstColumnDeg) - Math.max(from, -180 + target * dstColumnDeg);
        if (overlap > 1e-12) lonTaps[target].push([column, overlap]);
      }
    }
  }
  // Latitude: per map row, its source rows and their weights.
  const latTaps = Array.from({ length: dstHeight }, () => []);
  for (let row = 0; row < srcHeight; row++) {
    const centre = srcLatCentreDeg(row);
    const from = centre - srcRowHeightDeg / 2;
    const to = centre + srcRowHeightDeg / 2;
    const weight = Math.cos((centre * Math.PI) / 180);
    const first = Math.max(0, Math.floor((from + 90) / dstRowDeg));
    const last = Math.min(dstHeight - 1, Math.ceil((to + 90) / dstRowDeg) - 1);
    for (let target = first; target <= last; target++) {
      const overlap = Math.min(to, -90 + (target + 1) * dstRowDeg) - Math.max(from, -90 + target * dstRowDeg);
      if (overlap > 1e-12) latTaps[target].push([row, overlap * weight]);
    }
  }
  return (values) => {
    const across = new Float64Array(srcHeight * dstWidth);
    for (let row = 0; row < srcHeight; row++) {
      const base = row * srcWidth;
      for (let target = 0; target < dstWidth; target++) {
        let sum = 0;
        let weight = 0;
        for (const [column, overlap] of lonTaps[target]) {
          sum += overlap * values[base + column];
          weight += overlap;
        }
        across[row * dstWidth + target] = sum / weight;
      }
    }
    const out = new Float64Array(dstWidth * dstHeight);
    for (let target = 0; target < dstHeight; target++) {
      const taps = latTaps[target];
      let weight = 0;
      for (const [, tapWeight] of taps) weight += tapWeight;
      for (let column = 0; column < dstWidth; column++) {
        let sum = 0;
        for (const [row, tapWeight] of taps) sum += tapWeight * across[row * dstWidth + column];
        out[target * dstWidth + column] = sum / weight;
      }
    }
    return out;
  };
}

// ---------------------------------------------------------------------------
// What the bake measures on the map it wrote.

/** The glint's brightness at a facet tilt for a mean-square slope: the
 *  Beckmann lobe's shape, exp(-tan² / mss) / mss. */
export function lobe(mss, tiltDeg) {
  const tan = Math.tan((tiltDeg * Math.PI) / 180);
  return Math.exp((-tan * tan) / mss) / mss;
}

/** The q-quantile of values under weights. */
export function weightedQuantile(values, weights, q) {
  const order = Array.from(values.keys()).sort((left, right) => values[left] - values[right]);
  let total = 0;
  for (const weight of weights) total += weight;
  let running = 0;
  for (const index of order) {
    running += weights[index];
    if (running >= q * total) return values[index];
  }
  return values[order[order.length - 1]];
}

/** The bars the mip-bias statistics are held to, at every level and tilt. */
export const MIP_BIAS_BARS = Object.freeze({ mean: 0.03, p99: 0.1 });
export const MIP_BIAS_LEVELS = Object.freeze([1, 2, 3, 4]);
export const MIP_BIAS_TILTS_DEG = Object.freeze([0, 5, 10]);

const latitudeOfRow = (row, height) => ((row + 0.5) / height) * 180 - 90;
const longitudeOfColumn = (column, width) => ((column + 0.5) / width) * 360 - 180;

/**
 * How far a mip of the map is from the mean of what its texels draw, at mip
 * levels 1-4 (blocks of 2, 4, 8, 16 texels a side, as the GPU's box chain
 * aligns them). Population: blocks centred between 60 S and 60 N whose
 * texels are at least half sea (`sea`, the product's ocean mask averaged the
 * same way), each weighted by cos(latitude); all of a block's texels are
 * averaged, as the mip averages them.
 *   speed: per tilt, |lobe(mss(mean R)) / mean(lobe(mss(R))) - 1|;
 *   anisotropy: per component, |d(mean R) mean(x) - mean(d(R) x)| / mean(mss(R)),
 *     the error of the product of two stored channels the shader will build.
 * Each row: the weighted mean, the weighted 99th percentile, the maximum and
 * where it is, and whether the mean and p99 are under MIP_BIAS_BARS.
 */
export function mipBias({ width, height, windMs, axisX, axisY, sea }, { latLimitDeg = 60, minSea = 0.5 } = {}) {
  const levels = [];
  for (const level of MIP_BIAS_LEVELS) {
    const size = 2 ** level;
    const weights = [];
    const places = [];
    const speedErrors = MIP_BIAS_TILTS_DEG.map(() => []);
    const axisErrors = [[], []];
    for (let blockRow = 0; blockRow < height / size; blockRow++) {
      const centreLat = -90 + ((blockRow + 0.5) * size * 180) / height;
      if (Math.abs(centreLat) > latLimitDeg) continue;
      for (let blockColumn = 0; blockColumn < width / size; blockColumn++) {
        let seaSum = 0;
        let windSum = 0;
        let mssSum = 0;
        let x1Sum = 0;
        let x2Sum = 0;
        let dx1Sum = 0;
        let dx2Sum = 0;
        const lobeSums = MIP_BIAS_TILTS_DEG.map(() => 0);
        for (let row = blockRow * size; row < (blockRow + 1) * size; row++) {
          for (let column = blockColumn * size; column < (blockColumn + 1) * size; column++) {
            const texel = row * width + column;
            const wind = windMs[texel];
            const mss = meanSquareSlope(wind);
            const d = slopeAnisotropy(wind);
            seaSum += sea[texel];
            windSum += wind;
            mssSum += mss;
            x1Sum += axisX[texel];
            x2Sum += axisY[texel];
            dx1Sum += d * axisX[texel];
            dx2Sum += d * axisY[texel];
            MIP_BIAS_TILTS_DEG.forEach((tilt, index) => { lobeSums[index] += lobe(mss, tilt); });
          }
        }
        const n = size * size;
        if (seaSum / n < minSea) continue;
        const windMean = windSum / n;
        const mssMean = mssSum / n;
        weights.push(Math.cos((centreLat * Math.PI) / 180));
        places.push([centreLat, -180 + ((blockColumn + 0.5) * size * 360) / width]);
        MIP_BIAS_TILTS_DEG.forEach((tilt, index) => {
          speedErrors[index].push(Math.abs(lobe(meanSquareSlope(windMean), tilt) / (lobeSums[index] / n) - 1));
        });
        const dMean = slopeAnisotropy(windMean);
        axisErrors[0].push(Math.abs(dMean * (x1Sum / n) - dx1Sum / n) / mssMean);
        axisErrors[1].push(Math.abs(dMean * (x2Sum / n) - dx2Sum / n) / mssMean);
      }
    }
    const summarise = (errors) => {
      let weightSum = 0;
      let errorSum = 0;
      let maxIndex = 0;
      errors.forEach((error, index) => {
        weightSum += weights[index];
        errorSum += weights[index] * error;
        if (error > errors[maxIndex]) maxIndex = index;
      });
      const mean = errorSum / weightSum;
      const p99 = weightedQuantile(errors, weights, 0.99);
      return {
        mean, p99, max: errors[maxIndex], maxAtLatLon: places[maxIndex],
        over10Percent: errors.filter((error) => error > 0.1).length,
        pass: mean < MIP_BIAS_BARS.mean && p99 < MIP_BIAS_BARS.p99,
      };
    };
    levels.push({
      level,
      blockTexels: size,
      blocks: weights.length,
      speed: MIP_BIAS_TILTS_DEG.map((tilt, index) => ({ tiltDeg: tilt, ...summarise(speedErrors[index]) })),
      anisotropy: [0, 1].map((component) => ({ component: component + 1, ...summarise(axisErrors[component]) })),
    });
  }
  const pass = levels.every((entry) => entry.speed.every((row) => row.pass) && entry.anisotropy.every((row) => row.pass));
  return { bars: MIP_BIAS_BARS, latLimitDeg, minSea, levels, pass };
}

/**
 * The seams: per pair of neighbouring columns (c, c + 1 wrapping), the mean
 * |difference| of each channel over the open-sea rows (|latitude| <= 60, sea
 * share at least a half on both sides). The pairs named in `seams` are
 * reported against the distribution over every other pair: a seam the
 * resampler or the roll broke stands out above all of them.
 */
export function seamNumbers({ width, height, channels, sea }, seams, { latLimitDeg = 60, minSea = 0.5 } = {}) {
  const names = Object.keys(channels);
  const pairMeans = names.map(() => new Float64Array(width));
  for (let left = 0; left < width; left++) {
    const right = (left + 1) % width;
    const sums = names.map(() => 0);
    let count = 0;
    for (let row = 0; row < height; row++) {
      if (Math.abs(latitudeOfRow(row, height)) > latLimitDeg) continue;
      const a = row * width + left;
      const b = row * width + right;
      if (sea[a] < minSea || sea[b] < minSea) continue;
      names.forEach((name, index) => { sums[index] += Math.abs(channels[name][a] - channels[name][b]); });
      count++;
    }
    names.forEach((name, index) => { pairMeans[index][left] = count ? sums[index] / count : 0; });
  }
  const report = {};
  for (const [label, left] of Object.entries(seams)) {
    report[label] = { columns: [left, (left + 1) % width], lonDeg: -180 + ((left + 1) % width) * (360 / width) };
    names.forEach((name, index) => {
      const others = Array.from(pairMeans[index]).filter((_, column) => !Object.values(seams).includes(column)).sort((x, y) => x - y);
      const value = pairMeans[index][left];
      const rank = others.filter((other) => other < value).length / others.length;
      report[label][name] = {
        meanAbsDiff: value,
        othersMedian: others[Math.floor(others.length / 2)],
        othersP95: others[Math.floor(0.95 * (others.length - 1))],
        othersMax: others[others.length - 1],
        percentile: rank,
        pass: value <= others[others.length - 1],
      };
    });
  }
  return report;
}

export { latitudeOfRow, longitudeOfColumn };
