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
 * The dot is a radial gradient painted into a square quad, so the quad is
 * always wider than the mark: the profile below runs out to 0.77 of the
 * half-extent, and at 2.6 that puts the painted edge at 0.77 × 1.3 = 1.00 of
 * the drawn radius. Marker and globe therefore paint to the same limb, and the
 * crossover between them reads as one object changing detail rather than size.
 *
 * It lives here, with the rest of the drawn-size policy, because three things
 * need it: the sprite the scene builds, the gate that lifts a marker over the
 * solar disc (which is judged at the whole quad, gradient skirt and all), and
 * anything that has to stay clear of what the sprite paints.
 */
export const DOT_EXTENT_MUL = 2.6;

/** One stop of the marker's radial alpha profile: `at` is the fraction of the
 *  sprite's half-extent, `alpha` the coverage there, linear in between. */
export interface DotGradientStop {
  at: number;
  alpha: number;
}

/**
 * The marker's alpha profile — the shape of every dot the chart draws.
 *
 * A flat core with a short feather, not a bulb. The profile it replaced held
 * 0.18 alpha out at 0.7 of the half-extent and only reached zero at the quad's
 * own edge, which paints a visible haze half again as wide as the body it
 * stands for: at marker sizes that reads as a soft blob rather than as a world.
 * This one carries the same INK — the alpha-weighted equivalent disc, which is
 * the radius the eye reads a mark at, is within about a percent of the old
 * profile's, so nothing on the chart changed size — and spends it as coverage
 * instead of as skirt.
 *
 * The feather (0.68 → 0.77) is the mark's only soft edge, and it is sized to
 * antialias rather than to glow: about a pixel across at the smallest marker
 * the policy draws.
 */
export const DOT_GRADIENT_STOPS: readonly DotGradientStop[] = [
  { at: 0, alpha: 1 },
  { at: 0.55, alpha: 0.97 },
  { at: 0.68, alpha: 0.32 },
  { at: 0.77, alpha: 0 },
];

/** The profile sampled at `t` of the half-extent: piecewise linear through the
 *  stops, holding the first stop inside it and zero past the painted edge —
 *  exactly what a canvas radial gradient would interpolate from the same
 *  stops. The texture is authored from this sampler pixel by pixel instead of
 *  asking a 2D gradient fill to paint it; the reason lives with the texture
 *  builders that call it. */
export function dotGradientAlpha(t: number): number {
  const stops = DOT_GRADIENT_STOPS;
  if (t <= stops[0].at) return stops[0].alpha;
  for (let i = 1; i < stops.length; i++) {
    const lo = stops[i - 1];
    const hi = stops[i];
    if (t <= hi.at) {
      return lo.alpha + ((hi.alpha - lo.alpha) * (t - lo.at)) / (hi.at - lo.at);
    }
  }
  return 0;
}

/** Where the profile above reaches zero, as a fraction of the half-extent —
 *  the painted edge of a dot, derived from the profile rather than restated. */
export const DOT_PAINTED_FRACTION = ((): number => {
  for (const stop of DOT_GRADIENT_STOPS) if (stop.alpha <= 0) return stop.at;
  return 1;
})();

/** The painted radius of a dot per drawn radius: half the quad, times the share
 *  of it the profile actually covers. ~1.0 by construction — the marker paints
 *  the body's drawn limb. */
export const DOT_PAINTED_EDGE_MUL = (DOT_EXTENT_MUL / 2) * DOT_PAINTED_FRACTION;

/**
 * The radius anything placed beside a body has to clear, in screen px.
 *
 * Both looks paint to the same edge — a globe's disc is its drawn radius, and
 * the dot's profile is calibrated so its gradient dies there too — so the two
 * answers agree to a thousandth. They are still derived apart: the dot's edge
 * follows the gradient profile, and a future retune of that profile has to move
 * this with it rather than silently leaving labels standing off a skirt that is
 * no longer painted.
 */
export function labelClearanceRadiusPx(drawnRadiusPx: number, drawnAsDot: boolean): number {
  if (!(drawnRadiusPx > 0)) return 0;
  return drawnAsDot ? drawnRadiusPx * DOT_PAINTED_EDGE_MUL : drawnRadiusPx;
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
