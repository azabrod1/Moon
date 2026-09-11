import { describe, expect, it } from 'vitest';
import { EARTH_MODEL } from '../data/models/earth';
import { EUROPA_MODEL } from '../data/models/europa';
import { JUPITER_DILUTE_MODEL } from '../data/models/jupiter';
import { endpoints, heat, UNKNOWN } from '../data/modelHelpers';
import { boundaryText, depthRangeText, heatText, provenanceText, quantityText, uncertaintyText } from './inspectorText';

describe('inspectorText', () => {
  it('reads a quantity outer to inner with its basis, and unknown as no data', () => {
    expect(quantityText(endpoints(5700, 5400, 'src', 'inferred'), 'K')).toBe('5,400–5,700 K (inferred)');
    expect(quantityText(endpoints(1860, 1860, 'src', 'measured', 'none'), 'kg/m³')).toBe('1,860 kg/m³ (measured)');
    expect(quantityText(UNKNOWN, 'K')).toBe('not known');
    expect(quantityText(endpoints(0.6, 0, 'src', 'modelled'), 'GPa')).toBe('0–0.6 GPa (modelled)');
    expect(quantityText({ kind: 'profile', samples: [{ radiusKm: 0, value: 10 }, { radiusKm: 1, value: 30 }], interpolation: 'linear', source: 's', basis: 'measured' }, 'K'))
      .toBe('10–30 K (measured, 2 samples)');
  });

  it('gives depths below the surface for a region', () => {
    const outerCore = EARTH_MODEL.regions[1];
    expect(depthRangeText(outerCore, 1221.5, 6371)).toBe('2,891–5,150 km down');
  });

  it('describes a boundary from its transition and its knowledge', () => {
    expect(boundaryText(EARTH_MODEL.regions[0])).toBe('A sharp boundary; placed at 1,215–1,225 km at 90% confidence.');
    expect(boundaryText(JUPITER_DILUTE_MODEL.regions[0])).toContain('A gradual change over about 15,000 km');
    expect(boundaryText(EUROPA_MODEL.regions[0])).toContain('across models (Anderson 1998 (Fe), Anderson 1998 (Fe–FeS))');
    expect(boundaryText(EARTH_MODEL.regions[4])).toBe('A sharp boundary.');
  });

  it('reads an uncertainty record', () => {
    expect(uncertaintyText(null)).toBeNull();
    expect(uncertaintyText({ kind: 'qualitative', note: 'Open' })).toBe('Open');
  });

  it('turns a heat budget into a sentence', () => {
    expect(heatText(heat([{ kind: 'radiogenicDecay', note: 'x' }], 'Heat from the core', 'convection')))
      .toBe('Heat from radioactive decay; warmed by heat from the core; moved by convection.');
    expect(heatText(heat([{ kind: 'none', note: 'x' }], null, 'unresolved')))
      .toBe('Heat from none of its own; how it moves is unresolved.');
  });

  it('formats provenance', () => {
    expect(provenanceText('InSight', 2021)).toBe('InSight, 2021');
    expect(provenanceText(undefined, 1936)).toBe('1936');
    expect(provenanceText('Galileo', undefined)).toBe('Galileo');
    expect(provenanceText(undefined, undefined)).toBe('');
  });
});
