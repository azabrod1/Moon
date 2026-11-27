/**
 * The ships the user can fly, and where the choice is kept.
 *
 * On screen it is the ☰ Ship page: a card for each ship here, in this order.
 * The cards are markup in index.html (their icons live there); the labels are
 * repeated here for the root row's value, and settingsRows.test.ts holds the
 * two together. The models are in ship/fleet.ts; nothing here touches three,
 * so the menu and the tests read the list without building a ship.
 *
 * The choice is the user's setting: one localStorage key of its own through
 * app/storedSetting.ts, never part of the journey save, so New Journey keeps
 * it.
 *
 * `classic` is the ship the app has always flown (models/defaultShip.ts).
 * A mission still flies its own probe and the Retro look its own fighter;
 * the chosen ship comes back when they end (PlanetariumMode.applyShip).
 */
import { enumCodec, storedSetting } from '../../app/storedSetting';
import type { QualityStorage } from '../../app/qualitySetting';

/** Every ship, in the order the page offers them. The ids are the saved
 *  values: lower case, and never renamed once shipped. */
export const SHIP_IDS = [
  'classic', 'starship', 'shuttle', 'apollo',
  'soyuz', 'saucer', 'torchship', 'manta',
] as const;
export type ShipId = (typeof SHIP_IDS)[number];

export const DEFAULT_SHIP: ShipId = 'classic';

/** What each card reads, as index.html's cards do. */
export const SHIP_LABELS: Record<ShipId, string> = {
  classic: 'Classic',
  starship: 'Starship',
  shuttle: 'Shuttle',
  apollo: 'Apollo',
  soyuz: 'Soyuz',
  saucer: 'Saucer',
  torchship: 'Torchship',
  manta: 'Manta',
};

/** The line under the cards, for the ship that is checked. */
export const SHIP_NOTES: Record<ShipId, string> = {
  classic: 'The ship this app has always flown: a white needle with three fins.',
  starship: 'SpaceX’s stainless-steel ship, with its four flaps.',
  shuttle: 'NASA’s winged orbiter, which flew 135 missions from 1981 to 2011.',
  apollo: 'The command and service module that carried crews to the Moon from 1968 to 1972.',
  soyuz: 'Russia’s three-part crew ship, flying since 1967.',
  saucer: 'A flying saucer. Nobody knows who built it.',
  torchship: 'Our own design: a fusion liner with a spinning ring to live in.',
  manta: 'Our own design: a flying wing with a long tail.',
};

/** What can keep the chosen ship off the screen. */
export interface ShipPageState {
  /** A historic mission is flying its probe. */
  mission: boolean;
  /** A look (the Retro look) is flying a ship of its own. */
  lookShip: boolean;
  /** Show ship is on. */
  shown: boolean;
}

/**
 * The line under the cards: the checked ship's own, unless that ship is not
 * the one on screen. Then it says why, because a pick that seems to do
 * nothing reads as broken; the pick is saved either way and appears when the
 * reason ends. A mission outranks a look, and both outrank a hidden ship,
 * which is the order they take the screen in.
 */
export function shipPageNote(ship: ShipId, state: ShipPageState): string {
  if (state.mission) return 'This mission flies its own probe. Your ship comes back when it ends.';
  if (state.lookShip) return 'The look you chose flies its own ship. Yours comes back when you change the look.';
  if (!state.shown) return 'The ship is hidden. Turn on Show ship to see it.';
  return SHIP_NOTES[ship];
}

/** What the ☰ root's Ship row carries beside it. */
export function shipRowValue(ship: ShipId, shown: boolean): string {
  return shown ? SHIP_LABELS[ship] : `${SHIP_LABELS[ship]}, hidden`;
}

export const shipSetting = storedSetting<ShipId>('planetarium-ship', enumCodec(SHIP_IDS));

/** The ship this load flies: the saved one, else Classic. */
export function resolveBootShip(storage: QualityStorage | null = null): ShipId {
  return shipSetting.read(storage) ?? DEFAULT_SHIP;
}
