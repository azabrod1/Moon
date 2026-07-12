/**
 * Planetarium background starfield: the bright-star catalog projected onto a
 * fixed-radius celestial sphere as GPU points (per-vertex size + colour-index
 * tint). Pure builders — no scene or mode state.
 */
import * as THREE from 'three';
import { BRIGHT_STAR_CATALOG } from '../data/brightStars';
import { raDecToVector } from '../../astronomy/planetary';

/** Celestial-sphere radius (AU) shared by the stars and the constellation
 *  overlay (Constellations.ts) — the lines must land on the stars. */
export const STAR_SPHERE_RADIUS = 85;

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
 * Per-star brightness multiplier from apparent magnitude — brighter stars ride
 * higher, with a floor so the faint field keeps a visible tint. Per-channel
 * results can exceed 1.0, but the catalog's peak Rec.709 luminance stays under
 * the bloom high-pass cutoff so no star survives as a bloom glint near the Sun
 * (pinned in the test alongside this file).
 */
export function starBrightness(magnitude: number): number {
  return THREE.MathUtils.clamp(1.2 - (magnitude + 1.44) / 8, 0.25, 1.2);
}

/** Final RGB a star's vertex receives: tint × brightness, per channel. */
export function starRenderColor(colorIndex: number, magnitude: number): THREE.Color {
  return getStarColor(colorIndex).multiplyScalar(starBrightness(magnitude));
}

/**
 * Faint-end shaping. Dimmer stars get lower opacity and smaller points, so the
 * dense faint layer recedes into fine texture and stops reading as a flat wall
 * of identical specks. The fade ramps over the FAINT_FADE_RANGE_MAG magnitudes
 * leading up to the catalog's faintest star, so a wide span pulls down the
 * dimmer part of the whole field, not only the near-limit stars; stars brighter
 * than that span keep full size and opacity. The window anchors to the actual
 * faintest star so it tracks the catalog if the limit changes. Opacity carries
 * the dimming; point size stays at or above 1px so stars read as crisp dots
 * even at the limit.
 */
const FAINT_FADE_RANGE_MAG = 1.6; // fade-ramp width (mags up to the faint limit); larger dims more of the field
const FAINT_MIN_ALPHA = 0.45; // opacity of the faintest stars (never 0 — keep a hint)
const FAINT_MIN_SIZE_SCALE = 0.8; // faintest stars shrink to this × base size (then clamped >= 1px)

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
  let faintestMag = -Infinity;
  for (const s of catalog) if (s.magnitude > faintestMag) faintestMag = s.magnitude;
  const fadeStartMag = faintestMag - FAINT_FADE_RANGE_MAG;

  for (let i = 0; i < starCount; i++) {
    const star = catalog[i];
    const color = starRenderColor(star.colorIndex, star.magnitude);

    // 0 for the bright/mid field, ramping to 1 at the catalog's faint limit.
    const faint = THREE.MathUtils.clamp(
      (star.magnitude - fadeStartMag) / FAINT_FADE_RANGE_MAG,
      0,
      1,
    );

    // raDecToVector is the single chirality definition site — every sky
    // embedding routes through it (build-time allocation is fine here).
    const position = raDecToVector(star.raDeg, star.decDeg, STAR_SPHERE_RADIUS);
    positions[i * 3] = position.x;
    positions[i * 3 + 1] = position.y;
    positions[i * 3 + 2] = position.z;

    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;

    // Spread so constellation stars (mag 1-3) stand out from dim ones; the
    // faintest taper down but stay >= 1px to avoid sub-pixel shimmer.
    const baseSize = THREE.MathUtils.clamp(6.0 - star.magnitude * 1.1, 1.2, 6.5);
    sizes[i] = Math.max(1.0, THREE.MathUtils.lerp(baseSize, baseSize * FAINT_MIN_SIZE_SCALE, faint));

    // Opacity is the main faint-end lever: the dense faint layer recedes
    // instead of reading as white noise.
    alphas[i] = THREE.MathUtils.lerp(1.0, FAINT_MIN_ALPHA, faint);
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
    },
    vertexShader: `
        attribute float size;
        attribute float alpha;
        varying vec3 vColor;
        varying float vAlpha;
        uniform float pixelRatio;
        void main() {
          vColor = color;
          vAlpha = alpha;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          gl_PointSize = size * pixelRatio;
        }
      `,
    fragmentShader: `
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - vec2(0.5));
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
