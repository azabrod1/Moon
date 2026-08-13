import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

const ROUND_CAP_DISCARD = 'if ( len2 > 1.0 ) discard;';

/**
 * Remove LineMaterial's round end caps from a connected map polyline.
 *
 * Line2 draws every segment as its own quad. Its stock round caps extend past
 * both endpoints, so at every internal vertex two translucent caps overlap and
 * blend twice — the evenly spaced bright ticks visible along the map's orbit
 * arcs. Butt caps make the segment rectangles meet at the shared endpoint
 * without overdraw. At the map's 180-segment tessellation the tiny outer-bend
 * notch is far below a pixel.
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
