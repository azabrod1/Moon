import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ATMOSPHERE_GOLDEN_PINS, goldenChannelTolerance } from './atmosphereGoldens.pinned';
import { ATMOSPHERE_GOLDEN_CONTROL_PINS } from './atmosphereGoldens.mieexact0.pinned';
import { ATMOSPHERE_TABLE_SIZES_FULL } from './atmosphereModel';
import { createAtmosphereShellMaterial } from './atmosphereShell';
import { PLANETS } from '../planets/planetData';
import { MOONS } from '../planets/moonData';

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
 *
 * Two sets. The SHIPPED set (tools/goldens/atmosphere, atmosphereGoldens.pinned)
 * is every pose on every tier through the program the app ships, single Mie's
 * exact colour on (world/atmosphereLut MIE_EXACT). The CONTROL set
 * (tools/goldens/atmosphere-mieexact0, atmosphereGoldens.mieexact0.pinned) is
 * every pose on the LUT tier under `?mieexact=0`, the colour rebuilt from the
 * scattering table's rgb: the arm the goldens were captured through before the
 * colour table existed. The switch reaches only the table lookups, so only the
 * LUT tier has a control. A change that moves the shipped set and not the
 * control moved the exact colour; one that moves both moved something else.
 * Each capture records the arm its session compiled (`mieExact`), and each set
 * is held to the arm it says it is.
 */
const DIR = fileURLToPath(new URL('../../../tools/goldens/atmosphere/', import.meta.url));
const CONTROL_DIR = fileURLToPath(new URL('../../../tools/goldens/atmosphere-mieexact0/', import.meta.url));

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
  // The same framing under a gibbous Moon standing 30 degrees over the
  // terminator: past the terminator the Sun's own light on the ground is gone,
  // so what weights the Moon's is the whole of how the crossing reads.
  'terminator-1.5r-gibbous',
  // The night side under three Moons. A night pose is a pose AND a Moon: the
  // set's original sits at a thin waning crescent, and the pair beside it is
  // the same framing with the second source at full strength and at nothing,
  // switched by the ephemeris at the pose's own date rather than by a flag.
  'night-1.05r',
  'night-1.05r-moonlit',
  'night-1.05r-newmoon',
  // A total solar eclipse with the umbra on the day disc: the one pose where
  // the shadow the ground and the air in front of it share is measured rather
  // than argued from the uniforms they read it out of.
  'eclipse-2.5r',
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
  // Gibbous: 30.7 degrees of phase, which is also how high it stands over the
  // brightest point of the terminator the frame is looking at.
  'terminator-1.5r-gibbous': '2026-03-30T12:00:00Z',
  // Central total eclipse, gamma 0.14: the umbra lands near the sub-solar
  // point rather than out by the limb, and the Moon is close enough that the
  // umbra reaches the ground at all — an annular eclipse feeds no caster.
  'eclipse-2.5r': '2027-08-02T10:06:00Z',
};
const DEFAULT_TIME = '2026-03-20T12:00:00Z';       // equinox noon, 160.7 deg

// Three sessions, not two: the analytic tier, the LUT tier, and the no-float
// fallback device (?nofloat=1 — no float targets, so no composer, no bloom and
// no tables). The fallback is what the weakest hardware sees, and it is the one
// path whose look nothing else in the repo records.
const TIERS = ['analytic', 'lut', 'nofloat'];

const EARTH_RADIUS_AU = PLANETS.find((p) => p.name === 'Earth')!.radiusAU;
const SUN_RADIUS_AU = 695_700 / 149_597_870.7;

interface Golden {
  pose: string;
  tier: string;
  mieExact: boolean | null;
  body: string;
  kRadii: number | null;
  near: number | null;
  exposure: number;
  pixelRatio: number;
  timeUtcMs: number | null;
  moonPhaseDeg: number | null;
  moonIrradiance: [number, number, number] | null;
  casterCount: number;
  casters: [number, number, number, number][];
  cloudFrameSpin: number | null;
  width: number;
  height: number;
  grid: [number, number][];
  samples: [number, number, number][];
  limbScanX: number[];
  limbScan: [number, number, number][];
}

const read = (name: string): Golden => JSON.parse(readFileSync(`${DIR}${name}.json`, 'utf8'));
const readControl = (name: string): Golden => JSON.parse(readFileSync(`${CONTROL_DIR}${name}.json`, 'utf8'));

/** Every sampled channel of a capture against its pin, at the set's tolerance. */
function holdToPins(
  name: string,
  golden: Golden,
  pin: { samples: readonly (readonly number[])[]; limbScan: readonly (readonly number[])[] },
): void {
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
    for (const name of CAPTURES) holdToPins(name, read(name), ATMOSPHERE_GOLDEN_PINS[name]);
  });

  it('was captured through the arm the app ships', () => {
    // The tables' lookups read single Mie's exact colour unless `?mieexact=0`:
    // every LUT capture here says its session compiled that arm, and the
    // no-float tier, which has no tables, says nothing.
    for (const pose of POSES) {
      expect(read(`${pose}.lut`).mieExact, pose).toBe(true);
      expect(ATMOSPHERE_GOLDEN_PINS[`${pose}.lut`].mieExact, pose).toBe(true);
      expect(read(`${pose}.nofloat`).mieExact, pose).toBeNull();
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

  it('lights the terminator band under a Moon standing over it', () => {
    // The Moon's PHASE ANGLE is how high it stands over the highest point of
    // the terminator: the terminator is 90 degrees from the sub-solar point and
    // the Moon is (180 - phase) from it. So this pose is a Moon 30.7 degrees up
    // over the band the frame is looking at, which is the configuration the
    // Moon's own weight and the Sun's disagree about.
    const gibbous = read('terminator-1.5r-gibbous.lut');
    expect(gibbous.moonPhaseDeg!).toBeGreaterThan(25);
    expect(gibbous.moonPhaseDeg!).toBeLessThan(35);
    // Weighted by the SUN's elevation the Moon's light arrives 14.5 degrees
    // late and the ground in between is black. The three grid points along the
    // bottom of the terminator band are where that shows: the middle one reads
    // 0,0,0 with the Sun's weight and is lit on the Moon's own.
    for (const i of [17, 18, 19]) {
      const rgb = gibbous.samples[i];
      expect(Math.max(...rgb), `sample ${i} of the terminator band`).toBeGreaterThan(0);
    }
    // And it is the Moon doing it: wherever the tier with no second source at
    // all is dark among those points, the LUT tier is lit. Point 17 is not one
    // of them — the analytic tier still has sunlight there, and on the LUT
    // tier the Sun's own path through the air (surfaceShading SUN_PATH) has
    // put it out (with `?sunpath=0` it reads 58,57,59), which is the Sun's term
    // and not the Moon's.
    const analytic = read('terminator-1.5r-gibbous.analytic');
    const dark = [17, 18, 19].filter((i) => Math.max(...analytic.samples[i]) <= 2);
    expect(dark.length).toBeGreaterThanOrEqual(2);
    for (const i of dark) {
      expect(Math.max(...gibbous.samples[i]), `sample ${i}, dark without the Moon`)
        .toBeGreaterThan(Math.max(...analytic.samples[i]) + 2);
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

  it('caught a moon\'s umbra on the ground, at one pose and only there', () => {
    // Two commits argued the eclipse from shared uniforms and a shared GLSL
    // function: the ground and the air in front of it dim by one number, and
    // the deck above them traces the same casters in the same frame. This is
    // the frame where a caster was actually there. Everything downstream of it
    // — the spot on the ground, the spot on the haze, the spot on the clouds —
    // lands in the pinned radiances.
    const eclipse = read('eclipse-2.5r.lut');
    expect(eclipse.casterCount).toBe(1);
    const moon = MOONS.find((m) => m.name === 'Moon')!;
    expect(eclipse.casters[0][3]).toBeCloseTo(moon.radiusAU, 12);
    // And a TOTAL one, which is the only kind that casts an umbra at all: the
    // Moon has to be near enough that its shadow cone still has width where
    // Earth is. At the Sun's angular size from here that is inside about
    // 379 000 km, against a mean distance of 384 400 — the pose is not just a
    // new Moon, it is a close one.
    const centre = eclipse.casters[0];
    const distanceAU = Math.hypot(centre[0], centre[1], centre[2]);
    const sunAngularRadius = SUN_RADIUS_AU / 1.015;   // Earth in early August
    expect(distanceAU).toBeLessThan(moon.radiusAU / sunAngularRadius);
    expect(distanceAU).toBeGreaterThan(0.0022);
  });

  it('records the frame the cloud deck was drawn in', () => {
    // The deck carries a drift of its own on top of the body's spin, so its
    // object space is that far out of the frame the caster centres are stated
    // in. Unfed — or fed with the wrong sign — the umbra on the clouds lands at
    // a longitude of its own, beside the one on the ground. The correction is a
    // rotation nothing in a capture would otherwise record.
    for (const name of CAPTURES) {
      const golden = read(name);
      const pinned = ATMOSPHERE_GOLDEN_PINS[name];
      expect(golden.casterCount, name).toBe(pinned.casterCount);
      if (pinned.cloudFrameSpin === null) expect(golden.cloudFrameSpin, name).toBeNull();
      else expect(golden.cloudFrameSpin!, name).toBeCloseTo(pinned.cloudFrameSpin, 5);
    }
    // It is a real rotation at the eclipse pose, not a zero that would make the
    // correction untested.
    expect(Math.abs(read('eclipse-2.5r.lut').cloudFrameSpin!)).toBeGreaterThan(0.01);
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
    //
    // The captures are taken with the night-side exposure rule off
    // (`--extra='&nightexposure=0'`, world/nightExposure). The rule is a
    // camera's metering on top of the shader's night terms, not a change to
    // them, and it would meter these poses by how much sunlit ground they
    // hold: the terminator poses at 1.5 R are half lit, which is a day
    // exposure and a night side with no light of its own at all. With it off
    // every slot is 1 and the radiances are the shader's own night terms —
    // what these pins exist to hold.
    const hash = (glsl: string): string => createHash('sha256').update(glsl).digest('hex');
    const shell = createAtmosphereShellMaterial({
      planetRadius: 4.2635e-5, body: 'Earth', sizes: ATMOSPHERE_TABLE_SIZES_FULL,
    });
    // Table sizes are defines, not text, so one hash covers every profile and
    // every body — the same property that lets one warm-up probe cover them.
    // The text carries both readings of the single-Mie colour (MIE_EXACT,
    // world/atmosphereLut), so this one hash stands behind both sets: the
    // shipped set captured through the define on, the control set through it
    // off (`?mieexact=0`, the text aerialPerspective.test.ts pins at e613114e…).
    expect(hash(shell.vertexShader))
      .toBe('604724ecd98c07ab9465d5cce0bbc7285e1ed2627fe5f2d7b69ec6ddbba3b1fc');
    expect(hash(shell.fragmentShader))
      .toBe('2381bcdaf0c1b86879aed4c1782f68a33f718c113dd9d659f298af5075e0411b');
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

describe('the ?mieexact=0 control set', () => {
  const CONTROL = POSES.map((pose) => `${pose}.lut`);

  it('covers every pose on the LUT tier, through the arm it says it is', () => {
    expect(Object.keys(ATMOSPHERE_GOLDEN_CONTROL_PINS).sort()).toEqual([...CONTROL].sort());
    for (const name of CONTROL) {
      const golden = readControl(name);
      expect(golden.tier, name).toBe('lut');
      expect(golden.mieExact, name).toBe(false);
      expect(ATMOSPHERE_GOLDEN_CONTROL_PINS[name].mieExact, name).toBe(false);
      expect(statSync(`${CONTROL_DIR}${name}.png`).size, name).toBeGreaterThan(1000);
      expect(golden.samples, name).toHaveLength(20);
      expect(golden.limbScan, name).toHaveLength(41);
    }
  });

  it('was captured at the shipped set\'s own pose, clock, near plane, exposure and ratio', () => {
    // A control that differs in anything but the switch is a control of nothing.
    for (const name of CONTROL) {
      const control = readControl(name);
      const shipped = read(name);
      for (const field of ['pose', 'body', 'kRadii', 'near', 'exposure', 'pixelRatio', 'timeUtcMs', 'width', 'height'] as const) {
        expect(control[field], `${name} ${field}`).toEqual(shipped[field]);
      }
      expect(control.moonPhaseDeg!, name).toBeCloseTo(shipped.moonPhaseDeg!, 3);
      expect(control.casterCount, name).toBe(shipped.casterCount);
    }
  });

  it('holds every control radiance to its own pins', () => {
    for (const name of CONTROL) holdToPins(name, readControl(name), ATMOSPHERE_GOLDEN_CONTROL_PINS[name]);
  });

  it('sits a little brighter in green and blue than the shipped arm, which is what the exact colour corrects', () => {
    // Rebuilt from rgb, single Mie's green and blue come out too bright, most
    // in the lowest twilight band. In these frames the difference is small —
    // a step or two of 8 bits where it shows, chiefly in the ground's aerial
    // perspective toward the limb — and in blue it is one-sided: summed over
    // every sampled point of every pose, the control's blue is higher, its
    // green within a few steps of even (8 up before the ozone correction of
    // 2026-10-09, 0 after: the nadir pose runs the other way), and its red,
    // which both arms read from the same texel, is not.
    const sum = (g: Golden, c: number): number =>
      [...g.samples, ...g.limbScan].reduce((a, rgb) => a + rgb[c], 0);
    let red = 0, green = 0, blue = 0, differing = 0, redStep = 0;
    for (const name of CONTROL) {
      const control = readControl(name);
      const shipped = read(name);
      red += sum(control, 0) - sum(shipped, 0);
      green += sum(control, 1) - sum(shipped, 1);
      blue += sum(control, 2) - sum(shipped, 2);
      if (JSON.stringify([control.samples, control.limbScan]) !== JSON.stringify([shipped.samples, shipped.limbScan])) differing++;
      [...control.samples, ...control.limbScan].forEach((rgb, i) => {
        const other = [...shipped.samples, ...shipped.limbScan][i];
        redStep = Math.max(redStep, Math.abs(rgb[0] - other[0]));
      });
    }
    expect(differing).toBeGreaterThanOrEqual(5);
    expect(Math.abs(green)).toBeLessThan(20);
    expect(blue).toBeGreaterThan(0);
    // The two sets are two browser sessions, and a sampled point that sits on
    // a rounding edge flips by one step between them (the re-record of
    // 2026-10-09 flipped five of 671 red values by one, three of them in the
    // near band's beam). So red is held to single steps and a sum of a few,
    // well under the green and blue the control adds.
    expect(redStep).toBeLessThanOrEqual(1);
    expect(Math.abs(red)).toBeLessThanOrEqual(5);
  });
});
