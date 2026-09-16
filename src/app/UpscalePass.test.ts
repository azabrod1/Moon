import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { OutputTargetPass, SharpenPass, UpscalePass, createLdrTarget } from './UpscalePass';
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
