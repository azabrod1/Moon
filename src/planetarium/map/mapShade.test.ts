import { describe, expect, it } from 'vitest';
import {
  MAP_SHADE_FLOOR,
  advanceMapShade,
  makeMapShadeState,
  mapShadeDim,
  resetMapShade,
} from './mapShade';
import { SHADE_SMOOTHING } from '../world/shadeSmoothing';

describe('mapShadeDim', () => {
  it('floors a fully eclipsed moon instead of taking it to black', () => {
    expect(mapShadeDim(0)).toBe(MAP_SHADE_FLOOR);
    expect(MAP_SHADE_FLOOR).toBeGreaterThan(0);
  });

  it('leaves a sunlit moon exactly as it draws', () => {
    expect(mapShadeDim(1)).toBe(1);
  });

  it('is monotone in the sun-visible fraction', () => {
    let prev = -Infinity;
    for (let f = 0; f <= 1.0001; f += 0.05) {
      const dim = mapShadeDim(f);
      expect(dim).toBeGreaterThan(prev);
      prev = dim;
    }
  });

  it('clamps input outside [0, 1]', () => {
    expect(mapShadeDim(-0.5)).toBe(MAP_SHADE_FLOOR);
    expect(mapShadeDim(1.5)).toBe(1);
  });
});

// The chart's two-phase seam: the geometry pass caches a TARGET (and is allowed
// to skip still frames), the render pass advances the APPLIED value every
// frame. These drive the two phases separately, the way the map does.
describe('the map-owned shading seam', () => {
  const FRAME_MS = 16;

  it('takes the target whole the first time a moon is shaded', () => {
    const state = makeMapShadeState();
    state.shadeTarget = 0; // phase 1: appeared already deep in the umbra
    expect(advanceMapShade(state, 1000)).toBe(MAP_SHADE_FLOOR);
    expect(state.shadeSmoothed).toBe(0);
  });

  it('snaps across a gap rather than fading in from a stale value', () => {
    const state = makeMapShadeState();
    state.shadeTarget = 0;
    advanceMapShade(state, 1000);
    // The system left the chart and came back a second later, now sunlit.
    state.shadeTarget = 1;
    expect(advanceMapShade(state, 1000 + SHADE_SMOOTHING.snapGapMs + 1)).toBe(1);
  });

  it('reaches a standing target with the geometry pass never running again', () => {
    // The freeze case: clock paused, camera still, so phase 1 runs ONCE. The
    // applied value must still walk the whole way down.
    const state = makeMapShadeState();
    state.shadeTarget = 1;
    advanceMapShade(state, 0);
    state.shadeTarget = 0; // the one geometry pass that saw the immersion
    let now = 0;
    for (let i = 0; i < 240; i++) {
      now += FRAME_MS;
      advanceMapShade(state, now);
    }
    expect(state.shadeSmoothed).toBe(0);
    expect(mapShadeDim(state.shadeSmoothed!)).toBe(MAP_SHADE_FLOOR);
    // Inside the limiter's own ramp time, not the whole loop.
    expect(now).toBeLessThanOrEqual((1000 / SHADE_SMOOTHING.maxRatePerSec) * 240);
  });

  it('ramps rather than cutting, and never overshoots', () => {
    const state = makeMapShadeState();
    state.shadeTarget = 1;
    advanceMapShade(state, 0);
    state.shadeTarget = 0;
    const first = advanceMapShade(state, FRAME_MS);
    expect(first).toBeLessThan(1);
    expect(first).toBeGreaterThan(MAP_SHADE_FLOOR);
    let now = FRAME_MS;
    let prev = first;
    for (let i = 0; i < 200; i++) {
      now += FRAME_MS;
      const dim = advanceMapShade(state, now);
      expect(dim).toBeLessThanOrEqual(prev);
      expect(dim).toBeGreaterThanOrEqual(MAP_SHADE_FLOOR);
      prev = dim;
    }
  });

  it('is idempotent once settled — repeated frames neither drift nor accumulate', () => {
    const state = makeMapShadeState();
    state.shadeTarget = 0.5;
    advanceMapShade(state, 100);
    let now = 100;
    const settled = advanceMapShade(state, now + FRAME_MS);
    for (let i = 0; i < 10; i++) {
      now += FRAME_MS;
      expect(advanceMapShade(state, now + FRAME_MS)).toBe(settled);
    }
    expect(state.shadeSmoothed).toBe(0.5);
  });

  it('forgets the applied value on reset so the next sight snaps', () => {
    const state = makeMapShadeState();
    state.shadeTarget = 0;
    advanceMapShade(state, 1000);
    resetMapShade(state);
    state.shadeTarget = 1;
    expect(advanceMapShade(state, 1000 + FRAME_MS)).toBe(1);
  });
});
