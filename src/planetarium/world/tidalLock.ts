/**
 * Tidal locking — the orientation a synchronous moon wears.
 *
 * Every major moon keeps one face toward its planet, so its orientation is not
 * a spin about a pole but a basis built from where it is: the sub-planet
 * direction, and the orbit normal as the roll reference. Two renderers need it
 * (the world's moon meshes and the map's), and they must agree exactly — the
 * same moon at the same instant faces the same way on the chart as it does out
 * of the window.
 */
import * as THREE from 'three';
import { eclipticToEquatorial } from '../../astronomy/planetary';

/** Ecliptic north in the scene's equatorial frame. */
const ECLIPTIC_NORTH = eclipticToEquatorial(new THREE.Vector3(0, 1, 0));

/**
 * The roll reference a moon's locked face is levelled against — its orbit
 * normal, except for Earth's Moon.
 *
 * The Moon's spin axis sits about 1.5° from ecliptic north (a Cassini state),
 * not on the 5.1°-tilted normal of its own orbit, so rolling it on the orbit
 * normal would tip its face by several degrees and wobble it over the 18.6-year
 * nodal cycle. Both renderers ask here rather than each deciding: the same moon
 * at the same instant has to face the same way on the chart and out of the
 * window, and the shadow engine reads the TRUE normal straight from the
 * ephemeris seam, which is a different question.
 */
export function tidalRollNorth(
  moonName: string,
  parentPlanetName: string,
  orbitNormal: THREE.Vector3,
  out: THREE.Vector3,
): THREE.Vector3 {
  if (moonName === 'Moon' && parentPlanetName === 'Earth') return out.copy(ECLIPTIC_NORTH);
  return out.copy(orbitNormal);
}

const tmpToParent = new THREE.Vector3();
const tmpBasisZ = new THREE.Vector3();
const tmpUp = new THREE.Vector3();
const tmpBasis = new THREE.Matrix4();

/**
 * Write the tidally-locked orientation into `out`: the face pointed at the
 * parent, rolled so the orbit normal is up.
 *
 * `offsetFromParent` is the moon's position relative to its planet, and
 * `rollNorth` the orbit normal. Returns false — leaving `out` untouched — for
 * degenerate geometry, which valid orbits never produce.
 *
 * The basis Z column holds TEXTURE longitude 90°W rather than geographic east
 * (east is its negation, pole×prime — the same naming as the pole-basis
 * builder). Only the handedness matters here: X×Y=Z keeps the determinant
 * positive, so a texture is never mirrored.
 */
export function tidalLockQuaternion(
  offsetFromParent: THREE.Vector3,
  rollNorth: THREE.Vector3,
  out: THREE.Quaternion,
): boolean {
  const toParent = tmpToParent.copy(offsetFromParent).multiplyScalar(-1);
  if (toParent.lengthSq() < 1e-30) return false;
  toParent.normalize();
  const basisZ = tmpBasisZ.crossVectors(toParent, rollNorth);
  if (basisZ.lengthSq() < 1e-10) return false;
  basisZ.normalize();
  const up = tmpUp.crossVectors(basisZ, toParent);
  out.setFromRotationMatrix(tmpBasis.makeBasis(toParent, up, basisZ));
  return true;
}
