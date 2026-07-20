import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { PLAYER_SHIPS } from '../shipProfiles';
import { createPlayerFleetModel } from './playerFleet';

const FLEET = PLAYER_SHIPS.filter((ship) => ship.id !== 'default');

describe('player fleet models', () => {
  it('keeps an even-sized menu fleet', () => {
    expect(PLAYER_SHIPS).toHaveLength(14);
    expect(PLAYER_SHIPS.length % 2).toBe(0);
  });

  it.each(FLEET)('$label has a detailed, finite chase-scale model', ({ id }) => {
    const model = createPlayerFleetModel(id, 1);
    model.updateMatrixWorld(true);

    let meshCount = 0;
    const materialKinds = new Set<string>();
    const standardMaterials = new Set<THREE.MeshStandardMaterial>();
    model.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      meshCount++;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        materialKinds.add(`${material.type}:${material.uuid}`);
        if (material instanceof THREE.MeshStandardMaterial) standardMaterials.add(material);
      }
    });

    const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
    expect([size.x, size.y, size.z].every(Number.isFinite)).toBe(true);
    expect(Math.max(size.x, size.y, size.z)).toBeGreaterThan(2.5);
    expect(Math.max(size.x, size.y, size.z)).toBeLessThan(7);
    expect(meshCount).toBeGreaterThanOrEqual(20);
    expect(materialKinds.size).toBeGreaterThanOrEqual(3);
    for (const material of standardMaterials) {
      expect(material.emissiveIntensity).toBeGreaterThanOrEqual(0.24);
      expect(Math.max(material.emissive.r, material.emissive.g, material.emissive.b)).toBeGreaterThanOrEqual(0.035);
    }
  });

  it('seats the Millennium Falcon engine light inside a matching aft housing', () => {
    const falcon = createPlayerFleetModel('falcon', 1);
    const housing = falcon.getObjectByName('falcon-engine-housing');
    const light = falcon.getObjectByName('falcon-engine-light');
    expect(housing).toBeInstanceOf(THREE.Mesh);
    expect(light).toBeInstanceOf(THREE.Mesh);
    const housingBox = new THREE.Box3().setFromObject(housing!);
    const lightBox = new THREE.Box3().setFromObject(light!);
    expect(housingBox.containsBox(lightBox)).toBe(true);
  });

  it('gives SpaceX Starship three sea-level and three vacuum engines', () => {
    const starship = createPlayerFleetModel('starship', 1);
    const names: string[] = [];
    starship.traverse((object) => {
      if (object.name.startsWith('starship-') && object.name.includes('-engine-')) names.push(object.name);
    });
    expect(names.filter((name) => name.includes('sea-level'))).toHaveLength(3);
    expect(names.filter((name) => name.includes('vacuum'))).toHaveLength(3);
  });
});
