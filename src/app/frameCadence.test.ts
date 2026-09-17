import { describe, expect, it } from 'vitest';
import {
  ASSUMED_CADENCE_MS, COVER_WINDOW, FrameCadence, MISSED_PERIOD_FACTOR, OBSERVED_WINDOW,
  RAISE_WINDOW, parseRefreshParam,
} from './frameCadence';
import { BUDGET_MS } from './resolutionController';
import { isScreenRate, requestedMsFor, type FrameRate } from './frameRateSetting';

// The streams. A Chromium callback timestamp sits on the vsync grid; a WebKit
// one is the rendering-update time, so it carries the main thread's scheduling
// delay — which is why the schedule counts callbacks and never compares
// timestamps against a deadline.

/** Deterministic, so a failure is the same failure twice. */
function rand(seed: number): () => number {
  let r = seed >>> 0;
  return () => {
    r = (r * 1103515245 + 12345) & 0x7fffffff;
    return r / 0x7fffffff;
  };
}

function grid(hz: number, seconds: number): number[] {
  const refresh = 1000 / hz;
  const n = Math.round(hz * seconds);
  return Array.from({ length: n }, (_, i) => i * refresh);
}

/** `lateP` of the callbacks arrive up to `lateMs` after their refresh, and
 *  `dropP` of them never arrive at all. */
function webkit(hz: number, seconds: number, opts: { lateP?: number; lateMs?: number; dropP?: number; seed?: number } = {}): number[] {
  const { lateP = 0.3, lateMs = 6, dropP = 0, seed = 7 } = opts;
  const refresh = 1000 / hz;
  const n = Math.round(hz * seconds);
  const r = rand(seed);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (r() < dropP) continue;
    out.push(i * refresh + (r() < lateP ? r() * lateMs : 0));
  }
  return out;
}

/** A stream DELIVERED slower than the display's own rate: Low Power Mode, the
 *  iOS thermal cap, a GPU-bound stretch. */
function throttled(hz: number, seconds: number, factor: number): number[] {
  const step = (1000 / hz) * factor;
  const n = Math.round((hz / factor) * seconds);
  return Array.from({ length: n }, (_, i) => i * step);
}

/** Alternating lateness: a tick that overruns its slot delays the next
 *  callback, so the pattern a busy cover produces is not independent noise.
 *  This is the shape a median misreads. */
function alternating(hz: number, n: number, p: number, lateMs: number, seed = 3): number[] {
  const refresh = 1000 / hz;
  const r = rand(seed);
  return Array.from({ length: n }, (_, i) => i * refresh + (r() < p ? lateMs : 0));
}

function cadenceFor(rate: FrameRate, opts: { pinnedCadenceMs?: number } = {}): FrameCadence {
  return new FrameCadence({
    screen: isScreenRate(rate),
    requestedMs: requestedMsFor(rate),
    pinnedCadenceMs: opts.pinnedCadenceMs ?? null,
  });
}

/** Run a stream through the schedule the way animate() does: observe, then
 *  due, then drew on a draw. `forcedUntil` stands in for a cover, a veil or a
 *  capture pin — a draw the cadence never asked for. */
function run(cadence: FrameCadence, stream: readonly number[], opts: { covered?: boolean; forcedUntil?: number } = {}): number[] {
  return runIndexed(cadence, stream, opts).times;
}

/** The same, reporting WHICH callbacks drew. The refresh a draw landed on
 *  cannot be read back off a WebKit timestamp — a callback six milliseconds
 *  late at 120 Hz would look like the next refresh — so the parity of the
 *  schedule is checked against the callback's own position in the stream. */
function runIndexed(
  cadence: FrameCadence,
  stream: readonly number[],
  opts: { covered?: boolean; forcedUntil?: number } = {},
): { times: number[]; indices: number[] } {
  const { covered = false, forcedUntil = -1 } = opts;
  const times: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < stream.length; i++) {
    const t = stream[i];
    cadence.observe(t, covered);
    const due = cadence.due(t);
    if (t < forcedUntil || due) {
      times.push(t);
      indices.push(i);
      cadence.drew(t);
    }
  }
  return { times, indices };
}

/** Calibrate under the cover at a real refresh, then hand the cadence back
 *  live — the sequence every session goes through. */
function calibrated(rate: FrameRate, hz: number): FrameCadence {
  const cadence = cadenceFor(rate);
  run(cadence, grid(hz, 1.5), { covered: true });
  return cadence;
}

const gaps = (draws: readonly number[]): number[] => draws.slice(1).map((t, i) => t - draws[i]);

describe('calibration', () => {
  it('reads a covered 60 Hz boot as 60 Hz', () => {
    const cadence = calibrated('60', 60);
    expect(cadence.state().idleCadenceMs).toBeCloseTo(1000 / 60, 4);
    expect(cadence.state().assumed).toBe(false);
  });

  it('reads a WebKit-style cover as the display, within its stated bound', () => {
    // The bound, not an impossibility: the span can only be shortened by one
    // scheduling delay landing on its first callback, which is at most
    // lateMs / COVER_WINDOW — a tenth of a millisecond here, far below the
    // 15 % raise gate and below every rounding boundary.
    const lateMs = 6;
    for (const hz of [60, 120]) {
      const cadence = cadenceFor('60');
      run(cadence, webkit(hz, 2, { lateMs }), { covered: true });
      const read = cadence.state().idleCadenceMs;
      const truth = 1000 / hz;
      expect(read).toBeGreaterThan(truth - lateMs / COVER_WINDOW);
      expect(read).toBeLessThan(truth * 1.02);
    }
  });

  it('is not fooled faster by alternating late ticks, which is what a median does', () => {
    // The patterns a busy cover really produces, at the amplitudes the review
    // measured a median reading as 72, 90 and 120 Hz on a real 60 Hz screen.
    // A misread that fast is a budget too tight for the display, which slides
    // the picture down and latches.
    for (const [p, lateMs] of [[0.3, 3], [0.5, 3], [0.5, 5], [0.6, 5], [0.6, 8]] as const) {
      const cadence = cadenceFor('120');
      run(cadence, alternating(60, COVER_WINDOW + 1, p, lateMs), { covered: true });
      const read = cadence.state().idleCadenceMs;
      expect(read).toBeGreaterThan(1000 / 60 - lateMs / COVER_WINDOW);
      // Which is what matters: the screen still reads as 60 Hz, so a 120
      // target is capped by the screen rather than pacing into a cliff.
      expect(cadence.state().ticksPerDraw).toBe(1);
      expect(cadence.state().capped).toBe('by the screen');
    }
  });

  it('errs SLOW when callbacks are dropped, never fast', () => {
    const cadence = cadenceFor('60');
    run(cadence, webkit(120, 2, { dropP: 0.3 }), { covered: true });
    expect(cadence.state().idleCadenceMs).toBeGreaterThan(1000 / 120);
  });

  it('assumes 60 Hz where the cover was too short, and says so', () => {
    const cadence = cadenceFor('30');
    // Half a window of covered callbacks, then live.
    run(cadence, grid(60, 0.4), { covered: true });
    run(cadence, grid(60, 0.1).map((t) => t + 1000), { covered: false });
    expect(cadence.state().idleCadenceMs).toBeCloseTo(ASSUMED_CADENCE_MS, 6);
    expect(cadence.state().assumed).toBe(true);
  });

  it('raises live on a confidently faster stream and never lowers on a slower one', () => {
    // A Low Power Mode boot: the cover delivers 30 callbacks a second.
    const cadence = cadenceFor('60');
    run(cadence, grid(30, 3), { covered: true });
    expect(cadence.state().idleCadenceMs).toBeCloseTo(1000 / 30, 3);
    // The mode lifts: callbacks come at 60 and the cadence follows.
    const live = grid(60, 4).map((t) => t + 5000);
    run(cadence, live);
    expect(cadence.state().idleCadenceMs).toBeCloseTo(1000 / 60, 2);
    // Now load halves the delivered rate. The DISPLAY has not changed, so the
    // calibration must not either.
    run(cadence, throttled(60, 6, 2).map((t) => t + 20_000));
    expect(cadence.state().idleCadenceMs).toBeCloseTo(1000 / 60, 2);
  });

  it('holds the cadence where ?refresh= pins it', () => {
    const cadence = cadenceFor('60', { pinnedCadenceMs: 1000 / 120 });
    run(cadence, grid(60, 3), { covered: true });
    run(cadence, grid(60, 4).map((t) => t + 5000));
    expect(cadence.state().idleCadenceMs).toBeCloseTo(1000 / 120, 6);
    expect(cadence.state().pinned).toBe(true);
    expect(cadence.state().ticksPerDraw).toBe(2);
  });

  it('parses ?refresh= only on a dev build, and only a plausible rate', () => {
    expect(parseRefreshParam('?refresh=120', true)).toBeCloseTo(1000 / 120, 6);
    expect(parseRefreshParam('?refresh=120', false)).toBeNull();
    expect(parseRefreshParam('?refresh=0', true)).toBeNull();
    expect(parseRefreshParam('?refresh=abc', true)).toBeNull();
    expect(parseRefreshParam('?fps=60', true)).toBeNull();
  });
});

describe('the derived quantities', () => {
  const table: { hz: number; rate: FrameRate; ticks: number; period: number; budget: number }[] = [
    { hz: 60, rate: 'screen', ticks: 1, period: 16.67, budget: BUDGET_MS },
    { hz: 60, rate: '30', ticks: 2, period: 33.33, budget: 33.33 },
    { hz: 60, rate: '60', ticks: 1, period: 16.67, budget: 16.67 },
    { hz: 60, rate: '120', ticks: 1, period: 16.67, budget: 16.67 },
    { hz: 120, rate: 'screen', ticks: 1, period: 8.33, budget: BUDGET_MS },
    { hz: 120, rate: '30', ticks: 4, period: 33.33, budget: 33.33 },
    { hz: 120, rate: '60', ticks: 2, period: 16.67, budget: 16.67 },
    { hz: 120, rate: '120', ticks: 1, period: 8.33, budget: 8.33 },
    { hz: 144, rate: '30', ticks: 5, period: 34.72, budget: 34.72 },
    { hz: 144, rate: '60', ticks: 2, period: 13.89, budget: 16.67 },
    { hz: 144, rate: '120', ticks: 1, period: 6.94, budget: 8.33 },
    { hz: 90, rate: '30', ticks: 3, period: 33.33, budget: 33.33 },
    { hz: 90, rate: '60', ticks: 2, period: 22.22, budget: 22.22 },
    { hz: 90, rate: '120', ticks: 1, period: 11.11, budget: 11.11 },
    // A 50 Hz panel under Screen keeps today's budget, churn and all.
    { hz: 50, rate: 'screen', ticks: 1, period: 20, budget: BUDGET_MS },
  ];

  for (const row of table) {
    it(`${row.hz} Hz at ${row.rate}: every ${row.ticks} tick(s), ${row.period} ms, budget ${Math.round(row.budget * 100) / 100}`, () => {
      const cadence = calibrated(row.rate, row.hz);
      const fps = cadence.state();
      expect(fps.ticksPerDraw).toBe(row.ticks);
      expect(fps.periodMs).toBeCloseTo(row.period, 1);
      expect(fps.budgetMs).toBeCloseTo(row.budget, 1);
    });
  }

  it('the request bounds the budget from below, so 60 on 144 Hz defends 60 and not 72', () => {
    const cadence = calibrated('60', 144);
    expect(Math.round(1000 / cadence.state().periodMs)).toBe(72);
    expect(cadence.state().budgetMs).toBeCloseTo(BUDGET_MS, 4);
  });

  it('names why the delivered rate is not the requested one', () => {
    expect(calibrated('screen', 60).state().capped).toBe('no');
    expect(calibrated('60', 60).state().capped).toBe('no');
    expect(calibrated('120', 60).state().capped).toBe('by the screen');
    expect(calibrated('60', 144).state().capped).toBe('rounded');
    expect(calibrated('30', 144).state().capped).toBe('rounded');
    // A browser holding the callbacks at 30 a second on a 60 Hz screen.
    const throttledSession = calibrated('60', 60);
    run(throttledSession, throttled(60, 4, 2).map((t) => t + 5000));
    expect(throttledSession.state().capped).toBe('by the browser');
  });

  it('is uncalibrated as today: one draw a callback, and a budget no tighter than the request', () => {
    for (const rate of ['screen', '30', '60', '120'] as FrameRate[]) {
      const cadence = cadenceFor(rate);
      expect(cadence.state().calibrated).toBe(false);
      expect(cadence.state().ticksPerDraw).toBe(1);
      expect(cadence.state().budgetMs).toBeCloseTo(
        rate === 'screen' ? BUDGET_MS : Math.max(ASSUMED_CADENCE_MS, requestedMsFor(rate)), 4,
      );
    }
  });
});

describe('the schedule', () => {
  const rates: FrameRate[] = ['screen', '30', '60', '120'];

  for (const hz of [60, 90, 120, 144]) {
    for (const rate of rates) {
      for (const shape of ['grid', 'webkit'] as const) {
        it(`${hz} Hz ${shape} at ${rate}: the nominal count, with the refresh parity exact`, () => {
          const cadence = calibrated(rate, hz);
          const ticks = cadence.state().ticksPerDraw;
          const stream = shape === 'grid' ? grid(hz, 10) : webkit(hz, 10);
          const { times, indices } = runIndexed(cadence, stream.map((t) => t + 100_000));
          const nominal = Math.round(stream.length / ticks);
          expect(Math.abs(times.length - nominal)).toBeLessThanOrEqual(1);
          // Every draw is exactly ticksPerDraw callbacks after the last one,
          // whatever the scheduling delay did to the timestamps.
          const steps = new Set(indices.slice(1).map((v, i) => v - indices[i]));
          expect([...steps]).toEqual([ticks]);
        });
      }
    }
  }

  it('Screen draws every callback, even where a timestamp comparison would not', () => {
    const cadence = calibrated('screen', 120);
    const stream = webkit(120, 5);
    const draws = run(cadence, stream.map((t) => t + 100_000));
    expect(draws).toHaveLength(stream.length);
  });

  it('a dropped callback shifts the phase by one refresh and nothing accumulates', () => {
    const cadence = calibrated('60', 120);
    const stream = webkit(120, 20, { dropP: 0.05 });
    const draws = run(cadence, stream.map((t) => t + 100_000));
    // Every interval is still N callbacks; a drop costs that one draw's
    // phase, not the schedule.
    expect(draws.length).toBeGreaterThan(0.9 * Math.floor(stream.length / 2));
    expect(Math.max(...gaps(draws))).toBeLessThan(4 * cadence.state().periodMs);
  });

  it('draws now when the stream breaks for longer than a period and a half', () => {
    const cadence = calibrated('30', 60);
    const period = cadence.state().periodMs;
    // One callback, then a long stall, then the stream resumes.
    const stream = [100_000, 100_000 + MISSED_PERIOD_FACTOR * period + 1];
    const draws = run(cadence, stream);
    expect(draws).toEqual(stream);
  });

  it('never fires the missed-period rule on a stream that is merely slower than the pin', () => {
    // `?refresh=120` on a machine delivering 60 callbacks a second: the
    // pretended period (4 x 8.33 = 33.3) lands between two real callbacks, so
    // a threshold derived from it would fire on the third of every four and
    // the target would be missed by a quarter.
    const cadence = cadenceFor('30', { pinnedCadenceMs: 1000 / 120 });
    run(cadence, grid(60, 2), { covered: true });
    expect(cadence.state().ticksPerDraw).toBe(4);
    const { indices } = runIndexed(cadence, grid(60, 12).map((t) => t + 100_000));
    const steps = new Set(indices.slice(1).map((v, i) => v - indices[i]));
    expect([...steps]).toEqual([4]);
  });

  it('a hidden tab comes back drawing, not waiting out a count', () => {
    const cadence = calibrated('30', 60);
    const before = run(cadence, grid(60, 2).map((t) => t + 100_000));
    expect(before.length).toBeGreaterThan(0);
    const after = run(cadence, [200_000, 200_016.7]);
    expect(after[0]).toBe(200_000);
  });

  it('forced draws reset the count and can never freeze the picture', () => {
    // A second of forced draws (a veil, a capture pin), then release.
    const cadence = calibrated('30', 60);
    const stream = grid(60, 5).map((t) => t + 100_000);
    const draws = run(cadence, stream, { forcedUntil: 101_000 });
    const afterRelease = draws.filter((t) => t >= 101_000);
    expect(afterRelease[0]).toBeLessThan(101_000 + 2 * cadence.state().periodMs);
    expect(Math.max(...gaps(draws))).toBeLessThanOrEqual(cadence.state().periodMs + 1e-6);
  });

  it('counts one callback per call, so a second read of the same tick would change the cadence', () => {
    const cadence = calibrated('30', 60);
    expect(cadence.state().ticksPerDraw).toBe(2);
    // A draw, then the callback right after it: not due, one of two.
    cadence.drew(200_000);
    const t = 200_000 + 1000 / 60;
    cadence.observe(t, false);
    expect(cadence.due(t)).toBe(false);
    // The hazard this pins: asked twice, the same callback becomes due — which
    // is why animate() calls it once, unconditionally, and ORs the result.
    expect(cadence.due(t)).toBe(true);
  });
});

describe('a stream slower than the display', () => {
  // The defect this divisor exists for: dividing the CALIBRATED refresh would
  // multiply a throttle by ticksPerDraw — 15 fps at a 30 target on a 60 Hz
  // screen delivering 30 callbacks a second.
  for (const [hz, factor, rate, asked] of [
    [60, 2, '30', 30], [60, 2, '60', 60], [120, 2, '60', 60], [120, 2, '30', 30], [60, 3, '30', 30],
  ] as const) {
    for (const shape of ['grid', 'webkit'] as const) {
      it(`${hz} Hz delivering 1/${factor} of its callbacks at ${rate} still draws at the rate it can`, () => {
        const cadence = calibrated(rate as FrameRate, hz);
        const base = 100_000;
        const stream = shape === 'grid'
          ? throttled(hz, 12, factor)
          : throttled(hz, 12, factor).map((t, i) => t + (i % 3 === 0 ? 2.5 : 0));
        const draws = run(cadence, stream.map((t) => t + base));
        // Measured over the last four seconds, past the window that learns
        // the delivered rate.
        const late = draws.filter((t) => t >= base + 8000);
        const rateNow = (late.length - 1) * 1000 / (late[late.length - 1] - late[0]);
        const delivered = hz / factor;
        expect(rateNow).toBeGreaterThan(Math.min(asked, delivered) * 0.9);
        // And the budget has not moved: a throttle must not relax what a
        // frame is measured against.
        expect(cadence.state().budgetMs).toBeCloseTo(
          Math.max(cadence.state().ticksPerDraw * (1000 / hz), requestedMsFor(rate as FrameRate)), 1,
        );
      });
    }
  }

  it('paces at N again once the stream recovers', () => {
    const cadence = calibrated('30', 120);
    expect(cadence.state().ticksPerDraw).toBe(4);
    run(cadence, throttled(120, 6, 2).map((t) => t + 100_000));
    expect(cadence.state().ticksPerDraw).toBe(2);
    run(cadence, grid(120, 6).map((t) => t + 200_000));
    expect(cadence.state().ticksPerDraw).toBe(4);
  });
});

describe('what it tells the rest of the app', () => {
  it('never moves the budget while Screen holds, whatever the display is', () => {
    const cadence = cadenceFor('screen');
    // Screen's first derivation is the default budget, so there is nothing
    // for the controller to be told.
    expect(cadence.takeChange()?.budgetChanged).toBe(false);
    run(cadence, grid(120, 3), { covered: true });
    const change = cadence.takeChange();
    // A calibration under Screen may report the display for the debug line,
    // but it can never move the budget.
    expect(change?.budgetChanged ?? false).toBe(false);
    expect(cadence.state().budgetMs).toBeCloseTo(BUDGET_MS, 6);
  });

  it('hands the boot budget over even where the calibration confirms it', () => {
    // A 30 fps boot on a 60 Hz screen: the constructor derives 33.33 and the
    // covered calibration lands on exactly the same number. Without the
    // constructor's own change the controller would never hear it and would
    // defend 60 fps with pixels while the row asked for 30.
    const cadence = cadenceFor('30');
    const first = cadence.takeChange();
    expect(first?.budgetChanged).toBe(true);
    expect(first?.readout.budgetMs).toBeCloseTo(1000 / 30, 4);
    run(cadence, grid(60, 2), { covered: true });
    expect(cadence.state().budgetMs).toBeCloseTo(1000 / 30, 4);
  });

  it('a raise is an automatic change; the row is a user change', () => {
    const cadence = cadenceFor('60');
    run(cadence, grid(30, 3), { covered: true });
    cadence.takeChange();
    run(cadence, grid(60, 4).map((t) => t + 5000));
    const raised = cadence.takeChange();
    expect(raised?.cause).toBe('auto');
    expect(raised?.budgetChanged).toBe(true);
    cadence.setRate(false, requestedMsFor('30'));
    const picked = cadence.takeChange();
    expect(picked?.cause).toBe('user');
  });

  it('reports the rate it really drew', () => {
    const cadence = calibrated('30', 60);
    run(cadence, grid(60, 4).map((t) => t + 100_000));
    expect(cadence.state().drawnRate).toBeGreaterThan(28);
    expect(cadence.state().drawnRate).toBeLessThan(32);
  });

  it('the windows it reads are sized as the header says', () => {
    expect(COVER_WINDOW).toBe(60);
    expect(OBSERVED_WINDOW).toBe(60);
    expect(RAISE_WINDOW).toBe(120);
  });
});
