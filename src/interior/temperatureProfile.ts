/**
 * Temperature as a function of physical radius: the one definition of a
 * region's temperature that everything reading it shares. The Temperature
 * diagram's colour at a pixel, the Materials glow at the same pixel, the
 * body's scale, a legend swatch and the thin-layer inset's swatch all come
 * from sampleTemperatureK, so the two views can never disagree about how
 * hot a place is (plan F22).
 *
 * A quantity is sampled at a physical radius. Endpoints run from the
 * region's top (`outer`) to its bottom (`inner`), linear or logarithmic as
 * the model declares; a profile is read between its own samples, every one
 * of them, so an extremum inside a region is honoured and not only its ends;
 * outside a profile's first and last sample the value is held. Unknown is
 * null, never a number — an unknown temperature is drawn cold and hatched,
 * never guessed. 'none' is refused on a temperature by the validator; here it
 * reads as linear, so a sampler never has to fail.
 *
 * The shader cannot hold a profile of any length, so a region hands it
 * TEMPERATURE_KNOTS temperatures at even depth fractions, the quantity read
 * at each, and interpolates between them the way the quantity declares
 * (temperatureKnotsK). That is exact for every endpoints quantity — the
 * knots lie on the ramp, and a linear or log mix between two points of a
 * linear or log ramp is the ramp — and a chord of the profile between knots
 * otherwise. The Readable remap is linear within a region, so a depth
 * fraction is the same in display and physical space, which is what lets
 * the shader sample by depth fraction at all (temperatureProfile.test.ts
 * pins it against the remap).
 *
 * Pure: no three, no DOM.
 */
import type { Quantity } from './data/interiorTypes';

/** Temperatures per region the shader holds, at even depth fractions from the top to the bottom. */
export const TEMPERATURE_KNOTS = 8;

/** Where a physical radius sits in a region: 0 at its top (the outer radius), 1 at its bottom. */
export function depthFraction(physicalRadiusKm: number, innerRadiusKm: number, outerRadiusKm: number): number {
  const span = outerRadiusKm - innerRadiusKm;
  if (!(span > 0)) return 0;
  return Math.min(1, Math.max(0, (outerRadiusKm - physicalRadiusKm) / span));
}

/** Between two temperatures by t, on a line or on a log (floored at one kelvin, as the shader floors it). */
export function interpolateK(fromK: number, toK: number, t: number, log: boolean): number {
  if (log) {
    const low = Math.log(Math.max(fromK, 1));
    const high = Math.log(Math.max(toK, 1));
    return Math.exp(low + (high - low) * t);
  }
  return fromK + (toK - fromK) * t;
}

/** Whether a quantity's ramp is logarithmic (false for unknown). */
export function temperatureLog(quantity: Quantity): boolean {
  return quantity.kind !== 'unknown' && quantity.interpolation === 'log';
}

/**
 * The temperature at a physical radius inside a region, K, or null when the
 * quantity says nothing. Endpoints interpolate over the region's own radii;
 * a profile interpolates between its samples and holds beyond them.
 */
export function sampleTemperatureK(quantity: Quantity, physicalRadiusKm: number, innerRadiusKm: number, outerRadiusKm: number): number | null {
  if (quantity.kind === 'endpoints') {
    const t = depthFraction(physicalRadiusKm, innerRadiusKm, outerRadiusKm);
    return interpolateK(quantity.outer.value, quantity.inner.value, t, quantity.interpolation === 'log');
  }
  if (quantity.kind === 'profile') {
    const samples = quantity.samples;
    if (samples.length === 0) return null;
    if (samples.length === 1) return samples[0].value;
    const radiusKm = Math.min(samples[samples.length - 1].radiusKm, Math.max(samples[0].radiusKm, physicalRadiusKm));
    let upper = 1;
    while (upper < samples.length - 1 && samples[upper].radiusKm < radiusKm) upper++;
    const low = samples[upper - 1];
    const high = samples[upper];
    const t = high.radiusKm > low.radiusKm ? (radiusKm - low.radiusKm) / (high.radiusKm - low.radiusKm) : 0;
    return interpolateK(low.value, high.value, t, quantity.interpolation === 'log');
  }
  return null;
}

/** The coldest and hottest temperature a quantity holds anywhere in its region
 *  — a profile's every sample, not only its ends — or null when unknown. */
export function temperatureExtremes(quantity: Quantity): { minK: number; maxK: number } | null {
  if (quantity.kind === 'endpoints') {
    return { minK: Math.min(quantity.inner.value, quantity.outer.value), maxK: Math.max(quantity.inner.value, quantity.outer.value) };
  }
  if (quantity.kind === 'profile' && quantity.samples.length > 0) {
    let minK = Infinity;
    let maxK = -Infinity;
    for (const sample of quantity.samples) {
      minK = Math.min(minK, sample.value);
      maxK = Math.max(maxK, sample.value);
    }
    return { minK, maxK };
  }
  return null;
}

/** The temperature at even depth fractions from the region's top to its
 *  bottom — the shader's knots — or null when unknown. */
export function temperatureKnotsK(quantity: Quantity, innerRadiusKm: number, outerRadiusKm: number, count = TEMPERATURE_KNOTS): number[] | null {
  if (quantity.kind === 'unknown') return null;
  const knots: number[] = [];
  for (let index = 0; index < count; index++) {
    const t = count > 1 ? index / (count - 1) : 0;
    const radiusKm = outerRadiusKm - t * (outerRadiusKm - innerRadiusKm);
    const kelvin = sampleTemperatureK(quantity, radiusKm, innerRadiusKm, outerRadiusKm);
    if (kelvin === null) return null;
    knots.push(kelvin);
  }
  return knots;
}

/** The temperature the shader reads between the knots at a depth fraction:
 *  the knot pair the fraction falls between, mixed on a line or a log as the
 *  quantity declares. The CPU statement of sectionTempK, for the tests and
 *  for any reader that wants what the face shows rather than the model. */
export function knotsTemperatureK(knotsK: readonly number[], log: boolean, regionT: number): number {
  const last = knotsK.length - 1;
  if (last < 1) return knotsK[0] ?? 0;
  const x = Math.min(1, Math.max(0, regionT)) * last;
  const index = Math.min(last - 1, Math.floor(x));
  return interpolateK(knotsK[index], knotsK[index + 1], x - index, log);
}

/** The one number a region is summed up by where a summary needs one — its
 *  legend swatch, the inset's — the temperature at the middle of the region;
 *  null when unknown. The mean of a linear ramp's ends, the geometric mean
 *  of a log ramp's, and a profile's value at mid-depth. */
export function representativeTemperatureK(quantity: Quantity, innerRadiusKm: number, outerRadiusKm: number): number | null {
  return sampleTemperatureK(quantity, (innerRadiusKm + outerRadiusKm) / 2, innerRadiusKm, outerRadiusKm);
}
