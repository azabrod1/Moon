import { describe, it, expect } from 'vitest';
import { mapBodyDrawMode, shouldAdoptTexture, MAP_GLOBE_MIN_PX } from './mapGlobes';

describe('mapBodyDrawMode', () => {
  // Overview framing: every body's real disc is far below its chart marker.
  const FAR = { truePx: 0.001, markerPx: 16 };
  // Focus framing: the camera has closed in until the real disc dominates.
  const CLOSE = { truePx: 63, markerPx: 16 };

  it('falls back to the dot while the world texture is still loading', () => {
    expect(mapBodyDrawMode(false, FAR.truePx, FAR.markerPx, MAP_GLOBE_MIN_PX)).toBe('dot');
    expect(mapBodyDrawMode(false, CLOSE.truePx, CLOSE.markerPx, 0)).toBe('dot');
  });

  it('draws the globe once the marker can carry a face', () => {
    // The drawn size is floored at the marker either way, so a body-sized mark
    // that painted as an abstract dot read as an unloaded body. A planet's
    // marker (here 16 px) is a globe even while the real disc is nothing.
    expect(mapBodyDrawMode(true, FAR.truePx, FAR.markerPx, MAP_GLOBE_MIN_PX)).toBe('globe');
  });

  it('keeps a small mark a crisp dot below the face threshold', () => {
    // A zoom-shrunken planet at the far overview, or a revealed system's
    // minor moon at true scale: a globe at a few px is mush — and at the
    // overview an unlit hemisphere — where the dot is the honest symbol.
    const tiny = MAP_GLOBE_MIN_PX - 0.01;
    expect(mapBodyDrawMode(true, 0.001, tiny, MAP_GLOBE_MIN_PX)).toBe('dot');
    expect(mapBodyDrawMode(true, 0.001, MAP_GLOBE_MIN_PX, MAP_GLOBE_MIN_PX)).toBe('globe');
  });

  it('never demotes an unshrunken planet marker — the classic chart is untouched', () => {
    // The planets' marker floor is 6 px and the face threshold 5: wherever
    // the zoom response reads 1 (every framing out to the planet-orbit
    // views), the compressed chart draws exactly the globes it always did.
    expect(mapBodyDrawMode(true, 0.001, 6, MAP_GLOBE_MIN_PX)).toBe('globe');
  });

  it('threshold 0 is the always-globe chart', () => {
    // The corner chart (marks 2.4–6 px, fixed framing) and compressed-mode
    // moons keep their established look: any textured mark is a globe.
    expect(mapBodyDrawMode(true, 0.001, 2.4, 0)).toBe('globe');
    expect(mapBodyDrawMode(true, 0.001, MAP_GLOBE_MIN_PX - 0.01, 0)).toBe('globe');
  });

  it('hands over to the REAL disc exactly at the marker crossover', () => {
    // Below the face floor the real disc is still what flips a small mark to
    // a globe, at the same crossover the size policy hands the radius over at.
    const markerPx = MAP_GLOBE_MIN_PX - 1;
    expect(mapBodyDrawMode(true, markerPx - 0.01, markerPx, MAP_GLOBE_MIN_PX)).toBe('dot');
    expect(mapBodyDrawMode(true, markerPx, markerPx, MAP_GLOBE_MIN_PX)).toBe('globe');
    expect(mapBodyDrawMode(true, CLOSE.truePx, CLOSE.markerPx, MAP_GLOBE_MIN_PX)).toBe('globe');
  });

  it('the moon call sites switch threshold by committed target, not blend', () => {
    // Moons pass 0 while compressed and the face threshold at true scale —
    // the decision the old boolean parameter encoded, now the caller's
    // ternary on the scale control's committed target. A small mark is the
    // case where the two thresholds still disagree.
    const tiny = MAP_GLOBE_MIN_PX - 0.01;
    expect(mapBodyDrawMode(true, 0.001, tiny, MAP_GLOBE_MIN_PX)).toBe('dot');
    expect(mapBodyDrawMode(true, 0.001, tiny, 0)).toBe('globe');
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
