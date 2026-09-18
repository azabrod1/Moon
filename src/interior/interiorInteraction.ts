/**
 * The tap recognizer of the Look-inside tool: which pointer gesture on the
 * canvas is a tap (pin the region under it) and which is a drag or a pinch
 * (the orbit's, with nothing to pin). Pure: it is fed pointer events as plain
 * samples, holds one candidate at a time and answers on the up.
 *
 * A candidate is the first pointer down while no other is held, from a
 * primary button. It is cancelled for good — a return to where it started
 * does not revive it — by travel past TAP_MAX_PX, by a second pointer joining
 * (a pinch, a two-finger drag), by a cancel or a lost capture, and by
 * outliving TAP_MAX_MS. No pointer that goes down while another is held can
 * start one, so the finger of a pinch that lifts last is not a tap. Only the
 * owning pointer's up commits.
 *
 * Before this the mode kept one start point with no pointer id and tested
 * the up's displacement from it: a second finger overwrote the start and its
 * own lift read as a tap, and an out-and-back drag under the time limit did
 * too.
 *
 * Times are the events' own timestamps, one clock for the down and the up.
 */

/** A press that moves less than this (px) and ends within this (ms) is a tap, not a drag. */
export const TAP_MAX_PX = 8;
export const TAP_MAX_MS = 400;

export interface PointerSample {
  pointerId: number;
  x: number;
  y: number;
  /** The event's timeStamp. */
  timeMs: number;
}

interface TapCandidate {
  pointerId: number;
  x: number;
  y: number;
  startMs: number;
  cancelled: boolean;
}

export class TapRecognizer {
  private candidate: TapCandidate | null = null;
  private readonly held = new Set<number>();

  /**
   * A pointer went down. `primary` is whether it may start a tap: a mouse's
   * main button, any touch or pen. A second pointer cancels the candidate
   * and starts none of its own.
   */
  down(sample: PointerSample, primary = true): void {
    this.held.add(sample.pointerId);
    if (this.held.size > 1) {
      if (this.candidate) this.candidate.cancelled = true;
      return;
    }
    this.candidate = primary
      ? { pointerId: sample.pointerId, x: sample.x, y: sample.y, startMs: sample.timeMs, cancelled: false }
      : null;
  }

  /** A pointer moved: the candidate's own travel past the limit cancels it. */
  move(sample: PointerSample): void {
    const candidate = this.candidate;
    if (!candidate || candidate.cancelled || candidate.pointerId !== sample.pointerId) return;
    if (Math.hypot(sample.x - candidate.x, sample.y - candidate.y) > TAP_MAX_PX) candidate.cancelled = true;
  }

  /** A pointer lifted. True when this up completes a tap: the owning pointer, uncancelled, in time. */
  up(sample: PointerSample): boolean {
    this.held.delete(sample.pointerId);
    const candidate = this.candidate;
    if (!candidate || candidate.pointerId !== sample.pointerId) return false;
    this.candidate = null;
    if (candidate.cancelled) return false;
    if (sample.timeMs - candidate.startMs > TAP_MAX_MS) return false;
    return Math.hypot(sample.x - candidate.x, sample.y - candidate.y) <= TAP_MAX_PX;
  }

  /** A pointer was cancelled or lost its capture: nothing of this gesture can be a tap. */
  cancel(pointerId: number): void {
    this.held.delete(pointerId);
    this.candidate = null;
  }

  /** Everything let go: a blur, the mode leaving. */
  reset(): void {
    this.held.clear();
    this.candidate = null;
  }

  /** A pointer is down. */
  pressed(): boolean {
    return this.held.size > 0;
  }

  /** A pointer is down and this gesture is no longer a tap: the orbit is being dragged. */
  dragging(): boolean {
    return this.held.size > 0 && (this.candidate === null || this.candidate.cancelled);
  }
}
