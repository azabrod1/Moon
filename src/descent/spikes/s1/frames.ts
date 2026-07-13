/**
 * Spike S1 throwaway code (docs/descent/ROADMAP.md) — replaced by the production
 * DescentMode in P1. The surviving artifact is the shell refactor this exercises
 * (src/app/renderPipeline.ts); this file is a scratch depth/frame calculator.
 *
 * Pure coordinate/depth math, parameterized by body radius so Descent can extend
 * to other bodies later — no hardcoded Moon radius in the math itself.
 */
import * as THREE from 'three';

/** Moon mean radius (m). The spike's default body radius; the math takes it as an argument. */
export const MOON_RADIUS_M = 1_737_400;

/** Distance to the geometric horizon for a viewer/relief of height h above a
 *  sphere of radius R: √(h·(2R + h)) — exact, TECH §3 / Appendix. */
export function horizonDistance(h: number, radiusM: number): number {
  return Math.sqrt(h * (2 * radiusM + h));
}

/**
 * Dynamic near/far for a given eye altitude, worst-case relief, and body radius.
 * near = max(0.4 m, alt/3000). far includes the relief-inflated horizon so a
 * distant massif is not clipped at the limb (TECH §3): the smooth-sphere horizon
 * from the eye PLUS the horizon of a relief-height peak, then a margin (5% + 10 km).
 */
export function computeNearFar(
  altitudeM: number,
  reliefM: number,
  radiusM: number = MOON_RADIUS_M,
): { near: number; far: number } {
  const near = Math.max(0.4, altitudeM / 3000);
  const reach = horizonDistance(altitudeM, radiusM) + horizonDistance(reliefM, radiusM);
  const far = reach * 1.05 + 10_000; // 5% + 10 km margin
  return { near, far };
}

/** A selenocentric position as plain f64 JS numbers (no float32 quantization). */
export interface Vec3f64 {
  x: number;
  y: number;
  z: number;
}

/**
 * Camera-relative transform: subtract the camera position from a world position
 * in f64, writing the small offset into `out`. The subtraction MUST happen in
 * f64 (plain JS numbers) — baking the ~1.7e6 m absolute coordinate into float32
 * first quantizes it to ~0.25 m and the offset jitters. `out` carries the small
 * result on to the GPU, where its magnitude is float32-safe.
 */
export function toCameraRelative(posM: Vec3f64, camPosM: Vec3f64, out: THREE.Vector3): THREE.Vector3 {
  return out.set(posM.x - camPosM.x, posM.y - camPosM.y, posM.z - camPosM.z);
}
