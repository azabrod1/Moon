/**
 * Drawn-size policy for bodies on the system map — the single definition of how
 * big a body renders on the chart.
 *
 * Same philosophy as the world's moonRenderSize: truth wherever truth is
 * legible, a compressive curve where it is not, size ordering preserved either
 * way. The difference is what the floor is anchored to. On the chart the floor
 * is a screen size, because at the whole-system overview every body is far
 * below one pixel (Earth spans ~0.001 px across a 49 AU frame). So a body draws
 * at its marker size until its true projected size overtakes it, and at true
 * size from there in — one continuous crossover, nothing pops.
 *
 * Below that crossover the marker is not one flat dot for everything: its size
 * follows the body's true radius on a compressive power law about a reference
 * radius, so Jupiter still reads bigger than Earth reads bigger than Mercury
 * while the whole spread stays inside [minPx, maxPx]. The chart's subject is
 * the orbits; markers stay markers.
 *
 * Invariants the consumers lean on:
 *  - never smaller than the body's true projected size — nothing is shrunk;
 *  - never smaller than minPx, so every body stays visible at the overview
 *    (staying *tappable* is the pick resolver's job: it takes the larger of the
 *    pointer floor and the drawn disc, so a floored marker keeps a full-size
 *    hit target);
 *  - never larger than maxPx while the marker governs, so orbits stay dominant;
 *  - strictly ordered by true radius between the reference radius and the cap;
 *  - continuous in camera distance: marker and truth meet exactly where they
 *    cross.
 *
 * Bodies smaller than the reference radius all sit on the floor — the chart
 * cannot separate them at the overview and does not pretend to; the reference
 * is a knob, so a view whose smallest body is much smaller can lower it.
 *
 * Every knob lives in the block below and retunes live through the dev bridge,
 * the way the world's moon size curve does.
 */

import { KM_PER_AU } from '../../astronomy/constants';

/** True radius that draws exactly at the floor: the smallest catalog planet
 *  (Mercury), so every planet sits at or above the floor. */
const MAP_BODY_REF_RADIUS_KM = 2440;

export interface MapBodySizeParams {
  /** Legibility floor, screen px of radius — no body draws smaller. */
  minPx: number;
  /** Ceiling for the marker branch, screen px of radius. Binds only well above
   *  the planets (the Sun would otherwise sit on the chart as a blob); true
   *  size still overtakes it as the camera closes. */
  maxPx: number;
  /** Compression exponent of the marker branch: drawn spread = true spread^gamma. */
  gamma: number;
  /** True radius (AU) that draws exactly at minPx. */
  refRadiusAU: number;
}

export const MAP_BODY_SIZE_DEFAULTS: MapBodySizeParams = {
  minPx: 6,
  maxPx: 18,
  gamma: 0.3,
  refRadiusAU: MAP_BODY_REF_RADIUS_KM / KM_PER_AU,
};

/**
 * Marker radius (screen px) for a body of true radius `radiusAU` — the chart
 * symbol, independent of camera distance.
 */
export function mapMarkerRadiusPx(
  radiusAU: number,
  params: MapBodySizeParams = MAP_BODY_SIZE_DEFAULTS,
): number {
  if (!(radiusAU > 0)) return params.minPx;
  const px = params.minPx * Math.pow(radiusAU / params.refRadiusAU, params.gamma);
  if (!(px > params.minPx)) return params.minPx;
  return Math.min(px, params.maxPx);
}

/**
 * Drawn radius (screen px): the marker, or the body's true projected radius
 * once that is the larger — so closing in resolves a real globe instead of a
 * symbol, and the symbol never shrinks a body.
 */
export function mapBodyRadiusPx(
  radiusAU: number,
  trueProjectedPx: number,
  params: MapBodySizeParams = MAP_BODY_SIZE_DEFAULTS,
): number {
  const marker = mapMarkerRadiusPx(radiusAU, params);
  return trueProjectedPx > marker ? trueProjectedPx : marker;
}

/**
 * Drawn radius in map-space AU for a body sitting `depthAU` along the camera's
 * view axis. `worldPerPxAtUnitDepth` is the world span of one screen px at unit
 * depth (2·tan(fov/2) / viewport height) — the same factor the constant-size
 * markers scale with, so one camera fact drives both.
 */
export function mapBodyRadiusAU(
  trueRadiusAU: number,
  depthAU: number,
  worldPerPxAtUnitDepth: number,
  params: MapBodySizeParams = MAP_BODY_SIZE_DEFAULTS,
): number {
  const worldPerPx = worldPerPxAtUnitDepth * Math.max(depthAU, 1e-9);
  if (!(worldPerPx > 0)) return trueRadiusAU;
  return mapBodyRadiusPx(trueRadiusAU, trueRadiusAU / worldPerPx, params) * worldPerPx;
}
