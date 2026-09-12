/**
 * The cut frame of the Look-inside tool: where a body is opened, expressed
 * independently of the body's own scientific pose.
 *
 * A hinge axis runs through the body's centre, and the removed wedge opens
 * symmetrically about the view axis by an opening angle θ. Both section faces
 * and the exterior skin's discard read this one frame every frame (as two
 * unit axes and the half-angle), so they can never disagree about where the
 * cut is, and the CPU pick uses the same test the shader does (insideWedge).
 *
 * The v1 hinge is the camera's own up axis: orbiting in azimuth turns the
 * body under a cut that keeps facing the viewer, orbiting in elevation
 * carries the cut with the camera, and nothing flips at the poles because a
 * camera's local up is always perpendicular to its view direction. A
 * body-locked cut (a chosen meridian) is a later option.
 *
 * The three named views are geometry, not limits of a formula:
 *   Closed    θ = 0     no faces are drawn and the skin is whole
 *   Cutaway   θ = 120°  two faces, each 60° off the view axis: the terraces read as
 *                       stepped ledges and the core shows whole, where 90° left it a sliver
 *   Section   θ = 180°  one full disc perpendicular to the view axis; the
 *                       near hemisphere is removed
 *
 * Basis: (view, side, hinge) is right-handed with side = hinge × view. A
 * rotation about the hinge by α carries view to cos α·view + sin α·side.
 * Face A lies at +θ/2 from the view axis, face B at −θ/2; each face's normal
 * points into the removed wedge, i.e. toward the viewer.
 *
 * Pure: no DOM, no renderer, only three's vector math.
 */
import * as THREE from 'three';
import { DEG2RAD } from '../shared/math/angles';

export type CutView = 'closed' | 'cutaway' | 'section';

export const CUT_VIEWS: readonly CutView[] = ['closed', 'cutaway', 'section'];

/** The opening angle each named view sets, in degrees. */
export const CUT_VIEW_ANGLE_DEG: Readonly<Record<CutView, number>> = {
  closed: 0,
  cutaway: 120,
  section: 180,
};

export const MAX_OPENING_ANGLE_DEG = 180;

/** Which named view an opening angle stands for, or null between them. */
export function cutViewForAngle(openingAngleDeg: number, toleranceDeg = 0.5): CutView | null {
  for (const view of CUT_VIEWS) {
    if (Math.abs(openingAngleDeg - CUT_VIEW_ANGLE_DEG[view]) <= toleranceDeg) return view;
  }
  return null;
}

export interface CutFrame {
  /** Unit vector from the body centre toward the camera. */
  view: THREE.Vector3;
  /** Unit hinge axis: the camera's up, made perpendicular to `view`. */
  hinge: THREE.Vector3;
  /** Unit vector hinge × view: with `view` it spans the plane the wedge opens in. */
  side: THREE.Vector3;
  /** Opening angle θ in radians, clamped to [0, π]. */
  openingAngle: number;
}

export function createCutFrame(): CutFrame {
  return {
    view: new THREE.Vector3(0, 0, 1),
    hinge: new THREE.Vector3(0, 1, 0),
    side: new THREE.Vector3(1, 0, 0),
    openingAngle: 0,
  };
}

const fallbackUp = new THREE.Vector3();

/**
 * Build the frame for a camera looking at a body. `cameraLocalUp` is the
 * camera's OWN up axis in world space (its local +Y), not the scene's world
 * up: the local axis is perpendicular to the line of sight by construction,
 * so the hinge is defined at every elevation. Should a caller nevertheless
 * pass an up parallel to the view, any perpendicular axis stands in.
 */
export function computeCutFrame(
  cameraPosition: THREE.Vector3,
  cameraLocalUp: THREE.Vector3,
  bodyCentre: THREE.Vector3,
  openingAngleRad: number,
  out: CutFrame = createCutFrame(),
): CutFrame {
  out.view.subVectors(cameraPosition, bodyCentre);
  if (out.view.lengthSq() < 1e-20) out.view.set(0, 0, 1);
  out.view.normalize();
  // Gram–Schmidt the up against the view so the hinge is exactly perpendicular.
  out.hinge.copy(cameraLocalUp).addScaledVector(out.view, -cameraLocalUp.dot(out.view));
  if (out.hinge.lengthSq() < 1e-12) {
    fallbackUp.set(0, 1, 0);
    if (Math.abs(fallbackUp.dot(out.view)) > 0.9) fallbackUp.set(1, 0, 0);
    out.hinge.copy(fallbackUp).addScaledVector(out.view, -fallbackUp.dot(out.view));
  }
  out.hinge.normalize();
  out.side.crossVectors(out.hinge, out.view).normalize();
  out.openingAngle = THREE.MathUtils.clamp(openingAngleRad, 0, Math.PI);
  return out;
}

export type CutFaceSide = 'a' | 'b';

export interface CutFaceBasis {
  /** In-plane radial direction: the half-disc extends from the hinge along +radial. */
  radial: THREE.Vector3;
  /** The hinge axis, signed so that (radial, up, normal) is right-handed. */
  up: THREE.Vector3;
  /** The face normal, pointing into the removed wedge (toward the viewer). */
  normal: THREE.Vector3;
}

export function createCutFaceBasis(): CutFaceBasis {
  return { radial: new THREE.Vector3(), up: new THREE.Vector3(), normal: new THREE.Vector3() };
}

/**
 * The basis of one section face. Face A sits at +θ/2 from the view axis
 * (toward +side), face B at −θ/2. For both, `normal` points into the wedge:
 *   normal_A = sin(θ/2)·view − cos(θ/2)·side
 *   normal_B = sin(θ/2)·view + cos(θ/2)·side
 * so at Section (θ = π) both normals equal `view` and the two half-discs
 * tile the one disc facing the camera, and at Cutaway each normal is 45°
 * off the view axis. The triple (radial, up, normal) is right-handed, so a
 * half-disc geometry built in +X (radial) × Y (up) with +Z normal maps onto
 * it without a mirror.
 */
export function cutFaceBasis(frame: CutFrame, face: CutFaceSide, out: CutFaceBasis = createCutFaceBasis()): CutFaceBasis {
  const half = frame.openingAngle * 0.5;
  const sign = face === 'a' ? 1 : -1;
  const cosHalf = Math.cos(half);
  const sinHalf = Math.sin(half);
  out.radial.copy(frame.view).multiplyScalar(cosHalf).addScaledVector(frame.side, sign * sinHalf);
  out.normal.copy(frame.view).multiplyScalar(sinHalf).addScaledVector(frame.side, -sign * cosHalf);
  // radial × up must equal normal: for face A that is +hinge, for face B −hinge.
  out.up.copy(frame.hinge).multiplyScalar(sign);
  return out;
}

/**
 * The angle, in the plane the wedge opens in, between a point's direction
 * from the centre and the view axis: 0 on the view axis, π on the far side.
 * The hinge component is ignored (points on the hinge line itself return 0
 * from atan2(0, 0); they are on the cut edge either way).
 */
export function wedgeAngle(frame: CutFrame, offsetFromCentre: THREE.Vector3): number {
  const along = offsetFromCentre.dot(frame.view);
  const across = Math.abs(offsetFromCentre.dot(frame.side));
  return Math.atan2(across, along);
}

/** True where the exterior is removed: inside the open wedge. The same test
 *  the skin shader applies per fragment, so the pick can never land on a
 *  discarded fragment. A closed cut removes nothing. */
export function insideWedge(frame: CutFrame, offsetFromCentre: THREE.Vector3): boolean {
  if (frame.openingAngle <= 0) return false;
  return wedgeAngle(frame, offsetFromCentre) < frame.openingAngle * 0.5;
}

/**
 * The opening angle of a terrace `stepsInward` regions below the crust:
 * each region inward opens `step` of the full angle less, so the layers
 * read as nested spheres, and a region far enough in is closed. The scene's
 * shells and faces and the CPU pick use this one rule.
 */
export function terraceOpeningAngle(openingAngle: number, stepsInward: number, step: number): number {
  return Math.max(0, openingAngle * (1 - stepsInward * step));
}

export function openingAngleDegToRad(deg: number): number {
  return THREE.MathUtils.clamp(deg, 0, MAX_OPENING_ANGLE_DEG) * DEG2RAD;
}

const yawScratch = new THREE.Vector3();

/**
 * Turn the wedge about the hinge by `yawRad`, so it is no longer symmetric
 * about the view axis: one face turns toward the viewer, the other away,
 * and the terraces show on the near face as curved steps rather than a
 * crease looked at head-on. The frame stays orthonormal and the skin, the
 * faces and the pick all read the turned frame, so nothing disagrees.
 */
export function yawCutFrame(frame: CutFrame, yawRad: number): CutFrame {
  if (yawRad === 0) return frame;
  const cosYaw = Math.cos(yawRad);
  const sinYaw = Math.sin(yawRad);
  yawScratch.copy(frame.view).multiplyScalar(cosYaw).addScaledVector(frame.side, sinYaw);
  frame.view.copy(yawScratch).normalize();
  frame.side.crossVectors(frame.hinge, frame.view).normalize();
  return frame;
}
