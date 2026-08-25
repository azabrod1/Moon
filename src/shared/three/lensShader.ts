import * as THREE from 'three';
import { lensRadial } from '../math/lensProjection';

import { DEG2RAD as DEG } from '../math/angles';

/** Uniform block shared by pre-warp screen primitives. They draw into the
 * rectilinear source but author their centres and sizes in final-output pixels. */
export interface LensShaderUniforms {
  uLensStrength: { value: number };
  uLensAspect: { value: number };
  uLensTanHalfRender: { value: number };
  uLensREdge: { value: number };
  uLensViewportPx: { value: THREE.Vector2 };
  uLensFramebufferPx: { value: THREE.Vector2 };
}

export function createLensShaderUniforms(): LensShaderUniforms {
  return {
    uLensStrength: { value: 0 },
    uLensAspect: { value: 1 },
    uLensTanHalfRender: { value: 1 },
    uLensREdge: { value: 1 },
    uLensViewportPx: { value: new THREE.Vector2(1, 1) },
    uLensFramebufferPx: { value: new THREE.Vector2(1, 1) },
  };
}

export function applyLensShaderUniforms(
  uniforms: LensShaderUniforms,
  camera: THREE.PerspectiveCamera,
  viewportWidthPx: number,
  viewportHeightPx: number,
  pixelRatio = 1,
): void {
  const lens = camera.userData.lens as
    | { strength: number; designFovDeg: number; effectiveStrength?: number }
    | undefined;
  const strength = lens ? (lens.effectiveStrength ?? lens.strength) : 0;
  uniforms.uLensStrength.value = strength;
  uniforms.uLensAspect.value = camera.aspect;
  uniforms.uLensTanHalfRender.value = Math.tan((camera.fov / 2) * DEG);
  uniforms.uLensREdge.value = lens
    ? lensRadial((lens.designFovDeg / 2) * DEG, strength)
    : Math.tan((camera.fov / 2) * DEG);
  uniforms.uLensViewportPx.value.set(
    Math.max(viewportWidthPx, 1),
    Math.max(viewportHeightPx, 1),
  );
  uniforms.uLensFramebufferPx.value.set(
    Math.max(viewportWidthPx * pixelRatio, 1),
    Math.max(viewportHeightPx * pixelRatio, 1),
  );
}

/** GLSL 1-compatible forward/inverse pair. The inverse uses the same fixed
 * eight Newton steps as the CPU and LensPass implementations. */
export const lensShaderGLSL = /* glsl */ `
uniform float uLensStrength;
uniform float uLensAspect;
uniform float uLensTanHalfRender;
uniform float uLensREdge;
uniform vec2 uLensViewportPx;
uniform vec2 uLensFramebufferPx;

float lensShaderRadial(float theta) {
  return (1.0 - uLensStrength) * tan(theta)
    + uLensStrength * 2.0 * tan(theta * 0.5);
}

float lensShaderRadialInverse(float radius) {
  float theta = atan(radius);
  for (int i = 0; i < 8; i++) {
    float t = tan(theta);
    float th = tan(theta * 0.5);
    float f = (1.0 - uLensStrength) * t + uLensStrength * 2.0 * th - radius;
    float df = (1.0 - uLensStrength) * (1.0 + t * t)
      + uLensStrength * (1.0 + th * th);
    theta -= f / df;
  }
  return theta;
}

vec2 lensWarpSourceNdc(vec2 sourceNdc) {
  if (uLensStrength <= 0.0) return sourceNdc;
  vec2 d = vec2(
    sourceNdc.x * uLensAspect * uLensTanHalfRender,
    sourceNdc.y * uLensTanHalfRender
  );
  float tanTheta = length(d);
  if (tanTheta < 1e-7) return vec2(0.0);
  float radius = lensShaderRadial(atan(tanTheta)) / uLensREdge;
  vec2 outputAspect = d * (radius / tanTheta);
  return vec2(outputAspect.x / uLensAspect, outputAspect.y);
}

vec2 lensUnwarpOutputNdc(vec2 outputNdc) {
  if (uLensStrength <= 0.0) return outputNdc;
  vec2 d = vec2(outputNdc.x * uLensAspect, outputNdc.y);
  float outputRadius = length(d);
  if (outputRadius < 1e-7) return vec2(0.0);
  float theta = lensShaderRadialInverse(outputRadius * uLensREdge);
  float sourceRadius = tan(theta) / uLensTanHalfRender;
  vec2 sourceAspect = d * (sourceRadius / outputRadius);
  return vec2(sourceAspect.x / uLensAspect, sourceAspect.y);
}
`;

/**
 * Point-sprite pre-distortion, vertex side — the statement block a lens-aware
 * Points shader runs after writing gl_Position. Warps the centre into output
 * space, then bounds gl_PointSize conservatively by unwarping the four
 * corners of the desired output quad (the source-space footprint of a warped
 * disc is anisotropic; the max over the corners always covers it). ONE
 * definition for every point-sprite consumer (moon dots, starfield) — the
 * pre-distortion contract must never drift between them.
 *
 * The surrounding shader declares `attribute float size`, `uniform float
 * pixelRatio`, the pair of varyings `vec2 vLensOutputCentre` / `float
 * vLensTargetDiameterPx`, and interpolates a block providing
 * lensWarpSourceNdc/lensUnwarpOutputNdc (lensShaderGLSL, or a superset like
 * the sun-glare mask block).
 */
export const lensPointSpriteVertexGLSL = /* glsl */ `
          vec2 sourceCentre = gl_Position.xy / gl_Position.w;
          vLensOutputCentre = lensWarpSourceNdc(sourceCentre);
          vLensTargetDiameterPx = size * pixelRatio;
          vec2 halfOutputNdc = vec2(
            vLensTargetDiameterPx / max(uLensFramebufferPx.x, 1.0),
            vLensTargetDiameterPx / max(uLensFramebufferPx.y, 1.0)
          );
          vec2 sourceA = lensUnwarpOutputNdc(vLensOutputCentre + halfOutputNdc);
          vec2 sourceB = lensUnwarpOutputNdc(vLensOutputCentre - halfOutputNdc);
          vec2 sourceC = lensUnwarpOutputNdc(vLensOutputCentre + vec2(halfOutputNdc.x, -halfOutputNdc.y));
          vec2 sourceD = lensUnwarpOutputNdc(vLensOutputCentre + vec2(-halfOutputNdc.x, halfOutputNdc.y));
          vec2 halfA = abs(sourceA - sourceCentre) * uLensFramebufferPx * 0.5;
          vec2 halfB = abs(sourceB - sourceCentre) * uLensFramebufferPx * 0.5;
          vec2 halfC = abs(sourceC - sourceCentre) * uLensFramebufferPx * 0.5;
          vec2 halfD = abs(sourceD - sourceCentre) * uLensFramebufferPx * 0.5;
          float sourceHalfPx = max(
            max(max(halfA.x, halfA.y), max(halfB.x, halfB.y)),
            max(max(halfC.x, halfC.y), max(halfD.x, halfD.y))
          );
          gl_PointSize = max(1.0, 2.0 * sourceHalfPx);
`;

/**
 * Point-sprite disc kernel, fragment side — pairs with
 * lensPointSpriteVertexGLSL. Measures each fragment's distance from the
 * warped centre in OUTPUT pixels (so the drawn disc is round after the lens
 * pass), discards outside the disc, and leaves `falloff` (and `d`) for the
 * shader's own colour/alpha line.
 */
export const lensPointSpriteFragmentGLSL = /* glsl */ `
          vec2 sourceNdc = gl_FragCoord.xy / uLensFramebufferPx * 2.0 - 1.0;
          vec2 outputNdc = lensWarpSourceNdc(sourceNdc);
          vec2 outputOffsetPx = (outputNdc - vLensOutputCentre) * uLensFramebufferPx * 0.5;
          float d = length(outputOffsetPx) / max(vLensTargetDiameterPx, 1e-6);
          if (d > 0.5) discard;
          float falloff = 1.0 - smoothstep(0.2, 0.5, d);
`;

/** Pre-distort a fixed-size SpriteMaterial quad into the overscan source so the
 * final lens pass restores its authored output-space centre, size, and shape. */
export function augmentFixedScreenSpriteForLens(
  material: THREE.SpriteMaterial,
  uniforms: LensShaderUniforms = createLensShaderUniforms(),
): LensShaderUniforms {
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${lensShaderGLSL}`)
      .replace(
        'gl_Position = projectionMatrix * mvPosition;',
        /* glsl */ `
  vec4 lensCentreView = mvPosition;
  lensCentreView.xy -= rotatedPosition;
  vec4 lensCentreClip = projectionMatrix * lensCentreView;
  vec4 lensVertexClip = projectionMatrix * mvPosition;
  vec2 lensSourceCentre = lensCentreClip.xy / lensCentreClip.w;
  vec2 lensSourceVertex = lensVertexClip.xy / lensVertexClip.w;
  vec2 lensOutputCentre = lensWarpSourceNdc(lensSourceCentre);
  vec2 lensDesiredOutput = lensOutputCentre + (lensSourceVertex - lensSourceCentre);
  vec2 lensPredistortedSource = lensUnwarpOutputNdc(lensDesiredOutput);
  gl_Position = lensVertexClip;
  gl_Position.xy = lensPredistortedSource * gl_Position.w;
`,
      );
  };
  material.customProgramCacheKey = () => 'fixed-screen-sprite-lens-v1';
  material.needsUpdate = true;
  return uniforms;
}

/** Keep Line2's pixel-authored width in output space. The centreline remains a
 * physical scene line (and is therefore curved by the lens where appropriate),
 * while each generated endpoint/cap vertex is inverse-mapped from the desired
 * output-width quad. WORLD_UNITS materials intentionally retain their physical
 * width path. */
export function augmentFixedScreenLineForLens(
  material: THREE.ShaderMaterial,
  uniforms: LensShaderUniforms = createLensShaderUniforms(),
): LensShaderUniforms {
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${lensShaderGLSL}`)
      .replace(
        'gl_Position = clip;',
        /* glsl */ `
  #ifndef WORLD_UNITS
    // A segment that wraps or grazes the camera plane has near-singular NDC
    // endpoints (trimSegment parks one just in front of the near plane, with a
    // huge finite ndc.xy; both-behind segments have negative clip w). The
    // warp/unwarp pair is numerically explosive there, scattering the quad's
    // vertices across the frame as giant triangles. Keep the stock quad for
    // those segments. When the camera sits on the line's own path (a ring
    // being ridden, an umbra cone being stood in), a sizeable fraction of the
    // primitive takes this fallback, not just an off-screen sliver — measured
    // effect: on-screen weight gets MORE uniform, because the warp math was
    // mis-thinning exactly those segments before it exploded. Behind-camera
    // vertices stay clipped as the stock path clips them.
    bool lensApplies = clipStart.w > 0.0 && clipEnd.w > 0.0
      && length(ndcStart.xy) < 8.0 && length(ndcEnd.xy) < 8.0;
    if (lensApplies) {
      vec2 lensOutStart = lensWarpSourceNdc(ndcStart.xy);
      vec2 lensOutEnd = lensWarpSourceNdc(ndcEnd.xy);
      vec2 lensDir = lensOutEnd - lensOutStart;
      lensDir.x *= aspect;
      lensDir = normalize(lensDir);
      vec2 lensOffset = vec2(lensDir.y, -lensDir.x);
      lensDir.x /= aspect;
      lensOffset.x /= aspect;
      if (position.x < 0.0) lensOffset *= -1.0;
      if (position.y < 0.0) lensOffset -= lensDir;
      else if (position.y > 1.0) lensOffset += lensDir;
      lensOffset *= linewidth;
      lensOffset /= resolution.y;
      vec2 lensOutCentre = position.y < 0.5 ? lensOutStart : lensOutEnd;
      vec2 lensDesiredOutput = lensOutCentre + lensOffset;
      vec2 lensPredistortedSource = lensUnwarpOutputNdc(lensDesiredOutput);
      clip.xy = lensPredistortedSource * clip.w;
    }
  #endif
  gl_Position = clip;
`,
      );
  };
  material.customProgramCacheKey = () => 'fixed-screen-line-lens-v2';
  material.needsUpdate = true;
  return uniforms;
}
