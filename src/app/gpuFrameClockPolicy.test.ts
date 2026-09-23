import { describe, expect, it } from 'vitest';
import {
  CAMPAIGN_SHARE_MAX,
  CAP_SHARE,
  CLOCK_EXPONENT,
  CPU_PER_FRAME_MAX_MS,
  DUTY_MAX,
  DUTY_START,
  GRID_MAX_MS,
  GpuClockPolicy,
  PRICE_BLOCK_SAMPLES,
  REVERSAL_MS,
  SOURCE_TRIAL_SAMPLES,
  STARVED_GAP_MS,
  capMsFor,
  classifyReading,
  clockResolves,
  isReversal,
  predictReadingMs,
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
    gapMs?: number;
    minStepMs?: number | null;
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
    intervalMeanMs: opts.gapMs ?? 0.04,
    minStepMs: opts.minStepMs === undefined ? 0.1 : opts.minStepMs,
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
});

describe('the predictor', () => {
  it('holds the pre-submit part and scales the rest by the ratio to the exponent', () => {
    // 2 ms of building and 7 ms after it, one rung up (2 → 2.5).
    const p = predictReadingMs(2, 9, 2, 2.5);
    expect(p).toBeCloseTo(2 + 7 * Math.pow(1.25, CLOCK_EXPONENT), 9);
    // The per-pixel bound is the exponent 2: the area.
    expect(predictReadingMs(0, 8, 2, 2.5, 2)).toBeCloseTo(8 * 1.5625, 9);
    // A capped reading predicts a capped reading.
    expect(predictReadingMs(2, Infinity, 2, 2.5)).toBe(Infinity);
    // Busy can never exceed the reading it is part of.
    expect(predictReadingMs(12, 9, 2, 2.5)).toBeCloseTo(9, 9);
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
    expect(clockResolves(16.7)).toBe(false);
  });
});
