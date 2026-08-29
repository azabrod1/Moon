import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  equirectMapGpuBytes,
  layoutGpuBytes,
  retainedSourceBytes,
  textureGpuBytes,
} from './textureBytes';

/** A classic map: an image of this size, mipped as three defaults it. */
function imageTexture(width: number, height: number): THREE.Texture {
  return new THREE.Texture({ width, height } as unknown as HTMLImageElement);
}

/** A transcoded rung as the KTX2 loader hands it over: the blocks its
 *  container carries, one byte a texel, with its own baked mip chain. */
function compressedTexture(width: number, height: number): THREE.CompressedTexture {
  const mipmaps: Array<{ width: number; height: number; data: Uint8Array }> = [];
  for (let w = width, h = height; w >= 4 && h >= 1; w >>= 1, h >>= 1) {
    mipmaps.push({ width: w, height: h, data: new Uint8Array(w * h) });
  }
  return new THREE.CompressedTexture(mipmaps as unknown as ImageData[], width, height);
}

const MiB = 1024 * 1024;

describe('what a texture costs the device', () => {
  // One table, one answer per kind of texture the two allocators hold. The
  // rows are the four cases that used to be answered by three functions with
  // three different results.
  const cases: Array<{
    what: string;
    tex: () => THREE.Texture | null;
    nominalWidth?: number;
    bytes: number;
  }> = [
    {
      what: 'an uncompressed 4K equirect map: w x h x 4 x 4/3',
      tex: () => imageTexture(4096, 2048),
      bytes: Math.round(4096 * 2048 * 4 * (4 / 3)),
    },
    {
      what: 'a 2048-square colour tile, the sector streamer\'s unit',
      tex: () => imageTexture(2048, 2048),
      bytes: Math.round(2048 * 2048 * 4 * (4 / 3)),
    },
    {
      // The claim the module makes about a transcoded rung: a byte a texel
      // plus its mip chain, which is what an uncompressed map a quarter of
      // its width costs. Within a texel of it — the chain stops at 4 px wide
      // rather than at 1.
      what: 'a compressed 8K rung: the blocks its container carries, a byte a texel',
      tex: () => compressedTexture(8192, 4096),
      bytes: 44_739_240,
    },
    {
      what: 'an unmipped data texture: no mip chain to pay for',
      tex: () => {
        const tex = imageTexture(256, 128);
        tex.generateMipmaps = false;
        return tex;
      },
      bytes: 256 * 128 * 4,
    },
    {
      what: 'the 1024 stand-in a released rung draws from, priced as itself',
      tex: () => imageTexture(1024, 512),
      bytes: Math.round(1024 * 512 * 4 * (4 / 3)),
    },
    {
      what: 'a texture with no readable image, priced at the tier it was asked for',
      tex: () => new THREE.Texture(),
      nominalWidth: 4096,
      bytes: equirectMapGpuBytes(4096),
    },
    {
      what: 'a texture with no readable image and no nominal width at all',
      tex: () => new THREE.Texture(),
      bytes: 0,
    },
    { what: 'no texture', tex: () => null, bytes: 0 },
  ];

  for (const row of cases) {
    it(row.what, () => {
      expect(textureGpuBytes(row.tex(), row.nominalWidth ?? 0)).toBe(row.bytes);
    });
  }

  it('reads the figure stashed at decode once the source behind it is closed', () => {
    // Both allocators close a decoded source after its upload is paid. What
    // is on the GPU has not changed, so the stash wins over the stand-in
    // image left in its place.
    const tex = imageTexture(1024, 512);
    tex.userData.gpuBytes = equirectMapGpuBytes(8192);
    expect(textureGpuBytes(tex)).toBe(equirectMapGpuBytes(8192));
  });

  it('prices an equirect map from its width alone, compressed or not', () => {
    expect(equirectMapGpuBytes(4096) / MiB).toBeCloseTo(42.7, 1);
    expect(equirectMapGpuBytes(8192) / MiB).toBeCloseTo(170.7, 1);
    // A transcoded map is a byte a texel: the 8K rung costs what a 4K one does.
    expect(equirectMapGpuBytes(8192, true)).toBe(equirectMapGpuBytes(4096));
    expect(equirectMapGpuBytes(0)).toBe(0);
    expect(equirectMapGpuBytes(-1)).toBe(0);
  });

  it('prices a transcoded rung at what an uncompressed map a quarter as wide costs', () => {
    const transcoded = textureGpuBytes(compressedTexture(8192, 4096));
    expect(transcoded / equirectMapGpuBytes(2048)).toBeCloseTo(4, 2);
  });

  it('prices a tile layout the same way, before a byte of it has decoded', () => {
    expect(layoutGpuBytes({ width: 2048, height: 2048 }))
      .toBe(textureGpuBytes(imageTexture(2048, 2048)));
  });
});

describe('what a decoded source still holds in RAM', () => {
  /** An ImageBitmap source: the only image kind that can be closed. */
  const bitmap = (width: number, height: number) =>
    ({ width, height, close: () => {} }) as unknown as HTMLImageElement;

  it('counts the bitmap behind a rung at four bytes a texel, with no mip chain', () => {
    expect(retainedSourceBytes(new THREE.Texture(bitmap(4096, 2048)))).toBe(4096 * 2048 * 4);
  });

  it('counts nothing once the source has been released', () => {
    const tex = new THREE.Texture(bitmap(1024, 512));
    tex.userData.sourceReleased = true;
    expect(retainedSourceBytes(tex)).toBe(0);
  });

  it('counts nothing for an <img> element, which holds no closable bitmap', () => {
    expect(retainedSourceBytes(new THREE.Texture({ width: 4096, height: 2048 } as unknown as HTMLImageElement)))
      .toBe(0);
  });

  it('counts nothing for a compressed container, whose blocks are already measured', () => {
    const tex = compressedTexture(1024, 512);
    expect(retainedSourceBytes(tex)).toBe(0);
  });

  it('counts nothing for no texture at all', () => {
    expect(retainedSourceBytes(null)).toBe(0);
    expect(retainedSourceBytes(undefined)).toBe(0);
  });
});
