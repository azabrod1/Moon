import * as THREE from 'three';
import { MOON_RADIUS_KM, type LightingSnapshot } from './lightingSnapshot';

export interface FlightInputState {
  thrustForward: number;
  thrustRight: number;
  thrustRadial: number;
  lookYaw: number;
  lookPitch: number;
  boost: boolean;
  brake: boolean;
}

export const ZERO_INPUT: FlightInputState = {
  thrustForward: 0,
  thrustRight: 0,
  thrustRadial: 0,
  lookYaw: 0,
  lookPitch: 0,
  boost: false,
  brake: false,
};

export interface FlightState {
  altitudeKm: number;
  speedKmS: number;
  boost: boolean;
}

const ECLIPTIC_NORTH = new THREE.Vector3(0, 0, 1);
const ORBIT_ALTITUDE_KM = 5000;
const MAX_ALTITUDE_KM = 10000;
const MIN_ALTITUDE_KM = 0.3;
const MIN_SPEED_KM_S = 0.005;        // 5 m/s at the surface
const MAX_SPEED_KM_S = 5;            // 5 km/s at orbit altitude
const BOOST_MULTIPLIER = 10;
const THRUST_ACCEL_KM_S2 = 0.5;      // body-frame thrust magnitude
const BRAKE_DECAY_PER_SEC = 3;
const PITCH_LIMIT = Math.PI / 2 - 0.01;

/**
 * Auto-leveled free-fly controller for moon flight.
 *
 * State is yaw (around the radial-out axis) + pitch (around the local right
 * axis). The camera's screen-up tracks the radial direction, so the horizon
 * stays level regardless of where the moon is in world space — the player
 * never ends up upside-down.
 */
export class FlightController {
  private position = new THREE.Vector3();
  private velocity = new THREE.Vector3();
  private headingYaw = 0;
  private pitch = 0;
  private boostActive = false;
  private quat = new THREE.Quaternion();

  initializeFromSnapshot(snap: LightingSnapshot): void {
    const earthDir = snap.earthDir.clone().normalize();
    const tiltRaw = ECLIPTIC_NORTH.clone().multiplyScalar(0.85)
      .add(snap.sunDir.clone().multiplyScalar(0.4));
    const tilt = tiltRaw.sub(earthDir.clone().multiplyScalar(tiltRaw.dot(earthDir))).normalize();
    const camDir = earthDir.clone().multiplyScalar(-0.93)
      .add(tilt.multiplyScalar(0.367))
      .normalize();
    const orbitRadiusKm = MOON_RADIUS_KM + ORBIT_ALTITUDE_KM;
    this.position.copy(camDir).multiplyScalar(orbitRadiusKm);
    this.velocity.set(0, 0, 0);
    this.boostActive = false;

    // Recover (yaw, pitch) from "look at origin".
    const lookDir = this.position.clone().negate().normalize();
    const radial = this.position.clone().normalize();
    const sinPitch = lookDir.dot(radial);
    this.pitch = Math.asin(THREE.MathUtils.clamp(sinPitch, -1, 1));

    const lookTangent = lookDir.clone().sub(radial.clone().multiplyScalar(sinPitch));
    if (lookTangent.length() < 1e-4) {
      this.headingYaw = 0;
    } else {
      lookTangent.normalize();
      const refNorth = this.referenceNorth(radial);
      const refRight = new THREE.Vector3().crossVectors(refNorth, radial);
      this.headingYaw = Math.atan2(lookTangent.dot(refRight), lookTangent.dot(refNorth));
    }
  }

  update(dt: number, input: FlightInputState): void {
    this.boostActive = input.boost;

    this.headingYaw += input.lookYaw;
    this.pitch += input.lookPitch;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -PITCH_LIMIT, PITCH_LIMIT);

    const radial = this.position.clone().normalize();
    const refNorth = this.referenceNorth(radial);
    const tangentForward = refNorth.clone().applyAxisAngle(radial, this.headingYaw);
    const tangentRight = new THREE.Vector3().crossVectors(tangentForward, radial);
    const lookForward = tangentForward.clone().applyAxisAngle(tangentRight, -this.pitch);
    const localUp = new THREE.Vector3().crossVectors(tangentRight, lookForward).normalize();

    const m = new THREE.Matrix4().makeBasis(tangentRight, localUp, lookForward.clone().negate());
    this.quat.setFromRotationMatrix(m);

    const boostMul = this.boostActive ? BOOST_MULTIPLIER : 1;
    const accelMag = THRUST_ACCEL_KM_S2 * boostMul;
    const accel = new THREE.Vector3();
    accel.addScaledVector(lookForward, input.thrustForward);
    accel.addScaledVector(tangentRight, input.thrustRight);
    accel.addScaledVector(radial, input.thrustRadial);
    this.velocity.addScaledVector(accel, accelMag * dt);

    if (input.brake) {
      this.velocity.multiplyScalar(Math.exp(-BRAKE_DECAY_PER_SEC * dt));
    }

    const altitude = Math.max(0, this.position.length() - MOON_RADIUS_KM);
    const altFrac = THREE.MathUtils.clamp(altitude / ORBIT_ALTITUDE_KM, 0, 1);
    const baseMaxSpeed = THREE.MathUtils.lerp(MIN_SPEED_KM_S, MAX_SPEED_KM_S, altFrac);
    const maxSpeed = baseMaxSpeed * boostMul;
    const speed = this.velocity.length();
    if (speed > maxSpeed) {
      this.velocity.multiplyScalar(maxSpeed / speed);
    }

    this.position.addScaledVector(this.velocity, dt);

    this.clampRadius(MOON_RADIUS_KM + MIN_ALTITUDE_KM, true);
    this.clampRadius(MOON_RADIUS_KM + MAX_ALTITUDE_KM, false);
  }

  applyToCamera(camera: THREE.PerspectiveCamera): void {
    camera.position.copy(this.position);
    camera.quaternion.copy(this.quat);
    const altitude = Math.max(0, this.position.length() - MOON_RADIUS_KM);
    camera.near = Math.max(0.01, altitude * 0.01);
    camera.far = Math.max(8000, altitude * 4 + 8000);
    camera.updateProjectionMatrix();
  }

  getState(): FlightState {
    return {
      altitudeKm: Math.max(0, this.position.length() - MOON_RADIUS_KM),
      speedKmS: this.velocity.length(),
      boost: this.boostActive,
    };
  }

  private referenceNorth(radial: THREE.Vector3): THREE.Vector3 {
    const proj = ECLIPTIC_NORTH.clone()
      .sub(radial.clone().multiplyScalar(ECLIPTIC_NORTH.dot(radial)));
    if (proj.length() < 0.01) {
      const fallback = new THREE.Vector3(1, 0, 0);
      proj.copy(fallback).sub(radial.clone().multiplyScalar(fallback.dot(radial)));
    }
    return proj.normalize();
  }

  /** If clampMin, push outward when r<limit; else push inward when r>limit. Cancels velocity along the violated axis. */
  private clampRadius(limitKm: number, clampMin: boolean): void {
    const r = this.position.length();
    const violated = clampMin ? r < limitKm : r > limitKm;
    if (!violated) return;
    this.position.multiplyScalar(limitKm / r);
    const radial = this.position.clone().normalize();
    const radialVel = this.velocity.dot(radial);
    if ((clampMin && radialVel < 0) || (!clampMin && radialVel > 0)) {
      this.velocity.addScaledVector(radial, -radialVel);
    }
  }
}
