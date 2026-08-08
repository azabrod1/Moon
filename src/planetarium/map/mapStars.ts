/**
 * The chart's star backdrop: the bright-star catalog as a camera-centred
 * sphere of GPU points behind everything the map draws.
 *
 * The map scene IS the J2000 equatorial frame, so the catalog drops in
 * through `raDecToVector` untransformed and the sky is truthful — Polaris
 * sits over the chart's pole, the Milky Way band crosses where it crosses,
 * and tipping the chart edge-on lays the ecliptic's constellations behind
 * the plane they belong to.
 *
 * The sphere is DIRECTIONAL, not positional: it re-centres on the camera
 * every frame, so its radius only has to sit between the clip planes in
 * every camera state (the map's near touches 1e-6 in a tight follow and its
 * far always reaches past the chart) — one chart unit does, everywhere.
 *
 * Compositing: the material is opaque-pass additive with depth fully off,
 * ordered before everything else. Depth-testing a camera-centred sphere
 * against the chart would paint stars OVER any body more than a radius away,
 * and the transparent pass runs after the globes — so the stars neither read
 * nor write depth and simply go down first; every disc, globe, line and
 * label paints over them. The corner chart never draws them at all: the
 * points live on their own layer only the full chart's camera enables, so
 * the fixed little frame stays the clean schematic it has always been.
 *
 * Brightness is raw shader-input parity with the planetarium's starfield:
 * same catalog, same `starPointVisual` sizes and alphas, same colours, same
 * pixel-ratio cap — the chart shows the one sky the app has, not a
 * map-flavoured rendition. (The planetarium additionally applies sun-glare
 * masking and adaptive exposure; the map fixes exposure at 1, so "parity"
 * means the shader inputs, not the final frame near the Sun.) Both knobs are
 * uniforms so the dev bridge can retune live without rebuilding the geometry.
 */
import * as THREE from 'three';
import { BRIGHT_STAR_CATALOG } from '../data/brightStars';
import { raDecToVector } from '../../astronomy/planetary';
import { getStarColor, starfieldFaintLimitMag } from '../world/starfield';
import { starPointVisual } from '../world/starPointMapping';

/** The layer the star points live on. The full chart's camera enables it;
 *  the corner chart's camera keeps the default layer and never sees them. */
export const MAP_STAR_LAYER = 1;

/** Sphere radius in chart units. Directional only — the sphere rides the
 *  camera — so the one job of this number is to sit inside every camera
 *  state's clip planes: above the deepest follow's near, below the far that
 *  always reaches past the chart. */
export const MAP_STAR_SPHERE_RADIUS = 1;

export interface MapStarParams {
  /** Multiplier on each star's planetarium alpha. */
  alphaMul: number;
  /** Multiplier on each star's planetarium point size (CSS px). */
  sizeMul: number;
}

// 1/1 is not a neutral placeholder — it is the point of the module: the
// same star the planetarium draws, at the same size and alpha. Anything
// quieter is a taste override that belongs on the knob, not in the default.
export const MAP_STAR_DEFAULTS: MapStarParams = {
  alphaMul: 1.0,
  sizeMul: 1.0,
};

/** gl_PointSize is framebuffer px; sizes are tuned in CSS px at ratio ≤ 2,
 *  the same cap the planetarium starfield draws under. */
export function mapStarPixelRatio(rendererPixelRatio: number): number {
  return Math.min(rendererPixelRatio, 2);
}

export function createMapStars(rendererPixelRatio: number): THREE.Points {
  // Sol is a body on the chart, not a backdrop star.
  const catalog = BRIGHT_STAR_CATALOG.filter((s) => s.magnitude > -10);
  const count = catalog.length;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const alphas = new Float32Array(count);
  const faintestMag = starfieldFaintLimitMag();

  for (let i = 0; i < count; i++) {
    const star = catalog[i];
    // The single chirality seam — the same call the planetarium sky makes,
    // so the two skies can never disagree.
    const p = raDecToVector(star.raDeg, star.decDeg, MAP_STAR_SPHERE_RADIUS);
    positions[i * 3] = p.x;
    positions[i * 3 + 1] = p.y;
    positions[i * 3 + 2] = p.z;
    const { brightness, sizePx, alpha } = starPointVisual(star.magnitude, faintestMag);
    const color = getStarColor(star.colorIndex);
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

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      pixelRatio: { value: mapStarPixelRatio(rendererPixelRatio) },
      alphaMul: { value: MAP_STAR_DEFAULTS.alphaMul },
      sizeMul: { value: MAP_STAR_DEFAULTS.sizeMul },
    },
    vertexShader: `
        attribute float size;
        attribute float alpha;
        uniform float pixelRatio;
        uniform float alphaMul;
        uniform float sizeMul;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = color;
          vAlpha = alpha * alphaMul;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = max(1.0, size * sizeMul * pixelRatio);
        }
      `,
    fragmentShader: `
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec2 offset = gl_PointCoord - 0.5;
          float d = length(offset);
          if (d > 0.5) discard;
          float falloff = 1.0 - smoothstep(0.2, 0.5, d);
          gl_FragColor = vec4(vColor, falloff * vAlpha);
          // The map renders straight to the backbuffer at its own exposure,
          // so tone mapping and the sRGB transform land here, exactly as the
          // planetarium starfield's no-bloom path does.
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    // Opaque-pass additive, depth fully off: drawn first by render order,
    // painted over by everything, never fighting the transparent ladder.
    transparent: false,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    vertexColors: true,
  });

  const points = new THREE.Points(geo, mat);
  points.renderOrder = -10;
  points.frustumCulled = false;
  points.layers.set(MAP_STAR_LAYER);
  return points;
}

/** Retune the backdrop live. Partial params land on the uniforms; null puts
 *  the defaults back. Returns what is now applied. */
export function setMapStarParams(
  points: THREE.Points,
  partial: Partial<MapStarParams> | null,
): MapStarParams {
  const mat = points.material as THREE.ShaderMaterial;
  const want = partial === null
    ? { ...MAP_STAR_DEFAULTS }
    : {
      alphaMul: partial.alphaMul ?? mat.uniforms.alphaMul.value as number,
      sizeMul: partial.sizeMul ?? mat.uniforms.sizeMul.value as number,
    };
  mat.uniforms.alphaMul.value = want.alphaMul;
  mat.uniforms.sizeMul.value = want.sizeMul;
  return want;
}
