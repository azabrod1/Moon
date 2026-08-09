/**
 * System-map picking — pure nearest-anchor selection over projected screen
 * positions. No THREE, no DOM: SystemMap projects the bodies and the ship into
 * screen px each frame and hands the anchors here.
 *
 * A body's hit target is the larger of the pointer floor and its own drawn
 * disc: the floor keeps a sub-pixel marker comfortably tappable, and the disc
 * keeps a body that draws large from rejecting a click on its own limb. The
 * map renders without the lens pass, so a disc radius is plain camera
 * projection — never the world's warped-limb seam.
 */

/** Tap hit radius on a fine pointer (mouse). */
export const PICK_RADIUS_FINE = 24;
/** Fatter hit radius on a coarse pointer (finger/pen). */
export const PICK_RADIUS_COARSE = 44;
/** Pointer travel between down and up beyond which the gesture is a drag,
 *  not a pick. */
export const PICK_MOVE_SLOP = 6;
/** Slack outside a drawn disc, so the limb itself is comfortably clickable.
 *  Smaller than either pointer floor, so a marker-sized body is unaffected. */
export const PICK_DISC_PAD = 4;

export interface PickAnchor {
  name: string;
  /** Screen px from the canvas top-left. */
  x: number;
  y: number;
  /** The ship marker is inert — present as an anchor (so a tap on it lands on
   *  something and does nothing) but never pickable. */
  pickable: boolean;
  /** Drawn radius in screen px, 0 for a marker with no footprint of its own.
   *  Anchors track the body's map position rather than any mesh, so this is the
   *  only thing that changes as a marker grows into a globe. */
  discRadiusPx: number;
}

export type PickResult =
  | { kind: 'body'; name: string }
  /** A tap that landed on the ship marker — swallowed, dismisses nothing. */
  | { kind: 'ship' }
  /** A tap on empty map space — dismisses the open card. */
  | { kind: 'empty' };

/** Radius for the active pointer. A coarse pointer (touch/pen) gets the fat one. */
export function pickRadiusFor(pointerType: string): number {
  return pointerType === 'mouse' ? PICK_RADIUS_FINE : PICK_RADIUS_COARSE;
}

/**
 * Whether an anchor is close enough to the viewport to be pickable. A marker
 * (no drawn disc) must have its CENTRE inside the frame — a dot half off the
 * edge isn't a target. A body with a footprint counts while any of that
 * footprint is on screen, so a globe drifting off the edge stays clickable by
 * the limb the viewer can still see.
 */
export function anchorOnScreen(
  x: number,
  y: number,
  w: number,
  h: number,
  discRadiusPx = 0,
): boolean {
  const reach = discRadiusPx > 0 ? discRadiusPx : 0;
  return x >= -reach && x <= w + reach && y >= -reach && y <= h + reach;
}

/** Hit radius for one anchor: the pointer floor, or its own drawn disc plus a
 *  pad once the body is drawn larger than the floor. */
export function pickRadiusForAnchor(
  pointerRadiusPx: number,
  discRadiusPx: number,
  pad = PICK_DISC_PAD,
): number {
  const disc = discRadiusPx > 0 ? discRadiusPx + pad : 0;
  return disc > pointerRadiusPx ? disc : pointerRadiusPx;
}

/** A gesture is a pick (tap) when the pointer barely moved between down and up. */
export function isTap(
  downX: number,
  downY: number,
  upX: number,
  upY: number,
  slop = PICK_MOVE_SLOP,
): boolean {
  const dx = upX - downX;
  const dy = upY - downY;
  return dx * dx + dy * dy <= slop * slop;
}

// Pooled results — resolvePick runs on pointer events (hover, tap), and returns
// one of these without allocating. Every caller reads the result before the
// next resolvePick call, so the single mutable body result is safe to reuse.
const EMPTY_RESULT: PickResult = { kind: 'empty' };
const SHIP_RESULT: PickResult = { kind: 'ship' };
const BODY_RESULT: { kind: 'body'; name: string } = { kind: 'body', name: '' };

/**
 * Nearest anchor to (x, y) within its own hit radius — `pointerRadiusPx` for a
 * marker, its drawn disc for a body big enough to have one. The ship counts as
 * a candidate so it wins when it is the nearest thing under the finger (users
 * tap it first) and swallows the tap; a pickable body under the finger returns
 * a body pick; empty space returns 'empty' so the caller can dismiss the card.
 *
 * Nearest wins even across mismatched hit radii, so a small marker sitting in
 * front of a large disc still takes the tap.
 *
 * A tie (equal distance) resolves to whichever anchor was supplied first — the
 * caller lists bodies before the ship, so a docked ship ring sitting exactly on
 * its parent's dot yields to the planet. The result is a pooled object; read it
 * before calling resolvePick again.
 */
export function resolvePick(
  x: number,
  y: number,
  anchors: readonly PickAnchor[],
  pointerRadiusPx: number,
): PickResult {
  let best: PickAnchor | null = null;
  let bestD2 = Infinity;
  for (const a of anchors) {
    const dx = a.x - x;
    const dy = a.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 >= bestD2) continue;
    const r = pickRadiusForAnchor(pointerRadiusPx, a.discRadiusPx);
    if (d2 <= r * r) {
      bestD2 = d2;
      best = a;
    }
  }
  if (!best) return EMPTY_RESULT;
  if (!best.pickable) return SHIP_RESULT;
  BODY_RESULT.name = best.name;
  return BODY_RESULT;
}
