/**
 * Whether one family's sectors may work this frame, from what the frame can
 * see of the body: how fast it is turning, and what is drawing it.
 *
 * Two decisions, both pure, both called from the per-frame measuring pass:
 *
 * 1. The spin latch. A globe turning fast enough to blur under the camera can
 *    only churn 21 MiB uploads, so admissions stop while it does. Latched
 *    rather than thresholded, because a body turning at exactly the suspend
 *    rate would otherwise pulse admissions on and off with frame jitter: past
 *    the suspend rate a hold starts, and any rate above the lower resume rate
 *    while the hold runs extends it.
 * 2. The suspend verdict those states add up to — hold everything, hold the
 *    admissions only, or work normally.
 *
 * The latch is per FAMILY, not per body: two families of one body measure the
 * same quaternion and keep an entry each, which is a duplicate rate and
 * nothing worse — while a latch keyed on the body would let one family's
 * suspend decide the other's.
 */
import type * as THREE from 'three';
import { RAD2DEG } from '../../shared/math/angles';
import type { SectorSuspend } from './sectorStreamer';

/** Above this rotation rate on screen (degrees of body spin per real second —
 *  Earth at 900 s/s) a globe turns visibly under the camera. Measured per body
 *  from its world orientation, so a slow turner (the Moon: 27x Earth) keeps
 *  streaming at rates that would spin Earth into a blur. */
export const SECTOR_SPIN_SUSPEND_DEG_PER_S = 3.75;
/** Admissions resume only once the rate has stayed under this lower figure for
 *  the hold. */
export const SECTOR_SPIN_RESUME_DEG_PER_S = 3;
/** How long a hold runs from the last frame that earned it. */
export const SECTOR_SPIN_HOLD_MS = 400;

/** One family's latch: the orientation and time of its last visit, and how far
 *  ahead the hold currently reaches. The caller owns the map these live in and
 *  the quaternion read that fills them. */
export interface SectorSpinLatch {
  quat: THREE.Quaternion;
  tMs: number;
  heldUntilMs: number;
}

/**
 * Advance one family's latch with this frame's orientation, and say whether
 * its admissions are held. Mutates the latch — it is the caller's per-family
 * state, kept across frames.
 *
 * A first visit has no previous orientation to difference against, so it
 * records one and reports no spin: a body cannot be judged turning by a single
 * sample.
 */
export function advanceSpinLatch(
  latch: SectorSpinLatch,
  quat: THREE.Quaternion,
  nowMs: number,
): boolean {
  const dtS = (nowMs - latch.tMs) / 1000;
  // The angle between two orientations, which is what a rate has to be
  // measured on: |dot| folds the double cover, so q and -q read as no turn.
  const angle = 2 * Math.acos(Math.min(1, Math.abs(latch.quat.dot(quat))));
  const rate = dtS > 0 ? (angle * RAD2DEG) / dtS : 0;
  const held = nowMs < latch.heldUntilMs;
  if (rate > SECTOR_SPIN_SUSPEND_DEG_PER_S || (held && rate > SECTOR_SPIN_RESUME_DEG_PER_S)) {
    latch.heldUntilMs = nowMs + SECTOR_SPIN_HOLD_MS;
  }
  const spinning = nowMs < latch.heldUntilMs;
  latch.quat.copy(quat);
  latch.tMs = nowMs;
  return spinning;
}

/**
 * What one family may do this frame.
 *
 * The ground under a surface observer isn't drawn (the near plane culls it)
 * and every sector "faces" a camera standing on it, so a grounded body holds
 * nothing at all; a hidden globe — an unpainted or out-of-range moon — holds
 * nothing either. A body that is merely turning, or a frame the chart owns,
 * keeps what it has and starts nothing new.
 */
export function sectorSuspendFor(state: {
  hidden: boolean;
  grounded: boolean;
  spinning: boolean;
  chart: boolean;
}): SectorSuspend {
  if (state.hidden || state.grounded) return 'all';
  if (state.spinning || state.chart) return 'admissions';
  return 'none';
}
