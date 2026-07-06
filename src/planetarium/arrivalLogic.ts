/**
 * Pure math for cruise arrivals near moons. The planet throttle knows
 * nothing smaller than a system — deep inside one it still allows the
 * in-system speed setting (~25,000 km/s by default), which crosses a moon
 * standoff in about a second. These functions give moons their own approach
 * dynamics; PlanetariumMode feeds live positions and applies the results.
 */
import { KM_PER_AU } from '../astronomy/constants';

/** Approach dynamics: distance to the moon's surface e-folds every 1/K
 *  seconds, so every moon from Ganymede to Deimos gets the same subjective
 *  ease-in regardless of scale. 8 s reads as a deliberate glide without
 *  feeling parked. */
export const MOON_APPROACH_K_PER_S = 1 / 8;

/** The governor never caps below ~2 km/s — you can always creep closer; the
 *  collision bubble, not the governor, is what holds you off the mesh. */
export const MOON_APPROACH_V_MIN_AU_S = 2 / KM_PER_AU;

/**
 * Proximity speed cap near one moon: closing speed is limited to
 * K × (distance to the mesh surface), floored at vMin. The cap applies only
 * while the heading closes on the moon — `cap = base / g`, with g a
 * smoothstep of the approach cosine over [0, 0.3] — so it fades out
 * continuously as the nose swings past the limb: a flyby ends by sailing
 * on, never by wading out of molasses. Receding or grazing flight is free.
 */
export function governedSpeedCap(
  surfaceDistAU: number,
  cosApproach: number,
  kPerS: number,
  vMinAUPerS: number,
): number {
  if (cosApproach <= 0) return Infinity;
  const t = Math.min(cosApproach / 0.3, 1);
  const g = t * t * (3 - 2 * t);
  if (g <= 0) return Infinity;
  const base = Math.max(surfaceDistAU * kPerS, vMinAUPerS);
  return base / g;
}
