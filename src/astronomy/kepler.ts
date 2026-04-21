/**
 * Simple Keplerian orbital mechanics for computing planet positions at any date.
 * Uses mean orbital elements at J2000.0 epoch (JD 2451545.0).
 */

import type { PlanetData } from '../planetarium/planets/planetData';
import { DEG, J2000 } from './constants';

/**
 * Solve Kepler's equation: E = M + e*sin(E)
 * Newton-Raphson iteration, converges in 5 iterations for e < 0.25
 */
function solveKepler(M: number, e: number): number {
  let E = M; // initial guess
  for (let i = 0; i < 8; i++) {
    const dE = (M - (E - e * Math.sin(E))) / (1 - e * Math.cos(E));
    E += dE;
    if (Math.abs(dE) < 1e-10) break;
  }
  return E;
}

/**
 * Compute heliocentric position of a planet at a given Julian Day.
 * Returns position in AU on the ecliptic plane (y = 0).
 */
export function computePlanetPosition(
  planet: PlanetData,
  jd: number,
): { x: number; y: number; z: number } {
  const a = planet.semiMajorAxisAU;
  const e = planet.eccentricity;

  // Mean motion (degrees per day)
  const n = 360 / (planet.orbitalPeriodYears * 365.25);

  // Mean anomaly at date
  const M0 = (planet.meanLongitudeDeg - planet.lonPerihelionDeg) * DEG;
  const daysSinceJ2000 = jd - J2000;
  const M = M0 + n * DEG * daysSinceJ2000;

  // Solve Kepler's equation for eccentric anomaly
  const E = solveKepler(M, e);

  // True anomaly
  const cosE = Math.cos(E);
  const sinE = Math.sin(E);
  const trueAnomaly = Math.atan2(
    Math.sqrt(1 - e * e) * sinE,
    cosE - e,
  );

  // Distance from Sun
  const r = a * (1 - e * cosE);

  // Position in orbital plane, then rotate by longitude of perihelion
  const lonPeri = planet.lonPerihelionDeg * DEG;
  const angle = trueAnomaly + lonPeri;

  return {
    x: r * Math.cos(angle),
    y: 0,
    z: r * Math.sin(angle),
  };
}

/**
 * Convert a Date to Julian Day Number (UTC).
 */
export function dateToJD(date: Date): number {
  let y = date.getUTCFullYear();
  let m = date.getUTCMonth() + 1;
  const d =
    date.getUTCDate() +
    date.getUTCHours() / 24 +
    date.getUTCMinutes() / 1440 +
    date.getUTCSeconds() / 86400;

  if (m <= 2) {
    y -= 1;
    m += 12;
  }

  const A = Math.floor(y / 100);
  const B = 2 - A + Math.floor(A / 4);

  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + d + B - 1524.5;
}
