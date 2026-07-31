/**
 * The system map's camera — its state machine and its bounds policy. Pure: no
 * THREE, no DOM, no scene state. Every THREE write (dolly, controls.update,
 * matrix flush, pose snapshots, follow deltas) stays in SystemMap; this module
 * only answers questions with numbers.
 *
 * ## The machine
 *
 * Four states, one owner of the camera at a time:
 *
 *   overview  — the whole-system fit, OrbitControls free around the Sun
 *   focusFly  — a ~0.9 s eased flight, either INTO a body or back OUT to the fit
 *   following — riding a moving body, orbit/zoom live around it
 *   dive      — the commit transition; the mode drives the pose frame by frame
 *
 * A flight has to say where it is going: the return flight reuses the same ease
 * and the same code, so `flyGoal` is carried explicitly rather than inferred
 * from whether a body happens to be named.
 *
 * A dive that starts from a focus state memos what it interrupted — state, goal
 * and body — because cancelling it has to put the user back where they were,
 * and "where they were" differs per origin: a follow resumes on the body's LIVE
 * position, an interrupted release completes to the overview instead of
 * reversing itself back onto the body.
 *
 * ## The bounds
 *
 * The transaction that matters is not the transition list, it is what the
 * camera is allowed to do once it is there:
 *
 *  - `minDist` — how close follow may come. The aspiration is a disc ~200 px in
 *    radius; the near plane is what actually permits it, and on the smaller
 *    bodies it binds first. 200 px is therefore an aspiration, not a promise.
 *  - `maxDist` — twice the depth at which the body's true disc crosses its own
 *    chart marker, so zooming out can never shrink the subject past the marker
 *    it would draw as anyway. Follow cannot hide its own subject.
 *  - `far` — always past the whole system, from wherever the camera sits: the
 *    context behind the subject IS the product (labels and pick anchors cull on
 *    ndcZ >= 1, and the background lines and globes are what make a focus read
 *    as a place in a system rather than a body on black).
 *  - `near` — a quarter of the way to the subject's surface, never further out
 *    than the overview's own near plane (during a flight the subject is still
 *    far away and a quarter of THAT would slice through the foreground), and
 *    never closer than far/RATIO.
 *
 * That last floor is the declared trade: a fixed-point depth buffer spends its
 * precision on the near/far ratio, so letting near collapse would leave the
 * background lines and globes fighting each other. Capping the ratio instead
 * caps how close follow may come — the floor is precisely what sets `minDist`,
 * and above `minDist` the quarter-of-the-surface-distance term governs.
 */

import { mapMarkerRadiusPx, type MapBodySizeParams } from './mapBodySize';
import { fitDistanceAU } from './mapProjection';
import { smoothstepUnclamped } from '../../shared/math/smoothstep';

/** Vertical field of view (degrees) the map camera renders at — the single
 *  definition site, read by every framing, fit and size calculation. */
export const MAP_FOV_DEG = 50;

/** How long a focus flight takes, in and out. */
export const MAP_FOCUS_FLY_MS = 900;

/** Two taps on the same body inside this window focus it. */
export const MAP_DOUBLE_TAP_MS = 300;

/** Disc radius (screen px) the closest follow framing aims to give the subject.
 *  Reached on the bodies whose near plane permits it; the rest cap lower. */
export const MAP_FOCUS_MIN_PX = 200;

/** Disc radius (screen px) a focus flight lands at — well inside the marker
 *  crossover, so the globe arrives genuinely resolved rather than at the size
 *  where the chart symbol still governs it. */
export const MAP_FOCUS_REVEAL_PX = 40;

/** Zoom-out limit as a multiple of the marker-crossover depth. */
export const MAP_FOLLOW_MAX_CROSSOVER_MUL = 2;

/** The follow shell is never thinner than this ratio, so a body the near floor
 *  pushes past its own crossover — or a moon whose shell has been raised to
 *  clear its parent — still leaves somewhere to orbit. */
export const MAP_FOLLOW_MIN_SPREAD = 1.5;

/** Near plane as a fraction of the distance to the subject's surface. */
const MAP_NEAR_SURFACE_FRAC = 0.25;

/** Near plane as a fraction of the extent, when the subject is far enough away
 *  that metering off it would clip the foreground. Same value the overview
 *  frames with, so a flight's clipping arrives continuous at both ends. */
export const MAP_OVERVIEW_NEAR_FRAC = 1e-3;

/** Largest far/near the map will ask a depth buffer for. */
const MAP_NEAR_FAR_RATIO = 3e4;

/** How much of the subject's surface distance the near plane may eat before
 *  the approach is stopped. Half leaves the subject unambiguously in front of
 *  the plane while still letting the camera get close on the small bodies. */
const MAP_NEAR_CLEAR_FRAC = 0.5;

/** Slack past the outermost drawn radius, so the far plane contains the last
 *  orbit vertex rather than landing exactly on it. */
const MAP_FAR_EXTENT_MARGIN = 1.05;

export type MapCamState = 'overview' | 'focusFly' | 'following' | 'dive';
export type MapFlyGoal = 'follow' | 'overview';

/** What a camera dive interrupted, kept so a cancel can restore it. `flyGoal`
 *  is part of the memo: without it, cancelling a dive that interrupted a
 *  RELEASE flight would restore the follow the user had just left. */
export interface MapDiveOrigin {
  camState: Exclude<MapCamState, 'dive'>;
  flyGoal: MapFlyGoal | null;
  focusName: string | null;
}

export interface MapCameraState {
  camState: MapCamState;
  /** Where a flight is headed. Only set in `focusFly`. */
  flyGoal: MapFlyGoal | null;
  /** The body a focus rides. Held through a release flight too — the camera is
   *  still leaving THAT body, and its radius is what the clip planes meter
   *  against until the flight is over. */
  focusName: string | null;
  diveOrigin: MapDiveOrigin | null;
}

export type MapCameraEvent =
  /** Focus button or double-tap on a body. */
  | { kind: 'focus'; name: string }
  /** The overview chip, or the Esc cascade's focus rung. */
  | { kind: 'release' }
  /** The ease reached 1. */
  | { kind: 'flyLanded' }
  /** A commit began. `camera: false` is the Autopilot fade, which never touches
   *  the camera at all — follow keeps riding under it. */
  | { kind: 'diveStart'; camera: boolean }
  | { kind: 'diveCancel' }
  /** The map closed, or is being reset for a fresh open. */
  | { kind: 'close' };

export function mapCameraInitialState(): MapCameraState {
  return { camState: 'overview', flyGoal: null, focusName: null, diveOrigin: null };
}

function flying(state: MapCameraState, goal: MapFlyGoal): boolean {
  return state.camState === 'focusFly' && state.flyGoal === goal;
}

/**
 * The state machine. Returns the SAME object when an event changes nothing, so
 * a caller can tell "already there" from "start the flight" by identity.
 */
export function mapCameraReduce(
  state: MapCameraState,
  event: MapCameraEvent,
): MapCameraState {
  switch (event.kind) {
    case 'focus': {
      // The dive owns the camera outright while it runs.
      if (state.camState === 'dive') return state;
      // Asking for the body you are already on, or already flying to, is not a
      // request to start over.
      if (state.camState === 'following' && state.focusName === event.name) return state;
      if (flying(state, 'follow') && state.focusName === event.name) return state;
      // Everything else is a fresh flight toward the named body: from the
      // overview, retargeting from a follow or a flight, and superseding a
      // release the user has changed their mind about.
      return {
        camState: 'focusFly',
        flyGoal: 'follow',
        focusName: event.name,
        diveOrigin: null,
      };
    }
    case 'release': {
      if (state.camState === 'following' || flying(state, 'follow')) {
        return {
          camState: 'focusFly',
          flyGoal: 'overview',
          focusName: state.focusName,
          diveOrigin: null,
        };
      }
      // Already leaving, or never left: nothing visible would change.
      return state;
    }
    case 'flyLanded': {
      if (flying(state, 'follow')) {
        return {
          camState: 'following',
          flyGoal: null,
          focusName: state.focusName,
          diveOrigin: null,
        };
      }
      if (flying(state, 'overview')) return mapCameraInitialState();
      return state;
    }
    case 'diveStart': {
      if (!event.camera) return state; // the Autopilot fade leaves the camera alone
      if (state.camState === 'dive') return state;
      return {
        camState: 'dive',
        flyGoal: null,
        focusName: null,
        diveOrigin: {
          camState: state.camState,
          flyGoal: state.flyGoal,
          focusName: state.focusName,
        },
      };
    }
    case 'diveCancel': {
      if (state.camState !== 'dive') return state;
      const origin = state.diveOrigin;
      if (!origin || origin.camState === 'overview') return mapCameraInitialState();
      if (origin.camState === 'following' || origin.flyGoal === 'follow') {
        // An interrupted approach completes rather than resuming mid-flight:
        // the camera lands on the pose the flight was heading for.
        return {
          camState: 'following',
          flyGoal: null,
          focusName: origin.focusName,
          diveOrigin: null,
        };
      }
      // An interrupted release finishes leaving.
      return mapCameraInitialState();
    }
    case 'close':
      return mapCameraInitialState();
  }
}

/** Whether the ◂ Overview chip shows: while a focus is being flown to, and
 *  while one is being followed. A release flight is already on its way out. */
export function mapOverviewChipVisible(state: MapCameraState): boolean {
  return state.camState === 'following' || flying(state, 'follow');
}

/** Whether taps and hover stand down: the camera is writing its own pose and a
 *  pick would land on a body that has already moved under the pointer. */
export function mapCameraOwnsPose(state: MapCameraState): boolean {
  return state.camState === 'focusFly' || state.camState === 'dive';
}

/** The flight's eased progress for a raw fraction of its duration. */
export function mapFocusEase(t: number): number {
  return smoothstepUnclamped(Math.max(0, Math.min(1, t)));
}

/** World span of one screen px at unit depth — the one camera fact every screen
 *  size on the map is metered with. */
export function mapWorldPerPxAtUnitDepth(viewportH: number, fovDeg: number): number {
  const h = Math.max(viewportH, 1);
  return (2 * Math.tan((fovDeg * Math.PI) / 180 / 2)) / h;
}

/** Camera depth (AU) at which a body of true radius `radiusAU` subtends a disc
 *  of `px` radius. */
export function apparentDepthAU(
  radiusAU: number,
  px: number,
  viewportH: number,
  fovDeg: number,
): number {
  const perPx = mapWorldPerPxAtUnitDepth(viewportH, fovDeg) * Math.max(px, 1e-6);
  return radiusAU / Math.max(perPx, 1e-30);
}

/**
 * Where a focus flight lands: the distance at which the subject's true disc
 * reads as a resolved globe rather than a symbol. The caller clamps it into the
 * follow shell — on a body the near floor keeps at arm's length, the shell's
 * own minimum is as close as the flight can honestly promise.
 */
export function revealDistanceAU(
  trueRadiusAU: number,
  viewportH: number,
  fovDeg: number,
): number {
  return apparentDepthAU(trueRadiusAU, MAP_FOCUS_REVEAL_PX, viewportH, fovDeg);
}

export interface MapFollowBounds {
  minDist: number;
  maxDist: number;
  near: number;
  far: number;
}

/**
 * The whole bounds transaction for a focused body.
 *
 * `surfaceDistAU` and `cameraOriginDistAU` describe where the camera is RIGHT
 * NOW (they drive the clip planes, which is why a flight re-evaluates this
 * every frame); `subjectOriginDistAU` and `extentAU` describe the chart, and
 * with the body's radius they fix the distance shell, which does not move as
 * the camera does.
 */
export function followBounds(
  trueRadiusAU: number,
  surfaceDistAU: number,
  cameraOriginDistAU: number,
  subjectOriginDistAU: number,
  extentAU: number,
  viewportH: number,
  fovDeg: number,
  sizeParams: MapBodySizeParams,
  out: MapFollowBounds = { minDist: 0, maxDist: 0, near: 0, far: 0 },
): MapFollowBounds {
  const radius = Math.max(trueRadiusAU, 0);
  const extent = Math.max(extentAU, 1e-6);
  // Everything drawn sits inside a ball of `extent` about the Sun, so the far
  // plane only ever needs to reach the far side of that ball from here.
  const far = Math.max(cameraOriginDistAU, 0) + extent * MAP_FAR_EXTENT_MARGIN;
  // The same reach, measured from the body rather than from the camera: the
  // shell must not shuffle every time the camera moves inside it.
  const shellFar = Math.max(subjectOriginDistAU, 0) + extent * MAP_FAR_EXTENT_MARGIN;

  // As close as the near plane permits: below this the ratio floor would eat
  // more than its share of the way to the subject's surface.
  const nearFloorDist = radius + shellFar / (MAP_NEAR_FAR_RATIO * MAP_NEAR_CLEAR_FRAC);
  const wantedDist = apparentDepthAU(radius, MAP_FOCUS_MIN_PX, viewportH, fovDeg);
  const minDist = Math.max(wantedDist, nearFloorDist);

  // Twice the depth where the true disc crosses the marker the chart would draw
  // instead — past that the subject is a symbol among symbols again.
  const crossDist = apparentDepthAU(
    radius,
    mapMarkerRadiusPx(radius, sizeParams),
    viewportH,
    fovDeg,
  );
  const maxDist = Math.max(
    crossDist * MAP_FOLLOW_MAX_CROSSOVER_MUL,
    minDist * MAP_FOLLOW_MIN_SPREAD,
  );

  const surface = Math.max(surfaceDistAU, 1e-9);
  const near = Math.max(
    Math.min(surface * MAP_NEAR_SURFACE_FRAC, extent * MAP_OVERVIEW_NEAR_FRAC),
    far / MAP_NEAR_FAR_RATIO,
    1e-6,
  );

  out.minDist = minDist;
  out.maxDist = maxDist;
  out.near = near;
  out.far = far;
  return out;
}

/**
 * The camera distance a transition needs, given the straight path's own
 * distance and how far the AIM currently sits from the nearest body.
 *
 * The aim sweeps from one body to another while the camera hangs a fraction of
 * an AU behind it, so a straight run spends its middle staring at empty space
 * with everything far outside the frustum — a black frame, not a journey. The
 * distance therefore has a floor: far enough to frame whatever is nearest to
 * what the camera is looking at. On a body that floor is nothing and the
 * straight path stands; halfway between two it is the distance that holds them
 * both, which is what makes the middle of the trip the shot that shows the
 * ground covered.
 *
 * Metering against the nearest BODY, rather than the two ends of the move, is
 * what survives a redirect: a move retargeted mid-way begins in empty space, and
 * framing that starting point would frame nothing at all. Capped at the overview
 * fit, because no trip needs to see more of the system than the chart does.
 */
export function mapFlightFramingDistanceAU(
  baseDistAU: number,
  aimToNearestBodyAU: number,
  extentAU: number,
  fovDeg: number,
  aspect: number,
): number {
  if (!(aimToNearestBodyAU > 0)) return baseDistAU;
  const needed = Math.min(
    fitDistanceAU(aimToNearestBodyAU, fovDeg, aspect),
    fitDistanceAU(Math.max(extentAU, 1e-6), fovDeg, aspect),
  );
  return needed > baseDistAU ? needed : baseDistAU;
}

/** Hold a camera distance inside the follow shell. */
export function clampFollowDistanceAU(distAU: number, bounds: MapFollowBounds): number {
  return Math.min(Math.max(distAU, bounds.minDist), bounds.maxDist);
}

/** How far outside the destination's drawn surface a dive is allowed to end. */
const MAP_DIVE_SURFACE_CLEARANCE = 1.5;

/**
 * The fraction of its start distance a dive ends at, measured from the body it
 * is diving AT — the ease keeps the camera this far from a target that travels
 * onto the destination, so the fraction fixes the final gap to the destination
 * whatever the camera was orbiting when it started.
 *
 * The dive closes to a fixed fraction, which is a whole system away when it
 * leaves from the overview but only a few radii when it leaves from a focus —
 * and a fraction of a few radii is inside the body. The globes are front-face
 * culled, so a camera that arrives under the surface loses the destination
 * entirely for the frames before the fade covers it. Floor the end at the
 * destination's own DRAWN extent — its true size once the camera can resolve
 * it, its chart marker while it cannot, and past any ring it wears — with
 * enough clearance to keep a limb rather than a wall.
 *
 * The floor is NOT capped at where the dive started: the start distance belongs
 * to whatever the camera was following, which can be a far smaller body than
 * the destination. Aim at the Sun from a Mercury follow and the camera already
 * sits well inside the Sun's shell, so the dive has to recede to clear it.
 *
 * Below the floor this returns `baseFrac` unchanged, bit for bit — an overview
 * dive is far enough out that the floor cannot reach it, and its numbers must
 * not move.
 */
export function mapDiveEndFraction(
  startDistAU: number,
  destinationClearanceRadiusAU: number,
  baseFrac: number,
): number {
  if (!(startDistAU > 0)) return baseFrac;
  const floorFrac = (destinationClearanceRadiusAU * MAP_DIVE_SURFACE_CLEARANCE) / startDistAU;
  return floorFrac > baseFrac ? floorFrac : baseFrac;
}
