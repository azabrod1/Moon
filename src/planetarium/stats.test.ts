import { describe, expect, it } from 'vitest';
import { computeStats, formatAU } from './stats';
import { LIGHT_SPEED_AU_PER_S } from './planets/planetData';
import { KM_PER_AU } from '../astronomy/constants';

/** Planet world positions, in the shape the mode's per-frame map has. */
const positions = (entries: Record<string, [number, number, number]>) =>
  new Map(Object.entries(entries).map(([name, [x, y, z]]) => [name, { x, y, z }]));

describe('computeStats', () => {
  it('reads Earth distance as one AU of light time and full solar intensity', () => {
    const stats = computeStats(1, 0, 0, 0, 0, 0, positions({}));
    expect(stats.distanceFromSunAU).toBe(1);
    // Sunlight takes 8m 19s to cross an AU.
    expect(stats.lightTravelTime).toBe('8m 19s');
    expect(stats.solarIntensityPct).toBeCloseTo(100, 9);
    // The equilibrium temperature at Earth's distance, albedo ~0.3.
    expect(stats.blackbodyTempK).toBeCloseTo(278.5, 9);
  });

  it('falls off as the inverse square, and drops the minutes under one', () => {
    const jupiter = computeStats(5.2, 0, 0, 0, 0, 0, positions({}));
    expect(jupiter.solarIntensityPct).toBeCloseTo(100 / (5.2 * 5.2), 9);
    expect(jupiter.blackbodyTempK).toBeCloseTo(278.5 / Math.sqrt(5.2), 9);

    const close = computeStats(0.01, 0, 0, 0, 0, 0, positions({}));
    expect(close.lightTravelTime).toMatch(/^\d+s$/);
  });

  it('holds finite numbers at the heliocentre instead of dividing by zero', () => {
    const stats = computeStats(0, 0, 0, 0, 0, 0, positions({}));
    expect(Number.isFinite(stats.solarIntensityPct)).toBe(true);
    expect(Number.isFinite(stats.blackbodyTempK)).toBe(true);
  });

  it('converts speed to c and to km/s from the one AU definition', () => {
    const stats = computeStats(1, 0, 0, LIGHT_SPEED_AU_PER_S * 2, 0, 0, positions({}));
    expect(stats.speedC).toBeCloseTo(2, 12);
    expect(stats.speedKmS).toBeCloseTo(LIGHT_SPEED_AU_PER_S * 2 * KM_PER_AU, 3);
  });

  it('picks the nearest planet by 3D distance, ignoring bodies with no position', () => {
    const stats = computeStats(1, 0, 0, 0, 0, 0, positions({
      Mars: [1, 0, 0.5],
      Jupiter: [1, 0, 0.2],
    }));
    expect(stats.nearestPlanet?.name).toBe('Jupiter');
    expect(stats.nearestPlanet?.distanceAU).toBeCloseTo(0.2, 12);
  });

  it('reports no nearest planet before any position is known', () => {
    expect(computeStats(1, 0, 0, 0, 0, 0, positions({})).nearestPlanet).toBeNull();
  });

  it('formats elapsed time as minutes and zero-padded seconds', () => {
    expect(computeStats(1, 0, 0, 0, 0, 0, positions({})).timeElapsed).toBe('0:00');
    expect(computeStats(1, 0, 0, 0, 0, 61.4, positions({})).timeElapsed).toBe('1:01');
    expect(computeStats(1, 0, 0, 0, 0, 3599, positions({})).timeElapsed).toBe('59:59');
  });
});

describe('formatAU', () => {
  it('keeps a close approach readable and a cruise distance short', () => {
    expect(formatAU(0.000123456)).toBe('0.00012');
    expect(formatAU(0.5)).toBe('0.500');
    expect(formatAU(39.482)).toBe('39.48');
  });
});
