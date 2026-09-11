/**
 * The CPU pick for the Look-inside tool (plan §5, Picking): a pointer ray
 * against exactly what the studio draws — the terraced cut — using the same
 * cut frame, the same terrace rule and the same display radii as the
 * shaders, so a hover can never land on a discarded skin fragment, on a
 * face hidden under the shell above it, or on a far-side region through an
 * intact hemisphere. No GPU readback.
 *
 * The drawn geometry, inside-out region k of n with display radius R_k:
 *   its shell   a sphere of radius R_k, removed inside its own wedge
 *               (terraceOpeningAngle(θ, n−1−k)); region n−1's shell is the
 *               skin
 *   its faces   two half-discs of radius R_k on the wedge's bounding planes,
 *               each extending from the hinge along +radial, front side only
 * A face shows whichever region the hit radius falls in (the shader resolves
 * by radius), and the nearest surviving hit along the ray wins, which is
 * what the depth buffer does. Everything here is in the studio's world
 * space, where the body is a unit sphere at the origin.
 */
import * as THREE from 'three';
import { createCutFaceBasis, createCutFrame, cutFaceBasis, terraceOpeningAngle, wedgeAngle, type CutFrame } from './cutFrame';

export interface PickLayout {
  /** The full-angle cut frame, as applied to the scene (after the yaw). */
  frame: CutFrame;
  /** Display-space outer radii, inside-out and increasing; the last is 1. */
  outerDisplay: readonly number[];
  /** The terrace step the scene uses (InteriorScene.TERRACE_STEP). */
  terraceStep: number;
}

export type PickSurface = 'face' | 'shell' | 'skin';

export interface PickHit {
  surface: PickSurface;
  /** The inside-out index of the region the surface shows at the hit. */
  regionIndex: number;
  /** The hit's radius from the body centre, display space (0..1). */
  radiusDisplay: number;
  /** Distance along the ray. */
  distance: number;
  point: THREE.Vector3;
}

export function createPickHit(): PickHit {
  return { surface: 'skin', regionIndex: 0, radiusDisplay: 0, distance: Infinity, point: new THREE.Vector3() };
}

/** The region whose display shell contains a radius: the first whose outer radius reaches it. */
export function regionIndexAtRadius(outerDisplay: readonly number[], radiusDisplay: number): number {
  for (let index = 0; index < outerDisplay.length; index++) {
    if (radiusDisplay <= outerDisplay[index]) return index;
  }
  return outerDisplay.length - 1;
}

const terraceFrame = createCutFrame();
const faceBasis = createCutFaceBasis();
const scratchPoint = new THREE.Vector3();
const EPSILON = 1e-7;

/** The near intersection distance of a ray with a sphere at the origin, or −1 for none ahead of the origin. */
function sphereNearDistance(origin: THREE.Vector3, direction: THREE.Vector3, radius: number): number {
  // |o + t d|² = r² with |d| = 1: t² + 2(o·d)t + (o·o − r²) = 0.
  const b = origin.dot(direction);
  const c = origin.lengthSq() - radius * radius;
  const discriminant = b * b - c;
  if (discriminant < 0) return -1;
  const root = Math.sqrt(discriminant);
  const near = -b - root;
  if (near > EPSILON) return near;
  const far = -b + root;
  return far > EPSILON ? far : -1;
}

/**
 * The nearest visible surface along a ray, or null when the ray misses the
 * body. `origin` and `direction` (unit) are in studio world space.
 */
export function pickInterior(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  layout: PickLayout,
  out: PickHit = createPickHit(),
): PickHit | null {
  const count = layout.outerDisplay.length;
  if (count === 0) return null;
  let bestDistance = Infinity;
  let found = false;
  terraceFrame.view.copy(layout.frame.view);
  terraceFrame.side.copy(layout.frame.side);
  terraceFrame.hinge.copy(layout.frame.hinge);
  for (let index = 0; index < count; index++) {
    const radius = layout.outerDisplay[index];
    const angle = terraceOpeningAngle(layout.frame.openingAngle, count - 1 - index, layout.terraceStep);
    terraceFrame.openingAngle = angle;

    // The shell: the sphere's near side, unless the cut removed it there.
    const shellDistance = sphereNearDistance(origin, direction, radius);
    if (shellDistance > 0 && shellDistance < bestDistance) {
      scratchPoint.copy(origin).addScaledVector(direction, shellDistance);
      const removed = angle > 0 && wedgeAngle(terraceFrame, scratchPoint) < angle * 0.5;
      if (!removed) {
        bestDistance = shellDistance;
        found = true;
        out.surface = index === count - 1 ? 'skin' : 'shell';
        out.regionIndex = index;
        out.radiusDisplay = radius;
        out.distance = shellDistance;
        out.point.copy(scratchPoint);
      }
    }

    if (angle <= 0) continue;
    // The two faces: front side of a half-disc plane through the origin.
    for (const side of ['a', 'b'] as const) {
      const basis = cutFaceBasis(terraceFrame, side, faceBasis);
      const facing = direction.dot(basis.normal);
      if (facing >= -EPSILON) continue; // back side or edge-on
      const faceDistance = -origin.dot(basis.normal) / facing;
      if (faceDistance <= EPSILON || faceDistance >= bestDistance) continue;
      scratchPoint.copy(origin).addScaledVector(direction, faceDistance);
      if (scratchPoint.dot(basis.radial) < 0) continue; // the other half of the disc
      const hitRadius = scratchPoint.length();
      if (hitRadius > radius) continue;
      bestDistance = faceDistance;
      found = true;
      out.surface = 'face';
      out.regionIndex = regionIndexAtRadius(layout.outerDisplay, hitRadius);
      out.radiusDisplay = hitRadius;
      out.distance = faceDistance;
      out.point.copy(scratchPoint);
    }
  }
  return found ? out : null;
}
