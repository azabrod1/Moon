import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { computeCutFrame, createCutFrame } from './cutFrame';
import { IDENTITY_REMAP, readableRemap } from './interiorGeometry';
import { niceStepKm, rulerLayout, rulerPoint, rulerSide, type RulerInput } from './ruler';

function input(overrides: Partial<RulerInput> = {}): RulerInput {
  const frame = computeCutFrame(new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 1, 0), new THREE.Vector3(), Math.PI, createCutFrame());
  return {
    frame,
    side: 'a',
    referenceRadiusKm: 6371,
    remap: IDENTITY_REMAP,
    outerDisplay: [0.19, 0.55, 0.9, 0.99, 1],
    regionsInsideOut: [
      { key: 'innerCore', name: 'Inner core', outerRadiusKm: 1221, innerRadiusKm: 0 },
      { key: 'outerCore', name: 'Outer core', outerRadiusKm: 3480, innerRadiusKm: 1221 },
      { key: 'lowerMantle', name: 'Lower mantle', outerRadiusKm: 5711, innerRadiusKm: 3480 },
      { key: 'upperMantle', name: 'Upper mantle', outerRadiusKm: 6336, innerRadiusKm: 5711 },
      { key: 'crust', name: 'Crust', outerRadiusKm: 6371, innerRadiusKm: 6336 },
    ],
    annotations: [{ name: 'Transition zone', innerRadiusKm: 5711, outerRadiusKm: 5961 }],
    terraceStep: 0.2,
    ...overrides,
  };
}

describe('niceStepKm', () => {
  it('picks the smallest nice step that fits at most eight ticks', () => {
    expect(niceStepKm(6371)).toBe(1000);
    expect(niceStepKm(1560.8)).toBe(200);
    expect(niceStepKm(11.1)).toBe(2);
    expect(niceStepKm(69_911)).toBe(10_000);
    expect(niceStepKm(252.1)).toBe(50);
    expect(niceStepKm(696_340)).toBe(100_000);
  });
});

describe('rulerPoint', () => {
  it('puts the rim on the crust face and the centre at the origin', () => {
    const rim = rulerPoint(input(), 0);
    // At Section, face A's radial is +X (side): the rim sits at (1, 0, 0).
    expect(rim.x).toBeCloseTo(1, 9);
    expect(rim.y).toBeCloseTo(0, 9);
    expect(rim.z).toBeCloseTo(0, 9);
    const centre = rulerPoint(input(), 6371);
    expect(centre.length()).toBeCloseTo(0, 9);
  });

  it('places a depth on the face of the region that owns it, at that face\'s terrace angle', () => {
    // 4000 km down is the outer core (region 1): its face opens θ₁ = π·(1 − 3·0.2) = 0.4π, half 0.2π.
    const point = rulerPoint(input(), 4000);
    const radius = point.length();
    expect(radius).toBeCloseTo(1 - 4000 / 6371, 9);
    const half = 0.4 * Math.PI / 2;
    // radial_A = cos(half)·view + sin(half)·side, view = +Z, side = +X.
    expect(point.z / radius).toBeCloseTo(Math.cos(half), 9);
    expect(point.x / radius).toBeCloseTo(Math.sin(half), 9);
  });

  it('stretches through the Readable remap: the crust tick moves inward as the crust is widened', () => {
    const remap = readableRemap([1221 / 6371, 3480 / 6371, 5711 / 6371, 6336 / 6371, 1], 0.05, 1);
    const trueScale = rulerPoint(input(), 35);
    const readable = rulerPoint(input({ remap }), 35);
    // 35 km down is the crust's base: on the true scale a hair under the rim, on the Readable scale 5% in.
    expect(trueScale.length()).toBeCloseTo(1 - 35 / 6371, 6);
    expect(readable.length()).toBeCloseTo(0.95, 6);
  });
});

describe('rulerLayout', () => {
  it('ticks every nice step from the rim, ending at the centre', () => {
    const layout = rulerLayout(input());
    expect(layout.stepKm).toBe(1000);
    expect(layout.ticks.map((tick) => tick.depthKm)).toEqual([0, 1000, 2000, 3000, 4000, 5000, 6000, 6371]);
    expect(layout.ticks[7].major).toBe(false);
    expect(layout.ticks[0].point.length()).toBeCloseTo(1, 9);
  });

  it('gives one segment per region from its outer edge in to its inner one, and a bracket per annotation', () => {
    const layout = rulerLayout(input());
    expect(layout.segments.map((segment) => segment.key)).toEqual(['innerCore', 'outerCore', 'lowerMantle', 'upperMantle', 'crust']);
    expect(layout.segments[4].from.length()).toBeCloseTo(1, 9);
    expect(layout.segments[4].to.length()).toBeCloseTo(0.99, 5);
    expect(layout.segments[0].to.length()).toBeCloseTo(0, 9);
    expect(layout.brackets).toHaveLength(1);
    expect(layout.brackets[0].from.length()).toBeCloseTo(5961 / 6371, 9);
    expect(layout.brackets[0].to.length()).toBeCloseTo(5711 / 6371, 9);
  });

  it('chooses the face turned more toward the camera', () => {
    const frame = computeCutFrame(new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 1, 0), new THREE.Vector3(), Math.PI / 2, createCutFrame());
    // Camera exactly on the view axis: a tie, resolved to face A.
    expect(rulerSide(frame, new THREE.Vector3(0, 0, 1))).toBe('a');
    // Camera swung toward −side: face B (its normal has a +side component) faces it more.
    expect(rulerSide(frame, new THREE.Vector3(0.5, 0, 0.87).normalize())).toBe('b');
    expect(rulerSide(frame, new THREE.Vector3(-0.5, 0, 0.87).normalize())).toBe('a');
  });
});
