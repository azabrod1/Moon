/**
 * A body's albedo grade: a linear colour on its material, multiplying the map
 * the way three's `material.color` always has (no shader, no cost), for a map
 * authored brighter or greyer than the body it stands for.
 *
 * The Moon is the one entry. Its map's area-weighted mean is 0.48 in linear
 * light against a real albedo near 0.12, where Mars's sits at 0.17 against
 * 0.17 and Jupiter's at 0.41 against 0.54: in one calibrated frame holding
 * both (Galileo, 1992) the Moon's disc is half as bright as Earth's, and in
 * the app it was 1.8 times brighter. The physical grade is 0.3 of its linear
 * value, which lands the Earth-and-Moon ratio on Galileo's and brings the
 * maria's contrast against the highlands back. It ships at 0.5 for now: the
 * app's exposure is set for the Sun's light and never opens up for a dark
 * body, so a Moon alone in frame at 0.3 drew as a mid grey (a disc median of
 * 91 against 144 as it was), darker than any photograph of the Moon, which
 * is exposed for the Moon. 0.5 keeps most of that brightness (122) with the
 * cream gone and the contrast back. When an exposure that adapts up for a
 * dark body filling the view exists, the way the night rule adapts the other
 * way, this returns to 0.3 and the two views agree. Its hue is the cream the Sun was
 * authored in before it went neutral (sunLight): the map itself is nearly
 * grey (linear blue over red 0.92), and by colour index the real Moon is
 * warmer (B−V 0.92 against the Sun's 0.65), a warmth the cream light had been
 * supplying and a neutral light does not. So the body keeps the colour it
 * wore, in its own albedo rather than in everyone's Sun.
 *
 * The grade is recorded on the material (userData.albedoGrade) and applied
 * wherever the material's colour is set: at the paint, when the real map
 * replaces the placeholder tint, and at every rung swap of the texture
 * ladder, both of which used to reset the colour to white; and every frame
 * for a moon, whose colour is also its eclipse shade (PlanetariumMode's
 * applyMoonShading writes grade times shade through writeShadedAlbedo, and the
 * streamer mirrors that colour onto the sectors). A streamed sector inherits
 * its globe's at creation. The DEV knob (`__moon.albedoGrade`) overrides a
 * body's grade live for every material it has and every one it makes later,
 * which is how a sheet of candidates comes out of one page load.
 */
import * as THREE from 'three';
import type { RGB } from './atmosphereModel';
import { SUN_LIGHT_AUTHORED_HUE } from '../sunLight';

/** The Moon's grade: 0.5 of the map's luminance, in the cream's hue. 0.3 is
 *  the physical value, held off until the exposure can open up for a dark
 *  body alone in frame (the header). */
export const MOON_ALBEDO_SCALE = 0.5;

export const BODY_ALBEDO_GRADE: Readonly<Record<string, RGB>> = {
  Moon: [
    SUN_LIGHT_AUTHORED_HUE[0] * MOON_ALBEDO_SCALE,
    SUN_LIGHT_AUTHORED_HUE[1] * MOON_ALBEDO_SCALE,
    SUN_LIGHT_AUTHORED_HUE[2] * MOON_ALBEDO_SCALE,
  ],
};

const WHITE: RGB = [1, 1, 1];
/** Every live material of each graded body, for the DEV knob. */
const materialsOf = new Map<string, Set<THREE.Material>>();
/** A DEV override per body (null = the authored grade, undefined = none set). */
const overrides = new Map<string, RGB | null>();

/** The grade a body's materials wear right now. */
export function albedoGradeOf(name: string): RGB {
  const over = overrides.get(name);
  if (over) return over;
  return BODY_ALBEDO_GRADE[name] ?? WHITE;
}

function remember(mat: THREE.Material, name: string): void {
  let set = materialsOf.get(name);
  if (!set) materialsOf.set(name, (set = new Set()));
  if (!set.has(mat)) {
    set.add(mat);
    mat.addEventListener('dispose', () => set.delete(mat));
  }
  (mat.userData as { albedoGrade?: RGB; albedoBody?: string }).albedoBody = name;
}

function writeColor(mat: THREE.Material, rgb: RGB): void {
  const color = (mat as THREE.MeshStandardMaterial).color;
  if (color?.isColor) color.setRGB(rgb[0], rgb[1], rgb[2]);
}

/** Record the body's grade on its material and, unless the material still
 *  wears a placeholder tint the paint will replace (`now` false), apply it. */
export function applyAlbedoGrade(mat: THREE.Material, name: string, now = true): void {
  remember(mat, name);
  if (now) restoreAlbedoGrade(mat);
}

/** Set the material's colour to its body's grade (white for an ungraded body):
 *  the call every site that used to reset the colour to white makes instead. */
export function restoreAlbedoGrade(mat: THREE.Material): void {
  const name = (mat.userData as { albedoBody?: string }).albedoBody;
  writeColor(mat, name ? albedoGradeOf(name) : WHITE);
}

/** The material's colour as the body's grade times a per-frame shade (a
 *  moon's sun-visible fraction, the blood-moon floor): the one write for a
 *  body whose colour is driven every frame, so the shade never erases the
 *  grade and the grade never erases the shade. */
export function writeShadedAlbedo(mat: THREE.Material, name: string, shade: RGB): void {
  const g = albedoGradeOf(name);
  writeColor(mat, [g[0] * shade[0], g[1] * shade[1], g[2] * shade[2]]);
}

/** A sector takes its globe's grade. */
export function inheritAlbedoGrade(from: THREE.Material, to: THREE.Material): void {
  const name = (from.userData as { albedoBody?: string }).albedoBody;
  if (!name) return;
  applyAlbedoGrade(to, name, true);
}

/** DEV: override a body's grade live (`rgb`), or put the authored one back
 *  (`null`); returns the grade in force and how many materials wear it. */
export function devAlbedoGrade(name: string, rgb?: RGB | null): { body: string; grade: RGB; authored: RGB; materials: number } {
  if (rgb !== undefined) {
    if (rgb === null) overrides.delete(name);
    else overrides.set(name, [rgb[0], rgb[1], rgb[2]]);
    for (const mat of materialsOf.get(name) ?? []) {
      // A material still on its placeholder keeps it: the paint applies the grade.
      if ((mat as THREE.MeshStandardMaterial).map) restoreAlbedoGrade(mat);
    }
  }
  return { body: name, grade: albedoGradeOf(name), authored: BODY_ALBEDO_GRADE[name] ?? WHITE, materials: materialsOf.get(name)?.size ?? 0 };
}
