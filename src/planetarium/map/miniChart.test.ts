import { describe, it, expect } from 'vitest';
import {
  makeMiniBodyKey,
  miniBodiesStale,
  miniChartRect,
  miniChartVisible,
  miniDrawRect,
  miniNeedsReseat,
  miniRectStale,
  miniScissorBottomPx,
  stampMiniBodyKey,
  MINI_BODY_SIZE_PARAMS,
  MINI_SHIP_PX,
  type MiniChartVisibility,
} from './miniChart';
import { mapMarkerRadiusPx, MAP_BODY_SIZE_DEFAULTS } from './mapBodySize';
import { PLANETARIUM_BODIES } from '../planets/planetData';

const shown: MiniChartVisibility = {
  enabled: true,
  ready: true,
  landed: false,
  mapOpen: false,
  deckOpen: false,
  missionActive: false,
  tutorialActive: false,
  helpOpen: false,
  arrivalVeilUp: false,
};

describe('miniChartRect', () => {
  it('sits clear of the wordmark on a desktop canvas', () => {
    const r = miniChartRect(1400, 900);
    expect(r.left).toBe(14);
    expect(r.top).toBe(56);
    expect(r.width).toBe(184);
    expect(r.height).toBe(138);
  });

  it('steps down at the mobile breakpoint and again on a small phone', () => {
    const phone = miniChartRect(390, 844);
    expect(phone.width).toBe(124);
    expect(phone.height).toBe(93);
    expect(phone.top).toBe(56);

    const small = miniChartRect(320, 720);
    expect(small.width).toBe(104);
    expect(small.height).toBe(78);
    expect(small.top).toBe(56);

    // 640 is the breakpoint the rest of the UI uses — it belongs to the
    // narrow band, not the wide one.
    expect(miniChartRect(640, 900).width).toBe(124);
    expect(miniChartRect(641, 900).width).toBe(184);
  });

  it('clears the action cluster at every width', () => {
    // The cluster's bottom edge is the same y whatever the screen (top inset
    // 14 + a 38 px button row), and at 320 px it reaches far enough left to
    // meet the chart. Measured in the browser, so this is a fact about the
    // shipped chrome, not an assumption.
    const CLUSTER_BOTTOM_PX = 52;
    for (const [w, h] of [[1400, 900], [640, 900], [390, 844], [320, 720]]) {
      expect(miniChartRect(w, h).top).toBeGreaterThan(CLUSTER_BOTTOM_PX);
    }
  });

  it('never covers more than its share of a short landscape phone', () => {
    const r = miniChartRect(740, 320);
    expect(r.height).toBeLessThanOrEqual(320 * 0.28 + 1);
    expect(r.width).toBeLessThanOrEqual(740 * 0.42 + 1);
    // Shape is kept: shrinking must not re-frame the chart.
    expect(r.width / r.height).toBeCloseTo(184 / 138, 1);
  });

  it('stays inside the canvas at every band', () => {
    for (const [w, h] of [[1400, 900], [640, 480], [390, 844], [320, 720], [740, 320]]) {
      const r = miniChartRect(w, h);
      expect(r.left).toBeGreaterThanOrEqual(0);
      expect(r.top).toBeGreaterThanOrEqual(0);
      expect(r.left + r.width).toBeLessThanOrEqual(w);
      expect(r.top + r.height).toBeLessThanOrEqual(h);
    }
  });
});

describe('miniScissorBottomPx', () => {
  it('flips the CSS top-left origin onto GL bottom-left', () => {
    const rect = { left: 14, top: 56, width: 184, height: 138 };
    expect(miniScissorBottomPx(900, rect)).toBe(900 - 56 - 138);
  });
});

describe('miniChartVisible', () => {
  it('shows while cruising with the preference on', () => {
    expect(miniChartVisible(shown)).toBe(true);
  });

  it('hides for every state that owns the frame instead', () => {
    const blockers: (keyof MiniChartVisibility)[] = [
      'landed', 'mapOpen', 'deckOpen', 'missionActive',
      'tutorialActive', 'helpOpen', 'arrivalVeilUp',
    ];
    for (const key of blockers) {
      expect(miniChartVisible({ ...shown, [key]: true })).toBe(false);
    }
  });

  it('hides with the preference off, and before the scene is ready', () => {
    expect(miniChartVisible({ ...shown, enabled: false })).toBe(false);
    expect(miniChartVisible({ ...shown, ready: false })).toBe(false);
  });
});

describe('miniNeedsReseat', () => {
  it('always seats an unseated pose', () => {
    expect(miniNeedsReseat(49, 0)).toBe(true);
    expect(miniNeedsReseat(0, 49)).toBe(true);
  });

  it('rides a ship moving inside the seated extent', () => {
    expect(miniNeedsReseat(49, 49)).toBe(false);
    expect(miniNeedsReseat(49 * 1.04, 49)).toBe(false);
    expect(miniNeedsReseat(49 / 1.04, 49)).toBe(false);
  });

  it('re-fits once the extent leaves the band, either way', () => {
    expect(miniNeedsReseat(49 * 1.06, 49)).toBe(true);
    expect(miniNeedsReseat(49 / 1.06, 49)).toBe(true);
  });
});

describe('MINI_BODY_SIZE_PARAMS', () => {
  it('keeps every planet legible but small against the chart', () => {
    const rect = miniChartRect(1400, 900);
    for (const planet of PLANETARIUM_BODIES) {
      const px = mapMarkerRadiusPx(planet.radiusAU, MINI_BODY_SIZE_PARAMS);
      expect(px).toBeGreaterThanOrEqual(MINI_BODY_SIZE_PARAMS.minPx);
      expect(px).toBeLessThanOrEqual(MINI_BODY_SIZE_PARAMS.maxPx);
      // A marker is a marker: its painted disc stays a small fraction of the
      // chart it is drawn on, so the orbits remain the subject.
      expect(2 * px).toBeLessThan(rect.height * 0.1);
    }
  });

  it('keeps the full chart\'s ordering by true radius', () => {
    const sorted = [...PLANETARIUM_BODIES].sort((a, b) => a.radiusAU - b.radiusAU);
    let last = -Infinity;
    for (const planet of sorted) {
      const px = mapMarkerRadiusPx(planet.radiusAU, MINI_BODY_SIZE_PARAMS);
      expect(px).toBeGreaterThanOrEqual(last - 1e-12);
      last = px;
    }
  });

  it('is a shrunk copy of the full chart\'s policy, not a different one', () => {
    expect(MINI_BODY_SIZE_PARAMS.gamma).toBe(MAP_BODY_SIZE_DEFAULTS.gamma);
    expect(MINI_BODY_SIZE_PARAMS.refRadiusAU).toBe(MAP_BODY_SIZE_DEFAULTS.refRadiusAU);
    expect(MINI_BODY_SIZE_PARAMS.minPx).toBeLessThan(MAP_BODY_SIZE_DEFAULTS.minPx);
    expect(MINI_BODY_SIZE_PARAMS.maxPx).toBeLessThan(MAP_BODY_SIZE_DEFAULTS.maxPx);
  });

  it('draws a ship marker that fits the smallest chart', () => {
    const small = miniChartRect(320, 720);
    expect(MINI_SHIP_PX).toBeLessThan(small.height * 0.25);
  });
});

describe('miniRectStale', () => {
  it('is fresh while the canvas holds still', () => {
    expect(miniRectStale(1400, 900, 1400, 900)).toBe(false);
  });

  it('goes stale on either canvas dimension', () => {
    expect(miniRectStale(1400, 900, 1399, 900)).toBe(true);
    expect(miniRectStale(1400, 900, 1400, 901)).toBe(true);
  });

  it('goes stale against an unbuilt cache', () => {
    expect(miniRectStale(-1, -1, 1400, 900)).toBe(true);
  });
});

describe('the corner chart\'s planet-pass key', () => {
  it('never lets the first pass be skipped', () => {
    const key = makeMiniBodyKey();
    expect(miniBodiesStale(key, 0, 0, 0)).toBe(true);
    // Even against the values a fresh key looks like it might hold.
    expect(miniBodiesStale(key, Number.NaN, Number.NaN, -1)).toBe(true);
  });

  it('holds while the clock, the blend and the projection all hold', () => {
    const key = makeMiniBodyKey();
    stampMiniBodyKey(key, 1000, 0, 3);
    expect(miniBodiesStale(key, 1000, 0, 3)).toBe(false);
  });

  it('goes stale on the clock', () => {
    const key = makeMiniBodyKey();
    stampMiniBodyKey(key, 1000, 0, 3);
    expect(miniBodiesStale(key, 1016, 0, 3)).toBe(true);
  });

  it('goes stale on the blend alone — the dots follow the body pass', () => {
    // The case that makes the blend term load-bearing: the corner chart parking
    // a full chart left at true scale moves every body without moving the
    // clock, and reprojecting the orbit lines does not place the dots.
    const key = makeMiniBodyKey();
    stampMiniBodyKey(key, 1000, 1, 3);
    expect(miniBodiesStale(key, 1000, 0, 3)).toBe(true);
  });

  it('goes stale on the projection revision — curve, size policy, viewport', () => {
    const key = makeMiniBodyKey();
    stampMiniBodyKey(key, 1000, 0, 3);
    expect(miniBodiesStale(key, 1000, 0, 4)).toBe(true);
  });

  it('re-holds once stamped again', () => {
    const key = makeMiniBodyKey();
    stampMiniBodyKey(key, 1000, 0, 3);
    stampMiniBodyKey(key, 2000, 0.5, 9);
    expect(miniBodiesStale(key, 2000, 0.5, 9)).toBe(false);
    expect(miniBodiesStale(key, 2000, 0.5, 10)).toBe(true);
  });
});

describe('miniDrawRect — the drawn rectangle never leaves the DOM one', () => {
  /** The renderer's buffer: it FLOORS the css-times-ratio product, each axis. */
  const bufferDims = (cw: number, ch: number, pr: number) => ({
    w: Math.floor(cw * pr),
    h: Math.floor(ch * pr),
  });

  /**
   * The DOM surface's own edges in buffer px, as real numbers. The browser
   * stretches the floored buffer over the css box, so the true scale on each
   * axis is buffer/css — smaller than the nominal ratio whenever the product
   * was fractional. The rect hangs from the TOP of the canvas; GL counts from
   * the buffer's bottom.
   */
  function domEdges(rect: ReturnType<typeof miniChartRect>, cw: number, ch: number, bw: number, bh: number) {
    const scaleX = bw / cw;
    const scaleY = bh / ch;
    return {
      left: rect.left * scaleX,
      right: (rect.left + rect.width) * scaleX,
      bottom: bh - (rect.top + rect.height) * scaleY,
      top: bh - rect.top * scaleY,
    };
  }

  /** What three actually hands the driver: the origin and the size rounded
   *  INDEPENDENTLY, which is the whole defect. */
  const asThreeSees = (originCss: number, sizeCss: number, pr: number) => {
    const origin = Math.round(originCss * pr);
    return { origin, size: Math.round(sizeCss * pr), end: origin + Math.round(sizeCss * pr) };
  };

  // The five configurations the independent QA measured a spill row at, plus
  // the controls it measured clean. Desktop pixel ratio floors at 1.5
  // (main.ts), which is what puts an odd CSS height on a half device pixel.
  const CASES: [number, number, number][] = [
    [390, 844, 1.5],
    [390, 845, 1.5],
    [800, 260, 1.5],
    [800, 261, 1.5],
    [844, 390, 1.5],
    // Controls: an even drawn height, and a whole pixel ratio.
    [1400, 900, 1.5],
    [1440, 900, 2],
    // Fractional ratios a parity trick would not survive.
    [390, 844, 1.25],
    [1400, 900, 1.25],
    [1400, 900, 2.5],
    // A fractional buffer: canvas·ratio is not integral, the renderer floors
    // it, and only a buffer-anchored snap agrees with the driver's frame.
    [800, 261, 1.6],
    [390, 845, 1.6],
    // Fractional buffer WIDTH — the horizontal twin of the same defect.
    [391, 844, 1.5],
    [391, 845, 1.6],
  ];

  it.each(CASES)('%i x %i at pixel ratio %f stays inside the frame', (cw, ch, pr) => {
    const rect = miniChartRect(cw, ch);
    const buf = bufferDims(cw, ch, pr);
    const draw = miniDrawRect(rect, cw, ch, buf.w, buf.h, pr);
    const dom = domEdges(rect, cw, ch, buf.w, buf.h);

    // Whole device pixels...
    expect(Number.isInteger(draw.leftDevicePx)).toBe(true);
    expect(Number.isInteger(draw.bottomDevicePx)).toBe(true);
    expect(Number.isInteger(draw.widthDevicePx)).toBe(true);
    expect(Number.isInteger(draw.heightDevicePx)).toBe(true);

    // ...that three's independent rounding recovers exactly...
    const x = asThreeSees(draw.left, draw.width, pr);
    const y = asThreeSees(draw.bottom, draw.height, pr);
    expect(x.origin).toBe(draw.leftDevicePx);
    expect(x.size).toBe(draw.widthDevicePx);
    expect(y.origin).toBe(draw.bottomDevicePx);
    expect(y.size).toBe(draw.heightDevicePx);

    // ...and land inside the DOM surface on every edge.
    expect(y.origin).toBeGreaterThanOrEqual(dom.bottom);
    expect(y.end).toBeLessThanOrEqual(dom.top);
    expect(x.origin).toBeGreaterThanOrEqual(dom.left);
    expect(x.end).toBeLessThanOrEqual(dom.right);

    // And it is a real chart, not a shaved-to-nothing one: at most one device
    // pixel is given up on each axis.
    expect(dom.top - y.end).toBeLessThan(1);
    expect(y.origin - dom.bottom).toBeLessThan(1);
    expect(dom.right - x.end).toBeLessThan(1);
    expect(x.origin - dom.left).toBeLessThan(1);
  });

  it('reproduces the defect it exists to prevent', () => {
    // 390x844 at 1.5: the DOM top edge is device row 1182 exactly. Handed the
    // raw CSS rect, three rounds bottom 695 -> 1043 and height 93 -> 140 and
    // paints up to row 1183 — one row above the frame.
    const rect = miniChartRect(390, 844);
    expect(rect.height).toBe(93);
    const bottomCss = miniScissorBottomPx(844, rect);
    expect(bottomCss).toBe(695);
    const naive = asThreeSees(bottomCss, rect.height, 1.5);
    expect(naive.end).toBe(1183);
    const domTop = (bottomCss + rect.height) * 1.5;
    expect(domTop).toBe(1182);
    expect(naive.end).toBeGreaterThan(domTop); // the defect

    const buf = bufferDims(390, 844, 1.5);
    const draw = miniDrawRect(rect, 390, 844, buf.w, buf.h, 1.5);
    expect(asThreeSees(draw.bottom, draw.height, 1.5).end).toBe(1182); // the fix
    expect(draw.heightDevicePx).toBe(139);
  });

  it('anchors on the real buffer when canvas-height·ratio is fractional', () => {
    // 800x261 at ratio 1.6: the buffer is floor(417.6) = 417 rows stretched
    // over 261 css px, so the true vertical scale is 417/261 and the DOM top
    // edge sits at 417 − 56·(417/261) ≈ 327.53 from the buffer's bottom. A
    // snap in the nominal frame (·1.6, anchored on 417.6) would place the top
    // edge at device row 328 — above the frame the driver actually has.
    const rect = miniChartRect(800, 261);
    expect(rect.top).toBe(56);
    expect(rect.height).toBe(73);
    const buf = bufferDims(800, 261, 1.6);
    expect(buf.h).toBe(417);

    const cssAnchoredTop = Math.floor((261 - 56) * 1.6 + 1e-9); // the old frame
    expect(cssAnchoredTop).toBe(328);
    const domTop = buf.h - rect.top * (buf.h / 261);
    expect(domTop).toBeCloseTo(327.5287, 3);
    expect(cssAnchoredTop).toBeGreaterThan(domTop); // the defect

    const draw = miniDrawRect(rect, 800, 261, buf.w, buf.h, 1.6);
    const y = asThreeSees(draw.bottom, draw.height, 1.6);
    expect(y.end).toBe(327); // inside 327.53
    expect(y.origin).toBeGreaterThanOrEqual(buf.h - (rect.top + rect.height) * (buf.h / 261));
  });

  it('anchors on the real buffer when canvas-WIDTH·ratio is fractional', () => {
    // 391x844 at ratio 1.5: the buffer is floor(586.5) = 586 columns over 391
    // css px, so the DOM right edge maps to 134·(586/391) ≈ 200.83 — the
    // scissor must end at column 200. The nominal frame says 134·1.5 = 201
    // exactly, which the epsilon rightly treats as integral, and one column
    // then paints outside the frame.
    const rect = miniChartRect(391, 844);
    expect(rect.left + rect.width).toBe(134);
    const buf = bufferDims(391, 844, 1.5);
    expect(buf.w).toBe(586);

    const nominalRight = Math.floor(134 * 1.5 + 1e-9); // the old frame
    expect(nominalRight).toBe(201);
    const domRight = 134 * (buf.w / 391);
    expect(domRight).toBeCloseTo(200.8286, 3);
    expect(nominalRight).toBeGreaterThan(domRight); // the defect

    const draw = miniDrawRect(rect, 391, 844, buf.w, buf.h, 1.5);
    const x = asThreeSees(draw.left, draw.width, 1.5);
    expect(x.end).toBe(200); // inside 200.83
  });

  it('holds the epsilon in both directions', () => {
    // The true scales are rationals with css-integer denominators, so a real
    // edge never sits closer to an integer than about 1/canvas — six orders
    // above the float-noise epsilon. Inward: an exactly-integral edge must not
    // creep down (390 at 1.5: right edge 134·(585/390) = 201 exactly stays
    // 201). Outward: a real fraction must not round up (391's 200.83 stays
    // 200 — pinned by the width test above).
    const rect = miniChartRect(390, 844);
    const buf = bufferDims(390, 844, 1.5);
    expect(buf.w).toBe(585);
    const draw = miniDrawRect(rect, 390, 844, buf.w, buf.h, 1.5);
    expect(draw.leftDevicePx + draw.widthDevicePx).toBe(201);
  });

  it('leaves an already device-aligned rectangle untouched, to the pixel', () => {
    // The desktop case at DPR 2: every edge is already whole, so the snap must
    // change nothing at all.
    const rect = miniChartRect(1440, 900);
    const buf = bufferDims(1440, 900, 2);
    const draw = miniDrawRect(rect, 1440, 900, buf.w, buf.h, 2);
    expect(draw.left).toBe(rect.left);
    expect(draw.width).toBe(rect.width);
    expect(draw.height).toBe(rect.height);
    expect(draw.bottom).toBe(miniScissorBottomPx(900, rect));
    expect(draw.leftDevicePx).toBe(28);
    expect(draw.widthDevicePx).toBe(368);
    expect(draw.heightDevicePx).toBe(276);
  });

  it('degrades safely on a nonsense pixel ratio', () => {
    const rect = miniChartRect(1400, 900);
    // The ratio guard makes pr 1; a css-sized buffer then has scale 1.
    const draw = miniDrawRect(rect, 1400, 900, 1400, 900, 0);
    expect(draw.widthDevicePx).toBe(rect.width);
    expect(draw.heightDevicePx).toBe(rect.height);
  });
});
