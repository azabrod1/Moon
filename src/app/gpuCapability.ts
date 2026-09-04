/**
 * Probes whether the GPU can render to a float framebuffer (required for the
 * UnrealBloom pass): creates a tiny float FBO and checks completeness.
 */
import * as THREE from 'three';
import { debugLog, debugWarn } from '../shared/debug';

export function canGPUDoBloom(renderer: THREE.WebGLRenderer): boolean {
  try {
    // three r163+ is WebGL2-only, so the half-float enums are always present.
    const gl = renderer.getContext() as WebGL2RenderingContext;
    const ext = gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float');
    if (!ext) { debugLog('Bloom test: no float buffer extension'); return false; }
    // Actually create a small float framebuffer and check completeness
    const framebuffer = gl.createFramebuffer();
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 4, 4, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteTexture(texture);
    gl.deleteFramebuffer(framebuffer);
    const ok = status === gl.FRAMEBUFFER_COMPLETE;
    debugLog('Bloom test: float FBO', { ok, status });
    return ok;
  } catch (err) {
    debugWarn('Bloom test failed', err);
    return false;
  }
}

/**
 * Sample counts the GPU can attach to the composer's half-float scene target,
 * highest first — the menu `composerSamples` (app/renderResolution.ts) picks
 * from. WebGL2 promises multisampling only for the fixed-point colour
 * formats; a float target's counts are the driver's business, and asking for
 * one it cannot do leaves the framebuffer incomplete (a black frame). Every
 * count the driver lists is built in the exact layout the composer uses
 * (RGBA16F colour + DEPTH24_STENCIL8, both multisampled renderbuffers) and
 * kept only if it completes. Empty means no multisampling. A GPU exposing
 * WEBGL_multisampled_render_to_texture would take three's other allocation
 * path (a multisampled texture, which this probe does not build), so it
 * reports empty. A 4×4 probe cannot foresee a full-size allocation failing
 * for memory: that is what keeps the sample count off dense displays.
 */
export function halfFloatTargetSampleCounts(renderer: THREE.WebGLRenderer): number[] {
  try {
    const gl = renderer.getContext() as WebGL2RenderingContext;
    if (renderer.extensions.has('WEBGL_multisampled_render_to_texture')) {
      debugLog('Half-float target samples: render-to-texture GPU, not probed');
      return [];
    }
    drainErrors(gl);
    const listed = gl.getInternalformatParameter(gl.RENDERBUFFER, gl.RGBA16F, gl.SAMPLES) as Int32Array | null;
    drainErrors(gl);
    const counts = listed ? Array.from(listed).filter((n) => n > 0).sort((a, b) => b - a) : [];
    const supported = counts.filter((samples) => completesMultisampled(renderer, gl, samples));
    debugLog('Half-float target samples', { listed: counts, supported });
    return supported;
  } catch (err) {
    debugWarn('Half-float sample probe failed', err);
    return [];
  }
}

/** Empties the GL error queue so nothing raised earlier is blamed on a probe. */
function drainErrors(gl: WebGL2RenderingContext): void {
  for (let i = 0; i < 8 && gl.getError() !== gl.NO_ERROR; i++) { /* drained */ }
}

function completesMultisampled(
  renderer: THREE.WebGLRenderer,
  gl: WebGL2RenderingContext,
  samples: number,
): boolean {
  const fbo = gl.createFramebuffer();
  const colour = gl.createRenderbuffer();
  const depth = gl.createRenderbuffer();
  try {
    gl.bindRenderbuffer(gl.RENDERBUFFER, colour);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA16F, 4, 4);
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH24_STENCIL8, 4, 4);
    // Through three's state cache, so its record of the bound framebuffer
    // stays true whatever ran before this probe.
    renderer.state.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, colour);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, depth);
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    // A refused storage call raises a GL error but no exception: a miss.
    const clean = gl.getError() === gl.NO_ERROR;
    drainErrors(gl);
    return complete && clean;
  } finally {
    renderer.state.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    gl.deleteRenderbuffer(colour);
    gl.deleteRenderbuffer(depth);
    gl.deleteFramebuffer(fbo);
  }
}
