import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { paintRing, STRIP_WIDTH } from '../planets/rings';
import { augmentSurfaceMaterial, RING_SHADOW_OPACITY_GLSL } from './surfaceShading';

// Mimics the subset of three's onBeforeCompile shader object we mutate, so the
// wiring can be exercised without a GL context.
function mockShader() {
  return {
    uniforms: {} as Record<string, unknown>,
    vertexShader: '#include <common>\nvoid main() {\n#include <begin_vertex>\n}',
    fragmentShader: '#include <common>\nvoid main() {\n#include <opaque_fragment>\n}',
  };
}

describe('augmentSurfaceMaterial', () => {
  it('returns a per-frame sun-direction uniform and installs an onBeforeCompile hook', () => {
    const mat = new THREE.MeshStandardMaterial();
    const fx = augmentSurfaceMaterial(mat, 'airless');
    expect(fx.uSunDirWorld.value).toBeInstanceOf(THREE.Vector3);
    expect(typeof mat.onBeforeCompile).toBe('function');
  });

  it('binds the live uniform ref into the shader and injects the night fill', () => {
    const mat = new THREE.MeshStandardMaterial();
    const fx = augmentSurfaceMaterial(mat, 'gas');
    const shader = mockShader();
    (mat.onBeforeCompile as (s: typeof shader, r: unknown) => void)(shader, null);

    // The object the mode updates each frame must be the one bound into the shader.
    expect(shader.uniforms.uSunDirWorld).toBe(fx.uSunDirWorld);
    expect(shader.uniforms.uSilhouette).toBe(fx.uSilhouette);
    expect(fx.uSilhouette.value).toBe(0);
    expect(shader.vertexShader).toContain('vSunViewDir = normalize');
    // Additive radiance must land at a real chunk, not silently no-op.
    expect(shader.fragmentShader).toContain('outgoingLight +=');
    expect(shader.fragmentShader).toContain('uSilhouette');
    expect(shader.fragmentShader).toContain('#include <opaque_fragment>');
  });

  // The augmentation is a string replace on three's own standard shader. If a
  // three release reworded either include, every replace would silently miss
  // and the whole surface treatment — night fill, ring shadow, moon transits,
  // limb darkening, the eclipse silhouette — would vanish with the tests still
  // green. These pin the two needles against the installed library.
  it('finds both of its anchors in the installed three standard shader', () => {
    expect(THREE.ShaderLib.standard.vertexShader).toContain('#include <begin_vertex>');
    expect(THREE.ShaderLib.standard.fragmentShader).toContain('#include <opaque_fragment>');
  });

  it('lands its added radiance ahead of <opaque_fragment> in the real source', () => {
    const mat = new THREE.MeshStandardMaterial();
    augmentSurfaceMaterial(mat, 'earth');
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    };
    (mat.onBeforeCompile as (s: typeof shader, r: unknown) => void)(shader, null);

    const added = shader.fragmentShader.indexOf('outgoingLight +=');
    const anchor = shader.fragmentShader.indexOf('#include <opaque_fragment>');
    expect(added).toBeGreaterThan(-1);
    // outgoingLight is only in scope up to <opaque_fragment>, which consumes it.
    expect(added).toBeLessThan(anchor);
    // The vertex varying must be written after three has computed `transformed`.
    expect(shader.vertexShader.indexOf('vSunViewDir ='))
      .toBeGreaterThan(shader.vertexShader.indexOf('#include <begin_vertex>'));
  });
});

// Saturn's cast ring shadow is traced through ringShadowOpacity(), a smooth
// analytic stand-in for the strip that planets/rings.ts actually paints. The
// two are written independently — a shared table would change the shader's
// shape — so the shadow only lines up with the ring that casts it while their
// band layouts agree. These measure the painted strip and check the shader's
// declared landmarks against it.
describe('ringShadowOpacity vs the painted Saturn strip', () => {
  /** Painted opacity at radial fraction t, taking the strongest of a few
   *  neighbouring texels so the painter's 4 % fine-structure speckle (which
   *  only ever darkens) cannot be mistaken for a gap. */
  const painted = (t: number): number => {
    const centre = Math.round(t * STRIP_WIDTH);
    let a = 0;
    for (let x = centre - 1; x <= centre + 1; x++) {
      a = Math.max(a, paintRing(Math.min(Math.max(x, 0), STRIP_WIDTH), 'saturn')[3] / 255);
    }
    return a;
  };

  /** The run of radial fractions around `t` where the painted strip stays
   *  under `level` — the painter's own gap, measured, not restated. */
  const gapAround = (t: number, level: number): [number, number] => {
    const step = 1 / STRIP_WIDTH;
    let lo = t;
    let hi = t;
    while (lo > step && painted(lo - step) < level) lo -= step;
    while (hi < 1 - step && painted(hi + step) < level) hi += step;
    return [lo, hi];
  };

  const glslNumber = (pattern: RegExp): number => {
    const found = pattern.exec(RING_SHADOW_OPACITY_GLSL);
    expect(found, `no match for ${pattern}`).not.toBeNull();
    return Number(found![1]);
  };

  const bRing = painted(0.4);
  const aRing = painted(0.75);

  it('puts its Cassini and Encke gaps inside the painted ones', () => {
    const cassini = glslNumber(/float cas = \(t - ([\d.]+)\)/);
    const cassiniWidth = glslNumber(/float cas = \(t - [\d.]+\) \/ ([\d.]+)/);
    const [casLo, casHi] = gapAround(cassini, bRing * 0.25);
    expect(painted(cassini)).toBeLessThan(bRing * 0.25);
    expect(cassini - cassiniWidth).toBeGreaterThanOrEqual(casLo);
    expect(cassini + cassiniWidth).toBeLessThanOrEqual(casHi);

    const encke = glslNumber(/float enk = \(t - ([\d.]+)\)/);
    const enckeWidth = glslNumber(/float enk = \(t - [\d.]+\) \/ ([\d.]+)/);
    const [enkLo, enkHi] = gapAround(encke, aRing * 0.25);
    expect(painted(encke)).toBeLessThan(aRing * 0.25);
    expect(encke - enckeWidth).toBeGreaterThanOrEqual(enkLo);
    expect(encke + enckeWidth).toBeLessThanOrEqual(enkHi);
  });

  it('thins its A ring across the painted B-to-A step', () => {
    const from = glslNumber(/mix\(1\.0, 0\.8, smoothstep\(([\d.]+),/);
    const to = glslNumber(/mix\(1\.0, 0\.8, smoothstep\([\d.]+, ([\d.]+),/);
    // The painter's A ring starts where the Cassini gap ends.
    const step = gapAround(0.6, bRing * 0.25)[1];
    expect(step).toBeGreaterThanOrEqual(from);
    expect(step).toBeLessThanOrEqual(to);
    expect(aRing).toBeLessThan(bRing);
  });

  it('ends its C-ring ramp and both edge falloffs where the painter does', () => {
    const cRingEnd = glslNumber(/mix\(0\.4, 1\.0, smoothstep\(0\.02, ([\d.]+), t\)\)/);
    expect(painted(cRingEnd - 0.01)).toBeLessThan(bRing);
    expect(painted(cRingEnd + 0.01)).toBeCloseTo(bRing, 5);

    const innerEdge = glslNumber(/a \*= smoothstep\(0\.0, ([\d.]+), t\);/);
    expect(painted(0)).toBeLessThan(bRing * 0.02);
    expect(painted(innerEdge)).toBeGreaterThan(0);

    const outerEdge = glslNumber(/1\.0 - smoothstep\(([\d.]+), 1\.0, t\)/);
    expect(painted(outerEdge - 0.01)).toBeCloseTo(aRing, 5);
    expect(painted((outerEdge + 1) / 2)).toBeLessThan(aRing * 0.75);
    expect(painted(1)).toBeLessThan(aRing * 0.05);
  });
});
