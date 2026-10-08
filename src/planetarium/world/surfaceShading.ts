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
 * The reader can add a third model to that max(): Night sides, Brightened
 * (app/nightSidesSetting, the ☰ Display page), lifts a night side to a dimmed
 * copy of its own surface — albedo times one neutral strength, night-weighted
 * like the floor and killed with it in a silhouette — so the ground on the dark
 * half shows. It is never added to the floor or the sky's ambient, and at Real
 * it sits behind a uniform branch that is not taken, so the pixel is what it
 * was. Only the planetarium's own bodies can see it: PlanetFactory points their
 * slot at one shared uniform (`nightLiftUniform`), and every other surface this
 * augment builds — Look inside, How many fit?, the shader warm-up probes —
 * keeps a zero of its own.
 *
 * The Moon is the sixth, and it is weighted by its OWN elevation rather than by
 * the Sun's: `moonUpWeight` times `sunDownWeight`, a one-sided ramp at full
 * strength from the terminator down and fading only as the Sun climbs above it.
 * Gate it by the Sun's night weight instead — or by any ramp centred on the
 * terminator, the day factor's complement included — and the ground runs
 * through a minimum there, the Sun's light gone and the Moon's half arrived,
 * with a gibbous Moon standing right over it.
 *
 * The fifth and sixth terms are drawn as a long exposure (world/nightSources),
 * and a camera only takes one while there is no daylight in view. So each of
 * them — the starlight floor, the sky's ambient, planetshine, and the Moon's
 * beam, its skylight and its column in the haze — is multiplied by
 * `uNightExposure`, one number per body per frame in the shared air block that
 * the mode meters from how much of the visible cap is sunlit
 * (world/nightExposure): a quarter with no daylight in view — the long exposure,
 * held two stops under the level it was authored at — and 0 once enough of the
 * cap is lit; 1, the picture as it was, only with the rule off or stood down.
 * It goes on each weight and never on `nightKeep`, so it composes with the
 * silhouette instead of standing in for it. The sky's ambient is not a
 * non-solar source — it is the Sun's own skylight at the day scale, the
 * irradiance table with no night gain — and in deep night the table's clamp
 * holds it at about the authored floor, so the factor is right there; it also
 * takes the first degrees of real twilight down with it. The deck's city glow
 * does not take it — the cities are the app's own look of Earth at night, and
 * they stay — nor does the reader's lift, which stands the rule down altogether
 * while it is on, and nothing solar reads it.
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
 * That segment ends at the fragment for a surface whose mesh really is at the
 * altitude it stands for, and at a stated radius for the cloud deck, whose
 * coarse sphere sags kilometres between its vertices. `AIR_LOOKUP_RADIUS` is
 * where each archetype's segment really ends.
 *
 * How much of that haze a DIRECT view shows is a body's own number
 * (SURFACE_HAZE_CLEAR_VIEW), and the weight it sets climbs to one at the
 * horizon whatever the number, because that is where the ground's haze has to
 * meet the shell's limb. The weight is one term of the shared air block, so
 * the globe, its sectors, the deck and the additive night lights are graded
 * together: a deck hazed harder than the ground under it would read as a
 * second, higher sky.
 *
 * The injection has five points: the declarations at <common>; the deck's
 * smoothed colour fetch at <map_fragment>; the ocean's gloss remap at
 * <roughnessmap_fragment>; the cloud deck's detail at <normal_fragment_maps> —
 * the one place where the perturbed normal exists and no light has read it yet
 * — and everything else before <opaque_fragment>, after the lighting, where the
 * terms above land in linear radiance. A normal moved at the last point would
 * shade this file's own night terms and leave three's lights on a smooth
 * sphere.
 *
 * Close-range detail synthesis is the seventh term, and it is the only one that
 * exists because a MAP ran out rather than because the light did. Where the
 * colour map on this material is magnified past a texel a pixel — the same band
 * the smooth magnification filter hands over on, measured the same way — a
 * seeded, tileable height field fades in and tilts the normal under it, so a
 * surface that has run out of photograph reads as ground rather than as blur.
 * It composes UNDER whatever is painted: it perturbs shading and never restates
 * a body's colour.
 *
 * Its CPU twin does not exist and must not be written. The procedural moon
 * painter holds every LOOK term in both a GPU and a CPU path so a device that
 * falls back paints the same moon; this is a draw-time term over whatever map
 * is bound, with no painted output to match, and a body wearing a photograph
 * gets it too.
 *
 * The surfaces this file does NOT reach never fade it in: Earth's night-lights
 * shell and its night sectors are their own ShaderMaterial, and the atmosphere
 * shells, the rings, the Sun and the moon dots are not surfaces at all.
 *
 * The injected GLSL is byte-identical for every body (only uniforms differ), so
 * materials still share compiled programs — no custom cache key needed. That
 * holds for the air too: a body without tables takes the same text with
 * `uAirDensity` at zero, rather than a shorter variant that would fork the
 * program cache per body and per tier. The detail term is the same: one text
 * with `uSynthEnvelope` at zero, never a `#define` and never a per-body
 * variant.
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
import { SUN_LIGHT_BASELINE } from '../sunLight';
import { onPerfSwitch, perfSwitchOn, perfSwitchUniform, setPerfSwitch } from '../../app/perfSwitches';
import {
  COX_MUNK_SLOPE_CALM, COX_MUNK_SLOPE_PER_MS, SEA_WIND_MAX_MS, disposeRetiredSeaWindMaps, seaWindTexture,
} from './seaWind';
import { DEFAULT_ALBEDO_PIVOT, surfaceLookOf } from './surfaceLook';
import type { NightSides } from '../../app/nightSidesSetting';
import { EARTH_NIGHT_COLD_CUT, EARTH_NIGHT_WARM_GLSL } from '../../shared/shaders/atmosphere';
import {
  CLOUD_ALBEDO,
  CLOUD_ALBEDO_BLEND,
  CLOUD_CITY_GLOW,
  CLOUD_COVERAGE_GLSL,
  CLOUD_DETAIL_ERODE,
  CLOUD_DETAIL_GLSL,
  CLOUD_DETAIL_RELIEF_KM,
  CLOUD_FRAME_GLSL,
  CLOUD_TOP_KM,
  cloudShellScale,
  LUMINANCE_WEIGHTS,
  SPHERE_EQUIRECT_UV_GLSL,
} from './cloudDeck';
import {
  CLOUD_DETAIL_SIZE,
  CLOUD_DETAIL_GRADIENT_SCALE,
  CLOUD_DETAIL_UV_PER_RADIAN,
  cloudDetailTexture,
} from './cloudDetailNoise';
import { CLOUD_FIELD_MIX_GLSL, cloudFieldGlsl } from './cloudField';
import { cloudFieldDiagUniform, cloudFieldOn, cloudFieldUniforms, setCloudFieldCompiled } from './cloudFieldSlots';
import { MOON_UP_GLSL, NIGHT_WEIGHT_GLSL, NIGHT_WEIGHT_ZERO_SIN, SUN_DOWN_GLSL } from './nightSources';
import { gpuSeed } from './proceduralMoon';
import { SURFACE_TEXEL_FADE } from './surfaceDensity';
import { RELIEF_SPHERE_FRAME_GLSL } from './reliefFrame';
import {
  SURFACE_DETAIL_GRADIENT_SCALE,
  surfaceDetailFieldMean,
  surfaceDetailHeightSpan,
  surfaceDetailTexture,
} from './surfaceDetailNoise';
import { PLANETS } from '../planets/planetData';

/** The cloud deck is a surface class of its own: its alpha is the coverage its
 *  own map states rather than a flat opacity (world/cloudDeck), it hazes and
 *  eclipses like the ground under it, and it draws the same night terms every
 *  other surface does
 *  — the sky's ambient and the Moon — which is what makes moonlit cloud tops
 *  read silver. What it does NOT carry is an authored starlight fill of its own
 *  (`NIGHT_FILL.cloud` is zero): the globe beneath it already has one, and that
 *  floor is too faint to draw anything under the tone curve's toe.
 *
 *  The reader's night lift (Night sides: Brightened) is bright enough to see,
 *  and the deck DOES carry it: left unlit over a lifted globe, cloud would lay
 *  black shapes across the night side the reader asked to see. Nothing is lit
 *  twice, because the deck's blend is a straight source-alpha one, not
 *  premultiplied: every night term — the table's and the lift — composes as
 *  a·term(cloud) + (1−a)·term(ground), each layer once, in its own colours. */
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
  /** The reader's night lift (Night sides: Brightened), as a fraction of
   *  albedo. A fresh set gets a zero of its own; PlanetFactory points the
   *  planetarium's bodies at `nightLiftUniform` instead, so the setting reaches
   *  them and nothing else — a tool's surface cannot be lifted by construction.
   *  Bound at compile time like every other slot here, so the pointing has to
   *  happen before the material's first compile. */
  uNightLift: { value: number };
  /** 1 while a cloud deck is drawn over this body's ground, written each frame
   *  by the mode beside the deck's drift; 0 on every other body and on every
   *  surface a tool or a warm-up probe builds, whose fx is its own. What the
   *  ground's cloud shadows (CLOUD_SHADOW) are gated on per frame, so a deck
   *  the range gate or a role switch has hidden leaves no shadow behind. */
  uCloudAbove: { value: number };
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
  // through it. Its share of the table's own night terms it does draw, and that
  // is what silvers a moonlit cloud top; the reader's night lift it draws too
  // (see SurfaceArchetype), because unlike this fill that lift is bright enough
  // to see and an unlit deck would black out the ground it lifts. The
  // terminator width is the globe's, because the same rolloff gates the eclipse
  // spot on both and the two have to move together.
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

/**
 * How much of the air's haze a DIRECT view of a body's surface shows, 0..1.
 * The weight the shaders derive from it (aerialHazeWeight, world/atmosphereLut)
 * is this number where the line of sight stands on the ground and one where it
 * grazes it, so the horizon always carries the whole column and the limb meets
 * the shell as baked. A presentation grade on the physical aerial perspective,
 * never a change to the air: the tables, the sky shell and the limb are
 * untouched, and 1 is the physics.
 *
 * Earth is the one body graded down. Its day map is atmosphere-corrected
 * surface reflectance, and the clear-sky column the tables put back over it is
 * a quarter of the blue light gone and the sky's own blue added on top — over
 * a dark ocean the air outshines the water two to one, so the sea flattens to
 * one pale blue and the Sahara greys. That is what a photograph from orbit
 * records, and it is not the crisp Earth the disc is expected to be. Mars
 * keeps its physics: a dusty haze IS the look of that planet.
 *
 * Live as `__moon.haze` and `?haze=<clear view>` in a development build, so
 * candidates are captured out of one page load rather than an edit each.
 */
export const SURFACE_HAZE_CLEAR_VIEW: Readonly<Record<string, number>> = {
  Earth: 0.35,
};

let devSurfaceHaze: number | undefined;
/** Haze every direct view at this strength from now on, on every body with
 *  tables (`__moon.haze`), held to 0..1 because past 1 the mix leaves the
 *  physics; null puts the authored numbers back. Reads back the override in
 *  force, undefined when the authored numbers stand. Development builds only. */
export function setDevSurfaceHaze(clearView?: number | null): number | undefined {
  if (!import.meta.env.DEV) return undefined;
  if (clearView === null) devSurfaceHaze = undefined;
  else if (clearView !== undefined && Number.isFinite(clearView)) {
    devSurfaceHaze = Math.min(1, Math.max(0, clearView));
  }
  return devSurfaceHaze;
}

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

const EARTH_RADIUS_KM = PLANETS.find((p) => p.name === 'Earth')!.radiusKm;

// Where a surface's air segment ENDS, in the radius units the tables are baked
// in (1 = the surface). 0 leaves the segment at the fragment's own radius,
// which is right for every mesh drawn at the altitude it stands for.
//
// The cloud deck IS drawn at the altitude it stands for (cloudShellScale), and
// it still names that altitude here rather than passing 0, because a sphere
// built at the globe's segment count sags away from the sphere it approximates
// by kilometres between its vertices: at 64 longitude segments the chord dips
// 7.7 km below Earth's radius mid-quad, which is most of a cloud top. Read the
// fragment's own radius and the air segment's far end would wander that far
// across every quad of the deck; normalising to the stated altitude ends every
// ray at the same height, which is what the deck is.
//
// The substituted point is always still on the visible side of the globe: a
// deck fragment is only drawn where its normal faces the camera, which is
// within arccos(R_deck/d) of the camera axis, and that cone is strictly
// narrower than the globe's own arccos(R_globe/d) because the deck is the
// larger sphere.
//
// These are radius units and the only body with a deck is Earth, so the deck's
// entry is the cloud top expressed against Earth's radius. A second body that
// grew one would want its own altitude divided by its own radius.
export const AIR_LOOKUP_RADIUS: Record<SurfaceArchetype, number> = {
  airless: 0,
  rocky:   0,
  gas:     0,
  icy:     0,
  earth:   0,
  cloud:   cloudShellScale(EARTH_RADIUS_KM),
};

/**
 * How much albedo grain the close-range term puts back, as a fraction either
 * side of what the map says. Keyed to surface class: a regolith reads as grain
 * at any magnification, ice reads smoother, and the two classes that get none
 * are the two where a grain would be a lie — a gas giant has no surface to
 * grain, and Earth's is mostly ocean, which is the one surface in the system
 * that really is smooth at this scale.
 */
const SYNTH_GRAIN: Record<SurfaceArchetype, number> = {
  airless: 0.10,
  rocky: 0.08,
  icy: 0.06,
  gas: 0,
  earth: 0,
  cloud: 0,
};

/**
 * How steeply the synthesized relief is drawn, against the crater geometry the
 * field was actually built with: 1 is that geometry, unexaggerated. Never on a
 * body wearing a MEASURED surface, which already has its own and would wear a
 * second set of craters lit from the same Sun; on a body wearing a painted one,
 * only from where that painting has run out of texels.
 */
const SYNTH_RELIEF_GAIN: Record<SurfaceArchetype, number> = {
  airless: 1.0,
  rocky: 0.8,
  icy: 0.7,
  gas: 0,
  earth: 0,
  cloud: 0,
};

// --- The ocean's gloss -------------------------------------------------------
//
// Earth's roughness map is a water mask graded into two roughnesses (the pair
// tools/gen-tiles.mjs writes it with), area-averaged so a coast is a fractional
// value between them rather than a stair. What it authors for open water is a
// GGX lobe about as wide as a 7 m/s sea's, the mean wind over the ocean.
//
// A glint is a picture of the wind, and no one width draws one. At that width
// the whole sea is a grey-white wash, dimmer than the sunlit land beside it;
// at a calm width it is a white bead on a glossy globe; and at any width every
// contour is a circle the sphere's own geometry draws, because nothing but the
// normal varies. A real ocean holds a glassy patch that clips to white beside a
// trade-wind sea that reads as a silvery sheen the size of a continent. So the
// width is read per fragment from a map of the wind over the sea
// (world/seaWind.ts) through Cox-Munk's slope law, and the constant below is
// the one width the sea falls back to with the map switched off (`?seawind=0`,
// or a DEV override), kept where it was so the switch is an A/B.
//
// The remap happens where the map is read rather than in the map, so the globe
// and the streamed sectors cut from the same source move together — a sector
// carrying the shipped pair over a globe carrying a different one is a
// rectangle of different sea.

/** What the shipped roughness map grades land and open water at. Mirrors the
 *  ROUGH_LAND / ROUGH_WATER pair in tools/gen-tiles.mjs — the values are read
 *  back out of the map here, so the two have to agree. */
export const ROUGHNESS_MAP_LAND = 0.92;
export const ROUGHNESS_MAP_WATER = 0.45;

/**
 * The one width the whole sea is drawn at when the wind map is off: a GGX
 * alpha of 0.0144 (three squares the roughness), calmer than any real sea, so
 * the reflection is a core that clips to white. It is the picture before the
 * map — `?seawind=0` and the DEV `?glint=` override draw it — and it stays at
 * the value it had so that switch compares against what shipped and not
 * against a third width.
 *
 * How it was chosen, for the record: it was 0.2 (alpha 0.04), and from a
 * whole-disc distance that patch, with the bloom spread around its clipped
 * core, read as too strong. A sheet of six widths from 0.2 down to 0.08 had
 * the glow and the patch shrinking together, because with one lobe the width
 * is the one number that moves both — which is the reason there is a map now.
 */
export const OCEAN_ROUGHNESS = 0.12;
/**
 * The sea's reflectance, as water rather than as three's generic dielectric.
 * three's Schlick curve starts at 4 % head-on and reaches a perfect mirror at
 * grazing; seawater's starts at 2 % (an index of 1.33) and reaches the same
 * place. The shader rescales three's mirror term per fragment by the ratio of
 * the two curves at that fragment's half vector: a half where the glint is,
 * one along the limb and the terminator, where a flat half used to darken the
 * sheen a real sea is brightest.
 */
export const SEA_WATER_IOR = 1.33;
export const SEA_WATER_F0 = ((SEA_WATER_IOR - 1) / (SEA_WATER_IOR + 1)) ** 2;

/**
 * The colour of the open sea's water, as the sea is drawn in it. Earth's day
 * map is surface reflectance, and its open sea is painted: one flat texel,
 * sRGB (2, 30, 84), wherever there is deep water, which in linear light is
 * three times brighter in blue than clear ocean water reflects and carries no
 * red at all. Under a white Sun with a third of the air's veil over it that
 * paint drew a royal blue no photograph of Earth has; every frame measured
 * (EPIC, GOES-18, Galileo, Worldview's corrected reflectance, ISS nadir
 * frames) holds its open sea at red 0.15 to 0.48 of blue and green 0.33 to
 * 0.88 of it, the painted sea at 0.03 to 0.10 and 0.14 to 0.28. So where a
 * texel of the map IS that paint — within a small linear distance of it, so a
 * coast or a shallow bank painted its own colour keeps it — the sea is drawn
 * in this water-leaving reflectance instead, mixed in by the water fraction:
 * clear open ocean's pi times its remote-sensing reflectance, about 0.035 at
 * 443 nm, 0.008 at 555 nm and 0.001 at 670 nm, in display primaries. The
 * terms that carry the rest of a photograph's slate add on top of it: the sky
 * reflected off the water (SEA_SKY, below) and the aerosol's grey in the air
 * (world/atmosphereModel.ts). This is the water's own term they add to,
 * which is why it is the physical value rather
 * than a teal with those baked in.
 *
 * A production build carries the colour as a literal and the share as a
 * uniform (`seaColourUniforms.uSeaMix`, 1): `?seacolour=0` zeroes it on any
 * build, under a branch the whole draw takes the same side of, so the sea is
 * the painted map again, bit for bit — the kill switch, and the A/B. A
 * development build reads the colour from a uniform too (devGlintUniforms,
 * `__moon.glint({seaColour, seaMix})`), so a sheet of candidates comes out of
 * one page load.
 */
export const SEA_WATER_COLOUR: readonly [number, number, number] = [0.0015, 0.009, 0.028];
/** The map's painted open sea, sRGB (2, 30, 84), in linear light: what the
 *  shader detects as the paint. */
export const SEA_PAINT_COLOUR: readonly [number, number, number] = [0.000607, 0.012983, 0.088656];
/** The share of the water colour the sea is drawn in: 1, or 0 on `?seacolour=0`. */
export const seaColourUniforms: { uSeaMix: { value: number } } = { uSeaMix: { value: 1 } };
export function setSeaColourEnabled(on: boolean): void {
  seaColourUniforms.uSeaMix.value = on ? 1 : 0;
}
/** Whether the sea is drawn in the water colour right now (the DEV knob can hold a share between). */
export function seaColourOn(): boolean {
  return seaColourUniforms.uSeaMix.value > 0;
}
/** The `?seacolour=0` kill switch, on any build. */
export function parseSeaColourParam(search: string): boolean {
  return new URLSearchParams(search).get('seacolour') !== '0';
}

/**
 * The sky reflected off the sea's surface (the SEA_SKY define, `?seasky=0`).
 * Water is a mirror as well as a scatterer: at nadir it hands the camera 2 %
 * of the zenith sky, at the oblique views an orbital photograph takes the sea
 * at (50 to 70 degrees from the vertical) 4 to 12 % of a sky several times
 * brighter near the horizon. That is most of the grey-blue veil every ISS
 * frame of open sea carries and the renderer did not, once the water's own
 * colour (SEA_WATER_COLOUR) was right. The sky's radiance along the reflected
 * ray is the air's own scattering table read at the surface, the same table,
 * bridge and phase functions the camera leg's in-scatter uses with the far
 * end gone (the ray leaves the atmosphere), so the two cannot disagree about
 * the sky; times the water's unpolarised Fresnel reflectance at the view's
 * incidence, exact rather than Schlick (which reads 15 to 24 % low in that
 * band). The reflection is about the smooth radial normal: the sea's relief
 * is zero, its wind is a BRDF and not a normal map, and the one fast-changing
 * part of the sky, the Mie aureole about the Sun, is what the beam's own lobe
 * already covers. Below SEA_SKY_GRAZING_COS the incidence is held: a
 * wind-roughened sea reflects less at grazing than a flat one (Mobley reads
 * 0.18 at 80 degrees for 7 m/s where the flat surface reads 0.35), and the
 * exact Fresnel at 73 degrees is that 0.18; the horizon's pixels are the
 * air's in any case. Its own term, never folded into the beam (which the
 * cloud cut, the shoulder and the probe's attribution read), held out of the
 * limb darkening with it, dimmed by an eclipse with it, faded in with the
 * air, and only where there is water, air and a Sun the table knows. Off it
 * is the text it was. Development builds scale it live (`uSeaSky`).
 */
export const SEA_SKY_GRAZING_COS = 0.29;

/**
 * Where the Sun's image lands on glassy water the mirror term runs past white.
 * The tone mapper clips that to a white patch, which a camera does too, but
 * the bloom pass would then smear the excess over the coast and the clouds
 * beside it, and land is no mirror: the water's reflection is held to this
 * cap, in units of white, before anything downstream sees it.
 *
 * In units of the WATER's reflection — the ratio above is applied first — so
 * this is what reaches the tone curve and the bright pass. 1.25 is what the
 * core reached before (a cap of 2.5 on three's term, then a flat half), so the
 * clipped core is as bright as it was: 0.92 in sRGB through the ACES curve,
 * white beside a sea at 0.22 and a sheen at 0.5. Higher is a hair whiter and
 * hands the bright pass more: with the bloom knee (app/bloomConfig.ts) a
 * pixel here feeds the blur its excess over the threshold, a few hundredths at
 * 1.25 and a third of a unit at 1.5. Over a 7 m/s sea the term peaks near
 * 0.15 and the cap never engages; it holds only the glassy patches. In scene
 * units at baseline 1; it rides SUN_LIGHT_BASELINE with the light, as the
 * bloom's line and the beam's knee and cap do, so it is the same number of
 * whites whatever the baseline.
 *
 * Only the old chain applies it: with the beam chain (SEA_BEAM, the default)
 * the shoulder below caps what reaches the camera instead, so this cap and
 * the `cap` knob of `__moon.glint` and `?glint=` act only under `?seabeam=0`.
 */
export const OCEAN_GLINT_CAP = 1.25 * SUN_LIGHT_BASELINE;

/**
 * The beam chain's cap, on what REACHES THE CAMERA (SURFACE_FRAGMENT_BODY,
 * after the air): a shoulder, linear up to the knee and an exponential
 * approach to the cap above it, continuous in value and slope at the knee,
 * per channel, in scene units (a white Lambert disc under the Sun reads
 * SUN_LIGHT_INTENSITY / pi, about 1.23 at the 1.4 baseline). OCEAN_GLINT_CAP flattened the beam's
 * top into a plateau before the air and the limb darkening then sloped it
 * down toward the horizon, which is backwards for a mirror; this holds a core
 * past white just past it, where the tone curve is already rolling off (an
 * ACES input of 1.3 lands at 0.8 of its white, 2.6 at 0.9), and leaves the
 * bright pass a bounded excess. Behind `?seabeam=0`, which keeps the old cap.
 *
 * The shipped numbers keep the physical range: the beam's core reaches 5 to
 * 6 whites at a low Sun and the shoulder only begins at 4, as a guard on the
 * resample and the half-float target rather than a grade, because the tone
 * curve compresses rather than clips and a capped beam goes grey the moment
 * the frame is exposed for it, where an uncapped one stays bright over dark
 * water. What makes that range safe is the sea's flag for the bloom
 * (SEA_BLOOM_FLAG_GLSL): without it the Sun's glow blurred the beam into a
 * halo over the limb and into space, and the only honest cap was under 1.1.
 * The DEV knobs (`__moon.glint({beamKnee, beamCap})`) move both live.
 */
export const OCEAN_BEAM_KNEE = 3.5 * SUN_LIGHT_BASELINE;
export const OCEAN_BEAM_CAP = 7.0 * SUN_LIGHT_BASELINE;

/**
 * The cap and a scale as the shader reads them. In a development build they
 * are uniforms, so the glint can be tuned live at a pose (`__moon.glint`) and
 * a sheet of candidates captured from one page load: the cap, and a flat
 * scale on the sea's whole mirror term that defaults to one now that the
 * Fresnel is water's own, kept as an A/B knob. A production build compiles
 * the cap as a literal and carries neither uniform nor the scale, and the
 * fold test pins that the two texts are the same text.
 */
export const devGlintUniforms: {
  uGlintCap: { value: number };
  uGlintKeep: { value: number };
  uBeamKnee: { value: number };
  uBeamCap: { value: number };
  /** The water colour the sea is drawn in (SEA_WATER_COLOUR), as a uniform so
   *  `__moon.glint({seaColour})` moves it live; a production build compiles
   *  the constant. The share is `seaColourUniforms.uSeaMix` in every build. */
  uSeaColour: { value: THREE.Vector3 };
  /** A scale on the sky reflected off the sea (1; folded out of production). */
  uSeaSky: { value: number };
} = {
  uGlintCap: { value: OCEAN_GLINT_CAP },
  uGlintKeep: { value: 1 },
  uBeamKnee: { value: OCEAN_BEAM_KNEE },
  uBeamCap: { value: OCEAN_BEAM_CAP },
  uSeaColour: { value: new THREE.Vector3(...SEA_WATER_COLOUR) },
  uSeaSky: { value: 1 },
};
const GLINT_CAP_GLSL = import.meta.env.DEV ? 'uGlintCap' : OCEAN_GLINT_CAP.toFixed(2);
const BEAM_KNEE_GLSL = import.meta.env.DEV ? 'uBeamKnee' : OCEAN_BEAM_KNEE.toFixed(2);
const BEAM_CAP_GLSL = import.meta.env.DEV ? 'uBeamCap' : OCEAN_BEAM_CAP.toFixed(2);
const GLINT_KEEP_GLSL = import.meta.env.DEV ? ' * uGlintKeep' : '';
const SEA_COLOUR_GLSL = import.meta.env.DEV ? 'uSeaColour' : `vec3(${SEA_WATER_COLOUR.map((v) => v.toFixed(5)).join(', ')})`;
const SEA_SKY_SCALE_GLSL = import.meta.env.DEV ? ' * uSeaSky' : '';

/** The cloud deck's colour map, and the drift its own frame carries on top of
 *  the body's (with that drift's cosine and sine, `setCloudShadowDrift`).
 *  Shared by every augmented surface so the ocean's mirror term can be cut
 *  where cloud stands between it and the Sun; the map is whatever rung the
 *  deck is currently wearing, written each frame by the mode. */
export const cloudShadowUniforms: {
  uCloudShadowMap: { value: THREE.Texture | null };
  uCloudShadowSpin: { value: number };
  uCloudShadowTurn: { value: THREE.Vector2 };
} = {
  uCloudShadowMap: { value: null },
  uCloudShadowSpin: { value: 0 },
  uCloudShadowTurn: { value: new THREE.Vector2(1, 0) },
};

/** The deck's drift, written each frame by the mode: the angle, which the
 *  sea's straight-down read turns by, and its cosine and sine, which the cloud
 *  shadow's read takes as they are rather than evaluating both again at every
 *  fragment of the ground. */
export function setCloudShadowDrift(drift: number): void {
  cloudShadowUniforms.uCloudShadowSpin.value = drift;
  cloudShadowUniforms.uCloudShadowTurn.value.set(Math.cos(drift), Math.sin(drift));
}

/** Let go of the deck map the frame loop parked above. It is the only
 *  reference to that texture outside the deck's own material, so a session
 *  that ends still holding it keeps a whole colour rung alive and leaves the
 *  next one binding a texture from a disposed scene; cleared, the next
 *  augmented material re-installs the 1x1 stand-in. */
export function resetCloudShadowUniforms(): void {
  cloudShadowUniforms.uCloudShadowMap.value = null;
  setCloudShadowDrift(0);
}

// --- Cloud shadows on the ground, the sea and the air (`?cloudshadows=0`) ----
//
// With the switch on, the share of the Sun's beam a ground fragment receives
// through the deck (`cloudSunKeep`) is read where the ray from that fragment
// toward the Sun pierces the shell the deck is DRAWN on, in the deck's own
// frame (world/cloudDeck: cloudRayDirection, bodyToDeck), instead of straight
// down under the sea's glint alone. One height, the drawn one: a shadow traced
// from any other lies beside its cloud by the difference times the tangent of
// the view angle, which at 400 km and 60° off nadir is a second copy of the
// pattern, not a shadow. Its three readers are the Sun's direct diffuse
// (CLOUD_SHADOW_DEPTH), the sea's glint (the cut that was already there), and
// the air the camera looks through down to that ground (CLOUD_SHADOW_AIR).
//
// The switch is a compile-time define, CLOUD_SHADOW, on the ground materials of
// a body that has a deck — Earth's globe and every sector cut from it — and
// nowhere else: not the deck, not another body, not a tool's surface and not a
// warm-up probe. A define rather than a uniform branch because with it off the
// program is the text it was, after the preprocessor, character for character:
// moving the sea's cut into a second branch on one uniform, with the same
// arithmetic, was measured changing one bit at one pixel on Metal under ANGLE.
// Being part of three's program key, it relinks the program when it moves.
//
// What the shadow reads is the deck's base sheet, through the deck's smooth
// filter — and, in a session with the cloud field (on unless `?cloudtiles=0`,
// world/cloudField), the field's 1.2 km opacity wherever a page is resident at
// the pierce point, over the sheet at the field's own weight: the ground then
// compiles CLOUD_FIELD beside CLOUD_SHADOW (never without it), so a shadow is
// as sharp as the cloud drawn over it and hands over to the sheet with it
// (CLOUD_SHADOW_READ). With the field there the sky's fill reads its table
// only where there is a shade; with it absent the program is the one above.

/** The share of the Sun's direct light a cloud takes from the ground in its
 *  shadow, at full coverage. The rest is what the cloud scatters down through
 *  itself and the skylight around it, neither of which the ground is lit by
 *  in this renderer by day — so 0.7 is an authored stand-in for both, not a
 *  measurement of either. Scaled by the coverage the deck draws there, so a
 *  thin veil takes a little and a solid bank takes all of this. */
export const CLOUD_SHADOW_DEPTH = 0.7;
/** The share of the air's own glow between the camera and a shaded ground
 *  point that the shadow takes with it, at full coverage: about seven tenths of
 *  the air's mass lies below the 10 km the deck is drawn at, and the column
 *  under a cloud is in its shadow. Only the Sun's in-scatter; the air's
 *  transmittance is the air's and is not touched. Over a dark sea this is most
 *  of what a cloud's shadow is. */
export const CLOUD_SHADOW_AIR = 0.6;

/**
 * How the cloud's coverage turns into shade on the ground: the ground and the
 * air under it take `(1 - cloudSunKeep)^gamma` of the share above, never the
 * beam's own loss. A thin veil scatters most of the Sun's light it intercepts
 * on down to the ground — forward, the way a thin cloud does — so the ground
 * under it dims far less than the direct beam does; only thick cloud takes
 * most of the light away. At 2, a half-covered texel shades the ground a
 * quarter as much as a solid bank does. The beam's own share, `cloudSunKeep`,
 * is unchanged, because the sea's glint IS the direct beam and reads it as is.
 */
export const CLOUD_SHADOW_GAMMA = 2.0;

/**
 * Where the shadow on the air fades out as the view grazes the ground, as the
 * cosine between the ground's geometric normal and the line of sight: the full
 * shadow from a half (60° off the vertical) up, none by a tenth (84°). A
 * grazing ray's air below the cloud tops runs hundreds of kilometres from the
 * ground point it ends at, and the cloud read at that one point says nothing
 * about the whole of it: applied there, the limb's haze band went patchy
 * wherever cloud happened to lie under its last few pixels.
 */
export const CLOUD_SHADOW_AIR_GRAZE: readonly [number, number] = [0.10, 0.50];

/**
 * The sine of the Sun's height at the ground under which the shade fades out,
 * reaching nothing where the Sun meets that ground's horizon: 2.9°, the same
 * height every night source is gone by (world/nightSources). Below the horizon
 * the ray enters the ground before any cloud and there is no shade to read,
 * and the Sun's own light on the ground is already near zero above it — but
 * the air's glow is not, and a shade that held its full value to the horizon
 * and stopped there drew a line along the terminator through the haze.
 */
export const CLOUD_SHADOW_HORIZON_SIN = NIGHT_WEIGHT_ZERO_SIN;

/**
 * The sky's own light on ground in a cloud's shade, as a multiple of the
 * irradiance table's skylight, in proportion to the shade. By day the ground in
 * this renderer is lit by the Sun alone — its map is surface reflectance and
 * the clear-sky look is authored against that — so a shadow that takes the
 * Sun away leaves the ground with nothing: over a low-Sun sea, near black.
 * What a shadowed ground really keeps is the sky above it, and that is blue,
 * so with this the shadow reads blue-grey rather than as a darker copy of the
 * ground. 1 is the table's own skylight at the shade's full strength.
 */
export const CLOUD_SHADOW_SKY_FILL = 1.0;

/** On unless `?cloudshadows=0`, the kill switch, read once at boot in any
 *  build. */
const cloudShadowsByUrl = typeof location === 'undefined'
  || new URLSearchParams(location.search).get('cloudshadows') !== '0';
// In a development build the switch is the `cloud-shadow` key
// (app/perfSwitches), so `__moon.perfArm` and the bridge's own knob move it
// live; the kill switch disarms the key so the two readings never disagree.
if (import.meta.env.DEV && !cloudShadowsByUrl) setPerfSwitch('cloud-shadow', false);

/** Whether the ground under a deck compiles its cloud shadows. */
export function cloudShadowsOn(): boolean {
  return import.meta.env.DEV ? perfSwitchOn('cloud-shadow') : cloudShadowsByUrl;
}

/**
 * The shell's height and, in a development build, the three knobs
 * (`__moon.cloudShadow`), shared by every material that compiles the shadow.
 * The height is the drawn deck's own (CLOUD_TOP_KM over Earth's radius): the
 * only body with a deck is Earth, as for the deck's own air lookup. A
 * production build compiles the depth, the air share and the penumbra as the
 * constants above and carries no uniform for them; the fold test pins that the
 * two texts are the same text.
 */
export const cloudShadowShared: {
  uCloudHeightOverRadius: { value: number };
  uCloudShadowDepth: { value: number };
  uCloudShadowAir: { value: number };
  uCloudShadowPenumbra: { value: number };
  uCloudShadowGamma: { value: number };
  uCloudShadowSkyFill: { value: number };
} = {
  uCloudHeightOverRadius: { value: CLOUD_TOP_KM / EARTH_RADIUS_KM },
  uCloudShadowDepth: { value: CLOUD_SHADOW_DEPTH },
  uCloudShadowAir: { value: CLOUD_SHADOW_AIR },
  uCloudShadowPenumbra: { value: 1 },
  uCloudShadowGamma: { value: CLOUD_SHADOW_GAMMA },
  uCloudShadowSkyFill: { value: CLOUD_SHADOW_SKY_FILL },
};
const CLOUD_SHADOW_DEPTH_GLSL = import.meta.env.DEV ? 'uCloudShadowDepth' : CLOUD_SHADOW_DEPTH.toFixed(4);
const CLOUD_SHADOW_AIR_GLSL = import.meta.env.DEV ? 'uCloudShadowAir' : CLOUD_SHADOW_AIR.toFixed(4);
const CLOUD_SHADOW_GAMMA_GLSL = import.meta.env.DEV ? 'uCloudShadowGamma' : CLOUD_SHADOW_GAMMA.toFixed(4);
const CLOUD_SHADOW_SKY_FILL_GLSL = import.meta.env.DEV ? 'uCloudShadowSkyFill' : CLOUD_SHADOW_SKY_FILL.toFixed(4);
// In a development build a fill knobbed to zero skips the table fetch; a
// production build reads the constant and the plain condition.
const CLOUD_SHADOW_SKY_FILL_GUARD = import.meta.env.DEV ? 'uCloudShadowSkyFill > 0.0 && ' : '';
const CLOUD_SHADOW_PENUMBRA_GUARD = import.meta.env.DEV ? 'uCloudShadowPenumbra * ' : '';

/** The fx of every body whose ground a deck stands over: a ground material
 *  augmented with one of these — the globe, then each sector re-augmented from
 *  it — is a receiver. Keyed on the fx because a sector shares its globe's. */
const groundsUnderDeck = new WeakSet<SurfaceShadingFx>();
/** Every live receiver, so the switch can reach the materials already drawn. */
const cloudShadowReceivers = new Set<THREE.Material>();

/** Say a deck stands over this ground material's body. Called once, by whoever
 *  builds the deck, with the body's globe; the sectors later cut from that
 *  globe follow on their own. The deck itself, and any material of a body
 *  without this call — another planet, a tool's surface, a warm-up probe —
 *  never compiles the shadow. */
export function setGroundUnderCloudDeck(mat: THREE.Material): void {
  const args = augmentArgs.get(mat);
  if (!args || args.archetype === 'cloud') return;
  groundsUnderDeck.add(args.fx);
  receiveCloudShadow(mat);
}

/** Whether this material compiles the cloud shadow right now. */
export function surfaceCloudShadowCompiled(mat: THREE.Material): boolean {
  return mat.defines?.CLOUD_SHADOW !== undefined;
}

function receiveCloudShadow(mat: THREE.Material): void {
  if (!cloudShadowReceivers.has(mat)) {
    cloudShadowReceivers.add(mat);
    mat.addEventListener('dispose', () => cloudShadowReceivers.delete(mat));
  }
  applyCloudShadow(mat, cloudShadowsOn());
}

/** The shadow on a receiver, and the cloud field it reads with it: a ground
 *  compiles CLOUD_FIELD only beside CLOUD_SHADOW, and only in a session that
 *  has the field (world/cloudFieldSlots), so a ground without the shadow is
 *  the program it was whether or not the deck has the field. */
function applyCloudShadow(mat: THREE.Material, on: boolean): void {
  applySwitchDefine(mat, 'CLOUD_SHADOW', on);
  setCloudFieldCompiled(mat, on);
}

/** Set or clear one of the cloud switches' defines on a material. */
function applySwitchDefine(mat: THREE.Material, name: 'CLOUD_SHADOW' | 'CLOUD_LIGHT' | 'SUN_PATH' | 'SEA_BEAM' | 'SEA_SKY', on: boolean): void {
  const defines = (mat.defines ??= {});
  if ((defines[name] !== undefined) === on) return;
  if (on) defines[name] = '';
  else delete defines[name];
  // The define is part of three's program key: the next draw links (or finds)
  // the program with the other text.
  mat.needsUpdate = true;
}

if (import.meta.env.DEV) {
  onPerfSwitch('cloud-shadow', (on) => {
    for (const mat of cloudShadowReceivers) applyCloudShadow(mat, on);
  });
}

/** The shadow's knobs, live (`__moon.cloudShadow`): `on` moves the switch and
 *  relinks the receivers, the rest are uniforms from the next frame. Returns
 *  the values in force. Development builds only. */
export function devCloudShadow(opts?: {
  on?: boolean;
  depth?: number;
  air?: number;
  penumbra?: boolean | number;
  gamma?: number;
}): {
  on: boolean;
  depth: number;
  air: number;
  penumbra: number;
  gamma: number;
  heightOverRadius: number;
  receivers: number;
  compiled: number;
} | null {
  if (!import.meta.env.DEV) return null;
  if (opts?.on !== undefined) setPerfSwitch('cloud-shadow', opts.on);
  if (opts?.depth !== undefined && Number.isFinite(opts.depth)) cloudShadowShared.uCloudShadowDepth.value = opts.depth;
  if (opts?.air !== undefined && Number.isFinite(opts.air)) cloudShadowShared.uCloudShadowAir.value = opts.air;
  if (opts?.penumbra !== undefined) {
    cloudShadowShared.uCloudShadowPenumbra.value = typeof opts.penumbra === 'boolean'
      ? (opts.penumbra ? 1 : 0)
      : opts.penumbra;
  }
  if (opts?.gamma !== undefined && Number.isFinite(opts.gamma) && opts.gamma > 0) {
    cloudShadowShared.uCloudShadowGamma.value = opts.gamma;
  }
  let compiled = 0;
  for (const mat of cloudShadowReceivers) if (surfaceCloudShadowCompiled(mat)) compiled++;
  return {
    on: cloudShadowsOn(),
    depth: cloudShadowShared.uCloudShadowDepth.value,
    air: cloudShadowShared.uCloudShadowAir.value,
    penumbra: cloudShadowShared.uCloudShadowPenumbra.value,
    gamma: cloudShadowShared.uCloudShadowGamma.value,
    heightOverRadius: cloudShadowShared.uCloudHeightOverRadius.value,
    receivers: cloudShadowReceivers.size,
    compiled,
  };
}

// --- The deck lit as a cloud (`?cloudlight=0`) -------------------------------
//
// By day the deck is lit by the Sun's direct light on its perturbed normal and
// by nothing else: three has no other light in the planetarium and the sky's
// own ambient is a night term. So a facet of the relief tilted away from a low
// Sun draws pure black — darker than the sea under it — and a shaded flank has
// no colour at all. A real cloud's shaded side is lit from inside, by light
// scattered through the cloud, and from outside, by the sky. CLOUD_LIGHT, a
// compile-time define on the planetarium's own deck and nowhere else (not the
// ground, not a tool's deck) but the warm-up probe that stands in for it, adds
// those two in `outgoingLight` alone. The deck's alpha is its coverage and nothing here
// writes it: a light term changes how bright the cloud is, never how much of
// the pixel it owns.

/**
 * How much of the deck's direct diffuse is taken on its geometric normal (the
 * shell's own radial one) instead of the relief's perturbed normal: the light
 * scattered inside a cloud reaches its far flanks, so the relief shades a
 * cloud's sides but cannot put a side in the dark. 0 is today's deck; 1 would
 * light the deck as a smooth sphere and flatten the relief out. A mix, so a
 * cloud top in full Sun keeps its brightness.
 */
export const CLOUD_LIGHT_WRAP = 0.4;
/**
 * How much of the sky's own irradiance lights the deck by day, as a multiple
 * of the table's (the same irradiance table the night side's ambient reads,
 * at the deck's own radius and the Sun's height there). It joins the night
 * ambient along one ramp, the night weight's complement, so the two hand over
 * where every night source does and the sum is the table's irradiance on both
 * sides of the terminator. Only where a body's air tables are bound: with no
 * tables there is no sky to read and the deck has none, as before.
 */
export const CLOUD_LIGHT_SKY = 1.0;

/** On unless `?cloudlight=0`, the kill switch, read once at boot in any
 *  build. */
const cloudLightByUrl = typeof location === 'undefined'
  || new URLSearchParams(location.search).get('cloudlight') !== '0';
if (import.meta.env.DEV && !cloudLightByUrl) setPerfSwitch('cloud-light', false);

/** Whether the planetarium's deck compiles its cloud light. */
export function cloudLightOn(): boolean {
  return import.meta.env.DEV ? perfSwitchOn('cloud-light') : cloudLightByUrl;
}

/**
 * The cloud light's knobs (`__moon.cloudLight`). A production build compiles
 * the wrap and the sky as the constants above and carries neither uniform.
 * The same bridge entry also moves the ground's sky fill under a shadow
 * (`groundFill`), which is CLOUD_SHADOW's term and lives in its uniforms.
 */
export const cloudLightShared: {
  uCloudLightWrap: { value: number };
  uCloudLightSky: { value: number };
} = {
  uCloudLightWrap: { value: CLOUD_LIGHT_WRAP },
  uCloudLightSky: { value: CLOUD_LIGHT_SKY },
};
const CLOUD_LIGHT_WRAP_GLSL = import.meta.env.DEV ? 'uCloudLightWrap' : CLOUD_LIGHT_WRAP.toFixed(4);
const CLOUD_LIGHT_SKY_GLSL = import.meta.env.DEV ? 'uCloudLightSky' : CLOUD_LIGHT_SKY.toFixed(4);

/** The planetarium's deck, registered by whoever builds it. */
const cloudLightReceivers = new Set<THREE.Material>();

/** Say this material is the planetarium's own cloud deck, the one surface the
 *  cloud light (CLOUD_LIGHT) compiles into. Any other deck — Look inside's — is
 *  never registered and never compiles it. */
export function setPlanetariumCloudDeck(mat: THREE.Material): void {
  const args = augmentArgs.get(mat);
  if (!args || args.archetype !== 'cloud') return;
  if (!cloudLightReceivers.has(mat)) {
    cloudLightReceivers.add(mat);
    mat.addEventListener('dispose', () => cloudLightReceivers.delete(mat));
  }
  applySwitchDefine(mat, 'CLOUD_LIGHT', cloudLightOn());
}

/** Give the warm-up probe that stands in for the planetarium's deck
 *  (world/shaderWarmupProbes) the cloud light as the session compiles it, or
 *  the program it links under the boot cover is one the deck never draws with
 *  and the deck's own links once its relief lands, in view. Not a receiver: a
 *  development build's flip relinks the deck on purpose, and the probe keeps
 *  the boot's answer. */
export function setCloudDeckWarmupProbe(mat: THREE.Material): void {
  const args = augmentArgs.get(mat);
  if (!args || args.archetype !== 'cloud') return;
  applySwitchDefine(mat, 'CLOUD_LIGHT', cloudLightOn());
}

/** Whether this material compiles the cloud light right now. */
export function surfaceCloudLightCompiled(mat: THREE.Material): boolean {
  return mat.defines?.CLOUD_LIGHT !== undefined;
}

if (import.meta.env.DEV) {
  onPerfSwitch('cloud-light', (on) => {
    for (const mat of cloudLightReceivers) applySwitchDefine(mat, 'CLOUD_LIGHT', on);
  });
}

/** The cloud light's knobs, live (`__moon.cloudLight`): `on` moves the switch
 *  and relinks the deck, the rest are uniforms from the next frame. Returns
 *  the values in force. Development builds only. */
export function devCloudLight(opts?: {
  on?: boolean;
  wrap?: number;
  sky?: number;
  groundFill?: number;
}): { on: boolean; wrap: number; sky: number; groundFill: number; receivers: number; compiled: number } | null {
  if (!import.meta.env.DEV) return null;
  if (opts?.on !== undefined) setPerfSwitch('cloud-light', opts.on);
  if (opts?.wrap !== undefined && Number.isFinite(opts.wrap)) cloudLightShared.uCloudLightWrap.value = opts.wrap;
  if (opts?.sky !== undefined && Number.isFinite(opts.sky)) cloudLightShared.uCloudLightSky.value = opts.sky;
  if (opts?.groundFill !== undefined && Number.isFinite(opts.groundFill)) {
    cloudShadowShared.uCloudShadowSkyFill.value = opts.groundFill;
  }
  let compiled = 0;
  for (const mat of cloudLightReceivers) if (surfaceCloudLightCompiled(mat)) compiled++;
  return {
    on: cloudLightOn(),
    wrap: cloudLightShared.uCloudLightWrap.value,
    sky: cloudLightShared.uCloudLightSky.value,
    groundFill: cloudShadowShared.uCloudShadowSkyFill.value,
    receivers: cloudLightReceivers.size,
    compiled,
  };
}

/**
 * Night sides: Brightened's strength, as a fraction of each fragment's own
 * albedo on the night half. Neutral — no starlight tint — so a red body reads
 * red and a crater field reads as craters; one number for every body.
 *
 * 0.045 is the lowest strength at which the darkest ground shows: Mercury's
 * and Mars's night discs come to about 10/255 at exposure 1, where 0.03 leaves
 * them at 5 or 6, barely off black. The lift is a fraction of albedo and not
 * of sunlight, so it does not fall off with distance from the Sun the way the
 * day side does: the farther and brighter a body, the closer its lifted night
 * comes to its own day. At this strength Enceladus's night disc carries about
 * a sixth of its day half's light, where the Moon's carries a twentieth. A
 * body with planetshine (Europa, Tethys) is already that bright at night
 * without any lift.
 */
export const NIGHT_LIFT_STRENGTH = 0.045;

/**
 * The one uniform object every planetarium body's night lift reads — the
 * globes, their streamed sectors and the cloud deck (all of which share their
 * body's fx) and the moons. Zero is Real: the shader's branch is not taken and
 * the frame is what it was. The entry point writes it through
 * `applyNightLift`; the DEV bridge's `nightLift` pin writes it directly.
 */
export const nightLiftUniform: { value: number } = { value: 0 };

/** Apply the reader's Night sides choice to every planetarium body, from the
 *  next frame. Nothing recompiles: the value is a uniform. */
export function applyNightLift(mode: NightSides): void {
  nightLiftUniform.value = mode === 'brightened' ? NIGHT_LIFT_STRENGTH : 0;
}

/** The factor the map's distance BELOW land is multiplied by to land open
 *  water on OCEAN_ROUGHNESS. A coast's fractional water score keeps its
 *  fraction — the coastal gradation is scaled, not thresholded away. */
const WATER_GLOSS_GAIN = (ROUGHNESS_MAP_LAND - OCEAN_ROUGHNESS)
  / (ROUGHNESS_MAP_LAND - ROUGHNESS_MAP_WATER);

/** The remap, as the shader applies it: land unmoved, open water at
 *  OCEAN_ROUGHNESS, a fractional coast in proportion. */
export function waterGlossRoughness(mapRoughness: number): number {
  return Math.max(
    ROUGHNESS_MAP_LAND - (ROUGHNESS_MAP_LAND - mapRoughness) * WATER_GLOSS_GAIN,
    0.02,
  );
}

/**
 * three's own <roughnessmap_fragment>, reading RED instead of green.
 *
 * three reads green so a roughness map can be one channel of a packed
 * occlusion/roughness/metalness image. Nothing here packs anything: the only
 * roughness map any surface in this app binds is Earth's water mask, a grey
 * image where red IS green — which is what lets it be stored one byte a texel
 * instead of four (world/texturePolicy's 'mask' kind), on the globe and on
 * every resident sector's crop of it. A packed map bound here would need this
 * line back on green and its storage back to four channels.
 */
const SURFACE_ROUGHNESSMAP_FRAGMENT = /* glsl */ `
float roughnessFactor = roughness;
#ifdef USE_ROUGHNESSMAP
	roughnessFactor *= texture2D( roughnessMap, vRoughnessMapUv ).r;
#endif
`;

/** The roughness chunk this build compiles. In DEV with one-channel storage
 *  switched off (`?perfoff=r8-maps`) the map is RGBA again and three's own
 *  chunk reads green from it, as it did before the change — so that switch's
 *  A/B compares the two whole pipelines, storage and channel together, rather
 *  than two readings of red. A production build compiles the red read alone. */
function roughnessChunk(): string {
  return import.meta.env.DEV && !perfSwitchOn('r8-maps')
    ? '#include <roughnessmap_fragment>'
    : SURFACE_ROUGHNESSMAP_FRAGMENT;
}

/**
 * The GLSL half of `waterGlossRoughness`, behind the uniform that is zero on
 * every surface but a globe whose roughness map really is a water mask — and,
 * with the wind map on, the sea's own lobe under this fragment: the wind
 * read in the body frame (world/seaWind.ts) and turned into the roughness
 * three lights the sea at through Cox-Munk's slope law (`windRoughness` in
 * GLSL). The read takes explicit gradients, as the cloud shadow's does,
 * because the UV jumps a whole turn at the date line and an implicit
 * derivative across it would pick the coarsest mip down one column of sea;
 * the gradients are taken in the uniform branch, outside the per-fragment
 * gate that spares pure land the fetch.
 */
const WATER_GLOSS_GLSL = /* glsl */ `
float seaWater = 0.0;
if (GROUND_ON(uWaterGloss > 0.0)) {
  float waterGain = uWaterGloss;
  seaWater = clamp((${ROUGHNESS_MAP_LAND.toFixed(6)} - roughnessFactor)
      / ${(ROUGHNESS_MAP_LAND - ROUGHNESS_MAP_WATER).toFixed(6)}, 0.0, 1.0);
  if (uSeaWindOn > 0.5) {
    vec3 seaDir = normalize(vObjPos);
    vec2 seaUv = sphereEquirectUv(seaDir);
    vec2 seaDx = sphereEquirectUvGrad(seaDir, dFdx(seaDir));
    vec2 seaDy = sphereEquirectUvGrad(seaDir, dFdy(seaDir));
    if (roughnessFactor < ${(ROUGHNESS_MAP_LAND - 0.005).toFixed(6)}) {
      float seaWindMs = textureGrad(uSeaWindMap, seaUv, seaDx, seaDy).r * ${SEA_WIND_MAX_MS.toFixed(1)};
      float seaRoughness = sqrt(sqrt(${COX_MUNK_SLOPE_CALM.toFixed(5)}
          + ${COX_MUNK_SLOPE_PER_MS.toFixed(5)} * seaWindMs));
      waterGain = (${ROUGHNESS_MAP_LAND.toFixed(6)} - seaRoughness)
          / ${(ROUGHNESS_MAP_LAND - ROUGHNESS_MAP_WATER).toFixed(6)};
    }
  }
  roughnessFactor = max(${ROUGHNESS_MAP_LAND.toFixed(6)}
      - (${ROUGHNESS_MAP_LAND.toFixed(6)} - roughnessFactor) * waterGain, 0.02);
  // The water's own colour (SEA_WATER_COLOUR): the day map's open sea is one
  // flat painted texel, so a texel within a small linear distance of that
  // paint is the paint and nothing else, and is mixed toward the water colour
  // by the water fraction; a coast or a bank the map painted its own colour
  // is left as it is. Behind the share's uniform branch so ?seacolour=0 is
  // the painted map again, bit for bit.
  if (uSeaMix > 0.0) {
    float seaPaint = 1.0 - smoothstep(0.012, 0.03,
        distance(diffuseColor.rgb, vec3(${SEA_PAINT_COLOUR.map((v) => v.toFixed(6)).join(', ')})));
    diffuseColor.rgb = mix(diffuseColor.rgb, ${SEA_COLOUR_GLSL}, seaWater * seaPaint * uSeaMix);
  }
}`;

// Analytic stand-in for Saturn's ring opacity across the annulus (t: 0 inner …
// 1 outer), used only for the shadow it casts — the major features that read on
// the globe are the dense B ring, the clear Cassini Division, and the slightly
// thinner A ring. This mirrors the band layout painted by paintRing('saturn') in
// planets/rings.ts; keep the two in step so the cast shadow lines up with the
// ring that casts it (this is a coarse re-derivation, not a shared source).
export const RING_SHADOW_OPACITY_GLSL = /* glsl */ `
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
varying vec3 vAirFrag;
#if defined( USE_NORMALMAP_TANGENTSPACE ) && !defined( CLOUD_DECK )
varying vec3 vReliefPole;
#endif`;

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
vAirFrag = mat3(modelMatrix) * position;
#if defined( USE_NORMALMAP_TANGENTSPACE ) && !defined( CLOUD_DECK )
// The relief frame's one input (world/reliefFrame.ts): the body's pole
// (SphereGeometry's +Y) in the view space the fragment's normal is in. A
// sector is a child of its body's mesh, so its normalMatrix carries the same
// pole.
vReliefPole = normalMatrix * vec3(0.0, 1.0, 0.0);
#endif`;

/**
 * The hand-over from the smooth magnification filter back to plain bilinear, in
 * map texels per screen pixel. Defined once in world/surfaceDensity and read
 * here and on the CPU alike: a surface must not start smoothing at one density
 * and gain close-range detail at another.
 */
const SMOOTH_TEXEL_FADE = SURFACE_TEXEL_FADE;

/**
 * A cubic B-spline magnification filter, for the two maps only the cloud deck
 * wears. Bilinear magnification is C0 — the interpolant's SLOPE jumps at every
 * texel boundary — and any nonlinear function of the result (the deck's
 * coverage curve, a normal map through a light) turns that jump into a visible
 * crease. Stretch a texel over twenty screen pixels, as an orbital-altitude
 * frame of an 8K whole-globe map does, and the creases draw the texel grid:
 * square-edged cloud blobs, square holes, straight seams across the interiors.
 *
 * The B-spline kernel is C2 and four texels wide, so the grid has nothing left
 * to draw — and unlike a smoothstep warp of the sample point, which is also C1
 * but leaves each texel's centre flat, it does not trade creases for plateaus.
 * Four bilinear taps by the standard weight-folding, and only where the map is
 * actually magnified: `smoothTexelWeight` is zero everywhere else, and the taps
 * sit behind it.
 *
 * The taps are explicit-LOD. Their offsets are discontinuous at texel
 * boundaries, so an implicit derivative would pick a mip off a garbage
 * footprint; under magnification the level is zero by definition, which is what
 * the fade above is really saying.
 */
const SMOOTH_TEXEL_GLSL = /* glsl */ `
// How much of the smooth filter this fragment wants: 1 while the map is
// magnified, 0 once the mip chain has taken over.
float smoothTexelWeight(vec2 uv, vec2 texels) {
  float perPixel = max(fwidth(uv.x) * texels.x, fwidth(uv.y) * texels.y);
  return 1.0 - smoothstep(${SMOOTH_TEXEL_FADE[0].toFixed(6)}, ${SMOOTH_TEXEL_FADE[1].toFixed(6)}, perPixel);
}
vec4 textureBSpline(sampler2D tex, vec2 uv, vec2 texels) {
  vec2 p = uv * texels - 0.5;
  vec2 f = fract(p);
  vec2 base = p - f;
  vec2 f2 = f * f;
  vec2 f3 = f2 * f;
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
  vec2 w3 = f3 / 6.0;
  // Each PAIR of taps is folded into one bilinear fetch placed between them:
  // four texels of support for two fetches per axis.
  vec2 s0 = w0 + w1;
  vec2 s1 = w2 + w3;
  vec2 t0 = (base + w1 / s0 - 0.5) / texels;
  vec2 t1 = (base + w3 / s1 + 1.5) / texels;
  return mix(
      mix(textureLod(tex, vec2(t1.x, t0.y), 0.0), textureLod(tex, vec2(t0.x, t0.y), 0.0), s0.x),
      mix(textureLod(tex, vec2(t1.x, t1.y), 0.0), textureLod(tex, vec2(t0.x, t1.y), 0.0), s0.x),
      s1.y);
}
`;

// --- Close-range detail synthesis -------------------------------------------
//
// Past the band above, a colour map has nothing left to say: a texel is being
// stretched over more than a pixel, the smooth filter has taken over, and what
// the eye sees is interpolation. A photograph at that magnification reads as
// blur, and a procedural moon's painted canvas reads as putty. This fades in a
// seeded, tileable HEIGHT field under whatever is painted and tilts the normal
// with it — so the surface answers the light instead of restating its own
// colour, which is the difference between ground and a picture of ground.
//
// It is a height field on purpose. Synthetic relief painted into the albedo
// draws its own shadows, and those shadows do not move with the Sun; at grazing
// light they read as fake craters, which is the verdict that killed an earlier
// attempt at synthetic relief and the bar this one is measured against.

/** Screen size, in render-target pixels, the field's tile is drawn at. The map
 *  is 512 texels across, so a tile this wide puts its finest texel on about one
 *  pixel — where the mip chain hands over and nothing crawls — and its craters
 *  between five and sixty pixels, which is the range an eye reads as ground. */
const SURFACE_DETAIL_TILE_PX = 512;

/**
 * How far off its own axis a flat chart still says anything, as the cosine
 * between the surface point and that axis.
 *
 * It has a ceiling and a cost. The ceiling is 0.577: the largest component of a
 * unit vector is never smaller than that, so a cut above it would leave the
 * points on the body's diagonals with no chart at all. Below it every chart
 * covers more, and the overlaps are where two or three are drawn instead of one
 * — another pair of texture fetches on every fragment that falls in one. At a
 * half, a point of the sphere is drawn by 1.5 charts on average and the widest
 * overlap runs over thirty degrees of arc, which is far slower than anything
 * the field itself draws.
 */
export const SYNTH_CHART_CUT = 0.5;

/**
 * How many rungs finer a body with NO cratering draws the field.
 *
 * The field is one packed map with craters and grain already summed into it, so
 * nothing can turn the craters down at sample time. What can be done is draw
 * the whole field smaller: it is scale-free, so three rungs finer turns a
 * crater that spanned five to sixty pixels into one spanning a pixel or seven —
 * ground texture rather than impacts — and flattens its relief with it, because
 * the field keeps its own depth-to-width. A share between the two rides the
 * ordinary crossfade.
 *
 * The cost is at the top of the ladder: the rung ceiling arrives three rungs
 * earlier on a share-0 body, so a camera standing on Europa reaches the
 * magnifying regime sooner and its pitting grows as it comes closer instead of
 * staying put. If that is ever seen, the fix is a second grain-only field
 * sampled in place of this one, not a bigger ceiling.
 */
const SYNTH_SMOOTH_RUNGS = 3;

/**
 * How much of its RELIEF a body with no cratering keeps.
 *
 * Drawing the field finer makes its craters small; it does not make them
 * shallow, because the field is scale-free and keeps its slope at every rung.
 * A body with nothing to crater it therefore came out pitted — dense little
 * holes at full shading contrast, which is a golf ball rather than smooth ice.
 * What a resurfaced surface should read as is frost-scale texture: fine AND
 * faint. So the relief is scaled down with the share, while the albedo grain
 * stays at its archetype's value — the ground still has a texture, it just
 * stops answering the light like a crater field.
 */
const SYNTH_RELIEF_FLOOR = 0.15;

/**
 * The three charts' weights at a point of the unit sphere, as the shader
 * computes them — the CPU twin of the three lines in the GLSL below, kept so
 * the two properties the whole domain rests on can be checked at every point of
 * a sphere rather than argued about: every point has at least one chart, and no
 * chart is ever stretched more than about 1.7 to 1 where it is used.
 *
 * `dir` is a unit direction in the body's own frame; the weights come back in
 * axis order and are normalised in length, so the independent noise the charts
 * carry adds to one variance rather than to one mean.
 */
export function surfaceChartWeights(dir: readonly [number, number, number]): [number, number, number] {
  const raw = dir.map((c) => Math.max(Math.abs(c) - SYNTH_CHART_CUT, 0) ** 2);
  const norm = Math.hypot(raw[0], raw[1], raw[2]);
  return (norm > 0 ? raw.map((w) => w / norm) : [0, 0, 0]) as [number, number, number];
}

/**
 * The field's tiling lattice, as the shader lays it: the plane of one rung's
 * uv is skewed into a triangular lattice with one tile between vertices, and
 * every vertex hashes to its own copy of the field. Column-major, as GLSL reads
 * a mat2: (1, 0) then (−1/√3, 2/√3).
 */
export const SYNTH_TRI = [1, 0, -0.57735027, 1.15470054] as const;

/**
 * How much of a barycentric weight is cut before it is sharpened. A vertex's
 * copy of the field leaves the blend at exactly zero, on a line, rather than by
 * falling under a threshold — so the shader may skip that copy's read where its
 * weight is zero, and the skip draws nothing the blend was not already drawing
 * nothing of. At a tenth about half of a cell reads all three copies, a corner
 * around each vertex reads one, and the rest reads two.
 */
export const SYNTH_HEX_CUT = 0.1;

/**
 * The three lattice vertices a point of one rung's uv plane reads the field
 * through, and the weight of each: the CPU twin of `synthTile` in the GLSL
 * below, so the two properties the blend rests on can be walked rather than
 * argued — every point has a weight, and nothing jumps at a triangle's edge.
 *
 * The weights are cut, cubed and normalised in LENGTH: the three copies are
 * independent readings of one random field, so it is their variance that has
 * to add to one.
 */
export function surfaceHexWeights(u: number, v: number): {
  vertices: [[number, number], [number, number], [number, number]];
  weights: [number, number, number];
} {
  const px = SYNTH_TRI[0] * u + SYNTH_TRI[2] * v;
  const py = SYNTH_TRI[1] * u + SYNTH_TRI[3] * v;
  const bx = Math.floor(px);
  const by = Math.floor(py);
  const fx = px - bx;
  const fy = py - by;
  const upper = fx + fy >= 1;
  const vertices: [[number, number], [number, number], [number, number]] = upper
    ? [[bx + 1, by + 1], [bx + 1, by], [bx, by + 1]]
    : [[bx, by], [bx + 1, by], [bx, by + 1]];
  const raw = upper ? [fx + fy - 1, 1 - fy, 1 - fx] : [1 - fx - fy, fx, fy];
  const cut = raw.map((w) => Math.max(w - SYNTH_HEX_CUT, 0) ** 3);
  const n = Math.hypot(cut[0], cut[1], cut[2]);
  return { vertices, weights: cut.map((w) => (n > 0 ? w / n : 0)) as [number, number, number] };
}

/**
 * What one lattice vertex does to the field it reads: the CPU twin of
 * `synthVertexShift` in the GLSL below, bit for bit — the same two rounds of
 * pcg2d over the vertex as a 32-bit unsigned pair — so the hash can be tested
 * for being a hash (uniform, and uncorrelated between neighbouring vertices)
 * instead of only for being present in the text.
 */
export function surfaceHexVertex(vx: number, vy: number, salt: number): {
  shift: [number, number];
  flipX: boolean;
  flipY: boolean;
  swap: boolean;
} {
  let x = (vx + Math.imul(salt, 0x9e3779b9)) >>> 0;
  let y = (vy + Math.imul(salt, 0x85ebca6b)) >>> 0;
  x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
  y = (Math.imul(y, 1664525) + 1013904223) >>> 0;
  x = (x + Math.imul(y, 1664525)) >>> 0;
  y = (y + Math.imul(x, 1664525)) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  y = (y ^ (y >>> 16)) >>> 0;
  x = (x + Math.imul(y, 1664525)) >>> 0;
  y = (y + Math.imul(x, 1664525)) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  y = (y ^ (y >>> 16)) >>> 0;
  return {
    shift: [(x >>> 3) / 536870912, (y >>> 3) / 536870912],
    swap: (x & 1) === 1,
    flipY: (x & 2) === 2,
    flipX: (x & 4) === 4,
  };
}

/**
 * How many rungs of the field a fragment reads at once.
 *
 * The field is drawn as a stack: every rung from the coarsest the body draws
 * up to the one the pixel wants. A single rung chosen per pixel is chosen by
 * the pixel's footprint on the ground, and that footprint grows as the ground
 * tilts away from the camera — so the same ground asked for a coarser rung
 * near the limb than at the disc centre, and wore a different set of craters
 * there. Its craters were attached to the view. With the rungs below the
 * wanted one always drawn, the view decides how fine the field gets and never
 * which craters are there.
 *
 * The coarse end is the body's own rung 0 — the scale at which the map's
 * texels ran out, so everything coarser is the map's — for as long as the
 * wanted rung stays under this depth, which cruise does: the flight floor
 * wants about rung 5. A camera standing on the ground wants up to rung 12,
 * and there the stack slides, letting go of a rung this many below the
 * wanted one; a crater that far below the pixel's own is hundreds of times
 * wider than the finest drawn, so its going is a slow change in the shading
 * of a whole slope rather than a crater that leaves. Each rung in the stack
 * is a full set of reads, which is why there is a depth at all.
 */
export const SYNTH_STACK_DEPTH = 7;

/**
 * How much of its contrast each rung below the finest keeps, per rung.
 *
 * The finest rung a pixel resolves carries the field at its own contrast;
 * every rung below it is tapered by this per rung of distance. Equal weights
 * would spread the field's contrast over the whole stack and leave the small
 * craters — the ones a pilot reads as the ground's definition — at half of
 * what one rung drew them at. And a crater's depth-to-width falls with its
 * size, so the big basins under the small craters are the gentler ones.
 * Continuous in the wanted rung: the taper is taken from the fraction too,
 * so a rung eases down as the next one eases in.
 */
export const SYNTH_STACK_TAPER = 0.6;

/** The gain that returns the finest rung to unit contrast once the stack is
 *  deep: the weights are normalised in length so the field's variance is
 *  fixed, and the tapered stack's length converges to this. */
export const SYNTH_STACK_GAIN = 1 / Math.sqrt(1 - SYNTH_STACK_TAPER * SYNTH_STACK_TAPER);

/** The rungs a fragment's stack reads and their weights, as the shader
 *  builds them: the fraction of the wanted rung at the rung above it, what
 *  is left of a rung sliding out at the bottom, the taper below the finest;
 *  normalised in length and lifted by the gain. */
export function surfaceStackWeights(wanted: number): { rung: number; weight: number }[] {
  const coarse = wanted - (SYNTH_STACK_DEPTH - 1);
  const lo = Math.max(Math.floor(coarse), 0);
  const raw: { rung: number; weight: number }[] = [];
  for (let k = 0; k <= SYNTH_STACK_DEPTH; k++) {
    const rung = lo + k;
    if (rung > wanted + 1) break;
    let weight = Math.min(1, Math.max(0, Math.min(wanted - rung + 1, rung - coarse + 1)));
    if (weight <= 0) continue;
    weight *= SYNTH_STACK_TAPER ** Math.max(wanted - rung, 0);
    raw.push({ rung, weight });
  }
  const norm = Math.hypot(...raw.map((r) => r.weight));
  return raw.map((r) => ({ rung: r.rung, weight: (r.weight / norm) * SYNTH_STACK_GAIN }));
}

const SURFACE_DETAIL_GLSL = /* glsl */ `
uniform sampler2D uSynthDetail;
uniform float uSynthGrain;
uniform float uSynthRelief;
uniform float uSynthBumpFade;
uniform float uSynthEnvelope;
uniform float uSynthMid;
uniform float uSynthCraterShare;
uniform vec2 uSynthSeed;
// How much of this term a map's density asks for: the same band the smooth
// magnification filter hands over on, read across the map's COARSEST axis
// rather than its busiest.
//
// The difference is the poles. An equirect map's texel columns converge to a
// point there, so its longitude axis reports texels crowded many to a pixel
// over the exact cap the map has least to say about — and a fade that takes the
// busiest axis therefore switches this term off over that cap and leaves a blob
// of putty in the middle of ground. What limits a map is its coarsest axis; the
// two readings agree everywhere a map is not distorted.
float synthTexelWeight(vec2 uv, vec2 texels) {
  float perPixel = min(fwidth(uv.x) * texels.x, fwidth(uv.y) * texels.y);
  return 1.0 - smoothstep(${SMOOTH_TEXEL_FADE[0].toFixed(6)}, ${SMOOTH_TEXEL_FADE[1].toFixed(6)}, perPixel);
}
// The field is one tile, and a plain wrap lays that tile every few hundred
// pixels at every zoom: the same handful of big craters again and again, which
// under grazing light reads as a lattice rather than as ground. So the tile is
// never laid the same way twice. Each rung's uv plane is cut into a triangular
// lattice with one tile between vertices; every vertex hashes to its own copy
// of the field — shifted, and flipped or transposed, so that no two cells
// carry the same motif — and a fragment reads the field through the three
// vertices of the triangle it sits in, blended by where in that triangle it
// sits. A copy is a shifted, flipped or transposed tile, so it tiles as the
// field does, and its stored gradient comes back through the same flip.
//
// Hashed on the vertex as an INTEGER: the lattice reaches past six thousand at
// the top rung, where hashing the float coordinate would be hashing rounding
// noise. The mixing wraps at 32 bits, which is what highp says here.
const mat2 SYNTH_TRI = mat2(${SYNTH_TRI[0].toFixed(1)}, ${SYNTH_TRI[1].toFixed(1)}, ${SYNTH_TRI[2].toFixed(8)}, ${SYNTH_TRI[3].toFixed(8)});
// A vertex's copy of the field: a shift in xy, and in z three bits — flip x,
// flip y, transpose — as a float the caller decodes. Two rounds of the mix:
// one leaves neighbouring vertices almost the same shift, which is the lattice
// back again with a wobble, and the twin's test holds the neighbour
// correlation under two per cent.
vec3 synthVertexShift(vec2 vertex, uint salt) {
  highp uvec2 v = uvec2(ivec2(vertex));
  v += uvec2(salt * 0x9E3779B9u, salt * 0x85EBCA6Bu);
  v = v * 1664525u + 1013904223u;
  v.x += v.y * 1664525u;
  v.y += v.x * 1664525u;
  v ^= v >> 16u;
  v.x += v.y * 1664525u;
  v.y += v.x * 1664525u;
  v ^= v >> 16u;
  return vec3(vec2(v >> 3u) * (1.0 / 536870912.0), float(v.x & 7u));
}
// One copy's reading of the field at \`uv\`, through vertex \`vertex\`: the
// height around the field's own mean in x, the gradient of that height with
// respect to uv, per tile width, in yz — decoded from the bytes here, so that
// everything the tile adds up is in one unit. The copy is read at A·uv + shift,
// with A a flip or transpose, and its stored gradient — which is with respect
// to the copy's own coordinates — comes back through A transposed.
vec3 synthCopy(vec2 uv, vec2 dx, vec2 dy, vec2 vertex, uint salt) {
  vec3 hv = synthVertexShift(vertex, salt);
  int bits = int(hv.z);
  vec2 sgn = vec2((bits & 4) != 0 ? -1.0 : 1.0, (bits & 2) != 0 ? -1.0 : 1.0);
  bool swap = (bits & 1) != 0;
  vec2 q = swap ? uv.yx : uv;
  vec2 qx = swap ? dx.yx : dx;
  vec2 qy = swap ? dy.yx : dy;
  vec4 s = textureGrad(uSynthDetail, q * sgn + hv.xy, qx * sgn, qy * sgn);
  vec2 g = (s.gb * 2.0 - 1.0) * ${SURFACE_DETAIL_GRADIENT_SCALE.toFixed(1)} * sgn;
  // Against the field's OWN mean, per copy, before any weight: the weights add
  // to one in length rather than in sum, so a mean left in would come out
  // scaled by their sum, which is not one.
  return vec3(s.r - uSynthMid, swap ? g.yx : g);
}
// One rung's reading of the field at \`uv\`: height around the mean in x, the
// gradient of that height with respect to uv, per tile width, in yz.
//
// Three copies, one through each vertex of the triangle \`uv\` sits in, blended
// with that triangle's barycentric weights — cut, so a copy leaves the blend
// at exactly zero and its read can be skipped there; cubed, so most of a cell
// reads one copy at full contrast and the blend is confined to a band along
// each edge; and normalised in LENGTH, the rule the charts blend by: the copies
// are independent readings of one random field, so it is their variance that
// has to add to one. A weighted mean would draw every band fainter than the
// ground on either side of it.
//
// The gradient is the gradient of the blended HEIGHT, weights included. Weights
// that add to one in length do not add to one in sum — the sum runs from one at
// a vertex to 1.7 at a triangle's centre — so where a copy is locally high or
// low, a crater floor say, the changing weights alone tilt the blend, by about
// as much as the ground's own grain does. Left out, that tilt is a soft facet
// locked to every cell of the lattice, which is the artefact this whole
// construction exists to remove. The weights are a fixed function of uv, so
// their derivative is the same few lines of arithmetic as the weights. Exact
// everywhere but on a cell's diagonal, where the raw weights bend: the tilt
// steps there by a tenth of a byte of the stored gradient at most.
vec3 synthTile(vec2 uv, vec2 dx, vec2 dy, uint salt) {
  vec2 p = SYNTH_TRI * uv;
  vec2 base = floor(p);
  vec2 f = p - base;
  float upper = step(1.0, f.x + f.y);
  vec2 v1 = base + vec2(upper);
  vec2 v2 = base + vec2(1.0, 0.0);
  vec2 v3 = base + vec2(0.0, 1.0);
  vec3 w = mix(vec3(1.0 - f.x - f.y, f.x, f.y), vec3(f.x + f.y - 1.0, 1.0 - f.y, 1.0 - f.x), upper);
  // The raw weights are linear in p, so their derivative is a constant per
  // triangle.
  vec3 dwx = mix(vec3(-1.0, 1.0, 0.0), vec3(1.0, 0.0, -1.0), upper);
  vec3 dwy = mix(vec3(-1.0, 0.0, 1.0), vec3(1.0, -1.0, 0.0), upper);
  vec3 wc = max(w - ${SYNTH_HEX_CUT.toFixed(2)}, 0.0);
  vec3 ws = wc * wc * wc;
  vec3 dsx = 3.0 * wc * wc * dwx;
  vec3 dsy = 3.0 * wc * wc * dwy;
  float len = max(length(ws), 1e-20);
  vec3 n = ws / len;
  vec3 dnx = (dsx - n * dot(n, dsx)) / len;
  vec3 dny = (dsy - n * dot(n, dsy)) / len;
  vec3 c1 = vec3(0.0);
  vec3 c2 = vec3(0.0);
  vec3 c3 = vec3(0.0);
  if (wc.x > 0.0) c1 = synthCopy(uv, dx, dy, v1, salt);
  if (wc.y > 0.0) c2 = synthCopy(uv, dx, dy, v2, salt);
  if (wc.z > 0.0) c3 = synthCopy(uv, dx, dy, v3, salt);
  vec3 h = vec3(c1.x, c2.x, c3.x);
  // The weights' own slope, in p, then back into uv through the lattice skew.
  vec2 dwp = vec2(dot(h, dnx), dot(h, dny));
  vec2 dwuv = vec2(dwp.x, ${SYNTH_TRI[2].toFixed(8)} * dwp.x + ${SYNTH_TRI[3].toFixed(8)} * dwp.y);
  return n.x * c1 + n.y * c2 + n.z * c3 + vec3(0.0, dwuv);
}
// One flat chart's reading of the field: its height here, around zero, in x,
// and the slope of that height across the SCREEN in yz. \`c\` is the chart's own
// two coordinates and \`cx\`/\`cy\` their screen derivatives; \`wanted\` is the
// fragment's rung, fraction included, not the chart's.
//
// One rung for every chart on a fragment, chosen from the surface's own arc per
// pixel. Per chart it would be chosen from each chart's own compressed
// coordinates, and two charts drawing the same fragment would then disagree
// about how big a crater is by up to two thirds of a rung — a patch of ground
// carrying two crater fields at different sizes, which is what a seam between
// them looked like.
//
// The reading is a STACK of rungs: every rung from the coarsest the body
// draws up to the wanted one, the finest fading in with the fraction. The
// pixel's footprint on the ground chooses the wanted rung, and that footprint
// grows as the ground tilts away from the camera, so one rung chosen per
// pixel put a different set of craters on the same ground near the limb than
// at the disc centre — craters attached to the view. With the stack below
// always drawn, the view decides how fine the field gets and never which
// craters are there; a rung fades in as its craters become resolvable, the
// way a photograph gains detail as it is approached.
//
// The coarse end is the body's own rung 0 until the wanted rung is
// SYNTH_STACK_DEPTH above it (cruise never is), then slides; a rung leaving
// at the bottom fades out over one rung of magnification, as one arriving at
// the top fades in, so nothing steps. The finest rung carries the field at
// its own contrast and each rung below it is tapered — the small craters
// are what reads as the ground's definition, and a crater's depth-to-width
// falls with its size. Weights are normalised in length, the rule every
// blend in this term follows (the rungs are independent readings of one
// random field, so it is their variance that has to add up), and lifted by
// the gain the tapered stack's length converges to, so the finest rung
// comes out at one.
//
// The rung cancels out of the slope: the stored gradient is per tile WIDTH, and
// a tile's width on the ground shrinks with the rung by exactly the factor the
// gradient grows, which is what lets one small map stand for every zoom at one
// steepness. So the rungs are mixed in their own units and the chart's
// unscaled derivative is what turns them into a slope.
vec3 synthChart(vec2 c, vec2 cx, vec2 cy, vec2 seed, float wanted) {
  // The rung below which the stack lets go, continuous in the wanted rung.
  float coarse = wanted - ${(SYNTH_STACK_DEPTH - 1).toFixed(1)};
  float lo = max(floor(coarse), 0.0);
  vec3 f = vec3(0.0);
  float norm = 0.0;
  for (int k = 0; k <= ${SYNTH_STACK_DEPTH}; k++) {
    float rung = lo + float(k);
    if (rung > wanted + 1.0) break;
    // One inside the stack; the fraction of the wanted rung at the rung above
    // it; what is left of a rung sliding out at the bottom.
    float w = clamp(min(wanted - rung + 1.0, rung - coarse + 1.0), 0.0, 1.0);
    if (w <= 0.0) continue;
    w *= pow(${SYNTH_STACK_TAPER.toFixed(2)}, max(wanted - rung, 0.0));
    // Built with the arithmetic every rung uses and salted by the ABSOLUTE
    // rung, so a rung reads the same ground bit for bit whatever stack it is
    // in. (Forming a finer uv as uv * 2 - seed instead differs from
    // c * 2^(r+1) + seed by up to a quarter texel at rung 12 — a sub-texel
    // seam of its own.)
    float perUnit = exp2(rung);
    f += w * synthTile(c * perUnit + seed, cx * perUnit, cy * perUnit, uint(rung));
    norm += w * w;
  }
  f *= ${SYNTH_STACK_GAIN.toFixed(6)} / sqrt(max(norm, 1e-12));
  return vec3(f.x, dot(f.yz, cx), dot(f.yz, cy));
}
`;

const SURFACE_DETAIL_BODY = /* glsl */ `
#ifdef USE_MAP
if (GROUND_ON(uSynthEnvelope > 0.0)) {
  // How magnified the map on THIS material is, on the one band the smooth
  // filter hands over on. Per material and per fragment, which is what makes it
  // right on a streamed body: a resident 16K tile reports its own size against
  // its own UV and switches the term off over its own patch, while the coarse
  // globe one pixel away keeps it. A body-wide scalar would draw that boundary
  // as a rectangle.
  float synthW = synthTexelWeight(vMapUv, vec2(textureSize(map, 0))) * uSynthEnvelope;
  // How much relief this fragment may draw. Zero wherever a MEASURED surface is
  // bound, whatever the magnification. Where what is bound is itself invented —
  // a painted crater bump — it fades in as that bump's OWN texels stretch past
  // a pixel, on the same band and measured the same way: past there the painted
  // craters are interpolation, and finer invented craters in their place assert
  // nothing the coarse ones did not.
  float synthRelief = uSynthRelief;
  // A body that wears no craters keeps only a fraction of the relief, so what
  // the finer field leaves is texture rather than pits. The albedo grain is
  // untouched by this: it is the light the surface answers with that changes,
  // not whether it has a surface.
  synthRelief *= mix(${SYNTH_RELIEF_FLOOR.toFixed(2)}, 1.0, uSynthCraterShare);
  #ifdef USE_BUMPMAP
  synthRelief *= mix(1.0,
      synthTexelWeight(vBumpMapUv, vec2(textureSize(bumpMap, 0))), uSynthBumpFade);
  #endif
  // The field's domain is the BODY's own frame, never the material's UV: a
  // streamed sector's UV runs 0..1 across its own tile, so a field in UV space
  // would put a different pattern on every tile and draw the tile grid.
  vec3 synthDir = normalize(vObjPos);
  // Every derivative is taken HERE, under a branch that is uniform across the
  // draw: a derivative under a per-fragment condition is undefined, and the
  // fades below are exactly such conditions.
  vec3 synthDx = dFdx(synthDir);
  vec3 synthDy = dFdy(synthDir);
  vec3 synthVx = dFdx(-vViewPosition);
  vec3 synthVy = dFdy(-vViewPosition);
  if (synthW > 0.0) {
    // Three flat charts, one per axis of the body's own frame, each reading the
    // tiling field straight off the two coordinates across its own face of the
    // sphere, blended where they meet.
    //
    // Flat charts and not a longitude/latitude one, which would be two fetches
    // cheaper: a cylinder pinches to a point at each pole, where a cell is a
    // sliver and its longitudinal slope is however many times steeper that
    // pinch makes it, and a body posed with its cap toward the camera draws a
    // pinwheel of radial streaks across the whole frame. A flat chart has no
    // such point anywhere on the sphere. Its own distortion is a stretch away
    // from its axis, worst at the corner where three charts meet and bounded
    // there at 1.7 to 1 — where it reads as ground drawn slightly coarser, and
    // as nothing else, because the field keeps its own depth-to-width under a
    // stretch that carries craters and their slopes together.
    //
    // The weights are squared so a chart arrives with zero slope rather than
    // with an edge, and normalised in LENGTH rather than in sum: the charts
    // carry independent noise, so it is their VARIANCE that has to add to one.
    // A weighted mean would flatten the field to 58% of itself along every
    // diagonal, which is a fade in the ground with no cause on the ground.
    vec3 synthChartW = max(abs(synthDir) - ${SYNTH_CHART_CUT.toFixed(4)}, 0.0);
    synthChartW *= synthChartW;
    // How much arc this fragment's pixel covers, off the surface direction
    // itself rather than off any one chart's compressed copy of it: one rung
    // for every chart drawing this fragment, so they cannot disagree about how
    // big a crater is. Along the pixel's SHORTER side: on ground turned away
    // from the camera a pixel covers a long strip, and a rung chosen by the
    // long side let the fine craters go wherever the ground tilted, which
    // read as craters that come and go with the viewing angle. The reads
    // carry the true derivatives, so the field is filtered along the long
    // side the way any texture is, and the fine craters compress instead.
    float synthPerPx = max(min(length(synthDx), length(synthDy)), 1e-12);
    float synthWanted = log2(1.0 / (${SURFACE_DETAIL_TILE_PX.toFixed(1)} * synthPerPx));
    // A body that wears no craters draws the whole field finer, so what it
    // wears is ground texture rather than impacts. Added to the rung the
    // fragment WANTS, before it is rounded to one, so a share between the two
    // rides the ordinary crossfade instead of stepping.
    synthWanted += (1.0 - uSynthCraterShare) * ${SYNTH_SMOOTH_RUNGS.toFixed(1)};
    // Ceilinged, because the rung multiplies the coordinates and a float runs
    // out of mantissa: at rung 12 one unit in the last place of the uv is a
    // quarter of a texel of the map, at 14 it is a whole texel, and past that
    // the field is drawn in steps. The screen derivatives the rung is chosen
    // from run out sooner still — they are differences of a unit vector, a
    // few ulps apart per pixel by rung 12 — so the ladder must stop about
    // here whatever the uv could still name. Nothing in cruise gets near —
    // the flight floor is around rung 5 — but a camera standing ON a surface
    // can, and past the ceiling the finest rung simply magnifies, which is
    // ground drawn coarser rather than ground drawn wrong. Ceilinged at
    // twelve, so the top of the stack is rung 12 alone and nothing reaches
    // for a thirteenth; floored at rung 0, where the term is already fading
    // in at the map's own texel scale.
    synthWanted = clamp(synthWanted, 0.0, 12.0);
    // Each chart reads its own patch of the one field: the offsets are
    // arbitrary and only have to differ, or the seam between two charts would
    // be two copies of the same ground sliding across each other.
    //
    // Which side of its own plane a chart is on is part of that. A chart's two
    // coordinates are the same pair on both sides — the X chart reads (y, z)
    // whether x is +0.8 or −0.8 — so without this a body wears the same ground
    // on both faces of every axis, mirrored through the plane between them.
    // Never visible in one frame, and wrong all the same. The offset can jump
    // at the sign flip because the flip happens where the axis is zero, which
    // is where that chart's weight has been zero for the whole half of the
    // sphere around it.
    vec3 synthChartFlip = step(0.0, synthDir);
    vec3 synthChartX = vec3(0.0);
    vec3 synthChartY = vec3(0.0);
    vec3 synthChartZ = vec3(0.0);
    if (synthChartW.x > 0.0) {
      synthChartX = synthChart(vec2(synthDir.y, synthDir.z),
          vec2(synthDx.y, synthDx.z), vec2(synthDy.y, synthDy.z),
          uSynthSeed + synthChartFlip.x * vec2(0.5, 0.25), synthWanted);
    }
    if (synthChartW.y > 0.0) {
      synthChartY = synthChart(vec2(synthDir.z, synthDir.x),
          vec2(synthDx.z, synthDx.x), vec2(synthDy.z, synthDy.x),
          uSynthSeed + vec2(0.37, 0.11) + synthChartFlip.y * vec2(0.5, 0.25),
          synthWanted);
    }
    if (synthChartW.z > 0.0) {
      synthChartZ = synthChart(vec2(synthDir.x, synthDir.y),
          vec2(synthDx.x, synthDx.y), vec2(synthDy.x, synthDy.y),
          uSynthSeed + vec2(0.71, 0.53) + synthChartFlip.z * vec2(0.5, 0.25),
          synthWanted);
    }
    // The shares are normalised in LENGTH rather than in sum: the charts carry
    // independent noise, so it is their VARIANCE that has to add to one. A
    // weighted mean would flatten the field along every diagonal, which is a
    // fade in the ground with no cause on the ground.
    vec3 synthShare = synthChartW / max(length(synthChartW), 1e-20);
    // Height and slope take the same shares: a crater has to keep its walls
    // with its depth, or the shading would light a hole the surface has lost.
    vec3 synthField = synthShare.x * synthChartX + synthShare.y * synthChartY
        + synthShare.z * synthChartZ;
    // Grain: the field's own height as a small multiplicative variation of the
    // albedo, luminance only and a few per cent of it. It puts a texture back
    // on a surface that has run out of map; it must never restate the body's
    // colour, which is what the photograph or the archetype palette is for.
    diffuseColor.rgb *= 1.0 + uSynthGrain * synthField.x * 2.0 * synthW;
    if (synthRelief > 0.0) {
      // The body's own rendered radius, off the varying that already carries
      // this fragment's offset from the body's centre — no uniform to keep in
      // step with a mesh scale.
      float synthR = length(vAirFrag);
      vec3 synthNrm = normalize(normal);
      vec3 synthR1 = cross(synthVy, synthNrm);
      vec3 synthR2 = cross(synthNrm, synthVx);
      float synthDet = dot(synthVx, synthR1);
      if (abs(synthDet) > 1e-30) {
        // Height per screen pixel in world units, turned into a surface
        // gradient by the screen basis — the same construction the cloud
        // deck's relief takes, and for the same reason: it needs no tangent
        // frame, so it works on a sector mesh and a globe alike.
        vec3 synthSurfGrad = (synthField.y * synthR1 + synthField.z * synthR2)
            * (synthRelief * synthR / synthDet);
        normal = normalize(synthNrm - synthSurfGrad * synthW);
      }
    }
  }
}
#endif`;

/** The GPU-efficiency switches this shader carries, declared only where they
 *  exist: a production build compiles one path per item and has no uniform to
 *  read (app/perfSwitches.ts). */
const PERF_SWITCH_DECLS = /* glsl */ `uniform float uPerfCloudTaps;
uniform float uPerfCloudClear;
uniform float uPerfGlintGate;
uniform float uPerfCloudNoiseFrame;
uniform float uProbeCloudSmooth;
uniform float uProbeCloudDetail;
uniform float uProbeCloudRelief;
uniform float uProbeCloudAir;`;

/** The glint's tuning uniforms (devGlintUniforms), development builds only. */
const DEV_TUNING_DECLS = /* glsl */ `uniform float uGlintCap;
uniform float uGlintKeep;
uniform float uBeamKnee;
uniform float uBeamCap;
uniform vec3 uSeaColour;
uniform float uSeaSky;`;

/**
 * The cloud deck's cost probes (app/perfSwitches.ts, `cloud-probe-*`): each
 * one takes a whole term off the deck so a device can price it. None of them
 * is a change to the picture, so none of them has a cheap reading to keep — a
 * production build has neither the uniform nor the condition, and the text
 * is then exactly what it was before the probes existed. Each guard is the
 * condition its term keeps running under: true wherever the probe is not
 * armed, and always true on a surface that is not the deck, so a probe never
 * reaches the ground the deck stands over. Plain constants rather than a
 * helper called with the name, so the folded bundle carries neither the name
 * nor the call.
 */
const SMOOTH_PROBE_GUARD = import.meta.env.DEV ? 'uProbeCloudSmooth < 0.5 && ' : '';
const DETAIL_PROBE_GUARD = import.meta.env.DEV ? 'uProbeCloudDetail > 0.5 ? 0.0 : ' : '';
const RELIEF_PROBE_OPEN = import.meta.env.DEV ? '\tif (uProbeCloudRelief < 0.5 || DECK_OFF) {\n' : '';
const RELIEF_PROBE_CLOSE = import.meta.env.DEV ? '\t} // cloud relief probe\n' : '';
const AIR_PROBE_GUARD = import.meta.env.DEV ? ' && (uProbeCloudAir < 0.5 || DECK_OFF)' : '';

/**
 * The deck detail's frame before it was the sheet's own: the world's axes,
 * where the detail stood still in the sky while the cloud turned under it.
 * Development builds only, behind `cloud-noise-frame` (app/perfSwitches.ts) —
 * the control arm, the picture as it was — and a production build has neither
 * the uniform nor these lines. Everything it swaps is a value the block above
 * has already set, and the two derivatives it takes are inside a branch on a
 * uniform, which the whole draw takes the same way.
 */
const NOISE_FRAME_OFF_ARM = import.meta.env.DEV
  ? '  if (uPerfCloudNoiseFrame < 0.5) {\n'
    + '    dir = normalize(vAirFrag);\n'
    + '    ddx = dFdx(dir);\n'
    + '    ddy = dFdy(dir);\n'
    + '  }\n'
  : '';

/** The switch a dead cloud tap is removed behind, as the condition that still
 *  takes the tap. Off, the fetch happens exactly where it happened before the
 *  change; a production build has neither the switch nor the second reading. */
const cloudTapKept = (stillNeeded: string): string =>
  (import.meta.env.DEV ? `uPerfCloudTaps < 0.5 || ${stillNeeded}` : stillNeeded);

/**
 * The clear-sky early-out: a deck fragment with no cloud on it, written out as
 * nothing and left.
 *
 * Placed at the END of the injected normal block, after the close-range
 * detail's own derivatives have been taken, so every derivative the deck's
 * path takes is above it, in flow that is uniform across the draw. What it
 * skips is everything downstream: three's whole physical lighting, the night
 * floor and the sky's ambient, the moonlight pair, the eclipse trace, the city
 * glow through the deck and the six aerial-perspective lookups.
 *
 * Past the return the lanes that carried on are in divergent flow, so nothing
 * on the deck's path below it may take a derivative or an implicit-LOD fetch.
 * That holds on three facts, each load-bearing: three's own chunks past this
 * point fetch only maps the deck does not bind (emissive, ambient occlusion,
 * light and environment maps) and shadow maps the renderer never enables; the
 * surface body's own derivatives below it, the sea's lookup into the deck map,
 * sit under `uWaterGloss > 0.0`, which is zero on the deck; and the atmosphere
 * tables are unmipped LinearFilter textures, so their lookups have no level
 * to mispick. Binding one of those maps on the deck, or enabling shadow maps,
 * is a change to this reasoning. cloudDeck.test.ts pins the derivative order.
 *
 * `vec4(0.0)` and not a discard, and the two are not interchangeable here:
 * this is the ONE material in the app whose archetype is 'cloud', and it draws
 * with `depthWrite: false` into a plain source-alpha blend, so a zero alpha
 * leaves the destination bit for bit. A cloud-archetype surface that wrote
 * depth, or one on premultiplied alpha, would need this reasoning done again.
 */
const CLOUD_CLEAR_RETURN = import.meta.env.DEV
  ? 'if (uPerfCloudClear > 0.5 && DECK_ON && cloudAlpha == 0.0) { gl_FragColor = vec4(0.0); return; }'
  : 'if (DECK_ON && cloudAlpha == 0.0) { gl_FragColor = vec4(0.0); return; }';

/**
 * three's own <map_fragment>, with the deck's fetch put through the smooth
 * magnification filter. The ordinary bilinear tap happens for every surface;
 * the four extra ones sit behind a weight that is zero on all of them.
 *
 * At full smooth weight the ordinary tap is not an endpoint of anything — the
 * mix returns the B-spline — and it is taken anyway, in flow that is uniform
 * across the draw, as three's chunk always took it. Two attempts to skip it
 * there are on record, and both are closed. An implicit-LOD fetch under the
 * weight was measured as the same picture on two engines, but it puts the
 * fetch under a per-fragment condition, where the language leaves the mip
 * undefined for a quad the condition splits, and the tap's weight there is
 * small rather than zero: a bound, not an identity. A fetch handed explicit
 * gradients under the same condition has a defined mip and a DIFFERENT one:
 * against the implicit tap the pixel gate read 25 000 pixels at the
 * terminator and 38 000 across the far disc, up to 24 levels, on Chromium —
 * the two LOD paths do not agree. So this chunk is three's own text plus the
 * filter, exactly as it was, and the deck's picture rests on nothing but the
 * specification.
 */
const SURFACE_MAP_FRAGMENT = /* glsl */ `
#ifdef USE_MAP
	vec4 sampledDiffuseColor = texture2D( map, vMapUv );
	if ( ${SMOOTH_PROBE_GUARD}DECK_ON ) {
		vec2 mapTexels = vec2( textureSize( map, 0 ) );
		float smoothW = smoothTexelWeight( vMapUv, mapTexels );
		if ( smoothW > 0.0 ) {
			sampledDiffuseColor = mix( sampledDiffuseColor,
				textureBSpline( map, vMapUv, mapTexels ), smoothW );
		}
	}
	#ifdef DECODE_VIDEO_TEXTURE
		sampledDiffuseColor = sRGBTransferEOTF( sampledDiffuseColor );
	#endif
	diffuseColor *= sampledDiffuseColor;
	if ( DECK_OFF ) diffuseColor.rgb = albedoContrast( diffuseColor.rgb );
#endif
`;

/**
 * A ground compiled with the cloud field (CLOUD_FIELD without CLOUD_DECK: the
 * ground reads the field in its shadow lookup) knows at compile time that it
 * is not the deck, so DECK_ON is a constant false there and the deck's own
 * block — its detail tap on `uCloudDetail` above all, an active sampler on
 * every ground today only because DECK_ON is a uniform test — is compiled out.
 * One sampler unit back on the program that spends the most. Whole lines inside
 * their own conditional, opening with no blank line of their own, so a program
 * without CLOUD_FIELD is the text it was to the character.
 */
const GROUND_FIELD_ARCHETYPE_OPEN = '#ifdef CLOUD_FIELD\n#define DECK_ON false\n#define DECK_OFF true\n#else\n';
const GROUND_FIELD_ARCHETYPE_CLOSE = '#endif\n';

/**
 * The cloud deck's archetype, decided when its program compiles.
 *
 * Every surface takes one injected text, and a body's class is a set of
 * uniforms, so that three's program cache holds one program per map
 * combination rather than one per body. The deck is the one surface that
 * already has a program to itself — it is transparent, and opaque-or-not is
 * part of three's cache key — so on the deck alone the archetype can be a
 * define at no cost in programs: the compiler then drops every branch the
 * deck never takes (the sea's gloss, the close-range synthesis, ring shadow,
 * icy rim, planetshine, limb darkening) instead of carrying them past a
 * uniform. On an Apple GPU that was measured as eight percent of the deck's
 * draw. The three macros are the only spelling the injected text uses, so a
 * program without the define reads exactly as it did: DECK_ON is the deck's
 * own condition, DECK_OFF its negation, and GROUND_ON(x) is a condition the
 * deck can never satisfy.
 */
const SURFACE_ARCHETYPE_MACROS = /* glsl */ `
#ifdef CLOUD_DECK
#define DECK_ON true
#define DECK_OFF false
#define GROUND_ON(x) false
#else
${GROUND_FIELD_ARCHETYPE_OPEN}#define DECK_ON (uCloudDeck > 0.0)
#define DECK_OFF (uCloudDeck == 0.0)
${GROUND_FIELD_ARCHETYPE_CLOSE}#define GROUND_ON(x) (x)
#endif`;

/**
 * The Gaussian slope law as a microfacet lobe: Beckmann, alpha squared the
 * mean-square slope. Cox-Munk's sea is this lobe exactly, which is why the
 * body swaps it in for three's GGX — whose tail at three sigma of facet tilt
 * is eighty times heavier, and was the haze round the sheen — wherever the
 * wind map is on. The cosine is floored so a facet turned away is a lobe of
 * nothing rather than a division by nothing.
 */
const SEA_LOBE_GLSL = /* glsl */ `
// Unpolarised Fresnel reflectance of water at an incidence cosine, exact for
// its index (SEA_WATER_IOR): Schlick reads 15 to 24 % low between 50 and 60
// degrees, the band an orbital oblique view meets the sea at.
float seaFresnelExact(float cosI) {
  float g = sqrt(max(${(SEA_WATER_IOR * SEA_WATER_IOR - 1).toFixed(6)} + cosI * cosI, 0.0));
  float a = (g - cosI) / max(g + cosI, 1e-6);
  float b = (cosI * (g + cosI) - 1.0) / max(cosI * (g - cosI) + 1.0, 1e-6);
  return 0.5 * a * a * (1.0 + b * b);
}
float seaBeckmann(float alpha, float dotNH) {
  float cos2 = max(dotNH * dotNH, 1e-6);
  float alpha2 = alpha * alpha;
  return exp((cos2 - 1.0) / (cos2 * alpha2)) / (PI * alpha2 * cos2 * cos2);
}
// Beckmann's own Smith shadowing, Walter's rational fit of its G1 in
// a = 1 / (alpha tan theta), as the visibility term V = G1(l) G1(v) / (4 n.l n.v)
// that multiplies the lobe. three's correlated GGX Smith on this lobe read
// about a third too dark at a grazing Sun and eye, which is where the beam is.
float seaBeckmannG1(float cosTheta, float alpha) {
  float sinTheta = sqrt(max(1.0 - cosTheta * cosTheta, 0.0));
  float a = cosTheta / max(alpha * sinTheta, 1e-6);
  return a >= 1.6 ? 1.0 : (3.535 * a + 2.181 * a * a) / (1.0 + 2.276 * a + 2.577 * a * a);
}
float seaBeckmannVis(float alpha, float dotNL, float dotNV) {
  return seaBeckmannG1(dotNL, alpha) * seaBeckmannG1(dotNV, alpha) / max(4.0 * dotNL * dotNV, 1e-6);
}
`;

/**
 * Cloud shadows' declarations, compiled only with CLOUD_SHADOW (see the switch
 * beside `cloudShadowUniforms`). Every line of this and of the three blocks
 * below is a whole line inside its own conditional, so with the define off
 * the preprocessor leaves the text it was.
 *
 * Every chunk that opens with a directive — this one, the cloud light's and the
 * cloud field's declarations, and the body blocks that open with `#ifdef` —
 * opens with its own newline and ends with one, so it is a whole line wherever
 * it is spliced: the preprocessor only sees a directive at the start of a line,
 * and a neighbour that happens not to end with a newline would otherwise hide
 * `#ifdef` behind its last brace (aerialPerspective.test.ts scans for that).
 */
const CLOUD_SHADOW_DECLS = /* glsl */ `
#ifdef CLOUD_SHADOW
uniform float uCloudAbove;
uniform float uCloudHeightOverRadius;
${import.meta.env.DEV ? 'uniform float uCloudShadowDepth;\nuniform float uCloudShadowAir;\nuniform float uCloudShadowPenumbra;\nuniform float uCloudShadowGamma;\nuniform float uCloudShadowSkyFill;\n' : ''}#ifdef CLOUD_FIELD
uniform vec2 uCloudShadowTurn;
#endif
#endif
`;

/**
 * The cloud deck's 1.2 km field (world/cloudField), compiled only with
 * CLOUD_FIELD, which only the planetarium's deck (and the warm-up probe that
 * stands in for it) and Earth's ground beside its cloud shadow carry, and only
 * in a session that has the field (world/cloudFieldSlots). Every line is a
 * whole line inside
 * its conditional, so a program without the define is, after the
 * preprocessor, the program it was but for the blank line each chunk opens
 * with; a development build adds the field's diagnostics inside the same
 * conditionals (aerialPerspective.test.ts pins both texts and the fold).
 */
export const CLOUD_FIELD_DECLS = cloudFieldGlsl(SMOOTH_TEXEL_FADE);
export const CLOUD_FIELD_MIX = CLOUD_FIELD_MIX_GLSL(`vec3(${LUMINANCE_WEIGHTS.map((w) => w.toFixed(4)).join(', ')})`);

/** The cloud light's knobs, declared only in a development build and only in a
 *  program compiled with CLOUD_LIGHT; a production build reads constants. */
const CLOUD_LIGHT_DECLS = import.meta.env.DEV
  ? '\n#ifdef CLOUD_LIGHT\nuniform float uCloudLightWrap;\nuniform float uCloudLightSky;\n#endif\n'
  : '';

/**
 * A presentation grade on the albedo (world/surfaceLook.ts): a contrast gain
 * in log luminance about the body's own typical albedo, every channel scaled
 * by the one factor so the hue and the saturation stay the map's. The gain is
 * 1 for every body but the ones the look table names, and 1 is the map
 * EXACTLY — the early return, not a pow that rounds — and the branch is
 * uniform, so the ground pays nothing where it is off. x is the gain, y the
 * pivot luminance. Applied to the ground's albedo alone: the cloud deck shares
 * the globe's air block, and a grade meant for the ground would otherwise
 * read as a grade on the clouds too.
 */
const ALBEDO_CONTRAST_GLSL = /* glsl */ `
uniform vec2 uAlbedoContrast;
vec3 albedoContrast( vec3 albedo ) {
	if ( uAlbedoContrast.x == 1.0 ) return albedo;
	float luminance = max( dot( albedo, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-5 );
	return albedo * pow( luminance / uAlbedoContrast.y, uAlbedoContrast.x - 1.0 );
}
`;

const SURFACE_FRAGMENT_DECLS = /* glsl */ `
${SURFACE_ARCHETYPE_MACROS}
#if defined( USE_NORMALMAP_TANGENTSPACE ) && !defined( CLOUD_DECK )
varying vec3 vReliefPole;
${RELIEF_SPHERE_FRAME_GLSL}
#endif
uniform vec3 uNightColor;
uniform float uNightStrength;
uniform float uNightLift;
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
uniform float uNightExposure;
uniform float uAirDensity;
uniform float uAirBlend;
uniform float uSurfaceHaze;
uniform float uAirLookupRadius;
uniform float uWaterGloss;
uniform float uSeaMix;
uniform sampler2D uSeaWindMap;
uniform float uSeaWindOn;
uniform sampler2D uCloudShadowMap;
uniform float uCloudShadowSpin;
uniform float uCloudDeck;
uniform sampler2D uCloudDetail;
uniform float uCloudAlbedo;
uniform float uCloudDetailErode;
uniform float uCloudDetailRelief;
uniform sampler2D uNightLights;
uniform float uCloudCityGlow;
uniform float uFrameSpin;
${CLOUD_FRAME_GLSL}${CLOUD_SHADOW_DECLS}${CLOUD_LIGHT_DECLS}uniform float uPlanetRadius;
uniform float uSolarIrradiance;
uniform vec3 uAirlightScale;
uniform sampler2D uTransmittance;
uniform sampler2D uIrradiance;
uniform sampler3D uScattering;
${import.meta.env.DEV ? `${PERF_SWITCH_DECLS}
${DEV_TUNING_DECLS}` : ''}
varying vec3 vSunViewDir;
varying vec3 vMoonViewDir;
varying vec3 vObjPos;
varying vec3 vPlanetshineViewDir;
varying vec3 vAirCam;
varying vec3 vAirFrag;
${RING_SHADOW_OPACITY_GLSL}${MOON_SHADOW_TRACE_GLSL}${ATMOSPHERE_LOOKUP_BODY_GLSL}${AERIAL_PERSPECTIVE_GLSL}${NIGHT_WEIGHT_GLSL}${MOON_UP_GLSL}${SUN_DOWN_GLSL}${CLOUD_COVERAGE_GLSL}${CLOUD_DETAIL_GLSL}${SPHERE_EQUIRECT_UV_GLSL}${SMOOTH_TEXEL_GLSL}${SURFACE_DETAIL_GLSL}${SEA_LOBE_GLSL}${CLOUD_FIELD_DECLS}`;

/**
 * three's <normal_fragment_maps>, with the tangent-space branch taken over.
 *
 * The deck's height field is its coarsest map by far — tens of kilometres to
 * the texel where its colour map is a few — so it is the layer whose bilinear
 * facets read first, as flat-shaded quilting across the interior of every
 * bank, and it is drawn through the smooth magnification filter instead. That
 * used to be done AFTER the chunk, which meant the chunk's own fetch and its
 * tangent-frame transform were computed and then overwritten on every deck
 * fragment, with the relief fetched a second time for the mix. Done here
 * instead, the relief is read once — the plain tap, taken in uniform flow as
 * the chunk always took it, is the mix's own first endpoint — and the frame
 * transform happens once. The plain tap is not put under the weight, for the
 * reason SURFACE_MAP_FRAGMENT gives.
 *
 * The other paths through the chunk — object-space normals, the bump map — are
 * the include itself, unchanged: they belong to every other body's surface and
 * there is nothing to save on them.
 *
 * The frame the relief is turned into a normal with (world/reliefFrame.ts) is
 * the sphere's own orthonormal east and north, the balance the maps are baked
 * in; it reads no UV, so a sector's crop of any shape is drawn in the frame
 * its globe is. The deck keeps three's `tbn` exactly: its relief is a
 * brightness proxy, not a slope.
 *
 * The map's blue is never read. A tangent normal is a unit vector, so its z
 * is √(1 − x² − y²), and reading x and y alone is what lets every normal map
 * be stored two bytes a texel (texturePolicy's 'normal' kind, RG8): a
 * two-channel texture has no blue to read, and the blue a four-channel upload
 * still carries says the same thing to within half a degree at the steepest
 * texel — so one text draws both storages, and the DEV A/B between them is a
 * difference of nothing.
 */
/** The deck drawn through the ground's program — DEV's `cloud-program` switch
 *  off, the only way a deck reaches a program without CLOUD_DECK — keeps
 *  three's frame there too. A production deck always has its own program, so
 *  production's ground program has no such line. */
const RELIEF_DECK_FALLBACK = import.meta.env.DEV ? '\tif ( DECK_ON ) reliefFrame = tbn;\n' : '';

const SURFACE_NORMAL_MAPS = /* glsl */ `
#if defined( USE_NORMALMAP_TANGENTSPACE )
${RELIEF_PROBE_OPEN}	vec4 reliefTexel = texture2D( normalMap, vNormalMapUv );
	if ( ${SMOOTH_PROBE_GUARD}DECK_ON ) {
		vec2 reliefTexels = vec2( textureSize( normalMap, 0 ) );
		float reliefSmoothW = smoothTexelWeight( vNormalMapUv, reliefTexels );
		if ( reliefSmoothW > 0.0 ) {
			reliefTexel = mix( reliefTexel,
				textureBSpline( normalMap, vNormalMapUv, reliefTexels ), reliefSmoothW );
		}
	}
	// x and y are the map; z is a unit normal's own, so a two-channel upload
	// draws exactly as a four-channel one.
	vec2 reliefXY = reliefTexel.xy * 2.0 - 1.0;
	vec3 mapN = vec3( reliefXY, sqrt( max( 0.0, 1.0 - dot( reliefXY, reliefXY ) ) ) );
	mapN.xy *= normalScale;
#if defined( CLOUD_DECK )
	normal = normalize( tbn * mapN );
#else
	mat3 reliefFrame = reliefSphereFrame( vReliefPole, normal );
${RELIEF_DECK_FALLBACK}	normal = normalize( reliefFrame * mapN );
#endif
${RELIEF_PROBE_CLOSE}#else
#include <normal_fragment_maps>
#endif
`;

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
if (DECK_ON) {
  // Where this fragment is, in the body's own frame. Every derivative the
  // block needs is taken HERE, inside the one branch that is uniform across
  // the draw: a derivative under a per-fragment condition is undefined, and
  // the fade below is exactly such a condition.
  vec3 objDir = normalize(vObjPos);
  vec3 objDx = dFdx(objDir);
  vec3 objDy = dFdy(objDir);
  vec3 sx = dFdx(-vViewPosition);
  vec3 sy = dFdy(-vViewPosition);
  // Where this fragment stands over the GROUND — the frame the night map is
  // painted in. The deck drifts on top of the body's spin, so its own UV is
  // that drift out of register with the cities under it. The derivatives come
  // with it: the lookup happens under a per-fragment condition further down,
  // where an implicit one is undefined.
  cloudNightUv = sphereEquirectUv(objDir);
  cloudNightDx = sphereEquirectUvGrad(objDir, objDx);
  cloudNightDy = sphereEquirectUvGrad(objDir, objDy);
  // Where it is on the deck's OWN sheet, which is where the detail belongs:
  // the body frame turned back by the drift the deck's mesh carries, the frame
  // the cloud map is painted in. Read off anything else — the world's axes,
  // say — the detail stands still in the sky while the cloud under it turns
  // with the planet and drifts on top of that, and every carved edge crawls.
  // The turn is linear, so it carries the derivatives exactly as it carries
  // the direction.
  vec3 dir = bodyToDeck(objDir, uFrameSpin);
  vec3 ddx = bodyToDeck(objDx, uFrameSpin);
  vec3 ddy = bodyToDeck(objDy, uFrameSpin);
${NOISE_FRAME_OFF_ARM}  float cosLat = max(sqrt(dir.x * dir.x + dir.z * dir.z), 1e-4);
  // The angles' screen derivatives, taken analytically from the direction's.
  // atan() has a branch cut at the antimeridian, and reading its derivative
  // through dFdx would put one pixel of enormous gradient down that line — the
  // wrong mip and no detail on it. cos(latitude) is the same sqrt for both.
  vec2 dAngX = vec2((dir.x * ddx.z - dir.z * ddx.x) / (cosLat * cosLat), ddx.y / cosLat);
  vec2 dAngY = vec2((dir.x * ddy.z - dir.z * ddy.x) / (cosLat * cosLat), ddy.y / cosLat);
  vec2 detailUv = vec2(atan(dir.z, dir.x), asin(clamp(dir.y, -1.0, 1.0))) * ${CLOUD_DETAIL_UV_PER_RADIAN.toFixed(7)};
  vec2 duvX = dAngX * ${CLOUD_DETAIL_UV_PER_RADIAN.toFixed(7)};
  vec2 duvY = dAngY * ${CLOUD_DETAIL_UV_PER_RADIAN.toFixed(7)};
  float cloudDetailW = ${DETAIL_PROBE_GUARD}cloudDetailFade(max(length(duvX), length(duvY)) * ${CLOUD_DETAIL_SIZE.toFixed(1)});
  // Explicit gradients, for the same reason the angles' were taken by hand: the
  // mip has to be chosen off a quantity that is continuous across the cut.
  // Past the fade the weight is exactly zero: the erosion's mix returns 1 and
  // the relief block below is not entered, so the fetch has no reader.
  vec4 detail = vec4(0.0);
  if (${cloudTapKept('cloudDetailW > 0.0')}) detail = textureGrad(uCloudDetail, detailUv, duvX, duvY);
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
  // wisps — the band is zero at both ends, which is also what keeps an exactly
  // clear fragment exactly clear through this.
  cloudAlpha *= mix(1.0, mix(1.0 - uCloudDetailErode, 1.0, detail.r),
      cloudEdgeBand(cloudAlpha) * cloudDetailW);
  // The hue survives; the brightness is pulled toward the cloud's own albedo by
  // however much of the map is coverage rather than albedo. All of it and the
  // solid interiors are one flat white with no structure; none of it and the
  // ring comes back.
  diffuseColor.rgb = min(
      diffuseColor.rgb * pow(uCloudAlbedo / max(cloudLum, 0.001), ${CLOUD_ALBEDO_BLEND.toFixed(6)}),
      vec3(1.0));
${CLOUD_FIELD_MIX}  if (cloudDetailW > 0.0) {
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
}
${SURFACE_DETAIL_BODY}
${CLOUD_CLEAR_RETURN}`;

/**
 * The sea's flag for the bloom, in the alpha the opaque ground otherwise
 * writes as 1 (three's <opaque_fragment>): under the beam chain, water writes
 * 1 - 2 x its water fraction instead, so open sea reads -1, land 1 and a
 * coast in between, and the planetarium's bright pass (app/bloomTargets
 * SEA_BLOOM_SHARE_GLSL) hands the blur none of a negative pixel. That is what
 * lets the beam carry its physical radiance — several whites at a low Sun —
 * without the Sun's glow, blurred at the Sun's radius, painting it as a halo
 * over the limb and into space; the Sun and every other pixel keep an alpha
 * of zero or more and their glow bit for bit. Only the ground: the deck's
 * alpha IS its coverage, and its blend over the sea pulls the flag back
 * toward 1 in proportion, which is the continuous control it should be. The
 * canvas is opaque and every finishing pass writes its own alpha, so the flag
 * reaches the bright pass and nothing else. Off with `?seabeam=0`, where the
 * cap before the air kept the sea under the bloom's threshold anyway.
 */
const SEA_BLOOM_FLAG_GLSL = /* glsl */ `
#ifdef SEA_BEAM
  if (GROUND_ON(uWaterGloss > 0.0)) gl_FragColor.a = 1.0 - 2.0 * seaWater;
#endif`;

/**
 * Where the Sun's beam to this ground point crosses the deck, and how much of
 * it gets through: `cloudSunKeep`, read once, for its three readers below.
 *
 * Everything the lookup needs from the screen is taken first, inside a branch
 * on a uniform that the whole draw takes the same way, and before the
 * per-fragment gate: the gate splits quads at the terminator, and a derivative
 * under it is undefined. The derivatives are of the DISPLACED direction, not
 * the ground's: near the terminator the pierce point moves across the deck
 * faster than the ground point under it moves across the ground, so the
 * ground's own footprint would pick too sharp a mip there.
 *
 * The gate is the Sun above this fragment's own geometric horizon. Below it
 * there is no direct light to shade, and the ray goes into the ground before it
 * reaches any cloud, so the shell it meets on the far side is no shadow.
 *
 * The lookup is the deck's own: the deck draws its map through the smooth
 * magnification filter (SMOOTH_TEXEL_GLSL), because bilinear under the
 * coverage curve draws the texel grid, and a shadow drawn without it would be
 * a square-edged copy of a round cloud. The weight is taken from the explicit
 * gradients here — the coordinate wraps at the date line, and the read sits
 * under the gate — where the deck takes it from its own UV.
 *
 * The penumbra: the solar disc is half a degree wide, so a cloud's edge throws
 * a soft edge on the ground h·Δθ/sin²e long along the shadow, which is the
 * same footprint on the deck seen from the ground point — 3 km with the Sun 10°
 * up. Each screen step on the deck is widened to at least that, and the mip
 * chain does the blur. The width stops growing below 5.7° (9 km), where the
 * true one runs on toward the 357 km of the horizon itself. Isotropic: across
 * the shadow the true width is sin e of that, and a first look is wanted
 * before the shape is.
 *
 * With the cloud field compiled too (CLOUD_FIELD, which a ground takes only
 * beside this define, in a session that has the field), the coverage is the
 * field's wherever a page is resident at the pierce point: `cloudFieldFine`'s
 * opacity, mixed over the base sheet's at the field's weight exactly as the
 * deck mixes them, so a shadow sharpens and fades in step with its cloud. The
 * sheet and the field are cut from one master, so where no page is resident
 * the base is the same sky, softer. The weight's guard reads this lookup's own
 * footprint — the displaced direction's derivatives, the penumbra included —
 * and the penumbra is held in the tile ratio's pixels there, the pixels the
 * guard and the residency's shadow demand (world/cloudFieldMeasure) both
 * measure in, so a Dynamic rung step moves neither. Each read is taken only
 * where it has a share: the base not at full weight, the page not at none,
 * and neither filter's plain tap where the smooth one takes it all.
 *
 * The field's arm also spends less arithmetic getting there, because this
 * runs at every fragment of the ground and each instruction saved is a share
 * of the frame that can be measured: the turn into the deck's frame takes the
 * drift's cosine and sine as uniforms (`setCloudShadowDrift`) rather than
 * evaluating both at each fragment, and the penumbra widens each gradient
 * through one reciprocal square root rather than a length and a division —
 * the same numbers to float rounding. A ground without the field keeps the
 * read it had: with CLOUD_FIELD off the program is the one from before the
 * field reached it (aerialPerspective.test.ts pins that text).
 */
const CLOUD_SHADOW_FIELD_TURN = /* glsl */ `#ifdef CLOUD_FIELD
    vec3 shadowRay = cloudRayDirection(shadowN, shadowL, uCloudHeightOverRadius);
    vec3 shadowDir = vec3(uCloudShadowTurn.x * shadowRay.x - uCloudShadowTurn.y * shadowRay.z, shadowRay.y,
                          uCloudShadowTurn.y * shadowRay.x + uCloudShadowTurn.x * shadowRay.z);
#else
`;
const CLOUD_SHADOW_FIELD_PENUMBRA = /* glsl */ `#ifdef CLOUD_FIELD
    shadowPenumbra /= uCloudFieldPixelScale;
    shadowDx *= max(1.0, shadowPenumbra * inversesqrt(max(dot(shadowDx, shadowDx), 1e-24)));
    shadowDy *= max(1.0, shadowPenumbra * inversesqrt(max(dot(shadowDy, shadowDy), 1e-24)));
#else
`;
const CLOUD_SHADOW_FIELD_END = '#endif\n';
const CLOUD_SHADOW_FIELD_READ = /* glsl */ `#ifdef CLOUD_FIELD
      float shadowFieldW = 0.0;
      float shadowFieldLayer = -1.0;
      float shadowCover = cloudFieldFine(shadowDir, shadowDx, shadowDy, shadowFieldW, shadowFieldLayer).x;
      if (shadowFieldW < 1.0) {
        vec2 shadowTexels = vec2(textureSize(uCloudShadowMap, 0));
        float shadowPerPixel = max((abs(shadowUvDx.x) + abs(shadowUvDy.x)) * shadowTexels.x,
                                   (abs(shadowUvDx.y) + abs(shadowUvDy.y)) * shadowTexels.y);
        float shadowSmoothW = 1.0 - smoothstep(${SMOOTH_TEXEL_FADE[0].toFixed(6)}, ${SMOOTH_TEXEL_FADE[1].toFixed(6)}, shadowPerPixel);
        vec4 shadowTexel = vec4(0.0);
        if (shadowSmoothW < 1.0) shadowTexel = textureGrad(uCloudShadowMap, shadowUv, shadowUvDx, shadowUvDy);
        if (shadowSmoothW > 0.0) {
          vec4 shadowSmooth = textureBSpline(uCloudShadowMap, shadowUv, shadowTexels);
          shadowTexel = shadowSmoothW >= 1.0 ? shadowSmooth : mix(shadowTexel, shadowSmooth, shadowSmoothW);
        }
        shadowCover = mix(cloudCoverage(dot(shadowTexel.rgb,
            vec3(${LUMINANCE_WEIGHTS.map((w) => w.toFixed(4)).join(', ')}))), shadowCover, shadowFieldW);
      }
      cloudSunKeep = 1.0 - shadowCover;
#else
`;

const CLOUD_SHADOW_READ = /* glsl */ `
#ifdef CLOUD_SHADOW
  // With cloud shadows compiled in, the beam's share is read HERE, for the
  // ground, the sea and the air alike, where the Sun's ray to this point
  // crosses the deck as it is drawn; the straight-down read under the sea's
  // gloss is compiled out below, and the sea's cut reads this value instead.
  // The shade's fade toward the horizon (CLOUD_SHADOW_HORIZON_SIN) rides
  // beside it: the beam is the beam, and only what the ground and the air
  // take from it fades.
  float cloudShadeHorizon = 0.0;
  if (GROUND_ON(uCloudAbove > 0.0)) {
    vec3 shadowN = normalize(vObjPos);
    vec3 shadowL = normalize(uSunDirLocal);
    float shadowMu = dot(shadowN, shadowL);
${CLOUD_SHADOW_FIELD_TURN}    vec3 shadowDir = bodyToDeck(cloudRayDirection(shadowN, shadowL, uCloudHeightOverRadius), uCloudShadowSpin);
${CLOUD_SHADOW_FIELD_END}    vec3 shadowDx = dFdx(shadowDir);
    vec3 shadowDy = dFdy(shadowDir);
    float shadowPenumbra = ${CLOUD_SHADOW_PENUMBRA_GUARD}uCloudHeightOverRadius * (2.0 * uSunTan)
        / max(shadowMu * shadowMu, 0.01);
${CLOUD_SHADOW_FIELD_PENUMBRA}    shadowDx *= max(1.0, shadowPenumbra / max(length(shadowDx), 1e-12));
    shadowDy *= max(1.0, shadowPenumbra / max(length(shadowDy), 1e-12));
${CLOUD_SHADOW_FIELD_END}    vec2 shadowUv = sphereEquirectUv(shadowDir);
    vec2 shadowUvDx = sphereEquirectUvGrad(shadowDir, shadowDx);
    vec2 shadowUvDy = sphereEquirectUvGrad(shadowDir, shadowDy);
    bool cloudTapWanted = shadowMu > 0.0;
    cloudShadeHorizon = smoothstep(0.0, ${CLOUD_SHADOW_HORIZON_SIN.toFixed(6)}, shadowMu);
    if (cloudTapWanted) {
${CLOUD_SHADOW_FIELD_READ}      vec4 shadowTexel = textureGrad(uCloudShadowMap, shadowUv, shadowUvDx, shadowUvDy);
      vec2 shadowTexels = vec2(textureSize(uCloudShadowMap, 0));
      float shadowPerPixel = max((abs(shadowUvDx.x) + abs(shadowUvDy.x)) * shadowTexels.x,
                                 (abs(shadowUvDx.y) + abs(shadowUvDy.y)) * shadowTexels.y);
      float shadowSmoothW = 1.0 - smoothstep(${SMOOTH_TEXEL_FADE[0].toFixed(6)}, ${SMOOTH_TEXEL_FADE[1].toFixed(6)}, shadowPerPixel);
      if (shadowSmoothW > 0.0) {
        shadowTexel = mix(shadowTexel, textureBSpline(uCloudShadowMap, shadowUv, shadowTexels), shadowSmoothW);
      }
      cloudSunKeep = 1.0 - cloudCoverage(dot(shadowTexel.rgb,
          vec3(${LUMINANCE_WEIGHTS.map((w) => w.toFixed(4)).join(', ')})));
${CLOUD_SHADOW_FIELD_END}    }
  }
#endif
`;

/**
 * The first reader: the Sun's diffuse light on the ground, cut by the cloud's
 * SHADE — the beam's loss through the shade curve (CLOUD_SHADOW_GAMMA), since
 * the light a thin veil scatters out of the beam mostly still reaches the
 * ground. three adds `reflectedLight.directDiffuse` into `outgoingLight` as it
 * stands — no occlusion map, transmission, sheen or clearcoat reaches it on
 * these materials — so this removes exactly that much of the Sun. After the
 * sea's own block, which cuts only the mirror term by the beam itself, and
 * before the eclipse factor, which multiplies both.
 */
const CLOUD_SHADOW_DIFFUSE = /* glsl */ `
#ifdef CLOUD_SHADOW
  float cloudShade = pow(1.0 - cloudSunKeep, ${CLOUD_SHADOW_GAMMA_GLSL}) * cloudShadeHorizon;
  outgoingLight -= reflectedLight.directDiffuse * (cloudShade * ${CLOUD_SHADOW_DEPTH_GLSL});
#endif
`;

/** The third reader: the Sun's glow in the air between the camera and this
 *  ground point, the share of that column under the cloud taken with it — and
 *  less of it as the view grazes, measured on the ground's geometric normal
 *  (never the perturbed one) against the line of sight (CLOUD_SHADOW_AIR_GRAZE).
 *  With the field compiled the cosine is the one three's lights already hold,
 *  its unperturbed normal against its view direction (both in view space),
 *  rather than a second normalization of the sight line in the world's axes. */
const CLOUD_SHADOW_AIR_SCALE = /* glsl */ `
#ifdef CLOUD_SHADOW
#ifdef CLOUD_FIELD
      airS *= 1.0 - cloudShade * ${CLOUD_SHADOW_AIR_GLSL}
          * smoothstep(${CLOUD_SHADOW_AIR_GRAZE[0].toFixed(6)}, ${CLOUD_SHADOW_AIR_GRAZE[1].toFixed(6)}, dot(nonPerturbedNormal, geometryViewDir));
#else
      airS *= 1.0 - cloudShade * ${CLOUD_SHADOW_AIR_GLSL}
          * smoothstep(${CLOUD_SHADOW_AIR_GRAZE[0].toFixed(6)}, ${CLOUD_SHADOW_AIR_GRAZE[1].toFixed(6)}, dot(up, normalize(vAirCam - vAirFrag)));
#endif
#endif
`;

/**
 * The second reader of the shade on the ground: the sky's own light, added in
 * proportion to it (CLOUD_SHADOW_SKY_FILL) — the irradiance table's skylight
 * at the ground's radius and the Sun's height there, by albedo over pi as the
 * night side's ambient takes it, so a shadow keeps the blue a real one keeps.
 * The night weight's complement hands it over to that ambient where every
 * night source hands over, and the shade's own fade at the horizon already
 * takes it to nothing where the Sun meets the ground's horizon. Only where the
 * body's air tables are bound: with no tables there is no sky to read. A
 * ground compiled with the cloud field fetches the table only where there is
 * a shade to fill, which over clear sky is exactly none: the same picture,
 * without the read.
 */
const CLOUD_SHADOW_FILL = /* glsl */ `
#ifdef CLOUD_SHADOW
#ifdef CLOUD_FIELD
  if (cloudShade > 0.0 && ${CLOUD_SHADOW_SKY_FILL_GUARD}uAirDensity > 0.0) {
#else
  if (${CLOUD_SHADOW_SKY_FILL_GUARD}uAirDensity > 0.0) {
#endif
    float fillMuS = clampCosine(dot(normalize(vAirFrag), normalize(uSunDirWorld)));
    outgoingLight += diffuseColor.rgb * RECIPROCAL_PI
        * (getIrradiance(uIrradiance, clampRadius(length(vAirFrag) / uPlanetRadius), fillMuS)
            * uAirlightScale * uSolarIrradiance)
        * (cloudShade * ${CLOUD_SHADOW_SKY_FILL_GLSL} * (1.0 - nightWeight(fillMuS)));
  }
#endif
`;

/**
 * The deck lit as a cloud (CLOUD_LIGHT, the planetarium's deck only), both
 * terms into `outgoingLight` and nothing else — never the alpha, which is the
 * deck's coverage.
 *
 * First, the light scattered inside the cloud: the deck's direct diffuse
 * becomes a mix of the Lambert term on the relief's perturbed normal — three's
 * own `reflectedLight.directDiffuse` — and the same lights through the same
 * BRDF on the shell's geometric normal (`nonPerturbedNormal`, the sphere's own
 * interpolated radial one). The lights are read the way three's
 * lights_fragment_begin reads them, every point and directional light the
 * program was built with, so no light is assumed to be the Sun by its index.
 * `reflectedLight.directDiffuse` was scaled before this point by the Sun's
 * path through the air (the body-scope `vec3 sunPath`, set at the top of the
 * surface body and applied to the direct terms there), so `cloudGeoIrradiance`
 * is multiplied by that same `sunPath`, exactly as the perturbed-normal term
 * it is mixed with already has been, or the wrap hands back the light the
 * path took away.
 *
 * Second, the sky: the irradiance table's own skylight at the deck's radius and
 * the Sun's height there, by albedo over pi as three's diffuse BRDF and the
 * night side's ambient both take it, weighted by the night weight's
 * complement so it hands over to that ambient along the same ramp and the two
 * sum to the table's irradiance through the terminator. Only where the body's
 * air tables are bound; on the tier without them the deck has no sky light.
 *
 * Placed after three's lighting and before the eclipse factor, the limb and
 * the air, so a moon's umbra dims both terms and the air sees them as light
 * leaving the deck. No derivative and no mipped fetch: it sits past the deck's
 * clear-sky return, where the lanes are divergent.
 */
const CLOUD_LIGHT_DECK = /* glsl */ `
#ifdef CLOUD_LIGHT
  if (DECK_ON) {
    vec3 cloudGeoIrradiance = vec3(0.0);
    IncidentLight cloudLight;
#if NUM_POINT_LIGHTS > 0
    #pragma unroll_loop_start
    for ( int i = 0; i < NUM_POINT_LIGHTS; i ++ ) {
      getPointLightInfo( pointLights[ i ], geometryPosition, cloudLight );
      cloudGeoIrradiance += saturate( dot( nonPerturbedNormal, cloudLight.direction ) ) * cloudLight.color;
    }
    #pragma unroll_loop_end
#endif
#if NUM_DIR_LIGHTS > 0
    #pragma unroll_loop_start
    for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
      getDirectionalLightInfo( directionalLights[ i ], cloudLight );
      cloudGeoIrradiance += saturate( dot( nonPerturbedNormal, cloudLight.direction ) ) * cloudLight.color;
    }
    #pragma unroll_loop_end
#endif
    // The Sun's path through the air took its share of the direct diffuse at
    // the top of the body; the geometric term is the same Sun through the same
    // air, so it takes the same share, or the wrap would hand a low-Sun cloud
    // top back the unattenuated, unreddened light the path took away.
    cloudGeoIrradiance *= sunPath;
    outgoingLight += ${CLOUD_LIGHT_WRAP_GLSL}
        * (cloudGeoIrradiance * BRDF_Lambert( material.diffuseContribution ) - reflectedLight.directDiffuse);
    if (uAirDensity > 0.0) {
      float skyMuS = clampCosine(dot(normalize(vAirFrag), normalize(uSunDirWorld)));
      float skyR = clampRadius(uAirLookupRadius > 0.0 ? uAirLookupRadius : length(vAirFrag) / uPlanetRadius);
      outgoingLight += diffuseColor.rgb * RECIPROCAL_PI
          * (getIrradiance(uIrradiance, skyR, skyMuS) * uAirlightScale * uSolarIrradiance)
          * (${CLOUD_LIGHT_SKY_GLSL} * (1.0 - nightWeight(skyMuS)));
    }
  }
#endif
`;

const SURFACE_FRAGMENT_BODY = /* glsl */ `{
  // The Sun's own path through this body's air to the fragment. three's point
  // light reaches every surface at its full strength, but a Sun ten degrees up
  // has come through several times the zenith's column, and what reaches the
  // ground is dimmer and redder: the gold on a low-Sun sea, a cloud top and a
  // coast is that path. The table's transmittance toward the Sun at this
  // fragment's radius and Sun angle, divided by the same table at the zenith,
  // so the subsolar picture stays the one that was graded and only the low Sun
  // moves; on the direct terms alone — the diffuse and the mirror — because
  // the sky's light is the air's own and comes in through the irradiance
  // table where that is read. Faded in with the air's own blend, so the
  // tables' arrival does not step the terminator; skipped where the Sun is
  // under the fragment's horizon, where three's direct terms are zero
  // already. The deck takes it at its own altitude. Any build: ?sunpath=0.
  // Body scope, one everywhere the branch is not taken, so any later term
  // that reads the Sun's irradiance for itself (the deck's light on its
  // geometric normal) multiplies by the same factor the direct terms took.
  vec3 sunPath = vec3(1.0);
#ifdef SUN_PATH
  if (uAirDensity > 0.0 && dot(normal, normalize(vSunViewDir)) > 0.0) {
    float sunPathR = clampRadius(length(vAirFrag) / uPlanetRadius);
    float sunPathMu = clampCosine(dot(normalize(vAirFrag), normalize(uSunDirWorld)));
    sunPath = getTransmittanceToSun(uTransmittance, sunPathR, sunPathMu)
        / max(getTransmittanceToSun(uTransmittance, sunPathR, 1.0), vec3(1e-4));
    sunPath = mix(vec3(1.0), min(sunPath, vec3(1.0)), uAirBlend);
    outgoingLight -= (reflectedLight.directDiffuse + reflectedLight.directSpecular) * (1.0 - sunPath);
    reflectedLight.directDiffuse *= sunPath;
    reflectedLight.directSpecular *= sunPath;
  }
#endif
  // The sea's mirror term as water rather than as three's generic dielectric
  // (SEA_WATER_F0): three's term is rescaled by the ratio of the two Schlick
  // curves at this fragment's half vector, with three's own exp2 approximation
  // of the fifth power so the division takes out exactly what was put in.
  // Then, with the wind map on, the lobe: three's GGX is divided out at the
  // same half vector and one Beckmann lobe at the map's wind put in its
  // place, because Beckmann with alpha squared as the mean-square slope IS
  // Cox-Munk's Gaussian slope law, and GGX's heavy tail spread the sheen into
  // haze. The lobe takes three's own alpha, its geometry roughness and floor
  // included, so a small disc's normal spread widens it. Then the cap, on
  // the water's own reflection and in units of white (OCEAN_GLINT_CAP). What
  // is left is what the cloud mask below can cut. Both the Fresnel and the lobe are the
  // water's, so both fade with the water fraction the roughness map reads:
  // the gate is the material's, and the land under it keeps three's own
  // dielectric term and lobe, as it had before the sea was given its own.
  vec3 seaGlint = vec3(0.0);
  vec3 seaSky = vec3(0.0);
  if (GROUND_ON(uWaterGloss > 0.0)) {
    vec3 glintRaw = reflectedLight.directSpecular;
    vec3 seaViewDir = normalize(vViewPosition);
    vec3 seaHalfDir = normalize(normalize(vSunViewDir) + seaViewDir);
    float seaDotVH = clamp(dot(seaViewDir, seaHalfDir), 0.0, 1.0);
    float seaFresnelTail = exp2((-5.55473 * seaDotVH - 6.98316) * seaDotVH);
    float seaFresnel = mix(1.0,
        (${SEA_WATER_F0.toFixed(5)} * (1.0 - seaFresnelTail) + seaFresnelTail)
            / (0.04 * (1.0 - seaFresnelTail) + seaFresnelTail),
        seaWater);
    float seaLobe = 1.0;
    if (uSeaWindOn > 0.5) {
      float seaDotNH = saturate(dot(normal, seaHalfDir));
      float seaDotNL = saturate(dot(normal, normalize(vSunViewDir)));
      float seaDotNV = saturate(dot(normal, seaViewDir));
      float seaAlpha = pow2(material.roughness);
      float seaVis = V_GGX_SmithCorrelated(seaAlpha, seaDotNL, seaDotNV);
      // The beam chain shadows the Beckmann lobe with Beckmann's own Smith
      // term, because three's correlated GGX one reads a fifth to a third
      // dark on this lobe at a grazing Sun and eye, which is where the beam
      // is; the old chain keeps three's, which then cancels. The denominator
      // stays three's whichever chain, since that is what is being divided out.
#ifdef SEA_BEAM
      float seaBeamVis = seaBeckmannVis(seaAlpha, seaDotNL, seaDotNV);
#else
      float seaBeamVis = seaVis;
#endif
      seaLobe = mix(1.0,
          seaBeamVis * seaBeckmann(seaAlpha, seaDotNH) / (seaVis * D_GGX(seaAlpha, seaDotNH)),
          seaWater);
    }
    vec3 seaGlintFull = glintRaw * (seaFresnel * seaLobe${GLINT_KEEP_GLSL});
    // The old chain caps the term here, before the air and the limb darkening
    // (OCEAN_GLINT_CAP). The beam chain carries the whole of it to the camera
    // and shapes it there, after the air (OCEAN_BEAM_KNEE, OCEAN_BEAM_CAP):
    // seaGlint stays the mirror term as it CURRENTLY sits inside
    // outgoingLight, scaled below by everything that scales the light.
#ifdef SEA_BEAM
    seaGlint = seaGlintFull;
#else
    seaGlint = min(seaGlintFull, vec3(${GLINT_CAP_GLSL}));
#endif
    outgoingLight -= glintRaw - seaGlint;
#ifdef SEA_SKY
    // The sky reflected off the water (SEA_SKY_GRAZING_COS): the air's
    // scattering table read at the surface along the view ray reflected
    // about the radial normal, in the air's frame (vAirFrag and vAirCam are
    // offsets from the body's centre in world axes, so the Sun is
    // uSunDirWorld), at radius exactly one (a sector's chord sits a little
    // under or over it), the ray's cosine clamped at the horizon, the
    // single-Mie term recovered and gated as the camera leg gates it. Only
    // with water under the fragment, the tables bound, and the Sun above the
    // table's floor (uMuSMin: below it the table reads its edge row, a
    // pedestal over the whole night half, and the fetches would be spent on
    // it). Faded in with the air (uAirBlend), as the camera leg is.
    if (uAirDensity > 0.0 && seaWater > 0.0) {
      vec3 skyUp = normalize(vAirFrag);
      vec3 skySun = normalize(uSunDirWorld);
      float skyMuS = dot(skyUp, skySun);
      if (skyMuS > uMuSMin) {
        vec3 skyView = normalize(vAirFrag - vAirCam);
        float skyCos = max(-dot(skyView, skyUp), 0.0);
        vec3 skyRay = skyView + 2.0 * skyCos * skyUp;
        float skyNu = dot(skyRay, skySun);
#ifdef MIE_EXACT
        vec2 skyMieGB;
        vec4 skyS = getScatteringAndMieColour3D(uScattering, 1.0, skyCos, skyMuS, skyNu, false, skyMieGB);
        vec3 skyMie = vec3(skyS.a, skyMieGB) * smoothstep(0.0, 0.01, skyMuS);
#else
        vec4 skyS = getScattering3DRGBA(uScattering, 1.0, skyCos, skyMuS, skyNu, false);
        vec3 skyMie = getExtrapolatedSingleMieScattering(skyS) * smoothstep(0.0, 0.01, skyMuS);
#endif
        vec3 skyRadiance = (skyS.rgb * rayleighPhaseFunction(skyNu) + skyMie * miePhaseFunction(uMiePhaseG, skyNu))
            * uAirlightScale * uSolarIrradiance;
        seaSky = skyRadiance
            * (seaWater * uAirBlend * seaFresnelExact(max(skyCos, ${SEA_SKY_GRAZING_COS.toFixed(2)}))${SEA_SKY_SCALE_GLSL});
        outgoingLight += seaSky;
      }
    }
#endif
  }
  // The deck's alpha, worked out with its colour above where the lights could
  // still see both. A deck at a flat opacity dims clear sky by that fraction
  // everywhere and caps the thickest cloud at it; reading the map means a pixel
  // over clear sky has no deck on it at all. The alpha is 1 on every other
  // surface, so the terms below that scale by it are the deck's alone without a
  // second branch.
  diffuseColor.a *= cloudAlpha;
  // The share of the Sun's direct beam that reaches this fragment through the
  // cloud deck above it: 1 in clear air, and 1 on every surface that reads no
  // deck. The deck blends what leaves this fragment by (1 - coverage) on the
  // way UP; the beam is cut by the same coverage on the way DOWN. Anything
  // else that scales the Sun's direct light under cloud reads this one value,
  // so a cloud and what it shades cannot disagree about where the cloud is.
  // Read only under the water gloss, which is nonzero only where a real water
  // mask says there is sea: one uniform branch, and no fetch at all, on every
  // other surface in the app. It is also left at 1 wherever cloudTapWanted
  // below skips the read, so a reader of it must have nothing to scale
  // wherever the Sun's mirror term is zero, or widen that condition.
  float cloudSunKeep = 1.0;
${CLOUD_SHADOW_READ}  if (GROUND_ON(uWaterGloss > 0.0)) {
#ifndef CLOUD_SHADOW
    float deckC = cos(uCloudShadowSpin);
    float deckS = sin(uCloudShadowSpin);
    // The deck's own object frame, which is the body frame turned back by the
    // drift its mesh carries — the frame its colour map is painted in.
    vec3 deckDir = normalize(vec3(vObjPos.x * deckC - vObjPos.z * deckS,
                                  vObjPos.y,
                                  vObjPos.z * deckC + vObjPos.x * deckS));
    // Explicit gradients, taken analytically from the direction's: the UV
    // jumps a whole turn at the date line, and an implicit derivative read
    // across that jump would pick the coarsest mip down that one column of
    // pixels — a hairline of average cloud drawn over the sea. Taken HERE and
    // not inside the gate below: this branch is a compare against a uniform,
    // which the whole draw takes the same side of, and the gate is not.
    vec2 deckUv = sphereEquirectUv(deckDir);
    vec2 deckDx = sphereEquirectUvGrad(deckDir, dFdx(deckDir));
    vec2 deckDy = sphereEquirectUvGrad(deckDir, dFdy(deckDir));
    // The one condition under which the cloud map is read for this fragment:
    // a term that needs cloudSunKeep somewhere new widens the read here rather
    // than fetching the map again. Wherever the Sun is below this fragment's
    // horizon three's own N·L saturates to zero and the water's mirror term
    // above is exactly zero in every channel: the one reader of the value in
    // such a fragment is the sea's cut below, which is then a subtraction of
    // nothing whatever the deck says, and the whole cloud-map read would be
    // spent on it. Tested on the term itself rather than on "night side",
    // because it is the perturbed normal that decides whether there is a
    // highlight, and uWaterGloss is a material-wide enable rather than a
    // per-fragment test for sea.
    bool cloudTapWanted = ${import.meta.env.DEV
      ? 'uPerfGlintGate < 0.5 || any(greaterThan(seaGlint, vec3(0.0)))'
      : 'any(greaterThan(seaGlint, vec3(0.0)))'};
    if (cloudTapWanted) {
      float deckLum = dot(textureGrad(uCloudShadowMap, deckUv, deckDx, deckDy).rgb,
          vec3(${LUMINANCE_WEIGHTS.map((w) => w.toFixed(4)).join(', ')}));
      cloudSunKeep = 1.0 - cloudCoverage(deckLum);
    }
#endif
    // The sea's glint, cut by what the Sun's beam went through to reach it:
    // the water's own term above, already rescaled, because cutting three's
    // raw term here would drive the light below zero under cloud, which the
    // bloom then paints as a yellow core in a blue ring. Only the mirror term
    // notices — ground under cloud is still lit by what the cloud scattered,
    // a specular highlight is not, and a full-strength glint reading through
    // a cirrus sheet is what an orbital frame of it cannot do. Whichever read
    // set cloudSunKeep — straight down just above, or at the Sun-ray pierce
    // point with the cloud shadow's define compiled in — the cut is this one
    // line, and where no read happened the share is 1 and it subtracts nothing.
    outgoingLight -= seaGlint * (1.0 - cloudSunKeep);
    seaGlint *= cloudSunKeep;
  }
${CLOUD_SHADOW_DIFFUSE}${CLOUD_SHADOW_FILL}${CLOUD_LIGHT_DECK}  // The sine of the Sun's elevation at this fragment, off the perturbed normal:
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
      ? nightWeight(clampCosine(dot(up, normalize(uSunDirWorld)))) * nightKeep * uNightExposure
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
  float cloudNight = DECK_ON
      ? nightWeight(clampCosine(dot(up, normalize(uSunDirWorld)))) * nightKeep
      : 0.0;
  float moonNight = uAirDensity > 0.0
      ? moonUpWeight(clampCosine(dot(up, normalize(uMoonDirWorld))))
          * sunDownWeight(sunElevSin, uTermWidth) * nightKeep * uNightExposure
      : 0.0;
  // The authored starlight floor, and the sky's own ambient that stands in for
  // it where the tables are bound. They are combined with max() rather than
  // added: two models of one thing added together lift the fragment twice, and
  // switching the authored one off outright lets the tier with the tables come
  // out darker than the tier without them. With the air off the ambient is
  // exactly zero and the floor is the whole night side, unchanged.
  vec3 nightFloor = diffuseColor.rgb * uNightColor
      * (uNightStrength * (1.0 - dayFactor) * nightKeep * uNightExposure * ${NIGHT_FLOOR_FRACTION.toFixed(6)});
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
  // The reader's lift (Night sides: Brightened) joins the same max() only when
  // it is on: a dimmed copy of the surface in its own colours, albedo times a
  // neutral strength, night-weighted like the floor and killed with it in a
  // silhouette. Three models of "some light on the dark half", never added to
  // each other; at Real the branch is not taken and the pixel is byte for byte
  // what it was.
  vec3 nightLow = max(nightAmbient, nightFloor);
  if (uNightLift > 0.0) {
    nightLow = max(nightLow, diffuseColor.rgb * (uNightLift * (1.0 - dayFactor) * nightKeep));
  }
  outgoingLight += nightLow;
  // Planetshine: parent-lit glow on the night side. Albedo-multiplicative,
  // so the eclipse color-dim carries through it automatically.
  if (GROUND_ON(uPlanetshineIntensity > 0.0)) {
    float pl = max(dot(normalize(normal), normalize(vPlanetshineViewDir)), 0.0);
    outgoingLight += diffuseColor.rgb * uPlanetshineColor * (uPlanetshineIntensity * pl * (1.0 - dayFactor) * nightKeep * uNightExposure);
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
  if (GROUND_ON(uIcyRim > 0.5)) {
    float rim = pow(1.0 - max(dot(normalize(normal), normalize(vViewPosition)), 0.0), 3.0);
    float back = max(-dot(normalize(normal), normalize(vSunViewDir)), 0.0);
    float lit = max(diffuseColor.r, max(diffuseColor.g, diffuseColor.b));
    outgoingLight += vec3(0.55, 0.75, 1.0) * (rim * back * 0.55 * lit);
  }
  vec3 sd = normalize(uSunDirLocal);
  // Ring shadow on the globe: trace toward the Sun to the ring plane
  // (y = 0) and dim by the rings opacity where it lands.
  if (GROUND_ON(uRingOuter > 0.0 && abs(sd.y) > 1e-4)) {
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
  seaGlint *= sunVisible;
#ifdef SEA_SKY
  seaSky *= sunVisible;
#endif
  // Limb darkening: the disc dims toward its edge as the view ray grazes the
  // surface. mu = cos of the view angle — 1 at disc centre, 0 at the limb.
  // Applied last so it shades every lit term equally; 0 disables it. The beam
  // chain holds the water's mirror term out of it: a mirror does not darken
  // toward the limb, it brightens, and the air below is the real limb. Off,
  // the held share is exactly zero and the product is the one it was.
  if (GROUND_ON(uLimbDarkening > 0.0)) {
    float mu = max(dot(normalize(normal), normalize(vViewPosition)), 0.0);
#ifdef SEA_BEAM
    vec3 limbHeld = seaGlint;
#else
    vec3 limbHeld = vec3(0.0);
#endif
#ifdef SEA_SKY
    // A mirror of the sky brightens toward the limb as the beam does.
    limbHeld += seaSky;
#endif
    outgoingLight = (outgoingLight - limbHeld) * (1.0 - uLimbDarkening * (1.0 - mu)) + limbHeld;
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
  if (uAirDensity > 0.0${AIR_PROBE_GUARD}) {
    // Where the segment ends. A mesh whose own radius is the altitude it stands
    // for ends at its own fragment; the cloud deck names its altitude instead,
    // because its sphere is built at the globe's coarse segment count and the
    // chord sags kilometres below that radius between vertices. Same ray, same
    // direction, the radius substituted — and the whole substitution is one
    // uniform, so the injected text stays identical for every surface.
    vec3 airEnd = uAirLookupRadius > 0.0
        ? normalize(vAirFrag) * uAirLookupRadius
        : vAirFrag / uPlanetRadius;
    AerialSegment seg = aerialSegment(
        vAirCam / uPlanetRadius, airEnd, normalize(uSunDirWorld));
    if (seg.valid) {
      vec3 airT = aerialTransmittance(uTransmittance, seg);
      vec3 airS = aerialInscatter(uScattering, seg, airT)
          * uAirlightScale * (uSolarIrradiance * sunVisible);
${CLOUD_SHADOW_AIR_SCALE}      // The Moon lights the same column. One traversal, one transmittance: only
      // the two angles that involve the source change, so the second source is
      // a second pair of lookups and nothing else. Behind the Moon's own weight
      // and behind a uniform branch, so a day fragment, a new Moon and a body
      // with no moon at all cost a branch and no fetches.
      if (moonNight > 0.0 && uMoonIrradiance.g > 0.0) {
        airS += aerialInscatter(uScattering, aerialForLight(seg, normalize(uMoonDirWorld)), airT)
            * uMoonIrradiance * moonNight;
      }
      // The tables arrive a few seconds into a session, and the haze they
      // bring would otherwise switch on across the whole ground in one frame:
      // it fades in over a moment instead.
      float airWeight = uAirBlend * aerialHazeWeight(seg, uSurfaceHaze);
      outgoingLight = mix(outgoingLight, outgoingLight * airT + airS, airWeight);
      seaGlint = mix(seaGlint, seaGlint * airT, airWeight);
    }
  }
  // The beam's cap, on what REACHES THE CAMERA: everything above scaled the
  // mirror term along with the light, so seaGlint is now its share of this
  // pixel. A shoulder — the term itself up to the knee, then an exponential
  // approach to the cap, continuous in value and slope at the knee, per
  // channel — so a core past white is held just past it instead of flattened
  // to a plateau, and the bright pass is handed a bounded excess. Entered only
  // past the knee, where the held value differs from the term; below it the
  // two are equal and the exponential would be paid for nothing on nearly
  // every sea pixel. The old chain capped before the air and has no shoulder.
#ifdef SEA_BEAM
  if (any(greaterThan(seaGlint, vec3(${BEAM_KNEE_GLSL})))) {
    vec3 beamKnee = vec3(${BEAM_KNEE_GLSL});
    vec3 beamRange = vec3(${BEAM_CAP_GLSL}) - beamKnee;
    vec3 beamOver = max(seaGlint - beamKnee, vec3(0.0));
    vec3 beamHeld = min(seaGlint, beamKnee) + beamRange * (1.0 - exp(-beamOver / beamRange));
    outgoingLight -= seaGlint - beamHeld;
  }
#endif
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
  /** The ocean-gloss remap's gain, or 0 while this material's roughness map is
   *  not a water mask. Held here rather than on the material because the
   *  streamed sectors have to be told the same thing the globe was. */
  uWaterGloss: { value: number };
  /** How much of the close-range detail term this material is drawing, eased in
   *  wall time by whoever owns the body. Material-scoped, so a streamed sector
   *  has to be told the globe's value every frame or it holds a stale one. */
  uSynthEnvelope: { value: number };
  /** The relief height that term draws, or 0 while MEASURED relief is bound on
   *  this material. Grain is unconditional; relief is not. */
  uSynthRelief: { value: number };
  /** 1 while the relief bound on this material is itself invented — a painted
   *  crater bump — which makes the synthesized relief wait for that bump's own
   *  texels to stretch past a pixel instead of drawing on top of them. */
  uSynthBumpFade: { value: number };
  /** What relief this material was last told it carries. Held rather than read
   *  back off the two uniforms above: on a surface class that draws no relief
   *  at all the gain is zero whatever is bound, so a uniform read cannot tell a
   *  gas giant with nothing on it from a body wearing measured elevation. */
  relief: SurfaceReliefKind;
  /** What `uSynthRelief` goes back to when nothing else supplies relief — the
   *  archetype's own gain against the field's built geometry. */
  synthReliefGain: number;
  /** How much of the field's cratering this body wears (world/PlanetFactory's
   *  table). Held so a dependent material (a streamed sector) draws the same
   *  ground rather than defaulting to a cratered one. */
  uSynthCraterShare: { value: number };
  /** The body this material draws, as the close-range field's seed reads it.
   *  Held so a dependent material (a streamed sector) lands on the SAME ground
   *  as the globe under it rather than on a second patch of field. */
  seedName: string;
}
const augmentArgs = new WeakMap<THREE.Material, SurfaceShadingArgs>();

/** The augmentation a material received, or undefined for a plain one. */
export function surfaceShadingArgsOf(mat: THREE.Material): SurfaceShadingArgs | undefined {
  return augmentArgs.get(mat);
}

/** Whether this material is reading its roughness map as a water mask. */
export function surfaceWaterGloss(mat: THREE.Material): boolean {
  return (augmentArgs.get(mat)?.uWaterGloss.value ?? 0) > 0;
}

/** Read this material's roughness map as a water mask, or stop: `on` is only
 *  true for a map that really grades water against land (world/surfaceShading's
 *  ROUGHNESS_MAP_* pair), never for the flat stand-in a failed fetch leaves. */
export function setSurfaceWaterGloss(mat: THREE.Material, on: boolean): void {
  const args = augmentArgs.get(mat);
  if (!args) return;
  args.uWaterGloss.value = on ? waterGlossGain() : 0;
  // The first sea that really is one brings the wind map in. Every program
  // already carries the binding, on the stand-in, so this is a value.
  if (on) installSeaWind();
  if (import.meta.env.DEV) {
    if (on && !glossyMaterials.has(mat)) {
      glossyMaterials.add(mat);
      mat.addEventListener('dispose', () => glossyMaterials.delete(mat));
    } else if (!on) {
      glossyMaterials.delete(mat);
    }
  }
}

/**
 * The energy chain's two switches, any build, each a compile-time define on
 * EVERY augmented surface — the globes, their sectors, the decks, the moons, a
 * tool's surface and a warm-up probe alike, so the program a probe warms is the
 * program the body draws with. `SUN_PATH` (`?sunpath=0`): the Sun's own path
 * through the body's air on every surface's direct terms, so a low Sun lights
 * the ground, the sea and the cloud deck dimmer and redder, normalised to the
 * zenith so the subsolar picture is the one that was graded. `SEA_BEAM`
 * (`?seabeam=0`): the sea's beam chain — Beckmann's own shadowing on the sea's
 * Beckmann lobes, the mirror term held out of the limb darkening, its cap moved
 * after the air as a shoulder on what reaches the camera, and the sea's flag
 * for the bloom in the alpha — against the chain as it was, with the cap
 * before the air. Defines rather than uniforms because a uniform select
 * compiles both chains into one program and the ground pays for the beam's
 * terms whether or not it uses them (a fifth of a millisecond on its draw at
 * Earth's shell on an M5 Max); with the define off the preprocessor leaves the
 * old expressions and nothing else, so either kill switch is the program it
 * was. Set at boot from the URL before any surface is augmented; a flip later
 * (the DEV knob) relinks every live surface through three's program key.
 */
let sunPathEnabled = true;
let seaBeamEnabled = true;
/** `SEA_SKY` (`?seasky=0`): the sky reflected off the sea (SEA_SKY_GRAZING_COS), the same shape of switch. */
let seaSkyEnabled = true;
/** Every live augmented surface, so a flip can reach the materials already drawn. */
const beamReceivers = new Set<THREE.Material>();
function receiveBeamSwitches(mat: THREE.Material): void {
  if (!beamReceivers.has(mat)) {
    beamReceivers.add(mat);
    mat.addEventListener('dispose', () => beamReceivers.delete(mat));
  }
  applySwitchDefine(mat, 'SUN_PATH', sunPathEnabled);
  applySwitchDefine(mat, 'SEA_BEAM', seaBeamEnabled);
  applySwitchDefine(mat, 'SEA_SKY', seaSkyEnabled);
}
export function setSunPathEnabled(on: boolean): void {
  sunPathEnabled = on;
  for (const mat of beamReceivers) applySwitchDefine(mat, 'SUN_PATH', on);
}
export function setSeaBeamEnabled(on: boolean): void {
  seaBeamEnabled = on;
  for (const mat of beamReceivers) applySwitchDefine(mat, 'SEA_BEAM', on);
}
export function setSeaSkyEnabled(on: boolean): void {
  seaSkyEnabled = on;
  for (const mat of beamReceivers) applySwitchDefine(mat, 'SEA_SKY', on);
}
/** Whether every surface compiles the sky reflected off the sea right now. */
export function seaSkyOn(): boolean {
  return seaSkyEnabled;
}
/** The `?seasky=0` kill switch, on any build. */
export function parseSeaSkyParam(search: string): boolean {
  return new URLSearchParams(search).get('seasky') !== '0';
}
/** The beam's shoulder as the sea draws it this frame: the DEV knobs' values
 *  in a development build, the constants in production. The highlight meter
 *  reads it so its prediction follows a knob moved live. */
export function beamShoulderInForce(): { knee: number; cap: number } {
  if (import.meta.env.DEV) {
    return { knee: devGlintUniforms.uBeamKnee.value, cap: devGlintUniforms.uBeamCap.value };
  }
  return { knee: OCEAN_BEAM_KNEE, cap: OCEAN_BEAM_CAP };
}

/** Whether every surface compiles the Sun's path right now. */
export function sunPathOn(): boolean {
  return sunPathEnabled;
}
/** Whether every surface compiles the sea's beam chain right now. */
export function seaBeamOn(): boolean {
  return seaBeamEnabled;
}
/** `?sunpath=0`, any build: the Sun's light unattenuated by its path through
 *  the air again, in the house style of `?seawind=0`. */
export function parseSunPathParam(search: string): boolean {
  return new URLSearchParams(search).get('sunpath') !== '0';
}
/** `?seabeam=0`, any build: the sea's old chain, its cap before the air. */
export function parseSeaBeamParam(search: string): boolean {
  return new URLSearchParams(search).get('seabeam') !== '0';
}

/**
 * The wind map's uniforms (world/seaWind.ts), shared by every augmented
 * material the way the cloud deck's are: the map, and whether the sea reads
 * it (1) or is drawn at the one width uWaterGloss authors (0). Bound to the
 * 1x1 stand-in until the map has landed and a sea is confirmed; `?seawind=0`
 * and a DEV roughness override hold it at 0.
 */
export const seaWindUniforms: {
  uSeaWindMap: { value: THREE.Texture | null };
  uSeaWindOn: { value: number };
} = {
  uSeaWindMap: { value: null },
  uSeaWindOn: { value: 0 },
};
let seaWindEnabled = true;
let seaWindBound = false;

/** `?seawind=0`: the whole sea at OCEAN_ROUGHNESS, as before the wind map. */
export function setSeaWindEnabled(on: boolean): void {
  seaWindEnabled = on;
  applySeaWindOn();
}

/** Whether the sea is reading the wind map right now. */
export function seaWindOn(): boolean {
  return seaWindUniforms.uSeaWindOn.value > 0;
}

/** A sea confirmed: bind the map if it has landed (world/seaWind.ts); if
 *  not, the sea reads the one width until `rebindSeaWindMap` brings it. */
function installSeaWind(): void {
  rebindSeaWindMap();
}

/** The map landed — the shipped one, or a DEV `?seawindmap=` replacement
 *  (world/seaWind.ts installSeaWindMap): every sea already drawn reads it
 *  from the next frame, and one not yet confirmed finds it bound when it is. */
export function rebindSeaWindMap(): void {
  const map = seaWindTexture();
  if (map) {
    seaWindUniforms.uSeaWindMap.value = map;
    seaWindBound = true;
  }
  applySeaWindOn();
  disposeRetiredSeaWindMaps();
}

/** The map is read only with the switch on, the map bound, and no DEV override
 *  forcing one width on the whole sea. */
function applySeaWindOn(): void {
  seaWindUniforms.uSeaWindOn.value =
    seaWindEnabled && seaWindBound && devOceanRoughnessOverride === null ? 1 : 0;
}

/** The gain a water mask is read through with the map off: OCEAN_ROUGHNESS's,
 *  or in a development build whatever `setDevOceanRoughness` last asked for. */
function waterGlossGain(): number {
  return import.meta.env.DEV && devOceanRoughnessOverride !== null
    ? (ROUGHNESS_MAP_LAND - devOceanRoughnessOverride) / (ROUGHNESS_MAP_LAND - ROUGHNESS_MAP_WATER)
    : WATER_GLOSS_GAIN;
}
let devOceanRoughnessOverride: number | null = null;
/** Every material currently reading its map as a water mask, so a live
 *  roughness change reaches the sea already on screen and not only the next
 *  sector to arrive. Development builds only; a disposed material leaves. */
const glossyMaterials = new Set<THREE.Material>();

/** Draw the whole sea at this one GGX roughness from now on, the wind map set
 *  aside, on every sea already drawn and every one still to come
 *  (`__moon.glint`); null hands the sea back to the map. Returns the override
 *  in force, null for the map. Development only. */
export function setDevOceanRoughness(roughness?: number | null): number | null {
  if (!import.meta.env.DEV) return null;
  if (roughness === undefined) return devOceanRoughnessOverride;
  devOceanRoughnessOverride = roughness;
  for (const mat of glossyMaterials) {
    const args = augmentArgs.get(mat);
    if (args && args.uWaterGloss.value > 0) args.uWaterGloss.value = waterGlossGain();
  }
  applySeaWindOn();
  return devOceanRoughnessOverride;
}

/**
 * Point the sea's cloud cut at a black deck: no cloud over any sea, so the
 * glint reads as under a clear sky, until the deck's own map is written again
 * (PlanetariumMode writes it every frame the clouds are shown, and skips the
 * write while they are hidden). The clear-sky arm of a glint measurement.
 */
export function holdSeaCloudCut(): void {
  cloudShadowUniforms.uCloudShadowMap.value = surfaceAirDummies().map2D;
}

/**
 * Where a body reads the tiling detail field. The field is periodic, so an
 * offset is free and cannot break the wrap; two coprime moduli keep names that
 * hash close together from landing on one line of the tile.
 */
function synthSeedOffset(name: string): THREE.Vector2 {
  const seed = gpuSeed(name);
  return new THREE.Vector2((seed % 977) / 977, (Math.floor(seed / 977) % 613) / 613);
}

/**
 * What kind of relief a material already carries, which is what decides whether
 * a synthesized one may be drawn under it at all:
 *
 *   - `measured` — a real surface: an elevation-derived normal map, an
 *     elevation bump, a photograph's own luminance read as one, or a sector's
 *     crop of any of those. Synthesized relief NEVER joins it. Two sets of
 *     craters under one Sun is what a doubled relief looks like, and where the
 *     first set is real the second one is an invention laid over a measurement.
 *   - `painted` — a crater bump the app itself invented for a moon with no
 *     measured surface to draw. Synthesized relief replaces it as it runs out
 *     of resolution: the fiction stays one fiction, at the scale the eye is
 *     actually looking at.
 *   - `none` — nothing bound, so the synthesized relief is the only relief.
 */
export type SurfaceReliefKind = 'measured' | 'painted' | 'none';

/** Which of the three this material carries. A texture says for itself whether
 *  it was painted rather than measured (`proceduralRelief` in its userData);
 *  anything else bound as relief is treated as a real surface, because the
 *  expensive mistake is to emboss invented craters over a measured one. */
export function surfaceReliefKind(mat: THREE.Material): SurfaceReliefKind {
  // A body whose measured surface is on its way counts as wearing it already.
  // The map is requested at load and bound whenever the fetch lands, and in
  // between there is nothing bound at all: read literally, this surface would
  // be given a full invented relief for those seconds and then have it taken
  // away the frame the real one arrives — a step, on the one body class that
  // is never allowed one, and on a streamed sector cut before the map landed it
  // would be a rectangle of invented craters beside measured ones.
  if ((mat.userData as { hasRealNormal?: boolean } | undefined)?.hasRealNormal === true) {
    return 'measured';
  }
  const standard = mat as Partial<THREE.MeshStandardMaterial>;
  const relief = standard.normalMap ?? standard.bumpMap ?? null;
  if (!relief) return 'none';
  return relief.userData?.proceduralRelief === true ? 'painted' : 'measured';
}

/** How much of the field's cratering this material draws. */
export function surfaceCraterShare(mat: THREE.Material): number {
  return augmentArgs.get(mat)?.uSynthCraterShare.value ?? 1;
}

/** Tell a material how much of the field's cratering its body wears. Set once,
 *  from the body's own entry: a surface does not become resurfaced mid-flight. */
export function setSurfaceCraterShare(mat: THREE.Material, share: number): void {
  const args = augmentArgs.get(mat);
  if (args) args.uSynthCraterShare.value = Math.min(1, Math.max(0, share));
}

/**
 * Set how much of the close-range detail term a material draws this frame:
 * `envelope` is the eased 0..1 the owner is holding, and `relief` is what this
 * material already carries. Grain is drawn whatever is bound; synthesized
 * relief is held off entirely under a measured surface, and under a painted one
 * it waits, per fragment, for that painting's own texels to stretch past a
 * pixel.
 *
 * A material with no augmentation (a plain mesh, a shell that is not a surface)
 * simply has nothing to set.
 *
 * A surface class the term is authored to nothing for — a gas giant with no
 * ground to grain, Earth's mostly-ocean globe, the cloud deck — is held at zero
 * however magnified it gets. Its envelope would otherwise ease to one on every
 * close approach and every fragment would take four derivatives, the chart
 * weights and up to six fetches of the 1×1 stand-in to multiply the surface by
 * exactly one. The density record is untouched: the probe still labels a sheet
 * of a body whose term is off, which is the arm every sheet is judged against.
 */
export function setSurfaceSynthesis(
  mat: THREE.Material,
  envelope: number,
  relief: SurfaceReliefKind,
): void {
  const args = augmentArgs.get(mat);
  if (!args) return;
  const drawsNothing = SYNTH_GRAIN[args.archetype] === 0 && args.synthReliefGain === 0;
  args.uSynthEnvelope.value = drawsNothing ? 0 : envelope;
  args.uSynthRelief.value = relief === 'measured' ? 0 : args.synthReliefGain;
  args.uSynthBumpFade.value = relief === 'painted' ? 1 : 0;
  args.relief = relief;
}

/** How much of the term this material is drawing, on its own — read once per
 *  live sector per frame, so it allocates nothing. */
export function surfaceSynthesisEnvelope(mat: THREE.Material): number {
  return augmentArgs.get(mat)?.uSynthEnvelope.value ?? 0;
}

/** How much of the term this material is drawing, and what its relief is doing
 *  — what a dependent material (a streamed sector) mirrors. */
export function surfaceSynthesisOf(
  mat: THREE.Material,
): { envelope: number; relief: SurfaceReliefKind } | undefined {
  const args = augmentArgs.get(mat);
  if (!args) return undefined;
  return { envelope: args.uSynthEnvelope.value, relief: args.relief };
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
    // 0 → 1 over SURFACE_AIR_FADE_S after the tables bind; the haze is scaled by it.
    uAirBlend: { value: 0 },
    uSurfaceHaze: { value: 1 },
    // The albedo's contrast grade (world/surfaceLook.ts): gain and pivot. A
    // fresh block is the map as it is; seatSurfaceLook writes a body's own.
    uAlbedoContrast: { value: new THREE.Vector2(1, DEFAULT_ALBEDO_PIVOT) },
    uPlanetRadius: { value: 1 },
    uSolarIrradiance: { value: 1 },
    uAirlightScale: { value: new THREE.Vector3(...AIRLIGHT_SCALE) },
    // The night's second source. It lives here, with the air, because every
    // surface that draws this body has to be lit by the same Moon as the shell
    // around it — and because the mode writes it once per body per frame.
    uMoonDirWorld: { value: new THREE.Vector3(0, 0, 1) },
    uMoonIrradiance: { value: new THREE.Vector3() },
    // The camera's exposure for the night side (world/nightExposure): 1, the
    // authored level, until the mode meters the body. Here for the same
    // reason as the Moon — the globe, its sectors, the deck and the shell take
    // one exposure. A block nothing meters, a studio's or a tool's, stays at 1.
    uNightExposure: { value: 1 },
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
  air.uMieColour.value = dummies.map3D;
  return air;
}

/**
 * Seat a body's surface radius on its air uniforms the moment they exist —
 * world AU, the units the vertex stage hands over. bindSurfaceAir states it
 * again when the tables bind, and until this existed that was the ONLY
 * writer: every air lookup is gated on the density, so the default of 1 cost
 * nothing there. The cloud deck's detail bump is not gated. It turns the
 * relief's fraction of the radius back into kilometres by multiplying with
 * this uniform wherever the deck is magnified, and read the default as a
 * radius of one AU: 70,000 km of relief where 3 were authored, normals
 * pointing anywhere, clouds drawn black — on every device whose atmosphere
 * bake is unavailable (a software renderer, a slow device), and in the
 * moments before the bake lands on the rest.
 */
export function seatSurfaceAirRadius(air: SurfaceAirFx, planetRadius: number): void {
  air.uPlanetRadius.value = planetRadius;
}

/**
 * Write a body's albedo contrast grade (world/surfaceLook.ts) into its air
 * block: the gain and the pivot the shader's `albedoContrast` reads. Seated
 * when the surface is augmented, and again every frame by the mode, so a
 * switch moved live reaches the globe, its sectors and anything else sharing
 * the block on the next draw. A body the look table does not name is left as
 * it is — the gain of 1 the block was made with, which is the map exactly.
 */
export function seatSurfaceLook(air: SurfaceAirFx, body: string): void {
  const look = surfaceLookOf(body);
  if (!look) return;
  (air.uAlbedoContrast.value as THREE.Vector2).set(look.contrast, look.contrastPivot);
}

/**
 * Point a body's surfaces at its finished tables and switch the air on.
 * `planetRadius` is the surface radius in the same units the vertex stage hands
 * over (world AU), because that is what the lookup divides by to reach the
 * radius units the tables are baked in; seatSurfaceAirRadius seated the same
 * number when the body was built, for the reader that never waits for tables.
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
  air.uMieColour.value = tables.mieColour;
  air.uIrradiance.value = tables.irradiance;
  air.uPlanetRadius.value = planetRadius;
  air.uSolarIrradiance.value = solarIrradiance;
  // The body's grade on its own haze (SURFACE_HAZE_CLEAR_VIEW). Its own
  // uniform, apart from the loading fade: the fade also drives the shell's
  // crossfade, and a grade folded into it would leave the shell stuck part
  // way between its tiers.
  // The DEV pin on every body first, then the body's own switch or table
  // entry (world/surfaceLook.ts), then this file's grade, then the physics.
  air.uSurfaceHaze.value = (import.meta.env.DEV ? devSurfaceHaze : undefined)
    ?? surfaceLookOf(tables.body)?.haze
    ?? SURFACE_HAZE_CLEAR_VIEW[tables.body] ?? 1;
  // Switching on starts the fade; a rebind of live air leaves it where it is.
  if (air.uAirDensity.value === 0) air.uAirBlend.value = 0;
  air.uAirDensity.value = 1;
}

/** How long a body's haze takes to fade in once its tables bind. */
export const SURFACE_AIR_FADE_S = 1.2;

/** Advance a body's haze fade by one frame; a no-op once the air is fully on
 *  or while it is off. */
export function advanceSurfaceAir(air: SurfaceAirFx, dtS: number): void {
  if (air.uAirDensity.value === 0 || air.uAirBlend.value >= 1) return;
  air.uAirBlend.value = Math.min(1, air.uAirBlend.value + Math.max(0, dtS) / SURFACE_AIR_FADE_S);
}

/** Finish a body's haze fade at once. For the dev pin that flips the tier for
 *  an A/B: a golden pair wants the steady state of each tier, not a frame from
 *  the transition between them. */
export function settleSurfaceAir(air: SurfaceAirFx): void {
  if (air.uAirDensity.value === 0) return;
  air.uAirBlend.value = 1;
}

/** Switch the air off and let go of the tables: a lost context frees their
 *  textures, and a sampler still pointed at one is a bind of a dead name. */
export function clearSurfaceAir(air: SurfaceAirFx): void {
  const dummies = surfaceAirDummies();
  if (air.uAirDensity.value === 0 && air.uScattering.value === dummies.map3D
    && air.uMieColour.value === dummies.map3D) return;
  air.uAirDensity.value = 0;
  air.uAirBlend.value = 0;
  air.uTransmittance.value = dummies.map2D;
  air.uIrradiance.value = dummies.map2D;
  air.uScattering.value = dummies.map3D;
  air.uMieColour.value = dummies.map3D;
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
  /** The body's name, which is the close-range detail field's seed. Two bodies
   *  wear different ground and one body wears the same ground every session.
   *  Empty for a surface nobody looks at (a warm-up probe, a compare filler). */
  seedName = '',
): SurfaceShadingFx {
  const night = NIGHT_FILL[archetype];

  // Created up front so the mode can update these refs even before the material
  // lazily compiles; onBeforeCompile assigns the same objects into the shader.
  // A shared set is reused whole — a streamed sector must not build (and throw
  // away) the caster slots its globe already owns.
  const fx: SurfaceShadingFx = shared ?? {
    uSunDirWorld: { value: new THREE.Vector3(1, 0, 0) },
    uSunDirLocal: { value: new THREE.Vector3(1, 0, 0) },
    uMoonShadow: { value: Array.from({ length: MAX_MOON_SHADOWS }, () => new THREE.Vector4()) },
    uMoonShadowCount: { value: 0 },
    uPlanetshineColor: { value: new THREE.Color(0x6688aa) },
    uPlanetshineDir: { value: new THREE.Vector3(1, 0, 0) },
    uPlanetshineIntensity: { value: 0 },
    uSilhouette: { value: 0 },
    uNightLift: { value: 0 },
    uCloudAbove: { value: 0 },
    air: createSurfaceAirFx(),
  };
  const uFrameSpin = sharedSpin ?? { value: 0 };
  // The body's own grade on its albedo, if the look table names it; a shared
  // block already carries it, and the write is the same value again.
  if (seedName) seatSurfaceLook(fx.air, seedName);
  // Off until whoever owns the roughness map says it really is a water mask:
  // the flat mid-grey stand-in a failed fetch leaves behind is not one, and
  // remapping it would put an ocean's sheen on the whole planet.
  const uWaterGloss = { value: 0 };
  // Off until the body's owner says this surface is magnified past the band and
  // eases it in. Nothing is ever stepped on: at zero the term costs a uniform
  // branch and no fetch.
  const uSynthEnvelope = { value: 0 };
  const synthReliefGain = SYNTH_RELIEF_GAIN[archetype] > 0
    ? SYNTH_RELIEF_GAIN[archetype] * surfaceDetailHeightSpan()
    : 0;
  const uSynthRelief = { value: synthReliefGain };
  const uSynthBumpFade = { value: 0 };
  // Every body wears the whole field until its owner says otherwise: a moon
  // whose surface is resurfaced is the exception, not the rule.
  const uSynthCraterShare = { value: 1 };
  augmentArgs.set(mat, {
    archetype, ringShadow, sunTan, fx, uFrameSpin, uWaterGloss,
    uSynthEnvelope, uSynthRelief, uSynthBumpFade, uSynthCraterShare,
    relief: 'none', synthReliefGain, seedName,
  });
  receiveBeamSwitches(mat);
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
  const uSynthGrain = { value: SYNTH_GRAIN[archetype] };
  // The one shared field, or the same 1x1 stand-in the air's samplers take on a
  // surface class that never fades the term in — sampling it is never legal,
  // because uSynthEnvelope is then held at zero.
  const uSynthDetail = {
    value: SYNTH_GRAIN[archetype] > 0 || SYNTH_RELIEF_GAIN[archetype] > 0
      ? surfaceDetailTexture() as THREE.Texture
      : surfaceAirDummies().map2D as THREE.Texture,
  };
  // Where this body reads the tiling field. One offset per body, so two moons
  // wear different ground; the field is periodic, so an offset costs nothing
  // and cannot break the wrap. The caller supplies it (the body's name, hashed)
  // — a body must not change face between sessions.
  const uSynthSeed = { value: synthSeedOffset(seedName) };
  // The zero the grain is read against — the built field's own mean, so the
  // term adds no light of its own. Zero on a surface class that never draws it,
  // where the field is not even bound.
  const uSynthMid = {
    value: SYNTH_GRAIN[archetype] > 0 || SYNTH_RELIEF_GAIN[archetype] > 0
      ? surfaceDetailFieldMean()
      : 0,
  };

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSunDirWorld = fx.uSunDirWorld;
    shader.uniforms.uSunDirLocal = fx.uSunDirLocal;
    shader.uniforms.uMoonShadow = fx.uMoonShadow;
    shader.uniforms.uMoonShadowCount = fx.uMoonShadowCount;
    shader.uniforms.uNightColor = uNightColor;
    shader.uniforms.uNightStrength = uNightStrength;
    shader.uniforms.uNightLift = fx.uNightLift;
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
    shader.uniforms.uWaterGloss = uWaterGloss;
    shader.uniforms.uSeaMix = seaColourUniforms.uSeaMix;
    // A surface with no water mask never samples this, but every program
    // still carries the binding: the injected text is byte-identical for
    // every body, which is what keeps them sharing one compiled program.
    if (!cloudShadowUniforms.uCloudShadowMap.value) {
      cloudShadowUniforms.uCloudShadowMap.value = surfaceAirDummies().map2D;
    }
    shader.uniforms.uCloudShadowMap = cloudShadowUniforms.uCloudShadowMap;
    shader.uniforms.uCloudShadowSpin = cloudShadowUniforms.uCloudShadowSpin;
    shader.uniforms.uCloudShadowTurn = cloudShadowUniforms.uCloudShadowTurn;
    // The wind map the same way: the stand-in until it has landed and a sea
    // is confirmed, and a shared uniform so the globe and every streamed
    // sector read one sea.
    if (!seaWindUniforms.uSeaWindMap.value) {
      seaWindUniforms.uSeaWindMap.value = surfaceAirDummies().map2D;
    }
    shader.uniforms.uSeaWindMap = seaWindUniforms.uSeaWindMap;
    shader.uniforms.uSeaWindOn = seaWindUniforms.uSeaWindOn;
    shader.uniforms.uCloudDeck = uCloudDeck;
    shader.uniforms.uCloudDetail = uCloudDetail;
    shader.uniforms.uCloudAlbedo = uCloudAlbedo;
    shader.uniforms.uCloudDetailErode = uCloudDetailErode;
    shader.uniforms.uCloudCityGlow = uCloudCityGlow;
    shader.uniforms.uCloudDetailRelief = uCloudDetailRelief;
    // The efficiency A/B switches, shared objects so a flip reaches the globe,
    // its streamed sectors and the deck in one frame. Absent from a production
    // build along with the second path each of them selects.
    if (import.meta.env.DEV) {
      shader.uniforms.uPerfCloudTaps = perfSwitchUniform('cloud-taps');
      shader.uniforms.uPerfCloudClear = perfSwitchUniform('cloud-clear');
      shader.uniforms.uPerfGlintGate = perfSwitchUniform('glint-gate');
      shader.uniforms.uPerfCloudNoiseFrame = perfSwitchUniform('cloud-noise-frame');
      shader.uniforms.uProbeCloudSmooth = perfSwitchUniform('cloud-probe-smooth');
      shader.uniforms.uProbeCloudDetail = perfSwitchUniform('cloud-probe-detail');
      shader.uniforms.uProbeCloudRelief = perfSwitchUniform('cloud-probe-relief');
      shader.uniforms.uProbeCloudAir = perfSwitchUniform('cloud-probe-air');
      shader.uniforms.uGlintCap = devGlintUniforms.uGlintCap;
      shader.uniforms.uGlintKeep = devGlintUniforms.uGlintKeep;
      shader.uniforms.uBeamKnee = devGlintUniforms.uBeamKnee;
      shader.uniforms.uBeamCap = devGlintUniforms.uBeamCap;
      shader.uniforms.uSeaColour = devGlintUniforms.uSeaColour;
      shader.uniforms.uSeaSky = devGlintUniforms.uSeaSky;
    }
    shader.uniforms.uFrameSpin = uFrameSpin;
    shader.uniforms.uSynthDetail = uSynthDetail;
    shader.uniforms.uSynthGrain = uSynthGrain;
    shader.uniforms.uSynthRelief = uSynthRelief;
    shader.uniforms.uSynthBumpFade = uSynthBumpFade;
    shader.uniforms.uSynthEnvelope = uSynthEnvelope;
    shader.uniforms.uSynthSeed = uSynthSeed;
    shader.uniforms.uSynthMid = uSynthMid;
    shader.uniforms.uSynthCraterShare = uSynthCraterShare;
    // Cloud shadows' slots: read only by a program compiled with CLOUD_SHADOW.
    shader.uniforms.uCloudAbove = fx.uCloudAbove;
    shader.uniforms.uCloudHeightOverRadius = cloudShadowShared.uCloudHeightOverRadius;
    if (import.meta.env.DEV) {
      shader.uniforms.uCloudShadowDepth = cloudShadowShared.uCloudShadowDepth;
      shader.uniforms.uCloudShadowAir = cloudShadowShared.uCloudShadowAir;
      shader.uniforms.uCloudShadowPenumbra = cloudShadowShared.uCloudShadowPenumbra;
      shader.uniforms.uCloudShadowGamma = cloudShadowShared.uCloudShadowGamma;
      shader.uniforms.uCloudLightWrap = cloudLightShared.uCloudLightWrap;
      shader.uniforms.uCloudLightSky = cloudLightShared.uCloudLightSky;
      shader.uniforms.uCloudShadowSkyFill = cloudShadowShared.uCloudShadowSkyFill;
    }
    for (const name of Object.keys(fx.air)) shader.uniforms[name] = fx.air[name];
    // The cloud field's slots (world/cloudFieldSlots), on the materials that
    // compile it: the planetarium's deck and its warm-up probe, and the ground
    // under the deck while its shadow reads the field. A ground takes them
    // whether or not it compiles the define right now: three keeps the
    // uniforms of a material's LAST new program, and a program the live shadow
    // switch returns to is found in the material's cache, not built again.
    if (mat.defines?.CLOUD_FIELD !== undefined || (cloudFieldOn() && cloudShadowReceivers.has(mat))) {
      const field = cloudFieldUniforms();
      shader.uniforms.uCloudPages = field.uCloudPages;
      shader.uniforms.uCloudPageTable = field.uCloudPageTable;
      shader.uniforms.uCloudFieldPixelScale = field.uCloudFieldPixelScale;
      if (import.meta.env.DEV) shader.uniforms.uCloudFieldDiag = cloudFieldDiagUniform;
    }

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>${SURFACE_VERTEX_DECLS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>${SURFACE_VERTEX_BODY}`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>${SURFACE_FRAGMENT_DECLS}${ALBEDO_CONTRAST_GLSL}`)
      .replace('#include <map_fragment>', SURFACE_MAP_FRAGMENT)
      .replace('#include <roughnessmap_fragment>', `${roughnessChunk()}${WATER_GLOSS_GLSL}`)
      .replace('#include <normal_fragment_maps>', `${SURFACE_NORMAL_MAPS}${SURFACE_NORMAL_BODY}`)
      .replace('#include <opaque_fragment>', `${SURFACE_FRAGMENT_BODY}\n#include <opaque_fragment>${SEA_BLOOM_FLAG_GLSL}`);
  };
  // The table dimensions are #defines, and a define is part of three's program
  // cache key — so every augmented material carries the same set, whether or
  // not its body has any air. Split them per body and the cache forks per body;
  // omit them and the injected lookup does not compile at all.
  // The deck's archetype is a define (SURFACE_ARCHETYPE_MACROS): the one
  // surface whose program is already its own. Read once, here — a define is
  // part of the program key, so a switch that moved mid-session would relink.
  const deckProgram = archetype === 'cloud' && (import.meta.env.DEV ? perfSwitchOn('cloud-program') : true);
  mat.defines = {
    ...mat.defines,
    ...atmosphereTableDefines(atmosphereSessionSizes()),
    ...(deckProgram ? { CLOUD_DECK: '' } : {}),
  };
  // A sector re-augmented from a globe a deck stands over shares that globe's
  // fx, and takes the cloud shadow's define with it (setGroundUnderCloudDeck).
  if (archetype !== 'cloud' && groundsUnderDeck.has(fx)) receiveCloudShadow(mat);
  mat.needsUpdate = true;
  return fx;
}
