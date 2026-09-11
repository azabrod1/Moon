import { describe, expect, it } from 'vitest';
import { validateCoverage, validateInteriorModel } from './validate';
import type { Coverage, InteriorModel, Region } from './interiorTypes';

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
});
