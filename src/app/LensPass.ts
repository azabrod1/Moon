/**
 * The lens-correction post pass (see lensProjection.ts for the math and the
 * why). Sits between bloom and the OutputPass in the planetarium composer;
 * per-frame uniform sync happens in main's render loop from the camera's
 * `userData.lens`, so dev FOV poses and resizes never leave the pass stale.
 */
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { lensPassFragmentShader, lensRadial } from '../shared/math/lensProjection';

const DEG = Math.PI / 180;

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

/** Sync the pass to the camera's current lens params + render FOV/aspect. */
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
  pass.enabled = strength > 0;
}
