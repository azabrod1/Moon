import { describe, it, expect } from 'vitest';
import { planetshineIntensity } from './planetshine';

describe('planetshineIntensity', () => {
  it('peaks when the parent is full from the moon (Sun opposite, cosPhase = -1)', () => {
    const full = planetshineIntensity(0.3, 4.26e-5, 2.57e-3, -1);
    const half = planetshineIntensity(0.3, 4.26e-5, 2.57e-3, 0);
    const none = planetshineIntensity(0.3, 4.26e-5, 2.57e-3, 1);
    expect(full).toBeGreaterThan(half);
    expect(half).toBeGreaterThan(none);
    expect(none).toBe(0); // new parent (cosPhase = +1): nothing reflected toward the moon
  });

  it('scales with albedo and apparent parent area, falls off as 1/dist^2', () => {
    const base = planetshineIntensity(0.3, 4.26e-5, 2.57e-3, -1);
    expect(planetshineIntensity(0.6, 4.26e-5, 2.57e-3, -1)).toBeCloseTo(base * 2, 12);
    // double the distance -> quarter the apparent area
    expect(planetshineIntensity(0.3, 4.26e-5, 5.14e-3, -1)).toBeCloseTo(base / 4, 12);
  });

  it('never goes negative for out-of-range phase', () => {
    expect(planetshineIntensity(0.3, 4.26e-5, 2.57e-3, 5)).toBe(0);
  });
});
