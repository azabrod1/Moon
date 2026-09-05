/**
 * The smoothed frame interval that frame-sliced work budgets itself against.
 *
 * The texture warm pump and the atmosphere bake each take a share of a frame,
 * and the share is a share of THIS — an exponential average of the intervals
 * the mode has actually been delivered — so a 60 Hz machine and a 120 Hz one
 * each get a share of their own frame instead of a constant that is generous
 * on one and ruinous on the other. It is averaged rather than read live, and
 * a single hitch is clamped before folding in, because otherwise one late
 * frame would raise the estimate and licence more work on exactly the frames
 * that are already late.
 *
 * A long frame is CLAMPED into the average rather than dropped, and that is
 * deliberate in both directions. It must not be taken whole, or one hitch
 * would licence more work on frames that are already late. But it must not be
 * discarded either: a burst of long frames is the app working hard — a boot,
 * an arrival under the veil — and letting the average rise there is what hands
 * the warm pump its full budget while frames are long anyway, so the uploads
 * are paid under the cut instead of spilling into the frames after it.
 * Dropping those gaps instead was measured, and it starves the pump: the
 * sector-tile uploads move out from under the arrival veil into the near band,
 * and earth-near goes from no upload over budget to ten.
 *
 * The one case where a gap is not evidence about the app at all is a tab that
 * was not being shown. A hidden or occluded tab still gets frames — one a
 * second where the browser throttles rather than stops — and clamped in at
 * 40 ms apiece those take the average from 8.3 ms to about 21 ms in ten
 * seconds. The bake's slice budget is 0.35 of the interval with no cap of its
 * own, so a bake resuming in the foreground would then size 7.4 ms slices
 * against 8.3 ms frames, and keep doing it for the sixty-odd frames the
 * average needs to decay back. So the tracker is told when the document
 * becomes visible again, and takes the first frame after that whole. Only the
 * visibility transition does this, because only there is the run of long gaps
 * known to say nothing about how hard the app is working.
 */

/** Below this, a reported gap is noise rather than a frame. */
export const FRAME_INTERVAL_MIN_MS = 4;
/** Above this, a gap is not a display interval: no display refreshes slower
 *  than 25 Hz, so anything longer is a stall, a throttle or a resume. */
export const FRAME_INTERVAL_MAX_MS = 40;
/** How fast the average follows. At 0.05 a step change is 95 % absorbed in
 *  about sixty frames, which is also how long a corrupted average takes to
 *  clear — the reason the long gaps are dropped rather than let in. */
export const FRAME_INTERVAL_EMA_ALPHA = 0.05;
/** Frames needed to absorb 95 % of a step change — ln(0.05) / ln(1 - alpha).
 *  It is how fast the average follows a display that really did change, and
 *  equally how long a corrupted one would stay wrong, which is what makes
 *  dropping the impossible gaps worth more than clamping them. */
export const FRAME_INTERVAL_ALPHA_FRAMES_TO_SETTLE =
  Math.round(Math.log(0.05) / Math.log(1 - FRAME_INTERVAL_EMA_ALPHA));

/**
 * Holds the average across frames. Mutable and allocation-free on purpose:
 * this is stepped once per frame on the render path.
 */
export class FrameIntervalTracker {
  private valueMs: number;
  /** Set only by resume(): the next frame is taken whole rather than blended,
   *  because what came before it was measured while nothing was on screen. */
  private seeding = false;

  constructor(seedMs = 16.7) {
    this.valueMs = seedMs;
  }

  /** The current average, in ms. */
  get ms(): number {
    return this.valueMs;
  }

  /** Whether the next frame will be taken whole. */
  get reseeding(): boolean {
    return this.seeding;
  }

  /** The document is being shown again: forget what was measured while it was
   *  not, by believing the next frame outright. */
  resume(): void {
    this.seeding = true;
  }

  /** Fold in one frame's raw duration and return the new average. */
  observe(rawDtMs: number): number {
    if (!Number.isFinite(rawDtMs)) return this.valueMs;
    const seen = Math.min(FRAME_INTERVAL_MAX_MS, Math.max(FRAME_INTERVAL_MIN_MS, rawDtMs));
    this.valueMs = this.seeding
      ? seen
      : this.valueMs + (seen - this.valueMs) * FRAME_INTERVAL_EMA_ALPHA;
    this.seeding = false;
    return this.valueMs;
  }
}
