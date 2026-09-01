import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  augmentSurfaceMaterial, OCEAN_ROUGHNESS, ROUGHNESS_MAP_LAND, ROUGHNESS_MAP_WATER,
  setSurfaceSynthesis, setSurfaceWaterGloss, surfaceChartWeights, surfaceReliefKind,
  surfaceSynthesisOf, surfaceWaterGloss, waterGlossRoughness,
} from './surfaceShading';
import { surfaceDetailHeightSpan } from './surfaceDetailNoise';

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
});

describe('the ocean gloss remap', () => {
  it('leaves land where the map put it and pulls open water to the authored gloss', () => {
    expect(waterGlossRoughness(ROUGHNESS_MAP_LAND)).toBeCloseTo(ROUGHNESS_MAP_LAND, 12);
    expect(waterGlossRoughness(ROUGHNESS_MAP_WATER)).toBeCloseTo(OCEAN_ROUGHNESS, 12);
  });

  it('keeps a coast\'s fraction a fraction rather than thresholding it', () => {
    // Half water by area in the map comes out half way down the new range too,
    // which is what stops the coastline reading as a hard edge in the glint.
    const half = (ROUGHNESS_MAP_LAND + ROUGHNESS_MAP_WATER) / 2;
    expect(waterGlossRoughness(half))
      .toBeCloseTo((ROUGHNESS_MAP_LAND + OCEAN_ROUGHNESS) / 2, 12);
  });

  it('is off until a material is told its roughness map is a water mask', () => {
    // The flat mid-grey a failed fetch leaves behind is not a water mask, and
    // remapping it would put an ocean's sheen on the whole planet.
    const mat = new THREE.MeshStandardMaterial();
    augmentSurfaceMaterial(mat, 'earth');
    expect(surfaceWaterGloss(mat)).toBe(false);
    const shader = mockShader();
    (mat.onBeforeCompile as (s: typeof shader, r: unknown) => void)(shader, null);
    expect((shader.uniforms.uWaterGloss as { value: number }).value).toBe(0);
    setSurfaceWaterGloss(mat, true);
    expect(surfaceWaterGloss(mat)).toBe(true);
    // The same object the shader already holds, so the switch reaches a
    // material that compiled before the map arrived.
    expect((shader.uniforms.uWaterGloss as { value: number }).value).toBeGreaterThan(0);
    setSurfaceWaterGloss(mat, false);
    expect((shader.uniforms.uWaterGloss as { value: number }).value).toBe(0);
  });
});

describe('the close-range detail term', () => {
  /** The injected fragment source, through the same stub the rest of this file
   *  uses — the real chunk names, no GL context. */
  function fragment(archetype: Parameters<typeof augmentSurfaceMaterial>[1], name = 'Rhea'): string {
    const mat = new THREE.MeshStandardMaterial();
    augmentSurfaceMaterial(mat, archetype, undefined, 0, undefined, undefined, name);
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: '#include <common>\n#include <begin_vertex>\n',
      fragmentShader: '#include <common>\n#include <normal_fragment_maps>\n#include <opaque_fragment>\n',
    };
    (mat.onBeforeCompile as (s: typeof shader, r: unknown) => void)(shader, null);
    return shader.fragmentShader;
  }

  function uniforms(
    archetype: Parameters<typeof augmentSurfaceMaterial>[1],
    name = 'Rhea',
    mat = new THREE.MeshStandardMaterial(),
  ): Record<string, { value: unknown }> {
    augmentSurfaceMaterial(mat, archetype, undefined, 0, undefined, undefined, name);
    const shader = {
      uniforms: {} as Record<string, { value: unknown }>,
      vertexShader: '#include <common>\n#include <begin_vertex>\n',
      fragmentShader: '#include <common>\n#include <normal_fragment_maps>\n#include <opaque_fragment>\n',
    };
    (mat.onBeforeCompile as (s: typeof shader) => void)(shader);
    return shader.uniforms;
  }

  it('perturbs the normal upstream of every light', () => {
    // The one place a perturbed normal exists and nothing has read it yet.
    // Moved after the lighting, it would shade this file's own night terms and
    // leave three's lights on a smooth sphere.
    const glsl = fragment('airless');
    expect(glsl.indexOf('normal = normalize(synthNrm - synthSurfGrad'))
      .toBeGreaterThan(glsl.indexOf('#include <normal_fragment_maps>'));
    expect(glsl.indexOf('normal = normalize(synthNrm - synthSurfGrad'))
      .toBeLessThan(glsl.indexOf('#include <opaque_fragment>'));
  });

  it('takes every derivative in uniform control flow', () => {
    // A derivative under a per-fragment condition is undefined, and the fade is
    // exactly such a condition: a driver that takes the licence picks the wrong
    // rung and the wrong mip wherever a quad straddles the fade.
    const glsl = fragment('airless');
    const block = glsl.slice(
      glsl.indexOf('if (uSynthEnvelope > 0.0) {'),
      glsl.indexOf('if (synthW > 0.0) {'),
    );
    const inner = glsl.slice(glsl.indexOf('if (synthW > 0.0) {'), glsl.indexOf('#include <opaque_fragment>'));
    // Two for the surface direction and two for the screen frame the relief is
    // built on.
    expect(block.match(/dFd[xy]\(/g)).toHaveLength(4);
    expect(inner).not.toMatch(/dFd[xy]\(/);
  });

  it('reads its own material\'s map, not a body-wide number', () => {
    // A streamed sector reports its own tile's size against its own UV, which
    // is what switches the term off over a resident tile while the coarse globe
    // one pixel away keeps it. A body-wide scalar draws that boundary as a
    // rectangle.
    expect(fragment('airless')).toContain('smoothTexelWeight(vMapUv, vec2(textureSize(map, 0)))');
  });

  it('is one text for every body, only the uniforms differing', () => {
    // Materials share compiled programs; a define or a per-body variant here
    // would fork the cache per body and per tier.
    expect(fragment('airless', 'Rhea')).toBe(fragment('icy', 'Mimas'));
    expect(fragment('gas', 'Jupiter')).toBe(fragment('airless', 'Rhea'));
    expect(fragment('airless')).not.toContain('#define');
  });

  it('gives every body its own ground, and the same ground every session', () => {
    const rhea = uniforms('icy', 'Rhea').uSynthSeed.value as THREE.Vector2;
    const mimas = uniforms('icy', 'Mimas').uSynthSeed.value as THREE.Vector2;
    const rheaAgain = uniforms('icy', 'Rhea').uSynthSeed.value as THREE.Vector2;
    expect(rhea.equals(rheaAgain)).toBe(true);
    expect(rhea.equals(mimas)).toBe(false);
  });

  it('never fades in on a surface that has no ground to grain', () => {
    // A gas giant has no surface, Earth's is mostly ocean, and the cloud deck
    // is not ground at all.
    for (const archetype of ['gas', 'earth', 'cloud'] as const) {
      const u = uniforms(archetype, 'Jupiter');
      expect((u.uSynthGrain.value as number)).toBe(0);
      expect((u.uSynthRelief.value as number)).toBe(0);
    }
    // And it starts at rest everywhere, including where it will be used: the
    // body's owner eases it in, nothing switches it on.
    expect(uniforms('airless', 'Moon').uSynthEnvelope.value).toBe(0);
  });

  it('holds relief back wherever a measured surface is already bound', () => {
    // Two sets of craters under one Sun is what a doubled relief looks like,
    // and where the first set is real the second one is an invention over a
    // measurement.
    const mat = new THREE.MeshStandardMaterial();
    const u = uniforms('airless', 'Moon', mat);
    expect(surfaceSynthesisOf(mat)?.relief).toBe('none');
    mat.normalMap = new THREE.Texture();
    expect(surfaceReliefKind(mat)).toBe('measured');
    setSurfaceSynthesis(mat, 0.5, surfaceReliefKind(mat));
    expect(surfaceSynthesisOf(mat)).toEqual({ envelope: 0.5, relief: 'measured' });
    expect(u.uSynthRelief.value).toBe(0);
    // The grain is not held back with it — a surface that has run out of map
    // still has grain to put back, whatever else is bound.
    expect(u.uSynthGrain.value).toBeGreaterThan(0);
  });

  it('lets relief in under a painted bump, gated on that painting\'s own texels', () => {
    // A crater bump the app invented is not a measurement, and past the density
    // where its own texels stretch over a pixel it is interpolation. Finer
    // invented craters in its place say nothing the coarse ones did not.
    const mat = new THREE.MeshStandardMaterial();
    const u = uniforms('airless', 'Rhea', mat);
    const painted = new THREE.Texture();
    painted.userData.proceduralRelief = true;
    mat.bumpMap = painted;
    expect(surfaceReliefKind(mat)).toBe('painted');
    setSurfaceSynthesis(mat, 1, surfaceReliefKind(mat));
    expect(surfaceSynthesisOf(mat)).toEqual({ envelope: 1, relief: 'painted' });
    expect(u.uSynthRelief.value).toBeGreaterThan(0);
    expect(u.uSynthBumpFade.value).toBe(1);
    // And the gate is the bump map's OWN density, on the same band as the
    // colour fade — not the colour map's, which is a different map at a
    // different width.
    expect(fragment('airless')).toContain(
      'smoothTexelWeight(vBumpMapUv, vec2(textureSize(bumpMap, 0))), uSynthBumpFade)',
    );
  });

  it('draws its field on charts with no pole and a bounded stretch', () => {
    // A longitude/latitude domain pinches to a point at each pole, where a cell
    // is a sliver and its longitudinal slope is however many times steeper the
    // pinch makes it — a pinwheel of radial streaks across a polar view. The
    // flat charts that replace it have to cover the whole sphere with none of
    // that, which is these two numbers at every point of it.
    let worstStretch = 1;
    let mostCharts = 0;
    let leastCharts = 3;
    for (let i = 0; i < 20000; i++) {
      // A deterministic spiral over the sphere, so every corner and every
      // diagonal between two charts is visited.
      const z = 1 - (2 * i + 1) / 20000;
      const r = Math.sqrt(Math.max(1 - z * z, 0));
      const phi = i * 2.399963229728653;
      const dir: [number, number, number] = [r * Math.cos(phi), r * Math.sin(phi), z];
      const w = surfaceChartWeights(dir);
      // Every point is covered, and the charts' variances add to exactly one:
      // an uncovered point would be a hole in the ground and a short sum would
      // be a patch of it drawn fainter than the ground around it.
      expect(Math.hypot(...w)).toBeCloseTo(1, 12);
      const drawn = w.filter((x) => x > 0).length;
      mostCharts = Math.max(mostCharts, drawn);
      leastCharts = Math.min(leastCharts, drawn);
      // How stretched the ground this point is drawn on really is: each chart's
      // own stretch, weighted by the share of the field it carries.
      let stretch = 0;
      for (let a = 0; a < 3; a++) if (w[a] > 0) stretch += w[a] * w[a] * (1 / Math.abs(dir[a]));
      worstStretch = Math.max(worstStretch, stretch);
    }
    // Three charts meet on a diagonal, one covers a face on its own, and the
    // stretch is worst on that diagonal — the 54.7° a cube's corner sits at.
    expect(leastCharts).toBe(1);
    expect(mostCharts).toBe(3);
    expect(worstStretch).toBeLessThan(1.74);
  });

  it('draws craters no deeper than the field was built with', () => {
    // The relief uniform is a gain on the field's own geometry, so an
    // exaggeration is a number someone chose rather than a number that drifted.
    const mat = new THREE.MeshStandardMaterial();
    augmentSurfaceMaterial(mat, 'airless', undefined, 0, undefined, undefined, 'Moon');
    const relief = (uniforms('airless', 'Moon', mat).uSynthRelief.value as number);
    expect(relief).toBeCloseTo(surfaceDetailHeightSpan(), 12);
  });
});
