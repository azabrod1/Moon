/**
 * The section-face material for the Look-inside tool: a MeshStandardMaterial
 * whose albedo, roughness, emission and normal are decided per pixel from
 * the radial region the pixel falls in, injected through onBeforeCompile so
 * the faces take the same PBR lighting as the skin (plan §5, path (a)).
 *
 * The face geometry is a unit half-disc in its own XY plane; the vertex
 * stage hands the fragment its local XY (radius in DISPLAY space, 0..1) and
 * its world position. Region boundaries arrive in display space (the mode
 * runs the Readable remap on the CPU), inside-out and increasing, up to
 * MAX_REGIONS of them; each boundary is antialiased with a `fwidth` band and
 * the regions blend outside-in, so the loop is branch-free and a thin crust
 * is never lost to a texel.
 *
 * Patterns are 3-D fields in BODY space (the world position turned by the
 * inverse of the body's pose), so a face shows a coherent slice of a solid
 * — orbit the camera or spin the body and the grain, swirl or banding stays
 * fixed to the material, never painted on the face. Jupiter's banding is
 * cylindrical about the spin axis, as deep zonal flows are. One noise feeds
 * everything (the Sun's, shared/shaders/sun.ts). Motion runs on the tool's
 * presentation clock, never the solar-system clock.
 *
 * Injection points, in the order meshphysical.glsl.js runs them:
 *   after <color_fragment>        the region resolve → diffuseColor.rgb
 *   after <roughnessmap_fragment> roughnessFactor
 *   after <normal_fragment_maps>  a small derivative bump from the pattern
 *   after <emissivemap_fragment>  totalEmissiveRadiance
 */
import * as THREE from 'three';
import { sunNoiseGLSL } from '../../shared/shaders/sun';
import { PATTERN_INDEX, type ArtParams } from '../data/artParams';

export const MAX_REGIONS = 8;

export interface SectionUniforms {
  /** Outer radius of region k in display space, inside-out, increasing; the last used one is 1. */
  uOuter: { value: number[] };
  uColorA: { value: THREE.Color[] };
  uColorB: { value: THREE.Color[] };
  uRough: { value: number[] };
  uGlow: { value: number[] };
  uPattern: { value: number[] };
  uMotion: { value: number[] };
  uScale: { value: number[] };
  uRelief: { value: number[] };
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
    uColorA: { value: colors() },
    uColorB: { value: colors() },
    uRough: { value: numbers().map(() => 1) },
    uGlow: { value: numbers() },
    uPattern: { value: numbers() },
    uMotion: { value: numbers() },
    uScale: { value: numbers().map(() => 1) },
    uRelief: { value: numbers() },
    uCount: { value: 1 },
    uWorldToBody: { value: new THREE.Matrix3() },
    uTime: { value: 0 },
    uCorner: { value: 0 },
  };
}

export interface SectionRegionLook {
  /** Outer radius in display space, 0..1. */
  outerDisplay: number;
  art: ArtParams;
}

/**
 * Write a body's regions into the uniforms, inside-out. Colours are
 * converted to linear here: the injected code writes straight into
 * diffuseColor, which three expects in working (linear) space.
 */
export function writeSectionRegions(uniforms: SectionUniforms, regionsInsideOut: readonly SectionRegionLook[]): void {
  const count = Math.min(regionsInsideOut.length, MAX_REGIONS);
  uniforms.uCount.value = Math.max(1, count);
  for (let index = 0; index < MAX_REGIONS; index++) {
    const region = regionsInsideOut[Math.min(index, count - 1)];
    uniforms.uOuter.value[index] = index < count ? region.outerDisplay : 1;
    uniforms.uColorA.value[index].setHex(region.art.colorA);
    uniforms.uColorB.value[index].setHex(region.art.colorB);
    uniforms.uRough.value[index] = region.art.roughness;
    uniforms.uGlow.value[index] = region.art.glow;
    uniforms.uPattern.value[index] = PATTERN_INDEX[region.art.pattern];
    uniforms.uMotion.value[index] = region.art.motion;
    uniforms.uScale.value[index] = region.art.scale;
    uniforms.uRelief.value[index] = region.art.relief;
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
uniform vec3 uColorA[${MAX_REGIONS}];
uniform vec3 uColorB[${MAX_REGIONS}];
uniform float uRough[${MAX_REGIONS}];
uniform float uGlow[${MAX_REGIONS}];
uniform float uPattern[${MAX_REGIONS}];
uniform float uMotion[${MAX_REGIONS}];
uniform float uScale[${MAX_REGIONS}];
uniform float uRelief[${MAX_REGIONS}];
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
// by artParams.PATTERN_INDEX; the height feeds the derivative bump.
vec4 sectionSample(int k, vec3 bodyPoint) {
  int pattern = int(uPattern[k] + 0.5);
  float scale = uScale[k];
  float drift = uTime * uMotion[k];
  float mixValue = 0.5;
  if (pattern == 1) {
    // grain: faceted crystalline metal
    float cells = noise3(bodyPoint * scale);
    float fine = noise3(bodyPoint * scale * 3.1 + 7.0);
    mixValue = step(0.55, cells) * 0.55 + fine * 0.45;
  } else if (pattern == 2) {
    // swirl: slow convection in a solid-state mantle
    vec3 q = bodyPoint * scale + vec3(drift, -drift * 0.7, drift * 0.4);
    float warp = sectionFbm(q);
    mixValue = sectionFbm(q + 1.7 * vec3(warp, -warp, warp * 0.5));
  } else if (pattern == 3) {
    // flow: liquid metal, faster and more layered
    vec3 q = bodyPoint * scale + vec3(drift * 2.0, drift, -drift * 1.5);
    mixValue = sectionFbm(q * 1.5 + sectionFbm(q) * 2.0);
  } else if (pattern == 4) {
    // caustic: ridged shimmer for water and brine
    vec3 q = bodyPoint * scale + vec3(drift, drift * 1.3, -drift);
    float ridge = 1.0 - abs(2.0 * noise3(q) - 1.0);
    mixValue = pow(ridge, 3.0) * 0.8 + noise3(q * 2.3) * 0.2;
  } else if (pattern == 5) {
    // banding: cylinders about the spin axis (body-space Y), softened by noise
    float axial = length(bodyPoint.xz);
    float wobble = sectionFbm(bodyPoint * 3.0 + vec3(drift)) * 2.0;
    mixValue = 0.5 + 0.5 * sin(axial * scale + wobble);
  } else if (pattern == 6) {
    // mottle: an unresolved mix
    mixValue = sectionFbm(bodyPoint * scale);
  } else if (pattern == 7) {
    // crystal: faint large facets in ice
    mixValue = 0.35 + 0.3 * step(0.5, noise3(bodyPoint * scale)) + 0.2 * noise3(bodyPoint * scale * 4.0);
  }
  return vec4(mix(uColorA[k], uColorB[k], mixValue), mixValue);
}
`;

/** After <color_fragment>: resolve the region and its blended look. */
const SECTION_RESOLVE = /* glsl */ `
float sectionRadius = length(vSectionLocal);
float sectionBand = max(fwidth(sectionRadius), 1e-5);
vec3 sectionBodyPoint = uWorldToBody * vSectionWorld;
vec4 sectionFirst = sectionSample(0, sectionBodyPoint);
vec3 interiorAlbedo = sectionFirst.rgb;
float interiorHeight = sectionFirst.a;
float interiorRough = uRough[0];
float interiorGlow = uGlow[0];
float interiorRelief = uRelief[0];
for (int k = 1; k < ${MAX_REGIONS}; k++) {
  if (k >= uCount) break;
  float t = smoothstep(uOuter[k - 1] - sectionBand, uOuter[k - 1] + sectionBand, sectionRadius);
  vec4 sampleK = sectionSample(k, sectionBodyPoint);
  interiorAlbedo = mix(interiorAlbedo, sampleK.rgb, t);
  interiorHeight = mix(interiorHeight, sampleK.a, t);
  interiorRough = mix(interiorRough, uRough[k], t);
  interiorGlow = mix(interiorGlow, uGlow[k], t);
  interiorRelief = mix(interiorRelief, uRelief[k], t);
}
// The crease where the two faces meet: a contact shadow fading out along
// the face's radial axis, gone at Section where the faces are coplanar.
float interiorCrease = 1.0 - uCorner * 0.45 * (1.0 - smoothstep(0.0, 0.14, vSectionLocal.x));
diffuseColor.rgb = interiorAlbedo * interiorCrease;
`;

const SECTION_ROUGHNESS = /* glsl */ `
roughnessFactor = interiorRough;
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

/** The faces are a diagram as much as a surface: a shadowed face must stay
 *  legible, so every face carries a small ambient floor of its own albedo
 *  (the studio key still tells the two faces apart), plus the region's glow. */
const SECTION_AMBIENT_FLOOR = 0.16;

const SECTION_EMISSIVE = /* glsl */ `
totalEmissiveRadiance += interiorAlbedo * ${SECTION_AMBIENT_FLOOR.toFixed(2)} * interiorCrease;
totalEmissiveRadiance += mix(interiorAlbedo, vec3(1.0, 0.86, 0.62), 0.3) * interiorGlow * interiorCrease;
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
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${SECTION_NORMAL}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${SECTION_EMISSIVE}`);
  };
  material.customProgramCacheKey = () => 'interiorSection';
  return material;
}
