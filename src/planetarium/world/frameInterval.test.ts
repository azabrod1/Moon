import { describe, it, expect } from 'vitest';
import {
  FrameIntervalTracker,
  FRAME_INTERVAL_ALPHA_FRAMES_TO_SETTLE,
  FRAME_INTERVAL_EMA_ALPHA,
  FRAME_INTERVAL_MAX_MS,
  FRAME_INTERVAL_MIN_MS,
} from './frameInterval';
import { bakeSliceBudgetMs } from './atmosphereLut';
import { warmBudgetMs } from './textureWarmer';

/** Frames of the same length, which is what a steady display delivers. */
function steady(t: FrameIntervalTracker, ms: number, frames: number): number {
  let last = t.ms;
  for (let i = 0; i < frames; i++) last = t.observe(ms);
  return last;
}

describe('FrameIntervalTracker', () => {
  it('follows a steady display towards its own interval', () => {
    const t = new FrameIntervalTracker(16.7);
    expect(t.ms).toBe(16.7);
    // 120 Hz: the average walks down from the 60 Hz seed and settles there.
    expect(steady(t, 8.3, 200)).toBeCloseTo(8.3, 3);
  });

  it('clamps a single hitch instead of letting it licence more work', () => {
    const t = new FrameIntervalTracker(8.3);
    // One 30 ms frame is a real interval and folds in, but only by alpha.
    t.observe(30);
    expect(t.ms).toBeCloseTo(8.3 + (30 - 8.3) * FRAME_INTERVAL_EMA_ALPHA, 6);
    expect(t.ms).toBeLessThan(10);
  });

  it('floors a gap too short to be a frame', () => {
    const t = new FrameIntervalTracker(8.3);
    steady(t, 0.1, 200);
    expect(t.ms).toBeCloseTo(FRAME_INTERVAL_MIN_MS, 3);
  });

  it('clamps a gap longer than any display interval rather than dropping it', () => {
    const t = new FrameIntervalTracker(8.3);
    t.observe(1000);
    // Clamped to the ceiling and blended, exactly as a 40 ms frame would be.
    expect(t.ms).toBeCloseTo(8.3 + (FRAME_INTERVAL_MAX_MS - 8.3) * FRAME_INTERVAL_EMA_ALPHA, 6);
    expect(t.reseeding).toBe(false);
  });

  /**
   * Why clamped and not dropped: a run of long frames is the app working —
   * a boot, an arrival under the veil — and letting the average rise there
   * gives the warm pump its whole budget while the frames are long anyway.
   * Discarding those gaps holds the pump at its floor and the uploads it
   * would have paid under the cut land after it instead.
   */
  it('lets a busy stretch raise the pump budget, which is what pays uploads early', () => {
    const busy = new FrameIntervalTracker(8.3);
    steady(busy, 40, 30); // thirty long frames: a veil, a boot
    expect(busy.ms).toBeGreaterThan(24);
    expect(warmBudgetMs(busy.ms)).toBe(6); // the pump's cap, so it works ahead

    const dropped = new FrameIntervalTracker(8.3); // what discarding them gives
    expect(warmBudgetMs(dropped.ms)).toBeLessThan(6);
    expect(warmBudgetMs(dropped.ms)).toBeCloseTo(8.3 * 0.35, 3);
  });

  it('ignores a value that is not a number at all', () => {
    const t = new FrameIntervalTracker(8.3);
    t.observe(Number.NaN);
    expect(t.ms).toBe(8.3);
    expect(t.reseeding).toBe(false);
  });

  /**
   * The fault this exists for: ten seconds of a hidden tab, delivered one
   * frame a second, then the foreground again. Those gaps say nothing about
   * how hard the app is working, because nothing was being shown — so the
   * first frame after the tab is visible again is believed outright.
   */
  it('comes back from a hidden tab on the first foreground frame', () => {
    const t = new FrameIntervalTracker(8.3);
    steady(t, 8.3, 200);
    expect(t.ms).toBeCloseTo(8.3, 3);

    steady(t, 1000, 10); // ten seconds at 1 Hz, hidden or occluded
    expect(t.ms).toBeCloseTo(21.0, 1); // clamped in, and the average is wrong

    t.resume(); // the visibilitychange listener's one call
    expect(t.reseeding).toBe(true);
    t.observe(8.3);
    expect(t.ms).toBeCloseTo(8.3, 6);
    expect(t.reseeding).toBe(false);
  });

  it('resume only affects the next frame, not the ones after it', () => {
    const t = new FrameIntervalTracker(8.3);
    t.resume();
    t.observe(16.7);
    expect(t.ms).toBe(16.7);
    // Back to blending at once: a second frame moves it by alpha, not whole.
    t.observe(8.3);
    expect(t.ms).toBeCloseTo(16.7 + (8.3 - 16.7) * FRAME_INTERVAL_EMA_ALPHA, 6);
  });

  /**
   * And what it costs when those gaps DO land, which is the whole reason for
   * the rule: clamped in at 40 ms apiece they take the average to about 21 ms,
   * and the bake sizes its slice from that with no cap of its own — 7 ms of
   * work offered to an 8.3 ms frame.
   */
  it('would have licenced a 7 ms bake slice against an 8.3 ms frame', () => {
    let corrupted = 8.3;
    for (let i = 0; i < 10; i++) {
      corrupted += (Math.min(FRAME_INTERVAL_MAX_MS, 1000) - corrupted) * FRAME_INTERVAL_EMA_ALPHA;
    }
    expect(corrupted).toBeCloseTo(21.0, 1);
    expect(bakeSliceBudgetMs(corrupted)).toBeGreaterThan(7);
    // 7.4 ms of GPU work offered inside an 8.3 ms frame is 89 % of it, where
    // the share the bake is supposed to take is 35 %.
    expect(bakeSliceBudgetMs(corrupted) / 8.3).toBeGreaterThan(0.85);
    // The warm pump has a cap of its own, so it was only ever offered 6 ms —
    // half again what an 8.3 ms frame should have given it, but bounded.
    expect(warmBudgetMs(corrupted)).toBe(6);

    // What the tracker hands them instead, on the frame after the tab is shown.
    const t = new FrameIntervalTracker(8.3);
    steady(t, 8.3, 200);
    steady(t, 1000, 10);
    t.resume();
    t.observe(8.3);
    expect(bakeSliceBudgetMs(t.ms)).toBeCloseTo(8.3 * 0.35, 3);
    expect(bakeSliceBudgetMs(t.ms)).toBeLessThan(8.3);
    expect(warmBudgetMs(t.ms)).toBeCloseTo(8.3 * 0.35, 3);
  });

  it('settles a step change in about the frames the smoothing implies', () => {
    const t = new FrameIntervalTracker(8.3);
    // 120 Hz to 60 Hz, an external display plugged in: 95 % of the way in the
    // frames alpha implies, and no sooner.
    const target = 16.7;
    let frames = 0;
    while (Math.abs(t.ms - target) > (target - 8.3) * 0.05 && frames < 1000) {
      t.observe(target);
      frames++;
    }
    expect(frames).toBeCloseTo(FRAME_INTERVAL_ALPHA_FRAMES_TO_SETTLE, -1);
  });
});
