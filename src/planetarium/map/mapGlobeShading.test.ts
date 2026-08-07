import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  augmentMapGlobeMaterial,
  makeMapSunUniforms,
  mapTerminatorSoftness,
  MAP_NIGHT_FLOOR_LINEAR,
  MAP_TERMINATOR_MAX,
  MAP_TERMINATOR_SOFT_PX,
} from './mapGlobeShading';
import { mapMarkerRadiusPx, MAP_BODY_SIZE_DEFAULTS } from './mapBodySize';
import { PLANETARIUM_BODIES } from '../planets/planetData';

/** The shape the injected GLSL applies, mirrored here so the properties the
 *  shader is written for can be stated: it rounds the corner off max(c, 0)
 *  without moving the lit face. Kept to this file — the shader is the only
 *  implementation that ships. */
const softened = (ndl: number, s: number): number =>
  Math.min(1, 0.5 * (ndl + Math.sqrt(ndl * ndl + s * s)));
const hard = (ndl: number): number => Math.min(1, Math.max(ndl, 0));

describe('mapTerminatorSoftness', () => {
  it('holds the eased band at a fixed width on screen, whatever the size', () => {
    // The point of metering in px: a body twice as big eases over half as much
    // cosine, so the band the eye sees stays the same width.
    for (const r of [8, 16, 40, 120, 400]) {
      expect(mapTerminatorSoftness(r) * r).toBeCloseTo(MAP_TERMINATOR_SOFT_PX, 12);
    }
  });

  it('shrinks toward nothing as a body is resolved', () => {
    let prev = Infinity;
    for (const r of [6, 12, 30, 80, 200]) {
      const s = mapTerminatorSoftness(r);
      expect(s).toBeLessThan(prev);
      prev = s;
    }
    // A dived-into globe is left with antialiasing and nothing else.
    expect(mapTerminatorSoftness(400)).toBeLessThan(0.005);
  });

  it('caps the easing so a marker-sized body still has a night side', () => {
    for (const r of [0.5, 1, 3, MAP_TERMINATOR_SOFT_PX / MAP_TERMINATOR_MAX - 0.01]) {
      expect(mapTerminatorSoftness(r)).toBe(MAP_TERMINATOR_MAX);
    }
    // At the cap the terminator itself is a sixth of full daylight — soft, and
    // still plainly an edge.
    expect(softened(0, MAP_TERMINATOR_MAX)).toBeCloseTo(MAP_TERMINATOR_MAX / 2, 12);
    expect(softened(0, MAP_TERMINATOR_MAX)).toBeLessThan(0.2);
  });

  it('takes the cap for a body whose drawn size is not known yet', () => {
    expect(mapTerminatorSoftness(0)).toBe(MAP_TERMINATOR_MAX);
    expect(mapTerminatorSoftness(-4)).toBe(MAP_TERMINATOR_MAX);
    expect(mapTerminatorSoftness(Number.NaN)).toBe(MAP_TERMINATOR_MAX);
  });

  it('eases every planet at the overview marker, and none of them flat', () => {
    for (const planet of PLANETARIUM_BODIES) {
      const r = mapMarkerRadiusPx(planet.radiusAU, MAP_BODY_SIZE_DEFAULTS);
      const s = mapTerminatorSoftness(r);
      expect(s, planet.name).toBeGreaterThan(0.05);
      expect(s, planet.name).toBeLessThanOrEqual(MAP_TERMINATOR_MAX);
    }
  });
});

describe('the softened response the shader applies', () => {
  it('is exactly the hard one when nothing is asked for', () => {
    for (const ndl of [-1, -0.4, 0, 0.2, 0.75, 1]) {
      expect(softened(ndl, 0)).toBe(hard(ndl));
    }
  });

  it('leaves the lit face alone at the sizes bodies actually draw', () => {
    // Every planet marker and every drawn moon asks for 0.13 or less (1.6 px
    // over a radius of 12 px and up). There the lit face agrees with the hard
    // cosine to under a percent: the body keeps its own shading, and only the
    // terminator is touched.
    for (const s of [0.02, 0.05, 0.13]) {
      for (const ndl of [0.5, 0.7, 1]) {
        expect(Math.abs(softened(ndl, s) - hard(ndl))).toBeLessThan(0.01);
      }
    }
    // At the cap — a body a few px across, where the alternative is a stair —
    // the lit face lifts a few percent, and the sub-solar point not at all.
    expect(softened(0.5, MAP_TERMINATOR_MAX) - hard(0.5)).toBeLessThan(0.06);
    expect(softened(1, MAP_TERMINATOR_MAX)).toBeCloseTo(1, 6);
  });

  it('never darkens, and never takes a body over full daylight', () => {
    for (const s of [0.02, 0.13, MAP_TERMINATOR_MAX]) {
      for (let ndl = -1; ndl <= 1.0001; ndl += 0.01) {
        expect(softened(ndl, s)).toBeGreaterThanOrEqual(hard(ndl) - 1e-12);
        expect(softened(ndl, s)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('spends its lift on the terminator and lets it go on the night side', () => {
    const s = 0.2;
    expect(softened(0, s)).toBeCloseTo(s / 2, 12);
    // Well past the terminator the lift decays as s²/4|c| — present, fading,
    // never a wall of light on the dark hemisphere.
    expect(softened(-0.5, s)).toBeCloseTo((s * s) / (4 * 0.5), 2);
    expect(softened(-1, s)).toBeLessThan(0.02);
  });
});

// ── The compile-time seam ────────────────────────────────────────────────────
// The injection rewrites three's stock fragment shader by string anchor. An
// anchor that drifts on a three upgrade fails SILENTLY — replace() just
// no-ops — so the seam is driven here against the shipped ShaderLib source:
// every anchor must exist, and every rewrite must land.
describe('augmentMapGlobeMaterial', () => {
  function compiled() {
    const mat = new THREE.MeshStandardMaterial();
    const sun = makeMapSunUniforms(new THREE.Color(0xfff4e2), Math.PI);
    const shading = augmentMapGlobeMaterial(mat, sun);
    const shader = {
      uniforms: {} as Record<string, unknown>,
      fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    };
    mat.onBeforeCompile!(shader as never, null as never);
    return { sun, shading, shader };
  }

  it('finds every anchor in the shipped shader source', () => {
    const src = THREE.ShaderLib.physical.fragmentShader;
    expect(src).toContain('#include <common>');
    expect(src).toContain('#include <lights_fragment_begin>');
    expect(src).toContain(
      'vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;',
    );
  });

  it('wires the shared uniforms by identity and lands all three rewrites', () => {
    const { sun, shading, shader } = compiled();
    expect(shader.uniforms.uMapSunViewPos).toBe(sun.viewPos);
    expect(shader.uniforms.uMapSunIrradiance).toBe(sun.irradiance);
    expect(shader.uniforms.uMapNightFloor).toBe(sun.nightFloor);
    expect(shader.uniforms.uMapTermSoft).toBe(shading.softness);
    const out = shader.fragmentShader;
    expect(out).toContain('uniform vec3 uMapNightFloor;');
    expect(out).toContain('uMapTermSoft * uMapTermSoft');
    // The floor is a MAX past the albedo multiply — the stock assembly line
    // must be gone, replaced by the floored one. The function name is pinned
    // literally: a min() here would cap daylight at the floor instead of
    // lifting night, and every other assertion would still pass.
    expect(out).not.toContain(
      'vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;',
    );
    expect(out).toContain('vec3 outgoingLight = max(');
    expect(out).toContain('totalDiffuse + totalSpecular + totalEmissiveRadiance, uMapNightFloor);');
  });

  it('keeps one compiled program across bodies: the hook source is shared', () => {
    // three keys its program cache on onBeforeCompile.toString() — per-body
    // closures would compile one program per globe. The source must be
    // byte-identical however many materials carry their own uniforms through.
    const sun = makeMapSunUniforms(new THREE.Color(0xfff4e2), Math.PI);
    const a = new THREE.MeshStandardMaterial();
    const b = new THREE.MeshStandardMaterial();
    augmentMapGlobeMaterial(a, sun);
    augmentMapGlobeMaterial(b, sun);
    expect(a.onBeforeCompile!.toString()).toBe(b.onBeforeCompile!.toString());
  });

  it('floors above the chart background once tonemapped and encoded', () => {
    // The whole point of the floor: a globe pixel can never read darker than
    // empty space (the clear colour is written raw; only materials tonemap).
    // Mirror three's ACTUAL ACESFilmicToneMapping — the 1/0.6 pre-scale, the
    // ACES input/output matrices, and the Hill RRTAndODTFit. The first cut of
    // this test used the scalar 2.51/2.43 fit, which over-predicts ~3× at
    // these levels and passed a floor that rendered BELOW the background
    // (measured (3,6,12) on screen) — the mirror must be the shipped curve.
    const MIN = [
      [0.59719, 0.35458, 0.04823],
      [0.07600, 0.90834, 0.01566],
      [0.02840, 0.13383, 0.83777],
    ];
    const MOUT = [
      [1.60475, -0.53108, -0.07367],
      [-0.10208, 1.10813, -0.00605],
      [-0.00327, -0.07276, 1.07602],
    ];
    const mul = (m: number[][], v: number[]): number[] =>
      m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
    const rrt = (v: number[]): number[] => v.map(
      (x) => (x * (x + 0.0245786) - 0.000090537) / (x * (0.983729 * x + 0.4329510) + 0.238081),
    );
    const aces = (v: number[]): number[] =>
      mul(MOUT, rrt(mul(MIN, v.map((x) => x / 0.6))))
        .map((x) => Math.min(1, Math.max(0, x)));
    const srgb = (x: number): number =>
      x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
    const bg = [0x05, 0x07, 0x0d];
    const screen = aces(MAP_NIGHT_FLOOR_LINEAR.toArray()).map((x) => srgb(x) * 255);
    for (let c = 0; c < 3; c++) {
      // Strictly above the background, and quiet: within a handful of counts.
      // A night side against space should be nearly invisible — the floor
      // exists so it can never be a hole, not so it glows.
      expect(screen[c]).toBeGreaterThan(bg[c] + 0.5);
      expect(screen[c]).toBeLessThan(bg[c] + 6);
    }
  });
});
