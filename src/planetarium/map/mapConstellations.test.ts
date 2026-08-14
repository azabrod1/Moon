import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createMapConstellations } from './mapConstellations';
import { createMapStars, MAP_STAR_LAYER, MAP_STAR_SPHERE_RADIUS } from './mapStars';
import { constellationSegmentPositions } from '../data/constellationGeometry';
import { loadBrightStarCatalogFromDisk } from '../data/brightStarsTestCatalog';

// The snap and the star backdrop both read the catalog store; fill it the
// way the app's loader would before anything asks.
loadBrightStarCatalogFromDisk();

describe('the chart’s constellation figures', () => {
  it('draws the shared snap at the chart’s own sphere radius', () => {
    const lines = createMapConstellations();
    const attr = lines.geometry.getAttribute('position');
    const expected = constellationSegmentPositions(MAP_STAR_SPHERE_RADIUS);
    expect(attr.count * 3).toBe(expected.length);
    expect(Array.from(attr.array as Float32Array)).toEqual(Array.from(expected));
  });

  it('puts every vertex on the sphere the stars are on', () => {
    const attr = createMapConstellations().geometry.getAttribute('position');
    const v = new THREE.Vector3();
    for (let i = 0; i < attr.count; i++) {
      v.fromBufferAttribute(attr, i);
      expect(v.length()).toBeCloseTo(MAP_STAR_SPHERE_RADIUS, 5);
    }
  });

  it('sorts in the OPAQUE pass, ahead of the stars', () => {
    const lines = createMapConstellations();
    const stars = createMapStars(1);
    const mat = lines.material as THREE.LineBasicMaterial;
    // The whole compositing contract in one place. transparent:true would sort
    // these into the transparent queue — which runs after the opaque one — and
    // the figures would paint over the very stars they run between, whatever
    // renderOrder said.
    expect(mat.transparent).toBe(false);
    expect(mat.blending).toBe(THREE.AdditiveBlending);
    expect(mat.depthTest).toBe(false);
    expect(mat.depthWrite).toBe(false);
    expect(lines.renderOrder).toBeLessThan(stars.renderOrder);
  });

  it('is additive, so the colour carries the faintness', () => {
    const mat = createMapConstellations().material as THREE.LineBasicMaterial;
    // No alpha to dial in an additive pass: the world's hue times the world's
    // opacity, pre-multiplied. What matters is that it is dim and blue.
    expect(mat.color.b).toBeGreaterThan(mat.color.r);
    expect(mat.color.b).toBeLessThan(0.3);
  });

  it('stays off the corner chart, and off until asked for', () => {
    const lines = createMapConstellations();
    expect(lines.layers.isEnabled(MAP_STAR_LAYER)).toBe(true);
    expect(lines.layers.isEnabled(0)).toBe(false);
    expect(lines.visible).toBe(false);
    expect(lines.frustumCulled).toBe(false);
  });
});
