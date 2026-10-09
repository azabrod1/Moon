import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { paintRing, STRIP_WIDTH } from '../planets/rings';
import {
  augmentSurfaceMaterial, OCEAN_ROUGHNESS, ROUGHNESS_MAP_LAND, ROUGHNESS_MAP_WATER,
  SEA_PAINT_COLOUR, SEA_WATER_COLOUR, parseSeaColourParam, seaColourOn, seaColourUniforms, setSeaColourEnabled,
  SEA_SKY_GRAZING_COS, parseSeaSkyParam, seaSkyOn, setSeaSkyEnabled, SEA_WATER_IOR,
  setSurfaceCraterShare, setSurfaceSynthesis, setSurfaceWaterGloss, surfaceChartWeights,
  SYNTH_CHART_CUT, surfaceCraterShare, surfaceReliefKind, surfaceSynthesisOf, surfaceWaterGloss,
  waterGlossRoughness,
  SYNTH_HEX_CUT,
  SYNTH_TRI,
  surfaceHexWeights,
  surfaceHexVertex,
  surfaceStackWeights,
  SYNTH_STACK_DEPTH,
  SYNTH_STACK_TAPER,
  SYNTH_STACK_GAIN,
  advanceSurfaceAir,
  settleSurfaceAir,
  bindSurfaceAir,
  clearSurfaceAir,
  createSurfaceAirFx,
  seatSurfaceAirRadius,
  SURFACE_AIR_FADE_S,
  OCEAN_BEAM_CAP,
  OCEAN_BEAM_KNEE,
  OCEAN_GLINT_CAP,
  RING_SHADOW_OPACITY_GLSL,
  SEA_WATER_F0,
  rebindSeaWindMap,
  seaWindOn,
  seaWindUniforms,
  setDevOceanRoughness,
  setSeaWindEnabled,
  CLOUD_SHADOW_AIR,
  CLOUD_SHADOW_AIR_GRAZE,
  CLOUD_SHADOW_DEPTH,
  CLOUD_SHADOW_GAMMA,
  CLOUD_SHADOW_HORIZON_SIN,
  CLOUD_SHADOW_SKY_FILL,
  CLOUD_LIGHT_SKY,
  CLOUD_LIGHT_WRAP,
  cloudLightOn,
  cloudLightShared,
  setPlanetariumCloudDeck,
  surfaceCloudLightCompiled,
  cloudShadowShared,
  cloudShadowsOn,
  setGroundUnderCloudDeck,
  surfaceCloudShadowCompiled,
  seaBeamOn,
  setSeaBeamEnabled,
  foamAlbedoInForce, parseFoamParam, parseWhitecapsParam, setFoamAlbedo, setWhitecapsEnabled, whitecapsOn,
} from './surfaceShading';
import {
  COX_MUNK_SLOPE_CALM, COX_MUNK_SLOPE_PER_MS, SEA_WIND_MAX_MS, installSeaWindMap,
  seaWindTextureFrom, WHITECAP_ALBEDO, WHITECAP_COVER_COEFFICIENT, whitecapCoverage,
} from './seaWind';
import { createSectorMaterial } from './sectorMaterial';
import { setCloudFieldOn } from './cloudFieldSlots';
import { CLOUD_TOP_KM, cloudCoverageAlpha } from './cloudDeck';
import { resolveDefine } from '../testing/glslDefine';
import { NIGHT_WEIGHT_ZERO_SIN } from './nightSources';
import { PLANETS } from '../planets/planetData';
import { surfaceDetailFieldMean, surfaceDetailHeightSpan } from './surfaceDetailNoise';
import { atmosphereParams } from './atmosphereModel';
import { earthNightFragmentShader } from '../../shared/shaders/atmosphere';
import { setPerfSwitch } from '../../app/perfSwitches';

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
      glsl.indexOf('if (GROUND_ON(uSynthEnvelope > 0.0)) {'),
      glsl.indexOf('if (synthW > 0.0) {'),
    );
    // The branch's own block only — the terms after it (the sea's cloud
    // shadow) sit in uniform branches of their own and answer for their own
    // derivatives.
    const open = glsl.indexOf('if (synthW > 0.0) {');
    let depth = 0;
    let close = open;
    for (let i = open; i < glsl.length; i++) {
      if (glsl[i] === '{') depth++;
      else if (glsl[i] === '}' && --depth === 0) { close = i + 1; break; }
    }
    expect(close).toBeGreaterThan(open);
    const inner = glsl.slice(open, close);
    // Everything that takes one, not just the explicit four: two derivatives
    // for the surface direction, two for the screen frame the relief is built
    // on, and the two texel-density reads, each of which is an fwidth inside a
    // function. All six above the per-fragment branch, none inside it.
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
    // The one block of defines is the deck's archetype macros, which read the
    // uniform everywhere but on the deck's own program (cloudDeck.test pins
    // the block itself); nothing else in the text is a define. The block may
    // nest one conditional of its own (a ground compiled with the cloud field
    // knows it is not the deck), so it ends at the #endif after its last line.
    const text = fragment('airless');
    const groundOn = '#define GROUND_ON(x) (x)';
    const macros = text.slice(
      text.indexOf('#ifdef CLOUD_DECK'),
      text.indexOf('#endif', text.indexOf(groundOn)) + '#endif'.length,
    );
    expect(macros).toContain(groundOn);
    expect(text.replace(macros, '')).not.toContain('#define');
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
    // offset is added to the rung the fragment WANTS, before it is clamped, so
    // a share between the two slides the whole stack instead of stepping it.
    const glsl = fragment('icy');
    const offset = glsl.indexOf('synthWanted += (1.0 - uSynthCraterShare) * 3.0;');
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeLessThan(glsl.indexOf('synthWanted = clamp(synthWanted, 0.0, 12.0);'));
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
    expect(fragment('airless')).toContain('synthWanted = clamp(synthWanted, 0.0, 12.0);');
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

  describe('the rung stack', () => {
    it('draws every rung below the wanted one in cruise, so craters belong to the ground', () => {
      // A single rung chosen per pixel is chosen by the pixel's footprint on
      // the ground, which grows as the ground tilts away — the same ground
      // wore one set of craters at the disc centre and another near the limb.
      // With the stack below the wanted rung always drawn, a viewing angle
      // only decides how fine the field gets.
      for (const wanted of [0, 0.5, 2, 3.7, 5, SYNTH_STACK_DEPTH - 1]) {
        const rungs = surfaceStackWeights(wanted).map((r) => r.rung);
        expect(rungs[0]).toBe(0);
        expect(rungs).toEqual(rungs.map((_, i) => i));
        expect(rungs[rungs.length - 1]).toBe(Number.isInteger(wanted) ? wanted : Math.floor(wanted) + 1);
      }
    });

    it('fades a rung in at the top and out at the bottom, and never steps', () => {
      let prev = surfaceStackWeights(0);
      for (let wanted = 0.02; wanted <= 12; wanted = +(wanted + 0.02).toFixed(2)) {
        const next = surfaceStackWeights(wanted);
        const rungs = new Set([...prev, ...next].map((r) => r.rung));
        for (const rung of rungs) {
          const a = prev.find((r) => r.rung === rung)?.weight ?? 0;
          const b = next.find((r) => r.rung === rung)?.weight ?? 0;
          expect(Math.abs(a - b)).toBeLessThan(0.06);
        }
        prev = next;
      }
    });

    it('holds the field at one variance, lifted by the gain, and bounds the reads', () => {
      for (const wanted of [0, 0.3, 1, 4.5, 6.9, 9, 12]) {
        const w = surfaceStackWeights(wanted);
        expect(Math.hypot(...w.map((r) => r.weight))).toBeCloseTo(SYNTH_STACK_GAIN, 12);
        expect(w.length).toBeLessThanOrEqual(SYNTH_STACK_DEPTH + 1);
      }
    });

    it('keeps the finest rung at its own contrast and tapers the ones below it', () => {
      // Equal weights would leave the small craters at half of what one rung
      // drew them at; the taper keeps them, and the deep stack's finest whole
      // rung comes out at one.
      const deep = surfaceStackWeights(9);
      const top = deep.find((r) => r.rung === 9)!.weight;
      expect(top).toBeCloseTo(1, 1);
      for (let k = 1; k < deep.length; k++) {
        if (deep[k].rung > 9) continue;
        expect(deep[k].weight / deep[k - 1].weight).toBeCloseTo(1 / SYNTH_STACK_TAPER, 6);
      }
      // Never fainter than the single rung was, at any magnification.
      for (const wanted of [0, 0.5, 1.2, 2, 3.5, 6]) {
        const w = surfaceStackWeights(wanted);
        expect(w.find((r) => r.rung === Math.floor(wanted))!.weight).toBeGreaterThan(0.85);
      }
    });

    it('slides its coarse end only past the depth, and stops at rung twelve', () => {
      expect(surfaceStackWeights(SYNTH_STACK_DEPTH - 1)[0].rung).toBe(0);
      expect(surfaceStackWeights(SYNTH_STACK_DEPTH + 2)[0].rung).toBeGreaterThan(0);
      const top = surfaceStackWeights(12);
      expect(top[top.length - 1].rung).toBe(12);
    });

    it('is drawn as it was walked', () => {
      const text = fragment();
      expect(text).toContain(`float coarse = wanted - ${(SYNTH_STACK_DEPTH - 1).toFixed(1)};`);
      expect(text).toContain('float lo = max(floor(coarse), 0.0);');
      expect(text).toContain(`for (int k = 0; k <= ${SYNTH_STACK_DEPTH}; k++) {`);
      expect(text).toContain('float w = clamp(min(wanted - rung + 1.0, rung - coarse + 1.0), 0.0, 1.0);');
      expect(text).toContain('f += w * synthTile(c * perUnit + seed, cx * perUnit, cy * perUnit, uint(rung));');
      expect(text).toContain(`w *= pow(${SYNTH_STACK_TAPER.toFixed(2)}, max(wanted - rung, 0.0));`);
      expect(text).toContain(`f *= ${SYNTH_STACK_GAIN.toFixed(6)} / sqrt(max(norm, 1e-12));`);
      expect(text).toContain('synthWanted);');
      expect(text).not.toContain('synthBlend');
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

  it('compiles none of the beam with the two energy-chain switches off', () => {
    // SUN_PATH and SEA_BEAM are compile-time defines on every augmented
    // surface, on by default. A uniform select would compile both chains into
    // one program and the ground would pay for the beam's terms whether or
    // not it used them; with the defines off the preprocessor leaves the old
    // expressions and nothing else, so either kill switch is the program it
    // was.
    const mat = new THREE.MeshStandardMaterial();
    augmentSurfaceMaterial(mat, 'earth', undefined, 0, undefined, undefined, 'Earth');
    expect(mat.defines?.SUN_PATH).toBe('');
    expect(mat.defines?.SEA_BEAM).toBe('');
    const text = resolveDefine(resolveDefine(fragmentOf('earth'), 'SEA_BEAM', false), 'SUN_PATH', false);
    expect(text).not.toMatch(/SEA_BEAM|SUN_PATH|uSeaBeam|uSunPath/);
    expect(text).not.toContain('seaBeckmannVis(seaAlpha');
    expect(text).not.toContain('sunPathR');
    expect(text).not.toContain('beamHeld');
    expect(text).not.toContain('gl_FragColor.a = 1.0 - 2.0 * seaWater;');
    expect(text).toContain('vec3 sunPath = vec3(1.0);');
    expect(text).toContain('float seaBeamVis = seaVis;');
    expect(text).toContain('vec3 limbHeld = vec3(0.0);');
    expect(text).toContain(`seaGlint = min(seaGlintFull, vec3(${import.meta.env.DEV ? 'uGlintCap' : OCEAN_GLINT_CAP.toFixed(2)}));`);
    // A flip relinks: the define leaves the material, and needsUpdate (which
    // three counts in `version`) sends the program key with it.
    const version = mat.version;
    setSeaBeamEnabled(false);
    expect(mat.defines?.SEA_BEAM).toBeUndefined();
    expect(mat.version).toBeGreaterThan(version);
    setSeaBeamEnabled(true);
    expect(mat.defines?.SEA_BEAM).toBe('');
    expect(seaBeamOn()).toBe(true);
  });

  it('cuts the cloud-shadowed glint from the capped term, never below zero', () => {
    // The two terms meet in one body: the cap first, then the deck's shadow on
    // the mirror term. The shadow must cut from what the cap left, or under
    // cloud the light goes negative and bloom paints a coloured core. Read with
    // the cloud shadow's define off, the arm every surface compiles by default.
    const frag = resolveDefine(fragmentOf('airless'), 'CLOUD_SHADOW', false);
    expect(frag).toContain(`vec3 seaGlintFull = glintRaw * (seaFresnel * seaLobe${import.meta.env.DEV ? ' * uGlintKeep' : ''});`);
    // Two chains, one compiled: the old cap before the air, the beam's
    // shoulder after it, selected by the SEA_BEAM define.
    expect(frag).toContain(`#ifdef SEA_BEAM\n    seaGlint = seaGlintFull;\n#else\n    seaGlint = min(seaGlintFull, vec3(${
      import.meta.env.DEV ? 'uGlintCap' : OCEAN_GLINT_CAP.toFixed(2)}));\n#endif`);
    expect(frag).toContain(`vec3 beamKnee = vec3(${import.meta.env.DEV ? 'uBeamKnee' : OCEAN_BEAM_KNEE.toFixed(2)});`);
    expect(frag).toContain(`vec3 beamRange = vec3(${import.meta.env.DEV ? 'uBeamCap' : OCEAN_BEAM_CAP.toFixed(2)}) - beamKnee;`);
    // The mirror term stays live through everything that scales the light, so
    // the shoulder after the air shapes the share that reached the camera.
    expect(frag).toContain('seaGlint *= cloudSunKeep;');
    expect(frag).toContain('seaGlint *= sunVisible;');
    expect(frag).toContain('#ifdef SEA_BEAM\n    vec3 limbHeld = seaGlint;\n#else\n    vec3 limbHeld = vec3(0.0);\n#endif');
    expect(frag).toContain('seaGlint = mix(seaGlint, seaGlint * airT, airWeight);');
    expect(frag).toContain('outgoingLight -= seaGlint - beamHeld;');
    // The sea's flag for the bloom: after three's opaque write, the ground
    // only, water negative, so the bright pass hands the blur none of it.
    expect(frag).toContain('#include <opaque_fragment>\n#ifdef SEA_BEAM\n  if (GROUND_ON(uWaterGloss > 0.0)) gl_FragColor.a = 1.0 - 2.0 * seaWater;\n#endif');
    // The Sun's own path, on the direct terms of every surface, before the sea
    // reads its mirror term, and normalised to the zenith.
    expect(frag.indexOf('reflectedLight.directSpecular *= sunPath;')).toBeLessThan(frag.indexOf('vec3 glintRaw = reflectedLight.directSpecular;'));
    // Body scope, so a later term that reads the Sun's irradiance for itself
    // (the deck's cloud light) can take the same factor.
    expect(frag).toContain('vec3 sunPath = vec3(1.0);\n#ifdef SUN_PATH\n  if (uAirDensity > 0.0 && dot(normal, normalize(vSunViewDir)) > 0.0) {');
    expect(frag).toContain('/ max(getTransmittanceToSun(uTransmittance, sunPathR, 1.0), vec3(1e-4));');
    expect(frag).toContain('outgoingLight -= seaGlint * (1.0 - cloudSunKeep);');
    expect(frag).not.toMatch(/reflectedLight\.directSpecular \* cloudCoverage/);
    // The beam's share through the deck is one value, read from the map once
    // and only under the one named condition; the sea's cut fetches nothing.
    expect(frag).toContain('float cloudSunKeep = 1.0;');
    expect(frag).toContain('if (cloudTapWanted) {');
    expect(frag).toContain('cloudSunKeep = 1.0 - cloudCoverage(deckLum);');
    expect(frag.split('textureGrad(uCloudShadowMap').length - 1).toBe(1);
    // The cut follows the read inside the same branch. Moved to a second
    // branch on the same uniform it is the same arithmetic, but Metal under
    // ANGLE compiled that shape to a frame one bit off at a lit fragment.
    expect(frag).toMatch(
      /cloudSunKeep = 1\.0 - cloudCoverage\(deckLum\);\n {4}\}\n(?: {4}\/\/[^\n]*\n)* {4}outgoingLight -= seaGlint \* \(1\.0 - cloudSunKeep\);/);
  });

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

  it('seats the body radius on the air the moment it exists, so the deck\'s bump reads it before any tables bind', () => {
    // The air lookups are gated on the density and never read the radius
    // while the air is off; the cloud deck's detail bump is not gated. At the
    // default of 1 its 3 km of relief came out as 70,000 km, and clouds drew
    // black on every device whose atmosphere bake was unavailable.
    const radiusAU = 4.26e-5;
    const air = createSurfaceAirFx();
    expect(air.uPlanetRadius.value).toBe(1);
    seatSurfaceAirRadius(air, radiusAU);
    expect(air.uPlanetRadius.value).toBe(radiusAU);
    // The off-air paths leave it alone, and a bind states the same number.
    clearSurfaceAir(air);
    expect(air.uPlanetRadius.value).toBe(radiusAU);
    const tables = {
      transmittance: air.uTransmittance.value,
      scattering: air.uScattering.value,
      irradiance: air.uIrradiance.value,
      params: atmosphereParams('Earth'),
    } as Parameters<typeof bindSurfaceAir>[1];
    bindSurfaceAir(air, tables, radiusAU, 1);
    expect(air.uPlanetRadius.value).toBe(radiusAU);
    expect(air.uAirDensity.value).toBe(1);
    // The deck shares the globe's fx, and its program binds that very object:
    // what the globe seats is what the deck's bump multiplies by.
    const globe = new THREE.MeshStandardMaterial();
    const fx = augmentSurfaceMaterial(globe, 'earth');
    seatSurfaceAirRadius(fx.air, radiusAU);
    const deck = new THREE.MeshStandardMaterial({ transparent: true });
    augmentSurfaceMaterial(deck, 'cloud', undefined, undefined, fx);
    const shader = mockShader();
    (deck.onBeforeCompile as (s: typeof shader, r: unknown) => void)(shader, null);
    expect(shader.uniforms.uPlanetRadius).toBe(fx.air.uPlanetRadius);
    expect((shader.uniforms.uPlanetRadius as { value: number }).value).toBe(radiusAU);
    expect((shader.uniforms.uCloudDeck as { value: number }).value).toBe(1);
  });

  it('is drawn as the twin fades it, and the sea hands bloom no more than the cap', () => {
    const text = fragmentOf('airless');
    expect(text).toContain('uniform float uAirBlend;');
    // The fade and the body's grade on a direct view are one weight, and the
    // haze is applied once behind it.
    expect(text).toContain('float airWeight = uAirBlend * aerialHazeWeight(seg, uSurfaceHaze);');
    expect(text).toContain('outgoingLight = mix(outgoingLight, outgoingLight * airT + airS, airWeight);');
    expect(OCEAN_GLINT_CAP).toBeGreaterThan(1);
    expect(text).toContain(`vec3 seaGlintFull = glintRaw * (seaFresnel * seaLobe${import.meta.env.DEV ? ' * uGlintKeep' : ''});`);
    expect(text).toContain(`#else\n    seaGlint = min(seaGlintFull, vec3(${
      import.meta.env.DEV ? 'uGlintCap' : OCEAN_GLINT_CAP.toFixed(2)}));\n#endif`);
    expect(text).toContain('outgoingLight -= glintRaw - seaGlint;');
    // The cloud mask cuts the water's own term, never three's raw one.
    expect(text).toContain('outgoingLight -= seaGlint * (1.0 - cloudSunKeep);');
  });
});

describe('the sea', () => {
  /** The injected fragment text through a stub that carries every chunk the
   *  sea touches: the roughness remap and the body. */
  function seaFragment(): string {
    const mat = new THREE.MeshStandardMaterial();
    augmentSurfaceMaterial(mat, 'earth', undefined, 0, undefined, undefined, 'Earth');
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: '#include <common>\n#include <begin_vertex>\n',
      fragmentShader: '#include <common>\n#include <map_fragment>\n#include <roughnessmap_fragment>\n'
        + '#include <normal_fragment_maps>\n#include <opaque_fragment>\n',
    };
    (mat.onBeforeCompile as (s: typeof shader, r: unknown) => void)(shader, null);
    return shader.fragmentShader;
  }

  it('is drawn as seawater: three\'s mirror term rescaled by the ratio of the two Schlick curves', () => {
    const text = seaFragment();
    expect(SEA_WATER_F0).toBeCloseTo(0.02006, 5);
    // The ratio fades with the water fraction the roughness map reads, so
    // the land under the same material gate keeps three's dielectric term.
    expect(text).toContain('float seaFresnel = mix(1.0,\n'
      + `        (${SEA_WATER_F0.toFixed(5)} * (1.0 - seaFresnelTail) + seaFresnelTail)\n`
      + '            / (0.04 * (1.0 - seaFresnelTail) + seaFresnelTail),\n'
      + '        seaWater);');
    expect(text).toContain(`seaWater = clamp((${ROUGHNESS_MAP_LAND.toFixed(6)} - roughnessFactor)\n`
      + `      / ${(ROUGHNESS_MAP_LAND - ROUGHNESS_MAP_WATER).toFixed(6)}, 0.0, 1.0);`);
    // three's own spelling of the Schlick tail, so the division takes out
    // exactly what three put in.
    expect(text).toContain('float seaFresnelTail = exp2((-5.55473 * seaDotVH - 6.98316) * seaDotVH);');
    const ratio = (dotVH: number): number => {
      const tail = Math.pow(2, (-5.55473 * dotVH - 6.98316) * dotVH);
      return (SEA_WATER_F0 * (1 - tail) + tail) / (0.04 * (1 - tail) + tail);
    };
    // A half where the glint is, the whole of it at grazing, and no dip between.
    expect(ratio(1)).toBeCloseTo(SEA_WATER_F0 / 0.04, 2);
    expect(ratio(0)).toBeCloseTo(1, 6);
    expect(ratio(0.5)).toBeGreaterThan(ratio(1));
    expect(ratio(0.5)).toBeLessThan(1);
  });

  it('reads its width from the wind map through Cox-Munk\'s slope law, the numbers world/seaWind.ts holds', () => {
    const text = seaFragment();
    expect(text).toContain('uniform sampler2D uSeaWindMap;');
    expect(text).toContain('uniform float uSeaWindOn;');
    // One map: no calm weight is read or declared any more.
    expect(text).not.toContain('uSeaCalmMap');
    expect(text).not.toContain('seaCalmWeight');
    expect(text).toContain(`textureGrad(uSeaWindMap, seaUv, seaDx, seaDy).r * ${SEA_WIND_MAX_MS.toFixed(1)};`);
    expect(text).toContain(`float seaRoughness = sqrt(sqrt(${COX_MUNK_SLOPE_CALM.toFixed(5)}\n`
      + `          + ${COX_MUNK_SLOPE_PER_MS.toFixed(5)} * seaWindMs));`);
    // The gradients are taken in the uniform branch, before the per-fragment
    // gate that spares pure land the fetches: a derivative inside a branch the
    // fragments of one draw take both sides of is undefined.
    const gradients = text.indexOf('vec2 seaDy = sphereEquirectUvGrad(seaDir, dFdy(seaDir));');
    const gate = text.indexOf(`if (roughnessFactor < ${(ROUGHNESS_MAP_LAND - 0.005).toFixed(6)}) {`);
    expect(gradients).toBeGreaterThan(0);
    expect(gate).toBeGreaterThan(gradients);
    // With the map off the remap is the one-width gain, as it was.
    expect(text).toContain('float waterGain = uWaterGloss;');
  });

  it('greys its albedo by the foam the same wind raises, the law world/seaWind.ts holds, under WHITECAPS', () => {
    const text = resolveDefine(seaFragment(), 'WHITECAPS', true);
    // The wind is copied out of the one read, never read again or moved: the
    // copy is declared before the map's branch and filled right after the
    // read, inside it.
    const declared = text.indexOf('float seaFoamWind = 0.0;');
    const branch = text.indexOf('if (uSeaWindOn > 0.5) {');
    const read = `float seaWindMs = textureGrad(uSeaWindMap, seaUv, seaDx, seaDy).r * ${SEA_WIND_MAX_MS.toFixed(1)};`;
    expect(declared).toBeGreaterThan(0);
    expect(branch).toBeGreaterThan(declared);
    expect(text).toContain(`${read}\n      seaFoamWind = seaWindMs;\n`);
    expect(text.match(/textureGrad\(uSeaWindMap/g)).toHaveLength(1);
    expect(text.match(/float seaFoamWind/g)).toHaveLength(1);
    // The foam goes on after the water colour, so a painted texel is matched
    // first and a shelf painted its own colour takes foam too; no map, or a
    // map of zeros, is no foam.
    const paint = text.indexOf('seaWater * seaPaint * uSeaMix);');
    const foam = text.indexOf('diffuseColor.rgb = mix(diffuseColor.rgb, vec3(FOAM_ALBEDO), seaFoam * seaWater);');
    expect(paint).toBeGreaterThan(0);
    expect(foam).toBeGreaterThan(paint);
    expect(text).toContain('if (seaFoamWind > 0.0) {');
    // The coefficient is an exponent literal, never a fixed-point string that
    // would round it to 0.000004.
    expect(text).toContain(`${WHITECAP_COVER_COEFFICIENT.toExponential()}`);
    expect(WHITECAP_COVER_COEFFICIENT.toExponential()).toBe('3.84e-6');
    // The law the shader writes is the law world/seaWind.ts holds: its
    // three numbers read back out of the text and evaluated in TypeScript.
    const law = /float seaFoam = clamp\(([\d.e+-]+) \* ([\d.e+-]+)\n\s*\* pow\(seaFoamWind, ([\d.e+-]+)\), 0\.0, 1\.0\);/.exec(text);
    expect(law).not.toBeNull();
    const [factor, coefficient, exponent] = law!.slice(1).map(Number);
    for (const wind of [0.5, 3, 7, 10, 12, 13.38, SEA_WIND_MAX_MS]) {
      const glsl = Math.min(Math.max(factor * coefficient * Math.pow(wind, exponent), 0), 1);
      expect(glsl).toBeCloseTo(whitecapCoverage(wind), 12);
    }
    // With the define off none of it is there.
    const off = resolveDefine(seaFragment(), 'WHITECAPS', false);
    expect(off).not.toMatch(/seaFoam|FOAM_ALBEDO|WHITECAPS/);
  });

  it('carries the whitecaps as a define on by default with the foam\'s reflectance beside it, the switch and the knob relinking them', () => {
    expect(parseWhitecapsParam('')).toBe(true);
    expect(parseWhitecapsParam('?whitecaps=1')).toBe(true);
    expect(parseWhitecapsParam('?whitecaps=0')).toBe(false);
    expect(parseFoamParam('')).toBeNull();
    expect(parseFoamParam('?foam=0.30')).toBe(0.3);
    expect(parseFoamParam('?foam=')).toBeNull();
    expect(parseFoamParam('?foam=1.5')).toBeNull();
    expect(parseFoamParam('?foam=grey')).toBeNull();
    // A blank, a space or a hex form would read as zero through Number():
    // a mistyped link leaves the picture alone.
    expect(parseFoamParam('?foam=+')).toBeNull();
    expect(parseFoamParam('?foam=%20')).toBeNull();
    expect(parseFoamParam('?foam=0x0')).toBeNull();
    expect(parseFoamParam('?foam=.15')).toBe(0.15);
    const mat = new THREE.MeshStandardMaterial();
    augmentSurfaceMaterial(mat, 'earth', undefined, 0, undefined, undefined, 'Earth');
    expect(whitecapsOn()).toBe(true);
    expect(foamAlbedoInForce()).toBe(WHITECAP_ALBEDO);
    expect(mat.defines?.WHITECAPS).toBe('');
    expect(mat.defines?.FOAM_ALBEDO).toBe('0.22');
    // Off, both leave the material, so it is the program it was, defines and
    // all; a flip relinks through three's program key.
    let version = mat.version;
    setWhitecapsEnabled(false);
    expect(whitecapsOn()).toBe(false);
    expect(mat.defines?.WHITECAPS).toBeUndefined();
    expect(mat.defines?.FOAM_ALBEDO).toBeUndefined();
    expect(mat.version).toBeGreaterThan(version);
    setWhitecapsEnabled(true);
    expect(mat.defines?.WHITECAPS).toBe('');
    expect(mat.defines?.FOAM_ALBEDO).toBe('0.22');
    // The reflectance is a GLSL float literal, a new value relinks, and a
    // value that is no reflectance is refused.
    version = mat.version;
    expect(setFoamAlbedo(0.3)).toBe(0.3);
    expect(mat.defines?.FOAM_ALBEDO).toBe('0.3');
    expect(mat.version).toBeGreaterThan(version);
    expect(setFoamAlbedo(1)).toBe(1);
    expect(mat.defines?.FOAM_ALBEDO).toBe('1.0');
    expect(setFoamAlbedo(-0.1)).toBe(1);
    expect(setFoamAlbedo(Number.NaN)).toBe(1);
    expect(setFoamAlbedo(WHITECAP_ALBEDO)).toBe(WHITECAP_ALBEDO);
    expect(mat.defines?.FOAM_ALBEDO).toBe('0.22');
    // A surface augmented while the switch is off is born without either.
    setWhitecapsEnabled(false);
    const late = new THREE.MeshStandardMaterial();
    augmentSurfaceMaterial(late, 'airless');
    expect(late.defines?.WHITECAPS).toBeUndefined();
    expect(late.defines?.FOAM_ALBEDO).toBeUndefined();
    setWhitecapsEnabled(true);
    expect(late.defines?.FOAM_ALBEDO).toBe('0.22');
  });

  it('draws one Beckmann lobe in place of three\'s GGX, at three\'s own alpha, only with the map on', () => {
    const text = seaFragment();
    // Beckmann with alpha squared as the mean-square slope is the Gaussian
    // slope law itself; the cosine floored so a facet turned away is nothing.
    expect(text).toContain('float seaBeckmann(float alpha, float dotNH) {\n'
      + '  float cos2 = max(dotNH * dotNH, 1e-6);\n'
      + '  float alpha2 = alpha * alpha;\n'
      + '  return exp((cos2 - 1.0) / (cos2 * alpha2)) / (PI * alpha2 * cos2 * cos2);\n}');
    // The swap: three's D at the same half vector divided out, the Beckmann
    // lobe put in, under the map's uniform so `?seawind=0` is three's lobe
    // again.
    expect(text).toContain('float seaLobe = 1.0;\n    if (uSeaWindOn > 0.5) {');
    expect(text).toContain('float seaDotNH = saturate(dot(normal, seaHalfDir));');
    expect(text).toContain('float seaAlpha = pow2(material.roughness);');
    expect(text).not.toContain('uGlintCalm');
    // three's own Smith visibility at the lobe's alpha, which the division
    // takes out with three's distribution.
    expect(text).toContain('float seaVis = V_GGX_SmithCorrelated(seaAlpha, seaDotNL, seaDotNV);');
    // The beam chain's Beckmann Smith on the lobe, three's GGX one on the old
    // chain (where it cancels), one of the two compiled; the denominator is
    // three's either way.
    expect(text).toContain('#ifdef SEA_BEAM\n      float seaBeamVis = seaBeckmannVis(seaAlpha, seaDotNL, seaDotNV);\n'
      + '#else\n      float seaBeamVis = seaVis;\n#endif');
    // The swap, like the Fresnel, fades with the water fraction: land keeps
    // three's lobe.
    expect(text).toContain('seaLobe = mix(1.0,\n'
      + '          seaBeamVis * seaBeckmann(seaAlpha, seaDotNH) / (seaVis * D_GGX(seaAlpha, seaDotNH)),\n'
      + '          seaWater);');
    // The two lobes share their peak: at the half vector on the normal, both
    // read 1 / (pi alpha²), so the swap moves the tail and not the centre.
    const beckmann = (alpha: number, dotNH: number): number => {
      const cos2 = Math.max(dotNH * dotNH, 1e-6);
      return Math.exp((cos2 - 1) / (cos2 * alpha * alpha)) / (Math.PI * alpha * alpha * cos2 * cos2);
    };
    const ggx = (alpha: number, dotNH: number): number => {
      const a2 = alpha * alpha;
      const denom = dotNH * dotNH * (a2 - 1) + 1;
      return a2 / (Math.PI * denom * denom);
    };
    const alpha = Math.pow(0.003 + 0.00512 * 7, 0.5);
    expect(beckmann(alpha, 1)).toBeCloseTo(ggx(alpha, 1), 9);
    // And in the tail Beckmann is the narrower of the two: at three sigma of
    // facet tilt GGX is eighty times brighter, which was the haze.
    const threeSigma = Math.cos(Math.atan(3 * alpha));
    expect(ggx(alpha, threeSigma) / beckmann(alpha, threeSigma)).toBeGreaterThan(50);
    expect(beckmann(alpha, 0)).toBe(0);
    expect(Number.isFinite(beckmann(alpha, 0.001))).toBe(true);
  });

  it('binds the map on one shared uniform once a sea is confirmed, and the switch and the override hold it off', () => {
    const mat = new THREE.MeshStandardMaterial();
    augmentSurfaceMaterial(mat, 'earth');
    const shader = mockShader();
    (mat.onBeforeCompile as (s: typeof shader, r: unknown) => void)(shader, null);
    expect(shader.uniforms.uSeaCalmMap).toBeUndefined();
    expect(shader.uniforms.uSeaWindMap).toBe(seaWindUniforms.uSeaWindMap);
    expect(shader.uniforms.uSeaWindOn).toBe(seaWindUniforms.uSeaWindOn);
    // A sea confirmed before the map lands reads the one width, on the
    // stand-in; the map landing (PlanetFactory's install, here by hand) binds
    // it and turns it on.
    setSurfaceWaterGloss(mat, true);
    expect(seaWindOn()).toBe(false);
    const map = seaWindTextureFrom({ data: new Uint8Array([100, 128, 128, 255, 100, 128, 128, 255]), width: 2, height: 1 });
    expect(installSeaWindMap(map, 'test')).toBe(map);
    rebindSeaWindMap();
    expect(seaWindUniforms.uSeaWindMap.value).toBe(map);
    expect(seaWindOn()).toBe(true);
    setSeaWindEnabled(false);
    expect(seaWindOn()).toBe(false);
    expect(seaWindUniforms.uSeaWindMap.value).toBe(map);
    setSeaWindEnabled(true);
    expect(seaWindOn()).toBe(true);
    // A DEV override draws the whole sea at one width; null hands it back.
    expect(setDevOceanRoughness(0.2)).toBe(0.2);
    expect(seaWindOn()).toBe(false);
    expect(setDevOceanRoughness()).toBe(0.2);
    expect(setDevOceanRoughness(null)).toBe(null);
    expect(seaWindOn()).toBe(true);
    // A sea switched off leaves the map bound for the next one.
    setSurfaceWaterGloss(mat, false);
    expect(seaWindUniforms.uSeaWindMap.value).toBe(map);
    // A replacement map is read from the next frame, the old one let go once
    // the uniform points at its successor.
    let disposed = false;
    map.addEventListener('dispose', () => { disposed = true; });
    const replacement = seaWindTextureFrom({ data: new Uint8Array([50, 128, 128, 255, 50, 128, 128, 255]), width: 2, height: 1 });
    expect(installSeaWindMap(replacement, 'test')).toBe(replacement);
    expect(disposed).toBe(false);
    rebindSeaWindMap();
    expect(seaWindUniforms.uSeaWindMap.value).toBe(replacement);
    expect(disposed).toBe(true);
  });
});

describe('the GPU-efficiency switches', () => {
  /** The injected text through a stub that carries every chunk the switches
   *  touch: the map, the roughness, the normal maps and the body. */
  function fragmentOf(archetype: Parameters<typeof augmentSurfaceMaterial>[1]): string {
    const mat = new THREE.MeshStandardMaterial();
    augmentSurfaceMaterial(mat, archetype, undefined, 0, undefined, undefined, 'Earth');
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: '#include <common>\n#include <begin_vertex>\n',
      fragmentShader: '#include <common>\n#include <map_fragment>\n#include <roughnessmap_fragment>\n'
        + '#include <normal_fragment_maps>\n#include <opaque_fragment>\n',
    };
    (mat.onBeforeCompile as (s: typeof shader, r: unknown) => void)(shader, null);
    return shader.fragmentShader;
  }

  it('binds every uniform the injected text declares, so a knob is never a declaration the driver reads as zero', () => {
    // The stub's fragment text carries the injected declarations alone
    // (three's includes are left as includes), so every `uniform` in it is
    // ours, and every one must have landed in shader.uniforms: a uniform
    // declared and read but never bound is silently zero, which is how the
    // calm lobe once collapsed to nothing in a development build while the
    // production literal, and every text test, stayed right.
    for (const archetype of ['earth', 'cloud'] as const) {
      const mat = new THREE.MeshStandardMaterial();
      augmentSurfaceMaterial(mat, archetype, undefined, 0, undefined, undefined, 'Earth');
      const shader = {
        uniforms: {} as Record<string, unknown>,
        vertexShader: '#include <common>\n#include <begin_vertex>\n',
        fragmentShader: '#include <common>\n#include <map_fragment>\n#include <roughnessmap_fragment>\n'
          + '#include <normal_fragment_maps>\n#include <opaque_fragment>\n',
      };
      (mat.onBeforeCompile as (s: typeof shader, r: unknown) => void)(shader, null);
      // The text the driver compiles for a default material: the cloud
      // defines off, so a knob declared only under one of them (bound only
      // where the define is on) is not read as a declaration here.
      const compiled = ['CLOUD_FIELD', 'CLOUD_SHADOW', 'CLOUD_LIGHT']
        .reduce((text, name) => resolveDefine(text, name, false), shader.vertexShader + shader.fragmentShader);
      const declared = [...compiled.matchAll(/uniform\s+\w+\s+(\w+)\s*;/g)]
        .map((match) => match[1]);
      expect(declared.length).toBeGreaterThan(20);
      const unbound = [...new Set(declared)].filter((name) => !(name in shader.uniforms));
      expect(unbound, `${archetype}: declared but never bound`).toEqual([]);
    }
  });

  it('guards each cheap path with a prefix the production fold deletes', () => {
    // This is the DEVELOPMENT text, both readings of every change behind its
    // uniform; a production build compiles the cheap reading alone
    // (app/perfSwitches.ts). That fold is a deletion and not a rewrite only
    // while each guard keeps this exact shape — the switch's own uniform and
    // then, verbatim, the condition the shipped text is left with — which is
    // what lets a hash of this text stand for the text that ships.
    const frag = fragmentOf('cloud');
    expect(frag).toContain('if (uPerfCloudTaps < 0.5 || cloudDetailW > 0.0) detail = textureGrad(uCloudDetail, detailUv, duvX, duvY);');
    expect(frag).toContain('if (uPerfCloudClear > 0.5 && DECK_ON && cloudAlpha == 0.0) { gl_FragColor = vec4(0.0); return; }');
    expect(frag).toContain('bool cloudTapWanted = uPerfGlintGate < 0.5 || any(greaterThan(seaGlint, vec3(0.0)));');
    expect(earthNightFragmentShader)
      .toContain('if (uPerfNightEarly > 0.5) { if (nightMix == 0.0) { gl_FragColor = vec4(0.0); return; } }');
    // Each uniform declared once, where the shader reads it.
    for (const u of ['uPerfCloudTaps', 'uPerfCloudClear', 'uPerfGlintGate']) {
      expect(frag.match(new RegExp(`uniform float ${u};`, 'g'))).toHaveLength(1);
    }
  });

  it('reads the roughness map as red, and as green only with the storage switched back', () => {
    // three's own chunk reads green, for a packed occlusion/roughness/metalness
    // image. The water mask is grey and stored one byte a texel
    // (world/texturePolicy's 'mask' kind), so red is the same number and the
    // only channel there is. With the storage switch off the map is RGBA
    // again and three's chunk is compiled back in, so the switch's own A/B
    // covers the channel change and not only the storage.
    expect(fragmentOf('earth')).toContain('roughnessFactor *= texture2D( roughnessMap, vRoughnessMapUv ).r;');
    expect(fragmentOf('earth')).not.toContain('#include <roughnessmap_fragment>');
    setPerfSwitch('r8-maps', false);
    try {
      expect(fragmentOf('earth')).toContain('#include <roughnessmap_fragment>');
      expect(fragmentOf('earth')).not.toContain('vRoughnessMapUv ).r;');
    } finally {
      setPerfSwitch('r8-maps', true);
    }
  });
});

describe('cloud shadows on the ground (CLOUD_SHADOW, on unless ?cloudshadows=0)', () => {
  /** The whole injected fragment text a ground material compiles. */
  function fragmentOf(mat: THREE.Material): string {
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: '#include <common>\n#include <begin_vertex>\n',
      fragmentShader: '#include <common>\n#include <map_fragment>\n#include <roughnessmap_fragment>\n'
        + '#include <normal_fragment_maps>\n#include <opaque_fragment>\n',
    };
    (mat.onBeforeCompile as (s: typeof shader, r: unknown) => void)(shader, null);
    return shader.fragmentShader;
  }
  /** Earth's globe, its deck on the same fx, and the call that says the deck is there. */
  function earthWithDeck() {
    const globe = new THREE.MeshStandardMaterial();
    const fx = augmentSurfaceMaterial(globe, 'earth', undefined, 0.00465, undefined, undefined, 'Earth');
    const deck = new THREE.MeshStandardMaterial({ transparent: true });
    augmentSurfaceMaterial(deck, 'cloud', undefined, 0.00465, fx);
    setGroundUnderCloudDeck(globe);
    setGroundUnderCloudDeck(deck);
    return { globe, deck, fx };
  }

  it('is on unless switched off, on the ground and never the deck', () => {
    expect(cloudShadowsOn()).toBe(true);
    const { globe, deck, fx } = earthWithDeck();
    expect(surfaceCloudShadowCompiled(globe)).toBe(true);
    expect(surfaceCloudShadowCompiled(deck)).toBe(false);
    // The per-frame gate starts closed on every fresh set; the mode opens it
    // for Earth while the deck is drawn.
    expect(fx.uCloudAbove.value).toBe(0);
  });

  // The switch moves through the DEV key; a production build reads
  // `?cloudshadows=0` once at boot and has no key to move.
  it.runIf(import.meta.env.DEV)('compiles on Earth\'s ground and its sectors only, and moves with the switch', () => {
    const { globe, deck } = earthWithDeck();
    const sector = createSectorMaterial(globe, { map: new THREE.Texture() });
    // A tool's Earth (Look inside builds its own skin and deck on a fx of its
    // own) and another body: never receivers.
    const studio = new THREE.MeshStandardMaterial();
    const studioFx = augmentSurfaceMaterial(studio, 'earth');
    augmentSurfaceMaterial(new THREE.MeshStandardMaterial({ transparent: true }), 'cloud', undefined, 0, studioFx);
    const mars = new THREE.MeshStandardMaterial();
    augmentSurfaceMaterial(mars, 'rocky', undefined, 0, undefined, undefined, 'Mars');
    expect(surfaceCloudShadowCompiled(globe)).toBe(true);
    expect(surfaceCloudShadowCompiled(sector)).toBe(true);
    // A sector cut while the switch is on takes it at birth, and a globe and
    // its sectors carry one set of defines, so they share one program.
    const late = createSectorMaterial(globe, { map: new THREE.Texture() });
    expect(surfaceCloudShadowCompiled(late)).toBe(true);
    expect(late.defines).toEqual(globe.defines);
    expect(sector.defines).toEqual(globe.defines);
    // Never the deck, never a tool, never another body.
    expect(surfaceCloudShadowCompiled(deck)).toBe(false);
    expect(surfaceCloudShadowCompiled(studio)).toBe(false);
    expect(surfaceCloudShadowCompiled(mars)).toBe(false);
    const v0 = globe.version;
    setPerfSwitch('cloud-shadow', false);
    try {
      expect(cloudShadowsOn()).toBe(false);
      // The define is part of three's program key: the next draw relinks.
      expect(globe.version).toBeGreaterThan(v0);
      for (const m of [globe, sector, late]) expect(surfaceCloudShadowCompiled(m)).toBe(false);
      // A sector cut while the switch is off is born without it.
      const off = createSectorMaterial(globe, { map: new THREE.Texture() });
      expect(surfaceCloudShadowCompiled(off)).toBe(false);
      expect(off.defines).toEqual(globe.defines);
    } finally {
      setPerfSwitch('cloud-shadow', true);
    }
    for (const m of [globe, sector, late]) expect(surfaceCloudShadowCompiled(m)).toBe(true);
  });

  it('reads the beam once, where the Sun\'s ray to the ground crosses the DRAWN deck, its derivatives taken before the gate', () => {
    const { globe } = earthWithDeck();
    // The base sheet's read, as a session without the cloud field compiles it.
    const on = resolveDefine(resolveDefine(fragmentOf(globe), 'CLOUD_SHADOW', true), 'CLOUD_FIELD', false);
    // One read of the deck's map, and it is this one: the straight-down read
    // under the sea alone is the off arm's.
    expect(on.split('textureGrad(uCloudShadowMap').length - 1).toBe(1);
    expect(on).not.toContain('float deckC = cos(uCloudShadowSpin);');
    expect(on).toContain('vec3 shadowN = normalize(vObjPos);');
    expect(on).toContain('vec3 shadowL = normalize(uSunDirLocal);');
    expect(on).toContain(
      'vec3 shadowDir = bodyToDeck(cloudRayDirection(shadowN, shadowL, uCloudHeightOverRadius), uCloudShadowSpin);');
    const readAt = on.indexOf('if (GROUND_ON(uCloudAbove > 0.0)) {');
    const read = on.slice(readAt, on.indexOf('if (GROUND_ON(uWaterGloss > 0.0)) {', readAt));
    expect(read.length).toBeGreaterThan(0);
    const gate = read.indexOf('if (cloudTapWanted) {');
    expect(read).toContain('bool cloudTapWanted = shadowMu > 0.0;');
    // Both derivatives of the displaced direction, above the gate...
    expect(read.slice(0, gate).match(/dFd[xy]\(/g)).toEqual(['dFdx(', 'dFdy(']);
    expect(read).toContain('vec3 shadowDx = dFdx(shadowDir);');
    // ...and nothing below it that needs one: explicit gradients and the
    // smooth filter's explicit-level taps only.
    expect(read.slice(gate)).not.toMatch(/dFd[xy]\(|fwidth\(|texture2D\(|[^a-zA-Z]texture\(/);
    expect(read.slice(gate)).toContain('textureBSpline(uCloudShadowMap, shadowUv, shadowTexels)');
    // The specular is the glint's business alone, cut once by the same value.
    expect(read).not.toContain('directSpecular');
    expect(on).toContain('outgoingLight -= seaGlint * (1.0 - cloudSunKeep);');
    expect(on).not.toMatch(/reflectedLight\.directSpecular \* \(1\.0 - cloudSunKeep/);
  });

  it('reads the cloud field over the base at the field\'s weight, where the ground compiles the field', () => {
    const { globe } = earthWithDeck();
    const text = resolveDefine(fragmentOf(globe), 'CLOUD_SHADOW', true);
    const field = resolveDefine(text, 'CLOUD_FIELD', true);
    const readAt = field.indexOf('if (GROUND_ON(uCloudAbove > 0.0)) {');
    const read = field.slice(readAt, field.indexOf('if (GROUND_ON(uWaterGloss > 0.0)) {', readAt));
    expect(read.length).toBeGreaterThan(0);
    // The field at the pierce point, through the shadow lookup's own
    // footprint: the displaced direction's derivatives, widened by a penumbra
    // held in the tile ratio's pixels, where the guard measures.
    const held = read.indexOf('shadowPenumbra /= uCloudFieldPixelScale;');
    expect(held).toBeGreaterThan(read.indexOf('float shadowPenumbra = '));
    expect(held).toBeLessThan(read.indexOf('shadowDx *= max('));
    const fine = read.indexOf('cloudFieldFine(shadowDir, shadowDx, shadowDy, shadowFieldW, shadowFieldLayer).x;');
    const gate = read.indexOf('if (cloudTapWanted) {');
    expect(fine).toBeGreaterThan(gate);
    // The base only where the field leaves it a share, mixed as the deck mixes
    // them; its plain tap only where the smooth filter does not take it all.
    const base = read.indexOf('if (shadowFieldW < 1.0) {');
    expect(base).toBeGreaterThan(fine);
    expect(read.split('textureGrad(uCloudShadowMap').length - 1).toBe(1);
    expect(read).toContain('if (shadowSmoothW < 1.0) shadowTexel = textureGrad(uCloudShadowMap, shadowUv, shadowUvDx, shadowUvDy);');
    expect(read).toContain('shadowCover, shadowFieldW);');
    expect(read).toContain('cloudSunKeep = 1.0 - shadowCover;');
    // Under the gate, still nothing that needs an implicit derivative.
    expect(read.slice(gate)).not.toMatch(/dFd[xy]\(|fwidth\(|texture2D\(|[^a-zA-Z]texture\(/);
    // The sky's fill reads its table only where there is a shade to fill.
    expect(field).toContain('if (cloudShade > 0.0 && ');
    // With the field off the read is the base sheet's alone, as it was.
    const off = resolveDefine(text, 'CLOUD_FIELD', false);
    expect(off).not.toMatch(/cloudFieldFine|uCloudFieldPixelScale|shadowCover|cloudShade > 0\.0/);
  });

  it.runIf(import.meta.env.DEV)('compiles the field into the ground beside the shadow, in a session that has it', () => {
    const { globe, deck } = earthWithDeck();
    const sector = createSectorMaterial(globe, { map: new THREE.Texture() });
    const field = (m: THREE.Material) => (m as THREE.MeshStandardMaterial).defines?.CLOUD_FIELD !== undefined;
    // Without the field, the shadow alone.
    expect(surfaceCloudShadowCompiled(globe)).toBe(true);
    expect(field(globe)).toBe(false);
    setCloudFieldOn(true);
    try {
      // A ground built in a session with the field takes both at birth.
      const late = earthWithDeck();
      expect(field(late.globe)).toBe(true);
      // Never the field without the shadow: the shadow's kill switch takes
      // both off every receiver.
      setPerfSwitch('cloud-shadow', false);
      try {
        for (const m of [late.globe, globe, sector]) expect(field(m)).toBe(false);
        // The ground binds the field's slots on every compile, the define in
        // or out, so a program the switch returns to finds them.
        const shader = {
          uniforms: {} as Record<string, unknown>,
          vertexShader: '#include <common>\n#include <begin_vertex>\n',
          fragmentShader: '#include <common>\n#include <opaque_fragment>\n',
        };
        (late.globe.onBeforeCompile as (s: typeof shader, r: unknown) => void)(shader, null);
        expect(field(late.globe)).toBe(false);
        expect(Object.keys(shader.uniforms)).toEqual(expect.arrayContaining(['uCloudPages', 'uCloudPageTable', 'uCloudFieldPixelScale']));
      } finally {
        setPerfSwitch('cloud-shadow', true);
      }
      // Back on, every receiver takes both, the ones built before the field
      // was settled too.
      for (const m of [late.globe, globe, sector]) expect(field(m)).toBe(true);
      // A sector cut while it is on takes both at birth, and shares the
      // globe's program.
      const cut = createSectorMaterial(late.globe, { map: new THREE.Texture() });
      expect(cut.defines).toEqual(late.globe.defines);
      // Never the deck's: its own factory decides that one.
      expect(field(deck)).toBe(false);
    } finally {
      setCloudFieldOn(false);
    }
    for (const m of [globe, sector]) expect(field(m)).toBe(false);
    expect(surfaceCloudShadowCompiled(globe)).toBe(true);
  });

  it('cuts the Sun\'s diffuse after the sea\'s block and the air\'s glow before the Moon\'s, and nothing else', () => {
    const { globe } = earthWithDeck();
    // Both readings: a session without the cloud field, and one with it, whose
    // air takes the grazing cosine three's lights already hold.
    for (const field of [false, true]) {
      const on = resolveDefine(resolveDefine(fragmentOf(globe), 'CLOUD_SHADOW', true), 'CLOUD_FIELD', field);
      // The ground and the air take the cloud's SHADE, the beam's loss through
      // the shade curve; the glint takes the beam itself.
      const gamma = import.meta.env.DEV ? 'uCloudShadowGamma' : CLOUD_SHADOW_GAMMA.toFixed(4);
      expect(on).toContain(`float cloudShade = pow(1.0 - cloudSunKeep, ${gamma}) * cloudShadeHorizon;`);
      // ...faded to nothing where the Sun meets the ground's horizon, so the air
      // the shade is taken from carries no line along the terminator.
      expect(on).toContain(`cloudShadeHorizon = smoothstep(0.0, ${CLOUD_SHADOW_HORIZON_SIN.toFixed(6)}, shadowMu);`);
      expect(CLOUD_SHADOW_HORIZON_SIN).toBe(NIGHT_WEIGHT_ZERO_SIN);
      const diffuse = on.indexOf('outgoingLight -= reflectedLight.directDiffuse * (cloudShade * ');
      expect(diffuse).toBeGreaterThan(on.indexOf('outgoingLight -= seaGlint * (1.0 - cloudSunKeep)'));
      expect(diffuse).toBeLessThan(on.indexOf('float sunElevSin = dot('));
      // Before the eclipse factor, which multiplies both, and every night term.
      expect(diffuse).toBeLessThan(on.indexOf('outgoingLight *= sunVisible;'));
      expect(diffuse).toBeLessThan(on.indexOf('outgoingLight += nightLow;'));
      const air = on.indexOf('airS *= 1.0 - cloudShade * ');
      expect(air).toBeGreaterThan(on.indexOf('vec3 airS = aerialInscatter(uScattering, seg, airT)'));
      expect(air).toBeLessThan(on.indexOf('airS += aerialInscatter('));
      // The transmittance is the air's and is not touched.
      expect(on).not.toMatch(/airT \*=|airT = .*cloudSunKeep/);
      // Three readers: the diffuse cut, the sky's fill, the air's take.
      expect(on.match(/cloudShade \*/g)).toHaveLength(3);
      expect(on).toContain('outgoingLight -= seaGlint * (1.0 - cloudSunKeep);');
      // The air's share fades as the view grazes, on the geometric normal and
      // the line of sight, never the perturbed normal.
      expect(on).toContain(`smoothstep(${CLOUD_SHADOW_AIR_GRAZE[0].toFixed(6)}, ${CLOUD_SHADOW_AIR_GRAZE[1].toFixed(6)}, `
        + (field ? 'dot(nonPerturbedNormal, geometryViewDir));' : 'dot(up, normalize(vAirCam - vAirFrag)));'));
      if (!field) expect(on.indexOf('vec3 up = normalize(vAirFrag);')).toBeLessThan(air);
    }
  });

  it('shades thin cloud little and solid cloud fully, and the haze not at all where the view grazes', () => {
    // The shade curve, as the shader applies it: a half-covered texel shades
    // a quarter as much as a solid bank; clear sky not at all.
    const shade = (keep: number) => (1 - keep) ** CLOUD_SHADOW_GAMMA;
    expect(CLOUD_SHADOW_GAMMA).toBe(2);
    expect(shade(1)).toBe(0);
    expect(shade(0)).toBe(1);
    expect(shade(0.5)).toBeCloseTo(0.25, 12);
    // The grazing fade: full from 60° off the vertical, gone by 84°.
    const [lo, hi] = CLOUD_SHADOW_AIR_GRAZE;
    expect(Math.acos(hi) * 180 / Math.PI).toBeCloseTo(60, 6);
    expect(Math.acos(lo) * 180 / Math.PI).toBeGreaterThan(84);
    expect(Math.acos(lo) * 180 / Math.PI).toBeLessThan(85);
    expect(cloudShadowShared.uCloudShadowGamma.value).toBe(CLOUD_SHADOW_GAMMA);
  });

  it('states its numbers once: the drawn shell, the two shares, the penumbra', () => {
    const earthKm = PLANETS.find((p) => p.name === 'Earth')!.radiusKm;
    expect(cloudShadowShared.uCloudHeightOverRadius.value).toBeCloseTo(CLOUD_TOP_KM / earthKm, 15);
    expect(cloudShadowShared.uCloudShadowDepth.value).toBe(CLOUD_SHADOW_DEPTH);
    expect(cloudShadowShared.uCloudShadowAir.value).toBe(CLOUD_SHADOW_AIR);
    expect(cloudShadowShared.uCloudShadowPenumbra.value).toBe(1);
    expect(CLOUD_SHADOW_DEPTH).toBe(0.7);
    expect(CLOUD_SHADOW_AIR).toBe(0.6);
    // The penumbra's footprint on the deck, h·Δθ/sin²e: 3 km with the Sun 10°
    // up for a 10 km shell and a half-degree Sun, held from 5.7° down.
    const { globe } = earthWithDeck();
    const on = resolveDefine(fragmentOf(globe), 'CLOUD_SHADOW', true);
    expect(on).toContain('uCloudHeightOverRadius * (2.0 * uSunTan)\n        / max(shadowMu * shadowMu, 0.01);');
    const dTheta = 2 * 0.00465;
    const kmAt = (deg: number) => CLOUD_TOP_KM * dTheta / Math.max(Math.sin(deg * Math.PI / 180) ** 2, 0.01);
    expect(kmAt(10)).toBeGreaterThan(3.0);
    expect(kmAt(10)).toBeLessThan(3.2);
    expect(kmAt(3)).toBeCloseTo(kmAt(5.74), 1);
  });

  it('takes nothing from a black map, which is what hidden clouds bind', () => {
    // The 1x1 stand-in every augmented material binds before the deck's map
    // lands, and what a hidden deck may be pointed at, is black: no coverage,
    // the whole beam kept, no shadow.
    expect(cloudCoverageAlpha(0)).toBe(0);
  });
});

describe('the cloud deck lit as a cloud (CLOUD_LIGHT, on unless ?cloudlight=0)', () => {
  function fragmentOf(mat: THREE.Material): string {
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: '#include <common>\n#include <begin_vertex>\n',
      fragmentShader: '#include <common>\n#include <map_fragment>\n#include <roughnessmap_fragment>\n'
        + '#include <normal_fragment_maps>\n#include <opaque_fragment>\n',
    };
    (mat.onBeforeCompile as (s: typeof shader, r: unknown) => void)(shader, null);
    return shader.fragmentShader;
  }
  function earthWithDeck() {
    const globe = new THREE.MeshStandardMaterial();
    const fx = augmentSurfaceMaterial(globe, 'earth', undefined, 0.00465, undefined, undefined, 'Earth');
    const deck = new THREE.MeshStandardMaterial({ transparent: true });
    augmentSurfaceMaterial(deck, 'cloud', undefined, 0.00465, fx);
    setGroundUnderCloudDeck(globe);
    setPlanetariumCloudDeck(deck);
    setPlanetariumCloudDeck(globe);
    return { globe, deck };
  }

  it('is on unless switched off, and compiles into the planetarium\'s deck alone', () => {
    expect(cloudLightOn()).toBe(true);
    const { globe, deck } = earthWithDeck();
    expect(surfaceCloudLightCompiled(deck)).toBe(true);
    expect(surfaceCloudLightCompiled(globe)).toBe(false);
    // A tool's deck (Look inside builds its own) is never registered.
    const studioDeck = new THREE.MeshStandardMaterial({ transparent: true });
    augmentSurfaceMaterial(studioDeck, 'cloud');
    expect(surfaceCloudLightCompiled(studioDeck)).toBe(false);
    if (!import.meta.env.DEV) return;
    setPerfSwitch('cloud-light', false);
    try {
      expect(surfaceCloudLightCompiled(deck)).toBe(false);
      expect(surfaceCloudLightCompiled(studioDeck)).toBe(false);
      // And it is not the shadow's switch: the ground under it is untouched.
      expect(surfaceCloudShadowCompiled(globe)).toBe(true);
    } finally {
      setPerfSwitch('cloud-light', true);
    }
    expect(surfaceCloudLightCompiled(deck)).toBe(true);
  });

  it('mixes the Sun\'s diffuse toward the shell\'s own normal through three\'s own lights, and adds the sky by day', () => {
    const { deck } = earthWithDeck();
    const on = resolveDefine(fragmentOf(deck), 'CLOUD_LIGHT', true);
    const block = on.slice(on.indexOf('vec3 cloudGeoIrradiance = vec3(0.0);'), on.indexOf('float sunElevSin = dot('));
    expect(block.length).toBeGreaterThan(0);
    // Every point and directional light the program was built with, read as
    // three reads them, on the unperturbed normal.
    expect(block).toContain('for ( int i = 0; i < NUM_POINT_LIGHTS; i ++ ) {');
    expect(block).toContain('getPointLightInfo( pointLights[ i ], geometryPosition, cloudLight );');
    expect(block).toContain('for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {');
    expect(block.match(/saturate\( dot\( nonPerturbedNormal, cloudLight\.direction \) \)/g)).toHaveLength(2);
    expect(block).not.toMatch(/pointLights\[ ?0 ?\]/);
    const wrap = import.meta.env.DEV ? 'uCloudLightWrap' : CLOUD_LIGHT_WRAP.toFixed(4);
    const sky = import.meta.env.DEV ? 'uCloudLightSky' : CLOUD_LIGHT_SKY.toFixed(4);
    expect(block).toContain(`outgoingLight += ${wrap}\n`
      + '        * (cloudGeoIrradiance * BRDF_Lambert( material.diffuseContribution ) - reflectedLight.directDiffuse);');
    // The sky by day, only with tables, joined to the night ambient along the
    // night weight's complement.
    expect(block).toContain('if (uAirDensity > 0.0) {');
    expect(block).toContain(`* (${sky} * (1.0 - nightWeight(skyMuS)));`);
    expect(block).toContain('getIrradiance(uIrradiance, skyR, skyMuS) * uAirlightScale * uSolarIrradiance');
    // Light only: nothing here touches the alpha, which is the deck's coverage.
    expect(block).not.toMatch(/\.a\s*[*+-]?=|gl_FragColor/);
    // No derivative: the block sits past the deck's clear-sky return.
    expect(block).not.toMatch(/dFd[xy]\(|fwidth\(/);
    expect(on.indexOf('vec3 cloudGeoIrradiance')).toBeGreaterThan(on.indexOf('cloudAlpha == 0.0) { gl_FragColor = vec4(0.0); return; }'));
    // Before the eclipse factor, so a moon's umbra dims it too, and the air.
    expect(on.indexOf('vec3 cloudGeoIrradiance')).toBeLessThan(on.indexOf('outgoingLight *= sunVisible;'));
  });

  it('states its numbers once', () => {
    expect(CLOUD_LIGHT_WRAP).toBe(0.4);
    expect(CLOUD_LIGHT_SKY).toBe(1.0);
    expect(cloudLightShared.uCloudLightWrap.value).toBe(CLOUD_LIGHT_WRAP);
    expect(cloudLightShared.uCloudLightSky.value).toBe(CLOUD_LIGHT_SKY);
    expect(cloudShadowShared.uCloudShadowSkyFill.value).toBe(CLOUD_SHADOW_SKY_FILL);
  });

  it('fills the ground under a shade with the sky\'s own light, only with tables, joined to the night ambient', () => {
    const { globe } = earthWithDeck();
    const on = resolveDefine(fragmentOf(globe), 'CLOUD_SHADOW', true);
    const fill = import.meta.env.DEV ? 'uCloudShadowSkyFill' : CLOUD_SHADOW_SKY_FILL.toFixed(4);
    expect(on).toContain(`if (${import.meta.env.DEV ? 'uCloudShadowSkyFill > 0.0 && ' : ''}uAirDensity > 0.0) {`);
    expect(on).toContain(`* (cloudShade * ${fill} * (1.0 - nightWeight(fillMuS)));`);
    // After the diffuse cut that makes the shade, before the eclipse factor.
    const at = on.indexOf('float fillMuS');
    expect(at).toBeGreaterThan(on.indexOf('float cloudShade = pow('));
    expect(at).toBeLessThan(on.indexOf('outgoingLight *= sunVisible;'));
    expect(CLOUD_SHADOW_SKY_FILL).toBe(1);
    // Not on the deck, which never compiles the shadow.
    expect(resolveDefine(fragmentOf(globe), 'CLOUD_SHADOW', false)).not.toContain('fillMuS');
  });
});

describe("the sea's water colour", () => {
  function compiled(): { text: string; uniforms: Record<string, unknown> } {
    const mat = new THREE.MeshStandardMaterial();
    augmentSurfaceMaterial(mat, 'earth');
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: '#include <common>\n#include <begin_vertex>\n',
      fragmentShader: '#include <common>\n#include <roughnessmap_fragment>\n#include <normal_fragment_maps>\n#include <opaque_fragment>\n',
    };
    (mat.onBeforeCompile as (s: typeof shader, r: unknown) => void)(shader, null);
    return { text: shader.fragmentShader, uniforms: shader.uniforms };
  }
  const srgbToLinear = (byte: number): number => {
    const c = byte / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };

  it("detects the day map's painted open sea, sRGB (2, 30, 84), in linear light", () => {
    expect(SEA_PAINT_COLOUR[0]).toBeCloseTo(srgbToLinear(2), 5);
    expect(SEA_PAINT_COLOUR[1]).toBeCloseTo(srgbToLinear(30), 5);
    expect(SEA_PAINT_COLOUR[2]).toBeCloseTo(srgbToLinear(84), 5);
    // Clear ocean water: a dark, blue-led reflectance with a little red, far
    // under the paint's blue.
    expect(SEA_WATER_COLOUR[2]).toBeLessThan(SEA_PAINT_COLOUR[2] / 2);
    expect(SEA_WATER_COLOUR[0]).toBeGreaterThan(SEA_PAINT_COLOUR[0]);
    expect(SEA_WATER_COLOUR[1] / SEA_WATER_COLOUR[2]).toBeGreaterThan(0.25);
  });

  it('draws the paint in the water colour behind the share uniform, bound on every augmented surface', () => {
    const { text, uniforms } = compiled();
    expect(text).toContain('if (uSeaMix > 0.0)');
    expect(text).toContain(`vec3(${SEA_PAINT_COLOUR.map((v) => v.toFixed(6)).join(', ')})`);
    // The colour: a knob in a development build, a literal in production.
    expect(text).toContain(import.meta.env.DEV ? 'uSeaColour, seaWater * seaPaint * uSeaMix' : `vec3(${SEA_WATER_COLOUR.map((v) => v.toFixed(5)).join(', ')}), seaWater * seaPaint * uSeaMix`);
    expect(uniforms.uSeaMix).toBe(seaColourUniforms.uSeaMix);
  });

  it('is the `?seacolour=0` switch, the painted map again at a share of exactly zero', () => {
    expect(parseSeaColourParam('?seacolour=0')).toBe(false);
    expect(parseSeaColourParam('?seacolour=1')).toBe(true);
    expect(parseSeaColourParam('')).toBe(true);
    expect(seaColourUniforms.uSeaMix.value).toBe(1);
    expect(seaColourOn()).toBe(true);
    setSeaColourEnabled(false);
    expect(seaColourUniforms.uSeaMix.value).toBe(0);
    expect(seaColourOn()).toBe(false);
    setSeaColourEnabled(true);
    expect(seaColourUniforms.uSeaMix.value).toBe(1);
  });
});

describe('the sky reflected off the sea', () => {
  function fragmentOf(): string {
    const mat = new THREE.MeshStandardMaterial();
    augmentSurfaceMaterial(mat, 'earth', undefined, 0, undefined, undefined, 'Earth');
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: '#include <common>\n#include <begin_vertex>\n',
      fragmentShader: '#include <common>\n#include <roughnessmap_fragment>\n#include <normal_fragment_maps>\n#include <opaque_fragment>\n',
    };
    (mat.onBeforeCompile as (s: typeof shader, r: unknown) => void)(shader, null);
    return shader.fragmentShader;
  }
  // The exact unpolarised Fresnel the shader's helper computes, in TypeScript.
  const fresnel = (cosI: number): number => {
    const g = Math.sqrt(SEA_WATER_IOR * SEA_WATER_IOR - 1 + cosI * cosI);
    const a = (g - cosI) / (g + cosI);
    const b = (cosI * (g + cosI) - 1) / (cosI * (g - cosI) + 1);
    return 0.5 * a * a * (1 + b * b);
  };

  it('is a define on by default, the switch and the knob relinking it, and its grazing hold is where the exact Fresnel reads a rough sea', () => {
    expect(parseSeaSkyParam('')).toBe(true);
    expect(parseSeaSkyParam('?seasky=0')).toBe(false);
    const mat = new THREE.MeshStandardMaterial();
    augmentSurfaceMaterial(mat, 'earth', undefined, 0, undefined, undefined, 'Earth');
    expect(mat.defines?.SEA_SKY).toBe('');
    setSeaSkyEnabled(false);
    expect(seaSkyOn()).toBe(false);
    expect(mat.defines?.SEA_SKY).toBeUndefined();
    setSeaSkyEnabled(true);
    expect(mat.defines?.SEA_SKY).toBe('');
    // Water at normal incidence reflects 2 %; at the hold, 73°, about 0.18,
    // which is what a 7 m/s sea reflects at 80° where a flat one reads 0.35.
    expect(fresnel(1)).toBeCloseTo(0.02, 3);
    expect(fresnel(SEA_SKY_GRAZING_COS)).toBeGreaterThan(0.17);
    expect(fresnel(SEA_SKY_GRAZING_COS)).toBeLessThan(0.185);
    expect(fresnel(0.17)).toBeGreaterThan(0.33);
  });

  it('reads the air table at the surface along the reflected ray in the air frame, its own term held out of the limb, and is no text at all off', () => {
    const text = fragmentOf();
    // One lookup at the surface, its single Mie read whole from the tables
    // under MIE_EXACT and rebuilt from rgb without it — no subtraction here.
    const exact = resolveDefine(text, 'MIE_EXACT', true);
    expect(exact).toContain('getScatteringAndMieColour3D(uScattering, 1.0, skyCos, skyMuS, skyNu, false, skyMieGB)');
    expect(exact).toContain('vec3 skyMie = vec3(skyS.a, skyMieGB) * smoothstep(0.0, 0.01, skyMuS);');
    expect(resolveDefine(text, 'MIE_EXACT', false))
      .toContain('getScattering3DRGBA(uScattering, 1.0, skyCos, skyMuS, skyNu, false)');
    expect(text).toContain('vec3 skyView = normalize(vAirFrag - vAirCam);');
    expect(text).toContain('vec3 skySun = normalize(uSunDirWorld);');
    expect(text).toContain('if (uAirDensity > 0.0 && seaWater > 0.0) {');
    expect(text).toContain('if (skyMuS > uMuSMin) {');
    expect(text).toContain(`seaFresnelExact(max(skyCos, ${SEA_SKY_GRAZING_COS.toFixed(2)}))`);
    expect(text).toContain('seaSky *= sunVisible;');
    expect(text).toContain('limbHeld += seaSky;');
    // The term never joins the beam: the cloud cut, the shoulder and the
    // probe's attribution read seaGlint alone.
    expect(text).not.toMatch(/seaGlint\s*\+=\s*seaSky|seaGlint = seaGlint \+ seaSky/);
    const off = resolveDefine(text, 'SEA_SKY', false);
    expect(off).not.toContain('skyRadiance');
    expect(off).not.toContain('limbHeld += seaSky');
    expect(off).not.toContain('seaSky *= sunVisible');
  });
});
