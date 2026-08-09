/**
 * Which markers a drawn disc hides — pure, no THREE, no DOM, scalars in and out
 * so it can run per body per frame without giving the collector anything to
 * sweep up.
 *
 * The chart's markers are depth-free sprites, deliberately: a symbol standing in
 * for a body far below one pixel has to paint whatever is in front of it, or the
 * chart loses the body. The cost is that the depth buffer cannot answer the one
 * question the eye asks anyway — is that moon in front of its planet, or behind
 * it? A gate written on the distance from the camera answers it backwards: that
 * distance is LARGEST exactly when a moon is directly behind its parent, so the
 * moon glides across the lit face as a transit that is not happening, while its
 * own depth-tested orbit ring correctly dies at the limb.
 *
 * Two facts decide it, and neither is a distance in three dimensions: which side
 * of the occluder's centre plane the marker sits on along the VIEW AXIS, and how
 * far the two centres land apart in screen PX. Both are things the drawing pass
 * has already measured.
 *
 * The answer is its own state, kept apart from whether the chart draws the body
 * at all. A moon behind its parent is still a surface the camera has to clear
 * and still what a zoom pivots on; what it is not is something to paint a
 * symbol, a name, or a hit target for.
 */

/**
 * Smallest hysteresis band, screen px. A marker drawn a fraction of a pixel
 * across would otherwise get no band at all, and the sub-pixel jitter of a
 * moon riding its parent around the Sun would strobe it on and off at the limb.
 */
export const OCCLUSION_HYSTERESIS_MIN_PX = 1;

/**
 * Half-width of the band around the occluder's limb inside which the last
 * answer stands: half the marker's own drawn radius, never less than the floor
 * above. Keyed to the marker because that is the scale at which the decision is
 * visible — a dot skimming the limb tangentially crosses this band once and
 * settles, instead of flipping on every frame that nudges it a hair either way.
 */
export function occlusionMarginPx(markerRadiusPx: number): number {
  const half = markerRadiusPx > 0 ? markerRadiusPx * 0.5 : 0;
  return half > OCCLUSION_HYSTERESIS_MIN_PX ? half : OCCLUSION_HYSTERESIS_MIN_PX;
}

/**
 * Screen separation in px between two points given in CAMERA space: `x` right,
 * `y` up, `depth` along the view axis (the positive distance in front of the
 * camera, which is −z). `worldPerPxAtUnitDepth` is the world span of one screen
 * px at unit depth — the same camera fact the drawn sizes scale with.
 *
 * Each point is divided by the world-per-px at ITS OWN depth, which is the
 * whole point: a marker twice as far as the disc it stands behind projects at
 * half the transverse offset, and a separation taken in world units would call
 * it clear of a limb it is well inside.
 *
 * Infinity for a degenerate depth — that reads as "nowhere near", which leaves
 * the marker drawn, and drawing a marker that should have been hidden is the
 * recoverable failure.
 */
export function markerSeparationPx(
  markerX: number,
  markerY: number,
  markerDepth: number,
  discX: number,
  discY: number,
  discDepth: number,
  worldPerPxAtUnitDepth: number,
): number {
  const markerPerPx = worldPerPxAtUnitDepth * markerDepth;
  const discPerPx = worldPerPxAtUnitDepth * discDepth;
  if (!(markerPerPx > 0) || !(discPerPx > 0)) return Infinity;
  const dx = markerX / markerPerPx - discX / discPerPx;
  const dy = markerY / markerPerPx - discY / discPerPx;
  return Math.hypot(dx, dy);
}

/**
 * Whether a marker is hidden behind a drawn disc — the gate for its dot, its
 * label and its hit target.
 *
 * `discDrawn` is the occluder's DRAWN MODE, not its size: a parent the chart is
 * drawing as its own marker paints a symbol, not a body, and a symbol occludes
 * nothing. (It matters at every reveal distance where the moons arrive while
 * their planet is still a dot.)
 *
 * The centre-plane test is sufficient rather than exact, and deliberately in the
 * forgiving direction: a marker beyond the sphere's centre is certainly behind
 * its near surface, while one just inside the centre plane near the limb is
 * technically behind the surface and still drawn. That residue is a sliver of a
 * pixel at the limb; the alternative is a marker that vanishes before it reaches
 * the disc.
 *
 * A disc no bigger than the marker cannot swallow it, so it never hides it: an
 * outer planet crossing behind the Sun's small chart disc still shows a globe
 * wider than the star, and its name belongs with it.
 *
 * `wasBehind` is the previous frame's answer, held through the hysteresis band.
 */
export function markerBehindDisc(
  discDrawn: boolean,
  markerDepth: number,
  markerRadiusPx: number,
  discDepth: number,
  discRadiusPx: number,
  separationPx: number,
  wasBehind: boolean,
): boolean {
  if (!discDrawn) return false;
  if (!(discRadiusPx > markerRadiusPx)) return false;
  if (!(markerDepth > discDepth)) return false;
  const margin = occlusionMarginPx(markerRadiusPx);
  if (separationPx <= discRadiusPx - margin) return true;
  if (separationPx >= discRadiusPx + margin) return false;
  return wasBehind;
}

/**
 * The other half of the same question: whether a marker stands IN FRONT of a
 * drawn disc with its paint landing on it. What that answers is compositing —
 * a depth-free marker drawn before a depth-free disc is painted over by it,
 * however near the camera the marker really is, so the near one has to be
 * lifted above the disc for the frame it overlaps.
 *
 * No hysteresis: at the moment the two footprints stop touching, which order
 * they were drawn in makes no difference to a single pixel.
 */
export function markerInFrontOfDisc(
  discDrawn: boolean,
  markerDepth: number,
  markerRadiusPx: number,
  discDepth: number,
  discRadiusPx: number,
  separationPx: number,
): boolean {
  if (!discDrawn) return false;
  if (markerDepth > discDepth) return false;
  return separationPx < discRadiusPx + markerRadiusPx;
}
