import { describe, expect, it } from 'vitest';
import type { Region } from '../data/interiorTypes';
import { claim, endpoints, heat, row, sharp, sourced } from '../data/modelHelpers';
import { EARTH_MODEL } from '../data/models/earth';
import { CLAIM_TITLE, evidenceGroups, isPlaceholder, sentenceJoin } from './evidenceView';

const SOURCE = 'A test source (2026)';

/** A region built by hand, so the group's shape can be asserted row by row. */
function testRegion(claims: Region['claims']): Region {
  return {
    key: 'testShell',
    name: 'Test shell',
    family: 'metal',
    phase: 'solid',
    outerRadiusKm: 100,
    boundary: sharp(),
    composition: sourced('Iron', SOURCE, 'inferred'),
    temperatureK: endpoints(400, 200, SOURCE, 'modelled'),
    pressureGPa: endpoints(2, 1, SOURCE, 'modelled'),
    densityKgM3: endpoints(5000, 4000, SOURCE, 'modelled'),
    heat: heat([{ kind: 'primordial', note: 'Formation heat.' }], null, 'conduction'),
    claims,
  };
}

describe('isPlaceholder', () => {
  it('knows the words an author writes where there is nothing to say', () => {
    for (const text of ['', ' ', '   ', '—', '-', 'As above', 'as above', ' AS ABOVE ', 'n/a', 'N/A', 'none', 'None', undefined]) {
      expect(isPlaceholder(text)).toBe(true);
    }
    for (const text of ['Nothing material', 'None of the models agree', 'A sharp boundary', '±500 K', 'Its thickness, 20–50 km']) {
      expect(isPlaceholder(text)).toBe(false);
    }
  });
});

describe('sentenceJoin', () => {
  it('drops placeholders, ends each part with a full stop and joins with a space', () => {
    expect(sentenceJoin(['Array stacking recovers real reflections', 'The signal is faint'])).toBe('Array stacking recovers real reflections. The signal is faint.');
    expect(sentenceJoin(['—', 'Its thickness, 20–50 km'])).toBe('Its thickness, 20–50 km.');
    expect(sentenceJoin(['As above', 'as above', undefined, ''])).toBe('');
    expect(sentenceJoin([])).toBe('');
  });

  it('never doubles a full stop, and keeps an ellipsis, a question mark or an exclamation', () => {
    expect(sentenceJoin(['Hydrostatic equilibrium.', 'The assumption itself.'])).toBe('Hydrostatic equilibrium. The assumption itself.');
    expect(sentenceJoin(['Everything below is guesswork…'])).toBe('Everything below is guesswork…');
    expect(sentenceJoin(['Everything below is guesswork...'])).toBe('Everything below is guesswork...');
    expect(sentenceJoin(['Is the shape hydrostatic?', 'Nobody has measured it!'])).toBe('Is the shape hydrostatic? Nobody has measured it!');
    expect(sentenceJoin(['  Padded on both sides  '])).toBe('Padded on both sides.');
  });
});

describe('evidenceGroups', () => {
  it('builds one group per claim, with its standing and its rows in the reader\'s words', () => {
    const region = testRegion([
      claim('existence', [
        row('momentOfInertia', 'supports', SOURCE, {
          observed: 'Doppler tracking gives a moment of inertia of 0.377',
          inferred: 'A dense core under a rock mantle',
          assumed: 'Hydrostatic equilibrium',
          uncertain: 'Its size trades against its sulphur content',
          mission: 'Galileo',
          year: 2001,
        }),
        row('model', 'challenges', SOURCE, {
          observed: '—',
          inferred: 'A gradient fits the same data',
          assumed: '—',
          uncertain: 'As above',
        }),
      ]),
    ]);

    const groups = evidenceGroups(region);
    expect(groups).toHaveLength(1);
    const [structure] = groups;
    expect(structure.kind).toBe('existence');
    expect(structure.title).toBe(CLAIM_TITLE.existence);
    expect(structure.title).toBe('Structure');
    // The challenging row decides the standing, whatever supports it.
    expect(structure.summary.standing).toBe('contested');
    expect(structure.summary.phrase).toBe('Contested by interior model');
    expect(structure.probability).toBeNull();
    expect(structure.entries).toHaveLength(2);

    const [supporting, challenging] = structure.entries;
    expect(supporting.method).toBe('Moment of inertia');
    expect(supporting.relation).toBe('supports');
    expect(supporting.relationWord).toBe('supports');
    expect(supporting.provenance).toBe('Galileo, 2001');
    expect(supporting.observation).toBe('Doppler tracking gives a moment of inertia of 0.377');
    expect(supporting.interpretation).toBe('A dense core under a rock mantle');
    expect(supporting.assumed).toBe('Hydrostatic equilibrium.');
    expect(supporting.uncertain).toBe('Its size trades against its sulphur content.');
    expect(supporting.source).toBe(SOURCE);

    expect(challenging.method).toBe('Interior model');
    expect(challenging.relation).toBe('challenges');
    expect(challenging.relationWord).toBe('challenges');
    expect(challenging.provenance).toBe('');
    expect(challenging.observation).toBe('');
    expect(challenging.interpretation).toBe('A gradient fits the same data');
    expect(challenging.assumed).toBe('');
    expect(challenging.uncertain).toBe('');
  });

  it('carries a published probability as its line, and nothing where there is none', () => {
    const withProbability = testRegion([
      claim(
        'state',
        [row('tides', 'supports', SOURCE, { observed: 'A tidal Love number', inferred: 'Liquid', assumed: '—', uncertain: '—' })],
        { value: 0.88, proposition: 'the layer is liquid', source: SOURCE },
      ),
      claim('temperature', [row('model', 'supports', SOURCE, { observed: 'An adiabat', inferred: 'About 2,000 K', assumed: '—', uncertain: '±500 K' })]),
    ]);

    const [state, temperature] = evidenceGroups(withProbability);
    expect(state.title).toBe('Physical state');
    expect(state.probability).toBe(`Published: 88% that the layer is liquid (${SOURCE})`);
    expect(temperature.title).toBe('Temperature');
    expect(temperature.probability).toBeNull();
    expect(temperature.entries[0].assumed).toBe('');
    expect(temperature.entries[0].uncertain).toBe('±500 K.');
  });

  it("reads Earth's outer core as its claims are authored", () => {
    // earth.ts, region 'outerCore': claims in the order existence, state, temperature;
    // the existence claim opens with Oldham's S-wave shadow (seismology).
    const outerCore = EARTH_MODEL.regions[1];
    expect(outerCore.key).toBe('outerCore');

    const groups = evidenceGroups(outerCore);
    expect(groups.map((group) => group.kind)).toEqual(['existence', 'state', 'temperature']);
    expect(groups.map((group) => group.title)).toEqual(['Structure', 'Physical state', 'Temperature']);
    expect(groups[0].summary.phrase).toBe('Observed by seismology');
    expect(groups[0].entries[0].method).toBe('Seismology');
    expect(groups[0].entries[0].provenance).toBe('1914');
    expect(groups[0].entries[0].observation).toContain('No direct S waves beyond 104°');
    expect(groups[0].entries.map((entry) => entry.method)).toEqual(['Seismology', 'Normal modes', 'Magnetic field', 'High-pressure laboratory']);
    // The state claim's only row leaves nothing open: "Nothing material" is not a placeholder.
    expect(groups[1].entries[0].assumed).toBe('Shear waves need rigidity.');
    expect(groups[1].entries[0].uncertain).toBe('Nothing material.');
  });
});
