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
} from './cruiseView';

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
    // Tighter than the chase-distance ship gap (camDist − hull ≈ 320 km),
    // so the surface term binds.
    const surface = 200 * KM;
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
    ({ x, y, z, surfaceRadiusAU });
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
      { x: 0, y: 0, z: 0, surfaceRadiusAU: 1_737.4 * KM },
      { x: 10_000 * KM, y: 0, z: 0, surfaceRadiusAU: 3_000 * KM },
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
    const out = chaseIdealOffset(forward, new THREE.Vector3());
    const camDist = CRUISE_CAM_DIST_AU;
    // Byte-identical to the inline chase formula the reset and steady follow
    // both used to spell out — a drift here is a rig split reappearing.
    expect(out.x).toBe(-forward.x * camDist);
    expect(out.y).toBe(-forward.y * camDist + camDist * CHASE_CAM_LIFT_FRAC);
    expect(out.z).toBe(-forward.z * camDist);
  });

  it('lifts by 0.35 of the chase distance (reset and steady follow unified)', () => {
    expect(CHASE_CAM_LIFT_FRAC).toBe(0.35);
    const out = chaseIdealOffset({ x: 0, y: 0, z: 1 }, new THREE.Vector3());
    expect(out.y).toBe(CRUISE_CAM_DIST_AU * 0.35);
    expect(out.z).toBe(-CRUISE_CAM_DIST_AU);
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
      reacquireCameraStep(out, out, ideal, dt, CAM_FOLLOW_TAU_TURN_S);
      expect(Math.abs(out.length() - R) / R).toBeLessThanOrEqual(CAM_REACQUIRE_SETTLE_RADIUS_FRAC);
      expect(angleDeg(out, ideal)).toBeLessThan(15); // lag bounded, never diverges
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
    // Just inside the angle threshold, radius exactly at ideal — only the
    // shared direction tau is in play, so the spherical step and the chase
    // branch's Cartesian lerp toward the same offset must agree.
    const cam = ideal
      .clone()
      .applyAxisAngle(new THREE.Vector3(1, 0, 0), (0.4 * Math.PI) / 180);
    const tau = CAM_FOLLOW_TAU_IDLE_S;
    const dt = 1 / 120;
    const spherical = new THREE.Vector3();
    reacquireCameraStep(spherical, cam, ideal, dt, tau);
    const lerp = cam.clone().lerp(ideal, cameraFollowGain(dt, tau));
    expect(spherical.distanceTo(lerp) / R).toBeLessThan(1e-4);
  });
});
