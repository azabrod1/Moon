/**
 * A body's presentation grades: the few numbers a surface is DRAWN with that
 * are a look rather than a measurement, in one table, with the URL switches
 * that move them in any build.
 *
 * Three today, all Mars's. The relief's depth — the normal map's scale on the
 * material, which the streamed sectors mirror each frame (PlanetFactory
 * authors it; 0.5 is half the 2.4× the maps are baked at). How much of the
 * air's haze a direct view shows — surfaceShading's SURFACE_HAZE_CLEAR_VIEW
 * rule, where Earth is graded to 0.35 and Mars had no grade: a dusty haze is
 * the look of that planet, but on top of a colour map with its shading
 * removed and a halved relief it is a third flattener. And a contrast gain on
 * the albedo, in log luminance about the body's own typical albedo with every
 * channel scaled alike, so the hue and the saturation stay the map's: the
 * Tianwen-1 mosaic is photometrically corrected — an albedo map, shading
 * removed, which is exactly why the Viking patchwork is gone — and in the
 * mid-latitudes its 5th-to-95th percentile luminance spans 1.9× where the
 * map it replaced spanned 4.0×.
 *
 * Why switches rather than new defaults: a look is judged on a real screen,
 * and this box renders Mars with no haze at all (the atmosphere tables never
 * bake on a software renderer). So each number is a link —
 * `?marsrelief=1&marshaze=0.5&marscontrast=1.5` — the candidates are compared
 * on a phone, and the defaults move to the winner. The table's numbers ARE the
 * shipped picture until then, and a switch alone is a kill switch for its
 * term. In DEV `__moon.surfaceLook('Mars', {…})` moves them live, so a sheet
 * of candidates comes out of one page load.
 *
 * Pure: the URL is read once at module evaluation where one exists, and the
 * parser is a function of the search string, so the rules are tested without
 * a window.
 */

export interface SurfaceLook {
  /** The relief's authored depth: the material's normalScale. */
  relief: number;
  /** How much of the air's haze a direct view shows, 0..1, or null to leave
   *  SURFACE_HAZE_CLEAR_VIEW's number (1, the physics, for a body it does not
   *  name). */
  haze: number | null;
  /** Contrast gain on the albedo in log luminance; 1 is the map as it is. */
  contrast: number;
  /** The linear luminance the contrast turns about: the body's own typical
   *  albedo, so the gain deepens the dark ground and brightens the bright
   *  without moving the body's overall brightness. */
  contrastPivot: number;
}

/** The three numbers a link or the DEV pin may move. */
export type SurfaceLookOverride = Partial<Pick<SurfaceLook, 'relief' | 'haze' | 'contrast'>>;

/** The pivot a body with no entry carries beside its gain of 1, where it is
 *  never read: Mars's, the one body with an entry. */
export const DEFAULT_ALBEDO_PIVOT = 0.18;

/** The shipped picture, per body. A body not named here is drawn as it was:
 *  relief as its factory authors it, haze by SURFACE_HAZE_CLEAR_VIEW, contrast 1. */
export const SURFACE_LOOK: Readonly<Record<string, SurfaceLook>> = {
  // The pivot is the shipped 4K map's median linear luminance between ±45°
  // (0.178, measured on public/textures/4k/mars.v3.webp).
  Mars: { relief: 0.5, haze: null, contrast: 1, contrastPivot: DEFAULT_ALBEDO_PIVOT },
};

/** What a link may ask for. A relief past 4 is facets; a haze past 1 leaves
 *  the physics (the mix it weights is 0..1); a contrast under 0.25 is a flat
 *  map and over 4 is posterised rock. */
const LIMITS: Readonly<Record<keyof SurfaceLookOverride, readonly [number, number]>> = {
  relief: [0, 4],
  haze: [0, 1],
  contrast: [0.25, 4],
};

const KNOBS = ['relief', 'haze', 'contrast'] as const;

/**
 * The switches in a search string: `?<body>relief=`, `?<body>haze=`,
 * `?<body>contrast=` for every body the table names, the body lower-cased
 * (`?marsrelief=1`). A value that is not a finite number is a mistyped link
 * and is ignored; one outside its limits is clamped to them.
 */
export function parseSurfaceLookParams(search: string): Record<string, SurfaceLookOverride> {
  const params = new URLSearchParams(search);
  const out: Record<string, SurfaceLookOverride> = {};
  for (const body of Object.keys(SURFACE_LOOK)) {
    const prefix = body.toLowerCase();
    for (const knob of KNOBS) {
      const raw = params.get(`${prefix}${knob}`);
      if (raw === null || raw.trim() === '') continue;
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;
      const [low, high] = LIMITS[knob];
      (out[body] ??= {})[knob] = Math.min(high, Math.max(low, value));
    }
  }
  return out;
}

/** The overrides in force: the URL's at boot, then whatever the DEV pin set. */
let overrides: Record<string, SurfaceLookOverride> = parseSurfaceLookParams(
  typeof location === 'undefined' ? '' : location.search,
);

/** A body's look as it is drawn now: the table's numbers under the overrides. */
export function surfaceLookOf(body: string): SurfaceLook | undefined {
  const authored = SURFACE_LOOK[body];
  if (!authored) return undefined;
  const over = overrides[body];
  if (!over) return authored;
  return {
    relief: over.relief ?? authored.relief,
    haze: over.haze ?? authored.haze,
    contrast: over.contrast ?? authored.contrast,
    contrastPivot: authored.contrastPivot,
  };
}

/** Move a body's numbers from now on (the DEV pin), clamped like a link's;
 *  a knob set to undefined is left as it is. A body the table does not name
 *  has no look to move, and the call says so. */
export function setSurfaceLookOverride(body: string, override: SurfaceLookOverride): SurfaceLook | undefined {
  if (!SURFACE_LOOK[body]) return undefined;
  const current = overrides[body] ?? {};
  for (const knob of KNOBS) {
    const value = override[knob];
    if (value === undefined) continue;
    if (value === null) { delete current[knob]; continue; }
    if (!Number.isFinite(value)) continue;
    const [low, high] = LIMITS[knob];
    current[knob] = Math.min(high, Math.max(low, value));
  }
  overrides[body] = current;
  return surfaceLookOf(body);
}

/** Test seam: back to the table, as a boot with no switches. */
export function resetSurfaceLookForTests(search = ''): void {
  overrides = parseSurfaceLookParams(search);
}

/**
 * The contrast grade, as the shader applies it (surfaceShading's
 * `albedoContrast`): the albedo's linear luminance against the pivot, raised
 * to the gain less one, scales every channel. The reference the GLSL is held
 * to — a gain of 1 returns the albedo exactly, and the pivot maps to itself
 * at every gain.
 */
export function albedoContrast(albedo: readonly [number, number, number], gain: number, pivot: number): [number, number, number] {
  if (gain === 1) return [albedo[0], albedo[1], albedo[2]];
  const luminance = Math.max(0.2126 * albedo[0] + 0.7152 * albedo[1] + 0.0722 * albedo[2], 1e-5);
  const factor = Math.pow(luminance / pivot, gain - 1);
  return [albedo[0] * factor, albedo[1] * factor, albedo[2] * factor];
}
