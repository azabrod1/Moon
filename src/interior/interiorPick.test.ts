import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { computeCutFrame, createCutFrame, terraceOpeningAngle } from './cutFrame';
import { pickInterior, regionIndexAtRadius, type PickLayout } from './interiorPick';

/** A camera on +Z looking at the origin with +Y up: view (0,0,1), hinge (0,1,0), side (1,0,0). */
function layoutFor(openingAngle: number, outerDisplay: number[], terraceStep = 0.2): PickLayout {
  const frame = computeCutFrame(new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 1, 0), new THREE.Vector3(), openingAngle, createCutFrame());
  return { frame, outerDisplay, terraceStep };
}

function rayDown(x: number, y = 0) {
  return { origin: new THREE.Vector3(x, y, 5), direction: new THREE.Vector3(0, 0, -1) };
}

const THREE_REGIONS = [0.3, 0.7, 1];

describe('terraceOpeningAngle', () => {
  it('narrows each step inward and closes past the last step', () => {
    expect(terraceOpeningAngle(Math.PI, 0, 0.2)).toBe(Math.PI);
    expect(terraceOpeningAngle(Math.PI, 1, 0.2)).toBeCloseTo(Math.PI * 0.8, 12);
    expect(terraceOpeningAngle(Math.PI, 5, 0.2)).toBe(0);
    expect(terraceOpeningAngle(Math.PI, 9, 0.2)).toBe(0);
  });
});

describe('regionIndexAtRadius', () => {
  it('returns the first region whose outer radius reaches the hit', () => {
    expect(regionIndexAtRadius(THREE_REGIONS, 0)).toBe(0);
    expect(regionIndexAtRadius(THREE_REGIONS, 0.3)).toBe(0);
    expect(regionIndexAtRadius(THREE_REGIONS, 0.31)).toBe(1);
    expect(regionIndexAtRadius(THREE_REGIONS, 0.99)).toBe(2);
    expect(regionIndexAtRadius(THREE_REGIONS, 1.5)).toBe(2);
  });
});

describe('pickInterior', () => {
  it('misses a ray that passes the body', () => {
    const ray = rayDown(2);
    expect(pickInterior(ray.origin, ray.direction, layoutFor(Math.PI, THREE_REGIONS))).toBeNull();
  });

  it('hits the skin when the cut is closed, whatever the regions', () => {
    const ray = rayDown(0.5);
    const hit = pickInterior(ray.origin, ray.direction, layoutFor(0, THREE_REGIONS))!;
    expect(hit.surface).toBe('skin');
    expect(hit.regionIndex).toBe(2);
    expect(hit.radiusDisplay).toBe(1);
    expect(hit.point.z).toBeCloseTo(Math.sqrt(1 - 0.25), 9);
  });

  it('at Section, the crust annulus is the outermost face', () => {
    const ray = rayDown(0.85);
    const hit = pickInterior(ray.origin, ray.direction, layoutFor(Math.PI, THREE_REGIONS))!;
    expect(hit.surface).toBe('face');
    expect(hit.regionIndex).toBe(2);
    expect(hit.radiusDisplay).toBeCloseTo(0.85, 9);
    expect(hit.distance).toBeCloseTo(5, 9); // the crust's face is the z = 0 plane
  });

  it('at Section, a terrace face one step in is hit before the crust face behind it', () => {
    const ray = rayDown(0.5);
    const hit = pickInterior(ray.origin, ray.direction, layoutFor(Math.PI, THREE_REGIONS))!;
    expect(hit.surface).toBe('face');
    expect(hit.regionIndex).toBe(1);
    // Face A of region 1 tilts by θ₁/2 = 72°: normal (−cos72, 0, sin72) through the origin.
    const half = (Math.PI * 0.8) / 2;
    const z = (0.5 * Math.cos(half)) / Math.sin(half);
    expect(hit.point.z).toBeCloseTo(z, 9);
    expect(hit.distance).toBeCloseTo(5 - z, 9);
    expect(hit.radiusDisplay).toBeCloseTo(Math.hypot(0.5, z), 9);
  });

  it('is symmetric across the hinge: face B answers on the other side', () => {
    const a = rayDown(0.5);
    const b = rayDown(-0.5);
    const hitA = pickInterior(a.origin, a.direction, layoutFor(Math.PI, THREE_REGIONS))!;
    const hitB = pickInterior(b.origin, b.direction, layoutFor(Math.PI, THREE_REGIONS))!;
    expect(hitB.regionIndex).toBe(hitA.regionIndex);
    expect(hitB.distance).toBeCloseTo(hitA.distance, 9);
    expect(hitB.point.x).toBeCloseTo(-hitA.point.x, 9);
  });

  it('reaches the innermost region down its own narrower terrace', () => {
    const ray = rayDown(0.1);
    const hit = pickInterior(ray.origin, ray.direction, layoutFor(Math.PI, THREE_REGIONS))!;
    expect(hit.surface).toBe('face');
    expect(hit.regionIndex).toBe(0);
    expect(hit.radiusDisplay).toBeLessThan(0.3);
  });

  it('hits an inner shell where the cut above is open but its own wedge is closed', () => {
    // A small opening: the crust opens 20°, region 1 opens 16°, region 0 opens 12°.
    // A ray a little off the view axis in the hinge direction (y) lands on
    // the crust's removed cap, then on region 1's shell, which is removed
    // only inside its own narrower wedge — the point at (0, 0.2, z) is ON the
    // view axis in the wedge plane (angle 0), so it is removed too; go wider.
    const opening = 20 * (Math.PI / 180);
    const layout = layoutFor(opening, THREE_REGIONS);
    const ray = rayDown(0.12, 0);
    const hit = pickInterior(ray.origin, ray.direction, layout)!;
    // atan2(0.12, √(0.49−0.0144)) ≈ 9.9° > region 1's half-angle 8°: shell 1 survives there,
    // while the crust (half-angle 10°) is removed at atan2(0.12, √(1−0.0144)) ≈ 6.9°.
    expect(hit.surface).toBe('shell');
    expect(hit.regionIndex).toBe(1);
    expect(hit.radiusDisplay).toBe(0.7);
  });

  it('never picks a region through the intact far hemisphere', () => {
    // From behind the body (−Z), the cut faces the +Z camera: the skin is whole on this side.
    const layout = layoutFor(Math.PI, THREE_REGIONS);
    const hit = pickInterior(new THREE.Vector3(0.2, 0, -5), new THREE.Vector3(0, 0, 1), layout)!;
    expect(hit.surface).toBe('skin');
    expect(hit.regionIndex).toBe(2);
  });

  it('a single unresolved region is its own face and skin', () => {
    const layout = layoutFor(Math.PI / 2, [1]);
    const ray = rayDown(0.4);
    const hit = pickInterior(ray.origin, ray.direction, layout)!;
    expect(hit.surface).toBe('face');
    expect(hit.regionIndex).toBe(0);
  });
});
