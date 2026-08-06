/**
 * The system map's camera — its state machine and its bounds policy. Pure: no
 * THREE, no DOM, no scene state. Every THREE write (dolly, controls.update,
 * matrix flush, pose snapshots, follow deltas) stays in SystemMap; this module
 * only answers questions with numbers.
 *
 * ## The machine
 *
 * Five states, one owner of the camera at a time:
 *
 *   overview  — the whole-system fit, OrbitControls free around the Sun
 *   focusFly  — a ~0.9 s eased flight, either INTO a body or back OUT to the fit
 *   following — riding a moving body, orbit/zoom live around it
 *   dive      — the commit transition; the mode drives the pose frame by frame
 *   flip      — the short crossing to the other side of the chart's plane
 *
 * The crossing carries where it came FROM, for the same reason a flight carries
 * where it is going: it lands back in that state, and the two land differently
 * — an overview crossing gives the camera back to the free controls, a follow
 * crossing resumes the ride on the body it never stopped watching.
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
 *
 * ## The overview's own bounds
 *
 * The same four numbers, decided differently, because the overview is not
 * riding anything: the camera is free and what it is near changes as it moves.
 *
 *  - `minDist` — how close the free camera may come to whatever its pivot sits
 *    on. Small in absolute AU, not merely a fraction of the chart: a fraction
 *    of a wide chart is still further out than the shell a moon system appears
 *    inside, so the small systems would stay permanently out of reach.
 *  - `maxDist` — a little past the whole-system fit, so zooming out settles on
 *    the chart rather than drifting off it.
 *  - `far` — the far side of the drawn scene from wherever the camera sits.
 *    The figure fed in is the RENDERED reach, not the orbit centrelines: a
 *    revealed system's moon rings stand off its parent, and they are drawn on
 *    the frame the camera leaves that system on.
 *  - `near` — the overview's own plane, tightened only when the camera is
 *    genuinely close to something, and never below the ratio floor.
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

/** Closest the free overview camera may come to its pivot, as a fraction of the
 *  chart's extent AND as an absolute distance — whichever is smaller. The
 *  absolute cap is what makes every system reachable: a thousandth of the
 *  compressed chart is four times further out than the shell Mars's moons
 *  appear inside, and Earth's and Pluto's fail the same way, so the fraction
 *  alone would leave the small systems permanently unzoomable. */
export const MAP_OVERVIEW_MIN_DIST_FRAC = 1e-3;
export const MAP_OVERVIEW_MIN_DIST_AU = 1e-4;

/** Zoom-out limit as a multiple of the whole-system fit distance. */
const MAP_OVERVIEW_MAX_DIST_MUL = 1.8;

/** The overview's near plane never comes closer than this, whatever the chart
 *  and the surfaces say. */
const MAP_OVERVIEW_MIN_NEAR_AU = 1e-4;

/** Largest far/near the map will ask a depth buffer for. */
const MAP_NEAR_FAR_RATIO = 3e4;

/** How much of the subject's surface distance the near plane may eat before
 *  the approach is stopped. Half leaves the subject unambiguously in front of
 *  the plane while still letting the camera get close on the small bodies. */
const MAP_NEAR_CLEAR_FRAC = 0.5;

/** Slack past the outermost drawn radius, so the far plane contains the last
 *  orbit vertex rather than landing exactly on it. */
const MAP_FAR_EXTENT_MARGIN = 1.05;

export type MapCamState = 'overview' | 'focusFly' | 'following' | 'dive' | 'flip';
export type MapFlyGoal = 'follow' | 'overview';
/** The two states a crossing can be launched from, and the one it lands in. */
export type MapFlipOrigin = 'overview' | 'following';

/** Which side of the chart's plane the camera is held on. */
export type MapHemisphere = 'above' | 'below';

/** The polar band the camera is held in, measured from north: never fully
 *  edge-on, never underneath. `min` keeps the pole itself out of reach (a view
 *  straight down the axis has no bearing left to orbit by); `max` is where the
 *  chart stops reading as a chart. */
export const MAP_POLAR_MIN_RAD = 0.08;
export const MAP_POLAR_MAX_RAD = (78 * Math.PI) / 180;

export interface MapPolarBand {
  min: number;
  max: number;
}

/**
 * The band for a hemisphere. The two are exact mirrors and share NO overlap —
 * which is why the map has to hold a latch and write the matching band wherever
 * bounds are applied. OrbitControls clamp against one contiguous interval, so a
 * camera mirrored below the plane under the above-band's clamp is dragged back
 * over it within a frame.
 */
export function mapPolarBand(
  hemisphere: MapHemisphere,
  out: MapPolarBand = { min: 0, max: 0 },
): MapPolarBand {
  if (hemisphere === 'above') {
    out.min = MAP_POLAR_MIN_RAD;
    out.max = MAP_POLAR_MAX_RAD;
  } else {
    out.min = Math.PI - MAP_POLAR_MAX_RAD;
    out.max = Math.PI - MAP_POLAR_MIN_RAD;
  }
  return out;
}

/** The other side. */
export function mapHemisphereFlipped(hemisphere: MapHemisphere): MapHemisphere {
  return hemisphere === 'above' ? 'below' : 'above';
}

/** What a camera dive interrupted, kept so a cancel can restore it. `flyGoal`
 *  is part of the memo: without it, cancelling a dive that interrupted a
 *  RELEASE flight would restore the follow the user had just left. A crossing
 *  is never memoed as itself — it is settled before a dive begins, and the
 *  reducer records the state it would have landed in. */
export interface MapDiveOrigin {
  camState: Exclude<MapCamState, 'dive' | 'flip'>;
  flyGoal: MapFlyGoal | null;
  focusName: string | null;
}

export interface MapCameraState {
  camState: MapCamState;
  /** Where a flight is headed. Only set in `focusFly`. */
  flyGoal: MapFlyGoal | null;
  /** The body a focus rides. Held through a release flight too — the camera is
   *  still leaving THAT body, and its radius is what the clip planes meter
   *  against until the flight is over. Held through a crossing for the same
   *  reason: the ride continues under it. */
  focusName: string | null;
  /** Where a crossing came from, and where it lands. Only set in `flip`. */
  flipOrigin: MapFlipOrigin | null;
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
  /** The Flip button. A press while one is already crossing is a REVERSAL,
   *  which changes no field here — the camera is still crossing, from the same
   *  origin, and lands in the same state either way. The geometry owns that
   *  case, so this reports "nothing changed" for it. */
  | { kind: 'flip' }
  /** The crossing reached its far side. */
  | { kind: 'flipLanded' }
  /** The map closed, or is being reset for a fresh open. */
  | { kind: 'close' };

export function mapCameraInitialState(): MapCameraState {
  return {
    camState: 'overview',
    flyGoal: null,
    focusName: null,
    flipOrigin: null,
    diveOrigin: null,
  };
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
        flipOrigin: null,
        diveOrigin: null,
      };
    }
    case 'release': {
      if (state.camState === 'following' || flying(state, 'follow')) {
        return {
          camState: 'focusFly',
          flyGoal: 'overview',
          focusName: state.focusName,
          flipOrigin: null,
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
          flipOrigin: null,
          diveOrigin: null,
        };
      }
      if (flying(state, 'overview')) return mapCameraInitialState();
      return state;
    }
    case 'diveStart': {
      if (!event.camera) return state; // the Autopilot fade leaves the camera alone
      if (state.camState === 'dive') return state;
      // A crossing is settled before a dive takes the camera, so the memo
      // records where it would have landed — restoring INTO a crossing would
      // put the camera back mid-move with no clock left to finish it.
      const from: MapDiveOrigin = state.camState === 'flip'
        ? {
          camState: state.flipOrigin ?? 'overview',
          flyGoal: null,
          focusName: state.focusName,
        }
        : {
          camState: state.camState,
          flyGoal: state.flyGoal,
          focusName: state.focusName,
        };
      return {
        camState: 'dive',
        flyGoal: null,
        focusName: null,
        flipOrigin: null,
        diveOrigin: from,
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
          flipOrigin: null,
          diveOrigin: null,
        };
      }
      // An interrupted release finishes leaving.
      return mapCameraInitialState();
    }
    case 'flip': {
      // Only from a settled view. A flight and a dive are already writing the
      // pose, and the crossing has nothing legal to mirror mid-move.
      if (state.camState !== 'overview' && state.camState !== 'following') return state;
      return {
        camState: 'flip',
        flyGoal: null,
        // A follow crossing keeps riding its subject; an overview one has none.
        focusName: state.camState === 'following' ? state.focusName : null,
        flipOrigin: state.camState,
        diveOrigin: null,
      };
    }
    case 'flipLanded': {
      if (state.camState !== 'flip') return state;
      if (state.flipOrigin === 'following' && state.focusName) {
        return {
          camState: 'following',
          flyGoal: null,
          focusName: state.focusName,
          flipOrigin: null,
          diveOrigin: null,
        };
      }
      return mapCameraInitialState();
    }
    case 'close':
      return mapCameraInitialState();
  }
}

/** Whether there is a focus to let go of: one is being flown to, one is being
 *  followed, or one is being crossed over. A release flight is already on its
 *  way out. This is Esc's rung — Esc gives a focus back and then closes the
 *  map, and a crossing counts because the ride continues under it: Esc there
 *  has to mean the same thing it means a frame before and a frame after. */
export function mapFocusReleasable(state: MapCameraState): boolean {
  return state.camState === 'following'
    || flying(state, 'follow')
    || (state.camState === 'flip' && state.flipOrigin === 'following');
}

/**
 * Whether the console's Overview row has anything to do. It offers two ways
 * home, not one: giving up a focus, and re-fitting an overview that a free zoom
 * has wandered off. At the parked fit both refuse, and the row greys out.
 *
 * A move already under way answers no, whichever kind it is. Both journeys home
 * end by seating a pose, and one seated on top of a flight, a dive or a
 * crossing would fight whatever is writing the camera that frame.
 *
 * Deliberately NOT the same predicate as Esc's. Esc at a wandered overview
 * closes the map, exactly as it always has — the row is an extra affordance
 * there, not a new rung in the cascade, and one shared predicate with a flag
 * would be one call site away from making Esc unable to close the map at all.
 */
export function mapOverviewAvailable(state: MapCameraState, zoomFree: boolean): boolean {
  if (mapCameraOwnsPose(state)) return false;
  return mapFocusReleasable(state) || (state.camState === 'overview' && zoomFree);
}

/** Whether taps and hover stand down: the camera is writing its own pose and a
 *  pick would land on a body that has already moved under the pointer. */
export function mapCameraOwnsPose(state: MapCameraState): boolean {
  return state.camState === 'focusFly'
    || state.camState === 'dive'
    || state.camState === 'flip';
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

/**
 * The moon-reveal gate's own disc radius (screen px) — deliberately separate
 * from the focus-landing constant above. A free zoom-in should meet a system's
 * moons well before the parent fills the working view; 40 px made the reveal
 * feel late (the re-feel round's complaint), while at 24 px the revealed frame
 * still reads (ladder: planning/qa-epsilon-assess/e3-*.png). Focus flights are
 * unaffected: a focus reveals its system immediately whatever this is.
 */
export const MOON_REVEAL_PX = 24;

/** How close (AU) the camera must be to a parent for its moons to appear on a
 *  free approach — the parent's disc reaching MOON_REVEAL_PX. */
export function moonRevealThresholdAU(
  trueRadiusAU: number,
  viewportH: number,
  fovDeg: number,
): number {
  return apparentDepthAU(trueRadiusAU, MOON_REVEAL_PX, viewportH, fovDeg);
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
  ceilingRadiusAU: number,
  fitDistAU: number,
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

  // Twice the depth where the subject's disc crosses the marker the chart
  // would draw instead — past that the subject is a symbol among symbols
  // again. Judged on the CAMERA-INDEPENDENT radius, never the drawn one: a
  // planet's drawn radius pins to its pixel floor and grows with camera
  // depth, so a ceiling metered on it rides the camera out forever — the
  // clamp chased the zoom to thousands of AU instead of stopping it. And
  // never past the overview fit: beyond the frame that shows the whole
  // chart, the overview is the honest view, not a follow.
  const ceiling = Math.max(ceilingRadiusAU, 0);
  const crossDist = apparentDepthAU(
    ceiling,
    mapMarkerRadiusPx(ceiling, sizeParams),
    viewportH,
    fovDeg,
  );
  const spreadFloor = minDist * MAP_FOLLOW_MIN_SPREAD;
  const maxDist = Math.max(
    Math.min(
      Math.max(crossDist * MAP_FOLLOW_MAX_CROSSOVER_MUL, spreadFloor),
      Math.max(fitDistAU, 0) > 0 ? fitDistAU : Number.POSITIVE_INFINITY,
    ),
    spreadFloor,
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

/** The same four numbers for a camera that is not riding anything. Same shape
 *  as the follow shell's, under a name that doesn't claim a subject. */
export type MapCameraBounds = MapFollowBounds;

/**
 * The whole bounds transaction for the free overview camera.
 *
 * `extentAU` is the chart — the ball the orbit centrelines and the ship sit
 * inside — and it fixes how close the camera may come and how thin the near
 * plane may be. `farExtentAU` is what is actually DRAWN out to, which is the
 * chart plus whatever a revealed moon system stands off its parent; only the
 * far plane needs it, and using the centreline extent there would clip the
 * rings off the frame a departing system is still drawn on.
 *
 * `nearestClearanceDistAU` is the distance from the camera to the nearest drawn
 * surface, and the two degenerate values mean opposite things. `Infinity` is a
 * chart with no surface to meter against at all, so the chart's own term
 * governs. Zero or negative is a camera already INSIDE a drawn shell, and that
 * is the case that needs the thinnest plane there is: the chart's term is a
 * thousandth of the whole system, which from inside a shell would cut away the
 * body and everything else nearby. It falls to the floors instead.
 */
export function mapOverviewBounds(
  extentAU: number,
  farExtentAU: number,
  fitDistAU: number,
  cameraOriginDistAU: number,
  nearestClearanceDistAU: number,
  out: MapCameraBounds = { minDist: 0, maxDist: 0, near: 0, far: 0 },
): MapCameraBounds {
  const extent = Math.max(extentAU, 1e-6);
  // Everything drawn sits inside a ball of this radius about the Sun, so the
  // far plane only ever needs to reach its far side from here.
  const far = Math.max(cameraOriginDistAU, 0) + Math.max(farExtentAU, extent) * MAP_FAR_EXTENT_MARGIN;
  // Inside a shell (or handed a NaN) there is no room in front to spend, so the
  // surface term collapses to nothing and the floors alone hold the plane up.
  const surface = nearestClearanceDistAU > 0 ? nearestClearanceDistAU : 0;
  out.minDist = Math.min(extent * MAP_OVERVIEW_MIN_DIST_FRAC, MAP_OVERVIEW_MIN_DIST_AU);
  out.maxDist = fitDistAU * MAP_OVERVIEW_MAX_DIST_MUL;
  out.near = Math.max(
    Math.min(extent * MAP_OVERVIEW_NEAR_FRAC, surface * MAP_NEAR_SURFACE_FRAC),
    far / MAP_NEAR_FAR_RATIO,
    MAP_OVERVIEW_MIN_NEAR_AU,
  );
  out.far = far;
  return out;
}

/**
 * Where the free camera's pivot belongs: on the nearest drawn surface ahead of
 * it, held inside the shell it is allowed to orbit in.
 *
 * A cursor-anchored dolly moves the camera by a fraction of its own pivot
 * radius, so the radius is the whole travel budget — parked on the chart's
 * origin it can only ever spend the distance to the Sun, and a body further
 * off than that is unreachable at any minimum distance. Metering the pivot
 * against what is actually ahead makes every notch close the same fraction of
 * the REAL gap: the budget refills as the gap shrinks, and the approach becomes
 * asymptotic instead of finite. The same rule stops the zoom passing THROUGH a
 * body — the radius clamp is measured to its drawn surface, not to a point
 * behind it.
 */
export function mapOverviewPivotDistanceAU(
  nearestClearanceDistAU: number,
  minDistAU: number,
  maxDistAU: number,
): number {
  const lo = Math.max(minDistAU, 0);
  const hi = Math.max(maxDistAU, lo);
  // NaN and a camera inside the nearest surface both land on the floor.
  if (!(nearestClearanceDistAU > lo)) return lo;
  return Math.min(nearestClearanceDistAU, hi);
}

/**
 * How much closer one press of a zoom button leaves the camera — the step the
 * buttons spend, in place of a wheel notch's.
 *
 * Deliberately coarser than a wheel notch (~5%): a wheel is a continuous
 * gesture that spends dozens of notches without thinking, while a press is one
 * discrete decision and has to be worth making. A quarter closer per press
 * crosses the whole chart — the overview fit down to the closest a small moon
 * system can be approached, some five decades — in about fifty presses, which
 * a held repeat covers in a few seconds.
 */
export const MAP_ZOOM_NOTCH_FACTOR = 1.25;

/** How much of a step counts as a step. Relative, because the distances this
 *  is asked about span five decades, and an absolute epsilon that means
 *  anything at the overview is larger than the whole shell of a moon system. */
const MAP_ZOOM_STEP_EPS = 1e-6;

/**
 * The camera distance `notches` of the zoom buttons ask for, held inside the
 * shell the current state allows. Positive notches move CLOSER.
 *
 * Multiplicative, so one press covers the same fraction of the way in at every
 * scale — the chart spans five decades, and a fixed AU step would be a whole
 * system out at Pluto and imperceptible inside a moon system.
 */
export function mapZoomNotchDistanceAU(
  distAU: number,
  notches: number,
  minDistAU: number,
  maxDistAU: number,
): number {
  const lo = Math.max(minDistAU, 0);
  const hi = Math.max(maxDistAU, lo);
  if (!(distAU > 0)) return lo;
  const want = distAU * Math.pow(MAP_ZOOM_NOTCH_FACTOR, -notches);
  return Math.min(Math.max(want, lo), hi);
}

/**
 * Whether a press in this direction has anywhere left to go.
 *
 * This is the ONE question behind both the buttons' enabled state and the
 * hold-repeat's stop condition, and it is asked of the bounds themselves — not
 * of the controls' `minDistance`/`maxDistance`, which are rewritten from these
 * every frame and would chatter a disabled button on and off as the chart
 * breathes underneath it.
 *
 * The direction is part of the question. A camera sitting OUTSIDE its shell
 * (the bounds moved under it) still has a way in, and asking only whether the
 * clamped target differs would report the way out as open too — and then send
 * the camera inward for a press that asked for the opposite.
 */
export function mapZoomNotchAvailable(
  distAU: number,
  notches: number,
  minDistAU: number,
  maxDistAU: number,
): boolean {
  if (!(distAU > 0) || !Number.isFinite(notches) || notches === 0) return false;
  const target = mapZoomNotchDistanceAU(distAU, notches, minDistAU, maxDistAU);
  return notches > 0
    ? target < distAU * (1 - MAP_ZOOM_STEP_EPS)
    : target > distAU * (1 + MAP_ZOOM_STEP_EPS);
}

/** Which way the zoom buttons may still go. Filled into a caller's scratch —
 *  the answer is read every frame to paint the buttons. */
export interface MapZoomAvailability {
  zoomIn: boolean;
  zoomOut: boolean;
}

/** Both directions at once, from one set of bounds. `false` for both is the
 *  honest answer whenever nothing may move the camera at all — a shut map, a
 *  running dive, a focus flight writing its own pose. */
export function mapZoomAvailability(
  distAU: number,
  minDistAU: number,
  maxDistAU: number,
  out: MapZoomAvailability = { zoomIn: false, zoomOut: false },
): MapZoomAvailability {
  out.zoomIn = mapZoomNotchAvailable(distAU, 1, minDistAU, maxDistAU);
  out.zoomOut = mapZoomNotchAvailable(distAU, -1, minDistAU, maxDistAU);
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

/** How long the arrival pulse runs, and how many times it swells inside that. */
export const MAP_FOCUS_PULSE_MS = 1200;
const MAP_FOCUS_PULSE_CYCLES = 2;
/** How much of its predecessor each swell keeps — the second is a confirmation,
 *  not a repeat. */
const MAP_FOCUS_PULSE_DECAY = 0.45;

/**
 * The emphasis envelope for a focus flight LANDING, at `tMs` after it landed.
 *
 * Two swells over about a second, the second smaller, then nothing. It marks
 * the moment the camera stops flying and starts riding — which is otherwise
 * invisible on the small bodies, where the flight ends on a marker that never
 * changed size. Named for the transition rather than for "arrival", which in
 * this codebase is what a SHIP does.
 *
 * Exactly 0 outside [0, MAP_FOCUS_PULSE_MS), so a caller can drive it with a
 * running clock and stop when it returns to nothing.
 */
export function mapFocusLandPulse(tMs: number): number {
  if (!(tMs >= 0) || tMs >= MAP_FOCUS_PULSE_MS) return 0;
  const cycleMs = MAP_FOCUS_PULSE_MS / MAP_FOCUS_PULSE_CYCLES;
  const index = Math.floor(tMs / cycleMs);
  const phase = (tMs - index * cycleMs) / cycleMs;
  return Math.pow(MAP_FOCUS_PULSE_DECAY, index) * Math.sin(Math.PI * phase);
}
