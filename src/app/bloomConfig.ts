/**
 * Planetarium bloom constants, split out so the composer build sites and the
 * star-luminance invariant test share one source of truth.
 */

import { SUN_LIGHT_BASELINE } from '../planetarium/sunLight';

/** UnrealBloom mip blur radius — shared by every mode's composer. */
export const BLOOM_RADIUS = 0.4;

/**
 * The ceiling the starfield is held under (Rec.709 luminance): the brightest
 * catalog star stays below it, so near the Sun no star survives the bright
 * pass as a star-shaped glint. The stars' own number, which the Sun's
 * baseline never moves.
 */
export const STAR_LUMINANCE_CEILING = 1.0;

/**
 * Planetarium bloom high-pass cutoff (Rec.709 luminance): the stars' ceiling
 * times the Sun's baseline (planetarium/sunLight SUN_LIGHT_BASELINE), so the
 * sunlit white (3/pi of the light) sits under the line by the margin it was
 * graded with, and the stars, which keep their authored radiance under the
 * brighter Sun, sit further under it. The Sun's corona and halo sit far above
 * it and bloom on purpose. Moon Flight and Volume Compare keep their own lower
 * cutoffs authored at their own call sites.
 */
export const BLOOM_THRESHOLD = STAR_LUMINANCE_CEILING * SUN_LIGHT_BASELINE;

/**
 * The knee's width per unit of the Sun's baseline (planetarium/sunLight
 * SUN_LIGHT_BASELINE). The knee is a width in the same luminance units as the
 * threshold, so it follows the baseline the way the threshold does: a brighter
 * Sun moves the line and the ease over it together, and a pixel a given
 * fraction of the baseline over the line hands the blur the same fraction of
 * the baseline at any baseline. Chosen so the knee at the baseline of 1.4 is
 * exactly the 0.25 the bright pass has drawn with since that baseline came in,
 * and the float the GPU reads is that value bit for bit (a test holds both).
 */
export const BLOOM_KNEE_PER_BASELINE = 0.25 / 1.4;

/**
 * How much of a pixel the planetarium's bright pass hands the blur.
 *
 * three's high pass is a step: a pixel whose luminance clears the threshold
 * passes WHOLE, and one a hair under it passes nothing. That is a fair glow for
 * the Sun, which sits hundreds of units over the line, and a poor one for
 * anything just over it. The ocean glint's core reached the threshold by about
 * a tenth and was handed to the blur entire — a smooth halo out to a fifth of
 * Earth's radius, from a pixel a camera would merely clip, and the one glow in
 * a frame where nothing else on the disc crosses the line. Here the blur takes
 * the EXCESS above the threshold instead, eased in over a knee so the contour
 * where it starts is not an edge: a pixel a tenth of the baseline over the
 * line hands over under three hundredths of the baseline, the photosphere
 * hands over all but the threshold and half the knee, and a star under its
 * ceiling still hands over nothing, which is the invariant the threshold
 * exists for.
 *
 * Only the planetarium's chain: Moon Flight and Volume Compare authored their
 * lower cutoffs against the step and keep it. `?bloomknee=0` (any build) puts
 * the step back here too — the kill switch, and the A/B for the halo.
 */
export const BLOOM_KNEE = BLOOM_KNEE_PER_BASELINE * SUN_LIGHT_BASELINE;

/**
 * The luminance the bright pass keeps of a pixel at `v`: none up to the
 * threshold, the excess eased in as a square over the knee, the excess less
 * half the knee beyond it, so the two arms meet in value and in slope. The
 * GLSL in app/bloomTargets.ts is this function, and its test holds the two
 * texts together; the colour passes scaled by this over the pixel's own
 * luminance, so hue survives.
 */
export function bloomExcess(v: number, threshold: number, knee: number): number {
  const over = Math.max(v - threshold, 0);
  if (knee <= 0) return over;
  return over < knee ? (over * over) / (2 * knee) : over - knee / 2;
}

/** The planetarium composer's bloom, as one object: the boot build and every
 *  runtime rebuild (mode switch, bloom toggle, the dev lens knob) read this
 *  rather than restating the set, so a tuning A/B cannot fork them. The knee
 *  is this chain's alone (BLOOM_KNEE); the other modes' objects carry none. */
export const PLANETARIUM_BLOOM: { strength: number; threshold: number; knee: number } = {
  strength: 0.8,
  threshold: BLOOM_THRESHOLD,
  knee: BLOOM_KNEE,
};
