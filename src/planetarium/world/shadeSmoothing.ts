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

/**
 * Two-owner wall-time smoothing for the Sun silhouette night-lift kill, shared
 * by the same rate limiter. At most one body owns the dim at a time; a handoff
 * ramps the incoming owner up while the outgoing one fades to 0, so a warp that
 * compresses an eclipse below one frame reads as a quick dip rather than a
 * strobe, and conjunct occluders swapping ownership don't hard-cut.
 *
 * Generic over an opaque owner token (compared by identity) so it stays pure and
 * testable; the caller maps tokens to shading uniforms and writes the applied
 * values out. Only two slots are tracked: a brand-new owner arriving while an
 * ex-owner is still fading evicts that ex-owner (its token drops out of both
 * slots), and the caller is responsible for zeroing any token that leaves.
 */
export interface SilhouetteOwnerSlot<T> {
  /** The body currently assigned this slot, or null when the slot is idle. */
  owner: T | null;
  /** Smoothed uSilhouette value in [0, 1]. */
  applied: number;
  /** Wall-clock ms of the last advance, for the rate limiter's dt. */
  stampMs: number;
}

export interface SilhouetteOwners<T> {
  /** The owner ramping toward this frame's target. */
  current: SilhouetteOwnerSlot<T>;
  /** The previous owner fading to 0; released (owner → null) on arrival. */
  ex: SilhouetteOwnerSlot<T>;
}

export interface SilhouetteTarget<T> {
  /** Dominant occluder this frame, or null when nothing silhouettes the Sun. */
  owner: T | null;
  /** Target uSilhouette for that owner (occluderShade × size gate), in [0, 1]. */
  shade: number;
}

export interface SilhouetteAdvanceOptions {
  /** Snap both slots to their targets instantly (a scene discontinuity: a
   *  fading ghost of the previous scene's silhouette must never show). */
  snap?: boolean;
  params?: ShadeSmoothingParams;
}

/** A slot at rest with no owner. */
export function makeSilhouetteOwners<T>(): SilhouetteOwners<T> {
  return {
    current: { owner: null, applied: 0, stampMs: 0 },
    ex: { owner: null, applied: 0, stampMs: 0 },
  };
}

const SILHOUETTE_RELEASE_EPS = 1e-4;

/**
 * Advance the two owner slots one frame toward `target`. Mutates and returns
 * `state` (alloc-free: the two slot objects are reused, swapped, or overwritten
 * in place). The caller then writes `current.applied` / `ex.applied` to their
 * tokens' uniforms and zeroes any token that dropped out of both slots.
 */
export function advanceSilhouetteOwners<T>(
  state: SilhouetteOwners<T>,
  target: SilhouetteTarget<T>,
  nowMs: number,
  options: SilhouetteAdvanceOptions = {},
): SilhouetteOwners<T> {
  const params = options.params ?? SHADE_SMOOTHING;
  const snap = options.snap ?? false;
  const active = target.owner != null && target.shade > 0;
  const tOwner = active ? target.owner : null;
  const tShade = active ? target.shade : 0;

  // Ownership transitions (only when a real new owner arrives).
  if (tOwner !== null && tOwner !== state.current.owner) {
    if (tOwner === state.ex.owner) {
      // The incoming owner is the one currently fading — revive it, and let the
      // outgoing current start fading in its place. Pure ref swap.
      const tmp = state.current;
      state.current = state.ex;
      state.ex = tmp;
    } else {
      // A brand-new owner: the current becomes the fader; the old ex is evicted
      // (its slot object is reused as the fresh current so nothing allocates).
      // Its stampMs is left at the previous frame's value so the first ramp step
      // sees one real frame's dt rather than a zero dt that would snap.
      const reused = state.ex;
      state.ex = state.current;
      reused.owner = tOwner;
      reused.applied = 0;
      state.current = reused;
    }
  }

  const current = state.current;
  const ex = state.ex;
  // The current slot ramps to the target only while it actually holds the
  // active owner; if the frame has no owner it fades out like the ex slot.
  const currentTarget = current.owner !== null && current.owner === tOwner ? tShade : 0;

  current.applied = snap
    ? currentTarget
    : smoothShadeFraction(currentTarget, current.applied, nowMs - current.stampMs, params);
  current.stampMs = nowMs;
  ex.applied = snap
    ? 0
    : smoothShadeFraction(0, ex.applied, nowMs - ex.stampMs, params);
  ex.stampMs = nowMs;

  // Release a faded-out slot so its token can be zeroed and forgotten. The
  // active owner is never released, even at applied 0 (a gated-out landscape
  // planet keeps ownership so it doesn't churn identity every frame).
  if (current.owner !== null && current.owner !== tOwner && current.applied <= SILHOUETTE_RELEASE_EPS) {
    current.owner = null;
    current.applied = 0;
  }
  if (ex.owner !== null && ex.applied <= SILHOUETTE_RELEASE_EPS) {
    ex.owner = null;
    ex.applied = 0;
  }

  return state;
}
