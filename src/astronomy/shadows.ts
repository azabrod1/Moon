/**
 * Analytic shadow engine: umbra/penumbra/antumbra cone geometry plus event
 * search for the two shadow-event kinds a moon system produces —
 *
 *   'eclipse'        the moon passes through its parent's shadow
 *                    (for the Earth system: a lunar eclipse),
 *   'shadow-transit' the moon's shadow touches its parent
 *                    (for the Earth system: a solar eclipse).
 *
 * Everything runs in the heliocentric scene frame (Sun at the origin) and
 * resolves positions through the exact functions the renderer uses
 * (computeBodyPositionAU, computeMoonOffsetEquatorialAU), so an event found
 * here is an event the scene shows. The geometry uses only dot products and
 * norms, which the det(−1) scene embedding preserves — the engine is
 * indifferent to the roadmapped chirality flip.
 *
 * Classification is kind-split deliberately: a moon is "totally eclipsed"
 * when it fits inside the umbra (immersion), but a solar eclipse is "total"
 * when the umbra merely touches the parent (Earth could never fit inside the
 * Moon's umbra). Shadow-transit cone radii are evaluated at the sphere's near
 * surface along the axis, not its center plane — the Moon's umbra apex skims
 * Earth's surface, and the center-plane approximation misclassifies marginal
 * total/annular events.
 *
 * Pinned by shadows.test.ts against EclipseWise/Espenak catalogs and
 * published satellite-event timings.
 */
import * as THREE from 'three';
import { PLANETARIUM_BODIES, type PlanetData } from '../planetarium/planets/planetData';
import { getMoonsByPlanet, type MoonData } from '../planetarium/planets/moonData';
import { computeBodyPositionAU } from './planetary';
import {
  computeMoonOffsetEquatorialAU,
  getSatelliteOrbitMeta,
  EARTH_MOON_ORBIT_META,
  type SatelliteOrbitMeta,
} from './satellites';
import { DEG, KM_PER_AU } from './constants';
import { KM_CONSTANTS } from '../shared/constants/physicalData';

const MS_PER_DAY = 86_400_000;

/**
 * Danjon-style atmospheric shadow enlargement: Earth's effective occluding
 * radius grows by 1/85 so umbral magnitudes match the eclipse canon (NASA's
 * Five-Millennium catalog convention; shadows.test.ts pins the 2025 events'
 * EclipseWise magnitudes within ±0.1, where the ~0.02-mag difference between
 * published enlargement conventions is immaterial). Other occluders: none.
 */
const EARTH_SHADOW_ENLARGEMENT = 1 + 1 / 85;

/** Exported so shadow visuals pose cones with the same effective radius the engine classifies with. */
export function occluderEnlargement(occluderName: string): number {
  return occluderName === 'Earth' ? EARTH_SHADOW_ENLARGEMENT : 1;
}

// ================================================================
// Pure cone geometry
// ================================================================

export type ShadowClassification = 'none' | 'penumbral' | 'partial' | 'total' | 'annular';

export interface ShadowGeometry {
  /** Distance of the target center beyond the occluder along the shadow axis (km); ≤ 0 = sunward of the occluder. */
  axialKm: number;
  /** Perpendicular distance of the target center from the shadow axis (km). */
  missKm: number;
  /** Penumbra cone radius at the target's axial distance (km). */
  penumbraRadiusKm: number;
  /** Umbra cone radius at the target's axial distance (km); negative past the apex, where |value| is the antumbra radius. */
  umbraRadiusKm: number;
  /** Umbra cone length from occluder center to apex (km). */
  umbraLengthKm: number;
}

/**
 * Shadow-cone geometry of `occluder` evaluated at `target`, Sun at the
 * origin. Positions in AU, radii in km; zero allocations when `out` is given.
 */
export function computeShadowGeometry(
  occluderPosAU: THREE.Vector3,
  occluderRadiusKm: number,
  targetPosAU: THREE.Vector3,
  out: ShadowGeometry,
  shadowEnlargement = 1,
): ShadowGeometry {
  const sunDistKm = occluderPosAU.length() * KM_PER_AU;
  const axisX = (occluderPosAU.x * KM_PER_AU) / sunDistKm;
  const axisY = (occluderPosAU.y * KM_PER_AU) / sunDistKm;
  const axisZ = (occluderPosAU.z * KM_PER_AU) / sunDistKm;
  const relX = (targetPosAU.x - occluderPosAU.x) * KM_PER_AU;
  const relY = (targetPosAU.y - occluderPosAU.y) * KM_PER_AU;
  const relZ = (targetPosAU.z - occluderPosAU.z) * KM_PER_AU;

  const axialKm = relX * axisX + relY * axisY + relZ * axisZ;
  const relSq = relX * relX + relY * relY + relZ * relZ;
  const missKm = Math.sqrt(Math.max(0, relSq - axialKm * axialKm));

  const effectiveRadiusKm = occluderRadiusKm * shadowEnlargement;
  const sunRadiusKm = KM_CONSTANTS.SUN_RADIUS;
  const penumbraSlope = (sunRadiusKm + effectiveRadiusKm) / sunDistKm;
  const umbraSlope = (sunRadiusKm - effectiveRadiusKm) / sunDistKm;
  // Cone radii are clamped to the occluder plane on the sunward side so the
  // search metric stays continuous across axialKm = 0.
  const axialClampedKm = Math.max(0, axialKm);

  out.axialKm = axialKm;
  out.missKm = missKm;
  out.penumbraRadiusKm = effectiveRadiusKm + axialClampedKm * penumbraSlope;
  out.umbraRadiusKm = effectiveRadiusKm - axialClampedKm * umbraSlope;
  out.umbraLengthKm = (effectiveRadiusKm * sunDistKm) / (sunRadiusKm - effectiveRadiusKm);
  return out;
}

export interface EclipseCircumstance {
  classification: ShadowClassification;
  /** (rp + Rt − ρ)/(2Rt) — fraction of the target disc inside the penumbra. */
  penumbralMagnitude: number;
  /** (ru + Rt − ρ)/(2Rt) — ≥ 1 means total; 0 when past the umbra apex. */
  umbralMagnitude: number;
  /** (|ru| + Rt − ρ)/(2Rt) past the apex — ≥ 1 means annular; 0 otherwise. */
  antumbralMagnitude: number;
}

/**
 * Immersion classification for a moon inside a shadow ('eclipse' kind):
 * how deep the target disc sits in each cone.
 */
export function classifyEclipse(
  geometry: ShadowGeometry,
  targetRadiusKm: number,
  out: EclipseCircumstance,
): EclipseCircumstance {
  const rho = geometry.missKm;
  const rt = targetRadiusKm;
  const ru = geometry.umbraRadiusKm;
  const penumbralMagnitude = (geometry.penumbraRadiusKm + rt - rho) / (2 * rt);

  out.penumbralMagnitude = penumbralMagnitude;
  out.umbralMagnitude = 0;
  out.antumbralMagnitude = 0;

  if (geometry.axialKm <= 0 || penumbralMagnitude <= 0) {
    out.classification = 'none';
    return out;
  }
  if (ru > 0) {
    const umbralMagnitude = (ru + rt - rho) / (2 * rt);
    out.umbralMagnitude = Math.max(0, umbralMagnitude);
    out.classification =
      umbralMagnitude >= 1 ? 'total' : umbralMagnitude > 0 ? 'partial' : 'penumbral';
    return out;
  }
  const antumbralMagnitude = (-ru + rt - rho) / (2 * rt);
  out.antumbralMagnitude = Math.max(0, antumbralMagnitude);
  out.classification =
    antumbralMagnitude >= 1 ? 'annular' : antumbralMagnitude > 0 ? 'partial' : 'penumbral';
  return out;
}

/**
 * Touch classification for a shadow falling on the parent sphere
 * ('shadow-transit' kind): which cone reaches the body — total/annular read
 * "somewhere on the body", the convention eclipse catalogs use. Cone radii
 * are re-evaluated at the sphere's near surface along the axis (see header).
 */
export function classifyShadowTransit(
  geometry: ShadowGeometry,
  occluderRadiusKm: number,
  targetRadiusKm: number,
  occluderSunDistKm: number,
): ShadowClassification {
  const d = geometry.axialKm;
  const rho = geometry.missKm;
  const rt = targetRadiusKm;
  if (d <= 0) return 'none';

  const pierceKm = Math.sqrt(Math.max(0, rt * rt - Math.min(rho, rt) * Math.min(rho, rt)));
  const nearAxialKm = Math.max(0, d - pierceKm);
  const sunRadiusKm = KM_CONSTANTS.SUN_RADIUS;
  const umbraNearKm =
    occluderRadiusKm - (nearAxialKm * (sunRadiusKm - occluderRadiusKm)) / occluderSunDistKm;
  const penumbraNearKm =
    occluderRadiusKm + (nearAxialKm * (sunRadiusKm + occluderRadiusKm)) / occluderSunDistKm;

  if (umbraNearKm > 0 && rho < umbraNearKm + rt) return 'total';
  if (umbraNearKm <= 0 && rho < -umbraNearKm + rt) return 'annular';
  if (rho < penumbraNearKm + rt) return 'partial';
  return 'none';
}

// ================================================================
// Spec resolution — positions through the renderer's own seams
// ================================================================

export type ShadowEventKind = 'eclipse' | 'shadow-transit';

export interface ShadowEventSpec {
  kind: ShadowEventKind;
  parentPlanet: string;
  moonName: string;
}

export interface ShadowEvent {
  spec: ShadowEventSpec;
  /** Minimum-separation instant. */
  peakUtcMs: number;
  /** Outer (penumbral-contact) start/end. */
  startUtcMs: number;
  endUtcMs: number;
  classification: ShadowClassification;
  /** Immersion magnitudes at peak — 'eclipse' kind only (transits report class only). */
  penumbralMagnitude?: number;
  umbralMagnitude?: number;
  antumbralMagnitude?: number;
}

interface ResolvedSpec {
  spec: ShadowEventSpec;
  parent: PlanetData;
  moon: MoonData;
  meta: SatelliteOrbitMeta;
}

function resolveSpec(spec: ShadowEventSpec): ResolvedSpec {
  const parent = PLANETARIUM_BODIES.find((b) => b.name === spec.parentPlanet);
  if (!parent) throw new Error(`Unknown parent planet "${spec.parentPlanet}"`);
  const moon = getMoonsByPlanet(spec.parentPlanet).find((m) => m.name === spec.moonName);
  if (!moon) throw new Error(`No moon "${spec.moonName}" around ${spec.parentPlanet}`);
  const meta =
    spec.moonName === 'Moon' && spec.parentPlanet === 'Earth'
      ? EARTH_MOON_ORBIT_META
      : getSatelliteOrbitMeta(spec.moonName);
  return { spec, parent, moon, meta };
}

/** Both event kinds for every catalog moon of a parent — the Sky panel's search set. */
export function listShadowEventSpecs(parentPlanet: string): ShadowEventSpec[] {
  const specs: ShadowEventSpec[] = [];
  for (const moon of getMoonsByPlanet(parentPlanet)) {
    specs.push({ kind: 'eclipse', parentPlanet, moonName: moon.name });
    specs.push({ kind: 'shadow-transit', parentPlanet, moonName: moon.name });
  }
  return specs;
}

// Search scratch — module-level temporaries; the engine is synchronous and
// single-threaded, and the search path runs thousands of evaluations.
const tmpMoonOffset = new THREE.Vector3();
const tmpMoonHelio = new THREE.Vector3();
const tmpOrbitNormal = new THREE.Vector3();
const tmpGeometry: ShadowGeometry = {
  axialKm: 0,
  missKm: 0,
  penumbraRadiusKm: 0,
  umbraRadiusKm: 0,
  umbraLengthKm: 0,
};
const tmpCircumstance: EclipseCircumstance = {
  classification: 'none',
  penumbralMagnitude: 0,
  umbralMagnitude: 0,
  antumbralMagnitude: 0,
};

/**
 * One time-sample of the search metric: the target's miss distance minus the
 * outer (penumbra + target) contact radius — negative while the bodies are in
 * penumbral contact. On the sunward side of the occluder the axial distance
 * is folded in so the sign stays correct and the entry crossing lands at the
 * terminator plane.
 */
function evaluateMetricKm(resolved: ResolvedSpec, kind: ShadowEventKind, utcMs: number): number {
  const parentPos = computeBodyPositionAU(resolved.parent, utcMs);
  computeMoonOffsetEquatorialAU(resolved.moon.name, resolved.parent.name, utcMs, tmpMoonOffset);
  tmpMoonHelio.copy(parentPos).add(tmpMoonOffset);

  let metricKm: number;
  if (kind === 'eclipse') {
    computeShadowGeometry(
      parentPos,
      resolved.parent.radiusKm,
      tmpMoonHelio,
      tmpGeometry,
      occluderEnlargement(resolved.parent.name),
    );
    metricKm = tmpGeometry.missKm - (tmpGeometry.penumbraRadiusKm + resolved.moon.radiusKm);
  } else {
    computeShadowGeometry(tmpMoonHelio, resolved.moon.radiusKm, parentPos, tmpGeometry);
    metricKm = tmpGeometry.missKm - (tmpGeometry.penumbraRadiusKm + resolved.parent.radiusKm);
  }
  if (tmpGeometry.axialKm <= 0) {
    metricKm = Math.max(metricKm, -tmpGeometry.axialKm);
  }
  return metricKm;
}

/** Classify + build the public event record at the located peak. */
function buildEvent(
  resolved: ResolvedSpec,
  kind: ShadowEventKind,
  peakUtcMs: number,
  startUtcMs: number,
  endUtcMs: number,
): ShadowEvent {
  const parentPos = computeBodyPositionAU(resolved.parent, peakUtcMs);
  computeMoonOffsetEquatorialAU(resolved.moon.name, resolved.parent.name, peakUtcMs, tmpMoonOffset);
  tmpMoonHelio.copy(parentPos).add(tmpMoonOffset);

  if (kind === 'eclipse') {
    computeShadowGeometry(
      parentPos,
      resolved.parent.radiusKm,
      tmpMoonHelio,
      tmpGeometry,
      occluderEnlargement(resolved.parent.name),
    );
    const circumstance = classifyEclipse(tmpGeometry, resolved.moon.radiusKm, tmpCircumstance);
    return {
      spec: resolved.spec,
      peakUtcMs,
      startUtcMs,
      endUtcMs,
      classification: circumstance.classification,
      penumbralMagnitude: circumstance.penumbralMagnitude,
      umbralMagnitude: circumstance.umbralMagnitude,
      antumbralMagnitude: circumstance.antumbralMagnitude,
    };
  }

  computeShadowGeometry(tmpMoonHelio, resolved.moon.radiusKm, parentPos, tmpGeometry);
  const classification = classifyShadowTransit(
    tmpGeometry,
    resolved.moon.radiusKm,
    resolved.parent.radiusKm,
    tmpMoonHelio.length() * KM_PER_AU,
  );
  return { spec: resolved.spec, peakUtcMs, startUtcMs, endUtcMs, classification };
}

// ================================================================
// Event search
// ================================================================

export interface ShadowSearchOptions {
  /**
   * Scan budget: an exhausted scan returns 'none'. Refinement of an event the
   * scan already landed inside (contact bisection + peak ternary) always runs
   * to completion, so a 'found' result may exceed the budget by a bounded
   * amount (shadows.test.ts pins this semantic).
   */
  maxEvaluations?: number;
  /** Wall-clock slice in ms; when exceeded the search pauses and returns a cursor. */
  timeBudgetMs?: number;
  /**
   * Anchor of the search window when resuming a paused search: pass the
   * ORIGINAL fromUtcMs here while scanning from the returned cursor, so the
   * horizon stays fixed instead of sliding forward with every resume.
   */
  searchOriginUtcMs?: number;
  /** Deterministic evaluation counter (tests pin against this, not wall-clock). */
  statsOut?: { evaluations: number };
}

export type ShadowSearchResult =
  | { status: 'found'; event: ShadowEvent }
  | { status: 'none' }
  | { status: 'paused'; cursorUtcMs: number };

const DEFAULT_MAX_EVALUATIONS = 300_000;
/** Re-check the season prefilter every this many fine-scan steps. */
const PREFILTER_RECHECK_STEPS = 32;
const BISECTION_ITERATIONS = 25;
const TERNARY_ITERATIONS = 35;

interface SearchPlan {
  resolved: ResolvedSpec;
  kind: ShadowEventKind;
  fineStepDays: number;
  horizonDays: number;
  /** Conservative contact threshold at apoapsis (km) for the season prefilter. */
  skipThresholdKm: number;
  periapsisKm: number;
  /** Upper bound on how fast the miss geometry drifts (rad/day) — Sun motion + node precession. */
  driftRateRadPerDay: number;
  maxStrideDays: number;
}

function buildSearchPlan(resolved: ResolvedSpec, kind: ShadowEventKind, fromUtcMs: number): SearchPlan {
  const { meta, parent, moon } = resolved;
  const a = meta.semiMajorAxisKm;
  const e = meta.eccentricity;
  const periapsisKm = a * (1 - e);
  const apoapsisKm = a * (1 + e);

  const parentDistAU = computeBodyPositionAU(parent, fromUtcMs).length();
  const parentDistKm = parentDistAU * KM_PER_AU;
  const parentPeriodDays = 365.25 * Math.pow(parentDistAU, 1.5);
  const sunRadiusKm = KM_CONSTANTS.SUN_RADIUS;

  // Outer contact radius, sized at apoapsis so the prefilter can never skip a
  // reachable event: parent's penumbra + moon for eclipses, the moon's
  // penumbra + parent for transits.
  const occluderRadiusKm = kind === 'eclipse' ? parent.radiusKm : moon.radiusKm;
  const targetRadiusKm = kind === 'eclipse' ? moon.radiusKm : parent.radiusKm;
  const penumbraAtApoKm =
    occluderRadiusKm + (apoapsisKm * (sunRadiusKm + occluderRadiusKm)) / parentDistKm;
  const skipThresholdKm = penumbraAtApoKm + targetRadiusKm;

  // Event half-window from periapsis geometry and the periapsis angular rate,
  // so eccentric moons (Nereid e=0.75) can't be stepped over.
  const meanMotion = 360 / meta.periodDays;
  const omegaMaxDegPerDay = (meanMotion * (1 + e) * (1 + e)) / Math.pow(1 - e * e, 1.5);
  const contactAngleDeg =
    Math.asin(Math.min(1, skipThresholdKm / periapsisKm)) / DEG;
  const halfWindowDays = contactAngleDeg / omegaMaxDegPerDay;
  const fineStepDays = Math.min(meta.periodDays / 8, Math.max(halfWindowDays / 3, 1e-5));

  const parentPeriodYears = parentPeriodDays / 365.25;
  const horizonDays = Math.max(25, 0.55 * parentPeriodYears) * 365.25;

  const driftRateRadPerDay =
    (2 * Math.PI) / parentPeriodDays + meta.nodeRateDegPerDay * DEG * Math.sin(meta.inclinationDeg * DEG);

  return {
    resolved,
    kind,
    fineStepDays,
    horizonDays,
    skipThresholdKm,
    periapsisKm,
    driftRateRadPerDay,
    maxStrideDays: parentPeriodDays / 40,
  };
}

/**
 * Eclipse-season prefilter: with β the elevation of the Sun→parent axis out
 * of the moon's orbit plane, no contact is possible while
 * periapsis·sin β > skipThreshold. Returns the number of days that can be
 * safely skipped (0 = in season, must fine-scan). The stride is bounded so
 * the worst-case geometry drift (Sun motion + node precession, |n̂·â| keeps
 * it chirality-proof) cannot cross the margin within the skip.
 */
function seasonSkipDays(plan: SearchPlan, utcMs: number): number {
  const { resolved } = plan;
  const parentPos = computeBodyPositionAU(resolved.parent, utcMs);
  computeMoonOffsetEquatorialAU(
    resolved.moon.name,
    resolved.parent.name,
    utcMs,
    tmpMoonOffset,
    tmpOrbitNormal,
  );
  const parentDist = parentPos.length();
  const sinBeta = Math.abs(parentPos.dot(tmpOrbitNormal)) / parentDist;
  const minMissKm = plan.periapsisKm * sinBeta;
  const marginKm = minMissKm - plan.skipThresholdKm;
  if (marginKm <= 0) return 0;

  const allowableDriftRad = marginKm / plan.periapsisKm; // conservative: d(sinβ)/dβ ≤ 1
  const strideDays = (0.5 * allowableDriftRad) / plan.driftRateRadPerDay;
  return Math.min(plan.maxStrideDays, Math.max(plan.fineStepDays, strideDays));
}

/**
 * Find the next (direction = 1) or previous (direction = −1) shadow event.
 * A search that starts inside an event returns that event. Resumable: pass
 * `timeBudgetMs`, re-call with the returned cursor as `fromUtcMs`, and keep
 * the original start in `searchOriginUtcMs` so the horizon doesn't slide.
 */
export function searchShadowEvent(
  spec: ShadowEventSpec,
  fromUtcMs: number,
  direction: 1 | -1,
  options: ShadowSearchOptions = {},
): ShadowSearchResult {
  const resolved = resolveSpec(spec);
  const plan = buildSearchPlan(resolved, spec.kind, fromUtcMs);
  const maxEvaluations = options.maxEvaluations ?? DEFAULT_MAX_EVALUATIONS;
  const stats = options.statsOut ?? { evaluations: 0 };
  const startedAtMs = options.timeBudgetMs !== undefined ? performance.now() : 0;

  const metricAt = (utcMs: number): number => {
    stats.evaluations++;
    return evaluateMetricKm(resolved, spec.kind, utcMs);
  };

  const stepMs = direction * plan.fineStepDays * MS_PER_DAY;
  const horizonMs = plan.horizonDays * MS_PER_DAY;
  const originUtcMs = options.searchOriginUtcMs ?? fromUtcMs;

  let cursor = fromUtcMs;
  let stepsSincePrefilter = 0;

  // Beyond-horizon resume: nothing left to scan.
  if (Math.abs(cursor - originUtcMs) > horizonMs) return { status: 'none' };

  // Mid-event start: expand around the starting instant.
  if (metricAt(cursor) <= 0) {
    return { status: 'found', event: expandEvent(plan, cursor, stats, maxEvaluations) };
  }

  while (Math.abs(cursor - originUtcMs) <= horizonMs) {
    if (stats.evaluations >= maxEvaluations) return { status: 'none' };
    if (options.timeBudgetMs !== undefined && performance.now() - startedAtMs > options.timeBudgetMs) {
      return { status: 'paused', cursorUtcMs: cursor };
    }

    // Season prefilter (also re-checked periodically inside a fine scan so a
    // season closing mid-scan flips us back to striding).
    if (stepsSincePrefilter === 0) {
      const skipDays = seasonSkipDays(plan, cursor);
      stats.evaluations++; // the prefilter's own ephemeris sample
      if (skipDays > plan.fineStepDays) {
        cursor += direction * skipDays * MS_PER_DAY;
        if (metricAt(cursor) <= 0) {
          return { status: 'found', event: expandEvent(plan, cursor, stats, maxEvaluations) };
        }
        continue;
      }
      stepsSincePrefilter = PREFILTER_RECHECK_STEPS;
    }
    stepsSincePrefilter--;

    cursor += stepMs;
    if (metricAt(cursor) <= 0) {
      return { status: 'found', event: expandEvent(plan, cursor, stats, maxEvaluations) };
    }
  }
  return { status: 'none' };
}

/** Synchronous convenience wrapper: event or null. */
export function findShadowEvent(
  spec: ShadowEventSpec,
  fromUtcMs: number,
  direction: 1 | -1,
  options: ShadowSearchOptions = {},
): ShadowEvent | null {
  const result = searchShadowEvent(spec, fromUtcMs, direction, options);
  return result.status === 'found' ? result.event : null;
}

/**
 * Expand a sample known to be inside an event (metric ≤ 0) to its contacts
 * and peak: fine-step outward in both directions to bracket the entry/exit
 * crossings, bisect them, then ternary-minimize the metric for the peak.
 */
function expandEvent(
  plan: SearchPlan,
  insideUtcMs: number,
  stats: { evaluations: number },
  maxEvaluations: number,
): ShadowEvent {
  const metricAt = (utcMs: number): number => {
    stats.evaluations++;
    return evaluateMetricKm(plan.resolved, plan.kind, utcMs);
  };
  const stepMs = plan.fineStepDays * MS_PER_DAY;

  const findContact = (dir: 1 | -1): number => {
    let inside = insideUtcMs;
    let probe = insideUtcMs + dir * stepMs;
    let guard = 0;
    while (metricAt(probe) <= 0) {
      inside = probe;
      probe += dir * stepMs;
      // An event can't outlast a full orbit of contact half-windows; the guard
      // only trips on degenerate geometry (and the eval cap backs it up).
      if (++guard > 10_000 || stats.evaluations >= maxEvaluations) break;
    }
    let lo = inside; // metric ≤ 0
    let hi = probe; // metric > 0
    for (let i = 0; i < BISECTION_ITERATIONS; i++) {
      const mid = (lo + hi) / 2;
      if (metricAt(mid) <= 0) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };

  const startUtcMs = findContact(-1);
  const endUtcMs = findContact(1);

  let lo = startUtcMs;
  let hi = endUtcMs;
  for (let i = 0; i < TERNARY_ITERATIONS; i++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    if (metricAt(m1) <= metricAt(m2)) hi = m2;
    else lo = m1;
  }
  const peakUtcMs = (lo + hi) / 2;
  return buildEvent(plan.resolved, plan.kind, peakUtcMs, startUtcMs, endUtcMs);
}

/**
 * The next event per (moon, kind) pair of a system, earliest `count` first.
 * Synchronous — UI callers should instead iterate listShadowEventSpecs with
 * per-frame time budgets (see PlanetariumMode's chunked scheduler).
 */
export function upcomingSystemEvents(
  parentPlanet: string,
  fromUtcMs: number,
  count = 6,
  options: ShadowSearchOptions = {},
): ShadowEvent[] {
  const events: ShadowEvent[] = [];
  for (const spec of listShadowEventSpecs(parentPlanet)) {
    const event = findShadowEvent(spec, fromUtcMs, 1, options);
    if (event) events.push(event);
  }
  events.sort((a, b) => a.peakUtcMs - b.peakUtcMs);
  return events.slice(0, count);
}

// ================================================================
// Per-frame dimming helper (renderer payoff)
// ================================================================

export interface MoonShadingState {
  /** 1 = fully sunlit, → 0 deep in umbra. Linear center-point sun visibility. */
  sunVisibleFraction: number;
  /** True while any part of the moon disc touches the umbra (drives reddening). */
  inUmbra: boolean;
}

/**
 * Cheap per-frame shading factor for a visible moon, from positions the
 * render loop already has in hand (no ephemeris work, zero allocations).
 */
export function computeMoonShading(
  parentPosAU: THREE.Vector3,
  parentName: string,
  parentRadiusKm: number,
  moonOffsetAU: THREE.Vector3,
  moonRadiusKm: number,
  out: MoonShadingState,
): MoonShadingState {
  tmpMoonHelio.copy(parentPosAU).add(moonOffsetAU);
  computeShadowGeometry(
    parentPosAU,
    parentRadiusKm,
    tmpMoonHelio,
    tmpGeometry,
    occluderEnlargement(parentName),
  );
  out.sunVisibleFraction = 1;
  out.inUmbra = false;
  if (tmpGeometry.axialKm <= 0) return out;

  const rho = tmpGeometry.missKm;
  const rp = tmpGeometry.penumbraRadiusKm;
  const ru = tmpGeometry.umbraRadiusKm; // negative past the apex → fraction floors above 0 (annular)
  if (rho >= rp + moonRadiusKm) return out;

  const fraction = (rho - ru) / (rp - ru);
  out.sunVisibleFraction = Math.min(1, Math.max(0, fraction));
  out.inUmbra = ru > 0 && rho < ru + moonRadiusKm;
  return out;
}
