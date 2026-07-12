import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  classifyMoonArchetype,
  archetypeCode,
  generateCraters,
  seededRng,
  gpuSeed,
  moonTextureSize,
  MAX_CRATERS,
  SMALL_MOON_RADIUS_KM,
} from './proceduralMoon';

// Reference: the exact brightness/hue formula createMoonTextures used, via
// THREE.Color so it tracks the app's colour-management setting. The GPU path
// and the CPU path both classify through classifyMoonArchetype, so this pins
// that they cannot diverge from the original look.
function refArchetype(hex: number) {
  const c = new THREE.Color(hex);
  const brightness = c.r * 0.299 + c.g * 0.587 + c.b * 0.114;
  return {
    isIcy: brightness > 0.55,
    isVolcanic: c.r > 0.6 && c.g > 0.4 && c.b < 0.35,
  };
}

describe('classifyMoonArchetype', () => {
  // Real catalog colours (Phobos, Io, Europa, Callisto) + the robust extremes.
  const colors = [0x8a7e6e, 0xc8b040, 0xb0a890, 0x605848, 0xffffff, 0x000000, 0xeeeeee];
  it('matches the original brightness/hue formula for representative colours', () => {
    for (const hex of colors) {
      expect(classifyMoonArchetype(hex)).toEqual(refArchetype(hex));
    }
  });
  it('pure white is icy, pure black is neither (colourspace-robust extremes)', () => {
    expect(classifyMoonArchetype(0xffffff)).toEqual({ isIcy: true, isVolcanic: false });
    expect(classifyMoonArchetype(0x000000)).toEqual({ isIcy: false, isVolcanic: false });
  });
  it('archetypeCode: icy wins over volcanic, rocky is the fallback (matches branch order)', () => {
    expect(archetypeCode({ isIcy: true, isVolcanic: true })).toBe(0);
    expect(archetypeCode({ isIcy: true, isVolcanic: false })).toBe(0);
    expect(archetypeCode({ isIcy: false, isVolcanic: true })).toBe(1);
    expect(archetypeCode({ isIcy: false, isVolcanic: false })).toBe(2);
  });
});

describe('generateCraters', () => {
  it('is deterministic for a seed and within the rocky count range (10..24)', () => {
    const a = generateCraters(seededRng(12345), 512, 256, false);
    const b = generateCraters(seededRng(12345), 512, 256, false);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThanOrEqual(10);
    expect(a.length).toBeLessThanOrEqual(24);
    expect(a.length).toBeLessThanOrEqual(MAX_CRATERS);
    for (const c of a) {
      expect(c.cx).toBeGreaterThanOrEqual(0);
      expect(c.cx).toBeLessThan(512);
      expect(c.cy).toBeGreaterThanOrEqual(0);
      expect(c.cy).toBeLessThan(256);
      expect(c.cr).toBeGreaterThan(0);
    }
  });
  it('icy moons use the smaller crater-count range (5..12)', () => {
    const icy = generateCraters(seededRng(999), 256, 128, true);
    expect(icy.length).toBeGreaterThanOrEqual(5);
    expect(icy.length).toBeLessThanOrEqual(12);
  });
  it('different seeds give different craters', () => {
    const a = generateCraters(seededRng(1), 512, 256, false);
    const b = generateCraters(seededRng(2), 512, 256, false);
    expect(a).not.toEqual(b);
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
    // The mod-997 collision (Miranda/Styx) is gone at this modulus.
    expect(new Set(seeds).size).toBe(seeds.length);
  });
});

describe('moonTextureSize', () => {
  it('baseline: tiny irregulars 256, everything else 512 (observe upgrades on demand)', () => {
    expect(moonTextureSize(SMALL_MOON_RADIUS_KM - 1)).toEqual({ width: 256, height: 128 }); // tiny irregular
    expect(moonTextureSize(SMALL_MOON_RADIUS_KM + 1)).toEqual({ width: 512, height: 256 }); // mid (e.g. Mimas)
    expect(moonTextureSize(2575)).toEqual({ width: 512, height: 256 }); // Titan: 512 baseline, 1024 when observed
  });
});
