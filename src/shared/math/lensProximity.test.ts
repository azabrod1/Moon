import { describe, expect, it } from 'vitest';
import { DEG2RAD } from './angles';
import {
  LENS_PROXIMITY_DEFAULT_BAND,
  LENS_PROXIMITY_FULL_DEG,
  LENS_PROXIMITY_OFF_DEG,
  isLensRampBand,
  lensProximityFactor,
  sphereAngularRadius,
} from './lensProximity';
import { ARRIVAL_IMPACT_RADII, SUN_APPROACH_SURFACE_RADII } from '../../planetarium/arrivalLogic';
import { LANDED_FRAME_RADII, landedMinDistanceAU, landedNearAU } from '../../planetarium/landedView';

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

  it('never enters the ramp in the landed orbit view: touchdown is not a lens change', () => {
    // Landing re-frames the body from LANDED_FRAME_RADII (the camera ends up
    // 1.5x that out), and the orbit camera may zoom no closer than
    // landedMinDistanceAU. Both sit under the full knee, so the landed branch's
    // forced 1 and the ramp's own law agree at every landed pose — the lens
    // changes on entering the observatory, a deliberate change of activity,
    // never on touching the ground. A knee lowered under 41.8° breaks this.
    const earthRadiusAU = 6371 / 149_597_870.7;
    const moonletRadiusAU = 11 / 149_597_870.7;
    for (const radiusAU of [earthRadiusAU, moonletRadiusAU]) {
      const framed = sphereAngularRadius(radiusAU, radiusAU * LANDED_FRAME_RADII * 1.5);
      expect(lensProximityFactor(framed)).toBe(1);
      const closest = sphereAngularRadius(radiusAU, landedMinDistanceAU(radiusAU, landedNearAU(radiusAU)));
      expect(closest / DEG2RAD).toBeLessThan(LENS_PROXIMITY_FULL_DEG);
      expect(lensProximityFactor(closest)).toBe(1);
    }
    expect(sphereAngularRadius(1, 1.5) / DEG2RAD).toBeCloseTo(41.81, 1);
  });

  it('blends the Sun at its governed park from the photosphere, not the governed surface', () => {
    // The governor holds off at SUN_APPROACH_SURFACE_RADII photosphere radii;
    // the DISC is the photosphere, 56.4° from the park. Measured against the
    // 1.2x governed surface it would read 90° — the two radius classes must
    // never be mixed. They part most where the park sits mid-ramp, which it
    // did under the first band, 45/70: 0.563 against 0.
    const firstBand = { fullDeg: 45, offDeg: 70 };
    const park = sphereAngularRadius(1, SUN_APPROACH_SURFACE_RADII);
    expect(park / DEG2RAD).toBeCloseTo(56.44, 1);
    expect(lensProximityFactor(park, firstBand)).toBeCloseTo(0.563, 2);
    expect(lensProximityFactor(sphereAngularRadius(SUN_APPROACH_SURFACE_RADII, SUN_APPROACH_SURFACE_RADII), firstBand)).toBe(0);
    // Under the default band the park keeps 0.04 of the lens: nearly a pinhole.
    expect(lensProximityFactor(park)).toBeCloseTo(0.04, 2);
  });

  it('reads a non-finite or inside-the-sphere input safely', () => {
    // Non-finite reads as far away — every sign of it; an infinite angular
    // radius is nonsense, and the safe answer is the lens as it was.
    expect(lensProximityFactor(Number.NaN)).toBe(1);
    expect(lensProximityFactor(Number.POSITIVE_INFINITY)).toBe(1);
    expect(lensProximityFactor(Number.NEGATIVE_INFINITY)).toBe(1);
    expect(sphereAngularRadius(1, 0.5)).toBe(Math.PI / 2);
    expect(sphereAngularRadius(0, 5)).toBe(0);
    // A NaN distance is not "inside the sphere": it reads as no disc, never a pinhole.
    expect(sphereAngularRadius(1, Number.NaN)).toBe(0);
    expect(sphereAngularRadius(1, Number.POSITIVE_INFINITY)).toBe(0);
    expect(sphereAngularRadius(1, 2) / DEG2RAD).toBeCloseTo(30, 9);
  });
});

describe('the band', () => {
  const KM = 1 / 149_597_870.7;
  const MOON_R = 1737.4 * KM;
  const CLEARANCE = (1737.4 / 64) * 1.5 * KM; // SHIP_CLEARANCE_AU, written out so this file stays off cruiseView
  const BOOM = 232.8 * KM;

  it('a band moves both knees and nothing else; the default band is the module constants', () => {
    expect(LENS_PROXIMITY_DEFAULT_BAND).toEqual({ fullDeg: LENS_PROXIMITY_FULL_DEG, offDeg: LENS_PROXIMITY_OFF_DEG });
    const band = { fullDeg: 45, offDeg: 70 };
    expect(lensProximityFactor(45 * DEG2RAD, band)).toBe(1);
    expect(lensProximityFactor(70 * DEG2RAD, band)).toBe(0);
    expect(lensProximityFactor(57.5 * DEG2RAD, band)).toBeCloseTo(0.5, 12);
    expect(lensProximityFactor(51.5 * DEG2RAD)).toBeCloseTo(lensProximityFactor(51.5 * DEG2RAD, LENS_PROXIMITY_DEFAULT_BAND), 12);
  });

  it("the ship-plus-boom driver reaches a pinhole at the Moon's clearance shell, where the first band, 45/70, kept a third of the lens", () => {
    const shipPlusBoom = sphereAngularRadius(MOON_R, MOON_R + CLEARANCE + BOOM);
    expect(shipPlusBoom / DEG2RAD).toBeCloseTo(59.8, 0);
    expect(LENS_PROXIMITY_DEFAULT_BAND).toEqual({ fullDeg: 45, offDeg: 58 });
    expect(lensProximityFactor(shipPlusBoom)).toBe(0);
    expect(lensProximityFactor(shipPlusBoom, { fullDeg: 45, offDeg: 70 })).toBeGreaterThan(0.3);
  });

  it('refuses a band it cannot use', () => {
    expect(isLensRampBand(LENS_PROXIMITY_DEFAULT_BAND)).toBe(true);
    expect(isLensRampBand({ fullDeg: 45, offDeg: 70 })).toBe(true);
    expect(isLensRampBand({ fullDeg: 40, offDeg: 90 })).toBe(true);
    for (const [fullDeg, offDeg] of [[58, 45], [45, 45], [45, 91], [0, 50], [Number.NaN, 50], [45, Number.POSITIVE_INFINITY]]) {
      expect(isLensRampBand({ fullDeg, offDeg }), `${fullDeg},${offDeg}`).toBe(false);
    }
  });
});
