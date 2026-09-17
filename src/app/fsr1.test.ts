import { describe, expect, it } from 'vitest';
import {
  EASU_FRAGMENT_SHADER,
  FSR1_VERTEX_SHADER,
  RCAS_DEFAULT_STOPS,
  RCAS_FRAGMENT_SHADER,
  easuConstants,
  rcasSharpness,
  rcasStopsForFactor,
} from './fsr1';

describe('easuConstants', () => {
  it('is the reference con0: output index → input position of the centre, less half', () => {
    // A 2× phone drawing its scene at 1.5: 645×1398 up to 860×1864.
    const [sx, sy, ox, oy] = easuConstants(645, 1398, 860, 1864);
    expect(sx).toBeCloseTo(0.75, 12);
    expect(sy).toBeCloseTo(0.75, 12);
    expect(ox).toBeCloseTo(0.5 * 0.75 - 0.5, 12);
    expect(oy).toBeCloseTo(0.5 * 0.75 - 0.5, 12);
    // Output pixel i lands at (i + 0.5) · 0.75 − 0.5 in the input: pixel 0
    // at −0.125 (its 'f' is texel −1, which the fetch clamps to 0), pixel
    // 859 at 644.125 (the last input texel).
    expect(0 * sx + ox).toBeCloseTo(-0.125, 12);
    expect(859 * sx + ox).toBeCloseTo(644.125, 12);
  });

  it('is the identity at 1:1', () => {
    expect(easuConstants(100, 50, 100, 50)).toEqual([1, 1, 0, 0]);
  });
});

describe('rcasSharpness', () => {
  it('halves per stop from the reference maximum of 1', () => {
    expect(rcasSharpness(0)).toBe(1);
    expect(rcasSharpness(1)).toBe(0.5);
    expect(rcasSharpness(2)).toBe(0.25);
    // The default is one stop: where the upscaled frame's edge energy matches
    // the native frame's (the header of fsr1.ts carries the measurement).
    expect(RCAS_DEFAULT_STOPS).toBe(1);
    expect(rcasSharpness(RCAS_DEFAULT_STOPS)).toBe(0.5);
  });

  it('never sharpens past the maximum', () => {
    expect(rcasSharpness(-3)).toBe(1);
  });
});

describe('rcasStopsForFactor', () => {
  it('gives each measured factor the stops it was measured at', () => {
    // 4/3 is Low on a 2x phone (scene 1.5) and a 1x desktop (scene 0.75).
    expect(rcasStopsForFactor(4 / 3)).toBe(RCAS_DEFAULT_STOPS);
    // 1.15 is Dynamic's first rung down, where one stop reads five per cent
    // sharper than the frame it replaces.
    expect(rcasStopsForFactor(1.15)).toBeCloseTo(1.6, 12);
  });

  it('interpolates between them: the second rung down is a hair over one stop', () => {
    // The rung at 1/1.33 of the output ratio, which is a factor of 1.33 —
    // just under the 4/3 the stop was matched at.
    expect(rcasStopsForFactor(1.33)).toBeCloseTo(1.011, 3);
    // The midpoint of the two factors is the midpoint of the two stops.
    const mid = (1.15 + 4 / 3) / 2;
    expect(rcasStopsForFactor(mid)).toBeCloseTo((1.6 + RCAS_DEFAULT_STOPS) / 2, 12);
  });

  it('holds flat outside the measured range rather than extrapolating', () => {
    // Below the shallowest measurement: the softer end, not a sharpen nobody
    // has looked at.
    expect(rcasStopsForFactor(1.05)).toBe(1.6);
    expect(rcasStopsForFactor(1)).toBe(1.6);
    // Above the deepest: EASU's stated limit is 2x and only a DEV pin reaches
    // past 4/3, so the measured stop stands.
    expect(rcasStopsForFactor(1.5)).toBe(RCAS_DEFAULT_STOPS);
    expect(rcasStopsForFactor(2)).toBe(RCAS_DEFAULT_STOPS);
  });

  it('never sharpens more at a shallower upscale', () => {
    let previous = Infinity;
    for (let factor = 1; factor <= 2.001; factor += 0.01) {
      const stops = rcasStopsForFactor(factor);
      expect(stops).toBeLessThanOrEqual(previous + 1e-12);
      previous = stops;
    }
  });

  it('answers the numbers a division by a degenerate ratio can produce', () => {
    // Nothing finite to interpolate on: the softest measured end, which
    // sharpens least and cannot pop.
    expect(rcasStopsForFactor(Number.NaN)).toBe(1.6);
    expect(rcasStopsForFactor(Number.POSITIVE_INFINITY)).toBe(1.6);
    expect(rcasStopsForFactor(0)).toBe(1.6);
  });
});

describe('the shader text', () => {
  const fragments = [EASU_FRAGMENT_SHADER, RCAS_FRAGMENT_SHADER];

  it('is GLSL ES 3.00 with its own declarations: a raw material gets no prefix from three', () => {
    for (const text of fragments) {
      expect(text).toContain('precision highp float;');
      expect(text).toContain('out vec4 fragColor;');
      expect(text).not.toContain('gl_FragColor');
      expect(text).not.toContain('texture2D');
      expect(text).not.toContain('#version');
    }
    expect(FSR1_VERTEX_SHADER).toContain('in vec3 position;');
    expect(FSR1_VERTEX_SHADER).not.toContain('projectionMatrix');
  });

  it("fetches the reference's twelve EASU taps at the reference's offsets from f", () => {
    const offsets = [...EASU_FRAGMENT_SHADER.matchAll(/tap\(f \+ ivec2\(\s*(-?\d),\s*(-?\d)\)\)/g)]
      .map((m) => `${m[1]},${m[2]}`)
      .sort();
    //    b c
    //  e f g h
    //  i j k l
    //    n o
    expect(offsets).toEqual([
      '0,-1', '1,-1',
      '-1,0', '1,0', '2,0',
      '-1,1', '0,1', '1,1', '2,1',
      '0,2', '1,2',
    ].sort());
    expect(EASU_FRAGMENT_SHADER).toContain('vec3 tF = tap(f);');
    expect(EASU_FRAGMENT_SHADER.match(/easuTap\(aC, aW,/g)).toHaveLength(12);
    expect(EASU_FRAGMENT_SHADER.match(/easuSet\(dir, len,/g)).toHaveLength(4);
    // The fetch clamps to the image, as the reference's sampler does.
    expect(EASU_FRAGMENT_SHADER).toContain('clamp(p, ivec2(0), uInputMax)');
  });

  it("keeps the reference's bit-trick reciprocals and its dering", () => {
    expect(EASU_FRAGMENT_SHADER).toContain('0x7ef07ebbu');
    expect(EASU_FRAGMENT_SHADER).toContain('0x5f347d74u');
    expect(EASU_FRAGMENT_SHADER).toContain('min(max4, max(min4, aC * (1.0 / aW)))');
    expect(RCAS_FRAGMENT_SHADER).toContain('0x7ef19fffu');
  });

  it('holds RCAS off the two divisions the reference leaves bare', () => {
    expect(RCAS_FRAGMENT_SHADER.match(/div0\(/g)).toHaveLength(3); // the definition and its two uses
    expect(RCAS_FRAGMENT_SHADER).toContain('const float RCAS_LIMIT = 0.25 - (1.0 / 16.0);');
    expect(RCAS_FRAGMENT_SHADER).not.toContain('FSR_RCAS_DENOISE');
  });

  it('writes an opaque pixel', () => {
    for (const text of fragments) expect(text).toMatch(/fragColor = vec4\([^;]*, 1\.0\);/);
  });
});
