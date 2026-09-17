/**
 * The frame-rate cap's schedule: how often the loop DRAWS, and what the
 * display is delivering.
 *
 * Pure and DOM-free. It is fed every animation callback's rAF timestamp and
 * whether the boot cover was up, and it answers one question per tick — draw
 * this one? — plus the three quantities the rest of the app reads.
 *
 * **Three quantities, kept apart.**
 *  - `requestedMs` is 1000 / the Frame rate row's value, and nothing else ever
 *    writes it. "Screen" is the row's default and means today's loop: draw on
 *    every callback, whatever the display's rate.
 *  - `idleCadenceMs` is the display's own cadence as this browser exposes it
 *    (iOS Safari delivers 60 on a 120 Hz panel unless the user opts in, and
 *    that 60 IS the number a schedule needs). It is calibrated under the boot
 *    cover, where draws are gated and the GPU is idle by construction, and is
 *    RAISED live on confident faster evidence but never lowered: callbacks
 *    cannot arrive faster than the display delivers them, so faster is always
 *    real, while slower is load or a throttle and never the display.
 *  - `observedCadenceMs` is the live delivered cadence, one 60-callback window
 *    at a time. It paces, and it never touches the budget: a GPU-bound 60 Hz
 *    session delivering 30 callbacks a second must still read its frames as
 *    over budget, because that is the down-step it needs.
 *
 * **Pacing follows the delivered cadence; the budget follows the display.**
 * A counter that divides the calibrated refresh would amplify any slowdown by
 * `ticksPerDraw` — a 60 Hz session throttled to 30 callbacks a second would
 * draw 15 at a 30 target — so the divisor is `max(idleCadenceMs,
 * observedCadenceMs)`: a stream delivering at half the calibrated refresh
 * draws every callback and the requested rate is still met. The budget stays
 * on `idleCadenceMs`, so the separation above survives. The divisor carries
 * hysteresis, because a request can land exactly between two of them — 60 on
 * a 90 Hz screen is 1.5 — and ordinary jitter would otherwise flip such a
 * display between 45 and 90 fps window after window.
 *
 * **The schedule counts callbacks; timestamps only detect a broken stream.**
 * On a vsync-driven stream "every N-th callback" IS the phase-locked schedule:
 * the interval is N refreshes whatever the callback-entry jitter, and whatever
 * WebKit's scheduling delay does to the reported timestamp. A half-refresh
 * tolerance compared against a running deadline was measured on a WebKit-style
 * stream to step 1, 2 or 3 refreshes apart at 120 Hz — the 16/50 ms
 * alternation half-rate vsync exists to avoid — where the counter gives the
 * nominal count exactly. A dropped callback shifts the phase by one refresh
 * and the next interval is still N callbacks; nothing accumulates, and there
 * is no deadline to run away, so a forced draw (a covered boot, a veil's one
 * required frame, a capture pin) merely resets the count.
 *
 * The rAF timestamp is used for one thing only: the missed-period test, where
 * it is compared against itself over a span of a period and a half. Everywhere
 * else in this repo an rAF timestamp is refused for measurement because it
 * goes stale behind a busy main thread; here staleness of a few milliseconds
 * cannot reach that threshold.
 *
 * **The estimator is a span over its own interval count — never a median.**
 * A median reads FASTER under alternating late ticks (a 60 Hz cover with half
 * its ticks 3 ms late reads 72 Hz; 5 ms late, 90 Hz), and a fast misread is a
 * budget too tight for the display, which slides the picture down and latches.
 * A span divided by the number of intervals inside it telescopes: dropped
 * callbacks lengthen the span and lower the count together, so it reads the
 * truth or SLOWER, and its worst fast term is one scheduling delay spread over
 * the window — about 0.1 ms at 60 intervals, far below the 15 % raise gate and
 * below every rounding boundary. Slow is the safe direction: it rounds
 * `ticksPerDraw` to 1, which is today's loop.
 */

import { BUDGET_MS } from './resolutionController';

/** What Screen requests. It paces nothing — `ticksPerDraw` is forced to 1 —
 *  but the number is what the readout reports and what the budget holds. */
export const SCREEN_REQUEST_MS = 1000 / 60;

/** Intervals a calibration window needs under the cover before it is read. */
export const COVER_WINDOW = 60;

/** Intervals in a live delivered-cadence window: two seconds at 30 callbacks
 *  a second, which is how fast a throttle is seen. */
export const OBSERVED_WINDOW = 60;

/** Intervals a live window needs before it may RAISE the calibration. More
 *  than the delivered window asks for: a raise changes the budget. */
export const RAISE_WINDOW = 120;

/** How much faster than the calibration a live window must read before it is
 *  believed. */
export const RAISE_MARGIN = 0.15;

/** What a boot too short to calibrate assumes: the common case. The live
 *  raise is the way out of it. */
export const ASSUMED_CADENCE_MS = 1000 / 60;

/** A draw this far past the last one is a broken stream — a hidden tab, a
 *  stall — and draws now whatever the count says. */
export const MISSED_PERIOD_FACTOR = 1.5;

/** Why the delivered rate is not the requested one. */
export type FrameRateCap = 'no' | 'by the screen' | 'by the browser' | 'rounded';

/** Everything `__moon.quality().fps` reports of the schedule. */
export interface FrameCadenceReadout {
  /** The row's value: the word for Screen, else frames per second. */
  requested: 'screen' | number;
  idleCadenceMs: number;
  observedCadenceMs: number | null;
  ticksPerDraw: number;
  periodMs: number;
  /** What the resolution controller is held to — `max(period, requested)`,
   *  except under Screen, which is today's constant on every display. */
  budgetMs: number;
  /** Draws a second, measured over the last full second of draws. */
  drawnRate: number;
  capped: FrameRateCap;
  /** True where no cover was long enough to calibrate and 60 Hz was assumed. */
  assumed: boolean;
  /** True once a cover has been measured or the assumption has been made. */
  calibrated: boolean;
  /** True while DEV `?refresh=` pins the cadence. */
  pinned: boolean;
}

/** A change worth telling the rest of the app about. */
export interface FrameCadenceChange {
  readout: FrameCadenceReadout;
  /** Whether `budgetMs` moved — the only reason to disturb the controller. */
  budgetChanged: boolean;
  /** A user's change (the row, the bridge) drops everything the controller
   *  learned; an automatic one (a cadence raise) keeps what is a fact about
   *  the device. */
  cause: 'user' | 'auto';
}

/** The DEV `?refresh=<hz>` pin: be a 120 Hz screen on a 60 Hz one, which is
 *  how the pacing gate measures a fast display without owning one. Returns the
 *  cadence in ms, or null where nothing legible was asked for. */
export function parseRefreshParam(search: string, dev: boolean): number | null {
  if (!dev) return null;
  const raw = new URLSearchParams(search).get('refresh');
  if (raw === null || raw.trim() === '') return null;
  const hz = Number(raw);
  if (!Number.isFinite(hz) || hz < 10 || hz > 1000) return null;
  return 1000 / hz;
}

export class FrameCadence {
  private screen: boolean;
  private requestedMs: number;
  private readonly pinnedMs: number | null;

  private idleMs = ASSUMED_CADENCE_MS;
  private observedMs: number | null = null;
  private calibrated = false;
  private assumed = false;

  private ticks = 1;
  private periodMs = ASSUMED_CADENCE_MS;
  private budget = BUDGET_MS;
  /** How long after a draw a broken stream is declared: a period and a half
   *  of DELIVERED callbacks. */
  private missedAfterMs = MISSED_PERIOD_FACTOR * ASSUMED_CADENCE_MS;

  /** Callbacks since the last draw, and the last draw's timestamp: the whole
   *  schedule. */
  private since = 0;
  private lastDrawT: number | null = null;

  private wasCovered = true;
  private coverStartT: number | null = null;
  private coverIntervals = 0;
  private coverBestMs: number | null = null;
  private obsStartT: number | null = null;
  private obsIntervals = 0;
  private raiseStartT: number | null = null;
  private raiseIntervals = 0;

  /** Whether a divisor has been derived from a real cadence yet. The first
   *  one is taken outright; only later ones are held against it. */
  private ticksSettled = false;
  /** Whether the schedule has ever been reported: the first reading is a line
   *  on the debug overlay whether or not it moved anything. */
  private everReported = false;

  private rateStartT: number | null = null;
  private rateDraws = 0;
  private drawnRate = 0;

  private change: FrameCadenceChange | null = null;

  constructor(opts: { screen: boolean; requestedMs: number; pinnedCadenceMs?: number | null }) {
    this.screen = opts.screen;
    this.requestedMs = opts.requestedMs;
    this.pinnedMs = opts.pinnedCadenceMs ?? null;
    if (this.pinnedMs !== null) {
      this.idleMs = this.pinnedMs;
      this.calibrated = true;
    }
    this.recompute('user');
    // The constructor's own derivation is the session's starting point, not a
    // change anybody has to be told about.
    this.change = null;
  }

  /** The row picked a value. Screen forces `ticksPerDraw` to 1. */
  setRate(screen: boolean, requestedMs: number): void {
    if (screen === this.screen && requestedMs === this.requestedMs) return;
    this.screen = screen;
    this.requestedMs = requestedMs;
    this.since = 0;
    // A new request is a fresh question: the divisor is derived outright
    // rather than held against the one the old request settled on.
    this.ticksSettled = false;
    this.recompute('user');
  }

  /**
   * One animation callback, before `due`. Feeds the calibration and the
   * delivered-cadence windows; never decides anything about this tick.
   */
  observe(t: number, covered: boolean): void {
    if (covered) {
      this.observeCovered(t);
      return;
    }
    if (this.wasCovered) {
      this.wasCovered = false;
      this.coverStartT = null;
      this.coverIntervals = 0;
      if (!this.calibrated) {
        // A warm reload can be under a window's worth of covered callbacks.
        // Assume the common rate and let the live raise correct it.
        this.assumed = true;
        this.calibrated = true;
        this.idleMs = ASSUMED_CADENCE_MS;
        this.recompute('auto');
      }
    }
    this.observeLive(t);
  }

  /**
   * Draw this callback? Called exactly once per tick, unconditionally, and
   * OR-ed with the holds — it advances the counter, so a second read or a
   * reorder would change the cadence.
   */
  due(t: number): boolean {
    // Before any arithmetic: the default draws every callback, exactly as a
    // build with no cap does.
    if (this.ticks === 1) return true;
    this.since++;
    if (this.since >= this.ticks) return true;
    // A stream that stopped delivering — a hidden tab, a stall — draws now
    // rather than waiting out a count that will not arrive. Measured against
    // the DELIVERED cadence, not the display's: they are the same number on a
    // real screen, but `?refresh=` pins a cadence faster than the callbacks
    // really come, and a threshold derived from the pretend one lands between
    // two real callbacks and fires on every draw.
    if (this.lastDrawT !== null && t - this.lastDrawT >= this.missedAfterMs) return true;
    return false;
  }

  /** A frame was drawn — due, or forced by a hold, a cover or a veil. Every
   *  draw resets the count, which is why a forced draw can never run a
   *  schedule ahead of the clock. */
  drew(t: number): void {
    this.since = 0;
    this.lastDrawT = t;
    this.rateDraws++;
    if (this.rateStartT === null) {
      this.rateStartT = t;
      this.rateDraws = 0;
      return;
    }
    const elapsed = t - this.rateStartT;
    if (elapsed >= 1000) {
      this.drawnRate = (this.rateDraws * 1000) / elapsed;
      this.rateStartT = t;
      this.rateDraws = 0;
    }
  }

  /** The document is being shown again: the windows that straddle the time it
   *  was not are not evidence about the display. */
  resume(): void {
    this.obsStartT = null;
    this.obsIntervals = 0;
    this.raiseStartT = null;
    this.raiseIntervals = 0;
    this.rateStartT = null;
    this.rateDraws = 0;
  }

  /** A change the rest of the app has to act on, taken once. */
  takeChange(): FrameCadenceChange | null {
    const change = this.change;
    this.change = null;
    return change;
  }

  get ticksPerDraw(): number {
    return this.ticks;
  }

  get budgetMs(): number {
    return this.budget;
  }

  /** True where a draw covers more than one callback, which is the only case
   *  the controller's quantised-interval gates apply in. */
  get quantised(): boolean {
    return this.ticks >= 2;
  }

  state(): FrameCadenceReadout {
    return {
      requested: this.screen ? 'screen' : Math.round(1000 / this.requestedMs),
      idleCadenceMs: this.idleMs,
      observedCadenceMs: this.observedMs,
      ticksPerDraw: this.ticks,
      periodMs: this.periodMs,
      budgetMs: this.budget,
      drawnRate: this.drawnRate,
      capped: this.cappedBy(),
      assumed: this.assumed,
      calibrated: this.calibrated,
      pinned: this.pinnedMs !== null,
    };
  }

  private observeCovered(t: number): void {
    if (this.coverStartT === null) {
      this.coverStartT = t;
      this.coverIntervals = 0;
      return;
    }
    this.coverIntervals++;
    if (this.coverIntervals < COVER_WINDOW) return;
    const ms = (t - this.coverStartT) / this.coverIntervals;
    this.coverStartT = t;
    this.coverIntervals = 0;
    // The covered window measured the DELIVERED stream as well as the
    // display, and the first live tick needs both: without a delivered
    // reading the missed-period rule would spend the first second on the
    // display's cadence, which under `?refresh=` is not the stream's.
    this.observedMs = ms;
    // The fastest window a long cover produced: a window can read slower than
    // the display (a stall inside it lengthens the span) but never faster.
    if (this.coverBestMs === null || ms < this.coverBestMs) this.coverBestMs = ms;
    if (this.pinnedMs !== null) {
      // The pin owns the display's cadence, but the delivered one it has just
      // learned still feeds the missed-period rule.
      this.recompute('auto');
      return;
    }
    if (this.idleMs === this.coverBestMs && this.calibrated) return;
    this.idleMs = this.coverBestMs;
    this.calibrated = true;
    this.assumed = false;
    this.recompute('auto');
  }

  private observeLive(t: number): void {
    if (this.obsStartT === null) {
      this.obsStartT = t;
      this.obsIntervals = 0;
    } else {
      this.obsIntervals++;
      if (this.obsIntervals >= OBSERVED_WINDOW) {
        const ms = (t - this.obsStartT) / this.obsIntervals;
        this.obsStartT = t;
        this.obsIntervals = 0;
        this.observedMs = ms;
        // Pacing only: a slower delivered stream lowers ticksPerDraw so the
        // requested rate is still met, and the budget does not move with it.
        this.recompute('auto');
      }
    }
    if (this.raiseStartT === null) {
      this.raiseStartT = t;
      this.raiseIntervals = 0;
      return;
    }
    this.raiseIntervals++;
    if (this.raiseIntervals < RAISE_WINDOW) return;
    const ms = (t - this.raiseStartT) / this.raiseIntervals;
    this.raiseStartT = t;
    this.raiseIntervals = 0;
    if (this.pinnedMs !== null) return;
    // Raise only. A window faster than the calibration is the display; a
    // slower one is load or a throttle, and is never taken.
    if (ms > this.idleMs * (1 - RAISE_MARGIN)) return;
    this.idleMs = ms;
    this.assumed = false;
    this.calibrated = true;
    this.recompute('auto');
  }

  private recompute(cause: 'user' | 'auto'): void {
    const before = { ticks: this.ticks, period: this.periodMs, budget: this.budget };
    // Pacing divides the DELIVERED cadence, so a throttled stream draws every
    // callback instead of halving the picture on top of the throttle. A
    // pinned cadence is the exception: `?refresh=` exists to make a 60 Hz
    // harness behave as a 120 Hz screen, and a delivered rate slower than the
    // pin is exactly what it is pretending away.
    const paceMs = this.pinnedMs !== null
      ? this.pinnedMs
      : Math.max(this.idleMs, this.observedMs ?? this.idleMs);
    // Uncalibrated is today's loop: one draw per callback, and a budget no
    // tighter than the request.
    if (this.screen || !this.calibrated) {
      this.ticks = 1;
    } else {
      this.ticks = holdTicks(this.ticksSettled ? before.ticks : 0, this.requestedMs / paceMs);
      this.ticksSettled = true;
    }
    // The period the budget is derived from is the DISPLAY's, never the
    // delivered rate: a throttle must not relax what a frame is measured
    // against.
    this.periodMs = this.ticks * this.idleMs;
    this.missedAfterMs = MISSED_PERIOD_FACTOR * this.ticks
      * Math.max(this.idleMs, this.observedMs ?? this.idleMs);
    this.budget = this.screen ? BUDGET_MS : Math.max(this.periodMs, this.requestedMs);
    const budgetChanged = Math.abs(this.budget - before.budget) > 1e-9;
    const paced = this.ticks !== before.ticks || Math.abs(this.periodMs - before.period) > 1e-9;
    // The first reading is always worth reporting, even where nothing it
    // derives moved: `?debug=1` on a 60 Hz phone at the default would
    // otherwise never say what the schedule decided.
    const first = this.calibrated && !this.everReported;
    if (!budgetChanged && !paced && !first && cause !== 'user') return;
    this.everReported = this.everReported || this.calibrated;
    this.change = { readout: this.state(), budgetChanged, cause };
  }

  private cappedBy(): FrameRateCap {
    if (this.screen) return 'no';
    const asked = this.requestedMs;
    if (this.ticks === 1) {
      // One draw per callback and the callbacks are slower than the request:
      // the display's own rate, or a stream the browser is not delivering.
      if (this.observedMs !== null && this.observedMs > this.idleMs * 1.1
        && this.observedMs > asked * 1.05) return 'by the browser';
      if (this.idleMs > asked * 1.05) return 'by the screen';
    }
    if (Math.abs(this.periodMs - asked) > asked * ROUNDED_BAND) return 'rounded';
    return 'no';
  }
}

/**
 * Callbacks per draw, from the ratio of the request to the delivered cadence.
 *
 * Rounded rather than floored: 60 on a 144 Hz monitor is 72 (every second
 * refresh), because 60 there would alternate two- and three-refresh frames,
 * and an uneven 60 is what people turn half-rate vsync on to avoid. The
 * epsilon is not slack — a 60 request on a 90 Hz screen is EXACTLY 1.5, and
 * without it float noise in the delivered reading would flip that display
 * between every callback and every second one from window to window.
 */
function roundTicks(ratio: number): number {
  if (!Number.isFinite(ratio)) return 1;
  return Math.max(1, Math.floor(ratio + 0.5 + 1e-6));
}

/**
 * The same, with hysteresis: the current divisor is kept while the ratio is
 * still within `TICKS_HOLD_BAND` of it.
 *
 * Without it, a request that lands exactly between two divisors would flip
 * window to window on ordinary jitter — a 60 request on a 90 Hz screen is
 * exactly 1.5, and the delivered reading is a hair slow as often as not, so
 * the display would alternate between 45 and 90 fps every two seconds. A real
 * slowdown moves the ratio by a whole step or more and still crosses this.
 */
function holdTicks(current: number, ratio: number): number {
  if (!Number.isFinite(ratio)) return current;
  if (current >= 1 && Math.abs(ratio - current) <= TICKS_HOLD_BAND) return current;
  return roundTicks(ratio);
}

/** A tenth of a step past the rounding boundary, either side. */
const TICKS_HOLD_BAND = 0.6;

/** How far the delivered period may sit from the request before the debug
 *  line calls it rounded: a 144 Hz screen at a 30 target delivers 29. */
const ROUNDED_BAND = 0.02;
