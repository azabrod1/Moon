import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

const ROUND_CAP_DISCARD = 'if ( len2 > 1.0 ) discard;';

/**
 * Remove LineMaterial's round end caps from a connected map polyline.
 *
 * Line2 draws every segment as its own quad. Its stock round caps extend past
 * both endpoints, so at every internal vertex two translucent caps overlap and
 * blend twice — the evenly spaced bright ticks visible along the map's orbit
 * arcs. Butt caps make the segment rectangles meet at the shared endpoint
 * without overdraw. At the map's 96/180-segment tessellations the tiny
 * outer-bend notch is far below a pixel. The polylines this applies to must
 * CLOSE exactly (their fill sites pinch the seam shut): an exposed open end
 * loses the halfwidth of padding its round cap used to give it.
 *
 * Fail loudly when a Three.js upgrade changes the shader anchor instead of
 * silently bringing the artifact back.
 */
export function applyMapOrbitButtCaps(material: LineMaterial): LineMaterial {
  const fragment = material.fragmentShader;
  const first = fragment.indexOf(ROUND_CAP_DISCARD);
  if (first === -1 || fragment.indexOf(ROUND_CAP_DISCARD, first + 1) !== -1) {
    throw new Error('map orbit-line shader cap anchor not found exactly once');
  }
  material.fragmentShader = fragment.replace(ROUND_CAP_DISCARD, 'discard;');
  material.customProgramCacheKey = () => 'map-orbit-butt-caps-v1';
  return material;
}

/**
 * The map's planet-orbit line material. depthTest ON: a true-sized globe
 * writes depth, so the line dies at the limb and re-emerges past it — a body
 * occludes its own orbit. No depth write: the lines must never occlude each
 * other or the sprites. Vertex colours carry the per-vertex direction fade.
 */
export function createMapPlanetOrbitMaterial(opacity: number): LineMaterial {
  return applyMapOrbitButtCaps(new LineMaterial({
    linewidth: 1.5,
    vertexColors: true,
    transparent: true,
    opacity,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
  }));
}

/**
 * A moon system's orbit-ring material: same depth contract as the planet
 * orbits, tinted from the moon's catalog colour. At half opacity the stock
 * round caps' joint overlap blends to 1.5x brightness — ticks every segment —
 * so the butt-cap patch matters most here.
 */
export function createMapMoonRingMaterial(color: number, opacity: number): LineMaterial {
  return applyMapOrbitButtCaps(new LineMaterial({
    color,
    linewidth: 1,
    transparent: true,
    opacity,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
  }));
}
