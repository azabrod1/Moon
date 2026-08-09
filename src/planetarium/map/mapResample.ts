/**
 * When the chart rebuilds its orbit lines, and which one.
 *
 * Each line is a strip of the body's real trajectory taken at one instant, so
 * it goes stale as the sky turns under it — ORBIT_LINE_RESAMPLE_MAX_AGE_MS says
 * how far is too far. Rebuilding all nine costs ~1,600 ephemeris evaluations,
 * and at a warped clock the drift limit trips every handful of frames: paid in
 * one frame that is a stutter the chart injects into ordinary cruise, the
 * corner chart carrying it into flights nobody opened a map for. So the refresh
 * runs on two paths.
 *
 * The COLD path seeds every line at once, and is the only path allowed to: a
 * chart drawing eight lines at last month's epoch is a half-drawn chart, and
 * the app's standing rule is that nothing half-loaded is ever shown. It runs
 * when nothing has been sampled yet — every open, the corner chart's first
 * frame — and when the clock has JUMPED: a date typed in, an event warp, Now.
 * A jump is recognised for what it is rather than announced: the simulation
 * step is dt-capped, so at the fastest rate on the rail a running clock still
 * moves less than the drift limit in one frame, and anything past it in a
 * single step is a discontinuity that staled all nine at once.
 *
 * The DRIFT path rebuilds at most one line per frame, sweeping in order so no
 * line starves behind a neighbour that stales faster.
 *
 * Numbers only: the caller owns the entries, the sampling and the buffers.
 */

/** The one field the sweep reads off a chart entry. */
export interface OrbitEpoch {
  /** Clock instant this orbit's samples were taken at, NaN before the first. */
  epochUtcMs: number;
}

/**
 * Whether the clock has left this orbit's sampling epoch far enough behind
 * that the drawn loop no longer passes through the body. Written against the
 * fresh case so an unsampled entry (NaN) reads stale rather than fresh.
 */
export function orbitEpochStale(epochUtcMs: number, utcMs: number, maxAgeMs: number): boolean {
  return !(Math.abs(utcMs - epochUtcMs) <= maxAgeMs);
}

/**
 * Whether this frame must seed the whole chart rather than refresh one line:
 * nothing sampled yet, no previous frame to measure against, or a clock step
 * no running clock could have taken.
 */
export function needsColdSeed(
  sampled: boolean,
  prevClockUtcMs: number,
  utcMs: number,
  maxAgeMs: number,
): boolean {
  if (!sampled) return true;
  if (!Number.isFinite(prevClockUtcMs)) return true;
  return Math.abs(utcMs - prevClockUtcMs) > maxAgeMs;
}

/**
 * One step of the sweep, taken every frame whatever the step before it found.
 * The cursor is the chart's memory of where the sweep has got to, and it is
 * deliberately shared between the full chart and the corner chart: closing one
 * hands the lap over mid-stride instead of restarting it, which is the whole
 * difference between nine lines refreshed in turn and one line refreshed nine
 * times.
 */
export function advanceOrbitCursor(cursor: number, count: number): number {
  if (count <= 0) return 0;
  const next = cursor + 1;
  return next >= count || next < 0 ? 0 : next;
}

/**
 * Index of the orbit to rebuild this frame, or −1 when none is due. The search
 * starts at `cursor` and wraps once, so every entry gets its turn in order —
 * and walking past the entries that are still fresh (one comparison each)
 * rather than spending the frame on them is what keeps a chart with work
 * outstanding from idling eight frames behind it.
 */
export function nextStaleOrbit(
  entries: readonly OrbitEpoch[],
  cursor: number,
  utcMs: number,
  maxAgeMs: number,
): number {
  const count = entries.length;
  if (count <= 0) return -1;
  const start = ((Math.trunc(cursor) % count) + count) % count;
  for (let step = 0; step < count; step++) {
    const index = (start + step) % count;
    if (orbitEpochStale(entries[index].epochUtcMs, utcMs, maxAgeMs)) return index;
  }
  return -1;
}

export type ResamplePlan =
  | { kind: 'cold' }
  | { kind: 'one'; index: number }
  | { kind: 'none' };

/**
 * The sweep's whole memory: where the lap has got to, and the clock reading
 * the last decision was taken against. One object, owned by the chart and
 * shared by BOTH passes for the map's whole life. The fields are runtime
 * private and only plan() moves them: a close() that reset the cursor —
 * restarting the lap the full-to-corner handover depends on — cannot be
 * written against this class. (Replacing the whole object stays expressible
 * anywhere, as with any owned state; the chart holds its sweep in a
 * `readonly` field so the compiler refuses that too.)
 */
export class ResampleSweep {
  #cursor = 0;
  #prevClockUtcMs = Number.NaN;

  /**
   * One frame's whole refresh decision, taken against — and advancing — the
   * sweep's memory: cold when the chart is unseeded or the clock has jumped,
   * otherwise at most one stale entry from the cursor onward. The state is
   * stamped and stepped HERE so a caller cannot take the decision without
   * paying the bookkeeping that makes the next one right.
   */
  plan(
    sampled: boolean,
    entries: readonly OrbitEpoch[],
    utcMs: number,
    maxAgeMs: number,
  ): ResamplePlan {
    const prev = this.#prevClockUtcMs;
    this.#prevClockUtcMs = utcMs;
    if (needsColdSeed(sampled, prev, utcMs, maxAgeMs)) return { kind: 'cold' };
    this.#cursor = advanceOrbitCursor(this.#cursor, entries.length);
    const due = nextStaleOrbit(entries, this.#cursor, utcMs, maxAgeMs);
    if (due < 0) return { kind: 'none' };
    this.#cursor = due;
    return { kind: 'one', index: due };
  }

  /**
   * The chart seeded every line at `utcMs` OUTSIDE a plan — an open does,
   * before its first frame. Stamp the clock so the next plan measures a
   * running clock against this instant, not against whatever was current
   * before the chart closed. The cursor is deliberately untouched: even a
   * full reseed hands the lap over rather than restarting it.
   */
  seeded(utcMs: number): void {
    this.#prevClockUtcMs = utcMs;
  }
}

/**
 * Whether a moon ring may refill now. An unfilled ring always may — a missing
 * orbit is not a stale one, and gating a first fill would leave a newly
 * revealed system ringless. A filled ring waits out the cadence floor, so a
 * warped clock that stales every ring per frame cannot turn the one-ring
 * budget into a fixed per-frame cost by the back door.
 */
export function ringRefillDue(
  filled: boolean,
  nowMs: number,
  filledAtMs: number,
  minRefillMs: number,
): boolean {
  if (!filled) return true;
  return nowMs - filledAtMs >= minRefillMs;
}
