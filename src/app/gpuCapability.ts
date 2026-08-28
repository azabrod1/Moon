/**
 * Probes what the GPU will actually do, by doing it. Two gates live here:
 * float framebuffers for the bloom composer, and layered rendering into a 3D
 * float texture for the precomputed atmosphere tables. They are separate
 * probes because passing one proves nothing about the other.
 */
import * as THREE from 'three';
import { debugLog, debugWarn } from '../shared/debug';

export function canGPUDoBloom(renderer: THREE.WebGLRenderer): boolean {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float');
    if (!ext) { debugLog('Bloom test: no float buffer extension'); return false; }
    // Actually create a small float framebuffer and check completeness
    const framebuffer = gl.createFramebuffer();
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, (gl as WebGL2RenderingContext).RGBA16F ?? gl.RGBA,
      4, 4, 0, gl.RGBA, (gl as WebGL2RenderingContext).HALF_FLOAT ?? gl.FLOAT, null);
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
