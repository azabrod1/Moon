/**
 * Pins the Observatory surface view's observer-circumstances table and its
 * vantage/FOV geometry: every landed×kind×involvement combination, the
 * shadow-spot vantage's degradation chain (hit → nearest-to-axis →
 * sub-occluder), the altitude clamp, and the entry-FOV-fits-the-disc rule.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  angularDiameterDeg,
  clampSurfaceFovDeg,
  computeShadowSpotVantage,
  computeSubTargetVantage,
  entryFovDeg,
  selectSurfaceTarget,
  SURFACE_FOV_DEFAULT_DEG,
  SURFACE_MIN_ALTITUDE_AU,
  surfaceAltitudeAU,
  type SurfaceEventInfo,
  type SurfaceLandedInfo,
} from './surfaceView';
import { shadowAxisSphereHitAU, shadowAxisSurfacePoint } from '../astronomy/shadows';
import { KM_PER_AU } from '../astronomy/constants';

const onEarth: SurfaceLandedInfo = { type: 'planet', name: 'Earth' };
const onMoon: SurfaceLandedInfo = { type: 'moon', name: 'Moon', parentPlanet: 'Earth' };
const onJupiter: SurfaceLandedInfo = { type: 'planet', name: 'Jupiter' };
const onIo: SurfaceLandedInfo = { type: 'moon', name: 'Io', parentPlanet: 'Jupiter' };
const onEuropa: SurfaceLandedInfo = { type: 'moon', name: 'Europa', parentPlanet: 'Jupiter' };

const lunarEclipse: SurfaceEventInfo = { kind: 'eclipse', parentPlanet: 'Earth', moonName: 'Moon' };
const solarEclipse: SurfaceEventInfo = { kind: 'shadow-transit', parentPlanet: 'Earth', moonName: 'Moon' };
const ioEclipse: SurfaceEventInfo = { kind: 'eclipse', parentPlanet: 'Jupiter', moonName: 'Io' };
const ioTransit: SurfaceEventInfo = { kind: 'shadow-transit', parentPlanet: 'Jupiter', moonName: 'Io' };

describe('selectSurfaceTarget — the observer-circumstances table', () => {
  it('on the parent, an eclipse points at the eclipsed moon', () => {
    expect(selectSurfaceTarget(onEarth, lunarEclipse)).toEqual({ kind: 'moon', moonName: 'Moon' });
    expect(selectSurfaceTarget(onJupiter, ioEclipse)).toEqual({ kind: 'moon', moonName: 'Io' });
  });

  it('on the parent, a shadow transit is a solar eclipse: Sun, standing in the spot', () => {
    expect(selectSurfaceTarget(onEarth, solarEclipse)).toEqual({
      kind: 'sun-from-spot',
      occluderMoonName: 'Moon',
    });
    expect(selectSurfaceTarget(onJupiter, ioTransit)).toEqual({
      kind: 'sun-from-spot',
      occluderMoonName: 'Io',
    });
  });

  it("on the involved moon, your own eclipse is the parent occulting your Sun", () => {
    expect(selectSurfaceTarget(onMoon, lunarEclipse)).toEqual({ kind: 'sun' });
    expect(selectSurfaceTarget(onIo, ioEclipse)).toEqual({ kind: 'sun' });
  });

  it("on the involved moon, your own transit shows your shadow on the parent", () => {
    expect(selectSurfaceTarget(onMoon, solarEclipse)).toEqual({ kind: 'parent' });
    expect(selectSurfaceTarget(onIo, ioTransit)).toEqual({ kind: 'parent' });
  });

  it('on a sibling moon, eclipses point at the involved moon, transits at the parent disc', () => {
    expect(selectSurfaceTarget(onEuropa, ioEclipse)).toEqual({ kind: 'moon', moonName: 'Io' });
    // Pin: a sibling never spot-stands — the spot is on the parent, not under you.
    expect(selectSurfaceTarget(onEuropa, ioTransit)).toEqual({ kind: 'parent' });
  });

  it('no event: companion subject (Earth→Moon, moon→parent, generic planet→Sun)', () => {
    expect(selectSurfaceTarget(onEarth, null)).toEqual({ kind: 'moon', moonName: 'Moon' });
    expect(selectSurfaceTarget(onIo, null)).toEqual({ kind: 'parent' });
    expect(selectSurfaceTarget(onJupiter, null)).toEqual({ kind: 'sun' });
    expect(selectSurfaceTarget({ type: 'planet', name: 'Mercury' }, null)).toEqual({ kind: 'sun' });
  });

  it('a cross-system event falls back to the companion subject', () => {
    const saturnEvent: SurfaceEventInfo = { kind: 'eclipse', parentPlanet: 'Saturn', moonName: 'Titan' };
    expect(selectSurfaceTarget(onIo, saturnEvent)).toEqual({ kind: 'parent' });
    expect(selectSurfaceTarget(onJupiter, saturnEvent)).toEqual({ kind: 'sun' });
  });

  it('never resolves to the landed body itself', () => {
    const landedSpots: SurfaceLandedInfo[] = [onEarth, onMoon, onJupiter, onIo, onEuropa];
    const events: (SurfaceEventInfo | null)[] = [lunarEclipse, solarEclipse, ioEclipse, ioTransit, null];
    for (const landed of landedSpots) {
      for (const event of events) {
        const target = selectSurfaceTarget(landed, event);
        if (target.kind === 'moon') expect(target.moonName).not.toBe(landed.name);
        if (target.kind === 'parent') expect(landed.type).toBe('moon');
      }
    }
  });
});

describe('surface vantage geometry', () => {
  const EARTH_RADIUS_AU = 6371 / KM_PER_AU;

  it('hovers above the sub-target point along the target direction', () => {
    const dir = new THREE.Vector3(3, -4, 12); // deliberately unnormalized
    const out = computeSubTargetVantage(EARTH_RADIUS_AU, dir, new THREE.Vector3());
    expect(out.length()).toBeCloseTo(EARTH_RADIUS_AU + surfaceAltitudeAU(EARTH_RADIUS_AU), 12);
    expect(out.clone().normalize().dot(dir.clone().normalize())).toBeCloseTo(1, 12);
  });

  it('altitude is 2% of the radius, floored at the near-plane clearance', () => {
    // Earth: 2% of 4.26e-5 AU is below the floor — the floor wins.
    expect(surfaceAltitudeAU(EARTH_RADIUS_AU)).toBe(SURFACE_MIN_ALTITUDE_AU);
    // Jupiter-sized: 2% wins.
    const jupiterRadiusAU = 71_492 / KM_PER_AU;
    expect(surfaceAltitudeAU(jupiterRadiusAU)).toBeCloseTo(0.02 * jupiterRadiusAU, 12);
    // Tiny moonlet: floor keeps the camera off the near plane.
    expect(surfaceAltitudeAU(10 / KM_PER_AU)).toBe(SURFACE_MIN_ALTITUDE_AU);
  });

  it('degenerate target direction still produces a valid vantage', () => {
    const out = computeSubTargetVantage(EARTH_RADIUS_AU, new THREE.Vector3(0, 0, 0), new THREE.Vector3());
    expect(out.length()).toBeGreaterThan(EARTH_RADIUS_AU);
  });

  describe('shadow-spot vantage degradation chain', () => {
    const R = 1;

    it('central event: stands at the axis/sphere intersection', () => {
      // Occluder off-axis at (0.5R, 0, 2R), shadow pointing -z: hit on the +z hemisphere.
      const offset = new THREE.Vector3(0.5, 0, 2);
      const axis = new THREE.Vector3(0, 0, -1);
      const t = shadowAxisSphereHitAU(offset, axis, R);
      expect(t).not.toBeNull();
      const surface = shadowAxisSurfacePoint(offset, axis, R, new THREE.Vector3());
      expect(surface.length()).toBeCloseTo(R, 12);
      expect(surface.x).toBeCloseTo(0.5, 12);
      expect(surface.z).toBeCloseTo(Math.sqrt(1 - 0.25), 12);
      const vantage = computeShadowSpotVantage(R, offset, axis, new THREE.Vector3());
      expect(vantage.length()).toBeCloseTo(R + surfaceAltitudeAU(R), 12);
      expect(vantage.clone().normalize().dot(surface.clone().normalize())).toBeCloseTo(1, 12);
    });

    it('partial event (axis misses the disc): stands at the deepest-cover point', () => {
      const offset = new THREE.Vector3(1.5, 0, 2);
      const axis = new THREE.Vector3(0, 0, -1);
      expect(shadowAxisSphereHitAU(offset, axis, R)).toBeNull();
      const surface = shadowAxisSurfacePoint(offset, axis, R, new THREE.Vector3());
      // Closest approach of the ray to the center is (1.5, 0, 0) → surface (1, 0, 0).
      expect(surface.x).toBeCloseTo(1, 12);
      expect(surface.y).toBeCloseTo(0, 12);
      expect(surface.z).toBeCloseTo(0, 12);
    });

    it('shadow receding from the sphere: stands at the sub-occluder point', () => {
      const offset = new THREE.Vector3(0, 0, 2);
      const axis = new THREE.Vector3(0, 0, 1); // anti-sunward points away from the sphere
      expect(shadowAxisSphereHitAU(offset, axis, R)).toBeNull();
      const surface = shadowAxisSurfacePoint(offset, axis, R, new THREE.Vector3());
      expect(surface.x).toBeCloseTo(0, 12);
      expect(surface.z).toBeCloseTo(1, 12);
    });

    it('sphere sunward of the occluder yields no hit (no spot to stand in)', () => {
      // Ray origin outside, sphere behind the ray start along the axis.
      const offset = new THREE.Vector3(0, 0, -2);
      const axis = new THREE.Vector3(0, 0, -1);
      expect(shadowAxisSphereHitAU(offset, axis, R)).toBeNull();
    });
  });
});

describe('surface FOV', () => {
  it('clamps to the [1.5°, 45°] range', () => {
    expect(clampSurfaceFovDeg(0.1)).toBe(1.5);
    expect(clampSurfaceFovDeg(90)).toBe(45);
    expect(clampSurfaceFovDeg(10)).toBe(10);
  });

  it('entry FOV keeps the realistic default for small discs', () => {
    expect(entryFovDeg(0.53)).toBe(SURFACE_FOV_DEFAULT_DEG);
  });

  it('entry FOV widens for big discs so they fill ~60% of frame', () => {
    // Jupiter from Io: ∅ ≈ 19.5° → ~33° view, disc fills ~59%.
    expect(entryFovDeg(19.5)).toBeCloseTo(33.15, 6);
    expect(entryFovDeg(40)).toBe(45); // clamped at the wide end
  });

  it('angular diameters match the real sky', () => {
    // The Moon from Earth: ~0.52° mean.
    const moonDeg = angularDiameterDeg(1737.4 / KM_PER_AU, 384_400 / KM_PER_AU);
    expect(moonDeg).toBeGreaterThan(0.5);
    expect(moonDeg).toBeLessThan(0.54);
    // Jupiter from Io: the feature's best advertisement.
    const jupiterFromIoDeg = angularDiameterDeg(71_492 / KM_PER_AU, 421_700 / KM_PER_AU);
    expect(jupiterFromIoDeg).toBeGreaterThan(19);
    expect(jupiterFromIoDeg).toBeLessThan(20);
    // Inside-the-body degenerate case.
    expect(angularDiameterDeg(2, 1)).toBe(180);
  });
});
