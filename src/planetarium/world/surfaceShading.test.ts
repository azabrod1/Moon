import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  augmentSurfaceMaterial, OCEAN_ROUGHNESS, ROUGHNESS_MAP_LAND, ROUGHNESS_MAP_WATER,
  setSurfaceCraterShare, setSurfaceSynthesis, setSurfaceWaterGloss, surfaceChartWeights,
  SYNTH_CHART_CUT, surfaceCraterShare, surfaceReliefKind, surfaceSynthesisOf, surfaceWaterGloss,
  waterGlossRoughness,
  SYNTH_HEX_CUT,
  SYNTH_TRI,
  surfaceHexWeights,
  surfaceHexVertex,
  surfaceRungLayers,
  surfaceRungWeights,
  advanceSurfaceAir,
  settleSurfaceAir,
  bindSurfaceAir,
  clearSurfaceAir,
  createSurfaceAirFx,
  SURFACE_AIR_FADE_S,
  OCEAN_GLINT_CAP,
} from './surfaceShading';
import { surfaceDetailFieldMean, surfaceDetailHeightSpan } from './surfaceDetailNoise';
import { atmosphereParams } from './atmosphereModel';

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
    // Everything that takes one, not just the explicit four: two derivatives
    // for the surface direction, two for the screen frame the relief is built
    // on, and the two texel-density reads, each of which is an fwidth inside a
    // function. All six above the per-fragment branch, none below it.
    const takesOne = /(dFd[xy]|fwidth|synthTexelWeight)\(/g;
    expect(block.match(takesOne)).toHaveLength(6);
    expect(inner).not.toMatch(takesOne);
  });

  it('reads its own material\'s map, not a body-wide number', () => {
    // A streamed sector reports its own tile's size against its own UV, which
    // is what switches the term off over a resident tile while the coarse globe
    // one pixel away keeps it. A body-wide scalar draws that boundary as a
    // rectangle.
    expect(fragment('airless')).toContain('synthTexelWeight(vMapUv, vec2(textureSize(map, 0)))');
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
      'synthTexelWeight(vBumpMapUv, vec2(textureSize(bumpMap, 0))), uSynthBumpFade)',
    );
  });

  it('counts a measured surface that is still in flight as bound', () => {
    // The Moon's and Mars's elevation maps are requested at load and bound
    // whenever the fetch lands. Read literally, the seconds in between are a
    // surface with nothing bound — full invented relief, taken away again the
    // frame the real map arrives.
    const mat = new THREE.MeshStandardMaterial();
    augmentSurfaceMaterial(mat, 'airless', undefined, 0, undefined, undefined, 'Moon');
    expect(surfaceReliefKind(mat)).toBe('none');
    mat.userData.hasRealNormal = true;
    expect(surfaceReliefKind(mat)).toBe('measured');
    // And it outranks a painted bump: a body that will wear a measurement is
    // never given craters of its own, however long the fetch takes.
    const painted = new THREE.Texture();
    painted.userData.proceduralRelief = true;
    mat.bumpMap = painted;
    expect(surfaceReliefKind(mat)).toBe('measured');
  });

  it('draws a resurfaced body its ground rather than impacts', () => {
    // Europa is the youngest solid surface known and Io has no impact crater on
    // it at all; drawn with the field at face value both come out cratered. The
    // whole field goes finer instead, so what is left reads as ground — and the
    // offset is added to the rung the fragment WANTS, before it is rounded, so
    // a share between the two rides the ordinary crossfade instead of stepping.
    const glsl = fragment('icy');
    const offset = glsl.indexOf('synthWanted += (1.0 - uSynthCraterShare) * 3.0;');
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeLessThan(glsl.indexOf('clamp(floor(synthWanted), 0.0, 12.0)'));
    // And it reaches the shader per body.
    const mat = new THREE.MeshStandardMaterial();
    const u = uniforms('icy', 'Europa', mat);
    expect(u.uSynthCraterShare.value).toBe(1);
    setSurfaceCraterShare(mat, 0);
    expect(u.uSynthCraterShare.value).toBe(0);
    expect(surfaceCraterShare(mat)).toBe(0);
  });

  it('stops climbing rungs where a float stops being able to name one', () => {
    // The rung multiplies the chart's coordinates, so its ulp grows with it: at
    // twelve it is a quarter of a texel of the field, at fourteen a whole one,
    // and past that the ground is drawn in steps. A camera standing on a
    // surface can reach it; cruise cannot. The cap lands before the floor is
    // taken, so the top is rung twelve alone and the crossfade never selects
    // a thirteenth.
    expect(fragment('airless')).toContain('synthWanted = min(synthWanted, 12.0);');
    expect(fragment('airless')).toContain('clamp(floor(synthWanted), 0.0, 12.0)');
  });

  it('never runs on a surface class it is authored to nothing for', () => {
    // A gas giant has no ground to grain and Earth's is mostly ocean, so both
    // are authored to zero — and both are bodies a player hangs close to. Left
    // to ease, every fragment of them would take four derivatives, the chart
    // weights and up to six fetches of a 1×1 stand-in to multiply the surface
    // by exactly one.
    for (const archetype of ['gas', 'earth', 'cloud'] as const) {
      const mat = new THREE.MeshStandardMaterial();
      const u = uniforms(archetype, 'Jupiter', mat);
      setSurfaceSynthesis(mat, 1, 'none');
      expect(u.uSynthEnvelope.value).toBe(0);
    }
    // And it does run where there is ground.
    const moon = new THREE.MeshStandardMaterial();
    const u = uniforms('airless', 'Rhea', moon);
    setSurfaceSynthesis(moon, 1, 'none');
    expect(u.uSynthEnvelope.value).toBe(1);
  });

  it('says what a surface carries, not what its uniforms came out as', () => {
    // A class that draws no relief at all holds its gain at zero whatever is
    // bound, so reading the kind back off the uniforms would report every gas
    // giant and every cloud deck as wearing a measured surface.
    const gas = new THREE.MeshStandardMaterial();
    augmentSurfaceMaterial(gas, 'gas', undefined, 0, undefined, undefined, 'Jupiter');
    expect(surfaceReliefKind(gas)).toBe('none');
    setSurfaceSynthesis(gas, 1, surfaceReliefKind(gas));
    // Its envelope is held at zero by the class (the term is authored to
    // nothing there); what it must not do is claim a surface it does not wear.
    expect(surfaceSynthesisOf(gas)).toEqual({ envelope: 0, relief: 'none' });
    // And a body that really does wear one still says so.
    const moon = new THREE.MeshStandardMaterial();
    augmentSurfaceMaterial(moon, 'airless', undefined, 0, undefined, undefined, 'Moon');
    moon.normalMap = new THREE.Texture();
    setSurfaceSynthesis(moon, 1, surfaceReliefKind(moon));
    expect(surfaceSynthesisOf(moon)?.relief).toBe('measured');
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
      // Every point is covered, and the shares' SQUARES add to exactly one:
      // the charts carry independent noise, so it is their variance that has to
      // add up. An uncovered point would be a hole in the ground, and a short
      // sum would be a patch of it drawn fainter than the ground around it.
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
    // And the shader is drawing what was just walked: the same cut, hinged the
    // same way, normalised in LENGTH. Everything above is a property of this
    // function, and worth nothing if the GLSL sums its weights instead.
    const glsl = fragment('airless');
    expect(glsl).toContain(`max(abs(synthDir) - ${SYNTH_CHART_CUT.toFixed(4)}, 0.0)`);
    expect(glsl).toContain('synthChartW *= synthChartW;');
    expect(glsl).toContain('synthChartW / max(length(synthChartW)');
  });

  it('reads the field against its own mean, so the grain adds no light', () => {
    // The field's plain sits two thirds of the way up a range its craters set,
    // so a grain centred on the middle of that range would brighten every
    // magnified surface by a few per cent before it varied anything.
    const u = uniforms('airless', 'Moon');
    expect(u.uSynthMid.value).toBeCloseTo(surfaceDetailFieldMean(), 12);
    expect(fragment('airless')).toContain('return vec3(s.r - uSynthMid, swap ? g.yx : g);');
    // And nothing is bound to read on a surface class that never draws it.
    expect(uniforms('gas', 'Jupiter').uSynthMid.value).toBe(0);
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

describe('the field\'s tiling lattice', () => {
  function fragment(): string {
    const mat = new THREE.MeshStandardMaterial();
    augmentSurfaceMaterial(mat, 'airless', undefined, 0, undefined, undefined, 'Rhea');
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: '#include <common>\n#include <begin_vertex>\n',
      fragmentShader: '#include <common>\n#include <normal_fragment_maps>\n#include <opaque_fragment>\n',
    };
    (mat.onBeforeCompile as (s: typeof shader, r: unknown) => void)(shader, null);
    return shader.fragmentShader;
  }

  it('gives every point a full-length weight and jumps nowhere', () => {
    // A tile laid the same way everywhere is a lattice of the same craters; a
    // tile laid differently per cell with a step at the cell's edge is a grid
    // of seams. So the blend has to be continuous everywhere, edges included,
    // and its weights' squares have to add to one everywhere, or a band of
    // ground would be drawn fainter than the ground beside it. Walked, not
    // argued: a per-vertex value blended along lines that cross many cells and
    // every kind of edge, and the largest step it ever takes.
    const phi = (vx: number, vy: number) => surfaceHexVertex(vx, vy, 0).shift[0] - 0.5;
    let worstJump = 0;
    let steps = 0;
    for (const [du, dv, u0, v0] of [[1, 0.37, 0.11, 0.42], [0.2, 1, 0.9, 0.3], [1, -1, 0.5, 0.5], [0.57735027, 1, 0, 0]]) {
      let prev: number | null = null;
      for (let i = 0; i <= 20000; i++) {
        const t = i * 0.002;
        const { vertices, weights } = surfaceHexWeights(u0 + du * t, v0 + dv * t);
        expect(Math.hypot(...weights)).toBeCloseTo(1, 9);
        let blended = 0;
        for (let k = 0; k < 3; k++) blended += weights[k] * phi(vertices[k][0], vertices[k][1]);
        if (prev !== null) {
          worstJump = Math.max(worstJump, Math.abs(blended - prev));
          steps++;
        }
        prev = blended;
      }
    }
    // A step of 0.002 tiles moves a continuous blend by a few hundredths at
    // most; a seam would move it by the weight of a whole copy.
    expect(steps).toBeGreaterThan(70000);
    expect(worstJump).toBeLessThan(0.03);
    // The cut is what lets a copy leave the blend on a line, and what the
    // shader's skipped reads rest on: about half of a cell reads all three
    // copies (the inner triangle where every raw weight clears the cut, 0.7² of
    // the area), a corner around each vertex reads one, and the rest read two.
    let fewest = 3;
    let most = 0;
    let three = 0;
    const samples = 20000;
    for (let i = 0; i < samples; i++) {
      const { weights } = surfaceHexWeights((i % 141) * 0.0709 + i * 1e-5, Math.floor(i / 141) * 0.0473);
      const live = weights.filter((w) => w > 0).length;
      fewest = Math.min(fewest, live);
      most = Math.max(most, live);
      if (live === 3) three++;
    }
    expect(fewest).toBe(1);
    expect(most).toBe(3);
    expect(three / samples).toBeGreaterThan(0.44);
    expect(three / samples).toBeLessThan(0.54);
  });

  it('lays no two cells the same way', () => {
    // The point of the lattice is that neighbouring cells carry different
    // copies. A weak hash would leave the old lattice in place with a wobble.
    const N = 200;
    const bins = new Array(8).fill(0);
    const variants = new Set<string>();
    let sumXY = 0;
    let sumX = 0;
    let sumY = 0;
    let sumXX = 0;
    let sumYY = 0;
    for (let vx = -N / 2; vx < N / 2; vx++) {
      for (let vy = -N / 2; vy < N / 2; vy++) {
        const here = surfaceHexVertex(vx, vy, 0);
        const next = surfaceHexVertex(vx + 1, vy, 0);
        bins[Math.min(7, Math.floor(here.shift[0] * 8))]++;
        variants.add(`${here.flipX}${here.flipY}${here.swap}`);
        const x = here.shift[0];
        const y = next.shift[0];
        sumX += x; sumY += y; sumXY += x * y; sumXX += x * x; sumYY += y * y;
      }
    }
    const count = N * N;
    for (const b of bins) expect(b / count).toBeGreaterThan(0.125 * 0.94);
    for (const b of bins) expect(b / count).toBeLessThan(0.125 * 1.06);
    const cov = sumXY / count - (sumX / count) * (sumY / count);
    const varX = sumXX / count - (sumX / count) ** 2;
    const varY = sumYY / count - (sumY / count) ** 2;
    expect(Math.abs(cov / Math.sqrt(varX * varY))).toBeLessThan(0.02);
    expect(variants.size).toBe(8);
    // Deterministic — the same ground every session — and a different salt
    // gives a different lattice (each rung has its own).
    expect(surfaceHexVertex(17, -4, 0)).toEqual(surfaceHexVertex(17, -4, 0));
    expect(surfaceHexVertex(17, -4, 1).shift).not.toEqual(surfaceHexVertex(17, -4, 0).shift);
  });

  describe('the rung crossfade', () => {
    it('reads the same ground on both sides of a whole rung', () => {
      // The fine reading of rung r and the coarse reading of rung r+1 are one
      // reading — same scale, same salt — or every doubling of magnification
      // would re-arrange the whole field, and a still pose would carry a seam
      // along the contour where the wanted rung is whole.
      for (let rung = 0; rung < 12; rung++) {
        expect(surfaceRungLayers(rung).b).toEqual(surfaceRungLayers(rung + 1).a);
      }
      expect(surfaceRungLayers(3).a.salt).not.toBe(surfaceRungLayers(3).b.salt);
    });

    it('keeps the relief at full contrast between rungs', () => {
      // A mean of two independent readings has 0.707 of their contrast at the
      // midpoint; the weights are normalised in length like every other blend
      // in the term.
      for (const blend of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
        const [wa, wb] = surfaceRungWeights(blend);
        expect(Math.hypot(wa, wb)).toBeCloseTo(1, 12);
      }
      expect(surfaceRungWeights(0)).toEqual([1, 0]);
      expect(surfaceRungWeights(1)).toEqual([0, 1]);
    });

    it('is drawn as it was walked', () => {
      const text = fragment();
      expect(text).toContain('uint salt = uint(rung);');
      expect(text).toContain('vec3 a = synthTile(c * perUnit + seed, cx * perUnit, cy * perUnit, salt);');
      expect(text).toContain('if (blend > 0.0) b = synthTile(c * perUnit2 + seed, cx * perUnit2, cy * perUnit2, salt + 1u);');
      expect(text).toContain('vec2 rw = vec2(1.0 - blend, blend);');
      expect(text).toContain('rw /= length(rw);');
      expect(text).toContain('vec3 f = rw.x * a + rw.y * b;');
      expect(text).not.toContain('mix(a, b, blend)');
    });
  });

  it('is drawn as it was walked', () => {
    // Everything above is a property of the twin, and worth nothing if the
    // GLSL skews, cuts, sharpens or normalises differently.
    const glsl = fragment();
    expect(glsl).toContain(`const mat2 SYNTH_TRI = mat2(${SYNTH_TRI[0].toFixed(1)}, ${SYNTH_TRI[1].toFixed(1)}, ${SYNTH_TRI[2].toFixed(8)}, ${SYNTH_TRI[3].toFixed(8)});`);
    expect(glsl).toContain(`vec3 wc = max(w - ${SYNTH_HEX_CUT.toFixed(2)}, 0.0);`);
    expect(glsl).toContain('vec3 ws = wc * wc * wc;');
    expect(glsl).toContain('vec3 n = ws / len;');
    // Hashed on the vertex as an integer, never on the float coordinate.
    expect(glsl).toContain('highp uvec2 v = uvec2(ivec2(vertex));');
    // Three copies per rung, each read only where its weight is not zero.
    expect(glsl).toContain('if (wc.x > 0.0) c1 = synthCopy(uv, dx, dy, v1, salt);');
    expect(glsl).toContain('if (wc.y > 0.0) c2 = synthCopy(uv, dx, dy, v2, salt);');
    expect(glsl).toContain('if (wc.z > 0.0) c3 = synthCopy(uv, dx, dy, v3, salt);');
    // The gradient carries the weights' own slope, or every cell wears a facet.
    expect(glsl).toContain('vec2 dwp = vec2(dot(h, dnx), dot(h, dny));');
    // Explicit gradients on every read, and no derivative taken in here: the
    // reads sit under per-fragment conditions.
    const region = glsl.slice(glsl.indexOf('vec3 synthVertexShift('), glsl.indexOf('vec3 synthChart('));
    expect(region).not.toMatch(/dFd[xy]|fwidth/);
    expect(region).not.toMatch(/[^a-zA-Z]texture\(/);
    expect(region.split('textureGrad(uSynthDetail').length - 1).toBe(1);
  });
});

describe('the haze fade and the glint cap', () => {
  /** The injected fragment source through the same stub the file uses. */
  function fragmentOf(archetype: Parameters<typeof augmentSurfaceMaterial>[1]): string {
    const mat = new THREE.MeshStandardMaterial();
    augmentSurfaceMaterial(mat, archetype, undefined, 0, undefined, undefined, 'Rhea');
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: '#include <common>\n#include <begin_vertex>\n',
      fragmentShader: '#include <common>\n#include <normal_fragment_maps>\n#include <opaque_fragment>\n',
    };
    (mat.onBeforeCompile as (s: typeof shader, r: unknown) => void)(shader, null);
    return shader.fragmentShader;
  }

  it('fades a body\'s haze in over a moment when its tables first bind, and only then', () => {
    const air = createSurfaceAirFx();
    const tables = {
      transmittance: air.uTransmittance.value,
      scattering: air.uScattering.value,
      irradiance: air.uIrradiance.value,
      params: atmosphereParams('Earth'),
    } as Parameters<typeof bindSurfaceAir>[1];
    advanceSurfaceAir(air, 1);
    expect(air.uAirBlend.value).toBe(0);
    bindSurfaceAir(air, tables, 1, 1);
    expect(air.uAirDensity.value).toBe(1);
    expect(air.uAirBlend.value).toBe(0);
    advanceSurfaceAir(air, SURFACE_AIR_FADE_S / 2);
    expect(air.uAirBlend.value).toBeCloseTo(0.5, 6);
    // A rebind every frame, as the mode does, must not restart the fade.
    bindSurfaceAir(air, tables, 1, 1);
    expect(air.uAirBlend.value).toBeCloseTo(0.5, 6);
    advanceSurfaceAir(air, 10);
    expect(air.uAirBlend.value).toBe(1);
    clearSurfaceAir(air);
    expect(air.uAirBlend.value).toBe(0);
    // The A/B pin finishes the fade at once — but only for air that is on.
    settleSurfaceAir(air);
    expect(air.uAirBlend.value).toBe(0);
    bindSurfaceAir(air, tables, 1, 1);
    settleSurfaceAir(air);
    expect(air.uAirBlend.value).toBe(1);
  });

  it('is drawn as the twin fades it, and the sea hands bloom no more than the cap', () => {
    const text = fragmentOf('airless');
    expect(text).toContain('uniform float uAirBlend;');
    expect(text).toContain('outgoingLight = mix(outgoingLight, outgoingLight * airT + airS, uAirBlend);');
    expect(OCEAN_GLINT_CAP).toBeGreaterThan(1);
    expect(text).toContain(`outgoingLight -= glint - min(glint, vec3(${OCEAN_GLINT_CAP.toFixed(2)}));`);
  });
});
