import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { augmentSurfaceMaterial } from './surfaceShading';

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
    expect(shader.vertexShader).toContain('vSunViewDir = normalize');
    // Additive radiance must land at a real chunk, not silently no-op.
    expect(shader.fragmentShader).toContain('outgoingLight +=');
    expect(shader.fragmentShader).toContain('#include <opaque_fragment>');
  });
});
