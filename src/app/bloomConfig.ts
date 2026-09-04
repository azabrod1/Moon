/**
 * Planetarium bloom constants, split out so the composer build sites and the
 * star-luminance invariant test share one source of truth.
 */

/** UnrealBloom mip blur radius — shared by every mode's composer. */
export const BLOOM_RADIUS = 0.4;

/**
 * Pixel ratio the bloom mip chain is sized at, whatever the display's. The
 * blur kernels are fixed texel counts, so a chain sized in device pixels
 * draws a glow whose width in CSS pixels shrinks as the display gets denser
 * (a 1× monitor would show the Sun's glow twice as wide as a 2× one). The
 * look was authored on 2× displays (Retina Macs, phones); every display gets
 * that glow. main.ts re-sizes the pass to this after every composer resize.
 */
export const BLOOM_PIXEL_RATIO = 2;

/**
 * Planetarium bloom high-pass cutoff (Rec.709 luminance). Set at exactly 1.0 so
 * the brightest catalog star (luminance below 1.0) contributes nothing to the
 * bloom pass: near the Sun, stars must not survive as star-shaped glints. The
 * Sun's corona and halo sit far above 1.0 and bloom on purpose. Moon Flight and
 * Volume Compare keep their own lower cutoffs authored at their own call sites.
 */
export const BLOOM_THRESHOLD = 1.0;

/** The planetarium composer's bloom, as one object: the boot build and every
 *  runtime rebuild (mode switch, bloom toggle, the dev lens knob) read this
 *  rather than restating the pair, so a tuning A/B cannot fork them. */
export const PLANETARIUM_BLOOM: { strength: number; threshold: number } = {
  strength: 0.8,
  threshold: BLOOM_THRESHOLD,
};
