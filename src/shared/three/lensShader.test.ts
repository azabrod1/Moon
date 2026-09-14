import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LINE_CLIP_ANCHOR, SPRITE_CLIP_ANCHOR, lensShaderGLSL } from './lensShader';
import { LENS_INVERSE_ITERATIONS, lensRadial, lensRadialInverse } from '../math/lensProjection';

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

// The radial inverse exists twice — once on the CPU (shared/math/lensProjection
// lensRadialInverse) and once in the GLSL block spliced in here — and the two
// seams must agree, which is why they share an iteration budget. They must also
// share the RANGE GUARD. 2*tan(theta/2) only reaches 2 as theta reaches 90
// degrees, so a radius at or past 2 has no solution below it: an unguarded
// Newton step walks through 90 degrees and tan() comes back NEGATIVE, placing
// the vertex on the opposite side of the frame. A segment whose far endpoint
// lands there reads as a hard bend in a line that is straight in the data.

describe('lens radial inverse: CPU and GPU agree', () => {
  const MAX_THETA_GLSL = 1.53588974;

  /** The GLSL routine, transcribed. Kept beside the source it mirrors so a
   *  divergence shows up as a failure here rather than as bent geometry. */
  const shaderInverse = (radius: number, strength: number): number => {
    if (radius <= 0) return 0;
    if (radius >= lensRadial(MAX_THETA_GLSL, strength)) return MAX_THETA_GLSL;
    let theta = Math.min(Math.atan(radius), MAX_THETA_GLSL);
    for (let iteration = 0; iteration < LENS_INVERSE_ITERATIONS; iteration++) {
      const tangent = Math.tan(theta);
      const halfTangent = Math.tan(theta / 2);
      const residual = (1 - strength) * tangent + strength * 2 * halfTangent - radius;
      const slope = (1 - strength) * (1 + tangent * tangent) + strength * (1 + halfTangent * halfTangent);
      theta = Math.min(Math.max(theta - residual / slope, 0), MAX_THETA_GLSL);
    }
    return theta;
  };

  it('keeps the shader source guarded against the out-of-range radius', () => {
    expect(lensShaderGLSL).toContain('LENS_MAX_THETA');
    expect(lensShaderGLSL).toContain('clamp(theta - f / df, 0.0, LENS_MAX_THETA)');
    expect(lensShaderGLSL).toContain('if (radius >= lensShaderRadial(LENS_MAX_THETA)) return LENS_MAX_THETA;');
  });

  it('never turns a radius into a negative or non-finite source radius', () => {
    for (const strength of [0.25, 0.5, 0.75, 1]) {
      for (const radius of [0, 0.5, 1, 1.5, 1.9, 1.93, 1.99, 2, 2.5, 4, 10, 1e3]) {
        const sourceRadius = Math.tan(shaderInverse(radius, strength));
        expect(Number.isFinite(sourceRadius)).toBe(true);
        expect(sourceRadius).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('matches the CPU seam across the representable range and beyond it', () => {
    for (const strength of [0.25, 0.5, 0.75, 1]) {
      for (let step = 0; step <= 40; step++) {
        const radius = (step / 40) * 4;
        expect(shaderInverse(radius, strength)).toBeCloseTo(lensRadialInverse(radius, strength), 6);
      }
    }
  });
});
