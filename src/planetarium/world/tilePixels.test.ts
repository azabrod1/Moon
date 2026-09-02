import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  TILE_PIXEL_BUDGET_BYTES,
  TILE_PIXEL_RESERVE_BYTES,
  isOpaqueWebp,
  releaseTilePixels,
  tilePixelBudgetAllows,
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
