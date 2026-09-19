/**
 * The corner chart — the schematic riding along in the top-left while you fly.
 * Pure policy, no THREE, no DOM: where the rectangle sits, when the chart is
 * shown at all, how big its markers draw, and when its fixed overview pose has
 * to be re-seated.
 *
 * It is the same chart the full-screen map draws, at a viewport a tenth the
 * area, so nothing metered in screen pixels can be carried over: a marker sized
 * for a 900 px canvas covers a sixth of a 150 px chart. The size knobs below
 * are the corner chart's own, and they follow the same rule the full chart's do
 * — ordered by true radius, floored so nothing vanishes, capped so the orbits
 * stay the subject — except the zoom response, which the mini pins off (γ 0):
 * its framing never zooms, so its marks have nothing to answer.
 *
 * **The chart is the user's to size.** One number, the size scale, says how
 * big the chart is as a multiple of the width this layout would give it on its
 * own, so one preference means the same thing on a monitor and on a phone:
 * 1.5 is "half again as big as the chart you would have had", whichever band
 * the canvas falls in. The rectangle it asks for is then held to a floor and a
 * ceiling measured against THIS canvas (`miniSizeRange`), so a size dragged
 * out on a monitor lands at what a phone can afford rather than off its edge.
 * The shape never changes — a corner drag, a pinch and the ☰ row all move the
 * one scale — because the chart is a disc seen from three-quarters overhead
 * and a different aspect would be a different framing, not a bigger box.
 *
 * A bigger box gets bigger marks, gently (`miniPresentationScale`): the
 * framing is fixed, so at twice the width every orbit is drawn at twice the
 * pixels per AU, and marks held at their small-chart size would read as a
 * chart drawn for a smaller box. They grow on a compressive law and never
 * reach the full chart's sizes, so the orbits stay the subject at every size;
 * at and below the default width nothing changes, and today's chart is drawn
 * exactly as it was.
 */

import {
  MAP_BODY_SIZE_DEFAULTS,
  MAP_MARKER_ZOOM_DEFAULTS,
  type MapBodySizeParams,
  type MapMarkerZoomParams,
  type MapSunSizeParams,
} from './mapBodySize';
import { MOBILE_BREAKPOINT_PX } from '../../shared/dom';

/** A rectangle in CSS px, measured from the canvas's top-left. */
export interface MiniChartRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Width at the three layout bands, and the top-left inset each sits at. */
const MINI_WIDE_PX = 200;
const MINI_NARROW_PX = 132;
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
const MINI_NARROW_MAX_W = MOBILE_BREAKPOINT_PX;
const MINI_TINY_MAX_W = 380;
/** However the bands work out, the DEFAULT chart never eats more of the view
 *  than this — a short landscape phone would otherwise wear it like a
 *  blindfold. */
const MINI_MAX_CANVAS_FRAC_W = 0.42;
const MINI_MAX_CANVAS_FRAC_H = 0.28;

// ── The user's size ─────────────────────────────────────────────────────────

/** The size scale's own bounds: what a preference may ask for, before this
 *  canvas has its say. 2.2× the desktop default is a 440 px chart, at which
 *  the inner system reads at a glance; below 0.6× the ship and the inner
 *  planets are one smear. */
export const MINI_SIZE_MIN_SCALE = 0.6;
export const MINI_SIZE_MAX_SCALE = 2.2;
/** Today's chart, by construction: scale 1 is the band's own width. */
export const MINI_SIZE_DEFAULT_SCALE = 1;
/** Legibility floor in CSS px, whatever the scale asks: below this the ship
 *  marker alone is a seventh of the chart. */
const MINI_MIN_WIDTH_PX = 96;
/** The caps a DRAG may reach — looser than the default's, because a user who
 *  pulled the chart out asked for it, and still short of a blindfold: on a
 *  390 × 844 phone the ceiling is a 234 px chart, and in landscape the height
 *  cap binds first. */
const MINI_HARD_CANVAS_FRAC_W = 0.6;
const MINI_HARD_CANVAS_FRAC_H = 0.4;

/** What this canvas allows: the width the layout gives on its own, and the
 *  floor and ceiling a size may be held to. Measured once at a gesture's
 *  start, so a move costs no layout. */
export interface MiniSizeRange {
  /** The band's width after the default caps — the rect at scale 1. */
  defaultWidthPx: number;
  minWidthPx: number;
  maxWidthPx: number;
}

/** The three sizes the ☰ row offers, as scales. A drag lands anywhere between
 *  the floor and the ceiling; the row steps through these. */
export type MiniSizeDetent = 'small' | 'medium' | 'large';
export const MINI_SIZE_DETENTS: readonly { detent: MiniSizeDetent; scale: number; label: string }[] = [
  { detent: 'small', scale: 0.75, label: 'Small' },
  { detent: 'medium', scale: MINI_SIZE_DEFAULT_SCALE, label: 'Medium' },
  { detent: 'large', scale: 1.5, label: 'Large' },
];
/** How near a detent a scale has to be to wear its name. */
const MINI_SIZE_DETENT_EPSILON = 0.02;
/** How near a detent a RELEASED drag has to land to settle on it — a soft
 *  click into Small, Medium or Large, so a chart dragged back to about where
 *  it started reads Medium again rather than 0.98. */
const MINI_SIZE_SNAP_EPSILON = 0.04;

/** A scale a preference or a bridge call handed in, made safe: NaN and the
 *  like read as the default, everything else is held to the scale's bounds. */
export function clampMiniSizeScale(scale: number): number {
  if (!Number.isFinite(scale)) return MINI_SIZE_DEFAULT_SCALE;
  return Math.min(MINI_SIZE_MAX_SCALE, Math.max(MINI_SIZE_MIN_SCALE, scale));
}

/** The band's width and inset for a canvas of this width. */
function miniBand(canvasWidthPx: number): { widthPx: number; leftPx: number } {
  if (canvasWidthPx <= MINI_TINY_MAX_W) return { widthPx: MINI_TINY_PX, leftPx: MINI_TINY_INSET_X };
  if (canvasWidthPx <= MINI_NARROW_MAX_W) return { widthPx: MINI_NARROW_PX, leftPx: MINI_NARROW_INSET_X };
  return { widthPx: MINI_WIDE_PX, leftPx: MINI_WIDE_INSET_X };
}

/** The width the layout gives on its own: the band, shrunk on the binding
 *  axis by the default caps, keeping the shape. Rounded, so it is exactly the
 *  width the rect at scale 1 draws. */
function miniDefaultWidthPx(canvasWidthPx: number, canvasHeightPx: number): number {
  const width = miniBand(canvasWidthPx).widthPx;
  const height = width * MINI_ASPECT_H;
  // Shrink on the binding axis, keeping the shape — a squashed chart would
  // re-fit to a different framing rather than just showing less of the room.
  const shrink = Math.min(
    1,
    (canvasWidthPx * MINI_MAX_CANVAS_FRAC_W) / width,
    (canvasHeightPx * MINI_MAX_CANVAS_FRAC_H) / height,
  );
  return Math.round(width * shrink);
}

export function miniSizeRange(canvasWidthPx: number, canvasHeightPx: number): MiniSizeRange {
  const cw = Math.max(canvasWidthPx, 1);
  const ch = Math.max(canvasHeightPx, 1);
  const defaultWidthPx = miniDefaultWidthPx(cw, ch);
  // The floor never sits above the default: a canvas too small for the
  // legibility floor still gets the chart it always had.
  const minWidthPx = Math.min(
    defaultWidthPx,
    Math.max(MINI_MIN_WIDTH_PX, Math.round(defaultWidthPx * MINI_SIZE_MIN_SCALE)),
  );
  // Nor does the ceiling sit below it: the hard caps are looser than the
  // default's on both axes, so this only ever binds above the default, but
  // the guard says so rather than relying on the two pairs staying ordered.
  const maxWidthPx = Math.max(
    defaultWidthPx,
    Math.min(
      Math.round(defaultWidthPx * MINI_SIZE_MAX_SCALE),
      Math.floor(cw * MINI_HARD_CANVAS_FRAC_W),
      Math.floor((ch * MINI_HARD_CANVAS_FRAC_H) / MINI_ASPECT_H),
    ),
  );
  return { defaultWidthPx, minWidthPx, maxWidthPx };
}

/** The width a scale draws at on this canvas: the default times the scale,
 *  held to the range. */
export function miniWidthForScale(range: MiniSizeRange, scale: number): number {
  const asked = range.defaultWidthPx * clampMiniSizeScale(scale);
  return Math.round(Math.min(range.maxWidthPx, Math.max(range.minWidthPx, asked)));
}

/** The scale a width means on this canvas — what a gesture commits. Held to
 *  the scale's own bounds, so a width the caps cut short still saves as the
 *  size it drew at, and a monitor can honour the rest of the ask. */
export function miniScaleForWidth(range: MiniSizeRange, widthPx: number): number {
  if (!(range.defaultWidthPx > 0)) return MINI_SIZE_DEFAULT_SCALE;
  return clampMiniSizeScale(widthPx / range.defaultWidthPx);
}

/** The detent a scale sits on, or 'custom' between them. */
export function miniSizeDetentAt(scale: number): MiniSizeDetent | 'custom' {
  for (const entry of MINI_SIZE_DETENTS) {
    if (Math.abs(scale - entry.scale) <= MINI_SIZE_DETENT_EPSILON) return entry.detent;
  }
  return 'custom';
}

/** What the ☰ row's button reads for a scale. Plain, in the panel's voice. */
export function miniSizeLabel(scale: number): string {
  const detent = miniSizeDetentAt(scale);
  if (detent === 'custom') return 'Custom';
  return MINI_SIZE_DETENTS.find((entry) => entry.detent === detent)?.label ?? 'Custom';
}

export function miniSizeDetentScale(detent: MiniSizeDetent): number {
  return MINI_SIZE_DETENTS.find((entry) => entry.detent === detent)?.scale ?? MINI_SIZE_DEFAULT_SCALE;
}

/** Where the ☰ row goes from a scale: the next detent round the cycle from
 *  the one it sits on, or — from a dragged, custom size — the first detent
 *  above it, wrapping to Small past Large. So one press from a chart pulled a
 *  little past Medium reads Large, which is the nearest thing to what the
 *  user was reaching for. */
export function nextMiniSizeDetent(scale: number): MiniSizeDetent {
  const at = miniSizeDetentAt(scale);
  if (at !== 'custom') {
    const index = MINI_SIZE_DETENTS.findIndex((entry) => entry.detent === at);
    return MINI_SIZE_DETENTS[(index + 1) % MINI_SIZE_DETENTS.length].detent;
  }
  const above = MINI_SIZE_DETENTS.find((entry) => entry.scale > scale);
  return above ? above.detent : MINI_SIZE_DETENTS[0].detent;
}

/**
 * The width a corner drag asks for. The grip is the bottom-right corner and
 * the shape is fixed, so the pointer's two axes have to agree on one width:
 * the dominant one wins, measured in width (the vertical travel divided by
 * the aspect), so a pull straight down grows the chart as surely as a pull
 * to the right, and a diagonal pull keeps the corner under the finger.
 */
export function miniDragWidth(startWidthPx: number, dxPx: number, dyPx: number): number {
  const byX = dxPx;
  const byY = dyPx / MINI_ASPECT_H;
  return startWidthPx + (Math.abs(byX) >= Math.abs(byY) ? byX : byY);
}

/** The width a pinch asks for: the chart scales with the distance between
 *  the two fingers. A degenerate distance (the fingers on one point) asks for
 *  nothing. */
export function miniPinchWidth(startWidthPx: number, startDistancePx: number, distancePx: number): number {
  if (!(startDistancePx > 0) || !(distancePx > 0)) return startWidthPx;
  return startWidthPx * (distancePx / startDistancePx);
}

/** Where a released gesture settles: on a detent it landed near, else where
 *  the finger left it. */
export function miniReleaseScale(scale: number): number {
  for (const entry of MINI_SIZE_DETENTS) {
    if (Math.abs(scale - entry.scale) <= MINI_SIZE_SNAP_EPSILON) return entry.scale;
  }
  return clampMiniSizeScale(scale);
}

/** The same settle, in the width a gesture works in. */
export function miniReleaseWidth(range: MiniSizeRange, widthPx: number): number {
  return miniWidthForScale(range, miniReleaseScale(miniScaleForWidth(range, widthPx)));
}

/** The compressive law the marks grow on: at twice the width they are about
 *  1.5× their size, and at the scale's ceiling about 1.6× — under the full
 *  chart's on every mark. */
const MINI_PRESENTATION_GAMMA = 0.6;

/**
 * How much bigger the marks draw for a chart of this width. Exactly 1 at and
 * below the default width, so today's chart is drawn as it was; above it the
 * law above, capped where the scale caps.
 */
export function miniPresentationScale(widthPx: number, defaultWidthPx: number): number {
  if (!(widthPx > 0) || !(defaultWidthPx > 0)) return 1;
  const ratio = widthPx / defaultWidthPx;
  if (!(ratio > 1)) return 1;
  return Math.pow(Math.min(ratio, MINI_SIZE_MAX_SCALE), MINI_PRESENTATION_GAMMA);
}

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
 * The marks a chart of a given presentation scale draws with: the mini's own
 * size policy with its floor and cap scaled, its Sun, its ship, and how much
 * the orbit lines thicken. Gamma and the reference radius are the full
 * chart's, untouched — the mini stays a shrunk copy of that policy at every
 * size, never a different one. The lines take the square root of the scale:
 * the orbit is the subject, and a line that thickened as fast as the marks
 * would read as a heavier chart rather than a bigger one.
 */
export interface MiniMarkSizes {
  body: MapBodySizeParams;
  sun: MapSunSizeParams;
  /** The ship marker's full sprite extent, screen px. */
  shipPx: number;
  /** Multiplier on the orbit material's authored line width. */
  lineWidthScale: number;
}

export function miniMarkSizes(presentationScale: number): MiniMarkSizes {
  const s = Number.isFinite(presentationScale) && presentationScale > 0 ? presentationScale : 1;
  return {
    body: { ...MINI_BODY_SIZE_PARAMS, minPx: MINI_BODY_SIZE_PARAMS.minPx * s, maxPx: MINI_BODY_SIZE_PARAMS.maxPx * s },
    sun: { ...MINI_SUN_SIZE_PARAMS, pivotPx: MINI_SUN_SIZE_PARAMS.pivotPx * s, floorPx: MINI_SUN_SIZE_PARAMS.floorPx * s },
    shipPx: MINI_SHIP_PX * s,
    lineWidthScale: Math.sqrt(s),
  };
}

/**
 * Where the chart sits for a canvas of this size, at a size scale. One
 * definition: the WebGL scissor rectangle and the DOM surface that frames it
 * and takes the tap are both written from this, so they cannot drift apart.
 * At scale 1 it is the band's own rect, exactly as it was.
 */
export function miniChartRect(
  canvasWidthPx: number,
  canvasHeightPx: number,
  sizeScale: number = MINI_SIZE_DEFAULT_SCALE,
): MiniChartRect {
  const cw = Math.max(canvasWidthPx, 1);
  const ch = Math.max(canvasHeightPx, 1);
  const width = miniWidthForScale(miniSizeRange(cw, ch), sizeScale);
  const height = Math.round(width * MINI_ASPECT_H);
  return { left: miniBand(cw).leftPx, top: MINI_INSET_Y, width, height };
}

/**
 * The chart as chrome the body labels may not print into. The label layer
 * sits above the canvas the chart is drawn on, so a planet's, a moon's or the
 * Sun's name whose box lands on the chart would sit across its orbits; every
 * label pass takes this rectangle as a keep-out. A small margin keeps a name
 * from kissing the frame.
 */
export const MINI_LABEL_KEEP_OUT_MARGIN_PX = 6;

export interface MiniKeepOutRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Write the chart's keep-out for `rect` into `out` (the label passes' own
 *  rect shape, top-left in CSS px) and hand it back — no allocation on a
 *  rect rebuild. */
export function writeMiniKeepOut(rect: MiniChartRect, out: MiniKeepOutRect): MiniKeepOutRect {
  out.x = rect.left - MINI_LABEL_KEEP_OUT_MARGIN_PX;
  out.y = rect.top - MINI_LABEL_KEEP_OUT_MARGIN_PX;
  out.w = rect.width + 2 * MINI_LABEL_KEEP_OUT_MARGIN_PX;
  out.h = rect.height + 2 * MINI_LABEL_KEEP_OUT_MARGIN_PX;
  return out;
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
 * Whether the cached rectangle was built for a different canvas or size. The
 * rect is a pure function of the canvas size and the size scale, so it is
 * rebuilt when — and only when — one of those changes; every other frame
 * reuses the object, which is what keeps the steady state free of allocation.
 * A drag changes the scale every frame it moves, and rebuilds on every one of
 * those: that is the gesture's cost, not the steady state's.
 */
export function miniRectStale(
  cachedWidthPx: number,
  cachedHeightPx: number,
  cachedSizeScale: number,
  widthPx: number,
  heightPx: number,
  sizeScale: number,
): boolean {
  return cachedWidthPx !== widthPx || cachedHeightPx !== heightPx || cachedSizeScale !== sizeScale;
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
