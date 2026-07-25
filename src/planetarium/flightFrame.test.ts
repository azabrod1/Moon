import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FLIGHT_UP_SCENE } from './flightFrame';
import { ECLIPTIC_NORTH_EQUATORIAL } from '../astronomy/planetary';
import { OBLIQUITY_DEG, DEG } from '../astronomy/constants';

describe('the cruise flight horizon', () => {
  it('is the astronomy module\'s ecliptic north — one definition site, not a copy', () => {
    // A second inlined obliquity rotation is exactly the drift the frame
    // contract forbids: the flight frame must BE the astronomy vector.
    expect(FLIGHT_UP_SCENE).toBe(ECLIPTIC_NORTH_EQUATORIAL);
  });

  it('is a unit vector', () => {
    expect(FLIGHT_UP_SCENE.length()).toBeCloseTo(1, 12);
  });

  it('sits at the obliquity from celestial north, tilted toward +Z', () => {
    // RotX(+ε) carries the ecliptic pole to (0, cos ε, sin ε) — the J2000
    // equatorial position of the north ecliptic pole (RA 270°, Dec 90°−ε).
    const eps = OBLIQUITY_DEG * DEG;
    expect(FLIGHT_UP_SCENE.x).toBeCloseTo(0, 12);
    expect(FLIGHT_UP_SCENE.y).toBeCloseTo(Math.cos(eps), 12);
    expect(FLIGHT_UP_SCENE.z).toBeCloseTo(Math.sin(eps), 12);
    // And it is genuinely tilted — a horizon change that silently reverted to
    // world-up would otherwise pass every level-flight assertion.
    const tiltDeg = THREE.MathUtils.radToDeg(
      FLIGHT_UP_SCENE.angleTo(new THREE.Vector3(0, 1, 0)),
    );
    expect(tiltDeg).toBeCloseTo(OBLIQUITY_DEG, 9);
  });
});
