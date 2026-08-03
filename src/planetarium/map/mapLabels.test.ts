import { describe, it, expect } from 'vitest';
import {
  MapLabelPlacer,
  mapLabelOffsetPx,
  LABEL_ANCHOR_OFFSET_PX,
  LABEL_CLEARANCE_PX,
  LABEL_MIN_SEP_PX,
} from './mapLabels';
import { MAP_LABEL_CAPACITY } from './mapBodies';
import { mapMarkerRadiusPx, MAP_BODY_SIZE_DEFAULTS } from './mapBodySize';
import { PLANETARIUM_BODIES, SUN_DATA } from '../planets/planetData';

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

describe('mapLabelOffsetPx', () => {
  it('keeps the flat offset for a body small enough not to need more', () => {
    expect(mapLabelOffsetPx(0)).toBe(LABEL_ANCHOR_OFFSET_PX);
    expect(mapLabelOffsetPx(3)).toBe(LABEL_ANCHOR_OFFSET_PX);
    // The floor binds right up to where the marker plus its air overtakes it.
    expect(mapLabelOffsetPx(LABEL_ANCHOR_OFFSET_PX - LABEL_CLEARANCE_PX))
      .toBe(LABEL_ANCHOR_OFFSET_PX);
    expect(mapLabelOffsetPx(LABEL_ANCHOR_OFFSET_PX - LABEL_CLEARANCE_PX + 1))
      .toBe(LABEL_ANCHOR_OFFSET_PX + 1);
  });

  it('clears a marker wider than the flat offset', () => {
    expect(mapLabelOffsetPx(16.5)).toBeCloseTo(18.5, 10);
    expect(mapLabelOffsetPx(200)).toBe(202);
  });

  it('takes the flat offset for a body with no drawn radius of its own', () => {
    // A moon: sized against its parent, and the placer is handed the floor.
    expect(mapLabelOffsetPx(null)).toBe(LABEL_ANCHOR_OFFSET_PX);
    expect(mapLabelOffsetPx(Number.NaN)).toBe(LABEL_ANCHOR_OFFSET_PX);
    expect(mapLabelOffsetPx(-5)).toBe(LABEL_ANCHOR_OFFSET_PX);
  });

  it('rises with the marker, so ordering never inverts', () => {
    let prev = 0;
    for (let r = 0; r <= 40; r += 0.5) {
      const off = mapLabelOffsetPx(r);
      expect(off).toBeGreaterThanOrEqual(prev);
      prev = off;
    }
  });

  it('puts every planet\'s label outside its own marker', () => {
    for (const planet of PLANETARIUM_BODIES) {
      const marker = mapMarkerRadiusPx(planet.radiusAU, MAP_BODY_SIZE_DEFAULTS);
      const offset = mapLabelOffsetPx(marker);
      expect(offset, planet.name).toBeGreaterThanOrEqual(marker + LABEL_CLEARANCE_PX);
      // And outside the dot's painted edge, which sits inside the policy radius
      // (the gradient's 0.18-alpha contour at 0.7 of a 1.3-radius half-extent).
      expect(offset, planet.name).toBeGreaterThan(marker * 0.91);
    }
  });

  it('separates the biggest and smallest planets, which a flat rule could not', () => {
    const jupiter = PLANETARIUM_BODIES.find((p) => p.name === 'Jupiter')!;
    const mercury = PLANETARIUM_BODIES.find((p) => p.name === 'Mercury')!;
    const big = mapLabelOffsetPx(mapMarkerRadiusPx(jupiter.radiusAU, MAP_BODY_SIZE_DEFAULTS));
    const small = mapLabelOffsetPx(mapMarkerRadiusPx(mercury.radiusAU, MAP_BODY_SIZE_DEFAULTS));
    expect(small).toBe(LABEL_ANCHOR_OFFSET_PX);
    expect(big).toBeGreaterThan(small);
    // The flat rule would have put Jupiter's name well inside its own marker.
    expect(LABEL_ANCHOR_OFFSET_PX)
      .toBeLessThan(mapMarkerRadiusPx(jupiter.radiusAU, MAP_BODY_SIZE_DEFAULTS));
  });

  it('is the same number the cull and the transform both use', () => {
    // The contract the ONE helper exists for: the placer is handed the label's
    // drawn position, not the body's centre, so a label is judged where it is
    // painted. Two bodies 30 px apart with equal offsets stay 30 px apart and
    // both place; give the lower one a big marker and its label drops onto the
    // other's, which the cull must catch.
    const p = new MapLabelPlacer(8);
    const anchorA = { x: 100, y: 100, r: 6 };
    const anchorB = { x: 100, y: 130, r: 6 };
    p.begin();
    expect(p.place(anchorA.x, anchorA.y + mapLabelOffsetPx(anchorA.r))).toBe(true);
    expect(p.place(anchorB.x, anchorB.y + mapLabelOffsetPx(anchorB.r))).toBe(true);

    p.begin();
    const grown = { x: 100, y: 100, r: 25 };
    expect(p.place(grown.x, grown.y + mapLabelOffsetPx(grown.r))).toBe(true);
    // Drawn at 127; B's label at 139 is 12 px away — under the separation.
    expect(mapLabelOffsetPx(grown.r)).toBe(27);
    expect(p.place(anchorB.x, anchorB.y + mapLabelOffsetPx(anchorB.r))).toBe(false);
    // Culled against the DRAWN positions: the raw centres are 30 px apart and
    // would both have passed.
    p.begin();
    expect(p.place(grown.x, grown.y)).toBe(true);
    expect(p.place(anchorB.x, anchorB.y)).toBe(true);
  });

  it('leaves the Sun on the flat offset — it is not a planet entry', () => {
    // Stated, not fixed here: the Sun already sizes by policy, so this commit
    // changes nothing about it. Its marker is wider than the flat offset, which
    // is a pre-existing wart, not one this rule introduces.
    expect(mapLabelOffsetPx(null)).toBe(LABEL_ANCHOR_OFFSET_PX);
    expect(mapMarkerRadiusPx(SUN_DATA.radiusAU, MAP_BODY_SIZE_DEFAULTS))
      .toBeGreaterThan(LABEL_ANCHOR_OFFSET_PX);
  });
});
