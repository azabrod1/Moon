import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  augmentSurfaceMaterial, OCEAN_ROUGHNESS, ROUGHNESS_MAP_LAND, ROUGHNESS_MAP_WATER,
  setSurfaceWaterGloss, surfaceWaterGloss, waterGlossRoughness,
} from './surfaceShading';

// Mimics the subset of three's onBeforeCompile shader object we mutate, so the
// wiring can be exercised without a GL context.
function mockShader() {
  return {
    uniforms: {} as Record<string, unknown>,
    vertexShader: '#include <common>\nvoid main() {\n#include <begin_vertex>\n}',
    fragmentShader: '#include <common>\nvoid main() {\n#include <opaque_fragment>\n}',
  };
}

describe('augmentSurfaceMaterial', () => {
  it('returns a per-frame sun-direction uniform and installs an onBeforeCompile hook', () => {
    const mat = new THREE.MeshStandardMaterial();
    const fx = augmentSurfaceMaterial(mat, 'airless');
    expect(fx.uSunDirWorld.value).toBeInstanceOf(THREE.Vector3);
    expect(typeof mat.onBeforeCompile).toBe('function');
  });

  it('binds the live uniform ref into the shader and injects the night fill', () => {
    const mat = new THREE.MeshStandardMaterial();
    const fx = augmentSurfaceMaterial(mat, 'gas');
    const shader = mockShader();
    (mat.onBeforeCompile as (s: typeof shader, r: unknown) => void)(shader, null);

    // The object the mode updates each frame must be the one bound into the shader.
    expect(shader.uniforms.uSunDirWorld).toBe(fx.uSunDirWorld);
    expect(shader.uniforms.uSilhouette).toBe(fx.uSilhouette);
    expect(fx.uSilhouette.value).toBe(0);
    expect(shader.vertexShader).toContain('vSunViewDir = normalize');
    // Additive radiance must land at a real chunk, not silently no-op.
    expect(shader.fragmentShader).toContain('outgoingLight +=');
    expect(shader.fragmentShader).toContain('uSilhouette');
    expect(shader.fragmentShader).toContain('#include <opaque_fragment>');
  });
});

describe('the ocean gloss remap', () => {
  it('leaves land where the map put it and pulls open water to the authored gloss', () => {
    expect(waterGlossRoughness(ROUGHNESS_MAP_LAND)).toBeCloseTo(ROUGHNESS_MAP_LAND, 12);
    expect(waterGlossRoughness(ROUGHNESS_MAP_WATER)).toBeCloseTo(OCEAN_ROUGHNESS, 12);
  });

  it('keeps a coast\'s fraction a fraction rather than thresholding it', () => {
    // Half water by area in the map comes out half way down the new range too,
    // which is what stops the coastline reading as a hard edge in the glint.
    const half = (ROUGHNESS_MAP_LAND + ROUGHNESS_MAP_WATER) / 2;
    expect(waterGlossRoughness(half))
      .toBeCloseTo((ROUGHNESS_MAP_LAND + OCEAN_ROUGHNESS) / 2, 12);
  });

  it('is off until a material is told its roughness map is a water mask', () => {
    // The flat mid-grey a failed fetch leaves behind is not a water mask, and
    // remapping it would put an ocean's sheen on the whole planet.
    const mat = new THREE.MeshStandardMaterial();
    augmentSurfaceMaterial(mat, 'earth');
    expect(surfaceWaterGloss(mat)).toBe(false);
    const shader = mockShader();
    (mat.onBeforeCompile as (s: typeof shader, r: unknown) => void)(shader, null);
    expect((shader.uniforms.uWaterGloss as { value: number }).value).toBe(0);
    setSurfaceWaterGloss(mat, true);
    expect(surfaceWaterGloss(mat)).toBe(true);
    // The same object the shader already holds, so the switch reaches a
    // material that compiled before the map arrived.
    expect((shader.uniforms.uWaterGloss as { value: number }).value).toBeGreaterThan(0);
    setSurfaceWaterGloss(mat, false);
    expect((shader.uniforms.uWaterGloss as { value: number }).value).toBe(0);
  });
});
