import { describe, expect, it } from 'vitest';
import {
  STAR_TREK_WARP_ACCEL_MS,
  STAR_TREK_WARP_EXIT_MS,
  advanceStarTrekWarpX,
  starTrekWarpMotion,
} from './StarTrekWarpEffect';

describe('Star Trek warp motion', () => {
  it('accelerates points into clean slit-scan streaks', () => {
    const start = starTrekWarpMotion(0, null);
    const cruise = starTrekWarpMotion(STAR_TREK_WARP_ACCEL_MS, null);
    expect(cruise.speed).toBeGreaterThan(start.speed * 20);
    expect(cruise.trail).toBeGreaterThan(start.trail * 40);
    expect(cruise.chroma).toBeGreaterThan(start.chroma);
  });

  it('moves stars laterally with depth parallax instead of a radial tunnel', () => {
    const near = advanceStarTrekWarpX(0.8, 1, 1, 1 / 60);
    const far = advanceStarTrekWarpX(0.8, 1, 0.1, 1 / 60);
    expect(near).toBeLessThan(far);
    expect(far).toBeLessThan(0.8);
  });

  it('returns streaks to point stars during exit', () => {
    const midpoint = starTrekWarpMotion(0, STAR_TREK_WARP_EXIT_MS / 2);
    const end = starTrekWarpMotion(0, STAR_TREK_WARP_EXIT_MS);
    expect(midpoint.flare).toBeGreaterThan(0);
    expect(end.speed).toBeLessThan(midpoint.speed);
    expect(end.trail).toBeLessThan(midpoint.trail);
    expect(end.flare).toBeCloseTo(0, 10);
  });
});
