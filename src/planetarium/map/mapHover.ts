/**
 * The map's moving-body hover latch — pure, no THREE, no DOM.
 *
 * A chart at warp moves its bodies under a cursor that is standing still. Hover
 * resolved frame by frame, with nothing holding it, then flickers: the body
 * under the pointer slides off the pixel, the emphasis drops, a neighbour
 * crossing the same pixel steals it, and the card a click was aimed at is not
 * the one it opens. So a hold, released on the two things that mean the user
 * has moved on — time without a confirmed hit, and deliberate pointer travel
 * away from where the hold was last confirmed.
 *
 * Ported from Gregory Zabrodskiy's resolveSystemMapHover (PR #16), with his
 * pickup floor and both release constants. His click geometry is deliberately
 * NOT ported: the map's tap radii are their own contract in mapPicking, and
 * widening them here would silently fatten every tap target on the chart.
 */

/**
 * Hit radius for hover pickup — deliberately TIGHTER than a tap's, so a body
 * the cursor is merely near never claims the emphasis a click would not claim.
 * A marker with no drawn disc gets exactly this; a globe drawn wider than it
 * gets its own footprint (pickRadiusForAnchor).
 */
export const HOVER_HIT_FLOOR_PX = 18;

/** How long a hold survives with no confirmed hit before the next candidate —
 *  including no candidate at all — takes it. Longer than the double-tap window,
 *  so a hold outlives the gesture it is there to serve. */
export const HOVER_RELEASE_MS = 800;

/** Pointer travel from the hold's anchor that counts as aiming somewhere else.
 *  Measured against the anchor — where the pointer was at the last confirmed
 *  hit — never frame to frame, or a slow drift would never add up to a release. */
export const HOVER_RECLAIM_MOVE_PX = 4;

/**
 * What the hover should be this frame.
 *
 * A new or empty candidate replaces the held body only once the hold has
 * lapsed: no confirmed hit for HOVER_RELEASE_MS, or the pointer has travelled
 * more than HOVER_RECLAIM_MOVE_PX from the anchor. The same candidate always
 * refreshes the hold, however long it has been held.
 */
export function resolveMapHover(
  currentKey: string | null,
  candidateKey: string | null,
  elapsedSinceCurrentHitMs: number,
  pointerDriftSinceCurrentHitPx: number,
): string | null {
  if (currentKey === null || candidateKey === currentKey) return candidateKey;
  const released = elapsedSinceCurrentHitMs >= HOVER_RELEASE_MS
    || pointerDriftSinceCurrentHitPx > HOVER_RECLAIM_MOVE_PX;
  return released ? candidateKey : currentKey;
}
