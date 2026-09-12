import { describe, expect, it } from 'vitest';
import { validateCoverage, validateInteriorModel } from './validate';
import { MAX_REGIONS, type Coverage, type InteriorModel, type Region } from './interiorTypes';

function region(key: string, outerRadiusKm: number, innerK: number, outerK: number): Region {
  return {
    key,
    name: key,
    family: 'silicate',
    phase: 'solid',
    outerRadiusKm,
    boundary: { transition: { kind: 'sharp' }, knowledge: { location: null, width: null } },
    composition: { value: 'rock', source: 's', basis: 'inferred' },
    temperatureK: { kind: 'endpoints', inner: { value: innerK, source: 's', basis: 'modelled' }, outer: { value: outerK, source: 's', basis: 'modelled' }, interpolation: 'linear' },
    pressureGPa: { kind: 'unknown' },
    densityKgM3: { kind: 'unknown' },
    heat: { generated: [{ kind: 'primordial', note: 'n' }], received: null, transport: 'conduction' },
    claims: [{ kind: 'existence', evidence: [{ method: 'gravity', relation: 'supports', observed: 'o', inferred: 'i', assumed: 'a', uncertain: 'u', source: 's' }] }],
  };
}

function model(regions: Region[], overrides: Partial<InteriorModel> = {}): InteriorModel {
  return {
    body: 'Test',
    modelId: 'test',
    title: 'Test',
    version: '1',
    review: 'provisional',
    reviewedOn: '2026-09-11',
    epoch: 'now',
    radiusConvention: 'volumetricMean',
    referenceRadiusKm: 1000,
    overview: 'o',
    regions,
    annotations: [],
    sources: ['s'],
    ...overrides,
  };
}

describe('validateInteriorModel', () => {
  it('accepts a well-formed model', () => {
    expect(validateInteriorModel(model([region('core', 400, 2000, 1500), region('mantle', 1000, 1500, 300)]))).toEqual([]);
  });

  it('pins the radius rule: strictly increasing and the last equal to the reference', () => {
    expect(validateInteriorModel(model([region('core', 400, 2000, 1500), region('mantle', 999, 1500, 300)]))).toContainEqual(expect.stringContaining('must equal the reference radius'));
    expect(validateInteriorModel(model([region('core', 500, 2000, 1500), region('mantle', 500, 1500, 300), region('crust', 1000, 300, 200)]))).toContainEqual(expect.stringContaining('not greater than the previous'));
  });

  it('requires an existence claim with evidence and a source on every row', () => {
    const bare = region('core', 1000, 2000, 1500);
    bare.claims = [];
    expect(validateInteriorModel(model([bare]))).toContainEqual(expect.stringContaining('no existence claim'));
    const unsourced = region('core', 1000, 2000, 1500);
    unsourced.claims[0].evidence[0].source = '';
    expect(validateInteriorModel(model([unsourced]))).toContainEqual(expect.stringContaining('has no source'));
  });

  it('requires a proposition and source on a probability', () => {
    const withProbability = region('core', 1000, 2000, 1500);
    withProbability.claims.push({ kind: 'state', evidence: [], probability: { value: 0.9, proposition: '', source: 's' } });
    expect(validateInteriorModel(model([withProbability]))).toContainEqual(expect.stringContaining('needs a proposition and a source'));
  });

  it('refuses temperatures that decrease inward, within and across regions', () => {
    expect(validateInteriorModel(model([region('core', 1000, 1000, 1500)]))).toContainEqual(expect.stringContaining('decreases inward within'));
    expect(validateInteriorModel(model([region('core', 400, 900, 800), region('mantle', 1000, 1500, 300)]))).toContainEqual(expect.stringContaining('decreases inward across'));
  });

  it('keeps annotations inside the body', () => {
    const problems = validateInteriorModel(model([region('core', 1000, 2000, 1500)], {
      annotations: [{ name: 'too far', innerRadiusKm: 900, outerRadiusKm: 1200, note: 'n', source: 's' }],
    }));
    expect(problems).toContainEqual(expect.stringContaining('does not lie within the body'));
  });

  it('refuses more regions than the studio draws', () => {
    const many: Region[] = [];
    for (let index = 0; index < MAX_REGIONS + 1; index++) {
      many.push(region(`r${index}`, (index + 1) * 100, 2000 - index * 100, 2000 - index * 100 - 50));
    }
    const problems = validateInteriorModel(model(many, { referenceRadiusKm: (MAX_REGIONS + 1) * 100 }));
    expect(problems).toContainEqual(expect.stringContaining(`draws at most ${MAX_REGIONS}`));
    expect(validateInteriorModel(model(many.slice(0, MAX_REGIONS), { referenceRadiusKm: MAX_REGIONS * 100 }))).toEqual([]);
  });

  it('refuses two regions with one key', () => {
    const problems = validateInteriorModel(model([region('core', 400, 2000, 1500), region('core', 1000, 1500, 300)]));
    expect(problems).toContainEqual(expect.stringContaining('another region already has this key'));
  });

  it('requires a boundary interval or spread to bracket the radius it is drawn at, with a confidence in (0, 1]', () => {
    const missed = region('core', 400, 2000, 1500);
    missed.boundary.knowledge.location = { kind: 'interval', low: 410, high: 450, level: 0.9, source: 's' };
    expect(validateInteriorModel(model([missed, region('mantle', 1000, 1500, 300)]))).toContainEqual(expect.stringContaining('does not bracket the outer radius 400 km'));
    const spread = region('core', 400, 2000, 1500);
    spread.boundary.knowledge.location = { kind: 'modelSpread', low: 100, high: 300, models: ['a', 'b'] };
    expect(validateInteriorModel(model([spread, region('mantle', 1000, 1500, 300)]))).toContainEqual(expect.stringContaining('modelSpread 100–300 km does not bracket'));
    const overconfident = region('core', 400, 2000, 1500);
    overconfident.boundary.knowledge.location = { kind: 'interval', low: 390, high: 410, level: 90, source: 's' };
    expect(validateInteriorModel(model([overconfident, region('mantle', 1000, 1500, 300)]))).toContainEqual(expect.stringContaining('level 90 is not a confidence'));
    const bracketed = region('core', 400, 2000, 1500);
    bracketed.boundary.knowledge.location = { kind: 'interval', low: 390, high: 410, level: 0.9, source: 's' };
    expect(validateInteriorModel(model([bracketed, region('mantle', 1000, 1500, 300)]))).toEqual([]);
  });

  it('keeps a probability between 0 and 1', () => {
    const tooSure = region('core', 1000, 2000, 1500);
    tooSure.claims.push({ kind: 'state', evidence: [], probability: { value: 90, proposition: 'p', source: 's' } });
    expect(validateInteriorModel(model([tooSure]))).toContainEqual(expect.stringContaining('probability of 90 is not between 0 and 1'));
  });

  it("refuses a temperature interpolated 'none' and a profile out of radius order", () => {
    const stepped = region('core', 1000, 2000, 1500);
    stepped.temperatureK = { kind: 'endpoints', inner: { value: 2000, source: 's', basis: 'modelled' }, outer: { value: 1500, source: 's', basis: 'modelled' }, interpolation: 'none' };
    expect(validateInteriorModel(model([stepped]))).toContainEqual(expect.stringContaining("cannot be interpolated 'none'"));
    const shuffled = region('core', 1000, 2000, 1500);
    shuffled.temperatureK = { kind: 'profile', samples: [{ radiusKm: 0, value: 2000 }, { radiusKm: 800, value: 1700 }, { radiusKm: 400, value: 1900 }], interpolation: 'linear', source: 's', basis: 'modelled' };
    expect(validateInteriorModel(model([shuffled]))).toContainEqual(expect.stringContaining('temperature profile\'s samples are not in ascending radius at sample 2'));
    const pressure = region('core', 1000, 2000, 1500);
    pressure.pressureGPa = { kind: 'profile', samples: [{ radiusKm: 500, value: 10 }, { radiusKm: 500, value: 5 }], interpolation: 'linear', source: 's', basis: 'modelled' };
    expect(validateInteriorModel(model([pressure]))).toContainEqual(expect.stringContaining('pressure profile\'s samples are not in ascending radius'));
    const ordered = region('core', 1000, 2000, 1500);
    ordered.temperatureK = { kind: 'profile', samples: [{ radiusKm: 0, value: 2000 }, { radiusKm: 500, value: 1800 }, { radiusKm: 1000, value: 1500 }], interpolation: 'linear', source: 's', basis: 'modelled' };
    expect(validateInteriorModel(model([ordered]))).toEqual([]);
  });
});

describe('validateCoverage', () => {
  const good = model([region('core', 400, 2000, 1500), region('mantle', 1000, 1500, 300)]);

  it('checks a competing entry for a default, a distinguishing sentence and one radius', () => {
    const other = { ...good, modelId: 'other', referenceRadiusKm: 1001, regions: [region('core', 500, 2000, 1500), region('mantle', 1001, 1500, 300)] };
    const coverage: Coverage = { state: 'competing', models: [good, other], defaultModelId: 'missing', distinguishedBy: '', history: [] };
    const problems = validateCoverage('Test', coverage);
    expect(problems).toContainEqual(expect.stringContaining('is not one of the competing models'));
    expect(problems).toContainEqual(expect.stringContaining('must say what distinguishes'));
    expect(problems).toContainEqual(expect.stringContaining('disagree on the reference radius'));
  });

  it('requires an illustrative model to be labelled in its own data', () => {
    const coverage: Coverage = { state: 'poorlyConstrained', bulk: { densityKgM3: null, note: 'n' }, illustrative: good, history: [] };
    expect(validateCoverage('Test', coverage)).toContainEqual(expect.stringContaining('labelled illustrative'));
    const labelled: Coverage = { ...coverage, illustrative: { ...good, illustrative: true } };
    expect(validateCoverage('Test', labelled)).toEqual([]);
  });

  it('flags a model filed under the wrong body', () => {
    expect(validateCoverage('Other', { state: 'constrained', model: good, history: [] })).toContainEqual(expect.stringContaining('is for Test'));
  });

  it('forbids an illustrative label on a constrained or competing model', () => {
    const scenario = { ...good, illustrative: true };
    expect(validateCoverage('Test', { state: 'constrained', model: scenario, history: [] })).toContainEqual(expect.stringContaining('labelled illustrative, but a constrained entry'));
    const other = { ...good, modelId: 'other' };
    const competing: Coverage = { state: 'competing', models: [scenario, other], defaultModelId: 'test', distinguishedBy: 'd', history: [] };
    expect(validateCoverage('Test', competing)).toContainEqual(expect.stringContaining('labelled illustrative, but a competing entry'));
    expect(validateCoverage('Test', { ...competing, models: [good, other] })).toEqual([]);
  });
});
