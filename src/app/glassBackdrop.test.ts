import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  GLASS_MAX_PAIRS, GLASS_PIPELINE_VARIANCE, GlassBackdrop, glassMirrorInto, glassPairTaps, glassQuarterSigma,
  glassTargetSizes, parseGlassParam, saturateMatrix, type GlassFinishing,
} from './glassBackdrop';
import type { GlassRect } from './glassRects';
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
  it('hands every texel exactly the normalised Gaussian weight, two texels a fetch', () => {
    for (const sigma of [0.25, 1, 2.7, 6, 14.97]) {
      const { centre, pairs } = glassPairTaps(sigma);
      // Each pair is one bilinear read at `offset` between texels k and k+1:
      // texel k gets weight·(k+1−offset), texel k+1 weight·(offset−k).
      const fromPairs = new Map<number, number>([[0, centre]]);
      pairs.forEach((p, i) => {
        const k = 2 * i + 1;
        fromPairs.set(k, (fromPairs.get(k) ?? 0) + p.weight * (k + 1 - p.offset));
        fromPairs.set(k + 1, (fromPairs.get(k + 1) ?? 0) + p.weight * (p.offset - k));
      });
      // The same kernel summed texel by texel: exp(−x²/2σ²) at every texel
      // out to the pairs' reach, both sides, normalised.
      const reach = 2 * pairs.length;
      const texels = Array.from({ length: reach + 1 }, (_, x) => Math.exp(-(x * x) / (2 * sigma * sigma)));
      const total = texels[0] + 2 * texels.slice(1).reduce((a, b) => a + b, 0);
      for (let x = 0; x <= reach; x++) expect(fromPairs.get(x)).toBeCloseTo(texels[x] / total, 12);
      // And the pairs reach 3σ.
      expect(reach).toBeGreaterThanOrEqual(Math.min(Math.ceil(3 * sigma), 2 * GLASS_MAX_PAIRS));
    }
  });
});

describe('glassMirrorInto', () => {
  it('reflects at the box\'s edges and never lets a bilinear read reach a texel centred outside', () => {
    const boxes = [[3.2, 17.9], [3.7, 17.3], [0, 12], [5.5, 6.5], [10.1, 10.8], [2.49, 9.51]];
    for (const [lo, hi] of boxes) {
      for (let p = lo - 30; p <= hi + 30; p += 0.37) {
        const c = glassMirrorInto(p, lo, hi);
        const left = Math.floor(c - 0.5);
        const centres = [left + 0.5, left + 1.5];
        const weightRight = c - 0.5 - left;
        // A texel that takes any weight is centred inside the box, unless the
        // box holds no texel centre at all.
        const holds = Math.floor(hi - 0.5) >= Math.ceil(lo - 0.5);
        if (holds) {
          if (weightRight < 1 - 1e-9) expect(centres[0] >= lo - 1e-9 && centres[0] <= hi + 1e-9, `${p} in [${lo}, ${hi}] → ${c}`).toBe(true);
          if (weightRight > 1e-9) expect(centres[1] >= lo - 1e-9 && centres[1] <= hi + 1e-9, `${p} in [${lo}, ${hi}] → ${c}`).toBe(true);
        }
      }
    }
  });

  it('is a mirror inside the box: a point and its reflection read the same place', () => {
    const [lo, hi] = [4.2, 20.6];
    for (const d of [0.3, 1.1, 2.6]) {
      expect(glassMirrorInto(lo - d, lo, hi)).toBeCloseTo(glassMirrorInto(lo + d, lo, hi), 12);
      expect(glassMirrorInto(hi + d, lo, hi)).toBeCloseTo(glassMirrorInto(hi - d, lo, hi), 12);
    }
  });

  it('is the arithmetic the blur shader carries', () => {
    expect(source).toContain('float first = ceil(lo - 0.5) + 0.5;');
    expect(source).toContain('float last = floor(hi - 0.5) + 0.5;');
    expect(source).toContain('return clamp(lo + t, first, last);');
  });
});

describe('saturateMatrix', () => {
  // Filter Effects' own definition: s·I + (1 − s)·L, L the projection onto the
  // luminance weights 0.213 / 0.715 / 0.072 in every channel.
  const definition = (s: number): number[] => {
    const lum = [0.213, 0.715, 0.072];
    return Array.from({ length: 9 }, (_, i) => (Math.floor(i / 3) === i % 3 ? s : 0) + (1 - s) * lum[i % 3]);
  };

  it('is the specification\'s matrix', () => {
    for (const s of [0, 0.5, 1, 1.6, 3]) {
      const m = saturateMatrix(s);
      definition(s).forEach((v, i) => expect(m[i]).toBeCloseTo(v, 12));
    }
  });

  it('is the matrix the composite shader carries (GLSL\'s mat3 is column-major)', () => {
    const literal = source.match(/mat3 m = mat3\(([\s\S]*?)\);/)?.[1];
    expect(literal).toBeDefined();
    for (const s of [0.4, 1.6]) {
      const columns = literal!.split(',').map((x) => Function('s', `return ${x.trim()};`)(s) as number);
      expect(columns).toHaveLength(9);
      const rowMajor = Array.from({ length: 9 }, (_, i) => columns[(i % 3) * 3 + Math.floor(i / 3)]);
      definition(s).forEach((v, i) => expect(rowMajor[i]).toBeCloseTo(v, 12));
    }
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

// ---------------------------------------------------------------------------
// The renderer side, through a renderer that records what it is asked to do.

type Call = { op: 'target' | 'clear' | 'render'; target: unknown; autoClear: boolean; dither?: unknown; box?: unknown; material?: unknown };

class FakeRenderer {
  autoClear = true;
  toneMappingExposure = 1.7;
  outputColorSpace = 'srgb';
  toneMapping = 4;
  calls: Call[] = [];
  failOnRender = -1;
  private target: unknown = null;
  getDrawingBufferSize(v: THREE.Vector2): THREE.Vector2 { return v.set(400, 200); }
  getRenderTarget(): unknown { return this.target; }
  setRenderTarget(t: unknown): void { this.target = t; this.calls.push({ op: 'target', target: t, autoClear: this.autoClear }); }
  clear(): void { this.calls.push({ op: 'clear', target: this.target, autoClear: this.autoClear }); }
  compile(): void { /* nothing to link */ }
  render(mesh: THREE.Mesh): void {
    const u = (mesh.material as THREE.ShaderMaterial).uniforms ?? {};
    this.calls.push({ op: 'render', target: this.target, autoClear: this.autoClear, dither: u.uDither?.value, box: u.uBox?.value, material: mesh.material });
    if (this.calls.filter((c) => c.op === 'render').length - 1 === this.failOnRender) throw new Error('lost context');
  }
}

function finishing(ready = true): GlassFinishing & { _outputColorSpace: string | null; _toneMapping: number | null } {
  return {
    material: { uniforms: { uDither: { value: 1 }, uBox: { value: 1 }, tDiffuse: { value: null }, toneMappingExposure: { value: 1 } } } as unknown as THREE.ShaderMaterial,
    _outputColorSpace: ready ? 'srgb' : null,
    _toneMapping: ready ? 4 : null,
  };
}

const panel: GlassRect = { x0: 10, y0: 20, x1: 110, y1: 60, radii: [8, 8, 8, 8], sigma: 24, saturation: 1.6, coverage: 1 };
const scene = { texture: new THREE.Texture() } as unknown as THREE.WebGLRenderTarget;
const asRenderer = (r: FakeRenderer) => r as unknown as THREE.WebGLRenderer;

describe('GlassBackdrop against a recording renderer', () => {
  it('draws nothing and touches no target in a frame with no glass', () => {
    const glass = new GlassBackdrop();
    const r = new FakeRenderer();
    glass.setFrame([]);
    glass.drawSource(asRenderer(r), scene, finishing());
    glass.composite(asRenderer(r));
    expect(r.calls).toEqual([]);
    expect(glass.frameComplete).toBe(true);
  });

  it('draws the source with the finishing pass\'s dither and box held off, then puts them and autoClear back', () => {
    const glass = new GlassBackdrop();
    const r = new FakeRenderer();
    const fin = finishing();
    glass.setFrame([panel]);
    glass.drawSource(asRenderer(r), scene, fin);
    const renders = r.calls.filter((c) => c.op === 'render');
    expect(renders).toHaveLength(4);
    expect(renders[0].material).toBe(fin.material);
    expect(renders[0].dither).toBe(0);
    expect(renders[0].box).toBe(0);
    expect(renders.every((c) => c.autoClear === false && c.target !== null)).toBe(true);
    // Every offscreen pass opens with a clear of its own target.
    for (const c of renders) expect(r.calls.some((d) => d.op === 'clear' && d.target === c.target)).toBe(true);
    const u = (fin.material as THREE.ShaderMaterial).uniforms;
    expect(u.uDither.value).toBe(1);
    expect(u.uBox.value).toBe(1);
    expect(u.tDiffuse.value).toBe(scene.texture);
    expect(u.toneMappingExposure.value).toBe(1.7);
    expect(r.autoClear).toBe(true);
    expect(glass.frameComplete).toBe(true);
  });

  it('puts the finishing pass\'s uniforms and autoClear back even when a draw throws', () => {
    const glass = new GlassBackdrop();
    const r = new FakeRenderer();
    r.failOnRender = 0;
    const fin = finishing();
    glass.setFrame([panel]);
    expect(() => glass.drawSource(asRenderer(r), scene, fin)).toThrow('lost context');
    const u = (fin.material as THREE.ShaderMaterial).uniforms;
    expect(u.uDither.value).toBe(1);
    expect(u.uBox.value).toBe(1);
    expect(r.autoClear).toBe(true);
    expect(glass.frameComplete).toBe(false);
  });

  it('leaves a frame to the browser while the finishing pass has not built its defines', () => {
    const glass = new GlassBackdrop();
    const r = new FakeRenderer();
    glass.setFrame([panel]);
    glass.drawSource(asRenderer(r), scene, finishing(false));
    glass.composite(asRenderer(r));
    expect(r.calls).toEqual([]);
    expect(glass.frameComplete).toBe(false);
    glass.endFrame();
    expect(glass.stats()).toEqual({ rects: 1, drew: false, skipped: 'finishing pass not drawn yet' });
  });

  it('composites only after its own source pass drew, onto the canvas, without clearing it', () => {
    const glass = new GlassBackdrop();
    const r = new FakeRenderer();
    glass.setFrame([panel]);
    glass.composite(asRenderer(r));
    expect(r.calls).toEqual([]);
    glass.drawSource(asRenderer(r), scene, finishing());
    r.calls = [];
    glass.composite(asRenderer(r));
    expect(r.calls.filter((c) => c.op === 'render')).toHaveLength(1);
    expect(r.calls.find((c) => c.op === 'render')!.target).toBeNull();
    expect(r.calls.some((c) => c.op === 'clear')).toBe(false);
    expect(r.calls.find((c) => c.op === 'render')!.autoClear).toBe(false);
    expect(r.autoClear).toBe(true);
    // After the frame nothing is carried: a stray draw composites nothing.
    glass.endFrame();
    r.calls = [];
    glass.composite(asRenderer(r));
    expect(r.calls).toEqual([]);
  });

  it('warms: makes the targets at the canvas\'s size, then draws one invisible panel through every pass, once', () => {
    const glass = new GlassBackdrop();
    const r = new FakeRenderer();
    glass.warm(asRenderer(r));
    expect(glass.targetOf('half')).toMatchObject({ width: 200, height: 100 });
    expect(glass.targetOf('quarter')).toMatchObject({ width: 100, height: 50 });
    expect(glass.targetOf('scratch')).toMatchObject({ width: 100, height: 50 });
    r.calls = [];
    glass.setFrame([]);
    glass.drawSource(asRenderer(r), scene, finishing());
    glass.composite(asRenderer(r));
    expect(r.calls.filter((c) => c.op === 'render')).toHaveLength(5);
    // The frame had no panel of its own: the browser's blur is not involved.
    expect(glass.frameComplete).toBe(true);
    glass.endFrame();
    expect(glass.stats().rects).toBe(0);
    r.calls = [];
    glass.setFrame([]);
    glass.drawSource(asRenderer(r), scene, finishing());
    glass.composite(asRenderer(r));
    expect(r.calls).toEqual([]);
  });
});
