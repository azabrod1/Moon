/**
 * The fitted ephemeris: Chebyshev series fitted to JPL Horizons by
 * gen-ephemeris.mjs (`npm run gen:ephemeris`), shipped as
 * public/ephemeris/ephemeris.v1.bin and installed here before anything asks
 * for a position (world/ephemerisLoader.ts at boot, the test setup in tests).
 *
 * It holds geometric positions in km, ICRF axes, TDB, from 1900-01-01 to
 * 2100-06-16: the Moon about Earth's centre, and about the Sun's centre the
 * Earth–Moon barycentre and the barycentres of the other planetary systems.
 * Its worst errors on Horizons samples the fit never saw are in the file
 * (0.5 km for the Moon; a few km for the inner planets; tens of km for the
 * giants, a few hundredths of an arcsecond from Earth).
 *
 * planetary.ts reads it through `fittedPositionKm` and falls back to its
 * analytic models outside the window, or before the file is installed.
 * Times are taken as TDB from a TT Julian Date: the two differ by under 2 ms.
 *
 * Format v1 (little-endian), as gen-ephemeris.mjs writes it:
 *   header    magic 'MEPH' | version u16 | bodyCount u16
 *   per body  nameLength u8 | name | startJd f64 | intervalDays f64
 *             | intervalCount u32 | coefficientCount u16 | heldOutKm f32
 *             | dataOffset u32
 *   data      per interval, per coordinate: c0 f64, c1 f64, c2… f32 (km)
 */
import type * as THREE from 'three';

export const FITTED_EPHEMERIS_FILE = 'ephemeris/ephemeris.v1.bin';

/** Earth/Moon mass ratio from Horizons' physical data for body 301; the
 *  generator fits with the same value. */
export const EARTH_MOON_MASS_RATIO = 81.3005690769;

const MAGIC = 'MEPH';
const VERSION = 1;

export interface FittedSeries {
  name: string;
  startJd: number;
  intervalDays: number;
  intervalCount: number;
  coefficientCount: number;
  /** The fit's worst error on held-out Horizons samples, km. */
  heldOutKm: number;
  /** All coefficients, decoded: [interval][coordinate][degree]. */
  coefficients: Float64Array;
}

export type FittedEphemeris = ReadonlyMap<string, FittedSeries>;

/** Parse the shipped file. Throws on anything that is not a complete v1
 *  file: a truncated download must never install as a shorter ephemeris. */
export function parseFittedEphemeris(buffer: ArrayBuffer): FittedEphemeris {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  if (buffer.byteLength < 8 || new TextDecoder().decode(bytes.subarray(0, 4)) !== MAGIC) {
    throw new Error('ephemeris: bad magic');
  }
  const version = view.getUint16(4, true);
  if (version !== VERSION) throw new Error(`ephemeris: unsupported version ${version}`);
  const bodyCount = view.getUint16(6, true);
  const series = new Map<string, FittedSeries>();
  let cursor = 8;
  for (let bodyIndex = 0; bodyIndex < bodyCount; bodyIndex++) {
    if (cursor + 1 > buffer.byteLength) throw new Error('ephemeris: truncated directory');
    const nameLength = view.getUint8(cursor);
    const name = new TextDecoder().decode(bytes.subarray(cursor + 1, cursor + 1 + nameLength));
    cursor += 1 + nameLength;
    if (cursor + 30 > buffer.byteLength) throw new Error('ephemeris: truncated directory');
    const startJd = view.getFloat64(cursor, true);
    const intervalDays = view.getFloat64(cursor + 8, true);
    const intervalCount = view.getUint32(cursor + 16, true);
    const coefficientCount = view.getUint16(cursor + 20, true);
    const heldOutKm = view.getFloat32(cursor + 22, true);
    const dataOffset = view.getUint32(cursor + 26, true);
    cursor += 30;
    const blockBytes = 16 + 4 * (coefficientCount - 2);
    const blockCount = intervalCount * 3;
    if (coefficientCount < 2 || dataOffset + blockCount * blockBytes > buffer.byteLength) {
      throw new Error(`ephemeris: truncated data for ${name}`);
    }
    const coefficients = new Float64Array(blockCount * coefficientCount);
    let at = dataOffset;
    for (let block = 0; block < blockCount; block++) {
      const base = block * coefficientCount;
      coefficients[base] = view.getFloat64(at, true);
      coefficients[base + 1] = view.getFloat64(at + 8, true);
      at += 16;
      for (let degree = 2; degree < coefficientCount; degree++) {
        coefficients[base + degree] = view.getFloat32(at, true);
        at += 4;
      }
    }
    series.set(name, { name, startJd, intervalDays, intervalCount, coefficientCount, heldOutKm, coefficients });
  }
  return series;
}

let installed: FittedEphemeris | null = null;

/** Install (or, with null, remove) the session's ephemeris. */
export function setFittedEphemeris(ephemeris: FittedEphemeris | null): void {
  installed = ephemeris;
}

export function fittedEphemerisInstalled(): boolean {
  return installed !== null;
}

/** The span a body's series covers, as TT/TDB Julian Dates, or null when
 *  nothing is installed or the body has no series. */
export function fittedWindowJd(name: string): { startJd: number; endJd: number } | null {
  const series = installed?.get(name);
  if (!series) return null;
  return { startJd: series.startJd, endJd: series.startJd + series.intervalDays * series.intervalCount };
}

/** Days at each end of a series over which planetary.ts hands a body over
 *  to its analytic model, so a clock running across the edge of the window
 *  never sees a body jump (the analytic Moon differs by up to 2′). */
export const FITTED_BLEND_DAYS = 730;

/**
 * How much of a body's position comes from the fitted series at a TDB Julian
 * Date: 1 inside the window, easing (smoothstep) to 0 across the last
 * FITTED_BLEND_DAYS at each end, 0 outside it or before the file is
 * installed. Allocates nothing.
 */
export function fittedWeight(name: string, jdTdb: number): number {
  const series = installed?.get(name);
  if (!series) return 0;
  const fromStart = jdTdb - series.startJd;
  const toEnd = series.startJd + series.intervalDays * series.intervalCount - jdTdb;
  const edgeDays = Math.min(fromStart, toEnd);
  if (!(edgeDays > 0)) return 0;
  if (edgeDays >= FITTED_BLEND_DAYS) return 1;
  const progress = edgeDays / FITTED_BLEND_DAYS;
  return progress * progress * (3 - 2 * progress);
}

/**
 * A body's position at a TDB Julian Date, km, ICRF axes, written into `out`
 * as (x, y, z). False — `out` untouched — outside the series or before the
 * file is installed. Clenshaw's recurrence; allocates nothing.
 */
export function fittedPositionKm(name: string, jdTdb: number, out: THREE.Vector3): boolean {
  const series = installed?.get(name);
  if (!series) return false;
  const elapsedDays = jdTdb - series.startJd;
  const totalDays = series.intervalDays * series.intervalCount;
  if (!(elapsedDays >= 0 && elapsedDays <= totalDays)) return false;
  const interval = Math.min(Math.floor(elapsedDays / series.intervalDays), series.intervalCount - 1);
  const scaled = (2 * (elapsedDays - interval * series.intervalDays)) / series.intervalDays - 1;
  const count = series.coefficientCount;
  const coefficients = series.coefficients;
  const blockBase = interval * 3 * count;
  out.x = clenshaw(coefficients, blockBase, count, scaled);
  out.y = clenshaw(coefficients, blockBase + count, count, scaled);
  out.z = clenshaw(coefficients, blockBase + 2 * count, count, scaled);
  return true;
}

function clenshaw(coefficients: Float64Array, base: number, count: number, x: number): number {
  let next = 0;
  let afterNext = 0;
  const twoX = 2 * x;
  for (let degree = count - 1; degree >= 1; degree--) {
    const current = twoX * next - afterNext + coefficients[base + degree];
    afterNext = next;
    next = current;
  }
  return x * next - afterNext + coefficients[base];
}
