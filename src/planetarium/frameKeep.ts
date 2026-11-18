/**
 * Frame-keeping for a teleport arrival: how far the cruise camera must turn
 * toward the destination to keep it framed on screen.
 *
 * Why it exists. A teleport parks the ship with its heading aimed past the
 * destination (the flyby offset, up to ~12° for a planet and ~16° for the
 * smallest moons), and the arrival look is deliberately un-engaged at the
 * standoff, so the destination lands wherever that offset puts it. The offset
 * points wherever the composition needs it: straight up for a planet without
 * rings, along the ring axis for a ringed one, toward the parent for a moon.
 * A desktop window has room for any of those, but a phone held upright shows
 * only about ±15° across against its 60° height, so a sideways offset put
 * Uranus, Deimos and Phobos at or past the edge of the screen, where the
 * approach (whose off-axis angle grows as it closes) carried them further out
 * until the tracking shot engaged seconds later.
 *
 * What it computes. The smallest rotation of the camera's aim, along the great
 * circle from the aim toward the destination, after which the destination is
 * framed: on each screen axis its disc either fits inside the frame inset by
 * FRAME_KEEP_MARGIN or, once it is wider than that inset, covers it from edge
 * to edge. The two conditions meet exactly where the disc's width equals the
 * inset's (both then demand it centred on that axis), so the turn is
 * continuous as an approaching disc outgrows a phone's width. Zero whenever
 * the destination is already framed, which is every desktop arrival, every
 * planet without rings (centred across, and covering a phone's width once it
 * outgrows it), and the big moons on a phone, so in those cases the arrival
 * is the settled chase pose exactly as before.
 *
 * How it measures. Through the same output lens the renderer draws with (see
 * shared/math/lensProjection.ts): a direction θ off the axis at screen
 * azimuth φ lands at R(θ)/R(edge)·(cos φ / aspect, sin φ) in output NDC, where
 * the design FOV's half-angle is the frame's top and bottom edge. A disc's
 * extreme points along its own azimuth sit at θ ± ρ, so its radial span is
 * exact; at full stereographic strength (the default) the disc draws as a
 * circle, and at any blend its radial extent is the larger one, so the circle
 * built from the radial span always contains the drawn disc (for the
 * fitting test; the covering test is exact only at full strength, and the
 * blend only falls short of it when a body over ~45° of radius fades the
 * lens, by which time the tracking shot owns the frame). The camera's roll
 * comes from the cruise up axis, as the chase rig's lookAt takes it.
 *
 * Bounds. The keep never turns the camera to face a destination that has
 * swung far off the aim (it fades out between FRAME_KEEP_FADE_START_RAD and
 * FRAME_KEEP_FADE_END_RAD): it keeps an approaching destination in frame and
 * is not a way to look behind the ship. Pure: no THREE scene state, and it
 * allocates nothing per call.
 */
import * as THREE from 'three';
import { DEG2RAD } from '../shared/math/angles';
import { lensRadial } from '../shared/math/lensProjection';

/** The frame the keep fits into: the displayed vertical FOV (displayFovDeg,
 *  never camera.fov), the canvas aspect, and the lens's EFFECTIVE strength. */
export interface FrameKeepView {
  designFovDeg: number;
  aspect: number;
  lensStrength: number;
}

/** Inset from every edge, as a fraction of the frame's half-height, so the
 *  same number of pixels on all four sides: about 25 px on an upright phone
 *  and 24 px on a 1280×800 window. Enough that a kept disc reads as framed
 *  rather than as touching the edge. */
export const FRAME_KEEP_MARGIN = 0.06;

/** Off-axis angles over which the keep fades out. An approaching destination
 *  stays well inside the start (a planet at half its arrival distance sits
 *  ~23° off the heading, and by then the tracking shot has taken over); the
 *  fade only guards against the keep ever swinging the camera round toward a
 *  body beside or behind the ship. */
export const FRAME_KEEP_FADE_START_RAD = 60 * DEG2RAD;
export const FRAME_KEEP_FADE_END_RAD = 85 * DEG2RAD;

/** Past this off-axis angle the lens map is near its representable limit
 *  (lensProjection saturates at 88°); a disc edge beyond it is measured as
 *  if it stopped here. */
const MAX_DISC_EDGE_RAD = 87 * DEG2RAD;

/** Bisection steps: 2^-24 of the off-axis angle, far below a pixel. */
const BISECTION_STEPS = 24;

const tmpPerp = new THREE.Vector3();
const tmpAim = new THREE.Vector3();
const tmpCamX = new THREE.Vector3();
const tmpCamY = new THREE.Vector3();
const tmpCamZ = new THREE.Vector3();

interface FitLimits {
  rEdge: number;
  limitX: number;
  limitY: number;
  strength: number;
}
const limits: FitLimits = { rEdge: 1, limitX: 0, limitY: 0, strength: 0 };

/** Fill `limits` for a view; false when the inset frame is empty. */
function prepareLimits(view: FrameKeepView, margin: number): boolean {
  const strength = Math.min(Math.max(view.lensStrength, 0), 1);
  const halfFov = (view.designFovDeg / 2) * DEG2RAD;
  if (!(halfFov > 0) || !(view.aspect > 0)) return false;
  limits.strength = strength;
  limits.rEdge = lensRadial(halfFov, strength);
  limits.limitX = view.aspect - margin;
  limits.limitY = 1 - margin;
  return limits.rEdge > 0 && limits.limitX > 0 && limits.limitY > 0;
}

/**
 * True when a disc of angular radius `discRadiusRad` in unit direction
 * `bodyDir` is framed by a camera aimed along unit `aimDir` with up axis `up`:
 * on each axis it fits inside the inset frame, or covers it when wider than
 * it. Reads `limits` (prepareLimits first).
 */
function discFits(
  aimDir: THREE.Vector3,
  bodyDir: THREE.Vector3,
  discRadiusRad: number,
  up: THREE.Vector3,
): boolean {
  // three's lookAt basis for a camera: z points back along the aim, x is
  // up × z, y completes the frame. Aimed along the up axis the roll is
  // undefined; any fixed perpendicular stands in (the chase never pitches
  // that far, so this only keeps the arithmetic finite).
  tmpCamZ.copy(aimDir).negate();
  tmpCamX.crossVectors(up, tmpCamZ);
  if (tmpCamX.lengthSq() < 1e-18) {
    tmpCamX.set(1, 0, 0).addScaledVector(tmpCamZ, -tmpCamZ.x);
    if (tmpCamX.lengthSq() < 1e-18) tmpCamX.set(0, 0, 1).addScaledVector(tmpCamZ, -tmpCamZ.z);
  }
  tmpCamX.normalize();
  tmpCamY.crossVectors(tmpCamZ, tmpCamX);

  const offAxis = Math.acos(THREE.MathUtils.clamp(bodyDir.dot(aimDir), -1, 1));
  // Past the lens map's representable range the drawn edge is off any frame
  // anyway; clamping there understates the disc, which only ever makes the
  // test stricter.
  const outer = Math.min(offAxis + discRadiusRad, MAX_DISC_EDGE_RAD);
  const inner = offAxis - discRadiusRad; // negative when the disc covers the axis
  const rOuter = lensRadial(outer, limits.strength);
  const rInner = lensRadial(inner, limits.strength); // odd in its angle
  const centre = (rOuter + rInner) / (2 * limits.rEdge);
  const radius = (rOuter - rInner) / (2 * limits.rEdge);

  const screenX = bodyDir.dot(tmpCamX);
  const screenY = bodyDir.dot(tmpCamY);
  const lateral = Math.hypot(screenX, screenY);
  const cosAzimuth = lateral > 1e-12 ? screenX / lateral : 1;
  const sinAzimuth = lateral > 1e-12 ? screenY / lateral : 0;
  // Fits: |c| + r ≤ limit. Covers: r − |c| ≥ limit. Together: |c| ≤ |limit − r|.
  return (
    Math.abs(centre * cosAzimuth) <= Math.abs(limits.limitX - radius) &&
    Math.abs(centre * sinAzimuth) <= Math.abs(limits.limitY - radius)
  );
}

/** `aimDir` turned by `angle` toward `bodyDir` along their great circle,
 *  given the unit perpendicular of that circle. Writes `out`. */
function turnToward(
  aimDir: THREE.Vector3,
  perp: THREE.Vector3,
  angle: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  return out.copy(aimDir).multiplyScalar(Math.cos(angle)).addScaledVector(perp, Math.sin(angle));
}

/**
 * The rotation, in radians, to turn unit `aimDir` toward unit `bodyDir` (along
 * their great circle) so a disc of angular radius `discRadiusRad` there is
 * framed — fitting inside the frame inset by `margin` (fraction of the
 * half-height), or covering it on an axis it is wider than. 0 when it already
 * is; faded to 0 for a body far off the aim (see the header). `up` is the
 * camera's up axis.
 */
export function frameKeepAngle(
  aimDir: THREE.Vector3,
  bodyDir: THREE.Vector3,
  discRadiusRad: number,
  up: THREE.Vector3,
  view: FrameKeepView,
  margin = FRAME_KEEP_MARGIN,
): number {
  if (!prepareLimits(view, margin)) return 0;
  const radius = Math.min(Math.max(discRadiusRad, 0), Math.PI / 2);
  const offAxis = Math.acos(THREE.MathUtils.clamp(aimDir.dot(bodyDir), -1, 1));
  if (!(offAxis > 1e-9)) return 0;
  if (offAxis >= FRAME_KEEP_FADE_END_RAD) return 0;
  if (discFits(aimDir, bodyDir, radius, up)) return 0;

  tmpPerp.copy(bodyDir).addScaledVector(aimDir, -aimDir.dot(bodyDir));
  if (tmpPerp.lengthSq() < 1e-24) return 0;
  tmpPerp.normalize();

  let needed: number;
  if (!discFits(turnToward(aimDir, tmpPerp, offAxis, tmpAim), bodyDir, radius, up)) {
    // Centred is always framed (|c| = 0); only float noise at an exact
    // fit/cover boundary lands here. Centre it.
    needed = offAxis;
  } else {
    // framed(0) is false and framed(offAxis) is true: bisect for the smallest
    // turn that frames it. Turning along the great circle moves the body straight
    // toward the axis (its off-axis angle is offAxis − turn exactly); only the
    // roll, fixed by the up axis, turns its screen azimuth, and only slightly
    // over the few degrees a keep spans, so the predicate is monotone in
    // practice. The upper bound is always framed, so the answer always is.
    let low = 0;
    let high = offAxis;
    for (let step = 0; step < BISECTION_STEPS; step++) {
      const mid = (low + high) / 2;
      if (discFits(turnToward(aimDir, tmpPerp, mid, tmpAim), bodyDir, radius, up)) high = mid;
      else low = mid;
    }
    needed = high;
  }
  const fade = 1 - THREE.MathUtils.smoothstep(offAxis, FRAME_KEEP_FADE_START_RAD, FRAME_KEEP_FADE_END_RAD);
  return needed * fade;
}

/** Whether a disc is framed (fits the inset frame, or covers it on an axis
 *  it is wider than) with no turn at all — the test the keep starts from,
 *  exposed for the tests. */
export function discFitsFrame(
  aimDir: THREE.Vector3,
  bodyDir: THREE.Vector3,
  discRadiusRad: number,
  up: THREE.Vector3,
  view: FrameKeepView,
  margin = FRAME_KEEP_MARGIN,
): boolean {
  if (!prepareLimits(view, margin)) return true;
  return discFits(aimDir, bodyDir, Math.min(Math.max(discRadiusRad, 0), Math.PI / 2), up);
}
