import { describe, expect, it } from 'vitest';
import { DEG2RAD } from './angles';
import {
  LENS_PROXIMITY_FULL_DEG,
  LENS_PROXIMITY_OFF_DEG,
  lensProximityFactor,
  sphereAngularRadius,
} from './lensProximity';
import { ARRIVAL_IMPACT_RADII, SUN_APPROACH_SURFACE_RADII } from '../../planetarium/arrivalLogic';

describe('lensProximityFactor', () => {
  it('is exactly 1 at and below the full knee, exactly 0 at and above the off knee', () => {
    for (const angularRadiusDeg of [0, 5, 22, 33.7, 44.999, LENS_PROXIMITY_FULL_DEG]) {
      expect(lensProximityFactor(angularRadiusDeg * DEG2RAD)).toBe(1);
    }
    for (const angularRadiusDeg of [LENS_PROXIMITY_OFF_DEG, 75.9, 89, 90]) {
      expect(lensProximityFactor(angularRadiusDeg * DEG2RAD)).toBe(0);
    }
  });

  it('eases monotonically and continuously between the knees', () => {
    let previous = 1;
    for (let angularRadiusDeg = LENS_PROXIMITY_FULL_DEG; angularRadiusDeg <= LENS_PROXIMITY_OFF_DEG; angularRadiusDeg += 0.25) {
      const factor = lensProximityFactor(angularRadiusDeg * DEG2RAD);
      expect(factor).toBeLessThanOrEqual(previous);
      expect(factor).toBeGreaterThanOrEqual(0);
      previous = factor;
    }
    const step = 1e-6;
    expect(lensProximityFactor((LENS_PROXIMITY_FULL_DEG + step) * DEG2RAD)).toBeCloseTo(1, 9);
    expect(lensProximityFactor((LENS_PROXIMITY_OFF_DEG - step) * DEG2RAD)).toBeCloseTo(0, 9);
    const middle = (LENS_PROXIMITY_FULL_DEG + LENS_PROXIMITY_OFF_DEG) / 2;
    expect(lensProximityFactor(middle * DEG2RAD)).toBeCloseTo(0.5, 12);
  });

  it('never touches an authored flyby: closest approach sits under the full knee', () => {
    // Every arrival passes at ARRIVAL_IMPACT_RADII rendered radii, and the
    // floors only push a pass farther out. On the receding leg the body is
    // still this large and drifting off-axis — the case the lens exists for.
    const closestApproach = sphereAngularRadius(1, ARRIVAL_IMPACT_RADII);
    expect(closestApproach / DEG2RAD).toBeCloseTo(33.75, 1);
    expect(lensProximityFactor(closestApproach)).toBe(1);
    // With a margin, so a knee moved down toward it is heard.
    expect(LENS_PROXIMITY_FULL_DEG - closestApproach / DEG2RAD).toBeGreaterThan(10);
  });

  it('blends the Sun at its governed park from the photosphere, not the governed surface', () => {
    // The governor holds off at SUN_APPROACH_SURFACE_RADII photosphere radii;
    // the DISC is the photosphere, so the park sits mid-ramp. Measured against
    // the 1.2x governed surface it would read 90° and switch the lens fully
    // off — the two radius classes must never be mixed.
    const park = sphereAngularRadius(1, SUN_APPROACH_SURFACE_RADII);
    expect(park / DEG2RAD).toBeCloseTo(56.44, 1);
    expect(lensProximityFactor(park)).toBeCloseTo(0.563, 2);
    expect(lensProximityFactor(sphereAngularRadius(SUN_APPROACH_SURFACE_RADII, SUN_APPROACH_SURFACE_RADII))).toBe(0);
  });

  it('reads a non-finite or inside-the-sphere input safely', () => {
    expect(lensProximityFactor(Number.NaN)).toBe(1);
    expect(sphereAngularRadius(1, 0.5)).toBe(Math.PI / 2);
    expect(sphereAngularRadius(0, 5)).toBe(0);
    expect(sphereAngularRadius(1, 2) / DEG2RAD).toBeCloseTo(30, 9);
  });
});
