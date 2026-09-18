import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { computeCutFrame, createCutFaceBasis, createCutFrame, cutFaceBasis, insideWedge, wedgeAngle, yawCutFrame, type CutFrame } from './cutFrame';
import { MAX_REGIONS } from './data/interiorTypes';
import { drawnRegionCount, pickInterior, regionIndexAtRadius, type PickLayout, type PickSurface } from './interiorPick';

/** A camera on +Z looking at the origin with +Y up: view (0,0,1), hinge (0,1,0), side (1,0,0). */
function layoutFor(openingAngle: number, outerDisplay: number[]): PickLayout {
  const frame = computeCutFrame(new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 1, 0), new THREE.Vector3(), openingAngle, createCutFrame());
  return { frame, outerDisplay };
}

function rayDown(x: number, y = 0) {
  return { origin: new THREE.Vector3(x, y, 5), direction: new THREE.Vector3(0, 0, -1) };
}

const THREE_REGIONS = [0.3, 0.7, 1];
const HALF_TURN = Math.PI;
const QUARTER_TURN = Math.PI / 2;

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
    expect(pickInterior(ray.origin, ray.direction, layoutFor(HALF_TURN, THREE_REGIONS))).toBeNull();
  });

  it('hits the skin when the cut is closed, whatever the regions', () => {
    const ray = rayDown(0.5);
    const hit = pickInterior(ray.origin, ray.direction, layoutFor(0, THREE_REGIONS))!;
    expect(hit.surface).toBe('skin');
    expect(hit.regionIndex).toBe(2);
    expect(hit.radiusDisplay).toBe(1);
    expect(hit.point.z).toBeCloseTo(Math.sqrt(1 - 0.25), 9);
  });

  it('at Section, the crust annulus is the outermost part of the one face', () => {
    const ray = rayDown(0.85);
    const hit = pickInterior(ray.origin, ray.direction, layoutFor(HALF_TURN, THREE_REGIONS))!;
    expect(hit.surface).toBe('face');
    expect(hit.regionIndex).toBe(2);
    expect(hit.radiusDisplay).toBeCloseTo(0.85, 9);
    expect(hit.distance).toBeCloseTo(5, 9); // the face is the z = 0 plane
  });

  it('at Section, the one flat face carries every region at its own radius', () => {
    // No tilted terrace face any more: the ray meets the z = 0 plane at 5,
    // half a radius out, and the region follows from that radius alone.
    const ray = rayDown(0.5);
    const hit = pickInterior(ray.origin, ray.direction, layoutFor(HALF_TURN, THREE_REGIONS))!;
    expect(hit.surface).toBe('face');
    expect(hit.regionIndex).toBe(1);
    expect(hit.distance).toBeCloseTo(5, 9);
    expect(hit.point.z).toBeCloseTo(0, 9);
    expect(hit.radiusDisplay).toBeCloseTo(0.5, 9);
  });

  it('is symmetric across the hinge: face B answers on the other side', () => {
    const a = rayDown(0.5);
    const b = rayDown(-0.5);
    const hitA = pickInterior(a.origin, a.direction, layoutFor(HALF_TURN, THREE_REGIONS))!;
    const hitB = pickInterior(b.origin, b.direction, layoutFor(HALF_TURN, THREE_REGIONS))!;
    expect(hitB.regionIndex).toBe(hitA.regionIndex);
    expect(hitB.distance).toBeCloseTo(hitA.distance, 9);
    expect(hitB.point.x).toBeCloseTo(-hitA.point.x, 9);
  });

  it('reaches the innermost region near the centre of the face', () => {
    const ray = rayDown(0.1);
    const hit = pickInterior(ray.origin, ray.direction, layoutFor(HALF_TURN, THREE_REGIONS))!;
    expect(hit.surface).toBe('face');
    expect(hit.regionIndex).toBe(0);
    expect(hit.radiusDisplay).toBeCloseTo(0.1, 9);
  });

  it('at a 90° opening, a ray inside the wedge lands on face A and one outside it on the skin', () => {
    const layout = layoutFor(QUARTER_TURN, THREE_REGIONS);
    // Face A's plane has normal sin45°·view − cos45°·side = (−√½, 0, √½), so a
    // ray straight down at x = 0.5 meets it at z = 0.5: radius √½, the crust.
    const inside = rayDown(0.5);
    const insideHit = pickInterior(inside.origin, inside.direction, layout)!;
    expect(insideHit.surface).toBe('face');
    expect(insideHit.point.z).toBeCloseTo(0.5, 9);
    expect(insideHit.distance).toBeCloseTo(4.5, 9);
    expect(insideHit.radiusDisplay).toBeCloseTo(Math.SQRT1_2, 9);
    expect(insideHit.regionIndex).toBe(2);
    const faceA = cutFaceBasis(layout.frame, 'a', createCutFaceBasis());
    expect(insideHit.point.dot(faceA.normal)).toBeCloseTo(0, 9);

    // At x = 0.9 the skin survives: its near point is 64° off the view axis,
    // past the wedge's 45° half-angle. Face A's plane is nearer along the ray
    // (z = 0.9, distance 4.1), but at radius 1.27 it is past the disc's rim.
    const outside = rayDown(0.9);
    const outsideHit = pickInterior(outside.origin, outside.direction, layout)!;
    expect(outsideHit.surface).toBe('skin');
    expect(outsideHit.regionIndex).toBe(2);
    expect(outsideHit.radiusDisplay).toBe(1);
    expect(outsideHit.distance).toBeCloseTo(5 - Math.sqrt(1 - 0.81), 9);
    expect(wedgeAngle(layout.frame, outsideHit.point)).toBeGreaterThan(layout.frame.openingAngle / 2);
    const planeDistance = -outside.origin.dot(faceA.normal) / outside.direction.dot(faceA.normal);
    expect(planeDistance).toBeCloseTo(4.1, 9);
    expect(outside.origin.clone().addScaledVector(outside.direction, planeDistance).length()).toBeGreaterThan(1);
  });

  it('follows a yawed frame: the near face is the one turned toward the camera', () => {
    const layout = layoutFor(QUARTER_TURN, THREE_REGIONS);
    yawCutFrame(layout.frame, 22 * (Math.PI / 180));
    const faceA = cutFaceBasis(layout.frame, 'a', createCutFaceBasis());
    const faceB = cutFaceBasis(layout.frame, 'b', createCutFaceBasis());
    const lineOfSight = new THREE.Vector3(0, 0, 1);
    expect(faceA.normal.dot(lineOfSight)).toBeGreaterThan(faceB.normal.dot(lineOfSight));

    // The camera axis now sits 22° inside the wedge (half-angle 45°): the skin
    // is removed there, and face A — the turned-toward face — answers.
    const near = rayDown(0.15);
    const nearHit = pickInterior(near.origin, near.direction, layout)!;
    expect(nearHit.surface).toBe('face');
    expect(Math.abs(nearHit.point.dot(faceA.normal))).toBeLessThan(1e-9);
    expect(nearHit.point.dot(faceA.radial)).toBeGreaterThan(0);
    const planeDistance = -near.origin.dot(faceA.normal) / near.direction.dot(faceA.normal);
    expect(nearHit.distance).toBeCloseTo(planeDistance, 9);
    expect(nearHit.point.z).toBeGreaterThan(0);

    // Mirror rays no longer land at mirror depths: the wedge is off the view axis.
    const left = rayDown(-0.5);
    const right = rayDown(0.5);
    const hitLeft = pickInterior(left.origin, left.direction, layout)!;
    const hitRight = pickInterior(right.origin, right.direction, layout)!;
    expect(Math.abs(hitLeft.distance - hitRight.distance)).toBeGreaterThan(0.05);

    // Far to the side the yaw turned the wedge away from, the skin survives at
    // exactly the wedge test's word.
    const skin = rayDown(-0.9);
    const hitSkin = pickInterior(skin.origin, skin.direction, layout)!;
    expect(hitSkin.surface).toBe('skin');
    expect(hitSkin.radiusDisplay).toBe(1);
    expect(wedgeAngle(layout.frame, hitSkin.point)).toBeGreaterThan(layout.frame.openingAngle / 2);
  });

  it('never picks a region through the intact far hemisphere', () => {
    // From behind the body (−Z), the cut faces the +Z camera: the skin is whole on this side.
    const layout = layoutFor(HALF_TURN, THREE_REGIONS);
    const hit = pickInterior(new THREE.Vector3(0.2, 0, -5), new THREE.Vector3(0, 0, 1), layout)!;
    expect(hit.surface).toBe('skin');
    expect(hit.regionIndex).toBe(2);
    expect(hit.radiusDisplay).toBe(1);
  });

  it('on the hinge line both faces answer at the same point, and one of them wins', () => {
    const layout = layoutFor(HALF_TURN, THREE_REGIONS);
    const ray = rayDown(0, 0.3);
    const faceA = cutFaceBasis(layout.frame, 'a', createCutFaceBasis());
    const faceB = cutFaceBasis(layout.frame, 'b', createCutFaceBasis());
    const distanceA = -ray.origin.dot(faceA.normal) / ray.direction.dot(faceA.normal);
    const distanceB = -ray.origin.dot(faceB.normal) / ray.direction.dot(faceB.normal);
    expect(distanceA).toBeCloseTo(distanceB, 12);
    const hit = pickInterior(ray.origin, ray.direction, layout)!;
    expect(hit.surface).toBe('face');
    expect(hit.distance).toBeCloseTo(distanceA, 9);
    expect(hit.radiusDisplay).toBeCloseTo(0.3, 9);
    expect(hit.point.x).toBeCloseTo(0, 9);
    expect(hit.point.y).toBeCloseTo(0.3, 9);
  });

  it('a single unresolved region is its own face and skin', () => {
    const layout = layoutFor(QUARTER_TURN, [1]);
    const ray = rayDown(0.4);
    const hit = pickInterior(ray.origin, ray.direction, layout)!;
    expect(hit.surface).toBe('face');
    expect(hit.regionIndex).toBe(0);
  });

  it('draws at most MAX_REGIONS regions, like the scene, whatever the layout lists', () => {
    const tooMany = Array.from({ length: MAX_REGIONS + 3 }, (_, index) => (index + 1) / (MAX_REGIONS + 3));
    expect(drawnRegionCount(tooMany)).toBe(MAX_REGIONS);
    expect(regionIndexAtRadius(tooMany, 0.99)).toBe(MAX_REGIONS - 1);
    const layout = layoutFor(0, tooMany);
    // With the cut closed the skin is all there is: the outermost DRAWN region, at radius 1.
    const ray = rayDown(0.1);
    const hit = pickInterior(ray.origin, ray.direction, layout)!;
    expect(hit.surface).toBe('skin');
    expect(hit.regionIndex).toBe(MAX_REGIONS - 1);
    expect(hit.radiusDisplay).toBe(1);
    const open = layoutFor(HALF_TURN, tooMany);
    for (let x = 0; x < 1; x += 0.05) {
      const probe = rayDown(x);
      const probeHit = pickInterior(probe.origin, probe.direction, open);
      if (probeHit) expect(probeHit.regionIndex).toBeLessThan(MAX_REGIONS);
    }
  });
});

/**
 * The candidate surfaces at a ray, worked out here rather than read from the
 * module's own loop: the unit sphere's near point where the wedge left it,
 * and each face's plane hit inside its half-disc.
 */
interface Candidate {
  surface: PickSurface;
  distance: number;
  point: THREE.Vector3;
  radius: number;
}

function candidatesAt(frame: CutFrame, origin: THREE.Vector3, direction: THREE.Vector3): Candidate[] {
  const found: Candidate[] = [];
  const alongToCentre = origin.dot(direction);
  const discriminant = alongToCentre * alongToCentre - (origin.lengthSq() - 1);
  if (discriminant >= 0) {
    const distance = -alongToCentre - Math.sqrt(discriminant);
    if (distance > 1e-7) {
      const point = origin.clone().addScaledVector(direction, distance);
      if (!insideWedge(frame, point)) found.push({ surface: 'skin', distance, point, radius: 1 });
    }
  }
  if (frame.openingAngle > 0) {
    for (const side of ['a', 'b'] as const) {
      const basis = cutFaceBasis(frame, side, createCutFaceBasis());
      const facing = direction.dot(basis.normal);
      if (facing >= -1e-7) continue;
      const distance = -origin.dot(basis.normal) / facing;
      if (distance <= 1e-7) continue;
      const point = origin.clone().addScaledVector(direction, distance);
      if (point.dot(basis.radial) < 0) continue;
      const radius = point.length();
      if (radius > 1) continue;
      found.push({ surface: 'face', distance, point, radius });
    }
  }
  return found;
}

describe('pickInterior over a grid of rays', () => {
  const xs = Array.from({ length: 15 }, (_, index) => -1.05 + index * 0.15);
  const ys = Array.from({ length: 7 }, (_, index) => -0.9 + index * 0.3);
  const openings = [Math.PI / 6, QUARTER_TURN, (2 * Math.PI) / 3, HALF_TURN];

  for (const opening of openings) {
    for (const yawDeg of [0, 22]) {
      it(`answers the nearest drawn surface at ${Math.round(opening * (180 / Math.PI))}° with ${yawDeg}° of yaw`, () => {
        const layout = layoutFor(opening, THREE_REGIONS);
        if (yawDeg !== 0) yawCutFrame(layout.frame, yawDeg * (Math.PI / 180));
        const frame = layout.frame;
        const faces = [cutFaceBasis(frame, 'a', createCutFaceBasis()), cutFaceBasis(frame, 'b', createCutFaceBasis())];
        let faceHits = 0;
        let skinHits = 0;
        for (const x of xs) {
          for (const y of ys) {
            const ray = rayDown(x, y);
            const hit = pickInterior(ray.origin, ray.direction, layout);
            const candidates = candidatesAt(frame, ray.origin, ray.direction);
            if (!hit) {
              expect(candidates).toHaveLength(0);
              continue;
            }
            expect(candidates.length).toBeGreaterThan(0);
            const nearest = Math.min(...candidates.map((candidate) => candidate.distance));
            expect(hit.distance).toBeCloseTo(nearest, 9);
            if (hit.surface === 'skin') {
              skinHits++;
              expect(insideWedge(frame, hit.point)).toBe(false);
              expect(hit.radiusDisplay).toBe(1);
              expect(hit.regionIndex).toBe(THREE_REGIONS.length - 1);
            } else {
              faceHits++;
              // On the +radial half of a face, and on that face's plane.
              const reachable = faces.filter((basis) => hit.point.dot(basis.radial) >= 0);
              expect(reachable.length).toBeGreaterThan(0);
              const offPlane = Math.min(...reachable.map((basis) => Math.abs(hit.point.dot(basis.normal))));
              expect(offPlane).toBeLessThan(1e-9);
              expect(hit.radiusDisplay).toBeCloseTo(hit.point.length(), 12);
              expect(hit.radiusDisplay).toBeLessThanOrEqual(1);
              expect(hit.regionIndex).toBe(regionIndexAtRadius(THREE_REGIONS, hit.radiusDisplay));
            }
          }
        }
        // Both kinds of surface are exercised — except at a face-on Section,
        // where the whole near hemisphere is gone and every ray from the
        // camera that meets the body meets the one disc.
        expect(faceHits).toBeGreaterThan(0);
        if (opening < HALF_TURN || yawDeg !== 0) expect(skinHits).toBeGreaterThan(0);
      });
    }
  }
});
