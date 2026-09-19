/**
 * The cut frame of the Look-inside tool: where a body is opened, expressed
 * independently of the body's own scientific pose.
 *
 * A hinge axis runs through the body's centre, and the removed wedge opens
 * symmetrically about the view axis by an opening angle θ. It is ONE wedge
 * through every layer: the two section faces are half-discs of the body's
 * radius on the wedge's bounding planes, and the section shader resolves the
 * region at a fragment by its radius, so each face shows every layer as a
 * band from the rim to the centre and nothing is stepped. Both faces and the
 * exterior skin's discard read this one frame every frame (as two unit axes
 * and the half-angle), so they can never disagree about where the cut is,
 * and the CPU pick uses the same test the shader does (insideWedge).
 *
 * The three named views are geometry, not limits of a formula:
 *   Closed    θ = 0     no faces are drawn and the skin is whole
 *   Cutaway   θ = 90°   a quarter wedge: two faces at right angles, each
 *                       showing every layer, with the core whole at the corner
 *   Section   θ = 180°  one full disc perpendicular to the view axis; the
 *                       near hemisphere is removed
 *
 * The cut is locked to the body. A frame is chosen from the camera
 * (computeCutFrame: the hinge is the camera's own up, so nothing flips at the
 * poles) once — on entry, at a body swap and at Reset view — turned about the
 * hinge by the mode's yaw (yawCutFrame), and kept as two unit axes in the
 * body's own coordinates (CutAnchor, the inverse of the pose the skin wears).
 * Every frame the world frame is rebuilt from the anchor and the pose
 * (frameFromAnchor), so orbiting the camera turns the body under a cut that
 * stays where it is, as a cut in a solid does; the skin, the faces, the pick
 * and the ruler read the rebuilt frame and nothing disagrees. Looked at from
 * behind, the cut disappears behind the exterior, and Reset view brings it
 * back. The camera-following frame remains as an option (the mode's "Cut
 * faces the camera"), and the way between the two is a short slerp
 * (blendCutFrames) rather than a snap.
 *
 * Basis: (view, side, hinge) is right-handed with side = hinge × view. A
 * rotation about the hinge by α carries view to cos α·view + sin α·side.
 * Face A lies at +θ/2 from the view axis, face B at −θ/2; each face's normal
 * points into the removed wedge, i.e. toward the viewer.
 *
 * The yaw turns the wedge about the hinge so the viewer looks at one face
 * obliquely and along the other rather than straight into the crease: at
 * Cutaway one face is a few tens of degrees off face-on and the other grazes,
 * and at Section the disc is the same few tens of degrees off face-on, which
 * leaves a crescent of the skin's rim standing on one side — without it a
 * Section on a body with no rings and no air (the Moon) is a coloured circle
 * laid over the world rather than a world with its near half taken off. What
 * that costs anything measuring the disc on screen: the disc's extent ALONG
 * the hinge is still its display radius while across the hinge it is
 * foreshortened by cos(yaw). A pixel read of the disc measures along the
 * hinge, or allows for the cosine.
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
  cutaway: 90,
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

export function openingAngleDegToRad(deg: number): number {
  return THREE.MathUtils.clamp(deg, 0, MAX_OPENING_ANGLE_DEG) * DEG2RAD;
}

const yawScratch = new THREE.Vector3();

/**
 * Turn the wedge about the hinge by `yawRad`, so it is no longer symmetric
 * about the view axis: one face turns toward the viewer and the other away,
 * and the viewer looks at a face rather than into a crease. The frame stays
 * orthonormal and the skin, the faces and the pick all read the turned
 * frame, so nothing disagrees.
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

/** Copy a frame's axes and opening into another. */
/**
 * The yaw the cut is drawn with at an opening. The quarter wedge is turned
 * this much about the hinge so one face meets the eye more squarely than the
 * other (a three-quarter view, the face the ruler goes on); a full disc must
 * face the camera exactly, or the skin's far half shows past its edge as a
 * crescent. So the yaw is whole up to the quarter wedge and fades to nothing
 * at Section, on the opening angle — the anchor holds the unyawed frame, and
 * a view change swings the cut as it opens.
 */
export function cutYawRad(openingAngleRad: number, fullYawRad: number): number {
  const quarter = Math.PI / 2;
  if (openingAngleRad <= quarter) return fullYawRad;
  return fullYawRad * Math.max(0, 1 - (openingAngleRad - quarter) / quarter);
}

export function copyCutFrame(from: CutFrame, out: CutFrame): CutFrame {
  out.view.copy(from.view);
  out.hinge.copy(from.hinge);
  out.side.copy(from.side);
  out.openingAngle = from.openingAngle;
  return out;
}

// --- the body lock ------------------------------------------------------------

export interface CutAnchor {
  /** The view axis in the body's own coordinates (unit). */
  view: THREE.Vector3;
  /** The hinge axis in the body's own coordinates (unit, perpendicular to `view`). */
  hinge: THREE.Vector3;
}

export function createCutAnchor(): CutAnchor {
  return { view: new THREE.Vector3(0, 0, 1), hinge: new THREE.Vector3(0, 1, 0) };
}

const inversePose = new THREE.Quaternion();

/**
 * Keep a world frame in the body's coordinates: the axes turned by the
 * inverse of the pose the skin wears, so that frameFromAnchor with the same
 * pose gives the frame back, and with a later pose gives the same cut in the
 * turned body.
 */
export function anchorCutFrame(frame: CutFrame, bodyPose: THREE.Quaternion, out: CutAnchor = createCutAnchor()): CutAnchor {
  inversePose.copy(bodyPose).invert();
  out.view.copy(frame.view).applyQuaternion(inversePose).normalize();
  out.hinge.copy(frame.hinge).applyQuaternion(inversePose);
  out.hinge.addScaledVector(out.view, -out.hinge.dot(out.view)).normalize();
  return out;
}

/**
 * The world frame of an anchored cut under the body's current pose, at an
 * opening angle. The hinge is re-orthogonalised against the view so rounding
 * over many poses can never shear the basis, and `side` follows from the two.
 */
export function frameFromAnchor(anchor: CutAnchor, bodyPose: THREE.Quaternion, openingAngleRad: number, out: CutFrame = createCutFrame()): CutFrame {
  out.view.copy(anchor.view).applyQuaternion(bodyPose).normalize();
  out.hinge.copy(anchor.hinge).applyQuaternion(bodyPose);
  out.hinge.addScaledVector(out.view, -out.hinge.dot(out.view)).normalize();
  out.side.crossVectors(out.hinge, out.view).normalize();
  out.openingAngle = THREE.MathUtils.clamp(openingAngleRad, 0, Math.PI);
  return out;
}

const blendMatrix = new THREE.Matrix4();
const blendFrom = new THREE.Quaternion();
const blendTo = new THREE.Quaternion();

/** The frame's axes as one rotation: the basis (side, hinge, view), which is right-handed. */
export function frameQuaternion(frame: CutFrame, out: THREE.Quaternion = new THREE.Quaternion()): THREE.Quaternion {
  blendMatrix.makeBasis(frame.side, frame.hinge, frame.view);
  return out.setFromRotationMatrix(blendMatrix);
}

/**
 * The frame part-way from one to another: a slerp of their rotations, so the
 * axes turn together along the shortest arc and stay orthonormal throughout
 * — the way "Cut faces the camera" swings a locked cut round to the camera
 * rather than snapping it. The opening angle is `to`'s; `t` is clamped to [0, 1].
 */
export function blendCutFrames(from: CutFrame, to: CutFrame, t: number, out: CutFrame = createCutFrame()): CutFrame {
  const amount = THREE.MathUtils.clamp(t, 0, 1);
  frameQuaternion(from, blendFrom);
  frameQuaternion(to, blendTo);
  blendFrom.slerp(blendTo, amount);
  blendMatrix.makeRotationFromQuaternion(blendFrom);
  blendMatrix.extractBasis(out.side, out.hinge, out.view);
  out.side.normalize();
  out.hinge.normalize();
  out.view.normalize();
  out.openingAngle = to.openingAngle;
  return out;
}
