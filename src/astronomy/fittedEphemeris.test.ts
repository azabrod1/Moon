/**
 * The shipped ephemeris against JPL Horizons: ephemeris.goldens.json holds
 * Horizons vectors (DE441, geometric, ICRF, km) at instants off every fit
 * grid, fetched by gen-ephemeris.mjs alongside the samples it fits — never
 * values computed here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import goldens from './ephemeris.goldens.json';
import {
  EARTH_MOON_MASS_RATIO,
  fittedPositionKm,
  fittedWindowJd,
  parseFittedEphemeris,
  setFittedEphemeris,
} from './fittedEphemeris';
import { installFittedEphemerisFromDisk } from './fittedEphemerisTestFile';

type GoldenRow = [number, number, number, number];
const bodies = goldens.bodies as unknown as Record<string, { rows: GoldenRow[] }>;
const targetsKm = goldens.provenance.targetsKm as Record<string, number>;

describe('the shipped ephemeris', () => {
  beforeAll(() => installFittedEphemerisFromDisk());

  it.each(Object.keys(targetsKm))('%s matches Horizons off the fit grid', (name) => {
    const position = new THREE.Vector3();
    for (const [jdTdb, x, y, z] of bodies[name].rows) {
      expect(fittedPositionKm(name, jdTdb, position), `JD ${jdTdb}`).toBe(true);
      const errorKm = position.distanceTo(new THREE.Vector3(x, y, z));
      expect(errorKm, `${name} at JD ${jdTdb}`).toBeLessThan(targetsKm[name]);
    }
  });

  it("derives Earth's centre from the barycentre and the Moon", () => {
    const barycenter = new THREE.Vector3();
    const moon = new THREE.Vector3();
    for (const [jdTdb, x, y, z] of bodies.Earth.rows) {
      fittedPositionKm('EarthMoonBarycenter', jdTdb, barycenter);
      fittedPositionKm('Moon', jdTdb, moon);
      const earth = barycenter.clone().addScaledVector(moon, -1 / (1 + EARTH_MOON_MASS_RATIO));
      expect(earth.distanceTo(new THREE.Vector3(x, y, z)), `JD ${jdTdb}`).toBeLessThan(targetsKm.EarthMoonBarycenter);
    }
  });

  it('never steps where intervals meet', () => {
    // Each side is extrapolated linearly to the join from two samples on its
    // own side, which takes the body's motion out; what is left is the step.
    const near = new THREE.Vector3();
    const far = new THREE.Vector3();
    const epsilonDays = 1e-6;
    const sideValue = (name: string, joinJd: number, direction: number) => {
      fittedPositionKm(name, joinJd + direction * epsilonDays, near);
      fittedPositionKm(name, joinJd + 2 * direction * epsilonDays, far);
      return near.clone().multiplyScalar(2).sub(far);
    };
    for (const name of Object.keys(targetsKm)) {
      const window = fittedWindowJd(name)!;
      const series = installFittedEphemerisFromDisk().get(name)!;
      for (let interval = 1; interval < series.intervalCount; interval += 97) {
        const joinJd = window.startJd + interval * series.intervalDays;
        const step = sideValue(name, joinJd, -1).distanceTo(sideValue(name, joinJd, 1));
        expect(step, `${name} at JD ${joinJd}`).toBeLessThan(0.01);
      }
    }
  });

  it('answers nothing outside its window', () => {
    const window = fittedWindowJd('Moon')!;
    const position = new THREE.Vector3(1, 2, 3);
    expect(fittedPositionKm('Moon', window.startJd - 1, position)).toBe(false);
    expect(fittedPositionKm('Moon', window.endJd + 1, position)).toBe(false);
    expect(position.toArray()).toEqual([1, 2, 3]);
  });
});

describe('parseFittedEphemeris', () => {
  afterAll(() => installFittedEphemerisFromDisk());

  it('refuses a truncated file rather than installing a shorter ephemeris', () => {
    const shipped = installFittedEphemerisFromDisk();
    expect(shipped.size).toBe(10);
    const bytes = new Uint8Array(1024);
    bytes.set(new TextEncoder().encode('MEPH'), 0);
    new DataView(bytes.buffer).setUint16(4, 1, true);
    new DataView(bytes.buffer).setUint16(6, 3, true);
    expect(() => parseFittedEphemeris(bytes.buffer)).toThrow();
    expect(() => parseFittedEphemeris(new ArrayBuffer(4))).toThrow(/magic/);
  });

  it('answers nothing before a file is installed', () => {
    setFittedEphemeris(null);
    expect(fittedPositionKm('Moon', 2460000.5, new THREE.Vector3())).toBe(false);
  });
});
