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

/** Stock landed/observatory camera near plane, and the app's startup
 *  default (~150 km). Surface view RELIES on the near plane culling the
 *  ground under the camera, and the framing helpers below are calibrated
 *  against it. Cruise swaps in its own dynamic near (cruiseView) every
 *  frame; every landing applies landedNearAU below, and mode deactivation
 *  restores this stock value. */
export const LANDED_NEAR_AU = 0.000001;

/**
 * Near plane for the body being orbited: the stock plane for everything
 * human-scale, shrinking to 2.2× the TRUE radius on bodies smaller than it.
 * Two constraints meet at 2.2. Surface view needs the near plane to cull the
 * ground beneath the camera — on a body smaller than the stock plane that
 * means culling the whole ball, and since the farthest ground point from a
 * surface camera is one diameter away, any factor above 2 keeps even the
 * antipode inside the cull. And the landing frame must not degrade: the
 * guard in landedFrameCamDistAU dominates only when 1.5·near exceeds
 * 4·renderedRadius, and 1.5 × 2.2 × trueRadius = 3.3·trueRadius can never
 * reach that (rendered ≥ true for every body), so every real body still
 * frames to ~18.9°. The 1e-8 AU (~1.5 km) floor only guards a degenerate
 * zero-radius body, mirroring landedFrameCamDistAU's own guard.
 */
export function landedNearAU(trueRadiusAU: number): number {
  return Math.min(LANDED_NEAR_AU, Math.max(trueRadiusAU * 2.2, 0.00000001));
}

/** Camera-distance multiple of the rendered radius; see the module note for the ⅓-view derivation. */
export const LANDED_FRAME_RADII = 4;

/**
 * Camera offset magnitude `d` for the landing frame (the camera ends up 1.5·d
 * from the body). With the landing near plane coming from landedNearAU, the
 * near-plane guard can only bind for a missing/zero-radius body; for every
 * real body `renderedRadius × LANDED_FRAME_RADII` dominates, so all bodies
 * frame to ~18.9° (pinned by the colocated test across the catalog).
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
