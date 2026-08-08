import { describe, expect, it } from 'vitest';
import {
  SHIP_SUN_DISC_SAMPLE_COUNT,
  SHIP_SUN_DISC_SAMPLES,
  shipHullMayOverlapSource,
  unblockedShipSunFraction,
} from './shipSunOcclusion';

describe('SHIP_SUN_DISC_SAMPLES', () => {
  it('pins the centre and distributes every equal-weight sample inside the source disc', () => {
    expect(SHIP_SUN_DISC_SAMPLES).toHaveLength(SHIP_SUN_DISC_SAMPLE_COUNT);
    expect(SHIP_SUN_DISC_SAMPLE_COUNT).toBe(37);
    expect(SHIP_SUN_DISC_SAMPLES[0]).toEqual({ x: 0, y: 0 });
    for (const sample of SHIP_SUN_DISC_SAMPLES) {
      expect(sample.x * sample.x + sample.y * sample.y).toBeLessThanOrEqual(1 + 1e-12);
    }
  });
});

describe('shipHullMayOverlapSource', () => {
  it('rejects a source cone that clears the conservative hull sphere', () => {
    expect(shipHullMayOverlapSource(10, 1, Math.cos(0.3), 0.02)).toBe(false);
  });

  it('keeps a grazing source cone for exact hull sampling', () => {
    const hullAngle = Math.asin(0.1);
    expect(shipHullMayOverlapSource(10, 1, Math.cos(hullAngle + 0.019), 0.02)).toBe(true);
  });

  it('always traverses while the camera is inside the conservative sphere', () => {
    expect(shipHullMayOverlapSource(0.9, 1, -1, 0)).toBe(true);
  });
});

describe('unblockedShipSunFraction', () => {
  it('reduces equal-weight samples and clamps defensive inputs', () => {
    expect(unblockedShipSunFraction(0, 37)).toBe(0);
    expect(unblockedShipSunFraction(7, 37)).toBeCloseTo(7 / 37, 12);
    expect(unblockedShipSunFraction(38, 37)).toBe(1);
    expect(unblockedShipSunFraction(-1, 37)).toBe(0);
    expect(unblockedShipSunFraction(0, 0)).toBe(1);
  });
});
