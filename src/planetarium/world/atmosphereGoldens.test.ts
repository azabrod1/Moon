import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ATMOSPHERE_GOLDEN_PINS, goldenChannelTolerance } from './atmosphereGoldens.pinned';
import { ATMOSPHERE_TABLE_SIZES_FULL } from './atmosphereModel';
import { createAtmosphereShellMaterial } from './atmosphereShell';
import { PLANETS } from '../planets/planetData';

/**
 * The atmosphere shell's golden captures (tools/atmo-shell-qa.mjs).
 *
 * The images are a LOCAL gate: CI has no GPU and cannot render them, and they
 * are deliberately out of public/ so they never ship to anyone. What CI holds
 * is the numbers beside them — every sampled radiance, against the values
 * pinned in atmosphereGoldens.pinned.ts.
 *
 * The two files are the whole point. Reading a capture's JSON and checking it
 * against itself passes for any shader at all: the JSON is whatever the GPU
 * produced the last time somebody ran the tool. Held against a second file that
 * only a deliberate `--pins` regeneration rewrites, a shader edit that changes
 * the picture fails here as soon as the captures are re-recorded, and the fix
 * is a diff full of moved radiances rather than a silent re-record.
 *
 * The rest is what makes a capture mean anything at all: the pinned near plane,
 * the pinned exposure and pixel ratio, and the pinned clock. A pose captured
 * with any of those floating compares against nothing, and the way that fails
 * is silently.
 */
const DIR = fileURLToPath(new URL('../../../tools/goldens/atmosphere/', import.meta.url));

const POSES = [
  'limb-8r',
  'limb-1.05r',
  // Straight down and along the ground toward the horizon, from the same
  // 1.05 R stand point: the two poses aerial perspective is judged on. Nadir is
  // the whole frame of ground under one thin airmass; oblique is the same
  // column seen end-on, where it thickens into haze.
  'nadir-1.05r',
  'oblique-1.05r',
  'terminator-1.5r',
  // The night side under three Moons. A night pose is a pose AND a Moon: the
  // set's original sits at a thin waning crescent, and the pair beside it is
  // the same framing with the second source at full strength and at nothing,
  // switched by the ephemeris at the pose's own date rather than by a flag.
  'night-1.05r',
  'night-1.05r-moonlit',
  'night-1.05r-newmoon',
  'inside-air',
];

/** The clock each pose is captured at. Earth's spin, its clouds, its
 *  terminator and — for the night poses — its Moon are all in the frame, so a
 *  golden taken at wall-clock time compares against nothing. */
const POSE_TIME: Record<string, string> = {
  // As full as the Moon gets without being eclipsed. The nearest full Moon to
  // the rest of the set is a total lunar eclipse, which is no moonlight at all.
  'night-1.05r-moonlit': '2026-04-02T02:00:00Z',   // full, phase angle 2.9 deg
  'night-1.05r-newmoon': '2026-03-19T01:00:00Z',   // new, 178.2 deg
};
const DEFAULT_TIME = '2026-03-20T12:00:00Z';       // equinox noon, 160.7 deg

// Three sessions, not two: the analytic tier, the LUT tier, and the no-float
// fallback device (?nofloat=1 — no float targets, so no composer, no bloom and
// no tables). The fallback is what the weakest hardware sees, and it is the one
// path whose look nothing else in the repo records.
const TIERS = ['analytic', 'lut', 'nofloat'];

const EARTH_RADIUS_AU = PLANETS.find((p) => p.name === 'Earth')!.radiusAU;

interface Golden {
  pose: string;
  tier: string;
  body: string;
  kRadii: number | null;
  near: number | null;
  exposure: number;
  pixelRatio: number;
  timeUtcMs: number | null;
  moonPhaseDeg: number | null;
  moonIrradiance: [number, number, number] | null;
  width: number;
  height: number;
  grid: [number, number][];
  samples: [number, number, number][];
  limbScanX: number[];
  limbScan: [number, number, number][];
}

const read = (name: string): Golden => JSON.parse(readFileSync(`${DIR}${name}.json`, 'utf8'));

const CAPTURES = [
  ...POSES.flatMap((pose) => TIERS.map((tier) => `${pose}.${tier}`)),
  // The ghost's shell is pinned to the analytic tier in code; captured so that
  // pin cannot rot unnoticed.
  'volume-compare.analytic',
];

describe('the atmosphere goldens', () => {
  it('cover every tier at every pose, plus the compare ghost', () => {
    for (const name of CAPTURES) {
      const golden = read(name);
      expect(golden.tier, name).toMatch(/^(analytic|lut|nofloat)$/);
      expect(statSync(`${DIR}${name}.png`).size, name).toBeGreaterThan(1000);
    }
  });

  it('records the pins a capture is reproducible through', () => {
    for (const pose of POSES) {
      for (const tier of TIERS) {
        const golden = read(`${pose}.${tier}`);
        expect(golden.pose).toBe(pose);
        expect(golden.body).toBe('Earth');
        // The near plane no framing hook sets, the exposure the Sun drives, the
        // ratio the display drives, and the clock that turns Earth under the
        // limb.
        expect(golden.near).toBeGreaterThan(0);
        expect(golden.exposure).toBe(1);
        expect(golden.pixelRatio).toBe(1);
        expect(golden.timeUtcMs).toBe(Date.parse(POSE_TIME[pose] ?? DEFAULT_TIME));
        expect(golden.width).toBe(512);
      }
    }
  });

  it('captures each pose through a near plane the camera is above', () => {
    // A near plane further out than the camera is high clips the ground away
    // and takes the near half of the shell with it, and the frame that comes
    // back still looks like an atmosphere — the way this goes wrong is that the
    // capture stays plausible. One value cannot serve every pose: 1e-6 AU is
    // 149.6 km, fine from 1.05 R and half the sky from 1.008 R.
    for (const pose of POSES) {
      for (const tier of TIERS) {
        const golden = read(`${pose}.${tier}`);
        const altitudeAU = (golden.kRadii! - 1) * EARTH_RADIUS_AU;
        expect(golden.kRadii, `${pose}.${tier}`).toBeGreaterThan(1);
        expect(golden.near!, `${pose}.${tier}`).toBeLessThan(altitudeAU);
      }
    }
  });

  it('carries 20 sampled radiances and a scan across the limb', () => {
    for (const name of CAPTURES) {
      const golden = read(name);
      expect(golden.samples, name).toHaveLength(20);
      expect(golden.grid, name).toHaveLength(20);
      // The scan is what tells the two tiers apart: at 8 R the whole
      // atmosphere is about one pixel wide, and a scattered grid walks
      // straight past it.
      expect(golden.limbScan, name).toHaveLength(41);
      expect(golden.limbScanX, name).toHaveLength(41);
      for (const rgb of [...golden.samples, ...golden.limbScan]) {
        expect(rgb).toHaveLength(3);
        for (const channel of rgb) {
          expect(Number.isInteger(channel)).toBe(true);
          expect(channel).toBeGreaterThanOrEqual(0);
          expect(channel).toBeLessThanOrEqual(255);
        }
      }
    }
  });

  it('holds every captured radiance to the pinned value', () => {
    // The assertion the rest of this file exists to support. A shader edit that
    // drops the entry-point shift, loses the Mie term or stops multiplying by
    // the solar irradiance changes these numbers; nothing else CI can run does.
    expect(Object.keys(ATMOSPHERE_GOLDEN_PINS).sort()).toEqual([...CAPTURES].sort());
    for (const name of CAPTURES) {
      const golden = read(name);
      const pin = ATMOSPHERE_GOLDEN_PINS[name];
      for (const field of ['samples', 'limbScan'] as const) {
        const actual = golden[field];
        const expected = pin[field];
        expect(actual.length, `${name} ${field}`).toBe(expected.length);
        for (let i = 0; i < expected.length; i++) {
          for (let c = 0; c < 3; c++) {
            const want = expected[i][c];
            expect(
              Math.abs(actual[i][c] - want),
              `${name} ${field}[${i}][${'rgb'[c]}]: ${actual[i][c]} vs pinned ${want}`,
            ).toBeLessThanOrEqual(goldenChannelTolerance(want));
          }
        }
      }
    }
  });

  it('was captured under the Moon its pose asks for', () => {
    // The night terms are fed from the live ephemeris, so what a night golden
    // records is only meaningful with the Moon it was taken under written down
    // beside it. Held against the pins for the same reason the radiances are.
    // Recorded on the tier that has a Moon. The other two draw no non-solar
    // source at all, and their captures say so with a null rather than with
    // whatever the ephemeris happened to be doing.
    expect(read('night-1.05r-moonlit.lut').moonPhaseDeg!).toBeLessThan(5);
    expect(read('night-1.05r-newmoon.lut').moonPhaseDeg!).toBeGreaterThan(175);
    expect(read('night-1.05r.lut').moonPhaseDeg!).toBeGreaterThan(150);
    for (const tier of ['analytic', 'nofloat']) {
      expect(read(`night-1.05r-moonlit.${tier}`).moonPhaseDeg, tier).toBeNull();
    }
    for (const name of CAPTURES) {
      const actual = read(name).moonPhaseDeg;
      const pinned = ATMOSPHERE_GOLDEN_PINS[name].moonPhaseDeg;
      if (pinned === null || actual === null) expect(actual, name).toBe(pinned);
      // The pin file carries four decimals of a degree, which is 400 metres of
      // the Moon's orbit and far finer than anything the frame shows.
      else expect(actual, name).toBeCloseTo(pinned, 3);
    }
  });

  it('shows the Moon lighting the night side it stands over', () => {
    // The two night dates frame different ground — the Earth has turned between
    // them — so what separates them is not one being brighter than the other.
    // It is how much the LUT tier ADDS over the analytic one at the same pose
    // and the same instant: at full Moon that is airglow plus moonlight, at new
    // Moon it is airglow and the sky's own ambient alone.
    const lit = (name: string): number =>
      read(name).samples.reduce((a, [r, g, b]) => a + r + g + b, 0);
    const added = (pose: string): number => lit(`${pose}.lut`) - lit(`${pose}.analytic`);
    expect(added('night-1.05r-moonlit')).toBeGreaterThan(added('night-1.05r-newmoon'));
    expect(added('night-1.05r-moonlit')).toBeGreaterThan(0);
  });

  it('pins the near plane each capture was taken with', () => {
    for (const name of CAPTURES) {
      expect(read(name).near, name).toBe(ATMOSPHERE_GOLDEN_PINS[name].near);
    }
  });

  it('was captured through the shader text pinned here', () => {
    // The half of the contract CI can check without a GPU. The pinned radiances
    // above only move when someone re-runs the capture tool, so on their own
    // they let a shader edit through until the next capture; this hash fails on
    // the edit itself. The two are one pair: change the shell's GLSL and this
    // breaks, re-capture and the radiances break, and the only diff that lands
    // green is one that moves the shader, the captures and the pins together.
    const hash = (glsl: string): string => createHash('sha256').update(glsl).digest('hex');
    const shell = createAtmosphereShellMaterial({
      planetRadius: 4.2635e-5, body: 'Earth', sizes: ATMOSPHERE_TABLE_SIZES_FULL,
    });
    // Table sizes are defines, not text, so one hash covers every profile and
    // every body — the same property that lets one warm-up probe cover them.
    expect(hash(shell.vertexShader))
      .toBe('604724ecd98c07ab9465d5cce0bbc7285e1ed2627fe5f2d7b69ec6ddbba3b1fc');
    expect(hash(shell.fragmentShader))
      .toBe('8972702a1ba500a2d8c045c2c9917087d3fefe4aa3e7baffc172950b1610f0f1');
  });

  it('shows the LUT tier drawing a different limb from the analytic one', () => {
    // Not a threshold on the look — that is the local image gate's job. This
    // only holds that the two tiers ARE two tiers: a capture pair that came
    // back identical would mean the swap never happened and the goldens are
    // recording the fallback twice.
    const sum = (g: Golden): number => g.limbScan.reduce((a, [r, gr, b]) => a + r + gr + b, 0);
    const differing = POSES.filter(
      (pose) => sum(read(`${pose}.analytic`)) !== sum(read(`${pose}.lut`)),
    );
    expect(differing.length).toBeGreaterThanOrEqual(3);
  });
});
