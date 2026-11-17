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

  // The per-star checks below gather the stars that fail and hold them to none
  // once, the first ten named: an expect per attribute of 25,000 stars was a
  // fifth of a million calls and most of this file's time.

  it('places every star on the camera-centred sphere', () => {
    const pos = geo.getAttribute('position');
    const off: string[] = [];
    for (let i = 0; i < pos.count; i++) {
      const r = Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i));
      // toBeCloseTo's 6 digits: closer than half of 1e-6.
      if (!(Math.abs(MAP_STAR_SPHERE_RADIUS - r) < 0.5e-6) && off.length < 10) off.push(`star ${i} at radius ${r}`);
    }
    expect(off).toEqual([]);
  });

  it('keeps colours and alphas finite and in range', () => {
    const color = geo.getAttribute('color');
    const alpha = geo.getAttribute('alpha');
    const bad: string[] = [];
    for (let i = 0; i < alpha.count; i++) {
      const a = alpha.getX(i);
      const ok = Number.isFinite(color.getX(i)) && Number.isFinite(color.getY(i)) && Number.isFinite(color.getZ(i))
        && a > 0 && a <= 1;
      if (!ok && bad.length < 10) bad.push(`star ${i}: colour ${color.getX(i)}, ${color.getY(i)}, ${color.getZ(i)}, alpha ${a}`);
    }
    expect(bad).toEqual([]);
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
    const unlike: string[] = [];
    for (let i = 0; i < catalog.length; i++) {
      const star = catalog[i];
      const visual = starPointVisual(star.magnitude, faintestMag);
      const taper = starBeyondAnchorScale(star.magnitude);
      // toBeCloseTo's 6 digits on both attributes.
      const sizeOk = Math.abs(visual.sizePx - size.getX(i)) < 0.5e-6;
      const alphaOk = Math.abs(visual.alpha * taper - alpha.getX(i)) < 0.5e-6;
      if (!(sizeOk && alphaOk) && unlike.length < 10) {
        unlike.push(`star ${i} (mag ${star.magnitude}): size ${size.getX(i)} for ${visual.sizePx}, alpha ${alpha.getX(i)} for ${visual.alpha * taper}`);
      }
      if (taper < 1) tapered++;
    }
    expect(unlike).toEqual([]);
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
