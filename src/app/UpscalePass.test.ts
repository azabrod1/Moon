import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  DownsamplePass, OutputTargetPass, SharpenPass, UpscalePass, createLdrTarget, downsampleAxisWeights,
} from './UpscalePass';
import { easuConstants, rcasSharpness, RCAS_DEFAULT_STOPS } from './fsr1';

/** What the passes ask of a renderer, and nothing else. */
function stubRenderer(bufferW: number, bufferH: number) {
  const targets: (THREE.WebGLRenderTarget | null)[] = [];
  let draws = 0;
  const renderer = {
    setRenderTarget: (t: THREE.WebGLRenderTarget | null) => { targets.push(t); },
    getDrawingBufferSize: (v: THREE.Vector2) => v.set(bufferW, bufferH),
    render: () => { draws++; },
    clear: () => {},
    toneMappingExposure: 1,
    outputColorSpace: THREE.SRGBColorSpace,
    toneMapping: THREE.ACESFilmicToneMapping,
    autoClearColor: true,
    autoClearDepth: true,
    autoClearStencil: true,
  } as unknown as THREE.WebGLRenderer;
  return { renderer, targets, draws: () => draws };
}

const materialOf = (pass: object): THREE.RawShaderMaterial =>
  (pass as unknown as { material: THREE.RawShaderMaterial }).material;

describe('the 8-bit target', () => {
  it('is raw RGBA8 storage with a linear filter and no depth', () => {
    const t = createLdrTarget();
    expect(t.texture.format).toBe(THREE.RGBAFormat);
    expect(t.texture.type).toBe(THREE.UnsignedByteType);
    expect(t.texture.colorSpace).toBe(THREE.NoColorSpace);
    // Named by hand: an sRGB storage would be decoded on every fetch and the
    // filter would run on linear light (screenTarget.ts names it for the same reason).
    expect(t.texture.internalFormat).toBe('RGBA8');
    expect(t.texture.minFilter).toBe(THREE.LinearFilter);
    expect(t.texture.magFilter).toBe(THREE.LinearFilter);
    expect(t.texture.generateMipmaps).toBe(false);
    expect(t.depthBuffer).toBe(false);
    expect(t.stencilBuffer).toBe(false);
  });
});

describe('OutputTargetPass', () => {
  it('draws the canvas when it is the last enabled pass, and allocates nothing', () => {
    const { renderer, targets } = stubRenderer(860, 1864);
    const pass = new OutputTargetPass();
    expect(pass.needsSwap).toBe(false);
    pass.renderToScreen = true;
    const read = new THREE.WebGLRenderTarget(860, 1864);
    pass.render(renderer, read, read);
    expect(targets).toEqual([null]);
    expect(pass.target).toBeNull();
  });

  it('draws its own target at the scene size when something follows, refitting as the size moves', () => {
    const { renderer, targets, draws } = stubRenderer(860, 1864);
    const pass = new OutputTargetPass();
    pass.renderToScreen = false;
    const read = new THREE.WebGLRenderTarget(645, 1398);
    pass.render(renderer, read, read);
    expect(pass.target).not.toBeNull();
    expect(pass.target!.width).toBe(645);
    expect(pass.target!.height).toBe(1398);
    expect(targets).toEqual([pass.target]);
    expect(draws()).toBe(1);
    const first = pass.target;
    pass.render(renderer, read, read);
    expect(pass.target).toBe(first); // fitted, not remade
    const bigger = new THREE.WebGLRenderTarget(860, 1864);
    pass.render(renderer, bigger, bigger);
    expect(pass.target).toBe(first);
    expect(pass.target!.width).toBe(860);
    expect(pass.target!.height).toBe(1864);
  });

  it('lets its target go with the pass', () => {
    const { renderer } = stubRenderer(860, 1864);
    const pass = new OutputTargetPass();
    pass.renderToScreen = false;
    const read = new THREE.WebGLRenderTarget(645, 1398);
    pass.render(renderer, read, read);
    pass.dispose();
    expect(pass.target).toBeNull();
  });
});

describe('UpscalePass', () => {
  const drawnSource = (renderer: THREE.WebGLRenderer) => {
    const source = new OutputTargetPass();
    source.renderToScreen = false;
    const read = new THREE.WebGLRenderTarget(645, 1398);
    source.render(renderer, read, read);
    return source;
  };

  it('is a raw GLSL3 material, so drawing the canvas one frame and a target the next relinks nothing', () => {
    const pass = new UpscalePass(new OutputTargetPass());
    const material = materialOf(pass);
    expect(material.isRawShaderMaterial).toBe(true);
    expect(material.glslVersion).toBe(THREE.GLSL3);
    expect(material.depthTest).toBe(false);
    expect(material.depthWrite).toBe(false);
    expect(material.blending).toBe(THREE.NoBlending);
    expect(pass.needsSwap).toBe(false);
  });

  it('draws nothing while the finishing pass drew the canvas itself', () => {
    const { renderer, targets, draws } = stubRenderer(860, 1864);
    const pass = new UpscalePass(new OutputTargetPass());
    pass.renderToScreen = true;
    pass.render(renderer);
    expect(draws()).toBe(0);
    expect(targets).toEqual([]);
  });

  it('resamples the finishing pass\'s target to the canvas at the drawing-buffer size', () => {
    const { renderer, targets, draws } = stubRenderer(860, 1864);
    const source = drawnSource(renderer);
    targets.length = 0;
    const pass = new UpscalePass(source);
    pass.renderToScreen = true;
    pass.render(renderer);
    expect(draws()).toBe(2);
    expect(targets).toEqual([null]);
    expect(pass.target).toBeNull();
    const u = materialOf(pass).uniforms;
    expect((u.uCon0.value as THREE.Vector4).toArray()).toEqual(easuConstants(645, 1398, 860, 1864));
    expect((u.uInputMax.value as THREE.Vector2).toArray()).toEqual([644, 1397]);
    // The texture is let go after the draw, as the other passes do.
    expect(u.tInput.value).toBeNull();
  });

  it('draws its own output-size target when the sharpen pass follows', () => {
    const { renderer, targets } = stubRenderer(860, 1864);
    const source = drawnSource(renderer);
    targets.length = 0;
    const pass = new UpscalePass(source);
    pass.renderToScreen = false;
    pass.render(renderer);
    expect(pass.target).not.toBeNull();
    expect(pass.target!.width).toBe(860);
    expect(pass.target!.height).toBe(1864);
    expect(targets).toEqual([pass.target]);
  });
});

describe('SharpenPass', () => {
  it('starts at the default stops and follows setSharpness', () => {
    const pass = new SharpenPass(new UpscalePass(new OutputTargetPass()));
    expect(pass.needsSwap).toBe(false);
    expect(pass.sharpness).toBe(RCAS_DEFAULT_STOPS);
    expect(materialOf(pass).uniforms.uSharpness.value).toBeCloseTo(rcasSharpness(RCAS_DEFAULT_STOPS), 12);
    pass.setSharpness(0);
    expect(pass.sharpness).toBe(0);
    expect(materialOf(pass).uniforms.uSharpness.value).toBe(1);
    expect(materialOf(pass).isRawShaderMaterial).toBe(true);
  });

  it('draws nothing while the upscale pass drew the canvas itself', () => {
    const { renderer, draws } = stubRenderer(860, 1864);
    const pass = new SharpenPass(new UpscalePass(new OutputTargetPass()));
    pass.render(renderer);
    expect(draws()).toBe(0);
  });

  it('sharpens the upscale pass\'s target onto the canvas', () => {
    const { renderer, targets, draws } = stubRenderer(860, 1864);
    const source = new OutputTargetPass();
    source.renderToScreen = false;
    const read = new THREE.WebGLRenderTarget(645, 1398);
    source.render(renderer, read, read);
    const up = new UpscalePass(source);
    up.renderToScreen = false;
    up.render(renderer);
    targets.length = 0;
    const pass = new SharpenPass(up);
    pass.render(renderer);
    expect(draws()).toBe(3);
    expect(targets).toEqual([null]);
    const u = materialOf(pass).uniforms;
    expect((u.uInputMax.value as THREE.Vector2).toArray()).toEqual([859, 1863]);
    expect(u.tInput.value).toBeNull();
  });
});

describe('the downsample kernel', () => {
  const sum = (w: readonly number[]) => w.reduce((a, b) => a + b, 0);

  it('normalises to 1 at every sub-pixel phase, either kernel', () => {
    // 1.5 is the largest supersample the policy offers; 1.25 and 1.15 are the
    // other rungs, and the sizes are floored, so the phases are not periodic.
    for (const [inSize, outSize] of [[2592, 1728], [2160, 1728], [1987, 1728], [1729, 1728]]) {
      for (let out = 0; out < outSize; out += 37) {
        for (const filter of ['box', 'tent'] as const) {
          const { weights } = downsampleAxisWeights(inSize, outSize, out, filter);
          expect(sum(weights)).toBeCloseTo(1, 12);
        }
      }
    }
  });

  it('normalises to 1 at both borders, where part of the footprint is off the image', () => {
    for (const [inSize, outSize] of [[2592, 1728], [1987, 1728]]) {
      for (const out of [0, 1, outSize - 2, outSize - 1]) {
        for (const filter of ['box', 'tent'] as const) {
          const { weights } = downsampleAxisWeights(inSize, outSize, out, filter);
          expect(sum(weights)).toBeCloseTo(1, 12);
        }
      }
    }
  });

  it('weighs a tap by how much of it the footprint really covers, and an empty one at zero', () => {
    // 3:2 exactly. Output pixel 0 covers source [0, 1.5]: all of texel 0,
    // half of texel 1, none of texel 2.
    const first = downsampleAxisWeights(3, 2, 0);
    expect(first.base).toBe(0);
    expect(first.weights).toEqual([0, 2 / 3, 1 / 3]);
    // Output pixel 1 covers [1.5, 3]: half of texel 1, all of texel 2.
    const second = downsampleAxisWeights(3, 2, 1);
    expect(second.base).toBe(2);
    expect(second.weights).toEqual([1 / 3, 2 / 3, 0]);
  });

  it('leaves the outer ring at exactly zero on the far side at 1.5, so nine taps are four', () => {
    // An area box 1.5 texels wide covers two texels per axis, so at every
    // phase at least one of the two outer taps carries nothing at all: the
    // third tap is there for a footprint that straddles three, which a ratio
    // below 1.5 with a drifting phase really does.
    for (let out = 0; out < 64; out++) {
      const { weights } = downsampleAxisWeights(2592, 1728, out);
      expect(weights[0] === 0 || weights[2] === 0).toBe(true);
      expect(weights.filter((w) => w > 0).length).toBeLessThanOrEqual(2);
    }
  });

  it('keeps the whole footprint inside its three taps at every rung', () => {
    // The base is floored rather than rounded for exactly this reason: a
    // rounded base can sit one texel past a footprint that straddles three,
    // and the sliver it misses is up to a sixth of the weight.
    for (const [inSize, outSize] of [[2592, 1728], [2160, 1728], [1987, 1728]]) {
      const f = inSize / outSize;
      for (let out = 0; out < outSize; out += 13) {
        const { base } = downsampleAxisWeights(inSize, outSize, out);
        expect(base - 1).toBeLessThanOrEqual(Math.floor(out * f));
        expect(base + 1).toBeGreaterThanOrEqual(Math.ceil((out + 1) * f) - 1);
      }
    }
  });

  it('spreads a tent wider than the box, which is what makes it the soft arm', () => {
    // Output pixel 1 of a 3:2 shrink covers source [1.5, 3]: the box stops at
    // texel 2, the tent's radius reaches texel 3 as well.
    const box = downsampleAxisWeights(3, 2, 1, 'box');
    const tent = downsampleAxisWeights(3, 2, 1, 'tent');
    expect(box.weights[2]).toBe(0);
    expect(tent.weights[2]).toBeGreaterThan(0);
    // And the middle texel, the one the footprint really is centred on, keeps
    // less of the output than the box gives it.
    expect(tent.weights[1]).toBeLessThan(box.weights[1]);
  });
});

describe('DownsamplePass', () => {
  const drawnSource = (renderer: THREE.WebGLRenderer, w: number, h: number) => {
    const source = new OutputTargetPass();
    source.renderToScreen = false;
    const read = new THREE.WebGLRenderTarget(w, h);
    source.render(renderer, read, read);
    return source;
  };

  it('is a raw GLSL3 material like the rest of the chain, and swaps nothing', () => {
    const pass = new DownsamplePass(new OutputTargetPass());
    const material = materialOf(pass);
    expect(material.isRawShaderMaterial).toBe(true);
    expect(material.glslVersion).toBe(THREE.GLSL3);
    expect(material.depthTest).toBe(false);
    expect(material.depthWrite).toBe(false);
    expect(material.blending).toBe(THREE.NoBlending);
    expect(pass.needsSwap).toBe(false);
    expect(pass.kernel).toBe('box');
  });

  it('draws nothing while the finishing pass drew the canvas itself', () => {
    const { renderer, targets, draws } = stubRenderer(1728, 1117);
    const pass = new DownsamplePass(new OutputTargetPass());
    pass.renderToScreen = true;
    pass.render(renderer);
    expect(draws()).toBe(0);
    expect(targets).toEqual([]);
    expect(pass.input).toBeNull();
  });

  it('averages the finishing pass\'s target onto the canvas at the drawing-buffer size', () => {
    const { renderer, targets, draws } = stubRenderer(3456, 2234);
    const source = drawnSource(renderer, 5184, 3351);
    targets.length = 0;
    const pass = new DownsamplePass(source);
    pass.renderToScreen = true;
    pass.render(renderer);
    expect(draws()).toBe(2);
    // Always last: it draws the canvas, never a target of its own.
    expect(targets).toEqual([null]);
    const u = materialOf(pass).uniforms;
    expect((u.uInputSize.value as THREE.Vector2).toArray()).toEqual([5184, 3351]);
    expect((u.uOutputSize.value as THREE.Vector2).toArray()).toEqual([3456, 2234]);
    expect(u.tInput.value).toBeNull();
  });

  it('picks the kernel through a uniform, so the A/B relinks nothing', () => {
    const pass = new DownsamplePass(new OutputTargetPass());
    expect(materialOf(pass).uniforms.uFilter.value).toBe(0);
    pass.setFilter('tent');
    expect(pass.kernel).toBe('tent');
    expect(materialOf(pass).uniforms.uFilter.value).toBe(1);
    pass.setFilter('box');
    expect(materialOf(pass).uniforms.uFilter.value).toBe(0);
  });
});
