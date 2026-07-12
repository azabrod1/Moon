/**
 * Auto-exposure for near-Sun flight. Framework-free (no three imports).
 *
 * The eye adapts to the Sun: fly close and it fills the view, the exposure
 * falls, and everything else — stars, corona haze, faint discs — sinks below
 * visibility the way it does when you look near the real Sun. This module is
 * the pure math: how much of the frame the solar disc covers, the exposure that
 * coverage should command, and the time-constant glide between the two.
 *
 * Exposure is a display-referred lever (renderer.toneMappingExposure), applied
 * once at the end of the pipeline. It cannot pull anything back below the bloom
 * high-pass, which thresholds scene-referred values — the two are independent,
 * and the near-Sun look uses both (this side plus the corona's HDR headroom).
 */

/** Safe minimum exposure at or inside the photosphere. */
export const SOLAR_EXPOSURE_FLOOR = 0.04;
/** e-folding constant of the coverage→exposure falloff. */
export const COVERAGE_E = 0.075;
/** Adaptation time constant (s) toward a brighter view — exposure falling. */
export const TAU_DIM = 0.30;
/** Adaptation time constant (s) toward a darker view — exposure rising. */
export const TAU_RECOVER = 1.6;

/**
 * Fraction of the viewport the solar disc covers, as a box-overlap surrogate —
 * the axis-aligned overlap of the disc's angular bounding box with the frustum's
 * angular extent, NOT true disc area. Deliberate: the surrogate is cheap,
 * continuous everywhere, and monotone on approach, which is all the exposure
 * curve needs. Known, harmless departures from true area:
 *   - a fully-inside disc reads 4ρ²/(fovX·fovY) — ≈1.27× its true area, absorbed
 *     into COVERAGE_E's tuning;
 *   - a disc overlapping only a viewport corner over-reports a little (dimming
 *     begins marginally early);
 *   - a giant disc centred outside the frame under-reports (harmless: the value
 *     is monotone on approach and the floor is reached well before then).
 * Full cover resolves to exactly 1 via the d≤R early return and the final clamp.
 *
 * Camera space: the view looks down −z, so a body in front has negative z.
 * A body behind the camera falls out naturally — |θ| exceeds fov/2 and the
 * overlap goes to zero.
 */
export function solarViewportCoverage(
  sunCamX: number,
  sunCamY: number,
  sunCamZ: number,
  sunRadiusAU: number,
  fovYRad: number,
  aspect: number,
): number {
  const d = Math.hypot(sunCamX, sunCamY, sunCamZ);
  // Inside or at the photosphere: the disc fills the frame. This also guards the
  // atan2(0, -0) = π degeneracy at d = 0.
  if (d <= sunRadiusAU) return 1;

  const rho = Math.asin(Math.min(1, sunRadiusAU / d));
  // Angular position of the disc centre. The −z view axis makes a body dead
  // ahead read θ = 0; behind the camera it swings past ±π/2 and clips out.
  const thetaX = Math.atan2(sunCamX, -sunCamZ);
  const thetaY = Math.atan2(sunCamY, -sunCamZ);
  const fovX = 2 * Math.atan(Math.tan(fovYRad / 2) * aspect);

  const halfX = fovX / 2;
  const halfY = fovYRad / 2;
  const wx = Math.max(0, Math.min(thetaX + rho, halfX) - Math.max(thetaX - rho, -halfX));
  const wy = Math.max(0, Math.min(thetaY + rho, halfY) - Math.max(thetaY - rho, -halfY));

  const denom = fovX * fovYRad;
  if (!(denom > 0)) return 0; // degenerate frustum (aspect 0) — no coverage
  const coverage = (wx * wy) / denom;
  return coverage < 0 ? 0 : coverage > 1 ? 1 : coverage;
}

/**
 * Exposure the given coverage should command: 1.0 when the Sun is absent, easing
 * down to the floor as it fills the frame. A single exponential falloff — no
 * knees, continuous and monotone.
 */
export function solarExposureTarget(coverage: number): number {
  return SOLAR_EXPOSURE_FLOOR + (1 - SOLAR_EXPOSURE_FLOOR) * Math.exp(-coverage / COVERAGE_E);
}

/**
 * One adaptation step toward the target, with asymmetric time constants: the eye
 * clamps down fast when a bright disc swings in (TAU_DIM) and opens back up
 * slowly when it leaves (TAU_RECOVER). A non-positive dt returns current
 * unchanged, so a paused or first frame never jumps.
 */
export function stepExposure(current: number, target: number, dtSeconds: number): number {
  if (!(dtSeconds > 0)) return current;
  const tau = target < current ? TAU_DIM : TAU_RECOVER;
  return current + (target - current) * (1 - Math.exp(-dtSeconds / tau));
}
