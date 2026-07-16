/**
 * Photometric moon dots: the pure render-proxy photometry behind the sub-pixel
 * moon points.
 *
 * A moon whose drawn disc is smaller than a couple of pixels is invisible as a
 * sphere, yet a real body that bright would still show as a naked-eye point. So a
 * sub-pixel moon renders as a star-scale point at its apparent magnitude, through
 * the same magnitude → brightness/size mapping the starfield uses — held at a
 * bright-end scene ceiling (the planets are tonemapped, so the point scale must
 * compress with them) — and hands off to the real mesh disc across a luminance-
 * matched crossfade as the disc resolves.
 *
 * Render-proxy photometry: the flux uses the RENDERED radius the scene actually
 * draws — moons are inflated on a compressive curve so tiny ones stay findable —
 * NOT the true radius. The point must hand off to the disc that is really on
 * screen; a true-flux point would mismatch its own inflated disc and pop at the
 * crossover. This is the same honest fiction the rendered-size curve makes.
 *
 * Every tuning constant lives in MOON_DOT_PARAMS; the controller keeps a live
 * copy the dev bridge merges into (`__moon.setMoonDotParams`) for tuning by eye.
 */

import { DEG2RAD } from '../shared/math/angles';
import { STAR_POINT_MAPPING, starPointVisual, type StarPointMapping } from './world/starPointMapping';

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const lerp = (x: number, y: number, t: number) => (1 - t) * x + t * y;
function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export interface MoonDotParams {
  /** Apparent-magnitude zero point of the render-proxy flux model. Calibrated so
   *  a representative Galilean at a close standoff lands at naked-eye-bright:
   *  Europa (rendered radius, tint-luminance albedo) at Δ = 0.036 AU, r_sun = 5.2
   *  AU, full phase resolves to ≈ mag −5. */
  magZeroPoint: number;
  /** Catalog-tint luminance → albedo proxy: clamp to a plausible band, then gain. */
  albedoMin: number;
  albedoMax: number;
  albedoGain: number;
  /** Bright-end scene ceiling (apparent magnitude): a dot never renders brighter
   *  than a star of this magnitude. The planet discs are tonemapped far below
   *  their physical brightness, so an uncapped photometric point (a Galilean at
   *  close range is genuinely Venus-class, mag −5) would out-render its own
   *  parent planet — five beacons dwarfing a modest Jupiter. The ceiling sits at
   *  first-magnitude class (1.0, was 0.2): the saturated bright end is what
   *  bloom inflates into a fat halo (measured 12px → 4px beside a 45px Jupiter),
   *  and clamping dimmer keeps the parent the visual anchor while leaving
   *  every fainter-than-ceiling dot's photometric differences untouched. */
  magCeiling: number;
  /** Hard cap on the dot's point size (CSS px), below the star mapping's own
   *  6.5 px top end — a moon dot should read as a bright star, never as a
   *  Jupiter-scale orb once bloom widens it. */
  sizeMaxPx: number;
  /** Disc-handoff crossfade window (rendered disc DIAMETER, screen px): the dot
   *  fades out as the disc grows from START to END. Wide so the disc is already
   *  larger than a bright point before the dot fully dies (no "blazing point
   *  shrinks into a small disc" deflation). The #1 tune-by-eye target. */
  fadeStartPx: number;
  fadeEndPx: number;
  /** Luminance matching at the handoff: across the first ~60% of the crossfade
   *  window the dot's brightness ramps from its star-scale value to
   *  discMatchLum · albedo · illumination — an estimate of the tonemapped
   *  luminance of the small disc it is handing off to. Without this the dot dies
   *  at full star brightness while the disc is still a couple of dim pixels: a
   *  bright point, then nothing, then a faint moon. With it the point visibly
   *  resolves INTO the disc, like a telescope pulling focus. */
  discMatchLum: number;
  /** Shrink a large point toward the disc size across the crossfade so point and
   *  disc converge; never grows a faint point toward a big disc. */
  shrinkToDisc: boolean;
  /** Nav-target floor: the moon you are flying at keeps at least this much star
   *  contribution while its physical flux is > 0, so it never fully vanishes.
   *  Applied before the disc/edge crossfades — a resolved or edge target still
   *  fades out. */
  targetMinIntensity: number;
  /** Below the star catalog's faint limit, alpha ramps from the star faint-end
   *  floor to zero over this many magnitudes — dots fade in from nothing. */
  faintExtendMag: number;
  /** System-edge fade: dots ramp in over the last fraction of the system
   *  visibility threshold distance, so a system's dots never appear as a
   *  one-frame constellation. */
  systemEdgeFadeFrac: number;
  /** Parent-dominance gate (parent planet's disc DIAMETER, screen px): dots ramp
   *  from nothing at START to full at FULL as the parent's own disc resolves.
   *  From far away the planet itself is dot-scale — physically it outshines its
   *  moons a thousandfold, but the tonemapped disc can't say so, and bright-star
   *  points beside a planet-sized blob read as equals. So the moons hold back
   *  until the planet visually dominates. */
  parentGateStartPx: number;
  parentGateFullPx: number;
  /** Proximity release of the parent-dominance gate: a moon whose camera
   *  distance is within `relFullRatio` of its own orbital radius (distToMoon /
   *  |moonPos − parentPos|) releases the gate fully — you are inside its
   *  neighborhood, so it shows on its photometric merits however small the
   *  parent's disc has shrunk behind you. Beyond `relZeroRatio` the gate holds
   *  (a moon viewed from outside its orbit shell stays gated). This is what
   *  keeps an outbound irregular (Ananke/Elara) from a long dead zone: the
   *  parent's disc closes the gate long before the tiny moon's disc resolves.
   *  Tuned against the two sweeps in moonDots.test.ts PLUS a temporal
   *  constraint no sweep measures: the ramp must be wide enough (≥ 0.1 of the
   *  orbit radius) that a moon crossing the boundary — or a ship flying past
   *  it — FADES over dozens of frames instead of blinking at warp. A narrower
   *  window scores a better dead-zone trough (0.59/0.60 reaches ≈ 0.29 vs
   *  0.50/0.60's ≈ 0.22, Ananke H900 tightest) but is a step in disguise.
   *  relZeroRatio is pinned at 0.60 by the static sweep (release ≤ 0.05 from
   *  every vantage outside 1.6× a moon's orbit radius, i.e. ratio ≥ 0.6);
   *  raising it leaks dots into far views, lowering relFullRatio further
   *  erodes the trough. */
  relFullRatio: number;
  relZeroRatio: number;
  /** Texture upgrade-on-approach (feature B): re-render a procedural moon sharper
   *  once its disc diameter passes this many screen px. */
  texUpgradeDiscPx: number;
}

export const MOON_DOT_PARAMS: MoonDotParams = {
  magZeroPoint: -25.64,
  albedoMin: 0.15,
  albedoMax: 0.7,
  albedoGain: 1.0,
  magCeiling: 1.0,
  sizeMaxPx: 4.2,
  fadeStartPx: 3.5,
  fadeEndPx: 10.0,
  discMatchLum: 0.6,
  shrinkToDisc: true,
  targetMinIntensity: 0.04,
  faintExtendMag: 1.6,
  systemEdgeFadeFrac: 0.15,
  parentGateStartPx: 8,
  parentGateFullPx: 22,
  relFullRatio: 0.5,
  relZeroRatio: 0.6,
  // Deck arrivals park a moon's disc at ~87 px (the 5° standoff), so the
  // threshold sits below that: arriving at a procedural moon sharpens it.
  texUpgradeDiscPx: 80,
};

/**
 * On-screen disc DIAMETER (px) of a sphere of rendered radius r at distance
 * `distAU`, using the true-silhouette tangent angle (matches `discRadiusPx` in
 * PlanetLabels, so the dot's handoff and the label offset agree).
 */
export function discDiameterPx(
  renderedRadiusAU: number,
  distAU: number,
  fovDeg: number,
  viewportHpx: number,
): number {
  const r = renderedRadiusAU;
  const halfFovTan = Math.tan((fovDeg * DEG2RAD) / 2);
  const tangentSq = distAU * distAU - r * r;
  const tangent = Math.sqrt(Math.max(tangentSq, r * r * 1e-12));
  return (r / (tangent * halfFovTan)) * viewportHpx;
}

/**
 * Albedo proxy from a catalog tint: the tint's Rec.709 luminance clamped to a
 * plausible geometric-albedo band, times a gain. Keeps the flux catalog-driven
 * without a new albedo table — tint luminance correlates well enough.
 */
export function albedoProxyFromColor(hexColor: number, params: MoonDotParams = MOON_DOT_PARAMS): number {
  const r = ((hexColor >> 16) & 0xff) / 255;
  const g = ((hexColor >> 8) & 0xff) / 255;
  const b = (hexColor & 0xff) / 255;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return clamp(lum, params.albedoMin, params.albedoMax) * params.albedoGain;
}

/**
 * Hue-only chromaticity of a catalog tint (max channel = 1). The dot's screen
 * brightness comes from the magnitude model, so the colour must carry hue only —
 * re-applying the tint's darkness would count it twice (once in the albedo → flux
 * → magnitude, once in the raw RGB).
 */
export function chromaticityRGB(
  hexColor: number,
  out: { r: number; g: number; b: number },
): { r: number; g: number; b: number } {
  const r = ((hexColor >> 16) & 0xff) / 255;
  const g = ((hexColor >> 8) & 0xff) / 255;
  const b = (hexColor & 0xff) / 255;
  const m = Math.max(r, g, b, 1e-6);
  out.r = r / m;
  out.g = g / m;
  out.b = b / m;
  return out;
}

/**
 * Illuminated fraction seen by the observer (Lambert-ish): 1 at full phase, 0 at
 * new. `phaseCos` = cosine of the Sun–moon–observer angle.
 */
export function phaseIllumination(phaseCos: number): number {
  return Math.max(0, (1 + phaseCos) / 2);
}

/**
 * Apparent magnitude of the render-proxy: flux ∝ albedo · (R/Δ)² · illum / r_sun².
 * `illum` folds phase and eclipse dimming. Returns +Infinity when nothing is lit
 * (illum 0) or geometry is degenerate — the dot is then invisible.
 */
export function moonDotMagnitude(
  renderedRadiusAU: number,
  distAU: number,
  sunDistAU: number,
  illum: number,
  albedoProxy: number,
  params: MoonDotParams = MOON_DOT_PARAMS,
): number {
  if (illum <= 0 || albedoProxy <= 0 || renderedRadiusAU <= 0 || distAU <= 0 || sunDistAU <= 0) {
    return Infinity;
  }
  const rOverDelta = renderedRadiusAU / distAU;
  const flux = (albedoProxy * rOverDelta * rOverDelta * illum) / (sunDistAU * sunDistAU);
  return params.magZeroPoint - 2.5 * Math.log10(flux);
}

export interface MoonDotVisual {
  /** Star-visible contribution before the crossfades, with the nav-target floor
   *  applied. Diagnostic only: the parent-dominance gate (`parentFade`) is kept
   *  OUT of this field — the gate, the disc crossfade, and the system-edge fade
   *  all compose in `alpha`, not here. */
  intensity: number;
  /** Final per-vertex GPU alpha. Non-target: intensityStar · parentFade ·
   *  (1 − crossfade) · systemFade. Nav target: max(intensityStar · parentFade,
   *  targetMinIntensity) · (1 − crossfade) · systemFade — the floor survives the
   *  parent gate closing (the outbound dead-zone fix) but still fades with the
   *  disc handoff and the system edge. */
  alpha: number;
  /** Point size (CSS px), already shrunk toward the disc if enabled. */
  sizePx: number;
  /** Colour brightness scalar (multiplies the moon's chromaticity). */
  brightness: number;
  /** Apparent magnitude (diagnostic; +Infinity when unlit). */
  magnitude: number;
}

/**
 * Full per-frame visual for one moon dot. Composition order is deliberate and
 * test-pinned: star-scale brightness/size/alpha from the shared mapping → extend
 * the faint-end alpha below the catalog limit toward zero → floor the nav
 * target's contribution only where there is real flux → multiply the disc-handoff
 * crossfade and the system-edge fade.
 */
export function moonDotVisual(
  renderedRadiusAU: number,
  distAU: number,
  sunDistAU: number,
  phaseCos: number,
  albedoProxy: number,
  shadeFraction: number,
  discPx: number,
  isTarget: boolean,
  systemFade: number,
  parentFade: number,
  starFaintLimitMag: number,
  params: MoonDotParams = MOON_DOT_PARAMS,
  starMapping: StarPointMapping = STAR_POINT_MAPPING,
): MoonDotVisual {
  const illum = phaseIllumination(phaseCos) * Math.max(0, shadeFraction);
  const magnitude = moonDotMagnitude(renderedRadiusAU, distAU, sunDistAU, illum, albedoProxy, params);
  const hasFlux = Number.isFinite(magnitude);

  // Star-scale brightness + size + faint-end alpha — what a star of this
  // magnitude gets, with the bright end held at the scene ceiling: the planets
  // are tonemapped, so the point scale must compress with them or a close
  // Galilean (genuinely mag −5) out-renders its own parent.
  const effectiveMag = Math.max(magnitude, params.magCeiling);
  const star = starPointVisual(effectiveMag, starFaintLimitMag, starMapping);

  // Extend the faint-end alpha below the catalog limit toward zero. At the limit
  // the star floor is faintMinAlpha and this multiplier is 1, so the two meet
  // continuously; a dimmer dot fades on to nothing over faintExtendMag.
  const extend =
    magnitude <= starFaintLimitMag
      ? 1
      : clamp(1 - (magnitude - starFaintLimitMag) / params.faintExtendMag, 0, 1);
  const intensityStar = hasFlux ? star.alpha * extend : 0;

  // Diagnostic `intensity`: the floored star contribution. The nav-target floor
  // is applied here (only where there is real flux to floor — never conjures a
  // dot on the unlit side), but the parent gate and the crossfades stay OUT —
  // they compose in `alpha` below.
  let intensity = intensityStar;
  if (isTarget && hasFlux && illum > 0) {
    intensity = Math.max(intensity, params.targetMinIntensity);
  }

  // Disc handoff. `t` runs 0→1 as the disc grows across the window; alpha fades
  // out over the whole window, while brightness ramps to the disc's estimated
  // tonemapped luminance over the first ~60% — so by the time the point is
  // dying it is no brighter than the disc it uncovers. Without the luminance
  // ramp the point dies at full star brightness against a still-dim few-pixel
  // disc: bright dot, then nothing, then a faint moon.
  const t = smoothstep(params.fadeStartPx, params.fadeEndPx, discPx);
  // The parent-dominance gate multiplies the star term but NOT the nav-target
  // floor: the moon you are flying at keeps its floor even as the parent's disc
  // shrinks behind you (outbound irregulars — the dead-zone fix). The disc
  // crossfade and the system-edge fade still apply to both branches, so a
  // resolved or edge-of-system target still fades out honestly.
  const gatedStar = intensityStar * parentFade;
  const floored =
    isTarget && hasFlux && illum > 0
      ? Math.max(gatedStar, params.targetMinIntensity)
      : gatedStar;
  const alpha = floored * (1 - t) * clamp(systemFade, 0, 1);
  const discLum = params.discMatchLum * Math.min(albedoProxy, 1) * illum;
  const brightness = lerp(star.brightness, discLum, Math.min(1, t / 0.6));

  // Cap the point size below the star mapping's top end, and shrink toward a
  // smaller disc across the crossfade; `min` guarantees a faint point is never
  // grown toward a big disc.
  let sizePx = Math.min(star.sizePx, params.sizeMaxPx);
  if (params.shrinkToDisc) {
    sizePx = Math.min(sizePx, lerp(sizePx, discPx, t));
  }

  return { intensity, alpha, sizePx, brightness, magnitude };
}

/**
 * System-edge fade factor for a system whose dots are visible: 0 at the outer
 * visibility threshold, ramping to 1 over the last `systemEdgeFadeFrac` of the
 * threshold distance as the player moves inward. Keyed off the same
 * player-distance/threshold pair the mesh visibility gate uses, so the dots
 * fade in exactly as the system turns on.
 */
export function systemEdgeFade(
  distToPlayerAU: number,
  thresholdAU: number,
  params: MoonDotParams = MOON_DOT_PARAMS,
): number {
  if (params.systemEdgeFadeFrac <= 0 || thresholdAU <= 0) return 1;
  return clamp((thresholdAU - distToPlayerAU) / (thresholdAU * params.systemEdgeFadeFrac), 0, 1);
}

/**
 * Parent-dominance fade with proximity release: the greater of two terms.
 *
 * Gate: 0 while the parent planet's own disc is at or below parentGateStartPx
 * (the system is dot-scale — no moon dots beside a dot-sized planet), ramping to
 * 1 at parentGateFullPx where the planet unambiguously anchors the scene.
 *
 * Release: 1 when the camera is within relFullRatio of the moon's own orbital
 * radius (`proximityRatio = distToMoon / moonOrbitR`), ramping to 0 by
 * relZeroRatio. A moon you are inside the neighborhood of shows on its
 * photometric merits regardless of how small the parent has become; a moon
 * viewed from outside its orbit shell stays gated. Without this an outbound
 * irregular sits in a dead zone — the parent's disc closes the gate long before
 * the tiny moon's own disc resolves.
 *
 * `max` of the two so either condition alone lights the dot. proximityRatio
 * defaults to Infinity (release 0 → shipped gate-only behavior); any non-finite
 * or negative ratio is treated as Infinity too, so NaN never reaches the `max`.
 */
export function parentDominanceFade(
  parentDiscPx: number,
  proximityRatio = Infinity,
  params: MoonDotParams = MOON_DOT_PARAMS,
): number {
  const gate = smoothstep(params.parentGateStartPx, params.parentGateFullPx, parentDiscPx);
  const ratio = proximityRatio >= 0 ? proximityRatio : Infinity;
  const release = 1 - smoothstep(params.relFullRatio, params.relZeroRatio, ratio);
  return Math.max(gate, release);
}

/**
 * Which moon a frame's texture upgrade-on-approach lands on: the first visible
 * moon whose disc has passed the threshold AND whose procedural texture can
 * actually be sharpened (eligible), or −1 for none. One successful upgrade per
 * frame; an ineligible or sub-threshold moon does not consume the slot (so an
 * already-sharp/photo/CPU-painted moon can't starve a later eligible one).
 */
export function pickMoonTextureUpgrade(
  candidates: { discPx: number; eligible: boolean }[],
  params: MoonDotParams = MOON_DOT_PARAMS,
): number {
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (c.discPx > params.texUpgradeDiscPx && c.eligible) return i;
  }
  return -1;
}
