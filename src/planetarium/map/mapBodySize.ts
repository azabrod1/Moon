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
 * Dot sprite extent per drawn radius, for every body the chart marks with one.
 *
 * The dot is a radial gradient, not a disc: opaque to 0.55 of its half-extent,
 * down to alpha 0.18 at 0.7, gone at 1.0. So it PAINTS about seven tenths of the
 * quad it is given, and a quad sized at the drawn radius would read as a body
 * two thirds the size of the globe it stands in for. At 2.6 the painted edge
 * lands at 0.7 × 1.3 = 0.91 of the drawn radius — near enough that the swap
 * between marker and globe reads as one object changing detail rather than
 * size. The ~9% residual is the price of the gradient and is not worth chasing.
 *
 * It lives here, with the rest of the drawn-size policy, because two things
 * need it: the sprite the scene builds, and anything that has to stay clear of
 * what that sprite paints.
 */
export const DOT_EXTENT_MUL = 2.6;

/**
 * The radius anything placed beside a body has to clear, in screen px.
 *
 * A globe paints its disc and nothing else, so its drawn radius is the whole
 * of it. A dot paints a quad half again as wide — the gradient's skirt fades
 * out at the half-extent, not at the drawn radius — so a rule written for the
 * globe puts a label a third of the way inside the sprite of the same body.
 * Which look is drawing is a per-frame fact the scene already holds; this is
 * the one place that fact turns into a distance.
 */
export function labelClearanceRadiusPx(drawnRadiusPx: number, drawnAsDot: boolean): number {
  if (!(drawnRadiusPx > 0)) return 0;
  return drawnAsDot ? (drawnRadiusPx * DOT_EXTENT_MUL) / 2 : drawnRadiusPx;
}

/** Ganymede, the largest moon, sets the top of the moon scale. */
const LARGEST_MOON_RADIUS_AU = 1.761e-5;
/** Where Ganymede draws, as a fraction of its parent's drawn radius, and the
 *  band every other moon is held inside. A moon is drawn against its PARENT
 *  rather than against the chart, so a system reads as a system at any zoom:
 *  the same picture whether Jupiter is a marker or a globe. */
const MOON_TOP_FRACTION = 0.34;
const MOON_MIN_FRACTION = 0.03;
const MOON_MAX_FRACTION = 0.36;

/**
 * A moon's chart marker in map AU: the SQRT of its true radius against the
 * largest moon, scaled to its parent's drawn radius and clamped into a band —
 * so Ganymede and Titan clearly dominate while Mimas and Phobos stay small but
 * visible. Sqrt rather than the planets' gentler exponent because the moon
 * spread is wider and the band is narrower; the shared philosophy is the same
 * one the world's moon sizing uses, and the one thing that must survive is
 * ordering.
 */
export function mapMoonMarkerRadiusAU(
  moonRadiusAU: number,
  parentDrawnRadiusAU: number,
): number {
  const rel = Math.sqrt(Math.max(moonRadiusAU, 0) / LARGEST_MOON_RADIUS_AU);
  const wanted = parentDrawnRadiusAU * MOON_TOP_FRACTION * rel;
  const lo = parentDrawnRadiusAU * MOON_MIN_FRACTION;
  const hi = parentDrawnRadiusAU * MOON_MAX_FRACTION;
  return Math.min(Math.max(wanted, lo), hi);
}

/**
 * A moon's drawn radius in map AU: its chart marker, or its true projected size
 * once that is larger — the same crossover the planets use, so closing in
 * resolves a real globe and nothing is ever drawn smaller than it is.
 */
export function mapMoonRadiusAU(
  moonRadiusAU: number,
  parentDrawnRadiusAU: number,
): number {
  // Both sides are already map AU — the marker is a fraction of the parent's
  // drawn radius, and the parent's drawn radius is where the camera enters —
  // so the crossover needs no projection of its own.
  return Math.max(mapMoonMarkerRadiusAU(moonRadiusAU, parentDrawnRadiusAU), moonRadiusAU);
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
