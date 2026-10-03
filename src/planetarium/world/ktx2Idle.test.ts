import { describe, expect, it } from 'vitest';
import { IdleLoaderKeeper, KTX2_IDLE_DISPOSE_MS, type IdleTimer } from './ktx2Idle';

/** A timer the test advances by hand. */
function manualTimer(): IdleTimer & { advance(ms: number): void; pending(): number } {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    set(fn, ms) {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clear(handle) { timers.delete(handle as number); },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    pending: () => timers.size,
  };
}

class FakeLoader {
  disposed = false;
  constructor(readonly id: number) {}
  dispose(): void { this.disposed = true; }
}

function keeper(idleMs = KTX2_IDLE_DISPOSE_MS) {
  const timer = manualTimer();
  const made: FakeLoader[] = [];
  const k = new IdleLoaderKeeper(() => {
    const loader = new FakeLoader(made.length + 1);
    made.push(loader);
    return Promise.resolve(loader);
  }, idleMs, timer);
  return { k, timer, made };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('the KTX2 transcoder\'s idle lifetime', () => {
  it('makes no loader until a rung asks for one', () => {
    const { k, made } = keeper();
    expect(made).toHaveLength(0);
    expect(k.state()).toEqual({ inFlight: 0, alive: false, disposedCount: 0 });
  });

  it('shares one loader across a burst of rungs', async () => {
    const { k, made } = keeper();
    const a = k.acquire();
    const b = k.acquire();
    const c = k.acquire();
    expect(made).toHaveLength(1);
    expect(await a.loader).toBe(await b.loader);
    expect(await c.loader).toBe(made[0]);
    expect(k.state()).toEqual({ inFlight: 3, alive: true, disposedCount: 0 });
  });

  it('lets the loader go once nothing has been in flight for the idle interval', async () => {
    const { k, timer, made } = keeper();
    const lease = k.acquire();
    await lease.loader;
    lease.release();
    timer.advance(KTX2_IDLE_DISPOSE_MS - 1);
    expect(made[0].disposed).toBe(false);
    timer.advance(1);
    await flush();
    expect(made[0].disposed).toBe(true);
    expect(k.state()).toEqual({ inFlight: 0, alive: false, disposedCount: 1 });
  });

  it('never disposes with a transcode in flight', async () => {
    const { k, timer, made } = keeper();
    const first = k.acquire();
    const second = k.acquire();
    first.release();
    // One of the burst is still transcoding: no clock at all.
    expect(timer.pending()).toBe(0);
    timer.advance(10 * KTX2_IDLE_DISPOSE_MS);
    await flush();
    expect(made[0].disposed).toBe(false);
    second.release();
    timer.advance(KTX2_IDLE_DISPOSE_MS);
    await flush();
    expect(made[0].disposed).toBe(true);
  });

  it('a rung asked for during the idle interval cancels it and reuses the loader', async () => {
    const { k, timer, made } = keeper();
    k.acquire().release();
    timer.advance(KTX2_IDLE_DISPOSE_MS - 5);
    const late = k.acquire();
    expect(await late.loader).toBe(made[0]);
    timer.advance(KTX2_IDLE_DISPOSE_MS);
    await flush();
    expect(made[0].disposed).toBe(false);
    // The interval restarts from the late rung's settling, not the first's.
    late.release();
    timer.advance(KTX2_IDLE_DISPOSE_MS - 1);
    await flush();
    expect(made[0].disposed).toBe(false);
    timer.advance(1);
    await flush();
    expect(made[0].disposed).toBe(true);
  });

  it('a rung asked for after the dispose makes a fresh loader, never the disposed one', async () => {
    const { k, timer, made } = keeper();
    k.acquire().release();
    timer.advance(KTX2_IDLE_DISPOSE_MS);
    await flush();
    const next = k.acquire();
    expect(made).toHaveLength(2);
    expect(await next.loader).toBe(made[1]);
    expect(made[1].disposed).toBe(false);
    expect(k.state()).toEqual({ inFlight: 1, alive: true, disposedCount: 1 });
  });

  it('counts a lease returned twice once', async () => {
    // A loader's onLoad and onError can both reach the same load: KTX2Loader
    // chains a throwing onLoad to its onError.
    const { k, timer, made } = keeper();
    const a = k.acquire();
    const b = k.acquire();
    a.release();
    a.release();
    expect(k.state().inFlight).toBe(1);
    timer.advance(KTX2_IDLE_DISPOSE_MS);
    await flush();
    expect(made[0].disposed).toBe(false);
    b.release();
    expect(k.state().inFlight).toBe(0);
  });

  it('drops a loader that could not be made, so a later rung tries again', async () => {
    const timer = manualTimer();
    let calls = 0;
    const k = new IdleLoaderKeeper<FakeLoader>(() => {
      calls++;
      if (calls === 1) return Promise.reject(new Error('chunk failed to load'));
      return Promise.resolve(new FakeLoader(calls));
    }, KTX2_IDLE_DISPOSE_MS, timer);
    const failed = k.acquire();
    await expect(failed.loader).rejects.toThrow('chunk failed to load');
    failed.release();
    // Within the interval the failure stands, exactly as it did before.
    const again = k.acquire();
    await expect(again.loader).rejects.toThrow();
    again.release();
    expect(calls).toBe(1);
    timer.advance(KTX2_IDLE_DISPOSE_MS);
    await flush();
    const retried = k.acquire();
    expect((await retried.loader).id).toBe(2);
  });

  it('turns a factory that throws into a rejected loader, and still returns the lease', async () => {
    const timer = manualTimer();
    const k = new IdleLoaderKeeper<FakeLoader>(() => { throw new Error('no'); }, 1000, timer);
    const lease = k.acquire();
    await expect(lease.loader).rejects.toThrow('no');
    lease.release();
    expect(k.state().inFlight).toBe(0);
    timer.advance(1000);
    await flush();
    expect(k.state()).toEqual({ inFlight: 0, alive: false, disposedCount: 1 });
  });

  it('waits long enough to cover a burst and its first retries', () => {
    // An arrival's rungs land seconds apart and a failed rung is retried
    // after 8 s, then 16 s: none of those gaps should pay a fresh transcoder.
    expect(KTX2_IDLE_DISPOSE_MS).toBeGreaterThan(16_000);
    expect(KTX2_IDLE_DISPOSE_MS).toBeLessThanOrEqual(60_000);
  });
});
