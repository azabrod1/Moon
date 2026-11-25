import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { globeColorWrap, globeColorWrapFor, isPhotoTexture, setColorMapIsPhoto, setMapSmoothRule, createMapSmoothGate } from './mapSmooth';

/** sRGB 8-bit to linear and back, as the sampler decodes an sRGB map. */
const toLinear = (c: number): number => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const toSrgb8 = (l: number): number => 255 * (l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055);

/** One row of a map read the way the GPU reads it along S: a bilinear fetch at
 *  `u`, texel centres at (i + 0.5) / width, out-of-range texels resolved by the
 *  texture's own wrap mode. */
function rowSampler(row: readonly number[], wrapS: THREE.Wrapping) {
  const w = row.length;
  const texel = (i: number): number => (wrapS === THREE.RepeatWrapping
    ? row[((i % w) + w) % w]
    : row[Math.min(Math.max(i, 0), w - 1)]);
  return (u: number): number => {
    const p = u * w - 0.5;
    const i = Math.floor(p);
    const f = p - i;
    return texel(i) * (1 - f) + texel(i + 1) * f;
  };
}

/** surfaceShading's textureBSpline along one axis, tap for tap: the two folded
 *  bilinear fetches at explicit coordinates, blended by s0. */
function bSpline(bilinear: (u: number) => number, u: number, w: number): number {
  const p = u * w - 0.5;
  const f = p - Math.floor(p);
  const base = p - f;
  const w0 = (1 - 3 * f + 3 * f * f - f * f * f) / 6;
  const w1 = (4 - 6 * f * f + 3 * f * f * f) / 6;
  const w2 = (1 + 3 * f + 3 * f * f - 3 * f * f * f) / 6;
  const w3 = (f * f * f) / 6;
  const s0 = w0 + w1;
  const s1 = w2 + w3;
  const t0 = (base + w1 / s0 - 0.5) / w;
  const t1 = (base + w3 / s1 + 1.5) / w;
  // mix(t1-tap, t0-tap, s0), as the shader writes it.
  return bilinear(t1) * (1 - s0) + bilinear(t0) * s0;
}

describe('the seam of a smoothed globe map', () => {
  // Mercury's shipped 2K map (mercury.v2.webp), source row 231, the case an
  // outside review named: its last three and first three texels, grey, as
  // decoded. Every other texel is filler the taps at the seam never reach.
  const W = 2048;
  const ends = { [W - 3]: 115, [W - 2]: 135, [W - 1]: 129, 0: 129, 1: 86, 2: 102 } as Record<number, number>;
  const row = Array.from({ length: W }, (_, i) => toLinear(ends[i] ?? 128));
  // The seam is one line on the ground drawn by two triangles, one reading
  // u = 0 and the other u = 1: those are the two sides compared, and a hair
  // inside each.
  const across = (wrapS: THREE.Wrapping, eps = 0) => {
    const bilinear = rowSampler(row, wrapS);
    return {
      bilinear: [toSrgb8(bilinear(eps)), toSrgb8(bilinear(1 - eps))],
      spline: [toSrgb8(bSpline(bilinear, eps, W)), toSrgb8(bSpline(bilinear, 1 - eps, W))],
    };
  };

  it('steps under clamp-to-edge where bilinear does not', () => {
    // The reason for the fix, kept as a test so the sampler model above is
    // known to be able to see a step at all.
    const clamp = across(THREE.ClampToEdgeWrapping);
    expect(clamp.bilinear[0]).toBeCloseTo(129, 9);
    expect(clamp.bilinear[1]).toBeCloseTo(129, 9);
    expect(clamp.spline[0]).toBeCloseTo(128.28, 2);
    expect(clamp.spline[1]).toBeCloseTo(129.13, 2);
  });

  it('is continuous on the wrap a smoothed globe map is given', () => {
    const tex = new THREE.Texture();
    globeColorWrap(tex, true);
    expect(tex.wrapS).toBe(THREE.RepeatWrapping);
    expect(tex.wrapT).toBe(THREE.ClampToEdgeWrapping);
    const wrapped = across(tex.wrapS);
    expect(wrapped.bilinear[1] - wrapped.bilinear[0]).toBeCloseTo(0, 9);
    expect(wrapped.spline[1] - wrapped.spline[0]).toBeCloseTo(0, 9);
    expect(wrapped.spline[0]).toBeCloseTo(128.41, 2);
    const inside = across(tex.wrapS, 1e-9);
    expect(inside.spline[1] - inside.spline[0]).toBeCloseTo(0, 3);
    expect(across(THREE.ClampToEdgeWrapping, 1e-9).spline[1] - across(THREE.ClampToEdgeWrapping, 1e-9).spline[0])
      .toBeGreaterThan(0.8);
    // The same picture as the clamped spline a texel and a half in from either
    // edge, where no tap reaches past it: only the seam moves.
    const clampBil = rowSampler(row, THREE.ClampToEdgeWrapping);
    const wrapBil = rowSampler(row, THREE.RepeatWrapping);
    for (const u of [2 / W, 0.25, 0.5, 1 - 2 / W]) {
      expect(bSpline(wrapBil, u, W)).toBeCloseTo(bSpline(clampBil, u, W), 12);
    }
  });

  it('leaves a map alone when the rule is off, and wraps by the rule a material carries', () => {
    const plain = new THREE.Texture();
    globeColorWrap(plain, false);
    expect([plain.wrapS, plain.wrapT]).toEqual([THREE.ClampToEdgeWrapping, THREE.ClampToEdgeWrapping]);
    const mat = new THREE.MeshStandardMaterial();
    const ungated = new THREE.Texture();
    globeColorWrapFor(ungated, mat); // not a surface: no gate, no rule
    expect(ungated.wrapS).toBe(THREE.ClampToEdgeWrapping);
    createMapSmoothGate(mat);
    setMapSmoothRule(mat, true);
    const ruled = new THREE.Texture();
    globeColorWrapFor(ruled, mat);
    expect(ruled.wrapS).toBe(THREE.RepeatWrapping);
  });
});

describe('the gate', () => {
  it('is the rule and a photograph, and nothing on a material without one', () => {
    const mat = new THREE.MeshStandardMaterial();
    setMapSmoothRule(mat, true); // no gate: ignored
    setColorMapIsPhoto(mat, true);
    const gate = createMapSmoothGate(mat);
    expect(gate.uniform.value).toBe(0);
    setMapSmoothRule(mat, true);
    expect(gate.uniform.value).toBe(0);
    setColorMapIsPhoto(mat, true);
    expect(gate.uniform.value).toBe(1);
    setMapSmoothRule(mat, false);
    expect(gate.uniform.value).toBe(0);
    const stand = new THREE.Texture();
    stand.userData.proceduralFallback = true;
    expect(isPhotoTexture(stand)).toBe(false);
    expect(isPhotoTexture(new THREE.Texture())).toBe(true);
    expect(isPhotoTexture(null)).toBe(false);
  });
});
