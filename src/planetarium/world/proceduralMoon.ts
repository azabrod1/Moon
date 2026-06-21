/**
 * Shared procedural-moon surface generation primitives, used by BOTH the CPU
 * texture path (createMoonTextures, the fallback) and the GPU texturer
 * (ProceduralMoonTexturer). Centralising the archetype classifier, the noise,
 * the seed, and the crater RNG here is what guarantees the two paths agree:
 * a moon must look the same whether it was painted on the CPU or the GPU.
 *
 * The noise/classifier are decorative (no physical meaning); the GPU port runs
 * the same math in f32 with a reduced seed, so it is visually equivalent, not
 * bit-exact. Crater PLACEMENT stays on the CPU (this module) for both paths —
 * only the per-pixel noise loop moves to the GPU — so craters are identical.
 */
import * as THREE from 'three';

// Tiny irregular moons render as a handful of pixels even up close, so they get
// half-dimension textures (a quarter of the per-pixel work); round, inspectable
// moons keep full resolution. Shared so both paths size textures identically.
export const SMALL_MOON_RADIUS_KM = 150;

/**
 * Baseline texture dimensions (equirectangular 2:1), sized for the FLYTHROUGH,
 * where a moon's on-screen size tracks its physical size: tiny irregulars are a
 * few specks (256), everything else 512. The Observatory magnifies any moon to a
 * fixed screen fraction regardless of physical size, so the landed path
 * re-renders the observed moon sharper on demand (ProceduralMoonTexturer.upgrade)
 * — that is where inspection resolution comes from, not this baseline. Keeping
 * the baseline modest means we only hold a hi-res texture for moons actually
 * inspected, not all ~65 at once.
 */
export function moonTextureSize(radiusKm: number): { width: number; height: number } {
  const width = radiusKm < SMALL_MOON_RADIUS_KM ? 256 : 512;
  return { width, height: width / 2 };
}

export function hashString(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function seededRng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 16807 + 0) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

// Layered sine-based value noise (no library needed). f64 here; the GPU port
// runs the same form in highp f32.
export function valueNoise(x: number, y: number, seed: number): number {
  const a = Math.sin(x * 12.9898 + y * 78.233 + seed) * 43758.5453;
  return a - Math.floor(a);
}

export function fractalNoise(x: number, y: number, seed: number, octaves: number): number {
  let value = 0;
  let amplitude = 1;
  let frequency = 1;
  let maxAmp = 0;
  for (let i = 0; i < octaves; i++) {
    value += valueNoise(x * frequency, y * frequency, seed + i * 100) * amplitude;
    maxAmp += amplitude;
    amplitude *= 0.5;
    frequency *= 2.2;
  }
  return value / maxAmp;
}

export interface MoonArchetypeFlags {
  isIcy: boolean;
  isVolcanic: boolean;
}

/**
 * Surface archetype from base colour, EXACTLY as the original createMoonTextures
 * computed it — brightness/RGB thresholds, three outcomes (icy / volcanic /
 * rocky). This is deliberately NOT the scene's two-value moonArchetype()/
 * ICY_MOONS lookup: the two disagree for ~25 of 65 moons, and the set lacks the
 * volcanic branch entirely (Io, Titan). Drive the procedural look from this one.
 */
export function classifyMoonArchetype(colorHex: number): MoonArchetypeFlags {
  const c = new THREE.Color(colorHex);
  const brightness = c.r * 0.299 + c.g * 0.587 + c.b * 0.114;
  return {
    isIcy: brightness > 0.55,
    isVolcanic: c.r > 0.6 && c.g > 0.4 && c.b < 0.35,
  };
}

/** GLSL-friendly archetype code: 0 icy, 1 volcanic, 2 rocky (icy wins, as in the
 *  CPU branch order). */
export function archetypeCode(flags: MoonArchetypeFlags): number {
  if (flags.isIcy) return 0;
  if (flags.isVolcanic) return 1;
  return 2;
}

export interface Crater {
  /** centre, in texels */
  cx: number;
  cy: number;
  /** radius, in texels */
  cr: number;
}

// Crater radii were originally tuned in pixels for a 512-wide texture. Scaling
// them by width/512 keeps craters the SAME size relative to the moon at any
// resolution, so re-rendering a moon larger on observe is a pure sharpen, not a
// surface redesign (smaller-looking craters).
const CRATER_REFERENCE_WIDTH = 512;

/**
 * Seeded crater list, in the EXACT RNG-draw order the original crater loop used
 * (count, then per crater: cx, cy, cr) so a given moon gets identical craters on
 * both paths and at any resolution. The caller passes an rng already seeded from
 * the moon name. cx/cy scale with the texture dims; cr scales with width so the
 * relative crater size is resolution-independent.
 */
export function generateCraters(
  rng: () => number,
  width: number,
  height: number,
  isIcy: boolean,
): Crater[] {
  const radiusScale = width / CRATER_REFERENCE_WIDTH;
  const craterCount = isIcy ? 5 + Math.floor(rng() * 8) : 10 + Math.floor(rng() * 15);
  const craters: Crater[] = [];
  for (let i = 0; i < craterCount; i++) {
    const cx = Math.floor(rng() * width);
    const cy = Math.floor(rng() * height);
    const cr = (isIcy ? 2 + rng() * 5 : 3 + rng() * 12) * radiusScale;
    craters.push({ cx, cy, cr });
  }
  return craters;
}

// Upper bound on craters (icy: 5+7=12 max; rocky: 10+14=24 max), so the GPU
// uniform array can be a fixed size. Keep in sync with generateCraters' ranges.
export const MAX_CRATERS = 25;

/**
 * Reduced seed for the GPU shader. The CPU path uses the full hashString seed in
 * f64; in f32 a ~1e9 seed quantises the noise (banding), so the GPU path uses a
 * bounded seed. ≥ 2^16 to stay collision-resistant (mod 997 collided Miranda/
 * Styx) while small enough that f32 ulp (~0.015 at 1e5) keeps the noise smooth.
 */
export function gpuSeed(name: string): number {
  return hashString(name) % 131071; // largest prime < 2^17
}
