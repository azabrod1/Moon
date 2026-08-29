/**
 * When the globe texture ladder has to give a map back, and what it does
 * first.
 *
 * Three rules the release pass turns on, all of them here so they can be read
 * and tested without a scene:
 *
 * 1. What counts as pressure. Maps already over the ladder's share, OR a rung
 *    a body is earning that the ledger will not fit. Demand that cannot be met
 *    is the whole reason a map would be handed back: without it a ladder that
 *    exactly fills its share would sit there refusing every new rung forever.
 * 2. Pressure is a state, not a frame. It must hold for a dwell before
 *    anything is released — a rung applying holds its decoded source for the
 *    frame or two before the upload is paid and the source closed, and a body
 *    would otherwise lose a map it keeps needing to a spike that clears
 *    itself.
 * 3. A rung waiting to be fetched back after a lost context goes before any
 *    discretionary release. A globe on a stand-in is one the player can see is
 *    soft, and both take the same one-swap-in-flight slot.
 */

/** How long the ladder must be over its share, or a rung go unmet, before a
 *  map is given back. */
export const RELEASE_PRESSURE_DWELL_MS = 1_000;

export interface LadderPressureState {
  /** GPU bytes the ladder's optional maps hold right now. */
  ladderBytes: number;
  /** The most they may hold — the envelope less the tiles' floor. */
  ceilingBytes: number;
  /** A rung some body is earning (or its committed arrival is warming) that
   *  the ledger answered `blocked` for this frame. */
  blockedDemand: boolean;
  /** When the ladder first came under pressure, or null while it is not. */
  pressureSinceMs: number | null;
  nowMs: number;
  dwellMs?: number;
  /** A release or a restore re-fetch already in the air. Only one swap at a
   *  time: each transiently holds both maps. */
  swapInFlight: boolean;
  /** A rung is waiting to fetch back the map a lost context took. */
  restoreQueued: boolean;
}

export interface LadderPressurePlan {
  /** The latch to carry into the next frame: cleared the moment the pressure
   *  goes, so a fresh spell owes the dwell again from its own start. */
  pressureSinceMs: number | null;
  /** Start a queued restore re-fetch now, before anything discretionary. */
  restoreFirst: boolean;
  /** The dwell is served and nothing is in flight: a map may be planned for
   *  release. */
  releaseDue: boolean;
}

/** Advance the pressure latch and say what this frame may do about it. */
export function planLadderPressure(state: LadderPressureState): LadderPressurePlan {
  const dwellMs = state.dwellMs ?? RELEASE_PRESSURE_DWELL_MS;
  const pressure = state.ladderBytes > state.ceilingBytes || state.blockedDemand;
  const pressureSinceMs = pressure ? state.pressureSinceMs ?? state.nowMs : null;
  const dwellServed = pressureSinceMs !== null && state.nowMs - pressureSinceMs >= dwellMs;
  return {
    pressureSinceMs,
    restoreFirst: state.restoreQueued && !state.swapInFlight,
    releaseDue: dwellServed && !state.swapInFlight,
  };
}
