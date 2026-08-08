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
 * The marker itself is no longer constant in px: it rides a zoom response
 * (`mapMarkerZoomScale` / `mapMarkerZoomScaleAt` below) driven by
 * AU-per-screen-px at camera DEPTH — mostly the chart centre's, with a small
 * share of each body's own. Markers hold full size at every framing from the
 * inner system out to the planet-orbit views and ease down together as the
 * camera pulls toward the whole-system overview, where constant-px marks
 * would pile giant night-side globes onto the star. Depth is the driver
 * deliberately: it is continuous under every camera move (a zoom-pivot reseat
 * teleports the orbit target without moving the camera, so any driver
 * measured against the target would step mid-gesture) and needs no per-frame
 * state. The per-body share adds a whisper of perspective — a background body
 * eases a little further than a foreground one, the direction its true disc
 * would move — kept small so depth difference can never let a small near body
 * out-draw a big far one.
 *
 * Invariants the consumers lean on:
 *  - never smaller than the body's true projected size — nothing is shrunk;
 *  - never smaller than floorScale·minPx, so every body stays visible at the
 *    overview (staying *tappable* is the pick resolver's job: it takes the
 *    larger of the pointer floor and the drawn disc, so a floored marker keeps
 *    a full-size hit target);
 *  - never larger than maxPx while the marker governs, so orbits stay dominant;
 *  - strictly ordered by true radius AT EQUAL DEPTH between the reference
 *    radius and the cap; across different depths perspective rules, the same
 *    way it already does for resolved true discs;
 *  - continuous in camera distance: marker and truth meet exactly where they
 *    cross, and the zoom response is continuous through its reference point.
 *
 * Bodies smaller than the reference radius all sit on the floor — the chart
 * cannot separate them at the overview and does not pretend to; the reference
 * is a knob, so a view whose smallest body is much smaller can lower it.
 *
 * Every knob lives in the two blocks below (radius curve, zoom response) and
 * retunes live through the dev bridge, the way the world's moon size curve
 * does.
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

// ×0.7 of the first tuning (6/18): at the old sizes a zoomed-out chart read
// as discs first and a system second — the Sun's disc spanned the inner
// orbits. The shrink is uniform so every ratio the marker-zoom pass tuned
// survives; a stated consequence is that Mercury and Mars (and, at the far
// fit, the ice giants) now sit under the 5 px globe threshold wherever the
// marker governs, and draw as tinted dots — a 4 px globe is mush anyway.
export const MAP_BODY_SIZE_DEFAULTS: MapBodySizeParams = {
  minPx: 4.2,
  maxPx: 12.6,
  gamma: 0.3,
  refRadiusAU: MAP_BODY_REF_RADIUS_KM / KM_PER_AU,
};

/**
 * Marker radius (screen px) for a body of true radius `radiusAU` — the chart
 * symbol, independent of camera distance. (The DRAWN marker no longer is: the
 * consumers scale this by `mapMarkerZoomScale` before painting.)
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
 * The zoom response of the marker branch.
 *
 * `auPerPx` is the world span of one screen pixel at the BODY's depth — the
 * quantity the sizing pass already has in hand per body. Below the reference
 * the answer is exactly 1: every framing from the inner system out to the
 * planet-orbit views draws the markers at full size, byte-identical to the
 * constant-marker chart this replaces. Past it the scale falls on a
 * compressive power law and settles on the floor, so the whole-system
 * overview draws every mark at a fraction that keeps the star the biggest
 * disc on the chart. γ 0 is the constant branch, kept for the corner chart,
 * whose fixed framing has no zoom to answer.
 *
 * Anything degenerate — zero, negative, NaN, infinite — answers 1: a body the
 * projection cannot place yet draws at its familiar size rather than at a
 * surprise one.
 */
export interface MapMarkerZoomParams {
  /** Compression exponent of the response; 0 = constant markers (the old
   *  look). */
  gamma: number;
  /** AU-per-px at the body's depth where the shrink begins. In CHART units —
   *  the compressed chart's AU-per-px, the same space `viewDepth` answers in. */
  refAuPerPx: number;
  /** Smallest multiplier the response reaches — the far-overview size. */
  floorScale: number;
  /** How much of the response rides the body's OWN depth; the rest rides the
   *  chart centre's. See `mapMarkerZoomScaleAt`. 1 = pure per-body. */
  depthShare: number;
}

export const MAP_MARKER_ZOOM_DEFAULTS: MapMarkerZoomParams = {
  gamma: 0.75,
  // Chart-units-per-px just past the framing that holds Jupiter's whole orbit
  // on a desktop-tall window: everything from there IN is untouched. At the
  // complaint pose — Neptune's orbit filling a 1300-tall window, ~7.7e-3 —
  // the response reads ~0.49: the markers halve, and the star's 8 px floor
  // tops every planet disc again.
  refAuPerPx: 0.003,
  // Binds from about the zoom ceiling out. Low enough that the giants sit
  // under the Sun's floor disc, high enough that the smallest markers
  // (floorScale·minPx ≈ 2.5 px) stay above the label-culling threshold —
  // there is a test pinning that margin.
  floorScale: 0.42,
  // Mostly the centre's answer, with a fifth of the body's own: enough that a
  // deep background eases while a foreground body holds, compressed enough
  // that a tilted fit cannot draw a near small body over a far big one (the
  // pure per-body response inverted Neptune over Jupiter by 18% there; a
  // fifth of that spread is under the eye's threshold at marker sizes).
  depthShare: 0.2,
};

export function mapMarkerZoomScale(
  auPerPx: number,
  params: MapMarkerZoomParams = MAP_MARKER_ZOOM_DEFAULTS,
): number {
  if (!(auPerPx > params.refAuPerPx) || !Number.isFinite(auPerPx)) return 1;
  if (!(params.gamma > 0)) return 1;
  const s = Math.pow(params.refAuPerPx / auPerPx, params.gamma);
  return s > params.floorScale ? s : params.floorScale;
}

/**
 * The zoom response a BODY draws with: the chart centre's response, times the
 * body's own raised to `depthShare` — a log-space blend of the two depths.
 *
 * The centre (the star sits at the chart's origin) carries the zoom itself:
 * its depth moves only with the camera, continuously through every gesture.
 * The body's own depth carries the perspective: a background body eases a
 * little further than a foreground one, the direction its true disc would
 * move. Blending in log space keeps both properties exact — at equal depths
 * the answer is the shared response (ordering by true radius is exact there),
 * and across unequal depths the per-body spread is compressed by the share —
 * markers a tilted overview would visibly re-order under the pure response
 * stay ordered, and the residual swaps live on near-equal markers (within a
 * few percent) at hundredths of a pixel, under the eye's threshold. Share 1
 * is the pure per-body response; share 0 pins every marker to the centre's
 * answer.
 *
 * Both responses read 1 inside the reference, and once both depths
 * individually reach the floor the blend is the floor — so the blend changes
 * nothing at either end of the zoom and only tempers the spread in between.
 * (At a tilted ceiling a near-edge body can still sit a few percent off the
 * floor while the centre is on it; the blend then lands a fifth of that gap
 * above the floor, which is the perspective share working as intended.)
 */
export function mapMarkerZoomScaleAt(
  bodyDepthAU: number,
  centralDepthAU: number,
  worldPerPxAtUnitDepth: number,
  params: MapMarkerZoomParams = MAP_MARKER_ZOOM_DEFAULTS,
): number {
  const central = mapMarkerZoomScale(worldPerPxAtUnitDepth * centralDepthAU, params);
  const own = mapMarkerZoomScale(worldPerPxAtUnitDepth * bodyDepthAU, params);
  if (own === central) return central;
  return central * Math.pow(own / central, params.depthShare);
}

/**
 * Drawn radius (screen px): the zoom-scaled marker, or the body's true
 * projected radius once that is the larger — so closing in resolves a real
 * globe instead of a symbol, and the symbol never shrinks a body.
 * `markerScale` scales ONLY the marker branch (1 = the classic chart); truth
 * always wins the max whatever the scale.
 */
export function mapBodyRadiusPx(
  radiusAU: number,
  trueProjectedPx: number,
  params: MapBodySizeParams = MAP_BODY_SIZE_DEFAULTS,
  markerScale = 1,
): number {
  const marker = mapMarkerRadiusPx(radiusAU, params) * markerScale;
  return trueProjectedPx > marker ? trueProjectedPx : marker;
}

/**
 * The Sun's own drawn-size branch.
 *
 * Through the marker policy above the Sun computes far over `maxPx` and pins
 * to the cap, and its true disc does not overtake the cap until the camera is
 * practically inside Mercury's orbit — so across the whole useful zoom range
 * the star drew at one constant screen size while every body around it
 * resolved and grew. A dive toward a planet then reads wrong twice over: the
 * planet and its moons swell as the camera closes while the star sits pinned
 * to the glass, and a disc plus halo sized for the overview dominates a
 * neighbourhood it is five AU away from.
 *
 * So the Sun answers zoom on its own compressive curve: drawn px =
 * `pivotPx · (true px / pivotPx)^gamma`, floored. The curve meets the true
 * disc exactly at the pivot (for γ < 1 it sits above truth below the pivot and
 * below it past it, so `max` with truth hands over continuously there — the
 * same crossover shape the marker branch has), grows gently as the camera
 * closes, and settles on the floor at the overview. γ = 0 is the old constant,
 * kept for the corner chart, whose fixed framing has no zoom to answer.
 */
export interface MapSunSizeParams {
  /** Compression exponent of the zoom response; 0 = constant (the old look). */
  gamma: number;
  /** Screen px of radius where the curve meets the true disc. */
  pivotPx: number;
  /** Smallest the Sun draws, px of radius — the overview size. */
  floorPx: number;
}

export const MAP_SUN_SIZE_DEFAULTS: MapSunSizeParams = {
  gamma: 0.3,
  // ×0.7 with the planet markers (12.6 = the marker branch's new ceiling, as
  // 18 was of the old): the crossover to the true disc moves in with it, so
  // the mid-zoom shrink lands nearer ×0.78 than ×0.7 — the pivot is a hybrid
  // knob, not a pure scale. The far overview is where the old Sun spanned
  // the inner orbits, and the floor below is the exact ×0.7 that fixes it.
  pivotPx: 12.6,
  // Low enough that the curve is off the floor from about 1.5 px of true disc
  // — a Jupiter-range view already answers zoom — while the overview keeps a
  // clear warm mark (the halo carries the star's rank there, not the disc).
  floorPx: 5.6,
};

/** Drawn radius (screen px) for the Sun whose true projected radius is
 *  `trueProjectedPx`. Never smaller than the true disc, never below the floor. */
export function mapSunRadiusPx(
  trueProjectedPx: number,
  params: MapSunSizeParams = MAP_SUN_SIZE_DEFAULTS,
): number {
  if (!(trueProjectedPx > 0)) return params.floorPx;
  const curved = params.pivotPx * Math.pow(trueProjectedPx / params.pivotPx, params.gamma);
  const px = curved > trueProjectedPx ? curved : trueProjectedPx;
  return px > params.floorPx ? px : params.floorPx;
}

/** The Sun's drawn radius in map-space AU — same camera factor contract as
 *  `mapBodyRadiusAU`. */
export function mapSunRadiusAU(
  trueRadiusAU: number,
  depthAU: number,
  worldPerPxAtUnitDepth: number,
  params: MapSunSizeParams = MAP_SUN_SIZE_DEFAULTS,
): number {
  const worldPerPx = worldPerPxAtUnitDepth * Math.max(depthAU, 1e-9);
  if (!(worldPerPx > 0)) return trueRadiusAU;
  return mapSunRadiusPx(trueRadiusAU / worldPerPx, params) * worldPerPx;
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
 *
 * `markerScale` is the zoom response the caller computed for this body —
 * `mapMarkerZoomScaleAt` from this same depth plus the chart centre's, which
 * is why it is handed in rather than derived here. 1 is the classic
 * constant-marker chart.
 */
export function mapBodyRadiusAU(
  trueRadiusAU: number,
  depthAU: number,
  worldPerPxAtUnitDepth: number,
  params: MapBodySizeParams = MAP_BODY_SIZE_DEFAULTS,
  markerScale = 1,
): number {
  const worldPerPx = worldPerPxAtUnitDepth * Math.max(depthAU, 1e-9);
  if (!(worldPerPx > 0)) return trueRadiusAU;
  return mapBodyRadiusPx(trueRadiusAU, trueRadiusAU / worldPerPx, params, markerScale)
    * worldPerPx;
}
