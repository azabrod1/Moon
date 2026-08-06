/**
 * The two decisions behind the map's mini-globes — pure, no THREE, no DOM.
 * Both run per body per frame, so both take and return scalars: no object
 * argument, no object result, nothing for the collector to sweep up.
 *
 * 1. Globe or dot. The map draws a body as a lit little world only when it has
 *    something honest to draw: a surface texture the world has already loaded.
 *    Without one it falls back to the schematic dot — never an untextured
 *    sphere, which would be a body shown half-loaded.
 *
 *    On the compressed chart the globe is the look throughout. At true scale
 *    the whole system is a field of sub-pixel points and the dot IS the visible
 *    object — until the camera closes on one body far enough that its real disc
 *    overtakes the marker the chart would have drawn instead. That crossover,
 *    not a flat pixel threshold, is the gate: it is the size policy's own
 *    "marker and truth meet exactly where they cross" invariant, so the swap is
 *    continuous by construction. Gating on a smaller number would hand the
 *    globe over while the per-body marker floor still governs its drawn size,
 *    and a "true-scale" globe would appear several times inflated.
 *
 *    The compressed/true decision keys off the scale control's committed
 *    target, not the animating blend, so it happens on the gesture that asked
 *    for it. Mid-animation the look is already settled and only the distances
 *    slide; a threshold part-way through would pop for no reason the viewer
 *    could name.
 *
 * 2. Texture adoption. The map borrows the world's texture objects and owns
 *    none of them: the world disposes the old texture the moment it hot-swaps a
 *    sharper tier in, so a reference held across that swap points at freed GPU
 *    memory and draws black. The rule is re-read and compare by identity every
 *    update — adopt whatever the world material carries now, keep nothing else,
 *    dispose nothing ever. Dropping to null is itself an adoption, not a free.
 */

export type MapBodyDraw = 'globe' | 'dot';

/** The smallest marker radius that draws as a globe at true scale. A mark this
 *  big is a body-sized footprint either way — painting it as an abstract dot
 *  reads as an unloaded body, not as a schematic symbol, so once there is room
 *  for a face the real textured globe draws at the same footprint. Below it a
 *  mark is a few px, where a globe is mush and a crisp dot is the honest
 *  symbol — which keeps a revealed system's small moons as dots. */
export const TRUE_SCALE_GLOBE_MIN_PX = 5;

/**
 * Which of the two looks a body draws as this frame.
 *
 * `textureReady` — the world's material for this body carries a colour map;
 * false while it is still loading. `trueScaleTarget` — the scale control's
 * committed target is true scale; the blend may still be animating toward it,
 * and the draw mode follows the target, not the blend. `trueProjectedPx` — the
 * body's REAL disc radius on screen right now, and `markerRadiusPx` the chart
 * marker it would draw at instead.
 *
 * Compressed always draws the globe. True scale draws it from the moment the
 * real disc overtakes the marker — the crossover the size policy hands the
 * drawn radius over at — and also whenever the marker itself is big enough to
 * carry a face: the drawn size is floored at the marker either way, so the
 * globe is no more inflated than the dot it replaces, and it looks like the
 * world it stands for instead of like a texture that never arrived.
 */
export function mapBodyDrawMode(
  textureReady: boolean,
  trueScaleTarget: boolean,
  trueProjectedPx: number,
  markerRadiusPx: number,
): MapBodyDraw {
  if (!textureReady) return 'dot';
  if (!trueScaleTarget) return 'globe';
  if (trueProjectedPx >= markerRadiusPx) return 'globe';
  return markerRadiusPx >= TRUE_SCALE_GLOBE_MIN_PX ? 'globe' : 'dot';
}

/**
 * Whether the map must point its material at the reference the world carries
 * now. Compared by identity, never by contents: a first arrival, a tier swap,
 * and a texture that went away all read as a change, and an unchanged reference
 * is kept. What the caller does on true is assign — the old reference is
 * dropped, never disposed, because the map did not create it.
 */
export function shouldAdoptTexture<T extends object>(
  held: T | null | undefined,
  world: T | null | undefined,
): boolean {
  return (held ?? null) !== (world ?? null);
}
