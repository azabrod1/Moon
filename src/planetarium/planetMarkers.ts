/**
 * Planet marker visual policy: how the far-away beacon sprite for each planet
 * scales and dims with viewing circumstance.
 *
 * The markers are a deliberate fiction — real planets at these distances are
 * dots or invisible — but the fiction should follow the sky's real hierarchy:
 * a marker's size and brightness track its apparent brightness (albedo ·
 * (R/Δ)² / r_sun², the same proxy the moon dots use), compressed onto a
 * magnitude ramp with a floor so nothing ever vanishes and a full-scale end so
 * nothing ever balloons. Earth seen from Neptune shrinks to a modest pale
 * point; Venus stays prominent from anywhere because it genuinely is; Neptune
 * is always a quiet far-off glint. The floor keeps every planet findable —
 * "realistic dots" is not this policy's job.
 *
 * Pure math, unit-tested; the sprite texture that carries the tint is drawn in
 * PlanetLabels (paint, not policy).
 */

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const lerp = (x: number, y: number, t: number) => (1 - t) * x + t * y;

export interface PlanetMarkerParams {
  /** Apparent-magnitude zero point of the flux proxy — the same physically
   *  derived value the moon dots calibrated (moonDots.ts), so both policies
   *  speak one magnitude scale. With true planet radii it lands near real
   *  apparent magnitudes (Neptune from Earth ≈ +8 real, ≈ +8.7 here). */
  magZeroPoint: number;
  /** Marker-tint luminance → albedo proxy clamp band (same recipe as the
   *  moon dots' catalog-tint proxy). */
  albedoMin: number;
  albedoMax: number;
  /** Magnitude ramp: at or below `magBright` the marker renders at full size
   *  and brightness; at or above `magFaint` it sits on the floor. Between the
   *  two it slides linearly in magnitude (log flux — already compressive). */
  magBright: number;
  magFaint: number;
  /** Floor of the size multiplier — the faint end renders at this fraction of
   *  full scale. Never 0: markers are beacons, not realism. */
  sizeMinScale: number;
  /** Floor of the brightness multiplier (sprite color scalar at the faint end). */
  brightnessMin: number;
  /** Sprite scale at full size (screen-proportional units — the sprite renders
   *  with sizeAttenuation off; the pre-policy constant was 0.03 for every
   *  planet at every distance). */
  baseScale: number;
}

export const PLANET_MARKER_PARAMS: PlanetMarkerParams = {
  magZeroPoint: -25.64,
  albedoMin: 0.15,
  albedoMax: 0.7,
  magBright: -2.5,
  magFaint: 7.0,
  sizeMinScale: 0.4,
  brightnessMin: 0.5,
  baseScale: 0.027,
};

/**
 * Albedo proxy from the marker tint: Rec.709 luminance clamped to a plausible
 * geometric-albedo band. Same shape as the moon dots' proxy — tint luminance
 * correlates well enough that no albedo table is needed.
 */
export function markerAlbedoProxy(hexColor: number, p: PlanetMarkerParams = PLANET_MARKER_PARAMS): number {
  const r = ((hexColor >> 16) & 0xff) / 255;
  const g = ((hexColor >> 8) & 0xff) / 255;
  const b = (hexColor & 0xff) / 255;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return clamp(lum, p.albedoMin, p.albedoMax);
}

/**
 * Apparent magnitude of the flux proxy: albedo · (R/Δ)² / r_sun². No phase
 * term — markers are navigational beacons, and a Lambert phase would black out
 * Mercury/Venus seen from outside their orbits for half of every synodic
 * period. Returns +Infinity on degenerate geometry.
 */
export function markerMagnitude(
  radiusAU: number,
  distAU: number,
  sunDistAU: number,
  albedoProxy: number,
  p: PlanetMarkerParams = PLANET_MARKER_PARAMS,
): number {
  if (radiusAU <= 0 || distAU <= 0 || sunDistAU <= 0 || albedoProxy <= 0) return Infinity;
  const rOverDelta = radiusAU / distAU;
  const flux = (albedoProxy * rOverDelta * rOverDelta) / (sunDistAU * sunDistAU);
  return p.magZeroPoint - 2.5 * Math.log10(flux);
}

export interface PlanetMarkerVisual {
  /** Sprite scale to apply (screen-proportional; baseScale × the size ramp). */
  sizeScale: number;
  /** Sprite color scalar (dims the tinted texture at the faint end). */
  brightness: number;
}

/**
 * Size + brightness for one marker this frame. Both slide on the same
 * magnitude ramp; +Infinity (degenerate geometry) lands on the floor.
 * Pass `out` to reuse a result object (per-frame callers — no allocation).
 */
export function markerVisual(
  magnitude: number,
  p: PlanetMarkerParams = PLANET_MARKER_PARAMS,
  out: PlanetMarkerVisual = { sizeScale: 0, brightness: 0 },
): PlanetMarkerVisual {
  const t = Number.isFinite(magnitude)
    ? clamp((magnitude - p.magBright) / (p.magFaint - p.magBright), 0, 1)
    : 1;
  out.sizeScale = p.baseScale * lerp(1, p.sizeMinScale, t);
  out.brightness = lerp(1, p.brightnessMin, t);
  return out;
}
