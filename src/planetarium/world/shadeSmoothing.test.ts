import { describe, expect, it } from 'vitest';
import {
  SHADE_SMOOTHING,
  advanceSilhouetteOwners,
  makeSilhouetteOwners,
  smoothShadeFraction,
} from './shadeSmoothing';

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

describe('advanceSilhouetteOwners', () => {
  // Per-frame step at 60 fps, and the resulting rate-limited increment.
  const FRAME = 16;
  const STEP = (SHADE_SMOOTHING.maxRatePerSec * FRAME) / 1000; // 0.064

  /** Advance one frame with a monotonically rising wall clock. */
  function run<T>(
    s: ReturnType<typeof makeSilhouetteOwners<T>>,
    owner: T | null,
    shade: number,
    t: number,
    snap = false,
  ) {
    return advanceSilhouetteOwners(s, { owner, shade }, t, { snap });
  }

  it('starts empty with two distinct slots', () => {
    const s = makeSilhouetteOwners<string>();
    expect(s.current.owner).toBe(null);
    expect(s.current.applied).toBe(0);
    expect(s.ex.owner).toBe(null);
    expect(s.ex.applied).toBe(0);
    expect(s.current).not.toBe(s.ex);
  });

  it('keeps both slot timestamps fresh while idle so a later owner ramps', () => {
    const s = makeSilhouetteOwners<string>();
    run(s, null, 0, 1000);
    expect(s.current.stampMs).toBe(1000);
    expect(s.ex.stampMs).toBe(1000);
    expect(s.current.owner).toBe(null);
  });

  it('ramps a fresh owner up rather than stepping when the state is primed', () => {
    const s = makeSilhouetteOwners<string>();
    run(s, null, 0, 1000); // prime the timestamps
    run(s, 'A', 1, 1000 + FRAME);
    expect(s.current.owner).toBe('A');
    expect(s.current.applied).toBeCloseTo(STEP, 10);
    run(s, 'A', 1, 1000 + 2 * FRAME);
    expect(s.current.applied).toBeCloseTo(2 * STEP, 10);
  });

  it('snaps a fresh owner when the timestamps are stale (a cold-start discontinuity)', () => {
    const s = makeSilhouetteOwners<string>();
    // No prime: stampMs 0 is a gap beyond snapGapMs, so the first owner lands
    // on its target — booting straight into totality shows a dark disc at once.
    run(s, 'A', 1, 1_000_000);
    expect(s.current.applied).toBe(1);
  });

  it('lands both slots on target instantly when snap is set', () => {
    const s = makeSilhouetteOwners<string>();
    run(s, null, 0, 1000);
    run(s, 'A', 0.8, 1000 + FRAME, true);
    expect(s.current.owner).toBe('A');
    expect(s.current.applied).toBe(0.8);
  });

  it('treats a non-positive shade as no active owner', () => {
    const s = makeSilhouetteOwners<string>();
    run(s, null, 0, 1000);
    run(s, 'A', 0, 1000 + FRAME);
    expect(s.current.owner).toBe(null);
    expect(s.current.applied).toBe(0);
  });

  it('fades an owner out and releases the slot when the eclipse ends', () => {
    const s = makeSilhouetteOwners<string>();
    run(s, null, 0, 1000);
    run(s, 'A', 1, 1000 + FRAME); // A up to one step
    run(s, null, 0, 1000 + 2 * FRAME); // idle: A ramps to 0 and releases
    expect(s.current.owner).toBe(null);
    expect(s.current.applied).toBe(0);
  });

  it('keeps a still-dominant owner even when its applied value rounds toward zero', () => {
    const s = makeSilhouetteOwners<string>();
    run(s, null, 0, 1000);
    run(s, 'A', 0.00005, 1000 + FRAME); // below the release epsilon but still active
    expect(s.current.owner).toBe('A');
    expect(s.current.applied).toBeCloseTo(0.00005, 10);
  });

  it('hands off to a new owner: incumbent fades in the ex slot, newcomer rises', () => {
    const s = makeSilhouetteOwners<string>();
    let t = 1000;
    run(s, null, 0, t);
    for (let i = 0; i < 20; i++) run(s, 'A', 1, (t += FRAME)); // A to full
    expect(s.current.owner).toBe('A');
    expect(s.current.applied).toBe(1);
    expect(s.ex.owner).toBe(null);

    run(s, 'B', 1, (t += FRAME)); // B arrives
    expect(s.current.owner).toBe('B');
    expect(s.current.applied).toBeCloseTo(STEP, 10);
    expect(s.ex.owner).toBe('A');
    expect(s.ex.applied).toBeCloseTo(1 - STEP, 10);

    for (let i = 0; i < 40; i++) run(s, 'B', 1, (t += FRAME)); // settle
    expect(s.current.owner).toBe('B');
    expect(s.current.applied).toBe(1);
    expect(s.ex.owner).toBe(null); // A fully faded and released
  });

  it('revives the fading ex-owner instead of evicting it when it regains dominance', () => {
    const s = makeSilhouetteOwners<string>();
    let t = 1000;
    run(s, null, 0, t);
    for (let i = 0; i < 20; i++) run(s, 'A', 1, (t += FRAME)); // A full
    run(s, 'B', 1, (t += FRAME)); // hand off: current=B, ex=A
    for (let i = 0; i < 3; i++) run(s, 'B', 1, (t += FRAME)); // let both drift
    const exApplied = s.ex.applied; // A, fading
    const curApplied = s.current.applied; // B, rising
    expect(s.ex.owner).toBe('A');
    expect(s.current.owner).toBe('B');

    run(s, 'A', 1, (t += FRAME)); // A regains dominance
    expect(s.current.owner).toBe('A');
    expect(s.current.applied).toBeCloseTo(exApplied + STEP, 10); // A ramps back up
    expect(s.ex.owner).toBe('B');
    expect(s.ex.applied).toBeCloseTo(curApplied - STEP, 10); // B now fades
  });

  it('evicts a still-fading ex-owner when a third body takes over', () => {
    const s = makeSilhouetteOwners<string>();
    let t = 1000;
    run(s, null, 0, t);
    for (let i = 0; i < 20; i++) run(s, 'A', 1, (t += FRAME));
    run(s, 'B', 1, (t += FRAME)); // hand off: current=B, ex=A (still high)
    for (let i = 0; i < 4; i++) run(s, 'B', 1, (t += FRAME)); // let B rise so it survives a step
    expect(s.ex.owner).toBe('A'); // A still fading in the ex slot
    run(s, 'C', 1, (t += FRAME)); // C arrives before A has faded out
    expect(s.current.owner).toBe('C');
    expect(s.ex.owner).toBe('B'); // B moved to ex; A was evicted (dropped both slots)
  });

  it('snap during a handoff snaps the current owner up and drops the fading ex', () => {
    const s = makeSilhouetteOwners<string>();
    let t = 1000;
    run(s, null, 0, t);
    for (let i = 0; i < 20; i++) run(s, 'A', 1, (t += FRAME));
    run(s, 'B', 1, (t += FRAME)); // current=B rising, ex=A fading
    run(s, 'B', 1, (t += FRAME), true); // discontinuity
    expect(s.current.owner).toBe('B');
    expect(s.current.applied).toBe(1);
    expect(s.ex.owner).toBe(null);
    expect(s.ex.applied).toBe(0);
  });

  it('snap onto a brand-new owner shows no ghost of the previous one', () => {
    const s = makeSilhouetteOwners<string>();
    let t = 1000;
    run(s, null, 0, t);
    for (let i = 0; i < 20; i++) run(s, 'A', 1, (t += FRAME)); // A full
    run(s, 'B', 1, (t += FRAME), true); // teleport straight to B's eclipse
    expect(s.current.owner).toBe('B');
    expect(s.current.applied).toBe(1);
    expect(s.ex.owner).toBe(null);
    expect(s.ex.applied).toBe(0);
  });
});
