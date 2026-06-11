/**
 * Pure target-selection + vantage math for the Observatory's surface view:
 * given where the player is landed and which shadow event (if any) they
 * jumped to, decide what the narrow-FOV camera should look at and where on
 * the landed body's surface it should stand. No scene or DOM access — the
 * PlanetariumMode adapter gathers fresh scene positions from the renderer's
 * own seams and passes plain vectors in. Unit-tested in surfaceView.test.ts.
 */
import * as THREE from 'three';
import { shadowAxisSurfacePoint, type ShadowClassification } from '../astronomy/shadows';
import { DEG2RAD, RAD2DEG } from '../shared/math/angles';

/** What the surface view points at (resolved to scene positions by the owner). */
export type SurfaceTarget =
  | { kind: 'sun' }
  /** Solar-eclipse view: look at the Sun while standing where the occluder's shadow falls. */
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
  const moonDisplay =
    spec.parentPlanet === 'Earth' && spec.moonName === 'Moon' ? 'The Moon' : spec.moonName;
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

/**
 * "What you'll see" hint for an event, from this observer (design-brief #28):
 * a penumbral eclipse honestly renders as a subtle dimming, which reads as
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
  const moonMid =
    parent === 'Earth' && spec.moonName === 'Moon' ? 'the Moon' : spec.moonName;
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
      case 'annular': return `a ring of Sun remains around ${moonMid} at peak`;
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
 * becomes a roll about the look axis and the sky pivots around the target
 * (design-brief #26). 68° keeps the target commanding while leaving a
 * horizon band in frame as a stable pan reference.
 */
export const SURFACE_TARGET_ELEVATION_DEG = 68;

const tmpVantageT = new THREE.Vector3();
const tmpVantageH = new THREE.Vector3();

/**
 * Default vantage: hover above a surface point chosen so the look target
 * sits at `targetElevationDeg` above the local horizon (90° = the legacy
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
  const t = tmpVantageT.copy(dirToTarget);
  if (t.lengthSq() < 1e-30) t.set(1, 0, 0);
  t.normalize();
  const h = tmpVantageH.copy(poleAxis).addScaledVector(t, -poleAxis.dot(t));
  if (h.lengthSq() < 1e-12) {
    const ax = Math.abs(poleAxis.x);
    const ay = Math.abs(poleAxis.y);
    const az = Math.abs(poleAxis.z);
    if (ax <= ay && ax <= az) h.set(1, 0, 0);
    else if (ay <= az) h.set(0, 1, 0);
    else h.set(0, 0, 1);
    h.addScaledVector(t, -h.dot(t));
  }
  h.normalize();
  const tiltRad = (90 - targetElevationDeg) * DEG2RAD;
  out.copy(t)
    .multiplyScalar(Math.cos(tiltRad))
    .addScaledVector(h, Math.sin(tiltRad));
  return out.normalize().multiplyScalar(bodyRadiusAU + surfaceAltitudeAU(bodyRadiusAU));
}

/**
 * Solar-eclipse vantage: stand where the occluder's shadow falls on the
 * landed body — the axis/sphere hit for central events, the deepest-cover
 * surface point when the umbral axis misses the disc (partial events), the
 * sub-occluder point when there's no shadow contact at all (scrubbing before
 * or after the event). `occluderOffsetAU` is the occluding moon's position
 * relative to the landed body; `shadowAxis` its unit anti-sunward axis.
 */
export function computeShadowSpotVantage(
  bodyRadiusAU: number,
  occluderOffsetAU: THREE.Vector3,
  shadowAxis: THREE.Vector3,
  out: THREE.Vector3,
): THREE.Vector3 {
  shadowAxisSurfacePoint(occluderOffsetAU, shadowAxis, bodyRadiusAU, out);
  return out.normalize().multiplyScalar(bodyRadiusAU + surfaceAltitudeAU(bodyRadiusAU));
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
 * Entry FOV fits the subject. Companion entries keep the realistic-sky
 * default unless the target's disc would overflow it — then widen so the
 * disc fills ~60% of the frame (Jupiter from Io is ∅19.5° and must not
 * overflow a 10° view). Event entries frame the event instead: ~8× the
 * target disc, so a solar eclipse opens on a Sun that reads as a disc
 * (∅0.4° → 3.2° FOV ≈ 1/8 of the frame), clamped to the zoom range.
 */
export function entryFovDeg(
  targetAngularDiameterDeg: number,
  context: SurfaceEntryContext = 'companion',
): number {
  if (context === 'event') {
    return clampSurfaceFovDeg(targetAngularDiameterDeg * 8);
  }
  return Math.min(
    SURFACE_FOV_MAX_DEG,
    Math.max(SURFACE_FOV_DEFAULT_DEG, targetAngularDiameterDeg * 1.7),
  );
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

export type SurfaceMarkerKind = 'brackets' | 'reticle';

/**
 * Which target marker the HUD draws — the shared resolvability decision
 * (one helper so the panel, HUD, and scene never disagree about "too
 * small"). Hysteresis keeps the swap from flickering as the disc breathes
 * around the threshold.
 */
export function resolveMarkerKind(
  discPx: number,
  current: SurfaceMarkerKind,
): SurfaceMarkerKind {
  if (discPx >= MARKER_BRACKETS_MIN_PX) return 'brackets';
  if (discPx <= MARKER_RETICLE_MAX_PX) return 'reticle';
  return current;
}

/** Shadow-guide resolvability thresholds (px, with hysteresis): cone
 * silhouette edges and footprint rings activate once their projected size
 * clears the ON bound and hold until it drops below the OFF bound. Sits
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

/** Display formatting for an apparent diameter — never prints "0.00°": below
 * the two-decimal floor it reads "<0.01" (an honest speck, not a zero). */
export function formatDiscDeg(deg: number): string {
  if (deg < 0.005) return '<0.01';
  return deg >= 1 ? deg.toFixed(1) : deg.toFixed(2);
}
