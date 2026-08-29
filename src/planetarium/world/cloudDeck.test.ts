import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import {
  CLOUD_COVERAGE_GLSL,
  CLOUD_COVERAGE_HIGH,
  CLOUD_COVERAGE_LOW,
  cloudCoverageAlpha,
  luminance,
} from './cloudDeck';
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
