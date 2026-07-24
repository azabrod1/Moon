/**
 * System-map radial compression — pure math, no THREE, no scene state.
 *
 * The map draws the whole solar system schematically by squeezing every
 * heliocentric radius toward the Sun with a power law, r' = r^gamma about the
 * origin. gamma < 1 pulls the outer planets in without reordering anything
 * (the map is monotonic in radius, so Mercury stays innermost and the
 * Neptune/Pluto ordering by semi-major axis survives); gamma = 1 is true
 * scale. Direction is preserved exactly, so a body's compressed marker still
 * points the real way from the Sun.
 *
 * All inputs and outputs are in scene AU with the Sun at the origin — the same
 * frame computeBodyPositionAU returns, so the map cannot disagree with the
 * world it mirrors.
 */

/** Default compression: Mercury 0.39 AU -> 0.65, Pluto 39.5 -> 5.2. */
export const MAP_GAMMA_DEFAULT = 0.45;
/** gamma at which the map draws real distances. */
export const MAP_GAMMA_TRUE = 1;
/** How long the scale toggle eases gamma from one setting to the other. */
export const MAP_GAMMA_ANIM_MS = 400;

/** Compress a heliocentric radius (AU) toward the Sun. gamma = 1 is identity. */
export function compressRadius(radiusAU: number, gamma: number): number {
  if (radiusAU <= 0) return 0;
  return Math.pow(radiusAU, gamma);
}

export interface MapVec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Re-project a raw heliocentric point into map space: compress its distance
 * from the Sun while holding its direction. Writes into `out` and returns it
 * (no allocation) so the per-frame resample can reuse one scratch.
 */
export function projectMapPoint(
  x: number,
  y: number,
  z: number,
  gamma: number,
  out: MapVec3,
): MapVec3 {
  const r = Math.sqrt(x * x + y * y + z * z);
  if (r < 1e-12) {
    out.x = 0;
    out.y = 0;
    out.z = 0;
    return out;
  }
  // scale = r^gamma / r, so |out| = r^gamma and the direction is unchanged.
  const scale = Math.pow(r, gamma) / r;
  out.x = x * scale;
  out.y = y * scale;
  out.z = z * scale;
  return out;
}

/**
 * Largest compressed radius over a set of raw heliocentric radii — the map's
 * live extent. The ship's own radius is just another entry, so a probe past
 * Pluto legitimately widens the frame.
 */
export function mapExtentAU(radiiAU: readonly number[], gamma: number): number {
  let max = 0;
  for (const r of radiiAU) {
    const c = compressRadius(r, gamma);
    if (c > max) max = c;
  }
  return max;
}

/**
 * Camera dolly distance that frames a centred disc of radius `extentAU` at the
 * given vertical FOV and aspect. Fits to the tighter of the vertical and
 * horizontal half-angles so a portrait phone (aspect < 1) still contains the
 * whole disc, with a little margin around the rim.
 */
export function fitDistanceAU(
  extentAU: number,
  verticalFovDeg: number,
  aspect: number,
  marginFrac = 1.18,
): number {
  const vHalf = (verticalFovDeg * Math.PI) / 180 / 2;
  const hHalf = Math.atan(Math.tan(vHalf) * Math.max(aspect, 1e-3));
  const half = Math.min(vHalf, hHalf);
  const target = Math.max(extentAU, 1e-6) * marginFrac;
  return target / Math.tan(half);
}
