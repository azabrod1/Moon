import { describe, expect, it } from 'vitest';
import { nearestPresetIndex, railDetentLabel, railFraction, railTapAction } from './PlanetariumTimePanel';
import { TIME_RATE_PRESETS } from '../timeRates';

const PRESETS = TIME_RATE_PRESETS;
const LAST = PRESETS.length - 1;
const SLOP = 4; // px, mirrors TAP_SLOP_PX
const RAIL_W = 300; // px; rail left edge at 0 for these fixtures

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

describe('railTapAction', () => {
  it('pauses within slop of the thumb, selects beyond it', () => {
    expect(railTapAction(100, 100, SLOP)).toBe('pause');
    expect(railTapAction(104, 100, SLOP)).toBe('pause'); // exactly at slop
    expect(railTapAction(96, 100, SLOP)).toBe('pause');
    expect(railTapAction(105, 100, SLOP)).toBe('select'); // just past slop
  });

  it('selects the nearest detent from an off-ladder rate instead of pausing', () => {
    // 2 hr/s (7200) sits ~4.8% of the rail past detent 3 — beyond the tap slop
    // on any real rail — so a tap on detent 3 must select it, not pause.
    const thumbX = railFraction(7200, PRESETS) * RAIL_W;
    const detent3X = (3 / LAST) * RAIL_W;
    expect(Math.abs(detent3X - thumbX)).toBeGreaterThan(SLOP);
    expect(railTapAction(detent3X, thumbX, SLOP)).toBe('select');
    // A tap on the thumb itself still pauses.
    expect(railTapAction(thumbX, thumbX, SLOP)).toBe('pause');
  });

  it('still pauses when tapping the detent a rate sits exactly on', () => {
    // On the ladder the thumb sits on its detent, so their x coincide.
    const detent4X = railFraction(PRESETS[4], PRESETS) * RAIL_W;
    const thumbX = (4 / LAST) * RAIL_W;
    expect(detent4X).toBeCloseTo(thumbX, 10);
    expect(railTapAction(detent4X, thumbX, SLOP)).toBe('pause');
  });
});

describe('railDetentLabel', () => {
  it('labels the shipped ladder compactly, minutes never bare-m', () => {
    expect(PRESETS.map(railDetentLabel)).toEqual([
      '1×', '1min', '20min', '1h', '6h', '1d', '1w', '1mo', '1yr',
    ]);
  });
});
