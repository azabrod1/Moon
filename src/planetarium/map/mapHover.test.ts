import { describe, it, expect } from 'vitest';
import {
  resolveMapHover,
  HOVER_HIT_FLOOR_PX,
  HOVER_RECLAIM_MOVE_PX,
  HOVER_RELEASE_MS,
} from './mapHover';
import { PICK_DISC_PAD, PICK_RADIUS_FINE, pickRadiusForAnchor } from './mapPicking';
import { MAP_DOUBLE_TAP_MS } from './mapCamera';

describe('the map hover latch', () => {
  it('acquires from nothing the moment a body is under the pointer', () => {
    expect(resolveMapHover(null, 'Io', 0, 0)).toBe('Io');
    // Nothing held and nothing under the pointer stays nothing.
    expect(resolveMapHover(null, null, 0, 0)).toBeNull();
    // With nothing held, neither release term can hold anything back.
    expect(resolveMapHover(null, 'Io', 10_000, 400)).toBe('Io');
  });

  it('holds through misses while the pointer rests', () => {
    for (const elapsed of [0, 16, 250, HOVER_RELEASE_MS - 1]) {
      expect(resolveMapHover('Io', null, elapsed, 0)).toBe('Io');
    }
  });

  it('holds through a rival body flying across the same pixel', () => {
    // Europa passes over the cursor while Io is held: the hold wins until it
    // lapses, so the card a click opens is the one the emphasis names.
    expect(resolveMapHover('Io', 'Europa', HOVER_RELEASE_MS - 1, 0)).toBe('Io');
    expect(resolveMapHover('Io', 'Europa', 1, HOVER_RECLAIM_MOVE_PX)).toBe('Io');
  });

  it('hands over at exactly the release time', () => {
    expect(resolveMapHover('Io', 'Europa', HOVER_RELEASE_MS, 0)).toBe('Europa');
    expect(resolveMapHover('Io', null, HOVER_RELEASE_MS, 0)).toBeNull();
  });

  it('retargets on deliberate aim, and not on a jitter', () => {
    // Strictly beyond the reclaim radius is aiming; exactly at it is not.
    expect(resolveMapHover('Io', 'Europa', 0, HOVER_RECLAIM_MOVE_PX + 1)).toBe('Europa');
    expect(resolveMapHover('Io', 'Europa', 0, HOVER_RECLAIM_MOVE_PX)).toBe('Io');
    expect(resolveMapHover('Io', 'Europa', 0, HOVER_RECLAIM_MOVE_PX + 0.001)).toBe('Europa');
    // Aiming at empty space releases the same way.
    expect(resolveMapHover('Io', null, 0, HOVER_RECLAIM_MOVE_PX + 1)).toBeNull();
  });

  it('refreshes on the same candidate however long it has been held', () => {
    expect(resolveMapHover('Io', 'Io', 10_000, 400)).toBe('Io');
    expect(resolveMapHover('Io', 'Io', Number.MAX_SAFE_INTEGER, 1e6)).toBe('Io');
  });

  it('picks hover up tighter than a click, at every drawn size', () => {
    // The floor itself is inside the tap radius...
    expect(HOVER_HIT_FLOOR_PX).toBeLessThan(PICK_RADIUS_FINE);
    // ...and stays inside it once a globe's own footprint governs both, since
    // the two share one disc rule and differ only in the floor they start from.
    for (const disc of [0, 5, 17, 18, 24, 40, 300]) {
      expect(pickRadiusForAnchor(HOVER_HIT_FLOOR_PX, disc, PICK_DISC_PAD))
        .toBeLessThanOrEqual(pickRadiusForAnchor(PICK_RADIUS_FINE, disc, PICK_DISC_PAD));
    }
    // A dot pushes no disc, so its hover radius is exactly the floor.
    expect(pickRadiusForAnchor(HOVER_HIT_FLOOR_PX, 0)).toBe(HOVER_HIT_FLOOR_PX);
    // A globe drawn wider than the floor gets its own limb plus the pad.
    expect(pickRadiusForAnchor(HOVER_HIT_FLOOR_PX, 40)).toBe(44);
  });

  it('outlives the double-tap window, so a hold serves the gesture it is for', () => {
    expect(HOVER_RELEASE_MS).toBeGreaterThan(MAP_DOUBLE_TAP_MS);
  });
});
