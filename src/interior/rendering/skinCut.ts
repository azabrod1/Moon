/**
 * The exterior discard for the Look-inside tool: a composed onBeforeCompile
 * wrapper that removes the skin inside the cut frame's wedge, uniform-driven
 * rather than through material.clippingPlanes so the same values govern the
 * skin, the rings, the atmosphere shell and the Sun's photosphere — and so
 * the edge can be feathered.
 *
 * The test per fragment is the wedge as the intersection of the two
 * half-spaces its faces bound: each face's normal points into the removed
 * wedge (cutFrame.cutFaceBasis), and a fragment is inside only when it is on
 * the removed side of BOTH planes, so how far outside it is is its distance
 * to the nearer plane. That distance is linear in the fragment's offset from
 * the centre, so its `fwidth` feather is one pixel wide everywhere — the
 * hinge included, where the two planes meet and an angle test (atan of two
 * vanishing components) has no answer and left a notch at each pole. The
 * same set as cutFrame.wedgeAngle below the half-angle, which the CPU pick
 * keeps. The feather is written into the fragment's alpha. How that alpha
 * becomes an edge depends on the render path (InteriorScene decides, per
 * plan §5): with a multisampled target the material uses alpha-to-coverage,
 * so the skin stays in the opaque pass and writes depth like any other
 * opaque; with no samples it blends the feather instead (transparent, depth
 * still written) — the whole exterior is one mesh, so nothing has to sort
 * against it.
 *
 * Wraps AFTER surfaceShading's augment (the compare studio's pile-floor
 * pattern): the augment's hook runs first, then the cut lines are added.
 * The wrapper text is identical for every body, so the program cache key
 * stays shared across bodies.
 */
import * as THREE from 'three';

export interface SkinCutUniforms {
  /** The wedge's two bounding planes as their unit normals, each pointing INTO
   *  the removed wedge (world): cutFrame.cutFaceBasis's normals for face A and B. */
  uCutNormalA: { value: THREE.Vector3 };
  uCutNormalB: { value: THREE.Vector3 };
  /** Unit vector from the body centre toward the camera THIS FRAME (world): what
   *  a shell drawn from its far side reflects through, and the axis of the disc
   *  a halo is gated to. The wedge itself is body-locked and does not follow it. */
  uCutCamera: { value: THREE.Vector3 };
  /** Half the opening angle, radians; 0 leaves the skin whole. */
  uCutHalfAngle: { value: number };
  /** 1 feathers the edge with fwidth, 0 is a hard step. */
  uCutFeather: { value: number };
  /** 1 keeps only the wedge instead of removing it: the reveal's exterior ghost. */
  uCutInvert: { value: number };
}

export function createSkinCutUniforms(): SkinCutUniforms {
  return {
    uCutNormalA: { value: new THREE.Vector3(0, 0, 1) },
    uCutNormalB: { value: new THREE.Vector3(0, 0, 1) },
    uCutCamera: { value: new THREE.Vector3(0, 0, 1) },
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
uniform vec3 uCutNormalA;
uniform vec3 uCutNormalB;
uniform float uCutHalfAngle;
uniform float uCutFeather;
uniform float uCutInvert;
// How far outside the wedge a point is, in body radii: inside only when it is
// on the removed side of both bounding planes, so outside by its distance to
// the nearer one. Linear in the point, so the feather is one pixel wide at the
// hinge too, where the planes meet.
float interiorCutOutside(vec3 offset) {
  return -min(dot(offset, uCutNormalA), dot(offset, uCutNormalB));
}
`;

/** Runs at the top of main: the removed fragments never reach the lighting. */
const CUT_FRAGMENT = /* glsl */ `
float interiorCutCoverage = 1.0;
if (uCutHalfAngle > 0.0 || uCutInvert > 0.5) {
  float cutSigned = interiorCutOutside(vInteriorCutWorld) * (1.0 - 2.0 * uCutInvert);
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

/** The standard-material cut as one text, for the test that pins its arithmetic. */
export const SKIN_CUT_FRAGMENT_TEXT = [CUT_PARS_FRAGMENT, CUT_FRAGMENT, CUT_ALPHA].join('\n');

/**
 * Compose the discard onto a standard material that may already carry
 * surfaceShading's hook. Assigns the uniforms by reference, so the scene
 * updates them once per frame for every material that shares them.
 */
export function applySkinCut(material: THREE.MeshStandardMaterial, uniforms: SkinCutUniforms): void {
  const previousCompile = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile.call(material, shader, renderer);
    shader.uniforms.uCutNormalA = uniforms.uCutNormalA;
    shader.uniforms.uCutNormalB = uniforms.uCutNormalB;
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
  /** GLSL for the fragment's offset from the body centre (any length; the planes pass through the centre). */
  direction: string;
  /** The output statement to replace, and its replacement carrying `interiorCutCoverage`. */
  output: { find: string; replace: string };
  /** Test the screen position a far-side fragment covers (a BackSide shell) rather than the
   *  fragment itself: its reflection through the plane facing the camera this frame. */
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
  material.uniforms.uCutNormalA = uniforms.uCutNormalA;
  material.uniforms.uCutNormalB = uniforms.uCutNormalB;
  material.uniforms.uCutCamera = uniforms.uCutCamera;
  material.uniforms.uCutHalfAngle = uniforms.uCutHalfAngle;
  const declarations = 'uniform vec3 uCutNormalA;\nuniform vec3 uCutNormalB;\nuniform vec3 uCutCamera;\nuniform float uCutHalfAngle;\n'
    + (options.vertexVarying ? 'varying vec3 vInteriorCutWorld;\n' : '');
  const reflect = options.reflectFarSide
    ? '    float cutAlong = dot(cutOffset, uCutCamera);\n    if (cutAlong < 0.0) cutOffset -= 2.0 * cutAlong * uCutCamera;\n'
    : '';
  // Beyond the disc the wedge has nothing to open: a halo there is kept whole.
  // The gate lands on the COVERAGE, after the feather: a sentinel written into
  // the signed distance would be the step the feather's fwidth measures on the
  // quads straddling the gate, and half-covered them on both sides.
  const gate = options.discGateScale !== undefined
    ? `    if (length(cross(normalize(cutOffset), uCutCamera)) * ${options.discGateScale.toFixed(4)} >= 1.0) interiorCutCoverage = 1.0;\n`
    : '';
  const test = `
  float interiorCutCoverage = 1.0;
  if (uCutHalfAngle > 0.0) {
    vec3 cutOffset = ${options.direction};
${reflect}    float cutSigned = -min(dot(cutOffset, uCutNormalA), dot(cutOffset, uCutNormalB));
    float cutWidth = max(fwidth(cutSigned), 1e-5);
    interiorCutCoverage = clamp(cutSigned / cutWidth + 0.5, 0.0, 1.0);
${gate}    if (interiorCutCoverage <= 0.0) discard;
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
 * covers, which its reflection through the plane facing the camera gives —
 * the camera's own direction this frame (uCutCamera), not the wedge's axis,
 * because the wedge is locked to the body and the camera orbits it, and a
 * reflection through a stale axis hung the shell's far side over the faces
 * as a veil. At the limb, where the fringe lives, the reflected point and
 * the fragment coincide, so the air's edge lands exactly on the skin's. The
 * feather goes into the radiance, since an
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
