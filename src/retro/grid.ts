/**
 * The Retro look's two grids.
 *
 * The picture's: a whole number of canvas pixels per big pixel (`block`),
 * chosen so the canvas's short side holds about RETRO_LINES of them — a
 * 320 × 200 VGA screen on a 16:10 window. Anchored at the canvas's top-left;
 * where the canvas is not a whole number of blocks, the last column and row
 * hang off the right and bottom edges and are cut there.
 *
 * The scene under the picture is drawn coarser to match (retroSceneRatio):
 * about SCENE_PIXELS_PER_BLOCK of its pixels across each big pixel, which is
 * all the reduce needs, but never below half the canvas's resolution — a
 * quarter of a 2× display's pixels, and as coarse as the reduce's point curve
 * was measured at (RetroPass.ts POINT_CURVE).
 *
 * The interface's: a whole number of DEVICE pixels, about one and a half
 * (three on a 2× display, one on a 1× monitor), finer than the picture's on
 * purpose — on a strict 200-line grid the app's own menu, at about eighteen
 * rows, would not fit on the screen.
 */

export const RETRO_LINES = 200;

export interface RetroGrid {
  /** Canvas pixels per big pixel, a whole number of at least 1. */
  block: number;
  /** Big pixels across and down, the hanging last column and row included. */
  virtual: { width: number; height: number };
  /** One big pixel in CSS px. */
  cssPixel: number;
}

/** The picture's grid for a canvas of `bufferWidth × bufferHeight` device
 *  pixels shown at `outputRatio` device pixels per CSS px. */
export function retroGrid(bufferWidth: number, bufferHeight: number, outputRatio: number): RetroGrid {
  const width = Math.max(1, Math.floor(bufferWidth));
  const height = Math.max(1, Math.floor(bufferHeight));
  const block = Math.max(1, Math.round(Math.min(width, height) / RETRO_LINES));
  return {
    block,
    virtual: { width: Math.ceil(width / block), height: Math.ceil(height / block) },
    cssPixel: block / (outputRatio > 0 ? outputRatio : 1),
  };
}

export const SCENE_PIXELS_PER_BLOCK = 3;

/** The scene ratio the look asks for on a `cssWidth × cssHeight` canvas at
 *  `outputRatio`: SCENE_PIXELS_PER_BLOCK scene pixels across each big pixel,
 *  between half the canvas's own ratio and all of it. */
export function retroSceneRatio(cssWidth: number, cssHeight: number, outputRatio: number): number {
  const { block } = retroGrid(cssWidth * outputRatio, cssHeight * outputRatio, outputRatio);
  return outputRatio * Math.min(1, Math.max(0.5, SCENE_PIXELS_PER_BLOCK / block));
}

/** The interface's pixel in CSS px: a whole number of device pixels. */
export function retroInterfacePixel(devicePixelRatio: number): number {
  const ratio = devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.max(1, Math.floor(1.5 * ratio)) / ratio;
}
