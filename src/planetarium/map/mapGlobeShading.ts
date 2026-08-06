/**
 * Terminator softening for the chart's little globes.
 *
 * A map globe is drawn at six to twenty screen pixels most of the time. At that
 * size the day/night boundary — a hard step in the cosine of the light angle,
 * with no antialiasing under it, since the map draws straight to the backbuffer
 * with no composer and no multisampling — lands on two or three pixels and
 * reads as a stair cut across the body. The real terminator is soft (a real one
 * is softened by the Sun's angular size and by air), and at chart size the
 * honest picture and the legible one are the same picture.
 *
 * So the cosine falls off through a rounded corner instead of a hard one, over
 * a band chosen in SCREEN PIXELS rather than in angle: the eased band is about
 * `MAP_TERMINATOR_SOFT_PX` wide however big the body draws. That is what makes
 * it size-dependent in the way the eye needs — a marker-sized Mercury eases
 * over a quarter of its lit cosine while a dived-into globe eases over a
 * hundredth of it, which is antialiasing and nothing more. Away from the
 * terminator the two responses agree to a fraction of a percent, so the lit
 * face keeps its own shape and nothing is washed flat.
 *
 * The strength is a uniform, and at zero the injected term is exactly zero, so
 * the shader is inert until a body asks for softening. That matters twice: the
 * GLSL is byte-identical for every body (only the uniform differs), so the
 * globes still share one compiled program, and the whole effect can be turned
 * off in place for an A/B.
 */

import * as THREE from 'three';

/** How wide the eased band is on screen, in px. Wide enough to kill the stair
 *  at marker sizes, narrow enough that a resolved globe still shows a crisp
 *  terminator with its own shape. */
export const MAP_TERMINATOR_SOFT_PX = 1.6;

/** Ceiling on the easing. A body only a few px across would otherwise ask for
 *  so much that its night side lifts into daylight and the body reads as flat —
 *  the one thing the night floor exists to avoid. At the ceiling the terminator
 *  itself sits at about a sixth of full daylight, which is a soft edge and
 *  still unmistakably an edge. */
export const MAP_TERMINATOR_MAX = 0.35;

/**
 * The easing width for a body drawn at `drawnRadiusPx`, in cosine units: the
 * band either side of the geometric terminator that the falloff is rounded
 * over.
 *
 * A body with no drawn size yet takes the ceiling — the smallest thing it could
 * be — so nothing draws a hard stair on its first frame.
 */
export function mapTerminatorSoftness(
  drawnRadiusPx: number,
  softPx: number = MAP_TERMINATOR_SOFT_PX,
  max: number = MAP_TERMINATOR_MAX,
): number {
  if (!(drawnRadiusPx > 0)) return max;
  // One screen px of arc is one px of cosine per drawn radius: near the
  // terminator the cosine runs at about a radian per radius, so a band this
  // wide in cosine is that many px wide on screen.
  const soft = softPx / drawnRadiusPx;
  return soft > max ? max : soft;
}

/** The per-body handle on the injection: one float, written every frame from
 *  the body's drawn size. */
export interface MapGlobeShading {
  softness: { value: number };
}

/** The star as the shader needs it, shared by every globe on the chart: its
 *  position in the drawing camera's space, and the irradiance it delivers.
 *  One holder, written once per drawing pass. */
export interface MapSunUniforms {
  viewPos: { value: THREE.Vector3 };
  irradiance: { value: THREE.Color };
}

export function makeMapSunUniforms(color: THREE.Color, intensity: number): MapSunUniforms {
  return {
    viewPos: { value: new THREE.Vector3() },
    irradiance: { value: color.clone().multiplyScalar(intensity) },
  };
}

/**
 * Add the softened terminator to one globe material.
 *
 * The map's star is a point light at the chart's origin with its falloff
 * switched off, so the shader can rebuild exactly the light the standard
 * material already applied — direction from the fragment to the star, constant
 * irradiance — and add the DIFFERENCE between the softened response and the
 * hard one. An additive difference rather than a rescale: at softness zero the
 * two responses are identical and the term is exactly zero, which no division
 * by a vanishing cosine could promise.
 *
 * The softened response is the hard one with its corner rounded off:
 * ½(c + √(c² + s²)) against max(c, 0). It meets the hard cosine from above and
 * converges to it as s²/4c, so a lit face is left alone (a percent at most),
 * the terminator itself sits at s/2 instead of at nothing, and the night side
 * gets a fading lift rather than a wall. There is no branch and no clamp in the
 * shape itself — the same expression covers both sides of the terminator.
 */
export function augmentMapGlobeMaterial(
  mat: THREE.MeshStandardMaterial,
  sun: MapSunUniforms,
): MapGlobeShading {
  const softness = { value: 0 };
  // One function SOURCE for every body: three keys the program cache on
  // onBeforeCompile.toString(), so identical source means one compiled program
  // however many materials carry their own uniforms through it.
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uMapSunViewPos = sun.viewPos;
    shader.uniforms.uMapSunIrradiance = sun.irradiance;
    shader.uniforms.uMapTermSoft = softness;
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\n'
          + 'uniform vec3 uMapSunViewPos;\n'
          + 'uniform vec3 uMapSunIrradiance;\n'
          + 'uniform float uMapTermSoft;',
      )
      .replace(
        '#include <lights_fragment_begin>',
        '#include <lights_fragment_begin>\n'
          + '{\n'
          // vViewPosition is the fragment's view position negated, so the star's
          // view position plus it is the vector from the surface to the star.
          + '  vec3 sunDir = normalize(uMapSunViewPos + vViewPosition);\n'
          + '  float ndl = dot(geometryNormal, sunDir);\n'
          + '  float hard = clamp(ndl, 0.0, 1.0);\n'
          + '  float soft = min(1.0,\n'
          + '    0.5 * (ndl + sqrt(ndl * ndl + uMapTermSoft * uMapTermSoft)));\n'
          + '  reflectedLight.directDiffuse +=\n'
          + '    (soft - hard) * uMapSunIrradiance * BRDF_Lambert(material.diffuseColor);\n'
          + '}',
      );
  };
  mat.needsUpdate = true;
  return { softness };
}
