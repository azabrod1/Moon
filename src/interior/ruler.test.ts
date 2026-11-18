import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { computeCutFrame, createCutFaceBasis, createCutFrame, cutFaceBasis, yawCutFrame } from './cutFrame';
import { IDENTITY_REMAP, readableRemap, toDisplayFraction } from './interiorGeometry';
import { spheroidLevelRadius, spheroidRadiusToward, SPHERE_SHAPE, type SpheroidShape } from '../astronomy/spheroid';
import { niceStepKm, rulerFacing, rulerLayout, rulerPoint, rulerSide, type RulerInput } from './ruler';

/** A camera on +Z with +Y up: view (0,0,1), hinge (0,1,0), side (1,0,0). */
function frameAt(openingAngle: number) {
  return computeCutFrame(new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 1, 0), new THREE.Vector3(), openingAngle, createCutFrame());
}

function input(overrides: Partial<RulerInput> = {}): RulerInput {
  return {
    frame: frameAt(Math.PI),
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

  it('places every depth on the one full-angle face, whichever region owns it', () => {
    // 4000 km down is the outer core, but the cut is one wedge through the
    // whole body: the point is simply the face's radial at that radius.
    const section = rulerPoint(input(), 4000);
    const radius = section.length();
    expect(radius).toBeCloseTo(1 - 4000 / 6371, 9);
    expect(section.x / radius).toBeCloseTo(1, 9);
    expect(section.z / radius).toBeCloseTo(0, 9);
    // At a 90° opening, face A's radial is cos45°·view + sin45°·side.
    const quarter = rulerPoint(input({ frame: frameAt(Math.PI / 2) }), 4000);
    expect(quarter.length()).toBeCloseTo(radius, 9);
    expect(quarter.x / radius).toBeCloseTo(Math.SQRT1_2, 9);
    expect(quarter.z / radius).toBeCloseTo(Math.SQRT1_2, 9);
    expect(quarter.y).toBeCloseTo(0, 9);
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

  it("carries a region's note onto its segment, and none where the region has none", () => {
    const layout = rulerLayout(input({
      regionsInsideOut: [
        { key: 'core', name: 'Core', outerRadiusKm: 1221, innerRadiusKm: 0, note: 'Temperature not known' },
        { key: 'mantle', name: 'Mantle', outerRadiusKm: 6371, innerRadiusKm: 1221 },
      ],
      outerDisplay: [0.19, 1],
      annotations: [],
    }));
    expect(layout.segments.map((segment) => segment.note)).toEqual(['Temperature not known', '']);
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

  it('lays every point on one straight line out of the centre: the cut has no terraces to step across', () => {
    // A 90° opening, where the face is tilted out of every scene axis, so a
    // point that wandered off the line would show in all three components.
    const laid = input({ frame: frameAt(Math.PI / 2) });
    const layout = rulerLayout(laid);
    const radial = cutFaceBasis(laid.frame, 'a', createCutFaceBasis()).radial;
    const points = [
      ...layout.ticks.map((tick) => tick.point),
      ...layout.segments.flatMap((segment) => [segment.from, segment.to]),
      ...layout.brackets.flatMap((bracket) => [bracket.from, bracket.to]),
    ];
    expect(points.length).toBeGreaterThan(10);
    for (const point of points) {
      const along = point.dot(radial);
      expect(along).toBeGreaterThanOrEqual(0);
      // point = along · radial exactly: nothing off the line, nothing behind the hinge.
      expect(point.distanceTo(radial.clone().multiplyScalar(along))).toBeLessThan(1e-9);
    }
  });

  it('reuses a layout it is handed, its vectors included, and shortens it to fit', () => {
    const pooled = rulerLayout(input());
    const tickVectors = pooled.ticks.map((tick) => tick.point);
    const segmentVectors = pooled.segments.map((segment) => segment.from);
    const again = rulerLayout(input(), pooled);
    expect(again).toBe(pooled);
    again.ticks.forEach((tick, index) => expect(tick.point).toBe(tickVectors[index]));
    again.segments.forEach((segment, index) => expect(segment.from).toBe(segmentVectors[index]));
    // A smaller body: fewer ticks and regions, the extra entries dropped, the rest re-posed.
    const smaller = rulerLayout(input({
      referenceRadiusKm: 1560.8,
      outerDisplay: [0.4, 1],
      regionsInsideOut: [
        { key: 'core', name: 'Core', outerRadiusKm: 600, innerRadiusKm: 0 },
        { key: 'shell', name: 'Shell', outerRadiusKm: 1560.8, innerRadiusKm: 600 },
      ],
      annotations: [],
    }), pooled);
    expect(smaller.stepKm).toBe(200);
    expect(smaller.ticks.map((tick) => tick.depthKm)).toEqual([0, 200, 400, 600, 800, 1000, 1200, 1400, 1560.8]);
    expect(smaller.segments.map((segment) => segment.key)).toEqual(['core', 'shell']);
    expect(smaller.brackets).toHaveLength(0);
    expect(smaller.ticks[0].point).toBe(tickVectors[0]);
  });

  it('chooses the face turned more toward the camera', () => {
    const frame = frameAt(Math.PI / 2);
    // Camera exactly on the view axis: a tie, resolved to face A.
    expect(rulerSide(frame, new THREE.Vector3(0, 0, 1))).toBe('a');
    // Camera swung toward −side: face B (its normal has a +side component) faces it more.
    expect(rulerSide(frame, new THREE.Vector3(0.5, 0, 0.87).normalize())).toBe('b');
    expect(rulerSide(frame, new THREE.Vector3(-0.5, 0, 0.87).normalize())).toBe('a');
  });

  it('reports how squarely the nearer face meets the eye, and turns negative behind the body', () => {
    // At Section both faces look straight down the view axis.
    expect(rulerFacing(frameAt(Math.PI), new THREE.Vector3(0, 0, 1))).toBeCloseTo(1, 9);
    // At a 90° opening each face is 45° off it.
    expect(rulerFacing(frameAt(Math.PI / 2), new THREE.Vector3(0, 0, 1))).toBeCloseTo(Math.SQRT1_2, 9);
    // Orbited round behind the cut, both faces have turned away.
    expect(rulerFacing(frameAt(Math.PI), new THREE.Vector3(0, 0, -1))).toBeCloseTo(-1, 9);
    expect(rulerFacing(frameAt(Math.PI / 2), new THREE.Vector3(0, 0, -1))).toBeLessThan(0);
    // The face rulerSide picks is the one the facing reports.
    const frame = frameAt(Math.PI / 2);
    const camera = new THREE.Vector3(0.5, 0, 0.87).normalize();
    const picked = cutFaceBasis(frame, rulerSide(frame, camera), createCutFaceBasis());
    expect(rulerFacing(frame, camera)).toBeCloseTo(picked.normal.dot(camera), 12);
  });
});

describe('the ruler on a flattened giant', () => {
  const FLATTENING = 1 - 54_364 / 60_268; // Saturn's
  const tilted = new THREE.Vector3(0.3, 0.85, 0.25).normalize();
  const SATURN: SpheroidShape = { flattening: FLATTENING, poleX: tilted.x, poleY: tilted.y, poleZ: tilted.z };
  const saturnInput = (shape: SpheroidShape | undefined, side: 'a' | 'b') => input({
    frame: yawCutFrame(computeCutFrame(new THREE.Vector3(3, 1, 8), new THREE.Vector3(0, 1, 0), new THREE.Vector3(), Math.PI / 2, createCutFrame()), 0.4),
    side,
    referenceRadiusKm: 58_232,
    remap: readableRemap([0.6, 0.72, 0.9875, 1], 0.05),
    outerDisplay: [0.62, 0.75, 0.989, 1],
    regionsInsideOut: [
      { key: 'diffuseCore', name: 'Diffuse core', outerRadiusKm: 35_000, innerRadiusKm: 0 },
      { key: 'metallicHydrogen', name: 'Metallic hydrogen', outerRadiusKm: 42_000, innerRadiusKm: 35_000 },
      { key: 'molecularEnvelope', name: 'Molecular hydrogen envelope', outerRadiusKm: 57_500, innerRadiusKm: 42_000 },
      { key: 'atmosphere', name: 'Outer atmosphere', outerRadiusKm: 58_232, innerRadiusKm: 57_500 },
    ],
    annotations: [{ name: 'Helium rain region', innerRadiusKm: 32_000, outerRadiusKm: 42_000 }],
    shape,
  });

  it('puts every mark on the level the faces draw for it, along the one radial line', () => {
    for (const side of ['a', 'b'] as const) {
      const ruler = saturnInput(SATURN, side);
      const radial = cutFaceBasis(ruler.frame, side, createCutFaceBasis()).radial;
      const layout = rulerLayout(ruler);
      for (const tick of layout.ticks) {
        const physical = 1 - tick.depthKm / ruler.referenceRadiusKm;
        const display = toDisplayFraction(ruler.remap, physical);
        expect(spheroidLevelRadius(tick.point.x, tick.point.y, tick.point.z, SATURN)).toBeCloseTo(display, 12);
        expect(tick.point.clone().normalize().dot(radial)).toBeGreaterThan(display > 1e-9 ? 1 - 1e-12 : -2);
      }
      layout.segments.forEach((segment, index) => {
        expect(spheroidLevelRadius(segment.from.x, segment.from.y, segment.from.z, SATURN)).toBeCloseTo(ruler.outerDisplay[index], 12);
      });
      // The rim mark is on the surface itself.
      const rim = layout.ticks[0].point;
      expect(rim.length()).toBeCloseTo(spheroidRadiusToward(radial.x, radial.y, radial.z, 1, SATURN), 12);
    }
  });

  it('is the sphere ruler, bit for bit, at no flattening', () => {
    const sphere = rulerLayout(saturnInput(undefined, 'a'));
    const shaped = rulerLayout(saturnInput(SPHERE_SHAPE, 'a'));
    expect(shaped.ticks.map((tick) => tick.point.toArray())).toEqual(sphere.ticks.map((tick) => tick.point.toArray()));
    expect(shaped.segments.map((segment) => segment.from.toArray())).toEqual(sphere.segments.map((segment) => segment.from.toArray()));
  });
});
