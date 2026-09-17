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
 * (the pinned anchor magnitude — deliberately NOT the catalog's dimmest star,
 * so deepening the catalog never re-brightens the existing sky; entries past
 * the anchor continue on the below-anchor taper). Opacity carries the
 * dimming; size stays at or
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
  beyondAnchorRangeMag: 1.5, // mags past the anchor over which the taper below runs out
  beyondAnchorAlphaScale: 0.6, // the taper's floor — deeper stars stay visible, just quieter
} as const;

/**
 * The magnitude the faint-end ramp is anchored to.
 *
 * Deliberately a fixed number rather than whatever the catalog's dimmest star
 * happens to be. The ramp fades the last stretch of magnitudes RELATIVE to this
 * anchor, so deriving it from the catalog would mean every deepening of the
 * catalog silently re-brightened every star already in the sky and slid the
 * moon dots' faint handoff with it. Pinned here, a deeper catalog only adds
 * stars below the anchor and leaves the existing field exactly as it was.
 */
export const STAR_FAINT_ANCHOR_MAG = 7.02;

/**
 * Opacity multiplier for stars past the anchor: 1 at the anchor, easing to
 * `beyondAnchorAlphaScale` over `beyondAnchorRangeMag`. The same shape the moon
 * dots use below their limit, but floored instead of run to zero — a catalog
 * star is a real star and should still be on the sky, just fainter than
 * anything the anchor covers.
 */
export function starBeyondAnchorScale(
  mag: number,
  anchorMag: number = STAR_FAINT_ANCHOR_MAG,
  p: StarPointMapping = STAR_POINT_MAPPING,
): number {
  const beyond = mag - anchorMag;
  if (!(beyond > 0)) return 1;
  return lerp(1, p.beyondAnchorAlphaScale, clamp(beyond / p.beyondAnchorRangeMag, 0, 1));
}

export type StarPointMapping = typeof STAR_POINT_MAPPING;

/**
 * The pixel ratio a sky point's `gl_PointSize` is sized by — shared by the
 * starfield and the moon dots, whose sizes come out of the mapping above and
 * must stay the same size as each other.
 *
 * gl_PointSize is in framebuffer pixels, so a point that should read as N CSS
 * px is N × the ratio of the target it is rasterised INTO. Since the
 * graphics-quality levels landed that is the SCENE ratio, which need not be the
 * ratio the canvas is presented at: a supersampled rung draws the scene at 3
 * and carries it down onto a 2× canvas, a rung down draws at 1.5 and carries it
 * up (app/renderResolution.ts).
 *
 * The ≤ 2 cap is against the DISPLAY's density and nothing else. The sizes
 * above were dialled on a 2× display, and the intent is that a denser display
 * holds them at that device-pixel size instead of growing them — so the cap
 * fixes the point's CSS size at `min(outputRatio, 2) / outputRatio` of the
 * mapping's own, and the scene ratio then scales that CSS size into the pixels
 * actually being drawn. Capping the SCENE ratio instead makes a resolution rung
 * change the point's CSS size, which is a different picture per rung rather
 * than the same picture at a different resolution.
 *
 * Where the scene ratio equals the output ratio — every fixed Medium frame, and
 * every canvas the resolution levels are not driving — `sceneRatio/outputRatio`
 * is exactly 1 and this is exactly `min(outputRatio, 2)`, the value before this
 * argument existed. The divide is written first for that reason: it makes the
 * identity exact in float rather than merely true in arithmetic (at an output
 * ratio of 1.6, `r × min(r,2) / r` is not `r`).
 */
export function pointSpritePixelRatio(sceneRatio: number, outputRatio: number): number {
  return (sceneRatio / outputRatio) * Math.min(outputRatio, 2);
}

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
 * Pass `out` to reuse a result object (per-frame callers — no allocation).
 */
export function starPointVisual(
  mag: number,
  faintLimitMag: number,
  p: StarPointMapping = STAR_POINT_MAPPING,
  out: StarPointVisual = { brightness: 0, sizePx: 0, alpha: 0 },
): StarPointVisual {
  const faint = starFaintFraction(mag, faintLimitMag, p);
  const baseSize = starPointBaseSize(mag, p);
  out.brightness = starPointBrightness(mag, p);
  out.sizePx = Math.max(p.sizeFloorPx, lerp(baseSize, baseSize * p.faintMinSizeScale, faint));
  out.alpha = lerp(1.0, p.faintMinAlpha, faint);
  return out;
}
