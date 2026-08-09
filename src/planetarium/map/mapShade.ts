/**
 * Eclipse shading for the chart's moons: the mapping from sun-visible fraction
 * to how dark a charted moon draws, and the two-phase state one moon carries
 * between the pass that decides its shading and the pass that applies it.
 *
 * Two phases, because the two answers change on different clocks:
 *
 *  1. The TARGET is geometry. It moves only when the sky does, so it is cached
 *     by the position pass, which is allowed to stand down on a settled chart.
 *  2. The APPLIED value is a wall-clock rate limiter (the shared shade
 *     smoother), and a limiter has to keep stepping toward a standing target or
 *     it freezes part-way there. Advancing it inside a pass that skips still
 *     frames would leave a paused clock holding a half-finished ramp forever —
 *     so it is advanced every rendered frame instead.
 *
 * Pure: numbers in, numbers out. No THREE, no materials, no clock of its own.
 */

import {
  SHADE_SMOOTHING,
  smoothShadeFraction,
  type ShadeSmoothingParams,
} from '../world/shadeSmoothing';

/**
 * How dark a fully eclipsed moon draws, as a multiplier on its normal look.
 *
 * The world darkens an eclipsed moon almost to black, because there the moon
 * IS the subject and a real umbra is that deep. On the chart a moon is a mark
 * on a diagram: taken to black it would read as missing rather than as
 * eclipsed, and the system would appear to lose a body every orbit. A third of
 * its normal brightness is unmistakably darker than its neighbours while
 * staying plainly present.
 */
export const MAP_SHADE_FLOOR = 0.35;

/** The drawn multiplier for a sun-visible fraction: the floor in full shadow,
 *  untouched in full sunlight, linear between. Out-of-range input clamps. */
export function mapShadeDim(sunVisibleFraction: number): number {
  const f = sunVisibleFraction > 1 ? 1 : sunVisibleFraction > 0 ? sunVisibleFraction : 0;
  return MAP_SHADE_FLOOR + (1 - MAP_SHADE_FLOOR) * f;
}

/** One moon's shading state, owned by the chart entry it belongs to. */
export interface MapShadeState {
  /** Raw sun-visible fraction from the last geometry pass, 1 = full sunlight. */
  shadeTarget: number;
  /** The fraction actually applied, rate-limited toward the target.
   *  `undefined` means never applied — the next advance takes the target
   *  whole, so a system appearing mid-eclipse arrives already dark. */
  shadeSmoothed: number | undefined;
  /** Wall-clock ms of the last advance, for the limiter's dt. */
  shadeStampMs: number;
}

export function makeMapShadeState(): MapShadeState {
  return { shadeTarget: 1, shadeSmoothed: undefined, shadeStampMs: 0 };
}

/** Forget the applied value so the next advance snaps: a moon that stopped
 *  being drawn must never fade in from the shading it wore when it left. */
export function resetMapShade(state: MapShadeState): void {
  state.shadeSmoothed = undefined;
  state.shadeStampMs = 0;
}

/**
 * Advance one moon's applied shading toward its cached target and return the
 * drawn multiplier. Mutates the state; call once per rendered frame per drawn
 * moon, with one `nowMs` shared by the whole pass.
 */
export function advanceMapShade(
  state: MapShadeState,
  nowMs: number,
  params: ShadeSmoothingParams = SHADE_SMOOTHING,
): number {
  const applied = smoothShadeFraction(
    state.shadeTarget,
    state.shadeSmoothed,
    nowMs - state.shadeStampMs,
    params,
  );
  state.shadeSmoothed = applied;
  state.shadeStampMs = nowMs;
  return mapShadeDim(applied);
}
