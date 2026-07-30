import { describe, it, expect } from 'vitest';
import { MapLabelPlacer, LABEL_MIN_SEP_PX } from './mapLabels';
import { MAP_LABEL_CAPACITY } from './mapBodies';

describe('MapLabelPlacer', () => {
  it('admits the first label and culls one that lands on top of it', () => {
    const p = new MapLabelPlacer(8);
    p.begin();
    expect(p.place(100, 100)).toBe(true);
    expect(p.place(100 + LABEL_MIN_SEP_PX - 1, 100)).toBe(false);
    expect(p.place(100 + LABEL_MIN_SEP_PX, 100)).toBe(true);
    expect(p.placed).toBe(2);
  });

  it('starts each frame clean', () => {
    const p = new MapLabelPlacer(8);
    p.begin();
    p.place(0, 0);
    p.begin();
    expect(p.placed).toBe(0);
    expect(p.place(0, 0)).toBe(true);
  });

  it('keeps culling past its capacity instead of silently admitting everything', () => {
    // The failure this exists to prevent: writing placements past the end of a
    // fixed pool drops them, and comparing against a dropped placement compares
    // against nothing — so every later label would pass and the de-overlap
    // would stop working altogether, without a symptom.
    const p = new MapLabelPlacer(3);
    p.begin();
    for (let i = 0; i < 12; i++) {
      expect(p.place(i * 100, 0)).toBe(true);
    }
    expect(p.placed).toBe(3);
    // The recorded three still cull.
    expect(p.place(0, 0)).toBe(false);
    expect(p.place(100, 0)).toBe(false);
    expect(p.place(200, 0)).toBe(false);
    // Past capacity the placer no longer knows about a position, and says so by
    // admitting it — partial culling, never none.
    expect(p.place(300, 0)).toBe(true);
  });

  it('is sized so a whole roster of labels never reaches that edge', () => {
    const p = new MapLabelPlacer(MAP_LABEL_CAPACITY);
    p.begin();
    for (let i = 0; i < MAP_LABEL_CAPACITY; i++) {
      expect(p.place(i * 100, 0)).toBe(true);
    }
    expect(p.placed).toBe(MAP_LABEL_CAPACITY);
    // Every one of them is still remembered, including the last.
    expect(p.place(0, 0)).toBe(false);
    expect(p.place((MAP_LABEL_CAPACITY - 1) * 100, 0)).toBe(false);
  });

  it('measures separation in both axes', () => {
    const p = new MapLabelPlacer(4);
    p.begin();
    p.place(0, 0);
    expect(p.place(0, LABEL_MIN_SEP_PX - 1)).toBe(false);
    expect(p.place(LABEL_MIN_SEP_PX * 0.8, LABEL_MIN_SEP_PX * 0.8)).toBe(true);
  });

  it('honours a separation the caller sets', () => {
    const p = new MapLabelPlacer(4);
    p.begin();
    p.place(0, 0, 10);
    expect(p.place(9, 0, 10)).toBe(false);
    expect(p.place(11, 0, 10)).toBe(true);
  });
});
