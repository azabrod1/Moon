import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import fixture from './legacyPositions.fixture.json';
import { legacyMoonOffsetAU, legacyPlanetPositionAU } from './legacyPositions';
import { KM_PER_AU } from './constants';
import { PLANETARIUM_BODIES } from '../planetarium/planets/planetData';

const PARENT: Record<string, string> = { Moon: 'Earth', Io: 'Jupiter', Titan: 'Saturn', Phobos: 'Mars' };

describe('legacy positions reproduce the deployed build', () => {
  it.each(fixture.instants)('at $utc', (row) => {
    const utcMs = Date.parse(row.utc);
    const position = new THREE.Vector3();
    for (const body of PLANETARIUM_BODIES) {
      legacyPlanetPositionAU(body, utcMs, position);
      const expected = new THREE.Vector3(...(row.planets as unknown as Record<string, [number, number, number]>)[body.name]);
      // Within a metre of the deployed build's own numbers.
      expect(position.distanceTo(expected) * KM_PER_AU, body.name).toBeLessThan(1e-3);
    }
    for (const [moon, expectedArray] of Object.entries(row.moonOffsets as unknown as Record<string, [number, number, number]>)) {
      legacyMoonOffsetAU(moon, PARENT[moon], utcMs, position);
      // To the millisecond the clock resolves: Io moves 17 m in one.
      expect(position.distanceTo(new THREE.Vector3(...expectedArray)) * KM_PER_AU, moon).toBeLessThan(0.02);
    }
  });
});
