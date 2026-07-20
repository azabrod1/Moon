import { describe, expect, it } from 'vitest';
import {
  STAR_TREK_WARP_ACCEL_MS,
  STAR_TREK_WARP_EXIT_MS,
  advanceStarTrekWarpPoint,
  screenSpaceWarpDirection,
  starTrekWarpMotion,
  upstreamWarpSpawn,
} from './StarTrekWarpEffect';

describe('Star Trek warp motion', () => {
  it('accelerates points into clean slit-scan streaks', () => {
    const start = starTrekWarpMotion(0, null);
    const cruise = starTrekWarpMotion(STAR_TREK_WARP_ACCEL_MS, null);
    expect(cruise.speed).toBeGreaterThan(start.speed * 20);
    expect(cruise.trail).toBeGreaterThan(start.trail * 40);
    expect(cruise.chroma).toBeGreaterThan(start.chroma);
  });

  it('moves stars opposite an arbitrary projected ship heading', () => {
    const direction = screenSpaceWarpDirection({ x: 10, y: 10 }, { x: 13, y: 14 });
    const next = advanceStarTrekWarpPoint(80, 60, direction, 120, 1, 1 / 60);
    expect(direction.x).toBeCloseTo(0.6);
    expect(direction.y).toBeCloseTo(0.8);
    expect(next.x).toBeLessThan(80);
    expect(next.y).toBeLessThan(60);
  });

  it('keeps depth parallax along the projected heading', () => {
    const direction = { x: 0, y: -1 };
    const near = advanceStarTrekWarpPoint(80, 60, direction, 120, 1, 1 / 60);
    const far = advanceStarTrekWarpPoint(80, 60, direction, 120, 0.1, 1 / 60);
    expect(near.x).toBe(80);
    expect(far.x).toBe(80);
    expect(near.y).toBeGreaterThan(far.y);
    expect(far.y).toBeGreaterThan(60);
  });

  it('uses screen-up when the ship points directly through the camera axis', () => {
    expect(screenSpaceWarpDirection({ x: 20, y: 30 }, { x: 20, y: 30 })).toEqual({ x: 0, y: -1 });
  });

  it('respawns vertical and horizontal fields on a visible upstream edge', () => {
    expect(upstreamWarpSpawn({ x: 0, y: -1 }, 0.5, 0.35, 0.1)).toEqual({ x: 0.35, y: -0.1 });
    expect(upstreamWarpSpawn({ x: 1, y: 0 }, 0.5, 0.65, 0.1)).toEqual({ x: 1.1, y: 0.65 });
  });

  it('distributes diagonal respawns according to the heading components', () => {
    expect(upstreamWarpSpawn({ x: 0.75, y: -0.25 }, 0.2, 0.4, 0.08)).toEqual({ x: 1.08, y: 0.4 });
    expect(upstreamWarpSpawn({ x: 0.75, y: -0.25 }, 0.95, 0.4, 0.08)).toEqual({ x: 0.4, y: -0.08 });
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
