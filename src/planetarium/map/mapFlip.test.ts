import { describe, it, expect } from 'vitest';
import {
  makeMapFlipState,
  mapFlipAdvance,
  mapFlipBegin,
  mapFlipElevationRad,
  mapFlipOffset,
  mapFlipReverse,
  mapFlipSettle,
  mirrorMapOffset,
  MAP_FLIP_MS,
  type MapFlipVec,
} from './mapFlip';
import { MAP_POLAR_MAX_RAD, MAP_POLAR_MIN_RAD, mapPolarBand } from './mapCamera';

const vec = (x: number, y: number, z: number): MapFlipVec => ({ x, y, z });
const len = (v: MapFlipVec): number => Math.hypot(v.x, v.y, v.z);
/** Polar angle from north — the quantity OrbitControls clamps. */
const polar = (v: MapFlipVec): number => Math.atan2(Math.hypot(v.x, v.z), v.y);

/** A 3/4 overhead pose like the chart's own fit: up and out. */
const OVERHEAD = vec(0.42, 1.9, 0.77);

describe('mirrorMapOffset', () => {
  it('negates the signed height and leaves the bearing alone', () => {
    const out = mirrorMapOffset(OVERHEAD, vec(0, 0, 0));
    expect(out.x).toBe(OVERHEAD.x);
    expect(out.z).toBe(OVERHEAD.z);
    expect(out.y).toBe(-OVERHEAD.y);
  });

  it('preserves distance from the pivot', () => {
    const out = mirrorMapOffset(OVERHEAD, vec(0, 0, 0));
    expect(len(out)).toBeCloseTo(len(OVERHEAD), 12);
  });

  it('sends the polar angle to its supplement', () => {
    const out = mirrorMapOffset(OVERHEAD, vec(0, 0, 0));
    expect(polar(out)).toBeCloseTo(Math.PI - polar(OVERHEAD), 12);
  });

  it('is its own inverse', () => {
    const once = mirrorMapOffset(OVERHEAD, vec(0, 0, 0));
    const twice = mirrorMapOffset(once, vec(0, 0, 0));
    expect(twice.x).toBe(OVERHEAD.x);
    expect(twice.y).toBe(OVERHEAD.y);
    expect(twice.z).toBe(OVERHEAD.z);
  });

  it('writes in place safely', () => {
    const v = vec(1, 2, 3);
    mirrorMapOffset(v, v);
    expect([v.x, v.y, v.z]).toEqual([1, -2, 3]);
  });
});

describe('mapFlipBegin', () => {
  it('refuses an offset with no length — nothing to mirror', () => {
    const state = makeMapFlipState();
    expect(mapFlipBegin(state, vec(0, 0, 0), 1, 0)).toBe(false);
    expect(state.running).toBe(false);
  });

  it('captures the radius, the bearing and the signed elevation', () => {
    const state = makeMapFlipState();
    expect(mapFlipBegin(state, OVERHEAD, 1, 0)).toBe(true);
    expect(state.radiusAU).toBeCloseTo(len(OVERHEAD), 12);
    const horizontal = Math.hypot(OVERHEAD.x, OVERHEAD.z);
    expect(state.azX).toBeCloseTo(OVERHEAD.x / horizontal, 12);
    expect(state.azZ).toBeCloseTo(OVERHEAD.z / horizontal, 12);
    expect(state.fromElevRad).toBeCloseTo(Math.PI / 2 - polar(OVERHEAD), 12);
    expect(state.toElevRad).toBeCloseTo(-state.fromElevRad, 12);
  });

  it('takes the bearing from the hint when the camera looks straight down the pole', () => {
    const state = makeMapFlipState();
    expect(mapFlipBegin(state, vec(0, 2, 0), 0, -3)).toBe(true);
    expect(state.azX).toBeCloseTo(0, 12);
    expect(state.azZ).toBeCloseTo(-1, 12);
    // And the crossing still runs: the pole's own elevation is a right angle.
    expect(state.fromElevRad).toBeCloseTo(Math.PI / 2, 12);
  });

  it('falls back to +X for a degenerate hint rather than stalling', () => {
    const state = makeMapFlipState();
    expect(mapFlipBegin(state, vec(0, 2, 0), 0, 0)).toBe(true);
    expect(state.azX).toBe(1);
    expect(state.azZ).toBe(0);
  });
});

describe('the crossing', () => {
  it('starts on the pose it was handed and ends on its mirror', () => {
    const state = makeMapFlipState();
    mapFlipBegin(state, OVERHEAD, 1, 0);
    const out = vec(0, 0, 0);
    mapFlipOffset(state, out);
    expect(out.x).toBeCloseTo(OVERHEAD.x, 12);
    expect(out.y).toBeCloseTo(OVERHEAD.y, 12);
    expect(out.z).toBeCloseTo(OVERHEAD.z, 12);

    expect(mapFlipAdvance(state, MAP_FLIP_MS)).toBe(true);
    mapFlipOffset(state, out);
    const mirrored = mirrorMapOffset(OVERHEAD, vec(0, 0, 0));
    expect(out.x).toBeCloseTo(mirrored.x, 12);
    expect(out.y).toBeCloseTo(mirrored.y, 12);
    expect(out.z).toBeCloseTo(mirrored.z, 12);
  });

  it('holds the radius and the bearing at every step in between', () => {
    const state = makeMapFlipState();
    mapFlipBegin(state, OVERHEAD, 1, 0);
    const radius = len(OVERHEAD);
    const bearing = Math.atan2(OVERHEAD.z, OVERHEAD.x);
    const out = vec(0, 0, 0);
    for (let i = 0; i <= 20; i++) {
      state.elapsedMs = (MAP_FLIP_MS * i) / 20;
      mapFlipOffset(state, out);
      expect(len(out)).toBeCloseTo(radius, 10);
      // Straight overhead has no bearing to check; every other step does.
      expect(Math.atan2(out.z, out.x)).toBeCloseTo(bearing, 10);
    }
  });

  it('never passes through the pivot — the straight lerp would', () => {
    const state = makeMapFlipState();
    mapFlipBegin(state, OVERHEAD, 1, 0);
    const radius = len(OVERHEAD);
    const out = vec(0, 0, 0);
    let closest = Infinity;
    for (let i = 0; i <= 40; i++) {
      state.elapsedMs = (MAP_FLIP_MS * i) / 40;
      mapFlipOffset(state, out);
      closest = Math.min(closest, len(out));
    }
    expect(closest).toBeCloseTo(radius, 10);
  });

  it('crosses the plane exactly once, and its ease starts and ends at rest', () => {
    const state = makeMapFlipState();
    mapFlipBegin(state, OVERHEAD, 1, 0);
    // Strictly descending, so the sign changes once and never comes back.
    let previous = mapFlipElevationRad(state);
    expect(previous).toBeGreaterThan(0);
    for (let i = 1; i <= 40; i++) {
      state.elapsedMs = (MAP_FLIP_MS * i) / 40;
      const elevation = mapFlipElevationRad(state);
      expect(elevation).toBeLessThan(previous);
      previous = elevation;
    }
    expect(previous).toBeLessThan(0);
    // Smoothstep: the first and last steps move far less than the middle one.
    const step = (from: number, to: number): number => {
      state.elapsedMs = from;
      const a = mapFlipElevationRad(state);
      state.elapsedMs = to;
      return Math.abs(mapFlipElevationRad(state) - a);
    };
    const first = step(0, MAP_FLIP_MS / 40);
    const middle = step(MAP_FLIP_MS * 0.475, MAP_FLIP_MS * 0.525);
    const last = step(MAP_FLIP_MS * 39 / 40, MAP_FLIP_MS);
    expect(first).toBeLessThan(middle);
    expect(last).toBeLessThan(middle);
  });

  it('lands only when the clock runs out', () => {
    const state = makeMapFlipState();
    mapFlipBegin(state, OVERHEAD, 1, 0);
    expect(mapFlipAdvance(state, MAP_FLIP_MS / 2)).toBe(false);
    expect(state.running).toBe(true);
    expect(mapFlipAdvance(state, MAP_FLIP_MS / 2)).toBe(true);
    expect(state.running).toBe(false);
    // A frame longer than the whole crossing lands it, and no further.
    const long = makeMapFlipState();
    mapFlipBegin(long, OVERHEAD, 1, 0);
    expect(mapFlipAdvance(long, MAP_FLIP_MS * 10)).toBe(true);
    expect(long.elapsedMs).toBe(MAP_FLIP_MS);
  });

  it('settles onto the far side', () => {
    const state = makeMapFlipState();
    mapFlipBegin(state, OVERHEAD, 1, 0);
    mapFlipAdvance(state, MAP_FLIP_MS * 0.3);
    mapFlipSettle(state);
    expect(state.running).toBe(false);
    expect(mapFlipElevationRad(state)).toBeCloseTo(-state.fromElevRad, 12);
  });
});

describe('the second press', () => {
  it('returns to the pose the crossing began at', () => {
    const state = makeMapFlipState();
    mapFlipBegin(state, OVERHEAD, 1, 0);
    mapFlipAdvance(state, MAP_FLIP_MS * 0.4);
    const midway = mapFlipElevationRad(state);
    mapFlipReverse(state);
    // No jump at the turn: it starts from the pose standing right now.
    expect(mapFlipElevationRad(state)).toBeCloseTo(midway, 12);
    expect(mapFlipAdvance(state, MAP_FLIP_MS)).toBe(true);
    const out = vec(0, 0, 0);
    mapFlipOffset(state, out);
    expect(out.x).toBeCloseTo(OVERHEAD.x, 10);
    expect(out.y).toBeCloseTo(OVERHEAD.y, 10);
    expect(out.z).toBeCloseTo(OVERHEAD.z, 10);
  });

  it('lands inside the band it came from — a live mirror would not', () => {
    // Sampled mid-pose: a shallow view, five degrees above the plane, which is
    // inside the crossing but inside NEITHER hemisphere's legal band.
    const state = makeMapFlipState();
    mapFlipBegin(state, OVERHEAD, 1, 0);
    while (Math.abs(mapFlipElevationRad(state)) > (5 * Math.PI) / 180) {
      state.elapsedMs += 1;
    }
    const shallow = mapFlipElevationRad(state);
    expect(Math.PI / 2 - Math.abs(shallow)).toBeGreaterThan(MAP_POLAR_MAX_RAD);

    mapFlipReverse(state);
    mapFlipAdvance(state, MAP_FLIP_MS);
    const landed = Math.PI / 2 - mapFlipElevationRad(state);
    const above = mapPolarBand('above');
    expect(landed).toBeGreaterThanOrEqual(above.min);
    expect(landed).toBeLessThanOrEqual(above.max);
  });

  it('turns around again on a third press', () => {
    const state = makeMapFlipState();
    mapFlipBegin(state, OVERHEAD, 1, 0);
    const goal = state.toElevRad;
    mapFlipAdvance(state, MAP_FLIP_MS * 0.5);
    mapFlipReverse(state);
    mapFlipAdvance(state, MAP_FLIP_MS * 0.2);
    mapFlipReverse(state);
    mapFlipAdvance(state, MAP_FLIP_MS);
    // Back on course for the far side.
    expect(mapFlipElevationRad(state)).toBeCloseTo(goal, 10);
  });

  it('does nothing to a settled crossing', () => {
    const state = makeMapFlipState();
    mapFlipBegin(state, OVERHEAD, 1, 0);
    mapFlipAdvance(state, MAP_FLIP_MS);
    const landed = mapFlipElevationRad(state);
    mapFlipReverse(state);
    expect(mapFlipElevationRad(state)).toBeCloseTo(landed, 12);
  });
});

describe('mapPolarBand', () => {
  it('mirrors the band and leaves no overlap between the two', () => {
    const above = mapPolarBand('above');
    const below = mapPolarBand('below');
    expect(above.min).toBe(MAP_POLAR_MIN_RAD);
    expect(above.max).toBe(MAP_POLAR_MAX_RAD);
    expect(below.min).toBeCloseTo(Math.PI - MAP_POLAR_MAX_RAD, 12);
    expect(below.max).toBeCloseTo(Math.PI - MAP_POLAR_MIN_RAD, 12);
    expect(above.max).toBeLessThan(below.min);
  });

  it('sends every legal pose in one band to a legal pose in the other', () => {
    const above = mapPolarBand('above');
    const below = mapPolarBand('below');
    for (let i = 0; i <= 10; i++) {
      const theta = above.min + ((above.max - above.min) * i) / 10;
      const source = vec(Math.sin(theta) * 1.4, Math.cos(theta) * 1.4, 0);
      const mirrored = mirrorMapOffset(source, vec(0, 0, 0));
      expect(polar(mirrored)).toBeGreaterThanOrEqual(below.min - 1e-12);
      expect(polar(mirrored)).toBeLessThanOrEqual(below.max + 1e-12);
    }
  });

  it('fills the scratch it is handed rather than allocating', () => {
    const out = { min: 0, max: 0 };
    expect(mapPolarBand('below', out)).toBe(out);
  });
});
