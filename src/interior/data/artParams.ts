/**
 * How each material family LOOKS on a section face: colour, roughness,
 * glow, pattern and motion, keyed by family and phase. Art, not science —
 * the inspector says once that these are illustrative treatments. The
 * composition legend's swatches use exactly these colours, so the key and
 * the face can never disagree.
 *
 * Phase changes the response, not the caption: solid and liquid iron are
 * different looks. Families, not per-planet shaders: one noise (the Sun's,
 * shared/shaders/sun.ts) feeds every pattern, and a body's regions only
 * choose family and phase. A model may override a region's glow where a
 * presentation choice is justified (a core drawn hot); nothing else is
 * overridable, so the vocabulary stays fixed across bodies.
 */

export type MaterialFamily =
  | 'metal'
  | 'rock'
  | 'ice'
  | 'water'
  | 'hydrogen'
  | 'metallicHydrogen'
  | 'ionic'
  | 'plasma'
  | 'mixed'
  | 'unresolved';

export type MaterialPhase = 'solid' | 'liquid' | 'gas' | 'supercritical' | 'plasma' | 'mixed';

/** The shader's pattern switch; the index is what the uniform carries. */
export type PatternKind = 'none' | 'grain' | 'swirl' | 'flow' | 'caustic' | 'banding' | 'mottle' | 'crystal';

export const PATTERN_INDEX: Readonly<Record<PatternKind, number>> = {
  none: 0,
  grain: 1,
  swirl: 2,
  flow: 3,
  caustic: 4,
  banding: 5,
  mottle: 6,
  crystal: 7,
};

export interface ArtParams {
  /** Base tone, sRGB hex. The legend swatch. */
  colorA: number;
  /** Second tone the pattern mixes toward, sRGB hex. */
  colorB: number;
  roughness: number;
  /** Emissive strength added to the lit result; 0 for a cold region. */
  glow: number;
  pattern: PatternKind;
  /** Pattern drift in pattern units per presentation second; 0 for a still pattern. */
  motion: number;
  /** Pattern frequency in body radii; larger is finer. */
  scale: number;
  /** Normal perturbation strength from the pattern's height; 0 for a flat face. */
  relief: number;
}

const FAMILY_DEFAULT: Readonly<Record<MaterialFamily, ArtParams>> = {
  metal: { colorA: 0xc79a3e, colorB: 0xf0d27a, roughness: 0.5, glow: 0.12, pattern: 'grain', motion: 0, scale: 75, relief: 0.35 },
  rock: { colorA: 0x9c4f2e, colorB: 0xd8824f, roughness: 0.88, glow: 0.05, pattern: 'swirl', motion: 0.02, scale: 4.5, relief: 0.25 },
  ice: { colorA: 0xbfdcee, colorB: 0xeaf5fb, roughness: 0.45, glow: 0, pattern: 'crystal', motion: 0, scale: 30, relief: 0.15 },
  water: { colorA: 0x184a8a, colorB: 0x3f8fd6, roughness: 0.2, glow: 0, pattern: 'caustic', motion: 0.12, scale: 26, relief: 0.1 },
  hydrogen: { colorA: 0xd9c9a5, colorB: 0xf4e9cf, roughness: 0.9, glow: 0, pattern: 'banding', motion: 0.03, scale: 40, relief: 0 },
  metallicHydrogen: { colorA: 0x9ea7b1, colorB: 0xd7dde3, roughness: 0.28, glow: 0.05, pattern: 'flow', motion: 0.05, scale: 5, relief: 0.15 },
  ionic: { colorA: 0x2f8f8a, colorB: 0x7fd6cf, roughness: 0.35, glow: 0.05, pattern: 'flow', motion: 0.06, scale: 6, relief: 0.1 },
  plasma: { colorA: 0xffd27a, colorB: 0xfff4d6, roughness: 1, glow: 0.8, pattern: 'mottle', motion: 0.2, scale: 30, relief: 0 },
  mixed: { colorA: 0x7b6a5c, colorB: 0xa8988a, roughness: 0.95, glow: 0, pattern: 'mottle', motion: 0, scale: 18, relief: 0.3 },
  unresolved: { colorA: 0x666a72, colorB: 0x70747c, roughness: 1, glow: 0, pattern: 'none', motion: 0, scale: 1, relief: 0 },
};

/** Phase-specific responses that differ from the family default. */
const PHASE_OVERRIDE: Readonly<Partial<Record<`${MaterialFamily}:${MaterialPhase}`, Partial<ArtParams>>>> = {
  'metal:liquid': { colorA: 0xd9a545, colorB: 0xffe28a, roughness: 0.3, glow: 0.16, pattern: 'flow', motion: 0.08, scale: 6, relief: 0.12 },
  'metal:solid': { glow: 0.3 },
  'rock:liquid': { colorA: 0xb8481f, colorB: 0xffa04a, roughness: 0.5, glow: 0.25, pattern: 'flow', motion: 0.06, scale: 5, relief: 0.15 },
  'rock:mixed': { pattern: 'mottle', scale: 10, relief: 0.3 },
  'ice:liquid': { colorA: 0x184a8a, colorB: 0x3f8fd6, roughness: 0.2, pattern: 'caustic', motion: 0.12, scale: 26, relief: 0.1 },
  'hydrogen:supercritical': { colorA: 0xcdbb95, colorB: 0xe8d9b8, roughness: 0.75 },
  'mixed:solid': { pattern: 'mottle' },
  'mixed:mixed': { pattern: 'mottle' },
};

export function artParamsFor(family: MaterialFamily, phase: MaterialPhase, glowOverride?: number): ArtParams {
  const base = FAMILY_DEFAULT[family];
  const override = PHASE_OVERRIDE[`${family}:${phase}`];
  const merged = override ? { ...base, ...override } : { ...base };
  if (glowOverride !== undefined) merged.glow = glowOverride;
  return merged;
}

/** Human labels for the legend and the inspector. */
export const FAMILY_LABEL: Readonly<Record<MaterialFamily, string>> = {
  metal: 'Iron and nickel',
  rock: 'Silicate rock',
  ice: 'Ice',
  water: 'Liquid water',
  hydrogen: 'Hydrogen and helium',
  metallicHydrogen: 'Metallic hydrogen',
  ionic: 'Ionic fluid',
  plasma: 'Plasma',
  mixed: 'Mixed',
  unresolved: 'Unresolved',
};

export const PHASE_LABEL: Readonly<Record<MaterialPhase, string>> = {
  solid: 'solid',
  liquid: 'liquid',
  gas: 'gas',
  supercritical: 'supercritical fluid',
  plasma: 'plasma',
  mixed: 'mixed phases',
};
