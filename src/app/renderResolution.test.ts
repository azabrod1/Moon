import { describe, expect, it } from 'vitest';
import {
  BLOOM_MIN_PIXEL_RATIO_DESKTOP,
  bloomPixelRatio,
  composerSamples,
  ECONOMY_ABOVE_DEVICE_PIXELS,
  MAX_TARGET_PIXEL_RATIO_DESKTOP,
  MAX_TARGET_PIXEL_RATIO_MOBILE,
  parseMsaaOverride,
  policySamples,
  SCENE_TARGET_SAMPLES,
  SCENE_TARGET_SAMPLES_ECONOMY,
  targetPixelRatio,
} from './renderResolution';

const QHD = 2560 * 1440;
const UHD = 3840 * 2160;
const FIVE_K = 5120 * 2880;

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

describe('bloomPixelRatio', () => {
  it('keeps the old desktop floor for the bloom chain', () => {
    expect(bloomPixelRatio(1, false)).toBe(BLOOM_MIN_PIXEL_RATIO_DESKTOP);
    expect(bloomPixelRatio(1.25, false)).toBe(BLOOM_MIN_PIXEL_RATIO_DESKTOP);
    expect(bloomPixelRatio(1.5, false)).toBe(1.5);
    expect(bloomPixelRatio(2, false)).toBe(2);
    expect(bloomPixelRatio(3, false)).toBe(MAX_TARGET_PIXEL_RATIO_DESKTOP);
  });

  it('follows the phone ratio exactly, floor-free, as before', () => {
    expect(bloomPixelRatio(1, true)).toBe(1);
    expect(bloomPixelRatio(2, true)).toBe(2);
    expect(bloomPixelRatio(3, true)).toBe(MAX_TARGET_PIXEL_RATIO_MOBILE);
  });
});

describe('policySamples', () => {
  it('gives plain 1× displays the full count up to 4K', () => {
    expect(policySamples(1, false, 1920 * 1080)).toBe(SCENE_TARGET_SAMPLES);
    expect(policySamples(1, false, QHD)).toBe(SCENE_TARGET_SAMPLES);
    expect(policySamples(1, false, UHD)).toBe(SCENE_TARGET_SAMPLES);
    expect(policySamples(0.8, false, QHD)).toBe(SCENE_TARGET_SAMPLES);
  });

  it('drops to the economy count on scaled laptops and beyond 4K', () => {
    expect(policySamples(1.25, false, 1920 * 1080)).toBe(SCENE_TARGET_SAMPLES_ECONOMY);
    expect(policySamples(1.49, false, QHD)).toBe(SCENE_TARGET_SAMPLES_ECONOMY);
    expect(policySamples(1, false, ECONOMY_ABOVE_DEVICE_PIXELS + 1)).toBe(SCENE_TARGET_SAMPLES_ECONOMY);
    expect(policySamples(1, false, FIVE_K)).toBe(SCENE_TARGET_SAMPLES_ECONOMY);
  });

  it('leaves dense desktops and every phone without samples', () => {
    expect(policySamples(1.5, false, QHD)).toBe(0);
    expect(policySamples(2, false, QHD)).toBe(0);
    expect(policySamples(2.5, false, QHD)).toBe(0);
    expect(policySamples(1, true, QHD)).toBe(0);
    expect(policySamples(2, true, QHD)).toBe(0);
  });
});

describe('composerSamples', () => {
  const GPU = [8, 4, 2];

  it('follows the policy when the knob is off', () => {
    expect(composerSamples(1, false, QHD, null, GPU)).toBe(SCENE_TARGET_SAMPLES);
    expect(composerSamples(1.25, false, QHD, null, GPU)).toBe(SCENE_TARGET_SAMPLES_ECONOMY);
    expect(composerSamples(2, false, QHD, null, GPU)).toBe(0);
    expect(composerSamples(1, true, QHD, null, GPU)).toBe(0);
  });

  it('lets the knob force a count on any display', () => {
    expect(composerSamples(2, false, QHD, 4, GPU)).toBe(4);
    expect(composerSamples(2, true, QHD, 4, GPU)).toBe(4);
    expect(composerSamples(1, false, QHD, 0, GPU)).toBe(0);
    expect(composerSamples(1, false, QHD, 8, GPU)).toBe(8);
  });

  it('picks the largest completed count not above the request', () => {
    expect(composerSamples(1, false, QHD, null, [2])).toBe(2);
    expect(composerSamples(1, false, QHD, 8, [4, 2])).toBe(4);
    expect(composerSamples(1, false, QHD, 4, [16, 8, 4, 2])).toBe(4);
    expect(composerSamples(1.25, false, QHD, null, [8, 4, 2])).toBe(2);
  });

  it('falls up to the smallest completed count rather than to none', () => {
    expect(composerSamples(1.25, false, QHD, null, [8, 4])).toBe(4);
    expect(composerSamples(1, false, QHD, 2, [8])).toBe(8);
  });

  it('never multisamples on a GPU that completed nothing', () => {
    expect(composerSamples(1, false, QHD, null, [])).toBe(0);
    expect(composerSamples(1, false, QHD, 4, [])).toBe(0);
  });
});

describe('parseMsaaOverride', () => {
  it('reads the knob on the dev server', () => {
    expect(parseMsaaOverride('?msaa=0', true)).toBe(0);
    expect(parseMsaaOverride('?debug=1&msaa=4', true)).toBe(4);
    expect(parseMsaaOverride('?msaa=8', true)).toBe(8);
  });

  it('honours only the kill switch on a production build', () => {
    expect(parseMsaaOverride('?msaa=0', false)).toBe(0);
    expect(parseMsaaOverride('?msaa=2', false)).toBeNull();
    expect(parseMsaaOverride('?msaa=4', false)).toBeNull();
    expect(parseMsaaOverride('?msaa=8', false)).toBeNull();
  });

  it('follows the policy when the knob is absent, malformed, or not a real count', () => {
    expect(parseMsaaOverride('', true)).toBeNull();
    expect(parseMsaaOverride('?msaa=', true)).toBeNull();
    expect(parseMsaaOverride('?msaa=lots', true)).toBeNull();
    expect(parseMsaaOverride('?msaa=-4', true)).toBeNull();
    expect(parseMsaaOverride('?msaa=2.5', true)).toBeNull();
    expect(parseMsaaOverride('?msaa=1', true)).toBeNull();
    expect(parseMsaaOverride('?msaa=3', true)).toBeNull();
    expect(parseMsaaOverride('?msaa=16', true)).toBeNull();
  });
});
