/**
 * Pure geometry for the tutorial's spotlight layer and for composing a stop's
 * subject around the chrome. DOM-free and camera-free so every placement is
 * unit-testable: the cutout the mask opens around a control, which side of it
 * the coach bubble takes, the largest free rectangle left between the card,
 * the cluster and the bars, and how large a subject fits inside that
 * rectangle. ui/TutorialSpotlight.ts draws the layer; PlanetariumMode poses
 * the scene from the fit.
 */

/** A screen rectangle in CSS pixels, origin top-left. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Breathing room the cutout adds around the control it rings. */
export const SPOTLIGHT_CUTOUT_PAD_PX = 6;
/** Corner radius of the cutout and its ring. */
export const SPOTLIGHT_CUTOUT_RADIUS_PX = 11;
/** Gap between the cutout's edge and the bubble's arrow tip. */
export const BUBBLE_GAP_PX = 12;
/** The bubble never comes closer than this to the viewport's edge. */
export const BUBBLE_MARGIN_PX = 8;
/** The arrow keeps this far from the bubble's corners along its edge. */
export const BUBBLE_ARROW_INSET_PX = 14;

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Whether `inner` lies inside `outer`, allowing `tolerancePx` of spill on every edge. */
export function rectInside(inner: Rect, outer: Rect, tolerancePx = 0): boolean {
  return (
    inner.x >= outer.x - tolerancePx &&
    inner.y >= outer.y - tolerancePx &&
    inner.x + inner.w <= outer.x + outer.w + tolerancePx &&
    inner.y + inner.h <= outer.y + outer.h + tolerancePx
  );
}

export function rectCentre(rect: Rect): { x: number; y: number } {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

/** The cutout around a control: padded outward, then held inside the viewport. */
export function spotlightCutout(target: Rect, viewport: Rect, pad = SPOTLIGHT_CUTOUT_PAD_PX): Rect {
  const left = Math.max(viewport.x, target.x - pad);
  const top = Math.max(viewport.y, target.y - pad);
  const right = Math.min(viewport.x + viewport.w, target.x + target.w + pad);
  const bottom = Math.min(viewport.y + viewport.h, target.y + target.h + pad);
  return { x: left, y: top, w: Math.max(0, right - left), h: Math.max(0, bottom - top) };
}

export type BubbleSide = 'below' | 'above' | 'left' | 'right';

export interface BubblePlacement {
  /** The bubble's top-left. */
  x: number;
  y: number;
  /** Which side of the cutout the bubble sits on; the arrow points back across the gap. */
  side: BubbleSide;
  /** The arrow's position along the bubble's edge facing the cutout: px from
   *  the bubble's left edge for above/below, from its top edge for left/right. */
  arrow: number;
}

export const DEFAULT_BUBBLE_SIDES: readonly BubbleSide[] = ['below', 'above', 'left', 'right'];

/**
 * Place the coach bubble beside a cutout. Sides are tried in order; the first
 * whose bubble fits inside the viewport and overlaps none of the `avoid`
 * rectangles (the narrator card, above all) wins. When every side collides
 * with something, the side that fits the viewport with the least overlap is
 * taken rather than none, so the bubble is always on screen. The arrow is
 * aimed at the cutout's centre and kept off the bubble's corners.
 */
export function placeBubble(args: {
  cutout: Rect;
  size: { w: number; h: number };
  viewport: Rect;
  avoid: readonly Rect[];
  sides?: readonly BubbleSide[];
  gap?: number;
  margin?: number;
}): BubblePlacement {
  const { cutout, size, viewport } = args;
  const gap = args.gap ?? BUBBLE_GAP_PX;
  const margin = args.margin ?? BUBBLE_MARGIN_PX;
  const sides = args.sides ?? DEFAULT_BUBBLE_SIDES;
  const centre = rectCentre(cutout);
  const minX = viewport.x + margin;
  const maxX = viewport.x + viewport.w - margin - size.w;
  const minY = viewport.y + margin;
  const maxY = viewport.y + viewport.h - margin - size.h;
  const clampX = (x: number) => Math.min(Math.max(x, minX), Math.max(minX, maxX));
  const clampY = (y: number) => Math.min(Math.max(y, minY), Math.max(minY, maxY));

  let best: { placement: BubblePlacement; overlap: number } | null = null;
  for (const side of sides) {
    let x: number;
    let y: number;
    switch (side) {
      case 'below':
        x = clampX(centre.x - size.w / 2);
        y = cutout.y + cutout.h + gap;
        break;
      case 'above':
        x = clampX(centre.x - size.w / 2);
        y = cutout.y - gap - size.h;
        break;
      case 'left':
        x = cutout.x - gap - size.w;
        y = clampY(centre.y - size.h / 2);
        break;
      case 'right':
        x = cutout.x + cutout.w + gap;
        y = clampY(centre.y - size.h / 2);
        break;
    }
    // A side whose bubble would leave the viewport is no side at all; the
    // perpendicular axis was clamped, so only the facing axis can fail here.
    if (x < minX || x > maxX || y < minY || y > maxY) continue;
    const rect = { x, y, w: size.w, h: size.h };
    let overlap = 0;
    for (const other of args.avoid) overlap += overlapArea(rect, other);
    const arrow =
      side === 'below' || side === 'above'
        ? clampArrow(centre.x - x, size.w)
        : clampArrow(centre.y - y, size.h);
    const placement = { x, y, side, arrow };
    if (overlap === 0) return placement;
    if (!best || overlap < best.overlap) best = { placement, overlap };
  }
  if (best) return best.placement;
  // Nothing fits (a viewport smaller than the bubble): pin it below, clamped.
  const x = clampX(centre.x - size.w / 2);
  const y = clampY(cutout.y + cutout.h + gap);
  return { x, y, side: 'below', arrow: clampArrow(centre.x - x, size.w) };
}

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function clampArrow(along: number, extent: number): number {
  const inset = Math.min(BUBBLE_ARROW_INSET_PX, extent / 2);
  return Math.min(Math.max(along, inset), extent - inset);
}

/**
 * The largest rectangle inside `viewport` that touches none of the
 * `obstacles`, inset by `margin` on every side. The candidates are every
 * span between obstacle edges, so with the handful of chrome pieces a screen
 * has (the card, the cluster, the bars) the search is exhaustive and cheap.
 * The winner is the one whose shorter side is longest: a subject is fitted
 * as a disc, so a long thin strip is worth less than a squarer area. Area
 * breaks ties. Obstacles with no size are ignored.
 */
export function largestFreeRect(viewport: Rect, obstacles: readonly Rect[], margin = 0): Rect {
  const blocks = obstacles.filter((rect) => rect.w > 0 && rect.h > 0 && rectsOverlap(rect, viewport));
  const xs = new Set<number>([viewport.x, viewport.x + viewport.w]);
  const ys = new Set<number>([viewport.y, viewport.y + viewport.h]);
  for (const block of blocks) {
    for (const x of [block.x, block.x + block.w]) {
      if (x > viewport.x && x < viewport.x + viewport.w) xs.add(x);
    }
    for (const y of [block.y, block.y + block.h]) {
      if (y > viewport.y && y < viewport.y + viewport.h) ys.add(y);
    }
  }
  const xList = [...xs].sort((a, b) => a - b);
  const yList = [...ys].sort((a, b) => a - b);
  let best: Rect = { x: viewport.x, y: viewport.y, w: 0, h: 0 };
  let bestShort = -1;
  let bestArea = -1;
  for (let i = 0; i < xList.length; i++) {
    for (let j = i + 1; j < xList.length; j++) {
      const w = xList[j] - xList[i];
      for (let k = 0; k < yList.length; k++) {
        for (let l = k + 1; l < yList.length; l++) {
          const h = yList[l] - yList[k];
          const shortSide = Math.min(w, h);
          const area = w * h;
          if (shortSide < bestShort || (shortSide === bestShort && area <= bestArea)) continue;
          const candidate = { x: xList[i], y: yList[k], w, h };
          if (blocks.some((block) => overlapArea(candidate, block) > 0)) continue;
          best = candidate;
          bestShort = shortSide;
          bestArea = area;
        }
      }
    }
  }
  return {
    x: best.x + margin,
    y: best.y + margin,
    w: Math.max(0, best.w - margin * 2),
    h: Math.max(0, best.h - margin * 2),
  };
}

/** How much of the free rectangle's shorter side a stop's subject spans. */
export const SUBJECT_FIT_FRACTION = 0.62;

/** Where a subject goes inside a free rectangle, and how wide: centred, spanning the fit fraction of the shorter side. */
export function subjectFrame(
  free: Rect,
  fitFraction = SUBJECT_FIT_FRACTION,
): { x: number; y: number; diameterPx: number } {
  const centre = rectCentre(free);
  return { x: centre.x, y: centre.y, diameterPx: Math.max(1, Math.min(free.w, free.h) * fitFraction) };
}

/**
 * The distance at which a sphere of `radius` subtends `diameterPx` of a
 * viewport `viewportHeightPx` tall shown at `displayFovDeg` (vertical).
 * Rectilinear at the frame centre; the lens bends the off-axis answer, which
 * the caller corrects by measuring the projection and scaling.
 */
export function distanceForDiameter(
  radius: number,
  diameterPx: number,
  displayFovDeg: number,
  viewportHeightPx: number,
): number {
  const fovRad = (displayFovDeg * Math.PI) / 180;
  const angular = Math.max(1e-6, (diameterPx / Math.max(1, viewportHeightPx)) * fovRad);
  const halfAngle = Math.min(angular / 2, Math.PI / 2 - 1e-6);
  return radius / Math.sin(halfAngle);
}

/** A screen error in pixels as the turn that would cancel it, in radians, at the frame centre's scale. */
export function angularErrorRad(errorPx: number, displayFovDeg: number, viewportHeightPx: number): number {
  const fovRad = (displayFovDeg * Math.PI) / 180;
  return (errorPx / Math.max(1, viewportHeightPx)) * fovRad;
}
