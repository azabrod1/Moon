import { describe, it, expect } from 'vitest';
import { mapBodyDrawMode, shouldAdoptTexture, TRUE_SCALE_GLOBE_MIN_PX } from './mapGlobes';

describe('mapBodyDrawMode', () => {
  // Overview framing: every body's real disc is far below its chart marker.
  const FAR = { truePx: 0.001, markerPx: 16 };
  // Focus framing: the camera has closed in until the real disc dominates.
  const CLOSE = { truePx: 63, markerPx: 16 };

  it('draws a globe only with a loaded texture on the compressed chart', () => {
    expect(mapBodyDrawMode(true, false, FAR.truePx, FAR.markerPx)).toBe('globe');
  });

  it('falls back to the dot while the world texture is still loading', () => {
    expect(mapBodyDrawMode(false, false, FAR.truePx, FAR.markerPx)).toBe('dot');
    expect(mapBodyDrawMode(false, true, CLOSE.truePx, CLOSE.markerPx)).toBe('dot');
  });

  it('draws the globe at true scale once the marker can carry a face', () => {
    // The drawn size is floored at the marker either way, so a body-sized mark
    // that painted as an abstract dot read as an unloaded body. A planet's
    // marker (here 16 px) is a globe now even while the real disc is nothing.
    expect(mapBodyDrawMode(true, true, FAR.truePx, FAR.markerPx)).toBe('globe');
  });

  it('keeps a small mark a crisp dot at true scale', () => {
    // A revealed system's minor moons floor at a few px, where a globe is
    // mush and the dot is the honest symbol.
    const tiny = TRUE_SCALE_GLOBE_MIN_PX - 0.01;
    expect(mapBodyDrawMode(true, true, 0.001, tiny)).toBe('dot');
    expect(mapBodyDrawMode(true, true, 0.001, TRUE_SCALE_GLOBE_MIN_PX)).toBe('globe');
  });

  it('hands over to the REAL disc exactly at the marker crossover', () => {
    // Below the face floor the real disc is still what flips a small mark to
    // a globe, at the same crossover the size policy hands the radius over at.
    const markerPx = TRUE_SCALE_GLOBE_MIN_PX - 1;
    expect(mapBodyDrawMode(true, true, markerPx - 0.01, markerPx)).toBe('dot');
    expect(mapBodyDrawMode(true, true, markerPx, markerPx)).toBe('globe');
    expect(mapBodyDrawMode(true, true, CLOSE.truePx, CLOSE.markerPx)).toBe('globe');
  });

  it('swaps on the committed target, so the blend animation runs one look', () => {
    // The toggle commits, then the 400 ms blend runs. Whatever the blend is
    // doing, every frame of that animation reports the same target — so the
    // decision is constant across all of it. A small mark is the case where
    // the two targets still disagree.
    const tiny = TRUE_SCALE_GLOBE_MIN_PX - 0.01;
    expect(mapBodyDrawMode(true, true, 0.001, tiny)).toBe('dot');
    expect(mapBodyDrawMode(true, false, 0.001, tiny)).toBe('globe');
  });
});

describe('shouldAdoptTexture', () => {
  const a = { id: 1 };
  const b = { id: 2 };

  it('keeps a reference the world still carries', () => {
    expect(shouldAdoptTexture(a, a)).toBe(false);
  });

  it('adopts the first texture to arrive', () => {
    expect(shouldAdoptTexture(null, a)).toBe(true);
    expect(shouldAdoptTexture(undefined, a)).toBe(true);
  });

  it('adopts the replacement when the world hot-swaps a tier', () => {
    // The world disposes `a` as it swaps `b` in; holding `a` would draw black.
    expect(shouldAdoptTexture(a, b)).toBe(true);
  });

  it('compares by identity, never by contents', () => {
    const twin = { id: 1 };
    expect(shouldAdoptTexture(a, twin)).toBe(true);
  });

  it('adopts null when the world has nothing — a drop, not a dispose', () => {
    expect(shouldAdoptTexture(a, null)).toBe(true);
    expect(shouldAdoptTexture(a, undefined)).toBe(true);
    expect(shouldAdoptTexture(null, null)).toBe(false);
    expect(shouldAdoptTexture(null, undefined)).toBe(false);
  });

  it('is idempotent — a second look at the same world state adopts nothing', () => {
    expect(shouldAdoptTexture(null, b)).toBe(true);
    expect(shouldAdoptTexture(b, b)).toBe(false);
  });
});
