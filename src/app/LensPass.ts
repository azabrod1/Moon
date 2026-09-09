/**
 * The lens-correction post pass (see lensProjection.ts for the math and the
 * why). Runs before output-space bloom on HDR-capable devices; the no-float
 * fallback tone-maps first and runs this as its final LDR resample.
 * per-frame uniform sync happens in main's render loop from the camera's
 * `userData.lens`, so dev FOV poses and resizes never leave the pass stale.
 */
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { lensPassFragmentShader, lensRadial } from '../shared/math/lensProjection';

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

/** Sync the pass to the camera's current lens params + render FOV/aspect.
 *  Called every frame on both render paths, whatever the pass's flag says:
 *  this is the only writer of `pass.enabled`, so a frame that skipped it
 *  because the pass was off could never turn the pass back on. */
export function updateLensPass(
  pass: ShaderPass,
  lens: LensParams,
  renderFovDeg: number,
  aspect: number,
): void {
  const strength = lens.effectiveStrength ?? lens.strength;
  pass.uniforms.uStrength.value = strength;
  pass.uniforms.uAspect.value = aspect;
  pass.uniforms.uTanHalfRender.value = Math.tan((renderFovDeg / 2) * DEG);
  pass.uniforms.uREdge.value = lensRadial((lens.designFovDeg / 2) * DEG, strength);
  pass.enabled = strength > 0 && !(import.meta.env.DEV && devLensOff);
}
