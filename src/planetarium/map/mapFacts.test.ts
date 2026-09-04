import { describe, it, expect } from 'vitest';
import { mapFactRows, mapHoverMeta, sig3, tiltAxisEndpoints, TILT_GLYPH } from './mapFacts';
import { PLANETARIUM_BODIES, SUN_DATA } from '../planets/planetData';
import { MOONS } from '../planets/moonData';

/** The numeric part of a formatted row value, so a test can assert the figure
 *  without restating the unit. */
function numberOf(value: string | { tiltDeg: number }): number {
  if (typeof value !== 'string') throw new Error('expected a text value');
  return Number(value.replace(/[^0-9.eE+-]/g, '').replace(/,/g, ''));
}

function rowValue(name: string, label: string): string | { tiltDeg: number } {
  const row = mapFactRows(name).rows.find((r) => r.label === label);
  if (!row) throw new Error(`${name} has no ${label} row`);
  return row.value;
}

describe('sig3', () => {
  it('holds three significant figures below a thousand', () => {
    expect(sig3(1)).toBe('1.00');
    expect(sig3(23.44)).toBe('23.4');
    expect(sig3(0.034)).toBe('0.0340');
    expect(sig3(999.4)).toBe('999');
  });

  it('groups a rounded integer from a thousand up', () => {
    expect(sig3(1000)).toBe('1,000');
    expect(sig3(1234)).toBe('1,230');
    expect(sig3(384_400)).toBe('384,000');
    expect(sig3(332_946)).toBe('333,000');
  });

  it('groups a value that ROUNDS to a thousand — never scientific notation', () => {
    // 999.5 rounds to 1000 at three figures; deciding the grouping branch on
    // the raw value would hand it to toPrecision, which prints "1.00e+3" —
    // the exact form this function exists to avoid.
    expect(sig3(999.5)).toBe('1,000');
    expect(sig3(999.9)).toBe('1,000');
    expect(sig3(-999.9)).toBe('-1,000');
  });

  it('prints zero as zero, not as 0.00', () => {
    expect(sig3(0)).toBe('0');
    expect(sig3(-0)).toBe('0');
  });

  it('keeps a negative sign', () => {
    expect(sig3(-42.1234)).toBe('-42.1');
    expect(sig3(-5432)).toBe('-5,430');
  });

  it('prints a non-finite value as itself rather than as a measurement', () => {
    expect(sig3(Number.NaN)).toBe('NaN');
    expect(sig3(Number.POSITIVE_INFINITY)).toBe('Infinity');
    expect(sig3(Number.NEGATIVE_INFINITY)).toBe('-Infinity');
  });
});

describe('the atmosphere catalog', () => {
  it('gives every planet on the chart a non-empty atmosphere', () => {
    expect(PLANETARIUM_BODIES.length).toBe(9);
    for (const planet of PLANETARIUM_BODIES) {
      expect(planet.atmosphere, planet.name).toBeTruthy();
    }
    expect(PLANETARIUM_BODIES.find((p) => p.name === 'Mercury')?.atmosphere).toBe('None');
    expect(PLANETARIUM_BODIES.find((p) => p.name === 'Pluto')?.atmosphere).toBe('N₂ (thin)');
  });

  it('names an atmosphere on exactly the three moons that have one', () => {
    const named = MOONS.filter((m) => m.atmosphere).map((m) => m.name).sort();
    expect(named).toEqual(['Io', 'Titan', 'Triton']);
    expect(MOONS.find((m) => m.name === 'Titan')?.atmosphere).toBe('N₂ (thick)');
    expect(MOONS.find((m) => m.name === 'Triton')?.atmosphere).toBe('N₂ (thin)');
    expect(MOONS.find((m) => m.name === 'Io')?.atmosphere).toBe('SO₂ (thin)');
  });
});

describe('the derived mass', () => {
  // g = GM/R² against Earth. Both inputs are hand-authored catalog figures, so
  // the tolerances say how much that costs rather than pretending it is exact.
  const massOf = (name: string): number => numberOf(rowValue(name, 'Mass'));

  it('puts Earth at one Earth mass by construction', () => {
    expect(massOf('Earth')).toBe(1);
  });

  it('lands the giants within 2% of the published masses', () => {
    expect(massOf('Jupiter')).toBeCloseTo(317.8, 0);
    expect(Math.abs(massOf('Jupiter') / 317.8 - 1)).toBeLessThan(0.02);
    expect(Math.abs(massOf('Saturn') / 95.16 - 1)).toBeLessThan(0.02);
  });

  it('lands Pluto within 5% — the catalog g and R are the honest limit', () => {
    const iauEarthMasses = 1.303e22 / 5.972e24;
    expect(Math.abs(massOf('Pluto') / iauEarthMasses - 1)).toBeLessThan(0.05);
  });

  it('gives the Sun its own figure rather than deriving one it has no g for', () => {
    expect(rowValue('Sun', 'Mass')).toBe('333,000 M⊕');
  });
});

describe('the Kepler year', () => {
  it('is exactly one for Earth', () => {
    expect(rowValue('Earth', 'Year')).toBe('1.00 yr⊕');
  });

  it('rises with the semi-major axis, and matches the known periods', () => {
    expect(numberOf(rowValue('Mars', 'Year'))).toBeCloseTo(1.88, 2);
    expect(Math.abs(numberOf(rowValue('Jupiter', 'Year')) / 11.86 - 1)).toBeLessThan(0.02);
    expect(Math.abs(numberOf(rowValue('Neptune', 'Year')) / 164.8 - 1)).toBeLessThan(0.02);
  });
});

describe('mapFactRows', () => {
  it('reads a planet out in one fixed order', () => {
    expect(mapFactRows('Earth')).toEqual({
      oneLiner: 'Our home world',
      rows: [
        { label: 'Distance to Sun', value: '1.00 AU' },
        { label: 'Radius', value: '1.00 R⊕' },
        { label: 'Mass', value: '1.00 M⊕' },
        { label: 'Gravity', value: '1.00 g' },
        { label: 'Tilt', value: { tiltDeg: 23.44 } },
        { label: 'Atmosphere', value: 'N₂ / O₂' },
        { label: 'Year', value: '1.00 yr⊕' },
        { label: 'Day', value: '0.997 d⊕' },
        { label: 'Moons', value: '1' },
      ],
    });
  });

  it('hands the tilt over as an angle, so the card can draw it', () => {
    expect(rowValue('Venus', 'Tilt')).toEqual({ tiltDeg: 177.36 });
    expect(rowValue('Uranus', 'Tilt')).toEqual({ tiltDeg: 97.77 });
  });

  it('reads a moon with an atmosphere out with four rows', () => {
    const titan = mapFactRows('Titan');
    expect(titan.oneLiner).toBe("Saturn's moon");
    expect(titan.rows.map((r) => r.label))
      .toEqual(['Distance to planet', 'Radius', 'Orbit', 'Atmosphere']);
    expect(titan.rows[0].value).toBe('1,220,000 km');
    expect(titan.rows[3].value).toBe('N₂ (thick)');
    // Titan's orbit is a shade under 16 days.
    expect(numberOf(titan.rows[2].value)).toBeCloseTo(15.9, 1);
  });

  it('leaves an airless moon its three rows, with no padded None', () => {
    const europa = mapFactRows('Europa');
    expect(europa.oneLiner).toBe("Jupiter's moon");
    expect(europa.rows.map((r) => r.label)).toEqual(['Distance to planet', 'Radius', 'Orbit']);
    expect(europa.rows.some((r) => r.value === 'None')).toBe(false);
    expect(numberOf(europa.rows[2].value)).toBeCloseTo(3.55, 1);
  });

  it("names a moon by its parent, and Earth's Moon like any other", () => {
    expect(mapFactRows('Moon').oneLiner).toBe("Earth's moon");
    expect(mapFactRows('Moon').rows[0].value).toBe('384,000 km');
    expect(mapFactRows('Moon').rows[1].value).toBe('1,740 km');
    expect(numberOf(mapFactRows('Moon').rows[2].value)).toBeCloseTo(27.3, 1);
  });

  it('gives the Sun two rows and a line of its own', () => {
    expect(mapFactRows('Sun')).toEqual({
      oneLiner: 'Our star, a yellow dwarf',
      rows: [
        { label: 'Radius', value: '109 R⊕' },
        { label: 'Mass', value: '333,000 M⊕' },
      ],
    });
  });

  it('answers a name the chart does not know with nothing at all', () => {
    for (const name of ['Nibiru', '', '__ship', 'earth']) {
      expect(mapFactRows(name)).toEqual({ rows: [], oneLiner: '' });
    }
  });

  it('answers every body on the chart with rows and a line', () => {
    for (const planet of PLANETARIUM_BODIES) {
      const facts = mapFactRows(planet.name);
      expect(facts.rows.length, planet.name).toBe(9);
      expect(facts.oneLiner, planet.name).toBeTruthy();
    }
    for (const moon of MOONS) {
      const facts = mapFactRows(moon.name);
      expect(facts.rows.length, moon.name).toBe(moon.atmosphere ? 4 : 3);
      expect(facts.oneLiner, moon.name).toBe(`${moon.parentPlanet}'s moon`);
      for (const row of facts.rows) {
        expect(String(row.value), `${moon.name} ${row.label}`).not.toContain('NaN');
      }
    }
    expect(mapFactRows(SUN_DATA.name).rows.length).toBe(2);
  });
});

describe('tiltAxisEndpoints', () => {
  const { cx, cy, axisHalf } = TILT_GLYPH;

  it('stands the axis upright at zero, pole on top', () => {
    const a = tiltAxisEndpoints(0);
    expect(a.northX).toBeCloseTo(cx, 10);
    expect(a.northY).toBeCloseTo(cy - axisHalf, 10);
    expect(a.southX).toBeCloseTo(cx, 10);
    expect(a.southY).toBeCloseTo(cy + axisHalf, 10);
    // Screen y runs down: "on top" is a smaller y.
    expect(a.northY).toBeLessThan(cy);
  });

  it('lays it flat at ninety, pole to the right', () => {
    const a = tiltAxisEndpoints(90);
    expect(a.northX).toBeCloseTo(cx + axisHalf, 10);
    expect(a.northY).toBeCloseTo(cy, 10);
    expect(a.southX).toBeCloseTo(cx - axisHalf, 10);
  });

  it("swings Venus's pole below the body — the retrograde tell", () => {
    const venus = tiltAxisEndpoints(177.36);
    expect(venus.northY).toBeGreaterThan(cy);
    const earth = tiltAxisEndpoints(23.44);
    expect(earth.northY).toBeLessThan(cy);
    // And the two glyphs are visibly different, not a near-vertical pair.
    expect(Math.abs(venus.northY - earth.northY)).toBeGreaterThan(axisHalf);
  });

  it('keeps the ends symmetric about the centre at every angle', () => {
    for (const deg of [0, 0.034, 23.44, 90, 97.77, 119.6, 177.36, 180]) {
      const a = tiltAxisEndpoints(deg);
      expect((a.northX + a.southX) / 2).toBeCloseTo(cx, 10);
      expect((a.northY + a.southY) / 2).toBeCloseTo(cy, 10);
      expect(Math.hypot(a.northX - a.southX, a.northY - a.southY))
        .toBeCloseTo(2 * axisHalf, 10);
    }
  });

  it('keeps the whole axis inside the glyph box', () => {
    for (let deg = 0; deg <= 180; deg += 3) {
      const a = tiltAxisEndpoints(deg);
      for (const x of [a.northX, a.southX]) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(TILT_GLYPH.width);
      }
      for (const y of [a.northY, a.southY]) {
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(TILT_GLYPH.height);
      }
    }
  });
});

describe('mapHoverMeta', () => {
  it('names the moon, its parent, its orbit and its real distance', () => {
    const io = mapHoverMeta('Io');
    expect(io).toBe(`Io · Jupiter's moon · Orbit ${rowValue('Io', 'Orbit')} · ${rowValue('Io', 'Distance to planet')}`);
    // The shape, spelled out once so a reordering is caught: name, parent,
    // orbit, distance — the two figures the compressed chart cannot draw.
    expect(io?.split(' · ')).toHaveLength(4);
    expect(io).toMatch(/^Io · Jupiter's moon · Orbit [\d.]+ d⊕ · [\d,.]+ km$/);
  });

  it('agrees with the card about both figures', () => {
    // One display seam, not two: the hovered line and the opened card must
    // never quote a different orbit or a different distance for the same moon.
    for (const name of ['Titan', 'Ganymede', 'Mimas', 'Phobos']) {
      const meta = mapHoverMeta(name)!;
      expect(meta, name).toContain(`Orbit ${rowValue(name, 'Orbit')}`);
      expect(meta, name).toContain(String(rowValue(name, 'Distance to planet')));
    }
  });

  it('uses the chart\'s own name for Earth\'s moon', () => {
    expect(mapHoverMeta('Moon')).toBe(`the Moon · Earth's moon · Orbit ${rowValue('Moon', 'Orbit')} · ${rowValue('Moon', 'Distance to planet')}`);
  });

  it('answers for every moon the chart can draw', () => {
    for (const moon of MOONS) {
      const meta = mapHoverMeta(moon.name);
      expect(meta, moon.name).toBeTruthy();
      expect(meta, moon.name).toContain(`${moon.parentPlanet}'s moon`);
      expect(meta, moon.name).not.toContain('NaN');
      expect(meta, moon.name).not.toContain('undefined');
    }
  });

  it('says nothing about a body whose drawn place is its real one', () => {
    // Planets and the Sun are charted where they are (radially compressed, but
    // that is the chart's whole subject and the card says so). Nothing is owed.
    for (const planet of PLANETARIUM_BODIES) {
      expect(mapHoverMeta(planet.name), planet.name).toBeNull();
    }
    expect(mapHoverMeta(SUN_DATA.name)).toBeNull();
    expect(mapHoverMeta('Ship')).toBeNull();
    expect(mapHoverMeta('nothing the chart knows')).toBeNull();
  });
});
