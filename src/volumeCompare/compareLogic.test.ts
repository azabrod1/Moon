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
  sliderTargetCount,
  pourBudget,
  spawnAllowance,
  drainTarget,
  sphericalCapVolume,
  capHeightForVolume,
  nextPhase,
  commitSession,
  isStale,
  escIntent,
  brimStats,
  massRatioText,
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
  it('>=1M: ≈ two-decimal millions', () => {
    expect(formatCount(1_305_678)).toBe('≈1.31 million');
  });

  it('band boundaries land in the correct band', () => {
    expect(formatCount(10)).toBe('10.0'); // 10..100
    expect(formatCount(100)).toBe('100'); // 100..100k
    expect(formatCount(100_000)).toBe('≈100,000'); // 100k..1M
    expect(formatCount(1_000_000)).toBe('≈1.00 million'); // >=1M
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
    expect(pickRegime(4097)).toBe('sand');
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
    'complete',
  ];

  it('traverses the full §1.4 arc', () => {
    expect(nextPhase('idle', 'commit')).toBe('loading');
    expect(nextPhase('loading', 'ready')).toBe('settling');
    expect(nextPhase('settling', 'pour')).toBe('pouring');
    expect(nextPhase('pouring', 'brim-hit')).toBe('brim');
    expect(nextPhase('brim', 'melt-start')).toBe('melting');
    expect(nextPhase('melting', 'melt-open')).toBe('raining');
    expect(nextPhase('raining', 'fill-complete')).toBe('complete');
    expect(nextPhase('complete', 'reset')).toBe('loading');
  });
  it('pouring ⇄ settling loop', () => {
    expect(nextPhase('pouring', 'target-met')).toBe('settling');
    expect(nextPhase('settling', 'pour')).toBe('pouring');
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
