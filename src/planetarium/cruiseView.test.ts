import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { ATMOSPHERE_SHELL_SCALES } from './PlanetFactory';
import { createVoyagerModel } from './ship/models/voyager';
import { createCassiniModel } from './ship/models/cassini';
import { createNewHorizonsModel } from './ship/models/newHorizons';
import { createJunoModel } from './ship/models/juno';
import {
  SHIP_RIG_SCALE,
  SHIP_REFERENCE_RADIUS_AU,
  SHIP_CLEARANCE_AU,
  CRUISE_CAM_DIST_AU,
  SHIP_OCCLUDER_RADIUS_AU,
  CRUISE_CONTROLS_MIN_DISTANCE_AU,
  SHIP_HULL_MAX_EXTENT_AU,
  SHIP_ANY_HULL_EXTENT_AU,
  CAMERA_BODY_MARGIN_AU,
  CRUISE_NEAR_MIN_AU,
  CRUISE_NEAR_MAX_AU,
  planetEnvelopeRadiusAU,
  cruiseCameraNearAU,
  ringAnnulusDistanceAU,
  escapeCameraPenetrations,
  nearestShellSurfaceDistanceAU,
  CAM_FOLLOW_TAU_IDLE_S,
  CAM_FOLLOW_TAU_TURN_S,
  CAM_FOLLOW_TURN_BLEND_S,
  cameraFollowGain,
  CHASE_CAM_LIFT_FRAC,
  chaseIdealOffset,
  reacquireCameraStep,
  CAM_REACQUIRE_RADIUS_TAU_S,
  CAM_REACQUIRE_SETTLE_ANGLE_DEG,
  CAM_REACQUIRE_SETTLE_RADIUS_FRAC,
  largestDiscAngles,
  chaseIdealBoomAU,
  intendedBoomAfterOrbitUpdate,
  ORBIT_DOLLY_DEADBAND,
} from './cruiseView';
// cruiseView itself stays dependency-free (the up axis is passed in); the
// test pins it against the REAL flight horizon the mode hands it.
import { FLIGHT_UP_SCENE, flightDirectionFromAngles } from './flightFrame';
import { DEG2RAD } from '../shared/math/angles';
import { lensProximityFactor } from '../shared/math/lensProximity';

const KM_PER_AU = 149_597_870.7;
const KM = 1 / KM_PER_AU;

describe('cruise rig derivation chain', () => {
  // Every rig quantity must derive from the one scaled base — a constant that
  // silently reverts to an unscaled literal is exactly the bug class the
  // chain exists to prevent.
  it('derives every pad and distance from the scaled reference radius', () => {
    expect(SHIP_REFERENCE_RADIUS_AU).toBe((1_737.4 / KM_PER_AU) * SHIP_RIG_SCALE);
    expect(SHIP_CLEARANCE_AU).toBe(SHIP_REFERENCE_RADIUS_AU * 1.5);
    expect(SHIP_OCCLUDER_RADIUS_AU).toBe(SHIP_REFERENCE_RADIUS_AU * 0.75);
    expect(SHIP_HULL_MAX_EXTENT_AU).toBe(SHIP_REFERENCE_RADIUS_AU * 2.2);
    expect(CAMERA_BODY_MARGIN_AU).toBe(SHIP_REFERENCE_RADIUS_AU * 2.5);
  });

  it('keeps the legacy literals riding the same scale (on-screen ship size unchanged)', () => {
    expect(CRUISE_CAM_DIST_AU).toBe(0.000094 * SHIP_RIG_SCALE);
  });

  it('keeps the wheel-zoom floor outside the hull (full wheel-in may never enter the fins)', () => {
    expect(CRUISE_CONTROLS_MIN_DISTANCE_AU).toBe(SHIP_HULL_MAX_EXTENT_AU * 1.5);
    expect(CRUISE_CONTROLS_MIN_DISTANCE_AU).toBeGreaterThan(SHIP_HULL_MAX_EXTENT_AU);
    // And it still sits well inside the chase distance — wheel-in remains a
    // real close-up, not a no-op.
    expect(CRUISE_CONTROLS_MIN_DISTANCE_AU).toBeLessThan(CRUISE_CAM_DIST_AU * 0.5);
  });

  it('keeps the camera margin outside the hull extent (a clamped camera can stack on the ship radial)', () => {
    expect(CAMERA_BODY_MARGIN_AU).toBeGreaterThan(SHIP_HULL_MAX_EXTENT_AU);
  });

  it('covers the default hull: nozzle exit 1.82 units × 1.8 per radius × 0.5 group scale', () => {
    expect(SHIP_HULL_MAX_EXTENT_AU).toBeGreaterThan(SHIP_REFERENCE_RADIUS_AU * 1.82 * 1.8 * 0.5);
  });

  it('the any-hull sphere contains every built probe model (the marker-vs-hull pre-reject bound)', () => {
    // Measured from the real geometry, not the authored numbers: build each
    // procedural profile, take the farthest bounding-sphere edge from the
    // group origin, apply the 0.5 PlayerShip group scale. Sphere.applyMatrix4
    // over-estimates under non-uniform scale, which is the safe direction for
    // an upper-bound pin. A future profile with a longer boom fails here
    // instead of drawing beacons across its hull. (The default hull needs a
    // DOM for its canvas panel skin — its 1.638-radius nozzle pin above
    // covers it; the Cassini GLB is normalized to a target dimension on load,
    // so the procedural fallback is the wider of the two.)
    const extentAU = (model: THREE.Object3D): number => {
      model.updateMatrixWorld(true);
      let max = 0;
      const sphere = new THREE.Sphere();
      model.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
        sphere.copy(mesh.geometry.boundingSphere!).applyMatrix4(mesh.matrixWorld);
        max = Math.max(max, sphere.center.length() + sphere.radius);
      });
      return max * 0.5;
    };
    const models = {
      voyager: createVoyagerModel(SHIP_REFERENCE_RADIUS_AU),
      cassini: createCassiniModel(SHIP_REFERENCE_RADIUS_AU),
      newHorizons: createNewHorizonsModel(SHIP_REFERENCE_RADIUS_AU),
      juno: createJunoModel(SHIP_REFERENCE_RADIUS_AU),
    };
    for (const [name, model] of Object.entries(models)) {
      expect(extentAU(model), name).toBeLessThan(SHIP_ANY_HULL_EXTENT_AU);
    }
    // Juno's magnetometer boom is why this constant exists apart from
    // SHIP_HULL_MAX_EXTENT_AU: it genuinely outreaches the camera-safety
    // extent (accepted there — see the constants' comments).
    expect(extentAU(models.juno)).toBeGreaterThan(SHIP_HULL_MAX_EXTENT_AU);
    expect(SHIP_ANY_HULL_EXTENT_AU).toBeGreaterThan(SHIP_HULL_MAX_EXTENT_AU);
  });

  it('keeps the near ceiling under the chase-distance camera-to-hull gap', () => {
    // At the default chase distance even the near CEILING cannot reach the
    // hull (wheel-in past the hull is the preserved legacy quirk; there the
    // live ship term takes over and drives near to the floor).
    const chaseGap = CRUISE_CAM_DIST_AU - SHIP_HULL_MAX_EXTENT_AU;
    expect(CRUISE_NEAR_MAX_AU).toBeLessThan(chaseGap);
  });
});

describe('planetEnvelopeRadiusAU', () => {
  const JUPITER = 71_492 * KM;

  it('uses the atmosphere shell where it is the outermost surface', () => {
    // Jupiter's 1.015R shell is ~1,072 km thick — parking inside it puts the
    // camera inside a full-alpha BackSide mesh.
    expect(planetEnvelopeRadiusAU(JUPITER, 1, 1.015)).toBeCloseTo(JUPITER * 1.015, 12);
  });

  it('uses the solid ball when there is no shell', () => {
    expect(planetEnvelopeRadiusAU(JUPITER, 1)).toBe(JUPITER);
  });

  it('lets an inflated render scale win over a thin shell', () => {
    expect(planetEnvelopeRadiusAU(JUPITER, 1.05, 1.015)).toBeCloseTo(JUPITER * 1.05, 12);
  });

  it('never shrinks below the catalog radius', () => {
    expect(planetEnvelopeRadiusAU(JUPITER, 0.5)).toBe(JUPITER);
  });

  it('pins Venus: the thickest shell grows the collision shell ~2.5%', () => {
    // Venus's 1.025 cloud-deck shell is the thickest of the five, and at the
    // shrunken clearance the growth is scale-dominated: the collision envelope
    // tracks the shell scale, not a fixed pad.
    const VENUS = 6_052 * KM;
    const solid = VENUS + SHIP_CLEARANCE_AU;
    const envelope = planetEnvelopeRadiusAU(VENUS, 1, ATMOSPHERE_SHELL_SCALES.Venus) + SHIP_CLEARANCE_AU;
    expect(envelope / solid - 1).toBeGreaterThan(0.02);
    expect(envelope / solid - 1).toBeLessThan(0.03);
  });
});

describe('cruiseCameraNearAU', () => {
  it('sits at 30% of the surface distance when the surface is tightest', () => {
    // Tighter than the chase-distance ship gap (camDist − hull ≈ 160 km),
    // so the surface term binds.
    const surface = 100 * KM;
    const ship = CRUISE_CAM_DIST_AU;
    expect(cruiseCameraNearAU(surface, ship)).toBeCloseTo(0.3 * surface, 12);
  });

  it('yields to the ship term when the camera wheels in close', () => {
    const ship = SHIP_HULL_MAX_EXTENT_AU * 1.5;
    const near = cruiseCameraNearAU(Infinity, ship);
    expect(near).toBeCloseTo(0.3 * (ship - SHIP_HULL_MAX_EXTENT_AU), 12);
  });

  it('collapses toward the floor on a ring-plane crossing', () => {
    expect(cruiseCameraNearAU(Infinity, CRUISE_CAM_DIST_AU, 0)).toBe(CRUISE_NEAR_MIN_AU);
  });

  it('caps at the static-equivalent ceiling when zoomed far out', () => {
    // Wheel-out grows the camera-to-ship gap until the ceiling binds (at the
    // default chase distance the ship term holds near at ~96 km instead).
    expect(cruiseCameraNearAU(Infinity, 1e-5)).toBe(CRUISE_NEAR_MAX_AU);
  });

  it('never goes below the depth-precision floor', () => {
    expect(cruiseCameraNearAU(0, 0)).toBe(CRUISE_NEAR_MIN_AU);
  });

  it('holds a steady mid-range value at the parked wall (no clamp in play)', () => {
    // Parked at max approach: surface ≈ clearance + camDist, ship = camDist.
    const surface = SHIP_CLEARANCE_AU + CRUISE_CAM_DIST_AU;
    const near = cruiseCameraNearAU(surface, CRUISE_CAM_DIST_AU);
    expect(near).toBeGreaterThan(CRUISE_NEAR_MIN_AU);
    expect(near).toBeLessThan(CRUISE_NEAR_MAX_AU);
  });
});

describe('ringAnnulusDistanceAU', () => {
  // Saturn-ish annulus in AU: inner 1.24R, outer 2.27R.
  const R = 60_268 * KM;
  const INNER = 1.24 * R;
  const OUTER = 2.27 * R;

  it('is zero on the annulus itself', () => {
    expect(ringAnnulusDistanceAU(1.7 * R, 0, INNER, OUTER)).toBe(0);
  });

  it('is the height when hovering over the annulus', () => {
    expect(ringAnnulusDistanceAU(1.7 * R, 300 * KM, INNER, OUTER)).toBeCloseTo(300 * KM, 12);
  });

  it('measures to the inner edge from the ring gap', () => {
    expect(ringAnnulusDistanceAU(INNER - 500 * KM, 0, INNER, OUTER)).toBeCloseTo(500 * KM, 12);
  });

  it('measures diagonally to the outer edge from outside and above', () => {
    const d = ringAnnulusDistanceAU(OUTER + 300 * KM, 400 * KM, INNER, OUTER);
    expect(d).toBeCloseTo(500 * KM, 12);
  });

  it('is symmetric across the ring plane', () => {
    const above = ringAnnulusDistanceAU(1.5 * R, 250 * KM, INNER, OUTER);
    const below = ringAnnulusDistanceAU(1.5 * R, -250 * KM, INNER, OUTER);
    expect(above).toBe(below);
  });
});

describe('escapeCameraPenetrations', () => {
  const MARGIN = CAMERA_BODY_MARGIN_AU;
  const MOON_SURFACE = 1_737.4 * KM;
  const shell = (x: number, y: number, z: number, surfaceRadiusAU: number) =>
    ({ x, y, z, surfaceRadiusAU, discRadiusAU: surfaceRadiusAU, name: 'body' });
  const clearOf = (cam: { x: number; y: number; z: number }, s: ReturnType<typeof shell>) =>
    Math.hypot(cam.x - s.x, cam.y - s.y, cam.z - s.z) >= s.surfaceRadiusAU + MARGIN - 1e-15;

  it('leaves a clear camera untouched', () => {
    const shells = [shell(0, 0, 0, MOON_SURFACE)];
    const cam = { x: MOON_SURFACE + MARGIN * 2, y: 0, z: 0 };
    expect(escapeCameraPenetrations(cam, shells, 1, MARGIN)).toBeNull();
  });

  it('pushes a single-body penetration radially to the padded shell', () => {
    const shells = [shell(0, 0, 0, MOON_SURFACE)];
    const cam = { x: MOON_SURFACE * 0.3, y: MOON_SURFACE * 0.4, z: 0 };
    const out = escapeCameraPenetrations(cam, shells, 1, MARGIN)!;
    expect(Math.hypot(out.x, out.y, out.z)).toBeCloseTo(MOON_SURFACE + MARGIN, 12);
    expect(out.y / out.x).toBeCloseTo(0.4 / 0.3, 6); // same radial, just farther out
    expect(out.z).toBeCloseTo(0, 12);
  });

  it('escapes a dead-center camera along +X instead of dividing by zero', () => {
    const out = escapeCameraPenetrations({ x: 0, y: 0, z: 0 }, [shell(0, 0, 0, MOON_SURFACE)], 1, MARGIN)!;
    expect(out.x).toBeCloseTo(MOON_SURFACE + MARGIN, 12);
  });

  it('clears an overlapping co-orbital pair in the one step', () => {
    // Pan/Atlas: both floored to 5% of Saturn (3,013 km) while orbiting
    // 4,086 km apart — the padded shells genuinely overlap at conjunction.
    const R = 3_013.4 * KM;
    const shells = [shell(0, 0, 0, R), shell(4_086 * KM, 0, 0, R)];
    const cam = { x: 2_000 * KM, y: 100 * KM, z: 0 };
    const out = escapeCameraPenetrations(cam, shells, 2, MARGIN)!;
    expect(clearOf(out, shells[0])).toBe(true);
    expect(clearOf(out, shells[1])).toBe(true);
  });

  it('clears a triple conjunction in the one step (sequential pushes cannot promise this)', () => {
    // Pan–Atlas–Prometheus really do conjunct (SAT415, 1993-10-06) with
    // center separations of a few thousand km while all three render at
    // Saturn's floor — three mutually overlapping ~3,150 km shells.
    const R = 3_013.4 * KM;
    const shells = [
      shell(0, 0, 0, R),
      shell(4_086 * KM, 900 * KM, 0, R),
      shell(2_100 * KM, -2_300 * KM, 800 * KM, R),
    ];
    const cam = { x: 1_900 * KM, y: -400 * KM, z: 300 * KM }; // inside all three
    for (const s of shells) expect(clearOf(cam, s)).toBe(false);
    const out = escapeCameraPenetrations(cam, shells, 3, MARGIN)!;
    for (const s of shells) expect(clearOf(out, s)).toBe(true);
  });

  it('ignores shells beyond the pooled count', () => {
    const shells = [shell(0, 0, 0, MOON_SURFACE), shell(0, 0, 0, MOON_SURFACE * 10)];
    const cam = { x: MOON_SURFACE * 2, y: 0, z: 0 };
    expect(escapeCameraPenetrations(cam, shells, 1, MARGIN)).toBeNull();
  });
});

describe('nearestShellSurfaceDistanceAU', () => {
  it('reports the tightest surface distance across the set', () => {
    const shells = [
      { x: 0, y: 0, z: 0, surfaceRadiusAU: 1_737.4 * KM, discRadiusAU: 1_737.4 * KM, name: 'Moon' },
      { x: 10_000 * KM, y: 0, z: 0, surfaceRadiusAU: 3_000 * KM, discRadiusAU: 3_000 * KM, name: 'other' },
    ];
    const cam = { x: 2_257 * KM, y: 0, z: 0 };
    // 519.6 km above the first body's surface; ~4,743 km from the second's.
    expect(nearestShellSurfaceDistanceAU(cam, shells, 2)).toBeCloseTo(519.6 * KM, 9);
  });

  it('is Infinity with no bodies in range', () => {
    expect(nearestShellSurfaceDistanceAU({ x: 0, y: 0, z: 0 }, [], 0)).toBe(Infinity);
  });
});

describe('chaseIdealOffset', () => {
  it('reproduces the chase-branch pose formula at the unified lift', () => {
    const forward = new THREE.Vector3(0.3, -0.5, 0.8).normalize();
    const up = FLIGHT_UP_SCENE;
    const out = chaseIdealOffset(forward, up, new THREE.Vector3());
    const camDist = CRUISE_CAM_DIST_AU;
    const lift = camDist * CHASE_CAM_LIFT_FRAC;
    // Steady follow, reset, and the reacquire target must all resolve to this
    // one formula — a drift here is the old 0.45/0.35 rig split reappearing.
    expect(out.x).toBe(-forward.x * camDist + up.x * lift);
    expect(out.y).toBe(-forward.y * camDist + up.y * lift);
    expect(out.z).toBe(-forward.z * camDist + up.z * lift);
  });

  it('lifts by 0.35 of the chase distance (reset and steady follow unified)', () => {
    expect(CHASE_CAM_LIFT_FRAC).toBe(0.35);
    const out = chaseIdealOffset({ x: 0, y: 0, z: 1 }, { x: 0, y: 1, z: 0 }, new THREE.Vector3());
    expect(out.y).toBe(CRUISE_CAM_DIST_AU * 0.35);
    expect(out.z).toBe(-CRUISE_CAM_DIST_AU);
  });

  it('rides the passed-in up: the same rig at every heading around the flight horizon', () => {
    // The rig must tilt WITH the horizon, not with world-Y. For a forward
    // lying in the flight plane the offset decomposes exactly into
    //   up-component  = +lift·dist        (the camera sits above the ship)
    //   in-plane part = −dist·forward     (straight down the trail)
    // Note the camera→ship RAY is the negation: its up-component is
    // −lift·dist, so the ship is below the optical axis. That is the pose,
    // not a "level" one.
    const lift = CRUISE_CAM_DIST_AU * CHASE_CAM_LIFT_FRAC;
    for (const headingDeg of [0, 37, 90, 143, 180, 231, 270, 314]) {
      const forward = flightDirectionFromAngles(headingDeg * DEG2RAD, 0, new THREE.Vector3());
      expect(Math.abs(forward.dot(FLIGHT_UP_SCENE))).toBeLessThan(1e-12);

      const out = chaseIdealOffset(forward, FLIGHT_UP_SCENE, new THREE.Vector3());
      const alongUp = out.dot(FLIGHT_UP_SCENE);
      expect(alongUp).toBeCloseTo(lift, 14);

      const inPlane = out.clone().addScaledVector(FLIGHT_UP_SCENE, -alongUp);
      expect(inPlane.x).toBeCloseTo(-CRUISE_CAM_DIST_AU * forward.x, 14);
      expect(inPlane.y).toBeCloseTo(-CRUISE_CAM_DIST_AU * forward.y, 14);
      expect(inPlane.z).toBeCloseTo(-CRUISE_CAM_DIST_AU * forward.z, 14);
      // Distance to the ship is heading-independent — the rig is rigid.
      expect(out.length()).toBeCloseTo(CRUISE_CAM_DIST_AU * Math.hypot(1, CHASE_CAM_LIFT_FRAC), 14);
    }
  });
});

describe('cameraFollowGain', () => {
  it('reproduces the tuned per-frame factors at 120 Hz (the approved feel)', () => {
    // The old hardcoded lerp factors were 0.025 idle / 0.06 turning, tuned on
    // a 120 Hz display. The τ constants must keep that exact behavior there.
    expect(cameraFollowGain(1 / 120, CAM_FOLLOW_TAU_IDLE_S)).toBeCloseTo(0.025, 3);
    expect(cameraFollowGain(1 / 120, CAM_FOLLOW_TAU_TURN_S)).toBeCloseTo(0.058, 3);
  });

  it('converges at the same wall-clock rate regardless of frame cadence', () => {
    // Residual after 1 s of frames must equal e^(−1/τ) at any Hz — the whole
    // point of deriving the gain from dt.
    for (const hz of [30, 60, 120]) {
      const g = cameraFollowGain(1 / hz, CAM_FOLLOW_TAU_IDLE_S);
      const residualAfter1s = Math.pow(1 - g, hz);
      expect(residualAfter1s).toBeCloseTo(Math.exp(-1 / CAM_FOLLOW_TAU_IDLE_S), 6);
    }
  });

  it('stays a sane gain at the 100 ms dt cap and never reaches 1', () => {
    const g = cameraFollowGain(0.1, CAM_FOLLOW_TAU_TURN_S);
    expect(g).toBeGreaterThan(0.4);
    expect(g).toBeLessThan(1);
    expect(cameraFollowGain(0.008, CAM_FOLLOW_TURN_BLEND_S)).toBeGreaterThan(0);
  });
});

describe('reacquireCameraStep', () => {
  // The step is radius-scale-free (direction slerp and radius spring are both
  // scale-invariant; the only absolute threshold is the settle angle), so a
  // unit reference radius keeps the numbers readable.
  const R = 1;
  const angleDeg = (a: THREE.Vector3, b: THREE.Vector3) => a.angleTo(b) * (180 / Math.PI);

  it('holds the radius bit-stable under pure rotation at the ideal radius', () => {
    const ideal = new THREE.Vector3(0.2, 0.35, -1).setLength(R);
    const out = ideal
      .clone()
      .applyAxisAngle(new THREE.Vector3(0.3, 1, 0.1).normalize(), Math.PI / 3)
      .setLength(R); // same radius, only rotated — no zoom requested
    let prev = out.length();
    for (let i = 0; i < 400; i++) {
      reacquireCameraStep(out, out, ideal, 1 / 120, CAM_FOLLOW_TAU_IDLE_S);
      const len = out.length();
      expect(Math.abs(len - prev) / R).toBeLessThan(1e-12);
      prev = len;
    }
    expect(Math.abs(out.length() - R) / R).toBeLessThan(1e-9);
  });

  it('springs the radius monotonically toward |ideal| without overshoot', () => {
    const ideal = new THREE.Vector3(0, 0.35, -1);
    const rIdeal = ideal.length();
    const out = ideal.clone().setLength(rIdeal * 2); // same direction, farther out
    let prev = out.length();
    for (let i = 0; i < 400; i++) {
      reacquireCameraStep(out, out, ideal, 1 / 60, CAM_FOLLOW_TAU_IDLE_S);
      const len = out.length();
      expect(len).toBeLessThanOrEqual(prev + 1e-15);
      expect(len).toBeGreaterThanOrEqual(rIdeal - 1e-12);
      prev = len;
    }
    // The radius rides the deliberately slow CAM_REACQUIRE_RADIUS_TAU_S, so it
    // is well converged (not bit-exact) after this many steps.
    expect(out.length()).toBeCloseTo(rIdeal, 4);
  });

  it('turns the direction monotonically toward ideal with no reversal', () => {
    const ideal = new THREE.Vector3(0, 0.2, -1).setLength(R);
    const idealDir = ideal.clone().normalize();
    const out = ideal
      .clone()
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), (75 * Math.PI) / 180)
      .setLength(R);
    // The current direction's component along the initial perpendicular must
    // decay to zero without crossing sign (that crossing is the old reversal).
    const startDir = out.clone().normalize();
    const perp = startDir
      .clone()
      .addScaledVector(idealDir, -startDir.dot(idealDir))
      .normalize();
    let prevAngle = angleDeg(out, ideal);
    for (let i = 0; i < 400; i++) {
      reacquireCameraStep(out, out, ideal, 1 / 90, CAM_FOLLOW_TAU_TURN_S);
      const ang = angleDeg(out, ideal);
      expect(ang).toBeLessThanOrEqual(prevAngle + 1e-9);
      expect(out.clone().normalize().dot(perp)).toBeGreaterThan(-1e-9);
      prevAngle = ang;
    }
    expect(prevAngle).toBeLessThan(0.01);
  });

  it('is frame-rate invariant: one 0.1 s step equals ten 0.01 s steps', () => {
    const ideal = new THREE.Vector3(0, 0.35, -1);
    const start = ideal
      .clone()
      .setLength(ideal.length() * 1.5)
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    const tau = CAM_FOLLOW_TAU_IDLE_S;
    const big = start.clone();
    reacquireCameraStep(big, big, ideal, 0.1, tau);
    const small = start.clone();
    for (let i = 0; i < 10; i++) reacquireCameraStep(small, small, ideal, 0.01, tau);
    expect(angleDeg(big, small)).toBeLessThan(1e-3);
    expect(Math.abs(big.length() - small.length()) / ideal.length()).toBeLessThan(1e-3);
  });

  it('converges from an exactly antipodal start with no NaN or unit drift', () => {
    const ideal = new THREE.Vector3(0, 0.35, -1).setLength(R);
    const out = ideal.clone().negate(); // 180° away, same radius
    for (let i = 0; i < 600; i++) {
      reacquireCameraStep(out, out, ideal, 1 / 120, CAM_FOLLOW_TAU_IDLE_S);
      expect(Number.isFinite(out.x + out.y + out.z)).toBe(true);
      expect(Math.abs(out.length() - R) / R).toBeLessThan(1e-9);
    }
    expect(angleDeg(out, ideal)).toBeLessThan(CAM_REACQUIRE_SETTLE_ANGLE_DEG);
  });

  it('reports settled inside the thresholds and stays settled', () => {
    const ideal = new THREE.Vector3(0, 0.35, -1).setLength(R);
    const out = ideal
      .clone()
      .applyAxisAngle(new THREE.Vector3(1, 0, 0), (0.3 * Math.PI) / 180)
      .setLength(R * (1 + CAM_REACQUIRE_SETTLE_RADIUS_FRAC * 0.4));
    expect(reacquireCameraStep(out, out, ideal, 1 / 120, CAM_FOLLOW_TAU_IDLE_S)).toBe(true);
    for (let i = 0; i < 100; i++) {
      expect(reacquireCameraStep(out, out, ideal, 1 / 120, CAM_FOLLOW_TAU_IDLE_S)).toBe(true);
    }
  });

  it('reports unsettled outside either threshold', () => {
    // A stuck-true predicate would hand the chase a near-full offset and
    // replay the chord-cut zoom — pin false for each violated bound alone.
    const ideal = new THREE.Vector3(0, 0.35, -1).setLength(R);
    const dt = 1 / 120;
    const angOut = ideal
      .clone()
      .applyAxisAngle(new THREE.Vector3(1, 0, 0), (2 * Math.PI) / 180); // angle out, radius exact
    expect(reacquireCameraStep(angOut, angOut, ideal, dt, CAM_FOLLOW_TAU_IDLE_S)).toBe(false);
    const radOut = ideal.clone().setLength(R * 1.01); // radius out, angle exact
    expect(reacquireCameraStep(radOut, radOut, ideal, dt, CAM_FOLLOW_TAU_IDLE_S)).toBe(false);
    const bothOut = ideal
      .clone()
      .applyAxisAngle(new THREE.Vector3(1, 0, 0), (5 * Math.PI) / 180)
      .setLength(R * 1.05);
    expect(reacquireCameraStep(bothOut, bothOut, ideal, dt, CAM_FOLLOW_TAU_IDLE_S)).toBe(false);
  });

  it('keeps the radius within 0.5% through a full 60° and 90° return', () => {
    for (const deg of [60, 90]) {
      const ideal = new THREE.Vector3(0, 0.35, -1).setLength(R);
      const out = ideal
        .clone()
        .applyAxisAngle(new THREE.Vector3(0.2, 1, 0.1).normalize(), (deg * Math.PI) / 180)
        .setLength(R);
      for (let i = 0; i < 500; i++) {
        reacquireCameraStep(out, out, ideal, 1 / 120, CAM_FOLLOW_TAU_IDLE_S);
        expect(Math.abs(out.length() - R) / R).toBeLessThanOrEqual(CAM_REACQUIRE_SETTLE_RADIUS_FRAC);
      }
      expect(angleDeg(out, ideal)).toBeLessThan(CAM_REACQUIRE_SETTLE_ANGLE_DEG);
    }
  });

  it('tracks a rotating ideal within bounds, then settles once it stops', () => {
    const ideal = new THREE.Vector3(0, 0.35, -1).setLength(R);
    const out = ideal.clone().setLength(R);
    const axis = new THREE.Vector3(0, 1, 0);
    const dt = 1 / 120;
    const ratePerStep = ((40 * Math.PI) / 180) * dt; // 40°/s steering of the ideal
    for (let i = 0; i < 240; i++) {
      ideal.applyAxisAngle(axis, ratePerStep);
      const settled = reacquireCameraStep(out, out, ideal, dt, CAM_FOLLOW_TAU_TURN_S);
      expect(Math.abs(out.length() - R) / R).toBeLessThanOrEqual(CAM_REACQUIRE_SETTLE_RADIUS_FRAC);
      expect(angleDeg(out, ideal)).toBeLessThan(15); // lag bounded, never diverges
      // Once the steady-state lag builds (ω·τ ≈ 5.6°), the step must keep
      // reporting unsettled — a premature true hands the lag to the chase.
      if (i >= 60) expect(settled).toBe(false);
    }
    let settled = false;
    for (let i = 0; i < 400 && !settled; i++) {
      settled = reacquireCameraStep(out, out, ideal, dt, CAM_FOLLOW_TAU_TURN_S);
    }
    expect(settled).toBe(true);
  });

  it('sweeps the direction tau mid-return without perturbing the radius spring', () => {
    const makeIdeal = () => new THREE.Vector3(0, 0.35, -1).setLength(R);
    const makeStart = () =>
      makeIdeal()
        .applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)
        .setLength(R * 1.4); // radius spring genuinely active
    const swept = makeStart();
    const fixed = makeStart();
    const idealSwept = makeIdeal();
    const idealFixed = makeIdeal();
    for (let i = 0; i < 300; i++) {
      const blend = Math.min(1, i / 60);
      const tau = CAM_FOLLOW_TAU_IDLE_S + (CAM_FOLLOW_TAU_TURN_S - CAM_FOLLOW_TAU_IDLE_S) * blend;
      reacquireCameraStep(swept, swept, idealSwept, 1 / 120, tau);
      reacquireCameraStep(fixed, fixed, idealFixed, 1 / 120, CAM_FOLLOW_TAU_IDLE_S);
      // The radius rides CAM_REACQUIRE_RADIUS_TAU_S, not the swept direction
      // tau, so both runs walk the identical radius sequence.
      expect(swept.length()).toBeCloseTo(fixed.length(), 12);
    }
    // Converging toward R (slowly, on the radius tau) — the point is that the
    // sweep left the radius sequence identical, asserted every step above.
    expect(swept.length()).toBeLessThan(R * 1.01);
    expect(swept.length()).toBeGreaterThan(R);
    expect(CAM_REACQUIRE_RADIUS_TAU_S).toBeGreaterThan(CAM_FOLLOW_TAU_IDLE_S);
  });

  it('matches a chase Cartesian lerp at the settle boundary (seamless snap)', () => {
    const idealDir = new THREE.Vector3(0, 0.35, -1).normalize();
    const ideal = idealDir.clone().multiplyScalar(R);
    // Just inside BOTH thresholds — the worst pose the settle can hand over —
    // at both follow taus. The spherical step and the chase branch's Cartesian
    // lerp toward the same offset must agree, or the state switch is a
    // one-frame velocity step (the defect class this campaign kills).
    for (const tau of [CAM_FOLLOW_TAU_IDLE_S, CAM_FOLLOW_TAU_TURN_S]) {
      const cam = ideal
        .clone()
        .applyAxisAngle(new THREE.Vector3(1, 0, 0), (0.4 * Math.PI) / 180)
        .setLength(R * (1 + CAM_REACQUIRE_SETTLE_RADIUS_FRAC * 0.9));
      const dt = 1 / 120;
      const spherical = new THREE.Vector3();
      reacquireCameraStep(spherical, cam, ideal, dt, tau);
      const lerp = cam.clone().lerp(ideal, cameraFollowGain(dt, tau));
      expect(spherical.distanceTo(lerp) / R).toBeLessThan(1e-4);
    }
  });
});

describe('largestDiscAngles (what the lens proximity ramp reads)', () => {
  const angles = () => ({ effectiveRad: 0, effectiveIndex: -1, effectiveDistanceAU: 0, cameraRad: 0, cameraIndex: -1 });
  const shell = (x: number, y: number, z: number, surfaceRadiusAU: number, discRadiusAU: number, name: string) =>
    ({ x, y, z, surfaceRadiusAU, discRadiusAU, name });
  const deg = (rad: number) => (rad * 180) / Math.PI;
  const length = (v: { x: number; y: number; z: number }) => Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  const noBoom = { x: 0, y: 0, z: 0 };

  it('reads the DISC, never the envelope or the governed surface', () => {
    // Earth: the safety envelope carries the air shell (×1.02); the Sun's
    // governed surface is 1.2× its photosphere. Both must be ignored.
    const earthR = 6371 * KM;
    const earth = shell(0, 0, -2 * earthR, earthR * 1.02, earthR, 'Earth');
    const out = largestDiscAngles(noBoom, 0, [earth], 1, angles());
    expect(deg(out.effectiveRad)).toBeCloseTo(30, 6);
    expect(out.effectiveIndex).toBe(0);
    const sunR = 695_700 * KM;
    const sun = shell(0, 0, -1.2 * sunR, sunR * 1.2, sunR, 'Sun');
    const atSun = largestDiscAngles(noBoom, 0, [sun], 1, angles());
    expect(deg(atSun.effectiveRad)).toBeCloseTo(56.44, 1);
  });

  it('holds still while the camera orbits the ship, and moves as the intended boom lengthens', () => {
    const earthR = 6371 * KM;
    const boom = 233 * KM;
    const earth = shell(0, 0, -(earthR + 1000 * KM), earthR * 1.02, earthR, 'Earth');
    const readings: number[] = [];
    const cameraReadings: number[] = [];
    const lift = 0.35;
    const back = Math.sqrt(1 - lift * lift);
    for (const [x, y, z] of [[0, 0, boom], [boom, 0, 0], [0, boom, 0], [-boom, 0, 0], [0, lift * boom, back * boom]]) {
      const out = largestDiscAngles({ x, y, z }, boom, [earth], 1, angles());
      readings.push(out.effectiveRad);
      cameraReadings.push(out.cameraRad);
      // On a boom of its intended length the camera is never farther from
      // the body than the ship's distance plus that length.
      expect(out.cameraRad).toBeGreaterThanOrEqual(out.effectiveRad - 1e-12);
    }
    for (const r of readings) expect(r).toBeCloseTo(readings[0], 12);
    expect(Math.max(...cameraReadings) - Math.min(...cameraReadings)).toBeGreaterThan(0.01);
    const longer = largestDiscAngles({ x: 0, y: 0, z: 3 * boom }, 3 * boom, [earth], 1, angles());
    expect(longer.effectiveRad).toBeLessThan(readings[0]);
  });

  it('holds still through a safety push: a half-turn drag at the Moon shortens the camera boom, never the driving angle', () => {
    // Codex's counterexample against the ship-plus-ACTUAL-boom reading: the
    // ship parked 200 km over a Moon-sized body, the camera dragged round it
    // on the chase boom. Facing the body the camera sits inside the padded
    // shell and escapeCameraPenetrations pushes it out radially, which
    // shortens its distance to the ship — and a boom read from the camera
    // then read a larger driving angle with the ship never moving. The
    // intended boom is the rig's, so the driving angle holds to the bit
    // while the camera's own angle, and its actual boom, move.
    const moonR = 1737.4 * KM;
    const forward = { x: 0, y: 0, z: -1 }; // nose on the body, ahead along −z
    const up = { x: 0, y: 1, z: 0 };
    const intendedBoom = chaseIdealBoomAU(forward, up);
    expect(intendedBoom / KM).toBeCloseTo(232.8, 0);
    const ideal = chaseIdealOffset(forward, up, { x: 0, y: 0, z: 0 });
    const drag = (shipDistanceAU: number) => {
      const moon = shell(0, 0, -shipDistanceAU, moonR, moonR, 'Moon');
      const driving: number[] = [];
      const cameraAngles: number[] = [];
      const actualBooms: number[] = [];
      const oldReadings: number[] = [];
      for (let step = 0; step <= 720; step++) {
        const azimuth = (step / 720) * 2 * Math.PI; // 0 = the head-on chase, π = facing the body
        const posed = {
          x: Math.sin(azimuth) * ideal.z + Math.cos(azimuth) * ideal.x,
          y: ideal.y,
          z: Math.cos(azimuth) * ideal.z - Math.sin(azimuth) * ideal.x,
        };
        const pushed = escapeCameraPenetrations(posed, [moon], 1, CAMERA_BODY_MARGIN_AU);
        const cam = pushed ?? posed;
        const out = largestDiscAngles(cam, intendedBoom, [moon], 1, angles());
        driving.push(out.effectiveRad);
        cameraAngles.push(out.cameraRad);
        actualBooms.push(length(cam));
        // What the camera's actual boom would have read.
        oldReadings.push(largestDiscAngles(cam, length(cam), [moon], 1, angles()).effectiveRad);
      }
      return { driving, cameraAngles, actualBooms, oldReadings };
    };
    const span = (values: number[]) => Math.max(...values) - Math.min(...values);

    // 200 km up: Codex's numbers, 53.2° → 57.1° and a factor 0.75 → 0.53 read
    // from the camera; one number read from the rig.
    const twoHundred = drag(moonR + 200 * KM);
    for (const r of twoHundred.driving) expect(r).toBeCloseTo(twoHundred.driving[0], 12);
    expect(deg(twoHundred.driving[0])).toBeCloseTo(53.19, 1);
    expect(Math.min(...twoHundred.actualBooms) / KM).toBeLessThan(232.8 - 50); // the push happened
    expect(deg(span(twoHundred.cameraAngles))).toBeGreaterThan(5); // and the camera did move
    expect(deg(span(twoHundred.oldReadings))).toBeGreaterThan(2.5);
    const oldFactors = twoHundred.oldReadings.map(lensProximityFactor);
    expect(span(oldFactors)).toBeGreaterThan(0.15);
    expect(span(twoHundred.driving.map(lensProximityFactor))).toBe(0);

    // The Moon's own park (~78 km up, a driving angle of 58°): the camera's
    // boom read the same drag as the lens going from 0.47 to nearly off.
    const park = drag(moonR / Math.sin(58 * DEG2RAD) - intendedBoom);
    for (const r of park.driving) expect(r).toBeCloseTo(park.driving[0], 12);
    expect(deg(park.driving[0])).toBeCloseTo(58, 1);
    expect(span(park.oldReadings.map(lensProximityFactor))).toBeGreaterThan(0.3);
    expect(span(park.driving.map(lensProximityFactor))).toBe(0);
  });

  it('holds still under the floor: the safety push leaves the camera inside minDistance, the controls\' clamp lifts it back, every frame, and the boom never learns it', () => {
    // Codex's third finding. Mercury, the ship 98 km up (a k = 0.13 postcard):
    // the padded shell, R + 67.9 km, passes 30 km under the ship — inside the
    // controls' 89.6 km floor. A drag that faces the body puts the chase boom
    // through the shell; the safety pass pushes the camera out to it, 30 km
    // from the ship; OrbitControls re-derives its spherical from that camera
    // and its update lifts the radius to the floor with no wheel; the push
    // returns it — every frame the drag, then its coast, faces the body. A
    // boom that took each lift for a dolly-out tripled a frame.
    const mercuryR = 2439.7 * KM;
    const shipDistance = 8 * 0.13 * mercuryR;
    const mercury = shell(0, 0, -shipDistance, mercuryR, mercuryR, 'Mercury');
    const minAU = CRUISE_CONTROLS_MIN_DISTANCE_AU;
    const maxAU = 5;
    // The shell passes inside the floor: the condition this pose exists for.
    expect((shipDistance - mercuryR - CAMERA_BODY_MARGIN_AU) / KM).toBeCloseTo(29.7, 0);
    expect(shipDistance - mercuryR - CAMERA_BODY_MARGIN_AU).toBeLessThan(minAU);
    const forward = { x: 0, y: 0, z: -1 };
    const up = { x: 0, y: 1, z: 0 };
    const ideal = chaseIdealOffset(forward, up, { x: 0, y: 0, z: 0 });
    const chaseBoom = chaseIdealBoomAU(forward, up);
    const chasePolar = Math.atan2(Math.hypot(ideal.x, ideal.z), ideal.y); // from up
    const span = (values: number[]) => Math.max(...values) - Math.min(...values);
    // The frame loop under 'orbit', as the mode runs it: the controls' update
    // (the spherical from the live camera, the radius × 1 — no wheel — then
    // the clamp, then the pose at the drag's azimuth and polar), the boom
    // rule across that update, the safety pass, the lens.
    const fly = (boomRule: (intended: number, radiusBefore: number, radiusAfter: number) => number) => {
      let cam = { ...ideal };
      let intended = chaseBoom;
      let framesUnderFloor = 0;
      const driving: number[] = [];
      const cameraBooms: number[] = [];
      for (let frame = 0; frame < 900; frame++) {
        // 300 frames swinging round to face the body and dropping level with
        // it, 300 held there (the coast), 300 swinging back.
        const t = frame < 300 ? frame / 300 : frame < 600 ? 1 : 1 - (frame - 600) / 300;
        const azimuth = Math.PI * t; // 0 = the chase, π = facing the body
        const polar = chasePolar + (Math.PI / 2 - chasePolar) * t;
        const radiusBefore = length(cam);
        const radius = Math.min(Math.max(radiusBefore * 1, minAU), maxAU);
        cam = {
          x: radius * Math.sin(polar) * Math.sin(azimuth),
          y: radius * Math.cos(polar),
          z: radius * Math.sin(polar) * Math.cos(azimuth),
        };
        intended = boomRule(intended, radiusBefore, length(cam));
        const pushed = escapeCameraPenetrations(cam, [mercury], 1, CAMERA_BODY_MARGIN_AU);
        if (pushed) cam = pushed;
        if (length(cam) < minAU) framesUnderFloor++;
        cameraBooms.push(length(cam));
        driving.push(largestDiscAngles(cam, intended, [mercury], 1, angles()).effectiveRad);
      }
      return { intended, framesUnderFloor, driving, cameraBooms };
    };
    const rig = fly((intended, before, after) => intendedBoomAfterOrbitUpdate(intended, before, after, minAU, maxAU));
    // The condition was reached and held: the camera under the floor for the
    // whole coast, 30 km from the ship.
    expect(rig.framesUnderFloor).toBeGreaterThan(300);
    expect(Math.min(...rig.cameraBooms) / KM).toBeLessThan(35);
    expect(Object.is(rig.intended, chaseBoom)).toBe(true);
    for (const r of rig.driving) expect(r).toBe(rig.driving[0]);
    expect(deg(rig.driving[0])).toBeCloseTo(61.7, 0);
    expect(span(rig.driving.map(lensProximityFactor))).toBe(0);
    // The rule before this test — every ratio a dolly, the clamp's lift
    // included — ran the boom to the ceiling and the lens to full, with the
    // ship never moving.
    const unfixed = fly((intended, before, after) => {
      const ratio = after / before;
      if (Math.abs(ratio - 1) < ORBIT_DOLLY_DEADBAND) return intended;
      return Math.min(Math.max(intended * ratio, minAU), maxAU);
    });
    expect(unfixed.intended).toBe(maxAU);
    const unfixedFactors = unfixed.driving.map(lensProximityFactor);
    expect(unfixedFactors[0]).toBeCloseTo(lensProximityFactor(rig.driving[0]), 12);
    expect(unfixedFactors[0]).toBeLessThan(0.3);
    expect(Math.max(...unfixedFactors)).toBe(1);
  });

  it('never exceeds the ship-only angle: a 1.8-radius pass bounds the DRIVING angle at 33.7°, not the camera\'s own', () => {
    const r = 243 * KM; // the smallest rendered moon the flyby search visits
    const pass = shell(1.8 * r, 0, 0, r, r, 'moonlet');
    const trailing = { x: -233 * KM, y: 77 * KM, z: 0 };
    const worst = largestDiscAngles(trailing, length(trailing), [pass], 1, angles());
    expect(deg(worst.effectiveRad)).toBeLessThanOrEqual(33.75 + 1e-9);
    const shipOnly = largestDiscAngles(noBoom, 0, [pass], 1, angles());
    expect(worst.effectiveRad).toBeLessThan(shipOnly.effectiveRad);
    // The camera sits off the ship's line and can pass nearer the body than
    // the ship does; ITS angle reads past 33.7° and drives nothing.
    const swungIn = { x: 135.7 * KM, y: 77 * KM, z: 0 };
    const seen = largestDiscAngles(swungIn, length(trailing), [pass], 1, angles());
    expect(deg(seen.cameraRad)).toBeGreaterThan(45);
    expect(deg(seen.effectiveRad)).toBeLessThanOrEqual(33.75 + 1e-9);
  });

  it('picks the largest disc across the pool and reads empty, non-finite or a bad boom as none', () => {
    const near = shell(0, 0, -3 * 1000 * KM, 1000 * KM, 1000 * KM, 'near');
    const big = shell(0, 5 * 6371 * KM, 0, 6371 * KM, 6371 * KM, 'big');
    const out = largestDiscAngles(noBoom, 0, [near, big], 2, angles());
    expect(out.effectiveIndex).toBe(0);
    const none = largestDiscAngles(noBoom, 0, [], 0, angles());
    expect(none.effectiveRad).toBe(0);
    expect(none.effectiveIndex).toBe(-1);
    const broken = shell(Number.NaN, 0, 0, 1, 1, 'broken');
    const skipped = largestDiscAngles(noBoom, 0, [broken], 1, angles());
    expect(skipped.effectiveRad).toBe(0);
    expect(skipped.cameraRad).toBe(0);
    // A boom that is not a length reads as no boom, never as a NaN angle.
    for (const boom of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      const ship = largestDiscAngles(noBoom, boom, [near], 1, angles());
      expect(deg(ship.effectiveRad)).toBeCloseTo(deg(Math.asin(1 / 3)), 9);
    }
  });
});

describe('chaseIdealBoomAU (the boom the rig intends)', () => {
  it('is the chase ideal offset\'s length for any heading: 232.8 km level, shorter nose-up, longer nose-down', () => {
    const up = { x: 0, y: 1, z: 0 };
    expect(chaseIdealBoomAU({ x: 0, y: 0, z: -1 }, up) / KM).toBeCloseTo(CRUISE_CAM_DIST_AU * Math.hypot(1, CHASE_CAM_LIFT_FRAC) / KM, 9);
    expect(chaseIdealBoomAU({ x: 0, y: 0, z: -1 }, up) / KM).toBeCloseTo(232.8, 0);
    expect(chaseIdealBoomAU(up, up) / KM).toBeCloseTo(CRUISE_CAM_DIST_AU * (1 - CHASE_CAM_LIFT_FRAC) / KM, 9);
    expect(chaseIdealBoomAU({ x: 0, y: -1, z: 0 }, up) / KM).toBeCloseTo(CRUISE_CAM_DIST_AU * (1 + CHASE_CAM_LIFT_FRAC) / KM, 9);
    const scratch = new THREE.Vector3();
    for (const [headingDeg, pitchDeg] of [[0, 0], [37, 12], [200, -60], [300, 85], [90, -88]]) {
      const forward = flightDirectionFromAngles(headingDeg * DEG2RAD, pitchDeg * DEG2RAD, scratch).clone();
      const offset = chaseIdealOffset(forward, FLIGHT_UP_SCENE, new THREE.Vector3());
      expect(chaseIdealBoomAU(forward, FLIGHT_UP_SCENE)).toBeCloseTo(offset.length(), 15);
    }
  });
});

describe('intendedBoomAfterOrbitUpdate (the wheel enters the boom, a push never does)', () => {
  const minAU = CRUISE_CONTROLS_MIN_DISTANCE_AU;
  const maxAU = 5;
  const boom = 232.8 * KM;

  it('keeps the boom when an update leaves the radius alone, whatever radius a push left it at', () => {
    // Last frame's safety push shortened the camera's radius to 132 km; this
    // update rotated it and nothing else. The boom must not learn the push.
    expect(intendedBoomAfterOrbitUpdate(boom, 132 * KM, 132 * KM, minAU, maxAU)).toBe(boom);
  });

  it('keeps the boom BIT-identical when only rounding moved the radius, and hears the smallest wheel event', () => {
    // OrbitControls' spherical round trip returns a radius an ulp or two off
    // the one it read; a drag is hundreds of such updates, and a boom that
    // took each ratio walked, flipping the factor between adjacent doubles.
    const radius = 132 * KM;
    for (const ulps of [1, -1, 3, -7]) {
      const nudged = radius * (1 + ulps * Number.EPSILON);
      expect(Object.is(intendedBoomAfterOrbitUpdate(boom, radius, nudged, minAU, maxAU), boom)).toBe(true);
    }
    expect(intendedBoomAfterOrbitUpdate(boom, radius, radius * (1 + 0.5 * ORBIT_DOLLY_DEADBAND), minAU, maxAU)).toBe(boom);
    // The finest wheel event three's controls produce: 0.95^(0.01) of the radius.
    const finestWheel = Math.pow(0.95, 0.01);
    expect(intendedBoomAfterOrbitUpdate(boom, radius, radius * finestWheel, minAU, maxAU)).toBeCloseTo(boom * finestWheel, 20);
  });

  it('scales the boom by exactly the update\'s dolly ratio, from a pushed radius as from the boom itself', () => {
    expect(intendedBoomAfterOrbitUpdate(boom, 232.8 * KM, 279.36 * KM, minAU, maxAU) / KM).toBeCloseTo(279.36, 9);
    expect(intendedBoomAfterOrbitUpdate(boom, 132 * KM, 158.4 * KM, minAU, maxAU) / KM).toBeCloseTo(279.36, 9);
    expect(intendedBoomAfterOrbitUpdate(boom, 132 * KM, 66 * KM, minAU, maxAU) / KM).toBeCloseTo(116.4, 9);
  });

  it('clamps to the controls\' own distance range and ignores a radius it cannot read', () => {
    expect(intendedBoomAfterOrbitUpdate(boom, 232.8 * KM, 1 * KM, minAU, maxAU)).toBe(minAU);
    expect(intendedBoomAfterOrbitUpdate(boom, 232.8 * KM, 232.8 * KM * 1e9, minAU, maxAU)).toBe(maxAU);
    expect(intendedBoomAfterOrbitUpdate(boom, 0, 100 * KM, minAU, maxAU)).toBe(boom);
    expect(intendedBoomAfterOrbitUpdate(boom, 100 * KM, Number.NaN, minAU, maxAU)).toBe(boom);
    expect(intendedBoomAfterOrbitUpdate(boom, 100 * KM, 0, minAU, maxAU)).toBe(boom);
  });

  it('never takes the controls\' distance clamp for a dolly: a radius that entered under the floor and left on it leaves the boom alone', () => {
    // Codex's third finding: the ship 98 km over Mercury, the drag facing the
    // body, the safety pass leaving the camera 30 km from the ship — under
    // the 89.6 km floor — and OrbitControls' update() lifting it back to the
    // floor with no wheel at all. Multiplied through, that lift tripled the
    // boom every frame of the coast.
    const pushed = 30 * KM;
    expect(Object.is(intendedBoomAfterOrbitUpdate(boom, pushed, minAU, minAU, maxAU), boom)).toBe(true);
    // The spherical round trip leaves the lifted radius an ulp or two off
    // the floor, either side.
    for (const ulps of [1, -1, 3, -7]) {
      const lifted = minAU * (1 + ulps * Number.EPSILON);
      expect(Object.is(intendedBoomAfterOrbitUpdate(boom, pushed, lifted, minAU, maxAU), boom)).toBe(true);
    }
    // The cycle itself — pushed to the shell, lifted to the floor — for 500
    // frames leaves the boom BIT-identical.
    let intended = boom;
    for (let frame = 0; frame < 500; frame++) {
      intended = intendedBoomAfterOrbitUpdate(intended, pushed, minAU * (1 + ((frame % 3) - 1) * Number.EPSILON), minAU, maxAU);
    }
    expect(Object.is(intended, boom)).toBe(true);
    // A push that left the camera a rounding error under the floor: the lift
    // is the clamp's too.
    expect(Object.is(intendedBoomAfterOrbitUpdate(boom, minAU * (1 - Number.EPSILON), minAU, minAU, maxAU), boom)).toBe(true);
    // The ceiling, symmetric.
    expect(Object.is(intendedBoomAfterOrbitUpdate(boom, maxAU * 1.5, maxAU, minAU, maxAU), boom)).toBe(true);
    expect(Object.is(intendedBoomAfterOrbitUpdate(boom, maxAU * 1.5, maxAU * (1 - Number.EPSILON), minAU, maxAU), boom)).toBe(true);
  });

  it('still hears the wheel across the floor: out from under it exactly, in onto it as the move the camera made, and not at all where the clamp swallowed it', () => {
    const pushed = 60 * KM;
    // A wheel-out that carried a pushed camera past the floor left the update
    // OFF the bound: the ratio is the wheel's alone.
    expect(intendedBoomAfterOrbitUpdate(boom, pushed, pushed * 1.6, minAU, maxAU) / KM).toBeCloseTo(232.8 * 1.6, 9);
    // A wheel-in from above the floor that the clamp stopped AT the floor
    // moved the camera to the floor: the boom takes that visible ratio.
    expect(intendedBoomAfterOrbitUpdate(boom, 232.8 * KM, minAU, minAU, maxAU) / KM).toBeCloseTo(minAU / KM, 9);
    // A wheel-in AT the floor moves nothing the eye can see, and nothing here.
    expect(Object.is(intendedBoomAfterOrbitUpdate(boom, minAU, minAU, minAU, maxAU), boom)).toBe(true);
    // A wheel-out from under the floor that did not clear it is the clamp's
    // move, and is not heard: the camera is at the floor either way.
    expect(Object.is(intendedBoomAfterOrbitUpdate(boom, pushed, minAU, minAU, maxAU), boom)).toBe(true);
    // A wheel-out from the floor itself is heard exactly.
    expect(intendedBoomAfterOrbitUpdate(boom, minAU, minAU * 1.05, minAU, maxAU) / KM).toBeCloseTo(232.8 * 1.05, 9);
  });
});
