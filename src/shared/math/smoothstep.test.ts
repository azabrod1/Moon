import { describe, expect, it } from 'vitest';
import { smootherstep } from './smoothstep';

describe('smootherstep', () => {
  it('runs from exactly 0 to exactly 1 and holds there outside the range', () => {
    expect(smootherstep(0)).toBe(0);
    expect(smootherstep(1)).toBe(1);
    expect(smootherstep(-0.5)).toBe(0);
    expect(smootherstep(1.5)).toBe(1);
    expect(smootherstep(Number.NaN)).toBe(0);
    // Never past 1 just short of the end, where the polynomial in doubles
    // rounds to 1 + 2^-52: a fade that stopped there would not be exactly on.
    for (let i = 1; i <= 64; i++) expect(smootherstep(1 - i * Number.EPSILON)).toBeLessThanOrEqual(1);
    expect(smootherstep(0.9999999999999999)).toBeLessThanOrEqual(1);
    // Symmetric about the middle, which it crosses at one half.
    expect(smootherstep(0.5)).toBe(0.5);
    for (const t of [0.1, 0.23, 0.4]) expect(smootherstep(t) + smootherstep(1 - t)).toBeCloseTo(1, 12);
  });

  it('never runs backwards', () => {
    let last = smootherstep(0);
    for (let i = 1; i <= 4000; i++) {
      const next = smootherstep(i / 4000);
      expect(next).toBeGreaterThanOrEqual(last);
      last = next;
    }
  });

  it('leaves and arrives with zero slope', () => {
    // A one-sided difference quotient over a step h tends to the slope at that
    // end, so for a flat end it shrinks with h: 10 h² for smootherstep, whose
    // second derivative is zero there too, against smoothstep's 3 h. At
    // h = 1e-3 that is 1e-5 against 3e-3.
    const h = 1e-3;
    const startSlope = (smootherstep(h) - smootherstep(0)) / h;
    const endSlope = (smootherstep(1) - smootherstep(1 - h)) / h;
    expect(startSlope).toBeLessThan(2e-5);
    expect(endSlope).toBeLessThan(2e-5);
    // ...and its steepest is the middle, 15/8.
    expect((smootherstep(0.5 + h) - smootherstep(0.5 - h)) / (2 * h)).toBeCloseTo(15 / 8, 5);
  });
});
