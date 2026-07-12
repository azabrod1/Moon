/**
 * Orbit-details math: synthetic Kepler ellipses pin the derived-geometry
 * construction exactly; real-seam samples (computeMoonOffsetEquatorialAU —
 * the same code path the renderer draws) pin the 65-moon generalization,
 * including the pathological fitted decompositions (Tethys: Ṁ=−6.2°/d with
 * ω̇=+197°/d — the mean-longitude period is the only meaningful one) and the
 * exact-circular records whose apsides are float noise.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  deriveOrbitGeometry,
  sampleSpanTimesMs,
  needsResample,
  sectorWindows,
  isCircularDegenerate,
  areFociMerged,
  shouldCloseLoop,
  fanAreaAU2,
  formatOrbitReadout,
  orbitSampleSegments,
  SECTOR_SWEEP_FRACTION,
  SPAN_LEAD_FRACTION,
} from './orbitDetails';
import {
  computeMoonOffsetEquatorialAU,
  getMoonDisplayOrbit,
  getMoonApoapsisAU,
} from '../astronomy/satellites';
import { KM_PER_AU } from '../astronomy/constants';

const MS_PER_DAY = 86_400_000;
const EPOCH_MS = Date.UTC(2026, 5, 12); // fixed test epoch, mid-calibration-validity

// --- Synthetic Kepler orbit -------------------------------------------------

function solveKepler(meanAnomalyRad: number, e: number): number {
  let E = meanAnomalyRad;
  for (let i = 0; i < 60; i++) {
    const d = (E - e * Math.sin(E) - meanAnomalyRad) / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-14) break;
  }
  return E;
}

interface SyntheticOrbit {
  aAU: number;
  e: number;
  /** Orbital-plane basis (arbitrary orientation). */
  u: THREE.Vector3;
  v: THREE.Vector3;
  argPeriRad: number;
  retrograde: boolean;
}

function makeOrbit(aAU: number, e: number, retrograde = false): SyntheticOrbit {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.6, 1.1, 0.3, 'XYZ'));
  return {
    aAU,
    e,
    u: new THREE.Vector3(1, 0, 0).applyQuaternion(q),
    v: new THREE.Vector3(0, 1, 0).applyQuaternion(q),
    argPeriRad: 0.8,
    retrograde,
  };
}

function orbitPositionAtPhase(orbit: SyntheticOrbit, phase01: number, out: THREE.Vector3): THREE.Vector3 {
  const dir = orbit.retrograde ? -1 : 1;
  const M = dir * phase01 * 2 * Math.PI;
  const E = solveKepler(M, orbit.e);
  const nu = Math.atan2(
    Math.sqrt(1 - orbit.e * orbit.e) * Math.sin(E),
    Math.cos(E) - orbit.e,
  );
  const r = orbit.aAU * (1 - orbit.e * Math.cos(E));
  const theta = orbit.argPeriRad + nu;
  return out
    .set(0, 0, 0)
    .addScaledVector(orbit.u, r * Math.cos(theta))
    .addScaledVector(orbit.v, r * Math.sin(theta));
}

function syntheticSamples(orbit: SyntheticOrbit, segments: number): THREE.Vector3[] {
  const samples: THREE.Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    samples.push(orbitPositionAtPhase(orbit, i / segments, new THREE.Vector3()));
  }
  return samples;
}

function seamSamples(moonName: string, parentName: string, periodDays: number, segments: number) {
  const times = sampleSpanTimesMs(EPOCH_MS, periodDays, segments);
  return times.map((t) => computeMoonOffsetEquatorialAU(moonName, parentName, t, new THREE.Vector3()));
}

// --- Derived geometry: synthetic pins ---------------------------------------

describe('deriveOrbitGeometry (synthetic Kepler)', () => {
  const orbit = makeOrbit(1, 0.3);
  const geom = deriveOrbitGeometry(syntheticSamples(orbit, 256));

  it('recovers a, e, apsides to sampling tolerance', () => {
    expect(geom.semiMajorAxisAU).toBeCloseTo(1, 4);
    expect(geom.eccentricity).toBeCloseTo(0.3, 3);
    expect(geom.periRadiusAU).toBeCloseTo(0.7, 4);
    expect(geom.apoRadiusAU).toBeCloseTo(1.3, 4);
    expect(geom.semiMinorAxisAU).toBeCloseTo(Math.sqrt(1 - 0.09), 3);
  });

  it('places the empty focus at 2·center, opposite periapsis', () => {
    const periDir = new THREE.Vector3()
      .addScaledVector(orbit.u, Math.cos(orbit.argPeriRad))
      .addScaledVector(orbit.v, Math.sin(orbit.argPeriRad));
    const expected = periDir.clone().multiplyScalar(-2 * 0.3);
    expect(geom.emptyFocus.distanceTo(expected)).toBeLessThan(1e-3);
    expect(geom.center.distanceTo(expected.clone().multiplyScalar(0.5))).toBeLessThan(1e-3);
  });

  it('builds an orthogonal in-plane basis', () => {
    const planeNormal = new THREE.Vector3().crossVectors(orbit.u, orbit.v).normalize();
    expect(Math.abs(geom.majorDir.dot(geom.minorDir))).toBeLessThan(1e-9);
    expect(Math.abs(geom.majorDir.dot(planeNormal))).toBeLessThan(1e-6);
    expect(Math.abs(geom.minorDir.dot(planeNormal))).toBeLessThan(1e-6);
  });

  it('orient: prograde sampling gives the u×v normal; retrograde flips it', () => {
    const planeNormal = new THREE.Vector3().crossVectors(orbit.u, orbit.v).normalize();
    expect(geom.normal.dot(planeNormal)).toBeGreaterThan(0.999);
    const retro = deriveOrbitGeometry(syntheticSamples(makeOrbit(1, 0.3, true), 256));
    expect(retro.normal.dot(planeNormal)).toBeLessThan(-0.999);
  });

  it('closes an unperturbed loop and is not degenerate', () => {
    expect(geom.closureGapAU).toBeLessThan(1e-12);
    expect(shouldCloseLoop(geom)).toBe(true);
    expect(isCircularDegenerate(geom)).toBe(false);
  });

  it('near-circular orbits derive without NaN and flag degenerate', () => {
    const tiny = deriveOrbitGeometry(syntheticSamples(makeOrbit(1, 0.0001), 256));
    expect(Number.isFinite(tiny.semiMajorAxisAU)).toBe(true);
    expect(Number.isFinite(tiny.normal.length())).toBe(true);
    expect(tiny.semiMajorAxisAU).toBeCloseTo(1, 5);
    expect(isCircularDegenerate(tiny)).toBe(true);
  });
});

describe('equal-area sectors (the namesake invariant)', () => {
  it('trailing and half-period-offset fans sweep equal areas (synthetic, e=0.3)', () => {
    const orbit = makeOrbit(1, 0.3);
    const periodDays = 10;
    // Park "now" near periapsis so the two windows probe the extremes.
    const nowMs = 0;
    const w = sectorWindows(nowMs, periodDays);
    const fan = (startMs: number, endMs: number) => {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 16; i++) {
        const tMs = startMs + ((endMs - startMs) * i) / 16;
        const phase = tMs / (periodDays * MS_PER_DAY);
        pts.push(orbitPositionAtPhase(orbit, ((phase % 1) + 1) % 1, new THREE.Vector3()));
      }
      return pts;
    };
    const areaA = fanAreaAU2(fan(w.trailingStartMs, w.trailingEndMs));
    const areaB = fanAreaAU2(fan(w.offsetStartMs, w.offsetEndMs));
    expect(Math.abs(areaA - areaB) / areaA).toBeLessThan(0.005);
  });
});

describe('span layout + resample guard', () => {
  it('keeps both sector windows inside the sampled span across the staleness range', () => {
    for (const periodDays of [27.321661, 0.295]) {
      const periodMs = periodDays * MS_PER_DAY;
      const guardMs = Math.min((periodDays / 16) * MS_PER_DAY, 6 * 3_600_000);
      const refT = 1_000_000_000_000;
      const spanStart = refT - SPAN_LEAD_FRACTION * periodMs;
      const spanEnd = spanStart + periodMs;
      for (const now of [refT - guardMs, refT, refT + guardMs]) {
        expect(needsResample(now, refT, periodDays)).toBe(false);
        const w = sectorWindows(now, periodDays);
        expect(w.trailingStartMs).toBeGreaterThanOrEqual(spanStart);
        expect(w.offsetEndMs).toBeLessThanOrEqual(spanEnd);
      }
      expect(needsResample(refT + guardMs * 1.01, refT, periodDays)).toBe(true);
      expect(needsResample(refT - guardMs * 1.01, refT, periodDays)).toBe(true);
    }
  });

  it('windows are half a period apart with the configured sweep', () => {
    const w = sectorWindows(0, 4);
    expect(w.offsetEndMs - w.trailingEndMs).toBeCloseTo(2 * MS_PER_DAY, 6);
    expect(w.trailingEndMs - w.trailingStartMs).toBeCloseTo(SECTOR_SWEEP_FRACTION * 4 * MS_PER_DAY, 6);
  });
});

// --- Real-seam goldens -------------------------------------------------------

describe('real-seam orbits (same code path the renderer draws)', () => {
  it("Earth's Moon: apsides and derived e in real lunar ranges", () => {
    const display = getMoonDisplayOrbit('Moon', 'Earth');
    const geom = deriveOrbitGeometry(
      seamSamples('Moon', 'Earth', display.periodDays, orbitSampleSegments(display.eccentricity)),
    );
    const periKm = geom.periRadiusAU * KM_PER_AU;
    const apoKm = geom.apoRadiusAU * KM_PER_AU;
    expect(periKm).toBeGreaterThan(356_000);
    expect(periKm).toBeLessThan(371_000);
    expect(apoKm).toBeGreaterThan(400_000);
    expect(apoKm).toBeLessThan(407_000);
    expect(geom.eccentricity).toBeGreaterThan(0.026);
    expect(geom.eccentricity).toBeLessThan(0.078);
    // Evection moves the radial extremes off-antipodal — the max-diameter
    // center construction must still yield b ≤ a (a midpoint-of-apsides
    // center measured b ~5% LARGER than a; this pins the fix).
    expect(geom.semiMinorAxisAU).toBeLessThanOrEqual(geom.semiMajorAxisAU);
    expect(geom.semiMinorAxisAU / geom.semiMajorAxisAU).toBeGreaterThan(0.985);
    // Meeus perturbations (evection): the one-period trajectory misses
    // closure by MORE than the 0.5%-of-a chord threshold, so the flagship
    // orbit draws with an honest open seam (parked 45° behind the subject by
    // the span layout). Pinned so CLOSE_LOOP_GAP_FRACTION tuning can't
    // silently change the most-viewed orbit's seam behavior.
    expect(geom.closureGapAU).toBeGreaterThan(0.005 * geom.semiMajorAxisAU);
    expect(shouldCloseLoop(geom)).toBe(false);
  });

  it('Nereid: extreme ellipse recovered (e≈0.751, periapsis within 1%)', () => {
    const display = getMoonDisplayOrbit('Nereid', 'Neptune');
    expect(orbitSampleSegments(display.eccentricity)).toBe(768);
    const geom = deriveOrbitGeometry(
      seamSamples('Nereid', 'Neptune', display.periodDays, 768),
    );
    expect(Math.abs(geom.eccentricity - 0.7507)).toBeLessThan(0.03);
    const expectedPeriAU = (display.aKm / KM_PER_AU) * (1 - display.eccentricity);
    expect(Math.abs(geom.periRadiusAU - expectedPeriAU) / expectedPeriAU).toBeLessThan(0.01);
    // Foci-merge boundary: Nereid's empty focus is far outside Neptune.
    expect(areFociMerged(geom, 24622 / KM_PER_AU)).toBe(false);
  });

  it('Phobos: a within 1% of 9,375 km', () => {
    const display = getMoonDisplayOrbit('Phobos', 'Mars');
    const geom = deriveOrbitGeometry(
      seamSamples('Phobos', 'Mars', display.periodDays, orbitSampleSegments(display.eccentricity)),
    );
    expect(Math.abs(geom.semiMajorAxisAU * KM_PER_AU - 9375) / 9375).toBeLessThan(0.01);
  });

  it('Tethys (degenerate fitted decomposition): clean single loop, real period', () => {
    const display = getMoonDisplayOrbit('Tethys', 'Saturn');
    expect(display.periodDays).toBeGreaterThan(1.879);
    expect(display.periodDays).toBeLessThan(1.897);
    const samples = seamSamples('Tethys', 'Saturn', display.periodDays, orbitSampleSegments(display.eccentricity));
    // One revolution, no aliasing: consecutive samples advance < 5° each.
    for (let i = 0; i + 1 < samples.length; i++) {
      const stepDeg = samples[i].angleTo(samples[i + 1]) * (180 / Math.PI);
      expect(stepDeg).toBeLessThan(5);
    }
    const geom = deriveOrbitGeometry(samples);
    expect(shouldCloseLoop(geom)).toBe(true);
  });

  it('exact-circular record (Triton e=0): circular-degenerate fires', () => {
    const display = getMoonDisplayOrbit('Triton', 'Neptune');
    expect(display.eccentricity).toBe(0);
    const geom = deriveOrbitGeometry(
      seamSamples('Triton', 'Neptune', display.periodDays, orbitSampleSegments(0)),
    );
    expect(isCircularDegenerate(geom)).toBe(true);
    expect(Number.isFinite(geom.semiMajorAxisAU)).toBe(true);
  });
});

describe('display-orbit accessors', () => {
  it('mean-longitude periods survive the degenerate fits', () => {
    expect(getMoonDisplayOrbit('Phobos', 'Mars').periodDays).toBeCloseTo(0.3189, 2);
    expect(getMoonDisplayOrbit('Tethys', 'Saturn').periodDays).toBeCloseTo(1.888, 2);
    expect(getMoonDisplayOrbit('Calypso', 'Saturn').periodDays).toBeCloseTo(1.888, 1);
    expect(getMoonDisplayOrbit('Moon', 'Earth').periodDays).toBeCloseTo(27.3217, 3);
  });

  it('getMoonApoapsisAU is safe for all 65 moons including Earth-Moon', () => {
    expect(getMoonApoapsisAU('Moon', 'Earth')).toBeCloseTo(0.00271, 4);
    expect(getMoonApoapsisAU('Nereid', 'Neptune')).toBeCloseTo(0.0645, 3);
    expect(getMoonApoapsisAU('Neso', 'Neptune')).toBeGreaterThan(0.4);
  });
});

// --- Readout -----------------------------------------------------------------

describe('formatOrbitReadout', () => {
  const moonGeom = deriveOrbitGeometry(
    seamSamples('Moon', 'Earth', 27.321661, 256),
  );
  const earthRadiusAU = 6371 / KM_PER_AU;

  it("Earth's Moon: leads with e + center offset, perigee/apogee naming, low-e caption", () => {
    const readout = formatOrbitReadout(moonGeom, getMoonDisplayOrbit('Moon', 'Earth'), {
      isEarthMoon: true,
      parentRadiusAU: earthRadiusAU,
    });
    expect(readout.lines[0]).toMatch(/^e 0\.0\d\d · center offset [\d,]+ km$/);
    expect(readout.lines[1]).toContain('perigee');
    expect(readout.lines[1]).toContain('apogee');
    expect(readout.lines[2]).toContain('period 27.32 d');
    expect(readout.lines[3]).toBe('equal areas · 1.0 d each');
    expect(readout.captions.some((c) => c.includes('offset focus is the visible eccentricity'))).toBe(true);
    expect(areFociMerged(moonGeom, earthRadiusAU)).toBe(false);
  });

  it('generic moons say periapsis/apoapsis', () => {
    const display = getMoonDisplayOrbit('Nereid', 'Neptune');
    const geom = deriveOrbitGeometry(seamSamples('Nereid', 'Neptune', display.periodDays, 768));
    const readout = formatOrbitReadout(geom, display, {
      isEarthMoon: false,
      parentRadiusAU: 24622 / KM_PER_AU,
    });
    expect(readout.lines[1]).toContain('periapsis');
    expect(readout.captions.some((c) => c.includes('visible eccentricity'))).toBe(false);
  });

  it('phase-accuracy caveat: librator (Hyperion) and high-residual fitted (Neso), not Io', () => {
    const geom = deriveOrbitGeometry(syntheticSamples(makeOrbit(0.01, 0.1), 256));
    const opts = { isEarthMoon: false, parentRadiusAU: 1e-6 };
    const hyperion = formatOrbitReadout(geom, getMoonDisplayOrbit('Hyperion', 'Saturn'), opts);
    expect(hyperion.captions.some((c) => c.includes('resonant libration'))).toBe(true);
    const neso = formatOrbitReadout(geom, getMoonDisplayOrbit('Neso', 'Neptune'), opts);
    expect(neso.captions.some((c) => c.includes('position along the orbit approximate'))).toBe(true);
    const io = formatOrbitReadout(geom, getMoonDisplayOrbit('Io', 'Jupiter'), opts);
    expect(io.captions.some((c) => c.includes('approximate'))).toBe(false);
  });

  it('foci-merged (Io) and circular (Triton) captions; circular drops the apsides line', () => {
    const ioDisplay = getMoonDisplayOrbit('Io', 'Jupiter');
    const ioGeom = deriveOrbitGeometry(
      seamSamples('Io', 'Jupiter', ioDisplay.periodDays, 256),
    );
    const jupiterRadiusAU = 69911 / KM_PER_AU;
    expect(areFociMerged(ioGeom, jupiterRadiusAU)).toBe(true);
    // Boundary pin: Io's e=0.004 (0.8% radial variation) is real signal, not
    // float noise — it keeps its apsides/axes (the 0.1% threshold is a
    // deliberate deviation from the plan's 1%: only exact-zero records are
    // noise; small-but-real eccentricity stays visible).
    expect(isCircularDegenerate(ioGeom)).toBe(false);
    const io = formatOrbitReadout(ioGeom, ioDisplay, {
      isEarthMoon: false,
      parentRadiusAU: jupiterRadiusAU,
    });
    expect(io.captions.some((c) => c.includes('foci nearly coincide'))).toBe(true);

    const tritonDisplay = getMoonDisplayOrbit('Triton', 'Neptune');
    const tritonGeom = deriveOrbitGeometry(
      seamSamples('Triton', 'Neptune', tritonDisplay.periodDays, 256),
    );
    const triton = formatOrbitReadout(tritonGeom, tritonDisplay, {
      isEarthMoon: false,
      parentRadiusAU: 24622 / KM_PER_AU,
    });
    expect(triton.captions.some((c) => c.includes('circular within the model'))).toBe(true);
    expect(triton.lines.some((l) => l.includes('periapsis'))).toBe(false);
  });
});
