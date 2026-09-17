import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUALITY,
  dynamicLadder,
  nextQualityLevel,
  parseQualityParam,
  QUALITY_LEVELS,
  QUALITY_LEVEL_LABELS,
  qualityBounds,
  QUALITY_DOWN_RUNG_FACTORS,
  QUALITY_LOW_SCALE,
  QUALITY_UP_RUNG_FACTORS,
  renderTargetBytes,
  RENDER_TARGET_ENVELOPE_SHARE,
  sceneRatioForLevel,
  sceneTargetSize,
  type QualityBounds,
  type QualityBoundsInput,
  type QualityLevel,
} from './renderQuality';
import {
  DESKTOP_FLOOR_PIXEL_RATIO,
  MAX_UPSCALE_FACTOR,
  policySamples,
  targetPixelRatio,
} from './renderResolution';
import {
  classifyDevice,
  deviceProfileFor,
  platformFamily,
  type DeviceSignals,
} from '../planetarium/world/gpuEnvelope';

const MiB = 1024 * 1024;

/**
 * The devices are recorded the way gpuEnvelope's fixtures record them — every
 * signal literal — and the class, the family and the envelope come out of the
 * live table rather than being asserted here, so a bound that depends on a
 * class is pinned against the classifier itself.
 */
function signals(over: Partial<DeviceSignals>): DeviceSignals {
  return {
    userAgent: '',
    platform: '',
    maxTouchPoints: 0,
    innerWidth: 1600,
    screenWidth: 1600,
    screenHeight: 900,
    devicePixelRatio: 1,
    anyPointerCoarse: false,
    pointerCoarse: false,
    renderer: null,
    deviceMemory: null,
    hardwareConcurrency: null,
    uaPlatform: null,
    uaMobile: null,
    ...over,
  };
}

const UA = {
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  iphone187: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1',
  androidTablet: 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
};

interface Device {
  signals: DeviceSignals;
  /** The canvas, in CSS pixels, with the app's chrome around it. */
  cssWidth: number;
  cssHeight: number;
  /** What main.ts's `isMobile` says: an iPad is mobile, a touch laptop is
   *  not. It decides the output cap and the sample policy. */
  mobile: boolean;
}

/** Alex's 16" MacBook Pro in Chrome, window maximised. */
const MACBOOK_16: Device = {
  signals: signals({
    userAgent: UA.macChrome, platform: 'MacIntel', maxTouchPoints: 0,
    innerWidth: 1728, screenWidth: 1728, screenHeight: 1117, devicePixelRatio: 2,
    renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)',
    deviceMemory: 8, hardwareConcurrency: 12, uaPlatform: 'macOS', uaMobile: false,
  }),
  cssWidth: 1728,
  cssHeight: 1117,
  mobile: false,
};

/** A 5K iMac or a Studio Display: the same 2x ratio over far more pixels. */
const IMAC_5K: Device = {
  signals: signals({
    userAgent: UA.macChrome, platform: 'MacIntel', maxTouchPoints: 0,
    innerWidth: 2560, screenWidth: 2560, screenHeight: 1440, devicePixelRatio: 2,
    renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)',
    deviceMemory: 8, hardwareConcurrency: 8, uaPlatform: 'macOS', uaMobile: false,
  }),
  cssWidth: 2560,
  cssHeight: 1440,
  mobile: false,
};

/** A 13" iPad Pro, which always sends a desktop user agent. */
const IPAD_PRO_13: Device = {
  signals: signals({
    userAgent: UA.macSafari, platform: 'MacIntel', maxTouchPoints: 5,
    innerWidth: 1032, screenWidth: 1024, screenHeight: 1366, devicePixelRatio: 2,
    anyPointerCoarse: true, pointerCoarse: true, renderer: 'Apple GPU', hardwareConcurrency: 8,
  }),
  cssWidth: 1032,
  cssHeight: 1376,
  mobile: true,
};

/** An Android tablet: the same chassis class, an envelope a fifth the size. */
const ANDROID_TABLET: Device = {
  signals: signals({
    userAgent: UA.androidTablet, platform: 'Linux armv81', maxTouchPoints: 5,
    innerWidth: 800, screenWidth: 800, screenHeight: 1280, devicePixelRatio: 2,
    anyPointerCoarse: true, pointerCoarse: true,
    renderer: 'ANGLE (ARM, Mali-G715, OpenGL ES 3.2)',
    deviceMemory: 8, hardwareConcurrency: 8, uaPlatform: 'Android', uaMobile: false,
  }),
  cssWidth: 800,
  cssHeight: 1280,
  mobile: true,
};

/** Alex's iPhone, as probe.html read it: a 3x panel the policy caps at 2. */
const IPHONE: Device = {
  signals: signals({
    userAgent: UA.iphone187, platform: 'iPhone', maxTouchPoints: 5,
    innerWidth: 430, screenWidth: 430, screenHeight: 932, devicePixelRatio: 3,
    anyPointerCoarse: true, pointerCoarse: true, renderer: 'Apple GPU', hardwareConcurrency: 4,
  }),
  cssWidth: 430,
  cssHeight: 932,
  mobile: true,
};

/** A 1440p monitor at 100 %, where the scene target multisamples today. */
const MONITOR_1440P: Device = {
  signals: signals({
    userAgent: UA.windows, platform: 'Win32', maxTouchPoints: 0,
    innerWidth: 2560, screenWidth: 2560, screenHeight: 1440, devicePixelRatio: 1,
    renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060, D3D11)',
    deviceMemory: 16, hardwareConcurrency: 12, uaPlatform: 'Windows', uaMobile: false,
  }),
  cssWidth: 2560,
  cssHeight: 1440,
  mobile: false,
};

/** Windows at 175 %: no samples today, and 0.75 x its output is below the
 *  supersample floor, which is what tells the two floor rules apart. */
const WINDOWS_175: Device = {
  signals: signals({
    userAgent: UA.windows, platform: 'Win32', maxTouchPoints: 0,
    innerWidth: 1536, screenWidth: 1536, screenHeight: 864, devicePixelRatio: 1.75,
    renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics, D3D11)',
    deviceMemory: 8, hardwareConcurrency: 8, uaPlatform: 'Windows', uaMobile: false,
  }),
  cssWidth: 1536,
  cssHeight: 864,
  mobile: false,
};

/** A 4K monitor at 100 % against a driver whose textures stop at 4096. */
const MONITOR_4K: Device = {
  signals: signals({
    userAgent: UA.windows, platform: 'Win32', maxTouchPoints: 0,
    innerWidth: 3840, screenWidth: 3840, screenHeight: 2160, devicePixelRatio: 1,
    renderer: 'ANGLE (Intel, Intel(R) HD Graphics 620, D3D11)',
    deviceMemory: 8, hardwareConcurrency: 8, uaPlatform: 'Windows', uaMobile: false,
  }),
  cssWidth: 3840,
  cssHeight: 2160,
  mobile: false,
};

/** The whole input a device produces, so a test can override one field of it
 *  the way a URL knob would. */
function inputFor(device: Device, over: Partial<QualityBoundsInput> = {}): QualityBoundsInput {
  const deviceClass = classifyDevice(device.signals);
  const platform = platformFamily(device.signals);
  const profile = deviceProfileFor(deviceClass, platform);
  const mobile = device.mobile;
  const supersampleFallback = over.supersampleFallback ?? false;
  const outputRatio = over.outputRatio ?? targetPixelRatio(device.signals.devicePixelRatio, mobile, supersampleFallback);
  const size = sceneTargetSize(device.cssWidth, device.cssHeight, outputRatio);
  return {
    outputRatio,
    deviceClass,
    platform,
    envelopeBytes: profile.envelopeBytes,
    cssWidth: device.cssWidth,
    cssHeight: device.cssHeight,
    samples: policySamples(outputRatio, mobile, size.width * size.height),
    hasComposer: true,
    supersampleFallback,
    maxGlSize: 16384,
    ...over,
  };
}

function boundsFor(device: Device, over: Partial<QualityBoundsInput> = {}): QualityBounds {
  return qualityBounds(inputFor(device, over));
}

describe('qualityBounds — medium and low', () => {
  it('medium is the output ratio on every device, and nothing else is', () => {
    for (const device of [MACBOOK_16, IMAC_5K, IPAD_PRO_13, ANDROID_TABLET, MONITOR_1440P]) {
      const input = inputFor(device);
      expect(boundsFor(device).medium).toBe(input.outputRatio);
    }
  });

  it('low is 0.75 of the output ratio — 1.5 on Alexs 2x phone', () => {
    const phone = boundsFor(IPHONE);
    expect(phone.medium).toBe(2);
    expect(phone.low).toBe(1.5);
    expect(boundsFor(MONITOR_1440P).low).toBe(QUALITY_LOW_SCALE);
  });

  it('never asks EASU for more than the 2x it is specified for', () => {
    for (const device of [MACBOOK_16, IMAC_5K, IPAD_PRO_13, ANDROID_TABLET, MONITOR_1440P, WINDOWS_175]) {
      const bounds = boundsFor(device);
      expect(bounds.low).toBeGreaterThanOrEqual(bounds.medium / MAX_UPSCALE_FACTOR);
    }
  });
});

describe('qualityBounds — high against the byte budget', () => {
  it("offers 3 on Alex's 16\" Mac: 417 MB of targets inside 40 % of 1024 MiB", () => {
    const input = inputFor(MACBOOK_16);
    expect(input.deviceClass).toBe('desktop');
    expect(input.platform).toBe('apple');
    expect(input.envelopeBytes).toBe(1024 * MiB);
    expect(input.samples).toBe(0);
    const bounds = qualityBounds(input);
    expect(bounds.high).toBe(3);
    expect(bounds.highOffered).toBe(true);
    expect(bounds.reason).toBeNull();
    const bytes = renderTargetBytes(input.cssWidth, input.cssHeight, 3, 0);
    expect(Math.round(bytes / 1e6)).toBe(417);
    expect(bytes).toBeLessThanOrEqual(RENDER_TARGET_ENVELOPE_SHARE * input.envelopeBytes);
  });

  it('refuses both supersamples on a 5K iMac: 2.5 alone is 553 MB', () => {
    const input = inputFor(IMAC_5K);
    const bounds = qualityBounds(input);
    expect(Math.round(renderTargetBytes(input.cssWidth, input.cssHeight, 2.5, 0) / 1e6)).toBe(553);
    expect(bounds.high).toBe(bounds.medium);
    expect(bounds.highOffered).toBe(false);
    expect(bounds.reason).toBe('byte budget');
    expect(bounds.upRungs).toEqual([2]);
  });

  it('offers 3 on a 13" iPad Pro, whose envelope is 1536 MiB', () => {
    const input = inputFor(IPAD_PRO_13);
    expect(input.deviceClass).toBe('tablet');
    expect(input.platform).toBe('apple');
    expect(input.envelopeBytes).toBe(1536 * MiB);
    const bounds = qualityBounds(input);
    expect(bounds.high).toBe(3);
    expect(Math.round(renderTargetBytes(input.cssWidth, input.cssHeight, 3, 0) / 1e6)).toBe(307);
  });

  it('refuses it on an Android tablet, whose envelope is 320 MiB', () => {
    const input = inputFor(ANDROID_TABLET);
    expect(input.deviceClass).toBe('tablet');
    expect(input.platform).toBe('android');
    expect(input.envelopeBytes).toBe(320 * MiB);
    const bounds = qualityBounds(input);
    expect(bounds.high).toBe(bounds.medium);
    expect(bounds.reason).toBe('byte budget');
  });

  it('counts the samples: a 1440p 1x monitor with four gets 1.25, not 1.5', () => {
    const input = inputFor(MONITOR_1440P);
    expect(input.samples).toBe(4);
    const bounds = qualityBounds(input);
    expect(bounds.high).toBe(1.25);
    expect(Math.round(renderTargetBytes(input.cssWidth, input.cssHeight, 1.25, 4) / 1e6)).toBe(392);
    expect(renderTargetBytes(input.cssWidth, input.cssHeight, 1.5, 4)).toBeGreaterThan(
      RENDER_TARGET_ENVELOPE_SHARE * input.envelopeBytes,
    );
  });

  it('a shrunk envelope takes 3 away from the same Mac', () => {
    const bounds = boundsFor(MACBOOK_16, { envelopeBytes: 320 * MiB });
    expect(bounds.high).toBe(bounds.medium);
    expect(bounds.highOffered).toBe(false);
    expect(bounds.reason).toBe('byte budget');
    expect(dynamicLadder(bounds).rungs.every((r) => r <= 2)).toBe(true);
  });

  it('clamps to the GL size limit before it counts a byte', () => {
    const bounds = boundsFor(MONITOR_4K, { maxGlSize: 4096 });
    expect(sceneTargetSize(3840, 2160, 1.25).width).toBeGreaterThan(4096);
    expect(bounds.high).toBe(bounds.medium);
    expect(bounds.reason).toBe('gl size');
  });
});

describe('qualityBounds — where high is not offered at all', () => {
  it('a phone keeps medium: heat, not headroom, is what binds', () => {
    const input = inputFor(IPHONE);
    expect(input.deviceClass).toBe('phone');
    const bounds = qualityBounds(input);
    expect(bounds.high).toBe(2);
    expect(bounds.highOffered).toBe(false);
    expect(bounds.reason).toBe('phone');
    // The bytes would have allowed it, which is why the class rule has to
    // exist rather than falling out of the budget.
    expect(renderTargetBytes(input.cssWidth, input.cssHeight, 3, 0)).toBeLessThan(
      RENDER_TARGET_ENVELOPE_SHARE * input.envelopeBytes,
    );
  });

  it('the limited class keeps medium', () => {
    const bounds = boundsFor(MONITOR_1440P, { deviceClass: 'limited' });
    expect(bounds.high).toBe(bounds.medium);
    expect(bounds.reason).toBe('limited');
  });

  it('with no composer every level is medium and the ladder is one rung', () => {
    const bounds = boundsFor(MACBOOK_16, { hasComposer: false });
    expect(bounds.low).toBe(2);
    expect(bounds.medium).toBe(2);
    expect(bounds.high).toBe(2);
    expect(bounds.reason).toBe('no composer');
    expect(bounds.downRungs).toEqual([2]);
    expect(bounds.upRungs).toEqual([2]);
    expect(dynamicLadder(bounds)).toEqual({ rungs: [2], mediumIndex: 0 });
    for (const level of ['low', 'medium', 'high', 'dynamic'] as const) {
      expect(sceneRatioForLevel(level, bounds)).toBe(2);
    }
  });

  it('a machine that could not multisample keeps medium and floors at 1.5', () => {
    const input = inputFor(WINDOWS_175, { supersampleFallback: true });
    expect(input.outputRatio).toBe(1.75);
    const bounds = qualityBounds(input);
    expect(bounds.high).toBe(1.75);
    expect(bounds.highOffered).toBe(false);
    expect(bounds.reason).toBe('supersample fallback');
    // The floor is the old supersample ratio, not 0.75 x output (1.3125):
    // below 1.5 that machine has no antialiasing left at all.
    expect(bounds.low).toBe(DESKTOP_FLOOR_PIXEL_RATIO);
    expect(bounds.downRungs[bounds.downRungs.length - 1]).toBeGreaterThanOrEqual(DESKTOP_FLOOR_PIXEL_RATIO);
  });

  it('and where the output ratio IS the floor, Dynamic has nowhere to go', () => {
    const bounds = boundsFor(MONITOR_1440P, { supersampleFallback: true, outputRatio: 1.5, samples: 0 });
    expect(bounds.low).toBe(1.5);
    expect(bounds.medium).toBe(1.5);
    expect(dynamicLadder(bounds).rungs).toEqual([1.5]);
  });
});

describe('qualityBounds — the rungs', () => {
  it("are the phone's 2 -> 1.74 -> 1.5, in the factors they were calibrated at", () => {
    const bounds = boundsFor(IPHONE);
    expect(bounds.downRungs).toHaveLength(3);
    expect(bounds.downRungs[0]).toBe(2);
    expect(bounds.downRungs[1]).toBeCloseTo(2 / 1.15, 6);
    expect(bounds.downRungs[2]).toBeCloseTo(2 / 1.33, 6);
    expect(bounds.downRungs[1]).toBeCloseTo(1.74, 2);
    expect(bounds.downRungs[2]).toBeCloseTo(1.5, 2);
    // Nothing above medium on a phone, so Dynamic's ladder is the slide down.
    expect(bounds.upRungs).toEqual([2]);
    const ladder = dynamicLadder(bounds);
    expect(ladder.rungs).toHaveLength(3);
    expect(ladder.mediumIndex).toBe(2);
    expect(ladder.rungs[ladder.mediumIndex]).toBe(2);
  });

  it("are the Mac's five, ascending, with medium in the middle", () => {
    const ladder = dynamicLadder(boundsFor(MACBOOK_16));
    expect(ladder.rungs).toHaveLength(5);
    expect(ladder.mediumIndex).toBe(2);
    expect(ladder.rungs[2]).toBe(2);
    expect(ladder.rungs[3]).toBe(2.5);
    expect(ladder.rungs[4]).toBe(3);
    for (let i = 1; i < ladder.rungs.length; i++) {
      expect(ladder.rungs[i]).toBeGreaterThan(ladder.rungs[i - 1]);
    }
  });

  it('are relative to the output ratio, so a 1x monitor slides in its own units', () => {
    const bounds = boundsFor(MONITOR_1440P);
    expect(bounds.downRungs[0]).toBe(1);
    expect(bounds.downRungs[2]).toBeCloseTo(1 / 1.33, 6);
    expect(bounds.upRungs).toEqual([1, 1.25]);
    expect(QUALITY_DOWN_RUNG_FACTORS[0]).toBe(1);
    expect(QUALITY_UP_RUNG_FACTORS[0]).toBe(1);
  });

  it('size every rung to integers, as GL stores them', () => {
    for (const device of [MACBOOK_16, IPAD_PRO_13, ANDROID_TABLET, MONITOR_1440P, IPHONE]) {
      const bounds = boundsFor(device);
      for (const rung of dynamicLadder(bounds).rungs) {
        const size = sceneTargetSize(device.cssWidth, device.cssHeight, rung);
        expect(Number.isInteger(size.width)).toBe(true);
        expect(Number.isInteger(size.height)).toBe(true);
        expect(size.width).toBe(Math.floor(device.cssWidth * rung));
        expect(size.height).toBe(Math.floor(device.cssHeight * rung));
      }
    }
  });
});

describe('renderTargetBytes', () => {
  it('is 24 bytes a scene pixel with no samples', () => {
    expect(renderTargetBytes(100, 100, 1, 0)).toBe(100 * 100 * 24);
  });

  it('counts the samples in the colour and the depth, plus the resolve', () => {
    expect(renderTargetBytes(100, 100, 1, 4)).toBe(100 * 100 * 68);
    expect(renderTargetBytes(100, 100, 1, 2)).toBe(100 * 100 * 44);
  });

  it('measures the floored size, not the fractional one', () => {
    expect(renderTargetBytes(101, 101, 1.5, 0)).toBe(151 * 151 * 24);
  });
});

describe('parseQualityParam', () => {
  it('takes low, medium and dynamic on any build', () => {
    for (const dev of [true, false]) {
      expect(parseQualityParam('?quality=low', dev)).toBe('low');
      expect(parseQualityParam('?quality=medium', dev)).toBe('medium');
      expect(parseQualityParam('?quality=dynamic', dev)).toBe('dynamic');
      expect(parseQualityParam('?quality=DYNAMIC', dev)).toBe('dynamic');
    }
  });

  it('takes high on the dev server only', () => {
    expect(parseQualityParam('?quality=high', true)).toBe('high');
    expect(parseQualityParam('?quality=HIGH', true)).toBe('high');
    expect(parseQualityParam('?quality=high', false)).toBeNull();
  });

  it('ignores anything that is not a level', () => {
    for (const search of ['', '?quality=', '?quality=ultra', '?quality=2', '?msaa=0']) {
      expect(parseQualityParam(search, true)).toBeNull();
    }
  });

  it('defaults to dynamic', () => {
    expect(DEFAULT_QUALITY).toBe('dynamic');
  });
});

describe('nextQualityLevel', () => {
  it('cycles Low, Medium, High, Dynamic and round again', () => {
    expect(nextQualityLevel('low', true)).toBe('medium');
    expect(nextQualityLevel('medium', true)).toBe('high');
    expect(nextQualityLevel('high', true)).toBe('dynamic');
    expect(nextQualityLevel('dynamic', true)).toBe('low');
  });

  it('leaves High out of the cycle where it is not offered', () => {
    expect(nextQualityLevel('low', false)).toBe('medium');
    expect(nextQualityLevel('medium', false)).toBe('dynamic');
    expect(nextQualityLevel('dynamic', false)).toBe('low');
  });

  it('walks off a level the display does not offer', () => {
    // The DEV `?quality=high` boots a phone at High: the button has to lead
    // somewhere, and the next level in the order is Dynamic.
    expect(nextQualityLevel('high', false)).toBe('dynamic');
  });

  it('visits every offered level in one loop', () => {
    for (const highOffered of [true, false]) {
      const seen: QualityLevel[] = [];
      let level: QualityLevel = 'low';
      for (let step = 0; step < 8; step += 1) {
        seen.push(level);
        level = nextQualityLevel(level, highOffered);
        if (level === 'low') break;
      }
      expect(new Set(seen)).toEqual(new Set(
        QUALITY_LEVELS.filter((l) => l !== 'high' || highOffered),
      ));
    }
  });

  it('names every level on the button', () => {
    for (const level of QUALITY_LEVELS) {
      expect(QUALITY_LEVEL_LABELS[level]).toBe(level[0].toUpperCase() + level.slice(1));
    }
  });
});
