/**
 * The positions the app drew before the fitted ephemeris, reproduced exactly,
 * for one job: moving a journey saved by that build onto today's positions
 * (planetarium/saveAnchor.ts). Nothing draws with them.
 *
 * That build (main up to commit bfa845e) turned the clock into TT with the
 * Espenak–Meeus ΔT read at the middle of the date's month; placed Earth from
 * the apparent Meeus Sun (aberration and nutation both in); drew Earth's Moon
 * from the truncated Meeus series; and the planets from Standish elements.
 * Moons other than Earth's came from the bare mean elements, read at that TT,
 * which today's seam corrects (moonCorrections.ts). Against today's positions
 * it had the Moon up to 210 km, Titan up to 100,000 km and Jupiter up to
 * 2 million km away, so a ship it saved beside a body resumes beside that
 * body only if it is moved with it.
 *
 * Pinned to that build's own output in legacyPositions.test.ts.
 */
import * as THREE from 'three';
import { dateToJD, moonPosition, sunPosition } from './ephemeris';
import { decimalYearFromDate, deltaTSeconds } from './deltaT';
import { accumulatedPrecessionLonDeg } from './precession';
import { getStandishElements } from './standish';
import { computeKeplerPositionEquatorial, eclipticToEquatorial } from './planetary';
import { computeSatelliteOffsetEquatorialAU } from './satellites';
import { DEG, KM_PER_AU } from './constants';
import type { PlanetData } from '../planetarium/planets/planetData';

/** That build's TT Julian Date for a clock instant. */
export function legacyTtJd(utcMs: number): number {
  const date = new Date(utcMs);
  return dateToJD(date) + deltaTSeconds(decimalYearFromDate(date)) / 86_400;
}

/** Where that build drew a planet, heliocentric, scene AU. */
export function legacyPlanetPositionAU(planet: PlanetData, utcMs: number, out: THREE.Vector3): THREE.Vector3 {
  const jd = legacyTtJd(utcMs);
  if (planet.name === 'Earth') {
    const sun = sunPosition(jd);
    const lonRad = (sun.longitude - accumulatedPrecessionLonDeg(jd)) * DEG;
    return out.copy(
      eclipticToEquatorial(new THREE.Vector3(-sun.distance * Math.cos(lonRad), 0, sun.distance * Math.sin(lonRad))),
    );
  }
  return computeKeplerPositionEquatorial(getStandishElements(planet.name, jd), out);
}

/** Where that build drew a moon relative to its planet, scene AU. */
export function legacyMoonOffsetAU(moonName: string, parentName: string, utcMs: number, out: THREE.Vector3): THREE.Vector3 {
  const jd = legacyTtJd(utcMs);
  if (moonName === 'Moon' && parentName === 'Earth') {
    const moon = moonPosition(jd);
    const lonRad = (moon.longitude - accumulatedPrecessionLonDeg(jd)) * DEG;
    const latRad = moon.latitude * DEG;
    const distanceAU = moon.distance / KM_PER_AU;
    const cosLatitude = Math.cos(latRad);
    return out.copy(
      eclipticToEquatorial(
        new THREE.Vector3(
          distanceAU * cosLatitude * Math.cos(lonRad),
          distanceAU * Math.sin(latRad),
          -distanceAU * cosLatitude * Math.sin(lonRad),
        ),
      ),
    );
  }
  // The bare elements, which have not changed, at that build's TT.
  return computeSatelliteOffsetEquatorialAU(moonName, jd, out);
}
