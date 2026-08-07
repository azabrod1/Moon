/**
 * The corner chart — the schematic riding along in the top-left while you fly.
 * Pure policy, no THREE, no DOM: where the rectangle sits, when the chart is
 * shown at all, how big its markers draw, and when its fixed overview pose has
 * to be re-seated.
 *
 * It is the same chart the full-screen map draws, at a viewport a tenth the
 * area, so nothing metered in screen pixels can be carried over: a marker sized
 * for a 900 px canvas covers a sixth of a 138 px chart. The size knobs below
 * are the corner chart's own, and they follow the same rule the full chart's do
 * — ordered by true radius, floored so nothing vanishes, capped so the orbits
 * stay the subject — except the zoom response, which the mini pins off (γ 0):
 * its framing never zooms, so its marks have nothing to answer.
 */

import {
  MAP_BODY_SIZE_DEFAULTS,
  MAP_MARKER_ZOOM_DEFAULTS,
  type MapBodySizeParams,
  type MapMarkerZoomParams,
  type MapSunSizeParams,
} from './mapBodySize';

/** A rectangle in CSS px, measured from the canvas's top-left. */
export interface MiniChartRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Width at the three layout bands, and the top-left inset each sits at. */
const MINI_WIDE_PX = 184;
const MINI_NARROW_PX = 124;
const MINI_TINY_PX = 104;
/** Height as a fraction of width: the chart is a disc seen from 3/4 overhead,
 *  so it is wider than it is tall and a square box would waste its bottom. */
const MINI_ASPECT_H = 0.75;
/**
 * Top-left inset. The side inset tightens with the screen; the top does not —
 * the action cluster's bottom edge sits at the same y at every width, and at
 * 320 px the cluster reaches far enough left to overlap the chart's corner.
 * One inset below it clears the wordmark too.
 */
const MINI_INSET_Y = 56;
const MINI_WIDE_INSET_X = 14;
const MINI_NARROW_INSET_X = 10;
const MINI_TINY_INSET_X = 8;
/** The mobile breakpoint the rest of the UI uses, and the small-phone band. */
const MINI_NARROW_MAX_W = 640;
const MINI_TINY_MAX_W = 380;
/** However the bands work out, the chart never eats more of the view than
 *  this — a short landscape phone would otherwise wear it like a blindfold. */
const MINI_MAX_CANVAS_FRAC_W = 0.42;
const MINI_MAX_CANVAS_FRAC_H = 0.28;

/**
 * Marker sizes for the corner chart, in its own screen px. Same shape as the
 * full chart's policy — only the floor and the cap come down, because the
 * viewport did.
 */
export const MINI_BODY_SIZE_PARAMS: MapBodySizeParams = {
  ...MAP_BODY_SIZE_DEFAULTS,
  minPx: 2.4,
  maxPx: 6,
};

/** The corner chart's Sun: γ 0 is the constant-size branch — the mini frame
 *  never zooms, so there is no camera motion for a responsive curve to answer,
 *  and the old fixed size (this chart's `maxPx`) is exactly right. */
export const MINI_SUN_SIZE_PARAMS: MapSunSizeParams = {
  gamma: 0,
  pivotPx: 6,
  floorPx: 6,
};

/** The corner chart's marker zoom response: γ 0 for the same reason the Sun's
 *  is — the fixed 3/4 framing has no zoom to answer, and the full chart's
 *  response easing these marks would shrink a chart that is already at its
 *  legibility floor. The mini's marks are frozen exactly as they were. */
export const MINI_MARKER_ZOOM_PARAMS: MapMarkerZoomParams = {
  gamma: 0,
  refAuPerPx: MAP_MARKER_ZOOM_DEFAULTS.refAuPerPx,
  floorScale: 1,
  depthShare: MAP_MARKER_ZOOM_DEFAULTS.depthShare,
};

/** The ship marker's full sprite extent on the corner chart, screen px. */
export const MINI_SHIP_PX = 14;

/**
 * The Sun's halo, in multiples of its drawn disc. Tighter than the full
 * chart's: the whole inner system is inside the halo at this size, and a glow
 * sized for a full screen leaves Mercury, Venus and Earth reading as one smear.
 */
export const MINI_SUN_HALO_RADII = 2.1;

/**
 * Where the chart sits for a canvas of this size. One definition: the WebGL
 * scissor rectangle and the DOM surface that frames it and takes the tap are
 * both written from this, so they cannot drift apart.
 */
export function miniChartRect(canvasWidthPx: number, canvasHeightPx: number): MiniChartRect {
  const cw = Math.max(canvasWidthPx, 1);
  const ch = Math.max(canvasHeightPx, 1);
  let width = MINI_WIDE_PX;
  let left = MINI_WIDE_INSET_X;
  const top = MINI_INSET_Y;
  if (cw <= MINI_TINY_MAX_W) {
    width = MINI_TINY_PX;
    left = MINI_TINY_INSET_X;
  } else if (cw <= MINI_NARROW_MAX_W) {
    width = MINI_NARROW_PX;
    left = MINI_NARROW_INSET_X;
  }
  let height = width * MINI_ASPECT_H;
  // Shrink on the binding axis, keeping the shape — a squashed chart would
  // re-fit to a different framing rather than just showing less of the room.
  const shrink = Math.min(
    1,
    (cw * MINI_MAX_CANVAS_FRAC_W) / width,
    (ch * MINI_MAX_CANVAS_FRAC_H) / height,
  );
  width = Math.round(width * shrink);
  height = Math.round(height * shrink);
  return { left, top, width, height };
}

/**
 * The scissor/viewport origin WebGL wants for that rectangle: GL measures from
 * the bottom of the canvas, CSS from the top.
 */
export function miniScissorBottomPx(canvasHeightPx: number, rect: MiniChartRect): number {
  return Math.max(canvasHeightPx, 1) - rect.top - rect.height;
}

/**
 * The rectangle actually drawn — the DOM rectangle snapped INWARD to whole
 * device pixels.
 *
 * Three converts a scissor and a viewport from CSS to device px by rounding the
 * origin and the size SEPARATELY, so `round(bottom·pr) + round(height·pr)` can
 * land one device row above `round((bottom + height)·pr)`. Any half-device
 * height does it, and the desktop pixel ratio floors at 1.5, so an odd CSS
 * height (93 px — the whole narrow band) is enough: the chart then paints one
 * device row above its own frame, which reads as ink escaping the box.
 *
 * The fix is not a parity trick on the CSS height — that misses odd canvas
 * heights and ratios like 1.25 — but choosing the edges in DEVICE space and
 * handing back the CSS values that recover them exactly: ceil the low edges,
 * floor the high ones, so the drawn rectangle can only ever shrink into the
 * frame. A sub-device-row of chart background showing inside the border is
 * invisible; a row of orbit line outside it is not.
 *
 * Both the scissor and the viewport take these, and so does the camera: the
 * aspect and every screen-metered size have to describe the rectangle that is
 * actually drawn, not the one that was asked for.
 */
export interface MiniDrawRect {
  /** GL origin and size in CSS px, each exactly `device / pixelRatio`. */
  left: number;
  bottom: number;
  width: number;
  height: number;
  /** The same rectangle in whole device pixels — what the driver will see. */
  leftDevicePx: number;
  bottomDevicePx: number;
  widthDevicePx: number;
  heightDevicePx: number;
}

/**
 * Integer snapping that treats a value integral to within float noise as
 * integral — `12 * 1.25` must not creep up to 16. The epsilon is sized for
 * arithmetic error only (these products carry ~1e-12 at screen magnitudes), so
 * any outward overshoot it can cause is bounded by 1e-9 device px — the
 * "inward" invariant holds to that width, which is far below anything a
 * framebuffer can express.
 */
const DEVICE_SNAP_EPSILON = 1e-9;
const snapUp = (v: number): number => Math.ceil(v - DEVICE_SNAP_EPSILON);
const snapDown = (v: number): number => Math.floor(v + DEVICE_SNAP_EPSILON);

export function miniDrawRect(
  rect: MiniChartRect,
  canvasWidthPx: number,
  canvasHeightPx: number,
  drawingBufferWidthPx: number,
  drawingBufferHeightPx: number,
  pixelRatio: number,
): MiniDrawRect {
  const pr = pixelRatio > 0 ? pixelRatio : 1;
  const cw = Math.max(canvasWidthPx, 1);
  const ch = Math.max(canvasHeightPx, 1);
  const bufferW = Math.max(drawingBufferWidthPx, 1);
  const bufferH = Math.max(drawingBufferHeightPx, 1);
  // The DOM rect's device footprint is scaled by the REAL buffer-to-css ratio
  // on each axis, not by the nominal pixel ratio: the renderer FLOORS
  // css-times-ratio when it sizes the buffer, and the browser then stretches
  // that buffer over the css box, so whenever the product is fractional the
  // effective scale is slightly smaller than the ratio. One frame is the
  // truth for the footprint; the nominal ratio only comes back at the end,
  // because it is what the renderer multiplies our CSS values by.
  const scaleX = bufferW / cw;
  const scaleY = bufferH / ch;
  const leftDevicePx = snapUp(rect.left * scaleX);
  const rightDevicePx = snapDown((rect.left + rect.width) * scaleX);
  // The rect hangs from the TOP of the canvas; GL counts from the buffer's
  // bottom.
  const topDevicePx = snapDown(bufferH - rect.top * scaleY);
  const bottomDevicePx = snapUp(bufferH - (rect.top + rect.height) * scaleY);
  const widthDevicePx = Math.max(rightDevicePx - leftDevicePx, 0);
  const heightDevicePx = Math.max(topDevicePx - bottomDevicePx, 0);
  return {
    left: leftDevicePx / pr,
    bottom: bottomDevicePx / pr,
    width: widthDevicePx / pr,
    height: heightDevicePx / pr,
    leftDevicePx,
    bottomDevicePx,
    widthDevicePx,
    heightDevicePx,
  };
}

/** Everything that decides whether the corner chart is on screen this frame. */
export interface MiniChartVisibility {
  /** The user's ☰ preference. */
  enabled: boolean;
  /** The mode is live and its scene is built. */
  ready: boolean;
  landed: boolean;
  mapOpen: boolean;
  deckOpen: boolean;
  missionActive: boolean;
  tutorialActive: boolean;
  helpOpen: boolean;
  /**
   * The arrival veil is on screen — raised for a teleport, and still counted
   * through its fade-out. Not the same question as "an arrival is in flight":
   * the flight clears first, and the veil then holds and fades. A chart that
   * appeared during the fade would show through a black sheet that has already
   * given up its pointers, so a tap would go straight through it.
   */
  arrivalVeilUp: boolean;
}

/**
 * Cruise only. The chart says where you are going, so it belongs to flight:
 * on the ground the Observatory is the instrument, the full map supersedes it
 * outright, and a mission, the tutorial, the help modal or a body picker is
 * someone else's frame to own. Under the arrival veil there is nothing honest
 * to draw — the ship is between two places.
 */
export function miniChartVisible(state: MiniChartVisibility): boolean {
  return state.enabled
    && state.ready
    && !state.landed
    && !state.mapOpen
    && !state.deckOpen
    && !state.missionActive
    && !state.tutorialActive
    && !state.helpOpen
    && !state.arrivalVeilUp;
}

/** How far the chart's extent may drift from the one its pose was seated for
 *  before the pose is re-fit. The extent includes the ship, which moves every
 *  frame; re-fitting on every one of those would make the chart breathe. */
const MINI_RESEAT_TOLERANCE = 0.05;

/**
 * Whether the fixed overview pose still frames the chart. An unseated pose
 * (extent 0) always needs one.
 */
export function miniNeedsReseat(extentAU: number, seatedExtentAU: number): boolean {
  if (!(seatedExtentAU > 0) || !(extentAU > 0)) return true;
  const ratio = extentAU / seatedExtentAU;
  return ratio > 1 + MINI_RESEAT_TOLERANCE || ratio < 1 / (1 + MINI_RESEAT_TOLERANCE);
}

/**
 * Whether the cached rectangle was built for a different canvas. The rect is a
 * pure function of the canvas size, so it is rebuilt when — and only when —
 * that size changes; every other frame reuses the object, which is what keeps
 * the steady state free of allocation.
 */
export function miniRectStale(
  cachedWidthPx: number,
  cachedHeightPx: number,
  widthPx: number,
  heightPx: number,
): boolean {
  return cachedWidthPx !== widthPx || cachedHeightPx !== heightPx;
}

/**
 * What the corner chart's last planet pass was computed against. The chart
 * recomputes every body from the ephemeris, which is the most expensive thing
 * it does and the only thing in it that allocates; a settled chart under a
 * paused clock has no reason to do it twice.
 *
 * All three terms are load-bearing, and the second is the subtle one: the
 * planet dots are placed by the body pass, not by the orbit reprojection, so a
 * blend that moved without the clock moving (the corner chart parking a full
 * chart left at true scale) still has to replace them.
 */
export interface MiniBodyKey {
  utcMs: number;
  blend: number;
  /** The chart's projection revision — the curve, the size policy, the offset
   *  policy, the viewport: everything the clock and the blend cannot see. */
  revision: number;
}

/** A key nothing matches, so the first pass after it can never be skipped. */
export function makeMiniBodyKey(): MiniBodyKey {
  return { utcMs: Number.NaN, blend: Number.NaN, revision: -1 };
}

export function miniBodiesStale(
  key: MiniBodyKey,
  utcMs: number,
  blend: number,
  revision: number,
): boolean {
  return key.utcMs !== utcMs || key.blend !== blend || key.revision !== revision;
}

export function stampMiniBodyKey(
  key: MiniBodyKey,
  utcMs: number,
  blend: number,
  revision: number,
): void {
  key.utcMs = utcMs;
  key.blend = blend;
  key.revision = revision;
}
