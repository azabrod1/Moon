import { describe, expect, it } from 'vitest';
import { filterDeckRows, groupDeckBodies, observeArrivalAction } from './deckLogic';
import type { DeckRow } from './deckLogic';
import { PLANETARIUM_BODIES } from './planets/planetData';
import { MOONS } from './planets/moonData';

describe('filterDeckRows', () => {
  const ROWS: DeckRow[] = [
    { name: 'Mars' },
    { name: 'Phobos', parent: 'Mars' },
    { name: 'Deimos', parent: 'Mars' },
    { name: 'Saturn' },
    { name: 'Titan', parent: 'Saturn' },
    { name: 'Rhea', parent: 'Saturn' },
    { name: 'Uranus' },
    { name: 'Titania', parent: 'Uranus' },
    { name: 'Mercury' },
  ];
  const visible = (query: string) => {
    const keep = filterDeckRows(query, ROWS);
    return ROWS.filter((_, i) => keep[i]).map((row) => row.name);
  };

  it('moon match keeps the moon and its planet header — no sibling ride-along', () => {
    expect(visible('titan')).toEqual(['Saturn', 'Titan', 'Uranus', 'Titania']);
    expect(visible('phobos')).toEqual(['Mars', 'Phobos']);
  });

  it('planet match keeps the whole system (moons match via the parent name)', () => {
    expect(visible('saturn')).toEqual(['Saturn', 'Titan', 'Rhea']);
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(visible('TITAN')).toEqual(visible('titan'));
    expect(visible('  rhea ')).toEqual(['Saturn', 'Rhea']);
  });

  it('empty or blank query keeps everything', () => {
    expect(visible('')).toHaveLength(ROWS.length);
    expect(visible('   ')).toHaveLength(ROWS.length);
  });

  it('no match hides everything; a moonless planet matches alone', () => {
    expect(visible('xyzzy')).toEqual([]);
    expect(visible('mercury')).toEqual(['Mercury']);
  });
});

describe('observeArrivalAction', () => {
  const BOTH = [true, false];

  it('your own row reopens the panel, whatever the flags say', () => {
    for (const skyPref of BOTH)
      for (const companionless of BOTH)
        for (const fromPanel of BOTH)
          expect(observeArrivalAction({ sameBody: true, skyPref, companionless, fromPanel }))
            .toBe('reopen');
  });

  it('a companionless sky always arrives quiet — even from inside the open panel', () => {
    for (const skyPref of BOTH)
      for (const fromPanel of BOTH)
        expect(observeArrivalAction({ sameBody: false, skyPref, companionless: true, fromPanel }))
          .toBe('land-quiet');
  });

  it('preference on lands with the panel open', () => {
    for (const fromPanel of BOTH)
      expect(observeArrivalAction({ sameBody: false, skyPref: true, companionless: false, fromPanel }))
        .toBe('land-open');
  });

  it('preference off lands quiet, unless the switch came from inside the panel', () => {
    expect(observeArrivalAction({ sameBody: false, skyPref: false, companionless: false, fromPanel: false }))
      .toBe('land-quiet');
    expect(observeArrivalAction({ sameBody: false, skyPref: false, companionless: false, fromPanel: true }))
      .toBe('land-open');
  });
});

describe('groupDeckBodies', () => {
  it('groups moons under their planet, both sides in input order', () => {
    const groups = groupDeckBodies(
      [{ name: 'Mars' }, { name: 'Venus' }],
      [
        { name: 'Phobos', parentPlanet: 'Mars' },
        { name: 'Deimos', parentPlanet: 'Mars' },
      ],
    );
    expect(groups.map((g) => g.planet.name)).toEqual(['Mars', 'Venus']);
    expect(groups[0].moons.map((m) => m.name)).toEqual(['Phobos', 'Deimos']);
    expect(groups[1].moons).toEqual([]);
  });

  it('the real catalogs group with no orphan moons', () => {
    // A moon whose parentPlanet matches no planet name would silently vanish
    // from the deck list; pin the catalogs so a rename cannot drop one.
    const groups = groupDeckBodies(PLANETARIUM_BODIES, MOONS);
    expect(groups.length).toBe(PLANETARIUM_BODIES.length);
    expect(groups.reduce((n, g) => n + g.moons.length, 0)).toBe(MOONS.length);
  });
});
