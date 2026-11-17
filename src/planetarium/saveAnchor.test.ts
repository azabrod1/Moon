import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { anchoredShipPositionAU, currentBodyPositionAU, migrateLegacyJourney, rideAnchorFor } from './saveAnchor';
import { POSITION_MODEL, createDefaultPlanetariumState, type PlanetariumState } from './PlanetariumStore';
import { legacyMoonOffsetAU, legacyPlanetPositionAU } from '../astronomy/legacyPositions';
import { KM_PER_AU } from '../astronomy/constants';
import { PLANETARIUM_BODIES } from './planets/planetData';

const UTC_MS = Date.UTC(2026, 10, 17, 6, 30);
const planet = (name: string) => PLANETARIUM_BODIES.find((body) => body.name === name)!;
const km = (value: number) => value / KM_PER_AU;

/** A save written by the old build: no positionModel, the ship at `shipAU`. */
function legacySave(shipAU: THREE.Vector3, overrides: Partial<PlanetariumState> = {}): PlanetariumState {
  const state = { ...createDefaultPlanetariumState(), ...overrides };
  delete state.positionModel;
  state.positionAU = { x: shipAU.x, y: shipAU.y, z: shipAU.z };
  state.astroTimeUtcMs = UTC_MS;
  return state;
}

function vectorOf(position: { x: number; y: number; z: number }): THREE.Vector3 {
  return new THREE.Vector3(position.x, position.y, position.z);
}

describe('ride anchors', () => {
  it('put a ship back at its offset from the body', () => {
    const earthAU = currentBodyPositionAU('Earth', undefined, UTC_MS, new THREE.Vector3())!;
    const shipAU = earthAU.clone().add(new THREE.Vector3(km(7000), km(-300), km(2000)));
    const anchor = rideAnchorFor('Earth', undefined, shipAU, UTC_MS)!;
    const restored = new THREE.Vector3();
    expect(anchoredShipPositionAU(anchor, UTC_MS, restored)).toBe(true);
    expect(restored.distanceTo(shipAU) * KM_PER_AU).toBeLessThan(1e-6);
  });

  it('anchor to a moon through its parent', () => {
    const moonAU = currentBodyPositionAU('Io', 'Jupiter', UTC_MS, new THREE.Vector3())!;
    const shipAU = moonAU.clone().add(new THREE.Vector3(km(2500), 0, 0));
    const anchor = rideAnchorFor('Io', 'Jupiter', shipAU, UTC_MS)!;
    expect(anchor.parentPlanet).toBe('Jupiter');
    expect(anchor.offsetAU.x * KM_PER_AU).toBeCloseTo(2500, 3);
  });

  it('decline a body the catalog does not know', () => {
    expect(rideAnchorFor('Vulcan', undefined, new THREE.Vector3(), UTC_MS)).toBeNull();
    expect(anchoredShipPositionAU({ body: 'Io', parentPlanet: 'Saturn', offsetAU: { x: 0, y: 0, z: 0 } }, UTC_MS, new THREE.Vector3())).toBe(false);
  });
});

describe('migrateLegacyJourney', () => {
  // Each case parks a ship where the old build drew a body, and checks it
  // comes back the same distance from that body as the scene draws it now.
  const cases: Array<{ label: string; body: string; parentPlanet?: string; offsetKm: [number, number, number] }> = [
    { label: 'parked over Earth', body: 'Earth', offsetKm: [6378 + 195, 0, 0] },
    { label: 'parked over the Moon', body: 'Moon', parentPlanet: 'Earth', offsetKm: [0, 1737 + 68, 0] },
    { label: 'parked over Io', body: 'Io', parentPlanet: 'Jupiter', offsetKm: [0, 0, 1822 + 150] },
    { label: 'far out in Jupiter\'s system', body: 'Jupiter', offsetKm: [-900_000, 0, 300_000] },
  ];

  it.each(cases)('moves a ship $label with that body', ({ body, parentPlanet, offsetKm }) => {
    const parentName = parentPlanet ?? body;
    const legacyAU = legacyPlanetPositionAU(planet(parentName), UTC_MS, new THREE.Vector3());
    if (parentPlanet) legacyAU.add(legacyMoonOffsetAU(body, parentPlanet, UTC_MS, new THREE.Vector3()));
    const offset = new THREE.Vector3(...offsetKm.map(km) as [number, number, number]);
    const migrated = migrateLegacyJourney(legacySave(legacyAU.clone().add(offset)));
    expect(migrated.positionModel).toBe(POSITION_MODEL);
    const nowAU = currentBodyPositionAU(body, parentPlanet, UTC_MS, new THREE.Vector3())!;
    expect(vectorOf(migrated.positionAU).sub(nowAU).distanceTo(offset) * KM_PER_AU).toBeLessThan(0.05);
  });

  it('says how far the bodies moved, so the cases above test something', () => {
    const legacyEarth = legacyPlanetPositionAU(planet('Earth'), UTC_MS, new THREE.Vector3());
    const nowEarth = currentBodyPositionAU('Earth', undefined, UTC_MS, new THREE.Vector3())!;
    expect(legacyEarth.distanceTo(nowEarth) * KM_PER_AU).toBeGreaterThan(195);
  });

  it('leaves a deep-space ship where it was', () => {
    const shipAU = new THREE.Vector3(3.1, 0.4, -2.2);
    const migrated = migrateLegacyJourney(legacySave(shipAU));
    expect(vectorOf(migrated.positionAU).distanceTo(shipAU)).toBe(0);
    expect(migrated.positionModel).toBe(POSITION_MODEL);
  });

  it('leaves landed journeys and current saves alone', () => {
    const landed = legacySave(new THREE.Vector3(1, 0, 0), { landedOn: { type: 'planet', name: 'Mars' } });
    expect(migrateLegacyJourney(landed).positionAU).toEqual(landed.positionAU);
    const current = createDefaultPlanetariumState();
    expect(migrateLegacyJourney(current)).toBe(current);
  });
});
