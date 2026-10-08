/**
 * Types for the sea wind map's arithmetic (tools/seaWindMap.mjs), hand-written
 * because tools/ sits outside the TypeScript project (tsconfig includes only
 * src/). They exist so src/planetarium/world/seaWind.test.ts can drive the
 * bake's own encoder, axis law, roll, fill and resampler instead of restating
 * them.
 */

/** Cox and Munk's slope variances along and across the wind, each along one
 *  axis: sigma_u² = UPWIND_PER_MS U, sigma_c² = CROSSWIND_CALM +
 *  CROSSWIND_PER_MS U. */
export const COX_MUNK_UPWIND_PER_MS: number;
export const COX_MUNK_CROSSWIND_CALM: number;
export const COX_MUNK_CROSSWIND_PER_MS: number;
/** sigma_u² - sigma_c² at a wind, m/s: negative below 2.42 m/s. */
export function slopeAnisotropy(windMs: number): number;

/** The axis bytes: 128 + round(127 x), decoded (byte - 128) / 127. */
export const AXIS_ZERO: number;
export const AXIS_SCALE: number;
export const AXIS_DIVISOR_FLOOR: number;
export function windToByte(windMs: number): number;
export function byteToWind(byte: number): number;
export function axisToByte(x: number): number;
export function byteToAxis(byte: number): number;
/** a / d(R), clamped to the unit disc, none where |d(R)| is under the floor. */
export function axisFromAccumulator(a1: number, a2: number, windMs: number): [number, number];

export interface WindMapFields {
  width: number;
  height: number;
  /** Row 0 the south, m/s. */
  windMs: ArrayLike<number>;
  /** Row 0 the south, the axis in the unit disc; absent is no axis (128). */
  axisX?: ArrayLike<number> | null;
  axisY?: ArrayLike<number> | null;
}
/** RGBA, north-up, alpha 255: the one encoder every arm writes through. */
export function encodeWindMap(fields: WindMapFields): Uint8Array;
export interface DecodedWindMap {
  width: number;
  height: number;
  red: Uint8Array;
  green: Uint8Array;
  blue: Uint8Array;
  windMs: Float64Array;
  axisX: Float64Array;
  axisY: Float64Array;
}
/** A north-up picture of the map back into fields, row 0 south. */
export function decodeWindMap(pixels: ArrayLike<number>, width: number, height: number, channels?: number): DecodedWindMap;
export function rgbFromRgba(rgba: ArrayLike<number>): Uint8Array;

export const SYNTHETIC_STEADINESS: number;
/** The synthetic arm's zonal axis at a latitude. */
export function syntheticAxis(latDeg: number): [number, number];

export const WATER_CLASSES: readonly number[];
export interface WindAccumulator {
  cellCount: number;
  months: Uint8Array;
  windSum: Float64Array;
  a1Sum: Float64Array;
  a2Sum: Float64Array;
}
export function createAccumulator(cellCount: number): WindAccumulator;
export interface MonthFields {
  u: ArrayLike<number>;
  v: ArrayLike<number>;
  w: ArrayLike<number>;
  mask: ArrayLike<number>;
  uScale?: number;
  uOffset?: number;
  vScale?: number;
  vOffset?: number;
  wScale?: number;
  wOffset?: number;
}
export interface MonthResult {
  kHistogram: Float64Array;
  windHistogram: Float64Array;
  kOverOne: number;
  nonFinite: Record<string, number>;
  valid: number;
  windMax: number;
  watched: Array<{ cell: number; windMs: number; k: number; towardDeg: number }>;
}
export function accumulateMonth(acc: WindAccumulator, month: MonthFields, watch?: readonly number[]): MonthResult;
export function finishAccumulator(acc: WindAccumulator, minMonths: number): {
  windMs: Float64Array;
  a1: Float64Array;
  a2: Float64Array;
  filled: Uint8Array;
};
export function histogramQuantiles(histogram: ArrayLike<number>, quantiles: readonly number[], binsPerUnit?: number): number[];
export const W_BINS_PER_MS: number;

/** Each row's columns moved `shift` to the right, wrapping. */
export function rollColumns<T extends Float64Array | Float32Array | Uint8Array>(values: T, width: number, height: number, shift: number): T;
/** Per cell the index of the nearest filled cell, longitude periodic. */
export function nearestFilledIndex(filled: ArrayLike<number>, width: number, height: number): Int32Array;
/** The cells of `mask` in connected bodies (8 ways, longitude periodic) of at
 *  least `minCells`. */
export function largeBodies(mask: ArrayLike<number>, width: number, height: number, minCells: number): {
  kept: Uint8Array; bodiesKept: number; bodiesDropped: number; cellsDropped: number;
};
export function fillFromNearest(arrays: Array<Float64Array | Float32Array>, filled: ArrayLike<number>, nearest: ArrayLike<number>): void;
export interface AreaAveragerGrid {
  srcWidth: number;
  srcHeight: number;
  srcWestEdgeDeg: number;
  srcLatCentreDeg: (row: number) => number;
  srcRowHeightDeg: number;
  dstWidth: number;
  dstHeight: number;
}
/** The area average onto the map's grid, periodic in longitude from -180. */
export function areaAverager(grid: AreaAveragerGrid): (values: ArrayLike<number>) => Float64Array;

export function lobe(mss: number, tiltDeg: number): number;
export function weightedQuantile(values: readonly number[], weights: readonly number[], q: number): number;
export const MIP_BIAS_BARS: Readonly<{ mean: number; p99: number }>;
export const MIP_BIAS_LEVELS: readonly number[];
export const MIP_BIAS_TILTS_DEG: readonly number[];
export interface MipBiasRow {
  mean: number;
  p99: number;
  max: number;
  maxAtLatLon: [number, number];
  over10Percent: number;
  pass: boolean;
}
export interface MipBias {
  bars: Readonly<{ mean: number; p99: number }>;
  latLimitDeg: number;
  minSea: number;
  levels: Array<{
    level: number;
    blockTexels: number;
    blocks: number;
    speed: Array<MipBiasRow & { tiltDeg: number }>;
    anisotropy: Array<MipBiasRow & { component: number }>;
  }>;
  pass: boolean;
}
export function mipBias(
  map: { width: number; height: number; windMs: ArrayLike<number>; axisX: ArrayLike<number>; axisY: ArrayLike<number>; sea: ArrayLike<number> },
  options?: { latLimitDeg?: number; minSea?: number },
): MipBias;
export function seamNumbers(
  map: { width: number; height: number; channels: Record<string, ArrayLike<number>>; sea: ArrayLike<number> },
  seams: Record<string, number>,
  options?: { latLimitDeg?: number; minSea?: number },
): Record<string, Record<string, unknown>>;
export function latitudeOfRow(row: number, height: number): number;
export function longitudeOfColumn(column: number, width: number): number;
