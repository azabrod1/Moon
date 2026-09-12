/**
 * A round, soft-edged dot for stock point materials (the asteroid belt).
 *
 * three's stock points shader fills the whole gl_PointSize square at one
 * alpha, so a dot three or four device pixels wide is a hard square, and a
 * hard square snaps to whole pixels as the camera moves: a band of them along
 * the ecliptic crawls. The starfield and the moon dots carry their own kernel
 * (lensShader.ts lensPointSpriteFragmentGLSL): full alpha out to a fifth of
 * the diameter from the centre, fading to nothing at the rim. This gives a
 * stock material that same profile.
 *
 * Only where a dot is big enough to have a shape. A dot of one device pixel or
 * less is one fragment whose centre sits anywhere within half a pixel of the
 * point's, so a profile read there is a different dimming every frame, which
 * is the flicker this exists to remove; and the sub-pixel energy
 * (pointEnergy.ts) has already given that pixel the light the dot is owed.
 * The profile comes in across the second pixel of size and is whole from two.
 *
 * Chains onto whatever onBeforeCompile the material already carries, and reads
 * the point size after every write to it, the sub-pixel clamp included.
 */
import * as THREE from 'three';
import { POINT_ENERGY_FRAGMENT_ANCHOR, POINT_ENERGY_VERTEX_ANCHOR } from './pointEnergy';

/** Where the fade starts and where it reaches zero, in diameters from the centre. */
export const ROUND_POINT_CORE = 0.2;
export const ROUND_POINT_RIM = 0.5;

/**
 * The alpha factor for a dot `sizePx` framebuffer pixels wide, at a fragment
 * `d` diameters from its centre. The GLSL below mirrors it line for line.
 */
export function roundPointAlpha(sizePx: number, d: number): number {
  const t = Math.min(1, Math.max(0, (d - ROUND_POINT_CORE) / (ROUND_POINT_RIM - ROUND_POINT_CORE)));
  const shape = 1 - t * t * (3 - 2 * t);
  const round = Math.min(1, Math.max(0, sizePx - 1));
  return 1 + (shape - 1) * round;
}

export function augmentPointsMaterialWithRoundDots(mat: THREE.PointsMaterial): void {
  const previous = mat.onBeforeCompile;
  // Extend the key the material already had, as pointEnergy does: three keys
  // a program on its onBeforeCompile source unless told otherwise.
  const previousKey = mat.customProgramCacheKey();
  mat.customProgramCacheKey = () => `${previousKey}|roundPoint`;
  mat.onBeforeCompile = (shader, renderer) => {
    previous?.(shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vRoundPointPx;')
      .replace(POINT_ENERGY_VERTEX_ANCHOR, `vRoundPointPx = gl_PointSize;\n\t${POINT_ENERGY_VERTEX_ANCHOR}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vRoundPointPx;')
      .replace(
        POINT_ENERGY_FRAGMENT_ANCHOR,
        [
          `float roundPointShape = 1.0 - smoothstep(${ROUND_POINT_CORE.toFixed(2)}, ${ROUND_POINT_RIM.toFixed(2)}, length(gl_PointCoord - vec2(0.5)));`,
          `diffuseColor.a *= mix(1.0, roundPointShape, clamp(vRoundPointPx - 1.0, 0.0, 1.0));`,
          POINT_ENERGY_FRAGMENT_ANCHOR,
        ].join('\n\t'),
      );
  };
  mat.needsUpdate = true;
}
