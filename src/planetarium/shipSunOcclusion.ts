/**
 * Pure geometry for the cruise ship's solar-source occlusion probe.
 *
 * The live controller owns mesh traversal/raycasting; this module owns the
 * deterministic, equal-weight solar-disc samples and the conservative angular
 * early-out. Keeping those pieces pure makes the rare raycast path testable
 * without constructing the Planetarium controller.
 */

export interface ShipSunDiscSample {
  x: number;
  y: number;
}

/** Raised from the 19-ray first pass after the deterministic hull-graze sweep
 * exposed a three-sample (~16%) step inside one output pixel. This path runs
 * only after the conservative Sun/ship cone overlap gate. */
export const SHIP_SUN_DISC_SAMPLE_COUNT = 37;

/** Equal-weight Vogel-disc samples. Sample zero is pinned to the source centre
 * so a sub-pixel Sun still has an exact centre sightline; the remaining radii
 * grow with sqrt(area), avoiding an outer-ring bias. */
export const SHIP_SUN_DISC_SAMPLES: readonly ShipSunDiscSample[] = Object.freeze(
  Array.from({ length: SHIP_SUN_DISC_SAMPLE_COUNT }, (_, index) => {
    if (index === 0) return Object.freeze({ x: 0, y: 0 });
    const radius = Math.sqrt(index / (SHIP_SUN_DISC_SAMPLE_COUNT - 1));
    const angle = index * Math.PI * (3 - Math.sqrt(5));
    return Object.freeze({
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
    });
  }),
);

/**
 * Conservative angular precheck for a source disc against the sphere that
 * contains every ship profile.
 *
 * `sourceDotShip` is the dot of the unit camera→source and camera→ship
 * directions. A camera inside the conservative sphere must always traverse:
 * the cruise wheel-zoom floor can sit inside this broad bound while remaining
 * outside the actual hull.
 */
export function shipHullMayOverlapSource(
  cameraDistanceAU: number,
  hullRadiusAU: number,
  sourceDotShip: number,
  sourceAngularRadiusRad: number,
): boolean {
  if (!(cameraDistanceAU > hullRadiusAU)) return true;
  const hullAngularRadius = Math.asin(Math.min(1, Math.max(0, hullRadiusAU / cameraDistanceAU)));
  const combinedRadius = Math.min(Math.PI, Math.max(0, sourceAngularRadiusRad) + hullAngularRadius);
  return Math.min(1, Math.max(-1, sourceDotShip)) >= Math.cos(combinedRadius);
}

/** Equal-weight sample reduction, clamped against defensive bad inputs. */
export function unblockedShipSunFraction(unblockedSamples: number, totalSamples: number): number {
  if (!(totalSamples > 0)) return 1;
  return Math.min(1, Math.max(0, unblockedSamples / totalSamples));
}
