/**
 * Shared magnitude → point brightness/size/alpha mapping for sky points.
 *
 * Extracted from the starfield so a photometric moon dot renders at exactly the
 * visibility an equally bright star gets: the same brightness and size formulas,
 * the same faint-end shaping. The starfield builds its points through
 * `starPointVisual`; the moon dots feed their apparent magnitude through the same
 * function and then extend the alpha below the catalog's faint limit toward zero
 * (so a dot fades in from nothing instead of popping into existence).
 *
 * Pure math, no scene state. `clamp`/`lerp` replicate THREE.MathUtils exactly, so
 * the starfield's per-vertex output stays byte-identical after the extraction.
 */

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const lerp = (x: number, y: number, t: number) => (1 - t) * x + t * y;

/**
 * Faint-end shaping: dimmer points get lower opacity and smaller size, so a dense
 * faint layer recedes into fine texture instead of a flat wall of identical
 * specks. The ramp spans `faintFadeRangeMag` magnitudes up to a faint limit
 * (the catalog's dimmest star). Opacity carries the dimming; size stays at or
 * above `sizeFloorPx` so points read as crisp dots even at the limit.
 */
export const STAR_POINT_MAPPING = {
  // brightness = clamp(brightMul − (mag + brightBias) / brightDiv, brightMin, brightMax)
  brightBias: 1.44,
  brightDiv: 8,
  brightMul: 1.2,
  brightMin: 0.25,
  brightMax: 1.2,
  // baseSize = clamp(sizeMul − mag · sizeSlope, sizeMin, sizeMax)
  sizeMul: 6.0,
  sizeSlope: 1.1,
  sizeMin: 1.2,
  sizeMax: 6.5,
  sizeFloorPx: 1.0, // points never shrink below this (avoids sub-pixel shimmer)
  faintFadeRangeMag: 1.6, // fade-ramp width (mags up to the faint limit); larger dims more of the field
  faintMinAlpha: 0.45, // opacity of the faintest points (never 0 for stars — keep a hint)
  faintMinSizeScale: 0.8, // faintest points shrink to this × base size (then clamped ≥ sizeFloorPx)
} as const;

export type StarPointMapping = typeof STAR_POINT_MAPPING;

/** Screen brightness scalar for a point of the given apparent magnitude. */
export function starPointBrightness(mag: number, p: StarPointMapping = STAR_POINT_MAPPING): number {
  return clamp(p.brightMul - (mag + p.brightBias) / p.brightDiv, p.brightMin, p.brightMax);
}

/** Point size (CSS px) before faint-end taper, for the given magnitude. */
export function starPointBaseSize(mag: number, p: StarPointMapping = STAR_POINT_MAPPING): number {
  return clamp(p.sizeMul - mag * p.sizeSlope, p.sizeMin, p.sizeMax);
}

/** 0 for the bright/mid field, ramping to 1 at the faint limit. */
export function starFaintFraction(
  mag: number,
  faintLimitMag: number,
  p: StarPointMapping = STAR_POINT_MAPPING,
): number {
  return clamp((mag - (faintLimitMag - p.faintFadeRangeMag)) / p.faintFadeRangeMag, 0, 1);
}

export interface StarPointVisual {
  brightness: number;
  sizePx: number;
  alpha: number;
}

/**
 * The full per-point visual for a star (or star-scale point) of the given
 * apparent magnitude, faded toward the faint limit. The clamps cap the bright
 * end, so a point this maps can never out-render the brightest star treatment.
 */
export function starPointVisual(
  mag: number,
  faintLimitMag: number,
  p: StarPointMapping = STAR_POINT_MAPPING,
): StarPointVisual {
  const brightness = starPointBrightness(mag, p);
  const faint = starFaintFraction(mag, faintLimitMag, p);
  const baseSize = starPointBaseSize(mag, p);
  const sizePx = Math.max(p.sizeFloorPx, lerp(baseSize, baseSize * p.faintMinSizeScale, faint));
  const alpha = lerp(1.0, p.faintMinAlpha, faint);
  return { brightness, sizePx, alpha };
}
