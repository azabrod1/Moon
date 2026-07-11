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
import { PLANETARIUM_BODIES, SUN_DATA } from '../planetarium/planets/planetData';
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
  /** Hard cap on LIVE rigid balls in a marble session (rain melts arrivals, so the
   *  live pile is bounded here while the poured odometer runs on toward N). */
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
  /** Seconds a full sand fill takes at the constant fractional rate (a partial
   *  fill to fraction f scales to sandFillS·f, floored at 4 s). */
  sandFillS: 24,
  /** The visual rim-contact epsilon for liquidAtRim, as a fraction of the
   *  container radius (~0.5% of R) — the top-out trigger fires this close. */
  liquidRimEpsFrac: 0.005,
  /** Balls melted per second while the melt beat runs (the slump pace). */
  meltPerSec: 90,
  /** Max liquid-touching balls consumed per frame in rain mode (paces the splash tick). */
  rainConsumePerFrame: 6,
  /** Time constant, seconds, for the rendered liquid level easing toward its computed height. */
  liquidEaseTau: 0.35,
  /** Seconds spawn refusals must persist (while the pile is quiescent) before the brim beat fires. */
  brimQuietS: 1.0,
  /** Seconds a boulder takes to descend from the spawn height to its rest on the glass top. */
  boulderDescentS: 1.0,
  /** Fastest boulder melt window, seconds (used at the crowded end of the boulder band). */
  boulderMeltMinS: 1.4,
  /** Slowest boulder melt window, seconds (used when only one or two boulders drop — savoured). */
  boulderMeltMaxS: 2.8,
  /** Fraction of the current boulder's melt that must complete before the next boulder drops. */
  boulderOverlapAt: 0.6,
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
 *   1M..1B       two-decimal millions      1,305,678 → "≈1.31 million"
 *   1B..1T       two-decimal billions      28,083,000,000 → "≈28.08 billion"
 *   1T..1Q       two-decimal trillions
 *   >= 1Q        two-decimal quadrillions
 * The magnitude is named past a million (never "≈28083.62 million"). Digit
 * grouping matches the repo's toLocaleString('en-US') idiom.
 */
export function formatCount(n: number): string {
  if (n < 1) return twoSigFiguresBelowOne(n);
  if (n < 10) return n.toFixed(2);
  if (n < 100) return n.toFixed(1);
  if (n < 100_000) return Math.round(n).toLocaleString('en-US');
  if (n < 1_000_000) return `≈${(Math.round(n / 1000) * 1000).toLocaleString('en-US')}`;
  if (n < 1e9) return `≈${(n / 1e6).toFixed(2)} million`;
  if (n < 1e12) return `≈${(n / 1e9).toFixed(2)} billion`;
  if (n < 1e15) return `≈${(n / 1e12).toFixed(2)} trillion`;
  return `≈${(n / 1e15).toFixed(2)} quadrillion`;
}

/**
 * The "⟨n⟩ across" scale-preview number: whole from 3 up ("11 across", never
 * "11.0"), one decimal below 3 where the fraction reads ("1.2 across", "2.5
 * across"). formatCount renders 10.97 as "11.0" — the trailing ".0" is wrong
 * voice for this one line, so this is its own small formatter.
 */
export function formatAcross(across: number): string {
  if (across >= 3) return String(Math.round(across));
  return across.toFixed(1);
}

/**
 * A whole-ball counter for the odometer + the packed-count stats: the value
 * rounded to an integer with thousands separators ("8", "131", "1,321"). The
 * ratio formatter (formatCount) is wrong here — its 1–10 band shows two
 * decimals, but a count of eight poured balls is "8", never "8.00".
 */
export function formatOdometer(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/**
 * The odometer's display string for a regime + phase. Marbles count WHOLE balls
 * through the pour (formatOdometer — "49"), but a full fill tops the liquid to the
 * exact ratio at the finish and `poured` carries it, so the two finished phases
 * (spilling / complete) render with the headline's own formatter — the odometer
 * lands on the headline number ("49.3", not the whole-ball "49"). Boulders + sand
 * always run the ratio voice; their poured already decelerates onto the exact ratio.
 */
export function odometerString(regime: FillRegime, phase: ComparePhase, poured: number): string {
  if (regime !== 'marbles') return formatCount(poured);
  const finished = phase === 'spilling' || phase === 'complete';
  return finished ? formatCount(poured) : formatOdometer(poured);
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

/**
 * The exact inverse of sliderTargetCount: the slider fraction that lands on a
 * given target count, clamped to [0, 1]. `s = (target / N)^(1/gamma)`. Presets
 * use this so "fill it" and the boulders' "1" sit on the perceptual curve at
 * exactly N and exactly 1 rather than a nearby approximation. N ≤ 0 → 0.
 */
export function sliderForTarget(n: number, target: number): number {
  if (n <= 0) return 0;
  const frac = Math.min(1, Math.max(0, target / n));
  return Math.pow(frac, 1 / COMPARE_TUNABLES.sliderGamma);
}

/**
 * Whether a slider fraction is an EXACT full fill — the target equals N, not a
 * near-max approximation. sliderTargetCount clamps to N, so this is true only at
 * s = 1 (the "fill it" preset lands there exactly, and dragging to the slider's
 * max reaches it). A raw drag to 0.995–0.999 targets only ~98.9%–99.8% of N via
 * the s^gamma curve, so it is a PARTIAL fill: it must settle quietly with no
 * brim/card, exactly like any other partial. Keyed to the exact target, never a
 * threshold — a threshold classifies near-max sliders as full and either hangs
 * sand in `pouring` (its top-out never fires) or shows a card on a partial fill.
 */
export function sliderFillsExactly(n: number, s: number): boolean {
  return sliderTargetCount(n, s) === n;
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
 * live-pile cap, and the awake-window cap — never negative, always a whole
 * count. Mobile callers pre-scale the caps by mobileCapScale before passing
 * them in. `poured` is the odometer (bounded by the target); `live` is the
 * count of live rigid balls, which the total cap guards — they diverge in rain
 * mode where arrivals melt away so the odometer runs past the live pile. `live`
 * defaults to `poured`, preserving the pre-rain single-count behavior.
 */
export function spawnAllowance(
  target: number,
  poured: number,
  awake: number,
  caps: SpawnCaps,
  live: number = poured,
): number {
  const byTarget = target - poured;
  const byTotal = caps.total - live;
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

/** The boulders' fractional target lands within float error of the melted
 *  volume; a real slider nudge always exceeds this, so it can't strand a pour. */
const BOULDER_TARGET_EPS = 1e-3;

/**
 * Whether the poured amount has reached the slider target for this regime — the
 * settling phase pours again while this is false, and the ghost target ring
 * retires once it is true. Marbles pour WHOLE balls, so the goal is the integer
 * floor(target): a fractional target (287.6) is satisfied at 287, and comparing
 * against the floor (never target − 0.5) is what stops the settling⇄pouring
 * ping-pong. Boulders melt a FRACTIONAL volume, so the goal is the fractional
 * target within an epsilon — "half" of a 1.73-boulder pair (0.865) must pour and
 * hold mid-slump, and a mid-band increase (0.3 → 0.7) must pour the delta.
 */
export function targetReached(target: number, poured: number, regime: FillRegime): boolean {
  if (regime === 'boulders') return poured >= target - BOULDER_TARGET_EPS;
  return poured >= Math.floor(target);
}

/**
 * The sand fill's ramp progress in [0, 1] over an elapsed/duration window — a
 * smoothstep: monotone, soft start (derivative 0 at the open), and a SOFT
 * LANDING (derivative → 0 as it lands) so the odometer decelerates into its
 * final number rather than snapping. Lands EXACTLY on 1 at elapsed ≥ duration
 * (the clamp), and reads 0 at elapsed ≤ 0. A non-positive duration is already
 * complete. The scene maps this progress across [startFraction, targetFraction]
 * and multiplies by N to drive `melted`.
 */
export function sandFillFraction(elapsed: number, duration: number): number {
  if (duration <= 0) return 1;
  const t = Math.min(1, Math.max(0, elapsed / duration));
  return t * t * (3 - 2 * t);
}

/**
 * The live sand-grain pool budget for a device tier — two tiers, one boolean:
 * the weak tier (no-bloom GPU OR a ≤640px mobile viewport) gets half the grains
 * so the signals never stack down to a quarter. Full tier 3000, weak tier 1500.
 * The spill count is flat across tiers (a fixed garnish), sized by the scene.
 */
export function sandGrainBudget(useBloom: boolean, isMobile: boolean): number {
  const weakTier = !useBloom || isMobile;
  return weakTier ? 1500 : 3000;
}

/**
 * The sand heap's crest-relative height at normalized radius `rr` (0 centre → 1
 * wall) for a given crest height `peakH` (world-space studio units): a full-width
 * cone, `peakH · max(0, 1 − rr)`. Crest at the axis, meeting the glass wall at 0 —
 * no flat annulus, so the flank runs crest→wall monotonically (sand piles against
 * the glass, it doesn't leave a moat). This is the single source of the heap
 * profile: the disc shader mirrors the GLSL, and the CPU reads it for the sand
 * stream's kill plane and the plume contact (bulkSurfaceY + heapHeightAt(rr,
 * peakH)). The `max(0, ·)` guards a grain drifting past the wall (rr > 1). The
 * bulk fill height that carries the settled volume comes from heapSplit; this is
 * only the cone riding on top of it.
 */
export function heapHeightAt(rr: number, peakH: number): number {
  return peakH * Math.max(0, 1 - rr);
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

export interface HeapSplit {
  /** Settled-bulk fill height from the bottom pole (spherical-cap volume). */
  bulkH: number;
  /** Crest height of the cone above the bulk surface, at the axis. */
  peakH: number;
}

/**
 * Split a total poured volume V into the settled bulk and the heaped cone that
 * rides on it — a pure, frame-independent solve, so the rendered surface is a
 * function of V alone (no incremental state, no deflation, no stream coupling).
 * Units are world/studio: glass radius 1, liquid radius `R`, shared origin at the
 * sphere centre; `mouthPlaneY` is the vessel's mouth plane (same centre origin).
 *
 * The surface is a full-width cone `heapHeightAt(rr, peakH)` on a spherical-cap
 * bulk of height h. With `y = h − R` the bulk surface height above centre and
 * `discR = sqrt(R² − y²)` its radius, the crest height is capped two ways:
 *   peakCap(h) = max(0, min(slope · discR, headroomK · (mouthPlaneY − y)))
 * The slope cap holds the flank at the angle of repose (the hourglass read);
 * through the bottom half of the fill it binds, so the flank sits at exact repose.
 * The headroom cap eases the whole surface toward flat as the fill nears the brim,
 * and the `max(0, ·)` is mandatory: the mouth plane sits below R on every real
 * vessel, so the headroom term goes negative over the last stretch of a full fill.
 *
 * Total volume F(h) = capVolume(h) + π/3 · discR² · peakCap(h) is monotone in h,
 * so bisection (the capHeightForVolume idiom) inverts F(h) = V. Exact endpoints:
 * V ≤ 0 ⇒ (0, 0); V ≥ V_full ⇒ (2R, 0), where discR → 0 and headroom → 0 kill the
 * cone term so the full pour lands flat at the brim with no trapped volume. NaN-free
 * at every input (guarded denominators; the cone term vanishes cleanly at discR = 0).
 */
export function heapSplit(
  V: number,
  R: number,
  mouthPlaneY: number,
  slope: number,
  headroomK: number,
): HeapSplit {
  const full = (4 / 3) * Math.PI * R * R * R;
  const clampedV = Math.min(full, Math.max(0, V));
  const peakCapAt = (h: number): number => {
    const y = h - R;
    const discR = Math.sqrt(Math.max(0, R * R - y * y));
    return Math.max(0, Math.min(slope * discR, headroomK * (mouthPlaneY - y)));
  };
  if (clampedV <= 0) return { bulkH: 0, peakH: 0 };
  if (clampedV >= full) return { bulkH: 2 * R, peakH: 0 };
  const F = (h: number): number => {
    const y = h - R;
    const discR2 = Math.max(0, R * R - y * y);
    return sphericalCapVolume(h, R) + (Math.PI / 3) * discR2 * peakCapAt(h);
  };
  let lo = 0;
  let hi = 2 * R;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (F(mid) < clampedV) lo = mid;
    else hi = mid;
  }
  const bulkH = (lo + hi) / 2;
  return { bulkH, peakH: peakCapAt(bulkH) };
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
  | 'spilling'
  | 'complete';

export type CompareEvent =
  | 'commit'
  | 'ready'
  | 'pour'
  | 'target-met'
  | 'brim-hit'
  | 'melt-start'
  | 'melt-open'
  | 'top-out'
  | 'fill-complete'
  | 'reset';

/**
 * The arc: idle →commit→ loading →ready→ settling ⇄(pour / target-met)⇄
 * pouring →brim-hit→ brim →melt-start→ melting →melt-open→ raining →top-out→
 * spilling →fill-complete→ complete →reset→ loading. `commit` is legal from
 * EVERY phase (a pair change or ⇄ swap resets the session, and is the generation
 * bump); every other jump not drawn here is illegal. `pickerOpen` is an overlay
 * flag, not a phase — the pour keeps running under the picker.
 *
 * `top-out` fires on VISUAL rim contact (liquidAtRim on the eased render level),
 * never the logical amount, so the overflow spill can't fire while the surface
 * is still easing toward the rim (liquidEaseTau 0.35 s). `spilling` runs the
 * overflow-grain garnish, then completes.
 *
 * Marbles and sand both overflow: raining/pouring reach the rim → `spilling` →
 * complete. BOULDERS never pack and never spill — the last body settling at
 * target = N completes straight from `pouring` (the `pouring → fill-complete →
 * complete` edge, no mouth, no spill), skipping the marble reconcile and the
 * garnish. Sand's full fill leaves `pouring` via `top-out` (a partial sand
 * target settles back via `target-met`, exactly like marbles).
 */
const PHASE_TABLE: Readonly<Record<ComparePhase, Partial<Record<CompareEvent, ComparePhase>>>> = {
  idle: { commit: 'loading' },
  loading: { commit: 'loading', ready: 'settling' },
  settling: { commit: 'loading', pour: 'pouring' },
  pouring: {
    commit: 'loading',
    'target-met': 'settling',
    'brim-hit': 'brim',
    'top-out': 'spilling',
    'fill-complete': 'complete',
  },
  brim: { commit: 'loading', 'melt-start': 'melting' },
  melting: { commit: 'loading', 'melt-open': 'raining' },
  raining: { commit: 'loading', 'top-out': 'spilling' },
  spilling: { commit: 'loading', 'fill-complete': 'complete' },
  complete: { commit: 'loading', reset: 'loading' },
};

/** The phase an event moves to, or null when the jump is illegal (caller ignores it). */
export function nextPhase(phase: ComparePhase, event: CompareEvent): ComparePhase | null {
  return PHASE_TABLE[phase][event] ?? null;
}

/**
 * Whether the RENDERED liquid surface has reached the vessel rim — the visual
 * `top-out` trigger for the overflow spill. `levelY` is the eased render level
 * (height above the bottom pole), `rimY` the full-fill height (2·R_liq), and the
 * epsilon is a small fraction of the container radius. Keyed to the eased level,
 * never the logical fill: the 0.35 s level ease trails the count, so a spill
 * keyed to the logical top-off would fire before the surface visibly arrives.
 */
export function liquidAtRim(levelY: number, rimY: number, containerR: number): boolean {
  return levelY >= rimY - COMPARE_TUNABLES.liquidRimEpsFrac * containerR;
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

export type EscIntent = 'close-picker' | 'dismiss-card' | 'pause-pour' | 'skip-spill' | 'leave';

/**
 * What Esc does, in strict priority: close the picker, else dismiss the end
 * card, else pause an active pour (only while pouring / melting / raining), else
 * skip the overflow garnish straight to the card (while spilling — the fill is
 * logically done, so Esc mirrors the tap-to-skip rather than leaving), else
 * leave the mode. From the card that skip surfaces, the next Esc dismisses it
 * and the cascade continues as normal.
 */
export function escIntent({ pickerOpen, endCardShown, phase }: EscContext): EscIntent {
  if (pickerOpen) return 'close-picker';
  if (endCardShown) return 'dismiss-card';
  if (phase === 'pouring' || phase === 'melting' || phase === 'raining') return 'pause-pour';
  if (phase === 'spilling') return 'skip-spill';
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

// ---------------------------------------------------------------------------
// Prose helpers + end-card model
// ---------------------------------------------------------------------------

/**
 * Prose name with the article for the two common nouns — "the Moon", "the Sun"
 * ("…fit inside the Sun", "988 Jupiters in the Sun"); every proper-named body
 * stays bare. Restated here rather than imported from surfaceView so this module
 * stays three-free (surfaceView pulls in three.js). Deck rows deliberately show
 * raw catalog names (a different code path) and are unaffected.
 */
export function bodyDisplayName(name: string): string {
  if (name === 'Moon') return 'the Moon';
  if (name === 'Sun') return 'the Sun';
  return name;
}

/** English plural of a body name: +es after a sibilant ending, else +s. */
export function pluralizeBody(name: string): string {
  return /(?:s|x|z|ch|sh)$/i.test(name) ? `${name}es` : `${name}s`;
}

/** A body's catalog tint (the shared idiom: planet/moon catalogs, Sun the one
 *  exception since it is absent from them). Returned as a hex number so this module
 *  stays three-free; the panel renders the swatch. */
export function bodyTint(name: string): number {
  if (name === 'Sun') return SUN_DATA.color;
  return (
    PLANETARIUM_BODIES.find((b) => b.name === name)?.color ??
    MOONS.find((m) => m.name === name)?.color ??
    0x888888
  );
}

/** Capitalize the first character of a sentence (leaves the rest untouched) — the
 *  end-card kicker starts with a display name, so "the Sun/Moon" must read "The". */
export function capitalizeSentence(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/** The paused status line. The "Esc to leave" hint only makes sense on a
 *  keyboard-ish device, so a coarse-pointer (touch) device just reads "paused". */
export function pausedStatus(hasFinePointer: boolean): string {
  return hasFinePointer ? 'paused — Esc to leave' : 'paused';
}

export interface EndCardTryRow {
  container: string;
  filler: string;
  /** "49 Moons in Earth" — live count + the pour phrasing. */
  text: string;
  /** The FILLER's catalog tint (the body the count names) — the row's dot swatch. */
  color: number;
}

export interface EndCardModel {
  /** "1,321 Earths fit inside Jupiter". */
  headline: string;
  /** The spheres-vs-volume dual stat, or null for boulders (they never pack). */
  dualStat: string | null;
  /** The density kicker, or null unless both bodies have a listed mass. */
  kicker: string | null;
  /** The curated Try-next rows with live counts. */
  tryNext: EndCardTryRow[];
}

/**
 * The end-card copy for a finished fill: the headline count, the packed-vs-melted
 * dual stat (from the BrimStats captured when the brim beat fired — null for
 * boulders/sand, which never pack), the density kicker when both masses are
 * known, and the six Try-next rows with counts computed live. Pure string/number
 * work; the panel renders it.
 */
export function endCardModel(
  container: string,
  filler: string,
  comparison: Comparison,
  brim: BrimStats | null,
): EndCardModel {
  const fillers = pluralizeBody(filler);
  // A same-body pair has an EXACT ratio of 1 (r/r cubed), never a coincidental
  // cross-body ≈1, so this reads it as one singular sentence rather than the
  // mechanical "1.00 Earths fit inside Earth".
  const sameBody = Math.abs(comparison.n - 1) < 1e-9;
  const headline = sameBody
    ? capitalizeSentence(`${bodyDisplayName(container)} fits inside ${bodyDisplayName(container)} exactly once`)
    : `${formatCount(comparison.n)} ${fillers} fit inside ${bodyDisplayName(container)}`;

  const dualStat = brim
    ? `As solid spheres: ${formatOdometer(brim.packedCount)} fit (${brim.packedPct}%) — melted, all ${brim.ratioText} do.`
    : null;

  const mass = massRatioText(container, filler);
  // Sentence-initial: the display name "the Sun"/"the Moon" must capitalize at the
  // start of the kicker ("The Sun holds…"), while the headline + try-next rows keep
  // the lowercase article mid-sentence ("…inside the Sun"). Capitalizing the first
  // rendered character is safe for every name ("Earth holds…" is unchanged).
  const kicker = mass
    ? capitalizeSentence(
        sameBody
          ? `${bodyDisplayName(container)} holds one ${filler} — the very same volume and mass.`
          : `${bodyDisplayName(container)} holds the volume of ${formatCount(comparison.n)} ${fillers} — but only the mass of ${mass}.`,
      )
    : null;

  // Never offer the pair the player just poured (exact container+filler match);
  // the swapped direction may still appear (it's a different comparison).
  const tryNext = TRY_NEXT.filter(
    (pair) => !(pair.container === container && pair.filler === filler),
  ).map((pair) => {
    const rn = buildComparison(pair.container, pair.filler).n;
    // Sub-unity rows read "0.00076 of a Jupiter in Earth" (singular, "of a") —
    // "0.00076 Jupiters" would misread as a plural count.
    const text =
      rn < 1
        ? `${formatCount(rn)} of a ${pair.filler} in ${bodyDisplayName(pair.container)}`
        : `${formatCount(rn)} ${pluralizeBody(pair.filler)} in ${bodyDisplayName(pair.container)}`;
    return { container: pair.container, filler: pair.filler, text, color: bodyTint(pair.filler) };
  });

  return { headline, dualStat, kicker, tryNext };
}
