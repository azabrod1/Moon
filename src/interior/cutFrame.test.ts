import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  CUT_VIEW_ANGLE_DEG,
  anchorCutFrame,
  blendCutFrames,
  computeCutFrame,
  createCutAnchor,
  createCutFrame,
  cutFaceBasis,
  cutViewForAngle,
  frameFromAnchor,
  frameQuaternion,
  insideWedge,
  openingAngleDegToRad,
  wedgeAngle,
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
    // Each face plane sits half the opening off the view axis (45° at the 90° quarter wedge),
    // so its normal sits the complement, (π − θ)/2, off the axis: 45° again.
    expect(CUT_VIEW_ANGLE_DEG.cutaway).toBe(90);
    const normalOffView = (Math.PI - openingAngleDegToRad(CUT_VIEW_ANGLE_DEG.cutaway)) / 2;
    expect(normalOffView).toBeCloseTo(Math.PI / 4, 12);
    expect(faceA.normal.angleTo(view)).toBeCloseTo(normalOffView, 9);
    expect(faceB.normal.angleTo(view)).toBeCloseTo(normalOffView, 9);
    expect(faceA.normal.dot(faceA.radial)).toBeCloseTo(0, 9);
    expect(faceB.normal.dot(faceB.radial)).toBeCloseTo(0, 9);
    // The normals face the viewer, and each points away from its own side.
    expect(faceA.normal.dot(view)).toBeGreaterThan(0);
    expect(faceA.normal.dot(side)).toBeLessThan(0);
    expect(faceB.normal.dot(side)).toBeGreaterThan(0);
    // A point on the view axis is removed, one 40° round with it; one 60° round is kept.
    expect(insideWedge(frame, new THREE.Vector3(0, 0, 1))).toBe(true);
    expect(insideWedge(frame, new THREE.Vector3(Math.sin(0.7), 0, Math.cos(0.7)))).toBe(true);
    expect(insideWedge(frame, new THREE.Vector3(Math.sin(1.05), 0, Math.cos(1.05)))).toBe(false);
    // The quarter wedge reaches the centre: both faces run from the hinge to the rim, so
    // every layer shows on each of them — there is nothing stepped for a deeper layer.
    expect(faceA.radial.length()).toBeCloseTo(1, 12);
    expect(faceB.radial.length()).toBeCloseTo(1, 12);
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
    expect(cutViewForAngle(90.2)).toBe('cutaway');
    expect(cutViewForAngle(120)).toBeNull();
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

describe('the yaw at Section', () => {
  const yaw = THREE.MathUtils.degToRad(20);

  it('keeps the Section disc off face-on by the yaw, turned about the hinge alone', () => {
    const { position, localUp } = orbitCamera(30, 20);
    const plain = computeCutFrame(position, localUp, centre, Math.PI);
    const yawed = computeCutFrame(position, localUp, centre, Math.PI, createCutFrame());
    yawCutFrame(yawed, yaw);
    expect(yawed.view.angleTo(plain.view)).toBeCloseTo(yaw, 9);
    // Turned about the hinge and nothing else: the hinge is where it was, so the
    // disc keeps its full radius along the screen-vertical and loses cos(yaw)
    // across it — which is what a pixel read of the disc has to allow for.
    expectVectorClose(yawed.hinge, plain.hinge, 12);
    expect(yawed.view.dot(plain.hinge)).toBeCloseTo(0, 12);
    const faceA = cutFaceBasis(yawed, 'a');
    // The disc's normal is the yawed view, not the line of sight.
    expectVectorClose(faceA.normal, yawed.view, 12);
    expect(faceA.normal.angleTo(plain.view)).toBeCloseTo(yaw, 9);
    // Its radial still spans the screen, tilted out of it by the yaw.
    expect(Math.abs(faceA.radial.dot(plain.view))).toBeCloseTo(Math.sin(yaw), 9);
  });

  it('at Cutaway turns one face toward the camera and the other away by the same yaw', () => {
    const { position, localUp } = orbitCamera(30, 20);
    const lineOfSight = position.clone().normalize();
    const frame = computeCutFrame(position, localUp, centre, Math.PI / 2, createCutFrame());
    yawCutFrame(frame, yaw);
    const faceA = cutFaceBasis(frame, 'a');
    const faceB = cutFaceBasis(frame, 'b');
    // normal · line of sight = sin(θ/2 ± yaw): face A 25° off face-on, face B 65° off.
    expect(faceA.normal.dot(lineOfSight)).toBeCloseTo(Math.sin(Math.PI / 4 + yaw), 9);
    expect(faceB.normal.dot(lineOfSight)).toBeCloseTo(Math.sin(Math.PI / 4 - yaw), 9);
  });
});

describe('the body lock', () => {
  const pose = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, -1.1, 0.25));

  it('gives a frame back through its anchor under the same pose', () => {
    const { position, localUp } = orbitCamera(-28, 16);
    const chosen = computeCutFrame(position, localUp, centre, Math.PI / 2, createCutFrame());
    yawCutFrame(chosen, THREE.MathUtils.degToRad(20));
    const anchor = anchorCutFrame(chosen, pose, createCutAnchor());
    const rebuilt = frameFromAnchor(anchor, pose, chosen.openingAngle, createCutFrame());
    expectVectorClose(rebuilt.view, chosen.view, 12);
    expectVectorClose(rebuilt.hinge, chosen.hinge, 12);
    expectVectorClose(rebuilt.side, chosen.side, 12);
    expect(rebuilt.openingAngle).toBe(chosen.openingAngle);
    // The anchor is in the body's coordinates: with the identity pose it IS the world frame.
    const identityAnchor = anchorCutFrame(chosen, new THREE.Quaternion(), createCutAnchor());
    expectVectorClose(identityAnchor.view, chosen.view, 12);
    expectVectorClose(identityAnchor.hinge, chosen.hinge, 12);
  });

  it('turns with the body: a pose change carries the cut with the material, and a camera move does not', () => {
    const { position, localUp } = orbitCamera(-28, 16);
    const chosen = computeCutFrame(position, localUp, centre, Math.PI / 2, createCutFrame());
    const anchor = anchorCutFrame(chosen, pose, createCutAnchor());
    const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.7);
    const turnedPose = turn.clone().multiply(pose);
    const turned = frameFromAnchor(anchor, turnedPose, chosen.openingAngle, createCutFrame());
    expectVectorClose(turned.view, chosen.view.clone().applyQuaternion(turn), 12);
    expectVectorClose(turned.hinge, chosen.hinge.clone().applyQuaternion(turn), 12);
    expectVectorClose(turned.side, chosen.side.clone().applyQuaternion(turn), 12);
    // Nothing in the rebuilt frame reads the camera: the same anchor and pose give the
    // same frame whatever the camera does, which is the whole point of the lock.
    const elsewhere = frameFromAnchor(anchor, pose, Math.PI, createCutFrame());
    expectVectorClose(elsewhere.view, chosen.view, 12);
    expect(elsewhere.openingAngle).toBe(Math.PI);
  });

  it('rebuilds an orthonormal frame from an anchor that rounding has sheared', () => {
    const anchor = createCutAnchor();
    anchor.view.set(0.3, 0.2, 0.9).normalize();
    anchor.hinge.set(0.01, 1, 0.05); // neither unit nor perpendicular
    const frame = frameFromAnchor(anchor, pose, 1.2, createCutFrame());
    expect(frame.view.length()).toBeCloseTo(1, 12);
    expect(frame.hinge.length()).toBeCloseTo(1, 12);
    expect(frame.side.length()).toBeCloseTo(1, 12);
    expect(frame.view.dot(frame.hinge)).toBeCloseTo(0, 12);
    expect(frame.view.dot(frame.side)).toBeCloseTo(0, 12);
    expect(frame.hinge.dot(frame.side)).toBeCloseTo(0, 12);
    expectVectorClose(new THREE.Vector3().crossVectors(frame.hinge, frame.view), frame.side, 12);
  });

  it('blends two frames along the shortest arc, orthonormal throughout, at the destination\'s opening', () => {
    const from = computeCutFrame(orbitCamera(-28, 16).position, orbitCamera(-28, 16).localUp, centre, Math.PI / 2, createCutFrame());
    const to = computeCutFrame(orbitCamera(50, -10).position, orbitCamera(50, -10).localUp, centre, Math.PI, createCutFrame());
    const atStart = blendCutFrames(from, to, 0, createCutFrame());
    expectVectorClose(atStart.view, from.view, 9);
    expectVectorClose(atStart.hinge, from.hinge, 9);
    expect(atStart.openingAngle).toBe(Math.PI);
    const atEnd = blendCutFrames(from, to, 1, createCutFrame());
    expectVectorClose(atEnd.view, to.view, 9);
    expectVectorClose(atEnd.side, to.side, 9);
    const whole = frameQuaternion(from).angleTo(frameQuaternion(to));
    let previous = 0;
    for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const blended = blendCutFrames(from, to, t, createCutFrame());
      expect(blended.view.dot(blended.hinge)).toBeCloseTo(0, 9);
      expect(blended.hinge.dot(blended.side)).toBeCloseTo(0, 9);
      expectVectorClose(new THREE.Vector3().crossVectors(blended.hinge, blended.view), blended.side, 9);
      // A slerp: the rotation from the start grows in proportion to t.
      const travelled = frameQuaternion(from).angleTo(frameQuaternion(blended));
      expect(travelled).toBeCloseTo(whole * t, 6);
      expect(travelled).toBeGreaterThan(previous);
      previous = travelled;
    }
    // Clamped: nothing overshoots.
    expectVectorClose(blendCutFrames(from, to, 1.5, createCutFrame()).view, to.view, 9);
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
