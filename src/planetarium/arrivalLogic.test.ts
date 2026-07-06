import { describe, expect, it } from 'vitest';
import {
  governedSpeedCap,
  MOON_APPROACH_K_PER_S,
  MOON_APPROACH_V_MIN_AU_S,
} from './arrivalLogic';

const K = MOON_APPROACH_K_PER_S;
const VMIN = MOON_APPROACH_V_MIN_AU_S;

describe('governedSpeedCap', () => {
  it('head-on approach is capped at K × surface distance', () => {
    expect(governedSpeedCap(1e-4, 1, K, VMIN)).toBeCloseTo(1e-4 * K, 12);
  });

  it('the floor keeps a creep speed available at the surface', () => {
    expect(governedSpeedCap(0, 1, K, VMIN)).toBe(VMIN);
    expect(governedSpeedCap(1e-9, 1, K, VMIN)).toBe(VMIN);
  });

  it('receding or side-on flight is uncapped', () => {
    expect(governedSpeedCap(1e-4, 0, K, VMIN)).toBe(Infinity);
    expect(governedSpeedCap(1e-4, -1, K, VMIN)).toBe(Infinity);
  });

  it('the grazing band releases smoothly: half-smoothstep doubles the cap', () => {
    const full = governedSpeedCap(1e-4, 0.3, K, VMIN);
    expect(governedSpeedCap(1e-4, 0.15, K, VMIN)).toBeCloseTo(full * 2, 10);
    // Continuity toward the free side: a whisker of closing cosine allows
    // a huge (but finite) cap, never a jump from capped to free.
    expect(governedSpeedCap(1e-4, 0.005, K, VMIN)).toBeGreaterThan(full * 100);
    expect(governedSpeedCap(1e-4, 0.005, K, VMIN)).toBeLessThan(Infinity);
  });

  it('beyond the band the cap is exactly the base — no over-tightening', () => {
    expect(governedSpeedCap(2e-4, 0.9, K, VMIN)).toBeCloseTo(2e-4 * K, 12);
  });

  it('closer means slower, monotonically', () => {
    let prev = Infinity;
    for (const d of [1e-3, 1e-4, 1e-5, 1e-6]) {
      const cap = governedSpeedCap(d, 1, K, VMIN);
      expect(cap).toBeLessThan(prev);
      prev = cap;
    }
  });
});
