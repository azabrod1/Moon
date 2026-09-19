/**
 * Screen targets: an off-screen render target that three shades EXACTLY as it
 * shades the canvas, so what used to be drawn straight onto a multisampled
 * canvas can be drawn onto one of these and copied across byte for byte.
 *
 * Why. The canvas is created without its own multisampling (main.ts): on the
 * composer path the canvas only ever receives one full-screen quad, so its
 * samples smoothed nothing and their resolve cost 2.9 ms of every frame on an
 * iPhone (20 %) and 3.5 ms on a Mac. But three things did draw straight onto
 * the canvas and relied on those samples: the no-float direct path, the
 * System Map and the corner chart. They draw here instead, with the samples
 * they had.
 *
 * How three treats it. A render target flagged `isXRRenderTarget` is shaded
 * as the screen is — tone mapping on (WebGLPrograms.js `toneMapping`,
 * WebGLRenderer.js setProgram), the program's output colour space taken from
 * the target's texture rather than forced linear (WebGLPrograms.js
 * `outputColorSpace`), and the scene's background Color cleared in that same
 * space (UniformsUtils.js getUnlitUniformColorSpace). With the texture's
 * colour space sRGB, every material encodes in-shader exactly as it does for
 * the canvas. The storage has to be plain RGBA8 for the bytes to be raw and
 * the resolve to average encoded bytes as the canvas's resolve does: three's
 * multisample renderbuffer gets that from the flag (WebGLTextures.js forces a
 * linear transfer for XR targets), but the resolve texture is allocated with
 * no such override and would come out SRGB8_ALPHA8 — an sRGB attachment
 * resolving in linear space, or a resolve blit between mismatched formats
 * that fails outright. So the internal format is named by hand, which
 * short-circuits the transfer logic for both allocations
 * (screenTarget.test.ts pins those three.js lines).
 *
 * Nothing else in three reads the flag on this renderer: framebuffer
 * selection, resize, dispose and the resolve path are flag-blind. The
 * programs a material links for this target carry the canvas's parameters,
 * so a material drawn to both relinks nothing.
 *
 * The copy is a raw texture fetch: a ShaderMaterial with no tone-mapping or
 * colour-space chunk (three only DEFINES those helpers for a ShaderMaterial;
 * a shader that never includes the chunks never calls them), and no blending
 * for an opaque image. The premultiplied variant composites a transparent
 * image drawn over a cleared alpha-0 target, whose colour is already
 * multiplied by coverage.
 *
 * Filtering is the caller's: a target copied 1:1 (the map, the chart) is
 * nearest-filtered, so a one-pixel size disagreement would alias rather than
 * blur; the target the lens resamples is linear, because the lens always
 * sampled its canvas copy linearly and a warp reads between texels.
 */

import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

/** The canvas's own sample count: what its resolve would cost, read from the context rather than the attribute the page asked for. */
export function canvasSampleCount(renderer: THREE.WebGLRenderer): number {
  const gl = renderer.getContext();
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(null);
  const samples = gl.getParameter(gl.SAMPLES) as number;
  renderer.setRenderTarget(prev);
  return samples;
}

/** The samples a screen target carries: what `antialias: true` gave the canvas on every engine measured, or fewer where the GPU has fewer. */
export function screenTargetSamples(renderer: THREE.WebGLRenderer): number {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  return Math.min(4, gl.getParameter(gl.MAX_SAMPLES) as number);
}

export interface ScreenTargetOptions {
  /** The world's direct path needs one — the orbit-line/décor stencil contract (world/orbitLineStencil.ts) draws through it, which is why the canvas carries one too. The map and the chart use none. */
  stencil?: boolean;
  /** Linear for a target something resamples (the lens); nearest, the default, for one copied 1:1. */
  linear?: boolean;
}

export function createScreenTarget(width: number, height: number, samples: number, opts: ScreenTargetOptions = {}): THREE.WebGLRenderTarget {
  const filter = opts.linear ? THREE.LinearFilter : THREE.NearestFilter;
  const target = new THREE.WebGLRenderTarget(Math.max(1, width), Math.max(1, height), {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    colorSpace: THREE.SRGBColorSpace,
    minFilter: filter,
    magFilter: filter,
    generateMipmaps: false,
    depthBuffer: true,
    stencilBuffer: opts.stencil === true,
    samples,
    // Nothing reads the depth after the frame, so the resolve blit carries
    // colour only (the scene target does the same, main.ts buildComposer).
    resolveDepthBuffer: false,
  });
  target.texture.internalFormat = 'RGBA8';
  (target as unknown as { isXRRenderTarget: boolean }).isXRRenderTarget = true;
  return target;
}

/** Bytes a screen target holds per device pixel: the multisampled colour and depth planes, the resolve texture, and the single-sample depth three attaches to the resolve framebuffer. */
export function screenTargetBytesPerPixel(samples: number): number {
  return samples * 4 + samples * 4 + 4 + 4;
}

/** Resize a screen target to `width × height` device pixels; a no-op when it already is. */
export function fitScreenTarget(target: THREE.WebGLRenderTarget, width: number, height: number): void {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (target.width !== w || target.height !== h) target.setSize(w, h);
}

const COPY_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}`;

// `uUvScale` is the sub-rectangle read (app/sceneSubRect.ts's idiom): a target
// drawn into at its origin but allocated larger has its image in the
// bottom-left `uUvScale` of the texture. The copy is 1:1 and nearest-filtered
// onto a viewport the drawn size, so each fragment's scaled `vUv` lands on its
// own texel's centre and no tap reaches the region past the drawn edge; at
// (1, 1) the multiply is exact and the full-target copy is the bytes it was.
const COPY_FRAGMENT = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 uUvScale;
varying vec2 vUv;
void main() {
  gl_FragColor = texture2D( tDiffuse, vUv * uUvScale );
}`;

/** Copies a screen target's bytes onto whatever is bound — the canvas, inside the current viewport and scissor. */
export class ScreenCopy {
  private readonly material: THREE.ShaderMaterial;
  private readonly quad: FullScreenQuad;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uUvScale: { value: new THREE.Vector2(1, 1) } },
      vertexShader: COPY_VERTEX,
      fragmentShader: COPY_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  /**
   * Draw `target` onto the canvas. `premultiplied` composites a transparent
   * image over what is there. `drawWidth × drawHeight`, in the target's
   * device pixels, is the sub-rectangle at the target's origin that was drawn
   * into when the target is allocated larger than what it holds; left out,
   * the whole target is the image.
   */
  copy(
    renderer: THREE.WebGLRenderer,
    target: THREE.WebGLRenderTarget,
    premultiplied = false,
    drawWidth: number = target.width,
    drawHeight: number = target.height,
  ): void {
    const m = this.material;
    m.uniforms.tDiffuse.value = target.texture;
    m.uniforms.uUvScale.value.set(
      Math.min(1, Math.max(drawWidth, 1) / Math.max(target.width, 1)),
      Math.min(1, Math.max(drawHeight, 1) / Math.max(target.height, 1)),
    );
    if (premultiplied) {
      m.blending = THREE.CustomBlending;
      m.blendSrc = THREE.OneFactor;
      m.blendDst = THREE.OneMinusSrcAlphaFactor;
      m.blendSrcAlpha = THREE.OneFactor;
      m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
      m.transparent = true;
    } else {
      m.blending = THREE.NoBlending;
      m.transparent = false;
    }
    renderer.setRenderTarget(null);
    this.quad.render(renderer);
    m.uniforms.tDiffuse.value = null;
  }

  dispose(): void {
    this.quad.dispose();
    this.material.dispose();
  }
}
