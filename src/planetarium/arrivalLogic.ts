/**
 * Pure math for cruise approaches and arrivals near bodies — moons, planets,
 * and the Sun. The planet throttle knows nothing smaller than a system —
 * deep inside one it still allows the in-system speed setting (~25,000 km/s
 * by default), which crosses a body standoff in about a second. These
 * functions give every body its own approach AND departure dynamics — both
 * tied to distance, so arrivals glide and departures pull away instead of
 * detonating off a time ramp — and every teleportable body its arrival
 * pose: one shared drive-by for planets and moons (authored past-the-limb
 * pass, lane-scored drop so no bystander body ever owns the arrival's
 * speed cap, one-shot aim lead so the pass geometry survives the target's
 * own orbital motion), a centered park for moonlet-scale bodies, and the
 * legacy "postcard" framing kept verbatim for authored scenes (tutorial,
 * historic journeys, the dev screenshot bridge). PlanetariumMode feeds
 * live positions and applies the results.
 */
import * as THREE from 'three';
import { KM_PER_AU } from '../astronomy/constants';
import { DEG2RAD } from '../shared/math/angles';
import { SHIP_CLEARANCE_AU } from './cruiseView';
import { FLIGHT_UP_SCENE } from './flightFrame';

/** Approach dynamics, every body class: distance to the surface e-folds every
 *  1/K seconds, so Ganymede, Deimos, and Jupiter all get the same subjective
 *  ease-in regardless of scale — 4 s reads as a brisk glide. The collision
 *  sweep, not this cap, is what prevents impact. (A per-class dial stays a
 *  one-line change if flying QA ever wants a gentler planet feel.) */
export const BODY_APPROACH_K_PER_S = 1 / 4;

/** The Sun has no collision shell, so the governed glide is the only brake
 *  before the corona; govern against an effective surface above the
 *  photosphere so the glide asymptotes short of it. */
export const SUN_APPROACH_SURFACE_RADII = 1.2;

/** The governor never caps below ~2 km/s — you can always creep closer; the
 *  collision bubble, not the governor, is what holds you off the mesh. */
export const BODY_APPROACH_V_MIN_AU_S = 2 / KM_PER_AU;

/** Departure near zone: for its first moments a departure is capped by the
 *  SAME K × height glide as an approach — right beside a body, leaving is as
 *  unhurried as arriving — but with this head start added to the height, so
 *  the shell itself reads as a visible creep (~0.05 shell radii per second)
 *  instead of the near-freeze the approach floor would pin a parked
 *  nose-out ship at.
 *
 *  The departure law's datum is the COLLISION SHELL (rendered radius + hull
 *  clearance) — the surface the resolvers actually park the ship on — and
 *  the head start and knee scale on that shell radius. Rendered radii would
 *  break the smallest bodies: the fixed clearance dwarfs a moonlet's mesh,
 *  so a ship parked at one would measure several "radii" up, start past the
 *  knee, and detonate off the shell in a fraction of a second. */
export const DEPARTURE_HEADSTART_RADII = 0.2;

/** Knee of the departure law, measured on the head-started shell height.
 *  Inside it the departure cap is the plain glide — the really-slow zone,
 *  crossed in ~3 s of flight. Past it the cap opens as the SQUARE of the
 *  ratio (a cubic law overall), so it outruns any dialed speed within
 *  ~1/(2K) ≈ 2 s more: a departure is genuinely governed only for its first
 *  few seconds — slow beside the body, picking up through the knee, and
 *  entirely free once the ship has clearly left. Everything is in shell
 *  radii, so a moonlet departure and a Jupiter departure share one
 *  subjective timeline. */
export const DEPARTURE_KNEE_RADII = 0.38;

/**
 * Proximity speed cap near one body. Closing, speed is limited to
 * K × (distance to the rendered surface), floored at vMin — the glide.
 * Receding, it is limited to K × (height + head start), opening as the
 * square past the knee — the departure law: as slow as an arrival right
 * beside the body, then free within a few seconds of flight. (A pure-time
 * opening reads as nothing-nothing-BANG; a flat distance law holds a
 * committed departure against empty sky for tens of seconds.)
 *
 * The two laws blend HARMONICALLY over the approach-cosine smoothstep band
 * [0, 0.3]: `1 / (w/vIn + (1−w)/vOut)`. As vOut → ∞ this reduces exactly to
 * the historical `vIn / w` band fade, so the proven inbound behavior is the
 * special case — an arithmetic blend here would hand a near-tangent closing
 * course a large share of an opened departure cap and grind it into the
 * resolver.
 *
 * `surfaceDistAU` is the RAW `dist − surfaceRadius`, negative while a swept
 * endpoint sits momentarily inside the surface. Both laws clamp: at or
 * inside the collision shell the departure cap holds the shell's own creep
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
  const paddedHeightAU =
    Math.max(surfaceDistAU - SHIP_CLEARANCE_AU, 0) + DEPARTURE_HEADSTART_RADII * shellRadiusAU;
  const kneeAU = DEPARTURE_KNEE_RADII * shellRadiusAU;
  const opening = paddedHeightAU > kneeAU ? (paddedHeightAU / kneeAU) ** 2 : 1;
  const vOut = Math.max(kPerS * paddedHeightAU * opening, vMinAUPerS);
  const t = THREE.MathUtils.clamp(cosApproach / 0.3, 0, 1);
  const w = t * t * (3 - 2 * t);
  if (w <= 0) return vOut;
  const vIn = Math.max(Math.max(surfaceDistAU, 0) * kPerS, vMinAUPerS);
  if (w >= 1) return vIn;
  return 1 / (w / vIn + (1 - w) / vOut);
}

/** Pace of the cap's loosening transition (a target-residual ease, so the
 *  normalized progress is body-independent: 50% in ~0.24 s, 95% in ~1.05 s
 *  whether the target is a moonlet's departure law or Jupiter's). */
export const CAP_TRANSITION_TAU_S = 0.35;

/**
 * Time-eased speed cap: `geomCap` is the instantaneous geometric cap from
 * `governedSpeedCap` (min over bodies), `prevCap` the cap applied last
 * frame. Tightening (and first contact) applies instantly — decelerating
 * late is the safety half. Loosening eases the RESIDUAL toward the target
 * (`prev + (geom − prev) × (1 − e^(−dt/τ))`): body-scale independent —
 * a multiplicative e-fold from a shell pin needs ~2.4 s beside Jupiter with
 * 1.5 s of it invisible — and exactly frame-rate independent for a given
 * elapsed time. Once the transition catches the departure law, the cap simply
 * tracks it — distance-tied — until it outruns the dialed speed and
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
 * the cap and reads 0 parked. With the finite departure law, `engaged` stays
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
 *  passes the moon's center at this distance — under a radius of sky above
 *  the limb. The clearance floor below still outranks this on the smallest
 *  meshes. Tighter reads closer but kills the pass: the proximity governor
 *  meters speed by height above the collision shell, and a perigee that
 *  falls inside the departure knee turns the flyby into a hover
 *  beside the body (1.35 parked outright; 1.6 hung ~12 s at perigee and
 *  crept out with no sling). 1.8 is the closest pass that keeps its pace. */
export const ARRIVAL_IMPACT_RADII = 1.8;

/** Ceiling on how far the aim may swing off the moon: tiny meshes parked
 *  under their separation caps would otherwise push the disc out of frame. */
export const ARRIVAL_MAX_OFFAXIS_DEG = 12;

/** The flyby needs its lateral show to dwarf the chase rig: below this
 *  many camera-boom lengths of impact parameter, the whole pass — perigee,
 *  abeam slide, sling — happens INSIDE the camera's own trail distance, and
 *  reads as teleporting on top of a rock while the view crawls. Those moons
 *  arrive planet-style instead: aimed dead at the body, the governed glide
 *  as the show. Splits the catalog at the named-moon line (every classical
 *  moon plus Charon flies; the moonlet swarm parks). */
export const FLYBY_MIN_IMPACT_CAM_DISTS = 2;

/**
 * How strongly a moon teleport's camera should keep looking at the moon.
 * The flyby path still aims past the limb; only the camera is decoupled from
 * that heading so a close, off-axis sphere does not anamorphically stretch.
 * Track fully through closest approach, then ease back to the ship between
 * one and two arrival-camera distances on the receding leg.
 */
export function arrivalCameraLookWeight(
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
export const ARRIVAL_LOOK_RELEASE_S = 0.35;

/**
 * Fade multiplier for a released arrival look: 1 at the moment steering
 * begins, easing to 0 once ARRIVAL_LOOK_RELEASE_S has elapsed. Multiplies
 * arrivalCameraLookWeight, so a release during the receding leg only
 * ever shortens the ease that was already running.
 */
export function arrivalLookReleaseFade(releaseElapsedS: number): number {
  if (!(releaseElapsedS > 0)) return 1;
  const t = THREE.MathUtils.clamp(releaseElapsedS / ARRIVAL_LOOK_RELEASE_S, 0, 1);
  return 1 - t * t * (3 - 2 * t);
}

/** Engage band for the flyby tracking look, in fractions of the arrival
 *  camera distance. The look is EXACTLY zero at the arrival standoff and
 *  through the first stretch of the glide — a teleport's first input must
 *  find zero deflection (an always-on look put ~20° between the arrival and
 *  settled poses, and every first input paid it as a visible adjust) — and
 *  reaches full tracking well before the near-miss geometry carries the
 *  moon out of the fixed chase frame (~3 rendered radii on close passes). */
export const ARRIVAL_ENGAGE_START_RATIO = 0.5;
export const ARRIVAL_ENGAGE_FULL_RATIO = 0.2;

/**
 * How far a hands-off flyby has developed, 0→1: zero at (and anywhere
 * beyond) ARRIVAL_ENGAGE_START_RATIO × the arrival camera distance,
 * easing to 1 at ARRIVAL_ENGAGE_FULL_RATIO ×. Multiplies
 * arrivalCameraLookWeight, so the tracking shot fades in as the flyby
 * closes and back out as it recedes — and a look released by input while
 * still un-engaged carries no deflection at all.
 */
export function arrivalTrackEngage(
  cameraDistanceAU: number,
  arrivalCameraDistanceAU: number,
): number {
  if (!(arrivalCameraDistanceAU > 0)) return 0;
  return 1 - THREE.MathUtils.smoothstep(
    cameraDistanceAU,
    ARRIVAL_ENGAGE_FULL_RATIO * arrivalCameraDistanceAU,
    ARRIVAL_ENGAGE_START_RATIO * arrivalCameraDistanceAU,
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

/**
 * The legacy centered planet framing — the postcard: drop on the sunward
 * radial at 8 radii (floored by the collision envelope + legacy floor),
 * aimed dead at the center. User teleports fly the authored flyby instead;
 * this pose is kept verbatim for the callers whose compositions are authored
 * around it — historic-journey milestones, the tutorial's freeze-frames, and
 * the dev screenshot bridge — so those scenes stay byte-stable. The
 * multiplier scales the ENTIRE floored arm (historic milestones rely on
 * that, including sub-1 multipliers against their legacy 0.001 floor).
 */
export function planetPostcardPose(
  planetPos: THREE.Vector3,
  radiusAU: number,
  collisionRadiusAU: number,
  distanceMultiplier: number,
  floorAU: number,
): { position: THREE.Vector3; lookTarget: THREE.Vector3 } {
  const viewDist = Math.max(
    radiusAU * 8,
    collisionRadiusAU + radiusAU * 2,
    floorAU,
  ) * distanceMultiplier;
  const offsetDir = planetPos.clone().multiplyScalar(-1);
  if (offsetDir.lengthSq() < 1e-8) {
    offsetDir.set(-1, 0.25, 0);
  }
  offsetDir.normalize();
  return {
    position: planetPos.clone().addScaledVector(offsetDir, viewDist),
    lookTarget: planetPos.clone(),
  };
}

/** A body that could contest the approach lane: a satellite of the target
 *  planet (or a sibling of the target moon), at its jump-time analytic
 *  position. Velocity is heliocentric AU per SIMULATED second — the lane
 *  scorer propagates it at the live clock rate. `governedRadiusAU` is the
 *  radius the governor will see: the RENDERED size, not the physical one. */
export interface LaneBody {
  pos: THREE.Vector3;
  velAUPerS: THREE.Vector3;
  governedRadiusAU: number;
}

export interface ArrivalInputs {
  /** Target and parent world positions (AU, heliocentric), and their live
   *  separation. For a planet target the parent is the Sun at the origin
   *  and `orbitR` its heliocentric distance. */
  targetPos: THREE.Vector3;
  parentPos: THREE.Vector3;
  orbitR: number;
  /** Mesh radius as drawn: true radius, or the moonRenderSize curve's
   *  inflated size for moons below the render anchor. */
  renderedR: number;
  /** Hard parent collision radius (no rings). Unused for planet targets. */
  parentCollision: number;
  /** Ring-aware arrival clearance around the parent. Unused for planets. */
  parentClearance: number;
  /** Chase-camera trail distance behind the ship. */
  camDist: number;
  /** Ship hull clearance (SHIP_CLEARANCE_AU). */
  shipClearance: number;
  /** Body class. Default 'moon' — every shipped call site. 'planet' swaps
   *  the standoff law (pass-geometry minimum, no apparent-size term, no
   *  separation cap) and stages the drop through the lane-scored candidate
   *  fan with the flyover/ring composition. */
  kind?: 'moon' | 'planet';
  /** Target's heliocentric velocity, AU per SIMULATED second — the one-shot
   *  aim lead. Omit (or zero) for the un-led legacy aim. */
  targetVelAUPerS?: THREE.Vector3;
  /** Live clock rate (simulated seconds per real second). Default 1. */
  timeRate?: number;
  /** Dialed in-system speed cap, AU per REAL second — paces the lane
   *  simulation and the lead-time estimate where the governor's law exceeds
   *  it (the giants' coast regime). Default Infinity (pure glide). */
  commandedAUPerS?: number;
  /** Ring geometry of the TARGET (ringed planets): unit plane normal in
   *  J2000 and the annulus bounds. The pass must not cross the sheet. */
  ringNormal?: THREE.Vector3;
  ringInnerAU?: number;
  ringOuterAU?: number;
  /** Bodies that could contest the approach lane (planet: its catalog
   *  moons; moon: its siblings). Omit to skip lane scoring. */
  laneBodies?: LaneBody[];
}

export interface ArrivalPose {
  position: THREE.Vector3;
  /** Heading target. Flyby arrivals offset it from the moon's center so
   *  forward flight is a flyby past the limb; direct arrivals aim at the
   *  center itself and let the governed glide park the ship. */
  aimPoint: THREE.Vector3;
  /** True when this arrival stages the near-miss flyby (and its camera
   *  tracking); false for the head-on park at moonlet-scale bodies. */
  flyby: boolean;
  /** The authored impact parameter (AU) behind a flyby aim — the probe
   *  battery asserts measured perigees against this. Absent on parks. */
  impactParameterAU?: number;
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

/** Flyby-vs-park classification, the shared gate: a pass whose lateral show
 *  would fit inside a couple of camera booms reads as teleporting on top of
 *  a rock, so those bodies park instead. Every planet clears this (Pluto by
 *  2.4×); the park class is genuinely moonlet-scale (rendered ≲ 490 km). */
export function isFlybyClass(renderedR: number, camDist: number): boolean {
  return renderedR * ARRIVAL_IMPACT_RADII >= camDist * FLYBY_MIN_IMPACT_CAM_DISTS;
}

/**
 * Standoff distance from the target's center.
 *
 * Moons: the mesh subtends MOON_ARRIVAL_APPARENT_DIAMETER_DEG from the
 * camera (camDist behind the ship), floored by the legacy standoff and the
 * collision bubble (×1.5) and capped at a fraction of the moon–parent
 * separation. Planets: the pass-geometry minimum (~8.8 radii — the
 * structural successor to the legacy 8) with the same bubble floor and the
 * legacy planet floor; no apparent-size term (planets deliberately arrive
 * looming ~13°) and no separation cap.
 *
 * Flyby-class bodies of BOTH kinds also stand at least the pass-geometry
 * minimum out, so the off-axis ceiling never shaves the authored impact
 * parameter into the measured hover band. For every catalog moon this term
 * is inert (the apparent-size law stands farther out — pinned by the sweep
 * test); park-class standoffs skip it so those poses stay byte-stable.
 *
 * `arrivalPose` places the ship exactly this far out, so
 * |pose.position − targetPos| == this value by construction; the moon
 * autopilot glide rests the cruise here too.
 */
export function arrivalStandoffAU(inp: ArrivalInputs): number {
  const collisionR = moonCollisionRadius(inp.renderedR, inp.shipClearance);
  const passMin = isFlybyClass(inp.renderedR, inp.camDist)
    ? passGeometryMinAU(inp.renderedR)
    : 0;
  if (inp.kind === 'planet') {
    return Math.max(
      passMin,
      PLANET_ARRIVAL_STANDOFF_FLOOR_AU,
      collisionR * 1.5,
    );
  }
  const half = (MOON_ARRIVAL_APPARENT_DIAMETER_DEG / 2) * DEG2RAD;
  return Math.min(
    Math.max(
      inp.renderedR / Math.sin(half) - inp.camDist,
      MOON_ARRIVAL_STANDOFF_FLOOR_AU,
      collisionR * 1.5,
      passMin,
    ),
    inp.orbitR * MOON_ARRIVAL_SEPARATION_CAP,
  );
}

/** Autopilot closing-speed cap: the same K×distance glide the governor uses,
 *  but measured PAST the arrival standoff instead of the surface, so the
 *  cruise eases to rest at the postcard distance rather than grinding into the
 *  collision shell. Continuous, and exactly zero at or inside the standoff. */
export function autopilotGlideCap(distToMoonCenterAU: number, standoffAU: number): number {
  return BODY_APPROACH_K_PER_S * Math.max(distToMoonCenterAU - standoffAU, 0);
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
 * Standoff (arrivalStandoffAU): the mesh subtends
 * MOON_ARRIVAL_APPARENT_DIAMETER_DEG from the camera (camDist behind the
 * ship), clamped by the legacy floor, the collision bubble, and the separation
 * cap. Position: sun side preferred so
 * the lit face greets you — unless that parks inside the parent's clearance
 * bubble or with the parent occluding the sightline (an inner moon near
 * superior conjunction); fallback is outward along the parent→moon radial,
 * which always clears the parent, its rings, and the line of sight.
 *
 * Aim: for flyby-class moons, offset by an impact parameter so full
 * thrust sweeps past the limb; moonlets whose pass would fit inside the
 * camera boom aim dead at the body instead (planet-style, flyby:false).
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
export function arrivalPose(inp: ArrivalInputs): ArrivalPose {
  if (inp.kind === 'planet') return planetFlybyPose(inp);
  const { targetPos, parentPos, renderedR } = inp;
  const dist = arrivalStandoffAU(inp);

  const sunDir = targetPos.clone().multiplyScalar(-1).normalize();
  let position = targetPos.clone().addScaledVector(sunDir, dist);
  const occluded =
    new THREE.Line3(position, targetPos)
      .closestPointToPoint(parentPos, true, new THREE.Vector3())
      .distanceTo(parentPos) < inp.parentCollision;
  let sunSideLegal = true;
  if (position.distanceTo(parentPos) < inp.parentClearance || occluded) {
    sunSideLegal = false;
    position = outwardRadialPosition(inp, dist);
  }

  // Moonlets get the head-on arrival: aimed dead at the body, no flyby
  // offset — their pass would fit inside the camera boom (see the gate
  // constant). The glide clamps at the collision shell, so no miss geometry
  // is needed, and a parked pose needs no aim lead.
  if (!isFlybyClass(renderedR, inp.camDist)) {
    return { position, aimPoint: targetPos.clone(), flyby: false };
  }

  let aimPoint = moonFlybyAim(inp, position);
  // Lane check (sibling moons): if the sun-side lane reads another body's
  // brakes, the outward radial — the pose's own shipped fallback — may be
  // clean; take whichever lane is better only when the preferred side is
  // genuinely contested. Without lane data this is exactly the old pose.
  if (sunSideLegal && inp.laneBodies?.length) {
    const primaryLane = poseLaneScore(inp, position, aimPoint);
    if (primaryLane < LANE_CLEAN_RATIO) {
      const alt = outwardRadialPosition(inp, dist);
      const altAim = moonFlybyAim(inp, alt);
      if (poseLaneScore(inp, alt, altAim) > primaryLane) {
        position = alt;
        aimPoint = altAim;
      }
    }
  }
  return {
    position,
    aimPoint,
    flyby: true,
    impactParameterAU: impactParameterAU(inp, position.distanceTo(targetPos)),
  };
}

/** A lane reading at or above this keeps the arrival's pacing effectively
 *  the target's own law (a ≤5% dip is imperceptible; the measured Deimos
 *  incident read 0.24). */
export const LANE_CLEAN_RATIO = 0.95;

/** How far past closest approach (in target radii, on the surface datum)
 *  the lane simulation follows the receding leg — a body parked on the exit
 *  lane governs the departure. */
const LANE_EXIT_DIST_RADII = 4;

/** The ring sheet must never cross the frame closer than this many target
 *  radii of plane altitude at the pass — below it the flat texture reads
 *  edge-on through the camera. */
const RING_MIN_PASS_ALTITUDE_RADII = 0.5;

/** Candidate drop directions for a planet flyby, as rotations off the
 *  sunward radial: azimuth steps in the scene-horizontal basis, elevation
 *  steps out of it. Ordered by total off-sun angle at build time, so the
 *  first clean candidate is always the most lit-face-faithful one. */
const PLANET_DROP_AZ_DEG = [0, 20, -20, 40, -40, 60, -60];
const PLANET_DROP_EL_DEG = [0, 25, -25];

/** The wide net, tried only when every narrow candidate reads a dirty lane:
 *  a satellite system face-on to the sun line (Uranus near solstice) wraps
 *  ALL near-sun approaches in its moonlet shells — the lane must leave the
 *  disc axis entirely, and a half-lit arrival beats an arrival that reads
 *  another body's brakes. Measured: Miranda + Bianca held a sun-line Uranus
 *  approach to 0.54 of its own law with two handover surges. */
const PLANET_DROP_WIDE_AZ_DEG = [0, 30, -30, 60, -60, 90, -90, 120, -120, 150, -150, 180];
const PLANET_DROP_WIDE_EL_DEG = [40, -40, 60, -60];

function outwardRadialPosition(inp: ArrivalInputs, dist: number): THREE.Vector3 {
  const outward =
    inp.orbitR > 1e-9
      ? inp.targetPos.clone().sub(inp.parentPos).divideScalar(inp.orbitR)
      : new THREE.Vector3(1, 0, 0);
  return inp.targetPos.clone().addScaledVector(outward, dist);
}

/** The authored impact parameter as an aim offset from the (led) center:
 *  shared by both body classes. Clearance outranks BOTH composition terms:
 *  at close parks (the standoff floor on the smallest meshes) the swing
 *  ceiling can fall under the required miss, and safety wins — the aim may
 *  swing a few degrees past ARRIVAL_MAX_OFFAXIS_DEG there (≤ ~14° in the
 *  catalog, pinned by the ladder test). A ray aimed b off-center passes the
 *  center at b·cos(offAxis), so an exact miss of m needs
 *  b = m·d/√(d²−m²) — always real, the standoff keeps d well above m. */
function impactParameterAU(inp: ArrivalInputs, dist: number): number {
  const collisionR = moonCollisionRadius(inp.renderedR, inp.shipClearance);
  const missM = collisionR * 1.15;
  const clearB = (missM * dist) / Math.sqrt(dist * dist - missM * missM);
  return Math.max(
    Math.min(
      inp.renderedR * ARRIVAL_IMPACT_RADII,
      dist * Math.sin(ARRIVAL_MAX_OFFAXIS_DEG * DEG2RAD),
    ),
    clearB,
  );
}

/** Where the target's center will be at closest approach: the one-shot aim
 *  lead. Without it the pass geometry is drift-luck — Mercury moves ~10% of
 *  its own impact parameter during an approach (into the measured hover
 *  band), and Mars's orbital motion is what turned the old dead-center aim
 *  into a 130 km graze. Zero/absent velocity reproduces the un-led aim. */
function ledTargetPos(inp: ArrivalInputs, position: THREE.Vector3): THREE.Vector3 {
  const vel = inp.targetVelAUPerS;
  if (!vel || vel.lengthSq() === 0) return inp.targetPos.clone();
  const surfaceDist0 = position.distanceTo(inp.targetPos) - inp.renderedR;
  const passHeight = Math.max(
    (ARRIVAL_IMPACT_RADII - 1) * inp.renderedR,
    inp.renderedR * 0.25,
  );
  const passS = estimatePassDurationS(
    surfaceDist0, passHeight, inp.commandedAUPerS ?? Infinity,
  );
  return inp.targetPos.clone()
    .addScaledVector(vel, passS * (inp.timeRate ?? 1));
}

/** The moons' flyby aim for a given drop: perp toward the parent so the moon
 *  slides to the opposite third and the two flank the frame; the forward ray
 *  is checked against the parent's HARD collision sphere only (ring moons
 *  orbit entirely inside the ring-aware clearance, where no aim could pass
 *  such a test and none needs to — the ship has no ring collisions and
 *  skimming them is the best view in the app). The flip is best-effort: on
 *  the outward-radial fallback the parent sits dead ahead past the moon,
 *  where BOTH sides of a close flyby can point inside it (Pan) — the flyby
 *  still misses the moon, and the planet pushback is the backstop. */
function moonFlybyAim(inp: ArrivalInputs, position: THREE.Vector3): THREE.Vector3 {
  const { targetPos, parentPos } = inp;
  const dist = position.distanceTo(targetPos);
  const b = impactParameterAU(inp, dist);
  const led = ledTargetPos(inp, position);

  const viewDir = targetPos.clone().sub(position).normalize();
  const toParent = parentPos.clone().sub(position);
  let perp = toParent.clone().addScaledVector(viewDir, -toParent.dot(viewDir));
  if (perp.lengthSq() < 1e-18) perp = new THREE.Vector3().crossVectors(viewDir, new THREE.Vector3(0, 1, 0));
  if (perp.lengthSq() < 1e-18) perp = new THREE.Vector3().crossVectors(viewDir, new THREE.Vector3(1, 0, 0));
  perp.normalize();

  let aimPoint = led.clone().addScaledVector(perp, b);
  if (rayPassesNear(position, aimPoint, parentPos, inp.parentCollision * 1.1)) {
    perp.multiplyScalar(-1);
    aimPoint = led.clone().addScaledVector(perp, b);
  }
  return aimPoint;
}

function poseLaneScore(
  inp: ArrivalInputs,
  position: THREE.Vector3,
  aimPoint: THREE.Vector3,
): number {
  return scoreApproachLane(
    position,
    aimPoint,
    inp.targetPos,
    inp.renderedR,
    inp.laneBodies ?? [],
    inp.commandedAUPerS ?? Infinity,
    inp.timeRate ?? 1,
    LANE_EXIT_DIST_RADII * inp.renderedR,
  );
}

/** True when the aim ray keeps the authored clearance from the target's
 *  ring sheet: its closest approach to the center holds at least
 *  RING_MIN_PASS_ALTITUDE_RADII of plane altitude, and its ring-plane
 *  crossing (if any falls inside the pass corridor) lands outside the
 *  annulus — never a punch through the visible sheet. */
function rayClearsRingSheet(
  position: THREE.Vector3,
  aimPoint: THREE.Vector3,
  targetPos: THREE.Vector3,
  normal: THREE.Vector3,
  renderedR: number,
  ringInnerAU: number,
  ringOuterAU: number,
): boolean {
  const u = aimPoint.clone().sub(position);
  if (u.lengthSq() < 1e-24) return false;
  u.normalize();
  const rel = position.clone().sub(targetPos);

  // Plane altitude at the pass (closest approach to the center).
  const tClosest = -rel.dot(u);
  const atPass = rel.clone().addScaledVector(u, Math.max(tClosest, 0));
  if (Math.abs(atPass.dot(normal)) < RING_MIN_PASS_ALTITUDE_RADII * renderedR) {
    return false;
  }

  // Sheet crossing inside the pass corridor.
  const denom = u.dot(normal);
  if (Math.abs(denom) < 1e-12) {
    // Ray parallel to the sheet: clear only if it flies above/below it.
    return Math.abs(rel.dot(normal)) >= RING_MIN_PASS_ALTITUDE_RADII * renderedR;
  }
  const tCross = -rel.dot(normal) / denom;
  if (tCross < 0 || tCross > position.distanceTo(targetPos) * 2.5) return true;
  const crossRadius = rel.clone().addScaledVector(u, tCross).length();
  return crossRadius < ringInnerAU * 0.95 || crossRadius > ringOuterAU * 1.05;
}

/**
 * The planets' drive-by: candidate drop directions fan off the sunward
 * radial (lit face first), each staged with the flyover composition —
 * scene-up perp, so the terrain slides UNDER the frame, deterministic at
 * every epoch; ringed planets swing the perp to the ring-plane normal so a
 * hands-off pass looks down on the ring system opening below (sign chosen
 * once, toward scene-up). A candidate is rejected outright if its aim ray
 * would cross the ring sheet inside the annulus or fly it edge-on (Uranus
 * near solstice: the sun line approaches the ring pole, no over-the-rings
 * pass exists from there, and the fan's elevation steps rotate the approach
 * off the sun line instead). Among survivors the first lane-clean candidate
 * (score ≥ LANE_CLEAN_RATIO against the target's satellites) wins; if none
 * is clean, the best lane ships — and if the ring filter rejects the whole
 * fan (unreachable for the catalog's tilts), the plain sunward flyover
 * ships unfiltered rather than failing the jump.
 */
function planetFlybyPose(inp: ArrivalInputs): ArrivalPose {
  const { targetPos, renderedR } = inp;
  const dist = arrivalStandoffAU(inp);
  const sunDir = targetPos.clone().multiplyScalar(-1);
  if (sunDir.lengthSq() < 1e-8) sunDir.set(-1, 0.25, 0);
  sunDir.normalize();

  if (!isFlybyClass(renderedR, inp.camDist)) {
    return {
      position: targetPos.clone().addScaledVector(sunDir, dist),
      aimPoint: targetPos.clone(),
      flyby: false,
    };
  }

  // Orthobasis around the sun line for the candidate fan.
  const e1 = new THREE.Vector3().crossVectors(FLIGHT_UP_SCENE, sunDir);
  if (e1.lengthSq() < 1e-12) e1.crossVectors(new THREE.Vector3(1, 0, 0), sunDir);
  e1.normalize();
  const e2 = new THREE.Vector3().crossVectors(sunDir, e1).normalize();

  const buildCandidates = (azList: readonly number[], elList: readonly number[]) => {
    const out: { dir: THREE.Vector3; cost: number }[] = [];
    for (const azDeg of azList) {
      for (const elDeg of elList) {
        const az = azDeg * DEG2RAD;
        const el = elDeg * DEG2RAD;
        const dir = sunDir.clone().multiplyScalar(Math.cos(az) * Math.cos(el))
          .addScaledVector(e1, Math.sin(az) * Math.cos(el))
          .addScaledVector(e2, Math.sin(el))
          .normalize();
        out.push({
          dir,
          cost: Math.acos(THREE.MathUtils.clamp(dir.dot(sunDir), -1, 1)),
        });
      }
    }
    out.sort((a, c) => a.cost - c.cost);
    return out;
  };

  const withB = (position: THREE.Vector3, aimPoint: THREE.Vector3): ArrivalPose => ({
    position,
    aimPoint,
    flyby: true,
    impactParameterAU: impactParameterAU(inp, position.distanceTo(targetPos)),
  });

  let best: ArrivalPose | null = null;
  let bestLane = -1;
  // Fail-closed datum for the (unreachable-in-catalog) case where the ring
  // filter rejects the WHOLE fan: the least-bad candidate is the one whose
  // pass keeps the most ring-plane altitude — never the unvalidated
  // sunward ray, which can be exactly the annulus punch-through the filter
  // exists to forbid.
  let bestRejected: ArrivalPose | null = null;
  let bestRejectedAltitude = -1;
  const tryCandidates = (
    list: readonly { dir: THREE.Vector3; cost: number }[],
  ): ArrivalPose | null => {
    for (const cand of list) {
      const position = targetPos.clone().addScaledVector(cand.dir, dist);
      const aimPoint = planetFlybyAim(inp, position);
      if (inp.ringNormal && !rayClearsRingSheet(
        position, aimPoint, targetPos, inp.ringNormal, renderedR,
        inp.ringInnerAU ?? 0, inp.ringOuterAU ?? 0,
      )) {
        const altitude = ringPassAltitudeAU(position, aimPoint, targetPos, inp.ringNormal);
        if (altitude > bestRejectedAltitude) {
          bestRejectedAltitude = altitude;
          bestRejected = withB(position, aimPoint);
        }
        continue;
      }
      const lane = inp.laneBodies?.length
        ? poseLaneScore(inp, position, aimPoint)
        : 1;
      if (lane >= LANE_CLEAN_RATIO) return withB(position, aimPoint);
      if (lane > bestLane) {
        bestLane = lane;
        best = withB(position, aimPoint);
      }
    }
    return null;
  };

  const narrowClean = tryCandidates(buildCandidates(PLANET_DROP_AZ_DEG, PLANET_DROP_EL_DEG));
  if (narrowClean) return narrowClean;
  // Every lit-face-faithful lane is dirty: cast the wide net before settling
  // — leaving the satellite disc's axis costs arrival phase but removes the
  // handover dance outright wherever any clean corridor exists.
  const wideClean = tryCandidates(
    buildCandidates(PLANET_DROP_WIDE_AZ_DEG, PLANET_DROP_WIDE_EL_DEG),
  );
  if (wideClean) return wideClean;
  if (best) return best;
  if (bestRejected) return bestRejected;
  const position = targetPos.clone().addScaledVector(sunDir, dist);
  return withB(position, planetFlybyAim(inp, position));
}

/** Ring-plane altitude of the aim ray's closest approach to the center. */
function ringPassAltitudeAU(
  position: THREE.Vector3,
  aimPoint: THREE.Vector3,
  targetPos: THREE.Vector3,
  normal: THREE.Vector3,
): number {
  const u = aimPoint.clone().sub(position);
  if (u.lengthSq() < 1e-24) return 0;
  u.normalize();
  const rel = position.clone().sub(targetPos);
  const atPass = rel.clone().addScaledVector(u, Math.max(-rel.dot(u), 0));
  return Math.abs(atPass.dot(normal));
}

/** The flyover aim for one planet drop: scene-up perp (ringless) or the
 *  ring-normal perp, offset by the shared impact parameter from the led
 *  center. The perp's SIGN is chosen so its projection carries non-negative
 *  screen-up — aim above the target, planet slides UNDER the frame. Passing
 *  over vs under the ring plane is compositionally symmetric, but an aim
 *  BELOW the target parks the arrival with the planet clipped off the top
 *  of the frame for the whole first stretch (caught on a live Uranus
 *  epoch whose projected ring normal pointed down-screen). Deterministic:
 *  pure function of the jump geometry. */
function planetFlybyAim(inp: ArrivalInputs, position: THREE.Vector3): THREE.Vector3 {
  const viewDir = inp.targetPos.clone().sub(position).normalize();
  const dist = position.distanceTo(inp.targetPos);
  const b = impactParameterAU(inp, dist);
  const led = ledTargetPos(inp, position);

  const screenUp = FLIGHT_UP_SCENE.clone()
    .addScaledVector(viewDir, -FLIGHT_UP_SCENE.dot(viewDir));
  let perp: THREE.Vector3;
  if (inp.ringNormal) {
    perp = inp.ringNormal.clone()
      .addScaledVector(viewDir, -inp.ringNormal.dot(viewDir));
    if (perp.lengthSq() < 1e-12) perp = screenUp.clone();
    else if (perp.dot(screenUp) < 0) perp.multiplyScalar(-1);
  } else {
    perp = screenUp.clone();
  }
  if (perp.lengthSq() < 1e-12) {
    perp = new THREE.Vector3().crossVectors(viewDir, new THREE.Vector3(1, 0, 0));
  }
  perp.normalize();
  return led.addScaledVector(perp, b);
}

/** Headroom on the pass-geometry standoff so the aim's off-axis clamp never
 *  sits at float equality with the authored impact parameter. */
const PASS_GEOMETRY_HEADROOM = 1.02;

/** The distance at which the composition ceiling (ARRIVAL_MAX_OFFAXIS_DEG)
 *  still permits the full authored pass: closer, the aim clamp starts
 *  shaving the impact parameter toward the measured hover band. Planets
 *  derive their whole standoff from this (~8.8 radii — the successor to the
 *  legacy 8, now structural); for every catalog moon the apparent-size law
 *  already stands farther out, pinned by the sweep test. */
export function passGeometryMinAU(renderedR: number): number {
  return PASS_GEOMETRY_HEADROOM *
    (ARRIVAL_IMPACT_RADII * renderedR) / Math.sin(ARRIVAL_MAX_OFFAXIS_DEG * DEG2RAD);
}

/**
 * Estimated real seconds from the drop to closest approach: the governed
 * glide's e-fold from the arrival surface distance down to the pass height,
 * preceded by a dialed-speed coast where the far-field law exceeds the
 * commanded cap (the giants — their law at the standoff can be 5× the
 * dialed 25,000 km/s). Feeds the one-shot aim lead; a coarse estimate is
 * fine (the lead is a correction term, and mis-estimating it by 20% moves
 * the pass by a fraction of the drift it removes).
 */
export function estimatePassDurationS(
  surfaceDist0AU: number,
  passHeightAU: number,
  commandedAUPerS: number,
): number {
  const s0 = Math.max(surfaceDist0AU, 1e-12);
  const sPass = Math.min(Math.max(passHeightAU, 1e-12), s0);
  const k = BODY_APPROACH_K_PER_S;
  // Coast ends where the glide law undercuts the dial — but never short of
  // the pass height itself: a dial slower than K x passHeight coasts the
  // whole way in, and the glide term must not resurrect distance already
  // covered.
  const sCoastEnd = Number.isFinite(commandedAUPerS) && commandedAUPerS > 0
    ? Math.min(Math.max(commandedAUPerS / k, sPass), s0)
    : s0;
  const coastS = sCoastEnd < s0 ? (s0 - sCoastEnd) / commandedAUPerS : 0;
  const glideS = (1 / k) * Math.log(Math.max(sCoastEnd / sPass, 1));
  return coastS + glideS;
}

/**
 * Lane score for one candidate approach: how much of the target's own
 * arrival pacing survives the presence of other governed bodies. Simulates
 * the pass along the straight drop→aim ray under min(commanded, target law)
 * pacing, propagates every lane body linearly at the live clock rate, and
 * takes the worst ratio of
 *   min(commanded, targetCap, laneBodyCap) / min(commanded, targetCap)
 * over the whole run — 1.0 means the target's law is the min from frame one
 * (the arrival never reads another body's brakes), the measured Deimos
 * incident scores ~0.24. Within each step the closest approach to a moving
 * body is solved on the RELATIVE segment, so a fast inner moon can't slip
 * between samples. The run continues past closest approach to `exitDistAU`
 * on the receding leg (a body parked on the exit lane governs the departure
 * — the ship is closing on it even while it recedes from the target).
 */
export function scoreApproachLane(
  dropPos: THREE.Vector3,
  aimPoint: THREE.Vector3,
  targetPos: THREE.Vector3,
  targetSurfaceRadiusAU: number,
  laneBodies: readonly LaneBody[],
  commandedAUPerS: number,
  timeRate: number,
  exitDistAU: number,
): number {
  if (laneBodies.length === 0) return 1;
  const dir = aimPoint.clone().sub(dropPos);
  if (dir.lengthSq() < 1e-24) return 1;
  dir.normalize();
  // Zero is a real dial position, not "unlimited": only an absent/invalid
  // input (NaN, negative, Infinity) falls back to the pure glide.
  const commanded = Number.isFinite(commandedAUPerS) && commandedAUPerS >= 0
    ? Math.max(commandedAUPerS, 1e-12)
    : Infinity;
  const k = BODY_APPROACH_K_PER_S;

  // Horizon derived from the pass itself (estimate + exit + slack) so a
  // slow dial can't outlive a fixed cap; a run that would still truncate is
  // scored FAIL-CLOSED (a truncated simulation proves nothing clean).
  const DT_S = 0.2;
  const surfaceDist0 = dropPos.distanceTo(targetPos) - targetSurfaceRadiusAU;
  const estimateS = estimatePassDurationS(
    surfaceDist0, targetSurfaceRadiusAU * 0.5, commandedAUPerS,
  );
  const maxSteps = Math.min(
    Math.max(Math.ceil((estimateS * 2 + 60) / DT_S), 600),
    6000,
  );

  const ship = dropPos.clone();
  const prevShip = new THREE.Vector3();
  const toTarget = new THREE.Vector3();
  const bodyPos = new THREE.Vector3();
  const relStart = new THREE.Vector3();
  const relStep = new THREE.Vector3();
  let worst = 1;
  let receding = false;
  let elapsed = 0;
  let completed = false;

  for (let step = 0; step < maxSteps; step++) {
    toTarget.copy(targetPos).sub(ship);
    const centerDist = toTarget.length();
    const surfaceDist = centerDist - targetSurfaceRadiusAU;
    const cosTarget = centerDist > 1e-12
      ? toTarget.dot(dir) / centerDist
      : 1;
    const targetCap = governedSpeedCap(
      surfaceDist, targetSurfaceRadiusAU, cosTarget,
      k, BODY_APPROACH_V_MIN_AU_S,
    );
    const pace = Math.min(commanded, targetCap);
    prevShip.copy(ship);
    ship.addScaledVector(dir, pace * DT_S);

    for (const body of laneBodies) {
      // Everything in one synchronized window [elapsed, elapsed + DT]: the
      // body starts the step where the ship does, and the closest approach
      // is solved on the RELATIVE segment, so a fast inner moon can't slip
      // between samples. (Body velocities are TARGET-RELATIVE — the frozen
      // target is the frame; handing bodies the shared heliocentric
      // translation would read as fictitious lane drift.)
      bodyPos.copy(body.pos).addScaledVector(body.velAUPerS, elapsed * timeRate);
      relStart.copy(bodyPos).sub(prevShip);
      relStep.copy(body.velAUPerS).multiplyScalar(DT_S * timeRate)
        .addScaledVector(dir, -pace * DT_S);
      const stepLenSq = relStep.lengthSq();
      const tClosest = stepLenSq > 1e-30
        ? THREE.MathUtils.clamp(-relStart.dot(relStep) / stepLenSq, 0, 1)
        : 0;
      // The ship→body offset at the same in-step moment as the closest
      // approach — the relative segment IS that offset over the window, so
      // both the distance and the approach cosine read one synchronized
      // instant.
      relStart.addScaledVector(relStep, tClosest);
      const closest = relStart.length();
      const bodySurface = closest - body.governedRadiusAU;
      const cosBody = closest > 1e-12
        ? THREE.MathUtils.clamp(relStart.dot(dir) / closest, -1, 1)
        : 1;
      const bodyCap = governedSpeedCap(
        bodySurface, body.governedRadiusAU, cosBody,
        k, BODY_APPROACH_V_MIN_AU_S,
      );
      const withBody = Math.min(pace, bodyCap);
      if (pace > 1e-15) {
        const ratio = withBody / pace;
        if (ratio < worst) worst = ratio;
      }
    }
    elapsed += DT_S;

    const nowDist = targetPos.distanceTo(ship);
    if (nowDist > centerDist) receding = true;
    if (receding && nowDist - targetSurfaceRadiusAU > exitDistAU) {
      completed = true;
      break;
    }
  }
  return completed ? worst : Math.min(worst, LANE_CLEAN_RATIO - 0.01);
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
