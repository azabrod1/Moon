import * as THREE from 'three';
import { afterEach, describe, it, expect } from 'vitest';
import { captureDeviceTextureCaps, clampTier, resolveTextureUrl, TEXTURE_TIERS, type TextureTier } from './texturePolicy';

// The caps are module state captured from the live renderer; a fake renderer is
// the seam. 4096 is the pre-capture default — restore it so test order can't
// leak a cap into another file's expectations.
function withMaxTextureSize(size: number): void {
  captureDeviceTextureCaps({
    capabilities: { getMaxAnisotropy: () => 8, maxTextureSize: size },
  } as unknown as THREE.WebGLRenderer);
}

afterEach(() => withMaxTextureSize(4096));

describe('resolveTextureUrl', () => {
  it('keeps boot-tier assets in the flat textures folder', () => {
    const url = resolveTextureUrl('mars.webp', '2k');
    expect(url).toMatch(/textures\/mars\.webp$/);
    expect(url).not.toContain('4k/');
  });

  it('routes higher tiers to their own subfolder, same filename', () => {
    expect(resolveTextureUrl('mars.webp', '4k')).toMatch(/textures\/4k\/mars\.webp$/);
    expect(resolveTextureUrl('moon.webp', '8k')).toMatch(/textures\/8k\/moon\.webp$/);
  });
});

describe('clampTier', () => {
  const cases: Array<{ cap: number; expected: Record<TextureTier, TextureTier> }> = [
    { cap: 2048, expected: { '2k': '2k', '4k': '2k', '8k': '2k' } },
    { cap: 4096, expected: { '2k': '2k', '4k': '4k', '8k': '4k' } },
    { cap: 8192, expected: { '2k': '2k', '4k': '4k', '8k': '8k' } },
  ];

  for (const { cap, expected } of cases) {
    it(`resolves every request against a ${cap} max texture size`, () => {
      withMaxTextureSize(cap);
      for (const tier of TEXTURE_TIERS) expect(clampTier(tier)).toBe(expected[tier]);
    });
  }

  it('drops an 8K request all the way to the boot tier below 4096', () => {
    // The step-down is not one rung at a time: a device that cannot hold 4096
    // must not be handed 4K on its way down from 8K.
    withMaxTextureSize(2048);
    expect(clampTier('8k')).toBe('2k');
  });
});
