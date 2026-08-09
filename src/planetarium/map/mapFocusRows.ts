/**
 * The rows the map's Focus picker offers, from the chart's own roster.
 *
 * Built from `MAP_BODIES` and gated by `mapBodyAcceptsCamera`, never from the
 * deck's catalogs: the picker's whole promise is that every row it shows is a
 * body the camera will actually go to, and the two rosters answer that question
 * differently — the deck lists everywhere a SHIP can travel, which includes
 * bodies the chart has not drawn and so cannot fly to.
 *
 * Pure: catalogs and one predicate in, plain rows out. The rows carry the deck
 * row's shape, so the deck's search filter reads them unchanged.
 */

import { MAP_BODIES, mapBodyAcceptsCamera } from './mapBodies';
import { PLANETARIUM_BODIES } from '../planets/planetData';
import type { DeckRow } from '../deckLogic';

export interface MapFocusRow extends DeckRow {
  /** Catalog tint, 0xRRGGBB — the Sun's from SUN_DATA, the roster's one
   *  documented non-catalog entry. */
  color: number;
  /** The body the player is standing on. Only ever true for one row, and only
   *  while landed. */
  here: boolean;
  /** The one thing worth saying about the row beside its name: how far out a
   *  planet orbits, and what the Sun is. Absent on moons — a moon's distance
   *  from its planet is a number nobody reads a list by, and the indent under
   *  the parent already says where it belongs. */
  meta?: string;
}

/** Catalog semi-major axes, by planet name. A static figure for the list's
 *  own column, not a position — the chart's geometry comes from the ephemeris
 *  and never from here. */
const SEMI_MAJOR_AU: ReadonlyMap<string, number> = new Map(
  PLANETARIUM_BODIES.map((planet) => [planet.name, planet.semiMajorAxisAU]),
);

/** How the list prints an orbit radius: a decimal while it still says
 *  something (0.4, 1.0, 5.2 AU) and none once the number is two digits wide
 *  and the tenth is noise (19, 30 AU). */
function auMeta(au: number): string {
  return `${au.toFixed(au < 10 ? 1 : 0)} AU`;
}

/**
 * Every focusable body, in the order the picker lists them: the Sun, then each
 * planet immediately followed by its own moons, all in catalog order.
 *
 * A planet is listed whether or not its moons are, and a moon whose parent is
 * not drawable is dropped with it — a moon row under no planet row would be an
 * orphan the list has no way to indent under.
 */
export function buildMapFocusRows(
  isDrawn: (name: string) => boolean,
  hereName: string | null,
): MapFocusRow[] {
  const accepts = (name: string): boolean => mapBodyAcceptsCamera(name, isDrawn);
  const row = (name: string, color: number, parent?: string): MapFocusRow => {
    const built: MapFocusRow = { name, color, here: name === hereName };
    if (parent) built.parent = parent;
    const au = SEMI_MAJOR_AU.get(name);
    if (au !== undefined) built.meta = auMeta(au);
    return built;
  };

  const rows: MapFocusRow[] = [];
  for (const body of MAP_BODIES) {
    if (body.kind === 'moon') continue;
    if (!accepts(body.name)) continue;
    // The Sun has no orbit to quote; what it IS is the thing worth saying.
    const built = row(body.name, body.color);
    if (body.kind === 'sun') built.meta = 'star';
    rows.push(built);
    if (body.kind !== 'planet') continue;
    for (const moon of MAP_BODIES) {
      if (moon.kind !== 'moon' || moon.parentPlanet !== body.name) continue;
      if (!accepts(moon.name)) continue;
      rows.push(row(moon.name, moon.color, body.name));
    }
  }
  return rows;
}
