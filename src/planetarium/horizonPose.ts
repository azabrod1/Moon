/**
 * The geometry of a view along the sea from a height: where the Sun's mirror
 * point lies on a sphere for a camera standing above it, and the horizon's
 * dip. Pure, so the dev pose that uses it (PlanetariumMode.devHorizonView)
 * and a probe that re-runs the same equations on the CPU share one
 * derivation.
 *
 * Everything is in one frame with the Sun at a FINITE position (the app's
 * point light sits at the heliocentric origin), so the Sun's direction is
 * taken afresh at every point rather than as one parallel beam: the
 * difference is the body's radius over an astronomical unit, four
 * hundred-thousandths of a radian, and taking it exactly costs nothing.
 */
import * as THREE from 'three';

export interface MirrorPoint {
  /** The angle at the body's centre between the stand point's vertical and
   *  the mirror point, radians. */
  groundAngle: number;
  /** The mirror point's depression below the camera's horizontal, radians. */
  depression: number;
  /** The Sun's elevation above the mirror point's own horizon, radians. */
  sunElevation: number;
  /** The camera's distance from the mirror point, in the frame's units. */
  slant: number;
  /** The mirror point itself, in the frame. */
  point: THREE.Vector3;
}

/** The angle below the horizontal at which the horizon lies, for a camera
 *  `height` above a sphere of `radius`. */
export function horizonDip(radius: number, height: number): number {
  return Math.acos(Math.min(radius / (radius + height), 1));
}

/**
 * The Sun's mirror point on a sphere, in the plane of the Sun and the
 * vertical: the place whose surface normal bisects the directions to the Sun
 * and to the camera. `up` is the stand point's vertical (unit), `sunAzimuth`
 * the Sun's direction projected onto the stand point's horizon (unit), and
 * `camera` sits at `body + up * (radius + height)`. Found by bisection on the
 * ground angle: the bisector error rises from negative under the camera (the
 * camera is straight up there, the Sun lower) to positive at the horizon
 * wherever the Sun is above that horizon, so a root inside means the beam's
 * heart lies on the sphere; null means the Sun is below the horizon seen from
 * the horizon point, and there is no glint in the view at all.
 */
export function mirrorPointOnSphere(
  body: THREE.Vector3,
  radius: number,
  camera: THREE.Vector3,
  up: THREE.Vector3,
  sunAzimuth: THREE.Vector3,
  sun: THREE.Vector3,
): MirrorPoint | null {
  const height = camera.distanceTo(body) - radius;
  const horizon = horizonDip(radius, height);
  const normal = new THREE.Vector3();
  const point = new THREE.Vector3();
  const view = new THREE.Vector3();
  const toSun = new THREE.Vector3();
  const at = (theta: number) => {
    normal.copy(up).multiplyScalar(Math.cos(theta)).addScaledVector(sunAzimuth, Math.sin(theta)).normalize();
    point.copy(body).addScaledVector(normal, radius);
    view.copy(camera).sub(point);
    const slant = view.length();
    view.multiplyScalar(1 / slant);
    toSun.copy(sun).sub(point).normalize();
    return { slant, f: normal.dot(toSun) - normal.dot(view) };
  };
  let lo = 0;
  let hi = horizon;
  if (!(at(lo).f < 0 && at(hi).f > 0)) return null;
  for (let i = 0; i < 64; i++) {
    const mid = 0.5 * (lo + hi);
    if (at(mid).f < 0) lo = mid; else hi = mid;
  }
  const groundAngle = 0.5 * (lo + hi);
  const { slant } = at(groundAngle);
  const aim = point.clone().sub(camera).normalize();
  return {
    groundAngle,
    depression: Math.asin(THREE.MathUtils.clamp(-aim.dot(up), -1, 1)),
    sunElevation: Math.asin(THREE.MathUtils.clamp(normal.dot(toSun), -1, 1)),
    slant,
    point: point.clone(),
  };
}
