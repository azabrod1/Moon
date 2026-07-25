/**
 * The cruise flight frame: the one place that says which way is "up" while
 * flying, and how the ship's heading/pitch map to a scene direction.
 *
 * The scene is J2000 equatorial (+Y = celestial north), but everything the
 * player flies among — the planets, the belt, the orbit lines — lies in the
 * ecliptic, tilted 23.44° from that. Steering and the chase camera therefore
 * ride ECLIPTIC north: pitch 0 is level with the system, and the ecliptic's
 * vanishing line renders horizontal at every heading instead of rolling as
 * you yaw. The frame is presentation only — positions, ephemerides and the
 * scene's J2000 contract are untouched.
 *
 * Landed framing, surface view and the Observatory keep their own up handling
 * (world-up / local tangent); this module is the cruise rig's frame alone.
 */
import * as THREE from 'three';
import { ECLIPTIC_NORTH_EQUATORIAL, eclipticToEquatorial } from '../astronomy/planetary';

/** The cruise horizon axis: ecliptic north in scene coordinates. One vector
 *  shared with the astronomy definition site — read-only, copy to mutate. */
export const FLIGHT_UP_SCENE: THREE.Vector3 = ECLIPTIC_NORTH_EQUATORIAL;

/** Steering's pitch bound, and the same bound the direction→angles seam
 *  clamps to: the flight basis' poles are singular for heading, so no input
 *  path (collision pushback, a polar departure radial, a save) may park the
 *  ship exactly on one. ±0.49π ≈ ±88.2°. */
export const FLIGHT_PITCH_LIMIT_RAD = Math.PI * 0.49;

/** Ecliptic basis → scene, built from the astronomy transform itself so this
 *  module never re-inlines the obliquity rotation or its chirality. */
const ECLIPTIC_TO_SCENE_QUAT = new THREE.Quaternion().setFromRotationMatrix(
  new THREE.Matrix4().makeBasis(
    eclipticToEquatorial(new THREE.Vector3(1, 0, 0)),
    eclipticToEquatorial(new THREE.Vector3(0, 1, 0)),
    eclipticToEquatorial(new THREE.Vector3(0, 0, 1)),
  ),
);
const SCENE_TO_ECLIPTIC_QUAT = ECLIPTIC_TO_SCENE_QUAT.clone().invert();

/** The hull model's own forward axis (ship/models are authored +X-forward). */
const HULL_FORWARD_LOCAL = new THREE.Vector3(1, 0, 0);

// Scratch for the per-frame hull basis — this runs once per rendered frame,
// so it must not allocate.
const tmpBasisX = new THREE.Vector3();
const tmpBasisY = new THREE.Vector3();
const tmpBasisZ = new THREE.Vector3();
const tmpBasisMatrix = new THREE.Matrix4();
const tmpAngleDir = new THREE.Vector3();

export interface FlightAngles {
  headingRad: number;
  pitchRad: number;
}

/**
 * Heading/pitch → unit scene direction. The spherical formula is evaluated in
 * the ecliptic basis (heading sweeps the ecliptic plane, pitch is ecliptic
 * latitude) and rotated into the scene, so level flight stays level.
 */
export function flightDirectionFromAngles(
  headingRad: number,
  pitchRad: number,
  out: THREE.Vector3 = new THREE.Vector3(),
): THREE.Vector3 {
  const cosPitch = Math.cos(pitchRad);
  return out
    .set(
      Math.cos(headingRad) * cosPitch,
      Math.sin(pitchRad),
      Math.sin(headingRad) * cosPitch,
    )
    .applyQuaternion(ECLIPTIC_TO_SCENE_QUAT)
    .normalize();
}

/**
 * Scene direction → heading/pitch, the inverse of the above and the single
 * seam every "aim at that thing over there" caller goes through. The delta is
 * normalized first, so the result depends only on the DIRECTION — callers
 * pass raw world deltas, and a target a few metres away must read the same as
 * one a hundred AU away. A zero-length or non-finite delta has no direction
 * at all and returns level-ahead.
 *
 * Pitch is clamped to the steering bound: a caller handing over a straight-up
 * delta (a vertical collision push, a polar departure) would otherwise land
 * the ship exactly on the basis pole, where heading is undefined and the next
 * yaw input swings the nose through a right angle.
 */
export function flightAnglesFromSceneDirection(
  dx: number,
  dy: number,
  dz: number,
): FlightAngles {
  const local = tmpAngleDir.set(dx, dy, dz).applyQuaternion(SCENE_TO_ECLIPTIC_QUAT);
  const lengthSq = local.lengthSq();
  if (!(lengthSq > 0) || !Number.isFinite(lengthSq)) return { headingRad: 0, pitchRad: 0 };
  local.multiplyScalar(1 / Math.sqrt(lengthSq));
  // On the unit vector the floor is purely the exact-pole guard (atan2(±1, 0)
  // is ±π/2, which the clamp then pulls back inside the bound).
  const horizontal = Math.sqrt(local.x * local.x + local.z * local.z);
  const pitchRad = Math.atan2(local.y, Math.max(horizontal, 1e-8));
  return {
    headingRad: Math.atan2(local.z, local.x),
    pitchRad: Math.max(-FLIGHT_PITCH_LIMIT_RAD, Math.min(FLIGHT_PITCH_LIMIT_RAD, pitchRad)),
  };
}

/**
 * Convert angles saved in the pre-ecliptic (scene-equatorial) basis into this
 * one, preserving the world direction the ship was pointing. Rebuilds the old
 * basis' forward with the formula that produced it, then re-reads it here.
 *
 * Bounded loss near the flight poles, deliberately: a save aimed within
 * (π/2 − FLIGHT_PITCH_LIMIT_RAD) ≈ 1.8° of ecliptic north or south restores
 * pointing at the clamp instead, and at the exact pole its heading falls out
 * of float residue. Restored state must respect the pitch bound like any
 * other state — the bound is not just a steering nicety, it is what keeps the
 * chase camera's up axis off the view direction, where lookAt has no defined
 * roll. Trading up to 1.8° of a straight-up aim for a well-posed camera is
 * the intended bargain.
 */
export function eclipticHeadingPitchFromEquatorial(
  headingRad: number,
  pitchRad: number,
): FlightAngles {
  const cosPitch = Math.cos(pitchRad);
  return flightAnglesFromSceneDirection(
    Math.cos(headingRad) * cosPitch,
    Math.sin(pitchRad),
    Math.sin(headingRad) * cosPitch,
  );
}

/**
 * The visible hull's orientation for a flight heading/pitch: an explicit
 * +X-forward basis with its "up" the flight horizon, so the ship banks with
 * the system's plane rather than with celestial north. (Matrix4.lookAt is
 * −Z-forward and would be a 90° error against the +X-forward models.)
 *
 * Near the flight pole the roll reference degenerates; the epsilon sits above
 * every reachable pitch (steering and the direction seam both clamp to
 * FLIGHT_PITCH_LIMIT_RAD ≈ 88.2°), so the twist-minimal fallback guards float
 * noise only and the seam is unreachable through any input.
 */
export function shipOrientationFromFlight(
  headingRad: number,
  pitchRad: number,
  outQuat: THREE.Quaternion,
): THREE.Quaternion {
  const forward = flightDirectionFromAngles(headingRad, pitchRad, tmpBasisX);
  const alignment = forward.dot(FLIGHT_UP_SCENE);
  if (Math.abs(alignment) > 0.9999) {
    return outQuat.setFromUnitVectors(HULL_FORWARD_LOCAL, forward);
  }
  tmpBasisY.copy(FLIGHT_UP_SCENE).addScaledVector(forward, -alignment).normalize();
  tmpBasisZ.crossVectors(forward, tmpBasisY);
  tmpBasisMatrix.makeBasis(forward, tmpBasisY, tmpBasisZ);
  return outQuat.setFromRotationMatrix(tmpBasisMatrix);
}
