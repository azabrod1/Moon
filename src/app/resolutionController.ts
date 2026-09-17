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
 * **Budget: 60 fps unless the Frame rate row says otherwise.** Under vsync a
 * frame is delivered on a refresh tick, so a frame's cost never appears in the
 * intervals: on a 120 Hz panel a 12 ms frame is delivered at 16.67 ms. Holding
 * the panel's own rate would make every such frame a miss and pin a 120 Hz
 * machine at medium with a 120 → 60 cliff on each probe. Holding 60 means: as
 * sharp as 60 fps allows, evenly paced — a two-tick frame on a 120 Hz panel is
 * even — and a fast panel still runs at its own rate whenever the frame is
 * cheap. There is no refresh-rate estimator in the DOWN path at all, and so no
 * boot pollution and no panel list.
 *
 * `BUDGET_MS` is that default and `setBudget` is the one door that moves it:
 * the Frame rate row's target is a rate the app then has to DEFEND with
 * pixels, so the budget follows it (app/frameCadence.ts derives the number).
 * At the row's default, "Screen", nothing calls `setBudget` at all and every
 * path below is the one a build with no row takes.
 *
 * **Counted intervals.** An interval votes when both its endpoints were
 * eligible (visible, focused, uncovered), no frame-sliced work was done in
 * the frame that produced it, and either it came in on time or the app's own
 * main-thread tick is small enough that the app cannot explain the overrun.
 * The main-thread test is a FIXED ten milliseconds at every target and every
 * refresh, and only on over-budget intervals. As a share of the budget or of
 * the refresh it would get stricter the faster the panel or the higher the
 * target, and on a 120 Hz machine a perfectly healthy 6 ms tick would exclude
 * every frame and the rule would never fire at all. The question it asks is
 * "can the app explain this overrun by itself", and a tick that overran its
 * own slot is what delays the next callback. An on-time frame always counts.
 * Where a draw covers several ticks the figure is the LONGEST tick in the
 * span, not their sum: the cheap update-only ticks between draws would
 * otherwise hide the one that slipped.
 *
 * **Windows are authored in SECONDS and counted in intervals** — six seconds
 * for a down decision, ten for an up probe, converted at the budget (360 and
 * 600 at 60 fps, 180 and 300 at 30) with a staleness cap so a window can never
 * be assembled out of evidence from half a minute ago. At the longest window
 * and the lowest counted rate the span is 18.2 s against the 20 s horizon,
 * which is the margin the shorter windows had at 15 s. A streaming descent
 * over Earth does sliced work on many frames in a row; with a share-of-frames
 * gate the controller would go silent in both directions during exactly the
 * long hot flight the phone requirement is about, where with counted windows
 * the evidence merely accumulates more slowly.
 *
 * **A rung change drops the window outright**, because the evidence describes
 * the configuration it was measured in. So a second down-step needs its own
 * six seconds rather than firing two seconds later on the first step's
 * evidence, and medium to the floor is at least twelve seconds of sustained
 * trouble. `DOWN_SPACING_MS` is only the minimum between changes; at these
 * window lengths the evidence is what binds.
 *
 * **The statistic** is the mean of the window's counted intervals with the
 * three longest dropped — a fixed count, because a percentage trim is biased
 * by the window length and would drift the thresholds with the frame rate. A
 * 600 ms stall is ONE late callback, so one or two hitches fall out of the
 * statistic by construction rather than by a rule. At 60 Hz vsync, with a
 * fraction p of frames a tick late, the derived boundaries are: DOWN when the
 * trimmed mean passes 19.2 ms, which is p > 0.157, about 52 fps; UP-eligible
 * at or under 17.0 ms, which is p ≤ 0.025, about 58.5 fps. Steady 55 fps sits
 * between them and moves nothing, which is the tolerance band. A longer window
 * moves those shares a little — the trim is a fixed three, so it is a smaller
 * share of a longer window — which is why the suite derives them from the rule
 * rather than transcribing them.
 *
 * **Up under a cap is a search, not a measurement.** Where a draw covers two
 * or more callbacks, every frame that fits the period reports exactly the
 * period, so a rung up that still fits shows no change at all and the
 * controller would climb until a frame misses. Two things bound that search.
 * The first is headroom, and it is inert unless the caller says the intervals
 * are quantised, so the up path at the row's default is untouched: the
 * main-thread milliseconds SUMMED over each interval — an up probe is a search
 * under quantisation, and the CPU's share of the whole interval is what says
 * the frame has room. The bar is half the budget, and it is priced against a
 * real phone's busy profile before an explicit target ships as a phone
 * default. The second is the ceiling's escalation below, which applies at
 * every budget: a probe can fail at most four times at a rung in a session.
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
 * A failed probe's ceiling ESCALATES with each consecutive failure at the same
 * rung — a minute, four minutes, sixteen, then the rest of the session, the
 * floor latch's own ladder — rather than locking the rung for the session on
 * the second failure. A probe is the only way back up, and each one costs two
 * visible changes, so the escalation bounds the worst case at eight changes
 * spread over about twenty minutes and then silence; but a device whose frames
 * missed at the shell may fit them in deep space a few minutes later, and a
 * session lock would have kept a phone that cooled there soft for the rest of
 * its run. The count resets when a probe at that rung holds, and the ceiling
 * is cleared by a budget change or a new ladder (a resize, a level change) and
 * by nothing else — an arrival fires on every teleport, and a ceiling cleared
 * several times a journey would bound nothing.
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
 * **Which rate a fast display runs at is the Frame rate row's question, not
 * this file's.** The up path probes whenever the window is inside the budget,
 * so a 120 Hz machine at the default climbs to its sharpest rung and runs at
 * 60; a user who wants 120 asks for it in the menu, and the budget follows
 * them. An earlier draft estimated the panel's own period here from a low
 * percentile of counted intervals and made the up test stricter with it; the
 * row answers the same question out loud, so the estimator is gone.
 */

/** The budget every display is held to unless the Frame rate row moves it:
 *  60 fps. A delivered 60 Hz interval reads at or a hair above this, which is
 *  why the main-thread test is what admits a jittery on-time frame. */
export const BUDGET_MS = 1000 / 60;

/** Wall seconds of counted evidence behind a down decision. Long enough that
 *  a passing hot patch — a descent, a burst of uploads — is over before the
 *  window is full, because the picture changing is more noticeable than the
 *  two seconds of slow frames it saves. */
export const DOWN_WINDOW_S = 6;

/** And behind an up probe: more evidence is asked for before taking pixels
 *  than before giving them back. */
export const UP_WINDOW_S = 10;

/** Counted intervals in a window of `seconds` at `budgetMs`. */
export function windowCounted(seconds: number, budgetMs: number): number {
  return Math.max(1, Math.round((seconds * 1000) / budgetMs));
}

/** Counted intervals in a down decision's window at the default budget. */
export const DOWN_WINDOW_COUNTED = windowCounted(DOWN_WINDOW_S, BUDGET_MS);

/** And in an up probe's. */
export const UP_WINDOW_COUNTED = windowCounted(UP_WINDOW_S, BUDGET_MS);

/** No window is assembled out of intervals older than this, however few have
 *  been counted since. It has to clear the longest window at the lowest
 *  counted rate the app sees: ten seconds of counted evidence at a 55 % rate
 *  spans 18.2 s, so 20 s leaves 1.8 s of margin and 15 s would have made the
 *  up path unable to assemble a window at all. */
export const STALENESS_MS = 20_000;

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
 *  above this share of the DEFAULT budget: the app could then explain the
 *  overrun by itself, and fewer pixels would not fix it. */
export const MAIN_THREAD_SHARE = 0.6;

/** Which is ten milliseconds, and stays ten at every target and every refresh
 *  — see the header. Named apart from the live budget because the two must
 *  never be re-joined. */
export const MAIN_THREAD_EXCLUDE_MS = MAIN_THREAD_SHARE * BUDGET_MS;

/** The share of the budget the summed main-thread time may take before an up
 *  probe is refused. Applies ONLY where a draw covers several callbacks: the
 *  default's up path has no main-thread gate and must not grow one. */
export const HEADROOM_SHARE = 0.5;

/** Nothing is counted for this long after a rung change: the targets are
 *  reallocated in it. */
export const REALLOC_SETTLE_MS = 250;

/** How long an up-step is watched before it is trusted. */
export const VERIFY_MS = 1000;

/** The least time between changes for a down decision. A floor rather than
 *  the thing that binds: a change drops the window, so the next down-step
 *  cannot arrive before a whole new window of evidence has been counted. */
export const DOWN_SPACING_MS = 2000;

/** The wait before a first up probe, doubling on each probe that fails and
 *  reset by one that holds. */
export const PROBE_WAIT_MS = 8000;

/** Where the doubling stops. */
export const PROBE_WAIT_MAX_MS = 64_000;

/** How long a failed probe's rung is held as a ceiling, per consecutive
 *  failure at that rung: a minute, four minutes, sixteen, then the rest of
 *  the session — the not-pixel-bound latch's own escalation. */
export const CEILING_HOLD_MS: readonly number[] = [60_000, 240_000, 960_000, Infinity];

/** The improvement the floor rung must show over the mean that started the
 *  slide, or the device is not pixel-bound and gets medium back. 3 % against
 *  a 44 % cut in pixels. */
export const FLOOR_LATCH_MIN_GAIN = 0.03;

/** How long the not-pixel-bound latch holds, per failure: a minute, four
 *  minutes, then the rest of the session. */
export const LATCH_HOLD_MS: readonly number[] = [60_000, 240_000, Infinity];

/** A counted rate of zero for this long is a defect, not a quiet scene — an
 *  unfocused window, or a cover that never lifted. The caller logs it once so
 *  a phone can say so through `?debug=1`. */
export const ZERO_COUNTED_WARN_MS = 30_000;

/** One frame's evidence: the interval that ENDS at `nowMs`, and the previous
 *  frame's own figures, which are what produced it. */
export interface IntervalSample {
  /** The wall clock at the end of the interval — the same `performance.now()`
   *  the animation loop already took, never the rAF timestamp, which goes
   *  stale after a busy main thread. */
  nowMs: number;
  /** `nowMs` less the previous DRAW's. */
  intervalMs: number;
  /** The LONGEST single tick in the interval: loop start to the end of the
   *  work, for each tick since the previous draw. What exclusion reads. */
  mainThreadMs: number;
  /** All of them added up — what the headroom gate reads where a draw covers
   *  several ticks. Optional: with one tick per draw it is `mainThreadMs`,
   *  which is what a harness injecting samples means by it. */
  mainThreadSumMs?: number;
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

/** What a budget change invalidates. A change the USER made — the Frame rate
 *  row, the bridge — drops everything, because evidence at another budget is
 *  evidence about another question. An AUTOMATIC one (a cadence raise) keeps
 *  the not-pixel-bound latch, which is a fact about the device, the same keep
 *  `setLadder` makes. */
export type BudgetCause = 'user' | 'auto';

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
  /** The rung a failed probe latched, until when, and how many consecutive
   *  failures there — 1 a minute, 2 four minutes, 3 sixteen, 4 the session. */
  ceiling: { rung: number; untilMs: number; escalation: number } | null;
  /** The not-pixel-bound latch: while it stands there are no down-steps.
   *  `escalation` counts the failures — 1 a minute, 2 four minutes, 3 the
   *  session. */
  latch: { untilMs: number; escalation: number } | null;
  /** The last change the controller asked for. */
  lastStep: { atMs: number; from: number; to: number; reason: StepReason } | null;
  /** The mean that triggered the first step down from medium: what the floor
   *  has to beat. */
  floorReference: number | null;
  /** What a frame is measured against right now. */
  budgetMs: number;
  /** Counted intervals a decision needs at this budget. */
  downCounted: number;
  upCounted: number;
}

/**
 * A fixed-length ring of counted intervals, with its statistics read off it
 * in place. Allocation-free after construction: this is stepped on the render
 * path.
 */
class IntervalRing {
  private readonly atMs: Float64Array;
  private readonly ms: Float64Array;
  /** The main-thread milliseconds SUMMED over each interval, carried beside
   *  it so the headroom gate can read a window rather than one frame. */
  private readonly busyMs: Float64Array;
  private readonly top = new Float64Array(TRIM_COUNT);
  private head = 0;
  private count = 0;

  constructor(readonly capacity: number) {
    this.atMs = new Float64Array(capacity);
    this.ms = new Float64Array(capacity);
    this.busyMs = new Float64Array(capacity);
  }

  push(atMs: number, ms: number, busyMs: number): void {
    this.atMs[this.head] = atMs;
    this.ms[this.head] = ms;
    this.busyMs[this.head] = busyMs;
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

  /** Mean summed main-thread time over the newest `maxSize` intervals no
   *  older than `notBeforeMs`, or null where none are in reach. */
  meanBusy(maxSize: number, notBeforeMs: number): number | null {
    let count = 0;
    let sum = 0;
    for (let i = 0; i < this.count && count < maxSize; i++) {
      const at = (this.head - 1 - i + this.capacity) % this.capacity;
      if (this.atMs[at] < notBeforeMs) break;
      count++;
      sum += this.busyMs[at];
    }
    return count === 0 ? null : sum / count;
  }
}

/** How many recent intervals the counted rate is read over. */
const RATE_WINDOW = 240;

export class ResolutionController {
  private rungs: readonly number[];
  private mediumIndex: number;
  private index: number;

  /** What a frame is measured against, and the window lengths derived from
   *  it. `setBudget` is the only writer. */
  private budgetMs = BUDGET_MS;
  private downCounted = DOWN_WINDOW_COUNTED;
  private upCounted = UP_WINDOW_COUNTED;
  /** Whether a draw covers several callbacks, which is the only case the two
   *  quantisation gates apply in. */
  private quantised = false;

  /** Counted intervals for the decisions. Cleared on every rung change: the
   *  evidence describes the configuration it was measured in. Re-allocated
   *  when the budget changes the window length — a 120 fps target asks for
   *  960 intervals, and a ring that could not hold them would leave that
   *  target unable to probe up at all. */
  private window = new IntervalRing(UP_WINDOW_COUNTED);

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
  private ceiling: { rung: number; untilMs: number; escalation: number } | null = null;
  /** The rung the last probe failed at, held until something clears the
   *  evidence, and how many times in a row: the next failure there escalates. */
  private lastFailedProbeRung: number | null = null;
  private ceilingFailures = 0;
  private latch: { untilMs: number; escalation: number } | null = null;
  private latchFailures = 0;
  private floorReference: number | null = null;
  private lastStep: { atMs: number; from: number; to: number; reason: StepReason } | null = null;

  private pending: Decision | null = null;
  private idle = false;

  constructor(ladder: RungLadder) {
    this.rungs = ladder.rungs.length > 0 ? ladder.rungs : [1];
    this.mediumIndex = clampIndex(ladder.mediumIndex, this.rungs.length);
    this.index = this.mediumIndex;
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
      // The live budget on the left, the fixed ten milliseconds on the right:
      // one is what the frame owed, the other is what the app can explain.
      (sample.intervalMs <= this.budgetMs || sample.mainThreadMs <= MAIN_THREAD_EXCLUDE_MS);
    this.recordRate(counted);
    if (counted) {
      this.window.push(sample.nowMs, sample.intervalMs, sample.mainThreadSumMs ?? sample.mainThreadMs);
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
   * What a frame is measured against, changed — the Frame rate row picked a
   * target, or the calibrated cadence was raised. `null` is the default
   * budget.
   *
   * Everything measured at the old budget is dropped: it was evidence about
   * another question. The RUNG IS NOT MOVED — a settings change never changes
   * the picture by itself. What survives depends on who asked: a user's change
   * drops the not-pixel-bound latch too, an automatic one keeps it, because
   * that latch is a fact about the device rather than about the budget.
   *
   * `quantised` says whether a draw now covers several callbacks. It arms the
   * two gates that only make sense there, and at the row's default nothing
   * calls this at all.
   */
  setBudget(budgetMs: number | null, nowMs: number, opts: { cause: BudgetCause; quantised?: boolean }): void {
    const next = budgetMs === null || !Number.isFinite(budgetMs) || budgetMs <= 0 ? BUDGET_MS : budgetMs;
    this.clockMs = nowMs;
    this.quantised = opts.quantised ?? false;
    this.budgetMs = next;
    this.downCounted = windowCounted(DOWN_WINDOW_S, next);
    const upCounted = windowCounted(UP_WINDOW_S, next);
    this.upCounted = upCounted;
    // The ring has to be able to hold a whole up window, or the up path goes
    // silent at that budget without a symptom.
    if (this.window.capacity < upCounted) this.window = new IntervalRing(upCounted);
    else this.window.clear();
    this.pending = null;
    this.verifyUntilMs = null;
    this.ceiling = null;
    this.ceilingFailures = 0;
    this.lastFailedProbeRung = null;
    this.floorReference = null;
    if (opts.cause === 'user') {
      this.latch = null;
      this.latchFailures = 0;
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
        this.settleUntilMs = nowMs + REALLOC_SETTLE_MS;
        this.lastChangeMs = nowMs;
        this.startedMs = nowMs;
        this.lastCountedMs = null;
        return;
      case 'resize':
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
   * measurements taken against the old ladder are dropped, the session
   * ceiling with them — a resize reaches the controller here and not through
   * `notify`, and a ceiling latched for a window that no longer exists is a
   * ceiling for nothing. The not-pixel-bound latch is kept, because that is a
   * fact about the device.
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
    this.ceilingFailures = 0;
    this.lastFailedProbeRung = null;
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
    const stat = this.window.trimmedMean(this.downCounted, TRIM_COUNT, this.clockMs - STALENESS_MS);
    const since = this.lastCountedMs ?? this.startedMs ?? this.clockMs;
    return {
      rung: this.index,
      sceneRatio: this.rungs[this.index],
      idle: this.idle,
      trimmedMeanMs: stat?.meanMs ?? null,
      countedWindow: this.window.fresh(this.upCounted, this.clockMs - STALENESS_MS),
      countedRate: this.rateCount === 0 ? 0 : this.rateCounted / this.rateCount,
      silentMs: Math.max(0, this.clockMs - since),
      probeWaitMs: this.probeWait,
      ceiling: this.ceiling === null ? null : { ...this.ceiling },
      latch: this.latch === null ? null : { ...this.latch },
      lastStep: this.lastStep === null ? null : { ...this.lastStep },
      floorReference: this.floorReference,
      budgetMs: this.budgetMs,
      downCounted: this.downCounted,
      upCounted: this.upCounted,
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

  /** The bar a window has to clear to probe up. */
  private upThresholdMs(): number {
    return UP_FACTOR * this.budgetMs;
  }

  /** The reading that undoes a probe: a genuinely over-budget second. */
  private verifyThresholdMs(): number {
    return DOWN_FACTOR * this.budgetMs;
  }

  private finishVerification(nowMs: number): Decision | null {
    this.verifyUntilMs = null;
    const stat = this.window.trimmedMean(this.upCounted, VERIFY_TRIM_COUNT, nowMs - STALENESS_MS);
    if (stat === null || stat.count < VERIFY_MIN_COUNTED) return null;
    if (stat.meanMs > this.verifyThresholdMs()) {
      this.probeWait = Math.min(PROBE_WAIT_MAX_MS, this.probeWait * 2);
      // Again at the same rung, with nothing in between that cleared the
      // evidence: the hold escalates, a minute to four to sixteen to the
      // session. A different rung starts its own count.
      this.ceilingFailures = this.lastFailedProbeRung === this.index ? this.ceilingFailures + 1 : 0;
      const hold = CEILING_HOLD_MS[Math.min(this.ceilingFailures, CEILING_HOLD_MS.length - 1)];
      this.ceiling = { rung: this.index, untilMs: nowMs + hold, escalation: this.ceilingFailures + 1 };
      this.lastFailedProbeRung = this.index;
      return this.emit(this.verifyFromIndex, 'revert');
    }
    this.probeWait = PROBE_WAIT_MS;
    this.lastFailedProbeRung = null;
    this.ceilingFailures = 0;
    return null;
  }

  private downDecision(nowMs: number): Decision | null {
    if (this.index <= 0 || this.latch !== null) return null;
    if (nowMs - this.lastChangeMs < DOWN_SPACING_MS) return null;
    const stat = this.window.trimmedMean(this.downCounted, TRIM_COUNT, nowMs - STALENESS_MS);
    if (stat === null || stat.count < this.downCounted) return null;
    // A full window inside the budget: this rung holds.
    if (stat.meanMs <= DOWN_FACTOR * this.budgetMs) return null;
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
    const stat = this.window.trimmedMean(this.downCounted, TRIM_COUNT, nowMs - STALENESS_MS);
    if (stat === null || stat.count < this.downCounted) return null;
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
    const stat = this.window.trimmedMean(this.upCounted, TRIM_COUNT, nowMs - STALENESS_MS);
    if (stat === null || stat.count < this.upCounted) return null;
    if (stat.meanMs > this.upThresholdMs()) return null;
    // Headroom, and only where a draw covers several callbacks: there every
    // frame that fits reports exactly the period, so the interval says
    // nothing about what the frame had left and the main thread has to.
    if (this.quantised) {
      const busy = this.window.meanBusy(this.upCounted, nowMs - STALENESS_MS);
      if (busy !== null && busy > HEADROOM_SHARE * this.budgetMs) return null;
    }
    return this.emit(next, 'up');
  }
}

function clampIndex(index: number, length: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.min(length - 1, Math.max(0, Math.floor(index)));
}
