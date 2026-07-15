/**
 * Temporal smoothing for the applied eclipse shading (mesh tint + moon dot).
 *
 * The astronomy gives an instantaneous sun-visible fraction; at 1× time an
 * eclipse immersion takes minutes and the applied tint follows imperceptibly.
 * At warp the same immersion compresses below one frame, so the raw fraction
 * snaps full-bright → near-black between frames — with bloom on top the moon
 * strobes. This limiter caps how fast the APPLIED fraction may change in wall
 * time: fast enough to stay invisible at 1× (real immersions are far slower),
 * slow enough that a warped eclipse reads as a quick dip instead of a strobe.
 *
 * Presentation-only: event search, shadow geometry, and the Observatory all
 * keep reading the raw astronomy.
 */

export interface ShadeSmoothingParams {
  /** Max change of the applied fraction per wall-clock second: the full
   *  bright↔dark swing spreads over ~1/rate seconds. */
  maxRatePerSec: number;
  /** A moon not shaded for longer than this takes the target directly —
   *  teleports, system pop-in, and the first frame never ramp from stale
   *  state. */
  snapGapMs: number;
}

export const SHADE_SMOOTHING: ShadeSmoothingParams = {
  maxRatePerSec: 4,
  snapGapMs: 500,
};

/**
 * One limiter step: move `prev` toward `target` by at most
 * maxRatePerSec · dt. No previous value, a non-positive dt, or a gap beyond
 * snapGapMs snaps to the target.
 */
export function smoothShadeFraction(
  target: number,
  prev: number | undefined,
  dtMs: number,
  params: ShadeSmoothingParams = SHADE_SMOOTHING,
): number {
  if (prev === undefined || dtMs <= 0 || dtMs > params.snapGapMs) return target;
  const maxStep = (params.maxRatePerSec * dtMs) / 1000;
  const delta = target - prev;
  if (delta > maxStep) return prev + maxStep;
  if (delta < -maxStep) return prev - maxStep;
  return target;
}
