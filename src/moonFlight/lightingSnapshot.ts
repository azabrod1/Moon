import * as THREE from 'three';
import { dateToJD, moonPosition, sunPosition } from '../astronomy/ephemeris';
import { KM_CONSTANTS } from '../shared/constants/physicalData';

/**
 * Frozen lighting / sky geometry as seen from the Moon at a single instant.
 *
 * We snapshot once on flight-mode entry and treat it as fixed for the session.
 * The Moon orbits Earth in ~27 days, so within a 7-minute descent the sun and
 * earth directions change by fractions of a degree — invisible in practice.
 *
 * Frame convention: a right-handed Moon-centered ecliptic frame where
 *   +X = vernal equinox direction (ecliptic longitude 0)
 *   +Z = ecliptic north
 * Distances are kilometres. Directions are unit vectors.
 */
export interface LightingSnapshot {
  /** Unit vector from Moon toward the Sun. */
  sunDir: THREE.Vector3;
  /** Unit vector from Moon toward Earth. */
  earthDir: THREE.Vector3;
  /** Distance Moon → Earth (km). */
  earthDistanceKm: number;
  /** Distance Moon → Sun (km). */
  sunDistanceKm: number;
  /**
   * Illuminated fraction of Earth as seen from the Moon (0..1).
   * Near full moon on Earth ↔ near new earth as seen from Moon.
   */
  earthPhaseFrac: number;
  /** Date used for the snapshot. */
  date: Date;
}

const AU_KM = 149_597_870.7;

function eclipticToCartesian(longDeg: number, latDeg: number, distance: number): THREE.Vector3 {
  const lon = (longDeg * Math.PI) / 180;
  const lat = (latDeg * Math.PI) / 180;
  const cb = Math.cos(lat);
  return new THREE.Vector3(distance * cb * Math.cos(lon), distance * cb * Math.sin(lon), distance * Math.sin(lat));
}

export function snapshotLighting(date: Date): LightingSnapshot {
  const jd = dateToJD(date);
  const sun = sunPosition(jd);
  const moon = moonPosition(jd);

  // Sun: ecliptic longitude only (latitude ≈ 0 by definition of ecliptic).
  // Positions are geocentric; Earth is at origin of this intermediate frame.
  const sunGeocentricKm = eclipticToCartesian(sun.longitude, 0, sun.distance * AU_KM);
  const moonGeocentricKm = eclipticToCartesian(moon.longitude, moon.latitude, moon.distance);

  // Translate to Moon-centric: subtract Moon's geocentric position.
  const sunFromMoon = sunGeocentricKm.clone().sub(moonGeocentricKm);
  const earthFromMoon = moonGeocentricKm.clone().negate();

  const sunDistanceKm = sunFromMoon.length();
  const earthDistanceKm = earthFromMoon.length();

  const sunDir = sunFromMoon.clone().divideScalar(sunDistanceKm);
  const earthDir = earthFromMoon.clone().divideScalar(earthDistanceKm);

  // Earth phase as seen from Moon.
  // Phase angle φ at Earth = angle Sun-Earth-Moon, i.e. angle between
  // (Sun from Earth) and (Moon from Earth). Illuminated fraction seen from
  // Moon = (1 + cos(φ)) / 2 when light source is Sun.
  const sunFromEarth = sunGeocentricKm.clone().normalize();
  const moonFromEarth = moonGeocentricKm.clone().normalize();
  const cosPhase = THREE.MathUtils.clamp(sunFromEarth.dot(moonFromEarth), -1, 1);
  const earthPhaseFrac = (1 + cosPhase) / 2;

  return {
    sunDir,
    earthDir,
    earthDistanceKm,
    sunDistanceKm,
    earthPhaseFrac,
    date: new Date(date.getTime()),
  };
}

/** Apparent angular diameter (radians) of a sphere of given radius at given distance. */
export function angularDiameterRad(radiusKm: number, distanceKm: number): number {
  return 2 * Math.atan(radiusKm / distanceKm);
}

export const EARTH_RADIUS_KM = KM_CONSTANTS.EARTH_RADIUS;
export const SUN_RADIUS_KM = KM_CONSTANTS.SUN_RADIUS;
export const MOON_RADIUS_KM = KM_CONSTANTS.MOON_RADIUS;
