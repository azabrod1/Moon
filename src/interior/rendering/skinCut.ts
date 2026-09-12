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
  /** 1 keeps only the wedge instead of removing it: the reveal's exterior ghost. */
  uCutInvert: { value: number };
}

export function createSkinCutUniforms(): SkinCutUniforms {
  return {
    uCutView: { value: new THREE.Vector3(0, 0, 1) },
    uCutSide: { value: new THREE.Vector3(1, 0, 0) },
    uCutHalfAngle: { value: 0 },
    uCutFeather: { value: 1 },
    uCutInvert: { value: 0 },
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
uniform float uCutInvert;
`;

/** Runs at the top of main: the removed fragments never reach the lighting. */
const CUT_FRAGMENT = /* glsl */ `
float interiorCutCoverage = 1.0;
if (uCutHalfAngle > 0.0 || uCutInvert > 0.5) {
  vec3 cutDirection = normalize(vInteriorCutWorld);
  float cutAngle = atan(abs(dot(cutDirection, uCutSide)), dot(cutDirection, uCutView));
  float cutSigned = (cutAngle - uCutHalfAngle) * (1.0 - 2.0 * uCutInvert);
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
    shader.uniforms.uCutInvert = uniforms.uCutInvert;
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
export function configureSkinCutEdge(material: THREE.Material, multisampled: boolean): void {
  const wantAlphaToCoverage = multisampled;
  const wantTransparent = !multisampled;
  if (material.alphaToCoverage === wantAlphaToCoverage && material.transparent === wantTransparent) return;
  material.alphaToCoverage = wantAlphaToCoverage;
  material.transparent = wantTransparent;
  material.depthWrite = true;
  material.needsUpdate = true;
}

export interface RawShaderCutOptions {
  /** Add a world-position varying through the vertex shader (for a shader with no world position of its own). */
  vertexVarying: boolean;
  /** GLSL for the fragment's direction from the body centre (unit length not required). */
  direction: string;
  /** The output statement to replace, and its replacement carrying `interiorCutCoverage`. */
  output: { find: string; replace: string };
  /** Test the screen position a far-side fragment covers (a BackSide shell) rather than the fragment itself. */
  reflectFarSide: boolean;
  /** The shell's radius in body radii: when set, only fragments that project inside the body's
   *  disc are cut, and the shell's glow beyond the disc keeps shining through the wedge. */
  discGateScale?: number;
}

/**
 * The cut on a raw ShaderMaterial with no three chunks to hook (the analytic
 * atmosphere shell, the Sun's photosphere): the same test as the skin's,
 * spliced in by text at the top of main, with the feather handed to the
 * caller's output statement. Throws if the shader has changed shape, so a
 * silent uncut shell can never ship.
 */
export function applyRawShaderCut(material: THREE.ShaderMaterial, uniforms: SkinCutUniforms, options: RawShaderCutOptions): void {
  material.uniforms.uCutView = uniforms.uCutView;
  material.uniforms.uCutSide = uniforms.uCutSide;
  material.uniforms.uCutHalfAngle = uniforms.uCutHalfAngle;
  const declarations = 'uniform vec3 uCutView;\nuniform vec3 uCutSide;\nuniform float uCutHalfAngle;\n'
    + (options.vertexVarying ? 'varying vec3 vInteriorCutWorld;\n' : '');
  const reflect = options.reflectFarSide
    ? '    float cutAlong = dot(cutDirection, uCutView);\n    if (cutAlong < 0.0) cutDirection -= 2.0 * cutAlong * uCutView;\n'
    : '';
  // Beyond the disc the wedge has nothing to open: a halo there is kept whole.
  const gate = options.discGateScale !== undefined
    ? `    if (length(cross(cutDirection, uCutView)) * ${options.discGateScale.toFixed(4)} >= 1.0) cutSigned = 1e3;\n`
    : '';
  const test = `
  float interiorCutCoverage = 1.0;
  if (uCutHalfAngle > 0.0) {
    vec3 cutDirection = normalize(${options.direction});
${reflect}    float cutAngle = atan(abs(dot(cutDirection, uCutSide)), dot(cutDirection, uCutView));
    float cutSigned = cutAngle - uCutHalfAngle;
${gate}    float cutWidth = max(fwidth(cutSigned), 1e-5);
    interiorCutCoverage = clamp(cutSigned / cutWidth + 0.5, 0.0, 1.0);
    if (interiorCutCoverage <= 0.0) discard;
  }
`;
  if (!material.fragmentShader.includes(options.output.find) || !material.fragmentShader.includes('void main() {')) {
    throw new Error('applyRawShaderCut: the shader changed shape');
  }
  if (options.vertexVarying) {
    if (!material.vertexShader.includes('void main() {')) throw new Error('applyRawShaderCut: the vertex shader changed shape');
    material.vertexShader = 'varying vec3 vInteriorCutWorld;\n' + material.vertexShader
      .replace('void main() {', 'void main() {\n  vInteriorCutWorld = (modelMatrix * vec4(position, 1.0)).xyz;');
  }
  material.fragmentShader = declarations + material.fragmentShader
    .replace('void main() {', `void main() {${test}`)
    .replace(options.output.find, options.output.replace);
  material.needsUpdate = true;
}

/**
 * The cut on the analytic atmosphere shell. The shell is drawn from its far
 * side (BackSide, additive), so a fragment's own direction from the centre
 * points away from the viewer; what matters is the screen position it
 * covers, which its reflection through the frame's view plane gives — at
 * the limb, where the fringe lives, the two coincide, so the air's edge
 * lands exactly on the skin's. The feather goes into the radiance, since an
 * additive shell has no alpha to carry it. A wide shell (the Sun's corona,
 * whose halo reaches well beyond the disc) passes its scale as the disc
 * gate: an additive shell cannot occlude, so cutting its glow beyond the
 * disc would only punch a hood-shaped hole in the halo; inside the disc the
 * faces occlude it with depth, and at the limb the two agree.
 */
export function applyAtmosphereCut(material: THREE.ShaderMaterial, uniforms: SkinCutUniforms, discGateScale?: number): void {
  applyRawShaderCut(material, uniforms, {
    vertexVarying: false,
    direction: 'vWorldPos - vCenter',
    output: { find: 'gl_FragColor = vec4(radiance, 1.0);', replace: 'gl_FragColor = vec4(radiance * interiorCutCoverage, 1.0);' },
    reflectFarSide: true,
    discGateScale,
  });
}

/** The cut on the Sun's photosphere: the feather in alpha, so the edge takes the render
 *  path's treatment like the skin; `exposure` scales the planetarium's HDR radiance down to
 *  what a studio can show beside a section face. */
export function applyPhotosphereCut(material: THREE.ShaderMaterial, uniforms: SkinCutUniforms, exposure: number): void {
  applyRawShaderCut(material, uniforms, {
    vertexVarying: true,
    direction: 'vInteriorCutWorld',
    output: {
      find: 'gl_FragColor = vec4(color * radiance, 1.0);',
      replace: `gl_FragColor = vec4(color * radiance * ${exposure.toFixed(3)}, interiorCutCoverage);`,
    },
    reflectFarSide: false,
  });
}
