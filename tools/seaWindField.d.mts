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

/** The wind the map's full scale stands for, m/s. */
export const SEA_WIND_MAX_MS: number;

/** Cox-Munk's mean-square slope at a wind, m/s. */
export function meanSquareSlope(windMs: number): number;

export interface SeaWindFieldParams {
  /** Zonal mean wind by latitude (north positive), m/s, rows descending. */
  zonal: ReadonlyArray<readonly [latitudeDeg: number, windMs: number]>;
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
  /** The n x n box of points a texel averages. */
  supersample: number;
}

/** The field's parameters as shipped. */
export const DEFAULTS: Readonly<SeaWindFieldParams>;

/** (longitude, latitude) in degrees to the wind there, m/s, sharing the
 *  builder's arithmetic exactly. */
export function pointEvaluator(params?: Partial<SeaWindFieldParams>): (lonDeg: number, latDeg: number) => number;

export interface SeaWindField {
  /** The map's size; row 0 the south pole, as the shader reads it. */
  width: number;
  height: number;
  /** The mean wind over each texel's box of points, m/s. */
  windMs: Float32Array;
}

/** The field at a size, a box of `supersample` x `supersample` points a texel. */
export function buildField(width: number, height: number, params?: Partial<SeaWindFieldParams>): SeaWindField;

/** The map as a grey picture, three bytes a texel, north-up, the wind over
 *  SEA_WIND_MAX_MS. */
export function encodeWindGrey(field: SeaWindField): Uint8Array;

export interface SeaWindBandStatistics {
  meanWindMs: number;
  under1Fraction: number;
  under2Fraction: number;
}

/** Area-weighted statistics over |latitude| in [low, high), land included. */
export function bandStatistics(field: SeaWindField, latLowDeg: number, latHighDeg: number): SeaWindBandStatistics;
