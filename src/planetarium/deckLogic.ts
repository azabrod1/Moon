/**
 * Pure decision logic for the deck — the single centered picker (Observatory ·
 * Travel · Autopilot tabs, one-click rows) that replaces the separate travel
 * and observatory menus. DOM-free so the row filter and the observe-arrival
 * decision table stay unit-testable; PlanetariumMode owns the widgets.
 */

/** One list row: a planet, or a moon carrying its parent planet's name. */
export interface DeckRow {
  name: string;
  parent?: string;
}

/**
 * Which rows a search query keeps visible (same order as `rows`). A moon
 * matches on its own name or its parent's; a planet stays if it matches or
 * any of its moons do. Sibling moons do NOT ride along on a moon match —
 * "titan" keeps Saturn + Titan and Uranus + Titania, nothing else. (The old
 * travel-menu filter showed the whole system; the deck is deliberately
 * narrower so the hit list stays scannable.)
 */
export function filterDeckRows(query: string, rows: DeckRow[]): boolean[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows.map(() => true);
  const selfMatch = rows.map((row) => row.name.toLowerCase().includes(q));
  return rows.map((row, i) => {
    if (selfMatch[i]) return true;
    if (row.parent) return row.parent.toLowerCase().includes(q);
    return rows.some((moon, j) => moon.parent === row.name && selfMatch[j]);
  });
}

export type ObserveArrivalAction = 'reopen' | 'land-open' | 'land-quiet';

export interface ObserveCommit {
  /** Row is the body the player is already standing on. */
  sameBody: boolean;
  /** Effective sky-panel-on-arrival preference (stored value or device default). */
  skyPref: boolean;
  /** Target's system has no companion sky (no catalog moons). */
  companionless: boolean;
  /** The deck was opened from inside the open panel ("From ⟨body⟩ ▾"). */
  fromPanel: boolean;
}

/**
 * What committing a row on the Observatory tab means. Your own row reopens
 * this sky's panel, even a companionless one. Any other body lands there,
 * and the arrival preference decides whether the panel opens on arrival —
 * with two overrides, in this order: a companionless sky always arrives
 * quiet (its panel has nothing urgent to say), while a vantage switch from
 * inside the open panel keeps the panel open despite a quiet preference
 * (the user was already reading it).
 */
export function observeArrivalAction(commit: ObserveCommit): ObserveArrivalAction {
  if (commit.sameBody) return 'reopen';
  if (commit.companionless) return 'land-quiet';
  return commit.skyPref || commit.fromPanel ? 'land-open' : 'land-quiet';
}

export interface DeckGroup<P, M> {
  planet: P;
  moons: M[];
}

/** Catalog rows grouped for the deck list: each planet with its moons, both in catalog order. */
export function groupDeckBodies<P extends { name: string }, M extends { parentPlanet: string }>(
  planets: readonly P[],
  moons: readonly M[],
): DeckGroup<P, M>[] {
  return planets.map((planet) => ({
    planet,
    moons: moons.filter((moon) => moon.parentPlanet === planet.name),
  }));
}
