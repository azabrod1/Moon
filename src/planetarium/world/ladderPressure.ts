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
 *    The tiles' demand counts too, on a latch of its own: a set the streamer
 *    wants that does not fit what the maps leave it, but would fit if they
 *    left it everything (SectorStreamer.tilesShortfallFor), and short by no
 *    more than the releases it may ask for would free (tilesShortCovered),
 *    since a set no release admits is not one to strip far maps for. The
 *    ladder's share is the envelope less the tiles' FLOOR, so it can sit
 *    inside that share and still hold the tiles under their working set, with
 *    nothing else to give a map back for them. Kept apart from the ladder's
 *    own pressure for two reasons. It may take less: only a rung whose
 *    release lands on a compressed container (the caller's filter; why, at
 *    textureLadder's landsCompressed). And it stays out of `pressureSinceMs`,
 *    which is also what cuts a committed arrival's warm goals short: tiles
 *    short at Earth must not end Earth's own climb.
 *
 *    The tiles' latch has three rules of its own, because the tiles answer
 *    once a frame, after this pass has run. A "short" is acted on only while
 *    the ledger is the one it was taken against; an answer about another
 *    ledger is no answer, and carries the latch as it is rather than
 *    clearing it — clearing it on every landing would let a queue of
 *    restores landing back to back hold a hand-back off for ever. Under the
 *    chart nothing is wanted, so nothing is short. And every swap that gives
 *    a map back restarts the latch when it ends, however it ends
 *    (`swapEnded`), so the slot it frees is never taken on the frame it
 *    frees, on an answer from before; a restore at a stand-in's own tier
 *    gives nothing back and does not count.
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
  /** The tiles want a set the maps leave no room for, an empty ladder would,
   *  and the releases they may ask for would cover (tilesShortCovered); or
   *  null when the streamer's answer was taken against another envelope than
   *  now — a swap landed, a rung applied, the floor or the fixed reservations
   *  moved — and says nothing about this one. */
  tilesShort: boolean | null;
  /** When the tiles first came up short, or null while they are not. */
  tilesShortSinceMs: number | null;
  /** The spheres are drawn this frame. Under the chart nothing is, so the
   *  tiles want nothing whatever the last world frame's reconcile said. */
  drawing: boolean;
  /** A swap that gave a map back has ended since the last pass — settled,
   *  abandoned or expired. Restarts the tiles' latch (rule 1 above). */
  swapEnded: boolean;
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
  /** The tiles' latch, carried like `pressureSinceMs` and cleared the same
   *  way. */
  tilesShortSinceMs: number | null;
  /** The tiles have been short for the dwell and nothing is in flight: a map
   *  may be planned for release for them, from the candidates whose release
   *  lands on a compressed container. False whenever `releaseDue` is true,
   *  so the ladder's own pressure plans exactly as it always has. */
  tilesReleaseDue: boolean;
}

/** Advance the pressure latches and say what this frame may do about them. */
export function planLadderPressure(state: LadderPressureState): LadderPressurePlan {
  const dwellMs = state.dwellMs ?? RELEASE_PRESSURE_DWELL_MS;
  const pressure = state.ladderBytes > state.ceilingBytes || state.blockedDemand;
  const pressureSinceMs = pressure ? state.pressureSinceMs ?? state.nowMs : null;
  const dwellServed = pressureSinceMs !== null && state.nowMs - pressureSinceMs >= dwellMs;
  // The tiles' latch: rule 1 in the header says why each of these holds.
  const tiles = state.drawing ? state.tilesShort : false;
  const carried = state.swapEnded ? null : state.tilesShortSinceMs;
  const tilesShortSinceMs = tiles === null ? carried
    : tiles ? carried ?? state.nowMs : null;
  const tilesServed = tiles === true && tilesShortSinceMs !== null
    && state.nowMs - tilesShortSinceMs >= dwellMs;
  const releaseDue = dwellServed && !state.swapInFlight;
  return {
    pressureSinceMs,
    restoreFirst: state.restoreQueued && !state.swapInFlight,
    releaseDue,
    tilesShortSinceMs,
    tilesReleaseDue: tilesServed && !state.swapInFlight && !releaseDue,
  };
}

/**
 * Whether the tiles are short in a way a release can answer: `shortfallBytes`
 * is what the smallest set they want is short of (SectorStreamer
 * .tilesShortfallFor: 0 when not short, null when that answer was taken
 * against another ledger), and `releasableBytes` what every release the tiles
 * may ask for would free between them. A tiles-only release takes containers
 * only, 32 MiB a far 8K at most and 16 on a half-byte format, so a set bigger
 * than all of that together is one no release admits: stripping every far
 * map for it would buy the tiles nothing.
 */
export function tilesShortCovered(shortfallBytes: number | null, releasableBytes: number): boolean | null {
  if (shortfallBytes === null) return null;
  return shortfallBytes > 0 && releasableBytes >= shortfallBytes;
}

/**
 * Whether any rung a body is earning is blocked by the ledger. Asked only
 * when the ladder is within its share: over it, the pass is under pressure
 * already, and each ask walks the whole ladder.
 */
export function anyDemandBlocked<T>(overShare: boolean, wants: readonly T[], blocked: (want: T) => boolean): boolean {
  if (overShare) return false;
  for (const want of wants) if (blocked(want)) return true;
  return false;
}
