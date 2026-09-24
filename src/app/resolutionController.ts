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
 * **Budget: 60 fps at and below Medium, unless the Frame rate row says
 * otherwise.** Under vsync a frame is delivered on a refresh tick, so a
 * frame's cost never appears in the intervals: on a 120 Hz panel a 12 ms frame
 * is delivered at 16.67 ms. Holding the panel's own rate for the slide DOWN
 * would make every such frame a miss and take pixels from a 120 Hz machine
 * that is delivering a perfectly even 60, so below Medium the bar is 60 fps
 * on every display. `BUDGET_MS` is that default and `setBudget` is the one
 * door that moves it: the Frame rate row's target is a rate the app then has
 * to DEFEND with pixels, so the budget follows it (app/frameCadence.ts derives
 * the number).
 *
 * **Above Medium the bar is the display's own tick, and on a 60 Hz display
 * the intervals take no climb at all — only the GPU clock can (below).**
 * Taking a rung above Medium asks a different
 * question — may the picture be made sharper than it was? — and the intervals
 * can only answer it where the display has a finer tick than the budget: on a
 * 120 Hz panel a frame that fits one tick reads 8.33 ms and one that needs two
 * reads 16.67, so the rule can see whether the full rate holds. On a 60 Hz
 * panel an 11 ms frame and a 16 ms one both read 16.67 and the rule is blind;
 * an earlier version climbed while frames were on time and was measured
 * climbing until they missed — a phone at Earth's shell going from a locked
 * 60 fps to the fifties and hotter, a 120 Hz Mac from 120 fps to 80. So a rung
 * above Medium is taken, kept and verified against `aboveBudgetMs` — the
 * display's cadence under the row's default, where that is faster than 60 —
 * and where there is no finer tick (`aboveAllowed` false) Dynamic is Medium
 * and below, and High is the menu's choice. A row's own target is a rate the
 * user asked to be defended with pixels, so under a row the bar above Medium
 * is the row's budget and the climb is allowed. The rung a sharper picture is
 * handed back to is Medium, never lower: a display that cannot hold its own
 * rate at the sharper rung is not made softer than it was for it.
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
 * triggered the first step down from medium, nor than the mean that triggered
 * the last step (the rung just above, as it read most recently — a chip that
 * throttled mid-slide makes medium's reading stale, and a floor judged
 * against it alone was handed medium back at half the floor's rate), the
 * device is not pixel-bound —
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
 * its run. The count resets when a probe at that rung holds through its
 * probation (below), and the ceiling is cleared by a budget change or a new
 * ladder (a resize, a level change) and by nothing else — an arrival fires on
 * every teleport, and a ceiling cleared several times a journey would bound
 * nothing.
 *
 * **An up-step is on probation for two minutes.** The verification second
 * catches a rung whose frames miss outright, not one that lands just inside
 * the down bar. Measured, at a tight budget on a Mac: the rung above read
 * 9.55 ms against a down bar of 9.58, the rung below 8.17 against an up bar of
 * 8.50, and the picture cycled between the two every ten to forty seconds with
 * nothing failing — each up passed its verification, each down came from the
 * down window, and no ceiling was ever set. So a down decision from a rung
 * reached by a probe less than two minutes earlier IS that probe failing, and
 * takes the failure's whole treatment: the wait doubles and the rung's ceiling
 * escalates. A pose that straddles the bar then costs at most the escalation's
 * eight changes over twenty minutes and sits one rung below for the rest of
 * the session. The probation is cleared by whatever clears the verification —
 * a budget or ladder change, an arrival, a pin, a focus gain — because a down
 * after a new pose is a new question rather than a probe failing.
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
 * **The GPU clock, where the tick is blind.** On a display whose tick is not
 * finer than the budget and with no row target (`aboveAllowed` false — every
 * 60 Hz phone, Safari on a Mac), a rung above Medium may be taken when the
 * frame clock of app/gpuFrameClock.ts says there is room, and is handed back
 * when it says the room is gone. `aboveAllowed` keeps its meaning — the tick,
 * or a row — and the clock is a separate branch that never opens the interval
 * up-path: where the tick IS finer the clock does nothing at all, because
 * there the intervals are a direct measurement and the clock a latency with
 * an engine's bias. Where there is no clock (WebGL1, `?gpuclock=0`) the rule
 * is exactly what it was. The slide below Medium never reads the clock.
 *
 * A reading is admitted only paired with the verdict on the interval of the
 * frame it measured (`IntervalSample.gpu`, matched by `drawSeq`, whichever
 * later step it arrives on): a frame whose interval did not count, one drawn
 * before a settle ended, or one from an older generation — every rung change,
 * event, budget and ladder bumps it — measured something else. Starved
 * readings never enter a statistic; capped ones count as over the bar.
 *
 * A clock climb is one rung, and needs everything an interval climb needs
 * that still means something on a blind tick — the probe wait, no ceiling on
 * the rung, the up window of intervals within its bar (the frames are not
 * already late: a device capped from outside the app would otherwise climb
 * on an idle-looking GPU), no not-pixel-bound latch — plus a clock window of
 * at least `CLOCK_UP_COUNT` trusted readings spanning `CLOCK_UP_SPAN_MS`, a
 * starved share within bounds, and the p90 of the next rung's predicted
 * readings (app/gpuFrameClockPolicy.ts `predictReadingMs`) inside
 * `CLOCK_UP_SHARE` of the budget. The p90 and not the median: under motion a
 * median can read ample room while nearly half the frames sit at the deadline.
 *
 * A rung the clock earned is kept only while the clock vouches for it. Right
 * after the climb, and again after ANY evidence reset while it stands (a rung
 * change, an arrival, a resize, a focus gain, a pin lifted, a budget or a
 * ladder), `CLOCK_VERIFY_COUNT` fresh readings must arrive within
 * `CLOCK_VERIFY_MS` and pass — their mean with the longest dropped inside
 * `CLOCK_DOWN_SHARE` of the budget. A probe that fails that is the probe
 * failing (a revert, the wait doubled, the ceiling's escalation), and so are
 * starved or capped readings repeating through it; a reset that is not
 * re-earned in time is a plain restore to Medium, with no ceiling and no
 * longer wait, because a lifecycle event is not the rung failing. After that
 * the rung is handed back — one rung, never below Medium — by any of: the p90
 * of a window of at least `CLOCK_DOWN_COUNT` readings spanning
 * `CLOCK_DOWN_SPAN_MS` above `CLOCK_DOWN_SHARE` of the budget;
 * `CLOCK_PANIC_COUNT` readings in a row over the budget; or the intervals'
 * down window over `CLOCK_INTERVAL_DOWN` of the budget, a tighter bar than
 * the tick's, because a phone at 52–58 fps at a sharper rung is the
 * regression this rule exists to prevent. Inside its probation each of those
 * is the probe failing. And the clock going quiet — too few readings in the
 * staleness horizon, starved readings over their share, or the sensor off —
 * returns the rung to Medium with no ceiling: no clock is the rule as it was,
 * applied to the rung as well as to the climb. Once a climb's verification
 * has measured the sharper rung, a clock that read it LOWER than the rung
 * below (by more than its grid) is not tracking the load, and is off for the
 * session. None of the clock's decisions touch the floor's references, which
 * are interval evidence.
 *
 * Not in this version: the slide below Medium by the clock; a bias
 * calibration; a timer query; the clock on a display with a finer tick or
 * under a row target (a row's cadence can be quantised too — deferred, not
 * claimed sufficient); a predictive extrapolation term; and the phone's own
 * numbers, which the constants wait on.
 *
 * **No estimator of the panel's period lives here.** The display's cadence
 * comes in through `setBudget` from app/frameCadence.ts, which calibrates it
 * under the boot cover and raises it on faster live evidence; an earlier
 * draft estimated it from a low percentile of counted intervals, and a fast
 * misread there was a budget too tight for the display.
 */

import {
  CLOCK_DOWN_SHARE,
  CLOCK_UP_SHARE,
  REVERSAL_MS,
  REVERSAL_REPEATS,
  STARVED_SHARE_MAX,
  isReversal,
  predictReadingMs,
} from './gpuFrameClockPolicy';

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
 *  reset by one that holds through its probation. */
export const PROBE_WAIT_MS = 8000;

/** Where the doubling stops. */
export const PROBE_WAIT_MAX_MS = 64_000;

/** How long a failed probe's rung is held as a ceiling, per consecutive
 *  failure at that rung: a minute, four minutes, sixteen, then the rest of
 *  the session — the not-pixel-bound latch's own escalation. */
export const CEILING_HOLD_MS: readonly number[] = [60_000, 240_000, 960_000, Infinity];

/** How long an up-step has to hold. A down decision from that rung sooner is
 *  the probe failing, not a slide: it lands just inside the down bar, and
 *  without this the rule would hand the rung back and probe it again for as
 *  long as the pose lasts. */
export const PROBE_HOLD_MS = 120_000;

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

/** Trusted clock readings, and the seconds they must span, behind a clock
 *  climb: a median of that size was stable to ±1.5 ms p10–p90 on the one Mac
 *  measured, and the span keeps a burst of readings from one pose deciding. */
export const CLOCK_UP_COUNT = 32;
export const CLOCK_UP_SPAN_MS = 6000;

/** And behind a hand-back by the clock. */
export const CLOCK_DOWN_COUNT = 16;
export const CLOCK_DOWN_SPAN_MS = 3000;

/** Fresh readings a rung the clock earned must produce, and how long it has
 *  to produce them, after the climb and after every evidence reset: fixed,
 *  so a duty of 8 or 16 still reaches a verdict inside the time. */
export const CLOCK_VERIFY_COUNT = 8;
export const CLOCK_VERIFY_MS = 3000;

/** Readings in a row over the budget that hand the rung back at once. */
export const CLOCK_PANIC_COUNT = 4;

/** The intervals' down bar at a rung the clock earned: about 57 fps, where
 *  the tick's own bar would be 52. */
export const CLOCK_INTERVAL_DOWN = 1.05;

/** Starved or capped readings through a clock probe's verification that,
 *  once they are over the starved share, are the probe failing rather than
 *  merely short of evidence. */
export const CLOCK_PROBE_BAD_MIN = 2;

/** The recent attempts the starved share is read over, and how many of them a
 *  share needs before it means anything. */
export const CLOCK_STARVED_WINDOW = 16;
export const CLOCK_STARVED_MIN = 8;

/** Silence: this long of active, visible drawing with no admissible reading. */
export const CLOCK_GAP_MS = 1000;

/** Silence, too: fewer than `CLOCK_DOWN_COUNT` trusted readings in the
 *  preceding span this long, once the clock's evidence is that old. */
export const CLOCK_SILENCE_SPAN_MS = 6000;

/** Every frame drawn, untrimmed and unfiltered — streaming, main-thread and
 *  sensor overruns included, only the page away, covered or pinned left out —
 *  over this span: its mean must be within `CLOCK_DELIVERY_UP` of the budget
 *  for a clock climb, and a rung the clock earned goes back to Medium when it
 *  passes `CLOCK_DELIVERY_GUARD`. 58 fps is 17.24 ms, which a trimmed mean of
 *  counted intervals against 1.05 × the budget would let through; permission
 *  to KEEP extra pixels is not a question about what the pixels cost. */
export const CLOCK_DELIVERY_SPAN_MS = 6000;
export const CLOCK_DELIVERY_UP = 1.01;
export const CLOCK_DELIVERY_GUARD = 1.02;

/** Readings the clock keeps. At most one reading a frame, and a 6 s window at
 *  60 fps and one frame in four is 90 of them. */
const CLOCK_RING_SIZE = 256;

/** Recent frames whose interval verdict is kept for a late reading to find. */
const VERDICT_RING_SIZE = 8;

/** Eligible steps kept for the delivery guard: six seconds at 120 callbacks a
 *  second, which a pinned 60 Hz cadence on a 120 Hz engine delivers. */
const DELIVERY_RING_SIZE = 1024;

/** A GPU clock reading of one frame (app/gpuFrameClock.ts). */
export interface GpuObservation {
  /** The draw the fence closed. */
  drawSeq: number;
  /** The controller's generation when that draw ended. */
  generation: number;
  /** When that draw's animation callback started: what the settle and the
   *  staleness horizon judge the reading by. */
  sampledAtMs: number;
  /** Signalled less the callback start; Infinity for a capped fence. */
  readingMs: number;
  /** Submitted less the callback start: the part that does not grow with
   *  pixels. */
  busyMs: number;
  /** The poll that saw the signal came after a gap the clock cannot vouch
   *  for. Never enters a statistic. */
  starved: boolean;
  /** performance.now()'s grid as the sensor has seen it. */
  gridMs?: number | null;
}

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
  /** The draw that produced the interval, so a GPU reading of that draw can
   *  be paired with this verdict when it arrives. */
  drawSeq?: number;
  /** A GPU reading that finished since the last step: of this sample's draw,
   *  or of an earlier one whose reading came in late. Admitted only if that
   *  draw's interval counted. */
  gpu?: GpuObservation | null;
  /** The GPU clock's own main-thread work inside the interval — its fence,
   *  its flushes and its poll tasks — that ran after the next frame was due:
   *  the only part of it that can have held the next callback back. An
   *  over-budget interval this work explains was made late by the sensor, not
   *  by the pixels, and does not count. Never part of the main-thread
   *  figures. */
  sensorMs?: number;
}

/** Why a rung is being changed. */
export type StepReason = 'down' | 'up' | 'revert' | 'floor latch' | 'ladder' | 'restore';

/** Why the clock moved a rung, for the readout. */
export type ClockWhy =
  | 'climb' | 'verify' | 'unverified' | 'panic' | 'delivery' | 'hand-back' | 'intervals'
  | 'silent' | 'gap' | 'starved' | 'off' | 'reversal';

/** The GPU clock's part of the rule, as `__moon.quality().clock` shows it. */
export interface ClockState {
  /** The clock is the rule above Medium right now: the tick is blind, no row
   *  target, a rung above Medium exists, the controller is not held, and the
   *  clock is not off. */
  steering: boolean;
  /** The current rung is above Medium because the clock earned it. */
  earned: boolean;
  /** Why the clock is off, or null. */
  off: string | null;
  generation: number;
  /** Trusted readings of this generation inside the staleness horizon. */
  counted: number;
  /** Starved readings among the recent ones, or null with too few. */
  starvedShare: number | null;
  /** Over the trusted readings of this generation: diagnostic only. */
  medianMs: number | null;
  /** The safety statistic, over the same readings. */
  p90Ms: number | null;
  /** What a reading is held against: the budget. */
  barMs: number;
  /** The next rung's predicted p90, where there is a rung to predict and a
   *  climb window to predict it from. */
  predictedNextMs: number | null;
  /** Every frame drawn over the delivery span, untrimmed, or null before the
   *  span has been drawn. */
  deliveredMs: number | null;
  /** A verification standing: a probe's, or a reset's re-earning, with its
   *  deadline once the first eligible frame after it has started it. */
  verify: { kind: 'probe' | 'reset'; readings: number; deadlineMs: number | null } | null;
  panicStreak: number;
  /** Climbs whose sharper rung read markedly faster than the rung below. */
  reversals: number;
  accepted: number;
  dropped: { unpaired: number; uncounted: number; stale: number; settling: number; notSteering: number };
  /** Why the frames behind the uncounted readings did not count. */
  uncountedBy: { ineligible: number; settling: number; worked: number; mainThread: number; sensor: number };
  last: { atMs: number; from: number; to: number; why: ClockWhy } | null;
}

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
  /** The rung the last probe reached and until when it is on probation: a
   *  down from it before then is the probe failing. */
  probation: { rung: number; untilMs: number } | null;
  /** The not-pixel-bound latch: while it stands there are no down-steps.
   *  `escalation` counts the failures — 1 a minute, 2 four minutes, 3 the
   *  session. */
  latch: { untilMs: number; escalation: number } | null;
  /** The last change the controller asked for. */
  lastStep: { atMs: number; from: number; to: number; reason: StepReason } | null;
  /** The mean that triggered the first step down from medium: what the floor
   *  has to beat. */
  floorReference: number | null;
  /** The mean that triggered the latest step down — the rung just above the
   *  floor as it last read — which the floor may beat instead. */
  stepReference: number | null;
  /** What a frame at or below Medium is measured against right now. */
  budgetMs: number;
  /** What a rung above Medium is measured against — the display's own tick
   *  at the row's default — and whether one may be taken on its own at all. */
  aboveBudgetMs: number;
  aboveAllowed: boolean;
  /** Counted intervals a decision needs at this budget. */
  downCounted: number;
  upCounted: number;
  /** The GPU clock's part of the rule. */
  clock: ClockState;
}

/**
 * The GPU clock's readings, newest first, with the windows the rule reads.
 * Allocation-light: the ring and its scratch are sized once.
 */
class ClockRing {
  private readonly atMs: Float64Array;
  private readonly readingMs: Float64Array;
  private readonly busyMs: Float64Array;
  private readonly starved: Uint8Array;
  private readonly scratch: Float64Array;
  private head = 0;
  private count = 0;

  constructor(readonly capacity: number) {
    this.atMs = new Float64Array(capacity);
    this.readingMs = new Float64Array(capacity);
    this.busyMs = new Float64Array(capacity);
    this.starved = new Uint8Array(capacity);
    this.scratch = new Float64Array(capacity);
  }

  push(atMs: number, readingMs: number, busyMs: number, starved: boolean): void {
    this.atMs[this.head] = atMs;
    this.readingMs[this.head] = readingMs;
    this.busyMs[this.head] = busyMs;
    this.starved[this.head] = starved ? 1 : 0;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
  }

  private at(i: number): number {
    return (this.head - 1 - i + this.capacity) % this.capacity;
  }

  /**
   * The newest trusted readings no older than `notBeforeMs`, taken until
   * there are at least `minCount` of them AND they span at least `minSpanMs`
   * — a window as long as the longer of the two asks. Null where the evidence
   * in reach cannot make one. `predict` maps each reading (and its busy part)
   * to the quantity the statistic is taken over; the quantile is by nearest
   * rank. The starved share is over every reading the window reached.
   */
  window(
    minCount: number,
    minSpanMs: number,
    notBeforeMs: number,
    quantile: number,
    predict: ((readingMs: number, busyMs: number) => number) | null = null,
  ): { value: number; medianMs: number; count: number; starvedShare: number } | null {
    let n = 0;
    let total = 0;
    let starved = 0;
    let newest = NaN;
    let done = false;
    for (let i = 0; i < this.count; i++) {
      const k = this.at(i);
      const at = this.atMs[k];
      if (at < notBeforeMs) break;
      if (Number.isNaN(newest)) newest = at;
      total++;
      if (this.starved[k] === 1) { starved++; continue; }
      this.scratch[n++] = this.readingMs[k];
      if (n >= minCount && newest - at >= minSpanMs) { done = true; break; }
    }
    if (!done) return null;
    const medianMs = rank(this.scratch, n, 0.5);
    if (predict !== null) {
      // Refill with the predicted quantity, over exactly the same readings.
      let m = 0;
      for (let i = 0; m < n && i < this.count; i++) {
        const k = this.at(i);
        if (this.starved[k] === 1) continue;
        this.scratch[m++] = predict(this.readingMs[k], this.busyMs[k]);
      }
    }
    return { value: rank(this.scratch, n, quantile), medianMs, count: n, starvedShare: total === 0 ? 0 : starved / total };
  }

  /** The trusted readings no older than `notBeforeMs`, their mean with the
   *  longest dropped, their median, and how many starved and capped readings
   *  came with them. */
  since(notBeforeMs: number): {
    count: number;
    trimmedMeanMs: number | null;
    medianMs: number | null;
    p90Ms: number | null;
    starved: number;
    capped: number;
  } {
    let n = 0;
    let starved = 0;
    let capped = 0;
    for (let i = 0; i < this.count; i++) {
      const k = this.at(i);
      if (this.atMs[k] < notBeforeMs) break;
      if (this.starved[k] === 1) { starved++; continue; }
      if (!Number.isFinite(this.readingMs[k])) capped++;
      this.scratch[n++] = this.readingMs[k];
    }
    if (n === 0) return { count: 0, trimmedMeanMs: null, medianMs: null, p90Ms: null, starved, capped };
    const view = this.scratch.subarray(0, n);
    view.sort();
    let sum = 0;
    for (let i = 0; i < n - 1; i++) sum += view[i];
    const trimmedMeanMs = n === 1 ? view[0] : sum / (n - 1);
    return {
      count: n,
      trimmedMeanMs,
      medianMs: view[Math.ceil(0.5 * n) - 1],
      p90Ms: view[Math.ceil(0.9 * n) - 1],
      starved,
      capped,
    };
  }

  /** The starved share of the newest `size` readings no older than
   *  `notBeforeMs`, or null with fewer than `min` of them. */
  starvedShare(size: number, min: number, notBeforeMs: number): number | null {
    let total = 0;
    let starved = 0;
    for (let i = 0; i < this.count && total < size; i++) {
      const k = this.at(i);
      if (this.atMs[k] < notBeforeMs) break;
      total++;
      if (this.starved[k] === 1) starved++;
    }
    return total < min ? null : starved / total;
  }
}

/** Every eligible step's interval, for the delivery guard. */
class DeliveryRing {
  private readonly atMs: Float64Array;
  private readonly ms: Float64Array;
  private head = 0;
  private count = 0;
  private firstAtMs = NaN;

  constructor(readonly capacity: number) {
    this.atMs = new Float64Array(capacity);
    this.ms = new Float64Array(capacity);
  }

  push(atMs: number, ms: number): void {
    if (this.count === 0) this.firstAtMs = atMs - ms;
    this.atMs[this.head] = atMs;
    this.ms[this.head] = ms;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
    this.firstAtMs = NaN;
  }

  /** The mean interval over the last `spanMs`, or null until that much has
   *  been drawn. Untrimmed: every late frame counts. */
  mean(nowMs: number, spanMs: number): number | null {
    if (this.count === 0 || !(nowMs - this.firstAtMs >= spanMs)) return null;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < this.count; i++) {
      const k = (this.head - 1 - i + this.capacity) % this.capacity;
      if (this.atMs[k] <= nowMs - spanMs) break;
      sum += this.ms[k];
      n++;
    }
    return n === 0 ? null : sum / n;
  }
}

/** The value at quantile `q` of the first `n` entries, by nearest rank. Sorts
 *  them in place. */
function rank(values: Float64Array, n: number, q: number): number {
  const view = values.subarray(0, n);
  view.sort();
  return view[Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1))];
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
  /** The bar above Medium, and whether a rung above it may be taken at all.
   *  Closed until `setBudget` says the display has a finer tick to measure a
   *  sharper rung against, or a row asked for a rate to defend. */
  private aboveBudgetMs = BUDGET_MS;
  private aboveAllowed = false;
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
  /** The rung the last probe reached, on probation until then. */
  private probation: { rung: number; untilMs: number } | null = null;
  private latch: { untilMs: number; escalation: number } | null = null;
  private latchFailures = 0;
  private floorReference: number | null = null;
  private stepReference: number | null = null;
  private lastStep: { atMs: number; from: number; to: number; reason: StepReason } | null = null;

  private pending: Decision | null = null;
  private idle = false;

  /** Bumped by every rung change, event, budget and ladder: a GPU reading
   *  tagged with an older one measured another configuration. */
  private generationCount = 0;
  /** The clock's readings, cleared with every generation and every duty
   *  change, and when the clock's evidence started. */
  private readonly clockRing = new ClockRing(CLOCK_RING_SIZE);
  private clockSinceMs = 0;
  /** Why the clock is off, or null while it may steer. */
  private clockOffReason: string | null = null;
  /** The current rung above Medium was reached by the clock, and is kept only
   *  while the clock vouches for it. */
  private clockEarned = false;
  /** A clock climb decided and not yet applied, with the rung below's median
   *  for the honesty rule. */
  private pendingClimb: { belowMedianMs: number } | null = null;
  /** A verification standing at a rung the clock earned. */
  private clockVerify: {
    kind: 'probe' | 'reset';
    fromIndex: number;
    belowMedianMs: number | null;
    /** Readings count from frames drawn at or after this. */
    startMs: number;
    /** Set by the first eligible step after it opened, and never moved. */
    deadlineMs: number | null;
  } | null = null;
  /** Trusted readings in a row over the budget. */
  private panicStreak = 0;
  /** Active, visible drawing since the clock last had a reading. */
  private activeSinceReadingMs = 0;
  /** When the clock last passed a verification at the rung it holds: the
   *  steady-state silence rule runs from here, so the verification's eight
   *  readings are never judged by the sixteen. */
  private clockAcquiredAtMs: number | null = null;
  /** Every eligible step, for the delivery guard. */
  private readonly delivery = new DeliveryRing(DELIVERY_RING_SIZE);
  /** The last probe's rung was reached by the clock: its failures outlive the
   *  probation. */
  private probationByClock = false;
  private clockReversals = 0;
  /** Recent frames' interval verdicts, for a late reading to find its own. */
  private readonly verdictSeq = new Float64Array(VERDICT_RING_SIZE).fill(-1);
  private readonly verdictBecause = new Uint8Array(VERDICT_RING_SIZE);
  private verdictHead = 0;
  private clockAccepted = 0;
  private readonly clockDropped = { unpaired: 0, uncounted: 0, stale: 0, settling: 0, notSteering: 0 };
  private readonly clockUncountedBy = { ineligible: 0, settling: 0, worked: 0, mainThread: 0, sensor: 0 };
  private clockLast: { atMs: number; from: number; to: number; why: ClockWhy } | null = null;

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
    const sensorMs = sample.sensorMs ?? 0;
    const counted =
      !this.idle &&
      sample.eligible &&
      settled &&
      sample.workedMs === 0 &&
      // The live budget on the left, the fixed ten milliseconds on the right:
      // one is what the frame owed, the other is what the app can explain.
      (sample.intervalMs <= this.budgetMs || sample.mainThreadMs <= MAIN_THREAD_EXCLUDE_MS) &&
      // A late interval the GPU clock's own work explains was made late by
      // the sensor, and fewer pixels would not have fixed it. Late means past
      // the on-time tolerance the up bar allows: a 60 Hz engine delivers
      // 16.6 to 16.8 ms around a 16.67 budget, and that jitter is not a frame
      // anyone made late — excluding it would throw away every sampled
      // frame's reading whose interval happened to land a hair over.
      !(sensorMs > 0 && sample.intervalMs > UP_FACTOR * this.budgetMs && sample.intervalMs - sensorMs <= this.budgetMs);
    this.recordRate(counted);
    // Why an interval did not count, kept beside the verdict for the readout.
    const because = counted ? 0
      : this.idle || !sample.eligible ? 1
        : !settled ? 2
          : sample.workedMs !== 0 ? 3
            : !(sample.intervalMs <= this.budgetMs || sample.mainThreadMs <= MAIN_THREAD_EXCLUDE_MS) ? 4
              : 5;
    if (counted) {
      this.window.push(sample.nowMs, sample.intervalMs, sample.mainThreadSumMs ?? sample.mainThreadMs);
      this.lastCountedMs = sample.nowMs;
    }
    if (sample.drawSeq !== undefined) this.recordVerdict(sample.drawSeq, because);
    if (sample.gpu) this.admitGpu(sample.gpu);
    this.recordDelivery(sample, settled);
    // A verification's time starts at the first eligible frame after it opened
    // — the settle inside it — so a veil or a hidden page cannot use it up.
    if (this.clockVerify !== null && this.clockVerify.deadlineMs === null && sample.eligible && !this.idle) {
      this.clockVerify.deadlineMs = sample.nowMs + CLOCK_VERIFY_MS;
    }
    if (this.idle || this.pending !== null) return null;
    if (this.ceiling !== null && sample.nowMs >= this.ceiling.untilMs) this.ceiling = null;
    if (this.latch !== null && sample.nowMs >= this.latch.untilMs) this.latch = null;
    if (this.probation !== null && sample.nowMs >= this.probation.untilMs) {
      // Held through the whole probation: the probe succeeded, so the wait
      // and the rung's failure count start over — except at a rung the clock
      // earned, whose measured failures keep adding up for as long as the
      // evidence is not reset, or a device that heats slowly would earn,
      // throttle, recover and repeat for ever.
      this.probation = null;
      this.probeWait = PROBE_WAIT_MS;
      if (!this.probationByClock) {
        this.lastFailedProbeRung = null;
        this.ceilingFailures = 0;
      }
      this.probationByClock = false;
    }
    if (!settled) return null;
    // A rung the clock earned is judged by the clock first, and only on a
    // frame that could count: hidden, covered and pinned stretches suspend it,
    // and the resumption re-earns it.
    if (this.clockHolds()) {
      if (!sample.eligible) return null;
      const held = this.clockHeldDecision(sample.nowMs);
      if (held !== null) return held;
    }
    if (this.verifyUntilMs !== null) {
      if (sample.nowMs < this.verifyUntilMs) return null;
      return this.finishVerification(sample.nowMs);
    }
    // Nothing else is decided while the clock's verification stands.
    if (this.clockVerify !== null) return null;
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
    const climb = this.pendingClimb;
    this.pendingClimb = null;
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
      this.probation = { rung: this.index, untilMs: nowMs + PROBE_HOLD_MS };
    } else {
      this.verifyUntilMs = null;
      // A down, a revert, a floor latch or a ladder change: the rung the last
      // probe reached is no longer the rung, so there is nothing on probation.
      this.probation = null;
    }
    this.resetClockEvidence(nowMs);
    // Only a probe the clock made keeps its failures past its probation.
    this.probationByClock = false;
    if (kind === 'up' && climb !== null && this.index > this.mediumIndex) {
      // A clock probe: the clock verifies it, and the rung is the clock's.
      this.clockEarned = true;
      this.probationByClock = true;
      this.clockVerify = {
        kind: 'probe',
        fromIndex: from,
        belowMedianMs: climb.belowMedianMs,
        startMs: this.settleUntilMs,
        deadlineMs: null,
      };
    } else {
      // A new rung is a new question: whatever verification stood was for
      // the rung that was.
      this.clockVerify = null;
      this.reopenClockVerify();
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
   * two gates that only make sense there.
   *
   * `above` is what a rung above Medium is held to and whether one may be
   * taken at all (the header). Left out, a row's budget is defended in both
   * directions and the default budget closes the climb — which is what Screen
   * on a display with no finer tick than 60 fps means.
   */
  setBudget(
    budgetMs: number | null,
    nowMs: number,
    opts: { cause: BudgetCause; quantised?: boolean; above?: { budgetMs: number; allowed: boolean } },
  ): void {
    const next = budgetMs === null || !Number.isFinite(budgetMs) || budgetMs <= 0 ? BUDGET_MS : budgetMs;
    this.clockMs = nowMs;
    this.quantised = opts.quantised ?? false;
    this.budgetMs = next;
    const above = opts.above ?? { budgetMs: next, allowed: budgetMs !== null };
    this.aboveBudgetMs = Number.isFinite(above.budgetMs) && above.budgetMs > 0 ? above.budgetMs : next;
    this.aboveAllowed = above.allowed;
    this.downCounted = windowCounted(DOWN_WINDOW_S, next);
    const upCounted = windowCounted(UP_WINDOW_S, next);
    this.upCounted = upCounted;
    // The ring has to be able to hold a whole up window, or the up path goes
    // silent at that budget without a symptom.
    if (this.window.capacity < upCounted) this.window = new IntervalRing(upCounted);
    else this.window.clear();
    this.pending = null;
    this.verifyUntilMs = null;
    this.probation = null;
    this.probationByClock = false;
    this.ceiling = null;
    this.ceilingFailures = 0;
    this.lastFailedProbeRung = null;
    this.floorReference = null;
    this.stepReference = null;
    if (opts.cause === 'user') {
      this.latch = null;
      this.latchFailures = 0;
    }
    this.pendingClimb = null;
    this.resetClockEvidence(nowMs);
    this.reopenClockVerify();
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
    this.pendingClimb = null;
    this.verifyUntilMs = null;
    // Whatever drops the verification drops the probation with it: a down
    // after an arrival or a focus gain is a new question, not a probe failing.
    this.probation = null;
    this.probationByClock = false;
    this.resetClockEvidence(nowMs);
    switch (event) {
      case 'pin':
        this.idle = true;
        // Re-earned when the pin is lifted.
        this.clockVerify = null;
        return;
      case 'unpin':
        this.idle = false;
        this.settleUntilMs = nowMs + REALLOC_SETTLE_MS;
        this.lastChangeMs = nowMs;
        break;
      case 'boot':
        this.settleUntilMs = nowMs + REALLOC_SETTLE_MS;
        this.lastChangeMs = nowMs;
        this.startedMs = nowMs;
        this.lastCountedMs = null;
        break;
      case 'resize':
        this.settleUntilMs = nowMs + REALLOC_SETTLE_MS;
        break;
      case 'arrival':
      case 'focus':
        // Neither ever steps by itself: the frames under a veil and the
        // frames around a blur say nothing about what the scene costs, and
        // with the eligibility gate the rung cannot have moved while nobody
        // was looking.
        this.settleUntilMs = nowMs + REALLOC_SETTLE_MS;
        break;
    }
    // A rung the clock earned is re-earned once the event has settled.
    this.reopenClockVerify();
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
    this.probation = null;
    this.probationByClock = false;
    this.ceiling = null;
    this.ceilingFailures = 0;
    this.lastFailedProbeRung = null;
    this.floorReference = null;
    this.stepReference = null;
    this.clockMs = nowMs;
    this.settleUntilMs = nowMs + REALLOC_SETTLE_MS;
    this.lastChangeMs = nowMs;
    this.pendingClimb = null;
    this.resetClockEvidence(nowMs);
    this.reopenClockVerify();
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
      probation: this.probation === null ? null : { ...this.probation },
      latch: this.latch === null ? null : { ...this.latch },
      lastStep: this.lastStep === null ? null : { ...this.lastStep },
      floorReference: this.floorReference,
      stepReference: this.stepReference,
      budgetMs: this.budgetMs,
      aboveBudgetMs: this.aboveBudgetMs,
      aboveAllowed: this.aboveAllowed,
      downCounted: this.downCounted,
      upCounted: this.upCounted,
      clock: this.clockState(),
    };
  }

  // --- The GPU clock ------------------------------------------------------

  /** The generation a GPU reading must carry to be admitted. */
  get generation(): number {
    return this.generationCount;
  }

  /** What a clock reading is held against where the clock steers: the
   *  budget. */
  get clockBarMs(): number {
    return this.budgetMs;
  }

  /** Why the clock is off, or null. */
  get clockOff(): string | null {
    return this.clockOffReason;
  }

  /**
   * Whether a reading taken now would be read: the sensor samples only then,
   * so it costs nothing where it could not help — a display with a finer tick,
   * a row target, a held controller, a ladder with nothing above Medium, the
   * not-pixel-bound latch, or a rung below Medium. At Medium a ceiling on the
   * next rung stops the sampling too, since nothing could be probed; a rung
   * the clock earned is watched whatever the rung above it holds, or the
   * controller would make its own silence and restore Medium for it.
   */
  wantsClock(): boolean {
    if (this.idle || this.aboveAllowed || this.clockOffReason !== null) return false;
    if (this.mediumIndex >= this.rungs.length - 1) return false;
    if (this.index > this.mediumIndex) return this.clockEarned;
    if (this.index < this.mediumIndex || this.latch !== null) return false;
    return this.ceiling === null || this.ceiling.rung > this.index + 1;
  }

  /**
   * The clock is off — the sensor priced itself out, lost its context or was
   * turned off — or back on (null). A rung the clock earned goes back to
   * Medium on the next step: no clock is the rule as it was, for the rung as
   * well as the climb.
   */
  setClockOff(reason: string | null): void {
    this.clockOffReason = reason;
    if (reason !== null) this.clockRing.clear();
  }

  /**
   * The sensor's duty moved: readings taken at the old duty are dropped and the
   * windows fill again from the new one. A rung the clock earned is re-earned
   * from them, inside a verification already standing if there is one.
   */
  clearClockEvidence(nowMs: number): void {
    this.clearClockRing(nowMs);
    this.clockAcquiredAtMs = null;
    this.reopenClockVerify();
  }

  private clearClockRing(nowMs: number): void {
    this.clockRing.clear();
    this.clockSinceMs = nowMs;
    this.panicStreak = 0;
    this.activeSinceReadingMs = 0;
  }

  private resetClockEvidence(nowMs: number): void {
    this.generationCount++;
    this.clearClockRing(nowMs);
    this.delivery.clear();
    this.clockAcquiredAtMs = null;
  }

  /** The rung is above Medium because the clock earned it, and the tick is
   *  still blind: the clock's rules hold it. */
  private clockHolds(): boolean {
    return this.clockEarned && this.index > this.mediumIndex && !this.aboveAllowed;
  }

  /**
   * After an evidence reset: a rung the clock earned must be earned again,
   * from readings drawn after the settle. A verification already standing
   * keeps its kind and its deadline — a second reset or a duty change never
   * buys it more time. Anywhere else there is nothing the clock holds.
   */
  private reopenClockVerify(): void {
    if (!this.clockHolds()) {
      this.clockVerify = null;
      this.clockEarned = false;
      return;
    }
    const standing = this.clockVerify;
    this.clockVerify = {
      kind: standing?.kind ?? 'reset',
      fromIndex: standing?.fromIndex ?? this.mediumIndex,
      belowMedianMs: standing?.belowMedianMs ?? null,
      startMs: this.settleUntilMs,
      deadlineMs: standing?.deadlineMs ?? null,
    };
  }

  /** `because` is 0 for a counted interval, else why it did not count. */
  private recordVerdict(drawSeq: number, because: number): void {
    this.verdictSeq[this.verdictHead] = drawSeq;
    this.verdictBecause[this.verdictHead] = because;
    this.verdictHead = (this.verdictHead + 1) % VERDICT_RING_SIZE;
  }

  /** A GPU reading, admitted only with its own frame's counted interval. */
  private admitGpu(obs: GpuObservation): void {
    if (this.idle || this.aboveAllowed || this.clockOffReason !== null) {
      this.clockDropped.notSteering++;
      return;
    }
    if (obs.generation !== this.generationCount) {
      this.clockDropped.stale++;
      return;
    }
    if (obs.sampledAtMs < this.settleUntilMs || obs.sampledAtMs < this.clockSinceMs) {
      this.clockDropped.settling++;
      return;
    }
    let because = -1;
    for (let i = 0; i < VERDICT_RING_SIZE; i++) {
      if (this.verdictSeq[i] === obs.drawSeq) {
        because = this.verdictBecause[i];
        break;
      }
    }
    if (because === -1) {
      this.clockDropped.unpaired++;
      return;
    }
    if (because !== 0) {
      this.clockDropped.uncounted++;
      const by = this.clockUncountedBy;
      if (because === 1) by.ineligible++;
      else if (because === 2) by.settling++;
      else if (because === 3) by.worked++;
      else if (because === 4) by.mainThread++;
      else by.sensor++;
      return;
    }
    this.clockRing.push(obs.sampledAtMs, obs.readingMs, obs.busyMs, obs.starved);
    this.clockAccepted++;
    this.activeSinceReadingMs = 0;
    if (!obs.starved) this.panicStreak = obs.readingMs > this.budgetMs ? this.panicStreak + 1 : 0;
  }

  /** Every eligible step's interval, for the delivery guard, and the active
   *  drawing time since the clock last had a reading. */
  private recordDelivery(sample: IntervalSample, settled: boolean): void {
    if (this.idle || !sample.eligible) return;
    this.activeSinceReadingMs += sample.intervalMs;
    if (settled) this.delivery.push(sample.nowMs, sample.intervalMs);
  }

  private noteClock(atMs: number, to: number, why: ClockWhy): void {
    this.clockLast = { atMs, from: this.index, to, why };
  }

  /** A measured failure at a rung the clock earned: the probe's treatment
   *  whether or not the probation still stands, so a device that heats slowly
   *  cannot earn, throttle, recover and repeat without the escalation adding
   *  up. `to` is one rung down, or Medium for the delivery guard. */
  private clockFail(nowMs: number, to: number, why: ClockWhy): Decision {
    this.noteClock(nowMs, to, why);
    this.failProbe(nowMs);
    return this.emit(to, 'revert');
  }

  /** Straight back to Medium with no ceiling: the clock cannot vouch for the
   *  rung, which is not the rung failing. A lifecycle reset that was not
   *  re-earned leaves the wait as it was; a clock that went quiet in steady
   *  state doubles it, so a clock that keeps going quiet cannot take the
   *  picture up and down every few seconds — each change is a visible one. */
  private clockRestore(nowMs: number, why: ClockWhy): Decision {
    this.noteClock(nowMs, this.mediumIndex, why);
    this.clockVerify = null;
    if (why === 'silent' || why === 'gap' || why === 'starved') {
      this.probeWait = Math.min(PROBE_WAIT_MAX_MS, this.probeWait * 2);
    }
    return this.emit(this.mediumIndex, 'restore');
  }

  /**
   * A rung the clock earned, judged by the clock on an eligible step: off,
   * panic, the delivery guard, the standing verification, silence, then the
   * hand-back window. Null means nothing to do here.
   */
  private clockHeldDecision(nowMs: number): Decision | null {
    if (this.clockOffReason !== null) return this.clockRestore(nowMs, 'off');
    const bar = this.budgetMs;
    const verify = this.clockVerify;
    if (this.panicStreak >= CLOCK_PANIC_COUNT) {
      return this.clockFail(nowMs, verify?.kind === 'probe' ? verify.fromIndex : this.index - 1, 'panic');
    }
    // Every frame that was drawn, slow for whatever reason: the pixels may be
    // kept only while the screen's rate really holds.
    const delivered = this.delivery.mean(nowMs, CLOCK_DELIVERY_SPAN_MS);
    if (delivered !== null && delivered > CLOCK_DELIVERY_GUARD * bar) {
      return this.clockFail(nowMs, this.mediumIndex, 'delivery');
    }
    const quiet = this.activeSinceReadingMs > CLOCK_GAP_MS;
    if (verify !== null) {
      if (verify.deadlineMs === null) return null;
      const got = this.clockRing.since(verify.startMs);
      if (got.count >= CLOCK_VERIFY_COUNT) {
        this.clockVerify = null;
        const trimmed = got.trimmedMeanMs ?? Infinity;
        if (trimmed > CLOCK_DOWN_SHARE * bar) {
          if (verify.kind === 'reset') return this.clockRestore(nowMs, 'verify');
          return this.clockFail(nowMs, verify.fromIndex, 'verify');
        }
        if (verify.kind === 'probe' && verify.belowMedianMs !== null && got.medianMs !== null
          && isReversal(verify.belowMedianMs, got.medianMs)) {
          // More pixels read as markedly less time. Once can be the scene
          // changing; again and the fence is not timing this frame's work.
          this.clockReversals++;
          if (this.clockReversals >= REVERSAL_REPEATS) {
            this.clockOffReason = `the clock read the sharper rung more than ${REVERSAL_MS} ms faster than the rung below, ${this.clockReversals} times`;
            return this.clockRestore(nowMs, 'reversal');
          }
        }
        this.clockAcquiredAtMs = nowMs;
        return null;
      }
      const bad = got.starved + got.capped;
      if (verify.kind === 'probe' && bad >= CLOCK_PROBE_BAD_MIN
        && (bad / (got.count + got.starved)) > STARVED_SHARE_MAX) {
        // Starved or capped readings repeating through the probe: the probe
        // failing, not merely silent.
        return this.clockFail(nowMs, verify.fromIndex, 'unverified');
      }
      if (nowMs < verify.deadlineMs && !quiet) return null;
      this.clockVerify = null;
      if (verify.kind === 'reset') return this.clockRestore(nowMs, 'unverified');
      this.noteClock(nowMs, verify.fromIndex, 'unverified');
      return this.emit(verify.fromIndex, 'revert');
    }
    if (quiet) return this.clockRestore(nowMs, 'gap');
    if (this.clockAcquiredAtMs !== null && nowMs - this.clockAcquiredAtMs >= CLOCK_SILENCE_SPAN_MS
      && this.clockRing.since(nowMs - CLOCK_SILENCE_SPAN_MS).count < CLOCK_DOWN_COUNT) {
      return this.clockRestore(nowMs, 'silent');
    }
    const starved = this.clockRing.starvedShare(CLOCK_STARVED_WINDOW, CLOCK_STARVED_MIN, nowMs - STALENESS_MS);
    if (starved !== null && starved > STARVED_SHARE_MAX) return this.clockRestore(nowMs, 'starved');
    const w = this.clockRing.window(CLOCK_DOWN_COUNT, CLOCK_DOWN_SPAN_MS, nowMs - STALENESS_MS, 0.9);
    if (w !== null && w.value > CLOCK_DOWN_SHARE * bar) return this.clockFail(nowMs, this.index - 1, 'hand-back');
    return null;
  }

  /**
   * A climb above Medium by the clock, one rung, where the tick is blind. It
   * needs what an interval climb needs that still means something here, a
   * delivered rate that really holds, and a clock window whose predicted p90
   * at the next rung fits the share.
   */
  private clockUpDecision(nowMs: number, next: number): Decision | null {
    if (this.clockOffReason !== null || this.latch !== null || this.clockVerify !== null) return null;
    // A rung above Medium the clock did not earn is not the clock's to build on.
    if (this.index > this.mediumIndex && !this.clockEarned) return null;
    if (this.ceiling !== null && next >= this.ceiling.rung) return null;
    if (nowMs - this.lastChangeMs < this.probeWait) return null;
    // The frames are not already late: the counted intervals over a whole up
    // window inside their up bar — a device capped from outside the app would
    // otherwise climb on an idle-looking GPU while its frames were missing —
    // and every frame drawn, untrimmed and unfiltered, at the screen's rate.
    const stat = this.window.trimmedMean(this.upCounted, TRIM_COUNT, nowMs - STALENESS_MS);
    if (stat === null || stat.count < this.upCounted) return null;
    if (stat.meanMs > UP_FACTOR * this.budgetMs) return null;
    const delivered = this.delivery.mean(nowMs, CLOCK_DELIVERY_SPAN_MS);
    if (delivered === null || delivered > CLOCK_DELIVERY_UP * this.budgetMs) return null;
    const starved = this.clockRing.starvedShare(CLOCK_STARVED_WINDOW, CLOCK_STARVED_MIN, nowMs - STALENESS_MS);
    if (starved !== null && starved > STARVED_SHARE_MAX) return null;
    const from = this.rungs[this.index];
    const to = this.rungs[next];
    const w = this.clockRing.window(
      CLOCK_UP_COUNT, CLOCK_UP_SPAN_MS, nowMs - STALENESS_MS, 0.9,
      (reading, busy) => predictReadingMs(busy, reading, from, to),
    );
    if (w === null || w.starvedShare > STARVED_SHARE_MAX) return null;
    if (w.value > CLOCK_UP_SHARE * this.budgetMs) return null;
    this.noteClock(nowMs, next, 'climb');
    const decision = this.emit(next, 'up');
    this.pendingClimb = { belowMedianMs: w.medianMs };
    return decision;
  }

  private clockState(): ClockState {
    const horizon = this.clockMs - STALENESS_MS;
    const got = this.clockRing.since(horizon);
    const next = this.index + 1;
    let predictedNextMs: number | null = null;
    if (next < this.rungs.length && next > this.mediumIndex) {
      const from = this.rungs[this.index];
      const to = this.rungs[next];
      const p = this.clockRing.window(
        CLOCK_UP_COUNT, CLOCK_UP_SPAN_MS, horizon, 0.9,
        (reading, busy) => predictReadingMs(busy, reading, from, to),
      );
      predictedNextMs = p?.value ?? null;
    }
    const verify = this.clockVerify;
    return {
      steering: !this.idle && !this.aboveAllowed && this.mediumIndex < this.rungs.length - 1 && this.clockOffReason === null,
      earned: this.clockHolds(),
      off: this.clockOffReason,
      generation: this.generationCount,
      counted: got.count,
      starvedShare: this.clockRing.starvedShare(CLOCK_STARVED_WINDOW, CLOCK_STARVED_MIN, horizon),
      medianMs: got.medianMs,
      p90Ms: got.p90Ms,
      barMs: this.budgetMs,
      predictedNextMs,
      deliveredMs: this.delivery.mean(this.clockMs, CLOCK_DELIVERY_SPAN_MS),
      verify: verify === null ? null : {
        kind: verify.kind,
        readings: this.clockRing.since(verify.startMs).count,
        deadlineMs: verify.deadlineMs,
      },
      panicStreak: this.panicStreak,
      reversals: this.clockReversals,
      accepted: this.clockAccepted,
      dropped: { ...this.clockDropped },
      uncountedBy: { ...this.clockUncountedBy },
      last: this.clockLast === null ? null : { ...this.clockLast },
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
    this.pendingClimb = null;
    this.pending = { to: clampIndex(to, this.rungs.length), reason };
    return this.pending;
  }

  /** What a frame at this rung is held to: the display's own tick above
   *  Medium, the budget at and below it (the header). */
  private budgetAt(index: number): number {
    return index > this.mediumIndex ? this.aboveBudgetMs : this.budgetMs;
  }

  /** The bar a window has to clear to probe up to `next`. */
  private upThresholdMs(next: number): number {
    return UP_FACTOR * this.budgetAt(next);
  }

  /** The reading that undoes a probe: a genuinely over-budget second at the
   *  rung being verified. */
  private verifyThresholdMs(): number {
    return DOWN_FACTOR * this.budgetAt(this.index);
  }

  private finishVerification(nowMs: number): Decision | null {
    this.verifyUntilMs = null;
    const stat = this.window.trimmedMean(this.upCounted, VERIFY_TRIM_COUNT, nowMs - STALENESS_MS);
    if (stat === null || stat.count < VERIFY_MIN_COUNTED) return null;
    if (stat.meanMs > this.verifyThresholdMs()) {
      this.failProbe(nowMs);
      return this.emit(this.verifyFromIndex, 'revert');
    }
    // Through the second: the probe stands, and is judged again by its
    // probation. Nothing is reset here — a rung that passes this second and
    // is handed back a minute later has failed, and its count must say so.
    return null;
  }

  /** The probe at the current rung failed — its verification second was over
   *  budget, or a down decision came inside its probation: the wait doubles
   *  and the rung is held as a ceiling. Again at the same rung, with nothing
   *  in between that cleared the evidence, the hold escalates, a minute to
   *  four to sixteen to the session; a different rung starts its own count. */
  private failProbe(nowMs: number): void {
    this.probeWait = Math.min(PROBE_WAIT_MAX_MS, this.probeWait * 2);
    this.ceilingFailures = this.lastFailedProbeRung === this.index ? this.ceilingFailures + 1 : 0;
    const hold = CEILING_HOLD_MS[Math.min(this.ceilingFailures, CEILING_HOLD_MS.length - 1)];
    this.ceiling = { rung: this.index, untilMs: nowMs + hold, escalation: this.ceilingFailures + 1 };
    this.lastFailedProbeRung = this.index;
    this.probation = null;
    this.probationByClock = false;
  }

  private downDecision(nowMs: number): Decision | null {
    if (this.index <= 0 || this.latch !== null) return null;
    if (nowMs - this.lastChangeMs < DOWN_SPACING_MS) return null;
    const stat = this.window.trimmedMean(this.downCounted, TRIM_COUNT, nowMs - STALENESS_MS);
    if (stat === null || stat.count < this.downCounted) return null;
    // A rung the clock earned is held to a tighter bar than the tick's: a
    // phone at 52–58 fps at a sharper rung is what the clock must not buy.
    const earned = this.clockHolds();
    // A full window inside this rung's bar: it holds. Above Medium the bar is
    // the display's own tick, so a sharper rung that has lost the screen's
    // full rate is handed back — to Medium at most, never past it for that.
    const bar = earned ? CLOCK_INTERVAL_DOWN * this.budgetMs : DOWN_FACTOR * this.budgetAt(this.index);
    if (stat.meanMs <= bar) return null;
    // At a rung the clock earned this is a measured failure, inside the
    // probation or out of it; and the floor's references, interval evidence
    // about a slide from Medium, are not touched.
    if (earned) return this.clockFail(nowMs, this.index - 1, 'intervals');
    // Handed back inside its probation: the probe that reached this rung has
    // failed, and the step is its revert rather than a slide.
    if (this.probation !== null && this.probation.rung === this.index && nowMs < this.probation.untilMs) {
      this.failProbe(nowMs);
      return this.emit(this.index - 1, 'revert');
    }
    // The mean at medium is what the floor will have to beat. Only a slide
    // that starts at medium can be judged that way; one that starts lower
    // (after a ladder change) leaves the reference unset and the floor check
    // silent.
    if (this.index === this.mediumIndex) this.floorReference = stat.meanMs;
    // And the rung above the floor as it last read, for a device that got
    // slower while the slide was under way.
    this.stepReference = stat.meanMs;
    return this.emit(this.index - 1, 'down');
  }

  /** At the floor: did the pixels the slide gave up buy anything? */
  private floorDecision(nowMs: number): Decision | null {
    if (this.latch !== null || this.floorReference === null || this.index === this.mediumIndex) return null;
    const stat = this.window.trimmedMean(this.downCounted, TRIM_COUNT, nowMs - STALENESS_MS);
    if (stat === null || stat.count < this.downCounted) return null;
    // The floor is held to the slower of the two readings it can beat: Medium
    // as it read when the slide began, or the rung just above as it read last.
    // A chip that stepped down mid-slide leaves Medium's reading stale — a
    // phone at Earth's shell read Medium at 17 ms as the throttle hit, the
    // rung above the floor at 41 and the floor at 33, and against the 17 the
    // floor looked like a loss while Medium itself was by then at 46.
    const reference = Math.max(this.floorReference, this.stepReference ?? 0);
    // Answered either way: a fresh slide from medium sets a fresh reference.
    this.floorReference = null;
    this.stepReference = null;
    if (stat.meanMs <= reference * (1 - FLOOR_LATCH_MIN_GAIN)) return null;
    const hold = LATCH_HOLD_MS[Math.min(this.latchFailures, LATCH_HOLD_MS.length - 1)];
    this.latchFailures++;
    this.latch = { untilMs: nowMs + hold, escalation: this.latchFailures };
    return this.emit(this.mediumIndex, 'floor latch');
  }

  private upDecision(nowMs: number): Decision | null {
    const next = this.index + 1;
    if (next >= this.rungs.length) return null;
    // A rung above Medium is taken by the intervals only where the display
    // has a tick fine enough to measure it against (the header); where it has
    // none, only the GPU clock can take one.
    if (next > this.mediumIndex && !this.aboveAllowed) return this.clockUpDecision(nowMs, next);
    if (this.ceiling !== null && next >= this.ceiling.rung) return null;
    if (nowMs - this.lastChangeMs < this.probeWait) return null;
    const stat = this.window.trimmedMean(this.upCounted, TRIM_COUNT, nowMs - STALENESS_MS);
    if (stat === null || stat.count < this.upCounted) return null;
    if (stat.meanMs > this.upThresholdMs(next)) return null;
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
