import { describe, expect, it } from 'vitest';
import { markOpenStep, markUncoveredStep, startOpenStopwatch } from './openTimings';

describe('an open\'s stopwatch', () => {
  it('marks a step once, to a tenth of a millisecond, from the open\'s own start', () => {
    const watch = startOpenStopwatch('entry', 'Earth');
    expect(watch.timings.prepareStart).toBeNull();
    markOpenStep(watch, 'prepareStart');
    const first = watch.timings.prepareStart;
    expect(first).not.toBeNull();
    expect(first).toBeGreaterThanOrEqual(0);
    expect(Math.round(first! * 10)).toBe(first! * 10); // a tenth, not a float's tail
    // A step reached twice (a reveal onto the body that was already on) keeps
    // the moment the reader waited for.
    markOpenStep(watch, 'prepareStart');
    expect(watch.timings.prepareStart).toBe(first);
  });

  it('gives every open its own id', () => {
    const first = startOpenStopwatch('entry', 'Earth');
    const second = startOpenStopwatch('swap', 'Mars');
    expect(second.id).toBeGreaterThan(first.id);
    expect(second.timings.kind).toBe('swap');
    expect(second.timings.bodyId).toBe('Mars');
  });
});

describe('the veil\'s marks', () => {
  const at = (watch: { startedAt: number }, ms: number) => watch.startedAt + ms;

  it('writes into the entry that asked for them, once', () => {
    const watch = startOpenStopwatch('entry', 'Earth');
    expect(markUncoveredStep(watch, watch.id, 'veilLifted', at(watch, 300), true)).toBe(300);
    expect(watch.timings.veilLifted).toBe(300);
    // The transition's own end and the timer standing in for it both call:
    // whichever arrives second is a no-op.
    expect(markUncoveredStep(watch, watch.id, 'veilLifted', at(watch, 450), true)).toBeNull();
    expect(watch.timings.veilLifted).toBe(300);
    expect(markUncoveredStep(watch, watch.id, 'firstVisibleFrame', at(watch, 316), true)).toBe(316);
  });

  it('refuses an open that a pick has taken over', () => {
    const entry = startOpenStopwatch('entry', 'Earth');
    const swap = startOpenStopwatch('swap', 'Mars');
    // Main still holds the entry's id; the live stopwatch is the pick's.
    expect(markUncoveredStep(swap, entry.id, 'veilLifted', at(swap, 300), true)).toBeNull();
    expect(swap.timings.veilLifted).toBeNull();
    // And a swap never carries them, even asked for by its own id: it has no veil.
    expect(markUncoveredStep(swap, swap.id, 'veilLifted', at(swap, 300), true)).toBeNull();
  });

  it('refuses a mode that has been left', () => {
    // An exit during the lift: the switch out re-covers the screen, so the
    // lift's transitionend never comes and the timer standing in for it fires
    // a fade later. It must not record a black screen as the moment the reader
    // saw the body, nor the planetarium's next frame as the tool's first
    // visible one.
    const watch = startOpenStopwatch('entry', 'Earth');
    expect(markUncoveredStep(watch, watch.id, 'veilLifted', at(watch, 450), false)).toBeNull();
    expect(markUncoveredStep(watch, watch.id, 'firstVisibleFrame', at(watch, 470), false)).toBeNull();
    expect(watch.timings.veilLifted).toBeNull();
    expect(watch.timings.firstVisibleFrame).toBeNull();
    // Still refused when the reader comes back: this open is over either way.
    expect(markUncoveredStep(watch, watch.id, 'veilLifted', at(watch, 900), true)).toBe(900);
  });

  it('refuses an entry that was never the open it names', () => {
    const watch = startOpenStopwatch('entry', 'Earth');
    expect(markUncoveredStep(watch, watch.id + 7, 'veilLifted', at(watch, 300), true)).toBeNull();
    expect(watch.timings.veilLifted).toBeNull();
  });
});
