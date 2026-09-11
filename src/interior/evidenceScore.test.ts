import { describe, expect, it } from 'vitest';
import { evidenceScore, levelFor, meterSegments } from './evidenceScore';
import type { Claim, Evidence, EvidenceMethod, EvidenceRelation } from './data/interiorTypes';

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

  it('a claim on a model row alone is a Hypothesis', () => {
    const result = evidenceScore({ kind: 'temperature', evidence: [row('model')] });
    expect(result.score).toBe(10);
    expect(result.level).toBe('hypothesis');
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
