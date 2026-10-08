/**
 * The Sun's light, as the planetarium's surfaces and air receive it: one
 * source for the colour, the intensity and the baseline every absolute
 * threshold in scene units rides on.
 *
 * The light is NEUTRAL. The planet maps are albedo under white light, and the
 * warmth of a low Sun is computed per pixel from the Sun's own path through
 * the air (surfaceShading's SUN_PATH), so a tinted light would warm every
 * body twice and whiten nothing: under the cream it replaced, Jupiter's zones
 * read orange-cream and Saturn butterscotch where Cassini shows pale white and
 * pale gold, and no cloud top could reach white. A body whose real colour the
 * tint had been supplying — the Moon, whose map is nearly grey — takes that
 * colour in its own albedo grade (world/albedoGrade) instead.
 *
 * The intensity is the cream's luminance at its authored intensity of 3
 * (Rec.709 of linear fff5e0 is 0.9194, so 2.7583) times SUN_LIGHT_BASELINE,
 * the baseline brightness: how far above the picture graded at exposure 1 the
 * sunlit world sits. The baseline is applied here, as the Sun's intensity,
 * and not as the tone map's exposure, because exposure brightens everything
 * — the stars tuned under the sky-first rule, the Sun's glow (the bloom is
 * composited inside the tone map), orbit lines, markers, city lights, the
 * night side — and each would then need its own compensation. Scaling the
 * light scales exactly what the Sun lights: the surfaces through three's
 * point light, the air through AIRLIGHT_SCALE (derived from these constants),
 * the moonlight on Earth's ground through that bridge, and the planetshine
 * through its gain, which reads the baseline. Everything self-luminous keeps
 * its authored radiance by construction. The thresholds authored in scene
 * units — the bloom's high pass and the width of its knee, the sea's glint cap
 * and the beam's knee and cap — multiply by the baseline where they are
 * defined, so the sunlit white sits under the bloom's line by the same margin
 * it did.
 *
 * The decay is 0.3, not the physical 2: at inverse-square the outer planets
 * would be unreadable, so the falloff is authored, and anything that has to
 * agree photometrically with the lit ground (a scattering table baked at unit
 * irradiance) uses THIS law; a test holds the two together.
 */
import * as THREE from 'three';
import type { RGB } from './world/atmosphereModel';

/** The baseline brightness of the sunlit world, in stops over the picture
 *  graded at exposure 1: 1.4 is half a stop. Judged on a sheet of every body
 *  beside photographs (Earth at DSCOVR's own clock, the Moon, Mars, Jupiter,
 *  Saturn) at 1, 1.4 and 2: at 2 the Moon and Jupiter's zones go chalky. */
export const SUN_LIGHT_BASELINE = 1.4;

/** The light's colour, sRGB: neutral. */
export const SUN_LIGHT_COLOR = 0xffffff;

/** The luminance the surfaces received from the cream Sun at intensity 3,
 *  which the neutral light matches at baseline 1. */
export const SUN_LIGHT_AUTHORED_LUMINANCE = 2.7583;

export const SUN_LIGHT_INTENSITY = SUN_LIGHT_AUTHORED_LUMINANCE * SUN_LIGHT_BASELINE;

export const SUN_LIGHT_DECAY = 0.3;

/** The light's colour in the linear working space, decoded the way three
 *  decodes it for the light itself. */
export const SUN_LIGHT_LINEAR: RGB = (() => {
  const c = new THREE.Color(SUN_LIGHT_COLOR);
  return [c.r, c.g, c.b];
})();

/** Rec.709 luminance of a linear colour. */
export function luminanceOf(rgb: RGB): number {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

/** The cream the Sun was authored in before it went neutral (sRGB fff5e0),
 *  as a linear hue of unit luminance: what everything tuned by eye under that
 *  light had been wearing — the moonlight's tint (nightSources), the Moon's
 *  albedo grade (world/albedoGrade). Those keep the colour they were judged
 *  in by carrying this hue themselves, now that the light no longer does. */
export const SUN_LIGHT_AUTHORED_HUE: RGB = (() => {
  const c = new THREE.Color(0xfff5e0);
  const lum = luminanceOf([c.r, c.g, c.b]);
  return [c.r / lum, c.g / lum, c.b / lum];
})();
