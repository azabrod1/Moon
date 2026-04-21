/**
 * Moon-view lunar-orbit geometry: true/mean/eccentric anomaly conversions,
 * orbit-plane positions, and km-to-scene-unit distance helpers. Everything here
 * is for visualizing the Moon orbit in the Moon view — not general Kepler code.
 */
import * as THREE from 'three';
import { DEG2RAD, RAD2DEG } from '../shared/math/angles';
import { KM_CONSTANTS } from '../shared/constants/physicalData';
import { SCENE_UNITS } from '../shared/constants/sceneUnits';

const ORBIT_EPSILON = 1e-9;

export const LUNAR_ORBIT = {
  eccentricity: 0.0549,
  semiMajorAxisScene: SCENE_UNITS.EARTH_MOON_DIST,
  semiMajorAxisKm: KM_CONSTANTS.EARTH_MOON_DIST,
  siderealPeriodDays: KM_CONSTANTS.MOON_SIDEREAL_PERIOD_DAYS,
};

export function getLunarOrbitMetrics() {
  const eccentricity = LUNAR_ORBIT.eccentricity;
  const semiMajorAxisScene = LUNAR_ORBIT.semiMajorAxisScene;
  const semiMajorAxisKm = LUNAR_ORBIT.semiMajorAxisKm;
  const semiMinorAxisScene = semiMajorAxisScene * Math.sqrt(1 - eccentricity * eccentricity);
  const semiMinorAxisKm = semiMajorAxisKm * Math.sqrt(1 - eccentricity * eccentricity);
  const focalOffsetScene = semiMajorAxisScene * eccentricity;
  const focalOffsetKm = semiMajorAxisKm * eccentricity;
  const periapsisScene = semiMajorAxisScene * (1 - eccentricity);
  const apoapsisScene = semiMajorAxisScene * (1 + eccentricity);
  const periapsisKm = semiMajorAxisKm * (1 - eccentricity);
  const apoapsisKm = semiMajorAxisKm * (1 + eccentricity);

  return {
    eccentricity,
    semiMajorAxisScene,
    semiMinorAxisScene,
    focalOffsetScene,
    periapsisScene,
    apoapsisScene,
    semiMajorAxisKm,
    semiMinorAxisKm,
    focalOffsetKm,
    periapsisKm,
    apoapsisKm,
  };
}

export function normalizeDegrees(angleDeg: number): number {
  return ((angleDeg % 360) + 360) % 360;
}

export function meanMotionDegPerDay(): number {
  return 360 / LUNAR_ORBIT.siderealPeriodDays;
}

function normalizeRadians(angleRad: number): number {
  const fullTurn = Math.PI * 2;
  return ((angleRad % fullTurn) + fullTurn) % fullTurn;
}

export function trueAnomalyDegFromLongitude(longitudeDeg: number, nodeAngleDeg: number): number {
  return normalizeDegrees(longitudeDeg - nodeAngleDeg);
}

export function solveEccentricAnomaly(meanAnomalyRad: number, eccentricity: number): number {
  let estimate = meanAnomalyRad;
  for (let i = 0; i < 8; i++) {
    const f = estimate - eccentricity * Math.sin(estimate) - meanAnomalyRad;
    const fp = 1 - eccentricity * Math.cos(estimate);
    estimate -= f / Math.max(fp, ORBIT_EPSILON);
  }
  return estimate;
}

export function trueAnomalyDegFromMeanAnomaly(meanAnomalyDeg: number): number {
  const eccentricity = LUNAR_ORBIT.eccentricity;
  const meanAnomalyRad = normalizeDegrees(meanAnomalyDeg) * DEG2RAD;
  const eccentricAnomaly = solveEccentricAnomaly(meanAnomalyRad, eccentricity);
  const x = Math.cos(eccentricAnomaly) - eccentricity;
  const y = Math.sqrt(1 - eccentricity * eccentricity) * Math.sin(eccentricAnomaly);
  return normalizeDegrees(Math.atan2(y, x) * RAD2DEG);
}

export function meanAnomalyDegFromTrueAnomaly(trueAnomalyDeg: number): number {
  const eccentricity = LUNAR_ORBIT.eccentricity;
  const trueAnomalyRad = normalizeDegrees(trueAnomalyDeg) * DEG2RAD;
  const factor = Math.sqrt((1 - eccentricity) / (1 + eccentricity));
  const eccentricAnomaly =
    2 * Math.atan2(factor * Math.sin(trueAnomalyRad / 2), Math.cos(trueAnomalyRad / 2));
  const normalizedEccentricAnomaly = normalizeRadians(eccentricAnomaly);
  const meanAnomaly =
    normalizedEccentricAnomaly - eccentricity * Math.sin(normalizedEccentricAnomaly);
  return normalizeDegrees(meanAnomaly * RAD2DEG);
}

export function positionInOrbitPlaneFromTrueAnomaly(trueAnomalyDeg: number): THREE.Vector3 {
  const trueAnomalyRad = normalizeDegrees(trueAnomalyDeg) * DEG2RAD;
  const eccentricity = LUNAR_ORBIT.eccentricity;
  const semiMajorAxis = LUNAR_ORBIT.semiMajorAxisScene;
  const semiLatusRectum = semiMajorAxis * (1 - eccentricity * eccentricity);
  const radius = semiLatusRectum / (1 + eccentricity * Math.cos(trueAnomalyRad));

  return new THREE.Vector3(
    radius * Math.cos(trueAnomalyRad),
    0,
    radius * Math.sin(trueAnomalyRad),
  );
}

export function orbitDistanceKmFromTrueAnomaly(trueAnomalyDeg: number): number {
  const trueAnomalyRad = normalizeDegrees(trueAnomalyDeg) * DEG2RAD;
  const eccentricity = LUNAR_ORBIT.eccentricity;
  const semiMajorAxis = LUNAR_ORBIT.semiMajorAxisKm;
  const semiLatusRectum = semiMajorAxis * (1 - eccentricity * eccentricity);
  return semiLatusRectum / (1 + eccentricity * Math.cos(trueAnomalyRad));
}

export function positionInOrbitPlaneFromLongitude(longitudeDeg: number, nodeAngleDeg: number): THREE.Vector3 {
  return positionInOrbitPlaneFromTrueAnomaly(trueAnomalyDegFromLongitude(longitudeDeg, nodeAngleDeg));
}

export function orbitDistanceKmFromLongitude(longitudeDeg: number, nodeAngleDeg: number): number {
  return orbitDistanceKmFromTrueAnomaly(trueAnomalyDegFromLongitude(longitudeDeg, nodeAngleDeg));
}

export function longitudeDegFromMeanAnomaly(meanAnomalyDeg: number, nodeAngleDeg: number): number {
  return normalizeDegrees(nodeAngleDeg + trueAnomalyDegFromMeanAnomaly(meanAnomalyDeg));
}

export function createOrbitPoints(segments: number): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    const trueAnomalyDeg = (i / segments) * 360;
    points.push(positionInOrbitPlaneFromTrueAnomaly(trueAnomalyDeg));
  }
  return points;
}
