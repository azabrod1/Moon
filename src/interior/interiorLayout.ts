/**
 * Where the Look-inside body is drawn and how large: the stage.
 *
 * The stage is the free rectangle of the viewport — the part the tool's own
 * chrome does not cover. That chrome eats the edges: a header strip along the
 * top (Leave, the body's name), a bottom sheet on phones (the legend and the
 * view buttons, whose height the reader drags), a side panel on the right at
 * desktop widths. Take those away, inset what is left by a margin, and the
 * remainder is the rectangle the body may occupy.
 *
 * Two numbers come out of that rectangle, and BOTH are needed:
 *
 *  - the fit distance (`fitDistance`), so the disc is sized against the stage
 *    rather than against the whole viewport. A projection shift on its own
 *    cannot rescue a globe that is too large for the free band: a shift MOVES
 *    the picture, it does not shrink it, so a tall sheet on a small phone
 *    leaves the same oversized disc with its lower half behind the sheet
 *    instead of behind the sheet's top edge. Only a distance that grows with
 *    the obstacles puts the whole body where the reader can see it — which is
 *    why the fit is a function of the layout and is recomputed whenever the
 *    sheet, the panel or the viewport moves.
 *  - the view offset (`stageViewOffset`), so the disc's centre lands at the
 *    stage's centre rather than the viewport's.
 *
 * Sign convention: the offset is three's `camera.setViewOffset(W, H, x, y, W,
 * H)` pair, which names the top-left corner of the sub-window the camera draws
 * out of the full image. A POSITIVE x therefore moves the picture LEFT on
 * screen, and a POSITIVE y moves it UP. The offset scales nothing: the
 * projected size of the body is still set by the full viewport height, which
 * is why `fitDistance` takes `viewportHeight` for the projection and reads the
 * stage only for the size the disc is asked to reach.
 *
 * The fit is the exact inverse of `interiorGeometry`'s `projectedRadiusPx` —
 * the one place the body's projected size is defined — and the round trip is
 * test-pinned, so the two can never drift apart.
 *
 * Pure: plain numbers, no three, no DOM. The caller reads the viewport and
 * measures its own chrome.
 */

export interface StageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Pixels the UI takes from each viewport edge, margins included: the header
 * strip at the top, the sheet at the bottom (phones), the side panel on the
 * right (desktop). 0 for none.
 */
export interface StageObstacles {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

function clampToRange(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * One axis of the stage: the band the obstacles leave, inset by the margin,
 * and never shorter than `minSizePx`. When the obstacles leave less than the
 * minimum the band's own centre is kept (so the overflow is shared between the
 * two obstacles rather than dumped behind one of them), and the result is then
 * nudged to lie inside the viewport; a minimum larger than the viewport itself
 * is centred on the viewport.
 */
function stageAxis(
  viewportSize: number,
  startObstaclePx: number,
  endObstaclePx: number,
  marginPx: number,
  minSizePx: number,
): { start: number; size: number } {
  const margin = Math.max(0, marginPx);
  const minimum = Math.max(0, minSizePx);
  const bandStart = Math.max(0, startObstaclePx);
  const bandEnd = viewportSize - Math.max(0, endObstaclePx);
  const start = bandStart + margin;
  const size = bandEnd - margin - start;
  if (size >= minimum) return { start, size };
  const bandCentre = (bandStart + bandEnd) / 2;
  if (minimum >= viewportSize) return { start: (viewportSize - minimum) / 2, size: minimum };
  return { start: clampToRange(bandCentre - minimum / 2, 0, viewportSize - minimum), size: minimum };
}

/**
 * The free rectangle the body may occupy: the viewport minus the obstacles,
 * inset by `marginPx` on every side, never smaller than `minSizePx` on either
 * axis (when the obstacles leave less than that, the rect keeps `minSizePx`
 * centred in whatever is left, so a huge sheet still leaves a sane stage
 * rather than a zero one).
 */
export function visibleStageRect(
  viewportWidth: number,
  viewportHeight: number,
  obstacles: StageObstacles,
  marginPx: number,
  minSizePx: number,
): StageRect {
  const horizontal = stageAxis(viewportWidth, obstacles.left, obstacles.right, marginPx, minSizePx);
  const vertical = stageAxis(viewportHeight, obstacles.top, obstacles.bottom, marginPx, minSizePx);
  return { x: horizontal.start, y: vertical.start, width: horizontal.size, height: vertical.size };
}

/**
 * The camera distance at which a sphere of `boundRadius` (scene units, at the
 * origin) projects to a disc of diameter `fill × min(stage.width,
 * stage.height)` px, for a perspective camera with vertical `fovDeg` drawing a
 * `viewportHeight`-px-tall image.
 *
 * The exact inverse of `projectedRadiusPx`: that one reads the disc's angular
 * radius asin(radius / distance) off the distance, this one reads the distance
 * off the tangent the wanted pixels ask for. A stage, a fill or a body of
 * nothing has no finite answer and says so with Infinity rather than quietly
 * framing the body somewhere wrong (a radius of nothing would put the camera
 * inside it).
 */
export function fitDistance(
  stage: StageRect,
  viewportHeight: number,
  fovDeg: number,
  boundRadius: number,
  fill: number,
): number {
  const targetRadiusPx = (fill * Math.min(stage.width, stage.height)) / 2;
  if (!(targetRadiusPx > 0) || !(viewportHeight > 0) || !(boundRadius > 0)) return Number.POSITIVE_INFINITY;
  const halfFovRad = (fovDeg * Math.PI) / 360;
  // tan of the angular radius the disc must subtend to cover that many pixels.
  const angularTangent = (targetRadiusPx * Math.tan(halfFovRad)) / (viewportHeight / 2);
  if (!(angularTangent > 0)) return Number.POSITIVE_INFINITY;
  const angularSine = angularTangent / Math.sqrt(1 + angularTangent * angularTangent);
  return boundRadius / angularSine;
}

/**
 * The projection shift that puts the body's centre at the stage's centre:
 * three's `setViewOffset` x and y (positive x moves the picture left, positive
 * y moves it up), rounded to whole pixels.
 */
export function stageViewOffset(
  stage: StageRect,
  viewportWidth: number,
  viewportHeight: number,
): { x: number; y: number } {
  const stageCentreX = stage.x + stage.width / 2;
  const stageCentreY = stage.y + stage.height / 2;
  return {
    x: Math.round(viewportWidth / 2 - stageCentreX),
    y: Math.round(viewportHeight / 2 - stageCentreY),
  };
}

/**
 * How far the reader has zoomed relative to the fit: distance / fit, so a
 * layout change can keep the reader's zoom (newDistance = newFit × ratio).
 * Clamped to [minRatio, maxRatio]; a fit that is not a finite positive
 * distance (no stage yet) reads as the fit itself, ratio 1.
 */
export function zoomRatio(
  currentDistance: number,
  fitDistanceValue: number,
  minRatio: number,
  maxRatio: number,
): number {
  if (!(fitDistanceValue > 0) || !Number.isFinite(fitDistanceValue) || !Number.isFinite(currentDistance)) {
    return clampToRange(1, minRatio, maxRatio);
  }
  return clampToRange(currentDistance / fitDistanceValue, minRatio, maxRatio);
}

/**
 * The distance a re-framing asks for: the new fit, times the zoom the reader
 * had relative to the last one, clamped to the camera's range. The zoom is
 * read off `settledDistance` — where the camera is GOING, not where it is: a
 * glide in flight is the framing's own move, so handing this the camera's
 * mid-glide position would read the glide as a zoom, stop it short and
 * remember the shortfall as the reader's choice for every fit after. Two
 * calls with nothing changed between them therefore ask for the same
 * distance, which is what lets a sheet snap and a page change inside one
 * gesture land where the first of them was going. No last fit yet, or no
 * distance yet, reads as the fit itself.
 */
export function framingDistance(
  fit: number,
  lastFit: number,
  settledDistance: number,
  minDistance: number,
  maxDistance: number,
): number {
  const ratio = settledDistance > 0
    ? zoomRatio(settledDistance, lastFit, minDistance / fit, maxDistance / fit)
    : clampToRange(1, minDistance / fit, maxDistance / fit);
  return clampToRange(fit * ratio, minDistance, maxDistance);
}
