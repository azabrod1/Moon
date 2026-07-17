import { describe, expect, it } from 'vitest';
import { SHADE_SMOOTHING, smoothShadeFraction } from './shadeSmoothing';

describe('smoothShadeFraction', () => {
  it('snaps to the target with no previous value', () => {
    expect(smoothShadeFraction(0.4, undefined, 16)).toBe(0.4);
  });

  it('snaps across an update gap (teleport / system pop-in)', () => {
    expect(smoothShadeFraction(0.03, 1, SHADE_SMOOTHING.snapGapMs + 1)).toBe(0.03);
    expect(smoothShadeFraction(0.03, 1, 0)).toBe(0.03);
  });

  it('rate-limits a warp eclipse snap to maxRatePerSec', () => {
    // Raw astronomy at high warp: 1 → 0.03 in one 16 ms frame.
    const step = smoothShadeFraction(0.03, 1, 16);
    expect(step).toBeCloseTo(1 - (SHADE_SMOOTHING.maxRatePerSec * 16) / 1000, 10);
    // Symmetric on the way back out.
    const up = smoothShadeFraction(1, 0.03, 16);
    expect(up).toBeCloseTo(0.03 + (SHADE_SMOOTHING.maxRatePerSec * 16) / 1000, 10);
  });

  it('converges to the target without overshoot', () => {
    let v: number | undefined = 1;
    let frames = 0;
    while (v !== 0.03 && frames < 120) {
      v = smoothShadeFraction(0.03, v, 16);
      frames++;
    }
    expect(v).toBe(0.03);
    // Full swing at 60 fps spreads over ~1/maxRatePerSec seconds of frames.
    const expected = Math.ceil((1 - 0.03) / ((SHADE_SMOOTHING.maxRatePerSec * 16) / 1000));
    expect(frames).toBe(expected);
  });

  it('is transparent at 1× time (real immersions change slower than the limit)', () => {
    // A real immersion moves the fraction ~0.4%/s; per 16 ms frame that is far
    // inside the limiter, so the applied value tracks the astronomy exactly.
    const target = 0.9 - 0.004 * 0.016;
    expect(smoothShadeFraction(target, 0.9, 16)).toBe(target);
  });

  it('pins the current tuning', () => {
    expect(SHADE_SMOOTHING.maxRatePerSec).toBe(4);
    expect(SHADE_SMOOTHING.snapGapMs).toBe(500);
  });
});
