import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  advanceBodyCap,
  advanceFlybyHold,
  initialFlybyHoldState,
  autopilotAimBlend,
  autopilotArrived,
  autopilotGlideCap,
  governedSpeedCap,
  initialBodyCapState,
  arrivalCameraLookWeight,
  arrivalLookReleaseFade,
  arrivalTrackEngage,
  ARRIVAL_ENGAGE_FULL_RATIO,
  ARRIVAL_ENGAGE_START_RATIO,
  ARRIVAL_LOOK_RELEASE_S,
  arrivalPose,
  arrivalStandoffAU,
  moonCollisionRadius,
  contactAimStep,
  grazeDeflectAim,
  movingBodySpeedCap,
  rampedSpeedCap,
  sunArrivalPose,
  sweepSegmentSphere,
  BODY_APPROACH_V_MIN_AU_S,
  BODY_CAP_CLEAR_HOLD_S,
  CAP_TRANSITION_TAU_S,
  CONTACT_AIM_TAU_S,
  GRAZE_OUTWARD_BIAS,
  DEPARTURE_HEADSTART_RADII,
  DEPARTURE_KNEE_RADII,
  BODY_APPROACH_K_PER_S,
  MOON_ARRIVAL_APPARENT_DIAMETER_DEG,
  ARRIVAL_IMPACT_RADII,
  ARRIVAL_MAX_OFFAXIS_DEG,
  MOON_ARRIVAL_SEPARATION_CAP,
  MOON_ARRIVAL_STANDOFF_FLOOR_AU,
  SUN_APPROACH_SURFACE_RADII,
  SUN_ARRIVAL_RADII,
  type BodyCapState,
  type ArrivalInputs,
  planetPostcardPose,
  passGeometryMinAU,
  estimatePassDurationS,
  scoreApproachLane,
  LANE_CLEAN_RATIO,
  type LaneBody,
  type ArrivalPose,
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

const K = BODY_APPROACH_K_PER_S;
const VMIN = BODY_APPROACH_V_MIN_AU_S;

/** Real-catalog inputs for one moon, posed at `angleRad` around its parent
 *  (parent placed on the +X axis at its semi-major axis; Sun at origin —
 *  the same world the controller feeds from live positions). */
function catalogInputs(moonName: string, angleRad = 0.7): ArrivalInputs {
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
    targetPos: offset.clone().add(parentPos),
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

  // The departure law's datum: the collision shell the resolvers park on.
  const SHELL = R + SHIP_CLEARANCE_AU;

  it('receding or side-on flight is capped at exactly the departure law', () => {
    // THE departure contract: leaving speed is a function of where you are —
    // the approach K on the head-started shell height, opened by the valve —
    // never Infinity, never a time ramp.
    const lift = (1e-4 - SHIP_CLEARANCE_AU) + DEPARTURE_HEADSTART_RADII * SHELL;
    const law = K * lift * (lift / (DEPARTURE_KNEE_RADII * SHELL)) ** 2;
    expect(governedSpeedCap(1e-4, R, 0, K, VMIN)).toBeCloseTo(law, 12);
    expect(governedSpeedCap(1e-4, R, -1, K, VMIN)).toBeCloseTo(law, 12);
  });

  it('parked on the shell, leaving is as unhurried as arriving — the head start is the whole gap', () => {
    // The near-zone contract: the departure cap IS the approach glide, read one
    // head start above the collision shell — a visible creep (~0.05 shell
    // radii/s), nothing like a brisk pull, and below the knee no valve term.
    expect(governedSpeedCap(SHIP_CLEARANCE_AU, R, -1, K, VMIN)).toBeCloseTo(
      K * DEPARTURE_HEADSTART_RADII * SHELL,
      15,
    );
    const aboveShell = 0.1 * SHELL;
    expect(governedSpeedCap(SHIP_CLEARANCE_AU + aboveShell, R, -1, K, VMIN)).toBeCloseTo(
      K * (aboveShell + DEPARTURE_HEADSTART_RADII * SHELL),
      15,
    );
  });

  it('at or inside the collision shell the departure cap clamps to the parked creep', () => {
    const parked = K * DEPARTURE_HEADSTART_RADII * SHELL;
    expect(governedSpeedCap(SHIP_CLEARANCE_AU * 0.5, R, -1, K, VMIN)).toBeCloseTo(parked, 15);
    expect(governedSpeedCap(0, R, -1, K, VMIN)).toBeCloseTo(parked, 15);
    expect(governedSpeedCap(-0.9 * R, R, -1, K, VMIN)).toBeCloseTo(parked, 15);
  });

  it('the grazing band blends the two laws harmonically', () => {
    // Posed close in, where the two laws are comparable (lift below the knee).
    const h = 2e-6;
    const vIn = Math.max(h * K, VMIN);
    const vOut = K * ((h - SHIP_CLEARANCE_AU) + DEPARTURE_HEADSTART_RADII * SHELL);
    // Half-smoothstep: the harmonic mean of the closing glide and the departure law.
    expect(governedSpeedCap(h, R, 0.15, K, VMIN)).toBeCloseTo(
      1 / (0.5 / vIn + 0.5 / vOut),
      12,
    );
  });

  it('a giant body keeps the proven closing band: harmonic ≈ the old vIn/w fade', () => {
    // Jupiter-class shell contact: vOut/vIn ~ 185. An arithmetic blend would
    // hand a near-tangent CLOSING course half the departure law (~1,900 km/s);
    // the harmonic blend stays within a hair under the historical vIn/w.
    const surfaceDist = 5.44e-7; // one ship clearance off the shell
    const giantR = 5e-4;
    const vIn = Math.max(surfaceDist * K, VMIN);
    const oldLaw = vIn / 0.5;
    const cap = governedSpeedCap(surfaceDist, giantR, 0.15, K, VMIN);
    expect(cap).toBeLessThan(oldLaw);
    expect(cap).toBeGreaterThan(oldLaw * 0.99);
  });

  it('the departure opening is inert below the knee, continuous at it, cubic past it', () => {
    const knee = DEPARTURE_KNEE_RADII * SHELL; // head-started shell height at the knee
    // Raw surface distance whose shell height reaches the knee lift.
    const kneeDist = SHIP_CLEARANCE_AU + (DEPARTURE_KNEE_RADII - DEPARTURE_HEADSTART_RADII) * SHELL;
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
    // is a moonlet's departure law or a giant's — the multiplicative ramp this
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
    // Nose-away parked is the departure law's own creep — far under any dial,
    // so pointing out to sea while parked cannot start the auto-clear either.
    const geomAway = governedSpeedCap(SHIP_CLEARANCE_AU, 1.16e-5, -1, K, VMIN);
    expect(advanceBodyCap(initialBodyCapState(), geomAway, COMMANDED, true, DT).engaged).toBe(true);
  });

  it('under the departure law, an override departure unbinds only once genuinely away', () => {
    // `engaged` holds until the departure law crosses the commanded speed. A
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
    const engageDistAU = COMMANDED / BODY_APPROACH_K_PER_S; // cap == speed here
    expect(governedSpeedCap(engageDistAU, 4.26e-5, 1, BODY_APPROACH_K_PER_S, VMIN)).toBeCloseTo(COMMANDED, 12);
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
    // Sub-knee the departure law IS the approach glide (head-started), so three
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
      if (r.d - shell + DEPARTURE_HEADSTART_RADII * shell >= 0.9 * DEPARTURE_KNEE_RADII * shell) break;
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
      expect(park, tag).toBeCloseTo(Math.max(K * DEPARTURE_HEADSTART_RADII * shellR, VMIN), 15);
      expect(park, tag).toBeGreaterThanOrEqual(VMIN);
      expect(advanceBodyCap(initialBodyCapState(), park, commanded, true, DT).engaged, tag).toBe(true);
      // The closed-loop timeline: sub-knee at 2.5 s, past it by 3.6 s, free
      // within a few seconds — the same story at every rung.
      const samples = simulateRelease(8.0, commanded, bodyR);
      const speedAt = (t: number) => samples.find((r) => r.t >= t - 1e-9)!.speed;
      const kneeSpeed = K * DEPARTURE_KNEE_RADII * shellR;
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

  it('a departing frame whose start the moving shell swallowed is NOT a contact', () => {
    // The leading-face trap: the ship parked ON the shell last frame, the
    // planet advanced onto that point, and the ship flew outward+tangential
    // to a clear endpoint. Deepest point of the segment is its start — a
    // contact here would re-park the ship and cancel the frame's escape
    // progress, which pinned fleeing ships against a planet's leading face
    // forever.
    const start = { x: R * 0.9999, y: 0, z: 0 }; // just inside (shell moved over it)
    const end = { x: R * 1.001, y: R * 0.02, z: 0 }; // receding, clear of the shell
    expect(sweepSegmentSphere(start.x, start.y, start.z, end.x, end.y, end.z, 0, 0, 0, R))
      .toBeNull();
  });

  it('a start-deepest frame still inside resolves by its ENDPOINT radial, keeping the slide', () => {
    // The body outran the ship this frame: hold it on the shell, but on the
    // endpoint's own radial — the tangential progress survives, only the
    // height clamps.
    const hit = sweepSegmentSphere(
      R * 0.99, 0, 0,
      R * 0.995, R * 0.05, 0,
      0, 0, 0, R,
    );
    expect(hit).not.toBeNull();
    const len = Math.hypot(R * 0.995, R * 0.05);
    expect(hit!.ox).toBeCloseTo((R * 0.995) / len, 9);
    expect(hit!.oy).toBeCloseTo((R * 0.05) / len, 9);
  });
});

describe('arrivalPose — ladder fixtures', () => {
  const standoff = (name: string) => {
    const inp = catalogInputs(name);
    const pose = arrivalPose(inp);
    return { inp, pose, dist: pose.position.distanceTo(inp.targetPos) };
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
      const b = pose.aimPoint.distanceTo(inp.targetPos);
      const collisionR = moonCollisionRadius(inp.renderedR, inp.shipClearance);
      expect(b).toBeGreaterThanOrEqual(collisionR * 1.15 - 1e-12);
      // Every body on this list composes under the swing ceiling: it is the
      // moonlets, not these, where a floor outranks it and the aim swings
      // past 12°. The floor angle is derived here in the exact
      // perpendicular-miss form the pose uses, so the bound stays the law's
      // and not a copy of one body's number.
      const missM = Math.max(collisionR * 1.15, CAM_DIST_AU);
      const clearanceDeg =
        Math.atan2((missM * dist) / Math.sqrt(dist * dist - missM * missM), dist) * RAD2DEG;
      const offAxis =
        pose.aimPoint.clone().sub(pose.position).angleTo(inp.targetPos.clone().sub(pose.position));
      expect(offAxis * RAD2DEG).toBeLessThanOrEqual(
        Math.max(ARRIVAL_MAX_OFFAXIS_DEG, clearanceDeg) + 0.01,
      );
      expect(offAxis * RAD2DEG).toBeLessThanOrEqual(15);
      expect(Math.atan2(b, dist) * RAD2DEG).toBeCloseTo(offAxis * RAD2DEG, 5);
    }
  });

  it('one camera boom floors the miss — and is inert wherever 1.8 radii already clears it', () => {
    // The whole ladder: b is max(1.8 rendered radii capped by the swing
    // ceiling, the hull-clearance miss, one camera boom). The boom term can
    // only reach a body whose entire authored pass would fit inside the
    // camera's trail, so re-derive every aim with it dropped: wherever 1.8
    // radii is already wider than a boom — every planet, and all but the six
    // smallest moons — the two agree bit for bit and nothing moved.
    const authoredB = (inp: ArrivalInputs, dist: number, withBoom: boolean) => {
      const collisionR = moonCollisionRadius(inp.renderedR, inp.shipClearance);
      const missM = withBoom
        ? Math.max(collisionR * 1.15, CAM_DIST_AU)
        : collisionR * 1.15;
      const clearB = (missM * dist) / Math.sqrt(dist * dist - missM * missM);
      return Math.max(
        Math.min(
          inp.renderedR * ARRIVAL_IMPACT_RADII,
          dist * Math.sin(ARRIVAL_MAX_OFFAXIS_DEG * DEG2RAD),
        ),
        clearB,
      );
    };
    const bodies = [
      ...MOONS.map((m) => ({ name: m.name, inp: catalogInputs(m.name) })),
      ...PLANET_NAMES.map((n) => ({ name: n, inp: planetInputs(n) })),
    ];
    const floored: string[] = [];
    for (const { name, inp } of bodies) {
      const pose = arrivalPose(inp);
      const dist = pose.position.distanceTo(inp.targetPos);
      expect(pose.impactParameterAU, `${name}: b is the ladder`).toBe(
        authoredB(inp, dist, true),
      );
      if (inp.renderedR * ARRIVAL_IMPACT_RADII > CAM_DIST_AU) {
        expect(authoredB(inp, dist, true), `${name}: boom floor inert`).toBe(
          authoredB(inp, dist, false),
        );
      } else {
        expect(pose.impactParameterAU, `${name}: boom floor binds`).toBeGreaterThan(
          authoredB(inp, dist, false),
        );
        floored.push(name);
      }
    }
    // Only the moonlets: six meshes small enough that 1.8 of their radii
    // still fits inside the camera's trail.
    expect(floored).toEqual(['Phobos', 'Deimos', 'Styx', 'Nix', 'Kerberos', 'Hydra']);
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
    const pose = arrivalPose(inp);
    const flightForward = pose.aimPoint.clone().sub(pose.position).normalize();
    const startToMoon = inp.targetPos.clone().sub(pose.position);
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
      inp.targetPos,
      inp.renderedR,
    );
    expect(ovalRatio).toBeGreaterThan(1.1);

    const cameraDistance = cameraPos.distanceTo(inp.targetPos);
    const arrivalCameraDistance = pose.position
      .clone()
      .add(chaseIdealOffset(flightForward, FLIGHT_UP_SCENE, new THREE.Vector3()))
      .distanceTo(inp.targetPos);
    const weight = arrivalCameraLookWeight(
      cameraDistance,
      arrivalCameraDistance,
      false,
    );
    const trackedTarget = shipPos.clone().lerp(inp.targetPos, weight);
    const trackedForward = trackedTarget.sub(cameraPos).normalize();
    expect(projectedAxisRatio(
      cameraPos,
      trackedForward,
      inp.targetPos,
      inp.renderedR,
    )).toBeCloseTo(1, 10);
  });

  it('holds through approach, then smoothly releases over one arrival distance', () => {
    const d = 10;
    expect(arrivalCameraLookWeight(d * 0.2, d, false)).toBe(1);
    expect(arrivalCameraLookWeight(d * 0.2, d, true)).toBe(1);
    expect(arrivalCameraLookWeight(d, d, true)).toBe(1);
    expect(arrivalCameraLookWeight(d * 1.5, d, true)).toBeCloseTo(0.5, 10);
    expect(arrivalCameraLookWeight(d * 2, d, true)).toBe(0);
    expect(arrivalCameraLookWeight(d * 3, d, true)).toBe(0);
  });

  it('eases a steering release from full weight to zero, never in one frame', () => {
    // Untouched (releaseElapsedS null → callers pass 0) the fade is inert.
    expect(arrivalLookReleaseFade(0)).toBe(1);
    // The first steered frame must NOT collapse the look — that one-frame
    // collapse was the visible camera snap on the first touch after a moon
    // teleport (the touch zone turns a stationary tap into full steering).
    expect(arrivalLookReleaseFade(1 / 60)).toBeGreaterThan(0.9);
    // Monotone decay across the window...
    let prev = 1;
    for (let t = 0; t <= ARRIVAL_LOOK_RELEASE_S + 0.01; t += 0.02) {
      const fade = arrivalLookReleaseFade(t);
      expect(fade).toBeLessThanOrEqual(prev);
      prev = fade;
    }
    // ...fully released at the window's end and beyond.
    expect(arrivalLookReleaseFade(ARRIVAL_LOOK_RELEASE_S)).toBe(0);
    expect(arrivalLookReleaseFade(ARRIVAL_LOOK_RELEASE_S * 5)).toBe(0);
  });
});

describe('arrivalPose — catalog sweep (all moons, three orbit phases)', () => {
  const angles = [0.7, 2.4, 4.1];

  it('every arrival in the catalog satisfies the standoff and flyby invariants', () => {
    for (const moon of MOONS) {
      for (const angle of angles) {
        const inp = catalogInputs(moon.name, angle);
        const pose = arrivalPose(inp);
        const dist = pose.position.distanceTo(inp.targetPos);
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
        // Every arrival is a pass: closest approach of the forward ray to
        // the moon's center is the impact parameter, above the bubble.
        const fwd = pose.aimPoint.clone().sub(pose.position).normalize();
        const toMoon = inp.targetPos.clone().sub(pose.position);
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

  it('no moon parks: every arrival in the catalogue is a pass past the limb', () => {
    // There is no park class. The seven that used to have one — Mars's two,
    // the innermost Uranian, and Pluto's four minors — fly the same authored
    // pass as the Moon; at that scale a floor authors the miss, not the
    // 1.8-rendered-radii composition.
    for (const moon of MOONS) {
      const inp = catalogInputs(moon.name);
      const pose = arrivalPose(inp);
      const collisionR = moonCollisionRadius(inp.renderedR, inp.shipClearance);
      expect(pose.impactParameterAU, `${moon.name}: authored b`)
        .toBeGreaterThanOrEqual(collisionR * 1.15 - 1e-12);
      // And never inside the camera's own trail: the chase camera rides one
      // boom behind the ship, so a body authored to pass closer than that
      // crosses between the camera and the ship instead of past the bow.
      expect(pose.impactParameterAU, `${moon.name}: one camera boom`)
        .toBeGreaterThanOrEqual(CAM_DIST_AU);
      expect(pose.aimPoint.distanceTo(inp.targetPos), `${moon.name}: aim is off-center`)
        .toBeGreaterThan(0);
    }
    // Named, so the ruling reads off the test: these are the seven that
    // used to park.
    for (const name of ['Phobos', 'Deimos', 'Cordelia', 'Styx', 'Nix', 'Kerberos', 'Hydra']) {
      const inp = catalogInputs(name);
      const pose = arrivalPose(inp);
      const collisionR = moonCollisionRadius(inp.renderedR, inp.shipClearance);
      const dist = pose.position.distanceTo(inp.targetPos);
      const missM = Math.max(collisionR * 1.15, CAM_DIST_AU);
      const clearB = (missM * dist) / Math.sqrt(dist * dist - missM * missM);
      const composed = Math.min(
        inp.renderedR * ARRIVAL_IMPACT_RADII,
        dist * Math.sin(ARRIVAL_MAX_OFFAXIS_DEG * DEG2RAD),
      );
      expect(pose.impactParameterAU, `${name}: authored b`)
        .toBeCloseTo(Math.max(composed, clearB), 15);
      // Six of the seven fly the boom: their mesh plus the hull pad is
      // narrower than the camera's trail, so the trail is the widest term
      // and is what authors the miss. Cordelia, the largest of them,
      // composes a pass two booms wide at 1.8 radii and never sees a floor.
      if (name === 'Cordelia') {
        expect(composed, `${name}: composed at 1.8 radii`).toBeGreaterThan(clearB);
      } else {
        expect(clearB, `${name}: boom floor binds`).toBeGreaterThan(composed);
        expect(collisionR * 1.15, `${name}: shell miss is narrower than the boom`)
          .toBeLessThan(CAM_DIST_AU);
      }
    }
  });

  it('every arrival shows a real disc — never the old sub-degree dot', () => {
    // The floor's whole contract after the render curve: the smallest meshes
    // (Styx, ~20 km) still subtend ≥ ~2.5° from the chase camera. Cap-bound
    // arrivals (Charon) legitimately exceed the 5° target; the ceiling is
    // pinned by the binds-on-apparent-size test below.
    for (const moon of MOONS) {
      const inp = catalogInputs(moon.name);
      const pose = arrivalPose(inp);
      const fwd = pose.aimPoint.clone().sub(pose.position).normalize();
      const camPos = pose.position
        .clone()
        .add(chaseIdealOffset(fwd, FLIGHT_UP_SCENE, new THREE.Vector3()));
      const apparentDeg = 2 * Math.asin(inp.renderedR / camPos.distanceTo(inp.targetPos)) * RAD2DEG;
      expect(apparentDeg, `${moon.name}: arrival disc`).toBeGreaterThan(2.4);
    }
  });

  it('where the apparent-size term binds, the camera really sees the target size', () => {
    const half = (MOON_ARRIVAL_APPARENT_DIAMETER_DEG / 2) * DEG2RAD;
    let checked = 0;
    for (const moon of MOONS) {
      const inp = catalogInputs(moon.name);
      const raw = inp.renderedR / Math.sin(half) - CAM_DIST_AU;
      const pose = arrivalPose(inp);
      const dist = pose.position.distanceTo(inp.targetPos);
      if (Math.abs(dist - raw) > 1e-9) continue; // a floor or cap bound instead
      // Compose the real chase-camera pose: camDist behind the ship along
      // the heading, lifted 0.35·camDist (the unified chase rig).
      const fwd = pose.aimPoint.clone().sub(pose.position).normalize();
      const camPos = pose.position
        .clone()
        .add(chaseIdealOffset(fwd, FLIGHT_UP_SCENE, new THREE.Vector3()));
      const apparentDeg = 2 * Math.asin(inp.renderedR / camPos.distanceTo(inp.targetPos)) * RAD2DEG;
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
    const targetPos = parentPos.clone().add(new THREE.Vector3(3e-4, 0, 0));
    const pose = arrivalPose({
      targetPos,
      parentPos,
      orbitR: 3e-4,
      renderedR: 1e-5,
      parentCollision: 2e-4,
      parentClearance: 1e-3, // bubble swallows every sunward option
      camDist: CAM_DIST_AU,
      shipClearance: SHIP_CLEARANCE_AU,
    });
    const radial = targetPos.clone().sub(parentPos).normalize();
    const fromMoon = pose.position.clone().sub(targetPos).normalize();
    expect(fromMoon.dot(radial)).toBeCloseTo(1, 6);
    // Parent dead ahead past the moon: the aim still exists, is finite, and
    // still misses the moon itself (the parent pushback owns what's beyond).
    expect(pose.aimPoint.distanceTo(targetPos)).toBeGreaterThan(0);
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

describe('arrivalStandoffAU — the pose distance, extracted', () => {
  it('equals |pose.position − targetPos| across the whole catalog and three phases', () => {
    // By construction: the pose parks the ship exactly one standoff from the
    // moon (sun-side or the outward-radial fallback, both unit offsets), so the
    // extracted distance must reproduce the pose geometry moon-for-moon.
    for (const moon of MOONS) {
      for (const angle of [0.7, 2.4, 4.1]) {
        const inp = catalogInputs(moon.name, angle);
        const pose = arrivalPose(inp);
        expect(arrivalStandoffAU(inp), `${moon.name} @ ${angle}`).toBeCloseTo(
          pose.position.distanceTo(inp.targetPos),
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

describe('arrivalTrackEngage', () => {
  const S = 2.9e-3; // arrival camera distance

  it('is EXACTLY zero at the arrival standoff and anywhere beyond it', () => {
    expect(arrivalTrackEngage(S, S)).toBe(0);
    expect(arrivalTrackEngage(2 * S, S)).toBe(0);
    expect(arrivalTrackEngage(ARRIVAL_ENGAGE_START_RATIO * S, S)).toBe(0);
  });

  it('reaches full tracking at (and inside) the engage-full distance', () => {
    expect(arrivalTrackEngage(ARRIVAL_ENGAGE_FULL_RATIO * S, S)).toBe(1);
    expect(arrivalTrackEngage(0.05 * S, S)).toBe(1);
  });

  it('rises monotonically as the pass closes through the band', () => {
    const steps = 40;
    let prev = 0;
    for (let i = 0; i <= steps; i++) {
      const r = ARRIVAL_ENGAGE_START_RATIO
        + (ARRIVAL_ENGAGE_FULL_RATIO - ARRIVAL_ENGAGE_START_RATIO) * (i / steps);
      const w = arrivalTrackEngage(r * S, S);
      expect(w).toBeGreaterThanOrEqual(prev);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(1);
      prev = w;
    }
    expect(prev).toBe(1);
  });

  it('a degenerate arrival distance engages nothing', () => {
    expect(arrivalTrackEngage(1e-5, 0)).toBe(0);
    expect(arrivalTrackEngage(1e-5, -1)).toBe(0);
    expect(arrivalTrackEngage(1e-5, NaN)).toBe(0);
  });
});

describe('advanceFlybyHold — the post-pass hold state machine', () => {
  it('tracks the engage gate verbatim while the pass is still closing', () => {
    const hold = initialFlybyHoldState();
    expect(advanceFlybyHold(hold, 0, false, false)).toBe(0);
    expect(advanceFlybyHold(hold, 0.4, false, false)).toBe(0.4);
    expect(advanceFlybyHold(hold, 0.9, true, false)).toBe(0.9);
    expect(hold.holding).toBe(false);
  });

  it('latches on the first receding frame of a developed pass', () => {
    const hold = initialFlybyHoldState();
    advanceFlybyHold(hold, 1, true, false);
    expect(hold.holding).toBe(false);
    expect(advanceFlybyHold(hold, 0.8, true, true)).toBe(1);
    expect(hold.holding).toBe(true);
  });

  it('holds the gate at its peak while the engage term collapses to zero', () => {
    const hold = initialFlybyHoldState();
    advanceFlybyHold(hold, 0.6, false, false);
    advanceFlybyHold(hold, 1, true, false);
    advanceFlybyHold(hold, 0.7, true, true);
    // The receding leg drives engage back through zero; the held shot must
    // not follow it out — that is the empty-star-field ending.
    for (const engage of [0.5, 0.2, 0, 0, 0]) {
      expect(advanceFlybyHold(hold, engage, true, true)).toBe(1);
    }
  });

  it('never latches without a real closest approach', () => {
    // The distance backstop can set `receding` on a look the ship leapt past
    // under a clock warp; that is not a pass and must not hold.
    const hold = initialFlybyHoldState();
    advanceFlybyHold(hold, 1, false, true);
    expect(hold.holding).toBe(false);
    expect(advanceFlybyHold(hold, 0, false, true)).toBe(0);
  });

  it('never latches on a shot that never opened', () => {
    // engagePeak 0 would hold at zero weight: no deflection, and a look
    // that can never reach the "handoff complete" drop.
    const hold = initialFlybyHoldState();
    expect(advanceFlybyHold(hold, 0, true, true)).toBe(0);
    expect(hold.holding).toBe(false);
    expect(hold.engagePeak).toBe(0);
  });

  it('holds a partially opened shot at exactly what it opened to', () => {
    const hold = initialFlybyHoldState();
    advanceFlybyHold(hold, 0.35, true, false);
    advanceFlybyHold(hold, 0.2, true, true);
    expect(hold.holding).toBe(true);
    expect(advanceFlybyHold(hold, 0, true, true)).toBe(0.35);
  });

  it('is sticky: a latched hold ends only through the release fade', () => {
    const hold = initialFlybyHoldState();
    advanceFlybyHold(hold, 1, true, false);
    advanceFlybyHold(hold, 1, true, true);
    expect(advanceFlybyHold(hold, 0, false, false)).toBe(1);
    expect(hold.holding).toBe(true);
  });
});

describe('planetPostcardPose — the legacy centered framing, pinned', () => {
  // Historic milestones, the tutorial freeze-frames, and the dev screenshot
  // bridge are authored around this exact pose; these goldens keep it
  // byte-stable while user teleports move to the flyby. Values are the
  // formula's own output at the pin date — update only with a deliberate
  // recomposition of those scenes.
  it('drops on the sunward radial at 8 radii, aimed dead at the center', () => {
    const pose = planetPostcardPose(
      new THREE.Vector3(1.35, 0.02, -0.55), 2.2701e-5, 2.72e-5, 1, 2e-5,
    );
    expect(pose.position.x).toBeCloseTo(1.3498318300457426, 15);
    expect(pose.position.y).toBeCloseTo(0.019997508593270260, 15);
    expect(pose.position.z).toBeCloseTo(-0.54993148631493227, 15);
    expect(pose.lookTarget.x).toBe(1.35);
    expect(pose.lookTarget.y).toBe(0.02);
    expect(pose.lookTarget.z).toBe(-0.55);
  });

  it('the historic floor binds INSIDE the max and the multiplier scales the whole arm', () => {
    const pose = planetPostcardPose(
      new THREE.Vector3(-20.1, 3.2, 25.4), 7.9e-6, 9.5e-6, 0.5, 0.001,
    );
    expect(pose.position.x).toBeCloseTo(-20.099691230760769, 15);
    expect(pose.position.y).toBeCloseTo(3.1999508427081822, 15);
    // Two places short of the last bit on purpose: one ULP of 25.4 is 3.6e-15,
    // so a tighter pin fails on reassociated arithmetic rather than on a pose
    // that moved.
    expect(pose.position.z).toBeCloseTo(25.399609813996193, 13);
  });

  it('a body at the exact origin takes the fixed fallback radial', () => {
    const pose = planetPostcardPose(
      new THREE.Vector3(0, 0, 0), 1e-5, 1.2e-5, 1, 2e-5,
    );
    expect(pose.position.x).toBeCloseTo(-0.000077611400011626551, 18);
    expect(pose.position.y).toBeCloseTo(0.000019402850002906638, 18);
    expect(pose.position.z).toBe(0);
  });

  it('collision envelope + 2 radii outranks 8 radii when the envelope is fat', () => {
    // A body whose envelope dwarfs its radius (an atmosphere-shelled giant
    // at a small rendered scale) must stand off the envelope, not the mesh.
    const r = 1e-5;
    const fatEnvelope = 2e-4;
    const pose = planetPostcardPose(
      new THREE.Vector3(5, 0, 0), r, fatEnvelope, 1, 2e-5,
    );
    const dist = pose.position.distanceTo(new THREE.Vector3(5, 0, 0));
    expect(dist).toBeCloseTo(fatEnvelope + 2 * r, 12);
  });
});

// ---------------------------------------------------------------------------
// The planets' drive-by (unified arrivalPose, kind: 'planet')
// ---------------------------------------------------------------------------

import { RING_CONFIGS } from './planets/rings';

/** Real-catalog planet inputs, posed on the +X axis at the semi-major axis
 *  (the same world the controller feeds). Ring geometry uses a synthetic
 *  normal per test — the app derives it from the live mesh orientation. */
function planetInputs(name: string, extra: Partial<ArrivalInputs> = {}): ArrivalInputs {
  const planet = PLANETARIUM_BODIES.find((b) => b.name === name)!;
  const targetPos = new THREE.Vector3(planet.semiMajorAxisAU, 0, 0);
  const ring = RING_CONFIGS[name];
  return {
    kind: 'planet',
    targetPos,
    parentPos: new THREE.Vector3(0, 0, 0),
    orbitR: planet.semiMajorAxisAU,
    renderedR: planet.radiusAU,
    parentCollision: 0,
    parentClearance: 0,
    camDist: CAM_DIST_AU,
    shipClearance: SHIP_CLEARANCE_AU,
    ...(ring
      ? {
          ringNormal: new THREE.Vector3(0, 1, 0),
          ringInnerAU: planet.radiusAU * ring.innerFactor,
          ringOuterAU: planet.radiusAU * ring.outerFactor,
        }
      : {}),
    ...extra,
  };
}

const PLANET_NAMES = PLANETARIUM_BODIES
  .filter((b) => b.name !== 'Sun')
  .map((b) => b.name);

/** Un-led perigee of a pose: the aim ray's closest approach to the center. */
function poseCenterMissAU(pose: ArrivalPose, targetPos: THREE.Vector3): number {
  const u = pose.aimPoint.clone().sub(pose.position).normalize();
  const rel = targetPos.clone().sub(pose.position);
  return rel.addScaledVector(u, -Math.max(rel.dot(u), 0)).length();
}

describe('the one arrival law', () => {
  it('the pass-geometry minimum is inert for every catalog moon', () => {
    // The apparent-size law outgrows it (22.9 R against 8.83 R), so for the
    // whole catalogue the standoff is still the disc-size law — the minimum
    // only guards a body small enough that its 5° disc would sit closer than
    // the pass needs.
    for (const moon of MOONS) {
      const inp = catalogInputs(moon.name);
      const half = (MOON_ARRIVAL_APPARENT_DIAMETER_DEG / 2) * DEG2RAD;
      const apparentLaw = inp.renderedR / Math.sin(half) - inp.camDist;
      expect(apparentLaw, moon.name).toBeGreaterThanOrEqual(
        passGeometryMinAU(inp.renderedR),
      );
    }
  });
});

describe('planet flyby pose — catalog sweep', () => {
  it('drops at the pass-geometry standoff with the full authored impact parameter', () => {
    for (const name of PLANET_NAMES) {
      const inp = planetInputs(name);
      const pose = arrivalPose(inp);
      const standoff = arrivalStandoffAU(inp);
      expect(pose.position.distanceTo(inp.targetPos), name).toBeCloseTo(standoff, 12);
      // ~8.8 radii, never the legacy floor for real planets.
      expect(standoff / inp.renderedR, name).toBeGreaterThan(8.5);
      expect(standoff / inp.renderedR, name).toBeLessThan(9.2);
      // The un-led center miss is the full b (no off-axis shaving): between
      // b·cos(12°) and b.
      const b = inp.renderedR * ARRIVAL_IMPACT_RADII;
      const miss = poseCenterMissAU(pose, inp.targetPos);
      expect(miss, name).toBeGreaterThan(b * 0.97);
      expect(miss, name).toBeLessThanOrEqual(b * 1.0001);
    }
  });

  it('ringed planets pass clear of the sheet: plane altitude at the pass ≥ 0.5 R', () => {
    for (const name of Object.keys(RING_CONFIGS)) {
      const inp = planetInputs(name);
      const pose = arrivalPose(inp);
      const u = pose.aimPoint.clone().sub(pose.position).normalize();
      const rel = inp.targetPos.clone().sub(pose.position);
      const atPass = pose.position.clone().addScaledVector(u, Math.max(rel.dot(u), 0));
      const altitude = Math.abs(
        atPass.sub(inp.targetPos).dot(inp.ringNormal!),
      );
      expect(altitude, name).toBeGreaterThanOrEqual(inp.renderedR * 0.5 * 0.999);
    }
  });

  it('a solstice-like ring pole on the sun line still yields a legal pass (the fan rotates off it)', () => {
    // Uranus worst case: ring normal within ~8° of the sun line. The plain
    // sun-side candidate cannot clear the sheet; the elevation fan must.
    const planet = PLANETARIUM_BODIES.find((b) => b.name === 'Uranus')!;
    const sunLine = new THREE.Vector3(-1, 0, 0); // drop dir ≈ −targetPos dir
    const nearPole = sunLine.clone()
      .applyAxisAngle(new THREE.Vector3(0, 0, 1), 8 * DEG2RAD)
      .normalize();
    const ring = RING_CONFIGS.Uranus;
    const inp = planetInputs('Uranus', {
      ringNormal: nearPole,
      ringInnerAU: planet.radiusAU * ring.innerFactor,
      ringOuterAU: planet.radiusAU * ring.outerFactor,
    });
    const pose = arrivalPose(inp);
    const u = pose.aimPoint.clone().sub(pose.position).normalize();
    const rel = inp.targetPos.clone().sub(pose.position);
    const atPass = pose.position.clone().addScaledVector(u, Math.max(rel.dot(u), 0));
    const altitude = Math.abs(atPass.sub(inp.targetPos).dot(nearPole));
    expect(altitude).toBeGreaterThanOrEqual(planet.radiusAU * 0.5 * 0.999);
    // And the sheet is never crossed inside the annulus within the corridor.
    const denom = u.dot(nearPole);
    if (Math.abs(denom) > 1e-12) {
      const tCross = -pose.position.clone().sub(inp.targetPos).dot(nearPole) / denom;
      if (tCross > 0 && tCross < rel.length() * 2.5) {
        const crossR = pose.position.clone().addScaledVector(u, tCross)
          .sub(inp.targetPos).length();
        const inAnnulus = crossR >= inp.ringInnerAU! * 0.95 && crossR <= inp.ringOuterAU! * 1.05;
        expect(inAnnulus).toBe(false);
      }
    }
  });

  it('is deterministic: identical inputs give identical poses', () => {
    const a = arrivalPose(planetInputs('Jupiter'));
    const c = arrivalPose(planetInputs('Jupiter'));
    expect(a.position.toArray()).toEqual(c.position.toArray());
    expect(a.aimPoint.toArray()).toEqual(c.aimPoint.toArray());
  });
});

describe('the approach lane scorer', () => {
  const marsLike = () => planetInputs('Mars');

  it('an empty lane scores a perfect 1', () => {
    const inp = marsLike();
    const pose = arrivalPose(inp);
    expect(scoreApproachLane(
      pose.position, pose.aimPoint, inp.targetPos, inp.renderedR,
      [], 25_000 / KM_PER_AU, 1, inp.renderedR * 4,
    )).toBe(1);
  });

  it('a Deimos-like body parked on the sun-side lane produces the measured-class dip', () => {
    const inp = marsLike();
    const standoff = arrivalStandoffAU(inp);
    const sunDir = inp.targetPos.clone().multiplyScalar(-1).normalize();
    const drop = inp.targetPos.clone().addScaledVector(sunDir, standoff);
    // Plant the body ~0.2 standoffs ahead of the drop, on the lane.
    const lurker: LaneBody = {
      pos: drop.clone().addScaledVector(sunDir, -standoff * 0.2),
      velAUPerS: new THREE.Vector3(0, 0, 0),
      governedRadiusAU: 6.2 / KM_PER_AU,
    };
    const aim = inp.targetPos.clone(); // dead-center legacy aim: the old world
    const score = scoreApproachLane(
      drop, aim, inp.targetPos, inp.renderedR,
      [lurker], 25_000 / KM_PER_AU, 1, inp.renderedR * 4,
    );
    expect(score).toBeLessThan(0.5);
  });

  it('the planet pose rotates its drop until the lane is clean again', () => {
    const inp = marsLike();
    const standoff = arrivalStandoffAU(inp);
    const sunDir = inp.targetPos.clone().multiplyScalar(-1).normalize();
    const drop = inp.targetPos.clone().addScaledVector(sunDir, standoff);
    const lurker: LaneBody = {
      pos: drop.clone().addScaledVector(sunDir, -standoff * 0.2),
      velAUPerS: new THREE.Vector3(0, 0, 0),
      governedRadiusAU: 6.2 / KM_PER_AU,
    };
    const pose = arrivalPose({ ...inp, laneBodies: [lurker], commandedAUPerS: 25_000 / KM_PER_AU });
    const score = scoreApproachLane(
      pose.position, pose.aimPoint, inp.targetPos, inp.renderedR,
      [lurker], 25_000 / KM_PER_AU, 1, inp.renderedR * 4,
    );
    expect(score).toBeGreaterThanOrEqual(LANE_CLEAN_RATIO);
    // And it still faces a mostly-lit planet: within the fan's ±60°/±25°.
    const dropDir = pose.position.clone().sub(inp.targetPos).normalize();
    expect(dropDir.dot(sunDir)).toBeGreaterThan(Math.cos(66 * DEG2RAD));
  });

  it('catches a fast satellite CROSSING the lane between samples', () => {
    const inp = marsLike();
    const standoff = arrivalStandoffAU(inp);
    const sunDir = inp.targetPos.clone().multiplyScalar(-1).normalize();
    const drop = inp.targetPos.clone().addScaledVector(sunDir, standoff);
    const side = new THREE.Vector3(0, 0, 1);
    // Starts well off the lane, sweeps across it at Metis-class speed at an
    // off-grid moment (t=4.73 s), with a governed radius SMALLER than one
    // relative step — endpoint-only sampling would miss it; only the
    // within-step relative closest-approach solve catches the crossing.
    const crosserSpeed = 35 / KM_PER_AU;
    const midpoint = drop.clone().addScaledVector(sunDir, -standoff * 0.35);
    const crosser: LaneBody = {
      pos: midpoint.clone().addScaledVector(side, crosserSpeed * 4.73),
      velAUPerS: side.clone().multiplyScalar(-crosserSpeed),
      governedRadiusAU: 90 / KM_PER_AU,
    };
    const score = scoreApproachLane(
      drop, inp.targetPos.clone(), inp.targetPos, inp.renderedR,
      [crosser], 25_000 / KM_PER_AU, 1, inp.renderedR * 4,
    );
    expect(score).toBeLessThan(0.9);
  });
});

describe('the one-shot aim lead', () => {
  it('shifts the aim by the target velocity over the estimated pass time', () => {
    const inp = planetInputs('Mercury');
    const vel = new THREE.Vector3(0, 0, 47.4 / KM_PER_AU); // heliocentric-ish
    const unled = arrivalPose(inp);
    const led = arrivalPose({ ...inp, targetVelAUPerS: vel, commandedAUPerS: 25_000 / KM_PER_AU });
    const shift = led.aimPoint.clone().sub(unled.aimPoint);
    // The shift is along the velocity and sized by a governed-pass duration
    // (~9 s at K=1/4 for this geometry, coast-corrected).
    const standoff = arrivalStandoffAU(inp);
    const expectedS = estimatePassDurationS(
      standoff - inp.renderedR,
      // The glide ends at the AUTHORED pass altitude — the impact parameter
      // above the surface. Where the 1.8-radii composition binds, as it does
      // for every planet, that is exactly 0.8 rendered radii.
      unled.impactParameterAU - inp.renderedR,
      25_000 / KM_PER_AU,
    );
    expect(unled.impactParameterAU - inp.renderedR).toBeCloseTo(
      (ARRIVAL_IMPACT_RADII - 1) * inp.renderedR,
      18,
    );
    expect(shift.length()).toBeCloseTo(vel.length() * expectedS, 10);
    expect(shift.clone().normalize().dot(vel.clone().normalize())).toBeCloseTo(1, 6);
    expect(expectedS).toBeGreaterThan(5);
    expect(expectedS).toBeLessThan(15);
  });

  it('a floored pass leads on ITS altitude, not the composition\u2019s', () => {
    // Deimos flies one camera boom out, four rendered radii above the
    // surface. An estimate that still integrated the glide down to 0.8 radii
    // would run seconds long, and the aim would lead past the encounter it
    // exists to correct — measured as a flown perigee a quarter wide of the
    // authored miss.
    const base = catalogInputs('Deimos');
    const vel = new THREE.Vector3(0, 0, 24 / KM_PER_AU); // Mars-system-ish
    const inp = { ...base, targetVelAUPerS: vel, commandedAUPerS: 25_000 / KM_PER_AU };
    const pose = arrivalPose(inp);
    const s0 = pose.position.distanceTo(base.targetPos) - inp.renderedR;
    const ledS = estimatePassDurationS(
      s0, pose.impactParameterAU - inp.renderedR, 25_000 / KM_PER_AU,
    );
    const composedS = estimatePassDurationS(
      s0, (ARRIVAL_IMPACT_RADII - 1) * inp.renderedR, 25_000 / KM_PER_AU,
    );
    expect(pose.aimCenter.distanceTo(base.targetPos)).toBeCloseTo(
      vel.length() * ledS,
      18,
    );
    expect(composedS - ledS).toBeGreaterThan(5);
  });

  it('zero velocity reproduces the un-led aim exactly', () => {
    const inp = planetInputs('Mars');
    const a = arrivalPose(inp);
    const c = arrivalPose({ ...inp, targetVelAUPerS: new THREE.Vector3(0, 0, 0) });
    expect(a.aimPoint.toArray()).toEqual(c.aimPoint.toArray());
  });
});

describe('estimatePassDurationS', () => {
  it('pure glide: the e-fold log at K', () => {
    expect(estimatePassDurationS(8e-4, 1e-4, Infinity)).toBeCloseTo(4 * Math.log(8), 12);
  });

  it('coast + glide where the far-field law exceeds the dialed speed', () => {
    const commanded = 1e-4; // AU/s; law at s0=8e-3 is K*s0=2e-3 >> commanded
    const s0 = 8e-3;
    const sCoastEnd = commanded / BODY_APPROACH_K_PER_S; // 4e-4
    const expected = (s0 - sCoastEnd) / commanded + 4 * Math.log(sCoastEnd / 1e-4);
    expect(estimatePassDurationS(s0, 1e-4, commanded)).toBeCloseTo(expected, 10);
  });

  it('degenerate inputs stay finite', () => {
    expect(estimatePassDurationS(0, 1e-4, Infinity)).toBe(0);
    expect(estimatePassDurationS(1e-4, 1e-3, Infinity)).toBe(0);
    expect(Number.isFinite(estimatePassDurationS(1, 1e-9, 0))).toBe(true);
  });
});

describe('the wide-net fan — a satellite disc face-on to the sun line', () => {
  it('escapes the Uranus-solstice geometry the narrow fan cannot', () => {
    // Uranus near solstice: the moonlet disc faces the Sun, so every
    // lit-face-faithful lane flies down the disc axis. Build that geometry
    // synthetically: the disc normal IS the sun line, and two Miranda/
    // Bianca-class bodies sit on their orbit rings nearest the incoming
    // lane — measured live, this held the ship to 0.54 of Uranus's law.
    const inp = planetInputs('Uranus');
    const planet = PLANETARIUM_BODIES.find((b) => b.name === 'Uranus')!;
    const sunDir = inp.targetPos.clone().multiplyScalar(-1).normalize();
    // The disc normal sits ~8° off the sun line (the 2026 geometry).
    const discNormal = sunDir.clone()
      .applyAxisAngle(new THREE.Vector3(0, 0, 1), 8 * DEG2RAD)
      .normalize();
    const commanded = 25_000 / KM_PER_AU;
    // One Miranda-class and one Bianca-class body, each parked at the ring
    // azimuth CLOSEST to the sun-line lane — the measured binding pair.
    const laneBodies: LaneBody[] = [];
    const basis1 = new THREE.Vector3().crossVectors(discNormal, new THREE.Vector3(0, 1, 0)).normalize();
    const basis2 = new THREE.Vector3().crossVectors(discNormal, basis1).normalize();
    for (const orbitKm of [129_900, 59_165]) {
      const orbitAU = orbitKm / KM_PER_AU;
      let bestPos: THREE.Vector3 | null = null;
      let bestLineDist = Infinity;
      for (let i = 0; i < 360; i++) {
        const a = (i / 360) * Math.PI * 2;
        const p = inp.targetPos.clone()
          .addScaledVector(basis1, Math.cos(a) * orbitAU)
          .addScaledVector(basis2, Math.sin(a) * orbitAU);
        // Distance from the sun-side lane (the line target + t·sunDir, t>0).
        const rel = p.clone().sub(inp.targetPos);
        const lineDist = rel.addScaledVector(sunDir, -rel.dot(sunDir)).length();
        if (lineDist < bestLineDist) {
          bestLineDist = lineDist;
          bestPos = p;
        }
      }
      // The nearest ring body AND its antipode: near-axis lanes pass the
      // ring on one side or the other depending on the aim sign, so a
      // single body per shell lets a sign flip dodge it — the pair forces
      // any near-axis candidate dirty regardless of which side it aims.
      laneBodies.push({
        pos: bestPos!,
        velAUPerS: new THREE.Vector3(0, 0, 0),
        governedRadiusAU: 470 / KM_PER_AU, // curve-rendered moonlet class
      });
      laneBodies.push({
        pos: inp.targetPos.clone().multiplyScalar(2).sub(bestPos!),
        velAUPerS: new THREE.Vector3(0, 0, 0),
        governedRadiusAU: 470 / KM_PER_AU,
      });
    }
    const ring = RING_CONFIGS.Uranus;
    const pose = arrivalPose({
      ...inp,
      ringNormal: discNormal,
      ringInnerAU: planet.radiusAU * ring.innerFactor,
      ringOuterAU: planet.radiusAU * ring.outerFactor,
      laneBodies,
      commandedAUPerS: commanded,
    });
    const score = scoreApproachLane(
      pose.position, pose.aimPoint, inp.targetPos, inp.renderedR,
      laneBodies, commanded, 1, inp.renderedR * 4,
    );
    expect(score).toBeGreaterThanOrEqual(LANE_CLEAN_RATIO);
    // The winning lane genuinely rotated off the sun line (the plain
    // sun-side drop reads the planted pair's brakes); HOW far is the fan's
    // own business — it takes the most lit-face-faithful clean candidate.
    const dropDir = pose.position.clone().sub(inp.targetPos).normalize();
    expect(dropDir.dot(sunDir)).toBeLessThan(Math.cos(15 * DEG2RAD));
  });

  it('a clean sun-side lane never pays the wide net (lit face preserved)', () => {
    const inp = planetInputs('Uranus');
    const pose = arrivalPose({ ...inp, laneBodies: [], commandedAUPerS: 25_000 / KM_PER_AU });
    const sunDir = inp.targetPos.clone().multiplyScalar(-1).normalize();
    const dropDir = pose.position.clone().sub(inp.targetPos).normalize();
    expect(dropDir.dot(sunDir)).toBeGreaterThan(0.999);
  });
});

describe('flyover composition — the signed contract', () => {
  it('an unringed planet slides UNDER the frame: the aim offset points along projected scene-up', () => {
    const inp = planetInputs('Mars');
    const pose = arrivalPose(inp);
    const viewDir = inp.targetPos.clone().sub(pose.position).normalize();
    const upPerp = FLIGHT_UP_SCENE.clone()
      .addScaledVector(viewDir, -FLIGHT_UP_SCENE.dot(viewDir))
      .normalize();
    const offset = pose.aimPoint.clone().sub(inp.targetPos).normalize();
    expect(offset.dot(upPerp)).toBeGreaterThan(0.99);
  });

  it('a ringed planet aims along the ring normal signed toward scene-up', () => {
    const normal = new THREE.Vector3(0.2, -0.9, 0.1).normalize(); // "down" pole
    const planet = PLANETARIUM_BODIES.find((b) => b.name === 'Saturn')!;
    const ring = RING_CONFIGS.Saturn;
    const inp = planetInputs('Saturn', {
      ringNormal: normal,
      ringInnerAU: planet.radiusAU * ring.innerFactor,
      ringOuterAU: planet.radiusAU * ring.outerFactor,
    });
    const pose = arrivalPose(inp);
    const viewDir = inp.targetPos.clone().sub(pose.position).normalize();
    const signed = normal.dot(FLIGHT_UP_SCENE) >= 0 ? normal.clone() : normal.clone().negate();
    const perp = signed.addScaledVector(viewDir, -signed.dot(viewDir)).normalize();
    const offset = pose.aimPoint.clone().sub(inp.targetPos).normalize();
    expect(offset.dot(perp)).toBeGreaterThan(0.99);
  });
});

describe('representative moon pose goldens — byte-stable', () => {

  // Exact outputs at the pin date; a semantic change to the shared pose math
  // must show up here as a deliberate fixture update, never a silent drift.
  // The drop positions moved once, by exactly one halving of the camera boom
  // (1.46875e-6 AU) when the rig went to 1/64: the standoff is measured from
  // the camera, so a shorter trail drops the ship that much farther out. Aim
  // points and impact parameters are unchanged by the rig, and stayed pinned.
  // Each number is pinned as finely as its own magnitude allows and no finer:
  // one ULP of 5.2 AU is 8.9e-16 and of 39.5 AU is 7.1e-15, so those two sit
  // two places short of the last bit while the small offsets beside them stay
  // tight. A moved pose still fails here; a last-bit difference out of
  // reassociated arithmetic is not what these guard.
  it('Io — composition-bound b', () => {
    const pose = arrivalPose(catalogInputs('Io'));
    expect(pose.position.x).toBeCloseTo(5.2047391511412595, 13);
    expect(pose.position.z).toBeCloseTo(0.0018158336145122137, 15);
    expect(pose.aimPoint.x).toBeCloseTo(5.2051560177500615, 15);
    expect(pose.aimPoint.z).toBeCloseTo(0.0017831343892584413, 15);
    expect(pose.impactParameterAU).toBeCloseTo(0.000032844660015313005, 18);
  });

  it('Phobos — boom-floor b, the ex-park class', () => {
    // The drop is where the park put it (the apparent-size law was already
    // the binding term), but the aim carries an impact parameter: at moonlet
    // scale a floor authors it, not 1.8 radii — and the widest floor is the
    // camera boom, so the miss is one trail length rather than the 113 km
    // the hull clearance alone asked for.
    const pose = arrivalPose(catalogInputs('Phobos'));
    expect(pose.position.x).toBeCloseTo(1.5240406028410485, 15);
    expect(pose.position.z).toBeCloseTo(0.000040375948823000805, 18);
    expect(pose.aimPoint.x).toBeCloseTo(1.5240479362858297, 15);
    expect(pose.aimPoint.z).toBeCloseTo(0.00003887701823419518, 18);
    expect(pose.impactParameterAU).toBeCloseTo(0.000001499124871024117, 19);
    expect(pose.impactParameterAU).toBeGreaterThan(CAM_DIST_AU);
  });

  it('Charon — separation-cap-bound standoff', () => {
    const pose = arrivalPose(catalogInputs('Charon'));
    expect(pose.position.x).toBeCloseTo(39.480041231023293, 12);
    expect(pose.aimPoint.z).toBeCloseTo(0.000077073748822255761, 18);
    expect(pose.impactParameterAU).toBeCloseTo(0.0000072915476329704215, 19);
  });
});

describe('fail-closed edges', () => {
  it('an all-ring-rejected fan ships the highest-altitude candidate, never the raw sunward ray', () => {
    // Absurd annulus (covers everything a corridor can cross) with a normal
    // that dooms every candidate: the fallback must still be the candidate
    // with the MOST ring-plane altitude.
    const planet = PLANETARIUM_BODIES.find((b) => b.name === 'Saturn')!;
    const inp = planetInputs('Saturn', {
      ringNormal: new THREE.Vector3(-1, 0, 0).normalize(), // ~sun line at +X world
      ringInnerAU: 0,
      ringOuterAU: planet.radiusAU * 1000,
    });
    const pose = arrivalPose(inp);
    // The chosen drop must NOT be the plain sunward radial (which flies the
    // sheet dead-on); it must carry real elevation off the doomed axis.
    const sunDir = inp.targetPos.clone().multiplyScalar(-1).normalize();
    const dropDir = pose.position.clone().sub(inp.targetPos).normalize();
    expect(dropDir.dot(sunDir)).toBeLessThan(0.95);
  });

  it('a zero commanded dial fails the lane closed instead of pacing at Infinity', () => {
    const inp = planetInputs('Mars');
    const pose = arrivalPose(inp);
    const body: LaneBody = {
      pos: inp.targetPos.clone().addScaledVector(new THREE.Vector3(0, 1, 0), inp.renderedR * 20),
      velAUPerS: new THREE.Vector3(0, 0, 0),
      governedRadiusAU: inp.renderedR,
    };
    const score = scoreApproachLane(
      pose.position, pose.aimPoint, inp.targetPos, inp.renderedR,
      [body], 0, 1, inp.renderedR * 4,
    );
    expect(score).toBeLessThan(LANE_CLEAN_RATIO);
  });

  it('a dial slower than the pass height coasts the whole way in', () => {
    // commanded/K < passHeight: the coast runs s0 -> sPass at the dial; the
    // glide term must not resurrect distance already covered.
    const s0 = 8e-3;
    const sPass = 1e-3;
    const commanded = 2e-5; // commanded/K = 8e-5 < sPass
    expect(estimatePassDurationS(s0, sPass, commanded)).toBeCloseTo((s0 - sPass) / commanded, 8);
  });
});

describe('grazeDeflectAim', () => {
  const out = new THREE.Vector3();

  it('keeps the tangential direction and peels out by exactly the bias', () => {
    // Approach 30° below the tangent against a +Y outward normal, sliding +X.
    const f = new THREE.Vector3(Math.cos(-30 * DEG2RAD), Math.sin(-30 * DEG2RAD), 0);
    grazeDeflectAim(f.x, f.y, f.z, 0, 1, 0, out);
    expect(out.length()).toBeCloseTo(1, 12);
    // The slide continues where it was going (+X), nothing lateral appears.
    expect(out.x).toBeGreaterThan(0.9);
    expect(Math.abs(out.z)).toBeLessThan(1e-12);
    // Outward component = the bias on a unit tangent, renormalized.
    expect(out.y).toBeCloseTo(GRAZE_OUTWARD_BIAS / Math.hypot(1, GRAZE_OUTWARD_BIAS), 12);
  });

  it('a pure tangent skim keeps its heading, tilted out by the bias angle', () => {
    grazeDeflectAim(1, 0, 0, 0, 1, 0, out);
    expect(Math.asin(out.y)).toBeCloseTo(Math.atan(GRAZE_OUTWARD_BIAS), 9);
    expect(out.x).toBeGreaterThan(0.9);
  });

  it('a dead-center hit veers sideways — never the 180° boomerang', () => {
    const f = new THREE.Vector3(0, -1, 0); // straight into a +Y-normal shell
    grazeDeflectAim(f.x, f.y, f.z, 0, 1, 0, out);
    expect(out.length()).toBeCloseTo(1, 12);
    // A perpendicular slide with the gentle outward peel: ~104° off the nose
    // (the bias is the only backward component), nowhere near the −1 of a
    // reversal — so the ease that follows always has a defined swing plane.
    expect(out.dot(f)).toBeCloseTo(-GRAZE_OUTWARD_BIAS / Math.hypot(1, GRAZE_OUTWARD_BIAS), 12);
    expect(out.y).toBeGreaterThan(0);
    expect(Math.hypot(out.x, out.z)).toBeGreaterThan(0.9);
  });

  it('is deterministic for a given normal (the veer cannot flicker between contacts)', () => {
    const n = new THREE.Vector3(0.1, 0.9, 0.2).normalize();
    const a = grazeDeflectAim(-n.x, -n.y, -n.z, n.x, n.y, n.z, new THREE.Vector3());
    const b = grazeDeflectAim(-n.x, -n.y, -n.z, n.x, n.y, n.z, new THREE.Vector3());
    expect(a.distanceTo(b)).toBe(0);
  });

  it('never aims inward, from any direction on the approach cone', () => {
    const n = new THREE.Vector3(0.3, -0.5, 0.81).normalize();
    for (let i = 0; i < 40; i++) {
      const theta = (i / 40) * Math.PI * 2;
      const f = new THREE.Vector3(Math.cos(theta), Math.sin(theta), Math.sin(theta * 2) * 0.5).normalize();
      grazeDeflectAim(f.x, f.y, f.z, n.x, n.y, n.z, out);
      expect(out.length()).toBeCloseTo(1, 12);
      expect(out.dot(n)).toBeGreaterThan(0);
    }
  });
});

describe('contactAimStep', () => {
  it('converges monotonically onto the target and reports done within ~6τ', () => {
    const dir = new THREE.Vector3(1, 0, 0);
    const target = new THREE.Vector3(0, 1, 0); // a 90° swing
    let done = false;
    let prevDot = dir.dot(target);
    let steps = 0;
    while (!done && steps < 600) {
      done = contactAimStep(dir, target, 1 / 60, dir); // out aliases dir
      expect(dir.length()).toBeCloseTo(1, 12);
      const d = dir.dot(target);
      expect(d).toBeGreaterThanOrEqual(prevDot - 1e-12);
      prevDot = d;
      steps++;
    }
    expect(done).toBe(true);
    // The half-degree done latch on a 90° swing lands at ln(90/0.5) ≈ 5.2τ.
    expect(steps / 60).toBeLessThan(6 * CONTACT_AIM_TAU_S);
  });

  it('a capped 100 ms hitch frame still yields a unit direction mid-swing', () => {
    const dir = new THREE.Vector3(1, 0, 0);
    // The widest swing the graze can arm: a dead-center veer, ~104° off the nose.
    const target = new THREE.Vector3(-GRAZE_OUTWARD_BIAS, Math.hypot(1, GRAZE_OUTWARD_BIAS), 0).normalize();
    contactAimStep(dir, target, 0.1, dir);
    expect(dir.length()).toBeCloseTo(1, 12);
    expect(Number.isFinite(dir.x)).toBe(true);
  });
});

describe('movingBodySpeedCap', () => {
  it('matches the plain law for a body at rest', () => {
    expect(movingBodySpeedCap(1e-4, 1e-5, 0.5, 0, 0, K, VMIN))
      .toBe(governedSpeedCap(1e-4, 1e-5, 0.5, K, VMIN));
  });

  it('credits the body velocity along the nose on top of the leave law', () => {
    // Nose dead away from a chasing body: v·f̂ = B, v·r̂ = −B (closing).
    const B = 30 / KM_PER_AU;
    expect(movingBodySpeedCap(SHIP_CLEARANCE_AU, 1e-5, -1, B, -B, K, VMIN))
      .toBeCloseTo(governedSpeedCap(SHIP_CLEARANCE_AU, 1e-5, -1, K, VMIN) + B, 15);
  });

  it('motion against the nose earns no credit', () => {
    // Head-on at an oncoming body: v·f̂ = −B and v·r̂ = −B — closing motion
    // buys nothing on either side.
    const B = 30 / KM_PER_AU;
    expect(movingBodySpeedCap(1e-4, 1e-5, 1, -B, -B, K, VMIN))
      .toBe(governedSpeedCap(1e-4, 1e-5, 1, K, VMIN));
  });

  it('a crossing body must not sell closing speed', () => {
    // Nose 0.8-aligned with the body, body velocity partly along the nose but
    // ⊥ the sightline: v·f̂ > 0 yet nothing about the geometry reduces the
    // real closing rate, so the glide contract must hold exactly.
    expect(movingBodySpeedCap(1e-4, 1e-5, 0.8, 30 / KM_PER_AU, 0, K, VMIN))
      .toBe(governedSpeedCap(1e-4, 1e-5, 0.8, K, VMIN));
  });

  it('credits recession along the sightline on a committed closing course', () => {
    // Chasing a body fleeing dead along the nose (v·f̂ = v·r̂ = B): the cap
    // rides B above the world-frame glide, so the RELATIVE closing rate is
    // exactly the glide — without this the trailing-face tailgate never
    // closes the last stretch (the body flees faster than the glide floor).
    const B = 30 / KM_PER_AU;
    expect(movingBodySpeedCap(1e-4, 1e-5, 1, B, B, K, VMIN))
      .toBeCloseTo(governedSpeedCap(1e-4, 1e-5, 1, K, VMIN) + B, 15);
  });

  it('the nose credit tapers on the same blend the law uses (half-weight at cos 0.15)', () => {
    // Sightline recession zero (crossing geometry), so only the tapered
    // nose-side credit remains.
    const B = 30 / KM_PER_AU;
    expect(movingBodySpeedCap(1e-4, 1e-5, 0.15, B, 0, K, VMIN))
      .toBeCloseTo(governedSpeedCap(1e-4, 1e-5, 0.15, K, VMIN) + B / 2, 15);
  });

  it('escapes Metis’s leading face at 1× real time, where the world-frame law is pinned forever', () => {
    // Metis is the catalog's fastest bulldozer: 31.5 km/s orbital speed
    // (√(GM_jup/r) at r = 128,000 km) against a leave-valve creep of ~5% of
    // its curve-inflated shell per second (~27 km/s). Creep < closing speed,
    // so before the body-frame credit a ship caught on its leading face
    // could never out-walk it — at plain 1×, no time warp involved.
    const metis = MOONS.find((m) => m.name === 'Metis')!;
    const jupiter = PLANETARIUM_BODIES.find((b) => b.name === 'Jupiter')!;
    const renderedR = renderedMoonRadiusAU(metis.radiusAU, jupiter.radiusAU, MOON_RENDER_ANCHOR_RATIO);
    const shellR = renderedR + SHIP_CLEARANCE_AU;
    const B = 31.5 / KM_PER_AU;
    expect(K * DEPARTURE_HEADSTART_RADII * shellR).toBeLessThan(B); // the bulldozer regime is real

    // 1-D shell ride: h = height above the shell. Each frame the engine flies
    // min(commanded, cap) along the dead-outward nose while the moon closes
    // at B; the resolver clamps the ship at the shell (h never negative).
    const commanded = 25_000 / KM_PER_AU; // the in-system default (~0.083c)
    const simulate = (credited: boolean) => {
      const dt = 1 / 60;
      let h = 0;
      for (let t = 0; t < 10; t += dt) {
        const cap = credited
          ? movingBodySpeedCap(h + SHIP_CLEARANCE_AU, renderedR, -1, B, -B, K, VMIN)
          : governedSpeedCap(h + SHIP_CLEARANCE_AU, renderedR, -1, K, VMIN);
        h = Math.max(0, h + (Math.min(commanded, cap) - B) * dt);
      }
      return h;
    };
    expect(simulate(false)).toBeLessThan(0.02 * shellR); // glued to the blade
    expect(simulate(true)).toBeGreaterThan(DEPARTURE_KNEE_RADII * shellR); // walks off and leaves
  });
});
