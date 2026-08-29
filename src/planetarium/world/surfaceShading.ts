/**
 * Per-body surface-shading augmentation for the Planetarium. Once the flat
 * scene ambient is gone, a body's night side would crush to pure black; this
 * adds a dim, cool, *directional* starlight floor in the body's own material —
 * keyed to where the Sun actually is for that body — so the dark hemisphere
 * keeps its shape without washing out daylight contrast. Further view-space
 * lighting terms layer onto this same onBeforeCompile hook — they share the
 * sun-direction varyings.
 *
 * Two cast-shadow terms also live here, both traced in the body's own frame
 * (so they read the raw `position` varying, unaffected by pole orientation):
 *   - Ring shadow (Saturn): trace toward the Sun to the ring plane; dim by the
 *     rings' opacity where it lands. Gated by `uRingOuter > 0`.
 *   - Moon-shadow transits: a moon between the Sun and a fragment casts an
 *     umbra/penumbra spot onto the globe (Io's shadow crawling across Jupiter).
 *
 * The night side's own light is the fifth term, and where a body has tables it
 * REPLACES the starlight fill rather than joining it: the multiple-scattering
 * ambient out of the irradiance table, plus the Moon as a second directional
 * source, both faded out through the one `nightWeight` every non-solar source
 * in the app shares. Two night-fill models on one fragment lift the dark
 * hemisphere twice, so the authored one is switched off by the same uniform
 * that switches the air on — which leaves it as the answer for airless bodies
 * and for the tier with no tables, where it always was.
 *
 * Aerial perspective is the fourth term and the only one that reads a texture:
 * where a body has precomputed scattering tables, every surface fragment is
 * multiplied by the transmittance of the air between it and the camera and has
 * that air's own in-scattered light added on top (`color * T + S`). It lives
 * here, rather than in the globe's material alone, because a streamed sector
 * draws ABOVE the globe and would otherwise be the one unhazed layer, in
 * exactly the near-band view the haze exists for.
 *
 * The injected GLSL is byte-identical for every body (only uniforms differ), so
 * materials still share compiled programs — no custom cache key needed. That
 * holds for the air too: a body without tables takes the same text with
 * `uAirDensity` at zero, rather than a shorter variant that would fork the
 * program cache per body and per tier.
 */
import * as THREE from 'three';
import {
  AERIAL_PERSPECTIVE_GLSL,
  ATMOSPHERE_LOOKUP_BODY_GLSL,
  atmosphereLookupUniforms,
  atmosphereSessionSizes,
  atmosphereTableDefines,
  applyAtmosphereParams,
  type AtmosphereTables,
} from './atmosphereLut';
import { AIRLIGHT_SCALE } from './atmosphereModel';
import { NIGHT_WEIGHT_GLSL } from './nightSources';

/** The cloud deck is a surface class of its own: it hazes and eclipses like the
 *  ground under it, and carries none of the ground's own night terms — the
 *  globe beneath it already lifts the night side, and a second lift there would
 *  count it twice. */
export type SurfaceArchetype = 'airless' | 'rocky' | 'gas' | 'icy' | 'earth' | 'cloud';

/** Ring annulus that shadows this body's surface (object-space radii, AU). */
export interface RingShadowConfig {
  inner: number;
  outer: number;
}

/** Up to this many moons cast a shadow onto any one parent at once. */
export const MAX_MOON_SHADOWS = 4;

/**
 * One body's atmosphere, as the uniform block every surface that draws that
 * body reads: the tables, the parameters that address them, and the two
 * numbers that bridge a bake normalised to unit WHITE irradiance back to the
 * scene's own Sun. It lives inside `SurfaceShadingFx` so a streamed sector
 * inherits it through the same re-augment that gives it the eclipse casters —
 * a second uniform set is how a tile ends up hazed differently from the globe
 * one pixel away.
 *
 * `uAirDensity` is the switch, not a scale: 0 on an airless body, on a device
 * with no tier, and between a lost context and the re-bake. The air's actual
 * depth is in the tables.
 */
export type SurfaceAirFx = Record<string, THREE.IUniform>;

/** Per-frame-updated uniforms the mode feeds from each body's real position. */
export interface SurfaceShadingFx {
  uSunDirWorld: { value: THREE.Vector3 };       // world sun, for the night-fill terminator
  uSunDirLocal: { value: THREE.Vector3 };       // sun in the body's frame, for the cast-shadow traces
  uMoonShadow: { value: THREE.Vector4[] };      // [xyz = moon centre in body frame (AU), w = moon radius AU]
  uMoonShadowCount: { value: number };          // active entries in uMoonShadow
  uPlanetshineColor: { value: THREE.Color };    // parent's reflected-light tint (moons only)
  uPlanetshineDir: { value: THREE.Vector3 };    // world direction from the moon to its parent
  uPlanetshineIntensity: { value: number };     // night-side parent glow; 0 for planets / no parent
  /** 0..1: fades the night-side lifts (starlight fill, planetshine) while the
   *  body silhouettes the Sun. A disc backlit by the photosphere reads void
   *  black in any real exposure — the camera belongs to the ring or corona
   *  behind it, and the visibility lifts would read as fog on the silhouette. */
  uSilhouette: { value: number };
  /** This body's air. Shared by every material that draws its surface. */
  air: SurfaceAirFx;
}

interface NightFill {
  color: number;      // cool starlight tint (linear-ish hex)
  strength: number;   // peak night-side fraction of albedo (kept small)
  termWidth: number;  // half-width of the day/night rolloff, in dot(n, sun)
}

// Wider terminators on bodies with air (light wraps); tight on airless worlds.
// Keyed to surface class, not atmosphere depth, so Venus and Titan (thick haze)
// sit tighter here than reality; the atmosphere phase models their wrap properly.
const NIGHT_FILL: Record<SurfaceArchetype, NightFill> = {
  airless: { color: 0x223044, strength: 0.05, termWidth: 0.10 },
  rocky:   { color: 0x243246, strength: 0.06, termWidth: 0.16 },
  gas:     { color: 0x2a3550, strength: 0.08, termWidth: 0.24 },
  icy:     { color: 0x28384f, strength: 0.07, termWidth: 0.12 },
  earth:   { color: 0x1c2c44, strength: 0.05, termWidth: 0.16 },
  // No fill of its own: the deck is translucent and the globe's fill shows
  // through it, so a second one would double the night side's floor. The
  // terminator width is the globe's, because the same rolloff gates the
  // eclipse spot on both and the two have to move together.
  cloud:   { color: 0x000000, strength: 0.0, termWidth: 0.16 },
};

// View-angle limb darkening: a body's disc dims toward its edge as the line of
// sight grazes the surface — the single biggest "reads as a real photo" cue for
// gaseous and thick-atmosphere worlds. Airless rock is nearly flat to the limb
// (a full Moon reads as an even disc). Coefficient is the u in I/I0 = 1 - u(1-mu);
// 0 disables it. Icy moons keep their cool Fresnel rim instead.
const LIMB_DARKENING: Record<SurfaceArchetype, number> = {
  airless: 0.0,
  rocky:   0.18,
  gas:     0.55,
  icy:     0.0,
  earth:   0.3,
  // The globe under the deck carries the disc's edge; darkening the deck as
  // well would dim that edge twice.
  cloud:   0.0,
};

// Analytic stand-in for Saturn's ring opacity across the annulus (t: 0 inner …
// 1 outer), used only for the shadow it casts — the major features that read on
// the globe are the dense B ring, the clear Cassini Division, and the slightly
// thinner A ring. This mirrors the band layout painted by paintRing('saturn') in
// planets/rings.ts; keep the two in step so the cast shadow lines up with the
// ring that casts it (this is a coarse re-derivation, not a shared source).
const RING_SHADOW_OPACITY_GLSL = /* glsl */ `
float ringShadowOpacity(float t) {
  if (t < 0.0 || t > 1.0) return 0.0;
  float a = 0.9;
  a *= mix(0.4, 1.0, smoothstep(0.02, 0.18, t));         // C ring (faint inner)
  a *= mix(1.0, 0.8, smoothstep(0.58, 0.66, t));         // A ring a touch thinner than B
  float cas = (t - 0.6) / 0.022;                          // squared explicitly: pow() of a
  a *= 1.0 - 0.92 * exp(-cas * cas);                      // negative base is undefined in GLSL — Cassini
  float enk = (t - 0.83) / 0.008;
  a *= 1.0 - 0.6 * exp(-enk * enk);                       // Encke Gap
  a *= smoothstep(0.0, 0.04, t);                         // inner edge falloff
  a *= 1.0 - smoothstep(0.92, 1.0, t);                   // outer edge falloff
  return clamp(a, 0.0, 1.0);
}
`;

/** The umbra/penumbra of one caster, traced from a point in the BODY frame
 *  toward the Sun: a moon sunward of the point casts a cone that narrows with
 *  distance behind it. Returns 0 for a caster that is not sunward at all.
 *  Exported as GLSL because the atmosphere shell traces the same casters, in
 *  the same frame, and a second transcription would drift the eclipse spot on
 *  the air away from the one on the ground. */
export const MOON_SHADOW_TRACE_GLSL = /* glsl */ `
float moonShadowOcclusion(vec3 toMoon, float moonRadius, vec3 sunDir, float sunTan) {
  float along = dot(toMoon, sunDir);
  if (along <= 0.0) return 0.0;
  float perp = length(toMoon - sunDir * along);
  return 1.0 - smoothstep(max(moonRadius - along * sunTan, 0.0), moonRadius + along * sunTan, perp);
}
`;

// The augmentation GLSL, lifted out of onBeforeCompile so the shader reads as
// shader code rather than string concatenation. Computed once at module load,
// so every body injects the identical text (only the uniform *values* differ) —
// materials keep sharing one compiled program, no custom cache key needed.
const SURFACE_VERTEX_DECLS = /* glsl */ `
uniform vec3 uSunDirWorld;
uniform vec3 uMoonDirWorld;
uniform vec3 uPlanetshineDir;
uniform float uFrameSpin;
varying vec3 vSunViewDir;
varying vec3 vMoonViewDir;
varying vec3 vObjPos;
varying vec3 vPlanetshineViewDir;
varying vec3 vAirCam;
varying vec3 vAirFrag;`;

const SURFACE_VERTEX_BODY = /* glsl */ `
vSunViewDir = normalize((viewMatrix * vec4(uSunDirWorld, 0.0)).xyz);
vMoonViewDir = normalize((viewMatrix * vec4(uMoonDirWorld, 0.0)).xyz);
vPlanetshineViewDir = normalize((viewMatrix * vec4(uPlanetshineDir, 0.0)).xyz);
// vObjPos is the BODY frame — the frame the eclipse casters, the ring plane and
// the local sun direction are all stated in. A mesh that carries a spin of its
// own on top of the body's (the cloud deck drifts) would trace them at the
// wrong longitude, putting a second eclipse spot on the clouds beside the one
// on the ground. Zero for every mesh that shares the body's own frame, and the
// branch is what keeps those byte-identical rather than off by a rounded cosine.
if (uFrameSpin == 0.0) {
  vObjPos = position;
} else {
  float spinC = cos(uFrameSpin);
  float spinS = sin(uFrameSpin);
  vObjPos = vec3(position.x * spinC + position.z * spinS,
                 position.y,
                 position.z * spinC - position.x * spinS);
}
// The air's geometry is frame-free: the camera and the fragment as offsets from
// the body's centre, in world axes, against a world sun direction. The
// fragment's offset comes off the rotation alone — going through world position
// and back would subtract two numbers of the body's heliocentric size to get
// one the size of its radius.
vAirCam = cameraPosition - modelMatrix[3].xyz;
vAirFrag = mat3(modelMatrix) * position;`;

const SURFACE_FRAGMENT_DECLS = /* glsl */ `
uniform vec3 uNightColor;
uniform float uNightStrength;
uniform float uTermWidth;
uniform vec3 uSunDirLocal;
uniform float uRingInner;
uniform float uRingOuter;
uniform float uSunTan;
uniform vec4 uMoonShadow[${MAX_MOON_SHADOWS}];
uniform int uMoonShadowCount;
uniform vec3 uPlanetshineColor;
uniform float uPlanetshineIntensity;
uniform float uSilhouette;
uniform float uIcyRim;
uniform float uLimbDarkening;
uniform vec3 uSunDirWorld;
uniform vec3 uMoonDirWorld;
uniform vec3 uMoonIrradiance;
uniform float uAirDensity;
uniform float uPlanetRadius;
uniform float uSolarIrradiance;
uniform vec3 uAirlightScale;
uniform sampler2D uTransmittance;
uniform sampler2D uIrradiance;
uniform sampler3D uScattering;
varying vec3 vSunViewDir;
varying vec3 vMoonViewDir;
varying vec3 vObjPos;
varying vec3 vPlanetshineViewDir;
varying vec3 vAirCam;
varying vec3 vAirFrag;
${RING_SHADOW_OPACITY_GLSL}${MOON_SHADOW_TRACE_GLSL}${ATMOSPHERE_LOOKUP_BODY_GLSL}${AERIAL_PERSPECTIVE_GLSL}${NIGHT_WEIGHT_GLSL}`;

// Injected after lighting but before <opaque_fragment> writes outgoingLight into
// gl_FragColor — so terms land in linear radiance (tone-mapped downstream) and
// read the perturbed view-space `normal`.
const SURFACE_FRAGMENT_BODY = /* glsl */ `{
  float dayFactor = smoothstep(-uTermWidth, uTermWidth, dot(normalize(normal), normalize(vSunViewDir)));
  // The night lifts fade while this body silhouettes the Sun: a disc backlit
  // by the photosphere is void black in any real exposure, and the starlight
  // fill or earthshine would read as fog painted on the silhouette.
  float nightKeep = 1.0 - uSilhouette;
  // The Sun's elevation at THIS fragment: the geometric quantity every
  // non-solar source is weighted by, so the airglow on the limb, the moonlight
  // on the ground and the haze in front of it all fade along one line instead
  // of three. Zero where there is no air, which is where the authored fill
  // below is the whole night side instead.
  float airNight = uAirDensity > 0.0
      ? nightWeight(clampCosine(dot(normalize(vAirFrag), normalize(uSunDirWorld)))) * nightKeep
      : 0.0;
  // The authored starlight floor, and the seam it sits on: where the tables are
  // bound they carry the night side's own light, and this fill would be a
  // second model of the same thing lifting the same fragment twice. So the fill
  // is the airless and the fallback-tier answer, and the table's is the other.
  outgoingLight += diffuseColor.rgb * uNightColor
      * (uNightStrength * (1.0 - uAirDensity) * (1.0 - dayFactor) * nightKeep);
  // Planetshine: parent-lit glow on the night side. Albedo-multiplicative,
  // so the eclipse color-dim carries through it automatically.
  if (uPlanetshineIntensity > 0.0) {
    float pl = max(dot(normalize(normal), normalize(vPlanetshineViewDir)), 0.0);
    outgoingLight += diffuseColor.rgb * uPlanetshineColor * (uPlanetshineIntensity * pl * (1.0 - dayFactor) * nightKeep);
  }
  // The night side's own light, where a body has tables: the sky's
  // multiple-scattering ambient — the term that replaces the authored fill —
  // plus the Moon's direct beam through the air above this fragment. The
  // ambient is read for both sources from one table: the irradiance table is
  // the light a horizontal surface receives from the whole sky, and which sky
  // it is depends only on where its source is.
  if (airNight > 0.0) {
    vec3 up = normalize(vAirFrag);
    float rFrag = clampRadius(length(vAirFrag) / uPlanetRadius);
    float muSSun = clampCosine(dot(up, normalize(uSunDirWorld)));
    vec3 moonDir = normalize(uMoonDirWorld);
    float muSMoon = clampCosine(dot(up, moonDir));
    vec3 ambient = getIrradiance(uIrradiance, rFrag, muSSun)
            * uAirlightScale * uSolarIrradiance
        + getIrradiance(uIrradiance, rFrag, muSMoon) * uMoonIrradiance;
    vec3 direct = uMoonIrradiance
        * getTransmittanceToSun(uTransmittance, rFrag, muSMoon)
        * max(dot(normalize(normal), normalize(vMoonViewDir)), 0.0);
    outgoingLight += diffuseColor.rgb * (ambient + direct) * airNight;
  }
  // Icy moons: a cool Fresnel rim on the back-lit limb (ice scatters light).
  // Scaled by the (eclipse-dimmed) albedo brightness so it fades when the
  // moon sits in its parent shadow and no sunlight is there to scatter.
  if (uIcyRim > 0.5) {
    float rim = pow(1.0 - max(dot(normalize(normal), normalize(vViewPosition)), 0.0), 3.0);
    float back = max(-dot(normalize(normal), normalize(vSunViewDir)), 0.0);
    float lit = max(diffuseColor.r, max(diffuseColor.g, diffuseColor.b));
    outgoingLight += vec3(0.55, 0.75, 1.0) * (rim * back * 0.55 * lit);
  }
  vec3 sd = normalize(uSunDirLocal);
  // Ring shadow on the globe: trace toward the Sun to the ring plane
  // (y = 0) and dim by the rings opacity where it lands.
  if (uRingOuter > 0.0 && abs(sd.y) > 1e-4) {
    float tHit = -vObjPos.y / sd.y;
    if (tHit > 0.0) {
      vec3 hit = vObjPos + sd * tHit;
      float t01 = (length(hit.xz) - uRingInner) / (uRingOuter - uRingInner);
      outgoingLight *= 1.0 - 0.9 * ringShadowOpacity(t01) * dayFactor;
    }
  }
  // Moon-shadow transits: a moon sunward of this fragment casts an
  // umbra/penumbra spot (cone narrows with distance behind the moon).
  // Accumulated into ONE visible-Sun factor rather than applied per caster,
  // because the air in front of this fragment has to be dimmed by the same
  // number: two expressions of the same eclipse drift apart, and the way that
  // shows is a spot on the haze offset from the spot on the ground.
  float sunVisible = 1.0;
  for (int i = 0; i < ${MAX_MOON_SHADOWS}; i++) {
    if (i >= uMoonShadowCount) break;
    float occ = moonShadowOcclusion(uMoonShadow[i].xyz - vObjPos, uMoonShadow[i].w, sd, uSunTan);
    sunVisible *= 1.0 - occ * dayFactor;
  }
  outgoingLight *= sunVisible;
  // Limb darkening: the disc dims toward its edge as the view ray grazes the
  // surface. mu = cos of the view angle — 1 at disc centre, 0 at the limb.
  // Applied last so it shades every lit term equally; 0 disables it.
  if (uLimbDarkening > 0.0) {
    float mu = max(dot(normalize(normal), normalize(vViewPosition)), 0.0);
    outgoingLight *= 1.0 - uLimbDarkening * (1.0 - mu);
  }
  // Aerial perspective, last: everything above is light leaving this fragment,
  // and all of it crosses the same air on the way to the camera. What survives
  // is x T; what the air itself sends is + S. Zero on a body with no
  // tables, on a device with no tier, and between a lost context and the
  // re-bake — the same text either way, so one program serves every body.
  if (uAirDensity > 0.0) {
    AerialSegment seg = aerialSegment(
        vAirCam / uPlanetRadius, vAirFrag / uPlanetRadius, normalize(uSunDirWorld));
    if (seg.valid) {
      vec3 airT = aerialTransmittance(uTransmittance, seg);
      vec3 airS = aerialInscatter(uScattering, seg, airT)
          * uAirlightScale * (uSolarIrradiance * sunVisible);
      // The Moon lights the same column. One traversal, one transmittance: only
      // the two angles that involve the source change, so the second source is
      // a second pair of lookups and nothing else. Behind the night weight, so
      // by day it is a branch and no fetches.
      if (airNight > 0.0) {
        airS += aerialInscatter(uScattering, aerialForLight(seg, normalize(uMoonDirWorld)), airT)
            * uMoonIrradiance * airNight;
      }
      outgoingLight = outgoingLight * airT + airS;
    }
  }
}`;

/** What a material was augmented with, kept beside it so a dependent
 *  material (a streamed surface sector) can be augmented identically and share
 *  the same per-frame fx objects. A side table, not userData: userData is
 *  JSON-cloned by Material.copy and can hold render-target refs. */
export interface SurfaceShadingArgs {
  archetype: SurfaceArchetype;
  ringShadow?: RingShadowConfig;
  sunTan: number;
  fx: SurfaceShadingFx;
  /** This mesh's own rotation about the pole, on top of the body's — the cloud
   *  deck drifts, and its object space is that much out of the body frame the
   *  eclipse casters are given in. Zero for a mesh that shares the frame. */
  uFrameSpin: { value: number };
}
const augmentArgs = new WeakMap<THREE.Material, SurfaceShadingArgs>();

/** The augmentation a material received, or undefined for a plain one. */
export function surfaceShadingArgsOf(mat: THREE.Material): SurfaceShadingArgs | undefined {
  return augmentArgs.get(mat);
}

/** 1×1 stand-ins, shared by every augmented material: no sampler is ever left
 *  for the renderer to fill with an empty of its own, which for a `sampler3D`
 *  is the first place a driver would have to invent one. Sampling them is never
 *  legal — wherever they are what is bound, `uAirDensity` is 0. */
let airDummies: { map2D: THREE.DataTexture; map3D: THREE.Data3DTexture } | null = null;
function surfaceAirDummies(): { map2D: THREE.DataTexture; map3D: THREE.Data3DTexture } {
  if (!airDummies) {
    const map2D = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    map2D.needsUpdate = true;
    const map3D = new THREE.Data3DTexture(new Uint8Array(4), 1, 1, 1);
    map3D.minFilter = THREE.LinearFilter;
    map3D.magFilter = THREE.LinearFilter;
    map3D.needsUpdate = true;
    airDummies = { map2D, map3D };
  }
  return airDummies;
}

/** A body's air, switched off and pointed at the stand-ins. */
export function createSurfaceAirFx(): SurfaceAirFx {
  const dummies = surfaceAirDummies();
  const air: SurfaceAirFx = {
    ...atmosphereLookupUniforms(),
    uAirDensity: { value: 0 },
    uPlanetRadius: { value: 1 },
    uSolarIrradiance: { value: 1 },
    uAirlightScale: { value: new THREE.Vector3(...AIRLIGHT_SCALE) },
    // The night's second source. It lives here, with the air, because every
    // surface that draws this body has to be lit by the same Moon as the shell
    // around it — and because the mode writes it once per body per frame.
    uMoonDirWorld: { value: new THREE.Vector3(0, 0, 1) },
    uMoonIrradiance: { value: new THREE.Vector3() },
  };
  air.uTransmittance.value = dummies.map2D;
  air.uIrradiance.value = dummies.map2D;
  air.uScattering.value = dummies.map3D;
  return air;
}

/**
 * Point a body's surfaces at its finished tables and switch the air on.
 * `planetRadius` is the surface radius in the same units the vertex stage hands
 * over (world AU), because that is what the lookup divides by to reach the
 * radius units the tables are baked in.
 */
export function bindSurfaceAir(
  air: SurfaceAirFx,
  tables: AtmosphereTables,
  planetRadius: number,
  solarIrradiance: number,
): void {
  applyAtmosphereParams(air, tables.params);
  air.uTransmittance.value = tables.transmittance;
  air.uScattering.value = tables.scattering;
  air.uIrradiance.value = tables.irradiance;
  air.uPlanetRadius.value = planetRadius;
  air.uSolarIrradiance.value = solarIrradiance;
  air.uAirDensity.value = 1;
}

/** Switch the air off and let go of the tables: a lost context frees their
 *  textures, and a sampler still pointed at one is a bind of a dead name. */
export function clearSurfaceAir(air: SurfaceAirFx): void {
  if (air.uAirDensity.value === 0 && air.uScattering.value === surfaceAirDummies().map3D) return;
  const dummies = surfaceAirDummies();
  air.uAirDensity.value = 0;
  air.uTransmittance.value = dummies.map2D;
  air.uIrradiance.value = dummies.map2D;
  air.uScattering.value = dummies.map3D;
}

export function augmentSurfaceMaterial(
  mat: THREE.MeshStandardMaterial,
  archetype: SurfaceArchetype,
  ringShadow?: RingShadowConfig,
  sunTan = 0,
  /** Share another material's fx objects instead of creating fresh ones: the
   *  mode writes sun direction, moon shadows and planetshine into ONE object
   *  per body, and every material drawing that body's surface must read the
   *  same values (a streamed sector tinted differently from the globe under
   *  it is a rectangle in the middle of an eclipse). */
  shared?: SurfaceShadingFx,
  /** Share the spin of the mesh this material's own mesh hangs under (a
   *  streamed sector is a child of the globe mesh, so it inherits its frame). */
  sharedSpin?: { value: number },
): SurfaceShadingFx {
  const night = NIGHT_FILL[archetype];

  // Created up front so the mode can update these refs even before the material
  // lazily compiles; onBeforeCompile assigns the same objects into the shader.
  const moonShadow: THREE.Vector4[] = [];
  for (let i = 0; i < MAX_MOON_SHADOWS; i++) moonShadow.push(new THREE.Vector4());
  const fx: SurfaceShadingFx = shared ?? {
    uSunDirWorld: { value: new THREE.Vector3(1, 0, 0) },
    uSunDirLocal: { value: new THREE.Vector3(1, 0, 0) },
    uMoonShadow: { value: moonShadow },
    uMoonShadowCount: { value: 0 },
    uPlanetshineColor: { value: new THREE.Color(0x6688aa) },
    uPlanetshineDir: { value: new THREE.Vector3(1, 0, 0) },
    uPlanetshineIntensity: { value: 0 },
    uSilhouette: { value: 0 },
    air: createSurfaceAirFx(),
  };
  const uFrameSpin = sharedSpin ?? { value: 0 };
  augmentArgs.set(mat, { archetype, ringShadow, sunTan, fx, uFrameSpin });
  const uNightColor = { value: new THREE.Color(night.color) };
  const uNightStrength = { value: night.strength };
  const uTermWidth = { value: night.termWidth };
  const uRingInner = { value: ringShadow ? ringShadow.inner : 0 };
  const uRingOuter = { value: ringShadow ? ringShadow.outer : 0 };
  const uSunTan = { value: sunTan };
  const uIcyRim = { value: archetype === 'icy' ? 1 : 0 };
  const uLimbDarkening = { value: LIMB_DARKENING[archetype] };

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSunDirWorld = fx.uSunDirWorld;
    shader.uniforms.uSunDirLocal = fx.uSunDirLocal;
    shader.uniforms.uMoonShadow = fx.uMoonShadow;
    shader.uniforms.uMoonShadowCount = fx.uMoonShadowCount;
    shader.uniforms.uNightColor = uNightColor;
    shader.uniforms.uNightStrength = uNightStrength;
    shader.uniforms.uTermWidth = uTermWidth;
    shader.uniforms.uRingInner = uRingInner;
    shader.uniforms.uRingOuter = uRingOuter;
    shader.uniforms.uSunTan = uSunTan;
    shader.uniforms.uPlanetshineColor = fx.uPlanetshineColor;
    shader.uniforms.uPlanetshineDir = fx.uPlanetshineDir;
    shader.uniforms.uPlanetshineIntensity = fx.uPlanetshineIntensity;
    shader.uniforms.uSilhouette = fx.uSilhouette;
    shader.uniforms.uIcyRim = uIcyRim;
    shader.uniforms.uLimbDarkening = uLimbDarkening;
    shader.uniforms.uFrameSpin = uFrameSpin;
    for (const name of Object.keys(fx.air)) shader.uniforms[name] = fx.air[name];

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>${SURFACE_VERTEX_DECLS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>${SURFACE_VERTEX_BODY}`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>${SURFACE_FRAGMENT_DECLS}`)
      .replace('#include <opaque_fragment>', `${SURFACE_FRAGMENT_BODY}\n#include <opaque_fragment>`);
  };
  // The table dimensions are #defines, and a define is part of three's program
  // cache key — so every augmented material carries the same set, whether or
  // not its body has any air. Split them per body and the cache forks per body;
  // omit them and the injected lookup does not compile at all.
  mat.defines = { ...mat.defines, ...atmosphereTableDefines(atmosphereSessionSizes()) };
  mat.needsUpdate = true;
  return fx;
}
