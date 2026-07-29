import { describe, it, expect } from 'vitest';
import { mapBodyDrawMode, shouldAdoptTexture } from './mapGlobes';

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

  it('keeps the dot look at true scale while the marker is what governs', () => {
    expect(mapBodyDrawMode(true, true, FAR.truePx, FAR.markerPx)).toBe('dot');
  });

  it('hands over the true-scale globe exactly at the marker crossover', () => {
    // Below the crossover the marker would still floor the drawn size, so a
    // globe there would be an inflated body calling itself true scale.
    expect(mapBodyDrawMode(true, true, 15.99, 16)).toBe('dot');
    expect(mapBodyDrawMode(true, true, 16, 16)).toBe('globe');
    expect(mapBodyDrawMode(true, true, CLOSE.truePx, CLOSE.markerPx)).toBe('globe');
  });

  it('lets the per-body marker floor set its own crossover', () => {
    // A 20 px disc is a globe for a body whose marker floors at 6 px and still
    // a dot for one whose marker floors at 16.
    expect(mapBodyDrawMode(true, true, 20, 6)).toBe('globe');
    expect(mapBodyDrawMode(true, true, 20, 16)).toBe('globe');
    expect(mapBodyDrawMode(true, true, 8, 6)).toBe('globe');
    expect(mapBodyDrawMode(true, true, 8, 16)).toBe('dot');
  });

  it('swaps on the committed target, so the blend animation runs one look', () => {
    // The toggle commits, then the 400 ms blend runs. Whatever the blend is
    // doing, every frame of that animation reports the same target — so the
    // decision is constant across all of it.
    expect(mapBodyDrawMode(true, true, FAR.truePx, FAR.markerPx)).toBe('dot');
    expect(mapBodyDrawMode(true, false, FAR.truePx, FAR.markerPx)).toBe('globe');
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
