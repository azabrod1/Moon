/**
 * Planetarium background starfield: the bright-star catalog projected onto a
 * fixed-radius celestial sphere as GPU points (per-vertex size + colour-index
 * tint). Pure builders — no scene or mode state.
 */
import * as THREE from 'three';
import { BRIGHT_STAR_CATALOG } from '../data/brightStars';
import { raDecToVector } from '../../astronomy/planetary';
import { createSunGlareMaskUniforms, sunGlareMaskGLSL } from './sunGlareMask';
import { starPointBrightness, starPointVisual } from './starPointMapping';

/** Celestial-sphere radius (AU) shared by the stars and the constellation
 *  overlay (Constellations.ts) — the lines must land on the stars. */
export const STAR_SPHERE_RADIUS = 85;

/** Magnitude of the catalog's dimmest rendered star — the anchor the faint-end
 *  fade ramps up to (shared by the moon dots so their faint-limit handoff lines
 *  up with the stars'). Sol (mag ≤ −10, drawn as a mesh) is excluded. */
export function starfieldFaintLimitMag(): number {
  let faintest = -Infinity;
  for (const s of BRIGHT_STAR_CATALOG) {
    if (s.magnitude > -10 && s.magnitude > faintest) faintest = s.magnitude;
  }
  return faintest;
}

/** Map a stellar colour index (B–V) to an approximate RGB tint. */
export function getStarColor(colorIndex: number): THREE.Color {
  const clamped = THREE.MathUtils.clamp(colorIndex, -0.3, 1.8);
  const t = (clamped + 0.3) / 2.1;
  const cool = new THREE.Color(0.55, 0.70, 1.0);
  const neutral = new THREE.Color(1.0, 0.97, 0.92);
  const warm = new THREE.Color(1.0, 0.68, 0.38);
  return t < 0.5
    ? cool.clone().lerp(neutral, t * 2)
    : neutral.clone().lerp(warm, (t - 0.5) * 2);
}

/**
 * The RGB a star's vertex actually receives: catalog tint × its magnitude
 * brightness (via the shared point mapping, so this equals the render path
 * below). Per-channel values can exceed 1, but the catalog's peak Rec.709
 * luminance stays under the bloom high-pass cutoff, so no star survives as a
 * bloom glint near the Sun (pinned by the invariant test alongside this file).
 */
export function starRenderColor(colorIndex: number, magnitude: number): THREE.Color {
  return getStarColor(colorIndex).multiplyScalar(starPointBrightness(magnitude));
}

/**
 * gl_PointSize is in framebuffer pixels, so a star that should read as N CSS px
 * must be sized N × the renderer's pixel ratio — the ratio the canvas is
 * actually drawn at, NOT window.devicePixelRatio (which the desktop renderer
 * clamps up to 1.5 and down to 2.5, so a DPR-1 desktop draws at 1.5× while
 * naive DPR sizing left the whole tuned hierarchy ~33% small). The ≤2 cap keeps
 * the point-size tuning: the sizes above were dialled against a ratio of 2.
 */
function starPixelRatio(rendererPixelRatio: number): number {
  return Math.min(rendererPixelRatio, 2);
}

/** Retune the star point size when the renderer's pixel ratio changes (DPR /
 *  monitor change, or a resize that reclamps it). */
export function setStarfieldPixelRatio(starfield: THREE.Points, rendererPixelRatio: number): void {
  const mat = starfield.material as THREE.ShaderMaterial;
  const uniform = mat.uniforms?.pixelRatio;
  if (uniform) uniform.value = starPixelRatio(rendererPixelRatio);
}

export function createPlanetariumStarfield(rendererPixelRatio: number): THREE.Points {
  // Filter out Sol (rendered as 3D mesh)
  const catalog = BRIGHT_STAR_CATALOG.filter((s) => s.magnitude > -10);
  const starCount = catalog.length;
  const positions = new Float32Array(starCount * 3);
  const colors = new Float32Array(starCount * 3);
  const sizes = new Float32Array(starCount);
  const alphas = new Float32Array(starCount);

  // Anchor the faint-end fade to the dimmest star actually in the catalog.
  const faintestMag = starfieldFaintLimitMag();

  for (let i = 0; i < starCount; i++) {
    const star = catalog[i];
    const color = getStarColor(star.colorIndex);
    // Magnitude → brightness/size/alpha through the shared point mapping (the
    // same one the moon dots use, so a moon dot is as visible as an equally
    // bright star). Spread lets constellation stars (mag 1-3) stand out; the
    // faintest taper down but stay ≥ 1px to avoid sub-pixel shimmer.
    const { brightness, sizePx, alpha } = starPointVisual(star.magnitude, faintestMag);

    // raDecToVector is the single chirality definition site — every sky
    // embedding routes through it (build-time allocation is fine here).
    const position = raDecToVector(star.raDeg, star.decDeg, STAR_SPHERE_RADIUS);
    positions[i * 3] = position.x;
    positions[i * 3 + 1] = position.y;
    positions[i * 3 + 2] = position.z;

    colors[i * 3] = color.r * brightness;
    colors[i * 3 + 1] = color.g * brightness;
    colors[i * 3 + 2] = color.b * brightness;

    sizes[i] = sizePx;
    alphas[i] = alpha;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
  geo.setAttribute('alpha', new THREE.BufferAttribute(alphas, 1));

  // Custom shader for per-vertex star size + opacity
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      pixelRatio: { value: starPixelRatio(rendererPixelRatio) },
      // The Sun's veiling glare fades stars sitting behind it. Inactive by
      // default (mask 0 -> alpha scale exactly 1), so stars render unchanged
      // until the controller drives these each frame.
      ...createSunGlareMaskUniforms(),
    },
    vertexShader: `
        attribute float size;
        attribute float alpha;
        varying vec3 vColor;
        varying float vAlpha;
        varying vec2 vLensOutputCentre;
        varying float vLensTargetDiameterPx;
        uniform float pixelRatio;
        ${sunGlareMaskGLSL()}
        void main() {
          vColor = color;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
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
          vAlpha = alpha * (1.0 - 0.98 * sunGlareMask(gl_Position));
        }
      `,
    fragmentShader: `
        varying vec3 vColor;
        varying float vAlpha;
        varying vec2 vLensOutputCentre;
        varying float vLensTargetDiameterPx;
        ${sunGlareMaskGLSL()}
        void main() {
          vec2 sourceNdc = gl_FragCoord.xy / uLensFramebufferPx * 2.0 - 1.0;
          vec2 outputNdc = lensWarpSourceNdc(sourceNdc);
          vec2 outputOffsetPx = (outputNdc - vLensOutputCentre) * uLensFramebufferPx * 0.5;
          float d = length(outputOffsetPx) / max(vLensTargetDiameterPx, 1e-6);
          if (d > 0.5) discard;
          float falloff = 1.0 - smoothstep(0.2, 0.5, d);
          gl_FragColor = vec4(vColor, falloff * vAlpha);
          // Exposure + ACES + sRGB when this material draws straight to screen
          // (the no-bloom path): the exposure that crushes the Sun's neighbours
          // must reach the stars too. Compiles to a no-op in the composer's
          // linear render target, so the bloom path is byte-identical.
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    transparent: true,
    depthWrite: false,
    vertexColors: true,
  });

  return new THREE.Points(geo, mat);
}
