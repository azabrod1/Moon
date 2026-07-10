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

/** Farthest solid point of any ship profile from the group origin. The
 *  default hull's nozzle exit sits at 1.82 authored units × 1.8 units per
 *  reference radius × 0.5 group scale = 1.638 reference radii; 2.2 leaves
 *  ~34% headroom for the probe-profile hulls (own geometry, root scale
 *  1.18). Used as the near-plane ceiling on the camera-to-ship term, as the
 *  floor under CAMERA_BODY_MARGIN_AU, and as the base of the wheel-zoom
 *  floor — solid geometry must never cross the near plane or the camera. */
export const SHIP_HULL_MAX_EXTENT_AU = SHIP_REFERENCE_RADIUS_AU * 2.2;

/** OrbitControls wheel-zoom floor in cruise. The legacy floor sat inside the
 *  hull's aft extent (a quirk this rig initially preserved by ratio), but at
 *  close-approach scale that is user-visible: full wheel-in put the camera
 *  through the fin envelope — plates filled the frame as bare squares, then
 *  the whole ship vanished to backfaces. Floor at 1.5× the hull extent
 *  instead: the ship still fills ~35° of frame, and solid geometry stays in
 *  front of the camera. */
export const CRUISE_CONTROLS_MIN_DISTANCE_AU = SHIP_HULL_MAX_EXTENT_AU * 1.5;

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

/** One governed body as the camera-safety pass sees it: center position (in
 *  the camera's own frame) and the body's outermost rendered surface radius
 *  (envelope for planets, rendered mesh for moons) — margin NOT included. */
export interface CameraBodyShell {
  x: number;
  y: number;
  z: number;
  surfaceRadiusAU: number;
}

/**
 * Escape every padded body shell in ONE deterministic step. Returns null
 * when the camera is clear of all of them (the common case). Otherwise:
 * take the ray from the deepest-penetrating body's center through the
 * camera (+X at dead center) and walk out to the FARTHEST ray–sphere exit
 * over every shell the ray passes through — a point at the last exit is
 * outside each of them. Sequential per-body pushes have no such guarantee:
 * co-orbital moons rendered at the 5%-of-parent floor genuinely overlap
 * (Pan–Atlas–Prometheus conjunct for real), and alternating pushes between
 * overlapping spheres can oscillate.
 *
 * `count` bounds the scan so callers can reuse a pooled array.
 */
export function escapeCameraPenetrations(
  cam: { x: number; y: number; z: number },
  shells: readonly CameraBodyShell[],
  count: number,
  marginAU: number,
): { x: number; y: number; z: number } | null {
  // Deepest penetration decides the escape direction.
  let deepest = 0;
  let originX = 0;
  let originY = 0;
  let originZ = 0;
  for (let i = 0; i < count; i++) {
    const s = shells[i];
    const dx = cam.x - s.x;
    const dy = cam.y - s.y;
    const dz = cam.z - s.z;
    const pen = s.surfaceRadiusAU + marginAU - Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (pen > deepest) {
      deepest = pen;
      originX = s.x;
      originY = s.y;
      originZ = s.z;
    }
  }
  if (deepest <= 0) return null;

  let rx = cam.x - originX;
  let ry = cam.y - originY;
  let rz = cam.z - originZ;
  const rLen = Math.sqrt(rx * rx + ry * ry + rz * rz);
  if (rLen < 1e-12) {
    rx = 1;
    ry = 0;
    rz = 0;
  } else {
    rx /= rLen;
    ry /= rLen;
    rz /= rLen;
  }

  // Farthest exit along the ray across ALL shells it passes through. Shells
  // entirely behind the camera yield a negative exit and drop out; shells
  // containing the camera always yield a positive one.
  let tExit = 0;
  for (let i = 0; i < count; i++) {
    const s = shells[i];
    const cx = s.x - cam.x;
    const cy = s.y - cam.y;
    const cz = s.z - cam.z;
    const along = cx * rx + cy * ry + cz * rz;
    const missSq = cx * cx + cy * cy + cz * cz - along * along;
    const shellR = s.surfaceRadiusAU + marginAU;
    const rSq = shellR * shellR;
    if (missSq >= rSq) continue;
    const t = along + Math.sqrt(rSq - missSq);
    if (t > tExit) tExit = t;
  }
  if (tExit <= 0) return null;
  return { x: cam.x + rx * tExit, y: cam.y + ry * tExit, z: cam.z + rz * tExit };
}

/** Distance from the camera to the nearest body SURFACE (no margin) over the
 *  pooled shell set — the live quantity the dynamic near plane rides on. */
export function nearestShellSurfaceDistanceAU(
  cam: { x: number; y: number; z: number },
  shells: readonly CameraBodyShell[],
  count: number,
): number {
  let min = Infinity;
  for (let i = 0; i < count; i++) {
    const s = shells[i];
    const dx = cam.x - s.x;
    const dy = cam.y - s.y;
    const dz = cam.z - s.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) - s.surfaceRadiusAU;
    if (d < min) min = d;
  }
  return min;
}
