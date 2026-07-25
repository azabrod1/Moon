import { describe, it, expect } from 'vitest';
import { formatBodyDistance } from './bodyDistance';
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
