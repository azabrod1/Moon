import { describe, expect, it } from 'vitest';
import { EARTH_MODEL } from './data/models/earth';
import { SUN_MODEL } from './data/models/sun';
import { endpoints, UNKNOWN } from './data/modelHelpers';
import type { Quantity } from './data/interiorTypes';
import { drawnFromModel } from './drawnModel';
import { readableRemap, toDisplayFraction, toPhysicalFraction } from './interiorGeometry';
import { outerFractionsInsideOut } from './drawnModel';
import {
  TEMPERATURE_KNOTS,
  depthFraction,
  interpolateK,
  knotsTemperatureK,
  representativeTemperatureK,
  sampleTemperatureK,
  temperatureExtremes,
  temperatureKnotsK,
  temperatureLog,
} from './temperatureProfile';

const profile = (samples: [number, number][], interpolation: 'linear' | 'log' = 'linear'): Quantity => ({
  kind: 'profile',
  samples: samples.map(([radiusKm, value]) => ({ radiusKm, value })),
  interpolation,
  source: 's',
  basis: 'modelled',
});

describe('sampleTemperatureK', () => {
  it('runs endpoints from the top of the region to its bottom', () => {
    const quantity = endpoints(5400, 4000, 's', 'inferred'); // inner 5400, outer 4000
    expect(sampleTemperatureK(quantity, 3480, 1220, 3480)).toBe(4000); // the top is the outer value
    expect(sampleTemperatureK(quantity, 1220, 1220, 3480)).toBe(5400); // the bottom the inner
    expect(sampleTemperatureK(quantity, 2350, 1220, 3480)).toBe(4700); // half way, on a line
    // Beyond the region the ramp holds at its ends.
    expect(sampleTemperatureK(quantity, 4000, 1220, 3480)).toBe(4000);
    expect(sampleTemperatureK(quantity, 0, 1220, 3480)).toBe(5400);
  });

  it('interpolates on a log where the model says so', () => {
    const quantity = endpoints(10_000, 100, 's', 'modelled', 'log');
    expect(sampleTemperatureK(quantity, 500, 0, 1000)).toBeCloseTo(1000, 9); // the geometric middle
    const linear = endpoints(10_000, 100, 's', 'modelled');
    expect(sampleTemperatureK(linear, 500, 0, 1000)).toBe(5050);
    expect(temperatureLog(quantity)).toBe(true);
    expect(temperatureLog(linear)).toBe(false);
    expect(temperatureLog(UNKNOWN)).toBe(false);
  });

  it('reads every sample of a profile, holds beyond its ends, and keeps a single sample as a constant', () => {
    // An extremum inside the region, which its ends alone would never show.
    const quantity = profile([[0, 2000], [400, 2600], [1000, 1500]]);
    expect(sampleTemperatureK(quantity, 400, 0, 1000)).toBe(2600);
    expect(sampleTemperatureK(quantity, 200, 0, 1000)).toBe(2300);
    expect(sampleTemperatureK(quantity, 700, 0, 1000)).toBe(2050);
    expect(sampleTemperatureK(quantity, 1000, 0, 1000)).toBe(1500);
    expect(sampleTemperatureK(quantity, 1500, 0, 1000)).toBe(1500); // held past the last sample
    expect(sampleTemperatureK(quantity, -5, 0, 1000)).toBe(2000); // and before the first
    expect(sampleTemperatureK(profile([[300, 777]]), 100, 0, 1000)).toBe(777);
    expect(sampleTemperatureK(profile([]), 100, 0, 1000)).toBeNull();
    const log = profile([[0, 10_000], [1000, 100]], 'log');
    expect(sampleTemperatureK(log, 500, 0, 1000)).toBeCloseTo(1000, 9);
  });

  it('says nothing for unknown', () => {
    expect(sampleTemperatureK(UNKNOWN, 100, 0, 1000)).toBeNull();
    expect(temperatureKnotsK(UNKNOWN, 0, 1000)).toBeNull();
    expect(representativeTemperatureK(UNKNOWN, 0, 1000)).toBeNull();
    expect(temperatureExtremes(UNKNOWN)).toBeNull();
  });

  it('places a radius in a region and floors a log ramp at one kelvin', () => {
    expect(depthFraction(3480, 1220, 3480)).toBe(0);
    expect(depthFraction(1220, 1220, 3480)).toBe(1);
    expect(depthFraction(2350, 1220, 3480)).toBeCloseTo(0.5, 12);
    expect(depthFraction(500, 1000, 1000)).toBe(0); // a region with no thickness has a top and nothing else
    expect(interpolateK(0, 100, 0.5, true)).toBeCloseTo(10, 9); // 0 K floored to 1 K: sqrt(1 × 100)
    expect(interpolateK(0, 100, 0.5, false)).toBe(50);
  });
});

describe('the extremes and the representative temperature', () => {
  it('takes the coldest and hottest value anywhere in the region', () => {
    expect(temperatureExtremes(endpoints(5400, 4000, 's', 'inferred'))).toEqual({ minK: 4000, maxK: 5400 });
    expect(temperatureExtremes(profile([[0, 2000], [400, 2600], [1000, 1500]]))).toEqual({ minK: 1500, maxK: 2600 });
    expect(temperatureExtremes(profile([]))).toBeNull();
  });

  it('is the temperature at the middle of the region: a linear ramp\'s mean, a log ramp\'s geometric mean, a profile\'s mid-depth value', () => {
    expect(representativeTemperatureK(endpoints(5700, 5400, 's', 'inferred'), 0, 1220)).toBe((5700 + 5400) / 2);
    expect(representativeTemperatureK(endpoints(10_000, 100, 's', 'modelled', 'log'), 0, 1000)).toBeCloseTo(1000, 9);
    expect(representativeTemperatureK(profile([[0, 2000], [400, 2600], [1000, 1500]]), 0, 1000)).toBe(2600 - (2600 - 1500) / 6);
  });
});

describe('the knots the shader holds', () => {
  it('lie on an endpoints ramp and reproduce it between themselves, linear or log', () => {
    const linear = endpoints(3700, 1900, 's', 'inferred');
    const knots = temperatureKnotsK(linear, 3480, 5711)!;
    expect(knots).toHaveLength(TEMPERATURE_KNOTS);
    expect(knots[0]).toBe(1900);
    expect(knots[TEMPERATURE_KNOTS - 1]).toBe(3700);
    for (let step = 0; step <= 100; step++) {
      const regionT = step / 100;
      const radiusKm = 5711 - regionT * (5711 - 3480);
      expect(knotsTemperatureK(knots, false, regionT)).toBeCloseTo(sampleTemperatureK(linear, radiusKm, 3480, 5711)!, 9);
    }
    const log = endpoints(15_700_000, 7_000_000, 's', 'modelled', 'log');
    const logKnots = temperatureKnotsK(log, 0, 174_000)!;
    for (let step = 0; step <= 100; step++) {
      const regionT = step / 100;
      const radiusKm = 174_000 * (1 - regionT);
      const fromKnots = knotsTemperatureK(logKnots, true, regionT);
      const fromRamp = sampleTemperatureK(log, radiusKm, 0, 174_000)!;
      expect(Math.abs(fromKnots - fromRamp) / fromRamp).toBeLessThan(1e-9);
    }
  });

  it('draw a chord of a profile between knots, honouring an interior extremum that falls on one', () => {
    // Seven intervals: a sample at 4/7 of the depth sits on a knot exactly.
    const peakRadiusKm = 1000 - (4 / 7) * 1000;
    const quantity = profile([[0, 2000], [peakRadiusKm, 2600], [1000, 1500]]);
    const knots = temperatureKnotsK(quantity, 0, 1000)!;
    expect(knots[4]).toBeCloseTo(2600, 9);
    expect(Math.max(...knots)).toBeCloseTo(2600, 9);
    // Between knots the chord is within the profile's own curvature: here the profile is
    // piecewise linear with its corner on a knot, so the chord IS the profile.
    for (let step = 0; step <= 50; step++) {
      const regionT = step / 50;
      const radiusKm = 1000 * (1 - regionT);
      expect(knotsTemperatureK(knots, false, regionT)).toBeCloseTo(sampleTemperatureK(quantity, radiusKm, 0, 1000)!, 9);
    }
    // A corner between knots is cut by the chord, never overshot.
    const between = profile([[0, 2000], [1000 - 0.5 * (1000 / 7), 2600], [1000, 1500]]);
    const cut = temperatureKnotsK(between, 0, 1000)!;
    expect(Math.max(...cut)).toBeLessThan(2600);
    expect(Math.max(...cut)).toBeGreaterThan(2000);
  });

  it('read the same depth fraction in display space as in physical space, whatever the Readable remap did', () => {
    // The shader samples by depth fraction within a region in DISPLAY space; the remap is
    // linear within a region, so that fraction is the physical one — plan F22's normalised-depth
    // formulation, pinned here against the remap itself.
    const earth = drawnFromModel(EARTH_MODEL);
    const fractions = outerFractionsInsideOut(earth);
    const remap = readableRemap(fractions, 0.08, 1);
    earth.regionsInsideOut.forEach((region, index) => {
      const outerDisplay = toDisplayFraction(remap, fractions[index]);
      const innerDisplay = index > 0 ? toDisplayFraction(remap, fractions[index - 1]) : 0;
      for (const regionT of [0, 0.2, 0.5, 0.8, 1]) {
        const display = outerDisplay - regionT * (outerDisplay - innerDisplay);
        const physicalKm = toPhysicalFraction(remap, display) * earth.referenceRadiusKm;
        const expectedKm = region.outerRadiusKm - regionT * (region.outerRadiusKm - region.innerRadiusKm);
        expect(physicalKm).toBeCloseTo(expectedKm, 6);
      }
    });
  });

  it('cover every shipped region of the Earth and the Sun', () => {
    for (const model of [EARTH_MODEL, SUN_MODEL]) {
      const drawn = drawnFromModel(model);
      for (const region of drawn.regionsInsideOut) {
        const knots = temperatureKnotsK(region.region!.temperatureK, region.innerRadiusKm, region.outerRadiusKm)!;
        expect(knots).toHaveLength(TEMPERATURE_KNOTS);
        // Hotter inward within every region, as the validator requires of the models.
        for (let index = 1; index < knots.length; index++) expect(knots[index]).toBeGreaterThanOrEqual(knots[index - 1]);
        expect(region.temperatureK).toBeCloseTo(knotsTemperatureK(knots, temperatureLog(region.region!.temperatureK), 0.5), 6);
      }
    }
  });
});
