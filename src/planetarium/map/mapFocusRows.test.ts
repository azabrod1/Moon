import { describe, it, expect } from 'vitest';
import { buildMapFocusRows } from './mapFocusRows';
import { MAP_BODIES, mapBody } from './mapBodies';
import { filterDeckRows } from '../deckLogic';
import { SUN_DATA } from '../planets/planetData';

const all = (): string[] => MAP_BODIES.map((b) => b.name);
const drawEverything = (): boolean => true;
const drawNothing = (): boolean => false;

describe('buildMapFocusRows', () => {
  it('leads with the Sun and keeps the catalog order', () => {
    const rows = buildMapFocusRows(drawEverything, null);
    expect(rows[0].name).toBe(SUN_DATA.name);
    expect(rows[1].name).toBe('Mercury');
    const names = rows.map((r) => r.name);
    expect(names).toContain('Pluto');
  });

  it('puts each moon directly under its own planet', () => {
    const rows = buildMapFocusRows(drawEverything, null);
    for (let i = 0; i < rows.length; i++) {
      const parent = rows[i].parent;
      if (!parent) continue;
      // Walk back to the nearest planet row: it must be this moon's parent.
      let j = i - 1;
      while (j >= 0 && rows[j].parent) j--;
      expect(rows[j].name).toBe(parent);
    }
  });

  it('offers only bodies the camera accepts', () => {
    // Nothing drawn: the Sun orbits nothing and is always reachable, and the
    // planets are drawn from the chart's first frame.
    const rows = buildMapFocusRows(drawNothing, null);
    expect(rows.map((r) => r.name)).toEqual([SUN_DATA.name]);
  });

  it('drops a moon whose system is not revealed, and keeps its planet', () => {
    const hidden = new Set(['Io', 'Europa']);
    const rows = buildMapFocusRows((name) => !hidden.has(name), null);
    const names = rows.map((r) => r.name);
    expect(names).toContain('Jupiter');
    expect(names).toContain('Ganymede');
    expect(names).not.toContain('Io');
    expect(names).not.toContain('Europa');
  });

  it('takes every tint from the roster', () => {
    for (const row of buildMapFocusRows(drawEverything, null)) {
      expect(row.color).toBe(mapBody(row.name)?.color);
    }
  });

  it('marks the landed body, and only it', () => {
    const rows = buildMapFocusRows(drawEverything, 'Titan');
    expect(rows.filter((r) => r.here).map((r) => r.name)).toEqual(['Titan']);
  });

  it('marks nothing in cruise', () => {
    expect(buildMapFocusRows(drawEverything, null).some((r) => r.here)).toBe(false);
  });

  it('never offers a name the roster cannot resolve', () => {
    const roster = new Set(all());
    for (const row of buildMapFocusRows(drawEverything, null)) {
      expect(roster.has(row.name)).toBe(true);
    }
  });

  it('reads as deck rows, so the deck search filters them unchanged', () => {
    const rows = buildMapFocusRows(drawEverything, null);
    const visible = filterDeckRows('titan', rows);
    const kept = rows.filter((_, i) => visible[i]).map((r) => r.name);
    // The deck's rule: a moon match keeps the moon and its planet, with no
    // sibling ride-along.
    expect(kept).toEqual(['Saturn', 'Titan', 'Uranus', 'Titania']);
  });
});
