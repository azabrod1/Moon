/**
 * gpuFrameClockPolicy — what a GPU fence reading means, whether it is trusted,
 * how often one is taken and what the sensor may cost. Pure and DOM-free: the
 * GL calls and the task loop are app/gpuFrameClock.ts and app/fencePoll.ts,
 * and the rule that steers by the readings is app/resolutionController.ts.
 *
 * **A reading** is ONE subtraction: the moment the poll loop saw the frame's
 * fence signalled, less the moment that frame's animation callback started.
 * That is the frame's building on the main thread plus however long after the
 * hand-over the GPU finished it — the elapsed time a frame deadline is
 * compared with. Nothing is added to it: the tick's final busy time is not
 * known when the fence goes in, and main-thread work after the submit runs
 * while the GPU is still drawing, so adding it would count that overlap twice.
 * No bias is subtracted either. A plain fence signals when EVERYTHING queued
 * before it has completed, so a reading on a device that is behind is "behind
 * by this much", not a cost; the rule only ever reads it against a bar.
 *
 * **Whether a reading may steer at all.** The clock it is read on must resolve
 * a millisecond or better (`performance.now()`'s grid, read off the loop's own
 * stamps; a browser that coarsens it further has no clock to offer). Every
 * non-zero step between two stamps is a whole number of grid steps, so the
 * smallest over many of them is the grid — but over a few it can be a stretch
 * in which other work held the loop: a first sample taken while the page was
 * busy saw its polls 1.1 ms apart on a clock whose grid is a tenth of that. So
 * the grid qualifies as soon as a step within `GRID_TOLERANCE` of a millisecond
 * has been seen, and is judged too coarse only after `GRID_MIN_STEPS` steps
 * (or `GRID_MIN_SAMPLES` samples with no step at all) never showed one; until
 * one or the other, no reading steers. Then the
 * stamps must be in order (callback, then submit, then signal), and the gap
 * before the poll that saw the signal — the reading's uncertainty, since the
 * fence signalled somewhere inside it — must be at most `STARVED_GAP_MS`, or
 * one step of the clock's own grid where that is coarser. A longer gap means
 * the loop was not running when it mattered: the main thread had other work
 * and the reading may be late by the whole gap. Such a reading is STARVED: it
 * never enters a statistic, and the share of them is what says the clock has
 * gone quiet. The grid is the floor under the test because below it a gap
 * cannot be read at all: on WebKit's millisecond clock a forty-microsecond gap
 * reads 1 whenever a millisecond boundary falls inside it, and on this
 * project's Mac, moving at Earth's shell, seven starved readings in nine were
 * exactly that — a one-step gap — against two real gaps of 2 and 7 ms. A
 * clock accepted at a millisecond is only asked for what it can resolve: a
 * gap of one step passes, two steps are starved. A fence that has
 * not signalled one and a quarter budgets after the frame began is CAPPED: the
 * loop stops spinning, and the reading counts as over the bar (infinite),
 * because a frame that late is exactly the evidence a hand-back needs.
 *
 * **A sample is taken on one eligible drawn frame in `duty`**, counting only
 * frames where the sensor could have been armed and arming the first CLEAN
 * one (no sliced work, no program link in its tick) once the count runs out,
 * so a duty of 4 cannot fall into step with the alternating upload frames
 * near Earth and see nothing. One fence is in flight at a time; a frame that
 * found one still out is a skipped arm, counted. While the controller is
 * verifying a rung the clock earned, the sensor samples one frame in
 * `DUTY_VERIFY` whatever its priced duty, and those samples and the frames
 * they ran across are kept out of the pricing blocks (they reach the
 * session's totals): the price is a steady-state rate, and a three-second
 * burst at one frame in four costs what twelve seconds at one in sixteen do.
 * No verification is skipped for the duty.
 *
 * **Two prices, per device, no chassis rule**, judged in blocks of
 * `PRICE_BLOCK_SAMPLES` samples. The first is CPU: everything the sensor
 * executes — the fence, every frame's flush, every poll task's handler and
 * the bookkeeping — per drawn frame, against `CPU_PER_FRAME_MAX_MS`. The
 * second is WALL: the poll campaigns' span, first task to last, as a share of
 * the elapsed time, against `CAMPAIGN_SHARE_MAX` — how long the loop keeps the
 * main thread turning over, which keeps a core awake whether or not anything
 * else was waiting. The two are never added (the handler's execution is
 * inside the campaign), and the campaign is never charged to a frame as if it
 * were proven delay. Either over its bar doubles the duty, 4, 8, 16; still
 * over at 16, the sensor is off for the session. The duty never comes back
 * down: a device that priced it once is not re-priced every minute. On this
 * project's Mac in WebKit a campaign is about the whole reading, ~11 ms, so
 * the wall price settles it at one frame in sixteen. Starvation is NEVER a
 * reason to back off — it measures the app's load, not the sensor's cost, and
 * the controller hears it as silence. The 5 % is an occupancy allowance, not
 * an energy measurement; a phone soak is what can validate it. The CPU price
 * is what the sensor's calls cost the main thread, whatever made them slow:
 * an engine that blocks inside `flush()` while the GPU is behind charges that
 * wait to the sensor, so a GPU-bound stretch at Medium can price the sensor
 * up to one frame in sixteen and then off for the session. That is the
 * conservative direction — without the clock the controller is what it was
 * before there was one — but it is a cost the sensor may not have caused.
 *
 * **A sensor that can never help rests.** At Medium, a predictor that keeps
 * refusing the climb — `REFUSAL_SUSTAIN_MS` of refusals from full windows
 * with no fit between them — means the device has no room at this pose, and
 * sampling on would flush every frame and poll one in sixteen for the whole
 * session for nothing. So the sensor stops for `REFUSAL_REST_MS`, then
 * retries: one full window, and a refusal there rests it again for twice as
 * long, up to `REFUSAL_REST_MAX_MS`. A window that fits, a new budget or
 * ladder, or an arrival somewhere else starts it over (`RefusalRest`).
 *
 * **The poll's task source is chosen by measurement**, never by a user-agent
 * string: the first samples alternate `window.postMessage` and a
 * `MessageChannel`, and the one whose loop turned over faster is kept. (On
 * this project's Mac, WebKit's window messages were twice as fast as its
 * channel, and Chromium's channel marginally faster and private.)
 *
 * **The predictor**, a filter on probes and nothing more: a reading is busy +
 * GPU, and only the GPU part grows with pixels, so each reading is carried to
 * the next rung as `busy + (reading − busy) × r^E` from its OWN pre-submit
 * time, r the ratio of the two rungs' pixel ratios (pixels grow as r²), and
 * the p90 of those predictions is what the rule compares. E = 2 would be the
 * per-pixel bound; a fixed per-frame cost makes the real growth slower. The
 * prediction is conservative only while the fixed cost is non-negative and
 * the frame's work grows no faster than its area — a cache that stops
 * fitting, a level of detail that changes or a bottleneck that moves can break
 * that model — which is why a rung is kept by what the verification MEASURES
 * at it and never by the prediction.
 *
 * **Where the frozen numbers were read conservatively.** The signal-gap bar
 * is `STARVED_GAP_MS`, half a millisecond, but on a clock that only resolves
 * a millisecond it is one step of the grid: a gap that clock cannot see
 * below one step is admitted, and a reading it admits can be late by up to
 * that step — never early, so it can only over-read the frame. And the gap
 * of a fence that has already signalled when the loop first asks runs from
 * the submit, across the rest of the callback and the browser's rendering
 * update, so it is nearly always starved: the fastest frames, whose GPU work
 * is done before the loop starts, read as starved rather than as fast, which
 * can hold a very fast device at Medium — never climb one it should not.
 *
 * **Reversals.** A sharper rung that reads more than `REVERSAL_MS` LESS than
 * the rung below it, measured moments apart at the same pose, is suspicious —
 * but a true reading can fall when the scene changes, and a constant bogus
 * reading passes any monotonic test, so one reversal proves nothing. The
 * clock is off for the session only after `REVERSAL_REPEATS` of them.
 */

import type { FencePollSource } from './fencePoll';

/** One eligible frame in this many is sampled at the start. */
export const DUTY_START = 4;

/** And through any verification of a rung the clock earned, whatever the
 *  priced duty: eight readings then arrive in about half a second at 60 fps,
 *  well inside the verification's three seconds, where one frame in sixteen
 *  would need two of them with nothing dropped. */
export const DUTY_VERIFY = 4;

/** And the sparsest the duty goes before the sensor turns itself off. */
export const DUTY_MAX = 16;

/** What everything the sensor executes may cost per drawn frame: about 2 % of
 *  a 60 fps frame. */
export const CPU_PER_FRAME_MAX_MS = 0.3;

/** The share of the elapsed time the poll campaigns may keep the main thread
 *  turning over. */
export const CAMPAIGN_SHARE_MAX = 0.05;

/** Samples in one pricing block: the prices are judged once per block, on
 *  that block's own work, campaigns, frames and time. */
export const PRICE_BLOCK_SAMPLES = 16;

/** A gap before the signalling poll longer than this makes the reading
 *  starved. */
export const STARVED_GAP_MS = 0.5;

/** The coarsest `performance.now()` grid the clock will steer on. */
export const GRID_MAX_MS = 1;

/** The slack on that bar for a grid read as the difference of two floats. */
export const GRID_TOLERANCE = 0.15;

/** Non-zero clock steps seen before a grid that has not qualified is called
 *  too coarse — and, for a clock whose steps never show inside a poll at all,
 *  samples. */
export const GRID_MIN_STEPS = 32;
export const GRID_MIN_SAMPLES = 32;

/** The loop gives up this many budgets after the frame's callback began. */
export const CAP_SHARE = 1.25;

/** Samples each task source is tried for before one is kept. */
export const SOURCE_TRIAL_SAMPLES = 8;

/** The predictor's exponent on the ratio of the rungs' pixel ratios: 2 is the
 *  per-pixel bound. */
export const CLOCK_EXPONENT = 1.5;

/** A climb is taken when the p90 of the next rung's predicted readings fits
 *  this share of the bar. */
export const CLOCK_UP_SHARE = 0.85;

/** A rung is handed back when its measured p90 passes this share of the bar;
 *  the band between the two shares is the hysteresis. */
export const CLOCK_DOWN_SHARE = 0.9;

/** Starved readings above this share of the recent attempts are silence. */
export const STARVED_SHARE_MAX = 0.3;

/** A sharper rung reading this much less than the rung below is a reversal. */
export const REVERSAL_MS = 2;

/** Reversals in a session that turn the clock off. */
export const REVERSAL_REPEATS = 2;

/** The longest signal gap a trusted reading may have: `STARVED_GAP_MS`, or
 *  one step of the clock's grid where that is coarser (with a little slack
 *  for the float the step is read as). */
export function starvedGapLimitMs(gridMs: number | null): number {
  return gridMs !== null && gridMs > STARVED_GAP_MS ? gridMs * 1.001 : STARVED_GAP_MS;
}

/** How long the loop may spin for a frame, from the frame's callback start. */
export function capMsFor(barMs: number): number {
  return CAP_SHARE * barMs;
}

/** Whether a clock with this grid can steer at all. */
export function clockResolves(gridMs: number | null): boolean {
  return gridMs !== null && gridMs <= GRID_MAX_MS * (1 + GRID_TOLERANCE);
}

/** What the poll loop found for one sampled frame. */
export interface PolledSample {
  /** When the sampled frame's animation callback started. */
  callbackStartMs: number;
  /** When the fence and its flush were in. */
  submittedAtMs: number;
  /** When the poll that saw the signal answered, or null where it never did. */
  signalledAtMs: number | null;
  /** The gap before that poll. */
  signalGapMs: number | null;
  capped: boolean;
}

/** What a sample means. */
export interface ClassifiedReading {
  /** signalled − callback start; Infinity where the loop was capped. */
  readingMs: number;
  /** submitted − callback start: the pre-submit wall time, the part of the
   *  reading that does not grow with pixels. */
  busyMs: number;
  starved: boolean;
  capped: boolean;
  /** The stamps were out of order: not a reading at all. */
  invalid: boolean;
}

/** One subtraction, and the flags. */
export function classifyReading(sample: PolledSample, gridMs: number | null = null): ClassifiedReading {
  const busyMs = sample.submittedAtMs - sample.callbackStartMs;
  const invalid = !(busyMs >= 0) || (sample.signalledAtMs !== null && sample.signalledAtMs < sample.submittedAtMs);
  if (sample.capped || sample.signalledAtMs === null) {
    return { readingMs: Infinity, busyMs: Math.max(0, busyMs), starved: false, capped: true, invalid };
  }
  const readingMs = sample.signalledAtMs - sample.callbackStartMs;
  const starved = sample.signalGapMs === null || sample.signalGapMs > starvedGapLimitMs(gridMs);
  return { readingMs, busyMs: Math.max(0, busyMs), starved, capped: false, invalid };
}

/** The next rung's reading, predicted from one reading of this rung: its own
 *  pre-submit part held, the rest scaled by the pixel ratio to the power
 *  `exponent`. */
export function predictReadingMs(
  busyMs: number,
  readingMs: number,
  fromRatio: number,
  toRatio: number,
  exponent: number = CLOCK_EXPONENT,
): number {
  if (!Number.isFinite(readingMs)) return Infinity;
  const busy = Math.min(Math.max(0, busyMs), readingMs);
  const r = fromRatio > 0 ? toRatio / fromRatio : 1;
  return busy + (readingMs - busy) * Math.pow(r, exponent);
}

/** How long the predictor must go on refusing a climb from Medium, with no
 *  window that fits in between, before the sensor rests. */
export const REFUSAL_SUSTAIN_MS = 30_000;

/** The first rest, and where its doubling stops. */
export const REFUSAL_REST_MS = 60_000;
export const REFUSAL_REST_MAX_MS = 480_000;

/**
 * When a sensor whose predictor keeps refusing should stop sampling, and
 * when it should try again (the header). Told of every judgement the
 * predictor makes from a full window at Medium; pure, with the time passed in.
 */
export class RefusalRest {
  /** The first refusal of the run the next fit would end, or null. */
  private refusingSinceMs: number | null = null;
  /** When the last rest ends, or null before any. Once it has ended the
   *  sensor is retrying: the next refusal rests it again at once. */
  private restUntilMs: number | null = null;
  private nextRestMs = REFUSAL_REST_MS;
  /** Rests taken since the last start-over. */
  rests = 0;

  /** The predictor refused a climb from a full window. */
  refused(nowMs: number): void {
    if (this.restUntilMs !== null) {
      if (nowMs >= this.restUntilMs) this.rest(nowMs);
      return;
    }
    if (this.refusingSinceMs === null) this.refusingSinceMs = nowMs;
    else if (nowMs - this.refusingSinceMs >= REFUSAL_SUSTAIN_MS) this.rest(nowMs);
  }

  /** A full window fitted: there is room, and the next refusals start a new
   *  run from the first rest. */
  fits(): void {
    this.reset();
  }

  /** Whether the sensor should stay off now. */
  resting(nowMs: number): boolean {
    return this.restUntilMs !== null && nowMs < this.restUntilMs;
  }

  /** A new budget, a new ladder or a new pose: nothing learned here holds. */
  reset(): void {
    this.refusingSinceMs = null;
    this.restUntilMs = null;
    this.nextRestMs = REFUSAL_REST_MS;
    this.rests = 0;
  }

  /** For the readout. */
  state(): { restUntilMs: number | null; nextRestMs: number; rests: number } {
    return { restUntilMs: this.restUntilMs, nextRestMs: this.nextRestMs, rests: this.rests };
  }

  private rest(nowMs: number): void {
    this.restUntilMs = nowMs + this.nextRestMs;
    this.nextRestMs = Math.min(REFUSAL_REST_MAX_MS, this.nextRestMs * 2);
    this.refusingSinceMs = null;
    this.rests++;
  }
}

/** Whether the sharper rung read more than `REVERSAL_MS` less than the rung
 *  below: suspicious, not yet proof. */
export function isReversal(belowMs: number, aboveMs: number): boolean {
  return Number.isFinite(belowMs) && Number.isFinite(aboveMs) && aboveMs < belowMs - REVERSAL_MS;
}

/** What `recordSample` decided about the sensor itself. */
export type PriceVerdict = { kind: 'duty'; duty: number } | { kind: 'disabled'; reason: string } | null;

/** How many recent readings the readout's median and p90 are taken over. */
const RECENT = 64;

/** An active frame's time counts toward the elapsed time at most this much:
 *  a longer gap is the page away, not the sensor running. */
const FRAME_ELAPSED_CAP_MS = 100;

export class GpuClockPolicy {
  /** One eligible frame in this many is sampled. */
  duty = DUTY_START;
  /** DEV: a duty pinned from the bridge is priced but never moved. */
  dutyPinned = false;
  /** Why the sensor turned itself off, or null while it runs. */
  disabled: string | null = null;
  /** performance.now()'s grid as the loop's own stamps have shown it, and
   *  how many non-zero steps it was the smallest of. */
  gridMs: number | null = null;
  gridSteps = 0;
  /** The task source kept, or null while both are on trial. */
  source: FencePollSource | null = null;

  /** Samples finished, and how many of them were starved, capped or invalid. */
  sampled = 0;
  starvedCount = 0;
  cappedCount = 0;
  invalidCount = 0;
  /** Frames whose count had run out and were clean, but found a fence still
   *  out. */
  skippedArms = 0;

  private countdown = 0;
  /** The sample in flight was armed inside a verification burst. */
  private armedInBurst = false;
  /** The block being priced. */
  private blockCpuMs = 0;
  private blockCampaignMs = 0;
  private blockFrames = 0;
  private blockElapsedMs = 0;
  private blockSamples = 0;
  private lastFrameMs: number | null = null;
  /** The last judged block's prices, for the readout. */
  lastCpuPerFrameMs: number | null = null;
  lastCampaignShare: number | null = null;
  lastCpuPerSampleMs: number | null = null;
  lastCampaignPerSampleMs: number | null = null;
  /** Over the session. */
  totalCpuMs = 0;
  totalCampaignMs = 0;
  totalFrames = 0;
  totalElapsedMs = 0;

  private readonly trial: Record<FencePollSource, number[]> = { window: [], channel: [] };
  private nextTrial: FencePollSource = 'window';

  private readonly recent = new Float64Array(RECENT);
  private readonly recentStarved = new Uint8Array(RECENT);
  private recentHead = 0;
  private recentCount = 0;

  /**
   * An eligible drawn frame, at the end of its draw: fence it? The count runs
   * over eligible frames only; once it has run out, the first clean frame with
   * no fence in flight is armed. `verifying` samples at `DUTY_VERIFY` for as
   * long as it lasts.
   */
  armFrame(clean: boolean, inFlight: boolean, verifying = false): boolean {
    if (this.disabled !== null) return false;
    const duty = this.dutyFor(verifying);
    if (this.countdown > duty - 1) this.countdown = duty - 1;
    if (this.countdown > 0) {
      this.countdown--;
      return false;
    }
    if (!clean) return false;
    if (inFlight) {
      this.skippedArms++;
      return false;
    }
    this.countdown = duty - 1;
    this.armedInBurst = this.inBurst(verifying);
    return true;
  }

  /** The duty a frame is sampled at. */
  dutyFor(verifying: boolean): number {
    return verifying ? Math.min(this.duty, DUTY_VERIFY) : this.duty;
  }

  /** A verification is sampling faster than the priced duty: its work is kept
   *  out of the pricing blocks. */
  inBurst(verifying: boolean): boolean {
    return verifying && this.duty > DUTY_VERIFY;
  }

  /** Whether the sample in flight was armed inside a burst: what its poll
   *  tasks' CPU is charged as. */
  get sampleInBurst(): boolean {
    return this.armedInBurst;
  }

  /** A drawn frame the sensor ran across, at the wall time it was drawn. */
  noteFrame(nowMs: number, verifying = false): void {
    const burst = this.inBurst(verifying);
    if (!burst) this.blockFrames++;
    this.totalFrames++;
    if (this.lastFrameMs !== null) {
      const elapsed = Math.min(FRAME_ELAPSED_CAP_MS, Math.max(0, nowMs - this.lastFrameMs));
      if (!burst) this.blockElapsedMs += elapsed;
      this.totalElapsedMs += elapsed;
    }
    this.lastFrameMs = nowMs;
  }

  /** CPU the sensor executed, wherever it was spent: the fence and the flush
   *  inside the tick, a poll task's handler, the bookkeeping after one.
   *  `burst` keeps it out of the block being priced. */
  noteCpu(ms: number, burst = false): void {
    if (!(ms > 0)) return;
    if (!burst) this.blockCpuMs += ms;
    this.totalCpuMs += ms;
  }

  /** The source the next sample polls on. */
  nextSource(): FencePollSource {
    return this.source ?? this.nextTrial;
  }

  /**
   * A finished sample: learn the clock's grid from its stamps, keep the trial
   * going, classify the reading, and price the sensor once a block is full.
   */
  recordSample(
    sample: PolledSample & {
      source: FencePollSource;
      intervalMeanMs: number | null;
      minStepMs: number | null;
      /** The non-zero steps the smallest was taken over; one where left out. */
      gridSteps?: number;
      campaignMs: number;
    },
  ): { reading: ClassifiedReading; verdict: PriceVerdict } {
    if (sample.minStepMs !== null && sample.minStepMs > 0) {
      this.gridMs = this.gridMs === null ? sample.minStepMs : Math.min(this.gridMs, sample.minStepMs);
      this.gridSteps += Math.max(1, sample.gridSteps ?? 1);
    }
    const reading = classifyReading(sample, this.gridMs);
    this.sampled++;
    if (reading.invalid) this.invalidCount++;
    else if (reading.starved) this.starvedCount++;
    else if (reading.capped) this.cappedCount++;
    if (!reading.invalid) {
      this.recent[this.recentHead] = reading.readingMs;
      this.recentStarved[this.recentHead] = reading.starved ? 1 : 0;
      this.recentHead = (this.recentHead + 1) % RECENT;
      if (this.recentCount < RECENT) this.recentCount++;
    }
    this.recordTrial(sample.source, sample.intervalMeanMs);
    const burst = this.armedInBurst;
    this.armedInBurst = false;
    if (!burst) this.blockSamples++;
    if (sample.campaignMs > 0) {
      if (!burst) this.blockCampaignMs += sample.campaignMs;
      this.totalCampaignMs += sample.campaignMs;
    }
    return { reading, verdict: burst ? null : this.price() };
  }

  /**
   * What the stamps have shown of the clock so far: 'fine' once a step within
   * the bar has been seen, 'coarse' once enough steps (or samples) never
   * showed one, and null while the evidence is too thin to say — a reading
   * steers only on 'fine'.
   */
  gridVerdict(): 'fine' | 'coarse' | null {
    if (clockResolves(this.gridMs)) return 'fine';
    if (this.gridSteps >= GRID_MIN_STEPS) return 'coarse';
    if (this.gridMs === null && this.sampled >= GRID_MIN_SAMPLES) return 'coarse';
    return null;
  }

  /** Turn the sensor off for the session. */
  disable(reason: string): void {
    if (this.disabled === null) this.disabled = reason;
  }

  /** The median and p90 of the recent trusted readings, and the starved share
   *  of the recent ones: diagnostics, not the controller's statistics. */
  recentStats(): { medianMs: number | null; p90Ms: number | null; starvedShare: number | null } {
    const values: number[] = [];
    let starved = 0;
    for (let i = 0; i < this.recentCount; i++) {
      if (this.recentStarved[i] === 1) starved++;
      else values.push(this.recent[i]);
    }
    values.sort((a, b) => a - b);
    const at = (p: number): number | null =>
      values.length === 0 ? null : values[Math.min(values.length - 1, Math.max(0, Math.ceil(p * values.length) - 1))];
    return {
      medianMs: at(0.5),
      p90Ms: at(0.9),
      starvedShare: this.recentCount === 0 ? null : starved / this.recentCount,
    };
  }

  /** The trial's measured mean poll gaps, per source. */
  trialGaps(): Record<FencePollSource, number | null> {
    const median = (xs: number[]): number | null => {
      if (xs.length === 0) return null;
      const s = [...xs].sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)];
    };
    return { window: median(this.trial.window), channel: median(this.trial.channel) };
  }

  /** Start a new pricing block — after a duty is pinned the old block's
   *  frames were drawn at another duty. */
  resetBlock(): void {
    this.blockCpuMs = 0;
    this.blockCampaignMs = 0;
    this.blockFrames = 0;
    this.blockElapsedMs = 0;
    this.blockSamples = 0;
  }

  private recordTrial(source: FencePollSource, intervalMeanMs: number | null): void {
    if (this.source !== null) return;
    // A loop that saw the signal on its first or second poll has no gap to
    // measure; the other source goes next either way.
    if (intervalMeanMs !== null && Number.isFinite(intervalMeanMs)) this.trial[source].push(intervalMeanMs);
    this.nextTrial = this.trial.window.length <= this.trial.channel.length ? 'window' : 'channel';
    if (this.trial.window.length >= SOURCE_TRIAL_SAMPLES && this.trial.channel.length >= SOURCE_TRIAL_SAMPLES) {
      const gaps = this.trialGaps();
      this.source = (gaps.channel ?? Infinity) < (gaps.window ?? Infinity) ? 'channel' : 'window';
    }
  }

  private price(): PriceVerdict {
    if (this.blockSamples < PRICE_BLOCK_SAMPLES) return null;
    const cpu = this.blockFrames > 0 ? this.blockCpuMs / this.blockFrames : Infinity;
    const share = this.blockElapsedMs > 0 ? this.blockCampaignMs / this.blockElapsedMs : Infinity;
    this.lastCpuPerFrameMs = cpu;
    this.lastCampaignShare = share;
    this.lastCpuPerSampleMs = this.blockCpuMs / this.blockSamples;
    this.lastCampaignPerSampleMs = this.blockCampaignMs / this.blockSamples;
    this.resetBlock();
    const cpuOver = cpu > CPU_PER_FRAME_MAX_MS;
    const wallOver = share > CAMPAIGN_SHARE_MAX;
    if ((!cpuOver && !wallOver) || this.dutyPinned) return null;
    if (this.duty < DUTY_MAX) {
      this.duty *= 2;
      this.countdown = 0;
      return { kind: 'duty', duty: this.duty };
    }
    const what = cpuOver
      ? `${cpu.toFixed(2)} ms of CPU a frame`
      : `${Math.round(share * 1000) / 10} % of the main thread's time polling`;
    const reason = `the clock cost ${what} even at one frame in ${this.duty}`;
    this.disable(reason);
    return { kind: 'disabled', reason };
  }
}
