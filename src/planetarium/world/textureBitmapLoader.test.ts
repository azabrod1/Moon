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
  it('falls back to the shared TextureLoader when the probe refuses', async () => {
    setBitmapProbeForTests(false);
    // API present (else the sync no-API path short-circuits before the probe).
    vi.stubGlobal('createImageBitmap', vi.fn());
    const { calls } = deferredLoad();
    const onLoad = vi.fn();
    loadStreamedTexture('textures/a.jpg', onLoad, vi.fn());
    await flush();
    expect(calls.map((c) => c.url)).toEqual(['textures/a.jpg']);
    const tex = new THREE.Texture();
    calls[0].onLoad(tex);
    expect(onLoad).toHaveBeenCalledWith(tex);
  });

  it('hands the caller\'s abort signal to the fetch, and never starts one already aborted', async () => {
    setBitmapProbeForTests(true);
    const fetchSpy = vi.fn(async () => ({ ok: true, blob: async () => new Blob() }));
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('createImageBitmap', vi.fn(async () => fakeBitmap()));
    const live = new AbortController();
    loadStreamedTexture('textures/maps/c.jpg', vi.fn(), vi.fn(), undefined, live.signal);
    await flush();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((fetchSpy.mock.calls[0] as unknown[])[1]).toEqual({ signal: live.signal });
    const gone = new AbortController();
    gone.abort();
    const onError = vi.fn();
    loadStreamedTexture('textures/maps/d.jpg', vi.fn(), onError, undefined, gone.signal);
    await flush();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
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

  it('spends one TextureLoader fallback on a decode failure', async () => {
    setBitmapProbeForTests(true);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob() })));
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('too large'); }));
    const { calls } = deferredLoad();
    const onLoad = vi.fn();
    const onError = vi.fn();
    loadStreamedTexture('textures/d.jpg', onLoad, onError);
    await flush();
    expect(onError).not.toHaveBeenCalled();
    expect(calls.map((c) => c.url)).toEqual(['textures/d.jpg']);
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
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:decoder') });
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
