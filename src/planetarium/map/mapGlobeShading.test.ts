import { describe, it, expect } from 'vitest';
import {
  mapTerminatorSoftness,
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
