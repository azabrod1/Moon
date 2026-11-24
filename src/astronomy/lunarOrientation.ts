/**
 * The Moon's orientation: the IAU model (WGCCRE 2009, Archinal et al. 2011,
 * carried unchanged into NAIF pck00011 as BODY301), whose pole and prime
 * meridian include the physical and optical libration in thirteen periodic
 * terms. Its frame approximates the mean Earth/polar axis frame (MOON_ME)
 * Horizons reports the sub-Earth point in; lunarOrientation.test.ts holds the
 * two together. Longitude 0 is the mean sub-Earth meridian, which is where
 * the Moon's map puts its centre.
 *
 * Without it the Moon wore an exact tidal lock: its face pointed straight at
 * Earth's centre, so it never librated — the ±7° in longitude and ±7° in
 * latitude that let an observer see 59% of its surface over time.
 */
import * as THREE from 'three';
import { buildPoleBasisQuaternion } from './planetary';

const J2000_JD = 2451545.0;
const DEG = Math.PI / 180;

/** E1…E13: degrees at J2000 and degrees per day. */
const ANGLES: ReadonlyArray<readonly [number, number]> = [
  [125.045, -0.0529921],
  [250.089, -0.1059842],
  [260.008, 13.0120009],
  [176.625, 13.3407154],
  [357.529, 0.9856003],
  [311.589, 26.4057084],
  [134.963, 13.064993],
  [276.617, 0.3287146],
  [34.226, 1.7484877],
  [15.134, -0.1589763],
  [119.743, 0.0036096],
  [239.961, 0.1643573],
  [25.053, 12.9590088],
];
/** Amplitudes per angle, degrees: α0 (sin), δ0 (cos), W (sin). */
const RA_SIN = [-3.8787, -0.1204, 0.07, -0.0172, 0, 0.0072, 0, 0, 0, -0.0052, 0, 0, 0.0043];
const DEC_COS = [1.5419, 0.0239, -0.0278, 0.0068, 0, -0.0029, 0.0009, 0, 0, 0.0008, 0, 0, -0.0009];
const MERIDIAN_SIN = [3.561, 0.1208, -0.0642, 0.0158, 0.0252, -0.0066, -0.0047, -0.0046, 0.0028, 0.0052, 0.004, 0.0019, -0.0044];

export interface LunarRotation {
  poleRaDeg: number;
  poleDecDeg: number;
  meridianDeg: number;
}

/** The Moon's pole and prime meridian at a TT Julian day (TDB to 2 ms). */
export function lunarRotation(jdTT: number, out: LunarRotation = { poleRaDeg: 0, poleDecDeg: 0, meridianDeg: 0 }): LunarRotation {
  const days = jdTT - J2000_JD;
  const centuries = days / 36525;
  let poleRaDeg = 269.9949 + 0.0031 * centuries;
  let poleDecDeg = 66.5392 + 0.013 * centuries;
  let meridianDeg = 38.3213 + 13.17635815 * days - 1.4e-12 * days * days;
  for (let index = 0; index < ANGLES.length; index++) {
    const angle = (ANGLES[index][0] + ANGLES[index][1] * days) * DEG;
    const sine = Math.sin(angle);
    poleRaDeg += RA_SIN[index] * sine;
    poleDecDeg += DEC_COS[index] * Math.cos(angle);
    meridianDeg += MERIDIAN_SIN[index] * sine;
  }
  out.poleRaDeg = poleRaDeg;
  out.poleDecDeg = poleDecDeg;
  out.meridianDeg = meridianDeg;
  return out;
}

const rotationScratch: LunarRotation = { poleRaDeg: 0, poleDecDeg: 0, meridianDeg: 0 };

/** The Moon's body-fixed frame in the scene frame at a TT Julian day: +X the
 *  mean sub-Earth meridian, +Y its north pole (planetary.ts' pole basis). */
export function lunarOrientationQuaternion(jdTT: number, out: THREE.Quaternion = new THREE.Quaternion()): THREE.Quaternion {
  const rotation = lunarRotation(jdTT, rotationScratch);
  return buildPoleBasisQuaternion(rotation.poleRaDeg, rotation.poleDecDeg, rotation.meridianDeg, out);
}
