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
  bodyDisplayName,
  clampSurfaceFovDeg,
  computeAnchoredSpotVantage,
  computeShadowSpotVantage,
  computeSpotAnchorLocal,
  computeSubTargetVantage,
  entryFovDeg,
  formatDiscDeg,
  GUIDE_RESOLVABLE_OFF_PX,
  GUIDE_RESOLVABLE_ON_PX,
  isBelowResolutionAtMaxZoom,
  MARKER_BRACKETS_MIN_PX,
  MARKER_PILL_MIN_DISC_FRAC,
  MARKER_PILL_EXIT_DISC_FRAC,
  MARKER_RETICLE_MAX_PX,
  projectedDiscPx,
  resolveGuideVisibility,
  resolveMarkerKind,
  selectSurfaceTarget,
  SURFACE_FOV_DEFAULT_DEG,
  SURFACE_MIN_ALTITUDE_AU,
  SURFACE_TARGET_ELEVATION_DEG,
  makeSurfaceTargetChoice,
  orderSurfaceTargetChoices,
  surfaceAltitudeAU,
  surfaceEventExpectation,
  surfaceEventNarrative,
  surfaceTargetKey,
  transportTrackingUp,
  type SurfaceEventInfo,
  type SurfaceLandedInfo,
  type SurfaceTargetChoice,
} from './surfaceView';
import { findShadowEvent, shadowAxisSphereHitAU, shadowAxisSurfacePoint } from '../astronomy/shadows';
import { computeBodyPositionAU, computeBodyState } from '../astronomy/planetary';
import { computeMoonOffsetEquatorialAU } from '../astronomy/satellites';
import { PLANETARIUM_BODIES } from './planets/planetData';
import { MOONS } from './planets/moonData';
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

describe("surfaceEventExpectation — honest what-you'll-see per kind (brief #28)", () => {
  const phobosEclipse: SurfaceEventInfo = { kind: 'eclipse', parentPlanet: 'Mars', moonName: 'Phobos' };
  const phobosTransit: SurfaceEventInfo = { kind: 'shadow-transit', parentPlanet: 'Mars', moonName: 'Phobos' };
  const onMars: SurfaceLandedInfo = { type: 'planet', name: 'Mars' };
  const onDeimos: SurfaceLandedInfo = { type: 'moon', name: 'Deimos', parentPlanet: 'Mars' };
  const onPhobos: SurfaceLandedInfo = { type: 'moon', name: 'Phobos', parentPlanet: 'Mars' };

  it("the trigger case: a penumbral eclipse watched from the parent admits it's subtle", () => {
    // Alex watched a penumbral Phobos eclipse from Mars and asked "what am I
    // supposed to see" — the honest answer belongs in the UI, not a surprise.
    expect(surfaceEventExpectation(onMars, phobosEclipse, 'penumbral')).toBe(
      'subtle dimming only, easy to miss',
    );
  });

  it('watched eclipses scale with classification; only Earth\'s Moon goes blood-red', () => {
    expect(surfaceEventExpectation(onMars, phobosEclipse, 'total')).toBe('fades to black at totality');
    expect(surfaceEventExpectation(onEarth, lunarEclipse, 'total')).toBe('turns blood-red at totality');
    expect(surfaceEventExpectation(onEarth, lunarEclipse, 'partial')).toBe('partly darkened at peak');
    expect(surfaceEventExpectation(onEuropa, ioEclipse, 'annular')).toBe('dims, never fully dark');
  });

  it('standing in the shadow spot, a transit reads as the solar eclipse seen from there', () => {
    expect(surfaceEventExpectation(onEarth, solarEclipse, 'total')).toBe(
      'the Sun is fully covered at peak',
    );
    expect(surfaceEventExpectation(onEarth, solarEclipse, 'annular')).toBe(
      'a ring of Sun remains around the Moon at peak',
    );
    // Phobos' umbra never reaches Mars — its transits are annular at best.
    expect(surfaceEventExpectation(onMars, phobosTransit, 'annular')).toBe(
      'a ring of Sun remains around Phobos at peak',
    );
    expect(surfaceEventExpectation(onMars, phobosTransit, 'partial')).toBe(
      'the Sun is only partly covered, no darkness',
    );
  });

  it('on the involved moon, hints are personal and follow the geometry', () => {
    expect(surfaceEventExpectation(onMoon, lunarEclipse, 'total')).toBe(
      'the Sun vanishes behind Earth',
    );
    expect(surfaceEventExpectation(onMoon, lunarEclipse, 'penumbral')).toBe('daylight barely dims');
    // Annular immersion means the parent's disc is too small to hide the Sun.
    expect(surfaceEventExpectation(onPhobos, phobosEclipse, 'annular')).toBe(
      'a bright ring of Sun remains around Mars',
    );
    expect(surfaceEventExpectation(onIo, ioTransit, 'total')).toBe('a crisp dark spot on Jupiter');
  });

  it('sibling watchers see the shadow on the disc, scaled to its core', () => {
    expect(surfaceEventExpectation(onDeimos, phobosTransit, 'total')).toBe(
      'a small dark dot crawling across Mars',
    );
    expect(surfaceEventExpectation(onDeimos, phobosTransit, 'partial')).toBe(
      'a pale grazing shadow, barely visible',
    );
  });

  it("classification 'none' yields no hint", () => {
    expect(surfaceEventExpectation(onMars, phobosEclipse, 'none')).toBe('');
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

    it('central event: stands ON the axis at the camera shell', () => {
      // Occluder off-axis at (0.5R, 0, 2R), shadow pointing -z: hit on the +z hemisphere.
      const offset = new THREE.Vector3(0.5, 0, 2);
      const axis = new THREE.Vector3(0, 0, -1);
      const t = shadowAxisSphereHitAU(offset, axis, R);
      expect(t).not.toBeNull();
      const surface = shadowAxisSurfacePoint(offset, axis, R, new THREE.Vector3());
      expect(surface.length()).toBeCloseTo(R, 12);
      expect(surface.x).toBeCloseTo(0.5, 12);
      expect(surface.z).toBeCloseTo(Math.sqrt(1 - 0.25), 12);
      // The vantage sits at the camera's flying shell and ON the shadow axis
      // (zero perpendicular distance to the axis line) — lifting the ground
      // hit radially instead put the observer beside the umbral line and a
      // slanted-axis eclipse never reached totality.
      const vantage = computeShadowSpotVantage(R, offset, axis, new THREE.Vector3());
      expect(vantage.length()).toBeCloseTo(R + surfaceAltitudeAU(R), 12);
      const fromOccluder = vantage.clone().sub(offset);
      const axialDistToAxis = fromOccluder.clone().addScaledVector(axis, -fromOccluder.dot(axis));
      expect(axialDistToAxis.length()).toBeCloseTo(0, 12);
      expect(vantage.x).toBeCloseTo(0.5, 12);
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

  describe('stand-still eclipse anchor (rotating-frame pin)', () => {
    const R = 1;
    const offset = new THREE.Vector3(0.5, 0, 2);
    const axis = new THREE.Vector3(0, 0, -1);

    it('round-trips to the live spot vantage at the pin orientation', () => {
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.83);
      const anchor = computeSpotAnchorLocal(offset, axis, R, q, new THREE.Vector3());
      const vantage = computeAnchoredSpotVantage(R, anchor, q, new THREE.Vector3());
      const live = computeShadowSpotVantage(R, offset, axis, new THREE.Vector3());
      expect(vantage.distanceTo(live)).toBeLessThan(1e-12);
    });

    it('co-rotates with the body: spinning the frame carries the point with the ground', () => {
      const q0 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.4);
      const spin = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 1.1);
      const q1 = spin.clone().multiply(q0);
      const anchor = computeSpotAnchorLocal(offset, axis, R, q0, new THREE.Vector3());
      const v0 = computeAnchoredSpotVantage(R, anchor, q0, new THREE.Vector3());
      const v1 = computeAnchoredSpotVantage(R, anchor, q1, new THREE.Vector3());
      expect(v1.distanceTo(v0.clone().applyQuaternion(spin))).toBeLessThan(1e-12);
      // The point moved with the spin — it is not re-derived from the shadow.
      expect(v1.distanceTo(v0)).toBeGreaterThan(0.5);
    });

    it('keeps the observer altitude of the live vantage', () => {
      const q = new THREE.Quaternion();
      const anchor = computeSpotAnchorLocal(offset, axis, R, q, new THREE.Vector3());
      const vantage = computeAnchoredSpotVantage(R, anchor, q, new THREE.Vector3());
      expect(vantage.length()).toBeCloseTo(R + surfaceAltitudeAU(R), 12);
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

  it('companion entry FOV fits the disc to ~1/4 of the frame, clamped', () => {
    // The Moon from Earth: ∅ ≈ 0.53° → ~2.1° view, disc ~1/4 of the frame.
    expect(entryFovDeg(0.53)).toBeCloseTo(2.12, 9);
    expect(entryFovDeg(0.53, 'companion')).toBeCloseTo(2.12, 9);
    // A looming parent (Jupiter from Io ∅19.5°) clamps at the wide end.
    expect(entryFovDeg(19.5)).toBe(45);
    // A speck clamps at the tightest zoom rather than zooming past it.
    expect(entryFovDeg(0.1)).toBe(1.5);
  });

  it('keeps the Sun at the resting sky FOV as a companion (no glare zoom)', () => {
    // From Mars the Sun is ∅~0.35°; fitting it to ¼ would fill the sky with
    // glare and erase its real size cue, so the companion path holds it wide.
    expect(entryFovDeg(0.35, 'companion', true)).toBe(SURFACE_FOV_DEFAULT_DEG);
    expect(entryFovDeg(1.4, 'companion', true)).toBe(SURFACE_FOV_DEFAULT_DEG); // Sun from Mercury
    // A solar eclipse is the 'event' path — there the framing is the point.
    expect(entryFovDeg(0.35, 'event', true)).toBeCloseTo(2.8, 9);
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
    const h = 1000;
    expect(resolveMarkerKind(MARKER_BRACKETS_MIN_PX + 1, 'reticle', h)).toBe('brackets');
    expect(resolveMarkerKind(MARKER_RETICLE_MAX_PX - 1, 'brackets', h)).toBe('reticle');
    // Between the bounds: sticky.
    const between = (MARKER_RETICLE_MAX_PX + MARKER_BRACKETS_MIN_PX) / 2;
    expect(resolveMarkerKind(between, 'brackets', h)).toBe('brackets');
    expect(resolveMarkerKind(between, 'reticle', h)).toBe('reticle');
  });

  it('brackets hand off to the pill when the disc dominates the frame', () => {
    const h = 1000;
    // Past the ceiling: pill, regardless of prior kind.
    expect(resolveMarkerKind(MARKER_PILL_MIN_DISC_FRAC * h + 1, 'brackets', h)).toBe('pill');
    // Hysteresis band: pill holds, brackets hold.
    const mid = ((MARKER_PILL_MIN_DISC_FRAC + MARKER_PILL_EXIT_DISC_FRAC) / 2) * h;
    expect(resolveMarkerKind(mid, 'pill', h)).toBe('pill');
    expect(resolveMarkerKind(mid, 'brackets', h)).toBe('brackets');
    // Below the exit bound: back to brackets.
    expect(resolveMarkerKind(MARKER_PILL_EXIT_DISC_FRAC * h - 1, 'pill', h)).toBe('brackets');
    // Alex's scene: Earth (2°) from the Moon at min FOV 1.5° on a 1000px
    // viewport → a 1338px disc must not draw a floating locator box.
    expect(resolveMarkerKind((2.007 / 1.5) * h, 'brackets', h)).toBe('pill');
  });

  it('shadow-guide visibility gates with hysteresis below the marker scale', () => {
    expect(GUIDE_RESOLVABLE_OFF_PX).toBeLessThan(GUIDE_RESOLVABLE_ON_PX);
    expect(GUIDE_RESOLVABLE_ON_PX).toBeLessThan(MARKER_BRACKETS_MIN_PX);
    expect(resolveGuideVisibility(GUIDE_RESOLVABLE_ON_PX, false)).toBe(true);
    expect(resolveGuideVisibility(GUIDE_RESOLVABLE_OFF_PX, true)).toBe(false);
    // Between the bounds: sticky both ways.
    const between = (GUIDE_RESOLVABLE_OFF_PX + GUIDE_RESOLVABLE_ON_PX) / 2;
    expect(resolveGuideVisibility(between, true)).toBe(true);
    expect(resolveGuideVisibility(between, false)).toBe(false);
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

describe('Look-at menu choices', () => {
  const moon = (name: string, discDeg: number): SurfaceTargetChoice =>
    makeSurfaceTargetChoice({ kind: 'moon', moonName: name }, name, discDeg);

  it('computes resolvable exactly as the events-list speck rule', () => {
    // 0.5° resolves easily at max zoom; 0.001° never earns brackets.
    expect(makeSurfaceTargetChoice({ kind: 'sun' }, 'the Sun', 0.5).resolvable).toBe(true);
    expect(moon('Kale', 0.001).resolvable).toBe(!isBelowResolutionAtMaxZoom(0.001));
    expect(moon('Kale', 0.001).resolvable).toBe(false);
  });

  it('planet vantage: Sun pinned first, moons by descending apparent size', () => {
    const ordered = orderSurfaceTargetChoices([
      moon('Metis', 0.045),
      moon('Ganymede', 0.29),
      makeSurfaceTargetChoice({ kind: 'sun' }, 'the Sun', 0.1),
      moon('Io', 0.6),
    ]);
    expect(ordered.map((c) => c.name)).toEqual(['the Sun', 'Io', 'Ganymede', 'Metis']);
  });

  it('moon vantage: parent pinned above the Sun, siblings sorted after', () => {
    const ordered = orderSurfaceTargetChoices([
      moon('Europa', 0.31),
      makeSurfaceTargetChoice({ kind: 'sun' }, 'the Sun', 0.1),
      makeSurfaceTargetChoice({ kind: 'parent' }, 'Jupiter', 19.5),
      moon('Ganymede', 0.18),
    ]);
    expect(ordered.map((c) => c.name)).toEqual(['Jupiter', 'the Sun', 'Europa', 'Ganymede']);
  });

  it('equal-size moons keep input order', () => {
    const ordered = orderSurfaceTargetChoices([moon('A', 0.1), moon('B', 0.1), moon('C', 0.1)]);
    expect(ordered.map((c) => c.name)).toEqual(['A', 'B', 'C']);
  });

  it('does not mutate its input', () => {
    const input = [moon('Small', 0.01), moon('Big', 0.5)];
    orderSurfaceTargetChoices(input);
    expect(input.map((c) => c.name)).toEqual(['Small', 'Big']);
  });

  it('keys both sun kinds to the same row identity', () => {
    expect(surfaceTargetKey({ kind: 'sun' })).toBe(
      surfaceTargetKey({ kind: 'sun-from-spot', occluderMoonName: 'Io' }),
    );
    expect(surfaceTargetKey({ kind: 'moon', moonName: 'Io' })).not.toBe(
      surfaceTargetKey({ kind: 'moon', moonName: 'Europa' }),
    );
    expect(surfaceTargetKey({ kind: 'parent' })).toBe('parent');
  });
});

describe('bodyDisplayName', () => {
  it('gives the Moon and the Sun their articles, leaves proper names bare', () => {
    expect(bodyDisplayName('Moon')).toBe('the Moon');
    expect(bodyDisplayName('Sun')).toBe('the Sun');
    expect(bodyDisplayName('Io')).toBe('Io');
    expect(bodyDisplayName('Jupiter')).toBe('Jupiter');
  });
});

describe('anchored solar-eclipse pass — totality regressions', () => {
  // Integrated pin: from the stand-still anchor (derived exactly as the
  // mode's ensureSurfaceSpotAnchor derives it), the observed Sun–Moon
  // separation across the whole event must be a single V — one approach,
  // one minimum at peak, one departure — AND for a total eclipse the
  // minimum must drop below the totality margin (Moon minus Sun angular
  // radius), not merely "get close". The 2026-08-12 pass bottomed out at
  // ~0.05° when the vantage lifted the ground-level axis point radially:
  // on that slanted axis (high gamma) the lift walked the observer
  // hundreds of km off the umbral line and the Sun was never covered. The
  // camera now stands on the axis at its flying shell; both the slanted
  // and the near-vertical geometry must reach real totality. A loose
  // minimum bound (< 0.05°) passed while users watched a permanent
  // crescent — the margin comparison is the honest assert.
  const SUN_RADIUS_AU = 695_700 / KM_PER_AU;
  const MOON_RADIUS_AU = MOONS.find(m => m.name === 'Moon')!.radiusAU;

  const cases: Array<[searchFrom: string, greatest: string, label: string]> = [
    ['2026-07-18T00:00:00Z', '2026-08-12T17:46:00Z', 'slanted axis (2026-08-12)'],
    ['2027-07-15T00:00:00Z', '2027-08-02T10:06:41Z', 'near-central axis (2027-08-02)'],
  ];

  it.each(cases)(
    'a pinned observer reaches totality in one monotonic pass — %s',
    (searchFromUtc, greatestUtc) => {
      const earth = PLANETARIUM_BODIES.find(b => b.name === 'Earth')!;
      const event = findShadowEvent(
        { kind: 'shadow-transit', parentPlanet: 'Earth', moonName: 'Moon' },
        Date.parse(searchFromUtc),
        1,
      );
      expect(event).not.toBeNull();
      const peakMs = event!.peakUtcMs;
      // Published greatest-eclipse instants (EclipseWise).
      expect(Math.abs(peakMs - Date.parse(greatestUtc))).toBeLessThan(10 * 60_000);

      const peakOffset = computeMoonOffsetEquatorialAU('Moon', 'Earth', peakMs, new THREE.Vector3());
      const axis = computeBodyPositionAU(earth, peakMs).add(peakOffset).normalize();
      const anchor = computeSpotAnchorLocal(
        peakOffset,
        axis,
        earth.radiusAU,
        computeBodyState(earth, peakMs).orientationQuaternion,
        new THREE.Vector3(),
      );

      const observerAt = (utcMs: number): THREE.Vector3 =>
        computeAnchoredSpotVantage(
          earth.radiusAU,
          anchor,
          computeBodyState(earth, utcMs).orientationQuaternion,
          new THREE.Vector3(),
        ).add(computeBodyPositionAU(earth, utcMs));

      const separationDeg = (utcMs: number): number => {
        const observer = observerAt(utcMs);
        const sunDir = observer.clone().multiplyScalar(-1).normalize();
        const moonDir = computeMoonOffsetEquatorialAU('Moon', 'Earth', utcMs, new THREE.Vector3())
          .add(computeBodyPositionAU(earth, utcMs))
          .sub(observer)
          .normalize();
        return Math.acos(THREE.MathUtils.clamp(sunDir.dot(moonDir), -1, 1)) * RAD2DEG;
      };

      const stepMs = 120_000;
      const spanSteps = 75; // peak ± 150 min at 2-min samples
      const seps: number[] = [];
      for (let i = -spanSteps; i <= spanSteps; i++) seps.push(separationDeg(peakMs + i * stepMs));

      let minIdx = 0;
      for (let i = 1; i < seps.length; i++) if (seps[i] < seps[minIdx]) minIdx = i;

      // Deep central alignment at (within a few minutes of) the pin instant.
      expect(Math.abs(minIdx - spanSteps) * stepMs).toBeLessThanOrEqual(6 * 60_000);

      // Totality margin from the model's own geometry at peak: the Moon's
      // angular radius must exceed the Sun's (total, not annular, in-model)
      // and the observed minimum must sit decisively inside that margin —
      // the Sun fully covered, not grazed.
      const obs = observerAt(peakMs);
      const sunDistAU = obs.length();
      const moonDistAU = computeMoonOffsetEquatorialAU('Moon', 'Earth', peakMs, new THREE.Vector3())
        .add(computeBodyPositionAU(earth, peakMs))
        .sub(obs)
        .length();
      const marginDeg =
        (Math.asin(MOON_RADIUS_AU / moonDistAU) - Math.asin(SUN_RADIUS_AU / sunDistAU)) * RAD2DEG;
      expect(marginDeg).toBeGreaterThan(0);
      expect(seps[minIdx]).toBeLessThan(marginDeg * 0.5);

      // One pass: falls into the minimum, rises out, never dips again.
      const eps = 1e-4;
      for (let i = 1; i <= minIdx; i++) expect(seps[i]).toBeLessThan(seps[i - 1] + eps);
      for (let i = minIdx + 1; i < seps.length; i++) expect(seps[i]).toBeGreaterThan(seps[i - 1] - eps);
      // Clean entry and exit: well separated at both window edges.
      expect(seps[0]).toBeGreaterThan(0.5);
      expect(seps[seps.length - 1]).toBeGreaterThan(0.5);
    },
  );
});
