import { describe, expect, it } from 'vitest';
import {
  STAR_POINT_MAPPING,
  starFaintFraction,
  starPointBaseSize,
  starPointBrightness,
  starPointVisual,
} from './starPointMapping';

// These pins reproduce the exact numbers the starfield loop produced before the
// mapping was extracted; the starfield's per-vertex output must stay identical.
describe('starPointMapping — formulas', () => {
  it('brightness = clamp(1.2 − (mag + 1.44)/8, 0.25, 1.2)', () => {
    expect(starPointBrightness(2)).toBeCloseTo(1.2 - (2 + 1.44) / 8, 12); // 0.77
    expect(starPointBrightness(-30)).toBe(1.2); // clamp high
    expect(starPointBrightness(30)).toBe(0.25); // clamp low
  });

  it('baseSize = clamp(6.0 − mag·1.1, 1.2, 6.5)', () => {
    expect(starPointBaseSize(2)).toBeCloseTo(3.8, 12);
    expect(starPointBaseSize(-10)).toBe(6.5); // clamp high
    expect(starPointBaseSize(10)).toBe(1.2); // clamp low
  });

  it('faint fraction is 0 before the ramp, 1 at the limit', () => {
    const limit = 6.5;
    expect(starFaintFraction(limit - STAR_POINT_MAPPING.faintFadeRangeMag, limit)).toBeCloseTo(0, 12);
    expect(starFaintFraction(limit, limit)).toBeCloseTo(1, 12);
    expect(starFaintFraction(0, limit)).toBe(0); // well below the ramp → clamped
  });

  it('visual: a mid-field star gets full opacity and its base size', () => {
    const v = starPointVisual(2, 6.5);
    expect(v.brightness).toBeCloseTo(0.77, 12);
    expect(v.sizePx).toBeCloseTo(3.8, 12);
    expect(v.alpha).toBe(1);
  });

  it('visual: the faintest star tapers to the floor opacity and min size', () => {
    const v = starPointVisual(6.5, 6.5);
    expect(v.alpha).toBeCloseTo(STAR_POINT_MAPPING.faintMinAlpha, 12); // 0.45
    // baseSize at mag 6.5 clamps to 1.2, then × 0.8 = 0.96, floored to 1.0.
    expect(v.sizePx).toBe(1.0);
  });

  it('visual: an out scratch is filled and returned (zero-alloc path)', () => {
    const scratch = { brightness: -1, sizePx: -1, alpha: -1 };
    const v = starPointVisual(2, 6.5, STAR_POINT_MAPPING, scratch);
    expect(v).toBe(scratch);
    expect(v).toEqual(starPointVisual(2, 6.5));
  });
});
