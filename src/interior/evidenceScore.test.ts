import { describe, expect, it } from 'vitest';
import { DIRECTLY_DETECTED_MIN_SCORE, evidenceScore, levelFor, meterSegments } from './evidenceScore';
import type { Claim, Evidence, EvidenceMethod, EvidenceRelation } from './data/interiorTypes';
import { coverageModels } from './data/interiorTypes';
import { competingTopology, coverageFor, interiorBodyIds } from './data/interiorRegistry';
import { EARTH_MODEL } from './data/models/earth';
import { SUN_MODEL } from './data/models/sun';

/** The existence claim of a shipped region, scored as the inspector scores it. */
function shippedExistence(bodyId: string, regionKey: string) {
  const coverage = coverageFor(bodyId);
  const model = coverageModels(coverage)[0];
  const region = model.regions.find((candidate) => candidate.key === regionKey)!;
  const claim = region.claims.find((candidate) => candidate.kind === 'existence')!;
  return evidenceScore(claim, { competingTopology: competingTopology(coverage, model.modelId, regionKey) });
}

function row(method: EvidenceMethod, relation: EvidenceRelation = 'supports', year?: number): Evidence {
  return { method, relation, observed: 'o', inferred: 'i', assumed: 'a', uncertain: 'u', source: 'test', year };
}
function claim(...evidence: Evidence[]): Claim {
  return { kind: 'existence', evidence };
}

describe('evidenceScore: the pinned worked examples', () => {
  it("Earth's outer core: direct plus modes and magnetic plus lab plus agreement is 95, Directly detected", () => {
    const result = evidenceScore(claim(
      row('seismology'), row('normalModes'), row('magnetic'), row('labHighPressure'),
    ));
    expect(result.score).toBe(95);
    expect(result.level).toBe('directlyDetected');
    expect(result.lines.reduce((sum, line) => sum + line.points, 0)).toBe(95);
  });

  it("Jupiter's dilute core: gravity plus model, unchallenged but with competing topology, is Model-dependent", () => {
    const result = evidenceScore(claim(row('gravity'), row('model')), { competingTopology: true });
    expect(result.score).toBe(35);
    expect(result.level).toBe('modelDependent');
  });

  it("Io's shallow magma ocean: induction supports, Juno tides challenge, is Hypothesis", () => {
    const result = evidenceScore(claim(row('magnetic', 'supports', 2011), row('tides', 'challenges', 2024)));
    expect(result.score).toBe(10);
    expect(result.level).toBe('hypothesis');
  });

  it("Callisto's ocean on induction alone is Constrained", () => {
    const result = evidenceScore(claim(row('magnetic')));
    expect(result.score).toBe(45);
    expect(result.level).toBe('constrained');
  });

  it("Earth's outer-core temperature: a melting curve plus an adiabat model, unchallenged, is Constrained", () => {
    const result = evidenceScore({ kind: 'temperature', evidence: [row('labHighPressure'), row('model')] });
    // 35 as the first (and only) support, no second +10 for the same lab row, +10 unchallenged
    expect(result.score).toBe(45);
    expect(result.level).toBe('constrained');
    expect(result.lines.filter((line) => line.evidence?.method === 'labHighPressure')).toHaveLength(1);
  });

  it("Earth's crust: the seismic Moho, rock in hand and isostasy, unchallenged, is Directly detected", () => {
    const result = evidenceScore(claim(row('seismology'), row('sample'), row('gravity')));
    // 45 direct + 15 a second direct method + 15 gravity + 10 unchallenged
    expect(result.score).toBe(85);
    expect(result.level).toBe('directlyDetected');
  });

  it('a claim on a model row alone is a Hypothesis', () => {
    const result = evidenceScore({ kind: 'temperature', evidence: [row('model')] });
    expect(result.score).toBe(10);
    expect(result.level).toBe('hypothesis');
  });

  it("Earth's inner core and the Sun's core are Directly detected on the shipped models", () => {
    // Both are reached by a direct method with few corroborating methods: the
    // level is the direct row plus a score from 65, not a score from 85.
    expect(EARTH_MODEL.regions[0].key).toBe('innerCore');
    const innerCore = shippedExistence('Earth', 'innerCore');
    expect(innerCore.score).toBe(80);
    expect(innerCore.direct).toBe(true);
    expect(innerCore.level).toBe('directlyDetected');
    expect(SUN_MODEL.regions[0].key).toBe('core');
    const sunCore = shippedExistence('Sun', 'core');
    expect(sunCore.score).toBe(70);
    expect(sunCore.direct).toBe(true);
    expect(sunCore.level).toBe('directlyDetected');
    // A direct row under 65 stays at its score band: the Sun's photosphere, in situ but alone.
    const photosphere = shippedExistence('Sun', 'photosphere');
    expect(photosphere.direct).toBe(true);
    expect(photosphere.score).toBe(55);
    expect(photosphere.level).toBe('constrained');
  });
});

describe('evidenceScore: the rules', () => {
  it('never reaches 100 and stays a multiple of five', () => {
    const result = evidenceScore(claim(
      row('seismology'), row('normalModes'), row('gravity'), row('magnetic'), row('tides'), row('labHighPressure'),
    ));
    expect(result.score).toBe(95);
    expect(result.score % 5).toBe(0);
  });

  it('caps further methods at +30 and counts each method once', () => {
    const result = evidenceScore(claim(row('gravity'), row('magnetic'), row('magnetic'), row('tides'), row('libration')));
    // 35 first + 15 + 15 (cap) + 10 unchallenged = 75
    expect(result.score).toBe(75);
    expect(result.level).toBe('wellConstrained');
  });

  it('caps challenges at −50', () => {
    const result = evidenceScore(claim(row('seismology'), row('gravity'), row('magnetic'), row('tides', 'challenges'), row('model', 'challenges'), row('gravity', 'challenges')));
    // 45 + 15 + 15 − 50 = 25
    expect(result.score).toBe(25);
    expect(result.level).toBe('modelDependent');
  });

  it('a high score without a direct row is Well constrained, not Directly detected', () => {
    const result = evidenceScore(claim(row('gravity'), row('magnetic'), row('tides'), row('labHighPressure')));
    // 35 + 15 + 15 + 10 + 10 = 85
    expect(result.score).toBe(85);
    expect(result.level).toBe('wellConstrained');
    expect(levelFor(85, true)).toBe('directlyDetected');
  });

  it('Directly detected needs a direct row and a score from 65; below that the band decides', () => {
    expect(DIRECTLY_DETECTED_MIN_SCORE).toBe(65);
    expect(levelFor(65, true)).toBe('directlyDetected');
    expect(levelFor(65, false)).toBe('wellConstrained');
    expect(levelFor(60, true)).toBe('constrained');
    expect(levelFor(40, true)).toBe('modelDependent');
    // A direct row with nothing beside it: 45 + 10 unchallenged = 55, Constrained.
    expect(evidenceScore(claim(row('seismology'))).level).toBe('constrained');
    // A direct row with one further method: 45 + 15 + 10 = 70, Directly detected.
    expect(evidenceScore(claim(row('seismology'), row('gravity'))).level).toBe('directlyDetected');
  });

  it('accounts for a density row beside stronger evidence and a repeated method with zero-point lines', () => {
    const density = row('density');
    const secondGravity = row('gravity', 'supports', 2020);
    const result = evidenceScore(claim(row('seismology'), row('gravity', 'supports', 2010), secondGravity, density));
    // 45 + 15 gravity + 10 unchallenged = 70; the density and the second gravity row earn nothing.
    expect(result.score).toBe(70);
    const densityLine = result.lines.find((line) => line.evidence === density);
    expect(densityLine?.points).toBe(0);
    expect(densityLine?.label).toContain('beside stronger evidence');
    const repeatLine = result.lines.find((line) => line.evidence === secondGravity);
    expect(repeatLine?.points).toBe(0);
    expect(repeatLine?.label).toContain('already counted');
    // A second laboratory row and a second density row under density-only support are accounted for too.
    const secondLab = row('labHighPressure');
    const withLabs = evidenceScore(claim(row('seismology'), row('labHighPressure'), secondLab));
    expect(withLabs.lines.find((line) => line.evidence === secondLab)?.points).toBe(0);
    const secondDensity = row('density');
    const densityOnly = evidenceScore(claim(row('density'), secondDensity));
    expect(densityOnly.score).toBe(25);
    expect(densityOnly.lines.find((line) => line.evidence === secondDensity)?.points).toBe(0);
  });

  it('gives every evidence row of every shipped claim exactly one line', () => {
    let claims = 0;
    for (const bodyId of interiorBodyIds()) {
      const coverage = coverageFor(bodyId);
      for (const model of coverageModels(coverage)) {
        for (const region of model.regions) {
          for (const shippedClaim of region.claims) {
            claims++;
            const result = evidenceScore(shippedClaim, { competingTopology: competingTopology(coverage, model.modelId, region.key) });
            for (const evidence of shippedClaim.evidence) {
              const matching = result.lines.filter((line) => line.evidence === evidence);
              expect(matching, `${bodyId}/${model.modelId}/${region.key}/${shippedClaim.kind}: ${evidence.method} ${evidence.relation}`).toHaveLength(1);
            }
            // And no line points at a row the claim does not have.
            for (const line of result.lines) {
              if (line.evidence) expect(shippedClaim.evidence).toContain(line.evidence);
            }
          }
        }
      }
    }
    expect(claims).toBeGreaterThan(50);
  });

  it('density-only support earns 15 and is capped at Model-dependent', () => {
    const result = evidenceScore(claim(row('density'), row('model')));
    expect(result.score).toBe(25);
    expect(result.level).toBe('modelDependent');
  });

  it('constraining rows earn nothing but are listed', () => {
    const result = evidenceScore(claim(row('seismology'), row('gravity', 'constrains')));
    expect(result.score).toBe(55);
    expect(result.lines.some((line) => line.points === 0 && line.evidence?.relation === 'constrains')).toBe(true);
  });

  it('no evidence at all is a Hypothesis at 0', () => {
    const result = evidenceScore(claim());
    expect(result.score).toBe(0);
    expect(result.level).toBe('hypothesis');
  });

  it('fills the meter in fifths', () => {
    expect(meterSegments(0)).toBe(0);
    expect(meterSegments(20)).toBe(1);
    expect(meterSegments(45)).toBe(3);
    expect(meterSegments(95)).toBe(5);
  });
});
