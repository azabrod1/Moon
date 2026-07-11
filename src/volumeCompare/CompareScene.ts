/**
 * The volume-compare studio scene: a glass version of the container planet, a
 * warm key light, a dimmed starfield, and an instanced mesh of filler spheres —
 * everything under one group flipped visible on activate. Studio scale pins the
 * container's inner radius at 1.0 unit (the same scale the solver and the
 * spherePhysics mouth geometry use), so 1 filler ball is 1/across units across.
 *
 * The mode owns the camera, the OrbitControls, and the DOM; this owns the scene
 * content, the VC-owned textures, and their disposal. Nothing here reaches into
 * the Planetarium's state or its saves.
 *
 * Glass v1 is two shells sharing one program (BackSide then FrontSide): a
 * view-dependent alpha that stays near-clear face-on and dense at the rim, a
 * tight warm fresnel edge lobe, an opening discarded around +Y on both shells,
 * and — on the back wall only — the container's own colour map ghosted in and
 * lit by the key, so glass-Jupiter still reads as Jupiter. The ghost's gain is
 * normalized by the map's mean luminance so a dark-ocean Earth reads as
 * translucent as bright-banded Jupiter rather than a solid unlit ball.
 */
import * as THREE from 'three';
import {
  loadTexture,
  createMoonTextures,
  ATMOSPHERES,
  planetArchetype,
  moonArchetype,
  type AtmosphereConfig,
} from '../planetarium/PlanetFactory';
import { augmentSurfaceMaterial, type SurfaceArchetype } from '../planetarium/world/surfaceShading';
import { createPlanetariumStarfield, setStarfieldPixelRatio } from '../planetarium/world/starfield';
import { captureDeviceTextureCaps } from '../planetarium/world/texturePolicy';
import { atmosphereVertexShader, atmosphereFragmentShader } from '../shared/shaders/atmosphere';
import { PLANETARIUM_BODIES, SUN_DATA, type PlanetData } from '../planetarium/planets/planetData';
import { MOONS, type MoonData } from '../planetarium/planets/moonData';
import { mouthGeometry, SpherePhysics, defaultPhysicsParams, PACK_CEILING } from './spherePhysics';
import { mulberry32 } from './rng';
import { DEG2RAD } from '../shared/math/angles';
import {
  COMPARE_TUNABLES,
  capHeightForVolume,
  pourBudget,
  spawnAllowance,
  sandFillFraction,
  heapHeightAt,
  heapSplit,
  type Comparison,
  type FillRegime,
  type SpawnCaps,
} from './compareLogic';

// --- studio scale + framing ------------------------------------------------
// The container's inner radius is 1 unit; the glass shells sit exactly there.
export const CONTAINER_R = 1.0;
// Camera framing (the mode applies these to the camera + its OrbitControls).
export const VC_FRAMING = {
  /** Start orbit: gentle 20° elevation. `distance` is the wide-screen default —
   *  the real per-aspect value comes from defaultOrbitDistance(). */
  elevationDeg: 20,
  /** Start azimuth rides ~8° off the key light (key azimuth ≈ −43°), so the
   *  vessel and the pile open on their lit three-quarter — dead-on +Z shows
   *  the glass mostly backlit and the marbles mostly night-side. */
  azimuthDeg: -35,
  distance: 4.2,
  /** Look slightly below the equator so the open mouth sits in the upper frame. */
  target: new THREE.Vector3(0, -0.15, 0),
  /** Orbit distance clamp — never inside the glass, never lost in the dark. */
  minDistance: 1.7,
  maxDistance: 8,
  dampingFactor: 0.05,
} as const;

/**
 * Default orbit distance for an aspect ratio. On wide screens the vessel takes
 * ~69% of the frame's height — showroom framing, air above and below. On
 * narrow (portrait) screens the horizontal FOV is the tight side, so fit ~95%
 * of that instead; without this the sphere overflows a phone frame and the
 * vessel silhouette is lost entirely.
 */
export function defaultOrbitDistance(aspect: number): number {
  const vHalf = 20 * DEG2RAD; // half of the camera's 40° vertical FOV
  const hHalf = Math.atan(Math.tan(vHalf) * Math.max(aspect, 0.01));
  const fitHalf = Math.min(0.69 * vHalf, 0.95 * hHalf);
  return CONTAINER_R / Math.sin(fitHalf);
}

/**
 * Pull the camera back for a scene that tops higher than the vessel (a boulder
 * perched on the glass, or the sub-unity filler poking out): the default
 * distance scaled by (top extent + margin) / R, never past what maxDistance
 * allows. Marbles pass topExtent = R and get the default untouched.
 */
export function tallSceneDistance(aspect: number, topExtent: number, maxDistance: number): number {
  const base = defaultOrbitDistance(aspect);
  const margin = topExtent + 0.15;
  const fit = Math.min(Math.max(margin / CONTAINER_R, 1), Math.max(1, maxDistance / base));
  return base * fit;
}

// --- lighting --------------------------------------------------------------
// One warm point light raked from upper-side-behind (¾ back) so it rims the
// glass into a bright crescent and back-lights the mouth. No ambient, no fill —
// the dark side comes from the fillers' own surface-shading night floor.
// Showroom key: upper-left, ~45° camera-side of the product. The glass rim is
// view-locked fresnel and needs no back-light, so the key's job is the
// CONTENTS — lit hemispheres on the pile facing the viewer, and a brighter
// far wall behind it for silhouette separation. Orbiting still reveals the
// direction: the lit shoulder travels, the far side falls off.
const KEY_LIGHT_DIR = new THREE.Vector3(-0.6, 0.5, 0.65).normalize();
// A dedicated key for the sub-unity loom filler only: its belly faces the camera
// (below) and the shared upper key leaves it in night. Side-biased, not frontal —
// a frontal underlight grazes the belly at loom distances and washes it flat
// cream; the side component keeps band relief so the giant reads as its planet.
const SUB_UNITY_LOOM_KEY = new THREE.Vector3(-0.55, -0.38, 0.74).normalize();
const KEY_LIGHT_DISTANCE = 6;
const KEY_LIGHT_COLOR = 0xffe8c8;
const KEY_LIGHT_INTENSITY = 8;
const WARM_TINT = new THREE.Color(0xffe6c4); // warm-key white for the fresnel rim
// Night-side lift for the fillers, borrowed from the app's planetshine idiom:
// a faint cool-neutral fill from the camera side so unlit hemispheres read as
// dim worlds instead of holes. Mode-scoped — set on VC's material handle only.
const FILL_SHINE_COLOR = 0x9aa4b8;
const FILL_SHINE_DIR = new THREE.Vector3(0.4, 0.2, 1).normalize();
const FILL_SHINE_INTENSITY = 1.5;
// Hemisphere studio fill for the fillers only (scoped via the ShaderMaterial
// bodies ignoring scene lights). Warm-neutral sky, dark ground — lifts night
// sides to a readable fraction of day without flattening the key's direction.
// The fill carries the pile's presence: raised so the packed marbles read as lit
// worlds (matched to the mass floor lift), never a dim grey heap — but held below
// a flat plastic wash so the key's direction still travels across the pile.
const FILL_SKY_COLOR = 0xaeb6c6;
const FILL_GROUND_COLOR = 0x2a2622;
const FILL_HEMI_INTENSITY = 1.6;

// --- ghost tuning ----------------------------------------------------------
// The ghost map's brightness is normalized to this mean luminance so every
// container reads EQUALLY translucent — the whole point of the gain. A bright
// map (Jupiter ~0.62) must be pulled DOWN to the target just as a dark one
// (Earth ~0.25) is lifted up, so the floor sits below 1: only a near-black map
// hits it. The ceiling stops a black map from blowing out. The target is low so
// the surface only WHISPERS through the vessel (blended at the view-dependent
// alpha, the ghost is faint at the clear centre and densest toward the rim) —
// the caption must read "empty glass Jupiter", not "Jupiter at night".
const GHOST_TARGET_LUM = 0.85;
// Floor sits below the gain the brightest map needs (Moon at target 0.32 wants
// ~0.44) so every container normalizes to the target — bright Jupiter/Moon read
// as translucent as dark Earth. It only guards against a near-black map (gain -> 0).
const GHOST_GAIN_MIN = 0.3;
const GHOST_GAIN_MAX = 5.0;
// High-contrast maps defeat a mean-only gain: at equal MEAN, Earth's bright
// Antarctica/cloud decks punch through the vessel as glowing blobs while its
// oceans stay black. The knee clamps ghost texels at this multiple of the map's
// own mean (converted to the shader's linear space), so peaks flatten toward
// the body's overall translucency and the glass illusion survives every map.
const GHOST_KNEE_X_MEAN = 2.5;
// The ghost's presented luminance floor: the alpha curve's low end (its clear-centre
// value). Raised from a barely-there whisper so the container's bands stay readable
// ABOVE the fill at a default camera during a pour — a floor, not a re-light, so the
// glass-not-solid feel survives (the rim stays denser via the fresnel curve).
const GHOST_FLOOR_ALPHA = 0.14;
// Cold-open empty lift: while the vessel is empty, a gentle studio fill brightens
// the ghost so the empty glass reads as a full subject, easing OUT over the first 5%
// of occupancy — the house lights dim over the first breath of the pour, never a snap.
// An extra on top of GHOST_FLOOR_ALPHA (which holds at every fill).
const EMPTY_LIFT_GAIN = 0.55;
const EMPTY_LIFT_FADE_END = 0.05;

// --- backdrop --------------------------------------------------------------
// The Planetarium starfield, dimmed so it reads as depth behind the glass, not
// as dirt seen through it — but not so dim that the clear centre of the vessel
// reads as a HOLE in space instead of glass with space behind it.
const STARFIELD_DIM = 0.45;

// While an in-mode pair swap loads, the scene dims to this fraction (the arrival
// veil is only for mode entry) so the swap reads as deliberate, not a flicker.
const LOADING_DIM = 0.4;

// --- atmosphere ghost ------------------------------------------------------
// Containers with an atmosphere get the app's own glow shell, faded to this
// fraction so it whispers "this is that planet" without competing with the glass.
const ATMOSPHERE_GHOST_ALPHA = 0.3;

// --- liquid ----------------------------------------------------------------
// The molten liquid sits at a radius a hair inside the glass so the meniscus
// ring reads against the shell rather than z-fighting it. Cap-volume math uses
// this radius, never the container R (standing ruling).
const R_LIQ = 0.995;
// The rendered liquid height (above the bottom pole) at a full fill — the rim the
// visual top-out trigger (liquidAtRim) watches for. A full sphere cap is 2·R_liq.
export const LIQUID_RIM_Y = 2 * R_LIQ;
// The rendered liquid volume is the logical fillFraction (= melted / N) scaled
// by this R_liq sphere volume, so the liquid tops the vessel exactly when
// melted = N. Feeding raw ball volumes (V_container / N each) here instead
// would fill ~1.5% early, since R_liq³ = 0.985 of the container's.
const LIQUID_SPHERE_VOLUME = (4 / 3) * Math.PI * R_LIQ * R_LIQ * R_LIQ;
// Melt identity: the fraction of the filler's CATALOG tint blended into the melt
// palette's two MID stops (uMeltPalette1/2). Luminance-percentile stops alone melt a
// marbled Earth into brown mud (the mid stops average land + ocean); pulling the mids
// toward the catalog colour keeps the resting pool reading as that body's stuff while
// the dark/bright end stops keep the map's own range. Melt-only by construction: the
// sand bed and the boulder front read the raw uPalette stops.
const MELT_IDENTITY_BLEND = 0.4;

// --- pour feel -------------------------------------------------------------
// The solver constrains balls to a bowl a hair inside the glass (the scatter
// inset) so a resting ball's surface never coincides with the shell at the limb.
// The glass shell stays at CONTAINER_R (1) and the liquid at R_liq (0.995).
const SOLVER_R = 0.97;
// The spout stream ramps in / trails out over this time constant so opening and
// closing the pour never snaps (feel contract).
const SPOUT_RAMP_TAU = 0.4;
// Pour rate scales with the mouth: min(pourMaxPerSec, POUR_RATE_K · balls-across)
// — a wide mouth (11 across) feeds ~88/s, a chunky one (3.7 across) ~29/s, so
// balls never pile onto the rim faster than the opening swallows them.
const POUR_RATE_K = 8;
// Below this many balls across, the pour is "chunky": a tighter in-flight cap
// (balls a third of the bowl wide bridge and tower if too many fall at once).
const CHUNKY_ACROSS = 6;
// Never let more than this many un-entered balls exist at once (the spawner
// holds otherwise) — a falling column that outpaces entry builds a tower that
// deflects chunky balls over the rim onto the dome. Chunky pours cap tighter.
const IN_FLIGHT_CAP_CHUNKY = 4;
const IN_FLIGHT_CAP = 12;
// The sub-unity filler renders at its TRUE radius ratio (Alex's ruling: "keep
// Jupiter whole screen and make Moon smaller so scale is real") — no clamp. The
// framing (frameSubUnity) keeps the giant owning the frame and shrinks the vessel
// to its size floor, so the smallness is the honest story.
// Above this filler radius the sub-unity pose keeps fitting both (filler wedged
// in the mouth, poking well out) vs framing the loom (glass in the lower third,
// giant overflowing). Tunable.
export const SUB_UNITY_LOOM_RF = 2.5;
// Sub-unity renders the vessel WITH a mouth (not a sealed whole vessel):
// the oversized filler wedges into this opening like an egg in a cup — it reads
// as "went in as far as it fits", not balanced on a pole. Display-only radius.
const SUBUNITY_MOUTH_R = 0.35;
const SUBUNITY_MOUTH_PLANE_Y = Math.sqrt(CONTAINER_R * CONTAINER_R - SUBUNITY_MOUTH_R * SUBUNITY_MOUTH_R);
// A drained (popped) ball scales out over this long — a quick unwind, not a cut.
const DRAIN_SHRINK_S = 0.15;
// Max solids popped per frame on a drain, so a full-slider yank unwinds in a
// beat rather than vanishing instantly (and the shrink list stays bounded).
const DRAIN_MAX_PER_FRAME = 40;
// Ripples: a small pool of additive quads, radial fade, short life — one is
// placed at each melt/consume splash.
const RIPPLE_POOL = 24;
const RIPPLE_LIFE = 0.5;
const RIPPLE_MAX_R = 0.09; // studio units at full expansion (a small splash flash)
// Faller/stream splash droplets warm a touch toward this so the burst reads as a
// splash, not stray filler flecks (kept sub-bloom by the ≤1.35 gain in grainColor).
const SPLASH_WARM = new THREE.Color(1.0, 0.72, 0.38);

// --- sand grains (the pour stream + the overflow spill) --------------------
// One THREE.Points pool of lit sphere-impostors, allocated at the FULL-tier
// capacity and disposed once. The tier budget (sandGrainBudget) bounds how many
// are ever live; unused slots sit dead (aAge ≥ aLife → 0 px). Both the stream
// and the spill draw from this one pool.
const GRAIN_CAPACITY = 3000;
// Grains never render at the true single-body radius (a sub-pixel sliver at this
// scale) — they read as sand at a small studio size, jittered, with the ≥1px·dpr
// floor carrying them at distance (the starfield idiom). Small enough to stay
// grain-like even zoomed in at the crest (larger sizes read as boulders there);
// the stream RATE, not the grain size, carries the ribbon's body.
const GRAIN_SIZE_MIN = 0.007;
const GRAIN_SIZE_MAX = 0.014;
// The spill grains read a touch larger so the garnish is legible at the rim.
const SPILL_SIZE_MIN = 0.02;
const SPILL_SIZE_MAX = 0.034;
// Studio gravity for the falling column + the spill arc (units/s²) — tuned so a
// full-height pour reads as a quick sand fall, not a slow drift.
const GRAIN_GRAVITY = 6.5;
// Terminal velocity for the falling column (kind-0 stream + kind-2 plume/droplets)
// so it reaches the bed without thinning under unchecked acceleration. The kind-1
// spill stays ballistic (its arc is tuned).
const GRAIN_VT = 2.2;
// The stream spawns across a gaussian disc this fraction of the mouth radius —
// a TIGHT dense core (most grains on the axis, a few strays) so the column reads
// as a continuous ribbon, not drifting dust (display-only cross-section).
const STREAM_DISC_FRAC = 0.32;
// Stream throughput (grains/sec) while pouring — high enough that the tight core
// reads as a solid ribbon at the half-size grain; emitStream scales it to the
// device tier's slot band so a tall early-pour fall never outruns the pool.
const STREAM_RATE = 2600;

// --- sand heap (the settled bulk + the repose cone that rides on it) -------
// The sand surface is a full-width cone on a spherical-cap bulk, a PURE function
// of poured volume (heapSplit): crest at the axis, meeting the glass wall at 0.
// REPOSE_SLOPE is the flank angle tan (0.7 ≈ 35°, dry sand's true angle of repose —
// the steeper crest reads as genuinely poured granular material where a shallower
// cone read melted-flat); it binds through the bottom half of the fill so the flank
// sits at exact repose — the signature realism cue. HEADROOM_K eases the whole surface flat as the fill nears the brim
// (the crest stays below the mouth). AZ_AMP is a frozen per-pour azimuthal wobble
// of the crest height (≤6%, GLSL-only, imperceptible at grain size — the CPU kill
// plane stays on the nominal profile). SAND_N_ROUGH is the fragment micro-noise
// blended around the analytic flank normal so the flank is grainy, not glassy.
const REPOSE_SLOPE = 0.7;
const HEADROOM_K = 0.55;
const AZ_AMP = 0.03;
const SAND_N_ROUGH = 0.22;
// Mass legibility floor. The molten/sand mass carries only its filler albedo × a
// dim constant with no diffuse key, so a dark-albedo filler (Earth's oceans, mean
// ~6/255) renders as a black silhouette. massFloorLift lifts each pixel toward this
// presented luminance IN ITS OWN HUE — directional (brighter toward the key, never
// dead-black on the far side) so the mass reads as a lit body, and a pure floor so
// already-lit pixels (a bright filler's top surface) stay near-untouched.
const MASS_FLOOR = 0.06;
// The far-side night fraction of that floor (a flank turned from the key still
// reads, never a hole); the remainder is the key-facing directional gain.
const MASS_FLOOR_NIGHT = 0.42;
// The same legibility floor for the INSTANCED MARBLES (the pre-melt pile): a
// dark-albedo filler (Earth) packs into a near-black heap even under the key +
// hemisphere fill, because albedo bounds every light's contribution. A notch lower
// than the mass floor — marbles need their form shading (each is a little world)
// more than the liquid needs body. Injected into the standard material after the
// shared surface-shading hook; hue-preserving and directional like massFloorLift,
// and a pure floor, so bright-albedo fillers (Moon marbles) stay byte-close.
const PILE_FLOOR = 0.045;
// The marble floor's injected chunk (byte-identical for every filler material, so the
// compiled program is shared across pairs). Runs after the surface-shading terms, in
// linear radiance before <opaque_fragment>; `normal`/`vSunViewDir` are the standard
// material's perturbed view-space normal and the shading hook's key direction. Only
// the final radiance is lifted — spec/roughness/metalness untouched, no plastic.
const PILE_FLOOR_FRAGMENT = /* glsl */ `{
  float pfCurLum = dot(outgoingLight, vec3(0.2126, 0.7152, 0.0722));
  float pfNdl = max(dot(normalize(normal), normalize(vSunViewDir)), 0.0);
  float pfTarget = ${PILE_FLOOR.toFixed(3)} * (${MASS_FLOOR_NIGHT.toFixed(3)} + ${(1 - MASS_FLOOR_NIGHT).toFixed(3)} * pfNdl);
  float pfDeficit = max(0.0, pfTarget - pfCurLum);
  outgoingLight += (outgoingLight / max(pfCurLum, 1e-4)) * pfDeficit;
}`;
// Contact rollers: the strongest "alive heap" cue. At crest contact a fraction of
// stream-grain deaths convert to short-lived grains that RIDE the flank down to the
// foot instead of vanishing — budget-neutral (they reuse the dying grain's slot).
const ROLLER_FRACTION = 0.12; // ≤12% of crest contacts
const ROLLER_SPEED_MIN = 0.35; // initial outward speed down the flank, studio units/s
const ROLLER_SPEED_MAX = 0.7;
const ROLLER_ACCEL = 1.6; // down-slope acceleration (per-second speed growth factor)
const ROLLER_LIFE_MIN = 0.4;
const ROLLER_LIFE_MAX = 0.7; // dies at the flank foot or this life, whichever first
// A slot band reserved for the spill + plume so a dense stream can't starve them.
const SPILL_RESERVE = 220;
// The overflow spill: a restrained garnish, ~40 grains over ~1.5 s at the rim.
const SPILL_COUNT = 40;
const SPILL_EMIT_S = 1.5;
const SPILL_GRAIN_LIFE = 1.5;

// --- boulder melt runoff (the causal cue: a ball melting on the glass FEEDS the pool) -
// A slender warm trickle of molten grains falls from a melting boulder's base to the
// pool while a gap separates them, so the pour reads as "the ball melts INTO the pool",
// not "a solid on top + a pool that appeared on its own". Reuses the grain pool as
// kind-0 (dies at the pool since a boulder's heap crest is 0). Thin by design.
const RUNOFF_RATE = 90; // grains/sec — a strand, not a stream
const RUNOFF_COLOR = new THREE.Color(1.0, 0.5, 0.18); // molten, sub-bloom

// --- marble rain fallers (display-owned; the solver keeps only the residual pile) -
// During `raining`, each arrival is a display faller that falls from the spout,
// contacts the pool/pile, splashes, and sinks — never a solver ball (the mouth-melt
// bug ate arrivals mid-descent). 1:1 with poured; the solver drains its own pile.
const FALLER_CAP = 128; // ≥ rate × airborne life (≈ 88/s × 0.95 s ≈ 84) with margin
const FALLER_GRAVITY = 5.5; // studio units/s² (own constant; GRAIN_GRAVITY is grains-only)
const FALLER_VT = 3.6; // terminal velocity → a ~0.6-0.8 s full-height fall (reads as a pour)
const FALLER_SINK_S = 0.2; // scale/translate below the contact plane over this long
const FALLER_SPAWN_Y = 1.3; // spout height the arrivals fall from (above the vessel top)
// The shared impact-churn spot: an animated surface roil at each active site
// (sand stream slot 0, marble splashes slots 1-3), rendered in the disc shader.
const CHURN_R = 0.17; // world-space radius of a churn spot's falloff
const CHURN_LIFE = 0.6; // seconds a churn spot rolls before it ages out
// On completion the airborne splash/plume/droplet garnish is retired over this
// window — a graceful fade (NOT the instant cancelTransients pop) so the end card
// settles over a clean scene. Under the ≤0.6 s retire budget.
const RETIRE_FADE_S = 0.5;
// The overflow-spill grains arc over the shoulder and sit AT/OUTSIDE the vessel
// limb — a lit droplet there reads as a stray after the landing settles, so they
// retire on a much shorter beat than the over-pool garnish (which fades in place).
const SPILL_RETIRE_FADE_S = 0.18;

// --- instanced fillers -----------------------------------------------------
// Capacity = the marble cap (4000) + FALLER_CAP so the faller tail always has
// slots: accounting never depends on a render guard (a dropped mesh write drops
// only the DRAW, never a faller or its melted++).
const INSTANCE_CAPACITY = 4000 + FALLER_CAP;
const FILLER_SEGMENTS_W = 16;
const FILLER_SEGMENTS_H = 10;
// devScatter keeps every ball this far inside the shell (|p| + r ≤ this) so no
// filler ever pokes through the glass in the transparency QA.
const SCATTER_INSET = 0.97;
const SCATTER_SEED = 0x5eed; // fixed so the QA layout is reproducible

const PLANET_BY_NAME = new Map<string, PlanetData>(PLANETARIUM_BODIES.map((p) => [p.name, p]));
const MOON_BY_NAME = new Map<string, MoonData>(MOONS.map((m) => [m.name, m]));

/** Catalog colour for a body's tint (Sun is absent from the catalogs). */
function bodyColor(name: string): number {
  if (name === 'Sun') return SUN_DATA.color;
  return PLANET_BY_NAME.get(name)?.color ?? MOON_BY_NAME.get(name)?.color ?? 0x888888;
}

/** Surface archetype for the filler's night-fill + limb darkening — the same
 *  classification the Planetarium uses. Sun is handled separately. */
function fillerArchetype(name: string): SurfaceArchetype {
  const planet = PLANET_BY_NAME.get(name);
  if (planet) return planetArchetype(planet);
  const moon = MOON_BY_NAME.get(name);
  if (moon) return moonArchetype(moon);
  return 'airless';
}

// --- glass shader ----------------------------------------------------------
const GLASS_VERTEX = /* glsl */ `
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec3 vObjPos;
varying vec2 vUv;
void main() {
  vUv = uv;
  vObjPos = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const GLASS_FRAGMENT = /* glsl */ `
uniform vec3 uCam;
uniform vec3 uWarmTint;
uniform vec3 uCatalogTint;
uniform sampler2D uGhostMap;
uniform float uHasGhost;
uniform float uGhostGain;
uniform float uMouthPlaneY; // the opening's plane height on the unit sphere (2 = no mouth)
uniform float uMouthOpen;   // 0 closed sphere → 1 irised open
uniform float uGhostKnee;   // ghost texel ceiling (linear) — flattens bright peaks
uniform float uBackShell;   // 1 for the far shell (lit ghost), 0 for the near shell
uniform float uDim;         // 1 normally, < 1 while an in-mode pair swap loads
uniform float uReveal;      // 1 presented, eases 0→1 on reveal (held 0 until a pair is fully loaded)
uniform float uFill;        // 0..1 liquid fill — warms the rim as the glass fills
uniform float uLoomLit;     // 1 in the sub-unity honest loom (light the vessel from the giant above)
uniform float uContainerIsSun; // 1 when the container is the Sun (granulate the ember dome; 0 = byte-identical)
uniform float uEmptyLift;      // 1 while the vessel is empty, eases to 0 early in the pour (cold-open ghost fill)
uniform float uTime;           // seconds — drifts the ember granulation at solar-convection pace
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec3 vObjPos;
varying vec2 vUv;

// Sub-unity loom vessel lighting (applied in the back-shell ghost branch below):
// the giant looms straight overhead and lights the tiny vessel from above. Tunable.
const vec3 LOOM_KEY = vec3(-0.301, 0.905, 0.301); // strongly overhead, camera-left (unit)
const float LOOM_AMBIENT = 0.12;    // belly night floor (never a pure-black pebble)
const float LOOM_GAIN = 1.25;       // lit-ghost strength over the faint hologram
const float LOOM_BODY_ALPHA = 0.74; // body alpha floor so the lit world survives the glass blend

// Ember granulation (the Sun dome): the emissive-boulder fbm, reused to break the
// featureless brown gradient into soft solar cells. NaN-free at all-zero uniforms.
// mod 2*pi before the sine: identity (sine is 2*pi-periodic) but it bounds the
// argument, so an Apple Metal fast-math sine can't return NaN for a large arg and
// poison the granulation (framebuffer clamps NaN to black).
float gHash(vec2 p){
  float a = mod(dot(p, vec2(127.1, 311.7)), 6.2831853071795864);
  return fract(sin(a) * 43758.5453);
}
float gNoise(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(gHash(i),gHash(i+vec2(1,0)),f.x), mix(gHash(i+vec2(0,1)),gHash(i+vec2(1,1)),f.x), f.y); }
float gFbm(vec2 p){ float v=0.0,a=0.5; for(int i=0;i<4;i++){ v+=a*gNoise(p); p*=2.0; a*=0.5; } return v; }

void main() {
  // The mouth irises open only during a pour: the discard threshold eases from
  // above the pole (closed → a pristine whole sphere at idle) down to the mouth
  // plane (an open hole balls pour through).
  vec3 dir = normalize(vObjPos);
  float plane = mix(1.05, uMouthPlaneY, uMouthOpen);
  float mouthEdge = 1.0 - smoothstep(plane - 0.05, plane, dir.y);
  if (mouthEdge <= 0.0) discard;

  vec3 N = normalize(vWorldNormal);
  vec3 V = normalize(uCam - vWorldPos);
  float ndv = abs(dot(N, V));
  float fres = 1.0 - ndv;

  // A thin bright glass-cut rim on the opening — a crisp lip LINE (triangular
  // falloff ~0.028 wide), warm-tinted toward the key colour, not a fat collar.
  // Only its centre crosses the bloom threshold, so the halo stays about the
  // line's width.
  float rimD = dir.y - (plane - 0.028);
  float cutRim = max(0.0, 1.0 - abs(rimD) / 0.014) * uMouthOpen;

  // View-dependent alpha: clearest face-on (stars read through the face), dense
  // at the rim (constant alpha reads as a frosted billiard ball and
  // double-darkens where the shells cross). The floor stays visibly above zero —
  // a fully-clear centre reveals raw void and the vessel reads as a hole.
  float alpha = mix(0.14, 0.9, pow(fres, 2.5));

  // Tight warm fresnel edge lobe, blended with a faint catalog-colour rim; the
  // rim warms toward the key colour as the liquid rises (the glass reacts to
  // its contents).
  float edge = pow(fres, 5.0);
  vec3 rimTint = mix(mix(uWarmTint, uCatalogTint, 0.35), uWarmTint, 0.5 * uFill);
  vec3 col = rimTint * edge;

  // Second fresnel lobe — a faint green-cyan absorption tint (thick-glass iron
  // colour), steep enough to sit only in the outer third of the disc so the
  // face stays clear (no milky billiard-ball veil across the centre).
  float shoulder = pow(fres, 2.6);
  col += vec3(0.75, 1.0, 0.92) * shoulder * 0.14;

  // No front-shell specular glint: a tight HDR ping over the bloom threshold
  // read as a bright blob floating mid-vessel and added nothing — the fresnel
  // rim + the glass-cut lip carry the "reflective surface" cue on their own.

  // Ghosted back wall: the far shell shows the container's surface faintly.
  // The key modulates the shell so orbiting reveals a light DIRECTION (lit
  // shoulder, falloff, dark side) — but the floor keeps the texture present on
  // the dark half, so no day/night terminator ever reads on the glass. The
  // knee clamps bright texels (icecaps, cloud decks) that would otherwise
  // punch through the vessel as solid glowing patches. A cheap limb factor
  // keeps it a surface, not a decal.
  if (uBackShell > 0.5 && uHasGhost > 0.5) {
    // The container's REAL colour map as an UNLIT hologram — independent of the
    // key so its identity (Jupiter's cream/rust bands, Saturn's ochre) survives
    // every sun angle, on the night limb too. Auto-gained per container so
    // low-contrast maps still band. Fresnel-shaped: bands at the limb, melting
    // to a clear centre (~0.34 rim → ~0.07 centre). Native saturation kept.
    float ghostAlpha = mix(${GHOST_FLOOR_ALPHA.toFixed(3)}, 0.34, pow(fres, 1.3));
    vec3 ghostTex = min(texture2D(uGhostMap, vUv).rgb, vec3(uGhostKnee));
    col += ghostTex * uGhostGain * ghostAlpha;
    // Cold-open empty lift: a gentle studio fill on the ghost while the vessel is
    // empty, easing out over the first breath of the pour — never in the Sun ember branch
    // (below), and shell alpha is untouched. Rides the ghost hue, a touch fuller at the
    // clear centre than the fresnel curve so the empty glass reads as a full subject.
    col += ghostTex * uGhostGain * (0.6 + 0.4 * pow(fres, 1.3)) * uEmptyLift * ${EMPTY_LIFT_GAIN.toFixed(3)};
    // Sub-unity honest loom: the giant is wedged in the mouth on +Y and looms
    // straight overhead. It lights the tiny vessel from above — planetshine for a
    // Jupiter-class giant, literal sunlight for a Sun giant. Paint the container's
    // own surface onto the far wall, top-lit toward the giant with a camera-side
    // fill so the continents/maria read, and lift the body alpha so the lit world
    // survives the glass blend instead of reading as a black pebble. Loom-gated:
    // uLoomLit 0 leaves every normal-framing vessel byte-identical.
    float loomShade = LOOM_AMBIENT + (1.0 - LOOM_AMBIENT) * max(dot(N, LOOM_KEY), 0.0);
    col += ghostTex * uGhostGain * loomShade * LOOM_GAIN * uLoomLit;
    alpha = mix(alpha, max(alpha, LOOM_BODY_ALPHA), uLoomLit);
  } else if (uBackShell > 0.5) {
    // A ghost-less container (the Sun) would otherwise be a void behind glass:
    // give the vessel an ember interior instead — its own colour pulled toward
    // deep fire, amplitude sized against the low face-on alpha it blends under.
    vec3 emberTint = mix(uCatalogTint, vec3(1.0, 0.45, 0.15), 0.6);
    // Granulate the ember so the close dome plainly reads as the Sun's surface, not a
    // flat brown gradient. Two fbm octaves DRIFTING at a slow solar-convection pace (so
    // the idle dome is clearly alive at a glance, never busy), SHARPENED into crisp cells
    // at CONSTANT mean: the modulation is symmetric about 0.5 (cells=0.5 ⇒ ×1), so the
    // dome's average luminance + whiteout hold, while the cell cores carry real local
    // contrast. It is multiplicative on the ember, so the contrast rides the brighter
    // shoulder + limb (where there is luminance) and fades in the dark zenith. The ±14%
    // peak keeps the limb's brightest cells sub-bloom. The two octaves crawl on slightly
    // different vectors so the field morphs (cells swell/fade) instead of rigidly
    // scrolling. Gated by uContainerIsSun so a ghost-less non-Sun (there is none today)
    // is byte-identical — the drift lives entirely behind mix(1, ·, uContainerIsSun).
    float g1 = gFbm(vObjPos.xy * 6.5 + vec2(uTime * 0.028, uTime * 0.020));
    float g2 = gFbm(vObjPos.xy * 18.0 + vec2(-uTime * 0.017, uTime * 0.025));
    float cells = clamp(0.5 + (g1 * 0.68 + g2 * 0.32 - 0.5) * 3.2, 0.0, 1.0);
    emberTint *= mix(1.0, mix(0.86, 1.14, cells), uContainerIsSun);
    col += emberTint * (0.3 + 0.5 * (1.0 - ndv));
  }

  // Glass-cut rim: additive with the peak just over the 0.92 bloom threshold (a
  // thin hot line), alpha lifted so it reads through the transparent shell.
  col += uWarmTint * cutRim * 1.15;
  alpha = max(alpha, cutRim * 0.7);

  // uReveal holds the vessel hidden until the pair is fully loaded, then eases it
  // in — so a swap never flashes the outgoing pair's map on the new vessel and a
  // cold load never shows a ghost-less shell. 1 in steady state (no-op at rest).
  gl_FragColor = vec4(col * uDim, alpha * mouthEdge * uReveal);
}
`;

// --- liquid shader (molten planet) -----------------------------------------
// A shared fbm (the Sun corona's noise) drives the convection crust and the
// marbling. The interior body renders opaque (depthWrite on, watertight below
// the surface); the surface disc renders transparent between the glass shells.
const LIQUID_COMMON = /* glsl */ `
uniform float uHeat;      // 0.15 at rest, eases to 1 while melting/raining
uniform float uTime;
uniform float uSurfaceY;  // world-space y of the liquid surface
uniform vec3 uPalette0;   // filler map luminance percentiles → marbling ramp
uniform vec3 uPalette1;
uniform vec3 uPalette2;
uniform vec3 uPalette3;
uniform vec3 uMeltPalette0; // MELT-ONLY marbling stops: uPalette with the catalog tint
uniform vec3 uMeltPalette1; // blended into the mid stops, so the resting melt keeps the
uniform vec3 uMeltPalette2; // body's identity colour (melted Earths read blue, not mud)
uniform vec3 uMeltPalette3;
uniform vec3 uCam;        // camera world position — the disc's wet specular lobe
uniform vec3 uSunDir;     // key direction for the sheen
uniform vec3 uContainerTint0; // container palette stops — the at-rest melt-identity bands
uniform vec3 uContainerTint1;
uniform float uContainerMix;  // 0 when the container has no map (the Sun skip)
uniform float uSandSurface;   // 1 on the sand bed (material read), 0 for marbles/boulders
uniform float uSurfDiscR;     // the surface disc's world radius (churn sites are world xz)
uniform float uPeakH;         // sand heap crest height, world units (0 off — see heapHeightAt mirror)
uniform float uStreamActive;  // eased 0..1, 1 while the sand stream pours (trickle life; 0 for marbles)
// Impact-churn sites: vec4(worldX, worldZ, age01, amp) — an animated surface roil
// where the stream/fallers meet the pool. age01>=1 is dead. Shared: sand stream
// (slot 0, pinned centre) + marble splashes (rotating 1-3). Strictly a roil.
uniform vec4 uChurn[4];
float lqHash(vec2 p){
  // Reduce the sine argument modulo 2*pi before sampling. Sine is 2*pi-periodic so
  // this is mathematically identity, but it keeps the argument small: a fast-math
  // sine that returns NaN for large arguments (observed on Apple Metal at the
  // high-frequency grain samples, ~1e5) would otherwise poison the whole procedural
  // mass and the framebuffer clamps NaN to black. Bounded argument -> always finite.
  float a = mod(dot(p, vec2(127.1, 311.7)), 6.2831853071795864);
  return fract(sin(a) * 43758.5453);
}
float lqNoise(vec2 p){
  vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(lqHash(i),lqHash(i+vec2(1,0)),f.x),
             mix(lqHash(i+vec2(0,1)),lqHash(i+vec2(1,1)),f.x), f.y);
}
float lqFbm(vec2 p){ float v=0.0,a=0.5; for(int i=0;i<4;i++){ v+=a*lqNoise(p); p*=2.0; a*=0.5; } return v; }
// The filler slurry colour at a marbling value m in [0,1] — a 4-stop ramp of
// the map's own luminance percentiles, so Earth melts into ocean/land/cloud.
vec3 lqPalette(float m){
  if (m < 0.33) return mix(uPalette0, uPalette1, m / 0.33);
  if (m < 0.66) return mix(uPalette1, uPalette2, (m - 0.33) / 0.33);
  return mix(uPalette2, uPalette3, (m - 0.66) / 0.34);
}
// The MELT's marbling palette: uMeltPalette stops for the melt, but the SAND bed keeps
// uPalette exactly (uSandSurface 1 → byte-identical: the bed IS the filler's raw
// material). The boulder front reads uPalette directly (a separate shader), so the
// melt identity blend never touches it either.
vec3 lqMeltPalette(float m){
  vec3 p0 = mix(uMeltPalette0, uPalette0, uSandSurface);
  vec3 p1 = mix(uMeltPalette1, uPalette1, uSandSurface);
  vec3 p2 = mix(uMeltPalette2, uPalette2, uSandSurface);
  vec3 p3 = mix(uMeltPalette3, uPalette3, uSandSurface);
  if (m < 0.33) return mix(p0, p1, m / 0.33);
  if (m < 0.66) return mix(p1, p2, (m - 0.33) / 0.33);
  return mix(p2, p3, (m - 0.66) / 0.34);
}
// The studio key as a directional legibility FLOOR on the mass. Lifts each pixel
// toward a presented luminance in its own hue (never a flat white boost), the floor
// scaled by a directional shape (brighter toward the key). A pixel already above
// the floor is returned unchanged, so a bright filler's lit surface is near-identity
// while a dark-albedo mass stops reading as a black silhouette. Hue-preserving:
// the added luminance rides the pixel's own colour direction.
vec3 massFloorLift(vec3 c, vec3 N, vec3 keyDir, float floorLum){
  float curLum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float ndl = max(dot(normalize(N), keyDir), 0.0);
  float shape = ${MASS_FLOOR_NIGHT.toFixed(3)} + ${(1 - MASS_FLOOR_NIGHT).toFixed(3)} * ndl; // directional; never fully dark
  float target = floorLum * shape;
  float deficit = max(0.0, target - curLum);
  return c + (c / max(curLum, 1e-4)) * deficit;
}
// GPU safety net for the procedural mass. On some drivers (seen on Apple Metal)
// the sand/melt math evaluates a NaN for certain camera + fill states; the
// framebuffer clamps NaN to zero and the whole mass reads as a black silhouette
// next to the lit vessel. Replace any non-finite channel with a legible fallback
// (finite by construction — a constant-input read of the filler's own mid-tone),
// so the body is never a black hole. A NaN never equals itself, so x == x is the
// finiteness test.
vec3 sanitizeMass(vec3 col, vec3 fallback){
  return vec3(
    col.x == col.x ? col.x : fallback.x,
    col.y == col.y ? col.y : fallback.y,
    col.z == col.z ? col.z : fallback.z
  );
}
`;

const LIQUID_BODY_VERTEX = /* glsl */ `
varying vec3 vObjPos;
varying vec3 vWorldNormal;
varying vec3 vWorldPos;
void main(){
  vObjPos = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const LIQUID_BODY_FRAGMENT = /* glsl */ `
${LIQUID_COMMON}
varying vec3 vObjPos;
varying vec3 vWorldNormal;
varying vec3 vWorldPos;
void main(){
  if (vObjPos.y > uSurfaceY) discard; // nothing above the surface plane
  // Depth below the surface, 0 at the meniscus → 1 at the bottom pole.
  float depth = clamp((uSurfaceY - vObjPos.y) / (uSurfaceY + ${R_LIQ.toFixed(3)} + 0.001), 0.0, 1.0);
  // Cooled marbling from the filler palette — a dark body, not a hot volume — with
  // a finer octave so the wall isn't a smear. The sand BED biases the coord toward
  // the lower/mid stops (pow 1.6) + gains up so the wall reads as deep material.
  float m = lqFbm(vObjPos.xz * 4.5 + vec2(0.0, uTime * 0.05));
  float detail = lqFbm(vObjPos.xy * 13.0 + vec2(0.0, uTime * 0.04));
  float mCoord = mix(clamp(m, 0.0, 1.0), pow(clamp(m, 0.0, 1.0), 1.6), uSandSurface);
  vec3 crust = lqMeltPalette(mCoord) * mix(0.44, 0.60, uSandSurface) * (0.9 + 0.2 * detail);
  // Fine granular speckle on the bed wall (off for marbles/boulders).
  crust *= 1.0 + (lqNoise(vObjPos.xy * 130.0) - 0.5) * 0.5 * uSandSurface;
  // Close-range fine grains on the settled bulk too, camera-faded — so the wall below
  // the heap foot reads as the SAME granular sand as the flank, not a smoother wall.
  float fineFadeB = 1.0 - smoothstep(1.7, 2.6, length(uCam - vWorldPos));
  crust *= 1.0 + (0.5 * lqNoise(vObjPos.xz * 420.0) + 0.5 * lqNoise(vObjPos.zy * 420.0) - 0.5) * 0.3 * uSandSurface * fineFadeB;
  // A deep warm glow rises only from the bottom while molten, staying BELOW the
  // 0.92 bloom threshold (max channel 0.85). OFF on the sand bed (cool material).
  vec3 warm = vec3(0.85, 0.4, 0.12);
  float glow = depth * depth * uHeat; // concentrated low, gone by the surface
  vec3 col = mix(crust, warm, glow * 0.75 * (1.0 - uSandSurface));
  // Melt-identity whisper on the wall too (latitude bands along object y) — the
  // same at-rest-only gate as the disc, plus OFF on the sand bed (the bed IS the
  // filler's material; the container identity lives on the glass ghost).
  float restId = (1.0 - smoothstep(0.16, 0.3, uHeat)) * uContainerMix * (1.0 - uSandSurface);
  float cBand = smoothstep(0.35, 0.65, lqNoise(vec2(vObjPos.y * 4.0, 2.3)));
  col = mix(col, mix(uContainerTint0, uContainerTint1, cBand), restId * 0.09);
  // Wet specular SHEEN on the wall so the at-rest pool reads as molten liquid,
  // not matte clay — a broad low-exponent lobe. Near-MATTE on the sand bed.
  vec3 N = normalize(vWorldNormal + vec3((detail - 0.5) * 0.25, 0.0, (m - 0.5) * 0.25));
  // Directional legibility floor so the mass wall reads as a lit body, not a black
  // silhouette (matched to the flank floor so the two meet seamlessly at the rim).
  col = massFloorLift(col, N, uSunDir, ${MASS_FLOOR.toFixed(3)});
  vec3 V = normalize(uCam - vWorldPos);
  float spec = pow(max(dot(reflect(-uSunDir, N), V), 0.0), 10.0);
  col += vec3(1.0, 0.86, 0.62) * spec * mix(0.30, 0.05, uSandSurface);
  // Fallback lights the ANALYTIC world normal (finite), not the noise-derived N.
  col = sanitizeMass(col, massFloorLift(lqMeltPalette(0.5), vWorldNormal, uSunDir, ${MASS_FLOOR.toFixed(3)}));
  gl_FragColor = vec4(col, 1.0);
}
`;

const LIQUID_DISC_VERTEX = /* glsl */ `
uniform float uPeakH;        // world-space sand heap crest height (studio units; 0 = flat)
uniform float uSandSurface;  // 1 on the sand bed (heap on), 0 marbles/boulders (flat)
uniform float uSurfDiscR;    // world radius of the bulk disc — the flank slope is peakH/discR
uniform vec2  uHeapSeed;     // per-pour frozen phase for the azimuthal irregularity
varying vec2 vXz;      // object-space xz (unit circle → radius 1)
varying vec3 vWorldPos;
varying vec3 vFlankN;  // analytic cone-flank normal (world space), crest-softened
// Mirror of heapHeightAt(rr, peakH) in compareLogic — the CPU kill plane and this
// displacement share the one profile. Keep the two in lockstep.
float heapHeightAt(float rr, float peakH){
  return peakH * max(0.0, 1.0 - rr);
}
// mod 2*pi before the sine: identity (sine is 2*pi-periodic) but it bounds the
// argument. uHeapSeed pushes the dot to ~1e4-1e5 here, and an Apple Metal fast-math
// sine returns NaN for a large arg — in this VERTEX stage that NaN flows through the
// azimuthal wobble into the heap height and gl_Position, collapsing the cone geometry
// itself (a corruption the fragment sanitize can't repair). Bounded arg -> always finite.
float vHash(vec2 p){
  float a = mod(dot(p, vec2(127.1, 311.7)), 6.2831853071795864);
  return fract(sin(a) * 43758.5453);
}
float vNoise(vec2 p){
  vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(vHash(i),vHash(i+vec2(1,0)),f.x),
             mix(vHash(i+vec2(0,1)),vHash(i+vec2(1,1)),f.x), f.y);
}
void main(){
  vXz = position.xy; // the radial-ring disc lies in the xy plane before the flat-rotate
  float rr = length(position.xy);
  vec2 dir = rr > 1e-5 ? position.xy / rr : vec2(0.0);
  // Azimuthal irregularity: a frozen, per-pour multiplicative wobble of the crest
  // height that depends on AZIMUTH only (constant down each radial → ridge lines run
  // straight down the flank, no wobble). Sampling smooth value-noise around the unit
  // circle keeps it seamless (the sample point returns to its start at 2pi). Height
  // is world-space (local z, scale.z stays 1) so the heap sits in studio units.
  float az = 1.0 + ${AZ_AMP.toFixed(3)} * (vNoise(dir * 1.5 + uHeapSeed) - 0.5) * 2.0;
  float h = heapHeightAt(rr, uPeakH) * az * uSandSurface;
  vec4 wp = modelMatrix * vec4(position.xy, position.z + h, 1.0);
  vWorldPos = wp.xyz;
  // Analytic flank normal: the cone height H(rho) = peakH·(1 − rho/discR) has slope
  // k = peakH/discR, so the outward normal is normalize(k·radial + up). The object
  // xy direction maps through the disc's −90° x-rotation to the world radial
  // (dir.x, 0, −dir.y). Soften toward +Y over the top ~10% of peakH (rr < 0.1) so the
  // apex catches light softly instead of reading as a facet spike.
  float k = uPeakH / max(uSurfDiscR, 1e-4);
  vec3 radial = vec3(dir.x, 0.0, -dir.y);
  vec3 flank = normalize(k * radial + vec3(0.0, 1.0, 0.0));
  float crest = 1.0 - smoothstep(0.0, 0.1, rr);
  vFlankN = normalize(mix(flank, vec3(0.0, 1.0, 0.0), crest));
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const LIQUID_DISC_FRAGMENT = /* glsl */ `
${LIQUID_COMMON}
varying vec2 vXz;
varying vec3 vWorldPos;
varying vec3 vFlankN;
void main(){
  float rr = length(vXz);        // 0 centre → 1 outer rim (the glass wall)
  // Convection CRUST: dark cooled cells; only the cracks between them glow.
  vec2 drift = vec2(uTime * 0.045, -uTime * 0.035);
  // Baseline crust samples — the FLAT disc in object space. Marbles/boulders keep
  // exactly this (byte-identical at uSandSurface 0); the sand branch below overwrites
  // cell/detail with the 3D-cone reprojection.
  float cell = lqFbm(vXz * 4.5 + drift);
  // A finer octave breaks the crust up so it never reads as a low-res smear.
  float detail = lqFbm(vXz * 16.0 + drift * 0.6);
  // Thin glowing veins — a high band of a finer fbm, ~15% coverage (shared).
  float veins = smoothstep(0.60, 0.72, lqFbm(vXz * 11.0 - drift * 1.3));
  // Camera-distance fade for the close-range granularity (moiré guard): shared by the
  // ×420 speckle and the micro-glint below — both sand-only.
  float camDist = length(uCam - vWorldPos);
  float fineFade = 1.0 - smoothstep(1.7, 2.6, camDist);
  // Sand-only granular material, evaluated in ONE uniform branch so marbles/boulders
  // never pay for the pseudo-3D FBM reprojection, the ×130/×420 speckle, the trickle,
  // or the glint (weak-tier melt used to run the full sand ALU for pixels it multiplies
  // by 0). Each augment stays 0 off-sand and sits at its ORIGINAL crust position, so
  // both the marble baseline and the sand output are byte-identical to before.
  float sp130Aug = 0.0;   // crust *= 1 + augment (0 ⇒ ×1 off-sand)
  float sp420Aug = 0.0;
  float trickleAug = 0.0;
  float glint = 0.0;
  if (uSandSurface > 0.5) {
    // Reproject the crust onto the 3D cone surface (two orthogonal world-space
    // projections → pseudo-3D) so its features follow the flank instead of
    // foreshortening into horizontal bands at grazing angles.
    vec3 wp3 = vWorldPos;
    cell = 0.5 * lqFbm(wp3.xz * 4.5 + drift) + 0.5 * lqFbm(wp3.zy * 4.5 + drift.yx);
    detail = 0.5 * lqFbm(wp3.xz * 16.0 + drift * 0.6) + 0.5 * lqFbm(wp3.zy * 16.0 + drift.yx * 0.6);
    // Fine granular SPECKLE (×130) + a finer camera-faded octave (×420) that breaks the
    // "wet concrete" read into grains as the camera nears.
    float sp130 = 0.5 * lqNoise(wp3.xz * 130.0) + 0.5 * lqNoise(wp3.zy * 130.0);
    float sp420 = 0.5 * lqNoise(wp3.xz * 420.0) + 0.5 * lqNoise(wp3.zy * 420.0);
    sp130Aug = (sp130 - 0.5) * 0.5;
    sp420Aug = (sp420 - 0.5) * 0.34 * fineFade;
    // Trickle streaks: darker sand flowing DOWN the flank (radially outward), sampled
    // in object space (no atan/uv seam). Slope-gated off at the crest tip and the foot,
    // gated by the eased stream-active scalar (dead once the pour quiets).
    vec2 radialDir = rr > 1e-4 ? vXz / rr : vec2(0.0);
    float streaks = lqNoise(radialDir * 14.0);
    float flow = lqFbm(vXz * 11.0 + radialDir * (rr * 2.0 + uTime * 2.2));
    float trickleNz = streaks * 0.6 + flow * 0.4;
    float trickleGate = smoothstep(0.04, 0.22, rr) * (1.0 - smoothstep(0.78, 1.0, rr));
    trickleAug = smoothstep(0.56, 0.82, trickleNz) * -0.15 * trickleGate * uStreamActive;
    // Micro-glint: sparse high-frequency sparkle where grains catch the key.
    glint = pow(0.5 * lqNoise(wp3.xz * 380.0) + 0.5 * lqNoise(wp3.zy * 380.0 + vec2(uTime * 0.2, 0.0)), 24.0);
  }
  // Marbling coordinate. The sand BED biases it toward the lower/mid palette
  // stops (pow 1.6 — a ramp-weight remap, never a hue injection: the Moon's grey
  // stops stay grey, Earth reads ocean-and-land not cloud-cream). Flag 0 = raw.
  float mBase = clamp(cell * 0.85 + detail * 0.15, 0.0, 1.0);
  float mCoord = mix(mBase, pow(mBase, 1.6), uSandSurface);
  // Bed reads as MATERIAL: gain up from ×0.38 so it's deep + saturated, not dishwater.
  vec3 crust = lqMeltPalette(mCoord) * mix(0.38, 0.62, uSandSurface);
  crust *= 0.85 + 0.3 * detail; // subtle luminance breakup
  crust *= 1.0 + sp130Aug;      // fine granular speckle (×1 off-sand)
  crust *= 1.0 + sp420Aug;      // close-range grains, camera-faded (×1 off-sand)
  // Impact churn: an animated ROIL where the stream/fallers meet the pool — a
  // noise-modulated brighten/darken MULTIPLY on the matte crust only (never the
  // HDR cracks), hard-capped strictly sub-bloom so the deleted glint blob can't
  // return through this door. Shared: sand stream (slot 0) + marble splashes (rotating
  // 1-3), so it stays OUTSIDE the sand branch. Sites are world xz (vXz·discR).
  float roil = 0.0;
  for (int i = 0; i < 4; i++) {
    if (uChurn[i].z >= 1.0) continue;
    float dch = distance(vXz * uSurfDiscR, uChurn[i].xy);
    float fall = 1.0 - smoothstep(0.0, ${CHURN_R.toFixed(3)}, dch);
    float nz = lqFbm(vXz * uSurfDiscR * 22.0 + uTime * 1.4) - 0.5;
    roil += nz * fall * (1.0 - uChurn[i].z) * uChurn[i].w;
  }
  crust *= 1.0 + clamp(roil, -0.4, 0.18);
  crust *= 1.0 + trickleAug;    // down-flank trickle, AFTER the roil (×1 off-sand)
  crust = min(crust, vec3(0.85)); // hard sub-bloom cap on the roiled matte crust
  // Cracks: thin, warm, HDR only while molten (uHeat scales the CRACKS, not the
  // whole surface). ~1.2–1.8 at full heat, near-off at rest. OFF on the sand bed
  // (sand never melts — no molten idioms on the material).
  vec3 crackGlow = vec3(1.0, 0.55, 0.2) * veins * (0.25 + 1.45 * uHeat) * (1.0 - uSandSurface);
  vec3 col = crust + crackGlow;
  // Melt-identity whisper (at rest only): a low-alpha band tint of the CONTAINER's
  // palette across the pool, so the resting surface still says which vessel it
  // fills. Gated hard off while molten (uHeat → 1 kills it, so the melt look is
  // untouched), for containers with no map (uContainerMix 0), AND on the sand bed
  // (uSandSurface 1 — the bed IS the filler's material; the container's identity
  // already lives on the glass ghost).
  float restId = (1.0 - smoothstep(0.16, 0.3, uHeat)) * uContainerMix * (1.0 - uSandSurface);
  float cBand = smoothstep(0.35, 0.65, lqNoise(vec2(vXz.y * 3.0, 1.7)));
  col = mix(col, mix(uContainerTint0, uContainerTint1, cBand), restId * 0.09);
  // Wet specular SHEEN — reads as molten LIQUID, not matte paint, but a broad
  // low-exponent lobe: the old pow-48 ×0.7 ping was the second tight blob on the
  // pool. Near-MATTE on the sand bed (a granular material, not liquid).
  vec3 Nfloor = normalize(vec3((detail - 0.5) * 0.55, 1.0, (cell - 0.5) * 0.55));
  // On the sand flank, light the ANALYTIC cone normal (the near-vertical procedural
  // normal above would light a 30° flank like a floor) with the micro-noise blended
  // around it for grain. mix on uSandSurface keeps the marble/boulder disc byte-identical.
  vec3 Nsand = normalize(vFlankN + vec3(detail - 0.5, 0.0, cell - 0.5) * ${SAND_N_ROUGH.toFixed(3)});
  vec3 N = mix(Nfloor, Nsand, uSandSurface);
  // Directional legibility floor: the flank/top lifts toward a legible presented
  // luminance in the filler's own hue (a dark-albedo heap stops reading black), the
  // top surface near-untouched where it is already lit. The flank normal carries the
  // direction so the lit shoulder travels and the far flank still reads.
  col = massFloorLift(col, N, uSunDir, ${MASS_FLOOR.toFixed(3)});
  vec3 V = normalize(uCam - vWorldPos);
  float spec = pow(max(dot(reflect(-uSunDir, N), V), 0.0), 10.0);
  col += vec3(1.0, 0.86, 0.62) * spec * mix(0.38, 0.05, uSandSurface); // sheen; near-matte on sand
  // Micro-glint (precomputed in the sand branch above): sparse high-frequency sparkle
  // where grains catch the key, camera-faded like the fine speckle and sub-bloom capped.
  // 0 for marbles/boulders (the branch was skipped).
  col += vec3(1.0, 0.95, 0.82) * glint * 0.16 * uSandSurface * fineFade;
  // A THIN meniscus at the glass wall — heat-gated: near-off at rest (a subtle
  // warm line, sub-bloom) and igniting over ~2 s to the molten target 2.0 as the
  // pool heats. fillerIsSun pins uHeat=1 so a Sun fill keeps the hot rim. GATED OFF
  // on the sand bed — dry sand doesn't wick up the glass (× (1 − uSandSurface); the
  // term is unchanged at flag 0).
  float meniscus = smoothstep(0.93, 0.985, rr) * (1.0 - smoothstep(0.985, 1.02, rr));
  col += vec3(1.0, 0.72, 0.32) * meniscus * mix(0.35, 2.0, smoothstep(0.15, 1.0, uHeat)) * (1.0 - uSandSurface);
  // Never let the heap read as a black silhouette if the procedural math NaNs on a
  // given GPU — fall back to a directionally-lit read of the filler's mid-tone. Light
  // the ANALYTIC flank normal (finite by construction), not the noise-derived N which
  // is itself NaN when the noise is the culprit.
  col = sanitizeMass(col, massFloorLift(lqMeltPalette(0.5), vFlankN, uSunDir, ${MASS_FLOOR.toFixed(3)}));
  gl_FragColor = vec4(col, 0.97);
}
`;

interface LiquidUniforms {
  uHeat: { value: number };
  uTime: { value: number };
  uSurfaceY: { value: number };
  uPalette0: { value: THREE.Color };
  uPalette1: { value: THREE.Color };
  uPalette2: { value: THREE.Color };
  uPalette3: { value: THREE.Color };
  uMeltPalette0: { value: THREE.Color };
  uMeltPalette1: { value: THREE.Color };
  uMeltPalette2: { value: THREE.Color };
  uMeltPalette3: { value: THREE.Color };
  uCam: { value: THREE.Vector3 };
  uSunDir: { value: THREE.Vector3 };
  uContainerTint0: { value: THREE.Color };
  uContainerTint1: { value: THREE.Color };
  uContainerMix: { value: number };
  uSandSurface: { value: number };
  uSurfDiscR: { value: number };
  uPeakH: { value: number };
  uStreamActive: { value: number };
  uHeapSeed: { value: THREE.Vector2 };
  uChurn: { value: THREE.Vector4[] };
}

// --- ripple shader (pooled additive splash quads) --------------------------
const RIPPLE_VERTEX = /* glsl */ `
attribute float aAge;   // seconds since spawn (>= life = dead)
attribute vec3 aCenter; // splash centre, studio units
varying vec2 vUv;
varying float vLife;
void main(){
  vUv = uv;
  vLife = clamp(aAge / ${RIPPLE_LIFE.toFixed(3)}, 0.0, 1.0);
  float r = ${RIPPLE_MAX_R.toFixed(3)} * vLife;
  // Billboard the quad around its centre (camera-facing), growing with age.
  vec3 right = vec3(modelViewMatrix[0][0], modelViewMatrix[1][0], modelViewMatrix[2][0]);
  vec3 up    = vec3(modelViewMatrix[0][1], modelViewMatrix[1][1], modelViewMatrix[2][1]);
  vec3 world = aCenter + (right * position.x + up * position.y) * r;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
}
`;

const RIPPLE_FRAGMENT = /* glsl */ `
varying vec2 vUv;
varying float vLife;
void main(){
  if (vLife >= 1.0) discard;
  float d = length(vUv - 0.5) * 2.0; // 0 centre → 1 edge
  // A soft splash burst — a warm glow that flashes on impact and fades out (NOT
  // an outlined ring, which read as a flat debug circle). Bright core, soft edge.
  float glow = (1.0 - smoothstep(0.0, 0.9, d));
  float fade = (1.0 - vLife) * smoothstep(0.0, 0.15, vLife); // quick rise, slow fall
  gl_FragColor = vec4(vec3(1.0, 0.8, 0.45) * glow * fade * 1.1, glow * fade * 0.8);
}
`;

// --- sand-grain shader (lit sphere-impostors on one Points object) ---------
// Each grain is a camera-facing point sprite lit as a tiny sphere: the normal is
// reconstructed from gl_PointCoord, lambert against the studio key with a small
// ambient floor, per-grain colour sampled from the filler palette. Perspective
// size attenuation with a ≥1px·dpr floor (starfield idiom); a velocity streak by
// squashing the impostor ACROSS its screen-space motion axis (point sprites can't
// elongate the quad, so the lit disc is compressed across the motion to read as a
// stroke ALONG it); age fade in/out. Output stays below the 0.92 bloom threshold.
const GRAIN_VERTEX = /* glsl */ `
uniform float uPixelRatio;  // devicePixelRatio (the ≥1px floor is this many device px)
uniform float uViewportH;   // drawing-buffer height, px
uniform float uStretchK;    // velocity → streak gain
attribute vec3 aVel;        // studio-units/s (drives the streak axis + amount)
attribute vec3 aColor;      // per-grain palette colour
attribute float aAge;       // seconds since spawn
attribute float aLife;      // total lifetime (dead when aAge >= aLife)
attribute float aSize;      // base studio radius
varying vec3 vColor;
varying float vFade;
varying vec2 vStretchDir;   // screen-space motion axis (unit)
varying float vStretch;     // 0 round → up, streaked
void main() {
  vColor = aColor;
  float lifeT = aLife > 0.0 ? clamp(aAge / aLife, 0.0, 1.0) : 1.0;
  float fadeIn = smoothstep(0.0, 0.06, lifeT);
  float fadeOut = 1.0 - smoothstep(0.72, 1.0, lifeT);
  vFade = fadeIn * fadeOut;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  float dist = max(-mvPosition.z, 0.001);
  // world diameter → framebuffer px (P[1][1] = 1/tan(fovY/2)); floor at 1 device px.
  float px = projectionMatrix[1][1] * aSize * uViewportH / dist;
  float dead = aAge >= aLife ? 0.0 : 1.0;
  gl_PointSize = max(uPixelRatio, px) * dead;
  // Screen-space motion axis: project a small step along the velocity and take
  // the NDC delta from the grain's own NDC position.
  vec4 aheadClip = projectionMatrix * modelViewMatrix * vec4(position + aVel * 0.01, 1.0);
  vec2 pNdc = gl_Position.xy / max(gl_Position.w, 1e-4);
  vec2 aNdc = aheadClip.xy / max(aheadClip.w, 1e-4);
  vec2 mo = aNdc - pNdc;
  float mlen = length(mo);
  vStretchDir = mlen > 1e-5 ? mo / mlen : vec2(0.0, 1.0);
  vStretch = clamp(mlen * uStretchK, 0.0, 0.6);
}
`;

const GRAIN_FRAGMENT = /* glsl */ `
uniform vec3 uKeyDirView;   // key light direction in VIEW space (impostor normals are view-space)
uniform float uAmbient;     // night-floor fraction so a grain is never a black speck
varying vec3 vColor;
varying float vFade;
varying vec2 vStretchDir;
varying float vStretch;
void main() {
  if (vFade <= 0.001) discard;
  vec2 c = gl_PointCoord * 2.0 - 1.0; // [-1,1] across the sprite
  // Squash ACROSS the motion axis so the lit disc reads as a streak along it.
  float along = dot(c, vStretchDir);
  vec2 perp = c - along * vStretchDir;
  vec2 cs = along * vStretchDir + perp * (1.0 + vStretch * 5.0);
  float r2 = dot(cs, cs);
  if (r2 > 1.0) discard;
  vec3 N = vec3(cs, sqrt(max(0.0, 1.0 - r2))); // sphere-impostor normal (view space)
  // Half-lambert wrap: a 2 px dot is mostly grazing normals, so a straight N·L
  // lands nearly all-dark — wrapping lifts the terminator so the grain reads as a
  // lit little body (the spill grains sit outside the glass in full key light).
  float wrap = dot(N, uKeyDirView) * 0.5 + 0.5;
  vec3 lit = vColor * (uAmbient + (1.0 - uAmbient) * wrap * wrap);
  // Never let a grain vanish to a NaN speck if the view-space key dir goes non-finite
  // on a given GPU — fall back to the flat ambient-lit grain colour (a grain is always
  // a lit little body, never a black hole).
  if (!(lit.x == lit.x && lit.y == lit.y && lit.z == lit.z)) lit = vColor * uAmbient;
  gl_FragColor = vec4(lit, vFade); // NormalBlending, toneMapped — stays sub-bloom
}
`;

interface GrainUniforms {
  uPixelRatio: { value: number };
  uViewportH: { value: number };
  uStretchK: { value: number };
  uKeyDirView: { value: THREE.Vector3 };
  uAmbient: { value: number };
}

// --- boulder shader (a slumping molten planet on the glass top) ------------
// The boulder reads as the filler planet — its colour map, key-lit with a night
// floor — with a molten front that climbs from the bottom pole as it melts: the
// texture bleeds toward the liquid palette below the front, glowing warm.
const BOULDER_VERTEX = /* glsl */ `
varying vec2 vUv;
varying vec3 vNormalW;
varying float vObjY;
void main(){
  vUv = uv;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vObjY = position.y; // -1..1 on the unit sphere
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const BOULDER_FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uSunDir;
uniform vec3 uMoltenLo;   // liquid palette low stop (the cooled crust below the front)
uniform float uMeltFront; // object-y of the molten front: -1.3 (off) climbing to +1 (all melted)
uniform float uEmber;     // 1 for the Sun boulder (emissive, no map lighting)
uniform float uLodBias;   // mip bias: 0 normally; negative on the sub-unity loom, where limb
                          // UV foreshortening over-minifies (a tiny map patch stretched huge)
uniform float uTime;
varying vec2 vUv;
varying vec3 vNormalW;
varying float vObjY;
// mod 2*pi before the sine: identity (sine is 2*pi-periodic) but it bounds the
// argument, so an Apple Metal fast-math sine can't return NaN for a large arg and
// poison the granulation (framebuffer clamps NaN to black).
float bHash(vec2 p){
  float a = mod(dot(p, vec2(127.1, 311.7)), 6.2831853071795864);
  return fract(sin(a) * 43758.5453);
}
float bNoise(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(bHash(i),bHash(i+vec2(1,0)),f.x), mix(bHash(i+vec2(0,1)),bHash(i+vec2(1,1)),f.x), f.y); }
float bFbm(vec2 p){ float v=0.0,a=0.5; for(int i=0;i<4;i++){ v+=a*bNoise(p); p*=2.0; a*=0.5; } return v; }
void main(){
  vec3 base = texture2D(uMap, vUv, uLodBias).rgb;
  float ndl = max(dot(normalize(vNormalW), uSunDir), 0.0);
  // Sun as filler (no map): a genuinely EMISSIVE body — warm, corona-adjacent,
  // fbm-granulated so it reads as the Sun, HDR toward bloom so it GLOWS instead of
  // the old flat ×1.4 (which rendered the map-less Sun black). uEmber doubles as
  // the per-context intensity: a small melt boulder blooms brighter (1.6) than the
  // enormous sub-unity giant (0.95), which must not white out the frame.
  if (uEmber > 0.5) {
    float g1 = bFbm(vUv * 6.0 + vec2(uTime * 0.05, -uTime * 0.04));
    float g2 = bFbm(vUv * 18.0 - uTime * 0.06);
    vec3 warm = mix(vec3(0.80, 0.26, 0.05), vec3(1.0, 0.74, 0.32), g1);
    warm += vec3(0.18, 0.06, 0.0) * g2; // brighter granulation flecks
    gl_FragColor = vec4(warm * uEmber, 1.0);
    return;
  }
  // Saturn's real texture, key-lit with a dim starlight night floor.
  vec3 lit = base * (0.08 + 0.92 * ndl);
  // The melt is a BAND at the front, not a plasma wash. Above the front the
  // texture stays readable (warmed near the band); in the band, glowing cracks;
  // below, the ball is consumed to a dark cooled crust.
  float d = vObjY - uMeltFront;                    // >0 above the front, <0 below
  float belowFront = 1.0 - smoothstep(0.0, 0.1, d);// 1 below → consumed crust
  float warmNear = smoothstep(0.28, 0.0, d) * (1.0 - belowFront); // just above the band
  float veins = smoothstep(0.60, 0.74, bFbm(vUv * 13.0 + uTime * 0.1));
  vec3 crust = uMoltenLo * 0.38;                   // dark consumed crust
  vec3 crackGlow = vec3(1.0, 0.55, 0.2) * veins * (belowFront * 1.2 + warmNear * 0.9);
  vec3 col = mix(lit, crust, belowFront);          // texture above → crust below
  col = mix(col, col * vec3(1.25, 1.02, 0.85), warmNear * 0.5); // warm the texture near the band
  col += crackGlow;                                // HDR cracks (the only bloom)
  gl_FragColor = vec4(col, 1.0);
}
`;

interface BoulderUniforms {
  uMap: { value: THREE.Texture | null };
  uSunDir: { value: THREE.Vector3 };
  uMoltenLo: { value: THREE.Color };
  uMeltFront: { value: number };
  uEmber: { value: number };
  uLodBias: { value: number };
  uTime: { value: number };
}

interface Boulder {
  /** Index into boulderPool / boulderUniforms. */
  slot: number;
  /** How much this boulder contributes to `melted` (1 for a full one, < 1 for the last). */
  volumeFrac: number;
  /** 'descend' → eased fall onto the glass top; 'melt' → slump + molten bleed. */
  state: 'descend' | 'melt';
  /** descend: 0..1 progress; melt: seconds elapsed. */
  t: number;
  /** Seconds this boulder's melt takes (scales with N). */
  meltWindow: number;
  /** 0..volumeFrac transferred to the liquid so far. */
  meltedFrac: number;
  /** Studio radius of this boulder (the true relative filler scale). */
  radius: number;
  /** Rest-centre height on the glass top. */
  restY: number;
}

/** A display-owned marble-rain arrival: falls from the spout, contacts the
 *  pool/pile, splashes, then sinks. Never a solver body (accounting is 1:1 with
 *  poured; melted++ fires at contact). */
interface Faller {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  qx: number; qy: number; qz: number; qw: number; // orientation (tumble)
  wx: number; wy: number; wz: number; // angular velocity
  r: number; // studio radius (the pair's ball radius at spawn)
  sinking: boolean;
  sinkAge: number;
  contactY: number; // the plane it landed on (pool surface or axial pile top)
}

interface GhostLoad {
  tex: THREE.Texture;
  gain: number;
  meanLum: number;
  /** The container map's 4-stop palette — two mid stops become the at-rest
   *  melt-identity bands (sampled in the same readback as the gain). */
  palette: THREE.Color[];
}

interface GlassUniforms {
  uCam: { value: THREE.Vector3 };
  uWarmTint: { value: THREE.Color };
  uCatalogTint: { value: THREE.Color };
  uGhostMap: { value: THREE.Texture | null };
  uHasGhost: { value: number };
  uGhostGain: { value: number };
  uGhostKnee: { value: number };
  uMouthPlaneY: { value: number };
  /** 0 closed sphere → 1 irised open (eased during a pour). */
  uMouthOpen: { value: number };
  uDim: { value: number };
  /** 1 presented; held 0 through a pair load, eased 0→1 on reveal (no wrong-map flash). */
  uReveal: { value: number };
  /** 0..1 fill level — warms the rim tint as the liquid rises (glass reacts to contents). */
  uFill: { value: number };
  /** 1 in the sub-unity honest loom — lights the small vessel from the giant overhead. */
  uLoomLit: { value: number };
  /** 1 when the container is the Sun — granulates the ember dome (0 = byte-identical glass). */
  uContainerIsSun: { value: number };
  /** 1 while the vessel is empty, eased to 0 early in the pour — the cold-open ghost fill. */
  uEmptyLift: { value: number };
  /** Seconds — drifts the Sun-dome ember granulation so the idle dome reads alive.
   *  Unused off the Sun-container ember branch, so it never touches other pairs. */
  uTime: { value: number };
}

/** Per-frame commands the mode hands the scene's sim (phase-derived). */
export interface PourControl {
  /** Live-ball goal the spawner chases (already drain-clamped at the melted floor). */
  targetCount: number;
  /** Whether the spout is streaming (the scene tapers the rate internally). */
  spawnEnabled: boolean;
  /** Bottom-up melt rate, balls/sec (0 = off). */
  meltRate: number;
  /** Arrivals consume on contact with the liquid surface (rain mode). */
  rainEnabled: boolean;
  /** Freeze the sim, the spawner, and the melt (physics holds where it is). */
  paused: boolean;
  /** The active regime (boulders run a scripted drop, never the solver). */
  regime: FillRegime;
}

/** What the scene reports back so the mode can run the phase machine + panel. */
export interface PourStatus {
  /** Odometer: balls poured so far. marbles/boulders: poured = live + melted.
   *  sand: poured = floor(melted), live = 0 — a display odometer, no rigid bodies. */
  poured: number;
  /** Balls melted into the liquid so far (drives the level). */
  melted: number;
  /** Live rigid balls in the pile. */
  live: number;
  /** Awake rigid balls (the physics work window). */
  awake: number;
  /** Fraction of live balls asleep (1 when the pile is empty). */
  asleepFrac: number;
  /** enteredCount·r³ / R³ — the admission ceiling gate reads this. */
  packingFraction: number;
  /** True while the pile sits at the admission ceiling (a brim signal). */
  atPackCeiling: boolean;
  /** True once a settled entered ball reaches the mouth plane (the chunky-band
   *  brim signal — the pile physically filled to the opening). */
  pileAtMouth: boolean;
  /** melted / N — 1.0 means the container's volume is full. */
  fillFraction: number;
  /** The rendered (eased) liquid surface height above the bottom pole, studio units. */
  liquidLevelY: number;
  /** For boulders: true once the last scripted drop has finished melting. */
  bouldersDone: boolean;
}

export class CompareScene {
  readonly group: THREE.Group;
  private scene: THREE.Scene;
  private renderer: THREE.WebGLRenderer;
  private capsCaptured = false;

  private keyLight: THREE.PointLight;
  private fillLight: THREE.HemisphereLight;
  private starfield: THREE.Points;

  // Glass: two shells over one shared uniform block.
  private glassUniforms: GlassUniforms;
  private backShell: THREE.Mesh;
  private frontShell: THREE.Mesh;
  private glassGeo: THREE.SphereGeometry;
  private backMat: THREE.ShaderMaterial;
  private frontMat: THREE.ShaderMaterial;

  // Instanced fillers.
  private fillerGeo: THREE.SphereGeometry;
  private fillerMesh: THREE.InstancedMesh;
  private fillerMap: THREE.Texture | null = null;
  private ballRadius = 0.1;
  // The live mouth plane (2 = vessel whole). The glass discard threshold irises
  // between "closed sphere" and this plane via uMouthOpen.
  private mouthPlaneY = 2;
  private mouthOpen = 0; // eased 0 (closed sphere) → 1 (irised open) during a pour
  private mouthOpenHold = 0; // debounce timer keeping the iris open across the active arc

  // Held, VC-owned textures for the current pair (disposed on swap + dispose()).
  private ghostTex: THREE.Texture | null = null;
  private emptyTex: THREE.Texture; // 1×1 default so the ghost sampler is always bound
  private atmosphere: THREE.Mesh | null = null;

  // Presentation reveal: the vessel (glass shells + atmosphere halo) is held hidden
  // through the async pair load and eased in only once the pair is fully applied, so
  // a swap never flashes the outgoing map on the new vessel and a cold load never
  // shows a ghost-less or halo-less shell. 1 = fully presented (steady state).
  private revealEase = 1;
  private revealTarget = 1;
  // The cold-open empty lift's temporal ease (target = the occupancy curve). A
  // boulder commits its whole volume fraction at spawn, so without this the ghost
  // dim would step in a single frame; starts at 1 = the empty cold-open state.
  private emptyLiftEase = 1;

  // Scratch (no per-call allocation).
  private scratchMatrix = new THREE.Matrix4();
  private scratchPos = new THREE.Vector3();
  private scratchQuat = new THREE.Quaternion();
  private scratchScale = new THREE.Vector3();
  private scratchVec2 = new THREE.Vector2();

  // --- the pour (solver + sim counters) ---
  private solver: SpherePhysics;
  private rng: () => number = mulberry32(SCATTER_SEED);
  private poured = 0; // odometer. marbles/boulders: live + melted. sand: floor(melted), live = 0 (display odometer, no rigid bodies)
  private melted = 0; // balls turned to liquid
  private simN = 1; // the live comparison's ratio (fillFraction denominator)
  private across = 1; // balls-across (pour rate + in-flight cap scale with it)
  private solverMouthPlaneY = 2; // the solver bowl's mouth plane (pile-at-mouth brim signal)
  private fillerIsSun = false; // Sun liquid is emissive throughout (uHeat pinned)
  private sandRegime = false; // sand runs no rigid solver — skip its reconfigure + preview
  private fillerTint = 0x888888; // the filler's catalog colour (slider track + ghost line)
  // Spawn caps for the marble solver — the awake window bounds the physics work,
  // the live cap bounds the pile. Scaled down at ≤640px via setCapScale so phones
  // get a lighter sim (mobileCapScale). Captured once when the mode activates.
  private spawnCaps: SpawnCaps = {
    total: COMPARE_TUNABLES.marbleTotalCap,
    awake: COMPARE_TUNABLES.awakeCap,
  };
  private subUnityRf = 1; // the rendered sub-unity filler radius (capped; the mode frames to it)
  private subUnityFillerY = 1; // the wedged filler's centre height (the mode frames + guards to it)
  private spoutFlow = 0; // 0..1 tapered spout throughput
  private pourCarry = 0; // fractional-spawn carry across frames
  private meltCarry = 0; // fractional-melt carry across frames
  // Removal out-params (indices are recycled after a swap-remove; read positions).
  private removedIdx = new Int32Array(INSTANCE_CAPACITY);
  private removedPos = new Float32Array(INSTANCE_CAPACITY * 3);
  // Reused per-frame status (the mode reads it within the same frame and never
  // retains it across frames), so buildStatus allocates nothing.
  private statusScratch: PourStatus = {
    poured: 0, melted: 0, live: 0, awake: 0, asleepFrac: 1, packingFraction: 0,
    atPackCeiling: false, pileAtMouth: false, fillFraction: 0, liquidLevelY: 0,
    bouldersDone: false,
  };

  // --- liquid (molten planet) ---
  private liquidLevelRendered = 0; // eased surface height above the bottom pole
  private liquidUniforms: LiquidUniforms;
  private liquidBody: THREE.Mesh;
  private liquidDisc: THREE.Mesh;
  private liquidGeo: THREE.SphereGeometry;
  // Two disc objects, swapped per regime in configurePour: marbles/boulders keep the
  // exact coarse fan (flag-0 rasterization untouched by construction); sand gets a
  // dense disc (rings biased toward the foot and tip) so the tall repose cone reads
  // smooth, not faceted.
  private marbleDiscGeo: THREE.BufferGeometry;
  private sandDiscGeo: THREE.BufferGeometry;
  private liquidTime = 0;
  private timeFrozen = false; // DEV/QA: hold liquidTime so animated content poses for pixel-diffs

  // --- ghost fill line + scale preview ---
  private ghostLine: THREE.LineLoop;
  private ghostLineMat: THREE.LineBasicMaterial;
  // The preview shares the live filler material (reassigned in applyFiller); no
  // second material to own or dispose.
  private previewMesh: THREE.Mesh;
  private previewOpacity = 0; // eased 0..1 presence
  private ghostTargetFraction = 0; // volume fraction the ghost ring previews (0 = hidden)
  private ghostLineOpacity = 0;

  // --- ripples (pooled additive quads) ---
  private ripples: THREE.Mesh;
  private rippleMat: THREE.ShaderMaterial;
  private rippleCursor = 0;

  // --- sand grains (the pour stream + the overflow spill; one Points pool) ---
  private grains: THREE.Points;
  private grainGeo: THREE.BufferGeometry;
  private grainMat: THREE.ShaderMaterial;
  private grainUniforms: GrainUniforms;
  // Attribute-array views (mutated in place, needsUpdate each frame): position,
  // velocity, colour, age, life, size. A grain is dead when aAge >= aLife.
  private gPos!: Float32Array;
  private gVel!: Float32Array;
  private gColor!: Float32Array;
  private gAge!: Float32Array;
  private gLife!: Float32Array;
  private gSize!: Float32Array;
  // 0 = stream (falls, dies at the surface); 1 = spill (OUTSIDE — arcs over the
  // shoulder); 2 = plume (INSIDE — the impact splash at the pool contact). Stream +
  // plume are "inside the vessel" and hold the mouth iris open; spill never does.
  private gKind!: Uint8Array;
  // Native-saturation fleck colours from the filler map — each grain takes one
  // whole (un-averaged) so the stream reads speckled, not milky.
  private grainFlecks: THREE.Color[] = defaultPalette();
  private grainColorScratch = new THREE.Color();
  // A dedicated RNG so grain jitter never perturbs the solver's seeded stream
  // (marble QA layouts stay reproducible).
  private grainRng: () => number = mulberry32(0x5a4d);
  private grainCursor = 0; // round-robin allocation into the stream slot range
  private grainBudget = GRAIN_CAPACITY; // live cap for this device tier (sandGrainBudget)
  private grainLiveCount = 0; // grains alive this frame (grainsLive() QA + pool visibility)
  private insideGrainLiveCount = 0; // live INSIDE grains (stream + plume) — the iris hold; excludes the outside spill
  private streamCarry = 0; // fractional stream-spawn carry across frames
  private runoffCarry = 0; // fractional boulder-melt-runoff-spawn carry
  private plumeRippleT = 0; // countdown to the next throttled contact-flash ripple
  private mouthRadiusStudio = 0.14; // the current pair's glass opening radius (stream spread)
  // Spill emission: a bounded garnish at top-out — SPILL_COUNT grains over
  // SPILL_EMIT_S, generation-guarded so a reset/commit mid-spill cancels it.
  private spillActive = false;
  private spillElapsed = 0;
  private spillEmitted = 0;
  private spillCarry = 0;
  private spillCursor = 0; // round-robin allocation into the spill/plume slot range
  // Sand fill ramp (never the solver): melted = simN·(start + (target−start)·p),
  // p = sandFillFraction(elapsed, duration). Re-anchored on each fresh pour so a
  // raised target keeps the same fractional rate.
  private sandStartFrac = 0;
  private sandTargetFrac = 0;
  private sandElapsed = 0;
  private sandDuration = 0;
  private sandFillActive = false;
  // The sand heap, a PURE function of poured volume (heapSplit): the settled-bulk
  // fill height and the repose cone that rides on it. 0 for marbles/boulders
  // (uSandSurface gates the cone off in the shader; the CPU kill plane reads
  // heapHeightAt(rr, 0) = 0). No easing — the ramp is already smooth, so the heap
  // holds bit-stable when V freezes (pause / slider-down).
  private heapBulkH = 0;
  private heapPeakH = 0;
  // Eased 0..1 stream-active scalar (τ≈0.4 s): drives the down-flank trickle so it
  // fades in/out with the pour rather than snapping. 0 for marbles/boulders.
  private streamActive = 0;

  // --- boulders (scripted, never the solver) + drain shrink-out ---
  private boulderGeo!: THREE.SphereGeometry;
  private boulders: Boulder[] = [];
  private boulderPool: THREE.Mesh[] = [];
  private boulderUniforms: BoulderUniforms[] = [];
  private boulderTarget = 0; // melted-volume goal for the boulder script
  private boulderCommitted = 0; // total volumeFrac assigned to boulders so far
  // Popped-ball scale-outs: rendered as instanced slots ABOVE the live count so
  // no extra mesh is needed; each shrinks 1→0 over DRAIN_SHRINK_S then drops.
  private drainShrink: { x: number; y: number; z: number; r: number; age: number }[] = [];

  // --- marble rain fallers (display-owned) + impact churn ---
  // During `raining` each arrival is a Faller (falls, splashes, sinks) — never a
  // solver body. Rendered into fillerMesh after the solver balls + drain tail.
  private fallers: Faller[] = [];
  private churnCursor = 1; // rotating marble-splash churn slots (1-3); slot 0 = sand stream

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.group = new THREE.Group();
    this.group.name = 'VolumeCompareRoot';
    this.group.visible = false;

    // Key light — inside the group so it can never leak into the other modes.
    this.keyLight = new THREE.PointLight(KEY_LIGHT_COLOR, KEY_LIGHT_INTENSITY, 0, 0.5);
    this.keyLight.position.copy(KEY_LIGHT_DIR).multiplyScalar(KEY_LIGHT_DISTANCE);
    this.group.add(this.keyLight);

    // Studio fill — a museum display case, not deep space. A hemisphere light in
    // the group lifts the fillers' night sides to a readable ~0.3 of day (an
    // Earth marble reads blue/green from any angle, never a black ball). It is
    // scoped to the fillers alone: the glass / liquid / boulders are
    // ShaderMaterials that ignore scene lights, and group.visible gates it off in
    // the other modes.
    this.fillLight = new THREE.HemisphereLight(FILL_SKY_COLOR, FILL_GROUND_COLOR, FILL_HEMI_INTENSITY);
    this.group.add(this.fillLight);

    // Dimmed starfield backdrop (VC owns this instance; scaling the colour buffer
    // dims it without touching the shared factory).
    this.starfield = createPlanetariumStarfield(this.renderer.getPixelRatio());
    dimStarfield(this.starfield, STARFIELD_DIM);
    this.group.add(this.starfield);

    // 1×1 default texture so the ghost sampler is always bound (Sun has no map).
    this.emptyTex = makeEmptyTexture();

    // Glass shells — shared uniform block; only uBackShell differs per material.
    this.glassUniforms = {
      uCam: { value: new THREE.Vector3() },
      uWarmTint: { value: WARM_TINT.clone() },
      uCatalogTint: { value: new THREE.Color(0xffffff) },
      uGhostMap: { value: this.emptyTex },
      uHasGhost: { value: 0 },
      uGhostGain: { value: 1 },
      uGhostKnee: { value: 1 },
      uMouthPlaneY: { value: 0.93 },
      uMouthOpen: { value: 0 },
      uDim: { value: 1 },
      uReveal: { value: 1 },
      uFill: { value: 0 },
      uLoomLit: { value: 0 },
      uContainerIsSun: { value: 0 },
      uEmptyLift: { value: 0 },
      uTime: { value: 0 },
    };
    this.glassGeo = new THREE.SphereGeometry(CONTAINER_R, 64, 32);
    this.backMat = this.makeGlassMaterial(THREE.BackSide, 1);
    this.frontMat = this.makeGlassMaterial(THREE.FrontSide, 0);
    this.backShell = new THREE.Mesh(this.glassGeo, this.backMat);
    this.backShell.renderOrder = 1;
    this.frontShell = new THREE.Mesh(this.glassGeo, this.frontMat);
    this.frontShell.renderOrder = 3;
    this.group.add(this.backShell, this.frontShell);

    // Instanced fillers — capacity fixed, all matrices zero-scale so unwritten
    // slots never render an identity ball at the origin.
    this.fillerGeo = new THREE.SphereGeometry(1, FILLER_SEGMENTS_W, FILLER_SEGMENTS_H);
    const placeholder = this.makeFillerMaterial('Earth'); // replaced on first pair
    this.fillerMesh = new THREE.InstancedMesh(this.fillerGeo, placeholder, INSTANCE_CAPACITY);
    this.fillerMesh.count = 0;
    this.fillerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.fillerMesh.frustumCulled = false;
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < INSTANCE_CAPACITY; i++) this.fillerMesh.setMatrixAt(i, zero);
    this.fillerMesh.instanceMatrix.needsUpdate = true;
    this.group.add(this.fillerMesh);

    // The solver — capacity fixed at INSTANCE_CAPACITY; radius + bowl are reset
    // per pair in configurePour. Bowl a hair inside the glass. Seeded RNG so a
    // pour is reproducible for QA.
    this.solver = new SpherePhysics(
      { ...defaultPhysicsParams(this.ballRadius, INSTANCE_CAPACITY), containerR: SOLVER_R },
      this.rng,
    );

    // Liquid (molten planet): the interior body renders opaque + depthWrite on
    // (watertight below the surface); the surface disc renders transparent
    // between the shells (renderOrder 2). Both share one uniform block.
    this.liquidUniforms = {
      uHeat: { value: 0.15 },
      uTime: { value: 0 },
      uSurfaceY: { value: -R_LIQ },
      uPalette0: { value: new THREE.Color(0x1a2740) },
      uPalette1: { value: new THREE.Color(0x3a5a86) },
      uPalette2: { value: new THREE.Color(0x9fb6c8) },
      uPalette3: { value: new THREE.Color(0xf2f4f0) },
      uMeltPalette0: { value: new THREE.Color(0x1a2740) },
      uMeltPalette1: { value: new THREE.Color(0x3a5a86) },
      uMeltPalette2: { value: new THREE.Color(0x9fb6c8) },
      uMeltPalette3: { value: new THREE.Color(0xf2f4f0) },
      uCam: { value: new THREE.Vector3() },
      uSunDir: { value: KEY_LIGHT_DIR.clone() },
      uContainerTint0: { value: new THREE.Color(0x888888) },
      uContainerTint1: { value: new THREE.Color(0xbbbbbb) },
      uContainerMix: { value: 0 },
      uSandSurface: { value: 0 },
      uSurfDiscR: { value: R_LIQ },
      uPeakH: { value: 0 },
      uStreamActive: { value: 0 },
      uHeapSeed: { value: new THREE.Vector2(0, 0) },
      uChurn: { value: [new THREE.Vector4(0, 0, 1, 0), new THREE.Vector4(0, 0, 1, 0), new THREE.Vector4(0, 0, 1, 0), new THREE.Vector4(0, 0, 1, 0)] },
    };
    this.liquidGeo = new THREE.SphereGeometry(R_LIQ, 48, 32);
    this.liquidBody = new THREE.Mesh(this.liquidGeo, this.makeLiquidBodyMaterial());
    this.liquidBody.renderOrder = 0; // opaque queue anyway; explicit for clarity
    this.liquidBody.visible = false;
    // Two radially re-tessellated unit discs (concentric rings, NOT a fan) so the
    // surface displaces smoothly in the vertex shader. vXz stays object-space unit
    // xy; scaled to the cap radius per frame. The coarse fan is the marble/boulder
    // disc (kept byte-identical); the dense disc carries the sand repose cone. The
    // mesh starts on the marble disc; configurePour swaps it for sand.
    this.marbleDiscGeo = makeRadialDiscGeometry(14, 48);
    this.sandDiscGeo = makeSandDiscGeometry(56, 120);
    this.liquidDisc = new THREE.Mesh(this.marbleDiscGeo, this.makeLiquidDiscMaterial());
    this.liquidDisc.rotation.x = -Math.PI / 2; // lie flat (xz plane)
    this.liquidDisc.renderOrder = 2; // between the back (1) and front (3) shells
    this.liquidDisc.visible = false;
    this.group.add(this.liquidBody, this.liquidDisc);

    // Ghost fill line — a thin additive ring at the target level inside the glass.
    this.ghostLineMat = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.ghostLine = new THREE.LineLoop(makeRingGeometry(64), this.ghostLineMat);
    this.ghostLine.renderOrder = 2;
    this.ghostLine.visible = false;
    this.group.add(this.ghostLine);

    // Scale preview — one filler parked beside the vessel; it shares the live
    // filler material (applyFiller reassigns it), so nothing extra to dispose.
    this.previewMesh = new THREE.Mesh(this.fillerGeo, this.fillerMesh.material);
    this.previewMesh.visible = false;
    this.group.add(this.previewMesh);

    // Ripple pool — additive quads billboarded + grown in the shader by age.
    const { mesh, mat } = makeRipplePool();
    this.ripples = mesh;
    this.rippleMat = mat;
    this.ripples.renderOrder = 4; // over the front shell, additive splash
    this.group.add(this.ripples);

    // Sand-grain pool — one Points object, allocated once at full capacity and
    // disposed once (ripple-pool precedent). Dead by default (aAge ≥ aLife → 0 px).
    this.grainUniforms = {
      uPixelRatio: { value: 1 },
      uViewportH: { value: 1080 },
      uStretchK: { value: 44 },
      uKeyDirView: { value: new THREE.Vector3(0, 0, 1) },
      uAmbient: { value: 0.46 }, // night-floor so grains stay legible over the dark pool
    };
    this.grainGeo = new THREE.BufferGeometry();
    this.gPos = new Float32Array(GRAIN_CAPACITY * 3);
    this.gVel = new Float32Array(GRAIN_CAPACITY * 3);
    this.gColor = new Float32Array(GRAIN_CAPACITY * 3);
    this.gAge = new Float32Array(GRAIN_CAPACITY).fill(1);
    this.gLife = new Float32Array(GRAIN_CAPACITY).fill(1); // aAge==aLife → dead
    this.gSize = new Float32Array(GRAIN_CAPACITY).fill(GRAIN_SIZE_MIN);
    this.gKind = new Uint8Array(GRAIN_CAPACITY);
    const dyn = THREE.DynamicDrawUsage;
    this.grainGeo.setAttribute('position', new THREE.BufferAttribute(this.gPos, 3).setUsage(dyn));
    this.grainGeo.setAttribute('aVel', new THREE.BufferAttribute(this.gVel, 3).setUsage(dyn));
    this.grainGeo.setAttribute('aColor', new THREE.BufferAttribute(this.gColor, 3).setUsage(dyn));
    this.grainGeo.setAttribute('aAge', new THREE.BufferAttribute(this.gAge, 1).setUsage(dyn));
    this.grainGeo.setAttribute('aLife', new THREE.BufferAttribute(this.gLife, 1).setUsage(dyn));
    this.grainGeo.setAttribute('aSize', new THREE.BufferAttribute(this.gSize, 1).setUsage(dyn));
    this.grainMat = new THREE.ShaderMaterial({
      uniforms: this.grainUniforms as unknown as Record<string, THREE.IUniform>,
      vertexShader: GRAIN_VERTEX,
      fragmentShader: GRAIN_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
    });
    this.grains = new THREE.Points(this.grainGeo, this.grainMat);
    this.grains.frustumCulled = false;
    this.grains.renderOrder = 0; // before the glass shells (1/3): the glass tints over the contents
    this.grains.visible = false;
    this.group.add(this.grains);

    // Boulder pool — up to 2 full-res slumping meshes (≤2 visible at once).
    this.boulderGeo = new THREE.SphereGeometry(1, 48, 32);
    for (let i = 0; i < 2; i++) {
      const u: BoulderUniforms = {
        uMap: { value: this.emptyTex },
        uSunDir: { value: KEY_LIGHT_DIR.clone() },
        uMoltenLo: { value: new THREE.Color(0x3a5a86) },
        uMeltFront: { value: -1.3 },
        uEmber: { value: 0 },
        uLodBias: { value: 0 },
        uTime: { value: 0 },
      };
      const bmat = new THREE.ShaderMaterial({
        uniforms: u as unknown as Record<string, THREE.IUniform>,
        vertexShader: BOULDER_VERTEX,
        fragmentShader: BOULDER_FRAGMENT,
      });
      const bmesh = new THREE.Mesh(this.boulderGeo, bmat);
      bmesh.visible = false;
      // Never frustum-cull: the sub-unity giant fills the frame at a true 40-400×
      // radius with its centre far off-screen; its auto bounding sphere can trip
      // the far-plane cull even while its underside would fill the view.
      bmesh.frustumCulled = false;
      this.boulderPool.push(bmesh);
      this.boulderUniforms.push(u);
      this.group.add(bmesh);
    }

    this.scene.add(this.group);
  }

  private makeLiquidBodyMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      uniforms: this.liquidUniforms as unknown as Record<string, THREE.IUniform>,
      vertexShader: LIQUID_BODY_VERTEX,
      fragmentShader: LIQUID_BODY_FRAGMENT,
      side: THREE.FrontSide,
      transparent: false,
      depthWrite: true,
    });
  }

  private makeLiquidDiscMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      uniforms: this.liquidUniforms as unknown as Record<string, THREE.IUniform>,
      vertexShader: LIQUID_DISC_VERTEX,
      fragmentShader: LIQUID_DISC_FRAGMENT,
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
    });
  }

  private makeGlassMaterial(side: THREE.Side, backShell: number): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      // Share the uniform-value wrappers so one update feeds both shells; only
      // uBackShell is per-material. Identical GLSL keeps one compiled program.
      uniforms: { ...this.glassUniforms, uBackShell: { value: backShell } },
      vertexShader: GLASS_VERTEX,
      fragmentShader: GLASS_FRAGMENT,
      transparent: true,
      depthWrite: false,
      side,
    });
  }

  private makeFillerMaterial(filler: string): THREE.MeshStandardMaterial {
    if (filler === 'Sun') {
      // A textureless hot body — never the map-less standard material (which
      // would render black); an emissive ember stands in for the Sun's map.
      return new THREE.MeshStandardMaterial({
        color: 0xff8a3a,
        emissive: new THREE.Color(0xff7a26),
        emissiveIntensity: 1.6,
        roughness: 1,
        metalness: 0,
      });
    }
    const mat = new THREE.MeshStandardMaterial({
      map: this.fillerMap ?? this.emptyTex,
      roughness: 0.95,
      metalness: 0,
    });
    const fx = augmentSurfaceMaterial(mat, fillerArchetype(filler));
    fx.uSunDirWorld.value.copy(KEY_LIGHT_DIR); // the one key light is the fillers' sun
    // The app's planetshine channel doubles as the studio fill: a faint
    // cool-neutral lift from the camera side so unlit hemispheres read as dim
    // worlds instead of holes in the pile. Mode-scoped — only VC's material.
    fx.uPlanetshineColor.value.setHex(FILL_SHINE_COLOR);
    fx.uPlanetshineDir.value.copy(FILL_SHINE_DIR);
    fx.uPlanetshineIntensity.value = FILL_SHINE_INTENSITY;
    // Pile legibility floor, layered AFTER the shared shading hook so it reads the
    // final lit radiance (see PILE_FLOOR). The wrapper text is identical for every
    // filler, so the default program cache key still shares one compiled program
    // across pairs (and differs from the Planetarium's hook-only materials).
    const augmentCompile = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader, renderer) => {
      augmentCompile(shader, renderer);
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <opaque_fragment>',
        `${PILE_FLOOR_FRAGMENT}\n#include <opaque_fragment>`,
      );
    };
    return mat;
  }

  /**
   * Load one body's colour texture (VC-owned; caller disposes). Sun resolves to
   * null (rendered textureless). Photo bodies stream their real map; procedural
   * moons synthesize theirs mesh-free.
   */
  private async loadBodyColor(name: string): Promise<THREE.Texture | null> {
    if (name === 'Sun') return null;
    const planet = PLANET_BY_NAME.get(name);
    const moon = MOON_BY_NAME.get(name);
    const textureKey = planet?.textureKey ?? moon?.textureKey;
    if (textureKey) {
      const texture = await loadTexture(textureKey);
      // TextureLoader's load event can precede a usable CPU decode on Safari.
      // PlanetFactory deliberately starts image.decode() fire-and-forget for GPU
      // warming, but VC immediately drawImage()s the same image to derive its
      // palette. Await the decode here, behind the pair-loading veil, so that
      // readback cannot silently return a zero-filled canvas on first entry.
      const image = texture.image as { decode?: () => Promise<void> } | undefined;
      if (image && typeof image.decode === 'function') {
        try { await image.decode(); } catch { /* sampleMapStats has a tinted fallback */ }
      }
      return texture;
    }
    if (moon) {
      const { colorTex, bumpTex } = createMoonTextures(moon.color, moon.name, moon.radiusKm);
      bumpTex.dispose(); // the glass ghost + filler map want colour only
      return colorTex;
    }
    return null;
  }

  private async loadGhost(name: string): Promise<GhostLoad | null> {
    const tex = await this.loadBodyColor(name);
    if (!tex) return null;
    const stats = sampleMapStats(tex.image as CanvasImageSource | null, bodyColor(name));
    const meanLum = stats.meanLum;
    const gain = THREE.MathUtils.clamp(
      GHOST_TARGET_LUM / Math.max(meanLum, 0.05),
      GHOST_GAIN_MIN,
      GHOST_GAIN_MAX,
    );
    return { tex, gain, meanLum, palette: stats.palette };
  }

  /** Measured mean luminance of the current ghost map (0 = no ghost); for the log. */
  private lastGhostMeanLum = 0;
  getGhostMeanLum(): number {
    return this.lastGhostMeanLum;
  }

  /** The live cold-open empty-lift value (1 empty → 0 early in the pour); QA probe. */
  getEmptyLift(): number {
    return this.glassUniforms.uEmptyLift.value;
  }

  /** DEV/QA only: hold the liquid/dome clock so animated content poses for pixel-diffs. */
  setTimeFrozen(on: boolean): void {
    this.timeFrozen = on;
  }

  /**
   * Load and apply a new pair's textures. Generation-guarded: the mode passes a
   * staleness check that is consulted after the async load — a stale resolve
   * disposes what it loaded and leaves the live scene untouched. On a fresh
   * resolve, new textures are assigned before the outgoing pair's are disposed,
   * so no frame ever samples freed memory.
   */
  async applyPair(comparison: Comparison, container: string, filler: string, isStale: () => boolean): Promise<void> {
    if (!this.capsCaptured) {
      captureDeviceTextureCaps(this.renderer);
      this.capsCaptured = true;
    }
    const [ghost, fillerTex] = await Promise.all([
      container === 'Sun' ? Promise.resolve(null) : this.loadGhost(container),
      filler === 'Sun' ? Promise.resolve(null) : this.loadBodyColor(filler),
    ]);
    if (isStale()) {
      ghost?.tex.dispose();
      fillerTex?.dispose();
      return;
    }
    this.applyGhost(container, ghost);
    this.applyFiller(filler, fillerTex);
    this.applyMouth(comparison);
    this.applyAtmosphere(container);
    this.configurePour(comparison, filler);
  }

  /**
   * Reconfigure the solver for a new pair's ball size and zero every sim +
   * liquid counter — the pour restarts clean. The chunky boulder band wants a
   * longer settle window (the standing recipe); marbles/sand keep the default.
   */
  private configurePour(comparison: Comparison, filler: string): void {
    this.simN = comparison.n;
    this.across = comparison.across;
    this.fillerIsSun = filler === 'Sun';
    this.sandRegime = comparison.regime === 'sand';
    this.solverMouthPlaneY = mouthGeometry(this.ballRadius, SOLVER_R).mouthPlaneY;
    // Sand runs NO rigid bodies — the stream is a particle garnish and its status
    // is a display odometer (updateSand builds it from the ramp, reading nothing
    // off the solver). Its ball radius is a thousandths-of-a-unit sliver that would
    // size the solver's spatial grid to billions of cells and throw, so skip BOTH
    // setParams AND reset for sand: nothing reads the solver in sand mode, and
    // fillerMesh.count stays 0 below so any leftover pile is invisible — the next
    // non-sand configurePour resets it. Marbles/boulders reconfigure + reset here.
    if (!this.sandRegime) {
      this.solver.setParams({
        radius: this.ballRadius,
        sleepFrames: comparison.across < COMPARE_TUNABLES.boulderMaxAcross + 1 ? 40 : 34,
      });
      this.solver.reset();
    }
    this.poured = 0;
    this.melted = 0;
    this.spoutFlow = 0;
    this.pourCarry = 0;
    this.meltCarry = 0;
    this.liquidLevelRendered = 0;
    this.previewOpacity = 0;
    this.fillerMesh.count = 0;
    // Hide BOTH boulder-pool meshes — they carry boulder drops AND the sub-unity
    // filler, so a leftover would linger when switching from a boulder/sub-unity
    // pair to a marble one. Drops / showSubUnity re-show what they need.
    for (const m of this.boulderPool) m.visible = false;
    this.boulders.length = 0;
    this.boulderCommitted = 0;
    this.drainShrink.length = 0;
    this.cancelTransients(); // grains + spill + plume carries/ripple + fallers + churn
    this.sandFillActive = false;
    this.sandStartFrac = 0;
    this.sandTargetFrac = 0;
    this.sandElapsed = 0;
    this.sandDuration = 0;
    // Sand bed material + heap: flag on only for the sand regime (marble/boulder
    // output stays byte-identical at uSandSurface 0). The dense sand disc swaps in
    // here; marbles/boulders keep the exact coarse fan object.
    this.liquidUniforms.uSandSurface.value = this.sandRegime ? 1 : 0;
    this.liquidDisc.geometry = this.sandRegime ? this.sandDiscGeo : this.marbleDiscGeo;
    // Frozen per-pour phase for the heap's azimuthal irregularity (so successive
    // pours differ but never wobble within a pour). Only the sand disc reads it, so
    // draw it ONLY for sand: a marble/boulder pair must not consume grainRng here or
    // its faller spawns, tumbles, and splash droplets shift off the shared sequence.
    // A stale seed left on a marble pair is harmless — nothing reads uHeapSeed unless
    // uSandSurface is 1, and the next sand pour reseeds it.
    if (this.sandRegime) {
      this.liquidUniforms.uHeapSeed.value.set(this.grainRng() * 100, this.grainRng() * 100);
    }
    // Normal framing lights the vessel with the shared key only; showSubUnity flips
    // this on for the honest loom (the giant lights the tiny vessel from overhead).
    this.glassUniforms.uLoomLit.value = 0;
    this.heapBulkH = 0;
    this.heapPeakH = 0;
    this.streamActive = 0;
    this.liquidUniforms.uPeakH.value = 0;
    this.liquidUniforms.uStreamActive.value = 0;
    // Sun as filler has no map to sample; its molten pool is a constant ember ramp
    // and stays emissive throughout (uHeat pinned in updateSim).
    this.liquidUniforms.uHeat.value = 0.15;
    this.fillerTint = bodyColor(filler);
    this.updateLiquidUniforms(0);
  }

  /** The filler's catalog tint (the slider track + ghost line read this). */
  fillerTintHex(): number {
    return this.fillerTint;
  }

  /** Scale the marble spawn caps (1 desktop, mobileCapScale on ≤640px phones). */
  setCapScale(scale: number): void {
    this.spawnCaps = {
      total: COMPARE_TUNABLES.marbleTotalCap * scale,
      awake: COMPARE_TUNABLES.awakeCap * scale,
    };
  }

  private applyGhost(container: string, ghost: GhostLoad | null): void {
    // Assign new before disposing old.
    const prev = this.ghostTex;
    if (ghost) {
      this.glassUniforms.uGhostMap.value = ghost.tex;
      this.glassUniforms.uHasGhost.value = 1;
      this.glassUniforms.uGhostGain.value = ghost.gain;
      // The knee lives in the shader's linear space; the mean is measured on
      // sRGB-encoded pixels, so convert the ceiling through the ~2.2 curve.
      this.glassUniforms.uGhostKnee.value =
        Math.pow(Math.min(GHOST_KNEE_X_MEAN * ghost.meanLum, 1), 2.2);
      this.ghostTex = ghost.tex;
      this.lastGhostMeanLum = ghost.meanLum;
      // Melt-identity bands: two mid container-palette stops read through the
      // AT-REST pool (the shader's uHeat gate keeps the molten look untouched).
      this.liquidUniforms.uContainerTint0.value.copy(ghost.palette[1]);
      this.liquidUniforms.uContainerTint1.value.copy(ghost.palette[2]);
      this.liquidUniforms.uContainerMix.value = 1;
    } else {
      // Sun (or a body with no map): warm-tinted glass, no ghost — and no
      // melt-identity tint (the molten pool stays pure).
      this.glassUniforms.uGhostMap.value = this.emptyTex;
      this.glassUniforms.uHasGhost.value = 0;
      this.ghostTex = null;
      this.lastGhostMeanLum = 0;
      this.liquidUniforms.uContainerMix.value = 0;
    }
    this.glassUniforms.uCatalogTint.value.setHex(bodyColor(container));
    // Granulate the ember dome only when the Sun is the container (the one ghost-less
    // vessel, in ANY regime). Set here with the container in hand; resetSession keeps
    // the same pair's value. 0 everywhere else ⇒ the glass fragment is byte-identical.
    this.glassUniforms.uContainerIsSun.value = container === 'Sun' ? 1 : 0;
    if (prev) prev.dispose();
  }

  private applyFiller(filler: string, fillerTex: THREE.Texture | null): void {
    const prevMat = this.fillerMesh.material as THREE.MeshStandardMaterial;
    const prevMap = this.fillerMap;
    this.fillerMap = fillerTex;
    // Build the new material while the old one still holds the shared program
    // alive, so the swap never frees + recompiles it.
    const mat = this.makeFillerMaterial(filler);
    this.fillerMesh.material = mat;
    this.previewMesh.material = mat; // the preview shares the live filler material
    // A pair change resets the pour — clear any scattered fillers.
    this.fillerMesh.count = 0;
    // Marbling palette + grain flecks: the liquid and the sand stream are the
    // filler's own colours. Sun has no map — an ember ramp; grains flecked in fire.
    let palette: THREE.Color[];
    if (filler === 'Sun') {
      palette = [new THREE.Color(0x2a0a02), new THREE.Color(0xb03408), new THREE.Color(0xff8a2a), new THREE.Color(0xfff0c0)];
      this.grainFlecks = [new THREE.Color(0x8a2a08), new THREE.Color(0xd05010), new THREE.Color(0xff8a2a), new THREE.Color(0xffd070)];
    } else {
      const stats = sampleMapStats(fillerTex?.image as CanvasImageSource | null, bodyColor(filler));
      palette = stats.palette;
      this.grainFlecks = stats.flecks;
    }
    this.liquidUniforms.uPalette0.value.copy(palette[0]);
    this.liquidUniforms.uPalette1.value.copy(palette[1]);
    this.liquidUniforms.uPalette2.value.copy(palette[2]);
    this.liquidUniforms.uPalette3.value.copy(palette[3]);
    // The melt's identity stops: catalog tint into the MIDS only (see
    // MELT_IDENTITY_BLEND). The Sun filler keeps its ember ramp untouched — the
    // ramp already IS its identity, and the ember pool look is frozen.
    const identityBlend = filler === 'Sun' ? 0 : MELT_IDENTITY_BLEND;
    const identity = new THREE.Color(bodyColor(filler));
    this.liquidUniforms.uMeltPalette0.value.copy(palette[0]);
    this.liquidUniforms.uMeltPalette1.value.copy(palette[1]).lerp(identity, identityBlend);
    this.liquidUniforms.uMeltPalette2.value.copy(palette[2]).lerp(identity, identityBlend);
    this.liquidUniforms.uMeltPalette3.value.copy(palette[3]);
    prevMat.dispose();
    if (prevMap) prevMap.dispose();
  }

  private applyMouth(comparison: Comparison): void {
    // The ball radius (and therefore the mouth) come from the live comparison,
    // via the same spherePhysics geometry the solver uses — never re-derived.
    this.ballRadius = 1 / comparison.across;
    // Boulders melt down from the glass top and never pour through a hole, so
    // their vessel stays whole. Sub-unity renders a display mouth the oversized
    // filler wedges into. Marbles cut the physics mouth.
    if (comparison.subUnity) {
      this.mouthPlaneY = SUBUNITY_MOUTH_PLANE_Y; // permanently open (the wedge sits in it)
    } else if (comparison.regime === 'boulders') {
      this.mouthPlaneY = 2; // no mouth — boulders melt on the closed vessel's top
    } else {
      const mouth = mouthGeometry(this.ballRadius, CONTAINER_R);
      this.mouthPlaneY = mouth.mouthPlaneY;
      this.mouthRadiusStudio = mouth.mouthRadius; // the sand stream spawns across this opening
    }
    this.glassUniforms.uMouthPlaneY.value = this.mouthPlaneY;
    // Sub-unity holds the mouth open; every other pair starts closed and irises
    // open only during pour activity.
    this.mouthOpen = comparison.subUnity ? 1 : 0;
    this.mouthOpenHold = 0;
    this.glassUniforms.uMouthOpen.value = this.mouthOpen;
  }

  private applyAtmosphere(container: string): void {
    if (this.atmosphere) {
      this.group.remove(this.atmosphere);
      this.atmosphere.geometry.dispose();
      (this.atmosphere.material as THREE.Material).dispose();
      this.atmosphere = null;
    }
    const params = ATMOSPHERES[container];
    if (!params) return; // airless bodies (and Sun) get no ghost shell
    this.atmosphere = makeAtmosphereGhost(params);
    this.group.add(this.atmosphere);
  }

  /**
   * Scatter `n` static fillers inside the glass — a deterministic settled pile
   * for the transparency QA and the montage capture (the real pour replaces it).
   * Every ball is strictly inside the shell and packed toward the lower
   * hemisphere. `n = 0` clears.
   */
  scatter(n: number): void {
    const r = this.ballRadius;
    const count = Math.max(0, Math.min(Math.floor(n), INSTANCE_CAPACITY));
    const reach = SCATTER_INSET - r;
    if (count === 0 || reach <= 0) {
      // A filler bigger than the glass (sub-unity pairs) can't sit inside — clear.
      this.fillerMesh.count = 0;
      this.fillerMesh.instanceMatrix.needsUpdate = true;
      return;
    }
    const rng = mulberry32(SCATTER_SEED);
    let placed = 0;
    for (let i = 0; i < count; i++) {
      // Vertical: quadratic bias toward the bottom (a settled pile), still inside.
      const t = rng();
      const y = -reach + reach * 1.3 * t * t;
      const maxXZ = Math.sqrt(Math.max(0, reach * reach - y * y));
      const a = rng() * Math.PI * 2;
      const rad = Math.sqrt(rng()) * maxXZ; // uniform in the disc
      this.scratchPos.set(Math.cos(a) * rad, y, Math.sin(a) * rad);
      randomQuat(this.scratchQuat, rng);
      this.scratchScale.setScalar(r);
      this.scratchMatrix.compose(this.scratchPos, this.scratchQuat, this.scratchScale);
      this.fillerMesh.setMatrixAt(placed++, this.scratchMatrix);
    }
    this.fillerMesh.count = placed;
    this.fillerMesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Per-frame: feed the camera into the glass shells + liquid sheen (world pos)
   * and the sand grains (view-space key dir + framebuffer size for the ≥1px
   * point-size floor). The grain impostor normals are view-space, so the key
   * light is transformed through the camera's inverse world matrix each frame.
   */
  update(camera: THREE.PerspectiveCamera): void {
    camera.getWorldPosition(this.scratchPos);
    this.glassUniforms.uCam.value.copy(this.scratchPos);
    this.liquidUniforms.uCam.value.copy(this.scratchPos);
    camera.updateMatrixWorld();
    this.scratchMatrix.copy(camera.matrixWorld).invert();
    this.grainUniforms.uKeyDirView.value.copy(KEY_LIGHT_DIR).transformDirection(this.scratchMatrix);
    this.grainUniforms.uPixelRatio.value = this.renderer.getPixelRatio();
    this.renderer.getDrawingBufferSize(this.scratchVec2);
    this.grainUniforms.uViewportH.value = Math.max(1, this.scratchVec2.y);
  }

  /**
   * Step the sim one frame under the mode's phase-derived commands and report
   * back. Marbles run the solver; boulders run a scripted drop (never the
   * solver). Paused freezes the physics + spawner + melt while the visuals
   * (ripples, liquid time, preview fade) keep easing.
   */
  updateSim(dt: number, ctl: PourControl): PourStatus {
    const dtc = Math.min(dt, 0.05); // guard a huge hitch (tab refocus, breakpoint)
    if (!this.timeFrozen) this.liquidTime += dtc;
    // The glass dome's ember granulation drifts off the same clock (idle-alive). Only
    // the Sun-container back-shell ember branch reads it; every other pair is untouched.
    this.glassUniforms.uTime.value = this.liquidTime;
    this.updateRipples(dtc);
    this.easePreview(dtc);
    this.updateGhostLine(dtc);
    if (ctl.regime === 'sand') return this.updateSand(dtc, ctl);
    if (ctl.regime === 'boulders') return this.updateBoulders(dtc, ctl);
    return this.updateMarbles(dtc, ctl);
  }

  /**
   * The mode sets the ghost fill line to the slider's volume fraction (0 hides
   * it). The ring rides at that liquid target level; it fades once the real
   * level reaches it, and at slider 0.
   */
  setGhostTarget(volumeFraction: number, fillerColorHex: number): void {
    this.ghostTargetFraction = Math.min(1, Math.max(0, volumeFraction));
    this.ghostLineMat.color.setHex(fillerColorHex);
  }

  private updateGhostLine(dt: number): void {
    let targetOpacity = 0;
    const frac = this.ghostTargetFraction;
    if (frac > 0.001) {
      const targetLevel = capHeightForVolume(frac * LIQUID_SPHERE_VOLUME, R_LIQ);
      const surfaceY = -R_LIQ + targetLevel;
      const ringR = Math.sqrt(Math.max(0, R_LIQ * R_LIQ - surfaceY * surfaceY));
      this.ghostLine.position.set(0, surfaceY, 0);
      this.ghostLine.scale.set(ringR, 1, ringR);
      const reached = Math.abs(this.liquidLevelRendered - targetLevel) < 0.02;
      targetOpacity = reached ? 0 : 0.35;
    }
    this.ghostLineOpacity += (targetOpacity - this.ghostLineOpacity) * (1 - Math.exp(-dt / 0.2));
    this.ghostLineMat.opacity = this.ghostLineOpacity;
    this.ghostLine.visible = this.ghostLineOpacity > 0.01;
  }

  /**
   * Sub-unity pose: one filler at true relative scale r_f = n^(−1/3) (> 1),
   * internally tangent at the container's bottom pole so it pokes out the top.
   * Reuses boulder mesh 0 as a plain lit planet (molten front off). The vessel
   * stays whole (the mouth is regime-gated away). Never routed through the solver.
   */
  showSubUnity(comparison: Comparison): void {
    // The TRUE relative scale — Moon-in-Jupiter r_f ≈ 40, Earth-in-Sun ≈ 109,
    // Moon-in-Sun ≈ 400. No clamp: the giant is genuinely that big, the vessel
    // genuinely that small (Alex's honest-scale ruling). frameSubUnity keeps the
    // camera outside the giant and the vessel at/above its readable size floor.
    const rf = Math.pow(Math.max(comparison.n, 1e-9), -1 / 3);
    this.subUnityRf = rf;
    const mesh = this.boulderPool[0];
    const u = this.boulderUniforms[0];
    u.uMap.value = this.fillerMap ?? this.emptyTex;
    // Giant emissive intensity: tamer than a melt boulder so the frame-filling
    // sub-unity Sun glows without whiting out (whiteout budget applies).
    u.uEmber.value = this.fillerIsSun ? 0.95 : 0;
    u.uMeltFront.value = -1.3; // no molten bleed — a whole planet in a glass
    // The loom giant's limb over-minifies (tiny map patch stretched huge → the
    // sampler falls to blurry high mips): bias toward a sharper mip here only.
    u.uLodBias.value = -0.75;
    mesh.scale.setScalar(rf);
    // Wedged in the vessel's mouth like an egg in a cup: tangent to the mouth-rim
    // circle (radius SUBUNITY_MOUTH_R at the mouth plane), so the filler sits IN
    // the opening — "went in as far as it fits", not balanced on a pole. Internal
    // tangency would engulf the opaque-occluded glass; this keeps it visible. The
    // belly faces the camera, so it takes the dedicated underside key.
    this.subUnityFillerY = SUBUNITY_MOUTH_PLANE_Y + Math.sqrt(Math.max(0, rf * rf - SUBUNITY_MOUTH_R * SUBUNITY_MOUTH_R));
    mesh.position.set(0, this.subUnityFillerY, 0);
    u.uSunDir.value.copy(SUB_UNITY_LOOM_KEY);
    // Light the tiny vessel from the giant overhead (the glass shader's loom branch);
    // configurePour cleared this to 0, so it is set on for the loom pose only.
    this.glassUniforms.uLoomLit.value = 1;
    mesh.visible = true;
    // Everything else off: this is a single static teaching image.
    this.boulderPool[1].visible = false;
    this.liquidBody.visible = false;
    this.liquidDisc.visible = false;
    this.previewMesh.visible = false;
    this.ghostLine.visible = false;
    this.fillerMesh.count = 0;
    this.fillerMesh.instanceMatrix.needsUpdate = true;
  }

  /** The scene's top extent (studio units) for the tall-scene framing. */
  topExtentForPour(comparison: Comparison): number {
    if (comparison.subUnity) return this.subUnityFillerY + this.subUnityRf; // wedged filler top
    if (comparison.regime === 'boulders') return CONTAINER_R + 2 * (1 / comparison.across);
    return CONTAINER_R;
  }

  /** The rendered sub-unity filler radius (capped) — the mode frames the loom to it. */
  subUnityRenderRf(): number {
    return this.subUnityRf;
  }

  /** How many boulder-pool meshes are visible (QA leftover check — should be 0 for
   *  marbles/sand, ≤2 for boulders, 1 for sub-unity). */
  visibleBoulderMeshes(): number {
    return this.boulderPool.reduce((n, m) => n + (m.visible ? 1 : 0), 0);
  }

  /** The mouth iris amount (0 sealed closed sphere → 1 open) — QA seal check. */
  mouthOpenAmount(): number {
    return this.mouthOpen;
  }

  /** The wedged sub-unity filler's centre height — the mode frames + guards to it. */
  subUnityFillerCenterY(): number {
    return this.subUnityFillerY;
  }

  /** Re-zero the sim + liquid for the same pair (Reset — no texture reload). */
  resetSession(comparison: Comparison, filler: string): void {
    this.configurePour(comparison, filler);
    // Re-seal the mouth immediately: a reset must show a pristine closed vessel,
    // not the ~1 s open-hold + ease the cleared pour left behind. (Sub-unity holds
    // its display mouth open, but a reset only runs for pourable regimes.)
    if (!comparison.subUnity) {
      this.mouthOpen = 0;
      this.mouthOpenHold = 0;
      this.glassUniforms.uMouthOpen.value = 0;
    }
  }

  /**
   * Top the liquid off to exactly full at completion. Whole balls fill only
   * floor(N)/N of the container (you cannot pour a fractional ball), so the last
   * fractional ball-volume of liquid is added here — the container's volume IS
   * exactly N ball-volumes, so a full fill reads N, not floor(N). `poured` lands
   * on the exact ratio too (as topOffSand does), so the completion odometer and
   * the slider track read the headline count, not the whole-ball floor.
   */
  topOffLiquid(): void {
    this.melted = this.simN;
    this.poured = this.simN;
  }

  private updateMarbles(dt: number, ctl: PourControl): PourStatus {
    const solver = this.solver;
    // Spout taper: the stream ramps in and trails out, never snaps.
    const flowTarget = ctl.spawnEnabled && !ctl.paused ? 1 : 0;
    this.spoutFlow += (flowTarget - this.spoutFlow) * (1 - Math.exp(-dt / SPOUT_RAMP_TAU));

    if (!ctl.paused) {
      const target = ctl.targetCount;
      if (ctl.rainEnabled) {
        // Raining: arrivals become display fallers (the mouth-melt no longer eats
        // them mid-descent). The solver only drains its residual pile below.
        this.spawnFallersToward(dt, target);
      } else if (this.poured > target + 0.5) {
        this.drainToTarget(Math.floor(target)); // slider dropped: pop newest
      } else {
        this.spawnToward(dt, target); // rate is 0 when the spout is closed
      }
      if (ctl.meltRate > 0) this.meltStep(dt, ctl.meltRate);
      if (ctl.rainEnabled) this.rainStep();
      // Integrate + land fallers: raining spawns them, spilling lets airborne
      // stragglers finish. Inside the !paused block so pause freezes the fall.
      this.updateFallers(dt);
      solver.update(dt);
    }

    // Animate the overflow spill (marbles spill too — the grains ride the same
    // pool), then iris on pour/airborne/spill/faller activity.
    this.updateGrains(dt);
    const airborne = this.solver.count - this.solver.enteredCount;
    // Inside grains only (stream/plume) + fallers hold the mouth; the outside
    // spill garnish never does (else the iris stays open past complete).
    const irisActive = (ctl.spawnEnabled && !ctl.paused) || airborne > 0 ||
      this.insideGrainLiveCount > 0 || this.fallers.length > 0;
    this.updateMouthIris(dt, irisActive);
    const molten = ctl.meltRate > 0 || ctl.rainEnabled;
    this.updateLiquid(dt, molten);
    this.syncInstances(dt);
    return this.buildStatus(false);
  }

  /**
   * Iris the mouth open during pour activity and seal it otherwise — the vessel
   * is a pristine closed sphere at idle/brim/complete. Held open across the
   * active arc (a 1 s debounce) so pour→settle→pour within a session never
   * strobes, and eased ~0.4 s so it never snaps.
   */
  private updateMouthIris(dt: number, active: boolean): void {
    if (active) this.mouthOpenHold = 1.0;
    else this.mouthOpenHold = Math.max(0, this.mouthOpenHold - dt);
    const target = this.mouthOpenHold > 0 ? 1 : 0;
    this.mouthOpen += (target - this.mouthOpen) * (1 - Math.exp(-dt / 0.14)); // ~0.4 s ease
    this.glassUniforms.uMouthOpen.value = this.mouthOpen;
  }

  // ---- marble rain fallers (display-owned; never the solver) --------------

  /**
   * Spawn display fallers toward the target during `raining` — 1:1 with poured
   * (each poured++ is exactly one faller). Rate is the pourBudget's mouth-scaled
   * throughput alone (no solver-entry throttle for arrivals). If the list is at
   * FALLER_CAP the spawn does NOT fire and the budget carries, so a faller can
   * never be dropped after spawning and poured/faller stay 1:1 by construction.
   */
  private spawnFallersToward(dt: number, targetCount: number): void {
    const rate = Math.min(COMPARE_TUNABLES.pourMaxPerSec, POUR_RATE_K * this.across) * this.spoutFlow;
    const budget = pourBudget(dt, rate, this.pourCarry);
    this.pourCarry = budget.carry;
    let toSpawn = Math.min(budget.spawns, Math.max(0, Math.floor(targetCount - this.poured)));
    while (toSpawn > 0) {
      if (this.fallers.length >= FALLER_CAP) { this.pourCarry += toSpawn; break; } // full → carry, never drop
      this.spawnFaller();
      this.poured++;
      toSpawn--;
    }
  }

  /** One faller at the spout: existing entry velocity + small radial scatter
   *  inside the mouth disc (falls through the iris) + a random tumble. */
  private spawnFaller(): void {
    const a = this.grainRng() * Math.PI * 2;
    const rad = Math.sqrt(this.grainRng()) * this.mouthRadiusStudio * 0.55;
    randomQuat(this.scratchQuat, this.grainRng);
    this.fallers.push({
      x: Math.cos(a) * rad, y: FALLER_SPAWN_Y, z: Math.sin(a) * rad,
      vx: (this.grainRng() - 0.5) * 0.12, vy: -1.2 - this.grainRng() * 0.5, vz: (this.grainRng() - 0.5) * 0.12,
      qx: this.scratchQuat.x, qy: this.scratchQuat.y, qz: this.scratchQuat.z, qw: this.scratchQuat.w,
      wx: (this.grainRng() - 0.5) * 2.0, wy: (this.grainRng() - 0.5) * 2.0, wz: (this.grainRng() - 0.5) * 2.0,
      r: this.ballRadius, sinking: false, sinkAge: 0, contactY: 0,
    });
  }

  /**
   * Integrate every faller (terminal-velocity-capped fall + tumble), land those
   * that reach the contact plane (max of the pool surface and the axial pile top,
   * so they land ON the exposed pile during the melt/rain overlap instead of
   * ghosting through it), splash, then sink. Runs in `raining` (spawns) AND
   * `spilling` (airborne stragglers finish). Called inside the solver's
   * !ctl.paused block, so pause freezes the fall (solver parity). Also advances
   * the impact churn each frame.
   */
  private updateFallers(dt: number): void {
    if (this.fallers.length === 0) { this.advanceChurn(dt); return; }
    const surfaceY = -R_LIQ + this.liquidLevelRendered;
    const pileTop = this.solver.pileTopNearAxis(this.mouthRadiusStudio); // -Infinity if none
    const contactPlane = Math.max(surfaceY, pileTop);
    const contactIsLiquid = surfaceY >= pileTop; // pileTop -Inf → always the pool
    this.plumeRippleT -= dt; // ~12/s ripple throttle (one per frame max)
    let rippleReady = this.plumeRippleT <= 0;
    for (let k = this.fallers.length - 1; k >= 0; k--) {
      const f = this.fallers[k];
      if (f.sinking) {
        f.sinkAge += dt;
        if (f.sinkAge >= FALLER_SINK_S) { this.fallers.splice(k, 1); continue; }
        f.y = f.contactY - (f.sinkAge / FALLER_SINK_S) * f.r * 1.2; // sink below the plane
        continue;
      }
      f.vy -= FALLER_GRAVITY * dt;
      if (f.vy < -FALLER_VT) f.vy = -FALLER_VT; // terminal velocity
      f.x += f.vx * dt; f.y += f.vy * dt; f.z += f.vz * dt;
      this.integrateFallerSpin(f, dt);
      if (f.y - f.r <= contactPlane) {
        // (a) ripple — only when the contact is the liquid, throttled to ~12/s.
        if (contactIsLiquid && rippleReady) {
          this.removedPos[0] = f.x; this.removedPos[2] = f.z;
          this.spawnRipple(0);
          rippleReady = false;
          this.plumeRippleT = 1 / 12;
        }
        // (b) droplet burst from the grain pool — always. (c) churn spot — always.
        this.splashDroplets(f.x, f.z, contactPlane);
        this.bumpChurn(this.nextChurnSlot(), f.x, f.z, 0.85);
        f.sinking = true; f.sinkAge = 0; f.contactY = contactPlane;
        this.melted = Math.min(this.simN, this.melted + 1); // clamped to simN
      }
    }
    this.advanceChurn(dt);
  }

  /** Integrate one faller's tumble quaternion (semi-implicit, renormalized). */
  private integrateFallerSpin(f: Faller, dt: number): void {
    const h = 0.5 * dt;
    const nx = f.qx + h * (f.wx * f.qw + f.wy * f.qz - f.wz * f.qy);
    const ny = f.qy + h * (-f.wx * f.qz + f.wy * f.qw + f.wz * f.qx);
    const nz = f.qz + h * (f.wx * f.qy - f.wy * f.qx + f.wz * f.qw);
    const nw = f.qw + h * (-f.wx * f.qx - f.wy * f.qy - f.wz * f.qz);
    const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz + nw * nw);
    f.qx = nx * inv; f.qy = ny * inv; f.qz = nz * inv; f.qw = nw * inv;
  }

  /** A small amber-warmed droplet burst from the grain pool at a splash contact
   *  (kind 2 — inside the vessel; gain ≤1.35, sub-bloom). */
  private splashDroplets(x: number, z: number, y: number): void {
    const count = 2 + ((this.grainRng() * 3) | 0); // 2-4
    for (let i = 0; i < count; i++) {
      const a = this.grainRng() * Math.PI * 2;
      const outward = 0.3 + this.grainRng() * 0.6;
      const vy = 0.7 + this.grainRng() * 0.8;
      const size = SPILL_SIZE_MIN + this.grainRng() * (SPILL_SIZE_MAX - SPILL_SIZE_MIN);
      // Crown brightness 1.1 (≤1.35 cap) + amber-warmed toward the molten pool
      // so it reads as glowing displaced matter, never whiter than the pool.
      this.grainColor(this.grainColorScratch, 1.1);
      this.grainColorScratch.lerp(SPLASH_WARM, 0.25);
      this.writeGrain(this.nextSpillSlot(), x, y + 0.01, z, Math.cos(a) * outward, vy, Math.sin(a) * outward, size, 0.34, 2, this.grainColorScratch);
    }
  }

  /** Seat/refresh an impact-churn site (worldX, worldZ, age01=0, amp). */
  private bumpChurn(slot: number, x: number, z: number, amp: number): void {
    this.liquidUniforms.uChurn.value[slot].set(x, z, 0, amp);
  }

  /** Rotate through the marble-splash churn slots (1-3); slot 0 is the sand stream. */
  private nextChurnSlot(): number {
    const s = this.churnCursor;
    this.churnCursor = this.churnCursor >= 3 ? 1 : this.churnCursor + 1;
    return s;
  }

  /** Age every churn site toward death (age01 → 1). */
  private advanceChurn(dt: number): void {
    const step = dt / CHURN_LIFE;
    for (const v of this.liquidUniforms.uChurn.value) {
      if (v.z < 1) v.z = Math.min(1, v.z + step);
    }
  }

  /** Live faller count — QA telemetry + the mouth-iris hold. */
  fallersLive(): number {
    return this.fallers.length;
  }

  /** Spawn balls toward the poured target, capped by the live/awake caps, the
   *  mouth-scaled rate, the in-flight cap, and the spout taper. */
  private spawnToward(dt: number, targetCount: number): void {
    // Rate follows the mouth so balls never land on the rim faster than the
    // opening swallows them.
    const rate = Math.min(COMPARE_TUNABLES.pourMaxPerSec, POUR_RATE_K * this.across) * this.spoutFlow;
    const budget = pourBudget(dt, rate, this.pourCarry);
    this.pourCarry = budget.carry;
    if (budget.spawns <= 0) return;
    // Hold the spout while too many balls are still falling — a column that
    // outpaces entry towers up and deflects chunky balls over the rim.
    const inFlightCap = this.across < CHUNKY_ACROSS ? IN_FLIGHT_CAP_CHUNKY : IN_FLIGHT_CAP;
    const allowance = spawnAllowance(
      targetCount,
      this.poured,
      this.solver.awakeCount,
      this.spawnCaps,
      this.solver.count,
    );
    const want = Math.min(budget.spawns, allowance);
    for (let i = 0; i < want; i++) {
      if (this.solver.count - this.solver.enteredCount >= inFlightCap) break; // let the column enter first
      if (this.solver.spawn() < 0) break; // buffer full, pack ceiling, or spout busy
      this.poured++;
    }
  }

  /** Pop the newest solids until live ≤ target, scaling each out over ~150 ms. */
  private drainToTarget(target: number): void {
    let excess = this.solver.count - target;
    if (excess <= 0) return;
    excess = Math.min(excess, DRAIN_MAX_PER_FRAME);
    const removed = this.solver.drainNewest(excess, this.removedIdx, this.removedPos);
    for (let c = 0; c < removed; c++) {
      if (this.drainShrink.length < 256) {
        this.drainShrink.push({
          x: this.removedPos[c * 3],
          y: this.removedPos[c * 3 + 1],
          z: this.removedPos[c * 3 + 2],
          r: this.ballRadius,
          age: 0,
        });
      }
      this.poured = Math.max(this.melted, this.poured - 1);
    }
  }

  /** Bottom-up melt: remove the lowest solids at `rate`/s, each splashing a ripple. */
  private meltStep(dt: number, rate: number): void {
    const budget = pourBudget(dt, rate, this.meltCarry);
    this.meltCarry = budget.carry;
    if (budget.spawns <= 0) return;
    const removed = this.solver.meltLowest(budget.spawns, this.removedIdx, this.removedPos);
    // One splash per batch — the ~24 pool at 0.6 s life would recycle away faster
    // than it reads if every removal spawned its own.
    if (removed > 0) this.spawnRipple(0);
    this.melted += removed;
  }

  /** Rain: consume solids that touch the risen liquid surface, paced per frame. */
  private rainStep(): void {
    const levelY = -R_LIQ + this.liquidLevelRendered;
    const removed = this.solver.consumeTouchingLiquid(
      levelY,
      COMPARE_TUNABLES.rainConsumePerFrame,
      this.removedIdx,
      this.removedPos,
    );
    if (removed > 0) this.spawnRipple(0);
    this.melted += removed;
  }

  /** Ease the liquid's rendered level + heat, then push both into the uniforms. */
  private updateLiquid(dt: number, molten: boolean): void {
    const fillFraction = Math.min(1, this.melted / Math.max(this.simN, 1e-9));
    const computed = capHeightForVolume(fillFraction * LIQUID_SPHERE_VOLUME, R_LIQ);
    this.liquidLevelRendered += (computed - this.liquidLevelRendered) *
      (1 - Math.exp(-dt / COMPARE_TUNABLES.liquidEaseTau));
    // Planets glow only during the melt beat; the Sun's molten pool stays hot.
    const heatTarget = this.fillerIsSun ? 1 : molten ? 1 : 0.15;
    const u = this.liquidUniforms;
    u.uHeat.value += (heatTarget - u.uHeat.value) * (1 - Math.exp(-dt / 0.5));
    this.updateLiquidUniforms(this.liquidLevelRendered);
    const show = this.melted > 1e-4;
    this.liquidBody.visible = show;
    this.liquidDisc.visible = show;
  }

  /** Push the eased level (and the fill fraction) into the liquid + glass uniforms. */
  private updateLiquidUniforms(level: number): void {
    const surfaceY = -R_LIQ + level;
    this.liquidUniforms.uSurfaceY.value = surfaceY;
    this.liquidUniforms.uTime.value = this.liquidTime;
    // Position + scale the surface disc to the cap circle at this height. Lifted a
    // hair above the body's clip plane (both otherwise sit exactly at surfaceY and
    // z-fight at grazing angles — the transparent disc tests depth against the
    // opaque body top).
    const discR = Math.sqrt(Math.max(0, R_LIQ * R_LIQ - surfaceY * surfaceY));
    this.liquidDisc.position.set(0, surfaceY + 0.004, 0);
    this.liquidDisc.scale.set(discR, discR, 1);
    this.liquidUniforms.uSurfDiscR.value = discR; // churn sites compare in world xz
    // The glass rim warms with the fill.
    this.glassUniforms.uFill.value = Math.min(1, this.melted / Math.max(this.simN, 1e-9));
  }

  /** Write the live balls (and drain shrink-outs) into the instanced mesh. */
  private syncInstances(dt: number): void {
    const solver = this.solver;
    const r = this.ballRadius;
    const count = solver.count;
    for (let i = 0; i < count; i++) {
      this.scratchPos.set(solver.posX[i], solver.posY[i], solver.posZ[i]);
      this.scratchQuat.set(solver.qx[i], solver.qy[i], solver.qz[i], solver.qw[i]);
      this.scratchScale.setScalar(r);
      this.scratchMatrix.compose(this.scratchPos, this.scratchQuat, this.scratchScale);
      this.fillerMesh.setMatrixAt(i, this.scratchMatrix);
    }
    // Drain shrink-outs occupy slots just above the live count.
    let slot = count;
    for (let k = this.drainShrink.length - 1; k >= 0; k--) {
      const s = this.drainShrink[k];
      s.age += dt;
      const t = s.age / DRAIN_SHRINK_S;
      if (t >= 1 || slot >= INSTANCE_CAPACITY) {
        this.drainShrink.splice(k, 1);
        continue;
      }
      this.scratchPos.set(s.x, s.y, s.z);
      this.scratchQuat.identity();
      this.scratchScale.setScalar(s.r * (1 - t));
      this.scratchMatrix.compose(this.scratchPos, this.scratchQuat, this.scratchScale);
      this.fillerMesh.setMatrixAt(slot++, this.scratchMatrix);
    }
    // Display fallers (marble rain) occupy slots above the drain tail — capacity
    // has FALLER_CAP of headroom, so a mesh write dropped by the cap drops only
    // the DRAW, never the faller or its melted++.
    for (let k = 0; k < this.fallers.length && slot < INSTANCE_CAPACITY; k++) {
      const f = this.fallers[k];
      this.scratchPos.set(f.x, f.y, f.z);
      this.scratchQuat.set(f.qx, f.qy, f.qz, f.qw);
      const sc = f.sinking ? f.r * Math.max(0, 1 - f.sinkAge / FALLER_SINK_S) : f.r;
      this.scratchScale.setScalar(sc);
      this.scratchMatrix.compose(this.scratchPos, this.scratchQuat, this.scratchScale);
      this.fillerMesh.setMatrixAt(slot++, this.scratchMatrix);
    }
    this.fillerMesh.count = slot;
    this.fillerMesh.instanceMatrix.needsUpdate = true;
  }

  private buildStatus(bouldersDone: boolean): PourStatus {
    const solver = this.solver;
    const live = solver.count;
    const awake = solver.awakeCount;
    const asleepFrac = live === 0 ? 1 : (live - awake) / live;
    const packing = solver.packingFraction;
    // Pile-at-mouth: a settled entered ball whose top reaches the bowl's mouth
    // plane — the physical "full" the chunky band hits before the pack ceiling.
    const mouthThresh = this.solverMouthPlaneY - 2 * this.ballRadius;
    let pileAtMouth = false;
    for (let i = 0; i < live; i++) {
      if (solver.entered[i] && solver.asleep[i] && solver.posY[i] >= mouthThresh) {
        pileAtMouth = true;
        break;
      }
    }
    // Filled in place (one status object per scene, rewritten each frame): the
    // mode reads it within the frame and only ever keeps the latest.
    const s = this.statusScratch;
    s.poured = this.poured;
    s.melted = this.melted;
    s.live = live;
    s.awake = awake;
    s.asleepFrac = asleepFrac;
    s.packingFraction = packing;
    s.atPackCeiling = packing >= PACK_CEILING - 0.01;
    s.pileAtMouth = pileAtMouth;
    s.fillFraction = Math.min(1, this.melted / Math.max(this.simN, 1e-9));
    s.liquidLevelY = this.liquidLevelRendered;
    s.bouldersDone = bouldersDone;
    return s;
  }

  /** The scale preview parks beside the vessel and scale-fades on the first pour. */
  /** World placement of the scale preview (one filler parked beside the vessel) —
   *  the single source for both the render (easePreview) and the mode's mobile
   *  framing fit, so the two never drift. Radius is the pair's true ball radius. */
  previewBounds(): { x: number; y: number; z: number; r: number } {
    const r = this.ballRadius;
    return { x: CONTAINER_R + Math.max(2.5 * r, 0.18), y: -CONTAINER_R + r, z: 0, r };
  }

  /** Read-only presence for the HTML label that follows the rendered preview. */
  previewPresence(): number {
    return this.previewOpacity;
  }

  private easePreview(dt: number): void {
    // Sand's filler is a sub-pixel sliver at this scale — the honest note carries
    // the "too many to pour" story, so the preview stays hidden for sand.
    const want =
      !this.sandRegime && this.poured === 0 && this.melted === 0 && this.boulders.length === 0;
    this.previewOpacity += ((want ? 1 : 0) - this.previewOpacity) * (1 - Math.exp(-dt / 0.13));
    const b = this.previewBounds();
    this.previewMesh.position.set(b.x, b.y, b.z);
    this.previewMesh.scale.setScalar(b.r * this.previewOpacity);
    this.previewMesh.visible = this.previewOpacity > 0.02;
  }

  private updateRipples(dt: number): void {
    const attr = this.ripples.geometry.getAttribute('aAge') as THREE.InstancedBufferAttribute;
    const arr = attr.array as Float32Array;
    let dirty = false;
    for (let i = 0; i < RIPPLE_POOL; i++) {
      if (arr[i] < RIPPLE_LIFE) {
        arr[i] += dt;
        dirty = true;
      }
    }
    if (dirty) attr.needsUpdate = true;
  }

  /**
   * Seat a ripple ON the liquid surface at removal `c`'s xz — clamped inside the
   * surface disc's radius at the current level, so a deep-melted ball (whose xz
   * lies where the sphere is wider than the surface) never puts a splash outside
   * the disc or beyond the glass silhouette.
   */
  private spawnRipple(c: number): void {
    const geo = this.ripples.geometry;
    const ageAttr = geo.getAttribute('aAge') as THREE.InstancedBufferAttribute;
    const cenAttr = geo.getAttribute('aCenter') as THREE.InstancedBufferAttribute;
    const i = this.rippleCursor;
    this.rippleCursor = (this.rippleCursor + 1) % RIPPLE_POOL;
    // Seat on the BULK surface for sand (its level is the volume-flat plane; the
    // physical surface is the heap on bulkH), the eased pool otherwise.
    const bulkLevel = this.sandRegime ? this.heapBulkH : this.liquidLevelRendered;
    const surfaceY = -R_LIQ + bulkLevel;
    const discRfull = Math.sqrt(Math.max(0, R_LIQ * R_LIQ - surfaceY * surfaceY));
    const discR = discRfull * 0.9;
    let x = this.removedPos[c * 3];
    let z = this.removedPos[c * 3 + 2];
    const rad = Math.hypot(x, z);
    if (rad > discR && rad > 1e-5) {
      const s = discR / rad;
      x *= s;
      z *= s;
    }
    // On sand, lift the ripple to the LOCAL heap height at its xz so a contact flash
    // sits on the flank/crest, not mid-air on the flat level below the cone.
    const seatRr = discRfull > 1e-4 ? Math.hypot(x, z) / discRfull : 0;
    const seatY = this.sandRegime ? surfaceY + heapHeightAt(seatRr, this.heapPeakH) : surfaceY;
    const cen = cenAttr.array as Float32Array;
    cen[i * 3] = x;
    cen[i * 3 + 1] = seatY + 0.002; // a hair above the disc, never below the meniscus
    cen[i * 3 + 2] = z;
    (ageAttr.array as Float32Array)[i] = 0;
    cenAttr.needsUpdate = true;
    ageAttr.needsUpdate = true;
  }

  // ---- sand (a lit particle stream + the overflow spill, never the solver) -

  /** Set the live sand-grain budget for the device tier (sandGrainBudget). */
  setGrainBudget(budget: number): void {
    this.grainBudget = Math.min(GRAIN_CAPACITY, Math.max(SPILL_RESERVE + 1, Math.floor(budget)));
  }

  /** Kill every grain (aAge = aLife → 0 px) and hide the pool. */
  private clearGrains(): void {
    this.gAge.set(this.gLife); // every slot dead
    (this.grainGeo.getAttribute('aAge') as THREE.BufferAttribute).needsUpdate = true;
    this.grainLiveCount = 0;
    this.insideGrainLiveCount = 0;
    this.grainCursor = 0;
    this.spillCursor = 0;
    this.grains.visible = false;
  }

  /**
   * Synchronously cancel every transient garnish — the whole grain pool (stream,
   * plume, spill), its fractional carries + ripple timer, and the spill emission.
   * Called at the TOP of a pair commit (BEFORE the async texture load) and on
   * deactivate, so old grains never freeze on stage during the load window; also
   * the single clear that configurePour runs when a load lands. Touches no solver
   * pile and no liquid — the next configurePour resets those.
   */
  cancelTransients(): void {
    this.clearGrains();
    this.streamCarry = 0;
    this.runoffCarry = 0;
    this.plumeRippleT = 0;
    this.spillActive = false;
    this.spillElapsed = 0;
    this.spillEmitted = 0;
    this.spillCarry = 0;
    // Marble-rain fallers + the impact-churn sites (pair-swap / reset / deactivate).
    this.fallers.length = 0;
    this.churnCursor = 1;
    for (const v of this.liquidUniforms.uChurn.value) v.set(0, 0, 1, 0);
  }

  /**
   * Gracefully retire every live splash / plume / droplet grain over
   * RETIRE_FADE_S so the end card settles over a clean scene — a fast FADE, not
   * the instant pop `cancelTransients` does for swaps / reset / deactivate.
   * Rewrites each live grain to the fade-out threshold now (lifeT 0.72, full
   * opacity), dying RETIRE_FADE_S later — uniform, no pop, positions keep
   * integrating so the strays drift out as they fade. Also stops the overflow
   * spill from emitting more garnish (the already-emitted grains fade with the
   * rest). Fallers are out of scope — they land + sink on their own within the
   * settle window. Called on entering `complete`.
   */
  retireTransients(): void {
    const life = RETIRE_FADE_S / 0.28; // fadeOut spans lifeT 0.72 → 1.0
    const spillLife = SPILL_RETIRE_FADE_S / 0.28;
    for (let i = 0; i < this.grainBudget; i++) {
      if (this.gAge[i] >= this.gLife[i]) continue; // already dead — leave it
      // Spill grains (kind 1) sit at the limb — clear them fast and cancel their
      // outward arc so none linger lit outside the vessel once the landing settles
      // (gravity still settles them a hair through the short fade, which reads as a
      // droplet dropping — the point is they stop travelling outward). The over-pool
      // splash/plume (kinds 0/2) keep the graceful fade.
      const isSpill = this.gKind[i] === 1;
      const l = isSpill ? spillLife : life;
      this.gLife[i] = l;
      this.gAge[i] = 0.72 * l; // at the fade-out threshold → dies its window out
      if (isSpill) {
        const i3 = i * 3;
        this.gVel[i3] = 0; this.gVel[i3 + 1] = 0; this.gVel[i3 + 2] = 0; // cancel the arc
      }
    }
    this.spillActive = false;
    (this.grainGeo.getAttribute('aAge') as THREE.BufferAttribute).needsUpdate = true;
    (this.grainGeo.getAttribute('aLife') as THREE.BufferAttribute).needsUpdate = true;
  }

  /** How many grains are alive this frame (iris hold + QA cleared-check). */
  grainsLive(): number {
    return this.grainLiveCount;
  }

  /**
   * The sand fill: a lit particle stream pours while the liquid level rises to
   * the true volume — never the solver (no spawn/step/reset, no packing stats,
   * no drain logic). The ramp (sandFillFraction) drives `melted`; `poured =
   * floor(melted)`, `live = 0`. The stream + the overflow spill share one Points
   * pool. Structural, not situational: the sandRegime flag routes here.
   */
  private updateSand(dt: number, ctl: PourControl): PourStatus {
    if (!ctl.paused) this.advanceSandFill(dt, ctl);
    const streaming = ctl.spawnEnabled && !ctl.paused && this.sandFillActive;
    // The sand surface is the heap, a PURE function of poured volume — no easing, no
    // deflation, no stream coupling. Repose is stable, so a frozen V (pause /
    // slider-down) holds the heap bit-stable. V is the ramp's melted count in R_liq
    // sphere-volume units, the same measure the volume-flat level reads.
    const fillFraction = Math.min(1, this.melted / Math.max(this.simN, 1e-9));
    const V = fillFraction * LIQUID_SPHERE_VOLUME;
    // Pose the heap from the total volume V (settled bulk + repose cone + volume-flat
    // level + disc/body geometry uniforms). Extracted so topOffSand poses through the
    // SAME path — heap = f(V) holds on the brim-landing frame, no stale-pose flash.
    this.poseSandSurface(V);
    // uHeat still eases (a Sun filler stays hot; every other sand rests cool). This is
    // per-frame, not part of the pose, so it stays here. The geometry uniforms already
    // sit at the BULK surface (poseSandSurface): the opaque body fills to bulkH and the
    // cone rides on top in the disc's vertex stage, so the cone volume is never drawn twice.
    const heatTarget = this.fillerIsSun ? 1 : 0.15;
    this.liquidUniforms.uHeat.value +=
      (heatTarget - this.liquidUniforms.uHeat.value) * (1 - Math.exp(-dt / 0.5));
    // Ease the stream-active scalar (the trickle's life) toward the live pour state.
    this.streamActive += ((streaming ? 1 : 0) - this.streamActive) * (1 - Math.exp(-dt / 0.4));
    this.liquidUniforms.uStreamActive.value = this.streamActive;
    const show = this.melted > 1e-4;
    this.liquidBody.visible = show;
    this.liquidDisc.visible = show;
    if (!ctl.paused) {
      if (streaming) {
        this.emitStream(dt);
        this.updateStreamContact(dt);
      } else {
        this.streamCarry = 0;
      }
      this.advanceChurn(dt); // age churn sites (slot 0 re-bumped by updateStreamContact while streaming)
    }
    this.updateGrains(dt);
    // The iris opens on stream/plume (inside-vessel) activity and seals ~1 s after
    // it quiets — the outside spill garnish never holds it open (item 5).
    this.updateMouthIris(dt, streaming || this.insideGrainLiveCount > 0);
    return this.buildSandStatus();
  }

  /**
   * Sand's status WITHOUT any solver read — the guarantee that sand never touches
   * the rigid-body solver. Sand runs no bodies, so live/awake/packing are fixed 0
   * (poured/melted/fillFraction/level come from the ramp fields). buildStatus (the
   * marble/boulder path) reads solver.count/awakeCount/packingFraction + particle
   * arrays; this must not.
   */
  private buildSandStatus(): PourStatus {
    const s = this.statusScratch;
    s.poured = this.poured;
    s.melted = this.melted;
    s.live = 0;
    s.awake = 0;
    s.asleepFrac = 1;
    s.packingFraction = 0;
    s.atPackCeiling = false;
    s.pileAtMouth = false;
    s.fillFraction = Math.min(1, this.melted / Math.max(this.simN, 1e-9));
    s.liquidLevelY = this.liquidLevelRendered;
    s.bouldersDone = false;
    return s;
  }

  /**
   * Advance the sand ramp toward the target fraction. Re-anchored on each fresh
   * pour (and when the target moves up) from the CURRENT fill, with a duration
   * scaled by the remaining fraction — so a raised target keeps the same
   * fractional rate (1/sandFillS). A decrease is already clamped at the melted
   * floor by the mode's drain-clamped target, so the fill only ever holds or
   * rises (you cannot un-pour sand, the melted-floor idiom).
   */
  private advanceSandFill(dt: number, ctl: PourControl): void {
    const n = Math.max(this.simN, 1e-9);
    const targetFrac = Math.min(1, Math.max(0, ctl.targetCount / n));
    const currentFrac = this.melted / n;
    if (!ctl.spawnEnabled || targetFrac <= currentFrac) {
      this.sandFillActive = false; // settling, or the target is met — hold the level
      return;
    }
    // Sub-grain increase (the target rose by less than ONE whole grain): SNAP to
    // the exact count rather than run a stream for a change no odometer tick can
    // show. Count-scaled — a FIXED fraction-space deadband (1e-5) is thousands of
    // grains on a 28-billion pair and would skip the mandated stream, while on a
    // big N it also stranded melted a few grains short (poured = floor(melted) sat
    // below floor(target), so the whole-ball target-met never fired and the pour
    // hung in `pouring`). deltaFrac·N < 1 snaps ONLY genuine sub-grain nudges; a
    // real first slider step (thousands of grains) falls through to the ramp.
    if ((targetFrac - currentFrac) * n < 1) {
      this.melted = Math.min(this.simN, ctl.targetCount);
      this.poured = Math.floor(this.melted);
      this.sandFillActive = false;
      return;
    }
    if (!this.sandFillActive || Math.abs(targetFrac - this.sandTargetFrac) > 1e-4) {
      this.sandStartFrac = currentFrac;
      this.sandTargetFrac = targetFrac;
      this.sandElapsed = 0;
      this.sandDuration = Math.max(4, COMPARE_TUNABLES.sandFillS * (targetFrac - this.sandStartFrac));
      this.sandFillActive = true;
    }
    this.sandElapsed += dt;
    const p = sandFillFraction(this.sandElapsed, this.sandDuration);
    if (p >= 1) {
      // Snap to the EXACT target count, not simN·(target/simN): that round-trip
      // through the division lands melted a hair under the target, so
      // poured = floor(melted) sits one grain below floor(target) and the
      // whole-ball target-met check never fires (the pour would stall in
      // `pouring`). The exact snap keeps poured === floor(target).
      this.melted = Math.min(this.simN, ctl.targetCount);
      this.poured = Math.floor(this.melted);
      this.sandFillActive = false;
    } else {
      const frac = this.sandStartFrac + (this.sandTargetFrac - this.sandStartFrac) * p;
      this.melted = this.simN * frac;
      this.poured = Math.floor(this.melted);
    }
  }

  /** Pose the sand heap for a total poured volume V (studio sphere-volume units): the
   *  settled bulk fills to bulkH, the full-width repose cone (peakH) rides on the disc,
   *  and the volume-flat level feeds the top-out trigger + glass rim. Shared by the
   *  per-frame sand update and the top-out snap so heap = f(V) holds on every frame —
   *  including the brim-landing frame. Sand BYPASSES the 0.35 s geometry ease: the ramp
   *  is already smooth, and a second ease would lag the exact-landing frame. */
  private poseSandSurface(V: number): void {
    const heap = heapSplit(V, R_LIQ, this.mouthPlaneY, REPOSE_SLOPE, HEADROOM_K);
    this.heapBulkH = heap.bulkH;
    this.heapPeakH = heap.peakH;
    this.liquidUniforms.uPeakH.value = heap.peakH;
    this.liquidLevelRendered = capHeightForVolume(V, R_LIQ);
    this.updateLiquidUniforms(this.heapBulkH);
  }

  /** Snap the sand fill to exactly full at top-out — melted AND poured read N, so
   *  the final odometer string equals the headline (formatCount(N)). The mode fires
   *  top-out this same frame, so re-pose to f(V_full) here — settled flat at the brim
   *  (bulkH 2R, peakH 0) — or the landing frame renders the pre-snap pose: a one-frame
   *  hole at the pole that closes next frame. Posing in this call keeps heap = f(V) on
   *  the top-out frame itself. */
  topOffSand(): void {
    this.melted = this.simN;
    this.poured = this.simN;
    this.sandFillActive = false;
    this.poseSandSurface(LIQUID_SPHERE_VOLUME);
  }

  /** Begin the overflow spill: ~SPILL_COUNT grains over SPILL_EMIT_S at the rim.
   *  Marbles only — at sand top-out the rim burst read as confetti (the settled
   *  heap and the brim-flat surface already tell the moment), so sand's spilling
   *  beat runs with no airborne garnish. */
  beginSpill(): void {
    if (this.sandRegime) return;
    this.spillActive = true;
    this.spillElapsed = 0;
    this.spillEmitted = 0;
    this.spillCarry = 0;
  }

  /** Spawn stream grains at the mouth this frame, across a gaussian disc ~half
   *  the mouth radius (dense core, sparse edge — display-only cross-section). */
  private emitStream(dt: number): void {
    const crestY = -R_LIQ + this.heapBulkH + this.heapPeakH;
    const yTop = this.mouthPlaneY;
    if (yTop <= crestY + 0.02) return; // the heap crest reached the mouth — no room to pour
    // Scale the rate to this tier's stream slot band: the full-tier rate on a
    // reduced pool would round-robin live grains out mid-fall (visible pops).
    const rate = STREAM_RATE * Math.min(1, (this.grainBudget - SPILL_RESERVE) / (GRAIN_CAPACITY - SPILL_RESERVE));
    const budget = pourBudget(dt, rate, this.streamCarry);
    this.streamCarry = budget.carry;
    const spread = this.mouthRadiusStudio * STREAM_DISC_FRAC;
    for (let k = 0; k < budget.spawns; k++) {
      const g = this.grainRng() + this.grainRng() + this.grainRng() - 1.5; // ~gaussian, dense core
      const rad = Math.min(spread * 1.5, Math.abs(g) * spread);
      const a = this.grainRng() * Math.PI * 2;
      const x = Math.cos(a) * rad;
      const z = Math.sin(a) * rad;
      const vx = (this.grainRng() - 0.5) * 0.18;
      const vz = (this.grainRng() - 0.5) * 0.18;
      const vy = -0.5 - this.grainRng() * 0.4;
      const size = GRAIN_SIZE_MIN + this.grainRng() * (GRAIN_SIZE_MAX - GRAIN_SIZE_MIN);
      this.grainColor(this.grainColorScratch, 1);
      this.writeGrain(this.nextStreamSlot(), x, yTop, z, vx, vy, vz, size, 3.0, 0, this.grainColorScratch);
    }
  }

  /** Emit the overflow-spill garnish at the mouth rim (outward + up, over the
   *  glass shoulder), paced so SPILL_COUNT grains leave over SPILL_EMIT_S. */
  private emitSpill(dt: number): void {
    this.spillElapsed += dt;
    const budget = pourBudget(dt, SPILL_COUNT / SPILL_EMIT_S, this.spillCarry);
    this.spillCarry = budget.carry;
    const remaining = Math.max(0, SPILL_COUNT - this.spillEmitted);
    const n = Math.min(budget.spawns, remaining);
    const rimR = this.mouthRadiusStudio;
    const yTop = this.mouthPlaneY;
    for (let k = 0; k < n; k++) {
      const a = this.grainRng() * Math.PI * 2;
      const x = Math.cos(a) * rimR;
      const z = Math.sin(a) * rimR;
      const outward = 0.65 + this.grainRng() * 0.55; // clear the shoulder, don't rocket off-frame
      const vx = Math.cos(a) * outward;
      const vz = Math.sin(a) * outward;
      const vy = 1.0 + this.grainRng() * 0.7; // up and over before it falls past the base
      const size = SPILL_SIZE_MIN + this.grainRng() * (SPILL_SIZE_MAX - SPILL_SIZE_MIN);
      this.grainColor(this.grainColorScratch, 1.3); // lit little bodies in full key light
      this.writeGrain(this.nextSpillSlot(), x, yTop, z, vx, vy, vz, size, SPILL_GRAIN_LIFE, 1, this.grainColorScratch);
      this.spillEmitted++;
    }
    if (this.spillElapsed >= SPILL_EMIT_S || this.spillEmitted >= SPILL_COUNT) this.spillActive = false;
  }

  /** Integrate every live grain (gravity), recycle stream grains that reach the
   *  pool surface (with a throttled impact plume + splash), age out spill grains,
   *  and push the mutated attributes. Emits the spill garnish while active. Called
   *  from both the sand path (stream + spill) and the marble path (spill only). */
  private updateGrains(dt: number): void {
    if (this.spillActive) this.emitSpill(dt);
    // The stream kill plane rides the BULK surface + the heap cone (sand); the marble
    // spill reads neither (it arcs over the shoulder). liquidLevelRendered is the
    // volume-flat level for sand, so the bulk height comes from heapBulkH there.
    const bulkLevel = this.sandRegime ? this.heapBulkH : this.liquidLevelRendered;
    const surfaceY = -R_LIQ + bulkLevel;
    const discR = Math.max(1e-4, Math.sqrt(Math.max(0, R_LIQ * R_LIQ - surfaceY * surfaceY)));
    const budget = this.grainBudget;
    let live = 0;
    let inside = 0;
    for (let i = 0; i < budget; i++) {
      if (this.gAge[i] >= this.gLife[i]) continue;
      const i3 = i * 3;
      // Rollers (kind 3) RIDE the flank: no free fall — accelerate down-slope, re-pin
      // Y to the cone surface at their radius, die at the foot (rr≈1) or their short
      // life. The one CPU cue that reads the heap as a live, cascading pile.
      if (this.gKind[i] === 3) {
        this.gAge[i] += dt;
        const grow = 1 + ROLLER_ACCEL * dt;
        this.gVel[i3] *= grow;
        this.gVel[i3 + 2] *= grow;
        this.gPos[i3] += this.gVel[i3] * dt;
        this.gPos[i3 + 2] += this.gVel[i3 + 2] * dt;
        const rr = Math.hypot(this.gPos[i3], this.gPos[i3 + 2]) / discR;
        this.gPos[i3 + 1] = surfaceY + heapHeightAt(Math.min(1, rr), this.heapPeakH) + 0.004;
        if (rr >= 0.97 || this.gAge[i] >= this.gLife[i]) {
          this.gAge[i] = this.gLife[i];
          continue;
        }
        live++;
        inside++;
        continue;
      }
      this.gVel[i3 + 1] -= GRAIN_GRAVITY * dt;
      // Terminal-velocity cap for the falling column (kind 0 stream + kind 2
      // plume/droplets) so it reaches the bed without thinning; kind 1 spill stays
      // ballistic (its arc is tuned).
      if (this.gKind[i] !== 1 && this.gVel[i3 + 1] < -GRAIN_VT) this.gVel[i3 + 1] = -GRAIN_VT;
      this.gPos[i3] += this.gVel[i3] * dt;
      this.gPos[i3 + 1] += this.gVel[i3 + 1] * dt;
      this.gPos[i3 + 2] += this.gVel[i3 + 2] * dt;
      this.gAge[i] += dt;
      // Stream grains vanish INTO the bed — the bulk surface PLUS the heap cone at
      // the grain's radius (heapHeightAt; 0 when peakH is 0, i.e. marbles/idle). A
      // fraction of crest contacts become down-flank rollers instead of dying.
      if (this.gKind[i] === 0) {
        const rr = Math.min(1, Math.hypot(this.gPos[i3], this.gPos[i3 + 2]) / discR);
        if (this.gPos[i3 + 1] <= surfaceY + heapHeightAt(rr, this.heapPeakH)) {
          if (this.heapPeakH > 0.02 && this.grainRng() < ROLLER_FRACTION) {
            this.startRoller(i, i3, surfaceY, discR);
          } else {
            this.gAge[i] = this.gLife[i];
          }
          continue;
        }
      }
      // Plume chips (kind 2) fall back onto the heap after the splash: on the
      // DESCENDING leg they die where they meet the local profile, instead of aging
      // out mid-air (which under a heap reads as passing through it). Sand only —
      // marble splash droplets are also kind 2, and killing them at the pool level
      // ends their protected age-out early, sealing the mouth iris sooner.
      if (this.sandRegime && this.gKind[i] === 2 && this.gVel[i3 + 1] < 0) {
        const rr = Math.min(1, Math.hypot(this.gPos[i3], this.gPos[i3 + 2]) / discR);
        if (this.gPos[i3 + 1] <= surfaceY + heapHeightAt(rr, this.heapPeakH)) {
          this.gAge[i] = this.gLife[i];
          continue;
        }
      }
      live++;
      // Stream (0) + plume (2) are inside the vessel and hold the iris; spill (1)
      // arcs over the shoulder and must not (else the mouth stays open past complete).
      if (this.gKind[i] !== 1) inside++;
    }
    this.grainLiveCount = live;
    this.insideGrainLiveCount = inside;
    this.grains.visible = live > 0;
    const g = this.grainGeo;
    (g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('aVel') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('aColor') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('aAge') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('aLife') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('aSize') as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Convert a stream grain dying at the crest into a down-flank ROLLER (kind 3):
   *  aimed outward along the local flank, pinned to the surface, short-lived. Reuses
   *  the dying grain's slot (budget-neutral) and its colour/size. */
  private startRoller(i: number, i3: number, surfaceY: number, discR: number): void {
    const rad = Math.hypot(this.gPos[i3], this.gPos[i3 + 2]);
    let dirX: number;
    let dirZ: number;
    if (rad > 1e-4) {
      dirX = this.gPos[i3] / rad;
      dirZ = this.gPos[i3 + 2] / rad;
    } else {
      const a = this.grainRng() * Math.PI * 2; // born at the apex → a random azimuth
      dirX = Math.cos(a);
      dirZ = Math.sin(a);
    }
    const speed = ROLLER_SPEED_MIN + this.grainRng() * (ROLLER_SPEED_MAX - ROLLER_SPEED_MIN);
    this.gVel[i3] = dirX * speed;
    this.gVel[i3 + 1] = 0;
    this.gVel[i3 + 2] = dirZ * speed;
    this.gKind[i] = 3;
    this.gAge[i] = 0;
    this.gLife[i] = ROLLER_LIFE_MIN + this.grainRng() * (ROLLER_LIFE_MAX - ROLLER_LIFE_MIN);
    this.gPos[i3 + 1] = surfaceY + heapHeightAt(Math.min(1, rad / discR), this.heapPeakH) + 0.004;
  }

  /** The stream's contact cues where the column meets the pool: the churn-spot
   *  surface roil plus a throttled flash ripple. Deliberately NO thrown grains —
   *  a kicked-up chip cloud reads as confetti at close zoom, so the contact is
   *  carried by the surface animation alone. */
  private updateStreamContact(dt: number): void {
    // The column lands on the heap crest (axial → heapHeightAt(0, peakH) = peakH).
    const contactY = -R_LIQ + this.heapBulkH + this.heapPeakH;
    if (this.mouthPlaneY <= contactY + 0.02) return; // crest at the mouth — no fall, no contact
    // The stream-churn spot: slot 0 pinned at the contact centre, kept fresh each
    // frame while the stream is live (amp is the stream's activity).
    this.bumpChurn(0, 0, 0, 0.9);
    // A throttled surface flash so the contact reads even at a glance — tightened
    // to ~0.06 s so the contact is unmissable.
    this.plumeRippleT -= dt;
    if (this.plumeRippleT <= 0) {
      this.plumeRippleT = 0.06;
      this.removedPos[0] = 0;
      this.removedPos[2] = 0;
      this.spawnRipple(0); // reuse the surface-splash flash (sand + marbles never run together)
    }
  }

  /** A slender molten runoff from a melting boulder's base down to the pool — the
   *  causal cue that the ball melting on the glass FEEDS the pool (vs a solid on top +
   *  a pool that seems to appear on its own). Reuses the grain pool as kind-0 (a
   *  boulder's heap crest is 0, so kind-0 dies exactly at the pool), warm and thin.
   *  Only runs while a gap separates the ball base from the pool; tapers as it sinks in. */
  private emitRunoff(ballBaseY: number, poolY: number, r: number, dt: number): void {
    if (ballBaseY <= poolY + 0.06) { this.runoffCarry = 0; return; } // ball reached the pool — no gap
    const budget = pourBudget(dt, RUNOFF_RATE, this.runoffCarry);
    this.runoffCarry = budget.carry;
    for (let k = 0; k < budget.spawns; k++) {
      const a = this.grainRng() * Math.PI * 2;
      const rad = this.grainRng() * r * 0.22; // a tight strand at the ball's base
      const x = Math.cos(a) * rad;
      const z = Math.sin(a) * rad;
      const vx = (this.grainRng() - 0.5) * 0.06;
      const vz = (this.grainRng() - 0.5) * 0.06;
      const vy = -0.35 - this.grainRng() * 0.25; // drips down toward the pool
      const size = GRAIN_SIZE_MIN + this.grainRng() * (GRAIN_SIZE_MAX - GRAIN_SIZE_MIN);
      this.grainColorScratch.copy(RUNOFF_COLOR).multiplyScalar(0.85 + this.grainRng() * 0.3);
      this.writeGrain(this.nextStreamSlot(), x, ballBaseY, z, vx, vy, vz, size, 3.0, 0, this.grainColorScratch);
    }
  }

  /** Next round-robin slot in the stream range [0, budget − SPILL_RESERVE). */
  private nextStreamSlot(): number {
    const cap = Math.max(1, this.grainBudget - SPILL_RESERVE);
    const i = this.grainCursor % cap;
    this.grainCursor = (this.grainCursor + 1) % cap;
    return i;
  }

  /** Next round-robin slot in the spill/plume range [budget − SPILL_RESERVE, budget). */
  private nextSpillSlot(): number {
    const base = Math.max(1, this.grainBudget - SPILL_RESERVE);
    const span = Math.max(1, this.grainBudget - base);
    const i = base + (this.spillCursor % span);
    this.spillCursor++;
    return i;
  }

  /** Write one grain into slot i. */
  private writeGrain(
    i: number, x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    size: number, life: number, kind: number, color: THREE.Color,
  ): void {
    const i3 = i * 3;
    this.gPos[i3] = x; this.gPos[i3 + 1] = y; this.gPos[i3 + 2] = z;
    this.gVel[i3] = vx; this.gVel[i3 + 1] = vy; this.gVel[i3 + 2] = vz;
    this.gColor[i3] = color.r; this.gColor[i3 + 1] = color.g; this.gColor[i3 + 2] = color.b;
    this.gAge[i] = 0;
    this.gLife[i] = life;
    this.gSize[i] = size;
    this.gKind[i] = kind;
  }

  /** A per-grain colour: ONE whole native-saturation fleck from the filler map
   *  (never an average of stops), so a stream of Earths reads speckled —
   *  ocean-blue, land-brown, cloud-white — not milky. `gain` brightens the impact
   *  plume's core; a small brightness jitter keeps the column from banding. */
  private grainColor(out: THREE.Color, gain: number): void {
    const flecks = this.grainFlecks;
    const idx = Math.min(flecks.length - 1, (this.grainRng() * flecks.length) | 0);
    out.copy(flecks[idx]).multiplyScalar((0.9 + this.grainRng() * 0.22) * gain);
  }

  // ---- boulders (scripted drop → slump, never the solver) ------------------

  private updateBoulders(dt: number, ctl: PourControl): PourStatus {
    this.boulderTarget = ctl.targetCount;
    const n = this.simN;
    const totalBoulders = Math.max(1, Math.ceil(n - 1e-9));
    const meltWindow = THREE.MathUtils.lerp(
      COMPARE_TUNABLES.boulderMeltMaxS,
      COMPARE_TUNABLES.boulderMeltMinS,
      THREE.MathUtils.clamp((totalBoulders - 2) / 23, 0, 1),
    );
    const r = this.ballRadius; // the boulder radius = n^(-1/3)
    const restY = CONTAINER_R + r * 0.99;

    if (!ctl.paused) {
      const last = this.boulders[this.boulders.length - 1];
      // A raised target resumes the HELD partial boulder first: its remaining
      // solid melts on (up to one whole ball) before any new boulder drops.
      // Without this, every partial raise would claim a fresh pool slot and two
      // raises would strand the pour at the 2-mesh cap.
      if (last && last.volumeFrac < 1 - 1e-9 && this.boulderCommitted < this.boulderTarget - 0.001) {
        const extra = Math.min(1 - last.volumeFrac, this.boulderTarget - this.boulderCommitted);
        last.volumeFrac += extra;
        this.boulderCommitted += extra;
      }
      // Drop the next boulder once the current one is ~60% melted (or on an empty stage).
      const overlap = COMPARE_TUNABLES.boulderOverlapAt;
      const ready = last === undefined || (last.state === 'melt' && last.meltedFrac >= overlap * last.volumeFrac);
      if (this.boulderCommitted < this.boulderTarget - 0.001 && this.boulders.length < 2 && ready) {
        this.spawnBoulder(r, meltWindow);
      }
      for (let k = this.boulders.length - 1; k >= 0; k--) {
        const b = this.boulders[k];
        if (b.state === 'descend') {
          b.t = Math.min(1, b.t + dt / COMPARE_TUNABLES.boulderDescentS);
          if (b.t >= 1) b.state = 'melt';
        } else {
          const before = b.meltedFrac;
          b.meltedFrac = Math.min(b.volumeFrac, b.meltedFrac + dt / b.meltWindow);
          this.melted += b.meltedFrac - before;
          // A boulder that finished melting its share sinks into the pool and is
          // freed — full boulders always, and the last PARTIAL one too on a full
          // fill (else a solid sliver survives into the sealed complete vessel; a
          // partial *target* still holds it mid-slump, which is the design).
          const fullFill = this.boulderTarget >= this.simN - 0.01;
          const done = b.meltedFrac >= b.volumeFrac - 1e-3;
          if (done && (b.volumeFrac >= 0.999 || fullFill)) {
            this.boulderPool[b.slot].visible = false;
            this.boulders.splice(k, 1);
            continue;
          }
        }
      }
    }

    const molten = this.fillerIsSun || this.boulders.some((b) => b.state === 'melt');
    this.updateLiquid(dt, molten);
    for (const b of this.boulders) this.poseBoulder(b, restY, r);

    // Molten runoff strand: from the first melting boulder still above the pool, so
    // the pour reads as the ball melting INTO the pool. One emit/frame (shared carry).
    const poolY = -R_LIQ + this.liquidLevelRendered;
    if (!ctl.paused) {
      let emitted = false;
      for (const b of this.boulders) {
        // Only while the ball is actively transferring volume: a partial-target
        // boulder HOLDS in the melt state at its share forever (the designed
        // mid-slump rest), and a held ball must not drip an endless strand.
        if (emitted || b.state !== 'melt' || b.meltedFrac >= b.volumeFrac - 1e-3) continue;
        const t = b.meltedFrac;
        const yy = THREE.MathUtils.lerp(restY, poolY - r * 0.4, t);
        const baseY = yy - r * (1 - 0.8 * t) * (1 - 0.3 * t); // bottom of the shrunk ball
        if (baseY > poolY + 0.06) { this.emitRunoff(baseY, poolY, r, dt); emitted = true; }
      }
      if (!emitted) this.runoffCarry = 0;
    }
    this.updateGrains(dt); // integrate the runoff strand (boulders otherwise run no grains)

    this.fillerMesh.count = 0;
    this.fillerMesh.instanceMatrix.needsUpdate = true;
    this.poured = this.melted; // boulders report progress as the melted volume
    const done =
      this.boulderCommitted >= this.boulderTarget - 0.001 &&
      this.boulders.every((b) => b.meltedFrac >= b.volumeFrac - 1e-3) &&
      this.melted > 1e-4;
    return this.buildStatus(done);
  }

  private spawnBoulder(r: number, meltWindow: number): void {
    const used = new Set(this.boulders.map((b) => b.slot));
    const slot = used.has(0) ? 1 : 0;
    const volumeFrac = Math.min(1, this.boulderTarget - this.boulderCommitted);
    this.boulderCommitted += volumeFrac;
    const u = this.boulderUniforms[slot];
    u.uMap.value = this.fillerMap ?? this.emptyTex;
    // Melt-boulder emissive intensity: brighter than the sub-unity giant (0.95) —
    // a small Sun boulder genuinely blooms while keeping its granulation readable
    // and the frame inside the whiteout budget (measured: 1.6 washed the core).
    // (Sun/Sun, n=1, is the one Sun-boulder pair.)
    u.uEmber.value = this.fillerIsSun ? 1.3 : 0;
    u.uMoltenLo.value.copy(this.liquidUniforms.uPalette1.value);
    u.uMeltFront.value = -1.3;
    u.uLodBias.value = 0; // the loom's sharper-mip bias is sub-unity-only
    this.boulderPool[slot].visible = true;
    this.boulders.push({
      slot,
      volumeFrac,
      state: 'descend',
      t: 0,
      meltWindow,
      meltedFrac: 0,
      radius: r,
      restY: CONTAINER_R + r * 0.99,
    });
  }

  /** Position + squash a boulder for its descent or its molten slump. */
  private poseBoulder(b: Boulder, restY: number, r: number): void {
    const mesh = this.boulderPool[b.slot];
    const u = this.boulderUniforms[b.slot];
    u.uTime.value = this.liquidTime;
    if (b.state === 'descend') {
      const e = 1 - (1 - b.t) * (1 - b.t); // ease-out fall
      const bounce = Math.sin(b.t * Math.PI) * r * 0.06 * (b.t > 0.8 ? 1 : 0); // tiny contact settle
      mesh.position.set(0, THREE.MathUtils.lerp(2.2, restY, e) + bounce, 0);
      mesh.scale.setScalar(r);
      u.uMeltFront.value = -1.3;
    } else {
      const t = b.meltedFrac; // 0..1 melt progress (caps at volumeFrac for the partial last)
      const surfaceY = -R_LIQ + this.liquidLevelRendered;
      // Sink from the glass top down into the rising pool as it melts.
      const y = THREE.MathUtils.lerp(restY, surfaceY - r * 0.4, t);
      mesh.position.set(0, y, 0);
      // Visibly DIMINISH as it melts — the solid is consumed into the pool (its volume
      // becomes the rising liquid), so it shrinks overall with a slight molten slump,
      // never the old footprint-growing spread that read as a static ball on the glass.
      const shrink = 1 - 0.8 * t;
      mesh.scale.set(r * shrink * (1 + 0.12 * t), r * shrink * (1 - 0.30 * t), r * shrink * (1 + 0.12 * t));
      // Molten front climbs the ball: object-y −1.2 (nothing molten) → +1 (all molten).
      u.uMeltFront.value = -1.2 + 2.2 * t;
    }
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  /** Called after main.ts reapplies the render resolution on a window resize
   *  (which may reclamp the renderer's pixel ratio). Star point sizes track
   *  the renderer's ratio, so retune them to the new value. */
  onResize(): void {
    setStarfieldPixelRatio(this.starfield, this.renderer.getPixelRatio());
  }

  /** The starfield's applied point-size pixel ratio — QA reads this to assert
   *  onResize retuned it AFTER the renderer's ratio was reapplied on a DPR change. */
  getStarfieldPixelRatio(): number {
    return (this.starfield.material as THREE.ShaderMaterial).uniforms?.pixelRatio?.value ?? 0;
  }

  /** Dim the whole scene during an in-mode pair swap (key light + glass). */
  setDimmed(dim: boolean): void {
    this.keyLight.intensity = dim ? KEY_LIGHT_INTENSITY * LOADING_DIM : KEY_LIGHT_INTENSITY;
    this.fillLight.intensity = dim ? FILL_HEMI_INTENSITY * LOADING_DIM : FILL_HEMI_INTENSITY;
    this.glassUniforms.uDim.value = dim ? LOADING_DIM : 1;
  }

  /** Hold the vessel hidden while a new pair loads: snap the reveal to 0 (the
   *  outgoing map + halo vanish at once), hide the current halo, and hide the
   *  outgoing pair's CONTENTS — the update loop stops driving the sim through the
   *  load, so a stale melt ball / pile / preview would otherwise float naked over
   *  the stars with the glass gone. configurePour rebuilds the new pair's staging
   *  from zero and the per-frame drivers re-show what the new pair needs.
   *  `revealPair` eases the vessel back in once the pair is fully applied.
   *  Idempotent; safe on entry (the mode veil covers it). */
  beginPairLoad(): void {
    this.revealEase = 0;
    this.revealTarget = 0;
    this.glassUniforms.uReveal.value = 0;
    if (this.atmosphere) {
      (this.atmosphere.material as THREE.ShaderMaterial).uniforms.alphaScale.value = 0;
    }
    this.fillerMesh.count = 0;
    this.fillerMesh.instanceMatrix.needsUpdate = true;
    for (const m of this.boulderPool) m.visible = false;
    this.liquidBody.visible = false;
    this.liquidDisc.visible = false;
    this.previewMesh.visible = false;
    this.previewOpacity = 0;
    this.ghostLine.visible = false;
    this.ghostLineOpacity = 0;
  }

  /** The pair is fully presented — ease the vessel in from the load hold. */
  revealPair(): void {
    this.revealTarget = 1;
  }

  /** Ease the presentation toward its target every frame (runs even while a pair
   *  loads, so the hold holds and the ease-in plays). Drives the glass alpha + the
   *  halo's presence, and the cold-open empty lift — all at their rest values on a
   *  settled presented frame, so that frame is byte-identical. */
  tickReveal(dt: number): void {
    this.revealEase += (this.revealTarget - this.revealEase) * (1 - Math.exp(-dt / 0.12));
    if (Math.abs(this.revealTarget - this.revealEase) < 0.001) this.revealEase = this.revealTarget;
    this.glassUniforms.uReveal.value = this.revealEase;
    if (this.atmosphere) {
      (this.atmosphere.material as THREE.ShaderMaterial).uniforms.alphaScale.value =
        ATMOSPHERE_GHOST_ALPHA * this.revealEase;
    }
    // Cold-open empty lift: occupied volume fraction (whichever counter leads the
    // fill), gone over the first few percent so the empty vessel reads as a full
    // subject and the lift is provably out once the pour is under way. Eased in
    // TIME as well: a boulder commits its whole fraction the frame it spawns, so
    // the raw occupancy step would pop the ghost dim — the house lights dim over a
    // beat instead. Off for the sub-unity loom (that vessel is full of the giant).
    const occupied = Math.max(this.poured, this.melted, this.boulderCommitted) / Math.max(this.simN, 1e-9);
    const liftTarget =
      this.glassUniforms.uLoomLit.value > 0.5 ? 0 : 1 - THREE.MathUtils.smoothstep(occupied, 0, EMPTY_LIFT_FADE_END);
    this.emptyLiftEase += (liftTarget - this.emptyLiftEase) * (1 - Math.exp(-dt / 0.25));
    if (Math.abs(liftTarget - this.emptyLiftEase) < 0.001) this.emptyLiftEase = liftTarget;
    this.glassUniforms.uEmptyLift.value = this.emptyLiftEase;
  }

  dispose(): void {
    this.group.visible = false;
    this.scene.remove(this.group);

    this.glassGeo.dispose();
    this.backMat.dispose();
    this.frontMat.dispose();

    this.fillerGeo.dispose();
    (this.fillerMesh.material as THREE.Material).dispose();
    this.fillerMesh.dispose();
    this.fillerMap?.dispose();
    this.fillerMap = null;

    // Liquid, ghost line, ripples, boulders (the preview shares the filler
    // material + geometry, so it is not disposed here).
    this.liquidGeo.dispose();
    (this.liquidBody.material as THREE.Material).dispose();
    this.marbleDiscGeo.dispose();
    this.sandDiscGeo.dispose();
    (this.liquidDisc.material as THREE.Material).dispose();
    this.ghostLine.geometry.dispose();
    this.ghostLineMat.dispose();
    this.ripples.geometry.dispose();
    this.rippleMat.dispose();
    this.grainGeo.dispose();
    this.grainMat.dispose();
    this.boulderGeo.dispose();
    for (const b of this.boulderPool) (b.material as THREE.Material).dispose();

    if (this.atmosphere) {
      this.atmosphere.geometry.dispose();
      (this.atmosphere.material as THREE.Material).dispose();
      this.atmosphere = null;
    }

    this.starfield.geometry.dispose();
    (this.starfield.material as THREE.Material).dispose();

    this.ghostTex?.dispose();
    this.ghostTex = null;
    this.emptyTex.dispose();
  }
}

// --- module helpers --------------------------------------------------------

/** Dim VC's own starfield instance by scaling its per-vertex colour buffer. */
function dimStarfield(stars: THREE.Points, dim: number): void {
  const color = stars.geometry.getAttribute('color') as THREE.BufferAttribute;
  const arr = color.array as Float32Array;
  for (let i = 0; i < arr.length; i++) arr[i] *= dim;
  color.needsUpdate = true;
}

function makeEmptyTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 1;
  c.height = 1;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 1, 1);
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

interface MapStats {
  /** Mean Rec.709 luminance (0 if unreadable) — the ghost gain reads this. */
  meanLum: number;
  /** Four colours at the 10/40/70/95th luminance percentiles — the marbling ramp. */
  palette: THREE.Color[];
  /** A spread of NATIVE-saturation texels for the sand grains — each grain takes
   *  one whole (nearest-sample, un-averaged) so the stream reads speckled: an
   *  Earth stream is ocean-blue + land-brown + cloud-white flecks, not milky. */
  flecks: THREE.Color[];
}

const GRAIN_FLECK_COUNT = 16;

/** A fallback ramp when a body has no readable map (Sun, tainted canvas). */
function defaultPalette(): THREE.Color[] {
  return [
    new THREE.Color(0x1a2740),
    new THREE.Color(0x3a5a86),
    new THREE.Color(0x9fb6c8),
    new THREE.Color(0xf2f4f0),
  ];
}

/** Body-coloured fallback for a photo whose canvas readback is unavailable or
 * silently zero-filled. The four stops preserve the body's identity while still
 * spanning enough luminance for the sand marbling and per-grain flecks. */
function tintedFallbackStats(tint: number): MapStats {
  const base = new THREE.Color(tint);
  const palette = [
    base.clone().multiplyScalar(0.24),
    base.clone().multiplyScalar(0.52),
    base.clone().multiplyScalar(0.78),
    base.clone().lerp(new THREE.Color(0xffffff), 0.38),
  ];
  const r = ((tint >> 16) & 0xff) / 255;
  const g = ((tint >> 8) & 0xff) / 255;
  const b = (tint & 0xff) / 255;
  const meanLum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return { meanLum, palette, flecks: palette.map((c) => c.clone()) };
}

/**
 * One 32×32 readback of a body's colour map, returning its mean luminance (for
 * the ghost gain), a 4-stop marbling ramp (the 10/40/70/95th luminance
 * percentiles), and a spread of native-saturation fleck colours for the sand
 * grains — a single pass so the ghost, the molten-liquid palette, and the grain
 * flecks never read the same canvas twice. Unreadable image → mean 0 + defaults.
 */
function sampleMapStats(image: CanvasImageSource | null, fallbackTint?: number): MapStats {
  const fallback = (): MapStats => fallbackTint === undefined
    ? { meanLum: 0, palette: defaultPalette(), flecks: defaultPalette() }
    : tintedFallbackStats(fallbackTint);
  if (!image) return fallback();
  const size = 32;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return fallback();
  try {
    ctx.drawImage(image, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;
    const n = size * size;
    const samples: { luma: number; r: number; g: number; b: number }[] = new Array(n);
    let sum = 0;
    for (let p = 0; p < n; p++) {
      const i = p * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      sum += luma;
      samples[p] = { luma, r, g, b };
    }
    // Safari can successfully execute drawImage/getImageData before the decoded
    // pixels are CPU-readable, yielding transparent/black zeros without throwing.
    // No supported body colour map is genuinely all-black, so treating this as an
    // unreadable image is both safe and prevents a finite-black palette from
    // bypassing the shader's NaN guards and turning the whole sand mass black.
    if (sum <= 0) return fallback();
    samples.sort((a, b) => a.luma - b.luma);
    const at = (idx: number): THREE.Color => {
      const s = samples[Math.min(n - 1, Math.max(0, idx))];
      return new THREE.Color().setRGB(s.r / 255, s.g / 255, s.b / 255, THREE.SRGBColorSpace);
    };
    const pick = (frac: number): THREE.Color => at(Math.floor(frac * n));
    // Flecks: an even spread across the luminance-sorted texels (dark ocean →
    // bright cloud), each kept whole so its native saturation survives.
    const flecks: THREE.Color[] = [];
    for (let k = 0; k < GRAIN_FLECK_COUNT; k++) {
      flecks.push(at(Math.floor(((k + 0.5) / GRAIN_FLECK_COUNT) * n)));
    }
    return { meanLum: sum / n, palette: [pick(0.1), pick(0.4), pick(0.7), pick(0.95)], flecks };
  } catch {
    return fallback(); // tainted or otherwise unreadable canvas
  }
}

/**
 * A unit-radius disc in the xy plane, radially re-tessellated into `rings`
 * concentric bands × `segments` azimuthal (a centre vertex + rings, triangulated)
 * — NOT CircleGeometry's zero-interior fan, whose only interior vertex is the
 * centre (a vertex mound on it is a full-width cone). The mound's radial falloff
 * lives in the vertex shader (object rr), so the interior rings carry the smooth
 * cap. position.xy is the unit disc (the disc shader reads it as vXz).
 */
function makeRadialDiscGeometry(
  rings: number,
  segments: number,
  radiusAt: (t: number) => number = (t) => t,
): THREE.BufferGeometry {
  const positions: number[] = [0, 0, 0]; // centre
  const uvs: number[] = [0.5, 0.5];
  for (let ri = 1; ri <= rings; ri++) {
    const r = radiusAt(ri / rings);
    for (let s = 0; s < segments; s++) {
      const a = (2 * Math.PI * s) / segments;
      positions.push(Math.cos(a) * r, Math.sin(a) * r, 0);
      uvs.push(Math.cos(a) * r * 0.5 + 0.5, Math.sin(a) * r * 0.5 + 0.5);
    }
  }
  const indices: number[] = [];
  for (let s = 0; s < segments; s++) {
    indices.push(0, 1 + s, 1 + ((s + 1) % segments)); // inner fan (centre → ring 1)
  }
  for (let ri = 1; ri < rings; ri++) {
    const b0 = 1 + (ri - 1) * segments;
    const b1 = 1 + ri * segments;
    for (let s = 0; s < segments; s++) {
      const s1 = (s + 1) % segments;
      indices.push(b0 + s, b1 + s, b1 + s1);
      indices.push(b0 + s, b1 + s1, b0 + s1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return geo;
}

/**
 * A dense radial disc for the sand heap's repose cone, with ring spacing biased
 * toward the foot (the glass wall) and the tip (the axis) via a cosine radius
 * mapping — dense where the silhouette curves sharpest at both ends, sparse across
 * the straight mid-flank — so a cone up to ~0.6 units tall reads smooth where the
 * coarse marble fan would crease.
 */
function makeSandDiscGeometry(rings: number, segments: number): THREE.BufferGeometry {
  return makeRadialDiscGeometry(rings, segments, (t) => 0.5 - 0.5 * Math.cos(Math.PI * t));
}

/** A unit-radius ring (LineLoop) of `n` segments in the xz plane, scaled per frame. */
function makeRingGeometry(n: number): THREE.BufferGeometry {
  const pts = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    pts[i * 3] = Math.cos(a);
    pts[i * 3 + 1] = 0;
    pts[i * 3 + 2] = Math.sin(a);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
  return geo;
}

/**
 * The ripple pool: RIPPLE_POOL instanced quads whose per-instance age + centre
 * drive a shader that billboards, grows, and fades each splash. One mesh, one
 * additive draw; the scene ages them and reseeds the oldest on a splash.
 */
function makeRipplePool(): { mesh: THREE.Mesh; mat: THREE.ShaderMaterial } {
  const base = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.attributes.position = base.attributes.position;
  geo.attributes.uv = base.attributes.uv;
  const age = new Float32Array(RIPPLE_POOL).fill(RIPPLE_LIFE); // all start dead
  const center = new Float32Array(RIPPLE_POOL * 3);
  geo.setAttribute('aAge', new THREE.InstancedBufferAttribute(age, 1));
  geo.setAttribute('aCenter', new THREE.InstancedBufferAttribute(center, 3));
  geo.instanceCount = RIPPLE_POOL;
  const mat = new THREE.ShaderMaterial({
    uniforms: {},
    vertexShader: RIPPLE_VERTEX,
    fragmentShader: RIPPLE_FRAGMENT,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  base.dispose();
  return { mesh, mat };
}

/** Uniform-random unit quaternion (Shoemake) into `out`. */
function randomQuat(out: THREE.Quaternion, rng: () => number): void {
  const u1 = rng();
  const u2 = rng();
  const u3 = rng();
  const s1 = Math.sqrt(1 - u1);
  const s2 = Math.sqrt(u1);
  out.set(
    s1 * Math.sin(2 * Math.PI * u2),
    s1 * Math.cos(2 * Math.PI * u2),
    s2 * Math.sin(2 * Math.PI * u3),
    s2 * Math.cos(2 * Math.PI * u3),
  );
}

/** The app's atmosphere glow shell, dimmed for the ghost, keyed to the studio light. */
function makeAtmosphereGhost(config: AtmosphereConfig): THREE.Mesh {
  // The glow shell is WHOLE — it must NOT inherit the mouth cut, or its hard
  // edge reads as a glitch from high angles (the soft additive halo arcing over
  // the opening is far better than a sliced rim). The lip ring frames the mouth.
  const geo = new THREE.SphereGeometry(CONTAINER_R * config.scale, 64, 32);
  const mat = new THREE.ShaderMaterial({
    vertexShader: atmosphereVertexShader,
    fragmentShader: atmosphereFragmentShader,
    uniforms: {
      uSunDirWorld: { value: KEY_LIGHT_DIR.clone() },
      alphaScale: { value: ATMOSPHERE_GHOST_ALPHA }, // the ghost's fixed presence
      uDayColor: { value: new THREE.Vector3(...config.dayColor) },
      uSunsetColor: { value: new THREE.Vector3(...config.sunsetColor) },
      uMieColor: { value: new THREE.Vector3(...config.mieColor) },
      uRayleighStrength: { value: config.rayleighStrength },
      uMieStrength: { value: config.mieStrength },
      uMieG: { value: config.mieG },
      uPower: { value: config.power },
      uIntensity: { value: config.intensity },
      uHaloStrength: { value: config.haloStrength },
      uPlanetRadius: { value: CONTAINER_R },
    },
    transparent: true,
    side: THREE.BackSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 4; // over the front shell, so the halo adds on top of the rim
  return mesh;
}
