// The ozone extinction Earth's air is baked with, derived from the published
// tables rather than copied in, and pinned to the derivation: Bruneton's
// Chappuis-band cross-section (Serdyuchenko et al. as tabulated in the
// precomputed-scattering reference, 360-830 nm at 10 nm), the extraterrestrial
// Sun from the same table, the CIE 1931 2-degree matching functions and the
// XYZ-to-linear-sRGB matrix. A bake that holds three wavelengths needs ONE
// coefficient per display channel, and sampling the cross-section at 680 nm
// put red on the weak wing of the band (a display's red sits near 600 nm,
// inside it), which is the lavender limb of 2026-10-08. The effective value is
// the one that gives a display channel the transmittance its whole spectrum
// has through the column, which depends on the spectrum the channel carries:
// the Sun's for light that comes straight through, the blue airlight's for the
// light a limb scatters. The two bracket the value; the spec ships the middle.
import { describe, expect, it } from 'vitest';
import { ATMOSPHERE_WAVELENGTHS_NM, atmosphereSpec } from './atmosphereModel';

// CIE 1931 2-degree colour matching functions at 10 nm, 360-830 nm: x, y, z per row.
const CIE_XYZ_10NM: ReadonlyArray<readonly [number, number, number]> = [
  [0.0001299, 0.000003917, 0.0006061],
  [0.0004149, 0.00001239, 0.001946],
  [0.001368, 0.000039, 0.00645],
  [0.004243, 0.00012, 0.02005],
  [0.01431, 0.000396, 0.06785],
  [0.04351, 0.00121, 0.2074],
  [0.13438, 0.004, 0.6456],
  [0.2839, 0.0116, 1.3856],
  [0.34828, 0.023, 1.7471],
  [0.3362, 0.038, 1.7721],
  [0.2908, 0.06, 1.6692],
  [0.19536, 0.09098, 1.2876],
  [0.09564, 0.13902, 0.81295],
  [0.03201, 0.20802, 0.46518],
  [0.0049, 0.323, 0.272],
  [0.0093, 0.503, 0.1582],
  [0.06327, 0.71, 0.07825],
  [0.1655, 0.862, 0.04216],
  [0.2904, 0.954, 0.0203],
  [0.43345, 0.99495, 0.00875],
  [0.5945, 0.995, 0.0039],
  [0.7621, 0.952, 0.0021],
  [0.9163, 0.87, 0.00165],
  [1.0263, 0.757, 0.0011],
  [1.0622, 0.631, 0.0008],
  [1.0026, 0.503, 0.00034],
  [0.85445, 0.381, 0.00019],
  [0.6424, 0.265, 0.00005],
  [0.4479, 0.175, 0.00002],
  [0.2835, 0.107, 0],
  [0.1649, 0.061, 0],
  [0.0874, 0.032, 0],
  [0.04677, 0.017, 0],
  [0.0227, 0.00821, 0],
  [0.011359, 0.004102, 0],
  [0.0057903, 0.002091, 0],
  [0.0028993, 0.001047, 0],
  [0.00144, 0.00052, 0],
  [0.00069008, 0.0002492, 0],
  [0.0003323, 0.00012, 0],
  [0.00016615, 0.00006, 0],
  [0.000083075, 0.00003, 0],
  [0.00004151, 0.00001499, 0],
  [0.000020674, 0.0000074657, 0],
  [0.000010254, 0.0000037029, 0],
  [0.0000050859, 0.0000018366, 0],
  [0.0000025225, 9.1093e-7, 0],
  [0.0000012511, 4.5181e-7, 0],
];
// XYZ to linear sRGB (D65), rows red, green, blue.
const XYZ_TO_SRGB = [3.2406, -1.5372, -0.4986, -0.9689, 1.8758, 0.0415, 0.0557, -0.204, 1.057];
// Ozone absorption cross-section, m^2 per molecule, 360-830 nm at 10 nm.
const OZONE_CROSS_SECTION_M2 = [1.18e-27, 2.182e-28, 2.818e-28, 6.636e-28, 1.527e-27, 2.763e-27, 5.52e-27, 8.451e-27, 1.582e-26, 2.316e-26, 3.669e-26, 4.924e-26, 7.752e-26, 9.016e-26, 1.48e-25, 1.602e-25, 2.139e-25, 2.755e-25, 3.091e-25, 3.5e-25, 4.266e-25, 4.672e-25, 4.398e-25, 4.701e-25, 5.019e-25, 4.305e-25, 3.74e-25, 3.215e-25, 2.662e-25, 2.238e-25, 1.852e-25, 1.473e-25, 1.209e-25, 9.423e-26, 7.455e-26, 6.566e-26, 5.105e-26, 4.15e-26, 4.228e-26, 3.237e-26, 2.451e-26, 2.801e-26, 2.534e-26, 1.624e-26, 1.465e-26, 2.078e-26, 1.383e-26, 7.105e-27];
// Extraterrestrial solar irradiance, W/m^2/nm, 360-830 nm at 10 nm.
const SOLAR_IRRADIANCE = [1.1178, 1.1426, 1.0125, 1.1472, 1.7276, 1.7305, 1.6887, 1.6125, 1.912, 2.0347, 2.0204, 2.0221, 1.9338, 1.9581, 1.9169, 1.8298, 1.8685, 1.8931, 1.8515, 1.8504, 1.8341, 1.8345, 1.8147, 1.7816, 1.7533, 1.6965, 1.6819, 1.6465, 1.6048, 1.5214, 1.5562, 1.5113, 1.474, 1.4482, 1.4102, 1.3678, 1.3419, 1.3143, 1.283, 1.2676, 1.2367, 1.2082, 1.1874, 1.1468, 1.1236, 1.1058, 1.0712, 1.0499];
const LAMBDAS_NM = CIE_XYZ_10NM.map((_, i) => 360 + 10 * i);
/** One Dobson unit, molecules per m²; the tent holds 300 of them. */
const DOBSON_UNIT_PER_M2 = 2.687e20;
const TENT_DOBSON_UNITS = 300;
const EARTH_RADIUS_M = 6371e3;

const spec = atmosphereSpec('Earth')!;
const tent = spec.absorption!;
/** The tent's vertical integral in metres (a triangle), and the peak density
 *  that makes it 300 Dobson units — Bruneton's 5.374e18 /m³. */
const tentIntegralM = ((tent.topKm - tent.bottomKm) / 2) * 1000;
const peakDensity = (TENT_DOBSON_UNITS * DOBSON_UNIT_PER_M2) / tentIntegralM;
const tentDensity = (hKm: number): number => {
  if (hKm <= tent.bottomKm || hKm >= tent.topKm) return 0;
  return hKm < tent.peakKm ? (hKm - tent.bottomKm) / (tent.peakKm - tent.bottomKm) : (tent.topKm - hKm) / (tent.topKm - tent.peakKm);
};
/** Extinction per metre at the peak of the tent, at a tabulated wavelength. */
const ozoneAt = (nm: number): number => OZONE_CROSS_SECTION_M2[(nm - 360) / 10] * peakDensity;
/** The ozone along a tangent ray at altitude h, in metres at the peak density. */
const tangentColumn = (hKm: number): number => {
  const r0 = EARTH_RADIUS_M + hKm * 1000;
  let sum = 0;
  const step = 200;
  for (let x = -1.5e6; x <= 1.5e6; x += step) sum += tentDensity((Math.hypot(r0, x) - EARTH_RADIUS_M) / 1000) * step;
  return sum;
};
/** Each display channel's weight per tabulated wavelength: the matching
 *  functions through the sRGB matrix (signed, as the primaries are), times
 *  the spectrum the channel carries. */
const channelWeights = (spectrum: (nm: number, i: number) => number): number[][] =>
  [0, 1, 2].map((c) => LAMBDAS_NM.map((nm, i) => {
    const [x, y, z] = CIE_XYZ_10NM[i];
    return (XYZ_TO_SRGB[3 * c] * x + XYZ_TO_SRGB[3 * c + 1] * y + XYZ_TO_SRGB[3 * c + 2] * z) * spectrum(nm, i);
  }));
/** The per-channel extinction that reproduces the channel's transmittance
 *  through `columnM` metres of peak-density ozone. */
const effective = (weights: number[][], columnM: number): number[] =>
  weights.map((w) => {
    let transmitted = 0;
    let total = 0;
    LAMBDAS_NM.forEach((nm, i) => { transmitted += w[i] * Math.exp(-ozoneAt(nm) * columnM); total += w[i]; });
    return -Math.log(transmitted / total) / columnM;
  });
const sunlight = (_nm: number, i: number): number => SOLAR_IRRADIANCE[i];
const airlight = (nm: number, i: number): number => SOLAR_IRRADIANCE[i] * (550 / nm) ** 4;

describe("Earth's ozone extinction", () => {
  const shipped = tent.extinctionPerM;

  it('the tent is 300 Dobson units at the reference peak density', () => {
    expect(peakDensity).toBeCloseTo(5.374e18, -15);
  });

  it('sampling the cross-section at the three bake wavelengths gives the triplet this replaced, not the one shipped', () => {
    const sampled = ATMOSPHERE_WAVELENGTHS_NM.map(ozoneAt);
    expect(sampled[0] / 0.65e-6).toBeCloseTo(1, 2);
    expect(sampled[1] / 1.881e-6).toBeCloseTo(1, 2);
    expect(sampled[2] / 0.085e-6).toBeCloseTo(1, 2);
    expect(shipped[0] / sampled[0]).toBeGreaterThan(3.5);
  });

  it('the shipped triplet sits between the sunlight and airlight weightings along the strongest tangent column, every channel positive', () => {
    const column = tangentColumn(20);
    expect(column).toBeGreaterThan(6e5);
    const sun = effective(channelWeights(sunlight), column);
    const air = effective(channelWeights(airlight), column);
    for (let c = 0; c < 3; c++) {
      const low = Math.min(sun[c], air[c]);
      const high = Math.max(sun[c], air[c]);
      expect(low, `channel ${c}`).toBeGreaterThan(0);
      expect(shipped[c], `channel ${c}: ${sun[c].toExponential(3)} .. ${air[c].toExponential(3)}`).toBeGreaterThanOrEqual(low * 0.97);
      expect(shipped[c], `channel ${c}: ${sun[c].toExponential(3)} .. ${air[c].toExponential(3)}`).toBeLessThanOrEqual(high * 1.03);
    }
    // The bracket itself, so a table change shows as a number.
    expect(sun[0] / 1e-6).toBeCloseTo(2.51, 1);
    expect(air[0] / 1e-6).toBeCloseTo(2.94, 1);
    expect(sun[1] / 1e-6).toBeCloseTo(1.74, 1);
    expect(air[1] / 1e-6).toBeCloseTo(1.89, 1);
  });

  it('the bracket barely moves with the column: the value is a property of the spectrum, not of one path', () => {
    const weights = channelWeights(airlight);
    const atTen = effective(weights, tangentColumn(10));
    const atThirty = effective(weights, tangentColumn(30));
    expect(atTen[0] / atThirty[0]).toBeCloseTo(1, 1);
    expect(atTen[1] / atThirty[1]).toBeCloseTo(1, 1);
  });
});
