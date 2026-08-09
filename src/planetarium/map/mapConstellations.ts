/**
 * The chart's constellation figures: the same 88 shapes the planetarium's sky
 * draws, on the same camera-centred sphere as the chart's stars.
 *
 * The geometry comes from the shared snap (`data/constellationGeometry`), so
 * the two skies cannot disagree about where a figure runs; only the
 * compositing is local.
 *
 * Compositing: opaque-pass additive with depth fully off, ordered BEFORE the
 * stars. This is not a style choice — a `transparent: true` material sorts
 * into the transparent queue, which runs after the opaque one, so the lines
 * would paint over the very stars they are meant to run between no matter what
 * renderOrder said. Additive in the opaque pass is how the star sphere itself
 * sorts first, and the figures go down one order earlier still, exactly as the
 * world draws its figures under its stars.
 *
 * Additive means the colour IS the intensity: there is no alpha to dial, so
 * the hue is pre-multiplied by the same faintness the world's overlay gets
 * from its opacity.
 *
 * The sphere is DIRECTIONAL like the stars' — re-centred on the camera every
 * frame — and lives on the map's star layer, so the corner chart (whose camera
 * never enables that layer) stays the clean schematic it has always been.
 */
import * as THREE from 'three';
import { constellationSegmentPositions } from '../data/constellationGeometry';
import { MAP_STAR_LAYER, MAP_STAR_SPHERE_RADIUS } from './mapStars';

/** The world sky's figure hue, and how faint it is drawn there. Additive
 *  compositing has no opacity to apply them separately, so they arrive here as
 *  one pre-scaled colour. */
const LINE_COLOR = 0x6688bb;
const LINE_INTENSITY = 0.28;

/** One order ahead of the stars (−10): the figures are what the stars are
 *  drawn ON, so they go down first. */
const RENDER_ORDER = -11;

export function createMapConstellations(): THREE.LineSegments {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(constellationSegmentPositions(MAP_STAR_SPHERE_RADIUS), 3),
  );

  const material = new THREE.LineBasicMaterial({
    color: new THREE.Color(LINE_COLOR).multiplyScalar(LINE_INTENSITY),
    transparent: false,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
  });

  const lines = new THREE.LineSegments(geometry, material);
  lines.renderOrder = RENDER_ORDER;
  lines.frustumCulled = false;
  lines.layers.set(MAP_STAR_LAYER);
  // Off until the chart's own layer switch asks for them.
  lines.visible = false;
  return lines;
}
