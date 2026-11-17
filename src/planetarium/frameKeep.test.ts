import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applyDesignFov } from '../shared/math/lensProjection';
import { DEG2RAD } from '../shared/math/angles';
import { projectSphereToScreen } from '../shared/three/projectToScreen';
import {
  FRAME_KEEP_FADE_END_RAD,
  FRAME_KEEP_FADE_START_RAD,
  FRAME_KEEP_MARGIN,
  discFitsFrame,
  frameKeepAngle,
  type FrameKeepView,
} from './frameKeep';

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };
const view = (size: { width: number; height: number }, lensStrength = 1): FrameKeepView => ({
  designFovDeg: 60,
  aspect: size.width / size.height,
  lensStrength,
});

const AIM = new THREE.Vector3(0, 0, -1);
const UP = new THREE.Vector3(0, 1, 0);
const RIGHT = new THREE.Vector3(1, 0, 0);

/** Unit direction `rightDeg` to the right of and `upDeg` above the aim. */
function offAim(rightDeg: number, upDeg: number): THREE.Vector3 {
  return AIM.clone()
    .addScaledVector(RIGHT, Math.tan(rightDeg * DEG2RAD))
    .addScaledVector(UP, Math.tan(upDeg * DEG2RAD))
    .normalize();
}

function turned(aim: THREE.Vector3, body: THREE.Vector3, angle: number): THREE.Vector3 {
  const perp = body.clone().addScaledVector(aim, -aim.dot(body)).normalize();
  return aim.clone().multiplyScalar(Math.cos(angle)).addScaledVector(perp, Math.sin(angle));
}

/** The renderer's own measurement of a sphere seen along `aim`: a lens camera
 *  at the origin, rolled by `UP` as the chase rig's lookAt rolls it. */
function measureDisc(
  size: { width: number; height: number },
  aim: THREE.Vector3,
  body: THREE.Vector3,
  discRadiusRad: number,
  lensStrength = 1,
) {
  const camera = new THREE.PerspectiveCamera(60, size.width / size.height, 1e-3, 1e4);
  camera.userData.lens = { strength: lensStrength, designFovDeg: 60 };
  applyDesignFov(camera, 60);
  camera.up.copy(UP);
  camera.position.set(0, 0, 0);
  camera.lookAt(aim.clone().multiplyScalar(10));
  camera.updateMatrixWorld(true);
  const distance = 100;
  return projectSphereToScreen(
    body.clone().multiplyScalar(distance),
    distance * Math.sin(discRadiusRad),
    camera,
    size.width,
    size.height,
  );
}

const marginPx = (size: { height: number }) => FRAME_KEEP_MARGIN * (size.height / 2);

describe('frameKeepAngle', () => {
  it('is exactly zero wherever the disc already fits', () => {
    // A ringless planet's arrival as the chase frames it on a phone: centred
    // across, a little above the axis.
    expect(frameKeepAngle(AIM, offAim(0, 7.8), 6.5 * DEG2RAD, UP, view(PHONE))).toBe(0);
    // A big moon's arrival on a phone: a third across, high in the frame.
    expect(frameKeepAngle(AIM, offAim(4.5, 19.3), 2.5 * DEG2RAD, UP, view(PHONE))).toBe(0);
    // Uranus's sideways arrival on a desktop window: room to spare.
    expect(frameKeepAngle(AIM, offAim(-10.9, 15.6), 6.5 * DEG2RAD, UP, view(DESKTOP))).toBe(0);
    // Deimos's widest sideways arrival on a desktop window.
    expect(frameKeepAngle(AIM, offAim(14.5, 13.4), 3.2 * DEG2RAD, UP, view(DESKTOP))).toBe(0);
  });

  it('turns a sideways destination on a phone just far enough to fit, no further', () => {
    const body = offAim(-10.9, 15.6); // Uranus, as measured on 2026-11-17
    const rho = 6.5 * DEG2RAD;
    expect(discFitsFrame(AIM, body, rho, UP, view(PHONE))).toBe(false);
    const keep = frameKeepAngle(AIM, body, rho, UP, view(PHONE));
    const offAxis = AIM.angleTo(body);
    expect(keep).toBeGreaterThan(0);
    expect(keep).toBeLessThan(offAxis); // fitted, not centred
    expect(discFitsFrame(turned(AIM, body, keep), body, rho, UP, view(PHONE))).toBe(true);
    expect(discFitsFrame(turned(AIM, body, keep - 0.05 * DEG2RAD), body, rho, UP, view(PHONE))).toBe(false);
  });

  it('agrees with the renderer: the kept disc touches the inset edge and stays inside it', () => {
    const cases = [
      { body: offAim(-10.9, 15.6), radiusDeg: 6.5 }, // Uranus: left edge
      { body: offAim(7.1, 10.2), radiusDeg: 6.5 }, // Neptune: right edge
      { body: offAim(14.5, 13.4), radiusDeg: 3.2 }, // Deimos: right edge
      { body: offAim(-11.5, 21.7), radiusDeg: 3.0 }, // Phobos: left edge, high
    ];
    for (const { body, radiusDeg } of cases) {
      const rho = radiusDeg * DEG2RAD;
      const keep = frameKeepAngle(AIM, body, rho, UP, view(PHONE));
      expect(keep).toBeGreaterThan(0);
      const disc = measureDisc(PHONE, turned(AIM, body, keep), body, rho);
      expect(disc.footprintKind).toBe('sampled'); // a real limb measurement, not a fallback
      const inset = marginPx(PHONE);
      // Inside the inset frame on every side (half a pixel for the sampled limb).
      expect(disc.minX).toBeGreaterThanOrEqual(inset - 0.5);
      expect(disc.maxX).toBeLessThanOrEqual(PHONE.width - inset + 0.5);
      expect(disc.minY).toBeGreaterThanOrEqual(inset - 0.5);
      expect(disc.maxY).toBeLessThanOrEqual(PHONE.height - inset + 0.5);
      // And no further in than it needs: the nearer side edge is touched.
      const gap = Math.min(disc.minX - inset, PHONE.width - inset - disc.maxX);
      expect(gap).toBeLessThan(1);
    }
  });

  it('stays conservative under a reduced lens strength', () => {
    const body = offAim(-10.9, 15.6);
    const rho = 6.5 * DEG2RAD;
    for (const strength of [0, 0.5]) {
      const keep = frameKeepAngle(AIM, body, rho, UP, view(PHONE, strength));
      const disc = measureDisc(PHONE, turned(AIM, body, keep), body, rho, strength);
      expect(disc.minX).toBeGreaterThanOrEqual(marginPx(PHONE) - 0.5);
      expect(disc.maxX).toBeLessThanOrEqual(PHONE.width - marginPx(PHONE) + 0.5);
    }
  });

  it('holds a disc wider than the frame across it, edge to edge, without centring it', () => {
    const body = offAim(12, 0);
    const rho = 20 * DEG2RAD;
    const keep = frameKeepAngle(AIM, body, rho, UP, view(PHONE));
    expect(keep).toBeGreaterThan(0);
    expect(keep).toBeLessThan(AIM.angleTo(body));
    const disc = measureDisc(PHONE, turned(AIM, body, keep), body, rho);
    const inset = marginPx(PHONE);
    expect(disc.minX).toBeLessThanOrEqual(inset + 0.5);
    expect(disc.maxX).toBeGreaterThanOrEqual(PHONE.width - inset - 0.5);
    // No further than it needs: the trailing limb sits on the inset edge. The
    // measurement pads its sampled limb outward (~0.8 px on this disc), which
    // here counts against the gap, so the bar is 2 px.
    expect(Math.min(inset - disc.minX, disc.maxX - (PHONE.width - inset))).toBeLessThan(2);
  });

  it('needs no turn for a ringless planet that outgrows a phone\'s width, centred across', () => {
    // Mars late in its approach: wider than the phone, centred left to right,
    // a little above the axis — framed as it is.
    for (const radiusDeg of [12.5, 14, 18, 24]) {
      expect(frameKeepAngle(AIM, offAim(0, 4), radiusDeg * DEG2RAD, UP, view(PHONE))).toBe(0);
    }
  });

  it('turns continuously as an approaching disc outgrows the frame', () => {
    // Fitting and covering meet where the disc is exactly as wide as the
    // inset, so the turn has no step there.
    const body = offAim(9, 2);
    let previous = frameKeepAngle(AIM, body, 9 * DEG2RAD, UP, view(PHONE));
    for (let radiusDeg = 9.02; radiusDeg <= 16; radiusDeg += 0.02) {
      const keep = frameKeepAngle(AIM, body, radiusDeg * DEG2RAD, UP, view(PHONE));
      expect(Math.abs(keep - previous)).toBeLessThan(0.05 * DEG2RAD);
      previous = keep;
    }
  });

  it('never swings the camera round to a body far off the aim', () => {
    const rho = 40 * DEG2RAD; // far from framed: un-faded, the answer is a large turn
    const beside = turned(AIM, RIGHT, FRAME_KEEP_FADE_END_RAD + 0.01);
    expect(frameKeepAngle(AIM, beside, rho, UP, view(PHONE))).toBe(0);
    const behind = AIM.clone().negate();
    expect(frameKeepAngle(AIM, behind, rho, UP, view(PHONE))).toBe(0);
    const midFade = (FRAME_KEEP_FADE_START_RAD + FRAME_KEEP_FADE_END_RAD) / 2;
    const fading = frameKeepAngle(AIM, turned(AIM, RIGHT, midFade), rho, UP, view(PHONE));
    expect(fading).toBeGreaterThan(0);
    expect(fading).toBeLessThan(midFade);
  });

  it('stays finite when aimed along the up axis, where the roll is undefined', () => {
    const keep = frameKeepAngle(UP, turned(UP, RIGHT, 20 * DEG2RAD), 6 * DEG2RAD, UP, view(PHONE));
    expect(Number.isFinite(keep)).toBe(true);
  });

  it('is zero for a degenerate frame or a body on the axis', () => {
    expect(frameKeepAngle(AIM, offAim(30, 0), 0.1, UP, { designFovDeg: 0, aspect: 1, lensStrength: 1 })).toBe(0);
    expect(frameKeepAngle(AIM, AIM, 0.1, UP, view(PHONE))).toBe(0);
  });
});
