/**
 * Analytic screen size of a sphere, from camera distance alone.
 *
 * The closed form answers everywhere: a measured/sampled footprint collapses to
 * 0 px the moment the body leaves the frustum, so any gate that must keep a
 * stable answer while the body is steered past the frame edge reads this
 * instead. `fovDeg` is always the DISPLAY fov — the lens pass parks the overscan
 * in `camera.fov`, which is not the angle the viewer sees.
 *
 * Framework-free scalars: no scene, camera or renderer state, so subsystems that
 * have no business importing the render pipeline can size a disc.
 */

import { DEG2RAD } from './angles';

/**
 * On-screen disc DIAMETER (px) of a sphere of rendered radius r at distance
 * `distAU`, using the true-silhouette tangent angle (matches `discRadiusPx` in
 * PlanetLabels, so the dot's handoff and the label offset agree).
 */
export function discDiameterPx(
  renderedRadiusAU: number,
  distAU: number,
  fovDeg: number,
  viewportHpx: number,
): number {
  const r = renderedRadiusAU;
  const halfFovTan = Math.tan((fovDeg * DEG2RAD) / 2);
  const tangentSq = distAU * distAU - r * r;
  const tangent = Math.sqrt(Math.max(tangentSq, r * r * 1e-12));
  return (r / (tangent * halfFovTan)) * viewportHpx;
}
