/**
 * The lens correction's uniforms, and the pass that carries them on its own.
 *
 * See lensProjection.ts for the math and the why. The warp itself is four
 * uniforms and one GLSL function, and there are two ways the frame gets it:
 *
 *  - The fused chain (what ships): no pass of its own. The bloom bright pass
 *    and the finishing pass read the scene image through the warp, sharing ONE
 *    set of uniform objects (`LensUniforms`), so `syncLensUniforms` writes the
 *    four values once a frame and both programs see them.
 *  - A `LensPass` of its own: the no-float fallback, which tone-maps first and
 *    runs this as its final LDR resample, and the `?fused=0` composer chain.
 *    `updateLensPass` syncs it and owns its `enabled` flag.
 *
 * Either way the sync happens every frame in main's render loop from the
 * camera's `userData.lens`, so dev FOV poses and resizes never leave the warp
 * stale.
 */
import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { lensPassFragmentShader, lensRadial } from '../shared/math/lensProjection';
import type { SubRectUniforms } from './sceneSubRect';

import { DEG2RAD as DEG } from '../shared/math/angles';

/** Per-camera lens parameters, carried on `camera.userData.lens`. */
export interface LensParams {
  /** Requested blend strength, 0 (rectilinear) to 1 (stereographic). */
  strength: number;
  /** The FOV the frame DISPLAYS vertically; camera.fov holds the overscan. */
  designFovDeg: number;
  /** What the current design FOV can honour (applyDesignFov maintains it):
   *  very wide design FOVs force the strength down — a pinhole source can't
   *  feed a full stereographic frame past ~80° corners. */
  effectiveStrength?: number;
  /** The proximity ramp's factor on `strength` (shared/math/lensProximity.ts),
   *  written by the planetarium each frame from the largest disc in view;
   *  absent or 1 leaves the requested strength alone. `effectiveStrength`
   *  carries the product, so every reader of it follows the ramp without
   *  knowing it exists. */
  proximityFactor?: number;
}

/** The pass's own sub-rect uniforms, for the one writer of them. */
export function lensSubRectUniforms(pass: ShaderPass): SubRectUniforms {
  return { uUvScale: pass.uniforms.uUvScale, uUvMax: pass.uniforms.uUvMax };
}

/**
 * The four uniforms the warp reads, as the uniform OBJECTS themselves.
 *
 * On the fused chain one set is shared by both materials that sample the scene
 * image: three reads `.value` at upload, so a single write reaches both
 * programs in the same frame — the two must never warp differently, and two
 * copies of the same four numbers is a way for them to.
 */
export interface LensUniforms {
  uStrength: THREE.IUniform;
  uAspect: THREE.IUniform;
  uTanHalfRender: THREE.IUniform;
  uREdge: THREE.IUniform;
}

/** A fresh set, at the identity: strength 0 is the plain read, so a chain that
 *  has not been synced yet draws the frame rather than nothing. */
export function makeLensUniforms(): LensUniforms {
  return {
    uStrength: { value: 0 },
    uAspect: { value: 1 },
    uTanHalfRender: { value: 1 },
    uREdge: { value: 1 },
  };
}

/** Put a shared set into one material's uniform map. Assigned rather than
 *  defaulted: the point is that both materials hold the same four objects. */
export function installLensUniforms(
  uniforms: Record<string, THREE.IUniform>,
  lens: LensUniforms,
): void {
  uniforms.uStrength = lens.uStrength;
  uniforms.uAspect = lens.uAspect;
  uniforms.uTanHalfRender = lens.uTanHalfRender;
  uniforms.uREdge = lens.uREdge;
}

export function createLensPass(): ShaderPass {
  return new ShaderPass({
    name: 'LensPass',
    uniforms: {
      tDiffuse: { value: null },
      uStrength: { value: 0 },
      uAspect: { value: 1 },
      uTanHalfRender: { value: 1 },
      uREdge: { value: 1 },
      // The source's sub-rectangle (app/sceneSubRect.ts). 1 until something
      // says otherwise, which is what the direct no-float path leaves them at.
      uUvScale: { value: new THREE.Vector2(1, 1) },
      uUvMax: { value: new THREE.Vector2(1, 1) },
    },
    vertexShader: /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`,
    fragmentShader: lensPassFragmentShader,
  });
}

/**
 * DEV only: the lens pass held off, for the perf sweep's "Lens off" row.
 *
 * `updateLensPass` decides `pass.enabled` from the strength on EVERY frame, so
 * a flag written on the pass from outside is overwritten a frame later and a
 * row that set it once measured one frame of the switch and the rest of the
 * hold with the lens back on. This is the one place that decision can be
 * overridden and stay overridden. A production build folds it to nothing.
 */
let devLensOff = false;
export function devSetLensPassOff(off: boolean): void {
  devLensOff = off;
}

/**
 * Write the warp's four uniforms from the camera's current lens params +
 * render FOV/aspect. The fused chain's only per-frame lens work.
 *
 * Under the DEV hold the strength goes to zero rather than a pass being
 * skipped: on the fused chain there is no pass to skip, and the shader's own
 * branch turns a zero strength into the plain scaled read. `uREdge` keeps the
 * real strength's edge radius — with the warp branch not taken it has no
 * reader, and leaving it alone keeps the pass path's writes what they were.
 */
export function syncLensUniforms(
  u: LensUniforms,
  lens: LensParams,
  renderFovDeg: number,
  aspect: number,
): void {
  const strength = lens.effectiveStrength ?? lens.strength;
  u.uStrength.value = import.meta.env.DEV && devLensOff ? 0 : strength;
  u.uAspect.value = aspect;
  u.uTanHalfRender.value = Math.tan((renderFovDeg / 2) * DEG);
  u.uREdge.value = lensRadial((lens.designFovDeg / 2) * DEG, strength);
}

/** Sync a lens pass of its own to the camera, uniforms and flag.
 *  Called every frame on both render paths, whatever the pass's flag says:
 *  this is the only writer of `pass.enabled`, so a frame that skipped it
 *  because the pass was off could never turn the pass back on. */
export function updateLensPass(
  pass: ShaderPass,
  lens: LensParams,
  renderFovDeg: number,
  aspect: number,
): void {
  syncLensUniforms(pass.uniforms as unknown as LensUniforms, lens, renderFovDeg, aspect);
  const strength = lens.effectiveStrength ?? lens.strength;
  pass.enabled = strength > 0 && !(import.meta.env.DEV && devLensOff);
}
