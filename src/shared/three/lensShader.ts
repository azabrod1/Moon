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
 * The point-sprite disc kernel's sampling rule, shared by the GLSL below and
 * its TypeScript mirror (pinned together by lensShader.test.ts).
 *
 * A fragment of a point sprite integrates the disc profile over its own
 * pixel square with an N×N midpoint grid. The grid is chosen so the fine
 * lattice it forms has at least POINT_SPRITE_SAMPLES_ACROSS samples across
 * the star's diameter: N = ceil(8·σ/D), where D is the star's diameter in
 * output pixels and σ the output pixels one source pixel spans at that star
 * (the lens magnifies the frame centre about 1.3× and shrinks its edges), so
 * a star D output px wide is D/σ fragments wide. Capped at
 * POINT_SPRITE_MAX_SAMPLES_PER_AXIS per axis; the cap only binds for stars
 * under one source pixel (a 1× monitor at Low), where it leaves a 2 % swing.
 * N = 1 — a star of 8σ px or more — is the plain centre sample.
 */
export const POINT_SPRITE_SAMPLES_ACROSS = 8;
export const POINT_SPRITE_MAX_SAMPLES_PER_AXIS = 8;

/** Sub-samples per axis for a target `diameterPx` output px wide where one
 *  source pixel spans `sourcePxScale` output px. The vertex GLSL mirrors it. */
export function pointSpriteSamplesPerAxis(diameterPx: number, sourcePxScale: number): number {
  const wanted = Math.ceil(POINT_SPRITE_SAMPLES_ACROSS * sourcePxScale / Math.max(diameterPx, 1e-6));
  return Math.min(POINT_SPRITE_MAX_SAMPLES_PER_AXIS, Math.max(1, wanted));
}

/** The disc profile at `d` diameters from the centre: full to a fifth of the
 *  diameter, smooth to nothing at the rim (1 − smoothstep(0.2, 0.5, d)). */
export function pointSpriteProfile(d: number): number {
  const t = Math.min(1, Math.max(0, (d - 0.2) / 0.3));
  return 1 - t * t * (3 - 2 * t);
}

/**
 * The fragment kernel, as the GLSL computes it: the falloff of a fragment
 * whose centre sits `outputOffsetPx` from the star's warped centre, for a
 * star `diameterPx` wide, sampled `samplesPerAxis` × `samplesPerAxis` times
 * over the fragment's source pixel. `sourceToOutputPx` is the pair of output-
 * pixel vectors one source pixel spans along source x and along source y,
 * [xx, xy, yx, yy] — the lens's local Jacobian, the identity with the lens
 * off. One sample per axis is the plain centre sample, the kernel as it was.
 */
export function pointSpriteFalloff(
  diameterPx: number,
  outputOffsetPx: readonly [number, number],
  sourceToOutputPx: readonly [number, number, number, number],
  samplesPerAxis: number,
): number {
  const invD = 1 / Math.max(diameterPx, 1e-6);
  if (samplesPerAxis <= 1) {
    const d = Math.hypot(outputOffsetPx[0], outputOffsetPx[1]) * invD;
    return d > 0.5 ? 0 : pointSpriteProfile(d);
  }
  const n = samplesPerAxis;
  const [xx, xy, yx, yy] = sourceToOutputPx;
  let sum = 0;
  for (let a = 0; a < n; a++) {
    const sx = (a + 0.5) / n - 0.5;
    const rowX = outputOffsetPx[0] + xx * sx;
    const rowY = outputOffsetPx[1] + xy * sx;
    for (let b = 0; b < n; b++) {
      const sy = (b + 0.5) / n - 0.5;
      sum += pointSpriteProfile(Math.hypot(rowX + yx * sy, rowY + yy * sy) * invD);
    }
  }
  return sum / (n * n);
}

/**
 * Point-sprite pre-distortion, vertex side — the statement block a lens-aware
 * Points shader runs after writing gl_Position. Warps the centre into output
 * space, measures the lens's local scale at the star (one source pixel each
 * way, as output pixels, by central differences of the warp), picks the
 * kernel's sample count from it, then bounds gl_PointSize conservatively by
 * unwarping the four corners of the desired output quad (the source-space
 * footprint of a warped disc is anisotropic; the max over the corners always
 * covers it). ONE definition for every point-sprite consumer (moon dots,
 * starfield) — the pre-distortion contract must never drift between them.
 *
 * The surrounding shader declares `attribute float size`, `uniform float
 * pixelRatio`, the varyings `vec2 vLensOutputCentre`, `float
 * vLensTargetDiameterPx`, `vec4 vLensSourceToOutputPx` and `float
 * vLensSamplesPerAxis`, and interpolates a block providing
 * lensWarpSourceNdc/lensUnwarpOutputNdc (lensShaderGLSL, or a superset like
 * the sun-glare mask block).
 */
export const lensPointSpriteVertexGLSL = /* glsl */ `
          vec2 sourceCentre = gl_Position.xy / gl_Position.w;
          vLensOutputCentre = lensWarpSourceNdc(sourceCentre);
          vLensTargetDiameterPx = size * pixelRatio;
          // One source pixel each way as output px: the lens's local scale
          // here. Central differences; the warp is smooth, so a one-pixel
          // step is exact to float precision. The identity with the lens off.
          vec2 stepX = vec2(2.0 / max(uLensFramebufferPx.x, 1.0), 0.0);
          vec2 stepY = vec2(0.0, 2.0 / max(uLensFramebufferPx.y, 1.0));
          vec2 alongX = (lensWarpSourceNdc(sourceCentre + stepX) - lensWarpSourceNdc(sourceCentre - stepX)) * uLensFramebufferPx * 0.25;
          vec2 alongY = (lensWarpSourceNdc(sourceCentre + stepY) - lensWarpSourceNdc(sourceCentre - stepY)) * uLensFramebufferPx * 0.25;
          vLensSourceToOutputPx = vec4(alongX, alongY);
          float sourcePxScale = max(length(alongX), length(alongY));
          vLensSamplesPerAxis = clamp(ceil(${POINT_SPRITE_SAMPLES_ACROSS.toFixed(1)} * sourcePxScale / max(vLensTargetDiameterPx, 1e-6)), 1.0, ${POINT_SPRITE_MAX_SAMPLES_PER_AXIS.toFixed(1)});
          // The kernel's footprint in output px: the disc, plus one source
          // pixel each way when fragments integrate over their pixel square
          // (a fragment whose centre lies just outside the rim still overlaps it).
          float footprintPx = vLensSamplesPerAxis > 1.5 ? vLensTargetDiameterPx + 2.0 * sourcePxScale : vLensTargetDiameterPx;
          vec2 halfOutputNdc = vec2(
            footprintPx / max(uLensFramebufferPx.x, 1.0),
            footprintPx / max(uLensFramebufferPx.y, 1.0)
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
 * lensPointSpriteVertexGLSL. Measures each fragment's offset from the warped
 * centre in OUTPUT pixels (so the drawn disc is round after the lens pass),
 * discards outside the disc, and leaves `falloff` (and `d`, the centre's
 * distance in diameters) for the shader's own colour/alpha line.
 *
 * The profile is full to a fifth of the diameter and smooth to nothing at
 * the rim. Each fragment takes its MEAN over its own pixel square — an N×N
 * midpoint grid in source pixels, each point carried to output pixels by
 * the lens's local scale from the vertex — rather than one reading at its
 * centre. Summed over the pixel lattice, a pixel-averaged profile adds up to
 * the profile's whole integral (0.399·D²) wherever the star's centre falls
 * between pixels; a profile read at pixel centres does not, and a 2-px star
 * (every floor-sized star on a 2× display at Medium) read that way carried
 * up to twice the light at one sub-pixel position as at another, so the
 * whole faint sky pulsed as the view panned. With at least eight fine
 * samples across the star (POINT_SPRITE_SAMPLES_ACROSS) the remaining swing
 * is under half a percent; stars of 8σ px and more take the single centre
 * reading, which is that accurate on its own and is the kernel as it was,
 * byte for byte. The one size rule replaces an earlier two-path kernel (a
 * square tent splat under 2 px) and its seam.
 *
 * This conserves the star's light in the scene target. The output pass then
 * resamples that target and tone-maps it, and both weigh a star's light by
 * how it is spread over pixels; what the eye finally sees is theirs to keep
 * steady, not this kernel's.
 */
export const lensPointSpriteFragmentGLSL = /* glsl */ `
          vec2 sourceNdc = gl_FragCoord.xy / uLensFramebufferPx * 2.0 - 1.0;
          vec2 outputNdc = lensWarpSourceNdc(sourceNdc);
          vec2 outputOffsetPx = (outputNdc - vLensOutputCentre) * uLensFramebufferPx * 0.5;
          float d = length(outputOffsetPx) / max(vLensTargetDiameterPx, 1e-6);
          float falloff;
          int samplesPerAxis = int(vLensSamplesPerAxis + 0.5);
          if (samplesPerAxis <= 1) {
            if (d > 0.5) discard;
            falloff = 1.0 - smoothstep(0.2, 0.5, d);
          } else {
            float n = float(samplesPerAxis);
            float invD = 1.0 / max(vLensTargetDiameterPx, 1e-6);
            float sum = 0.0;
            for (int a = 0; a < ${POINT_SPRITE_MAX_SAMPLES_PER_AXIS}; a++) {
              if (a >= samplesPerAxis) break;
              vec2 row = outputOffsetPx + vLensSourceToOutputPx.xy * ((float(a) + 0.5) / n - 0.5);
              for (int b = 0; b < ${POINT_SPRITE_MAX_SAMPLES_PER_AXIS}; b++) {
                if (b >= samplesPerAxis) break;
                vec2 o = row + vLensSourceToOutputPx.zw * ((float(b) + 0.5) / n - 0.5);
                sum += 1.0 - smoothstep(0.2, 0.5, length(o) * invD);
              }
            }
            falloff = sum / (n * n);
            if (falloff <= 0.0) discard;
          }
`;

/** The two lines of three's stock shaders the splices below replace. Pinned by
 * lensShader.test.ts against the installed three: `String.replace` with a
 * missing needle is a silent no-op, and the symptom (every marker sprite and
 * décor line drifting off its body toward the frame edge under the lens) is
 * only ever caught by eye. */
export const SPRITE_CLIP_ANCHOR = 'gl_Position = projectionMatrix * mvPosition;';
export const LINE_CLIP_ANCHOR = 'gl_Position = clip;';

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
        SPRITE_CLIP_ANCHOR,
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
        LINE_CLIP_ANCHOR,
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
