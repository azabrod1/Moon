import { describe, expect, it } from 'vitest';
import {
  shadowEventSpecKey,
  startShadowEventSearch,
  stepShadowEventSearch,
  type ShadowEventSearch,
} from './shadowEventSearch';
import { findShadowEvent, listShadowEventSpecs, type ShadowEvent } from '../astronomy/shadows';

const MIN = 60_000;
const FROM = Date.parse('2026-06-12T00:00:00Z');

/** Run a sweep to completion in slices, the way a frame loop does. */
function sweep(search: ShadowEventSearch, budgetMs: number): {
  events: ShadowEvent[];
  slices: number;
  paused: number;
} {
  const events: ShadowEvent[] = [];
  const out: ShadowEvent[] = [];
  let slices = 0;
  let paused = 0;
  for (; slices < 20_000; slices++) {
    const before = search.index;
    const done = stepShadowEventSearch(search, budgetMs, out);
    events.push(...out);
    if (search.index === before && !done) paused++;
    if (done) break;
  }
  return { events, slices, paused };
}

describe('startShadowEventSearch', () => {
  it('covers exactly the system\'s spec set', () => {
    const search = startShadowEventSearch('Jupiter', FROM)!;
    expect(search.specs).toEqual(listShadowEventSpecs('Jupiter'));
    expect(search.index).toBe(0);
    expect(search.resumeCursorUtcMs).toBeNull();
    expect(search.fromUtcMs).toBe(FROM);
  });

  it('refuses a system with nothing to search', () => {
    expect(startShadowEventSearch('Venus', FROM)).toBeNull();
    expect(startShadowEventSearch('Mercury', FROM)).toBeNull();
  });
});

describe('stepShadowEventSearch', () => {
  it('collects the same events a direct search finds', () => {
    const search = startShadowEventSearch('Earth', FROM)!;
    const { events } = sweep(search, 1000);
    expect(events).toHaveLength(2);
    for (const spec of listShadowEventSpecs('Earth')) {
      const direct = findShadowEvent(spec, FROM, 1)!;
      const chunked = events.find(
        (e) => shadowEventSpecKey(e.spec) === shadowEventSpecKey(spec),
      )!;
      expect(chunked).toBeDefined();
      expect(Math.abs(chunked.peakUtcMs - direct.peakUtcMs)).toBeLessThan(MIN);
    }
  });

  it('pauses inside a spec and resumes it to the same answer', () => {
    // A budget this small pauses mid-spec repeatedly; the anchored horizon is
    // what lets those resumes still terminate.
    const search = startShadowEventSearch('Earth', FROM)!;
    const { events, paused } = sweep(search, 0.05);
    expect(paused).toBeGreaterThan(0);
    expect(events).toHaveLength(2);
    for (const spec of listShadowEventSpecs('Earth')) {
      const direct = findShadowEvent(spec, FROM, 1)!;
      const chunked = events.find(
        (e) => shadowEventSpecKey(e.spec) === shadowEventSpecKey(spec),
      )!;
      expect(Math.abs(chunked.peakUtcMs - direct.peakUtcMs)).toBeLessThan(MIN);
    }
  });

  it('never moves the anchor, and advances one spec at a time', () => {
    const search = startShadowEventSearch('Earth', FROM)!;
    const out: ShadowEvent[] = [];
    let previousIndex = 0;
    for (let i = 0; i < 20_000; i++) {
      const done = stepShadowEventSearch(search, 0.05, out);
      expect(search.fromUtcMs).toBe(FROM);
      expect(search.index).toBeGreaterThanOrEqual(previousIndex);
      expect(search.index).toBeLessThanOrEqual(search.specs.length);
      // A paused spec keeps its cursor; a finished one drops it.
      if (search.index > previousIndex) expect(search.resumeCursorUtcMs).toBeNull();
      previousIndex = search.index;
      if (done) break;
    }
    expect(search.index).toBe(search.specs.length);
  });

  it('reports done only once every spec has been searched', () => {
    const search = startShadowEventSearch('Jupiter', FROM)!;
    const out: ShadowEvent[] = [];
    // One tiny slice cannot finish 30+ specs.
    expect(stepShadowEventSearch(search, 0.05, out)).toBe(false);
    expect(search.index).toBeLessThan(search.specs.length);
  });

  it('clears the caller\'s array each slice rather than appending forever', () => {
    const search = startShadowEventSearch('Earth', FROM)!;
    const out: ShadowEvent[] = [];
    let total = 0;
    for (let i = 0; i < 20_000; i++) {
      const done = stepShadowEventSearch(search, 1000, out);
      total += out.length;
      if (done) break;
    }
    expect(total).toBe(2);
    expect(out.length).toBeLessThanOrEqual(2);
  });
});

describe('shadowEventSpecKey', () => {
  it('separates the two kinds for one moon and keeps moons apart', () => {
    const [eclipse, transit] = listShadowEventSpecs('Earth');
    expect(shadowEventSpecKey(eclipse)).not.toBe(shadowEventSpecKey(transit));
    expect(shadowEventSpecKey(eclipse)).toBe(shadowEventSpecKey({ ...eclipse }));
  });
});
