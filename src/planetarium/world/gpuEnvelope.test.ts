import { describe, it, expect } from 'vitest';
import {
  classifyDevice,
  deviceProfileFor,
  fillRateTierCaps,
  ladderCeilingBytes,
  legacyProfile,
  legacyTouchFirst,
  planRelease,
  platformFamily,
  profileForDevice,
  sectorBudgetBytes,
  APPLE_PHONE_PROFILE,
  APPLE_TABLET_PROFILE,
  DEVICE_PROFILES,
  EARTH_SECTOR_SET_BYTES,
  FILL_RATE_TIER_CAP,
  LEGACY_DESKTOP_PROFILE,
  LEGACY_TOUCH_PROFILE,
  LIMITED_PROFILE,
  type DeviceClass,
  type DeviceProfile,
  type DeviceSignals,
  type PlatformFamily,
  type ReleaseCandidate,
} from './gpuEnvelope';
import { SECTOR_SETS, sectorSetGpuBytes } from './sectorStreamer';

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
  // The two devices the Apple envelope was measured on, at the OS and Safari
  // versions probe.html recorded: iOS 18.7 / Safari 26.6 and iPadOS /
  // Safari 26.5. Everything else in those two fixtures is the reading itself.
  iphone187: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1',
  ipados265: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Safari/605.1.15',
};

interface Fixture {
  name: string;
  signals: DeviceSignals;
  /** What the classifier makes of it. */
  deviceClass: DeviceClass;
  /** Whose platform it is, which decides whether a measurement reaches it. */
  family: PlatformFamily;
  /** The row those two land on, and so every number it spends. */
  row: DeviceProfile['id'];
  /** And which numbers the app gave it before the class was allowed to size
   *  anything — the reference the switch is measured against. */
  legacy: 'legacy-touch' | 'legacy-desktop';
}

/**
 * One row per device the classifier has to get right. The two rows marked as
 * probe readings are the devices the Apple envelope was measured on, copied
 * from what probe.html reported on them; the three Playwright WebKit rows
 * were read off the harness itself (planning/_envelope-wk-signals.mjs) and
 * the desktop Chromium figures off this machine; the rest are the published
 * chassis sizes and the user-agent strings those devices send.
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
    family: 'apple',
    row: 'apple-phone',
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
    family: 'apple',
    row: 'apple-phone',
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
    family: 'apple',
    row: 'apple-tablet',
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
    family: 'apple',
    row: 'apple-tablet',
    legacy: 'legacy-touch',
  },
  {
    // The phone the 768 MiB row was measured on: 46 maps of 42.7 MiB —
    // 1962.7 MiB — still drawing, no kill at any size (2026-08-29).
    name: "Alex's iPhone, as probe.html read it",
    signals: signals({
      userAgent: UA.iphone187, platform: 'iPhone', maxTouchPoints: 5,
      innerWidth: 430, screenWidth: 430, screenHeight: 932, devicePixelRatio: 3,
      anyPointerCoarse: true, pointerCoarse: true, renderer: 'Apple GPU',
      deviceMemory: null, hardwareConcurrency: 4,
    }),
    deviceClass: 'phone',
    family: 'apple',
    row: 'apple-phone',
    legacy: 'legacy-touch',
  },
  {
    // And the tablet: 95 maps — 4053.3 MiB, the probe's own 4 GiB stop —
    // with the device still showing nothing (2026-08-29). MacIntel with five
    // touch points is the iPad tell; it sends a desktop Safari UA.
    name: "Alex's iPad, as probe.html read it",
    signals: signals({
      userAgent: UA.ipados265, platform: 'MacIntel', maxTouchPoints: 5,
      innerWidth: 834, screenWidth: 834, screenHeight: 1062, devicePixelRatio: 2,
      anyPointerCoarse: true, pointerCoarse: true, renderer: 'Apple GPU',
      deviceMemory: null, hardwareConcurrency: 8,
    }),
    deviceClass: 'tablet',
    family: 'apple',
    row: 'apple-tablet',
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
    family: 'android',
    row: 'legacy-touch',
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
    family: 'android',
    row: 'legacy-touch',
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
    family: 'android',
    row: 'legacy-touch',
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
    family: 'android',
    row: 'legacy-touch',
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
    family: 'other',
    row: 'legacy-desktop',
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
    family: 'other',
    row: 'legacy-desktop',
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
    family: 'other',
    row: 'legacy-touch',
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
    family: 'apple',
    row: 'legacy-desktop',
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
    family: 'apple',
    row: 'legacy-desktop',
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
    family: 'apple',
    row: 'apple-phone',
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
    family: 'apple',
    row: 'apple-phone',
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
    family: 'other',
    row: 'legacy-desktop',
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
    family: 'other',
    row: 'limited',
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
    family: 'android',
    row: 'limited',
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

describe('the class table', () => {
  /** The numbers a row spends, without the label on it: what a device holds
   *  is these ten fields, and two rows that agree on them are the same
   *  policy under two names. */
  const numbersOf = (p: DeviceProfile) => ({
    envelopeBytes: p.envelopeBytes,
    ceilingBytes: p.ceilingBytes,
    sectorFloorBytes: p.sectorFloorBytes,
    residentCap: p.residentCap,
    inflightCap: p.inflightCap,
    fetchPool: p.fetchPool,
    wantTexelPx: p.wantTexelPx,
    releaseTexelPx: p.releaseTexelPx,
    cacheOnlyWarm: p.cacheOnlyWarm,
    tierCaps: p.tierCaps,
  });

  for (const fixture of FIXTURES) {
    it(`reads ${fixture.name} as ${fixture.family} and gives it the ${fixture.row} numbers`, () => {
      expect(platformFamily(fixture.signals)).toBe(fixture.family);
      expect(profileForDevice(fixture.signals).id).toBe(fixture.row);
      // And by the two keys separately, so a fixture cannot pass on a
      // classifier and a family that happen to cancel each other out.
      expect(deviceProfileFor(fixture.deviceClass, fixture.family).id).toBe(fixture.row);
    });
  }

  it('has a row for every class in every family', () => {
    const families: PlatformFamily[] = ['apple', 'android', 'other'];
    const classes: DeviceClass[] = ['phone', 'tablet', 'desktop', 'limited'];
    for (const family of families) {
      for (const cls of classes) {
        const row = deviceProfileFor(cls, family);
        expect(row.envelopeBytes, `${family}/${cls}`).toBeGreaterThan(0);
        expect(row.sectorFloorBytes, `${family}/${cls}`).toBeLessThanOrEqual(row.ceilingBytes);
        expect(row.ceilingBytes, `${family}/${cls}`).toBeLessThanOrEqual(row.envelopeBytes);
      }
    }
    expect(Object.keys(DEVICE_PROFILES).sort()).toEqual(['android', 'apple', 'other']);
  });

  it('gives an Apple phone and an Apple tablet the desktop numbers', () => {
    // The measurement, in one assertion: an iPhone held 1962.7 MiB and an
    // iPad 4053.3 with no kill, so neither is asked to spend less than the
    // machine that was never in doubt. The cloud deck's cap is the only
    // difference, and it is about fill rate rather than memory.
    for (const row of [APPLE_PHONE_PROFILE, APPLE_TABLET_PROFILE]) {
      expect(numbersOf(row)).toEqual({
        ...numbersOf(LEGACY_DESKTOP_PROFILE),
        tierCaps: { earthClouds: '4k' },
      });
      expect(row.envelopeBytes).toBe(768 * MiB);
      expect(row.ceilingBytes).toBe(256 * MiB);
      expect(row.sectorFloorBytes).toBe(3 * EARTH_SECTOR_SET_BYTES);
      expect(row.cacheOnlyWarm).toBe(false);
    }
    expect(APPLE_PHONE_PROFILE.provenance).toBe('measured 2026-08-29 iPhone');
    expect(APPLE_TABLET_PROFILE.provenance).toBe('measured 2026-08-29 iPad');
  });

  it('leaves every unmeasured touch row exactly as the app shipped it', () => {
    // Android and everything that is neither Apple nor Android: nobody has
    // walked one of these up to its ceiling, so nothing here may move.
    for (const family of ['android', 'other'] as PlatformFamily[]) {
      for (const cls of ['phone', 'tablet'] as DeviceClass[]) {
        const row = deviceProfileFor(cls, family);
        expect(row.id, `${family}/${cls}`).toBe('legacy-touch');
        expect(numbersOf(row), `${family}/${cls}`).toEqual(numbersOf(LEGACY_TOUCH_PROFILE));
        expect(row.provenance, `${family}/${cls}`).toBe('legacy');
      }
    }
    expect(numbersOf(LEGACY_TOUCH_PROFILE)).toEqual({
      envelopeBytes: 320 * MiB,
      ceilingBytes: 144 * MiB,
      sectorFloorBytes: 2 * EARTH_SECTOR_SET_BYTES,
      residentCap: 8,
      inflightCap: 1,
      fetchPool: 3,
      wantTexelPx: 1.25,
      releaseTexelPx: 0.8,
      cacheOnlyWarm: true,
      tierCaps: { earthClouds: '4k' },
    });
  });

  it('gives every family the same desktop row and the same limited one', () => {
    // A desktop is a desktop, and a software rasteriser is a fact about the
    // renderer that no platform measurement reaches past.
    for (const family of ['apple', 'android', 'other'] as PlatformFamily[]) {
      expect(deviceProfileFor('desktop', family)).toBe(LEGACY_DESKTOP_PROFILE);
      expect(deviceProfileFor('limited', family)).toBe(LIMITED_PROFILE);
    }
    expect(LIMITED_PROFILE.envelopeBytes).toBe(192 * MiB);
    expect(LIMITED_PROFILE.ceilingBytes).toBe(2 * EARTH_SECTOR_SET_BYTES);
    expect(LIMITED_PROFILE.sectorFloorBytes).toBe(EARTH_SECTOR_SET_BYTES);
    // It needs no cloud-deck cap of its own: the 8K deck is 171 MiB and the
    // ladder may hold 192 less the tiles' floor, so the arithmetic refuses it
    // before any fill-rate argument is reached.
    expect(LIMITED_PROFILE.tierCaps).toEqual({});
    expect(ladderCeilingBytes(LIMITED_PROFILE, LIMITED_PROFILE.sectorFloorBytes)).toBeLessThan(171 * MiB);
  });

  it('caps the cloud deck on a phone and a tablet of every family', () => {
    for (const family of ['apple', 'android', 'other'] as PlatformFamily[]) {
      expect(deviceProfileFor('phone', family).tierCaps, family).toEqual({ earthClouds: '4k' });
      expect(deviceProfileFor('tablet', family).tierCaps, family).toEqual({ earthClouds: '4k' });
      expect(deviceProfileFor('desktop', family).tierCaps, family).toEqual({});
    }
    // Including the Apple phone, which is on the desktop's memory numbers and
    // still does not shade a full-screen 8K transparent shell.
    expect(profileForDevice(FIXTURES[0].signals).tierCaps).toEqual({ earthClouds: '4k' });
    expect(profileForDevice(FIXTURES[0].signals).envelopeBytes).toBe(768 * MiB);
  });

  it('warms the boot pair for real on Apple and into the cache elsewhere', () => {
    // The speculative Earth+Moon warm decodes and uploads, or pulls the same
    // bytes into the HTTP cache and no further. Which one a device gets is
    // the same question as whether it has room for two maps a session may
    // never visit — and the Apple measurement answers yes.
    for (const cls of ['phone', 'tablet'] as DeviceClass[]) {
      expect(deviceProfileFor(cls, 'apple').cacheOnlyWarm, `apple/${cls}`).toBe(false);
      expect(deviceProfileFor(cls, 'android').cacheOnlyWarm, `android/${cls}`).toBe(true);
      expect(deviceProfileFor(cls, 'other').cacheOnlyWarm, `other/${cls}`).toBe(true);
    }
    expect(deviceProfileFor('desktop', 'other').cacheOnlyWarm).toBe(false);
    expect(deviceProfileFor('limited', 'apple').cacheOnlyWarm).toBe(true);
  });

  it('pins the two legacy rows verbatim, labels and all', () => {
    expect(LEGACY_TOUCH_PROFILE).toEqual({
      id: 'legacy-touch',
      provenance: 'legacy',
      envelopeBytes: 320 * MiB,
      ceilingBytes: 144 * MiB,
      sectorFloorBytes: 2 * EARTH_SECTOR_SET_BYTES,
      residentCap: 8,
      inflightCap: 1,
      fetchPool: 3,
      wantTexelPx: 1.25,
      releaseTexelPx: 0.8,
      cacheOnlyWarm: true,
      // The Moon's 4K cap is gone: whether a device holds the 8K rung is
      // arithmetic against the envelope now, and the compressed Moon tier is
      // 42.7 MiB rather than the 171 the cap was written against. The cloud
      // deck's cap stays, and is about fill rate rather than memory.
      tierCaps: { earthClouds: '4k' },
    });
    expect(LEGACY_DESKTOP_PROFILE).toEqual({
      id: 'legacy-desktop',
      provenance: 'legacy',
      envelopeBytes: 768 * MiB,
      ceilingBytes: 256 * MiB,
      sectorFloorBytes: 3 * EARTH_SECTOR_SET_BYTES,
      residentCap: 16,
      inflightCap: 2,
      fetchPool: 6,
      wantTexelPx: 1.0,
      releaseTexelPx: 0.65,
      cacheOnlyWarm: false,
      tierCaps: {},
    });
  });

  it('keeps the shipped device test intact as the reference it is measured against', () => {
    // Three arms: an iOS user agent, a Mac platform with more than one touch
    // point (iPadOS and "Request Desktop Website" both land here), and any
    // touchscreen in a window 1024 CSS px or narrower. Nothing calls it; the
    // two tests below are what it is for.
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

  it('names exactly the devices whose numbers the switch moves', () => {
    // Every device here holds something different from today. The list is
    // accepted, not discovered: a device that appears or disappears from it
    // is a change in what real hardware does.
    const moved = FIXTURES
      .filter((f) => JSON.stringify(numbersOf(legacyProfile(f.signals))) !== JSON.stringify(numbersOf(profileForDevice(f.signals))))
      .map((f) => `${f.name}: ${legacyProfile(f.signals).id} -> ${profileForDevice(f.signals).id}`);
    expect(moved).toEqual([
      'iPhone 15 Pro, Safari: legacy-touch -> apple-phone',
      'iPhone with Request Desktop Website — a Mac UA on a phone chassis: legacy-touch -> apple-phone',
      'iPad Pro 13", which always sends a desktop UA: legacy-touch -> apple-tablet',
      'iPad mini: legacy-touch -> apple-tablet',
      "Alex's iPhone, as probe.html read it: legacy-touch -> apple-phone",
      "Alex's iPad, as probe.html read it: legacy-touch -> apple-tablet",
      'Samsung DeX: an Android phone driving a 1920x1080 desktop: legacy-desktop -> legacy-touch',
      'Windows touch laptop, window dragged to 1024 CSS px: legacy-touch -> legacy-desktop',
      'Chromebook with a touchscreen, 1366x768: legacy-desktop -> legacy-touch',
      'Playwright WebKit, emulated iPhone with the iOS UA: legacy-touch -> apple-phone',
      'Playwright WebKit, phone viewport with its own desktop UA: legacy-desktop -> apple-phone',
      'SwiftShader: no GPU at all: legacy-desktop -> limited',
      'A 2 GB Android phone: legacy-touch -> limited',
    ]);
    // The Android tablet with a mouse changes class — the primary pointer is
    // fine and only `any-pointer` sees its screen — but not its numbers: its
    // window was already inside the shipped test's 1024 px arm. The DeX row
    // is the same move with numbers attached, because its window is wider.
    const mouse = FIXTURES.find((f) => f.name.includes('with a mouse'))!;
    expect(classifyDevice(mouse.signals)).toBe('tablet');
    expect(moved.some((m) => m.includes('with a mouse'))).toBe(false);
  });

  it('states each of those moves in numbers', () => {
    const shape = (p: DeviceProfile) => {
      const sets = Math.round(p.sectorFloorBytes / EARTH_SECTOR_SET_BYTES);
      return `${Math.round(p.envelopeBytes / MiB)}/${Math.round(p.ceilingBytes / MiB)} MiB, floor ${sets === 1 ? '1 set' : `${sets} sets`}, ` +
        `${p.residentCap}/${p.inflightCap}/${p.fetchPool}, want ${p.wantTexelPx}/${p.releaseTexelPx}, ` +
        `warm ${p.cacheOnlyWarm ? 'cached' : 'full'}, caps ${JSON.stringify(p.tierCaps)}`;
    };
    const seen = new Map<string, string>();
    for (const f of FIXTURES) {
      const was = legacyProfile(f.signals);
      const now = profileForDevice(f.signals);
      if (shape(was) === shape(now)) continue;
      const key = `${was.id} -> ${now.id}`;
      if (!seen.has(key)) seen.set(key, `${key}\n    was ${shape(was)}\n    now ${shape(now)}`);
    }
    expect([...seen.values()]).toEqual([
      'legacy-touch -> apple-phone\n' +
      '    was 320/144 MiB, floor 2 sets, 8/1/3, want 1.25/0.8, warm cached, caps {"earthClouds":"4k"}\n' +
      '    now 768/256 MiB, floor 3 sets, 16/2/6, want 1/0.65, warm full, caps {"earthClouds":"4k"}',
      'legacy-touch -> apple-tablet\n' +
      '    was 320/144 MiB, floor 2 sets, 8/1/3, want 1.25/0.8, warm cached, caps {"earthClouds":"4k"}\n' +
      '    now 768/256 MiB, floor 3 sets, 16/2/6, want 1/0.65, warm full, caps {"earthClouds":"4k"}',
      'legacy-desktop -> legacy-touch\n' +
      '    was 768/256 MiB, floor 3 sets, 16/2/6, want 1/0.65, warm full, caps {}\n' +
      '    now 320/144 MiB, floor 2 sets, 8/1/3, want 1.25/0.8, warm cached, caps {"earthClouds":"4k"}',
      'legacy-touch -> legacy-desktop\n' +
      '    was 320/144 MiB, floor 2 sets, 8/1/3, want 1.25/0.8, warm cached, caps {"earthClouds":"4k"}\n' +
      '    now 768/256 MiB, floor 3 sets, 16/2/6, want 1/0.65, warm full, caps {}',
      'legacy-desktop -> apple-phone\n' +
      '    was 768/256 MiB, floor 3 sets, 16/2/6, want 1/0.65, warm full, caps {}\n' +
      '    now 768/256 MiB, floor 3 sets, 16/2/6, want 1/0.65, warm full, caps {"earthClouds":"4k"}',
      'legacy-desktop -> limited\n' +
      '    was 768/256 MiB, floor 3 sets, 16/2/6, want 1/0.65, warm full, caps {}\n' +
      '    now 192/46 MiB, floor 1 set, 4/1/2, want 1.25/0.8, warm cached, caps {}',
      'legacy-touch -> limited\n' +
      '    was 320/144 MiB, floor 2 sets, 8/1/3, want 1.25/0.8, warm cached, caps {"earthClouds":"4k"}\n' +
      '    now 192/46 MiB, floor 1 set, 4/1/2, want 1.25/0.8, warm cached, caps {}',
    ]);
  });
});

describe('the envelope arithmetic', () => {
  const DESKTOP = LEGACY_DESKTOP_PROFILE;
  const TOUCH = LEGACY_TOUCH_PROFILE;
  const SET = sectorSetGpuBytes(SECTOR_SETS.Earth);

  it('states one Earth sector set in bytes, and the floors in whole sets of it', () => {
    // The constant is policy and the layout is the streamer's; they have to
    // be the same number or a floor is a fraction of a set.
    expect(EARTH_SECTOR_SET_BYTES).toBe(SET);
    expect(TOUCH.sectorFloorBytes).toBe(2 * SET);
    expect(DESKTOP.sectorFloorBytes).toBe(3 * SET);
  });

  it('gives the tiles the smaller of their ceiling and what the maps leave', () => {
    expect(sectorBudgetBytes(DESKTOP, 0, DESKTOP.sectorFloorBytes)).toBe(DESKTOP.ceilingBytes);
    expect(sectorBudgetBytes(DESKTOP, DESKTOP.envelopeBytes - 4 * SET, DESKTOP.sectorFloorBytes))
      .toBe(4 * SET);
  });

  it('never trims the tiles below the floor, whatever the maps have taken', () => {
    for (const ladder of [DESKTOP.envelopeBytes, 2 * DESKTOP.envelopeBytes]) {
      expect(sectorBudgetBytes(DESKTOP, ladder, DESKTOP.sectorFloorBytes))
        .toBe(DESKTOP.sectorFloorBytes);
    }
    expect(sectorBudgetBytes(TOUCH, TOUCH.envelopeBytes, TOUCH.sectorFloorBytes))
      .toBe(TOUCH.sectorFloorBytes);
  });

  it('owes no floor where no tile can load', () => {
    // `?sectors=0`: refusing a globe map to reserve memory for tiles that
    // cannot load would be the failure this floor exists to prevent, upside
    // down.
    expect(sectorBudgetBytes(DESKTOP, DESKTOP.envelopeBytes, 0)).toBe(0);
    expect(ladderCeilingBytes(DESKTOP, 0)).toBe(DESKTOP.envelopeBytes);
  });

  it('leaves the ladder the envelope less the tiles floor', () => {
    expect(ladderCeilingBytes(TOUCH, TOUCH.sectorFloorBytes))
      .toBe(TOUCH.envelopeBytes - 2 * SET);
    // A floor bigger than the tiles could ever hold is still only the tiles
    // ceiling, either way round.
    expect(ladderCeilingBytes(TOUCH, 4 * TOUCH.ceilingBytes))
      .toBe(TOUCH.envelopeBytes - TOUCH.ceilingBytes);
  });

  it('keeps the cloud deck off 8K on a phone and a tablet, and only there', () => {
    // Not a memory cap: an 8K transparent shell is shaded over the whole
    // globe, on the devices with the least fill rate to spend.
    expect(FILL_RATE_TIER_CAP.earthClouds).toEqual({ phone: '4k', tablet: '4k' });
    expect(fillRateTierCaps('phone')).toEqual({ earthClouds: '4k' });
    expect(fillRateTierCaps('tablet')).toEqual({ earthClouds: '4k' });
    expect(fillRateTierCaps('desktop')).toEqual({});
    expect(fillRateTierCaps('limited')).toEqual({});
    // And nothing else is capped by class any more: what a device holds is
    // arithmetic against its envelope.
    expect(Object.keys(FILL_RATE_TIER_CAP)).toEqual(['earthClouds']);
  });
});

describe('planning a release', () => {
  const candidate = (over: Partial<ReleaseCandidate>): ReleaseCandidate => ({
    id: 'body:key', heldBytes: 42 * 1024 * 1024, lowBytes: 10 * 1024 * 1024, distance: 1, ...over,
  });
  const ROOMY = { ladderBytes: 0, envelopeBytes: 1024 * 1024 * 1024 };

  it('takes the farthest rung', () => {
    const plan = planRelease([
      candidate({ id: 'near', distance: 0.5 }),
      candidate({ id: 'far', distance: 9 }),
      candidate({ id: 'middle', distance: 3 }),
    ], ROOMY);
    expect(plan?.id).toBe('far');
  });

  it('takes nothing when there is nothing to take', () => {
    expect(planRelease([], ROOMY)).toBeNull();
    // A rung whose lower map costs what it does is no gain at all.
    expect(planRelease([candidate({ heldBytes: 10, lowBytes: 10 })], ROOMY)).toBeNull();
  });

  it('refuses a swap whose transient does not fit', () => {
    // A release holds the high map AND the low one until the swap lands, so
    // the pair has to fit the envelope or the release raises the peak it is
    // there to lower.
    const envelopeBytes = 100;
    const tight = { ladderBytes: 95, envelopeBytes };
    expect(planRelease([candidate({ heldBytes: 40, lowBytes: 10 })], tight)).toBeNull();
    expect(planRelease([candidate({ heldBytes: 40, lowBytes: 5 })], tight)?.id).toBe('body:key');
    // …and it is the farthest of the ones that DO fit, not the farthest of all.
    const plan = planRelease([
      candidate({ id: 'far-but-fat', distance: 9, heldBytes: 40, lowBytes: 10 }),
      candidate({ id: 'near-and-thin', distance: 2, heldBytes: 40, lowBytes: 5 }),
    ], tight);
    expect(plan?.id).toBe('near-and-thin');
  });
});
