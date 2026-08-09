/**
 * Moon-label placement rules: which moons earn a label, and how the ones that
 * earn one share the screen.
 *
 * DOM-free by design — the controller gathers the candidates and applies the
 * decision to the elements. Everything here is screen-space arithmetic over
 * pooled candidate objects, so a steady-state frame allocates nothing.
 *
 * A label is earned by what the moon WOULD show fully lit, not by what it shows
 * this instant: a moon in eclipse or at new phase is still there and still
 * aimable, so its name holds through the darkness in a dimmer style rather than
 * strobing off with its dot. Every non-photometric fade — the parent-dominance
 * gate, the system edge, the disc handoff — still reaches the label, so a name
 * dies where the moon itself stops being shown.
 *
 * Tuning constants live in MOON_LABEL_PLACEMENT_PARAMS; the controller keeps a
 * live copy the dev bridge merges into (`__moon.setMoonLabelPlacementParams`)
 * for tuning by eye.
 */

/** A moon's padded disc reads as more than a point at or above this radius (px):
 *  at that size the moon is its own anchor and the label needs no dot. */
export const LABEL_READABLE_RADIUS_PX = 1.0;

/** Dot alpha at or above which a sub-pixel moon is worth naming: below it there
 *  is nothing on screen for the name to point at. Read against the moon's dot
 *  alpha WITH illumination forced full, so darkness alone never strips a name. */
export const LABEL_DOT_MIN_ALPHA = 0.03;

export interface MoonLabelPlacementParams {
  /** Dark-label style band, read against the dot's ACTUAL alpha: the `.unlit`
   *  class turns on below `unlitEnterAlpha` and off above `unlitLeaveAlpha`. Two
   *  thresholds because a dot hovering near a single one flickers on its own
   *  photometry, and the style would pulse with it. */
  unlitEnterAlpha: number;
  unlitLeaveAlpha: number;
}

export const MOON_LABEL_PLACEMENT_PARAMS: MoonLabelPlacementParams = {
  unlitEnterAlpha: 0.02,
  unlitLeaveAlpha: 0.05,
};
