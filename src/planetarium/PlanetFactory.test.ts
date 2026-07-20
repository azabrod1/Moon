import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { cancelTextureUpgrade, type TextureUpgrade } from './PlanetFactory';

function upgrade(state: TextureUpgrade['state']): TextureUpgrade {
  return {
    key: 'moon',
    material: new THREE.MeshStandardMaterial(),
    state,
  };
}

describe('covered texture upgrades', () => {
  it('cancels an optional 4K fetch that missed its covered window', () => {
    const up = upgrade('loading');
    cancelTextureUpgrade(up);
    expect(up.state).toBe('cancelled');
    up.material.dispose();
  });

  it('does not cancel an upgrade before it starts or after it settles', () => {
    for (const state of ['idle', 'done', 'failed'] as const) {
      const up = upgrade(state);
      cancelTextureUpgrade(up);
      expect(up.state).toBe(state);
      up.material.dispose();
    }
  });
});
