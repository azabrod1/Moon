import { describe, expect, it } from 'vitest';
import {
  advanceSunEmergenceFlash,
  circleOcclusionFraction,
  diamondRingStrength,
  eclipseOccluderLikeness,
  projectedSourceRadiusAtPlane,
  silhouetteSizeGate,
  sunGlareFloodOpacity,
  sunInteriorWhiteout,
  sunWhiteoutFraction,
  targetSunExposure,
  visibleCrescentGeometry,
  type CrescentGeometry,
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

  it('stops down further only when the photosphere fills most of the frame', () => {
    expect(targetSunExposure({ projectedRadiusNdc: 0.95, centerDistanceNdc: 0, visibleFraction: 1 }))
      .toBeCloseTo(0.25, 8);
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

describe('visibleCrescentGeometry', () => {
  // Independent brute-force centroid of (Sun disc − occluder disc): the Sun is
  // the unit circle at the origin, the occluder radius r centred at (sep, 0).
  function numericCentroid(sep: number, r: number): number {
    const N = 1600;
    const step = 2 / N;
    let count = 0;
    let sumX = 0;
    for (let i = 0; i < N; i++) {
      const x = -1 + (i + 0.5) * step;
      for (let j = 0; j < N; j++) {
        const y = -1 + (j + 0.5) * step;
        if (x * x + y * y > 1) continue; // outside the Sun
        const dx = x - sep;
        if (dx * dx + y * y <= r * r) continue; // covered by the occluder
        count += 1;
        sumX += x;
      }
    }
    return count > 0 ? sumX / count : 0;
  }

  const out: CrescentGeometry = { centroidSr: 0, extentSr: 0 };

  it('matches a numerically integrated centroid across regimes, always exposed-side', () => {
    for (const [sep, r] of [
      [0.4, 0.6],
      [0.5, 0.5], // occluder touching the limb from inside
      [0.9, 0.4], // deep partial
      [0.2, 0.9], // large occluder, near concentric
      [1.05, 1.0], // total-onset partial (occluder Sun-sized)
      [0.7, 0.7],
    ] as const) {
      visibleCrescentGeometry(sep, r, out);
      const numeric = numericCentroid(sep, r);
      expect(out.centroidSr).toBeCloseTo(numeric, 2);
      // The exposed crescent is always on the far side from the occluder (+x).
      expect(out.centroidSr).toBeLessThanOrEqual(0);
    }
  });

  it('stays centred for concentric geometry (no false annular shift)', () => {
    visibleCrescentGeometry(0, 0.5, out);
    expect(out.centroidSr).toBe(0);
    expect(out.extentSr).toBeCloseTo(1, 12); // ring width summed: 2(1 − r)
  });

  it('reports zero centroid when clear or fully covered', () => {
    visibleCrescentGeometry(2.5, 0.5, out); // no overlap
    expect(out.centroidSr).toBe(0);
    expect(out.extentSr).toBeCloseTo(2, 12); // whole Sun exposed
    visibleCrescentGeometry(0, 1.2, out); // engulfed
    expect(out.centroidSr).toBe(0);
    expect(out.extentSr).toBe(0);
  });

  it('measures the along-axis exposed width of a partial', () => {
    visibleCrescentGeometry(0.9, 0.4, out); // 1 + d − r
    expect(out.extentSr).toBeCloseTo(1.5, 12);
  });
});

describe('diamondRingStrength', () => {
  const like = eclipseOccluderLikeness;

  it('gives an annular (sub-Sun) occluder no diamond at any coverage', () => {
    for (let vis = 0; vis <= 0.02; vis += 0.001) {
      expect(diamondRingStrength(like(0.97), vis)).toBe(0);
    }
  });

  it('is exactly 0 at totality and above the sliver band for a total eclipse', () => {
    const l = like(1.05); // 1
    expect(diamondRingStrength(l, 0)).toBe(0);
    expect(diamondRingStrength(l, 0.012)).toBe(0);
    expect(diamondRingStrength(l, 0.02)).toBe(0);
    expect(diamondRingStrength(l, 0.05)).toBe(0);
  });

  it('blazes through the second/third-contact sliver band, monotone each side', () => {
    const l = like(1.05);
    // rising edge out of totality is monotone nondecreasing
    let prev = -1;
    for (let vis = 0; vis <= 0.00031; vis += 0.00003) {
      const v = diamondRingStrength(l, vis);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = v;
    }
    // there is a real burst inside the band
    expect(diamondRingStrength(l, 0.002)).toBeGreaterThan(0.5);
    expect(diamondRingStrength(l, 0.008)).toBeGreaterThan(0.1);
    // and it decays monotonically across the band
    expect(diamondRingStrength(l, 0.001)).toBeGreaterThan(diamondRingStrength(l, 0.008));
  });
});

describe('silhouetteSizeGate', () => {
  it('keeps the silhouette for eclipse-scale occluders, annular through total', () => {
    expect(silhouetteSizeGate(0.9)).toBe(1);  // annular (sub-Sun) keeps its black disc
    expect(silhouetteSizeGate(1.05)).toBe(1); // just past total
    expect(silhouetteSizeGate(3)).toBe(1);    // still eclipse scale at the edge
  });

  it('drops the silhouette for a landscape-scale foreground body', () => {
    expect(silhouetteSizeGate(8)).toBe(0);
    expect(silhouetteSizeGate(20)).toBe(0);
    expect(silhouetteSizeGate(100)).toBe(0);
  });

  it('is monotone nonincreasing across the 3x-8x handoff', () => {
    let prev = Infinity;
    for (let r = 0; r <= 12; r += 0.25) {
      const g = silhouetteSizeGate(r);
      expect(g).toBeLessThanOrEqual(prev + 1e-9);
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThanOrEqual(1);
      prev = g;
    }
    // Midway through the handoff it is strictly between the two plateaus.
    const mid = silhouetteSizeGate(5.5);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
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
