import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import {
  LINE_CLIP_ANCHOR,
  POINT_SPRITE_MAX_SAMPLES_PER_AXIS,
  POINT_SPRITE_SAMPLES_ACROSS,
  SPRITE_CLIP_ANCHOR,
  lensPointSpriteFragmentGLSL,
  lensPointSpriteVertexGLSL,
  pointSpriteFalloff,
  pointSpriteProfile,
  pointSpriteSamplesPerAxis,
} from './lensShader';

// The lens splices rewrite two lines of three's own shaders by string
// replacement. A three bump that reworded either line would turn the splice
// into a silent no-op — so the installed shaders are checked for both needles
// (and the `#include <common>` the GLSL block is inserted after).

describe('lens splice anchors', () => {
  it('still finds its line in the installed sprite shader', () => {
    const vert = THREE.ShaderLib.sprite.vertexShader;
    expect(vert).toContain('#include <common>');
    expect(vert).toContain(SPRITE_CLIP_ANCHOR);
  });

  it('still finds its line in the installed LineMaterial shader', () => {
    const material = new LineMaterial();
    expect(material.vertexShader).toContain('#include <common>');
    expect(material.vertexShader).toContain(LINE_CLIP_ANCHOR);
    material.dispose();
  });
});

// The point-sprite kernel (stars, moon dots) is pinned through its TypeScript
// mirror. The property that matters: a star carries the same light wherever
// its centre falls between pixels. The fragments are SOURCE pixels and the
// star is measured in OUTPUT pixels, so every case states the lens's local
// Jacobian J = [xx, xy, yx, yy]: the identity with the lens off, about 1.32×
// at the centre of a 60° frame, about 0.78× at its sides, a rotated
// anisotropic one at a corner.

type Jacobian = readonly [number, number, number, number];
const I: Jacobian = [1, 0, 0, 1];
const CENTRE: Jacobian = [1.32, 0, 0, 1.32];
const SIDE: Jacobian = [0.78, 0, 0, 0.78];
const CORNER: Jacobian = [0.73, -0.18, -0.18, 0.89];

const scaleOf = (j: Jacobian) => Math.max(Math.hypot(j[0], j[1]), Math.hypot(j[2], j[3]));
const detOf = (j: Jacobian) => Math.abs(j[0] * j[3] - j[1] * j[2]);

/** The profile's integral over the plane for a unit diameter: 2π∫₀^½ f(u)·u du. */
function profileIntegral(): number {
  const steps = 20000;
  let sum = 0;
  for (let i = 0; i < steps; i++) {
    const u = (i + 0.5) / steps * 0.5;
    sum += pointSpriteProfile(u) * u * (0.5 / steps);
  }
  return 2 * Math.PI * sum;
}
const UNIT_INTEGRAL = profileIntegral();

/** Sum of the kernel over every source fragment for a star whose centre sits
 *  at sub-pixel phase (px, py) of the fragment lattice. */
function latticeSum(diameterPx: number, j: Jacobian, px: number, py: number): number {
  const n = pointSpriteSamplesPerAxis(diameterPx, scaleOf(j));
  const reach = Math.ceil(diameterPx / scaleOf(j)) + 3;
  let sum = 0;
  for (let fx = -reach; fx <= reach; fx++) {
    for (let fy = -reach; fy <= reach; fy++) {
      // The fragment centre's offset from the star, in source px, then output px.
      const sx = fx - px;
      const sy = fy - py;
      const offset: [number, number] = [j[0] * sx + j[2] * sy, j[1] * sx + j[3] * sy];
      sum += pointSpriteFalloff(diameterPx, offset, j, n);
    }
  }
  return sum;
}

function swingOver(diameterPx: number, j: Jacobian, phases = 12): { swing: number; mean: number } {
  let min = Infinity;
  let max = -Infinity;
  let total = 0;
  for (let a = 0; a < phases; a++) {
    for (let b = 0; b < phases; b++) {
      const s = latticeSum(diameterPx, j, a / phases, b / phases);
      min = Math.min(min, s);
      max = Math.max(max, s);
      total += s;
    }
  }
  return { swing: max / min, mean: total / (phases * phases) };
}

describe('point-sprite kernel', () => {
  it('takes at least eight fine samples across a star, and one reading for the big ones', () => {
    expect(pointSpriteSamplesPerAxis(2, 1)).toBe(4);
    expect(pointSpriteSamplesPerAxis(2, 1.32)).toBe(6);
    expect(pointSpriteSamplesPerAxis(1.74, 1.32)).toBe(7);
    expect(pointSpriteSamplesPerAxis(1, 1)).toBe(8);
    expect(pointSpriteSamplesPerAxis(0.75, 1.32)).toBe(POINT_SPRITE_MAX_SAMPLES_PER_AXIS);
    expect(pointSpriteSamplesPerAxis(0, 1)).toBe(POINT_SPRITE_MAX_SAMPLES_PER_AXIS);
    expect(pointSpriteSamplesPerAxis(8, 1)).toBe(1);
    expect(pointSpriteSamplesPerAxis(7.9, 1)).toBe(2);
    expect(pointSpriteSamplesPerAxis(10, 1.32)).toBe(2);
    expect(pointSpriteSamplesPerAxis(16, 1.32)).toBe(1);
  });

  it('one sample per axis is the plain centre reading, the kernel as it was', () => {
    for (const d of [0, 0.1, 0.2, 0.3, 0.45, 0.5, 0.6]) {
      const offset: [number, number] = [d * 10 * Math.SQRT1_2, d * 10 * Math.SQRT1_2];
      const expected = d > 0.5 ? 0 : 1 - THREE.MathUtils.smoothstep(d, 0.2, 0.5);
      expect(pointSpriteFalloff(10, offset, CENTRE, 1)).toBeCloseTo(expected, 12);
    }
  });

  it('carries the same light wherever the star lands, under any lens scale', () => {
    const cases: Array<[number, Jacobian, number]> = [
      // diameter, Jacobian, allowed swing
      [1, I, 1.005], [1.5, I, 1.005], [2, I, 1.005], [2.2, I, 1.005], [2.5, I, 1.005], [3, I, 1.005], [4, I, 1.005], [8, I, 1.005],
      [1, CENTRE, 1.005], [1.5, CENTRE, 1.005], [1.74, CENTRE, 1.005], [2, CENTRE, 1.005], [2.5, CENTRE, 1.005], [3, CENTRE, 1.005], [12, CENTRE, 1.005],
      [1, SIDE, 1.005], [1.5, SIDE, 1.005], [2, SIDE, 1.005], [3, SIDE, 1.005],
      [1.5, CORNER, 1.005], [2, CORNER, 1.005], [3, CORNER, 1.005],
      // The one place the per-axis cap binds: a star under one source pixel.
      [0.75, CENTRE, 1.02], [0.75, I, 1.006],
    ];
    for (const [diameter, j, allowed] of cases) {
      const { swing, mean } = swingOver(diameter, j);
      expect(swing, `D ${diameter} J ${j.join(',')}`).toBeLessThanOrEqual(allowed);
      // The lattice sum is the profile's integral over the plane, in source px².
      expect(mean / (UNIT_INTEGRAL * diameter * diameter / detOf(j)), `energy D ${diameter} J ${j.join(',')}`).toBeCloseTo(1, 2);
    }
  });

  it('the centre reading alone pulses — the reason the kernel integrates', () => {
    // The faint sky at Medium on a 2× display as it was: 2 px stars read once
    // per fragment. Centred on a pixel the star lights that pixel alone (1.0);
    // centred on a pixel corner it lights four at 0.49 each — nearly twice.
    const centreOnly = (px: number, py: number) => {
      let sum = 0;
      for (let fx = -3; fx <= 3; fx++) for (let fy = -3; fy <= 3; fy++) sum += pointSpriteFalloff(2, [fx - px, fy - py], I, 1);
      return sum;
    };
    expect(centreOnly(0.5, 0.5) / centreOnly(0, 0)).toBeGreaterThan(1.8);
  });

  it('the GLSL carries the same constants as the mirror', () => {
    expect(lensPointSpriteVertexGLSL).toContain(`clamp(ceil(${POINT_SPRITE_SAMPLES_ACROSS.toFixed(1)} * sourcePxScale`);
    expect(lensPointSpriteVertexGLSL).toContain(`1.0, ${POINT_SPRITE_MAX_SAMPLES_PER_AXIS.toFixed(1)})`);
    expect(lensPointSpriteFragmentGLSL).toContain(`for (int a = 0; a < ${POINT_SPRITE_MAX_SAMPLES_PER_AXIS}; a++)`);
    expect(lensPointSpriteFragmentGLSL).toContain(`for (int b = 0; b < ${POINT_SPRITE_MAX_SAMPLES_PER_AXIS}; b++)`);
    expect(lensPointSpriteFragmentGLSL).toContain('1.0 - smoothstep(0.2, 0.5, length(o) * invD)');
  });
});
