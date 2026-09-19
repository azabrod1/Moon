/**
 * How long the Look-inside ceremony takes, and in what order it happens.
 *
 * These lengths are the tool's feel, not a budget: the cut's opening, a swap's
 * close, the skin's cross-fade and the reopen. They are the studio's own moves.
 * The two lengths either side of them — the fade to black every mode switch
 * waits out, and the veil's lift at the far end — belong to the CSS
 * (index.html's `--veil-fade` and `--veil-lift`), and main reads the fade's
 * duration off the element rather than keeping a second copy of it here: one
 * number, one writer.
 *
 * `revealAfterVeil` is the order. With it, activate resolves with the body
 * presented and the cut still closed, main lifts the veil, and the cut opens
 * once the reader can see it — so the whole opening is seen instead of its
 * first half playing behind black and its second half under a fading veil.
 * Without it, the cut opens at the end of the commit, the way it used to.
 *
 * Session-only, and DEV-only to write: `__moon.interiorTransition({...})` sets
 * them for one page load, so a sheet of candidates can be captured from a
 * single build instead of a build per candidate. Nothing here is persisted.
 */
export interface InteriorTransition {
  /** The entry's opening cut, seconds. */
  openS: number;
  /** A swap's closing cut, which the prepare and the warm-up run inside. */
  closeS: number;
  /** The skin's cross-fade behind the closed cut. */
  dissolveS: number;
  /** A swap's reopening cut. */
  reopenS: number;
  /** Whether the entry's cut waits for the veil to finish lifting. */
  revealAfterVeil: boolean;
}

export const INTERIOR_TRANSITION: InteriorTransition = {
  openS: 0.5,
  closeS: 0.25,
  dissolveS: 0.25,
  reopenS: 0.5,
  revealAfterVeil: true,
};

/** Set some of them for this page load (DEV bridge only). A value that is not
 *  a finite number is ignored, so a typo leaves the ceremony alone. */
export function setInteriorTransition(patch: Partial<InteriorTransition>): InteriorTransition {
  for (const key of ['openS', 'closeS', 'dissolveS', 'reopenS'] as const) {
    const value = patch[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) INTERIOR_TRANSITION[key] = value;
  }
  if (typeof patch.revealAfterVeil === 'boolean') INTERIOR_TRANSITION.revealAfterVeil = patch.revealAfterVeil;
  return { ...INTERIOR_TRANSITION };
}
