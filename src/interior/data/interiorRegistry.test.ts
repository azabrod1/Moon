/**
 * The registry's contract: every catalog body resolves to a coverage entry,
 * every shipped model and entry passes validation, the authored bodies are
 * in the states the plan names, and each model's reference radius agrees
 * with the app's mean radius for the body (the advisory convention check:
 * a disagreement over 0.5% means an equatorial radius slipped in).
 */
import { describe, expect, it } from 'vitest';
import { PLANETARIUM_BODIES } from '../../planetarium/planets/planetData';
import { MOONS } from '../../planetarium/planets/moonData';
import { meanRadiusKm } from '../../volumeCompare/compareLogic';
import { coverageBulk, coverageModels } from './interiorTypes';
import { validateCoverage, validateInteriorModel } from './validate';
import {
  COVERAGE_BADGE,
  INTERIOR_DEFAULT_BODY,
  competingTopology,
  coverageFor,
  coverageStateFor,
  defaultModelFor,
  interiorBodyIds,
  modelFor,
} from './interiorRegistry';

const CATALOG = [...PLANETARIUM_BODIES.map((planet) => planet.name), ...MOONS.map((moon) => moon.name)];

/** Bodies that are not spheres: their "mean radius" depends on how the
 *  ellipsoid is averaged, so the convention check is loosened to 3% and the
 *  reason is written down here rather than hidden in a tolerance. */
const IRREGULAR_BODY_TOLERANCE: Readonly<Record<string, { tolerance: number; reason: string }>> = {
  Phobos: { tolerance: 0.03, reason: 'a 27×22×18 km ellipsoid; the catalog\'s 11.3 km and Willner (2014)\'s 11.1 km are two averages of it' },
};

describe('interiorRegistry', () => {
  it('answers for every catalog body, planets, Pluto and moons alike', () => {
    expect(interiorBodyIds()).toEqual(CATALOG);
    for (const bodyId of CATALOG) {
      const coverage = coverageFor(bodyId);
      expect(['constrained', 'competing', 'poorlyConstrained', 'notYetModelled']).toContain(coverage.state);
      expect(COVERAGE_BADGE[coverage.state]).toBeTruthy();
    }
  });

  it('validates every entry and every model it carries', () => {
    const problems: string[] = [];
    for (const bodyId of CATALOG) {
      const coverage = coverageFor(bodyId);
      problems.push(...validateCoverage(bodyId, coverage));
      for (const model of coverageModels(coverage)) problems.push(...validateInteriorModel(model));
    }
    expect(problems).toEqual([]);
  });

  it('has the first-release bodies in the states the plan names', () => {
    expect(coverageStateFor('Earth')).toBe('constrained');
    expect(coverageStateFor('Moon')).toBe('constrained');
    expect(coverageStateFor('Europa')).toBe('constrained');
    expect(coverageStateFor('Jupiter')).toBe('competing');
    expect(coverageStateFor('Mars')).toBe('competing');
    expect(coverageStateFor('Phobos')).toBe('poorlyConstrained');
    expect(coverageStateFor('Mercury')).toBe('competing');
    expect(coverageStateFor('Venus')).toBe('constrained');
    expect(coverageStateFor('Io')).toBe('constrained');
    expect(coverageStateFor('Ganymede')).toBe('constrained');
    expect(coverageStateFor('Callisto')).toBe('competing');
    expect(coverageStateFor('Enceladus')).toBe('constrained');
    expect(coverageStateFor('Titan')).toBe('competing');
    expect(coverageStateFor('Saturn')).toBe('constrained');
    expect(coverageStateFor('Uranus')).toBe('competing');
    expect(coverageStateFor('Neptune')).toBe('competing');
    expect(coverageStateFor('Pluto')).toBe('competing');
    expect(coverageStateFor('Triton')).toBe('poorlyConstrained');
    expect(coverageStateFor('Nix')).toBe('notYetModelled');
    expect(INTERIOR_DEFAULT_BODY).toBe('Earth');
  });

  it('draws the competing default first and nothing for the unresolved states', () => {
    expect(defaultModelFor('Jupiter')?.modelId).toBe('jupiter-dilute-core');
    expect(defaultModelFor('Mars')?.modelId).toBe('mars-large-liquid-core');
    expect(defaultModelFor('Earth')?.modelId).toBe('earth-prem');
    // Phobos has an illustrative model, but it is drawn only on request.
    expect(defaultModelFor('Phobos')).toBeNull();
    expect(modelFor('Phobos', 'phobos-rubble-pile-illustrative')?.illustrative).toBe(true);
    expect(defaultModelFor('Titan')?.modelId).toBe('titan-global-ocean');
    expect(defaultModelFor('Mercury')?.modelId).toBe('mercury-liquid-core');
    expect(defaultModelFor('Callisto')?.modelId).toBe('callisto-partially-differentiated');
    expect(defaultModelFor('Uranus')?.modelId).toBe('uranus-layered');
    expect(defaultModelFor('Pluto')?.modelId).toBe('pluto-ocean');
    expect(defaultModelFor('Triton')).toBeNull();
    expect(modelFor('Triton', 'triton-ocean-illustrative')?.illustrative).toBe(true);
    expect(defaultModelFor('Nix')).toBeNull();
    expect(modelFor('Jupiter', 'jupiter-compact-core')?.modelId).toBe('jupiter-compact-core');
    expect(modelFor('Jupiter', 'no-such-model')).toBeNull();
  });

  it('carries a bulk density with a source, or a null with a note, for every unmodelled body', () => {
    for (const bodyId of CATALOG) {
      const coverage = coverageFor(bodyId);
      if (coverage.state !== 'poorlyConstrained' && coverage.state !== 'notYetModelled') continue;
      expect(coverage.bulk.note.length, bodyId).toBeGreaterThan(20);
      const density = coverage.bulk.densityKgM3;
      if (density) {
        expect(density.source, bodyId).toBeTruthy();
        expect(density.basis).toBe('measured');
        expect(density.value, bodyId).toBeGreaterThan(300);
        expect(density.value, bodyId).toBeLessThan(6000);
      }
    }
    expect(coverageBulk(coverageFor('Deimos'))?.densityKgM3?.value).toBe(1470);
    expect(coverageBulk(coverageFor('Nix'))?.densityKgM3).toBeNull();
    expect(coverageBulk(coverageFor('Earth'))).toBeNull();
  });

  it('keeps every model\'s reference radius within 0.5% of the app\'s mean radius (the convention check)', () => {
    for (const bodyId of CATALOG) {
      for (const model of coverageModels(coverageFor(bodyId))) {
        const appRadius = meanRadiusKm(bodyId);
        expect(appRadius, bodyId).not.toBeNull();
        const relative = Math.abs(model.referenceRadiusKm - appRadius!) / appRadius!;
        const tolerance = IRREGULAR_BODY_TOLERANCE[bodyId]?.tolerance ?? 0.005;
        expect(relative, `${bodyId}/${model.modelId}: ${model.referenceRadiusKm} vs ${appRadius}`).toBeLessThan(tolerance);
      }
    }
  });

  it('knows which regions a rival model draws differently', () => {
    const jupiter = coverageFor('Jupiter');
    expect(competingTopology(jupiter, 'jupiter-dilute-core', 'diluteCore')).toBe(true);
    expect(competingTopology(jupiter, 'jupiter-compact-core', 'compactCore')).toBe(true);
    expect(competingTopology(jupiter, 'jupiter-dilute-core', 'atmosphere')).toBe(false);
    // The metallic hydrogen region keeps its outer radius in both models: same topology.
    expect(competingTopology(jupiter, 'jupiter-dilute-core', 'metallicHydrogen')).toBe(false);
    const mars = coverageFor('Mars');
    expect(competingTopology(mars, 'mars-large-liquid-core', 'core')).toBe(true); // 1830 vs 1650 km
    expect(competingTopology(mars, 'mars-basal-molten-layer', 'basalMoltenLayer')).toBe(true);
    expect(competingTopology(mars, 'mars-large-liquid-core', 'crust')).toBe(false);
    expect(competingTopology(coverageFor('Earth'), 'earth-prem', 'innerCore')).toBe(false);
    expect(competingTopology(jupiter, 'no-such-model', 'diluteCore')).toBe(false);
  });

  it('lists a history entry for every current model', () => {
    for (const bodyId of ['Earth', 'Moon', 'Europa', 'Jupiter', 'Mars', 'Phobos', 'Mercury', 'Venus', 'Io', 'Ganymede', 'Callisto', 'Enceladus', 'Titan', 'Saturn', 'Uranus', 'Neptune', 'Pluto', 'Triton']) {
      const coverage = coverageFor(bodyId);
      for (const model of coverageModels(coverage)) {
        expect(coverage.history.some((entry) => entry.modelId === model.modelId), `${bodyId}/${model.modelId}`).toBe(true);
      }
    }
  });
});
