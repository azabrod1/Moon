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
 * Depth is drawn as in a cutaway illustration. A sharp boundary carries a
 * shadow line just inside it (the layer above overhangs the one below) and
 * a light rim just outside (the lip that catches the key); both fade out as
 * the boundary's blend widens, because a gradual transition has no lip.
 * Within a region the face darkens from top to bottom by the region's
 * depthGradient, and the disc's rim darkens under the skin's overhang. A
 * crease shadow darkens the hinge where the two faces meet, gone at Section.
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
 * Heat is the fourth channel. Each region carries its incandescence (linear
 * HDR radiance from its temperature, artParams.incandescence, through the
 * family's heat tint), which the pattern grains — lava glows in its
 * fissures, a crystalline core in its facets — and adds as emission; the
 * hotter the region, the more its heat outweighs its albedo, and what
 * albedo survives takes the heat's hue. Only the body's hottest region
 * is lifted past the bloom threshold (INCANDESCENCE_HOTTEST_BOOST), so a
 * core bleeds and a mantle keeps its colour. A self-lit region (a star's
 * plasma) has no albedo at all: its patterned palette is its emission,
 * scaled by where the region sits in the body's heat (uHeatLevel).
 *
 * The terraces cast: the inner region's shell stands on the next face just
 * outside their boundary, and a soft contact shadow at its foot is what
 * makes a ledge read as a ledge rather than a painted ring.
 *
 * The same shader also dresses the terrace shells (InteriorScene): a shell
 * is one region's outer surface, so its variant samples that region
 * directly (uShellRegion) instead of resolving by radius, with no crease
 * and no lip lines.
 *
 * Emphasis is uniform-driven (plan §4): uEmphasis names a region and
 * uEmphasisAmount eases in. The named region brightens and its boundaries
 * take a light outline; every other region desaturates and its heat dims,
 * so the eye goes where the pointer or the legend row says. Nothing
 * extrudes and nothing recompiles.
 *
 * Temperature mode (plan §5, uDisplayMode 1) is a diagram: the face is
 * unlit (diffuse black, emissive only) and its colour is the body's
 * temperature scale at the temperature sampled at that pixel — each
 * region's endpoints interpolated by its depth fraction, which is the same
 * in display and physical space because the Readable remap is linear
 * within a region. An unknown temperature is a screen-space hatch, never
 * the coldest colour, and emphasis there is the outline alone.
 *
 * Uncertainty of a boundary's location (plan §6) is a faint hatched band
 * straddling it in Temperature mode, sized from the knowledge record; in
 * Composition mode the boundary's blend is widened to the band instead —
 * a soft edge is the honest picture of a line nobody has placed, and a
 * hatch across half a radius reads as wood grain. A distributed transition
 * stays the blend it already is, so the treatments compose.
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
import { INCANDESCENCE_HOTTEST_BOOST, PATTERN_INDEX, type ArtParams, type Incandescence } from '../data/artParams';
import { TEMPERATURE_SCALE_STOPS, type TemperatureRange } from '../temperatureScale';

export const MAX_REGIONS = 8;

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
  /** Incandescent radiance per region, linear HDR. */
  uHeat: { value: THREE.Vector3[] };
  /** 0 cold .. 1 fully incandescent. */
  uHeatStrength: { value: number[] };
  /** 1 for a region that is a light (a star's plasma): no albedo, its palette is its emission. */
  uSelfLit: { value: number[] };
  /** A self-lit region's place in the body's heat, 0 at the coolest zone to 1 at the hottest. */
  uHeatLevel: { value: number[] };
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
  /** Temperature at region k's top and bottom, K; log interpolation flag; 1 when known. */
  uTempOuter: { value: number[] };
  uTempInner: { value: number[] };
  uTempLog: { value: number[] };
  uTempKnown: { value: number[] };
  /** The body's scale, K (1 = logarithmic), and its six linear-RGB stops. */
  uScaleMin: { value: number };
  uScaleMax: { value: number };
  uScaleLog: { value: number };
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
    uHeatStrength: { value: numbers() },
    uSelfLit: { value: numbers() },
    uHeatLevel: { value: numbers() },
    uCount: { value: 1 },
    uWorldToBody: { value: new THREE.Matrix3() },
    uTime: { value: 0 },
    uCorner: { value: 0 },
    uEmphasis: { value: -1 },
    uEmphasisAmount: { value: 0 },
    uDisplayMode: { value: 0 },
    uTempOuter: { value: numbers() },
    uTempInner: { value: numbers() },
    uTempLog: { value: numbers() },
    uTempKnown: { value: numbers() },
    uScaleMin: { value: 0 },
    uScaleMax: { value: 1 },
    uScaleLog: { value: 0 },
    uScaleStops: { value: TEMPERATURE_SCALE_STOPS.map((stop) => new THREE.Vector3(srgbToLinear(stop[0]), srgbToLinear(stop[1]), srgbToLinear(stop[2]))) },
    uBandLow: { value: numbers() },
    uBandHigh: { value: numbers() },
  };
}

function srgbToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
}

/** The body's temperature scale; null when no region's temperature is known. */
export function writeTemperatureScale(uniforms: SectionUniforms, range: TemperatureRange | null): void {
  uniforms.uScaleMin.value = range ? range.minK : 0;
  uniforms.uScaleMax.value = range ? Math.max(range.maxK, range.minK + 1) : 1;
  uniforms.uScaleLog.value = range?.log ? 1 : 0;
}

export interface SectionRegionLook {
  /** Outer radius in display space, 0..1. */
  outerDisplay: number;
  /** Blend half-width of the boundary at outerDisplay, display space; 0 for sharp. */
  blendDisplay: number;
  art: ArtParams;
  heat: Incandescence;
  /** The region's temperature endpoints, K, or null when unknown (drawn hatched in Temperature mode). */
  temperature: { outerK: number; innerK: number; log: boolean } | null;
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
  const heatLevels = selfLitHeatLevels(regionsInsideOut, count);
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
      // A light: the palette is the emission; the radiance says where in the body's heat it sits.
      uniforms.uHeat.value[index].setScalar((SELF_LIT_FLOOR + SELF_LIT_RANGE * heatLevels[index]) * art.heatGain);
    } else {
      const tint = linearTint(art.heatTint);
      const boost = index === hottestIndex ? INCANDESCENCE_HOTTEST_BOOST : 1;
      uniforms.uHeat.value[index]
        .set(region.heat.emission[0] * tint[0], region.heat.emission[1] * tint[1], region.heat.emission[2] * tint[2])
        .multiplyScalar(art.heatGain * boost);
    }
    uniforms.uHeatStrength.value[index] = region.heat.strength;
    uniforms.uSelfLit.value[index] = art.selfLit ? 1 : 0;
    uniforms.uHeatLevel.value[index] = heatLevels[index];
    const temperature = index < count ? region.temperature : null;
    uniforms.uTempOuter.value[index] = temperature ? temperature.outerK : 0;
    uniforms.uTempInner.value[index] = temperature ? temperature.innerK : 0;
    uniforms.uTempLog.value[index] = temperature?.log ? 1 : 0;
    uniforms.uTempKnown.value[index] = temperature ? 1 : 0;
    const band = index < count ? region.bandDisplay : null;
    uniforms.uBandLow.value[index] = band ? band.low : 0;
    uniforms.uBandHigh.value[index] = band ? band.high : 0;
  }
}

/** A self-lit region's radiance: this floor at the body's coolest self-lit zone, rising by the
 *  range to its hottest, so only the core crosses the bloom threshold. */
const SELF_LIT_FLOOR = 0.55;
const SELF_LIT_RANGE = 0.8;

function linearTint(hex: number): [number, number, number] {
  return [srgbToLinear(((hex >> 16) & 0xff) / 255), srgbToLinear(((hex >> 8) & 0xff) / 255), srgbToLinear((hex & 0xff) / 255)];
}

/** The lit region with the highest bottom temperature: the one the scene lets bloom. */
function hottestRegionIndex(regionsInsideOut: readonly SectionRegionLook[], count: number): number {
  let hottest = -1;
  let hottestK = -Infinity;
  for (let index = 0; index < count; index++) {
    const region = regionsInsideOut[index];
    if (region.art.selfLit || !region.temperature) continue;
    const bottomK = Math.max(region.temperature.innerK, region.temperature.outerK);
    if (bottomK > hottestK) {
      hottestK = bottomK;
      hottest = index;
    }
  }
  return hottest;
}

/** Where each self-lit region sits in the body's heat, by the log of its bottom temperature
 *  between the coolest self-lit top and the hottest self-lit bottom; 1 when there is only
 *  one, 0.5 when a temperature is unknown, 0 for a region that is not self-lit. */
function selfLitHeatLevels(regionsInsideOut: readonly SectionRegionLook[], count: number): number[] {
  const levels = Array.from({ length: MAX_REGIONS }, () => 0);
  let coolestK = Infinity;
  let hottestK = -Infinity;
  for (let index = 0; index < count; index++) {
    const region = regionsInsideOut[index];
    if (!region.art.selfLit || !region.temperature) continue;
    coolestK = Math.min(coolestK, region.temperature.outerK, region.temperature.innerK);
    hottestK = Math.max(hottestK, region.temperature.outerK, region.temperature.innerK);
  }
  const span = Number.isFinite(coolestK) && hottestK > coolestK ? Math.log(hottestK / Math.max(coolestK, 1)) : 0;
  for (let index = 0; index < count; index++) {
    const region = regionsInsideOut[index];
    if (!region.art.selfLit) continue;
    if (!region.temperature) {
      levels[index] = 0.5;
      continue;
    }
    const bottomK = Math.max(region.temperature.innerK, region.temperature.outerK, 1);
    levels[index] = span > 0 ? Math.max(0, Math.min(1, Math.log(bottomK / Math.max(coolestK, 1)) / span)) : 1;
  }
  return levels;
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
uniform float uHeatStrength[${MAX_REGIONS}];
uniform float uSelfLit[${MAX_REGIONS}];
uniform float uHeatLevel[${MAX_REGIONS}];
uniform int uCount;
uniform mat3 uWorldToBody;
uniform float uTime;
uniform float uCorner;
uniform int uEmphasis;
uniform float uEmphasisAmount;
uniform int uDisplayMode;
uniform float uTempOuter[${MAX_REGIONS}];
uniform float uTempInner[${MAX_REGIONS}];
uniform float uTempLog[${MAX_REGIONS}];
uniform float uTempKnown[${MAX_REGIONS}];
uniform float uScaleMin;
uniform float uScaleMax;
uniform float uScaleLog;
uniform vec3 uScaleStops[6];
uniform float uBandLow[${MAX_REGIONS}];
uniform float uBandHigh[${MAX_REGIONS}];

${sunNoiseGLSL}

// Where region k's temperature sits on the body's scale at depth fraction
// regionT (0 at its top, 1 at its bottom), 0..1.
float sectionTempT(int k, float regionT) {
  float outerK = max(uTempOuter[k], 1.0);
  float innerK = max(uTempInner[k], 1.0);
  float kelvin = uTempLog[k] > 0.5 ? exp(mix(log(outerK), log(innerK), regionT)) : mix(outerK, innerK, regionT);
  if (uScaleLog > 0.5) {
    float low = log(max(uScaleMin, 1.0));
    return clamp((log(max(kelvin, 1.0)) - low) / max(log(max(uScaleMax, 1.0)) - low, 1e-4), 0.0, 1.0);
  }
  return clamp((kelvin - uScaleMin) / max(uScaleMax - uScaleMin, 1.0), 0.0, 1.0);
}

// The scale colour at t, linear RGB: six stops, linear between them, the
// same ramp the legend paints from temperatureScale.ts.
vec3 sectionScaleColor(float t) {
  float x = clamp(t, 0.0, 1.0) * 5.0;
  int stop = int(floor(min(x, 4.999)));
  float f = x - float(stop);
  return mix(uScaleStops[stop], uScaleStops[stop + 1], f);
}

// A screen-space hatch for a temperature nobody knows: distinct from every
// scale colour, and never mistaken for cold.
vec3 sectionNoDataColor() {
  float hatch = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) / 10.0));
  return mix(vec3(0.045), vec3(0.15), hatch);
}

// Emphasis: the rest desaturate a little and their heat dims a little, so
// the named region is the one still fully alive (its own lift is a higher
// ambient floor, in the emissive stage, never a brighter albedo). emphasisMix
// is this pixel's membership of the named region (blended across a soft
// boundary like everything else). In Temperature mode nothing shifts: the
// hue is the legend's, and only the outline remains.
void sectionEmphasis(float emphasisMix, inout vec3 albedo, inout vec3 heat, inout float glow) {
  if (uEmphasisAmount <= 0.0 || uDisplayMode == 1) return;
  float other = uEmphasisAmount * (1.0 - emphasisMix);
  float luminance = dot(albedo, vec3(0.2126, 0.7152, 0.0722));
  albedo = mix(albedo, vec3(luminance) * 0.85, other * 0.4);
  heat *= 1.0 - 0.3 * other;
  glow *= 1.0 - 0.3 * other;
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
    float amplitude = 0.25 * (1.0 - 0.5 * regionT);
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
      mixValue = mix(0.25 + 0.5 * structure, 0.75 + 0.25 * structure, level);
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
// The body sits at the origin and every face plane passes through it, so the
// world position's length IS the display radius — for a terrace disc scaled
// to its region's radius as much as for the crust's full disc (the local
// coordinate would be the unit geometry's, and read every disc as the whole body).
float sectionRadius = length(vSectionWorld);
float sectionPx = max(fwidth(sectionRadius), 1e-5); // one screen pixel, display units
vec3 sectionBodyPoint = uWorldToBody * vSectionWorld;
float regionT0 = clamp((uOuter[0] - sectionRadius) / max(uOuter[0], 1e-4), 0.0, 1.0);
float heatMask0;
vec4 sectionFirst = sectionSample(0, sectionBodyPoint, regionT0, heatMask0);
vec3 interiorAlbedo = sectionFirst.rgb;
float interiorHeight = sectionFirst.a;
// Hotter inward within a region too: the heat brightens toward the bottom.
vec3 interiorHeat = uHeat[0] * heatMask0 * (0.8 + 0.35 * regionT0);
float interiorHeatStrength = uHeatStrength[0];
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
float interiorTempKnown = uTempKnown[0];
for (int k = 1; k < ${MAX_REGIONS}; k++) {
  if (k >= uCount) break;
  float boundary = uOuter[k - 1];
  // In Composition an uncertain boundary is a wide blend; in Temperature it is a hatched band.
  float bandHalf = uDisplayMode == 1 ? 0.0 : 0.5 * max(uBandHigh[k - 1] - uBandLow[k - 1], 0.0);
  float blendWidth = max(uBlend[k - 1], bandHalf);
  float halfWidth = max(blendWidth, sectionPx);
  float t = smoothstep(boundary - halfWidth, boundary + halfWidth, sectionRadius);
  float regionT = clamp((uOuter[k] - sectionRadius) / max(uOuter[k] - boundary, 1e-4), 0.0, 1.0);
  float heatMaskK;
  vec4 sampleK = sectionSample(k, sectionBodyPoint, regionT, heatMaskK);
  interiorAlbedo = mix(interiorAlbedo, sampleK.rgb, t);
  interiorHeight = mix(interiorHeight, sampleK.a, t);
  interiorHeat = mix(interiorHeat, uHeat[k] * heatMaskK * (0.8 + 0.35 * regionT), t);
  interiorHeatStrength = mix(interiorHeatStrength, uHeatStrength[k], t);
  interiorSelfLit = mix(interiorSelfLit, uSelfLit[k], t);
  interiorRough = mix(interiorRough, uRough[k], t);
  interiorMetal = mix(interiorMetal, uMetal[k], t);
  interiorGlow = mix(interiorGlow, uGlow[k], t);
  interiorRelief = mix(interiorRelief, uRelief[k], t);
  interiorAmbient = mix(interiorAmbient, uAmbient[k], t);
  interiorDepthShade = mix(interiorDepthShade, uDepthGrad[k] * regionT, t);
  emphasisMix = mix(emphasisMix, uEmphasis == k ? 1.0 : 0.0, t);
  interiorTempT = mix(interiorTempT, sectionTempT(k, regionT), t);
  interiorTempKnown = mix(interiorTempKnown, uTempKnown[k], t);
  if (uDisplayMode == 1 && uBandHigh[k - 1] > uBandLow[k - 1]) {
    // Where the boundary might be: a faint hatch across the whole band.
    float inBand = step(uBandLow[k - 1], sectionRadius) * step(sectionRadius, uBandHigh[k - 1]);
    float stripes = 0.5 + 0.5 * sin((gl_FragCoord.x - gl_FragCoord.y) * 0.9);
    bandShade *= 1.0 - 0.16 * inBand * stripes;
  }
  if (uEmphasis == k || uEmphasis == k - 1) {
    // The emphasised region's boundary, a line a couple of pixels wide.
    float lineDistance = (sectionRadius - boundary) / (sectionPx * 1.4);
    interiorOutline = max(interiorOutline, exp(-lineDistance * lineDistance));
  }
  // The cutaway's lip: a shadow just inside a sharp boundary, a light rim
  // just outside it; neither where the transition is a physical blend.
  float crisp = 1.0 - smoothstep(sectionPx * 1.5, sectionPx * 6.0, blendWidth);
  float inside = (boundary - sectionRadius) / (sectionPx * 3.5);
  float shadow = exp(-inside * inside) * step(0.0, inside);
  float outside = (sectionRadius - boundary) / (sectionPx * 1.6);
  float rim = exp(-outside * outside) * step(0.0, outside);
  boundaryShade *= 1.0 - 0.42 * crisp * shadow;
  boundaryShade *= 1.0 + 0.22 * crisp * rim;
  // The terrace above: the inner region's shell stands on this face just outside
  // the boundary, and its foot casts a soft contact shadow, sized to the body.
  float foot = (sectionRadius - boundary) / max(0.06 * boundary, sectionPx * 2.0);
  boundaryShade *= 1.0 - 0.35 * crisp * exp(-foot * foot) * step(0.0, foot);
}
// The skin overhangs the disc's rim.
float underSkin = (uOuter[uCount - 1] - sectionRadius) / (sectionPx * 3.5);
boundaryShade *= 1.0 - 0.4 * exp(-underSkin * underSkin) * step(0.0, underSkin);
// The crease where the two faces meet, gone at Section where they are coplanar.
float interiorCrease = 1.0 - uCorner * 0.45 * (1.0 - smoothstep(0.0, 0.45, vSectionLocal.x));
float interiorShade = (1.0 - interiorDepthShade) * interiorCrease * boundaryShade * bandShade;
if (uEmphasis == uCount - 1) {
  // The outermost region's outer boundary is the disc's rim.
  float rimDistance = (sectionRadius - uOuter[uCount - 1]) / (sectionPx * 1.4);
  interiorOutline = max(interiorOutline, exp(-rimDistance * rimDistance));
}
float interiorEmphasis = emphasisMix;
sectionEmphasis(emphasisMix, interiorAlbedo, interiorHeat, interiorGlow);
// A hot face is a light more than a surface: its albedo gives way to its heat, and
// what survives takes the heat's hue, so liquid iron stays iron rather than going grey.
// A self-lit region has no albedo at all.
interiorAlbedo = mix(interiorAlbedo, interiorAlbedo * sectionHeatHue(interiorHeat), 0.5 * interiorHeatStrength);
diffuseColor.rgb = interiorAlbedo * interiorShade * (1.0 - 0.55 * interiorHeatStrength) * (1.0 - interiorSelfLit);
if (uDisplayMode == 1) diffuseColor.rgb = vec3(0.0); // a diagram is unlit
`;

/** The shell variant of the resolve: one region's outer surface, sampled
 *  directly, with neither crease nor lip lines (its edges are the cut). */
const SHELL_RESOLVE = /* glsl */ `
vec3 sectionBodyPoint = uWorldToBody * vSectionWorld;
float shellHeatMask;
vec4 shellSample = sectionSample(uShellRegion, sectionBodyPoint, 0.0, shellHeatMask);
vec3 interiorAlbedo = shellSample.rgb;
float interiorHeight = shellSample.a;
vec3 interiorHeat = uHeat[uShellRegion] * shellHeatMask;
float interiorHeatStrength = uHeatStrength[uShellRegion];
float interiorSelfLit = uSelfLit[uShellRegion];
// A shell seen at a grazing angle would flare in the softbox as a bright sliver along
// the hinge: its sheen is held down (rough, and its metalness fading as it turns away).
float shellFacing = abs(dot(normalize(vNormal), normalize(vViewPosition)));
float interiorRough = max(uRough[uShellRegion], 0.6);
float interiorMetal = uMetal[uShellRegion] * sqrt(shellFacing);
float interiorGlow = uGlow[uShellRegion];
float interiorRelief = uRelief[uShellRegion];
float interiorAmbient = uAmbient[uShellRegion];
// A glowing sphere still reads as a sphere: its heat falls off toward the
// limb (the emission is not lambertian, but the eye expects the form).
float shellLimb = 0.6 + 0.4 * abs(dot(normalize(vNormal), normalize(vViewPosition)));
interiorHeat *= shellLimb;
float interiorShade = 1.0;
float bandShade = 1.0;
float interiorOutline = 0.0;
float interiorTempT = sectionTempT(uShellRegion, 0.0);
float interiorTempKnown = uTempKnown[uShellRegion];
float interiorEmphasis = uShellRegion == uEmphasis ? 1.0 : 0.0;
sectionEmphasis(interiorEmphasis, interiorAlbedo, interiorHeat, interiorGlow);
interiorAlbedo = mix(interiorAlbedo, interiorAlbedo * sectionHeatHue(interiorHeat), 0.5 * interiorHeatStrength);
diffuseColor.rgb = interiorAlbedo * (1.0 - 0.55 * interiorHeatStrength) * (1.0 - interiorSelfLit);
if (uDisplayMode == 1) diffuseColor.rgb = vec3(0.0);
`;

const SECTION_ROUGHNESS = /* glsl */ `
roughnessFactor = uDisplayMode == 1 ? 1.0 : interiorRough;
`;

const SECTION_METALNESS = /* glsl */ `
metalnessFactor = uDisplayMode == 1 ? 0.0 : interiorMetal;
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
  // no-data hatch, dimmed only by an uncertainty band. 0.88 keeps the top
  // of the scale under the bloom threshold.
  vec3 scaleColor = sectionScaleColor(interiorTempT) * 0.88;
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

export interface ShellOptions {
  /** The region (inside-out index) whose outer surface this material dresses. */
  shellRegion: { value: number };
}

export function createSectionMaterial(uniforms: SectionUniforms, shell?: ShellOptions): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    side: THREE.FrontSide,
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    if (shell) shader.uniforms.uShellRegion = shell.shellRegion;
    const pars = shell ? `${SECTION_PARS_FRAGMENT}\nuniform int uShellRegion;` : SECTION_PARS_FRAGMENT;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${SECTION_PARS_VERTEX}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${SECTION_VERTEX}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${pars}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${shell ? SHELL_RESOLVE : SECTION_RESOLVE}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${SECTION_ROUGHNESS}`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n${SECTION_METALNESS}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${SECTION_NORMAL}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${SECTION_EMISSIVE}`);
  };
  material.customProgramCacheKey = () => (shell ? 'interiorShell' : 'interiorSection');
  return material;
}
