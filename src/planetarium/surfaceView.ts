/**
 * Pure target-selection + vantage math for the Observatory's surface view:
 * given where the player is landed and which shadow event (if any) they
 * jumped to, decide what the narrow-FOV camera should look at and where on
 * the landed body's surface it should stand. No scene or DOM access — the
 * PlanetariumMode adapter gathers fresh scene positions from the renderer's
 * own seams and passes plain vectors in. Unit-tested in surfaceView.test.ts.
 */
import * as THREE from 'three';
import { shadowAxisSurfacePoint } from '../astronomy/shadows';
import { RAD2DEG } from '../shared/math/angles';

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
 * Default vantage: hover above the sub-target point — the surface point
 * directly beneath the look target — so the target culminates overhead and
 * the landed body's limb stays out of frame. Body-centered scene AU.
 */
export function computeSubTargetVantage(
  bodyRadiusAU: number,
  dirToTarget: THREE.Vector3,
  out: THREE.Vector3,
): THREE.Vector3 {
  out.copy(dirToTarget);
  if (out.lengthSq() < 1e-30) out.set(1, 0, 0);
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

export const SURFACE_FOV_MIN_DEG = 1.5;
export const SURFACE_FOV_MAX_DEG = 45;
export const SURFACE_FOV_DEFAULT_DEG = 10;

export function clampSurfaceFovDeg(fovDeg: number): number {
  return Math.min(SURFACE_FOV_MAX_DEG, Math.max(SURFACE_FOV_MIN_DEG, fovDeg));
}

/**
 * Entry FOV fits the target: the realistic-sky default unless the target's
 * disc would overflow it — then widen so the disc fills ~60% of the frame
 * (Jupiter from Io is ∅19.5° and must not overflow a 10° view).
 */
export function entryFovDeg(targetAngularDiameterDeg: number): number {
  return Math.min(
    SURFACE_FOV_MAX_DEG,
    Math.max(SURFACE_FOV_DEFAULT_DEG, targetAngularDiameterDeg * 1.7),
  );
}

/** Apparent angular diameter (degrees) of a sphere of radius r seen from distance d. */
export function angularDiameterDeg(radiusAU: number, distanceAU: number): number {
  if (distanceAU <= radiusAU) return 180;
  return 2 * Math.asin(radiusAU / distanceAU) * RAD2DEG;
}
