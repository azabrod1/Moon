/**
 * Types for the sea wind field generator, hand-written because tools/ sits
 * outside the TypeScript project (tsconfig includes only src/). They exist so
 * src/planetarium/world/seaWind.test.ts can drive the real generator — the
 * periodicity, the band statistics and the mip property — instead of
 * restating what it does.
 */

/** Cox-Munk's mean-square slope of a clean sea at no wind, and the slope per
 *  metre a second; world/seaWind.ts holds the same two numbers. */
export const COX_MUNK_SLOPE_CALM: number;
export const COX_MUNK_SLOPE_PER_MS: number;

/** The wind the windy channel's full scale stands for, m/s. */
export const SEA_WIND_MAX_MS: number;

/** Cox-Munk's mean-square slope at a wind, m/s. */
export function meanSquareSlope(windMs: number): number;

export interface SeaWindFieldParams {
  /** Zonal mean wind by latitude (north positive), m/s, rows descending. */
  zonal: ReadonlyArray<readonly [latitudeDeg: number, windMs: number]>;
  /** The share of the sea that is calm lane, by zonal wind, rows descending. */
  laneFractionByWind: ReadonlyArray<readonly [windMs: number, fraction: number]>;
  /** The share of the sea inside a calm region, by zonal wind. */
  regionFractionByWind: ReadonlyArray<readonly [windMs: number, fraction: number]>;
  /** One scale on both shares. */
  calmScale: number;
  /** The streaked terms' stretch along the streak, and the tangent of their
   *  tilt from the parallels (mirrored across the equator). */
  stretch: number;
  tilt: number;
  /** Broad structure and fine grain as fractions of the zonal mean; the
   *  grain's cell in degrees and its octaves. */
  broadSpread: number;
  grain: number;
  grainCell: number;
  grainOctaves: number;
  laneCell: number;
  laneOctaves: number;
  laneEdge: number;
  regionCell: number;
  regionEdge: number;
  /** Inside a region the sea drops to this fraction of its wind. */
  regionWindScale: number;
  /** The glassy lobe the calm weight is measured against, as a wind. */
  calmReferenceWindMs: number;
  /** The n x n box of points a texel averages. */
  supersample: number;
  /** How many times smaller the windy map is than the calm map, a side. */
  windyDownsample: number;
}

/** The field's parameters as shipped. */
export const DEFAULTS: Readonly<SeaWindFieldParams>;

/**
 * The weight of a glassy reference lobe that gives its mixture with a windy
 * lobe the same peak brightness as one lobe at `windMs`: a ratio of
 * reciprocal mean-square slopes, clamped to [0, 1].
 */
export function calmWeightForWind(windMs: number, windyMs: number, referenceWindMs: number): number;

export interface SeaWindPoint {
  /** The single-wind design the mixture stands in for, m/s. */
  windMs: number;
  /** The calm weight in [0, 1]. */
  calmWeight: number;
  /** The windy lobe's wind, m/s. */
  windyMs: number;
}

/** (longitude, latitude) in degrees to the field at that point, sharing the
 *  builder's arithmetic exactly. */
export function pointEvaluator(params?: Partial<SeaWindFieldParams>): (lonDeg: number, latDeg: number) => SeaWindPoint;

export interface SeaWindField {
  /** The calm map's size; row 0 the south pole, as the shader reads it. */
  width: number;
  height: number;
  calmWeight: Float32Array;
  /** The single-wind design's mean over the texel, for the statistics. */
  windMs: Float32Array;
  /** The windy map, `windyDownsample` times smaller a side. */
  windyWidth: number;
  windyHeight: number;
  windyMs: Float32Array;
}

/** The field at a size, a box of `supersample` x `supersample` points a texel. */
export function buildField(width: number, height: number, params?: Partial<SeaWindFieldParams>): SeaWindField;

/** The calm map as a grey picture, three bytes a texel, north-up. */
export function encodeCalmGrey(field: SeaWindField): Uint8Array;
/** The windy map as a grey picture, the speed over SEA_WIND_MAX_MS. */
export function encodeWindyGrey(field: SeaWindField): Uint8Array;
/** Both maps in one picture at the calm map's size, north-up: red the calm
 *  weight, green the windy speed, blue nothing — the DEV override's form. */
export function encodeSeaWindRgb(field: SeaWindField): Uint8Array;

export interface SeaWindBandStatistics {
  meanWindMs: number;
  meanCalmWeight: number;
  under1Fraction: number;
  under2Fraction: number;
}

/** Area-weighted statistics over |latitude| in [low, high), land included. */
export function bandStatistics(field: SeaWindField, latLowDeg: number, latHighDeg: number): SeaWindBandStatistics;
