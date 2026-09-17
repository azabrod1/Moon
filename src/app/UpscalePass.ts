/**
 * The resample: the last passes of the planetarium's composer whenever the
 * scene is drawn at a pixel ratio other than the canvas's (the policy is
 * renderPixelRatio in app/renderResolution.ts; the FSR shaders are
 * app/fsr1.ts).
 *
 *   … Bloom
 *   OutputTargetPass   tone map + display encode. To the canvas when it is the
 *                      last enabled pass — three's OutputPass, byte for byte —
 *                      else into its own 8-bit target at scene size.
 *   UpscalePass        EASU: that target → the canvas at output size, or → its
 *                      own 8-bit target at output size when the sharpen follows.
 *   SharpenPass        RCAS on that target → the canvas.
 *   DownsamplePass     the other direction: a scene drawn LARGER than the
 *                      canvas, area-averaged down onto it. Never enabled
 *                      together with the two above.
 *
 * Why the finishing pass owns a target instead of writing the composer's
 * writeBuffer: after the lens pass swapped, the writeBuffer is the scene
 * target itself — half-float, with a depth/stencil plane DepthDiscardPass has
 * just invalidated and OutputPass's material would depth-test against, and
 * multisampled on a desktop, so a quad drawn into it is resolved again. An
 * 8-bit target is what FSR asks for (32 bpp, display-encoded) and exactly the
 * bytes the canvas would have held. Its storage is named RGBA8 by hand for the
 * same reason screenTarget.ts names it: an sRGB storage would be decoded on
 * every fetch, and the filter would run on linear light.
 *
 * None of the three swaps the composer's buffers (needsSwap false), so the
 * parity guard in main's renderScene is untouched. The composer decides which
 * pass draws the canvas: three sets `renderToScreen` on the last ENABLED pass
 * every render, so disabling the two upscale passes hands the canvas back to
 * the finishing pass with no rebuild — that is how the switch flips live — and
 * a chain with them disabled is the chain that shipped before them.
 *
 * Sizes are read at render time: the composer hands every pass the SCENE size
 * through setSize, and the output size is the renderer's drawing buffer. The
 * targets are made on the first render that needs them, so a build with the
 * upscaler off allocates nothing, and fitted on every render (a no-op when
 * unchanged).
 *
 * Under a fixed allocation (app/sceneSubRect.ts) the scene-sized buffers are
 * larger than the frame and the frame sits in a sub-rectangle at their origin.
 * EASU and the box therefore take their input size from the input target's
 * VIEWPORT rather than its width, the finishing pass carries the same
 * rectangle into its own target, and its read of the scene buffer is scaled
 * and clamped by the uniforms the patch installs. RCAS is the exception: it
 * reads EASU's own output-sized target, which is always full.
 *
 * The materials are RawShaderMaterials on purpose: three re-keys a
 * ShaderMaterial's program on the destination's colour space and tone
 * mapping, so a pass that draws the canvas one frame and a target the next
 * would relink; a raw material's key ignores both.
 *
 * The control arm — the same lower ratio with no upscale, the finishing pass
 * drawing the smaller buffer straight to the canvas through the composer
 * target's own linear filter — needs nothing here: both upscale passes
 * disabled with the composer at the lower ratio.
 *
 * **The downsample averages display-encoded sRGB, on purpose.** It is the last
 * thing that happens to the frame, after the tone map and after bloom, and the
 * look it is there to reproduce is the compositor's own box shrink of a `?ratio=3`
 * frame — the picture the owner judged as the sharper one. Resolving in linear
 * light instead would move the average of every high-contrast edge: a lone
 * bright star on black would come out dimmer in display encoding and, sampled
 * before bloom, could fall under the bloom threshold and lose its glow
 * altogether. The averaging is therefore deliberately not physically "correct";
 * it is the same arithmetic the display server does with the same bytes.
 *
 * **The box, and why nine taps.** The default filter is the area box: each
 * output pixel is the average of the source texels its own footprint covers,
 * weighted by how much of each texel that footprint holds, normalised by the
 * weights' sum. At the largest supersample the policy offers (1.5) a footprint
 * is 1.5 texels wide and covers two or three of them per axis, so the taps are
 * the three around `floor(centre)` — floored rather than rounded because a
 * rounded base can sit one texel off a footprint that straddles three, leaving
 * up to a sixth of the weight unsampled at some phases, while the floor is
 * provably inside the footprint's span for every ratio under 2. Taps outside
 * the footprint weigh exactly zero and taps outside the image are clamped for
 * the fetch but weighted by their true (empty) overlap, so an edge pixel is
 * the average of the texels that really are there rather than one of them
 * counted twice.
 */
import * as THREE from 'three';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import {
  EASU_FRAGMENT_SHADER,
  FSR1_VERTEX_SHADER,
  RCAS_DEFAULT_STOPS,
  RCAS_FRAGMENT_SHADER,
  easuConstants,
  rcasSharpness,
} from './fsr1';
import { OUTPUT_UV_ANCHOR, patchUvScale, type SubRectUniforms } from './sceneSubRect';

/** An 8-bit colour-only target with raw storage and a linear filter. */
export function createLdrTarget(): THREE.WebGLRenderTarget {
  const target = new THREE.WebGLRenderTarget(1, 1, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    colorSpace: THREE.NoColorSpace,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
    depthBuffer: false,
    stencilBuffer: false,
  });
  target.texture.internalFormat = 'RGBA8';
  return target;
}

/** Resize a target to `width × height`; a no-op when it already is. */
function fitTarget(target: THREE.WebGLRenderTarget, width: number, height: number): void {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  if (target.width !== w || target.height !== h) target.setSize(w, h);
}

/**
 * The part of a target a frame was really drawn into: its viewport, which
 * three keeps at the whole target unless something narrowed it. Under a fixed
 * allocation (app/sceneSubRect.ts) that is the rung's own sub-rectangle at the
 * origin, and it is what the resample must derive its taps from — the target's
 * width would step outside the image into the region the rung above drew.
 */
function drawnSize(target: THREE.WebGLRenderTarget): { width: number; height: number } {
  return {
    width: Math.min(target.width, Math.max(1, Math.round(target.viewport.z))),
    height: Math.min(target.height, Math.max(1, Math.round(target.viewport.w))),
  };
}

function rawMaterial(fragmentShader: string, uniforms: Record<string, THREE.IUniform>): THREE.RawShaderMaterial {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms,
    vertexShader: FSR1_VERTEX_SHADER,
    fragmentShader,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
  });
}

/**
 * three's OutputPass that, when something follows it, writes into its own
 * 8-bit target at the scene size rather than the composer's writeBuffer.
 */
export class OutputTargetPass extends OutputPass {
  /** The tone-mapped, display-encoded frame at scene size; null until a
   *  render has needed it, null again after dispose. */
  target: THREE.WebGLRenderTarget | null = null;

  /** Where its read of the scene-sized buffer lands (app/sceneSubRect.ts).
   *  Not readonly: the fused variant writes its own shader text over this
   *  one's and patches it again. */
  subRect: SubRectUniforms;

  constructor() {
    super();
    this.needsSwap = false;
    this.subRect = patchUvScale(this.material, OUTPUT_UV_ANCHOR);
  }

  /**
   * The LDR target at this size. `create` is false for a caller that only
   * wants to fix up a target that already exists — a fixed allocation makes it
   * eagerly so its rectangle can be set before any frame needs it, and every
   * other path leaves it lazy, so a build that never resamples allocates
   * nothing.
   */
  ensureTarget(width: number, height: number, create: boolean): THREE.WebGLRenderTarget | null {
    if (!this.target && !create) return null;
    const target = (this.target ??= createLdrTarget());
    fitTarget(target, width, height);
    return target;
  }

  render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
    deltaTime = 0,
    maskActive = false,
  ): void {
    if (this.renderToScreen) {
      super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
      return;
    }
    // At the read buffer's own size, sub-rectangle and all: the frame lands in
    // the same corner of this target as it did in the one it came from, which
    // is what lets the resample read it with the same rectangle.
    const target = this.ensureTarget(readBuffer.width, readBuffer.height, true)!;
    super.render(renderer, target, readBuffer, deltaTime, maskActive);
  }

  dispose(): void {
    super.dispose();
    this.target?.dispose();
    this.target = null;
  }
}

/** EASU: the finishing pass's target, resampled to the output size. */
export class UpscalePass extends Pass {
  /** EASU's result at output size; made only while the sharpen pass follows. */
  target: THREE.WebGLRenderTarget | null = null;
  private readonly material: THREE.RawShaderMaterial;
  private readonly quad: FullScreenQuad;
  private readonly bufferSize = new THREE.Vector2();

  constructor(private readonly source: OutputTargetPass) {
    super();
    this.needsSwap = false;
    this.material = rawMaterial(EASU_FRAGMENT_SHADER, {
      tInput: { value: null },
      uCon0: { value: new THREE.Vector4() },
      uInputMax: { value: new THREE.Vector2() },
    });
    this.quad = new FullScreenQuad(this.material);
  }

  /** The image this pass resamples, once the finishing pass has drawn it. */
  get input(): THREE.WebGLRenderTarget | null {
    return this.source.target;
  }

  render(renderer: THREE.WebGLRenderer): void {
    const input = this.source.target;
    // The finishing pass drew the canvas itself (nothing enabled after it):
    // there is no image to resample.
    if (!input) return;
    renderer.getDrawingBufferSize(this.bufferSize);
    const outW = Math.max(1, Math.floor(this.bufferSize.x));
    const outH = Math.max(1, Math.floor(this.bufferSize.y));
    const drawn = drawnSize(input);
    const u = this.material.uniforms;
    u.tInput.value = input.texture;
    (u.uCon0.value as THREE.Vector4).fromArray(easuConstants(drawn.width, drawn.height, outW, outH));
    (u.uInputMax.value as THREE.Vector2).set(drawn.width - 1, drawn.height - 1);
    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
    } else {
      const target = (this.target ??= createLdrTarget());
      fitTarget(target, outW, outH);
      renderer.setRenderTarget(target);
    }
    this.quad.render(renderer);
    u.tInput.value = null;
  }

  dispose(): void {
    this.material.dispose();
    this.quad.dispose();
    this.target?.dispose();
    this.target = null;
  }
}

/** Which kernel the downsample uses. The box is the compositor's look; the
 *  tent is the A/B behind a DEV knob, and it is softer (its radius reaches a
 *  whole footprint past the footprint's own edge). */
export type DownsampleFilter = 'box' | 'tent';

/** The three taps of one axis and the weights they carry, normalised to sum
 *  to 1 — the arithmetic the shader below does per axis, as a function a test
 *  can drive. `outIndex` is the output pixel's integer coordinate on that
 *  axis; `base` is the middle tap's texel index, which may be −1 or the
 *  size at the borders (the fetch is clamped, the weight is not). */
export function downsampleAxisWeights(
  inSize: number,
  outSize: number,
  outIndex: number,
  filter: DownsampleFilter = 'box',
): { base: number; weights: [number, number, number] } {
  const f = inSize / outSize;
  const from = outIndex * f;
  const to = from + f;
  const centre = 0.5 * (from + to);
  const base = Math.floor(centre);
  const raw: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const i = base + k - 1;
    raw[k] = filter === 'tent'
      ? Math.max(0, 1 - Math.abs(i + 0.5 - centre) / f)
      : Math.max(0, Math.min(to, i + 1) - Math.max(from, i));
  }
  const sum = raw[0] + raw[1] + raw[2];
  const norm = sum > 0 ? sum : 1;
  return { base, weights: [raw[0] / norm, raw[1] / norm, raw[2] / norm] };
}

/**
 * The downsample, as GLSL ES 3.00. `uFilter` picks the kernel (0 box, 1 tent)
 * so the A/B is a uniform rather than a relink. Separable: the weights are
 * computed per axis and multiplied, which is exactly the area of the 2D
 * overlap for the box and a product tent for the tent, and normalising each
 * axis makes the nine weights sum to 1 without a second pass over them.
 */
const DOWNSAMPLE_FRAGMENT_SHADER = /* glsl */ `
precision highp float;
uniform sampler2D tInput;
uniform vec2 uInputSize;
uniform vec2 uOutputSize;
uniform float uFilter;
out vec4 fragColor;

// The three taps' weights around the middle tap, normalised. 'p' is the
// output pixel's coordinate on this axis and 'f' the footprint's width in
// source texels; 'base' comes back as the middle tap's texel index.
vec3 axisWeights(float p, float f, out float base) {
  float from = p * f;
  float to = from + f;
  float centre = 0.5 * (from + to);
  base = floor(centre);
  float i0 = base - 1.0;
  float i1 = base;
  float i2 = base + 1.0;
  vec3 w;
  if (uFilter > 0.5) {
    // Tent of radius f about the footprint's centre, over texel centres.
    w = vec3(
      max(0.0, 1.0 - abs(i0 + 0.5 - centre) / f),
      max(0.0, 1.0 - abs(i1 + 0.5 - centre) / f),
      max(0.0, 1.0 - abs(i2 + 0.5 - centre) / f)
    );
  } else {
    // Area box: how much of each texel [i, i+1] the footprint covers.
    w = vec3(
      max(0.0, min(to, i0 + 1.0) - max(from, i0)),
      max(0.0, min(to, i1 + 1.0) - max(from, i1)),
      max(0.0, min(to, i2 + 1.0) - max(from, i2))
    );
  }
  float sum = w.x + w.y + w.z;
  return w / max(sum, 1e-6);
}

void main() {
  vec2 f = uInputSize / uOutputSize;
  float bx;
  float by;
  vec3 wx = axisWeights(floor(gl_FragCoord.x), f.x, bx);
  vec3 wy = axisWeights(floor(gl_FragCoord.y), f.y, by);
  ivec2 base = ivec2(int(bx), int(by));
  ivec2 last = ivec2(uInputSize) - ivec2(1);
  vec3 sum = vec3(0.0);
  for (int j = 0; j < 3; j++) {
    float wj = j == 0 ? wy.x : (j == 1 ? wy.y : wy.z);
    if (wj <= 0.0) continue;
    for (int i = 0; i < 3; i++) {
      float wi = i == 0 ? wx.x : (i == 1 ? wx.y : wx.z);
      if (wi <= 0.0) continue;
      ivec2 at = clamp(base + ivec2(i - 1, j - 1), ivec2(0), last);
      sum += texelFetch(tInput, at, 0).rgb * (wi * wj);
    }
  }
  fragColor = vec4(sum, 1.0);
}
`;

/**
 * The scene drawn larger than the canvas, averaged down onto it.
 *
 * Always the last pass in the chain, so it draws the canvas itself; the image
 * it reads is the finishing pass's own 8-bit target, at scene size.
 */
export class DownsamplePass extends Pass {
  private readonly material: THREE.RawShaderMaterial;
  private readonly quad: FullScreenQuad;
  private readonly bufferSize = new THREE.Vector2();
  private filter: DownsampleFilter = 'box';

  constructor(private readonly source: OutputTargetPass) {
    super();
    this.needsSwap = false;
    this.material = rawMaterial(DOWNSAMPLE_FRAGMENT_SHADER, {
      tInput: { value: null },
      uInputSize: { value: new THREE.Vector2() },
      uOutputSize: { value: new THREE.Vector2() },
      uFilter: { value: 0 },
    });
    this.quad = new FullScreenQuad(this.material);
  }

  /** The image this pass averages, once the finishing pass has drawn it. */
  get input(): THREE.WebGLRenderTarget | null {
    return this.source.target;
  }

  /** Box (the default, the compositor's look) or the tent A/B. */
  setFilter(filter: DownsampleFilter): void {
    this.filter = filter;
    this.material.uniforms.uFilter.value = filter === 'tent' ? 1 : 0;
  }

  get kernel(): DownsampleFilter {
    return this.filter;
  }

  render(renderer: THREE.WebGLRenderer): void {
    const input = this.source.target;
    // The finishing pass drew the canvas itself: there is nothing to average.
    if (!input) return;
    renderer.getDrawingBufferSize(this.bufferSize);
    const drawn = drawnSize(input);
    const u = this.material.uniforms;
    u.tInput.value = input.texture;
    // Both the footprint's width and the clamp on its taps come off this one
    // uniform, so the sub-rectangle's size fixes the pair at once.
    (u.uInputSize.value as THREE.Vector2).set(drawn.width, drawn.height);
    (u.uOutputSize.value as THREE.Vector2).set(
      Math.max(1, Math.floor(this.bufferSize.x)),
      Math.max(1, Math.floor(this.bufferSize.y)),
    );
    // Always the last pass: the canvas.
    renderer.setRenderTarget(null);
    this.quad.render(renderer);
    u.tInput.value = null;
  }

  dispose(): void {
    this.material.dispose();
    this.quad.dispose();
  }
}

/** RCAS: the upscale pass's target, sharpened in place onto the canvas. */
export class SharpenPass extends Pass {
  private readonly material: THREE.RawShaderMaterial;
  private readonly quad: FullScreenQuad;
  private stops = RCAS_DEFAULT_STOPS;

  constructor(private readonly source: UpscalePass) {
    super();
    this.needsSwap = false;
    this.material = rawMaterial(RCAS_FRAGMENT_SHADER, {
      tInput: { value: null },
      uInputMax: { value: new THREE.Vector2() },
      uSharpness: { value: rcasSharpness(RCAS_DEFAULT_STOPS) },
    });
    this.quad = new FullScreenQuad(this.material);
  }

  /** Sharpness in stops below the reference's maximum (0 = sharpest). */
  setSharpness(stops: number): void {
    this.stops = stops;
    this.material.uniforms.uSharpness.value = rcasSharpness(stops);
  }

  get sharpness(): number {
    return this.stops;
  }

  /** The image this pass sharpens, once the upscale pass has drawn it. */
  get input(): THREE.WebGLRenderTarget | null {
    return this.source.target;
  }

  render(renderer: THREE.WebGLRenderer): void {
    const input = this.source.target;
    // The upscale pass drew the canvas itself: nothing to sharpen.
    if (!input) return;
    const u = this.material.uniforms;
    u.tInput.value = input.texture;
    // The upscale pass's own target, at OUTPUT size and filled edge to edge —
    // never a sub-rectangle of a scene-sized allocation, whatever the rung. Its
    // whole width is the image, and a bound taken from the scene's sub-rect
    // would clamp the right and top of the frame to interior texels.
    (u.uInputMax.value as THREE.Vector2).set(input.width - 1, input.height - 1);
    // Always the last pass: the canvas.
    renderer.setRenderTarget(null);
    this.quad.render(renderer);
    u.tInput.value = null;
  }

  dispose(): void {
    this.material.dispose();
    this.quad.dispose();
  }
}
