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

export class MapLabelPlacer {
  private readonly x: Float32Array;
  private readonly y: Float32Array;
  private count = 0;

  constructor(capacity: number) {
    const n = Math.max(1, Math.floor(capacity));
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
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
   * Whether a label anchored at (x, y) may draw: true when it clears every
   * label already recorded this frame by `minSepPx`. A label that may draw is
   * recorded, up to capacity.
   */
  place(x: number, y: number, minSepPx: number = LABEL_MIN_SEP_PX): boolean {
    const min2 = minSepPx * minSepPx;
    for (let i = 0; i < this.count; i++) {
      const dx = x - this.x[i];
      const dy = y - this.y[i];
      if (dx * dx + dy * dy < min2) return false;
    }
    if (this.count < this.x.length) {
      this.x[this.count] = x;
      this.y[this.count] = y;
      this.count++;
    }
    return true;
  }
}
