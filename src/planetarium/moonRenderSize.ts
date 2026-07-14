/**
 * Rendered-size policy for moons: the single definition of how a moon's drawn
 * radius derives from its true radius.
 *
 * Most moons are slivers of their giant parents — at true scale nearly the
 * whole catalog is sub-pixel from any useful viewpoint — so a moon below an
 * anchor size (a fraction of its parent's radius) is inflated toward that
 * anchor on a compressive power curve:
 *
 *   rendered = anchor · (true / anchor)^γ        for true < anchor
 *
 * Unlike a hard clamp to the anchor (which drew all eighteen Saturn moons at
 * one identical size — 5% of Saturn exceeds even Titan), the curve keeps every
 * invariant its consumers lean on:
 *  - never shrinks a moon: rendered ≥ true for any γ < 1;
 *  - size-ordered: a strictly larger true radius renders strictly larger;
 *  - bounded: rendered ≤ anchor, so shells and standoffs sized from it can
 *    never exceed what the old clamp produced;
 *  - continuous: the curve meets identity exactly at the anchor.
 *
 * An anchorRatio ≤ 0 returns the true radius (surface view draws real angular
 * sizes — an Io silhouette on the Sun must be Io-sized). The explicit guard
 * only protects the pow; identity is the curve's natural limit as the anchor
 * shrinks, not a separate mode.
 *
 * Every tuning knob lives in the exported block below. γ is the taste dial:
 * lower flattens the spread back toward the same-size look, higher approaches
 * true scale — at γ = 0.4 a 3× true size difference renders as ~1.55×. The
 * dev bridge overrides γ live (`__moon.setMoonSizeGamma`) for in-scene tuning.
 */

/** Compression exponent: rendered spread = true spread^γ below the anchor. */
export const MOON_RENDER_GAMMA = 0.4;

/** Anchor ratio while flying, and while observing a moon: the fraction of the
 *  parent's radius where rendered size meets true size. Small moons inflate
 *  toward it so every moon stays a findable speck as you pass. */
export const MOON_RENDER_ANCHOR_RATIO = 0.05;

/** Smaller anchor while observing the parent planet: with the moons as the
 *  subject, the system reads closer to honest relative sizes, at some cost in
 *  speck prominence. */
export const MOON_RENDER_ANCHOR_RATIO_OBSERVING = 0.025;

/**
 * Rendered radius for a moon: true size at or above the anchor
 * (anchor = parentRadiusAU · anchorRatio); below it, inflated toward the
 * anchor on the power curve so tiny moons stay findable while their true
 * size ordering survives.
 */
export function renderedMoonRadiusAU(
  trueRadiusAU: number,
  parentRadiusAU: number,
  anchorRatio: number,
  gamma: number = MOON_RENDER_GAMMA,
): number {
  if (anchorRatio <= 0 || trueRadiusAU <= 0) return trueRadiusAU;
  const anchorAU = parentRadiusAU * anchorRatio;
  if (trueRadiusAU >= anchorAU) return trueRadiusAU;
  return anchorAU * Math.pow(trueRadiusAU / anchorAU, gamma);
}
