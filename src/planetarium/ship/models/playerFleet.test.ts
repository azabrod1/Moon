import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { PLAYER_SHIPS, type PlayerShipProfile } from '../shipProfiles';
import { createPlayerFleetModel } from './playerFleet';

const FLEET = PLAYER_SHIPS.filter((ship) => ship.id !== 'default');
type AuditedProfile = Exclude<PlayerShipProfile, 'default' | 'saucer'>;

/** Primary-reference silhouette landmarks. If a profile is accidentally
 * routed to a fallback (the regression that made Orion, Starliner, Dream
 * Chaser, and the Bird-of-Prey identical), these signatures fail loudly. */
const AUTHENTICITY_SIGNATURES = {
  starship: ['starship-stainless-hull', 'starship-forward-flap-port', 'starship-sea-level-engine-1', 'starship-vacuum-engine-1'],
  dragon: ['dragon-crew-capsule', 'dragon-unpressurized-trunk', 'dragon-trunk-solar-facet-1'],
  orion: ['orion-crew-module', 'orion-european-service-module', 'orion-solar-panel-y--1-1', 'orion-solar-panel-z-1-3'],
  starliner: ['starliner-crew-capsule', 'starliner-service-module', 'starliner-aft-solar-cell-1'],
  dreamChaser: ['dream-chaser-lifting-body', 'dream-chaser-cockpit', 'dream-chaser-tail-port'],
  soyuz: ['soyuz-orbital-module', 'soyuz-descent-module', 'soyuz-instrumentation-propulsion-module', 'soyuz-solar-wing-port'],
  apollo: ['apollo-command-module', 'apollo-service-module', 'apollo-service-propulsion-engine'],
  shuttle: ['shuttle-orbiter-fuselage', 'shuttle-delta-wing'],
  falcon: ['falcon-offset-cockpit', 'falcon-engine-housing', 'falcon-engine-light'],
  xwing: ['x-wing-fuselage', 'x-wing-s-foil-upper-port', 'x-wing-s-foil-lower-starboard'],
  ywing: ['y-wing-cockpit', 'y-wing-astromech-dome', 'y-wing-engine-nacelle-port'],
  tie: ['tie-spherical-cockpit', 'tie-hexagonal-solar-wing-port', 'tie-hexagonal-solar-wing-starboard'],
  starDestroyer: ['star-destroyer-dagger-wedge', 'star-destroyer-command-tower', 'star-destroyer-ventral-hangar'],
  naboo: ['naboo-pilot-canopy', 'naboo-astromech-dome', 'naboo-j-type-engine-port', 'naboo-center-tail-finial'],
  enterprise: ['enterprise-primary-saucer', 'enterprise-secondary-hull', 'enterprise-warp-nacelle-port'],
  ussVoyager: ['voyager-primary-hull', 'voyager-secondary-hull', 'voyager-variable-nacelle-port', 'voyager-navigational-deflector'],
  klingon: ['klingon-command-head', 'klingon-long-neck', 'klingon-swept-wing-port', 'klingon-wingtip-cannon-starboard'],
  romulan: ['romulan-command-head', 'romulan-outstretched-neck', 'romulan-dorsal-wing-port', 'romulan-ventral-wing-starboard', 'romulan-warp-nacelle-port', 'romulan-open-hollow-core'],
} satisfies Record<AuditedProfile, string[]>;

describe('player fleet models', () => {
  it('keeps an even-sized menu fleet', () => {
    expect(PLAYER_SHIPS).toHaveLength(20);
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

  it.each(Object.entries(AUTHENTICITY_SIGNATURES) as Array<[AuditedProfile, string[]]>)('%s keeps its researched silhouette landmarks', (profile, anchors) => {
    const model = createPlayerFleetModel(profile, 1);
    expect(model.userData.playerShipProfile).toBe(profile);
    for (const anchor of anchors) expect(model.getObjectByName(anchor), anchor).toBeDefined();
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
