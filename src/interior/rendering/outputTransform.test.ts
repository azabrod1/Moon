import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { temperatureScaleColor, temperatureScaleHex } from '../temperatureScale';
import { DIAGRAM_EXPOSURE, diagramFaceHex, diagramFaceRgb, neutralToneMap, rgbToHex, srgbEotf, srgbOetf } from './outputTransform';
import { SECTION_SHADER_TEXT } from './sectionMaterial';

const threeToneMapping = readFileSync(fileURLToPath(new URL('../../../node_modules/three/src/renderers/shaders/ShaderChunk/tonemapping_pars_fragment.glsl.js', import.meta.url)), 'utf8');
const threeColorSpace = readFileSync(fileURLToPath(new URL('../../../node_modules/three/src/renderers/shaders/ShaderChunk/colorspace_pars_fragment.glsl.js', import.meta.url)), 'utf8');

describe('the diagram output transform', () => {
  it('transcribes the transfer functions three ships', () => {
    expect(threeColorSpace).toContain('pow( value.rgb * 0.9478672986 + vec3( 0.0521327014 ), vec3( 2.4 ) ), value.rgb * 0.0773993808');
    expect(threeColorSpace).toContain('pow( value.rgb, vec3( 0.41666 ) ) * 1.055 - vec3( 0.055 ), value.rgb * 12.92');
    for (const channel of [0, 0.001, 0.04045, 0.2, 0.5, 0.9, 1]) {
      expect(srgbOetf(srgbEotf(channel))).toBeCloseTo(channel, 3); // three's rounded exponent, so three places
    }
    expect(srgbEotf(0.5)).toBeCloseTo(0.2140, 3);
  });

  it('transcribes Khronos PBR Neutral as three ships it', () => {
    expect(threeToneMapping).toContain('const float StartCompression = 0.8 - 0.04;');
    expect(threeToneMapping).toContain('const float Desaturation = 0.15;');
    expect(threeToneMapping).toContain('float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;');
    expect(threeToneMapping).toContain('float newPeak = 1. - d * d / ( peak + d - StartCompression );');
    expect(threeToneMapping).toContain('float g = 1. - 1. / ( Desaturation * ( peak - newPeak ) + 1. );');
    // Below the knee the curve only takes the black lift off.
    expect(neutralToneMap([0.5, 0.5, 0.5])).toEqual([0.46, 0.46, 0.46]);
    const dark = neutralToneMap([0.02, 0.03, 0.04]);
    const offset = 0.02 - 6.25 * 0.02 * 0.02;
    expect(dark[0]).toBeCloseTo(0.02 - offset, 12);
    expect(dark[2]).toBeCloseTo(0.04 - offset, 12);
    // Past it the peak is compressed toward one and the colour eased toward grey.
    const bright = neutralToneMap([0.9, 0.5, 0.2]);
    expect(bright[0]).toBeLessThan(0.86);
    expect(bright[0]).toBeGreaterThan(0.8);
    expect(bright[0]).toBeGreaterThan(bright[1]);
    expect(bright[1]).toBeGreaterThan(bright[2]);
    expect(neutralToneMap([0.5, 0.5, 0.5], 0.5)).toEqual([0.21, 0.21, 0.21]);
  });

  it('is what the shader applies: the exposure literal and the same stops', () => {
    expect(SECTION_SHADER_TEXT).toContain(`* ${DIAGRAM_EXPOSURE};`);
    // The top of the scale stays under the interior bloom threshold (0.95 luminance) after the exposure.
    const top = temperatureScaleColor(1).map((channel) => srgbEotf(channel) * DIAGRAM_EXPOSURE);
    expect(0.2126 * top[0] + 0.7152 * top[1] + 0.0722 * top[2]).toBeLessThan(0.95);
  });

  it('darkens a swatch a little and keeps its hue and its order', () => {
    for (const t of [0, 0.1, 0.35, 0.6, 0.85, 1]) {
      const swatch = temperatureScaleColor(t);
      const face = diagramFaceRgb(swatch);
      for (let channel = 0; channel < 3; channel++) expect(face[channel]).toBeLessThanOrEqual(swatch[channel] + 1e-9);
      expect(diagramFaceHex(t)).toBe(rgbToHex(face));
    }
    // Hotter on the scale is brighter on the face, as it is on the swatch.
    let previous = -1;
    for (let step = 0; step <= 20; step++) {
      const face = diagramFaceRgb(temperatureScaleColor(step / 20));
      const luminance = 0.2126 * face[0] + 0.7152 * face[1] + 0.0722 * face[2];
      expect(luminance).toBeGreaterThan(previous);
      previous = luminance;
    }
    expect(temperatureScaleHex(1)).toBeGreaterThan(diagramFaceHex(1));
  });
});
