/**
 * Planet-position math for the Planetarium: Kepler solver, element-to-vector
 * transforms in the scene's J2000 frame, the Meeus Earth/Moon seams, and the
 * shared simulation time type. Elements come from the Standish provider
 * (standish.ts); Earth's render position alone stays Meeus-derived. Consumed
 * by the Planetarium world and nav controllers.
 */
import * as THREE from 'three';
import { SUN_DATA, type PlanetData } from '../planetarium/planets/planetData';
import { dateToJD, moonPosition, sunPosition } from './ephemeris';
import { deltaTDaysAtDate } from './deltaT';
import { accumulatedPrecessionLonDeg } from './precession';
import { getStandishElements, type KeplerElements } from './standish';
import { DEG, J2000, KM_PER_AU, OBLIQUITY_DEG } from './constants';

const REFERENCE_NORTH = new THREE.Vector3(0, 1, 0);

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

function computeOrbitalPlanePosition(el: KeplerElements, eccentricAnomalyRad: number): THREE.Vector3 {
  const x = el.semiMajorAxisAU * (Math.cos(eccentricAnomalyRad) - el.eccentricity);
  const yInPlane =
    el.semiMajorAxisAU *
    Math.sqrt(1 - el.eccentricity * el.eccentricity) *
    Math.sin(eccentricAnomalyRad);
  // Scene ecliptic frame: longitude increases toward −Z, so the textbook
  // in-plane (x, y) lands at (x, 0, −y).
  return new THREE.Vector3(x, 0, -yInPlane);
}

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
    .clone()
    .applyAxisAngle(REFERENCE_NORTH, argPerihelionRad)
    .applyAxisAngle(new THREE.Vector3(1, 0, 0), inclinationRad)
    .applyAxisAngle(REFERENCE_NORTH, ascendingNodeRad);
}

export function eclipticToEquatorial(vector: THREE.Vector3): THREE.Vector3 {
  return vector.clone().applyMatrix4(ECLIPTIC_TO_EQUATORIAL);
}

/** TT Julian Day from civil UTC ms — what ephemeris/rotation theories expect. */
export function ttJDFromUtcMs(utcMs: number): number {
  const date = new Date(utcMs);
  return dateToJD(date) + deltaTDaysAtDate(date);
}

/**
 * THE chirality definition site: J2000 equatorial RA/Dec → scene vector via
 * the proper rotation (x, z, −y) — +X = vernal equinox (RA 0), +Y = celestial
 * north, +Z = RA 270°. det = +1, so the rendered sky has real-world chirality.
 * Every scene embedding of sky coordinates must route through here.
 */
export function raDecToVector(raDeg: number, decDeg: number, radius = 1): THREE.Vector3 {
  const ra = raDeg * DEG;
  const dec = decDeg * DEG;
  const cosDec = Math.cos(dec);

  return new THREE.Vector3(
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
export function computeKeplerPositionEcliptic(el: KeplerElements): THREE.Vector3 {
  const eccentricAnomalyRad = solveKepler(el.meanAnomalyDeg * DEG, el.eccentricity);
  return applyOrbitalOrientation(computeOrbitalPlanePosition(el, eccentricAnomalyRad), el);
}

export function computeKeplerPositionEquatorial(el: KeplerElements): THREE.Vector3 {
  return eclipticToEquatorial(computeKeplerPositionEcliptic(el));
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

/**
 * Heliocentric Earth in the scene's equatorial frame (AU): the Meeus
 * geocentric Sun mirrored through the origin — same distance, longitude
 * + 180°, latitude 0 — then precessed of-date → J2000 like the Moon seam.
 * Earth deliberately does NOT use its Standish EMB elements: deriving Earth
 * from the same Meeus theory as the Moon and the sunlight direction keeps
 * Sun–Earth–Moon exactly coherent (full moons render full, eclipse
 * alignments align to the theory's own accuracy), which beats one-model
 * uniformity. The Standish EMB row still draws Earth's decorative orbit line
 * and cross-checks this function in planetary.test.ts.
 */
export function computeEarthPositionEquatorial(jdTT: number): THREE.Vector3 {
  const sun = sunPosition(jdTT);
  const lonRad = (sun.longitude - accumulatedPrecessionLonDeg(jdTT)) * DEG;
  // Negated Sun vector in the λ→−Z ecliptic frame: −(d cos λ, 0, −d sin λ).
  const ecliptic = new THREE.Vector3(
    -sun.distance * Math.cos(lonRad),
    0,
    sun.distance * Math.sin(lonRad),
  );
  return ecliptic.applyMatrix4(ECLIPTIC_TO_EQUATORIAL);
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
 * from the catalog semi-major axis is plenty.
 */
export function sampleTrajectoryLinePoints(
  planet: PlanetData,
  centerUtcMs: number,
  segments: number,
): THREE.Vector3[] {
  const periodMs = 365.25 * Math.pow(planet.semiMajorAxisAU, 1.5) * 86_400_000;
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    points.push(computeBodyPositionAU(planet, centerUtcMs + (i / segments - 0.5) * periodMs));
  }
  return points;
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
/** The IAU pole + prime-meridian fields the orientation construction needs —
 *  every planet has them, and SUN_DATA carries the same quartet. */
export type BodyRotationModel = Pick<
  PlanetData,
  'poleRaDeg' | 'poleDecDeg' | 'primeMeridianDegAtJ2000' | 'primeMeridianRateDegPerDay'
>;

function getBasePrimeDirection(planet: BodyRotationModel): THREE.Vector3 {
  return raDecToVector(planet.poleRaDeg + 90, 0);
}

function buildPoleBasisQuaternion(planet: BodyRotationModel, primeMeridianDeg: number): THREE.Quaternion {
  const poleDirection = raDecToVector(planet.poleRaDeg, planet.poleDecDeg).normalize();
  const primeDirection = getBasePrimeDirection(planet)
    .applyAxisAngle(poleDirection, primeMeridianDeg * DEG)
    .normalize();
  // Third basis column, prime×pole: holds *texture* longitude 90°W, not
  // geographic east (east = pole×prime = the −Z column's image). Only the
  // RH-ness of the basis matters here; the name is deliberately not "east".
  const basisZ = new THREE.Vector3().crossVectors(primeDirection, poleDirection).normalize();

  const basis = new THREE.Matrix4().makeBasis(primeDirection, poleDirection, basisZ);
  return new THREE.Quaternion().setFromRotationMatrix(basis);
}

export function computeBodyOrientationQuaternion(planet: BodyRotationModel, jd: number): THREE.Quaternion {
  const daysSinceJ2000 = getDaysSinceJ2000(jd);
  const primeMeridianDeg =
    planet.primeMeridianDegAtJ2000 + planet.primeMeridianRateDegPerDay * daysSinceJ2000;
  return buildPoleBasisQuaternion(planet, primeMeridianDeg);
}

/**
 * Solar orientation from the same IAU pole + W construction as the planets
 * (SUN_DATA carries the WGCCRE Carrington model). The photosphere shader's
 * active regions, filaments, and prominence anchors all live in object
 * space, so this one quaternion carries the whole surface weather across
 * the disc — invisible at 1×, alive under time warp.
 */
export function computeSunOrientationQuaternion(utcMs: number): THREE.Quaternion {
  return computeBodyOrientationQuaternion(SUN_DATA, ttJDFromUtcMs(utcMs));
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
 */
export function computeBodyPositionAU(planet: PlanetData, utcMs: number): THREE.Vector3 {
  const jd = ttJDFromUtcMs(utcMs);
  return planet.name === 'Earth'
    ? computeEarthPositionEquatorial(jd)
    : computeKeplerPositionEquatorial(getStandishElements(planet.name, jd));
}

export function computeBodyState(planet: PlanetData, utcMs: number): BodyState {
  const jd = ttJDFromUtcMs(utcMs);
  const positionAU = computeBodyPositionAU(planet, utcMs);
  const orientationQuaternion = computeBodyOrientationQuaternion(planet, jd);
  const sunDirection = positionAU.clone().multiplyScalar(-1).normalize();

  return {
    positionAU,
    orientationQuaternion,
    sunDirection,
  };
}

export function advancePlanetariumTime(state: SimulationTime, dtSeconds: number): SimulationTime {
  if (state.paused) return state;
  return {
    ...state,
    currentUtcMs: state.currentUtcMs + dtSeconds * 1000 * state.rate,
  };
}

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
