import * as THREE from 'three';

/**
 * Apply the simulator's shared orbit-plane orientation.
 * The negative node rotation keeps orbital longitudes aligned with the scene's X/Z convention.
 */
export function orientOrbitPlane(object: THREE.Object3D, inclinationRad: number, nodeAngleRad: number) {
  object.rotation.order = 'YXZ';
  object.rotation.x = inclinationRad;
  object.rotation.y = -nodeAngleRad;
}
