import { describe, expect, it } from 'vitest';
import {
  composerSamples,
  MAX_TARGET_PIXEL_RATIO_DESKTOP,
  MAX_TARGET_PIXEL_RATIO_MOBILE,
  parseMsaaOverride,
  SCENE_TARGET_SAMPLES,
  targetPixelRatio,
} from './renderResolution';

describe('targetPixelRatio', () => {
  it('renders native on ordinary desktop displays (no floor)', () => {
    expect(targetPixelRatio(1, false)).toBe(1);
    expect(targetPixelRatio(1.25, false)).toBe(1.25);
    expect(targetPixelRatio(2, false)).toBe(2);
  });

  it('caps very dense desktops and phones', () => {
    expect(targetPixelRatio(3, false)).toBe(MAX_TARGET_PIXEL_RATIO_DESKTOP);
    expect(targetPixelRatio(3, true)).toBe(MAX_TARGET_PIXEL_RATIO_MOBILE);
    expect(targetPixelRatio(2.625, true)).toBe(MAX_TARGET_PIXEL_RATIO_MOBILE);
  });

  it('follows a zoomed-out page below 1', () => {
    expect(targetPixelRatio(0.8, false)).toBe(0.8);
    expect(targetPixelRatio(0.8, true)).toBe(0.8);
  });
});

describe('composerSamples', () => {
  const GPU = [8, 4, 2];

  it('multisamples desktop below the dense-display threshold and not above', () => {
    expect(composerSamples(1, false, null, GPU)).toBe(SCENE_TARGET_SAMPLES);
    expect(composerSamples(1.5, false, null, GPU)).toBe(SCENE_TARGET_SAMPLES);
    expect(composerSamples(1.99, false, null, GPU)).toBe(SCENE_TARGET_SAMPLES);
    expect(composerSamples(2, false, null, GPU)).toBe(0);
    expect(composerSamples(2.5, false, null, GPU)).toBe(0);
  });

  it('leaves mobile without samples at every density', () => {
    expect(composerSamples(1, true, null, GPU)).toBe(0);
    expect(composerSamples(1.5, true, null, GPU)).toBe(0);
    expect(composerSamples(2, true, null, GPU)).toBe(0);
  });

  it('lets the URL knob force a count on any display', () => {
    expect(composerSamples(2, false, 4, GPU)).toBe(4);
    expect(composerSamples(2, true, 4, GPU)).toBe(4);
    expect(composerSamples(1, false, 0, GPU)).toBe(0);
    expect(composerSamples(1, false, 8, GPU)).toBe(8);
  });

  it('only ever picks a count the GPU completed, never above the request', () => {
    expect(composerSamples(1, false, null, [2])).toBe(2);
    expect(composerSamples(1, false, null, [])).toBe(0);
    expect(composerSamples(1, false, null, [8])).toBe(0);
    expect(composerSamples(1, false, 8, [4, 2])).toBe(4);
    expect(composerSamples(1, false, 4, [16, 8, 4, 2])).toBe(4);
  });
});

describe('parseMsaaOverride', () => {
  it('reads the knob', () => {
    expect(parseMsaaOverride('?msaa=0')).toBe(0);
    expect(parseMsaaOverride('?debug=1&msaa=4')).toBe(4);
  });

  it('follows the policy when the knob is absent, malformed, or not a real count', () => {
    expect(parseMsaaOverride('')).toBeNull();
    expect(parseMsaaOverride('?msaa=')).toBeNull();
    expect(parseMsaaOverride('?msaa=lots')).toBeNull();
    expect(parseMsaaOverride('?msaa=-4')).toBeNull();
    expect(parseMsaaOverride('?msaa=2.5')).toBeNull();
    expect(parseMsaaOverride('?msaa=1')).toBeNull();
    expect(parseMsaaOverride('?msaa=3')).toBeNull();
    expect(parseMsaaOverride('?msaa=16')).toBeNull();
  });
});
