import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  CUT_VIEW_ANGLE_DEG,
  computeCutFrame,
  createCutFrame,
  cutFaceBasis,
  cutViewForAngle,
  insideWedge,
  openingAngleDegToRad,
  wedgeAngle,
  wedgeYawForOpening,
  yawCutFrame,
} from './cutFrame';

const centre = new THREE.Vector3(0, 0, 0);

/** A camera orbiting the origin, looking at it: its local up is what the mode passes. */
function orbitCamera(azimuthDeg: number, elevationDeg: number, distance = 5) {
  const azimuth = THREE.MathUtils.degToRad(azimuthDeg);
  const elevation = THREE.MathUtils.degToRad(elevationDeg);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  camera.position.set(
    distance * Math.sin(azimuth) * Math.cos(elevation),
    distance * Math.sin(elevation),
    distance * Math.cos(azimuth) * Math.cos(elevation),
  );
  camera.up.set(0, 1, 0);
  camera.lookAt(centre);
  camera.updateMatrixWorld();
  const localUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  return { position: camera.position.clone(), localUp };
}

function expectVectorClose(actual: THREE.Vector3, expected: THREE.Vector3, digits = 6) {
  expect(actual.x).toBeCloseTo(expected.x, digits);
  expect(actual.y).toBeCloseTo(expected.y, digits);
  expect(actual.z).toBeCloseTo(expected.z, digits);
}

describe('computeCutFrame', () => {
  it('builds a right-handed (view, side, hinge) basis from the camera', () => {
    const { position, localUp } = orbitCamera(0, 0);
    const frame = computeCutFrame(position, localUp, centre, Math.PI / 2);
    expectVectorClose(frame.view, new THREE.Vector3(0, 0, 1));
    expectVectorClose(frame.hinge, new THREE.Vector3(0, 1, 0));
    expectVectorClose(frame.side, new THREE.Vector3(1, 0, 0));
    expect(new THREE.Vector3().crossVectors(frame.hinge, frame.view).dot(frame.side)).toBeCloseTo(1, 9);
  });

  it('keeps the hinge exactly perpendicular to the view at every elevation', () => {
    for (let elevationDeg = -89; elevationDeg <= 89; elevationDeg += 11) {
      for (let azimuthDeg = 0; azimuthDeg < 360; azimuthDeg += 37) {
        const { position, localUp } = orbitCamera(azimuthDeg, elevationDeg);
        const frame = computeCutFrame(position, localUp, centre, 1);
        expect(Math.abs(frame.hinge.dot(frame.view))).toBeLessThan(1e-9);
        expect(frame.hinge.length()).toBeCloseTo(1, 9);
        expect(frame.side.length()).toBeCloseTo(1, 9);
      }
    }
  });

  it('changes smoothly as the camera orbits through the poles and across the equator', () => {
    const stepDeg = 1;
    const maxStep = 2 * Math.sin(THREE.MathUtils.degToRad(stepDeg) / 2) * 1.5;
    let previous = computeCutFrame(orbitCamera(20, -89).position, orbitCamera(20, -89).localUp, centre, 1);
    for (let elevationDeg = -88; elevationDeg <= 89; elevationDeg += stepDeg) {
      const { position, localUp } = orbitCamera(20, elevationDeg);
      const frame = computeCutFrame(position, localUp, centre, 1, createCutFrame());
      expect(frame.view.distanceTo(previous.view)).toBeLessThan(maxStep);
      expect(frame.hinge.distanceTo(previous.hinge)).toBeLessThan(maxStep);
      expect(frame.side.distanceTo(previous.side)).toBeLessThan(maxStep);
      previous = frame;
    }
    previous = computeCutFrame(orbitCamera(0, 0).position, orbitCamera(0, 0).localUp, centre, 1);
    for (let azimuthDeg = stepDeg; azimuthDeg <= 360; azimuthDeg += stepDeg) {
      const { position, localUp } = orbitCamera(azimuthDeg, 0);
      const frame = computeCutFrame(position, localUp, centre, 1, createCutFrame());
      expect(frame.view.distanceTo(previous.view)).toBeLessThan(maxStep);
      expect(frame.hinge.distanceTo(previous.hinge)).toBeLessThan(maxStep);
      previous = frame;
    }
  });

  it('stands in a perpendicular axis when handed an up parallel to the view', () => {
    const frame = computeCutFrame(new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 0, 1), centre, 1);
    expect(Math.abs(frame.hinge.dot(frame.view))).toBeLessThan(1e-9);
    expect(frame.hinge.length()).toBeCloseTo(1, 9);
  });

  it('clamps the opening angle to [0, π]', () => {
    const { position, localUp } = orbitCamera(0, 0);
    expect(computeCutFrame(position, localUp, centre, -1).openingAngle).toBe(0);
    expect(computeCutFrame(position, localUp, centre, 7).openingAngle).toBeCloseTo(Math.PI, 12);
  });
});

describe('the three named views', () => {
  const { position, localUp } = orbitCamera(0, 0);
  const view = new THREE.Vector3(0, 0, 1);
  const side = new THREE.Vector3(1, 0, 0);

  it('Closed removes nothing', () => {
    const frame = computeCutFrame(position, localUp, centre, openingAngleDegToRad(CUT_VIEW_ANGLE_DEG.closed));
    expect(insideWedge(frame, new THREE.Vector3(0, 0, 1))).toBe(false);
    expect(insideWedge(frame, new THREE.Vector3(0.1, 0.2, 0.97))).toBe(false);
  });

  it('Section removes exactly the near hemisphere and both faces become one disc facing the camera', () => {
    const frame = computeCutFrame(position, localUp, centre, openingAngleDegToRad(CUT_VIEW_ANGLE_DEG.section));
    expect(insideWedge(frame, new THREE.Vector3(0, 0, 1))).toBe(true);
    expect(insideWedge(frame, new THREE.Vector3(0.7, 0.3, 0.05))).toBe(true);
    expect(insideWedge(frame, new THREE.Vector3(0, 0, -1))).toBe(false);
    expect(insideWedge(frame, new THREE.Vector3(0.7, 0.3, -0.05))).toBe(false);
    const faceA = cutFaceBasis(frame, 'a');
    const faceB = cutFaceBasis(frame, 'b');
    expectVectorClose(faceA.normal, view);
    expectVectorClose(faceB.normal, view);
    expectVectorClose(faceA.radial, side);
    expectVectorClose(faceB.radial, side.clone().negate());
  });

  it('Cutaway puts each face plane half the opening off the view axis, normal into the wedge', () => {
    const frame = computeCutFrame(position, localUp, centre, openingAngleDegToRad(CUT_VIEW_ANGLE_DEG.cutaway));
    const faceA = cutFaceBasis(frame, 'a');
    const faceB = cutFaceBasis(frame, 'b');
    // Each face plane sits half the opening off the view axis (60° at the 120° cutaway), so
    // its normal sits the complement, (π − θ)/2 = 30°, off the axis.
    const normalOffView = (Math.PI - openingAngleDegToRad(CUT_VIEW_ANGLE_DEG.cutaway)) / 2;
    expect(faceA.normal.angleTo(view)).toBeCloseTo(normalOffView, 9);
    expect(faceB.normal.angleTo(view)).toBeCloseTo(normalOffView, 9);
    expect(faceA.normal.dot(faceA.radial)).toBeCloseTo(0, 9);
    expect(faceB.normal.dot(faceB.radial)).toBeCloseTo(0, 9);
    // The normals face the viewer, and each points away from its own side.
    expect(faceA.normal.dot(view)).toBeGreaterThan(0);
    expect(faceA.normal.dot(side)).toBeLessThan(0);
    expect(faceB.normal.dot(side)).toBeGreaterThan(0);
    // A point on the view axis is removed; one 60° round is kept.
    expect(insideWedge(frame, new THREE.Vector3(0, 0, 1))).toBe(true);
    expect(insideWedge(frame, new THREE.Vector3(Math.sin(1.05), 0, Math.cos(1.05)))).toBe(false);
  });

  it('every face basis is right-handed so a +Z half-disc maps without a mirror', () => {
    for (const angleDeg of [10, 45, 90, 135, 180]) {
      const frame = computeCutFrame(position, localUp, centre, openingAngleDegToRad(angleDeg));
      for (const face of ['a', 'b'] as const) {
        const basis = cutFaceBasis(frame, face);
        const cross = new THREE.Vector3().crossVectors(basis.radial, basis.up);
        expectVectorClose(cross, basis.normal, 9);
      }
    }
  });

  it('names the angle each view sets', () => {
    expect(cutViewForAngle(0)).toBe('closed');
    expect(cutViewForAngle(120.2)).toBe('cutaway');
    expect(cutViewForAngle(180)).toBe('section');
    expect(cutViewForAngle(60)).toBeNull();
  });
});

describe('yawCutFrame', () => {
  it('turns the view axis about the hinge by the angle and keeps the frame orthonormal', () => {
    const { position, localUp } = orbitCamera(0, 0);
    const frame = computeCutFrame(position, localUp, centre, 1);
    const before = frame.view.clone();
    yawCutFrame(frame, THREE.MathUtils.degToRad(20));
    expect(frame.view.angleTo(before)).toBeCloseTo(THREE.MathUtils.degToRad(20), 9);
    expect(Math.abs(frame.view.dot(frame.hinge))).toBeLessThan(1e-9);
    expect(Math.abs(frame.side.dot(frame.hinge))).toBeLessThan(1e-9);
    expect(Math.abs(frame.side.dot(frame.view))).toBeLessThan(1e-9);
    expect(new THREE.Vector3().crossVectors(frame.hinge, frame.view).dot(frame.side)).toBeCloseTo(1, 9);
    // The hinge is untouched and a zero yaw is the identity.
    expectVectorClose(frame.hinge, new THREE.Vector3(0, 1, 0));
    const same = computeCutFrame(position, localUp, centre, 1);
    const copy = same.view.clone();
    yawCutFrame(same, 0);
    expectVectorClose(same.view, copy, 12);
  });
});

describe('wedgeYawForOpening', () => {
  const full = THREE.MathUtils.degToRad(22);
  // The mode's SECTION_YAW_DEG: the floor the taper ends on, not zero.
  const floor = THREE.MathUtils.degToRad(18);

  it('keeps the full yaw up to Cutaway and the floor at Section, tapering smoothly between', () => {
    expect(wedgeYawForOpening(0, full, floor)).toBe(full);
    expect(wedgeYawForOpening(openingAngleDegToRad(45), full, floor)).toBe(full);
    expect(wedgeYawForOpening(openingAngleDegToRad(CUT_VIEW_ANGLE_DEG.cutaway), full, floor)).toBe(full);
    const midTaperDeg = (CUT_VIEW_ANGLE_DEG.cutaway + CUT_VIEW_ANGLE_DEG.section) / 2;
    expect(wedgeYawForOpening(openingAngleDegToRad(midTaperDeg), full, floor)).toBeCloseTo((full + floor) / 2, 12);
    expect(wedgeYawForOpening(openingAngleDegToRad(CUT_VIEW_ANGLE_DEG.section), full, floor)).toBe(floor);
    let previous = full;
    let largestStep = 0;
    for (let deg = 0; deg <= 180; deg += 0.5) {
      const yaw = wedgeYawForOpening(openingAngleDegToRad(deg), full, floor);
      expect(yaw).toBeLessThanOrEqual(previous + 1e-12);
      expect(yaw).toBeGreaterThanOrEqual(floor - 1e-12);
      largestStep = Math.max(largestStep, previous - yaw);
      previous = yaw;
    }
    // Smooth: no half-degree step moves the yaw more than a smoothstep's steepest slope
    // (1.5 over the taper's span) would, so a kink or a jump anywhere fails here.
    const taperSpanDeg = CUT_VIEW_ANGLE_DEG.section - CUT_VIEW_ANGLE_DEG.cutaway;
    expect(largestStep).toBeLessThan((full - floor) * 1.5 * (0.5 / taperSpanDeg) * 1.01);
    // A floor of zero is the old face-on Section, still reachable.
    expect(wedgeYawForOpening(openingAngleDegToRad(CUT_VIEW_ANGLE_DEG.section), full, 0)).toBe(0);
  });

  it('keeps the Section disc off face-on by the floor, turned about the hinge alone', () => {
    const { position, localUp } = orbitCamera(30, 20);
    const plain = computeCutFrame(position, localUp, centre, Math.PI);
    const yawed = computeCutFrame(position, localUp, centre, Math.PI, createCutFrame());
    yawCutFrame(yawed, wedgeYawForOpening(yawed.openingAngle, full, floor));
    expect(yawed.view.angleTo(plain.view)).toBeCloseTo(floor, 9);
    // Turned about the hinge and nothing else: the hinge is where it was, so the
    // disc keeps its full radius along the screen-vertical and loses cos(floor)
    // across it — which is what a pixel read of the disc has to allow for.
    expectVectorClose(yawed.hinge, plain.hinge, 12);
    expect(yawed.view.dot(plain.hinge)).toBeCloseTo(0, 12);
    const faceA = cutFaceBasis(yawed, 'a');
    // The disc's normal is the yawed view, not the line of sight.
    expectVectorClose(faceA.normal, yawed.view, 12);
    expect(faceA.normal.angleTo(plain.view)).toBeCloseTo(floor, 9);
    // Its radial still spans the screen, tilted out of it by the floor.
    expect(Math.abs(faceA.radial.dot(plain.view))).toBeCloseTo(Math.sin(floor), 9);
    // At Cutaway the same camera gets the full yaw.
    const cutaway = computeCutFrame(position, localUp, centre, Math.PI / 2, createCutFrame());
    const before = cutaway.view.clone();
    yawCutFrame(cutaway, wedgeYawForOpening(cutaway.openingAngle, full, floor));
    expect(cutaway.view.angleTo(before)).toBeCloseTo(full, 9);
  });
});

describe('wedgeAngle', () => {
  it('measures in the plane the wedge opens in and ignores the hinge component', () => {
    const { position, localUp } = orbitCamera(0, 0);
    const frame = computeCutFrame(position, localUp, centre, 1);
    expect(wedgeAngle(frame, new THREE.Vector3(0, 0, 1))).toBeCloseTo(0, 12);
    expect(wedgeAngle(frame, new THREE.Vector3(0, 0.9, 1))).toBeCloseTo(0, 12);
    expect(wedgeAngle(frame, new THREE.Vector3(1, 0, 0))).toBeCloseTo(Math.PI / 2, 12);
    expect(wedgeAngle(frame, new THREE.Vector3(-1, 0, 0))).toBeCloseTo(Math.PI / 2, 12);
    expect(wedgeAngle(frame, new THREE.Vector3(0, 0, -1))).toBeCloseTo(Math.PI, 12);
  });

  it('varies continuously with the opening angle: a fixed point flips exactly once', () => {
    const { position, localUp } = orbitCamera(0, 0);
    const point = new THREE.Vector3(Math.sin(0.6), 0.2, Math.cos(0.6));
    let flips = 0;
    let previous = false;
    for (let deg = 0; deg <= 180; deg += 0.5) {
      const frame = computeCutFrame(position, localUp, centre, openingAngleDegToRad(deg));
      const inside = insideWedge(frame, point);
      if (inside !== previous) flips++;
      previous = inside;
    }
    expect(flips).toBe(1);
  });
});
