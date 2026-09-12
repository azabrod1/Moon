/**
 * How each material family LOOKS on a section face: colour, roughness,
 * metalness, glow, pattern, motion, relief, an ambient floor and a depth
 * gradient, keyed by family and phase. Art, not science — the inspector
 * says once that these are illustrative treatments. The composition
 * legend's swatches use exactly these colours (after the depth tint), so
 * the key and the face can never disagree.
 *
 * Phase changes the response, not the caption: solid and liquid iron are
 * different looks, and solid rock (convection cells, no cracks) is not
 * molten rock (dark cooled plates split by glowing fissures). Families, not
 * per-planet shaders: one noise (the Sun's, shared/shaders/sun.ts) feeds
 * every pattern, and a body's regions only choose family and phase — the
 * schema's own vocabulary (interiorTypes MaterialFamily and Phase), so a
 * model can never name a look this table lacks. A region may carry a small
 * `look` adjustment (a hue turn and a saturation, applied by adjustArt) so
 * Mars reads rustier than Venus; nothing else is overridable per model.
 * Heat comes from the region's temperature (incandescence, below), and the
 * vocabulary stays fixed across bodies.
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
export type PatternKind = 'none' | 'grain' | 'swirl' | 'flow' | 'caustic' | 'banding' | 'mottle' | 'crystal' | 'lava' | 'mineral' | 'hatch';

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
  mineral: 9,
  hatch: 10,
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
  /** Multiplier on the region's incandescent radiance: below 1 for a family whose
   *  material should win over its heat (a metallic-hydrogen mirror, an ionic sea). */
  heatGain: number;
  /** Tint on the incandescent radiance, sRGB hex: white for a blackbody glow, warm
   *  gold for metallic hydrogen, the family's own blue for a conducting sea. */
  heatTint: number;
  /** The region is a light, not a lit surface (a star's plasma): no albedo, its
   *  patterned palette is its emission, scaled by its place in the body's heat. */
  selfLit: boolean;
}

type FamilyParams = Omit<ArtParams, 'heatTint' | 'selfLit'> & Partial<Pick<ArtParams, 'heatTint' | 'selfLit'>>;

function family(params: FamilyParams): ArtParams {
  return { heatTint: 0xffffff, selfLit: false, ...params };
}

const FAMILY_DEFAULT: Readonly<Record<MaterialFamily, ArtParams>> = {
  metal: family({ colorA: 0xb8852c, colorB: 0xf2d27c, roughness: 0.5, metalness: 0.55, glow: 0.12, pattern: 'grain', motion: 0, scale: 75, relief: 7, depthGradient: 0.2, ambient: 0.22, heatGain: 1 }),
  // Solid rock: convection cells drawn as radial plumes, olivine-brown at the top and glowing
  // toward the bottom by its own heat. No cracks: a solid mantle has none.
  silicate: family({ colorA: 0x4a3520, colorB: 0x8a4a22, roughness: 0.7, metalness: 0, glow: 0, pattern: 'mineral', motion: 0.012, scale: 6, relief: 3, depthGradient: 0.3, ambient: 0.16, heatGain: 1 }),
  // Ice: glassy, faceted, with a cold self-lit floor so the key's warmth never bleaches its blue.
  ice: family({ colorA: 0xbfdcee, colorB: 0xeaf5fb, roughness: 0.25, metalness: 0, glow: 0, pattern: 'crystal', motion: 0, scale: 40, relief: 2, depthGradient: 0.2, ambient: 0.45, heatGain: 1 }),
  // Water: deep, dark, lit from the ice above it, with a soft two-octave shimmer.
  water: family({ colorA: 0x06182e, colorB: 0x1f5f9a, roughness: 0.4, metalness: 0, glow: 0, pattern: 'caustic', motion: 0.12, scale: 40, relief: 0.6, depthGradient: 0.35, ambient: 0.2, heatGain: 1 }),
  // Envelope: broad soft zonal bands, cream at the top, amber and turbulent below; its hot
  // base glows warm through the bands rather than whiting them out.
  hydrogen: family({ colorA: 0xa8823f, colorB: 0xf6ead0, roughness: 0.85, metalness: 0, glow: 0, pattern: 'banding', motion: 0.03, scale: 40, relief: 0, depthGradient: 0.35, ambient: 0.18, heatGain: 0.4, heatTint: 0xffd9a0 }),
  // A dark liquid mirror with a gold glow inside it, not a white blast.
  metallicHydrogen: family({ colorA: 0x1e2630, colorB: 0x7d8a9a, roughness: 0.15, metalness: 0.6, glow: 0.05, pattern: 'flow', motion: 0.05, scale: 5, relief: 1.6, depthGradient: 0.15, ambient: 0.22, heatGain: 0.25, heatTint: 0xffcc80 }),
  // A conducting sea: its own electric teal wins over the heat, which glows through it.
  ionicFluid: family({ colorA: 0x1f7f9a, colorB: 0x5fc8e0, roughness: 0.3, metalness: 0.3, glow: 0.05, pattern: 'flow', motion: 0.06, scale: 6, relief: 2, depthGradient: 0.25, ambient: 0.2, heatGain: 0.3, heatTint: 0x60c8ff }),
  // A star: every region is a light. The palette (amber to yellow-white) is the emission,
  // granulated at the surface and boiling in cells below, brightest at the core.
  plasma: family({ colorA: 0xff9a2a, colorB: 0xffe0a0, roughness: 1, metalness: 0, glow: 0, pattern: 'mottle', motion: 0.2, scale: 30, relief: 0, depthGradient: 0, ambient: 0, heatGain: 1, selfLit: true }),
  // A mix: cold it is a mottled rock-and-ice mud; hot (a giant's diluted core) it glows a
  // deep gold through its own mottle rather than blasting white.
  mixed: family({ colorA: 0x6c5744, colorB: 0xb8a088, roughness: 0.9, metalness: 0, glow: 0, pattern: 'mottle', motion: 0, scale: 12, relief: 2.5, depthGradient: 0.25, ambient: 0.16, heatGain: 0.45, heatTint: 0xffd090 }),
  // Unknown: the same hatch Temperature mode uses for "not known", lighter, so the disc reads
  // as deliberately blank rather than unfinished.
  unresolved: family({ colorA: 0x5c6068, colorB: 0x7a7e86, roughness: 1, metalness: 0, glow: 0, pattern: 'hatch', motion: 0, scale: 1, relief: 0, depthGradient: 0.1, ambient: 0.2, heatGain: 1 }),
};

/** Phase-specific responses that differ from the family default. A liquid
 *  metal flows; a solid one has grain. Molten rock is a lava field — dark
 *  cooled plates split by glowing fissures — and a partial melt is rock with
 *  those fissures beginning in it. Superionic water (Uranus and Neptune) is a
 *  dark crystalline conductor, not a sea. A metal whose phase is unresolved
 *  keeps the family default. */
const PHASE_OVERRIDE: Readonly<Partial<Record<`${MaterialFamily}:${Phase}`, Partial<ArtParams>>>> = {
  'metal:liquidMetal': { colorA: 0xc8892a, colorB: 0xffd978, roughness: 0.32, metalness: 0.6, glow: 0.2, pattern: 'flow', motion: 0.08, scale: 6, relief: 1.3 },
  'metal:liquid': { colorA: 0xc8892a, colorB: 0xffd978, roughness: 0.32, metalness: 0.6, glow: 0.2, pattern: 'flow', motion: 0.08, scale: 6, relief: 1.3 },
  'metal:solid': { colorA: 0xd39a3a, colorB: 0xffe9a0, roughness: 0.5, metalness: 0.5, glow: 0.34 },
  'silicate:liquid': { colorA: 0x3a1208, colorB: 0xff9a3a, roughness: 0.5, glow: 0.2, pattern: 'lava', motion: 0.05, scale: 5, relief: 2 },
  'silicate:partialMelt': { colorA: 0x3f1a0e, colorB: 0xc86a34, roughness: 0.65, glow: 0.1, pattern: 'lava', motion: 0.03, scale: 6, relief: 3 },
  'water:superionic': { colorA: 0x102a44, colorB: 0x2a6a8a, roughness: 0.35, metalness: 0.25, pattern: 'crystal', motion: 0, scale: 24, relief: 1.2, depthGradient: 0.25, ambient: 0.18, heatGain: 0.3, heatTint: 0x5fb8ff },
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

/** Multiply two sRGB hex colours channel by channel (a tint). */
export function tintHexColor(hex: number, tint: number): number {
  const channel = (shift: number) => Math.round((((hex >> shift) & 0xff) * ((tint >> shift) & 0xff)) / 255);
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

/**
 * Turn an sRGB hex colour's hue by `hueShiftDeg` and scale its saturation by
 * `saturation` (1 leaves it), keeping its lightness: a region's `look`
 * adjustment, applied to both tones so the swatch and the face agree.
 */
export function adjustHexColor(hex: number, hueShiftDeg: number, saturation: number): number {
  if (hueShiftDeg === 0 && saturation === 1) return hex;
  const red = ((hex >> 16) & 0xff) / 255;
  const green = ((hex >> 8) & 0xff) / 255;
  const blue = (hex & 0xff) / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  const delta = max - min;
  let hue = 0;
  let sat = 0;
  if (delta > 1e-6) {
    sat = delta / (1 - Math.abs(2 * lightness - 1));
    if (max === red) hue = ((green - blue) / delta) % 6;
    else if (max === green) hue = (blue - red) / delta + 2;
    else hue = (red - green) / delta + 4;
    hue = (((hue * 60) % 360) + 360) % 360;
  }
  hue = (((hue + hueShiftDeg) % 360) + 360) % 360;
  sat = Math.max(0, Math.min(1, sat * saturation));
  const chroma = (1 - Math.abs(2 * lightness - 1)) * sat;
  const second = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const match = lightness - chroma / 2;
  const sector = Math.min(Math.floor(hue / 60), 5);
  const sectors: [number, number, number][] = [
    [chroma, second, 0],
    [second, chroma, 0],
    [0, chroma, second],
    [0, second, chroma],
    [second, 0, chroma],
    [chroma, 0, second],
  ];
  const [red1, green1, blue1] = sectors[sector];
  const toByte = (value: number) => Math.max(0, Math.min(255, Math.round((value + match) * 255)));
  return (toByte(red1) << 16) | (toByte(green1) << 8) | toByte(blue1);
}

/** A region's `look` adjustment: a hue turn in degrees and a saturation scale. */
export interface LookAdjustment {
  hueShiftDeg?: number;
  saturation?: number;
}

/** A region's look with its `look` adjustment applied to both tones. */
export function adjustArt(art: ArtParams, look: LookAdjustment | undefined): ArtParams {
  if (!look) return art;
  const hueShiftDeg = look.hueShiftDeg ?? 0;
  const saturation = look.saturation ?? 1;
  if (hueShiftDeg === 0 && saturation === 1) return art;
  return { ...art, colorA: adjustHexColor(art.colorA, hueShiftDeg, saturation), colorB: adjustHexColor(art.colorB, hueShiftDeg, saturation) };
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
  plasma: 'fully ionised',
  unresolved: 'phase unresolved',
};

/**
 * Incandescence: the light a region gives off by its own heat, from its
 * temperature alone. The colour is the forge ramp — what the eye expects of
 * hot matter, and what every cutaway ever painted agrees on: a dull red at
 * the Draper point (the ~800 K at which hot matter first shows), cherry,
 * orange, amber, yellow-white, and white from about 6,000 K on. Hotter is
 * never bluer: a camera would see a 5,000 K core as Planckian white and a
 * star's zones as blue-white, but the ramp stops at white and lets the
 * radiance carry the ordering. The strength ramps from the Draper point to
 * a plateau by ~4,000 K; the radiance sits under the bloom threshold for
 * every region but the body's hottest, which the scene lifts by
 * INCANDESCENCE_HOTTEST_BOOST so only a core bleeds. In HDR, linear.
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
/** Radiance at full strength for any region but the body's hottest: under the tone curve's
 *  knee and the bloom threshold, so a mantle and an outer core keep their colour. */
const INCANDESCENCE_PEAK = 0.6;
/** The body's hottest region is lifted by this toward its centre (the shader grades the lift
 *  by depth within the region), so the middle of a core is the one thing that blooms. */
export const INCANDESCENCE_HOTTEST_BOOST = 2.2;
/** Above this the radiance rises on a log of the temperature: a star's zones, millions of
 *  kelvin apart and all white, still read in order — a fusion core is a stronger light than
 *  the zone that boils above it. */
const INCANDESCENCE_HOT_K = 20_000;
const INCANDESCENCE_HOT_DECADES = 3;
const INCANDESCENCE_HOT_BOOST = 4;

/** The forge ramp, sRGB, by physical temperature. Linear between stops; white beyond. */
const FORGE_STOPS: readonly (readonly [number, readonly [number, number, number]])[] = [
  [800, [0.55, 0.08, 0.02]],
  [1300, [0.85, 0.18, 0.05]],
  [2000, [1.0, 0.45, 0.08]],
  [3000, [1.0, 0.68, 0.22]],
  [4500, [1.0, 0.78, 0.35]],
  [6000, [1.0, 0.93, 0.72]],
];

export function forgeSrgb(temperatureK: number): [number, number, number] {
  const first = FORGE_STOPS[0];
  const last = FORGE_STOPS[FORGE_STOPS.length - 1];
  if (temperatureK <= first[0]) return [first[1][0], first[1][1], first[1][2]];
  if (temperatureK >= last[0]) return [last[1][0], last[1][1], last[1][2]];
  for (let index = 1; index < FORGE_STOPS.length; index++) {
    const [highK, highColor] = FORGE_STOPS[index];
    if (temperatureK > highK) continue;
    const [lowK, lowColor] = FORGE_STOPS[index - 1];
    const t = (temperatureK - lowK) / (highK - lowK);
    return [
      lowColor[0] + (highColor[0] - lowColor[0]) * t,
      lowColor[1] + (highColor[1] - lowColor[1]) * t,
      lowColor[2] + (highColor[2] - lowColor[2]) * t,
    ];
  }
  return [last[1][0], last[1][1], last[1][2]];
}

export function incandescence(temperatureK: number): Incandescence {
  const ramp = Math.max(0, Math.min(1, (temperatureK - DRAPER_POINT_K) / (INCANDESCENCE_FULL_K - DRAPER_POINT_K)));
  const strength = Math.pow(ramp, 0.8);
  const [red, green, blue] = forgeSrgb(temperatureK);
  const hotDecades = Math.min(1, Math.max(0, Math.log10(Math.max(temperatureK, 1) / INCANDESCENCE_HOT_K) / INCANDESCENCE_HOT_DECADES));
  const radiance = (0.03 * strength + INCANDESCENCE_PEAK * Math.pow(strength, 0.9)) * (1 + INCANDESCENCE_HOT_BOOST * hotDecades * hotDecades);
  const linear = (channel: number) => Math.pow(channel, 2.2) * radiance;
  const display = (channel: number) => Math.round(Math.max(0, Math.min(1, channel * (0.35 + 0.65 * strength))) * 255);
  return {
    emission: [linear(red), linear(green), linear(blue)],
    strength,
    swatchHex: (display(red) << 16) | (display(green) << 8) | display(blue),
  };
}

/** The legend swatch: the albedo tone for a cold region, the incandescent
 *  colour (through the family's heat tint) for a hot one, blended by how
 *  much the heat dominates. A self-lit region's swatch is its own palette. */
export function swatchHex(art: ArtParams, heat: Incandescence): number {
  if (art.selfLit || heat.strength <= 0) return art.colorA;
  const heatHex = tintHexColor(heat.swatchHex, art.heatTint);
  const mix = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);
  const t = Math.min(1, heat.strength * 1.2) * (0.5 + 0.5 * art.heatGain);
  const red = mix((art.colorA >> 16) & 0xff, (heatHex >> 16) & 0xff, t);
  const green = mix((art.colorA >> 8) & 0xff, (heatHex >> 8) & 0xff, t);
  const blue = mix(art.colorA & 0xff, heatHex & 0xff, t);
  return (red << 16) | (green << 8) | blue;
}
