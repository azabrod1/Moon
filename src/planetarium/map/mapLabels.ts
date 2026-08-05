/**
 * Screen-space de-overlap for the map's labels — pure, no DOM.
 *
 * Labels are offered in priority order (the Sun first, then bodies outward), and
 * one that lands too close to a label already placed this frame yields. The
 * placed positions live in preallocated arrays so a frame allocates nothing.
 *
 * Capacity is the sharp edge: a pool smaller than the number of labels offered
 * would drop every later position on the floor, and a comparison against a
 * dropped position is a comparison against NaN — which is false, so EVERY
 * remaining label would pass and the de-overlap would quietly stop working
 * altogether. This placer instead keeps culling against what it did record and
 * only stops recording, so a pool too small degrades to partial culling rather
 * than to none. Size it from the whole roster and it never binds.
 */

/** A label whose anchor lands within this many screen px of an already-placed
 *  one hides this frame — the true-scale inner four otherwise stack. */
export const LABEL_MIN_SEP_PX = 26;

/** How far below a body's centre a label sits when the body's own marker is
 *  small enough not to matter. The historical flat offset, and still the floor. */
export const LABEL_ANCHOR_OFFSET_PX = 9;
/** Air between the edge of a marker and the top of its label. */
export const LABEL_CLEARANCE_PX = 2;

/**
 * Where a body's label sits below its centre, in screen px.
 *
 * A flat offset works only while every marker is the same size. Once a body's
 * marker follows the size policy the largest of them are wider than the offset,
 * and a flat rule starts the name inside the body it names — so the offset
 * clears whatever the body paints, and never drops below the flat floor for the
 * small ones.
 *
 * `drawnRadiusPx` is the body's painted radius under the size policy, or null
 * for a body with no drawn radius of its own — a moon, whose marker is sized
 * against its parent and already sits well inside the floor.
 */
export function mapLabelOffsetPx(drawnRadiusPx: number | null): number {
  if (drawnRadiusPx === null || !(drawnRadiusPx > 0)) return LABEL_ANCHOR_OFFSET_PX;
  return Math.max(LABEL_ANCHOR_OFFSET_PX, drawnRadiusPx + LABEL_CLEARANCE_PX);
}

/** Half-width to assume for a label that could not be measured at all — a
 *  guard, not a working value: the placer measures every label before it judges
 *  one, so this stands in only if a read comes back empty. Set to cover the
 *  widest label the chart can draw ("Prometheus", 64 px, half 32 in both
 *  engines) with margin, because a fallback that under-covers is a label lying
 *  across its neighbour, while one that over-covers only yields a place it
 *  could have taken. The QA pins it against the measured roster. */
export const LABEL_NOMINAL_HALF_WIDTH_PX = 36;
/** Line box of a `.map-label`, pinned in CSS so the vertical half of the
 *  rectangle test means the same thing in both engines. */
export const LABEL_LINE_HEIGHT_PX = 14;
/** Air demanded around a label box before its neighbour may draw. */
export const LABEL_BOX_PAD_PX = 3;

/** Air between a label box and the viewport's side edges, and between the box
 *  and the bottom chrome band. */
export const LABEL_EDGE_PAD_PX = 4;

/**
 * The label centre, slid sideways just far enough that its box stays whole on
 * the frame. "Titan" half off the right edge is a clipped name that reads as a
 * bug; the same name pinned at the edge under its body reads as a label doing
 * its best. A viewport too narrow for the box at all parks it centred — there
 * is no x that satisfies both edges, and centred loses the least.
 */
export function clampLabelCenterXPx(
  xPx: number,
  halfWidthPx: number,
  viewportWPx: number,
  padPx: number = LABEL_EDGE_PAD_PX,
): number {
  const lo = halfWidthPx + padPx;
  const hi = viewportWPx - halfWidthPx - padPx;
  if (lo > hi) return viewportWPx / 2;
  return Math.min(Math.max(xPx, lo), hi);
}

/**
 * The lowest box-top a label may draw at, given where the bottom chrome band
 * begins. A name sliding under the scale control or the world bar is unreadable
 * where it matters and painted where nothing should be — so the band excludes
 * it, and the exclusion is measured from the chrome actually on screen, not
 * from CSS numbers restated here. `chromeTopPx` null means nothing was
 * measured; the viewport bottom then stands in.
 */
export function labelMaxBoxTopPx(chromeTopPx: number | null, viewportHPx: number): number {
  const limit = chromeTopPx ?? viewportHPx;
  return limit - LABEL_EDGE_PAD_PX - LABEL_LINE_HEIGHT_PX;
}

/** Below this drawn radius a body is a speck, and a full-size name on a speck
 *  points at nothing the eye can find — the label waits until the marker is
 *  worth naming. Planets never trip it (their marker floor is ~6 px); this is
 *  the true-scale and far-follow regimes, where moons drop to their real size. */
export const LABEL_MIN_BODY_RADIUS_PX = 1.5;

/** Whether a body's marker is big enough to carry a name. Null — a body whose
 *  drawn size the caller cannot resolve — passes: hiding a label on missing
 *  information would hide real names, while showing one costs a speck a name. */
export function labelWorthDrawing(
  drawnRadiusPx: number | null,
  minRadiusPx: number = LABEL_MIN_BODY_RADIUS_PX,
): boolean {
  return drawnRadiusPx === null || drawnRadiusPx >= minRadiusPx;
}

/** A projected annulus whose minor semi-axis is thinner than this many px is
 *  not worth dodging: near edge-on the ring is a sliver a name can cross
 *  legibly — and treating it as a region would fling coplanar moons' labels to
 *  the ring's distant tip, since their normalized radius stays finite while
 *  the annulus itself has collapsed. */
export const RING_DODGE_MIN_MINOR_PX = LABEL_LINE_HEIGHT_PX;

/**
 * Where an inner moon's label goes when straight-down would land it on the
 * parent's drawn ring annulus — Saturn's inner family lives entirely inside
 * the rings, and a name printed across them is unreadable against the texture.
 *
 * The projected ring is treated as an ellipse about the parent: `minorDir` is
 * the screen direction of the projected pole (the minor axis), `minorMajorRatio`
 * its foreshortening (1 face-on, →0 edge-on), `outerRadiusPx` the outer edge
 * along the major axis. The moon's position relative to the parent is measured
 * in that frame; a moon outside the outer edge keeps its ordinary label and
 * this returns false. Inside, the label slides RADIALLY OUTWARD (in the
 * ellipse's own normalized sense, so the exit is the nearest one) to just past
 * the outer edge — and never less than `minShiftPx`, the moon's own marker
 * clearance, so a moon already near the edge still clears its own dot.
 *
 * What exits is the BOX, not a point: the label's rectangle (2·halfWidth wide,
 * one line tall, hung below the placed point) is cleared IN THE NORMALIZED
 * FRAME, where the ellipse is a circle and the tangent argument is exact —
 * the box's four corners are mapped through the same rotation-and-stretch the
 * moon's position was, their support against the inward direction taken, and
 * the exit radius extended by it. Every corner then sits beyond the tangent
 * line at the exit point, and past a circle's tangent is past the circle;
 * working in screen space instead would clear only the face-on case, and a
 * foreshortened ring would keep a corner of the box inside the annulus. The
 * near-edge-on regime is inert regardless: an annulus thinner than
 * `minMinorExtentPx` is a sliver nothing needs to dodge, which also keeps
 * coplanar moons off the collapsed ring's distant tip.
 *
 * A moon at the parent's own centre has no direction to speak of and takes
 * straight down.
 *
 * `out` receives the offset of the label's placed point (its box's top-centre)
 * from the moon's anchor, in screen px — box clearance already included.
 */
export function ringClearedLabelShiftPx(
  relXPx: number,
  relYPx: number,
  outerRadiusPx: number,
  minorMajorRatio: number,
  minorDirXPx: number,
  minorDirYPx: number,
  minShiftPx: number,
  halfWidthPx: number,
  lineHeightPx: number,
  out: { x: number; y: number },
  padPx: number = LABEL_EDGE_PAD_PX,
  minMinorExtentPx: number = RING_DODGE_MIN_MINOR_PX,
): boolean {
  out.x = 0;
  out.y = 0;
  if (!(outerRadiusPx > 0) || !(minorMajorRatio > 0)) return false;
  if (!(outerRadiusPx * minorMajorRatio > minMinorExtentPx)) return false;
  const mLen = Math.hypot(minorDirXPx, minorDirYPx);
  // No usable minor direction = a face-on ring in disguise; treat axes as any
  // orthogonal pair (the ellipse is a circle, the frame does not matter).
  const mx = mLen > 1e-9 ? minorDirXPx / mLen : 0;
  const my = mLen > 1e-9 ? minorDirYPx / mLen : 1;
  // Major axis: the perpendicular.
  const Mx = -my;
  const My = mx;
  const u = relXPx * Mx + relYPx * My;
  const v = relXPx * mx + relYPx * my;
  const vn = v / minorMajorRatio;
  const rho = Math.hypot(u, vn);
  if (rho >= outerRadiusPx) return false;
  if (rho < 1e-6) {
    // The parent's own pixel — no outward direction exists. Straight down: the
    // box's top edge is its near edge, so the point clearance is the box's.
    out.y = Math.max(outerRadiusPx * minorMajorRatio + padPx, minShiftPx);
    return true;
  }
  // The exit direction, normalized-frame unit vector: the boundary there is a
  // CIRCLE, so a box whose every corner sits past the tangent line at the exit
  // point sits past the boundary — the tangent argument is exact, where a
  // screen-space support would only be right face-on.
  const dU = u / rho;
  const dV = vn / rho;
  // The box's four corners relative to its placed point (top-centre), mapped
  // through the same frame the moon was: rotate into the ellipse's axes, then
  // stretch the minor share by 1/ratio. Support = how far the box reaches back
  // toward the ring against the exit direction; unrolled, so a per-frame call
  // allocates nothing.
  let support = 0;
  for (let corner = 0; corner < 4; corner++) {
    const cx = corner & 1 ? halfWidthPx : -halfWidthPx;
    const cy = corner & 2 ? lineHeightPx : 0;
    const cu = cx * Mx + cy * My;
    const cv = (cx * mx + cy * my) / minorMajorRatio;
    const reach = -(cu * dU + cv * dV);
    if (reach > support) support = reach;
  }
  // Walk out along the same normalized ray to the boundary plus pad plus the
  // box's own reach, and map back to the screen.
  const s = (outerRadiusPx + padPx + support) / rho;
  const bx = (u * s) * Mx + (v * s) * mx;
  const by = (u * s) * My + (v * s) * my;
  let dx = bx - relXPx;
  let dy = by - relYPx;
  const len = Math.hypot(dx, dy);
  if (len < minShiftPx && len > 1e-9) {
    const grow = minShiftPx / len;
    dx *= grow;
    dy *= grow;
  }
  out.x = dx;
  out.y = dy;
  return true;
}

export class MapLabelPlacer {
  private readonly x: Float32Array;
  private readonly y: Float32Array;
  /** The drawn box of each placed label: centre x, top y, half-width. Kept
   *  apart from the anchor above — a clamp or a ring dodge moves the box while
   *  the body it names stays put, and each test reads its own point. */
  private readonly boxX: Float32Array;
  private readonly boxTop: Float32Array;
  private readonly boxHalf: Float32Array;
  private count = 0;

  constructor(capacity: number) {
    const n = Math.max(1, Math.floor(capacity));
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.boxX = new Float32Array(n);
    this.boxTop = new Float32Array(n);
    this.boxHalf = new Float32Array(n);
  }

  /** Start a frame: nothing is placed yet. */
  begin(): void {
    this.count = 0;
  }

  /** How many labels have been recorded this frame. */
  get placed(): number {
    return this.count;
  }

  /** The pool's capacity, so a caller can size itself against the roster. */
  get capacity(): number {
    return this.x.length;
  }

  /**
   * Whether a label may draw, on two tests it has to pass both of.
   *
   * The ANCHOR test is the old one, unchanged: bodies whose centres crowd each
   * other yield in priority order, whatever their names happen to be. That is
   * what keeps the true-scale inner four from stacking.
   *
   * The BOX test is the new one, and it is over the rectangle the label is
   * actually DRAWN in — `boxCenterX` across, `boxTop` down through one line —
   * not over the body's centre. Once the vertical offset varies by body (a big
   * marker pushes its name further down), the anchor and the label are
   * different points, and a text box can sit clean of every anchor while lying
   * straight across a neighbour's name. Rejects only when the two rectangles
   * overlap on BOTH axes, so a name directly above another still draws.
   *
   * The two tests take two different x's on purpose. An edge clamp or a ring
   * dodge moves the BOX while the body it names stays put — judging the anchor
   * test at the moved x builds a hybrid point that is nobody's position, close
   * enough to a neighbour's anchor to hide a label whose body and box are both
   * well clear.
   *
   * `halfWidthPx` is the label's measured half-width; a caller with nothing
   * measured yet passes the nominal one. A label that may draw is recorded, up
   * to capacity.
   */
  place(
    x: number,
    y: number,
    boxCenterX: number = x,
    boxTop: number = y,
    halfWidthPx: number = 0,
    minSepPx: number = LABEL_MIN_SEP_PX,
  ): boolean {
    const min2 = minSepPx * minSepPx;
    const boxBottom = boxTop + LABEL_LINE_HEIGHT_PX;
    for (let i = 0; i < this.count; i++) {
      const dx = x - this.x[i];
      const dy = y - this.y[i];
      if (dx * dx + dy * dy < min2) return false;
      // Rectangles, both grown by half the pad so the gap between them is the
      // pad rather than twice it.
      if (halfWidthPx > 0 || this.boxHalf[i] > 0) {
        const overlapX =
          Math.abs(boxCenterX - this.boxX[i]) < halfWidthPx + this.boxHalf[i] + LABEL_BOX_PAD_PX;
        const overlapY = boxTop < this.boxTop[i] + LABEL_LINE_HEIGHT_PX + LABEL_BOX_PAD_PX
          && boxBottom + LABEL_BOX_PAD_PX > this.boxTop[i];
        if (overlapX && overlapY) return false;
      }
    }
    if (this.count < this.x.length) {
      this.x[this.count] = x;
      this.y[this.count] = y;
      this.boxX[this.count] = boxCenterX;
      this.boxTop[this.count] = boxTop;
      this.boxHalf[this.count] = halfWidthPx;
      this.count++;
    }
    return true;
  }
}
