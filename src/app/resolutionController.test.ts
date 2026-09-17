import { describe, expect, it } from 'vitest';
import {
  BUDGET_MS,
  CEILING_HOLD_MS,
  DOWN_FACTOR,
  DOWN_SPACING_MS,
  DOWN_WINDOW_COUNTED,
  DOWN_WINDOW_S,
  FLOOR_LATCH_MIN_GAIN,
  LATCH_HOLD_MS,
  MAIN_THREAD_SHARE,
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
  type IntervalSample,
  type RungLadder,
  type StepReason,
} from './resolutionController';

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
    climbs.run(3 * UP_WINDOW_COUNTED, oneInLate(Math.ceil(1 / share)));
    expect(climbs.applied.map((a) => a.reason)).toContain('up');

    const holds = new Rig(new ResolutionController(FULL_LADDER));
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
  it('climbs a Mac that holds 60 fps, one rung at a time, to the top', () => {
    const rig = new Rig(new ResolutionController(FULL_LADDER));
    rig.run(4000, () => TICK);
    expect(rig.applied.map((a) => a.reason)).toEqual(['up', 'up']);
    expect(rig.rung).toBe(FULL_LADDER.rungs.length - 1);
    expect(rig.controller.state().probeWaitMs).toBe(PROBE_WAIT_MS);
  });

  it('reverts a probe whose next second is over budget inside 1.25 s, doubles the wait and latches a ceiling', () => {
    const rig = new Rig(new ResolutionController(FULL_LADDER));
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
    // Two failures at the first rung above medium in the first 200 s, then
    // the frames fit there.
    let fits = false;
    const frame = (rung: number) => (rung > FULL_LADDER.mediumIndex && !fits ? 2 * TICK : TICK);
    rig.run(12_000, frame);
    expect(rig.controller.state().ceiling?.escalation).toBe(2);
    fits = true;
    rig.run(12_000, frame);
    // The four-minute ceiling ran out and the probe held.
    expect(rig.rung).toBeGreaterThan(FULL_LADDER.mediumIndex);
    expect(rig.controller.state().ceiling).toBeNull();
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
    rig.run(24_000, (rung) => (rung > FULL_LADDER.mediumIndex ? 2 * TICK : TICK));
    expect(rig.controller.state().ceiling?.escalation).toBe(3);
    rig.controller.setBudget(1000 / 30, rig.nowMs, { cause: 'user' });
    expect(rig.controller.state().ceiling).toBeNull();
  });
});

describe('the up path on a fast display', () => {
  /** A 120 Hz machine: medium fits inside one vsync, anything sharper needs
   *  two. At the default budget it is meant to spend the refresh rate for the
   *  sharper picture — which rate it runs at is the Frame rate row's
   *  question. */
  const machine = (rung: number): number => (rung > FULL_LADDER.mediumIndex ? TICK : TICK_120);

  it('climbs to the sharpest rung and settles there', () => {
    const rig = new Rig(new ResolutionController(FULL_LADDER));
    rig.run(6000, machine);
    expect(rig.rung).toBe(FULL_LADDER.rungs.length - 1);
    expect(rig.applied.filter((a) => a.reason === 'revert')).toEqual([]);
  });

  it('steps down on the budget, not on the panel period', () => {
    const rig = new Rig(new ResolutionController(SHORT_LADDER));
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
