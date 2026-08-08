/**
 * "Teleport anywhere" — turning a click on empty chart into a real point in
 * space. Pure math: no THREE, no DOM, no scene state.
 *
 * The chart is a schematic of the real system, so a pixel on it has to be read
 * back through two transforms before it means anything:
 *
 * 1. The pixel is a RAY, and the point it names is where that ray meets the
 *    J2000 ecliptic reference plane — the plane the orbits visibly ride, not
 *    the chart's own y = 0. The chart is the equatorial frame, so that plane
 *    sits about 23.4° off the chart's equator; its normal arrives from the
 *    caller (the shared ECLIPTIC_NORTH_EQUATORIAL) rather than being rebuilt
 *    here from a hand-written angle. The compression is radial and holds
 *    direction, so a plane through the Sun is the SAME plane in chart space as
 *    in real space — the intersection can be taken directly on the chart.
 *
 * 2. The hit is a chart radius, and the ship needs a real one. `unmapRadius`
 *    is the inverse of the chart's radial compression and the only legal one;
 *    the direction from the Sun is already exact, so the real point is that
 *    unit direction times the inverted radius.
 *
 * The clamp runs AFTER the inverse, in raw AU, against a fixed extent taken
 * from the planet catalog. Clamping the chart radius instead would move the
 * reachable limit every time the scale toggle animated, and measuring the
 * limit off the chart's LIVE extent would let the ship enlarge it: the ship's
 * own marker is part of that extent, so each teleport outward would widen the
 * range the next one may reach.
 *
 * Two guards decide a gesture is not a teleport at all, and both swallow it
 * rather than substituting something: a ray pointing away from the plane
 * (behind the camera), and one arriving so nearly edge-on that a pixel of aim
 * slides the hit point across the system. Clamping a miss into a max-range
 * teleport would send the ship to the rim for a click that meant nothing.
 */
import { formatBodyDistance } from '../bodyDistance';
import { unmapRadius, type MapCurve } from './mapProjection';

export interface TpVec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Smallest |ray · plane normal| a teleport will read. Below it the plane is
 * within ~4.6° of edge-on, where the whole system projects into a few rows of
 * pixels: at the map's 50° field one pixel of aim is about 0.05°, and dividing
 * that by the sine of the incidence slides the hit point more than a percent
 * of its own distance per pixel. The chart orbits freely, so this pose is
 * reachable on purpose, not a corner case — which is why the answer is to
 * swallow the gesture rather than to forbid the view.
 */
export const TP_MIN_INCIDENCE = 0.08;

/** A chart hit closer to the origin than this has no usable direction from the
 *  Sun — it is float noise, and the whole inverse rides that direction. Orders
 *  of magnitude below anything a pixel can resolve at any framing the chart
 *  offers, so only a ray aimed dead at the origin can reach it. */
const TP_ORIGIN_EPS_AU = 1e-9;

/** Closest a chosen point may sit to the Sun. Inside Mercury by a wide margin,
 *  and far outside the star itself — the point is a place to fly from, not a
 *  dive into the photosphere. */
export const TP_MIN_RADIUS_AU = 0.1;

/** How far past the outermost charted orbit the range reaches. Enough to park
 *  beyond Pluto and look back at the system; not an open invitation to the
 *  interstellar void, where the chart has nothing left to draw. */
export const TP_EXTENT_MARGIN = 1.3;

/** Where a teleport gesture landed: the real heliocentric point in AU, the
 *  chart-space point it was read from (the caller's revealed-system test lives
 *  in that amplified space), and how far from the Sun the chip will say it is. */
export interface TeleportPick {
  x: number;
  y: number;
  z: number;
  chartX: number;
  chartY: number;
  chartZ: number;
  radiusAU: number;
  /** True when the range limit moved the point in from where the ray hit. */
  clamped: boolean;
}

export function makeTeleportPick(): TeleportPick {
  return { x: 0, y: 0, z: 0, chartX: 0, chartY: 0, chartZ: 0, radiusAU: 0, clamped: false };
}

/**
 * The fixed outer reach of the charted system, in raw AU: the widest catalog
 * orbit, Pluto included. A catalog figure on purpose — it cannot drift, and
 * nothing the ship does can move it.
 */
export function outerOrbitExtentAU(orbits: readonly { semiMajorAxisAU: number }[]): number {
  let max = 0;
  for (const orbit of orbits) {
    if (orbit.semiMajorAxisAU > max) max = orbit.semiMajorAxisAU;
  }
  return max;
}

/** The radius window a chosen point is held inside, for a given outer extent. */
export function teleportRangeAU(outerExtentAU: number): { minAU: number; maxAU: number } {
  return {
    minAU: TP_MIN_RADIUS_AU,
    maxAU: Math.max(TP_MIN_RADIUS_AU, outerExtentAU * TP_EXTENT_MARGIN),
  };
}

/**
 * Where a screen ray meets a plane through the Sun, in chart units — or null
 * when the ray misses in either of the two ways that matter (see the header).
 * `t` is the distance along a unit ray; the caller walks the ray itself.
 */
export function intersectSunPlane(
  origin: TpVec3,
  unitDir: TpVec3,
  unitNormal: TpVec3,
  minIncidence = TP_MIN_INCIDENCE,
): number | null {
  const denom = unitDir.x * unitNormal.x + unitDir.y * unitNormal.y + unitDir.z * unitNormal.z;
  if (!(Math.abs(denom) >= minIncidence)) return null;
  const height = origin.x * unitNormal.x + origin.y * unitNormal.y + origin.z * unitNormal.z;
  const t = -height / denom;
  // Behind the camera: the plane is there, but not in front of the pixel.
  return t > 0 ? t : null;
}

/**
 * The whole gesture, end to end: a chart-space ray becomes the real
 * heliocentric point in AU the ship will be put at, or null when the guards
 * swallow it. `rayDir` and `planeNormal` need not be unit vectors. Writes into
 * `out` and returns it, so a gesture costs no allocation.
 */
export function resolveTeleportPick(
  rayOrigin: TpVec3,
  rayDir: TpVec3,
  planeNormal: TpVec3,
  blend: number,
  curve: MapCurve,
  outerExtentAU: number,
  out: TeleportPick,
): TeleportPick | null {
  const dirLen = Math.hypot(rayDir.x, rayDir.y, rayDir.z);
  const normLen = Math.hypot(planeNormal.x, planeNormal.y, planeNormal.z);
  if (!(dirLen > 0) || !(normLen > 0)) return null;
  const dx = rayDir.x / dirLen;
  const dy = rayDir.y / dirLen;
  const dz = rayDir.z / dirLen;
  const nx = planeNormal.x / normLen;
  const ny = planeNormal.y / normLen;
  const nz = planeNormal.z / normLen;
  const t = intersectSunPlane(rayOrigin, { x: dx, y: dy, z: dz }, { x: nx, y: ny, z: nz });
  if (t === null) return null;

  const chartX = rayOrigin.x + dx * t;
  const chartY = rayOrigin.y + dy * t;
  const chartZ = rayOrigin.z + dz * t;
  const chartR = Math.hypot(chartX, chartY, chartZ);
  if (!(chartR > TP_ORIGIN_EPS_AU) || !Number.isFinite(chartR)) return null;

  const rawR = unmapRadius(chartR, blend, curve);
  if (!Number.isFinite(rawR) || !(rawR > 0)) return null;

  const range = teleportRangeAU(outerExtentAU);
  const radiusAU = Math.min(Math.max(rawR, range.minAU), range.maxAU);
  // The compression holds direction exactly, so the real point is the chart
  // point's own direction at the inverted (and clamped) radius. Rebuilding it
  // from the unit direction rather than scaling the chart point keeps a
  // clamped result exactly on the range shell.
  out.x = (chartX / chartR) * radiusAU;
  out.y = (chartY / chartR) * radiusAU;
  out.z = (chartZ / chartR) * radiusAU;
  out.chartX = chartX;
  out.chartY = chartY;
  out.chartZ = chartZ;
  out.radiusAU = radiusAU;
  out.clamped = radiusAU !== rawR;
  return out;
}

/** The confirm chip's line. The distance is the whole reason the gesture
 *  confirms rather than jumping: it is what makes the choice an informed one. */
export function teleportChipLabel(radiusAU: number): string {
  return `Teleport here · ${formatBodyDistance(radiusAU)} from the Sun`;
}
