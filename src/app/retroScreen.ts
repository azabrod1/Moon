/**
 * The retro look's screen: one small grid of big pixels that the picture and
 * the interface share, the way a 1990s machine drew everything into one
 * 320 × 200 frame buffer.
 *
 * The grid is a whole number of canvas pixels per big pixel (`block`), chosen
 * so the short side of the canvas holds about RETRO_LINES of them. Anchored at
 * the canvas's top-left corner, not centred: the interface's edges are placed
 * on the same grid from the top-left (`--px` in index.html), and a centred grid
 * would put them half a block off it. Where the canvas is not a whole number
 * of blocks, the last column and row of big pixels hang off the right and
 * bottom edges and are cut there.
 *
 * The scene is drawn into a target RETRO_SCENE_SUPERSAMPLE times the grid and
 * averaged down onto it by the finishing pass's own box (app/FusedOutputPass.ts)
 * — 1.5 is the largest ratio that box averages exactly, two taps per axis.
 * Drawn 1:1 instead, every big pixel would be one bilinear tap at a warped
 * position: soft, and a one-pixel line would ripple. A chain without the box
 * (`?fused=0`, `?fuseddown=0`) draws it 1:1.
 *
 * The camera still frames the canvas, and the image it draws is laid over the
 * whole grid, so the picture is stretched by the hanging part of the last big
 * pixel: under one big pixel at the far edges, and nothing at the top-left.
 * HTML drawn over the picture therefore lines up with it to within one big
 * pixel everywhere.
 */

/** Big pixels on the canvas's short side: 200, a 320 × 200 VGA screen on a 16:10 window. */
export const RETRO_LINES = 200;

/** The scene draw, in big pixels: the most the finishing pass's box averages exactly. */
export const RETRO_SCENE_SUPERSAMPLE = 1.5;

export interface RetroSize {
  width: number;
  height: number;
}

export interface RetroGrid {
  /** Canvas pixels per big pixel, a whole number of at least 1. */
  block: number;
  /** Big pixels across and down, the hanging last column and row included. */
  virtual: RetroSize;
  /** The scene draw, in device pixels. */
  scene: RetroSize;
  /** One big pixel in CSS px: what the interface sizes itself by. */
  cssPixel: number;
}

/**
 * The grid for a canvas of `bufferWidth × bufferHeight` device pixels shown at
 * `outputRatio` device pixels per CSS px. `supersample` is the scene's ratio
 * to the grid: RETRO_SCENE_SUPERSAMPLE where the finishing pass can average
 * it, 1 where it cannot.
 */
export function retroGrid(
  bufferWidth: number,
  bufferHeight: number,
  outputRatio: number,
  supersample: number = RETRO_SCENE_SUPERSAMPLE,
): RetroGrid {
  const width = Math.max(1, Math.floor(bufferWidth));
  const height = Math.max(1, Math.floor(bufferHeight));
  const block = Math.max(1, Math.round(Math.min(width, height) / RETRO_LINES));
  const virtual = { width: Math.ceil(width / block), height: Math.ceil(height / block) };
  const factor = supersample > 0 ? supersample : 1;
  return {
    block,
    virtual,
    scene: {
      width: Math.max(1, Math.round(virtual.width * factor)),
      height: Math.max(1, Math.round(virtual.height * factor)),
    },
    cssPixel: block / (outputRatio > 0 ? outputRatio : 1),
  };
}
