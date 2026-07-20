import { describe, expect, it } from 'vitest';
import {
  advanceSunEmergenceFlash,
  advanceSunRotationClock,
  circleOcclusionFraction,
  eclipseOccluderLikeness,
  projectedSourceRadiusAtPlane,
  sunFlareEnvelope,
  sunGlareFloodOpacity,
  sunInteriorWhiteout,
  sunProminenceEjecta,
  sunProminenceEruption,
  sunProminenceRain,
  sunStudyFilterFraction,
  sunWhiteoutFraction,
  SUN_ROTATION_MAX_RATE,
  SUN_ROTATION_PERIOD_MS,
  targetSunExposure,
} from './sunAppearance';

describe('circleOcclusionFraction', () => {
  it('handles clear, total, annular, and partial overlaps', () => {
    expect(circleOcclusionFraction(1, 1, 2)).toBe(0);
    expect(circleOcclusionFraction(1, 1.1, 0)).toBe(1);
    expect(circleOcclusionFraction(1, 0.5, 0)).toBeCloseTo(0.25, 12);
    expect(circleOcclusionFraction(1, 1, 1)).toBeCloseTo(0.3910022, 6);
  });
});

describe('targetSunExposure', () => {
  it('dims a centred zoomed Sun but leaves totality and off-screen views neutral', () => {
    expect(targetSunExposure({ projectedRadiusNdc: 0.175, centerDistanceNdc: 0, visibleFraction: 1 }))
      .toBeCloseTo(0.35, 2);
    expect(targetSunExposure({ projectedRadiusNdc: 0.175, centerDistanceNdc: 0, visibleFraction: 0 }))
      .toBe(1);
    expect(targetSunExposure({ projectedRadiusNdc: 0.175, centerDistanceNdc: 1.5, visibleFraction: 1 }))
      .toBe(1);
  });

  it('reacts gently to a small Sun in a normal cruise FOV', () => {
    const exposure = targetSunExposure({ projectedRadiusNdc: 0.0046, centerDistanceNdc: 0, visibleFraction: 1 });
    expect(exposure).toBeGreaterThan(0.85);
    expect(exposure).toBeLessThan(1);
  });

  it('opens back up at study range where the filter carries the dimming', () => {
    expect(targetSunExposure({ projectedRadiusNdc: 0.95, centerDistanceNdc: 0, visibleFraction: 1 }))
      .toBeCloseTo(0.9, 8);
  });
});

describe('eclipseOccluderLikeness', () => {
  it('rejects annular geometry while accepting a Sun-sized totality occluder', () => {
    expect(eclipseOccluderLikeness(0.999)).toBe(0);
    expect(eclipseOccluderLikeness(1)).toBe(1);
    expect(eclipseOccluderLikeness(1.05)).toBe(1);
    expect(eclipseOccluderLikeness(3)).toBe(0);
  });
});

describe('projectedSourceRadiusAtPlane', () => {
  it('projects by camera-relative distance without diverging near the source', () => {
    expect(projectedSourceRadiusAtPlane(2, 10, 5)).toBe(1);
    expect(projectedSourceRadiusAtPlane(2, 10, 9)).toBeCloseTo(1.8, 12);
    expect(projectedSourceRadiusAtPlane(2, 10, 20)).toBe(2);
  });
});

describe('advanceSunEmergenceFlash', () => {
  it('fires on a fast reveal and decays without another visibility rise', () => {
    const fired = advanceSunEmergenceFlash({
      previousVisibleFraction: 0.1,
      visibleFraction: 0.6,
      flash: 0,
      dt: 1 / 60,
      eligible: true,
    });
    expect(fired).toBeGreaterThan(0.9);
    const decayed = advanceSunEmergenceFlash({
      previousVisibleFraction: 0.6,
      visibleFraction: 0.6,
      flash: fired,
      dt: 0.38,
      eligible: true,
    });
    expect(decayed).toBeCloseTo(fired / Math.E, 6);
  });

  it('does not fire when the Sun enters frame already visible', () => {
    expect(advanceSunEmergenceFlash({
      previousVisibleFraction: 1,
      visibleFraction: 1,
      flash: 0,
      dt: 1 / 60,
      eligible: false,
    })).toBe(0);
  });
});

describe('sunWhiteoutFraction', () => {
  it('leaves the granulation study range untouched and saturates the final approach', () => {
    expect(sunWhiteoutFraction(30)).toBe(0);
    expect(sunWhiteoutFraction(2.6)).toBe(0);
    expect(sunWhiteoutFraction(2.0)).toBeGreaterThan(0.2);
    expect(sunWhiteoutFraction(2.0)).toBeLessThan(0.55);
    // The 1.2-radii governor hover sits in near-total overwhelm...
    expect(sunWhiteoutFraction(1.2)).toBeGreaterThan(0.98);
    expect(sunWhiteoutFraction(1.2)).toBeLessThan(1);
    // ...and contact is pinned full white, continuous with the interior side.
    expect(sunWhiteoutFraction(1.12)).toBe(1);
    expect(sunWhiteoutFraction(1.0)).toBe(1);
    expect(sunWhiteoutFraction(0)).toBe(1);
    expect(sunWhiteoutFraction(-1)).toBe(1);
  });

  it('is monotonic across the bleach band', () => {
    let previous = sunWhiteoutFraction(2.8);
    for (let radii = 2.7; radii >= 1.05; radii -= 0.05) {
      const next = sunWhiteoutFraction(radii);
      expect(next).toBeGreaterThanOrEqual(previous);
      previous = next;
    }
  });
});

describe('sunInteriorWhiteout', () => {
  it('holds the crossing white and hands off to the ember dive with depth', () => {
    expect(sunInteriorWhiteout(1)).toBe(sunWhiteoutFraction(1)); // seamless crossing
    expect(sunInteriorWhiteout(0.95)).toBe(1);
    expect(sunInteriorWhiteout(0.7)).toBeGreaterThan(0.2);
    expect(sunInteriorWhiteout(0.7)).toBeLessThan(0.6);
    expect(sunInteriorWhiteout(0.55)).toBe(0);
    expect(sunInteriorWhiteout(0.2)).toBe(0);
  });
});

describe('sunStudyFilterFraction', () => {
  it('engages only for a large, centred, visible photosphere', () => {
    expect(sunStudyFilterFraction({ projectedRadiusNdc: 0.95, centerDistanceNdc: 0, visibleFraction: 1 }))
      .toBe(1);
    expect(sunStudyFilterFraction({ projectedRadiusNdc: 0.15, centerDistanceNdc: 0, visibleFraction: 1 }))
      .toBe(0);
    // The filter's centre falloff is laxer than the meter's (limb-study
    // poses keep it engaged); it only fully releases past ~1.8 NDC.
    expect(sunStudyFilterFraction({ projectedRadiusNdc: 0.95, centerDistanceNdc: 2.0, visibleFraction: 1 }))
      .toBe(0);
    expect(sunStudyFilterFraction({ projectedRadiusNdc: 0.95, centerDistanceNdc: 0, visibleFraction: 0 }))
      .toBe(0);
  });

  it('moves together with the exposure compensation tier', () => {
    const input = { projectedRadiusNdc: 0.5, centerDistanceNdc: 0, visibleFraction: 1 };
    const filter = sunStudyFilterFraction(input);
    expect(filter).toBeGreaterThan(0);
    expect(filter).toBeLessThan(1);
    // Exposure interpolates toward the 0.9 filtered tier by exactly the
    // filter fraction (metered base is 0.35 for a full-frame centred disc).
    expect(targetSunExposure(input)).toBeCloseTo(0.35 + (0.9 - 0.35) * filter, 8);
  });
});

describe('sunFlareEnvelope', () => {
  it('is deterministic, bounded, and silent without a period', () => {
    expect(sunFlareEnvelope(1234.5, 47, 0)).toBe(sunFlareEnvelope(1234.5, 47, 0));
    expect(sunFlareEnvelope(100, 0, 0)).toBe(0);
    expect(sunFlareEnvelope(100, -5, 0)).toBe(0);
    expect(sunFlareEnvelope(Number.NaN, 47, 0)).toBe(0);
    for (let t = 0; t < 4700; t += 0.73) {
      const env = sunFlareEnvelope(t, 47, 0.41);
      expect(env).toBeGreaterThanOrEqual(0);
      expect(env).toBeLessThanOrEqual(1);
    }
  });

  it('stays quiet most of the time but does fire', () => {
    let lit = 0;
    let peak = 0;
    const samples = 20000;
    for (let i = 0; i < samples; i++) {
      const env = sunFlareEnvelope(i * 0.25, 53, 0.73);
      if (env > 0.05) lit++;
      peak = Math.max(peak, env);
    }
    // A flare is an event: visible well under a tenth of the time, yet the
    // schedule must actually produce strong ones.
    expect(lit / samples).toBeLessThan(0.1);
    expect(peak).toBeGreaterThan(0.5);
  });

  it('rises fast and decays over roughly a tenth of the period', () => {
    // Find a firing cycle, then compare early-phase and late-phase envelopes.
    const period = 47;
    let cycleStart = -1;
    for (let cycle = 0; cycle < 400; cycle++) {
      if (sunFlareEnvelope((cycle + 0.02) * period, period, 0) > 0.5) {
        cycleStart = cycle * period;
        break;
      }
    }
    expect(cycleStart).toBeGreaterThanOrEqual(0);
    const early = sunFlareEnvelope(cycleStart + 0.02 * period, period, 0);
    const late = sunFlareEnvelope(cycleStart + 0.3 * period, period, 0);
    expect(early).toBeGreaterThan(0.5);
    expect(late).toBeLessThan(early * 0.05);
  });
});

describe('sunProminenceEruption', () => {
  it('is deterministic, bounded, and quiet at cycle boundaries', () => {
    expect(sunProminenceEruption(777.7)).toBe(sunProminenceEruption(777.7));
    expect(sunProminenceEruption(Number.NaN)).toBe(0);
    for (let t = 0; t < 16000; t += 1.7) {
      const e = sunProminenceEruption(t);
      expect(e).toBeGreaterThanOrEqual(0);
      expect(e).toBeLessThanOrEqual(1);
    }
    // Phase 0 of every cycle (period 160, seed 0.17) sits before the swell.
    for (let cycle = 0; cycle < 40; cycle++) {
      expect(sunProminenceEruption((cycle - 0.17 + 0.01) * 160)).toBe(0);
    }
  });

  it('produces full eruptions with a swell-and-release shape', () => {
    // Find an active cycle, then check the envelope rises, peaks, and lets go.
    let start = -1;
    for (let cycle = 0; cycle < 60; cycle++) {
      const mid = (cycle - 0.17 + 0.5) * 160;
      if (sunProminenceEruption(mid) > 0.6) { start = (cycle - 0.17) * 160; break; }
    }
    expect(start).toBeGreaterThanOrEqual(0);
    const early = sunProminenceEruption(start + 0.1 * 160);
    const peak = sunProminenceEruption(start + 0.5 * 160);
    const late = sunProminenceEruption(start + 0.9 * 160);
    expect(early).toBeLessThan(peak);
    expect(peak).toBeGreaterThan(0.6);
    expect(late).toBe(0);
  });
});

describe('sunProminenceRain', () => {
  it('is bounded, deterministic, and only rains in cycles that erupted', () => {
    expect(sunProminenceRain(4321.9)).toBe(sunProminenceRain(4321.9));
    expect(sunProminenceRain(Number.NaN)).toBe(0);
    for (let t = 0; t < 16000; t += 1.3) {
      const r = sunProminenceRain(t);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(1);
      // Rain never falls in a cycle whose eruption amplitude hashed to zero:
      // both envelopes share the cycle gate, so mid-cycle eruption silence
      // (phase 0.5, past the swell start) implies rain silence too.
      if (r > 0 && sunProminenceEruption(t) === 0) {
        const phase = ((t / 160 + 0.17) % 1 + 1) % 1;
        expect(phase).toBeGreaterThan(0.5);
      }
    }
  });

  it('rises as the eruption releases and outlives it', () => {
    // Find an erupting cycle, then walk its collapse.
    let start = -1;
    for (let cycle = 0; cycle < 60; cycle++) {
      const mid = (cycle - 0.17 + 0.5) * 160;
      if (sunProminenceEruption(mid) > 0.6) { start = (cycle - 0.17) * 160; break; }
    }
    expect(start).toBeGreaterThanOrEqual(0);
    const atPeak = sunProminenceRain(start + 0.45 * 160);
    const collapsing = sunProminenceRain(start + 0.7 * 160);
    const after = sunProminenceRain(start + 0.82 * 160);
    expect(atPeak).toBe(0);
    expect(collapsing).toBeGreaterThan(0.6);
    // The eruption envelope is gone by phase 0.78; rain keeps falling.
    expect(sunProminenceEruption(start + 0.82 * 160)).toBe(0);
    expect(after).toBeGreaterThan(0.5);
  });
});

describe('advanceSunRotationClock', () => {
  const ROT = SUN_ROTATION_PERIOD_MS;
  const dt = 1 / 60;
  const maxStep = SUN_ROTATION_MAX_RATE * dt * 1000;

  it('syncs on first frame and tracks the sim clock exactly at everyday rates', () => {
    const t0 = Date.UTC(2026, 6, 19);
    expect(advanceSunRotationClock(Number.NaN, t0, dt)).toBe(t0);
    // 1x: one frame advances the sim clock ~17 ms — far under the cap.
    expect(advanceSunRotationClock(t0, t0 + 17, dt)).toBe(t0 + 17);
    // Backward time is symmetric.
    expect(advanceSunRotationClock(t0, t0 - 17, dt)).toBe(t0 - 17);
  });

  it('caps the per-frame step under extreme warp', () => {
    const t0 = Date.UTC(2026, 6, 19);
    // A yr/s frame advances sim time ~526,000 s; the face may only move 6 h/s.
    const next = advanceSunRotationClock(t0, t0 + 5.26e8, dt);
    expect(next - t0).toBeCloseTo(maxStep, 6);
    const back = advanceSunRotationClock(t0, t0 - 5.26e8, dt);
    expect(t0 - back).toBeCloseTo(maxStep, 6);
  });

  it('folds whole Carrington rotations out of a hard time jump', () => {
    const t0 = Date.UTC(2026, 6, 19);
    // Jump three years ahead: identical faces fold away, leaving less than
    // one rotation (plus the capped step) to actually turn through.
    const target = t0 + 3 * 365.25 * 86_400_000;
    const next = advanceSunRotationClock(t0, target, dt);
    const folded = next - t0 - maxStep;
    // Millisecond-scale float residue is fine at epoch magnitudes; what
    // matters is that the fold is a whole number of rotations.
    const mod = ((folded % ROT) + ROT) % ROT;
    expect(Math.min(mod, ROT - mod)).toBeLessThan(1);
    expect(Math.abs(target - next)).toBeLessThan(ROT);
  });
});

describe('sunProminenceEjecta', () => {
  it('launches only when an eruption releases, then recedes and fades out', () => {
    // Find an erupting cycle (same schedule the eruption test walks).
    let start = -1;
    for (let cycle = 0; cycle < 60; cycle++) {
      const mid = (cycle - 0.17 + 0.5) * 160;
      if (sunProminenceEruption(mid) > 0.6) { start = (cycle - 0.17) * 160; break; }
    }
    expect(start).toBeGreaterThanOrEqual(0);
    // Bound before release: invisible, no travel.
    const before = sunProminenceEjecta(start + 0.4 * 160);
    expect(before.visibility).toBe(0);
    expect(before.travel).toBe(0);
    // Mid-flight: visible and under way.
    const flight = sunProminenceEjecta(start + 0.75 * 160);
    expect(flight.visibility).toBeGreaterThan(0.5);
    expect(flight.travel).toBeGreaterThan(0.05);
    // Later: farther and faded.
    const gone = sunProminenceEjecta(start + 0.99 * 160);
    expect(gone.travel).toBeGreaterThan(flight.travel);
    expect(gone.visibility).toBeLessThan(0.05);
  });

  it('stays quiet through cycles whose eruption never fired', () => {
    for (let t = 0; t < 16000; t += 1.1) {
      const { travel, visibility } = sunProminenceEjecta(t);
      expect(visibility).toBeGreaterThanOrEqual(0);
      expect(visibility).toBeLessThanOrEqual(1);
      expect(travel).toBeGreaterThanOrEqual(0);
      expect(travel).toBeLessThanOrEqual(1);
      if (visibility > 0) {
        // Any visible ejecta implies its cycle amplitude fired — the same
        // gate the eruption uses at its swell peak.
        const phase = ((t / 160 + 0.17) % 1 + 1) % 1;
        const swellPeak = (Math.floor(t / 160 + 0.17) - 0.17 + 0.5) * 160;
        expect(phase).toBeGreaterThan(0.55);
        expect(sunProminenceEruption(swellPeak)).toBeGreaterThan(0);
      }
    }
  });
});

describe('sunGlareFloodOpacity', () => {
  it('floods the chrome only at the whiteout wall and stays capped', () => {
    expect(sunGlareFloodOpacity(0)).toBe(0);
    expect(sunGlareFloodOpacity(0.85)).toBe(0);
    expect(sunGlareFloodOpacity(0.92)).toBeGreaterThan(0.05);
    expect(sunGlareFloodOpacity(0.92)).toBeLessThan(0.5);
    expect(sunGlareFloodOpacity(1)).toBeCloseTo(0.65, 12);
    // The 1.2-radii hover floods most of the way but never fully blinds.
    expect(sunGlareFloodOpacity(sunWhiteoutFraction(1.2))).toBeGreaterThan(0.55);
    expect(sunGlareFloodOpacity(sunWhiteoutFraction(1.2))).toBeLessThan(0.65);
  });
});
