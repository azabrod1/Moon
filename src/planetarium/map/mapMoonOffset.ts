/**
 * Where a moon sits on the chart — the map's one moon-offset policy.
 *
 * ## Units, and why they are these units
 *
 * In:  `x` = the moon's TRUE planetocentric distance in parent TRUE radii.
 * Out: `r` = its charted distance in parent DRAWN radii.
 *
 * The module is therefore camera-independent: same inputs, same curve, forever.
 * The conversion to AU happens at one seam in SystemMap — the scalar
 * `max(parent true radiusAU, the parent's marker-anchored drawn radius)` — so
 * the parent's drawn globe is exactly 1 in these units whatever the camera is
 * doing, and a clearance stated here is a clearance you can see.
 *
 * ## Why a policy at all
 *
 * True offsets cannot be drawn on one chart: Io sits 6 Jupiter radii out,
 * Sinope 335, and Neso ~2000 Neptune radii. A parent floored to a legible
 * marker cannot host those ratios — a chart that drew them true would show one
 * body and a lot of black. True offsets live in the True scale mode, which
 * bypasses this policy entirely; compressed mode is what this is for.
 *
 * ## The contract
 *
 * One strictly increasing function of x per system, in two zones plus a squeeze:
 *
 *  - **Zone 1, the classical regulars** (`x ≤ x₀`): `A·x^γ`, γ ≈ 0.8, A pinned
 *    so Io lands at 1.7 parent radii. The compression is in the exponent, so
 *    ADJACENT steps stay near-real (the Galilean step ratios come out 9–11%
 *    compressed) while long-range ratios compress hard — which is exactly what
 *    buys the irregular tail its room. Steps compound by design: Io→Callisto
 *    reads ~26% compressed, and no claim is made about non-adjacent pairs.
 *  - **Zone 2, the irregular tail** (`x > x₀`): a logarithmic continuation
 *    `r(x₀) + B·ln(x/x₀)`, B derived so the catalog's farthest APOAPSIS lands
 *    exactly on the cap. Monotone by construction, so every instantaneous point
 *    a moon plots respects the cap — Neso honestly sweeps its own orbit up to
 *    it. The kink at x₀ is accepted: the tail's job is honest ordering, not
 *    honest spacing. In all four giant systems the kink falls in a genuinely
 *    empty band (Callisto 26 → Himalia 160; Hyperion 25 → Iapetus 59; Oberon 23
 *    → the Uranian irregulars 167; Triton 14 → Nereid 224).
 *  - **Parent clearance and the packed-family squeeze**: a moon whose curve
 *    value falls inside `clearance` parent radii would be drawn inside the
 *    parent. Those moons form the system's BOUND RUN — a prefix in x, since the
 *    curve is increasing. They are lifted by ONE positive-slope affine map on
 *    curve output, not by per-moon constants: a flat floor would collapse
 *    Metis, Amalthea and Thebe onto a single radius. The map is anchored at
 *    `S(v_lo) = clearance + m` (v_lo = the run's minimum instantaneous value,
 *    i.e. its innermost periapsis, so clearance holds at periapsis and not
 *    merely on average) and at `S(v_hi) = v_hi`, where v_hi is the first
 *    UNBOUND moon's mean value — a fixed point, so every ring at or beyond it
 *    is exact and no cascade is possible. Where the squeeze binds, ratio
 *    fidelity is explicitly not claimed: that is declared legibility-minimum
 *    territory, distinctness there is a zoom-in property, and the honesty lives
 *    in True scale.
 *  - **Co-orbitals share a ring by design.** Telesto and Calypso really do ride
 *    Tethys's orbit; Janus and Epimetheus really do swap theirs. Any strictly
 *    increasing map sends equal x to equal r, and nothing here snaps: every
 *    marker rides the one function at its own instantaneous x.
 *
 * ## The property that separates a chart from an orrery
 *
 * The composite is one continuous strictly increasing function of x, and such a
 * map preserves interval overlap: two moons' charted radial ranges overlap if
 * and only if their true ranges do. Nereid interleaving with the outer
 * Neptunian irregulars on the chart is real interleaving, and no false crossing
 * can be introduced. It is a test, not a remark.
 */

import { KM_PER_AU } from '../../astronomy/constants';
import { PLANETARIUM_BODIES } from '../planets/planetData';
import { getMoonsByPlanet } from '../planets/moonData';
import { EARTH_MOON_ORBIT_META, getSatelliteOrbitMeta } from '../../astronomy/satellites';

export interface MapMoonOffsetParams {
  /** Zone-1 exponent. Lower compresses adjacent steps harder. */
  gamma: number;
  /** Zone boundary, in parent true radii. */
  x0: number;
  /** Where Io lands, in parent drawn radii — what pins zone 1's coefficient. */
  ioAnchorR: number;
  /** The outermost charted radius any moon may reach, in parent drawn radii. */
  capR: number;
  /** Closest a moon may be charted to the parent's centre, in drawn radii —
   *  1 is the drawn limb, so this is the visible gap around the globe. */
  clearanceR: number;
  /** Band width for a system whose every moon is bound (no catalog system is;
   *  the fallback exists so the policy is total). */
  bandR: number;
  /** Ceiling on the squeeze's anchor margin above clearance. Small, and
   *  halved-gap-limited, so S's slope stays positive however tight the gap. */
  marginMax: number;
}

export const MAP_MOON_OFFSET_DEFAULTS: MapMoonOffsetParams = {
  gamma: 0.8,
  x0: 30,
  ioAnchorR: 1.7,
  capR: 11,
  clearanceR: 1.35,
  bandR: 0.5,
  marginMax: 0.02,
};

/** One moon's orbit, in parent true radii — the only facts the policy needs. */
export interface MoonOffsetEntry {
  name: string;
  /** Semi-major axis, periapsis and apoapsis, all as x = distance / parent R. */
  meanX: number;
  periX: number;
  apoX: number;
}

/**
 * A system's offset policy: the shared curve plus whatever squeeze its packed
 * inner family needs. Built from the catalog once — nothing here depends on the
 * clock or the camera, so it is built lazily and then reused forever.
 */
export interface MoonOffsetPolicy {
  parentPlanet: string;
  /** Curve value at and above which the curve is exact. Infinity when every
   *  moon is bound and the fallback band governs the whole system. */
  fixedPoint: number;
  /** S(v) = slope·v + intercept, applied below the fixed point. */
  slope: number;
  intercept: number;
  /** False when no moon is bound: the curve stands unmodified. */
  squeezed: boolean;
  /** Names of the moons the squeeze was built for, innermost first — the
   *  system's bound run. Empty when nothing is bound. */
  boundRun: string[];
  params: MapMoonOffsetParams;
}

/** The two derived coefficients, memoized on the knobs they came from — the
 *  curve is evaluated per moon per frame, and both derivations sweep the
 *  catalog. */
interface MoonCurveCoefficients {
  /** Zone-1 scale: the value that puts Io exactly on its anchor. */
  a: number;
  /** Curve value at the zone boundary — where zone 2 continues from. */
  atX0: number;
  /** Zone-2 slope: the value that puts the catalog's farthest apoapsis exactly
   *  on the cap, so no instantaneous point any moon plots can exceed it. */
  b: number;
}
let coeffFor: MapMoonOffsetParams | null = null;
let coeff: MoonCurveCoefficients = { a: 0, atX0: 0, b: 0 };

function coefficients(p: MapMoonOffsetParams): MoonCurveCoefficients {
  if (coeffFor === p) return coeff;
  const ioX = ioMeanX();
  const a = ioX > 0 ? p.ioAnchorR / Math.pow(ioX, p.gamma) : p.ioAnchorR;
  const atX0 = a * Math.pow(p.x0, p.gamma);
  // A catalog with nothing past the boundary never uses zone 2; the fallback
  // span keeps the slope finite rather than dividing by a vanishing log.
  const span = Math.log(Math.max(farthestApoX(), p.x0 * Math.E) / p.x0);
  coeff = { a, atX0, b: Math.max(p.capR - atX0, 0) / span };
  coeffFor = p;
  return coeff;
}

/**
 * The shared two-zone curve: charted distance in parent drawn radii for a moon
 * currently x parent true radii out. Strictly increasing on x > 0, and
 * continuous at the zone boundary by construction.
 */
export function mapMoonCurveR(
  x: number,
  params: MapMoonOffsetParams = MAP_MOON_OFFSET_DEFAULTS,
): number {
  const safeX = Math.max(x, 0);
  const c = coefficients(params);
  if (safeX <= params.x0) return c.a * Math.pow(safeX, params.gamma);
  return c.atX0 + c.b * Math.log(safeX / params.x0);
}

/**
 * Build a system's policy from its moons' orbits. Entries in any order; the
 * bound run is found by sorting, since the curve is increasing and the run is
 * therefore a prefix in x.
 */
export function buildMoonOffsetPolicy(
  parentPlanet: string,
  entries: readonly MoonOffsetEntry[],
  params: MapMoonOffsetParams = MAP_MOON_OFFSET_DEFAULTS,
): MoonOffsetPolicy {
  const identity: MoonOffsetPolicy = {
    parentPlanet,
    fixedPoint: 0,
    slope: 1,
    intercept: 0,
    squeezed: false,
    boundRun: [],
    params,
  };
  if (entries.length === 0) return identity;
  const sorted = [...entries].sort((a, b) => a.meanX - b.meanX);
  const bound = sorted.filter((e) => mapMoonCurveR(e.meanX, params) < params.clearanceR);
  if (bound.length === 0) return identity;

  // The run's own minimum instantaneous value — its innermost periapsis. The
  // anchor sits here rather than on a mean, so the clearance holds at the
  // moment a bound moon is closest in.
  let vLo = Infinity;
  for (const e of bound) vLo = Math.min(vLo, mapMoonCurveR(e.periX, params));

  const firstUnbound = sorted[bound.length];
  if (firstUnbound) {
    const vHi = mapMoonCurveR(firstUnbound.meanX, params);
    const margin = Math.min(params.marginMax, (vHi - params.clearanceR) / 2);
    const slope = (vHi - (params.clearanceR + margin)) / Math.max(vHi - vLo, 1e-12);
    return {
      parentPlanet,
      fixedPoint: vHi,
      slope,
      intercept: vHi - slope * vHi,
      squeezed: true,
      boundRun: bound.map((e) => e.name),
      params,
    };
  }

  // No moon outside the clearance: there is no fixed point to anchor on, so the
  // run's whole instantaneous span opens onto a band just outside the parent.
  // No catalog system is like this; the fallback exists so the policy is total.
  let vMax = -Infinity;
  for (const e of bound) vMax = Math.max(vMax, mapMoonCurveR(e.apoX, params));
  const margin = Math.min(params.marginMax, params.bandR / 2);
  const lo = params.clearanceR + margin;
  const hi = params.clearanceR + params.bandR;
  if (!(vMax > vLo)) {
    // A single circular moon: no span to open, so the band's middle on a
    // slope-1 line, which is still strictly increasing.
    const mid = params.clearanceR + params.bandR / 2;
    return {
      parentPlanet,
      fixedPoint: Infinity,
      slope: 1,
      intercept: mid - vLo,
      squeezed: true,
      boundRun: bound.map((e) => e.name),
      params,
    };
  }
  const slope = (hi - lo) / (vMax - vLo);
  return {
    parentPlanet,
    fixedPoint: Infinity,
    slope,
    intercept: lo - slope * vLo,
    squeezed: true,
    boundRun: bound.map((e) => e.name),
    params,
  };
}

/**
 * Where a moon currently x parent true radii out is charted, in parent drawn
 * radii. One strictly increasing function of x per system: the curve above the
 * squeeze's fixed point, the squeeze below it, and continuous at the join
 * because the fixed point maps to itself.
 */
export function mapMoonOffsetR(policy: MoonOffsetPolicy, x: number): number {
  const v = mapMoonCurveR(x, policy.params);
  if (!policy.squeezed || v >= policy.fixedPoint) return v;
  return policy.slope * v + policy.intercept;
}

// ---- the catalog side --------------------------------------------------

let params: MapMoonOffsetParams = { ...MAP_MOON_OFFSET_DEFAULTS };
const policyCache = new Map<string, MoonOffsetPolicy>();
const entryCache = new Map<string, MoonOffsetEntry[]>();
let ioMeanXCache = 0;
let farthestApoXCache = 0;

/** The live knobs. */
export function mapMoonOffsetParams(): MapMoonOffsetParams {
  return params;
}

/**
 * Whether a set of knobs can be evaluated at all, and still describes a chart.
 *
 * The policy is a live-tunable A/B, so the values come from a hand at a console
 * — and the properties the whole contract rests on are not robust to arbitrary
 * numbers. A γ of 0 collapses zone 1 onto one radius; a cap under the curve's
 * value at the boundary collapses zone 2 the same way; x₀ of 0 divides by a
 * logarithm of zero and puts every moon at NaN; a negative anchor inverts the
 * order outright. None of those are charts. A knob set that fails here is
 * refused and the standing one keeps drawing, which is the same rule the map's
 * radial curve already follows.
 */
export function sanitizeMoonOffsetParams(
  candidate: MapMoonOffsetParams,
): MapMoonOffsetParams | null {
  for (const value of Object.values(candidate)) {
    if (!Number.isFinite(value)) return null;
  }
  // Strictly increasing in x, and starting outside the parent it orbits.
  if (!(candidate.gamma > 0) || candidate.gamma > 1) return null;
  if (!(candidate.x0 > 1)) return null;
  if (!(candidate.ioAnchorR > 0)) return null;
  if (!(candidate.clearanceR >= 1)) return null;
  if (!(candidate.bandR > 0) || !(candidate.marginMax >= 0)) return null;
  // Room for the squeeze's band inside the cap, and room for zone 2 past the
  // boundary — a cap at or under the curve's boundary value would flatten the
  // whole tail onto one ring.
  if (!(candidate.capR > candidate.clearanceR + candidate.bandR)) return null;
  const ioX = ioMeanX();
  const a = ioX > 0 ? candidate.ioAnchorR / Math.pow(ioX, candidate.gamma) : candidate.ioAnchorR;
  const atX0 = a * Math.pow(candidate.x0, candidate.gamma);
  if (!(a > 0) || !Number.isFinite(atX0) || !(candidate.capR > atX0)) return null;
  // And then the real test: build every system's policy from these numbers and
  // check the contract holds where the moons actually are. Windows on single
  // knobs cannot see what two of them do together — a clearance that lands
  // exactly on the first unbound moon's own curve value gives the squeeze a
  // slope of zero, and a whole packed family charts onto one ring.
  for (const planet of PLANETARIUM_BODIES) {
    const entries = moonOffsetEntries(planet.name);
    if (entries.length === 0) continue;
    const policy = buildMoonOffsetPolicy(planet.name, entries, candidate);
    if (!Number.isFinite(policy.slope) || !(policy.slope > 0)) return null;
    if (!Number.isFinite(policy.intercept)) return null;
    // Every breakpoint an orbit reaches, in order. Two moons at the SAME x
    // share a radius — that is a co-orbit, and it is the honest rendering of
    // one. Two moons at different x sharing a radius is a pile-up: distinct
    // orbits drawn as one ring. The positive slope above only guards the
    // squeeze, and the collapse can just as easily be in the base curve — as
    // gamma approaches zero, x^gamma approaches 1 and every regular in a system
    // charts on the anchor together — so the ordering is checked here, where
    // the drawn radii are.
    //
    // Clearance is checked at every PERIAPSIS. The squeeze is anchored on the
    // bound run's innermost periapsis precisely so the clearance holds there
    // and not merely on average, and a knob set under which some moon's closest
    // approach charts inside the parent has broken that promise however the run
    // was classified.
    const breakpoints: number[] = [];
    for (const e of entries) {
      breakpoints.push(e.periX, e.meanX, e.apoX);
      if (mapMoonOffsetR(policy, e.periX) < candidate.clearanceR - 1e-12) return null;
    }
    const lo = Math.min(...breakpoints);
    const hi = Math.max(...breakpoints);
    if (candidate.x0 > lo && candidate.x0 < hi) breakpoints.push(candidate.x0);
    breakpoints.sort((p, q) => p - q);
    let prevR = -Infinity;
    let prevX = -Infinity;
    for (const x of breakpoints) {
      const r = mapMoonOffsetR(policy, x);
      if (!Number.isFinite(r)) return null;
      if (r > candidate.capR + 1e-9) return null;
      if (x > prevX ? !(r > prevR) : r < prevR - 1e-12) return null;
      prevR = r;
      prevX = x;
    }
  }
  return candidate;
}

/** Dev bridge: retune the policy live. A partial merges into the running copy,
 *  null restores the shipped defaults; either way every built policy is
 *  dropped, since all of them are derived from these numbers. A merged set that
 *  would not draw a chart is refused, leaving the standing one in place, and
 *  the caller is told. */
export function setMapMoonOffsetParams(
  partial: Partial<MapMoonOffsetParams> | null,
): boolean {
  const merged = partial === null
    ? { ...MAP_MOON_OFFSET_DEFAULTS }
    : sanitizeMoonOffsetParams({ ...params, ...partial });
  if (!merged) return false;
  params = merged;
  policyCache.clear();
  coeffFor = null;
  return true;
}

function parentRadiusAU(parentPlanet: string): number {
  return PLANETARIUM_BODIES.find((p) => p.name === parentPlanet)?.radiusAU ?? 0;
}

/** Every moon of a system, as the orbits the policy reads: semi-major axis,
 *  periapsis and apoapsis in parent true radii. The elements are the same ones
 *  the renderer draws positions from, so the policy and the markers agree. */
export function moonOffsetEntries(parentPlanet: string): MoonOffsetEntry[] {
  const cached = entryCache.get(parentPlanet);
  if (cached) return cached;
  const rParent = parentRadiusAU(parentPlanet);
  const entries: MoonOffsetEntry[] = [];
  if (rParent > 0) {
    for (const moon of getMoonsByPlanet(parentPlanet)) {
      // Earth's Moon has no mean-element record — Meeus serves its positions —
      // so its orbit summary comes from the shared constant instead.
      const meta = moon.name === 'Moon' && parentPlanet === 'Earth'
        ? EARTH_MOON_ORBIT_META
        : getSatelliteOrbitMeta(moon.name);
      const aX = meta.semiMajorAxisKm / KM_PER_AU / rParent;
      const e = Math.min(Math.max(meta.eccentricity, 0), 0.99);
      entries.push({
        name: moon.name,
        meanX: aX,
        periX: aX * (1 - e),
        apoX: aX * (1 + e),
      });
    }
    entries.sort((a, b) => a.meanX - b.meanX);
  }
  entryCache.set(parentPlanet, entries);
  return entries;
}

/** Io's mean distance in Jupiter radii — the anchor zone 1 is pinned to. */
function ioMeanX(): number {
  if (ioMeanXCache > 0) return ioMeanXCache;
  ioMeanXCache = moonOffsetEntries('Jupiter').find((e) => e.name === 'Io')?.meanX ?? 0;
  return ioMeanXCache;
}

/** The farthest any catalog moon gets from its parent, in parent radii — the
 *  apoapsis the cap is derived at (Neso, on an orbit half as wide again as its
 *  mean). */
function farthestApoX(): number {
  if (farthestApoXCache > 0) return farthestApoXCache;
  let max = 0;
  for (const planet of PLANETARIUM_BODIES) {
    for (const e of moonOffsetEntries(planet.name)) max = Math.max(max, e.apoX);
  }
  farthestApoXCache = max;
  return max;
}

/** A system's policy, built once and cached. */
export function moonOffsetPolicyFor(parentPlanet: string): MoonOffsetPolicy {
  const cached = policyCache.get(parentPlanet);
  if (cached) return cached;
  const built = buildMoonOffsetPolicy(parentPlanet, moonOffsetEntries(parentPlanet), params);
  policyCache.set(parentPlanet, built);
  return built;
}
