/**
 * How each material family LOOKS on a section face: colour, roughness,
 * metalness, glow, pattern, motion, relief, an ambient floor and a depth
 * gradient, keyed by family and phase. Art, not science — the inspector
 * says once that these are illustrative treatments. The composition
 * legend's swatches use exactly these colours (after the depth tint), so
 * the key and the face can never disagree.
 *
 * Phase changes the response, not the caption: solid and liquid iron are
 * different looks. Families, not per-planet shaders: one noise (the Sun's,
 * shared/shaders/sun.ts) feeds every pattern, and a body's regions only
 * choose family and phase — the schema's own vocabulary (interiorTypes
 * MaterialFamily and Phase), so a model can never name a look this table
 * lacks. Nothing is overridable per model: heat comes from the region's
 * temperature (incandescence, below), and the vocabulary stays fixed
 * across bodies.
 *
 * Depth is drawn two ways, both policy here. Within a region, the face
 * darkens from the region's top to its bottom (`depthGradient`), so each
 * region reads as a shell lit from above rather than a painted ring.
 * Across regions of one family, the deeper region is tinted darker
 * (`FAMILY_DEPTH_DARKENING`, applied by depthTint), so Earth's three rock
 * regions have three swatches and the disc gains a tonal range. Cores are
 * exempt: they are drawn hot, and heat, not darkness, says "deep" there.
 */

import type { MaterialFamily, Phase } from './interiorTypes';

/** The shader's pattern switch; the index is what the uniform carries. */
export type PatternKind = 'none' | 'grain' | 'swirl' | 'flow' | 'caustic' | 'banding' | 'mottle' | 'crystal' | 'lava';

export const PATTERN_INDEX: Readonly<Record<PatternKind, number>> = {
  none: 0,
  grain: 1,
  swirl: 2,
  flow: 3,
  caustic: 4,
  banding: 5,
  mottle: 6,
  crystal: 7,
  lava: 8,
};

export interface ArtParams {
  /** Base tone, sRGB hex. The legend swatch. */
  colorA: number;
  /** Second tone the pattern mixes toward, sRGB hex. */
  colorB: number;
  roughness: number;
  /** PBR metalness: a metal reflects the studio in its own colour. */
  metalness: number;
  /** Emissive strength added to the lit result; 0 for a cold region. */
  glow: number;
  pattern: PatternKind;
  /** Pattern drift in pattern units per presentation second; 0 for a still pattern. */
  motion: number;
  /** Pattern frequency in body radii; larger is finer. */
  scale: number;
  /** Normal perturbation strength from the pattern's height (a bump scale on
   *  its screen-space derivative, so single digits are visible); 0 for a flat face. */
  relief: number;
  /** Fraction the face darkens from the region's top to its bottom. */
  depthGradient: number;
  /** Self-lit floor as a fraction of albedo, so a shadowed face stays legible. */
  ambient: number;
}

const FAMILY_DEFAULT: Readonly<Record<MaterialFamily, ArtParams>> = {
  metal: { colorA: 0xb8852c, colorB: 0xf2d27c, roughness: 0.5, metalness: 0.55, glow: 0.12, pattern: 'grain', motion: 0, scale: 75, relief: 7, depthGradient: 0.2, ambient: 0.22 },
  silicate: { colorA: 0x3d1f13, colorB: 0x9a5030, roughness: 0.9, metalness: 0, glow: 0, pattern: 'lava', motion: 0.015, scale: 6, relief: 4, depthGradient: 0.3, ambient: 0.16 },
  ice: { colorA: 0xbfdcee, colorB: 0xeaf5fb, roughness: 0.4, metalness: 0, glow: 0, pattern: 'crystal', motion: 0, scale: 30, relief: 0.5, depthGradient: 0.2, ambient: 0.3 },
  water: { colorA: 0x184a8a, colorB: 0x3f8fd6, roughness: 0.2, metalness: 0, glow: 0, pattern: 'caustic', motion: 0.12, scale: 26, relief: 0.8, depthGradient: 0.35, ambient: 0.2 },
  hydrogen: { colorA: 0xcbb283, colorB: 0xf6ead0, roughness: 0.85, metalness: 0, glow: 0, pattern: 'banding', motion: 0.03, scale: 110, relief: 0, depthGradient: 0.3, ambient: 0.18 },
  metallicHydrogen: { colorA: 0x8c98a6, colorB: 0xe8edf2, roughness: 0.3, metalness: 0.6, glow: 0.05, pattern: 'flow', motion: 0.05, scale: 5, relief: 1.6, depthGradient: 0.15, ambient: 0.22 },
  ionicFluid: { colorA: 0x2f8f8a, colorB: 0x7fd6cf, roughness: 0.3, metalness: 0.3, glow: 0.05, pattern: 'flow', motion: 0.06, scale: 6, relief: 2, depthGradient: 0.25, ambient: 0.2 },
  plasma: { colorA: 0xffd27a, colorB: 0xfff4d6, roughness: 1, metalness: 0, glow: 0.8, pattern: 'mottle', motion: 0.2, scale: 30, relief: 0, depthGradient: 0, ambient: 0.3 },
  mixed: { colorA: 0x6c5744, colorB: 0xb8a088, roughness: 0.9, metalness: 0.1, glow: 0, pattern: 'mottle', motion: 0, scale: 12, relief: 4, depthGradient: 0.25, ambient: 0.16 },
  unresolved: { colorA: 0x666a72, colorB: 0x70747c, roughness: 1, metalness: 0, glow: 0, pattern: 'none', motion: 0, scale: 1, relief: 0, depthGradient: 0.1, ambient: 0.2 },
};

/** Phase-specific responses that differ from the family default. A liquid
 *  metal flows; a solid one has grain. Molten rock flows too, and a partial
 *  melt is rock with the flow beginning in it. Superionic water (Uranus and
 *  Neptune) is a dark crystalline conductor, not a sea. A metal whose phase
 *  is unresolved keeps the family default. */
const PHASE_OVERRIDE: Readonly<Partial<Record<`${MaterialFamily}:${Phase}`, Partial<ArtParams>>>> = {
  'metal:liquidMetal': { colorA: 0xc8892a, colorB: 0xffd978, roughness: 0.32, metalness: 0.6, glow: 0.2, pattern: 'flow', motion: 0.08, scale: 6, relief: 1.3 },
  'metal:liquid': { colorA: 0xc8892a, colorB: 0xffd978, roughness: 0.32, metalness: 0.6, glow: 0.2, pattern: 'flow', motion: 0.08, scale: 6, relief: 1.3 },
  'metal:solid': { colorA: 0xd39a3a, colorB: 0xffe9a0, roughness: 0.5, metalness: 0.5, glow: 0.34 },
  'silicate:liquid': { colorA: 0xb8481f, colorB: 0xffa04a, roughness: 0.5, glow: 0.3, pattern: 'flow', motion: 0.06, scale: 5, relief: 2 },
  'silicate:partialMelt': { colorA: 0x5a2a16, colorB: 0xc0663a, roughness: 0.75, glow: 0.1, pattern: 'lava', motion: 0.03, scale: 6, relief: 3 },
  'water:superionic': { colorA: 0x12303e, colorB: 0x2c6a7c, roughness: 0.35, metalness: 0.25, pattern: 'crystal', motion: 0, scale: 24, relief: 1.2, depthGradient: 0.25, ambient: 0.18 },
  'water:supercriticalFluid': { colorA: 0x1f5a86, colorB: 0x4f9bd0, roughness: 0.3, pattern: 'flow', motion: 0.08, scale: 8, relief: 1 },
  'hydrogen:supercriticalFluid': { colorA: 0xcdbb95, colorB: 0xe8d9b8, roughness: 0.7 },
  'mixed:solid': { pattern: 'mottle' },
};

/** How much darker a family's deeper regions are drawn than its shallower
 *  ones, at the centre of the body. Cores are drawn hot instead. */
export const FAMILY_DEPTH_DARKENING: Readonly<Record<MaterialFamily, number>> = {
  metal: 0,
  silicate: 0.5,
  ice: 0.25,
  water: 0.25,
  hydrogen: 0.35,
  metallicHydrogen: 0.1,
  ionicFluid: 0.2,
  plasma: 0,
  mixed: 0.15,
  unresolved: 0.1,
};

export function artParamsFor(family: MaterialFamily, phase: Phase): ArtParams {
  const base = FAMILY_DEFAULT[family];
  const override = PHASE_OVERRIDE[`${family}:${phase}`];
  return override ? { ...base, ...override } : { ...base };
}

/** Scale an sRGB hex colour's channels by `factor` (0..1 darkens). */
export function scaleHexColor(hex: number, factor: number): number {
  const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
  const red = clamp(((hex >> 16) & 0xff) * factor);
  const green = clamp(((hex >> 8) & 0xff) * factor);
  const blue = clamp((hex & 0xff) * factor);
  return (red << 16) | (green << 8) | blue;
}

/**
 * The family depth tint for a region whose mid-depth is `depthMidFraction`
 * (0 at the surface, 1 at the centre): both tones darkened by the family's
 * darkening, so the legend swatch and the face agree.
 */
export function depthTint(art: ArtParams, family: MaterialFamily, depthMidFraction: number): ArtParams {
  const darkening = FAMILY_DEPTH_DARKENING[family];
  if (darkening <= 0) return art;
  // Square root: the shallow regions are where the tonal steps have to be
  // visible (a crust, an upper mantle), and a linear ramp barely moves them.
  const factor = 1 - darkening * Math.sqrt(Math.max(0, Math.min(1, depthMidFraction)));
  return { ...art, colorA: scaleHexColor(art.colorA, factor), colorB: scaleHexColor(art.colorB, factor) };
}

/** Human labels for the legend and the inspector. */
export const FAMILY_LABEL: Readonly<Record<MaterialFamily, string>> = {
  metal: 'Iron and nickel',
  silicate: 'Silicate rock',
  ice: 'Ice',
  water: 'Water',
  hydrogen: 'Hydrogen and helium',
  metallicHydrogen: 'Metallic hydrogen',
  ionicFluid: 'Ionic fluid',
  plasma: 'Plasma',
  mixed: 'Mixed',
  unresolved: 'Unresolved',
};

export const PHASE_LABEL: Readonly<Record<Phase, string>> = {
  solid: 'solid',
  partialMelt: 'partly molten',
  liquid: 'liquid',
  supercriticalFluid: 'supercritical fluid',
  liquidMetal: 'liquid metal',
  superionic: 'superionic',
  gas: 'gas',
  plasma: 'plasma',
  unresolved: 'phase unresolved',
};

/**
 * Incandescence: the light a region gives off by its own heat, from its
 * temperature alone. The colour follows the Planckian locus (a fit of the
 * blackbody curve in sRGB, linearised for the renderer), and the strength
 * ramps from the Draper point — the ~800 K at which hot matter first shows
 * a dull red — up through orange and yellow to a white cap by ~4,000 K, in
 * HDR so the bloom pass can bleed it. The hotter a region, the less its
 * albedo matters: a face at 5,000 K is a light, not a surface.
 *
 * This is what a section through the body would really look like — the
 * mantle glows — which is why it is computed and not painted.
 */
export interface Incandescence {
  /** Emitted radiance, linear RGB, HDR (components may exceed 1). */
  emission: [number, number, number];
  /** 0 cold .. 1 fully incandescent: how much the heat dominates the albedo. */
  strength: number;
  /** Display colour for the legend swatch of a hot region, sRGB hex. */
  swatchHex: number;
}

export const DRAPER_POINT_K = 800;
const INCANDESCENCE_FULL_K = 3800;
const INCANDESCENCE_PEAK = 1.3;
/** Display warmth: the hue is taken at a compressed temperature — this
 *  fraction of the way from the Draper point up to MANTLE_K, and a smaller
 *  fraction beyond it. The strict Planckian white of a 5,000 K core is what
 *  a camera would see; the eye expects molten metal yellow-orange, and every
 *  cutaway ever painted agrees. Ordering is preserved: hotter is always
 *  whiter. Art, documented. */
const INCANDESCENCE_WARMTH = 0.55;
const INCANDESCENCE_WARMTH_ABOVE = 0.3;
const INCANDESCENCE_MANTLE_K = 2600;

function planckianSrgb(temperatureK: number): [number, number, number] {
  const t = Math.max(1000, Math.min(40_000, temperatureK)) / 100;
  const red = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const green = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const blue = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const clamp = (value: number) => Math.max(0, Math.min(255, value)) / 255;
  return [clamp(red), clamp(green), clamp(blue)];
}

export function incandescence(temperatureK: number): Incandescence {
  const ramp = Math.max(0, Math.min(1, (temperatureK - DRAPER_POINT_K) / (INCANDESCENCE_FULL_K - DRAPER_POINT_K)));
  const strength = Math.pow(ramp, 0.8);
  // Below the Draper point the red end of the fit still returns a colour, so
  // clamp the lookup at the point the eye first sees a glow.
  const displayK = DRAPER_POINT_K
    + (Math.min(temperatureK, INCANDESCENCE_MANTLE_K) - DRAPER_POINT_K) * INCANDESCENCE_WARMTH
    + Math.max(0, temperatureK - INCANDESCENCE_MANTLE_K) * INCANDESCENCE_WARMTH_ABOVE;
  const [red, green, blue] = planckianSrgb(Math.max(displayK, 1000));
  const radiance = 0.03 * strength + INCANDESCENCE_PEAK * Math.pow(strength, 0.9);
  const linear = (channel: number) => Math.pow(channel, 2.2) * radiance;
  const display = (channel: number) => Math.round(Math.max(0, Math.min(1, channel * (0.35 + 0.65 * strength))) * 255);
  return {
    emission: [linear(red), linear(green), linear(blue)],
    strength,
    swatchHex: (display(red) << 16) | (display(green) << 8) | display(blue),
  };
}

/** The legend swatch: the albedo tone for a cold region, the incandescent
 *  colour for a hot one, blended by how much the heat dominates. */
export function swatchHex(art: ArtParams, heat: Incandescence): number {
  if (heat.strength <= 0) return art.colorA;
  const mix = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);
  const t = Math.min(1, heat.strength * 1.2);
  const red = mix((art.colorA >> 16) & 0xff, (heat.swatchHex >> 16) & 0xff, t);
  const green = mix((art.colorA >> 8) & 0xff, (heat.swatchHex >> 8) & 0xff, t);
  const blue = mix(art.colorA & 0xff, heat.swatchHex & 0xff, t);
  return (red << 16) | (green << 8) | blue;
}
