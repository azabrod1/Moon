import { describe, it, expect } from 'vitest';
import {
  classifyDevice,
  legacyProfile,
  legacyTouchFirst,
  LEGACY_DESKTOP_PROFILE,
  LEGACY_TOUCH_PROFILE,
  type DeviceClass,
  type DeviceSignals,
} from './gpuEnvelope';

const MiB = 1024 * 1024;

/** A device, as the reader would have recorded it. Every field is literal:
 *  these are devices, not arguments, and a fixture that quietly defaulted a
 *  field would be pinning the default rather than the device. */
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
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  webkitHarness: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.4 Safari/605.1.15',
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  pixel: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36',
  androidTablet: 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  chromeos: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
};

interface Fixture {
  name: string;
  signals: DeviceSignals;
  /** What the classifier makes of it. */
  deviceClass: DeviceClass;
  /** And which numbers the app gives it today, which is what commit-for-
   *  commit behaviour identity rests on. */
  legacy: 'legacy-touch' | 'legacy-desktop';
}

/**
 * One row per device the classifier has to get right. The three Playwright
 * WebKit rows were read off the harness itself (planning/_envelope-wk-signals.mjs)
 * and the desktop Chromium figures off this machine; the rest are the
 * published chassis sizes and the user-agent strings those devices send.
 */
const FIXTURES: Fixture[] = [
  {
    name: 'iPhone 15 Pro, Safari',
    signals: signals({
      userAgent: UA.iphone, platform: 'iPhone', maxTouchPoints: 5,
      innerWidth: 393, screenWidth: 393, screenHeight: 852, devicePixelRatio: 3,
      anyPointerCoarse: true, pointerCoarse: true, renderer: 'Apple GPU', hardwareConcurrency: 8,
    }),
    deviceClass: 'phone',
    legacy: 'legacy-touch',
  },
  {
    name: 'iPhone with Request Desktop Website — a Mac UA on a phone chassis',
    signals: signals({
      userAgent: UA.macSafari, platform: 'MacIntel', maxTouchPoints: 5,
      innerWidth: 980, screenWidth: 390, screenHeight: 844, devicePixelRatio: 3,
      anyPointerCoarse: true, pointerCoarse: true, renderer: 'Apple GPU', hardwareConcurrency: 8,
    }),
    deviceClass: 'phone',
    legacy: 'legacy-touch',
  },
  {
    name: 'iPad Pro 13", which always sends a desktop UA',
    signals: signals({
      userAgent: UA.macSafari, platform: 'MacIntel', maxTouchPoints: 5,
      innerWidth: 1024, screenWidth: 1024, screenHeight: 1366, devicePixelRatio: 2,
      anyPointerCoarse: true, pointerCoarse: true, renderer: 'Apple GPU', hardwareConcurrency: 8,
    }),
    deviceClass: 'tablet',
    legacy: 'legacy-touch',
  },
  {
    name: 'iPad mini',
    signals: signals({
      userAgent: UA.macSafari, platform: 'MacIntel', maxTouchPoints: 5,
      innerWidth: 744, screenWidth: 744, screenHeight: 1133, devicePixelRatio: 2,
      anyPointerCoarse: true, pointerCoarse: true, renderer: 'Apple GPU', hardwareConcurrency: 8,
    }),
    deviceClass: 'tablet',
    legacy: 'legacy-touch',
  },
  {
    name: 'Pixel 8, Chrome',
    signals: signals({
      userAgent: UA.pixel, platform: 'Linux armv81', maxTouchPoints: 5,
      innerWidth: 412, screenWidth: 412, screenHeight: 915, devicePixelRatio: 2.625,
      anyPointerCoarse: true, pointerCoarse: true,
      renderer: 'ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2)',
      deviceMemory: 8, hardwareConcurrency: 8, uaPlatform: 'Android', uaMobile: true,
    }),
    deviceClass: 'phone',
    legacy: 'legacy-touch',
  },
  {
    name: 'Android tablet',
    signals: signals({
      userAgent: UA.androidTablet, platform: 'Linux armv81', maxTouchPoints: 5,
      innerWidth: 800, screenWidth: 800, screenHeight: 1280, devicePixelRatio: 2,
      anyPointerCoarse: true, pointerCoarse: true,
      renderer: 'ANGLE (ARM, Mali-G715, OpenGL ES 3.2)',
      deviceMemory: 8, hardwareConcurrency: 8, uaPlatform: 'Android', uaMobile: false,
    }),
    deviceClass: 'tablet',
    legacy: 'legacy-touch',
  },
  {
    name: 'Android tablet with a mouse — its PRIMARY pointer is now fine',
    signals: signals({
      userAgent: UA.androidTablet, platform: 'Linux armv81', maxTouchPoints: 5,
      innerWidth: 800, screenWidth: 800, screenHeight: 1280, devicePixelRatio: 2,
      anyPointerCoarse: true, pointerCoarse: false,
      renderer: 'ANGLE (ARM, Mali-G715, OpenGL ES 3.2)',
      deviceMemory: 8, hardwareConcurrency: 8, uaPlatform: 'Android', uaMobile: false,
    }),
    deviceClass: 'tablet',
    legacy: 'legacy-touch',
  },
  {
    name: 'Samsung DeX: an Android phone driving a 1920x1080 desktop',
    signals: signals({
      userAgent: UA.androidTablet, platform: 'Linux armv81', maxTouchPoints: 5,
      innerWidth: 1600, screenWidth: 1920, screenHeight: 1080, devicePixelRatio: 1,
      anyPointerCoarse: true, pointerCoarse: false,
      renderer: 'ANGLE (ARM, Mali-G715, OpenGL ES 3.2)',
      deviceMemory: 8, hardwareConcurrency: 8, uaPlatform: 'Android', uaMobile: false,
    }),
    deviceClass: 'tablet',
    legacy: 'legacy-desktop',
  },
  {
    name: 'Windows touch laptop, window dragged to 1024 CSS px',
    signals: signals({
      userAgent: UA.windows, platform: 'Win32', maxTouchPoints: 10,
      innerWidth: 1024, screenWidth: 1920, screenHeight: 1080, devicePixelRatio: 1,
      anyPointerCoarse: true, pointerCoarse: false,
      renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics, D3D11)',
      deviceMemory: 8, hardwareConcurrency: 12, uaPlatform: 'Windows', uaMobile: false,
    }),
    deviceClass: 'desktop',
    legacy: 'legacy-touch',
  },
  {
    name: 'The same Windows touch laptop, window at full width',
    signals: signals({
      userAgent: UA.windows, platform: 'Win32', maxTouchPoints: 10,
      innerWidth: 1920, screenWidth: 1920, screenHeight: 1080, devicePixelRatio: 1,
      anyPointerCoarse: true, pointerCoarse: false,
      renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics, D3D11)',
      deviceMemory: 8, hardwareConcurrency: 12, uaPlatform: 'Windows', uaMobile: false,
    }),
    deviceClass: 'desktop',
    legacy: 'legacy-desktop',
  },
  {
    name: 'Chromebook with a touchscreen, 1366x768',
    signals: signals({
      userAgent: UA.chromeos, platform: 'Linux x86_64', maxTouchPoints: 10,
      innerWidth: 1366, screenWidth: 1366, screenHeight: 768, devicePixelRatio: 1,
      anyPointerCoarse: true, pointerCoarse: false,
      renderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 605, OpenGL ES 3.2)',
      deviceMemory: 4, hardwareConcurrency: 4, uaPlatform: 'Chrome OS', uaMobile: false,
    }),
    deviceClass: 'tablet',
    legacy: 'legacy-desktop',
  },
  {
    name: 'MacBook Pro, Chrome',
    signals: signals({
      userAgent: UA.macChrome, platform: 'MacIntel', maxTouchPoints: 0,
      innerWidth: 1512, screenWidth: 1728, screenHeight: 1117, devicePixelRatio: 2,
      anyPointerCoarse: false, pointerCoarse: false,
      renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)',
      deviceMemory: 8, hardwareConcurrency: 12, uaPlatform: 'macOS', uaMobile: false,
    }),
    deviceClass: 'desktop',
    legacy: 'legacy-desktop',
  },
  {
    name: 'Playwright WebKit, desktop context (the Safari oracle)',
    signals: signals({
      userAgent: UA.webkitHarness, platform: 'MacIntel', maxTouchPoints: 0,
      innerWidth: 1600, screenWidth: 1600, screenHeight: 900, devicePixelRatio: 1,
      anyPointerCoarse: false, pointerCoarse: false, renderer: 'Apple GPU', hardwareConcurrency: 8,
    }),
    deviceClass: 'desktop',
    legacy: 'legacy-desktop',
  },
  {
    name: 'Playwright WebKit, emulated iPhone with the iOS UA',
    signals: signals({
      userAgent: UA.iphone, platform: 'MacIntel', maxTouchPoints: 0,
      innerWidth: 980, screenWidth: 390, screenHeight: 844, devicePixelRatio: 1.1938774585723877,
      anyPointerCoarse: true, pointerCoarse: true, renderer: 'Apple GPU', hardwareConcurrency: 8,
    }),
    deviceClass: 'phone',
    legacy: 'legacy-touch',
  },
  {
    name: 'Playwright WebKit, phone viewport with its own desktop UA',
    signals: signals({
      userAgent: UA.webkitHarness, platform: 'MacIntel', maxTouchPoints: 0,
      innerWidth: 980, screenWidth: 390, screenHeight: 844, devicePixelRatio: 1.1938774585723877,
      anyPointerCoarse: true, pointerCoarse: true, renderer: 'Apple GPU', hardwareConcurrency: 8,
    }),
    deviceClass: 'phone',
    legacy: 'legacy-desktop',
  },
  {
    name: 'Firefox with fingerprinting resistance: no renderer, no memory',
    signals: signals({
      userAgent: UA.firefox, platform: 'Win32', maxTouchPoints: 0,
      innerWidth: 1600, screenWidth: 1920, screenHeight: 1080, devicePixelRatio: 1,
      anyPointerCoarse: false, pointerCoarse: false,
      renderer: null, deviceMemory: null, hardwareConcurrency: 2,
    }),
    deviceClass: 'desktop',
    legacy: 'legacy-desktop',
  },
  {
    name: 'SwiftShader: no GPU at all',
    signals: signals({
      userAgent: UA.windows, platform: 'Win32', maxTouchPoints: 0,
      innerWidth: 1600, screenWidth: 1600, screenHeight: 900, devicePixelRatio: 1,
      renderer: 'Google SwiftShader', deviceMemory: 8, hardwareConcurrency: 8,
      uaPlatform: 'Windows', uaMobile: false,
    }),
    deviceClass: 'limited',
    legacy: 'legacy-desktop',
  },
  {
    name: 'A 2 GB Android phone',
    signals: signals({
      userAgent: UA.pixel, platform: 'Linux armv81', maxTouchPoints: 5,
      innerWidth: 360, screenWidth: 360, screenHeight: 740, devicePixelRatio: 2,
      anyPointerCoarse: true, pointerCoarse: true,
      renderer: 'ANGLE (Qualcomm, Adreno (TM) 610, OpenGL ES 3.2)',
      deviceMemory: 2, hardwareConcurrency: 8, uaPlatform: 'Android', uaMobile: true,
    }),
    deviceClass: 'limited',
    legacy: 'legacy-touch',
  },
];

describe('classifyDevice', () => {
  for (const fixture of FIXTURES) {
    it(`reads ${fixture.name} as ${fixture.deviceClass}`, () => {
      expect(classifyDevice(fixture.signals)).toBe(fixture.deviceClass);
    });
  }

  it('never demotes a device whose renderer string it cannot read', () => {
    // A blocked WEBGL_debug_renderer_info is a privacy setting, not a
    // software rasteriser, and every Safari withholds deviceMemory. Reading
    // either absence as evidence would put every iPhone on the smallest
    // envelope there is.
    const firefox = FIXTURES.find((f) => f.name.startsWith('Firefox'))!;
    expect(firefox.signals.renderer).toBeNull();
    expect(firefox.signals.deviceMemory).toBeNull();
    expect(classifyDevice(firefox.signals)).toBe('desktop');
    const iphone = FIXTURES[0];
    expect(iphone.signals.deviceMemory).toBeNull();
    expect(classifyDevice(iphone.signals)).toBe('phone');
  });

  it('reads a low memory report only when it is a number', () => {
    const base = FIXTURES.find((f) => f.name === 'Pixel 8, Chrome')!.signals;
    expect(classifyDevice({ ...base, deviceMemory: 2 })).toBe('limited');
    expect(classifyDevice({ ...base, deviceMemory: 3 })).toBe('phone');
    expect(classifyDevice({ ...base, deviceMemory: null })).toBe('phone');
  });

  it('matches a software renderer positively, by name', () => {
    const base = FIXTURES.find((f) => f.name === 'MacBook Pro, Chrome')!.signals;
    for (const renderer of ['Google SwiftShader', 'llvmpipe (LLVM 15.0.6, 256 bits)', 'Software Rasterizer', 'Basic Render Driver']) {
      expect(classifyDevice({ ...base, renderer })).toBe('limited');
    }
    expect(classifyDevice({ ...base, renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070, D3D11)' })).toBe('desktop');
  });

  it('asks the touchscreen question of any pointer, not the primary one', () => {
    // An Android tablet with a keyboard case reports a fine primary pointer
    // and is still an Android tablet. Only `any-pointer` sees the screen.
    const tablet = FIXTURES.find((f) => f.name.includes('with a mouse'))!.signals;
    expect(tablet.pointerCoarse).toBe(false);
    expect(tablet.anyPointerCoarse).toBe(true);
    expect(classifyDevice(tablet)).toBe('tablet');
    // A desktop with neither is a desktop; a touch chassis is what opens the
    // size question at all.
    expect(classifyDevice({ ...tablet, anyPointerCoarse: false, uaPlatform: null, userAgent: UA.windows })).toBe('desktop');
  });

  it('measures the chassis, not the window', () => {
    // A phone in landscape keeps the same smaller side, and a maximised or a
    // dragged-narrow window does not change what the device is.
    const iphone = FIXTURES[0].signals;
    const landscape = { ...iphone, screenWidth: 852, screenHeight: 393, innerWidth: 852 };
    expect(classifyDevice(landscape)).toBe('phone');
    const laptop = FIXTURES.find((f) => f.name.startsWith('Windows touch laptop'))!.signals;
    expect(laptop.innerWidth).toBe(1024);
    expect(classifyDevice(laptop)).toBe('desktop');
  });

  it('gives the tablet band an upper bound for everything but Apple and Android', () => {
    const laptop = FIXTURES.find((f) => f.name.startsWith('Windows touch laptop'))!.signals;
    // A touchscreen all-in-one is a desktop; the 13" iPad next to it, at the
    // same 1024 CSS px on its short side, is not.
    expect(classifyDevice({ ...laptop, screenWidth: 1920, screenHeight: 1080 })).toBe('desktop');
    expect(classifyDevice({ ...laptop, screenWidth: 1200, screenHeight: 900 })).toBe('desktop');
    expect(classifyDevice({ ...laptop, screenWidth: 1024, screenHeight: 768 })).toBe('tablet');
    const ipad = FIXTURES.find((f) => f.name.startsWith('iPad Pro'))!.signals;
    expect(Math.min(ipad.screenWidth, ipad.screenHeight)).toBe(1024);
    expect(classifyDevice(ipad)).toBe('tablet');
  });
});

describe('the compatibility profile', () => {
  it('pins the numbers the app ships with, verbatim', () => {
    expect(LEGACY_TOUCH_PROFILE).toEqual({
      id: 'legacy-touch',
      envelopeBytes: 320 * MiB,
      ceilingBytes: 144 * MiB,
      residentCap: 8,
      inflightCap: 1,
      fetchPool: 3,
      wantTexelPx: 1.25,
      releaseTexelPx: 0.8,
      cacheOnlyWarm: true,
      tierCaps: { earthClouds: '4k', moon: '4k' },
    });
    expect(LEGACY_DESKTOP_PROFILE).toEqual({
      id: 'legacy-desktop',
      envelopeBytes: 768 * MiB,
      ceilingBytes: 256 * MiB,
      residentCap: 16,
      inflightCap: 2,
      fetchPool: 6,
      wantTexelPx: 1.0,
      releaseTexelPx: 0.65,
      cacheOnlyWarm: false,
      tierCaps: {},
    });
  });

  it('is the exact device test the app shipped with, on every recorded device', () => {
    // Three arms: an iOS user agent, a Mac platform with more than one touch
    // point (iPadOS and "Request Desktop Website" both land here), and any
    // touchscreen in a window 1024 CSS px or narrower.
    for (const fixture of FIXTURES) {
      const expected = (
        /iPad|iPhone|iPod/.test(fixture.signals.userAgent) ||
        (fixture.signals.platform === 'MacIntel' && fixture.signals.maxTouchPoints > 1) ||
        (fixture.signals.maxTouchPoints > 0 && fixture.signals.innerWidth <= 1024)
      );
      expect(legacyTouchFirst(fixture.signals), fixture.name).toBe(expected);
      expect(legacyProfile(fixture.signals).id, fixture.name).toBe(fixture.legacy);
    }
  });

  it('names exactly the devices the class would move, once it is allowed to', () => {
    // The class is collected and logged; the numbers still come from the
    // predicate above. This is the list that has to be accepted before the
    // two are joined — a device on it changes what it holds in memory.
    // A phone or a tablet would take today's touch numbers and a desktop
    // today's desktop ones, so those agree silently. `limited` is a third set
    // of numbers, so every device landing there moves whatever it takes now.
    const keepsItsNumbers = (f: Fixture): boolean => {
      const found = classifyDevice(f.signals);
      if (found === 'limited') return false;
      return f.legacy === (found === 'desktop' ? 'legacy-desktop' : 'legacy-touch');
    };
    const moved = FIXTURES
      .filter((f) => !keepsItsNumbers(f))
      .map((f) => `${f.name}: ${f.legacy} -> ${classifyDevice(f.signals)}`);
    expect(moved).toEqual([
      'Samsung DeX: an Android phone driving a 1920x1080 desktop: legacy-desktop -> tablet',
      'Windows touch laptop, window dragged to 1024 CSS px: legacy-touch -> desktop',
      'Chromebook with a touchscreen, 1366x768: legacy-desktop -> tablet',
      'Playwright WebKit, phone viewport with its own desktop UA: legacy-desktop -> phone',
      'SwiftShader: no GPU at all: legacy-desktop -> limited',
      'A 2 GB Android phone: legacy-touch -> limited',
    ]);
  });
});
