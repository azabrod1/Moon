import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { computeNearFar, horizonDistance, toCameraRelative, MOON_RADIUS_M } from './frames';

const R = MOON_RADIUS_M;

describe('horizonDistance', () => {
  it('matches the TECH anchors', () => {
    // Horizon from a 450 km eye ≈ 1,329 km.
    expect(horizonDistance(450_000, R) / 1000).toBeCloseTo(1329, 0);
    // A 4,500 m relief peak is visible from ≈ 125 km at ground level.
    expect(horizonDistance(4_500, R) / 1000).toBeCloseTo(125, 0);
  });
});

describe('computeNearFar', () => {
  it('pins near across the descent extremes', () => {
    expect(computeNearFar(450_000, 4_500, R).near).toBe(150); // alt/3000
    expect(computeNearFar(2, 4_500, R).near).toBe(0.4); // floored
    expect(computeNearFar(2_000, 4_500, R).near).toBeCloseTo(0.667, 3);
  });

  it('far includes the relief term, not just the smooth-sphere limb', () => {
    const withRelief = computeNearFar(2, 4_500, R).far;
    const noRelief = computeNearFar(2, 0, R).far;
    // The 4.5 km relief adds ~125 km of visible reach.
    expect(withRelief - noRelief).toBeCloseTo(horizonDistance(4_500, R) * 1.05, 0);
    expect(withRelief).toBeGreaterThan(horizonDistance(4_500, R));
  });
});

describe('toCameraRelative', () => {
  it('returns exact small deltas for selenocentric-magnitude positions', () => {
    const out = new THREE.Vector3();
    const pos = { x: R + 0.05, y: 0, z: 0 };
    const cam = { x: R, y: 0, z: 0 };
    toCameraRelative(pos, cam, out);
    expect(out.x).toBeCloseTo(0.05, 6);
    expect(out.y).toBe(0);
    expect(out.z).toBe(0);
  });

  it('proves the mechanism: float32 absolute coords would quantize the 0.05 m away', () => {
    // Baking both positions into float32 first (the naive absolute path) loses the
    // 0.05 m delta entirely — float32 ULP at 1.7e6 m is 0.125 m.
    expect(Math.fround(R + 0.05) - Math.fround(R)).toBe(0);
    // The f64 subtraction keeps it.
    expect((R + 0.05) - R).toBeCloseTo(0.05, 6);
  });
});
