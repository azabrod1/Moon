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
