import { describe, it, expect } from 'vitest';
import {
  CLOUD_DECK_DEPTH_BIAS_UNITS,
  NIGHT_SHELL_DEPTH_BIAS_UNITS,
  SHELL_DEPTH_BIAS_UNITS,
  nightSectorDepthBiasUnits,
} from './shellDepthBias';

// The bias exists to survive the cruise near plane, which is pinned to the
// SHIP and so stays at tens of kilometres however far away the body is. These
// pin the two things that make it work: that every rung is lifted off the
// globe, and that the rungs stay in the order the geometry says they are in.
describe('the thin-shell depth bias', () => {
  it('lifts every shell clear of the globe', () => {
    expect(SHELL_DEPTH_BIAS_UNITS).toBeGreaterThan(0);
    expect(NIGHT_SHELL_DEPTH_BIAS_UNITS).toBeGreaterThan(0);
    expect(CLOUD_DECK_DEPTH_BIAS_UNITS).toBeGreaterThan(0);
    for (const level of [0, 1, 2, 3]) {
      expect(nightSectorDepthBiasUnits(level), `level ${level}`).toBeGreaterThan(0);
    }
  });

  it('keeps the rungs in the order their radii put them in', () => {
    // Night lights at 6.4 km, deck at 10 km: the deck is in front, and a night
    // sector must beat the shell it replaces or it would draw twice as bright.
    for (const level of [0, 1, 2, 3]) {
      expect(nightSectorDepthBiasUnits(level), `level ${level}`)
        .toBeGreaterThan(NIGHT_SHELL_DEPTH_BIAS_UNITS);
      expect(CLOUD_DECK_DEPTH_BIAS_UNITS, `level ${level}`)
        .toBeGreaterThan(nightSectorDepthBiasUnits(level));
    }
  });

  it('steps one unit per sector level, finest nearest', () => {
    for (const level of [0, 1, 2, 3]) {
      expect(nightSectorDepthBiasUnits(level + 1) - nightSectorDepthBiasUnits(level)).toBe(1);
    }
  });

  // A units-only offset is constant in WINDOW depth, so the range it covers
  // shrinks with the buffer's own resolution — that is what makes one number
  // safe from low orbit to the far field. The sizing bar is the worst near
  // plane the cruise camera produces against the clearance it has to cover.
  it('covers the clearance the cruise near plane cannot resolve', () => {
    const DEPTH_UNIT = 1 / (2 ** 24 - 1);   // one 24-bit depth step, in window depth
    const worstNearKm = 2e-8 * 149597870.7; // CRUISE_NEAR_MIN_AU, ~3 km
    const deckClearanceKm = 10;
    for (const rangeKm of [50_000, 80_000, 150_000, 384_400]) {
      // Window-depth separation between the deck and the globe at this range.
      const separation = (worstNearKm * deckClearanceKm) / (rangeKm * rangeKm);
      const shortfallUnits = Math.max(0, DEPTH_UNIT - separation) / DEPTH_UNIT;
      expect(CLOUD_DECK_DEPTH_BIAS_UNITS, `${rangeKm} km`).toBeGreaterThan(shortfallUnits);
    }
  });
});
