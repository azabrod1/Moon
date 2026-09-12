import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { computeCutFrame, createCutFrame, cutFaceBasis, terraceOpeningAngle, wedgeAngle, yawCutFrame } from './cutFrame';
import { MAX_REGIONS } from './data/interiorTypes';
import { drawnRegionCount, pickInterior, regionIndexAtRadius, type PickLayout } from './interiorPick';

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

  it('follows a yawed frame: the faces it hits are the turned faces, and the symmetry across the hinge is gone', () => {
    const yaw = 22 * (Math.PI / 180);
    const layout = layoutFor(Math.PI / 2, THREE_REGIONS);
    yawCutFrame(layout.frame, yaw);
    // The camera axis now sits 22° inside the wedge (half-angle 45°): the skin is removed there, a face answers.
    const near = rayDown(0.15);
    const nearHit = pickInterior(near.origin, near.direction, layout)!;
    expect(nearHit.surface).toBe('face');
    // Close to the axis the innermost terrace's face is nearest (its shell is removed inside its own wedge).
    expect(nearHit.regionIndex).toBe(0);
    // The face it lands on is that terrace's face A, the one turned toward the camera: with the wedge
    // yawed toward +side, face A's normal is nearer the line of sight than face B's at every terrace angle.
    const terrace = createCutFrame();
    terrace.view.copy(layout.frame.view);
    terrace.side.copy(layout.frame.side);
    terrace.hinge.copy(layout.frame.hinge);
    terrace.openingAngle = terraceOpeningAngle(layout.frame.openingAngle, THREE_REGIONS.length - 1 - nearHit.regionIndex, 0.2);
    const faceA = cutFaceBasis(terrace, 'a');
    const faceB = cutFaceBasis(terrace, 'b', { radial: new THREE.Vector3(), up: new THREE.Vector3(), normal: new THREE.Vector3() });
    const lineOfSight = new THREE.Vector3(0, 0, 1);
    expect(faceA.normal.dot(lineOfSight)).toBeGreaterThan(faceB.normal.dot(lineOfSight));
    expect(Math.abs(nearHit.point.dot(faceA.normal))).toBeLessThan(1e-9);
    expect(nearHit.point.dot(faceA.radial)).toBeGreaterThan(0);
    // Its depth is the analytic plane hit, in front of the unyawed disc plane (z = 0).
    const planeDistance = -near.origin.dot(faceA.normal) / near.direction.dot(faceA.normal);
    expect(nearHit.distance).toBeCloseTo(planeDistance, 9);
    expect(nearHit.point.z).toBeGreaterThan(0);
    // Mirror rays no longer land at mirror depths: the wedge is off the view axis.
    const left = rayDown(-0.5);
    const right = rayDown(0.5);
    const hitLeft = pickInterior(left.origin, left.direction, layout)!;
    const hitRight = pickInterior(right.origin, right.direction, layout)!;
    expect(Math.abs(hitLeft.distance - hitRight.distance)).toBeGreaterThan(0.05);
    // Far to the side the yaw turned the wedge away from, the skin survives at exactly the wedge test's word.
    const skin = rayDown(-0.9);
    const hitSkin = pickInterior(skin.origin, skin.direction, layout)!;
    expect(hitSkin.surface).toBe('skin');
    expect(wedgeAngle(layout.frame, hitSkin.point)).toBeGreaterThan(layout.frame.openingAngle / 2);
  });

  it('answers with the shell of an inner terrace whose own wedge is closed', () => {
    // Six regions at a 0.2 step: the innermost is five steps in, so at Section its terrace angle is 0
    // and its shell is whole. Down the view axis the ray passes every open face's centre hole and
    // lands on that shell, not on a face.
    const six = [0.1, 0.25, 0.4, 0.6, 0.8, 1];
    const layout = layoutFor(Math.PI, six);
    expect(terraceOpeningAngle(Math.PI, 5, 0.2)).toBe(0);
    const ray = rayDown(0.02);
    const hit = pickInterior(ray.origin, ray.direction, layout)!;
    expect(hit.surface).toBe('shell');
    expect(hit.regionIndex).toBe(0);
    expect(hit.radiusDisplay).toBe(0.1);
    // Region 1, one step out, is open 36°: its steep face (18° off the side axis) reaches in front
    // of region 0's shell close to the axis, so a ray at x = 0.07 lands on that face at radius 0.23.
    const steep = rayDown(0.07);
    const hitSteep = pickInterior(steep.origin, steep.direction, layout)!;
    expect(hitSteep.surface).toBe('face');
    expect(hitSteep.regionIndex).toBe(1);
    expect(hitSteep.radiusDisplay).toBeGreaterThan(0.1);
    expect(hitSteep.radiusDisplay).toBeLessThan(0.25);
    // Further out the wider face of region 2 is in front: the terraces step outward.
    const wider = rayDown(0.2);
    const hitWider = pickInterior(wider.origin, wider.direction, layout)!;
    expect(hitWider.surface).toBe('face');
    expect(hitWider.regionIndex).toBe(2);
  });

  it('draws at most MAX_REGIONS regions, like the scene, whatever the layout lists', () => {
    const tooMany = Array.from({ length: MAX_REGIONS + 3 }, (_, index) => (index + 1) / (MAX_REGIONS + 3));
    expect(drawnRegionCount(tooMany)).toBe(MAX_REGIONS);
    expect(regionIndexAtRadius(tooMany, 0.99)).toBe(MAX_REGIONS - 1);
    const layout = layoutFor(0, tooMany);
    // With the cut closed the outermost DRAWN shell is the skin: region MAX_REGIONS − 1 at its own radius.
    const ray = rayDown(0.1);
    const hit = pickInterior(ray.origin, ray.direction, layout)!;
    expect(hit.surface).toBe('skin');
    expect(hit.regionIndex).toBe(MAX_REGIONS - 1);
    expect(hit.radiusDisplay).toBe(tooMany[MAX_REGIONS - 1]);
    const open = layoutFor(Math.PI, tooMany);
    for (let x = 0; x < 1; x += 0.05) {
      const probe = rayDown(x);
      const probeHit = pickInterior(probe.origin, probe.direction, open);
      if (probeHit) expect(probeHit.regionIndex).toBeLessThan(MAX_REGIONS);
    }
  });
});
