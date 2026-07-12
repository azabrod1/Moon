/**
 * Planetarium bloom constants, split out so the composer build sites and the
 * star-luminance invariant test share one source of truth.
 */

/** UnrealBloom mip blur radius — shared by every mode's composer. */
export const BLOOM_RADIUS = 0.4;

/**
 * Planetarium bloom high-pass cutoff (Rec.709 luminance). Set at exactly 1.0 so
 * the brightest catalog star (luminance below 1.0) contributes nothing to the
 * bloom pass: near the Sun, stars must not survive as star-shaped glints. The
 * Sun's corona and halo sit far above 1.0 and bloom on purpose. Moon Flight and
 * Volume Compare keep their own lower cutoffs authored at their own call sites.
 */
export const BLOOM_THRESHOLD = 1.0;
