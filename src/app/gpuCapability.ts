/**
 * Probes whether the GPU can render to a float framebuffer (required for the
 * UnrealBloom pass): creates a tiny float FBO and checks completeness.
 */
import * as THREE from 'three';
import { debugLog, debugWarn } from '../shared/debug';
import { drainErrors } from '../shared/three/glErrors';

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
 * count the driver lists is built in the layout the composer's multisampled
 * side uses (RGBA16F colour + DEPTH24_STENCIL8, both multisampled
 * renderbuffers) and kept only if it completes AND resolves: a clear and a
 * blit into a single-sample RGBA16F buffer, the operation three performs
 * after every render, with no GL error. (Three resolves into a texture, on
 * a framebuffer that also carries a single-sample depth renderbuffer; the
 * probe's bare renderbuffer proves the same blit.) Empty means no
 * multisampling, and main.ts then keeps the old supersample floor for the
 * scene, so the display renders as it always did. A GPU exposing
 * WEBGL_multisampled_render_to_texture (Chrome does on some Adreno/Mali
 * tablets) would take three's other allocation path, a multisampled texture
 * this probe does not build, so it reports empty and gets that floor. A 4×4
 * probe cannot foresee a full-size allocation failing for memory: that is
 * what keeps the sample count off dense displays and, above 4K, at two.
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

function completesMultisampled(
  renderer: THREE.WebGLRenderer,
  gl: WebGL2RenderingContext,
  samples: number,
): boolean {
  const fbo = gl.createFramebuffer();
  const colour = gl.createRenderbuffer();
  const depth = gl.createRenderbuffer();
  const resolveFbo = gl.createFramebuffer();
  const resolved = gl.createRenderbuffer();
  // What the probe borrows, to hand back as found: the bound framebuffers
  // (three's own, if a target is bound) and the clear colour.
  const prevDraw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  const prevRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  const prevClear = gl.getParameter(gl.COLOR_CLEAR_VALUE) as Float32Array;
  try {
    gl.bindRenderbuffer(gl.RENDERBUFFER, colour);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA16F, 4, 4);
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH24_STENCIL8, 4, 4);
    gl.bindRenderbuffer(gl.RENDERBUFFER, resolved);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA16F, 4, 4);
    // Through three's state cache, so its record of the bound framebuffers
    // stays true whatever ran before this probe.
    renderer.state.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, colour);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, depth);
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    // A refused storage call raises a GL error but no exception: a miss.
    // (The finally block drains whatever else it raised.)
    const clean = gl.getError() === gl.NO_ERROR;
    if (!complete || !clean) return false;
    // The resolve three performs after every render: write the samples,
    // then blit them into a single-sample buffer of the same format. The
    // clear colour goes through three's cache so its record stays true.
    renderer.state.buffers.color.setClear(0.25, 0.5, 0.75, 1, false);
    gl.clear(gl.COLOR_BUFFER_BIT);
    renderer.state.bindFramebuffer(gl.DRAW_FRAMEBUFFER, resolveFbo);
    gl.framebufferRenderbuffer(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, resolved);
    renderer.state.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo);
    const resolvable = gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.blitFramebuffer(0, 0, 4, 4, 0, 0, 4, 4, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    const resolvedClean = gl.getError() === gl.NO_ERROR;
    return resolvable && resolvedClean;
  } finally {
    // Everything back as found, through three's cache so its record matches
    // GL: the binding points (three's own target, if one was bound, else
    // null), the clear colour, and an empty error queue for whoever is next.
    // READ and DRAW separately, never a third FRAMEBUFFER bind over them: that
    // would point READ at the draw target and lose a READ != DRAW state.
    renderer.state.bindFramebuffer(gl.READ_FRAMEBUFFER, prevRead);
    renderer.state.bindFramebuffer(gl.DRAW_FRAMEBUFFER, prevDraw);
    renderer.state.buffers.color.setClear(prevClear[0], prevClear[1], prevClear[2], prevClear[3], false);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    gl.deleteRenderbuffer(colour);
    gl.deleteRenderbuffer(depth);
    gl.deleteRenderbuffer(resolved);
    gl.deleteFramebuffer(fbo);
    gl.deleteFramebuffer(resolveFbo);
    drainErrors(gl);
  }
}
