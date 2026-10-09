import { describe, expect, it } from 'vitest';
import {
  OUTPUT_DITHER_ADD, OUTPUT_DITHER_GLSL, OUTPUT_DITHER_R2, ditherOutputText, interleavedGradientNoise,
  outputDitherIsWired, outputDitherLsb, outputDitherUniform, parseDitherParam, r2PixelNoise, setOutputDither,
} from './outputDither';

/** The dither at every pixel centre of a 512 × 512 frame, as gl_FragCoord
 *  reads them. */
function sweep(): Float64Array {
  const out = new Float64Array(512 * 512);
  for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) out[y * 512 + x] = outputDitherLsb(x + 0.5, y + 0.5);
  return out;
}

describe('the output dither', () => {
  it('is the triangle on (-1, 1), whole: every bin of its histogram, its reach and its mean', () => {
    // Forty bins across (-1, 1), each held to the triangle's own mass in it.
    // A sum whose second term is a function of the first passes a coarse
    // middle-against-quarter count and fails here: it is confined to about
    // +-0.82 LSB with plateaus where the slopes should be.
    const t = sweep();
    const bins = new Array(40).fill(0);
    let sum = 0, min = Infinity, max = -Infinity;
    for (const v of t) {
      bins[Math.min(39, Math.floor((v + 1) * 20))]++;
      sum += v;
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    // Every value inside (-1, 1), held on the extremes once (a NaN anywhere
    // makes min NaN, which fails too): an expect per value was half a million
    // calls, past vitest's 5 s on a CI runner.
    expect(min).toBeGreaterThan(-1);
    expect(max).toBeLessThan(1);
    const cdf = (u: number): number => (u < 0 ? (u + 1) ** 2 / 2 : 1 - (1 - u) ** 2 / 2);
    for (let i = 0; i < 40; i++) {
      const lo = -1 + i / 20;
      const want = (cdf(lo + 1 / 20) - cdf(lo)) * t.length;
      expect(Math.abs(bins[i] / want - 1), `bin ${i} at ${lo.toFixed(2)}`).toBeLessThan(0.1);
    }
    expect(min).toBeLessThan(-0.95);
    expect(max).toBeGreaterThan(0.95);
    expect(Math.abs(sum / t.length)).toBeLessThan(0.01);
  });

  it('leaves a rounding error whose variance does not depend on the signal', () => {
    // The point of a triangle of two LSB: the error of rounding (value + dither)
    // has the same mean and the same variance, a quarter of an LSB squared,
    // whatever fraction of an LSB the value sits at. Off the triangle the
    // variance moves with that fraction, and the grain with the picture.
    const t = sweep();
    for (const frac of [0, 0.25, 0.4, 0.5]) {
      let e1 = 0, e2 = 0;
      for (const v of t) {
        const e = Math.round(100 + frac + v) - (100 + frac);
        e1 += e;
        e2 += e * e;
      }
      const mean = e1 / t.length;
      expect(Math.abs(mean), `mean at ${frac}`).toBeLessThan(0.01);
      expect(Math.abs(e2 / t.length - mean * mean - 0.25), `variance at ${frac}`).toBeLessThan(0.02);
    }
  });

  it('is fixed per pixel, and its two uniforms are independent of each other', () => {
    // Fixed: the same pixel gives the same value every time.
    expect(outputDitherLsb(123.5, 456.5)).toBe(outputDitherLsb(123.5, 456.5));
    // The pair over a frame covers the unit square evenly: no cell of a 10 × 10
    // grid more than a few per cent off its share.
    const cells = new Array(100).fill(0);
    for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
      const a = interleavedGradientNoise(x + 0.5, y + 0.5);
      const b = r2PixelNoise(x + 0.5, y + 0.5);
      cells[Math.min(9, Math.floor(a * 10)) * 10 + Math.min(9, Math.floor(b * 10))]++;
    }
    for (const c of cells) expect(Math.abs(c / (512 * 512 / 100) - 1)).toBeLessThan(0.05);
    // Neighbours differ by a good fraction of the range: no visible lattice.
    let close = 0;
    for (let x = 0; x < 2000; x++) if (Math.abs(interleavedGradientNoise(x, 7) - interleavedGradientNoise(x + 1, 7)) < 0.05) close++;
    expect(close / 2000).toBeLessThan(0.15);
  });

  it('carries the same constants in the GLSL as the reference does', () => {
    expect(OUTPUT_DITHER_GLSL).toContain('52.9829189');
    expect(OUTPUT_DITHER_GLSL).toContain('vec2(0.06711056, 0.00583715)');
    expect(OUTPUT_DITHER_GLSL).toContain(`vec2(${OUTPUT_DITHER_R2[0]}, ${OUTPUT_DITHER_R2[1]})`);
    expect(OUTPUT_DITHER_GLSL).toContain('outputDitherNoise(fragCoord) + outputDitherR2(fragCoord) - 1.0');
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
