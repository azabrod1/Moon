/**
 * System-map radial compression — pure math, no THREE, no scene state.
 *
 * The map draws the whole solar system schematically by squeezing every
 * heliocentric radius toward the Sun while holding direction exactly, so a
 * compressed marker still points the real way from the Sun.
 *
 * The compression curve is `s0 · asinh(r / s0)`: near-identity inside a few
 * tenths of an AU and logarithmic far out. Near-identity matters — the inner
 * system keeps close to its true relative geometry instead of being expanded
 * (a power law r^0.45 pushes Mercury's 0.39 AU out to 0.65), and the curve's
 * slope at the Sun is finite, so a ship crossing the origin doesn't get
 * infinite magnification. The logarithmic tail is what pulls Pluto into frame.
 *
 * The scale control blends that curve toward true scale with k ∈ [0, 1]:
 *
 *   r' = lerp(compressed(r), r, k)
 *
 * exact at both ends (k = 0 fully compressed, k = 1 true distances) and
 * monotonic in r at every k — dr'/dr = (1−k)/√(1+(r/s0)²) + k > 0 — so radial
 * ordering can never flicker part-way through the animation.
 *
 * The older power law r^gamma stays selectable through the dev bridge so the
 * two curves can be compared in place. It is monotonic too, so everything
 * below holds for either curve.
 *
 * All inputs and outputs are in scene AU with the Sun at the origin — the same
 * frame computeBodyPositionAU returns, so the map cannot disagree with the
 * world it mirrors.
 */

/** Softening scale (AU) of the compression curve: inside it the map is nearly
 *  true, beyond it logarithmic. Mercury 0.387 AU -> 0.364, Pluto 39.5 -> 2.93. */
export const MAP_ASINH_S0_DEFAULT = 0.6;

/** Exponent of the power-law curve, kept selectable for side-by-side comparison. */
export const MAP_GAMMA_DEFAULT = 0.45;

/** Blend endpoints: fully compressed, and true distances. */
export const MAP_BLEND_COMPRESSED = 0;
export const MAP_BLEND_TRUE = 1;

/** How long the scale toggle eases the blend from one endpoint to the other. */
export const MAP_BLEND_ANIM_MS = 400;

/** The radial curve the map compresses with. */
export type MapCurve =
  | { kind: 'asinh'; s0: number }
  | { kind: 'power'; gamma: number };

/** The curve the map ships with. A factory rather than a shared constant, so a
 *  live retune of one holder's curve can never leak into another's. */
export function defaultMapCurve(): MapCurve {
  return { kind: 'asinh', s0: MAP_ASINH_S0_DEFAULT };
}

/**
 * Tuning window for the softening scale (AU). Below the floor `r / s0`
 * overflows on outer-system radii; above the ceiling the curve is
 * indistinguishable from true scale.
 */
export const MAP_S0_MIN = 0.01;
export const MAP_S0_MAX = 100;

/**
 * Tuning window for the power-law exponent. Below the floor the whole system
 * collapses into one ring; above it Pluto's radius runs away (an exponent in
 * the hundreds overflows to Infinity outright).
 */
export const MAP_GAMMA_MIN = 0.05;
export const MAP_GAMMA_MAX = 2;

/**
 * The gate every externally-supplied curve passes: a parameter inside the
 * window where the curve stays finite and meaningful across a 0.39–49 AU
 * system, which is the precondition the curve functions below assume. Outside
 * it the map doesn't merely look wrong — a zero or tiny softening scale
 * divides by zero or overflows, a zero exponent collapses every radius to 1, a
 * negative one reverses radial ordering, and a huge one sends the outer
 * planets to Infinity. Returns a fresh curve (so a later mutation of the
 * caller's object can't move the map) or null to reject.
 */
export function sanitizeMapCurve(curve: MapCurve): MapCurve | null {
  if (curve.kind === 'power') {
    const gamma = curve.gamma;
    if (!(gamma >= MAP_GAMMA_MIN) || !(gamma <= MAP_GAMMA_MAX)) return null;
    return { kind: 'power', gamma };
  }
  const s0 = curve.s0;
  if (!(s0 >= MAP_S0_MIN) || !(s0 <= MAP_S0_MAX)) return null;
  return { kind: 'asinh', s0 };
}

/** Compressed radius on the asinh curve. s0 must be finite and positive. */
export function mapCompressedRadius(radiusAU: number, s0 = MAP_ASINH_S0_DEFAULT): number {
  if (radiusAU <= 0) return 0;
  return s0 * Math.asinh(radiusAU / s0);
}

/** Compressed radius on the power-law curve. gamma must be finite and
 *  positive; gamma = 1 is the identity. */
export function compressRadius(radiusAU: number, gamma: number): number {
  if (radiusAU <= 0) return 0;
  return Math.pow(radiusAU, gamma);
}

/** Compressed radius on whichever curve is selected, before the true blend.
 *  The curve is assumed sanitized. */
export function curveRadius(radiusAU: number, curve: MapCurve): number {
  return curve.kind === 'power'
    ? compressRadius(radiusAU, curve.gamma)
    : mapCompressedRadius(radiusAU, curve.s0);
}

/**
 * The radius the map actually draws: the curve blended toward true scale.
 * blend 0 is fully compressed, 1 is the real distance. Both endpoints return
 * their exact value rather than a rounded interpolation, so true scale is
 * true to the last bit.
 */
export function mapRadius(radiusAU: number, blend: number, curve: MapCurve): number {
  if (radiusAU <= 0) return 0;
  if (blend >= MAP_BLEND_TRUE) return radiusAU;
  const compressed = curveRadius(radiusAU, curve);
  if (blend <= MAP_BLEND_COMPRESSED) return compressed;
  return compressed + (radiusAU - compressed) * blend;
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
  blend: number,
  curve: MapCurve,
  out: MapVec3,
): MapVec3 {
  const r = Math.sqrt(x * x + y * y + z * z);
  if (r < 1e-12) {
    out.x = 0;
    out.y = 0;
    out.z = 0;
    return out;
  }
  // scale = drawn radius / true radius, so the direction is unchanged.
  const scale = mapRadius(r, blend, curve) / r;
  out.x = x * scale;
  out.y = y * scale;
  out.z = z * scale;
  return out;
}

/**
 * Largest drawn radius over a set of raw heliocentric radii — the map's live
 * extent. The ship's own radius is just another entry, so a probe past Pluto
 * legitimately widens the frame.
 */
export function mapExtentAU(
  radiiAU: readonly number[],
  blend: number,
  curve: MapCurve,
): number {
  let max = 0;
  for (const r of radiiAU) {
    const c = mapRadius(r, blend, curve);
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

/**
 * Camera distance a cancelled dive restores to. The extent can have moved
 * while the dive owned the camera (the scale animation and the bodies never
 * stop), so the restore is expressed against the CURRENT fit: a dive that left
 * from the parked overview snaps back to that fit exactly, and one that left
 * from a deliberate zoom keeps the framing fraction it had. With an unchanged
 * extent this is exactly the pre-dive distance.
 */
export function diveRestoreDistanceAU(
  wasAtOverview: boolean,
  preFitRatio: number,
  freshFitAU: number,
): number {
  return wasAtOverview ? freshFitAU : preFitRatio * freshFitAU;
}

/**
 * Whether the camera still sits at the whole-system overview fit, within a
 * small tolerance for damping drift. A viewport change (device rotation)
 * re-frames the overview only when this holds — a deliberate zoom must never
 * be overridden by a rotation.
 */
export function isAtOverviewFit(
  cameraDistAU: number,
  fitDistAU: number,
  tolFrac = 0.02,
): boolean {
  if (!Number.isFinite(fitDistAU) || !(fitDistAU > 0) || !Number.isFinite(cameraDistAU)) {
    return false;
  }
  return Math.abs(cameraDistAU - fitDistAU) <= fitDistAU * tolFrac;
}
