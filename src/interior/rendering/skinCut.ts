/**
 * The exterior discard for the Look-inside tool: a composed onBeforeCompile
 * wrapper that removes the skin inside the cut frame's wedge, uniform-driven
 * rather than through material.clippingPlanes so the same three values
 * (view axis, side axis, half-angle) govern the skin, the atmosphere shell
 * and the CPU pick — and so the edge can be feathered.
 *
 * The test per fragment is cutFrame.wedgeAngle in GLSL: the angle between
 * the fragment's direction from the centre, projected into the plane the
 * wedge opens in, and the view axis; below the half-angle the fragment is
 * removed. The edge is antialiased with a `fwidth` feather written into the
 * fragment's alpha. How that alpha becomes an edge depends on the render
 * path (InteriorScene decides, per plan §5): with a multisampled target the
 * material uses alpha-to-coverage, so the skin stays in the opaque pass and
 * writes depth like any other opaque; with no samples it blends the feather
 * instead (transparent, depth still written) — the whole exterior is one
 * mesh, so nothing has to sort against it.
 *
 * Wraps AFTER surfaceShading's augment (the compare studio's pile-floor
 * pattern): the augment's hook runs first, then the cut lines are added.
 * The wrapper text is identical for every body, so the program cache key
 * stays shared across bodies.
 */
import * as THREE from 'three';

export interface SkinCutUniforms {
  /** Unit vector from the body centre toward the camera (world). */
  uCutView: { value: THREE.Vector3 };
  /** Unit vector hinge × view (world). */
  uCutSide: { value: THREE.Vector3 };
  /** Half the opening angle, radians; 0 leaves the skin whole. */
  uCutHalfAngle: { value: number };
  /** 1 feathers the edge with fwidth, 0 is a hard step. */
  uCutFeather: { value: number };
}

export function createSkinCutUniforms(): SkinCutUniforms {
  return {
    uCutView: { value: new THREE.Vector3(0, 0, 1) },
    uCutSide: { value: new THREE.Vector3(1, 0, 0) },
    uCutHalfAngle: { value: 0 },
    uCutFeather: { value: 1 },
  };
}

const CUT_PARS_VERTEX = /* glsl */ `
varying vec3 vInteriorCutWorld;
`;

const CUT_VERTEX = /* glsl */ `
vInteriorCutWorld = (modelMatrix * vec4(position, 1.0)).xyz;
`;

const CUT_PARS_FRAGMENT = /* glsl */ `
varying vec3 vInteriorCutWorld;
uniform vec3 uCutView;
uniform vec3 uCutSide;
uniform float uCutHalfAngle;
uniform float uCutFeather;
`;

/** Runs at the top of main: the removed fragments never reach the lighting. */
const CUT_FRAGMENT = /* glsl */ `
float interiorCutCoverage = 1.0;
if (uCutHalfAngle > 0.0) {
  vec3 cutDirection = normalize(vInteriorCutWorld);
  float cutAngle = atan(abs(dot(cutDirection, uCutSide)), dot(cutDirection, uCutView));
  float cutSigned = cutAngle - uCutHalfAngle;
  float cutWidth = max(fwidth(cutSigned), 1e-5);
  interiorCutCoverage = uCutFeather > 0.5
    ? clamp(cutSigned / cutWidth + 0.5, 0.0, 1.0)
    : step(0.0, cutSigned);
  if (interiorCutCoverage <= 0.0) discard;
}
`;

/** Before opaque_fragment, after every lighting term: the feather lands in alpha. */
const CUT_ALPHA = /* glsl */ `
diffuseColor.a *= interiorCutCoverage;
`;

/**
 * Compose the discard onto a standard material that may already carry
 * surfaceShading's hook. Assigns the uniforms by reference, so the scene
 * updates them once per frame for every material that shares them.
 */
export function applySkinCut(material: THREE.MeshStandardMaterial, uniforms: SkinCutUniforms): void {
  const previousCompile = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile.call(material, shader, renderer);
    shader.uniforms.uCutView = uniforms.uCutView;
    shader.uniforms.uCutSide = uniforms.uCutSide;
    shader.uniforms.uCutHalfAngle = uniforms.uCutHalfAngle;
    shader.uniforms.uCutFeather = uniforms.uCutFeather;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${CUT_PARS_VERTEX}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${CUT_VERTEX}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${CUT_PARS_FRAGMENT}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${CUT_FRAGMENT}`)
      .replace('#include <opaque_fragment>', `${CUT_ALPHA}\n#include <opaque_fragment>`);
  };
  // The augment may have set its own key; the cut adds its own token so a
  // body's cut program never shares a cache slot with its uncut one.
  const previousKey = material.customProgramCacheKey;
  material.customProgramCacheKey = () => `${previousKey.call(material)}|interiorCut`;
}

/**
 * Choose how the feathered alpha becomes an edge for the current render
 * path. Multisampled targets take alpha-to-coverage and stay opaque; a
 * single-sample target blends the feather. Both write depth.
 */
export function configureSkinCutEdge(material: THREE.MeshStandardMaterial, multisampled: boolean): void {
  const wantAlphaToCoverage = multisampled;
  const wantTransparent = !multisampled;
  if (material.alphaToCoverage === wantAlphaToCoverage && material.transparent === wantTransparent) return;
  material.alphaToCoverage = wantAlphaToCoverage;
  material.transparent = wantTransparent;
  material.depthWrite = true;
  material.needsUpdate = true;
}
