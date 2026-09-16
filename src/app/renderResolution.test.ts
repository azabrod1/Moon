import { describe, expect, it } from 'vitest';
import {
  DESKTOP_FLOOR_PIXEL_RATIO,
  bloomPixelRatio,
  composerSamples,
  ECONOMY_ABOVE_DEVICE_PIXELS,
  MAX_TARGET_PIXEL_RATIO_DESKTOP,
  MAX_TARGET_PIXEL_RATIO_MOBILE,
  MAX_UPSCALE_FACTOR,
  parseMsaaOverride,
  parseUpscaleParam,
  policySamples,
  renderPixelRatio,
  SCENE_TARGET_SAMPLES,
  SCENE_TARGET_SAMPLES_ECONOMY,
  targetPixelRatio,
  UPSCALE_RENDER_PIXEL_RATIO,
  upscalePolicy,
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

  it('keeps the old desktop floor where the scene cannot multisample', () => {
    expect(targetPixelRatio(1, false, true)).toBe(DESKTOP_FLOOR_PIXEL_RATIO);
    expect(targetPixelRatio(1.25, false, true)).toBe(DESKTOP_FLOOR_PIXEL_RATIO);
    expect(targetPixelRatio(2, false, true)).toBe(2);
    expect(targetPixelRatio(3, false, true)).toBe(MAX_TARGET_PIXEL_RATIO_DESKTOP);
    expect(targetPixelRatio(1, true, true)).toBe(1);
  });
});

describe('bloomPixelRatio', () => {
  it('keeps the old desktop floor for the bloom chain', () => {
    expect(bloomPixelRatio(1, false)).toBe(DESKTOP_FLOOR_PIXEL_RATIO);
    expect(bloomPixelRatio(1.25, false)).toBe(DESKTOP_FLOOR_PIXEL_RATIO);
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

  it('falls up to the smallest completed count rather than to none, where affordable', () => {
    expect(composerSamples(1.25, false, QHD, null, [8, 4])).toBe(4);
    expect(composerSamples(1.25, false, QHD, null, [4])).toBe(4);
  });

  it('never falls up beyond 4K or above the full count', () => {
    expect(composerSamples(1, false, FIVE_K, null, [8, 4])).toBe(0);
    expect(composerSamples(1, false, ECONOMY_ABOVE_DEVICE_PIXELS + 1, null, [4])).toBe(0);
    expect(composerSamples(1, false, QHD, null, [8])).toBe(0);
    expect(composerSamples(1, false, QHD, 2, [8])).toBe(0);
    expect(composerSamples(1, false, FIVE_K, null, [8, 4, 2])).toBe(SCENE_TARGET_SAMPLES_ECONOMY);
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

describe('renderPixelRatio (the upscaler)', () => {
  it('is the output ratio with nothing asked, or with a request at or above it', () => {
    expect(renderPixelRatio(2, null)).toBe(2);
    expect(renderPixelRatio(2, 2)).toBe(2);
    expect(renderPixelRatio(2, 3)).toBe(2);
    expect(renderPixelRatio(1, 1.5)).toBe(1); // a 1× monitor asked for 1.5: nothing to upscale
  });

  it('is the request below the output ratio', () => {
    expect(renderPixelRatio(2, UPSCALE_RENDER_PIXEL_RATIO)).toBe(1.5);
    expect(renderPixelRatio(2, 1.7)).toBe(1.7);
    expect(renderPixelRatio(2.5, 1.5)).toBe(1.5);
  });

  it('never goes below the output ratio over the largest factor EASU is specified for', () => {
    expect(renderPixelRatio(2, 0.5)).toBe(2 / MAX_UPSCALE_FACTOR);
    expect(renderPixelRatio(3, 1)).toBe(1.5);
  });

  it('treats an unreadable request as nothing asked', () => {
    expect(renderPixelRatio(2, 0)).toBe(2);
    expect(renderPixelRatio(2, -1)).toBe(2);
    expect(renderPixelRatio(2, Number.NaN)).toBe(2);
  });
});

describe('parseUpscaleParam', () => {
  it('follows the policy when absent or unreadable', () => {
    expect(parseUpscaleParam('', true)).toBeNull();
    expect(parseUpscaleParam('?msaa=0', true)).toBeNull();
    expect(parseUpscaleParam('?upscale=', true)).toBeNull();
    expect(parseUpscaleParam('?upscale=abc', true)).toBeNull();
    expect(parseUpscaleParam('?upscale=-1', false)).toBeNull();
  });

  it('reads a scene ratio on any build, and off as the kill switch', () => {
    expect(parseUpscaleParam('?upscale=1.5', false)).toEqual({ renderRatio: 1.5 });
    expect(parseUpscaleParam('?upscale=1.5', true)).toEqual({ renderRatio: 1.5 });
    expect(parseUpscaleParam('?upscale=0', false)).toEqual({ renderRatio: null });
    expect(parseUpscaleParam('?upscale=off', false)).toEqual({ renderRatio: null });
    expect(parseUpscaleParam('?upscale=OFF', true)).toEqual({ renderRatio: null });
  });

  it('takes the control arm and the sharpen stops on the dev server only', () => {
    expect(parseUpscaleParam('?upscale=1.5,bilinear', true)).toEqual({ renderRatio: 1.5, filter: 'bilinear' });
    expect(parseUpscaleParam('?upscale=1.5,bilinear', false)).toEqual({ renderRatio: 1.5 });
    expect(parseUpscaleParam('?upscale=1.5&sharpen=off', true)).toEqual({ renderRatio: 1.5, sharpen: null });
    expect(parseUpscaleParam('?upscale=1.5&sharpen=0.5', true)).toEqual({ renderRatio: 1.5, sharpen: 0.5 });
    expect(parseUpscaleParam('?upscale=1.5&sharpen=0', true)).toEqual({ renderRatio: 1.5, sharpen: 0 });
    expect(parseUpscaleParam('?upscale=1.5&sharpen=-1', true)).toEqual({ renderRatio: 1.5 });
    expect(parseUpscaleParam('?upscale=1.5&sharpen=off', false)).toEqual({ renderRatio: 1.5 });
  });
});

describe('upscalePolicy', () => {
  it('turns nothing on unasked: the upscaler ships off until it has been seen on the phone', () => {
    expect(upscalePolicy(true)).toBeNull();
    expect(upscalePolicy(false)).toBeNull();
  });
});
