/**
 * Pure time policy for Observatory event jumps. A jump parks the clock
 * shortly before the event's peak and lets it run at 1× real time so the
 * user watches the event happen — which means the prev/next steppers cannot
 * search from "now" naively: the clock sits inside the event they just
 * jumped to, and a plain search would re-find that event forever.
 *
 * The same park point sets the other question here: which event, of the ones
 * already found, the sky is showing at this instant. Unit-tested in
 * observatoryTime.test.ts.
 */

/** Lead time before an event's peak that a jump parks at, clock running 1×. */
export const OBSERVATORY_JUMP_LEAD_MS = 3 * 60_000;

/** Padding around an event's span when deciding "the clock is parked here". */
export const OBSERVATORY_STEP_MARGIN_MS = 60_000;

export interface EventSpanMs {
  startUtcMs: number;
  peakUtcMs: number;
  endUtcMs: number;
}

/** Earliest instant covered by a jump to this event: first contact or the
 * pre-peak park point, whichever comes first (short events park before
 * first contact). */
function spanLeadStartMs(span: EventSpanMs): number {
  return Math.min(span.startUtcMs, span.peakUtcMs - OBSERVATORY_JUMP_LEAD_MS);
}

/**
 * Where a prev/next event search must start. While the clock sits inside the
 * last jumped-to event's window — from the pre-peak park point through the
 * final contact, padded by the step margin — stepping must skip that event:
 * forward searches resume past its end, backward ones before its start.
 * Anywhere else (no prior jump, or the user has moved the clock away) the
 * search starts from the current time. Phase events are instants: pass
 * start = peak = end.
 */
export function stepperSearchFromUtcMs(
  last: EventSpanMs | null,
  nowUtcMs: number,
  direction: 1 | -1,
): number {
  if (!last) return nowUtcMs;
  const windowStartMs = spanLeadStartMs(last) - OBSERVATORY_STEP_MARGIN_MS;
  const windowEndMs = last.endUtcMs + OBSERVATORY_STEP_MARGIN_MS;
  if (nowUtcMs < windowStartMs || nowUtcMs > windowEndMs) return nowUtcMs;
  return direction === 1
    ? last.endUtcMs + OBSERVATORY_STEP_MARGIN_MS
    : spanLeadStartMs(last) - OBSERVATORY_STEP_MARGIN_MS;
}

/** The minimum an event needs for "is it overhead?": its span and its sky. */
export interface LiveEventCandidate extends EventSpanMs {
  spec: { parentPlanet: string };
}

/**
 * Is the event in `now`'s sky, for the "overhead right now" question the
 * panel's window and watch row ask? The gate opens the jump's lead time
 * early — a jump parks at peak − lead, and on an event shorter than twice
 * that the clock would otherwise sit before first contact with the window
 * dark at the very instant it was asked for. It closes on the final contact
 * with no padding: the moment the event ends, nothing is overhead.
 */
function isOverheadNow(event: LiveEventCandidate, nowUtcMs: number): boolean {
  return nowUtcMs >= event.startUtcMs - OBSERVATORY_JUMP_LEAD_MS && nowUtcMs <= event.endUtcMs;
}

/**
 * Which event the sky over `parentPlanet` is showing at `nowUtcMs`, chosen
 * from the events already found by the upcoming search (never a new one).
 *
 * The last jumped-to event wins while its own contacts hold — coinciding
 * events must not swap the narration out from under the jump that staged
 * them — but only on bare contacts, so an event that has run its course
 * can't outrank one genuinely underway. Otherwise the earliest-peaking
 * candidate wins, matching the order the panel lists them in. The final
 * fall-back covers the instant after a jump, when the results have been
 * cleared and the chunked search has not re-found the destination yet.
 *
 * Candidates from another system are ignored: a vantage change leaves the
 * previous system's events behind, and they are not in this sky.
 */
export function resolveLiveEvent<T extends LiveEventCandidate>(
  nowUtcMs: number,
  parentPlanet: string,
  candidates: Iterable<T>,
  lastEvent: T | null,
): T | null {
  const last =
    lastEvent && lastEvent.spec.parentPlanet === parentPlanet ? lastEvent : null;
  if (last && nowUtcMs >= last.startUtcMs && nowUtcMs <= last.endUtcMs) return last;
  let best: T | null = null;
  for (const event of candidates) {
    if (event.spec.parentPlanet !== parentPlanet || !isOverheadNow(event, nowUtcMs)) continue;
    if (!best || event.peakUtcMs < best.peakUtcMs) best = event;
  }
  if (best) return best;
  return last && isOverheadNow(last, nowUtcMs) ? last : null;
}
