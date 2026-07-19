import * as THREE from 'three';

import { SUN_WHITEOUT_SLAM_EDGE } from '../shared/shaders/sun';
import { SUN_DATA } from './planets/planetData';

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
 * Whether a solar occluder has the geometry needed to reveal the corona.
 * Annular eclipses deliberately return zero: even 99% area coverage still
 * leaves photosphere visible all the way around, so a totality corona would be
 * physically wrong. Very large foreground planets also fade out of this
 * treatment; their occultations keep the ordinary glare response instead.
 */
export function eclipseOccluderLikeness(occluderToSunRadiusRatio: number): number {
  // Ratio 1 is a deliberate binary boundary: an occluder smaller than the Sun
  // (annular geometry) leaves a photosphere ring all the way around, which must
  // stay blinding — so it gets no corona at all rather than a faded one. Real
  // second contact is abrupt too. The cost is a one-frame corona pop if an
  // occluder's angular size grows through exactly Sun-sized mid-flight; that
  // rare case is accepted rather than softened into a physically wrong reveal.
  if (!(occluderToSunRadiusRatio >= 1)) return 0;
  const sunToOccluderRatio = 1 / occluderToSunRadiusRatio;
  return THREE.MathUtils.smoothstep(sunToOccluderRatio, 0.35, 0.7);
}

/** Radius of an angular source projected onto a plane along the sightline. */
export function projectedSourceRadiusAtPlane(
  sourceRadius: number,
  sourceDistance: number,
  planeDistance: number,
): number {
  if (!(sourceRadius > 0) || !(sourceDistance > 0) || !(planeDistance > 0)) return 0;
  return sourceRadius * THREE.MathUtils.clamp(planeDistance / sourceDistance, 0, 1);
}

/**
 * One-frame update for the short optical overshoot when the Sun emerges from
 * an occluder. The impulse depends on visibility rise-rate, so it is stable
 * across frame rates; the stored flash then decays exponentially.
 */
export function advanceSunEmergenceFlash(input: {
  previousVisibleFraction: number;
  visibleFraction: number;
  flash: number;
  dt: number;
  eligible: boolean;
}): number {
  const dt = Math.max(input.dt, 0);
  const decayed = THREE.MathUtils.clamp(input.flash, 0, 1) * Math.exp(-dt / 0.38);
  if (!input.eligible || !(dt > 0)) return decayed;

  const previous = THREE.MathUtils.clamp(input.previousVisibleFraction, 0, 1);
  const current = THREE.MathUtils.clamp(input.visibleFraction, 0, 1);
  const riseRate = Math.max(current - previous, 0) / dt;
  if (!(riseRate > 0) || previous >= 0.98) return decayed;

  const speed = THREE.MathUtils.smoothstep(riseRate, 0.12, 1.4);
  const uncoveredEnergy = Math.sqrt(1 - previous);
  return Math.max(decayed, speed * uncoveredEnergy);
}

/**
 * Proximity whiteout — the approach's final act. Surface brightness does not
 * fall with distance, so once the photosphere fills the frame no camera or eye
 * holds detail: adaptation loses and the view bleaches to a full white screen.
 * 0 beyond 2.6 solar radii (the granulation study tier lives there), climbing
 * to ~0.99 at the 1.2-radii governor hover, pinned 1 just before contact so the
 * crossing meets the interior side already saturated.
 */
export function sunWhiteoutFraction(distanceSolarRadii: number): number {
  if (!(distanceSolarRadii > 0)) return 1;
  return 1 - THREE.MathUtils.smoothstep(distanceSolarRadii, 1.12, 2.6);
}

/**
 * Opacity of the DOM chrome flood — the blaze spilling over the HUD itself.
 * Gated on the same slam edge as the shader's radiance, so the menus stay
 * crisp through the whole approach and only wash out in the final act, in
 * step with the scene going full white. Capped well below 1: the cockpit
 * must stay findable (and clickable — the flood never takes pointer events)
 * inside the blaze.
 */
export function sunGlareFloodOpacity(whiteout: number): number {
  return 0.65 * THREE.MathUtils.smoothstep(whiteout, SUN_WHITEOUT_SLAM_EDGE, 1);
}

/**
 * Whiteout handoff below the photosphere, driven by submersion (centre
 * distance / radius, 1 at the surface). The crossing itself stays saturated
 * white — continuous with sunWhiteoutFraction at contact — and the molten
 * interior current only emerges as depth pulls this back down; past
 * half-submersion the ember dive owns the view.
 */
export function sunInteriorWhiteout(submersion: number): number {
  return THREE.MathUtils.smoothstep(submersion, 0.55, 0.92);
}

/** Fastest sim rate the Sun's display rotation follows: 6 simulated hours
 *  per real second (a full Carrington turn in ~100 s of watching). Above
 *  this the yr/s presets would strobe the face. */
export const SUN_ROTATION_MAX_RATE = 21_600;

/** One Carrington rotation of the display clock, in milliseconds. */
export const SUN_ROTATION_PERIOD_MS =
  (360 / SUN_DATA.primeMeridianRateDegPerDay) * 86_400_000;

/**
 * Advance the Sun's display-rotation clock toward the sim clock. The IAU
 * spin is kept exact at everyday rates, but the planets' duty to absolute
 * phase (their continents face the Sun at a UTC instant) does not bind the
 * Sun — its face is unanchored — so under extreme time warp its rotation is
 * rate-capped instead of strobing. Whole Carrington rotations are folded
 * out of any lag first (an identical face, so the fold is invisible): a
 * hard time jump lands at most half a turn away and the visible catch-up
 * drift resolves within a minute of real time.
 */
export function advanceSunRotationClock(
  clockUtcMs: number,
  targetUtcMs: number,
  dtSeconds: number,
): number {
  if (!Number.isFinite(clockUtcMs)) return targetUtcMs;
  let next = clockUtcMs
    + Math.trunc((targetUtcMs - clockUtcMs) / SUN_ROTATION_PERIOD_MS) * SUN_ROTATION_PERIOD_MS;
  const maxStepMs = SUN_ROTATION_MAX_RATE * Math.max(dtSeconds, 0) * 1000;
  next += THREE.MathUtils.clamp(targetUtcMs - next, -maxStepMs, maxStepMs);
  return next;
}

/**
 * The virtual white-light solar filter for the close-up study view, 0 (off)
 * to 1 (fully on). Scene exposure alone cannot make the photosphere legible:
 * the bloom pass reads the raw HDR frame BEFORE exposure, so a stopped-down
 * camera still lets the disc's ~3.8 HDR radiance flood granulation, the
 * sunspot two-tone, and the limb's prominences with its own glow. Real solar
 * photography cuts the light ahead of the optics; this is that filter. The
 * photosphere shader dims its radiance by it (flares and prominences pierce
 * deliberately), and targetSunExposure opens the camera back up in step.
 * The caller releases it with the whiteout so the final approach stays a
 * blaze.
 */
export function sunStudyFilterFraction(input: SunExposureInput): number {
  if (!(input.projectedRadiusNdc > 0) || input.visibleFraction <= 0) return 0;
  // Centre falloff is measured in DISC RADII, not absolute NDC: a zoomed
  // limb close-up can sit several NDC off-centre while the photosphere still
  // fills half the frame — exactly the pose where a disengaged filter would
  // let the disc bloom back over the prominences. Past ~1.6 radii the disc
  // is genuinely leaving the frame and the blaze returns.
  const centreRadii = input.centerDistanceNdc / Math.max(input.projectedRadiusNdc, 1);
  const centreResponse = 1 - THREE.MathUtils.smoothstep(centreRadii, 1.0, 1.6);
  const visibleEnergy = Math.pow(THREE.MathUtils.clamp(input.visibleFraction, 0, 1), 0.38);
  // A long engagement band: the blaze hands off to the filtergram gradually
  // across most of the approach — white point, warming golden ball, orange
  // disc — instead of snapping palettes over a few camera lengths. Bloom
  // still floods the half-engaged middle of the band, but there the disc is
  // small enough that flooding IS the ordinary blaze look.
  return THREE.MathUtils.smoothstep(input.projectedRadiusNdc, 0.2, 0.85)
    * centreResponse * visibleEnergy;
}

/**
 * Deterministic flare schedule for one active-region site (periods/seeds live
 * in SUN_ACTIVE_REGIONS). Time is the Sun shader's own clock — real seconds,
 * not sim time. Each period-long cycle hashes to an amplitude and most cycles
 * stay dark, so a flare reads as an event rather than a strobe; the envelope
 * rises in under a second and decays over roughly a tenth of the period.
 */
export function sunFlareEnvelope(
  timeSeconds: number,
  periodSeconds: number,
  seed: number,
): number {
  if (!(periodSeconds > 0) || !Number.isFinite(timeSeconds)) return 0;
  const x = timeSeconds / periodSeconds + seed;
  const cycle = Math.floor(x);
  const phase = x - cycle;
  // Integer hash (imul keeps it exact across platforms — no transcendentals).
  let n = Math.imul(cycle + 0x9e3779b9, 0x85ebca6b)
    ^ Math.imul(Math.round(seed * 8192) + 0x165667b1, 0xc2b2ae35);
  n = Math.imul(n ^ (n >>> 15), 0x27d4eb2f);
  n = (n ^ (n >>> 13)) >>> 0;
  const amp = THREE.MathUtils.smoothstep(n / 4294967296, 0.55, 0.95);
  const rise = THREE.MathUtils.smoothstep(phase, 0, 0.012);
  const decay = Math.exp(-Math.max(phase - 0.012, 0) * 26);
  return amp * rise * decay;
}

/**
 * Slow prominence-eruption cycle, 0 (quiescent) to 1 (peak lift-off). Real
 * prominences hang quiescent for days, then destabilise: the arch swells and
 * rises over hours, partially detaches, and the material drains back down
 * the loop legs (coronal rain). Compressed here to a minutes-scale cycle on
 * the Sun shader's own clock so a visitor can watch one happen: a gated
 * cycle swells in over ~a third of the period, peaks, and lets go. The
 * shader maps the envelope to loop height/thickness/fade and colour cooling.
 */
function prominenceCycleState(timeSeconds: number): { amp: number; phase: number } {
  const period = 160;
  const seed = 0.17;
  if (!Number.isFinite(timeSeconds)) return { amp: 0, phase: 0 };
  const x = timeSeconds / period + seed;
  const cycle = Math.floor(x);
  const phase = x - cycle;
  // Same platform-exact integer hash as the flare schedule; roughly half the
  // cycles stay quiescent so an eruption reads as an occasion.
  let n = Math.imul(cycle + 0x9e3779b9, 0x85ebca6b) ^ 0x2545f491;
  n = Math.imul(n ^ (n >>> 15), 0x27d4eb2f);
  n = (n ^ (n >>> 13)) >>> 0;
  return { amp: THREE.MathUtils.smoothstep(n / 4294967296, 0.35, 0.8), phase };
}

export function sunProminenceEruption(timeSeconds: number): number {
  const { amp, phase } = prominenceCycleState(timeSeconds);
  const swell = THREE.MathUtils.smoothstep(phase, 0.05, 0.42);
  const release = 1 - THREE.MathUtils.smoothstep(phase, 0.55, 0.78);
  return amp * swell * release;
}

/**
 * Ejected plasma for the same cycle: not all the lifted mass rains back —
 * as the arch lets go (phase 0.55) a cloud detaches, accelerates away,
 * expands, and fades. travel is 0 (just detached) → 1 (gone); visibility
 * gates the mesh. Quiet cycles eject nothing.
 */
export function sunProminenceEjecta(
  timeSeconds: number,
): { travel: number; visibility: number } {
  const { amp, phase } = prominenceCycleState(timeSeconds);
  const t = THREE.MathUtils.clamp((phase - 0.55) / 0.42, 0, 1);
  // Ease-in: slow lift-off, accelerating escape.
  const travel = t * t;
  const visibility = amp * THREE.MathUtils.smoothstep(t, 0, 0.12)
    * (1 - THREE.MathUtils.smoothstep(t, 0.72, 1));
  return { travel, visibility };
}

/**
 * Coronal-rain envelope for the same cycle: as the eruption lets go, the
 * lifted material condenses and streams back down the loop legs, so the
 * rain rises exactly where the eruption envelope releases (phase 0.55–0.78)
 * and keeps falling on the re-formed loops a while after.
 */
export function sunProminenceRain(timeSeconds: number): number {
  const { amp, phase } = prominenceCycleState(timeSeconds);
  return amp * THREE.MathUtils.smoothstep(phase, 0.5, 0.64)
    * (1 - THREE.MathUtils.smoothstep(phase, 0.86, 0.98));
}

/**
 * Artist-bounded analytic metering for the one known extreme light source.
 * Small distant Suns still make the camera react, while a close/zoomed disc
 * can pull exposure down by at most ~1.51 stops in normal framing and ~2 stops
 * for an extreme full-frame photosphere close-up. Totality recovers to neutral.
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
  const metered = THREE.MathUtils.lerp(1, 0.35, signal);
  // At an extreme close approach the study filter (sunStudyFilterFraction)
  // cuts the photosphere's radiance in the shader, so the camera opens back
  // up the way a filtered solar telescope meters: exposure RISES toward 0.9
  // as the filter engages. Structure legibility comes from the filter, not
  // from stopping down — bloom reads the raw pre-exposure frame, so only the
  // filter can stop the disc from flooding its own features.
  return THREE.MathUtils.lerp(metered, 0.9, sunStudyFilterFraction(input));
}
