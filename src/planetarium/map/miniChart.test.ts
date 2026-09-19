import { describe, it, expect } from 'vitest';
import {
  clampMiniSizeScale,
  makeMiniBodyKey,
  miniBodiesStale,
  miniChartRect,
  miniChartVisible,
  miniDragWidth,
  miniDrawRect,
  miniMarkSizes,
  miniNeedsReseat,
  miniPinchWidth,
  miniPresentationScale,
  miniRectStale,
  miniReleaseScale,
  miniReleaseWidth,
  miniScaleForWidth,
  miniScissorBottomPx,
  miniSizeDetentAt,
  miniSizeDetentScale,
  miniSizeLabel,
  miniSizeRange,
  miniWidthForScale,
  nextMiniSizeDetent,
  stampMiniBodyKey,
  MINI_BODY_SIZE_PARAMS,
  MINI_SHIP_PX,
  MINI_SIZE_DETENTS,
  MINI_SIZE_MAX_SCALE,
  MINI_SIZE_MIN_SCALE,
  MINI_SUN_SIZE_PARAMS,
  type MiniChartVisibility,
} from './miniChart';
import { mapMarkerRadiusPx, MAP_BODY_SIZE_DEFAULTS, MAP_SUN_SIZE_DEFAULTS } from './mapBodySize';
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
    expect(r.width).toBe(200);
    expect(r.height).toBe(150);
  });

  it('steps down at the mobile breakpoint and again on a small phone', () => {
    const phone = miniChartRect(390, 844);
    expect(phone.width).toBe(132);
    expect(phone.height).toBe(99);
    expect(phone.top).toBe(56);

    const small = miniChartRect(320, 720);
    expect(small.width).toBe(104);
    expect(small.height).toBe(78);
    expect(small.top).toBe(56);

    // 640 is the breakpoint the rest of the UI uses — it belongs to the
    // narrow band, not the wide one.
    expect(miniChartRect(640, 900).width).toBe(132);
    expect(miniChartRect(641, 900).width).toBe(200);
  });

  it('draws the band\'s own rect at scale 1, and the same rect with the scale left out', () => {
    for (const [w, h] of [[1400, 900], [640, 900], [390, 844], [320, 720], [740, 320]]) {
      expect(miniChartRect(w, h, 1)).toEqual(miniChartRect(w, h));
    }
  });

  it('scales the width, keeps the shape and the corner', () => {
    const base = miniChartRect(1400, 900);
    const bigger = miniChartRect(1400, 900, 1.5);
    expect(bigger.width).toBe(300);
    expect(bigger.height).toBe(225);
    expect(bigger.left).toBe(base.left);
    expect(bigger.top).toBe(base.top);
    const smaller = miniChartRect(1400, 900, 0.75);
    expect(smaller.width).toBe(150);
    expect(smaller.height).toBe(113);
  });

  it('holds a dragged size to the canvas\'s ceiling, phone and landscape alike', () => {
    // A 390 px phone: 2.2 × 132 would be 290, but 60 % of the width is 234.
    const phone = miniChartRect(390, 844, MINI_SIZE_MAX_SCALE);
    expect(phone.width).toBe(234);
    expect(phone.left + phone.width).toBeLessThanOrEqual(390);
    // Landscape: the height cap binds first — 40 % of 390 is 156 tall.
    const landscape = miniChartRect(844, 390, MINI_SIZE_MAX_SCALE);
    expect(landscape.height).toBeLessThanOrEqual(156);
    expect(landscape.top + landscape.height).toBeLessThanOrEqual(390);
    // The desktop reaches the scale's own ceiling before the canvas's.
    expect(miniChartRect(1400, 900, MINI_SIZE_MAX_SCALE).width).toBe(440);
  });

  it('never shrinks below the legibility floor', () => {
    expect(miniChartRect(1400, 900, MINI_SIZE_MIN_SCALE).width).toBe(120);
    // 0.6 × 132 is 79; the floor holds it at 96.
    expect(miniChartRect(390, 844, MINI_SIZE_MIN_SCALE).width).toBe(96);
    // A chart already under the floor by the default caps keeps what it had.
    const short = miniChartRect(300, 200, MINI_SIZE_MIN_SCALE);
    expect(short.width).toBe(miniChartRect(300, 200).width);
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
    expect(r.width / r.height).toBeCloseTo(200 / 150, 1);
  });

  it('stays inside the canvas at every band and every size', () => {
    for (const [w, h] of [[1400, 900], [640, 480], [390, 844], [320, 720], [740, 320], [844, 390]]) {
      for (const scale of [MINI_SIZE_MIN_SCALE, 0.75, 1, 1.5, MINI_SIZE_MAX_SCALE]) {
        const r = miniChartRect(w, h, scale);
        expect(r.left).toBeGreaterThanOrEqual(0);
        expect(r.top).toBeGreaterThanOrEqual(0);
        expect(r.left + r.width).toBeLessThanOrEqual(w);
        expect(r.top + r.height).toBeLessThanOrEqual(h);
        // The shape is the one shape at every size.
        expect(r.width / r.height).toBeCloseTo(4 / 3, 1);
      }
    }
  });
});

describe('the size range', () => {
  it('brackets the default, which is the rect at scale 1', () => {
    for (const [w, h] of [[1400, 900], [390, 844], [320, 720], [844, 390], [300, 200]]) {
      const range = miniSizeRange(w, h);
      expect(range.defaultWidthPx).toBe(miniChartRect(w, h).width);
      expect(range.minWidthPx).toBeLessThanOrEqual(range.defaultWidthPx);
      expect(range.maxWidthPx).toBeGreaterThanOrEqual(range.defaultWidthPx);
    }
  });

  it('maps a scale to a width and back, inside the range', () => {
    const range = miniSizeRange(1400, 900);
    expect(miniWidthForScale(range, 1)).toBe(200);
    expect(miniWidthForScale(range, 1.5)).toBe(300);
    expect(miniScaleForWidth(range, 300)).toBeCloseTo(1.5, 12);
    // A width past the ceiling draws at the ceiling but saves as what it
    // drew at, so a monitor can honour it.
    const phone = miniSizeRange(390, 844);
    expect(miniWidthForScale(phone, 2.2)).toBe(234);
    expect(miniScaleForWidth(phone, 234)).toBeCloseTo(234 / 132, 12);
  });

  it('holds a preference to the scale\'s bounds and reads nonsense as the default', () => {
    expect(clampMiniSizeScale(5)).toBe(MINI_SIZE_MAX_SCALE);
    expect(clampMiniSizeScale(0)).toBe(MINI_SIZE_MIN_SCALE);
    expect(clampMiniSizeScale(Number.NaN)).toBe(1);
    expect(clampMiniSizeScale(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clampMiniSizeScale(1.3)).toBe(1.3);
  });
});

describe('the size detents', () => {
  it('name a scale on a detent, and Custom between them', () => {
    expect(miniSizeDetentAt(1)).toBe('medium');
    expect(miniSizeDetentAt(0.75)).toBe('small');
    expect(miniSizeDetentAt(1.5)).toBe('large');
    expect(miniSizeDetentAt(1.015)).toBe('medium');
    expect(miniSizeDetentAt(1.1)).toBe('custom');
    expect(miniSizeLabel(1)).toBe('Medium');
    expect(miniSizeLabel(1.2)).toBe('Custom');
  });

  it('cycle Small → Medium → Large → Small from a detent', () => {
    expect(nextMiniSizeDetent(miniSizeDetentScale('small'))).toBe('medium');
    expect(nextMiniSizeDetent(miniSizeDetentScale('medium'))).toBe('large');
    expect(nextMiniSizeDetent(miniSizeDetentScale('large'))).toBe('small');
  });

  it('step to the first detent above a custom size, wrapping past Large', () => {
    expect(nextMiniSizeDetent(0.65)).toBe('small');
    expect(nextMiniSizeDetent(0.9)).toBe('medium');
    expect(nextMiniSizeDetent(1.2)).toBe('large');
    expect(nextMiniSizeDetent(2)).toBe('small');
  });

  it('are ordered, and Medium is the default', () => {
    const scales = MINI_SIZE_DETENTS.map((entry) => entry.scale);
    expect([...scales].sort((a, b) => a - b)).toEqual(scales);
    expect(miniSizeDetentScale('medium')).toBe(1);
  });
});

describe('the gestures', () => {
  it('a corner drag follows the dominant axis, measured in width', () => {
    // Rightward: the width grows by the travel.
    expect(miniDragWidth(200, 40, 0)).toBe(240);
    // Downward: the travel is in height, so the width grows by 4/3 of it.
    expect(miniDragWidth(200, 0, 30)).toBeCloseTo(240, 12);
    // Diagonal along the box's own shape: the two agree, the corner stays
    // under the finger.
    expect(miniDragWidth(200, 40, 30)).toBeCloseTo(240, 12);
    // Inward shrinks.
    expect(miniDragWidth(200, -40, -10)).toBe(160);
    // Mixed: the larger claim wins.
    expect(miniDragWidth(200, -10, 30)).toBeCloseTo(240, 12);
  });

  it('a pinch scales the width with the finger distance', () => {
    expect(miniPinchWidth(200, 100, 150)).toBe(300);
    expect(miniPinchWidth(200, 100, 50)).toBe(100);
    expect(miniPinchWidth(200, 0, 50)).toBe(200);
    expect(miniPinchWidth(200, 100, 0)).toBe(200);
  });

  it('a release settles on a detent it landed near, else where the finger left it', () => {
    expect(miniReleaseScale(1.03)).toBe(1);
    expect(miniReleaseScale(0.97)).toBe(1);
    expect(miniReleaseScale(1.47)).toBe(1.5);
    expect(miniReleaseScale(1.2)).toBe(1.2);
    expect(miniReleaseScale(3)).toBe(MINI_SIZE_MAX_SCALE);
    const range = miniSizeRange(1400, 900);
    expect(miniReleaseWidth(range, 206)).toBe(200);
    expect(miniReleaseWidth(range, 260)).toBe(260);
  });
});

describe('the marks grow with the box', () => {
  it('draw exactly today\'s marks at and below the default width', () => {
    expect(miniPresentationScale(200, 200)).toBe(1);
    expect(miniPresentationScale(150, 200)).toBe(1);
    expect(miniPresentationScale(96, 132)).toBe(1);
    const marks = miniMarkSizes(1);
    expect(marks.body).toEqual(MINI_BODY_SIZE_PARAMS);
    expect(marks.sun).toEqual(MINI_SUN_SIZE_PARAMS);
    expect(marks.shipPx).toBe(MINI_SHIP_PX);
    expect(marks.lineWidthScale).toBe(1);
  });

  it('grow on a compressive law: slower than the box', () => {
    const twice = miniPresentationScale(400, 200);
    expect(twice).toBeGreaterThan(1);
    expect(twice).toBeLessThan(2);
    expect(miniPresentationScale(300, 200)).toBeLessThan(twice);
    // Past the scale's ceiling the marks stop growing.
    expect(miniPresentationScale(600, 200)).toBe(miniPresentationScale(440, 200));
  });

  it('stay under the full chart\'s at the ceiling, so the orbits remain the subject', () => {
    const marks = miniMarkSizes(miniPresentationScale(440, 200));
    expect(marks.body.minPx).toBeLessThan(MAP_BODY_SIZE_DEFAULTS.minPx);
    expect(marks.body.maxPx).toBeLessThan(MAP_BODY_SIZE_DEFAULTS.maxPx);
    expect(marks.body.gamma).toBe(MAP_BODY_SIZE_DEFAULTS.gamma);
    expect(marks.body.refRadiusAU).toBe(MAP_BODY_SIZE_DEFAULTS.refRadiusAU);
    expect(marks.sun.floorPx).toBeLessThan(MAP_SUN_SIZE_DEFAULTS.pivotPx);
    expect(marks.sun.gamma).toBe(0);
    // The full chart's ship sprite is 26 px (SystemMap's SHIP_PX).
    expect(marks.shipPx).toBeLessThan(26);
    // Lines thicken more gently than the marks.
    expect(marks.lineWidthScale).toBeGreaterThan(1);
    expect(marks.lineWidthScale).toBeLessThan(marks.shipPx / MINI_SHIP_PX);
    // And every mark still fits the chart it is drawn on.
    const rect = miniChartRect(1400, 900, MINI_SIZE_MAX_SCALE);
    for (const planet of PLANETARIUM_BODIES) {
      expect(2 * mapMarkerRadiusPx(planet.radiusAU, marks.body)).toBeLessThan(rect.height * 0.1);
    }
  });

  it('read nonsense as no growth', () => {
    expect(miniMarkSizes(Number.NaN).shipPx).toBe(MINI_SHIP_PX);
    expect(miniMarkSizes(0).shipPx).toBe(MINI_SHIP_PX);
    expect(miniPresentationScale(0, 200)).toBe(1);
    expect(miniPresentationScale(200, 0)).toBe(1);
  });
});

describe('miniScissorBottomPx', () => {
  it('flips the CSS top-left origin onto GL bottom-left', () => {
    const rect = { left: 14, top: 56, width: 200, height: 150 };
    expect(miniScissorBottomPx(900, rect)).toBe(900 - 56 - 150);
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
  it('is fresh while the canvas and the size hold still', () => {
    expect(miniRectStale(1400, 900, 1, 1400, 900, 1)).toBe(false);
  });

  it('goes stale on either canvas dimension', () => {
    expect(miniRectStale(1400, 900, 1, 1399, 900, 1)).toBe(true);
    expect(miniRectStale(1400, 900, 1, 1400, 901, 1)).toBe(true);
  });

  it('goes stale on the size scale — a drag rebuilds on every frame it moves', () => {
    expect(miniRectStale(1400, 900, 1, 1400, 900, 1.01)).toBe(true);
  });

  it('goes stale against an unbuilt cache', () => {
    expect(miniRectStale(-1, -1, -1, 1400, 900, 1)).toBe(true);
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
    // raw CSS rect, three rounds bottom 689 -> 1034 and height 99 -> 149 and
    // paints up to row 1183 — one row above the frame. (Any odd CSS height
    // does it; 99 is the whole narrow band's.)
    const rect = miniChartRect(390, 844);
    expect(rect.height).toBe(99);
    const bottomCss = miniScissorBottomPx(844, rect);
    expect(bottomCss).toBe(689);
    const naive = asThreeSees(bottomCss, rect.height, 1.5);
    expect(naive.end).toBe(1183);
    const domTop = (bottomCss + rect.height) * 1.5;
    expect(domTop).toBe(1182);
    expect(naive.end).toBeGreaterThan(domTop); // the defect

    const buf = bufferDims(390, 844, 1.5);
    const draw = miniDrawRect(rect, 390, 844, buf.w, buf.h, 1.5);
    expect(asThreeSees(draw.bottom, draw.height, 1.5).end).toBe(1182); // the fix
    expect(draw.heightDevicePx).toBe(148);
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
    // css px, so the DOM right edge maps to 142·(586/391) ≈ 212.82 — the
    // scissor must end at column 212. The nominal frame says 142·1.5 = 213
    // exactly, which the epsilon rightly treats as integral, and one column
    // then paints outside the frame.
    const rect = miniChartRect(391, 844);
    expect(rect.left + rect.width).toBe(142);
    const buf = bufferDims(391, 844, 1.5);
    expect(buf.w).toBe(586);

    const nominalRight = Math.floor(142 * 1.5 + 1e-9); // the old frame
    expect(nominalRight).toBe(213);
    const domRight = 142 * (buf.w / 391);
    expect(domRight).toBeCloseTo(212.8184, 3);
    expect(nominalRight).toBeGreaterThan(domRight); // the defect

    const draw = miniDrawRect(rect, 391, 844, buf.w, buf.h, 1.5);
    const x = asThreeSees(draw.left, draw.width, 1.5);
    expect(x.end).toBe(212); // inside 212.82
  });

  it('holds the epsilon in both directions', () => {
    // The true scales are rationals with css-integer denominators, so a real
    // edge never sits closer to an integer than about 1/canvas — six orders
    // above the float-noise epsilon. Inward: an exactly-integral edge must not
    // creep down (390 at 1.5: right edge 142·(585/390) = 213 exactly stays
    // 213). Outward: a real fraction must not round up (391's 212.82 stays
    // 212 — pinned by the width test above).
    const rect = miniChartRect(390, 844);
    const buf = bufferDims(390, 844, 1.5);
    expect(buf.w).toBe(585);
    const draw = miniDrawRect(rect, 390, 844, buf.w, buf.h, 1.5);
    expect(draw.leftDevicePx + draw.widthDevicePx).toBe(213);
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
    expect(draw.widthDevicePx).toBe(400);
    expect(draw.heightDevicePx).toBe(300);
  });

  it('degrades safely on a nonsense pixel ratio', () => {
    const rect = miniChartRect(1400, 900);
    // The ratio guard makes pr 1; a css-sized buffer then has scale 1.
    const draw = miniDrawRect(rect, 1400, 900, 1400, 900, 0);
    expect(draw.widthDevicePx).toBe(rect.width);
    expect(draw.heightDevicePx).toBe(rect.height);
  });
});
