import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import {
  CLOUD_COVERAGE_GLSL,
  CLOUD_COVERAGE_HIGH,
  CLOUD_COVERAGE_LOW,
  CLOUD_NORMAL_SCALE,
  cloudCoverageAlpha,
  luminance,
} from './cloudDeck';
import {
  appliedNormalHeldBytes,
  applyNormalTierTexture,
  equirectMapGpuBytes,
  makeNormalUpgrade,
  NORMAL_UPGRADE_TIERS,
  PLANET_TEXTURE_FILES,
  TIER_RANK,
} from '../PlanetFactory';
import { augmentSurfaceMaterial, type SurfaceArchetype } from './surfaceShading';

/** The subset of three's onBeforeCompile shader object the augmentation writes. */
function mockShader() {
  return {
    uniforms: {} as Record<string, unknown>,
    vertexShader: '#include <common>\nvoid main() {\n#include <begin_vertex>\n}',
    fragmentShader: '#include <common>\nvoid main() {\n#include <opaque_fragment>\n}',
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

  it('stays one compiled program for every body', () => {
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
      expect(next.mat.defines, a).toEqual(first.mat.defines);
    }
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
    mat.normalMap = new THREE.Texture({ width: 4096, height: 2048 } as unknown as HTMLImageElement);
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

