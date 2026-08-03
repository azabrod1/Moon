import { describe, expect, it } from 'vitest';
import {
  MAP_EVENT_RESEED_MS,
  guardMapEvent,
  latchMapEventReverse,
  makeMapEventReverseLatch,
  mapEventGuardAction,
  mapEventReverseRunning,
  mapEventSearchTarget,
  resetMapEventReverseLatch,
  type MapEventGuardInput,
  type MapEventGuardTickInput,
} from './mapEvents';

describe('mapEventSearchTarget', () => {
  it('sends a moon to its parent system', () => {
    expect(mapEventSearchTarget('Io')).toBe('Jupiter');
    expect(mapEventSearchTarget('Titan')).toBe('Saturn');
    expect(mapEventSearchTarget('Moon')).toBe('Earth');
  });

  it('keeps a planet with moons on itself', () => {
    expect(mapEventSearchTarget('Jupiter')).toBe('Jupiter');
    expect(mapEventSearchTarget('Earth')).toBe('Earth');
    expect(mapEventSearchTarget('Pluto')).toBe('Pluto');
  });

  it('has nothing to report for a moonless body or the Sun', () => {
    expect(mapEventSearchTarget('Mercury')).toBeNull();
    expect(mapEventSearchTarget('Venus')).toBeNull();
    expect(mapEventSearchTarget('Sun')).toBeNull();
  });

  it('is null for a name the chart does not know', () => {
    expect(mapEventSearchTarget('Vulcan')).toBeNull();
  });
});

describe('mapEventReverseRunning', () => {
  it('is only true for a clock actually running backwards', () => {
    expect(mapEventReverseRunning(-3600, false)).toBe(true);
    expect(mapEventReverseRunning(-3600, true)).toBe(false);
    expect(mapEventReverseRunning(3600, false)).toBe(false);
    expect(mapEventReverseRunning(0, false)).toBe(false);
  });
});

describe('latchMapEventReverse', () => {
  it('holds through frames the guard never sees', () => {
    const latch = makeMapEventReverseLatch();
    latchMapEventReverse(latch, -3600, false); // one backward frame
    latchMapEventReverse(latch, 1, false); // forward again before any guard look
    expect(latch.seenReverse).toBe(true);
  });

  it('never sets for a paused clock, whatever its rate', () => {
    const latch = makeMapEventReverseLatch();
    latchMapEventReverse(latch, -3600, true);
    latchMapEventReverse(latch, 0, true);
    expect(latch.seenReverse).toBe(false);
  });

  it('clears on reset, and re-latches from a still-backward clock next frame', () => {
    const latch = makeMapEventReverseLatch();
    latchMapEventReverse(latch, -3600, false);
    resetMapEventReverseLatch(latch);
    expect(latch.seenReverse).toBe(false);
    latchMapEventReverse(latch, -3600, false);
    expect(latch.seenReverse).toBe(true);
  });
});

const NOW = Date.parse('2026-08-03T00:00:00Z');
const base: MapEventGuardInput = {
  nowUtcMs: NOW,
  timeRate: 1,
  paused: false,
  wasReverse: false,
  searching: false,
  fromUtcMs: NOW,
  rowEndUtcMs: null,
};

describe('mapEventGuardAction', () => {
  it('idles through sustained reverse, however far the clock recedes', () => {
    let now = NOW;
    let wasReverse = false;
    let restarts = 0;
    for (let i = 0; i < 200; i++) {
      now -= 3_600_000; // a running-backwards clock recedes every tick
      const action = mapEventGuardAction({
        ...base, nowUtcMs: now, timeRate: -3600, paused: false, wasReverse, searching: true,
      });
      if (action !== 'none') restarts++;
      wasReverse = mapEventReverseRunning(-3600, false);
    }
    expect(restarts).toBe(0);
  });

  it('restarts exactly once on the return to forward', () => {
    let wasReverse = true;
    const actions: string[] = [];
    let fromUtcMs = NOW;
    let now = NOW - 10 * 86_400_000; // reverse left the clock well behind
    for (let i = 0; i < 5; i++) {
      const action = mapEventGuardAction({
        ...base, nowUtcMs: now, timeRate: 1, paused: false, wasReverse, searching: true, fromUtcMs,
      });
      actions.push(action);
      if (action !== 'none') fromUtcMs = now; // a restart re-anchors
      wasReverse = false;
      now += 1000;
    }
    expect(actions.filter((a) => a !== 'none')).toEqual(['restart']);
  });

  it('replaces an in-flight sweep exactly once after a backward jump', () => {
    // A dev setTimeMs / typed date lands the clock behind the anchor while a
    // sweep is running.
    let fromUtcMs = NOW;
    let now = NOW - 30 * 86_400_000;
    const actions: string[] = [];
    for (let i = 0; i < 5; i++) {
      const action = mapEventGuardAction({
        ...base, nowUtcMs: now, fromUtcMs, searching: true,
      });
      actions.push(action);
      if (action !== 'none') fromUtcMs = now;
      now += 1000; // the clock runs on forward from where it landed
    }
    expect(actions.filter((a) => a !== 'none')).toEqual(['restart']);
  });

  it('restarts after a reversal over entirely between two guard looks, then pause', () => {
    // The production sequence, driven end to end: every rendered frame calls
    // latchMapEventReverse, the guard tick calls guardMapEvent (which consumes
    // the latch itself), a restart calls resetMapEventReverseLatch. A
    // two-frame backward scrub between guard ticks clears the row (frames do
    // that directly), so the tick must still see it happened.
    const fromUtcMs = NOW - 3_600_000; // sweep anchored an hour back, completed
    let now = NOW;
    const latch = makeMapEventReverseLatch();
    const frames: Array<{ rate: number; paused: boolean }> = [
      { rate: 1, paused: false },
      { rate: -3600, paused: false }, // the scrub — no guard tick lands inside it
      { rate: -3600, paused: false },
      // Paused before the guard looks again. Pausing keeps the rate's sign —
      // that is what the time panel does — so the look below must too.
      { rate: -3600, paused: true },
      { rate: -3600, paused: true },
    ];
    for (const f of frames) {
      if (!f.paused) now += f.rate * 16; // ~16 ms rendered frames
      latchMapEventReverse(latch, f.rate, f.paused);
    }
    // The scrub stayed ahead of the anchor, so the behind-the-anchor restart
    // cannot be what saves the row here.
    expect(now).toBeGreaterThan(fromUtcMs);
    const look: MapEventGuardTickInput = {
      nowUtcMs: now,
      timeRate: -3600,
      paused: true,
      searching: false,
      fromUtcMs,
      rowEndUtcMs: null, // the backward frames cleared the row
    };
    expect(guardMapEvent(latch, look)).toBe('restart');
    // The tick consumed the latch: from a paused clock it re-seeds to false.
    expect(latch.seenReverse).toBe(false);
    // Sampling instead of latching — what the guard would have seen on its
    // own — leaves the cleared row waiting on the seven-day re-seed.
    expect(mapEventGuardAction({ ...look, wasReverse: false })).toBe('none');
  });

  it('restarts exactly once after a reversal the guard never saw, then forward', () => {
    let now = NOW;
    const latch = makeMapEventReverseLatch();
    for (const rate of [-3600, -3600, 1, 1, 1]) {
      now += rate * 16;
      latchMapEventReverse(latch, rate, false);
    }
    let fromUtcMs = NOW - 3_600_000;
    let searching = false; // the sweep had completed before the scrub
    const actions: string[] = [];
    for (let tick = 0; tick < 3; tick++) {
      const action = guardMapEvent(latch, {
        nowUtcMs: now,
        timeRate: 1,
        paused: false,
        searching,
        fromUtcMs,
        rowEndUtcMs: null,
      });
      actions.push(action);
      if (action !== 'none') {
        // The restart the owner runs: re-anchor and consume, as
        // startMapEventSearch does.
        fromUtcMs = now;
        searching = true;
        resetMapEventReverseLatch(latch);
      }
      for (let f = 0; f < 8; f++) {
        now += 16;
        latchMapEventReverse(latch, 1, false);
      }
    }
    expect(actions.filter((a) => a !== 'none')).toEqual(['restart']);
  });

  it('keeps sustained reverse restart-free through the production tick', () => {
    // guardMapEvent's own consume/re-seed must not turn a still-backward
    // clock into a restart on any later tick. The anchor sits a day back so
    // the receding clock never crosses it — the final restart below can only
    // come from the latch the ticks re-seed, not the behind-the-anchor branch.
    const fromUtcMs = NOW - 86_400_000;
    let now = NOW;
    const latch = makeMapEventReverseLatch();
    const actions: string[] = [];
    for (let tick = 0; tick < 20; tick++) {
      for (let f = 0; f < 8; f++) {
        now -= 3600 * 16;
        latchMapEventReverse(latch, -3600, false);
      }
      actions.push(guardMapEvent(latch, {
        nowUtcMs: now,
        timeRate: -3600,
        paused: false,
        searching: false,
        fromUtcMs,
        rowEndUtcMs: null,
      }));
      // A tick landing mid-reverse re-seeds from the live clock: a reversal
      // that ends right after this tick must still be remembered by the next.
      expect(latch.seenReverse).toBe(true);
    }
    expect(actions.every((a) => a === 'none')).toBe(true);
    expect(now).toBeGreaterThan(fromUtcMs);
    // Forward resumes with no reverse frame between the last tick and the
    // next — the re-seed is the only thing carrying the reversal across.
    latchMapEventReverse(latch, 1, false);
    expect(guardMapEvent(latch, {
      nowUtcMs: now,
      timeRate: 1,
      paused: false,
      searching: false,
      fromUtcMs,
      rowEndUtcMs: null,
    })).toBe('restart');
  });

  it('searches and shows from a paused clock with a negative rate', () => {
    expect(mapEventGuardAction({ ...base, timeRate: -3600, paused: true })).toBe('none');
    expect(mapEventReverseRunning(-3600, true)).toBe(false);
  });

  it('holds a paused-negative clock steady through the production tick', () => {
    // A paused clock is a fixed instant whichever way its rate points: the
    // frames must not latch and the ticks must not re-seed, however long it
    // sits — one wrongly re-seeded tick would restart the next, clear the
    // latch, re-seed again, and blank the row every other tick forever.
    const latch = makeMapEventReverseLatch();
    for (let tick = 0; tick < 10; tick++) {
      for (let f = 0; f < 8; f++) latchMapEventReverse(latch, -3600, true);
      expect(guardMapEvent(latch, {
        nowUtcMs: NOW,
        timeRate: -3600,
        paused: true,
        searching: false,
        fromUtcMs: NOW,
        rowEndUtcMs: null,
      })).toBe('none');
      expect(latch.seenReverse).toBe(false);
    }
  });

  it('restarts from the fixed instant when reverse is paused', () => {
    // The clock stopped somewhere behind the anchor: the row comes back from
    // where it now stands.
    const action = mapEventGuardAction({
      ...base,
      nowUtcMs: NOW - 5 * 86_400_000,
      timeRate: -3600,
      paused: true,
      wasReverse: true,
      searching: true,
    });
    expect(action).toBe('restart');
  });

  it('hides without restarting when a paused backward clock is released', () => {
    const action = mapEventGuardAction({
      ...base, timeRate: -3600, paused: false, wasReverse: false, searching: true,
    });
    expect(action).toBe('none');
  });

  it('bounds a fast forward warp to one restart per completed sweep', () => {
    // 1 yr/s: seven simulated days pass in ~20 ms, so the re-seed predicate is
    // true almost every tick. It may only act between sweeps.
    let now = NOW;
    let fromUtcMs = NOW;
    let restarts = 0;
    let searching = true;
    let sweepTicks = 0;
    for (let i = 0; i < 300; i++) {
      now += 30 * 86_400_000;
      const action = mapEventGuardAction({ ...base, nowUtcMs: now, fromUtcMs, searching });
      if (action !== 'none') {
        restarts++;
        fromUtcMs = now;
        searching = true;
        sweepTicks = 0;
      } else if (searching && ++sweepTicks >= 20) {
        searching = false; // a sweep completing, empty-handed
      }
    }
    // One restart per completed sweep, not one per tick.
    expect(restarts).toBeGreaterThan(0);
    expect(restarts).toBeLessThanOrEqual(300 / 20);
  });

  it('re-seeds a stale empty answer, but not a fresh one', () => {
    expect(mapEventGuardAction({
      ...base, nowUtcMs: NOW + MAP_EVENT_RESEED_MS + 1, fromUtcMs: NOW,
    })).toBe('restart');
    expect(mapEventGuardAction({
      ...base, nowUtcMs: NOW + MAP_EVENT_RESEED_MS - 1, fromUtcMs: NOW,
    })).toBe('none');
  });

  it('hands over when the shown event ends, and never re-seeds under one', () => {
    expect(mapEventGuardAction({
      ...base, rowEndUtcMs: NOW - 1,
    })).toBe('restart-preserve');
    // A live row far past the re-seed window keeps the row: it is not stale,
    // it is happening.
    expect(mapEventGuardAction({
      ...base, nowUtcMs: NOW + MAP_EVENT_RESEED_MS * 3, rowEndUtcMs: NOW + MAP_EVENT_RESEED_MS * 4,
      fromUtcMs: NOW,
    })).toBe('none');
  });

  it('does no housekeeping while a sweep is in flight', () => {
    expect(mapEventGuardAction({
      ...base, searching: true, rowEndUtcMs: NOW - 1,
    })).toBe('none');
    expect(mapEventGuardAction({
      ...base, searching: true, nowUtcMs: NOW + MAP_EVENT_RESEED_MS * 2, fromUtcMs: NOW,
    })).toBe('none');
  });

  it('stands down before the first sweep has an anchor', () => {
    expect(mapEventGuardAction({ ...base, fromUtcMs: Number.NaN })).toBe('none');
  });
});
