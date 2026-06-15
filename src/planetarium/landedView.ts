/**
 * Landed orbit-camera framing math (pure, unit-tested).
 *
 * On landing the camera is placed on the body's lit side at a distance of 1.5·d
 * from the body at the scene origin, where d is what landedFrameCamDistAU returns.
 * Framing a body to a fixed fraction of the view therefore means choosing d as a
 * multiple of the body's rendered radius: at ×4 the camera sits ~6 radii out,
 * giving an angular diameter of 2·atan(1/6) ≈ 18.9° — about a third of the
 * 60° vertical field of view, the same for every body regardless of size.
 *
 * Kept out of the controller and unit-tested so the framed size can't silently
 * drift (e.g. a too-large floor quietly pinning the smallest moons far away).
 */

/** Camera-distance multiple of the rendered radius; see the module note for the ⅓-view derivation. */
export const LANDED_FRAME_RADII = 4;

/**
 * Camera offset magnitude `d` for the landing frame (the camera ends up 1.5·d
 * from the body). The near-plane guard only prevents a degenerate zero-distance
 * camera for a missing/zero-radius body; for every real body
 * `renderedRadius × LANDED_FRAME_RADII` dominates, so all bodies frame to ~18.9°.
 */
export function landedFrameCamDistAU(renderedRadiusAU: number, cameraNearAU: number): number {
  return Math.max(renderedRadiusAU * LANDED_FRAME_RADII, cameraNearAU * 1.5);
}

/**
 * Closest the orbit camera may zoom in. The rendered radius keeps it outside an
 * inflated small-moon mesh; the additive near-plane term guarantees the body's
 * surface stays in front of the near plane even for the tiniest moons (whose
 * 1.5× rendered radius alone would otherwise fall inside it).
 */
export function landedMinDistanceAU(renderedRadiusAU: number, cameraNearAU: number): number {
  return Math.max(renderedRadiusAU * 1.5, renderedRadiusAU + cameraNearAU * 1.2);
}
