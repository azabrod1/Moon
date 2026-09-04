import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  loadStreamedTexture,
  setBitmapProbeForTests,
  takeBootWarmResponse,
  textureLoader,
  TextureTransportError,
} from './textureBitmapLoader';

/** A minimal ImageBitmap stand-in the loader can wrap and close. */
function fakeBitmap(width = 8, height = 4) {
  return { width, height, close: vi.fn() };
}

function deferredLoad() {
  const calls: Array<{ url: string; onLoad: (t: THREE.Texture) => void; onError: (e: unknown) => void }> = [];
  const spy = vi.spyOn(textureLoader, 'load').mockImplementation(
    ((url: string, onLoad?: (t: THREE.Texture) => void, _p?: unknown, onError?: (e: unknown) => void) => {
      calls.push({ url, onLoad: onLoad!, onError: onError! });
      return new THREE.Texture();
    }) as typeof textureLoader.load,
  );
  return { calls, spy };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  setBitmapProbeForTests(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('loadStreamedTexture', () => {
  it('decodes through the image path when the probe refuses, from the bytes it already fetched', async () => {
    setBitmapProbeForTests(false);
    // API present (else the sync no-API path short-circuits before the probe).
    vi.stubGlobal('createImageBitmap', vi.fn());
    const fetchSpy = vi.fn(async () => ({ ok: true, blob: async () => new Blob(['map']) }));
    vi.stubGlobal('fetch', fetchSpy);
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const { calls } = deferredLoad();
    const onLoad = vi.fn();
    loadStreamedTexture('textures/a.jpg', onLoad, vi.fn());
    await flush();
    // One transfer, and the image reads it back through an object URL rather
    // than asking the network for the same file again.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].url.startsWith('blob:')).toBe(true);
    expect(revoke).not.toHaveBeenCalled();
    const tex = new THREE.Texture();
    calls[0].onLoad(tex);
    expect(onLoad).toHaveBeenCalledWith(tex);
    expect(revoke).toHaveBeenCalledWith(calls[0].url);
    // The blob URL is nobody's business downstream: the texture is named
    // after the map it actually is.
    expect(tex.name).toBe('a.jpg');
    expect(tex.userData.sourceUrl).toBe('textures/a.jpg');
  });

  it('shares one transfer between image-fallback callers, each decoding its own image', async () => {
    setBitmapProbeForTests(false);
    vi.stubGlobal('createImageBitmap', vi.fn());
    let land!: () => void;
    const gate = new Promise<void>((r) => { land = r; });
    const fetchSpy = vi.fn(async () => { await gate; return { ok: true, blob: async () => new Blob(['map']) }; });
    vi.stubGlobal('fetch', fetchSpy);
    const { calls } = deferredLoad();
    const url = 'textures/tiles/earth-day.v2/16k/2_1.webp';
    const loads = [vi.fn(), vi.fn()];
    for (const onLoad of loads) loadStreamedTexture(url, onLoad, vi.fn());
    await flush();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    land();
    await flush();
    // Each caller owns the texture it is handed, so each decodes its own
    // image from its own object URL.
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((c) => c.url)).size).toBe(2);
    for (let i = 0; i < loads.length; i++) {
      calls[i].onLoad(new THREE.Texture());
      expect(loads[i]).toHaveBeenCalledTimes(1);
    }
  });

  it('ends an image-fallback transfer only once the last caller has dropped it', async () => {
    setBitmapProbeForTests(false);
    vi.stubGlobal('createImageBitmap', vi.fn());
    const signals: AbortSignal[] = [];
    let land!: () => void;
    const gate = new Promise<void>((r) => { land = r; });
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { signal: AbortSignal }) => {
      signals.push(init.signal);
      await gate;
      return { ok: true, blob: async () => new Blob(['map']) };
    }));
    deferredLoad();
    const url = 'textures/tiles/earth-day.v2/16k/4_1.webp';
    const first = new AbortController();
    const second = new AbortController();
    loadStreamedTexture(url, vi.fn(), vi.fn(), undefined, first.signal);
    loadStreamedTexture(url, vi.fn(), vi.fn(), undefined, second.signal);
    await flush();
    expect(signals).toHaveLength(1);
    first.abort();
    expect(signals[0].aborted).toBe(false); // the other caller still wants it
    second.abort();
    expect(signals[0].aborted).toBe(true);
    land();
  });

  it('ends the fetch when the caller aborts, and never starts one already aborted', async () => {
    setBitmapProbeForTests(true);
    const signals: AbortSignal[] = [];
    let land!: () => void;
    const gate = new Promise<void>((r) => { land = r; });
    const fetchSpy = vi.fn(async (_url: string, init: { signal: AbortSignal }) => {
      signals.push(init.signal);
      await gate;
      return { ok: true, blob: async () => new Blob() };
    });
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('createImageBitmap', vi.fn(async () => fakeBitmap()));
    const live = new AbortController();
    loadStreamedTexture('textures/maps/c.jpg', vi.fn(), vi.fn(), undefined, live.signal);
    await flush();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(signals[0].aborted).toBe(false);
    live.abort();
    expect(signals[0].aborted).toBe(true); // the only waiter is gone
    land();
    const gone = new AbortController();
    gone.abort();
    const onError = vi.fn();
    loadStreamedTexture('textures/maps/d.jpg', vi.fn(), onError, undefined, gone.signal);
    await flush();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('shares one transfer between callers asking for the same map at once', async () => {
    setBitmapProbeForTests(true);
    let land!: () => void;
    const gate = new Promise<void>((r) => { land = r; });
    const fetchSpy = vi.fn(async () => { await gate; return { ok: true, blob: async () => new Blob() }; });
    const decode = vi.fn(async () => fakeBitmap());
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('createImageBitmap', decode);
    const url = 'textures/tiles/earth-bump/2k/2_1.webp';
    const loads = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    for (const onLoad of loads) loadStreamedTexture(url, onLoad, vi.fn());
    await flush();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    land();
    await flush();
    await flush();
    // Every caller is served, each with its own decode and its own texture:
    // one of them disposing must not take the others' image away.
    expect(decode).toHaveBeenCalledTimes(4);
    const textures = loads.map((l) => {
      expect(l).toHaveBeenCalledTimes(1);
      return l.mock.calls[0][0] as THREE.Texture;
    });
    expect(new Set(textures.map((t) => t.image)).size).toBe(4);
    // A transfer that has landed is not reused: the next caller fetches.
    loadStreamedTexture(url, vi.fn(), vi.fn());
    await flush();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('ends a shared transfer only once the last caller has dropped it', async () => {
    setBitmapProbeForTests(true);
    const signals: AbortSignal[] = [];
    let land!: () => void;
    const gate = new Promise<void>((r) => { land = r; });
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { signal: AbortSignal }) => {
      signals.push(init.signal);
      await gate;
      return { ok: true, blob: async () => new Blob() };
    }));
    vi.stubGlobal('createImageBitmap', vi.fn(async () => fakeBitmap()));
    const url = 'textures/tiles/earth-bump/2k/3_1.webp';
    const first = new AbortController();
    const second = new AbortController();
    loadStreamedTexture(url, vi.fn(), vi.fn(), undefined, first.signal);
    loadStreamedTexture(url, vi.fn(), vi.fn(), undefined, second.signal);
    await flush();
    expect(signals).toHaveLength(1);
    first.abort();
    expect(signals[0].aborted).toBe(false); // the other caller still wants it
    second.abort();
    expect(signals[0].aborted).toBe(true);
    land();
  });

  it('delivers a pre-flipped bitmap texture when the probe passes', async () => {
    setBitmapProbeForTests(true);
    const bitmap = fakeBitmap();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob() })));
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
    const { calls } = deferredLoad();
    const onLoad = vi.fn();
    loadStreamedTexture('textures/maps/b.jpg?v=2', onLoad, vi.fn());
    await flush();
    expect(calls).toHaveLength(0);
    expect(onLoad).toHaveBeenCalledTimes(1);
    const tex = onLoad.mock.calls[0][0] as THREE.Texture;
    expect(tex.image).toBe(bitmap);
    expect(tex.flipY).toBe(false);
    expect(tex.name).toBe('b.jpg');
    expect(tex.userData.sourceUrl).toBe('textures/maps/b.jpg?v=2');
    expect(tex.userData.bitmapPreFlipped).toBe(true);
    // Disposal is the end of the texture's life — the decoded bitmap goes too.
    tex.dispose();
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });

  it('never starts the fetch when interest lapsed during the probe', async () => {
    setBitmapProbeForTests(true);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('createImageBitmap', vi.fn());
    const { calls } = deferredLoad();
    const onError = vi.fn();
    loadStreamedTexture('textures/8k/f.jpg', vi.fn(), onError, () => false);
    await flush();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(TextureTransportError);
  });

  it('skips the decoder fallback when interest lapsed mid-decode', async () => {
    setBitmapProbeForTests(true);
    let wanted = true;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob() })));
    vi.stubGlobal('createImageBitmap', vi.fn(async () => {
      wanted = false; // superseded while decoding
      throw new Error('decoder died');
    }));
    const { calls } = deferredLoad();
    const onError = vi.fn();
    loadStreamedTexture('textures/8k/g.jpg', vi.fn(), onError, () => wanted);
    await flush();
    expect(calls).toHaveLength(0);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('declines the decode when interest lapsed while the bytes were in the air', async () => {
    setBitmapProbeForTests(true);
    const cib = vi.fn(async () => fakeBitmap());
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob() })));
    vi.stubGlobal('createImageBitmap', cib);
    const { calls } = deferredLoad();
    const onLoad = vi.fn();
    const onError = vi.fn();
    loadStreamedTexture('textures/8k/e.jpg', onLoad, onError, () => false);
    await flush();
    expect(cib).not.toHaveBeenCalled();
    expect(onLoad).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(TextureTransportError);
  });

  it('surfaces transport failures to onError without a decoder fallback', async () => {
    setBitmapProbeForTests(true);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, blob: async () => new Blob() })));
    vi.stubGlobal('createImageBitmap', vi.fn());
    const { calls } = deferredLoad();
    const onError = vi.fn();
    loadStreamedTexture('textures/c.jpg', vi.fn(), onError);
    await flush();
    expect(calls).toHaveLength(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(TextureTransportError);
  });

  it('spends one image decode of the same bytes on a bitmap decode failure', async () => {
    setBitmapProbeForTests(true);
    const fetchSpy = vi.fn(async () => ({ ok: true, blob: async () => new Blob(['map']) }));
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('too large'); }));
    const { calls } = deferredLoad();
    const onLoad = vi.fn();
    const onError = vi.fn();
    loadStreamedTexture('textures/d.jpg', onLoad, onError);
    await flush();
    expect(onError).not.toHaveBeenCalled();
    // The fallback decodes the bytes in hand: the file is fetched once.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].url.startsWith('blob:')).toBe(true);
    const tex = new THREE.Texture();
    calls[0].onLoad(tex);
    expect(onLoad).toHaveBeenCalledWith(tex);
  });

  it('drinks the boot fetch-warm instead of fetching the same URL again', async () => {
    setBitmapProbeForTests(true);
    const bitmap = fakeBitmap();
    const fetchSpy = vi.fn(async () => ({ ok: true, blob: async () => new Blob() }));
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
    const warmed = Promise.resolve({ ok: true, blob: async () => new Blob() });
    vi.stubGlobal('__bootTexWarm', new Map([['textures/warm.webp', warmed]]));
    const onLoad = vi.fn();
    loadStreamedTexture('textures/warm.webp', onLoad, vi.fn());
    await flush();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onLoad).toHaveBeenCalledTimes(1);
  });
});

describe('loadStreamedTexture after the worker retires', () => {
  class FakeWorker {
    static instances: FakeWorker[] = [];
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onerror: ((e: { message: string }) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    posted: unknown[] = [];
    constructor() {
      FakeWorker.instances.push(this);
    }
    postMessage(msg: unknown) {
      this.posted.push(msg);
    }
    terminate() {}
  }
  function armWorker() {
    FakeWorker.instances = [];
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:decoder'), revokeObjectURL: vi.fn() });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob() })));
  }

  it('goes to the shared loader when this thread never passed the probe', async () => {
    armWorker();
    const mainDecode = vi.fn(async () => fakeBitmap());
    vi.stubGlobal('createImageBitmap', mainDecode);
    const { loadStreamedTexture, setBitmapProbeForTests, bitmapDecodePath } = await import('./textureBitmapLoader');
    setBitmapProbeForTests(true, { worker: true, main: false });
    expect(bitmapDecodePath()).toBe('worker');
    const { calls } = deferredLoad();
    const onLoad = vi.fn();
    loadStreamedTexture('textures/w.jpg', onLoad, vi.fn());
    await flush();
    expect(FakeWorker.instances[0].posted).toHaveLength(1);
    FakeWorker.instances[0].onerror!({ message: 'worker died' });
    await flush();
    // The request in flight fell back to the loader (one decode failure = one
    // fallback), on the bytes already fetched rather than a second transfer...
    expect(calls.map((c) => c.url)).toEqual(['blob:decoder']);
    expect(mainDecode).not.toHaveBeenCalled();
    // ...and so does every later map: this thread is unverified, so the shared
    // transfer's bytes go straight to the image path.
    expect(bitmapDecodePath()).toBe('loader');
    loadStreamedTexture('textures/x.jpg', vi.fn(), vi.fn());
    await flush();
    await flush();
    expect(calls.map((c) => c.url)).toEqual(['blob:decoder', 'blob:decoder']);
    expect(mainDecode).not.toHaveBeenCalled();
  });

  it('decodes on this thread after a worker failure when this thread passed the probe', async () => {
    armWorker();
    const mainDecode = vi.fn(async () => fakeBitmap());
    vi.stubGlobal('createImageBitmap', mainDecode);
    const { loadStreamedTexture, setBitmapProbeForTests, bitmapDecodePath } = await import('./textureBitmapLoader');
    setBitmapProbeForTests(true, { worker: true, main: true });
    const { calls } = deferredLoad();
    loadStreamedTexture('textures/w.jpg', vi.fn(), vi.fn());
    await flush();
    FakeWorker.instances[0].onerror!({ message: 'worker died' });
    await flush();
    expect(bitmapDecodePath()).toBe('main-thread');
    // The request the worker dropped spent its one loader fallback, on the
    // bytes it already had.
    expect(calls.map((c) => c.url)).toEqual(['blob:decoder']);
    const onLoad = vi.fn();
    loadStreamedTexture('textures/y.jpg', onLoad, vi.fn());
    await flush();
    await flush();
    expect(mainDecode).toHaveBeenCalledWith(expect.any(Blob), { imageOrientation: 'flipY', premultiplyAlpha: 'none' });
    expect(onLoad).toHaveBeenCalled();
  });
});

describe('takeBootWarmResponse', () => {
  it('hands a warmed promise over exactly once', () => {
    const warmed = Promise.resolve(new Response());
    vi.stubGlobal('__bootTexWarm', new Map([['textures/a.webp', warmed]]));
    expect(takeBootWarmResponse('textures/a.webp')).toBe(warmed);
    // A Response body is single-use, and a taken entry must never serve a
    // later retry — the second asker fetches fresh.
    expect(takeBootWarmResponse('textures/a.webp')).toBeUndefined();
    expect(takeBootWarmResponse('textures/other.webp')).toBeUndefined();
  });

  it('is absent-safe before the warm script has run', () => {
    expect(takeBootWarmResponse('textures/a.webp')).toBeUndefined();
  });
});

describe('WorkerBitmapDecoder', () => {
  /** A Worker double: records posted requests, lets the test answer them. */
  class FakeWorker {
    static instances: FakeWorker[] = [];
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onerror: ((e: { message: string }) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    posted: Array<{ id: number; source: unknown; opts: unknown }> = [];
    terminated = false;
    constructor(public url: string) {
      FakeWorker.instances.push(this);
    }
    postMessage(msg: { id: number; source: unknown; opts: unknown }) {
      this.posted.push(msg);
    }
    terminate() {
      this.terminated = true;
    }
  }

  function withFakeWorker() {
    FakeWorker.instances = [];
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:decoder'), revokeObjectURL: vi.fn() });
    vi.stubGlobal('Blob', class { constructor(public parts: unknown[], public opts: unknown) {} });
  }

  it('matches each reply to its request by id and resolves with the transferred bitmap', async () => {
    withFakeWorker();
    const { WorkerBitmapDecoder } = await import('./textureBitmapLoader');
    const decoder = new WorkerBitmapDecoder();
    const a = decoder.decode(new Blob() as Blob, { imageOrientation: 'flipY' });
    const b = decoder.decode(new Blob() as Blob, { imageOrientation: 'flipY' });
    const worker = FakeWorker.instances[0];
    expect(worker.posted.map((m) => m.id)).toEqual([1, 2]);
    expect(worker.posted[0].opts).toEqual({ imageOrientation: 'flipY' });
    const bitmapB = fakeBitmap(2, 2);
    const bitmapA = fakeBitmap(4, 4);
    worker.onmessage!({ data: { id: 2, bitmap: bitmapB } });
    worker.onmessage!({ data: { id: 1, bitmap: bitmapA } });
    expect(await a).toBe(bitmapA);
    expect(await b).toBe(bitmapB);
    expect(decoder.usable).toBe(true);
    // The first reply proved the script loaded: its blob URL is released once.
    expect((URL.revokeObjectURL as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect((URL.revokeObjectURL as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('blob:decoder');
  });

  it('pings an overdue worker and retires it only when the ping goes unanswered', async () => {
    withFakeWorker();
    vi.useFakeTimers();
    try {
      const { WorkerBitmapDecoder, DECODE_TIMEOUT_MS, PING_TIMEOUT_MS } = await import('./textureBitmapLoader');
      const decoder = new WorkerBitmapDecoder();
      const hung = decoder.decode(new Blob() as Blob, {});
      const rejected = vi.fn();
      hung.catch(rejected);
      const worker = FakeWorker.instances[0];
      await vi.advanceTimersByTimeAsync(DECODE_TIMEOUT_MS - 1);
      expect(worker.posted).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(2);
      // Expiry is a question, not a verdict: a ping the worker cannot decode.
      expect(worker.posted).toHaveLength(2);
      expect(worker.posted[1].source).toBeNull();
      expect(rejected).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(PING_TIMEOUT_MS + 1);
      expect(rejected).toHaveBeenCalledTimes(1);
      expect(String(rejected.mock.calls[0][0])).toMatch(/unresponsive/);
      expect(decoder.usable).toBe(false);
      expect(worker.terminated).toBe(true);
      expect((URL.revokeObjectURL as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a live worker whose one decode is slow: re-arms after the ping, gives up on that request alone', async () => {
    withFakeWorker();
    vi.useFakeTimers();
    try {
      const { WorkerBitmapDecoder, DECODE_TIMEOUT_MS } = await import('./textureBitmapLoader');
      const decoder = new WorkerBitmapDecoder();
      const slow = decoder.decode(new Blob() as Blob, {});
      const rejected = vi.fn();
      slow.catch(rejected);
      const worker = FakeWorker.instances[0];
      await vi.advanceTimersByTimeAsync(DECODE_TIMEOUT_MS + 1);
      const ping = worker.posted[1];
      worker.onmessage!({ data: { id: ping.id, error: 'not decodable' } });
      await vi.advanceTimersByTimeAsync(DECODE_TIMEOUT_MS - 10);
      expect(rejected).not.toHaveBeenCalled();
      expect(decoder.usable).toBe(true);
      // Second expiry with a worker that answered: only this decode is given up.
      await vi.advanceTimersByTimeAsync(20);
      expect(rejected).toHaveBeenCalledTimes(1);
      expect(String(rejected.mock.calls[0][0])).toMatch(/gave up/);
      expect(decoder.usable).toBe(true);
      expect(worker.terminated).toBe(false);
      // A late reply to the abandoned request is closed, not leaked.
      const late = fakeBitmap();
      worker.onmessage!({ data: { id: worker.posted[0].id, bitmap: late } });
      expect(late.close).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-arms instead of pinging while the page is hidden (the worker is frozen with it)', async () => {
    withFakeWorker();
    vi.stubGlobal('document', { visibilityState: 'hidden' });
    vi.useFakeTimers();
    try {
      const { WorkerBitmapDecoder, DECODE_TIMEOUT_MS } = await import('./textureBitmapLoader');
      const decoder = new WorkerBitmapDecoder();
      const frozen = decoder.decode(new Blob() as Blob, {});
      const rejected = vi.fn();
      frozen.catch(rejected);
      const worker = FakeWorker.instances[0];
      await vi.advanceTimersByTimeAsync(3 * DECODE_TIMEOUT_MS + 3);
      expect(worker.posted).toHaveLength(1);
      expect(rejected).not.toHaveBeenCalled();
      expect(decoder.usable).toBe(true);
      // Back in the foreground, the decode completes as if nothing happened.
      const bitmap = fakeBitmap();
      worker.onmessage!({ data: { id: worker.posted[0].id, bitmap } });
      expect(await frozen).toBe(bitmap);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a reply clears its timer: a worker is never suspected for a decode it finished', async () => {
    withFakeWorker();
    vi.useFakeTimers();
    try {
      const { WorkerBitmapDecoder, DECODE_TIMEOUT_MS } = await import('./textureBitmapLoader');
      const decoder = new WorkerBitmapDecoder();
      const done = decoder.decode(new Blob() as Blob, {});
      const worker = FakeWorker.instances[0];
      worker.onmessage!({ data: { id: worker.posted[0].id, bitmap: fakeBitmap() } });
      await done;
      await vi.advanceTimersByTimeAsync(2 * DECODE_TIMEOUT_MS + 2);
      expect(worker.posted).toHaveLength(1);
      expect(decoder.usable).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retires when the request cannot even be posted', async () => {
    withFakeWorker();
    const { WorkerBitmapDecoder } = await import('./textureBitmapLoader');
    const post = FakeWorker.prototype.postMessage;
    FakeWorker.prototype.postMessage = () => { throw new Error('DataCloneError'); };
    try {
      const decoder = new WorkerBitmapDecoder();
      await expect(decoder.decode(new Blob() as Blob, {})).rejects.toThrow('DataCloneError');
      expect(decoder.usable).toBe(false);
    } finally {
      FakeWorker.prototype.postMessage = post;
    }
  });

  it('rejects a request the worker reports as failed, and stays usable for the next', async () => {
    withFakeWorker();
    const { WorkerBitmapDecoder } = await import('./textureBitmapLoader');
    const decoder = new WorkerBitmapDecoder();
    const failed = decoder.decode(new Blob() as Blob, {});
    FakeWorker.instances[0].onmessage!({ data: { id: 1, error: 'decode failed' } });
    await expect(failed).rejects.toThrow('decode failed');
    expect(decoder.usable).toBe(true);
    expect(FakeWorker.instances[0].terminated).toBe(false);
  });

  it('retires on a worker error: every request in flight rejects, later ones are refused, a stray reply is closed', async () => {
    withFakeWorker();
    const { WorkerBitmapDecoder } = await import('./textureBitmapLoader');
    const decoder = new WorkerBitmapDecoder();
    const one = decoder.decode(new Blob() as Blob, {});
    const two = decoder.decode(new Blob() as Blob, {});
    const worker = FakeWorker.instances[0];
    worker.onerror!({ message: 'script blew up' });
    await expect(one).rejects.toThrow('script blew up');
    await expect(two).rejects.toThrow('script blew up');
    expect(worker.terminated).toBe(true);
    expect(decoder.usable).toBe(false);
    await expect(decoder.decode(new Blob() as Blob, {})).rejects.toThrow('retired');
    expect(FakeWorker.instances).toHaveLength(1);
    // A reply that arrives after the retire has nobody waiting: its bitmap is freed.
    const stray = fakeBitmap();
    worker.onmessage!({ data: { id: 1, bitmap: stray } });
    expect(stray.close).toHaveBeenCalled();
  });
});
