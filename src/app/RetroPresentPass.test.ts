import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { RETRO_DITHER, RETRO_PRESENT_FRAGMENT_SHADER, RetroPresentPass } from './RetroPresentPass';
import { OutputTargetPass } from './UpscalePass';
import { retroGrid } from './retroScreen';
import { outputDitherIsWired } from './outputDither';

function stubRenderer(bufferW: number, bufferH: number) {
  const bound: (THREE.WebGLRenderTarget | null)[] = [];
  let draws = 0;
  const renderer = {
    setRenderTarget: (target: THREE.WebGLRenderTarget | null) => { bound.push(target); },
    getDrawingBufferSize: (vector: THREE.Vector2) => vector.set(bufferW, bufferH),
    render: () => { draws++; },
    clear: () => {},
    toneMappingExposure: 1,
    outputColorSpace: THREE.SRGBColorSpace,
    toneMapping: THREE.ACESFilmicToneMapping,
    autoClearColor: true,
    autoClearDepth: true,
    autoClearStencil: true,
  } as unknown as THREE.WebGLRenderer;
  return { renderer, bound, draws: () => draws };
}

/** The shader's Bayer function, line for line, to pin the pattern it makes. */
function bayer8(x: number, y: number): number {
  const mixed = (x & 7) ^ (y & 7);
  let index = 0;
  for (let bit = 0; bit < 3; bit++) index = (index << 2) | (((mixed >> bit) & 1) << 1) | (((y & 7) >> bit) & 1);
  return index;
}

describe('RetroPresentPass', () => {
  it('is a raw GLSL3 material that swaps nothing and starts disabled', () => {
    const pass = new RetroPresentPass(new OutputTargetPass(), () => retroGrid(2560, 1600, 2));
    expect(pass.material).toBeInstanceOf(THREE.RawShaderMaterial);
    expect(pass.material.glslVersion).toBe(THREE.GLSL3);
    expect(pass.needsSwap).toBe(false);
    expect(pass.enabled).toBe(false);
  });

  it('draws nothing until the finishing pass has drawn its own target', () => {
    const { renderer, draws } = stubRenderer(2560, 1600);
    const pass = new RetroPresentPass(new OutputTargetPass(), () => retroGrid(2560, 1600, 2));
    pass.renderToScreen = true;
    pass.render(renderer);
    expect(draws()).toBe(0);
  });

  it('presents the grid-sized target on the canvas with the grid it is handed', () => {
    const { renderer, bound, draws } = stubRenderer(2560, 1600);
    const finishing = new OutputTargetPass();
    finishing.renderToScreen = false;
    finishing.outputSize = { width: 320, height: 200 };
    const scene = new THREE.WebGLRenderTarget(480, 300);
    finishing.render(renderer, scene, scene);
    expect([finishing.target!.width, finishing.target!.height]).toEqual([320, 200]);
    const pass = new RetroPresentPass(finishing, () => retroGrid(2560, 1600, 2));
    pass.renderToScreen = true;
    const before = draws();
    pass.render(renderer);
    expect(draws()).toBe(before + 1);
    expect(bound[bound.length - 1]).toBeNull();
    const u = pass.material.uniforms;
    expect(u.uBlock.value).toBe(8);
    expect((u.uVirtual.value as THREE.Vector2).toArray()).toEqual([320, 200]);
    expect((u.uBuffer.value as THREE.Vector2).toArray()).toEqual([2560, 1600]);
    expect(u.uBayer.value).toBeCloseTo(RETRO_DITHER, 12);
    // The input is let go after the draw; the lookup texture is kept.
    expect(u.tInput.value).toBeNull();
    expect((u.tPalette.value as THREE.DataTexture).image.width).toBe(1024);
    expect((u.tPalette.value as THREE.DataTexture).magFilter).toBe(THREE.NearestFilter);
  });

  it('counts big pixels from the top-left, fetches one exact texel, and carries no output dither', () => {
    expect(RETRO_PRESENT_FRAGMENT_SHADER).toContain('floor((uBuffer.y - gl_FragCoord.y) / uBlock)');
    expect(RETRO_PRESENT_FRAGMENT_SHADER).toContain('texelFetch(tInput, ivec2(big.x, uVirtual.y - 1 - big.y), 0)');
    expect(RETRO_PRESENT_FRAGMENT_SHADER).not.toContain('texture(');
    expect(RETRO_PRESENT_FRAGMENT_SHADER).not.toContain('gl_FragCoord.xy +');
    expect(outputDitherIsWired(RETRO_PRESENT_FRAGMENT_SHADER)).toBe(false);
    expect(RETRO_PRESENT_FRAGMENT_SHADER).toContain('fragColor = vec4(texelFetch(tPalette, ivec2(key.r + 32 * key.b, key.g), 0).rgb, 1.0);');
  });

  it('uses the 8 × 8 Bayer pattern: every threshold once in each 8 × 8 tile', () => {
    const seen = new Set<number>();
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) seen.add(bayer8(x, y));
    expect(seen.size).toBe(64);
    expect([bayer8(0, 0), bayer8(1, 0), bayer8(0, 1), bayer8(1, 1)]).toEqual([0, 32, 48, 16]);
    // Fixed to the big pixel: the same at the same place in every tile.
    expect(bayer8(3, 5)).toBe(bayer8(11, 21));
  });
});
