import { describe, expect, it } from 'vitest';
import {
  OBSERVATORY_JUMP_LEAD_MS,
  OBSERVATORY_STEP_MARGIN_MS,
  resolveLiveEvent,
  stepperSearchFromUtcMs,
  type EventSpanMs,
} from './observatoryTime';

const HOUR = 3_600_000;
const MIN = 60_000;

// A long event (Earth-style lunar eclipse: hours from first to last contact).
const long: EventSpanMs = {
  startUtcMs: 1_000 * HOUR,
  peakUtcMs: 1_002 * HOUR,
  endUtcMs: 1_004 * HOUR,
};
// A short event (small-moon transit): contacts inside the 3-min park lead.
const short: EventSpanMs = {
  startUtcMs: 2_000 * HOUR - 30_000,
  peakUtcMs: 2_000 * HOUR,
  endUtcMs: 2_000 * HOUR + 30_000,
};
// A phase instant (full/new moon — findEvent returns a single time).
const instant: EventSpanMs = {
  startUtcMs: 3_000 * HOUR,
  peakUtcMs: 3_000 * HOUR,
  endUtcMs: 3_000 * HOUR,
};

describe('stepperSearchFromUtcMs — jump-park dedupe for the event steppers', () => {
  it('searches from now when no event has been jumped to', () => {
    expect(stepperSearchFromUtcMs(null, 123, 1)).toBe(123);
    expect(stepperSearchFromUtcMs(null, 123, -1)).toBe(123);
  });

  it('parked at peak − lead: Next resumes past the end, Prev before the start', () => {
    const parked = long.peakUtcMs - OBSERVATORY_JUMP_LEAD_MS;
    expect(stepperSearchFromUtcMs(long, parked, 1)).toBe(long.endUtcMs + OBSERVATORY_STEP_MARGIN_MS);
    expect(stepperSearchFromUtcMs(long, parked, -1)).toBe(long.startUtcMs - OBSERVATORY_STEP_MARGIN_MS);
  });

  it('still skips the event after watching it to the end (clock just past last contact)', () => {
    const watchedOut = long.endUtcMs + 30_000; // inside the margin
    expect(stepperSearchFromUtcMs(long, watchedOut, 1)).toBe(long.endUtcMs + OBSERVATORY_STEP_MARGIN_MS);
    expect(stepperSearchFromUtcMs(long, watchedOut, -1)).toBe(long.startUtcMs - OBSERVATORY_STEP_MARGIN_MS);
  });

  it('ignores the last event once the clock has moved well away from it', () => {
    const longGone = long.endUtcMs + 5 * HOUR;
    expect(stepperSearchFromUtcMs(long, longGone, 1)).toBe(longGone);
    const longBefore = long.startUtcMs - OBSERVATORY_JUMP_LEAD_MS - 5 * HOUR;
    expect(stepperSearchFromUtcMs(long, longBefore, -1)).toBe(longBefore);
  });

  it('short events: the park point precedes first contact and is still deduped', () => {
    const parked = short.peakUtcMs - OBSERVATORY_JUMP_LEAD_MS;
    expect(parked).toBeLessThan(short.startUtcMs);
    expect(stepperSearchFromUtcMs(short, parked, 1)).toBe(short.endUtcMs + OBSERVATORY_STEP_MARGIN_MS);
    // Backward: resume before the park point, not merely before first contact —
    // a backward search from start − margin would land inside the park window.
    const prevFrom = stepperSearchFromUtcMs(short, parked, -1);
    expect(prevFrom).toBe(short.peakUtcMs - OBSERVATORY_JUMP_LEAD_MS - OBSERVATORY_STEP_MARGIN_MS);
    expect(prevFrom).toBeLessThanOrEqual(parked);
  });

  it('phase instants (start = peak = end) dedupe around the single time', () => {
    const parked = instant.peakUtcMs - OBSERVATORY_JUMP_LEAD_MS;
    expect(stepperSearchFromUtcMs(instant, parked, 1)).toBe(instant.peakUtcMs + OBSERVATORY_STEP_MARGIN_MS);
    expect(stepperSearchFromUtcMs(instant, parked, -1)).toBe(
      instant.peakUtcMs - OBSERVATORY_JUMP_LEAD_MS - OBSERVATORY_STEP_MARGIN_MS,
    );
  });

  it('now exactly at the last event\'s peak still steps off it', () => {
    // Only applies when the event IS the last jump target — a manual date-set
    // to a peak with no prior jump searches from now (and re-finding the
    // in-progress event there is the intended "watch this one" behavior).
    expect(stepperSearchFromUtcMs(long, long.peakUtcMs, 1)).toBe(long.endUtcMs + OBSERVATORY_STEP_MARGIN_MS);
  });

  it('window edges: inside the margin is parked, beyond it is not', () => {
    const justInside = long.endUtcMs + OBSERVATORY_STEP_MARGIN_MS - 1;
    expect(stepperSearchFromUtcMs(long, justInside, 1)).toBe(long.endUtcMs + OBSERVATORY_STEP_MARGIN_MS);
    // One ms past the margin must return `now` itself — at exactly end+margin
    // both branches coincide, so the falsifiable pin is the +1 case.
    const justBeyond = long.endUtcMs + OBSERVATORY_STEP_MARGIN_MS + 1;
    expect(stepperSearchFromUtcMs(long, justBeyond, 1)).toBe(justBeyond);
  });

  it('Next then Prev round-trip cannot oscillate onto the same event', () => {
    // Park at event, step Next: the forward origin is past the end…
    const parked = long.peakUtcMs - OBSERVATORY_JUMP_LEAD_MS;
    const nextFrom = stepperSearchFromUtcMs(long, parked, 1);
    expect(nextFrom).toBeGreaterThan(long.endUtcMs);
    // …and once parked at a later event, Prev's origin from THAT event's
    // window is before its own start, so it can re-find `long` (the genuine
    // previous event), not the one we're parked at.
    const later: EventSpanMs = {
      startUtcMs: long.endUtcMs + 10 * HOUR,
      peakUtcMs: long.endUtcMs + 12 * HOUR,
      endUtcMs: long.endUtcMs + 14 * HOUR,
    };
    const parkedLater = later.peakUtcMs - OBSERVATORY_JUMP_LEAD_MS;
    const prevFrom = stepperSearchFromUtcMs(later, parkedLater, -1);
    expect(prevFrom).toBeLessThan(later.startUtcMs);
    expect(prevFrom).toBeGreaterThan(long.endUtcMs + MIN);
  });
});

// Which event the panel's window calls "overhead" — chosen from the events
// the upcoming search already found, never a new search.
describe('resolveLiveEvent', () => {
  const span = (startUtcMs: number, peakUtcMs: number, endUtcMs: number, parentPlanet = 'Earth') =>
    ({ startUtcMs, peakUtcMs, endUtcMs, spec: { parentPlanet } });
  const eclipse = span(1_000 * HOUR, 1_002 * HOUR, 1_004 * HOUR);
  const brief = span(2_000 * HOUR - 30_000, 2_000 * HOUR, 2_000 * HOUR + 30_000);

  it('lights from the jump park point through the final contact', () => {
    expect(resolveLiveEvent(eclipse.startUtcMs, 'Earth', [eclipse], null)).toBe(eclipse);
    expect(resolveLiveEvent(eclipse.endUtcMs, 'Earth', [eclipse], null)).toBe(eclipse);
    // The lead-in opens exactly where a jump parks — and not a ms earlier.
    const park = eclipse.startUtcMs - OBSERVATORY_JUMP_LEAD_MS;
    expect(resolveLiveEvent(park, 'Earth', [eclipse], null)).toBe(eclipse);
    expect(resolveLiveEvent(park - 1, 'Earth', [eclipse], null)).toBeNull();
  });

  it('goes dark the instant the event ends — no trailing pad', () => {
    expect(resolveLiveEvent(eclipse.endUtcMs + 1, 'Earth', [eclipse], null)).toBeNull();
  });

  it('a jump to a short event lands with the window already lit', () => {
    // Contacts are inside the park lead: bare contacts alone would leave the
    // window dark at the instant the jump asked for it.
    const parked = brief.peakUtcMs - OBSERVATORY_JUMP_LEAD_MS;
    expect(parked).toBeLessThan(brief.startUtcMs);
    expect(resolveLiveEvent(parked, 'Earth', [brief], null)).toBe(brief);
  });

  it('ignores events from another system — a vantage change leaves them behind', () => {
    const io = span(1_000 * HOUR, 1_002 * HOUR, 1_004 * HOUR, 'Jupiter');
    expect(resolveLiveEvent(1_002 * HOUR, 'Earth', [io], null)).toBeNull();
    expect(resolveLiveEvent(1_002 * HOUR, 'Earth', [io], io)).toBeNull();
  });

  it('the jumped-to event outranks a coinciding one while its contacts hold', () => {
    const coinciding = span(999 * HOUR, 1_001 * HOUR, 1_005 * HOUR);
    // Earlier peak, so it would win the plain scan.
    expect(resolveLiveEvent(1_002 * HOUR, 'Earth', [coinciding, eclipse], null)).toBe(coinciding);
    expect(resolveLiveEvent(1_002 * HOUR, 'Earth', [coinciding, eclipse], eclipse)).toBe(eclipse);
  });

  it('an ended jump target never outranks an event genuinely underway', () => {
    const ended = span(900 * HOUR, 901 * HOUR, 902 * HOUR);
    expect(resolveLiveEvent(1_002 * HOUR, 'Earth', [eclipse], ended)).toBe(eclipse);
  });

  it('a last target still in its lead-in yields to one genuinely underway', () => {
    // The preference holds on bare contacts alone — the lead-in lights a
    // window, it does not defend one.
    const underway = span(998 * HOUR, 999 * HOUR, 1_003 * HOUR);
    const approaching = span(1_000 * HOUR, 1_001 * HOUR, 1_002 * HOUR);
    const justBefore = 1_000 * HOUR - 60_000;
    expect(resolveLiveEvent(justBefore, 'Earth', [underway, approaching], approaching)).toBe(
      underway,
    );
  });

  it('the jump target lights the window before the search has re-found it', () => {
    // The results are cleared on every jump; the chunked sweep refills over
    // the following frames.
    const parked = brief.peakUtcMs - OBSERVATORY_JUMP_LEAD_MS;
    expect(resolveLiveEvent(parked, 'Earth', [], brief)).toBe(brief);
    expect(resolveLiveEvent(brief.endUtcMs + 1, 'Earth', [], brief)).toBeNull();
  });

  it('picks the earliest-peaking candidate, matching the list order', () => {
    const later = span(1_001 * HOUR, 1_003 * HOUR, 1_005 * HOUR);
    expect(resolveLiveEvent(1_002 * HOUR, 'Earth', [later, eclipse], null)).toBe(eclipse);
    expect(resolveLiveEvent(1_002 * HOUR, 'Earth', [eclipse, later], null)).toBe(eclipse);
  });
});
