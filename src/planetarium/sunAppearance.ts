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
 * Artist-bounded analytic metering for the one known extreme light source.
 * Small distant Suns still make the camera react, while a close/zoomed disc
 * can pull exposure down by at most ~1.51 stops. Totality recovers to neutral.
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
  return THREE.MathUtils.lerp(1, 0.35, signal);
}
