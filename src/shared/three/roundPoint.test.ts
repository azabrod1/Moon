import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ShaderLib } from 'three';
import { augmentPointsMaterialWithSubpixelEnergy, POINT_ENERGY_FRAGMENT_ANCHOR, POINT_ENERGY_VERTEX_ANCHOR } from './pointEnergy';
import { augmentPointsMaterialWithRoundDots, roundPointAlpha } from './roundPoint';
import { augmentPointsMaterialWithSunGlareMask } from '../../planetarium/world/sunGlareMask';

describe('roundPointAlpha', () => {
  it('leaves a dot of one pixel or less exactly as it was, wherever its one fragment lands', () => {
    for (const px of [0.3, 1]) for (const d of [0, 0.35, 0.5, 0.7]) expect(roundPointAlpha(px, d)).toBe(1);
  });

  it('gives a dot of two pixels or more the starfield profile: full core, nothing at the rim or the corners', () => {
    for (const px of [2, 4]) {
      expect(roundPointAlpha(px, 0)).toBe(1);
      expect(roundPointAlpha(px, 0.2)).toBe(1);
      expect(roundPointAlpha(px, 0.35)).toBeCloseTo(0.5, 6);
      expect(roundPointAlpha(px, 0.5)).toBe(0);
      expect(roundPointAlpha(px, Math.SQRT1_2)).toBe(0);
    }
  });

  it('comes in across the second pixel of size', () => {
    expect(roundPointAlpha(1.5, 0.5)).toBeCloseTo(0.5, 6);
    expect(roundPointAlpha(1.5, 0)).toBe(1);
  });
});

describe('chained onto the belt material', () => {
  const compose = () => {
    const mat = new THREE.PointsMaterial();
    augmentPointsMaterialWithSunGlareMask(mat);
    augmentPointsMaterialWithSubpixelEnergy(mat);
    augmentPointsMaterialWithRoundDots(mat);
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: ShaderLib.points.vertexShader,
      fragmentShader: ShaderLib.points.fragmentShader,
    };
    mat.onBeforeCompile(shader as never, null as never);
    return { mat, shader };
  };

  it('reads the size after the sub-pixel clamp and shapes the alpha after the energy, ahead of the output', () => {
    const { shader } = compose();
    const v = shader.vertexShader;
    expect(v.indexOf('vRoundPointPx = gl_PointSize;')).toBeGreaterThan(v.indexOf('gl_PointSize = max(pointWantPx, 1.0)'));
    expect(v.indexOf('vRoundPointPx = gl_PointSize;')).toBeLessThan(v.indexOf(POINT_ENERGY_VERTEX_ANCHOR));
    const f = shader.fragmentShader;
    const shape = f.indexOf('diffuseColor.a *= mix(1.0, roundPointShape');
    expect(shape).toBeGreaterThan(f.indexOf('diffuseColor.a = min(1.0, diffuseColor.a * vPointEnergy)'));
    expect(shape).toBeLessThan(f.indexOf(POINT_ENERGY_FRAGMENT_ANCHOR));
    expect(f.split('varying float vRoundPointPx;').length).toBe(2);
    expect(v.split('varying float vRoundPointPx;').length).toBe(2);
  });

  it('keeps the programs it chains onto apart from a stock material', () => {
    const { mat } = compose();
    expect(mat.customProgramCacheKey()).toContain('pointEnergy');
    expect(mat.customProgramCacheKey()).toContain('roundPoint');
  });
});
