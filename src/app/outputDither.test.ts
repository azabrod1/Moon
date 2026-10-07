import { describe, expect, it } from 'vitest';
import {
  OUTPUT_DITHER_ADD, OUTPUT_DITHER_GLSL, OUTPUT_DITHER_OFFSET, ditherOutputText, interleavedGradientNoise,
  outputDitherIsWired, outputDitherLsb, outputDitherUniform, parseDitherParam, setOutputDither,
} from './outputDither';

describe('the output dither', () => {
  it('is triangular on (-1, 1) with no bias, as a function of the pixel alone', () => {
    // Over a frame's worth of pixels: mean zero, every value inside the open
    // interval, and the density at the middle about twice the density at the
    // quarter points, which is the triangle and not a flat distribution.
    let sum = 0, n = 0, mid = 0, quarter = 0;
    for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
      const t = outputDitherLsb(x, y);
      expect(t).toBeGreaterThan(-1);
      expect(t).toBeLessThan(1);
      sum += t; n++;
      if (Math.abs(t) < 0.1) mid++;
      if (Math.abs(Math.abs(t) - 0.5) < 0.05) quarter++;
    }
    expect(Math.abs(sum / n)).toBeLessThan(0.01);
    // The middle bin is 0.2 wide and the two quarter bins 0.1 each: at the
    // triangle's densities (1 at 0, 0.5 at +-0.5) the ratio is 2.
    expect(mid / quarter).toBeGreaterThan(1.7);
    expect(mid / quarter).toBeLessThan(2.3);
    // Fixed: the same pixel gives the same value every time.
    expect(outputDitherLsb(123, 456)).toBe(outputDitherLsb(123, 456));
    // Neighbours differ by a good fraction of the range: no visible lattice.
    let close = 0;
    for (let x = 0; x < 2000; x++) if (Math.abs(interleavedGradientNoise(x, 7) - interleavedGradientNoise(x + 1, 7)) < 0.05) close++;
    expect(close / 2000).toBeLessThan(0.15);
  });

  it('carries the same constants in the GLSL as the reference does', () => {
    expect(OUTPUT_DITHER_GLSL).toContain('52.9829189');
    expect(OUTPUT_DITHER_GLSL).toContain('vec2(0.06711056, 0.00583715)');
    expect(OUTPUT_DITHER_GLSL).toContain(`vec2(${OUTPUT_DITHER_OFFSET[0]}.0, ${OUTPUT_DITHER_OFFSET[1]}.0)`);
    expect(OUTPUT_DITHER_GLSL).toContain('uDither * t * (1.0 / 255.0)');
    expect(OUTPUT_DITHER_GLSL).not.toContain('`');
  });

  it('patches three\'s output text after the transfer, and refuses a text it cannot find its lines in', () => {
    const text = 'uniform sampler2D tDiffuse;\nvarying vec2 vUv;\nvoid main() {\n\tgl_FragColor = texture2D( tDiffuse, vUv );\n\t#ifdef SRGB_TRANSFER\n\t\tgl_FragColor = sRGBTransferOETF( gl_FragColor );\n\t#endif\n}';
    const patched = ditherOutputText(text);
    expect(outputDitherIsWired(patched)).toBe(true);
    expect(outputDitherIsWired(text)).toBe(false);
    expect(patched.indexOf(OUTPUT_DITHER_ADD)).toBeGreaterThan(patched.indexOf('sRGBTransferOETF'));
    expect(patched.indexOf('uniform float uDither;')).toBeGreaterThan(patched.indexOf('varying vec2 vUv;'));
    expect(() => ditherOutputText('void main() {}')).toThrow(/no longer carries/);
  });

  it('reads the switch and flips the one shared uniform', () => {
    expect(parseDitherParam('')).toBe(true);
    expect(parseDitherParam('?dither=1')).toBe(true);
    expect(parseDitherParam('?auto=planetarium&dither=0')).toBe(false);
    setOutputDither(false);
    expect(outputDitherUniform.value).toBe(0);
    setOutputDither(true);
    expect(outputDitherUniform.value).toBe(1);
  });
});
