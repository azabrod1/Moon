/**
 * Probes what the GPU will actually do, by doing it. Two gates live here:
 * float framebuffers for the bloom composer, and layered rendering into a 3D
 * float texture for the precomputed atmosphere tables. They are separate
 * probes because passing one proves nothing about the other.
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
 * Probes whether the GPU can render into one layer of a 3D half-float texture
 * and read the result back — the atmosphere tables' whole storage model.
 *
 * `canGPUDoBloom` cannot answer this: it proves a 2D float FBO and says nothing
 * about `framebufferTextureLayer` on a TEXTURE_3D, about MAX_3D_TEXTURE_SIZE,
 * or about half-float filtering. And three checks no framebuffer status on the
 * render-target path, so a device that fails the layer attach produces black
 * tables in silence.
 *
 * So the probe renders a known value into layer 1 of a 4×4×2 target, checks the
 * framebuffer itself, then samples that layer through a filtered fetch into an
 * 8-bit target and reads the byte. Fail-closed: anything that throws, any
 * incomplete framebuffer, any wrong byte, and the tier stays off — the analytic
 * atmosphere shell is a complete look without it. `?nofloat=1` forces false, so
 * the QA path can reproduce a device that has no tables.
 */
export function canGPUDoAtmosphereLut(renderer: THREE.WebGLRenderer): boolean {
  if (noFloatForced()) { debugLog('Atmosphere LUT probe: forced off by ?nofloat=1'); return false; }
  let target3d: THREE.WebGL3DRenderTarget | null = null;
  let readTarget: THREE.WebGLRenderTarget | null = null;
  let fillMaterial: THREE.ShaderMaterial | null = null;
  let readMaterial: THREE.ShaderMaterial | null = null;
  let geometry: THREE.PlaneGeometry | null = null;
  const previousTarget = renderer.getRenderTarget();
  try {
    const gl = renderer.getContext();
    if (!(gl instanceof WebGL2RenderingContext)) { debugLog('Atmosphere LUT probe: not WebGL2'); return false; }
    if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) {
      debugLog('Atmosphere LUT probe: no float colour buffer');
      return false;
    }
    if (gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) < 256) {
      debugLog('Atmosphere LUT probe: MAX_3D_TEXTURE_SIZE too small');
      return false;
    }

    target3d = new THREE.WebGL3DRenderTarget(4, 4, 2, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      samples: 0,
    });
    readTarget = new THREE.WebGLRenderTarget(4, 4, { depthBuffer: false, stencilBuffer: false, samples: 0 });
    geometry = new THREE.PlaneGeometry(2, 2);
    fillMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      precision: 'highp',
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: 'precision highp float;\nout vec4 fragColor;\nvoid main() { fragColor = vec4(0.5, 0.25, 0.75, 1.0); }',
    });
    readMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      precision: 'highp',
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      uniforms: { uTable: { value: target3d.texture } },
      vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: [
        'precision highp float;',
        'precision highp sampler3D;',
        'uniform sampler3D uTable;',
        'out vec4 fragColor;',
        // Layer 1 of two: its texel centres sit at w = 0.75.
        'void main() { fragColor = texture(uTable, vec3(0.5, 0.5, 0.75)); }',
      ].join('\n'),
    });

    const scene = new THREE.Scene();
    const camera = new THREE.Camera();
    const quad = new THREE.Mesh(geometry, fillMaterial);
    quad.frustumCulled = false;
    scene.add(quad);

    const previousAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    try {
      renderer.setRenderTarget(target3d, 1);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        debugLog('Atmosphere LUT probe: 3D framebuffer incomplete', { status });
        return false;
      }
      renderer.render(scene, camera);
      quad.material = readMaterial;
      renderer.setRenderTarget(readTarget);
      renderer.render(scene, camera);
    } finally {
      renderer.autoClear = previousAutoClear;
    }

    const pixels = new Uint8Array(4 * 16);
    renderer.readRenderTargetPixels(readTarget, 0, 0, 4, 4, pixels);
    // 0.5, 0.25, 0.75 written, filtered, and read back as bytes.
    const ok = Math.abs(pixels[0] - 128) <= 3
      && Math.abs(pixels[1] - 64) <= 3
      && Math.abs(pixels[2] - 191) <= 3
      && !gl.isContextLost();
    debugLog('Atmosphere LUT probe', { ok, sample: [pixels[0], pixels[1], pixels[2]] });
    return ok;
  } catch (err) {
    debugWarn('Atmosphere LUT probe failed', err);
    return false;
  } finally {
    renderer.setRenderTarget(previousTarget);
    target3d?.dispose();
    readTarget?.dispose();
    fillMaterial?.dispose();
    readMaterial?.dispose();
    geometry?.dispose();
  }
}

/** `?nofloat=1` forces the no-composer QA path; the LUT tier goes with it, so
 *  the analytic-only look can be reproduced on capable hardware. */
function noFloatForced(): boolean {
  try {
    return typeof location !== 'undefined' && new URLSearchParams(location.search).has('nofloat');
  } catch {
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
