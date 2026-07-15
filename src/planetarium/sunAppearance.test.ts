import { describe, expect, it } from 'vitest';
import { circleOcclusionFraction, targetSunExposure } from './sunAppearance';

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
});
