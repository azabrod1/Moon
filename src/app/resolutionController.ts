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
 * be assembled out of evidence from half a minute ago. At the Screen default
 * the budget is 16.67 ms and the down window 360 intervals on every display, a
 * 120 Hz one included; only the 120 fps row makes it 720. At the longest
 * window and a 55 % counted rate the span is 18.2 s against the 20 s horizon,
 * which is the margin the shorter windows had at 15 s. A streaming descent
 * over Earth does sliced work on many frames in a row; with a share-of-frames
 * gate the controller would go silent in both directions during exactly the
 * long hot flight the phone requirement is about, where with counted windows
 * the evidence merely accumulates more slowly.
 *
 * **A down window is also complete by its span.** The count assumes counted
 * intervals arrive near the budget's rate. A device delivering far below the
 * tick (15 fps at Medium, or 30 fps with every other frame doing sliced work)
 * counts fewer than 18 a second, never holds 360 inside the horizon, and so
 * would never step down, though it is the device Dynamic exists for. So a down
 * window is complete at its count OR once its counted intervals span
 * `DOWN_SPAN_FALLBACK_MS` (18 s) and number at least `DOWN_MIN_COUNT` (24:
 * three trimmed, twenty-one averaged), all inside the horizon. Eighteen
 * seconds is where the count already ends at 20 counted intervals a second, so
 * the two join without a jump and nothing changes at that rate or above:
 * 30 fps still steps at 12 s and a hot phone at 41 ms at 14.8 s, where 15, 10
 * and 5 fps now step at about 18 s and 1 fps never does (the horizon holds 21
 * of its intervals). The span is ELIGIBLE time, not wall time: a running total
 * of every interval both of whose endpoints were eligible, counted or
 * excluded, so a stretch that was not (hidden with no focus event, covered,
 * pinned) is never read as evidence, whatever event did or did not follow it.
 * The floor judgement reads the same completeness, and so does the down window
 * at a rung the clock earned, whose tighter bar is unchanged and which, at 20
 * counted intervals a second or more, completes exactly when it did. The up
 * path stays count-based: a thin stream that meets the up bar is a fast device
 * whose work is still landing, not a slow one. The limit of both
 * rules: a phone whose main-thread ticks exceed ten milliseconds has every
 * over-budget interval excluded, counts nothing, and is reached by neither.
 *
 * **A rung change drops the window outright**, because the evidence describes
 * the configuration it was measured in. So a second down-step needs a window
 * of its own rather than firing two seconds later on the first step's
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
 * that never moves. A mode switch is the same kind of break: a tool draws
 * another scene through another composer, so the frames under the switch's
 * own veil do not count, and the switch ends with a `mode` event that drops
 * the window, the clock's evidence and the still view the way an arrival does
 * — or three seconds of slow frames before Look inside would join a healthy
 * return and step the picture down and back up again.
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
 * readings never enter a statistic; capped ones count as over the bar. A
 * frame that was eligible and settled but whose interval did not count (its
 * sliced work, its main thread, the sensor) keeps its reading out of every
 * statistic too, but not out of the failure evidence: a starved or capped
 * reading of it counts toward the starved share and a probe's failures, and a
 * capped or over-bar one toward the panic streak — none of them is silence,
 * since each is the clock speaking — an engine
 * that blocks in submission under GPU backpressure makes exactly the frames
 * whose fences are capped the frames whose main thread is too busy to count.
 *
 * A clock climb is one rung, and needs everything an interval climb needs
 * that still means something on a blind tick — the probe wait, no ceiling on
 * the rung, the up window of intervals within its bar (the frames are not
 * already late: a device capped from outside the app would otherwise climb
 * on an idle-looking GPU), no not-pixel-bound latch — plus a clock window of
 * at least `CLOCK_UP_COUNT` trusted readings spanning `CLOCK_UP_SPAN_MS`, a
 * starved share within bounds, a delivered rate that holds, and the p90 of
 * the next rung's predicted readings inside `CLOCK_UP_SHARE` of the budget.
 * The p90 and not the median: under motion a median can read ample room
 * while nearly half the frames sit at the deadline. The prediction grows each
 * reading's GPU part by r^1.5 until the device has shown its own growth
 * (app/gpuFrameClockPolicy.ts), and while it has not, a climb the prediction
 * refuses may be tried on the rung's own readings — their p90 inside
 * `CALIBRATION_SHARE` of the budget, every other gate the same, verified and
 * failed like any probe — so a rung that reads well under load is ready to
 * try the next. The growth is learned when a climb's verification passes and
 * only where the two rungs can be shown to be of one view: the rung below's
 * whole window and every frame to the verdict under one name, with no sliced
 * work and no reset but the climb (the reversal check's own test, below). A
 * growth below 1 is thrown away as the scene getting cheaper. It is kept as an
 * exponent on the rungs' ratio, held between 0 and 2, so it carries from one
 * step of the ladder to another; the latest one learned wins. A climb
 * predicted with it that then fails its verification drops it when it was
 * below the guess of 1.5 — the more hopeful of the two — and the guess and
 * the tries on the rung's own reading come back; one at or above the guess is
 * kept, as it was already the more cautious. Only that climb can drop it: any
 * other move, or any verification passing, ends its trial. An arrival keeps
 * it; a new budget or ladder drops it. A ladder recomputed unchanged — every
 * resize of the window does that — is the same epoch: the growth, the
 * failure count below, the rungs marked unverified or silent and a ceiling
 * above Medium all stand.
 *
 * A rung the clock earned is kept only while the clock vouches for it. Right
 * after the climb, and again after ANY evidence reset while it stands (a rung
 * change, an arrival, a resize, a focus gain, a pin lifted, a budget or a
 * ladder, and the end of a stretch the clock could not sample — the System
 * Map, a DEV measurement), `CLOCK_VERIFY_COUNT` fresh readings must arrive
 * within `CLOCK_VERIFY_MS` and pass — their mean with the longest dropped inside
 * `CLOCK_DOWN_SHARE` of the budget. Through a verification the sensor
 * samples one frame in four whatever its priced duty, so the readings arrive
 * in about half a second at 60 fps; its three seconds start at the first
 * frame the clock can sample, and a stretch it cannot — a hidden page, a
 * veil, the map — restarts them once when it ends. A probe that fails that is the probe
 * failing (a revert, the wait doubled, the ceiling's escalation), and so are
 * starved or capped readings repeating through it; a probe whose readings do
 * not arrive in time is silence rather than a measured failure — a revert
 * with the wait doubled, and a second in a row at the same rung holds that
 * rung as a ceiling, so a rung that can never be verified is not probed every
 * ten seconds for the session. The starved or capped share through a probe is
 * judged once there are `CLOCK_STARVED_MIN` attempts, as the steady-state
 * share is: two starved readings among the first five are 40 % of a clock
 * whose share is a steady quarter. A reset that is not re-earned — its
 * readings too slow or too few, a panic, capped fences, the delivery guard
 * while it stands — is a plain restore to Medium, with no ceiling, no
 * failure counted and no longer wait, because a lifecycle event is not the
 * rung failing. The one exception is the delivery guard after a change of the
 * sensor's duty: that moved nothing on screen, the frames the guard reads are
 * the rung's own, and a slow stretch of them is a measured failure — until an
 * event reset inside that re-check moves the scene, which makes it a reset
 * like any other (the latest reset's cause decides). After that
 * the rung is handed back — one rung, never below Medium — by any of: the p90
 * of a window of at least `CLOCK_DOWN_COUNT` readings spanning
 * `CLOCK_DOWN_SPAN_MS` above `CLOCK_DOWN_SHARE` of the budget;
 * `CLOCK_PANIC_COUNT` readings in a row over the budget; or the intervals'
 * down window over `CLOCK_INTERVAL_DOWN` of the budget, a tighter bar than
 * the tick's, because a phone at 52–58 fps at a sharper rung is the
 * regression this rule exists to prevent — and straight to Medium when every
 * frame drawn over `CLOCK_DELIVERY_SPAN_MS`, bar the single longest, averages
 * slower than `CLOCK_DELIVERY_GUARD` of the budget: one stall is forgiven, a
 * slow stretch is not. The one left out is one interval with no cap on its
 * size, so a single freeze of several seconds is forgiven whole; a second
 * stall in the span is forgiven only while its excess fits the guard's 2 %
 * slack, like any late frame — below about 135 ms at 60 Hz — and the climb's
 * own 1.01 gate reads the same trimmed mean. Each of those is a measured failure,
 * inside the probation or out of it, and at a rung the clock earned the
 * failures are counted per evidence epoch — since the budget or the ladder
 * last changed — rather than per rung: with two rungs above Medium a heating
 * device fails at one and then at the other, and a count per rung starts over
 * at each. The first failure holds the failing rung as a ceiling for a
 * minute; from the second the ceiling sits on the first rung above Medium,
 * for four minutes, sixteen, then the session. The rung a hand-back lands on,
 * if still above Medium, is verified as a probe is — a revert the intervals'
 * own verification second makes as well as the clock's — so a failure there
 * escalates too; only a lifecycle reset gets the plain restore. And the clock
 * going quiet — no reading for six samples' worth of frames at the sensor's
 * duty (a second at the least), fewer than half the readings its duty would
 * take in the last six seconds (never fewer than eight nor more than the
 * sixteen a hand-back reads), starved readings over their share, or the
 * sensor off — returns the rung to Medium with no ceiling: no clock is the
 * rule as it was, applied to the rung as well as to the climb. From the
 * second such silence at the same rung in an epoch, every silence there holds
 * a ceiling with the failures' escalation, or a pose whose clock goes quiet
 * there and nowhere else would climb and restore for the rest of the session.
 *
 * Once a climb's verification has measured the sharper rung, a clock that read
 * it more than `REVERSAL_MS` LOWER than the rung below is suspect, and after
 * `REVERSAL_REPEATS` of them in a session it is not tracking the load and is
 * off for the session. But a true reading falls when the scene gets cheaper,
 * so the two rungs are compared only where they can be shown to have been read
 * in one still view: the caller names the view on every sample (`sceneKey` —
 * in the app, app/stillViewName.ts: the body the ship rides, the camera's aim
 * to within two degrees and the displayed field of view to within 2 %, and
 * no name at all while the ship is under way or the clock runs faster than a
 * minute a second), and the comparison is made only when every
 * reading of the rung below's window and every frame since came under one name
 * with no sliced work in any of them and no evidence reset but the climb
 * itself. Anything else skips the comparison and counts the skip: it proves
 * nothing either way, and a flight that really did reach a cheaper scene must
 * not take the clock away. None of the clock's decisions touch the floor's
 * references, which are interval evidence.
 *
 * **A rung the clock held is remembered for the next boot.** Earning each rung
 * again climb by climb costs a boot half a minute or more, and a rung the clock
 * verified and then held for `REMEMBER_HOLD_MS` — from the moment a
 * verification there passed, restarted by every evidence reset — is a fact
 * about the device. `memory` is the LAST such rung this epoch, not the
 * highest: the next boot resumes the pose this session ended in. A new budget
 * or ladder clears it; `memoryVersion` moves whenever it or `seedOutcome`
 * does, so the caller (app/rungMemory.ts keeps it) reads nothing per frame.
 * A boot that is told a rung through `remember` — once, only where the clock
 * steers, and only at Medium — may climb straight to it: the FIRST climb
 * from Medium, when every gate a clock climb needs holds except the
 * prediction, AND Medium's own p90 on this boot is inside `CALIBRATION_SHARE`
 * of the budget, is to the remembered rung, several rungs at once if it is
 * several above (`why: 'remembered'`, the one multi-rung step the rule
 * takes). The p90 is this boot's evidence that the room is there; a boot at a
 * pose where Medium reads heavier keeps the rung armed and climbs as it would
 * have. The remembered rung is used up by that climb, by any other change of
 * rung, and by a new budget or ladder, so it never fires mid-session after a
 * hand-back; one at or below the rung is used up with no decision. The climb
 * is verified exactly as a probe is — a `'probe'` verification marked
 * `seeded` — except that nothing is learned from it and nothing compared: a
 * step of several rungs says nothing about how one step grows. Every way out
 * of that check, the interval second included, is ONE treatment: back to
 * Medium, where every such climb starts, with no ceiling, no failure counted
 * and the wait as it was. A MEASURED failure — readings over the bar, capped
 * or starved ones repeating, a panic, the delivery guard, the intervals — ends
 * it 'dropped', which tells the caller to delete the memory; readings that did
 * not come (a stretch away, a tool, sliced work on every frame) or a clock
 * that went off measured nothing about the rung and end it 'abandoned', the
 * memory kept — a real overload reads as capped fences, and a page that dies
 * at the rung is the caller's trial mark to catch. Past
 * the check the rung is the clock's like any other, and it stays on trial
 * until it has been held for the minute ('passed'): a measured failure there
 * (a hand-back, a panic, the intervals, the delivery guard) takes the usual
 * treatment and drops the memory too, and so does a panic or readings over
 * the bar in the re-check a change of the sensor's duty opens — its plain
 * restore stands for the rung, but its frames are the rung's own and a heavy
 * rung is what prices the duty up, until an arrival or any other event reset
 * inside it moves the scene; a lifecycle restore, a pin, a level
 * change, a new budget or ladder, `forgetRemembered` (the canvas grew past
 * what the memory was held at), or any other move off the rung ends the
 * trial with no verdict ('abandoned') and the memory is kept. Where the tick
 * is finer, none of this runs: `remember` refuses and nothing is held.
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
  CALIBRATION_SHARE,
  CLOCK_DOWN_SHARE,
  CLOCK_EXPONENT,
  CLOCK_UP_SHARE,
  DUTY_START,
  DUTY_VERIFY,
  RefusalRest,
  REVERSAL_MS,
  REVERSAL_REPEATS,
  STARVED_SHARE_MAX,
  growthFor,
  isReversal,
  learnedExponent,
  predictWithGrowthMs,
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

/** A down window is also complete once its counted intervals span this much
 *  ELIGIBLE time, however few they are (down to `DOWN_MIN_COUNT`). The count
 *  alone assumes counted intervals arrive near the budget's rate, and a device
 *  delivering far below the tick — 15 fps at Medium, or 30 fps with every
 *  other frame doing sliced work — counts fewer than 18 a second, so it never
 *  holds 360 of them inside the staleness horizon and never steps down, though
 *  it is the device Dynamic exists for. Eighteen seconds is where the count
 *  already ends at 20 counted intervals a second (360 of them), so the two
 *  rules join without a jump and nothing changes at that rate or above. */
export const DOWN_SPAN_FALLBACK_MS = 18_000;

/** The fewest counted intervals a window completed by its span may hold:
 *  three trimmed, twenty-one averaged. Inside the 20 s horizon that admits
 *  a window down to about 1.15 counted intervals a second (the newest and
 *  23 more in 20 s), and it decides WHEN only between that and 1.33 (24 in
 *  18 s); nothing slower assembles. Below about 4 counted intervals a
 *  second the fixed trim of three is a large share of a short window and
 *  can read a reference 2–3 % low against a longer window at the floor —
 *  the size of `FLOOR_LATCH_MIN_GAIN` — a skew the floor judgement lives
 *  with rather than a reason to ask for more. And the limit of either rule:
 *  a phone whose main-thread ticks exceed 10 ms has every over-budget
 *  interval excluded, counts nothing, and is reached by neither. */
export const DOWN_MIN_COUNT = 24;

/** And behind an up probe: more evidence is asked for before taking pixels
 *  than before giving them back. */
export const UP_WINDOW_S = 10;

/** Counted intervals in a window of `seconds` at `budgetMs`. */
export function windowCounted(seconds: number, budgetMs: number): number {
  return Math.max(1, Math.round((seconds * 1000) / budgetMs));
}

/** Which rule completed a down window: its count, or its span. */
export type DownWindowBy = 'count' | 'span';

/** Whether a down window is complete, and by which rule: `count` once it holds
 *  the `counted` intervals six seconds come to at the budget, `span` once its
 *  intervals cover `DOWN_SPAN_FALLBACK_MS` of eligible time and number at
 *  least `DOWN_MIN_COUNT`; null while it is neither. The stat is the window as
 *  the ring assembled it, already cut at the staleness horizon. */
export function downWindowComplete(stat: { count: number; spanMs: number } | null, counted: number): DownWindowBy | null {
  if (stat === null) return null;
  if (stat.count >= counted) return 'count';
  if (stat.count >= DOWN_MIN_COUNT && stat.spanMs >= DOWN_SPAN_FALLBACK_MS) return 'span';
  return null;
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

/** Silence: active, visible drawing with no admissible reading for the
 *  longer of this and `CLOCK_GAP_SAMPLES` samples' worth of frames at the
 *  sensor's duty — a second, or 1.6 s at one frame in sixteen on a 60 Hz
 *  tick, so a sparse duty is not called silent for the frames it was never
 *  going to sample. Through a verification the sensor samples one frame in
 *  four whatever its duty (app/gpuFrameClockPolicy.ts), and the gap is judged
 *  at that duty. */
export const CLOCK_GAP_MIN_MS = 1000;
export const CLOCK_GAP_SAMPLES = 6;

/** The gap that is silence at a duty and a tick. */
export function clockGapMs(duty: number, tickMs: number): number {
  return Math.max(CLOCK_GAP_MIN_MS, CLOCK_GAP_SAMPLES * duty * tickMs);
}

/** Silence, too, once the clock's evidence is this old: fewer trusted
 *  readings in the preceding span this long than `clockSilenceCount` asks. */
export const CLOCK_SILENCE_SPAN_MS = 6000;

/** The share of the readings the sensor's duty would take in that span that
 *  must have been trusted, and the fewest ever asked for. A fixed count
 *  would not follow the duty: at one frame in sixteen on a 60 Hz tick only
 *  about 22 samples are taken in six seconds, so sixteen of them would ask
 *  71 % to be admissible, and at a pose where streaming keeps a share of
 *  the sampled frames from counting the rung would be restored to Medium
 *  every minute while readings kept arriving. */
export const CLOCK_SILENCE_SHARE = 0.5;
export const CLOCK_SILENCE_MIN_COUNT = 8;

/** Trusted readings the silence span needs at a duty and a tick: half the
 *  samples the duty takes, between `CLOCK_SILENCE_MIN_COUNT` and the
 *  hand-back window's `CLOCK_DOWN_COUNT` — a dense duty is not asked for more
 *  than a hand-back reads. */
export function clockSilenceCount(duty: number, tickMs: number): number {
  const expected = CLOCK_SILENCE_SPAN_MS / (Math.max(1, duty) * tickMs);
  return Math.min(CLOCK_DOWN_COUNT, Math.max(CLOCK_SILENCE_MIN_COUNT, Math.round(CLOCK_SILENCE_SHARE * expected)));
}

/** Every frame drawn, unfiltered — streaming, main-thread and sensor
 *  overruns and the settle after a change included, only the page away,
 *  covered or pinned and the map left out — over this span: its mean must be
 *  within `CLOCK_DELIVERY_UP` of the budget for a clock climb, and a rung the
 *  clock earned goes back to Medium when it passes `CLOCK_DELIVERY_GUARD`.
 *  58 fps is 17.24 ms, which a trimmed mean of counted intervals against
 *  1.05 × the budget would let through; permission to KEEP extra pixels is
 *  not a question about what the pixels cost. The mean drops ONE interval,
 *  the longest, and never more: one stall — a reallocation under `?alloc=0`,
 *  a hitch of the browser's own — is forgiven, where a second inside the span,
 *  or a stretch of late frames however short each is, is not. (One stall
 *  counted alone moves six seconds of frames by its excess over 360: a
 *  150 ms reallocation after a climb would put the mean at 17.04 ms and hand
 *  the rung straight back for its own move.) A climb or a revert does not
 *  restart the span, so a sharper rung is judged from its first late frames
 *  and an excursion shorter than the span cannot escape it. */
export const CLOCK_DELIVERY_SPAN_MS = 6000;
export const CLOCK_DELIVERY_UP = 1.01;
export const CLOCK_DELIVERY_GUARD = 1.02;

/** How long a rung the clock earned has to hold, from the verification that
 *  passed there and with no evidence reset since, before it is remembered for
 *  the next boot; and how long a remembered rung stays on trial. */
export const REMEMBER_HOLD_MS = 60_000;

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
   *  boot cover, an arrival veil or a mode switch's own veil. */
  eligible: boolean;
  /** The draw that produced the interval, so a GPU reading of that draw can
   *  be paired with this verdict when it arrives. */
  drawSeq?: number;
  /** A GPU reading that finished since the last step: of this sample's draw,
   *  or of an earlier one whose reading came in late. Admitted only if that
   *  draw's interval counted. */
  gpu?: GpuObservation | null;
  /** The GPU clock cannot sample this frame for a reason that is not the
   *  frame's cost: the System Map is drawn instead of the scene, or a DEV
   *  measurement holds the GPU. The clock's rules pause as they do for a
   *  hidden page — no silence accrues, nothing is handed back or climbed by
   *  the clock — and a rung it earned is re-earned when the stretch ends. The
   *  interval still counts or not exactly as it would without this. */
  clockSuspended?: boolean;
  /** What the frame's view was of, as the caller can name it: a number that
   *  stays the same while the view does, or null while it cannot be named —
   *  the ship under way, a fast clock. Left out, no view is ever named. Two
   *  clock readings seconds apart are compared for a reversal only under one
   *  name (the header). */
  sceneKey?: number | null;
  /** The GPU clock's own main-thread work inside the interval — its fence,
   *  its flushes and its poll tasks — that ran after the next frame was due:
   *  the only part of it that can have held the next callback back. An
   *  over-budget interval this work explains was made late by the sensor, not
   *  by the pixels, and does not count — which only an interval that is not
   *  quantised to a display tick can show: under vsync a late frame is a whole
   *  tick late, and the sensor's work would have to be that long to explain
   *  it. Never part of the main-thread figures. */
  sensorMs?: number;
}

/** Why a rung is being changed. */
export type StepReason = 'down' | 'up' | 'revert' | 'floor latch' | 'ladder' | 'restore';

/** A rung change the controller made, as the readout reports the last one.
 *  `windowBy` is the rule that completed the down window the step was decided
 *  on, and null for a step no down window decided. */
export interface StepRecord {
  atMs: number;
  from: number;
  to: number;
  reason: StepReason;
  windowBy: DownWindowBy | null;
}

/** Why the clock moved a rung, for the readout. */
export type ClockWhy =
  | 'calibrate' | 'climb' | 'verify' | 'unverified' | 'panic' | 'delivery' | 'hand-back' | 'intervals'
  | 'silent' | 'gap' | 'starved' | 'off' | 'reversal' | 'remembered';

/** What became of the rung a boot was told through `remember`: armed and not
 *  yet used; climbed to; held for `REMEMBER_HOLD_MS`; failed by measurement
 *  before that (the memory is to be deleted); or ended with no verdict — used
 *  up without a climb, or its trial cut short by something that is not the
 *  rung failing. */
export type SeedOutcome = 'armed' | 'applied' | 'passed' | 'dropped' | 'abandoned';

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
  /** Every frame drawn over the delivery span but the longest, or null before
   *  the span has been drawn. */
  deliveredMs: number | null;
  /** A verification standing: a probe's, or a reset's re-earning, with its
   *  deadline once the first eligible frame after it has started it. */
  verify: { kind: 'probe' | 'reset'; seeded: boolean; readings: number; deadlineMs: number | null } | null;
  /** The sensor's duty as it last told the controller, and the gap that is
   *  silence right now. */
  duty: number;
  gapMs: number;
  /** The trusted readings the last six seconds need, at that duty, before
   *  the clock is silent. */
  silenceCount: number;
  /** The rung whose last probe went unverified: a second in a row there holds
   *  it as a ceiling. */
  unverifiedRung: number | null;
  /** The rung a steady-state silence restored from this epoch: every silence
   *  there after the first holds a ceiling. */
  silentRung: number | null;
  /** Failures at rungs the clock earned since the budget or the ladder last
   *  changed: what its ceiling escalates on. */
  failures: number;
  /** At Medium, the sensor's rest after the predictor kept refusing: until
   *  when (null when not resting or never rested), the next rest's length and
   *  how many were taken. */
  rest: { untilMs: number | null; nextMs: number; rests: number };
  panicStreak: number;
  /** Climbs whose sharper rung read markedly faster than the rung below in
   *  the same still view. */
  reversals: number;
  /** Climbs whose two rungs were compared for that, and those that could not
   *  be, the view not shown to be the same. */
  reversalChecks: { made: number; skipped: number };
  /** How this device's frames grow with pixels, as the rule knows it: the
   *  last honest measurement as the ratio of the two rungs' GPU parts and as
   *  the exponent it is kept as (null before one), the factor the next climb
   *  predicts with — r to that exponent, or to the guessed 1.5 — and how many
   *  verified climbs taught it, could not (a view that was not one still
   *  view, or a growth below 1), and dropped it by failing. */
  growth: { measured: number | null; exponent: number | null; nextFactor: number | null; learned: number; skipped: number; dropped: number };
  /** No growth is held: a climb the prediction refuses may be tried on the
   *  rung's own readings. */
  calibrationOpen: boolean;
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
  /** The climb to a rung a previous boot held: the caller marks the memory on
   *  trial before it applies it. */
  seeded?: boolean;
}

/** What made the controller change its mind, or step out of the way. */
export type ControllerEvent = 'resize' | 'arrival' | 'mode' | 'focus' | 'boot' | 'pin' | 'unpin';

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
  /** The eligible time the down window's intervals cover, or null while there
   *  is too little to trim. */
  downSpanMs: number | null;
  /** Which rule has completed the down window — its count, or its span — or
   *  null while neither has. */
  downWindowBy: DownWindowBy | null;
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
  lastStep: StepRecord | null;
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
  /** The rung memory: the last rung the clock held for a minute this epoch
   *  (what the next boot is to be told), the rung this boot was told and has
   *  not used yet, and what became of it. */
  memory: { heldRatio: number | null; rememberedRatio: number | null; seed: SeedOutcome | null };
}

/** What a reading in the clock's ring is. A TRUSTED reading enters the
 *  statistics (a capped one as over the bar); a STARVED one never does; an
 *  EVIDENCE-only one — a capped fence from a frame whose interval did not
 *  count — never does either, but is a failure the probe and the silence
 *  rules must still hear about. */
const TRUSTED = 0;
const STARVED = 1;
const EVIDENCE = 2;

/**
 * The GPU clock's readings, newest first, with the windows the rule reads.
 * Allocation-light: the ring and its scratch are sized once.
 */
class ClockRing {
  private readonly atMs: Float64Array;
  private readonly readingMs: Float64Array;
  private readonly busyMs: Float64Array;
  private readonly kind: Uint8Array;
  private readonly scratch: Float64Array;
  private head = 0;
  private count = 0;

  constructor(readonly capacity: number) {
    this.atMs = new Float64Array(capacity);
    this.readingMs = new Float64Array(capacity);
    this.busyMs = new Float64Array(capacity);
    this.kind = new Uint8Array(capacity);
    this.scratch = new Float64Array(capacity);
  }

  push(atMs: number, readingMs: number, busyMs: number, kind: number): void {
    this.atMs[this.head] = atMs;
    this.readingMs[this.head] = readingMs;
    this.busyMs[this.head] = busyMs;
    this.kind[this.head] = kind;
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
  ): { value: number; medianMs: number; p90Ms: number; count: number; starvedShare: number; oldestAtMs: number } | null {
    let n = 0;
    let total = 0;
    let starved = 0;
    let newest = NaN;
    let oldest = NaN;
    let done = false;
    for (let i = 0; i < this.count; i++) {
      const k = this.at(i);
      const at = this.atMs[k];
      if (at < notBeforeMs) break;
      if (Number.isNaN(newest)) newest = at;
      total++;
      if (this.kind[k] !== TRUSTED) {
        if (this.kind[k] === STARVED) starved++;
        continue;
      }
      this.scratch[n++] = this.readingMs[k];
      oldest = at;
      if (n >= minCount && newest - at >= minSpanMs) { done = true; break; }
    }
    if (!done) return null;
    const medianMs = rank(this.scratch, n, 0.5);
    // Sorted by the rank above: the raw p90 is read off the same order.
    const p90Ms = this.scratch[Math.min(n - 1, Math.max(0, Math.ceil(0.9 * n) - 1))];
    if (predict !== null) {
      // Refill with the predicted quantity, over exactly the same readings.
      let m = 0;
      for (let i = 0; m < n && i < this.count; i++) {
        const k = this.at(i);
        if (this.kind[k] !== TRUSTED) continue;
        this.scratch[m++] = predict(this.readingMs[k], this.busyMs[k]);
      }
    }
    return {
      value: rank(this.scratch, n, quantile),
      medianMs,
      p90Ms,
      count: n,
      starvedShare: total === 0 ? 0 : starved / total,
      oldestAtMs: oldest,
    };
  }

  /** How the readings no older than `notBeforeMs` break down, without sorting
   *  anything: the trusted ones, the starved ones, the capped ones (trusted or
   *  evidence-only), and every one of them. */
  tally(notBeforeMs: number): { count: number; starved: number; capped: number; attempts: number } {
    let count = 0;
    let starved = 0;
    let capped = 0;
    let attempts = 0;
    for (let i = 0; i < this.count; i++) {
      const k = this.at(i);
      if (this.atMs[k] < notBeforeMs) break;
      attempts++;
      const kind = this.kind[k];
      if (kind === STARVED) { starved++; continue; }
      if (!Number.isFinite(this.readingMs[k])) capped++;
      if (kind === TRUSTED) count++;
    }
    return { count, starved, capped, attempts };
  }

  /** The trusted readings no older than `notBeforeMs`: their mean with the
   *  longest dropped, their median and their p90. */
  stats(notBeforeMs: number): { count: number; trimmedMeanMs: number | null; medianMs: number | null; p90Ms: number | null } {
    let n = 0;
    for (let i = 0; i < this.count; i++) {
      const k = this.at(i);
      if (this.atMs[k] < notBeforeMs) break;
      if (this.kind[k] === TRUSTED) this.scratch[n++] = this.readingMs[k];
    }
    if (n === 0) return { count: 0, trimmedMeanMs: null, medianMs: null, p90Ms: null };
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
    };
  }

  /** The median GPU part — reading less pre-submit time — of the trusted
   *  readings no older than `notBeforeMs`, or NaN with none. */
  gpuPartMedian(notBeforeMs: number): number {
    let n = 0;
    for (let i = 0; i < this.count; i++) {
      const k = this.at(i);
      if (this.atMs[k] < notBeforeMs) break;
      if (this.kind[k] !== TRUSTED) continue;
      const reading = this.readingMs[k];
      this.scratch[n++] = reading - Math.min(Math.max(0, this.busyMs[k]), reading);
    }
    return n === 0 ? NaN : rank(this.scratch, n, 0.5);
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
      if (this.kind[k] === STARVED) starved++;
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

  /** The mean interval over the last `spanMs` with the single longest left
   *  out, or null until that much has been drawn. One interval and never a
   *  class of them: every other late frame counts. */
  mean(nowMs: number, spanMs: number): number | null {
    if (this.count === 0 || !(nowMs - this.firstAtMs >= spanMs)) return null;
    let sum = 0;
    let n = 0;
    let longest = 0;
    for (let i = 0; i < this.count; i++) {
      const k = (this.head - 1 - i + this.capacity) % this.capacity;
      if (this.atMs[k] <= nowMs - spanMs) break;
      const ms = this.ms[k];
      sum += ms;
      n++;
      if (ms > longest) longest = ms;
    }
    if (n === 0) return null;
    return n === 1 ? sum : (sum - longest) / (n - 1);
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
  /** The controller's running total of eligible time as each interval was
   *  pushed, that interval included: every interval both of whose endpoints
   *  were eligible adds to it, counted or not, and nothing else does. Two of
   *  them apart are the eligible time between, so a window's span never reads
   *  across a stretch that was hidden, pinned or in another mode. */
  private readonly eligibleMs: Float64Array;
  private readonly top = new Float64Array(TRIM_COUNT);
  private head = 0;
  private count = 0;

  constructor(readonly capacity: number) {
    this.atMs = new Float64Array(capacity);
    this.ms = new Float64Array(capacity);
    this.busyMs = new Float64Array(capacity);
    this.eligibleMs = new Float64Array(capacity);
  }

  push(atMs: number, ms: number, busyMs: number, eligibleMs: number): void {
    this.atMs[this.head] = atMs;
    this.ms[this.head] = ms;
    this.busyMs[this.head] = busyMs;
    this.eligibleMs[this.head] = eligibleMs;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
  }

  /** Mean of the newest `maxSize` intervals no older than `notBeforeMs`, with
   *  the longest `trim` of them dropped. `count` is how many were in reach,
   *  so the caller can ask for a full window, and `spanMs` the eligible time
   *  they cover, from the start of the oldest to the end of the newest — 360
   *  intervals of 16.67 ms read 6000 — so it can ask for a long one. */
  trimmedMean(maxSize: number, trim: number, notBeforeMs: number): { meanMs: number; count: number; spanMs: number } | null {
    const drop = Math.min(trim, this.top.length);
    for (let i = 0; i < drop; i++) this.top[i] = -Infinity;
    let count = 0;
    let sum = 0;
    let oldest = -1;
    for (let i = 0; i < this.count && count < maxSize; i++) {
      const at = (this.head - 1 - i + this.capacity) % this.capacity;
      if (this.atMs[at] < notBeforeMs) break;
      const value = this.ms[at];
      oldest = at;
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
    const newest = (this.head - 1 + this.capacity) % this.capacity;
    const spanMs = this.eligibleMs[newest] - this.eligibleMs[oldest] + this.ms[oldest];
    return { meanMs: (sum - sumTop) / (count - dropped), count, spanMs };
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
  /** Every eligible interval added up, counted or not, for the span of a down
   *  window: a stretch hidden, pinned or in another mode adds nothing. */
  private eligibleMs = 0;

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
  private lastStep: StepRecord | null = null;

  private pending: Decision | null = null;
  /** The rule that completed the down window behind the pending decision, or
   *  null for a decision no down window made. */
  private pendingWindowBy: DownWindowBy | null = null;
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
   *  for the honesty rule — null where its window was not one still view —
   *  the still view it was taken in, the rung below's GPU part the growth is
   *  learned against, and whether the climb was predicted with a learned
   *  growth (which a failure of it may then drop). */
  private pendingClimb: { belowMedianMs: number | null; sceneStretch: number; belowGpuMs: number; byGrowth: boolean; seeded?: boolean } | null = null;
  /** The decision pending is a step down the clock made on its own evidence
   *  — a measured failure, or a probe it could not verify. */
  private pendingClockStep = false;
  /** A verification standing at a rung the clock earned. */
  private clockVerify: {
    kind: 'probe' | 'reset';
    fromIndex: number;
    belowMedianMs: number | null;
    /** For a climb's verification, the still view the rung below was read
     *  in; null for any other verification, which compares nothing. */
    sceneStretch: number | null;
    /** For a climb's verification, the median GPU part of the rung below's
     *  window, which the sharper rung's is set against to learn the growth;
     *  null for any other verification. */
    belowGpuMs: number | null;
    /** A reset opened by the sensor's duty changing rather than by anything
     *  that moved the scene: the frames the delivery guard reads are the
     *  rung's own, so a slow stretch there is a measured failure. */
    byDuty: boolean;
    /** Readings count from frames drawn at or after this. */
    startMs: number;
    /** Set by the first eligible step after it opened; moved at most once,
     *  after a stretch the clock could not sample. */
    deadlineMs: number | null;
    /** A stretch the clock could not sample fell after the deadline was set. */
    interrupted: boolean;
    /** The deadline has been restarted for one, and never will be again. */
    restarted: boolean;
    /** The check of a climb to a remembered rung: every way out of it is the
     *  one treatment the header gives it. */
    seeded?: boolean;
  } | null = null;
  /** The last step was one the clock could not sample for a reason that is
   *  not the frames' (the map, a DEV measurement). */
  private clockSuspendedLast = false;
  /** This step the clock can sample nothing: held, away, covered, or
   *  suspended. */
  private clockPausedNow = false;
  /** Trusted readings in a row over the budget. */
  private panicStreak = 0;
  /** The sensor's duty, which sets how long a gap between readings is
   *  silence. */
  private clockDuty = DUTY_START;
  /** The rung whose last clock probe went unverified, until a probe there
   *  passes or the budget or the ladder changes. */
  private unverifiedRung: number | null = null;
  /** Failures at rungs the clock earned since the budget or the ladder last
   *  changed, whatever rung each was at: what the clock's ceiling escalates
   *  on. */
  private clockFailures = 0;
  /** At Medium, whether the sensor is resting after the predictor kept
   *  refusing the climb (app/gpuFrameClockPolicy.ts). */
  private readonly refusal = new RefusalRest();
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
  /** The stretch of frames that were one named, still view with no sliced
   *  work and no evidence reset but a rung change: bumped whenever any of
   *  that breaks, with when the current one began and the name it is under.
   *  A reversal is judged only inside one stretch. */
  private sceneStretch = 0;
  private sceneStretchSinceMs = 0;
  private sceneKeyLast: number | null = null;
  private readonly reversalChecks = { made: 0, skipped: 0 };
  /** The exponent the latest honestly verified climb measured — the budget
   *  and the ladder as they are — with the ratio it came from, or null while
   *  none is held and a climb may be tried on the rung's own readings. An
   *  arrival keeps it. */
  private clockGrowthE: number | null = null;
  private clockGrowthMeasured: number | null = null;
  private readonly growthChecks = { learned: 0, skipped: 0, dropped: 0 };
  /** The rung being verified was climbed on a learned growth: failing the
   *  verification drops the growth. */
  private growthOnTrial = false;
  /** The rung a steady-state silence restored from, this epoch: every
   *  silence there after the first is a failure with a ceiling. */
  private silentRung: number | null = null;
  /** Recent frames' interval verdicts, for a late reading to find its own. */
  private readonly verdictSeq = new Float64Array(VERDICT_RING_SIZE).fill(-1);
  private readonly verdictBecause = new Uint8Array(VERDICT_RING_SIZE);
  private verdictHead = 0;
  private clockAccepted = 0;
  private readonly clockDropped = { unpaired: 0, uncounted: 0, stale: 0, settling: 0, notSteering: 0 };
  private readonly clockUncountedBy = { ineligible: 0, settling: 0, worked: 0, mainThread: 0, sensor: 0 };
  private clockLast: { atMs: number; from: number; to: number; why: ClockWhy } | null = null;

  // --- The remembered rung (the header) --------------------------------------
  /** The rung a previous boot held, armed for this boot's first climb from
   *  Medium; null once used, or never given. */
  private rememberedIndex: number | null = null;
  /** `remember` armed a rung this boot: a second call is ignored. */
  private rememberTaken = false;
  /** The rung the remembered climb reached, while its trial stands, and
   *  whether the clock has passed it there yet. */
  private seedRung: number | null = null;
  private seedClockChecked = false;
  private seedOutcomeNow: SeedOutcome | null = null;
  /** The last rung the clock earned and held for `REMEMBER_HOLD_MS` this
   *  epoch. */
  private heldMemory: { readonly ratio: number } | null = null;
  private memoryVersionCount = 0;

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
    if (!this.idle && sample.eligible) this.eligibleMs += sample.intervalMs;
    if (counted) {
      this.window.push(sample.nowMs, sample.intervalMs, sample.mainThreadSumMs ?? sample.mainThreadMs, this.eligibleMs);
      this.lastCountedMs = sample.nowMs;
    }
    if (sample.drawSeq !== undefined) this.recordVerdict(sample.drawSeq, because);
    if (sample.gpu) this.admitGpu(sample.gpu);
    this.noteScene(sample);
    const suspended = sample.clockSuspended === true;
    this.recordDelivery(sample, suspended);
    // The end of a stretch the clock could not sample: what it measured before
    // describes a scene it has not seen since, so its evidence starts again and
    // a rung it earned is re-earned.
    if (this.clockSuspendedLast && !suspended && !this.idle) {
      this.breakScene(sample.nowMs);
      this.resetClockEvidence(sample.nowMs);
      this.reopenClockVerify();
    }
    this.clockSuspendedLast = suspended;
    this.clockPausedNow = this.idle || !sample.eligible || suspended;
    this.timeClockVerify(sample.nowMs);
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
    // and the resumption re-earns it. Under the map or a DEV measurement the
    // clock is paused the same way, but the intervals still count, so their
    // own rules below go on.
    if (this.clockHolds()) {
      if (!sample.eligible) return null;
      if (!suspended) {
        const held = this.clockHeldDecision(sample.nowMs);
        if (held !== null) return held;
      }
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
    const clockStep = this.pendingClockStep;
    const windowBy = pending !== null ? this.pendingWindowBy : null;
    this.pendingClimb = null;
    this.pendingClockStep = false;
    this.pendingWindowBy = null;
    this.pending = null;
    if (pending !== null) this.index = clampIndex(pending.to, this.rungs.length);
    this.clockMs = nowMs;
    this.lastChangeMs = nowMs;
    this.settleUntilMs = nowMs + REALLOC_SETTLE_MS;
    this.window.clear();
    this.lastStep = { atMs: nowMs, from, to: this.index, reason: pending?.reason ?? 'ladder', windowBy };
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
    // The frames drawn before a rung change stay in the delivery guard's
    // span, so a sharper rung whose frames miss is seen from its first late
    // frames rather than after six seconds of its own — an excursion shorter
    // than the span would otherwise never be judged at all — and a revert
    // leaves the excursion's frames in reach of the next climb's gate. Only
    // a measured hand-back to a rung still above Medium starts the span
    // again: the frames that failed have been charged once already, to the
    // rung that drew them.
    this.resetClockEvidence(nowMs, !(clockStep && this.index > this.mediumIndex));
    // Only a probe the clock made keeps its failures past its probation.
    this.probationByClock = false;
    // On trial is only the rung a climb just reached on the learned growth:
    // any other move ends the trial, so only a climb that the growth itself
    // predicted can take the growth down with it.
    this.growthOnTrial = kind === 'up' && climb !== null && climb.byGrowth;
    if (kind === 'up' && climb !== null && this.index > this.mediumIndex) {
      // A clock probe: the clock verifies it, and the rung is the clock's.
      this.clockEarned = true;
      this.probationByClock = true;
      this.clockVerify = {
        kind: 'probe',
        fromIndex: from,
        belowMedianMs: climb.belowMedianMs,
        // A climb of several rungs to a remembered one compares nothing and
        // teaches nothing.
        sceneStretch: climb.seeded === true ? null : climb.sceneStretch,
        belowGpuMs: climb.seeded === true ? null : climb.belowGpuMs,
        byDuty: false,
        startMs: this.settleUntilMs,
        deadlineMs: null,
        interrupted: false,
        restarted: false,
        seeded: climb.seeded === true,
      };
    } else if (clockStep && this.clockHolds()) {
      // The clock handed a rung back to one still above Medium on its own
      // evidence. The rung it lands on is verified as a probe is — a measured
      // failure there escalates, and readings that do not come are silence —
      // because a heating device fails at the rung below next, and a reset's
      // plain restore there would start the escalation over each time.
      this.clockVerify = {
        kind: 'probe',
        fromIndex: Math.max(this.mediumIndex, this.index - 1),
        belowMedianMs: null,
        sceneStretch: null,
        belowGpuMs: null,
        byDuty: false,
        startMs: this.settleUntilMs,
        deadlineMs: null,
        interrupted: false,
        restarted: false,
      };
    } else {
      // A new rung is a new question: whatever verification stood was for
      // the rung that was.
      this.clockVerify = null;
      this.reopenClockVerify();
    }
    this.seedOnApplied(kind === 'up' && climb !== null && climb.seeded === true);
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
    this.pendingWindowBy = null;
    this.verifyUntilMs = null;
    this.probation = null;
    this.probationByClock = false;
    this.ceiling = null;
    this.ceilingFailures = 0;
    this.lastFailedProbeRung = null;
    this.unverifiedRung = null;
    this.clockFailures = 0;
    this.dropClockEpoch();
    this.refusal.reset();
    this.floorReference = null;
    this.stepReference = null;
    if (opts.cause === 'user') {
      this.latch = null;
      this.latchFailures = 0;
    }
    this.pendingClimb = null;
    this.pendingClockStep = false;
    this.breakScene(nowMs);
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
    this.pendingWindowBy = null;
    this.pendingClimb = null;
    this.pendingClockStep = false;
    this.verifyUntilMs = null;
    // Whatever drops the verification drops the probation with it: a down
    // after an arrival or a focus gain is a new question, not a probe failing.
    this.probation = null;
    this.probationByClock = false;
    this.breakScene(nowMs);
    this.resetClockEvidence(nowMs);
    switch (event) {
      case 'pin':
        this.idle = true;
        // Re-earned when the pin is lifted — as a reset, whose verdict says
        // nothing about the growth that climbed here.
        this.clockVerify = null;
        this.growthOnTrial = false;
        // Nor about a remembered rung on trial.
        if (this.seedRung !== null) this.endSeed('abandoned');
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
        // A new pose is a new question for a sensor resting on the old one.
        this.refusal.reset();
        this.settleUntilMs = nowMs + REALLOC_SETTLE_MS;
        break;
      case 'mode':
        // The composer switched — a tool opened or closed — and the frames
        // before it were another scene's: nothing measured there, the
        // sensor's rest included, says anything about the one on screen now.
        // Exactly the reset an arrival makes.
        this.refusal.reset();
        this.settleUntilMs = nowMs + REALLOC_SETTLE_MS;
        break;
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
    const nextRungs = ladder.rungs.length > 0 ? ladder.rungs : [1];
    const same = nextRungs.length === this.rungs.length
      && clampIndex(ladder.mediumIndex, nextRungs.length) === this.mediumIndex
      && nextRungs.every((r, i) => Math.abs(r - this.rungs[i]) < 1e-9);
    this.rungs = ladder.rungs.length > 0 ? ladder.rungs : [1];
    this.mediumIndex = clampIndex(ladder.mediumIndex, this.rungs.length);
    let nearest = 0;
    for (let i = 1; i < this.rungs.length; i++) {
      if (Math.abs(this.rungs[i] - previousRatio) < Math.abs(this.rungs[nearest] - previousRatio)) nearest = i;
    }
    this.index = nearest;
    this.window.clear();
    this.pending = null;
    this.pendingWindowBy = null;
    this.verifyUntilMs = null;
    this.probation = null;
    this.probationByClock = false;
    // An unchanged ladder — every window resize recomputes it: the end of a
    // drag, a phone turned, a keyboard shown — is the same epoch for the
    // clock. The growth, the failure count, the rungs marked unverified or
    // silent, and a ceiling above Medium on a blind tick (only the clock can
    // set one there) are facts about this device at these rungs, and a resize
    // must not buy the escalation back. Every other ceiling clears as before.
    const clockCeiling = same && !this.aboveAllowed && this.ceiling !== null && this.ceiling.rung > this.mediumIndex;
    if (!clockCeiling) this.ceiling = null;
    this.ceilingFailures = 0;
    this.lastFailedProbeRung = null;
    if (!same) {
      this.clockFailures = 0;
      this.unverifiedRung = null;
      this.dropClockEpoch();
    }
    this.refusal.reset();
    this.floorReference = null;
    this.stepReference = null;
    this.clockMs = nowMs;
    this.settleUntilMs = nowMs + REALLOC_SETTLE_MS;
    this.lastChangeMs = nowMs;
    this.pendingClimb = null;
    this.pendingClockStep = false;
    this.breakScene(nowMs);
    this.resetClockEvidence(nowMs);
    this.reopenClockVerify();
    if (Math.abs(this.rungs[this.index] - previousRatio) < 1e-9) return null;
    this.lastStep = { atMs: nowMs, from, to: this.index, reason: 'ladder', windowBy: null };
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
      downSpanMs: stat?.spanMs ?? null,
      downWindowBy: downWindowComplete(stat, this.downCounted),
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
      memory: {
        heldRatio: this.heldMemory?.ratio ?? null,
        rememberedRatio: this.rememberedIndex === null ? null : this.rungs[this.rememberedIndex],
        seed: this.seedOutcomeNow,
      },
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

  /** A rung the clock earned is being verified: the sensor samples one frame
   *  in four until it is done, whatever its priced duty, so eight readings
   *  arrive well inside the deadline. */
  get clockVerifying(): boolean {
    return this.clockVerify !== null;
  }

  /** Whether the clock could be the rule above Medium at all right now: the
   *  tick blind, no row target, a rung above Medium, the controller not held
   *  and the clock not off. Nowhere else is a frame's view worth naming. */
  get clockCanSteer(): boolean {
    return !this.idle && !this.aboveAllowed && this.mediumIndex < this.rungs.length - 1 && this.clockOffReason === null;
  }

  /**
   * Whether a reading taken now would be read: the sensor samples only then,
   * so it costs nothing where it could not help — a display with a finer tick,
   * a row target, a held controller, a ladder with nothing above Medium, the
   * not-pixel-bound latch, or a rung below Medium. At Medium a ceiling on the
   * next rung stops the sampling too, since nothing could be probed, and so
   * does a rest after the predictor kept refusing the climb; a rung
   * the clock earned is watched whatever the rung above it holds, or the
   * controller would make its own silence and restore Medium for it.
   */
  wantsClock(): boolean {
    if (this.idle || this.aboveAllowed || this.clockOffReason !== null) return false;
    if (this.mediumIndex >= this.rungs.length - 1) return false;
    if (this.index > this.mediumIndex) return this.clockEarned;
    if (this.index < this.mediumIndex || this.latch !== null) return false;
    if (this.refusal.resting(this.clockMs)) return false;
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
   * from them, inside a verification already standing if there is one. The
   * duty, where given, is what the silence gap is judged at from now on.
   */
  clearClockEvidence(nowMs: number, duty?: number): void {
    if (duty !== undefined && Number.isFinite(duty) && duty >= 1) this.clockDuty = duty;
    // Readings either side of a duty change are not compared: the change is
    // an evidence reset like any other.
    this.breakScene(nowMs);
    this.clearClockRing(nowMs);
    this.clockAcquiredAtMs = null;
    this.reopenClockVerify(true);
  }

  // --- The remembered rung (the header) --------------------------------------

  /**
   * The rung a previous boot verified and held on this device, for this boot's
   * FIRST climb from Medium. Taken once a boot, only where the clock steers and
   * only at Medium; returns null when it is armed, else why it was not.
   */
  remember(ratio: number): string | null {
    if (this.rememberTaken) return 'a rung was already remembered this boot';
    if (!this.clockCanSteer) return 'the clock does not steer here';
    if (this.index !== this.mediumIndex) return 'not at Medium';
    let at = -1;
    for (let i = this.mediumIndex + 1; i < this.rungs.length; i++) {
      if (Math.abs(this.rungs[i] - ratio) < 1e-6) at = i;
    }
    if (at < 0) return 'not a rung above Medium on this ladder';
    this.rememberTaken = true;
    this.rememberedIndex = at;
    this.setSeedOutcome('armed');
    return null;
  }

  /** The configuration a remembered rung was held in is not this one any
   *  more — the canvas grew past it, or the caller forgot it: an armed rung is
   *  cancelled, and a trial standing ends with no verdict, so a failure at the
   *  rung from here on is the rung's alone and says nothing about the memory. */
  forgetRemembered(): void {
    if (this.rememberedIndex !== null) {
      this.rememberedIndex = null;
      this.setSeedOutcome('abandoned');
    }
    if (this.seedRung !== null) this.endSeed('abandoned');
  }

  /** The last rung the clock earned and held for `REMEMBER_HOLD_MS` this
   *  epoch — what the next boot is to be told — or null. */
  get memory(): { readonly ratio: number } | null {
    return this.heldMemory;
  }

  /** Moves whenever `memory` or `seedOutcome` does: the one number a caller
   *  reads per frame. */
  get memoryVersion(): number {
    return this.memoryVersionCount;
  }

  /** What became of the rung this boot was told, or null if it was told none. */
  get seedOutcome(): SeedOutcome | null {
    return this.seedOutcomeNow;
  }

  private setSeedOutcome(outcome: SeedOutcome): void {
    if (this.seedOutcomeNow === outcome) return;
    this.seedOutcomeNow = outcome;
    this.memoryVersionCount++;
  }

  private endSeed(outcome: 'passed' | 'dropped' | 'abandoned'): void {
    this.seedRung = null;
    // A verification left standing is an ordinary probe's from here on.
    if (this.clockVerify !== null) this.clockVerify.seeded = false;
    this.setSeedOutcome(outcome);
  }

  /** A remembered climb's rung is on trial and is still the rung. */
  private seedOnTrial(): boolean {
    return this.seedRung !== null && this.index === this.seedRung;
  }

  /** Its check stands: the clock has not passed the rung yet, or the interval
   *  second every climb opens has not ended. Kept as a flag rather than read
   *  off the verification, which is let go before its verdict is acted on. */
  private seedChecking(): boolean {
    return this.seedOnTrial() && (!this.seedClockChecked || this.verifyUntilMs !== null);
  }

  /**
   * The climb straight to the remembered rung, where the gates the caller has
   * already passed — everything a clock climb needs but the prediction — hold,
   * and Medium's own readings on this boot say the room is there. Null
   * otherwise, and the rung stays armed.
   */
  private seedDecision(nowMs: number): Decision | null {
    const target = this.rememberedIndex;
    if (target === null || this.index !== this.mediumIndex) return null;
    if (target <= this.index) {
      // Nothing to climb to: used up, with no decision.
      this.forgetRemembered();
      return null;
    }
    if (this.ceiling !== null && target >= this.ceiling.rung) return null;
    if (this.refusal.resting(nowMs)) return null;
    const w = this.clockRing.window(CLOCK_UP_COUNT, CLOCK_UP_SPAN_MS, nowMs - STALENESS_MS, 0.9);
    if (w === null || w.starvedShare > STARVED_SHARE_MAX) return null;
    if (w.p90Ms > CALIBRATION_SHARE * this.budgetMs) return null;
    this.refusal.fits();
    this.noteClock(nowMs, target, 'remembered');
    const decision = this.emit(target, 'up');
    decision.seeded = true;
    this.pendingClimb = { belowMedianMs: null, sceneStretch: this.sceneStretch, belowGpuMs: NaN, byGrowth: false, seeded: true };
    return decision;
  }

  /** Every way out of a remembered climb's check: back to Medium, where every
   *  such climb starts, with no ceiling, no failure counted and the wait as it
   *  was. A MEASURED failure — readings over the bar, capped or starved ones
   *  repeating, a panic, the delivery guard, the intervals — drops the memory;
   *  readings that did not come, or a clock that went off, measured nothing
   *  about the rung, and the memory is kept ('abandoned'). */
  private seedFail(nowMs: number, why: ClockWhy, outcome: 'dropped' | 'abandoned' = 'dropped'): Decision {
    this.noteClock(nowMs, this.mediumIndex, why);
    this.clockVerify = null;
    this.verifyUntilMs = null;
    this.growthOnTrial = false;
    this.endSeed(outcome);
    return this.emit(this.mediumIndex, 'restore');
  }

  /** A rung was applied. The remembered rung is for the first climb from
   *  Medium only, so any change uses it up; a remembered climb puts its rung on
   *  trial, and any move off that rung while the trial stands ends it. */
  private seedOnApplied(seeded: boolean): void {
    if (this.rememberedIndex !== null) {
      this.rememberedIndex = null;
      if (!seeded) this.setSeedOutcome('abandoned');
    }
    if (seeded) {
      this.seedRung = this.index;
      this.seedClockChecked = false;
      this.setSeedOutcome('applied');
    } else if (this.seedRung !== null && this.index !== this.seedRung) {
      this.endSeed('abandoned');
    }
  }

  /** The rung the clock holds has been held for `REMEMBER_HOLD_MS` since a
   *  verification there passed: it is the one to remember, and a remembered
   *  rung on trial has passed. */
  private noteHeld(nowMs: number): void {
    if (this.clockAcquiredAtMs === null || nowMs - this.clockAcquiredAtMs < REMEMBER_HOLD_MS) return;
    const ratio = this.rungs[this.index];
    if (this.heldMemory === null || Math.abs(this.heldMemory.ratio - ratio) > 1e-9) {
      this.heldMemory = { ratio };
      this.memoryVersionCount++;
    }
    if (this.seedOnTrial()) this.endSeed('passed');
  }

  /** A new budget or ladder: the remembered rung, a trial and the rung held
   *  all describe the old one. */
  private dropMemoryEpoch(): void {
    this.forgetRemembered();
    if (this.heldMemory !== null) {
      this.heldMemory = null;
      this.memoryVersionCount++;
    }
  }

  /** A new evidence epoch for the clock: nothing learned about how this
   *  device grows, and no steady-state silence counted against a rung. */
  private dropClockEpoch(): void {
    this.clockGrowthE = null;
    this.clockGrowthMeasured = null;
    this.growthOnTrial = false;
    this.silentRung = null;
    this.dropMemoryEpoch();
  }

  private clearClockRing(nowMs: number): void {
    this.clockRing.clear();
    this.clockSinceMs = nowMs;
    this.panicStreak = 0;
    this.activeSinceReadingMs = 0;
  }

  private resetClockEvidence(nowMs: number, keepDelivery = false): void {
    this.generationCount++;
    this.clearClockRing(nowMs);
    if (!keepDelivery) this.delivery.clear();
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
   *
   * Whether the frames it reads are the rung's own is the LATEST reset's to
   * say: a duty change moved nothing on screen, but an arrival, a tool, a
   * focus gain, a resize or a pin lifted inside that re-check puts it at a
   * scene the rung was never earned at, so the mark goes — and a slow stretch
   * there, the delivery guard's included, is the plain restore every other
   * reset gets rather than a measured failure.
   */
  private reopenClockVerify(byDuty = false): void {
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
      sceneStretch: standing?.sceneStretch ?? null,
      belowGpuMs: standing?.belowGpuMs ?? null,
      byDuty,
      startMs: this.settleUntilMs,
      deadlineMs: standing?.deadlineMs ?? null,
      interrupted: standing?.interrupted ?? false,
      restarted: standing?.restarted ?? false,
      seeded: standing?.seeded ?? false,
    };
  }

  /** `because` is 0 for a counted interval, else why it did not count. */
  private recordVerdict(drawSeq: number, because: number): void {
    this.verdictSeq[this.verdictHead] = drawSeq;
    this.verdictBecause[this.verdictHead] = because;
    this.verdictHead = (this.verdictHead + 1) % VERDICT_RING_SIZE;
  }

  /** The view this step's interval was drawn in: a stretch of one named view
   *  ends at a new name, at no name, and at any sliced work — an upload
   *  changes what the frames draw, so readings either side of it are not
   *  of one scene. */
  private noteScene(sample: IntervalSample): void {
    const key = sample.sceneKey ?? null;
    if (key === null || key !== this.sceneKeyLast || sample.workedMs !== 0) this.breakScene(sample.nowMs);
    this.sceneKeyLast = key;
  }

  /** A new stretch starts here: nothing read before it is compared with
   *  anything read after. */
  private breakScene(nowMs: number): void {
    this.sceneStretch++;
    this.sceneStretchSinceMs = nowMs;
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
      // A frame that was eligible and settled but whose interval did not
      // count — sliced work, a busy main thread, the sensor's own work —
      // says nothing trustworthy about what the pixels cost, so its reading
      // never enters a statistic. But it can still say the rung is failing:
      // an engine that blocks in submission under GPU backpressure makes
      // exactly the frames whose readings are capped also the frames whose
      // main thread is too busy to count. So a starved or capped reading
      // from such a frame is kept as evidence for the starved share, the
      // probe's failure count and silence, and a capped or over-bar one adds
      // to the panic streak. It never resets the streak: the evidence that a
      // rung fits is taken only from frames that counted.
      if (because >= 3) this.admitUncounted(obs);
      return;
    }
    this.clockRing.push(obs.sampledAtMs, obs.readingMs, obs.busyMs, obs.starved ? STARVED : TRUSTED);
    this.clockAccepted++;
    this.activeSinceReadingMs = 0;
    if (!obs.starved) this.panicStreak = obs.readingMs > this.budgetMs ? this.panicStreak + 1 : 0;
  }

  /** A reading of an eligible, settled frame whose interval did not count:
   *  kept only where it is evidence of failure (above). Such a reading is the
   *  clock speaking, so it is not silence either — at a sparse duty the
   *  silence gap would otherwise run out before four of them could make a
   *  panic, and the rung would go back with no ceiling for what is a measured
   *  failure. */
  private admitUncounted(obs: GpuObservation): void {
    if (obs.starved) {
      this.clockRing.push(obs.sampledAtMs, obs.readingMs, obs.busyMs, STARVED);
      this.activeSinceReadingMs = 0;
      return;
    }
    if (!(obs.readingMs > this.budgetMs)) return;
    if (!Number.isFinite(obs.readingMs)) this.clockRing.push(obs.sampledAtMs, obs.readingMs, obs.busyMs, EVIDENCE);
    this.activeSinceReadingMs = 0;
    this.panicStreak++;
  }

  /** Every eligible step's interval, for the delivery guard, and the active
   *  drawing time since the clock last had a reading. A stretch the clock
   *  cannot sample adds to neither: the map is not the scene's frames, and
   *  a reading it never asked for is not silence. The settle after a change
   *  is NOT left out of the guard: it keeps the pixel evidence from reading
   *  a reallocation as the rung's cost, but a frame drawn late inside it was
   *  still a frame the screen showed late, and a sharper rung whose first
   *  frame stalls must answer for it. */
  private recordDelivery(sample: IntervalSample, suspended: boolean): void {
    if (this.idle || !sample.eligible || suspended) return;
    this.activeSinceReadingMs += sample.intervalMs;
    this.delivery.push(sample.nowMs, sample.intervalMs);
  }

  /**
   * A verification's time starts at the first frame the clock can sample
   * after it opened — the settle inside it — so a veil, a hidden page or the
   * map cannot use it up before it has begun. And once it has begun, a
   * stretch the clock could not sample restarts it, once, when the stretch
   * ends: the evidence was dropped with it, and a verification that resumed
   * with a few milliseconds left, or none, would restore the rung for want of
   * readings nobody could take. A second such stretch does not restart it
   * again, and neither does any reset or duty change.
   */
  private timeClockVerify(nowMs: number): void {
    const verify = this.clockVerify;
    if (verify === null) return;
    if (this.clockPausedNow) {
      if (verify.deadlineMs !== null) verify.interrupted = true;
      return;
    }
    if (verify.deadlineMs === null) {
      verify.deadlineMs = nowMs + CLOCK_VERIFY_MS;
    } else if (verify.interrupted && !verify.restarted) {
      verify.deadlineMs = nowMs + CLOCK_VERIFY_MS;
      verify.restarted = true;
    }
    verify.interrupted = false;
  }

  private noteClock(atMs: number, to: number, why: ClockWhy): void {
    this.clockLast = { atMs, from: this.index, to, why };
  }

  /** A measured failure at a rung the clock earned: the probe's treatment
   *  whether or not the probation still stands, so a device that heats slowly
   *  cannot earn, throttle, recover and repeat without the escalation adding
   *  up. `to` is one rung down, or Medium for the delivery guard. */
  private clockFail(nowMs: number, to: number, why: ClockWhy): Decision {
    if (this.seedChecking()) return this.seedFail(nowMs, why);
    // A measured failure while a remembered rung is on trial: the memory goes.
    if (this.seedOnTrial()) this.endSeed('dropped');
    this.noteClock(nowMs, to, why);
    this.failProbe(nowMs);
    const decision = this.emit(to, 'revert');
    this.pendingClockStep = true;
    return decision;
  }

  /** Straight back to Medium with no ceiling: the clock cannot vouch for the
   *  rung, which is not the rung failing. A lifecycle reset that was not
   *  re-earned leaves the wait as it was; a clock that went quiet in steady
   *  state doubles it, so a clock that keeps going quiet cannot take the
   *  picture up and down every few seconds — each change is a visible one. */
  private clockRestore(nowMs: number, why: ClockWhy, rungsOwnFrames = false): Decision {
    // A restore is a clock that cannot vouch — off, or a lifecycle reset not
    // re-earned — and not the rung failing, so a remembered rung on trial
    // keeps its memory. Except a panic or readings over the bar in a re-check
    // the sensor's duty opened (`rungsOwnFrames`): nothing on screen moved, the
    // frames are the rung's own, and a heavy rung is exactly what prices the
    // duty up — for the memory, that is a measured failure.
    const memory = rungsOwnFrames && (why === 'panic' || why === 'verify') ? 'dropped' : 'abandoned';
    if (this.seedChecking()) return this.seedFail(nowMs, why, memory);
    if (this.seedOnTrial()) this.endSeed(memory);
    this.noteClock(nowMs, this.mediumIndex, why);
    this.clockVerify = null;
    this.growthOnTrial = false;
    if (why === 'silent' || why === 'gap' || why === 'starved') {
      this.probeWait = Math.min(PROBE_WAIT_MAX_MS, this.probeWait * 2);
    }
    return this.emit(this.mediumIndex, 'restore');
  }

  /**
   * A rung the clock earned went quiet in steady state: back to Medium with
   * no ceiling, the wait doubled. From the second time at the same rung in an
   * epoch, every silence there is a failure with the ceiling's escalation, or
   * a pose whose clock goes quiet at that rung and nowhere else would climb
   * and restore for the rest of the session.
   */
  private clockSilent(nowMs: number, why: ClockWhy): Decision {
    // Starved readings over their share are the clock failing to read the
    // rung's frames; a gap or too few readings are only the clock not reading.
    if (this.seedChecking()) return this.seedFail(nowMs, why, why === 'starved' ? 'dropped' : 'abandoned');
    if (this.silentRung !== this.index) {
      this.silentRung = this.index;
      return this.clockRestore(nowMs, why);
    }
    // The mark stays: every silence there from now on escalates.
    this.noteClock(nowMs, this.mediumIndex, why);
    this.clockVerify = null;
    // The wait doubles once, with the ceiling.
    this.failProbe(nowMs);
    return this.emit(this.mediumIndex, 'restore');
  }

  /**
   * A clock probe that could not be verified: the readings did not come. That
   * is silence, not a measured failure, and takes silence's treatment — the
   * wait doubles, so a rung whose readings never arrive is not probed every
   * ten seconds for the rest of the session — and a second one in a row at
   * the same rung holds that rung as a ceiling, as a failed probe would.
   */
  private clockUnverified(nowMs: number, to: number): Decision {
    // Readings that did not come in time: a stretch away, a tool, sliced work
    // on every frame — nothing measured about the rung.
    if (this.seedChecking()) return this.seedFail(nowMs, 'unverified', 'abandoned');
    this.noteClock(nowMs, to, 'unverified');
    if (this.unverifiedRung === this.index) {
      this.unverifiedRung = null;
      this.failProbe(nowMs);
    } else {
      this.unverifiedRung = this.index;
      this.probeWait = Math.min(PROBE_WAIT_MAX_MS, this.probeWait * 2);
    }
    const decision = this.emit(to, 'revert');
    this.pendingClockStep = true;
    return decision;
  }

  /** How long active drawing may go without a reading before the clock is
   *  silent: at the one-in-four a verification samples at, or the duty. */
  private clockGap(verifying: boolean): number {
    return clockGapMs(verifying ? Math.min(this.clockDuty, DUTY_VERIFY) : this.clockDuty, this.budgetMs);
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
    // While a lifecycle reset is being re-earned — an arrival, a resize, a
    // focus gain, a pin lifted, a new budget or ladder, a duty change, the
    // map closing — whatever fails it is the plain restore: Medium, no
    // ceiling, no failure counted, no longer wait. The rung did not fail at
    // the pose it was earned at; the question is only whether it can be
    // vouched for at the new one, and a panic or a capped fence there answers
    // no in the same way a slow verification does.
    const lifecycle = verify !== null && verify.kind === 'reset';
    if (this.panicStreak >= CLOCK_PANIC_COUNT) {
      if (lifecycle) return this.clockRestore(nowMs, 'panic', verify.byDuty);
      return this.clockFail(nowMs, verify?.kind === 'probe' ? verify.fromIndex : this.index - 1, 'panic');
    }
    // Every frame that was drawn, slow for whatever reason: the pixels may be
    // kept only while the screen's rate really holds.
    const delivered = this.delivery.mean(nowMs, CLOCK_DELIVERY_SPAN_MS);
    if (delivered !== null && delivered > CLOCK_DELIVERY_GUARD * bar) {
      // A duty change moved nothing on screen: the frames in the span are the
      // rung's own, and a slow stretch of them is the rung failing.
      if (lifecycle && !verify.byDuty) return this.clockRestore(nowMs, 'delivery');
      return this.clockFail(nowMs, this.mediumIndex, 'delivery');
    }
    const quiet = this.activeSinceReadingMs > this.clockGap(verify !== null);
    if (verify !== null) {
      if (verify.deadlineMs === null) return null;
      const got = this.clockRing.tally(verify.startMs);
      if (got.count >= CLOCK_VERIFY_COUNT) {
        this.clockVerify = null;
        const stats = this.clockRing.stats(verify.startMs);
        const trimmed = stats.trimmedMeanMs ?? Infinity;
        if (trimmed > CLOCK_DOWN_SHARE * bar) {
          if (lifecycle) return this.clockRestore(nowMs, 'verify', verify.byDuty);
          return this.clockFail(nowMs, verify.fromIndex, 'verify');
        }
        if (verify.kind === 'probe' && verify.sceneStretch !== null && stats.medianMs !== null) {
          // A climb, measured: the two rungs are compared only where they
          // were read in one still view — the rung below's whole window and
          // every frame since, under one name, with no sliced work and no
          // reset but the climb. Anything else is a scene that may really
          // have got cheaper, and the comparison is skipped.
          if (verify.belowMedianMs === null || verify.sceneStretch !== this.sceneStretch) {
            this.reversalChecks.skipped++;
          } else {
            this.reversalChecks.made++;
            if (isReversal(verify.belowMedianMs, stats.medianMs)) {
              // More pixels read as markedly less time in the same view.
              // Once can still be noise; again and the fence is not timing
              // this frame's work.
              this.clockReversals++;
              if (this.clockReversals >= REVERSAL_REPEATS) {
                this.clockOffReason = `the clock read the sharper rung more than ${REVERSAL_MS} ms faster than the rung below in the same view, ${this.clockReversals} times`;
                return this.clockRestore(nowMs, 'reversal');
              }
            }
          }
        }
        // Any verification that passes ends a growth's trial: the rung held.
        this.growthOnTrial = false;
        if (verify.kind === 'probe' && verify.sceneStretch !== null) {
          // A climb, verified: how much its GPU part grew over the rung
          // below's is how this device's frames grow with pixels — learned
          // only where the two were read in one still view, and never from a
          // growth below 1, which is the scene getting cheaper.
          const comparable = verify.belowMedianMs !== null && verify.sceneStretch === this.sceneStretch;
          const learned = comparable && verify.belowGpuMs !== null
            ? learnedExponent(verify.belowGpuMs, this.clockRing.gpuPartMedian(verify.startMs), this.rungs[verify.fromIndex], this.rungs[this.index])
            : null;
          if (learned === null) {
            this.growthChecks.skipped++;
          } else {
            this.clockGrowthE = learned.exponent;
            this.clockGrowthMeasured = learned.growth;
            this.growthChecks.learned++;
          }
        }
        this.clockAcquiredAtMs = nowMs;
        if (this.seedOnTrial()) this.seedClockChecked = true;
        if (this.unverifiedRung === this.index) this.unverifiedRung = null;
        return null;
      }
      // Judged, like the steady-state share, only once there are enough
      // attempts for a share to mean anything: two starved readings in the
      // first five are 40 % of a clock whose share is a steady quarter.
      const bad = got.starved + got.capped;
      if (verify.kind === 'probe' && bad >= CLOCK_PROBE_BAD_MIN && got.attempts >= CLOCK_STARVED_MIN
        && (bad / got.attempts) > STARVED_SHARE_MAX) {
        // Starved or capped readings repeating through the probe: the probe
        // failing, not merely silent.
        return this.clockFail(nowMs, verify.fromIndex, 'unverified');
      }
      if (nowMs < verify.deadlineMs && !quiet) return null;
      this.clockVerify = null;
      if (lifecycle) return this.clockRestore(nowMs, 'unverified');
      return this.clockUnverified(nowMs, verify.fromIndex);
    }
    if (quiet) return this.clockSilent(nowMs, 'gap');
    if (this.clockAcquiredAtMs !== null && nowMs - this.clockAcquiredAtMs >= CLOCK_SILENCE_SPAN_MS
      && this.clockRing.tally(nowMs - CLOCK_SILENCE_SPAN_MS).count < clockSilenceCount(this.clockDuty, this.budgetMs)) {
      return this.clockSilent(nowMs, 'silent');
    }
    const starved = this.clockRing.starvedShare(CLOCK_STARVED_WINDOW, CLOCK_STARVED_MIN, nowMs - STALENESS_MS);
    if (starved !== null && starved > STARVED_SHARE_MAX) return this.clockSilent(nowMs, 'starved');
    const w = this.clockRing.window(CLOCK_DOWN_COUNT, CLOCK_DOWN_SPAN_MS, nowMs - STALENESS_MS, 0.9);
    if (w !== null && w.value > CLOCK_DOWN_SHARE * bar) return this.clockFail(nowMs, this.index - 1, 'hand-back');
    this.noteHeld(nowMs);
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
    // Nothing is climbed that the clock could not go on to verify.
    if (this.clockPausedNow) return null;
    // A rung above Medium the clock did not earn is not the clock's to build on.
    if (this.index > this.mediumIndex && !this.clockEarned) return null;
    if (this.ceiling !== null && next >= this.ceiling.rung) return null;
    if (nowMs - this.lastChangeMs < this.probeWait) return null;
    // The frames are not already late: the counted intervals over a whole up
    // window inside their up bar — a device capped from outside the app would
    // otherwise climb on an idle-looking GPU while its frames were missing —
    // and every frame drawn, unfiltered and bar the one longest, at the
    // screen's rate.
    const stat = this.window.trimmedMean(this.upCounted, TRIM_COUNT, nowMs - STALENESS_MS);
    if (stat === null || stat.count < this.upCounted) return null;
    if (stat.meanMs > UP_FACTOR * this.budgetMs) return null;
    const delivered = this.delivery.mean(nowMs, CLOCK_DELIVERY_SPAN_MS);
    if (delivered === null || delivered > CLOCK_DELIVERY_UP * this.budgetMs) return null;
    const starved = this.clockRing.starvedShare(CLOCK_STARVED_WINDOW, CLOCK_STARVED_MIN, nowMs - STALENESS_MS);
    if (starved !== null && starved > STARVED_SHARE_MAX) return null;
    const seeded = this.seedDecision(nowMs);
    if (seeded !== null) return seeded;
    const growth = growthFor(this.clockGrowthE, this.rungs[this.index], this.rungs[next]);
    const horizon = nowMs - STALENESS_MS;
    const w = this.clockRing.window(
      CLOCK_UP_COUNT, CLOCK_UP_SPAN_MS, horizon, 0.9,
      (reading, busy) => predictWithGrowthMs(busy, reading, growth),
    );
    if (w === null || w.starvedShare > STARVED_SHARE_MAX) return null;
    const fits = w.value <= CLOCK_UP_SHARE * this.budgetMs;
    // While how this device's frames grow with pixels is not known, a climb
    // the guess refuses may be tried on the rung's own readings, and is
    // verified like any probe (app/gpuFrameClockPolicy.ts).
    const calibrate = !fits && this.clockGrowthE === null && w.p90Ms <= CALIBRATION_SHARE * this.budgetMs;
    if (!fits && !calibrate) {
      // No room at this pose. Kept up for long enough at Medium, the sensor
      // rests rather than sampling a session it cannot change.
      if (this.index === this.mediumIndex) this.refusal.refused(nowMs);
      return null;
    }
    this.refusal.fits();
    this.noteClock(nowMs, next, calibrate ? 'calibrate' : 'climb');
    const decision = this.emit(next, 'up');
    // The rung below's median, for the honesty check once the sharper rung
    // has been measured — only where every reading of the window was taken
    // inside the current still view — and its GPU part, for the growth.
    const still = this.sceneKeyLast !== null && w.oldestAtMs >= this.sceneStretchSinceMs;
    const gpu = this.clockRing.window(
      CLOCK_UP_COUNT, CLOCK_UP_SPAN_MS, horizon, 0.5,
      (reading, busy) => reading - Math.min(Math.max(0, busy), reading),
    );
    this.pendingClimb = {
      belowMedianMs: still ? w.medianMs : null,
      sceneStretch: this.sceneStretch,
      belowGpuMs: gpu?.value ?? NaN,
      byGrowth: fits && this.clockGrowthE !== null,
    };
    return decision;
  }

  private clockState(): ClockState {
    const horizon = this.clockMs - STALENESS_MS;
    const got = this.clockRing.stats(horizon);
    const next = this.index + 1;
    let predictedNextMs: number | null = null;
    let nextFactor: number | null = null;
    if (next < this.rungs.length && next > this.mediumIndex) {
      const growth = growthFor(this.clockGrowthE, this.rungs[this.index], this.rungs[next]);
      nextFactor = growth;
      const p = this.clockRing.window(
        CLOCK_UP_COUNT, CLOCK_UP_SPAN_MS, horizon, 0.9,
        (reading, busy) => predictWithGrowthMs(busy, reading, growth),
      );
      predictedNextMs = p?.value ?? null;
    }
    const verify = this.clockVerify;
    return {
      steering: this.clockCanSteer,
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
        seeded: verify.seeded === true,
        readings: this.clockRing.tally(verify.startMs).count,
        deadlineMs: verify.deadlineMs,
      },
      duty: this.clockDuty,
      gapMs: this.clockGap(verify !== null),
      silenceCount: clockSilenceCount(this.clockDuty, this.budgetMs),
      unverifiedRung: this.unverifiedRung,
      silentRung: this.silentRung,
      failures: this.clockFailures,
      rest: (() => {
        const r = this.refusal.state();
        return { untilMs: r.restUntilMs !== null && this.clockMs < r.restUntilMs ? r.restUntilMs : null, nextMs: r.nextRestMs, rests: r.rests };
      })(),
      panicStreak: this.panicStreak,
      reversals: this.clockReversals,
      reversalChecks: { ...this.reversalChecks },
      growth: {
        measured: this.clockGrowthMeasured,
        exponent: this.clockGrowthE,
        nextFactor,
        ...this.growthChecks,
      },
      calibrationOpen: this.clockGrowthE === null,
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
    this.pendingClockStep = false;
    this.pendingWindowBy = null;
    this.pending = { to: clampIndex(to, this.rungs.length), reason };
    return this.pending;
  }

  /** A decision the down window made, marked with the rule that completed
   *  that window so the step it becomes can say so. */
  private byWindow(decision: Decision, by: DownWindowBy): Decision {
    this.pendingWindowBy = by;
    return decision;
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
      // The interval second a remembered climb opened is part of its check.
      if (this.seedOnTrial()) return this.seedFail(nowMs, 'intervals');
      const clockRung = this.clockHolds();
      this.failProbe(nowMs);
      const decision = this.emit(this.verifyFromIndex, 'revert');
      // A clock probe the intervals failed: the rung it lands on, if still
      // above Medium, is verified as a probe is, like any hand-back the clock
      // makes on its own evidence.
      if (clockRung) this.pendingClockStep = true;
      return decision;
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
    if (this.growthOnTrial) {
      // The rung was climbed on a learned growth and did not hold. A growth
      // below the guess was more hopeful than the guess, and the guess comes
      // back; one at or above it was already at least as cautious, and going
      // back to the guess would only climb sooner, so it is kept.
      this.growthOnTrial = false;
      if (this.clockGrowthE !== null && this.clockGrowthE < CLOCK_EXPONENT) {
        this.clockGrowthE = null;
        this.clockGrowthMeasured = null;
        this.growthChecks.dropped++;
      }
    }
    if (this.clockHolds()) {
      // At a rung the clock earned the count is the evidence epoch's, not the
      // rung's: with two rungs above Medium a heating device fails at one,
      // then at the other, and a count per rung would start over at each and
      // never escalate. From the second failure the ceiling sits on the first
      // rung above Medium, so no clock climb is taken at all while it holds.
      const failures = this.clockFailures++;
      const hold = CEILING_HOLD_MS[Math.min(failures, CEILING_HOLD_MS.length - 1)];
      const rung = failures === 0 ? this.index : this.mediumIndex + 1;
      this.ceiling = { rung, untilMs: nowMs + hold, escalation: failures + 1 };
    } else {
      this.ceilingFailures = this.lastFailedProbeRung === this.index ? this.ceilingFailures + 1 : 0;
      const hold = CEILING_HOLD_MS[Math.min(this.ceilingFailures, CEILING_HOLD_MS.length - 1)];
      this.ceiling = { rung: this.index, untilMs: nowMs + hold, escalation: this.ceilingFailures + 1 };
      this.lastFailedProbeRung = this.index;
    }
    this.probation = null;
    this.probationByClock = false;
  }

  private downDecision(nowMs: number): Decision | null {
    if (this.index <= 0 || this.latch !== null) return null;
    if (nowMs - this.lastChangeMs < DOWN_SPACING_MS) return null;
    const stat = this.window.trimmedMean(this.downCounted, TRIM_COUNT, nowMs - STALENESS_MS);
    const by = downWindowComplete(stat, this.downCounted);
    if (stat === null || by === null) return null;
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
    if (earned) return this.byWindow(this.clockFail(nowMs, this.index - 1, 'intervals'), by);
    // Handed back inside its probation: the probe that reached this rung has
    // failed, and the step is its revert rather than a slide.
    if (this.probation !== null && this.probation.rung === this.index && nowMs < this.probation.untilMs) {
      this.failProbe(nowMs);
      return this.byWindow(this.emit(this.index - 1, 'revert'), by);
    }
    // The mean at medium is what the floor will have to beat. Only a slide
    // that starts at medium can be judged that way; one that starts lower
    // (after a ladder change) leaves the reference unset and the floor check
    // silent.
    if (this.index === this.mediumIndex) this.floorReference = stat.meanMs;
    // And the rung above the floor as it last read, for a device that got
    // slower while the slide was under way.
    this.stepReference = stat.meanMs;
    return this.byWindow(this.emit(this.index - 1, 'down'), by);
  }

  /** At the floor: did the pixels the slide gave up buy anything? */
  private floorDecision(nowMs: number): Decision | null {
    if (this.latch !== null || this.floorReference === null || this.index === this.mediumIndex) return null;
    // The same window, complete by the same rule, as the step down it judges.
    const stat = this.window.trimmedMean(this.downCounted, TRIM_COUNT, nowMs - STALENESS_MS);
    const by = downWindowComplete(stat, this.downCounted);
    if (stat === null || by === null) return null;
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
    return this.byWindow(this.emit(this.mediumIndex, 'floor latch'), by);
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
