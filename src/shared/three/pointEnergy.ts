/**
 * Display-invariant energy for stock point materials (the asteroid belt).
 *
 * A point smaller than one device pixel still rasterises as a whole pixel:
 * GL clamps gl_PointSize up to 1, so a dot that should cover a quarter of a
 * pixel lands at full opacity. How much light that adds depends on the
 * display: the belt's dots are around one device pixel on a 2× display and
 * half that on a 1× monitor, so the monitor drew the belt three times as
 * bright (a 1.5× supersample used to hide it). The belt's look was authored
 * on 2× displays, so that rendering is the reference: the vertex works out
 * how much light per CSS area the clamp gives the dot here versus on a
 * POINT_ENERGY_REFERENCE_RATIO display and the fragment multiplies the
 * ratio into the alpha, which it then holds at 1. A 2× display is untouched,
 * byte for byte; a denser one (2.5×, where the clamp gives a dot less light
 * than the reference) comes up to match.
 *
 * One thing has to be undone before any of that arithmetic is true. three
 * sizes a stock point from the OUTPUT pixel ratio — `uniforms.size.value =
 * material.size * pixelRatio`, where `pixelRatio` is `renderer.getPixelRatio()`
 * (WebGLMaterials.js) — but the points are rasterised into the SCENE target,
 * whose ratio the graphics-quality levels move independently. Left alone, a
 * supersampled rung draws the dot at the same framebuffer size in a framebuffer
 * whose pixels are two thirds as wide, i.e. two thirds of its CSS size and four
 * ninths of its light. `uPointSceneScale` = sceneRatio / outputRatio is the
 * correction, applied to gl_PointSize before anything reads it, so the dot
 * keeps its CSS size at every rung and the energy below is reckoned against the
 * size it really wants. It is exactly 1 wherever the scene is drawn at the
 * canvas's own ratio.
 *
 * roundPoint.ts's soft profile reads gl_PointSize after this, so it too is now
 * in the scene target's pixels. That is the right unit for it — its ramp is an
 * argument about one FRAGMENT's centre, and the fragments are the target's —
 * but it means the profile's weight is deliberately raster-dependent: the same
 * dot is a part-square at a low rung and fully round from two scene pixels up.
 * The energy above does not compensate for the profile's integral, so a dot
 * sitting on that ramp carries slightly less light where the ramp is partial.
 *
 * Chains onto whatever onBeforeCompile the material already carries (the
 * belt's Sun-glare mask), and injects at anchors every stock points shader
 * has. The star and moon-dot shaders carry their own kernel
 * (lensShader.ts lensPointSpriteFragmentGLSL) and solve this there.
 */
import * as THREE from 'three';

/** The renderer pixel ratio the point décor was authored and tuned at. */
export const POINT_ENERGY_REFERENCE_RATIO = 2;

export const POINT_ENERGY_VERTEX_ANCHOR = '#include <logdepthbuf_vertex>';
export const POINT_ENERGY_FRAGMENT_ANCHOR = '#include <opaque_fragment>';

export interface PointEnergyUniforms {
  uPointPixelRatio: { value: number };
  uPointSceneScale: { value: number };
}

/**
 * The alpha scale the shader applies: light per CSS area the clamp gives a
 * point of `wantPx` device pixels on a display at `pixelRatio`, over the same
 * on the reference display (the fragment then holds the final alpha at 1).
 * `wantPx` is the size the dot wants in the target it is drawn into, i.e. after
 * `uPointSceneScale`, and `pixelRatio` is that target's own ratio.
 * The GLSL below mirrors this line for line; the test pins both ends.
 */
export function pointEnergyScale(wantPx: number, pixelRatio: number): number {
  const refPx = wantPx * POINT_ENERGY_REFERENCE_RATIO / pixelRatio;
  const scale = (Math.max(refPx, 1) / Math.max(wantPx, 1)) * (pixelRatio / POINT_ENERGY_REFERENCE_RATIO);
  return scale * scale;
}

export function augmentPointsMaterialWithSubpixelEnergy(mat: THREE.PointsMaterial): PointEnergyUniforms {
  const u: PointEnergyUniforms = {
    uPointPixelRatio: { value: POINT_ENERGY_REFERENCE_RATIO },
    // 1 until told otherwise: a scene drawn at the canvas's own ratio, which
    // is what every material gets before the resolution levels speak.
    uPointSceneScale: { value: 1 },
  };
  const previous = mat.onBeforeCompile;
  // three keys a material's program on its onBeforeCompile source unless told
  // otherwise; every material this wraps would share ours, whatever hook it
  // chained. Extend the key the material already had instead.
  const previousKey = mat.customProgramCacheKey();
  mat.customProgramCacheKey = () => `${previousKey}|pointEnergy`;
  mat.onBeforeCompile = (shader, renderer) => {
    previous?.(shader, renderer);
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform float uPointPixelRatio;\nuniform float uPointSceneScale;\nvarying float vPointEnergy;',
      )
      .replace(
        POINT_ENERGY_VERTEX_ANCHOR,
        [
          `float pointWantPx = gl_PointSize * uPointSceneScale;`,
          `float pointRefPx = pointWantPx * ${POINT_ENERGY_REFERENCE_RATIO.toFixed(1)} / uPointPixelRatio;`,
          `float pointScale = max(pointRefPx, 1.0) / max(pointWantPx, 1.0) * uPointPixelRatio / ${POINT_ENERGY_REFERENCE_RATIO.toFixed(1)};`,
          `vPointEnergy = pointScale * pointScale;`,
          `gl_PointSize = max(pointWantPx, 1.0);`,
          POINT_ENERGY_VERTEX_ANCHOR,
        ].join('\n\t'),
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vPointEnergy;')
      .replace(POINT_ENERGY_FRAGMENT_ANCHOR, `diffuseColor.a = min(1.0, diffuseColor.a * vPointEnergy);\n\t${POINT_ENERGY_FRAGMENT_ANCHOR}`);
  };
  mat.needsUpdate = true;
  return u;
}

/**
 * Tell an augmented Points object both current pixel ratios — at boot, on every
 * resize, and on every graphics-quality rung. `sceneRatio` is the ratio of the
 * target the points are drawn into (the one the energy is reckoned against);
 * `outputRatio` is `renderer.getPixelRatio()`, the one three sized
 * `gl_PointSize` from, and the two together undo that (see the header).
 */
export function setPointEnergyPixelRatio(
  points: THREE.Points,
  sceneRatio: number,
  outputRatio: number,
): void {
  const u = points.userData.pointEnergyUniforms as PointEnergyUniforms | undefined;
  if (!u) return;
  u.uPointPixelRatio.value = sceneRatio;
  u.uPointSceneScale.value = sceneRatio / outputRatio;
}
