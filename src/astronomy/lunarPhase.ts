/**
 * The Moon's phase as the scene draws it: its elongation, lit fraction and
 * phase name, and the instants of full and new moon, all from the positions
 * the scene draws (planetary.ts): the fitted Moon about Earth, and the Sun
 * seen from Earth where Earth is drawn, which carries the 20″ of aberration
 * the apparent longitudes of almanacs carry. So the phase the Observatory
 * names, the glyph it lights and the full moon it jumps to are the ones on
 * screen, to a fraction of a minute of the published instants.
 *
 * Full and new moon are the instants the apparent ecliptic longitudes of the
 * Moon and the Sun differ by 180° and 0°; the ecliptic here is J2000's, which
 * turns with the equinox but tilts by under 1″ a decade, so the difference of
 * the two longitudes is the same. The lit fraction uses the true phase angle
 * at the Moon (Meeus 48.3), not the longitude difference, which the Moon's
 * up-to-5° latitude would throw off near new moon.
 *
 * ephemeris.ts keeps the Meeus-only versions (its worked examples pin them);
 * nothing the Observatory shows reads them any more. Tested in
 * lunarPhase.test.ts against JPL Horizons and published phase times.
 */
import * as THREE from 'three';
import { computeEarthPositionEquatorial, computeMoonGeocentricEquatorialAU, ttJDFromUtcMs } from './planetary';
import { DEG, KM_PER_AU, OBLIQUITY_DEG } from './constants';

const EQUATORIAL_TO_ECLIPTIC = new THREE.Matrix4().makeRotationX(-OBLIQUITY_DEG * DEG);
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

export interface LunarPhase {
  /** Moon minus Sun in ecliptic longitude, −180…180: positive while waxing. */
  elongationDeg: number;
  /** Lit fraction of the disc seen from Earth's centre, 0…1. */
  illumination: number;
  phaseName: string;
  /** The Moon's ecliptic latitude, degrees. */
  moonLatitudeDeg: number;
  moonDistanceKm: number;
}

const sunScratch = new THREE.Vector3();
const moonScratch = new THREE.Vector3();
const sunEclipticScratch = new THREE.Vector3();
const moonEclipticScratch = new THREE.Vector3();

function wrapDegrees(degrees: number): number {
  const wrapped = ((degrees % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
}

/** Ecliptic longitude of a scene-frame vector: +X at 0°, increasing toward −Z
 *  in the scene's ecliptic frame (as planetary.ts builds it). */
function eclipticLongitudeDeg(eclipticVector: THREE.Vector3): number {
  return Math.atan2(-eclipticVector.z, eclipticVector.x) / DEG;
}

/** Geocentric Sun and Moon, scene AU, at a clock instant. */
function geocentricSunAndMoon(utcMs: number): { sun: THREE.Vector3; moon: THREE.Vector3 } {
  const jdTT = ttJDFromUtcMs(utcMs);
  const sun = computeEarthPositionEquatorial(jdTT, sunScratch).negate();
  const moon = computeMoonGeocentricEquatorialAU(jdTT, moonScratch);
  return { sun, moon };
}

/** Moon minus Sun in ecliptic longitude, −180…180. */
export function lunarElongationDeg(utcMs: number): number {
  const { sun, moon } = geocentricSunAndMoon(utcMs);
  const sunEcliptic = sunEclipticScratch.copy(sun).applyMatrix4(EQUATORIAL_TO_ECLIPTIC);
  const moonEcliptic = moonEclipticScratch.copy(moon).applyMatrix4(EQUATORIAL_TO_ECLIPTIC);
  return wrapDegrees(eclipticLongitudeDeg(moonEcliptic) - eclipticLongitudeDeg(sunEcliptic));
}

export function lunarPhaseAt(utcMs: number): LunarPhase {
  const { sun, moon } = geocentricSunAndMoon(utcMs);
  const moonEcliptic = moonEclipticScratch.copy(moon).applyMatrix4(EQUATORIAL_TO_ECLIPTIC);
  const sunEcliptic = sunEclipticScratch.copy(sun).applyMatrix4(EQUATORIAL_TO_ECLIPTIC);
  const elongationDeg = wrapDegrees(eclipticLongitudeDeg(moonEcliptic) - eclipticLongitudeDeg(sunEcliptic));
  // Meeus 48.3: the phase angle at the Moon from the geocentric elongation ψ.
  const sunDistance = sun.length();
  const moonDistance = moon.length();
  const elongation = sun.angleTo(moon);
  const phaseAngle = Math.atan2(sunDistance * Math.sin(elongation), moonDistance - sunDistance * Math.cos(elongation));
  const absoluteElongation = Math.abs(elongationDeg);
  let phaseName: string;
  if (absoluteElongation < 10) phaseName = 'New Moon';
  else if (absoluteElongation < 80) phaseName = elongationDeg > 0 ? 'Waxing Crescent' : 'Waning Crescent';
  else if (absoluteElongation < 100) phaseName = elongationDeg > 0 ? 'First Quarter' : 'Last Quarter';
  else if (absoluteElongation < 170) phaseName = elongationDeg > 0 ? 'Waxing Gibbous' : 'Waning Gibbous';
  else phaseName = 'Full Moon';
  return {
    elongationDeg,
    illumination: (1 + Math.cos(phaseAngle)) / 2,
    phaseName,
    moonLatitudeDeg: Math.asin(THREE.MathUtils.clamp(moonEcliptic.y / moonDistance, -1, 1)) / DEG,
    moonDistanceKm: moonDistance * KM_PER_AU,
  };
}

/**
 * The next (direction 1) or previous (−1) instant the elongation crosses
 * `targetDeg` (0 new moon, 180 full moon), within `maxDays`: 6-hour steps to
 * bracket the crossing, then bisection to a few milliseconds. Null if none.
 */
function findElongationCrossingMs(fromUtcMs: number, targetDeg: number, direction: 1 | -1, maxDays: number): number | null {
  const stepMs = direction * 6 * MS_PER_HOUR;
  const stepCount = Math.ceil((maxDays * MS_PER_DAY) / Math.abs(stepMs));
  const offsetAt = (utcMs: number) => wrapDegrees(lunarElongationDeg(utcMs) - targetDeg);
  let previousMs = fromUtcMs;
  let previousOffset = offsetAt(previousMs);
  for (let step = 1; step <= stepCount; step++) {
    const currentMs = previousMs + stepMs;
    const currentOffset = offsetAt(currentMs);
    // A sign change through zero, not a wrap through ±180.
    if (previousOffset * currentOffset < 0 && Math.abs(previousOffset - currentOffset) < 90) {
      let lowMs = previousMs;
      let highMs = currentMs;
      let lowOffset = previousOffset;
      for (let iteration = 0; iteration < 24; iteration++) {
        const middleMs = (lowMs + highMs) / 2;
        const middleOffset = offsetAt(middleMs);
        if (lowOffset * middleOffset < 0) highMs = middleMs;
        else {
          lowMs = middleMs;
          lowOffset = middleOffset;
        }
      }
      return Math.round((lowMs + highMs) / 2);
    }
    previousMs = currentMs;
    previousOffset = currentOffset;
  }
  return null;
}

/** The next or previous full or new moon from `fromUtcMs`, as drawn. */
export function findLunarPhaseEvent(type: 'full-moon' | 'new-moon', fromUtcMs: number, direction: 1 | -1): number | null {
  return findElongationCrossingMs(fromUtcMs, type === 'full-moon' ? 180 : 0, direction, 35);
}
