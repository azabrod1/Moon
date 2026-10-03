import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import {
  CLOUD_COVERAGE_GLSL,
  CLOUD_COVERAGE_HIGH,
  CLOUD_COVERAGE_LOW,
  CLOUD_ALBEDO,
  CLOUD_ALBEDO_BLEND,
  CLOUD_CITY_GLOW,
  CLOUD_DETAIL_ERODE,
  CLOUD_DETAIL_FADE_END,
  CLOUD_DETAIL_FADE_START,
  CLOUD_DETAIL_GLSL,
  CLOUD_EDGE_BAND,
  CLOUD_FRAME_GLSL,
  CLOUD_NORMAL_SCALE,
  CLOUD_TOP_KM,
  bodyToDeck,
  cloudCoverageAlpha,
  cloudRayDirection,
  cloudShellScale,
  cloudDetailFade,
  cloudEdgeBand,
  luminance,
  sphereEquirectUv,
  SPHERE_EQUIRECT_UV_GLSL,
} from './cloudDeck';
import { cloudDetailTexture } from './cloudDetailNoise';
import {
  appliedNormalHeldBytes,
  applyNormalTierTexture,
  makeNormalUpgrade,
  NORMAL_UPGRADE_TIERS,
  PLANET_TEXTURE_FILES,
  TIER_RANK,
} from './textureLadder';
import { equirectMapGpuBytes } from './textureBytes';
import {
  EARTH_NIGHT_COLD_CUT, EARTH_NIGHT_MIX_SCALE, EARTH_NIGHT_WARM_GLSL,
  earthNightFragmentShader,
} from '../../shared/shaders/atmosphere';
import { createEarthNightShellMaterial } from './earthNightMaterial';
import {
  AIR_LOOKUP_RADIUS, augmentSurfaceMaterial, createSurfaceAirFx, type SurfaceArchetype,
} from './surfaceShading';
import { PLANETS } from '../planets/planetData';

const EARTH_RADIUS_KM = PLANETS.find((p) => p.name === 'Earth')!.radiusKm;
import { mapTexture } from '../testing/upgradeHarness';
import { resolveDefine } from '../testing/glslDefine';

/** The subset of three's onBeforeCompile shader object the augmentation writes. */
function mockShader() {
  return {
    uniforms: {} as Record<string, unknown>,
    vertexShader: '#include <common>\nvoid main() {\n#include <begin_vertex>\n}',
    // The map chunk is included as well: the deck's colour tap lives there.
    fragmentShader: '#include <common>\nvoid main() {\n#include <map_fragment>\n#include <normal_fragment_maps>\n#include <opaque_fragment>\n}',
  };
}

function compiled(archetype: SurfaceArchetype) {
  const mat = new THREE.MeshStandardMaterial();
  augmentSurfaceMaterial(mat, archetype);
  const shader = mockShader();
  (mat.onBeforeCompile as (s: typeof shader, r: unknown) => void)(shader, null);
  return { mat, shader };
}

/** The stored (file) luminance a linear sample of this value came from. */
const stored = (linear: number): number => Math.pow(linear, 1 / 2.2);
/** ...and back, so a test can name a value in the space the curve is authored in. */
const linearFor = (storedValue: number): number => Math.pow(storedValue, 2.2);

describe('the cloud deck\'s coverage curve', () => {
  it('leaves clear sky with no deck on it at all', () => {
    // The whole point of reading the map: a pixel the map calls empty gets no
    // veil, so the ground under it is at its own brightness.
    expect(cloudCoverageAlpha(0)).toBe(0);
    expect(cloudCoverageAlpha(linearFor(CLOUD_COVERAGE_LOW))).toBe(0);
    expect(cloudCoverageAlpha(linearFor(CLOUD_COVERAGE_LOW * 0.5))).toBe(0);
  });

  it('drives thick cloud to full opacity', () => {
    expect(cloudCoverageAlpha(linearFor(CLOUD_COVERAGE_HIGH))).toBe(1);
    expect(cloudCoverageAlpha(1)).toBe(1);
  });

  it('rises smoothly and monotonically between the two edges', () => {
    let previous = -1;
    for (let i = 0; i <= 40; i++) {
      const a = cloudCoverageAlpha(linearFor(i / 40));
      expect(a).toBeGreaterThanOrEqual(previous);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(1);
      previous = a;
    }
    // Half coverage at the midpoint of the authored pair, which is what makes
    // the pair readable as "where cloud starts" and "where it is solid".
    const mid = (CLOUD_COVERAGE_LOW + CLOUD_COVERAGE_HIGH) / 2;
    expect(cloudCoverageAlpha(linearFor(mid))).toBeCloseTo(0.5, 6);
  });

  it('is authored in the space the file is stored in, not the sampler\'s', () => {
    // A curve read straight off the linear sample would put the low edge at
    // stored 0.31 instead of 0.08 and call a third of the world's thin cloud
    // clear sky. The gamma is the difference, and it is the whole reason the
    // shipped map's mean alpha lands where the flat veil's was.
    expect(stored(cloudCoverageAlpha(1))).toBe(1);
    const thinCloud = linearFor(0.25); // a quarter of the way up the stored range
    expect(cloudCoverageAlpha(thinCloud)).toBeGreaterThan(0.1);
    expect(thinCloud).toBeLessThan(CLOUD_COVERAGE_LOW); // ...and would be clear sky read linearly
  });

  it('measures grey with the Rec.709 weights, which sum to one', () => {
    expect(luminance(1, 1, 1)).toBeCloseTo(1, 12);
    expect(luminance(0, 0, 0)).toBe(0);
  });

  it('hands the GLSL the same numbers the TypeScript uses', () => {
    // One pair of edges, two languages: the GLSL is generated from the
    // constants above, so a hand-edit of either is a diff in both.
    expect(CLOUD_COVERAGE_GLSL).toContain(CLOUD_COVERAGE_LOW.toFixed(6));
    expect(CLOUD_COVERAGE_GLSL).toContain(CLOUD_COVERAGE_HIGH.toFixed(6));
    expect(CLOUD_COVERAGE_GLSL).toContain((1 / 2.2).toFixed(6));
    expect(CLOUD_COVERAGE_GLSL).toContain('float cloudCoverage(float linearLuminance)');
  });
});

describe('the deck\'s alpha in the surface augmentation', () => {
  it('switches the coverage on for the deck and off for every other surface', () => {
    const others: SurfaceArchetype[] = ['airless', 'rocky', 'gas', 'icy', 'earth'];
    expect((compiled('cloud').shader.uniforms.uCloudDeck as { value: number }).value).toBe(1);
    for (const a of others) {
      expect((compiled(a).shader.uniforms.uCloudDeck as { value: number }).value, a).toBe(0);
    }
  });

  it('takes the alpha from the coverage rather than a flat opacity', () => {
    const { shader } = compiled('cloud');
    expect(shader.fragmentShader).toContain('cloudAlpha = cloudCoverage(');
    expect(shader.fragmentShader).toContain('diffuseColor.a *= cloudAlpha;');
    expect(shader.fragmentShader).toContain('float cloudCoverage(float linearLuminance)');
  });

  it('replaces the map\'s brightness with the cloud\'s own albedo, before the lights', () => {
    // The map states COVERAGE. Once the alpha carries that, drawing the map's
    // own value as the albedo counts the same fraction twice: a half-covered
    // pixel comes out at half the cloud's brightness AND half the ground's,
    // which is a dark ring around every cloud over bright ground — measured at
    // 22 % below the desert beside it before this landed. And it has to happen
    // upstream of the lights: three reads diffuseColor into the lighting long
    // before <opaque_fragment>, so a colour changed there lights nothing.
    const glsl = compiled('cloud').shader.fragmentShader;
    const albedo = glsl.indexOf('diffuseColor.rgb * pow(uCloudAlbedo');
    expect(albedo).toBeGreaterThan(-1);
    expect(albedo).toBeLessThan(glsl.indexOf('#include <opaque_fragment>'));
    expect(glsl).toContain(CLOUD_ALBEDO_BLEND.toFixed(6));
    expect((compiled('cloud').shader.uniforms.uCloudAlbedo as { value: number }).value).toBe(CLOUD_ALBEDO);
    // Not all of it: above the coverage curve's upper edge every pixel is fully
    // covered and what is left of the map's brightness is real cloud thickness,
    // so a fully normalised deck draws its interiors as one flat white.
    expect(CLOUD_ALBEDO_BLEND).toBeGreaterThan(0);
    expect(CLOUD_ALBEDO_BLEND).toBeLessThan(1);
  });

  it('stays one injected text for every body, and one program for every body but the deck', () => {
    // The archetype is uniforms only. A term that forked the text — even by a
    // number interpolated per body — would be a program per body and per tier,
    // and the warm-up probes that pre-compile the app's variants would then be
    // warming a set that no longer covers it.
    const all: SurfaceArchetype[] = ['airless', 'rocky', 'gas', 'icy', 'earth', 'cloud'];
    const first = compiled(all[0]);
    for (const a of all.slice(1)) {
      const next = compiled(a);
      expect(next.shader.vertexShader, a).toBe(first.shader.vertexShader);
      expect(next.shader.fragmentShader, a).toBe(first.shader.fragmentShader);
      // The deck is the one exception in the DEFINES: its archetype is
      // compiled in. It costs no program, because three already keys the
      // deck's program on its transparency, and the text is the same text —
      // the macros are the only spelling the injected text uses.
      expect(next.mat.defines, a).toEqual(a === 'cloud'
        ? { ...first.mat.defines, CLOUD_DECK: '' }
        : first.mat.defines);
    }
    // Read as a program without the cloud field compiles it (a ground with the
    // field takes DECK_ON as a constant false; world/surfaceShading).
    const glsl = resolveDefine(first.shader.fragmentShader, 'CLOUD_FIELD', false);
    expect(glsl).toContain('#ifdef CLOUD_DECK\n#define DECK_ON true\n#define DECK_OFF false\n#define GROUND_ON(x) false\n#else\n#define DECK_ON (uCloudDeck > 0.0)\n#define DECK_OFF (uCloudDeck == 0.0)\n#define GROUND_ON(x) (x)\n#endif');
    // ...and no other spelling of the deck's condition survives outside them.
    expect(glsl.split('uCloudDeck > 0.0')).toHaveLength(2);
    expect(glsl.split('uCloudDeck == 0.0')).toHaveLength(2);
  });
});

describe('the deck material the factory builds', () => {
  it('carries no flat opacity of its own', () => {
    // Read as text: building the deck needs Earth's whole detail load, and the
    // number this checks is a literal in that construction. A fraction here
    // would scale the coverage curve down again — the flat veil, one factor
    // further along, and invisible to every test that only reads the shader.
    const src = readFileSync(resolve(__dirname, '../PlanetFactory.ts'), 'utf8');
    const deck = src.slice(src.indexOf('const cloudMat = new THREE.MeshStandardMaterial({'));
    const literal = deck.slice(0, deck.indexOf('});'));
    expect(literal).toContain('map: cloudTex');
    expect(literal).toContain('opacity: 1,');
    expect(literal).toContain('transparent: true');
  });
});

describe('the deck\'s relief', () => {
  it('reads at the authored depth, not the map\'s own', () => {
    // A height field guessed from brightness at full depth embosses the banks
    // into ridges the moment the Sun is low.
    expect(CLOUD_NORMAL_SCALE).toBe(0.6);
    const src = readFileSync(resolve(__dirname, '../PlanetFactory.ts'), 'utf8');
    const deck = src.slice(src.indexOf('const cloudMat = new THREE.MeshStandardMaterial({'));
    expect(deck.slice(0, deck.indexOf('});')))
      .toContain('normalScale: new THREE.Vector2(CLOUD_NORMAL_SCALE, CLOUD_NORMAL_SCALE)');
  });

  it('keeps that depth across the rung that sharpens it', () => {
    // The boot relief and the 4K one are the same relief at two resolutions.
    // Resetting the scale as a rung lands would make the swap a visible pop —
    // and would flatten the deck's authored 0.6 to the Moon's 1.
    const mat = new THREE.MeshStandardMaterial();
    mat.normalScale.set(CLOUD_NORMAL_SCALE, CLOUD_NORMAL_SCALE);
    expect(applyNormalTierTexture(mat, new THREE.Texture(), TIER_RANK['4k'])).toBe(true);
    expect(mat.normalScale.x).toBe(CLOUD_NORMAL_SCALE);
    expect(mat.normalScale.y).toBe(CLOUD_NORMAL_SCALE);
  });

  it('ships at one resolution, with no rung above it', () => {
    // Bytes, not taste: a cloud field's normal map is nearly incompressible, so
    // the 4K one is 15.6 MB lossless and 10.3 MB near-lossless against the
    // 4.7 MB of the 8K COLOUR rung that doubles the resolution of the picture
    // itself. The band a rung would add is the one the detail noise covers.
    expect(NORMAL_UPGRADE_TIERS.earthCloudsNormal).toBeUndefined();
    expect(makeNormalUpgrade('earthCloudsNormal', new THREE.MeshStandardMaterial())).toBeUndefined();
    expect(PLANET_TEXTURE_FILES.earthCloudsNormal).toBe('earth-clouds-normal.webp');
  });

  it('would be counted in the envelope ledger the moment it earned a rung', () => {
    // The relief ladders spend the same envelope the colour ones do — the
    // Moon's 4K relief is 42.7 MiB and was not in this sum before — so the
    // tiles give way for one exactly as they do for a colour rung. The boot
    // relief every device fetches regardless is not the ladder's weight.
    const mat = new THREE.MeshStandardMaterial();
    const up = makeNormalUpgrade('moonNormal', mat);
    expect(up).toBeDefined();
    expect(appliedNormalHeldBytes(up)).toBe(0);
    mat.normalMap = mapTexture(4096);
    expect(appliedNormalHeldBytes(up)).toBe(0); // still not applied
    up!.state = 'done';
    expect(appliedNormalHeldBytes(up)).toBe(equirectMapGpuBytes(4096));
    expect(appliedNormalHeldBytes(undefined)).toBe(0);
  });

  it('is summed into the ladder\'s share of the envelope', () => {
    // Read as text: the sum is a private per-frame method on the mode. A relief
    // rung left out of it is 42.7 MiB the tiles are never trimmed for.
    const mode = readFileSync(resolve(__dirname, '../PlanetariumMode.ts'), 'utf8');
    const ledger = mode.slice(
      mode.indexOf('private liveGlobalMapBytes(): number {'),
      mode.indexOf('/** Every colour-tier handle in the scene'),
    );
    expect(ledger).not.toBe('');
    expect(ledger).toContain('appliedNormalHeldBytes(up)');
  });

  it('lights under the Moon off the map-perturbed normal', () => {
    // The night terms read `normal`, and three writes the normal map into it in
    // <normal_fragment_maps>. The augmentation is injected before
    // <opaque_fragment>, which is downstream of that — so moonlight on the deck
    // shades the cloud tops rather than the sphere they sit on.
    const physical = THREE.ShaderLib.physical.fragmentShader;
    expect(physical.indexOf('#include <normal_fragment_maps>')).toBeGreaterThan(-1);
    expect(physical.indexOf('#include <normal_fragment_maps>'))
      .toBeLessThan(physical.indexOf('#include <opaque_fragment>'));
    const glsl = compiled('cloud').shader.fragmentShader;
    const injected = glsl.indexOf('float cloudAlpha = 1.0;');
    expect(injected).toBeGreaterThan(-1);
    expect(injected).toBeLessThan(glsl.indexOf('#include <opaque_fragment>'));
    expect(glsl).toContain('dot(normalize(normal), normalize(vMoonViewDir))');
  });
});

describe('the relief maps on disk', () => {
  it('ships every tier every relief ladder names, and the deck\'s own map', () => {
    // Texture paths are runtime strings, invisible to tsc and Vite: a missing
    // one is a 404 the deck survives by staying flat for the session.
    const textures = resolve(__dirname, '../../../public/textures');
    const wanted = [resolve(textures, PLANET_TEXTURE_FILES.earthCloudsNormal)];
    for (const [key, tier] of Object.entries(NORMAL_UPGRADE_TIERS)) {
      wanted.push(resolve(textures, tier, PLANET_TEXTURE_FILES[key]));
    }
    for (const path of wanted) {
      expect(path).toBe(existsSync(path) ? path : `MISSING ${path}`);
    }
  });
});

describe('the deck\'s detail term', () => {
  it('is at full strength while the map is magnified and gone once it is not', () => {
    expect(cloudDetailFade(0)).toBe(1);
    expect(cloudDetailFade(CLOUD_DETAIL_FADE_START)).toBe(1);
    expect(cloudDetailFade(CLOUD_DETAIL_FADE_END)).toBe(0);
    // Arrival range: the whole globe in frame is about nine noise texels per
    // pixel, where the term must contribute nothing at all rather than a
    // shimmering pattern.
    expect(cloudDetailFade(9)).toBe(0);
    let previous = 2;
    for (let i = 0; i <= 30; i++) {
      const f = cloudDetailFade(i / 10);
      expect(f).toBeLessThanOrEqual(previous);
      previous = f;
    }
  });

  it('erodes the coverage at its edges and nowhere else', () => {
    // Clear sky gains no wisps the map does not have, and a solid cloud gets no
    // holes punched in its middle.
    expect(cloudEdgeBand(0)).toBe(0);
    expect(cloudEdgeBand(CLOUD_EDGE_BAND[0])).toBe(0);
    expect(cloudEdgeBand(1)).toBe(0);
    expect(cloudEdgeBand(CLOUD_EDGE_BAND[3])).toBe(0);
    expect(cloudEdgeBand(0.5)).toBeGreaterThan(0.9);
  });

  it('hands the GLSL the same numbers again', () => {
    expect(CLOUD_DETAIL_GLSL).toContain(CLOUD_DETAIL_FADE_START.toFixed(6));
    expect(CLOUD_DETAIL_GLSL).toContain(CLOUD_DETAIL_FADE_END.toFixed(6));
    for (const edge of CLOUD_EDGE_BAND) expect(CLOUD_DETAIL_GLSL).toContain(edge.toFixed(6));
  });

  it('costs one texel fetch per deck fragment and nothing on any other surface', () => {
    // The whole frame-time claim: one normal fetch (three's own, from the
    // relief map) and one noise fetch. A second octave sampled in the shader
    // would be a second dependent fetch on every fragment of the disc.
    const glsl = compiled('cloud').shader.fragmentShader;
    expect(glsl.match(/textureGrad\(uCloudDetail/g)).toHaveLength(1);
    expect(glsl.match(/uCloudDetail\s*,/g)).toHaveLength(1);
    // ...behind a uniform branch, so every other body pays a comparison.
    expect(glsl).toContain('if (DECK_ON) {');
    for (const a of ['airless', 'rocky', 'gas', 'icy', 'earth'] as SurfaceArchetype[]) {
      expect((compiled(a).shader.uniforms.uCloudDetailErode as { value: number }).value, a).toBe(0);
    }
    expect((compiled('cloud').shader.uniforms.uCloudDetailErode as { value: number }).value)
      .toBe(CLOUD_DETAIL_ERODE);
  });

  it('takes every derivative in uniform control flow', () => {
    // A derivative under a per-fragment condition is undefined, and the fade is
    // exactly such a condition: on a driver that takes the licence, the deck
    // gets a wrong mip and a wrong slope wherever the quad straddles the fade.
    // The deck never compiles the ground's cloud shadow (CLOUD_SHADOW), so the
    // text read here is that define's off arm, as the deck's driver reads it.
    const glsl = resolveDefine(resolveDefine(compiled('cloud').shader.fragmentShader, 'CLOUD_SHADOW', false),
      'CLOUD_LIGHT', false);
    const block = glsl.slice(glsl.indexOf('float cloudAlpha = 1.0;'), glsl.indexOf('vec4 detail = vec4(0.0);'));
    // The deck's own block only — the injection point carries other terms
    // after it, and each answers for its own derivatives.
    const inner = glsl.slice(
      glsl.indexOf('if (cloudDetailW > 0.0) {'),
      glsl.indexOf('normal = normalize(nrm - surfGrad * cloudDetailW);'),
    );
    // Two for the deck's geometry in view space and two for its direction in
    // the body frame, which both the ground's night map and the detail's own
    // sheet are read from. A development build carries two more: the world
    // frame the detail was read in before, the control arm, behind a uniform
    // the whole draw takes the same way.
    expect(block.match(/dFd[xy]\(/g)).toHaveLength(import.meta.env.DEV ? 6 : 4);
    expect(inner).not.toMatch(/dFd[xy]\(/);
    // Past the detail block the shared surface body has one derivative site of
    // its own, the sea's lookup into the deck map, and it sits under a compare
    // against a UNIFORM — the whole draw takes the same side of it, which is
    // what makes the derivative defined.
    const after = glsl.slice(glsl.indexOf('diffuseColor.a *= cloudAlpha;'), glsl.indexOf('#include <opaque_fragment>'));
    const gloss = after.slice(after.indexOf('if (GROUND_ON(uWaterGloss > 0.0)) {'), after.indexOf('float sunElevSin'));
    expect(after.match(/dFd[xy]\(/g)).toHaveLength(2);
    expect(gloss.match(/dFd[xy]\(/g)).toHaveLength(2);
    // The clear-sky return (CLOUD_CLEAR_RETURN) sits after the last derivative
    // the deck's path takes and before the alpha is applied, and between it
    // and the sea's uniform compare there is no derivative and no fwidth: the
    // lanes it leaves divergent never reach one.
    const ret = glsl.indexOf('cloudAlpha == 0.0) { gl_FragColor = vec4(0.0); return; }');
    const lastDerivative = glsl.indexOf('cloudNightDy = sphereEquirectUvGrad(objDir, objDy);');
    expect(lastDerivative).toBeGreaterThan(-1);
    expect(ret).toBeGreaterThan(lastDerivative);
    expect(ret).toBeLessThan(glsl.indexOf('diffuseColor.a *= cloudAlpha;'));
    expect(glsl.slice(ret, glsl.indexOf('if (GROUND_ON(uWaterGloss > 0.0)) {'))).not.toMatch(/dFd[xy]\(|fwidth\(/);
    // The relief's plain tap is taken once, in uniform flow, as three's chunk
    // always took it, and the smooth filter mixes from that same texel. Two
    // attempts to skip it at full weight are closed (SURFACE_MAP_FRAGMENT):
    // an implicit fetch under the weight rests on undefined derivatives, and
    // an explicit-gradient one under the weight picks a different mip.
    expect(glsl).toContain('vec4 reliefTexel = texture2D( normalMap, vNormalMapUv );');
    expect(glsl.match(/texture2D\( normalMap, vNormalMapUv \)/g)).toHaveLength(1);
    expect(glsl).not.toMatch(/SmoothW < 1\.0/);
    expect(glsl).not.toContain('textureGrad( map,');
    expect(glsl).not.toContain('textureGrad( normalMap,');
  });

  it('reads the detail on the deck\'s own sheet, so it turns and drifts with the cloud', () => {
    // The shader has the fragment in the BODY frame (vObjPos) and the drift
    // the deck's mesh carries (uFrameSpin, its rotation.y); the detail is read
    // at the mesh's own direction, which is the body frame turned back by it.
    // Read in the world's axes it stood still in the sky while the planet
    // turned; turned the wrong way it slides across the cloud at twice the
    // drift.
    const glsl = compiled('cloud').shader.fragmentShader;
    expect(glsl).toContain('vec3 dir = bodyToDeck(objDir, uFrameSpin);');
    expect(glsl).toContain('vec3 ddx = bodyToDeck(objDx, uFrameSpin);');
    expect(glsl).toContain('vec3 ddy = bodyToDeck(objDy, uFrameSpin);');
    expect(glsl).toContain('uniform float uFrameSpin;');
    // Nothing on the detail's path still reads the world's axes, outside the
    // development build's control arm.
    const detail = glsl.slice(glsl.indexOf('vec3 dir = bodyToDeck'), glsl.indexOf('vec4 detail = vec4(0.0);'));
    const arm = import.meta.env.DEV
      ? detail.slice(detail.indexOf('if (uPerfCloudNoiseFrame < 0.5) {'), detail.indexOf('float cosLat'))
      : '';
    expect(detail.replace(arm, '')).not.toContain('vAirFrag');
    // The vertex stage's own construction of vObjPos from the mesh position —
    // three's rotation about y by the drift — undone by bodyToDeck exactly.
    let worst = 0;
    for (let i = 0; i < 200; i++) {
      const p = new THREE.Vector3(Math.sin(i * 1.7), Math.cos(i * 0.9) * 0.9, Math.sin(i * 2.3 + 1)).normalize();
      const spin = (i * 0.731) % (2 * Math.PI);
      const body = p.clone().applyEuler(new THREE.Euler(0, spin, 0));
      const c = Math.cos(spin);
      const sn = Math.sin(spin);
      // The vertex stage's formula is that rotation, written out.
      expect(body.distanceTo(new THREE.Vector3(p.x * c + p.z * sn, p.y, p.z * c - p.x * sn))).toBeLessThan(1e-12);
      const back = bodyToDeck([body.x, body.y, body.z], spin);
      worst = Math.max(worst, Math.hypot(back[0] - p.x, back[1] - p.y, back[2] - p.z));
    }
    expect(worst).toBeLessThan(1e-12);
  });

  it('perturbs the normal upstream of the lights, not after them', () => {
    const glsl = compiled('cloud').shader.fragmentShader;
    expect(glsl.indexOf('normal = normalize(nrm - surfGrad'))
      .toBeLessThan(glsl.indexOf('#include <opaque_fragment>'));
    expect(glsl.indexOf('#include <normal_fragment_maps>'))
      .toBeLessThan(glsl.indexOf('float cloudAlpha = 1.0;'));
  });

  it('shares one detail map across every deck material', () => {
    // A map per material would be 5.3 MiB apiece and 30 ms of build each.
    const a = compiled('cloud').shader.uniforms.uCloudDetail as { value: unknown };
    const b = compiled('cloud').shader.uniforms.uCloudDetail as { value: unknown };
    expect(a.value).toBe(b.value);
    expect(a.value).toBe(cloudDetailTexture());
    expect((compiled('earth').shader.uniforms.uCloudDetail as { value: unknown }).value)
      .not.toBe(a.value);
  });
});

describe('the deck lit from below', () => {
  it('glows a covered city at three tenths of its bare brightness', () => {
    // The night-lights shell draws the map at 1.5, so this is 0.3 of that: a
    // town fully under cloud reads at 30 % of the town beside it in clear air,
    // and the deck's own alpha takes it the rest of the way down as the cover
    // thins. Both numbers in one expression, so neither can move alone.
    expect(CLOUD_CITY_GLOW / EARTH_NIGHT_MIX_SCALE).toBeCloseTo(0.3, 6);
  });

  it('weights the glow by the cover and by the shared night ramp', () => {
    const glsl = compiled('cloud').shader.fragmentShader;
    expect(glsl).toContain(
      `outgoingLight += city * ${EARTH_NIGHT_WARM_GLSL}\n        `
        + '* (uCloudCityGlow * cloudAlpha * cloudNight);',
    );
    // The deck's night weight is the SHARED ramp, so the glow fades along the
    // same line the airglow and the sky's ambient do...
    expect(glsl).toContain('cloudNight = DECK_ON\n      ? nightWeight(');
    // ...but not through uAirDensity: a city glowing through cloud happens on a
    // device that baked no tables at all.
    expect(glsl).not.toContain('cloudNight = uAirDensity');
  });

  it('gates the map with the one cold cut the lights themselves use', () => {
    const glsl = compiled('cloud').shader.fragmentShader;
    expect(glsl).toContain(`smoothstep(${(-EARTH_NIGHT_COLD_CUT / 255).toFixed(6)}, 0.0, city.r - city.b)`);
    expect(earthNightFragmentShader)
      .toContain(`smoothstep(${(-EARTH_NIGHT_COLD_CUT / 255).toFixed(6)}, 0.0, nightColor.r - nightColor.b)`);
  });

  it('costs a fetch only past the terminator', () => {
    // One lookup, under the night weight — the day half of the disc pays a
    // comparison. The deck's per-fragment budget is the noise fetch and the
    // relief map three reads for it; a third unconditional one would be a
    // dependent read on every pixel of a full-frame globe.
    const glsl = compiled('cloud').shader.fragmentShader;
    expect(glsl.match(/textureGrad\(uNightLights/g)).toHaveLength(1);
    expect(glsl).toContain('if (cloudNight > 0.0 && uCloudCityGlow > 0.0) {');
    for (const a of ['airless', 'rocky', 'gas', 'icy', 'earth'] as SurfaceArchetype[]) {
      expect((compiled(a).shader.uniforms.uCloudCityGlow as { value: number }).value, a).toBe(0);
    }
  });

  it('reads the night map through the body\'s own uniform, not a copy of it', () => {
    // The shell's ladder sharpens that map from 20 km per pixel to 500 m. A
    // second uniform here would leave the deck glowing the boot map for the
    // rest of the session, one layer under a lit coastline.
    const air = createSurfaceAirFx();
    const map = new THREE.Texture();
    const shell = createEarthNightShellMaterial(map, air);
    expect(shell.uniforms.nightTexture).toBe(air.uNightLights);
    expect(air.uNightLights.value).toBe(map);
    const sharper = new THREE.Texture();
    shell.uniforms.nightTexture.value = sharper; // what the colour ladder does
    expect(air.uNightLights.value).toBe(sharper);
    // ...and that object is what the deck's own material binds.
    const deck = new THREE.MeshStandardMaterial();
    augmentSurfaceMaterial(deck, 'cloud', undefined, 0, {
      uSunDirWorld: { value: new THREE.Vector3() },
      uSunDirLocal: { value: new THREE.Vector3() },
      uMoonShadow: { value: [] },
      uMoonShadowCount: { value: 0 },
      uPlanetshineColor: { value: new THREE.Color() },
      uPlanetshineDir: { value: new THREE.Vector3() },
      uPlanetshineIntensity: { value: 0 },
      uSilhouette: { value: 0 },
      uNightLift: { value: 0 },
      uCloudAbove: { value: 0 },
      air,
    });
    const shader = mockShader();
    (deck.onBeforeCompile as (s: typeof shader, r: unknown) => void)(shader, null);
    expect(shader.uniforms.uNightLights).toBe(air.uNightLights);
  });

  it('looks the ground up in the ground\'s frame, at the UV the geometry gives', () => {
    // The deck drifts on top of the body's spin, so its own UV is that drift
    // out of register with the cities under it — the lookup runs off vObjPos,
    // which is the body frame. And the formula has to be three's own: a
    // half-turn out and every city glows through the cloud on the far side.
    const glsl = compiled('cloud').shader.fragmentShader;
    expect(glsl).toContain('cloudNightUv = sphereEquirectUv(objDir);');
    const geo = new THREE.SphereGeometry(1, 24, 12);
    const pos = geo.attributes.position;
    const uv = geo.attributes.uv;
    let worst = 0;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      if (Math.abs(y) > 0.999) continue; // the poles: longitude is degenerate there
      const [u, v] = sphereEquirectUv(pos.getX(i), y, pos.getZ(i));
      const du = Math.abs(u - uv.getX(i));
      worst = Math.max(worst, Math.min(du, 1 - du), Math.abs(v - uv.getY(i)));
    }
    expect(worst).toBeLessThan(1e-5);
  });

  it('wraps longitude in the shader, the same as the TS twin', () => {
    // atan hands back negative longitude over half the sphere and these maps
    // are clamped, so an unwrapped u makes every fragment on that half read
    // the map's left-edge column instead of what is actually above it — the
    // eastern hemisphere lit by the date line's clouds and cities.
    const value = SPHERE_EQUIRECT_UV_GLSL.slice(
      SPHERE_EQUIRECT_UV_GLSL.indexOf('vec2 sphereEquirectUv(vec3 d)'),
      SPHERE_EQUIRECT_UV_GLSL.indexOf('vec2 sphereEquirectUvGrad'),
    );
    expect(value).toContain('fract(atan(d.z, -d.x)');
    // The gradient must not wrap with it: a slope is a difference, and the
    // seam's jump belongs to the value alone.
    const grad = SPHERE_EQUIRECT_UV_GLSL.slice(SPHERE_EQUIRECT_UV_GLSL.indexOf('vec2 sphereEquirectUvGrad'));
    expect(grad).not.toContain('fract(');
    // The TS twin wraps the same way, so the two halves agree: a direction
    // whose raw atan lands at -0.375 of a turn reads column 0.625.
    expect(sphereEquirectUv(1, 0, -1)[0]).toBeCloseTo(0.625, 12);
  });
});

describe('the deck\'s altitude', () => {
  it('is a real cloud top, not a shell chosen to clear the globe', () => {
    // Cloud tops run from a 2 km marine layer to a 16 km anvil; anything above
    // that is a sheet the eye sees standing off the planet at the limb.
    expect(CLOUD_TOP_KM).toBeGreaterThanOrEqual(2);
    expect(CLOUD_TOP_KM).toBeLessThanOrEqual(16);
    expect(cloudShellScale(EARTH_RADIUS_KM)).toBeCloseTo(1 + CLOUD_TOP_KM / EARTH_RADIUS_KM, 12);
  });

  it('is the same altitude the deck\'s own air segment ends at', () => {
    // The mesh and the air lookup are one number: a deck hazed as if it were
    // somewhere it is not draws unhazed cloud over hazed ground beside it.
    expect(AIR_LOOKUP_RADIUS.cloud).toBe(cloudShellScale(EARTH_RADIUS_KM));
  });

  it('clears Earth\'s night-lights shell, which the deck is drawn over', () => {
    expect(cloudShellScale(EARTH_RADIUS_KM)).toBeGreaterThan(1.001);
  });
});

describe('the deck\'s frames', () => {
  it('turns into the deck frame the way the sea has always turned into it', () => {
    // The sea's lookup into the deck map (world/surfaceShading) writes the
    // turn out by hand; bodyToDeck is the same turn, so the two read one map
    // at one place.
    const glsl = compiled('earth').shader.fragmentShader;
    expect(glsl).toContain('vec3 deckDir = normalize(vec3(vObjPos.x * deckC - vObjPos.z * deckS,\n'
      + '                                  vObjPos.y,\n'
      + '                                  vObjPos.z * deckC + vObjPos.x * deckS));');
    expect(CLOUD_FRAME_GLSL).toContain('return vec3(c * p.x - s * p.z, p.y, s * p.x + c * p.z);');
    const p = [0.3, -0.5, 0.8] as const;
    const spin = 1.234;
    const [x, y, z] = bodyToDeck(p, spin);
    expect(x).toBeCloseTo(p[0] * Math.cos(spin) - p[2] * Math.sin(spin), 15);
    expect(y).toBe(p[1]);
    expect(z).toBeCloseTo(p[2] * Math.cos(spin) + p[0] * Math.sin(spin), 15);
  });

  it('pierces the drawn shell where the exact quadratic does, at every Sun height', () => {
    // The ray n + tL meets the shell at 1 + h/R where t² + 2μt − k = 0. The
    // twin writes the root without the cancellation; the test takes it the
    // plain way in double precision, which has bits to spare.
    const R = EARTH_RADIUS_KM;
    const h = CLOUD_TOP_KM;
    expect(h).toBe(10);
    const hOverR = h / R;
    const k = hOverR * (2 + hOverR);
    const n = [0, 1, 0] as const;
    for (const mu of [1, 0.77, 0.17, 0.05, 0]) {
      // The Sun at this height, off toward +x.
      const L = [Math.sqrt(1 - mu * mu), mu, 0] as const;
      const tExact = -mu + Math.sqrt(mu * mu + k);
      const q = [n[0] + tExact * L[0], n[1] + tExact * L[1], n[2] + tExact * L[2]];
      expect(Math.hypot(q[0], q[1], q[2])).toBeCloseTo(1 + hOverR, 12);
      const len = Math.hypot(q[0], q[1], q[2]);
      const d = cloudRayDirection(n, L, hOverR);
      expect(Math.hypot(d[0], d[1], d[2])).toBeCloseTo(1, 14);
      for (let i = 0; i < 3; i++) expect(d[i]).toBeCloseTo(q[i] / len, 13);
      // The ground's distance along the ray, in km: the cloud a shadow comes
      // from is this far off toward the Sun.
      if (mu === 0) expect(tExact * R).toBeCloseTo(Math.sqrt(2 * R * h + h * h), 6);
      if (mu === 1) expect(tExact * R).toBeCloseTo(h, 6);
    }
    // At the horizon the ray reaches the shell 357 km off, not at infinity.
    expect(Math.sqrt(k) * R).toBeGreaterThan(356);
    expect(Math.sqrt(k) * R).toBeLessThan(358);
  });

  it('keeps its bits with the Sun high, where the plain root cancels', () => {
    // In single precision −μ + √(μ² + k) at μ = 1 is 1 − 1.0016 rounded:
    // a few ulps of 1 carrying all of a 10 km answer. The rationalised form
    // keeps the full precision; Math.fround stands in for the GPU's float.
    const f = Math.fround;
    const hOverR = f(CLOUD_TOP_KM / EARTH_RADIUS_KM);
    const k = f(hOverR * f(2 + hOverR));
    const mu = f(0.999);
    const root = f(Math.sqrt(f(f(mu * mu) + k)));
    const plain = f(root - mu);
    const rational = f(k / f(root + mu));
    const exact = -0.999 + Math.sqrt(0.999 * 0.999 + (CLOUD_TOP_KM / EARTH_RADIUS_KM) * (2 + CLOUD_TOP_KM / EARTH_RADIUS_KM));
    expect(Math.abs(rational - exact) / exact).toBeLessThan(1e-6);
    expect(Math.abs(plain - exact) / exact).toBeGreaterThan(Math.abs(rational - exact) / exact);
    expect(CLOUD_FRAME_GLSL).toContain('float t = mu >= 0.0 ? k / (root + mu) : root - mu;');
  });
});
