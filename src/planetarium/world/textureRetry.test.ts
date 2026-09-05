import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { fetchTextureDurably, type TextureRetryDeps } from './textureRetry';
import { setBitmapProbeForTests } from './textureBitmapLoader';
import {
  DEFAULT_TEXTURE_RETRY_POLICY,
  retryDelayMs,
  urlSpread,
} from './textureRetryPolicy';

vi.mock('../../shared/debug', () => ({
  debugWarn: () => {},
  debugLog: () => {},
  debugError: () => {},
}));

class FakeTexture {
  disposed = false;
  constructor(readonly label: string) {}
  dispose(): void { this.disposed = true; }
}

interface Attempt {
  url: string;
  at: number;
  onLoad: (tex: unknown) => void;
  onError: (err: unknown) => void;
  stillWanted?: () => boolean;
  signal?: AbortSignal;
}

/** A hand-cranked world: a clock the test moves, a timer queue that fires on
 *  the clock, a loader that records every attempt, and a wake signal the test
 *  dispatches. Nothing here is asynchronous, so the schedule is exact.
 *  `respond` answers an attempt the instant it goes out — three's loader can
 *  do that from cache or from an immediate error. */
function harness(respond?: (attempt: Attempt) => void) {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const attempts: Attempt[] = [];
  const wakeListeners = new Set<() => void>();

  const deps = {
    load: (url, onLoad, _progress, onError, stillWanted, signal) => {
      const attempt: Attempt = {
        url, at: now, onLoad: onLoad as (t: unknown) => void, onError, stillWanted, signal,
      };
      attempts.push(attempt);
      respond?.(attempt);
    },
    now: () => now,
    setTimer: (fn, delayMs) => {
      const id = nextId++;
      timers.set(id, { at: now + delayMs, fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (handle) => { timers.delete(handle as unknown as number); },
    subscribeWake: (fn) => {
      wakeListeners.add(fn);
      return () => wakeListeners.delete(fn);
    },
    policy: DEFAULT_TEXTURE_RETRY_POLICY,
  } satisfies TextureRetryDeps;

  return {
    deps,
    attempts,
    get pendingTimers() { return timers.size; },
    get subscribed() { return wakeListeners.size; },
    advance(ms: number) {
      const target = now + ms;
      // Fire timers in due order, letting a fired timer schedule the next one.
      for (;;) {
        let dueId: number | null = null;
        let dueAt = Infinity;
        for (const [id, t] of timers) {
          if (t.at <= target && t.at < dueAt) { dueId = id; dueAt = t.at; }
        }
        if (dueId === null) break;
        const timer = timers.get(dueId)!;
        timers.delete(dueId);
        now = timer.at;
        timer.fn();
      }
      now = target;
    },
    wake() { for (const fn of [...wakeListeners]) fn(); },
    failAll(reason = 'net down') {
      for (const attempt of attempts.splice(0)) attempt.onError(new Error(reason));
    },
    failLast(reason = 'net down') {
      attempts[attempts.length - 1].onError(new Error(reason));
    },
  };
}

const URL = '/textures/jupiter.jpg';
const delayAfter = (failures: number, url = URL) => retryDelayMs(failures, urlSpread(url));

describe('durable texture fetch', () => {
  it('fetches once and hands over the texture that lands', () => {
    const h = harness();
    const got: unknown[] = [];
    fetchTextureDurably({ url: URL, onLoad: (t) => got.push(t) }, h.deps);
    expect(h.attempts).toHaveLength(1);
    const tex = new FakeTexture('real');
    h.attempts[0].onLoad(tex);
    expect(got).toEqual([tex]);
    expect(tex.disposed).toBe(false);
    // Nothing left running: no timer, no listener.
    h.advance(600_000);
    expect(h.attempts).toHaveLength(1);
    expect(h.pendingTimers).toBe(0);
    expect(h.subscribed).toBe(0);
  });

  it('retries on the backoff ladder and delivers the recovered texture', () => {
    const h = harness();
    const got: unknown[] = [];
    fetchTextureDurably({ url: URL, onLoad: (t) => got.push(t) }, h.deps);
    h.failLast();
    h.advance(delayAfter(1) - 1);
    expect(h.attempts).toHaveLength(1);
    h.advance(1);
    expect(h.attempts).toHaveLength(2);
    h.failLast();
    h.advance(delayAfter(2));
    expect(h.attempts).toHaveLength(3);
    const tex = new FakeTexture('recovered');
    h.attempts[2].onLoad(tex);
    expect(got).toEqual([tex]);
  });

  // The whole point: an outage costs a body its map for as long as the outage
  // lasts, never for the session.
  it('never stops asking, however long the outage runs', () => {
    const h = harness();
    let landed: unknown = null;
    fetchTextureDurably({ url: URL, onLoad: (t) => { landed = t; } }, h.deps);
    for (let i = 0; i < 40; i++) {
      h.failLast();
      h.advance(60_000);
    }
    expect(h.attempts.length).toBe(41);
    // Ten minutes in, the connection returns on its own.
    const tex = new FakeTexture('very late');
    h.attempts[h.attempts.length - 1].onLoad(tex);
    expect(landed).toBe(tex);
  });

  it('reports every failure with its rung, so a caller can settle a fallback', () => {
    const h = harness();
    const rungs: number[] = [];
    fetchTextureDurably(
      { url: URL, onLoad: () => {}, onFailure: (_e, attemptsFailed) => rungs.push(attemptsFailed) },
      h.deps,
    );
    for (let i = 0; i < 4; i++) {
      h.failLast();
      h.advance(60_000);
    }
    expect(rungs).toEqual([1, 2, 3, 4]);
  });

  it('spaces two bodies failing in the same instant onto different retries', () => {
    const h = harness();
    const urls = ['/textures/jupiter.jpg', '/textures/saturn.jpg', '/textures/mars.jpg'];
    for (const url of urls) fetchTextureDurably({ url, onLoad: () => {} }, h.deps);
    h.failAll();
    const firstRetryAt = new Map<string, number>();
    h.advance(10_000);
    for (const attempt of h.attempts) {
      if (!firstRetryAt.has(attempt.url)) firstRetryAt.set(attempt.url, attempt.at);
    }
    expect(new Set(firstRetryAt.values()).size).toBe(urls.length);
  });
});

// A cached file answers inside the load() call, before the seam has finished
// building itself. Both callbacks have to be safe that early.
describe('an attempt answered inline', () => {
  it('hands over a texture that lands before the seam finishes wiring itself', () => {
    const tex = new FakeTexture('cached');
    const h = harness((attempt) => attempt.onLoad(tex));
    const got: unknown[] = [];
    fetchTextureDurably({ url: URL, onLoad: (t) => got.push(t) }, h.deps);
    expect(got).toEqual([tex]);
    expect(tex.disposed).toBe(false);
    // The wake subscription is taken before the first attempt goes out, so an
    // instant success has something to release; taken after, this leaks a
    // listener per cached texture for the whole session.
    expect(h.subscribed).toBe(0);
    expect(h.pendingTimers).toBe(0);
  });

  it('arms the ladder when the first attempt fails inline', () => {
    let offline = true;
    const h = harness((attempt) => { if (offline) attempt.onError(new Error('offline')); });
    fetchTextureDurably({ url: URL, onLoad: () => {} }, h.deps);
    expect(h.attempts).toHaveLength(1);
    offline = false; // the network is back before the retry is due
    h.advance(delayAfter(1));
    expect(h.attempts).toHaveLength(2);
    expect(h.subscribed).toBe(1); // still waiting for the texture
  });
});

describe('wake signals', () => {
  it('re-arms a long pending retry the moment the network returns', () => {
    const h = harness();
    fetchTextureDurably({ url: URL, onLoad: () => {} }, h.deps);
    // Ride the ladder up to its cap.
    for (let i = 0; i < 10; i++) {
      h.failLast();
      h.advance(60_000);
    }
    h.failLast();
    const attemptsBefore = h.attempts.length;
    h.advance(1_000); // deep in a capped wait — nothing is due for ~45 s
    expect(h.attempts).toHaveLength(attemptsBefore);
    h.wake();
    h.advance(DEFAULT_TEXTURE_RETRY_POLICY.wakeStaggerMs);
    expect(h.attempts).toHaveLength(attemptsBefore + 1);
  });

  it('ignores a wake while an attempt is already in flight', () => {
    const h = harness();
    fetchTextureDurably({ url: URL, onLoad: () => {} }, h.deps);
    h.wake();
    h.advance(60_000);
    expect(h.attempts).toHaveLength(1); // the in-flight fetch is untouched
  });

  it('does not turn a stream of wakes into a stream of requests', () => {
    const h = harness();
    fetchTextureDurably({ url: URL, onLoad: () => {} }, h.deps);
    for (let i = 0; i < 6; i++) {
      h.failLast();
      h.advance(60_000);
    }
    h.failLast();
    const attemptsBefore = h.attempts.length;
    for (let i = 0; i < 50; i++) { // a user flipping tabs
      h.wake();
      h.advance(20);
    }
    expect(h.attempts.length - attemptsBefore).toBeLessThanOrEqual(1);
  });

  it('never keeps listening after the texture lands', () => {
    const h = harness();
    fetchTextureDurably({ url: URL, onLoad: () => {} }, h.deps);
    expect(h.subscribed).toBe(1);
    h.attempts[0].onLoad(new FakeTexture('real'));
    expect(h.subscribed).toBe(0);
    h.wake(); // a wake after the hand-off must not restart anything
    h.advance(60_000);
    expect(h.attempts).toHaveLength(1);
  });
});

// The seam's own wiring: which events actually count as a wake. The browser
// names are the whole feature — a fetch waiting out a 45 s rung is rescued by
// `online` and by a tab coming back into view, and by nothing else.
describe('browser wake wiring', () => {
  function installFakeDom() {
    const listeners = new Map<string, Set<() => void>>();
    const target = {
      addEventListener(type: string, fn: () => void) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
      },
      removeEventListener(type: string, fn: () => void) { listeners.get(type)?.delete(fn); },
    };
    const globals = globalThis as unknown as Record<string, unknown>;
    globals.window = target;
    globals.document = { ...target, visibilityState: 'visible' };
    return {
      count: (type: string) => listeners.get(type)?.size ?? 0,
      fire: (type: string) => { for (const fn of [...(listeners.get(type) ?? [])]) fn(); },
      setVisibility: (value: string) => { (globals.document as { visibilityState: string }).visibilityState = value; },
      restore: () => { delete globals.window; delete globals.document; },
    };
  }

  function deepLadder(h: ReturnType<typeof harness>) {
    for (let i = 0; i < 8; i++) {
      h.failLast();
      h.advance(60_000);
    }
    h.failLast(); // now sitting in a capped wait
  }

  it('treats the network returning and the tab reappearing as wakes', () => {
    const dom = installFakeDom();
    try {
      const h = harness();
      const { subscribeWake: _drop, ...deps } = h.deps; // use the real wiring
      const fetch = fetchTextureDurably({ url: URL, onLoad: () => {} }, deps);
      expect(dom.count('online')).toBe(1);
      expect(dom.count('visibilitychange')).toBe(1);

      deepLadder(h);
      let attempts = h.attempts.length;
      dom.fire('online');
      h.advance(1_000);
      expect(h.attempts.length).toBe(attempts + 1);

      h.failLast();
      attempts = h.attempts.length;
      h.advance(3_000); // clear the spacing floor
      dom.fire('visibilitychange');
      h.advance(1_000);
      expect(h.attempts.length).toBe(attempts + 1);

      // A tab going away is not a wake.
      h.failLast();
      attempts = h.attempts.length;
      h.advance(3_000);
      dom.setVisibility('hidden');
      dom.fire('visibilitychange');
      h.advance(1_000);
      expect(h.attempts.length).toBe(attempts);

      fetch.cancel();
      expect(dom.count('online')).toBe(0); // listeners released with the last fetch
      expect(dom.count('visibilitychange')).toBe(0);
    } finally {
      dom.restore();
    }
  });

  // A cold start with the network down leaves dozens of fetches waiting, and
  // they all want the same two events — one pair serves the app.
  it('shares one pair of listeners, releases it with the last fetch, and re-arms after', () => {
    const dom = installFakeDom();
    try {
      const h = harness();
      const { subscribeWake: _drop, ...deps } = h.deps;
      const jupiter = fetchTextureDurably({ url: '/textures/jupiter.jpg', onLoad: () => {} }, deps);
      const saturn = fetchTextureDurably({ url: '/textures/saturn.jpg', onLoad: () => {} }, deps);
      expect(dom.count('online')).toBe(1); // one pair, not one per fetch
      expect(dom.count('visibilitychange')).toBe(1);

      jupiter.cancel();
      expect(dom.count('online')).toBe(1); // the other fetch still wants them
      saturn.cancel();
      expect(dom.count('online')).toBe(0);

      // A body loaded later — a moon photo streaming on approach — must get the
      // wiring back rather than sitting out its ladder deaf.
      const mars = fetchTextureDurably({ url: '/textures/mars.jpg', onLoad: () => {} }, deps);
      expect(dom.count('online')).toBe(1);
      expect(dom.count('visibilitychange')).toBe(1);
      mars.cancel();
    } finally {
      dom.restore();
    }
  });
});

describe('cancellation', () => {
  it('stops the ladder and releases the listener', () => {
    const h = harness();
    const fetch = fetchTextureDurably({ url: URL, onLoad: () => {} }, h.deps);
    h.failLast();
    fetch.cancel();
    h.advance(600_000);
    h.wake();
    h.advance(600_000);
    expect(h.attempts).toHaveLength(1);
    expect(h.pendingTimers).toBe(0);
    expect(h.subscribed).toBe(0);
  });

  it('frees a texture that lands after the cancel instead of leaking it', () => {
    const h = harness();
    const got: unknown[] = [];
    const fetch = fetchTextureDurably({ url: URL, onLoad: (t) => got.push(t) }, h.deps);
    fetch.cancel();
    const tex = new FakeTexture('too late');
    h.attempts[0].onLoad(tex); // three's loader cannot be aborted
    expect(got).toEqual([]);
    expect(tex.disposed).toBe(true);
  });

  it('reaches the loader: the transfer is aborted and the decode declined', () => {
    // Without this the fetch runs to completion and a full-size bitmap is
    // decoded for an attempt nobody is waiting on any more — the exact waste
    // the streamed loader grew its two cancellation arguments for.
    const h = harness();
    const fetch = fetchTextureDurably({ url: URL, onLoad: () => {} }, h.deps);
    const attempt = h.attempts[0];
    expect(attempt.stillWanted?.()).toBe(true);
    expect(attempt.signal?.aborted).toBe(false);
    fetch.cancel();
    expect(attempt.stillWanted?.()).toBe(false);
    expect(attempt.signal?.aborted).toBe(true);
  });

  it('gives each attempt its own signal, so a retry is not born aborted', () => {
    const h = harness();
    fetchTextureDurably({ url: URL, onLoad: () => {} }, h.deps);
    h.failLast();
    h.advance(600_000);
    expect(h.attempts.length).toBeGreaterThan(1);
    const [first, second] = h.attempts;
    expect(second.signal).not.toBe(first.signal);
    expect(second.signal?.aborted).toBe(false);
  });

  it('lets a caller cancel from inside the failure callback', () => {
    const h = harness();
    let fetch: { cancel(): void } | null = null;
    fetch = fetchTextureDurably(
      { url: URL, onLoad: () => {}, onFailure: () => fetch?.cancel() },
      h.deps,
    );
    h.failLast();
    h.advance(600_000);
    expect(h.attempts).toHaveLength(1);
    expect(h.pendingTimers).toBe(0);
  });
});

describe('default loader path', () => {
  it('delivers a pre-flipped bitmap texture through the streamed-texture seam', async () => {
    // Pins the deliberate production choice: with mutable storage removing
    // the sRGB allocation stall (texturePolicy + patches/three), the durable
    // seam takes the probe-guarded bitmap path — a delivered texture wraps the
    // decoded bitmap and does not flip again, which no plain TextureLoader
    // result does.
    setBitmapProbeForTests(true);
    const bitmap = { width: 4, height: 2, close: () => {} };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob() })));
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
    try {
      const delivered = await new Promise<THREE.Texture>((resolve) => {
        fetchTextureDurably({ url: 'textures/pin.jpg', onLoad: (tex) => resolve(tex) });
      });
      expect(delivered.image).toBe(bitmap);
      expect(delivered.flipY).toBe(false);
      expect(delivered.userData.sourceUrl).toBe('textures/pin.jpg');
    } finally {
      setBitmapProbeForTests(null);
      vi.unstubAllGlobals();
    }
  });
});
