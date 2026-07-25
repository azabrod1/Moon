/**
 * System-map picking — pure nearest-anchor selection over projected screen
 * positions. No THREE, no DOM: SystemMap projects the bodies and the ship into
 * screen px each frame and hands the anchors here.
 */

/** Tap hit radius on a fine pointer (mouse). */
export const PICK_RADIUS_FINE = 24;
/** Fatter hit radius on a coarse pointer (finger/pen). */
export const PICK_RADIUS_COARSE = 44;
/** Pointer travel between down and up beyond which the gesture is a drag,
 *  not a pick. */
export const PICK_MOVE_SLOP = 6;

export interface PickAnchor {
  name: string;
  /** Screen px from the canvas top-left. */
  x: number;
  y: number;
  /** The ship marker is inert — present as an anchor (so a tap on it lands on
   *  something and does nothing) but never pickable. */
  pickable: boolean;
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

/**
 * Nearest anchor to (x, y) within `radiusPx`. The ship counts as a candidate so
 * it wins when it is the nearest thing under the finger (users tap it first) and
 * swallows the tap; a pickable body under the finger returns a body pick; empty
 * space returns 'empty' so the caller can dismiss the card.
 */
export function resolvePick(
  x: number,
  y: number,
  anchors: readonly PickAnchor[],
  radiusPx: number,
): PickResult {
  const r2 = radiusPx * radiusPx;
  let best: PickAnchor | null = null;
  let bestD2 = Infinity;
  for (const a of anchors) {
    const dx = a.x - x;
    const dy = a.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= r2 && d2 < bestD2) {
      bestD2 = d2;
      best = a;
    }
  }
  if (!best) return { kind: 'empty' };
  return best.pickable ? { kind: 'body', name: best.name } : { kind: 'ship' };
}
