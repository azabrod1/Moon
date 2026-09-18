import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as COPY from './interiorCopy';
import { temperatureValueText, type TemperatureUnit } from './inspectorText';

/** The app's markup: the controls that are static HTML carry their words there. */
const MARKUP = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8');

describe('interiorCopy', () => {
  it('ships every label with words in it, and no stray space around them', () => {
    const entries = Object.entries(COPY);
    expect(entries.length).toBeGreaterThan(20);
    for (const [name, value] of entries) {
      if (typeof value === 'string') {
        expect(value, name).not.toBe('');
        expect(value, name).toBe(value.trim());
      } else {
        for (const [key, label] of Object.entries(value)) {
          expect(label, `${name}.${key}`).not.toBe('');
          expect(label, `${name}.${key}`).toBe(label.trim());
        }
      }
    }
  });

  it('pins the phrases another module writes into the panel', () => {
    // interiorLogic returns these three verbatim: a wording change here is a
    // change to what the reader is told about how far to trust the picture.
    expect(COPY.ILLUSTRATIVE_NOTE).toBe('Illustrative scenario. The internal structure is not well constrained.');
    expect(COPY.STRUCTURE_UNCERTAIN).toBe('Structure uncertain');
    expect(COPY.THIN_LAYERS_ENLARGED).toBe('Thin layers enlarged');
  });

  it('finds every word the markup owns still in the markup, so the two cannot drift', () => {
    // Element text: the word sits between a tag's close and the next tag's open.
    const asText = [
      COPY.BACK, COPY.VIEW_OPTIONS, COPY.CUT_ANGLE, COPY.ENLARGE_THIN_LAYERS, COPY.RINGS, COPY.TEMPERATURE_UNIT,
      COPY.BOUNDARY_UNCERTAIN, COPY.LAYERS, COPY.ENLARGE,
      ...Object.values(COPY.VIEW_LABEL), ...Object.values(COPY.MODE_LABEL), ...Object.values(COPY.UNIT_LABEL),
    ];
    for (const word of asText) expect(MARKUP, word).toContain(`>${word}<`);
    // Attribute values: the names a screen reader is given.
    for (const word of [COPY.BACK_ARIA, COPY.VIEW_OPTIONS, COPY.TEMPERATURE_UNIT, COPY.INTERIOR_MODEL]) {
      expect(MARKUP, word).toContain(`="${word}"`);
    }
  });

  it('labels the three views, the two modes and the two temperature units', () => {
    expect(Object.keys(COPY.VIEW_LABEL)).toEqual(['closed', 'cutaway', 'section']);
    expect(COPY.VIEW_LABEL.closed).toBe('Surface');
    expect(Object.keys(COPY.MODE_LABEL)).toEqual(['composition', 'temperature']);
    expect(COPY.MODE_LABEL.composition).toBe('Materials');
    // The unit switch says exactly what inspectorText prints after the number.
    const units: TemperatureUnit[] = ['kelvin', 'celsius'];
    for (const unit of units) {
      expect(temperatureValueText(300, unit).endsWith(` ${COPY.UNIT_LABEL[unit]}`), unit).toBe(true);
    }
  });
});
