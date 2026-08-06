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

/**
 * The inverse of `mapRadius`: the raw heliocentric radius a drawn radius came
 * from. Exact at both blend endpoints (identity at true scale; sinh / the
 * gamma root fully compressed). Mid-blend the equation
 * `c(r) + (r − c(r))·blend = m` has no closed form on the asinh curve, so it
 * is solved by a bracketed Newton: the drawn radius always lies between the
 * true radius and its fully-compressed image (whichever way the curve bends —
 * asinh only compresses, the power law expands below 1 AU), so the root is
 * bracketed by m and the blend-0 inverse of m, and any Newton step that
 * leaves the bracket falls back to the bracket's geometric midpoint —
 * log-space bisection, because the bracket can span a dozen decades in the
 * power law's expansion region and arithmetic halving cannot cross them in
 * the iteration budget. The blend-0 inverse can
 * overflow to Infinity on a hard-compressing curve (sinh of a mid-blend
 * radius), so the bracket is also capped at m / blend, which
 * `m = c·(1−blend) + r·blend ≥ r·blend` guarantees. Converges to double
 * precision in a handful of steps; f′ = c′·(1−blend) + blend ≥ blend > 0
 * keeps every Newton step well-conditioned. The answer returned is the
 * lowest-residual iterate visited, so no late bisection can trade a converged
 * root away.
 */
export function unmapRadius(mapRadiusAU: number, blend: number, curve: MapCurve): number {
  if (mapRadiusAU <= 0) return 0;
  if (blend >= MAP_BLEND_TRUE) return mapRadiusAU;
  const compressedInverse = curve.kind === 'power'
    ? Math.pow(mapRadiusAU, 1 / curve.gamma)
    : curve.s0 * Math.sinh(mapRadiusAU / curve.s0);
  if (blend <= MAP_BLEND_COMPRESSED) return compressedInverse;
  let lo = Math.min(mapRadiusAU, compressedInverse);
  let hi = Math.min(Math.max(mapRadiusAU, compressedInverse), mapRadiusAU / blend);
  let r = Math.min(mapRadiusAU, hi);
  let best = r;
  let bestErr = Infinity;
  // The budget covers the solver's worst honest paths: at a terminal blend in
  // the expansion region the bracket's low bound underflows ~100 decades
  // wide, the first geometric midpoint plunges far below the root, and
  // Newton crawls back in small accepted steps — measured 29 iterations at
  // the worst forward-swept case (24 returned 67% low there), and 58 at a
  // reverse ease's terminal frame, where the blend lands within a few ulps of
  // zero and the crawl runs longest. The function runs once per ease frame,
  // not per body, so the slack is free.
  for (let i = 0; i < 64; i++) {
    const compressed = curveRadius(r, curve);
    const f = compressed + (r - compressed) * blend - mapRadiusAU;
    if (f === 0) return r;
    const err = Math.abs(f);
    if (err < bestErr) {
      bestErr = err;
      best = r;
    }
    if (f > 0) hi = r;
    else lo = r;
    const cSlope = curve.kind === 'power'
      ? (curve.gamma * compressed) / r
      : 1 / Math.sqrt(1 + (r / curve.s0) ** 2);
    let next = r - f / (cSlope * (1 - blend) + blend);
    // A step that lands back on r is convergence — and r is also the bracket
    // edge the residual test just wrote, so recognize it BEFORE the bracket
    // check, which sees an endpoint and would bisect away from the root.
    if (next === r) break;
    // The fallback bisects GEOMETRICALLY: the power law's sub-AU expansion
    // can put the root a dozen decades below the drawn radius, and at a tiny
    // blend the Newton step overshoots past zero every time — arithmetic
    // halving covers ~7 decades in the whole budget where the log-space
    // midpoint crosses them all. Split sqrt against product underflow.
    if (!(next > lo && next < hi)) next = Math.sqrt(lo) * Math.sqrt(hi);
    if (next === r) break;
    r = next;
  }
  // The lowest-residual iterate visited, not the last: a step that grazed the
  // bracket edge can wander off a root it already had to double precision.
  return best;
}

/**
 * Where a free map-space radius lands when the blend moves — the same physical
 * point, re-projected. This is the camera pivot's seam: a cursor-anchored zoom
 * parks the orbit target on a body in map space, and the scale animation must
 * carry that point through the re-projection or a pivot acquired at true
 * scale is left far outside the whole compressed chart.
 */
export function remapRadius(
  mapRadiusAU: number,
  fromBlend: number,
  toBlend: number,
  curve: MapCurve,
): number {
  if (fromBlend === toBlend) return mapRadiusAU;
  return mapRadius(unmapRadius(mapRadiusAU, fromBlend, curve), toBlend, curve);
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
 *
 * The margin is the whole framing policy — every overview seat, the corner
 * chart and the dive restore all resolve through here — so it is documented
 * once, here, rather than restated at each call site.
 *
 * A portrait phone looks like it wastes vertical room, and the tempting fix is
 * to fit against a HUD-safe rectangle (the frame minus the bottom chrome band)
 * instead of the whole frame. Measured on the real chart, that fit is a LOSS at
 * every viewport, because on portrait the WIDTH already binds: at 390x844 the
 * disc spans 85% of the width and 33% of the height, so trimming height buys
 * nothing and the safe-rect fit lands 0.5% SMALLER (320x568: 0.8% smaller). On
 * a landscape desktop the height binds and trimming it costs 11%. The vertical
 * air on a phone is the price of a circular system in a tall frame, not slack
 * the fit failed to use — the ONLY lever that reaches it is the chrome standing
 * in that air, which is why the phone's body card is slim rather than the
 * framing tighter. Shrinking the margin is not the lever either: it clips the
 * outer planets and their labels, and it moves desktop, corner-chart and dive
 * framing along with the phone's.
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
