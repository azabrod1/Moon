/**
 * When the Paused badge shows. The badge is the one on-screen word for the
 * freeze Space (or the ☰ menu) lays over the scene — the clock stopped and
 * the ship held with it — so it follows the paused clock, minus the places
 * where the word would be wrong or is already said:
 *
 *  - surface view: the transport strip carries its own PAUSED tag and a
 *    Resume button, in the reader's eye line, so a second word is noise;
 *  - the Help modal: a full-screen sheet over a backdrop whose own freeze
 *    is restored on close — there is no scene to be paused over;
 *  - a historic mission: a milestone pauses the clock and THEN flies its
 *    arc, and "Paused" over a ship visibly in flight would be a lie;
 *  - the guided tutorial: the card is the narrator, and on a phone it sits
 *    exactly where the badge goes (the same reason toasts are muted then).
 *
 * The ☰ menu is deliberately NOT on the list: its auto-pause is the same
 * freeze, and the badge saying so beside the popover is the honest reading
 * of what the menu does to the scene.
 */
export interface PauseBadgeInput {
  /** The simulation clock is stopped (and the ship held with it). */
  paused: boolean;
  /** Landed and looking up: the surface transport strip says PAUSED itself. */
  surfaceView: boolean;
  /** The Help modal is up. */
  helpOpen: boolean;
  /** A historic journey is running its milestones. */
  missionActive: boolean;
  /** The guided tutorial is running. */
  tutorialActive: boolean;
}

export function pauseBadgeVisible(input: PauseBadgeInput): boolean {
  return input.paused
    && !input.surfaceView
    && !input.helpOpen
    && !input.missionActive
    && !input.tutorialActive;
}
