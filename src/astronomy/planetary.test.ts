/**
 * Frame-convention and consistency tests for the Kepler planet model.
 *
 * Scene ecliptic frame (locked by these tests): +X at ecliptic longitude 0°
 * (vernal equinox), +Y at the north ecliptic pole, longitude increasing
 * toward +Z — the same sense raDecToVector uses for the star sphere
 * (RA 90° = +Z), so a body and its sky backdrop agree.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  advancePlanetariumTime,
  computeBodyState,
  computeMoonGeocentricEquatorialAU,
  computePlanetPositionEcliptic,
  eclipticToEquatorial,
  formatTimeRateLabel,
  formatUtcInputValue,
  parseUtcInputValue,
  raDecToVector,
  ttJDFromUtcMs,
} from './planetary';
import { dateToJD, findEvent, sunPosition } from './ephemeris';
import { accumulatedPrecessionLonDeg } from './precession';
import { getStandishElements, type KeplerElements } from './standish';
import { DEG, J2000, OBLIQUITY_DEG, RAD } from './constants';
import { PLANETARIUM_BODIES, PLANETS } from '../planetarium/planets/planetData';

function norm360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

function norm180(deg: number): number {
  const v = norm360(deg);
  return v > 180 ? v - 360 : v;
}

/**
 * Textbook heliocentric ecliptic position from Kepler elements (Meeus ch. 33 /
 * standard orbital mechanics), mapped into the scene frame. Written
 * independently of planetary.ts so the two implementations check each other —
 * its job is pinning the scene-frame rotations, independent of where the
 * elements came from (both sides consume the same getStandishElements output).
 */
function referenceEclipticPosition(el: KeplerElements): THREE.Vector3 {
  const meanAnomaly = el.meanAnomalyDeg * DEG;
  const e = el.eccentricity;

  let eccentricAnomaly = meanAnomaly;
  for (let i = 0; i < 30; i++) {
    eccentricAnomaly -=
      (eccentricAnomaly - e * Math.sin(eccentricAnomaly) - meanAnomaly) /
      (1 - e * Math.cos(eccentricAnomaly));
  }

  const trueAnomaly = Math.atan2(
    Math.sqrt(1 - e * e) * Math.sin(eccentricAnomaly),
    Math.cos(eccentricAnomaly) - e,
  );
  const radius = el.semiMajorAxisAU * (1 - e * Math.cos(eccentricAnomaly));

  const argPerihelion = (el.lonPerihelionDeg - el.ascendingNodeDeg) * DEG;
  const node = el.ascendingNodeDeg * DEG;
  const inclination = el.inclinationDeg * DEG;
  const argLatitude = argPerihelion + trueAnomaly;

  const xToEquinox =
    radius *
    (Math.cos(node) * Math.cos(argLatitude) -
      Math.sin(node) * Math.sin(argLatitude) * Math.cos(inclination));
  const yToLon90 =
    radius *
    (Math.sin(node) * Math.cos(argLatitude) +
      Math.cos(node) * Math.sin(argLatitude) * Math.cos(inclination));
  const zToNorth = radius * Math.sin(argLatitude) * Math.sin(inclination);

  // Scene frame: north is +Y, longitude increases toward +Z.
  return new THREE.Vector3(xToEquinox, zToNorth, yToLon90);
}

describe('J2000 frame unification (accumulatedPrecessionLonDeg)', () => {
  it('is zero at J2000 and matches p_A at the fixture epochs', () => {
    expect(accumulatedPrecessionLonDeg(J2000)).toBe(0);
    expect(accumulatedPrecessionLonDeg(2461200.5)).toBeCloseTo(0.3693, 3); // 2026-06-09
    expect(accumulatedPrecessionLonDeg(2467900.5)).toBeCloseTo(0.6256, 3); // ~2044
  });

  it('is positive after J2000 (of-date λ exceeds J2000 λ)', () => {
    expect(accumulatedPrecessionLonDeg(J2000 + 36525)).toBeGreaterThan(1.39);
    expect(accumulatedPrecessionLonDeg(J2000 - 36525)).toBeLessThan(-1.39);
  });
});

describe('celestial frame', () => {
  it('puts RA 90° at +Z and the north pole at +Y', () => {
    const ra90 = raDecToVector(90, 0);
    expect(ra90.x).toBeCloseTo(0, 6);
    expect(ra90.z).toBeCloseTo(1, 6);
    expect(raDecToVector(123, 90).y).toBeCloseTo(1, 6);
  });

  it('maps the north ecliptic pole to its real equatorial position (RA 270°, Dec 90°−ε)', () => {
    const pole = eclipticToEquatorial(new THREE.Vector3(0, 1, 0));
    const expected = raDecToVector(270, 90 - OBLIQUITY_DEG);
    expect(pole.angleTo(expected) * RAD).toBeLessThan(1e-4);
  });
});

describe('computePlanetPositionEcliptic', () => {
  const testJDs = [J2000, J2000 + 1234.5, J2000 + 9000];

  for (const planet of PLANETARIUM_BODIES) {
    it(`matches textbook element propagation for ${planet.name}`, () => {
      for (const jd of testJDs) {
        const el = getStandishElements(planet.name, jd);
        const scene = computePlanetPositionEcliptic(el);
        const reference = referenceEclipticPosition(el);
        const separationDeg = scene.angleTo(reference) * RAD;
        expect(separationDeg, `${planet.name} at JD ${jd}`).toBeLessThan(0.01);
      }
    });
  }
});

describe('Standish EMB vs Meeus Sun (cross-model check)', () => {
  // Two independent models of the same body: the Standish EMB elements vs the
  // inverted Meeus Sun, precessed to J2000 exactly like the Earth render seam.
  // Budget for the 0.04° bound: EMB elements quoted 20″ ≈ 0.006°, Meeus ch. 25
  // truncation ~0.01°, aberration −20.5″ + nutation ±18″ ≈ 0.010° (sunPosition
  // is apparent, elements are geometric), EMB-vs-Earth geometry ~0.002°.
  // (The pre-Standish version of this test measured +0.002°…−0.235° — that
  // delta was precession plus element rounding, and both are now gone.)
  const dates = [
    '2000-01-01T12:00:00Z',
    '2010-06-15T00:00:00Z',
    '2020-03-20T12:00:00Z',
    '2026-08-12T17:46:00Z',
  ];

  it('keeps the two Earth models within 0.04° of each other', () => {
    for (const iso of dates) {
      const jd = dateToJD(new Date(iso));
      const emb = computePlanetPositionEcliptic(getStandishElements('Earth', jd));
      const sceneLonDeg = norm360(Math.atan2(emb.z, emb.x) * RAD);
      const expectedLonDeg = norm360(
        sunPosition(jd).longitude + 180 - accumulatedPrecessionLonDeg(jd),
      );
      const deltaDeg = norm180(sceneLonDeg - expectedLonDeg);
      expect(Math.abs(deltaDeg), `at ${iso}: EMB ${sceneLonDeg.toFixed(4)}°, Meeus ${expectedLonDeg.toFixed(4)}°`).toBeLessThan(0.04);
    }
  });
});

describe('Earth–Moon–Sun coherent set', () => {
  // End-to-end through the same functions the renderer uses: Earth's render
  // position (computeBodyState) and the Moon's offset must agree with the
  // event search, so "jump to event" lands on the matching picture.
  const earth = PLANETS.find((p) => p.name === 'Earth')!;

  it('renders a found full moon anti-sunward of Earth', () => {
    const fullMoon = findEvent('full-moon', new Date('2026-01-01T00:00:00Z'), 1)!;
    const state = computeBodyState(earth, fullMoon.getTime());
    const moonOffset = computeMoonGeocentricEquatorialAU(ttJDFromUtcMs(fullMoon.getTime()), new THREE.Vector3());
    // Anti-sunward from Earth = the Sun→Earth direction = positionAU itself.
    const separationDeg = moonOffset.angleTo(state.positionAU) * RAD;
    expect(separationDeg).toBeLessThan(6); // bounded by the Moon's ±5.1° latitude
  });

  it('reproduces the near-central 2027-08-02 total solar eclipse (γ = 0.14)', () => {
    const utcMs = Date.UTC(2027, 7, 2, 10, 6, 36); // greatest eclipse
    const state = computeBodyState(earth, utcMs);
    const moonOffset = computeMoonGeocentricEquatorialAU(ttJDFromUtcMs(utcMs), new THREE.Vector3());
    const earthToSun = state.positionAU.clone().multiplyScalar(-1);
    const separationDeg = moonOffset.angleTo(earthToSun) * RAD;
    expect(separationDeg).toBeLessThan(0.4);
  });

  it('reproduces the off-axis geometry of the 2026-08-12 total eclipse (γ = 0.90)', () => {
    const utcMs = Date.UTC(2026, 7, 12, 17, 46, 0); // greatest eclipse
    const state = computeBodyState(earth, utcMs);
    const moonOffset = computeMoonGeocentricEquatorialAU(ttJDFromUtcMs(utcMs), new THREE.Vector3());
    const earthToSun = state.positionAU.clone().multiplyScalar(-1);
    const separationDeg = moonOffset.angleTo(earthToSun) * RAD;
    // γ ≈ 0.898 × lunar parallax ≈ 0.9°: geocentrically the centers miss by
    // most of a degree even though the eclipse is total at high latitudes —
    // the lower bound proves the off-axis geometry is reproduced, not skipped.
    expect(separationDeg).toBeGreaterThan(0.4);
    expect(separationDeg).toBeLessThan(1.2);
  });
});

describe('time helpers', () => {
  it('advances time by rate and respects pause', () => {
    const running = advancePlanetariumTime({ currentUtcMs: 1000, rate: 60, paused: false }, 2);
    expect(running.currentUtcMs).toBe(1000 + 2 * 60 * 1000);
    const paused = advancePlanetariumTime({ currentUtcMs: 1000, rate: 60, paused: true }, 2);
    expect(paused.currentUtcMs).toBe(1000);
  });

  it('round-trips datetime-local input values', () => {
    const ms = Date.UTC(2026, 7, 12, 17, 46);
    expect(parseUtcInputValue(formatUtcInputValue(ms))).toBe(ms);
    expect(parseUtcInputValue('not-a-date')).toBeNull();
    expect(parseUtcInputValue('2026-08-12')).toBeNull();
  });

  it('formats time-rate labels', () => {
    expect(formatTimeRateLabel(1, false)).toBe('Realtime');
    expect(formatTimeRateLabel(1, true)).toBe('Paused');
    expect(formatTimeRateLabel(120, false)).toBe('2 min/s');
    expect(formatTimeRateLabel(-3600, false)).toBe('Reverse 1 hr/s');
    expect(formatTimeRateLabel(86400 * 365, false)).toBe('1.0 yr/s');
  });
});
