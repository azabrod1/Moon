import { describe, expect, it } from 'vitest';
import { EARTH_MODEL } from '../data/models/earth';
import { EUROPA_MODEL } from '../data/models/europa';
import { JUPITER_DILUTE_MODEL } from '../data/models/jupiter';
import { endpoints, heat, UNKNOWN } from '../data/modelHelpers';
import { coverageModels } from '../data/interiorTypes';
import { coverageFor, interiorBodyIds } from '../data/interiorRegistry';
import {
  atmospheresText,
  boundaryText,
  depthRangeText,
  heatText,
  pressureQuantityText,
  provenanceText,
  quantityText,
  reviewDateText,
  temperatureQuantityText,
  temperatureRangeText,
  uncertaintyText,
} from './inspectorText';

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
    expect(boundaryText(EARTH_MODEL.regions[0])).toBe('A sharp boundary; placed 1,215–1,225 km from the centre, at 90% confidence.');
    expect(boundaryText(JUPITER_DILUTE_MODEL.regions[0])).toContain('A gradual change over about 15,000 km');
    expect(boundaryText(EUROPA_MODEL.regions[0])).toContain('across models (Anderson 1998 (Fe), Anderson 1998 (Fe–FeS))');
    expect(boundaryText(EARTH_MODEL.regions[4])).toBe('A sharp boundary.');
    // A note about the boundary is its own sentence, never pasted after "placed at".
    const noted = {
      ...EARTH_MODEL.regions[4],
      boundary: { ...EARTH_MODEL.regions[4].boundary, knowledge: { ...EARTH_MODEL.regions[4].boundary.knowledge, location: { kind: 'qualitative' as const, note: 'The depth is read from crater shapes' } } },
    };
    expect(boundaryText(noted)).toBe('A sharp boundary. The depth is read from crater shapes.');
  });

  it('reads a temperature with its celsius and a pressure with its atmospheres', () => {
    expect(temperatureQuantityText(endpoints(3700, 1900, 'src', 'inferred'))).toBe('1,900–3,700 K · 1,627–3,427 °C (inferred)');
    expect(temperatureQuantityText(UNKNOWN)).toBe('not known');
    expect(pressureQuantityText(endpoints(136, 24, 'src', 'inferred'))).toBe('24–136 GPa (inferred); about 236,856–1.3 million atmospheres');
    expect(atmospheresText(1_342_184)).toBe('1.3 million');
    expect(atmospheresText(236_856)).toBe('236,856');
  });

  it('reads a legend row temperature as kelvin alone, and unknown as nothing', () => {
    expect(temperatureRangeText(endpoints(1600, 1100, 'src', 'inferred'))).toBe('1,100–1,600 K');
    expect(temperatureRangeText(endpoints(5800, 5800, 'src', 'measured', 'none'))).toBe('5,800 K');
    expect(temperatureRangeText(UNKNOWN)).toBe('');
  });

  it('prints a review date as a reader writes one', () => {
    expect(reviewDateText('2026-09-11')).toBe('11 Sep 2026');
    expect(reviewDateText('soon')).toBe('soon');
  });

  it('reads an uncertainty record', () => {
    expect(uncertaintyText(null)).toBeNull();
    expect(uncertaintyText({ kind: 'qualitative', note: 'Open' })).toBe('Open');
  });

  it('turns a heat budget into a sentence, printing what warms it as written', () => {
    expect(heatText(heat([{ kind: 'radiogenicDecay', note: 'x' }], 'heat from the core', 'convection')))
      .toBe('Heat from radioactive decay; warmed by heat from the core; moved by convection.');
    expect(heatText(heat([{ kind: 'none', note: 'x' }], null, 'unresolved')))
      .toBe('No heat of its own; how it moves is unresolved.');
    expect(heatText(heat([{ kind: 'primordial', note: 'x' }], null, 'conduction')))
      .toBe('Heat from heat left over from its formation; moved by conduction.');
    // A proper noun in the phrase keeps its capital.
    expect(heatText(heat([{ kind: 'tidal', note: 'x' }], "Jupiter's tides", 'convection')))
      .toBe("Heat from tidal flexing; warmed by Jupiter's tides; moved by convection.");
  });

  it('ships every heat phrase in the case it is printed in', () => {
    // The phrase follows "warmed by": it starts lowercase unless its first word is a proper noun.
    const properNouns = /^(Sun|Mars|Jupiter|Saturn|Uranus|Neptune|Earth|Pluto|Io|Europa|Ganymede|Callisto|Titan|Enceladus|Triton|Phobos|Deimos|Charon|Moon|Venus|Mercury)\b/;
    for (const bodyId of interiorBodyIds()) {
      for (const model of coverageModels(coverageFor(bodyId))) {
        for (const region of model.regions) {
          const received = region.heat.received;
          if (!received) continue;
          const first = received.charAt(0);
          expect(first === first.toLowerCase() || properNouns.test(received), `${bodyId}/${region.key}: "${received}"`).toBe(true);
        }
      }
    }
  });

  it('formats provenance', () => {
    expect(provenanceText('InSight', 2021)).toBe('InSight, 2021');
    expect(provenanceText(undefined, 1936)).toBe('1936');
    expect(provenanceText('Galileo', undefined)).toBe('Galileo');
    expect(provenanceText(undefined, undefined)).toBe('');
  });
});
