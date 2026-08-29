import { describe, expect, it } from 'vitest';
import html from '../../index.html?raw';
import { PLANET_TEXTURE_FILES } from './PlanetFactory';
import { BRIGHT_STAR_BIN_FILE } from './data/brightStars';
import { takeBootWarmResponse } from './world/textureBitmapLoader';

// index.html fetch-warms the whole boot texture set so the network starts on
// it at HTML parse. These tests pin the warm list to the manifest: a texture
// added to PLANET_TEXTURE_FILES without a warm boots with dead network time
// again, and a warm for a file the boot no longer fetches downloads
// megabytes nobody reads. An inline script rather than <link rel="preload"
// as="fetch"> because WebKit never matches such a preload to the loader's
// later fetch() under any credentials mode — on Safari every boot map
// downloaded twice.

function warmScript(): string {
  return html.match(/<script id="boot-texture-warm">([\s\S]*?)<\/script>/)?.[1] ?? '';
}

function warmedTextures(): string[] {
  return [...warmScript().matchAll(/'([^']+\.webp)'/g)].map((m) => m[1]);
}

describe('index.html boot texture fetch-warm', () => {
  it('warms exactly the boot texture manifest', () => {
    const warmed = warmedTextures();
    expect(new Set(warmed)).toEqual(new Set(Object.values(PLANET_TEXTURE_FILES)));
    expect(warmed).toHaveLength(new Set(warmed).size); // no duplicates
  });

  it('names files that exist on disk', () => {
    // Manifest and warm list agreeing proves nothing if both carry the same
    // stale name — every boot request would 404 while this suite stayed
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

  it('warms the star-catalog sidecar ahead of the texture wave', () => {
    // The catalog gates the starfield build inside activate; its 313KB must
    // hit the network before the 9.2MB of maps queue up behind it. Same
    // BASE_URL join as the loader's fetch, or the taker key never matches.
    const script = warmScript();
    const starWarm = script.indexOf(`'%BASE_URL%${BRIGHT_STAR_BIN_FILE}'`);
    expect(starWarm).toBeGreaterThan(-1);
    // Before the texture LOOP's fetch expression (the files array literal
    // sits above both — declaration order isn't fetch order).
    expect(starWarm).toBeLessThan(script.indexOf("'%BASE_URL%textures/' + files[i]"));
    // The handoff itself, not just the URL: the request must start AND land
    // in the warm map, or the loader quietly fetches the bin a second time.
    expect(script).toContain('var starRequest = fetch(starUrl)');
    expect(script).toContain('warm.set(starUrl, starRequest)');
    const shipped = Object.keys(import.meta.glob('../../public/stardata/*'))
      .map((p) => p.split('/').pop()!);
    expect(shipped, `public/${BRIGHT_STAR_BIN_FILE} is missing`)
      .toContain(BRIGHT_STAR_BIN_FILE.split('/').pop()!);
  });

  it('warms the blocking planet set before the durable moon wave', () => {
    // The 13 awaited planet-level maps gate the loading screen; the moon
    // system streams behind the veil. Order is the only priority signal the
    // warm loop carries, so the gate's files must all sit before the first
    // background one.
    const warmed = warmedTextures();
    const durableWave = new Set([
      PLANET_TEXTURE_FILES.moonNormal,
      PLANET_TEXTURE_FILES.marsNormal,
      // The cloud deck's relief is fetched durably too: the deck draws flat
      // until it lands rather than holding first paint for it.
      PLANET_TEXTURE_FILES.earthCloudsNormal,
      PLANET_TEXTURE_FILES.moon,
      PLANET_TEXTURE_FILES.io,
      PLANET_TEXTURE_FILES.europa,
      PLANET_TEXTURE_FILES.ganymede,
      PLANET_TEXTURE_FILES.callisto,
      PLANET_TEXTURE_FILES.triton,
    ]);
    const firstBackground = warmed.findIndex((f) => durableWave.has(f));
    const lastBlocking = warmed.reduce(
      (last, f, i) => (durableWave.has(f) ? last : i),
      -1,
    );
    expect(firstBackground).toBeGreaterThan(lastBlocking);
  });

  it('stashes the promises under the key the loader takes them from', () => {
    // Both ends of the handoff, pinned against each other: the inline script
    // must write the global this test stores under, and takeBootWarmResponse
    // must find what is stored there — rename either alone and this fails.
    expect(warmScript()).toContain('window.__bootTexWarm = warm');
    // The URLs must ride the Vite base: this page is not served from the
    // domain root on Pages, and a bare '/textures/' key would neither fetch
    // nor match the loader's BASE_URL-joined URL there.
    expect(warmScript()).toContain("'%BASE_URL%textures/' + files[i]");
    const warmed = Promise.resolve(new Response());
    (globalThis as Record<string, unknown>).__bootTexWarm = new Map([['textures/x.webp', warmed]]);
    try {
      expect(takeBootWarmResponse('textures/x.webp')).toBe(warmed);
    } finally {
      delete (globalThis as Record<string, unknown>).__bootTexWarm;
    }
  });
});
