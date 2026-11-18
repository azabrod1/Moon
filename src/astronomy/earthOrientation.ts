/**
 * Earth's orientation in the scene's J2000 frame, the way the IERS
 * conventions build it, minus the parts too small to see:
 *
 *  - the spin is the Earth Rotation Angle (IAU 2000; ERFA `eraEra00`), with the
 *    clock's UTC standing in for UT1 (within the 0.9 s that leap seconds keep
 *    them apart: 0.4 km at the equator);
 *  - the pole is the mean pole of date from the long-term precession of
 *    Vondrák, Capitaine & Wallace (2011, A&A 534, A22; ERFA `eraLtpequ`),
 *    valid over ±200,000 years, so it covers the clock's whole range;
 *  - the two are joined at the Celestial Intermediate Origin (ERFA
 *    `eraC2ixys`), with the CIO locator s taken as −XY/2.
 *
 * Nutation (at most 9″ of pole, 0.3 km on the ground) and polar motion
 * (under 0.5″) are left out.
 *
 * Earth used to share the other bodies' IAU WGCCRE cartographic model
 * (W = 190.147° + 360.9856235° d, pole fixed at Dec 90°). That is a linear
 * approximation with its own offset and rate, and with the pole's precession
 * dropped: by 2026 it had the prime meridian 0.11° and the pole 0.15° away
 * from Earth's real orientation, about 12 km and 16 km on the ground.
 *
 * Body frame (as every body here): +X toward longitude 0, +Y toward the north
 * pole, +Z toward longitude 90° W. Pure; tested against ERFA's own test values
 * in earthOrientation.test.ts.
 */
import * as THREE from 'three';

const TWO_PI = 2 * Math.PI;
const ARCSEC_TO_RAD = Math.PI / (180 * 3600);
const MS_PER_DAY = 86_400_000;
const J2000_JULIAN_DATE = 2451545.0;
const DAYS_PER_JULIAN_YEAR = 365.25;
/** 2000-01-01 12:00, the epoch of the rotation angle's day count. */
const J2000_UTC_MS = Date.UTC(2000, 0, 1, 12);

/**
 * Earth Rotation Angle in radians, [0, 2π), for a count of UT1 days since
 * J2000 (ERFA `eraEra00`). The whole days drop out of the first term, which
 * keeps the angle's precision for any date.
 */
export function earthRotationAngleRad(daysSinceJ2000: number): number {
  const fractionOfDay = daysSinceJ2000 - Math.floor(daysSinceJ2000);
  const turns = fractionOfDay + 0.779057273264 + 0.00273781191135448 * daysSinceJ2000;
  return TWO_PI * (turns - Math.floor(turns));
}

// Vondrák, Capitaine & Wallace (2011), Table 2 polynomial and Table 3
// periodic terms for the equator pole, as tabulated in ERFA's ltpequ.c:
// arcseconds, centuries since J2000.
const POLE_POLYNOMIAL_X = [5453.282155, 0.4252841, -0.00037173, -0.000000152];
const POLE_POLYNOMIAL_Y = [-73750.93035, -0.7675452, -0.00018725, 0.000000231];
/** [period in centuries, X cosine, Y cosine, X sine, Y sine] */
const POLE_PERIODIC: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [256.75, -819.940624, 75004.344875, 81491.287984, 1558.515853],
  [708.15, -8444.676815, 624.033993, 787.163481, 7774.939698],
  [274.2, 2600.009459, 1251.136893, 1251.296102, -2219.534038],
  [241.45, 2755.17563, -1102.212834, -1257.950837, -2523.969396],
  [2309.0, -167.659835, -2660.66498, -2966.79973, 247.850422],
  [492.2, 871.855056, 699.291817, 639.744522, -846.485643],
  [396.1, 44.769698, 153.16722, 131.600209, -1393.124055],
  [288.9, -512.313065, -950.865637, -445.040117, 368.526116],
  [231.1, -819.415595, 499.754645, 584.522874, 749.045012],
  [1610.0, -538.071099, -145.18821, -89.756563, 444.704518],
  [620.0, -189.793622, 558.116553, 524.42963, 235.934465],
  [157.87, -402.922932, -23.923029, -13.549067, 374.049623],
  [220.3, 179.516345, -165.405086, -210.157124, -171.33018],
  [1200.0, -9.814756, 9.344131, -44.919798, -22.899655],
];

/**
 * The mean pole of date as direction cosines in the J2000 equatorial frame
 * (x toward the J2000 equinox, z toward the J2000 pole), for a Julian epoch
 * such as 2026.88 (ERFA `eraLtpequ`). Writes `out[0..2]` and returns it.
 */
export function longTermEquatorPole(julianEpoch: number, out: number[]): number[] {
  const centuries = (julianEpoch - 2000) / 100;
  let x = 0;
  let y = 0;
  const phase = TWO_PI * centuries;
  for (const [periodCenturies, xCosine, yCosine, xSine, ySine] of POLE_PERIODIC) {
    const angle = phase / periodCenturies;
    const sine = Math.sin(angle);
    const cosine = Math.cos(angle);
    x += cosine * xCosine + sine * xSine;
    y += cosine * yCosine + sine * ySine;
  }
  let power = 1;
  for (let termIndex = 0; termIndex < POLE_POLYNOMIAL_X.length; termIndex++) {
    x += POLE_POLYNOMIAL_X[termIndex] * power;
    y += POLE_POLYNOMIAL_Y[termIndex] * power;
    power *= centuries;
  }
  x *= ARCSEC_TO_RAD;
  y *= ARCSEC_TO_RAD;
  const remainder = 1 - x * x - y * y;
  out[0] = x;
  out[1] = y;
  out[2] = remainder < 0 ? 0 : Math.sqrt(remainder);
  return out;
}

/**
 * The celestial-to-intermediate matrix from the pole's X, Y and the CIO
 * locator s (ERFA `eraC2ixys`): row-major, `out[row * 3 + column]`.
 * rc2i = Rz(−(E + s)) · Ry(d) · Rz(E), with ERFA's rotation conventions.
 */
export function celestialToIntermediateMatrix(x: number, y: number, s: number, out: number[]): number[] {
  const radiusSquared = x * x + y * y;
  const azimuth = radiusSquared > 0 ? Math.atan2(y, x) : 0;
  const tilt = Math.atan(Math.sqrt(radiusSquared / (1 - radiusSquared)));
  const cosAzimuth = Math.cos(azimuth);
  const sinAzimuth = Math.sin(azimuth);
  const cosTilt = Math.cos(tilt);
  const sinTilt = Math.sin(tilt);
  const cosFinal = Math.cos(-(azimuth + s));
  const sinFinal = Math.sin(-(azimuth + s));
  // Ry(d) · Rz(E): rows of Rz(E) are [c, s, 0], [−s, c, 0], [0, 0, 1];
  // Ry(d) mixes rows 0 and 2 as [c·r0 − s·r2, r1, s·r0 + c·r2].
  const tiltedRow0 = [cosTilt * cosAzimuth, cosTilt * sinAzimuth, -sinTilt];
  const tiltedRow1 = [-sinAzimuth, cosAzimuth, 0];
  const tiltedRow2 = [sinTilt * cosAzimuth, sinTilt * sinAzimuth, cosTilt];
  // Rz(−(E + s)) mixes rows 0 and 1 as [c·r0 + s·r1, −s·r0 + c·r1, r2].
  for (let column = 0; column < 3; column++) {
    out[column] = cosFinal * tiltedRow0[column] + sinFinal * tiltedRow1[column];
    out[3 + column] = -sinFinal * tiltedRow0[column] + cosFinal * tiltedRow1[column];
    out[6 + column] = tiltedRow2[column];
  }
  return out;
}

const poleScratch = [0, 0, 0];
const intermediateScratch = new Array<number>(9).fill(0);

/**
 * The celestial-to-terrestrial matrix, row-major: J2000 equatorial axes to
 * Earth-fixed axes (x toward longitude 0, y toward 90° E, z north). The
 * rotation angle comes from UT1 days since J2000, the pole from a Julian
 * epoch in TT. ERFA's `eraC2tcio` with polar motion left out:
 * rc2t = Rz(ERA) · rc2i.
 */
export function celestialToTerrestrialMatrix(
  ut1DaysSinceJ2000: number,
  julianEpochTT: number,
  out: number[],
): number[] {
  const pole = longTermEquatorPole(julianEpochTT, poleScratch);
  const locator = (-pole[0] * pole[1]) / 2;
  const intermediate = celestialToIntermediateMatrix(pole[0], pole[1], locator, intermediateScratch);
  const angle = earthRotationAngleRad(ut1DaysSinceJ2000);
  const cosAngle = Math.cos(angle);
  const sinAngle = Math.sin(angle);
  for (let column = 0; column < 3; column++) {
    const row0 = intermediate[column];
    const row1 = intermediate[3 + column];
    out[column] = cosAngle * row0 + sinAngle * row1;
    out[3 + column] = -sinAngle * row0 + cosAngle * row1;
    out[6 + column] = intermediate[6 + column];
  }
  return out;
}

const terrestrialScratch = new Array<number>(9).fill(0);
const basisX = new THREE.Vector3();
const basisY = new THREE.Vector3();
const basisZ = new THREE.Vector3();
const basisMatrix = new THREE.Matrix4();

/**
 * Earth's orientation quaternion at a clock instant: body frame to scene.
 * `jdTT` is the same instant's TT Julian Date (planetary.ts `ttJDFromUtcMs`),
 * passed in so this module does not depend on the clock conversion.
 */
export function earthOrientationQuaternion(utcMs: number, jdTT: number, out: THREE.Quaternion): THREE.Quaternion {
  const ut1Days = (utcMs - J2000_UTC_MS) / MS_PER_DAY;
  const julianEpoch = 2000 + (jdTT - J2000_JULIAN_DATE) / DAYS_PER_JULIAN_YEAR;
  const rows = celestialToTerrestrialMatrix(ut1Days, julianEpoch, terrestrialScratch);
  // The body frame's axes in Earth-fixed terms: +X is Earth-fixed x, +Y is
  // Earth-fixed z, +Z is Earth-fixed −y. Each one's J2000 direction is the
  // matching row of rc2t (its transpose maps Earth-fixed to J2000), carried
  // into the scene by J2000 (x, y, z) → scene (x, z, −y), as raDecToVector does.
  basisX.set(rows[0], rows[2], -rows[1]);
  basisY.set(rows[6], rows[8], -rows[7]);
  basisZ.set(-rows[3], -rows[5], rows[4]);
  return out.setFromRotationMatrix(basisMatrix.makeBasis(basisX, basisY, basisZ));
}
