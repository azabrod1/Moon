/**
 * The cruise rig: every distance that defines how the chase view sits around
 * the ship, derived from ONE scaled base so the whole rig shrinks together.
 *
 * The ship is authored against a reference radius (historically the Moon's).
 * SHIP_RIG_SCALE shrinks that reference — and with it the hull, the chase
 * distance, the clearance pads, the camera margins, and the zoom floor — so
 * the camera can get 32× closer to a body before the pads stop it, while the
 * ship's ON-SCREEN size never changes (it rides CRUISE_CAM_DIST_AU, which
 * scales identically). World scale, body radii, speeds, and the moon render
 * floors are deliberately untouched.
 *
 * Why 1/32: close approach is asset-bound, not engine-bound. A 4K equirect
 * map reads crisp to a ~49° disc and acceptable to ~98° on a desktop
 * viewport; 1/32 parks the un-floored hero bodies at/just past that edge
 * (Moon ~101°, Mars ~120°, Earth ~128°). The final push to the shell is
 * deliberate over-zoom past the asset floor — the proximity governor makes
 * it a slow glide, and pulling back restores full sharpness. Scaling deeper
 * buys nothing until a detail-synthesis shader exists (every extra degree of
 * disc lands past even 4K's texel budget).
 */
import { KM_PER_AU } from '../astronomy/constants';

export const SHIP_RIG_SCALE = 1 / 32;

/** The scaled base every other rig quantity derives from. The ship model is
 *  authored against this radius (PlayerShip hands it to the model builders),
 *  so hull size and rig pads can never drift apart. */
export const SHIP_REFERENCE_RADIUS_AU = (1_737.4 / KM_PER_AU) * SHIP_RIG_SCALE;

/** Standoff pad between a body's rendered surface and the parked ship. */
export const SHIP_CLEARANCE_AU = SHIP_REFERENCE_RADIUS_AU * 1.5;

/** Chase-camera trail distance behind the ship (also the moon-arrival
 *  standoff's camera correction — the apparent size the user sees is
 *  measured from back here, not from the ship). Kept as the legacy literal
 *  × scale, NOT a "clean" multiple of the reference radius: it is 8.094
 *  reference radii, and rounding would visibly change the ship's on-screen
 *  size, which this refactor must not. */
export const CRUISE_CAM_DIST_AU = 0.000094 * SHIP_RIG_SCALE;

/** Conservative disc radius for ship occlusion (label culling). Default hull
 *  is ~3 reference radii long with the 0.5× group scale applied →
 *  half-length ≈ 0.75 reference radii. */
export const SHIP_OCCLUDER_RADIUS_AU = SHIP_REFERENCE_RADIUS_AU * 0.75;

/** OrbitControls wheel-zoom floor in cruise. Scales with the rig so full
 *  wheel-in frames the ship the same as it always has (including the
 *  longstanding quirk that the floor sits inside the hull's aft extent —
 *  preserved, not fixed: the floor/hull ratio is identical by construction). */
export const CRUISE_CONTROLS_MIN_DISTANCE_AU = 0.00001 * SHIP_RIG_SCALE;

/** Farthest solid point of any ship profile from the group origin. The
 *  default hull's nozzle exit sits at 1.82 authored units × 1.8 units per
 *  reference radius × 0.5 group scale = 1.638 reference radii; 2.2 leaves
 *  ~34% headroom for the probe-profile hulls (own geometry, root scale
 *  1.18). Used as the near-plane ceiling on the camera-to-ship term and as
 *  the floor under CAMERA_BODY_MARGIN_AU — solid geometry must never cross
 *  the near plane. */
export const SHIP_HULL_MAX_EXTENT_AU = SHIP_REFERENCE_RADIUS_AU * 2.2;

/** Pad between a body's shell and the closest the CAMERA may sit. Must
 *  exceed SHIP_HULL_MAX_EXTENT_AU: during a bounce the ship parks at
 *  SHIP_CLEARANCE_AU and the camera can stack on the same radial — the gap
 *  between the two shells is what keeps the hull out of the camera.
 *  (Pin-tested: MARGIN > HULL_EXTENT.) */
export const CAMERA_BODY_MARGIN_AU = SHIP_REFERENCE_RADIUS_AU * 2.5;

/** Dynamic-near clamp floor (~3 km). Depth-precision guard: the steady-state
 *  near never reaches this; only ring-plane crossings and clamp transients do,
 *  and never for more than moments. */
export const CRUISE_NEAR_MIN_AU = 2e-8;

/** Dynamic-near clamp ceiling (~135 km): safely below the camera-to-hull
 *  minimum (CRUISE_CAM_DIST_AU − SHIP_HULL_MAX_EXTENT_AU ≈ 320 km × the 0.3
 *  fraction), and just under the legacy static 1e-6 AU near so far-field
 *  depth behavior is unchanged. */
export const CRUISE_NEAR_MAX_AU = 9e-7;

/** Fraction of the tightest live distance the near plane sits at. */
const CRUISE_NEAR_FRACTION = 0.3;

/** A planet's outermost rendered surface: the solid ball at its live render
 *  scale, or the atmosphere shell where one exists (Jupiter/Saturn's shells
 *  are 1.5% of R — over 1,000 km — and run at FULL alpha on close approach,
 *  so ship and camera must park outside them, not inside). */
export function planetEnvelopeRadiusAU(
  radiusAU: number,
  renderedScale: number,
  atmosphereScale?: number,
): number {
  return radiusAU * Math.max(renderedScale, 1, atmosphereScale ?? 1);
}

/**
 * Per-frame cruise near plane: a fraction of the tightest of three live
 * ceilings — camera-to-nearest-body-surface (envelope radii), camera-to-ship
 * minus the hull's solid extent, and camera-to-nearest-ring-annulus (rings
 * have no collision, so only the near plane keeps a skim from clipping a
 * hole through them). Ceilings that don't apply pass Infinity.
 */
export function cruiseCameraNearAU(
  camToNearestSurfaceAU: number,
  camToShipAU: number,
  camToNearestRingAU: number = Infinity,
): number {
  const tightest = Math.min(
    camToNearestSurfaceAU,
    camToShipAU - SHIP_HULL_MAX_EXTENT_AU,
    camToNearestRingAU,
  );
  const near = CRUISE_NEAR_FRACTION * tightest;
  return Math.min(CRUISE_NEAR_MAX_AU, Math.max(CRUISE_NEAR_MIN_AU, near));
}

/**
 * Distance from a point to a flat ring annulus, in the ring's own frame:
 * `radial` is the point's distance from the ring axis, `height` its distance
 * along the axis from the ring plane. Zero inside the annulus itself.
 */
export function ringAnnulusDistanceAU(
  radial: number,
  height: number,
  innerR: number,
  outerR: number,
): number {
  const radialExcess = Math.max(innerR - radial, radial - outerR, 0);
  return Math.hypot(radialExcess, Math.abs(height));
}

/**
 * Push a camera position radially out of a body's padded shell. Returns the
 * corrected position, or null when the camera is already clear (the common
 * case — callers skip all work on null). A camera exactly at the body
 * center pushes out along +X: any fixed direction beats NaN, and the caller
 * re-aims at its target afterward.
 */
export function resolveCameraPenetration(
  cam: { x: number; y: number; z: number },
  center: { x: number; y: number; z: number },
  shellRadiusAU: number,
): { x: number; y: number; z: number } | null {
  const minDist = shellRadiusAU + CAMERA_BODY_MARGIN_AU;
  const dx = cam.x - center.x;
  const dy = cam.y - center.y;
  const dz = cam.z - center.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist >= minDist) return null;
  if (dist < 1e-12) {
    return { x: center.x + minDist, y: center.y, z: center.z };
  }
  const s = minDist / dist;
  return { x: center.x + dx * s, y: center.y + dy * s, z: center.z + dz * s };
}
