/**
 * The section shader carries, in GLSL, arithmetic that TypeScript also
 * holds: the temperature scale (temperatureScale.ts), the temperature
 * between a region's knots (temperatureProfile.ts), the incandescence and
 * its forge ramp (artParams.ts) and the scale colour's sRGB mix. Nothing
 * links the two but this test, which reads the uniforms the writers produce,
 * runs the GLSL arithmetic in TypeScript against them, and pins that the
 * shader text still holds that arithmetic — floors and literals included —
 * so a change to either side must come here.
 */
import { describe, expect, it } from 'vitest';
import { MAX_REGIONS as SCHEMA_MAX_REGIONS } from '../data/interiorTypes';
import { EARTH_MODEL } from '../data/models/earth';
import { SUN_MODEL } from '../data/models/sun';
import {
  DRAPER_POINT_K,
  FORGE_STOPS,
  INCANDESCENCE_FULL_K,
  INCANDESCENCE_HOT_BOOST,
  INCANDESCENCE_HOT_DECADES,
  INCANDESCENCE_HOT_K,
  INCANDESCENCE_ONSET_POWER,
  INCANDESCENCE_PEAK,
  incandescence,
  selfLitSwatchHex,
  selfLitToneMix,
  swatchHex,
} from '../data/artParams';
import { drawnFromModel } from '../drawnModel';
import { IDENTITY_REMAP } from '../interiorGeometry';
import { regionArtInsideOut, regionLooks } from '../interiorLogic';
import { TEMPERATURE_KNOTS, knotsTemperatureK, sampleTemperatureK } from '../temperatureProfile';
import {
  LINEAR_SPAN_FLOOR_K,
  LOG_SPAN_FLOOR,
  TEMPERATURE_SCALE_STOPS,
  temperatureScaleColor,
  temperatureT,
  type TemperatureRange,
} from '../temperatureScale';
import { DIAGRAM_EXPOSURE, srgbEotf } from './outputTransform';
import {
  KNOT_VEC4S,
  MAX_REGIONS,
  SECTION_SHADER_TEXT,
  SELF_LIT_FLOOR,
  SELF_LIT_RANGE,
  SELF_LIT_REGION_MIX,
  createSectionUniforms,
  hottestRegionIndex,
  selfLitLevels,
  selfLitRadiance,
  writeSectionRegions,
  writeTemperatureScale,
  type SectionUniforms,
} from './sectionMaterial';

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** sectionScaleT, transcribed from the GLSL over the written uniforms (the log scale's own logs among them). */
function shaderScaleT(uniforms: SectionUniforms, kelvin: number): number {
  const scaleMin = uniforms.uScaleMin.value;
  const scaleMax = uniforms.uScaleMax.value;
  if (uniforms.uScaleLog.value > 0.5) {
    return clamp((Math.log(Math.max(kelvin, 1)) - uniforms.uScaleLogMin.value) / uniforms.uScaleLogSpan.value);
  }
  return clamp((kelvin - scaleMin) / Math.max(scaleMax - scaleMin, 1));
}

/** sectionKnotK: region k's knot j from the packed vec4s, floored at one kelvin. */
function shaderKnotK(uniforms: SectionUniforms, k: number, j: number): number {
  const four = uniforms.uTempKnot.value[k * KNOT_VEC4S + Math.floor(j / 4)];
  return Math.max(four.getComponent(j - Math.floor(j / 4) * 4), 1);
}

/** sectionTempK, transcribed: the knot pair, mixed on a line or a log. */
function shaderTemperatureK(uniforms: SectionUniforms, k: number, regionT: number): number {
  const x = clamp(regionT) * (TEMPERATURE_KNOTS - 1);
  const j = Math.floor(Math.min(x, TEMPERATURE_KNOTS - 1 - 0.001));
  const f = x - j;
  const a = shaderKnotK(uniforms, k, j);
  const b = shaderKnotK(uniforms, k, j + 1);
  return uniforms.uTempLog.value[k] > 0.5 ? Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * f) : a + (b - a) * f;
}

/** sectionForgeSrgb and sectionIncandescence, transcribed. */
function shaderIncandescence(kelvin: number): { emission: [number, number, number]; strength: number } {
  let color = [...FORGE_STOPS[0][1]] as [number, number, number];
  for (let index = 1; index < FORGE_STOPS.length; index++) {
    const [previousK] = FORGE_STOPS[index - 1];
    const [stopK, stopColor] = FORGE_STOPS[index];
    const t = clamp((kelvin - previousK) / (stopK - previousK));
    color = color.map((channel, channelIndex) => channel + (stopColor[channelIndex] - channel) * t) as [number, number, number];
  }
  const ramp = clamp((kelvin - DRAPER_POINT_K) / (INCANDESCENCE_FULL_K - DRAPER_POINT_K));
  const strength = ramp > 0 ? Math.pow(ramp, INCANDESCENCE_ONSET_POWER) : 0;
  const hotDecades = clamp((Math.log(Math.max(kelvin, 1) / INCANDESCENCE_HOT_K) * 0.4342944819) / INCANDESCENCE_HOT_DECADES);
  const radiance = (0.03 * strength + INCANDESCENCE_PEAK * Math.pow(strength, 0.9)) * (1 + INCANDESCENCE_HOT_BOOST * hotDecades * hotDecades);
  return { emission: color.map((channel) => Math.pow(channel, 2.2) * radiance) as [number, number, number], strength };
}

/** sectionScaleColor, transcribed: the stops mixed in sRGB, then linearised. */
function shaderScaleColor(uniforms: SectionUniforms, t: number): [number, number, number] {
  const x = clamp(t) * 5;
  const stop = Math.floor(Math.min(x, 4.999));
  const f = x - stop;
  const from = uniforms.uScaleStops.value[stop];
  const to = uniforms.uScaleStops.value[stop + 1];
  return [srgbEotf(from.x + (to.x - from.x) * f), srgbEotf(from.y + (to.y - from.y) * f), srgbEotf(from.z + (to.z - from.z) * f)];
}

describe('the temperature scale, CPU and GPU', () => {
  const ranges: TemperatureRange[] = [
    { minK: 288, maxK: 5700, log: false },
    { minK: 4500, maxK: 15_700_000, log: true },
    { minK: 300, maxK: 300, log: false }, // zero span, linear
    { minK: 300, maxK: 300, log: true }, // zero span, log
    { minK: 0, maxK: 10, log: false }, // a scale that starts at zero
    { minK: 0.5, maxK: 20, log: true }, // below the log floor of one kelvin
  ];

  it('places every temperature where the shader places it, zero-span ranges included', () => {
    for (const range of ranges) {
      const uniforms = createSectionUniforms();
      writeTemperatureScale(uniforms, range);
      const probes = [range.minK - 10, range.minK, (range.minK + range.maxK) / 2, Math.sqrt(Math.max(range.minK, 1) * Math.max(range.maxK, 1)), range.maxK, range.maxK + 1, range.maxK * 3];
      for (const kelvin of probes) {
        expect(temperatureT(range, kelvin), `${JSON.stringify(range)} at ${kelvin} K`).toBeCloseTo(shaderScaleT(uniforms, kelvin), 12);
      }
    }
  });

  it('writes a null range as a unit scale nobody knows, and the floors the shader applies', () => {
    const uniforms = createSectionUniforms();
    writeTemperatureScale(uniforms, null);
    expect(uniforms.uScaleMin.value).toBe(0);
    expect(uniforms.uScaleMax.value).toBe(1);
    expect(uniforms.uScaleLog.value).toBe(0);
    expect(uniforms.uScaleKnown.value).toBe(0);
    writeTemperatureScale(uniforms, { minK: 300, maxK: 300, log: false });
    expect(uniforms.uScaleMax.value - uniforms.uScaleMin.value).toBe(LINEAR_SPAN_FLOOR_K);
    expect(uniforms.uScaleKnown.value).toBe(1);
  });

  it('keeps the shader text on the same arithmetic', () => {
    // The floors, as the GLSL spells them; a change to either side must come here. The log
    // scale's own logs are uniforms, floored where they are written.
    expect(SECTION_SHADER_TEXT).toContain(`max(uScaleMax - uScaleMin, ${LINEAR_SPAN_FLOOR_K.toFixed(1)})`);
    expect(LOG_SPAN_FLOOR).toBe(1e-4);
    expect(SECTION_SHADER_TEXT).toContain('return clamp((log(max(kelvin, 1.0)) - uScaleLogMin) / uScaleLogSpan, 0.0, 1.0);');
    const zeroSpanLog = createSectionUniforms();
    writeTemperatureScale(zeroSpanLog, { minK: 1000, maxK: 1000, log: true });
    expect(zeroSpanLog.uScaleLogSpan.value).toBeGreaterThanOrEqual(LOG_SPAN_FLOOR);
    expect(zeroSpanLog.uScaleLogMin.value).toBeCloseTo(Math.log(1000), 12);
    // The knots: packed four to a vec4, the component picked by a mask, the pair chosen by the
    // depth fraction, mixed on a line or a log, and hatched only against a scale.
    expect(SECTION_SHADER_TEXT).toContain(`uniform vec4 uTempKnot[${MAX_REGIONS * KNOT_VEC4S}];`);
    expect(SECTION_SHADER_TEXT).toContain(`vec4 four = uTempKnot[k * ${KNOT_VEC4S} + j / 4];`);
    expect(SECTION_SHADER_TEXT).toContain('vec4 mask = vec4(equal(ivec4(j - (j / 4) * 4), ivec4(0, 1, 2, 3)));');
    expect(SECTION_SHADER_TEXT).toContain('return max(dot(four, mask), 1.0);');
    expect(SECTION_SHADER_TEXT).toContain(`clamp(regionT, 0.0, 1.0) * ${(TEMPERATURE_KNOTS - 1).toFixed(1)};`);
    expect(SECTION_SHADER_TEXT).toContain(`int j = int(floor(min(x, ${(TEMPERATURE_KNOTS - 1).toFixed(1)} - 0.001)));`);
    expect(SECTION_SHADER_TEXT).toContain('return uTempLog[k] > 0.5 ? exp(mix(log(a), log(b), f)) : mix(a, b, f);');
    expect(SECTION_SHADER_TEXT).toContain('uTempKnown[k] * uScaleKnown');
    expect(SECTION_SHADER_TEXT).toContain('uTempKnown[0] * uScaleKnown');
    // One diagram per draw, the local temperature sampled once per region and feeding either.
    expect(SECTION_SHADER_TEXT).toContain('bool sectionMaterials = uDisplayMode == 0;');
    expect(SECTION_SHADER_TEXT).toContain('float kelvin0 = sectionTempK(0, regionT0);');
    expect(SECTION_SHADER_TEXT).toContain('float kelvinK = sectionTempK(k, regionT);');
    expect(SECTION_SHADER_TEXT).toContain('interiorHeat = sectionHeat(0, regionT0, kelvin0, heatMask0, interiorHeatStrength);');
    expect(SECTION_SHADER_TEXT).toContain('interiorTempT = mix(interiorTempT, sectionScaleT(kelvinK), t);');
    expect(SECTION_SHADER_TEXT.match(/if \(sectionMaterials\) \{/g)).toHaveLength(2);
    // The heat's composition: the incandescence through the family's tint and gain, grained, lifted toward the hottest region's bottom.
    expect(SECTION_SHADER_TEXT).toContain('return radiance * uHeat[k] * heatMask * mix(1.0, uHeatBoost[k], regionT);');
    expect(SECTION_SHADER_TEXT).toContain('return vec4(pow(forge, vec3(2.2)) * radiance, strength);');
    // The rim's own band, read after the loop that reads every other boundary as the next region's.
    expect(SECTION_SHADER_TEXT).toContain('if (uBandHigh[uCount - 1] > uBandLow[uCount - 1]) {');
    // The diagram is unlit: a metal with a black albedo, at the documented exposure.
    expect(SECTION_SHADER_TEXT).toContain('metalnessFactor = uDisplayMode == 1 ? 1.0');
    expect(SECTION_SHADER_TEXT).toContain(`sectionScaleColor(interiorTempT) * ${DIAGRAM_EXPOSURE};`);
    expect(SECTION_SHADER_TEXT).toContain('return sectionSrgbToLinear(mix(uScaleStops[stop], uScaleStops[stop + 1], f));');
    expect(SECTION_SHADER_TEXT).toContain('float x = clamp(t, 0.0, 1.0) * 5.0;');
    expect(SECTION_SHADER_TEXT).toContain('int stop = int(floor(min(x, 4.999)));');
    // three's sRGB transfer, as colorspace_pars_fragment writes it.
    expect(SECTION_SHADER_TEXT).toContain('return mix(pow(c * 0.9478672986 + vec3(0.0521327014), vec3(2.4)), c * 0.0773993808, vec3(lessThanEqual(c, vec3(0.04045))));');
    // The incandescence's literals are artParams' constants.
    expect(SECTION_SHADER_TEXT).toContain(`(kelvin - ${DRAPER_POINT_K.toFixed(1)}) / ${(INCANDESCENCE_FULL_K - DRAPER_POINT_K).toFixed(1)}`);
    expect(SECTION_SHADER_TEXT).toContain(`/ ${INCANDESCENCE_HOT_K.toFixed(1)}) * 0.4342944819 / ${INCANDESCENCE_HOT_DECADES.toFixed(1)}`);
    expect(SECTION_SHADER_TEXT).toContain(`(0.03 * strength + ${INCANDESCENCE_PEAK} * peak)`);
    expect(SECTION_SHADER_TEXT).toContain(`${INCANDESCENCE_HOT_BOOST.toFixed(1)} * hotDecades * hotDecades`);
    expect(SECTION_SHADER_TEXT).toContain(`float strength = ramp > 0.0 ? pow(ramp, ${INCANDESCENCE_ONSET_POWER}) : 0.0;`);
    expect(SECTION_SHADER_TEXT).toContain(`${SELF_LIT_FLOOR} + ${SELF_LIT_RANGE} * level * level * level`);
    // A self-lit pixel's place is the local temperature's, pulled part way to its region's.
    expect(SECTION_SHADER_TEXT).toContain(`float level = mix(localLevel, regionLevel, ${SELF_LIT_REGION_MIX});`);
    expect(SECTION_SHADER_TEXT).toContain('sectionSelfLitRadiance(kelvin, known, uHeatLevel[k])');
    // The self-lit palette's tone mapping, which artParams.selfLitToneMix mirrors for the legend.
    expect(SECTION_SHADER_TEXT).toContain('mixValue = mix(0.15 + 0.45 * structure, 0.6 + 0.4 * structure, level * level) + 0.5 * whiten;');
    // The faces' own fill: a Lambert term on the albedo the resolve left, Materials only.
    expect(SECTION_SHADER_TEXT).toContain('totalEmissiveRadiance += diffuseColor.rgb * RECIPROCAL_PI * uFaceFill * max(dot(normal, uFaceFillDir), 0.0);');
    const floatText = (value: number) => (String(value).includes('.') ? String(value) : `${value}.0`);
    for (const [stopK, color] of FORGE_STOPS.slice(1)) {
      expect(SECTION_SHADER_TEXT).toContain(`vec3(${color.map(floatText).join(', ')})`);
      expect(stopK).toBeGreaterThan(0);
    }
  });

  it("hands the shader the legend's stops as the legend has them, sRGB, and the same region cap", () => {
    const uniforms = createSectionUniforms();
    expect(uniforms.uScaleStops.value).toHaveLength(TEMPERATURE_SCALE_STOPS.length);
    TEMPERATURE_SCALE_STOPS.forEach((stop, index) => {
      const written = uniforms.uScaleStops.value[index];
      expect([written.x, written.y, written.z]).toEqual([...stop]);
    });
    expect(SECTION_SHADER_TEXT).toContain('uniform vec3 uScaleStops[6];');
    expect(TEMPERATURE_SCALE_STOPS).toHaveLength(6);
    expect(MAX_REGIONS).toBe(SCHEMA_MAX_REGIONS);
    expect(uniforms.uOuter.value).toHaveLength(MAX_REGIONS);
  });

  it('mixes the scale colour as the legend does, in sRGB, and only then linearises', () => {
    const uniforms = createSectionUniforms();
    for (let step = 0; step <= 40; step++) {
      const t = step / 40;
      const legend = temperatureScaleColor(t).map(srgbEotf);
      const face = shaderScaleColor(uniforms, t);
      for (let channel = 0; channel < 3; channel++) expect(face[channel]).toBeCloseTo(legend[channel], 9);
    }
  });
});

describe('the shader text', () => {
  it('defines every section function it calls, so a dropped function is caught here and not by a GPU', () => {
    const defined = new Set([...SECTION_SHADER_TEXT.matchAll(/^(?:float|vec[234]|int|void) (section\w+)\(/gm)].map((match) => match[1]));
    const called = new Set([...SECTION_SHADER_TEXT.matchAll(/\b(section\w+)\(/g)].map((match) => match[1]));
    for (const name of called) expect(defined, `${name}() is called but never defined`).toContain(name);
    for (const name of ['sectionNoDataColor', 'sectionScaleColor', 'sectionScaleT', 'sectionTempK', 'sectionIncandescence', 'sectionHeat', 'sectionSample']) {
      expect(defined).toContain(name);
    }
  });
});

describe('the temperature and the heat at a pixel, CPU and GPU', () => {
  it('reads a region\'s temperature between its knots as the sampler does, for every region of the Earth and the Sun', () => {
    for (const model of [EARTH_MODEL, SUN_MODEL]) {
      const drawn = drawnFromModel(model);
      const looks = regionLooks(drawn, IDENTITY_REMAP, regionArtInsideOut(drawn));
      const uniforms = createSectionUniforms();
      writeSectionRegions(uniforms, looks);
      looks.forEach((look, index) => {
        const region = drawn.regionsInsideOut[index];
        expect(uniforms.uTempKnown.value[index]).toBe(1);
        for (let step = 0; step <= 50; step++) {
          const regionT = step / 50;
          const fromShader = shaderTemperatureK(uniforms, index, regionT);
          const fromKnots = knotsTemperatureK(look.temperature!.knotsK, look.temperature!.log, regionT);
          expect(Math.abs(fromShader - fromKnots) / fromKnots).toBeLessThan(1e-9);
          // And the knots are the model's ramp: the sampler at the physical radius the fraction names.
          const radiusKm = region.outerRadiusKm - regionT * (region.outerRadiusKm - region.innerRadiusKm);
          const fromModel = sampleTemperatureK(region.region!.temperatureK, radiusKm, region.innerRadiusKm, region.outerRadiusKm)!;
          expect(Math.abs(fromShader - fromModel) / fromModel).toBeLessThan(1e-9);
        }
      });
    }
  });

  it('writes an unknown temperature as one-kelvin knots nobody reads, and the heat as tint by gain', () => {
    const drawn = drawnFromModel(EARTH_MODEL);
    const looks = regionLooks(drawn, IDENTITY_REMAP, regionArtInsideOut(drawn));
    looks[1] = { ...looks[1], temperature: null };
    const uniforms = createSectionUniforms();
    writeSectionRegions(uniforms, looks);
    expect(uniforms.uTempKnown.value[1]).toBe(0);
    for (let knot = 0; knot < TEMPERATURE_KNOTS; knot++) expect(shaderKnotK(uniforms, 1, knot)).toBe(1);
    expect(uniforms.uTempKnown.value[0]).toBe(1);
    // A white heat tint at gain 1: the multiplier is one, the incandescence itself is the shader's.
    const heat = uniforms.uHeat.value[0];
    expect([heat.x, heat.y, heat.z]).toEqual([1, 1, 1]);
    // The hottest lit region takes the lift; the others none.
    const boosts = uniforms.uHeatBoost.value.slice(0, looks.length);
    expect(boosts.filter((boost) => boost > 1)).toHaveLength(1);
    expect(boosts[0]).toBeGreaterThan(1); // Earth's inner core
    // Nothing self-lit on the Earth: the self-lit scale is idle.
    expect(uniforms.uSelfLitSpanLog.value).toBe(0);
    const sun = drawnFromModel(SUN_MODEL);
    const sunUniforms = createSectionUniforms();
    writeSectionRegions(sunUniforms, regionLooks(sun, IDENTITY_REMAP, regionArtInsideOut(sun)));
    expect(sunUniforms.uSelfLitCoolK.value).toBe(4500);
    expect(sunUniforms.uSelfLitSpanLog.value).toBeCloseTo(Math.log(15_700_000 / 4500), 12);
    expect(sunUniforms.uHeatLevel.value[0]).toBe(1); // the core, the hottest zone
    expect(sunUniforms.uHeatLevel.value[sun.regionsInsideOut.length - 1]).toBeLessThan(0.3); // the photosphere
  });

  it('gives a star\'s zones their levels, and the legend a swatch per zone in the order the faces draw them', () => {
    const sun = drawnFromModel(SUN_MODEL);
    const looks = regionLooks(sun, IDENTITY_REMAP, regionArtInsideOut(sun));
    const uniforms = createSectionUniforms();
    writeSectionRegions(uniforms, looks);
    const levels = selfLitLevels(looks);
    expect(levels).toHaveLength(looks.length);
    for (let index = 0; index < looks.length; index++) expect(levels[index]).toBe(uniforms.uHeatLevel.value[index]);
    // Nothing on the Sun is a lit region: no boost, and no hottest lit region for the legend to lift.
    expect(hottestRegionIndex(looks, looks.length)).toBe(-1);
    // The radiance curve is the shader's: the floor at the coolest zone, floor + range at the hottest.
    expect(selfLitRadiance(0)).toBe(SELF_LIT_FLOOR);
    expect(selfLitRadiance(1)).toBeCloseTo(SELF_LIT_FLOOR + SELF_LIT_RANGE, 12);
    // The tone mapping is the shader's at structure 0.5: colorA-ward at the surface, past colorB at the core.
    expect(selfLitToneMix(0)).toBeCloseTo(0.375, 12);
    expect(selfLitToneMix(1)).toBeCloseTo(1.3, 12);
    // Four swatches, each brighter than the one outside it, and each at least 30 levels from every other.
    const swatches = looks.map((look, index) => selfLitSwatchHex(look.art, levels[index], selfLitRadiance(levels[index]) / selfLitRadiance(1)));
    const luma = (hex: number) => 0.299 * ((hex >> 16) & 255) + 0.587 * ((hex >> 8) & 255) + 0.114 * (hex & 255);
    for (let index = 1; index < swatches.length; index++) expect(luma(swatches[index - 1]), `zone ${index}`).toBeGreaterThan(luma(swatches[index]));
    const maxChannelDelta = (a: number, b: number) => Math.max(Math.abs(((a >> 16) & 255) - ((b >> 16) & 255)), Math.abs(((a >> 8) & 255) - ((b >> 8) & 255)), Math.abs((a & 255) - (b & 255)));
    for (let outer = 0; outer < swatches.length; outer++) {
      for (let inner = outer + 1; inner < swatches.length; inner++) expect(maxChannelDelta(swatches[outer], swatches[inner]), `${outer} vs ${inner}`).toBeGreaterThanOrEqual(30);
    }
    // A self-lit region's plain swatch is its base tone; the lit-region swatch never goes all the way to its heat.
    expect(swatchHex(looks[0].art, incandescence(15_700_000))).toBe(looks[0].art.colorA);
    const earth = drawnFromModel(EARTH_MODEL);
    const earthLooks = regionLooks(earth, IDENTITY_REMAP, regionArtInsideOut(earth));
    const innerCore = earthLooks[0].art;
    const plain = swatchHex(innerCore, incandescence(5500));
    const lifted = swatchHex(innerCore, incandescence(5500), 0.3);
    expect(plain).not.toBe(innerCore.colorA);
    expect(luma(lifted)).toBeGreaterThan(luma(plain));
    expect(hottestRegionIndex(earthLooks, earthLooks.length)).toBe(0);
  });

  it('computes the incandescence the swatch is computed from, at every temperature that matters', () => {
    const temperatures = [0, 1, 300, 799, 800, 801, 1000, 1300, 1650, 2000, 2500, 3000, 3800, 4500, 5400, 5700, 6000, 8000, 20_000, 100_000, 2_000_000, 15_700_000];
    for (const kelvin of temperatures) {
      const expected = incandescence(kelvin);
      const fromShader = shaderIncandescence(kelvin);
      expect(fromShader.strength, `${kelvin} K`).toBeCloseTo(expected.strength, 12);
      for (let channel = 0; channel < 3; channel++) {
        expect(fromShader.emission[channel], `${kelvin} K channel ${channel}`).toBeCloseTo(expected.emission[channel], 9);
      }
    }
  });
});
