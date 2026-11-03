import { describe, expect, it } from 'vitest';
import {
  GLASS_MAX_PAIRS, GLASS_PIPELINE_VARIANCE, glassPairTaps, glassQuarterSigma, glassTargetSizes,
  parseGlassParam, saturateMatrix,
} from './glassBackdrop';
import source from './glassBackdrop.ts?raw';

describe('parseGlassParam', () => {
  it('builds the renderer\'s glass unless ?glass=0', () => {
    expect(parseGlassParam('')).toBe(true);
    expect(parseGlassParam('?glass=1')).toBe(true);
    expect(parseGlassParam('?quality=high&glass=0')).toBe(false);
  });
});

describe('glassTargetSizes', () => {
  it('makes the half-size target exactly twice the quarter, so one bilinear read is a 2 × 2 box', () => {
    for (const [w, h] of [[3456, 2234], [780, 1688], [1001, 703], [1, 1]]) {
      const { quarter, half } = glassTargetSizes(w, h);
      expect(half).toEqual([quarter[0] * 2, quarter[1] * 2]);
      expect(quarter[0] * 4).toBeGreaterThanOrEqual(w);
      expect(quarter[0] * 4 - w).toBeLessThan(4);
      expect(quarter[1] * 4).toBeGreaterThanOrEqual(h);
    }
  });
});

describe('glassQuarterSigma', () => {
  it('takes the pipeline\'s own blur out of the requested one, in quarter texels', () => {
    // A 30px blur at 2×: 60 canvas pixels.
    const s = glassQuarterSigma(60, 0.25);
    expect(s).toBeCloseTo(Math.sqrt(3600 - GLASS_PIPELINE_VARIANCE) / 4, 9);
    // What reaches the screen: the drawn blur and the pipeline's, in quadrature.
    expect(Math.sqrt((s * 4) ** 2 + GLASS_PIPELINE_VARIANCE)).toBeCloseTo(60, 9);
  });

  it('never drops below a quarter texel', () => {
    expect(glassQuarterSigma(1, 0.25)).toBe(0.25);
    expect(glassQuarterSigma(0, 0.25)).toBe(0.25);
  });

  it('reaches 3σ inside the pass\'s pair budget at the desktop\'s top ratio', () => {
    // 30px at the 2.5 cap.
    const s = glassQuarterSigma(30 * 2.5, 0.25);
    expect(Math.ceil(Math.ceil(3 * s) / 2)).toBeLessThanOrEqual(GLASS_MAX_PAIRS);
  });
});

describe('glassPairTaps', () => {
  it('sums to 1 and keeps the Gaussian\'s variance, read two texels a fetch', () => {
    for (const sigma of [0.25, 1, 2.7, 6, 14.97]) {
      const { centre, pairs } = glassPairTaps(sigma);
      const total = centre + 2 * pairs.reduce((s, p) => s + p.weight, 0);
      expect(total).toBeCloseTo(1, 12);
      // The variance of the pair taps equals the truncated, normalised
      // Gaussian's to within the bilinear pairing's own error.
      const radius = Math.ceil(3 * sigma);
      let w = 1;
      let v = 0;
      for (let k = 1; k <= 2 * pairs.length; k++) {
        const g = Math.exp((-0.5 * k * k) / (sigma * sigma));
        w += 2 * g;
        v += 2 * g * k * k;
      }
      const exact = v / w;
      const paired = 2 * pairs.reduce((s, p) => s + p.weight * p.offset * p.offset, 0);
      expect(Math.abs(paired - exact)).toBeLessThan(0.25 + 0.02 * exact);
      expect(2 * pairs.length).toBeGreaterThanOrEqual(radius);
    }
  });
});

describe('saturateMatrix', () => {
  it('is the identity at 1 and keeps a grey grey at any factor', () => {
    expect(saturateMatrix(1).map((v) => Math.round(v * 1e9) / 1e9)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const m = saturateMatrix(1.6);
    for (let row = 0; row < 3; row++) expect(m[row * 3] + m[row * 3 + 1] + m[row * 3 + 2]).toBeCloseTo(1, 12);
  });

  it('is the matrix the composite shader carries, column for column', () => {
    // GLSL's mat3 is column-major: each column of the shader's literal is a
    // column of the row-major matrix here.
    const m = saturateMatrix(1.6);
    expect(source).toContain('0.213 + 0.787 * s, 0.213 - 0.213 * s, 0.213 - 0.213 * s,');
    expect(source).toContain('0.715 - 0.715 * s, 0.715 + 0.285 * s, 0.715 - 0.715 * s,');
    expect(source).toContain('0.072 - 0.072 * s, 0.072 - 0.072 * s, 0.072 + 0.928 * s);');
    expect(m[0]).toBeCloseTo(0.213 + 0.787 * 1.6, 12);
    expect(m[3]).toBeCloseTo(0.213 - 0.213 * 1.6, 12);
  });
});

describe('the composite\'s blend', () => {
  it('leaves the canvas alpha as the finishing pass wrote it', () => {
    expect(source).toMatch(/m\.blendSrcAlpha = THREE\.ZeroFactor;/);
    expect(source).toMatch(/m\.blendDstAlpha = THREE\.OneFactor;/);
  });

  it('discards a pixel its rounded box does not cover, so the canvas outside the panels is untouched', () => {
    expect(source).toContain('if (cover <= 0.0) discard;');
  });
});
