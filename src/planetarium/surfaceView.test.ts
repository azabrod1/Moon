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
  formatDiscDeg,
  isBelowResolutionAtMaxZoom,
  MARKER_BRACKETS_MIN_PX,
  MARKER_RETICLE_MAX_PX,
  projectedDiscPx,
  resolveMarkerKind,
  selectSurfaceTarget,
  SURFACE_FOV_DEFAULT_DEG,
  SURFACE_MIN_ALTITUDE_AU,
  SURFACE_TARGET_ELEVATION_DEG,
  surfaceAltitudeAU,
  surfaceEventNarrative,
  transportTrackingUp,
  type SurfaceEventInfo,
  type SurfaceLandedInfo,
} from './surfaceView';
import { shadowAxisSphereHitAU, shadowAxisSurfacePoint } from '../astronomy/shadows';
import { KM_PER_AU } from '../astronomy/constants';
import { RAD2DEG, DEG2RAD } from '../shared/math/angles';

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

describe('surfaceEventNarrative — observer/event relationship, not camera target', () => {
  const phobosTransit: SurfaceEventInfo = {
    kind: 'shadow-transit',
    parentPlanet: 'Mars',
    moonName: 'Phobos',
  };
  const onMars: SurfaceLandedInfo = { type: 'planet', name: 'Mars' };
  const onDeimos: SurfaceLandedInfo = { type: 'moon', name: 'Deimos', parentPlanet: 'Mars' };
  const onPhobos: SurfaceLandedInfo = { type: 'moon', name: 'Phobos', parentPlanet: 'Mars' };

  it('on the parent, a transit reads as the solar eclipse it is', () => {
    // The vantage-swap regression (Deimos → swap to Mars during a Phobos
    // transit) showed "Phobos is in Mars's shadow" — the eclipse sentence,
    // geometrically the OPPOSITE of a transit. The sentence must follow the
    // observer/event relationship even when the camera points elsewhere.
    expect(surfaceEventNarrative(onMars, phobosTransit)).toBe('Phobos is crossing the Sun');
    expect(surfaceEventNarrative(onEarth, solarEclipse)).toBe('The Moon is crossing the Sun');
  });

  it('on the involved moon, events are personal: your Sun, your shadow', () => {
    expect(surfaceEventNarrative(onMoon, lunarEclipse)).toBe('Earth is covering the Sun');
    expect(surfaceEventNarrative(onPhobos, phobosTransit)).toBe('Your shadow is crossing Mars');
    expect(surfaceEventNarrative(onIo, ioTransit)).toBe('Your shadow is crossing Jupiter');
  });

  it('from a sibling (or any third vantage), events read in the third person', () => {
    expect(surfaceEventNarrative(onDeimos, phobosTransit)).toBe(
      "Phobos's shadow is crossing Mars",
    );
    expect(surfaceEventNarrative(onEuropa, ioEclipse)).toBe("Io is in Jupiter's shadow");
    expect(surfaceEventNarrative(onMars, { kind: 'eclipse', parentPlanet: 'Mars', moonName: 'Deimos' }))
      .toBe("Deimos is in Mars's shadow");
  });

  it("Earth's Moon keeps its article", () => {
    expect(surfaceEventNarrative(onEarth, lunarEclipse)).toBe("The Moon is in Earth's shadow");
  });
});

describe('surface vantage geometry', () => {
  const EARTH_RADIUS_AU = 6371 / KM_PER_AU;

  const POLE = new THREE.Vector3(0, 1, 0);

  it('elevation 90° reproduces the legacy sub-target hover', () => {
    const dir = new THREE.Vector3(3, -4, 12); // deliberately unnormalized
    const out = computeSubTargetVantage(EARTH_RADIUS_AU, dir, POLE, 90, new THREE.Vector3());
    expect(out.length()).toBeCloseTo(EARTH_RADIUS_AU + surfaceAltitudeAU(EARTH_RADIUS_AU), 12);
    expect(out.clone().normalize().dot(dir.clone().normalize())).toBeCloseTo(1, 12);
  });

  it('default elevation: the zenith angle to the target direction is 90° − 68°', () => {
    const dir = new THREE.Vector3(1, 0.2, -0.5).normalize();
    const out = computeSubTargetVantage(
      EARTH_RADIUS_AU, dir, POLE, SURFACE_TARGET_ELEVATION_DEG, new THREE.Vector3(),
    );
    const up = out.clone().normalize();
    const zenithAngleDeg = Math.acos(THREE.MathUtils.clamp(up.dot(dir), -1, 1)) * RAD2DEG;
    expect(zenithAngleDeg).toBeCloseTo(90 - SURFACE_TARGET_ELEVATION_DEG, 9);
    expect(out.length()).toBeCloseTo(EARTH_RADIUS_AU + surfaceAltitudeAU(EARTH_RADIUS_AU), 12);
  });

  it('observer is displaced toward the pole — the target culminates toward local south', () => {
    const dir = new THREE.Vector3(1, 0, 0); // equatorial target, pole = +y
    const out = computeSubTargetVantage(
      EARTH_RADIUS_AU, dir, POLE, SURFACE_TARGET_ELEVATION_DEG, new THREE.Vector3(),
    );
    expect(out.y).toBeGreaterThan(0);
  });

  it('finite-distance elevation stays ~68° for real geometry (Saturn from Titan)', () => {
    const titanRadiusAU = 2_574 / KM_PER_AU;
    const target = new THREE.Vector3(1_221_870 / KM_PER_AU, 0, 0);
    const out = computeSubTargetVantage(
      titanRadiusAU, target, POLE, SURFACE_TARGET_ELEVATION_DEG, new THREE.Vector3(),
    );
    const toTarget = target.clone().sub(out).normalize();
    const up = out.clone().normalize();
    const elevationDeg = 90 - Math.acos(THREE.MathUtils.clamp(up.dot(toTarget), -1, 1)) * RAD2DEG;
    // Parallax across Titan's radius costs well under a tenth of a degree.
    expect(Math.abs(elevationDeg - SURFACE_TARGET_ELEVATION_DEG)).toBeLessThan(0.2);
  });

  it('close-in targets sit lower than nominal but never below the horizon (Metis from Jupiter)', () => {
    // The observer stands a body radius off-center; for a target orbiting at
    // 1.79 body radii the true elevation degrades from the nominal 68°.
    const jupiterRadiusAU = 71_492 / KM_PER_AU;
    const target = new THREE.Vector3(128_000 / KM_PER_AU, 0, 0);
    const out = computeSubTargetVantage(
      jupiterRadiusAU, target, POLE, SURFACE_TARGET_ELEVATION_DEG, new THREE.Vector3(),
    );
    const toTarget = target.clone().sub(out).normalize();
    const up = out.clone().normalize();
    const elevationDeg = 90 - Math.acos(THREE.MathUtils.clamp(up.dot(toTarget), -1, 1)) * RAD2DEG;
    expect(elevationDeg).toBeGreaterThan(35);
    expect(elevationDeg).toBeLessThan(SURFACE_TARGET_ELEVATION_DEG);
  });

  it('formatDiscDeg floors at "<0.01" and switches precision at 1°', () => {
    expect(formatDiscDeg(0.004)).toBe('<0.01');
    expect(formatDiscDeg(0.005)).toBe('0.01');
    expect(formatDiscDeg(0.31)).toBe('0.31');
    expect(formatDiscDeg(0.999)).toBe('1.00');
    expect(formatDiscDeg(5.71)).toBe('5.7');
  });

  it('a target drifting through the pole-degeneracy band moves the vantage continuously', () => {
    // Sweep the target from 0.05° to 30° off the pole (through the blend
    // band) in 0.1°-ish steps; consecutive vantage points must never jump.
    let prev: THREE.Vector3 | null = null;
    let maxStepDeg = 0;
    for (let i = 0; i <= 300; i++) {
      const offDeg = 0.05 + (29.95 * i) / 300;
      const t = new THREE.Vector3(Math.sin(offDeg * DEG2RAD), Math.cos(offDeg * DEG2RAD), 0);
      const u = computeSubTargetVantage(
        EARTH_RADIUS_AU, t, POLE, SURFACE_TARGET_ELEVATION_DEG, new THREE.Vector3(),
      ).normalize();
      if (prev) {
        const stepDeg = Math.acos(THREE.MathUtils.clamp(prev.dot(u), -1, 1)) * RAD2DEG;
        maxStepDeg = Math.max(maxStepDeg, stepDeg);
      }
      prev = u;
    }
    expect(maxStepDeg).toBeLessThan(2);
  });

  it('a target circling the pole inside the band crosses axis ties without a jump', () => {
    // The hard path: 2° off the pole (deep inside the blend band), azimuth
    // sweeping a full circle — the target's two near-zero components cross
    // each other repeatedly. A fallback axis picked against the *target*
    // flips ~90° at each crossing; picked against the constant pole it
    // cannot. Per-step vantage motion must stay proportional to the sweep.
    const offRad = 2 * DEG2RAD;
    let prev: THREE.Vector3 | null = null;
    let maxStepDeg = 0;
    for (let i = 0; i <= 360; i++) {
      const phi = i * DEG2RAD;
      const t = new THREE.Vector3(
        Math.sin(offRad) * Math.cos(phi),
        Math.cos(offRad),
        Math.sin(offRad) * Math.sin(phi),
      );
      const u = computeSubTargetVantage(
        EARTH_RADIUS_AU, t, POLE, SURFACE_TARGET_ELEVATION_DEG, new THREE.Vector3(),
      ).normalize();
      if (prev) {
        const stepDeg = Math.acos(THREE.MathUtils.clamp(prev.dot(u), -1, 1)) * RAD2DEG;
        maxStepDeg = Math.max(maxStepDeg, stepDeg);
      }
      prev = u;
    }
    expect(maxStepDeg).toBeLessThan(2);
  });

  it('target along the pole still yields a valid tilted vantage', () => {
    const out = computeSubTargetVantage(
      EARTH_RADIUS_AU, POLE.clone(), POLE, SURFACE_TARGET_ELEVATION_DEG, new THREE.Vector3(),
    );
    const zenithAngleDeg =
      Math.acos(THREE.MathUtils.clamp(out.clone().normalize().dot(POLE), -1, 1)) * RAD2DEG;
    expect(zenithAngleDeg).toBeCloseTo(90 - SURFACE_TARGET_ELEVATION_DEG, 6);
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
    const out = computeSubTargetVantage(
      EARTH_RADIUS_AU, new THREE.Vector3(0, 0, 0), POLE, SURFACE_TARGET_ELEVATION_DEG, new THREE.Vector3(),
    );
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

describe('transportTrackingUp — tracking-camera up at a zenith target', () => {
  // Both vantage builders put the target at the observer's zenith, so the
  // naive zenith-up is parallel to the look direction and lookAt's basis is
  // degenerate (this was the empty-sky-on-entry bug: orientation noise up to
  // ~20° off-target). These pin the transported up's contract.

  it('returns a unit vector perpendicular to forward', () => {
    const forward = new THREE.Vector3(0.3, -0.8, 0.52).normalize();
    const up = transportTrackingUp(new THREE.Vector3(0, 1, 0), forward);
    expect(up.length()).toBeCloseTo(1, 12);
    expect(up.dot(forward)).toBeCloseTo(0, 12);
  });

  it('is continuous: a small forward change barely moves the up', () => {
    const up = new THREE.Vector3(0, 1, 0);
    const f1 = new THREE.Vector3(1, 0.001, 0).normalize();
    transportTrackingUp(up, f1);
    const before = up.clone();
    const f2 = new THREE.Vector3(1, 0.002, 0.001).normalize();
    transportTrackingUp(up, f2);
    expect(up.angleTo(before)).toBeLessThan(0.01);
  });

  it('recovers a valid basis from a seed parallel to forward (the old degenerate case)', () => {
    const forward = new THREE.Vector3(0, 1, 0);
    const up = transportTrackingUp(new THREE.Vector3(0, 1, 0), forward);
    expect(up.length()).toBeCloseTo(1, 12);
    expect(Math.abs(up.dot(forward))).toBeLessThan(1e-9);
  });

  it('recovers along any axis-aligned forward (fallback picks a non-parallel world axis)', () => {
    for (const axis of [
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(-1, 0, 0),
      new THREE.Vector3(0.577, 0.577, 0.577).normalize(),
    ]) {
      const up = transportTrackingUp(axis.clone(), axis);
      expect(up.length()).toBeCloseTo(1, 9);
      expect(Math.abs(up.dot(axis))).toBeLessThan(1e-9);
    }
  });

  it('keeps the up stable across many frames of a slowly moving target', () => {
    // Simulate ~10 minutes of a tracked target drifting across the sky.
    const up = new THREE.Vector3(0, 1, 0);
    let prev: THREE.Vector3 | null = null;
    for (let i = 0; i <= 600; i++) {
      const theta = 0.4 + i * 0.0005;
      const forward = new THREE.Vector3(
        Math.cos(theta),
        Math.sin(theta),
        0.2 * Math.sin(theta * 3),
      ).normalize();
      transportTrackingUp(up, forward);
      expect(Math.abs(up.dot(forward))).toBeLessThan(1e-9);
      if (prev) expect(up.angleTo(prev)).toBeLessThan(0.01); // no frame-to-frame roll jumps
      prev = up.clone();
    }
  });
});

describe('surface FOV', () => {
  it('clamps to the [1.5°, 45°] range', () => {
    expect(clampSurfaceFovDeg(0.1)).toBe(1.5);
    expect(clampSurfaceFovDeg(90)).toBe(45);
    expect(clampSurfaceFovDeg(10)).toBe(10);
  });

  it('companion entry FOV keeps the realistic default for small discs', () => {
    expect(entryFovDeg(0.53)).toBe(SURFACE_FOV_DEFAULT_DEG);
    expect(entryFovDeg(0.53, 'companion')).toBe(SURFACE_FOV_DEFAULT_DEG);
  });

  it('companion entry FOV widens for big discs so they fill ~60% of frame', () => {
    // Jupiter from Io: ∅ ≈ 19.5° → ~33° view, disc fills ~59%.
    expect(entryFovDeg(19.5)).toBeCloseTo(33.15, 6);
    expect(entryFovDeg(40)).toBe(45); // clamped at the wide end
  });

  it('event entry FOV frames the event at ~8× the disc, clamped to the zoom range', () => {
    // Solar eclipse from Mars: Sun ∅ ≈ 0.35° → 2.8° view (~1/8 of frame).
    expect(entryFovDeg(0.35, 'event')).toBeCloseTo(2.8, 9);
    // Speck targets clamp at the tightest zoom rather than zooming past it.
    expect(entryFovDeg(0.04, 'event')).toBe(1.5);
    // Big discs clamp at the wide end.
    expect(entryFovDeg(19.5, 'event')).toBe(45);
  });

  it('marker kind swaps with hysteresis on the projected disc size', () => {
    expect(resolveMarkerKind(MARKER_BRACKETS_MIN_PX + 1, 'reticle')).toBe('brackets');
    expect(resolveMarkerKind(MARKER_RETICLE_MAX_PX - 1, 'brackets')).toBe('reticle');
    // Between the bounds: sticky.
    const between = (MARKER_RETICLE_MAX_PX + MARKER_BRACKETS_MIN_PX) / 2;
    expect(resolveMarkerKind(between, 'brackets')).toBe('brackets');
    expect(resolveMarkerKind(between, 'reticle')).toBe('reticle');
  });

  it('projected disc px and the static list speck flag agree with the optics', () => {
    // Jupiter from Io at 10° FOV on a 900px canvas: enormous.
    expect(projectedDiscPx(19.5, 10, 900)).toBeCloseTo(1755, 0);
    // Metis from Europa (∅ ≈ 0.005°) can never resolve: speck.
    expect(isBelowResolutionAtMaxZoom(0.005)).toBe(true);
    // Io from Europa (∅ ≈ 0.3°+) resolves easily at max zoom.
    expect(isBelowResolutionAtMaxZoom(0.3)).toBe(false);
    // One resolvability meaning everywhere: the list's ● promise must match
    // the HUD's bracket threshold, or a "shows a disc" row turns into a
    // "below resolution at any zoom" reticle after its own jump. The
    // boundary is MARKER_BRACKETS_MIN_PX at max zoom on the nominal canvas
    // (14px · 1.5° / 800px ≈ 0.026°).
    expect(isBelowResolutionAtMaxZoom(0.02)).toBe(true);
    expect(isBelowResolutionAtMaxZoom(0.03)).toBe(false);
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
