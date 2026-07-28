/**
 * The two decisions behind the map's mini-globes — pure, no THREE, no DOM.
 * Both run per body per frame, so both take and return scalars: no object
 * argument, no object result, nothing for the collector to sweep up.
 *
 * 1. Globe or dot. The map draws a body as a lit little world only when it has
 *    something honest to draw: a surface texture the world has already loaded,
 *    and a chart whose radii are compressed. Everything else falls back to the
 *    schematic dot — never an untextured sphere, which would be a body shown
 *    half-loaded, and never a globe at true scale, where the whole system is a
 *    field of sub-pixel points and the dot IS the visible object.
 *
 *    The swap keys off the scale control's committed target, not the animating
 *    blend, so it happens on the gesture that asked for it. Mid-animation the
 *    look is already settled and only the distances slide; a threshold part-way
 *    through would pop for no reason the viewer could name.
 *
 * 2. Texture adoption. The map borrows the world's texture objects and owns
 *    none of them: the world disposes the old texture the moment it hot-swaps a
 *    sharper tier in, so a reference held across that swap points at freed GPU
 *    memory and draws black. The rule is re-read and compare by identity every
 *    update — adopt whatever the world material carries now, keep nothing else,
 *    dispose nothing ever. Dropping to null is itself an adoption, not a free.
 */

export type MapBodyDraw = 'globe' | 'dot';

/**
 * Which of the two looks a body draws as this frame.
 *
 * `textureReady` — the world's material for this body carries a colour map;
 * false while it is still loading. `trueScaleTarget` — the scale control's
 * committed target is true scale; the blend may still be animating toward it,
 * and the draw mode follows the target, not the blend.
 */
export function mapBodyDrawMode(textureReady: boolean, trueScaleTarget: boolean): MapBodyDraw {
  if (trueScaleTarget) return 'dot';
  return textureReady ? 'globe' : 'dot';
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
