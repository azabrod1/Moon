/**
 * Pure target-selection + vantage math for the Observatory's surface view:
 * given where the player is landed and which shadow event (if any) they
 * jumped to, decide what the narrow-FOV camera should look at, where on
 * the landed body's surface it should stand — the solar-eclipse view stands
 * on its event's pinned ground only while that event is in the sky and the
 * ground can see the Sun, never looking through the body at it — and how a
 * drag turns it (a level pan; `?lookdrag=eyepiece` turns it in its own frame
 * instead). No scene or DOM access — the PlanetariumMode adapter gathers
 * fresh scene positions from the renderer's own seams and passes plain
 * vectors in. Unit-tested in surfaceView.test.ts.
 */
import * as THREE from 'three';
import {
  shadowAxisSphereHitAU,
  shadowAxisSurfacePoint,
  type ShadowClassification,
} from '../astronomy/shadows';
import { DEG2RAD, RAD2DEG } from '../shared/math/angles';

/** What the surface view points at (resolved to scene positions by the owner). */
export type SurfaceTarget =
  | { kind: 'sun' }
  /** Solar-eclipse view: look at the Sun while standing where the occluder's
   *  shadow falls — while the event is in the sky and that ground can see the
   *  Sun (spotAnchorFor, standAtSpotAnchor); from the default vantage otherwise. */
  | { kind: 'sun-from-spot'; occluderMoonName: string }
  | { kind: 'moon'; moonName: string }
  | { kind: 'parent' };

export interface SurfaceLandedInfo {
  type: 'planet' | 'moon';
  name: string;
  /** The system's parent planet — present when type === 'moon'. */
  parentPlanet?: string;
}

export interface SurfaceEventInfo {
  kind: 'eclipse' | 'shadow-transit';
  parentPlanet: string;
  moonName: string;
}

/**
 * The observer-level circumstances table — what a surface observer on the
 * landed body actually sees of a given event:
 *
 *   on the parent + eclipse        → the moon (it dims; Earth's Moon reddens)
 *   on the parent + shadow transit → the Sun, standing in the shadow spot
 *                                    (a solar eclipse, silhouetted)
 *   on the moon   + own eclipse    → the Sun (the parent occults it)
 *   on the moon   + own transit    → the parent (your shadow crawls its disc)
 *   on a sibling  + eclipse        → the involved moon, from across the system
 *   on a sibling  + transit        → the parent (the spot — no spot-standing:
 *                                    the spot is on the parent, not under you)
 *   no event                       → the companion subject: Earth→Moon,
 *                                    moon→parent, generic planet→Sun
 *
 * Total over all inputs; never resolves to the landed body itself.
 */
export function selectSurfaceTarget(
  landed: SurfaceLandedInfo,
  event: SurfaceEventInfo | null,
): SurfaceTarget {
  const systemParent = landed.type === 'planet' ? landed.name : landed.parentPlanet;
  if (event && event.parentPlanet === systemParent) {
    if (landed.type === 'planet') {
      return event.kind === 'eclipse'
        ? { kind: 'moon', moonName: event.moonName }
        : { kind: 'sun-from-spot', occluderMoonName: event.moonName };
    }
    if (landed.name === event.moonName) {
      return event.kind === 'eclipse' ? { kind: 'sun' } : { kind: 'parent' };
    }
    return event.kind === 'eclipse'
      ? { kind: 'moon', moonName: event.moonName }
      : { kind: 'parent' };
  }
  if (landed.type === 'moon') return { kind: 'parent' };
  if (landed.name === 'Earth') return { kind: 'moon', moonName: 'Moon' };
  return { kind: 'sun' };
}

/**
 * Present-tense one-liner for what a surface observer on `landed` sees of the
 * event — a pure function of the observer/event relationship, deliberately
 * NOT of the camera target: the camera can be re-pointed (vantage swap, free
 * look) while the sentence must keep describing the sky truthfully. Mirrors
 * the selectSurfaceTarget table row for row.
 */
export function surfaceEventNarrative(landed: SurfaceLandedInfo, spec: SurfaceEventInfo): string {
  const moonDisplay = narrativeMoonName(spec);
  if (landed.type === 'moon' && landed.name === spec.moonName) {
    return spec.kind === 'eclipse'
      ? `${spec.parentPlanet} is covering the Sun`
      : `Your shadow is crossing ${spec.parentPlanet}`;
  }
  if (landed.type === 'planet' && landed.name === spec.parentPlanet && spec.kind === 'shadow-transit') {
    return `${moonDisplay} is crossing the Sun`;
  }
  return spec.kind === 'eclipse'
    ? `${moonDisplay} is in ${spec.parentPlanet}'s shadow`
    : `${moonDisplay}'s shadow is crossing ${spec.parentPlanet}`;
}

function narrativeMoonName(spec: SurfaceEventInfo): string {
  return spec.parentPlanet === 'Earth' && spec.moonName === 'Moon' ? 'The Moon' : spec.moonName;
}

/**
 * True where the observer is outside the event's own geometry — watching
 * from the parent's ground during an eclipse, or from a sibling moon. These
 * are the fall-through rows of the narrative table above.
 */
function watchesFromOutside(landed: SurfaceLandedInfo, spec: SurfaceEventInfo): boolean {
  if (landed.type === 'moon' && landed.name === spec.moonName) return false;
  return !(
    landed.type === 'planet' &&
    landed.name === spec.parentPlanet &&
    spec.kind === 'shadow-transit'
  );
}

/**
 * The same table condensed for a slot too narrow for the sentence: the rows
 * that watch from outside the event drop their verb ("Io's shadow on
 * Jupiter"), which is where the longest sentences overrun. The rows an
 * observer is inside are short already and stay as they read in the HUD.
 */
export function surfaceEventPhrase(landed: SurfaceLandedInfo, spec: SurfaceEventInfo): string {
  if (!watchesFromOutside(landed, spec)) return surfaceEventNarrative(landed, spec);
  const moonDisplay = narrativeMoonName(spec);
  return spec.kind === 'eclipse'
    ? `${moonDisplay} in ${spec.parentPlanet}'s shadow`
    : `${moonDisplay}'s shadow on ${spec.parentPlanet}`;
}

/**
 * Display name with the article convention: Earth's Moon reads "the Moon"
 * in prose ("look up from the Moon") and the Sun reads "the Sun"; every
 * proper-named body stays bare.
 */
export function bodyDisplayName(name: string): string {
  if (name === 'Moon') return 'the Moon';
  if (name === 'Sun') return 'the Sun';
  return name;
}

/**
 * The hint the solar-eclipse view gives in place of "what you'll see" while
 * the ground it stands on for the event has the Sun under its limb, and the
 * frame shows the Sun, uneclipsed, from the default vantage instead
 * (standAtSpotAnchor).
 */
export const SURFACE_SPOT_SUN_DOWN = "the Sun is below the horizon in the shadow's path";

/**
 * "What you'll see" hint for an event, from this observer: a penumbral
 * eclipse honestly renders as a subtle dimming, which reads as
 * nothing-happened unless the UI says that's the show. Branches mirror
 * surfaceEventNarrative; phrases stay short (toast/row-friendly) and never
 * promise drama the classification can't deliver. The engine's transit
 * classifier never emits 'penumbral' (penumbra-only contact is 'partial');
 * the branch folds them together defensively.
 */
export function surfaceEventExpectation(
  landed: SurfaceLandedInfo,
  spec: SurfaceEventInfo,
  classification: ShadowClassification,
): string {
  if (classification === 'none') return '';
  const parent = spec.parentPlanet;
  const moonDisplay = bodyDisplayName(spec.moonName);
  if (landed.type === 'moon' && landed.name === spec.moonName) {
    if (spec.kind === 'eclipse') {
      // You are the eclipsed moon: the parent covers (some of) your Sun.
      switch (classification) {
        case 'penumbral': return 'daylight barely dims';
        case 'partial': return 'the Sun is partly covered';
        case 'annular': return `a bright ring of Sun remains around ${parent}`;
        case 'total': return `the Sun vanishes behind ${parent}`;
      }
    }
    // Your own shadow on the parent's disc.
    switch (classification) {
      case 'penumbral':
      case 'partial': return `just a faint penumbral shading on ${parent}`;
      case 'annular': return 'a soft-edged spot, the dark core falls short';
      case 'total': return `a crisp dark spot on ${parent}`;
    }
  }
  if (landed.type === 'planet' && landed.name === parent && spec.kind === 'shadow-transit') {
    // Standing in the shadow spot, watching a solar eclipse.
    switch (classification) {
      case 'penumbral':
      case 'partial': return 'the Sun is only partly covered, no darkness';
      case 'annular': return `a ring of Sun remains around ${moonDisplay} at peak`;
      case 'total': return 'the Sun is fully covered at peak';
    }
  }
  if (spec.kind === 'eclipse') {
    // Watching the eclipsed moon from the parent or a sibling.
    switch (classification) {
      case 'penumbral': return 'subtle dimming only, easy to miss';
      case 'partial': return 'partly darkened at peak';
      case 'annular': return 'dims, never fully dark';
      case 'total':
        return parent === 'Earth' && spec.moonName === 'Moon'
          ? 'turns blood-red at totality'
          : 'fades to black at totality';
    }
  }
  // Watching the shadow crawl the parent's disc from a sibling.
  switch (classification) {
    case 'penumbral':
    case 'partial': return 'a pale grazing shadow, barely visible';
    case 'annular': return 'a soft shadow dot, no dark core';
    case 'total': return `a small dark dot crawling across ${parent}`;
  }
}

/** Minimum eye height: the camera near plane is 1e-6 AU (~150 km) — stay clear of it. */
export const SURFACE_MIN_ALTITUDE_AU = 2.5e-6;

/**
 * Eye height above the surface: 2% of the body radius, floored at the
 * near-plane clearance — small moons get a "hovering" vantage by design.
 */
export function surfaceAltitudeAU(bodyRadiusAU: number): number {
  return Math.max(0.02 * bodyRadiusAU, SURFACE_MIN_ALTITUDE_AU);
}

/**
 * Elevation above the local horizon the tracked target sits at by default.
 * A zenith target gives drag-yaw nothing to pan against — horizontal drag
 * becomes a roll about the look axis and the sky pivots around the target.
 * 68° keeps the target commanding while leaving a
 * horizon band in frame as a stable pan reference.
 */
export const SURFACE_TARGET_ELEVATION_DEG = 68;

const tmpTargetDir = new THREE.Vector3();
const tmpPoleTangent = new THREE.Vector3();

/**
 * Default vantage: hover above a surface point chosen so the look target
 * sits at `targetElevationDeg` above the local horizon (90° = the
 * sub-target zenith). The observer is displaced from the sub-target point
 * toward `poleAxis` — the body's north — so the target culminates toward
 * the local south, the way a mid-latitude observer sees the sky.
 *
 * The azimuth reference is simply the pole's component ⊥ the target
 * direction — continuous everywhere except the exact pole. A target passing
 * NEAR the pole swings the standing point quickly but smoothly (a compass
 * carried past the pole does the same); only at true float-degeneracy
 * (target along the pole, e.g. a Uranus-solstice Sun) does a deterministic
 * fallback take over, picked against the constant pole so it can never flip
 * mid-track. Blended/banded schemes were tried and rejected: any mix of a
 * rotating reference with a fixed one must either cancel through zero or
 * flip sign somewhere on a circle around the pole (pinned by the circling
 * test in surfaceView.test.ts). Body-centered scene AU. The elevation is
 * nominal for distant targets; close-in ones sit lower because the observer
 * stands a body radius off-center (Metis from Jupiter culminates near 44°,
 * Phobos from Mars near 56°) — never below the horizon, which would need an
 * orbit under ~1.08 body radii. Pinned by the close-in test.
 */
export function computeSubTargetVantage(
  bodyRadiusAU: number,
  dirToTarget: THREE.Vector3,
  poleAxis: THREE.Vector3,
  targetElevationDeg: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const targetDir = tmpTargetDir.copy(dirToTarget);
  if (targetDir.lengthSq() < 1e-30) targetDir.set(1, 0, 0);
  targetDir.normalize();
  const poleTangent = tmpPoleTangent.copy(poleAxis).addScaledVector(targetDir, -poleAxis.dot(targetDir));
  if (poleTangent.lengthSq() < 1e-12) {
    const ax = Math.abs(poleAxis.x);
    const ay = Math.abs(poleAxis.y);
    const az = Math.abs(poleAxis.z);
    if (ax <= ay && ax <= az) poleTangent.set(1, 0, 0);
    else if (ay <= az) poleTangent.set(0, 1, 0);
    else poleTangent.set(0, 0, 1);
    poleTangent.addScaledVector(targetDir, -poleTangent.dot(targetDir));
  }
  poleTangent.normalize();
  const tiltRad = (90 - targetElevationDeg) * DEG2RAD;
  out.copy(targetDir)
    .multiplyScalar(Math.cos(tiltRad))
    .addScaledVector(poleTangent, Math.sin(tiltRad));
  return out.normalize().multiplyScalar(bodyRadiusAU + surfaceAltitudeAU(bodyRadiusAU));
}

const tmpInvOrientation = new THREE.Quaternion();

/**
 * Stand-still eclipse observer: the shadow-spot direction at one chosen
 * instant (the event's peak), expressed in the body's rotating frame so the
 * point stays on real ground as the body spins. Re-deriving the standing
 * point from the live shadow geometry every frame made the observer chase
 * the point of maximum cover: the occluder raced onto the Sun, backed off,
 * covered it again at the true peak, and re-aligned once more on the way
 * out — three alignments where a fixed observer sees one clean pass.
 *
 * The spot is shadowAxisSurfacePoint's: the axis/sphere hit for a central
 * event, the deepest-cover point when the umbral axis misses the disc (a
 * partial event, whose deepest point has the Sun on the horizon). `shadowAxis`
 * is the occluder's unit anti-sunward axis, `occluderOffsetAU` its position
 * from the landed body.
 */
export function computeSpotAnchorLocal(
  occluderOffsetAU: THREE.Vector3,
  shadowAxis: THREE.Vector3,
  bodyRadiusAU: number,
  bodyOrientation: THREE.Quaternion,
  out: THREE.Vector3,
): THREE.Vector3 {
  // Intersect at the camera's flying shell, not the ground: the surface camera
  // hovers well above the terrain (hundreds of km on Earth), and lifting the
  // ground-level axis point radially displaced it off the umbral line by
  // altitude x sin(axis incidence) — on a slanted-axis eclipse that is
  // hundreds of km, a Moon that never fully covers the Sun. The axis pierced
  // at the shell IS the point the camera occupies, so peak alignment is exact.
  shadowAxisSurfacePoint(
    occluderOffsetAU,
    shadowAxis,
    bodyRadiusAU + surfaceAltitudeAU(bodyRadiusAU),
    out,
  );
  return out.normalize().applyQuaternion(tmpInvOrientation.copy(bodyOrientation).invert());
}

/** World vantage for a stored rotating-frame anchor at the body's current orientation. */
export function computeAnchoredSpotVantage(
  bodyRadiusAU: number,
  anchorLocal: THREE.Vector3,
  bodyOrientation: THREE.Quaternion,
  out: THREE.Vector3,
): THREE.Vector3 {
  return out
    .copy(anchorLocal)
    .applyQuaternion(bodyOrientation)
    .normalize()
    .multiplyScalar(bodyRadiusAU + surfaceAltitudeAU(bodyRadiusAU));
}

const tmpSightline = new THREE.Vector3();

/**
 * Whether the landed body's limb hides a target from the eye: the sightline
 * from `eyeAU` to `targetAU` (body-centered AU) meets the body's sphere before
 * it reaches the target — the same near hit the shadow axis takes, cast along
 * the sightline. The default vantage can never do this, holding its target
 * high by construction; the stand-still eclipse observer can, because it turns
 * with the ground. At 07:03:39 UTC, nine hours before the 2027-02-06 annular,
 * the pinned spot has the Sun 21° below its horizon, under a limb that dips 19°
 * from the camera's shell; a long transit of a fast-spinning giant (Titan's
 * shadow on Saturn) does it without the clock ever leaving the event.
 */
export function targetBelowLimb(
  eyeAU: THREE.Vector3,
  targetAU: THREE.Vector3,
  bodyRadiusAU: number,
): boolean {
  const sightline = tmpSightline.copy(targetAU).sub(eyeAU);
  const distanceAU = sightline.length();
  if (distanceAU === 0) return false;
  const hitAU = shadowAxisSphereHitAU(eyeAU, sightline.divideScalar(distanceAU), bodyRadiusAU);
  return hitAU !== null && hitAU < distanceAU;
}

/** A pin of the stand-still eclipse observer: the peak it was made for, and
 *  the shadow-spot direction in the landed body's rotating frame there. */
export interface SpotAnchor {
  peakUtcMs: number;
  local: THREE.Vector3;
}

/**
 * The pin the solar-eclipse view may stand on this frame. It belongs to its
 * event: none unless the event in the sky — the one the HUD narrates, null once
 * the clock has left its window — is this occluder's shadow on the ground
 * underfoot; the cached pin when it was made for that event's peak; otherwise a
 * fresh one (`pin` is called only then). Kept past its event, the pinned ground
 * just turned with the planet: rewound nine hours from the 2027-02-06 annular it
 * had the Sun under the limb, and the view looked through Earth at it.
 */
export function spotAnchorFor(
  cached: SpotAnchor | null,
  landed: SurfaceLandedInfo,
  occluderMoonName: string,
  event: { peakUtcMs: number; spec: SurfaceEventInfo } | null,
  pin: (peakUtcMs: number) => THREE.Vector3 | null,
): SpotAnchor | null {
  if (
    !event ||
    landed.type !== 'planet' ||
    event.spec.kind !== 'shadow-transit' ||
    event.spec.parentPlanet !== landed.name ||
    event.spec.moonName !== occluderMoonName
  ) {
    return null;
  }
  if (cached?.peakUtcMs === event.peakUtcMs) return cached;
  const local = pin(event.peakUtcMs);
  return local ? { peakUtcMs: event.peakUtcMs, local } : null;
}

/**
 * Stand on a pinned eclipse spot if that ground can see the target: writes the
 * anchored vantage to `out` and returns whether the frame should use it. A look
 * up is never a look through the ground, so a pin whose Sun is under the limb
 * hands the frame to the default vantage until the ground turns it back up —
 * never inside an Earth eclipse's own contacts (every one of 2000–2100 keeps
 * it 3.6° or more above), but in a grazing partial's padding hour, in
 * Callisto's transits of Jupiter, and mid-transit for Titan or Iapetus on
 * Saturn, whose shadows outlast a good part of its day.
 */
export function standAtSpotAnchor(
  anchor: SpotAnchor | null,
  bodyRadiusAU: number,
  bodyOrientation: THREE.Quaternion,
  targetAU: THREE.Vector3,
  out: THREE.Vector3,
): boolean {
  if (!anchor) return false;
  computeAnchoredSpotVantage(bodyRadiusAU, anchor.local, bodyOrientation, out);
  return !targetBelowLimb(out, targetAU, bodyRadiusAU);
}

/**
 * Up vector for the tracking camera, parallel-transported frame to frame.
 * Both vantages above put the target at the observer's local zenith, so a
 * zenith up is parallel to the look direction and lookAt's basis is
 * degenerate — the orientation comes out as floating-point noise. Instead,
 * project last frame's up off the current forward axis: continuous roll,
 * never parallel to forward. Mutates and returns `up` (per-frame zero-alloc).
 * If the seed itself is parallel to forward, restarts from the world axis
 * least aligned with the look direction.
 */
export function transportTrackingUp(up: THREE.Vector3, forward: THREE.Vector3): THREE.Vector3 {
  up.addScaledVector(forward, -up.dot(forward));
  if (up.lengthSq() < 1e-12) {
    const ax = Math.abs(forward.x);
    const ay = Math.abs(forward.y);
    const az = Math.abs(forward.z);
    if (ax <= ay && ax <= az) up.set(1, 0, 0);
    else if (ay <= az) up.set(0, 1, 0);
    else up.set(0, 0, 1);
    up.addScaledVector(forward, -up.dot(forward));
  }
  return up.normalize();
}

/** Where the drag's yaw gain stops growing: the cosine of an 80° elevation,
 *  toward the zenith or the nadir. */
export const SURFACE_LOOK_COS_FLOOR = Math.cos(80 * DEG2RAD);

/** How close to the zenith or the nadir a drag may pitch the view. */
export const SURFACE_LOOK_MAX_ELEVATION_DEG = 89;

/** One drag step of the surface look: the two level-pan rotations. */
export interface SurfaceLookRotation {
  /** About the local zenith. */
  yawRad: number;
  /** About the horizontal axis across the view; positive raises the view. */
  pitchRad: number;
}

const tmpDrag = new THREE.Vector3();
const tmpAzimuthal = new THREE.Vector3();
const tmpUpTheSky = new THREE.Vector3();

/**
 * Drag look-around as a level pan — yaw about the local zenith, pitch about
 * the horizontal axis across the view — sized so the sky at the middle of the
 * screen follows the finger in direction and in distance, whatever the
 * camera's roll. The tracking camera's up is carried over from the orbit view,
 * not levelled to the ground, so the zenith can project anywhere around the
 * frame: feeding the finger's pixels straight into the yaw moved the sky
 * sideways at cos(elevation) of the finger's speed (0.37 at the default 68°),
 * slanted by the roll, and backwards wherever the zenith sat below the target
 * — the Sun culminating north of a southern eclipse spot, Uranus from its
 * moons.
 *
 * `rightRad` and `downRad` are the finger's motion in radians of sky (screen
 * right, screen down); the basis vectors are the camera's in world space. A
 * yaw ψ swings the view by ψ·(z × f) and a pitch θ by θ·B, B the unit
 * up-the-sky direction at f; the sky moves the opposite way, and the two
 * directions are orthogonal, so each rotation is one projection of the drag.
 *
 * A yaw about the zenith is a pan of ψ·cos(elevation) and a turn of the whole
 * frame about its middle of ψ·sin(elevation): keeping the horizon level while
 * looking up twists the field by tan(elevation) of what it pans, 2.5× at 68°,
 * as an alt-azimuth telescope does. That ratio is the model's, and was the
 * same when the pan lagged the finger; following the finger makes both
 * larger per pixel. The yaw's lever |z × f| is cos(elevation) and vanishes at
 * the zenith and the nadir, so its gain is capped at 1/cos 80°: steeper than
 * that the sky lags the finger, which bounds the twist rather than removing it.
 */
export function surfaceLookRotation(
  forward: THREE.Vector3,
  cameraUp: THREE.Vector3,
  cameraRight: THREE.Vector3,
  zenith: THREE.Vector3,
  rightRad: number,
  downRad: number,
  out: SurfaceLookRotation,
): SurfaceLookRotation {
  // The motion the sky under the middle of the screen must make, as a
  // tangent at the view direction (screen down is camera −up).
  const drag = tmpDrag.copy(cameraRight).multiplyScalar(rightRad).addScaledVector(cameraUp, -downRad);
  const azimuthal = tmpAzimuthal.crossVectors(zenith, forward);
  const cosElevation = azimuthal.length();
  if (cosElevation < 1e-9) {
    // Straight up or down there is no azimuth to pan along: the pitch alone,
    // about whatever axis the caller falls back to. Only a view within a
    // nanoradian of the zenith lands here — tracking can hold one past the
    // drag clamp, not that close — and it keeps the function total.
    out.yawRad = 0;
    out.pitchRad = downRad;
    return out;
  }
  const upTheSky = tmpUpTheSky
    .copy(zenith)
    .addScaledVector(forward, -forward.dot(zenith))
    .divideScalar(cosElevation);
  out.pitchRad = -drag.dot(upTheSky);
  out.yawRad =
    -drag.dot(azimuthal) / (cosElevation * Math.max(cosElevation, SURFACE_LOOK_COS_FLOOR));
  return out;
}

const tmpLookForward = new THREE.Vector3();
const tmpLookUp = new THREE.Vector3();
const tmpLookRight = new THREE.Vector3();
const tmpLookAxis = new THREE.Vector3();
const tmpLookTurn = new THREE.Quaternion();
const lookRotation: SurfaceLookRotation = { yawRad: 0, pitchRad: 0 };

/**
 * One drag step applied to a camera's orientation, in place: the level pan
 * surfaceLookRotation solves — the yaw about the zenith, then the pitch about
 * the horizontal axis across the view the yaw left, which is exactly the
 * elevation's change and so is clamped short of the zenith and the nadir, and
 * the view can never flip over the pole. Looking dead along the zenith there is
 * no horizontal axis, and the camera's own right stands in. For a camera with
 * no parent — the surface camera has none — its quaternion is its world pose.
 */
export function applySurfaceLookDrag(
  quaternion: THREE.Quaternion,
  zenith: THREE.Vector3,
  rightRad: number,
  downRad: number,
): THREE.Quaternion {
  const forward = tmpLookForward.set(0, 0, -1).applyQuaternion(quaternion);
  const look = surfaceLookRotation(
    forward,
    tmpLookUp.set(0, 1, 0).applyQuaternion(quaternion),
    tmpLookRight.set(1, 0, 0).applyQuaternion(quaternion),
    zenith,
    rightRad,
    downRad,
    lookRotation,
  );
  quaternion.premultiply(tmpLookTurn.setFromAxisAngle(zenith, look.yawRad));
  forward.set(0, 0, -1).applyQuaternion(quaternion);
  // |f × z| is cos(elevation) and f · z its sine: atan2 of the pair holds its
  // precision at the zenith, where an asin of the dot loses half its digits.
  const horizontal = tmpLookAxis.crossVectors(forward, zenith);
  const elevation = Math.atan2(forward.dot(zenith), horizontal.length());
  const maxElevation = SURFACE_LOOK_MAX_ELEVATION_DEG * DEG2RAD;
  const targetElevation = THREE.MathUtils.clamp(
    elevation + look.pitchRad,
    -maxElevation,
    maxElevation,
  );
  if (horizontal.lengthSq() > 1e-18) horizontal.normalize();
  else horizontal.set(1, 0, 0).applyQuaternion(quaternion);
  return quaternion.premultiply(
    tmpLookTurn.setFromAxisAngle(horizontal, targetElevation - elevation),
  );
}

const CAMERA_RIGHT = new THREE.Vector3(1, 0, 0);
const CAMERA_UP = new THREE.Vector3(0, 1, 0);

/**
 * The eyepiece drag, the A/B behind `?lookdrag=eyepiece`: the camera turns
 * about its own up and right axes, the way a hand swings a telescope, so the
 * sky follows the finger across the whole frame and the frame never twists —
 * where the level pan above turns it by tan(elevation) of what it pans, 21°
 * for a full-width drag at the 2027-02-06 eclipse spot. What it gives up is
 * that pan's horizon: a long sideways sweep runs along a great circle and
 * sinks toward the horizon instead of circling at one height, drags that go
 * round in circles roll the view against the ground, and the zenith is no
 * stop — the view passes over it, and nothing flips, because nothing here is
 * held level to begin with.
 */
export function applySurfaceEyepieceDrag(
  quaternion: THREE.Quaternion,
  rightRad: number,
  downRad: number,
): THREE.Quaternion {
  // Turning the view left carries the sky right, and pitching it up carries
  // the sky down: both are turns in the camera's own frame, so post-multiplied.
  quaternion.multiply(tmpLookTurn.setFromAxisAngle(CAMERA_UP, rightRad));
  return quaternion.multiply(tmpLookTurn.setFromAxisAngle(CAMERA_RIGHT, downRad));
}

export const SURFACE_FOV_MIN_DEG = 1.5;
export const SURFACE_FOV_MAX_DEG = 45;
export const SURFACE_FOV_DEFAULT_DEG = 10;

export function clampSurfaceFovDeg(fovDeg: number): number {
  return Math.min(SURFACE_FOV_MAX_DEG, Math.max(SURFACE_FOV_MIN_DEG, fovDeg));
}

/** How the surface view was entered: pointed at a specific event (jump /
 * live event) or at the standing companion subject. */
export type SurfaceEntryContext = 'event' | 'companion';

/**
 * Entry FOV fits the subject's disc to a fraction of the frame, then clamps —
 * so a target reads at a comfortable size whatever its true angular size: a
 * tiny Moon (∅0.5°) isn't a speck and a looming parent (Jupiter from Io ∅19.5°)
 * doesn't overflow. Event entries frame tightest, ~1/8 of the frame, leaving
 * room around the disc to read the eclipse/transit geometry; the plain
 * companion sky fills more, ~1/4, since there's no event to frame around it.
 * Fitting (rather than a flat resting FOV) is what keeps the Moon from
 * bottoming out tiny while still capping how large the companion can grow.
 */
export function entryFovDeg(
  targetAngularDiameterDeg: number,
  context: SurfaceEntryContext = 'companion',
  subjectIsSun = false,
): number {
  // The Sun is a bright, near-featureless disc: fitting it like a textured body
  // (below) fills the sky with glare and erases its real size cue (large from
  // Mercury, a point from Neptune). Show it at the resting sky FOV instead, so
  // its true apparent size reads. A solar eclipse is the 'event' path — there
  // the framing is the whole point, so it still fits.
  if (subjectIsSun && context !== 'event') return SURFACE_FOV_DEFAULT_DEG;
  const fillMultiplier = context === 'event' ? 8 : 4;
  return clampSurfaceFovDeg(targetAngularDiameterDeg * fillMultiplier);
}

/** Projected disc height in pixels for a disc of `discDeg` at `fovDeg`. */
export function projectedDiscPx(discDeg: number, fovDeg: number, viewportHeightPx: number): number {
  return (discDeg / fovDeg) * viewportHeightPx;
}

/** Marker-swap thresholds (px, with hysteresis): below the reticle bound the
 * HUD shows the sub-resolution reticle; above the brackets bound, the
 * resolvable-disc brackets; between, whatever it already shows. */
export const MARKER_RETICLE_MAX_PX = 10;
export const MARKER_BRACKETS_MIN_PX = 14;

/** Bracket ceiling (disc height as a fraction of the viewport, with
 * hysteresis): past it the disc dominates the frame and a locator box stops
 * locating — the bracket size cap pins the box smaller than the disc, so its
 * corners float in empty sky far off the limb and read as detached. The
 * anchored cluster (disc note + tracking pill) carries on alone. */
export const MARKER_PILL_MIN_DISC_FRAC = 0.66;
export const MARKER_PILL_EXIT_DISC_FRAC = 0.58;

export type SurfaceMarkerKind = 'brackets' | 'reticle' | 'pill';

/**
 * Which target marker the HUD draws — the shared resolvability decision
 * (one helper so the panel, HUD, and scene never disagree about "too
 * small"). Hysteresis keeps the swaps from flickering as the disc breathes
 * around either threshold.
 */
export function resolveMarkerKind(
  discPx: number,
  current: SurfaceMarkerKind,
  viewportHeightPx: number,
): SurfaceMarkerKind {
  const frac = discPx / viewportHeightPx;
  if (frac >= MARKER_PILL_MIN_DISC_FRAC) return 'pill';
  if (current === 'pill' && frac > MARKER_PILL_EXIT_DISC_FRAC) return 'pill';
  if (discPx >= MARKER_BRACKETS_MIN_PX) return 'brackets';
  if (discPx <= MARKER_RETICLE_MAX_PX) return 'reticle';
  return current;
}

/** Shadow-guide resolvability thresholds (px, with hysteresis): cone
 * silhouette edges and footprint rings activate once their screen size
 * (measured footprint or analytic tangent disc, whichever the caller can
 * answer with everywhere) clears the ON bound and hold until it drops below
 * the OFF bound. The band is also what absorbs the small difference between
 * those two sizings, so a caller may switch without a step at the gate. Sits
 * below the marker scale (MARKER_BRACKETS_MIN_PX) deliberately — guides are
 * hairlines, legible a little earlier than a bracketed disc. */
export const GUIDE_RESOLVABLE_ON_PX = 8;
export const GUIDE_RESOLVABLE_OFF_PX = 6;

/** Hysteresis gate for a shadow guide whose projected size is `discPx`. */
export function resolveGuideVisibility(discPx: number, current: boolean): boolean {
  if (discPx >= GUIDE_RESOLVABLE_ON_PX) return true;
  if (discPx <= GUIDE_RESOLVABLE_OFF_PX) return false;
  return current;
}

/** Nominal viewport for the events list's static speck flag — the list can't
 * know the live canvas, so it judges against a typical screen height. */
const LIST_FLAG_VIEWPORT_PX = 800;

/**
 * True when a disc of `discDeg` can never resolve from this vantage, even at
 * the tightest zoom — the events list dims these rows. "Resolve" means the
 * same thing everywhere: the disc would earn the brackets marker
 * (≥ MARKER_BRACKETS_MIN_PX), so a row's ● promise and the HUD's
 * reticle/caption can't contradict each other after a jump.
 */
export function isBelowResolutionAtMaxZoom(discDeg: number): boolean {
  return (
    projectedDiscPx(discDeg, SURFACE_FOV_MIN_DEG, LIST_FLAG_VIEWPORT_PX) < MARKER_BRACKETS_MIN_PX
  );
}

/** Apparent angular diameter (degrees) of a sphere of radius r seen from distance d. */
export function angularDiameterDeg(radiusAU: number, distanceAU: number): number {
  if (distanceAU <= radiusAU) return 180;
  return 2 * Math.asin(radiusAU / distanceAU) * RAD2DEG;
}

/** One row of the Look-at menu: a pickable sky target with its live size. */
export interface SurfaceTargetChoice {
  target: SurfaceTarget;
  /** Display name, bodyDisplayName conventions ("the Moon", "Io"). */
  name: string;
  /** Apparent diameter from the vantage at menu-open time (degrees). */
  discDeg: number;
  /** False when the disc can never earn the brackets marker even at max
   *  zoom — the row dims but stays pickable (the reticle + honesty caption
   *  handle it in-view). */
  resolvable: boolean;
  /** Row dot tint — the body's catalog color (the deck-row dot idiom). */
  color: number;
}

export function makeSurfaceTargetChoice(
  target: SurfaceTarget,
  name: string,
  discDeg: number,
  color = 0xffffff,
): SurfaceTargetChoice {
  return { target, name, discDeg, resolvable: !isBelowResolutionAtMaxZoom(discDeg), color };
}

/**
 * Stable identity for marking the menu's current row: the solar-eclipse
 * spot view is still "looking at the Sun", so both sun kinds share a key.
 */
export function surfaceTargetKey(target: SurfaceTarget): string {
  switch (target.kind) {
    case 'sun':
    case 'sun-from-spot':
      return 'sun';
    case 'parent':
      return 'parent';
    case 'moon':
      return `moon:${target.moonName}`;
  }
}

/**
 * Look-at menu order: pinned leads first — the parent (only present standing
 * on a moon), then the Sun — then the moons by descending apparent size, so
 * a big system reads Galileans-first with the irregular specks pooled at the
 * scrollable bottom. Equal-size moons keep input order.
 */
export function orderSurfaceTargetChoices(choices: SurfaceTargetChoice[]): SurfaceTargetChoice[] {
  const rank = (c: SurfaceTargetChoice) =>
    c.target.kind === 'parent' ? 0 : c.target.kind === 'moon' ? 2 : 1;
  return [...choices].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    return ra === 2 ? b.discDeg - a.discDeg : 0;
  });
}

/** Display formatting for an apparent diameter — never prints "0.00°": below
 * the two-decimal floor it reads "<0.01" (an honest speck, not a zero). */
export function formatDiscDeg(deg: number): string {
  if (deg < 0.005) return '<0.01';
  return deg >= 1 ? deg.toFixed(1) : deg.toFixed(2);
}
