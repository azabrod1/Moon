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

export class MapLabelPlacer {
  private readonly x: Float32Array;
  private readonly y: Float32Array;
  /** The drawn box of each placed label: centre x, top y, half-width. */
  private readonly boxTop: Float32Array;
  private readonly boxHalf: Float32Array;
  private count = 0;

  constructor(capacity: number) {
    const n = Math.max(1, Math.floor(capacity));
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
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
   * actually DRAWN in — centre x, `boxTop` down through one line — not over the
   * body's centre. Once the vertical offset varies by body (a big marker pushes
   * its name further down), the anchor and the label are different points, and
   * a text box can sit clean of every anchor while lying straight across a
   * neighbour's name. Rejects only when the two rectangles overlap on BOTH
   * axes, so a name directly above another still draws.
   *
   * `halfWidthPx` is the label's measured half-width; a caller with nothing
   * measured yet passes the nominal one. A label that may draw is recorded, up
   * to capacity.
   */
  place(
    x: number,
    y: number,
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
        const overlapX = Math.abs(x - this.x[i]) < halfWidthPx + this.boxHalf[i] + LABEL_BOX_PAD_PX;
        const overlapY = boxTop < this.boxTop[i] + LABEL_LINE_HEIGHT_PX + LABEL_BOX_PAD_PX
          && boxBottom + LABEL_BOX_PAD_PX > this.boxTop[i];
        if (overlapX && overlapY) return false;
      }
    }
    if (this.count < this.x.length) {
      this.x[this.count] = x;
      this.y[this.count] = y;
      this.boxTop[this.count] = boxTop;
      this.boxHalf[this.count] = halfWidthPx;
      this.count++;
    }
    return true;
  }
}
