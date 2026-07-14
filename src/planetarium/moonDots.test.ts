import { describe, expect, it } from 'vitest';
import { MOONS } from './planets/moonData';
import { PLANETARIUM_BODIES } from './planets/planetData';
import { MOON_RENDER_ANCHOR_RATIO, renderedMoonRadiusAU } from './moonRenderSize';
import { starPointVisual } from './world/starPointMapping';
import {
  MOON_DOT_PARAMS,
  albedoProxyFromColor,
  chromaticityRGB,
  discDiameterPx,
  moonDotMagnitude,
  moonDotVisual,
  phaseIllumination,
  pickMoonTextureUpgrade,
  systemEdgeFade,
} from './moonDots';

const P = MOON_DOT_PARAMS;
// A representative star faint limit for the mapping (the app derives the real
// one from the bright-star catalog). The magnitude anchors sit far brighter than
// this, so its exact value only matters for the faint-limit continuity tests.
const FAINT_LIMIT = 6.5;

const europa = MOONS.find((m) => m.name === 'Europa')!;
const jupiter = PLANETARIUM_BODIES.find((b) => b.name === 'Jupiter')!;
const EUROPA_RENDERED_AU = renderedMoonRadiusAU(europa.radiusAU, jupiter.radiusAU, MOON_RENDER_ANCHOR_RATIO);
const EUROPA_ALBEDO = albedoProxyFromColor(europa.color);
const R_SUN_JUP = 5.2;

/** Sample the full visual for a moon at Δ = distAU, full phase, unshaded. */
const visualAt = (distAU: number, opts: Partial<{ discPx: number; isTarget: boolean; edgeFade: number; phaseCos: number; shade: number }> = {}) =>
  moonDotVisual(
    EUROPA_RENDERED_AU,
    distAU,
    R_SUN_JUP,
    opts.phaseCos ?? 1,
    EUROPA_ALBEDO,
    opts.shade ?? 1,
    opts.discPx ?? 0.5,
    opts.isTarget ?? false,
    opts.edgeFade ?? 1,
    FAINT_LIMIT,
  );

/** Distance (AU) that yields a target apparent magnitude at full phase. */
const deltaForMag = (mag: number) => {
  const flux = Math.pow(10, (P.magZeroPoint - mag) / 2.5);
  return (EUROPA_RENDERED_AU * Math.sqrt(EUROPA_ALBEDO)) / (Math.sqrt(flux) * R_SUN_JUP);
};

describe('moonDots — geometry helpers', () => {
  it('phaseIllumination spans 0 (new) to 1 (full)', () => {
    expect(phaseIllumination(1)).toBeCloseTo(1, 12);
    expect(phaseIllumination(0)).toBeCloseTo(0.5, 12);
    expect(phaseIllumination(-1)).toBe(0);
    expect(phaseIllumination(-2)).toBe(0); // clamped, never negative
  });

  it('albedo proxy is the tint luminance clamped to the band × gain', () => {
    // Bright white saturates to the max; near-black floors to the min.
    expect(albedoProxyFromColor(0xffffff)).toBeCloseTo(P.albedoMax, 6);
    expect(albedoProxyFromColor(0x000000)).toBeCloseTo(P.albedoMin, 6);
    for (const m of MOONS) {
      const a = albedoProxyFromColor(m.color);
      expect(a).toBeGreaterThanOrEqual(P.albedoMin - 1e-9);
      expect(a).toBeLessThanOrEqual(P.albedoMax + 1e-9);
    }
  });

  it('chromaticity normalizes to max channel 1 (hue only)', () => {
    const out = { r: 0, g: 0, b: 0 };
    chromaticityRGB(0x804020, out);
    expect(Math.max(out.r, out.g, out.b)).toBeCloseTo(1, 12);
    // A darker shade of the same hue yields the same chromaticity.
    const out2 = { r: 0, g: 0, b: 0 };
    chromaticityRGB(0x402010, out2);
    expect(out2.r).toBeCloseTo(out.r, 6);
    expect(out2.g).toBeCloseTo(out.g, 6);
    expect(out2.b).toBeCloseTo(out.b, 6);
  });
});

describe('moonDots — magnitude model (calibration)', () => {
  it('Europa at the close standoff is naked-eye bright (≈ mag −5)', () => {
    const mag = moonDotMagnitude(EUROPA_RENDERED_AU, 0.036, R_SUN_JUP, 1, EUROPA_ALBEDO);
    expect(mag).toBeGreaterThan(-5.5);
    expect(mag).toBeLessThan(-4.5);
  });

  it('Europa a third of an AU out is bright-star class (m < 1.5)', () => {
    const mag = moonDotMagnitude(EUROPA_RENDERED_AU, 0.5, R_SUN_JUP, 1, EUROPA_ALBEDO);
    expect(mag).toBeLessThan(1.5);
  });

  it('magnitude is +Infinity when unlit (phase or eclipse zeroes the flux)', () => {
    expect(moonDotMagnitude(EUROPA_RENDERED_AU, 0.1, R_SUN_JUP, 0, EUROPA_ALBEDO)).toBe(Infinity);
  });

  it('brighter (closer) never raises the magnitude', () => {
    let prev = Infinity;
    for (const d of [1.0, 0.5, 0.2, 0.1, 0.05, 0.02]) {
      const mag = moonDotMagnitude(EUROPA_RENDERED_AU, d, R_SUN_JUP, 1, EUROPA_ALBEDO);
      expect(mag).toBeLessThanOrEqual(prev + 1e-9);
      prev = mag;
    }
  });

  it('discDiameterPx pins Europa to ~1 px at 0.0357 AU (fov 60, H 1200)', () => {
    expect(discDiameterPx(EUROPA_RENDERED_AU, 0.0357, 60, 1200)).toBeCloseTo(1.0, 1);
  });
});

describe('moonDots — visual composition', () => {
  it('a sub-pixel lit moon is fully visible; approaching never dims it pre-handoff', () => {
    let prev = -1;
    for (const d of [1.0, 0.5, 0.2, 0.1, 0.05]) {
      const v = visualAt(d, { discPx: 0.5 });
      expect(v.intensity).toBeGreaterThanOrEqual(prev - 1e-9); // monotone non-decreasing
      prev = v.intensity;
    }
    expect(visualAt(0.05, { discPx: 0.5 }).intensity).toBeCloseTo(1, 6); // saturated bright
  });

  it('the disc handoff crossfades alpha to exactly 0 at fadeEnd, monotone in discPx', () => {
    let prev = Infinity;
    for (const px of [0, P.fadeStartPx, 3.5, 4.5, P.fadeEndPx - 1e-6, P.fadeEndPx, P.fadeEndPx + 20]) {
      const a = visualAt(0.05, { discPx: px }).alpha;
      expect(a).toBeLessThanOrEqual(prev + 1e-9);
      prev = a;
    }
    expect(visualAt(0.05, { discPx: P.fadeEndPx }).alpha).toBe(0);
    expect(visualAt(0.05, { discPx: 100 }).alpha).toBe(0);
  });

  it('zeroes: new phase, full eclipse, and a resolved disc all give alpha 0', () => {
    expect(visualAt(0.05, { phaseCos: -1 }).alpha).toBe(0); // new phase → illum 0
    expect(visualAt(0.05, { shade: 0 }).alpha).toBe(0); // fully eclipsed
    expect(visualAt(0.05, { discPx: P.fadeEndPx + 1 }).alpha).toBe(0); // disc resolved
  });

  it('brightness/size match the shared star mapping for the dot magnitude', () => {
    const v = visualAt(0.3, { discPx: 0.5 }); // sub-fadeStart disc → no shrink
    const star = starPointVisual(v.magnitude, FAINT_LIMIT);
    expect(v.brightness).toBeCloseTo(star.brightness, 12);
    expect(v.sizePx).toBeCloseTo(star.sizePx, 12);
  });

  it('shrink-to-disc only shrinks: a big point converges, a faint point never grows', () => {
    // Bright point (natural size at the top of the star band) shrinks toward the disc.
    const bright = visualAt(0.05, { discPx: P.fadeEndPx - 1e-6 });
    const brightNoShrink = starPointVisual(visualAt(0.05, { discPx: 0.5 }).magnitude, FAINT_LIMIT).sizePx;
    expect(bright.sizePx).toBeLessThan(brightNoShrink);
    // Faint point (mag near the limit → ~1.2px) never grows toward a 5px disc.
    const faintMag = FAINT_LIMIT - 0.2;
    const d = deltaForMag(faintMag);
    const faintNatural = starPointVisual(faintMag, FAINT_LIMIT).sizePx;
    const faint = moonDotVisual(EUROPA_RENDERED_AU, d, R_SUN_JUP, 1, EUROPA_ALBEDO, 1, 5.0, false, 1, FAINT_LIMIT);
    expect(faint.sizePx).toBeLessThanOrEqual(faintNatural + 1e-9);
  });
});

describe('moonDots — faint-end extension continuity', () => {
  it('meets the star floor at the limit and ramps to 0 over faintExtendMag', () => {
    const at = (mag: number) =>
      moonDotVisual(EUROPA_RENDERED_AU, deltaForMag(mag), R_SUN_JUP, 1, EUROPA_ALBEDO, 1, 0.5, false, 1, FAINT_LIMIT).intensity;
    // At the limit the extension multiplier is 1, so intensity == the star floor.
    expect(at(FAINT_LIMIT)).toBeCloseTo(0.45, 2);
    // Halfway down the extension.
    expect(at(FAINT_LIMIT + P.faintExtendMag / 2)).toBeCloseTo(0.225, 2);
    // Fully faded out at the bottom of the extension.
    expect(at(FAINT_LIMIT + P.faintExtendMag)).toBeCloseTo(0, 3);
    // Monotone non-increasing across the whole faint tail.
    let prev = Infinity;
    for (let mag = FAINT_LIMIT - 1; mag <= FAINT_LIMIT + P.faintExtendMag + 0.5; mag += 0.2) {
      const v = at(mag);
      expect(v).toBeLessThanOrEqual(prev + 1e-9);
      prev = v;
    }
  });
});

describe('moonDots — nav-target floor ordering', () => {
  const veryDim = deltaForMag(FAINT_LIMIT + 5); // far past the faint tail: intensity 0 without a floor

  it('floors a dim target above the visibility threshold', () => {
    expect(visualAt(veryDim, { discPx: 0.5, isTarget: false }).intensity).toBe(0);
    expect(visualAt(veryDim, { discPx: 0.5, isTarget: true }).intensity).toBeCloseTo(P.targetMinIntensity, 6);
  });

  it('the floor does not bypass the disc crossfade or the system-edge fade', () => {
    // Target but disc resolved → still 0.
    expect(visualAt(veryDim, { discPx: 100, isTarget: true }).alpha).toBe(0);
    // Target but at the very system edge → still 0.
    expect(visualAt(veryDim, { discPx: 0.5, isTarget: true, edgeFade: 0 }).alpha).toBe(0);
    // Target inside the system with a sub-pixel disc → the floor shows through.
    expect(visualAt(veryDim, { discPx: 0.5, isTarget: true, edgeFade: 1 }).alpha).toBeCloseTo(P.targetMinIntensity, 6);
  });

  it('never floors an unlit target (no flux → no dot)', () => {
    expect(visualAt(veryDim, { discPx: 0.5, isTarget: true, phaseCos: -1 }).intensity).toBe(0);
    expect(visualAt(veryDim, { discPx: 0.5, isTarget: true, shade: 0 }).intensity).toBe(0);
  });
});

describe('moonDots — system-edge fade', () => {
  it('is 0 at the outer threshold and 1 once fully inside', () => {
    const threshold = 0.3;
    expect(systemEdgeFade(threshold, threshold)).toBeCloseTo(0, 12);
    expect(systemEdgeFade(threshold * (1 - P.systemEdgeFadeFrac), threshold)).toBeCloseTo(1, 12);
    expect(systemEdgeFade(threshold * 0.5, threshold)).toBe(1); // deep inside → clamped
  });

  it('is monotone increasing as the player moves inward', () => {
    const threshold = 0.4;
    let prev = -1;
    for (const d of [0.4, 0.38, 0.36, 0.34, 0.3, 0.1]) {
      const f = systemEdgeFade(d, threshold);
      expect(f).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = f;
    }
  });

  it('multiplies the dot alpha (a system fading in never over-brightens)', () => {
    const full = visualAt(0.1, { discPx: 0.5, edgeFade: 1 }).alpha;
    const half = visualAt(0.1, { discPx: 0.5, edgeFade: 0.5 }).alpha;
    expect(half).toBeCloseTo(full * 0.5, 6);
    expect(visualAt(0.1, { discPx: 0.5, edgeFade: 0 }).alpha).toBe(0);
  });
});

describe('moonDots — texture upgrade pick (threshold + throttle + non-starvation)', () => {
  it('returns none below the threshold', () => {
    expect(
      pickMoonTextureUpgrade([
        { discPx: P.texUpgradeDiscPx - 1, eligible: true },
        { discPx: 10, eligible: true },
      ]),
    ).toBe(-1);
  });

  it('picks the first eligible moon past the threshold (one per frame)', () => {
    expect(
      pickMoonTextureUpgrade([
        { discPx: P.texUpgradeDiscPx + 1, eligible: true },
        { discPx: 500, eligible: true },
      ]),
    ).toBe(0);
  });

  it('an ineligible over-threshold moon does not consume the slot (non-starvation)', () => {
    // First moon is huge on screen but already-sharp/photo/CPU-painted → skip it,
    // upgrade the later eligible one instead.
    expect(
      pickMoonTextureUpgrade([
        { discPx: 500, eligible: false },
        { discPx: P.texUpgradeDiscPx + 1, eligible: true },
      ]),
    ).toBe(1);
    expect(
      pickMoonTextureUpgrade([
        { discPx: 500, eligible: false },
        { discPx: 10, eligible: true },
      ]),
    ).toBe(-1);
  });
});

describe('moonDots — current tuning (defaults)', () => {
  // A deliberate retune of MOON_DOT_PARAMS updates exactly the pins here.
  it('pins the Europa magnitude anchor at the documented standoff', () => {
    expect(moonDotMagnitude(EUROPA_RENDERED_AU, 0.036, R_SUN_JUP, 1, EUROPA_ALBEDO)).toBeCloseTo(-5, 1);
  });

  it('pins the crossfade window and the target floor', () => {
    expect(P.fadeStartPx).toBe(2.5);
    expect(P.fadeEndPx).toBe(6.0);
    expect(P.targetMinIntensity).toBe(0.04);
    expect(P.texUpgradeDiscPx).toBe(96);
  });
});
