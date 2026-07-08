import { describe, expect, it } from 'vitest';
import { nearestPresetIndex, railDetentLabel, railFraction } from './PlanetariumTimePanel';
import { TIME_RATE_PRESETS } from '../timeRates';

const PRESETS = TIME_RATE_PRESETS;
const LAST = PRESETS.length - 1;

describe('railFraction', () => {
  it('puts every preset exactly on its detent', () => {
    PRESETS.forEach((preset, i) => {
      expect(railFraction(preset, PRESETS)).toBeCloseTo(i / LAST, 10);
    });
  });

  it('interpolates off-ladder magnitudes between their neighbour detents', () => {
    // The tutorial's 2 hr/s sits between the 1 hr/s and 6 hr/s detents,
    // nearer the low side (log-linear).
    const f = railFraction(7200, PRESETS);
    expect(f).toBeGreaterThan(3 / LAST);
    expect(f).toBeLessThan(4 / LAST);
    expect(f - 3 / LAST).toBeLessThan(4 / LAST - f);
  });

  it('clamps beyond both ends', () => {
    expect(railFraction(0.5, PRESETS)).toBe(0);
    expect(railFraction(1e9, PRESETS)).toBe(1);
  });
});

describe('nearestPresetIndex', () => {
  it('is exact on the ladder and log-nearest off it', () => {
    PRESETS.forEach((preset, i) => {
      expect(nearestPresetIndex(preset, PRESETS)).toBe(i);
    });
    // 2 hr/s is nearer 1 hr/s than 6 hr/s in log space.
    expect(nearestPresetIndex(7200, PRESETS)).toBe(3);
    expect(nearestPresetIndex(0.5, PRESETS)).toBe(0);
    expect(nearestPresetIndex(1e9, PRESETS)).toBe(LAST);
  });
});

describe('railDetentLabel', () => {
  it('labels the shipped ladder compactly, minutes never bare-m', () => {
    expect(PRESETS.map(railDetentLabel)).toEqual([
      '1×', '1min', '20min', '1h', '6h', '1d', '1w', '1mo', '1yr',
    ]);
  });
});
