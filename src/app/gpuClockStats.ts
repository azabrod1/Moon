/**
 * gpuClockStats — the statistics a GPU-clock measurement is read through.
 *
 * Pure and DOM-free, so the arithmetic of a measurement campaign can be
 * pinned by a test instead of being trusted because the numbers looked
 * plausible on a device.
 *
 * Three things are computed here and nowhere else:
 *
 *  - **A distribution, never a single frame.** A fence clock reads the moment
 *    a frame's GPU work COMPLETED, which is its cost plus whatever the
 *    browser's scheduler added, so a reading is only meaningful as a median
 *    with its p10/p90 beside it over a window of frames. `summarise` is that
 *    window; `percentile` interpolates between the two neighbouring ranks
 *    (the definition a spreadsheet's PERCENTILE uses) so a 40-frame window is
 *    not quantised to 2.5 % steps.
 *  - **What a poll loop cost.** Each poll of a fence's status is one
 *    synchronous call into the GPU process, and a loop that polls until the
 *    fence signals spends that cost many times inside one frame. The cost per
 *    poll and the interval actually achieved between polls are the two
 *    numbers that decide whether the clock can be afforded, so they are
 *    summarised from the raw before/after stamps rather than averaged on the
 *    way in.
 *  - **The CPU clock's own granularity.** Every reading is a difference of
 *    two `performance.now()` values, and that clock is quantised by policy
 *    (a millisecond on WebKit without cross-origin isolation, a dithered
 *    tenth of one on Chromium), which is a floor under every number in the
 *    record. `minNonZeroDelta` reads the floor off the device rather than
 *    assuming the documented value.
 */

export interface Summary {
  n: number;
  median: number;
  p10: number;
  p90: number;
  min: number;
  max: number;
  mean: number;
}

/**
 * The p-th percentile (p in 0…1) by linear interpolation between the
 * neighbouring ranks. Empty input has no percentile, so callers must check
 * the length; `summarise` does it for them.
 */
export function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const clamped = Math.min(1, Math.max(0, p));
  const at = (sorted.length - 1) * clamped;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (at - lo) * (sorted[hi] - sorted[lo]);
}

export function median(values: readonly number[]): number {
  return percentile(values, 0.5);
}

/** The window's shape, or null where there is nothing to describe. */
export function summarise(values: readonly number[]): Summary | null {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return null;
  const sorted = [...finite].sort((a, b) => a - b);
  return {
    n: sorted.length,
    median: percentile(sorted, 0.5),
    p10: percentile(sorted, 0.1),
    p90: percentile(sorted, 0.9),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
  };
}

/** One poll of a fence's status: the clock either side of the call. */
export interface PollStamp { before: number; after: number }

export interface PollSummary {
  /** Polls in the loop. */
  polls: number;
  /** Main-thread ms the loop spent inside the status calls. */
  costMs: number;
  /** The per-poll call cost. */
  cost: Summary | null;
  /** The interval between one poll's ask and the next's — the loop's achieved resolution. */
  interval: Summary | null;
}

/**
 * What a poll loop cost and what resolution it achieved. The interval is
 * measured ask-to-ask (`before` to `before`), because that is the window in
 * which a signal can go unnoticed; the cost is the call itself.
 */
export function summarisePolls(stamps: readonly PollStamp[]): PollSummary {
  const costs = stamps.map((s) => s.after - s.before);
  const intervals: number[] = [];
  for (let i = 1; i < stamps.length; i++) intervals.push(stamps[i].before - stamps[i - 1].before);
  return {
    polls: stamps.length,
    costMs: costs.reduce((a, b) => a + b, 0),
    cost: summarise(costs),
    interval: summarise(intervals),
  };
}

/**
 * The smallest non-zero step the sampled clock took — its observed
 * granularity. Samples must be in the order they were read; a run of equal
 * reads is the clock standing still and contributes nothing. Null where every
 * sample read the same.
 */
export function minNonZeroDelta(samples: readonly number[]): number | null {
  let best: number | null = null;
  for (let i = 1; i < samples.length; i++) {
    const d = samples[i] - samples[i - 1];
    if (d > 0 && (best === null || d < best)) best = d;
  }
  return best;
}

/**
 * Events per second from their timestamps: the span from first to last over
 * the intervals it contains, never a mean of reciprocals. Null below two
 * stamps, or where they all landed on one instant.
 */
export function ratePerSecond(stampsMs: readonly number[]): number | null {
  if (stampsMs.length < 2) return null;
  const span = stampsMs[stampsMs.length - 1] - stampsMs[0];
  if (!(span > 0)) return null;
  return ((stampsMs.length - 1) * 1000) / span;
}

/** The intervals between consecutive stamps, for a cadence summary. */
export function intervalsOf(stampsMs: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < stampsMs.length; i++) out.push(stampsMs[i] - stampsMs[i - 1]);
  return out;
}

/**
 * One clock's median minus another's — the bias to subtract if the two are
 * measuring the same frames at the same load. Null where either side has no
 * readings, so a missing arm can never read as a zero bias.
 */
export function deltaOfMedians(a: readonly number[], b: readonly number[]): number | null {
  const left = summarise(a);
  const right = summarise(b);
  if (!left || !right) return null;
  return left.median - right.median;
}
