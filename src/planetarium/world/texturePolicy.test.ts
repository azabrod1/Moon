import { describe, it, expect } from 'vitest';
import { resolveTextureUrl, clampTier } from './texturePolicy';

describe('resolveTextureUrl', () => {
  it('keeps 2K assets in the flat textures folder', () => {
    const url = resolveTextureUrl('mars.jpg', '2k');
    expect(url).toMatch(/textures\/mars\.jpg$/);
    expect(url).not.toContain('4k/');
  });

  it('routes 4K assets to the textures/4k subfolder', () => {
    expect(resolveTextureUrl('mars.jpg', '4k')).toMatch(/textures\/4k\/mars\.jpg$/);
  });
});

describe('clampTier', () => {
  it('keeps 4K when the device max texture size allows it (4096 default)', () => {
    expect(clampTier('4k')).toBe('4k');
  });

  it('never upgrades a 2K request', () => {
    expect(clampTier('2k')).toBe('2k');
  });
});
