import { describe, it, expect } from 'vitest';
import { ATMOSPHERE_SHELL_SCALES } from './PlanetFactory';
import {
  SHIP_RIG_SCALE,
  SHIP_REFERENCE_RADIUS_AU,
  SHIP_CLEARANCE_AU,
  CRUISE_CAM_DIST_AU,
  SHIP_OCCLUDER_RADIUS_AU,
  CRUISE_CONTROLS_MIN_DISTANCE_AU,
  SHIP_HULL_MAX_EXTENT_AU,
  CAMERA_BODY_MARGIN_AU,
  CRUISE_NEAR_MIN_AU,
  CRUISE_NEAR_MAX_AU,
  planetEnvelopeRadiusAU,
  cruiseCameraNearAU,
  ringAnnulusDistanceAU,
  resolveCameraPenetration,
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
    expect(CRUISE_CONTROLS_MIN_DISTANCE_AU).toBe(0.00001 * SHIP_RIG_SCALE);
  });

  it('keeps the camera margin outside the hull extent (a clamped camera can stack on the ship radial)', () => {
    expect(CAMERA_BODY_MARGIN_AU).toBeGreaterThan(SHIP_HULL_MAX_EXTENT_AU);
  });

  it('covers the default hull: nozzle exit 1.82 units × 1.8 per radius × 0.5 group scale', () => {
    expect(SHIP_HULL_MAX_EXTENT_AU).toBeGreaterThan(SHIP_REFERENCE_RADIUS_AU * 1.82 * 1.8 * 0.5);
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

  it('pins Venus: the thickest shell grows the collision shell ~4.4%', () => {
    // At the shrunken clearance the growth is scale-dominated — the plan's
    // early "≤1.5%" claim was Jupiter-specific and wrong for Venus.
    const VENUS = 6_052 * KM;
    const solid = VENUS + SHIP_CLEARANCE_AU;
    const envelope = planetEnvelopeRadiusAU(VENUS, 1, ATMOSPHERE_SHELL_SCALES.Venus) + SHIP_CLEARANCE_AU;
    expect(envelope / solid - 1).toBeGreaterThan(0.04);
    expect(envelope / solid - 1).toBeLessThan(0.05);
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

describe('resolveCameraPenetration', () => {
  const MOON_SHELL = 1_737.4 * KM + SHIP_CLEARANCE_AU;

  it('leaves a clear camera untouched', () => {
    const cam = { x: MOON_SHELL + CAMERA_BODY_MARGIN_AU * 2, y: 0, z: 0 };
    expect(resolveCameraPenetration(cam, { x: 0, y: 0, z: 0 }, MOON_SHELL)).toBeNull();
  });

  it('pushes a penetrating camera radially to the padded shell', () => {
    const cam = { x: MOON_SHELL * 0.5, y: 0, z: 0 };
    const out = resolveCameraPenetration(cam, { x: 0, y: 0, z: 0 }, MOON_SHELL);
    expect(out).not.toBeNull();
    expect(out!.x).toBeCloseTo(MOON_SHELL + CAMERA_BODY_MARGIN_AU, 12);
    expect(out!.y).toBe(0);
    expect(out!.z).toBe(0);
  });

  it('preserves the radial direction of the push', () => {
    const center = { x: 1, y: 2, z: 3 };
    const cam = { x: 1 + MOON_SHELL * 0.3, y: 2 + MOON_SHELL * 0.4, z: 3 };
    const out = resolveCameraPenetration(cam, center, MOON_SHELL)!;
    const dx = out.x - center.x;
    const dy = out.y - center.y;
    const dz = out.z - center.z;
    expect(Math.hypot(dx, dy, dz)).toBeCloseTo(MOON_SHELL + CAMERA_BODY_MARGIN_AU, 12);
    expect(dy / dx).toBeCloseTo(0.4 / 0.3, 6);
    expect(dz).toBeCloseTo(0, 12);
  });

  it('escapes a dead-center camera along +X instead of dividing by zero', () => {
    const out = resolveCameraPenetration({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, MOON_SHELL)!;
    expect(out.x).toBeCloseTo(MOON_SHELL + CAMERA_BODY_MARGIN_AU, 12);
  });

  it('settles a co-orbital shell overlap in two alternating passes', () => {
    // Pan/Atlas geometry: both floored to 5% of Saturn (3,013 km) while
    // orbiting 4,086 km apart — the padded shells genuinely overlap at
    // conjunction, so a one-body push can land inside the neighbour.
    const shell = 3_013.4 * KM + SHIP_CLEARANCE_AU;
    const pan = { x: 0, y: 0, z: 0 };
    const atlas = { x: 4_086 * KM, y: 0, z: 0 };
    let cam = { x: 2_000 * KM, y: 100 * KM, z: 0 };
    for (let pass = 0; pass < 2; pass++) {
      for (const body of [pan, atlas]) {
        const pushed = resolveCameraPenetration(cam, body, shell);
        if (pushed) cam = pushed;
      }
    }
    const clear = (c: { x: number; y: number; z: number }) =>
      Math.hypot(cam.x - c.x, cam.y - c.y, cam.z - c.z) >= shell + CAMERA_BODY_MARGIN_AU - 1e-15;
    expect(clear(pan)).toBe(true);
    expect(clear(atlas)).toBe(true);
  });
});
