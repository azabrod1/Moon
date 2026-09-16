/**
 * The upscaler: the last three passes of the planetarium's composer when the
 * scene is drawn at a lower pixel ratio than the canvas (the policy is
 * renderPixelRatio in app/renderResolution.ts; the shaders are app/fsr1.ts).
 *
 *   … Bloom
 *   OutputTargetPass   tone map + display encode. To the canvas when it is the
 *                      last enabled pass — three's OutputPass, byte for byte —
 *                      else into its own 8-bit target at scene size.
 *   UpscalePass        EASU: that target → the canvas at output size, or → its
 *                      own 8-bit target at output size when the sharpen follows.
 *   SharpenPass        RCAS on that target → the canvas.
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
 * The materials are RawShaderMaterials on purpose: three re-keys a
 * ShaderMaterial's program on the destination's colour space and tone
 * mapping, so a pass that draws the canvas one frame and a target the next
 * would relink; a raw material's key ignores both.
 *
 * The control arm — the same lower ratio with no upscale, the finishing pass
 * drawing the smaller buffer straight to the canvas through the composer
 * target's own linear filter — needs nothing here: both upscale passes
 * disabled with the composer at the lower ratio.
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

  constructor() {
    super();
    this.needsSwap = false;
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
    const target = (this.target ??= createLdrTarget());
    fitTarget(target, readBuffer.width, readBuffer.height);
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
    const u = this.material.uniforms;
    u.tInput.value = input.texture;
    (u.uCon0.value as THREE.Vector4).fromArray(easuConstants(input.width, input.height, outW, outH));
    (u.uInputMax.value as THREE.Vector2).set(input.width - 1, input.height - 1);
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
