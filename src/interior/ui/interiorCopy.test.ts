import { describe, expect, it } from 'vitest';
import * as COPY from './interiorCopy';
import { temperatureValueText, type TemperatureUnit } from './inspectorText';

describe('interiorCopy', () => {
  it('ships every label with words in it, and no stray space around them', () => {
    const entries = Object.entries(COPY);
    expect(entries.length).toBeGreaterThan(20);
    for (const [name, value] of entries) {
      if (typeof value === 'string') {
        expect(value, name).not.toBe('');
        expect(value, name).toBe(value.trim());
      } else if (typeof value === 'function') {
        continue; // the two interpolating lines are pinned below
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

  it("puts the body's name into the two lines that carry one", () => {
    expect(COPY.LOADING('Europa')).toBe('Loading Europa…');
    // A failed load names what is on screen instead, so the reader knows which world this is.
    expect(COPY.COULD_NOT_LOAD('Europa', 'Earth')).toBe('Could not load Europa. Showing Earth.');
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
