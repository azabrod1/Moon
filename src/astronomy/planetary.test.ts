/**
 * Frame-convention and consistency tests for the Kepler planet model.
 *
 * Scene ecliptic frame (locked by these tests): +X at ecliptic longitude 0°
 * (vernal equinox), +Y at the north ecliptic pole, longitude increasing
 * toward −Z — the same right-handed sense raDecToVector uses for the star
 * sphere (RA 90° = −Z), so a body and its sky backdrop agree. The chirality
 * pin (RA0 × RA90 = north) proves the embedding is a proper rotation: the
 * rendered sky has real-world chirality, not a mirror image.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  advancePlanetariumTime,
  stepSimulationRate,
  computeBodyOrientationQuaternion,
  computeBodyPoleQuaternion,
  computeBodyPositionAU,
  computeBodyState,
  computeMoonGeocentricEquatorialAU,
  computeKeplerPositionEcliptic,
  eclipticToEquatorial,
  formatAdaptiveClock,
  formatTimeRateLabel,
  formatUtcInputValue,
  parseUtcInputValue,
  raDecToVector,
  sampleTrajectoryLinePoints,
  trajectoryLineBodyFraction,
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

  // Scene frame: north is +Y, longitude increases toward −Z.
  return new THREE.Vector3(xToEquinox, zToNorth, -yToLon90);
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
  it('puts RA 90° at −Z and the north pole at +Y', () => {
    const ra90 = raDecToVector(90, 0);
    expect(ra90.x).toBeCloseTo(0, 6);
    expect(ra90.z).toBeCloseTo(-1, 6);
    expect(raDecToVector(123, 90).y).toBeCloseTo(1, 6);
  });

  it('embeds the sky with real-world chirality (the cycle-2 flip)', () => {
    // In the real sky, (RA 0) × (RA 90) along the equator points to celestial
    // north. A mirrored embedding gives −north — this is the test that fails
    // on the pre-flip det(−1) frame and pins the milestone.
    const north = new THREE.Vector3().crossVectors(raDecToVector(0, 0), raDecToVector(90, 0));
    expect(north.angleTo(new THREE.Vector3(0, 1, 0)) * RAD).toBeLessThan(1e-6);
  });

  it('maps the north ecliptic pole to its real equatorial position (RA 270°, Dec 90°−ε)', () => {
    const pole = eclipticToEquatorial(new THREE.Vector3(0, 1, 0));
    const expected = raDecToVector(270, 90 - OBLIQUITY_DEG);
    expect(pole.angleTo(expected) * RAD).toBeLessThan(1e-4);
  });
});

describe('computeBodyPoleQuaternion (de-spin foundation)', () => {
  it('maps local +Y to the IAU pole direction for every body', () => {
    for (const planet of PLANETARIUM_BODIES) {
      const pole = new THREE.Vector3(0, 1, 0).applyQuaternion(computeBodyPoleQuaternion(planet));
      const expected = raDecToVector(planet.poleRaDeg, planet.poleDecDeg);
      expect(pole.angleTo(expected) * RAD, planet.name).toBeLessThan(1e-6);
    }
  });

  it('puts Earth\'s prime meridian at GMST (absolute rotation phase)', () => {
    // At 2000-01-01 12:00 UTC, GMST ≈ 280.46°: Greenwich points at that RA.
    // Evaluated through ttJDFromUtcMs — the production computeBodyState path —
    // the IAU W model lands within ~0.05°; the 0.5° tolerance absorbs the
    // UT1/ΔT-level coarseness of the pin value. Do not tighten. This is the
    // absolute-phase test that no spin model could pass in the mirrored frame.
    const earth = PLANETS.find((p) => p.name === 'Earth')!;
    const jdTT = ttJDFromUtcMs(Date.UTC(2000, 0, 1, 12, 0, 0));
    const prime = new THREE.Vector3(1, 0, 0).applyQuaternion(
      computeBodyOrientationQuaternion(earth, jdTT),
    );
    expect(prime.angleTo(raDecToVector(280.46, 0)) * RAD).toBeLessThan(0.5);
  });

  it('shares its pole axis with the spinning orientation at any time', () => {
    // The de-spun moon frame and the daily-spinning planet frame must agree on
    // the axis — they differ only by the prime-meridian rotation about it.
    const saturn = PLANETARIUM_BODIES.find((p) => p.name === 'Saturn')!;
    const poleAxis = new THREE.Vector3(0, 1, 0).applyQuaternion(computeBodyPoleQuaternion(saturn));
    for (const jd of [J2000, J2000 + 1234.5678]) {
      const spinningAxis = new THREE.Vector3(0, 1, 0).applyQuaternion(
        computeBodyOrientationQuaternion(saturn, jd),
      );
      expect(spinningAxis.angleTo(poleAxis) * RAD, `JD ${jd}`).toBeLessThan(1e-6);
    }
  });
});

describe('computeKeplerPositionEcliptic', () => {
  const testJDs = [J2000, J2000 + 1234.5, J2000 + 9000];

  for (const planet of PLANETARIUM_BODIES) {
    it(`matches textbook element propagation for ${planet.name}`, () => {
      for (const jd of testJDs) {
        const el = getStandishElements(planet.name, jd);
        const scene = computeKeplerPositionEcliptic(el);
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
      const emb = computeKeplerPositionEcliptic(getStandishElements('Earth', jd));
      const sceneLonDeg = norm360(Math.atan2(-emb.z, emb.x) * RAD);
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
    // Tier boundaries at the top of the ladder: day → week → month → year.
    expect(formatTimeRateLabel(86400, false)).toBe('1 day/s');
    expect(formatTimeRateLabel(604800, false)).toBe('1 wk/s');
    expect(formatTimeRateLabel(2592000, false)).toBe('1 mo/s');
    // The Julian-year preset reads exactly like its detent label.
    expect(formatTimeRateLabel(31557600, false)).toBe('1 yr/s');
    // Off-ladder magnitudes keep a decimal instead of rounding to a lie.
    expect(formatTimeRateLabel(864000, false)).toBe('1.4 wk/s');
    expect(formatTimeRateLabel(7776000, false)).toBe('3 mo/s');
    expect(formatTimeRateLabel(-2592000, false)).toBe('Reverse 1 mo/s');
  });

  it('coarsens the adaptive clock readout as the rate climbs', () => {
    const ms = Date.UTC(2026, 6, 8, 20, 3, 44);
    expect(formatAdaptiveClock(ms, 1)).toEqual({ date: 'Jul 08 2026', time: '20:03' });
    expect(formatAdaptiveClock(ms, 60)).toEqual({ date: 'Jul 08 2026', time: '20:03' });
    expect(formatAdaptiveClock(ms, 1200)).toEqual({ date: 'Jul 08 2026', time: '20h' });
    expect(formatAdaptiveClock(ms, 21600)).toEqual({ date: 'Jul 08 2026', time: '20h' });
    expect(formatAdaptiveClock(ms, 86400)).toEqual({ date: 'Jul 08 2026', time: '' });
    expect(formatAdaptiveClock(ms, 604800)).toEqual({ date: 'Jul 08 2026', time: '' });
    expect(formatAdaptiveClock(ms, 2592000)).toEqual({ date: 'Jul 2026', time: '' });
    expect(formatAdaptiveClock(ms, 31557600)).toEqual({ date: 'Jul 2026', time: '' });
    // Off-ladder rates (the tutorial's 2 hr/s) land in the right tier too.
    expect(formatAdaptiveClock(ms, 7200)).toEqual({ date: 'Jul 08 2026', time: '20h' });
    // The zero-padded day keeps the readout width stable all month.
    expect(formatAdaptiveClock(Date.UTC(2026, 0, 5), 1).date).toBe('Jan 05 2026');
  });

  it('walks a signed ladder: down through 1× pauses, again crosses into reverse', () => {
    const presets = [1, 60, 1200] as const;
    const at = (rate: number, paused = false) => ({ currentUtcMs: 0, rate, paused });
    // Forward magnitude walk.
    expect(stepSimulationRate(at(1), 1, presets).rate).toBe(60);
    expect(stepSimulationRate(at(60), -1, presets).rate).toBe(1);
    // Down from 1× rests at the pause detent, poised forward for a plain resume.
    expect(stepSimulationRate(at(1), -1, presets)).toMatchObject({ rate: 1, paused: true });
    // Down again from pause crosses into reverse realtime.
    expect(stepSimulationRate(at(1, true), -1, presets)).toMatchObject({ rate: -1, paused: false });
    // Further − steps deepen the past; + walks back toward the future.
    expect(stepSimulationRate(at(-1), -1, presets).rate).toBe(-60);
    expect(stepSimulationRate(at(-60), 1, presets).rate).toBe(-1);
    expect(stepSimulationRate(at(-1), 1, presets)).toMatchObject({ rate: -1, paused: true });
    expect(stepSimulationRate(at(-1, true), 1, presets)).toMatchObject({ rate: 1, paused: false });
    // From pause the walk resumes at 1× in the pressed direction — the pause
    // detent's neighbours don't depend on what rate the pause stored.
    expect(stepSimulationRate(at(60, true), 1, presets)).toMatchObject({ rate: 1, paused: false });
    expect(stepSimulationRate(at(60, true), -1, presets)).toMatchObject({ rate: -1, paused: false });
    // Off-ladder magnitudes snap to the next larger preset before stepping.
    expect(stepSimulationRate(at(30), 1, presets).rate).toBe(1200);
    expect(stepSimulationRate(at(30), -1, presets).rate).toBe(1);
    expect(stepSimulationRate(at(-30), -1, presets).rate).toBe(-1200);
    // Clamped at the fast end on both sides.
    expect(stepSimulationRate(at(1200), 1, presets).rate).toBe(1200);
    expect(stepSimulationRate(at(-1200), -1, presets).rate).toBe(-1200);
  });
});

describe('orbit-line trajectory sampling', () => {
  // Orbit lines sample the render position seam over one period. The Standish
  // tables freeze outside their 3000 BC – 3000 AD fit, so every sample past
  // the edge used to return the same frozen point and the line collapsed —
  // period-dependent onset, just past 3000 AD for Mercury out to ~3124 for
  // Pluto. Sampling now slides its center back far enough to hold a whole
  // period inside the fit; Earth, drawn from the Meeus seam, is exempt.
  const TODAY_MS = Date.parse('2026-07-27T00:00:00Z');
  const PAST_TABLES_MS = Date.parse('3100-01-01T00:00:00Z');
  const FAR_MS = Date.parse('5000-01-01T00:00:00Z');
  const FARTHER_MS = Date.parse('9000-01-01T00:00:00Z');
  // The clock reverses too, so the early edge of the fit gets the same test.
  const DEEP_PAST_MS = Date.UTC(-4000, 0, 1);
  const DEEPER_PAST_MS = Date.UTC(-6000, 0, 1);
  const SEGMENTS = 256;

  const standishBodies = PLANETARIUM_BODIES.filter((p) => p.name !== 'Earth');
  const earth = PLANETS.find((p) => p.name === 'Earth')!;

  function radialSpreadAU(points: THREE.Vector3[]): number {
    const radii = points.map((p) => p.length());
    return Math.max(...radii) - Math.min(...radii);
  }

  function nearestVertexAU(points: THREE.Vector3[], target: THREE.Vector3): number {
    return Math.min(...points.map((p) => p.distanceTo(target)));
  }

  it('still draws an orbit past the element tables', () => {
    for (const planet of standishBodies) {
      // rmax − rmin of the same ellipse = 2·a·e; a and e drift by fractions of
      // a percent over the millennia in play, so a line that is still an orbit
      // keeps its spread and one that collapsed reads exactly zero.
      const todaySpreadAU = radialSpreadAU(sampleTrajectoryLinePoints(planet, TODAY_MS, SEGMENTS));
      for (const utcMs of [DEEPER_PAST_MS, DEEP_PAST_MS, PAST_TABLES_MS, FAR_MS, FARTHER_MS]) {
        const points = sampleTrajectoryLinePoints(planet, utcMs, SEGMENTS);
        const where = `${planet.name} at ${new Date(utcMs).toISOString()}`;
        expect(points.every((p) => Number.isFinite(p.length())), where).toBe(true);
        expect(radialSpreadAU(points), where).toBeGreaterThan(0.5 * todaySpreadAU);
        expect(radialSpreadAU(points), where).toBeLessThan(2 * todaySpreadAU);
      }
    }
  });

  it('holds the outside line on the last orbit the tables cover', () => {
    // Every epoch beyond an edge draws that edge's orbit — the line stops
    // changing where the elements do, rather than degrading further out.
    const groups = [
      [FAR_MS, PAST_TABLES_MS, FARTHER_MS],
      [DEEP_PAST_MS, DEEPER_PAST_MS],
    ];
    for (const planet of standishBodies) {
      for (const [referenceMs, ...restMs] of groups) {
        const reference = sampleTrajectoryLinePoints(planet, referenceMs, SEGMENTS);
        for (const utcMs of restMs) {
          const other = sampleTrajectoryLinePoints(planet, utcMs, SEGMENTS);
          for (let i = 0; i < reference.length; i++) {
            expect(reference[i].distanceTo(other[i]), `${planet.name} vertex ${i}`).toBeLessThan(1e-12);
          }
        }
      }
    }
  });

  it('keeps the drawn body on its own orbit line past the tables', () => {
    // Positions freeze at the same edge the line is drawn from, so the body
    // still sits on its line however far outside the fit the clock is.
    for (const planet of standishBodies) {
      for (const utcMs of [DEEP_PAST_MS, FAR_MS]) {
        const points = sampleTrajectoryLinePoints(planet, utcMs, SEGMENTS);
        const drawn = computeBodyPositionAU(planet, utcMs);
        expect(nearestVertexAU(points, drawn), planet.name).toBeLessThan(1e-6);
      }
    }
  });

  it("leaves Earth's Meeus-sourced line running with the clock", () => {
    for (const utcMs of [DEEP_PAST_MS, FAR_MS, FARTHER_MS]) {
      const points = sampleTrajectoryLinePoints(earth, utcMs, SEGMENTS);
      // Centered on the requested epoch, not pulled back to a table edge: the
      // middle vertex is Earth exactly where it is drawn that day.
      const drawn = computeBodyPositionAU(earth, utcMs);
      expect(points[SEGMENTS / 2].distanceTo(drawn)).toBeLessThan(1e-9);
      // And still a full ellipse (2·a·e ≈ 0.033 AU).
      expect(radialSpreadAU(points)).toBeGreaterThan(0.02);
    }
  });

  it('samples an unchanged trajectory inside the element tables', () => {
    // Vertices captured from the implementation before the clamp existed, so
    // dates in normal use can never shift.
    const pinned: Record<string, [number, number, number][]> = {
      Mercury: [
        [-0.386162580868, -0.046510443847, 0.161982283037],
        [0.213430738183, -0.196952516747, 0.327276918536],
        [-0.386350184923, -0.046084476307, 0.161220675913],
      ],
      Earth: [
        [-0.56514561749, 0.320652791149, -0.73959296003],
        [-0.174965414608, -0.397835177137, 0.917615889787],
        [-0.565072428897, 0.320672885432, -0.73963930795],
      ],
      Pluto: [
        [8.281972048607, 11.368945327422, -44.43617176275],
        [-14.640470670596, -3.625333859281, 25.752389737417],
        [8.201920610862, 11.399950209489, -44.441357394118],
      ],
    };
    const vertices = [0, 3, 8];
    for (const [name, expected] of Object.entries(pinned)) {
      const planet = PLANETARIUM_BODIES.find((p) => p.name === name)!;
      const points = sampleTrajectoryLinePoints(planet, TODAY_MS, 8);
      vertices.forEach((vertex, k) => {
        const where = `${name} vertex ${vertex}`;
        expect(points[vertex].x, where).toBeCloseTo(expected[k][0], 11);
        expect(points[vertex].y, where).toBeCloseTo(expected[k][1], 11);
        expect(points[vertex].z, where).toBeCloseTo(expected[k][2], 11);
      });
    }
  });
});

describe('orbit-line body fraction', () => {
  // Anything drawn against the body's place on its own line (the map's
  // direction fade) needs the sample-index ↔ epoch correspondence, and the
  // body is at the middle sample only while both epochs are inside the
  // tables. Past an edge the line holds its last whole period while the body
  // freezes on the edge — an END of the strip — so a fraction that kept
  // counting from the requested epoch would circulate around a standing body.
  const TODAY_MS = Date.parse('2026-07-27T00:00:00Z');
  const FAR_MS = Date.parse('5000-01-01T00:00:00Z');
  const FARTHER_MS = Date.parse('9000-01-01T00:00:00Z');
  const DEEP_PAST_MS = Date.UTC(-4000, 0, 1);
  const SEGMENTS = 256;

  const standishBodies = PLANETARIUM_BODIES.filter((p) => p.name !== 'Earth');
  const earth = PLANETS.find((p) => p.name === 'Earth')!;

  /** Vertices 0 and N are the same place on a closed loop, so index distance
   *  is measured the short way round. */
  function loopIndexGap(a: number, b: number): number {
    const raw = Math.abs(a - b);
    return Math.min(raw, SEGMENTS - raw);
  }

  it('points at the vertex the body is actually drawn on', () => {
    for (const planet of PLANETARIUM_BODIES) {
      for (const utcMs of [TODAY_MS, FAR_MS, DEEP_PAST_MS]) {
        const points = sampleTrajectoryLinePoints(planet, utcMs, SEGMENTS);
        const drawn = computeBodyPositionAU(planet, utcMs);
        let nearest = 0;
        for (let i = 1; i <= SEGMENTS; i++) {
          if (points[i].distanceTo(drawn) < points[nearest].distanceTo(drawn)) nearest = i;
        }
        const fraction = trajectoryLineBodyFraction(planet, utcMs, utcMs);
        const where = `${planet.name} at ${new Date(utcMs).toISOString()}`;
        expect(loopIndexGap(Math.round(fraction * SEGMENTS), nearest), where).toBeLessThanOrEqual(1);
      }
    }
  });

  it('puts the body at the middle sample inside the element tables', () => {
    for (const planet of PLANETARIUM_BODIES) {
      expect(trajectoryLineBodyFraction(planet, TODAY_MS, TODAY_MS), planet.name).toBe(0.5);
    }
    // And walks the loop with the clock: a quarter period on is three
    // quarters along a strip that starts half a period back.
    const quarterYearMs = (365.25 / 4) * 86_400_000;
    expect(trajectoryLineBodyFraction(earth, TODAY_MS, TODAY_MS + quarterYearMs)).toBeCloseTo(0.75, 9);
  });

  it('pins the fraction to the strip end past the tables', () => {
    for (const planet of standishBodies) {
      for (const utcMs of [FAR_MS, DEEP_PAST_MS]) {
        const fraction = trajectoryLineBodyFraction(planet, utcMs, utcMs);
        const where = `${planet.name} at ${new Date(utcMs).toISOString()}`;
        // Either end of the strip — they are the same place on the loop.
        expect(Math.min(fraction, 1 - fraction), where).toBeLessThan(1 / SEGMENTS);
      }
    }
  });

  it('stops the fraction advancing once the body is frozen', () => {
    // The map's line keeps the epoch it was last sampled at while the clock
    // runs on: past the tables the drawn body stands still, so the fraction
    // must stand still with it.
    for (const planet of standishBodies) {
      const atEdge = trajectoryLineBodyFraction(planet, FAR_MS, FAR_MS);
      for (const bodyUtcMs of [FAR_MS + 86_400_000 * 365.25 * 100, FARTHER_MS]) {
        expect(trajectoryLineBodyFraction(planet, FAR_MS, bodyUtcMs), planet.name).toBe(atEdge);
      }
    }
    // Earth is not frozen, so its fraction keeps moving.
    expect(trajectoryLineBodyFraction(earth, FAR_MS, FAR_MS + 91 * 86_400_000)).not.toBe(
      trajectoryLineBodyFraction(earth, FAR_MS, FAR_MS),
    );
  });
});
