/**
 * Pure math for the Observatory's orbit-details overlay: derives ellipse
 * annotation (apsides, axes, foci, center) from a trajectory SAMPLED through
 * the renderer's own position seam — the markers describe the curve actually
 * drawn, not a catalog idealization (the moon sits on the line by
 * construction; Meeus perturbations and librator drift included honestly).
 *
 * Layout contract (sampleSpanTimesMs): the span is [refT − P/8, refT + 7P/8],
 * refreshed while |now − refT| stays under min(P/16, 6 h) — so the closure
 * seam sits ~45° behind the subject, never under it, and both Kepler sectors
 * (sectorWindows) stay strictly inside the span. Unit-tested; PlanetariumMode
 * owns the seam evaluation and the THREE objects (world/OrbitDetailsVisuals).
 */
import * as THREE from 'three';
import { KM_PER_AU } from '../astronomy/constants';
import type { MoonDisplayOrbit } from '../astronomy/satellites';

const MS_PER_DAY = 86_400_000;
/** Resample guard: min(P/16, 6 h), symmetric (backward jumps re-center too). */
const RESAMPLE_MAX_MS = 6 * 3_600_000;
/** Span starts P/8 before the reference time (seam ~45° behind the subject). */
export const SPAN_LEAD_FRACTION = 1 / 8;
/** Sweep one day for a 27.32-day lunation; generalized as P/27.32. */
export const SECTOR_SWEEP_FRACTION = 1 / 27.321661;
/** Sampling density: high-e orbits thin out near periapsis (dν/dM at peri is
 *  (1+e)²/(1−e²)^1.5 ≈ 10.6× for Nereid) and need the denser grid there. */
export function orbitSampleSegments(eccentricity: number): number {
  return eccentricity > 0.25 ? 768 : 256;
}
/** Below this measured radial variation the apsides/axes directions are float
 *  noise (11 catalog records have e = 0 exactly) — suppress them rather than
 *  let the ticks re-spin on every resample. Io (e=0.004, 0.8% variation)
 *  stays above it: small-but-real eccentricity remains visible. */
const CIRCULAR_RADIAL_VARIATION = 1e-3;
/** Foci-merge: an empty focus closer to the parent's center than ~its mesh is
 *  a marker buried inside the planet (Io: c ≈ 1,687 km inside Jupiter). */
const FOCI_MERGE_PARENT_RADIUS_FACTOR = 1.2;
/** Close the polyline only when the endpoint gap is visually negligible. */
const CLOSE_LOOP_GAP_FRACTION = 0.005;

export interface OrbitGeometry {
  semiMajorAxisAU: number;
  /** Measured from the samples (max |minor-axis coordinate|), NOT a√(1−e²) —
   *  the readout describes the drawn curve (they differ for the Meeus Moon). */
  semiMinorAxisAU: number;
  eccentricity: number;
  focalOffsetAU: number;
  periRadiusAU: number;
  apoRadiusAU: number;
  /** Radial extremes from the parent (the honest perigee/apogee markers). */
  periPoint: THREE.Vector3;
  apoPoint: THREE.Vector3;
  /** The curve's maximum-diameter pair — the drawn major-axis endpoints.
   *  Exactly the major-axis ends for a true ellipse; for perturbed orbits
   *  they can sit slightly off the radial extremes. */
  majorAxisA: THREE.Vector3;
  majorAxisB: THREE.Vector3;
  center: THREE.Vector3;
  /** F1 is the parent at the local origin, so the empty focus is 2·center. */
  emptyFocus: THREE.Vector3;
  majorDir: THREE.Vector3;
  minorDir: THREE.Vector3;
  /** Follows the samples' time order — retrograde orbits get the honest sign. */
  normal: THREE.Vector3;
  /** (apo − peri) / mean radius — the circular-degeneracy signal. */
  radialVariation: number;
  closureGapAU: number;
}

/** Sample times for one revolution: N = segments + 1 points spanning exactly
 *  one period over [refT − P/8, refT + 7P/8]; first/last share the same mean
 *  anomaly, so the endpoint gap measures precession/perturbation only. */
export function sampleSpanTimesMs(refTMs: number, periodDays: number, segments: number): number[] {
  const periodMs = periodDays * MS_PER_DAY;
  const startMs = refTMs - SPAN_LEAD_FRACTION * periodMs;
  const times: number[] = new Array(segments + 1);
  for (let i = 0; i <= segments; i++) {
    times[i] = startMs + (i / segments) * periodMs;
  }
  return times;
}

export function needsResample(nowMs: number, refTMs: number, periodDays: number): boolean {
  const guardMs = Math.min((periodDays / 16) * MS_PER_DAY, RESAMPLE_MAX_MS);
  return Math.abs(nowMs - refTMs) > guardMs;
}

export interface SectorWindows {
  trailingStartMs: number;
  trailingEndMs: number;
  offsetStartMs: number;
  offsetEndMs: number;
  sweepMs: number;
}

/** The two equal-duration Kepler sectors: one trailing the subject, one
 *  HALF-PERIOD-offset (t + P/2 is M+180°, not ν+180° — do not "fix" this
 *  toward the geometric antipode: equal TIME is what makes the areas equal,
 *  and M+180° is what parks the second sector at the opposite apsis). */
export function sectorWindows(
  nowMs: number,
  periodDays: number,
  sweepFraction: number = SECTOR_SWEEP_FRACTION,
): SectorWindows {
  const periodMs = periodDays * MS_PER_DAY;
  const sweepMs = sweepFraction * periodMs;
  return {
    trailingStartMs: nowMs - sweepMs,
    trailingEndMs: nowMs,
    offsetStartMs: nowMs + periodMs / 2 - sweepMs,
    offsetEndMs: nowMs + periodMs / 2,
    sweepMs,
  };
}

/** Quadratic (3-point) refinement of an extremum at index i: returns the
 *  fractional offset s ∈ [−1, 1] of the parabola's vertex. */
function parabolicVertexOffset(rPrev: number, rMid: number, rNext: number): number {
  const denom = rPrev - 2 * rMid + rNext;
  if (Math.abs(denom) < 1e-30) return 0;
  const s = (0.5 * (rPrev - rNext)) / denom;
  return THREE.MathUtils.clamp(s, -1, 1);
}

/** Quadratic Lagrange interpolation of the three points around index i. */
function refinePoint(
  prev: THREE.Vector3,
  mid: THREE.Vector3,
  next: THREE.Vector3,
  s: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const wPrev = 0.5 * s * (s - 1);
  const wMid = 1 - s * s;
  const wNext = 0.5 * s * (s + 1);
  return out
    .set(0, 0, 0)
    .addScaledVector(prev, wPrev)
    .addScaledVector(mid, wMid)
    .addScaledVector(next, wNext);
}

/**
 * Derive the annotation geometry from sampled planetocentric positions (AU,
 * parent at origin). Expects the sampleSpanTimesMs layout (last point repeats
 * the first's mean anomaly); apsides search skips the duplicated endpoint.
 */
export function deriveOrbitGeometry(samples: THREE.Vector3[]): OrbitGeometry {
  const n = samples.length - 1; // distinct points; samples[n] ≈ samples[0]
  let periIndex = 0;
  let apoIndex = 0;
  let periR = Infinity;
  let apoR = -Infinity;
  for (let i = 0; i < n; i++) {
    const r = samples[i].length();
    if (r < periR) { periR = r; periIndex = i; }
    if (r > apoR) { apoR = r; apoIndex = i; }
  }

  const wrap = (i: number) => ((i % n) + n) % n;
  const refineApsis = (index: number, out: THREE.Vector3) => {
    const prev = samples[wrap(index - 1)];
    const mid = samples[index];
    const next = samples[wrap(index + 1)];
    const s = parabolicVertexOffset(prev.length(), mid.length(), next.length());
    refinePoint(prev, mid, next, s, out);
    return out.length();
  };

  const periPoint = new THREE.Vector3();
  const apoPoint = new THREE.Vector3();
  const periRadiusAU = refineApsis(periIndex, periPoint);
  const apoRadiusAU = refineApsis(apoIndex, apoPoint);

  // Center + major axis from the curve's maximum-diameter pair. For an exact
  // ellipse the farthest-apart samples are the major-axis endpoints and
  // their midpoint is exactly the center. Deriving the center from the two
  // RADIAL extremes instead skews on perturbed orbits — Meeus evection moves
  // perigee and apogee off-antipodal, and the measured semi-minor came out
  // LARGER than semi-major. O(n²) scan, resample-time only (≤768 samples).
  let diamI = 0;
  let diamJ = 0;
  let diamSq = -1;
  for (let i = 0; i < n; i++) {
    const si = samples[i];
    for (let j = i + 1; j < n; j++) {
      const d = si.distanceToSquared(samples[j]);
      if (d > diamSq) {
        diamSq = d;
        diamI = i;
        diamJ = j;
      }
    }
  }
  const majorAxisA = samples[diamI].clone();
  const majorAxisB = samples[diamJ].clone();
  const center = new THREE.Vector3().addVectors(majorAxisA, majorAxisB).multiplyScalar(0.5);
  const emptyFocus = center.clone().multiplyScalar(2);
  const semiMajorAxisAU = Math.sqrt(Math.max(diamSq, 0)) / 2;
  const focalOffsetAU = center.length();
  const eccentricity = semiMajorAxisAU > 0 ? focalOffsetAU / semiMajorAxisAU : 0;

  // Polygon normal in sample (time) order: Σ sᵢ × sᵢ₊₁ over the closed loop.
  const normal = new THREE.Vector3();
  const segCross = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    segCross.crossVectors(samples[i], samples[wrap(i + 1)]);
    normal.add(segCross);
  }
  normal.normalize();

  const majorDir = new THREE.Vector3().subVectors(majorAxisB, majorAxisA);
  if (majorDir.lengthSq() < 1e-30) majorDir.copy(samples[0]);
  majorDir.normalize();
  const minorDir = new THREE.Vector3().crossVectors(normal, majorDir).normalize();

  const fromCenter = new THREE.Vector3();
  let semiMinorAxisAU = 0;
  for (let i = 0; i < n; i++) {
    const m = Math.abs(fromCenter.subVectors(samples[i], center).dot(minorDir));
    if (m > semiMinorAxisAU) semiMinorAxisAU = m;
  }

  const meanR = (periRadiusAU + apoRadiusAU) / 2;
  const radialVariation = meanR > 0 ? (apoRadiusAU - periRadiusAU) / meanR : 0;
  const closureGapAU = samples[samples.length - 1].distanceTo(samples[0]);

  return {
    semiMajorAxisAU,
    semiMinorAxisAU,
    eccentricity,
    focalOffsetAU,
    periRadiusAU,
    apoRadiusAU,
    periPoint,
    apoPoint,
    majorAxisA,
    majorAxisB,
    center,
    emptyFocus,
    majorDir,
    minorDir,
    normal,
    radialVariation,
    closureGapAU,
  };
}

/** e = 0 (or float-noise) orbits: apsides/axes directions are meaningless. */
export function isCircularDegenerate(geometry: OrbitGeometry): boolean {
  return geometry.radialVariation < CIRCULAR_RADIAL_VARIATION;
}

/** Empty focus buried inside the parent — hide the F2 marker + c-segment. */
export function areFociMerged(geometry: OrbitGeometry, parentRadiusAU: number): boolean {
  return geometry.focalOffsetAU < parentRadiusAU * FOCI_MERGE_PARENT_RADIUS_FACTOR;
}

export function shouldCloseLoop(geometry: OrbitGeometry): boolean {
  return geometry.closureGapAU < CLOSE_LOOP_GAP_FRACTION * geometry.semiMajorAxisAU;
}

/** Signed-magnitude area of the fan polygon (apex at origin, AU²) — shared by
 *  the equal-area test and any future readout. */
export function fanAreaAU2(points: THREE.Vector3[]): number {
  const sum = new THREE.Vector3();
  const segCross = new THREE.Vector3();
  for (let i = 0; i + 1 < points.length; i++) {
    segCross.crossVectors(points[i], points[i + 1]);
    sum.add(segCross);
  }
  return sum.length() / 2;
}

function formatKm(valueAU: number): string {
  return `${Math.round(valueAU * KM_PER_AU).toLocaleString('en-US')} km`;
}

function formatPeriod(periodDays: number): string {
  if (periodDays >= 1) return `${periodDays.toFixed(2)} d`;
  return `${(periodDays * 24).toFixed(1)} h`;
}

function formatSweep(sweepMs: number): string {
  const days = sweepMs / MS_PER_DAY;
  if (days >= 1) return `${days.toFixed(1)} d`;
  const hours = days * 24;
  if (hours >= 1) return `${hours.toFixed(1)} h`;
  return `${Math.round(hours * 60)} min`;
}

export interface OrbitReadout {
  /** Dense mono ·-joined data lines (hero data-line idiom). */
  lines: string[];
  /** Honesty captions (low-e, foci-merged, circular, phase accuracy). */
  captions: string[];
}

/** Phase caveat threshold: fitted irregulars can carry librator-scale errors
 *  (Neso: tier "fitted", cal residual 90°) — gate on residuals, not tier. */
const PHASE_CAVEAT_SEPARATION_DEG = 10;

export function formatOrbitReadout(
  geometry: OrbitGeometry,
  display: MoonDisplayOrbit,
  opts: { isEarthMoon: boolean; parentRadiusAU: number },
): OrbitReadout {
  const circular = isCircularDegenerate(geometry);
  const merged = areFociMerged(geometry, opts.parentRadiusAU);
  const periLabel = opts.isEarthMoon ? 'perigee' : 'periapsis';
  const apoLabel = opts.isEarthMoon ? 'apogee' : 'apoapsis';

  const lines: string[] = [];
  // Lead with what is visible at true scale: the focal offset IS the visible
  // eccentricity (Earth sits 21,104 km off-center while the axes differ 0.15%).
  lines.push(`e ${geometry.eccentricity.toFixed(3)} · center offset ${formatKm(geometry.focalOffsetAU)}`);
  if (!circular) {
    lines.push(`${periLabel} ${formatKm(geometry.periRadiusAU)} · ${apoLabel} ${formatKm(geometry.apoRadiusAU)}`);
  }
  lines.push(
    `axes ${formatKm(geometry.semiMajorAxisAU * 2)} × ${formatKm(geometry.semiMinorAxisAU * 2)}` +
      ` · period ${formatPeriod(display.periodDays)}`,
  );
  lines.push(
    `equal areas · ${formatSweep(sectorWindows(0, display.periodDays).sweepMs)} each`,
  );

  const captions: string[] = [];
  if (circular) {
    captions.push('circular within the model — apsides not meaningful');
  } else if (merged) {
    captions.push('foci nearly coincide — orbit nearly circular');
  } else if (geometry.eccentricity < 0.1) {
    const axesDiffPct = (1 - geometry.semiMinorAxisAU / geometry.semiMajorAxisAU) * 100;
    captions.push(
      `nearly circular — axes differ by ${axesDiffPct.toFixed(2)}%; the offset focus is the visible eccentricity`,
    );
  }
  if (display.tier === 'librator' || display.maxCalibrationSeparationDeg > PHASE_CAVEAT_SEPARATION_DEG) {
    const range = Math.round(display.maxCalibrationSeparationDeg);
    captions.push(
      display.tier === 'librator'
        ? `position along the orbit approximate (±${range}° — resonant libration)`
        : `position along the orbit approximate (±${range}°)`,
    );
  }
  return { lines, captions };
}
