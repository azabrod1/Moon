/**
 * Tests for the orbit-line resampling seam — the only part of the lazy
 * 50-year rebuild that contains mechanics (the staleness policy in
 * PlanetariumMode is a two-line threshold check). Runs headless: THREE
 * BufferGeometry math needs no WebGL context.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ORBIT_LINE_SEGMENTS, resampleOrbitLines, type SolarSystemObjects } from './SolarSystem';
import { eclipticToEquatorial } from '../astronomy/planetary';
import { PLANETARIUM_BODIES } from './planets/planetData';

const J2000_UTC_MS = Date.UTC(2000, 0, 1, 12, 0, 0);

function makeBareObjects(): Pick<SolarSystemObjects, 'orbitLines' | 'orbitLinesEpochUtcMs'> {
  // Exactly the fields resampleOrbitLines declares it needs.
  return {
    orbitLines: PLANETARIUM_BODIES.map(
      () => new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial()),
    ),
    orbitLinesEpochUtcMs: 0,
  };
}

describe('resampleOrbitLines', () => {
  it('fills every line with a closed orbit and stamps the epoch', () => {
    const objects = makeBareObjects();
    resampleOrbitLines(objects, 'realistic', J2000_UTC_MS);

    expect(objects.orbitLinesEpochUtcMs).toBe(J2000_UTC_MS);
    for (let i = 0; i < objects.orbitLines.length; i++) {
      const geometry = objects.orbitLines[i].geometry;
      const position = geometry.getAttribute('position');
      expect(position.count, PLANETARIUM_BODIES[i].name).toBe(ORBIT_LINE_SEGMENTS + 1);
      expect(geometry.boundingSphere, PLANETARIUM_BODIES[i].name).not.toBeNull();
      // Bounding sphere must be orbit-sized, not the default empty sphere.
      expect(geometry.boundingSphere!.radius).toBeGreaterThan(
        PLANETARIUM_BODIES[i].semiMajorAxisAU * 0.5,
      );
    }
  });

  it('moves the lines and the bounding spheres when resampled centuries later', () => {
    const objects = makeBareObjects();
    resampleOrbitLines(objects, 'realistic', J2000_UTC_MS);
    const mercury = objects.orbitLines[0].geometry;
    const before = new THREE.Vector3().fromBufferAttribute(mercury.getAttribute('position'), 0);

    const later = J2000_UTC_MS + 200 * 365.25 * 86_400_000;
    resampleOrbitLines(objects, 'realistic', later);

    expect(objects.orbitLinesEpochUtcMs).toBe(later);
    const after = new THREE.Vector3().fromBufferAttribute(mercury.getAttribute('position'), 0);
    // Mercury's node/perihelion drift ~0.3°/cy: the perihelion vertex must
    // have moved measurably, and in place (same attribute object count).
    expect(after.distanceTo(before)).toBeGreaterThan(1e-4);
    expect(mercury.getAttribute('position').count).toBe(ORBIT_LINE_SEGMENTS + 1);
  });

  it('draws catalog-radius ecliptic circles in aligned mode', () => {
    // Aligned rings are circles in the ecliptic plane expressed in the
    // equatorial scene frame (same obliquity tilt as every orbit) — epoch-free.
    const objects = makeBareObjects();
    resampleOrbitLines(objects, 'aligned', J2000_UTC_MS);
    for (let i = 0; i < objects.orbitLines.length; i++) {
      const position = objects.orbitLines[i].geometry.getAttribute('position');
      const radiusAU = PLANETARIUM_BODIES[i].semiMajorAxisAU;
      for (const vertexIndex of [0, 64, 192]) {
        const angle = (vertexIndex / ORBIT_LINE_SEGMENTS) * Math.PI * 2;
        const expected = eclipticToEquatorial(
          new THREE.Vector3(radiusAU * Math.cos(angle), 0, radiusAU * Math.sin(angle)),
        );
        // BufferAttribute is float32: ~1e-7 relative quantization.
        const v = new THREE.Vector3().fromBufferAttribute(position, vertexIndex);
        expect(v.distanceTo(expected), PLANETARIUM_BODIES[i].name).toBeLessThan(1e-5 * (1 + radiusAU));
      }
    }
  });
});
