import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GyroSteering } from './GyroSteering';

/**
 * The gyro's smoothing seam. `smooth` is `private static` — TypeScript-private
 * only — so the real method is reachable through a cast, and a drift in it
 * fails these instead of passing a local copy. What matters is the property,
 * not the arithmetic: a centered phone must produce EXACTLY zero, because
 * every "is anyone flying?" test in the cruise loop compares steering against
 * zero, and the ease must feel the same however fast a device fires
 * deviceorientation events.
 */
const smooth = (GyroSteering as unknown as {
  smooth(value: number, target: number, dtS: number): number;
}).smooth.bind(GyroSteering);

/** One event of a 60 Hz stream — iOS's cadence, the one the ease was tuned on. */
const EVENT_S = 1 / 60;

describe('gyro steering residue', () => {
  it('a centered phone reaches a true zero, and quickly', () => {
    let v = 1;
    let events = 0;
    while (v !== 0) {
      v = smooth(v, 0, EVENT_S);
      events++;
      expect(events).toBeLessThan(120); // ~2 s of events, not a minute
    }
    expect(v).toBe(0);
    // The plain ease this replaces only ever approaches zero: after the same
    // number of events it is still nonzero, and stays so for thousands more.
    expect(THREE.MathUtils.lerp(1, 0, 0.18) * 0.82 ** (events - 1)).toBeGreaterThan(0);
  });

  it('real tilt is untouched: the snap band sits far below the dead zone', () => {
    // The dead zone passes nothing under 3° of tilt, which normalizes to
    // 1/25 of full deflection — hundreds of times the snap band.
    const smallestPassedTilt = 0.04;
    let v = 0;
    for (let i = 0; i < 60; i++) v = smooth(v, smallestPassedTilt, EVENT_S);
    expect(v).toBeCloseTo(smallestPassedTilt, 6);
  });

  it('a tilt held below the band cannot creep into steering', () => {
    let v = 0;
    for (let i = 0; i < 200; i++) v = smooth(v, 5e-5, EVENT_S);
    expect(v).toBe(0);
  });

  it('eases by wall time, so event cadence does not change the feel', () => {
    // A phone reporting at 200 Hz and one at 50 Hz must reach the same tilt
    // after the same tenth of a second.
    const fast = (() => {
      let v = 0;
      for (let i = 0; i < 20; i++) v = smooth(v, 1, 0.005);
      return v;
    })();
    const slow = (() => {
      let v = 0;
      for (let i = 0; i < 5; i++) v = smooth(v, 1, 0.02);
      return v;
    })();
    expect(fast).toBeCloseTo(slow, 6);
    // And one 0.1 s step lands in the same place as either of them.
    expect(smooth(0, 1, 0.1)).toBeCloseTo(fast, 6);
  });

  it('keeps the 60 Hz feel it was tuned at', () => {
    expect(smooth(0, 1, EVENT_S)).toBeCloseTo(0.18, 12);
  });
});
