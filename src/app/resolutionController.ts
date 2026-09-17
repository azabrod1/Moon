/**
 * The Dynamic quality decision rule: when the scene's pixel ratio should step
 * down a rung, when it may probe up one, and when a step it made has to be
 * handed back.
 *
 * Pure and DOM-free. It is stepped once per frame with one sample and returns
 * either nothing or a rung to apply; time arrives in the sample, never from a
 * clock of its own, which is what lets a whole minute of a heating phone be
 * played through it in a unit test.
 *
 * **A sample describes the interval that ENDS at its `nowMs`** — that is, the
 * work of the PREVIOUS frame. An interval is `now_N − now_{N−1}`, so it is
 * evidence about frame N−1, and every field has to be that frame's: its busy
 * time, its frame-sliced work, and whether both endpoints were eligible.
 * Attributing the interval to the frame that reported it would charge a tile
 * upload's cost to the clean frame after it — and near Earth, where sliced
 * work lands on alternating frames, the statistic would then be the mean of
 * exactly the long intervals the exclusion was written to remove.
 *
 * **Budget: 60 fps, on every display.** Under vsync a frame is delivered on a
 * refresh tick, so a frame's cost never appears in the intervals: on a 120 Hz
 * panel a 12 ms frame is delivered at 16.67 ms. Holding the panel's own rate
 * would make every such frame a miss and pin a 120 Hz machine at medium with
 * a 120 → 60 cliff on each probe. Holding 60 means: as sharp as 60 fps
 * allows, evenly paced — a two-tick frame on a 120 Hz panel is even — and a
 * fast panel still runs at its own rate whenever the frame is cheap. There is
 * no refresh-rate estimator in the DOWN path at all, and so no boot pollution
 * and no panel list.
 *
 * **Counted intervals.** An interval votes when both its endpoints were
 * eligible (visible, focused, uncovered), no frame-sliced work was done in
 * the frame that produced it, and either it came in on time or the app's own
 * main-thread tick is small enough that the app cannot explain the overrun.
 * The main-thread test is deliberately against the BUDGET and only on
 * over-budget intervals: as a fraction of the interval it would get stricter
 * the faster the panel is, and on a 120 Hz machine a perfectly healthy 6 ms
 * tick would exclude every frame and the rule would never fire at all. An
 * on-time frame always counts.
 *
 * **Windows are counted in intervals, not in seconds** — 180 for a down
 * decision, 480 for an up probe, with a staleness cap so a window can never
 * be assembled out of evidence from a minute ago. A streaming descent over
 * Earth does sliced work on many frames in a row; with a share-of-frames gate
 * the controller would go silent in both directions during exactly the long
 * hot flight the phone requirement is about, where with counted windows the
 * evidence merely accumulates more slowly.
 *
 * **The statistic** is the mean of the window's counted intervals with the
 * three longest dropped — a fixed count, because a percentage trim is biased
 * by the window length and would drift the thresholds with the frame rate. A
 * 600 ms stall is ONE late callback, so one or two hitches fall out of the
 * statistic by construction rather than by a rule. At 60 Hz vsync, with a
 * fraction p of frames a tick late, the derived boundaries are: DOWN when the
 * trimmed mean passes 19.2 ms, which is p > 0.166, about 51 fps; UP-eligible
 * at or under 17.0 ms, which is p ≤ 0.026, about 58.5 fps. Steady 55 fps sits
 * between them and moves nothing, which is the tolerance band.
 *
 * **A step is verified, and the floor is justified.** After any rung change
 * comes a short reallocation settle in which nothing is counted; after an
 * UP-step the second after that is a verification window of counted
 * intervals, and an over-budget reading there reverts the probe at once,
 * doubles the probe wait and latches that rung as a ceiling for a minute. A
 * DOWN-step is not verified per step: under vsync quantisation a phone whose
 * frame cost goes 24 ms → 20 ms still delivers two ticks, so a per-step
 * improvement bar would revert correct steps, and a thermally sliding device
 * is worse after a step that helped. The slide is bounded (two rungs, 44 % of
 * the pixels), so the check is made ONCE, at the floor: if the floor's
 * trimmed mean is not at least FLOOR_LATCH_MIN_GAIN lower than the mean that
 * triggered the first step down from medium, the device is not pixel-bound —
 * it is main-thread-bound, or capped from outside the app, which is what iOS
 * does under thermal pressure — so medium is handed back and the latch stops
 * the controller taking the picture again. 44 % fewer pixels that changed
 * nothing is unambiguous evidence, and neither quantisation nor drift can
 * fake it. The latch escalates rather than expiring on a fixed timer, because
 * a device with a hard external frame cap would otherwise change its picture
 * twice a minute for the life of the session.
 *
 * **Focus, and why there is no jump back on a resume.** An interval whose
 * endpoints were not both visible, focused and uncovered does not count, and
 * a focus or visibility gain drops the window rather than reading across it —
 * the frames around a blur are the browser's throttle, not the app's cost.
 * With that gate in place no slide can happen while nobody is looking,
 * because no evidence accumulates, so there is no rung to restore on the way
 * back; and jumping to the rung that held before an app switch would change
 * the picture twice on every switch, on exactly the hot phone the slide came
 * from. The caller seeds focus true and tracks it with focus/blur listeners
 * rather than polling, because a page reached from a link that was never
 * clicked reports no focus while animating perfectly well, and polling it
 * would exclude every frame of the session with no symptom but a controller
 * that never moves.
 *
 * **UP_RULE** is the one open question in the rule, and both answers are
 * built. 'sixty' probes up whenever the window is within the 60 fps budget,
 * so a 120 Hz machine climbs to its sharpest rung and runs at 60. 'panel'
 * probes up only while the window is within the panel's own period —
 * estimated as a low percentile of counted intervals, which is a measurement
 * that cannot be fooled by load, only made pessimistic — and reverts a probe
 * that costs the refresh rate, so a 120 Hz machine keeps 120 and the sharper
 * picture stays behind the High level. Down decisions use the 60 fps budget
 * either way. The panel estimate is clamped to the budget: it can only make
 * the up test stricter, never looser, or a device capped at 30 fps would read
 * its cap as its refresh and probe up into it.
 */

/** The budget every display is held to: 60 fps. A delivered 60 Hz interval
 *  reads at or a hair above this, which is why the main-thread test is what
 *  admits a jittery on-time frame. */
export const BUDGET_MS = 1000 / 60;

/** Counted intervals in a down decision's window. At 60 fps that is 3 s; on a
 *  phone at 30 fps, 6 s. */
export const DOWN_WINDOW_COUNTED = 180;

/** Counted intervals in an up probe's window: more evidence is asked for
 *  before taking pixels than before giving them back. */
export const UP_WINDOW_COUNTED = 480;

/** No window is assembled out of intervals older than this, however few have
 *  been counted since. */
export const STALENESS_MS = 15_000;

/** Intervals dropped from a window before the mean: the longest three, so two
 *  or three hitches in a window cannot move a decision. */
export const TRIM_COUNT = 3;

/** Dropped from the one-second verification window, which is a fifth the
 *  length of a decision window. */
export const VERIFY_TRIM_COUNT = 1;

/** Counted intervals a verification window needs before it may judge a probe.
 *  Fewer than this and the probe is left standing, with its wait unreset. */
export const VERIFY_MIN_COUNTED = 8;

/** The trimmed mean has to pass this multiple of the budget to step down. */
export const DOWN_FACTOR = 1.15;

/** And stay within this multiple to probe up. */
export const UP_FACTOR = 1.02;

/** An over-budget interval is excluded when the app's own main-thread tick is
 *  above this share of the BUDGET: the app could then explain the overrun by
 *  itself, and fewer pixels would not fix it. */
export const MAIN_THREAD_SHARE = 0.6;

/** Nothing is counted for this long after a rung change: the targets are
 *  reallocated in it. */
export const REALLOC_SETTLE_MS = 250;

/** How long an up-step is watched before it is trusted. */
export const VERIFY_MS = 1000;

/** The least time between changes for a down decision. */
export const DOWN_SPACING_MS = 2000;

/** The wait before a first up probe, doubling on each probe that fails and
 *  reset by one that holds. */
export const PROBE_WAIT_MS = 8000;

/** Where the doubling stops. */
export const PROBE_WAIT_MAX_MS = 64_000;

/** How long a failed probe's rung is held as a ceiling. */
export const CEILING_HOLD_MS = 60_000;

/** The improvement the floor rung must show over the mean that started the
 *  slide, or the device is not pixel-bound and gets medium back. 3 % against
 *  a 44 % cut in pixels. */
export const FLOOR_LATCH_MIN_GAIN = 0.03;

/** How long the not-pixel-bound latch holds, per failure: a minute, four
 *  minutes, then the rest of the session. */
export const LATCH_HOLD_MS: readonly number[] = [60_000, 240_000, Infinity];

/** Counted intervals the panel-period estimate needs before it is believed. */
export const PANEL_MIN_COUNTED = 60;

/** The percentile of counted intervals taken as the panel's period: a display
 *  cannot deliver faster than its refresh, so the short tail is the panel and
 *  everything above it is load. */
export const PANEL_PERCENTILE = 0.05;

/** A counted rate of zero for this long is a defect, not a quiet scene — an
 *  unfocused window, or a cover that never lifted. The caller logs it once so
 *  a phone can say so through `?debug=1`. */
export const ZERO_COUNTED_WARN_MS = 30_000;

/** Which answer the up path uses. See the header. */
export type UpRule = 'sixty' | 'panel';

/** One frame's evidence: the interval that ENDS at `nowMs`, and the previous
 *  frame's own figures, which are what produced it. */
export interface IntervalSample {
  /** The wall clock at the end of the interval — the same `performance.now()`
   *  the animation loop already took, never the rAF timestamp, which goes
   *  stale after a busy main thread. */
  nowMs: number;
  /** `nowMs` less the previous frame's. */
  intervalMs: number;
  /** The previous frame's busy time: loop start to the end of its draw. */
  mainThreadMs: number;
  /** Frame-sliced work DONE in the previous frame — uploads, bake slices,
   *  compiles. Fetches in flight are not work done and must not be reported
   *  here, or a streaming flight would silence the controller. */
  workedMs: number;
  /** Both endpoints eligible: visible and focused, and not covered by the
   *  boot cover or an arrival veil. */
  eligible: boolean;
}

/** Why a rung is being changed. */
export type StepReason = 'down' | 'up' | 'revert' | 'floor latch' | 'ladder';

/** A rung to apply. The caller applies it and calls onApplied; until it does,
 *  no further decision is made. */
export interface Decision {
  /** The rung index in the ladder. */
  to: number;
  reason: StepReason;
}

/** What made the controller change its mind, or step out of the way. */
export type ControllerEvent = 'resize' | 'arrival' | 'focus' | 'boot' | 'pin' | 'unpin';

export interface ResolutionControllerOptions {
  upRule?: UpRule;
}

/** The ladder Dynamic slides over (renderQuality.ts dynamicLadder). */
export interface RungLadder {
  /** Scene ratios, ascending. */
  rungs: readonly number[];
  /** Which of them is medium. */
  mediumIndex: number;
}

/** Everything `__moon.quality()` shows of the decision rule's own state. */
export interface ControllerState {
  /** The rung index the controller believes is applied. */
  rung: number;
  /** And its scene ratio. */
  sceneRatio: number;
  /** True while a pin holds the controller out of the way. */
  idle: boolean;
  /** The down window's trimmed mean, or null while there is too little to
   *  trim. */
  trimmedMeanMs: number | null;
  /** Counted intervals in reach right now: held, and not yet stale. */
  countedWindow: number;
  /** The share of recent intervals that counted. Zero for a long stretch is
   *  the tell that a gate is stuck, not that the scene is quiet. */
  countedRate: number;
  /** How long since an interval last counted. */
  silentMs: number;
  /** The current wait before an up probe. */
  probeWaitMs: number;
  /** The rung a failed probe latched, and until when. */
  ceiling: { rung: number; untilMs: number } | null;
  /** The not-pixel-bound latch: while it stands there are no down-steps.
   *  `escalation` counts the failures — 1 a minute, 2 four minutes, 3 the
   *  session. */
  latch: { untilMs: number; escalation: number } | null;
  /** The last change the controller asked for. */
  lastStep: { atMs: number; from: number; to: number; reason: StepReason } | null;
  /** The mean that triggered the first step down from medium: what the floor
   *  has to beat. */
  floorReference: number | null;
  /** The panel period the 'panel' up rule would use, where enough intervals
   *  have been counted to estimate one. */
  panelPeriodMs: number | null;
  upRule: UpRule;
}

/**
 * A fixed-length ring of counted intervals, with its statistics read off it
 * in place. Allocation-free after construction: this is stepped on the render
 * path.
 */
class IntervalRing {
  private readonly atMs: Float64Array;
  private readonly ms: Float64Array;
  private readonly top = new Float64Array(TRIM_COUNT);
  private readonly scratch: Float64Array;
  private head = 0;
  private count = 0;

  constructor(private readonly capacity: number) {
    this.atMs = new Float64Array(capacity);
    this.ms = new Float64Array(capacity);
    this.scratch = new Float64Array(capacity);
  }

  push(atMs: number, ms: number): void {
    this.atMs[this.head] = atMs;
    this.ms[this.head] = ms;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
  }

  /** Mean of the newest `maxSize` intervals no older than `notBeforeMs`, with
   *  the longest `trim` of them dropped. `count` is how many were in reach,
   *  so the caller can ask for a full window. */
  trimmedMean(maxSize: number, trim: number, notBeforeMs: number): { meanMs: number; count: number } | null {
    const drop = Math.min(trim, this.top.length);
    for (let i = 0; i < drop; i++) this.top[i] = -Infinity;
    let count = 0;
    let sum = 0;
    for (let i = 0; i < this.count && count < maxSize; i++) {
      const at = (this.head - 1 - i + this.capacity) % this.capacity;
      if (this.atMs[at] < notBeforeMs) break;
      const value = this.ms[at];
      count++;
      sum += value;
      for (let j = 0; j < drop; j++) {
        if (value > this.top[j]) {
          for (let k = drop - 1; k > j; k--) this.top[k] = this.top[k - 1];
          this.top[j] = value;
          break;
        }
      }
    }
    const dropped = Math.min(drop, count);
    if (count - dropped <= 0) return null;
    let sumTop = 0;
    for (let j = 0; j < dropped; j++) sumTop += this.top[j];
    return { meanMs: (sum - sumTop) / (count - dropped), count };
  }

  /** How many of the newest `maxSize` intervals are no older than
   *  `notBeforeMs`: what a window can actually be assembled from. */
  fresh(maxSize: number, notBeforeMs: number): number {
    let count = 0;
    for (let i = 0; i < this.count && count < maxSize; i++) {
      const at = (this.head - 1 - i + this.capacity) % this.capacity;
      if (this.atMs[at] < notBeforeMs) break;
      count++;
    }
    return count;
  }

  /** The `q` percentile of the newest `maxSize` intervals no older than
   *  `notBeforeMs`, or null when fewer than `min` are in reach. */
  percentile(maxSize: number, q: number, notBeforeMs: number, min: number): number | null {
    let count = 0;
    for (let i = 0; i < this.count && count < maxSize; i++) {
      const at = (this.head - 1 - i + this.capacity) % this.capacity;
      if (this.atMs[at] < notBeforeMs) break;
      this.scratch[count++] = this.ms[at];
    }
    if (count < min) return null;
    const sorted = this.scratch.subarray(0, count);
    sorted.sort();
    const index = Math.min(count - 1, Math.max(0, Math.floor(q * (count - 1))));
    return sorted[index];
  }
}

/** How many recent intervals the counted rate is read over. */
const RATE_WINDOW = 240;

export class ResolutionController {
  private rungs: readonly number[];
  private mediumIndex: number;
  private index: number;
  private readonly upRule: UpRule;

  /** Counted intervals for the decisions. Cleared on every rung change: the
   *  evidence describes the configuration it was measured in. */
  private readonly window = new IntervalRing(UP_WINDOW_COUNTED);
  /** Counted intervals for the panel-period estimate, which a rung change
   *  does NOT invalidate — the display's refresh is not a property of the
   *  rung, and the estimate has to remember the fast intervals a probe just
   *  spent. A resize or a boot clears it, because a monitor move can change
   *  the refresh rate. */
  private readonly panel = new IntervalRing(UP_WINDOW_COUNTED);

  private readonly rate = new Uint8Array(RATE_WINDOW);
  private rateHead = 0;
  private rateCount = 0;
  private rateCounted = 0;

  private clockMs = 0;
  private startedMs: number | null = null;
  private lastCountedMs: number | null = null;

  private settleUntilMs = 0;
  private lastChangeMs = 0;
  private verifyUntilMs: number | null = null;
  private verifyFromIndex = 0;
  private probeWait = PROBE_WAIT_MS;
  private ceiling: { rung: number; untilMs: number } | null = null;
  private latch: { untilMs: number; escalation: number } | null = null;
  private latchFailures = 0;
  private floorReference: number | null = null;
  private lastStep: { atMs: number; from: number; to: number; reason: StepReason } | null = null;

  private pending: Decision | null = null;
  private idle = false;

  constructor(ladder: RungLadder, opts: ResolutionControllerOptions = {}) {
    this.rungs = ladder.rungs.length > 0 ? ladder.rungs : [1];
    this.mediumIndex = clampIndex(ladder.mediumIndex, this.rungs.length);
    this.index = this.mediumIndex;
    this.upRule = opts.upRule ?? 'sixty';
  }

  /** The rung the controller believes is applied. The per-frame read: state()
   *  assembles the whole diagnostic picture and is for the debug line. */
  get rung(): number {
    return this.index;
  }

  /** And its scene ratio. */
  get sceneRatio(): number {
    return this.rungs[this.index];
  }

  /**
   * One frame. Returns a rung to apply, or null. A returned decision stands
   * until `onApplied` reports it applied; no second decision is made in the
   * meantime.
   */
  step(sample: IntervalSample): Decision | null {
    this.clockMs = sample.nowMs;
    if (this.startedMs === null) this.startedMs = sample.nowMs;
    const settled = sample.nowMs >= this.settleUntilMs;
    const counted =
      !this.idle &&
      sample.eligible &&
      settled &&
      sample.workedMs === 0 &&
      (sample.intervalMs <= BUDGET_MS || sample.mainThreadMs <= MAIN_THREAD_SHARE * BUDGET_MS);
    this.recordRate(counted);
    if (counted) {
      this.window.push(sample.nowMs, sample.intervalMs);
      this.panel.push(sample.nowMs, sample.intervalMs);
      this.lastCountedMs = sample.nowMs;
    }
    if (this.idle || this.pending !== null) return null;
    if (this.ceiling !== null && sample.nowMs >= this.ceiling.untilMs) this.ceiling = null;
    if (this.latch !== null && sample.nowMs >= this.latch.untilMs) this.latch = null;
    if (!settled) return null;
    if (this.verifyUntilMs !== null) {
      if (sample.nowMs < this.verifyUntilMs) return null;
      return this.finishVerification(sample.nowMs);
    }
    if (this.index === 0) {
      const latched = this.floorDecision(sample.nowMs);
      if (latched !== null) return latched;
    }
    return this.downDecision(sample.nowMs) ?? this.upDecision(sample.nowMs);
  }

  /**
   * The caller applied the pending decision (or moved the rung itself, in
   * which case `kind` says what it was). `kind: 'up'` opens the verification
   * window; `'down'` starts the down spacing; `'restore'` neither.
   */
  onApplied(nowMs: number, kind: 'up' | 'down' | 'restore'): void {
    const from = this.index;
    const pending = this.pending;
    this.pending = null;
    if (pending !== null) this.index = clampIndex(pending.to, this.rungs.length);
    this.clockMs = nowMs;
    this.lastChangeMs = nowMs;
    this.settleUntilMs = nowMs + REALLOC_SETTLE_MS;
    this.window.clear();
    this.lastStep = { atMs: nowMs, from, to: this.index, reason: pending?.reason ?? 'ladder' };
    if (kind === 'up') {
      this.verifyUntilMs = this.settleUntilMs + VERIFY_MS;
      this.verifyFromIndex = from;
    } else {
      this.verifyUntilMs = null;
    }
  }

  /**
   * Something happened that the windows must not be read across. A pin holds
   * the controller idle until it is lifted; every other event clears the
   * evidence and settles. `nowMs` defaults to the last frame's clock, which
   * is where an event between frames sits anyway.
   */
  notify(event: ControllerEvent, nowMs: number = this.clockMs): void {
    this.clockMs = nowMs;
    this.window.clear();
    this.pending = null;
    this.verifyUntilMs = null;
    switch (event) {
      case 'pin':
        this.idle = true;
        return;
      case 'unpin':
        this.idle = false;
        this.settleUntilMs = nowMs + REALLOC_SETTLE_MS;
        this.lastChangeMs = nowMs;
        return;
      case 'boot':
        this.panel.clear();
        this.settleUntilMs = nowMs + REALLOC_SETTLE_MS;
        this.lastChangeMs = nowMs;
        this.startedMs = nowMs;
        this.lastCountedMs = null;
        return;
      case 'resize':
        this.panel.clear();
        this.settleUntilMs = nowMs + REALLOC_SETTLE_MS;
        return;
      case 'arrival':
      case 'focus':
        // Neither ever steps by itself: the frames under a veil and the
        // frames around a blur say nothing about what the scene costs, and
        // with the eligibility gate the rung cannot have moved while nobody
        // was looking.
        this.settleUntilMs = nowMs + REALLOC_SETTLE_MS;
        return;
    }
  }

  /**
   * The bounds were recomputed — an output-ratio change, a resize, a level
   * change — so the ladder is new. The current rung is re-clamped to the
   * nearest scene ratio the new ladder offers and returned for the caller to
   * apply; null means the scene ratio did not move. The evidence and the
   * measurements taken against the old ladder are dropped; the
   * not-pixel-bound latch is not, because that is a fact about the device.
   */
  setLadder(ladder: RungLadder, nowMs: number = this.clockMs): Decision | null {
    const from = this.index;
    const previousRatio = this.rungs[this.index];
    this.rungs = ladder.rungs.length > 0 ? ladder.rungs : [1];
    this.mediumIndex = clampIndex(ladder.mediumIndex, this.rungs.length);
    let nearest = 0;
    for (let i = 1; i < this.rungs.length; i++) {
      if (Math.abs(this.rungs[i] - previousRatio) < Math.abs(this.rungs[nearest] - previousRatio)) nearest = i;
    }
    this.index = nearest;
    this.window.clear();
    this.pending = null;
    this.verifyUntilMs = null;
    this.ceiling = null;
    this.floorReference = null;
    this.clockMs = nowMs;
    this.settleUntilMs = nowMs + REALLOC_SETTLE_MS;
    this.lastChangeMs = nowMs;
    if (Math.abs(this.rungs[this.index] - previousRatio) < 1e-9) return null;
    this.lastStep = { atMs: nowMs, from, to: this.index, reason: 'ladder' };
    return { to: this.index, reason: 'ladder' };
  }

  /** The window fields `__moon.quality()` reports. */
  state(): ControllerState {
    const stat = this.window.trimmedMean(DOWN_WINDOW_COUNTED, TRIM_COUNT, this.clockMs - STALENESS_MS);
    const since = this.lastCountedMs ?? this.startedMs ?? this.clockMs;
    return {
      rung: this.index,
      sceneRatio: this.rungs[this.index],
      idle: this.idle,
      trimmedMeanMs: stat?.meanMs ?? null,
      countedWindow: this.window.fresh(UP_WINDOW_COUNTED, this.clockMs - STALENESS_MS),
      countedRate: this.rateCount === 0 ? 0 : this.rateCounted / this.rateCount,
      silentMs: Math.max(0, this.clockMs - since),
      probeWaitMs: this.probeWait,
      ceiling: this.ceiling === null ? null : { ...this.ceiling },
      latch: this.latch === null ? null : { ...this.latch },
      lastStep: this.lastStep === null ? null : { ...this.lastStep },
      floorReference: this.floorReference,
      panelPeriodMs: this.panelPeriodMs(),
      upRule: this.upRule,
    };
  }

  private recordRate(counted: boolean): void {
    if (this.rateCount === RATE_WINDOW) {
      this.rateCounted -= this.rate[this.rateHead];
    } else {
      this.rateCount++;
    }
    this.rate[this.rateHead] = counted ? 1 : 0;
    if (counted) this.rateCounted++;
    this.rateHead = (this.rateHead + 1) % RATE_WINDOW;
  }

  private emit(to: number, reason: StepReason): Decision {
    this.pending = { to: clampIndex(to, this.rungs.length), reason };
    return this.pending;
  }

  private panelPeriodMs(): number | null {
    return this.panel.percentile(UP_WINDOW_COUNTED, PANEL_PERCENTILE, this.clockMs - STALENESS_MS, PANEL_MIN_COUNTED);
  }

  /** The bar a window has to clear to probe up. */
  private upThresholdMs(): number {
    if (this.upRule === 'sixty') return UP_FACTOR * BUDGET_MS;
    const panel = this.panelPeriodMs();
    return UP_FACTOR * Math.min(BUDGET_MS, panel ?? BUDGET_MS);
  }

  /** The reading that undoes a probe. Under 'sixty' a probe is undone only by
   *  a genuinely over-budget second; under 'panel' it is undone by a second
   *  that cost the panel's own rate, which is what keeps a 120 Hz machine at
   *  120. */
  private verifyThresholdMs(): number {
    return this.upRule === 'panel' ? this.upThresholdMs() : DOWN_FACTOR * BUDGET_MS;
  }

  private finishVerification(nowMs: number): Decision | null {
    this.verifyUntilMs = null;
    const stat = this.window.trimmedMean(UP_WINDOW_COUNTED, VERIFY_TRIM_COUNT, nowMs - STALENESS_MS);
    if (stat === null || stat.count < VERIFY_MIN_COUNTED) return null;
    if (stat.meanMs > this.verifyThresholdMs()) {
      this.probeWait = Math.min(PROBE_WAIT_MAX_MS, this.probeWait * 2);
      this.ceiling = { rung: this.index, untilMs: nowMs + CEILING_HOLD_MS };
      return this.emit(this.verifyFromIndex, 'revert');
    }
    this.probeWait = PROBE_WAIT_MS;
    return null;
  }

  private downDecision(nowMs: number): Decision | null {
    if (this.index <= 0 || this.latch !== null) return null;
    if (nowMs - this.lastChangeMs < DOWN_SPACING_MS) return null;
    const stat = this.window.trimmedMean(DOWN_WINDOW_COUNTED, TRIM_COUNT, nowMs - STALENESS_MS);
    if (stat === null || stat.count < DOWN_WINDOW_COUNTED) return null;
    // A full window inside the budget: this rung holds.
    if (stat.meanMs <= DOWN_FACTOR * BUDGET_MS) return null;
    // The mean at medium is what the floor will have to beat. Only a slide
    // that starts at medium can be judged that way; one that starts lower
    // (after a ladder change) leaves the reference unset and the floor check
    // silent.
    if (this.index === this.mediumIndex) this.floorReference = stat.meanMs;
    return this.emit(this.index - 1, 'down');
  }

  /** At the floor: did the pixels the slide gave up buy anything? */
  private floorDecision(nowMs: number): Decision | null {
    if (this.latch !== null || this.floorReference === null || this.index === this.mediumIndex) return null;
    const stat = this.window.trimmedMean(DOWN_WINDOW_COUNTED, TRIM_COUNT, nowMs - STALENESS_MS);
    if (stat === null || stat.count < DOWN_WINDOW_COUNTED) return null;
    const reference = this.floorReference;
    // Answered either way: a fresh slide from medium sets a fresh reference.
    this.floorReference = null;
    if (stat.meanMs <= reference * (1 - FLOOR_LATCH_MIN_GAIN)) return null;
    const hold = LATCH_HOLD_MS[Math.min(this.latchFailures, LATCH_HOLD_MS.length - 1)];
    this.latchFailures++;
    this.latch = { untilMs: nowMs + hold, escalation: this.latchFailures };
    return this.emit(this.mediumIndex, 'floor latch');
  }

  private upDecision(nowMs: number): Decision | null {
    const next = this.index + 1;
    if (next >= this.rungs.length) return null;
    if (this.ceiling !== null && next >= this.ceiling.rung) return null;
    if (nowMs - this.lastChangeMs < this.probeWait) return null;
    const stat = this.window.trimmedMean(UP_WINDOW_COUNTED, TRIM_COUNT, nowMs - STALENESS_MS);
    if (stat === null || stat.count < UP_WINDOW_COUNTED) return null;
    if (stat.meanMs > this.upThresholdMs()) return null;
    return this.emit(next, 'up');
  }
}

function clampIndex(index: number, length: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.min(length - 1, Math.max(0, Math.floor(index)));
}
