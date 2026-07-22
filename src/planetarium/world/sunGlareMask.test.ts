import { describe, it, expect } from 'vitest';
import {
  sunGlareMaskAt,
  sunGlareMaskForRect,
  sunGlareMaskCoreOuterPx,
  sunGlareMaskActivation,
  sunLabelClearRadiusPx,
  sunGlareMaskGLSL,
  type SunGlareMaskParams,
} from './sunGlareMask';
import { SUN_VEIL_BETA, SUN_VEIL_SCALE_H } from '../../shared/shaders/sun';

// Independent re-derivations of the drawn profile, so the tests pin the module
// against hand math rather than against itself.
const H = 950;
const SCALE = SUN_VEIL_SCALE_H * H;
const moffat = (dPx: number) => 1 / Math.pow(1 + (dPx / SCALE) ** 2, SUN_VEIL_BETA);
const ss = (e0: number, e1: number, x: number) => {
  if (e0 === e1) return x < e0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

const base = (): SunGlareMaskParams => ({
  active: true,
  sunXPx: 0,
  sunYPx: 0,
  peak: 1,
  armCoeff: 0,
  armDecayPx: 1,
  armDecayYPx: 1,
  coreOuterPx: 0,
  viewportHeight: H,
});

describe('sunGlareMaskAt — inactive', () => {
  it('is 0 everywhere when the pipeline is ineligible', () => {
    const p: SunGlareMaskParams = { ...base(), active: false, coreOuterPx: 30 };
    expect(sunGlareMaskAt(p, 0, 0)).toBe(0);
    expect(sunGlareMaskAt(p, 5, 5)).toBe(0);
    expect(sunGlareMaskAt(p, 400, 300)).toBe(0);
    expect(sunGlareMaskForRect(p, -10, -10, 10, 10)).toBe(0);
    expect(sunLabelClearRadiusPx(p)).toBe(0);
  });
});

describe('sunGlareMaskAt — wide (Moffat) mask', () => {
  it('fully obscures at the Sun centre', () => {
    // peak · moffat(0) = 1, above the 0.08 upper edge -> mask 1.
    expect(sunGlareMaskAt(base(), 0, 0)).toBeCloseTo(1, 6);
  });

  it('matches smoothstep(0.01, 0.08, peak·moffat) across the ramp', () => {
    const p = base();
    for (const d of [20, 40, 60, 80, 100, 140]) {
      const expected = ss(0.01, 0.08, p.peak * moffat(d));
      expect(sunGlareMaskAt(p, d, 0)).toBeCloseTo(expected, 6);
      // Same distance on the y axis (arms off) is rotationally identical.
      expect(sunGlareMaskAt(p, 0, d)).toBeCloseTo(expected, 6);
    }
  });

  it('crosses through a partial band strictly inside (0, 1)', () => {
    // ~81 px gives peak·moffat ≈ 0.045, the midpoint of the [0.01, 0.08] ramp.
    const m = sunGlareMaskAt(base(), 81, 0);
    expect(m).toBeGreaterThan(0.3);
    expect(m).toBeLessThan(0.7);
  });

  it('is 0 far out where L drops below the lower edge', () => {
    expect(moffat(500)).toBeLessThan(0.01);
    expect(sunGlareMaskAt(base(), 500, 0)).toBe(0);
  });

  it('decreases monotonically with distance from the Sun', () => {
    const p = base();
    let prev = Infinity;
    for (let d = 0; d <= 300; d += 15) {
      const m = sunGlareMaskAt(p, d, 0);
      expect(m).toBeLessThanOrEqual(prev + 1e-9);
      prev = m;
    }
  });
});

describe('sunGlareMaskAt — core mask with the wash idle (Pluto-like)', () => {
  const pluto = (): SunGlareMaskParams => ({ ...base(), peak: 0.0005, coreOuterPx: 30 });

  it('obscures coincident points via the core even though the wash is ~0', () => {
    expect(sunGlareMaskAt(pluto(), 0, 0)).toBeCloseTo(1, 6);
    expect(sunGlareMaskAt(pluto(), 10, 0)).toBeCloseTo(1, 6); // inside 0.45·30
  });

  it('drops to 0 past the core radius (no wash to carry it)', () => {
    expect(sunGlareMaskAt(pluto(), 30, 0)).toBe(0);
    expect(sunGlareMaskAt(pluto(), 45, 0)).toBe(0);
  });

  it('ramps down across the outer half of the core', () => {
    const m = sunGlareMaskAt(pluto(), 22, 0); // between 13.5 and 30
    expect(m).toBeGreaterThan(0);
    expect(m).toBeLessThan(1);
  });

  it('honours the 22 px no-bloom core radius (headless always takes bloom=30)', () => {
    // The controller feeds coreOuterPx = 22 on the no-bloom fallback; verify the
    // mask math respects that smaller radius since it cannot be exercised in a
    // GPU-capable headless browser (which always reports float-FBO bloom).
    const noBloom = (): SunGlareMaskParams => ({ ...base(), peak: 0.0005, coreOuterPx: 22 });
    expect(sunGlareMaskAt(noBloom(), 0, 0)).toBeCloseTo(1, 6);
    expect(sunGlareMaskAt(noBloom(), 9, 0)).toBeCloseTo(1, 6); // inside 0.45·22 ≈ 9.9
    expect(sunGlareMaskAt(noBloom(), 22, 0)).toBe(0);
    // Acts over a tighter radius than the 30 px bloom core at the same point.
    expect(sunGlareMaskAt(noBloom(), 24, 0)).toBeLessThan(sunGlareMaskAt(pluto(), 24, 0));
  });
});

describe('sunGlareMaskForRect — nearest-point', () => {
  const p: SunGlareMaskParams = {
    active: true,
    sunXPx: 700,
    sunYPx: 475,
    peak: 0.8,
    armCoeff: 0.28,
    armDecayPx: 30,
    armDecayYPx: 12,
    coreOuterPx: 30,
    viewportHeight: H,
  };

  it('equals the point mask when the rectangle degenerates to a point', () => {
    for (const [x, y] of [[700, 475], [720, 500], [600, 400], [900, 475], [400, 600]]) {
      expect(sunGlareMaskForRect(p, x, y, x, y)).toBeCloseTo(sunGlareMaskAt(p, x, y), 12);
    }
  });

  it('uses the nearest edge point of an offset rectangle', () => {
    // Rect entirely to the right of the Sun: nearest point is its left edge.
    expect(sunGlareMaskForRect(p, 710, 470, 760, 494)).toBeCloseTo(
      sunGlareMaskAt(p, 710, 475),
      12,
    );
  });

  it('reads the Sun centre when the rectangle contains it', () => {
    expect(sunGlareMaskForRect(p, 690, 465, 710, 485)).toBeCloseTo(
      sunGlareMaskAt(p, 700, 475),
      12,
    );
  });
});

describe('sunLabelClearRadiusPx', () => {
  it('is the pad floor while the wash is idle, and grows past it', () => {
    expect(sunLabelClearRadiusPx({ ...base(), peak: 0 })).toBe(12);
    expect(sunLabelClearRadiusPx({ ...base(), peak: 0.02 })).toBe(12);
    expect(sunLabelClearRadiusPx({ ...base(), peak: 0.5 })).toBeGreaterThan(12);
  });

  it('is monotone non-decreasing in peak', () => {
    let prev = -Infinity;
    for (const peak of [0, 0.01, 0.02, 0.03, 0.05, 0.1, 0.3, 0.6, 1.0, 1.5]) {
      const r = sunLabelClearRadiusPx({ ...base(), peak });
      expect(r).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
  });

  it('is continuous across the L = 0.02 boundary', () => {
    // As peak approaches 0.02 from above the solved radius approaches the pad,
    // so the pad-floor branch joins the Moffat solve without a step.
    expect(sunLabelClearRadiusPx({ ...base(), peak: 0.0200001 })).toBeCloseTo(12, 1);
    expect(sunLabelClearRadiusPx({ ...base(), peak: 0.02 })).toBe(12);
  });

  it('is 0 when inactive regardless of peak', () => {
    expect(sunLabelClearRadiusPx({ ...base(), active: false, peak: 1 })).toBe(0);
  });
});

describe('sunGlareMaskGLSL', () => {
  it('interpolates the shared Moffat constants as GLSL floats', () => {
    const src = sunGlareMaskGLSL();
    expect(src).toContain(String(SUN_VEIL_SCALE_H));
    expect(src).toContain(String(SUN_VEIL_BETA));
    expect(src).toContain('float sunGlareMask(vec4 clip)');
    // Guards the degenerate cases the GPU path relies on.
    expect(src).toContain('uSunMaskActive < 0.5');
    expect(src).toContain('clip.w <= 0.0');
  });
});

describe('sunGlareMaskCoreOuterPx', () => {
  it('is exactly max(floor, 2.5·radius) at full exposure', () => {
    expect(sunGlareMaskCoreOuterPx(100, 30, 1)).toBeCloseTo(250, 9);
    expect(sunGlareMaskCoreOuterPx(100, 300, 1)).toBeCloseTo(300, 9);
  });

  it('collapses to 0 only in the final totality band', () => {
    expect(sunGlareMaskCoreOuterPx(100, 30, 0)).toBe(0);
    expect(sunGlareMaskCoreOuterPx(1000, 500, 0)).toBe(0);
  });

  it('still covers the whole disc plus a 1.2× margin through a deep partial', () => {
    // A surviving sliver (10% exposed) keeps the core over the disc + margin so
    // stars can't pop against the limb-hugging bloom.
    expect(sunGlareMaskCoreOuterPx(100, 1, 0.1)).toBeGreaterThanOrEqual(120);
  });

  it('is monotone nondecreasing in the exposed fraction', () => {
    let prev = -Infinity;
    for (let f = 0; f <= 1.0001; f += 0.05) {
      const v = sunGlareMaskCoreOuterPx(100, 30, f);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = v;
    }
  });

  it('lets the glint floor win for a tiny disc', () => {
    expect(sunGlareMaskCoreOuterPx(1, 30, 1)).toBeCloseTo(30, 9);
  });

  it('is continuous across the 0.002 totality-collapse band', () => {
    const a = sunGlareMaskCoreOuterPx(100, 30, 0.001);
    const b = sunGlareMaskCoreOuterPx(100, 30, 0.002);
    const c = sunGlareMaskCoreOuterPx(100, 30, 0.003);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(b); // still ramping up through the band
    expect(c).toBeGreaterThanOrEqual(b);
    // No step: 0.001 sits near the half-way point of the smooth ramp.
    expect(a).toBeGreaterThan(0.2 * b);
  });
});

describe('sunGlareMaskActivation', () => {
  const input = (overrides: Partial<Parameters<typeof sunGlareMaskActivation>[0]>) => ({
    sunFootprintKind: 'none' as const,
    sunXPx: 0,
    sunYPx: 0,
    coreOuterPx: 0,
    washSupportPx: 0,
    viewportWidth: 1280,
    viewportHeight: 720,
    ...overrides,
  });

  it('never activates on a covering footprint, however large the core', () => {
    // The covering fallback is a guess, not a measurement — with the camera
    // outside the photosphere it must not erase the sky.
    expect(sunGlareMaskActivation(input({
      sunFootprintKind: 'covering', sunXPx: 640, sunYPx: 360, coreOuterPx: 5000,
    }))).toBe(false);
  });

  it('is false for a far off-frame centre with a small support disc', () => {
    expect(sunGlareMaskActivation(input({ sunXPx: 2000, sunYPx: 360, coreOuterPx: 30 }))).toBe(false);
  });

  it('is true when an off-frame centre has a support disc reaching the edge', () => {
    // Nearest viewport point (1280, 360) is 720 px away — inside a 750 px disc.
    expect(sunGlareMaskActivation(input({
      sunXPx: 2000, sunYPx: 360, coreOuterPx: 750,
    }))).toBe(true);
  });

  it('honours the wash support radius when the core is small', () => {
    expect(sunGlareMaskActivation(input({
      sunXPx: 2000, sunYPx: 360, coreOuterPx: 10, washSupportPx: 800,
    }))).toBe(true);
    expect(sunGlareMaskActivation(input({
      sunXPx: 2000, sunYPx: 360, coreOuterPx: 10, washSupportPx: 100,
    }))).toBe(false);
  });

  it('is true for an on-frame centre with a sampled footprint', () => {
    // Centre inside the viewport rect: the support disc always overlaps.
    expect(sunGlareMaskActivation(input({
      sunFootprintKind: 'sampled', sunXPx: 640, sunYPx: 360, coreOuterPx: 5,
    }))).toBe(true);
  });

  it('regression: the recorded cruise-blackout telemetry does not activate', () => {
    // The failing pose fed a covering footprint / 3671.5 px core centred at
    // (1920, 360) on a 1280×720 frame. Either signal must leave the mask inert.
    expect(sunGlareMaskActivation(input({
      sunFootprintKind: 'covering', sunXPx: 1920, sunYPx: 360, coreOuterPx: 3671.5,
    }))).toBe(false);
    // Even reclassified 'none', the off-frame support can't reach the viewport.
    expect(sunGlareMaskActivation(input({
      sunFootprintKind: 'none', sunXPx: 1920, sunYPx: 360, coreOuterPx: 30, washSupportPx: 0,
    }))).toBe(false);
  });
});
