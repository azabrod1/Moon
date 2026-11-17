/**
 * The four solar eclipses of 2026–2028 against NASA's published greatest-
 * eclipse circumstances (Espenak, eclipse.gsfc.nasa.gov/SEbeselm/SEbeselm2001/
 * SE2026Aug12T, SE2027Feb06A, SE2027Aug02T, SE2028Jul22T; VSOP87 / ELP2000-85).
 * Two separate checks, so a failure says which half is wrong:
 *
 *  - the ephemeris: the instant the shadow axis passes closest to Earth's
 *    centre, in TD (each page's UT plus its own ΔT), and that distance, gamma,
 *    in Earth equatorial radii;
 *  - Earth's orientation and shape: where the axis meets the WGS 84 ellipsoid
 *    at NASA's instant, with the ephemeris at NASA's TD and the rotation at
 *    NASA's UT, against NASA's geodetic latitude and longitude.
 *
 * These pass only because Earth is drawn one Sun–Earth light time back
 * (planetary.ts computeEarthPositionEquatorial); geometric Earth and Moon put
 * every eclipse about 40 s late and 38 km off.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { computeBodyPositionAU, ttJDFromUtcMs } from './planetary';
import { computeMoonOffsetEquatorialAU } from './satellites';
import { earthOrientationQuaternion } from './earthOrientation';
import { ttMinusUtcSeconds } from './deltaT';
import { bodyFrameKmToGeodetic, rayEllipsoidDistanceKm, WGS84_EQUATORIAL_RADIUS_KM } from './earthShape';
import { KM_PER_AU } from './constants';
import { PLANETARIUM_BODIES } from '../planetarium/planets/planetData';

const earth = PLANETARIUM_BODIES.find((body) => body.name === 'Earth')!;

const NASA = [
  { label: '2026-08-12 total', greatestUt: '2026-08-12T17:45:53.8Z', deltaTSeconds: 71.4, latitudeDeg: 65 + 13.5 / 60, longitudeDeg: -(25 + 13.7 / 60), gamma: 0.8977 },
  { label: '2027-02-06 annular', greatestUt: '2027-02-06T15:59:35.7Z', deltaTSeconds: 71.6, latitudeDeg: -(31 + 18.2 / 60), longitudeDeg: -(48 + 28.1 / 60), gamma: -0.2952 },
  { label: '2027-08-02 total', greatestUt: '2027-08-02T10:06:37.7Z', deltaTSeconds: 71.7, latitudeDeg: 25 + 30.3 / 60, longitudeDeg: 33 + 11.0 / 60, gamma: 0.1421 },
  { label: '2028-07-22 total', greatestUt: '2028-07-22T02:55:26.9Z', deltaTSeconds: 72.1, latitudeDeg: -(15 + 34.4 / 60), longitudeDeg: 126 + 42.4 / 60, gamma: -0.6056 },
];

/** The clock instant whose TT, on the ms scale, is `ttMs`. */
function clockMsForTtMs(ttMs: number): number {
  let clockMs = ttMs - 69_184;
  for (let iteration = 0; iteration < 3; iteration++) clockMs = ttMs - ttMinusUtcSeconds(clockMs) * 1000;
  return clockMs;
}

function shadowAxisAt(clockMs: number) {
  const moonOffsetAU = computeMoonOffsetEquatorialAU('Moon', 'Earth', clockMs, new THREE.Vector3());
  const axis = computeBodyPositionAU(earth, clockMs, new THREE.Vector3()).add(moonOffsetAU).normalize();
  return { moonOffsetAU, axis };
}

/** Signed least distance of the axis from Earth's centre in equatorial radii,
 *  positive north. */
function gammaAt(clockMs: number): number {
  const { moonOffsetAU, axis } = shadowAxisAt(clockMs);
  const closest = moonOffsetAU.clone().addScaledVector(axis, -moonOffsetAU.dot(axis));
  return ((Math.sign(closest.y) || 1) * closest.length() * KM_PER_AU) / WGS84_EQUATORIAL_RADIUS_KM;
}

/** Least |gamma| within ±10 minutes: a 1 s scan, then 10 ms around its best. */
function greatestEclipseClockMs(aroundClockMs: number): number {
  let best = aroundClockMs;
  let bestMiss = Infinity;
  const scan = (fromMs: number, toMs: number, stepMs: number) => {
    for (let clockMs = fromMs; clockMs <= toMs; clockMs += stepMs) {
      const miss = Math.abs(gammaAt(clockMs));
      if (miss < bestMiss) {
        bestMiss = miss;
        best = clockMs;
      }
    }
  };
  scan(aroundClockMs - 600_000, aroundClockMs + 600_000, 1_000);
  scan(best - 1_000, best + 1_000, 10);
  return best;
}

function groundDistanceKm(latitudeA: number, longitudeA: number, latitudeB: number, longitudeB: number): number {
  const toRad = Math.PI / 180;
  const cosine =
    Math.sin(latitudeA * toRad) * Math.sin(latitudeB * toRad) +
    Math.cos(latitudeA * toRad) * Math.cos(latitudeB * toRad) * Math.cos((longitudeA - longitudeB) * toRad);
  return Math.acos(THREE.MathUtils.clamp(cosine, -1, 1)) * 6371;
}

describe('solar eclipses against NASA', () => {
  it.each(NASA)('$label: greatest eclipse within 3 s in TD, gamma within 3 km', (published) => {
    const publishedTtMs = Date.parse(published.greatestUt) + published.deltaTSeconds * 1000;
    const peakClockMs = greatestEclipseClockMs(clockMsForTtMs(publishedTtMs));
    const peakTtMs = peakClockMs + ttMinusUtcSeconds(peakClockMs) * 1000;
    expect(Math.abs(peakTtMs - publishedTtMs) / 1000).toBeLessThan(3);
    expect(Math.abs(gammaAt(peakClockMs) - published.gamma) * WGS84_EQUATORIAL_RADIUS_KM).toBeLessThan(3);
  });

  it.each(NASA)('$label: the centre of the shadow lands within 3 km of NASA\'s point', (published) => {
    const publishedUtMs = Date.parse(published.greatestUt);
    const clockAtPublishedTt = clockMsForTtMs(publishedUtMs + published.deltaTSeconds * 1000);
    const { moonOffsetAU, axis } = shadowAxisAt(clockAtPublishedTt);
    const toBody = earthOrientationQuaternion(publishedUtMs, ttJDFromUtcMs(clockAtPublishedTt), new THREE.Quaternion()).invert();
    const originKm = moonOffsetAU.clone().applyQuaternion(toBody).multiplyScalar(KM_PER_AU);
    const direction = axis.clone().applyQuaternion(toBody);
    const distanceKm = rayEllipsoidDistanceKm(originKm, direction);
    expect(distanceKm).not.toBeNull();
    const ground = bodyFrameKmToGeodetic(originKm.addScaledVector(direction, distanceKm!), {
      latitudeDeg: 0,
      longitudeDeg: 0,
      heightKm: 0,
    });
    expect(groundDistanceKm(ground.latitudeDeg, ground.longitudeDeg, published.latitudeDeg, published.longitudeDeg)).toBeLessThan(3);
  });
});
