import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  advanceSpinLatch,
  sectorSuspendFor,
  SECTOR_SPIN_HOLD_MS,
  SECTOR_SPIN_RESUME_DEG_PER_S,
  SECTOR_SPIN_SUSPEND_DEG_PER_S,
  type SectorSpinLatch,
} from './sectorSpinGate';

/** A body turned `deg` about its own pole. */
const spun = (deg: number) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(deg));

function latchAt(deg = 0, tMs = 0): SectorSpinLatch {
  return { quat: spun(deg), tMs, heldUntilMs: 0 };
}

/** Turn the body at `degPerS` for `ms`, advancing the latch once. */
function step(latch: SectorSpinLatch, degPerS: number, ms: number, fromDeg: number): { spinning: boolean; deg: number } {
  const deg = fromDeg + (degPerS * ms) / 1000;
  const spinning = advanceSpinLatch(latch, spun(deg), latch.tMs + ms);
  return { spinning, deg };
}

describe('the spin latch', () => {
  it('reports no spin on the first visit, which has nothing to difference against', () => {
    const latch = latchAt();
    expect(advanceSpinLatch(latch, spun(0), 0)).toBe(false);
  });

  it('holds admissions once the body turns faster than the suspend rate', () => {
    const latch = latchAt();
    expect(step(latch, SECTOR_SPIN_SUSPEND_DEG_PER_S + 1, 100, 0).spinning).toBe(true);
  });

  it('leaves a body turning under the suspend rate alone', () => {
    const latch = latchAt();
    expect(step(latch, SECTOR_SPIN_SUSPEND_DEG_PER_S - 0.5, 100, 0).spinning).toBe(false);
  });

  it('keeps the hold running while the rate stays above the lower resume rate', () => {
    // The whole reason the gate is latched: a body sitting between the two
    // rates would otherwise pulse admissions on and off with frame jitter.
    const latch = latchAt();
    let deg = 0;
    ({ deg } = step(latch, SECTOR_SPIN_SUSPEND_DEG_PER_S + 1, 100, deg));
    const between = (SECTOR_SPIN_SUSPEND_DEG_PER_S + SECTOR_SPIN_RESUME_DEG_PER_S) / 2;
    for (let i = 0; i < 10; i++) {
      const out = step(latch, between, 100, deg);
      deg = out.deg;
      expect(out.spinning).toBe(true);
    }
  });

  it('releases the hold once the rate falls under the resume rate and the hold runs out', () => {
    const latch = latchAt();
    let deg = 0;
    ({ deg } = step(latch, SECTOR_SPIN_SUSPEND_DEG_PER_S + 1, 100, deg));
    // Still held immediately after: the hold is a duration, not a frame.
    const stopped = step(latch, 0, 100, deg);
    expect(stopped.spinning).toBe(true);
    deg = stopped.deg;
    expect(step(latch, 0, SECTOR_SPIN_HOLD_MS, deg).spinning).toBe(false);
  });

  it('reads a half-turn the same either way round: q and -q are one orientation', () => {
    const latch = latchAt();
    const q = spun(1);
    q.set(-q.x, -q.y, -q.z, -q.w);
    // One degree in 100 ms is 10 deg/s, over the suspend rate — and the
    // double cover must not turn that into the 359 the raw dot would give.
    expect(advanceSpinLatch(latch, q, 100)).toBe(true);
    expect(latch.heldUntilMs).toBe(100 + SECTOR_SPIN_HOLD_MS);
  });

  it('carries this frame\'s orientation and time into the next visit', () => {
    const latch = latchAt();
    advanceSpinLatch(latch, spun(30), 250);
    expect(latch.tMs).toBe(250);
    expect(latch.quat.angleTo(spun(30))).toBeCloseTo(0, 12);
  });

  it('reads no rate at all when two visits land in the same millisecond', () => {
    const latch = latchAt();
    expect(advanceSpinLatch(latch, spun(180), 0)).toBe(false);
  });
});

describe('what a family may do this frame', () => {
  const base = { hidden: false, grounded: false, spinning: false, chart: false };

  it('works normally when nothing is in the way', () => {
    expect(sectorSuspendFor(base)).toBe('none');
  });

  it('holds everything for a body nobody can see', () => {
    expect(sectorSuspendFor({ ...base, hidden: true })).toBe('all');
  });

  it('holds everything for the ground under a surface observer', () => {
    expect(sectorSuspendFor({ ...base, grounded: true })).toBe('all');
  });

  it('holds only admissions while the body turns, or while the chart owns the frame', () => {
    expect(sectorSuspendFor({ ...base, spinning: true })).toBe('admissions');
    expect(sectorSuspendFor({ ...base, chart: true })).toBe('admissions');
  });

  it('lets the stronger suspend win when both apply', () => {
    expect(sectorSuspendFor({ ...base, hidden: true, spinning: true })).toBe('all');
    expect(sectorSuspendFor({ ...base, grounded: true, chart: true })).toBe('all');
  });
});
