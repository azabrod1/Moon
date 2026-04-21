/**
 * Shared orbit-plane orientation used by the Moon view. Applies an inclination
 * tilt plus a negated node rotation so orbital longitudes align with the
 * scene's X/Z convention (ecliptic plane = Y=0, +X = vernal equinox).
 */
import * as THREE from 'three';

export function orientOrbitPlane(object: THREE.Object3D, inclinationRad: number, nodeAngleRad: number) {
  object.rotation.order = 'YXZ';
  object.rotation.x = inclinationRad;
  object.rotation.y = -nodeAngleRad;
}
