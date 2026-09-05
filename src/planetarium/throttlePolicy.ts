/**
 * Pure throttle policy for the cruise ship. Framework-free — the two laws the
 * flight loop and the speed steppers apply, extracted so they carry tests:
 *
 * - systemSpeedFactor: the per-frame planet-system throttle. Inside a body's
 *   systemRadiusAU the allowed speed eases from 1 at the rim down to 0 at 5%
 *   of the radius (a smoothstep between them), and the deepest containing
 *   system wins; the Sun is one more system, fixed at the origin at
 *   SUN_SYSTEM_RADIUS_AU.
 * - stepThrottleTap: what one tap of the + / − stepper does to a multiplier.
 *   Multiplicative steps with an engage floor (a dead throttle jumps straight
 *   to a usable crawl instead of multiplying zero) and a cut floor just above
 *   it (stepping down from the crawl parks at zero instead of creeping
 *   asymptotically). The keyboard's continuous ramp is deliberately NOT this
 *   law — taps are discrete.
 * - rampThrottle: what a held throttle key does per second. An exponential
 *   ramp above an engage floor, a linear crawl below it, integrated on wall
 *   time so the feel is the same on a 60 Hz monitor and a 120 Hz phone; the
 *   rates are the old per-frame factors taken at 60 Hz.
 */
import { smoothstepEdges } from '../shared/math/smoothstep';

export interface SystemThrottleBody {
  name: string;
  systemRadiusAU: number;
}

export interface SystemSpeedResult {
  factor: number;
  planet: string | null;
}

/** The Sun's own throttle shell — it has no catalog systemRadiusAU. */
export const SUN_SYSTEM_RADIUS_AU = 0.01;

/** Speed factor at `dist` inside a system: 1 at the rim, 0 at 5% depth. */
function throttleFalloff(dist: number, systemRadius: number): number {
  return smoothstepEdges(systemRadius * 0.05, systemRadius, dist);
}

/**
 * The deepest system throttle containing the player, and which body's it is
 * (null outside every system). Pass `out` to reuse a result object — the
 * flight loop asks every frame.
 */
export function systemSpeedFactor(
  posX: number,
  posY: number,
  posZ: number,
  bodies: readonly SystemThrottleBody[],
  worldPositions: ReadonlyMap<string, { x: number; y: number; z: number }>,
  out: SystemSpeedResult = { factor: 1, planet: null },
): SystemSpeedResult {
  out.factor = 1.0;
  out.planet = null;

  for (const body of bodies) {
    const wp = worldPositions.get(body.name);
    if (!wp) continue;
    const dx = posX - wp.x;
    const dy = posY - wp.y;
    const dz = posZ - wp.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist >= body.systemRadiusAU) continue;
    const factor = throttleFalloff(dist, body.systemRadiusAU);
    if (factor < out.factor) {
      out.factor = factor;
      out.planet = body.name;
    }
  }

  // The Sun: always at the heliocentric world origin.
  const sunDist = Math.sqrt(posX * posX + posY * posY + posZ * posZ);
  if (sunDist < SUN_SYSTEM_RADIUS_AU) {
    const factor = throttleFalloff(sunDist, SUN_SYSTEM_RADIUS_AU);
    if (factor < out.factor) {
      out.factor = factor;
      out.planet = 'Sun';
    }
  }

  return out;
}

export interface ThrottleTapFloors {
  /** A multiplier below this engages here on the first up-tap. */
  engage: number;
  /** A multiplier below this cuts to exactly 0 on a down-tap. */
  cut: number;
}

/** The in-system stepper floors (multiplier is a fraction of system speed). */
export const SYSTEM_TAP_FLOORS: ThrottleTapFloors = { engage: 0.001, cut: 0.002 };
/** The open-cruise stepper floors. */
export const CRUISE_TAP_FLOORS: ThrottleTapFloors = { engage: 0.05, cut: 0.06 };

/** Multiplicative step per up-tap. */
export const THROTTLE_TAP_UP = 1.35;
/** Multiplicative step per down-tap. */
export const THROTTLE_TAP_DOWN = 0.72;

/**
 * One stepper tap. The cut floor sits ABOVE the engage floor on purpose:
 * engage, tap down once, and the ship parks — the pair can never trap the
 * multiplier in a sub-crawl band that neither button leaves.
 */
export function stepThrottleTap(
  current: number,
  direction: 1 | -1,
  floors: ThrottleTapFloors,
  max: number,
): number {
  if (direction === 1) {
    if (current < floors.engage) return floors.engage;
    return Math.min(current * THROTTLE_TAP_UP, max);
  }
  if (current < floors.cut) return 0;
  return Math.max(current * THROTTLE_TAP_DOWN, 0);
}

export interface ThrottleRampLaw {
  /** Below this the throttle crawls up linearly (multiplying near-zero would
   *  never get anywhere); above it the ramp is exponential. */
  engageBelow: number;
  /** The linear crawl, in multiplier per second. */
  engagePerS: number;
  /** Exponential rate up, per second: the multiplier grows by e^(rate·dt). */
  upRatePerS: number;
  /** Exponential rate down, per second, plus a constant pull (multiplier per
   *  second) so the ramp reaches exactly zero instead of decaying
   *  asymptotically: the law is dm/dt = −rate·m − pull. */
  downRatePerS: number;
  downPullPerS: number;
}

/** The rates reproduce the tuned per-frame factors at 60 Hz exactly:
 *  ×1.01 up, ×0.99 − step down, and the engage crawl ×60. */
const REFERENCE_HZ = 60;
const UP_RATE = Math.log(1.01) * REFERENCE_HZ;
const DOWN_RATE = -Math.log(0.99) * REFERENCE_HZ;
/** The constant pull whose closed-form step at 60 Hz subtracts exactly
 *  `stepPerFrame` after the ×0.99. */
const downPullFor = (stepPerFrame: number) => (stepPerFrame * DOWN_RATE) / (1 - Math.exp(-DOWN_RATE / REFERENCE_HZ));
/** The open-cruise ramp (multiplier of light speed). */
export const CRUISE_RAMP: ThrottleRampLaw = {
  engageBelow: 0.05,
  engagePerS: 0.002 * REFERENCE_HZ,
  upRatePerS: UP_RATE,
  downRatePerS: DOWN_RATE,
  downPullPerS: downPullFor(0.001),
};
/** The in-system ramp (multiplier is a fraction of system speed). */
export const SYSTEM_RAMP: ThrottleRampLaw = {
  engageBelow: 0.001,
  engagePerS: 0.0001 * REFERENCE_HZ,
  upRatePerS: UP_RATE,
  downRatePerS: DOWN_RATE,
  downPullPerS: downPullFor(0.0001),
};

/**
 * A held throttle key for `dtS` seconds. Wall-time: one 0.1 s step lands
 * where ten 0.01 s steps do, across the engage floor too, so the feel does
 * not depend on the display's refresh rate or on a hitch frame.
 */
export function rampThrottle(
  current: number,
  direction: 1 | -1,
  dtS: number,
  law: ThrottleRampLaw,
  max: number,
): number {
  if (direction === 1) {
    if (current < law.engageBelow) {
      // Crawl to the floor first; whatever time is left rides the exponential
      // from there, so a step that crosses the floor lands where a run of
      // smaller steps would.
      const toFloorS = (law.engageBelow - current) / law.engagePerS;
      if (dtS <= toFloorS) return Math.min(current + law.engagePerS * dtS, max);
      return Math.min(law.engageBelow * Math.exp(law.upRatePerS * (dtS - toFloorS)), max);
    }
    return Math.min(current * Math.exp(law.upRatePerS * dtS), max);
  }
  // The exact solution of dm/dt = −rate·m − pull over dtS, so that any split
  // of an interval composes to the same value.
  const rest = law.downPullPerS / law.downRatePerS;
  return Math.max((current + rest) * Math.exp(-law.downRatePerS * dtS) - rest, 0);
}
