/**
 * Earth's orientation against ERFA's own test values (t_erfa_c.c in
 * github.com/liberfa/erfa: t_era00, t_ltpequ, t_c2ixys, t_c2t06a). The
 * composite check against eraC2t06a holds to 1e-4 because that routine adds
 * nutation, frame bias and polar motion, which this model leaves out.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  celestialToIntermediateMatrix,
  celestialToTerrestrialMatrix,
  earthOrientationQuaternion,
  earthRotationAngleRad,
  longTermEquatorPole,
} from './earthOrientation';
import { raDecToVector, ttJDFromUtcMs } from './planetary';

const J2000_JULIAN_DATE = 2451545.0;

describe('earthRotationAngleRad', () => {
  it('matches eraEra00 at UT1 = JD 2400000.5 + 54388.0', () => {
    const daysSinceJ2000 = 2400000.5 + 54388.0 - J2000_JULIAN_DATE;
    expect(earthRotationAngleRad(daysSinceJ2000)).toBeCloseTo(0.4022837240028158102, 12);
  });

  it('stays in [0, 2π) before J2000 too', () => {
    const angle = earthRotationAngleRad(-1_000_000.25);
    expect(angle).toBeGreaterThanOrEqual(0);
    expect(angle).toBeLessThan(2 * Math.PI);
  });
});

describe('longTermEquatorPole', () => {
  it('matches eraLtpequ at epoch -2500', () => {
    const pole = longTermEquatorPole(-2500.0, [0, 0, 0]);
    expect(pole[0]).toBeCloseTo(-0.3586652560237326659, 14);
    expect(pole[1]).toBeCloseTo(-0.1996978910771128475, 14);
    expect(pole[2]).toBeCloseTo(0.9118552442250819624, 14);
  });

  it('is the J2000 pole at J2000, to a few milliarcseconds', () => {
    const pole = longTermEquatorPole(2000.0, [0, 0, 0]);
    const arcsec = Math.PI / (180 * 3600);
    expect(Math.abs(pole[0])).toBeLessThan(0.1 * arcsec);
    expect(Math.abs(pole[1])).toBeLessThan(0.1 * arcsec);
  });
});

describe('celestialToIntermediateMatrix', () => {
  it('matches eraC2ixys at its test inputs', () => {
    const matrix = celestialToIntermediateMatrix(
      0.5791308486706011e-3,
      0.4020579816732961219e-4,
      -0.1220040848472271978e-7,
      new Array<number>(9).fill(0),
    );
    const expected = [
      0.9999998323037157138, 0.5581984869168499149e-9, -0.579130849161128218e-3,
      -0.2384261642670440317e-7, 0.9999999991917468964, -0.4020579110169668931e-4,
      0.5791308486706011e-3, 0.4020579816732961219e-4, 0.999999831495462759,
    ];
    expected.forEach((value, index) => expect(matrix[index], `element ${index}`).toBeCloseTo(value, 12));
  });
});

describe('celestialToTerrestrialMatrix', () => {
  it('matches eraC2t06a to the size of the nutation it leaves out', () => {
    // eraC2t06a(TT = UT1 = JD 2400000.5 + 53736.0, xp, yp): JD 2453736.5,
    // which is 2191.5 days after J2000 and Julian epoch 2006.0.
    const matrix = celestialToTerrestrialMatrix(2191.5, 2006.0, new Array<number>(9).fill(0));
    const expected = [
      -0.1810332128305897282, 0.9834769806938592296, 0.6555550962998436505e-4,
      -0.9834768134136214897, -0.1810332203649130832, 0.574980084490559411e-3,
      0.5773474024748545878e-3, 0.3961816829632690581e-4, 0.9999998325501747785,
    ];
    expected.forEach((value, index) => expect(Math.abs(matrix[index] - value), `element ${index}`).toBeLessThan(1e-4));
  });
});

describe('earthOrientationQuaternion', () => {
  // eraEra00's test instant, JD 2400000.5 + 54388.0 (2007-10-15 00:00), as a
  // clock instant: the clock stands in for UT1.
  const utcMs = (2400000.5 + 54388.0 - 2440587.5) * 86_400_000;
  const orientation = earthOrientationQuaternion(utcMs, ttJDFromUtcMs(utcMs), new THREE.Quaternion());

  it('is a proper rotation', () => {
    expect(orientation.length()).toBeCloseTo(1, 12);
    const matrix = new THREE.Matrix4().makeRotationFromQuaternion(orientation);
    expect(matrix.determinant()).toBeCloseTo(1, 12);
  });

  it('points the prime meridian at the rotation angle', () => {
    // The CIO sits within a fraction of an arcsecond of the J2000 equinox in
    // 2007, so longitude 0 lies at a right ascension equal to the ERA.
    const primeMeridian = new THREE.Vector3(1, 0, 0).applyQuaternion(orientation);
    const rightAscensionRad = Math.atan2(-primeMeridian.z, primeMeridian.x);
    const angleRad = earthRotationAngleRad(2400000.5 + 54388.0 - J2000_JULIAN_DATE);
    expect(Math.abs(rightAscensionRad - angleRad)).toBeLessThan(1e-5);
  });

  it('points the north pole at the precessed pole of date', () => {
    const north = new THREE.Vector3(0, 1, 0).applyQuaternion(orientation);
    const julianEpoch = 2000 + (ttJDFromUtcMs(utcMs) - J2000_JULIAN_DATE) / 365.25;
    const pole = longTermEquatorPole(julianEpoch, [0, 0, 0]);
    const expected = new THREE.Vector3(pole[0], pole[2], -pole[1]);
    expect(north.angleTo(expected)).toBeLessThan(1e-12);
    // Precession has moved it off the J2000 pole by about 20″ a year.
    const tiltArcsec = north.angleTo(raDecToVector(0, 90)) * (180 / Math.PI) * 3600;
    expect(tiltArcsec).toBeGreaterThan(130);
    expect(tiltArcsec).toBeLessThan(160);
  });

  it('puts longitude 90° W on the body frame +Z', () => {
    const west = new THREE.Vector3(0, 0, 1).applyQuaternion(orientation);
    const prime = new THREE.Vector3(1, 0, 0).applyQuaternion(orientation);
    const north = new THREE.Vector3(0, 1, 0).applyQuaternion(orientation);
    // East is north × prime in a right-handed frame, so west is its negation.
    const east = new THREE.Vector3().crossVectors(north, prime);
    expect(west.angleTo(east.negate())).toBeLessThan(1e-12);
  });
});
