/**
 * Cruise camera aim: composition + continuity enforcement.
 *
 * The cruise camera's aim used to be written up to three times per frame by
 * writers that didn't know about each other (OrbitControls, the safety
 * escape's re-aim, the moon-arrival look override), and every input gesture
 * that took or dropped the camera had to individually remember to ease the
 * override out. Each forgotten seam shipped as a one-frame snap: the centred
 * moon jumping across the viewport on the first touch, keypress, or
 * click-drag after a teleport. This module inverts that polarity — aim
 * continuity is enforced by construction, and only an explicit cut
 * (`cutAim`, called at the deliberate repose sites) may move the aim
 * discontinuously.
 *
 * Per frame the aim decomposes into:
 *  - a BASE aim — the origin direction `normalize(−camPos)`. The ship rides
 *    the scene origin (floating origin), and every cruise camera owner aims
 *    at the origin, so base motion is position-driven and TRUSTED: drags,
 *    damping coasts and reacquires pass through 1:1 at any rate. The
 *    previous frame's aim is transported by the shortest-arc rotation
 *    prevBase→base before limiting, so limiting never clips them.
 *  - a DEFLECTION — the rotation from base aim to the actual aim, where the
 *    moon-arrival look (and every member of the aim-snap class) lives. Only
 *    the deflection's change is rate-limited, to
 *    min(AIM_RATE_CAP_RAD_PER_S·dt, AIM_STEP_MAX_RAD).
 *
 * The arrival look is DORMANT: no production path calls startArrivalLook —
 * moon teleports arrive directly in the settled pose (the moon-centred
 * postcard override was retired because its ~20° offset from the settled
 * pose made every first input pay a visible hand-back). The machinery
 * stays because it is the one safe home for any future authored look: a
 * look started here inherits the continuity guarantee below instead of
 * reviving the snap class.
 *
 * An authored look's target is fed ANALYTICALLY (parent world position +
 * ephemeris offset, heliocentric) rather than from the mesh transform:
 * updateMoonPositions skips invisible unpainted moons, and a cold jump's
 * mesh is invisible by design for the whole veiled paint window — the look
 * must hold full weight there so veil-lift opens already aimed. The frame
 * conversion (heliocentric world → scene) happens in exactly one place,
 * inside the step. A look whose target genuinely cannot be resolved latches
 * release and fades out from the last known world position; a clock jump or
 * high-warp near pass (apparent direction stepping more than
 * LOOK_WARP_RELEASE_RAD in one frame) latches release too — the look is a
 * teleport-arrival aid, not a warp tracker.
 *
 * Guarantee, stated honestly: uncut AIM-DIRECTION continuity (C0). Roll
 * rides the constant cruise up-basis; position discontinuities (safety
 * escape, collision pushback) remain their own deliberate domain.
 *
 * State is a plain data record owned by PlanetariumMode; every function here
 * is pure over it and allocates nothing per frame.
 */
import * as THREE from 'three';
import {
  moonArrivalCameraLookWeight,
  moonArrivalReleaseFade,
} from './arrivalLogic';
import { FLIGHT_UP_SCENE } from './flightFrame';

/** Continuity backstop: aim-direction changes above this rate are clipped
 *  into fast sweeps. Designed transitions (the 0.35 s release fade, the
 *  recede ease) peak well under it (~75°/s measured), and base-aim motion
 *  (drags, reacquire) bypasses it entirely via transport, so in ordinary
 *  play it never binds — it exists for the seam nobody eased. */
export const AIM_RATE_CAP_RAD_PER_S = (360 * Math.PI) / 180;

/** Absolute per-frame step clamp. The frame loop caps dt at ~100 ms, and
 *  cap·dt alone would let a hitch frame pass a 36° single step — bigger
 *  than the snaps this stage exists to kill. Sized to cap·(1/45 s): frames
 *  faster than ~45 fps are governed by the rate cap alone, only true hitch
 *  frames hit this clamp (and then converge over the following frames). */
export const AIM_STEP_MAX_RAD = AIM_RATE_CAP_RAD_PER_S / 45;

/** One-frame apparent-direction step that releases the arrival look: a
 *  clock jump or high-warp near pass moves the moon discontinuously, and
 *  tracking through that would interpret a teleport as a flyby. Governed
 *  real-time flybys stay far under this even on a 100 ms hitch frame. */
export const LOOK_WARP_RELEASE_RAD = (8 * Math.PI) / 180;

/** Distance backstop: past this multiple of the arrival distance the look
 *  is receding no matter what the approach bookkeeping saw — a warp step
 *  can leap the whole approach window, and without this the weight would
 *  pin at 1 chasing a moon the flyby never "reached". */
export const LOOK_RECEDE_BACKSTOP_RATIO = 2;

/** Moon-arrival look bookkeeping (the former PlanetariumMode
 *  `moonArrivalCameraLook`, moved here whole). */
export interface ArrivalLookState {
  name: string;
  parentPlanet: string;
  arrivalDistanceAU: number;
  previousDistanceAU: number;
  approached: boolean;
  receding: boolean;
  /** Seconds since an input released the look; null while it still owns the
   *  aim. Advanced each step once set, driving the release fade. */
  releaseElapsedS: number | null;
  /** Last successfully resolved moon position, HELIOCENTRIC — the fade-out
   *  datum when resolution fails, re-derived against the live render origin
   *  each frame (a frozen scene direction goes stale under ship motion). */
  lastMoonWorldPosAU: THREE.Vector3;
  /** Whether lastMoonWorldPosAU has ever been written. */
  hasLastMoonWorldPos: boolean;
  /** Previous frame's camera→moon unit direction (scene frame) — the warp
   *  detection datum, separate from the emitted aim. Zero until seeded. */
  prevApparentDir: THREE.Vector3;
  hasPrevApparentDir: boolean;
}

/** The whole cruise-aim state. Owned by PlanetariumMode, advanced only by
 *  the functions below. */
export interface CruiseAimState {
  look: ArrivalLookState | null;
  /** False after a cut: the next step adopts its desired aim exactly. */
  hasAim: boolean;
  /** Last emitted unit aim direction (scene frame; valid while hasAim). */
  aimDir: THREE.Vector3;
  /** Base (origin-aim) direction of the frame that emitted aimDir — the
   *  transport datum that lets base motion pass 1:1. */
  prevBaseDir: THREE.Vector3;
}

export function createCruiseAimState(): CruiseAimState {
  return {
    look: null,
    hasAim: false,
    aimDir: new THREE.Vector3(0, 0, -1),
    prevBaseDir: new THREE.Vector3(0, 0, -1),
  };
}

/** An authored look begins tracking (dormant: no production caller — see
 *  the module header). Does NOT restore a cut aim — the jump funnel cuts
 *  deliberately and the first step must adopt the desired aim exactly,
 *  not sweep toward it. */
export function startArrivalLook(
  state: CruiseAimState,
  name: string,
  parentPlanet: string,
  arrivalDistanceAU: number,
): void {
  state.look = {
    name,
    parentPlanet,
    arrivalDistanceAU,
    previousDistanceAU: arrivalDistanceAU,
    approached: false,
    receding: false,
    releaseElapsedS: null,
    lastMoonWorldPosAU: new THREE.Vector3(),
    hasLastMoonWorldPos: false,
    prevApparentDir: new THREE.Vector3(),
    hasPrevApparentDir: false,
  };
}

/** Manual input (steering, throttle, an orbit grab) hands the look back
 *  over the release fade. Idempotent: an already-releasing look keeps its
 *  fade phase. */
export function releaseArrivalLook(state: CruiseAimState): void {
  if (state.look) state.look.releaseElapsedS ??= 0;
}

/** Drop the look outright (jumps, landing, restore, deactivate). The
 *  emitted aim residual is deliberately NOT touched: the limiter keeps
 *  easing an orphaned deflection back to the base aim, so a clear alone can
 *  never snap. Pair with cutAim where the repose is authored. */
export function clearArrivalLook(state: CruiseAimState): void {
  state.look = null;
}

/** Deliberate discontinuity: the next step adopts its desired aim exactly.
 *  The only way past the rate cap. */
export function cutAim(state: CruiseAimState): void {
  state.hasAim = false;
}

const FALLBACK_BASE = new THREE.Vector3(0, 0, -1);
const tmpBase = new THREE.Vector3();
const tmpMoonScene = new THREE.Vector3();
const tmpApparentDir = new THREE.Vector3();
const tmpDesired = new THREE.Vector3();
const tmpAxis = new THREE.Vector3();
const tmpTransport = new THREE.Quaternion();
const tmpStep = new THREE.Quaternion();

/** The one antipodal-rotation axis: no great circle is preferred when two
 *  directions oppose, so every antipodal case in this module rotates about
 *  the SAME deterministic axis — the cruise up-basis projected onto the
 *  plane perpendicular to `dir` (the sweep stays upright, yaw-like, instead
 *  of pitching through the zenith), with a canonical fallback when `dir` IS
 *  the up axis. Three's setFromUnitVectors picks a component-dependent axis
 *  that can flip across a tiny perturbation — never rely on it here. */
function antipodalAxis(dir: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  const align = FLIGHT_UP_SCENE.dot(dir);
  out.copy(FLIGHT_UP_SCENE).addScaledVector(dir, -align);
  if (out.lengthSq() < 1e-12) {
    // dir is the up pole itself: any horizon axis works; pick one, forever.
    out.set(1, 0, 0).addScaledVector(dir, -dir.x);
  }
  return out.normalize();
}

/**
 * Advance one frame. camPos is the camera's scene position;
 * moonWorldPosAU is the look target's HELIOCENTRIC position (null when it
 * cannot be resolved) and renderOriginAU the player's render-frame origin —
 * the heliocentric→scene conversion happens here and nowhere else. Writes
 * the emitted unit aim direction (scene frame) to outDir. Allocates
 * nothing.
 */
export function stepCruiseAim(
  state: CruiseAimState,
  camPos: THREE.Vector3,
  moonWorldPosAU: THREE.Vector3 | null,
  renderOriginAU: { x: number; y: number; z: number },
  dtS: number,
  outDir: THREE.Vector3,
): void {
  // Base aim: the origin direction. The chase offset never degenerates to
  // zero length in cruise; guard anyway so a pathological pose can't NaN
  // the persistent state.
  const baseLen = camPos.length();
  const baseDir = tmpBase;
  if (baseLen > 1e-12) {
    baseDir.copy(camPos).multiplyScalar(-1 / baseLen);
  } else {
    baseDir.copy(state.hasAim ? state.prevBaseDir : FALLBACK_BASE);
  }

  // ---- Look bookkeeping → desired aim -------------------------------
  tmpDesired.copy(baseDir);
  const look = state.look;
  if (look) {
    if (moonWorldPosAU) {
      look.lastMoonWorldPosAU.copy(moonWorldPosAU);
      look.hasLastMoonWorldPos = true;
    } else if (look.hasLastMoonWorldPos) {
      // True loss: fade out from the last place the moon was known to be.
      releaseArrivalLook(state);
    } else {
      // Never resolved at all — nothing to aim at; drop the look. The
      // residual (none: aim never deflected) needs no easing.
      state.look = null;
    }
    if (state.look) {
      tmpMoonScene.set(
        look.lastMoonWorldPosAU.x - renderOriginAU.x,
        look.lastMoonWorldPosAU.y - renderOriginAU.y,
        look.lastMoonWorldPosAU.z - renderOriginAU.z,
      );
      const camToMoonLen = tmpApparentDir
        .copy(tmpMoonScene)
        .sub(camPos)
        .length();
      if (camToMoonLen > 1e-12) {
        tmpApparentDir.multiplyScalar(1 / camToMoonLen);
        const warped =
          look.hasPrevApparentDir &&
          tmpApparentDir.dot(look.prevApparentDir) <
            Math.cos(LOOK_WARP_RELEASE_RAD);
        if (warped) {
          // A clock jump / high-warp pass moved the moon discontinuously:
          // release, rebaseline the samples, and skip classification this
          // frame — the next ordinary frame classifies against post-warp
          // data, never against a pre-warp distance.
          releaseArrivalLook(state);
          look.previousDistanceAU = camToMoonLen;
        } else {
          if (camToMoonLen < look.arrivalDistanceAU * 0.98) {
            look.approached = true;
          }
          if (
            (look.approached &&
              camToMoonLen > look.previousDistanceAU * 1.0001) ||
            camToMoonLen >
              look.arrivalDistanceAU * LOOK_RECEDE_BACKSTOP_RATIO
          ) {
            look.receding = true;
          }
          look.previousDistanceAU = camToMoonLen;
        }
        look.prevApparentDir.copy(tmpApparentDir);
        look.hasPrevApparentDir = true;
      }

      if (look.releaseElapsedS !== null) look.releaseElapsedS += dtS;
      const weight =
        moonArrivalCameraLookWeight(
          camToMoonLen,
          look.arrivalDistanceAU,
          look.receding,
        ) * moonArrivalReleaseFade(look.releaseElapsedS ?? 0);
      if (weight <= 0) {
        state.look = null; // handoff complete; residual eases out below
      } else {
        // Today's shipped composition, expressed as a direction: the aim
        // point interpolates moon→origin, viewed from the camera.
        tmpDesired.copy(tmpMoonScene).multiplyScalar(weight).sub(camPos);
        const len = tmpDesired.length();
        if (len > 1e-12) tmpDesired.multiplyScalar(1 / len);
        else tmpDesired.copy(baseDir);
      }
    }
  }

  // ---- Continuity stage ---------------------------------------------
  if (!state.hasAim) {
    state.aimDir.copy(tmpDesired);
    state.hasAim = true;
  } else {
    // Transport last frame's aim by the base rotation, so position-driven
    // aim motion (drags, damping coasts, reacquire) passes through 1:1 and
    // only the residual deflection is rate-limited. An exactly-reversed
    // base (only an authored repose or a pathological pushback moves the
    // camera that far in one frame) takes the module's canonical antipodal
    // axis — transport is uncapped, so its axis must never be left to
    // setFromUnitVectors' perturbation-sensitive choice.
    if (state.prevBaseDir.dot(baseDir) < -1 + 1e-10) {
      tmpTransport.setFromAxisAngle(
        antipodalAxis(state.prevBaseDir, tmpAxis), Math.PI,
      );
    } else {
      tmpTransport.setFromUnitVectors(state.prevBaseDir, baseDir);
    }
    state.aimDir.applyQuaternion(tmpTransport).normalize();

    const dot = THREE.MathUtils.clamp(state.aimDir.dot(tmpDesired), -1, 1);
    const delta = Math.acos(dot);
    const maxStep = Math.min(AIM_RATE_CAP_RAD_PER_S * dtS, AIM_STEP_MAX_RAD);
    if (delta <= maxStep) {
      state.aimDir.copy(tmpDesired);
    } else {
      tmpAxis.crossVectors(state.aimDir, tmpDesired);
      if (tmpAxis.lengthSq() < 1e-12) {
        // Exact/near antipodal (a receding flyby can put the moon almost
        // directly behind the chase camera): no unique great circle, so
        // take the module's canonical axis.
        antipodalAxis(state.aimDir, tmpAxis);
      }
      tmpAxis.normalize();
      tmpStep.setFromAxisAngle(tmpAxis, maxStep);
      state.aimDir.applyQuaternion(tmpStep).normalize();
    }
  }
  state.prevBaseDir.copy(baseDir);
  outDir.copy(state.aimDir);
}
