import { describe, expect, it } from 'vitest';
import {
  BUDGET_MS,
  CEILING_HOLD_MS,
  CLOCK_DELIVERY_GUARD,
  CLOCK_DELIVERY_SPAN_MS,
  CLOCK_DELIVERY_UP,
  CLOCK_DOWN_COUNT,
  CLOCK_GAP_MS,
  CLOCK_INTERVAL_DOWN,
  CLOCK_SILENCE_SPAN_MS,
  CLOCK_PANIC_COUNT,
  CLOCK_UP_COUNT,
  CLOCK_UP_SPAN_MS,
  CLOCK_VERIFY_MS,
  DOWN_FACTOR,
  DOWN_SPACING_MS,
  DOWN_WINDOW_COUNTED,
  DOWN_WINDOW_S,
  FLOOR_LATCH_MIN_GAIN,
  LATCH_HOLD_MS,
  MAIN_THREAD_SHARE,
  PROBE_HOLD_MS,
  PROBE_WAIT_MS,
  REALLOC_SETTLE_MS,
  ResolutionController,
  STALENESS_MS,
  TRIM_COUNT,
  UP_FACTOR,
  UP_WINDOW_COUNTED,
  UP_WINDOW_S,
  VERIFY_MS,
  ZERO_COUNTED_WARN_MS,
  type Decision,
  type GpuObservation,
  type IntervalSample,
  type RungLadder,
  type StepReason,
} from './resolutionController';
import { CLOCK_DOWN_SHARE, CLOCK_EXPONENT, CLOCK_UP_SHARE, STARVED_SHARE_MAX } from './gpuFrameClockPolicy';

/** One vsync tick on a 60 Hz panel, as a delivered interval reads. */
const TICK = 16.67;
/** And on a 120 Hz one. */
const TICK_120 = 8.33;

/** A ladder with nothing above medium — 1.5 -> 1.74 -> 2 on a 2x display — so
 *  Dynamic there can only slide down. What the bounds hand back where a fact
 *  about the machine refuses a supersample: no composer, a GPU that completed
 *  no multisampled half-float target, the GL size limit or the byte budget.
 *  Named for its shape, because no rule asks what kind of chassis it is. */
const SHORT_LADDER: RungLadder = { rungs: [2 / 1.33, 2 / 1.15, 2], mediumIndex: 2 };

/** And a full one: the same two rungs below, 2.5 and 3 above. */
const FULL_LADDER: RungLadder = { rungs: [2 / 1.33, 2 / 1.15, 2, 2.5, 3], mediumIndex: 2 };

interface Applied {
  atMs: number;
  from: number;
  to: number;
  reason: StepReason;
}

/**
 * Plays a stream of intervals through the controller and applies whatever it
 * decides, the way the animation loop would. `interval` is asked for each
 * frame and may read the rung, which is how a device that gets faster (or
 * does not) as the ratio drops is modelled.
 */
class Rig {
  nowMs = 0;
  readonly applied: Applied[] = [];

  constructor(readonly controller: ResolutionController) {}

  run(frames: number, interval: (rung: number, i: number) => number, over: Partial<IntervalSample> = {}): void {
    for (let i = 0; i < frames; i++) {
      const rung = this.controller.rung;
      const intervalMs = interval(rung, i);
      this.nowMs += intervalMs;
      const sample: IntervalSample = {
        nowMs: this.nowMs,
        intervalMs,
        mainThreadMs: 5,
        workedMs: 0,
        eligible: true,
        ...over,
      };
      const decision = this.controller.step(sample);
      if (decision !== null) this.apply(decision);
    }
  }

  apply(decision: Decision): void {
    const from = this.controller.rung;
    this.applied.push({ atMs: this.nowMs, from, to: decision.to, reason: decision.reason });
    // Only a probe is verified, so the kind follows the reason and never the
    // direction: a floor latch also moves the rung up.
    const kind = decision.reason === 'up' ? 'up' : decision.reason === 'down' ? 'down' : 'restore';
    this.controller.onApplied(this.nowMs, kind);
  }

  get rung(): number {
    return this.controller.rung;
  }
}

/** The Frame rate row at 60 fps: a rate the user asked to be defended with
 *  pixels, so a rung above Medium is allowed and every rung is held to the
 *  same 16.67 ms — the bar the probe and probation tests below are written
 *  against. At the row's default a rung above Medium is measured against
 *  the display's own tick instead, and a 60 Hz display allows none. */
function sixtyRow(rig: Rig): void {
  rig.controller.setBudget(1000 / 60, 0, { cause: 'user' });
}

/** A 120 Hz display at the row's default: a rung above Medium is allowed and
 *  held to one of its ticks, 8.33 ms; Medium and below keep the 60 fps bar. */
function fastScreen(rig: Rig): void {
  rig.controller.setBudget(null, 0, { cause: 'auto', above: { budgetMs: TICK_120, allowed: true } });
}

/** A stream at a steady rate: one frame in `late` is a tick late. */
function oneInLate(late: number): (rung: number, i: number) => number {
  return (_rung, i) => ((i + 1) % late === 0 ? 2 * TICK : TICK);
}

/** Frames enough to fill a down window twice over: every stream below is
 *  sized off the rule's own window rather than off a number that would go
 *  quietly wrong the next time a window length moves. */
const TWO_DOWN_WINDOWS = 2 * DOWN_WINDOW_COUNTED;

describe('the statistic — hitches and bursts move nothing', () => {
  it('lets one 600 ms stall through: a stall is one late callback, not thirty', () => {
    const rig = new Rig(new ResolutionController(SHORT_LADDER));
    rig.run(TWO_DOWN_WINDOWS, (_r, i) => (i === DOWN_WINDOW_COUNTED ? 600 : TICK));
    expect(rig.applied).toEqual([]);
    expect(rig.rung).toBe(SHORT_LADDER.mediumIndex);
  });

  it('lets two 500 ms bursts through', () => {
    const rig = new Rig(new ResolutionController(SHORT_LADDER));
    const at = [Math.round(DOWN_WINDOW_COUNTED * 0.6), Math.round(DOWN_WINDOW_COUNTED * 1.3)];
    rig.run(TWO_DOWN_WINDOWS, (_r, i) => (at.includes(i) ? 500 : TICK));
    expect(rig.applied).toEqual([]);
  });

  it('lets a hitch train through: 400 ms every 5 s for half a minute', () => {
    const rig = new Rig(new ResolutionController(SHORT_LADDER));
    rig.run(1800, (_r, i) => (i % 300 === 299 ? 400 : TICK));
    expect(rig.applied).toEqual([]);
  });

  it('is the trimmed mean, so three hitches in one window still do not step', () => {
    const rig = new Rig(new ResolutionController(SHORT_LADDER));
    // All three inside the last full window, so none of them is merely stale.
    const at = [0.4, 0.6, 0.8].map((f) => DOWN_WINDOW_COUNTED + Math.round(DOWN_WINDOW_COUNTED * f));
    rig.run(TWO_DOWN_WINDOWS + 20, (_r, i) => (at.includes(i) ? 500 : TICK));
    expect(rig.applied).toEqual([]);
    expect(TRIM_COUNT).toBe(3);
  });
});

/** The rate a stream of one-in-`late` frames a tick late really delivers. */
const rateFor = (late: number): number => 1000 / (TICK * (1 + 1 / late));

describe('the derived frame-rate boundaries at 60 Hz vsync', () => {
  it('holds still at a steady 55 fps — the tolerance band', () => {
    const rig = new Rig(new ResolutionController(FULL_LADDER));
    expect(Math.round(rateFor(11))).toBe(55);
    rig.run(4 * UP_WINDOW_COUNTED, oneInLate(11));
    expect(rig.applied).toEqual([]);
    const mean = rig.controller.state().trimmedMeanMs ?? 0;
    expect(mean).toBeGreaterThan(UP_FACTOR * BUDGET_MS);
    expect(mean).toBeLessThan(DOWN_FACTOR * BUDGET_MS);
  });

  it('steps down at a steady 50 fps', () => {
    const rig = new Rig(new ResolutionController(SHORT_LADDER));
    expect(Math.round(rateFor(5))).toBe(50);
    rig.run(TWO_DOWN_WINDOWS, oneInLate(5));
    expect(rig.applied.length).toBeGreaterThanOrEqual(1);
    expect(rig.applied[0].reason).toBe('down');
    expect(rig.applied[0].to).toBe(SHORT_LADDER.mediumIndex - 1);
  });

  it('puts the down boundary at about 52 fps, and the header quotes what the rule does', () => {
    // Derived from the rule by bisection, never transcribed: a longer window
    // is a smaller share of it for a fixed trim of three, so the share moves
    // whenever a window length does.
    const share = boundaryShare(BUDGET_MS, BUDGET_MS,
      (rig) => rig.applied.some((a) => a.reason === 'down'));
    expect(Math.round(1000 / (BUDGET_MS * (1 + share)))).toBe(52);
    // And the pair either side of it behaves the way the boundary says.
    const steps = new Rig(new ResolutionController(SHORT_LADDER));
    steps.run(TWO_DOWN_WINDOWS, oneInLate(Math.floor(1 / share)));
    expect(steps.applied.map((a) => a.reason)).toContain('down');

    const holds = new Rig(new ResolutionController(SHORT_LADDER));
    holds.run(TWO_DOWN_WINDOWS, oneInLate(Math.ceil(1 / share)));
    expect(holds.applied).toEqual([]);
  });

  it('puts the up boundary just under 59 fps', () => {
    // The same bisection read the other way round: the share at which a
    // machine STOPS being allowed to climb.
    const share = boundaryShare(BUDGET_MS, BUDGET_MS,
      (rig) => !rig.applied.some((a) => a.reason === 'up'));
    expect(1000 / (BUDGET_MS * (1 + share))).toBeGreaterThan(58);
    expect(1000 / (BUDGET_MS * (1 + share))).toBeLessThan(59);

    const climbs = new Rig(new ResolutionController(FULL_LADDER));
    sixtyRow(climbs);
    climbs.run(3 * UP_WINDOW_COUNTED, oneInLate(Math.ceil(1 / share)));
    expect(climbs.applied.map((a) => a.reason)).toContain('up');

    const holds = new Rig(new ResolutionController(FULL_LADDER));
    sixtyRow(holds);
    holds.run(3 * UP_WINDOW_COUNTED, oneInLate(Math.floor(1 / share)));
    expect(holds.applied).toEqual([]);
  });
});

describe('how long a slide takes', () => {
  it('drops the window on a down step, so the second needs its own six seconds', () => {
    const rig = new Rig(new ResolutionController(SHORT_LADDER));
    rig.run(4 * DOWN_WINDOW_COUNTED, () => 2 * TICK);
    const downs = rig.applied.filter((a) => a.reason === 'down');
    expect(downs).toHaveLength(2);
    // Not DOWN_SPACING_MS after the first: a whole fresh window of counted
    // evidence, which at this rate is more than the six seconds it is worth.
    expect(downs[1].atMs - downs[0].atMs).toBeGreaterThan(DOWN_WINDOW_S * 1000);
    expect(DOWN_SPACING_MS).toBeLessThan(DOWN_WINDOW_S * 1000);
    // Medium to the floor is therefore at least two windows of trouble.
    expect(downs[1].atMs).toBeGreaterThan(2 * DOWN_WINDOW_S * 1000);
  });

  it('holds still for five minutes at a steady 55 fps', () => {
    // The no-oscillation run at the shipped windows: nothing in the tolerance
    // band may move the picture, however long it is held.
    const rig = new Rig(new ResolutionController(FULL_LADDER));
    rig.run(Math.ceil(300_000 / TICK), oneInLate(11));
    expect(rig.nowMs).toBeGreaterThan(300_000);
    expect(rig.applied).toEqual([]);
    expect(rig.rung).toBe(FULL_LADDER.mediumIndex);
  });
});

describe('what counts', () => {
  it('excludes an over-budget interval the app itself can explain', () => {
    const rig = new Rig(new ResolutionController(SHORT_LADDER));
    rig.run(400, () => 2 * TICK, { mainThreadMs: 12 });
    expect(rig.applied).toEqual([]);
    expect(rig.controller.state().countedRate).toBe(0);
    expect(12).toBeGreaterThan(MAIN_THREAD_SHARE * BUDGET_MS);
  });

  it('counts an on-time frame whatever the main thread did — a 120 Hz panel with a 6 ms tick', () => {
    const rig = new Rig(new ResolutionController(FULL_LADDER));
    rig.run(600, () => TICK_120, { mainThreadMs: 6 });
    expect(rig.controller.state().countedRate).toBeGreaterThan(0.9);
  });

  it('charges the interval to the frame that produced it: an alternating worked/clean stream is judged on the clean intervals', () => {
    const controller = new ResolutionController(SHORT_LADDER);
    let nowMs = 0;
    // Every other frame does sliced work and takes 40 ms; the frame after it
    // is clean and quick. The interval that ENDS at the clean frame is the
    // long one, and it carries the worked frame's figures — so it must not
    // vote.
    for (let i = 0; i < 400; i++) {
      const worked = i % 2 === 1;
      const intervalMs = worked ? 40 : TICK;
      nowMs += intervalMs;
      controller.step({
        nowMs,
        intervalMs,
        mainThreadMs: 5,
        workedMs: worked ? 20 : 0,
        eligible: true,
      });
    }
    const mean = controller.state().trimmedMeanMs ?? 0;
    expect(mean).toBeCloseTo(TICK, 1);
    expect(mean).toBeLessThan(DOWN_FACTOR * BUDGET_MS);
  });

  it('ignores an ineligible frame, and will not assemble a window out of stale evidence', () => {
    const rig = new Rig(new ResolutionController(SHORT_LADDER));
    const half = Math.floor(DOWN_WINDOW_COUNTED / 2);
    // Half a window of genuinely slow frames...
    rig.run(half, () => 2 * TICK);
    expect(rig.applied).toEqual([]);
    // ...then well past the staleness horizon with nothing on screen...
    rig.run(Math.ceil(STALENESS_MS / 1000) + 5, () => 1000, { eligible: false });
    // ...then another half window, which cannot be joined to the first.
    rig.run(half, () => 2 * TICK);
    expect(rig.applied).toEqual([]);
    expect(rig.controller.state().countedWindow).toBeLessThan(DOWN_WINDOW_COUNTED);
    expect(rig.controller.state().countedWindow).toBe(half);
    // A whole fresh window does step it.
    rig.run(DOWN_WINDOW_COUNTED, () => 2 * TICK);
    expect(rig.applied.map((a) => a.reason)).toEqual(['down']);
  });
});

describe('the slide down', () => {
  it('slides a phone that is getting slower rung by rung, with spacing between steps', () => {
    const rig = new Rig(new ResolutionController(SHORT_LADDER));
    // 30 fps at medium, and each rung down really does return frames.
    rig.run(3000, (rung) => (rung === 2 ? 2 * TICK : rung === 1 ? 25 : 20));
    expect(rig.applied.map((a) => a.reason)).toEqual(['down', 'down']);
    expect(rig.rung).toBe(0);
    expect(rig.applied[1].atMs - rig.applied[0].atMs).toBeGreaterThanOrEqual(DOWN_SPACING_MS);
  });

  it('does not revert mid-slide when a step is swallowed by vsync quantisation', () => {
    const rig = new Rig(new ResolutionController(SHORT_LADDER));
    // The frame cost falls from 24 ms to 20 ms, but both are two ticks, so
    // the delivered interval does not move at all. The step is right; the
    // controller must go on rather than undo it.
    rig.run(1200, () => 2 * TICK);
    expect(rig.applied[0]).toMatchObject({ reason: 'down', to: 1 });
    expect(rig.applied[1]).toMatchObject({ reason: 'down', to: 0 });
    expect(rig.applied.slice(0, 2).some((a) => a.reason === 'revert')).toBe(false);
  });
});

describe('the floor latch', () => {
  it('hands medium back when 44 % fewer pixels changed nothing, and stops trying', () => {
    const rig = new Rig(new ResolutionController(SHORT_LADDER));
    rig.run(4 * DOWN_WINDOW_COUNTED, () => 2 * TICK);
    expect(rig.applied.map((a) => a.reason)).toEqual(['down', 'down', 'floor latch']);
    expect(rig.rung).toBe(SHORT_LADDER.mediumIndex);
    const state = rig.controller.state();
    expect(state.latch).not.toBeNull();
    expect(state.latch?.escalation).toBe(1);
    expect(state.latch?.untilMs).toBeCloseTo(rig.applied[2].atMs + LATCH_HOLD_MS[0], -1);
    // And it holds: no further down-step while the latch stands.
    const before = rig.applied.length;
    const latchedAt = rig.nowMs;
    rig.run(DOWN_WINDOW_COUNTED + 60, () => 2 * TICK);
    expect(rig.nowMs - latchedAt).toBeLessThan(LATCH_HOLD_MS[0]);
    expect(rig.applied.length).toBe(before);
  });

  it('keeps the floor when it earned it', () => {
    const rig = new Rig(new ResolutionController(SHORT_LADDER));
    // Over budget at every rung, but each rung is measurably better.
    rig.run(4 * DOWN_WINDOW_COUNTED, (rung) => (rung === 2 ? 40 : rung === 1 ? 30 : 24));
    expect(rig.applied.map((a) => a.reason)).toEqual(['down', 'down']);
    expect(rig.rung).toBe(0);
    expect(rig.controller.state().latch).toBeNull();
    const floor = rig.controller.state().trimmedMeanMs ?? 0;
    expect(floor).toBeLessThan(40 * (1 - FLOOR_LATCH_MIN_GAIN));
  });

  it('keeps a floor that beats the rung above it on a chip that throttled mid-slide', () => {
    const rig = new Rig(new ResolutionController(SHORT_LADDER));
    // Medium reads a shade over the bar as the throttle hits — one frame in
    // four a tick late, a 20.8 ms mean — and every rung below then runs on a
    // chip three times slower: 41 ms at the rung above the floor, 33 at the
    // floor. Against medium's stale 20.8 the floor is a loss; against the 41
    // it returned a fifth of the frame, which is what the pixels bought.
    rig.run(4 * DOWN_WINDOW_COUNTED, (rung, i) => (rung === 2 ? ((i + 1) % 4 === 0 ? 2 * TICK : TICK) : rung === 1 ? 41 : 33));
    expect(rig.applied.map((a) => a.reason)).toEqual(['down', 'down']);
    expect(rig.rung).toBe(0);
    expect(rig.controller.state().latch).toBeNull();
  });

  it('still hands medium back when the floor beats neither reading', () => {
    const rig = new Rig(new ResolutionController(SHORT_LADDER));
    // The same throttle mid-slide, but the floor reads what the rung above
    // read: the pixels bought nothing at all.
    rig.run(4 * DOWN_WINDOW_COUNTED, (rung, i) => (rung === 2 ? ((i + 1) % 4 === 0 ? 2 * TICK : TICK) : 41));
    expect(rig.applied.map((a) => a.reason)).toEqual(['down', 'down', 'floor latch']);
    expect(rig.rung).toBe(SHORT_LADDER.mediumIndex);
    expect(rig.controller.state().latch?.escalation).toBe(1);
  });

  it('escalates a minute, four minutes, then the session', () => {
    const rig = new Rig(new ResolutionController(SHORT_LADDER));
    // Fifteen minutes of a device that is not pixel-bound: it slides to the
    // floor, is handed medium back, waits out the latch and tries again.
    rig.run(54_000, () => 2 * TICK);
    const latched = rig.applied.filter((a) => a.reason === 'floor latch');
    expect(latched.length).toBe(3);
    const state = rig.controller.state();
    expect(state.latch?.escalation).toBe(3);
    expect(state.latch?.untilMs).toBe(Infinity);
    expect(rig.rung).toBe(SHORT_LADDER.mediumIndex);
    // The three latches are a minute, then four minutes, then for good.
    expect(latched[1].atMs - latched[0].atMs).toBeGreaterThan(LATCH_HOLD_MS[0]);
    expect(latched[2].atMs - latched[1].atMs).toBeGreaterThan(LATCH_HOLD_MS[1]);
  });
});

describe('an up probe and its verification', () => {
  it('climbs a 120 Hz Mac one rung at a time to the top while every frame fits one tick', () => {
    const rig = new Rig(new ResolutionController(FULL_LADDER));
    fastScreen(rig);
    rig.run(4000, () => TICK_120);
    expect(rig.applied.map((a) => a.reason)).toEqual(['up', 'up']);
    expect(rig.rung).toBe(FULL_LADDER.rungs.length - 1);
    expect(rig.controller.state().probeWaitMs).toBe(PROBE_WAIT_MS);
  });

  it('reverts a probe whose next second is over budget inside 1.25 s, doubles the wait and latches a ceiling', () => {
    const rig = new Rig(new ResolutionController(FULL_LADDER));
    sixtyRow(rig);
    // Fine at medium; the moment it climbs, the frame goes to 30 fps.
    rig.run(1200, (rung) => (rung > FULL_LADDER.mediumIndex ? 2 * TICK : TICK));
    const up = rig.applied.find((a) => a.reason === 'up');
    const revert = rig.applied.find((a) => a.reason === 'revert');
    expect(up).toBeDefined();
    expect(revert).toBeDefined();
    expect((revert?.atMs ?? 0) - (up?.atMs ?? 0)).toBeLessThanOrEqual(REALLOC_SETTLE_MS + VERIFY_MS + 2 * TICK);
    expect(revert?.to).toBe(FULL_LADDER.mediumIndex);
    const state = rig.controller.state();
    expect(state.probeWaitMs).toBe(2 * PROBE_WAIT_MS);
    expect(state.ceiling?.rung).toBe(FULL_LADDER.mediumIndex + 1);
    expect(state.ceiling?.untilMs).toBeCloseTo((revert?.atMs ?? 0) + CEILING_HOLD_MS[0], -1);
    expect(state.ceiling?.escalation).toBe(1);
  });

  it('backs off 8, 16, 32 seconds, and each failure at the same rung holds the ceiling longer', () => {
    const rig = new Rig(new ResolutionController(FULL_LADDER));
    sixtyRow(rig);
    const waits: number[] = [];
    // Thirteen minutes of a device whose frames miss the moment it climbs.
    for (let i = 0; i < 6; i++) {
      rig.run(8000, (rung) => (rung > FULL_LADDER.mediumIndex ? 2 * TICK : TICK));
      waits.push(rig.controller.state().probeWaitMs);
    }
    // Three probes and three reverts: a minute's hold after the first, four
    // minutes after the second, and the sixteen after the third outlasts the
    // run.
    const reverts = rig.applied.filter((a) => a.reason === 'revert');
    expect(rig.applied.filter((a) => a.reason === 'up')).toHaveLength(3);
    expect(reverts).toHaveLength(3);
    expect(reverts[1].atMs - reverts[0].atMs).toBeGreaterThan(CEILING_HOLD_MS[0]);
    expect(reverts[2].atMs - reverts[1].atMs).toBeGreaterThan(CEILING_HOLD_MS[1]);
    // 8 s, doubled once per failure.
    expect(Math.max(...waits)).toBe(8 * PROBE_WAIT_MS);
    const state = rig.controller.state();
    expect(state.ceiling?.rung).toBe(FULL_LADDER.mediumIndex + 1);
    expect(state.ceiling?.escalation).toBe(3);
    expect(rig.rung).toBe(FULL_LADDER.mediumIndex);
  });

  it('escalates a minute, four, sixteen, then the session, and never probes that rung again', () => {
    const rig = new Rig(new ResolutionController(FULL_LADDER));
    sixtyRow(rig);
    // Forty minutes of the same device: four probes in the first twenty-two
    // minutes, then silence.
    rig.run(144_000, (rung) => (rung > FULL_LADDER.mediumIndex ? 2 * TICK : TICK));
    const reverts = rig.applied.filter((a) => a.reason === 'revert');
    expect(rig.applied.filter((a) => a.reason === 'up')).toHaveLength(4);
    expect(reverts).toHaveLength(4);
    expect(reverts[3].atMs - reverts[2].atMs).toBeGreaterThan(CEILING_HOLD_MS[2]);
    expect(reverts[3].atMs).toBeLessThan(22 * 60_000);
    const state = rig.controller.state();
    expect(state.ceiling?.escalation).toBe(4);
    expect(state.ceiling?.untilMs).toBe(Infinity);
    expect(rig.rung).toBe(FULL_LADDER.mediumIndex);
  });

  it('a probe that holds resets the escalation for that rung', () => {
    const rig = new Rig(new ResolutionController(FULL_LADDER));
    sixtyRow(rig);
    // Two failures at the first rung above medium in the first 200 s, then
    // the frames fit there.
    let fits = false;
    const frame = (rung: number) => (rung > FULL_LADDER.mediumIndex && !fits ? 2 * TICK : TICK);
    rig.run(12_000, frame);
    expect(rig.controller.state().ceiling?.escalation).toBe(2);
    fits = true;
    rig.run(20_000, frame);
    // The four-minute ceiling ran out and the probe held through its whole
    // probation.
    expect(rig.rung).toBeGreaterThan(FULL_LADDER.mediumIndex);
    expect(rig.controller.state().ceiling).toBeNull();
    expect(rig.controller.state().probation).toBeNull();
    // Then the frames miss again: a slide down, and the next failed probe
    // starts a fresh count rather than escalating from where it left off.
    fits = false;
    // A minute: long enough for the slide down and one failed probe, short of
    // the second that the first's minute-long ceiling would allow.
    rig.run(4_000, frame);
    const reverts = rig.applied.filter((a) => a.reason === 'revert');
    expect(reverts.length).toBe(3);
    expect(rig.controller.state().ceiling?.escalation).toBe(1);
  });

  it('a budget change clears the ceiling and its escalation, because it was a ceiling for another question', () => {
    const rig = new Rig(new ResolutionController(FULL_LADDER));
    sixtyRow(rig);
    rig.run(24_000, (rung) => (rung > FULL_LADDER.mediumIndex ? 2 * TICK : TICK));
    expect(rig.controller.state().ceiling?.escalation).toBe(3);
    rig.controller.setBudget(1000 / 30, rig.nowMs, { cause: 'user' });
    expect(rig.controller.state().ceiling).toBeNull();
  });
});

describe('an up-step on probation', () => {
  /** The straddle: the rung above medium passes its verification second by a
   *  hair and then sits a hair over the down bar, while medium sits under the
   *  up bar — the pose a Mac at a tight budget showed, where the picture
   *  cycled every ten to forty seconds with nothing failing. */
  function straddle(rig: Rig): (rung: number) => number {
    return (rung) => {
      if (rung <= FULL_LADDER.mediumIndex) return TICK;
      const lastUp = [...rig.applied].reverse().find((a) => a.reason === 'up');
      const sinceUp = rig.nowMs - (lastUp?.atMs ?? 0);
      return sinceUp < REALLOC_SETTLE_MS + VERIFY_MS + 250 ? 1.14 * TICK : 1.16 * TICK;
    };
  }

  it('a rung handed back inside two minutes is a failed probe, so a straddle escalates instead of hunting', () => {
    const rig = new Rig(new ResolutionController(FULL_LADDER));
    sixtyRow(rig);
    // Half an hour at the straddle.
    rig.run(108_000, straddle(rig));
    const ups = rig.applied.filter((a) => a.reason === 'up');
    const reverts = rig.applied.filter((a) => a.reason === 'revert');
    // Every step back down is the probe failing; none is a plain slide.
    expect(rig.applied.filter((a) => a.reason === 'down')).toEqual([]);
    expect(ups).toHaveLength(4);
    expect(reverts).toHaveLength(4);
    // The first hand-back comes from the down window, after the verification
    // second let the rung through.
    expect(reverts[0].atMs - ups[0].atMs).toBeGreaterThan(REALLOC_SETTLE_MS + VERIFY_MS);
    expect(reverts[0].atMs - ups[0].atMs).toBeLessThan(2 * DOWN_WINDOW_S * 1000);
    // A minute, four, sixteen, then the session: eight changes inside
    // twenty-two minutes and nothing after.
    expect(ups[1].atMs - reverts[0].atMs).toBeGreaterThanOrEqual(CEILING_HOLD_MS[0]);
    expect(ups[2].atMs - reverts[1].atMs).toBeGreaterThanOrEqual(CEILING_HOLD_MS[1]);
    expect(ups[3].atMs - reverts[2].atMs).toBeGreaterThanOrEqual(CEILING_HOLD_MS[2]);
    expect(reverts[3].atMs).toBeLessThan(22 * 60_000);
    const state = rig.controller.state();
    expect(state.ceiling?.rung).toBe(FULL_LADDER.mediumIndex + 1);
    expect(state.ceiling?.escalation).toBe(4);
    expect(state.ceiling?.untilMs).toBe(Infinity);
    expect(state.probation).toBeNull();
    expect(rig.rung).toBe(FULL_LADDER.mediumIndex);
  });

  /** One rung above medium, so a device whose frames fit has one probe to
   *  make and then nothing to climb to. */
  const ONE_UP_LADDER: RungLadder = { rungs: [2 / 1.33, 2 / 1.15, 2, 2.5], mediumIndex: 2 };

  it('a down more than two minutes after a probe is a slide, and the probation is reported while it stands', () => {
    const rig = new Rig(new ResolutionController(ONE_UP_LADDER));
    sixtyRow(rig);
    let slow = false;
    const frame = (rung: number) => (rung > ONE_UP_LADDER.mediumIndex && slow ? 1.16 * TICK : TICK);
    // One probe up, then a hold well past the probation.
    rig.run(1200, frame);
    const up = rig.applied.find((a) => a.reason === 'up');
    expect(up).toBeDefined();
    expect(rig.controller.state().probation).toEqual({
      rung: ONE_UP_LADDER.mediumIndex + 1,
      untilMs: (up?.atMs ?? 0) + PROBE_HOLD_MS,
    });
    rig.run(Math.round(PROBE_HOLD_MS / TICK), frame);
    expect(rig.controller.state().probation).toBeNull();
    // Then the frames go over the bar: a plain slide, no ceiling.
    slow = true;
    rig.run(600, frame);
    const last = rig.applied[rig.applied.length - 1];
    expect(last.reason).toBe('down');
    expect(rig.controller.state().ceiling).toBeNull();
    expect(rig.controller.state().probeWaitMs).toBe(PROBE_WAIT_MS);
  });

  it('an arrival ends the probation: a down after a new pose is a new question', () => {
    const rig = new Rig(new ResolutionController(ONE_UP_LADDER));
    sixtyRow(rig);
    let slow = false;
    const frame = (rung: number) => (rung > ONE_UP_LADDER.mediumIndex && slow ? 1.16 * TICK : TICK);
    rig.run(1200, frame);
    expect(rig.controller.state().probation).not.toBeNull();
    rig.controller.notify('arrival', rig.nowMs);
    expect(rig.controller.state().probation).toBeNull();
    slow = true;
    rig.run(600, frame);
    const last = rig.applied[rig.applied.length - 1];
    expect(last.reason).toBe('down');
    expect(rig.controller.state().ceiling).toBeNull();
  });
});

describe('a rung above Medium is held to the display’s own tick', () => {
  it('never climbs above Medium on a 60 Hz display at the row’s default', () => {
    // Every frame on time reads 16.67 ms whether it cost 11 ms or 16, so the
    // rule cannot see headroom and must not climb blind: a phone at Earth's
    // shell was measured going from a locked 60 fps into the fifties that way.
    const fresh = new Rig(new ResolutionController(FULL_LADDER));
    fresh.run(6000, () => TICK);
    expect(fresh.applied).toEqual([]);
    expect(fresh.rung).toBe(FULL_LADDER.mediumIndex);
    expect(fresh.controller.state().aboveAllowed).toBe(false);
    // Nor once the display has been calibrated at 60.
    const calibrated = new Rig(new ResolutionController(FULL_LADDER));
    calibrated.controller.setBudget(null, 0, { cause: 'auto', above: { budgetMs: BUDGET_MS, allowed: false } });
    calibrated.run(6000, () => TICK);
    expect(calibrated.applied).toEqual([]);
  });

  it('climbs a 120 Hz display only while the frame fits one tick, and keeps the rate over the pixels', () => {
    /** Medium and the rung above fit one vsync; the sharpest needs two. The
     *  earlier rule spent the refresh rate on the sharper picture — a Mac
     *  measured going from 120 fps to 80 — and now the sharper rung is kept
     *  only while 120 holds. */
    const machine = (rung: number): number => (rung > FULL_LADDER.mediumIndex + 1 ? TICK : TICK_120);
    const rig = new Rig(new ResolutionController(FULL_LADDER));
    fastScreen(rig);
    rig.run(12_000, machine);
    expect(rig.rung).toBe(FULL_LADDER.mediumIndex + 1);
    // The probe to the sharpest rung came back inside its verification second
    // and its rung is held as a ceiling.
    expect(rig.applied.filter((a) => a.reason === 'revert').length).toBeGreaterThanOrEqual(1);
    expect(rig.controller.state().ceiling?.rung).toBe(FULL_LADDER.mediumIndex + 2);
  });

  it('hands a sharper rung back when the screen’s rate is lost, and never goes below Medium for it', () => {
    const rig = new Rig(new ResolutionController(FULL_LADDER));
    fastScreen(rig);
    rig.run(3000, () => TICK_120);
    expect(rig.rung).toBeGreaterThan(FULL_LADDER.mediumIndex);
    // Two ticks a frame: a perfectly even 60 fps, which loses the sharper
    // rungs one at a time and is exactly what Medium is allowed to cost.
    rig.run(3000, () => TICK);
    expect(rig.rung).toBe(FULL_LADDER.mediumIndex);
    expect(rig.applied.every((a) => a.to >= FULL_LADDER.mediumIndex)).toBe(true);
    // Four ticks is 30 fps, which Medium is not allowed to cost — and a rung
    // below it that really is cheaper is kept (a floor that changed nothing
    // would be the not-pixel-bound latch, which is another test).
    rig.run(1200, (rung) => (rung >= FULL_LADDER.mediumIndex ? 2 * TICK : TICK));
    expect(rig.rung).toBeLessThan(FULL_LADDER.mediumIndex);
  });

  it('a row’s target is defended with pixels in both directions', () => {
    // The 60 fps row on any display: the user asked for 60, so the picture is
    // as sharp as 60 allows, which is the rule the default used to have.
    const rig = new Rig(new ResolutionController(FULL_LADDER));
    sixtyRow(rig);
    rig.run(4000, () => TICK);
    expect(rig.applied.map((a) => a.reason)).toEqual(['up', 'up']);
    expect(rig.controller.state().aboveAllowed).toBe(true);
    expect(rig.controller.state().aboveBudgetMs).toBeCloseTo(1000 / 60, 6);
    // And Screen on a 120 Hz display reports the tick it holds the climb to.
    const fast = new Rig(new ResolutionController(FULL_LADDER));
    fastScreen(fast);
    expect(fast.controller.state().aboveBudgetMs).toBeCloseTo(TICK_120, 6);
    expect(fast.controller.state().budgetMs).toBeCloseTo(BUDGET_MS, 6);
  });

  it('steps down on the budget, not on the panel period', () => {
    const rig = new Rig(new ResolutionController(SHORT_LADDER));
    fastScreen(rig);
    // A 120 Hz phone panel delivering two ticks: 60 fps, which is fine.
    rig.run(1200, () => TICK);
    expect(rig.applied).toEqual([]);
    // Four ticks is 30 fps, which is not.
    rig.run(1200, () => 2 * TICK);
    expect(rig.applied.map((a) => a.reason)).toContain('down');
  });
});

describe('events', () => {
  it('holds still while a pin is in force, and takes no evidence from it', () => {
    const rig = new Rig(new ResolutionController(SHORT_LADDER));
    rig.controller.notify('pin', 0);
    rig.run(1200, () => 2 * TICK);
    expect(rig.applied).toEqual([]);
    expect(rig.controller.state().idle).toBe(true);
    expect(rig.controller.state().countedWindow).toBe(0);
    rig.controller.notify('unpin', rig.nowMs);
    expect(rig.controller.state().idle).toBe(false);
    rig.run(DOWN_WINDOW_COUNTED + 40, () => 2 * TICK);
    expect(rig.applied.map((a) => a.reason)).toEqual(['down']);
  });

  it('drops the window on an arrival or a resize rather than reading across it', () => {
    const rig = new Rig(new ResolutionController(SHORT_LADDER));
    const nearly = DOWN_WINDOW_COUNTED - 10;
    rig.run(nearly, () => 2 * TICK);
    rig.controller.notify('arrival', rig.nowMs);
    expect(rig.controller.state().countedWindow).toBe(0);
    rig.run(nearly, () => 2 * TICK);
    expect(rig.applied).toEqual([]);
    rig.run(30, () => 2 * TICK);
    expect(rig.applied.map((a) => a.reason)).toEqual(['down']);
  });

  it('a focus gain steps nothing by itself, and drops the evidence it gained across', () => {
    const rig = new Rig(new ResolutionController(SHORT_LADDER));
    rig.run(DOWN_WINDOW_COUNTED - 10, () => 2 * TICK);
    // Away for a while: those intervals are the browser's throttle.
    rig.run(200, () => 900, { eligible: false });
    rig.controller.notify('focus', rig.nowMs);
    expect(rig.controller.state().countedWindow).toBe(0);
    rig.run(10, () => 2 * TICK);
    expect(rig.applied).toEqual([]);
  });

  it('cannot slide while nobody is looking, so there is nothing to hand back', () => {
    const rig = new Rig(new ResolutionController(SHORT_LADDER));
    // A minute of throttled frames with an idle main thread — what an
    // occluded window delivers — must move nothing.
    rig.run(60, () => 1000, { eligible: false });
    rig.controller.notify('focus', rig.nowMs);
    rig.run(10, () => TICK);
    expect(rig.applied).toEqual([]);
    expect(rig.rung).toBe(SHORT_LADDER.mediumIndex);
  });
});

describe('setLadder', () => {
  it('re-clamps the current rung to the nearest the new ladder offers', () => {
    const rig = new Rig(new ResolutionController(FULL_LADDER));
    sixtyRow(rig);
    rig.run(4000, () => TICK);
    expect(rig.rung).toBe(4);
    const decision = rig.controller.setLadder(SHORT_LADDER, rig.nowMs);
    expect(decision).toEqual({ to: 2, reason: 'ladder' });
    expect(rig.controller.state().sceneRatio).toBe(2);
    expect(rig.controller.state().countedWindow).toBe(0);
  });

  it('says nothing when the scene ratio is unchanged', () => {
    const controller = new ResolutionController(FULL_LADDER);
    expect(controller.setLadder({ rungs: [1.5, 1.74, 2, 2.5], mediumIndex: 2 }, 1000)).toBeNull();
    expect(controller.state().sceneRatio).toBe(2);
  });

  it('settles after the re-clamp instead of deciding on the old evidence', () => {
    const rig = new Rig(new ResolutionController(SHORT_LADDER));
    rig.run(DOWN_WINDOW_COUNTED - 10, () => 2 * TICK);
    rig.controller.setLadder(SHORT_LADDER, rig.nowMs);
    // Enough frames to have finished the window it was denied.
    rig.run(30, () => 2 * TICK);
    expect(rig.applied).toEqual([]);
  });
});

describe('diagnosis', () => {
  it('reports a counted rate of zero and how long it has been silent', () => {
    const rig = new Rig(new ResolutionController(SHORT_LADDER));
    rig.run(2000, () => TICK, { eligible: false });
    const state = rig.controller.state();
    expect(state.countedRate).toBe(0);
    expect(state.silentMs).toBeGreaterThan(ZERO_COUNTED_WARN_MS);
    expect(state.silentMs).toBeCloseTo(rig.nowMs, -2);
    expect(state.trimmedMeanMs).toBeNull();
  });

  it('reports the window, the ladder and the budget it is running', () => {
    const rig = new Rig(new ResolutionController(FULL_LADDER));
    // Past a down window and short of an up one, so both bounds below bite.
    rig.run(DOWN_WINDOW_COUNTED + 60, () => TICK);
    const state = rig.controller.state();
    expect(state.budgetMs).toBeCloseTo(BUDGET_MS, 6);
    expect(state.downCounted).toBe(DOWN_WINDOW_COUNTED);
    expect(state.upCounted).toBe(UP_WINDOW_COUNTED);
    expect(state.ceiling).toBeNull();
    // Until a display with a finer tick than 60 fps says so, no rung above
    // Medium is taken on its own.
    expect(state.aboveAllowed).toBe(false);
    expect(state.aboveBudgetMs).toBeCloseTo(BUDGET_MS, 6);
    expect(state.rung).toBe(2);
    expect(state.sceneRatio).toBe(2);
    expect(state.countedWindow).toBeGreaterThan(DOWN_WINDOW_COUNTED);
    expect(state.countedWindow).toBeLessThanOrEqual(UP_WINDOW_COUNTED);
    expect(state.trimmedMeanMs).toBeCloseTo(TICK, 2);
    expect(state.floorReference).toBeNull();
    expect(state.lastStep).toBeNull();
  });

  it('records what the floor has to beat once a slide starts', () => {
    const rig = new Rig(new ResolutionController(SHORT_LADDER));
    rig.run(DOWN_WINDOW_COUNTED + 40, () => 2 * TICK);
    expect(rig.applied.map((a) => a.reason)).toEqual(['down']);
    expect(rig.controller.state().floorReference).toBeCloseTo(2 * TICK, 1);
    expect(rig.controller.state().lastStep).toMatchObject({ from: 2, to: 1, reason: 'down' });
  });
});

// ---------------------------------------------------------------- the budget
//
// The Frame rate row moves what a frame is measured against. These pin what
// that does to the windows, the boundaries and the evidence — and that at the
// row's default nothing here is touched at all.

/** Every boundary in the header derived from the rule itself, at a budget, by
 *  bisection on the share of frames that come in a tick late. */
function boundaryShare(
  budgetMs: number,
  refreshMs: number,
  decide: (rig: Rig) => boolean,
): number {
  let low = 0;
  let high = 1;
  for (let step = 0; step < 18; step++) {
    const p = (low + high) / 2;
    const rig = new Rig(new ResolutionController(FULL_LADDER));
    rig.controller.setBudget(budgetMs, 0, { cause: 'user', quantised: budgetMs > refreshMs * 1.5 });
    // A deterministic share, not a random one: every 1/p-th frame is late by
    // one refresh, which is what a vsync miss costs.
    const every = p <= 0 ? Infinity : Math.round(1 / p);
    rig.run(Math.round(60_000 / budgetMs), (_r, i) => (
      every !== Infinity && i % every === every - 1 ? budgetMs + refreshMs : budgetMs
    ));
    if (decide(rig)) high = p;
    else low = p;
  }
  return (low + high) / 2;
}

describe('the budget the Frame rate row sets', () => {
  it('converts the windows from seconds, and 60 fps is today to the interval', () => {
    const controller = new ResolutionController(FULL_LADDER);
    // The two figures the header quotes, at the default budget.
    expect(controller.state().downCounted).toBe(360);
    expect(controller.state().upCounted).toBe(600);
    // And at every other budget the counts are still the same SECONDS: the
    // property the seconds-authored windows exist for, derived rather than
    // transcribed, so a window length that moves cannot leave a row behind.
    for (const budgetMs of [1000 / 60, 1000 / 30, 1000 / 120, 1000 / 144, 1000 / 240]) {
      controller.setBudget(budgetMs, 0, { cause: 'user' });
      const { downCounted, upCounted } = controller.state();
      expect(downCounted * budgetMs).toBeCloseTo(DOWN_WINDOW_S * 1000, 0);
      expect(upCounted * budgetMs).toBeCloseTo(UP_WINDOW_S * 1000, 0);
      expect(Number.isInteger(downCounted) && Number.isInteger(upCounted)).toBe(true);
    }
  });

  it('gives the longest window room inside the staleness horizon', () => {
    // Ten seconds of COUNTED evidence at the 55 % counted rate a streaming
    // flight leaves has to fit inside the horizon, or the up path could never
    // assemble a window at all: 18.2 s against 20 s.
    const span = (UP_WINDOW_COUNTED / 0.55) * BUDGET_MS;
    expect(Math.round(span / 100) / 10).toBe(18.2);
    expect(span).toBeGreaterThan(UP_WINDOW_S * 1000);
    expect(span).toBeLessThan(STALENESS_MS);
  });

  it('re-allocates the ring, so a 120 fps target can fill an up window at all', () => {
    const rig = new Rig(new ResolutionController(FULL_LADDER));
    rig.controller.setBudget(1000 / 120, 0, { cause: 'user', quantised: false });
    const wanted = rig.controller.state().upCounted;
    expect(wanted).toBeGreaterThan(UP_WINDOW_COUNTED);
    // The window has to be able to HOLD that many intervals at 8.33 ms — with
    // the ring the default budget sizes it never could, and a 120 fps target
    // would have been unable to probe up at all.
    rig.run(wanted + 200, () => 1000 / 240);
    expect(rig.controller.state().countedWindow).toBeGreaterThanOrEqual(wanted);
    // And past the probe wait it climbs.
    rig.run(3000, () => 1000 / 240);
    expect(rig.applied.map((a) => a.reason)).toContain('up');
  });

  it('derives its down and up boundaries at every budget', () => {
    const rows: { budgetMs: number; refreshMs: number }[] = [
      { budgetMs: 1000 / 60, refreshMs: 1000 / 60 },
      { budgetMs: 1000 / 30, refreshMs: 1000 / 60 },
      { budgetMs: 1000 / 120, refreshMs: 1000 / 120 },
    ];
    for (const row of rows) {
      const down = boundaryShare(row.budgetMs, row.refreshMs,
        (rig) => rig.applied.some((a) => a.reason === 'down'));
      // The rule's own arithmetic: the trimmed mean passes DOWN_FACTOR of the
      // budget when the share of late frames does.
      const predicted = (DOWN_FACTOR - 1) * row.budgetMs / row.refreshMs;
      expect(down).toBeGreaterThan(predicted * 0.7);
      expect(down).toBeLessThan(predicted * 1.5);
    }
  });

  it('holds still for five minutes at 28 ms against a 33 ms budget', () => {
    // The phone interim: a fixed level plus a 30 fps target, with frames that
    // fit the period. Nothing may oscillate.
    const rig = new Rig(new ResolutionController(FULL_LADDER));
    rig.controller.setBudget(1000 / 30, 0, { cause: 'user', quantised: true });
    rig.run(Math.round(300_000 / (1000 / 30)), (rung) => (rung > FULL_LADDER.mediumIndex ? 40 : 1000 / 30), {
      mainThreadMs: 5,
      mainThreadSumMs: 9,
    });
    // At most two probes up and their reverts, then quiet: the ceiling holds
    // a minute after the first failure and four after the second, so a third
    // cannot come inside five minutes.
    expect(rig.applied.filter((a) => a.reason === 'down')).toEqual([]);
    expect(rig.applied.filter((a) => a.reason === 'up').length).toBeLessThanOrEqual(2);
    expect(rig.rung).toBe(FULL_LADDER.mediumIndex);
  });

  it('climbs back out of Low at a 30 fps target once the device cools', () => {
    const rig = new Rig(new ResolutionController(SHORT_LADDER));
    rig.controller.setBudget(1000 / 30, 0, { cause: 'user', quantised: true });
    // Hot, and pixel-bound: every rung down really is cheaper, so the slide
    // reaches the floor and the floor check holds it there.
    const hot = [1000 / 30, 42, 50];
    rig.run(1200, (rung) => hot[rung], { mainThreadMs: 4, mainThreadSumMs: 8 });
    expect(rig.rung).toBe(0);
    expect(rig.controller.state().latch).toBeNull();
    // Cooled: eight seconds of counted evidence plus the probe wait per rung
    // gets the picture back, rather than never.
    rig.run(3000, () => 1000 / 30, { mainThreadMs: 4, mainThreadSumMs: 8 });
    expect(rig.rung).toBe(SHORT_LADDER.mediumIndex);
  });

  it('asks for headroom before probing up only where a draw covers several ticks', () => {
    const busy = { mainThreadMs: 9, mainThreadSumMs: 25 };
    // Quantised: 25 ms of main thread inside a 33 ms interval is no headroom.
    const capped = new Rig(new ResolutionController(FULL_LADDER));
    capped.controller.setBudget(1000 / 30, 0, { cause: 'user', quantised: true });
    capped.run(1400, () => 1000 / 30, busy);
    expect(capped.applied.filter((a) => a.reason === 'up')).toEqual([]);
    // The same evidence with one draw per callback is the up path this branch
    // has always had, and it probes.
    const plain = new Rig(new ResolutionController(FULL_LADDER));
    plain.controller.setBudget(1000 / 30, 0, { cause: 'user', quantised: false });
    plain.run(1400, () => 1000 / 30, busy);
    expect(plain.applied.map((a) => a.reason)).toContain('up');
  });

  it('takes the sum for headroom and the longest tick for exclusion', () => {
    // A 15 ms drawn tick with three 2 ms skipped ticks behind it: max 15,
    // sum 21. Over budget, the app can explain it, so it does not count.
    const rig = new Rig(new ResolutionController(SHORT_LADDER));
    rig.controller.setBudget(1000 / 30, 0, { cause: 'user', quantised: true });
    rig.run(400, () => 45, { mainThreadMs: 15, mainThreadSumMs: 21 });
    expect(rig.applied).toEqual([]);
    expect(rig.controller.state().countedWindow).toBe(0);
    // The same span with a 6 ms drawn tick is evidence, and steps down.
    const counted = new Rig(new ResolutionController(SHORT_LADDER));
    counted.controller.setBudget(1000 / 30, 0, { cause: 'user', quantised: true });
    counted.run(400, () => 45, { mainThreadMs: 6, mainThreadSumMs: 12 });
    expect(counted.applied.map((a) => a.reason)).toContain('down');
  });

  it('takes mainThreadMs as the sum where a caller gives only one figure', () => {
    // The bridge shape a harness writes: one main-thread number per sample.
    const rig = new Rig(new ResolutionController(FULL_LADDER));
    rig.controller.setBudget(1000 / 30, 0, { cause: 'user', quantised: true });
    rig.run(1400, () => 1000 / 30, { mainThreadMs: 25 });
    expect(rig.applied.filter((a) => a.reason === 'up')).toEqual([]);
  });
});

describe('what a budget change invalidates', () => {
  it('drops the evidence and moves no rung', () => {
    const rig = new Rig(new ResolutionController(SHORT_LADDER));
    rig.run(DOWN_WINDOW_COUNTED - 10, () => 2 * TICK);
    rig.controller.setBudget(1000 / 30, rig.nowMs, { cause: 'user' });
    expect(rig.controller.state().countedWindow).toBe(0);
    expect(rig.rung).toBe(SHORT_LADDER.mediumIndex);
    expect(rig.applied).toEqual([]);
  });

  it('a USER change drops the not-pixel-bound latch; an AUTOMATIC one keeps it', () => {
    const latched = (): Rig => {
      const rig = new Rig(new ResolutionController(SHORT_LADDER));
      // Slide to the floor on frames fewer pixels do not help, and be handed
      // medium back with the latch: two down windows and the floor's own.
      rig.run(4 * DOWN_WINDOW_COUNTED, () => 2 * TICK);
      expect(rig.controller.state().latch).not.toBeNull();
      return rig;
    };
    const auto = latched();
    auto.controller.setBudget(1000 / 30, auto.nowMs, { cause: 'auto' });
    expect(auto.controller.state().latch).not.toBeNull();
    const user = latched();
    user.controller.setBudget(1000 / 30, user.nowMs, { cause: 'user' });
    expect(user.controller.state().latch).toBeNull();
  });

  it('null is the default budget, which is what Screen holds', () => {
    const controller = new ResolutionController(FULL_LADDER);
    controller.setBudget(1000 / 30, 0, { cause: 'user' });
    expect(controller.state().budgetMs).toBeCloseTo(1000 / 30, 6);
    controller.setBudget(null, 0, { cause: 'user' });
    expect(controller.state().budgetMs).toBeCloseTo(BUDGET_MS, 6);
    expect(controller.state().downCounted).toBe(DOWN_WINDOW_COUNTED);
  });
});

// ---------------------------------------------------------------------------
// The GPU clock, where the tick is blind.
// ---------------------------------------------------------------------------

/** What the clock reads for one sampled frame: a number is a trusted reading
 *  with 2 ms of it spent building the frame; null is no reading at all. */
type ClockRead = number | { readingMs: number; busyMs?: number; starved?: boolean } | null;

/**
 * The Rig with the sensor beside it, as main.ts drives the pair: each drawn
 * frame is tagged with its draw number and the generation at the end of its
 * draw, one eligible frame in `duty` is fenced when the controller wants a
 * reading and none is out, and the reading arrives `lag` steps later —
 * paired, as the real one is, with the draw it measured. A lag of 1 is a
 * reading that finished before the next callback; 2 or more is one that came
 * in late.
 */
class ClockRig extends Rig {
  drawSeq = 0;
  duty = 4;
  lag = 1;
  /** Deliver readings even where the controller says it would not read them. */
  force = false;
  delivered = 0;
  private countdown = 0;
  private steps = 0;
  private inFlight: { dueStep: number; obs: GpuObservation } | null = null;

  runClock(
    frames: number,
    interval: (rung: number, i: number) => number,
    clock: (rung: number, i: number) => ClockRead,
    over: Partial<IntervalSample> = {},
  ): void {
    for (let i = 0; i < frames; i++) {
      const rung = this.controller.rung;
      const intervalMs = interval(rung, i);
      this.nowMs += intervalMs;
      this.steps++;
      let gpu: GpuObservation | null = null;
      if (this.inFlight !== null && this.inFlight.dueStep <= this.steps) {
        gpu = this.inFlight.obs;
        this.inFlight = null;
        this.delivered++;
      }
      const sample: IntervalSample = {
        nowMs: this.nowMs,
        intervalMs,
        mainThreadMs: 5,
        workedMs: 0,
        eligible: true,
        drawSeq: this.drawSeq,
        gpu,
        ...over,
      };
      const decision = this.controller.step(sample);
      if (decision !== null) this.apply(decision);
      // This tick's draw, at the rung any decision just applied.
      this.drawSeq++;
      if (!this.force && !this.controller.wantsClock()) continue;
      if (this.countdown > 0) { this.countdown--; continue; }
      if (this.inFlight !== null) continue;
      const read = clock(this.controller.rung, i);
      if (read === null) continue;
      this.countdown = this.duty - 1;
      const r = typeof read === 'number' ? { readingMs: read } : read;
      this.inFlight = {
        dueStep: this.steps + this.lag,
        obs: {
          drawSeq: this.drawSeq,
          generation: this.controller.generation,
          sampledAtMs: this.nowMs,
          readingMs: r.readingMs,
          busyMs: r.busyMs ?? 2,
          starved: r.starved ?? false,
          gridMs: 1,
        },
      };
    }
  }

  /** Drop whatever is out, the way a duty change does. */
  dropInFlight(): void {
    this.inFlight = null;
  }
}

/** A 60 Hz display under Screen: the tick is not finer than the budget and no
 *  row asked for a rate, so the intervals take no rung above Medium. */
function blindScreen(rig: Rig): void {
  rig.controller.setBudget(null, 0, { cause: 'auto', above: { budgetMs: BUDGET_MS, allowed: false } });
}

/** Seconds of frames at the 60 Hz tick. */
const seconds = (s: number): number => Math.round((s * 1000) / TICK);

const MEDIUM = FULL_LADDER.mediumIndex;
const TOP = FULL_LADDER.rungs.length - 1;

/** One rung above Medium, so a heating device has one rung to earn and lose. */
const ONE_ABOVE: RungLadder = { rungs: [2 / 1.33, 2 / 1.15, 2, 2.5], mediumIndex: 2 };

/** A clean 60 fps stream. */
const onTime = (): number => TICK;

describe('the GPU clock climbs where the tick is blind', () => {
  it('climbs a 60 Hz display to the top at 7 ms and holds, without redefining aboveAllowed', () => {
    const rig = new ClockRig(new ResolutionController(FULL_LADDER));
    blindScreen(rig);
    rig.runClock(seconds(60), onTime, () => 7);
    expect(rig.applied.map((a) => a.reason)).toEqual(['up', 'up']);
    expect(rig.rung).toBe(TOP);
    const state = rig.controller.state();
    expect(state.aboveAllowed).toBe(false);
    expect(state.clock.steering).toBe(true);
    expect(state.clock.earned).toBe(true);
    expect(state.clock.verify).toBeNull();
    expect(state.clock.last?.why).toBe('climb');
  });

  it('refuses at 12 ms: the next rung’s predicted p90 does not fit the share', () => {
    const rig = new ClockRig(new ResolutionController(FULL_LADDER));
    blindScreen(rig);
    rig.runClock(seconds(60), onTime, () => 12);
    expect(rig.applied).toEqual([]);
    const state = rig.controller.state();
    expect(state.clock.predictedNextMs).not.toBeNull();
    expect(state.clock.predictedNextMs!).toBeGreaterThan(CLOCK_UP_SHARE * BUDGET_MS);
  });

  it('predicts the next rung from the pre-submit part and the rest scaled by the ratio', () => {
    const rig = new ClockRig(new ResolutionController(FULL_LADDER));
    blindScreen(rig);
    // Held at Medium with a ceiling on the rung above, so the state keeps
    // reporting the prediction without the climb taking it.
    rig.runClock(seconds(12), onTime, () => ({ readingMs: 10, busyMs: 3 }));
    const predicted = rig.controller.state().clock;
    const expected = 3 + 7 * Math.pow(2.5 / 2, CLOCK_EXPONENT);
    if (rig.rung === MEDIUM) expect(predicted.predictedNextMs).toBeCloseTo(expected, 6);
    else expect(rig.applied[0].reason).toBe('up');
  });

  it('with no clock evidence is exactly the rule as it was: Medium and below', () => {
    const rig = new ClockRig(new ResolutionController(FULL_LADDER));
    blindScreen(rig);
    rig.runClock(seconds(60), onTime, () => null);
    expect(rig.applied).toEqual([]);
    expect(rig.controller.state().clock.counted).toBe(0);
  });

  it('needs a whole window: at one frame in sixteen the climb waits for its count', () => {
    const quick = new ClockRig(new ResolutionController(FULL_LADDER));
    blindScreen(quick);
    quick.runClock(seconds(40), onTime, () => 7);
    const sparse = new ClockRig(new ResolutionController(FULL_LADDER));
    sparse.duty = 16;
    blindScreen(sparse);
    sparse.runClock(seconds(40), onTime, () => 7);
    const firstUp = (rig: ClockRig) => rig.applied.find((a) => a.reason === 'up')?.atMs ?? Infinity;
    // Both need the ten-second interval window; the sparse clock also needs
    // its 32 readings, which at 3.75 a second take 8.5 s of their own.
    expect(firstUp(quick)).toBeLessThan(11_000);
    expect(firstUp(sparse)).toBeGreaterThanOrEqual(firstUp(quick));
    expect(firstUp(sparse)).toBeGreaterThanOrEqual((CLOCK_UP_COUNT * 16 * TICK) - 1);
    expect(CLOCK_UP_SPAN_MS).toBe(6000);
  });
});

describe('the GPU clock never opens the interval up-path (the gates a clock climb shares)', () => {
  it('holds at Medium through a minute of clean 60 fps with the clock at 14 ms', () => {
    const rig = new ClockRig(new ResolutionController(FULL_LADDER));
    blindScreen(rig);
    rig.runClock(seconds(60), onTime, () => 14);
    expect(rig.applied).toEqual([]);
  });

  it('never climbs on an idle-looking GPU while the frames are late', () => {
    const rig = new ClockRig(new ResolutionController(FULL_LADDER));
    blindScreen(rig);
    rig.runClock(seconds(60), () => 2 * TICK, () => 6);
    expect(rig.applied.some((a) => a.reason === 'up' && a.to > MEDIUM)).toBe(false);
    expect(rig.applied.every((a) => a.to <= MEDIUM)).toBe(true);
  });

  it('never climbs while the not-pixel-bound latch stands, and the sensor is not asked to run', () => {
    const rig = new ClockRig(new ResolutionController(FULL_LADDER));
    blindScreen(rig);
    // A slide that changed nothing: Medium back with the latch.
    rig.run(4 * DOWN_WINDOW_COUNTED, () => 2 * TICK);
    const latch = rig.controller.state().latch;
    expect(latch).not.toBeNull();
    expect(rig.controller.wantsClock()).toBe(false);
    const applied = rig.applied.length;
    rig.force = true;
    rig.runClock(Math.floor((latch!.untilMs - rig.nowMs) / TICK) - 1, onTime, () => 6);
    expect(rig.applied.slice(applied).some((a) => a.reason === 'up')).toBe(false);
  });

  it('changes nothing on a 120 Hz display, even with absurd readings either way', () => {
    const machine = (rung: number): number => (rung > MEDIUM + 1 ? TICK : TICK_120);
    const plain = new Rig(new ResolutionController(FULL_LADDER));
    fastScreen(plain);
    plain.run(seconds(80), machine);
    for (const absurd of [0.5, Infinity, 90]) {
      const rig = new ClockRig(new ResolutionController(FULL_LADDER));
      fastScreen(rig);
      rig.force = true;
      rig.runClock(seconds(80), machine, () => absurd);
      expect(rig.applied).toEqual(plain.applied);
      expect(rig.controller.state().clock.steering).toBe(false);
      expect(rig.controller.state().clock.counted).toBe(0);
      expect(rig.controller.wantsClock()).toBe(false);
    }
  });

  it('a row’s target ignores the clock', () => {
    const plain = new Rig(new ResolutionController(FULL_LADDER));
    sixtyRow(plain);
    plain.run(4000, onTime);
    const rig = new ClockRig(new ResolutionController(FULL_LADDER));
    sixtyRow(rig);
    rig.force = true;
    rig.runClock(4000, onTime, () => 30);
    expect(rig.applied).toEqual(plain.applied);
    expect(rig.controller.state().clock.steering).toBe(false);
  });

  it('does not ask for readings where it could not use them', () => {
    const short = new ResolutionController(SHORT_LADDER);
    short.setBudget(null, 0, { cause: 'auto', above: { budgetMs: BUDGET_MS, allowed: false } });
    expect(short.wantsClock()).toBe(false);
    const blind = new ResolutionController(FULL_LADDER);
    blind.setBudget(null, 0, { cause: 'auto', above: { budgetMs: BUDGET_MS, allowed: false } });
    expect(blind.wantsClock()).toBe(true);
    blind.notify('pin', 0);
    expect(blind.wantsClock()).toBe(false);
    blind.notify('unpin', 0);
    expect(blind.wantsClock()).toBe(true);
    blind.setClockOff('turned off');
    expect(blind.wantsClock()).toBe(false);
  });
});

describe('a reading is admitted only with its own frame', () => {
  it('pairs a late reading with its frame’s verdict', () => {
    const late = new ClockRig(new ResolutionController(FULL_LADDER));
    late.lag = 3;
    blindScreen(late);
    late.runClock(seconds(60), onTime, () => 7);
    expect(late.rung).toBe(TOP);
    expect(late.controller.state().clock.dropped.unpaired).toBe(0);
  });

  it('drops a reading whose frame did not count, and says why the frame did not', () => {
    const rig = new ClockRig(new ResolutionController(FULL_LADDER));
    blindScreen(rig);
    rig.runClock(seconds(20), onTime, () => 7, { workedMs: 3 });
    const state = rig.controller.state();
    expect(state.clock.counted).toBe(0);
    expect(state.clock.dropped.uncounted).toBeGreaterThan(0);
    expect(state.clock.uncountedBy.worked).toBe(state.clock.dropped.uncounted);
    expect(rig.applied).toEqual([]);
  });

  it('drops a reading of an older generation — one in flight across a rung change or an arrival', () => {
    const rig = new ClockRig(new ResolutionController(FULL_LADDER));
    rig.lag = 2;
    blindScreen(rig);
    rig.runClock(seconds(3), onTime, () => 7);
    const before = rig.controller.state().clock.dropped.stale;
    // An arrival lands while a reading is out.
    rig.runClock(1, onTime, () => 7);
    rig.controller.notify('arrival', rig.nowMs);
    rig.runClock(8, onTime, () => 7);
    expect(rig.controller.state().clock.dropped.stale).toBeGreaterThan(before);
  });

  it('drops a reading of a frame drawn inside the settle', () => {
    const rig = new ClockRig(new ResolutionController(FULL_LADDER));
    blindScreen(rig);
    rig.runClock(seconds(2), onTime, () => 7);
    rig.controller.notify('resize', rig.nowMs);
    rig.runClock(seconds(1), onTime, () => 7);
    // The readings in the ring are all from frames drawn after the settle.
    expect(rig.controller.state().clock.counted).toBeGreaterThan(0);
    expect(rig.controller.state().clock.counted).toBeLessThanOrEqual(Math.ceil(seconds(1) / 4));
  });

  it('a duty change clears the readings taken at the old duty', () => {
    const rig = new ClockRig(new ResolutionController(FULL_LADDER));
    blindScreen(rig);
    rig.runClock(seconds(5), onTime, () => 7);
    expect(rig.controller.state().clock.counted).toBeGreaterThan(0);
    rig.dropInFlight();
    rig.controller.clearClockEvidence(rig.nowMs);
    expect(rig.controller.state().clock.counted).toBe(0);
  });
});

describe('the sensor’s own work is not the pixels’', () => {
  it('excludes a late interval the sensor explains, and counts one it does not', () => {
    const explained = new Rig(new ResolutionController(SHORT_LADDER));
    explained.run(TWO_DOWN_WINDOWS, () => 2 * TICK, { sensorMs: 2 * TICK - BUDGET_MS + 0.5 });
    expect(explained.controller.state().countedWindow).toBe(0);
    expect(explained.applied).toEqual([]);
    const not = new Rig(new ResolutionController(SHORT_LADDER));
    not.run(TWO_DOWN_WINDOWS, () => 2 * TICK, { sensorMs: 1 });
    expect(not.applied.map((a) => a.reason)).toContain('down');
  });

  it('never excludes an on-time frame for the sensor’s work: a hair over the budget is vsync jitter', () => {
    const rig = new Rig(new ResolutionController(SHORT_LADDER));
    rig.run(600, (_r, i) => (i % 2 === 0 ? 16.8 : 16.55), { sensorMs: 2 });
    expect(rig.controller.state().countedRate).toBe(1);
  });
});

/** Up to the top by the clock at 7 ms, then past the probation so a hand-back
 *  is a slide rather than the probe failing. */
function earnedTop(): ClockRig {
  const rig = new ClockRig(new ResolutionController(FULL_LADDER));
  blindScreen(rig);
  rig.runClock(seconds(40), onTime, () => 7);
  expect(rig.rung).toBe(TOP);
  return rig;
}

describe('a rung the clock earned is kept only while the clock vouches for it', () => {
  it('hands back at 15.5 ms, to Medium and never below, as a measured failure even after the probation', () => {
    const rig = earnedTop();
    rig.runClock(Math.ceil(PROBE_HOLD_MS / TICK), onTime, () => 7);
    expect(rig.controller.state().probation).toBeNull();
    const from = rig.applied.length;
    rig.runClock(seconds(20), onTime, () => 15.5);
    const after = rig.applied.slice(from);
    expect(after.length).toBeGreaterThanOrEqual(1);
    expect(rig.rung).toBe(MEDIUM);
    expect(after.every((a) => a.to >= MEDIUM)).toBe(true);
    expect(after[0].reason).toBe('revert');
    expect(rig.controller.state().ceiling?.rung).toBe(TOP);
  });

  it('reverts a probe whose verification reads 15.5 ms, and escalates the ceiling like any failed probe', () => {
    const rig = new ClockRig(new ResolutionController(FULL_LADDER));
    blindScreen(rig);
    rig.runClock(seconds(20), onTime, (rung) => (rung > MEDIUM ? 15.5 : 7));
    const up = rig.applied.find((a) => a.reason === 'up');
    const revert = rig.applied.find((a) => a.reason === 'revert');
    expect(up).toBeDefined();
    expect(revert?.to).toBe(MEDIUM);
    expect(revert!.atMs - up!.atMs).toBeLessThan(REALLOC_SETTLE_MS + CLOCK_VERIFY_MS);
    const state = rig.controller.state();
    expect(state.ceiling?.rung).toBe(MEDIUM + 1);
    expect(state.ceiling?.escalation).toBe(1);
    expect(state.probeWaitMs).toBe(2 * PROBE_WAIT_MS);
    expect(state.clock.last?.why).toBe('verify');
    // Again after the minute: the second failure holds the rung four minutes.
    rig.runClock(seconds(90), onTime, (rung) => (rung > MEDIUM ? 15.5 : 7));
    expect(rig.controller.state().ceiling?.escalation).toBe(2);
  });

  it('a hand-back inside the probation is the probe failing', () => {
    const rig = new ClockRig(new ResolutionController(FULL_LADDER));
    blindScreen(rig);
    let slow = false;
    rig.runClock(seconds(15), onTime, (rung) => (rung > MEDIUM && slow ? 15.5 : 7));
    expect(rig.rung).toBe(MEDIUM + 1);
    expect(rig.controller.state().probation).not.toBeNull();
    slow = true;
    rig.runClock(seconds(10), onTime, (rung) => (rung > MEDIUM && slow ? 15.5 : 7));
    const last = rig.applied[rig.applied.length - 1];
    expect(last.reason).toBe('revert');
    expect(rig.controller.state().ceiling?.rung).toBe(MEDIUM + 1);
  });

  it('hands back at once on four readings in a row over the budget — a capped fence among them', () => {
    const rig = earnedTop();
    rig.runClock(Math.ceil(PROBE_HOLD_MS / TICK), onTime, () => 7);
    const from = rig.applied.length;
    const atMs = rig.nowMs;
    rig.runClock(seconds(1), onTime, (_r, i) => (i % 2 === 0 ? Infinity : 20));
    const step = rig.applied[from];
    expect(step).toBeDefined();
    expect(step.to).toBe(TOP - 1);
    expect(step.atMs - atMs).toBeLessThanOrEqual((CLOCK_PANIC_COUNT + 1) * rig.duty * TICK + 1);
    expect(rig.controller.state().clock.last?.why === 'panic' || rig.controller.state().clock.last?.why === 'verify').toBe(true);
    expect(CLOCK_PANIC_COUNT).toBe(4);
  });

  it('holds the delivered rate, not the clock: an under-reading clock at 55 fps goes back to Medium within a delivery span', () => {
    const rig = earnedTop();
    rig.runClock(Math.ceil(PROBE_HOLD_MS / TICK), onTime, () => 7);
    const from = rig.applied.length;
    const atMs = rig.nowMs;
    rig.runClock(seconds(2 * DOWN_WINDOW_S), oneInLate(11), () => 10);
    const step = rig.applied[from];
    expect(step).toBeDefined();
    expect(step.to).toBe(MEDIUM);
    expect(step.reason).toBe('revert');
    expect(step.atMs - atMs).toBeLessThanOrEqual(CLOCK_DELIVERY_SPAN_MS + 2 * TICK);
    expect(rig.controller.state().clock.last?.why).toBe('delivery');
    expect(rig.controller.state().ceiling?.rung).toBe(TOP);
    expect(CLOCK_INTERVAL_DOWN).toBe(1.05);
  });

  it('counts every drawn frame for delivery — a streaming overrun is not excused there', () => {
    const rig = earnedTop();
    rig.runClock(Math.ceil(PROBE_HOLD_MS / TICK), onTime, () => 7);
    const from = rig.applied.length;
    // 58 fps, every late frame carrying sliced work: the counted intervals see
    // a clean 60, the screen does not.
    let i = 0;
    for (let k = 0; k < seconds(8); k++) {
      const late = (++i % 29) === 0;
      rig.runClock(1, () => (late ? 2 * TICK : TICK), () => 7, late ? { workedMs: 3 } : {});
    }
    expect(rig.applied.slice(from)[0]?.to).toBe(MEDIUM);
    expect(rig.controller.state().clock.last?.why).toBe('delivery');
    expect(CLOCK_DELIVERY_GUARD).toBe(1.02);
  });

  it('a delivery failure is the rung failing: the ceiling refuses the next climb for a minute, and a second failure holds it for four', () => {
    // WebKit on the project's Mac at Earth's shell: a rung the clock earned,
    // then one hitch of about 150 ms in six seconds of frames — enough to
    // put the delivered mean past 1.02 × the budget.
    const rig = new ClockRig(new ResolutionController(ONE_ABOVE));
    blindScreen(rig);
    const top = ONE_ABOVE.rungs.length - 1;
    const medium = ONE_ABOVE.mediumIndex;
    rig.runClock(seconds(40), onTime, () => 7);
    expect(rig.rung).toBe(top);
    rig.runClock(Math.ceil(PROBE_HOLD_MS / TICK), onTime, () => 7);
    const hitch = (): void => {
      rig.runClock(1, () => 150, () => 7);
      rig.runClock(seconds(7), onTime, () => 7);
    };
    let from = rig.applied.length;
    hitch();
    const first = rig.applied[from];
    expect(first?.to).toBe(medium);
    expect(first?.reason).toBe('revert');
    expect(rig.controller.state().clock.last?.why).toBe('delivery');
    expect(rig.controller.state().ceiling).toMatchObject({ rung: top, escalation: 1 });
    const firstAt = first.atMs;
    // Clean frames and a clock at 7 ms for most of the minute: no climb.
    rig.runClock(seconds((CEILING_HOLD_MS[0] - 3000) / 1000) - seconds(7), onTime, () => 7);
    expect(rig.applied.length).toBe(from + 1);
    expect(rig.rung).toBe(medium);
    // Once the minute is out, the clock earns the rung again.
    rig.runClock(seconds(40), onTime, () => 7);
    const again = rig.applied[from + 1];
    expect(again?.to).toBe(top);
    expect(again.atMs - firstAt).toBeGreaterThanOrEqual(CEILING_HOLD_MS[0]);
    // Past its probation, and the same hitch: the failures at a rung the clock
    // earned add up, so the ceiling this time holds for four minutes.
    rig.runClock(Math.ceil(PROBE_HOLD_MS / TICK), onTime, () => 7);
    from = rig.applied.length;
    hitch();
    expect(rig.applied[from]?.to).toBe(medium);
    expect(rig.controller.state().clock.last?.why).toBe('delivery');
    const ceiling = rig.controller.state().ceiling;
    expect(ceiling).toMatchObject({ rung: top, escalation: 2 });
    expect(ceiling!.untilMs - rig.applied[from].atMs).toBe(CEILING_HOLD_MS[1]);
  });

  it('never climbs while the delivered rate is short of the screen’s, even if every counted interval is clean', () => {
    const rig = new ClockRig(new ResolutionController(FULL_LADDER));
    blindScreen(rig);
    let i = 0;
    for (let k = 0; k < seconds(60); k++) {
      const late = (++i % 40) === 0;
      rig.runClock(1, () => (late ? 2 * TICK : TICK), () => 7, late ? { workedMs: 3 } : {});
    }
    expect(rig.applied).toEqual([]);
    expect(rig.controller.state().clock.deliveredMs!).toBeGreaterThan(CLOCK_DELIVERY_UP * BUDGET_MS);
  });

  it('goes back to Medium, with no ceiling, when the readings stop — and waits longer before trying again', () => {
    const rig = earnedTop();
    const wait = rig.controller.state().probeWaitMs;
    const from = rig.applied.length;
    rig.runClock(seconds(30), onTime, () => null);
    const after = rig.applied.slice(from);
    expect(after.map((a) => a.reason)).toEqual(['restore']);
    expect(rig.rung).toBe(MEDIUM);
    expect(rig.controller.state().ceiling).toBeNull();
    expect(rig.controller.state().clock.last?.why).toBe('gap');
    expect(rig.controller.state().probeWaitMs).toBe(2 * wait);
  });

  it('a clock that keeps going quiet takes the picture up and down less and less often', () => {
    const rig = new ClockRig(new ResolutionController(FULL_LADDER));
    blindScreen(rig);
    // Readings at Medium; at the sharper rung they stop a few seconds in.
    let since = 0;
    rig.runClock(seconds(240), onTime, (rung) => {
      if (rung <= MEDIUM) { since = 0; return 7; }
      since++;
      return since < seconds(4) / rig.duty ? 7 : null;
    });
    const ups = rig.applied.filter((a) => a.reason === 'up').map((a) => a.atMs);
    const gaps = ups.slice(1).map((t, i) => t - ups[i]);
    expect(ups.length).toBeLessThanOrEqual(7);
    for (let i = 1; i < gaps.length; i++) expect(gaps[i]).toBeGreaterThanOrEqual(gaps[i - 1] - 1000);
  });

  it('goes back to Medium, with no ceiling, when the clock is lost', () => {
    const rig = earnedTop();
    const wait = rig.controller.state().probeWaitMs;
    rig.controller.setClockOff('the WebGL context was lost');
    rig.runClock(2, onTime, () => 7);
    expect(rig.applied[rig.applied.length - 1].reason).toBe('restore');
    expect(rig.rung).toBe(MEDIUM);
    expect(rig.controller.state().ceiling).toBeNull();
    expect(rig.controller.state().probeWaitMs).toBe(wait);
    // And it does not climb again while off.
    rig.runClock(seconds(40), onTime, () => 7);
    expect(rig.rung).toBe(MEDIUM);
  });

  it('never touches the floor’s references', () => {
    const rig = earnedTop();
    rig.runClock(seconds(20), onTime, () => 15.5);
    const state = rig.controller.state();
    expect(state.floorReference).toBeNull();
    expect(state.stepReference).toBeNull();
  });
});

describe('a rung the clock earned is re-earned after every evidence reset', () => {
  it('keeps the rung when the readings after an arrival still fit', () => {
    const rig = earnedTop();
    const from = rig.applied.length;
    rig.controller.notify('arrival', rig.nowMs);
    expect(rig.controller.state().clock.verify?.kind).toBe('reset');
    rig.runClock(seconds(4), onTime, () => 7);
    expect(rig.applied.slice(from)).toEqual([]);
    expect(rig.controller.state().clock.verify).toBeNull();
  });

  it('restores Medium with no ceiling and no longer wait when they do not', () => {
    const rig = earnedTop();
    const wait = rig.controller.state().probeWaitMs;
    rig.controller.notify('resize', rig.nowMs);
    rig.runClock(seconds(4), onTime, () => 15.5);
    const last = rig.applied[rig.applied.length - 1];
    expect(last.reason).toBe('restore');
    expect(last.to).toBe(MEDIUM);
    const state = rig.controller.state();
    expect(state.ceiling).toBeNull();
    expect(state.probeWaitMs).toBe(wait);
  });

  it('restores Medium when too few readings arrive in time', () => {
    const rig = earnedTop();
    rig.controller.notify('focus', rig.nowMs);
    rig.runClock(seconds(4), onTime, () => null);
    expect(rig.applied[rig.applied.length - 1].reason).toBe('restore');
    expect(rig.controller.state().clock.last?.why).toBe('unverified');
  });

  it('re-earns across a pin: nothing is read while it holds, and the rung is verified when it lifts', () => {
    const rig = earnedTop();
    const from = rig.applied.length;
    rig.controller.notify('pin', rig.nowMs);
    rig.force = true;
    rig.runClock(seconds(10), onTime, () => 7);
    expect(rig.controller.state().clock.counted).toBe(0);
    expect(rig.controller.state().clock.dropped.notSteering).toBeGreaterThan(0);
    rig.force = false;
    rig.controller.notify('unpin', rig.nowMs);
    expect(rig.controller.state().clock.verify?.kind).toBe('reset');
    rig.runClock(seconds(4), onTime, () => 7);
    expect(rig.applied.slice(from)).toEqual([]);
    expect(rig.rung).toBe(TOP);
  });

  it('re-earns after a ladder change — a resize, a fixed level back to Dynamic', () => {
    const rig = earnedTop();
    rig.controller.setLadder(FULL_LADDER, rig.nowMs);
    expect(rig.controller.state().clock.verify?.kind).toBe('reset');
    rig.runClock(seconds(4), onTime, () => 15.5);
    expect(rig.rung).toBe(MEDIUM);
    // A ladder with nothing above Medium re-clamps the rung and ends the
    // clock's hold outright.
    const top = earnedTop();
    top.controller.setLadder(SHORT_LADDER, top.nowMs);
    expect(top.controller.state().clock.earned).toBe(false);
    expect(top.controller.state().clock.verify).toBeNull();
  });

  it('re-earns after a budget change that leaves the tick blind, and hands the rung to the tick when it is not', () => {
    const rig = earnedTop();
    blindScreen(rig);
    expect(rig.controller.state().clock.verify?.kind).toBe('reset');
    const tick = earnedTop();
    fastScreen(tick);
    expect(tick.controller.state().clock.earned).toBe(false);
    expect(tick.controller.state().clock.verify).toBeNull();
  });

  it('an ?upscale= pin is a pin: the clock steps out and re-earns the rung after it', () => {
    const rig = earnedTop();
    rig.controller.notify('pin', rig.nowMs);
    rig.runClock(seconds(5), onTime, () => 15.5);
    expect(rig.rung).toBe(TOP);
    rig.controller.notify('unpin', rig.nowMs);
    rig.runClock(seconds(4), onTime, () => 15.5);
    expect(rig.rung).toBe(MEDIUM);
    expect(rig.applied[rig.applied.length - 1].reason).toBe('restore');
  });
});

describe('a clock probe short of evidence', () => {
  it('reverts when fewer than eight readings arrive in three seconds, without a ceiling', () => {
    const rig = new ClockRig(new ResolutionController(FULL_LADDER));
    blindScreen(rig);
    // Plenty at Medium; at the sharper rung almost no frame is sampled.
    rig.runClock(seconds(14), onTime, (rung, i) => (rung > MEDIUM ? (i % 60 === 0 ? 7 : null) : 7));
    const up = rig.applied.find((a) => a.reason === 'up');
    const revert = rig.applied.find((a) => a.reason === 'revert');
    expect(up).toBeDefined();
    expect(revert).toBeDefined();
    // A second of visible drawing with no reading is enough to call it.
    expect(revert!.atMs - up!.atMs).toBeGreaterThanOrEqual(CLOCK_GAP_MS);
    expect(revert!.atMs - up!.atMs).toBeLessThanOrEqual(CLOCK_VERIFY_MS + REALLOC_SETTLE_MS);
    expect(rig.controller.state().ceiling).toBeNull();
    expect(rig.controller.state().clock.last?.why).toBe('unverified');
  });

  it('fails when the readings it did get were starved or capped', () => {
    const rig = new ClockRig(new ResolutionController(FULL_LADDER));
    blindScreen(rig);
    rig.runClock(seconds(14), onTime, (rung) => (rung > MEDIUM ? { readingMs: 7, starved: true } : 7));
    expect(rig.applied.find((a) => a.reason === 'revert')).toBeDefined();
    expect(rig.controller.state().ceiling?.rung).toBe(MEDIUM + 1);
  });

  it('starvation that appears only at the sharper rung is bounded by the ceiling’s escalation', () => {
    const rig = new ClockRig(new ResolutionController(FULL_LADDER));
    blindScreen(rig);
    rig.runClock(seconds(20 * 60), onTime, (rung) => (rung > MEDIUM ? { readingMs: 7, starved: true } : 7));
    const ups = rig.applied.filter((a) => a.reason === 'up');
    expect(ups.length).toBeLessThanOrEqual(4);
    expect(rig.rung).toBe(MEDIUM);
  });
});

describe('a rung whose frames do not count still hears its failures', () => {
  it('an engine that blocks in submission: late, uncounted frames with capped fences at the sharper rung climb a few times and then stop', () => {
    // At Medium the frames are on time and the clock reads 7 ms. At the
    // sharper rung the GPU falls behind, the flush blocks, and every frame is
    // a tick late with a 12 ms main thread — so no interval there counts —
    // while every fence is capped.
    const rig = new ClockRig(new ResolutionController(FULL_LADDER));
    blindScreen(rig);
    while (rig.nowMs < 10 * 60_000) {
      const sharp = rig.rung > MEDIUM;
      rig.runClock(1, () => (sharp ? 2 * TICK : TICK), () => (sharp ? Infinity : 7), sharp ? { mainThreadMs: 12 } : {});
    }
    const ups = rig.applied.filter((a) => a.reason === 'up');
    expect(ups.length).toBeGreaterThanOrEqual(1);
    expect(ups.length).toBeLessThanOrEqual(3);
    const state = rig.controller.state();
    expect(state.ceiling).not.toBeNull();
    expect(state.ceiling!.rung).toBe(MEDIUM + 1);
    expect(rig.rung).toBe(MEDIUM);
    // The readings were heard as failures, never as statistics.
    expect(state.clock.dropped.uncounted).toBeGreaterThan(0);
    expect(state.clock.uncountedBy.mainThread).toBeGreaterThan(0);
  });

  it('keeps those readings out of the statistics: an over-bar reading from a frame that did not count moves no p90', () => {
    const rig = earnedTop();
    rig.runClock(Math.ceil(PROBE_HOLD_MS / TICK), onTime, () => 7);
    const before = rig.controller.state().clock.p90Ms;
    // Three over-bar readings from frames that did not count: short of the
    // panic, and invisible to the statistics.
    let n = 0;
    for (let k = 0; k < 40 && n < 3; k++) {
      const before = rig.delivered;
      rig.runClock(1, onTime, () => 20, { workedMs: 2 });
      if (rig.delivered > before) n++;
    }
    expect(rig.controller.state().clock.p90Ms).toBe(before);
    expect(rig.controller.state().clock.panicStreak).toBeGreaterThan(0);
    expect(rig.rung).toBe(TOP);
  });
});

describe('the clock’s evidence', () => {
  it('keeps starved readings out of the statistic, and a starved share over its bound blocks a climb', () => {
    const rig = new ClockRig(new ResolutionController(FULL_LADDER));
    blindScreen(rig);
    rig.runClock(seconds(60), onTime, (_r, i) => ({ readingMs: 7, starved: i % 5 < 2 }));
    expect(rig.applied).toEqual([]);
    expect(rig.controller.state().clock.starvedShare!).toBeGreaterThan(STARVED_SHARE_MAX);
  });

  it('a starved share at a rung it earned long ago is silence: Medium, no ceiling', () => {
    const rig = earnedTop();
    rig.runClock(Math.ceil(PROBE_HOLD_MS / TICK), onTime, () => 7);
    rig.runClock(seconds(20), onTime, () => ({ readingMs: 7, starved: true }));
    expect(rig.rung).toBe(MEDIUM);
    expect(rig.applied[rig.applied.length - 1].reason).toBe('restore');
    expect(rig.controller.state().ceiling).toBeNull();
  });

  it('takes one reversal as the scene moving, and turns itself off on the second', () => {
    // Each sharper rung reads 2.5 ms FASTER than the one below it.
    const read = (rung: number): number => 9.5 - 2.5 * (rung - MEDIUM);
    const once = new ClockRig(new ResolutionController(FULL_LADDER));
    blindScreen(once);
    once.runClock(seconds(15), onTime, read);
    expect(once.rung).toBe(MEDIUM + 1);
    expect(once.controller.state().clock.reversals).toBe(1);
    expect(once.controller.state().clock.off).toBeNull();
    once.runClock(seconds(20), onTime, read);
    const state = once.controller.state();
    expect(state.clock.reversals).toBe(2);
    expect(state.clock.off).toMatch(/faster than the rung below, 2 times/);
    expect(state.clock.last?.why).toBe('reversal');
    expect(once.rung).toBe(MEDIUM);
    once.runClock(seconds(60), onTime, read);
    expect(once.rung).toBe(MEDIUM);
    expect(once.controller.wantsClock()).toBe(false);
  });

  it('fails a probe once when the intervals and the clock fail on the same second', () => {
    const rig = new ClockRig(new ResolutionController(FULL_LADDER));
    blindScreen(rig);
    rig.runClock(seconds(20), (rung) => (rung > MEDIUM ? 2 * TICK : TICK), (rung) => (rung > MEDIUM ? Infinity : 7));
    const state = rig.controller.state();
    expect(rig.applied.filter((a) => a.reason === 'revert')).toHaveLength(1);
    expect(state.ceiling?.escalation).toBe(1);
    expect(state.probeWaitMs).toBe(2 * PROBE_WAIT_MS);
  });

  it('reports the down window’s size it hands back on', () => {
    expect(CLOCK_DOWN_COUNT).toBe(16);
    expect(CLOCK_DOWN_SHARE).toBe(0.9);
    expect(CLOCK_UP_SHARE).toBeGreaterThan(0);
  });
});

describe('silence, and the grace a reset gets', () => {
  it('a second of visible drawing with no admissible reading is silence', () => {
    const rig = earnedTop();
    const from = rig.applied.length;
    const atMs = rig.nowMs;
    rig.runClock(seconds(3), onTime, () => null);
    const step = rig.applied.slice(from)[0];
    expect(step.reason).toBe('restore');
    expect(step.atMs - atMs).toBeLessThanOrEqual(CLOCK_GAP_MS + 2 * TICK);
    expect(rig.controller.state().clock.last?.why).toBe('gap');
  });

  it('too few readings in the last six seconds is silence, once the evidence is that old', () => {
    const rig = earnedTop();
    rig.duty = 40;
    const from = rig.applied.length;
    rig.runClock(seconds(10), onTime, () => 7);
    const step = rig.applied.slice(from)[0];
    expect(step?.reason).toBe('restore');
    expect(rig.controller.state().clock.last?.why).toBe('silent');
    expect(CLOCK_SILENCE_SPAN_MS).toBe(6000);
  });

  it('starvation over its share of the last attempts is silence', () => {
    const rig = earnedTop();
    const from = rig.applied.length;
    rig.runClock(seconds(5), onTime, (_r, i) => ({ readingMs: 7, starved: i % 3 !== 0 }));
    expect(rig.applied.slice(from)[0]?.reason).toBe('restore');
    expect(rig.controller.state().clock.last?.why).toBe('starved');
    expect(rig.controller.state().ceiling).toBeNull();
  });

  it('starts the grace at the first eligible frame, so a veil cannot use it up', () => {
    const rig = earnedTop();
    const from = rig.applied.length;
    rig.controller.notify('arrival', rig.nowMs);
    // Five seconds covered: nothing counts, nothing is decided.
    rig.runClock(seconds(5), onTime, () => 7, { eligible: false });
    expect(rig.applied.slice(from)).toEqual([]);
    expect(rig.controller.state().clock.verify?.deadlineMs).toBeNull();
    rig.runClock(seconds(4), onTime, () => 7);
    expect(rig.applied.slice(from)).toEqual([]);
    expect(rig.rung).toBe(TOP);
  });

  it('never restarts a deadline that is already running', () => {
    const rig = earnedTop();
    rig.controller.notify('resize', rig.nowMs);
    rig.runClock(2, onTime, () => null);
    const deadline = rig.controller.state().clock.verify?.deadlineMs;
    expect(deadline).not.toBeNull();
    rig.runClock(seconds(0.5), onTime, () => null);
    rig.controller.notify('arrival', rig.nowMs);
    rig.controller.clearClockEvidence(rig.nowMs);
    rig.runClock(1, onTime, () => null);
    expect(rig.controller.state().clock.verify?.deadlineMs).toBe(deadline);
  });

  it('suspends a rung the clock earned while the page is away, and re-earns it on the way back', () => {
    const rig = earnedTop();
    const from = rig.applied.length;
    rig.runClock(seconds(30), onTime, () => null, { eligible: false });
    expect(rig.applied.slice(from)).toEqual([]);
    rig.controller.notify('focus', rig.nowMs);
    rig.runClock(seconds(4), onTime, () => 7);
    expect(rig.applied.slice(from)).toEqual([]);
    expect(rig.rung).toBe(TOP);
  });
});

describe('a clock rung’s failures add up across its probation', () => {
  it('a device that heats slowly — earn, hold past the probation, fail, cool, repeat — escalates', () => {
    const rig = new ClockRig(new ResolutionController(ONE_ABOVE));
    blindScreen(rig);
    let hot = false;
    const read = (rung: number): number => (rung > MEDIUM && hot ? 15.5 : 7);
    const ceilings: number[] = [];
    for (let round = 0; round < 3; round++) {
      hot = false;
      // Climb and hold past the two-minute probation.
      rig.runClock(seconds(CEILING_HOLD_MS[Math.min(round, CEILING_HOLD_MS.length - 1)] / 1000 + 150), onTime, read);
      expect(rig.rung).toBe(MEDIUM + 1);
      hot = true;
      rig.runClock(seconds(10), onTime, read);
      expect(rig.rung).toBe(MEDIUM);
      ceilings.push(rig.controller.state().ceiling?.escalation ?? 0);
    }
    expect(ceilings).toEqual([1, 2, 3]);
  });
});
