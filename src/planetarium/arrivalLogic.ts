/**
 * Pure math for cruise approaches and arrivals near bodies — moons, planets,
 * and the Sun. The planet throttle knows nothing smaller than a system —
 * deep inside one it still allows the in-system speed setting (~25,000 km/s
 * by default), which crosses a body standoff in about a second. These
 * functions give every body its own approach AND departure dynamics — both
 * tied to distance, so arrivals glide and departures pull away instead of
 * detonating off a time ramp — (and moons their arrival pose);
 * PlanetariumMode feeds live positions and applies the results.
 */
import * as THREE from 'three';
import { KM_PER_AU } from '../astronomy/constants';
import { DEG2RAD } from '../shared/math/angles';
import { SHIP_CLEARANCE_AU } from './cruiseView';

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

/** Departure near zone: for its first moments a leave is capped by the SAME
 *  K × height glide as an approach — right beside a body, leaving is as
 *  unhurried as arriving — but with this head start added to the height, so
 *  the shell itself reads as a visible creep (~0.05 shell radii per second)
 *  instead of the near-freeze the approach floor would pin a parked
 *  nose-out ship at.
 *
 *  The leave law's datum is the COLLISION SHELL (rendered radius + hull
 *  clearance) — the surface the resolvers actually park the ship on — and
 *  the head start and knee scale on that shell radius. Rendered radii would
 *  break the smallest bodies: the fixed clearance dwarfs a moonlet's mesh,
 *  so a ship parked at one would measure several "radii" up, start past the
 *  valve knee, and detonate off the shell in a fraction of a second. */
export const LEAVE_HEADSTART_RADII = 0.2;

/** Knee of the departure valve, measured on the head-started shell height.
 *  Inside it the leave cap is the plain glide — the really-slow zone,
 *  crossed in ~3 s of flight. Past it the cap opens as the SQUARE of the
 *  ratio (a cubic law overall), so it outruns any dialed speed within
 *  ~1/(2K) ≈ 2 s more: a departure is genuinely governed only for its first
 *  few seconds — slow beside the body, picking up through the knee, and
 *  entirely free once the ship has clearly left. Everything is in shell
 *  radii, so a moonlet departure and a Jupiter departure share one
 *  subjective timeline. */
export const LEAVE_VALVE_KNEE_RADII = 0.38;

/**
 * Proximity speed cap near one body. Closing, speed is limited to
 * K × (distance to the rendered surface), floored at vMin — the glide.
 * Receding, it is limited to K × (height + head start), squared open past
 * the valve knee — the leave law: as slow as an arrival right beside the
 * body, then releasing completely within a few seconds of flight. (A
 * pure-time release reads as nothing-nothing-BANG; a flat distance law
 * holds a committed departure against empty sky for tens of seconds.)
 *
 * The two laws blend HARMONICALLY over the approach-cosine smoothstep band
 * [0, 0.3]: `1 / (w/vIn + (1−w)/vOut)`. As vOut → ∞ this reduces exactly to
 * the historical `vIn / w` band fade, so the proven inbound behavior is the
 * special case — an arithmetic blend here would hand a near-tangent closing
 * course a large share of an opened leave valve and grind it into the
 * resolver.
 *
 * `surfaceDistAU` is the RAW `dist − surfaceRadius`, negative while a swept
 * endpoint sits momentarily inside the surface. Both laws clamp: at or
 * inside the collision shell the leave cap holds the shell's own creep
 * (floored at vMin, like the approach) and the approach cap its floor —
 * neither ever goes negative, and swinging the nose out is never slower
 * than swinging it in.
 */
export function governedSpeedCap(
  surfaceDistAU: number,
  surfaceRadiusAU: number,
  cosApproach: number,
  kPerS: number,
  vMinAUPerS: number,
): number {
  const shellRadiusAU = surfaceRadiusAU + SHIP_CLEARANCE_AU;
  const liftAU =
    Math.max(surfaceDistAU - SHIP_CLEARANCE_AU, 0) + LEAVE_HEADSTART_RADII * shellRadiusAU;
  const kneeAU = LEAVE_VALVE_KNEE_RADII * shellRadiusAU;
  const valve = liftAU > kneeAU ? (liftAU / kneeAU) ** 2 : 1;
  const vOut = Math.max(kPerS * liftAU * valve, vMinAUPerS);
  const t = THREE.MathUtils.clamp(cosApproach / 0.3, 0, 1);
  const w = t * t * (3 - 2 * t);
  if (w <= 0) return vOut;
  const vIn = Math.max(Math.max(surfaceDistAU, 0) * kPerS, vMinAUPerS);
  if (w >= 1) return vIn;
  return 1 / (w / vIn + (1 - w) / vOut);
}

/** Pace of the cap's loosening transition (a target-residual ease, so the
 *  normalized progress is body-independent: 50% in ~0.24 s, 95% in ~1.05 s
 *  whether the target is a moonlet's leave law or Jupiter's). */
export const CAP_TRANSITION_TAU_S = 0.35;

/**
 * Time-eased speed cap: `geomCap` is the instantaneous geometric cap from
 * `governedSpeedCap` (min over bodies), `prevCap` the cap applied last
 * frame. Tightening (and first contact) applies instantly — decelerating
 * late is the safety half. Loosening eases the RESIDUAL toward the target
 * (`prev + (geom − prev) × (1 − e^(−dt/τ))`): body-scale independent —
 * a multiplicative e-fold from a shell pin needs ~2.4 s beside Jupiter with
 * 1.5 s of it invisible — and exactly frame-rate independent for a given
 * elapsed time. Once the transition catches the leave law, the cap simply
 * tracks it — distance-tied — until the valve outruns the dialed speed and
 * the departure runs free.
 */
export function rampedSpeedCap(
  geomCap: number,
  prevCap: number,
  dtS: number,
  tauS: number,
): number {
  if (geomCap <= prevCap) return geomCap;
  // A bodiless frame (pre-load) has nothing to govern — and Infinity must
  // not reach the residual arithmetic, where a zero dt would make it NaN.
  if (!Number.isFinite(geomCap)) return geomCap;
  return prevCap + (geomCap - prevCap) * (1 - Math.exp(-dtS / tauS));
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
 * transition where it truly is. `applied` is what the ship actually gets
 * (Infinity while a bypass hatch is open). `engaged` is the latch: the
 * INSTANTANEOUS geometric cap binds against the commanded (uncapped,
 * throttle-dialed) speed — never the applied speed, which already contains
 * the cap and reads 0 parked. With the finite leave law, `engaged` stays
 * true through a departure until the law crosses the commanded speed — for
 * a governed departure a few seconds of flight, for a full-override sprint
 * a dozen radii of distance — so the auto-clear completes once the ship has
 * genuinely left rather than moments past the limb, and a ship parked
 * nose-away beside a body stays latched until it actually leaves (the pill
 * tap always clears by hand). `unboundS` is how long the latch has read
 * unbound while a bypass was active — the auto-clear waits out
 * BODY_CAP_CLEAR_HOLD_S on it.
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
  return {
    candidate: Infinity,
    applied: Infinity,
    engaged: false,
    unboundS: 0,
  };
}

/**
 * Advance the governor state one frame. `geomCap` is this frame's
 * instantaneous cap (min over all governed bodies); `commandedAUPerS` is the
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
  const candidate = rampedSpeedCap(geomCap, prev.candidate, dtS, CAP_TRANSITION_TAU_S);
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

/**
 * How strongly a moon teleport's camera should keep looking at the moon.
 * The flyby path still aims past the limb; only the camera is decoupled from
 * that heading so a close, off-axis sphere does not anamorphically stretch.
 * Track fully through closest approach, then ease back to the ship between
 * one and two arrival-camera distances on the receding leg.
 */
export function moonArrivalCameraLookWeight(
  cameraDistanceAU: number,
  arrivalCameraDistanceAU: number,
  receding: boolean,
): number {
  if (!receding) return 1;
  if (!(arrivalCameraDistanceAU > 0)) return 0;
  const t = THREE.MathUtils.clamp(
    (cameraDistanceAU - arrivalCameraDistanceAU) / arrivalCameraDistanceAU,
    0,
    1,
  );
  const eased = t * t * (3 - 2 * t);
  return 1 - eased;
}

/** Seconds over which manual steering hands the arrival look back to the
 *  ship. On the touch flight zone a stationary first tap is already full
 *  steering input, and cancelling the look in one frame swung the camera
 *  from the moon to the ship as an instant snap — up to the whole off-axis
 *  allowance — on the first touch after a teleport. */
export const MOON_ARRIVAL_RELEASE_S = 0.35;

/**
 * Fade multiplier for a released arrival look: 1 at the moment steering
 * begins, easing to 0 once MOON_ARRIVAL_RELEASE_S has elapsed. Multiplies
 * moonArrivalCameraLookWeight, so a release during the receding leg only
 * ever shortens the ease that was already running.
 */
export function moonArrivalReleaseFade(releaseElapsedS: number): number {
  if (!(releaseElapsedS > 0)) return 1;
  const t = THREE.MathUtils.clamp(releaseElapsedS / MOON_ARRIVAL_RELEASE_S, 0, 1);
  return 1 - t * t * (3 - 2 * t);
}

/** Engage band for the flythrough tracking look, in fractions of the arrival
 *  camera distance. The look is EXACTLY zero at the arrival standoff and
 *  through the first stretch of the glide — a teleport's first input must
 *  find zero deflection (an always-on look put ~20° between the arrival and
 *  settled poses, and every first input paid it as a visible adjust) — and
 *  reaches full tracking well before the near-miss geometry carries the
 *  moon out of the fixed chase frame (~3 rendered radii on close passes). */
export const MOON_ARRIVAL_ENGAGE_START_RATIO = 0.5;
export const MOON_ARRIVAL_ENGAGE_FULL_RATIO = 0.2;

/**
 * How far a hands-off flythrough has developed, 0→1: zero at (and anywhere
 * beyond) MOON_ARRIVAL_ENGAGE_START_RATIO × the arrival camera distance,
 * easing to 1 at MOON_ARRIVAL_ENGAGE_FULL_RATIO ×. Multiplies
 * moonArrivalCameraLookWeight, so the tracking shot fades in as the flyby
 * closes and back out as it recedes — and a look released by input while
 * still un-engaged carries no deflection at all.
 */
export function moonArrivalTrackEngage(
  cameraDistanceAU: number,
  arrivalCameraDistanceAU: number,
): number {
  if (!(arrivalCameraDistanceAU > 0)) return 0;
  return 1 - THREE.MathUtils.smoothstep(
    cameraDistanceAU,
    MOON_ARRIVAL_ENGAGE_FULL_RATIO * arrivalCameraDistanceAU,
    MOON_ARRIVAL_ENGAGE_START_RATIO * arrivalCameraDistanceAU,
  );
}

/** Standoff floor (~500 km) so the smallest arrivals never park
 *  uncomfortably tight. The old ~7,500 km value was tuned when the smallest
 *  rendered moon was a ~3,000 km marble; against curve-rendered specks it
 *  parked every jump staring at a sub-degree dot. 500 km keeps ≥ ~2.5° of
 *  disc on the smallest meshes (~20 km) and goes inert above ~40 km
 *  rendered, where the apparent-size term takes over. */
export const MOON_ARRIVAL_STANDOFF_FLOOR_AU = 3.3e-6;

/** Planet-jump standoff floor (~3,000 km). Inert for the current catalog —
 *  every planet's 8-radii arm exceeds it (Pluto's is 6.4e-5 AU) — it only
 *  guards a degenerate zero-radius body. The old 0.001 AU floor bound for
 *  ALL terrestrials and Pluto, parking Mercury at a ~2° postcard; historic
 *  journeys still pass that legacy value so authored milestone scenes keep
 *  their ship positions. */
export const PLANET_ARRIVAL_STANDOFF_FLOOR_AU = 2e-5;

/** Standoff never exceeds this fraction of the live moon–parent separation,
 *  so the parent can't dominate the view; for the closest moons (Phobos,
 *  Cordelia) this is what actually binds. Unchanged from the original. */
export const MOON_ARRIVAL_SEPARATION_CAP = 0.45;

export interface MoonArrivalInputs {
  /** Moon and parent world positions (AU), and their live separation. */
  moonPos: THREE.Vector3;
  parentPos: THREE.Vector3;
  orbitR: number;
  /** Mesh radius as drawn: true radius, or the moonRenderSize curve's
   *  inflated size for moons below the render anchor. */
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

/** Collision bubble around a moon mesh: rendered radius plus the full hull
 *  clearance pad. The pad is deliberately NOT reduced for small meshes — the
 *  curve renders the smallest moons well under the hull's own extent, and a
 *  shrunken pad would let the hull visibly enter the mesh before pushback.
 *  Standoffs stay outside the bubble by construction: the pose floors the
 *  distance at 1.5× this radius, and the tightest catalog separation cap is
 *  far larger (pinned by the catalog sweep). */
export function moonCollisionRadius(renderedR: number, shipClearance: number): number {
  return renderedR + shipClearance;
}

/** Unit outward pushback direction for a swept shell contact. */
export interface SweepContact {
  ox: number;
  oy: number;
  oz: number;
}

/**
 * Sweep the frame segment p0→p1 against a sphere: the shared collision test
 * for moons AND planets. Checking only the endpoint tunnels — at override
 * speeds a frame step (~4,800 km at 60 fps, ~30,000 km on a 100 ms hitch)
 * out-strides a terrestrial planet's shell diameter, and it tunnels exactly
 * at moon scale even at governed speeds. Returns the unit outward direction
 * from the sphere center at the segment's closest approach, or null when the
 * swept path stays clear (the common case — no allocation there).
 *
 * A dead-center pass has no radial direction; push back along the incoming
 * segment, and a zero-length segment dead on the center falls back to +X.
 */
export function sweepSegmentSphere(
  p0x: number, p0y: number, p0z: number,
  p1x: number, p1y: number, p1z: number,
  cx: number, cy: number, cz: number,
  radius: number,
): SweepContact | null {
  const dx = p1x - p0x;
  const dy = p1y - p0y;
  const dz = p1z - p0z;
  const tox = cx - p0x;
  const toy = cy - p0y;
  const toz = cz - p0z;
  const segLenSq = dx * dx + dy * dy + dz * dz;
  const t = segLenSq > 0
    ? Math.min(1, Math.max(0, (tox * dx + toy * dy + toz * dz) / segLenSq))
    : 0;
  let ox = p0x + dx * t - cx;
  let oy = p0y + dy * t - cy;
  let oz = p0z + dz * t - cz;
  let d = Math.sqrt(ox * ox + oy * oy + oz * oz);
  if (d >= radius) return null;
  if (d < 1e-9) {
    ox = -dx;
    oy = -dy;
    oz = -dz;
    d = Math.sqrt(ox * ox + oy * oy + oz * oz);
    if (d < 1e-9) {
      ox = 1;
      oy = 0;
      oz = 0;
      d = 1;
    }
  }
  return { ox: ox / d, oy: oy / d, oz: oz / d };
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
 * Standoff distance from the moon's center: the mesh subtends
 * MOON_ARRIVAL_APPARENT_DIAMETER_DEG from the camera (camDist behind the
 * ship), floored by the legacy standoff and the collision bubble (×1.5) and
 * capped at a fraction of the moon–parent separation. `moonArrivalPose` places
 * the ship exactly this far out, so |pose.position − moonPos| == this value by
 * construction; the autopilot glide rests the cruise here too.
 */
export function moonArrivalStandoffAU(inp: MoonArrivalInputs): number {
  const collisionR = moonCollisionRadius(inp.renderedR, inp.shipClearance);
  const half = (MOON_ARRIVAL_APPARENT_DIAMETER_DEG / 2) * DEG2RAD;
  return Math.min(
    Math.max(
      inp.renderedR / Math.sin(half) - inp.camDist,
      MOON_ARRIVAL_STANDOFF_FLOOR_AU,
      collisionR * 1.5,
    ),
    inp.orbitR * MOON_ARRIVAL_SEPARATION_CAP,
  );
}

/** Autopilot closing-speed cap: the same K×distance glide the governor uses,
 *  but measured PAST the arrival standoff instead of the surface, so the
 *  cruise eases to rest at the postcard distance rather than grinding into the
 *  collision shell. Continuous, and exactly zero at or inside the standoff. */
export function autopilotGlideCap(distToMoonCenterAU: number, standoffAU: number): number {
  return MOON_APPROACH_K_PER_S * Math.max(distToMoonCenterAU - standoffAU, 0);
}

/** How strongly the autopilot heading swings from the moon's center toward the
 *  flyby aim point as the ship closes: 0 while more than three standoffs out (a
 *  straight run in), ramping smoothly to 1 at the standoff so the parked
 *  heading is pre-aimed past the limb. Monotone in closing distance. */
export function autopilotAimBlend(distToMoonCenterAU: number, standoffAU: number): number {
  if (!(standoffAU > 0)) return 0;
  return 1 - THREE.MathUtils.smoothstep(distToMoonCenterAU, standoffAU, 3 * standoffAU);
}

/** Arrival test for an autopilot moon glide: the ship has eased to rest at the
 *  standoff. The small margin latches despite the K×distance ease-in never
 *  quite reaching zero closing distance. */
export function autopilotArrived(distToMoonCenterAU: number, standoffAU: number): boolean {
  return distToMoonCenterAU <= 1.05 * standoffAU;
}

/**
 * Arrival pose for a moon-precise jump: where the ship appears, and where
 * it points.
 *
 * Standoff (moonArrivalStandoffAU): the mesh subtends
 * MOON_ARRIVAL_APPARENT_DIAMETER_DEG from the camera (camDist behind the
 * ship), clamped by the legacy floor, the collision bubble, and the separation
 * cap. Position: sun side preferred so
 * the lit face greets you — unless that parks inside the parent's clearance
 * bubble or with the parent occluding the sightline (an inner moon near
 * superior conjunction); fallback is outward along the parent→moon radial,
 * which always clears the parent, its rings, and the line of sight.
 *
 * Aim: offset by an impact parameter so full thrust sweeps past the limb.
 * The clearance floor outranks composition — without it the smallest
 * curve-rendered moons keep almost no miss margin. Side selection selects the perp
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
  const dist = moonArrivalStandoffAU(inp);

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

  // Required perpendicular miss, converted to an aim offset: a ray aimed b
  // off-center passes the center at b·cos(offAxis), so hitting an exact miss
  // of m needs b = m·d/√(d²−m²). Always real: the standoff keeps d well
  // above m (d ≥ 1.5·collisionR ≥ 1.3·m).
  const missM = collisionR * 1.15;
  const clearB = (missM * dist) / Math.sqrt(dist * dist - missM * missM);
  // Clearance outranks BOTH composition terms: at close parks (the standoff
  // floor on the smallest meshes) the swing ceiling can fall under the
  // required miss, and safety wins — the aim may swing a few degrees past
  // MOON_ARRIVAL_MAX_OFFAXIS_DEG there (≤ ~14° in the catalog, pinned by
  // the ladder test).
  const b = Math.max(
    Math.min(
      renderedR * MOON_ARRIVAL_IMPACT_RADII,
      dist * Math.sin(MOON_ARRIVAL_MAX_OFFAXIS_DEG * DEG2RAD),
    ),
    clearB,
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

/** Standoff for a Sun teleport, in photosphere radii: 8 puts a ~14° disc in
 *  front of the chase camera — the visual weight a planet jump's 8-radii
 *  standoff gives — while sitting far outside the 1.2-radius governor shell,
 *  so the arrival glides instead of binding. */
export const SUN_ARRIVAL_RADII = 8;

/**
 * Pose for a Sun teleport: park on the player's OWN radial at the standoff,
 * looking at the heliocenter (the Sun is the world frame's origin). Keeping
 * the radial means the jump never swings the player around the Sun — the sky
 * they left stays behind them. A player exactly at the origin (unreachable in
 * practice) falls back to a fixed direction instead of normalizing zero.
 */
export function sunArrivalPose(
  playerPos: THREE.Vector3,
  sunRadiusAU: number,
): { position: THREE.Vector3; lookTarget: THREE.Vector3 } {
  const dist = sunRadiusAU * SUN_ARRIVAL_RADII;
  const dir = playerPos.lengthSq() > 1e-12
    ? playerPos.clone().normalize()
    : new THREE.Vector3(-1, 0.25, 0).normalize();
  return { position: dir.multiplyScalar(dist), lookTarget: new THREE.Vector3(0, 0, 0) };
}
