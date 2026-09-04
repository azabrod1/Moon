/**
 * The map HUD's two decisions that are pure once the DOM has been read, kept
 * DOM-free so they can be pinned: which card clicks count, and what the card
 * sheds when it runs out of room. MapHUD does the reading and the writing;
 * the rule lives here.
 */

/**
 * Whether a click on a card control is one the user actually made on it: the
 * control the last pointerdown armed. A keyboard activation arrives with
 * detail 0 and no pointer behind it, so it always passes — the card stays
 * fully operable without a pointer. A synthesized click no press armed is
 * refused: on a 320 px phone, one tap on Jupiter used to teleport the ship.
 */
export function cardClickArmed(detail: number, armed: unknown, control: unknown): boolean {
  if (detail === 0) return true;
  return armed === control;
}

/**
 * What a card that cannot fit its facts gives up. The event row is the one
 * thing that comes off before the facts do — the facts are what the card is
 * for, and the row is news that will keep — but only if losing it actually
 * buys the facts a viewport worth having; on a card too short for them either
 * way, the news stays and the facts come off. `roomWithoutRow` is the caller's
 * measurement with the row hidden, taken only when there is a row to shed
 * (null otherwise).
 */
export function cardOverflowPlan(
  factsRoom: number,
  roomWithoutRow: number | null,
  minFactsPx: number,
): { dropEventRow: boolean; dropFacts: boolean } {
  if (factsRoom >= minFactsPx) return { dropEventRow: false, dropFacts: false };
  if (roomWithoutRow !== null && roomWithoutRow >= minFactsPx) {
    return { dropEventRow: true, dropFacts: false };
  }
  return { dropEventRow: false, dropFacts: true };
}
