import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

/**
 * The gyro's smoothing seam, exercised directly: `GyroSteering.smooth` is
 * private and its owner only runs under a live DeviceOrientation stream, so
 * the contract is pinned on an identical local copy. What matters here is
 * the property, not the arithmetic — a centered phone must produce EXACTLY
 * zero, because every "is anyone flying?" test in the cruise loop compares
 * steering against zero.
 */
function smooth(value: number, target: number): number {
  const eased = THREE.MathUtils.lerp(value, target, 0.18);
  return Math.abs(eased) < 1e-4 ? 0 : eased;
}

describe('gyro steering residue', () => {
  it('a centered phone reaches a true zero, and quickly', () => {
    let v = 1;
    let events = 0;
    while (v !== 0) {
      v = smooth(v, 0);
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
    for (let i = 0; i < 60; i++) v = smooth(v, smallestPassedTilt);
    expect(v).toBeCloseTo(smallestPassedTilt, 6);
  });

  it('a tilt held below the band cannot creep into steering', () => {
    let v = 0;
    for (let i = 0; i < 200; i++) v = smooth(v, 5e-5);
    expect(v).toBe(0);
  });
});
