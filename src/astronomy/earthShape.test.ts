/**
 * WGS 84 against JPL Horizons' own conversion: each site's "Center
 * cylindric" header line (distance from the axis and from the equator plane)
 * for a CENTER='coord@399' query with COORD_TYPE='GEODETIC', fetched
 * 2026-11-17. Horizons' Earth radii are a = 6378.137 km and c = 6356.752 km,
 * so the comparison holds to a metre.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  WGS84_EQUATORIAL_RADIUS_KM,
  WGS84_POLAR_RADIUS_KM,
  bodyFrameKmToGeodetic,
  geodeticToBodyFrameKm,
  rayEllipsoidDistanceKm,
  type GeodeticPosition,
} from './earthShape';

const HORIZONS_SITES = [
  // SITE_COORD='2.12955,53.80939,0.073': Dxy 3774.40111, Dz 5124.30406
  { site: { longitudeDeg: 2.12955, latitudeDeg: 53.80939, heightKm: 0.073 }, axisDistanceKm: 3774.40111, equatorDistanceKm: 5124.30406 },
  // SITE_COORD='-25.2283,65.225,0': Dxy 2680.20223, Dz 5768.26707
  { site: { longitudeDeg: -25.2283, latitudeDeg: 65.225, heightKm: 0 }, axisDistanceKm: 2680.20223, equatorDistanceKm: 5768.26707 },
];

describe('geodeticToBodyFrameKm', () => {
  it.each(HORIZONS_SITES)('matches Horizons at $site.latitudeDeg°', ({ site, axisDistanceKm, equatorDistanceKm }) => {
    const point = geodeticToBodyFrameKm(site, new THREE.Vector3());
    expect(Math.abs(Math.hypot(point.x, point.z) - axisDistanceKm)).toBeLessThan(1e-3);
    expect(Math.abs(point.y - equatorDistanceKm)).toBeLessThan(1e-3);
  });

  it('puts east longitude at body −Z and the north pole at +Y', () => {
    const east = geodeticToBodyFrameKm({ latitudeDeg: 0, longitudeDeg: 90, heightKm: 0 }, new THREE.Vector3());
    expect(east.z).toBeCloseTo(-WGS84_EQUATORIAL_RADIUS_KM, 9);
    const pole = geodeticToBodyFrameKm({ latitudeDeg: 90, longitudeDeg: 0, heightKm: 0 }, new THREE.Vector3());
    expect(pole.y).toBeCloseTo(WGS84_POLAR_RADIUS_KM, 9);
  });
});

describe('bodyFrameKmToGeodetic', () => {
  it('inverts the forward conversion everywhere', () => {
    const point = new THREE.Vector3();
    const back: GeodeticPosition = { latitudeDeg: 0, longitudeDeg: 0, heightKm: 0 };
    for (const latitudeDeg of [-89.9, -65, -30, 0, 0.001, 25.5, 53.8, 65.2, 89.99]) {
      for (const longitudeDeg of [-179.5, -48.5, 0, 33.2, 126.7, 180]) {
        for (const heightKm of [0, 0.002, 374]) {
          geodeticToBodyFrameKm({ latitudeDeg, longitudeDeg, heightKm }, point);
          bodyFrameKmToGeodetic(point, back);
          const where = `${latitudeDeg}, ${longitudeDeg}, ${heightKm}`;
          expect(back.latitudeDeg, where).toBeCloseTo(latitudeDeg, 9);
          if (Math.abs(latitudeDeg) < 89.9) {
            const longitudeError = ((back.longitudeDeg - longitudeDeg + 540) % 360) - 180;
            expect(Math.abs(longitudeError), where).toBeLessThan(1e-9);
          }
          expect(back.heightKm, where).toBeCloseTo(heightKm, 6);
        }
      }
    }
  });
});

describe('rayEllipsoidDistanceKm', () => {
  it('meets the equator at a and the pole at b', () => {
    const fromEast = rayEllipsoidDistanceKm(new THREE.Vector3(10_000, 0, 0), new THREE.Vector3(-1, 0, 0));
    expect(fromEast).toBeCloseTo(10_000 - WGS84_EQUATORIAL_RADIUS_KM, 9);
    const fromAbove = rayEllipsoidDistanceKm(new THREE.Vector3(0, 10_000, 0), new THREE.Vector3(0, -1, 0));
    expect(fromAbove).toBeCloseTo(10_000 - WGS84_POLAR_RADIUS_KM, 9);
  });

  it('lands on the surface for a slanted ray, and misses when it should', () => {
    const origin = new THREE.Vector3(3_000, 9_000, -4_000);
    const direction = new THREE.Vector3(-0.2, -1, 0.35).normalize();
    const distance = rayEllipsoidDistanceKm(origin, direction)!;
    const hit = origin.clone().addScaledVector(direction, distance);
    const geodetic = bodyFrameKmToGeodetic(hit, { latitudeDeg: 0, longitudeDeg: 0, heightKm: 0 });
    expect(Math.abs(geodetic.heightKm)).toBeLessThan(1e-6);
    expect(rayEllipsoidDistanceKm(new THREE.Vector3(0, 9_000, 0), new THREE.Vector3(1, 0, 0))).toBeNull();
  });
});
