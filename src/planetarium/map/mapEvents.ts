/**
 * The chart card's next-event row: which system it searches, and when that
 * search has to start over.
 *
 * Pure decisions only — the sweep itself, the clock and the DOM live with their
 * owners. Two questions are answered here.
 *
 * WHICH SYSTEM. A card is opened on a body; the events belong to a system. A
 * moon's system is its parent's, a planet with moons is its own, and a body
 * with no moons at all (the Sun, Mercury, Venus) has no sky to report.
 *
 * WHEN TO START OVER. The sweep searches forward from a fixed instant, so the
 * clock moving under it eventually makes its answer stale — but a naive "the
 * clock left the anchor behind" test thrashes: under reverse playback the clock
 * recedes every single frame, and a sweep restarted every frame never finishes.
 * So reverse is handled as a state, not as an event:
 *
 *  - RUNNING backwards (not paused, negative rate) — "the next event" from a
 *    receding now means nothing, so the row goes away and the sweep idles.
 *    Nothing restarts while this holds.
 *  - PAUSED, whatever the rate's sign — a stopped clock is a fixed instant like
 *    any other. The sweep runs and the row shows.
 *  - The first forward tick after running backwards, and any discrete jump that
 *    lands the clock behind the anchor (a typed date, a dev jump) — restart
 *    once. These are the only restarts allowed to replace a sweep already in
 *    flight, and they self-limit: a restart re-anchors on the new instant, so
 *    the condition that fired is false immediately afterwards.
 *
 * Everything else is automatic housekeeping and runs only BETWEEN sweeps: a
 * shown event that has ended, and a finished sweep whose "nothing in range"
 * answer has aged out. Checking those mid-sweep is what makes a fast forward
 * warp restart forever without ever completing a search.
 */

import { mapBody } from './mapBodies';
import { getMoonsByPlanet } from '../planets/moonData';

/** How far the clock may run past a finished, empty sweep before it is worth
 *  asking again. Long enough that a warp completes many sweeps between
 *  re-seeds, short enough that a chart left open drifts back into range. */
export const MAP_EVENT_RESEED_MS = 7 * 86_400_000;

/**
 * The system whose events belong on a card opened for `name`, or null for a
 * body whose sky has nothing to report.
 */
export function mapEventSearchTarget(name: string): string | null {
  const body = mapBody(name);
  if (!body) return null;
  if (body.kind === 'moon') return body.parentPlanet;
  if (body.kind !== 'planet') return null;
  return getMoonsByPlanet(body.name).length > 0 ? body.name : null;
}

/** Whether the clock is actually running backwards. A paused clock is a fixed
 *  instant no matter which way it would go if released. */
export function mapEventReverseRunning(rate: number, paused: boolean): boolean {
  return !paused && rate < 0;
}

/**
 * "Has the clock run backwards since the guard last looked?" — asked per
 * rendered frame, answered per guard tick. The guard looks at the clock at the
 * UI cadence, but a reversal can begin and end entirely between two of its
 * looks — and the row clears the moment the clock runs backwards, so a
 * reversal the guard never saw would leave a cleared row that nothing restarts
 * until the re-seed. Frames only ever set the latch; the guard consumes it,
 * and whoever restarts (or cancels) the sweep clears it.
 */
export interface MapEventReverseLatch {
  seenReverse: boolean;
}

export function makeMapEventReverseLatch(): MapEventReverseLatch {
  return { seenReverse: false };
}

/** The per-frame step: remember a running-backwards clock until the guard (or
 *  a restart) asks. */
export function latchMapEventReverse(
  latch: MapEventReverseLatch,
  rate: number,
  paused: boolean,
): void {
  latch.seenReverse = latch.seenReverse || mapEventReverseRunning(rate, paused);
}

/** A restart re-anchors on the instant the clock stands at now, so it consumes
 *  whatever reversal was remembered; a cancel has no sweep left to restart. A
 *  still-running reverse re-latches the very next frame. */
export function resetMapEventReverseLatch(latch: MapEventReverseLatch): void {
  latch.seenReverse = false;
}

export interface MapEventGuardInput {
  /** The simulation clock now. */
  nowUtcMs: number;
  timeRate: number;
  paused: boolean;
  /** Whether the clock has run backwards at any point since the guard last
   *  looked — a per-frame latch, not a sample of the previous tick. */
  wasReverse: boolean;
  /** Whether a sweep is in flight right now. */
  searching: boolean;
  /** The instant the live (or last) sweep searched from; NaN when none has. */
  fromUtcMs: number;
  /** When the event the row is showing ends, or null when no row is shown. */
  rowEndUtcMs: number | null;
}

export type MapEventGuardAction = 'none' | 'restart' | 'restart-preserve';

/** The guard tick's input as the owner assembles it — everything but the
 *  latch, which the tick consumes itself. */
export type MapEventGuardTickInput = Omit<MapEventGuardInput, 'wasReverse'>;

/**
 * One guard tick: consume the latch into the decision, then re-seed it from
 * the live clock so the next interval accumulates afresh. This is the only way
 * the owner runs the guard — the latch handling is part of the tick, not a
 * wiring detail left to the caller.
 */
export function guardMapEvent(
  latch: MapEventReverseLatch,
  input: MapEventGuardTickInput,
): MapEventGuardAction {
  const action = mapEventGuardAction({ ...input, wasReverse: latch.seenReverse });
  latch.seenReverse = mapEventReverseRunning(input.timeRate, input.paused);
  return action;
}

/**
 * What the periodic guard should do this tick. Called at the UI's own cadence,
 * never per frame: the automatic branches below are cheap but their RESTARTS
 * are not, and one per completed sweep is the bound that keeps an absurd time
 * rate honest.
 */
export function mapEventGuardAction(input: MapEventGuardInput): MapEventGuardAction {
  const reverse = mapEventReverseRunning(input.timeRate, input.paused);
  // Running backwards: nothing to do until it stops.
  if (reverse) return 'none';
  // Back to a clock that means something, from either a reversal or a jump
  // that landed behind the anchor. Allowed to replace a sweep in flight —
  // that sweep is searching from an instant the clock has already left.
  if (input.wasReverse) return 'restart';
  if (Number.isFinite(input.fromUtcMs) && input.nowUtcMs < input.fromUtcMs) return 'restart';
  // Housekeeping, only between sweeps.
  if (input.searching) return 'none';
  if (input.rowEndUtcMs !== null) {
    // The shown event has finished — search on, keeping whatever is still
    // ahead so the row hands over instead of blanking.
    return input.nowUtcMs > input.rowEndUtcMs ? 'restart-preserve' : 'none';
  }
  if (
    Number.isFinite(input.fromUtcMs)
    && input.nowUtcMs > input.fromUtcMs + MAP_EVENT_RESEED_MS
  ) {
    return 'restart';
  }
  return 'none';
}

/** The row's finished copy — resolved by the owner, painted by the HUD. */
export interface MapEventRowModel {
  /** Event title, in the same words the Observatory's list uses. */
  label: string;
  /** When it peaks, in the same short form those rows carry. */
  when: string;
}
