import { describe, expect, it } from 'vitest';
import {
  CALIBRATION_SHARE,
  CAMPAIGN_SHARE_MAX,
  CAP_SHARE,
  CLOCK_EXPONENT,
  CPU_PER_FRAME_MAX_MS,
  DUTY_MAX,
  DUTY_START,
  DUTY_VERIFY,
  GRID_MAX_MS,
  GRID_MIN_SAMPLES,
  GRID_MIN_STEPS,
  GRID_TOLERANCE,
  GpuClockPolicy,
  PRICE_BLOCK_SAMPLES,
  REFUSAL_REST_MAX_MS,
  REFUSAL_REST_MS,
  REFUSAL_SUSTAIN_MS,
  RefusalRest,
  REVERSAL_MS,
  SOURCE_TRIAL_ATTEMPTS_MAX,
  SOURCE_TRIAL_SAMPLES,
  STARVED_GAP_MS,
  capMsFor,
  classifyReading,
  clockResolves,
  growthFor,
  isReversal,
  learnedExponent,
  predictWithGrowthMs,
  starvedGapLimitMs,
  type PolledSample,
} from './gpuFrameClockPolicy';
import type { FencePollSource } from './fencePoll';

/** A sample whose fence signalled `readingMs` after the callback began, with
 *  the frame built in `busyMs` and the signalling poll `gapMs` after the one
 *  before it. */
function polled(readingMs: number, opts: { busyMs?: number; gapMs?: number | null; capped?: boolean } = {}): PolledSample {
  const start = 1000;
  return {
    callbackStartMs: start,
    submittedAtMs: start + (opts.busyMs ?? 2),
    signalledAtMs: opts.capped ? null : start + readingMs,
    signalGapMs: opts.capped ? null : (opts.gapMs === undefined ? 0.04 : opts.gapMs),
    capped: opts.capped ?? false,
  };
}

/** The policy's own wall clock in these tests, advanced a 60 Hz tick a frame. */
let clockMs = 0;

/** One sample through the policy as the sensor would report it: the frames it
 *  ran across at 60 fps, the CPU it executed, the wall its campaign spanned,
 *  and the poll's figures. */
function feed(
  policy: GpuClockPolicy,
  opts: {
    costMs: number;
    campaignMs?: number;
    frames?: number;
    starved?: boolean;
    source?: FencePollSource;
    /** The poll's measured mean gap; null for a loop that saw the signal on
     *  its first or second ask and had none to measure. */
    gapMs?: number | null;
    minStepMs?: number | null;
    gridSteps?: number;
  },
) {
  const frames = opts.frames ?? policy.duty;
  for (let i = 0; i < frames; i++) {
    clockMs += 1000 / 60;
    policy.noteFrame(clockMs);
  }
  policy.noteCpu(opts.costMs);
  return policy.recordSample({
    ...polled(8, { gapMs: opts.starved ? 3 : 0.04 }),
    source: opts.source ?? policy.nextSource(),
    intervalMeanMs: opts.gapMs === undefined ? 0.04 : opts.gapMs,
    minStepMs: opts.minStepMs === undefined ? 0.1 : opts.minStepMs,
    gridSteps: opts.gridSteps,
    campaignMs: opts.campaignMs ?? 0,
  });
}

describe('a reading is one subtraction', () => {
  it('is the signal less the callback start, with the pre-submit time beside it', () => {
    const r = classifyReading(polled(9, { busyMs: 3 }));
    expect(r.readingMs).toBe(9);
    expect(r.busyMs).toBe(3);
    expect(r.starved).toBe(false);
    expect(r.capped).toBe(false);
    expect(r.invalid).toBe(false);
  });

  it('is not a reading at all when the stamps are out of order', () => {
    const backwards = { ...polled(9), signalledAtMs: 1001, submittedAtMs: 1003 };
    expect(classifyReading(backwards).invalid).toBe(true);
    const beforeStart = { ...polled(9), submittedAtMs: 999 };
    expect(classifyReading(beforeStart).invalid).toBe(true);
  });

  it('counts a capped fence as over the bar, never as missing', () => {
    const r = classifyReading(polled(0, { capped: true }));
    expect(r.capped).toBe(true);
    expect(r.readingMs).toBe(Infinity);
    expect(r.starved).toBe(false);
  });

  it('caps the loop one and a quarter budgets after the frame began', () => {
    expect(capMsFor(1000 / 60)).toBeCloseTo(CAP_SHARE * (1000 / 60), 9);
    expect(CAP_SHARE).toBe(1.25);
  });
});

describe('a starved reading', () => {
  it('is one whose signalling poll came after a gap longer than half a millisecond', () => {
    expect(classifyReading(polled(8, { gapMs: 0.4 })).starved).toBe(false);
    expect(classifyReading(polled(8, { gapMs: 0.6 })).starved).toBe(true);
    expect(STARVED_GAP_MS).toBe(0.5);
  });

  it('asks a millisecond clock only for what it can resolve: a one-step gap passes, two steps are starved', () => {
    expect(starvedGapLimitMs(null)).toBe(STARVED_GAP_MS);
    expect(starvedGapLimitMs(0.1)).toBe(STARVED_GAP_MS);
    expect(classifyReading(polled(8, { gapMs: 0 }), 1).starved).toBe(false);
    expect(classifyReading(polled(8, { gapMs: 0.9999999999854481 }), 0.9999999999854481).starved).toBe(false);
    expect(classifyReading(polled(8, { gapMs: 2 }), 1).starved).toBe(true);
    // A clock of a tenth of a millisecond keeps the half-millisecond bar.
    expect(classifyReading(polled(8, { gapMs: 0.6 }), 0.1).starved).toBe(true);
  });

  it('is one with no gap to judge at all', () => {
    expect(classifyReading(polled(8, { gapMs: null })).starved).toBe(true);
  });
});

describe('the duty', () => {
  it('samples one eligible frame in four, counting only eligible frames', () => {
    const policy = new GpuClockPolicy();
    expect(policy.duty).toBe(DUTY_START);
    const armed: number[] = [];
    for (let i = 0; i < 16; i++) if (policy.armFrame(true, false)) armed.push(i);
    expect(armed).toEqual([0, 4, 8, 12]);
  });

  it('arms the first clean frame once the count runs out, so it cannot alias with alternating upload frames', () => {
    const policy = new GpuClockPolicy();
    const armed: number[] = [];
    // Near Earth sliced work lands on every other frame; with the arm at a
    // fixed phase a duty of 4 could land on the worked frames every time.
    for (let i = 0; i < 40; i++) {
      const clean = i % 2 === 1;
      if (policy.armFrame(clean, false)) armed.push(i);
    }
    expect(armed.length).toBeGreaterThanOrEqual(8);
    expect(armed.every((i) => i % 2 === 1)).toBe(true);
  });

  it('keeps one fence in flight, and counts the arms it skipped for it', () => {
    const policy = new GpuClockPolicy();
    expect(policy.armFrame(true, false)).toBe(true);
    for (let i = 0; i < DUTY_START - 1; i++) expect(policy.armFrame(true, true)).toBe(false);
    // The count has run out and a fence is still out: skipped, and the next
    // clean frame with none out is armed.
    expect(policy.armFrame(true, true)).toBe(false);
    expect(policy.skippedArms).toBe(1);
    expect(policy.armFrame(true, false)).toBe(true);
  });

  it('samples one frame in four through a verification, whatever the priced duty, and goes back after', () => {
    const policy = new GpuClockPolicy();
    policy.duty = DUTY_MAX;
    // A steady arm leaves fifteen frames to count down; a verification that
    // opens cuts the count to its own.
    expect(policy.armFrame(true, false)).toBe(true);
    const armed: number[] = [];
    for (let i = 0; i < 16; i++) if (policy.armFrame(true, false, true)) armed.push(i);
    expect(armed).toEqual([3, 7, 11, 15]);
    expect(policy.dutyFor(true)).toBe(DUTY_VERIFY);
    expect(policy.sampleInBurst).toBe(true);
    const after: number[] = [];
    for (let i = 0; i < 40; i++) if (policy.armFrame(true, false)) after.push(i);
    expect(after).toEqual([3, 19, 35]);
    expect(policy.sampleInBurst).toBe(false);
  });
});

describe('self-pricing', () => {
  it('prices the CPU the sensor executes per drawn frame, and lands at a stable duty', () => {
    // 2 ms of CPU a sample: 0.5 ms a frame at one in four, 0.25 at one in eight.
    const policy = new GpuClockPolicy();
    const duties: number[] = [];
    for (let i = 0; i < 10 * PRICE_BLOCK_SAMPLES; i++) {
      feed(policy, { costMs: 2 });
      duties.push(policy.duty);
    }
    expect(duties[PRICE_BLOCK_SAMPLES - 2]).toBe(4);
    expect(policy.duty).toBe(8);
    expect(policy.disabled).toBeNull();
    expect(policy.lastCpuPerFrameMs).toBeCloseTo(0.25, 6);
    expect(policy.lastCpuPerFrameMs!).toBeLessThanOrEqual(CPU_PER_FRAME_MAX_MS);
  });

  it('prices the poll campaign’s wall time apart, and settles an 11 ms campaign at one frame in sixteen', () => {
    // Cheap to execute, but the loop turns the main thread over for the
    // whole reading: 16.5 % of the time at one in four, 8.25 at eight, 4.1 at
    // sixteen — the figures for this project's Mac in WebKit.
    const policy = new GpuClockPolicy();
    for (let i = 0; i < 12 * PRICE_BLOCK_SAMPLES; i++) feed(policy, { costMs: 0.2, campaignMs: 11 });
    expect(policy.duty).toBe(16);
    expect(policy.disabled).toBeNull();
    expect(policy.lastCampaignShare!).toBeLessThanOrEqual(CAMPAIGN_SHARE_MAX);
    expect(policy.lastCampaignShare!).toBeCloseTo(11 / (16 * 1000 / 60), 2);
    // And the two prices are never added: the CPU stays its own figure.
    expect(policy.lastCpuPerFrameMs).toBeCloseTo(0.2 / 16, 6);
  });

  it('backs off 4 → 8 → 16 and then turns itself off, saying why', () => {
    const policy = new GpuClockPolicy();
    const seen = new Set<number>();
    let disabled: string | null = null;
    for (let i = 0; i < 6 * PRICE_BLOCK_SAMPLES && disabled === null; i++) {
      const { verdict } = feed(policy, { costMs: 6 });
      seen.add(policy.duty);
      if (verdict?.kind === 'disabled') disabled = verdict.reason;
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([4, 8, 16]);
    expect(policy.duty).toBe(DUTY_MAX);
    expect(disabled).toMatch(/0\.38 ms of CPU a frame even at one frame in 16/);
    expect(policy.disabled).toBe(disabled);
    // Off is off: no frame is armed again.
    expect(policy.armFrame(true, false)).toBe(false);
    // And the wall price says so in its own words.
    const walled = new GpuClockPolicy();
    let why: string | null = null;
    for (let i = 0; i < 6 * PRICE_BLOCK_SAMPLES && why === null; i++) {
      const { verdict } = feed(walled, { costMs: 0.1, campaignMs: 20 });
      if (verdict?.kind === 'disabled') why = verdict.reason;
    }
    expect(why).toMatch(/% of the main thread's time polling even at one frame in 16/);
  });

  it('never brings the duty back down, however cheap it gets', () => {
    const policy = new GpuClockPolicy();
    for (let i = 0; i < 2 * PRICE_BLOCK_SAMPLES; i++) feed(policy, { costMs: 2 });
    expect(policy.duty).toBe(8);
    for (let i = 0; i < 10 * PRICE_BLOCK_SAMPLES; i++) feed(policy, { costMs: 0.1 });
    expect(policy.duty).toBe(8);
  });

  it('amortises over the frames it really ran across, not over the duty', () => {
    // Every other frame unclean: a sample every eight drawn frames at a duty of
    // four, so 2 ms a sample is 0.25 ms a frame and nothing backs off.
    const policy = new GpuClockPolicy();
    for (let i = 0; i < 4 * PRICE_BLOCK_SAMPLES; i++) feed(policy, { costMs: 2, frames: 8 });
    expect(policy.duty).toBe(4);
    expect(policy.lastCpuPerFrameMs).toBeCloseTo(0.25, 6);
  });

  it('keeps a verification burst out of the price: it is not the steady rate the duty was priced at', () => {
    // A sensor settled at one frame in sixteen on an 11 ms campaign, then a
    // three-second verification at one in four — 16.5 % of the time polling
    // for as long as it lasts.
    const policy = new GpuClockPolicy();
    for (let i = 0; i < 12 * PRICE_BLOCK_SAMPLES; i++) feed(policy, { costMs: 0.2, campaignMs: 11 });
    expect(policy.duty).toBe(DUTY_MAX);
    const campaigns = policy.totalCampaignMs;
    let verdicts = 0;
    for (let i = 0; i < 2 * PRICE_BLOCK_SAMPLES; i++) {
      let arms = 0;
      for (let f = 0; f < DUTY_VERIFY; f++) {
        clockMs += 1000 / 60;
        policy.noteFrame(clockMs, true);
        if (policy.armFrame(true, false, true)) arms++;
      }
      expect(arms).toBe(1);
      policy.noteCpu(0.2, policy.sampleInBurst);
      const { verdict } = policy.recordSample({
        ...polled(8),
        source: policy.nextSource(),
        intervalMeanMs: 0.04,
        minStepMs: 0.1,
        campaignMs: 11,
      });
      if (verdict !== null) verdicts++;
    }
    expect(verdicts).toBe(0);
    expect(policy.disabled).toBeNull();
    expect(policy.duty).toBe(DUTY_MAX);
    // It is still the session's cost.
    expect(policy.totalCampaignMs).toBeCloseTo(campaigns + 2 * PRICE_BLOCK_SAMPLES * 11, 6);
    // And at a priced duty of four a verification is an ordinary sample.
    const four = new GpuClockPolicy();
    expect(four.armFrame(true, false, true)).toBe(true);
    expect(four.sampleInBurst).toBe(false);
  });

  it('never backs off for starvation, which measures the app and not the sensor', () => {
    const policy = new GpuClockPolicy();
    for (let i = 0; i < 20 * PRICE_BLOCK_SAMPLES; i++) feed(policy, { costMs: 0.2, starved: true });
    expect(policy.duty).toBe(DUTY_START);
    expect(policy.disabled).toBeNull();
    expect(policy.starvedCount).toBe(20 * PRICE_BLOCK_SAMPLES);
    expect(policy.recentStats().starvedShare).toBe(1);
  });

  it('a duty pinned from the bridge is priced but never moved', () => {
    const policy = new GpuClockPolicy();
    policy.duty = 4;
    policy.dutyPinned = true;
    for (let i = 0; i < 4 * PRICE_BLOCK_SAMPLES; i++) feed(policy, { costMs: 6 });
    expect(policy.duty).toBe(4);
    expect(policy.lastCpuPerFrameMs).toBeCloseTo(1.5, 6);
  });
});

describe('the task source', () => {
  it('tries both and keeps the one whose loop turned over faster', () => {
    const policy = new GpuClockPolicy();
    const gap: Record<FencePollSource, number> = { window: 0.04, channel: 0.08 };
    const tried: FencePollSource[] = [];
    for (let i = 0; i < 2 * SOURCE_TRIAL_SAMPLES; i++) {
      const source = policy.nextSource();
      tried.push(source);
      feed(policy, { costMs: 0.5, source, gapMs: gap[source] });
    }
    expect(tried.filter((s) => s === 'window')).toHaveLength(SOURCE_TRIAL_SAMPLES);
    expect(tried.filter((s) => s === 'channel')).toHaveLength(SOURCE_TRIAL_SAMPLES);
    expect(policy.source).toBe('window');
    // And the other way round on an engine where the channel is quicker.
    const other = new GpuClockPolicy();
    const quick: Record<FencePollSource, number> = { window: 0.0034, channel: 0.0021 };
    for (let i = 0; i < 2 * SOURCE_TRIAL_SAMPLES; i++) {
      const source = other.nextSource();
      feed(other, { costMs: 0.5, source, gapMs: quick[source] });
    }
    expect(other.source).toBe('channel');
  });

  it('takes turns whatever a sample measured: a fence signalled at the first ask never pins the trial to one source', () => {
    // Every window sample signals before the loop can measure a gap; every
    // channel sample measures one.
    const policy = new GpuClockPolicy();
    const tried: FencePollSource[] = [];
    for (let i = 0; i < 2 * SOURCE_TRIAL_ATTEMPTS_MAX && policy.source === null; i++) {
      const source = policy.nextSource();
      tried.push(source);
      feed(policy, { costMs: 0.5, source, gapMs: source === 'window' ? null : 0.05 });
    }
    // Strict turns from the first sample on.
    expect(tried.slice(0, 12)).toEqual(Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? 'window' : 'channel')));
    expect(tried.filter((t) => t === 'window')).toHaveLength(SOURCE_TRIAL_ATTEMPTS_MAX);
    expect(tried.filter((t) => t === 'channel')).toHaveLength(SOURCE_TRIAL_ATTEMPTS_MAX);
    // The only source that measured anything is the one kept.
    expect(policy.trialGaps().window).toBeNull();
    expect(policy.source).toBe('channel');
  });

  it('ends a trial in which nothing measured a gap, on the window source, after its turns', () => {
    const policy = new GpuClockPolicy();
    const tried: FencePollSource[] = [];
    for (let i = 0; i < 2 * SOURCE_TRIAL_ATTEMPTS_MAX + 4; i++) {
      const source = policy.nextSource();
      tried.push(source);
      feed(policy, { costMs: 0.5, source, gapMs: null });
    }
    expect(tried.filter((s) => s === 'channel').length).toBe(SOURCE_TRIAL_ATTEMPTS_MAX);
    expect(policy.source).toBe('window');
  });

  it('a first sample with no gap still hands the next turn to the other source', () => {
    const policy = new GpuClockPolicy();
    feed(policy, { costMs: 0.5, source: policy.nextSource(), gapMs: null });
    expect(policy.nextSource()).toBe('channel');
  });
});

describe('the clock’s grid', () => {
  it('is learned from the loop’s own stamps and only ever gets finer', () => {
    const policy = new GpuClockPolicy();
    expect(policy.gridMs).toBeNull();
    feed(policy, { costMs: 0.5, minStepMs: 1 });
    expect(policy.gridMs).toBe(1);
    feed(policy, { costMs: 0.5, minStepMs: null });
    expect(policy.gridMs).toBe(1);
    feed(policy, { costMs: 0.5, minStepMs: 0.1 });
    expect(policy.gridMs).toBe(0.1);
  });

  it('is not judged on one sample whose polls other work held apart', () => {
    // Headless Chromium on the project's Mac turned the sensor off on its
    // first sample: its polls were held more than a millisecond apart while
    // the page was busy, on a clock whose grid is a tenth of that. One step
    // is not the grid, and decides nothing either way.
    const policy = new GpuClockPolicy();
    feed(policy, { costMs: 0.1, minStepMs: 1.2999999940395355, gridSteps: 1, starved: true });
    expect(policy.gridVerdict()).toBeNull();
    feed(policy, { costMs: 0.1, minStepMs: 0.09999999403953552, gridSteps: 40 });
    expect(policy.gridVerdict()).toBe('fine');
  });

  it('qualifies a millisecond clock read as the difference of two floats', () => {
    const policy = new GpuClockPolicy();
    feed(policy, { costMs: 0.5, minStepMs: 1.0999999940395355, gridSteps: 3 });
    expect(policy.gridVerdict()).toBe('fine');
    const webkit = new GpuClockPolicy();
    feed(webkit, { costMs: 0.5, minStepMs: 0.9999999999854481, gridSteps: 3 });
    expect(webkit.gridVerdict()).toBe('fine');
  });

  it('calls a clock too coarse only once enough steps never showed a millisecond', () => {
    const policy = new GpuClockPolicy();
    const per = 4;
    for (let i = 0; i * per < GRID_MIN_STEPS - per; i++) {
      feed(policy, { costMs: 0.5, minStepMs: 16.7, gridSteps: per });
      expect(policy.gridVerdict()).toBeNull();
    }
    feed(policy, { costMs: 0.5, minStepMs: 16.7, gridSteps: per });
    expect(policy.gridSteps).toBe(GRID_MIN_STEPS);
    expect(policy.gridVerdict()).toBe('coarse');
  });

  it('calls a clock that never moved inside a poll too coarse after enough samples', () => {
    const policy = new GpuClockPolicy();
    for (let i = 0; i < GRID_MIN_SAMPLES - 1; i++) feed(policy, { costMs: 0.5, minStepMs: null });
    expect(policy.gridVerdict()).toBeNull();
    feed(policy, { costMs: 0.5, minStepMs: null });
    expect(policy.gridVerdict()).toBe('coarse');
  });
});

describe('the predictor', () => {
  it('holds the pre-submit part and scales the rest by the ratio to the exponent', () => {
    // 2 ms of building and 7 ms after it, one rung up (2 → 2.5), nothing
    // learned: r^1.5.
    const guess = growthFor(null, 2, 2.5);
    expect(guess).toBeCloseTo(Math.pow(1.25, CLOCK_EXPONENT), 9);
    expect(predictWithGrowthMs(2, 9, guess)).toBeCloseTo(2 + 7 * guess, 9);
    // The per-pixel bound is the exponent 2: the area.
    expect(predictWithGrowthMs(0, 8, growthFor(2, 2, 2.5))).toBeCloseTo(8 * 1.5625, 9);
    // A capped reading predicts a capped reading.
    expect(predictWithGrowthMs(2, Infinity, guess)).toBe(Infinity);
    // Busy can never exceed the reading it is part of.
    expect(predictWithGrowthMs(12, 9, guess)).toBeCloseTo(9, 9);
  });

  it('learns the growth as an exponent, so one step of the ladder carries to another', () => {
    // Measured on 2.5 → 3 (r = 1.2): the GPU part grew from 9 to 10.
    const learned = learnedExponent(9, 10, 2.5, 3)!;
    expect(learned.growth).toBeCloseTo(10 / 9, 9);
    expect(learned.exponent).toBeCloseTo(Math.log(10 / 9) / Math.log(1.2), 9);
    // Applied to Medium → 2.5 (r = 1.25) it is 1.25 to the same power, not
    // the ratio measured on a smaller step.
    expect(growthFor(learned.exponent, 2, 2.5)).toBeCloseTo(Math.pow(1.25, learned.exponent), 9);
    // Held between 0 and 2: equal parts are 0, more than the area is 2.
    expect(learnedExponent(9, 9, 2, 2.5)!.exponent).toBe(0);
    expect(learnedExponent(5, 20, 2, 2.5)!.exponent).toBe(2);
  });

  it('learns nothing from a growth below 1, or from a rung below with no GPU part', () => {
    // A sharper rung that read cheaper is a scene that got cheaper.
    expect(learnedExponent(10, 7, 2, 2.5)).toBeNull();
    expect(learnedExponent(0, 5, 2, 2.5)).toBeNull();
    expect(learnedExponent(Number.NaN, 5, 2, 2.5)).toBeNull();
  });

  it('tries a climb on the rung’s own reading where its p90 is inside three quarters of the bar', () => {
    expect(CALIBRATION_SHARE * (1000 / 60)).toBeCloseTo(12.5, 9);
  });
});

describe('reversals and the clock’s resolution', () => {
  it('calls a sharper rung reading more than 2 ms faster than the rung below a reversal, and nothing less', () => {
    expect(REVERSAL_MS).toBe(2);
    expect(isReversal(9, 7.5)).toBe(false);
    expect(isReversal(9, 6.9)).toBe(true);
    expect(isReversal(7, 7)).toBe(false);
    expect(isReversal(Infinity, 3)).toBe(false);
  });

  it('steers only on a clock that resolves a millisecond or better, and only once that is known', () => {
    expect(GRID_MAX_MS).toBe(1);
    expect(clockResolves(null)).toBe(false);
    expect(clockResolves(1)).toBe(true);
    expect(clockResolves(0.1)).toBe(true);
    expect(clockResolves(1.0999999940395355)).toBe(true);
    expect(clockResolves(GRID_MAX_MS * (1 + GRID_TOLERANCE) + 0.01)).toBe(false);
    expect(clockResolves(16.7)).toBe(false);
  });
});

describe('the rest after a sustained refusal', () => {
  /** Refusals every frame at 60 fps from `fromMs` for `ms`. */
  const refuse = (rest: RefusalRest, fromMs: number, ms: number): number => {
    let t = fromMs;
    for (; t < fromMs + ms; t += 1000 / 60) if (!rest.resting(t)) rest.refused(t);
    return t;
  };

  it('rests only after refusals have gone on for the sustain, with no fit between them', () => {
    const rest = new RefusalRest();
    let t = refuse(rest, 0, REFUSAL_SUSTAIN_MS - 100);
    expect(rest.resting(t)).toBe(false);
    rest.fits();
    t = refuse(rest, t, REFUSAL_SUSTAIN_MS - 100);
    expect(rest.resting(t)).toBe(false);
    t = refuse(rest, t, 200);
    expect(rest.resting(t)).toBe(true);
    expect(rest.state().rests).toBe(1);
  });

  it('retries after each rest with one window, and rests again at once, twice as long, up to the most', () => {
    const rest = new RefusalRest();
    const t0 = refuse(rest, 0, REFUSAL_SUSTAIN_MS + 20);
    const lengths: number[] = [];
    let t = t0;
    for (let i = 0; i < 6; i++) {
      const until = rest.state().restUntilMs!;
      lengths.push(until - t);
      expect(rest.resting(until - 1)).toBe(true);
      t = until;
      expect(rest.resting(t)).toBe(false);
      // The retry's first full window refuses.
      rest.refused(t);
    }
    expect(Math.abs(lengths[0] - REFUSAL_REST_MS)).toBeLessThan(50);
    expect(lengths.slice(1).map((ms) => Math.round(ms))).toEqual([2, 4, 8, 8, 8].map((k) => k * REFUSAL_REST_MS));
    expect(REFUSAL_REST_MAX_MS).toBe(8 * REFUSAL_REST_MS);
  });

  it('starts over when a window fits, and on a reset', () => {
    const rest = new RefusalRest();
    let t = refuse(rest, 0, REFUSAL_SUSTAIN_MS + 20);
    t = rest.state().restUntilMs!;
    rest.refused(t);
    expect(rest.state().nextRestMs).toBe(4 * REFUSAL_REST_MS);
    t = rest.state().restUntilMs!;
    rest.fits();
    expect(rest.resting(t)).toBe(false);
    expect(rest.state()).toEqual({ restUntilMs: null, nextRestMs: REFUSAL_REST_MS, rests: 0 });
    // After a fit, a refusal is the start of a new run, not a retry.
    rest.refused(t);
    expect(rest.resting(t + 1)).toBe(false);
    refuse(rest, t, REFUSAL_SUSTAIN_MS + 20);
    rest.reset();
    expect(rest.state()).toEqual({ restUntilMs: null, nextRestMs: REFUSAL_REST_MS, rests: 0 });
  });
});
