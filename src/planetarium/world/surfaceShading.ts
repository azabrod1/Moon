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
 * The night side's own light is the fifth term, and where a body has tables the
 * irradiance table's multiple-scattering ambient stands in for the starlight
 * fill. It does not JOIN it and it does not simply replace it: the two are
 * combined with max(), so the fill is the floor the night side may never go
 * under and the table is what lifts it above that floor. Adding them would lift
 * one fragment through two models of the same thing; switching the fill off
 * outright would let the tier with the tables come out darker than the tier
 * without them, which inverts every other tier difference in the app. With the
 * air off the table's term is zero and the floor is the whole night side, which
 * is what it always was on an airless body and on a device with no tier.
 *
 * The Moon is the sixth, and it is weighted by its OWN elevation rather than by
 * the Sun's: `moonUpWeight` times `sunDownWeight`, a one-sided ramp at full
 * strength from the terminator down and fading only as the Sun climbs above it.
 * Gate it by the Sun's night weight instead — or by any ramp centred on the
 * terminator, the day factor's complement included — and the ground runs
 * through a minimum there, the Sun's light gone and the Moon's half arrived,
 * with a gibbous Moon standing right over it.
 *
 * What a night fragment costs, in dependent table fetches: 6 by day (two for
 * the transmittance in front of it, four for that air's in-scatter), 7 past the
 * terminator with no Moon up (the sky's own irradiance), and 13 with one (its
 * irradiance, its beam's transmittance, and four for its in-scatter on the same
 * segment). The last four are behind a uniform branch as well as the weight, so
 * a body with no moon and a new-Moon Earth pay none of them.
 *
 * Aerial perspective is the fourth term and the only one that reads a texture:
 * where a body has precomputed scattering tables, every surface fragment is
 * multiplied by the transmittance of the air between it and the camera and has
 * that air's own in-scattered light added on top (`color * T + S`). It lives
 * here, rather than in the globe's material alone, because a streamed sector
 * draws ABOVE the globe and would otherwise be the one unhazed layer, in
 * exactly the near-band view the haze exists for.
 *
 * That segment ends at the fragment for every surface drawn at the altitude it
 * stands for, and at an authored radius for the one that is not: the cloud
 * deck's mesh sits at 1.01 R so that up close the deck owns the silhouette,
 * which puts it above the whole air. `AIR_LOOKUP_RADIUS` is where each
 * archetype's segment really ends.
 *
 * The injection has three points, not two: the declarations at <common>, the
 * cloud deck's detail at <normal_fragment_maps> — the one place where the
 * perturbed normal exists and no light has read it yet — and everything else
 * before <opaque_fragment>, after the lighting, where the terms above land in
 * linear radiance. A normal moved at the third point would shade this file's
 * own night terms and leave three's lights on a smooth sphere.
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
import { EARTH_NIGHT_COLD_CUT, EARTH_NIGHT_WARM_GLSL } from '../../shared/shaders/atmosphere';
import {
  CLOUD_ALBEDO,
  CLOUD_ALBEDO_BLEND,
  CLOUD_CITY_GLOW,
  CLOUD_COVERAGE_GLSL,
  CLOUD_DETAIL_ERODE,
  CLOUD_DETAIL_GLSL,
  CLOUD_DETAIL_RELIEF_KM,
  LUMINANCE_WEIGHTS,
  SPHERE_EQUIRECT_UV_GLSL,
} from './cloudDeck';
import {
  CLOUD_DETAIL_SIZE,
  CLOUD_DETAIL_GRADIENT_SCALE,
  CLOUD_DETAIL_UV_PER_RADIAN,
  cloudDetailTexture,
} from './cloudDetailNoise';
import { MOON_UP_GLSL, NIGHT_WEIGHT_GLSL, SUN_DOWN_GLSL } from './nightSources';
import { PLANETS } from '../planets/planetData';

/** The cloud deck is a surface class of its own: its alpha is the coverage its
 *  own map states rather than a flat opacity (world/cloudDeck), it hazes and
 *  eclipses like the ground under it, and it draws the same night terms every
 *  other surface does
 *  — the sky's ambient and the Moon — which is what makes moonlit cloud tops
 *  read silver. What it does NOT carry is an authored starlight fill of its own
 *  (`NIGHT_FILL.cloud` is zero): the globe beneath it already has one, and the
 *  deck's blend is not premultiplied, so the table terms compose exactly once
 *  where a second authored floor would be a second lift. */
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

export interface NightFill {
  color: number;      // cool starlight tint (linear-ish hex)
  strength: number;   // peak night-side fraction of albedo (kept small)
  termWidth: number;  // half-width of the day/night rolloff, in dot(n, sun)
}

// Wider terminators on bodies with air (light wraps); tight on airless worlds.
// Keyed to surface class, not atmosphere depth, so Venus and Titan (thick haze)
// sit tighter here than reality; the atmosphere phase models their wrap properly.
//
// Where a body has tables the sky's own ambient stands in for this fill and
// this fill is the floor under it, and the swap is level-neutral — measured,
// not intended. At the new-Moon night pose, with the night-lights shell's own
// transmittance taken out of both frames, the mean over every lit pixel is
// 2.61/12.28/23.99 of 255 without the tables against 2.70/12.58/23.93 with
// them: a third of one 8-bit step apart, and on the right side of zero in two
// channels of three. The floor itself is worth 0.01/0.05/0.06 of a step there
// — take it out and the frame moves that far — because the two models of the
// same light happen to agree to within it, which is what makes max() the right
// way to combine them rather than a choice between them.
//
// What DOES take light off the night hemisphere on the tier with tables is
// that shell. City lights are painted on the ground and seen through the whole
// column — ten airmasses of it at the limb — and over this frame, which is a
// night side looked at from 1.05 R with most of its ground near the limb, that
// is 5.3 green and 14.7 blue off the mean. All of it: with the lights left
// unattenuated the two tiers land within a third of a step of each other.
export const NIGHT_FILL: Record<SurfaceArchetype, NightFill> = {
  airless: { color: 0x223044, strength: 0.05, termWidth: 0.10 },
  rocky:   { color: 0x243246, strength: 0.06, termWidth: 0.16 },
  gas:     { color: 0x2a3550, strength: 0.08, termWidth: 0.24 },
  icy:     { color: 0x28384f, strength: 0.07, termWidth: 0.12 },
  earth:   { color: 0x1c2c44, strength: 0.05, termWidth: 0.16 },
  // No fill of its own: the deck is translucent and the globe's fill shows
  // through it, so a second one would double the night side's floor. Its share
  // of the table's own night terms it does draw, and that is what silvers a
  // moonlit cloud top. The terminator width is the globe's, because the same
  // rolloff gates the eclipse spot on both and the two have to move together.
  cloud:   { color: 0x000000, strength: 0.0, termWidth: 0.16 },
};

/**
 * How much of the authored fill survives as the floor under the table's own
 * night ambient, on a body that has tables. 1.0 is the fill itself: the look
 * with no tables is the reference, and the tier with them is never allowed to
 * come out darker than it. Turn it down and the tables are allowed to take the
 * night side below the authored floor by that fraction; at 0 the floor is gone
 * and the table is the whole answer.
 */
export const NIGHT_FLOOR_FRACTION = 1.0;

/**
 * Where the night-lights shell looks its air up, in the radius units the tables
 * are baked in. The lights are painted on the GROUND; their mesh stands a few
 * kilometres above it so it never z-fights the globe, and at Earth's 8 km
 * Rayleigh scale height those few kilometres are more than half the column and
 * essentially all of the Mie. So the segment's far end is substituted back down
 * to the surface — the same substitution the cloud deck makes, in the other
 * direction — and a city is seen through the whole air rather than through the
 * thin top of it.
 */
export const NIGHT_LIGHTS_AIR_LOOKUP_RADIUS = 1.0;

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

/** A physical cloud top, km above the surface. A whole-globe deck stands for
 *  everything from a 2 km marine layer to a 16 km anvil; 10 is the middle of
 *  that range and the altitude the deck's air is looked up at. */
const CLOUD_TOP_KM = 10;

const EARTH_RADIUS_KM = PLANETS.find((p) => p.name === 'Earth')!.radiusKm;

// Where a surface's air segment ENDS, in the radius units the tables are baked
// in (1 = the surface). 0 leaves the segment at the fragment's own radius,
// which is right for every mesh drawn at the altitude it stands for.
//
// The cloud deck is not one of those. Its mesh is at 1.01 R because up close
// the deck, not the globe, is the body's silhouette — and 1.01 R is 64 km,
// above 99.97 % of the Rayleigh column and all of the Mie and the ozone. Look
// the air up there and `x T + S` is a no-op in every pose the app can reach,
// while the deck's own alpha still takes that fraction of the ground's airlight
// off every pixel it covers, and a covered pixel at the horizon is then an
// unhazed cloud image in the one band a photograph washes out. So the deck
// looks its air up at the physical cloud top instead: the same ray in the same
// direction, with the radius substituted for the segment's far end.
//
// The substituted point is always still on the visible side of the globe: a
// deck fragment is only drawn where its normal faces the camera, which is
// within arccos(R_deck/d) of the camera axis, and that cone is strictly
// narrower than the globe's own arccos(R_globe/d) because the deck is the
// larger sphere.
//
// These are radius units and the only body with a deck is Earth, so the deck's
// entry is 10 km expressed against Earth's radius. A second body that grew one
// would want its own altitude divided by its own radius, not this number.
export const AIR_LOOKUP_RADIUS: Record<SurfaceArchetype, number> = {
  airless: 0,
  rocky:   0,
  gas:     0,
  icy:     0,
  earth:   0,
  cloud:   1 + CLOUD_TOP_KM / EARTH_RADIUS_KM,
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
uniform float uAirLookupRadius;
uniform float uCloudDeck;
uniform sampler2D uCloudDetail;
uniform float uCloudAlbedo;
uniform float uCloudDetailErode;
uniform float uCloudDetailRelief;
uniform sampler2D uNightLights;
uniform float uCloudCityGlow;
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
${RING_SHADOW_OPACITY_GLSL}${MOON_SHADOW_TRACE_GLSL}${ATMOSPHERE_LOOKUP_BODY_GLSL}${AERIAL_PERSPECTIVE_GLSL}${NIGHT_WEIGHT_GLSL}${MOON_UP_GLSL}${SUN_DOWN_GLSL}${CLOUD_COVERAGE_GLSL}${CLOUD_DETAIL_GLSL}${SPHERE_EQUIRECT_UV_GLSL}`;

// Injected after lighting but before <opaque_fragment> writes outgoingLight into
// gl_FragColor — so terms land in linear radiance (tone-mapped downstream) and
// read the perturbed view-space `normal`.
// Injected right after three's own normal-map chunk, which is where the
// perturbed `normal` first exists and still upstream of every light. The deck's
// detail has to land here rather than beside the terms below: those run after
// the lighting, so a normal moved there would shade the deck's own night terms
// and leave the Sun lighting a smooth sphere.
//
// One texel of the tileable noise map per deck fragment, and a uniform branch
// and nothing else on every other surface. The two locals it leaves behind are
// read by the alpha term further down — the map holds the field and its own
// gradient in one texel, so the erosion and the relief share the fetch.
const SURFACE_NORMAL_BODY = /* glsl */ `
float cloudAlpha = 1.0;
vec2 cloudNightUv = vec2(0.0);
vec2 cloudNightDx = vec2(0.0);
vec2 cloudNightDy = vec2(0.0);
if (uCloudDeck > 0.0) {
  // Where this fragment is on the deck, as longitude and latitude. Every
  // derivative the block needs is taken HERE, inside the one branch that is
  // uniform across the draw: a derivative under a per-fragment condition is
  // undefined, and the fade below is exactly such a condition.
  vec3 dir = normalize(vAirFrag);
  vec3 ddx = dFdx(dir);
  vec3 ddy = dFdy(dir);
  vec3 sx = dFdx(-vViewPosition);
  vec3 sy = dFdy(-vViewPosition);
  // Where this fragment stands over the GROUND, in the body's own frame — the
  // frame the night map is painted in. The deck drifts on top of the body's
  // spin, so its own UV is that drift out of register with the cities under it.
  // The derivatives come with it: the lookup happens under a per-fragment
  // condition further down, where an implicit one is undefined.
  vec3 objDir = normalize(vObjPos);
  cloudNightUv = sphereEquirectUv(objDir);
  cloudNightDx = sphereEquirectUvGrad(objDir, dFdx(objDir));
  cloudNightDy = sphereEquirectUvGrad(objDir, dFdy(objDir));
  float cosLat = max(sqrt(dir.x * dir.x + dir.z * dir.z), 1e-4);
  // The angles' screen derivatives, taken analytically from the direction's.
  // atan() has a branch cut at the antimeridian, and reading its derivative
  // through dFdx would put one pixel of enormous gradient down that line — the
  // wrong mip and no detail on it. cos(latitude) is the same sqrt for both.
  vec2 dAngX = vec2((dir.x * ddx.z - dir.z * ddx.x) / (cosLat * cosLat), ddx.y / cosLat);
  vec2 dAngY = vec2((dir.x * ddy.z - dir.z * ddy.x) / (cosLat * cosLat), ddy.y / cosLat);
  vec2 detailUv = vec2(atan(dir.z, dir.x), asin(clamp(dir.y, -1.0, 1.0))) * ${CLOUD_DETAIL_UV_PER_RADIAN.toFixed(7)};
  vec2 duvX = dAngX * ${CLOUD_DETAIL_UV_PER_RADIAN.toFixed(7)};
  vec2 duvY = dAngY * ${CLOUD_DETAIL_UV_PER_RADIAN.toFixed(7)};
  float cloudDetailW = cloudDetailFade(max(length(duvX), length(duvY)) * ${CLOUD_DETAIL_SIZE.toFixed(1)});
  // Explicit gradients, for the same reason the angles' were taken by hand: the
  // mip has to be chosen off a quantity that is continuous across the cut.
  vec4 detail = textureGrad(uCloudDetail, detailUv, duvX, duvY);
  // The deck's alpha is the coverage its own map states. It is worked out HERE,
  // upstream of every light, because the colour has to change with it: the map
  // states coverage and not albedo, so once the alpha carries that coverage the
  // colour must be the cloud's own or the same fraction is counted twice — a
  // half-covered pixel drawn at half the cloud's brightness AND half the
  // ground's, which is a dark ring around every cloud over bright ground.
  float cloudLum = dot(diffuseColor.rgb, vec3(${LUMINANCE_WEIGHTS.map((w) => w.toFixed(4)).join(', ')}));
  cloudAlpha = cloudCoverage(cloudLum);
  // ...eroded by the detail noise where the coverage is at an EDGE. A cloud
  // map's edges are the resolution its authoring stopped at; the noise puts the
  // ragged margin back. Solid cloud keeps its interior and clear sky gains no
  // wisps — the band is zero at both ends.
  cloudAlpha *= mix(1.0, mix(1.0 - uCloudDetailErode, 1.0, detail.r),
      cloudEdgeBand(cloudAlpha) * cloudDetailW);
  // The hue survives; the brightness is pulled toward the cloud's own albedo by
  // however much of the map is coverage rather than albedo. All of it and the
  // solid interiors are one flat white with no structure; none of it and the
  // ring comes back.
  diffuseColor.rgb = min(
      diffuseColor.rgb * pow(uCloudAlbedo / max(cloudLum, 0.001), ${CLOUD_ALBEDO_BLEND.toFixed(6)}),
      vec3(1.0));
  if (cloudDetailW > 0.0) {
    // The packed gradient back into a real slope: field per tile of uv, times
    // the height that field's range stands for. The height is stated against
    // the body's own radius, so it is kilometres of cloud top and not a number
    // tuned against one frame.
    vec2 g = (detail.gb * 2.0 - 1.0) * ${CLOUD_DETAIL_GRADIENT_SCALE.toFixed(1)};
    vec3 nrm = normalize(normal);
    vec3 r1 = cross(sy, nrm);
    vec3 r2 = cross(nrm, sx);
    float det = dot(sx, r1);
    if (abs(det) > 1e-30) {
      vec3 surfGrad = (dot(g, duvX) * r1 + dot(g, duvY) * r2)
          * (uCloudDetailRelief * uPlanetRadius / det);
      normal = normalize(nrm - surfGrad * cloudDetailW);
    }
  }
}`;

const SURFACE_FRAGMENT_BODY = /* glsl */ `{
  // The deck's alpha, worked out with its colour above where the lights could
  // still see both. A deck at a flat opacity dims clear sky by that fraction
  // everywhere and caps the thickest cloud at it; reading the map means a pixel
  // over clear sky has no deck on it at all. The alpha is 1 on every other
  // surface, so the terms below that scale by it are the deck's alone without a
  // second branch.
  diffuseColor.a *= cloudAlpha;
  // The sine of the Sun's elevation at this fragment, off the perturbed normal:
  // the Sun's own Lambert term, which is what the day factor and the Moon's
  // weight below both read so the two describe one crossing.
  float sunElevSin = dot(normalize(normal), normalize(vSunViewDir));
  float dayFactor = smoothstep(-uTermWidth, uTermWidth, sunElevSin);
  // The night lifts fade while this body silhouettes the Sun: a disc backlit
  // by the photosphere is void black in any real exposure, and the starlight
  // fill or earthshine would read as fog painted on the silhouette.
  float nightKeep = 1.0 - uSilhouette;
  // Which way is up at this fragment: the geometry both night weights and every
  // table lookup below are read from.
  vec3 up = normalize(vAirFrag);
  // The Sun's elevation at THIS fragment: the quantity the sources the daylight
  // sky drowns are weighted by, so the airglow on the limb and the sky's own
  // ambient on the ground fade along one line rather than two. Zero where there
  // is no air, which is where the authored floor below is the whole night side.
  float airNight = uAirDensity > 0.0
      ? nightWeight(clampCosine(dot(up, normalize(uSunDirWorld)))) * nightKeep
      : 0.0;
  // The Moon's weight is the Moon's own, not the Sun's. It lights this fragment
  // whenever it stands above the fragment's horizon, and it arrives on a
  // one-sided ramp: full strength at the terminator, where the Sun's own light
  // on this fragment is exactly zero and there is nothing left to double-light,
  // and fading only as the Sun climbs above it. Weight it by anything centred
  // on the terminator and the crossing dips there instead of handing over.
  // The deck's night weight is the shared one, but it is NOT the air's: a city
  // glowing through cloud happens on a device that baked no tables at all, so
  // it cannot ride uAirDensity the way the sky's own ambient does.
  float cloudNight = uCloudDeck > 0.0
      ? nightWeight(clampCosine(dot(up, normalize(uSunDirWorld)))) * nightKeep
      : 0.0;
  float moonNight = uAirDensity > 0.0
      ? moonUpWeight(clampCosine(dot(up, normalize(uMoonDirWorld))))
          * sunDownWeight(sunElevSin, uTermWidth) * nightKeep
      : 0.0;
  // The authored starlight floor, and the sky's own ambient that stands in for
  // it where the tables are bound. They are combined with max() rather than
  // added: two models of one thing added together lift the fragment twice, and
  // switching the authored one off outright lets the tier with the tables come
  // out darker than the tier without them. With the air off the ambient is
  // exactly zero and the floor is the whole night side, unchanged.
  vec3 nightFloor = diffuseColor.rgb * uNightColor
      * (uNightStrength * (1.0 - dayFactor) * nightKeep * ${NIGHT_FLOOR_FRACTION.toFixed(6)});
  vec3 nightAmbient = vec3(0.0);
  if (airNight > 0.0) {
    // The irradiance table is the light a horizontal surface receives from the
    // whole sky. Both irradiances below turn into radiance by albedo/pi — the
    // same law three's own diffuse BRDF applies to the Sun, which is what the
    // bridge these numbers come through was calibrated against. Drop the 1/pi
    // and the night side is lit three times harder than the day side for the
    // same irradiance.
    float rFrag = clampRadius(length(vAirFrag) / uPlanetRadius);
    float muSSun = clampCosine(dot(up, normalize(uSunDirWorld)));
    nightAmbient = diffuseColor.rgb * RECIPROCAL_PI
        * (getIrradiance(uIrradiance, rFrag, muSSun) * uAirlightScale * uSolarIrradiance)
        * airNight;
  }
  outgoingLight += max(nightAmbient, nightFloor);
  // Planetshine: parent-lit glow on the night side. Albedo-multiplicative,
  // so the eclipse color-dim carries through it automatically.
  if (uPlanetshineIntensity > 0.0) {
    float pl = max(dot(normalize(normal), normalize(vPlanetshineViewDir)), 0.0);
    outgoingLight += diffuseColor.rgb * uPlanetshineColor * (uPlanetshineIntensity * pl * (1.0 - dayFactor) * nightKeep);
  }
  // The Moon: its beam through the air above this fragment, and the same
  // irradiance table read with the Moon as the source — which sky it is depends
  // only on where the source is. Behind a uniform branch as well as the weight,
  // so a body with no moon, a new Moon and every day fragment pay none of the
  // six fetches in here.
  if (moonNight > 0.0 && uMoonIrradiance.g > 0.0) {
    float rFrag = clampRadius(length(vAirFrag) / uPlanetRadius);
    float muSMoon = clampCosine(dot(up, normalize(uMoonDirWorld)));
    vec3 moonAmbient = getIrradiance(uIrradiance, rFrag, muSMoon) * uMoonIrradiance;
    vec3 moonDirect = uMoonIrradiance
        * getTransmittanceToSun(uTransmittance, rFrag, muSMoon)
        * max(dot(normalize(normal), normalize(vMoonViewDir)), 0.0);
    outgoingLight += diffuseColor.rgb * RECIPROCAL_PI * (moonAmbient + moonDirect) * moonNight;
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
  // Lit from below: the city lights on the ground under this deck fragment,
  // shining up into it. Added after the eclipse factor and the limb term
  // because neither applies — a moon's umbra does not put a city out, and the
  // deck has no limb darkening of its own — and before the air, because the
  // glow crosses the same column everything else leaving this fragment does.
  if (cloudNight > 0.0 && uCloudCityGlow > 0.0) {
    vec3 city = textureGrad(uNightLights, cloudNightUv, cloudNightDx, cloudNightDy).rgb;
    // The same warm-chroma gate the lights themselves draw through: the map's
    // ice and its background are cold and are not lights, and an ice sheet
    // glowing up through the clouds over Greenland is a continent that blooms.
    city *= smoothstep(${(-EARTH_NIGHT_COLD_CUT / 255).toFixed(6)}, 0.0, city.r - city.b);
    // ...and then the warm gain the lights themselves are drawn in, so one town
    // is one colour whether it is seen through this deck or in clear air beside
    // it. After the chroma gate, never before: the gate reads the map's own
    // r - b to tell a light from an ice sheet, and a tint applied first would
    // be classifying its own output.
    outgoingLight += city * ${EARTH_NIGHT_WARM_GLSL}
        * (uCloudCityGlow * cloudAlpha * cloudNight);
  }
  // Aerial perspective, last: everything above is light leaving this fragment,
  // and all of it crosses the same air on the way to the camera. What survives
  // is x T; what the air itself sends is + S. Zero on a body with no
  // tables, on a device with no tier, and between a lost context and the
  // re-bake — the same text either way, so one program serves every body.
  if (uAirDensity > 0.0) {
    // Where the segment ends. A mesh drawn at the altitude it stands for ends
    // at its own fragment; the cloud deck is drawn at 1.01 R to own the
    // silhouette, which is 64 km up and above the whole column, so its air is
    // looked up at a physical cloud top instead. Same ray, same direction, the
    // radius substituted — and the whole substitution is one uniform, so the
    // injected text stays identical for every surface.
    vec3 airEnd = uAirLookupRadius > 0.0
        ? normalize(vAirFrag) * uAirLookupRadius
        : vAirFrag / uPlanetRadius;
    AerialSegment seg = aerialSegment(
        vAirCam / uPlanetRadius, airEnd, normalize(uSunDirWorld));
    if (seg.valid) {
      vec3 airT = aerialTransmittance(uTransmittance, seg);
      vec3 airS = aerialInscatter(uScattering, seg, airT)
          * uAirlightScale * (uSolarIrradiance * sunVisible);
      // The Moon lights the same column. One traversal, one transmittance: only
      // the two angles that involve the source change, so the second source is
      // a second pair of lookups and nothing else. Behind the Moon's own weight
      // and behind a uniform branch, so a day fragment, a new Moon and a body
      // with no moon at all cost a branch and no fetches.
      if (moonNight > 0.0 && uMoonIrradiance.g > 0.0) {
        airS += aerialInscatter(uScattering, aerialForLight(seg, normalize(uMoonDirWorld)), airT)
            * uMoonIrradiance * moonNight;
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
    // The body's night map, for the same reason: the night-lights shell draws
    // it and the cloud deck glows cities through itself from it, and a second
    // uniform would leave the deck lighting the boot map for the session after
    // the shell's ladder sharpened its own. The 1x1 stand-in until a body has
    // one — sampling it is never legal, because uCloudCityGlow is then 0.
    uNightLights: { value: dummies.map2D },
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
  const uAirLookupRadius = { value: AIR_LOOKUP_RADIUS[archetype] };
  const uCloudDeck = { value: archetype === 'cloud' ? 1 : 0 };
  // The detail map is built once and shared; every other surface binds the same
  // 1x1 stand-in the air's samplers do, and never reads it.
  const uCloudDetail = {
    value: archetype === 'cloud'
      ? cloudDetailTexture() as THREE.Texture
      : surfaceAirDummies().map2D as THREE.Texture,
  };
  const uCloudAlbedo = { value: CLOUD_ALBEDO };
  const uCloudDetailErode = { value: archetype === 'cloud' ? CLOUD_DETAIL_ERODE : 0 };
  const uCloudCityGlow = { value: archetype === 'cloud' ? CLOUD_CITY_GLOW : 0 };
  // The detail's relief as a fraction of the body's own radius, which is what
  // the shader multiplies by uPlanetRadius to reach a real slope.
  const uCloudDetailRelief = {
    value: archetype === 'cloud' ? CLOUD_DETAIL_RELIEF_KM / EARTH_RADIUS_KM : 0,
  };

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
    shader.uniforms.uAirLookupRadius = uAirLookupRadius;
    shader.uniforms.uCloudDeck = uCloudDeck;
    shader.uniforms.uCloudDetail = uCloudDetail;
    shader.uniforms.uCloudAlbedo = uCloudAlbedo;
    shader.uniforms.uCloudDetailErode = uCloudDetailErode;
    shader.uniforms.uCloudCityGlow = uCloudCityGlow;
    shader.uniforms.uCloudDetailRelief = uCloudDetailRelief;
    shader.uniforms.uFrameSpin = uFrameSpin;
    for (const name of Object.keys(fx.air)) shader.uniforms[name] = fx.air[name];

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>${SURFACE_VERTEX_DECLS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>${SURFACE_VERTEX_BODY}`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>${SURFACE_FRAGMENT_DECLS}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>${SURFACE_NORMAL_BODY}`)
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
