/**
 * The flight throttle's ceilings, in multiples of the default cruise speed.
 * Framework-free and dependency-free so the ship, the throttle laws and the
 * persistence sanitizer all read the same numbers: a save carries a commanded
 * speed and a system throttle, and a value the ship would never accept must
 * not survive a load.
 */

/** Top commanded cruise speed (20 × the default ≈ 20c). */
export const SPEED_MAX = 20;

/** Top in-system speed, 0.4c ≈ 120k km/s. */
export const SYSTEM_SPEED_MAX = 0.4;
