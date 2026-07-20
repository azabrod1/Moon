import { describe, expect, it, vi } from 'vitest';

vi.mock('./ship/models/defaultShip', async () => {
  const THREE = await import('three');
  return {
    createDefaultShip: () => {
      const model = new THREE.Group();
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
      const exhaustCone = new THREE.Mesh(new THREE.ConeGeometry(0.2, 1), new THREE.MeshBasicMaterial());
      const exhaustCore = new THREE.Mesh(new THREE.ConeGeometry(0.1, 1), new THREE.MeshBasicMaterial());
      model.add(mesh, exhaustCone, exhaustCore);
      return { model, mesh, exhaustCone, exhaustCore };
    },
  };
});

import { PlayerShip } from './PlayerShip';
import { PLAYER_SHIPS } from './ship/shipProfiles';

describe('PlayerShip selectable profile routing', () => {
  it.each(PLAYER_SHIPS.filter(({ id }) => id !== 'default'))('routes $label to its own model', ({ id }) => {
    if (id === 'default') throw new Error('Default is intentionally outside this custom-model test.');
    const player = new PlayerShip();

    player.setProfile(id);

    const visibleModel = player.group.userData.shipModel;
    expect(visibleModel.visible).toBe(true);
    expect(visibleModel.userData.playerShipProfile).toBe(id);
  });

  it('does not rewrite model visibility when the requested profile is already active', () => {
    const player = new PlayerShip();
    player.setProfile('enterprise');
    const visibleModel = player.group.userData.shipModel;
    let visibilityWrites = 0;
    let visible = visibleModel.visible;
    Object.defineProperty(visibleModel, 'visible', {
      configurable: true,
      get: () => visible,
      set: (next: boolean) => {
        visibilityWrites += 1;
        visible = next;
      },
    });

    player.setProfile('enterprise');

    expect(visibilityWrites).toBe(0);
    expect(player.group.userData.activeShipProfile).toBe('enterprise');
  });

  it('dims parked fleet engines and powers them up while moving', () => {
    const player = new PlayerShip();
    player.setProfile('ussVoyager');
    const model = player.group.userData.shipModel as import('three').Group;
    const light = model.getObjectByName('ussVoyager-aft-engine-light-1') as import('three').Mesh;
    const material = light.material as import('three').MeshBasicMaterial;

    player.moving = false;
    player.update(0.1);
    expect(material.opacity).toBeCloseTo(0.24);
    player.moving = true;
    player.update(0.1);
    expect(material.opacity).toBeGreaterThan(0.7);
  });
});
