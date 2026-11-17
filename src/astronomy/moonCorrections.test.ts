import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  correctedMoonNames,
  MOON_CORRECTION_BLEND_DAYS,
  MOON_CORRECTIONS_FILE,
  moonCorrectionRtnKm,
  moonCorrectionWeight,
  parseMoonCorrections,
  type MoonCorrectionSet,
} from './moonCorrections';
import { computeMoonOffsetEquatorialAU, computeSatelliteOffsetEquatorialAU, installMoonCorrections } from './satellites';
import { installMoonCorrectionsFromDisk } from './fittedEphemerisTestFile';
import { SATELLITE_ELEMENTS } from './satelliteElements';
import { ttJDFromUtcMs } from './planetary';
import { KM_PER_AU } from './constants';
import golden from './moonCorrections.goldens.json';

const WINDOW_START_JD = 2415020.5;
const WINDOW_END_JD = WINDOW_START_JD + 143 * 512;

function utcMsAtTt(jdTT: number): number {
  let utcMs = (jdTT - 2440587.5) * 86_400_000;
  for (let iteration = 0; iteration < 4; iteration++) utcMs += (jdTT - ttJDFromUtcMs(utcMs)) * 86_400_000;
  return utcMs;
}

/** Scene AU → ICRF km. */
function icrfKm(scene: THREE.Vector3): [number, number, number] {
  return [scene.x * KM_PER_AU, -scene.z * KM_PER_AU, scene.y * KM_PER_AU];
}

/**
 * A one-moon v1 file: a constant term holding R at 10 km, and a periodic term
 * holding T at 5 sin ψ, both on four B-spline coefficients. Guard positions
 * are the given ones.
 */
function syntheticFile(name: string, guardJd: [number, number], guardKm: number[]): ArrayBuffer {
  const nameBytes = new TextEncoder().encode(name);
  const parts: number[] = [];
  const view = (size: number, write: (dataView: DataView) => void) => {
    const buffer = new ArrayBuffer(size);
    write(new DataView(buffer));
    parts.push(...new Uint8Array(buffer));
  };
  parts.push(...new TextEncoder().encode('MSCR'));
  view(4, (d) => { d.setUint16(0, 1, true); d.setUint16(2, 1, true); });
  view(56, (d) => {
    [WINDOW_START_JD, WINDOW_START_JD - 735, WINDOW_END_JD + 735, WINDOW_START_JD, WINDOW_END_JD, ...guardJd]
      .forEach((value, index) => d.setFloat64(index * 8, value, true));
  });
  parts.push(nameBytes.length, ...nameBytes);
  view(6, (d) => { d.setUint16(0, 2, true); d.setFloat32(2, 3, true); });
  view(48, (d) => guardKm.forEach((value, index) => d.setFloat64(index * 8, value, true)));
  // Constant term: rate 0, cosine only, R stored. Knots wide enough that four
  // coefficients span the whole spline range.
  const knotDays = 40_000;
  view(15, (d) => { d.setFloat64(0, 0, true); d.setFloat32(8, knotDays, true); d.setUint16(12, 4, true); d.setUint8(14, 1 | 2); });
  view(4 + 8, (d) => { d.setFloat32(0, 10 / 32767, true); for (let index = 0; index < 4; index++) d.setInt16(4 + 2 * index, 32767, true); });
  // Periodic term: T stored, A = 0 and B = 5 on every coefficient.
  view(15, (d) => { d.setFloat64(0, 0.25, true); d.setFloat32(8, knotDays, true); d.setUint16(12, 4, true); d.setUint8(14, 4); });
  view(4 + 16, (d) => {
    d.setFloat32(0, 5 / 32767, true);
    for (let index = 0; index < 4; index++) { d.setInt16(4 + 4 * index, 0, true); d.setInt16(6 + 4 * index, 32767, true); }
  });
  return new Uint8Array(parts).buffer;
}

function guardFor(name: string, guardJd: [number, number]): number[] {
  const position = new THREE.Vector3();
  return guardJd.flatMap((jd) => icrfKm(computeSatelliteOffsetEquatorialAU(name, jd, position)));
}

afterEach(() => {
  // Every other suite runs on the shipped file.
  installMoonCorrectionsFromDisk();
});

describe('the moon-corrections format', () => {
  const guardJd: [number, number] = [2420000.5, 2480000.5];

  it('evaluates a spline-modulated term set', () => {
    const set = parseMoonCorrections(syntheticFile('Io', guardJd, guardFor('Io', guardJd)));
    const moon = set.moons.get('Io')!;
    expect(moon.heldOutKm).toBe(3);
    const rtn = new Float64Array(3);
    const jd = 2451545.0;
    moonCorrectionRtnKm(set, moon, jd, rtn);
    // Equal coefficients: the B-spline's partition of unity gives the value back.
    expect(rtn[0]).toBeCloseTo(10, 3);
    expect(rtn[1]).toBeCloseTo(5 * Math.sin(0.25 * (jd - WINDOW_START_JD)), 3);
    expect(rtn[2]).toBe(0);
  });

  it('refuses a truncated file', () => {
    const bytes = syntheticFile('Io', guardJd, guardFor('Io', guardJd));
    expect(() => parseMoonCorrections(bytes.slice(0, bytes.byteLength - 1))).toThrow(/truncated/);
  });

  it('installs a moon only over the elements it was fitted to', () => {
    const good = parseMoonCorrections(syntheticFile('Io', guardJd, guardFor('Io', guardJd)));
    expect(installMoonCorrections(good)).toEqual([]);
    expect(correctedMoonNames()).toEqual(['Io']);
    const shifted = guardFor('Io', guardJd).map((value, index) => (index === 0 ? value + 1 : value));
    expect(installMoonCorrections(parseMoonCorrections(syntheticFile('Io', guardJd, shifted)))).toEqual(['Io']);
    expect(correctedMoonNames()).toEqual([]);
  });

  it('applies in full across the window and eases out past it', () => {
    const set = parseMoonCorrections(syntheticFile('Io', guardJd, guardFor('Io', guardJd))) as MoonCorrectionSet;
    expect(moonCorrectionWeight(set, WINDOW_START_JD)).toBe(1);
    expect(moonCorrectionWeight(set, WINDOW_END_JD)).toBe(1);
    expect(moonCorrectionWeight(set, WINDOW_START_JD - MOON_CORRECTION_BLEND_DAYS / 2)).toBeCloseTo(0.5, 9);
    expect(moonCorrectionWeight(set, WINDOW_END_JD + MOON_CORRECTION_BLEND_DAYS)).toBe(0);
  });
});

describe('the shipped moon corrections', () => {
  it('were fitted to the elements in satelliteElements.ts (rerun gen:moon-corrections after gen:moons)', () => {
    expect(installMoonCorrectionsFromDisk()).toEqual([]);
    expect(correctedMoonNames().sort()).toEqual(Object.keys(golden.moons).sort());
  });

  it('put each moon within its held-out error of Horizons, through the seam', () => {
    // The golden rows are on the fine grid, which the file's held-out error
    // was scored on and no fit ever saw.
    const bytes = readFileSync(fileURLToPath(new URL('../../public/' + MOON_CORRECTIONS_FILE, import.meta.url)));
    const set = parseMoonCorrections(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const position = new THREE.Vector3();
    for (const [moon, rows] of Object.entries(golden.moons)) {
      const parent = SATELLITE_ELEMENTS[moon].parentPlanet;
      const heldOutKm = set.moons.get(moon)!.heldOutKm;
      expect(heldOutKm).toBeLessThan(100);
      for (const row of rows) {
        const [x, y, z] = icrfKm(computeMoonOffsetEquatorialAU(moon, parent, utcMsAtTt(row.jdTdb), position));
        const errorKm = Math.hypot(x - row.km[0], y - row.km[1], z - row.km[2]);
        expect(errorKm, `${moon} at JD ${row.jdTdb}`).toBeLessThan(heldOutKm + 0.01);
      }
    }
  });

  it('ease out past the window without a jump, and never through the planet', () => {
    const corrected = new THREE.Vector3();
    const previous = new THREE.Vector3();
    const bare = new THREE.Vector3();
    // The two largest corrections: Mimas half an orbit, Titan 200,000 km.
    for (const moon of ['Mimas', 'Titan']) {
      const record = SATELLITE_ELEMENTS[moon];
      const parent = record.parentPlanet;
      const periodDays = 360 / Math.abs(record.meanAnomalyRateDegPerDay + record.argPeriapsisRateDegPerDay + record.ascendingNodeRateDegPerDay);
      const stepDays = periodDays / 20;
      for (const [fromJd, toJd] of [
        [WINDOW_START_JD - MOON_CORRECTION_BLEND_DAYS - 10, WINDOW_START_JD + 10],
        [WINDOW_END_JD - 10, WINDOW_END_JD + MOON_CORRECTION_BLEND_DAYS + 10],
      ]) {
        let first = true;
        for (let jd = fromJd; jd <= toJd; jd += stepDays) {
          computeMoonOffsetEquatorialAU(moon, parent, utcMsAtTt(jd), corrected);
          const bareRadius = computeSatelliteOffsetEquatorialAU(moon, jd, bare).length();
          expect(corrected.length() / bareRadius, `${moon} at JD ${jd}`).toBeGreaterThan(0.9);
          // One step along the orbit is 2π/20 of the radius; a flip of the
          // blended angle would be many times that.
          if (!first) expect(corrected.distanceTo(previous) / bareRadius, `${moon} at JD ${jd}`).toBeLessThan(0.5);
          previous.copy(corrected);
          first = false;
        }
      }
    }
  });
});
