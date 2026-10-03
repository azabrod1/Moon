import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { horizonDip, mirrorPointOnSphere } from './horizonPose';

const AU_KM = 149_597_870.7;
const R = 6371 / AU_KM;

/** A body one AU from the Sun (at the origin), the stand point where the Sun
 *  stands `sunElevDeg` above the horizon, the camera `altitudeKm` above it. */
function rig(sunElevDeg: number, altitudeKm: number) {
  const body = new THREE.Vector3(0.3, 0.2, -0.93).normalize();
  const subsolar = body.clone().negate().normalize();
  const east = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), subsolar).normalize();
  const zenith = THREE.MathUtils.degToRad(90 - sunElevDeg);
  const up = subsolar.clone().multiplyScalar(Math.cos(zenith)).addScaledVector(east, Math.sin(zenith)).normalize();
  const camera = body.clone().addScaledVector(up, R + altitudeKm / AU_KM);
  const sunAtCamera = camera.clone().negate().normalize();
  const sunAzimuth = sunAtCamera.clone().addScaledVector(up, -sunAtCamera.dot(up)).normalize();
  return { body, camera, up, sunAzimuth, sun: new THREE.Vector3(0, 0, 0) };
}

describe('horizonDip', () => {
  it('is the ISS astronaut\'s 19.8 degrees at 400 km and zero on the ground', () => {
    expect(THREE.MathUtils.radToDeg(horizonDip(6371, 400))).toBeCloseTo(19.79, 1);
    expect(horizonDip(6371, 0)).toBe(0);
  });
});

describe('mirrorPointOnSphere', () => {
  it('finds the point whose normal bisects the Sun and the camera', () => {
    const { body, camera, up, sunAzimuth, sun } = rig(10, 400);
    const m = mirrorPointOnSphere(body, R, camera, up, sunAzimuth, sun);
    expect(m).not.toBeNull();
    const normal = m!.point.clone().sub(body).normalize();
    const toSun = sun.clone().sub(m!.point).normalize();
    const toCamera = camera.clone().sub(m!.point).normalize();
    expect(Math.abs(normal.dot(toSun) - normal.dot(toCamera))).toBeLessThan(1e-9);
    // Where the Sun's elevation at the point equals the camera's: a 10 degree
    // Sun from 400 km puts it about 8.4 degrees along the ground, where the
    // Sun stands 18.4 degrees high and the camera 1000 km away, seen 27
    // degrees below the horizontal — inside the horizon's 19.8 degree dip.
    const dip = horizonDip(R, 400 / AU_KM);
    expect(THREE.MathUtils.radToDeg(m!.groundAngle)).toBeGreaterThan(7);
    expect(THREE.MathUtils.radToDeg(m!.groundAngle)).toBeLessThan(10);
    expect(m!.depression).toBeGreaterThan(dip);
    expect(THREE.MathUtils.radToDeg(m!.depression)).toBeLessThan(30);
    expect(THREE.MathUtils.radToDeg(m!.sunElevation)).toBeGreaterThan(17);
    expect(THREE.MathUtils.radToDeg(m!.sunElevation)).toBeLessThan(20);
    expect(m!.slant * AU_KM).toBeGreaterThan(900);
    expect(m!.slant * AU_KM).toBeLessThan(1100);
  });

  it('sits under the camera when the Sun is overhead, and is absent when the Sun is below the horizon', () => {
    const over = rig(89.9, 400);
    const m = mirrorPointOnSphere(over.body, R, over.camera, over.up, over.sunAzimuth, over.sun);
    expect(m).not.toBeNull();
    expect(THREE.MathUtils.radToDeg(m!.groundAngle)).toBeLessThan(0.05);
    expect(THREE.MathUtils.radToDeg(m!.depression)).toBeGreaterThan(89.5);
    // From 400 km the horizon is 19.8 degrees along the ground: with the Sun
    // 25 degrees below the stand point's horizon it is below the horizon
    // point's too, and the view holds no glint.
    const night = rig(-25, 400);
    expect(mirrorPointOnSphere(night.body, R, night.camera, night.up, night.sunAzimuth, night.sun)).toBeNull();
  });

  it('moves toward the horizon as the camera climbs, the geostationary view aside', () => {
    const low = rig(10, 400);
    const high = rig(10, 2000);
    const a = mirrorPointOnSphere(low.body, R, low.camera, low.up, low.sunAzimuth, low.sun)!;
    const b = mirrorPointOnSphere(high.body, R, high.camera, high.up, high.sunAzimuth, high.sun)!;
    expect(b.groundAngle).toBeGreaterThan(a.groundAngle);
    // From far away the camera's direction is the sub-point's own vertical
    // everywhere, so the mirror normal lies half the Sun's zenith angle over:
    // 15 degrees for a Sun 60 degrees high. From 35 786 km the camera's
    // parallax pulls it about a degree back toward the sub-point.
    const geo = rig(60, 35786);
    const g = mirrorPointOnSphere(geo.body, R, geo.camera, geo.up, geo.sunAzimuth, geo.sun)!;
    expect(THREE.MathUtils.radToDeg(g.groundAngle)).toBeGreaterThan(13);
    expect(THREE.MathUtils.radToDeg(g.groundAngle)).toBeLessThan(15);
  });
});
