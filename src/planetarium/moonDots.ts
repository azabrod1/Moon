/**
 * Photometric moon dots: the pure render-proxy photometry behind the sub-pixel
 * moon points.
 *
 * A moon whose drawn disc is smaller than a couple of pixels is invisible as a
 * sphere, yet a real body that bright would still show as a naked-eye point. So a
 * sub-pixel moon renders as a star-scale point at its apparent magnitude, through
 * the same magnitude → brightness/size mapping the starfield uses, and crossfades
 * out as the real mesh disc grows past a few pixels.
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
  /** Disc-handoff crossfade window (rendered disc DIAMETER, screen px): the dot
   *  fades out as the disc grows from START to END. Wide so the disc is already
   *  larger than a bright point before the dot fully dies (no "blazing point
   *  shrinks into a small disc" deflation). The #1 tune-by-eye target. */
  fadeStartPx: number;
  fadeEndPx: number;
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
  /** Texture upgrade-on-approach (feature B): re-render a procedural moon sharper
   *  once its disc diameter passes this many screen px. */
  texUpgradeDiscPx: number;
}

export const MOON_DOT_PARAMS: MoonDotParams = {
  magZeroPoint: -25.64,
  albedoMin: 0.15,
  albedoMax: 0.7,
  albedoGain: 1.0,
  fadeStartPx: 2.5,
  fadeEndPx: 6.0,
  shrinkToDisc: true,
  targetMinIntensity: 0.04,
  faintExtendMag: 1.6,
  systemEdgeFadeFrac: 0.15,
  texUpgradeDiscPx: 96,
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
  /** Star-visible contribution before the disc/edge crossfades, after the
   *  nav-target floor. The floor and the fades compose in this order. */
  intensity: number;
  /** Final per-vertex GPU alpha = intensity · disc crossfade · system-edge fade. */
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
  edgeFade: number,
  starFaintLimitMag: number,
  params: MoonDotParams = MOON_DOT_PARAMS,
  starMapping: StarPointMapping = STAR_POINT_MAPPING,
): MoonDotVisual {
  const illum = phaseIllumination(phaseCos) * Math.max(0, shadeFraction);
  const magnitude = moonDotMagnitude(renderedRadiusAU, distAU, sunDistAU, illum, albedoProxy, params);
  const hasFlux = Number.isFinite(magnitude);

  // Star-scale brightness + size + faint-end alpha — exactly what a star of this
  // magnitude gets. The mapping's clamps cap the bright end, so a dot can never
  // out-render the brightest star treatment (sky-first rule holds).
  const star = starPointVisual(magnitude, starFaintLimitMag, starMapping);

  // Extend the faint-end alpha below the catalog limit toward zero. At the limit
  // the star floor is faintMinAlpha and this multiplier is 1, so the two meet
  // continuously; a dimmer dot fades on to nothing over faintExtendMag.
  const extend =
    magnitude <= starFaintLimitMag
      ? 1
      : clamp(1 - (magnitude - starFaintLimitMag) / params.faintExtendMag, 0, 1);
  let intensity = hasFlux ? star.alpha * extend : 0;

  // Nav-target floor: only where there is real flux to floor (never conjures a
  // dot on the unlit side), and before the crossfades below — so a resolved or
  // edge-of-system target still fades out honestly.
  if (isTarget && hasFlux && illum > 0) {
    intensity = Math.max(intensity, params.targetMinIntensity);
  }

  // Disc handoff: fade the point out as the real disc grows across the window.
  const discFade = 1 - smoothstep(params.fadeStartPx, params.fadeEndPx, discPx);
  const alpha = intensity * discFade * clamp(edgeFade, 0, 1);

  // Shrink a large point toward the disc across the crossfade so the two
  // converge in size; `min` guarantees a faint point is never grown toward a
  // big disc.
  let sizePx = star.sizePx;
  if (params.shrinkToDisc) {
    const blend = smoothstep(params.fadeStartPx, params.fadeEndPx, discPx);
    sizePx = Math.min(sizePx, lerp(sizePx, discPx, blend));
  }

  return { intensity, alpha, sizePx, brightness: star.brightness, magnitude };
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
