import { describe, it, expect } from 'vitest';
import { mapBodyDrawMode, shouldAdoptTexture } from './mapGlobes';

describe('mapBodyDrawMode', () => {
  it('draws a globe only with a loaded texture on the compressed chart', () => {
    expect(mapBodyDrawMode(true, false)).toBe('globe');
  });

  it('falls back to the dot while the world texture is still loading', () => {
    expect(mapBodyDrawMode(false, false)).toBe('dot');
  });

  it('keeps the dot look at true scale, texture or not', () => {
    expect(mapBodyDrawMode(true, true)).toBe('dot');
    expect(mapBodyDrawMode(false, true)).toBe('dot');
  });

  it('swaps on the committed target, so the blend animation runs one look', () => {
    // The toggle commits, then the 400 ms blend runs. Whatever the blend is
    // doing, every frame of that animation reports the same target — so the
    // decision is constant across all of it.
    expect(mapBodyDrawMode(true, true)).toBe('dot');
    expect(mapBodyDrawMode(true, false)).toBe('globe');
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
