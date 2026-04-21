/**
 * Simplified astronomical ephemeris based on Jean Meeus's "Astronomical Algorithms".
 * Computes Sun and Moon ecliptic longitude, latitude, and distance for any date.
 * Accuracy: ~1° for Moon longitude, ~0.5° for Sun longitude — sufficient for
 * phase/eclipse visualization.
 */

import { DEG, RAD } from './constants';

/** Julian Day Number from a Date object (UTC). */
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

/** Centuries since J2000.0 epoch. */
function T(jd: number): number {
  return (jd - 2451545.0) / 36525.0;
}

/** Normalize angle to 0..360. */
function norm360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Normalize angle to -180..180. */
function norm180(deg: number): number {
  let v = ((deg % 360) + 360) % 360;
  if (v > 180) v -= 360;
  return v;
}

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;

export interface SunPosition {
  longitude: number;  // ecliptic longitude (degrees)
  distance: number;   // AU
}

/**
 * Low-precision Sun position (Meeus Ch. 25, simplified).
 * Good to ~0.01° longitude.
 */
export function sunPosition(jd: number): SunPosition {
  const t = T(jd);

  // Geometric mean longitude (degrees)
  const L0 = norm360(280.46646 + 36000.76983 * t + 0.0003032 * t * t);

  // Mean anomaly (degrees)
  const M = norm360(357.52911 + 35999.05029 * t - 0.0001537 * t * t);
  const Mrad = M * DEG;

  // Equation of center
  const C =
    (1.914602 - 0.004817 * t - 0.000014 * t * t) * Math.sin(Mrad) +
    (0.019993 - 0.000101 * t) * Math.sin(2 * Mrad) +
    0.000289 * Math.sin(3 * Mrad);

  // Sun's true longitude
  const trueLon = norm360(L0 + C);

  // Sun's apparent longitude (nutation correction)
  const omega = 125.04 - 1934.136 * t;
  const apparentLon = trueLon - 0.00569 - 0.00478 * Math.sin(omega * DEG);

  // Distance in AU
  const e = 0.016708634 - 0.000042037 * t - 0.0000001267 * t * t;
  const trueAnomaly = (M + C) * DEG;
  const R = (1.000001018 * (1 - e * e)) / (1 + e * Math.cos(trueAnomaly));

  return {
    longitude: norm360(apparentLon),
    distance: R,
  };
}

export interface MoonPosition {
  longitude: number;   // ecliptic longitude (degrees)
  latitude: number;    // ecliptic latitude (degrees)
  distance: number;    // km
  ascending_node: number;  // longitude of ascending node (degrees)
}

/**
 * Simplified Moon position (Meeus Ch. 47, reduced terms).
 * Uses the main periodic terms for longitude, latitude, and distance.
 * Accuracy: ~1° longitude, ~0.5° latitude.
 */
export function moonPosition(jd: number): MoonPosition {
  const t = T(jd);

  // Fundamental arguments (degrees)
  // L' — Moon's mean longitude
  const Lp = norm360(
    218.3165 + 481267.8813 * t -
    0.0016 * t * t + t * t * t / 538841 - t * t * t * t / 65194000
  );

  // D — Mean elongation
  const D = norm360(
    297.8502 + 445267.1115 * t -
    0.0019 * t * t + t * t * t / 545868 - t * t * t * t / 113065000
  );

  // M — Sun's mean anomaly
  const M = norm360(
    357.5291 + 35999.0503 * t -
    0.0002 * t * t - t * t * t / 300000
  );

  // M' — Moon's mean anomaly
  const Mp = norm360(
    134.9634 + 477198.8676 * t +
    0.0090 * t * t + t * t * t / 69699 - t * t * t * t / 14712000
  );

  // F — Moon's argument of latitude
  const F = norm360(
    93.2721 + 483202.0175 * t -
    0.0036 * t * t - t * t * t / 3526000 + t * t * t * t / 863310000
  );

  // Longitude of ascending node
  const omega = norm360(
    125.0446 - 1934.1363 * t +
    0.0021 * t * t + t * t * t / 467441 - t * t * t * t / 60616000
  );

  // Convert to radians for trig
  const Dr = D * DEG;
  const Mr = M * DEG;
  const Mpr = Mp * DEG;
  const Fr = F * DEG;

  // Longitude terms (main periodic terms from Meeus Table 47.A)
  let sumL = 0;
  sumL += 6288774 * Math.sin(Mpr);                         // M'
  sumL += 1274027 * Math.sin(2 * Dr - Mpr);                // 2D - M'
  sumL += 658314 * Math.sin(2 * Dr);                       // 2D
  sumL += 213618 * Math.sin(2 * Mpr);                      // 2M'
  sumL += -185116 * Math.sin(Mr);                           // M (E correction simplified)
  sumL += -114332 * Math.sin(2 * Fr);                       // 2F
  sumL += 58793 * Math.sin(2 * Dr - 2 * Mpr);              // 2D - 2M'
  sumL += 57066 * Math.sin(2 * Dr - Mr - Mpr);             // 2D - M - M'
  sumL += 53322 * Math.sin(2 * Dr + Mpr);                  // 2D + M'
  sumL += 45758 * Math.sin(2 * Dr - Mr);                   // 2D - M
  sumL += -40923 * Math.sin(Mr - Mpr);                     // M - M'
  sumL += -34720 * Math.sin(Dr);                            // D
  sumL += -30383 * Math.sin(Mr + Mpr);                     // M + M'
  sumL += 15327 * Math.sin(2 * Dr - 2 * Fr);               // 2D - 2F
  sumL += -12528 * Math.sin(Mpr + 2 * Fr);                 // M' + 2F
  sumL += 10980 * Math.sin(Mpr - 2 * Fr);                  // M' - 2F
  sumL += 10675 * Math.sin(4 * Dr - Mpr);                  // 4D - M'
  sumL += 10034 * Math.sin(3 * Mpr);                       // 3M'
  sumL += 8548 * Math.sin(4 * Dr - 2 * Mpr);               // 4D - 2M'
  sumL += -7888 * Math.sin(2 * Dr + Mr - Mpr);             // 2D + M - M'
  sumL += -6766 * Math.sin(2 * Dr + Mr);                   // 2D + M
  sumL += -5163 * Math.sin(Dr - Mpr);                      // D - M'
  sumL += 4987 * Math.sin(Dr + Mr);                        // D + M
  sumL += 4036 * Math.sin(2 * Dr - Mr + Mpr);              // 2D - M + M'

  // Latitude terms (main periodic terms from Meeus Table 47.B)
  let sumB = 0;
  sumB += 5128122 * Math.sin(Fr);                           // F
  sumB += 280602 * Math.sin(Mpr + Fr);                     // M' + F
  sumB += 277693 * Math.sin(Mpr - Fr);                     // M' - F
  sumB += 173237 * Math.sin(2 * Dr - Fr);                  // 2D - F
  sumB += 55413 * Math.sin(2 * Dr - Mpr + Fr);             // 2D - M' + F
  sumB += 46271 * Math.sin(2 * Dr - Mpr - Fr);             // 2D - M' - F
  sumB += 32573 * Math.sin(2 * Dr + Fr);                   // 2D + F
  sumB += 17198 * Math.sin(2 * Mpr + Fr);                  // 2M' + F
  sumB += 9266 * Math.sin(2 * Dr + Mpr - Fr);              // 2D + M' - F
  sumB += 8822 * Math.sin(2 * Mpr - Fr);                   // 2M' - F
  sumB += -8143 * Math.sin(2 * Dr - Mr - Fr);              // 2D - M - F
  sumB += 4120 * Math.sin(2 * Dr - Mr + Fr) * -1;          // sign correction
  sumB += -3958 * Math.sin(Mr + Fr) * -1;

  // Distance terms (main from Meeus Table 47.A)
  let sumR = 0;
  sumR += -20905355 * Math.cos(Mpr);
  sumR += -3699111 * Math.cos(2 * Dr - Mpr);
  sumR += -2955968 * Math.cos(2 * Dr);
  sumR += -569925 * Math.cos(2 * Mpr);
  sumR += 48888 * Math.cos(Mr);
  sumR += -3149 * Math.cos(2 * Fr);
  sumR += 246158 * Math.cos(2 * Dr - 2 * Mpr);
  sumR += -152138 * Math.cos(2 * Dr - Mr - Mpr);
  sumR += -170733 * Math.cos(2 * Dr + Mpr);
  sumR += -204586 * Math.cos(2 * Dr - Mr);
  sumR += -129620 * Math.cos(Mr - Mpr);
  sumR += 108743 * Math.cos(Dr);
  sumR += 104755 * Math.cos(Mr + Mpr);
  sumR += 10321 * Math.cos(2 * Dr - 2 * Fr);
  sumR += 79661 * Math.cos(Mpr - 2 * Fr);

  // Additive corrections for longitude
  const A1 = norm360(119.75 + 131.849 * t) * DEG;
  const A2 = norm360(53.09 + 479264.290 * t) * DEG;
  const A3 = norm360(313.45 + 481266.484 * t) * DEG;

  sumL += 3958 * Math.sin(A1) + 1962 * Math.sin(Lp * DEG - Fr) + 318 * Math.sin(A2);
  sumB += -2235 * Math.sin(Lp * DEG) + 382 * Math.sin(A3) + 175 * Math.sin(A1 - Fr);
  sumB += 175 * Math.sin(A1 + Fr) + 127 * Math.sin(Lp * DEG - Mpr) - 115 * Math.sin(Lp * DEG + Mpr);

  const longitude = norm360(Lp + sumL / 1000000);
  const latitude = sumB / 1000000;
  const distance = 385000.56 + sumR / 1000;

  return {
    longitude,
    latitude,
    ascending_node: norm360(omega),
    distance,
  };
}

/**
 * Compute all relevant orbital info for a given date.
 */
export interface OrbitalState {
  sunLongitude: number;    // degrees
  moonLongitude: number;   // degrees
  moonLatitude: number;    // degrees
  moonNodeLongitude: number; // degrees
  phaseAngle: number;      // degrees (0=new, 180=full)
  illumination: number;    // 0..1
  phaseName: string;
  eclipseType: 'none' | 'lunar' | 'solar';
  eclipseQuality: number;
  moonDistance: number;     // km
  sunDistance: number;      // AU
}

export function computeOrbitalState(date: Date): OrbitalState {
  const jd = dateToJD(date);
  const sun = sunPosition(jd);
  const moon = moonPosition(jd);

  // Phase angle: elongation of Moon from Sun
  let elongation = moon.longitude - sun.longitude;
  elongation = norm180(elongation);

  const absElong = Math.abs(elongation);
  // Phase angle for illumination (0=new, 180=full)
  const phaseAngle = absElong;
  const illumination = (1 - Math.cos(phaseAngle * DEG)) / 2;

  // Phase name
  let phaseName: string;
  if (absElong < 10) phaseName = 'New Moon';
  else if (absElong < 80) phaseName = elongation > 0 ? 'Waxing Crescent' : 'Waning Crescent';
  else if (absElong < 100) phaseName = elongation > 0 ? 'First Quarter' : 'Last Quarter';
  else if (absElong < 170) phaseName = elongation > 0 ? 'Waxing Gibbous' : 'Waning Gibbous';
  else phaseName = 'Full Moon';

  // Eclipse detection: Moon near node AND at conjunction/opposition
  const moonRelNode = norm180(moon.longitude - moon.ascending_node);
  const distFromNode = Math.min(
    Math.abs(moonRelNode),
    Math.abs(Math.abs(moonRelNode) - 180),
  );
  // Also use latitude — Moon close to ecliptic
  const absLat = Math.abs(moon.latitude);
  const nodeProximity = Math.max(0, 1 - absLat / 1.5); // within ~1.5° of ecliptic

  let eclipseType: 'none' | 'lunar' | 'solar' = 'none';
  let eclipseQuality = 0;

  if (nodeProximity > 0) {
    if (absElong > 170) {
      eclipseType = 'lunar';
      eclipseQuality = nodeProximity * ((absElong - 170) / 10);
    } else if (absElong < 10) {
      eclipseType = 'solar';
      eclipseQuality = nodeProximity * ((10 - absElong) / 10);
    }
  }

  return {
    sunLongitude: sun.longitude,
    moonLongitude: moon.longitude,
    moonLatitude: moon.latitude,
    moonNodeLongitude: moon.ascending_node,
    phaseAngle,
    illumination,
    phaseName,
    eclipseType,
    eclipseQuality: Math.min(1, eclipseQuality),
    moonDistance: moon.distance,
    sunDistance: sun.distance,
  };
}

// ================================================================
// Event search — find next/previous full moon, new moon, eclipses
// ================================================================

export type EventType = 'full-moon' | 'new-moon' | 'lunar-eclipse' | 'solar-eclipse';

/**
 * Get the Sun-Moon elongation for a given date (signed, -180..180).
 */
function elongationAt(date: Date): number {
  const jd = dateToJD(date);
  const sun = sunPosition(jd);
  const moon = moonPosition(jd);
  return norm180(moon.longitude - sun.longitude);
}

/**
 * Find the next/previous moment when elongation crosses a target value.
 * Uses coarse scan + bisection refinement.
 */
function findElongationCrossing(
  startDate: Date,
  targetElong: number,
  direction: 1 | -1,
  maxDays: number,
): Date | null {
  const step = direction * MS_PER_HOUR * 6; // 6-hour steps
  const maxSteps = Math.ceil((maxDays * MS_PER_DAY) / Math.abs(step));

  let prevTime = startDate.getTime();
  let prevElong = norm180(elongationAt(new Date(prevTime)) - targetElong);

  for (let i = 1; i <= maxSteps; i++) {
    const curTime = prevTime + step;
    const curElong = norm180(elongationAt(new Date(curTime)) - targetElong);

    // Detect sign change (crossing through 0), but ignore wraps through ±180
    if (prevElong * curElong < 0 && Math.abs(prevElong - curElong) < 90) {
      // Bisect to find precise crossing
      let lo = prevTime;
      let hi = curTime;
      for (let j = 0; j < 20; j++) {
        const mid = (lo + hi) / 2;
        const midElong = norm180(elongationAt(new Date(mid)) - targetElong);
        if (prevElong * midElong < 0) {
          hi = mid;
        } else {
          lo = mid;
          prevElong = midElong;
        }
      }
      return new Date((lo + hi) / 2);
    }

    prevTime = curTime;
    prevElong = curElong;
  }
  return null;
}

/**
 * Find next/previous full moon from a given date.
 */
export function findFullMoon(from: Date, direction: 1 | -1): Date | null {
  return findElongationCrossing(from, 180, direction, 45);
}

/**
 * Find next/previous new moon from a given date.
 */
export function findNewMoon(from: Date, direction: 1 | -1): Date | null {
  return findElongationCrossing(from, 0, direction, 45);
}

/**
 * Find next/previous lunar eclipse: a full moon where Moon latitude is small.
 */
export function findLunarEclipse(from: Date, direction: 1 | -1): Date | null {
  let cursor = new Date(from.getTime());
  // Search up to ~3 years (about 36 lunations)
  for (let i = 0; i < 40; i++) {
    const fm = findFullMoon(cursor, direction);
    if (!fm) return null;

    const state = computeOrbitalState(fm);
    if (Math.abs(state.moonLatitude) < 1.5) {
      return fm;
    }
    // Skip ahead past this full moon
    cursor = new Date(fm.getTime() + direction * MS_PER_DAY * 2);
  }
  return null;
}

/**
 * Find next/previous solar eclipse: a new moon where Moon latitude is small.
 */
export function findSolarEclipse(from: Date, direction: 1 | -1): Date | null {
  let cursor = new Date(from.getTime());
  for (let i = 0; i < 40; i++) {
    const nm = findNewMoon(cursor, direction);
    if (!nm) return null;

    const state = computeOrbitalState(nm);
    if (Math.abs(state.moonLatitude) < 1.5) {
      return nm;
    }
    cursor = new Date(nm.getTime() + direction * MS_PER_DAY * 2);
  }
  return null;
}

/**
 * Unified search function.
 */
export function findEvent(type: EventType, from: Date, direction: 1 | -1): Date | null {
  switch (type) {
    case 'full-moon': return findFullMoon(from, direction);
    case 'new-moon': return findNewMoon(from, direction);
    case 'lunar-eclipse': return findLunarEclipse(from, direction);
    case 'solar-eclipse': return findSolarEclipse(from, direction);
  }
}
