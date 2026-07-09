/**
 * Pure math for cruise approaches and arrivals near bodies — moons, planets,
 * and the Sun. The planet throttle knows nothing smaller than a system —
 * deep inside one it still allows the in-system speed setting (~25,000 km/s
 * by default), which crosses a body standoff in about a second. These
 * functions give every body its own approach dynamics (and moons their
 * arrival pose); PlanetariumMode feeds live positions and applies the
 * results.
 */
import * as THREE from 'three';
import { KM_PER_AU } from '../astronomy/constants';
import { DEG2RAD } from '../shared/math/angles';

/** Approach dynamics: distance to the moon's surface e-folds every 1/K
 *  seconds, so every moon from Ganymede to Deimos gets the same subjective
 *  ease-in regardless of scale. 4 s reads as a brisk glide — the collision
 *  sweep, not this cap, is what prevents impact. */
export const MOON_APPROACH_K_PER_S = 1 / 4;

/** Planets (and the Sun) launch at the moons' proven glide. A separate dial
 *  so a gentler planet feel is a one-line change if flying QA asks for it —
 *  a planet approach spans minutes where a moon's spans seconds. */
export const PLANET_APPROACH_K_PER_S = MOON_APPROACH_K_PER_S;

/** The Sun has no collision shell, so the governed glide is the only brake
 *  before the corona; govern against an effective surface above the
 *  photosphere so the glide asymptotes short of it. */
export const SUN_APPROACH_SURFACE_RADII = 1.2;

/** The governor never caps below ~2 km/s — you can always creep closer; the
 *  collision bubble, not the governor, is what holds you off the mesh. */
export const BODY_APPROACH_V_MIN_AU_S = 2 / KM_PER_AU;

/**
 * Proximity speed cap near one body: closing speed is limited to
 * K × (distance to the rendered surface), floored at vMin. The cap applies
 * only while the heading closes on the body — `cap = base / g`, with g a
 * smoothstep of the approach cosine over [0, 0.3] — so it fades out
 * continuously as the nose swings past the limb: a flyby ends by sailing
 * on, never by wading out of molasses. Receding or grazing flight is free.
 */
export function governedSpeedCap(
  surfaceDistAU: number,
  cosApproach: number,
  kPerS: number,
  vMinAUPerS: number,
): number {
  if (cosApproach <= 0) return Infinity;
  const t = Math.min(cosApproach / 0.3, 1);
  const g = t * t * (3 - 2 * t);
  if (g <= 0) return Infinity;
  const base = Math.max(surfaceDistAU * kPerS, vMinAUPerS);
  return base / g;
}

/** After a flyby the applied cap relaxes by e per this many seconds, so
 *  leaving reads as a pull-away — full in-system speed returns over ~4–5 s
 *  from a deep flyby — instead of a one-frame snap to thousands of km/s. */
export const BODY_CAP_RELEASE_EFOLD_S = 1;

/** Above this the ramp stops mattering against any real speed setting
 *  (~25c); promote to Infinity so no stale finite cap lingers as state. */
const CAP_FULLY_RELEASED_AU_S = 0.05;

/**
 * Time-eased speed cap: `geomCap` is the instantaneous geometric cap from
 * `governedSpeedCap`, `prevCap` the cap applied last frame. Tightening (and
 * first contact) applies instantly — decelerating late is the safety half.
 * Loosening grows exponentially from the previous cap, so however the
 * geometric cap releases (nose past the limb, receding, distance opening),
 * speed returns as a ramp, never a step.
 */
export function rampedSpeedCap(
  geomCap: number,
  prevCap: number,
  dtS: number,
  efoldS: number,
): number {
  if (geomCap <= prevCap) return geomCap;
  const grown = prevCap * Math.exp(dtS / efoldS);
  if (!Number.isFinite(geomCap) && grown >= CAP_FULLY_RELEASED_AU_S) return Infinity;
  return Math.min(geomCap, grown);
}

/** The override auto-clears only after the cap has read unbound continuously
 *  this long with an escape hatch active — one grazing frame at the engage
 *  boundary (gyro jitter, the cos-0.3 band) can't clear a latched override. */
export const BODY_CAP_CLEAR_HOLD_S = 0.75;

/** Engaged means the geometric cap sits meaningfully below the commanded
 *  speed — a hair under, not equal, so cap≈commanded float noise at the
 *  engage boundary doesn't flap the latch. */
const CAP_BIND_FRACTION = 0.999;

/**
 * Per-frame governor state. `candidate` is the eased cap the governor would
 * apply — integrated EVERY frame, bypassed or not, so easing state never
 * resets to Infinity mid-escape and a bypass that ends mid-flyby resumes the
 * ramp where it truly is. `applied` is what the ship actually gets (Infinity
 * while a bypass hatch is open). `engaged` is the latch: the INSTANTANEOUS
 * geometric cap binds against the commanded (uncapped, throttle-dialed)
 * speed — never the applied speed, which already contains the cap and reads
 * 0 parked. `unboundS` is how long the latch has read unbound while a bypass
 * was active — the override auto-clear waits out BODY_CAP_CLEAR_HOLD_S on it.
 */
export interface BodyCapState {
  candidate: number;
  applied: number;
  engaged: boolean;
  unboundS: number;
}

/** Fresh state for flight discontinuities (jump, takeoff, restore,
 *  activation): no cap, no latch, no partial clear-hold carried across. */
export function initialBodyCapState(): BodyCapState {
  return { candidate: Infinity, applied: Infinity, engaged: false, unboundS: 0 };
}

/**
 * Advance the governor state one frame. `geomCap` is this frame's
 * instantaneous cap (min over all governed bodies), `commandedAUPerS` the
 * speed the dialed throttle would fly uncapped, `bypass` whether an escape
 * hatch (throttle override, system slowdown off) is open.
 */
export function advanceBodyCap(
  prev: BodyCapState,
  geomCap: number,
  commandedAUPerS: number,
  bypass: boolean,
  dtS: number,
): BodyCapState {
  const candidate = rampedSpeedCap(geomCap, prev.candidate, dtS, BODY_CAP_RELEASE_EFOLD_S);
  const engaged = geomCap < commandedAUPerS * CAP_BIND_FRACTION;
  return {
    candidate,
    applied: bypass ? Infinity : candidate,
    engaged,
    // The hold only means something while a hatch is open and the cap is
    // unbound; any other frame resets it, so a partial hold can't survive
    // re-engagement or complete long after the hatch opened.
    unboundS: bypass && !engaged ? prev.unboundS + dtS : 0,
  };
}

/** Arrival standoff targets this apparent disc diameter from the CAMERA
 *  (which trails the ship): a clear disc with sky around it, then the
 *  governed drift-in grows it toward closest approach — the approach is
 *  the show, not the parking spot. */
export const MOON_ARRIVAL_APPARENT_DIAMETER_DEG = 5;

/** Flyby impact parameter in rendered radii: full thrust straight ahead
 *  passes the limb at this clearance, and the moon rides about a third
 *  off-center instead of bullseye. */
export const MOON_ARRIVAL_IMPACT_RADII = 2.5;

/** Ceiling on how far the aim may swing off the moon: tiny meshes parked
 *  under their separation caps would otherwise push the disc out of frame. */
export const MOON_ARRIVAL_MAX_OFFAXIS_DEG = 12;

/** Legacy floor (~7,500 km) so the smallest arrivals never park
 *  uncomfortably tight; unchanged from the original standoff. */
export const MOON_ARRIVAL_STANDOFF_FLOOR_AU = 5e-5;

/** Standoff never exceeds this fraction of the live moon–parent separation,
 *  so the parent can't dominate the view; for the closest moons (Phobos,
 *  Cordelia) this is what actually binds. Unchanged from the original. */
export const MOON_ARRIVAL_SEPARATION_CAP = 0.45;

export interface MoonArrivalInputs {
  /** Moon and parent world positions (AU), and their live separation. */
  moonPos: THREE.Vector3;
  parentPos: THREE.Vector3;
  orbitR: number;
  /** Mesh radius: catalog radius under the 5%-of-parent render floor. */
  renderedR: number;
  /** Hard planet collision radius (no rings). */
  parentCollision: number;
  /** Ring-aware arrival clearance around the parent. */
  parentClearance: number;
  /** Chase-camera trail distance behind the ship. */
  camDist: number;
  /** Ship hull clearance (SHIP_CLEARANCE_AU). */
  shipClearance: number;
}

export interface MoonArrivalPose {
  position: THREE.Vector3;
  /** Heading target: offset from the moon's center so forward flight is a
   *  flyby past the limb, never a collision course. */
  aimPoint: THREE.Vector3;
}

/** Collision bubble around a moon mesh: hull clearance saturates at one
 *  rendered radius so tiny-moon standoffs stay outside their own bubbles. */
export function moonCollisionRadius(renderedR: number, shipClearance: number): number {
  return renderedR + Math.min(shipClearance, renderedR);
}

/** True when the forward ray from `origin` through `through` passes within
 *  `radius` of `point` ahead of the ship (behind the ship can't be hit). */
function rayPassesNear(
  origin: THREE.Vector3,
  through: THREE.Vector3,
  point: THREE.Vector3,
  radius: number,
): boolean {
  const dir = through.clone().sub(origin).normalize();
  const toPoint = point.clone().sub(origin);
  const along = toPoint.dot(dir);
  if (along <= 0) return false;
  return toPoint.addScaledVector(dir, -along).length() < radius;
}

/**
 * Arrival pose for a moon-precise jump: where the ship appears, and where
 * it points.
 *
 * Standoff: the mesh subtends MOON_ARRIVAL_APPARENT_DIAMETER_DEG from the
 * camera (camDist behind the ship), clamped by the legacy floor, the
 * collision bubble, and the separation cap. Position: sun side preferred so
 * the lit face greets you — unless that parks inside the parent's clearance
 * bubble or with the parent occluding the sightline (an inner moon near
 * superior conjunction); fallback is outward along the parent→moon radial,
 * which always clears the parent, its rings, and the line of sight.
 *
 * Aim: offset by an impact parameter so full thrust sweeps past the limb.
 * The clearance floor outranks composition — without it the floored small
 * moons are left ~11 km of miss margin. Side selection selects the perp
 * toward the parent so the moon slides to the opposite third and the two
 * flank the frame; the forward ray is checked against the parent's HARD
 * collision sphere only (ring moons orbit entirely inside the ring-aware
 * clearance, where no aim could pass such a test and none needs to — the
 * ship has no ring collisions and skimming them is the best view in the
 * app). The flip is best-effort: on the outward-radial fallback the parent
 * sits dead ahead past the moon, where BOTH sides of a close flyby can
 * point inside it (Pan) — the flyby still misses the moon, and the planet
 * pushback is the backstop for what lies beyond.
 */
export function moonArrivalPose(inp: MoonArrivalInputs): MoonArrivalPose {
  const { moonPos, parentPos, orbitR, renderedR } = inp;
  const collisionR = moonCollisionRadius(renderedR, inp.shipClearance);

  const half = (MOON_ARRIVAL_APPARENT_DIAMETER_DEG / 2) * DEG2RAD;
  const dist = Math.min(
    Math.max(
      renderedR / Math.sin(half) - inp.camDist,
      MOON_ARRIVAL_STANDOFF_FLOOR_AU,
      collisionR * 1.5,
    ),
    orbitR * MOON_ARRIVAL_SEPARATION_CAP,
  );

  const sunDir = moonPos.clone().multiplyScalar(-1).normalize();
  let position = moonPos.clone().addScaledVector(sunDir, dist);
  const occluded =
    new THREE.Line3(position, moonPos)
      .closestPointToPoint(parentPos, true, new THREE.Vector3())
      .distanceTo(parentPos) < inp.parentCollision;
  if (position.distanceTo(parentPos) < inp.parentClearance || occluded) {
    const outward =
      orbitR > 1e-9
        ? moonPos.clone().sub(parentPos).divideScalar(orbitR)
        : new THREE.Vector3(1, 0, 0);
    position = moonPos.clone().addScaledVector(outward, dist);
  }

  const b = Math.min(
    Math.max(renderedR * MOON_ARRIVAL_IMPACT_RADII, collisionR * 1.15),
    dist * Math.sin(MOON_ARRIVAL_MAX_OFFAXIS_DEG * DEG2RAD),
  );

  const viewDir = moonPos.clone().sub(position).normalize();
  const toParent = parentPos.clone().sub(position);
  let perp = toParent.clone().addScaledVector(viewDir, -toParent.dot(viewDir));
  if (perp.lengthSq() < 1e-18) perp = new THREE.Vector3().crossVectors(viewDir, new THREE.Vector3(0, 1, 0));
  if (perp.lengthSq() < 1e-18) perp = new THREE.Vector3().crossVectors(viewDir, new THREE.Vector3(1, 0, 0));
  perp.normalize();

  let aimPoint = moonPos.clone().addScaledVector(perp, b);
  if (rayPassesNear(position, aimPoint, parentPos, inp.parentCollision * 1.1)) {
    perp.multiplyScalar(-1);
    aimPoint = moonPos.clone().addScaledVector(perp, b);
  }
  return { position, aimPoint };
}
