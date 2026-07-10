import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  advanceBodyCap,
  governedSpeedCap,
  initialBodyCapState,
  moonArrivalPose,
  moonCollisionRadius,
  rampedSpeedCap,
  BODY_APPROACH_V_MIN_AU_S,
  BODY_CAP_CLEAR_HOLD_S,
  MOON_CAP_RELEASE_EFOLD_S,
  PLANET_CAP_RELEASE_EFOLD_S,
  MOON_APPROACH_K_PER_S,
  PLANET_APPROACH_K_PER_S,
  MOON_ARRIVAL_APPARENT_DIAMETER_DEG,
  MOON_ARRIVAL_MAX_OFFAXIS_DEG,
  MOON_ARRIVAL_SEPARATION_CAP,
  MOON_ARRIVAL_STANDOFF_FLOOR_AU,
  type MoonArrivalInputs,
} from './arrivalLogic';
import { MOONS } from './planets/moonData';
import { PLANETARIUM_BODIES } from './planets/planetData';
import { KM_PER_AU } from '../astronomy/constants';
import { DEG2RAD, RAD2DEG } from '../shared/math/angles';
// The REAL rig constants — this sweep must see exactly the rig the app
// flies (mirrored copies here once meant a rig change couldn't fail a test).
import { SHIP_CLEARANCE_AU, CRUISE_CAM_DIST_AU as CAM_DIST_AU } from './cruiseView';

const K = MOON_APPROACH_K_PER_S;
const VMIN = BODY_APPROACH_V_MIN_AU_S;

const MESH_FLOOR_RATIO = 0.05;

/** Real-catalog inputs for one moon, posed at `angleRad` around its parent
 *  (parent placed on the +X axis at its semi-major axis; Sun at origin —
 *  the same world the controller feeds from live positions). */
function catalogInputs(moonName: string, angleRad = 0.7): MoonArrivalInputs {
  const moon = MOONS.find((m) => m.name === moonName)!;
  const parent = PLANETARIUM_BODIES.find((b) => b.name === moon.parentPlanet)!;
  const parentPos = new THREE.Vector3(parent.semiMajorAxisAU, 0, 0);
  const offset = new THREE.Vector3(
    Math.cos(angleRad) * moon.orbitalRadiusAU,
    0,
    Math.sin(angleRad) * moon.orbitalRadiusAU,
  );
  const parentCollision = parent.radiusAU + SHIP_CLEARANCE_AU;
  return {
    moonPos: offset.clone().add(parentPos),
    parentPos,
    orbitR: moon.orbitalRadiusAU,
    renderedR: Math.max(moon.radiusAU, parent.radiusAU * MESH_FLOOR_RATIO),
    parentCollision,
    parentClearance: parentCollision * 1.25, // ring factor varies; the sweep uses the base
    camDist: CAM_DIST_AU,
    shipClearance: SHIP_CLEARANCE_AU,
  };
}

describe('governedSpeedCap', () => {
  it('head-on approach is capped at K × surface distance', () => {
    expect(governedSpeedCap(1e-4, 1, K, VMIN)).toBeCloseTo(1e-4 * K, 12);
  });

  it('the floor keeps a creep speed available at the surface', () => {
    expect(governedSpeedCap(0, 1, K, VMIN)).toBe(VMIN);
    expect(governedSpeedCap(1e-9, 1, K, VMIN)).toBe(VMIN);
  });

  it('receding or side-on flight is uncapped', () => {
    expect(governedSpeedCap(1e-4, 0, K, VMIN)).toBe(Infinity);
    expect(governedSpeedCap(1e-4, -1, K, VMIN)).toBe(Infinity);
  });

  it('the grazing band releases smoothly: half-smoothstep doubles the cap', () => {
    const full = governedSpeedCap(1e-4, 0.3, K, VMIN);
    expect(governedSpeedCap(1e-4, 0.15, K, VMIN)).toBeCloseTo(full * 2, 10);
    // Continuity toward the free side: a whisker of closing cosine allows
    // a huge (but finite) cap, never a jump from capped to free.
    expect(governedSpeedCap(1e-4, 0.005, K, VMIN)).toBeGreaterThan(full * 100);
    expect(governedSpeedCap(1e-4, 0.005, K, VMIN)).toBeLessThan(Infinity);
  });

  it('beyond the band the cap is exactly the base — no over-tightening', () => {
    expect(governedSpeedCap(2e-4, 0.9, K, VMIN)).toBeCloseTo(2e-4 * K, 12);
  });

  it('closer means slower, monotonically', () => {
    let prev = Infinity;
    for (const d of [1e-3, 1e-4, 1e-5, 1e-6]) {
      const cap = governedSpeedCap(d, 1, K, VMIN);
      expect(cap).toBeLessThan(prev);
      prev = cap;
    }
  });
});

describe('rampedSpeedCap', () => {
  const E = MOON_CAP_RELEASE_EFOLD_S;

  it('tightening applies instantly, including first contact from Infinity', () => {
    expect(rampedSpeedCap(1e-6, Infinity, 1 / 60, E)).toBe(1e-6);
    expect(rampedSpeedCap(1e-7, 1e-6, 1 / 60, E)).toBe(1e-7);
  });

  it('a steady cap passes through unchanged', () => {
    expect(rampedSpeedCap(1e-6, 1e-6, 1 / 60, E)).toBe(1e-6);
    expect(rampedSpeedCap(Infinity, Infinity, 1 / 60, E)).toBe(Infinity);
  });

  it('release grows by e per e-fold, never past the geometric cap', () => {
    expect(rampedSpeedCap(Infinity, 1e-6, E, E)).toBeCloseTo(1e-6 * Math.E, 12);
    expect(rampedSpeedCap(2e-6, 1e-6, 10 * E, E)).toBe(2e-6);
  });

  it('a full release promotes to Infinity instead of lingering finite', () => {
    // From a deep-flyby cap, enough elapsed time crosses the release ceiling.
    expect(rampedSpeedCap(Infinity, 2e-6, 15 * E, E)).toBe(Infinity);
  });

  it('the ramp reaches in-system speed in a few seconds, not instantly', () => {
    // ~300 km/s flyby cap back to the ~25,000 km/s in-system band.
    const flyby = 300 / KM_PER_AU;
    const inSystem = 25_000 / KM_PER_AU;
    let cap = flyby;
    let t = 0;
    while (cap < inSystem && t < 60) {
      cap = rampedSpeedCap(Infinity, cap, 1 / 60, E);
      t += 1 / 60;
    }
    expect(t).toBeGreaterThan(2);
    expect(t).toBeLessThan(8);
  });
});

describe('advanceBodyCap — the governor latch', () => {
  const COMMANDED = 25_000 / KM_PER_AU; // the in-system default
  const DT = 1 / 60;

  it('stays latched (clear timer pinned at zero) while a body binds', () => {
    let s = initialBodyCapState();
    const geomCap = COMMANDED / 10;
    for (let t = 0; t < 3; t += DT) s = advanceBodyCap(s, geomCap, MOON_CAP_RELEASE_EFOLD_S, COMMANDED, true, DT);
    expect(s.engaged).toBe(true);
    expect(s.unboundS).toBe(0);
    expect(s.applied).toBe(Infinity); // bypassed…
    expect(s.candidate).toBeCloseTo(geomCap, 12); // …but the ramp memory stays live
  });

  it('completes the clear-hold only after a sustained unbound stretch', () => {
    let s = initialBodyCapState();
    s = advanceBodyCap(s, COMMANDED / 10, MOON_CAP_RELEASE_EFOLD_S, COMMANDED, true, DT); // bound once
    let held = 0;
    while (s.unboundS < BODY_CAP_CLEAR_HOLD_S) {
      s = advanceBodyCap(s, Infinity, MOON_CAP_RELEASE_EFOLD_S, COMMANDED, true, DT); // flying away
      held += DT;
      expect(held).toBeLessThan(BODY_CAP_CLEAR_HOLD_S + 1); // and it can't wedge
    }
    expect(s.unboundS).toBeGreaterThanOrEqual(BODY_CAP_CLEAR_HOLD_S);
  });

  it('a one-frame grazing re-bind resets the hold instead of clearing through it', () => {
    let s = initialBodyCapState();
    for (let t = 0; t < BODY_CAP_CLEAR_HOLD_S * 0.9; t += DT) {
      s = advanceBodyCap(s, Infinity, MOON_CAP_RELEASE_EFOLD_S, COMMANDED, true, DT);
    }
    expect(s.unboundS).toBeGreaterThan(0);
    s = advanceBodyCap(s, COMMANDED / 10, MOON_CAP_RELEASE_EFOLD_S, COMMANDED, true, DT); // graze
    expect(s.unboundS).toBe(0);
  });

  it('a parked ship beside a body stays latched on its DIALED speed', () => {
    // The commanded speed ignores the parked state; the latch must too, or
    // parking beside a moon would start clearing the override immediately.
    const geomCap = governedSpeedCap(2 * SHIP_CLEARANCE_AU, 1, K, VMIN);
    const s = advanceBodyCap(initialBodyCapState(), geomCap, MOON_CAP_RELEASE_EFOLD_S, COMMANDED, true, DT);
    expect(s.engaged).toBe(true);
  });

  it('the ramp memory survives a bypass and re-applies the moment it ends', () => {
    let s = initialBodyCapState();
    const geomCap = COMMANDED / 100;
    s = advanceBodyCap(s, geomCap, MOON_CAP_RELEASE_EFOLD_S, COMMANDED, true, DT);
    expect(s.applied).toBe(Infinity);
    s = advanceBodyCap(s, geomCap, MOON_CAP_RELEASE_EFOLD_S, COMMANDED, false, DT); // hatch closes
    expect(s.applied).toBeCloseTo(geomCap, 12); // tight at once — no Infinity restart
  });

  it('the auto-clear hand-off starts clean: no wall ramp survives the bypass edge', () => {
    // Controller contract: when the sustained hold auto-clears the override
    // it resets to initialBodyCapState. Without that, the candidate's
    // wall-level ramp memory (only ~2x grown over the hold) would become the
    // applied cap on the bypass true→false edge and brake a full-speed ship
    // to a crawl for several seconds.
    let s = initialBodyCapState();
    s = advanceBodyCap(s, COMMANDED / 1000, MOON_CAP_RELEASE_EFOLD_S, COMMANDED, true, DT); // deep at a wall, bypassed
    expect(s.candidate).toBeLessThan(COMMANDED); // the memory the reset discards
    s = initialBodyCapState(); // the controller's reset at auto-clear
    s = advanceBodyCap(s, Infinity, MOON_CAP_RELEASE_EFOLD_S, COMMANDED, false, DT); // first un-bypassed frame
    expect(s.applied).toBe(Infinity);
  });

  it('a planet flyby releases at the planet pace, latched through the whole ramp', () => {
    // Passing a planet at the moons' 1 s e-fold puts the ship at thousands
    // of km/s before a turnaround completes — planets release slower, and
    // the pace must persist after the planet stops binding.
    let s = initialBodyCapState();
    const wallCap = COMMANDED / 100;
    s = advanceBodyCap(s, wallCap, PLANET_CAP_RELEASE_EFOLD_S, COMMANDED, false, DT); // planet binds
    expect(s.releaseEfoldS).toBe(PLANET_CAP_RELEASE_EFOLD_S);
    s = advanceBodyCap(s, Infinity, MOON_CAP_RELEASE_EFOLD_S, COMMANDED, false, DT); // nose past the limb
    expect(s.releaseEfoldS).toBe(PLANET_CAP_RELEASE_EFOLD_S); // pace latched, not the frame's default
    expect(s.candidate).toBeCloseTo(wallCap * Math.exp(DT / PLANET_CAP_RELEASE_EFOLD_S), 12);
  });

  it('a moon re-binding mid-release takes the ramp back to the moon pace', () => {
    let s = initialBodyCapState();
    s = advanceBodyCap(s, COMMANDED / 100, PLANET_CAP_RELEASE_EFOLD_S, COMMANDED, false, DT);
    s = advanceBodyCap(s, Infinity, MOON_CAP_RELEASE_EFOLD_S, COMMANDED, false, DT); // planet releasing
    s = advanceBodyCap(s, COMMANDED / 200, MOON_CAP_RELEASE_EFOLD_S, COMMANDED, false, DT); // a moon binds
    expect(s.releaseEfoldS).toBe(MOON_CAP_RELEASE_EFOLD_S);
  });

  it('a planet approach at the in-system default engages ~100,000 km out', () => {
    const engageDistAU = COMMANDED / PLANET_APPROACH_K_PER_S; // cap == speed here
    expect(governedSpeedCap(engageDistAU, 1, PLANET_APPROACH_K_PER_S, VMIN)).toBeCloseTo(COMMANDED, 12);
    expect(engageDistAU * KM_PER_AU).toBeCloseTo(100_000, -3);
  });
});

describe('moonArrivalPose — ladder fixtures', () => {
  const standoff = (name: string) => {
    const inp = catalogInputs(name);
    const pose = moonArrivalPose(inp);
    return { inp, pose, dist: pose.position.distanceTo(inp.moonPos) };
  };

  it('the Moon parks where its disc reads the target size from the camera', () => {
    const { inp, dist } = standoff('Moon');
    const half = (MOON_ARRIVAL_APPARENT_DIAMETER_DEG / 2) * DEG2RAD;
    const raw = inp.renderedR / Math.sin(half) - CAM_DIST_AU;
    expect(dist).toBeCloseTo(raw, 9);
    // The SHIP parks just inside the zero-trail target-size distance and the
    // camera trail closes the remainder, so the ship-to-moon ratio rides the
    // rig (a shorter trail parks the ship farther out while the VIEW stays
    // identical). Bound it by the invariant, not by any one rig's split.
    expect(dist / inp.renderedR).toBeLessThan(1 / Math.sin(half));
    expect(dist / inp.renderedR).toBeGreaterThan(1 / Math.sin(half) - 1);
  });

  it('Phobos still binds on the separation cap, Deimos on the legacy floor', () => {
    const phobos = standoff('Phobos');
    expect(phobos.dist).toBeCloseTo(phobos.inp.orbitR * MOON_ARRIVAL_SEPARATION_CAP, 9);
    const deimos = standoff('Deimos');
    expect(deimos.dist).toBeCloseTo(MOON_ARRIVAL_STANDOFF_FLOOR_AU, 9);
  });

  it('the aim is a flyby: off the center, above the collision bubble, under the swing ceiling', () => {
    for (const name of ['Moon', 'Titan', 'Io', 'Phobos', 'Deimos', 'Charon', 'Phoebe', 'Miranda']) {
      const { inp, pose, dist } = standoff(name);
      const b = pose.aimPoint.distanceTo(inp.moonPos);
      const collisionR = moonCollisionRadius(inp.renderedR, inp.shipClearance);
      expect(b).toBeGreaterThanOrEqual(collisionR * 1.15 - 1e-12);
      const offAxis =
        pose.aimPoint.clone().sub(pose.position).angleTo(inp.moonPos.clone().sub(pose.position));
      expect(offAxis * RAD2DEG).toBeLessThanOrEqual(MOON_ARRIVAL_MAX_OFFAXIS_DEG + 0.01);
      expect(Math.atan2(b, dist) * RAD2DEG).toBeCloseTo(offAxis * RAD2DEG, 5);
    }
  });
});

describe('moonArrivalPose — catalog sweep (all moons, three orbit phases)', () => {
  const angles = [0.7, 2.4, 4.1];

  it('every arrival in the catalog satisfies the standoff and flyby invariants', () => {
    for (const moon of MOONS) {
      for (const angle of angles) {
        const inp = catalogInputs(moon.name, angle);
        const pose = moonArrivalPose(inp);
        const dist = pose.position.distanceTo(inp.moonPos);
        const collisionR = moonCollisionRadius(inp.renderedR, inp.shipClearance);

        for (const v of [pose.position, pose.aimPoint]) {
          expect(Number.isFinite(v.x + v.y + v.z), `${moon.name}: finite pose`).toBe(true);
        }
        // Standoff sits outside the moon's own bubble and inside the
        // parent-separation cap.
        expect(dist, `${moon.name}: standoff vs bubble`).toBeGreaterThan(collisionR * 1.5 - 1e-12);
        expect(dist, `${moon.name}: separation cap`).toBeLessThanOrEqual(
          inp.orbitR * MOON_ARRIVAL_SEPARATION_CAP + 1e-12,
        );
        // The arrival point clears the parent's clearance bubble.
        expect(
          pose.position.distanceTo(inp.parentPos),
          `${moon.name}: parent clearance`,
        ).toBeGreaterThan(inp.parentClearance - 1e-12);
        // The flyby misses the moon: closest approach of the forward ray to
        // the moon's center is the impact parameter, above the bubble.
        const fwd = pose.aimPoint.clone().sub(pose.position).normalize();
        const toMoon = inp.moonPos.clone().sub(pose.position);
        const closest = toMoon
          .clone()
          .addScaledVector(fwd, -toMoon.dot(fwd))
          .length();
        expect(closest, `${moon.name}: flyby miss distance`).toBeGreaterThanOrEqual(
          collisionR * 1.15 - 1e-12,
        );
      }
    }
  });

  it('where the apparent-size term binds, the camera really sees the target size', () => {
    const half = (MOON_ARRIVAL_APPARENT_DIAMETER_DEG / 2) * DEG2RAD;
    let checked = 0;
    for (const moon of MOONS) {
      const inp = catalogInputs(moon.name);
      const raw = inp.renderedR / Math.sin(half) - CAM_DIST_AU;
      const pose = moonArrivalPose(inp);
      const dist = pose.position.distanceTo(inp.moonPos);
      if (Math.abs(dist - raw) > 1e-9) continue; // a floor or cap bound instead
      // Compose the real chase-camera pose: camDist behind the ship along
      // the heading, lifted 0.45·camDist (resetCruiseCamera's rig).
      const fwd = pose.aimPoint.clone().sub(pose.position).normalize();
      const camPos = pose.position
        .clone()
        .addScaledVector(fwd, -CAM_DIST_AU)
        .add(new THREE.Vector3(0, CAM_DIST_AU * 0.45, 0));
      const apparentDeg = 2 * Math.asin(inp.renderedR / camPos.distanceTo(inp.moonPos)) * RAD2DEG;
      expect(apparentDeg).toBeGreaterThan(MOON_ARRIVAL_APPARENT_DIAMETER_DEG - 0.5);
      expect(apparentDeg).toBeLessThan(MOON_ARRIVAL_APPARENT_DIAMETER_DEG + 0.5);
      checked++;
    }
    // The big-moon half of the catalog binds on apparent size — make sure
    // the assertion actually ran there.
    expect(checked).toBeGreaterThan(20);
  });

  it('a parent-bubble arrival falls back to the outward radial', () => {
    // Synthetic: force the bubble with an oversized clearance; the arrival
    // must sit on the parent→moon radial, beyond the moon.
    const parentPos = new THREE.Vector3(1, 0, 0);
    const moonPos = parentPos.clone().add(new THREE.Vector3(3e-4, 0, 0));
    const pose = moonArrivalPose({
      moonPos,
      parentPos,
      orbitR: 3e-4,
      renderedR: 1e-5,
      parentCollision: 2e-4,
      parentClearance: 1e-3, // bubble swallows every sunward option
      camDist: CAM_DIST_AU,
      shipClearance: SHIP_CLEARANCE_AU,
    });
    const radial = moonPos.clone().sub(parentPos).normalize();
    const fromMoon = pose.position.clone().sub(moonPos).normalize();
    expect(fromMoon.dot(radial)).toBeCloseTo(1, 6);
    // Parent dead ahead past the moon: the aim still exists, is finite, and
    // still misses the moon itself (the parent pushback owns what's beyond).
    expect(pose.aimPoint.distanceTo(moonPos)).toBeGreaterThan(0);
  });
});
