/**
 * Pure logic for the "How many fit?" volume-compare mode: the volume-ratio
 * math and honesty rules, the three fill regimes, display formatting, the
 * slider / pour / drain schedule, spherical-cap liquid math, the phase machine
 * with its Esc cascade, and the curated "Try next" list. DOM-free and
 * three-free so every rule is unit-testable; the scene and panel own all
 * rendering and DOM.
 *
 * The headline number is an honest VOLUME ratio from volumetric mean radii,
 * not the catalog's equatorial radiusKm — equatorial Jupiter would overcount
 * (1,408 Earths), while the mean-radius answer is 1,321. Studio scale for the
 * cap math is the container's inner radius = 1 unit.
 */

import { KM_CONSTANTS } from '../shared/constants/physicalData';
import { PLANETARIUM_BODIES } from '../planetarium/planets/planetData';
import { MOONS } from '../planetarium/planets/moonData';

// ---------------------------------------------------------------------------
// Reference tables
// ---------------------------------------------------------------------------

/**
 * Volumetric mean radii, km, for the Sun + nine planets + the Moon. Sun,
 * Earth and Moon read from KM_CONSTANTS so there is one source of truth. These
 * are deliberately the volumetric means, not the catalog's equatorial
 * radiusKm: equatorial Jupiter gives 1,408 Earths, while the honest volumetric
 * answer is 1,321. Moons past the Moon fall back to their catalog radii
 * (potato-shaped irregulars are honest only to the limit of one number).
 */
export const MEAN_RADII_KM: Readonly<Record<string, number>> = {
  Sun: KM_CONSTANTS.SUN_RADIUS, // 696_340
  Mercury: 2439.7,
  Venus: 6051.8,
  Earth: KM_CONSTANTS.EARTH_RADIUS, // 6_371
  Mars: 3389.5,
  Jupiter: 69_911,
  Saturn: 58_232,
  Uranus: 25_362,
  Neptune: 24_622,
  Pluto: 1188.3,
  Moon: KM_CONSTANTS.MOON_RADIUS, // 1_737.4
};

/**
 * Masses, kg, for the same eleven bodies. Used only by the end-card density
 * kicker ("…the volume of 1,321 Earths and the mass of 318"); absent for any
 * body without a listed mass, which is why massRatioText can return null.
 */
export const MASSES_KG: Readonly<Record<string, number>> = {
  Sun: 1.9885e30,
  Mercury: 3.3011e23,
  Venus: 4.8675e24,
  Earth: 5.9722e24,
  Mars: 6.4171e23,
  Jupiter: 1.8982e27,
  Saturn: 5.6834e26,
  Uranus: 8.681e25,
  Neptune: 1.02409e26,
  Pluto: 1.303e22,
  Moon: 7.342e22,
};

const PLANET_RADII_KM = new Map<string, number>(
  PLANETARIUM_BODIES.map((body) => [body.name, body.radiusKm]),
);
const MOON_RADII_KM = new Map<string, number>(MOONS.map((entry) => [entry.name, entry.radiusKm]));

function ownNumber(record: Readonly<Record<string, number>>, name: string): number | undefined {
  return Object.prototype.hasOwnProperty.call(record, name) ? record[name] : undefined;
}

/**
 * Volumetric mean radius for any body the tool can pour or fill, km, or null
 * if the name resolves nowhere. Resolution order: the mean-radius table, then
 * the planet catalog's radiusKm, then the moon catalog's radiusKm. The table
 * wins so the eleven headline bodies use their volumetric means while every
 * other moon still resolves through its catalog entry.
 */
export function meanRadiusKm(name: string): number | null {
  const mean = ownNumber(MEAN_RADII_KM, name);
  if (mean !== undefined) return mean;
  const planet = PLANET_RADII_KM.get(name);
  if (planet !== undefined) return planet;
  const moon = MOON_RADII_KM.get(name);
  if (moon !== undefined) return moon;
  return null;
}

// ---------------------------------------------------------------------------
// Core ratio + regime
// ---------------------------------------------------------------------------

/**
 * How many filler spheres equal the container's volume: (R_container /
 * R_filler)^3 from the mean radii. NaN if either body is unresolved (callers
 * pour catalog bodies, which always resolve, so this is a defensive sentinel).
 */
export function volumeRatio(container: string, filler: string): number {
  const rc = meanRadiusKm(container);
  const rf = meanRadiusKm(filler);
  if (rc === null || rf === null) return NaN;
  const ratio = rc / rf;
  return ratio * ratio * ratio;
}

export type FillRegime =
  /** Under ~3.1 balls across: bodies descend one at a time and melt downward — they never enter as solids (no hole could pass them, and two can't rigidly coexist). */
  | 'boulders'
  /** ~3.1 to 16 balls across: full rigid physics — pour through the mouth, tumble, settle, sleep, then melt at the brim. The hero regime. */
  | 'marbles'
  /** Over 16 balls across: no per-grain physics — a lit particle stream pours while the level rises to the true volume. */
  | 'sand';

/**
 * Product-level tunables for the mode (the physics feel constants live with
 * the solver). Regime boundaries are expressed as balls-across = N^(1/3), the
 * scale-free measure of how chunky the fill reads. Do not add keys here
 * casually — every one is referenced by name.
 */
export const COMPARE_TUNABLES = {
  /** Below this many balls across, the fill is boulders (chunky, melt-only). */
  boulderMaxAcross: 3.1,
  /** Above this many balls across, the fill is sand (particle stream). */
  sandMinAcross: 16,
  /** Hard cap on total rigid balls ever poured in a marble session. */
  marbleTotalCap: 4000,
  /** Cap on simultaneously-awake rigid balls (the physics work window). */
  awakeCap: 2000,
  /** Mobile callers multiply the two caps above by this before spawning. */
  mobileCapScale: 0.5,
  /** Perceptual slider exponent: target = N · s^gamma. */
  sliderGamma: 2.2,
  /** Ceiling on spawn rate, balls per second, at the widest mouth throughput. */
  pourMaxPerSec: 110,
  /** Seconds the brim beat waits before melt auto-runs (when auto-melt is on). */
  autoMeltDelayS: 4,
  /** Seconds after the overflow spill starts before the end card appears. */
  endCardDelayS: 2,
} as const;

/** Balls across the container's diameter — the scale-free chunkiness measure, N^(1/3). */
export function ballsAcross(n: number): number {
  return Math.cbrt(n);
}

/**
 * Which fill regime an N picks. Boundaries are read in balls-across from
 * COMPARE_TUNABLES; exactly on a boundary counts as the middle (marbles)
 * regime, since the strict comparisons only push out the extremes.
 */
export function pickRegime(n: number): FillRegime {
  const across = ballsAcross(n);
  if (across < COMPARE_TUNABLES.boulderMaxAcross) return 'boulders';
  if (across > COMPARE_TUNABLES.sandMinAcross) return 'sand';
  return 'marbles';
}

export interface Comparison {
  /** Honest volume ratio, container over filler. */
  n: number;
  /** Balls across the diameter, N^(1/3). */
  across: number;
  /** Auto-picked regime for this N. */
  regime: FillRegime;
  /** N < 1: filler is larger than container, the tangent-pose swap teaser (never poured). */
  subUnity: boolean;
}

/**
 * The full comparison for a container/filler pair: the ratio, its balls-across,
 * the regime, and the sub-unity flag. A sub-unity pair (filler larger than the
 * container) is the swap teaser — it renders as one filler poking out of the
 * glass and is never routed through the solver, since the container constraint
 * is unsatisfiable.
 */
export function buildComparison(container: string, filler: string): Comparison {
  const n = volumeRatio(container, filler);
  return { n, across: ballsAcross(n), regime: pickRegime(n), subUnity: n < 1 };
}

// ---------------------------------------------------------------------------
// Display formatting
// ---------------------------------------------------------------------------

/** Two significant figures as a plain decimal (never exponential) for 0 < n < 1. */
function twoSigFiguresBelowOne(n: number): string {
  if (n <= 0) return '0';
  const decimals = Math.max(0, 1 - Math.floor(Math.log10(n)));
  return n.toFixed(decimals);
}

/**
 * The counter's display string, banded by the raw value. Precision drops as
 * the number grows, and the two big bands read "≈" because they are rounded:
 *   0<n<1        two significant figures   0.000757 → "0.00076", 0.578 → "0.58"
 *   1..10        two decimals              "1.73", same-body "1.00"
 *   10..100      one decimal               "49.3"
 *   100..100k    integer, grouped          "1,321"
 *   100k..1M     nearest thousand, grouped 203,663 → "≈204,000"
 *   >= 1M        two-decimal millions      1,305,678 → "≈1.31 million"
 * Digit grouping matches the repo's toLocaleString('en-US') idiom.
 */
export function formatCount(n: number): string {
  if (n < 1) return twoSigFiguresBelowOne(n);
  if (n < 10) return n.toFixed(2);
  if (n < 100) return n.toFixed(1);
  if (n < 100_000) return Math.round(n).toLocaleString('en-US');
  if (n < 1_000_000) return `≈${(Math.round(n / 1000) * 1000).toLocaleString('en-US')}`;
  return `≈${(n / 1_000_000).toFixed(2)} million`;
}

// ---------------------------------------------------------------------------
// Slider, pour schedule, drain
// ---------------------------------------------------------------------------

/**
 * The slider is a volume goal on a perceptual curve: target = N · s^gamma,
 * clamped to [0, N]. Monotone in s, with s=0 → 0 and s=1 → N. The exponent
 * spends most of the travel in the low counts where a single ball reads.
 */
export function sliderTargetCount(n: number, s: number): number {
  const clampedS = Math.min(1, Math.max(0, s));
  const target = n * Math.pow(clampedS, COMPARE_TUNABLES.sliderGamma);
  return Math.min(n, Math.max(0, target));
}

export interface PourBudget {
  /** Whole balls to spawn this step. */
  spawns: number;
  /** Fractional remainder to carry into the next step. */
  carry: number;
}

/**
 * How many balls a constant pour rate earns over dt, carrying the fractional
 * remainder as explicit state so the summed count is exact over many frames
 * (60 frames at 110/s sum to exactly 110). Never negative for non-negative
 * inputs.
 */
export function pourBudget(dt: number, ratePerSec: number, carry: number): PourBudget {
  const total = carry + dt * ratePerSec;
  const spawns = Math.max(0, Math.floor(total));
  return { spawns, carry: total - spawns };
}

export interface SpawnCaps {
  /** Cap on total balls ever poured this session (marbleTotalCap, mobile-scaled by the caller). */
  total: number;
  /** Cap on simultaneously-awake balls (awakeCap, mobile-scaled by the caller). */
  awake: number;
}

/**
 * How many more balls may spawn this step, respecting the slider target, the
 * total-poured cap, and the awake-window cap — never negative, always a whole
 * count. Mobile callers pre-scale the caps by mobileCapScale before passing
 * them in.
 */
export function spawnAllowance(
  target: number,
  poured: number,
  awake: number,
  caps: SpawnCaps,
): number {
  const byTarget = target - poured;
  const byTotal = caps.total - poured;
  const byAwake = caps.awake - awake;
  return Math.max(0, Math.floor(Math.min(byTarget, byTotal, byAwake)));
}

/**
 * The effective drain floor: you cannot un-melt, so a drain clamps at the
 * melted count. Below the melted floor the slider simply can't remove more
 * solids.
 */
export function drainTarget(sliderCount: number, meltedCount: number): number {
  return Math.max(sliderCount, meltedCount);
}

// ---------------------------------------------------------------------------
// Spherical-cap liquid math (container inner radius R, height h from the bottom pole)
// ---------------------------------------------------------------------------

/**
 * Volume of a spherical cap of height h in a sphere of radius R:
 * π·h²·(3R − h)/3, with h clamped to [0, 2R]. At h=0 it is 0 and at h=2R it is
 * the full sphere, so the two caps of a bisecting plane sum to the whole sphere.
 */
export function sphericalCapVolume(h: number, R: number): number {
  const hc = Math.min(2 * R, Math.max(0, h));
  return (Math.PI * hc * hc * (3 * R - hc)) / 3;
}

/**
 * The cap height that holds volume v in a sphere of radius R — the monotone
 * inverse of sphericalCapVolume, clamped so v ≤ 0 gives 0 and v ≥ the full
 * sphere gives 2R. Bisection, not Newton: the cap-volume derivative vanishes
 * at h = 2R, so Newton overshoots there while bisection stays monotone-safe.
 */
export function capHeightForVolume(v: number, R: number): number {
  const full = (4 / 3) * Math.PI * R * R * R;
  if (v <= 0) return 0;
  if (v >= full) return 2 * R;
  let lo = 0;
  let hi = 2 * R;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (sphericalCapVolume(mid, R) < v) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ---------------------------------------------------------------------------
// Phase machine + Esc cascade
// ---------------------------------------------------------------------------

export type ComparePhase =
  | 'idle'
  | 'loading'
  | 'pouring'
  | 'settling'
  | 'brim'
  | 'melting'
  | 'raining'
  | 'complete';

export type CompareEvent =
  | 'commit'
  | 'ready'
  | 'pour'
  | 'target-met'
  | 'brim-hit'
  | 'melt-start'
  | 'melt-open'
  | 'fill-complete'
  | 'reset';

/**
 * The arc: idle →commit→ loading →ready→ settling ⇄(pour / target-met)⇄
 * pouring →brim-hit→ brim →melt-start→ melting →melt-open→ raining
 * →fill-complete→ complete →reset→ loading. `commit` is legal from EVERY phase
 * (a pair change or ⇄ swap resets the session, and is the generation bump);
 * every other jump not drawn here is illegal. `pickerOpen` is an overlay flag,
 * not a phase — the pour keeps running under the picker.
 */
const PHASE_TABLE: Readonly<Record<ComparePhase, Partial<Record<CompareEvent, ComparePhase>>>> = {
  idle: { commit: 'loading' },
  loading: { commit: 'loading', ready: 'settling' },
  settling: { commit: 'loading', pour: 'pouring' },
  pouring: { commit: 'loading', 'target-met': 'settling', 'brim-hit': 'brim' },
  brim: { commit: 'loading', 'melt-start': 'melting' },
  melting: { commit: 'loading', 'melt-open': 'raining' },
  raining: { commit: 'loading', 'fill-complete': 'complete' },
  complete: { commit: 'loading', reset: 'loading' },
};

/** The phase an event moves to, or null when the jump is illegal (caller ignores it). */
export function nextPhase(phase: ComparePhase, event: CompareEvent): ComparePhase | null {
  return PHASE_TABLE[phase][event] ?? null;
}

export interface CompareSession {
  /** Monotonic token; every async resolve checks it and bails if stale. */
  generation: number;
  phase: ComparePhase;
  /** Balls poured so far this session. */
  poured: number;
  /** Balls melted so far this session (the drain floor). */
  melted: number;
  /** Last committed slider fraction. */
  slider: number;
}

/**
 * A fresh session after a pair change or ⇄ swap: the generation bumps and every
 * count zeroes. One object, one definition of "reset".
 */
export function commitSession(generation: number): CompareSession {
  return { generation: generation + 1, phase: 'loading', poured: 0, melted: 0, slider: 0 };
}

/** Whether a captured generation token is out of date against the live one. */
export function isStale(gen: number, current: number): boolean {
  return gen !== current;
}

export interface EscContext {
  /** The body picker overlay is open. */
  pickerOpen: boolean;
  /** The end card is showing. */
  endCardShown: boolean;
  /** Current phase (decides whether Esc pauses an active pour). */
  phase: ComparePhase;
}

export type EscIntent = 'close-picker' | 'dismiss-card' | 'pause-pour' | 'leave';

/**
 * What Esc does, in strict priority: close the picker, else dismiss the end
 * card, else pause an active pour (only while pouring / melting / raining),
 * else leave the mode.
 */
export function escIntent({ pickerOpen, endCardShown, phase }: EscContext): EscIntent {
  if (pickerOpen) return 'close-picker';
  if (endCardShown) return 'dismiss-card';
  if (phase === 'pouring' || phase === 'melting' || phase === 'raining') return 'pause-pour';
  return 'leave';
}

// ---------------------------------------------------------------------------
// Brim / end-card stats + Try next
// ---------------------------------------------------------------------------

export interface BrimStats {
  /** The true volume ratio, formatted. */
  ratioText: string;
  /** How many solid spheres actually fit (the live poured count). */
  packedCount: number;
  /** Solid-fit as a percentage of the true volume, rounded. */
  packedPct: number;
}

/**
 * The dual stat shown at the brim and on the end card — the true volume ratio
 * beside the count that actually fit as solid spheres and its percentage of
 * the volume (the spheres-leave-gaps teaching moment). Copy strings are built
 * elsewhere; this is just the numbers.
 */
export function brimStats(n: number, poured: number): BrimStats {
  return {
    ratioText: formatCount(n),
    packedCount: poured,
    packedPct: Math.round((100 * poured) / n),
  };
}

/**
 * The density kicker's mass ratio (container mass over filler mass), formatted,
 * or null unless both bodies have a listed mass. Jupiter over Earth reads
 * "318" — the surprise that its 1,321 volumes weigh only 318.
 */
export function massRatioText(container: string, filler: string): string | null {
  const mc = ownNumber(MASSES_KG, container);
  const mf = ownNumber(MASSES_KG, filler);
  if (mc === undefined || mf === undefined) return null;
  return formatCount(mc / mf);
}

export interface TryNextPair {
  container: string;
  filler: string;
}

/**
 * The curated "Try next" row on the end card. The last pair (Earth holding
 * Jupiter) is sub-unity on purpose — the tangent-pose teaser that invites the
 * swap. Counts in the UI are always computed live from these pairs, never baked.
 */
export const TRY_NEXT: ReadonlyArray<TryNextPair> = [
  { container: 'Earth', filler: 'Moon' },
  { container: 'Sun', filler: 'Jupiter' },
  { container: 'Moon', filler: 'Pluto' },
  { container: 'Sun', filler: 'Earth' },
  { container: 'Jupiter', filler: 'Saturn' },
  { container: 'Earth', filler: 'Jupiter' },
];
