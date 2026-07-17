import { describe, expect, it } from 'vitest';
import {
  advanceSunEmergenceFlash,
  circleOcclusionFraction,
  eclipseOccluderLikeness,
  projectedSourceRadiusAtPlane,
  sunInteriorWhiteout,
  sunWhiteoutFraction,
  targetSunExposure,
} from './sunAppearance';

describe('circleOcclusionFraction', () => {
  it('handles clear, total, annular, and partial overlaps', () => {
    expect(circleOcclusionFraction(1, 1, 2)).toBe(0);
    expect(circleOcclusionFraction(1, 1.1, 0)).toBe(1);
    expect(circleOcclusionFraction(1, 0.5, 0)).toBeCloseTo(0.25, 12);
    expect(circleOcclusionFraction(1, 1, 1)).toBeCloseTo(0.3910022, 6);
  });
});

describe('targetSunExposure', () => {
  it('dims a centred zoomed Sun but leaves totality and off-screen views neutral', () => {
    expect(targetSunExposure({ projectedRadiusNdc: 0.175, centerDistanceNdc: 0, visibleFraction: 1 }))
      .toBeCloseTo(0.35, 2);
    expect(targetSunExposure({ projectedRadiusNdc: 0.175, centerDistanceNdc: 0, visibleFraction: 0 }))
      .toBe(1);
    expect(targetSunExposure({ projectedRadiusNdc: 0.175, centerDistanceNdc: 1.5, visibleFraction: 1 }))
      .toBe(1);
  });

  it('reacts gently to a small Sun in a normal cruise FOV', () => {
    const exposure = targetSunExposure({ projectedRadiusNdc: 0.0046, centerDistanceNdc: 0, visibleFraction: 1 });
    expect(exposure).toBeGreaterThan(0.85);
    expect(exposure).toBeLessThan(1);
  });

  it('stops down further only when the photosphere fills most of the frame', () => {
    expect(targetSunExposure({ projectedRadiusNdc: 0.95, centerDistanceNdc: 0, visibleFraction: 1 }))
      .toBeCloseTo(0.25, 8);
  });
});

describe('eclipseOccluderLikeness', () => {
  it('rejects annular geometry while accepting a Sun-sized totality occluder', () => {
    expect(eclipseOccluderLikeness(0.999)).toBe(0);
    expect(eclipseOccluderLikeness(1)).toBe(1);
    expect(eclipseOccluderLikeness(1.05)).toBe(1);
    expect(eclipseOccluderLikeness(3)).toBe(0);
  });
});

describe('projectedSourceRadiusAtPlane', () => {
  it('projects by camera-relative distance without diverging near the source', () => {
    expect(projectedSourceRadiusAtPlane(2, 10, 5)).toBe(1);
    expect(projectedSourceRadiusAtPlane(2, 10, 9)).toBeCloseTo(1.8, 12);
    expect(projectedSourceRadiusAtPlane(2, 10, 20)).toBe(2);
  });
});

describe('advanceSunEmergenceFlash', () => {
  it('fires on a fast reveal and decays without another visibility rise', () => {
    const fired = advanceSunEmergenceFlash({
      previousVisibleFraction: 0.1,
      visibleFraction: 0.6,
      flash: 0,
      dt: 1 / 60,
      eligible: true,
    });
    expect(fired).toBeGreaterThan(0.9);
    const decayed = advanceSunEmergenceFlash({
      previousVisibleFraction: 0.6,
      visibleFraction: 0.6,
      flash: fired,
      dt: 0.38,
      eligible: true,
    });
    expect(decayed).toBeCloseTo(fired / Math.E, 6);
  });

  it('does not fire when the Sun enters frame already visible', () => {
    expect(advanceSunEmergenceFlash({
      previousVisibleFraction: 1,
      visibleFraction: 1,
      flash: 0,
      dt: 1 / 60,
      eligible: false,
    })).toBe(0);
  });
});

describe('sunWhiteoutFraction', () => {
  it('leaves the granulation study range untouched and saturates the final approach', () => {
    expect(sunWhiteoutFraction(30)).toBe(0);
    expect(sunWhiteoutFraction(2.6)).toBe(0);
    expect(sunWhiteoutFraction(2.0)).toBeGreaterThan(0.2);
    expect(sunWhiteoutFraction(2.0)).toBeLessThan(0.55);
    // The 1.2-radii governor hover sits in near-total overwhelm...
    expect(sunWhiteoutFraction(1.2)).toBeGreaterThan(0.98);
    expect(sunWhiteoutFraction(1.2)).toBeLessThan(1);
    // ...and contact is pinned full white, continuous with the interior side.
    expect(sunWhiteoutFraction(1.12)).toBe(1);
    expect(sunWhiteoutFraction(1.0)).toBe(1);
    expect(sunWhiteoutFraction(0)).toBe(1);
    expect(sunWhiteoutFraction(-1)).toBe(1);
  });

  it('is monotonic across the bleach band', () => {
    let previous = sunWhiteoutFraction(2.8);
    for (let radii = 2.7; radii >= 1.05; radii -= 0.05) {
      const next = sunWhiteoutFraction(radii);
      expect(next).toBeGreaterThanOrEqual(previous);
      previous = next;
    }
  });
});

describe('sunInteriorWhiteout', () => {
  it('holds the crossing white and hands off to the ember dive with depth', () => {
    expect(sunInteriorWhiteout(1)).toBe(sunWhiteoutFraction(1)); // seamless crossing
    expect(sunInteriorWhiteout(0.95)).toBe(1);
    expect(sunInteriorWhiteout(0.7)).toBeGreaterThan(0.2);
    expect(sunInteriorWhiteout(0.7)).toBeLessThan(0.6);
    expect(sunInteriorWhiteout(0.55)).toBe(0);
    expect(sunInteriorWhiteout(0.2)).toBe(0);
  });
});
