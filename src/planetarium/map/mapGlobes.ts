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
 *    With a texture, one rule covers every scale mode: the globe draws from
 *    the moment the body's real disc overtakes the marker the chart would
 *    have drawn instead — the size policy's own "marker and truth meet
 *    exactly where they cross" invariant, so that swap is continuous by
 *    construction — and also whenever the marker itself is big enough to
 *    carry a face (`globeMinPx`, per call site): the drawn size is floored at
 *    the marker either way, so a body-sized mark painted as an abstract dot
 *    read as an unloaded body, not as a schematic symbol. Below the threshold
 *    a mark is a few px, where a globe is mush — and, at the whole-system
 *    overview, an unlit hemisphere — and a crisp catalog-tinted dot is the
 *    honest symbol. The threshold is a parameter because the call sites want
 *    different answers: the full chart's planets take MAP_GLOBE_MIN_PX (this
 *    is what turns the far overview's night-side spheres back into chart
 *    dots as the zoom response shrinks their markers), the corner chart takes
 *    0 (fixed framing, marks always in the 2.4–6 px band — its tiny globes
 *    are its established look), and moons take 0 while compressed (a
 *    revealed system's small moons draw as globes today and the change that
 *    introduced the threshold had no business near them) and
 *    MAP_GLOBE_MIN_PX at true scale, exactly as before. Footprint parity is
 *    what keeps the swap free — labels, picking and occlusion all measure
 *    the policy radius, whichever look draws it. On the true side of the
 *    scale blend a floored globe composites like the marker it replaces
 *    (depth-free, hidden and lifted analytically against the solar disc):
 *    its sphere is inflated in world AU, so its depth is a lie an inflated
 *    Mercury must never write over the Sun. (Fully compressed, the whole
 *    chart is inflated in concert and the latches judge the drawn discs, so
 *    depth-tested globes are the right compositing there.)
 *
 *    Where a caller keys the threshold off the scale mode (the moons), it
 *    keys off the scale control's committed TARGET, not the animating blend,
 *    so the decision happens on the gesture that asked for it. Mid-animation
 *    the look is already settled and only the distances slide; a threshold
 *    part-way through would pop for no reason the viewer could name.
 *
 * 2. Texture adoption. The map borrows the world's texture objects and owns
 *    none of them: the world disposes the old texture the moment it hot-swaps a
 *    sharper tier in, so a reference held across that swap points at freed GPU
 *    memory and draws black. The rule is re-read and compare by identity every
 *    update — adopt whatever the world material carries now, keep nothing else,
 *    dispose nothing ever. Dropping to null is itself an adoption, not a free.
 */

export type MapBodyDraw = 'globe' | 'dot';

/** The smallest marker radius that draws as a globe on the full chart. A mark
 *  this big is a body-sized footprint either way — painting it as an abstract
 *  dot reads as an unloaded body, not as a schematic symbol, so once there is
 *  room for a face the real textured globe draws at the same footprint. Below
 *  it a mark is a few px, where a globe is mush and a crisp dot is the honest
 *  symbol — which turns the far overview's shrunken planet marks into dots
 *  and keeps a true-scale system's small moons as dots. The corner chart and
 *  compressed moons pass 0 instead: always-globe, their unchanged look. */
export const MAP_GLOBE_MIN_PX = 5;

/**
 * Which of the two looks a body draws as this frame.
 *
 * `textureReady` — the world's material for this body carries a colour map;
 * false while it is still loading. `trueProjectedPx` — the body's REAL disc
 * radius on screen right now. `markerRadiusPx` — the chart marker it would
 * draw at instead, at the size actually painted: callers pass the
 * zoom-SCALED marker, so the demotion judges the mark on the glass, not the
 * knob value behind it. `globeMinPx` — the smallest marker that still draws
 * as a globe here; see the constant above for who passes what.
 *
 * The globe draws from the moment the real disc overtakes the marker — the
 * crossover the size policy hands the drawn radius over at — and whenever the
 * marker itself is big enough to carry a face: the drawn size is floored at
 * the marker either way, so the globe is no more inflated than the dot it
 * replaces, and it looks like the world it stands for instead of like a
 * texture that never arrived.
 */
export function mapBodyDrawMode(
  textureReady: boolean,
  trueProjectedPx: number,
  markerRadiusPx: number,
  globeMinPx: number,
): MapBodyDraw {
  if (!textureReady) return 'dot';
  if (trueProjectedPx >= markerRadiusPx) return 'globe';
  return markerRadiusPx >= globeMinPx ? 'globe' : 'dot';
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
