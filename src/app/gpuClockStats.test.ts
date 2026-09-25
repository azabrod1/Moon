import { describe, it, expect } from 'vitest';
import {
  percentile,
  median,
  summarise,
  summarisePolls,
  minNonZeroDelta,
  ratePerSecond,
  intervalsOf,
  deltaOfMedians,
} from './gpuClockStats';

describe('percentile', () => {
  it('interpolates between the neighbouring ranks', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    // (n-1)*p = 0.9 and 8.1, so the tenths fall between the ranks either side.
    expect(percentile(xs, 0.1)).toBeCloseTo(1.9, 10);
    expect(percentile(xs, 0.9)).toBeCloseTo(9.1, 10);
    expect(percentile(xs, 0.5)).toBeCloseTo(5.5, 10);
    expect(percentile(xs, 0)).toBe(1);
    expect(percentile(xs, 1)).toBe(10);
  });

  it('does not need its input sorted', () => {
    expect(median([5, 1, 4, 2, 3])).toBe(3);
    expect(percentile([9, 1], 0.5)).toBe(5);
  });

  it('answers a single sample with itself and an empty window with NaN', () => {
    expect(percentile([7], 0.9)).toBe(7);
    expect(Number.isNaN(percentile([], 0.5))).toBe(true);
  });

  it('clamps a percentile outside 0…1 instead of reading off the end', () => {
    expect(percentile([1, 2, 3], -1)).toBe(1);
    expect(percentile([1, 2, 3], 2)).toBe(3);
  });
});

describe('summarise', () => {
  it('describes the window', () => {
    const s = summarise([4, 4, 4, 4])!;
    expect(s).toEqual({ n: 4, median: 4, p10: 4, p90: 4, min: 4, max: 4, mean: 4 });
  });

  it('is null where there is nothing to describe, so a missing arm never reads as zero', () => {
    expect(summarise([])).toBeNull();
    expect(summarise([NaN, NaN])).toBeNull();
  });

  it('drops the readings that never arrived and keeps the rest', () => {
    const s = summarise([10, NaN, 20, Infinity])!;
    expect(s.n).toBe(2);
    expect(s.median).toBe(15);
    expect(s.min).toBe(10);
    expect(s.max).toBe(20);
  });
});

describe('summarisePolls', () => {
  it('prices the loop ask to ask and the call itself separately', () => {
    // Three polls a tenth of a millisecond apart, each call costing 0.02 ms.
    const s = summarisePolls([
      { before: 100.0, after: 100.02 },
      { before: 100.1, after: 100.13 },
      { before: 100.2, after: 100.22 },
    ]);
    expect(s.polls).toBe(3);
    expect(s.costMs).toBeCloseTo(0.07, 6);
    expect(s.cost!.max).toBeCloseTo(0.03, 6);
    expect(s.interval!.n).toBe(2);
    expect(s.interval!.median).toBeCloseTo(0.1, 6);
    expect(s.interval!.max).toBeCloseTo(0.1, 6);
  });

  it('has a cost but no interval for a single poll, and neither for none', () => {
    const one = summarisePolls([{ before: 5, after: 5.5 }]);
    expect(one.costMs).toBeCloseTo(0.5, 10);
    expect(one.interval).toBeNull();
    const none = summarisePolls([]);
    expect(none).toEqual({ polls: 0, costMs: 0, cost: null, interval: null });
  });
});

describe('minNonZeroDelta', () => {
  it('reads the clock grid off a run of samples, ignoring the reads that stood still', () => {
    // A 1 ms grid read faster than it advances: many equal reads, then a step.
    expect(minNonZeroDelta([3, 3, 3, 4, 4, 5])).toBe(1);
    expect(minNonZeroDelta([0, 0.1, 0.1, 0.3])).toBeCloseTo(0.1, 10);
  });

  it('is null where the clock never moved, and ignores a backwards step', () => {
    expect(minNonZeroDelta([2, 2, 2])).toBeNull();
    expect(minNonZeroDelta([])).toBeNull();
    expect(minNonZeroDelta([5, 4, 6])).toBe(2);
  });
});

describe('ratePerSecond and intervalsOf', () => {
  it('is the span over the intervals it contains', () => {
    // Six stamps 16.67 ms apart: five intervals over 83.35 ms.
    const stamps = [0, 16.67, 33.34, 50.01, 66.68, 83.35];
    expect(ratePerSecond(stamps)!).toBeCloseTo(59.988, 2);
    expect(intervalsOf(stamps)).toHaveLength(5);
    expect(intervalsOf(stamps)[0]).toBeCloseTo(16.67, 10);
  });

  it('refuses to invent a rate from one stamp or one instant', () => {
    expect(ratePerSecond([12])).toBeNull();
    expect(ratePerSecond([])).toBeNull();
    expect(ratePerSecond([9, 9, 9])).toBeNull();
  });
});

describe('deltaOfMedians', () => {
  it('is the bias between two clocks reading the same frames', () => {
    expect(deltaOfMedians([10, 11, 12], [8, 9, 10])!).toBeCloseTo(2, 10);
  });

  it('is null where either clock read nothing', () => {
    expect(deltaOfMedians([], [1, 2])).toBeNull();
    expect(deltaOfMedians([1, 2], [])).toBeNull();
  });
});
