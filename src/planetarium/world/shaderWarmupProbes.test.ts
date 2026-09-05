import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { SHADER_WARMUP_PROBE_COMBOS, createShaderWarmupProbes } from './shaderWarmupProbes';

describe('shader warm-up probes', () => {
  it('build one augmented surface material per combination, carrying the flags that key its program', () => {
    const { group, dispose } = createShaderWarmupProbes();
    const meshes = group.children as THREE.Mesh[];
    expect(meshes.length).toBe(SHADER_WARMUP_PROBE_COMBOS.length);
    const keys = meshes.map((mesh) => {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      return ['map', mat.bumpMap ? 'bump' : '', mat.normalMap ? 'normal' : ''].filter(Boolean).join('+');
    });
    // The post-arrival combinations, once each.
    expect(keys).toEqual(['map+bump', 'map+normal', 'map']);
    expect(new Set(keys).size).toBe(keys.length);
    for (const mesh of meshes) {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      expect(mat.map).toBeInstanceOf(THREE.Texture);
      expect(mat.map!.colorSpace).toBe(THREE.SRGBColorSpace);
      // Augmented like every body's surface, so the probe keys the program a
      // real moon will draw with.
      expect(mat.onBeforeCompile).not.toBe(THREE.Material.prototype.onBeforeCompile);
      // Never pickable: a probe sits at the origin for the whole session.
      const hits: THREE.Intersection[] = [];
      mesh.raycast(new THREE.Raycaster(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)), hits);
      expect(hits).toEqual([]);
    }
    for (const combo of SHADER_WARMUP_PROBE_COMBOS) expect(combo.why.length).toBeGreaterThan(0);
    expect(group.visible).toBe(false);
    dispose();
  });
});
