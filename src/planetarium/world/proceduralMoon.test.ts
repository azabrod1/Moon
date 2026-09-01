/**
 * The procedural moon surface, at the level both painters share.
 *
 * Two things here are load-bearing beyond "the maths is right". The crater
 * field is a moon's set of landmarks: it is generated on the CPU for both
 * paths, so its draw order and its budget are a contract — reorder the draws
 * and every moon in the catalog changes face, overrun the budget and the
 * shader silently drops craters the CPU painter drew. And the fast row sampler
 * the CPU painter runs has to agree with the reference field the shader was
 * written from, or the fallback stops being a fallback.
 */
import { describe, it, expect } from 'vitest';
import {
  archetypeCode,
  classifyMoonArchetype,
  craterHeight,
  craterRay,
  craterReach,
  createTerrainRowSampler,
  generateCraters,
  gpuSeed,
  MAX_CRATERS,
  moonSurfaceLook,
  moonTextureSize,
  poleFade,
  seededRng,
  SMALL_MOON_RADIUS_KM,
  terrainFine,
  terrainShade,
} from './proceduralMoon';

const ICY = 0;
const VOLCANIC = 1;
const ROCKY = 2;

/** The classifier reads the chip's own sRGB bytes — the colour it renders as. */
function refArchetype(hex: number) {
  const r = ((hex >> 16) & 255) / 255;
  const g = ((hex >> 8) & 255) / 255;
  const b = (hex & 255) / 255;
  return { isIcy: r * 0.299 + g * 0.587 + b * 0.114 > 0.55, isVolcanic: r > 0.6 && g > 0.4 && b < 0.35 };
}

describe('classifyMoonArchetype', () => {
  const colors = [0x8a7e6e, 0xc8b040, 0xb0a890, 0x605848, 0xffffff, 0x000000, 0xeeeeee];
  it('matches the sRGB brightness/hue formula for representative colours', () => {
    for (const hex of colors) expect(classifyMoonArchetype(hex)).toEqual(refArchetype(hex));
  });
  it('pure white is icy, pure black is neither', () => {
    expect(classifyMoonArchetype(0xffffff)).toEqual({ isIcy: true, isVolcanic: false });
    expect(classifyMoonArchetype(0x000000)).toEqual({ isIcy: false, isVolcanic: false });
  });
  it('sorts the catalog the way the bodies actually look', () => {
    // The bright Saturn ring moonlets (Janus, Prometheus) are ice; the dark
    // Uranian and outer-irregular chips are not. Reading the same thresholds in
    // a linear working space put every one of these in the rocky branch.
    expect(classifyMoonArchetype(0xb0b0a8).isIcy).toBe(true); // Janus
    expect(classifyMoonArchetype(0xc0c0c0).isIcy).toBe(true); // Prometheus
    expect(classifyMoonArchetype(0x707070).isIcy).toBe(false); // Umbriel
    expect(classifyMoonArchetype(0x585850).isIcy).toBe(false); // Sinope
    expect(classifyMoonArchetype(0xc8b040).isVolcanic).toBe(true); // Io
  });
  it('archetypeCode: icy wins over volcanic, rocky is the fallback (matches branch order)', () => {
    expect(archetypeCode({ isIcy: true, isVolcanic: true })).toBe(ICY);
    expect(archetypeCode({ isIcy: true, isVolcanic: false })).toBe(ICY);
    expect(archetypeCode({ isIcy: false, isVolcanic: true })).toBe(VOLCANIC);
    expect(archetypeCode({ isIcy: false, isVolcanic: false })).toBe(ROCKY);
  });
});

describe('moonSurfaceLook', () => {
  it('puts a painted icy moonlet in the same band as the shipped icy maps', () => {
    // Rhea/Dione measure 133, Tethys 151, Enceladus 169 as an equatorial-band
    // mean byte. A painted ring moonlet has to land among them to read as the
    // same material.
    const janus = moonSurfaceLook(0xb0b0a8, classifyMoonArchetype(0xb0b0a8));
    const mean = ((janus.low[0] + janus.high[0]) / 2) * 255;
    expect(mean).toBeGreaterThan(120);
    expect(mean).toBeLessThan(175);
  });
  it('keeps a dark moon dark and a bright one bright within an archetype', () => {
    const dark = moonSurfaceLook(0x585850, classifyMoonArchetype(0x585850)); // Sinope
    const light = moonSurfaceLook(0x909090, classifyMoonArchetype(0x909090)); // Cordelia-class
    expect(dark.high[0]).toBeLessThan(light.high[0]);
  });
  it('carries the chip hue into both ends of the ramp', () => {
    // Amalthea's chip is deeply red; the surface must not come out grey.
    const look = moonSurfaceLook(0x8b4513, classifyMoonArchetype(0x8b4513));
    expect(look.low[0]).toBeGreaterThan(look.low[2] * 2);
    expect(look.high[0]).toBeGreaterThan(look.high[2] * 2);
  });
  it('ramps upward and stays inside the byte range', () => {
    for (const hex of [0xffffff, 0xe8e8f0, 0xb0b0b0, 0x707070, 0x000000, 0xc8b040]) {
      const look = moonSurfaceLook(hex, classifyMoonArchetype(hex));
      for (let ch = 0; ch < 3; ch++) {
        expect(look.high[ch]).toBeGreaterThan(look.low[ch]);
        expect(look.low[ch]).toBeGreaterThanOrEqual(0);
        expect(look.high[ch]).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('the terrain field', () => {
  it('wraps in longitude: the map has no seam at 0°', () => {
    for (const v of [0.2, 0.5, 0.77]) {
      expect(terrainShade(0, v, 4242)).toBeCloseTo(terrainShade(1, v, 4242), 12);
    }
  });
  it('the CPU row sampler reproduces the reference field the shader was written from', () => {
    const width = 128;
    const height = 64;
    const seed = 987_654;
    const sampler = createTerrainRowSampler(width, seed);
    for (const y of [0, 1, 17, 33, 63]) {
      const ny = y / height;
      sampler.beginRow(ny);
      for (const x of [0, 1, 7, 64, 127]) {
        const shade = sampler.sample(x);
        expect(shade).toBeCloseTo(terrainShade(x / width, ny, seed), 12);
        expect(sampler.fine()).toBeCloseTo(terrainFine(x / width, ny, seed), 12);
      }
    }
  });
  it('fades the landforms out at the poles and leaves the middle alone', () => {
    expect(poleFade(0)).toBeCloseTo(0, 12);
    expect(poleFade(1)).toBeCloseTo(0, 12);
    expect(poleFade(0.5)).toBe(1);
    expect(poleFade(0.02)).toBeLessThan(0.5);
  });
});

describe('generateCraters', () => {
  const rocky = () => generateCraters(seededRng(12345), 512, 256, ROCKY);

  it('is deterministic for a seed and stays inside the shader budget', () => {
    const a = rocky();
    const b = rocky();
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThanOrEqual(36);
    expect(a.length).toBeLessThanOrEqual(MAX_CRATERS);
    for (const c of a) {
      expect(c.cx).toBeGreaterThanOrEqual(0);
      expect(c.cx).toBeLessThan(512);
      expect(c.cy).toBeGreaterThanOrEqual(0);
      expect(c.cy).toBeLessThan(256);
      expect(c.cr).toBeGreaterThan(0);
      expect(c.depth).toBeGreaterThan(0);
      expect(c.rim).toBeGreaterThan(0);
      expect(c.peak).toBeGreaterThanOrEqual(0);
      expect(c.peak).toBeLessThanOrEqual(1);
    }
  });

  it('never overruns the budget for any archetype or seed', () => {
    for (const code of [ICY, VOLCANIC, ROCKY]) {
      for (let s = 1; s < 400; s++) {
        expect(generateCraters(seededRng(s), 256, 128, code).length).toBeLessThanOrEqual(MAX_CRATERS);
      }
    }
  });

  it('is a size-frequency mix: many small, a few large', () => {
    const radii = rocky().map((c) => c.cr).sort((x, y) => x - y);
    const median = radii[Math.floor(radii.length / 2)];
    const largest = radii[radii.length - 1];
    // A power-law draw puts the median far below the top of the range; the old
    // uniform sprinkle put it near the middle.
    expect(median).toBeLessThan(largest * 0.35);
    expect(largest).toBeGreaterThan(median * 3);
  });

  it('gives rays to a young minority only, and only to craters big enough to show them', () => {
    const craters = rocky();
    const rayed = craters.filter((c) => c.rays > 0);
    expect(rayed.length).toBeLessThan(craters.length / 3);
    const smallest = Math.min(...craters.map((c) => c.cr));
    for (const c of rayed) expect(c.cr).toBeGreaterThan(smallest);
  });

  it('re-rendering larger is a pure sharpen: the same craters, scaled', () => {
    const small = generateCraters(seededRng(555), 512, 256, ROCKY);
    const large = generateCraters(seededRng(555), 1024, 512, ROCKY);
    expect(large.length).toBe(small.length);
    for (let i = 0; i < small.length; i++) {
      expect(large[i].cr).toBeCloseTo(small[i].cr * 2, 10);
      expect(large[i].cx / 1024).toBeCloseTo(small[i].cx / 512, 2);
      expect(large[i].cy / 512).toBeCloseTo(small[i].cy / 256, 2);
      expect(large[i].depth).toBe(small[i].depth);
      expect(large[i].rays).toBe(small[i].rays);
    }
  });

  it('icy surfaces carry fewer craters than dark rock, and volcanic almost none', () => {
    const icy = generateCraters(seededRng(999), 256, 128, ICY);
    const volcanic = generateCraters(seededRng(999), 256, 128, VOLCANIC);
    const dark = generateCraters(seededRng(999), 256, 128, ROCKY);
    expect(volcanic.length).toBeLessThan(icy.length);
    expect(icy.length).toBeLessThan(dark.length);
  });

  it('places centres by area on the sphere, not by row on the map', () => {
    // The top and bottom sixth of the rows are the caps above 60° latitude:
    // a third of the map, but only 13% of the sphere. Drawing on the map put a
    // third of every moon's craters up there, stretched into bands.
    const height = 256;
    let polar = 0;
    let total = 0;
    for (let s = 1; s < 60; s++) {
      for (const c of generateCraters(seededRng(s), 512, height, ROCKY)) {
        total++;
        if (c.cy < height / 6 || c.cy > height - height / 6) polar++;
      }
    }
    expect(polar / total).toBeLessThan(0.18);
  });
});

describe('the crater profile', () => {
  const crater = {
    cx: 0, cy: 0, cr: 20, depth: 0.5, rim: 0.35, rays: 0, phase: 0, peak: 0,
  };

  it('is a depressed floor, a raised rim, and an ejecta blanket that runs out', () => {
    expect(craterHeight(crater, 0.1)).toBeLessThan(-0.4); // floor
    expect(craterHeight(crater, 0.9)).toBeGreaterThan(0); // wall, climbing
    expect(craterHeight(crater, 1)).toBeCloseTo(crater.rim, 6); // rim crest
    expect(craterHeight(crater, 1.1)).toBeLessThan(crater.rim); // blanket, falling
    expect(craterHeight(crater, craterReach(0))).toBe(0); // and gone
  });

  it('gives the big ones a central peak', () => {
    const peaked = { ...crater, peak: 1 };
    expect(craterHeight(peaked, 0)).toBeGreaterThan(craterHeight(crater, 0));
    expect(craterHeight(peaked, 0.5)).toBeCloseTo(craterHeight(crater, 0.5), 6);
  });

  it('throws rays past the rim only where a crater has them', () => {
    const young = { ...crater, rays: 0.4 };
    expect(craterReach(0.4)).toBeGreaterThan(craterReach(0));
    let anyRay = 0;
    for (let i = 0; i < 32; i++) anyRay += craterRay(young, 1.4, (i / 32) * Math.PI * 2);
    expect(anyRay).toBeGreaterThan(0);
    expect(craterRay(crater, 1.4, 0.3)).toBe(0); // no rays on an old one
    expect(craterRay(young, 0.5, 0.3)).toBe(0); // and none inside the rim
  });
});

describe('gpuSeed', () => {
  it('is bounded for f32 safety and distinct for distinct names', () => {
    const names = ['Io', 'Europa', 'Ganymede', 'Callisto', 'Titan', 'Phobos', 'Miranda', 'Styx'];
    const seeds = names.map(gpuSeed);
    for (const s of seeds) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(131071);
    }
    expect(new Set(seeds).size).toBe(seeds.length);
  });
});

describe('moonTextureSize', () => {
  it('baseline: tiny irregulars 256, everything else 512 (observe upgrades on demand)', () => {
    expect(moonTextureSize(SMALL_MOON_RADIUS_KM - 1)).toEqual({ width: 256, height: 128 });
    expect(moonTextureSize(SMALL_MOON_RADIUS_KM + 1)).toEqual({ width: 512, height: 256 });
    expect(moonTextureSize(2575)).toEqual({ width: 512, height: 256 });
  });
});
