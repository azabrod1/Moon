/**
 * The section shader and temperatureScale.ts each carry the temperature
 * scale: the faces sample sectionTempT per pixel and the legend paints
 * temperatureT per row. Nothing links the two but this test, which reads the
 * uniforms writeTemperatureScale produces, runs the GLSL arithmetic in
 * TypeScript against them, and pins that the shader text still holds that
 * arithmetic — floors included, so a zero-span range lands in the same place
 * on both sides.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MAX_REGIONS as SCHEMA_MAX_REGIONS } from '../data/interiorTypes';
import {
  LINEAR_SPAN_FLOOR_K,
  LOG_SPAN_FLOOR,
  TEMPERATURE_SCALE_STOPS,
  temperatureT,
  type TemperatureRange,
} from '../temperatureScale';
import { MAX_REGIONS, createSectionUniforms, writeTemperatureScale, type SectionUniforms } from './sectionMaterial';

const shaderSource = readFileSync(fileURLToPath(new URL('./sectionMaterial.ts', import.meta.url)), 'utf8');

/** sectionTempT's scale placement, transcribed from the GLSL over the written uniforms. */
function shaderScaleT(uniforms: SectionUniforms, kelvin: number): number {
  const scaleMin = uniforms.uScaleMin.value;
  const scaleMax = uniforms.uScaleMax.value;
  if (uniforms.uScaleLog.value > 0.5) {
    const low = Math.log(Math.max(scaleMin, 1));
    return clamp((Math.log(Math.max(kelvin, 1)) - low) / Math.max(Math.log(Math.max(scaleMax, 1)) - low, 1e-4));
  }
  return clamp((kelvin - scaleMin) / Math.max(scaleMax - scaleMin, 1));
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function srgbToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
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

  it('writes a null range as a unit scale and the floors the shader applies', () => {
    const uniforms = createSectionUniforms();
    writeTemperatureScale(uniforms, null);
    expect(uniforms.uScaleMin.value).toBe(0);
    expect(uniforms.uScaleMax.value).toBe(1);
    expect(uniforms.uScaleLog.value).toBe(0);
    writeTemperatureScale(uniforms, { minK: 300, maxK: 300, log: false });
    expect(uniforms.uScaleMax.value - uniforms.uScaleMin.value).toBe(LINEAR_SPAN_FLOOR_K);
  });

  it('keeps the shader text on the same arithmetic', () => {
    // The floors, as the GLSL spells them; a change to either side must come here.
    expect(shaderSource).toContain(`max(uScaleMax - uScaleMin, ${LINEAR_SPAN_FLOOR_K.toFixed(1)})`);
    expect(LOG_SPAN_FLOOR).toBe(1e-4);
    expect(shaderSource).toContain('max(log(max(uScaleMax, 1.0)) - low, 1e-4)');
    expect(shaderSource).toContain('float low = log(max(uScaleMin, 1.0));');
    expect(shaderSource).toContain('mix(outerK, innerK, regionT)');
    expect(shaderSource).toContain('exp(mix(log(outerK), log(innerK), regionT))');
  });

  it('hands the shader the legend\'s stops, linearised, and the same region cap', () => {
    const uniforms = createSectionUniforms();
    expect(uniforms.uScaleStops.value).toHaveLength(TEMPERATURE_SCALE_STOPS.length);
    TEMPERATURE_SCALE_STOPS.forEach((stop, index) => {
      const written = uniforms.uScaleStops.value[index];
      expect(written.x).toBeCloseTo(srgbToLinear(stop[0]), 12);
      expect(written.y).toBeCloseTo(srgbToLinear(stop[1]), 12);
      expect(written.z).toBeCloseTo(srgbToLinear(stop[2]), 12);
    });
    expect(shaderSource).toContain('uniform vec3 uScaleStops[6];');
    expect(TEMPERATURE_SCALE_STOPS).toHaveLength(6);
    expect(MAX_REGIONS).toBe(SCHEMA_MAX_REGIONS);
    expect(uniforms.uOuter.value).toHaveLength(MAX_REGIONS);
  });
});
