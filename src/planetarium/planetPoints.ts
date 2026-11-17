/**
 * The planets as points in the surface view: what a planet looks like when
 * its disc is smaller than a pixel, which from any surface is almost always
 * (Jupiter from Earth is under 50″, a quarter of a pixel at a 45° field).
 *
 * Brightness is the planet's apparent magnitude (astronomy/planetMagnitude.ts,
 * the Almanac's equations), drawn through the starfield's own magnitude →
 * point mapping (world/starPointMapping.ts), so a planet is exactly as
 * visible as a star of the same magnitude: Mars at +1 is a +1 star, Neptune
 * past the catalog's anchor fades the way the faintest stars do. Its colour is
 * a star's colour at the planet's B−V index (Mallama, Krobusek & Pavlov 2017,
 * Icarus 282, Table 3 reference B and V), so planets and stars share one
 * colour scale too.
 *
 * The bright end. The star mapping stops growing at magnitude −0.45 (size)
 * and −1.44 (brightness, Sirius's own −1.46): Sirius, Jupiter and Venus would
 * draw as one point. A planet brighter than −1.44 keeps growing, along a
 * gentler size slope, out to the ceiling (Venus at its most brilliant from
 * Earth is −4.9; brighter skies, Venus from Mercury or Earth from Venus, hold
 * there). Its brightness rises too, but its brightest pixel stays under the
 * bloom line by a margin, like every star: a planet point never blooms, so it
 * reads the same with bloom off, without float targets, and beside the Sun.
 * Size carries the ordering (Venus over Jupiter over Sirius), compressed, as
 * any display must compress a factor of 16.
 *
 * As the field narrows and the disc resolves, the point hands over to the
 * planet's own drawn disc across the moon dots' crossfade window, shrinking
 * toward the disc and dimming toward its lit fraction, as a moon's dot does.
 *
 * Pure; the controller draws the points with the moon dots' layer
 * (world/MoonDots.ts).
 */
import { MOON_DOT_PARAMS } from './moonDots';
import {
  STAR_POINT_MAPPING,
  starBeyondAnchorScale,
  starPointVisual,
  type StarPointMapping,
  type StarPointVisual,
} from './world/starPointMapping';
import { smoothstepEdges as smoothstep } from '../shared/math/smoothstep';

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const lerp = (x: number, y: number, t: number) => (1 - t) * x + t * y;

/** B and V reference magnitudes, Mallama, Krobusek & Pavlov (2017), Table 3:
 *  a planet's B−V colour index. */
const REFERENCE_BV: Readonly<Record<string, readonly [number, number]>> = {
  Mercury: [0.28, -0.69],
  Venus: [-3.68, -4.38],
  Earth: [-3.52, -3.99],
  Mars: [-0.24, -1.6],
  Jupiter: [-8.54, -9.4],
  Saturn: [-7.84, -8.91],
  Uranus: [-6.61, -7.11],
  Neptune: [-6.55, -6.94],
};

/** A planet's B−V colour index, or NaN for a body the table does not list. */
export function planetColorIndex(name: string): number {
  const reference = REFERENCE_BV[name];
  return reference ? reference[0] - reference[1] : Number.NaN;
}

export interface PlanetPointParams {
  /** The brightest magnitude the point follows; brighter draws as this. */
  magCeiling: number;
  /** Size growth past the star mapping's largest point, CSS px per magnitude:
   *  gentler than the stars' own slope, so Venus is a bright point, not an
   *  orb the size of the Moon's disc. */
  brightSizeSlopePx: number;
  /** The brightest pixel a planet point may reach, as a fraction of the bloom
   *  line (app/bloomConfig BLOOM_THRESHOLD): under it, so nothing blooms. */
  peakFractionOfBloomLine: number;
  /** Disc handoff (drawn disc diameter, screen px) and the brightness the
   *  point dims toward as it goes: the moon dots' window and level. */
  fadeStartPx: number;
  fadeEndPx: number;
  discMatchLum: number;
}

export const PLANET_POINT_PARAMS: PlanetPointParams = {
  magCeiling: -5,
  brightSizeSlopePx: 0.8,
  peakFractionOfBloomLine: 0.9,
  fadeStartPx: MOON_DOT_PARAMS.fadeStartPx,
  fadeEndPx: MOON_DOT_PARAMS.fadeEndPx,
  discMatchLum: MOON_DOT_PARAMS.discMatchLum,
};

export interface PlanetPointVisual {
  /** Vertex alpha, before the surface view's telescope gain. */
  alpha: number;
  /** Point size, CSS px. */
  sizePx: number;
  /** Multiplies the planet's chromaticity (max channel 1). */
  brightness: number;
}

const starScratch: StarPointVisual = { brightness: 0, sizePx: 0, alpha: 0 };

/** The magnitude where the star mapping stops brightening (−1.44, Sirius's
 *  own): past it every star draws alike, so a planet grows only past it, and
 *  never out-draws a brighter star. */
function brightnessSaturationMag(mapping: StarPointMapping): number {
  return (mapping.brightMul - mapping.brightMax) * mapping.brightDiv - mapping.brightBias;
}

/**
 * One planet's point for this frame.
 *
 * `magnitude` is its apparent magnitude (NaN or infinite draws nothing),
 * `discPx` its drawn disc's diameter on screen, `illuminatedFraction` the lit
 * part of the disc it hands over to, `chromaLuminance` the Rec.709 luminance
 * of its chromaticity (max channel 1), and `bloomLine` the bloom cutoff in the
 * same units as a vertex colour.
 */
export function planetPointVisual(
  magnitude: number,
  discPx: number,
  illuminatedFraction: number,
  chromaLuminance: number,
  bloomLine: number,
  starFaintLimitMag: number,
  params: PlanetPointParams = PLANET_POINT_PARAMS,
  mapping: StarPointMapping = STAR_POINT_MAPPING,
  out: PlanetPointVisual = { alpha: 0, sizePx: 0, brightness: 0 },
): PlanetPointVisual {
  if (!Number.isFinite(magnitude)) {
    out.alpha = 0;
    out.sizePx = 0;
    out.brightness = 0;
    return out;
  }
  const star = starPointVisual(magnitude, starFaintLimitMag, mapping, starScratch);
  let sizePx = star.sizePx;
  let brightness = star.brightness;
  const held = Math.max(magnitude, params.magCeiling);
  const saturation = brightnessSaturationMag(mapping);
  if (held < saturation) {
    sizePx = Math.max(sizePx, mapping.sizeMax + params.brightSizeSlopePx * (saturation - held));
    // The brightness line carries on past its cap, held so the brightest
    // pixel stays under the bloom line.
    const unclamped = mapping.brightMul - (held + mapping.brightBias) / mapping.brightDiv;
    const ceiling = (params.peakFractionOfBloomLine * bloomLine) / Math.max(chromaLuminance, 1e-6);
    brightness = Math.max(brightness, Math.min(unclamped, ceiling));
  }

  const handoff = smoothstep(params.fadeStartPx, params.fadeEndPx, discPx);
  out.alpha = star.alpha * starBeyondAnchorScale(magnitude, starFaintLimitMag, mapping) * (1 - handoff);
  out.sizePx = Math.min(sizePx, lerp(sizePx, discPx, handoff));
  const discLum = params.discMatchLum * clamp(illuminatedFraction, 0, 1);
  out.brightness = lerp(brightness, discLum, Math.min(1, handoff / 0.6));
  return out;
}

/**
 * The light a planet's point must show for the surface view to print its
 * name: vertex alpha (after the telescope gain and the Sun's glare mask)
 * times brightness. A name beside nothing reads as a bug: Neptune at
 * magnitude 7.8 is a one-pixel speck at the bottom of the star field (0.10
 * in a 45° field, 0.18 at 10°) and goes unnamed; Uranus at 5.7 (about 0.29)
 * keeps its name. A planet too faint to name is still in the Look-at menu,
 * and the HUD names the one it tracks.
 */
export const PLANET_LABEL_MIN_LIGHT = 0.22;

/** Rec.709 luminance of an RGB triple. */
export function rec709Luminance(red: number, green: number, blue: number): number {
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}
