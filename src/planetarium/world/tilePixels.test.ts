import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  TILE_PIXEL_BUDGET_BYTES,
  TILE_PIXEL_RESERVE_BYTES,
  isOpaqueWebp,
  decodeTileTexture,
  releaseTilePixels,
  setTilePixelRoundTrip,
  tilePixelBudgetAllows,
  tilePixelHeldBytes,
} from './tilePixels';

/** A blob whose first bytes are a WebP header of the given kind. */
function webp(kind: string, size = 4096): Blob {
  const head = new Uint8Array(16);
  const write = (at: number, text: string) => {
    for (let i = 0; i < 4; i++) head[at + i] = text.charCodeAt(i);
  };
  write(0, 'RIFF');
  write(8, 'WEBP');
  write(12, kind);
  return new Blob([head, new Uint8Array(Math.max(0, size - 16))]);
}

describe('isOpaqueWebp', () => {
  it('takes the simple lossy WebP the tile pipeline cuts', async () => {
    expect(await isOpaqueWebp(webp('VP8 '))).toBe(true);
  });

  it('refuses the two WebP shapes that can carry alpha', async () => {
    // The canvas round trip un-premultiplies, which is only exact for an
    // opaque image — so a container that MIGHT have alpha takes the path
    // that never reads pixels back.
    expect(await isOpaqueWebp(webp('VP8L'))).toBe(false);
    expect(await isOpaqueWebp(webp('VP8X'))).toBe(false);
  });

  it('refuses bytes that are not WebP at all, and bytes too short to tell', async () => {
    expect(await isOpaqueWebp(new Blob([new Uint8Array(64)]))).toBe(false);
    expect(await isOpaqueWebp(new Blob([new Uint8Array(8)]))).toBe(false);
  });
});

describe('tilePixelBudgetAllows', () => {
  it('holds four tiles at once, and refuses the fifth', () => {
    expect(TILE_PIXEL_BUDGET_BYTES).toBe(4 * TILE_PIXEL_RESERVE_BYTES);
    expect(tilePixelBudgetAllows(0)).toBe(true);
    expect(tilePixelBudgetAllows(3 * TILE_PIXEL_RESERVE_BYTES)).toBe(true);
    expect(tilePixelBudgetAllows(4 * TILE_PIXEL_RESERVE_BYTES)).toBe(false);
  });

  it('charges a whole 2048² tile whatever the real size', () => {
    // One conservative figure, so a smaller tile never has to be trued up and
    // no accounting depends on a decode succeeding.
    expect(TILE_PIXEL_RESERVE_BYTES).toBe(2048 * 2048 * 4);
  });
});

/** A tile texture as the pixel path builds one. */
function tile(): THREE.DataTexture {
  const tex = new THREE.DataTexture(
    new Uint8Array(16 * 16 * 4), 16, 16, THREE.RGBAFormat, THREE.UnsignedByteType,
  );
  tex.userData.ownedPixels = true;
  return tex;
}

describe('releaseTilePixels', () => {
  it('drops the buffer and un-marks the texture', () => {
    const tex = tile();
    releaseTilePixels(tex);
    expect((tex.image as { data: ArrayBufferView }).data.byteLength).toBe(0);
    expect(tex.userData.ownedPixels).toBe(false);
    expect(tex.userData.sourceReleased).toBe(true);
  });

  it('is inert the second time, and on a texture that never owned bytes', () => {
    // The dispose hook and the warm outcome both call it; a double release
    // would hand the byte budget back twice.
    const tex = tile();
    releaseTilePixels(tex);
    expect(() => releaseTilePixels(tex)).not.toThrow();
    const other = new THREE.Texture();
    expect(() => releaseTilePixels(other)).not.toThrow();
    expect(other.userData.sourceReleased).toBeUndefined();
  });
});

describe('the byte budget across every path that ends a decode', () => {
  /** A reply carrying a real buffer of the size the tile claims. */
  const decoded = (id: number, width = 2048, height = 2048) => ({
    id, ok: true as const, width, height, buffer: new ArrayBuffer(width * height * 4),
  });

  beforeEach(() => {
    // The fallback decode is the bitmap path; it only has to produce something.
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
      width: 2048, height: 2048, close: () => {},
    })));
  });

  afterEach(() => {
    setTilePixelRoundTrip(null);
    vi.unstubAllGlobals();
  });

  /** Decode one tile with a scripted worker in place of the real one. */
  function loadOne(reply: (msg: { probe?: boolean }) => Promise<unknown>): Promise<THREE.Texture> {
    setTilePixelRoundTrip(reply as never);
    return decodeTileTexture(webp('VP8 '), 'http://x/1_1.webp');
  }

  const probeOk = { id: 0, ok: true as const, probe: true as const, flipped: true };

  it('gives the reservation back when the worker reports a failure', async () => {
    // Nothing is thrown here — the worker simply could not decode — and the
    // caller gets the bitmap texture. The reservation must not survive it.
    const tex = await loadOne(async (m) => (m.probe ? probeOk : { id: 1, ok: false, error: 'no' }));
    expect(tilePixelHeldBytes()).toBe(0);
    expect(tex.userData.ownedPixels).toBeUndefined();
  });

  it('gives the reservation back when the round trip throws', async () => {
    await expect(loadOne(async (m) => {
      if (m.probe) return probeOk;
      throw new Error('worker exploded');
    })).rejects.toThrow();
    expect(tilePixelHeldBytes()).toBe(0);
  });

  it('gives the reservation back when the texture is disposed before its upload', async () => {
    // A sector abandoned mid-flight disposes the texture it never drew; the
    // dispose listener is what returns the bytes.
    const tex = await loadOne(async (m) => (m.probe ? probeOk : decoded(1)));
    expect(tilePixelHeldBytes()).toBe(TILE_PIXEL_RESERVE_BYTES);
    tex.dispose();
    expect(tilePixelHeldBytes()).toBe(0);
  });

  it('gives the reservation back when the upload is paid', async () => {
    const tex = await loadOne(async (m) => (m.probe ? probeOk : decoded(1)));
    expect(tilePixelHeldBytes()).toBe(TILE_PIXEL_RESERVE_BYTES);
    releaseTilePixels(tex); // what the streamer calls on the 'warmed' outcome
    expect(tilePixelHeldBytes()).toBe(0);
  });

  it('hands the fifth tile in flight to the bitmap decoder, and takes it back after', async () => {
    // The cap is the backstop on decoded RAM. Past it the path fails open
    // rather than queueing, and one release re-opens it.
    const held: THREE.Texture[] = [];
    for (let i = 0; i < 4; i++) held.push(await loadOne(async (m) => (m.probe ? probeOk : decoded(i))));
    expect(tilePixelHeldBytes()).toBe(TILE_PIXEL_BUDGET_BYTES);
    const fifth = await loadOne(async (m) => (m.probe ? probeOk : decoded(9)));
    expect(fifth.userData.ownedPixels).toBeUndefined(); // the bitmap path
    expect(tilePixelHeldBytes()).toBe(TILE_PIXEL_BUDGET_BYTES);
    releaseTilePixels(held[0]);
    const sixth = await loadOne(async (m) => (m.probe ? probeOk : decoded(10)));
    expect(sixth.userData.ownedPixels).toBe(true);
    for (const t of [...held.slice(1), sixth]) releaseTilePixels(t);
    expect(tilePixelHeldBytes()).toBe(0);
  });
});
