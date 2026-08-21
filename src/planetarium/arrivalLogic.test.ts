import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  advanceBodyCap,
  autopilotAimBlend,
  autopilotArrived,
  autopilotCloseStandoffAU,
  autopilotGlideCap,
  governedSpeedCap,
  initialBodyCapState,
  moonArrivalCameraLookWeight,
  moonArrivalReleaseFade,
  moonArrivalTrackEngage,
  MOON_ARRIVAL_ENGAGE_FULL_RATIO,
  MOON_ARRIVAL_ENGAGE_START_RATIO,
  MOON_ARRIVAL_RELEASE_S,
  moonArrivalPose,
  moonArrivalStandoffAU,
  moonCollisionRadius,
  rampedSpeedCap,
  sunArrivalPose,
  sweepSegmentSphere,
  BODY_APPROACH_V_MIN_AU_S,
  BODY_CAP_CLEAR_HOLD_S,
  CAP_TRANSITION_TAU_S,
  LEAVE_HEADSTART_RADII,
  LEAVE_VALVE_KNEE_RADII,
  MOON_APPROACH_K_PER_S,
  PLANET_APPROACH_K_PER_S,
  MOON_ARRIVAL_APPARENT_DIAMETER_DEG,
  MOON_ARRIVAL_IMPACT_RADII,
  MOON_ARRIVAL_MAX_OFFAXIS_DEG,
  MOON_ARRIVAL_SEPARATION_CAP,
  MOON_ARRIVAL_STANDOFF_FLOOR_AU,
  MOON_FLYTHROUGH_MIN_IMPACT_CAM_DISTS,
  SUN_APPROACH_SURFACE_RADII,
  SUN_ARRIVAL_RADII,
  type BodyCapState,
  type MoonArrivalInputs,
} from './arrivalLogic';
import { MOONS } from './planets/moonData';
import { PLANETARIUM_BODIES, SUN_DATA } from './planets/planetData';
import { KM_PER_AU } from '../astronomy/constants';
import { DEG2RAD, RAD2DEG } from '../shared/math/angles';
// The REAL rig constants — this sweep must see exactly the rig the app
// flies (mirrored copies here once meant a rig change couldn't fail a test).
import { SHIP_CLEARANCE_AU, CRUISE_CAM_DIST_AU as CAM_DIST_AU, chaseIdealOffset } from './cruiseView';
// The chase rig lifts along the flight horizon, not world-Y: compose the
// camera pose from the production function so a rig or frame change re-runs
// every arrival invariant instead of quietly passing on a stale approximation.
import { FLIGHT_UP_SCENE } from './flightFrame';
// Same rule for rendered sizes: the sweep derives them from the production
// curve, so a sizing change re-exercises every pose invariant automatically.
import { MOON_RENDER_ANCHOR_RATIO, renderedMoonRadiusAU } from './moonRenderSize';

const K = MOON_APPROACH_K_PER_S;
const VMIN = BODY_APPROACH_V_MIN_AU_S;

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
    renderedR: renderedMoonRadiusAU(moon.radiusAU, parent.radiusAU, MOON_RENDER_ANCHOR_RATIO),
    parentCollision,
    parentClearance: parentCollision * 1.25, // ring factor varies; the sweep uses the base
    camDist: CAM_DIST_AU,
    shipClearance: SHIP_CLEARANCE_AU,
  };
}

describe('governedSpeedCap', () => {
  // A Moon-class synthetic body: rendered radius 1e-5 AU (~1,500 km).
  const R = 1e-5;

  it('head-on approach is capped at K × surface distance', () => {
    expect(governedSpeedCap(1e-4, R, 1, K, VMIN)).toBeCloseTo(1e-4 * K, 12);
  });

  it('the floor keeps a creep speed available at — and inside — the surface', () => {
    expect(governedSpeedCap(0, R, 1, K, VMIN)).toBe(VMIN);
    expect(governedSpeedCap(1e-9, R, 1, K, VMIN)).toBe(VMIN);
    // A swept endpoint momentarily inside the surface: raw negative surface
    // distance still floors the approach term instead of going negative.
    expect(governedSpeedCap(-1e-6, R, 1, K, VMIN)).toBe(VMIN);
  });

  // The leave law's datum: the collision shell the resolvers park on.
  const SHELL = R + SHIP_CLEARANCE_AU;

  it('receding or side-on flight is capped at exactly the leave law', () => {
    // THE departure contract: leaving speed is a function of where you are —
    // the approach K on the head-started shell height, opened by the valve —
    // never Infinity, never a time ramp.
    const lift = (1e-4 - SHIP_CLEARANCE_AU) + LEAVE_HEADSTART_RADII * SHELL;
    const law = K * lift * (lift / (LEAVE_VALVE_KNEE_RADII * SHELL)) ** 2;
    expect(governedSpeedCap(1e-4, R, 0, K, VMIN)).toBeCloseTo(law, 12);
    expect(governedSpeedCap(1e-4, R, -1, K, VMIN)).toBeCloseTo(law, 12);
  });

  it('parked on the shell, leaving is as unhurried as arriving — the head start is the whole gap', () => {
    // The near-zone contract: the leave cap IS the approach glide, read one
    // head start above the collision shell — a visible creep (~0.05 shell
    // radii/s), nothing like a brisk pull, and below the knee no valve term.
    expect(governedSpeedCap(SHIP_CLEARANCE_AU, R, -1, K, VMIN)).toBeCloseTo(
      K * LEAVE_HEADSTART_RADII * SHELL,
      15,
    );
    const aboveShell = 0.1 * SHELL;
    expect(governedSpeedCap(SHIP_CLEARANCE_AU + aboveShell, R, -1, K, VMIN)).toBeCloseTo(
      K * (aboveShell + LEAVE_HEADSTART_RADII * SHELL),
      15,
    );
  });

  it('at or inside the collision shell the leave cap clamps to the parked creep', () => {
    const parked = K * LEAVE_HEADSTART_RADII * SHELL;
    expect(governedSpeedCap(SHIP_CLEARANCE_AU * 0.5, R, -1, K, VMIN)).toBeCloseTo(parked, 15);
    expect(governedSpeedCap(0, R, -1, K, VMIN)).toBeCloseTo(parked, 15);
    expect(governedSpeedCap(-0.9 * R, R, -1, K, VMIN)).toBeCloseTo(parked, 15);
  });

  it('the grazing band blends the two laws harmonically', () => {
    // Posed close in, where the two laws are comparable (lift below the knee).
    const h = 2e-6;
    const vIn = Math.max(h * K, VMIN);
    const vOut = K * ((h - SHIP_CLEARANCE_AU) + LEAVE_HEADSTART_RADII * SHELL);
    // Half-smoothstep: the harmonic mean of the closing glide and the leave law.
    expect(governedSpeedCap(h, R, 0.15, K, VMIN)).toBeCloseTo(
      1 / (0.5 / vIn + 0.5 / vOut),
      12,
    );
  });

  it('a giant body keeps the proven closing band: harmonic ≈ the old vIn/w fade', () => {
    // Jupiter-class shell contact: vOut/vIn ~ 185. An arithmetic blend would
    // hand a near-tangent CLOSING course half the leave law (~1,900 km/s);
    // the harmonic blend stays within a hair under the historical vIn/w.
    const surfaceDist = 5.44e-7; // one ship clearance off the shell
    const giantR = 5e-4;
    const vIn = Math.max(surfaceDist * K, VMIN);
    const oldLaw = vIn / 0.5;
    const cap = governedSpeedCap(surfaceDist, giantR, 0.15, K, VMIN);
    expect(cap).toBeLessThan(oldLaw);
    expect(cap).toBeGreaterThan(oldLaw * 0.99);
  });

  it('the release valve is inert below the knee, continuous at it, cubic past it', () => {
    const knee = LEAVE_VALVE_KNEE_RADII * SHELL; // head-started shell height at the knee
    // Raw surface distance whose shell height reaches the knee lift.
    const kneeDist = SHIP_CLEARANCE_AU + (LEAVE_VALVE_KNEE_RADII - LEAVE_HEADSTART_RADII) * SHELL;
    expect(governedSpeedCap(kneeDist, R, -1, K, VMIN)).toBeCloseTo(K * knee, 12);
    // 10% past the knee: the law picks up a (1.1)² opening.
    expect(governedSpeedCap(kneeDist + 0.1 * knee, R, -1, K, VMIN)).toBeCloseTo(
      K * 1.1 * knee * 1.21,
      10,
    );
    // Ten knees out the opening is ×100: any dialed speed is loose change
    // against the cube, which is what frees a departure within seconds.
    expect(governedSpeedCap(kneeDist + 9 * knee, R, -1, K, VMIN)).toBeCloseTo(
      K * 10 * knee * 100,
      8,
    );
  });

  it('is monotone in the approach cosine: swinging the nose in only tightens', () => {
    let prev = 0;
    for (const cos of [0.9, 0.3, 0.2, 0.1, 0.05, 0, -0.5]) {
      const cap = governedSpeedCap(1e-4, R, cos, K, VMIN);
      if (prev > 0) expect(cap).toBeGreaterThanOrEqual(prev);
      prev = cap;
    }
  });

  it('closer means slower, monotonically, closing and receding alike', () => {
    for (const cos of [1, -1]) {
      let prev = Infinity;
      for (const d of [1e-3, 1e-4, 1e-5, 1e-6]) {
        const cap = governedSpeedCap(d, R, cos, K, VMIN);
        expect(cap).toBeLessThan(prev);
        prev = cap;
      }
    }
  });

  it('beyond the band the cap is exactly the base — no over-tightening', () => {
    expect(governedSpeedCap(2e-4, R, 0.9, K, VMIN)).toBeCloseTo(2e-4 * K, 12);
  });
});

describe('rampedSpeedCap', () => {
  const TAU = CAP_TRANSITION_TAU_S;

  it('tightening applies instantly, including first contact from Infinity', () => {
    expect(rampedSpeedCap(1e-6, Infinity, 1 / 60, TAU)).toBe(1e-6);
    expect(rampedSpeedCap(1e-7, 1e-6, 1 / 60, TAU)).toBe(1e-7);
  });

  it('a steady cap passes through unchanged', () => {
    expect(rampedSpeedCap(1e-6, 1e-6, 1 / 60, TAU)).toBe(1e-6);
    expect(rampedSpeedCap(Infinity, Infinity, 1 / 60, TAU)).toBe(Infinity);
  });

  it('loosening eases the residual: 1 − 1/e of the gap per τ, never past the target', () => {
    expect(rampedSpeedCap(1e-5, 1e-6, TAU, TAU)).toBeCloseTo(
      1e-6 + (1e-5 - 1e-6) * (1 - Math.exp(-1)),
      15,
    );
    // Long dt converges to the target instead of overshooting it.
    expect(rampedSpeedCap(2e-6, 1e-6, 100 * TAU, TAU)).toBeCloseTo(2e-6, 15);
  });

  it('normalized progress is body-scale independent', () => {
    // The same fraction of the gap closes per unit time whether the target
    // is a moonlet's leave law or a giant's — the multiplicative ramp this
    // replaces needed ~2.4 s beside Jupiter vs ~1.1 s at the Moon.
    const frac = (target: number) =>
      (rampedSpeedCap(target, 1e-6, 2 * TAU, TAU) - 1e-6) / (target - 1e-6);
    expect(frac(1e-5)).toBeCloseTo(frac(1e-2), 12);
    expect(frac(1e-5)).toBeCloseTo(1 - Math.exp(-2), 12);
  });

  it('is frame-rate independent for a given elapsed time', () => {
    const target = 3e-6;
    const run = (dts: number[]) => {
      let cap = 1e-7;
      for (const dt of dts) cap = rampedSpeedCap(target, cap, dt, TAU);
      return cap;
    };
    const total = 1.05;
    const at60 = run(new Array(63).fill(total / 63));
    const at30 = run(new Array(31).fill(total / 31)); // ~34 ms frames
    const hitchy = run([0.1, ...new Array(57).fill((total - 0.1) / 57)]);
    const oneStep = run([total]);
    expect(at60 / oneStep).toBeCloseTo(1, 12);
    expect(at30 / oneStep).toBeCloseTo(1, 12);
    expect(hitchy / oneStep).toBeCloseTo(1, 12);
  });

  it('a bodiless frame (Infinity target) releases outright', () => {
    expect(rampedSpeedCap(Infinity, 1e-6, 1 / 60, TAU)).toBe(Infinity);
  });
});

describe('advanceBodyCap — the governor latch', () => {
  const COMMANDED = 25_000 / KM_PER_AU; // the in-system default
  const DT = 1 / 60;

  it('stays latched (clear timer pinned at zero) while a body binds', () => {
    let s = initialBodyCapState();
    const geomCap = COMMANDED / 10;
    for (let t = 0; t < 3; t += DT) s = advanceBodyCap(s, geomCap, COMMANDED, true, DT);
    expect(s.engaged).toBe(true);
    expect(s.unboundS).toBe(0);
    expect(s.applied).toBe(Infinity); // bypassed…
    expect(s.candidate).toBeCloseTo(geomCap, 12); // …but the transition memory stays live
  });

  it('does not latch on a cap the dialed speed never reaches', () => {
    const s = advanceBodyCap(initialBodyCapState(), COMMANDED * 2, COMMANDED, true, DT);
    expect(s.engaged).toBe(false);
  });

  it('completes the clear-hold only after a sustained unbound stretch', () => {
    let s = initialBodyCapState();
    s = advanceBodyCap(s, COMMANDED / 10, COMMANDED, true, DT); // bound once
    let held = 0;
    while (s.unboundS < BODY_CAP_CLEAR_HOLD_S) {
      s = advanceBodyCap(s, COMMANDED * 10, COMMANDED, true, DT); // far past the body
      held += DT;
      expect(held).toBeLessThan(BODY_CAP_CLEAR_HOLD_S + 1); // and it can't wedge
    }
    expect(s.unboundS).toBeGreaterThanOrEqual(BODY_CAP_CLEAR_HOLD_S);
  });

  it('a one-frame grazing re-bind resets the hold instead of clearing through it', () => {
    let s = initialBodyCapState();
    for (let t = 0; t < BODY_CAP_CLEAR_HOLD_S * 0.9; t += DT) {
      s = advanceBodyCap(s, COMMANDED * 10, COMMANDED, true, DT);
    }
    expect(s.unboundS).toBeGreaterThan(0);
    s = advanceBodyCap(s, COMMANDED / 10, COMMANDED, true, DT); // graze
    expect(s.unboundS).toBe(0);
  });

  it('a parked ship beside a body stays latched on its DIALED speed', () => {
    // The commanded speed ignores the parked state; the latch must too, or
    // parking beside a moon would start clearing the override immediately.
    const geomCap = governedSpeedCap(2 * SHIP_CLEARANCE_AU, 1.16e-5, 1, K, VMIN);
    const s = advanceBodyCap(initialBodyCapState(), geomCap, COMMANDED, true, DT);
    expect(s.engaged).toBe(true);
    // Nose-away parked is the leave law's own creep — far under any dial,
    // so pointing out to sea while parked cannot start the auto-clear either.
    const geomAway = governedSpeedCap(SHIP_CLEARANCE_AU, 1.16e-5, -1, K, VMIN);
    expect(advanceBodyCap(initialBodyCapState(), geomAway, COMMANDED, true, DT).engaged).toBe(true);
  });

  it('under the leave law, an override departure unbinds only once genuinely away', () => {
    // `engaged` holds until the leave law crosses the commanded speed. A
    // full-override sprint outruns the opened valve within a dozen radii,
    // so the clear-hold completes in about a second of flight — but the
    // ship is many radii gone by then, and a parked or grinding ship beside
    // the shell (cap ~ the glide, far under any dial) never unbinds at all.
    const R = 1.16e-5;
    let d = R + SHIP_CLEARANCE_AU; // center distance, from the shell
    let s = initialBodyCapState();
    let t = 0;
    while (s.unboundS < BODY_CAP_CLEAR_HOLD_S && t < 20) {
      const geom = governedSpeedCap(d - R, R, -1, K, VMIN);
      s = advanceBodyCap(s, geom, COMMANDED, true, DT);
      d += COMMANDED * DT; // bypass: the ship flies the dialed speed
      t += DT;
    }
    expect(t).toBeGreaterThan(0.5);
    expect(t).toBeLessThan(2);
    expect(d / R).toBeGreaterThan(8);
  });

  it('the transition memory survives a bypass and re-applies the moment it ends', () => {
    let s = initialBodyCapState();
    const geomCap = COMMANDED / 100;
    s = advanceBodyCap(s, geomCap, COMMANDED, true, DT);
    expect(s.applied).toBe(Infinity);
    s = advanceBodyCap(s, geomCap, COMMANDED, false, DT); // hatch closes
    expect(s.applied).toBeCloseTo(geomCap, 12); // tight at once — no Infinity restart
  });

  it('the auto-clear hand-off starts clean: no wall memory survives the bypass edge', () => {
    // Controller contract: when the sustained hold auto-clears the override
    // it resets to initialBodyCapState. Without that, the candidate's
    // wall-level memory would become the applied cap on the bypass
    // true→false edge and brake a full-speed ship mid-flight.
    let s = initialBodyCapState();
    s = advanceBodyCap(s, COMMANDED / 1000, COMMANDED, true, DT); // deep at a wall, bypassed
    expect(s.candidate).toBeLessThan(COMMANDED); // the memory the reset discards
    s = initialBodyCapState(); // the controller's reset at auto-clear
    s = advanceBodyCap(s, COMMANDED * 100, COMMANDED, false, DT); // first un-bypassed frame, body far behind
    expect(s.applied).toBeGreaterThan(COMMANDED); // unbinding — no crawl hand-off
  });

  it('a planet approach at the in-system default engages ~100,000 km out', () => {
    const engageDistAU = COMMANDED / PLANET_APPROACH_K_PER_S; // cap == speed here
    expect(governedSpeedCap(engageDistAU, 4.26e-5, 1, PLANET_APPROACH_K_PER_S, VMIN)).toBeCloseTo(COMMANDED, 12);
    expect(engageDistAU * KM_PER_AU).toBeCloseTo(100_000, -3);
  });
});

describe('departure feel — the reported outcomes, closed loop', () => {
  // The reported complaints as asserts. Before this design, a Moon-shell
  // release moved ~5 km in the first half second and ~33 km in the first
  // full second (invisible against a 1,738 km body — "still stuck"), then
  // the time-exponential ripped the gap 2×→20× in under 3 s ("shoots off in
  // an instant"). Measured: scratchpad collide-before/report.md, 2026-08-11.
  // The shape flown here is the three-zone departure: really slow beside
  // the body (arrival pacing), picking up through the knee, and free of the
  // governor entirely within a few seconds — at any dial, at any body scale.
  const R = 1.1616e-5; // the Moon as rendered
  const DT = 1 / 60;
  const COMMANDED = 25_000 / KM_PER_AU;

  /** Simulate a release from a shell grind: cap pinned at the closing glide,
   *  nose flipped out, then plain forward integration under the governor. */
  function simulateRelease(seconds: number, commanded = COMMANDED, bodyR = R) {
    const shell = bodyR + SHIP_CLEARANCE_AU;
    const pin = governedSpeedCap(shell - bodyR, bodyR, 1, K, VMIN);
    let s: BodyCapState = { candidate: pin, applied: pin, engaged: true, unboundS: 0 };
    let d = shell;
    const samples: { t: number; d: number; speed: number }[] = [{ t: 0, d, speed: pin }];
    for (let t = DT; t <= seconds + 1e-9; t += DT) {
      const geom = governedSpeedCap(d - bodyR, bodyR, -1, K, VMIN);
      s = advanceBodyCap(s, geom, commanded, false, DT);
      const speed = Math.min(commanded, s.applied);
      d += speed * DT;
      samples.push({ t, d, speed });
    }
    return samples;
  }

  const gainedKm = (samples: { t: number; d: number }[], t: number) => {
    const shell = R + SHIP_CLEARANCE_AU;
    return (samples.find((r) => r.t >= t - 1e-9)!.d - shell) * KM_PER_AU;
  };

  it('no dead-stick, but no pull either: the first second is a visible creep', () => {
    // Alive from the first frame — well clear of the ~33 km/s-equivalent
    // freeze that read as "stuck" — while staying at arrival pacing, a
    // fraction of the old brisk law's ~540 km opening second.
    const samples = simulateRelease(1.0);
    expect(gainedKm(samples, 0.5)).toBeGreaterThan(18);
    expect(gainedKm(samples, 1.0)).toBeGreaterThan(55);
    expect(gainedKm(samples, 1.0)).toBeLessThan(140);
  });

  it('really slow beside the body: the first three seconds hold arrival pacing', () => {
    // Sub-knee the leave law IS the approach glide (head-started), so three
    // seconds out the ship is still beside the Moon, creeping under ~300 km/s
    // — plenty of window to change your mind and turn back.
    const samples = simulateRelease(3.0);
    for (const r of samples) {
      expect(r.speed * KM_PER_AU, `t=${r.t.toFixed(2)}`).toBeLessThan(300);
    }
    expect(gainedKm(samples, 3.0)).toBeLessThan(650);
  });

  it('no bang: through the slow zone the speed TRACKS the law, not a spool', () => {
    // Chasing a target that grows as it is chased leaves a steady lag of
    // ~1/(1 + K·τ) — derived, so re-tuning either knob re-derives the
    // expectation; discrete 60 Hz integration sits a couple points under
    // the continuous equilibrium. Speed may trail the law; never exceed it.
    const floor = 0.96 / (1 + K * CAP_TRANSITION_TAU_S);
    const shell = R + SHIP_CLEARANCE_AU;
    const samples = simulateRelease(3.5);
    for (const r of samples) {
      if (r.t <= 3 * CAP_TRANSITION_TAU_S) continue;
      if (r.d - shell + LEAVE_HEADSTART_RADII * shell >= 0.9 * LEAVE_VALVE_KNEE_RADII * shell) break;
      const law = governedSpeedCap(r.d - R, R, -1, K, VMIN);
      expect(r.speed / law, `t=${r.t.toFixed(2)}`).toBeGreaterThan(floor);
      expect(r.speed).toBeLessThanOrEqual(law + 1e-15);
    }
  });

  it('then it picks up and runs entirely free within a few seconds — at any dial', () => {
    // The commitment contract: by the time the ship has clearly left, no
    // throttle at all. The bands are deliberately tight around the tuned
    // timeline (slow-zone handoff ~3 s, free ~5.9 s at the default dial) so
    // a drifted head start or knee fails here instead of hiding in slack.
    // The ramp stays continuous — per-frame speed never steps more than ~a
    // sixth, a steady surge rather than a bang.
    for (const { dialKmS, freeMin, freeMax } of [
      { dialKmS: 25_000, freeMin: 5.4, freeMax: 6.5 },
      { dialKmS: 892, freeMin: 4.4, freeMax: 5.7 },
    ]) {
      const commanded = dialKmS / KM_PER_AU;
      const samples = simulateRelease(8.0, commanded);
      const free = samples.find((r) => r.speed >= commanded * 0.999);
      expect(free, `dial ${dialKmS}`).toBeDefined();
      expect(free!.t, `dial ${dialKmS}`).toBeGreaterThan(freeMin);
      expect(free!.t, `dial ${dialKmS}`).toBeLessThan(freeMax);
      for (let i = 2; i < samples.length; i++) {
        expect(samples[i].speed / samples[i - 1].speed, `dial ${dialKmS} t=${samples[i].t.toFixed(2)}`)
          .toBeLessThan(1.35);
      }
    }
  });

  it('one subjective timeline at every scale — the shell, not the rendered radius, is the datum', () => {
    // A moonlet's fixed hull clearance dwarfs its rendered mesh: measured in
    // rendered radii it would park several "radii" up, past the valve knee,
    // and detonate off the shell in a fraction of a second. Measured from
    // the collision shell, a sub-clearance speck, Styx, and Jupiter all run
    // the Moon's slow-then-free departure.
    const rungs = [
      { bodyR: 1e-7, dialKmS: 25_000 }, // rendered speck far below the clearance
      { bodyR: 22.1 / KM_PER_AU, dialKmS: 25_000 }, // Styx-class
      { bodyR: 1.1616e-5, dialKmS: 892 }, // the Moon at a hand throttle
      { bodyR: 4.78e-4, dialKmS: 25_000 }, // Jupiter
    ];
    for (const { bodyR, dialKmS } of rungs) {
      const tag = `R=${bodyR}`;
      const shellR = bodyR + SHIP_CLEARANCE_AU;
      const commanded = dialKmS / KM_PER_AU;
      // Parked on the shell, nose out: exactly the head-start creep, never
      // under the approach floor — and it latches against the dial, so a
      // parked nose-away ship can't start the override auto-clear.
      const park = governedSpeedCap(SHIP_CLEARANCE_AU, bodyR, -1, K, VMIN);
      expect(park, tag).toBeCloseTo(Math.max(K * LEAVE_HEADSTART_RADII * shellR, VMIN), 15);
      expect(park, tag).toBeGreaterThanOrEqual(VMIN);
      expect(advanceBodyCap(initialBodyCapState(), park, commanded, true, DT).engaged, tag).toBe(true);
      // The closed-loop timeline: sub-knee at 2.5 s, past it by 3.6 s, free
      // within a few seconds — the same story at every rung.
      const samples = simulateRelease(8.0, commanded, bodyR);
      const speedAt = (t: number) => samples.find((r) => r.t >= t - 1e-9)!.speed;
      const kneeSpeed = K * LEAVE_VALVE_KNEE_RADII * shellR;
      expect(speedAt(2.5), tag).toBeLessThan(kneeSpeed);
      expect(speedAt(3.6), tag).toBeGreaterThan(kneeSpeed);
      const free = samples.find((r) => r.speed >= commanded * 0.999);
      expect(free, tag).toBeDefined();
      expect(free!.t, tag).toBeGreaterThan(4.3);
      expect(free!.t, tag).toBeLessThan(7);
      // Continuity is pinned through the visible departure — the slow zone
      // and the handoff (up to 3× the knee speed), past the spool up to the
      // creep. The cubic's FINAL sprint to a dial thousands of times a
      // speck's scale steps as hard as the τ-filter lets it: that abruptness
      // is the release itself, not a bang beside a visible disc — the felt
      // case (the Moon at real dials) is bounded end-to-end above.
      for (let i = 2; i < samples.length; i++) {
        if (samples[i - 1].speed < park || samples[i - 1].speed > 3 * kneeSpeed) continue;
        expect(samples[i].speed / samples[i - 1].speed, `${tag} t=${samples[i].t.toFixed(2)}`)
          .toBeLessThan(1.35);
      }
    }
  });

  it('the asymmetry lives at the ends: symmetric beside the body, unbound once away', () => {
    // At matched heights in the near zone the two laws read the same glide —
    // the head start is the only gap…
    const h = 0.2 * R;
    const closing = governedSpeedCap(h, R, 1, K, VMIN);
    const leaving = governedSpeedCap(h, R, -1, K, VMIN);
    expect(leaving / closing).toBeGreaterThan(1);
    expect(leaving / closing).toBeLessThan(2);
    // …while a few radii out the opened valve has left the approach glide
    // far behind: leaving runs free where arriving is still firmly governed.
    const far = 8 * R;
    expect(governedSpeedCap(far, R, -1, K, VMIN)).toBeGreaterThan(
      50 * governedSpeedCap(far, R, 1, K, VMIN),
    );
  });
});

describe('sweepSegmentSphere — the shared collision test', () => {
  const R = 8.8e-5; // an Earth-class shell

  it('catches a through-pass whose endpoints are both far outside', () => {
    // One override-speed frame out-strides the whole shell diameter — the
    // endpoint-only planet check this replaces tunneled here.
    const hit = sweepSegmentSphere(-2e-3, 1e-5, 0, 2e-3, 1e-5, 0, 0, 0, 0, R);
    expect(hit).not.toBeNull();
    // Pushback points from the center toward the segment's closest approach.
    expect(hit!.oy).toBeCloseTo(1, 9);
    expect(Math.abs(hit!.ox)).toBeLessThan(1e-9);
  });

  it('catches an endpoint inside the shell', () => {
    const hit = sweepSegmentSphere(-2e-3, 0, 0, -R * 0.5, 0, 0, 0, 0, 0, R);
    expect(hit).not.toBeNull();
    expect(hit!.ox).toBeCloseTo(-1, 9); // out the near side it came from
  });

  it('passes a clean miss without contact (and without allocating a hit)', () => {
    expect(sweepSegmentSphere(-2e-3, R * 2, 0, 2e-3, R * 2, 0, 0, 0, 0, R)).toBeNull();
  });

  it('is a SEGMENT, not the infinite line it lies on', () => {
    // A body dead ahead but beyond this frame's step: the ray hits, the
    // travelled segment does not, and only the segment may collide.
    expect(sweepSegmentSphere(-2e-3, 0, 0, -1e-3, 0, 0, 0, 0, 0, R)).toBeNull();
    // …and one behind the start, on the same line running away from it.
    expect(sweepSegmentSphere(1e-3, 0, 0, 2e-3, 0, 0, 0, 0, 0, R)).toBeNull();
    // The same step extended far enough does make contact.
    expect(sweepSegmentSphere(-2e-3, 0, 0, 2e-3, 0, 0, 0, 0, 0, R)).not.toBeNull();
  });

  it('the shell boundary itself is clear — contact means inside it', () => {
    const grazeOutside = sweepSegmentSphere(-2e-3, R, 0, 2e-3, R, 0, 0, 0, 0, R);
    expect(grazeOutside).toBeNull();
    const grazeInside = sweepSegmentSphere(-2e-3, R * 0.999, 0, 2e-3, R * 0.999, 0, 0, 0, 0, R);
    expect(grazeInside).not.toBeNull();
    expect(grazeInside!.oy).toBeCloseTo(1, 9);
  });

  it('a zero-length segment degenerates to the endpoint check', () => {
    expect(sweepSegmentSphere(R * 2, 0, 0, R * 2, 0, 0, 0, 0, 0, R)).toBeNull();
    const hit = sweepSegmentSphere(R * 0.5, 0, 0, R * 0.5, 0, 0, 0, 0, 0, R);
    expect(hit).not.toBeNull();
    expect(hit!.ox).toBeCloseTo(1, 9);
  });

  it('a dead-center pass pushes back along the incoming segment', () => {
    const hit = sweepSegmentSphere(-2e-3, 0, 0, 2e-3, 0, 0, 0, 0, 0, R);
    expect(hit).not.toBeNull();
    expect(hit!.ox).toBeCloseTo(-1, 9);
  });

  it('a zero-length segment dead on the center still yields a finite pushback', () => {
    const hit = sweepSegmentSphere(0, 0, 0, 0, 0, 0, 0, 0, 0, R);
    expect(hit).not.toBeNull();
    expect(Math.hypot(hit!.ox, hit!.oy, hit!.oz)).toBeCloseTo(1, 12);
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

  it('Charon still binds on the separation cap, Styx on the standoff floor', () => {
    const charon = standoff('Charon');
    expect(charon.dist).toBeCloseTo(charon.inp.orbitR * MOON_ARRIVAL_SEPARATION_CAP, 9);
    const styx = standoff('Styx');
    expect(styx.dist).toBeCloseTo(MOON_ARRIVAL_STANDOFF_FLOOR_AU, 9);
  });

  it('Phobos and Deimos escape the old dot-arrival floor: the apparent-size term binds', () => {
    const half = (MOON_ARRIVAL_APPARENT_DIAMETER_DEG / 2) * DEG2RAD;
    for (const name of ['Phobos', 'Deimos']) {
      const { inp, dist } = standoff(name);
      expect(dist, `${name}: apparent-size standoff`).toBeCloseTo(
        inp.renderedR / Math.sin(half) - CAM_DIST_AU,
        9,
      );
    }
  });

  it('the aim is a flyby: off the center, above the collision bubble, under the swing ceiling', () => {
    for (const name of ['Moon', 'Titan', 'Io', 'Charon', 'Phoebe', 'Miranda']) {
      const { inp, pose, dist } = standoff(name);
      const b = pose.aimPoint.distanceTo(inp.moonPos);
      const collisionR = moonCollisionRadius(inp.renderedR, inp.shipClearance);
      expect(b).toBeGreaterThanOrEqual(collisionR * 1.15 - 1e-12);
      // The swing ceiling holds except where the clearance floor outranks it
      // (close parks on the smallest meshes); even there the swing stays
      // shallow — a hand-width past the ceiling, not out of frame. The
      // clearance aim is the exact perpendicular-miss form the pose uses.
      const missM = collisionR * 1.15;
      const clearanceDeg =
        Math.atan2((missM * dist) / Math.sqrt(dist * dist - missM * missM), dist) * RAD2DEG;
      const offAxis =
        pose.aimPoint.clone().sub(pose.position).angleTo(inp.moonPos.clone().sub(pose.position));
      expect(offAxis * RAD2DEG).toBeLessThanOrEqual(
        Math.max(MOON_ARRIVAL_MAX_OFFAXIS_DEG, clearanceDeg) + 0.01,
      );
      expect(offAxis * RAD2DEG).toBeLessThanOrEqual(15);
      expect(Math.atan2(b, dist) * RAD2DEG).toBeCloseTo(offAxis * RAD2DEG, 5);
    }
  });
});

describe('moon teleport camera tracking', () => {
  /** Axis ratio of a sphere's conic silhouette under a rectilinear perspective
   *  projection. A centred sphere is 1; a large off-axis sphere is > 1. */
  const projectedAxisRatio = (
    cameraPos: THREE.Vector3,
    cameraForward: THREE.Vector3,
    sphereCenter: THREE.Vector3,
    radius: number,
  ) => {
    const toSphere = sphereCenter.clone().sub(cameraPos);
    const depth = toSphere.dot(cameraForward.clone().normalize());
    return Math.sqrt(
      (toSphere.lengthSq() - radius * radius) /
      (depth * depth - radius * radius),
    );
  };

  it('reproduces the oval on the ship-centred chase ray and removes it when tracking the Moon', () => {
    const inp = catalogInputs('Moon');
    const pose = moonArrivalPose(inp);
    const flightForward = pose.aimPoint.clone().sub(pose.position).normalize();
    const startToMoon = inp.moonPos.clone().sub(pose.position);
    const startAlong = startToMoon.dot(flightForward);

    // A deterministic point on the real flyby line: close enough that the
    // Moon is large, still four rendered radii ahead, and visibly stretched
    // when the optical axis remains pinned to the ship.
    const shipPos = pose.position
      .clone()
      .addScaledVector(flightForward, startAlong - inp.renderedR * 4);
    const cameraPos = shipPos
      .clone()
      .add(chaseIdealOffset(flightForward, FLIGHT_UP_SCENE, new THREE.Vector3()));
    const shipCentredForward = shipPos.clone().sub(cameraPos).normalize();
    const ovalRatio = projectedAxisRatio(
      cameraPos,
      shipCentredForward,
      inp.moonPos,
      inp.renderedR,
    );
    expect(ovalRatio).toBeGreaterThan(1.1);

    const cameraDistance = cameraPos.distanceTo(inp.moonPos);
    const arrivalCameraDistance = pose.position
      .clone()
      .add(chaseIdealOffset(flightForward, FLIGHT_UP_SCENE, new THREE.Vector3()))
      .distanceTo(inp.moonPos);
    const weight = moonArrivalCameraLookWeight(
      cameraDistance,
      arrivalCameraDistance,
      false,
    );
    const trackedTarget = shipPos.clone().lerp(inp.moonPos, weight);
    const trackedForward = trackedTarget.sub(cameraPos).normalize();
    expect(projectedAxisRatio(
      cameraPos,
      trackedForward,
      inp.moonPos,
      inp.renderedR,
    )).toBeCloseTo(1, 10);
  });

  it('holds through approach, then smoothly releases over one arrival distance', () => {
    const d = 10;
    expect(moonArrivalCameraLookWeight(d * 0.2, d, false)).toBe(1);
    expect(moonArrivalCameraLookWeight(d * 0.2, d, true)).toBe(1);
    expect(moonArrivalCameraLookWeight(d, d, true)).toBe(1);
    expect(moonArrivalCameraLookWeight(d * 1.5, d, true)).toBeCloseTo(0.5, 10);
    expect(moonArrivalCameraLookWeight(d * 2, d, true)).toBe(0);
    expect(moonArrivalCameraLookWeight(d * 3, d, true)).toBe(0);
  });

  it('eases a steering release from full weight to zero, never in one frame', () => {
    // Untouched (releaseElapsedS null → callers pass 0) the fade is inert.
    expect(moonArrivalReleaseFade(0)).toBe(1);
    // The first steered frame must NOT collapse the look — that one-frame
    // collapse was the visible camera snap on the first touch after a moon
    // teleport (the touch zone turns a stationary tap into full steering).
    expect(moonArrivalReleaseFade(1 / 60)).toBeGreaterThan(0.9);
    // Monotone decay across the window...
    let prev = 1;
    for (let t = 0; t <= MOON_ARRIVAL_RELEASE_S + 0.01; t += 0.02) {
      const fade = moonArrivalReleaseFade(t);
      expect(fade).toBeLessThanOrEqual(prev);
      prev = fade;
    }
    // ...fully released at the window's end and beyond.
    expect(moonArrivalReleaseFade(MOON_ARRIVAL_RELEASE_S)).toBe(0);
    expect(moonArrivalReleaseFade(MOON_ARRIVAL_RELEASE_S * 5)).toBe(0);
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
        // The arrival class is exactly the gate formula: the flythrough needs
        // its impact parameter to clear the camera boom.
        expect(pose.flythrough, `${moon.name}: arrival class`).toBe(
          inp.renderedR * MOON_ARRIVAL_IMPACT_RADII >=
            inp.camDist * MOON_FLYTHROUGH_MIN_IMPACT_CAM_DISTS,
        );
        const fwd = pose.aimPoint.clone().sub(pose.position).normalize();
        const toMoon = inp.moonPos.clone().sub(pose.position);
        const closest = toMoon
          .clone()
          .addScaledVector(fwd, -toMoon.dot(fwd))
          .length();
        if (pose.flythrough) {
          // The flyby misses the moon: closest approach of the forward ray to
          // the moon's center is the impact parameter, above the bubble.
          expect(closest, `${moon.name}: flyby miss distance`).toBeGreaterThanOrEqual(
            collisionR * 1.15 - 1e-12,
          );
        } else {
          // Planet-style: aimed dead at the body — the governed glide, not
          // miss geometry, is what stops the ship.
          expect(pose.aimPoint.distanceTo(inp.moonPos), `${moon.name}: direct aim`).toBe(0);
        }
      }
    }
  });

  it('the split lands on the named-moon line: classical moons fly, the moonlet swarm parks', () => {
    for (const name of ['Moon', 'Io', 'Europa', 'Ganymede', 'Callisto', 'Titan', 'Triton', 'Charon', 'Miranda', 'Phoebe']) {
      expect(moonArrivalPose(catalogInputs(name)).flythrough, name).toBe(true);
    }
    for (const name of ['Styx', 'Nix', 'Kerberos', 'Hydra', 'Phobos', 'Deimos', 'Pan', 'Cordelia']) {
      expect(moonArrivalPose(catalogInputs(name)).flythrough, name).toBe(false);
    }
  });

  it('every arrival shows a real disc — never the old sub-degree dot', () => {
    // The floor's whole contract after the render curve: the smallest meshes
    // (Styx, ~20 km) still subtend ≥ ~2.5° from the chase camera. Cap-bound
    // arrivals (Charon) legitimately exceed the 5° target; the ceiling is
    // pinned by the binds-on-apparent-size test below.
    for (const moon of MOONS) {
      const inp = catalogInputs(moon.name);
      const pose = moonArrivalPose(inp);
      const fwd = pose.aimPoint.clone().sub(pose.position).normalize();
      const camPos = pose.position
        .clone()
        .add(chaseIdealOffset(fwd, FLIGHT_UP_SCENE, new THREE.Vector3()));
      const apparentDeg = 2 * Math.asin(inp.renderedR / camPos.distanceTo(inp.moonPos)) * RAD2DEG;
      expect(apparentDeg, `${moon.name}: arrival disc`).toBeGreaterThan(2.4);
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
      // the heading, lifted 0.35·camDist (the unified chase rig).
      const fwd = pose.aimPoint.clone().sub(pose.position).normalize();
      const camPos = pose.position
        .clone()
        .add(chaseIdealOffset(fwd, FLIGHT_UP_SCENE, new THREE.Vector3()));
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

describe('sunArrivalPose', () => {
  const R = SUN_DATA.radiusAU;

  it('parks at the standoff on the player radial, looking at the heliocenter', () => {
    const player = new THREE.Vector3(0.9, 0.1, -0.4);
    const pose = sunArrivalPose(player, R);
    expect(pose.position.length()).toBeCloseTo(R * SUN_ARRIVAL_RADII, 12);
    expect(pose.position.clone().normalize().dot(player.clone().normalize())).toBeCloseTo(1, 12);
    expect(pose.lookTarget.length()).toBe(0);
  });

  it('shows a mid-teens-degree disc from well outside the governor shell', () => {
    const dist = sunArrivalPose(new THREE.Vector3(1, 0, 0), R).position.length();
    const discDeg = 2 * Math.asin(R / dist) * RAD2DEG;
    expect(discDeg).toBeGreaterThan(10);
    expect(discDeg).toBeLessThan(20);
    expect(dist).toBeGreaterThan(R * SUN_APPROACH_SURFACE_RADII * 3);
  });

  it('a player at the exact origin still gets a finite pose', () => {
    const pose = sunArrivalPose(new THREE.Vector3(0, 0, 0), R);
    expect(pose.position.length()).toBeCloseTo(R * SUN_ARRIVAL_RADII, 12);
    expect(Number.isFinite(pose.position.x)).toBe(true);
  });
});

describe('moonArrivalStandoffAU — the pose distance, extracted', () => {
  it('equals |pose.position − moonPos| across the whole catalog and three phases', () => {
    // By construction: the pose parks the ship exactly one standoff from the
    // moon (sun-side or the outward-radial fallback, both unit offsets), so the
    // extracted distance must reproduce the pose geometry moon-for-moon.
    for (const moon of MOONS) {
      for (const angle of [0.7, 2.4, 4.1]) {
        const inp = catalogInputs(moon.name, angle);
        const pose = moonArrivalPose(inp);
        expect(moonArrivalStandoffAU(inp), `${moon.name} @ ${angle}`).toBeCloseTo(
          pose.position.distanceTo(inp.moonPos),
          12,
        );
      }
    }
  });
});

describe('autopilotGlideCap', () => {
  const S = 1e-4;

  it('is zero at the standoff and inside it — the cruise comes to rest there', () => {
    expect(autopilotGlideCap(S, S)).toBe(0);
    expect(autopilotGlideCap(S * 0.5, S)).toBe(0);
    expect(autopilotGlideCap(0, S)).toBe(0);
  });

  it('is K × the distance past the standoff, not the surface', () => {
    expect(autopilotGlideCap(3 * S, S)).toBeCloseTo(K * 2 * S, 15);
  });

  it('is continuous and monotonically slower closing in', () => {
    let prev = Infinity;
    for (const d of [10 * S, 4 * S, 2 * S, 1.2 * S, 1.01 * S]) {
      const cap = autopilotGlideCap(d, S);
      expect(cap).toBeLessThan(prev);
      expect(cap).toBeGreaterThan(0);
      prev = cap;
    }
  });
});

describe('autopilotAimBlend', () => {
  const S = 1e-4;

  it('holds the center outside three standoffs, aims past the limb at one', () => {
    expect(autopilotAimBlend(3 * S, S)).toBe(0);
    expect(autopilotAimBlend(4 * S, S)).toBe(0);
    expect(autopilotAimBlend(S, S)).toBe(1);
    expect(autopilotAimBlend(S * 0.5, S)).toBe(1);
  });

  it('ramps smoothly and monotonically as the ship closes', () => {
    expect(autopilotAimBlend(2 * S, S)).toBeCloseTo(0.5, 12); // smoothstep midpoint
    let prev = -1;
    for (const d of [3 * S, 2.5 * S, 2 * S, 1.5 * S, 1.1 * S, S]) {
      const blend = autopilotAimBlend(d, S);
      expect(blend).toBeGreaterThanOrEqual(prev);
      prev = blend;
    }
    expect(prev).toBe(1);
  });

  it('a degenerate zero standoff never divides by zero', () => {
    expect(autopilotAimBlend(1, 0)).toBe(0);
  });
});

describe('autopilotArrived', () => {
  const S = 1e-4;

  it('latches within the 5% margin, not before', () => {
    expect(autopilotArrived(S, S)).toBe(true);
    expect(autopilotArrived(1.05 * S, S)).toBe(true);
    expect(autopilotArrived(1.06 * S, S)).toBe(false);
    expect(autopilotArrived(2 * S, S)).toBe(false);
  });

  it('the glide cap is still positive at the arrival margin, so the ship reaches it', () => {
    // A parked stop needs a nonzero closing speed at the trigger distance;
    // exactly at the standoff the cap is zero, so arrival must trigger above it.
    expect(autopilotGlideCap(1.05 * S, S)).toBeGreaterThan(0);
  });
});

describe('autopilotCloseStandoffAU — engaging inside the postcard', () => {
  it('retargets the Moon at the pose floor: 1.5× the collision bubble, well under the postcard', () => {
    const inp = catalogInputs('Moon');
    const close = autopilotCloseStandoffAU(inp);
    expect(close).toBeCloseTo(moonCollisionRadius(inp.renderedR, inp.shipClearance) * 1.5, 12);
    expect(close).toBeLessThan(moonArrivalStandoffAU(inp));
  });

  it('the reported bug case flies again: a third of the postcard out is arrived on the postcard, live on the retarget', () => {
    // Engaging autopilot beside the Moon used to ring the bell and park the
    // ship on the spot: any distance inside the ~23-radii postcard counted as
    // arrived, and the glide cap was zero there anyway.
    const inp = catalogInputs('Moon');
    const postcard = moonArrivalStandoffAU(inp);
    const dist = postcard / 3;
    expect(autopilotArrived(dist, postcard)).toBe(true); // the old instant bell
    const close = autopilotCloseStandoffAU(inp);
    expect(autopilotArrived(dist, close)).toBe(false); // retargeted: still flying
    expect(autopilotGlideCap(dist, close)).toBeGreaterThan(0); // and free to move
  });

  it('across the catalog the retarget stays between the collision bubble and the postcard', () => {
    for (const moon of MOONS) {
      for (const angle of [0.7, 2.4, 4.1]) {
        const inp = catalogInputs(moon.name, angle);
        const close = autopilotCloseStandoffAU(inp);
        const bubble = moonCollisionRadius(inp.renderedR, inp.shipClearance);
        // The arrival margin (1.05×) must clear the shell the resolvers park
        // on, or a close approach could never latch.
        expect(1.05 * close, `${moon.name}: latch clears the shell`).toBeGreaterThan(bubble);
        expect(close, `${moon.name}: never past the postcard`).toBeLessThanOrEqual(
          moonArrivalStandoffAU(inp) + 1e-15,
        );
      }
    }
  });
});

describe('moonArrivalTrackEngage', () => {
  const S = 2.9e-3; // arrival camera distance

  it('is EXACTLY zero at the arrival standoff and anywhere beyond it', () => {
    expect(moonArrivalTrackEngage(S, S)).toBe(0);
    expect(moonArrivalTrackEngage(2 * S, S)).toBe(0);
    expect(moonArrivalTrackEngage(MOON_ARRIVAL_ENGAGE_START_RATIO * S, S)).toBe(0);
  });

  it('reaches full tracking at (and inside) the engage-full distance', () => {
    expect(moonArrivalTrackEngage(MOON_ARRIVAL_ENGAGE_FULL_RATIO * S, S)).toBe(1);
    expect(moonArrivalTrackEngage(0.05 * S, S)).toBe(1);
  });

  it('rises monotonically as the pass closes through the band', () => {
    const steps = 40;
    let prev = 0;
    for (let i = 0; i <= steps; i++) {
      const r = MOON_ARRIVAL_ENGAGE_START_RATIO
        + (MOON_ARRIVAL_ENGAGE_FULL_RATIO - MOON_ARRIVAL_ENGAGE_START_RATIO) * (i / steps);
      const w = moonArrivalTrackEngage(r * S, S);
      expect(w).toBeGreaterThanOrEqual(prev);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(1);
      prev = w;
    }
    expect(prev).toBe(1);
  });

  it('a degenerate arrival distance engages nothing', () => {
    expect(moonArrivalTrackEngage(1e-5, 0)).toBe(0);
    expect(moonArrivalTrackEngage(1e-5, -1)).toBe(0);
    expect(moonArrivalTrackEngage(1e-5, NaN)).toBe(0);
  });
});
