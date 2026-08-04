/**
 * Which way the ship's chevron points on a chart — pure, no THREE, no DOM.
 *
 * The heading is a SCREEN direction: the marker and a point one step along the
 * ship's course are both projected, and the angle between them is what the
 * chevron takes. Clip space is square and the viewport usually is not, so the
 * viewport's own width and height are what turn an NDC delta into the angle a
 * viewer sees. The full-screen chart and the corner chart have different
 * aspects, so neither may assume the canvas: the dimensions come in.
 */

/**
 * Sprite rotation (radians, the sprite material's CCW convention) for a ship
 * whose marker and one-step-ahead point differ by `ndcDx`/`ndcDy` in clip
 * space, drawn into a viewport of `widthPx × heightPx`.
 *
 * The chevron texture points up and screen y runs down, so the angle is taken
 * from screen-up and negated.
 */
export function shipHeadingRotationRad(
  ndcDx: number,
  ndcDy: number,
  widthPx: number,
  heightPx: number,
): number {
  const dx = (ndcDx * widthPx) / 2;
  const dy = (-ndcDy * heightPx) / 2;
  return -Math.atan2(dx, -dy);
}
