/**
 * What a device can be asked about itself, what class that makes it, and the
 * memory numbers that class is allowed to spend. One place, DOM-free apart
 * from `readDeviceSignals`, so the policy is testable against recorded
 * devices instead of against whatever browser the test happens to run in.
 *
 * Why a class at all: WebGL reports no memory figure. `MAX_TEXTURE_SIZE` says
 * whether ONE map can be loaded and nothing about how many may be resident,
 * and the one number that matters — how much a tab may hold before the system
 * closes it — is unpublished on the platform where it binds (iOS). So the
 * device is classified from what it does say, and the classes carry measured
 * numbers.
 *
 * What each signal is worth, measured on real hardware and in the Playwright
 * harness that stands in for Safari:
 *
 * - The renderer string names the GPU on Chromium, Android and Windows, but
 *   every Apple Safari — a Mac, an iPhone, an iPad — answers `Apple GPU`. It
 *   cannot split Apple devices. It is still read: it is the only way to spot
 *   a software rasteriser.
 * - `navigator.deviceMemory` is Chromium-only, secure-context-only, and is
 *   system RAM rather than GPU memory. A missing field means nothing, so only
 *   a real number may move a device down.
 * - `maxTouchPoints > 1` on a Mac platform is the documented iPadOS tell, and
 *   catches "Request Desktop Website" on an iPhone too. The Playwright WebKit
 *   harness reports 0 where a real iPhone reports 5, which is why the
 *   classifier cannot rest on it alone.
 * - `(any-pointer: coarse)` is the touch-chassis question. `(pointer: coarse)`
 *   asks about the PRIMARY pointer, so an Android tablet with a mouse or a
 *   keyboard case answers false to it while still being an Android tablet.
 *
 * The classifier runs once. The signals it read and the profile it produced
 * are immutable for the mode's lifetime: the streamer's limits are readonly
 * from its constructor and a body's ladder ceiling is resolved when the handle
 * is made, so a mid-session reclassification would split one session across
 * two policies. A chassis change — a foldable opening, a dock — takes effect
 * on the next load.
 */
import type { TextureTier } from './texturePolicy';

export type DeviceClass = 'phone' | 'tablet' | 'desktop' | 'limited';

/** Everything the classifier reads, as literal values, so a device can be
 *  recorded once and replayed in a test. Fields a browser withholds are null
 *  rather than a default: "unreadable" and "reported low" are different
 *  answers and only the second one may move a device down a class. */
export interface DeviceSignals {
  userAgent: string;
  /** `navigator.platform`: 'MacIntel' on a Mac AND on an iPad. */
  platform: string;
  maxTouchPoints: number;
  /** The browser window's CSS width — the chassis is `screen`, not this. */
  innerWidth: number;
  /** The screen's CSS size. The chassis measure: device pixels move with the
   *  model, the CSS box of a phone does not. */
  screenWidth: number;
  screenHeight: number;
  devicePixelRatio: number;
  /** A touchscreen exists, mouse attached or not. */
  anyPointerCoarse: boolean;
  /** The primary pointer is a finger. */
  pointerCoarse: boolean;
  /** WEBGL_debug_renderer_info's unmasked renderer, or null when the browser
   *  withholds it (Firefox with fingerprinting resistance, Brave). */
  renderer: string | null;
  /** GiB of system RAM, or null where the field does not exist — which is
   *  every Safari and every non-secure origin, the LAN dev server included. */
  deviceMemory: number | null;
  hardwareConcurrency: number | null;
  /** `navigator.userAgentData`, absent on Safari and Firefox. */
  uaPlatform: string | null;
  uaMobile: boolean | null;
}

/** The numbers the sector streamer is built with. It takes these rather than
 *  a device guess so its tests state what they mean, and so one table is the
 *  only place a device becomes a number. */
export interface SectorMemoryLimits {
  /** Sector tiles and the ladder's globe maps together may not exceed this. */
  envelopeBytes: number;
  /** What the tiles alone may hold, whatever the envelope leaves free. */
  ceilingBytes: number;
  /** Resident sectors across all bodies: a draw-call ceiling, not the budget. */
  residentCap: number;
  /** Sector loads in flight (colour + crops of one sector count as one). */
  inflightCap: number;
  /** Individual map fetches in flight: one sector is up to three of them. */
  fetchPool: number;
  /** Device pixels per base texel at which a sector is worth fetching. */
  wantTexelPx: number;
  /** And below which a resident one is given back. */
  releaseTexelPx: number;
}

/** A class's whole memory policy: what the streamer is built with, plus the
 *  two ladder decisions that are about total residency rather than a single
 *  map's size. */
export interface DeviceProfile extends SectorMemoryLimits {
  /** Which branch of the table these numbers came from, for the debug line. */
  id: 'legacy-touch' | 'legacy-desktop';
  /** The speculative boot warm pulls its bytes into the HTTP cache only,
   *  rather than decoding and uploading maps a session may never visit. */
  cacheOnlyWarm: boolean;
  /** Ladder rungs this profile refuses whatever the GL max texture size
   *  allows. Keyed by upgrade key; absent means the ladder's own top. */
  tierCaps: Readonly<Partial<Record<string, TextureTier>>>;
}

const MiB = 1024 * 1024;

/** Per-key ceilings on a touch-first device, applied over the GL clamp. An 8K
 *  RGBA map is 171 MiB resident with its mips, and a phone's shared memory is
 *  the app's known weak spot (an unexplained crash teleporting to the Moon on
 *  an iPhone). Neither 8K earns its place there. The Moon's: at the
 *  telescope's default framing on a phone the disc is ~630 device pixels,
 *  where a 4K texel already spans half a pixel — the 8K first shows once the
 *  disc passes ~1600 device pixels, and from there the 16K sector tiles
 *  (measured against this ceiling) take over at a fraction of the memory. The
 *  cloud deck's: it would sit beside Earth's 4K day map and the sector tiles
 *  in the close approach the sectors serve. */
const TOUCH_TIER_CAPS: Readonly<Partial<Record<string, TextureTier>>> = { earthClouds: '4k', moon: '4k' };

/**
 * A touch-first device's numbers. An Earth sector set — its 2048² tile plus
 * its copies of the bump and roughness crops — is ~23.1 MiB, so this holds
 * six of them. Six is what a phone held before the budget was in bytes at
 * all, and a phone's shared memory is the app's known weak spot.
 *
 * It asks for tiles later than a desktop, at 1.25 device pixels per texel:
 * a 2–3× display reaches that magnification at nearly twice the distance, and
 * every earlier tile is a 200 KB fetch and 21 MiB of shared memory on the
 * device with the least of both.
 */
export const LEGACY_TOUCH_PROFILE: DeviceProfile = {
  id: 'legacy-touch',
  envelopeBytes: 320 * MiB,
  ceilingBytes: 144 * MiB,
  residentCap: 8,
  inflightCap: 1,
  fetchPool: 3,
  wantTexelPx: 1.25,
  releaseTexelPx: 0.8,
  cacheOnlyWarm: true,
  tierCaps: TOUCH_TIER_CAPS,
};

/**
 * A desktop's numbers: eleven Earth sector sets under the ceiling, inside an
 * envelope the globe maps share. It asks at 1.0 device pixels per texel —
 * a base texel spanning one device pixel is the point where a finer map
 * first shows, and the fetch after that is the only delay.
 */
export const LEGACY_DESKTOP_PROFILE: DeviceProfile = {
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
};

/** Software rasterisers, which deserve the smallest of everything. Matched
 *  positively and never inferred: a browser that withholds the renderer
 *  string is not a software renderer, it is a browser with a privacy
 *  setting. */
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|software|basic render/i;

/** Under this many CSS pixels on its smaller side, a chassis is a phone. The
 *  largest phone in portrait is ~480 CSS px wide (iPhone 16 Pro Max is 440);
 *  the smallest tablet is 744 (iPad mini). */
const PHONE_MAX_CSS_SIDE = 600;
/** And at or above this, a touch chassis that is neither Apple nor Android is
 *  a laptop with a touchscreen rather than a tablet. */
const TOUCH_LAPTOP_MIN_CSS_SIDE = 900;

/** The iOS/iPadOS tell. iPadOS reports as a Mac — `MacIntel`, a desktop
 *  Safari UA — and so does an iPhone asked for the desktop website; touch
 *  points are what separates either from a real Mac. */
function appleTouchDevice(s: DeviceSignals): boolean {
  return /iPad|iPhone|iPod/.test(s.userAgent) ||
    (/^Mac/.test(s.platform) && s.maxTouchPoints > 1);
}

/** Android, from the field that is reliable on Chrome Android for both
 *  `mobile: true` phones and `mobile: false` tablets, with the UA behind it.
 *  It belongs among the primary keys because it can only move a device
 *  down: an Android tablet with a mouse attached reports a fine primary
 *  pointer and would otherwise take the desktop numbers. */
function androidDevice(s: DeviceSignals): boolean {
  return s.uaPlatform === 'Android' || /Android/.test(s.userAgent);
}

/**
 * The class a set of signals lands on. Keys in order: the Apple touch tell,
 * Android, whether a touchscreen exists at all, then the chassis size.
 * `limited` comes first because a software rasteriser is a fact about the
 * hardware that outranks the shape of the box it is in.
 */
export function classifyDevice(s: DeviceSignals): DeviceClass {
  if (s.renderer !== null && SOFTWARE_RENDERER.test(s.renderer)) return 'limited';
  if (typeof s.deviceMemory === 'number' && s.deviceMemory <= 2) return 'limited';

  const apple = appleTouchDevice(s);
  const android = androidDevice(s);
  if (!apple && !android && !s.anyPointerCoarse) return 'desktop';

  const minSide = Math.min(s.screenWidth, s.screenHeight);
  if (minSide > 0 && minSide < PHONE_MAX_CSS_SIDE) return 'phone';
  // A Windows, ChromeOS or Linux machine with a touchscreen and a screen this
  // big is a laptop or an all-in-one, not a tablet. Apple and Android
  // chassis are exempt: a 13" iPad reports 1024 CSS px and is still a tablet.
  if (!apple && !android && minSide >= TOUCH_LAPTOP_MIN_CSS_SIDE) return 'desktop';
  return 'tablet';
}

/**
 * The device test the app shipped with, preserved exactly: an iOS user agent,
 * a Mac platform with more than one touch point, or any touchscreen in a
 * window 1024 CSS px or narrower. It is what chooses the numbers while the
 * class above is only being collected, so that introducing the classifier
 * changes no device's behaviour. Note the third arm measures the WINDOW, not
 * the screen — a touch laptop with a narrow window takes the touch numbers
 * today, which is one of the devices the class will move when it is allowed
 * to size anything.
 */
export function legacyTouchFirst(s: DeviceSignals): boolean {
  return (
    /iPad|iPhone|iPod/.test(s.userAgent) ||
    (s.platform === 'MacIntel' && s.maxTouchPoints > 1) ||
    (s.maxTouchPoints > 0 && s.innerWidth <= 1024)
  );
}

/** The profile the legacy test picks. */
export function legacyProfile(s: DeviceSignals): DeviceProfile {
  return legacyTouchFirst(s) ? LEGACY_TOUCH_PROFILE : LEGACY_DESKTOP_PROFILE;
}

/** Read the signals off the live browser. The one function here that touches
 *  the DOM, and the only one that cannot be tested against a fixture — which
 *  is why it does nothing but read. */
export function readDeviceSignals(gl?: WebGLRenderingContext | WebGL2RenderingContext | null): DeviceSignals {
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    userAgentData?: { platform?: string; mobile?: boolean };
  };
  const media = (query: string): boolean => {
    try { return window.matchMedia(query).matches; } catch { return false; }
  };
  let renderer: string | null = null;
  try {
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    if (info) {
      const value = gl?.getParameter(info.UNMASKED_RENDERER_WEBGL);
      renderer = typeof value === 'string' ? value : null;
    }
  } catch { renderer = null; }
  return {
    userAgent: nav.userAgent,
    platform: nav.platform,
    maxTouchPoints: nav.maxTouchPoints,
    innerWidth: window.innerWidth,
    screenWidth: screen.width,
    screenHeight: screen.height,
    devicePixelRatio: window.devicePixelRatio,
    anyPointerCoarse: media('(any-pointer: coarse)'),
    pointerCoarse: media('(pointer: coarse)'),
    renderer,
    deviceMemory: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
    hardwareConcurrency: typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null,
    uaPlatform: typeof nav.userAgentData?.platform === 'string' ? nav.userAgentData.platform : null,
    uaMobile: typeof nav.userAgentData?.mobile === 'boolean' ? nav.userAgentData.mobile : null,
  };
}
