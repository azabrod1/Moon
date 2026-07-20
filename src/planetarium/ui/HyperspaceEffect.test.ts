import { describe, expect, it } from 'vitest';
import {
  HYPERSPACE_ACCEL_MS,
  HYPERSPACE_EXIT_MS,
  advanceHyperspaceDepth,
  hyperspaceMotion,
  projectedHyperspaceRadius,
} from './HyperspaceEffect';

describe('hyperspace motion', () => {
  it('accelerates stars into longer perspective streaks', () => {
    const start = hyperspaceMotion(0, null);
    const cruise = hyperspaceMotion(HYPERSPACE_ACCEL_MS, null);
    expect(cruise.speed).toBeGreaterThan(start.speed * 10);
    expect(cruise.trail).toBeGreaterThan(start.trail * 20);
    expect(cruise.tunnel).toBeGreaterThan(start.tunnel);
  });

  it('moves every star outward from the vanishing point as it approaches the viewer', () => {
    const beforeDepth = 1.1;
    const afterDepth = advanceHyperspaceDepth(beforeDepth, 1.4, 1 / 60);
    expect(afterDepth).toBeLessThan(beforeDepth);
    expect(projectedHyperspaceRadius(0.5, afterDepth)).toBeGreaterThan(
      projectedHyperspaceRadius(0.5, beforeDepth),
    );
  });

  it('decelerates and flashes around the exit midpoint', () => {
    const midpoint = hyperspaceMotion(0, HYPERSPACE_EXIT_MS / 2);
    const end = hyperspaceMotion(0, HYPERSPACE_EXIT_MS);
    expect(midpoint.flash).toBeCloseTo(1, 10);
    expect(end.speed).toBeLessThan(midpoint.speed);
    expect(end.trail).toBeLessThan(midpoint.trail);
    expect(end.flash).toBeCloseTo(0, 10);
  });
});
