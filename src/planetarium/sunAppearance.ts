import * as THREE from 'three';

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
