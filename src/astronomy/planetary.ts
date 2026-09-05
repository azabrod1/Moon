/**
 * Planet-position math for the Planetarium: Kepler solver, element-to-vector
 * transforms in the scene's J2000 frame, the Meeus Earth/Moon seams, and the
 * shared simulation time type. Elements come from the Standish provider
 * (standish.ts); Earth's render position alone stays Meeus-derived. Consumed
 * by the Planetarium world and nav controllers.
 */
import * as THREE from 'three';
import type { PlanetData } from '../planetarium/planets/planetData';
import { dateToJD, moonPosition, sunPosition, type SunPosition } from './ephemeris';
import { deltaTDaysAtDate } from './deltaT';
import { accumulatedPrecessionLonDeg } from './precession';
import {
  STANDISH_MAX_JD,
  STANDISH_MIN_JD,
  getStandishElements,
  type KeplerElements,
} from './standish';
import { DEG, J2000, KM_PER_AU, OBLIQUITY_DEG } from './constants';

const REFERENCE_NORTH = new THREE.Vector3(0, 1, 0);
// The node line an inclination turns about: +X of the intermediate ecliptic
// frame. A constant rather than a vector built per call — an orbit line is
// hundreds of samples and every one of them turns about this same axis.
const NODE_LINE_AXIS = new THREE.Vector3(1, 0, 0);

// RotX(+ε): carries the ecliptic pole (0,1,0) to (0, cos ε, sin ε) =
// raDecToVector(270°, 90°−ε), the J2000 equatorial position of the north
// ecliptic pole. Pinned by the ecliptic-pole test in planetary.test.ts.
const ECLIPTIC_TO_EQUATORIAL = new THREE.Matrix4().makeRotationX(OBLIQUITY_DEG * DEG);

export interface SimulationTime {
  currentUtcMs: number;
  rate: number;
  paused: boolean;
}

export interface BodyState {
  positionAU: THREE.Vector3;
  orientationQuaternion: THREE.Quaternion;
  sunDirection: THREE.Vector3;
}

function solveKepler(meanAnomalyRad: number, eccentricity: number): number {
  let eccentricAnomaly = eccentricity < 0.8 ? meanAnomalyRad : Math.PI;
  for (let i = 0; i < 10; i++) {
    const delta =
      (meanAnomalyRad - (eccentricAnomaly - eccentricity * Math.sin(eccentricAnomaly))) /
      (1 - eccentricity * Math.cos(eccentricAnomaly));
    eccentricAnomaly += delta;
    if (Math.abs(delta) < 1e-10) break;
  }
  return eccentricAnomaly;
}

function getDaysSinceJ2000(jd: number): number {
  return jd - J2000;
}

function computeOrbitalPlanePosition(
  el: KeplerElements,
  eccentricAnomalyRad: number,
  out: THREE.Vector3 = new THREE.Vector3(),
): THREE.Vector3 {
  const x = el.semiMajorAxisAU * (Math.cos(eccentricAnomalyRad) - el.eccentricity);
  const yInPlane =
    el.semiMajorAxisAU *
    Math.sqrt(1 - el.eccentricity * el.eccentricity) *
    Math.sin(eccentricAnomalyRad);
  // Scene ecliptic frame: longitude increases toward −Z, so the textbook
  // in-plane (x, y) lands at (x, 0, −y).
  return out.set(x, 0, -yInPlane);
}

/** Turn an in-plane position into the ecliptic frame, IN PLACE and returned:
 *  both callers hand over a vector built for exactly this. */
function applyOrbitalOrientation(position: THREE.Vector3, el: KeplerElements): THREE.Vector3 {
  // ω = ϖ − Ω: the tables give the longitude of perihelion, not the argument.
  const argPerihelionRad = (el.lonPerihelionDeg - el.ascendingNodeDeg) * DEG;
  const inclinationRad = el.inclinationDeg * DEG;
  const ascendingNodeRad = el.ascendingNodeDeg * DEG;

  // Scene ecliptic frame: +Y north, longitude increasing toward −Z, so a +θ
  // rotation about +Y advances longitude by +θ — the textbook rotation chain
  // applies with no negations: +ω about the pole, +i about the node line
  // (+X), +Ω about the pole. planetary.test.ts pins this against the textbook
  // element formula and the Meeus Sun.
  return position
    .applyAxisAngle(REFERENCE_NORTH, argPerihelionRad)
    .applyAxisAngle(NODE_LINE_AXIS, inclinationRad)
    .applyAxisAngle(REFERENCE_NORTH, ascendingNodeRad);
}

export function eclipticToEquatorial(vector: THREE.Vector3): THREE.Vector3 {
  return vector.clone().applyMatrix4(ECLIPTIC_TO_EQUATORIAL);
}

/**
 * The north ecliptic pole expressed in the scene's J2000 equatorial frame —
 * (0, cos ε, sin ε). THE single definition site: derived from the obliquity
 * matrix above, never a re-inlined rotation, so every consumer (the cruise
 * flight horizon, the Moon's tidal-lock roll reference) shares one vector and
 * one sign convention. Treat as read-only; copy before mutating.
 */
export const ECLIPTIC_NORTH_EQUATORIAL: THREE.Vector3 = eclipticToEquatorial(
  new THREE.Vector3(0, 1, 0),
).normalize();

/**
 * Scratch for ttJDFromUtcMs. The JD and ΔT conventions are calendar math —
 * dateToJD and deltaTDaysAtDate read civil UTC components — and that stays:
 * setTime loads the same [[DateValue]] a fresh construction would carry, so
 * every component read is bit-identical, without the hot samplers (hundreds
 * of calls a frame) allocating a Date per sample. Consumed before return,
 * never handed out; nothing this calls retains the Date.
 */
const ttScratchDate = new Date(0);

/** TT Julian Day from civil UTC ms — what ephemeris/rotation theories expect. */
export function ttJDFromUtcMs(utcMs: number): number {
  ttScratchDate.setTime(utcMs);
  return dateToJD(ttScratchDate) + deltaTDaysAtDate(ttScratchDate);
}

const UNIX_EPOCH_JD = 2440587.5;

/**
 * The civil UTC instant whose TT Julian Day is `jdTT` — the inverse of
 * ttJDFromUtcMs, by fixed point. The day count itself is linear in the
 * timestamp, so the only nonlinearity to converge through is ΔT, which drifts
 * by seconds per year; the residual then floors at Date's whole-millisecond
 * quantization, orders below anything a half-period clamp can feel.
 */
function utcMsAtTtJD(jdTT: number): number {
  let utcMs = (jdTT - UNIX_EPOCH_JD) * 86_400_000;
  for (let i = 0; i < 4; i++) {
    utcMs += (jdTT - ttJDFromUtcMs(utcMs)) * 86_400_000;
  }
  return utcMs;
}

/**
 * THE chirality definition site: J2000 equatorial RA/Dec → scene vector via
 * the proper rotation (x, z, −y) — +X = vernal equinox (RA 0), +Y = celestial
 * north, +Z = RA 270°. det = +1, so the rendered sky has real-world chirality.
 * Every scene embedding of sky coordinates must route through here.
 */
export function raDecToVector(raDeg: number, decDeg: number, radius = 1, out?: THREE.Vector3): THREE.Vector3 {
  const ra = raDeg * DEG;
  const dec = decDeg * DEG;
  const cosDec = Math.cos(dec);

  return (out ?? new THREE.Vector3()).set(
    radius * cosDec * Math.cos(ra),
    radius * Math.sin(dec),
    -radius * cosDec * Math.sin(ra),
  );
}

/**
 * Heliocentric position from of-epoch elements (the mean anomaly arrives
 * propagated inside the KeplerElements — see getStandishElements), in the
 * scene's intermediate ecliptic frame.
 */
export function computeKeplerPositionEcliptic(
  el: KeplerElements,
  out?: THREE.Vector3,
): THREE.Vector3 {
  const eccentricAnomalyRad = solveKepler(el.meanAnomalyDeg * DEG, el.eccentricity);
  return applyOrbitalOrientation(computeOrbitalPlanePosition(el, eccentricAnomalyRad, out), el);
}

/**
 * `out` is the caller's own vector, written and returned instead of a fresh
 * one — the zero-allocation seam a sampler that runs this hundreds of times a
 * frame needs (the same optional-`out` idiom as projectToScreen). The
 * arithmetic is identical either way: the frame transform is applied in place
 * to a vector this call has just built, which is what the allocating path did
 * to its clone.
 */
export function computeKeplerPositionEquatorial(
  el: KeplerElements,
  out?: THREE.Vector3,
): THREE.Vector3 {
  return computeKeplerPositionEcliptic(el, out).applyMatrix4(ECLIPTIC_TO_EQUATORIAL);
}

/**
 * Geocentric position of Earth's Moon in the scene's equatorial frame (AU),
 * from the Meeus lunar theory. Replaces the circular clock model for the one
 * moon whose real geometry (phase, nodes, eclipses) the app showcases.
 * Meeus longitudes are ecliptic-of-date; the scene (like its star sphere) is
 * J2000, so accumulated precession is subtracted before the vector is built.
 */
export function computeMoonGeocentricEquatorialAU(jdTT: number, out: THREE.Vector3): THREE.Vector3 {
  const moon = moonPosition(jdTT);
  const lonRad = (moon.longitude - accumulatedPrecessionLonDeg(jdTT)) * DEG;
  const latRad = moon.latitude * DEG;
  const rAU = moon.distance / KM_PER_AU;
  const cosLat = Math.cos(latRad);
  // Scene ecliptic frame: +X at λ=0, +Y north, longitude increasing toward −Z.
  out.set(
    rAU * cosLat * Math.cos(lonRad),
    rAU * Math.sin(latRad),
    -rAU * cosLat * Math.sin(lonRad),
  );
  return out.applyMatrix4(ECLIPTIC_TO_EQUATORIAL);
}

/** Module scratch for the Meeus Sun record — consumed within the call below,
 *  never handed out, so the orbit sampler's Earth line allocates nothing. */
const sunScratch: SunPosition = { longitude: 0, distance: 0 };

/**
 * Heliocentric Earth in the scene's equatorial frame (AU): the Meeus
 * geocentric Sun mirrored through the origin — same distance, longitude
 * + 180°, latitude 0 — then precessed of-date → J2000 like the Moon seam.
 * Earth deliberately does NOT use its Standish EMB elements: deriving Earth
 * from the same Meeus theory as the Moon and the sunlight direction keeps
 * Sun–Earth–Moon exactly coherent (full moons render full, eclipse
 * alignments align to the theory's own accuracy), which beats one-model
 * uniformity. Earth's orbit line samples this function too, so nothing about
 * Earth rides the element tables or their epoch window; the Standish EMB row
 * survives as the independent cross-check in planetary.test.ts.
 */
export function computeEarthPositionEquatorial(
  jdTT: number,
  out?: THREE.Vector3,
): THREE.Vector3 {
  const sun = sunPosition(jdTT, sunScratch);
  const lonRad = (sun.longitude - accumulatedPrecessionLonDeg(jdTT)) * DEG;
  // Negated Sun vector in the λ→−Z ecliptic frame: −(d cos λ, 0, −d sin λ).
  const ecliptic = (out ?? new THREE.Vector3()).set(
    -sun.distance * Math.cos(lonRad),
    0,
    sun.distance * Math.sin(lonRad),
  );
  return ecliptic.applyMatrix4(ECLIPTIC_TO_EQUATORIAL);
}

/**
 * Which theory a body's rendered position comes from — the one place the
 * split is decided, so the position path and everything that reasons about
 * its validity can never disagree. Only Earth is Meeus; the rest propagate
 * Standish elements and inherit that fit's epoch window.
 */
function isMeeusPositioned(planet: PlanetData): boolean {
  return planet.name === 'Earth';
}

export function sampleOrbitLinePoints(el: KeplerElements, segments = 256): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    const eccentricAnomalyRad = (i / segments) * Math.PI * 2;
    const ecliptic = applyOrbitalOrientation(
      computeOrbitalPlanePosition(el, eccentricAnomalyRad),
      el,
    );
    points.push(eclipticToEquatorial(ecliptic));
  }
  return points;
}

const STANDISH_MIN_UTC_MS = utcMsAtTtJD(STANDISH_MIN_JD);
const STANDISH_MAX_UTC_MS = utcMsAtTtJD(STANDISH_MAX_JD);

/**
 * The period that spans one sampled line and spaces its vertices. Kepler's
 * third law from the catalog semi-major axis is plenty for placing a seam,
 * and sharing it is what keeps the sampler and the index math in step.
 */
function trajectoryPeriodMs(planet: PlanetData): number {
  return 365.25 * Math.pow(planet.semiMajorAxisAU, 1.5) * 86_400_000;
}

/**
 * The epoch a body's drawn position corresponds to. Standish positions freeze
 * where the tables stop, so past an edge the body stands at that edge's
 * position however far the clock runs on.
 */
function bodyEpochUtcMs(planet: PlanetData, utcMs: number): number {
  if (isMeeusPositioned(planet)) return utcMs;
  return Math.min(STANDISH_MAX_UTC_MS, Math.max(STANDISH_MIN_UTC_MS, utcMs));
}

/**
 * Keep a whole sampling period inside the epoch window the body's own theory
 * answers for. Standish freezes at its window's edges, so a period sampled
 * past one of them returns the same point over and over and the orbit line
 * collapses; pulling the center in by half a period draws the last true orbit
 * instead — and the body, frozen on that same edge, still sits on its line.
 * Earth is exempt: the Meeus seam it renders from has no such window.
 */
function clampLineEpochUtcMs(planet: PlanetData, centerUtcMs: number, periodMs: number): number {
  if (isMeeusPositioned(planet)) return centerUtcMs;
  const halfPeriodMs = periodMs / 2;
  return Math.min(
    STANDISH_MAX_UTC_MS - halfPeriodMs,
    Math.max(STANDISH_MIN_UTC_MS + halfPeriodMs, centerUtcMs),
  );
}

/**
 * Sample a body's actual rendered trajectory over one orbital period centered
 * on `centerUtcMs`. Because every sample goes through computeBodyPositionAU —
 * the renderer's own position seam — the line passes through the drawn body
 * by construction, which an osculating-element ellipse cannot guarantee:
 * Earth renders from the Meeus theory (≈1.4 R⊕ off its decorative EMB
 * ellipse), and the other bodies carry Standish secular terms the frozen
 * ellipse ignores. The strip's two ends meet half a period away from the
 * body, where the element drift accumulated over one period leaves a gap far
 * too small to see. The period only places that seam, so Kepler's third law
 * from the catalog semi-major axis is plenty. Past the element tables the
 * center slides back to the last epoch that holds a whole period (see
 * clampLineEpochUtcMs), so the line stays an orbit however far the clock runs.
 *
 * `out` is the caller's own point buffer, written in place and returned. A
 * chart that re-samples a line while the clock runs does it over and over, and
 * a fresh vector per sample puts that whole pass on the collector's account;
 * hand over an array already holding `segments + 1` vectors and it allocates
 * nothing. Short arrays are extended, long ones truncated, so the result is
 * always exactly the loop — and identical, sample for sample, to the
 * allocating call.
 */
export function sampleTrajectoryLinePoints(
  planet: PlanetData,
  centerUtcMs: number,
  segments: number,
  out?: THREE.Vector3[],
): THREE.Vector3[] {
  const periodMs = trajectoryPeriodMs(planet);
  const epochUtcMs = clampLineEpochUtcMs(planet, centerUtcMs, periodMs);
  const points: THREE.Vector3[] = out ?? [];
  for (let i = 0; i <= segments; i++) {
    const utcMs = epochUtcMs + (i / segments - 0.5) * periodMs;
    const held = points[i];
    if (held) computeBodyPositionAU(planet, utcMs, held);
    else points[i] = computeBodyPositionAU(planet, utcMs);
  }
  if (points.length > segments + 1) points.length = segments + 1;
  return points;
}

/**
 * Where the body sits along its own sampled line, as a fraction of the loop
 * in [0, 1) — sample i covers fraction i/segments. Anything body-anchored on
 * the line (a direction fade, a marker) must ask for this rather than assume
 * the body is at the middle sample: that only holds while the line's epoch
 * AND the body's are both inside the element tables. Past an edge the line
 * holds the last whole period it can sample while the body freezes on the
 * edge itself, which is an END of the strip — so the fraction pins there and
 * stops advancing, exactly as the drawn body does.
 */
export function trajectoryLineBodyFraction(
  planet: PlanetData,
  lineCenterUtcMs: number,
  utcMs: number,
): number {
  const periodMs = trajectoryPeriodMs(planet);
  const lineEpochUtcMs = clampLineEpochUtcMs(planet, lineCenterUtcMs, periodMs);
  const fraction = 0.5 + (bodyEpochUtcMs(planet, utcMs) - lineEpochUtcMs) / periodMs;
  return fraction - Math.floor(fraction);
}

/**
 * Frame contract: the scene is J2000 equatorial,
 * right-handed — +X vernal equinox, +Y celestial north, +Z = RA 270°; the
 * intermediate ecliptic frame runs longitude toward −Z. det = +1 throughout,
 * so cross products and spin senses are physically meaningful and the IAU
 * pole + W construction below gives the true absolute rotation phase (which
 * continents face the Sun at a UTC instant — pinned against GMST in
 * planetary.test.ts).
 *
 * The IAU prime-meridian reference is the node of the body's equator on the
 * J2000 Earth equator, at RA = poleRA + 90° (always perpendicular to the
 * pole, no degenerate case) — the same construction satellites.ts uses for
 * moon orbit frames. W is measured easterly from that node, which in this RH
 * frame is a +W rotation about the pole.
 */
function getBasePrimeDirection(planet: PlanetData, out?: THREE.Vector3): THREE.Vector3 {
  return raDecToVector(planet.poleRaDeg + 90, 0, 1, out);
}

// Scratch for the pole basis: the per-frame planet pass builds nine of these
// a frame, and the intermediates are consumed before the function returns.
const poleScratch = new THREE.Vector3();
const primeScratch = new THREE.Vector3();
const basisZScratch = new THREE.Vector3();
const basisScratch = new THREE.Matrix4();

function buildPoleBasisQuaternion(planet: PlanetData, primeMeridianDeg: number, out = new THREE.Quaternion()): THREE.Quaternion {
  const poleDirection = raDecToVector(planet.poleRaDeg, planet.poleDecDeg, 1, poleScratch).normalize();
  const primeDirection = getBasePrimeDirection(planet, primeScratch)
    .applyAxisAngle(poleDirection, primeMeridianDeg * DEG)
    .normalize();
  // Third basis column, prime×pole: holds *texture* longitude 90°W, not
  // geographic east (east = pole×prime = the −Z column's image). Only the
  // RH-ness of the basis matters here; the name is deliberately not "east".
  const basisZ = basisZScratch.crossVectors(primeDirection, poleDirection).normalize();

  const basis = basisScratch.makeBasis(primeDirection, poleDirection, basisZ);
  return out.setFromRotationMatrix(basis);
}

/** Pass `out` and the orientation is written into it rather than into a
 *  fresh quaternion; the math is the same either way. */
export function computeBodyOrientationQuaternion(planet: PlanetData, jd: number, out?: THREE.Quaternion): THREE.Quaternion {
  const daysSinceJ2000 = getDaysSinceJ2000(jd);
  const primeMeridianDeg =
    planet.primeMeridianDegAtJ2000 + planet.primeMeridianRateDegPerDay * daysSinceJ2000;
  return buildPoleBasisQuaternion(planet, primeMeridianDeg, out);
}

/**
 * Orientation of the body's equatorial frame without the daily spin.
 * Time-independent. (Moon positions propagate JPL element frames in
 * satellites.ts; this pins the pole/spin-axis split for orientation work.)
 */
export function computeBodyPoleQuaternion(planet: PlanetData): THREE.Quaternion {
  return buildPoleBasisQuaternion(planet, 0);
}

/**
 * The single heliocentric position path for every planetarium body — initial
 * scene construction and per-frame rebuilds both go through here, so the two
 * can never disagree. Earth dispatches to the Meeus seam (see
 * computeEarthPositionEquatorial for why); everything else is Standish.
 *
 * Pass `out` and the position is written into it rather than into a fresh
 * vector — the same optional zero-allocation seam projectToScreen offers, for
 * the callers that ask for a position every frame or hundreds of times inside
 * one. Nothing about the math changes with it.
 */
// One record the hot path re-propagates into on every call. Never handed out:
// computeKeplerPositionEquatorial consumes it before this function returns,
// and callers that want to HOLD elements go through getStandishElements
// themselves and receive a fresh record.
const elementsScratch = {} as import('./standish').KeplerElements;

export function computeBodyPositionAU(
  planet: PlanetData,
  utcMs: number,
  out?: THREE.Vector3,
): THREE.Vector3 {
  const jd = ttJDFromUtcMs(utcMs);
  return isMeeusPositioned(planet)
    ? computeEarthPositionEquatorial(jd, out)
    : computeKeplerPositionEquatorial(getStandishElements(planet.name, jd, elementsScratch), out);
}

export function computeBodyState(planet: PlanetData, utcMs: number): BodyState {
  return computeBodyStateInto(planet, utcMs, {
    positionAU: new THREE.Vector3(),
    orientationQuaternion: new THREE.Quaternion(),
    sunDirection: new THREE.Vector3(),
  });
}

/** The same state written into a caller-owned record: the per-frame planet
 *  pass asks for nine of these a frame and must not allocate for them. */
export function computeBodyStateInto(planet: PlanetData, utcMs: number, out: BodyState): BodyState {
  const jd = ttJDFromUtcMs(utcMs);
  computeBodyPositionAU(planet, utcMs, out.positionAU);
  computeBodyOrientationQuaternion(planet, jd, out.orientationQuaternion);
  out.sunDirection.copy(out.positionAU).multiplyScalar(-1).normalize();
  return out;
}

/** Advance the clock in place and hand the same record back: this runs every
 *  unpaused frame, and the seams that change rate or pause replace the record
 *  wholesale, so nothing relies on a fresh object here. */
export function advancePlanetariumTime(state: SimulationTime, dtSeconds: number): SimulationTime {
  if (state.paused) return state;
  // Saturate at the range a Date can hold: past it every ephemeris call is
  // NaN and the sky empties, and a save restored at the edge would get there
  // on its first running frame.
  state.currentUtcMs = Math.max(-MAX_UTC_MS, Math.min(MAX_UTC_MS, state.currentUtcMs + dtSeconds * 1000 * state.rate));
  return state;
}

/** The range a JS Date can hold, in ms from the epoch. */
export const MAX_UTC_MS = 8.64e15;

/**
 * Step the simulation rate along a signed ladder with a pause detent at zero:
 *
 *   −presets[last] … −presets[0] · paused · +presets[0] … +presets[last]
 *
 * `+1` always walks toward the future and `−1` toward the past — the bar's
 * −/+ and the ,/. keys are time-direction arrows, not magnitude knobs. So
 * stepping down through 1× rests at pause, and stepping down again starts
 * reverse; from pause the walk resumes at 1× in the pressed direction
 * whatever rate the pause stored. The shared core behind the time popover's
 * Slower/Faster and the surface transport strip's −/+. An off-ladder
 * magnitude snaps to the next larger preset before stepping.
 */
export function stepSimulationRate(
  state: SimulationTime,
  direction: -1 | 1,
  presets: readonly number[],
): SimulationTime {
  if (state.paused) {
    return { ...state, rate: direction * presets[0], paused: false };
  }
  const sign = state.rate < 0 ? -1 : 1;
  const currentMagnitude = Math.abs(state.rate);
  let index = presets.findIndex(rate => Math.abs(rate - currentMagnitude) < 1e-6);
  if (index === -1) {
    index = presets.findIndex(rate => rate > currentMagnitude);
    if (index === -1) index = presets.length - 1;
  }
  // On the reverse side the ladder runs mirrored: toward-the-past deepens the
  // magnitude, toward-the-future shrinks it.
  const next = index + (sign > 0 ? direction : -direction);
  if (next < 0) {
    // Walked down through 1×: rest at the pause detent, poised at 1× in the
    // direction just left so a plain resume continues it.
    return { ...state, rate: sign * presets[0], paused: true };
  }
  return {
    ...state,
    rate: sign * presets[Math.min(presets.length - 1, next)],
    paused: false,
  };
}

function formatUtcPart(value: number): string {
  return value.toString().padStart(2, '0');
}

const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export function formatUtcLabel(utcMs: number): string {
  const d = new Date(utcMs);
  return `${MONTH_SHORT[d.getUTCMonth()]} ${d.getUTCDate()} ${d.getUTCFullYear()}, ` +
    `${formatUtcPart(d.getUTCHours())}:${formatUtcPart(d.getUTCMinutes())}:${formatUtcPart(d.getUTCSeconds())} UTC`;
}

export function formatDateCompact(utcMs: number): string {
  const d = new Date(utcMs);
  return `${MONTH_SHORT[d.getUTCMonth()]} ${d.getUTCDate()} ${d.getUTCFullYear()}`;
}

export function formatUtcInputValue(utcMs: number): string {
  const date = new Date(utcMs);
  return `${date.getUTCFullYear()}-${formatUtcPart(date.getUTCMonth() + 1)}-${formatUtcPart(date.getUTCDate())}` +
    `T${formatUtcPart(date.getUTCHours())}:${formatUtcPart(date.getUTCMinutes())}`;
}

export function parseUtcInputValue(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const utcMs = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
  );
  return Number.isFinite(utcMs) ? utcMs : null;
}

/** Whole counts print bare ("1 wk/s"), fractional ones with one decimal
 *  ("1.4 wk/s") — a rounded-to-integer label would lie about off-ladder rates. */
function formatRateCount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function formatTimeRateLabel(rate: number, paused: boolean): string {
  if (paused) return 'Paused';
  const direction = rate < 0 ? 'Reverse ' : '';
  const magnitude = Math.abs(rate);
  if (magnitude === 1) return `${direction}Realtime`;
  if (magnitude < 60) return `${direction}${magnitude.toFixed(0)} sec/s`;
  if (magnitude < 3600) return `${direction}${(magnitude / 60).toFixed(0)} min/s`;
  if (magnitude < 86400) return `${direction}${(magnitude / 3600).toFixed(0)} hr/s`;
  if (magnitude < 604800) return `${direction}${(magnitude / 86400).toFixed(0)} day/s`;
  if (magnitude < 2592000) return `${direction}${formatRateCount(magnitude / 604800)} wk/s`;
  if (magnitude < 86400 * 365) return `${direction}${formatRateCount(magnitude / 2592000)} mo/s`;
  // Julian-year divisor: the ladder's top preset must read "1 yr/s" exactly,
  // matching its detent label.
  return `${direction}${formatRateCount(magnitude / 31557600)} yr/s`;
}

/**
 * The bar clock's adaptive readout: a unit is shown only while it ticks slowly
 * enough to read, so the string coarsens as the rate climbs — minutes up to
 * 1 min/s, whole hours up to 6 hr/s, the date up to 1 wk/s, then month + year
 * (the rolling month is the motion cue at the top of the ladder). The day is
 * zero-padded so a ticking clock never changes width mid-month.
 */
export function formatAdaptiveClock(
  utcMs: number,
  rateMagnitude: number,
): { date: string; time: string } {
  const d = new Date(utcMs);
  if (rateMagnitude > 604800) {
    return { date: `${MONTH_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`, time: '' };
  }
  const date = `${MONTH_SHORT[d.getUTCMonth()]} ${formatUtcPart(d.getUTCDate())} ${d.getUTCFullYear()}`;
  if (rateMagnitude > 21600) return { date, time: '' };
  if (rateMagnitude > 60) return { date, time: `${formatUtcPart(d.getUTCHours())}h` };
  return { date, time: `${formatUtcPart(d.getUTCHours())}:${formatUtcPart(d.getUTCMinutes())}` };
}
