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
  parentDominanceFade,
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

/** Sample the full visual for a moon at Δ = distAU, full phase, unshaded. The
 *  two fade slots default to 1 (fully inside the system, parent anchoring). */
const visualAt = (
  distAU: number,
  opts: Partial<{ discPx: number; isTarget: boolean; systemFade: number; parentFade: number; phaseCos: number; shade: number }> = {},
) =>
  moonDotVisual(
    EUROPA_RENDERED_AU,
    distAU,
    R_SUN_JUP,
    opts.phaseCos ?? 1,
    EUROPA_ALBEDO,
    opts.shade ?? 1,
    opts.discPx ?? 0.5,
    opts.isTarget ?? false,
    opts.systemFade ?? 1,
    opts.parentFade ?? 1,
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

  it('matches the shared star mapping in the mid range; the scene ceiling binds the bright end', () => {
    // Mid-range magnitude (no caps bind): exact star parity.
    const midMag = 3.0;
    const mid = moonDotVisual(
      EUROPA_RENDERED_AU, deltaForMag(midMag), R_SUN_JUP, 1, EUROPA_ALBEDO, 1, 0.5, false, 1, 1, FAINT_LIMIT,
    );
    const midStar = starPointVisual(mid.magnitude, FAINT_LIMIT);
    expect(mid.brightness).toBeCloseTo(midStar.brightness, 12);
    expect(mid.sizePx).toBeCloseTo(midStar.sizePx, 12);
    // Bright end: a mag −5-class dot renders as a mag-ceiling star, size-capped —
    // never the star mapping's own 6.5px/1.2 top end (the planets are tonemapped;
    // an uncapped point would out-render its parent).
    const bright = visualAt(0.036, { discPx: 0.5 });
    expect(bright.magnitude).toBeLessThan(-4);
    const ceilingStar = starPointVisual(P.magCeiling, FAINT_LIMIT);
    expect(bright.brightness).toBeCloseTo(ceilingStar.brightness, 12);
    expect(bright.sizePx).toBeCloseTo(Math.min(ceilingStar.sizePx, P.sizeMaxPx), 12);
    expect(bright.sizePx).toBeLessThanOrEqual(P.sizeMaxPx);
  });

  it('the handoff ramps brightness to the disc-matched luminance before the dot dies', () => {
    // Deep in the window (t ≥ 0.6): brightness has fully reached the disc estimate.
    const late = visualAt(0.05, { discPx: 8 });
    expect(late.brightness).toBeCloseTo(P.discMatchLum * Math.min(EUROPA_ALBEDO, 1), 6);
    expect(late.alpha).toBeGreaterThan(0); // the point is still there while it matches
    // Below the window: untouched star brightness at the scene ceiling.
    const before = visualAt(0.05, { discPx: 0.5 });
    expect(before.brightness).toBeCloseTo(starPointVisual(P.magCeiling, FAINT_LIMIT).brightness, 12);
    // Brightness is monotone non-increasing across the window for a bright dot.
    let prev = Infinity;
    for (const px of [0.5, P.fadeStartPx, 5, 6.5, 8, P.fadeEndPx]) {
      const b = visualAt(0.05, { discPx: px }).brightness;
      expect(b).toBeLessThanOrEqual(prev + 1e-9);
      prev = b;
    }
    // A half-lit disc matches at half the luminance (phase enters the target).
    const half = visualAt(0.05, { discPx: 8, phaseCos: 0 });
    expect(half.brightness).toBeCloseTo(P.discMatchLum * Math.min(EUROPA_ALBEDO, 1) * 0.5, 6);
  });

  it('point size never exceeds the cap and never grows toward a big disc', () => {
    for (const px of [0.5, P.fadeStartPx, 5, 8, P.fadeEndPx - 1e-6]) {
      expect(visualAt(0.05, { discPx: px }).sizePx).toBeLessThanOrEqual(P.sizeMaxPx + 1e-9);
    }
    // Faint point (mag near the limit → ~1.2px) never grows toward a 5px disc.
    const faintMag = FAINT_LIMIT - 0.2;
    const d = deltaForMag(faintMag);
    const faintNatural = starPointVisual(faintMag, FAINT_LIMIT).sizePx;
    const faint = moonDotVisual(EUROPA_RENDERED_AU, d, R_SUN_JUP, 1, EUROPA_ALBEDO, 1, 5.0, false, 1, 1, FAINT_LIMIT);
    expect(faint.sizePx).toBeLessThanOrEqual(faintNatural + 1e-9);
    // Shrink binds when the disc is smaller than the capped point inside the window.
    const tiny = visualAt(0.05, { discPx: P.fadeStartPx + 0.2 });
    expect(tiny.sizePx).toBeLessThanOrEqual(Math.min(P.sizeMaxPx, starPointVisual(P.magCeiling, FAINT_LIMIT).sizePx));
  });
});

describe('moonDots — faint-end extension continuity', () => {
  it('meets the star floor at the limit and ramps to 0 over faintExtendMag', () => {
    const at = (mag: number) =>
      moonDotVisual(EUROPA_RENDERED_AU, deltaForMag(mag), R_SUN_JUP, 1, EUROPA_ALBEDO, 1, 0.5, false, 1, 1, FAINT_LIMIT).intensity;
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
    expect(visualAt(veryDim, { discPx: 0.5, isTarget: true, systemFade: 0 }).alpha).toBe(0);
    // Target inside the system with a sub-pixel disc → the floor shows through.
    expect(visualAt(veryDim, { discPx: 0.5, isTarget: true, systemFade: 1 }).alpha).toBeCloseTo(P.targetMinIntensity, 6);
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
    const full = visualAt(0.1, { discPx: 0.5, systemFade: 1 }).alpha;
    const half = visualAt(0.1, { discPx: 0.5, systemFade: 0.5 }).alpha;
    expect(half).toBeCloseTo(full * 0.5, 6);
    expect(visualAt(0.1, { discPx: 0.5, systemFade: 0 }).alpha).toBe(0);
  });
});

describe('moonDots — parent-dominance gate', () => {
  it('is 0 while the parent is dot-scale and 1 once it anchors the scene', () => {
    expect(parentDominanceFade(0)).toBe(0);
    expect(parentDominanceFade(P.parentGateStartPx)).toBe(0);
    expect(parentDominanceFade(P.parentGateFullPx)).toBe(1);
    expect(parentDominanceFade(500)).toBe(1);
  });

  it('is monotone across the ramp', () => {
    let prev = -1;
    for (let px = 0; px <= P.parentGateFullPx + 5; px += 1) {
      const f = parentDominanceFade(px);
      expect(f).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = f;
    }
  });

  it('multiplies into the dot alpha through the parentFade slot (composition)', () => {
    // A mid-ramp parent (no proximity release) scales a non-target dot's alpha
    // proportionally, exactly like the system-edge fade.
    const mid = parentDominanceFade((P.parentGateStartPx + P.parentGateFullPx) / 2);
    expect(mid).toBeCloseTo(0.5, 6); // smoothstep midpoint
    const full = visualAt(0.1, { discPx: 0.5, parentFade: 1 }).alpha;
    const gated = visualAt(0.1, { discPx: 0.5, parentFade: mid }).alpha;
    expect(gated).toBeCloseTo(full * mid, 6);
  });
});

describe('moonDots — parent-gate proximity release', () => {
  // parentDominanceFade(0, ratio) forces the gate term to 0 (disc ≪ start), so
  // the result equals the proximity-release term alone — the clean way to pin it.
  const releaseAt = (ratio: number) => parentDominanceFade(0, ratio);

  it('is 1 inside relFullRatio, 0 outside relZeroRatio, and monotone in ratio', () => {
    expect(releaseAt(0)).toBe(1);
    expect(releaseAt(P.relFullRatio)).toBeCloseTo(1, 12);
    expect(releaseAt(P.relFullRatio - 0.05)).toBeCloseTo(1, 12);
    expect(releaseAt(P.relZeroRatio)).toBeCloseTo(0, 12);
    expect(releaseAt(P.relZeroRatio + 0.5)).toBe(0);
    let prev = Infinity;
    for (let r = 0; r <= 1.0; r += 0.02) {
      const v = releaseAt(r);
      expect(v).toBeLessThanOrEqual(prev + 1e-9);
      prev = v;
    }
  });

  it('a non-finite or negative ratio releases 0; ratio 0 releases 1 (degenerates)', () => {
    expect(parentDominanceFade(0, Number.NaN)).toBe(0);
    expect(parentDominanceFade(0, -1)).toBe(0);
    expect(parentDominanceFade(0, Infinity)).toBe(0);
    expect(parentDominanceFade(0, 0)).toBe(1);
    // Default (no ratio) is the shipped gate-only behavior: release 0.
    expect(parentDominanceFade(0)).toBe(0);
  });

  it('returns the max of gate and release, incl. the crossover point', () => {
    // gate dominates: parent fully anchoring, far outside the orbit shell.
    expect(parentDominanceFade(P.parentGateFullPx, 2.0)).toBe(1);
    // release dominates: parent dot-scale, deep inside the shell.
    expect(parentDominanceFade(2, 0.1)).toBeCloseTo(1, 12);
    // disc 15 gives gate 0.5 exactly (midpoint of 8..22); ratio 0.55 gives
    // release 0.5 (midpoint of relFull..relZero) → max is 0.5 by both branches.
    expect(parentDominanceFade(15, 0.55)).toBeCloseTo(0.5, 12);
    // gate 0.5 > release 0.104 (ratio 0.58) → gate wins.
    expect(parentDominanceFade(15, 0.58)).toBeCloseTo(0.5, 6);
    // release 0.896 > gate ≈ 0.198 (disc 12, ratio 0.52) → release wins.
    expect(parentDominanceFade(12, 0.52)).toBeCloseTo(0.896, 3);
  });
});

describe('moonDots — nav-target floor survives the parent gate (design A)', () => {
  const veryDim = deltaForMag(FAINT_LIMIT + 5); // no photometric contribution of its own

  it('floors a lit target through parentFade 0, still composing crossfade + system-edge', () => {
    // discPx 6.75 = the crossfade midpoint (linear 3.5..10) → smoothstep t = 0.5.
    const v = visualAt(veryDim, { isTarget: true, discPx: 6.75, systemFade: 0.7, parentFade: 0 });
    expect(v.alpha).toBeCloseTo(P.targetMinIntensity * (1 - 0.5) * 0.7, 12);
    // The floor still dies at the system edge and once the disc resolves.
    expect(visualAt(veryDim, { isTarget: true, discPx: 6.75, systemFade: 0, parentFade: 0 }).alpha).toBe(0);
    expect(visualAt(veryDim, { isTarget: true, discPx: P.fadeEndPx, systemFade: 1, parentFade: 0 }).alpha).toBe(0);
  });

  it('uses the photometric branch when the gated star exceeds the floor', () => {
    const opts = { discPx: 0.5, systemFade: 1, parentFade: 0.5 } as const;
    const idle = visualAt(0.05, opts); // bright non-target
    const target = visualAt(0.05, { ...opts, isTarget: true });
    // gatedStar = intensityStar·0.5 ≫ floor → target === non-target exactly.
    expect(target.alpha).toBeCloseTo(idle.alpha, 12);
    expect(target.alpha).toBeGreaterThan(P.targetMinIntensity);
  });

  it('a non-target with the gate closed and no proximity release draws nothing', () => {
    const parentFade = parentDominanceFade(P.parentGateStartPx, Infinity); // gate 0, release 0
    expect(parentFade).toBe(0);
    expect(visualAt(0.05, { discPx: 0.5, parentFade }).alpha).toBe(0);
  });

  it('does not pop when the nav-target flag drops while the release is full', () => {
    // Deep inside the neighborhood (ratio 0.2 → release 1 → parentFade 1); a dot
    // bright enough that its photometric alpha already clears the floor is
    // identical target vs idle, so disengaging autopilot never flickers it.
    const parentFade = parentDominanceFade(2, 0.2);
    expect(parentFade).toBeCloseTo(1, 12);
    const asTarget = visualAt(0.1, { discPx: 0.5, parentFade, isTarget: true });
    const asIdle = visualAt(0.1, { discPx: 0.5, parentFade, isTarget: false });
    expect(asTarget.alpha).toBeCloseTo(asIdle.alpha, 12);
    expect(asTarget.alpha).toBeGreaterThan(P.targetMinIntensity);
  });

  it('an Ananke-like non-target inside its neighborhood draws a visible dot', () => {
    const ananke = MOONS.find((m) => m.name === 'Ananke')!;
    const parentFade = parentDominanceFade(4, 0.35); // gate 0 (4<8), release 1 (0.35<relFull)
    expect(parentFade).toBeCloseTo(1, 12);
    const v = moonDotVisual(
      2.7e-6, 0.05, 5.2, 1, albedoProxyFromColor(ananke.color), 1, 0.5, false, 1, parentFade, FAINT_LIMIT,
    );
    expect(v.alpha).toBeGreaterThan(0.1);
  });

  it('keeps the floor above the label and QA visibility bars (retune guard)', () => {
    // renderMoonLabels gates a sub-pixel label at dotAlpha ≥ 0.03; the outbound
    // continuity QA bar is 0.02. The floor must clear both, or a retune could
    // silently kill the nav-target label while the dot still (barely) shows.
    const LABEL_DOT_MIN_ALPHA = 0.03;
    const QA_DOT_MIN_ALPHA = 0.02;
    expect(P.targetMinIntensity).toBeGreaterThan(LABEL_DOT_MIN_ALPHA);
    expect(P.targetMinIntensity).toBeGreaterThan(QA_DOT_MIN_ALPHA);
  });
});

describe('moonDots — outbound dead-zone sweep (the bug pin)', () => {
  const R_JUP = 4.779e-4; // Jupiter radius, AU
  // Collinear outbound path Jupiter → moon: player from 0.02 AU-from-Jupiter to
  // arrival, the moon dead ahead at its orbit radius. The tuned release ratios
  // must keep the combined parent fade ≥ 0.2 at every sampled position, or the
  // dot dead-zones out where the parent's disc has shrunk below the gate but the
  // moon's own disc hasn't resolved yet. The bar is 0.2 rather than the
  // achievable ~0.29 because the ramp width buys temporal smoothness instead —
  // a boundary crossing must fade, not blink (see the params comment).
  const minCombined = (orbitR: number, H: number) => {
    let min = Infinity;
    for (let p = 0.02; p <= orbitR - 5e-5; p += 0.0002) {
      const ratio = (orbitR - p) / orbitR;
      const combined = parentDominanceFade(discDiameterPx(R_JUP, p, 60, H), ratio);
      if (combined < min) min = combined;
    }
    return min;
  };

  for (const [name, orbitR] of [['Ananke', 0.1422], ['Elara', 0.0785]] as const) {
    for (const H of [900, 1200]) {
      it(`combined parent fade stays ≥ 0.2 outbound to ${name} (canvas H ${H})`, () => {
        expect(minCombined(orbitR, H)).toBeGreaterThanOrEqual(0.2);
      });
    }
  }
});

describe('moonDots — static no-release sweep', () => {
  it('releases ≤ 0.05 from every vantage outside 1.6× a catalog irregular orbit radius', () => {
    // Catalog irregulars: the outer, widely-orbiting moons (orbit radius well
    // beyond a Galilean's). Worst case for the release is the moon collinear on
    // the near side, so distToMoon = (mult − 1)·orbitR and proximityRatio =
    // mult − 1 ≥ 0.6 for mult ≥ 1.6. The gate is forced to 0 here so the fade
    // equals the release term alone.
    const irregulars = MOONS.filter((m) => m.orbitalRadiusAU > 0.04);
    expect(irregulars.length).toBeGreaterThan(4); // sanity: the set is non-trivial
    let maxRelease = 0;
    for (const m of irregulars) {
      for (const mult of [1.6, 2.0, 2.5, 3.0]) {
        const ratio = ((mult - 1) * m.orbitalRadiusAU) / m.orbitalRadiusAU;
        const release = parentDominanceFade(0, ratio);
        if (release > maxRelease) maxRelease = release;
      }
    }
    expect(maxRelease).toBeLessThanOrEqual(0.05);
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

  it('pins the crossfade window, scene ceiling, and the target floor', () => {
    expect(P.fadeStartPx).toBe(3.5);
    expect(P.fadeEndPx).toBe(10.0);
    expect(P.magCeiling).toBe(0.2);
    expect(P.sizeMaxPx).toBe(4.2);
    expect(P.discMatchLum).toBe(0.6);
    expect(P.parentGateStartPx).toBe(8);
    expect(P.parentGateFullPx).toBe(22);
    // Proximity-release ratios: relZero pinned by the static sweep, the 0.1-wide
    // ramp trades a little dead-zone trough (≈ 0.22 vs the achievable 0.29) for
    // a fade instead of a blink at the boundary (see the params comment).
    expect(P.relFullRatio).toBe(0.5);
    expect(P.relZeroRatio).toBe(0.6);
    expect(P.targetMinIntensity).toBe(0.04);
    // Below the ~87px disc a deck arrival parks at, so arrivals sharpen.
    expect(P.texUpgradeDiscPx).toBe(80);
  });
});
