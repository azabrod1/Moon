/**
 * The depth bias that keeps Earth's thin shells clear of the globe underneath
 * them — the one place the ladder is stated, because every rung has to be
 * ordered against the others and three separate numbers would drift apart.
 *
 * WHY A BIAS IS NEEDED AT ALL. Earth is drawn as four concentric shells: the
 * globe (the only one that writes depth), the night lights at 6.4 km, the cloud
 * deck at 10 km, and the air at 128 km. The two middle ones are a few
 * kilometres above a ball 6,378 km across, and they are depth-TESTED against
 * the globe even though geometry guarantees they are in front of it. That test
 * is only there to let something genuinely nearer — the ship, a moon crossing
 * the disc — occlude them; the globe beating them is always wrong.
 *
 * And at cruise range the globe does beat them. The cruise near plane is a
 * fraction of the distance to the SHIP (cruiseView.cruiseCameraNearAU), so it
 * sits at tens of kilometres no matter how far away the body is — 47 km at the
 * default chase, under 30 km with the camera zoomed in, 9 km at the wheel-zoom
 * floor. A 24-bit buffer spread over that near plane and a 200 AU far plane
 * resolves, at 80,000 km, about 7.6 km per depth step at the default chase and
 * 40 km at the zoom floor. The deck's 10 km of clearance is then worth about
 * one step, or a quarter of one, and the polygonal shells eat into even that:
 * a 96-segment sphere's facets sag 3.4 km below the true surface at the
 * equator, and the deck is spun against the globe for cloud drift, so the two
 * facet grids are out of phase and the real clearance falls to ~6.6 km. Below
 * one step the order the rasteriser computes is decided by float32 rounding in
 * two different meshes rather than by the 10 km between them, and the globe
 * wins on scattered fragments — pinpricks and slivers of bare ocean punched
 * through solid cloud, which re-shuffle as the near plane breathes with the
 * camera. That is the fizz an approach from the Moon shows.
 *
 * WHY THE BIAS IS SAFE. A units-only offset is a constant in WINDOW depth, so
 * the range it covers shrinks exactly as fast as the depth buffer's own
 * resolution does: DECK units buys ~92 km of margin at 80,000 km, ~24 cm from
 * low orbit, and nothing at any range is that close in front of a cloud top.
 * The slope factor stays 0 for the reason the sector materials give — it grows
 * without bound at the limb.
 *
 * THE ORDER. Larger magnitude is nearer the camera. The globe sits at 0 with
 * its day tiles just in front of it; then the night shell, then the night
 * sectors that replace it (their own per-level step preserved on top of this
 * base, which is the whole mechanism by which a sector's depth beats the
 * shell's), then the deck above all of them. The air needs none: at 128 km it
 * clears the buffer by a wide margin, and it writes no depth and draws last.
 */

/** Base lift for a shell that hangs just above the globe. */
export const SHELL_DEPTH_BIAS_UNITS = 4;

/** The night-lights shell itself. */
export const NIGHT_SHELL_DEPTH_BIAS_UNITS = SHELL_DEPTH_BIAS_UNITS;

/** A night sector at `level`, which must beat the shell it replaces by its own
 *  step while keeping the shared base — finest nearest, as before. */
export function nightSectorDepthBiasUnits(level: number): number {
  return SHELL_DEPTH_BIAS_UNITS + level + 1;
}

/** The cloud deck, above every night rung so city lights never draw through a
 *  cloud top. Four clear of the deepest night sector the streamer builds. */
export const CLOUD_DECK_DEPTH_BIAS_UNITS = SHELL_DEPTH_BIAS_UNITS + 8;
