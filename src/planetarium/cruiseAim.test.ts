import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  AIM_RATE_CAP_RAD_PER_S,
  AIM_STEP_MAX_RAD,
  LOOK_RECEDE_BACKSTOP_RATIO,
  LOOK_WARP_RELEASE_RAD,
  clearArrivalLook,
  createCruiseAimState,
  cutAim,
  releaseArrivalLook,
  startArrivalLook,
  stepCruiseAim,
  type CruiseAimState,
} from './cruiseAim';
import {
  ARRIVAL_ENGAGE_FULL_RATIO,
  ARRIVAL_ENGAGE_START_RATIO,
  ARRIVAL_LOOK_RELEASE_S,
} from './arrivalLogic';

const ORIGIN = new THREE.Vector3(0, 0, 0);
const out = new THREE.Vector3();

/** A representative arrival geometry: camera on the chase offset behind the
 *  origin, moon ahead at the arrival standoff. Angles are generous so the
 *  deflection (base aim vs moon aim) is clearly nonzero. */
function arrivalScene() {
  const camPos = new THREE.Vector3(0, 1e-6, 3e-6); // chase offset
  const moonWorld = new THREE.Vector3(0, 0, -2.9e-3); // heliocentric == scene here
  const arrivalDist = moonWorld.distanceTo(camPos);
  return { camPos, moonWorld, arrivalDist };
}

function angleBetween(a: THREE.Vector3, b: THREE.Vector3): number {
  return Math.acos(THREE.MathUtils.clamp(a.dot(b), -1, 1));
}

/** Desired aim exactly as the shipped composition defines it:
 *  the point weight·moonScene viewed from the camera. */
function pointMixDir(camPos: THREE.Vector3, moonScene: THREE.Vector3, weight: number): THREE.Vector3 {
  return moonScene.clone().multiplyScalar(weight).sub(camPos).normalize();
}

/** An arrival distance that puts `camToMoonAU` deep inside the engage band,
 *  so the tracking look runs at full weight (the mid-flyby state). */
function deepArrivalDistFor(camToMoonAU: number): number {
  return camToMoonAU / (ARRIVAL_ENGAGE_FULL_RATIO * 0.75);
}

function jumpArrival(state: CruiseAimState) {
  const { camPos, moonWorld, arrivalDist } = arrivalScene();
  // The REAL applyJumpDestination sequence: clear, then the
  // resetCruiseCamera funnel cuts, then jumpToMoon starts the look —
  // un-engaged at the standoff, weight exactly zero.
  clearArrivalLook(state);
  cutAim(state);
  startArrivalLook(state, { kind: 'moon', name: 'Io', parentPlanet: 'Jupiter' }, arrivalDist);
  return { camPos, moonWorld };
}

/** The same funnel sequence, but with the look declared as if arrival was
 *  far out: the camera→moon distance sits deep inside the engage band and
 *  tracking runs fully engaged. */
function engagedPass(state: CruiseAimState) {
  const { camPos, moonWorld } = arrivalScene();
  clearArrivalLook(state);
  cutAim(state);
  startArrivalLook(state, { kind: 'moon', name: 'Io', parentPlanet: 'Jupiter' }, deepArrivalDistFor(moonWorld.distanceTo(camPos)));
  return { camPos, moonWorld };
}

describe('jump arrival', () => {
  it('frame one at the standoff adopts the BASE aim exactly — zero deflection to hand back', () => {
    const state = createCruiseAimState();
    const { camPos, moonWorld } = jumpArrival(state);
    stepCruiseAim(state, camPos, moonWorld, ORIGIN, 1 / 60, out);
    const want = camPos.clone().negate().normalize();
    // acos noise at parallel bottoms out ~1.5e-8 rad; 1e-7 is still far
    // below anything a pixel could show.
    expect(angleBetween(out, want)).toBeLessThan(1e-7);
    // Un-engaged is NOT "handoff complete": the look survives, waiting for
    // a hands-off pass to develop.
    expect(state.look).not.toBeNull();
  });

  it('a fully engaged pass adopts the weight-1 moon aim exactly', () => {
    const state = createCruiseAimState();
    const { camPos, moonWorld } = engagedPass(state);
    stepCruiseAim(state, camPos, moonWorld, ORIGIN, 1 / 60, out);
    const want = pointMixDir(camPos, moonWorld, 1);
    expect(angleBetween(out, want)).toBeLessThan(1e-9);
  });

  it('startArrivalLook does not restore a cut aim', () => {
    const state = createCruiseAimState();
    const { camPos, moonWorld } = jumpArrival(state);
    expect(state.hasAim).toBe(false);
    stepCruiseAim(state, camPos, moonWorld, ORIGIN, 1 / 60, out);
    expect(state.hasAim).toBe(true);
  });

  it('an engaged input-free pass holds full weight indefinitely', () => {
    const state = createCruiseAimState();
    const { camPos, moonWorld } = engagedPass(state);
    for (let i = 0; i < 120; i++) {
      stepCruiseAim(state, camPos, moonWorld, ORIGIN, 1 / 60, out);
    }
    const want = pointMixDir(camPos, moonWorld, 1);
    expect(angleBetween(out, want)).toBeLessThan(1e-9);
    expect(state.look).not.toBeNull();
  });
});

describe('release fade', () => {
  it('reaches the origin aim within ARRIVAL_LOOK_RELEASE_S, C0 at every frame', () => {
    const state = createCruiseAimState();
    const { camPos, moonWorld } = engagedPass(state);
    const dt = 1 / 60;
    stepCruiseAim(state, camPos, moonWorld, ORIGIN, dt, out);
    releaseArrivalLook(state);
    const baseDir = camPos.clone().multiplyScalar(-1).normalize();
    let prev = out.clone();
    let maxStep = 0;
    const frames = Math.ceil(ARRIVAL_LOOK_RELEASE_S / dt) + 2;
    for (let i = 0; i < frames; i++) {
      stepCruiseAim(state, camPos, moonWorld, ORIGIN, dt, out);
      maxStep = Math.max(maxStep, angleBetween(prev, out));
      prev = out.clone();
    }
    expect(angleBetween(out, baseDir)).toBeLessThan(1e-6);
    expect(state.look).toBeNull(); // weight hit zero and self-cleared
    // C0: every frame bounded by the enforcement ceiling (the designed fade
    // stays far under it; this asserts no hidden discontinuity).
    expect(maxStep).toBeLessThanOrEqual(Math.min(AIM_RATE_CAP_RAD_PER_S * dt, AIM_STEP_MAX_RAD) + 1e-9);
  });

  it('releaseArrivalLook is idempotent — a second call keeps the fade phase', () => {
    const state = createCruiseAimState();
    const { camPos, moonWorld } = jumpArrival(state);
    stepCruiseAim(state, camPos, moonWorld, ORIGIN, 1 / 60, out);
    releaseArrivalLook(state);
    stepCruiseAim(state, camPos, moonWorld, ORIGIN, 1 / 60, out);
    const phase = state.look!.releaseElapsedS;
    releaseArrivalLook(state);
    expect(state.look!.releaseElapsedS).toBe(phase);
  });
});

describe('continuity enforcement', () => {
  it('clearArrivalLook alone still slews — an orphaned deflection never snaps', () => {
    const state = createCruiseAimState();
    const { camPos, moonWorld } = engagedPass(state);
    const dt = 1 / 60;
    stepCruiseAim(state, camPos, moonWorld, ORIGIN, dt, out);
    const aimed = out.clone();
    clearArrivalLook(state); // the old one-frame-cancel bug, now legal
    stepCruiseAim(state, camPos, moonWorld, ORIGIN, dt, out);
    const step = angleBetween(aimed, out);
    const deflection = angleBetween(aimed, camPos.clone().negate().normalize());
    expect(deflection).toBeGreaterThan(AIM_RATE_CAP_RAD_PER_S * dt); // a real snap arc
    expect(step).toBeLessThanOrEqual(Math.min(AIM_RATE_CAP_RAD_PER_S * dt, AIM_STEP_MAX_RAD) + 1e-9);
  });

  it('cap=∞ mutation guard: without enforcement the same clear IS a one-frame snap', () => {
    const state = createCruiseAimState();
    const { camPos, moonWorld } = engagedPass(state);
    const dt = 1 / 60;
    stepCruiseAim(state, camPos, moonWorld, ORIGIN, dt, out);
    const aimed = out.clone();
    clearArrivalLook(state);
    cutAim(state); // the cut IS the cap=∞ path: adopt desired in one frame
    stepCruiseAim(state, camPos, moonWorld, ORIGIN, dt, out);
    const step = angleBetween(aimed, out);
    expect(step).toBeGreaterThan(AIM_RATE_CAP_RAD_PER_S * dt); // proves the stage is load-bearing
  });

  it('a 100ms hitch frame clamps to AIM_STEP_MAX_RAD, lags, then converges without overshoot', () => {
    const state = createCruiseAimState();
    const { camPos, moonWorld } = engagedPass(state);
    stepCruiseAim(state, camPos, moonWorld, ORIGIN, 1 / 60, out);
    clearArrivalLook(state);
    const aimed = out.clone();
    const baseDir = camPos.clone().negate().normalize();
    stepCruiseAim(state, camPos, moonWorld, ORIGIN, 0.1, out); // hitch
    const hitchStep = angleBetween(aimed, out);
    expect(hitchStep).toBeLessThanOrEqual(AIM_STEP_MAX_RAD + 1e-9);
    expect(hitchStep).toBeLessThan(AIM_RATE_CAP_RAD_PER_S * 0.1); // deliberately lags
    // acos precision bottoms out ~1.5e-8 rad at parallel; 1e-6 rad
    // (≈ 0.00006°) is "converged" for any purpose the camera has.
    let prevAngle = angleBetween(out, baseDir);
    for (let i = 0; i < 200 && prevAngle > 1e-6; i++) {
      stepCruiseAim(state, camPos, moonWorld, ORIGIN, 1 / 60, out);
      const a = angleBetween(out, baseDir);
      expect(a).toBeLessThanOrEqual(prevAngle + 1e-12); // monotone, no overshoot
      prevAngle = a;
    }
    expect(prevAngle).toBeLessThan(1e-6);
  });

  it('60Hz and 120Hz produce the same wall-clock trajectory while only the rate cap binds', () => {
    // Drive a pure enforcement sweep (orphaned deflection) at both rates and
    // compare at common wall-clock instants.
    const run = (hz: number) => {
      const state = createCruiseAimState();
      const { camPos, moonWorld } = engagedPass(state);
      stepCruiseAim(state, camPos, moonWorld, ORIGIN, 1 / hz, out);
      clearArrivalLook(state);
      const samples: THREE.Vector3[] = [];
      const frames = hz === 60 ? 3 : 6; // 50ms of sweep, cap binding
      for (let i = 0; i < frames; i++) {
        stepCruiseAim(state, camPos, moonWorld, ORIGIN, 1 / hz, out);
        samples.push(out.clone());
      }
      return samples;
    };
    const s60 = run(60);
    const s120 = run(120);
    // Compare every 60Hz frame with the matching second 120Hz frame.
    for (let i = 0; i < s60.length; i++) {
      expect(angleBetween(s60[i], s120[i * 2 + 1])).toBeLessThan(1e-6);
    }
  });
});

describe('transport (base motion passes 1:1)', () => {
  it('zero residual stays exactly zero while the base rotates arbitrarily fast', () => {
    const state = createCruiseAimState();
    const dt = 1 / 60;
    const camPos = new THREE.Vector3(0, 0, 3e-6);
    stepCruiseAim(state, camPos, null, ORIGIN, dt, out);
    // Swing the camera 45° around the origin in ONE frame — far beyond the
    // cap. Aim must follow exactly (a drag owns this motion).
    for (const angle of [Math.PI / 4, Math.PI / 2, Math.PI]) {
      camPos.set(Math.sin(angle) * 3e-6, 0, Math.cos(angle) * 3e-6);
      stepCruiseAim(state, camPos, null, ORIGIN, dt, out);
      const want = camPos.clone().negate().normalize();
      expect(angleBetween(out, want)).toBeLessThan(1e-6);
    }
  });

  it('a nonzero residual transports across base rotation without decay or growth', () => {
    const state = createCruiseAimState();
    const dt = 1 / 60;
    const { camPos, moonWorld } = engagedPass(state);
    stepCruiseAim(state, camPos, moonWorld, ORIGIN, dt, out);
    const base0 = camPos.clone().negate().normalize();
    const residual0 = angleBetween(out, base0);
    expect(residual0).toBeGreaterThan(1e-3); // the scene really deflects
    // Rotate the camera (and the moon with it, so the desired deflection is
    // rigid) by 30° in one frame: residual must ride along unchanged.
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 6);
    camPos.applyQuaternion(q);
    moonWorld.applyQuaternion(q);
    stepCruiseAim(state, camPos, moonWorld, ORIGIN, dt, out);
    const base1 = camPos.clone().negate().normalize();
    // Transport is one setFromUnitVectors + applyQuaternion; a few e-6 rad
    // of float noise at a 30° base swing is expected, drift/decay is not.
    expect(Math.abs(angleBetween(out, base1) - residual0)).toBeLessThan(1e-5);
  });
});

describe('degenerate directions', () => {
  it('near-antipodal residual sweeps continuously with no NaN', () => {
    const state = createCruiseAimState();
    const dt = 1 / 60;
    // Aim locked ahead; then demand an aim almost directly behind.
    const camPos = new THREE.Vector3(0, 0, 3e-6);
    stepCruiseAim(state, camPos, null, ORIGIN, dt, out);
    const ahead = out.clone();
    // A moon essentially behind the camera at full weight (declared arrival
    // far out so the engage band reads fully engaged).
    const moonWorld = new THREE.Vector3(1e-9, 0, 3.001e-6 + 2.9e-3);
    clearArrivalLook(state);
    startArrivalLook(state, { kind: 'moon', name: 'Io', parentPlanet: 'Jupiter' }, deepArrivalDistFor(2.9e-3));
    let prev = ahead.clone();
    for (let i = 0; i < 2000; i++) {
      stepCruiseAim(state, camPos, moonWorld, ORIGIN, dt, out);
      expect(Number.isFinite(out.x + out.y + out.z)).toBe(true);
      const step = angleBetween(prev, out);
      expect(step).toBeLessThanOrEqual(Math.min(AIM_RATE_CAP_RAD_PER_S * dt, AIM_STEP_MAX_RAD) + 1e-9);
      prev = out.clone();
    }
    // It actually got there (a near-180° arc, swept).
    const want = pointMixDir(camPos, moonWorld, 1);
    expect(angleBetween(out, want)).toBeLessThan(1e-3);
  });

  it('exact antipodal picks the deterministic fallback axis — same sweep every run', () => {
    const run = () => {
      const state = createCruiseAimState();
      const dt = 1 / 60;
      const camPos = new THREE.Vector3(0, 0, 3e-6);
      stepCruiseAim(state, camPos, null, ORIGIN, dt, out);
      // Desired exactly behind: moon dead astern at weight 1.
      const moonWorld = new THREE.Vector3(0, 0, 3e-6 + 2.9e-3);
      startArrivalLook(state, { kind: 'moon', name: 'Io', parentPlanet: 'Jupiter' }, deepArrivalDistFor(2.9e-3));
      stepCruiseAim(state, camPos, moonWorld, ORIGIN, dt, out);
      return out.clone();
    };
    const a = run();
    const b = run();
    expect(a.distanceTo(b)).toBeLessThan(1e-12);
    expect(Number.isFinite(a.x + a.y + a.z)).toBe(true);
  });
});

describe('frame contract (heliocentric world vs scene)', () => {
  it('a large render origin changes the aim exactly as moonWorld − renderOrigin − camPos', () => {
    const state = createCruiseAimState();
    const dt = 1 / 60;
    const camPos = new THREE.Vector3(0, 1e-6, 3e-6);
    // Jupiter-distance render origin: the ship is 5 AU out; the moon's
    // heliocentric position is nothing like its scene position.
    const renderOrigin = new THREE.Vector3(3.2, -1.1, 4.7);
    const moonScene = new THREE.Vector3(0, 0, -2.9e-3);
    const moonWorld = moonScene.clone().add(renderOrigin);
    clearArrivalLook(state);
    cutAim(state);
    startArrivalLook(state, { kind: 'moon', name: 'Io', parentPlanet: 'Jupiter' }, deepArrivalDistFor(moonScene.distanceTo(camPos)));
    stepCruiseAim(state, camPos, moonWorld, renderOrigin, dt, out);
    const want = pointMixDir(camPos, moonScene, 1);
    expect(angleBetween(out, want)).toBeLessThan(1e-9);
  });

  it('loss fade re-derives the last known WORLD position against the live render origin', () => {
    const state = createCruiseAimState();
    const dt = 1 / 60;
    const camPos = new THREE.Vector3(0, 1e-6, 3e-6);
    const renderOrigin = new THREE.Vector3(3.2, -1.1, 4.7);
    const moonScene = new THREE.Vector3(0, 0, -2.9e-3);
    const moonWorld = moonScene.clone().add(renderOrigin);
    cutAim(state);
    startArrivalLook(state, { kind: 'moon', name: 'Io', parentPlanet: 'Jupiter' }, deepArrivalDistFor(moonScene.distanceTo(camPos)));
    stepCruiseAim(state, camPos, moonWorld, renderOrigin, dt, out);
    // Moon lost; the SHIP keeps cruising — the render origin moves toward
    // the moon's fixed world position. A frozen scene-frame direction would
    // be geometrically wrong; the re-derived one tracks the true bearing.
    const movedOrigin = renderOrigin.clone().add(new THREE.Vector3(0, 0, -1.4e-3));
    stepCruiseAim(state, camPos, null, movedOrigin, dt, out);
    expect(state.look!.releaseElapsedS).not.toBeNull(); // true loss latched release
    const expectedScene = moonWorld.clone().sub(movedOrigin);
    // Mid-fade the desired aim blends toward base, but its moon component
    // must be the RE-DERIVED bearing: the emitted aim stays within the
    // arc between base and the re-derived moon aim — and measurably closer
    // to the re-derived bearing than to the stale pre-move one.
    const freshDir = pointMixDir(camPos, expectedScene, 1);
    const staleDir = pointMixDir(camPos, moonScene, 1);
    expect(angleBetween(out, freshDir)).toBeLessThan(angleBetween(out, staleDir));
  });
});

describe('warp and loss lifecycle', () => {
  it('a warp frame releases with exact fade phase and no classification', () => {
    const state = createCruiseAimState();
    const dt = 1 / 60;
    const { camPos, moonWorld } = jumpArrival(state);
    stepCruiseAim(state, camPos, moonWorld, ORIGIN, dt, out);
    expect(state.look!.releaseElapsedS).toBeNull();
    // Clock jump beyond BOTH thresholds: 90° around the parent AND past
    // the 2× recede backstop distance.
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    const warped = moonWorld.clone().applyQuaternion(q).multiplyScalar(3);
    stepCruiseAim(state, camPos, warped, ORIGIN, dt, out);
    const look = state.look!;
    // Release latched ON the warp frame, and the fade ticked THAT frame:
    // the first post-warp weight already carries fade(dt), never fade(0)=1.
    expect(look.releaseElapsedS).toBeCloseTo(dt, 12);
    // Classification suppressed: even past the 2× backstop distance the
    // warp frame must not latch receding — the next ordinary frame
    // classifies against the rebaselined datum.
    expect(look.receding).toBe(false);
    expect(look.previousDistanceAU).toBeCloseTo(
      warped.clone().sub(camPos).length(), 12,
    );
    // Next ordinary frame: classification resumes and the backstop fires.
    stepCruiseAim(state, camPos, warped, ORIGIN, dt, out);
    expect(state.look === null || state.look.receding).toBe(true);
  });

  it('a permanently-warping moon still self-clears within the release fade', () => {
    const state = createCruiseAimState();
    const dt = 1 / 60;
    const { camPos, moonWorld } = engagedPass(state);
    stepCruiseAim(state, camPos, moonWorld, ORIGIN, dt, out);
    const spin = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 3);
    const pos = moonWorld.clone();
    let prev = out.clone();
    const frames = Math.ceil(ARRIVAL_LOOK_RELEASE_S / dt) + 2;
    for (let i = 0; i < frames; i++) {
      pos.applyQuaternion(spin); // warps EVERY frame — never classifies
      stepCruiseAim(state, camPos, pos, ORIGIN, dt, out);
      const step = angleBetween(prev, out);
      expect(step).toBeLessThanOrEqual(Math.min(AIM_RATE_CAP_RAD_PER_S * dt, AIM_STEP_MAX_RAD) + 1e-9);
      prev = out.clone();
    }
    expect(state.look).toBeNull(); // the fade ran to zero through the chaos
  });

  it('sub-threshold apparent motion does not release', () => {
    const state = createCruiseAimState();
    const dt = 1 / 60;
    const { camPos, moonWorld } = jumpArrival(state);
    stepCruiseAim(state, camPos, moonWorld, ORIGIN, dt, out);
    const q = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0), LOOK_WARP_RELEASE_RAD * 0.5,
    );
    stepCruiseAim(state, camPos, moonWorld.clone().applyQuaternion(q), ORIGIN, dt, out);
    expect(state.look!.releaseElapsedS).toBeNull();
  });

  it('true loss (never-null history) fades out from the last known world position', () => {
    const state = createCruiseAimState();
    const dt = 1 / 60;
    const { camPos, moonWorld } = engagedPass(state);
    stepCruiseAim(state, camPos, moonWorld, ORIGIN, dt, out);
    const aimed = out.clone();
    let prev = aimed.clone();
    const baseDir = camPos.clone().negate().normalize();
    for (let i = 0; i < Math.ceil(ARRIVAL_LOOK_RELEASE_S / dt) + 2; i++) {
      stepCruiseAim(state, camPos, null, ORIGIN, dt, out); // moon gone
      const step = angleBetween(prev, out);
      expect(step).toBeLessThanOrEqual(Math.min(AIM_RATE_CAP_RAD_PER_S * dt, AIM_STEP_MAX_RAD) + 1e-9);
      prev = out.clone();
    }
    expect(angleBetween(out, baseDir)).toBeLessThan(1e-6);
  });

  it('null→resolved reappearance corrects under the cap', () => {
    const state = createCruiseAimState();
    const dt = 1 / 60;
    const { camPos, moonWorld } = engagedPass(state);
    stepCruiseAim(state, camPos, moonWorld, ORIGIN, dt, out);
    let prev = out.clone();
    // Lose the moon for three frames (release latches, fade starts)...
    for (let i = 0; i < 3; i++) {
      stepCruiseAim(state, camPos, null, ORIGIN, dt, out);
      expect(angleBetween(prev, out)).toBeLessThanOrEqual(
        Math.min(AIM_RATE_CAP_RAD_PER_S * dt, AIM_STEP_MAX_RAD) + 1e-9,
      );
      prev = out.clone();
    }
    // ...then it reappears 30° away: the correction is a capped sweep,
    // never a snap.
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 6);
    const reappeared = moonWorld.clone().applyQuaternion(q);
    for (let i = 0; i < 10; i++) {
      stepCruiseAim(state, camPos, reappeared, ORIGIN, dt, out);
      expect(angleBetween(prev, out)).toBeLessThanOrEqual(
        Math.min(AIM_RATE_CAP_RAD_PER_S * dt, AIM_STEP_MAX_RAD) + 1e-9,
      );
      prev = out.clone();
    }
  });

  it('a look that never resolved simply drops', () => {
    const state = createCruiseAimState();
    const camPos = new THREE.Vector3(0, 0, 3e-6);
    startArrivalLook(state, { kind: 'moon', name: 'Io', parentPlanet: 'Jupiter' }, 2.9e-3);
    stepCruiseAim(state, camPos, null, ORIGIN, 1 / 60, out);
    expect(state.look).toBeNull();
    const want = camPos.clone().negate().normalize();
    expect(angleBetween(out, want)).toBeLessThan(1e-9);
  });

  it('the 2× recede backstop fades a look whose approach was leapt', () => {
    const state = createCruiseAimState();
    const dt = 1 / 60;
    const camPos = new THREE.Vector3(0, 1e-6, 3e-6);
    const arrivalDist = 2.9e-3;
    startArrivalLook(state, { kind: 'moon', name: 'Io', parentPlanet: 'Jupiter' }, arrivalDist);
    // First (and only) samples put the moon beyond 2× arrival: approached
    // never latched, but the backstop must force receding → weight 0.
    const farMoon = new THREE.Vector3(0, 0, -arrivalDist * (LOOK_RECEDE_BACKSTOP_RATIO + 0.1));
    stepCruiseAim(state, camPos, farMoon, ORIGIN, dt, out);
    expect(state.look === null || state.look.receding).toBe(true);
    for (let i = 0; i < 5 && state.look; i++) {
      stepCruiseAim(state, camPos, farMoon, ORIGIN, dt, out);
    }
    expect(state.look).toBeNull();
  });
});

describe('engage gating (the settled-arrival contract)', () => {
  it('an un-engaged look holds the base aim exactly, frame after frame', () => {
    const state = createCruiseAimState();
    const { camPos, moonWorld } = jumpArrival(state);
    const baseDir = camPos.clone().negate().normalize();
    for (let i = 0; i < 180; i++) {
      stepCruiseAim(state, camPos, moonWorld, ORIGIN, 1 / 60, out);
      expect(angleBetween(out, baseDir)).toBeLessThan(1e-7); // acos parallel noise floor
    }
    expect(state.look).not.toBeNull();
  });

  it('input at the standoff: the fade runs out with the aim never leaving base', () => {
    // Alex's exact scenario, as arithmetic: teleport, then click before the
    // pass develops. Zero deflection exists, so zero motion may occur.
    const state = createCruiseAimState();
    const { camPos, moonWorld } = jumpArrival(state);
    const dt = 1 / 60;
    stepCruiseAim(state, camPos, moonWorld, ORIGIN, dt, out);
    releaseArrivalLook(state);
    const baseDir = camPos.clone().negate().normalize();
    for (let i = 0; i < Math.ceil(ARRIVAL_LOOK_RELEASE_S / dt) + 2; i++) {
      stepCruiseAim(state, camPos, moonWorld, ORIGIN, dt, out);
      expect(angleBetween(out, baseDir)).toBeLessThan(1e-7); // acos parallel noise floor
    }
    expect(state.look).toBeNull(); // the release fade still ends the look
  });

  it('a closing pass fades tracking in under the cap and ends on the moon', () => {
    const state = createCruiseAimState();
    const dt = 1 / 60;
    const camPos = new THREE.Vector3(0, 1e-6, 3e-6);
    const arrivalDist = 2.9e-3;
    const moonWorld = new THREE.Vector3(0, 0, -arrivalDist);
    clearArrivalLook(state);
    cutAim(state);
    startArrivalLook(state, { kind: 'moon', name: 'Io', parentPlanet: 'Jupiter' }, arrivalDist);
    stepCruiseAim(state, camPos, moonWorld, ORIGIN, dt, out);
    let prev = out.clone();
    // Glide the moon in along the line of sight to a tenth of the arrival
    // distance (deep inside the engage band), well under the warp threshold
    // per frame.
    const frames = 260;
    for (let i = 1; i <= frames; i++) {
      moonWorld.z = -arrivalDist * (1 - 0.9 * (i / frames));
      stepCruiseAim(state, camPos, moonWorld, ORIGIN, dt, out);
      expect(angleBetween(prev, out)).toBeLessThanOrEqual(
        Math.min(AIM_RATE_CAP_RAD_PER_S * dt, AIM_STEP_MAX_RAD) + 1e-9,
      );
      prev = out.clone();
    }
    expect(state.look).not.toBeNull();
    expect(state.look!.releaseElapsedS).toBeNull(); // hands-off: never released
    // Let the limiter settle on the final geometry: full tracking.
    for (let i = 0; i < 40; i++) {
      stepCruiseAim(state, camPos, moonWorld, ORIGIN, dt, out);
    }
    const want = pointMixDir(camPos, moonWorld, 1);
    expect(angleBetween(out, want)).toBeLessThan(1e-6);
  });
});

describe('the post-pass hold (a travel ends on its destination)', () => {
  const DT = 1 / 60;
  const ARRIVAL = 2.9e-3;
  // Impact parameter inside ARRIVAL_ENGAGE_FULL_RATIO, so the hands-off pass
  // opens the tracking gate all the way, as every authored flyby does.
  const IMPACT = ARRIVAL * ARRIVAL_ENGAGE_FULL_RATIO * 0.75;
  const CAM = new THREE.Vector3(0, 1e-6, 3e-6);

  /** The body's scene position at along-track offset z: it starts one arrival
   *  distance ahead, sweeps past at IMPACT, and recedes behind. */
  const at = (z: number) => new THREE.Vector3(IMPACT, 0, z);

  /** Fly the pass from the drop to `endZ`, one frame at a time, asserting the
   *  aim never steps past the continuity cap. Returns the last body position. */
  function flyPass(state: CruiseAimState, endZ: number, frames: number) {
    const startZ = -Math.sqrt(Math.max(ARRIVAL * ARRIVAL - IMPACT * IMPACT, 0));
    let body = at(startZ);
    clearArrivalLook(state);
    cutAim(state);
    startArrivalLook(state, { kind: 'planet', name: 'Saturn' }, body.distanceTo(CAM));
    stepCruiseAim(state, CAM, body, ORIGIN, DT, out);
    let prev = out.clone();
    for (let i = 1; i <= frames; i++) {
      body = at(startZ + (endZ - startZ) * (i / frames));
      stepCruiseAim(state, CAM, body, ORIGIN, DT, out);
      expect(angleBetween(prev, out)).toBeLessThanOrEqual(
        Math.min(AIM_RATE_CAP_RAD_PER_S * DT, AIM_STEP_MAX_RAD) + 1e-9,
      );
      prev = out.clone();
    }
    return body;
  }

  it('keeps the body framed where the engage gate used to close again', () => {
    const state = createCruiseAimState();
    // Out to 0.9 arrival distances on the receding leg — outside the engage
    // band, where handing the frame back leaves the pilot on empty stars.
    const body = flyPass(state, 0.9 * ARRIVAL, 400);
    expect(body.distanceTo(CAM)).toBeGreaterThan(ARRIVAL_ENGAGE_START_RATIO * ARRIVAL);
    expect(state.look!.hold.holding).toBe(true);
    expect(state.look!.releaseElapsedS).toBeNull(); // hands off throughout
    expect(angleBetween(out, pointMixDir(CAM, body, 1))).toBeLessThan(1e-6);
  });

  it('survives past the distance that used to retire the look outright', () => {
    const state = createCruiseAimState();
    const body = flyPass(state, LOOK_RECEDE_BACKSTOP_RATIO * ARRIVAL * 1.5, 900);
    expect(state.look).not.toBeNull();
    expect(angleBetween(out, pointMixDir(CAM, body, 1))).toBeLessThan(1e-6);
  });

  it('a player input mid-hold ends it, eased and inside the release fade', () => {
    const state = createCruiseAimState();
    flyPass(state, 0.9 * ARRIVAL, 400);
    const body = at(0.9 * ARRIVAL);
    releaseArrivalLook(state);
    const baseDir = CAM.clone().negate().normalize();
    let prev = out.clone();
    let frames = 0;
    // The look itself must be gone within the fade; the residual deflection
    // (a held shot looks back down the flight path, so it can be most of a
    // half-turn) then eases out under the same rate cap as everything else.
    for (let i = 0; i < Math.ceil(ARRIVAL_LOOK_RELEASE_S / DT) + 1; i++) {
      stepCruiseAim(state, CAM, body, ORIGIN, DT, out);
      expect(angleBetween(prev, out)).toBeLessThanOrEqual(
        Math.min(AIM_RATE_CAP_RAD_PER_S * DT, AIM_STEP_MAX_RAD) + 1e-9,
      );
      prev = out.clone();
      frames++;
    }
    expect(state.look).toBeNull();
    while (angleBetween(out, baseDir) > 1e-6 && frames < 120) {
      stepCruiseAim(state, CAM, null, ORIGIN, DT, out);
      expect(angleBetween(prev, out)).toBeLessThanOrEqual(
        Math.min(AIM_RATE_CAP_RAD_PER_S * DT, AIM_STEP_MAX_RAD) + 1e-9,
      );
      prev = out.clone();
      frames++;
    }
    expect(frames).toBeLessThan(120);
    expect(angleBetween(out, baseDir)).toBeLessThan(1e-6);
  });

  it('an input before the pass develops leaves nothing to hold', () => {
    const state = createCruiseAimState();
    const body = at(-Math.sqrt(ARRIVAL * ARRIVAL - IMPACT * IMPACT));
    clearArrivalLook(state);
    cutAim(state);
    startArrivalLook(state, { kind: 'planet', name: 'Saturn' }, body.distanceTo(CAM));
    stepCruiseAim(state, CAM, body, ORIGIN, DT, out);
    releaseArrivalLook(state);
    // Fly the whole pass with the release already latched: the fade retires
    // the look long before closest approach, so no hold can form.
    for (let i = 0; i < 60; i++) {
      stepCruiseAim(state, CAM, at(-ARRIVAL * (1 - i / 60)), ORIGIN, DT, out);
    }
    expect(state.look).toBeNull();
    const baseDir = CAM.clone().negate().normalize();
    expect(angleBetween(out, baseDir)).toBeLessThan(1e-7);
  });
});

describe('allocation discipline', () => {
  it('stepCruiseAim allocates nothing across owner-representative inputs', () => {
    const state = createCruiseAimState();
    const { camPos, moonWorld } = jumpArrival(state);
    stepCruiseAim(state, camPos, moonWorld, ORIGIN, 1 / 60, out); // warm tmps
    releaseArrivalLook(state);
    // No allocation probe harness in the suite; pin the observable proxy:
    // out-params and state vectors are the SAME objects across steps.
    const aimRef = state.aimDir;
    const baseRef = state.prevBaseDir;
    for (let i = 0; i < 100; i++) {
      stepCruiseAim(state, camPos, moonWorld, ORIGIN, 1 / 60, out);
    }
    expect(state.aimDir).toBe(aimRef);
    expect(state.prevBaseDir).toBe(baseRef);
  });
});
