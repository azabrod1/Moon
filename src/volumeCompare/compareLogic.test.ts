import { describe, expect, it } from 'vitest';
import {
  MEAN_RADII_KM,
  MASSES_KG,
  COMPARE_TUNABLES,
  TRY_NEXT,
  meanRadiusKm,
  volumeRatio,
  ballsAcross,
  pickRegime,
  buildComparison,
  formatCount,
  formatAcross,
  formatOdometer,
  sliderTargetCount,
  sliderForTarget,
  sliderFillsExactly,
  pourBudget,
  spawnAllowance,
  drainTarget,
  targetReached,
  sandFillFraction,
  sandGrainBudget,
  heapHeightAt,
  heapSplit,
  liquidAtRim,
  sphericalCapVolume,
  capHeightForVolume,
  nextPhase,
  commitSession,
  isStale,
  escIntent,
  brimStats,
  massRatioText,
  endCardModel,
  bodyDisplayName,
  pluralizeBody,
  capitalizeSentence,
} from './compareLogic';
import type { ComparePhase } from './compareLogic';
import { PLANETARIUM_BODIES } from '../planetarium/planets/planetData';
import { MOONS } from '../planetarium/planets/moonData';

/** Relative-tolerance check for the numeric goldens (independent of display). */
function relClose(actual: number, want: number, rel = 0.002): void {
  expect(Math.abs(actual - want) / Math.abs(want)).toBeLessThan(rel);
}

describe('volumeRatio — numeric goldens (±0.2%, display-independent)', () => {
  // "A→B" reads "A pours into B": container = B, filler = A.
  it('Earth→Jupiter = 1321.3', () => relClose(volumeRatio('Jupiter', 'Earth'), 1321.3));
  it('Moon→Earth = 49.31', () => relClose(volumeRatio('Earth', 'Moon'), 49.31));
  it('Saturn→Jupiter = 1.7304', () => relClose(volumeRatio('Jupiter', 'Saturn'), 1.7304));
  it('Pluto→Moon = 3.126', () => relClose(volumeRatio('Moon', 'Pluto'), 3.126));
  it('Earth→Sun = 1.306e6', () => relClose(volumeRatio('Sun', 'Earth'), 1.306e6));
  it('Moon→Jupiter = 65,153', () => relClose(volumeRatio('Jupiter', 'Moon'), 65_153));

  it('same body is exactly 1', () => {
    expect(volumeRatio('Earth', 'Earth')).toBe(1);
  });
  it('NaN when a body is unresolved', () => {
    expect(Number.isNaN(volumeRatio('Nibiru', 'Earth'))).toBe(true);
  });
});

describe('formatCount — display goldens (separate from numeric goldens)', () => {
  it('0<n<1: two significant figures, plain decimal', () => {
    expect(formatCount(0.000757)).toBe('0.00076');
    expect(formatCount(0.578)).toBe('0.58');
  });
  it('1..10: two decimals', () => {
    expect(formatCount(1.73)).toBe('1.73');
    expect(formatCount(1)).toBe('1.00'); // same-body
  });
  it('10..100: one decimal', () => {
    expect(formatCount(49.3)).toBe('49.3');
  });
  it('100..100k: integer with thousands separators', () => {
    expect(formatCount(1321.3)).toBe('1,321');
  });
  it('100k..1M: ≈ nearest thousand, grouped', () => {
    expect(formatCount(203_663)).toBe('≈204,000');
  });
  it('1M..1B: ≈ two-decimal millions', () => {
    expect(formatCount(1_305_678)).toBe('≈1.31 million');
  });
  it('1B..1T: ≈ two-decimal billions (Jupiter/Carme ≈ 2.808e10)', () => {
    expect(formatCount(1e9)).toBe('≈1.00 billion');
    expect(formatCount(2.808e10)).toBe('≈28.08 billion'); // the extreme sand pair
    expect(formatCount(999_000_000)).toBe('≈999.00 million'); // just under a billion stays million
  });
  it('1T..1Q and beyond name the magnitude, never "28083.62 million"', () => {
    expect(formatCount(1e12)).toBe('≈1.00 trillion');
    expect(formatCount(2.5e13)).toBe('≈25.00 trillion');
    expect(formatCount(1e15)).toBe('≈1.00 quadrillion');
    expect(formatCount(4.2e16)).toBe('≈42.00 quadrillion');
  });

  it('band boundaries land in the correct band', () => {
    expect(formatCount(10)).toBe('10.0'); // 10..100
    expect(formatCount(100)).toBe('100'); // 100..100k
    expect(formatCount(100_000)).toBe('≈100,000'); // 100k..1M
    expect(formatCount(1_000_000)).toBe('≈1.00 million'); // 1M..1B
  });
});

describe('targetReached — regime-aware pour/ghost satisfaction', () => {
  it('marbles: floor(target), so a fractional target settles at its floor', () => {
    // 287.6 is satisfied at 287 (whole balls) — this is the ping-pong pin: at 287
    // it is reached (no re-pour), one below it is not (keep pouring).
    expect(targetReached(287.6, 287, 'marbles')).toBe(true);
    expect(targetReached(287.6, 286, 'marbles')).toBe(false);
    // and it never lingers half a ball short the way `poured >= target - 0.5` did.
    expect(targetReached(287.6, 287.6, 'marbles')).toBe(true);
  });
  it('boulders: half of a 1.73 pair (0.865) pours then holds mid-slump', () => {
    // fresh: not reached → the settling phase pours the boulder.
    expect(targetReached(0.865, 0, 'boulders')).toBe(false);
    // melted to its share: reached → no further pour (D7 partial hold), not a
    // full fill — the floor(0.865)=0 marble rule would have made this inert.
    expect(targetReached(0.865, 0.865, 'boulders')).toBe(true);
  });
  it('boulders: a mid-band increase 0.3 → 0.7 pours the delta', () => {
    // held at 0.3, target raised to 0.7 → not reached → pour the extra 0.4.
    expect(targetReached(0.7, 0.3, 'boulders')).toBe(false);
    expect(targetReached(0.7, 0.7, 'boulders')).toBe(true);
  });
  it('sand pours on the whole-ball rule (P4: the stream fills toward floor(target))', () => {
    // P4 REWRITE (was "sand never pours in P3"): sand is pourable now — the
    // stream drives floor(melted) toward the target, so a partial sand target
    // (e.g. 204000.6) is reached at its floor, one whole grain below is not.
    expect(targetReached(204_000.6, 204_000, 'sand')).toBe(true);
    expect(targetReached(204_000.6, 203_999, 'sand')).toBe(false);
    expect(targetReached(0, 0, 'sand')).toBe(true);
  });
});

describe('sandFillFraction — the sand ramp (P4)', () => {
  it('endpoints: 0 at/before the open, exactly 1 at/after the close', () => {
    expect(sandFillFraction(0, 24)).toBe(0);
    expect(sandFillFraction(-2, 24)).toBe(0);
    expect(sandFillFraction(24, 24)).toBe(1); // EXACT landing — the odometer reads N
    expect(sandFillFraction(30, 24)).toBe(1);
    expect(sandFillFraction(5, 0)).toBe(1); // a zero window is already complete
  });
  it('monotone non-decreasing across the window', () => {
    let prev = -1;
    for (let i = 0; i <= 200; i++) {
      const v = sandFillFraction((24 * i) / 200, 24);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(prev).toBe(1);
  });
  it('soft landing: the derivative vanishes into the close (decelerates, never snaps)', () => {
    // Numeric slope over the last 1% of the window is far below the mid slope —
    // the count eases into its final number.
    const d = 24 / 1000;
    const slopeEnd = (sandFillFraction(24, 24) - sandFillFraction(24 - d, 24)) / d;
    const slopeMid = (sandFillFraction(12 + d, 24) - sandFillFraction(12 - d, 24)) / (2 * d);
    expect(slopeEnd).toBeLessThan(0.02 * slopeMid);
  });
  it('soft start: the derivative vanishes out of the open', () => {
    const d = 24 / 1000;
    const slopeStart = (sandFillFraction(d, 24) - sandFillFraction(0, 24)) / d;
    const slopeMid = (sandFillFraction(12 + d, 24) - sandFillFraction(12 - d, 24)) / (2 * d);
    expect(slopeStart).toBeLessThan(0.05 * slopeMid);
  });
});

describe('sandGrainBudget — two tiers, one boolean (P4)', () => {
  it('full tier (bloom + desktop) = 3000, weak tier = 1500', () => {
    expect(sandGrainBudget(true, false)).toBe(3000); // full
    expect(sandGrainBudget(false, false)).toBe(1500); // no bloom → weak
    expect(sandGrainBudget(true, true)).toBe(1500); // mobile → weak
    expect(sandGrainBudget(false, true)).toBe(1500); // both signals never quarter
  });
});

describe('heapHeightAt — the sand cone profile (CPU/GPU mirror)', () => {
  it('crest at the axis, zero at the wall, linear flank between', () => {
    const peakH = 0.08;
    expect(heapHeightAt(0, peakH)).toBeCloseTo(peakH, 10); // crest is the full peak
    expect(heapHeightAt(1, peakH)).toBeCloseTo(0, 10); // meets the glass wall at 0
    expect(heapHeightAt(0.5, peakH)).toBeCloseTo(peakH * 0.5, 10); // straight flank
    expect(heapHeightAt(0.25, peakH)).toBeCloseTo(peakH * 0.75, 10);
  });
  it('no flat annulus — strictly decreasing crest→wall', () => {
    let prev = Infinity;
    for (let i = 0; i <= 40; i++) {
      const h = heapHeightAt(i / 40, 0.08);
      expect(h).toBeLessThan(prev + 1e-12);
      prev = h;
    }
  });
  it('clamps to 0 past the wall, scales linearly with peak, peak 0 is flat', () => {
    expect(heapHeightAt(1.3, 0.08)).toBe(0); // a grain drifted past the wall
    expect(heapHeightAt(0.2, 0.1)).toBeCloseTo(2 * heapHeightAt(0.2, 0.05), 10);
    for (const rr of [0, 0.25, 0.5, 0.75, 1, 1.5]) expect(heapHeightAt(rr, 0)).toBe(0);
  });
});

describe('heapSplit — the pure frame-independent bulk/cone solve', () => {
  const R = 0.995; // R_LIQ (studio units)
  const V_FULL = (4 / 3) * Math.PI * R * R * R;
  const SLOPE = 0.6;
  const K = 0.55;
  const MOUTH_Y = 0.9901; // the tightest sand mouth (mouthRadius floor 0.14, containerR 1)

  // Reconstruct the total volume the split represents — cap of the bulk plus the
  // full-width cone of the returned crest — the round-trip check against V.
  function heapVolume(bulkH: number, peakH: number): number {
    const y = bulkH - R;
    const discR2 = Math.max(0, R * R - y * y);
    return sphericalCapVolume(bulkH, R) + (Math.PI / 3) * discR2 * peakH;
  }

  it('round-trips F(heapSplit(V)) = V to ≤1e-6·V_full across the fill range', () => {
    for (let i = 1; i < 200; i++) {
      const V = (i / 200) * V_FULL;
      const { bulkH, peakH } = heapSplit(V, R, MOUTH_Y, SLOPE, K);
      expect(Math.abs(heapVolume(bulkH, peakH) - V)).toBeLessThan(1e-6 * V_FULL);
    }
  });

  it('exact endpoints: V=0 ⇒ (0,0); V=V_full ⇒ (2R, 0) flat at the brim', () => {
    expect(heapSplit(0, R, MOUTH_Y, SLOPE, K)).toEqual({ bulkH: 0, peakH: 0 });
    const full = heapSplit(V_FULL, R, MOUTH_Y, SLOPE, K);
    expect(full.bulkH).toBeCloseTo(2 * R, 10);
    expect(full.peakH).toBe(0);
    // Over-full and negative clamp to the endpoints (defensive).
    expect(heapSplit(V_FULL * 1.5, R, MOUTH_Y, SLOPE, K)).toEqual({ bulkH: 2 * R, peakH: 0 });
    expect(heapSplit(-1, R, MOUTH_Y, SLOPE, K)).toEqual({ bulkH: 0, peakH: 0 });
  });

  it('F(h) is strictly increasing over a dense h grid for every slope/mouth pair', () => {
    // Mirror of the solve's F so the bisection precondition is pinned directly.
    const peakCap = (h: number, slope: number, mouthY: number): number => {
      const y = h - R;
      const discR = Math.sqrt(Math.max(0, R * R - y * y));
      return Math.max(0, Math.min(slope * discR, K * (mouthY - y)));
    };
    const F = (h: number, slope: number, mouthY: number): number => {
      const y = h - R;
      const discR2 = Math.max(0, R * R - y * y);
      return sphericalCapVolume(h, R) + (Math.PI / 3) * discR2 * peakCap(h, slope, mouthY);
    };
    for (const slope of [0.5, 0.6, 0.8]) {
      for (const mouthY of [0.955, 0.9901]) {
        let prev = -Infinity;
        for (let i = 0; i <= 4000; i++) {
          const h = (i / 4000) * 2 * R;
          const v = F(h, slope, mouthY);
          expect(v).toBeGreaterThan(prev); // strictly monotone → bisection is valid
          prev = v;
        }
      }
    }
  });

  it('reads as a heap at partial fills and flattens toward the brim', () => {
    // A real cone exists through the body of the fill (the "growing heap" read).
    for (const frac of [0.1, 0.25, 0.5, 0.7]) {
      const { bulkH, peakH } = heapSplit(frac * V_FULL, R, MOUTH_Y, SLOPE, K);
      expect(peakH).toBeGreaterThan(0);
      expect(bulkH).toBeLessThan(2 * R);
    }
    // Through the bottom half the slope cap binds: the flank sits at exact repose.
    const lowMid = heapSplit(0.3 * V_FULL, R, MOUTH_Y, SLOPE, K);
    const discRLow = Math.sqrt(Math.max(0, R * R - (lowMid.bulkH - R) ** 2));
    expect(lowMid.peakH).toBeCloseTo(SLOPE * discRLow, 6); // repose, not headroom
    // Near the brim the headroom cap wins and the crest relaxes toward flat.
    const near = heapSplit(0.97 * V_FULL, R, MOUTH_Y, SLOPE, K);
    expect(near.peakH).toBeLessThan(lowMid.peakH);
    expect(near.bulkH).toBeLessThan(2 * R); // a near-max partial is NOT full
  });

  it('peakH is continuous under the real sand ramp — no pops where the heap reads', () => {
    // Couple to the actual pour ramp (sandFillFraction over sandFillS at 60 fps), not
    // a flat ΔV: near V=0 the ramp eases in (smoothstep derivative → 0), so its max
    // per-frame step lands at MID fill where peakH is gentle. Simulate both the full
    // fill (24 s) and the fast-partial floor (4 s) frame by frame.
    for (const dur of [COMPARE_TUNABLES.sandFillS, 4]) {
      const frames = Math.round(dur * 60);
      let prev = heapSplit(0, R, MOUTH_Y, SLOPE, K).peakH;
      let maxReadable = 0; // fill ≥ 0.05: the visible heap range
      let maxBirth = 0; // fill < 0.05: the repose cone forming at the pole
      for (let f = 1; f <= frames; f++) {
        const fill = sandFillFraction(f / frames, 1);
        const peakH = heapSplit(fill * V_FULL, R, MOUTH_Y, SLOPE, K).peakH;
        const jump = Math.abs(peakH - prev);
        if (fill >= 0.05) maxReadable = Math.max(maxReadable, jump);
        else maxBirth = Math.max(maxBirth, jump);
        prev = peakH;
      }
      // Where the heap reads, consecutive frames never pop.
      expect(maxReadable).toBeLessThan(0.008);
      // The pour-start transient is the repose cone being born (peakH ~ V^(1/3), the
      // signature sand cue vs liquid's slow rise) — continuous and bounded, never a
      // discontinuous jump.
      expect(maxBirth).toBeLessThan(0.05);
    }
  });

  it('is a pure function of V — dt-independent (coarse vs fine ramp land identical)', () => {
    // Same total volume reached by two different accumulation histories ⇒ identical
    // state, because heapSplit reads nothing but its arguments (the reuse-rider
    // contract: no grain/scene state, no call-order dependence).
    const target = 0.63 * V_FULL;
    let coarse = 0;
    for (let i = 0; i < 3; i++) coarse += target / 3;
    let fine = 0;
    for (let i = 0; i < 137; i++) fine += target / 137;
    const a = heapSplit(coarse, R, MOUTH_Y, SLOPE, K);
    const b = heapSplit(fine, R, MOUTH_Y, SLOPE, K);
    expect(a.bulkH).toBeCloseTo(b.bulkH, 9);
    expect(a.peakH).toBeCloseTo(b.peakH, 9);
    // Repeated calls are byte-identical (deterministic, no hidden state).
    expect(heapSplit(target, R, MOUTH_Y, SLOPE, K)).toEqual(
      heapSplit(target, R, MOUTH_Y, SLOPE, K),
    );
  });

  it('bulkH is monotone increasing in V (the observable of F monotonicity)', () => {
    let prev = -Infinity;
    for (let i = 0; i <= 300; i++) {
      const { bulkH } = heapSplit((i / 300) * V_FULL, R, MOUTH_Y, SLOPE, K);
      expect(bulkH).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = bulkH;
    }
  });

  it('NaN-free at the degenerate zeros (discR = 0, peakH = 0)', () => {
    for (const V of [0, 1e-12 * V_FULL, V_FULL, V_FULL - 1e-9]) {
      const { bulkH, peakH } = heapSplit(V, R, MOUTH_Y, SLOPE, K);
      expect(Number.isFinite(bulkH)).toBe(true);
      expect(Number.isFinite(peakH)).toBe(true);
      expect(peakH).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('liquidAtRim — the visual top-out trigger (P4)', () => {
  const R = 1;
  const rimY = 2 * 0.995; // 2·R_liq, the full-fill render height
  it('true only once the eased level is within ~0.5% of R of the rim', () => {
    expect(liquidAtRim(rimY, rimY, R)).toBe(true); // exactly at the rim
    expect(liquidAtRim(rimY - 0.004, rimY, R)).toBe(true); // inside the 0.005·R epsilon
    expect(liquidAtRim(rimY - 0.02, rimY, R)).toBe(false); // still easing up — no spill yet
    expect(liquidAtRim(0, rimY, R)).toBe(false); // empty
  });
});

describe('formatAcross — the "n across" preview line', () => {
  it('whole numbers from 3 up (no trailing .0 that formatCount would add)', () => {
    expect(formatAcross(10.97)).toBe('11'); // Earth-in-Jupiter; formatCount → "11.0"
    expect(formatAcross(3)).toBe('3');
    expect(formatAcross(3.67)).toBe('4'); // Moon-in-Earth
    expect(formatAcross(16)).toBe('16');
  });
  it('one decimal below 3, where the fraction reads', () => {
    expect(formatAcross(1.2)).toBe('1.2');
    expect(formatAcross(2.5)).toBe('2.5');
    expect(formatAcross(2.99)).toBe('3.0');
  });
});

describe('formatOdometer — the whole-ball counter', () => {
  it('rounds to an integer with separators, never a decimal', () => {
    expect(formatOdometer(8)).toBe('8'); // formatCount would say "8.00"
    expect(formatOdometer(28)).toBe('28'); // formatCount would say "28.0"
    expect(formatOdometer(131)).toBe('131');
    expect(formatOdometer(1321)).toBe('1,321');
    expect(formatOdometer(8.4)).toBe('8'); // fractional in flight → rounded
    expect(formatOdometer(0)).toBe('0');
  });
});

describe('regime picking', () => {
  it('boulder / marble boundary straddles 3.1 balls across (N = 3.1^3 ≈ 29.79)', () => {
    expect(pickRegime(29)).toBe('boulders');
    expect(pickRegime(30)).toBe('marbles');
    expect(ballsAcross(29)).toBeLessThan(COMPARE_TUNABLES.boulderMaxAcross);
    expect(ballsAcross(30)).toBeGreaterThan(COMPARE_TUNABLES.boulderMaxAcross);
  });
  it('marble / sand boundary straddles 16 balls across (N = 16^3 = 4096)', () => {
    expect(pickRegime(4095)).toBe('marbles');
    expect(pickRegime(4096)).toBe('marbles'); // exactly on the boundary → middle regime
    expect(pickRegime(4097)).toBe('sand'); // one past → sand pours (P4)
  });
  it('exactly on a boundary counts as the middle regime', () => {
    expect(pickRegime(Math.pow(COMPARE_TUNABLES.boulderMaxAcross, 3))).toBe('marbles');
    expect(pickRegime(Math.pow(COMPARE_TUNABLES.sandMinAcross, 3))).toBe('marbles');
  });

  it('buildComparison flags subUnity for N < 1 and clears it otherwise', () => {
    const teaser = buildComparison('Earth', 'Jupiter'); // Jupiter into Earth: unsatisfiable
    expect(teaser.subUnity).toBe(true);
    expect(teaser.n).toBeLessThan(1);

    const hero = buildComparison('Jupiter', 'Earth');
    expect(hero.subUnity).toBe(false);
    relClose(hero.n, 1321.3);
    expect(hero.regime).toBe('marbles');
    expect(hero.across).toBe(Math.cbrt(hero.n)); // across is exactly N^(1/3)
  });
});

describe('spherical-cap liquid math', () => {
  const R = 1; // studio scale: container inner radius = 1 unit
  const full = (4 / 3) * Math.PI * R * R * R;

  it('endpoints: V(0)=0 and V(2R)=full sphere', () => {
    expect(sphericalCapVolume(0, R)).toBe(0);
    expect(sphericalCapVolume(2 * R, R)).toBeCloseTo(full, 12);
  });
  it('symmetry: V(h) + V(2R-h) = V_sphere', () => {
    for (const h of [0.1, 0.5, 0.9, 1.0, 1.4, 1.9]) {
      expect(sphericalCapVolume(h, R) + sphericalCapVolume(2 * R - h, R)).toBeCloseTo(full, 12);
    }
  });
  it('monotonic in h across [0, 2R]', () => {
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const v = sphericalCapVolume((2 * R * i) / 100, R);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
  it('inverse round-trips within 1e-9·R', () => {
    for (const h of [0.05, 0.3, 0.7, 1.0, 1.3, 1.7, 1.95]) {
      const back = capHeightForVolume(sphericalCapVolume(h, R), R);
      expect(Math.abs(back - h)).toBeLessThan(1e-9 * R);
    }
    // and at a non-unit radius
    const R2 = 2.5;
    const h2 = 1.8;
    const back2 = capHeightForVolume(sphericalCapVolume(h2, R2), R2);
    expect(Math.abs(back2 - h2)).toBeLessThan(1e-9 * R2);
  });
  it('clamps below empty and above full', () => {
    expect(sphericalCapVolume(-1, R)).toBe(0);
    expect(sphericalCapVolume(3 * R, R)).toBeCloseTo(full, 12);
    expect(capHeightForVolume(-5, R)).toBe(0);
    expect(capHeightForVolume(full + 5, R)).toBe(2 * R);
    expect(capHeightForVolume(0, R)).toBe(0);
  });
});

describe('slider curve', () => {
  const N = 1321.3;
  it('endpoints: s=0 → 0, s=1 → N', () => {
    expect(sliderTargetCount(N, 0)).toBe(0);
    expect(sliderTargetCount(N, 1)).toBeCloseTo(N, 9);
  });
  it('monotone non-decreasing in s', () => {
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const t = sliderTargetCount(N, i / 100);
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
  });
  it('gamma curve shape: s=0.5 → N·0.5^2.2', () => {
    expect(sliderTargetCount(N, 0.5)).toBeCloseTo(N * Math.pow(0.5, COMPARE_TUNABLES.sliderGamma), 9);
  });
  it('clamps s outside [0,1]', () => {
    expect(sliderTargetCount(N, -0.5)).toBe(0);
    expect(sliderTargetCount(N, 1.5)).toBeCloseTo(N, 9);
  });
});

describe('sliderForTarget — exact inverse of sliderTargetCount', () => {
  it('round-trips volume-fraction presets (10% / half / fill) on a marble N', () => {
    const N = 1321.3;
    for (const frac of [0.1, 0.5, 1]) {
      const target = N * frac;
      const s = sliderForTarget(N, target);
      expect(sliderTargetCount(N, s)).toBeCloseTo(target, 6);
    }
  });
  it("lands the boulders' count-1 preset on exactly one", () => {
    for (const N of [1.7304, 3.126, 25]) {
      const s = sliderForTarget(N, 1);
      expect(sliderTargetCount(N, s)).toBeCloseTo(1, 9);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });
  it('clamps: target ≥ N → 1, target ≤ 0 → 0, N ≤ 0 → 0', () => {
    expect(sliderForTarget(50, 80)).toBe(1);
    expect(sliderForTarget(50, -3)).toBe(0);
    expect(sliderForTarget(0, 5)).toBe(0);
  });
});

describe('sliderFillsExactly — full ⇔ target === N (never a near-max threshold)', () => {
  it('the exact-1 "fill it" preset is full on a sand and a boulder N', () => {
    for (const N of [1.7304, 1_305_693, 2.81e10]) {
      // The 'fill it' preset sets slider = 1 exactly; dragging to the max reaches it too.
      expect(sliderFillsExactly(N, 1)).toBe(true);
      // And the round-trip preset for target N lands slider = 1, hence full.
      expect(sliderFillsExactly(N, sliderForTarget(N, N))).toBe(true);
    }
  });
  it('a raw near-max slider (0.995–0.999) is PARTIAL on sand and boulders', () => {
    for (const N of [1.7304, 1_305_693, 2.81e10]) {
      for (const s of [0.995, 0.997, 0.999]) {
        expect(sliderFillsExactly(N, s)).toBe(false);
        // It really is below N — the partial branch has room to run.
        expect(sliderTargetCount(N, s)).toBeLessThan(N);
      }
    }
  });
  it('the count-1 and half presets are never mistaken for full', () => {
    const N = 1321.3;
    expect(sliderFillsExactly(N, sliderForTarget(N, 1))).toBe(false);
    expect(sliderFillsExactly(N, Math.pow(0.5, 1 / COMPARE_TUNABLES.sliderGamma))).toBe(false);
  });
});

describe('pour schedule + caps', () => {
  it('carry conserves: one summed second at rate 110 yields 110 (spawns + carry)', () => {
    let carry = 0;
    let total = 0;
    for (let i = 0; i < 60; i++) {
      const b = pourBudget(1 / 60, 110, carry);
      total += b.spawns;
      carry = b.carry;
    }
    // Float repeated-addition of 110/60 lands a hair under 110, so the 110th
    // ball sits in carry — nothing is lost: spawns + carry == 110.
    expect(total + carry).toBeCloseTo(110, 9);
    expect(carry).toBeGreaterThanOrEqual(0);
    expect(carry).toBeLessThan(1);
  });
  it('a whole-divisor second lands exactly on the rate', () => {
    let carry = 0;
    let total = 0;
    for (let i = 0; i < 50; i++) {
      const b = pourBudget(0.02, 100, carry); // 50 fps × 2/frame = 100
      total += b.spawns;
      carry = b.carry;
    }
    expect(total).toBe(100);
    expect(carry).toBeCloseTo(0, 9);
  });
  it('never negative; a sub-1 step spawns nothing and banks the fraction', () => {
    expect(pourBudget(0, 0, 0)).toEqual({ spawns: 0, carry: 0 });
    const b = pourBudget(0.1, 3, 0); // 0.3 balls
    expect(b.spawns).toBe(0);
    expect(b.carry).toBeCloseTo(0.3, 9);
  });

  const CAPS = { total: COMPARE_TUNABLES.marbleTotalCap, awake: COMPARE_TUNABLES.awakeCap };
  it('allowance respects target, total cap, and awake cap', () => {
    expect(spawnAllowance(50, 50, 10, CAPS)).toBe(0); // target reached
    expect(spawnAllowance(4000, 4000, 10, CAPS)).toBe(0); // total cap
    expect(spawnAllowance(4000, 3995, 10, CAPS)).toBe(5); // total cap leaves 5
    expect(spawnAllowance(4000, 100, 2000, CAPS)).toBe(0); // awake cap
  });
  it('mobile pre-scaled caps bite', () => {
    const mobile = {
      total: COMPARE_TUNABLES.marbleTotalCap * COMPARE_TUNABLES.mobileCapScale,
      awake: COMPARE_TUNABLES.awakeCap * COMPARE_TUNABLES.mobileCapScale,
    };
    expect(spawnAllowance(9999, 0, 0, mobile)).toBe(1000); // awake 1000 is the min
  });
  it('floors a fractional target and never returns negative', () => {
    expect(spawnAllowance(5.7, 0, 0, CAPS)).toBe(5);
    expect(spawnAllowance(10, 50, 3000, { total: 20, awake: 100 })).toBe(0);
  });
  it('rain mode: the total cap reads LIVE, not the odometer', () => {
    // Odometer past the total cap but the live pile is small (rain melts them):
    // the default `live = poured` refuses (4200 ≥ 4000), yet with the real small
    // live count the pour keeps going, bounded by the target headroom.
    expect(spawnAllowance(6000, 4200, 100, CAPS)).toBe(0);
    // live 300 → target 6000-4200 = 1800, total 4000-300 = 3700, awake 2000-100 = 1900 → 1800.
    expect(spawnAllowance(6000, 4200, 100, CAPS, 300)).toBe(1800);
    // live at the cap refuses even though the odometer has target headroom.
    expect(spawnAllowance(6000, 4200, 100, CAPS, 4000)).toBe(0);
  });
});

describe('drain clamp', () => {
  it('clamps at the melted floor — you cannot un-melt', () => {
    expect(drainTarget(10, 25)).toBe(25);
    expect(drainTarget(40, 25)).toBe(40);
    expect(drainTarget(0, 0)).toBe(0);
  });
});

describe('phase machine', () => {
  const ALL_PHASES: ComparePhase[] = [
    'idle',
    'loading',
    'pouring',
    'settling',
    'brim',
    'melting',
    'raining',
    'spilling',
    'complete',
  ];

  it('traverses the full marble arc through the overflow spill', () => {
    expect(nextPhase('idle', 'commit')).toBe('loading');
    expect(nextPhase('loading', 'ready')).toBe('settling');
    expect(nextPhase('settling', 'pour')).toBe('pouring');
    expect(nextPhase('pouring', 'brim-hit')).toBe('brim');
    expect(nextPhase('brim', 'melt-start')).toBe('melting');
    expect(nextPhase('melting', 'melt-open')).toBe('raining');
    expect(nextPhase('raining', 'top-out')).toBe('spilling'); // P4: raining spills now
    expect(nextPhase('spilling', 'fill-complete')).toBe('complete');
    expect(nextPhase('complete', 'reset')).toBe('loading');
  });
  it('pouring ⇄ settling loop (partial targets, marbles + sand)', () => {
    expect(nextPhase('pouring', 'target-met')).toBe('settling');
    expect(nextPhase('settling', 'pour')).toBe('pouring');
  });
  it('sand full fill: pouring → top-out → spilling → complete', () => {
    expect(nextPhase('pouring', 'top-out')).toBe('spilling');
    expect(nextPhase('spilling', 'fill-complete')).toBe('complete');
  });
  it('boulders keep the direct pouring → fill-complete → complete edge (no spill)', () => {
    // Boulders have no mouth and never spill: the last body completes straight
    // from pouring. The edge exists ONLY from pouring + spilling — every other
    // phase rejects fill-complete.
    expect(nextPhase('pouring', 'fill-complete')).toBe('complete');
    expect(nextPhase('settling', 'fill-complete')).toBeNull();
    expect(nextPhase('brim', 'fill-complete')).toBeNull();
    expect(nextPhase('melting', 'fill-complete')).toBeNull();
    expect(nextPhase('raining', 'fill-complete')).toBeNull(); // P4: raining exits via top-out
    expect(nextPhase('spilling', 'fill-complete')).toBe('complete');
  });
  it('top-out is legal only from pouring (sand) and raining (marbles)', () => {
    expect(nextPhase('pouring', 'top-out')).toBe('spilling');
    expect(nextPhase('raining', 'top-out')).toBe('spilling');
    expect(nextPhase('settling', 'top-out')).toBeNull();
    expect(nextPhase('brim', 'top-out')).toBeNull();
    expect(nextPhase('spilling', 'top-out')).toBeNull();
  });
  it('commit is legal from EVERY phase and lands in loading', () => {
    for (const phase of ALL_PHASES) expect(nextPhase(phase, 'commit')).toBe('loading');
  });
  it('illegal jumps return null', () => {
    expect(nextPhase('idle', 'melt-start')).toBeNull();
    expect(nextPhase('brim', 'pour')).toBeNull(); // brim → pouring without a melt
    expect(nextPhase('idle', 'pour')).toBeNull();
    expect(nextPhase('loading', 'pour')).toBeNull();
    expect(nextPhase('complete', 'melt-start')).toBeNull();
    expect(nextPhase('settling', 'melt-start')).toBeNull();
  });

  it('commitSession bumps the generation and zeroes the session', () => {
    expect(commitSession(5)).toEqual({
      generation: 6,
      phase: 'loading',
      poured: 0,
      melted: 0,
      slider: 0,
    });
  });
  it('isStale compares generation tokens', () => {
    expect(isStale(3, 3)).toBe(false);
    expect(isStale(3, 4)).toBe(true);
  });
});

describe('Esc cascade', () => {
  it('picker wins over everything', () => {
    expect(escIntent({ pickerOpen: true, endCardShown: true, phase: 'pouring' })).toBe(
      'close-picker',
    );
  });
  it('end card is next, even during an active pour', () => {
    expect(escIntent({ pickerOpen: false, endCardShown: true, phase: 'pouring' })).toBe(
      'dismiss-card',
    );
  });
  it('pause-pour only while pouring / melting / raining', () => {
    const active: ComparePhase[] = ['pouring', 'melting', 'raining'];
    for (const phase of active)
      expect(escIntent({ pickerOpen: false, endCardShown: false, phase })).toBe('pause-pour');
  });
  it('spilling skips straight to the card (Esc mirrors the tap-to-skip)', () => {
    // The fill is logically done during the overflow garnish, so Esc jumps to the
    // card (fires fill-complete) rather than leaving — matching a canvas tap.
    expect(escIntent({ pickerOpen: false, endCardShown: false, phase: 'spilling' })).toBe(
      'skip-spill',
    );
  });
  it('otherwise leave the mode', () => {
    const idlePhases: ComparePhase[] = ['idle', 'loading', 'settling', 'brim', 'complete'];
    for (const phase of idlePhases)
      expect(escIntent({ pickerOpen: false, endCardShown: false, phase })).toBe('leave');
  });
});

describe('mean-radius completeness', () => {
  it('the Sun resolves to a positive radius', () => {
    const r = meanRadiusKm('Sun');
    expect(r).not.toBeNull();
    expect(r as number).toBeGreaterThan(0);
  });
  it('every planet in PLANETARIUM_BODIES resolves', () => {
    for (const body of PLANETARIUM_BODIES) {
      const r = meanRadiusKm(body.name);
      expect(r, body.name).not.toBeNull();
      expect(r as number).toBeGreaterThan(0);
    }
  });
  it('every moon in the catalog resolves', () => {
    for (const entry of MOONS) {
      const r = meanRadiusKm(entry.name);
      expect(r, entry.name).not.toBeNull();
      expect(r as number).toBeGreaterThan(0);
    }
  });
  it('an unknown body resolves to null', () => {
    expect(meanRadiusKm('Nibiru')).toBeNull();
  });
  it('mean-radius table wins over the catalogs (volumetric, not equatorial)', () => {
    // Earth mean 6,371 (not the catalog equatorial 6,378).
    expect(meanRadiusKm('Earth')).toBe(MEAN_RADII_KM.Earth);
    expect(MEAN_RADII_KM.Earth).toBe(6371);
  });
});

describe('Try-next list', () => {
  it('every entry resolves and has a positive N', () => {
    for (const pair of TRY_NEXT) {
      expect(meanRadiusKm(pair.container), pair.container).not.toBeNull();
      expect(meanRadiusKm(pair.filler), pair.filler).not.toBeNull();
      expect(buildComparison(pair.container, pair.filler).n).toBeGreaterThan(0);
    }
  });
  it('the Earth←Jupiter entry is the sub-unity tangent teaser', () => {
    const teaser = TRY_NEXT.find((p) => p.container === 'Earth' && p.filler === 'Jupiter');
    expect(teaser).toBeDefined();
    expect(buildComparison('Earth', 'Jupiter').subUnity).toBe(true);
  });
  it('holds exactly the six curated pairs in order', () => {
    expect(TRY_NEXT.map((p) => `${p.container}<-${p.filler}`)).toEqual([
      'Earth<-Moon',
      'Sun<-Jupiter',
      'Moon<-Pluto',
      'Sun<-Earth',
      'Jupiter<-Saturn',
      'Earth<-Jupiter',
    ]);
  });
});

describe('brim stats + density kicker', () => {
  it('brimStats dual number (Earth holds 49.3 Moons, 28 fit = 57%)', () => {
    expect(brimStats(49.31, 28)).toEqual({ ratioText: '49.3', packedCount: 28, packedPct: 57 });
  });
  it('massRatioText: Jupiter over Earth reads 318', () => {
    expect(massRatioText('Jupiter', 'Earth')).toBe('318');
  });
  it('massRatioText is null when either body lacks a mass', () => {
    expect(massRatioText('Jupiter', 'Titan')).toBeNull();
    expect(massRatioText('Titan', 'Earth')).toBeNull();
    expect(MASSES_KG.Titan).toBeUndefined();
  });
});

describe('prose helpers', () => {
  it('bodyDisplayName gives the two common nouns their article, others bare', () => {
    expect(bodyDisplayName('Moon')).toBe('the Moon');
    expect(bodyDisplayName('Sun')).toBe('the Sun');
    expect(bodyDisplayName('Jupiter')).toBe('Jupiter');
    expect(bodyDisplayName('Io')).toBe('Io');
  });
  it('pluralizeBody: +es after a sibilant, +s otherwise', () => {
    expect(pluralizeBody('Earth')).toBe('Earths');
    expect(pluralizeBody('Moon')).toBe('Moons');
    expect(pluralizeBody('Phobos')).toBe('Phoboses');
    expect(pluralizeBody('Titan')).toBe('Titans');
  });
  it('capitalizeSentence: sentence-initial display names read "The", proper names unchanged', () => {
    // Every rendered sentence that BEGINS with bodyDisplayName routes through this
    // (the kicker, the boulder melt note, the settling label); mid-sentence
    // "the Sun"/"the Moon" everywhere else stays lowercase.
    expect(capitalizeSentence(`${bodyDisplayName('Sun')} can't fit through any opening`)).toBe(
      "The Sun can't fit through any opening",
    );
    expect(capitalizeSentence(`${bodyDisplayName('Moon')} — 11 across`)).toBe('The Moon — 11 across');
    expect(capitalizeSentence('Earth holds the volume')).toBe('Earth holds the volume');
    expect(capitalizeSentence('')).toBe('');
  });
});

describe('endCardModel — golden strings (Jupiter/Earth)', () => {
  const cmp = buildComparison('Jupiter', 'Earth'); // n ≈ 1321
  it('marble finish: headline, dual stat, density kicker, six Try-next rows', () => {
    const brim = brimStats(cmp.n, 727);
    const model = endCardModel('Jupiter', 'Earth', cmp, brim);
    expect(model.headline).toBe('1,321 Earths fit inside Jupiter');
    expect(model.dualStat).toBe('As solid spheres: 727 fit (55%) — melted, all 1,321 do.');
    expect(model.kicker).toBe(
      'Jupiter holds the volume of 1,321 Earths — but only the mass of 318.',
    );
    expect(model.tryNext).toHaveLength(6);
    const earthMoon = model.tryNext[0];
    expect(earthMoon).toEqual({ container: 'Earth', filler: 'Moon', text: '49.3 Moons in Earth' });
  });
  it('dual stat renders the packed count as a whole ball (Earth/Moon, 28 fit)', () => {
    const cmp = buildComparison('Earth', 'Moon'); // ≈49.3
    const model = endCardModel('Earth', 'Moon', cmp, brimStats(cmp.n, 28));
    // 28, not "28.0" — the packed count is a whole-ball count.
    expect(model.dualStat).toBe('As solid spheres: 28 fit (57%) — melted, all 49.3 do.');
  });
  it('Try-next excludes the pair just poured (exact match), keeps the swap', () => {
    // Earth/Moon is in TRY_NEXT → excluded after an Earth/Moon run (5 rows left).
    const model = endCardModel('Earth', 'Moon', buildComparison('Earth', 'Moon'), null);
    expect(model.tryNext).toHaveLength(5);
    expect(model.tryNext.some((r) => r.container === 'Earth' && r.filler === 'Moon')).toBe(false);
    // Jupiter/Earth is NOT in TRY_NEXT → all six offered after a Jupiter/Earth run.
    const hero = endCardModel('Jupiter', 'Earth', buildComparison('Jupiter', 'Earth'), null);
    expect(hero.tryNext).toHaveLength(6);
  });
  it('sub-unity Try-next rows read "N of a Filler in Container" (n<1 branch)', () => {
    // Any end card offers the Earth←Jupiter sub-unity teaser (n ≈ 0.00076).
    const model = endCardModel('Jupiter', 'Earth', buildComparison('Jupiter', 'Earth'), null);
    const subRow = model.tryNext.find((r) => r.container === 'Earth' && r.filler === 'Jupiter');
    expect(subRow?.text).toBe('0.00076 of a Jupiter in Earth'); // singular "of a", never "0.00076 Jupiters"
    // A super-unity row keeps the mechanical plural count.
    const em = model.tryNext.find((r) => r.container === 'Earth' && r.filler === 'Moon');
    expect(em?.text).toBe('49.3 Moons in Earth');
  });
  it('the Sun takes its article across headline, kicker, and rows', () => {
    const model = endCardModel('Sun', 'Earth', buildComparison('Sun', 'Earth'), brimStats(1.306e6, 100));
    expect(model.headline).toBe('≈1.31 million Earths fit inside the Sun');
    // Sentence-initial in the kicker capitalizes ("The Sun holds…"); the headline
    // above keeps lowercase "the Sun" mid-sentence.
    expect(model.kicker).toContain('The Sun holds the volume');
    // Sun-container rows in the Try-next list keep lowercase "in the Sun".
    const sunRow = model.tryNext.find((r) => r.container === 'Sun');
    expect(sunRow?.text).toContain('in the Sun');
  });
  it('kicker capitalizes the sentence-initial display name (the Moon/Sun → The)', () => {
    const moon = endCardModel('Moon', 'Pluto', buildComparison('Moon', 'Pluto'), null);
    expect(moon.kicker?.startsWith('The Moon holds the volume')).toBe(true);
    // A proper name is unaffected — it was already capitalized.
    const jup = endCardModel('Jupiter', 'Earth', buildComparison('Jupiter', 'Earth'), null);
    expect(jup.kicker?.startsWith('Jupiter holds the volume')).toBe(true);
  });
  it('boulders skip the dual stat (brim = null)', () => {
    const boulders = buildComparison('Jupiter', 'Saturn'); // 1.73, boulders
    const model = endCardModel('Jupiter', 'Saturn', boulders, null);
    expect(model.dualStat).toBeNull();
    expect(model.headline).toBe('1.73 Saturns fit inside Jupiter');
  });
  it('kicker is null when a mass is unknown; the article shows on the Moon', () => {
    const cmpMoon = buildComparison('Moon', 'Pluto'); // 3.13; Pluto has a mass, Moon does too
    const model = endCardModel('Moon', 'Pluto', cmpMoon, null);
    expect(model.headline).toBe('3.13 Plutos fit inside the Moon');
    // both masses known → kicker present; sentence-initial article capitalizes
    expect(model.kicker).toContain('The Moon holds the volume');
    const titanContainer = endCardModel('Titan', 'Earth', buildComparison('Titan', 'Earth'), null);
    expect(titanContainer.kicker).toBeNull(); // Titan has no listed mass
  });
});
