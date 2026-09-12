/**
 * Geometry helpers for the Look-inside tool that must agree between the CPU
 * and the shader: the Readable-scale remap and its inverse, the projected
 * size of the body on screen, and the studio framing distance.
 *
 * The Readable remap is a policy, not a fudge. Inputs: the projected disc
 * radius in pixels and each region's true thickness as a fraction of the
 * reference radius. Rule: every region gets at least `minPx` of projected
 * thickness through a monotone piecewise-linear remap of radius; the thick
 * regions give up the difference in proportion to their slack. Fallback: if
 * the minimums cannot all fit, the minimum itself scales down (to 1/n) so the
 * remap stays monotone and predictable. A blend of 0 is the identity, 1 the
 * full policy, and the two are interpolated knot by knot, so an animated
 * blend never reorders boundaries.
 *
 * The same inputs answer the note's question — how many regions are too thin
 * to see at their true thickness (`tooThinToSeeCount`), which is the count the
 * True note reports.
 *
 * Everything the user reads stays physical: depth labels, temperatures and
 * the pick pass through `toPhysicalFraction`, the inverse of what the faces
 * draw with. Tool modes render rectilinear (no lens), so the projected radius
 * is plain perspective.
 *
 * Pure: no three, no DOM.
 */

export interface RemapKnot {
  /** Radius as a fraction of the reference radius, physical. */
  physical: number;
  /** The same radius as drawn, a fraction of the drawn disc. */
  display: number;
}

export interface ReadableRemap {
  /** Increasing in both coordinates; the first knot is (0, 0), the last (1, 1). */
  readonly knots: readonly RemapKnot[];
}

export const IDENTITY_REMAP: ReadableRemap = { knots: [{ physical: 0, display: 0 }, { physical: 1, display: 1 }] };

/** The plan's default: a region is readable at about six projected pixels. */
export const READABLE_MIN_PX = 6;

/** The minimum display thickness, as a fraction of the drawn radius, that
 *  `minPx` amounts to on a disc of `projectedRadiusPx`. Zero for a disc with
 *  no size yet (no remap before the first layout). */
export function minDisplayFraction(minPx: number, projectedRadiusPx: number): number {
  if (!(projectedRadiusPx > 0) || !(minPx > 0)) return 0;
  return minPx / projectedRadiusPx;
}

/**
 * How many regions are thinner than `minPx` on screen when they are drawn at
 * their true thickness: what the True note reports, so a reader whose thinnest
 * layers have vanished is told that Readable is what would show them. The
 * fractions are the regions' outer radii, inside-out and increasing, as
 * fractions of the reference radius; a disc with no size yet counts nothing.
 */
export function tooThinToSeeCount(
  outerFractionsInsideOut: readonly number[],
  minPx: number,
  projectedRadiusPx: number,
): number {
  if (!(projectedRadiusPx > 0) || !(minPx > 0)) return 0;
  let count = 0;
  let previousOuter = 0;
  for (const outer of outerFractionsInsideOut) {
    const thicknessPx = Math.max(0, outer - previousOuter) * projectedRadiusPx;
    if (thicknessPx < minPx) count++;
    previousOuter = outer;
  }
  return count;
}

/**
 * Build the remap for a body whose regions have the given outer radii,
 * inside-out and increasing, as fractions of the reference radius (the last
 * one is the surface and must be 1). `minFraction` is the smallest display
 * thickness any region may have; `blend` ∈ [0, 1] interpolates from the
 * identity to the full policy.
 */
export function readableRemap(
  outerFractionsInsideOut: readonly number[],
  minFraction: number,
  blend = 1,
): ReadableRemap {
  const count = outerFractionsInsideOut.length;
  if (count === 0) return IDENTITY_REMAP;
  const physicalThickness: number[] = [];
  let previous = 0;
  for (const outer of outerFractionsInsideOut) {
    physicalThickness.push(Math.max(0, outer - previous));
    previous = outer;
  }
  // Normalise so the thicknesses sum to exactly one whatever the caller
  // passed as the surface radius.
  const total = physicalThickness.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) return IDENTITY_REMAP;
  for (let index = 0; index < count; index++) physicalThickness[index] /= total;

  // The fallback: n regions cannot each have more than 1/n.
  const effectiveMin = Math.min(Math.max(0, minFraction), 1 / count);
  const displayThickness = physicalThickness.slice();
  let raise = 0;
  let slack = 0;
  for (let index = 0; index < count; index++) {
    const thickness = physicalThickness[index];
    if (thickness < effectiveMin) raise += effectiveMin - thickness;
    else slack += thickness - effectiveMin;
  }
  if (raise > 0 && slack > 0) {
    for (let index = 0; index < count; index++) {
      const thickness = physicalThickness[index];
      displayThickness[index] = thickness < effectiveMin
        ? effectiveMin
        : thickness - raise * ((thickness - effectiveMin) / slack);
    }
  }

  const clampedBlend = Math.min(1, Math.max(0, blend));
  const knots: RemapKnot[] = [{ physical: 0, display: 0 }];
  let physicalCumulative = 0;
  let displayCumulative = 0;
  for (let index = 0; index < count; index++) {
    physicalCumulative += physicalThickness[index];
    displayCumulative += physicalThickness[index] + (displayThickness[index] - physicalThickness[index]) * clampedBlend;
    knots.push({ physical: physicalCumulative, display: displayCumulative });
  }
  // Pin the surface exactly: rounding must not leave the rim at 0.9999.
  knots[knots.length - 1] = { physical: 1, display: 1 };
  return { knots };
}

function interpolate(knots: readonly RemapKnot[], value: number, from: keyof RemapKnot, to: keyof RemapKnot): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  for (let index = 1; index < knots.length; index++) {
    const lower = knots[index - 1];
    const upper = knots[index];
    if (value <= upper[from]) {
      const span = upper[from] - lower[from];
      if (span <= 0) return upper[to];
      const t = (value - lower[from]) / span;
      return lower[to] + (upper[to] - lower[to]) * t;
    }
  }
  return 1;
}

/** Physical radius fraction → drawn radius fraction. */
export function toDisplayFraction(remap: ReadableRemap, physicalFraction: number): number {
  return interpolate(remap.knots, physicalFraction, 'physical', 'display');
}

/** Drawn radius fraction → physical radius fraction: the inverse of toDisplayFraction. */
export function toPhysicalFraction(remap: ReadableRemap, displayFraction: number): number {
  return interpolate(remap.knots, displayFraction, 'display', 'physical');
}

/**
 * Projected radius, in pixels, of a sphere of radius `radius` whose centre is
 * `distance` from a rectilinear camera of vertical field `fovDeg` drawing
 * into a viewport `viewportHeightPx` tall. The silhouette of a sphere is a
 * circle of angular radius asin(radius / distance); a camera inside the
 * sphere gets the whole viewport.
 */
export function projectedRadiusPx(radius: number, distance: number, fovDeg: number, viewportHeightPx: number): number {
  if (!(distance > radius)) return viewportHeightPx;
  const angular = Math.asin(radius / distance);
  const halfFov = (fovDeg * Math.PI) / 360;
  return (Math.tan(angular) / Math.tan(halfFov)) * (viewportHeightPx / 2);
}

/**
 * Orbit distance that frames a unit sphere: on wide screens the disc takes
 * `heightFraction` of the frame's height; on portrait screens the horizontal
 * field is the tight side, so the disc takes `widthFraction` of that instead.
 * Same construction as the compare studio's framing, for a radius of 1.
 */
export function framingDistance(aspect: number, fovDeg: number, heightFraction = 0.66, widthFraction = 0.92): number {
  const verticalHalf = (fovDeg * Math.PI) / 360;
  const horizontalHalf = Math.atan(Math.tan(verticalHalf) * Math.max(aspect, 0.01));
  const fitHalf = Math.min(heightFraction * verticalHalf, widthFraction * horizontalHalf);
  return 1 / Math.sin(fitHalf);
}
