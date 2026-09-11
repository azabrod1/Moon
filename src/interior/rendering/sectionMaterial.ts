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
 * HDR radiance from its temperature, artParams.incandescence), which the
 * pattern grains — lava glows in its cracks, a crystalline core in its
 * facets — and adds as emission; the hotter the region, the more its heat
 * outweighs its albedo. The bloom pass bleeds what crosses its threshold.
 *
 * The same shader also dresses the terrace shells (InteriorScene): a shell
 * is one region's outer surface, so its variant samples that region
 * directly (uShellRegion) instead of resolving by radius, with no crease
 * and no lip lines.
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
import { PATTERN_INDEX, type ArtParams, type Incandescence } from '../data/artParams';

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
  uCount: { value: number };
  /** World → body-space rotation (the inverse of the body's pose). */
  uWorldToBody: { value: THREE.Matrix3 };
  /** Presentation seconds. */
  uTime: { value: number };
  /** 0..1, how much of a crease the hinge is: 1 closed-ish, 0 at Section. */
  uCorner: { value: number };
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
    uCount: { value: 1 },
    uWorldToBody: { value: new THREE.Matrix3() },
    uTime: { value: 0 },
    uCorner: { value: 0 },
  };
}

export interface SectionRegionLook {
  /** Outer radius in display space, 0..1. */
  outerDisplay: number;
  /** Blend half-width of the boundary at outerDisplay, display space; 0 for sharp. */
  blendDisplay: number;
  art: ArtParams;
  heat: Incandescence;
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
): void {
  const count = Math.min(regionsInsideOut.length, MAX_REGIONS);
  uniforms.uCount.value = Math.max(1, count);
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
    uniforms.uMotion.value[index] = art.motion;
    uniforms.uScale.value[index] = art.scale;
    uniforms.uRelief.value[index] = art.relief;
    uniforms.uDepthGrad.value[index] = art.depthGradient;
    uniforms.uAmbient.value[index] = lustre ? art.ambient : art.ambient + 0.1 * art.metalness;
    uniforms.uHeat.value[index].set(region.heat.emission[0], region.heat.emission[1], region.heat.emission[2]);
    uniforms.uHeatStrength.value[index] = region.heat.strength;
  }
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
uniform int uCount;
uniform mat3 uWorldToBody;
uniform float uTime;
uniform float uCorner;

${sunNoiseGLSL}

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
// region's incandescence (lava glows in its cracks, a core in its facets).
vec4 sectionSample(int k, vec3 bodyPoint, float regionT, out float heatMask) {
  int pattern = int(uPattern[k] + 0.5);
  float scale = uScale[k];
  float drift = uTime * uMotion[k];
  float mixValue = 0.5;
  float height = -1.0;
  heatMask = 1.0;
  if (pattern == 8) {
    // lava: glowing rock veined by thin, darker, cooler seams, with a slow
    // broad variation — the melt is the body of it, the veins the minority
    vec3 q = bodyPoint * scale + vec3(drift, -drift * 0.6, drift * 0.3);
    float broad = sectionFbm(q * 0.45);
    // fbm sits near 0.5, so the ridge is high almost everywhere: only a tight
    // threshold leaves the veins as thin lines.
    float ridge = 1.0 - abs(2.0 * sectionFbm(q * 1.7 + 3.1) - 1.0);
    float veins = smoothstep(0.86, 0.985, ridge);
    float fine = noise3(q * 6.0);
    mixValue = 0.55 + 0.35 * (broad - 0.5) - 0.4 * veins;
    heatMask = (0.8 + 0.5 * (broad - 0.5) + 0.12 * (fine - 0.5)) * (1.0 - 0.7 * veins);
    height = 0.5 + 0.4 * (broad - 0.5) - 0.5 * veins;
  } else if (pattern == 1) {
    // grain: faceted crystalline metal
    float cells = noise3(bodyPoint * scale);
    float fine = noise3(bodyPoint * scale * 3.1 + 7.0);
    mixValue = step(0.55, cells) * 0.55 + fine * 0.45;
    heatMask = 0.6 + 0.4 * mixValue;
  } else if (pattern == 2) {
    // swirl: slow convection in a solid-state mantle
    vec3 q = bodyPoint * scale + vec3(drift, -drift * 0.7, drift * 0.4);
    float warp = sectionFbm(q);
    mixValue = sectionFbm(q + 1.7 * vec3(warp, -warp, warp * 0.5));
  } else if (pattern == 3) {
    // flow: liquid metal, faster and more layered
    vec3 q = bodyPoint * scale + vec3(drift * 2.0, drift, -drift * 1.5);
    mixValue = sectionFbm(q * 1.5 + sectionFbm(q) * 2.0);
    heatMask = 0.6 + 0.6 * mixValue;
  } else if (pattern == 4) {
    // caustic: ridged shimmer for water and brine
    vec3 q = bodyPoint * scale + vec3(drift, drift * 1.3, -drift);
    float ridge = 1.0 - abs(2.0 * noise3(q) - 1.0);
    mixValue = pow(ridge, 3.0) * 0.8 + noise3(q * 2.3) * 0.2;
  } else if (pattern == 5) {
    // banding: cylinders about the spin axis (body-space Y), softened by
    // noise and fading toward the region's bottom as the flow gives way
    float axial = length(bodyPoint.xz);
    float wobble = sectionFbm(bodyPoint * 3.0 + vec3(drift)) * 2.0;
    float amplitude = 0.5 * (1.0 - 0.6 * regionT);
    mixValue = 0.5 + amplitude * sin(axial * scale + wobble);
    heatMask = 0.7 + 0.5 * mixValue;
  } else if (pattern == 6) {
    // mottle: an unresolved mix
    mixValue = sectionFbm(bodyPoint * scale);
    heatMask = 0.45 + 0.8 * mixValue;
  } else if (pattern == 7) {
    // crystal: faint large facets in ice
    mixValue = 0.35 + 0.3 * step(0.5, noise3(bodyPoint * scale)) + 0.2 * noise3(bodyPoint * scale * 4.0);
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
float interiorRough = uRough[0];
float interiorMetal = uMetal[0];
float interiorGlow = uGlow[0];
float interiorRelief = uRelief[0];
float interiorAmbient = uAmbient[0];
float interiorDepthShade = uDepthGrad[0] * regionT0;
float boundaryShade = 1.0;
for (int k = 1; k < ${MAX_REGIONS}; k++) {
  if (k >= uCount) break;
  float boundary = uOuter[k - 1];
  float halfWidth = max(uBlend[k - 1], sectionPx);
  float t = smoothstep(boundary - halfWidth, boundary + halfWidth, sectionRadius);
  float regionT = clamp((uOuter[k] - sectionRadius) / max(uOuter[k] - boundary, 1e-4), 0.0, 1.0);
  float heatMaskK;
  vec4 sampleK = sectionSample(k, sectionBodyPoint, regionT, heatMaskK);
  interiorAlbedo = mix(interiorAlbedo, sampleK.rgb, t);
  interiorHeight = mix(interiorHeight, sampleK.a, t);
  interiorHeat = mix(interiorHeat, uHeat[k] * heatMaskK * (0.8 + 0.35 * regionT), t);
  interiorHeatStrength = mix(interiorHeatStrength, uHeatStrength[k], t);
  interiorRough = mix(interiorRough, uRough[k], t);
  interiorMetal = mix(interiorMetal, uMetal[k], t);
  interiorGlow = mix(interiorGlow, uGlow[k], t);
  interiorRelief = mix(interiorRelief, uRelief[k], t);
  interiorAmbient = mix(interiorAmbient, uAmbient[k], t);
  interiorDepthShade = mix(interiorDepthShade, uDepthGrad[k] * regionT, t);
  // The cutaway's lip: a shadow just inside a sharp boundary, a light rim
  // just outside it; neither where the transition is a physical blend.
  float crisp = 1.0 - smoothstep(sectionPx * 1.5, sectionPx * 6.0, uBlend[k - 1]);
  float inside = (boundary - sectionRadius) / (sectionPx * 3.5);
  float shadow = exp(-inside * inside) * step(0.0, inside);
  float outside = (sectionRadius - boundary) / (sectionPx * 1.6);
  float rim = exp(-outside * outside) * step(0.0, outside);
  boundaryShade *= 1.0 - 0.42 * crisp * shadow;
  boundaryShade *= 1.0 + 0.22 * crisp * rim;
}
// The skin overhangs the disc's rim.
float underSkin = (uOuter[uCount - 1] - sectionRadius) / (sectionPx * 3.5);
boundaryShade *= 1.0 - 0.4 * exp(-underSkin * underSkin) * step(0.0, underSkin);
// The crease where the two faces meet, gone at Section where they are coplanar.
float interiorCrease = 1.0 - uCorner * 0.3 * (1.0 - smoothstep(0.0, 0.2, vSectionLocal.x));
float interiorShade = (1.0 - interiorDepthShade) * interiorCrease * boundaryShade;
// A hot face is a light more than a surface: its albedo gives way to its heat.
diffuseColor.rgb = interiorAlbedo * interiorShade * (1.0 - 0.85 * interiorHeatStrength);
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
float interiorRough = uRough[uShellRegion];
float interiorMetal = uMetal[uShellRegion];
float interiorGlow = uGlow[uShellRegion];
float interiorRelief = uRelief[uShellRegion];
float interiorAmbient = uAmbient[uShellRegion];
// A glowing sphere still reads as a sphere: its heat falls off toward the
// limb (the emission is not lambertian, but the eye expects the form).
float shellLimb = 0.6 + 0.4 * abs(dot(normalize(vNormal), normalize(vViewPosition)));
interiorHeat *= shellLimb;
float interiorShade = 1.0;
diffuseColor.rgb = interiorAlbedo * (1.0 - 0.85 * interiorHeatStrength);
`;

const SECTION_ROUGHNESS = /* glsl */ `
roughnessFactor = interiorRough;
`;

const SECTION_METALNESS = /* glsl */ `
metalnessFactor = interiorMetal;
`;

/** After <normal_fragment_maps>: the pattern's height as a bump, the
 *  construction of three's perturbNormalArb with the height's screen-space
 *  derivatives standing in for a bump map's. */
const SECTION_NORMAL = /* glsl */ `
if (interiorRelief > 0.0) {
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
totalEmissiveRadiance += interiorAlbedo * interiorAmbient * interiorShade * (1.0 - interiorHeatStrength);
totalEmissiveRadiance += mix(interiorAlbedo, vec3(1.0, 0.7, 0.4), 0.5)
  * interiorGlow * (0.7 + 0.6 * interiorHeight) * interiorShade;
totalEmissiveRadiance += interiorHeat * interiorShade;
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
