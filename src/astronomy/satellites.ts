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
 * Earth's Moon is NOT served here — it stays on the Meeus ephemeris
 * (computeMoonGeocentricEquatorialAU in planetary.ts).
 */
import * as THREE from 'three';
import { SATELLITE_ELEMENTS, type SatelliteElementsRecord } from './satelliteElements';
import { eclipticToEquatorial, raDecToVector } from './planetary';
import type { KeplerElements } from './standish';
import { DEG, KM_PER_AU } from './constants';

interface SatelliteFrameBasis {
  record: SatelliteElementsRecord;
  /** Scene images of the frame axes: A = in-plane origin (node of the
   *  reference plane on the ICRF equator), C = reference-plane pole,
   *  B = A×C — the det(−1) scene embedding flips the handedness of the
   *  third axis (map(p̂×n̂) = map(n̂)×map(p̂)). */
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
  const basisB = new THREE.Vector3().crossVectors(basisA, basisC);
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
