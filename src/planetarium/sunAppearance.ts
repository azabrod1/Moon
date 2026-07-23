import * as THREE from 'three';

import { SUN_WHITEOUT_SLAM_EDGE } from '../shared/shaders/sun';

/** Fraction of a circular luminous source covered by one circular occluder. */
export function circleOcclusionFraction(
  sourceRadius: number,
  occluderRadius: number,
  separation: number,
): number {
  if (!(sourceRadius > 0) || !(occluderRadius > 0)) return 0;
  if (separation >= sourceRadius + occluderRadius) return 0;

  if (separation <= Math.abs(sourceRadius - occluderRadius)) {
    if (occluderRadius >= sourceRadius) return 1;
    return (occluderRadius * occluderRadius) / (sourceRadius * sourceRadius);
  }

  const d2 = separation * separation;
  const source2 = sourceRadius * sourceRadius;
  const occluder2 = occluderRadius * occluderRadius;
  const sourceAngle = Math.acos(THREE.MathUtils.clamp(
    (d2 + source2 - occluder2) / (2 * separation * sourceRadius),
    -1,
    1,
  ));
  const occluderAngle = Math.acos(THREE.MathUtils.clamp(
    (d2 + occluder2 - source2) / (2 * separation * occluderRadius),
    -1,
    1,
  ));
  const lensTriangle = 0.5 * Math.sqrt(Math.max(
    0,
    (-separation + sourceRadius + occluderRadius)
      * (separation + sourceRadius - occluderRadius)
      * (separation - sourceRadius + occluderRadius)
      * (separation + sourceRadius + occluderRadius),
  ));
  const overlapArea = source2 * sourceAngle + occluder2 * occluderAngle - lensTriangle;
  return THREE.MathUtils.clamp(overlapArea / (Math.PI * source2), 0, 1);
}

export interface SunExposureInput {
  /** Projected solar radius where 1 reaches from screen centre to top/bottom. */
  projectedRadiusNdc: number;
  /** Distance from screen centre in NDC units. */
  centerDistanceNdc: number;
  /** Uncovered fraction of the photosphere, in [0, 1]. */
  visibleFraction: number;
}

/**
 * Whether a solar occluder has the geometry needed to reveal the corona.
 * Annular eclipses deliberately return zero: even 99% area coverage still
 * leaves photosphere visible all the way around, so a totality corona would be
 * physically wrong. Very large foreground planets also fade out of this
 * treatment; their occultations keep the ordinary glare response instead.
 */
export function eclipseOccluderLikeness(occluderToSunRadiusRatio: number): number {
  // Ratio 1 is a deliberate binary boundary: an occluder smaller than the Sun
  // (annular geometry) leaves a photosphere ring all the way around, which must
  // stay blinding — so it gets no corona at all rather than a faded one. Real
  // second contact is abrupt too. The cost is a one-frame corona pop if an
  // occluder's angular size grows through exactly Sun-sized mid-flight; that
  // rare case is accepted rather than softened into a physically wrong reveal.
  if (!(occluderToSunRadiusRatio >= 1)) return 0;
  const sunToOccluderRatio = 1 / occluderToSunRadiusRatio;
  return THREE.MathUtils.smoothstep(sunToOccluderRatio, 0.35, 0.7);
}

/**
 * Whether a solar occluder is an eclipse (keep the silhouette night-lift kill)
 * or ordinary landscape (keep the night fills). A body a few solar diameters
 * wide on the sky is a backlit silhouette — a total or annular eclipse from the
 * first bite — so its own night side reads void black. A body tens of times
 * wider is landscape: the Sun behind it is simply ordinary night, the eye is
 * dark-adapted, and the starlight/planetshine fills must stay. Returns 1 up to
 * ~3× the solar radius, fading to 0 by ~8×.
 *
 * Feed the RAW occluder/Sun angular-radius ratio, never the [0.5, 3]-clamped
 * uOccluderRadii. NOT eclipseOccluderLikeness: that zeroes sub-Sun (annular)
 * occluders, whose disc must keep its silhouette blackness.
 */
export function silhouetteSizeGate(occluderToSunRatio: number): number {
  return 1 - THREE.MathUtils.smoothstep(occluderToSunRatio, 3, 8);
}

/** Radius of an angular source projected onto a plane along the sightline. */
export function projectedSourceRadiusAtPlane(
  sourceRadius: number,
  sourceDistance: number,
  planeDistance: number,
): number {
  if (!(sourceRadius > 0) || !(sourceDistance > 0) || !(planeDistance > 0)) return 0;
  return sourceRadius * THREE.MathUtils.clamp(planeDistance / sourceDistance, 0, 1);
}

/**
 * One-frame update for the short optical overshoot when the Sun emerges from
 * an occluder. The impulse depends on visibility rise-rate, so it is stable
 * across frame rates; the stored flash then decays exponentially.
 */
export function advanceSunEmergenceFlash(input: {
  previousVisibleFraction: number;
  visibleFraction: number;
  flash: number;
  dt: number;
  eligible: boolean;
}): number {
  const dt = Math.max(input.dt, 0);
  const decayed = THREE.MathUtils.clamp(input.flash, 0, 1) * Math.exp(-dt / 0.38);
  if (!input.eligible || !(dt > 0)) return decayed;

  const previous = THREE.MathUtils.clamp(input.previousVisibleFraction, 0, 1);
  const current = THREE.MathUtils.clamp(input.visibleFraction, 0, 1);
  const riseRate = Math.max(current - previous, 0) / dt;
  if (!(riseRate > 0) || previous >= 0.98) return decayed;

  const speed = THREE.MathUtils.smoothstep(riseRate, 0.12, 1.4);
  const uncoveredEnergy = Math.sqrt(1 - previous);
  return Math.max(decayed, speed * uncoveredEnergy);
}

/**
 * Proximity whiteout — the approach's final act. Surface brightness does not
 * fall with distance, so once the photosphere fills the frame no camera or eye
 * holds detail: adaptation loses and the view bleaches to a full white screen.
 * 0 beyond 2.6 solar radii (the granulation study tier lives there), climbing
 * to ~0.99 at the 1.2-radii governor hover, pinned 1 just before contact so the
 * crossing meets the interior side already saturated.
 */
export function sunWhiteoutFraction(distanceSolarRadii: number): number {
  if (!(distanceSolarRadii > 0)) return 1;
  return 1 - THREE.MathUtils.smoothstep(distanceSolarRadii, 1.12, 2.6);
}

/**
 * Opacity of the DOM chrome flood — the blaze spilling over the HUD itself.
 * Gated on the same slam edge as the shader's radiance, so the menus stay
 * crisp through the whole approach and only wash out in the final act, in
 * step with the scene going full white. Capped well below 1: the cockpit
 * must stay findable (and clickable — the flood never takes pointer events)
 * inside the blaze.
 */
export function sunGlareFloodOpacity(whiteout: number): number {
  return 0.65 * THREE.MathUtils.smoothstep(whiteout, SUN_WHITEOUT_SLAM_EDGE, 1);
}

/**
 * Whiteout handoff below the photosphere, driven by submersion (centre
 * distance / radius, 1 at the surface). The crossing itself stays saturated
 * white — continuous with sunWhiteoutFraction at contact — and the molten
 * interior current only emerges as depth pulls this back down; past
 * half-submersion the ember dive owns the view.
 */
export function sunInteriorWhiteout(submersion: number): number {
  return THREE.MathUtils.smoothstep(submersion, 0.55, 0.92);
}

/**
 * Artist-bounded analytic metering for the one known extreme light source.
 * Small distant Suns still make the camera react, while a close/zoomed disc
 * can pull exposure down by at most ~1.51 stops in normal framing and ~2 stops
 * for an extreme full-frame photosphere close-up. Totality recovers to neutral.
 */
export function targetSunExposure(input: SunExposureInput): number {
  if (!(input.projectedRadiusNdc > 0) || input.visibleFraction <= 0) return 1;

  const radiusResponse = THREE.MathUtils.clamp(
    Math.log2(1 + input.projectedRadiusNdc * 128) / 4.5,
    0,
    1,
  );
  const centreResponse = 1 - THREE.MathUtils.smoothstep(input.centerDistanceNdc, 0.62, 1.5);
  const visibleEnergy = Math.pow(THREE.MathUtils.clamp(input.visibleFraction, 0, 1), 0.38);
  const signal = radiusResponse * centreResponse * visibleEnergy;
  const metered = THREE.MathUtils.lerp(1, 0.35, signal);
  // At an extreme close approach the photosphere fills most of the frame. A
  // further stopped-down tier reveals granulation and limb structure without
  // altering the normal/telescope exposure curve.
  const closeResponse = THREE.MathUtils.smoothstep(input.projectedRadiusNdc, 0.55, 0.95)
    * centreResponse * visibleEnergy;
  return THREE.MathUtils.lerp(metered, 0.25, closeResponse);
}
