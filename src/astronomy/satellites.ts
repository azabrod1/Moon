/**
 * Satellite (moon) ephemeris: propagates the generated JPL mean-element
 * records (satelliteElements.ts, regenerate via `npm run gen:moons`) and maps
 * them into the scene equatorial frame.
 *
 * Frame chain: elements live in the moon's own reference plane (J2000 ecliptic,
 * or a pole-defined plane — parent equator / local Laplace plane — with the
 * in-plane origin at the plane's ascending node on the ICRF equator, i.e. the
 * direction at RA pole+90°). The cached per-moon basis maps that frame straight
 * into the scene's equatorial embedding via raDecToVector/eclipticToEquatorial,
 * so a moon and its sky backdrop agree. Pinned by satellites.test.ts goldens.
 *
 * Earth's Moon propagates on the Meeus ephemeris, not these elements — the
 * name-keyed seam computeMoonOffsetEquatorialAU dispatches it to
 * computeMoonGeocentricEquatorialAU (planetary.ts) and everything else here.
 */
import * as THREE from 'three';
import { SATELLITE_ELEMENTS, type SatelliteElementsRecord } from './satelliteElements';
import {
  computeMoonGeocentricEquatorialAU,
  eclipticToEquatorial,
  raDecToVector,
  ttJDFromUtcMs,
} from './planetary';
import type { KeplerElements } from './standish';
import { DEG, KM_PER_AU } from './constants';

interface SatelliteFrameBasis {
  record: SatelliteElementsRecord;
  /** Scene images of the frame axes: A = in-plane origin (node of the
   *  reference plane on the ICRF equator), C = reference-plane pole,
   *  B = C×A — the scene embedding is a proper rotation, so cross products
   *  carry over directly (map(n̂×p̂) = map(n̂)×map(p̂)). */
  basisA: THREE.Vector3;
  basisB: THREE.Vector3;
  basisC: THREE.Vector3;
}

const frameCache = new Map<string, SatelliteFrameBasis>();

function getFrame(name: string): SatelliteFrameBasis {
  let frame = frameCache.get(name);
  if (frame) return frame;
  const record = SATELLITE_ELEMENTS[name];
  if (!record) throw new Error(`No satellite elements for "${name}"`);
  let basisA: THREE.Vector3;
  let basisC: THREE.Vector3;
  if (record.poleRaDeg === null || record.poleDecDeg === null) {
    // ecliptic rows: the plane's node on the ICRF equator is the equinox
    basisA = eclipticToEquatorial(new THREE.Vector3(1, 0, 0));
    basisC = eclipticToEquatorial(new THREE.Vector3(0, 1, 0));
  } else {
    basisA = raDecToVector(record.poleRaDeg + 90, 0);
    basisC = raDecToVector(record.poleRaDeg, record.poleDecDeg);
  }
  const basisB = new THREE.Vector3().crossVectors(basisC, basisA);
  frame = { record, basisA, basisB, basisC };
  frameCache.set(name, frame);
  return frame;
}

/**
 * Kepler solver (radians). Newton from E₀=M converges for the catalog's range
 * (max e = Nereid 0.751) but can diverge near e≈0.8 — seed E₀=π there.
 */
function solveKeplerRadians(meanAnomalyRad: number, eccentricity: number): number {
  let eccentricAnomaly = eccentricity < 0.8 ? meanAnomalyRad : Math.PI;
  for (let i = 0; i < 60; i++) {
    const delta =
      (eccentricAnomaly - eccentricity * Math.sin(eccentricAnomaly) - meanAnomalyRad) /
      (1 - eccentricity * Math.cos(eccentricAnomaly));
    eccentricAnomaly -= delta;
    if (Math.abs(delta) < 1e-13) break;
  }
  return eccentricAnomaly;
}

function wrapDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/**
 * Propagated elements in the moon's own reference frame. Note lonPerihelionDeg
 * is ϖ = ω(t)+Ω(t) built from the same propagated Ω(t) as ascendingNodeDeg —
 * consumers recover ω by subtraction. These are NOT scene-ecliptic elements;
 * use computeSatelliteOffsetEquatorialAU for positions.
 */
export function getSatelliteElements(name: string, jdTT: number): KeplerElements {
  const { record } = getFrame(name);
  const dt = jdTT - record.epochJdTdb;
  const omegaDeg = record.argPeriapsisAtEpochDeg + record.argPeriapsisRateDegPerDay * dt;
  const nodeDeg = record.ascendingNodeAtEpochDeg + record.ascendingNodeRateDegPerDay * dt;
  return {
    semiMajorAxisAU: record.aKm / KM_PER_AU,
    eccentricity: record.eccentricity,
    inclinationDeg: record.inclinationDeg,
    lonPerihelionDeg: omegaDeg + nodeDeg,
    ascendingNodeDeg: nodeDeg,
    meanAnomalyDeg: wrapDeg(record.meanAnomalyAtEpochDeg + record.meanAnomalyRateDegPerDay * dt),
  };
}

/**
 * Planetocentric offset of a moon in the scene equatorial frame (AU). (Not the
 * JPL table's "equatorial" reference plane — that is the parent's equator;
 * "Equatorial" here means the scene frame, as in computeMoonGeocentricEquatorialAU.)
 * Zero per-call allocations; runs per moon per frame. If `outOrbitNormal` is
 * given it receives the unit orbit normal (the tidal-lock roll reference).
 */
export function computeSatelliteOffsetEquatorialAU(
  name: string,
  jdTT: number,
  out: THREE.Vector3,
  outOrbitNormal?: THREE.Vector3,
): THREE.Vector3 {
  const { record, basisA, basisB, basisC } = getFrame(name);
  const dt = jdTT - record.epochJdTdb;
  const e = record.eccentricity;
  const omegaRad = (record.argPeriapsisAtEpochDeg + record.argPeriapsisRateDegPerDay * dt) * DEG;
  const nodeRad = (record.ascendingNodeAtEpochDeg + record.ascendingNodeRateDegPerDay * dt) * DEG;
  const meanAnomalyRad = wrapDeg(record.meanAnomalyAtEpochDeg + record.meanAnomalyRateDegPerDay * dt) * DEG;
  const eccentricAnomaly = solveKeplerRadians(meanAnomalyRad, e);
  const trueAnomaly = Math.atan2(
    Math.sqrt(1 - e * e) * Math.sin(eccentricAnomaly),
    Math.cos(eccentricAnomaly) - e,
  );
  const radiusAU = (record.aKm / KM_PER_AU) * (1 - e * Math.cos(eccentricAnomaly));
  const argLatitude = omegaRad + trueAnomaly;
  const cosNode = Math.cos(nodeRad);
  const sinNode = Math.sin(nodeRad);
  const cosIncl = Math.cos(record.inclinationDeg * DEG);
  const sinIncl = Math.sin(record.inclinationDeg * DEG);
  const cosArg = Math.cos(argLatitude);
  const sinArg = Math.sin(argLatitude);
  const x = radiusAU * (cosNode * cosArg - sinNode * sinArg * cosIncl);
  const y = radiusAU * (sinNode * cosArg + cosNode * sinArg * cosIncl);
  const z = radiusAU * sinArg * sinIncl;
  out.set(0, 0, 0).addScaledVector(basisA, x).addScaledVector(basisB, y).addScaledVector(basisC, z);
  if (outOrbitNormal) {
    outOrbitNormal
      .set(0, 0, 0)
      .addScaledVector(basisA, sinNode * sinIncl)
      .addScaledVector(basisB, -cosNode * sinIncl)
      .addScaledVector(basisC, cosIncl);
  }
  return out;
}

/** Apoapsis distance (AU) — sizes visibility/landing thresholds so eccentric
 *  moons (Neso e≈0.46) stay reachable at apoapsis. */
export function getSatelliteApoapsisAU(name: string): number {
  const { record } = getFrame(name);
  return (record.aKm / KM_PER_AU) * (1 + record.eccentricity);
}

/** Orbit shape/rate summary for search heuristics (shadow-engine season
 *  prefilter and step sizing) — not a positions API. */
export interface SatelliteOrbitMeta {
  semiMajorAxisKm: number;
  eccentricity: number;
  /** Anomalistic-ish period from the calibrated mean-anomaly rate. */
  periodDays: number;
  /** |Ω̇|, the node-precession rate — bounds how fast the orbit plane drifts. */
  nodeRateDegPerDay: number;
  /** Inclination to the moon's own reference plane (the precession cone half-angle). */
  inclinationDeg: number;
}

export function getSatelliteOrbitMeta(name: string): SatelliteOrbitMeta {
  const { record } = getFrame(name);
  return {
    semiMajorAxisKm: record.aKm,
    eccentricity: record.eccentricity,
    periodDays: 360 / Math.abs(record.meanAnomalyRateDegPerDay),
    nodeRateDegPerDay: Math.abs(record.ascendingNodeRateDegPerDay),
    inclinationDeg: record.inclinationDeg,
  };
}

/** Same shape for Earth's Moon (mean lunar orbit; Meeus serves positions). */
export const EARTH_MOON_ORBIT_META: SatelliteOrbitMeta = {
  semiMajorAxisKm: 384_400,
  eccentricity: 0.0549,
  periodDays: 27.321661,
  nodeRateDegPerDay: 0.0529539, // 18.6-year node regression
  inclinationDeg: 5.145, // to the ecliptic
};

// Finite-difference baseline for the Earth-Moon orbit normal: long enough to
// be numerically clean, far shorter than anything that bends the orbit.
const MOON_NORMAL_STEP_DAYS = 0.25;
const tmpNormalA = new THREE.Vector3();
const tmpNormalB = new THREE.Vector3();

/**
 * Planetocentric offset of ANY catalog moon in the scene equatorial frame
 * (AU), keyed by name — the single position seam shared by the renderer
 * (PlanetariumMode.getMoonWorldOffsetAU) and the shadow engine, so an event
 * the engine finds is an event the renderer shows. Earth's Moon → Meeus;
 * everything else → the JPL mean elements above.
 *
 * `outOrbitNormal` receives the actual orbit normal. For Earth's Moon that is
 * the true 5.1°-tilted normal from a finite difference of two Meeus samples:
 * L ≈ r(t) × r(t+dt), pointing north in the scene's proper (det +1) frame.
 */
export function computeMoonOffsetEquatorialAU(
  moonName: string,
  parentPlanetName: string,
  utcMs: number,
  out: THREE.Vector3,
  outOrbitNormal?: THREE.Vector3,
): THREE.Vector3 {
  if (moonName === 'Moon' && parentPlanetName === 'Earth') {
    const jdTT = ttJDFromUtcMs(utcMs);
    computeMoonGeocentricEquatorialAU(jdTT, out);
    if (outOrbitNormal) {
      tmpNormalA.copy(out);
      computeMoonGeocentricEquatorialAU(jdTT + MOON_NORMAL_STEP_DAYS, tmpNormalB);
      outOrbitNormal.crossVectors(tmpNormalA, tmpNormalB).normalize();
    }
    return out;
  }
  return computeSatelliteOffsetEquatorialAU(moonName, ttJDFromUtcMs(utcMs), out, outOrbitNormal);
}
