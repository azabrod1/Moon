/**
 * Tests for the orbit-line resampling seam — the only part of the lazy
 * drift rebuild that contains mechanics (the staleness policy in
 * PlanetariumMode is a two-line threshold check). Runs headless: THREE
 * BufferGeometry math needs no WebGL context.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  ORBIT_LINE_SEGMENTS,
  createAsteroidBelt,
  getPlanetOrbitalPosition,
  orbitLineSegmentCount,
  resampleOrbitLines,
  type SolarSystemObjects,
} from './SolarSystem';
import { computeBodyPositionAU, eclipticToEquatorial } from '../astronomy/planetary';
import { ASTEROID_BELT, PLANETARIUM_BODIES } from './planets/planetData';

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

function minDistToPolyline(p: THREE.Vector3, position: THREE.BufferAttribute): number {
  let best = Infinity;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ap = new THREE.Vector3();
  const closest = new THREE.Vector3();
  for (let i = 0; i + 1 < position.count; i++) {
    a.fromBufferAttribute(position, i);
    b.fromBufferAttribute(position, i + 1);
    ab.subVectors(b, a);
    ap.subVectors(p, a);
    const t = Math.max(0, Math.min(1, ap.dot(ab) / ab.lengthSq()));
    closest.copy(a).addScaledVector(ab, t);
    best = Math.min(best, p.distanceTo(closest));
  }
  return best;
}

describe('asteroid belt', () => {
  it('builds the same position and colour buffers on every load', () => {
    const first = createAsteroidBelt();
    const second = createAsteroidBelt();

    expect(Array.from(first.geometry.getAttribute('position').array)).toEqual(
      Array.from(second.geometry.getAttribute('position').array),
    );
    expect(Array.from(first.geometry.getAttribute('color').array)).toEqual(
      Array.from(second.geometry.getAttribute('color').array),
    );
  });

  it('stays inside the configured ecliptic annulus and spans both sides of its plane', () => {
    const belt = createAsteroidBelt();
    const positions = belt.geometry.getAttribute('position') as THREE.BufferAttribute;
    const eclipticNorth = eclipticToEquatorial(new THREE.Vector3(0, 1, 0)).normalize();
    const point = new THREE.Vector3();
    let minHeight = Infinity;
    let maxHeight = -Infinity;
    let minRadius = Infinity;
    let maxRadius = -Infinity;

    for (let i = 0; i < positions.count; i++) {
      point.fromBufferAttribute(positions, i);
      const height = point.dot(eclipticNorth);
      const radius = point.addScaledVector(eclipticNorth, -height).length();
      minHeight = Math.min(minHeight, height);
      maxHeight = Math.max(maxHeight, height);
      minRadius = Math.min(minRadius, radius);
      maxRadius = Math.max(maxRadius, radius);
    }

    const FLOAT32_TOLERANCE_AU = 1e-6;
    expect(positions.count).toBe(3000);
    expect(minHeight).toBeGreaterThanOrEqual(-0.025 - FLOAT32_TOLERANCE_AU);
    expect(maxHeight).toBeLessThanOrEqual(0.025 + FLOAT32_TOLERANCE_AU);
    expect(minHeight).toBeLessThan(0);
    expect(maxHeight).toBeGreaterThan(0);
    expect(minRadius).toBeGreaterThanOrEqual(ASTEROID_BELT.innerAU - FLOAT32_TOLERANCE_AU);
    expect(maxRadius).toBeLessThanOrEqual(ASTEROID_BELT.outerAU + FLOAT32_TOLERANCE_AU);
  });
});

describe('aligned layout positions', () => {
  it('puts every planet on its catalog-radius circle in the transformed ecliptic plane', () => {
    const eclipticNorth = eclipticToEquatorial(new THREE.Vector3(0, 1, 0)).normalize();
    for (let i = 0; i < PLANETARIUM_BODIES.length; i++) {
      const body = PLANETARIUM_BODIES[i];
      const position = getPlanetOrbitalPosition(body, i + 1, 'aligned');
      const point = new THREE.Vector3(position.x, position.y, position.z);
      expect(Math.abs(point.dot(eclipticNorth)), body.name).toBeLessThan(1e-12);
      expect(Math.abs(point.length() - body.semiMajorAxisAU), body.name).toBeLessThan(1e-12);
    }
  });
});

describe('resampleOrbitLines', () => {
  it('fills every line with a closed orbit and stamps the epoch', () => {
    const objects = makeBareObjects();
    resampleOrbitLines(objects, 'realistic', J2000_UTC_MS);

    expect(objects.orbitLinesEpochUtcMs).toBe(J2000_UTC_MS);
    for (let i = 0; i < objects.orbitLines.length; i++) {
      const geometry = objects.orbitLines[i].geometry;
      const position = geometry.getAttribute('position');
      expect(position.count, PLANETARIUM_BODIES[i].name).toBe(
        orbitLineSegmentCount(PLANETARIUM_BODIES[i]) + 1,
      );
      expect(geometry.boundingSphere, PLANETARIUM_BODIES[i].name).not.toBeNull();
      // Bounding sphere must be orbit-sized, not the default empty sphere.
      expect(geometry.boundingSphere!.radius).toBeGreaterThan(
        PLANETARIUM_BODIES[i].semiMajorAxisAU * 0.5,
      );
    }
  });

  it('keeps every planet on its own drawn line, even at the staleness bound', () => {
    // The user-facing guarantee behind the trajectory sampling + the 60-day
    // rebuild threshold: at landed zoom the planet must sit ON its orbit
    // line. Half a body radius of slack covers Pluto's clamped segment count
    // (~0.37 R sagitta) and Mercury's worst-case one-orbit-old precession at
    // 59 days stale. The old element-ellipse lines failed this by 1.4 R⊕
    // (Earth's Meeus/EMB seam) up to ~200 R (Pluto at 256 segments).
    const epochs = [
      Date.UTC(1977, 8, 5), // Voyager mission jump territory
      Date.UTC(2026, 5, 11),
      Date.UTC(2032, 0, 1),
    ];
    const STALE_MS = 59 * 86_400_000; // just under the rebuild threshold
    const objects = makeBareObjects();
    for (const epoch of epochs) {
      resampleOrbitLines(objects, 'realistic', epoch);
      for (const staleMs of [0, STALE_MS]) {
        for (let i = 0; i < objects.orbitLines.length; i++) {
          const body = PLANETARIUM_BODIES[i];
          const pos = computeBodyPositionAU(body, epoch + staleMs);
          const p = new THREE.Vector3(pos.x, pos.y, pos.z);
          const offAU = minDistToPolyline(
            p,
            objects.orbitLines[i].geometry.getAttribute('position') as THREE.BufferAttribute,
          );
          expect(offAU, `${body.name} @ ${new Date(epoch).toISOString()} +${staleMs / 86_400_000}d`)
            .toBeLessThan(body.radiusAU * 0.5);
        }
      }
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
    // The strip starts half a period before the epoch — 200 years later that
    // vertex sits somewhere else entirely on the (precessed) orbit, and the
    // resample must land in place (same attribute, same count).
    expect(after.distanceTo(before)).toBeGreaterThan(1e-4);
    expect(mercury.getAttribute('position').count).toBe(
      orbitLineSegmentCount(PLANETARIUM_BODIES[0]) + 1,
    );
  });

  it('draws catalog-radius ecliptic circles in aligned mode', () => {
    // Aligned rings are circles in the ecliptic plane expressed in the
    // equatorial scene frame (same obliquity tilt as every orbit) — epoch-free.
    // Independent expectation: longitude `angle` sits at (cos, 0, −sin) in the
    // scene's ecliptic frame (longitude runs toward −Z; planetary.test.ts).
    const objects = makeBareObjects();
    resampleOrbitLines(objects, 'aligned', J2000_UTC_MS);
    for (let i = 0; i < objects.orbitLines.length; i++) {
      const position = objects.orbitLines[i].geometry.getAttribute('position');
      const radiusAU = PLANETARIUM_BODIES[i].semiMajorAxisAU;
      for (const vertexIndex of [0, 64, 192]) {
        const angle = (vertexIndex / ORBIT_LINE_SEGMENTS) * Math.PI * 2;
        const expected = eclipticToEquatorial(
          new THREE.Vector3(radiusAU * Math.cos(angle), 0, -radiusAU * Math.sin(angle)),
        );
        // BufferAttribute is float32: ~1e-7 relative quantization.
        const v = new THREE.Vector3().fromBufferAttribute(position, vertexIndex);
        expect(v.distanceTo(expected), PLANETARIUM_BODIES[i].name).toBeLessThan(1e-5 * (1 + radiusAU));
      }
    }
  });
});
