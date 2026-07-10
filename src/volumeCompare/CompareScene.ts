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
import { createPlanetariumStarfield } from '../planetarium/world/starfield';
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
  type Comparison,
  type FillRegime,
  type SpawnCaps,
} from './compareLogic';

// --- studio scale + framing ------------------------------------------------
// The container's inner radius is 1 unit; the glass shells sit exactly there.
const CONTAINER_R = 1.0;
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
const FILL_SHINE_INTENSITY = 0.55;
// Hemisphere studio fill for the fillers only (scoped via the ShaderMaterial
// bodies ignoring scene lights). Warm-neutral sky, dark ground — lifts night
// sides to a readable fraction of day without flattening the key's direction.
const FILL_SKY_COLOR = 0xaeb6c6;
const FILL_GROUND_COLOR = 0x2a2622;
const FILL_HEMI_INTENSITY = 0.55;

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
// The rendered liquid volume is the logical fillFraction (= melted / N) scaled
// by this R_liq sphere volume, so the liquid tops the vessel exactly when
// melted = N. Feeding raw ball volumes (V_container / N each) here instead
// would fill ~1.5% early, since R_liq³ = 0.985 of the container's.
const LIQUID_SPHERE_VOLUME = (4 / 3) * Math.PI * R_LIQ * R_LIQ * R_LIQ;

// --- pour feel -------------------------------------------------------------
// The solver constrains balls to a bowl a hair inside the glass (P2's scatter
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
// The sub-unity filler's render radius is capped here so its loom pose stays
// framable — a genuinely enormous filler (Moon-in-Sun) would otherwise put the
// camera inside it. Well past every real Try-next pair (Earth-in-Jupiter 10.97).
const SUB_UNITY_MAX_RF = 12;
// Above this filler radius the sub-unity pose keeps fitting both (filler wedged
// in the mouth, poking well out) vs framing the loom (glass in the lower third,
// giant overflowing). Tunable.
export const SUB_UNITY_LOOM_RF = 2.5;
// Sub-unity renders the vessel WITH a mouth (revising P2's whole-vessel gate):
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

// --- instanced fillers -----------------------------------------------------
const INSTANCE_CAPACITY = 4000;
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
uniform vec3 uSunDir;
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
uniform float uFill;        // 0..1 liquid fill — warms the rim as the glass fills
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec3 vObjPos;
varying vec2 vUv;

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
  // falloff ~0.028 wide), tinted like the glint, not a fat collar. Only its
  // centre crosses the bloom threshold, so the halo stays about the line's width.
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

  // One sharp HDR specular glint from the key — a tight ping (bloom supplies the
  // halo), deliberately over the 0.92 threshold so the blooming hotspot IS the
  // "reflective surface" cue. Front shell only. The glint also lifts alpha at
  // its core so the bright colour actually shows through the transparent shell
  // (a low-alpha fragment would mute it to a smudge).
  if (uBackShell < 0.5) {
    vec3 R = reflect(-uSunDir, N);
    float glint = pow(max(dot(R, V), 0.0), 380.0);
    col += uWarmTint * glint * 3.0;
    alpha = max(alpha, glint);
  }

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
    float ghostAlpha = mix(0.07, 0.34, pow(fres, 1.3));
    vec3 ghost = min(texture2D(uGhostMap, vUv).rgb, vec3(uGhostKnee));
    col += ghost * uGhostGain * ghostAlpha;
  } else if (uBackShell > 0.5) {
    // A ghost-less container (the Sun) would otherwise be a void behind glass:
    // give the vessel an ember interior instead — its own colour pulled toward
    // deep fire, amplitude sized against the low face-on alpha it blends under.
    vec3 emberTint = mix(uCatalogTint, vec3(1.0, 0.45, 0.15), 0.6);
    col += emberTint * (0.3 + 0.5 * (1.0 - ndv));
  }

  // Glass-cut rim: additive with the peak just over the 0.92 bloom threshold (a
  // thin hot line), alpha lifted so it reads through the transparent shell.
  col += uWarmTint * cutRim * 1.15;
  alpha = max(alpha, cutRim * 0.7);

  gl_FragColor = vec4(col * uDim, alpha * mouthEdge);
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
uniform vec3 uCatalogTint;// the filler's catalog colour (molten filler)
uniform vec3 uPalette0;   // filler map luminance percentiles → marbling ramp
uniform vec3 uPalette1;
uniform vec3 uPalette2;
uniform vec3 uPalette3;
uniform vec3 uCam;        // camera world position — the disc's wet specular lobe
uniform vec3 uSunDir;     // key direction for the sheen
float lqHash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
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
  // a finer octave so the wall isn't a smear.
  float m = lqFbm(vObjPos.xz * 4.5 + vec2(0.0, uTime * 0.05));
  float detail = lqFbm(vObjPos.xy * 13.0 + vec2(0.0, uTime * 0.04));
  vec3 crust = lqPalette(clamp(m, 0.0, 1.0)) * 0.44 * (0.9 + 0.2 * detail);
  // A deep warm glow rises only from the bottom while molten, staying BELOW the
  // 0.92 bloom threshold (max channel 0.85) — the body itself never blooms.
  vec3 warm = vec3(0.85, 0.4, 0.12);
  float glow = depth * depth * uHeat; // concentrated low, gone by the surface
  vec3 col = mix(crust, warm, glow * 0.75);
  // Wet specular sheen on the wall so the at-rest pool reads as molten liquid,
  // not matte clay (below the bloom threshold).
  vec3 N = normalize(vWorldNormal + vec3((detail - 0.5) * 0.25, 0.0, (m - 0.5) * 0.25));
  vec3 V = normalize(uCam - vWorldPos);
  float spec = pow(max(dot(reflect(-uSunDir, N), V), 0.0), 36.0);
  col += vec3(1.0, 0.86, 0.62) * spec * 0.5;
  gl_FragColor = vec4(col, 1.0);
}
`;

const LIQUID_DISC_VERTEX = /* glsl */ `
varying vec2 vXz;      // object-space xz (unit circle → radius 1)
varying vec3 vWorldPos;
void main(){
  vXz = position.xy; // CircleGeometry lies in the xy plane before the flat-rotate
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const LIQUID_DISC_FRAGMENT = /* glsl */ `
${LIQUID_COMMON}
varying vec2 vXz;
varying vec3 vWorldPos;
void main(){
  float rr = length(vXz);        // 0 centre → 1 outer rim (the glass wall)
  // Convection CRUST: dark cooled cells; only the cracks between them glow.
  vec2 drift = vec2(uTime * 0.045, -uTime * 0.035);
  float cell = lqFbm(vXz * 4.5 + drift);
  // A finer octave breaks the crust up so it never reads as a low-res smear.
  float detail = lqFbm(vXz * 16.0 + drift * 0.6);
  // Thin glowing veins — a high band of a finer fbm, ~15% coverage.
  float veins = smoothstep(0.60, 0.72, lqFbm(vXz * 11.0 - drift * 1.3));
  vec3 crust = lqPalette(clamp(cell * 0.85 + detail * 0.15, 0.0, 1.0)) * 0.38;
  crust *= 0.85 + 0.3 * detail; // subtle luminance breakup
  // Cracks: thin, warm, HDR only while molten (uHeat scales the CRACKS, not the
  // whole surface). ~1.2–1.8 at full heat, near-off at rest.
  vec3 crackGlow = vec3(1.0, 0.55, 0.2) * veins * (0.25 + 1.45 * uHeat);
  vec3 col = crust + crackGlow;
  // Wet specular sheen — reads as molten LIQUID, not matte paint. The surface
  // normal is +Y perturbed by the convection, reflecting the key into the eye.
  vec3 N = normalize(vec3((detail - 0.5) * 0.55, 1.0, (cell - 0.5) * 0.55));
  vec3 V = normalize(uCam - vWorldPos);
  float spec = pow(max(dot(reflect(-uSunDir, N), V), 0.0), 48.0);
  col += vec3(1.0, 0.86, 0.62) * spec * 0.7; // below the bloom threshold
  // A THIN blooming meniscus at the glass wall — visible at rest too (authored
  // over the 0.92 threshold, intensity ~2).
  float meniscus = smoothstep(0.93, 0.985, rr) * (1.0 - smoothstep(0.985, 1.02, rr));
  col += vec3(1.0, 0.72, 0.32) * meniscus * 2.0;
  gl_FragColor = vec4(col, 0.97);
}
`;

interface LiquidUniforms {
  uHeat: { value: number };
  uTime: { value: number };
  uSurfaceY: { value: number };
  uCatalogTint: { value: THREE.Color };
  uPalette0: { value: THREE.Color };
  uPalette1: { value: THREE.Color };
  uPalette2: { value: THREE.Color };
  uPalette3: { value: THREE.Color };
  uCam: { value: THREE.Vector3 };
  uSunDir: { value: THREE.Vector3 };
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
uniform vec3 uMoltenHi;   // liquid palette high stop
uniform float uMeltFront; // object-y of the molten front: -1.3 (off) climbing to +1 (all melted)
uniform float uEmber;     // 1 for the Sun boulder (emissive, no map lighting)
uniform float uTime;
varying vec2 vUv;
varying vec3 vNormalW;
varying float vObjY;
float bHash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
float bNoise(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(bHash(i),bHash(i+vec2(1,0)),f.x), mix(bHash(i+vec2(0,1)),bHash(i+vec2(1,1)),f.x), f.y); }
float bFbm(vec2 p){ float v=0.0,a=0.5; for(int i=0;i<4;i++){ v+=a*bNoise(p); p*=2.0; a*=0.5; } return v; }
void main(){
  vec3 base = texture2D(uMap, vUv).rgb;
  float ndl = max(dot(normalize(vNormalW), uSunDir), 0.0);
  // Saturn's real texture, key-lit with a dim starlight night floor.
  vec3 lit = base * (0.08 + 0.92 * ndl);
  if (uEmber > 0.5) lit = base * 1.4; // Sun: emissive body, no map to light
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
  uMoltenHi: { value: THREE.Color };
  uMeltFront: { value: number };
  uEmber: { value: number };
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

interface GhostLoad {
  tex: THREE.Texture;
  gain: number;
  meanLum: number;
}

interface GlassUniforms {
  uCam: { value: THREE.Vector3 };
  uSunDir: { value: THREE.Vector3 };
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
  /** 0..1 fill level — warms the rim tint as the liquid rises (glass reacts to contents). */
  uFill: { value: number };
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
  /** Odometer: balls poured so far (poured = live + melted). */
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

  // Scratch (no per-call allocation).
  private scratchMatrix = new THREE.Matrix4();
  private scratchPos = new THREE.Vector3();
  private scratchQuat = new THREE.Quaternion();
  private scratchScale = new THREE.Vector3();

  // --- the pour (solver + sim counters) ---
  private solver: SpherePhysics;
  private rng: () => number = mulberry32(SCATTER_SEED);
  private poured = 0; // odometer: live + melted
  private melted = 0; // balls turned to liquid
  private simN = 1; // the live comparison's ratio (fillFraction denominator)
  private across = 1; // balls-across (pour rate + in-flight cap scale with it)
  private solverMouthPlaneY = 2; // the solver bowl's mouth plane (pile-at-mouth brim signal)
  private fillerIsSun = false; // Sun liquid is emissive throughout (uHeat pinned)
  private sandRegime = false; // sand never pours in P3 — skip the solver reconfigure + preview
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
  private liquidDiscGeo: THREE.CircleGeometry;
  private liquidTime = 0;

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
    this.starfield = createPlanetariumStarfield();
    dimStarfield(this.starfield, STARFIELD_DIM);
    this.group.add(this.starfield);

    // 1×1 default texture so the ghost sampler is always bound (Sun has no map).
    this.emptyTex = makeEmptyTexture();

    // Glass shells — shared uniform block; only uBackShell differs per material.
    this.glassUniforms = {
      uCam: { value: new THREE.Vector3() },
      uSunDir: { value: KEY_LIGHT_DIR.clone() },
      uWarmTint: { value: WARM_TINT.clone() },
      uCatalogTint: { value: new THREE.Color(0xffffff) },
      uGhostMap: { value: this.emptyTex },
      uHasGhost: { value: 0 },
      uGhostGain: { value: 1 },
      uGhostKnee: { value: 1 },
      uMouthPlaneY: { value: 0.93 },
      uMouthOpen: { value: 0 },
      uDim: { value: 1 },
      uFill: { value: 0 },
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
      uCatalogTint: { value: new THREE.Color(0xffffff) },
      uPalette0: { value: new THREE.Color(0x1a2740) },
      uPalette1: { value: new THREE.Color(0x3a5a86) },
      uPalette2: { value: new THREE.Color(0x9fb6c8) },
      uPalette3: { value: new THREE.Color(0xf2f4f0) },
      uCam: { value: new THREE.Vector3() },
      uSunDir: { value: KEY_LIGHT_DIR.clone() },
    };
    this.liquidGeo = new THREE.SphereGeometry(R_LIQ, 48, 32);
    this.liquidBody = new THREE.Mesh(this.liquidGeo, this.makeLiquidBodyMaterial());
    this.liquidBody.renderOrder = 0; // opaque queue anyway; explicit for clarity
    this.liquidBody.visible = false;
    this.liquidDiscGeo = new THREE.CircleGeometry(1, 48); // scaled to the cap radius per frame
    this.liquidDisc = new THREE.Mesh(this.liquidDiscGeo, this.makeLiquidDiscMaterial());
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

    // Boulder pool — up to 2 full-res slumping meshes (≤2 visible at once).
    this.boulderGeo = new THREE.SphereGeometry(1, 48, 32);
    for (let i = 0; i < 2; i++) {
      const u: BoulderUniforms = {
        uMap: { value: this.emptyTex },
        uSunDir: { value: KEY_LIGHT_DIR.clone() },
        uMoltenLo: { value: new THREE.Color(0x3a5a86) },
        uMoltenHi: { value: new THREE.Color(0xf2f4f0) },
        uMeltFront: { value: -1.3 },
        uEmber: { value: 0 },
        uTime: { value: 0 },
      };
      const bmat = new THREE.ShaderMaterial({
        uniforms: u as unknown as Record<string, THREE.IUniform>,
        vertexShader: BOULDER_VERTEX,
        fragmentShader: BOULDER_FRAGMENT,
      });
      const bmesh = new THREE.Mesh(this.boulderGeo, bmat);
      bmesh.visible = false;
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
      // would render black). P4 does the Sun-as-filler properly.
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
    if (planet) return loadTexture(planet.textureKey);
    const moon = MOON_BY_NAME.get(name);
    if (moon?.textureKey) return loadTexture(moon.textureKey);
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
    const meanLum = sampleMapStats(tex.image as CanvasImageSource | null).meanLum;
    const gain = THREE.MathUtils.clamp(
      GHOST_TARGET_LUM / Math.max(meanLum, 0.05),
      GHOST_GAIN_MIN,
      GHOST_GAIN_MAX,
    );
    return { tex, gain, meanLum };
  }

  /** Measured mean luminance of the current ghost map (0 = no ghost); for the log. */
  private lastGhostMeanLum = 0;
  getGhostMeanLum(): number {
    return this.lastGhostMeanLum;
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
    // Sand never pours in P3 (P4 owns the particle stream), and its ball radius is
    // a thousandths-of-a-unit sliver: pushing that into the solver would size the
    // spatial grid to billions of cells and throw. Skip the radius reconfigure for
    // sand entirely — just reset to clear any pile from the previous pair, which
    // rebuilds the grid at the previous (safe) radius.
    if (!this.sandRegime) {
      this.solver.setParams({
        radius: this.ballRadius,
        sleepFrames: comparison.across < COMPARE_TUNABLES.boulderMaxAcross + 1 ? 40 : 34,
      });
    }
    this.solver.reset();
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
    // Sun as filler has no map to sample; its molten pool is a constant ember ramp
    // and stays emissive throughout (uHeat pinned in updateSim).
    this.liquidUniforms.uHeat.value = 0.15;
    this.fillerTint = bodyColor(filler);
    this.liquidUniforms.uCatalogTint.value.setHex(this.fillerTint);
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
    } else {
      // Sun (or a body with no map): warm-tinted glass, no ghost.
      this.glassUniforms.uGhostMap.value = this.emptyTex;
      this.glassUniforms.uHasGhost.value = 0;
      this.ghostTex = null;
      this.lastGhostMeanLum = 0;
    }
    this.glassUniforms.uCatalogTint.value.setHex(bodyColor(container));
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
    // Marbling palette: the molten liquid is the filler's own colours. Sun has no
    // map — its liquid keeps the constructor's ember ramp (set below).
    const palette =
      filler === 'Sun'
        ? [new THREE.Color(0x2a0a02), new THREE.Color(0xb03408), new THREE.Color(0xff8a2a), new THREE.Color(0xfff0c0)]
        : sampleMapStats(fillerTex?.image as CanvasImageSource | null).palette;
    this.liquidUniforms.uPalette0.value.copy(palette[0]);
    this.liquidUniforms.uPalette1.value.copy(palette[1]);
    this.liquidUniforms.uPalette2.value.copy(palette[2]);
    this.liquidUniforms.uPalette3.value.copy(palette[3]);
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
      this.mouthPlaneY = mouthGeometry(this.ballRadius, CONTAINER_R).mouthPlaneY;
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
   * for the transparency QA and the CP2 montage (P3's real pour replaces this).
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

  /** Per-frame: feed the camera position into the glass shells + liquid sheen. */
  update(cameraWorldPos: THREE.Vector3): void {
    this.glassUniforms.uCam.value.copy(cameraWorldPos);
    this.liquidUniforms.uCam.value.copy(cameraWorldPos);
  }

  /**
   * Step the sim one frame under the mode's phase-derived commands and report
   * back. Marbles run the solver; boulders run a scripted drop (never the
   * solver). Paused freezes the physics + spawner + melt while the visuals
   * (ripples, liquid time, preview fade) keep easing.
   */
  updateSim(dt: number, ctl: PourControl): PourStatus {
    const dtc = Math.min(dt, 0.05); // guard a huge hitch (tab refocus, breakpoint)
    this.liquidTime += dtc;
    this.updateRipples(dtc);
    this.easePreview(dtc);
    this.updateGhostLine(dtc);
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
   * Sub-unity pose (D8): one filler at true relative scale r_f = n^(−1/3) (> 1),
   * internally tangent at the container's bottom pole so it pokes out the top.
   * Reuses boulder mesh 0 as a plain lit planet (molten front off). The vessel
   * stays whole (the mouth is regime-gated away). Never routed through the solver.
   */
  showSubUnity(comparison: Comparison): void {
    // The true relative scale can be astronomically large (Moon-in-Sun r_f ≈ 400);
    // cap the RENDER so the loom stays framable while the count line keeps the
    // honest number. Anything past the cap still reads as "impossibly bigger".
    const rf = Math.min(Math.pow(Math.max(comparison.n, 1e-9), -1 / 3), SUB_UNITY_MAX_RF);
    this.subUnityRf = rf;
    const mesh = this.boulderPool[0];
    const u = this.boulderUniforms[0];
    u.uMap.value = this.fillerMap ?? this.emptyTex;
    u.uEmber.value = this.fillerIsSun ? 1 : 0;
    u.uMeltFront.value = -1.3; // no molten bleed — a whole planet in a glass
    mesh.scale.setScalar(rf);
    // Wedged in the vessel's mouth like an egg in a cup: tangent to the mouth-rim
    // circle (radius SUBUNITY_MOUTH_R at the mouth plane), so the filler sits IN
    // the opening — "went in as far as it fits", not balanced on a pole. Internal
    // tangency would engulf the opaque-occluded glass; this keeps it visible. The
    // belly faces the camera, so it takes the dedicated underside key.
    this.subUnityFillerY = SUBUNITY_MOUTH_PLANE_Y + Math.sqrt(Math.max(0, rf * rf - SUBUNITY_MOUTH_R * SUBUNITY_MOUTH_R));
    mesh.position.set(0, this.subUnityFillerY, 0);
    u.uSunDir.value.copy(SUB_UNITY_LOOM_KEY);
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

  /** The scene's top extent (studio units) for the tall-scene framing (D9). */
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

  /** Re-zero the sim + liquid for the same pair (D15 Reset — no texture reload). */
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
   * exactly N ball-volumes, so a full fill reads N, not floor(N).
   */
  topOffLiquid(): void {
    this.melted = this.simN;
  }

  private updateMarbles(dt: number, ctl: PourControl): PourStatus {
    const solver = this.solver;
    // Spout taper: the stream ramps in and trails out, never snaps.
    const flowTarget = ctl.spawnEnabled && !ctl.paused ? 1 : 0;
    this.spoutFlow += (flowTarget - this.spoutFlow) * (1 - Math.exp(-dt / SPOUT_RAMP_TAU));

    if (!ctl.paused) {
      const target = ctl.targetCount;
      if (this.poured > target + 0.5) {
        this.drainToTarget(Math.floor(target)); // slider dropped: pop newest
      } else {
        this.spawnToward(dt, target); // rate is 0 when the spout is closed
      }
      if (ctl.meltRate > 0) this.meltStep(dt, ctl.meltRate);
      if (ctl.rainEnabled) this.rainStep();
      solver.update(dt);
    }

    this.updateMouthIris(dt, ctl);
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
  private updateMouthIris(dt: number, ctl: PourControl): void {
    const airborne = this.solver.count - this.solver.enteredCount;
    const active = (ctl.spawnEnabled && !ctl.paused) || airborne > 0;
    if (active) this.mouthOpenHold = 1.0;
    else this.mouthOpenHold = Math.max(0, this.mouthOpenHold - dt);
    const target = this.mouthOpenHold > 0 ? 1 : 0;
    this.mouthOpen += (target - this.mouthOpen) * (1 - Math.exp(-dt / 0.14)); // ~0.4 s ease
    this.glassUniforms.uMouthOpen.value = this.mouthOpen;
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
  private easePreview(dt: number): void {
    // Sand's filler is a sub-pixel sliver at this scale — the honest note carries
    // the "too many to pour" story, so the preview stays hidden for sand.
    const want =
      !this.sandRegime && this.poured === 0 && this.melted === 0 && this.boulders.length === 0;
    this.previewOpacity += ((want ? 1 : 0) - this.previewOpacity) * (1 - Math.exp(-dt / 0.13));
    const r = this.ballRadius;
    this.previewMesh.position.set(CONTAINER_R + Math.max(2.5 * r, 0.18), -CONTAINER_R + r, 0);
    this.previewMesh.scale.setScalar(r * this.previewOpacity);
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
    const surfaceY = -R_LIQ + this.liquidLevelRendered;
    const discR = Math.sqrt(Math.max(0, R_LIQ * R_LIQ - surfaceY * surfaceY)) * 0.9;
    let x = this.removedPos[c * 3];
    let z = this.removedPos[c * 3 + 2];
    const rad = Math.hypot(x, z);
    if (rad > discR && rad > 1e-5) {
      const s = discR / rad;
      x *= s;
      z *= s;
    }
    const cen = cenAttr.array as Float32Array;
    cen[i * 3] = x;
    cen[i * 3 + 1] = surfaceY + 0.002; // a hair above the disc, never below the meniscus
    cen[i * 3 + 2] = z;
    (ageAttr.array as Float32Array)[i] = 0;
    cenAttr.needsUpdate = true;
    ageAttr.needsUpdate = true;
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
    u.uEmber.value = this.fillerIsSun ? 1 : 0;
    u.uMoltenLo.value.copy(this.liquidUniforms.uPalette1.value);
    u.uMoltenHi.value.copy(this.liquidUniforms.uPalette3.value);
    u.uMeltFront.value = -1.3;
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
      mesh.scale.set(r * (1 + 0.12 * t), r * (1 - 0.35 * t), r * (1 + 0.12 * t));
      // Molten front climbs the ball: object-y −1.2 (nothing molten) → +1 (all molten).
      u.uMeltFront.value = -1.2 + 2.2 * t;
    }
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  /** Dim the whole scene during an in-mode pair swap (key light + glass). */
  setDimmed(dim: boolean): void {
    this.keyLight.intensity = dim ? KEY_LIGHT_INTENSITY * LOADING_DIM : KEY_LIGHT_INTENSITY;
    this.fillLight.intensity = dim ? FILL_HEMI_INTENSITY * LOADING_DIM : FILL_HEMI_INTENSITY;
    this.glassUniforms.uDim.value = dim ? LOADING_DIM : 1;
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
    this.liquidDiscGeo.dispose();
    (this.liquidDisc.material as THREE.Material).dispose();
    this.ghostLine.geometry.dispose();
    this.ghostLineMat.dispose();
    this.ripples.geometry.dispose();
    this.rippleMat.dispose();
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
}

/** A fallback ramp when a body has no readable map (Sun, tainted canvas). */
function defaultPalette(): THREE.Color[] {
  return [
    new THREE.Color(0x1a2740),
    new THREE.Color(0x3a5a86),
    new THREE.Color(0x9fb6c8),
    new THREE.Color(0xf2f4f0),
  ];
}

/**
 * One 32×32 readback of a body's colour map, returning both its mean luminance
 * (for the ghost gain) and a 4-stop marbling ramp (the 10/40/70/95th luminance
 * percentiles) — a single pass so the ghost and the molten-liquid palette never
 * read the same canvas twice. Unreadable image → mean 0 + the default ramp.
 */
function sampleMapStats(image: CanvasImageSource | null): MapStats {
  if (!image) return { meanLum: 0, palette: defaultPalette() };
  const size = 32;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return { meanLum: 0, palette: defaultPalette() };
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
    samples.sort((a, b) => a.luma - b.luma);
    const pick = (frac: number): THREE.Color => {
      const s = samples[Math.min(n - 1, Math.floor(frac * n))];
      return new THREE.Color().setRGB(s.r / 255, s.g / 255, s.b / 255, THREE.SRGBColorSpace);
    };
    return { meanLum: sum / n, palette: [pick(0.1), pick(0.4), pick(0.7), pick(0.95)] };
  } catch {
    return { meanLum: 0, palette: defaultPalette() }; // tainted canvas (shouldn't happen)
  }
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
