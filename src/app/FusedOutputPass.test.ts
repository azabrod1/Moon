import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  FusedOutputPass, fusedBoxAxis, fusedBoxTaps, fusedFragmentIsWired, fusedFragmentText, parseFusedDownParam,
  parseFusedParam, type FusedVariant,
} from './FusedOutputPass';
import { downsampleAxisWeights, type DownsampleFilter } from './UpscalePass';
import { OUTPUT_DITHER_ADD, OUTPUT_OPAQUE_WRITE, outputWriteIsOpaque } from './outputDither';
import { lensOverscanFovDeg, lensSourceFootprint, makeLensWarpContext } from '../shared/math/lensProjection';

const VARIANTS: FusedVariant[] = [];
for (const lens of [false, true]) {
  for (const glow of [false, true]) {
    for (const box of [false, true]) VARIANTS.push({ lens, glow, box });
  }
}
const same = (a: FusedVariant, b: FusedVariant): boolean =>
  a.lens === b.lens && a.glow === b.glow && (a.box ?? false) === (b.box ?? false);

describe('the finishing pass’s eight shader texts', () => {
  it('each carries exactly the edits its variant is made of', () => {
    // Every one of them is a string replacement into three's own OutputShader,
    // and a replacement that found nothing is silent: a pass that drops the
    // glow, one that reads its whole allocation where the frame is a corner of
    // it, or one whose warp is missing so the frame comes out rectilinear.
    for (const variant of VARIANTS) {
      expect(fusedFragmentIsWired(variant), JSON.stringify(variant)).toBe(true);
    }
  });

  it('keeps the eight apart, so one mode’s text never reaches another', () => {
    // There is one composer in the app, rebuilt per camera: the planetarium
    // wants the warp and the box and the other three modes want neither. A
    // single memoised text would hand whichever mode was entered first its own
    // text to every later one — silently: three uploads only the uniforms a
    // material carries, so a warped text on a material without the warp
    // uniforms draws the plain read at a strength of zero, and a text without
    // the glow line on a composer with a bloom chain draws no glow at all.
    const texts = VARIANTS.map((v) => fusedFragmentText(v));
    expect(new Set(texts).size).toBe(8);
    for (const [i, variant] of VARIANTS.entries()) {
      expect(texts[i].includes('lensSourceUv')).toBe(variant.lens);
      expect(texts[i].includes('tBloom')).toBe(variant.glow);
      expect(texts[i].includes('uBox')).toBe(variant.box);
      // And a text held against the wrong variant is reported as unwired.
      for (const other of VARIANTS) {
        expect(fusedFragmentIsWired(other, { fragmentShader: texts[i] } as never)).toBe(same(other, variant));
      }
    }
  });

  it('reads a variant with no box named as one without it', () => {
    expect(fusedFragmentText({ lens: true, glow: true })).toBe(fusedFragmentText({ lens: true, glow: true, box: false }));
  });

  it('is assembled once and kept', () => {
    // A module-level string edit is work a bundler keeps, so the texts are lazy
    // — and then they must be memoised, or every composer rebuild pays for four
    // string passes over three's shader.
    expect(fusedFragmentText({ lens: true, glow: true, box: true }))
      .toBe(fusedFragmentText({ lens: true, glow: true, box: true }));
  });

  it('tone-maps with three’s own text, untouched', () => {
    // Exposure, the tone curve and the output colour transform are OutputPass's
    // own, re-derived from the renderer per render: the fold adds lines to that
    // shader and changes none of them.
    for (const box of [false, true]) {
      const text = fusedFragmentText({ lens: true, glow: true, box });
      expect(text).toContain('#include <tonemapping_pars_fragment>');
      expect(text).toContain('#include <colorspace_pars_fragment>');
      expect(text).toContain('ACESFilmicToneMapping( gl_FragColor.rgb )');
      expect(text).toContain('sRGBTransferOETF( gl_FragColor )');
    }
  });
});

describe('the supersample’s box in the finishing text', () => {
  const box = fusedFragmentText({ lens: true, glow: true, box: true });
  const one = fusedFragmentText({ lens: true, glow: true, box: false });
  const fn = box.slice(box.indexOf('vec3 fusedBoxAverage() {'), box.indexOf('void main() {'));
  const branchAt = box.indexOf('if ( uBox > 0.5 ) {');
  const elseAt = box.indexOf('} else {', branchAt);
  const branch = box.slice(branchAt, elseAt);

  it('keeps the single-read body whole behind the branch, so ratio 2 draws what it drew', () => {
    // At ratio 2 and below uBox is 0 and the program runs the text it always
    // ran: three's body, line for line, inside the else.
    const body = (t: string) => t.slice(t.indexOf('gl_FragColor = texture2D( tDiffuse'), t.lastIndexOf('#endif'));
    expect(body(box)).toBe(body(one));
    expect(branchAt).toBeGreaterThan(box.indexOf('void main() {'));
    expect(elseAt).toBeLessThan(box.indexOf('gl_FragColor = texture2D( tDiffuse, lensSourceUv( vUv ) );'));
  });

  it('finishes each tap before the sum, and never converts the sum again', () => {
    // Scene plus glow, the tone curve and the transfer per tap, then the sum
    // of encoded colours: what the downsample averaged. The single read and
    // its conversion are not kept in the box's branch, or the average would
    // be tone-mapped twice.
    const read = fn.indexOf('vec4 tap = texture2D( tDiffuse, clamp( s + dUdx * oi + dUdy * oj, vec2( 0.0 ), uUvMax ) );');
    expect(read).toBeGreaterThan(0);
    expect(fn.indexOf('tap.rgb += glow;')).toBeGreaterThan(read);
    expect(fn.indexOf('tap.rgb = ACESFilmicToneMapping( tap.rgb );')).toBeGreaterThan(fn.indexOf('tap.rgb += glow;'));
    expect(fn.indexOf('tap = sRGBTransferOETF( tap );')).toBeGreaterThan(fn.indexOf('tap.rgb = ACESFilmicToneMapping( tap.rgb );'));
    expect(fn.indexOf('sum += tap.rgb * ( wi * wj );')).toBeGreaterThan(fn.indexOf('tap = sRGBTransferOETF( tap );'));
    expect(fn.split('sRGBTransferOETF(')).toHaveLength(2);
    // The glow once a pixel, at its centre.
    expect(fn.split('texture2D( tBloom, vUv )')).toHaveLength(2);
    expect(fn.indexOf('texture2D( tBloom, vUv )')).toBeLessThan(fn.indexOf('for ( int j = 0;'));
    expect(branch).not.toContain('sRGBTransferOETF');
    expect(branch).not.toContain('tDiffuse');
  });

  it('places the taps along the unclamped map’s derivative, and clamps each tap', () => {
    expect(fn).toContain('vec2 s = lensSourceFootprint( vUv, uOutputSize, dUdx, dUdy );');
    expect(fn).not.toContain('lensSourceUv(');
    const flat = fusedFragmentText({ lens: false, glow: false, box: true });
    expect(flat).toContain('vec2 dUdx = vec2( uUvScale.x / uOutputSize.x, 0.0 );');
    expect(flat).toContain('vec2 dUdy = vec2( 0.0, uUvScale.y / uOutputSize.y );');
  });

  it('adds the dither after the average and ends opaque, in the box’s own branch', () => {
    // Canvas alpha is Earth's sea flag on the way through the chain, and Safari
    // composites the canvas with whatever alpha the last write left: the box's
    // write must say it is opaque, and say it last.
    expect(branch.indexOf('gl_FragColor = vec4( fusedBoxAverage(), 1.0 );')).toBeLessThan(branch.indexOf(OUTPUT_DITHER_ADD));
    expect(branch.indexOf(OUTPUT_DITHER_ADD)).toBeLessThan(branch.indexOf(OUTPUT_OPAQUE_WRITE));
    expect(outputWriteIsOpaque(branch)).toBe(true);
    expect(outputWriteIsOpaque(box)).toBe(true);
  });

  it('reports a box that converts its average again, or drops its dither, as unwired', () => {
    const variant = { lens: true, glow: true, box: true };
    const twice = box.replace('gl_FragColor = vec4( fusedBoxAverage(), 1.0 );',
      'gl_FragColor = vec4( fusedBoxAverage(), 1.0 );\n\t\tgl_FragColor = sRGBTransferOETF( gl_FragColor );');
    expect(fusedFragmentIsWired(variant, { fragmentShader: twice } as never)).toBe(false);
    const undithered = box.replace(`${OUTPUT_DITHER_ADD}\n\t\t${OUTPUT_OPAQUE_WRITE}\n\n\t} else {`, `${OUTPUT_OPAQUE_WRITE}\n\n\t} else {`);
    expect(undithered).not.toBe(box);
    expect(fusedFragmentIsWired(variant, { fragmentShader: undithered } as never)).toBe(false);
    const translucent = box.replace(`${OUTPUT_OPAQUE_WRITE}\n\n\t} else {`, '\n\t} else {');
    expect(translucent).not.toBe(box);
    expect(fusedFragmentIsWired(variant, { fragmentShader: translucent } as never)).toBe(false);
  });
});

describe('the box’s taps against the downsample’s rule', () => {
  // [scene drawn, canvas] per axis: High on a 16" Mac (1.5 both ways),
  // Dynamic's 2.5 on it (1.25 across, 2792/2234 down, the floored odd
  // height), an odd canvas, a 4/3 that is not exact in float, and two drifting
  // ratios.
  const PAIRS: [number, number][] = [
    [5184, 3456], [3351, 2234], [4320, 3456], [2792, 2234], [3352, 2235], [3353, 2235],
    [2304, 1728], [1987, 1728], [2593, 1729], [1729, 1728], [3, 2], [5, 4],
  ];
  const FILTERS: DownsampleFilter[] = ['box', 'tent'];

  /** Each fetched texel and the weight it carries, from either rule. */
  const fetched = (entries: [number, number][]): Map<number, number> => {
    const m = new Map<number, number>();
    for (const [i, w] of entries) if (w !== 0) m.set(i, (m.get(i) ?? 0) + w);
    return m;
  };

  it('reads every texel the downsample read, at the weight it read it', () => {
    for (const [inSize, outSize] of PAIRS) {
      for (const filter of FILTERS) {
        const taps = fusedBoxTaps(inSize, outSize, filter);
        for (let out = 0; out < outSize; out++) {
          const ref = downsampleAxisWeights(inSize, outSize, out, filter);
          const want = fetched(ref.weights.map((w, k) => [Math.min(Math.max(ref.base + k - 1, 0), inSize - 1), w]));
          const got = fusedBoxAxis(inSize, outSize, out, filter, taps);
          const have = fetched(got.weights.map((w, k) => [got.fetch[k], w]));
          const label = `${inSize}/${outSize} ${filter} at ${out}`;
          expect([...have.keys()].sort(), label).toEqual([...want.keys()].sort());
          for (const [i, w] of want) expect(have.get(i)!, label).toBeCloseTo(w, 12);
        }
      }
    }
  });

  it('reads two taps per axis where the ratio is 1.5 or 1.25, none of them empty', () => {
    // Four finishes a pixel at High and at Dynamic's 2.5 on an even window,
    // and no tap that carries nothing.
    for (const [inSize, outSize] of [[5184, 3456], [3351, 2234], [4320, 3456], [3, 2], [5, 4]] as const) {
      expect(fusedBoxTaps(inSize, outSize, 'box')).toBe(2);
      for (let out = 0; out < outSize; out++) {
        const { weights } = fusedBoxAxis(inSize, outSize, out, 'box', 2);
        expect(weights[0]).toBeGreaterThan(0);
        expect(weights[1]).toBeGreaterThan(0);
        expect(weights[2]).toBe(0);
      }
    }
  });

  it('keeps the downsample’s three where two would miss a texel or float could', () => {
    // 2792/2234 drifts, so a footprint straddles three texels about one row in
    // four; 4/3 never does in exact arithmetic, but 4/3 is not exact in float,
    // and a footprint edge computed a hair low would start one texel early.
    expect(fusedBoxTaps(2792, 2234, 'box')).toBe(3);
    expect(fusedBoxTaps(2304, 1728, 'box')).toBe(3);
    expect(fusedBoxTaps(1987, 1728, 'box')).toBe(3);
    // The tent reaches past its footprint and always reads the three.
    for (const [inSize, outSize] of PAIRS) expect(fusedBoxTaps(inSize, outSize, 'tent')).toBe(3);
  });

  it('lands every tap on its texel’s centre at lens strength 0, in a Dynamic sub-rect', () => {
    // Dynamic's 2.5 inside the 3x allocation: drawn 4320x2792 in 5184x3351, the
    // canvas 3456x2234. At strength 0 the map is the scaled read, and a tap is
    // exactly the texel the downsample's pixel read: (texel + 0.5) / allocation.
    const alloc = { width: 5184, height: 3351 };
    const drawn = { width: 4320, height: 2792 };
    const out = { width: 3456, height: 2234 };
    const scale = { x: drawn.width / alloc.width, y: drawn.height / alloc.height };
    const ctx = makeLensWarpContext(60, 60, out.width / out.height, 0, { tanHalfRender: 0, aspect: 1, strength: 0, rEdge: 1 });
    for (const filter of FILTERS) {
      const tapsX = fusedBoxTaps(drawn.width, out.width, filter);
      const tapsY = fusedBoxTaps(drawn.height, out.height, filter);
      for (const [px, py] of [[0, 0], [1, 1], [1727, 1116], [3455, 2233], [2001, 77], [3, 2232]]) {
        const fp = lensSourceFootprint(ctx, scale, (px + 0.5) / out.width, (py + 0.5) / out.height, out.width, out.height);
        const ax = fusedBoxAxis(drawn.width, out.width, px, filter, tapsX);
        const ay = fusedBoxAxis(drawn.height, out.height, py, filter, tapsY);
        for (let i = 0; i < tapsX; i++) {
          for (let j = 0; j < tapsY; j++) {
            const x = fp.x + fp.dUdx[0] * ax.offsets[i] + fp.dUdy[0] * ay.offsets[j];
            const y = fp.y + fp.dUdx[1] * ax.offsets[i] + fp.dUdy[1] * ay.offsets[j];
            expect(x * alloc.width).toBeCloseTo(ax.fetch[i] + 0.5, 9);
            expect(y * alloc.height).toBeCloseTo(ay.fetch[j] + 0.5, 9);
            // Inside the drawn sub-rect, so the uUvMax clamp never moves it.
            expect(x).toBeLessThanOrEqual(scale.x - 0.5 / alloc.width + 1e-12);
            expect(y).toBeLessThanOrEqual(scale.y - 0.5 / alloc.height + 1e-12);
          }
        }
      }
    }
  });

  it('lands the taps where the old pass’s pixels sampled, to a hair, with the lens on', () => {
    // The old pass finished each scene-sized pixel through the warp at its
    // own centre; the box solves the warp once and extends it along its
    // derivative. They differ by the warp's curvature over a pixel.
    const out = { width: 3456, height: 2234 };
    const drawn = { width: 5184, height: 3351 };
    const scale = { x: 1, y: 1 };
    const aspect = out.width / out.height;
    const ctx = makeLensWarpContext(60, lensOverscanFovDeg(60, aspect, 1), aspect, 1,
      { tanHalfRender: 0, aspect: 1, strength: 0, rEdge: 1 });
    let worstTexels = 0;
    for (const [px, py] of [[0, 0], [3455, 2233], [1728, 1117], [100, 2000], [3000, 300]]) {
      const fp = lensSourceFootprint(ctx, scale, (px + 0.5) / out.width, (py + 0.5) / out.height, out.width, out.height);
      const ax = fusedBoxAxis(drawn.width, out.width, px, 'box', 2);
      const ay = fusedBoxAxis(drawn.height, out.height, py, 'box', 2);
      for (let i = 0; i < 2; i++) {
        for (let j = 0; j < 2; j++) {
          const x = fp.x + fp.dUdx[0] * ax.offsets[i] + fp.dUdy[0] * ay.offsets[j];
          const y = fp.y + fp.dUdx[1] * ax.offsets[i] + fp.dUdy[1] * ay.offsets[j];
          const exact = lensSourceFootprint(ctx, scale, (ax.fetch[i] + 0.5) / drawn.width, (ay.fetch[j] + 0.5) / drawn.height, out.width, out.height);
          worstTexels = Math.max(worstTexels, Math.abs(x - exact.x) * drawn.width, Math.abs(y - exact.y) * drawn.height);
        }
      }
    }
    expect(worstTexels).toBeLessThan(1e-3);
  });
});

describe('FusedOutputPass with the box', () => {
  function stubRenderer(bufferW: number, bufferH: number) {
    let bound: THREE.WebGLRenderTarget | null | undefined;
    const renderer = {
      setRenderTarget: (t: THREE.WebGLRenderTarget | null) => { bound = t; },
      getDrawingBufferSize: (v: THREE.Vector2) => v.set(bufferW, bufferH),
      render: () => {},
      clear: () => {},
      toneMappingExposure: 1,
      outputColorSpace: THREE.SRGBColorSpace,
      toneMapping: THREE.ACESFilmicToneMapping,
      autoClearColor: true,
      autoClearDepth: true,
      autoClearStencil: true,
    } as unknown as THREE.WebGLRenderer;
    return { renderer, bound: () => bound };
  }
  /** The scene target as Dynamic leaves it at 2.5: a 3x allocation with the
   *  frame drawn into its corner. */
  const dynamicScene = () => {
    const t = new THREE.WebGLRenderTarget(5184, 3351);
    t.viewport.set(0, 0, 4320, 2792);
    return t;
  };

  it('crosses between ratio 2 and 2.5 with a uniform, and relinks nothing', () => {
    // The step a Dynamic rung makes: the downsample's direction comes and goes
    // and the program stays the one it was. three relinks on a material whose
    // version moved or whose text or defines changed; neither may.
    const { renderer } = stubRenderer(3456, 2234);
    const pass = new FusedOutputPass({ bloom: null, lens: null, box: true });
    pass.renderToScreen = true;
    const scene = dynamicScene();
    pass.render(renderer, scene, scene);
    const material = pass.material as THREE.RawShaderMaterial;
    const version = material.version;
    const text = material.fragmentShader;
    const defines = JSON.stringify(material.defines);
    const uniforms = material.uniforms;
    for (const on of [true, false, true, true, false]) {
      pass.setBox(on, 'box');
      pass.render(renderer, scene, scene);
      expect(material.uniforms.uBox.value).toBe(on ? 1 : 0);
      expect(pass.boxOn).toBe(on);
    }
    expect(material.version).toBe(version);
    expect(material.fragmentShader).toBe(text);
    expect(JSON.stringify(material.defines)).toBe(defines);
    expect(material.uniforms).toBe(uniforms);
  });

  it('takes the drawn sub-rect, the canvas and the tap counts at render', () => {
    const { renderer, bound } = stubRenderer(3456, 2234);
    const pass = new FusedOutputPass({ bloom: null, lens: null, box: true });
    pass.renderToScreen = true;
    pass.setBox(true, 'box');
    const scene = dynamicScene();
    pass.render(renderer, scene, scene);
    const u = (pass.material as THREE.RawShaderMaterial).uniforms;
    expect(bound()).toBeNull();
    expect((u.uInputSize.value as THREE.Vector2).toArray()).toEqual([4320, 2792]);
    expect((u.uOutputSize.value as THREE.Vector2).toArray()).toEqual([3456, 2234]);
    expect((u.uBoxTaps.value as THREE.Vector2).toArray()).toEqual([2, 3]);
    expect(u.uFilter.value).toBe(0);
    // Its own target is not made: the box draws the canvas.
    expect(pass.target).toBeNull();
    pass.setBox(true, 'tent');
    pass.render(renderer, scene, scene);
    expect(u.uFilter.value).toBe(1);
    expect((u.uBoxTaps.value as THREE.Vector2).toArray()).toEqual([3, 3]);
  });

  it('averages only while it draws the canvas', () => {
    // Its own target is scene-sized; a box drawn into it would be an
    // output-sized picture in a corner of it.
    const { renderer } = stubRenderer(3456, 2234);
    const pass = new FusedOutputPass({ bloom: null, lens: null, box: true });
    pass.renderToScreen = false;
    pass.setBox(true, 'box');
    const scene = dynamicScene();
    pass.render(renderer, scene, scene);
    expect((pass.material as THREE.RawShaderMaterial).uniforms.uBox.value).toBe(0);
  });

  it('ignores the box on a text that does not carry it', () => {
    const pass = new FusedOutputPass({ bloom: null, lens: null });
    pass.setBox(true, 'box');
    expect(pass.boxOn).toBe(false);
    expect((pass.material as THREE.RawShaderMaterial).uniforms.uBox).toBeUndefined();
    expect(fusedFragmentIsWired(pass.variant, pass.material as THREE.ShaderMaterial)).toBe(true);
  });
});

describe('the ?fused= kill switch', () => {
  it('is on unless a URL says 0', () => {
    expect(parseFusedParam('')).toBe(true);
    expect(parseFusedParam('?auto=planetarium')).toBe(true);
    expect(parseFusedParam('?fused=1')).toBe(true);
    expect(parseFusedParam('?fused=0')).toBe(false);
    expect(parseFusedParam('?debug=1&fused=0&quality=medium')).toBe(false);
  });
});

describe('the ?fuseddown= kill switch', () => {
  it('is on unless a URL says 0, and is its own key', () => {
    expect(parseFusedDownParam('')).toBe(true);
    expect(parseFusedDownParam('?fuseddown=1')).toBe(true);
    expect(parseFusedDownParam('?fuseddown=0')).toBe(false);
    expect(parseFusedDownParam('?quality=high&fuseddown=0')).toBe(false);
    expect(parseFusedDownParam('?fused=0')).toBe(true);
    expect(parseFusedParam('?fuseddown=0')).toBe(true);
  });
});
