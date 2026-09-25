/**
 * The CPU pick for the Look-inside tool (plan §5, Picking): a pointer ray
 * against exactly what the studio draws — ONE wedge taken out of the whole
 * body — read off the same cut frame and the same display radii the shaders
 * read, so a hover can never land on a discarded skin fragment or reach a
 * region through an intact hemisphere. No GPU readback: a readback would
 * cost a stall every pointer move, and the geometry here is two surface
 * kinds of closed form.
 *
 * The cut removes the wedge from every layer alike, so those two kinds are
 * all there is:
 *   the skin   the unit sphere, gone wherever the wedge opens (insideWedge,
 *              the very test the skin's shader applies per fragment). It
 *              stands for the outermost drawn region, at display radius 1.
 *   the faces  two half-discs of radius 1 on the wedge's bounding planes,
 *              each running from the hinge along +radial, front side only.
 *              One flat cut through the whole body, so a face shows every
 *              region and the one at a hit is whichever the hit RADIUS
 *              falls in — which is how the shader resolves that fragment.
 * The nearest surviving hit along the ray wins, because that is what the
 * depth buffer does with the same surfaces. Everything is in the studio's
 * world space, where the body is a unit sphere at the origin. Like the
 * scene, the pick draws at most MAX_REGIONS regions (the validator refuses
 * more), so a hit never names a region the faces do not show.
 */
import * as THREE from 'three';
import { createCutFaceBasis, cutFaceBasis, insideWedge, type CutFaceSide, type CutFrame } from './cutFrame';
import { MAX_REGIONS } from './data/interiorTypes';

export interface PickLayout {
  /** The full-angle cut frame, as applied to the scene (after the yaw). */
  frame: CutFrame;
  /** Display-space outer radii, inside-out and increasing; the last is 1. */
  outerDisplay: readonly number[];
}

export type PickSurface = 'face' | 'skin';

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

/** The region whose display shell contains a radius: the first whose outer
 *  radius reaches it, among the regions that are drawn. */
export function regionIndexAtRadius(outerDisplay: readonly number[], radiusDisplay: number): number {
  const count = drawnRegionCount(outerDisplay);
  for (let index = 0; index < count; index++) {
    if (radiusDisplay <= outerDisplay[index]) return index;
  }
  return count - 1;
}

/** How many of the regions the studio draws: the scene's own cap. */
export function drawnRegionCount(outerDisplay: readonly number[]): number {
  return Math.min(outerDisplay.length, MAX_REGIONS);
}

/** The two faces as a constant, so the loop below allocates nothing. */
const FACE_SIDES: readonly CutFaceSide[] = ['a', 'b'];

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
  const count = drawnRegionCount(layout.outerDisplay);
  if (count === 0) return null;
  const frame = layout.frame;
  let bestDistance = Infinity;
  let found = false;

  // The skin: the sphere's near side, unless the cut removed it there. Only
  // the near root is tried: the skin is drawn FrontSide (InteriorScene's
  // standard material), so the far side's inside is culled and a ray through
  // a removed near side meets the faces, never the far skin. A skin drawn
  // double-sided would need the far root tested here too.
  // (The far root is essentially never inside the wedge itself — a near point on
  // the view axis has its far point at wedge angle ~π — so the wedge is not what
  // keeps it unpickable.)
  const skinDistance = sphereNearDistance(origin, direction, 1);
  if (skinDistance > 0) {
    scratchPoint.copy(origin).addScaledVector(direction, skinDistance);
    if (!insideWedge(frame, scratchPoint)) {
      bestDistance = skinDistance;
      found = true;
      out.surface = 'skin';
      out.regionIndex = count - 1;
      out.radiusDisplay = 1;
      out.distance = skinDistance;
      out.point.copy(scratchPoint);
    }
  }

  // The two faces: the front side of a half-disc plane through the origin,
  // at the FULL opening angle — one plane for every region, so which region
  // answers follows from the hit's radius and never from which face it was.
  if (frame.openingAngle > 0) {
    for (const side of FACE_SIDES) {
      const basis = cutFaceBasis(frame, side, faceBasis);
      const facing = direction.dot(basis.normal);
      if (facing >= -EPSILON) continue; // back side or edge-on
      const faceDistance = -origin.dot(basis.normal) / facing;
      if (faceDistance <= EPSILON || faceDistance >= bestDistance) continue;
      scratchPoint.copy(origin).addScaledVector(direction, faceDistance);
      // The other half of the disc — with a tolerance, so the hinge line, where the two
      // half-discs meet and a ray through the centre lands on a rounding hair either side
      // of both, belongs to the faces rather than to neither.
      if (scratchPoint.dot(basis.radial) < -EPSILON) continue;
      const hitRadius = scratchPoint.length();
      if (hitRadius > 1) continue; // past the rim: the plane runs on, the face does not
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
