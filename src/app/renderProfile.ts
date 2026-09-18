/**
 * The renderer's tone curve, per app mode: one owner for a setting that
 * three's output pass re-reads every frame and the no-float direct path
 * bakes into every program. The planetarium, flight and the compare studio
 * draw through ACES. The Look-inside studio draws through Neutral, which
 * keeps a hot face's hue where ACES turns everything past mid-grey toward
 * white — a molten core reads as gold rather than cream (art, documented
 * where it was asked for: interior/InteriorScene).
 *
 * The switch applies the profile when it brings a mode up, beside the
 * composer it builds for it. Before this the studio set the curve in its own
 * constructor and gave it back in dispose — and main caches every mode and
 * disposes none of them, so one Look inside visit left the whole planetarium
 * on Neutral for the rest of the session, with an exposure loop tuned for
 * ACES. A mode owns its scene; the switch owns the renderer.
 *
 * Exposure is not here: the animation loop is its sole writer and already
 * hands every mode but the planetarium a 1 (main.ts, the near-Sun auto-exposure).
 */
import * as THREE from 'three';

export type AppMode = 'planetarium' | 'moonFlight' | 'volumeCompare' | 'interior';

export const TONE_MAPPING_BY_MODE: Readonly<Record<AppMode, THREE.ToneMapping>> = {
  planetarium: THREE.ACESFilmicToneMapping,
  moonFlight: THREE.ACESFilmicToneMapping,
  volumeCompare: THREE.ACESFilmicToneMapping,
  interior: THREE.NeutralToneMapping,
};

export function toneMappingFor(mode: AppMode): THREE.ToneMapping {
  return TONE_MAPPING_BY_MODE[mode];
}

/** The curve's name, for the bridge and the debug overlay. */
export function toneMappingWord(curve: THREE.ToneMapping): string {
  switch (curve) {
    case THREE.NoToneMapping: return 'none';
    case THREE.LinearToneMapping: return 'linear';
    case THREE.ReinhardToneMapping: return 'reinhard';
    case THREE.CineonToneMapping: return 'cineon';
    case THREE.ACESFilmicToneMapping: return 'aces';
    case THREE.AgXToneMapping: return 'agx';
    case THREE.NeutralToneMapping: return 'neutral';
    default: return String(curve);
  }
}

/**
 * Point the renderer at the mode's curve. Returns whether it changed: the
 * same curve again writes nothing, so a program keyed on it (the direct
 * path's) is not invalidated for nothing.
 */
export function applyRenderProfile(renderer: Pick<THREE.WebGLRenderer, 'toneMapping'>, mode: AppMode): boolean {
  const curve = toneMappingFor(mode);
  if (renderer.toneMapping === curve) return false;
  renderer.toneMapping = curve;
  return true;
}
