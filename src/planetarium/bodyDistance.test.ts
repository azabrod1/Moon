import { describe, it, expect } from 'vitest';
import { bodyDistanceQuantum, formatBodyDistance } from './bodyDistance';
import { KM_PER_AU } from '../astronomy/constants';

describe('formatBodyDistance', () => {
  it('reads in kilometres under 0.01 AU', () => {
    // 0.0005 AU ~ 74,799 km — a close approach.
    expect(formatBodyDistance(0.0005)).toBe(`${(0.0005 * KM_PER_AU).toFixed(0)} km`);
    expect(formatBodyDistance(0.0005)).toMatch(/ km$/);
  });

  it('reads in AU at 0.01 AU and beyond', () => {
    expect(formatBodyDistance(0.01)).toBe('0.01 AU');
    expect(formatBodyDistance(3.2412)).toBe('3.24 AU');
    expect(formatBodyDistance(39.5)).toBe('39.50 AU');
  });

  it('matches the label idiom exactly at the boundary', () => {
    // Just below the threshold stays km; the label ternary uses the same cut.
    expect(formatBodyDistance(0.009999)).toMatch(/ km$/);
    expect(formatBodyDistance(0.01)).toMatch(/ AU$/);
  });
});

describe('bodyDistanceQuantum', () => {
  // The per-frame label and map-card callers keep the last quantum and skip
  // formatting while it is unchanged, so the readout goes stale the moment
  // the key stops changing exactly when the string does.
  const sweep = (from: number, to: number, steps: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i <= steps; i++) out.push(from + ((to - from) * i) / steps);
    return out;
  };

  const assertLockstep = (samples: number[]) => {
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1];
      const b = samples[i];
      expect(
        bodyDistanceQuantum(a) === bodyDistanceQuantum(b),
        `${a} vs ${b}`,
      ).toBe(formatBodyDistance(a) === formatBodyDistance(b));
    }
  };

  it('changes exactly when the kilometre readout changes', () => {
    // 1e-6 AU is ~150 km, so this crosses hundreds of rendered values.
    assertLockstep(sweep(1e-6, 0.0099, 4000));
  });

  it('changes exactly when the AU readout changes', () => {
    assertLockstep(sweep(0.01, 40, 4000));
  });

  it('never collides across the two regimes', () => {
    for (const km of sweep(0, 0.00999, 500)) {
      expect(bodyDistanceQuantum(km)).toBeGreaterThanOrEqual(0);
    }
    for (const au of sweep(0.01, 40, 500)) {
      expect(bodyDistanceQuantum(au)).toBeLessThanOrEqual(-1);
    }
  });
});
