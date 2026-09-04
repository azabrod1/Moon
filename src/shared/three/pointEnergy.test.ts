import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ShaderChunk, ShaderLib } from 'three';
import {
  augmentPointsMaterialWithSubpixelEnergy,
  POINT_ENERGY_FRAGMENT_ANCHOR,
  POINT_ENERGY_VERTEX_ANCHOR,
  pointEnergyScale,
} from './pointEnergy';
import { augmentPointsMaterialWithSunGlareMask } from '../../planetarium/world/sunGlareMask';

// String.replace with a missing needle is a silent no-op: pin the anchors
// against the installed three so a stock-shader rename cannot quietly turn
// the belt's sub-pixel energy off.
describe('point energy anchors', () => {
  it('exist in the stock points shaders', () => {
    expect(ShaderLib.points.vertexShader).toContain(POINT_ENERGY_VERTEX_ANCHOR);
    expect(ShaderLib.points.fragmentShader).toContain(POINT_ENERGY_FRAGMENT_ANCHOR);
    expect(ShaderChunk.opaque_fragment).toContain('diffuseColor');
  });

  it('follow the size attenuation in the vertex shader', () => {
    const v = ShaderLib.points.vertexShader;
    expect(v.indexOf(POINT_ENERGY_VERTEX_ANCHOR)).toBeGreaterThan(v.lastIndexOf('gl_PointSize'));
  });
});

describe('pointEnergyScale', () => {
  it('leaves the reference display untouched at every size', () => {
    for (const px of [0.2, 0.5, 1, 1.7, 4]) expect(pointEnergyScale(px, 2)).toBe(1);
  });

  it('gives a clamped sub-pixel dot on a 1× monitor the light it has on the reference', () => {
    // Half a pixel wanted, a whole pixel drawn: a quarter of the light.
    expect(pointEnergyScale(0.5, 1)).toBeCloseTo(0.25, 6);
    expect(pointEnergyScale(0.25, 1)).toBeCloseTo(0.25, 6);
    // Between one pixel here and two on the reference: the area it wanted.
    expect(pointEnergyScale(0.8, 1)).toBeCloseTo(0.64, 6);
  });

  it('does nothing to dots at a full pixel or more', () => {
    expect(pointEnergyScale(1, 1)).toBe(1);
    expect(pointEnergyScale(3, 1)).toBe(1);
    expect(pointEnergyScale(1.2, 1.25)).toBe(1);
  });

  it('brings a denser-than-reference display up to the reference (the shader holds alpha at 1)', () => {
    // 0.6 px wanted at 2.5× is a whole pixel drawn over a smaller CSS area
    // than the reference's whole pixel: 6.25/4 the light to match.
    expect(pointEnergyScale(0.6, 2.5)).toBeCloseTo(1.5625, 6);
    expect(pointEnergyScale(1.5, 2.5)).toBeCloseTo(1, 6);
    expect(pointEnergyScale(3, 2.5)).toBeCloseTo(1, 6);
  });
});

describe('chained onto the belt material', () => {
  const compose = () => {
    const mat = new THREE.PointsMaterial();
    const glare = augmentPointsMaterialWithSunGlareMask(mat);
    const energy = augmentPointsMaterialWithSubpixelEnergy(mat);
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: ShaderLib.points.vertexShader,
      fragmentShader: ShaderLib.points.fragmentShader,
    };
    mat.onBeforeCompile(shader as never, null as never);
    return { mat, glare, energy, shader };
  };

  it('keeps both alpha scales ahead of the output and the energy after the last size write', () => {
    const { shader } = compose();
    const f = shader.fragmentShader;
    const out = f.indexOf(POINT_ENERGY_FRAGMENT_ANCHOR);
    expect(f.indexOf('diffuseColor.a *= vSunGlareMaskAlpha')).toBeLessThan(out);
    expect(f.indexOf('diffuseColor.a = min(1.0, diffuseColor.a * vPointEnergy)')).toBeLessThan(out);
    const v = shader.vertexShader;
    expect(v.indexOf('vPointEnergy = ')).toBeGreaterThan(v.lastIndexOf('gl_PointSize *='));
    expect(v.indexOf('gl_PointSize = max(pointWantPx, 1.0)')).toBeLessThan(v.indexOf(POINT_ENERGY_VERTEX_ANCHOR));
    expect(f.split('vPointEnergy;').length).toBe(2); // one varying declaration in the fragment
  });

  it('hands three the live uniform objects and its own program key', () => {
    const { mat, glare, energy, shader } = compose();
    expect(shader.uniforms.uPointPixelRatio).toBe(energy.uPointPixelRatio);
    expect(shader.uniforms.uSunMaskActive).toBe(glare.uSunMaskActive);
    expect(mat.customProgramCacheKey()).toContain('pointEnergy');
    expect(mat.customProgramCacheKey()).not.toBe(new THREE.PointsMaterial().customProgramCacheKey());
  });
});
