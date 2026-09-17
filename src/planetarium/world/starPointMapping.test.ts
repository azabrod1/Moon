import { describe, expect, it } from 'vitest';
import {
  STAR_FAINT_ANCHOR_MAG,
  STAR_POINT_MAPPING,
  pointSpritePixelRatio,
  starBeyondAnchorScale,
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

  it('leaves everything at or above the anchor completely untouched', () => {
    // The whole point of pinning the anchor: deepening the catalog must not
    // reach any star that was already on the sky.
    for (const mag of [-1.44, 0, 2.5, 5, 6.5, 7.0, STAR_FAINT_ANCHOR_MAG]) {
      expect(starBeyondAnchorScale(mag)).toBe(1);
    }
  });

  it('tapers past the anchor toward a floor, never to nothing', () => {
    const p = STAR_POINT_MAPPING;
    const justPast = starBeyondAnchorScale(STAR_FAINT_ANCHOR_MAG + 0.48); // the 7.5 catalog edge
    expect(justPast).toBeLessThan(1);
    expect(justPast).toBeGreaterThan(p.beyondAnchorAlphaScale);
    // Monotone down, and it bottoms out rather than fading a real star away.
    let previous = 1;
    for (let d = 0; d <= 4; d += 0.1) {
      const scale = starBeyondAnchorScale(STAR_FAINT_ANCHOR_MAG + d);
      expect(scale).toBeLessThanOrEqual(previous + 1e-12);
      expect(scale).toBeGreaterThanOrEqual(p.beyondAnchorAlphaScale);
      previous = scale;
    }
    expect(starBeyondAnchorScale(STAR_FAINT_ANCHOR_MAG + p.beyondAnchorRangeMag))
      .toBeCloseTo(p.beyondAnchorAlphaScale, 12);
  });

  it('visual: an out scratch is filled and returned (zero-alloc path)', () => {
    const scratch = { brightness: -1, sizePx: -1, alpha: -1 };
    const v = starPointVisual(2, 6.5, STAR_POINT_MAPPING, scratch);
    expect(v).toBe(scratch);
    expect(v).toEqual(starPointVisual(2, 6.5));
  });
});

// The sizing rule the starfield and the moon dots share. Its whole job is to
// keep a sky point the same CSS size when the scene's resolution moves under a
// fixed canvas, and to be EXACTLY the old `min(outputRatio, 2)` when it does
// not — the graphics-quality campaign's promise is that Medium is today's
// frame byte for byte, and a uniform one float apart is a different frame.
describe('pointSpritePixelRatio', () => {
  it('is exactly min(outputRatio, 2) wherever the scene is the canvas', () => {
    for (const r of [1, 1.25, 1.5, 1.6, 1.739, 1.9, 2, 2.5, 3]) {
      expect(pointSpritePixelRatio(r, r)).toBe(Math.min(r, 2));
    }
  });

  it('holds the CSS size when a rung moves the scene under a 2x canvas', () => {
    // At an output ratio of 2 the cap never bites, so the point is sized in
    // whatever pixels the scene is drawn in and its CSS size never moves.
    for (const scene of [1.5, 1.739, 2, 2.5, 3]) {
      const px = pointSpritePixelRatio(scene, 2);
      expect(px).toBeCloseTo(scene, 12);
      expect(px / scene).toBeCloseTo(pointSpritePixelRatio(2, 2) / 2, 12); // same CSS size
    }
  });

  it('keeps the display cap on a 2.5x desktop, at every rung', () => {
    // The cap holds a point at the device size it has on a 2x display: on a
    // 2.5x canvas that is size × 2 OUTPUT px, and it stays size × 2 output px
    // when Low drops the scene to 1.875 — where the old rule, fed the scene
    // ratio, gave min(1.875, 2) = 1.875 and drew the point 25 % larger.
    const cssAtMedium = pointSpritePixelRatio(2.5, 2.5) / 2.5;
    expect(cssAtMedium).toBeCloseTo(2 / 2.5, 12);
    const low = pointSpritePixelRatio(1.875, 2.5);
    expect(low).toBeCloseTo(1.5, 12); // scene px
    expect(low / 1.875).toBeCloseTo(cssAtMedium, 12); // the same CSS size
    expect(low / 1.875 * 2.5).toBeCloseTo(2, 12); // = size × 2 output px, not 2.5
  });

  it('a 3x scene on a 2x canvas is two thirds larger in scene px, not two thirds smaller', () => {
    // The defect this rule fixes, stated as a number: fed the scene ratio, the
    // cap gave min(3, 2) = 2 and every star was 2/3 of its CSS size at High.
    expect(pointSpritePixelRatio(3, 2)).toBe(3);
    expect(Math.min(3, 2)).toBe(2);
  });
});
