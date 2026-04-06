import * as THREE from 'three';
import type { PlanetData } from './planets/planetData';
import { dateToJD } from '../utils/ephemeris';

const DEG = Math.PI / 180;
const J2000 = 2451545.0;
const OBLIQUITY_DEG = 23.4392911;
const REFERENCE_NORTH = new THREE.Vector3(0, 1, 0);
const REFERENCE_PRIME = new THREE.Vector3(1, 0, 0);

const ECLIPTIC_TO_EQUATORIAL = new THREE.Matrix4().makeRotationX(-OBLIQUITY_DEG * DEG);

export interface ExploreTimeState {
  currentUtcMs: number;
  rate: number;
  paused: boolean;
}

export interface BodyState {
  positionAU: THREE.Vector3;
  orientationQuaternion: THREE.Quaternion;
  sunDirection: THREE.Vector3;
}

function normalizeRadians(value: number): number {
  const twoPi = Math.PI * 2;
  return ((value % twoPi) + twoPi) % twoPi;
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

function computeOrbitalPlanePosition(planet: PlanetData, eccentricAnomalyRad: number): THREE.Vector3 {
  const x = planet.semiMajorAxisAU * (Math.cos(eccentricAnomalyRad) - planet.eccentricity);
  const z =
    planet.semiMajorAxisAU *
    Math.sqrt(1 - planet.eccentricity * planet.eccentricity) *
    Math.sin(eccentricAnomalyRad);
  return new THREE.Vector3(x, 0, z);
}

function applyOrbitalOrientation(position: THREE.Vector3, planet: PlanetData): THREE.Vector3 {
  const argPerihelionRad = (planet.lonPerihelionDeg - planet.ascendingNodeDeg) * DEG;
  const inclinationRad = planet.inclinationDeg * DEG;
  const ascendingNodeRad = planet.ascendingNodeDeg * DEG;

  return position
    .clone()
    .applyAxisAngle(REFERENCE_NORTH, argPerihelionRad)
    .applyAxisAngle(new THREE.Vector3(1, 0, 0), inclinationRad)
    .applyAxisAngle(REFERENCE_NORTH, ascendingNodeRad);
}

export function eclipticToEquatorial(vector: THREE.Vector3): THREE.Vector3 {
  return vector.clone().applyMatrix4(ECLIPTIC_TO_EQUATORIAL);
}

export function utcMsToDate(utcMs: number): Date {
  return new Date(utcMs);
}

export function utcMsToJD(utcMs: number): number {
  return dateToJD(new Date(utcMs));
}

export function raDecToVector(raDeg: number, decDeg: number, radius = 1): THREE.Vector3 {
  const ra = raDeg * DEG;
  const dec = decDeg * DEG;
  const cosDec = Math.cos(dec);

  return new THREE.Vector3(
    radius * cosDec * Math.cos(ra),
    radius * Math.sin(dec),
    radius * cosDec * Math.sin(ra),
  );
}

export function computePlanetPositionEcliptic(planet: PlanetData, jd: number): THREE.Vector3 {
  const meanMotionRadPerDay = (Math.PI * 2) / (planet.orbitalPeriodYears * 365.25);
  const meanAnomalyAtJ2000Rad = (planet.meanLongitudeDeg - planet.lonPerihelionDeg) * DEG;
  const meanAnomalyRad = normalizeRadians(
    meanAnomalyAtJ2000Rad + meanMotionRadPerDay * getDaysSinceJ2000(jd),
  );
  const eccentricAnomalyRad = solveKepler(meanAnomalyRad, planet.eccentricity);
  return applyOrbitalOrientation(computeOrbitalPlanePosition(planet, eccentricAnomalyRad), planet);
}

export function computePlanetPositionEquatorial(planet: PlanetData, jd: number): THREE.Vector3 {
  return eclipticToEquatorial(computePlanetPositionEcliptic(planet, jd));
}

export function sampleOrbitLinePoints(planet: PlanetData, segments = 256): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    const eccentricAnomalyRad = (i / segments) * Math.PI * 2;
    const ecliptic = applyOrbitalOrientation(
      computeOrbitalPlanePosition(planet, eccentricAnomalyRad),
      planet,
    );
    points.push(eclipticToEquatorial(ecliptic));
  }
  return points;
}

function getBasePrimeDirection(poleDirection: THREE.Vector3): THREE.Vector3 {
  const ascendingNodeDirection = new THREE.Vector3().crossVectors(REFERENCE_NORTH, poleDirection);
  if (ascendingNodeDirection.lengthSq() < 1e-8) {
    return REFERENCE_PRIME.clone();
  }
  return ascendingNodeDirection.normalize();
}

export function computeBodyOrientationQuaternion(planet: PlanetData, jd: number): THREE.Quaternion {
  const poleDirection = raDecToVector(planet.poleRaDeg, planet.poleDecDeg).normalize();
  const daysSinceJ2000 = getDaysSinceJ2000(jd);
  const primeMeridianDeg =
    planet.primeMeridianDegAtJ2000 + planet.primeMeridianRateDegPerDay * daysSinceJ2000;

  const primeDirection = getBasePrimeDirection(poleDirection)
    .applyAxisAngle(poleDirection, primeMeridianDeg * DEG)
    .normalize();
  const eastDirection = new THREE.Vector3().crossVectors(primeDirection, poleDirection).normalize();

  const basis = new THREE.Matrix4().makeBasis(primeDirection, poleDirection, eastDirection);
  return new THREE.Quaternion().setFromRotationMatrix(basis);
}

export function computeBodyState(planet: PlanetData, utcMs: number): BodyState {
  const jd = utcMsToJD(utcMs);
  const positionAU = computePlanetPositionEquatorial(planet, jd);
  const orientationQuaternion = computeBodyOrientationQuaternion(planet, jd);
  const sunDirection = positionAU.clone().multiplyScalar(-1).normalize();

  return {
    positionAU,
    orientationQuaternion,
    sunDirection,
  };
}

export function advanceExploreTime(state: ExploreTimeState, dtSeconds: number): ExploreTimeState {
  if (state.paused) return state;
  return {
    ...state,
    currentUtcMs: state.currentUtcMs + dtSeconds * 1000 * state.rate,
  };
}

function formatUtcPart(value: number): string {
  return value.toString().padStart(2, '0');
}

export function formatUtcLabel(utcMs: number): string {
  const date = new Date(utcMs);
  return `${date.getUTCFullYear()}-${formatUtcPart(date.getUTCMonth() + 1)}-${formatUtcPart(date.getUTCDate())} ` +
    `${formatUtcPart(date.getUTCHours())}:${formatUtcPart(date.getUTCMinutes())}:${formatUtcPart(date.getUTCSeconds())} UTC`;
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

export function formatTimeRateLabel(rate: number, paused: boolean): string {
  if (paused) return 'Paused';
  const direction = rate < 0 ? 'Reverse ' : '';
  const magnitude = Math.abs(rate);
  if (magnitude === 1) return `${direction}1x real-time`;
  if (magnitude < 60) return `${direction}${magnitude.toFixed(0)} sec/s`;
  if (magnitude < 3600) return `${direction}${(magnitude / 60).toFixed(0)} min/s`;
  if (magnitude < 86400) return `${direction}${(magnitude / 3600).toFixed(0)} hr/s`;
  if (magnitude < 86400 * 365) return `${direction}${(magnitude / 86400).toFixed(0)} day/s`;
  return `${direction}${(magnitude / (86400 * 365)).toFixed(1)} yr/s`;
}
