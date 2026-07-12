/**
 * Pure time policy for Observatory event jumps. A jump parks the clock
 * shortly before the event's peak and lets it run at 1× real time so the
 * user watches the event happen — which means the prev/next steppers cannot
 * search from "now" naively: the clock sits inside the event they just
 * jumped to, and a plain search would re-find that event forever.
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
