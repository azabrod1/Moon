import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  createMapStars,
  setMapStarParams,
  MAP_STAR_DEFAULTS,
  MAP_STAR_LAYER,
  MAP_STAR_SPHERE_RADIUS,
  mapStarPixelRatio,
} from './mapStars';
import { loadBrightStarCatalogFromDisk } from '../data/brightStarsTestCatalog';

const BRIGHT_STAR_CATALOG = loadBrightStarCatalogFromDisk();
import { starfieldFaintLimitMag } from '../world/starfield';
import { starBeyondAnchorScale, starPointVisual } from '../world/starPointMapping';

describe('the map star backdrop', () => {
  const stars = createMapStars(2);
  const geo = stars.geometry as THREE.BufferGeometry;

  it('carries every catalog star except Sol', () => {
    const expected = BRIGHT_STAR_CATALOG.filter((s) => s.magnitude > -10).length;
    expect(geo.getAttribute('position').count).toBe(expected);
    expect(expected).toBeGreaterThan(1000);
  });

  it('places every star on the camera-centred sphere', () => {
    const pos = geo.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const r = Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i));
      expect(r).toBeCloseTo(MAP_STAR_SPHERE_RADIUS, 6);
    }
  });

  it('keeps colours and alphas finite and in range', () => {
    const color = geo.getAttribute('color');
    const alpha = geo.getAttribute('alpha');
    for (let i = 0; i < alpha.count; i++) {
      expect(Number.isFinite(color.getX(i))).toBe(true);
      expect(Number.isFinite(color.getY(i))).toBe(true);
      expect(Number.isFinite(color.getZ(i))).toBe(true);
      const a = alpha.getX(i);
      expect(a).toBeGreaterThan(0);
      expect(a).toBeLessThanOrEqual(1);
    }
  });

  it('composites as a backdrop: depth off, drawn first, own layer', () => {
    const mat = stars.material as THREE.ShaderMaterial;
    expect(mat.depthTest).toBe(false);
    expect(mat.depthWrite).toBe(false);
    expect(mat.transparent).toBe(false);
    expect(mat.blending).toBe(THREE.AdditiveBlending);
    expect(stars.renderOrder).toBeLessThan(0);
    expect(stars.frustumCulled).toBe(false);
    expect(stars.layers.mask).toBe(1 << MAP_STAR_LAYER);
  });

  it('writes the exact per-star attributes the planetarium starfield derives', () => {
    // Parity is an ATTRIBUTE claim, not a range claim: every star's size and
    // alpha must equal the shared mapping's answer — including the faint-tail
    // taper past the ramp's anchor, which the planetarium multiplies in and a
    // range test cannot see missing.
    const catalog = BRIGHT_STAR_CATALOG.filter((s) => s.magnitude > -10);
    const faintestMag = starfieldFaintLimitMag();
    const size = geo.getAttribute('size');
    const alpha = geo.getAttribute('alpha');
    let tapered = 0;
    for (let i = 0; i < catalog.length; i++) {
      const star = catalog[i];
      const visual = starPointVisual(star.magnitude, faintestMag);
      const taper = starBeyondAnchorScale(star.magnitude);
      expect(size.getX(i)).toBeCloseTo(visual.sizePx, 6);
      expect(alpha.getX(i)).toBeCloseTo(visual.alpha * taper, 6);
      if (taper < 1) tapered++;
    }
    // The taper must actually bind for part of the catalog, or this test
    // would pass with the factor deleted.
    expect(tapered).toBeGreaterThan(0);
  });

  it('defaults to literal parity with the planetarium sky', () => {
    // Pinned as literals on purpose: the restore test below compares against
    // MAP_STAR_DEFAULTS itself, so it would pass for ANY constants. Parity —
    // the same shader inputs the planetarium starfield draws — is the
    // product decision, and this is where it is written down.
    expect(MAP_STAR_DEFAULTS).toEqual({ alphaMul: 1, sizeMul: 1 });
  });

  it('retunes through the knob and restores on null', () => {
    const fresh = createMapStars(2);
    const mat = fresh.material as THREE.ShaderMaterial;
    const tuned = setMapStarParams(fresh, { alphaMul: 0.2 });
    expect(tuned).toEqual({ alphaMul: 0.2, sizeMul: MAP_STAR_DEFAULTS.sizeMul });
    expect(mat.uniforms.alphaMul.value).toBe(0.2);
    const restored = setMapStarParams(fresh, null);
    expect(restored).toEqual({ ...MAP_STAR_DEFAULTS });
    expect(mat.uniforms.alphaMul.value).toBe(MAP_STAR_DEFAULTS.alphaMul);
  });

  it('caps the point-size ratio at 2, the tuning cap', () => {
    expect(mapStarPixelRatio(1)).toBe(1);
    expect(mapStarPixelRatio(3)).toBe(2);
  });
});
