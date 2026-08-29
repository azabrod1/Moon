import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  AIRGLOW_LIMB_CAP,
  AIRGLOW_SPECS,
  MOONLIGHT_NIGHT_GAIN,
  MOONLIGHT_SOURCES,
  MOON_SPECTRUM,
  MOON_UP_FULL_SIN,
  MOON_UP_GLSL,
  MULTIPLE_SCATTERING_HEADROOM,
  PEAK_REACHABLE_SKY_RADIANCE,
  NIGHT_WEIGHT_FULL_SIN,
  NIGHT_WEIGHT_GLSL,
  NIGHT_WEIGHT_ZERO_SIN,
  LUNAR_IRRADIANCE_RATIO,
  PEAK_TABLE_SKY_RADIANCE,
  airglowLimbFactor,
  airglowRadiance,
  airglowUniforms,
  lunarPhaseBrightness,
  moonIrradiance,
  moonUpWeight,
  nightWeight,
} from './nightSources';
import {
  AIRLIGHT_SCALE,
  ATMOSPHERE_TABLE_SIZES_FULL,
  atmosphereParams,
  computeIndirectIrradianceOrder1,
  rayIntersectsGround,
  singleScatteringRadiance,
} from './atmosphereModel';
import { createAtmosphereShellMaterial } from './atmosphereShell';
import { NIGHT_FILL, NIGHT_FLOOR_FRACTION, augmentSurfaceMaterial } from './surfaceShading';
import { BLOOM_THRESHOLD } from '../../app/bloomConfig';
import { PLANETS } from '../planets/planetData';

/**
 * The night side's sources: the shared weight that fades all of them, the
 * airglow layer, the Moon as a second light, and the promise that none of them
 * blooms.
 */
const src = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

/** The injected surface shader, as three would assemble it. */
function surfaceFragment(): string {
  const mat = new THREE.MeshStandardMaterial();
  augmentSurfaceMaterial(mat, 'earth');
  const shader = {
    uniforms: {} as Record<string, THREE.IUniform>,
    vertexShader: '#include <common>\nvoid main() {\n#include <begin_vertex>\n}',
    fragmentShader: '#include <common>\nvoid main() {\n#include <opaque_fragment>\n}',
  };
  (mat.onBeforeCompile as (s: typeof shader) => void)(shader);
  return shader.fragmentShader;
}

const shellFragment = (): string => createAtmosphereShellMaterial({
  planetRadius: 4.2635e-5, body: 'Earth', sizes: ATMOSPHERE_TABLE_SIZES_FULL,
}).fragmentShader;

describe('the shared night weight', () => {
  it('holds its shape at the four elevations either side of the terminator', () => {
    // Full strength once the Sun is 14.5 degrees down, gone once it is 2.9 up.
    expect(nightWeight(-0.3)).toBe(1);
    expect(nightWeight(-0.1)).toBeCloseTo(0.5, 12);
    expect(nightWeight(0)).toBeCloseTo(0.074074, 6);
    expect(nightWeight(0.1)).toBe(0);
  });

  it('is monotone and continuous across the whole range', () => {
    let previous = nightWeight(-1);
    expect(previous).toBe(1);
    for (let i = 1; i <= 2000; i++) {
      const value = nightWeight(-1 + (2 * i) / 2000);
      expect(value).toBeLessThanOrEqual(previous + 1e-12);
      // C0: no step bigger than the sampling can explain. The whole point of
      // one shared ramp is that nothing switches on along a line of its own,
      // and a discontinuity would be exactly that line.
      expect(Math.abs(value - previous)).toBeLessThan(0.01);
      previous = value;
    }
    expect(previous).toBe(0);
    // Flat on both sides of the ramp, so the weight cannot go negative or
    // overshoot where a source is meant to be at full strength.
    expect(nightWeight(-0.9)).toBe(1);
    expect(nightWeight(0.9)).toBe(0);
  });

  it('is one function in two languages, from one pair of edges', () => {
    // The GLSL is generated from the same constants, so this holds that the
    // generation happened rather than that someone typed the numbers twice.
    expect(NIGHT_WEIGHT_GLSL).toContain(
      `smoothstep(${NIGHT_WEIGHT_FULL_SIN.toFixed(6)}, ${NIGHT_WEIGHT_ZERO_SIN.toFixed(6)}, sunElevSin)`,
    );
    expect(NIGHT_WEIGHT_FULL_SIN).toBeLessThan(NIGHT_WEIGHT_ZERO_SIN);
    // And every shader that draws a night source carries it.
    for (const glsl of [shellFragment(), surfaceFragment()]) {
      expect(glsl).toContain(NIGHT_WEIGHT_GLSL);
      expect(glsl.match(/float nightWeight\(float sunElevSin\)/g)).toHaveLength(1);
    }
  });

  it('is what the sources the daylight sky drowns are multiplied by', () => {
    const shell = shellFragment();
    // The shell reads it at the ray's LOWEST point — the deepest air the ray
    // crosses — and hands the one value to the airglow and to the Moon.
    expect(shell).toContain('vec3 lowest = camera + view * max(-rmuCam, 0.0);');
    expect(shell).toContain('float night = nightWeight(clampCosine(dot(normalize(lowest), sun)));');
    expect(shell).toContain('airglowRadiance(camera, view, night)');
    expect(shell).toContain(
      'float moonNight = night * moonUpWeight(clampCosine(dot(normalize(lowest), moon)));',
    );
    // The surfaces read it at the fragment, off the same geometry the air does.
    const surface = surfaceFragment();
    expect(surface).toContain(
      'nightWeight(clampCosine(dot(up, normalize(uSunDirWorld))))',
    );
    expect(surface).toContain('vec3 up = normalize(vAirFrag);');
    expect(surface).toContain('if (airNight > 0.0) {');
  });
});

describe('the Moon\u2019s own weight', () => {
  it('is nothing with the Moon down, all of it with the Moon up', () => {
    expect(moonUpWeight(-1)).toBe(0);
    expect(moonUpWeight(-0.01)).toBe(0);
    expect(moonUpWeight(0)).toBe(0);
    expect(moonUpWeight(MOON_UP_FULL_SIN / 2)).toBeCloseTo(0.5, 12);
    expect(moonUpWeight(MOON_UP_FULL_SIN)).toBe(1);
    expect(moonUpWeight(1)).toBe(1);
    // Monotone and C0 over the whole range, like the weight beside it: a step
    // here would draw a line across the ground at one lunar altitude.
    let previous = 0;
    for (let i = 0; i <= 2000; i++) {
      const value = moonUpWeight(-1 + (2 * i) / 2000);
      expect(value).toBeGreaterThanOrEqual(previous - 1e-12);
      // C0: no step bigger than the sampling can explain across a ramp this
      // narrow (1.5 x 0.001 / 0.05 at its steepest).
      expect(Math.abs(value - previous)).toBeLessThan(0.04);
      previous = value;
    }
  });

  it('is one function in two languages, from one edge', () => {
    expect(MOON_UP_GLSL).toContain(
      `smoothstep(0.0, ${MOON_UP_FULL_SIN.toFixed(6)}, moonElevSin)`,
    );
    for (const glsl of [shellFragment(), surfaceFragment()]) {
      expect(glsl).toContain(MOON_UP_GLSL);
      expect(glsl.match(/float moonUpWeight\(float moonElevSin\)/g)).toHaveLength(1);
    }
  });

  it('is what the Moon\u2019s own terms ride, and the Sun\u2019s weight is not', () => {
    const surface = surfaceFragment();
    // Every moon-sourced term on a surface: the beam, the moonlit sky's
    // irradiance on the ground, and the moonlight scattered into the column in
    // front of it. None of them may be multiplied by airNight.
    expect(surface).toContain(
      'moonUpWeight(clampCosine(dot(up, normalize(uMoonDirWorld))))\n          * (1.0 - dayFactor) * nightKeep',
    );
    expect(surface).toContain(
      'outgoingLight += diffuseColor.rgb * RECIPROCAL_PI * (moonAmbient + moonDirect) * moonNight;',
    );
    expect(surface).toContain('* uMoonIrradiance * moonNight;');
    expect(surface).not.toContain('* uMoonIrradiance * airNight');
    expect(surface).not.toContain('uMoonIrradiance;\n    vec3 direct');
  });

  it('lifts the terminator out of the trough the Sun\u2019s weight puts it in', () => {
    // A gibbous Moon 30 degrees up over the terminator, which is the
    // configuration the two weights disagree about: the Sun's own light on the
    // ground has gone at the terminator and the Moon's is only half arrived, so
    // gating the Moon by the SUN's elevation leaves a band of ground darker
    // than the ground either side of it. Units: the scene's own irradiance,
    // with the Lambertian albedo/pi common to both terms divided out.
    const term = NIGHT_FILL.earth.termWidth;
    const moonElevSin = Math.sin((30 * Math.PI) / 180);
    const moon = moonIrradiance(1, 30)[1] * moonElevSin;
    const sun = (sunElevSin: number): number => AIRLIGHT_SCALE[1] * Math.max(sunElevSin, 0);
    const dayFactor = (s: number): number => {
      const t = Math.min(1, Math.max(0, (s + term) / (2 * term)));
      return t * t * (3 - 2 * t);
    };
    // Sun 15 degrees up to 20 degrees down, which covers both ramps.
    const sweep = (weight: (s: number) => number): number[] => {
      const out: number[] = [];
      for (let i = 0; i <= 200; i++) {
        const s = Math.sin(((15 - (i * 35) / 200) * Math.PI) / 180);
        out.push(sun(s) + moon * weight(s));
      }
      return out;
    };
    // How far the darkest point of the crossing falls below the fully night
    // ground either side of it. 1 is a crossing with no dip in it at all.
    const trough = (profile: number[]): number =>
      profile[profile.length - 1] / Math.min(...profile);
    const withSun = sweep((s) => nightWeight(s) * moonUpWeight(moonElevSin));
    const withMoon = sweep((s) => (1 - dayFactor(s)) * moonUpWeight(moonElevSin));
    // Deep night is the same under both — the disagreement is all in the band.
    expect(withMoon[withMoon.length - 1]).toBeCloseTo(withSun[withSun.length - 1], 12);
    // The Sun's weight digs a hole in the middle of the crossing: at the
    // terminator the ground is thirteen times darker than the same ground
    // fifteen degrees further into the night, with the Moon standing over both.
    expect(trough(withSun)).toBeGreaterThan(12);
    // The Moon's own weight fills most of it in. What is left is not nothing,
    // and it cannot be: the Sun's light on the ground reaches zero exactly at
    // the terminator while the Moon's is still halfway up its ramp, so the sum
    // dips there by a factor of two whatever the ramp's shape. Making the
    // crossing monotone needs a weight that is already at full strength at the
    // terminator — a one-sided ramp — not a narrower one.
    expect(trough(withMoon)).toBeLessThan(2.2);
    expect(trough(withSun) / trough(withMoon)).toBeGreaterThan(6);
  });
});

describe('airglow', () => {
  const EARTH_RADIUS_KM = PLANETS.find((p) => p.name === 'Earth')!.radiusKm;
  const bands = airglowUniforms('Earth').bands;

  it('sits in the layer the emission comes from', () => {
    const spec = AIRGLOW_SPECS.Earth;
    expect(spec.greenKm).toEqual([90, 100]);
    expect(bands[0]).toBeCloseTo(1 + 90 / EARTH_RADIUS_KM, 12);
    expect(bands[1]).toBeCloseTo(1 + 100 / EARTH_RADIUS_KM, 12);
    // The orange fringe is above the green one and inside the shell mesh
    // (1.02 R), which is the constraint that put it there rather than at the
    // 250 km the 630 nm line really comes from.
    expect(bands[2]).toBeGreaterThanOrEqual(bands[1]);
    expect(bands[3]).toBeLessThan(1.02);
  });

  // A ray from d that grazes the sphere of radius b: the impact parameter is
  // what decides how much of the layer it runs through.
  const grazing = (d: number, b: number): [number, number, number] => {
    const sin = b / d;
    return [-Math.sqrt(1 - sin * sin), sin, 0];
  };

  it('is a thin layer straight down and a bright thread edge-on', () => {
    // Straight up from inside: one vertical crossing, which is the unit.
    expect(airglowLimbFactor([1.0001, 0, 0], [1, 0, 0], bands[0], bands[1]))
      .toBeCloseTo(1, 6);
    // Straight down from 1.05 R the line crosses the layer twice, near side and
    // far. Only the geometry says so — the shell gives up on a ray that ends on
    // the ground before it ever asks.
    expect(airglowLimbFactor([1.05, 0, 0], [-1, 0, 0], bands[0], bands[1]))
      .toBeCloseTo(2, 6);
    // Tangent to the middle of the layer from the same altitude: the same
    // 10 km of air, run along instead of across.
    const b = (bands[0] + bands[1]) / 2;
    const view = grazing(1.05, b);
    const limb = airglowLimbFactor([1.05, 0, 0], view, bands[0], bands[1]);
    expect(limb).toBeGreaterThan(10);
    expect(limb).toBeLessThanOrEqual(AIRGLOW_LIMB_CAP);
    // The cap is a cap: the geometric factor for a tangent ray through a 10 km
    // slab at this radius is ~50, and the layer's own profile is why it is held.
    expect(airglowLimbFactor([1.05, 0, 0], view, bands[0], bands[1], 1000))
      .toBeGreaterThan(40);
  });

  it('draws nothing where the Sun is up, on the same limb ray', () => {
    const b = (bands[0] + bands[1]) / 2;
    const d = 1.05;
    const view = grazing(d, b);
    // Sun overhead at the ray's lowest point: the day limb, where the airglow
    // is 1e7 times under the sky it would be drawn over.
    expect(airglowRadiance('Earth', [d, 0, 0], view, 1)).toEqual([0, 0, 0]);
    expect(airglowRadiance('Earth', [d, 0, 0], view, 0.06)).toEqual([0, 0, 0]);
    // ...and everything at night.
    const night = airglowRadiance('Earth', [d, 0, 0], view, -0.4);
    // A thin thread, not a rim: 6.5e-3 of linear radiance once the limb has
    // stretched it, which through ACES at exposure 1 is four 8-bit steps over
    // the black behind it, and a twentieth of that seen from above.
    expect(night[1]).toBeGreaterThan(0.004);
    expect(night[1]).toBeLessThan(0.02);
    // Green line over an orange fringe: the green channel leads.
    expect(night[1]).toBeGreaterThan(night[0]);
  });

  it('is off, and costs nothing, on a body with no airglow authored', () => {
    const mars = airglowUniforms('Mars');
    expect(mars.bands).toEqual([0, 0, 0, 0]);
    expect(mars.green).toEqual([0, 0, 0]);
    expect(airglowRadiance('Mars', [1.05, 0, 0], [-1, 0, 0], -1)).toEqual([0, 0, 0]);
  });

  it('is computed on rays that never reach the air', () => {
    // The 630 nm fringe sits above the modelled top, so the airglow has to be
    // worked out before the branch that gives up on rays which miss it — a
    // shader that returns early there draws the green line and loses the fringe.
    const shell = shellFragment();
    const airglowAt = shell.indexOf('vec3 radiance = airglowRadiance(');
    const airBranchAt = shell.indexOf('bool inAir = true;');
    expect(airglowAt).toBeGreaterThan(0);
    expect(airglowAt).toBeLessThan(airBranchAt);
    expect(shell).toContain('inAir = false;                        // misses the air');
    // And it is emitted, not scattered: no eclipse dims it, no solar
    // irradiance scales it.
    expect(shell).toMatch(/vec3 radiance = airglowRadiance\(camera, view, night\);/);
  });
});

describe('moonlight', () => {
  it('follows the phase curve, and reaches zero at new Moon', () => {
    expect(lunarPhaseBrightness(0)).toBeCloseTo(1, 12);
    // A quarter Moon is a ninth of a full one, not a half: the surface
    // back-scatters, which is why the illuminated fraction is the wrong curve.
    expect(lunarPhaseBrightness(90)).toBeCloseTo(0.0910, 4);
    expect(lunarPhaseBrightness(180)).toBe(0);
    expect(lunarPhaseBrightness(-90)).toBeCloseTo(lunarPhaseBrightness(90), 12);
    // Monotone from full to new.
    let previous = 1;
    for (let a = 1; a <= 180; a++) {
      const value = lunarPhaseBrightness(a);
      expect(value).toBeLessThanOrEqual(previous);
      previous = value;
    }
  });

  it('is the physical ratio times a stated exposure gain, and says which is which', () => {
    expect(LUNAR_IRRADIANCE_RATIO).toBeCloseTo(1 / 4.4e5, 12);
    const full = moonIrradiance(1, 0);
    // Green carries the bridge unchanged; the spectrum only reddens it.
    expect(full[1]).toBeCloseTo(
      AIRLIGHT_SCALE[1] * LUNAR_IRRADIANCE_RATIO * MOONLIGHT_NIGHT_GAIN, 12,
    );
    expect(MOON_SPECTRUM[2]).toBeLessThan(MOON_SPECTRUM[1]);
    expect(MOON_SPECTRUM[0]).toBeGreaterThan(MOON_SPECTRUM[1]);
    // Blue relative to green, against the same ratio for the Sun's own light:
    // lunar light is the redder of the two.
    expect(full[2] / full[1]).toBeLessThan(AIRLIGHT_SCALE[2] / AIRLIGHT_SCALE[1]);
  });

  it('goes out with the Moon: new, eclipsed, or a planet without one', () => {
    expect(moonIrradiance(1, 180)).toEqual([0, 0, 0]);
    expect(moonIrradiance(1, 0, 0)).toEqual([0, 0, 0]);
    // Half out of the umbra is half the light.
    expect(moonIrradiance(1, 0, 0.5)[1]).toBeCloseTo(moonIrradiance(1, 0)[1] / 2, 12);
    // And a body further from the Sun gets a proportionally dimmer Moon,
    // through the same distance law the ground under it is lit by.
    expect(moonIrradiance(0.5, 0)[1]).toBeCloseTo(moonIrradiance(1, 0)[1] / 2, 12);
    expect(MOONLIGHT_SOURCES).toEqual({ Earth: 'Moon' });
  });

  it('is fed from the live ephemeris, with the phase and the eclipse in it', () => {
    const mode = src('../PlanetariumMode.ts');
    expect(mode).toContain('this.syncMoonlight(planet);');
    expect(mode).toContain('const phaseDeg = Math.acos(Math.min(1, Math.max(-1, cosPhase))) * RAD2DEG;');
    expect(mode).toContain('this.moonlightShading.sunVisibleFraction,');
    // One object per body, so the shell and every surface read the same Moon.
    expect(src('./atmosphereShell.ts')).toContain(
      'uMoonDirWorld: options.fx?.air?.uMoonDirWorld',
    );
  });

  it('is a second lookup on one traversal, in both consumers', () => {
    const shell = shellFragment();
    // Two lookups into the table, one per source; the rest of the matches are
    // the lookup GLSL's own definitions.
    expect(shell.match(/getScattering3DRGBA\(\s+uScattering/g)).toHaveLength(2);
    expect(shell).toContain('if (night > 0.0 && uMoonIrradiance.g > 0.0) {');
    const surface = surfaceFragment();
    expect(surface).toContain('aerialForLight(seg, normalize(uMoonDirWorld))');
    // The transmittance of the segment is the camera's, not the source's: one
    // path, two lights.
    expect(surface).toContain('aerialInscatter(uScattering, aerialForLight(seg, normalize(uMoonDirWorld)), airT)');
  });
});

describe('the night ground', () => {
  it('keeps the authored fill as a floor under the table\u2019s own ambient', () => {
    const surface = surfaceFragment();
    // max(), not a sum and not a swap. A sum lifts one fragment through two
    // models of the same thing; a swap lets the tier WITH the tables come out
    // darker than the tier without them, which inverts the direction of every
    // other tier difference in the app.
    expect(surface).toContain('outgoingLight += max(nightAmbient, nightFloor);');
    expect(surface).toContain(
      `* (uNightStrength * (1.0 - dayFactor) * nightKeep * ${NIGHT_FLOOR_FRACTION.toFixed(6)});`,
    );
    // The floor is the authored fill itself at fraction 1: the look with no
    // tables is the reference the tier with them may not go under.
    expect(NIGHT_FLOOR_FRACTION).toBeGreaterThan(0);
    expect(NIGHT_FLOOR_FRACTION).toBeLessThanOrEqual(1);
    // ...and the table's own ambient is what lifts it above that floor.
    expect(surface).toContain('getIrradiance(uIrradiance, rFrag, muSSun)');
    expect(surface).toContain('nightAmbient = diffuseColor.rgb * RECIPROCAL_PI');
    // The ambient is a night term: by day the ground is lit by the point light
    // and nothing here touches it.
    expect(surface).toContain('float airNight = uAirDensity > 0.0');
  });

  it('is the same fill it always was wherever there is no air', () => {
    // The floor's scalar with the air off has to be the fill's own value to the
    // bit, or the analytic tier and the fallback device move: `uAirDensity` is
    // gone from the expression, and what replaced it multiplies by exactly one.
    const surface = surfaceFragment();
    expect(surface).not.toContain('(1.0 - uAirDensity)');
    expect(NIGHT_FLOOR_FRACTION).toBe(1);
    // vec3 max against a zero vector returns the other side unchanged, so with
    // no tables bound the injected text evaluates to the fill and nothing else.
    expect(surface).toContain('vec3 nightAmbient = vec3(0.0);');
    for (const archetype of ['airless', 'rocky', 'gas', 'icy', 'earth'] as const) {
      expect(NIGHT_FILL[archetype].strength, archetype).toBeGreaterThan(0);
    }
    // The deck is the one surface with no fill of its own — the globe under it
    // already has one — so its floor is zero and the table is its whole answer.
    expect(NIGHT_FILL.cloud.strength).toBe(0);
  });

  it('pays no fetches for a Moon that is down, new, or not there at all', () => {
    // Four dependent 3D fetches for the in-scatter, one 2D for the beam's
    // transmittance and one for the moonlit sky's irradiance, all behind a
    // uniform branch: Mars has no moon in MOONLIGHT_SOURCES and a new-Moon
    // Earth has an irradiance of exactly zero.
    const surface = surfaceFragment();
    expect(surface.match(/if \(moonNight > 0\.0 && uMoonIrradiance\.g > 0\.0\) \{/g))
      .toHaveLength(2);
    // The shell guards its own second source the same way.
    expect(shellFragment()).toContain('if (night > 0.0 && uMoonIrradiance.g > 0.0) {');
    expect(moonIrradiance(1, 180)).toEqual([0, 0, 0]);
    expect(MOONLIGHT_SOURCES.Mars).toBeUndefined();
  });

  it('leaves the night-lights shell multiplying by transmittance alone', () => {
    // An additive layer over a surface that has already added the air's own
    // light gets x T and no S, whichever source lit it.
    const night = src('../../shared/shaders/atmosphere.ts');
    expect(night).toContain('if (seg.valid) lit *= aerialTransmittance(uTransmittance, seg);');
    expect(night).not.toContain('aerialInscatter');
  });
});

describe('the bloom threshold', () => {
  /** The brightest single-scattered radiance in the table at one starting
   *  radius and one source elevation, per channel, over every geometry the
   *  addressing can reach from there. */
  const sweepAt = (r: number, muS: number): number[] => {
    const p = atmosphereParams('Earth');
    const peak = [0, 0, 0];
    for (let j = 0; j <= 16; j++) {
      const mu = -1 + (2 * j) / 16;
      const ground = rayIntersectsGround(p, r, mu);
      const s = Math.sqrt(Math.max(0, (1 - mu * mu) * (1 - muS * muS)));
      for (const nu of [mu * muS + s, mu * muS - s, mu * muS]) {
        const radiance = singleScatteringRadiance(p, r, mu, muS, nu, ground, 30, 200);
        for (let c = 0; c < 3; c++) peak[c] = Math.max(peak[c], radiance[c]);
      }
    }
    return peak;
  };

  /** ...and over the source elevations too: the whole table from one radius. */
  const sweep = (r: number): number => Math.max(
    ...[1, 0.8, 0.4, 0.1, 0, -0.2].flatMap((muS) => sweepAt(r, muS)),
  );

  it('is above the brightest radiance any table lookup can return, once swept', () => {
    // Re-derived rather than remembered. Over the whole table the worst is the
    // aureole — the horizon looked at along a low Sun FROM THE GROUND.
    const p = atmosphereParams('Earth');
    const H = p.topRadius - p.bottomRadius;
    let peak = 0;
    for (let i = 0; i <= 8; i++) peak = Math.max(peak, sweep(p.bottomRadius + (H * i) / 8));
    expect(peak).toBeGreaterThan(1);
    expect(peak * MULTIPLE_SCATTERING_HEADROOM).toBeLessThanOrEqual(PEAK_TABLE_SKY_RADIANCE);
  });

  it('is above the brightest one the app can actually draw, which is 30x lower', () => {
    // Every lookup this renderer makes starts at the atmosphere entry point,
    // because a lookup at the camera's own radius clamps to the top row and
    // comes back flat. The one exception is the dev pose inside the air, and
    // the contract is written for that one rather than for the top row alone.
    const p = atmosphereParams('Earth');
    const top = sweep(p.topRadius);
    const insideAirPose = sweep(p.bottomRadius + 0.008);
    expect(top).toBeLessThan(0.12);
    expect(top * MULTIPLE_SCATTERING_HEADROOM).toBeLessThan(PEAK_REACHABLE_SKY_RADIANCE);
    expect(insideAirPose * MULTIPLE_SCATTERING_HEADROOM)
      .toBeLessThanOrEqual(PEAK_REACHABLE_SKY_RADIANCE);
    expect(PEAK_REACHABLE_SKY_RADIANCE).toBeLessThan(PEAK_TABLE_SKY_RADIANCE);
  });

  it('is above every night source at its brightest', () => {
    // The moonlit sky: the worst lookup the app can draw, under a full Moon.
    const full = moonIrradiance(1, 0);
    const moonlitSky = PEAK_REACHABLE_SKY_RADIANCE * Math.max(...full);
    expect(moonlitSky).toBeLessThan(BLOOM_THRESHOLD);
    // The moonlit ground: the sky's whole irradiance plus the Moon's own beam,
    // on a perfectly white surface, is at most twice the irradiance itself,
    // through a Lambertian 1/pi.
    expect((2 / Math.PI) * Math.max(...full)).toBeLessThan(BLOOM_THRESHOLD);
    // The airglow line, fully limb-brightened.
    const glow = airglowUniforms('Earth');
    for (let c = 0; c < 3; c++) {
      expect((glow.green[c] + glow.orange[c]) * AIRGLOW_LIMB_CAP).toBeLessThan(BLOOM_THRESHOLD);
    }
    // City lights are the one night source that is allowed to bloom, and this
    // commit does not touch them.
    expect(src('../../shared/shaders/atmosphere.ts'))
      .toContain('vec3 lit = nightColor.rgb * nightMix * 1.5;');
  });

  it('is above all of them ON ONE FRAGMENT, which is what the pass thresholds', () => {
    // Bounding the sources one at a time says nothing about the quantity the
    // bloom pass actually reads. A night fragment is the ground's own light —
    // the authored floor or the sky's ambient, plus the Moon's beam — seen
    // through the air in front of it, plus what that air scatters in, plus the
    // airglow on a ray that misses the ground.
    //
    // The two halves cannot both be at their worst, and adding two maxima that
    // never co-occur comes to 1.31 in red and describes no frame. The haze
    // peaks with the source ON the horizon — the aureole, the longest path in
    // the table with the Mie lobe aimed back at the camera — and the ground
    // peaks with it overhead. So the sum is swept against the SOURCE's own
    // elevation, which is the one variable both halves depend on.
    const p = atmosphereParams('Earth');
    const full = moonIrradiance(1, 0);
    const glow = airglowUniforms('Earth');
    // The brightest authored fill of any surface class, which is the floor's
    // own ceiling: it is max()'d with the ambient, never added to it, so
    // counting both here is already generous.
    const fill = Math.max(
      ...(['airless', 'rocky', 'gas', 'icy', 'earth', 'cloud'] as const)
        .map((archetype) => NIGHT_FILL[archetype].strength),
    );
    for (const muS of [1, 0.6, 0.3, 0.1, 0.05, 0]) {
      // The moonlit sky's irradiance on the ground, from the module's own
      // reference rather than from the bound: at the horizon it is a fortieth
      // of what it is overhead, and using the overhead value everywhere is the
      // slack that put the naive sum over the line.
      const skyIrradiance = computeIndirectIrradianceOrder1(p, p.bottomRadius, muS, 12, 100, 16)
        .map((v) => v * MULTIPLE_SCATTERING_HEADROOM);
      // Every lookup this renderer makes starts at the atmosphere entry point
      // or at the camera, and the deepest camera the app has is the dev pose
      // at 51 km. Those are the two reachable starting radii.
      const haze = [0, 1, 2].map((c) => MULTIPLE_SCATTERING_HEADROOM * Math.max(
        sweepAt(p.topRadius, muS)[c], sweepAt(p.bottomRadius + 0.008, muS)[c],
      ));
      for (let c = 0; c < 3; c++) {
        const ground = (skyIrradiance[c] * full[c] + full[c] * Math.max(muS, 0)) / Math.PI;
        const composed = fill + ground + haze[c] * full[c]
          + (glow.green[c] + glow.orange[c]) * AIRGLOW_LIMB_CAP;
        expect(composed, `muS ${muS} channel ${'rgb'[c]}`).toBeLessThan(BLOOM_THRESHOLD);
      }
    }
  });
});
