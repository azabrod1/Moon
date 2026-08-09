import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  MAP_RING_RADII_AU,
  createMapDistanceRings,
  ringLabelPoints,
  ringLabelText,
} from './mapDistanceRings';
import { MAP_STAR_LAYER } from './mapStars';
import { ECLIPTIC_NORTH_EQUATORIAL } from '../../astronomy/planetary';
import { OBLIQUITY_DEG } from '../../astronomy/constants';
import { DEG2RAD } from '../../shared/math/angles';

const vertices = (): THREE.Vector3[] => {
  const attr = createMapDistanceRings().geometry.getAttribute('position');
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < attr.count; i++) out.push(new THREE.Vector3().fromBufferAttribute(attr, i));
  return out;
};

describe('the chart’s distance rings', () => {
  it('rings the radii the panel names', () => {
    expect([...MAP_RING_RADII_AU]).toEqual([1, 5, 10, 20, 30]);
    expect(MAP_RING_RADII_AU.map(ringLabelText)).toEqual(['1 AU', '5 AU', '10 AU', '20 AU', '30 AU']);
  });

  it('puts every vertex at its own ring’s radius', () => {
    const wanted = new Set(MAP_RING_RADII_AU.map((r) => r.toFixed(4)));
    for (const v of vertices()) expect(wanted.has(v.length().toFixed(4))).toBe(true);
  });

  it('lies in the ECLIPTIC plane, not the scene’s equatorial one', () => {
    for (const v of vertices()) {
      // Flat against the ecliptic pole. Measured as a FRACTION of the radius:
      // these vertices are Float32, so an absolute tolerance would tighten on
      // the 1 AU ring and loosen on the 30 AU one.
      expect(v.dot(ECLIPTIC_NORTH_EQUATORIAL) / v.length()).toBeCloseTo(0, 6);
    }
    // …and tilted out of the equatorial plane by the obliquity, which is the
    // proof the rotation was applied rather than skipped.
    const worstTilt = Math.max(...vertices().map((v) => Math.abs(v.y / v.length())));
    expect(worstTilt).toBeCloseTo(Math.sin(OBLIQUITY_DEG * DEG2RAD), 3);
  });

  it('is dashed by geometry, with the same dash count on every ring', () => {
    const perRing = vertices().length / MAP_RING_RADII_AU.length;
    expect(Number.isInteger(perRing)).toBe(true);
    // Two vertices per dash, and the gap is as long as the dash.
    const dashes = perRing / 2;
    const ring = vertices().slice(0, perRing);
    const dashArc = ring[0].angleTo(ring[1]);
    const slotArc = ring[0].angleTo(ring[2]);
    expect(dashes).toBeGreaterThan(50);
    expect(dashArc / slotArc).toBeCloseTo(0.5, 2);
  });

  it('hands out one label point per ring, at the ring’s radius, built once', () => {
    const points = ringLabelPoints();
    expect(points).toHaveLength(MAP_RING_RADII_AU.length);
    points.forEach((p, i) => expect(p.length()).toBeCloseTo(MAP_RING_RADII_AU[i], 9));
    // The chart projects these every frame the layer is on: a fresh vector per
    // ring per frame is exactly the allocation a steady chart must not make.
    expect(ringLabelPoints()).toBe(points);
    expect(ringLabelPoints()[0]).toBe(points[0]);
  });

  it('stays off the corner chart, and off until asked for', () => {
    const rings = createMapDistanceRings();
    expect(rings.layers.isEnabled(MAP_STAR_LAYER)).toBe(true);
    expect(rings.layers.isEnabled(0)).toBe(false);
    expect(rings.visible).toBe(false);
    const mat = rings.material as THREE.LineBasicMaterial;
    // Furniture, like the orbit lines: a body in front of a ring occludes it,
    // and the ring occludes nothing.
    expect(mat.depthTest).toBe(true);
    expect(mat.depthWrite).toBe(false);
    expect(mat.opacity).toBeLessThan(0.3);
  });
});
