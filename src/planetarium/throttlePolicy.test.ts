import { describe, expect, it } from 'vitest';
import { CRUISE_RAMP, SYSTEM_RAMP, rampThrottle } from './throttlePolicy';
import {
  CRUISE_TAP_FLOORS,
  SUN_SYSTEM_RADIUS_AU,
  SYSTEM_TAP_FLOORS,
  stepThrottleTap,
  systemSpeedFactor,
  THROTTLE_TAP_DOWN,
  THROTTLE_TAP_UP,
} from './throttlePolicy';

const worldPositions = new Map([
  ['Earth', { x: 1, y: 0, z: 0 }],
  ['Jupiter', { x: -5.2, y: 0, z: 0 }],
]);
const bodies = [
  { name: 'Earth', systemRadiusAU: 0.03 },
  { name: 'Jupiter', systemRadiusAU: 0.2 },
];

describe('systemSpeedFactor', () => {
  it('is 1 with no system containing the player', () => {
    const r = systemSpeedFactor(0.5, 0.5, 0, bodies, worldPositions);
    expect(r.factor).toBe(1);
    expect(r.planet).toBeNull();
  });

  it('is exactly 1 at the rim and 0 at 5% depth, easing between', () => {
    // On the rim (dist === systemRadius): the >= guard leaves the factor 1.
    const rim = systemSpeedFactor(1 + 0.03, 0, 0, bodies, worldPositions);
    expect(rim.factor).toBe(1);
    // At the inner edge (5% of the radius) the smoothstep bottoms out. Close
    // to zero, not bit-zero: the player-minus-body subtraction rounds the
    // distance a few ULPs off the exact edge.
    const core = systemSpeedFactor(1 + 0.03 * 0.05, 0, 0, bodies, worldPositions);
    expect(core.factor).toBeCloseTo(0, 12);
    expect(core.planet).toBe('Earth');
    // Halfway between rim and inner edge: strictly inside (0, 1), and the
    // classic smoothstep midpoint is exactly 0.5.
    const midDist = (0.03 * 0.05 + 0.03) / 2;
    const mid = systemSpeedFactor(1 + midDist, 0, 0, bodies, worldPositions);
    expect(mid.factor).toBeCloseTo(0.5, 12);
    expect(mid.planet).toBe('Earth');
  });

  it('names the Sun inside its origin shell', () => {
    const r = systemSpeedFactor(SUN_SYSTEM_RADIUS_AU * 0.05, 0, 0, bodies, worldPositions);
    expect(r.factor).toBe(0);
    expect(r.planet).toBe('Sun');
  });

  it('skips bodies with no world position yet and reuses the out object', () => {
    const scratch = { factor: 0, planet: 'stale' as string | null };
    const r = systemSpeedFactor(
      0,
      3,
      0,
      [{ name: 'Ghost', systemRadiusAU: 100 }],
      worldPositions,
      scratch,
    );
    expect(r).toBe(scratch);
    expect(r.factor).toBe(1);
    expect(r.planet).toBeNull();
  });
});

describe('stepThrottleTap', () => {
  it('engages a dead throttle at the floor instead of multiplying zero', () => {
    expect(stepThrottleTap(0, 1, SYSTEM_TAP_FLOORS, 10)).toBe(SYSTEM_TAP_FLOORS.engage);
    expect(stepThrottleTap(0, 1, CRUISE_TAP_FLOORS, 10)).toBe(CRUISE_TAP_FLOORS.engage);
  });

  it('steps multiplicatively and clamps at the cap', () => {
    expect(stepThrottleTap(1, 1, CRUISE_TAP_FLOORS, 10)).toBeCloseTo(THROTTLE_TAP_UP, 12);
    expect(stepThrottleTap(9, 1, CRUISE_TAP_FLOORS, 10)).toBe(10);
    expect(stepThrottleTap(1, -1, CRUISE_TAP_FLOORS, 10)).toBeCloseTo(THROTTLE_TAP_DOWN, 12);
  });

  it('cuts to exactly zero below the cut floor — no asymptotic creep', () => {
    expect(stepThrottleTap(CRUISE_TAP_FLOORS.cut * 0.99, -1, CRUISE_TAP_FLOORS, 10)).toBe(0);
    expect(stepThrottleTap(SYSTEM_TAP_FLOORS.cut * 0.99, -1, SYSTEM_TAP_FLOORS, 10)).toBe(0);
  });

  it('cannot trap the multiplier: engage then one down-tap parks at zero', () => {
    // The floor asymmetry (cut > engage) is the load-bearing part of the
    // policy — engage lands below the cut line on both floor sets.
    for (const floors of [SYSTEM_TAP_FLOORS, CRUISE_TAP_FLOORS]) {
      expect(floors.cut).toBeGreaterThan(floors.engage);
      const engaged = stepThrottleTap(0, 1, floors, 10);
      expect(stepThrottleTap(engaged, -1, floors, 10)).toBe(0);
    }
  });
});

describe('rampThrottle', () => {
  const FRAME_60 = 1 / 60;

  it('reproduces the tuned per-frame factors at 60 Hz', () => {
    expect(rampThrottle(1, 1, FRAME_60, CRUISE_RAMP, 20)).toBeCloseTo(1.01, 12);
    expect(rampThrottle(1, -1, FRAME_60, CRUISE_RAMP, 20)).toBeCloseTo(0.99 - 0.001, 12);
    expect(rampThrottle(0.01, 1, FRAME_60, CRUISE_RAMP, 20)).toBeCloseTo(0.012, 12);
    expect(rampThrottle(0.0005, 1, FRAME_60, SYSTEM_RAMP, 0.4)).toBeCloseTo(0.0006, 12);
    expect(rampThrottle(0.1, -1, FRAME_60, SYSTEM_RAMP, 0.4)).toBeCloseTo(0.1 * 0.99 - 0.0001, 12);
  });

  it('is frame-rate invariant: one 0.1 s step equals ten 0.01 s steps', () => {
    for (const [start, dir] of [[1, 1], [4, -1], [0.02, 1]] as Array<[number, 1 | -1]>) {
      const one = rampThrottle(start, dir, 0.1, CRUISE_RAMP, 20);
      let ten = start;
      for (let i = 0; i < 10; i++) ten = rampThrottle(ten, dir, 0.01, CRUISE_RAMP, 20);
      expect(ten).toBeCloseTo(one, 9);
    }
  });

  it('doubles a held cruise throttle in the same wall time at 60 and 120 Hz', () => {
    const secondsToDouble = (hz: number) => {
      let mult = 1;
      let frames = 0;
      while (mult < 2) {
        mult = rampThrottle(mult, 1, 1 / hz, CRUISE_RAMP, 20);
        frames++;
      }
      return frames / hz;
    };
    expect(secondsToDouble(60)).toBeCloseTo(secondsToDouble(120), 1);
    expect(secondsToDouble(60)).toBeGreaterThan(1.1);
    expect(secondsToDouble(60)).toBeLessThan(1.2);
  });

  it('clamps at the cap going up and parks at exactly zero going down', () => {
    expect(rampThrottle(19.999, 1, 1, CRUISE_RAMP, 20)).toBe(20);
    let mult = 0.05;
    for (let i = 0; i < 600; i++) mult = rampThrottle(mult, -1, FRAME_60, CRUISE_RAMP, 20);
    expect(mult).toBe(0);
  });
});
