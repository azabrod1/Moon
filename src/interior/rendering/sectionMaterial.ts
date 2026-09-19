/**
 * The section-face material for the Look-inside tool: a MeshStandardMaterial
 * whose albedo, roughness, metalness, emission and normal are decided per
 * pixel from the radial region the pixel falls in, injected through
 * onBeforeCompile so the faces take the same PBR lighting as the skin (plan
 * §5, path (a)), and reflect the studio environment the scene hands the
 * material as its envMap — that reflection is what makes liquid iron and
 * metallic hydrogen read as metal rather than paint.
 *
 * The face geometry is a unit half-disc in its own XY plane; the vertex
 * stage hands the fragment its local XY (radius in DISPLAY space, 0..1) and
 * its world position. Region boundaries arrive in display space (the mode
 * runs the Readable remap on the CPU), inside-out and increasing, up to
 * MAX_REGIONS of them, each with a blend half-width: a sharp boundary is
 * antialiased over one `fwidth` band, a physical transition blends over its
 * own width. The regions blend outside-in, so the loop is branch-free and a
 * thin crust is never lost to a texel.
 *
 * The face is a plane, drawn as a diagram of a solid. Within a region it
 * darkens from top to bottom by the region's depthGradient; a sharp
 * boundary carries a hairline (one pixel, a little darker, the way a
 * drawing marks a contact) where a gradual one carries none, its blend
 * being its own edge; and a crease shadow darkens the hinge where the two
 * faces meet at a right angle, gone at Section where they are one plane.
 * Nothing bevels, glows or overhangs: a lip and a rim on every boundary made
 * the section read as a turned bowl, and a section is a cut.
 *
 * Patterns are 3-D fields in BODY space (the world position turned by the
 * inverse of the body's pose), so a face shows a coherent slice of a solid
 * — orbit the camera or spin the body and the grain, swirl or banding stays
 * fixed to the material, never painted on the face. Jupiter's banding is
 * cylindrical about the spin axis, as deep zonal flows are, and fades
 * inward through its region. One noise feeds everything (the Sun's,
 * shared/shaders/sun.ts). Motion runs on the tool's presentation clock,
 * never the solar-system clock.
 *
 * Heat is the fourth channel, and it is the local temperature's. Each
 * region hands the shader its temperature as knots (temperatureProfile:
 * TEMPERATURE_KNOTS values at even depth fractions through the shared
 * sampler), and at every pixel the face reads the temperature there
 * (sectionTempK) and computes its incandescence from it — the same forge
 * ramp and strength artParams.incandescence gives a swatch, transcribed to
 * GLSL and held to the TypeScript by sectionMaterial.test.ts — through the
 * family's heat tint and gain, grained by the pattern (lava glows in its
 * fissures, a crystalline core in its facets), and added as emission. So a
 * mantle glows brighter toward its base because it IS hotter there, and a
 * boundary where the model's temperature is continuous carries no step in
 * the glow: the Materials view and the Temperature view read one
 * temperature (plan F22). What is art stays apart from it: the tint, the
 * gain, and the lift on the body's hottest region toward its bottom
 * (INCANDESCENCE_HOTTEST_BOOST), which is exposure, so a core bleeds past
 * the bloom threshold and a mantle keeps its colour. A self-lit region (a
 * star's plasma) has no albedo at all: its patterned palette is its
 * emission, at a radiance from the local temperature's place between the
 * body's coolest and hottest self-lit temperatures.
 *
 * Emphasis is uniform-driven (plan §4): uEmphasis names a region and
 * uEmphasisAmount eases in. The named region's boundaries take a light
 * outline, a couple of screen pixels wide at any zoom, and its self-lit
 * floor lifts a little; nothing else changes — dimming the rest made a
 * pinned crust grey out almost the whole interior, and the outline is enough
 * to say where the eye should go. Nothing extrudes and nothing recompiles.
 *
 * Temperature mode (plan §5, uDisplayMode 1) is a diagram: the face is
 * unlit (no diffuse, no specular — metalness 1 over a black albedo leaves
 * nothing for the studio to light — emissive only) and its colour is the
 * body's temperature scale at the temperature sampled at that pixel, from
 * the same knots the glow reads; the depth fraction is the same in display
 * and physical space because the Readable remap is linear within a region.
 * The scale's six stops are mixed in sRGB, as the legend's gradient and the
 * swatches mix them, and linearised after, so the face is the swatch through
 * the output path rendering/outputTransform.ts states. An unknown
 * temperature is a screen-space hatch, never the coldest colour, and so is
 * every temperature when the body has no scale; emphasis there is the
 * outline alone.
 *
 * Uncertainty of a boundary's location (plan §6) is a faint hatched band
 * straddling it, sized from the knowledge record, in both modes: where the
 * line might be is a fact about our knowledge, not a physical transition,
 * so it never widens the composition blend — a boundary the model calls
 * sharp stays sharp under the band, and a distributed transition stays the
 * blend it already is, so the treatments compose.
 *
 * Injection points, in the order meshphysical.glsl.js runs them:
 *   after <color_fragment>        the region resolve → diffuseColor.rgb
 *   after <roughnessmap_fragment> roughnessFactor
 *   after <metalnessmap_fragment> metalnessFactor
 *   after <normal_fragment_maps>  a small derivative bump from the pattern
 *   after <emissivemap_fragment>  totalEmissiveRadiance: ambient floor + glow
 */
import * as THREE from 'three';
import { sunNoiseGLSL } from '../../shared/shaders/sun';
import {
  DRAPER_POINT_K,
  FORGE_STOPS,
  INCANDESCENCE_FULL_K,
  INCANDESCENCE_HOTTEST_BOOST,
  INCANDESCENCE_HOT_BOOST,
  INCANDESCENCE_HOT_DECADES,
  INCANDESCENCE_HOT_K,
  INCANDESCENCE_PEAK,
  PATTERN_INDEX,
  type ArtParams,
} from '../data/artParams';
import { LINEAR_SPAN_FLOOR_K, TEMPERATURE_SCALE_STOPS, type TemperatureRange } from '../temperatureScale';
import { TEMPERATURE_KNOTS } from '../temperatureProfile';
import { MAX_REGIONS } from '../data/interiorTypes';
import { DIAGRAM_EXPOSURE } from './outputTransform';

export { MAX_REGIONS };

/** A region's knots packed four to a vec4: the uniform slots a float array would spend one knot each. */
export const KNOT_VEC4S = Math.ceil(TEMPERATURE_KNOTS / 4);

export interface SectionUniforms {
  /** Outer radius of region k in display space, inside-out, increasing; the last used one is 1. */
  uOuter: { value: number[] };
  /** Blend half-width, display space, of the boundary at region k's outer radius (0 = sharp). */
  uBlend: { value: number[] };
  uColorA: { value: THREE.Color[] };
  uColorB: { value: THREE.Color[] };
  uRough: { value: number[] };
  uMetal: { value: number[] };
  uGlow: { value: number[] };
  uPattern: { value: number[] };
  uMotion: { value: number[] };
  uScale: { value: number[] };
  uRelief: { value: number[] };
  uDepthGrad: { value: number[] };
  uAmbient: { value: number[] };
  /** A lit region's multiplier on the incandescence the shader computes from its local
   *  temperature: the family's heat tint (linear) by its gain. A self-lit region's is its
   *  gain alone, on the radiance its local temperature earns it. */
  uHeat: { value: THREE.Vector3[] };
  /** 1 for a region that is a light (a star's plasma): no albedo, its palette is its emission. */
  uSelfLit: { value: number[] };
  /** A self-lit region's place in the body's heat, 0 at the coolest zone to 1 at the hottest:
   *  the regime its pattern draws (granules, cells, a still depth). */
  uHeatLevel: { value: number[] };
  /** The coolest self-lit temperature, K, and the log of the hottest over it: the local
   *  temperature's place between them sets a self-lit pixel's radiance. */
  uSelfLitCoolK: { value: number };
  uSelfLitSpanLog: { value: number };
  /** The lift on the body's hottest region's heat at its bottom (1 elsewhere), graded by depth. */
  uHeatBoost: { value: number[] };
  uCount: { value: number };
  /** World → body-space rotation (the inverse of the body's pose). */
  uWorldToBody: { value: THREE.Matrix3 };
  /** Presentation seconds. */
  uTime: { value: number };
  /** 0..1, how much of a crease the hinge is: 1 closed-ish, 0 at Section. */
  uCorner: { value: number };
  /** The emphasised region's inside-out index, or −1 for none. */
  uEmphasis: { value: number };
  /** 0..1, how far the emphasis has eased in. */
  uEmphasisAmount: { value: number };
  /** 0 composition, 1 temperature. */
  uDisplayMode: { value: number };
  /** Region k's temperature at TEMPERATURE_KNOTS even depth fractions, top to bottom, K,
   *  packed four to a vec4 (KNOT_VEC4S per region); 1 K where unknown, so a log is safe. */
  uTempKnot: { value: THREE.Vector4[] };
  /** 1 when region k's knots are mixed on a log; 1 when its temperature is known at all. */
  uTempLog: { value: number[] };
  uTempKnown: { value: number[] };
  /** The body's scale, K (1 = logarithmic; 1 when there is one), and its six sRGB stops. */
  uScaleMin: { value: number };
  uScaleMax: { value: number };
  uScaleLog: { value: number };
  uScaleKnown: { value: number };
  uScaleStops: { value: THREE.Vector3[] };
  /** The uncertainty band straddling region k's outer boundary, display radii; equal = none. */
  uBandLow: { value: number[] };
  uBandHigh: { value: number[] };
}

export function createSectionUniforms(): SectionUniforms {
  const numbers = () => Array.from({ length: MAX_REGIONS }, () => 0);
  const colors = () => Array.from({ length: MAX_REGIONS }, () => new THREE.Color(0x000000));
  return {
    uOuter: { value: numbers().map((_, index) => (index + 1) / MAX_REGIONS) },
    uBlend: { value: numbers() },
    uColorA: { value: colors() },
    uColorB: { value: colors() },
    uRough: { value: numbers().map(() => 1) },
    uMetal: { value: numbers() },
    uGlow: { value: numbers() },
    uPattern: { value: numbers() },
    uMotion: { value: numbers() },
    uScale: { value: numbers().map(() => 1) },
    uRelief: { value: numbers() },
    uDepthGrad: { value: numbers() },
    uAmbient: { value: numbers() },
    uHeat: { value: Array.from({ length: MAX_REGIONS }, () => new THREE.Vector3()) },
    uSelfLit: { value: numbers() },
    uHeatLevel: { value: numbers() },
    uSelfLitCoolK: { value: 1 },
    uSelfLitSpanLog: { value: 0 },
    uHeatBoost: { value: numbers().map(() => 1) },
    uCount: { value: 1 },
    uWorldToBody: { value: new THREE.Matrix3() },
    uTime: { value: 0 },
    uCorner: { value: 0 },
    uEmphasis: { value: -1 },
    uEmphasisAmount: { value: 0 },
    uDisplayMode: { value: 0 },
    uTempKnot: { value: Array.from({ length: MAX_REGIONS * KNOT_VEC4S }, () => new THREE.Vector4(1, 1, 1, 1)) },
    uTempLog: { value: numbers() },
    uTempKnown: { value: numbers() },
    uScaleMin: { value: 0 },
    uScaleMax: { value: 1 },
    uScaleLog: { value: 0 },
    uScaleKnown: { value: 0 },
    uScaleStops: { value: TEMPERATURE_SCALE_STOPS.map((stop) => new THREE.Vector3(stop[0], stop[1], stop[2])) },
    uBandLow: { value: numbers() },
    uBandHigh: { value: numbers() },
  };
}

function srgbToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
}

/** The body's temperature scale; null when no region's temperature is known,
 *  which hatches every face. The span is floored as sectionTempT floors it,
 *  so the two never disagree; a scale of one value keeps its one value. */
export function writeTemperatureScale(uniforms: SectionUniforms, range: TemperatureRange | null): void {
  uniforms.uScaleMin.value = range ? range.minK : 0;
  uniforms.uScaleMax.value = range ? Math.max(range.maxK, range.minK + LINEAR_SPAN_FLOOR_K) : 1;
  uniforms.uScaleLog.value = range?.log ? 1 : 0;
  uniforms.uScaleKnown.value = range ? 1 : 0;
}

export interface SectionRegionLook {
  /** Outer radius in display space, 0..1. */
  outerDisplay: number;
  /** Blend half-width of the boundary at outerDisplay, display space; 0 for sharp. */
  blendDisplay: number;
  art: ArtParams;
  /** The region's temperature as the shader's knots (TEMPERATURE_KNOTS values from its top
   *  to its bottom, K) and how to mix between them, or null when unknown — drawn cold, and
   *  hatched in Temperature mode. */
  temperature: { knotsK: readonly number[]; log: boolean } | null;
  /** The uncertainty band straddling the region's OUTER boundary, display radii, or null. */
  bandDisplay: { low: number; high: number } | null;
}

/**
 * Write a body's regions into the uniforms, inside-out. Colours are
 * converted to linear here: the injected code writes straight into
 * diffuseColor, which three expects in working (linear) space. With no
 * studio environment to reflect (no float targets on this device), a metal
 * would render near-black, so metalness is capped and the ambient lifted.
 */
export function writeSectionRegions(
  uniforms: SectionUniforms,
  regionsInsideOut: readonly SectionRegionLook[],
  lustre = true,
  motionScale = 1,
): void {
  const count = Math.min(regionsInsideOut.length, MAX_REGIONS);
  uniforms.uCount.value = Math.max(1, count);
  const hottestIndex = hottestRegionIndex(regionsInsideOut, count);
  const selfLit = selfLitHeat(regionsInsideOut, count);
  uniforms.uSelfLitCoolK.value = selfLit.coolestK;
  uniforms.uSelfLitSpanLog.value = selfLit.spanLog;
  for (let index = 0; index < MAX_REGIONS; index++) {
    const region = regionsInsideOut[Math.min(index, count - 1)];
    const art = region.art;
    uniforms.uOuter.value[index] = index < count ? region.outerDisplay : 1;
    uniforms.uBlend.value[index] = index < count ? region.blendDisplay : 0;
    uniforms.uColorA.value[index].setHex(art.colorA);
    uniforms.uColorB.value[index].setHex(art.colorB);
    uniforms.uRough.value[index] = art.roughness;
    uniforms.uMetal.value[index] = lustre ? art.metalness : Math.min(art.metalness, 0.25);
    uniforms.uGlow.value[index] = art.glow;
    uniforms.uPattern.value[index] = PATTERN_INDEX[art.pattern];
    uniforms.uMotion.value[index] = art.motion * motionScale;
    uniforms.uScale.value[index] = art.scale;
    uniforms.uRelief.value[index] = art.relief;
    uniforms.uDepthGrad.value[index] = art.depthGradient;
    uniforms.uAmbient.value[index] = lustre ? art.ambient : art.ambient + 0.1 * art.metalness;
    if (art.selfLit) {
      uniforms.uHeat.value[index].setScalar(art.heatGain);
    } else {
      const tint = linearTint(art.heatTint);
      uniforms.uHeat.value[index].set(tint[0], tint[1], tint[2]).multiplyScalar(art.heatGain);
    }
    uniforms.uHeatBoost.value[index] = index === hottestIndex ? INCANDESCENCE_HOTTEST_BOOST : 1;
    uniforms.uSelfLit.value[index] = art.selfLit ? 1 : 0;
    uniforms.uHeatLevel.value[index] = selfLit.levels[index];
    const temperature = index < count ? region.temperature : null;
    for (let knot = 0; knot < TEMPERATURE_KNOTS; knot++) {
      const kelvin = temperature ? Math.max(temperature.knotsK[Math.min(knot, temperature.knotsK.length - 1)] ?? 1, 1) : 1;
      uniforms.uTempKnot.value[index * KNOT_VEC4S + Math.floor(knot / 4)].setComponent(knot % 4, kelvin);
    }
    uniforms.uTempLog.value[index] = temperature?.log ? 1 : 0;
    uniforms.uTempKnown.value[index] = temperature ? 1 : 0;
    const band = index < count ? region.bandDisplay : null;
    uniforms.uBandLow.value[index] = band ? band.low : 0;
    uniforms.uBandHigh.value[index] = band ? band.high : 0;
  }
}

/** A self-lit pixel's radiance: this floor at the body's coolest self-lit temperature, rising
 *  by the range on the cube of the local temperature's log place between it and the hottest,
 *  so the zones read in order and only the core crosses the bloom threshold. */
export const SELF_LIT_FLOOR = 0.35;
export const SELF_LIT_RANGE = 0.85;

function linearTint(hex: number): [number, number, number] {
  return [srgbToLinear(((hex >> 16) & 0xff) / 255), srgbToLinear(((hex >> 8) & 0xff) / 255), srgbToLinear((hex & 0xff) / 255)];
}

function hottestKnotK(temperature: SectionRegionLook['temperature']): number {
  return temperature ? Math.max(...temperature.knotsK) : -Infinity;
}

function coolestKnotK(temperature: SectionRegionLook['temperature']): number {
  return temperature ? Math.min(...temperature.knotsK) : Infinity;
}

/** The lit region with the highest temperature anywhere in it: the one the scene lets bloom. */
function hottestRegionIndex(regionsInsideOut: readonly SectionRegionLook[], count: number): number {
  let hottest = -1;
  let hottestK = -Infinity;
  for (let index = 0; index < count; index++) {
    const region = regionsInsideOut[index];
    if (region.art.selfLit || !region.temperature) continue;
    const bottomK = hottestKnotK(region.temperature);
    if (bottomK > hottestK) {
      hottestK = bottomK;
      hottest = index;
    }
  }
  return hottest;
}

/** The self-lit regions' place in the body's heat: per region, the log of its hottest
 *  temperature between the coolest self-lit temperature and the hottest (1 when there is
 *  only one, 0.5 when a temperature is unknown, 0 for a region that is not self-lit) — the
 *  regime its pattern draws — with the coolest temperature and the log span themselves, which
 *  the shader places each pixel's own temperature on. */
function selfLitHeat(regionsInsideOut: readonly SectionRegionLook[], count: number): { levels: number[]; coolestK: number; spanLog: number } {
  const levels = Array.from({ length: MAX_REGIONS }, () => 0);
  let coolestK = Infinity;
  let hottestK = -Infinity;
  for (let index = 0; index < count; index++) {
    const region = regionsInsideOut[index];
    if (!region.art.selfLit || !region.temperature) continue;
    coolestK = Math.min(coolestK, coolestKnotK(region.temperature));
    hottestK = Math.max(hottestK, hottestKnotK(region.temperature));
  }
  const spanLog = Number.isFinite(coolestK) && hottestK > coolestK ? Math.log(hottestK / Math.max(coolestK, 1)) : 0;
  for (let index = 0; index < count; index++) {
    const region = regionsInsideOut[index];
    if (!region.art.selfLit) continue;
    if (!region.temperature) {
      levels[index] = 0.5;
      continue;
    }
    const bottomK = Math.max(hottestKnotK(region.temperature), 1);
    levels[index] = spanLog > 0 ? Math.max(0, Math.min(1, Math.log(bottomK / Math.max(coolestK, 1)) / spanLog)) : 1;
  }
  return { levels, coolestK: Number.isFinite(coolestK) ? Math.max(coolestK, 1) : 1, spanLog };
}

/** A GLSL float literal that is never mistaken for an int. */
function glslFloat(value: number): string {
  const text = String(value);
  return text.includes('.') || text.includes('e') ? text : `${text}.0`;
}

/** The forge ramp as a chain of mixes over artParams.FORGE_STOPS: piecewise linear in sRGB
 *  between the stops, held at the first below and the last above — forgeSrgb, generated. */
function forgeRampGlsl(): string {
  const [firstK, firstColor] = FORGE_STOPS[0];
  const lines = [`  vec3 color = vec3(${firstColor.map(glslFloat).join(', ')});`];
  let previousK = firstK;
  for (let index = 1; index < FORGE_STOPS.length; index++) {
    const [stopK, color] = FORGE_STOPS[index];
    lines.push(`  color = mix(color, vec3(${color.map(glslFloat).join(', ')}), clamp((kelvin - ${glslFloat(previousK)}) / ${glslFloat(stopK - previousK)}, 0.0, 1.0));`);
    previousK = stopK;
  }
  return lines.join('\n');
}

const SECTION_PARS_VERTEX = /* glsl */ `
varying vec2 vSectionLocal;
varying vec3 vSectionWorld;
`;

const SECTION_VERTEX = /* glsl */ `
vSectionLocal = position.xy;
vSectionWorld = (modelMatrix * vec4(position, 1.0)).xyz;
`;

const SECTION_PARS_FRAGMENT = /* glsl */ `
varying vec2 vSectionLocal;
varying vec3 vSectionWorld;
uniform float uOuter[${MAX_REGIONS}];
uniform float uBlend[${MAX_REGIONS}];
uniform vec3 uColorA[${MAX_REGIONS}];
uniform vec3 uColorB[${MAX_REGIONS}];
uniform float uRough[${MAX_REGIONS}];
uniform float uMetal[${MAX_REGIONS}];
uniform float uGlow[${MAX_REGIONS}];
uniform float uPattern[${MAX_REGIONS}];
uniform float uMotion[${MAX_REGIONS}];
uniform float uScale[${MAX_REGIONS}];
uniform float uRelief[${MAX_REGIONS}];
uniform float uDepthGrad[${MAX_REGIONS}];
uniform float uAmbient[${MAX_REGIONS}];
uniform vec3 uHeat[${MAX_REGIONS}];
uniform float uSelfLit[${MAX_REGIONS}];
uniform float uHeatLevel[${MAX_REGIONS}];
uniform float uSelfLitCoolK;
uniform float uSelfLitSpanLog;
uniform float uHeatBoost[${MAX_REGIONS}];
uniform int uCount;
uniform mat3 uWorldToBody;
uniform float uTime;
uniform float uCorner;
uniform int uEmphasis;
uniform float uEmphasisAmount;
uniform int uDisplayMode;
uniform vec4 uTempKnot[${MAX_REGIONS * KNOT_VEC4S}];
uniform float uTempLog[${MAX_REGIONS}];
uniform float uTempKnown[${MAX_REGIONS}];
uniform float uScaleMin;
uniform float uScaleMax;
uniform float uScaleLog;
uniform float uScaleKnown;
uniform vec3 uScaleStops[6];
uniform float uBandLow[${MAX_REGIONS}];
uniform float uBandHigh[${MAX_REGIONS}];

${sunNoiseGLSL}

// Region k's knot j, K (floored at one kelvin): four knots to a vec4, the
// component picked by a mask rather than a computed subscript.
float sectionKnotK(int k, int j) {
  vec4 four = uTempKnot[k * ${KNOT_VEC4S} + j / 4];
  vec4 mask = vec4(equal(ivec4(j - (j / 4) * 4), ivec4(0, 1, 2, 3)));
  return max(dot(four, mask), 1.0);
}

// Region k's temperature at depth fraction regionT (0 at its top, 1 at its
// bottom), K: the knot pair the fraction falls between, mixed on a line or a
// log as the quantity declares — temperatureProfile.knotsTemperatureK.
float sectionTempK(int k, float regionT) {
  float x = clamp(regionT, 0.0, 1.0) * ${glslFloat(TEMPERATURE_KNOTS - 1)};
  int j = int(floor(min(x, ${glslFloat(TEMPERATURE_KNOTS - 1)} - 0.001)));
  float f = x - float(j);
  float a = sectionKnotK(k, j);
  float b = sectionKnotK(k, j + 1);
  return uTempLog[k] > 0.5 ? exp(mix(log(a), log(b), f)) : mix(a, b, f);
}

// Where a temperature sits on the body's scale, 0..1: temperatureScale.temperatureT.
float sectionScaleT(float kelvin) {
  if (uScaleLog > 0.5) {
    float low = log(max(uScaleMin, 1.0));
    return clamp((log(max(kelvin, 1.0)) - low) / max(log(max(uScaleMax, 1.0)) - low, 1e-4), 0.0, 1.0);
  }
  return clamp((kelvin - uScaleMin) / max(uScaleMax - uScaleMin, 1.0), 0.0, 1.0);
}

// Where region k's temperature at depth fraction regionT sits on the body's scale, 0..1.
float sectionTempT(int k, float regionT) {
  return sectionScaleT(sectionTempK(k, regionT));
}

// sRGB to linear, three's own transfer (colorspace_pars_fragment), so a mix
// made in sRGB comes out of the canvas as the sRGB the legend painted.
vec3 sectionSrgbToLinear(vec3 c) {
  return mix(pow(c * 0.9478672986 + vec3(0.0521327014), vec3(2.4)), c * 0.0773993808, vec3(lessThanEqual(c, vec3(0.04045))));
}

// The scale colour at t, linear RGB: six sRGB stops mixed in sRGB — the way
// the legend's gradient and the swatches mix them (temperatureScale.ts) —
// then linearised for the emissive.
vec3 sectionScaleColor(float t) {
  float x = clamp(t, 0.0, 1.0) * 5.0;
  int stop = int(floor(min(x, 4.999)));
  float f = x - float(stop);
  return sectionSrgbToLinear(mix(uScaleStops[stop], uScaleStops[stop + 1], f));
}

// The forge ramp, sRGB, by temperature: artParams.forgeSrgb, generated from its stops.
vec3 sectionForgeSrgb(float kelvin) {
${forgeRampGlsl()}
  return color;
}

// Incandescence from a temperature: the emitted radiance (linear HDR, rgb)
// and how much the heat dominates the albedo (a, 0 cold .. 1 fully
// incandescent) — artParams.incandescence, held to it by the tests.
vec4 sectionIncandescence(float kelvin) {
  float ramp = clamp((kelvin - ${glslFloat(DRAPER_POINT_K)}) / ${glslFloat(INCANDESCENCE_FULL_K - DRAPER_POINT_K)}, 0.0, 1.0);
  float strength = ramp > 0.0 ? pow(ramp, 0.8) : 0.0;
  vec3 forge = sectionForgeSrgb(kelvin);
  float hotDecades = clamp(log(max(kelvin, 1.0) / ${glslFloat(INCANDESCENCE_HOT_K)}) * 0.4342944819 / ${glslFloat(INCANDESCENCE_HOT_DECADES)}, 0.0, 1.0);
  // pow(0, y) is left to the driver by the spec, so a cold pixel never asks for it.
  float peak = strength > 0.0 ? pow(strength, 0.9) : 0.0;
  float radiance = (0.03 * strength + ${glslFloat(INCANDESCENCE_PEAK)} * peak) * (1.0 + ${glslFloat(INCANDESCENCE_HOT_BOOST)} * hotDecades * hotDecades);
  return vec4(pow(forge, vec3(2.2)) * radiance, strength);
}

// A self-lit pixel's radiance: the local temperature's log place between the
// body's coolest and hottest self-lit temperatures, cubed, over a floor.
float sectionSelfLitRadiance(float kelvin, float known) {
  float level = known < 0.5 ? 0.5 : (uSelfLitSpanLog > 0.0 ? clamp(log(max(kelvin, 1.0) / uSelfLitCoolK) / uSelfLitSpanLog, 0.0, 1.0) : 1.0);
  return ${glslFloat(SELF_LIT_FLOOR)} + ${glslFloat(SELF_LIT_RANGE)} * level * level * level;
}

// Region k's heat at depth fraction regionT: its incandescence at the local
// temperature (a light's radiance at it instead), through the family's tint
// and gain, grained by the pattern, the body's hottest region lifted toward
// its bottom; an unknown temperature is cold. strength is how much the
// heat dominates the albedo there.
vec3 sectionHeat(int k, float regionT, float heatMask, out float strength) {
  float kelvin = sectionTempK(k, regionT);
  float known = uTempKnown[k];
  vec4 glow = sectionIncandescence(kelvin) * known;
  vec3 radiance = mix(glow.rgb, vec3(sectionSelfLitRadiance(kelvin, known)), uSelfLit[k]);
  strength = glow.a;
  return radiance * uHeat[k] * heatMask * mix(1.0, uHeatBoost[k], regionT);
}

// A screen-space crosshatch for a temperature nobody knows: distinct from
// every scale colour, never mistaken for cold, and crossed so it is never
// mistaken for an uncertain boundary's single-direction band either.
vec3 sectionNoDataColor() {
  float hatchA = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) / 10.0));
  float hatchB = step(0.5, fract((gl_FragCoord.x - gl_FragCoord.y) / 10.0));
  return mix(vec3(0.045), vec3(0.15), max(hatchA, hatchB));
}

// The hue of a heat colour, max channel 1: what a hot region's surviving albedo takes on.
vec3 sectionHeatHue(vec3 heat) {
  return heat / max(max(max(heat.r, heat.g), heat.b), 1e-3);
}

float sectionFbm(vec3 p) {
  float value = 0.0;
  float amplitude = 0.5;
  for (int octave = 0; octave < 4; octave++) {
    value += amplitude * noise3(p);
    p = p * 2.03 + vec3(1.7, 9.2, 4.1);
    amplitude *= 0.5;
  }
  return value;
}

// One region's tone and height at a body-space point. Patterns are indexed
// by artParams.PATTERN_INDEX; regionT runs 0 at the region's top to 1 at
// its bottom; the height feeds the derivative bump, and heatMask grains the
// region's incandescence (lava glows in its fissures, a core in its facets).
vec4 sectionSample(int k, vec3 bodyPoint, float regionT, out float heatMask) {
  int pattern = int(uPattern[k] + 0.5);
  float scale = uScale[k];
  float drift = uTime * uMotion[k];
  float mixValue = 0.5;
  float height = -1.0;
  heatMask = 1.0;
  if (pattern == 8) {
    // lava: a field of dark cooled plates split by glowing fissures — the
    // fissures are the bright minority, at two widths, and the plates between
    // them are where the crust has skinned over
    vec3 q = bodyPoint * scale + vec3(drift, -drift * 0.6, drift * 0.3);
    float broad = sectionFbm(q * 0.45);
    float ridgeWide = 1.0 - abs(2.0 * sectionFbm(q * 1.7 + 3.1) - 1.0);
    float ridgeFine = 1.0 - abs(2.0 * sectionFbm(q * 3.4 + 7.3) - 1.0);
    float veins = max(smoothstep(0.82, 0.985, ridgeWide), 0.6 * smoothstep(0.9, 0.995, ridgeFine));
    float fine = noise3(q * 6.0);
    mixValue = 0.25 + 0.2 * (broad - 0.5) + 0.75 * veins;
    heatMask = 0.35 + 0.9 * veins + 0.2 * (broad - 0.5) + 0.08 * (fine - 0.5);
    height = 0.5 + 0.3 * (broad - 0.5) + 0.5 * veins;
  } else if (pattern == 9) {
    // mineral: solid rock in slow convection — domain-warped cells stretched
    // along the radial direction into plumes; no cracks, the heat in the cells
    vec3 q = bodyPoint * scale + vec3(drift, -drift * 0.7, drift * 0.4);
    vec3 radial = normalize(bodyPoint + vec3(1e-4));
    vec3 stretched = q - radial * dot(q, radial) * 0.55;
    float warp = sectionFbm(stretched);
    float cells = sectionFbm(stretched + 1.6 * vec3(warp, -warp, warp * 0.5));
    mixValue = cells;
    heatMask = 0.6 + 0.8 * cells;
    height = cells;
  } else if (pattern == 1) {
    // grain: faceted crystalline metal
    float cells = noise3(bodyPoint * scale);
    float fine = noise3(bodyPoint * scale * 3.1 + 7.0);
    mixValue = step(0.55, cells) * 0.55 + fine * 0.45;
    heatMask = 0.4 + 0.9 * mixValue;
  } else if (pattern == 2) {
    // swirl: slow convection in a solid-state mantle
    vec3 q = bodyPoint * scale + vec3(drift, -drift * 0.7, drift * 0.4);
    float warp = sectionFbm(q);
    mixValue = sectionFbm(q + 1.7 * vec3(warp, -warp, warp * 0.5));
  } else if (pattern == 3) {
    // flow: liquid metal, faster and more layered, with convective structure in its heat
    vec3 q = bodyPoint * scale + vec3(drift * 2.0, drift, -drift * 1.5);
    mixValue = sectionFbm(q * 1.5 + sectionFbm(q) * 2.0);
    heatMask = 0.35 + 0.95 * mixValue;
  } else if (pattern == 4) {
    // caustic: a soft two-octave shimmer in deep water, lighter toward the ice
    // above it, so the light seems to come from there
    vec3 q = bodyPoint * scale + vec3(drift, drift * 1.3, -drift);
    float ridge = 1.0 - abs(2.0 * noise3(q) - 1.0);
    float ridgeFine = 1.0 - abs(2.0 * noise3(q * 2.3 + 4.2) - 1.0);
    mixValue = 0.35 * pow(ridge, 3.0) + 0.2 * pow(ridgeFine, 3.0) + 0.15 * noise3(q * 2.3) + 0.25 * (1.0 - regionT);
  } else if (pattern == 5) {
    // banding: broad soft zonal bands, cylinders about the spin axis (body-space
    // Y), with turbulence growing toward the region's bottom as the flow gives way
    float axial = length(bodyPoint.xz);
    float turbulence = sectionFbm(bodyPoint * 3.0 + vec3(drift));
    float wobble = turbulence * (2.0 + 6.0 * regionT);
    float amplitude = 0.45 * (1.0 - 0.5 * regionT);
    mixValue = 0.5 + amplitude * sin(axial * scale + wobble) + 0.2 * (turbulence - 0.5) * regionT;
    heatMask = 0.7 + 0.5 * mixValue;
  } else if (pattern == 6) {
    if (uSelfLit[k] > 0.5) {
      // a star's zones: granules at the surface, boiling cells below, a still
      // radiative depth with faint radial streaks, the palette whitening inward
      float level = uHeatLevel[k];
      float cellScale = scale * mix(1.0, 0.27, level);
      vec3 q = bodyPoint * cellScale + vec3(drift, -drift * 0.8, drift * 0.5);
      float cells = sectionFbm(q);
      float stillness = smoothstep(0.55, 0.95, level);
      float angle = atan(bodyPoint.z, bodyPoint.x);
      float streaks = noise3(vec3(angle * 14.0, length(bodyPoint) * 6.0, 1.7));
      float structure = mix(cells, 0.5 + 0.12 * (streaks - 0.5), stillness);
      // Amber at the surface zones, gold at depth, cream only at the core: the palette
      // whitens on the square of the level, so the convective zone keeps its colour.
      mixValue = mix(0.15 + 0.45 * structure, 0.6 + 0.4 * structure, level * level);
      heatMask = 0.75 + 0.5 * structure;
      height = structure;
    } else {
      // mottle: an unresolved mix
      mixValue = sectionFbm(bodyPoint * scale);
      heatMask = 0.45 + 0.8 * mixValue;
    }
  } else if (pattern == 7) {
    // crystal: glassy facets in ice at two sizes, catching the key
    float coarse = step(0.5, noise3(bodyPoint * scale));
    float fine = step(0.5, noise3(bodyPoint * scale * 2.1 + 5.0));
    mixValue = 0.3 + 0.3 * coarse + 0.15 * fine + 0.2 * noise3(bodyPoint * scale * 4.0);
    height = 0.5 * coarse + 0.3 * fine;
  } else if (pattern == 10) {
    // hatch: the "not known" hatch, lighter — a deliberately blank disc
    float stripe = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) / 10.0));
    mixValue = 0.35 + 0.4 * stripe;
  }
  return vec4(mix(uColorA[k], uColorB[k], mixValue), height < 0.0 ? mixValue : height);
}
`;

/** After <color_fragment>: resolve the region and its blended look. */
const SECTION_RESOLVE = /* glsl */ `
// The body sits at the origin and both face planes pass through it, so the
// world position's length IS the display radius — what the pick and the ruler
// measure too, so the three agree by construction.
float sectionRadius = length(vSectionWorld);
float sectionPx = max(fwidth(sectionRadius), 1e-5); // one screen pixel, display units
vec3 sectionBodyPoint = uWorldToBody * vSectionWorld;
float regionT0 = clamp((uOuter[0] - sectionRadius) / max(uOuter[0], 1e-4), 0.0, 1.0);
float heatMask0;
vec4 sectionFirst = sectionSample(0, sectionBodyPoint, regionT0, heatMask0);
vec3 interiorAlbedo = sectionFirst.rgb;
float interiorHeight = sectionFirst.a;
// The heat is the local temperature's, so a region brightens toward its base by being
// hotter there; the body's hottest region takes its lift there, so only the middle of a core blooms.
float interiorHeatStrength;
vec3 interiorHeat = sectionHeat(0, regionT0, heatMask0, interiorHeatStrength);
float interiorSelfLit = uSelfLit[0];
float interiorRough = uRough[0];
float interiorMetal = uMetal[0];
float interiorGlow = uGlow[0];
float interiorRelief = uRelief[0];
float interiorAmbient = uAmbient[0];
float interiorDepthShade = uDepthGrad[0] * regionT0;
float boundaryShade = 1.0;
float bandShade = 1.0;
float emphasisMix = uEmphasis == 0 ? 1.0 : 0.0;
float interiorOutline = 0.0;
float interiorTempT = sectionTempT(0, regionT0);
float interiorTempKnown = uTempKnown[0] * uScaleKnown;
for (int k = 1; k < ${MAX_REGIONS}; k++) {
  if (k >= uCount) break;
  float boundary = uOuter[k - 1];
  // The blend is the physical transition's width and nothing else: where the
  // line might be is the hatched band below, never a wider blend.
  float blendWidth = uBlend[k - 1];
  float halfWidth = max(blendWidth, sectionPx);
  float t = smoothstep(boundary - halfWidth, boundary + halfWidth, sectionRadius);
  float regionT = clamp((uOuter[k] - sectionRadius) / max(uOuter[k] - boundary, 1e-4), 0.0, 1.0);
  float heatMaskK;
  vec4 sampleK = sectionSample(k, sectionBodyPoint, regionT, heatMaskK);
  interiorAlbedo = mix(interiorAlbedo, sampleK.rgb, t);
  interiorHeight = mix(interiorHeight, sampleK.a, t);
  float strengthK;
  vec3 heatK = sectionHeat(k, regionT, heatMaskK, strengthK);
  interiorHeat = mix(interiorHeat, heatK, t);
  interiorHeatStrength = mix(interiorHeatStrength, strengthK, t);
  interiorSelfLit = mix(interiorSelfLit, uSelfLit[k], t);
  interiorRough = mix(interiorRough, uRough[k], t);
  interiorMetal = mix(interiorMetal, uMetal[k], t);
  interiorGlow = mix(interiorGlow, uGlow[k], t);
  interiorRelief = mix(interiorRelief, uRelief[k], t);
  interiorAmbient = mix(interiorAmbient, uAmbient[k], t);
  interiorDepthShade = mix(interiorDepthShade, uDepthGrad[k] * regionT, t);
  emphasisMix = mix(emphasisMix, uEmphasis == k ? 1.0 : 0.0, t);
  interiorTempT = mix(interiorTempT, sectionTempT(k, regionT), t);
  interiorTempKnown = mix(interiorTempKnown, uTempKnown[k] * uScaleKnown, t);
  if (uBandHigh[k - 1] > uBandLow[k - 1]) {
    // Where the boundary might be: a faint hatch across the whole band, in both modes.
    float inBand = step(uBandLow[k - 1], sectionRadius) * step(sectionRadius, uBandHigh[k - 1]);
    float stripes = 0.5 + 0.5 * sin((gl_FragCoord.x - gl_FragCoord.y) * 0.9);
    bandShade *= 1.0 - 0.16 * inBand * stripes;
  }
  if (uEmphasis == k || uEmphasis == k - 1) {
    // The emphasised region's boundary, a line a couple of pixels wide.
    float lineDistance = (sectionRadius - boundary) / (sectionPx * 1.4);
    interiorOutline = max(interiorOutline, exp(-lineDistance * lineDistance));
  }
  // A sharp boundary is a hairline, a pixel wide and a little darker, the way a
  // diagram marks a contact; a physical blend is its own edge and gets none.
  float crisp = 1.0 - smoothstep(sectionPx * 1.5, sectionPx * 6.0, blendWidth);
  float hairline = (sectionRadius - boundary) / (sectionPx * 0.9);
  boundaryShade *= 1.0 - 0.2 * crisp * exp(-hairline * hairline);
}
// The crease where the two faces meet, gone at Section where they are coplanar.
float interiorCrease = 1.0 - uCorner * 0.45 * (1.0 - smoothstep(0.0, 0.45, vSectionLocal.x));
float interiorShade = (1.0 - interiorDepthShade) * interiorCrease * boundaryShade * bandShade;
if (uEmphasis == uCount - 1) {
  // The outermost region's outer boundary is the disc's rim.
  float rimDistance = (sectionRadius - uOuter[uCount - 1]) / (sectionPx * 1.4);
  interiorOutline = max(interiorOutline, exp(-rimDistance * rimDistance));
}
float interiorEmphasis = emphasisMix;
// A hot face is a light more than a surface: its albedo gives way to its heat, and
// what survives takes the heat's hue, so liquid iron stays iron rather than going grey.
// A self-lit region has no albedo at all.
interiorAlbedo = mix(interiorAlbedo, interiorAlbedo * sectionHeatHue(interiorHeat), 0.5 * interiorHeatStrength);
diffuseColor.rgb = interiorAlbedo * interiorShade * (1.0 - 0.55 * interiorHeatStrength) * (1.0 - interiorSelfLit);
if (uDisplayMode == 1) diffuseColor.rgb = vec3(0.0); // a diagram is unlit
`;

const SECTION_ROUGHNESS = /* glsl */ `
roughnessFactor = uDisplayMode == 1 ? 1.0 : interiorRough;
`;

/** A metal's studio sheen fades as its heat rises: a white-hot core is a light, and a mirror
 *  of the softbox on top of it only reads as a pale wash. The diagram is a metal with a black
 *  albedo: three's specular colour is then black too, so nothing in the studio lights it. */
const SECTION_METALNESS = /* glsl */ `
metalnessFactor = uDisplayMode == 1 ? 1.0 : interiorMetal * (1.0 - 0.35 * interiorHeatStrength);
`;

/** After <normal_fragment_maps>: the pattern's height as a bump, the
 *  construction of three's perturbNormalArb with the height's screen-space
 *  derivatives standing in for a bump map's. */
const SECTION_NORMAL = /* glsl */ `
if (interiorRelief > 0.0 && uDisplayMode == 0) {
  vec2 heightGradient = vec2(dFdx(interiorHeight), dFdy(interiorHeight)) * interiorRelief;
  vec3 sigmaX = normalize(dFdx(-vViewPosition));
  vec3 sigmaY = normalize(dFdy(-vViewPosition));
  vec3 reliefR1 = cross(sigmaY, normal);
  vec3 reliefR2 = cross(normal, sigmaX);
  float reliefDet = dot(sigmaX, reliefR1) * faceDirection;
  vec3 reliefGrad = sign(reliefDet) * (heightGradient.x * reliefR1 + heightGradient.y * reliefR2);
  normal = normalize(abs(reliefDet) * normal - reliefGrad);
}
`;

/** The faces are a diagram as much as a surface: each carries a self-lit
 *  floor of its own albedo so a shadowed face stays legible (the studio key
 *  still tells the two faces apart), and a hot region adds its glow, grained
 *  by the pattern so a crystalline core glows unevenly. Both take the same
 *  shading as the albedo, so a boundary line cuts the glow too. */
const SECTION_EMISSIVE = /* glsl */ `
if (uDisplayMode == 1) {
  // The diagram: the scale colour at the sampled temperature, or the
  // no-data hatch, dimmed only by an uncertainty band. The exposure keeps the
  // top of the scale under the bloom threshold (outputTransform.DIAGRAM_EXPOSURE).
  vec3 scaleColor = sectionScaleColor(interiorTempT) * ${glslFloat(DIAGRAM_EXPOSURE)};
  totalEmissiveRadiance = mix(sectionNoDataColor(), scaleColor, interiorTempKnown) * bandShade;
} else {
  // The emphasised region's lift is a higher self-lit floor, not a brighter albedo.
  float ambientLift = 1.0 + 0.5 * uEmphasisAmount * interiorEmphasis;
  totalEmissiveRadiance += interiorAlbedo * interiorAmbient * ambientLift * interiorShade * (1.0 - interiorHeatStrength) * (1.0 - interiorSelfLit);
  totalEmissiveRadiance += mix(interiorAlbedo, vec3(1.0, 0.7, 0.4), 0.5)
    * interiorGlow * (0.7 + 0.6 * interiorHeight) * interiorShade;
  // A lit surface adds its heat; a light IS its heat, patterned by its palette.
  totalEmissiveRadiance += mix(interiorHeat, interiorAlbedo * interiorHeat, interiorSelfLit) * interiorShade;
}
// The emphasis outline is a line, not a surface: a light rim held under the bloom threshold.
totalEmissiveRadiance += vec3(0.45) * interiorOutline * uEmphasisAmount;
`;

export function createSectionMaterial(uniforms: SectionUniforms): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    side: THREE.FrontSide,
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${SECTION_PARS_VERTEX}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${SECTION_VERTEX}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${SECTION_PARS_FRAGMENT}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${SECTION_RESOLVE}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${SECTION_ROUGHNESS}`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n${SECTION_METALNESS}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${SECTION_NORMAL}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${SECTION_EMISSIVE}`);
  };
  material.customProgramCacheKey = () => 'interiorSection';
  return material;
}

/** The injected GLSL as one text, for the tests that pin its arithmetic to the TypeScript. */
export const SECTION_SHADER_TEXT = [SECTION_PARS_FRAGMENT, SECTION_RESOLVE, SECTION_ROUGHNESS, SECTION_METALNESS, SECTION_NORMAL, SECTION_EMISSIVE].join('\n');
