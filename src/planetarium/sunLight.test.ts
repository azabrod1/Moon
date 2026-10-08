import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  SUN_LIGHT_AUTHORED_LUMINANCE, SUN_LIGHT_BASELINE, SUN_LIGHT_COLOR, SUN_LIGHT_INTENSITY, SUN_LIGHT_LINEAR, luminanceOf,
} from './sunLight';
import { AIRLIGHT_SCALE } from './world/atmosphereModel';
import { BLOOM_KNEE, BLOOM_KNEE_PER_BASELINE, BLOOM_THRESHOLD, STAR_LUMINANCE_CEILING } from '../app/bloomConfig';
import { OCEAN_BEAM_CAP, OCEAN_BEAM_KNEE, OCEAN_GLINT_CAP } from './world/surfaceShading';

describe("the Sun's light", () => {
  it('is neutral, at the luminance the cream Sun gave at intensity 3, times the baseline', () => {
    expect(SUN_LIGHT_LINEAR).toEqual([1, 1, 1]);
    expect(new THREE.Color(SUN_LIGHT_COLOR).getHex()).toBe(0xffffff);
    // The cream fff5e0 at 3: Rec.709 of its linear decode times three.
    const cream = new THREE.Color(0xfff5e0);
    expect(luminanceOf([cream.r, cream.g, cream.b]) * 3).toBeCloseTo(SUN_LIGHT_AUTHORED_LUMINANCE, 3);
    expect(SUN_LIGHT_INTENSITY).toBeCloseTo(SUN_LIGHT_AUTHORED_LUMINANCE * SUN_LIGHT_BASELINE, 12);
    expect(luminanceOf(SUN_LIGHT_LINEAR) * SUN_LIGHT_INTENSITY).toBeCloseTo(2.7583 * 1.4, 3);
  });

  it('is the one Sun the air is bridged to', () => {
    expect(AIRLIGHT_SCALE).toEqual(SUN_LIGHT_LINEAR.map((c) => c * SUN_LIGHT_INTENSITY));
  });

  it('carries every scene-unit threshold with its baseline, and leaves the stars their own ceiling', () => {
    expect(STAR_LUMINANCE_CEILING).toBe(1);
    expect(BLOOM_THRESHOLD).toBeCloseTo(STAR_LUMINANCE_CEILING * SUN_LIGHT_BASELINE, 12);
    // The knee is a width in the threshold's units, so it rides the same baseline.
    expect(BLOOM_KNEE).toBeCloseTo(BLOOM_KNEE_PER_BASELINE * SUN_LIGHT_BASELINE, 12);
    expect(OCEAN_GLINT_CAP).toBeCloseTo(1.25 * SUN_LIGHT_BASELINE, 12);
    expect(OCEAN_BEAM_KNEE).toBeCloseTo(3.5 * SUN_LIGHT_BASELINE, 12);
    expect(OCEAN_BEAM_CAP).toBeCloseTo(7 * SUN_LIGHT_BASELINE, 12);
    // The sunlit white (3/pi of the light) keeps its margin under the bloom's line.
    const white = (SUN_LIGHT_INTENSITY / Math.PI) * luminanceOf(SUN_LIGHT_LINEAR);
    expect(white / BLOOM_THRESHOLD).toBeCloseTo((2.7583 / Math.PI) / 1, 3);
  });
});
