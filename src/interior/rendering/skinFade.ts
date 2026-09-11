/**
 * The skin cross-fade for a body swap (plan §4): the incoming skin material
 * carries the outgoing body's map as a second sampler and blends from it to
 * its own over a short fade, so the exterior changes body behind a closed
 * cut with no second mesh, no transparency pass and no recompile at the
 * end — the program is the same one the skin always uses, and once the
 * fade is done the previous map is dropped and the uniform sits at 1.
 *
 * Composed onto the material after surfaceShading's augment and before the
 * cut, so the blend happens where the map is read and every later term
 * (relief, night lights, the cut's feather) sees one skin.
 */
import * as THREE from 'three';

export interface SkinFadeUniforms {
  /** The outgoing body's colour map while a fade runs; a 1×1 black otherwise. */
  uSkinFadeMap: { value: THREE.Texture };
  /** 0 shows the previous map, 1 the material's own. */
  uSkinFade: { value: number };
}

const idle = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
idle.needsUpdate = true;

export function createSkinFadeUniforms(): SkinFadeUniforms {
  return { uSkinFadeMap: { value: idle }, uSkinFade: { value: 1 } };
}

/** The shared idle map, so a caller can tell a real fade map from none. */
export function idleFadeTexture(): THREE.Texture {
  return idle;
}

const FADE_PARS_FRAGMENT = /* glsl */ `
uniform sampler2D uSkinFadeMap;
uniform float uSkinFade;
`;

/** After <map_fragment>: the previous body's colour where the fade has not yet arrived. */
const FADE_FRAGMENT = /* glsl */ `
#ifdef USE_MAP
if (uSkinFade < 1.0) {
  vec4 skinPrevious = texture2D(uSkinFadeMap, vMapUv);
  diffuseColor.rgb = mix(skinPrevious.rgb, diffuseColor.rgb, uSkinFade);
}
#endif
`;

export function applySkinFade(material: THREE.MeshStandardMaterial, uniforms: SkinFadeUniforms): void {
  const previousCompile = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile.call(material, shader, renderer);
    shader.uniforms.uSkinFadeMap = uniforms.uSkinFadeMap;
    shader.uniforms.uSkinFade = uniforms.uSkinFade;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FADE_PARS_FRAGMENT}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${FADE_FRAGMENT}`);
  };
  const previousKey = material.customProgramCacheKey;
  material.customProgramCacheKey = () => `${previousKey.call(material)}|interiorFade`;
}
