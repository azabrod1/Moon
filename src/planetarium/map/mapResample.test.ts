import { describe, expect, it } from 'vitest';
import {
  advanceOrbitCursor,
  needsColdSeed,
  nextStaleOrbit,
  orbitEpochStale,
  ResampleSweep,
  ringRefillDue,
  type OrbitEpoch,
} from './mapResample';
import { trajectoryLineBodyFraction } from '../../astronomy/planetary';
import { PLANETARIUM_BODIES } from '../planets/planetData';
import { ORBIT_LINE_RESAMPLE_MAX_AGE_MS } from '../SolarSystem';

const DAY_MS = 86_400_000;
const MAX_AGE = ORBIT_LINE_RESAMPLE_MAX_AGE_MS;
const T0 = Date.parse('2026-08-04T00:00:00Z');

function epochs(...values: number[]): OrbitEpoch[] {
  return values.map(epochUtcMs => ({ epochUtcMs }));
}

/** Nine entries, all sampled at T0 — a chart straight off the cold path. */
function seeded(utcMs = T0): OrbitEpoch[] {
  return epochs(...new Array(9).fill(utcMs));
}

describe('orbitEpochStale', () => {
  it('holds an orbit fresh right up to the drift limit', () => {
    expect(orbitEpochStale(T0, T0, MAX_AGE)).toBe(false);
    expect(orbitEpochStale(T0, T0 + MAX_AGE, MAX_AGE)).toBe(false);
    expect(orbitEpochStale(T0, T0 + MAX_AGE + 1, MAX_AGE)).toBe(true);
  });

  it('stales symmetrically — the clock running backwards ages a line too', () => {
    expect(orbitEpochStale(T0, T0 - MAX_AGE - 1, MAX_AGE)).toBe(true);
  });

  it('reads an orbit that has never been sampled as stale', () => {
    expect(orbitEpochStale(Number.NaN, T0, MAX_AGE)).toBe(true);
  });
});

describe('needsColdSeed', () => {
  it('seeds a chart that has never sampled', () => {
    expect(needsColdSeed(false, T0, T0, MAX_AGE)).toBe(true);
  });

  it('seeds the first frame, with no previous clock to measure against', () => {
    expect(needsColdSeed(true, Number.NaN, T0, MAX_AGE)).toBe(true);
  });

  it('leaves an ordinary frame on the drift path at the fastest rate', () => {
    // 1 yr/s against the 100 ms simulation-step cap: the largest step a
    // RUNNING clock can take in one frame, and it stays well inside the limit.
    const fastestFrameMs = (365.25 * DAY_MS) * 0.1;
    expect(fastestFrameMs).toBeLessThan(MAX_AGE);
    expect(needsColdSeed(true, T0, T0 + fastestFrameMs, MAX_AGE)).toBe(false);
  });

  it('seeds on a clock jump — a date set, an event warp, Now', () => {
    const jump = T0 + 400 * DAY_MS;
    expect(needsColdSeed(true, T0, jump, MAX_AGE)).toBe(true);
    // Backwards jumps are jumps too.
    expect(needsColdSeed(true, T0, T0 - 400 * DAY_MS, MAX_AGE)).toBe(true);
  });

  it('leaves a paused clock alone', () => {
    expect(needsColdSeed(true, T0, T0, MAX_AGE)).toBe(false);
  });
});

describe('advanceOrbitCursor', () => {
  it('advances exactly one entry per frame and wraps at the end', () => {
    const visited: number[] = [];
    let cursor = 0;
    for (let frame = 0; frame < 10; frame++) {
      cursor = advanceOrbitCursor(cursor, 9);
      visited.push(cursor);
    }
    expect(visited).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 0, 1]);
  });

  it('survives a chart handover — the corner chart carries the lap on', () => {
    // Six frames of the full chart, then the map closes and the corner chart
    // takes over with the same cursor: the sweep continues rather than
    // restarting, so no entry is visited twice while another waits.
    let cursor = 0;
    for (let frame = 0; frame < 6; frame++) cursor = advanceOrbitCursor(cursor, 9);
    expect(cursor).toBe(6);
    const afterHandover = advanceOrbitCursor(cursor, 9);
    expect(afterHandover).toBe(7);
  });

  it('parks at zero when there is nothing to sweep', () => {
    expect(advanceOrbitCursor(4, 0)).toBe(0);
  });
});

describe('nextStaleOrbit', () => {
  it('reports nothing due on a freshly seeded chart', () => {
    expect(nextStaleOrbit(seeded(), 0, T0 + DAY_MS, MAX_AGE)).toBe(-1);
  });

  it('picks the stale entry, walking past the fresh ones', () => {
    const entries = seeded();
    entries[5].epochUtcMs = T0 - 10 * MAX_AGE;
    expect(nextStaleOrbit(entries, 0, T0, MAX_AGE)).toBe(5);
  });

  it('returns one index — a frame rebuilds at most one line', () => {
    const entries = seeded();
    for (const entry of entries) entry.epochUtcMs = T0 - 10 * MAX_AGE;
    const due = nextStaleOrbit(entries, 3, T0, MAX_AGE);
    expect(due).toBe(3);
  });

  it('starts from the cursor, so no entry starves behind a faster-staling one', () => {
    const entries = seeded();
    entries[0].epochUtcMs = T0 - 10 * MAX_AGE;
    entries[7].epochUtcMs = T0 - 10 * MAX_AGE;
    // From the top the near entry wins; from past it, the far one does.
    expect(nextStaleOrbit(entries, 0, T0, MAX_AGE)).toBe(0);
    expect(nextStaleOrbit(entries, 1, T0, MAX_AGE)).toBe(7);
  });

  it('wraps the search exactly once', () => {
    const entries = seeded();
    entries[2].epochUtcMs = T0 - 10 * MAX_AGE;
    expect(nextStaleOrbit(entries, 6, T0, MAX_AGE)).toBe(2);
  });

  it('gives every entry its turn over a lap of the sweep', () => {
    // The steady state the bug produced: a clock warped far enough that every
    // line is due again the moment it is refreshed. One rebuild per frame, and
    // over nine frames each of the nine is rebuilt exactly once.
    const entries = seeded(T0 - 10 * MAX_AGE);
    let cursor = 0;
    const rebuilt: number[] = [];
    for (let frame = 0; frame < 9; frame++) {
      cursor = advanceOrbitCursor(cursor, entries.length);
      const due = nextStaleOrbit(entries, cursor, T0, MAX_AGE);
      expect(due).toBeGreaterThanOrEqual(0);
      cursor = due;
      entries[due].epochUtcMs = T0;
      rebuilt.push(due);
    }
    expect([...rebuilt].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(nextStaleOrbit(entries, cursor, T0, MAX_AGE)).toBe(-1);
  });

  it('answers −1 for an empty chart', () => {
    expect(nextStaleOrbit([], 0, T0, MAX_AGE)).toBe(-1);
  });
});

describe('the fade reads its own line epoch', () => {
  // Why the epoch is per entry and not per chart: with a staggered refresh the
  // entries hold different epochs at the same instant, and the direction fade
  // is measured from the epoch its OWN samples were taken at. Reading a
  // neighbour's would put the bright head of the gradient somewhere other than
  // where the body is drawn.
  const earth = PLANETARIUM_BODIES.find(body => body.name === 'Earth')!;

  it('places the body at mid-loop on a line just rebuilt', () => {
    expect(trajectoryLineBodyFraction(earth, T0, T0)).toBeCloseTo(0.5, 12);
  });

  it('moves the fraction when the line epoch is a neighbour’s, not its own', () => {
    const own = trajectoryLineBodyFraction(earth, T0, T0);
    const stale = trajectoryLineBodyFraction(earth, T0 - 55 * DAY_MS, T0);
    // 55 days of an Earth year is ~15% of the loop — a brightness phase that
    // far off the body is the artifact a chart-wide epoch would draw.
    expect(Math.abs(stale - own)).toBeGreaterThan(0.1);
  });
});

describe('ResampleSweep', () => {
  const AGE = 60 * 86_400_000;
  const entry = (epochUtcMs: number) => ({ epochUtcMs });

  it('goes cold when nothing is seeded, and stamps the clock it decided at', () => {
    const sweep = new ResampleSweep();
    const entries = [entry(Number.NaN)];
    expect(sweep.plan(false, entries, 1_000, AGE)).toEqual({ kind: 'cold' });
    // The stamp is observable only through the next decision: one small step
    // on from the instant just decided at must ride the drift path, not
    // re-cold against whatever clock came before.
    entries[0] = entry(1_000);
    expect(sweep.plan(true, entries, 1_001, AGE).kind).not.toBe('cold');
  });

  it('goes cold on a step no running clock could take, then resumes the sweep', () => {
    const sweep = new ResampleSweep();
    const entries = [entry(0), entry(0), entry(0)];
    sweep.plan(false, entries, 0, AGE); // seed
    const jumped = sweep.plan(true, entries, AGE * 10, AGE);
    expect(jumped).toEqual({ kind: 'cold' });
    // The frame after the jump measures against the jumped clock, not the old one.
    const after = sweep.plan(true, entries, AGE * 10 + 1, AGE);
    expect(after.kind).not.toBe('cold');
  });

  it('a seed outside a plan stamps the clock too — an open does not double-cold', () => {
    const sweep = new ResampleSweep();
    // The open path seeds every line directly, then tells the sweep it did.
    const entries = [entry(5_000)];
    sweep.seeded(5_000);
    expect(sweep.plan(true, entries, 5_001, AGE).kind).not.toBe('cold');
  });

  it('refreshes at most one entry per call, in turn', () => {
    const sweep = new ResampleSweep();
    const entries = [entry(0), entry(0), entry(0)];
    const utc = AGE + 2; // entries sampled at 0 are all stale by now
    sweep.plan(false, entries, utc - 1, AGE); // seed stamps the clock
    const first = sweep.plan(true, entries, utc, AGE);
    expect(first.kind).toBe('one');
    // The caller refreshes what the plan names; mirror that.
    if (first.kind === 'one') entries[first.index] = entry(utc);
    const second = sweep.plan(true, entries, utc + 1, AGE);
    expect(second.kind).toBe('one');
    if (second.kind === 'one' && first.kind === 'one') {
      expect(second.index).not.toBe(first.index);
    }
  });

  it('carries one lap across two alternating passes — the close-to-corner handover', () => {
    // The full chart and the corner chart call with the SAME sweep object;
    // whichever pass runs continues the sweep where the other left it. The
    // sweep's memory is private and the class exports no reset, so a close
    // cannot restart the lap.
    const sweep = new ResampleSweep();
    const entries = [entry(0), entry(0), entry(0), entry(0)];
    const utc = AGE + 2; // entries sampled at 0 are all stale by now
    sweep.plan(false, entries, utc - 1, AGE); // seed stamps the clock
    const seen: number[] = [];
    for (let frame = 0; frame < 4; frame++) {
      // Alternate "passes" (update vs updateMini) — same sweep, same rule.
      const plan = sweep.plan(true, entries, utc + frame, AGE);
      if (plan.kind === 'one') {
        seen.push(plan.index);
        entries[plan.index] = entry(utc + frame);
      }
    }
    expect(new Set(seen).size).toBe(seen.length); // no entry revisited mid-lap
    expect(seen.length).toBe(4); // the lap completes across the handovers
  });

  it('reports none while every line is fresh, and idle frames cost the lap nothing', () => {
    const sweep = new ResampleSweep();
    const entries = [entry(0), entry(0), entry(0)];
    const utc = AGE + 2;
    sweep.plan(false, entries, utc - 1, AGE); // seed stamps the clock
    for (let i = 0; i < entries.length; i++) entries[i] = entry(utc);
    expect(sweep.plan(true, entries, utc, AGE)).toEqual({ kind: 'none' });
    expect(sweep.plan(true, entries, utc + 1, AGE)).toEqual({ kind: 'none' });
    // Now age the whole chart under a RUNNING clock: one stride of exactly the
    // drift limit is the largest step that is not a jump, and it carries the
    // clock past every entry's age at once. The sweep must come out of its
    // idle frames still able to cover all three exactly once.
    const seen: number[] = [];
    for (let frame = 0; frame < 3; frame++) {
      const clock = utc + AGE + 1 + frame;
      const plan = sweep.plan(true, entries, clock, AGE);
      expect(plan.kind).toBe('one');
      if (plan.kind === 'one') {
        seen.push(plan.index);
        entries[plan.index] = entry(clock);
      }
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });
});

describe('ringRefillDue', () => {
  it('always lets a first fill through — a missing orbit is not a stale one', () => {
    expect(ringRefillDue(false, 1_000, 999, 1_000)).toBe(true);
    expect(ringRefillDue(false, 0, Number.NEGATIVE_INFINITY, 1_000)).toBe(true);
  });

  it('holds a filled ring inside the cadence floor', () => {
    expect(ringRefillDue(true, 1_500, 1_000, 1_000)).toBe(false);
  });

  it('releases at the floor and beyond', () => {
    expect(ringRefillDue(true, 2_000, 1_000, 1_000)).toBe(true);
    expect(ringRefillDue(true, 9_000, 1_000, 1_000)).toBe(true);
  });
});
