/**
 * Planetarium background starfield: the bright-star catalog projected onto a
 * fixed-radius celestial sphere as GPU points (per-vertex size + colour-index
 * tint). Pure builders — no scene or mode state.
 */
import * as THREE from 'three';
import { BRIGHT_STAR_CATALOG } from '../data/brightStars';
import { raDecToVector } from '../../astronomy/planetary';
import { SUN_GLARE_MASK_MAX_KILL, createSunGlareMaskUniforms, sunGlareMaskGLSL } from './sunGlareMask';
import {
  STAR_FAINT_ANCHOR_MAG,
  starBeyondAnchorScale,
  starPointBrightness,
  starPointVisual,
} from './starPointMapping';

/** Celestial-sphere radius (AU) shared by the stars and the constellation
 *  overlay (Constellations.ts) — the lines must land on the stars. */
export const STAR_SPHERE_RADIUS = 85;

/** The magnitude the faint-end fade ramps up to, shared by the moon dots so
 *  their faint-limit handoff lines up with the stars'. Pinned rather than read
 *  off the catalog — see STAR_FAINT_ANCHOR_MAG. */
export function starfieldFaintLimitMag(): number {
  return STAR_FAINT_ANCHOR_MAG;
}

/** Telescope light grasp: how much the surface view's narrow field lifts the
 *  faint end. 1 leaves the field exactly as built. */
export function setStarfieldGain(starfield: THREE.Points, gain: number): void {
  const mat = starfield.material as THREE.ShaderMaterial;
  const uniform = mat.uniforms?.uStarGain;
  if (uniform) uniform.value = gain;
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

  // The fade is anchored to a fixed magnitude, not to the catalog's dimmest
  // star, so deepening the catalog cannot re-light the field that is already up.
  const faintestMag = STAR_FAINT_ANCHOR_MAG;

  for (let i = 0; i < starCount; i++) {
    const star = catalog[i];
    const color = getStarColor(star.colorIndex);
    // Magnitude → brightness/size/alpha through the shared point mapping (the
    // same one the moon dots use, so a moon dot is as visible as an equally
    // bright star). Spread lets constellation stars (mag 1-3) stand out; the
    // faintest taper down but stay ≥ 1px to avoid sub-pixel shimmer.
    const { brightness, sizePx, alpha } = starPointVisual(star.magnitude, faintestMag);
    // Stars past the anchor sit at the ramp's floor opacity; this keeps them
    // easing quietly downward from there instead of forming a flat new layer.
    const faintAlpha = alpha * starBeyondAnchorScale(star.magnitude);

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
    alphas[i] = faintAlpha;
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
      // Telescope light grasp, driven only by the surface view's narrow field.
      // Exactly 1 everywhere else, where it is a no-op on every star.
      uStarGain: { value: 1 },
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
        uniform float uStarGain;
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
          // Gain lifts the faint end on a soft knee, 1-(1-a)^g: alpha 1 stays 1
          // (no star climbs over the bloom cutoff the field is built to stay
          // under), the map is strictly monotone in alpha, so the magnitude
          // ordering survives every gain — a hard min() collapsed the whole
          // catalog to opacity 1 below a ~13-degree field. Branched so an
          // ungained frame is byte-identical, not merely pow-identical.
          float gained = uStarGain > 1.001
            ? 1.0 - pow(1.0 - alpha, uStarGain)
            : alpha;
          vAlpha = gained
            * (1.0 - ${SUN_GLARE_MASK_MAX_KILL.toFixed(2)} * sunGlareMask(gl_Position));
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
