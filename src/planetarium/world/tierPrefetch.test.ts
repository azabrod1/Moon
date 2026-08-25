import { describe, expect, it } from 'vitest';
import { cachePrefetchAllowed, startCachePrefetch } from './tierPrefetch';

describe('cachePrefetchAllowed', () => {
  it('assumes yes when the browser offers no connection hints', () => {
    expect(cachePrefetchAllowed(undefined)).toBe(true);
    expect(cachePrefetchAllowed({})).toBe(true);
  });

  it('respects saveData and 2g-class connections', () => {
    expect(cachePrefetchAllowed({ saveData: true })).toBe(false);
    expect(cachePrefetchAllowed({ effectiveType: '2g' })).toBe(false);
    expect(cachePrefetchAllowed({ effectiveType: 'slow-2g' })).toBe(false);
    expect(cachePrefetchAllowed({ effectiveType: '4g' })).toBe(true);
    expect(cachePrefetchAllowed({ effectiveType: '3g', saveData: false })).toBe(true);
  });
});

/** A fetch seam that records order and hands back a readable body. */
function recordingFetch(log: string[], fail: ReadonlySet<string> = new Set()) {
  return async (url: string) => {
    log.push(url);
    if (fail.has(url)) throw new Error('network says no');
    return { arrayBuffer: async () => new ArrayBuffer(0) };
  };
}

describe('startCachePrefetch', () => {
  it('waits out the start delay, then fetches every URL in order', async () => {
    const fetched: string[] = [];
    const delays: number[] = [];
    const run = startCachePrefetch({
      urls: ['a', 'b', 'c'],
      startDelayMs: 2000,
      delayFn: async (ms) => { delays.push(ms); },
      fetchFn: recordingFetch(fetched),
    });
    await run.done;
    expect(delays).toEqual([2000]);
    expect(fetched).toEqual(['a', 'b', 'c']);
  });

  it('a failed fetch skips that file and moves on — never retries, never rejects', async () => {
    const fetched: string[] = [];
    const run = startCachePrefetch({
      urls: ['a', 'b', 'c'],
      startDelayMs: 0,
      fetchFn: recordingFetch(fetched, new Set(['b'])),
    });
    await run.done;
    expect(fetched).toEqual(['a', 'b', 'c']);
  });

  it('holds between files while shouldPause says so', async () => {
    const fetched: string[] = [];
    let paused = true;
    let polls = 0;
    const run = startCachePrefetch({
      urls: ['a', 'b'],
      startDelayMs: 0,
      // Each poll is one pause beat; release after two so both files must
      // have waited the pause out before fetching.
      shouldPause: () => paused,
      delayFn: async () => { if (++polls >= 2) paused = false; },
      fetchFn: recordingFetch(fetched),
    });
    await run.done;
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(fetched).toEqual(['a', 'b']);
  });

  it('cancel stops before the next file', async () => {
    const fetched: string[] = [];
    const run = startCachePrefetch({
      urls: ['a', 'b', 'c'],
      startDelayMs: 0,
      fetchFn: async (url) => {
        fetched.push(url);
        // Yield once so startCachePrefetch has returned and `run` exists —
        // the sweep starts synchronously when there is no start delay.
        await Promise.resolve();
        if (url === 'a') run.cancel();
        return { arrayBuffer: async () => new ArrayBuffer(0) };
      },
    });
    await run.done;
    expect(fetched).toEqual(['a']);
  });

  it('cancel during the start delay fetches nothing', async () => {
    const fetched: string[] = [];
    let release: (() => void) | null = null;
    const run = startCachePrefetch({
      urls: ['a'],
      startDelayMs: 1000,
      delayFn: () => new Promise<void>((r) => { release = r; }),
      fetchFn: recordingFetch(fetched),
    });
    run.cancel();
    release!();
    await run.done;
    expect(fetched).toEqual([]);
  });
});
