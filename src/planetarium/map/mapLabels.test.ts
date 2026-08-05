import { describe, it, expect } from 'vitest';
import {
  MapLabelPlacer,
  mapLabelOffsetPx,
  LABEL_ANCHOR_OFFSET_PX,
  LABEL_CLEARANCE_PX,
  LABEL_MIN_SEP_PX,
  LABEL_BOX_PAD_PX,
  LABEL_LINE_HEIGHT_PX,
  LABEL_NOMINAL_HALF_WIDTH_PX,
  LABEL_EDGE_PAD_PX,
  LABEL_MIN_BODY_RADIUS_PX,
  clampLabelCenterXPx,
  labelMaxBoxTopPx,
  labelWorthDrawing,
  ringClearedLabelShiftPx,
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
    // Positional: x, anchorY, box top, half-width, separation. Nothing has a
    // width here, so only the anchor floor is in play.
    p.place(0, 0, 0, 0, 10);
    expect(p.place(9, 0, 0, 0, 10)).toBe(false);
    expect(p.place(11, 0, 0, 0, 10)).toBe(true);
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
    }
    // This function is handed a CLEARANCE radius, not a drawn one: how much a
    // body paints around itself is the size policy's business, and
    // labelClearanceRadiusPx is where the two looks are told apart. Feeding it
    // the drawn radius directly is the globe case, above; the dot case is
    // pinned beside that helper in mapBodySize.test.ts.
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

  it('clears the Sun too — its disc is twice the flat offset', () => {
    const sun = mapMarkerRadiusPx(SUN_DATA.radiusAU, MAP_BODY_SIZE_DEFAULTS);
    expect(sun).toBeGreaterThan(LABEL_ANCHOR_OFFSET_PX);
    expect(mapLabelOffsetPx(sun)).toBeGreaterThanOrEqual(sun + LABEL_CLEARANCE_PX);
    // The policy's ceiling is what the Sun sits on, so this is the widest
    // offset the chart ever asks for.
    expect(sun).toBe(MAP_BODY_SIZE_DEFAULTS.maxPx);
  });
});

describe('the label box test', () => {
  /** Place a label the way SystemMap does: anchor, drawn top, half-width. */
  const put = (p: MapLabelPlacer, anchorY: number, offset: number, half: number, x = 200) =>
    p.place(x, anchorY, anchorY + offset, half);

  it('rejects two names that would lie across each other (the O2 case)', () => {
    // Anchors 35 px apart clear the 26 px anchor floor, so the old rule drew
    // both — and their names, 44 px wide, lay straight across each other.
    const p = new MapLabelPlacer(8);
    p.begin();
    expect(p.place(200, 100, 109, 22)).toBe(true);
    expect(p.place(235, 100, 109, 22)).toBe(false);
    // Far enough apart that the boxes clear, and it draws again.
    expect(p.place(200 + 44 + LABEL_BOX_PAD_PX + 1, 100, 109, 22)).toBe(true);
  });

  it('still admits names that only crowd on one axis', () => {
    const p = new MapLabelPlacer(8);
    p.begin();
    expect(put(p, 100, 9, 22)).toBe(true);
    // Straight below, far enough that the two line boxes clear.
    expect(put(p, 100 + LABEL_LINE_HEIGHT_PX + LABEL_BOX_PAD_PX + 30, 9, 22)).toBe(true);
    p.begin();
    expect(put(p, 100, 9, 22)).toBe(true);
    // Side by side on the same line, clear of each other horizontally.
    expect(put(p, 100, 9, 22, 200 + 44 + LABEL_BOX_PAD_PX + 2)).toBe(true);
  });

  it('judges the DRAWN boxes, not the anchors — the mixed-offset case', () => {
    // Same two anchors both times. Saturn's marker is large, so its name is
    // pushed well down; a moon beside it keeps the flat offset. Whether they
    // collide depends entirely on those offsets, which is the whole point.
    // Two anchors 32 px apart across the frame — clear of the 26 px floor, so
    // the anchor rule admits both either way.
    const collide = new MapLabelPlacer(8);
    collide.begin();
    expect(collide.place(200, 100, 100 + 9, 22)).toBe(true);
    expect(collide.place(232, 100, 100 + 9, 22)).toBe(false);
    const spread = new MapLabelPlacer(8);
    spread.begin();
    expect(spread.place(200, 100, 100 + 9, 22)).toBe(true);
    // Same anchors. The second body's marker is big, so its name is pushed a
    // whole line further down — and now the two boxes clear.
    const bigOffset = 9 + LABEL_LINE_HEIGHT_PX + LABEL_BOX_PAD_PX + 1;
    expect(spread.place(232, 100, 100 + bigOffset, 22)).toBe(true);
  });

  it('leaves the anchor floor in charge when nothing has a width', () => {
    // Every old case, at half-width 0: the box test cannot fire, so the
    // behaviour is the anchor rule exactly as it was.
    const p = new MapLabelPlacer(8);
    p.begin();
    expect(p.place(100, 100, 100, 0)).toBe(true);
    expect(p.place(100 + LABEL_MIN_SEP_PX - 1, 100, 100, 0)).toBe(false);
    expect(p.place(100 + LABEL_MIN_SEP_PX, 100, 100, 0)).toBe(true);
  });

  it('defaults to the anchor-only behaviour for a two-argument caller', () => {
    const p = new MapLabelPlacer(8);
    p.begin();
    expect(p.place(0, 0)).toBe(true);
    expect(p.place(LABEL_MIN_SEP_PX - 1, 0)).toBe(false);
    expect(p.place(LABEL_MIN_SEP_PX, 0)).toBe(true);
  });

  it('culls on the nominal width before anything has been measured', () => {
    // The pre-measure frame still gets a box test, so a label does not flash
    // across its neighbour for one frame and then behave.
    const p = new MapLabelPlacer(8);
    p.begin();
    expect(put(p, 100, 9, LABEL_NOMINAL_HALF_WIDTH_PX)).toBe(true);
    expect(put(p, 100, 9, LABEL_NOMINAL_HALF_WIDTH_PX, 232)).toBe(false);
    expect(LABEL_NOMINAL_HALF_WIDTH_PX).toBeGreaterThan(0);
  });

  it('records the box it admitted, so the next label is judged against it', () => {
    const p = new MapLabelPlacer(8);
    p.begin();
    expect(put(p, 100, 9, 40)).toBe(true);
    expect(p.placed).toBe(1);
    // 60 px to the side clears the anchor floor but not two 40 px half-widths.
    expect(put(p, 100, 9, 40, 260)).toBe(false);
    expect(put(p, 100, 9, 40, 200 + 80 + LABEL_BOX_PAD_PX + 2)).toBe(true);
  });
});

describe('clampLabelCenterXPx', () => {
  it('leaves a label alone in the middle of the frame', () => {
    expect(clampLabelCenterXPx(200, 30, 390)).toBe(200);
  });

  it('pins the box whole at either edge — clipped names read as bugs', () => {
    // "Titan" half off the 390 px edge: centre must retreat to halfWidth + pad.
    expect(clampLabelCenterXPx(388, 22, 390)).toBe(390 - 22 - LABEL_EDGE_PAD_PX);
    expect(clampLabelCenterXPx(1, 22, 390)).toBe(22 + LABEL_EDGE_PAD_PX);
  });

  it('parks a label centred when the viewport cannot hold it at all', () => {
    expect(clampLabelCenterXPx(10, 300, 100)).toBe(50);
  });
});

describe('labelMaxBoxTopPx', () => {
  it('measures the band from the chrome actually on screen', () => {
    // Chrome top at 700: the box (14 px line) plus the pad must fit above it.
    expect(labelMaxBoxTopPx(700, 800)).toBe(700 - LABEL_EDGE_PAD_PX - LABEL_LINE_HEIGHT_PX);
  });

  it('falls back to the viewport bottom when nothing was measured', () => {
    expect(labelMaxBoxTopPx(null, 800)).toBe(800 - LABEL_EDGE_PAD_PX - LABEL_LINE_HEIGHT_PX);
  });
});

describe('labelWorthDrawing', () => {
  it('gates a speck and keeps a marker', () => {
    expect(labelWorthDrawing(0.4)).toBe(false);
    expect(labelWorthDrawing(LABEL_MIN_BODY_RADIUS_PX)).toBe(true);
    expect(labelWorthDrawing(6)).toBe(true);
  });

  it('shows a label the caller could not size — missing information hides nothing', () => {
    expect(labelWorthDrawing(null)).toBe(true);
  });

  it('never trips on a planet marker at the size policy floor', () => {
    const floor = mapMarkerRadiusPx(
      PLANETARIUM_BODIES.find((b) => b.name === 'Mercury')!.radiusAU,
      MAP_BODY_SIZE_DEFAULTS,
    );
    expect(labelWorthDrawing(floor)).toBe(true);
  });
});

describe('ringClearedLabelShiftPx', () => {
  const out = { x: 0, y: 0 };

  it('leaves a moon outside the annulus alone', () => {
    // Face-on ring (ratio 1), outer edge 100 px; moon at 120 px.
    expect(ringClearedLabelShiftPx(120, 0, 100, 1, 0, 1, 11, out)).toBe(false);
    expect(out).toEqual({ x: 0, y: 0 });
  });

  it('slides an inner moon radially outward past the outer edge, face on', () => {
    // Moon 40 px right of the parent, ring out to 100: the label lands past
    // 100 + pad along +x, so the shift is (100 + pad − 40, 0).
    expect(ringClearedLabelShiftPx(40, 0, 100, 1, 0, 1, 11, out)).toBe(true);
    expect(out.x).toBeCloseTo(100 + LABEL_EDGE_PAD_PX - 40, 6);
    expect(out.y).toBeCloseTo(0, 6);
  });

  it('points the shift away from the parent, whatever the quadrant', () => {
    expect(ringClearedLabelShiftPx(-30, -30, 100, 1, 0, 1, 11, out)).toBe(true);
    expect(out.x).toBeLessThan(0);
    expect(out.y).toBeLessThan(0);
  });

  it('works the ellipse frame, not the circle: a moon on the minor axis exits along it', () => {
    // Ratio 0.5, minor axis along +y: a moon 30 px up is 60 normalized —
    // still inside 100 — and its nearest exit is along +y at (100+pad)·0.5.
    expect(ringClearedLabelShiftPx(0, 30, 100, 0.5, 0, 1, 11, out)).toBe(true);
    expect(out.x).toBeCloseTo(0, 6);
    expect(out.y).toBeCloseTo((100 + LABEL_EDGE_PAD_PX) * 0.5 - 30, 6);
  });

  it('reads an edge-on ring as no annulus at all', () => {
    // Ratio ~0: any off-plane moon is normalized far outside the edge.
    expect(ringClearedLabelShiftPx(0, 5, 100, 1e-9, 0, 1, 11, out)).toBe(false);
  });

  it('enforces the marker clearance when the moon already sits near the edge', () => {
    // 2 px inside the edge: the raw exit is ~6 px, under the 11 px marker
    // clearance, so the shift grows to 11 along the same ray.
    expect(ringClearedLabelShiftPx(98, 0, 100, 1, 0, 1, 11, out)).toBe(true);
    expect(Math.hypot(out.x, out.y)).toBeCloseTo(11, 6);
    expect(out.y).toBeCloseTo(0, 6);
    expect(out.x).toBeGreaterThan(0);
  });

  it('takes straight down from the parent centre, clear of the whole annulus', () => {
    expect(ringClearedLabelShiftPx(0, 0, 100, 0.5, 0, 1, 11, out)).toBe(true);
    expect(out.x).toBe(0);
    expect(out.y).toBeCloseTo(100 * 0.5 + LABEL_EDGE_PAD_PX, 6);
  });
});
