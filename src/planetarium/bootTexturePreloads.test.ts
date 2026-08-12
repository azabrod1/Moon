import { describe, expect, it } from 'vitest';
import html from '../../index.html?raw';
import { PLANET_TEXTURE_FILES } from './PlanetFactory';

// index.html preloads the whole boot texture set so the network starts on it
// at HTML parse. These tests pin the preload tags to the manifest: a texture
// added to PLANET_TEXTURE_FILES without a preload boots with dead network
// time again, and a preload for a file the boot no longer fetches downloads
// megabytes nobody reads.

function preloadedTextures(): string[] {
  // crossorigin="anonymous" is load-bearing: with it the preload's request
  // mode/credentials match the streamed loader's plain fetch(), without it
  // the preload cache misses and every boot map downloads twice.
  return [...html.matchAll(/<link rel="preload" as="fetch" crossorigin="anonymous" href="\/textures\/([^"]+)"/g)]
    .map((m) => m[1]);
}

describe('index.html boot texture preloads', () => {
  it('preloads exactly the boot texture manifest', () => {
    const preloaded = preloadedTextures();
    expect(new Set(preloaded)).toEqual(new Set(Object.values(PLANET_TEXTURE_FILES)));
    expect(preloaded).toHaveLength(new Set(preloaded).size); // no duplicates
  });

  it('names files that exist on disk', () => {
    // Manifest and preload list agreeing proves nothing if both carry the
    // same stale name — every boot request would 404 while this suite stayed
    // green. Texture paths are runtime strings (invisible to tsc and Vite),
    // so the shipped directory is the only ground truth.
    const onDisk = new Set(
      Object.keys(import.meta.glob('../../public/textures/*'))
        .map((p) => p.split('/').pop()!),
    );
    for (const file of Object.values(PLANET_TEXTURE_FILES)) {
      expect(onDisk, `public/textures/${file} is missing`).toContain(file);
    }
  });

  it('preloads the blocking planet set before the durable moon wave', () => {
    // The 13 awaited planet-level maps gate the loading screen; the moon
    // system streams behind the veil. Order is the only priority signal a
    // same-priority preload list carries, so the gate's files must all sit
    // before the first background one.
    const preloaded = preloadedTextures();
    const durableWave = new Set([
      PLANET_TEXTURE_FILES.moonNormal,
      PLANET_TEXTURE_FILES.marsNormal,
      PLANET_TEXTURE_FILES.moon,
      PLANET_TEXTURE_FILES.io,
      PLANET_TEXTURE_FILES.europa,
      PLANET_TEXTURE_FILES.ganymede,
      PLANET_TEXTURE_FILES.callisto,
      PLANET_TEXTURE_FILES.triton,
    ]);
    const firstBackground = preloaded.findIndex((f) => durableWave.has(f));
    const lastBlocking = preloaded.reduce(
      (last, f, i) => (durableWave.has(f) ? last : i),
      -1,
    );
    expect(firstBackground).toBeGreaterThan(lastBlocking);
  });
});
