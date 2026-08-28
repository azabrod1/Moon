import { describe, expect, it } from 'vitest';
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
