/**
 * The two paths every other suite skips, since they all run on the shipped
 * ephemeris: a session whose file never arrived (the loader gives up and the
 * analytic models answer), and the edges of the fitted window, where the
 * positions ease from one source to the other.
 */
import { afterAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { computeBodyPositionAU, computeMoonGeocentricEquatorialAU, ttJDFromUtcMs } from './planetary';
import { FITTED_BLEND_DAYS, fittedPositionKm, fittedWindowJd, setFittedEphemeris } from './fittedEphemeris';
import { installFittedEphemerisFromDisk } from './fittedEphemerisTestFile';
import { findShadowEvent } from './shadows';
import { KM_PER_AU } from './constants';
import { PLANETARIUM_BODIES } from '../planetarium/planets/planetData';

const MS_PER_DAY = 86_400_000;

afterAll(() => installFittedEphemerisFromDisk());

describe('without the ephemeris file', () => {
  it('still places every body, and still finds the 2026-08-12 eclipse', () => {
    setFittedEphemeris(null);
    const utcMs = Date.UTC(2026, 10, 17);
    for (const body of PLANETARIUM_BODIES) {
      const position = computeBodyPositionAU(body, utcMs);
      expect(Number.isFinite(position.length()), body.name).toBe(true);
      // Within a few per cent of the body's catalog distance from the Sun.
      expect(Math.abs(position.length() / body.semiMajorAxisAU - 1), body.name).toBeLessThan(0.3);
    }
    const event = findShadowEvent(
      { kind: 'shadow-transit', parentPlanet: 'Earth', moonName: 'Moon' },
      Date.parse('2026-07-01T00:00:00Z'),
      1,
    );
    // The analytic Moon puts it within a couple of minutes (EclipseWise TD
    // 17:47:06 less 69 s).
    expect(Math.abs(event!.peakUtcMs - Date.parse('2026-08-12T17:45:57Z'))).toBeLessThan(2 * 60_000);
    installFittedEphemerisFromDisk();
  });
});

describe('the edges of the fitted window', () => {
  installFittedEphemerisFromDisk();
  const window = fittedWindowJd('Moon')!;
  const jdToUtcMs = (jdTT: number) => {
    let utcMs = (jdTT - 2440587.5) * MS_PER_DAY;
    for (let iteration = 0; iteration < 3; iteration++) utcMs += (jdTT - ttJDFromUtcMs(utcMs)) * MS_PER_DAY;
    return utcMs;
  };
  // Both ends of each ease: where it starts and where it reaches the analytic model.
  const edgesJd = [
    window.startJd,
    window.startJd + FITTED_BLEND_DAYS,
    window.endJd - FITTED_BLEND_DAYS,
    window.endJd,
  ];

  /** The step at an instant once the motion is taken out: each side is
   *  extrapolated linearly from two samples on its own side. */
  function stepKm(position: (utcMs: number, out: THREE.Vector3) => THREE.Vector3, edgeUtcMs: number): number {
    const epsilonMs = 1_000;
    const side = (direction: number) => {
      const near = position(edgeUtcMs + direction * epsilonMs, new THREE.Vector3());
      const far = position(edgeUtcMs + 2 * direction * epsilonMs, new THREE.Vector3());
      return near.multiplyScalar(2).sub(far);
    };
    return side(-1).distanceTo(side(1)) * KM_PER_AU;
  }

  it.each(edgesJd)('never steps a body at JD %d', (edgeJd) => {
    const edgeUtcMs = jdToUtcMs(edgeJd);
    for (const body of PLANETARIUM_BODIES) {
      expect(stepKm((utcMs, out) => computeBodyPositionAU(body, utcMs, out), edgeUtcMs), body.name).toBeLessThan(0.05);
    }
    expect(
      stepKm((utcMs, out) => computeMoonGeocentricEquatorialAU(ttJDFromUtcMs(utcMs), out), edgeUtcMs),
      'Moon',
    ).toBeLessThan(0.05);
  });

  it('hands over gradually: half way through the ease, half way between the two', () => {
    const middleUtcMs = jdToUtcMs(window.endJd - FITTED_BLEND_DAYS / 2);
    const jupiter = PLANETARIUM_BODIES.find((body) => body.name === 'Jupiter')!;
    const blended = computeBodyPositionAU(jupiter, middleUtcMs);
    const fittedKm = new THREE.Vector3();
    expect(fittedPositionKm('Jupiter', ttJDFromUtcMs(middleUtcMs), fittedKm)).toBe(true);
    // ICRF km into the scene's frame, as planetary.ts maps it.
    const fitted = new THREE.Vector3(fittedKm.x, fittedKm.z, -fittedKm.y).divideScalar(KM_PER_AU);
    setFittedEphemeris(null);
    const analytic = computeBodyPositionAU(jupiter, middleUtcMs);
    installFittedEphemerisFromDisk();
    // The two differ by thousands of km here, so the check has teeth.
    expect(fitted.distanceTo(analytic) * KM_PER_AU).toBeGreaterThan(1_000);
    const halfWay = fitted.clone().add(analytic).multiplyScalar(0.5);
    expect(blended.distanceTo(halfWay) * KM_PER_AU).toBeLessThan(0.01);
  });
});
