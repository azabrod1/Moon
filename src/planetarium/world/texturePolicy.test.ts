import * as THREE from 'three';
import { afterEach, describe, it, expect } from 'vitest';
import {
  captureDeviceCaps,
  deviceTextureProfile,
  resetDeviceCapsForTests,
  clampTier,
  resolveTextureUrl,
  resolveTileUrl,
  sectorSetHash,
  sectorSetLayout,
  tileSetPath,
  TEXTURE_TIERS,
  type TextureTier,
} from './texturePolicy';
import { SECTOR_SET_TABLE } from './sectorSets.generated';
import { LEGACY_DESKTOP_PROFILE, LEGACY_TOUCH_PROFILE } from './gpuEnvelope';

// The caps are module state captured from the live renderer; a fake renderer is
// the seam. Production captures once, so a test that wants a second answer
// clears the first. 4096 is the pre-capture default — restore it so test order
// can't leak a cap into another file's expectations.
function withMaxTextureSize(size: number): void {
  resetDeviceCapsForTests();
  captureDeviceCaps({
    capabilities: { getMaxAnisotropy: () => 8, maxTextureSize: size },
  } as unknown as THREE.WebGLRenderer, LEGACY_DESKTOP_PROFILE);
}

afterEach(() => withMaxTextureSize(4096));

function fakeRenderer(maxTextureSize: number): THREE.WebGLRenderer {
  return {
    capabilities: { getMaxAnisotropy: () => 8, maxTextureSize },
  } as unknown as THREE.WebGLRenderer;
}

describe('captureDeviceCaps', () => {
  it('keeps the first capture and hands it back to every later caller', () => {
    // Volume compare and the planetarium both capture, in whichever order a
    // session opens them, and they share one renderer. A second capture used
    // to overwrite the first — so a visit to volume compare re-decided the
    // planetarium's memory profile for the rest of the session, while every
    // ladder handle already built kept the old one.
    resetDeviceCapsForTests();
    expect(captureDeviceCaps(fakeRenderer(16384), LEGACY_TOUCH_PROFILE)).toBe(LEGACY_TOUCH_PROFILE);
    expect(deviceTextureProfile()).toBe(LEGACY_TOUCH_PROFILE);
    expect(captureDeviceCaps(fakeRenderer(4096), LEGACY_DESKTOP_PROFILE)).toBe(LEGACY_TOUCH_PROFILE);
    expect(deviceTextureProfile()).toBe(LEGACY_TOUCH_PROFILE);
    // The GL caps of that first capture stand too: 8K stays loadable.
    expect(clampTier('8k')).toBe('8k');
  });

  it('spends the desktop numbers until a real device is read', () => {
    resetDeviceCapsForTests();
    expect(deviceTextureProfile()).toBe(LEGACY_DESKTOP_PROFILE);
  });
});

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

describe('resolveTileUrl', () => {
  it('puts the set hash in the folder, next to the tier', () => {
    expect(tileSetPath('earth-day.v2', '16k', 'abcd1234')).toBe('textures/tiles/earth-day.v2/16k.abcd1234/');
    expect(resolveTileUrl('earth-day.v2', '16k', 'abcd1234', 2, 1))
      .toMatch(/^\/textures\/tiles\/earth-day\.v2\/16k\.abcd1234\/2_1\.webp$/);
  });

  it('serves tiles from the app’s own origin unless a tile origin is built in', () => {
    // The default build sets no VITE_TILE_ORIGIN, so a tile URL is rooted at
    // the app's base path like every other texture.
    expect(resolveTileUrl('moon', '16k', 'abcd1234', 0, 0).startsWith(import.meta.env.BASE_URL)).toBe(true);
  });

  it('reads a shipped set’s hash and layout from the generated table', () => {
    const entry = SECTOR_SET_TABLE['earth-day.v2/16k'];
    expect(sectorSetHash('earth-day.v2', '16k')).toBe(entry.setHash8);
    expect(sectorSetLayout('earth-day.v2', '16k')).toEqual({
      baseWidth: entry.baseWidth,
      spanU: entry.spanU,
    });
  });

  it('fails open on a set the table does not name, rather than throwing', () => {
    // These resolve while sectorStreamer's SECTOR_SETS literal is being built,
    // at module evaluation: a throw there is a blank app, and `?sectors=0` is
    // read after that import so nothing could turn streaming off first. An
    // empty hash 404s instead, which the body survives by keeping its base
    // map. sectorTiles.assets.test.ts is what keeps the shipped sets named.
    expect(sectorSetHash('earth-day.v2', '32k')).toBe('');
    expect(sectorSetLayout('earth-day.v2', '32k')).toEqual({ baseWidth: 0, spanU: 1 });
    expect(resolveTileUrl('earth-day.v2', '32k', sectorSetHash('earth-day.v2', '32k'), 0, 0))
      .toContain('textures/tiles/earth-day.v2/32k./0_0.webp');
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
