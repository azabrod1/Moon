/**
 * Eclipse shadow-cone visualization for the Moon view: builds the umbra cones
 * and orients them away from the Sun, showing the Moon's cone only near syzygy
 * (phase angle < 20°).
 */
import * as THREE from 'three';
import { SCENE_UNITS } from '../shared/constants/sceneUnits';
import { computePhaseInfo } from './phase';
import type { Sun } from './bodies/Sun';
import type { Moon } from './bodies/Moon';

export function createShadowCone(baseRadius: number, color: number): THREE.Mesh {
  const length = SCENE_UNITS.EARTH_MOON_DIST * 1.5;
  const geo = new THREE.ConeGeometry(baseRadius, length, 32, 1, true);
  geo.translate(0, length / 2, 0);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false,
  });
  return new THREE.Mesh(geo, mat);
}

const _quat = new THREE.Quaternion();

function orientConeAlongDir(cone: THREE.Mesh, origin: THREE.Vector3, direction: THREE.Vector3) {
  cone.position.copy(origin);
  _quat.setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction.clone().normalize());
  cone.quaternion.copy(_quat);
}

export function updateShadowCones(
  earthCone: THREE.Mesh,
  moonCone: THREE.Mesh,
  sun: Sun,
  moon: Moon,
  moonAngle: number,
  sunAngle: number,
  nodeAngle: number,
) {
  const sunDir = sun.getDirection();
  const antiSun = sunDir.clone().negate();

  orientConeAlongDir(earthCone, new THREE.Vector3(0, 0, 0), antiSun);
  earthCone.visible = true;

  const phase = computePhaseInfo(moonAngle, sunAngle, nodeAngle);
  const moonPos = moon.getWorldPosition();
  if (phase.phaseAngle < 20) {
    orientConeAlongDir(moonCone, moonPos, antiSun);
    moonCone.visible = true;
  } else {
    moonCone.visible = false;
  }
}
