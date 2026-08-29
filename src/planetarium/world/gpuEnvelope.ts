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
 * device is classified from what it does say, and the class it lands on —
 * crossed with the platform family, because a measurement only carries as far
 * as the platform it was taken on — names the numbers it may spend.
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

/** Whose memory behaviour a device has, which is a different question from
 *  how big its chassis is. An envelope is measured on hardware, and a
 *  measurement carries only as far as the platform it was taken on: what an
 *  iPhone holds says nothing about what an Android phone holds, and the two
 *  are the same size. Splitting the table this way is what lets a measured
 *  row move without dragging every unmeasured device along with it. */
export type PlatformFamily = 'apple' | 'android' | 'other';

/** Everything the classifier reads, as literal values, so a device can be
 *  recorded once and replayed in a test. Fields a browser withholds are null
 *  rather than a default: "unreadable" and "reported low" are different
 *  answers and only the second one may move a device down a class.
 *
 *  Wider than the classifier: innerWidth, pointerCoarse, devicePixelRatio,
 *  hardwareConcurrency and uaMobile are recorded and no live decision reads
 *  them. Deliberately — a recorded device is worth more complete than minimal,
 *  since the struct exists to be replayed, and two of the five are the signals
 *  that were tried and rejected, each with the reason on its own field below.
 *  What a class is actually decided on is what classifyDevice reads. */
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

/** The numbers the sector streamer is built with — memory limits, the demand
 *  thresholds in device pixels per texel, and the concurrency caps. It takes
 *  these rather than a device guess so its tests state what they mean, and so
 *  one table is the only place a device becomes a number. */
export interface SectorStreamerLimits {
  /** Sector tiles and the ladder's globe maps together may not exceed this. */
  envelopeBytes: number;
  /** What the tiles alone may hold, whatever the envelope leaves free. */
  ceilingBytes: number;
  /** What the tiles keep whatever the globe maps have taken. The globe ladder
   *  may not grow into it, and the budget is never trimmed below it while a
   *  body that can want a tile is registered: a surface at 20x magnification
   *  with no tile at all is a worse picture than any map the ladder refuses,
   *  and "the ladder asked first" is not a reason to decide that for the rest
   *  of the session. */
  sectorFloorBytes: number;
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
export interface DeviceProfile extends SectorStreamerLimits {
  /** Which row of the table these numbers came from, for the debug line. The
   *  two `unmeasured-` rows are the numbers the app shipped with; the rest
   *  name what they were measured on or what forced them. */
  id: 'apple-phone' | 'apple-tablet' | 'unmeasured-touch' | 'unmeasured-desktop' | 'limited';
  /** Where the row's numbers come from, in a form the debug overlay can show
   *  on a device with no console: the device and date they were measured on,
   *  or that no run has replaced the numbers the app shipped with. A phone
   *  showing `unmeasured` is a phone whose numbers are still a guess. */
  provenance: 'measured 2026-08-29 iPhone' | 'measured 2026-08-29 iPad' | 'unmeasured';
  /** The speculative boot warm pulls its bytes into the HTTP cache only,
   *  rather than decoding and uploading maps a session may never visit. */
  cacheOnlyWarm: boolean;
  /** Ladder rungs this profile refuses however much memory is free — the
   *  fill-rate caps below. Keyed by upgrade key; absent means the ladder's
   *  own top, admitted or refused by the memory arithmetic alone. */
  tierCaps: Readonly<Partial<Record<string, TextureTier>>>;
}

const MiB = 1024 * 1024;

/** The unit the sector floors below are counted in: one representative full
 *  set, the largest the app cuts — an Earth day sector, its 2048² colour tile
 *  plus its own copies of the bump and roughness crops. A unit of account, not
 *  any particular set's cost: a night sector carries no crops and comes in
 *  nearer 21 MiB, so a floor of three sets reserves a little more than three
 *  night sectors would need. Whole sets because a fraction of one buys
 *  nothing — half a set admits no tile. Pinned against the streamer's own
 *  layout arithmetic in gpuEnvelope.test.ts, which is what keeps a
 *  transcribed number honest in a file that must not import a body's layout. */
export const SECTOR_SET_FLOOR_UNIT_BYTES = 24_251_050;

/**
 * The one ladder cap that is NOT about memory. Whether a device holds an 8K
 * map is arithmetic — the envelope, the sector floor and what the ladder
 * already holds decide it, and a rung that does not fit is refused wherever
 * it is asked for. Fill rate is a different question, and the cloud deck is
 * where it bites: a full-screen transparent shell at 8K is shaded per pixel
 * over the whole globe, on the devices with the least fill rate to spend.
 * One entry, per class, so the reason it exists stays legible.
 */
export const FILL_RATE_TIER_CAP: Readonly<Record<string, Readonly<Partial<Record<DeviceClass, TextureTier>>>>> = {
  earthClouds: { phone: '4k', tablet: '4k' },
};

/** The fill-rate caps a class carries, in the shape a profile stores. */
export function fillRateTierCaps(cls: DeviceClass): Partial<Record<string, TextureTier>> {
  const caps: Partial<Record<string, TextureTier>> = {};
  for (const [key, byClass] of Object.entries(FILL_RATE_TIER_CAP)) {
    const cap = byClass[cls];
    if (cap) caps[key] = cap;
  }
  return caps;
}

/**
 * The numbers a touch device gets while nobody has measured its platform.
 * An Earth sector set — its 2048x2048 tile plus its copies of the bump and
 * roughness crops — is ~23.1 MiB, so this holds six of them, and never fewer
 * than two whatever the globe maps have taken. Six is what a phone held
 * before the budget was in bytes at all.
 *
 * It asks for tiles later than a desktop, at 1.25 device pixels per texel:
 * a 2-3x display reaches that magnification at nearly twice the distance, and
 * every earlier tile is a 200 KB fetch and 21 MiB of shared memory on the
 * device with the least of both. That is a cost argument rather than a demand
 * one, and it stands only while the cost is unmeasured — which on Android and
 * on everything that is neither Apple nor Android it still is.
 */
export const UNMEASURED_TOUCH_PROFILE: DeviceProfile = {
  id: 'unmeasured-touch',
  provenance: 'unmeasured',
  envelopeBytes: 320 * MiB,
  ceilingBytes: 144 * MiB,
  sectorFloorBytes: 2 * SECTOR_SET_FLOOR_UNIT_BYTES,
  residentCap: 8,
  inflightCap: 1,
  fetchPool: 3,
  wantTexelPx: 1.25,
  releaseTexelPx: 0.8,
  cacheOnlyWarm: true,
  tierCaps: fillRateTierCaps('phone'),
};

/**
 * A desktop's numbers: eleven Earth sector sets under the ceiling and three
 * under the floor, inside an envelope the globe maps share. It asks at 1.0
 * device pixels per texel — a base texel spanning one device pixel is the
 * point where a finer map first shows, and the fetch after that is the only
 * delay.
 */
export const UNMEASURED_DESKTOP_PROFILE: DeviceProfile = {
  id: 'unmeasured-desktop',
  provenance: 'unmeasured',
  envelopeBytes: 768 * MiB,
  ceilingBytes: 256 * MiB,
  sectorFloorBytes: 3 * SECTOR_SET_FLOOR_UNIT_BYTES,
  residentCap: 16,
  inflightCap: 2,
  fetchPool: 6,
  wantTexelPx: 1.0,
  releaseTexelPx: 0.65,
  cacheOnlyWarm: false,
  tierCaps: fillRateTierCaps('desktop'),
};

/**
 * An Apple phone: the desktop numbers, on the evidence below.
 *
 * A page that allocates 4096x2048 RGBA maps with mips — 42.7 MiB each, the
 * app's own rung shape — writing down each attempt before it makes it, so a
 * tab the system kills leaves the size that killed it behind:
 *
 *   iPhone 16 Pro Max class, iOS 18.7 / Safari 26.6, 2026-08-29:
 *   46 maps = 1962.7 MiB, still drawing. No kill was recorded at any size.
 *
 * 1962.7 MiB is six times the 320 MiB this device was being given. There is
 * no headroom fraction to take of a ceiling that was never reached, so the
 * number here is not a fraction of anything: it is the desktop working set,
 * which the device holds several times over.
 *
 * What stays smaller than a desktop's is the cloud deck, and for a reason
 * that is not memory — see FILL_RATE_TIER_CAP.
 */
export const APPLE_PHONE_PROFILE: DeviceProfile = {
  id: 'apple-phone',
  provenance: 'measured 2026-08-29 iPhone',
  envelopeBytes: 768 * MiB,
  ceilingBytes: 256 * MiB,
  sectorFloorBytes: 3 * SECTOR_SET_FLOOR_UNIT_BYTES,
  residentCap: 16,
  inflightCap: 2,
  fetchPool: 6,
  wantTexelPx: 1.0,
  releaseTexelPx: 0.65,
  cacheOnlyWarm: false,
  tierCaps: fillRateTierCaps('phone'),
};

/**
 * An Apple tablet, on the same probe:
 *
 *   iPad Pro 11" class, iPadOS / Safari 26.5, 2026-08-29:
 *   95 maps = 4053.3 MiB — the probe's own 4 GiB stop, reached with the
 *   device showing no sign of giving way. `ceiling-not-reached`.
 *
 * So the tablet's true ceiling is unknown from above rather than from below,
 * and it takes the phone's row for the same reason: a working set the
 * measurement clears by more than five times.
 */
export const APPLE_TABLET_PROFILE: DeviceProfile = {
  id: 'apple-tablet',
  provenance: 'measured 2026-08-29 iPad',
  envelopeBytes: 768 * MiB,
  ceilingBytes: 256 * MiB,
  sectorFloorBytes: 3 * SECTOR_SET_FLOOR_UNIT_BYTES,
  residentCap: 16,
  inflightCap: 2,
  fetchPool: 6,
  wantTexelPx: 1.0,
  releaseTexelPx: 0.65,
  cacheOnlyWarm: false,
  tierCaps: fillRateTierCaps('tablet'),
};

/**
 * A software rasteriser or a device that reports 2 GB of system RAM: two
 * Earth sector sets under the ceiling, one under the floor, and an envelope
 * small enough that the 171 MiB 8K cloud deck fails the ladder's arithmetic
 * without needing a cap of its own. It keeps the conservative want threshold
 * and the cache-only boot warm for the same reason the unmeasured touch rows
 * do: nothing has been measured here either, and this is the class with the
 * least to spend if the guess is wrong.
 */
export const LIMITED_PROFILE: DeviceProfile = {
  id: 'limited',
  provenance: 'unmeasured',
  envelopeBytes: 192 * MiB,
  ceilingBytes: 2 * SECTOR_SET_FLOOR_UNIT_BYTES,
  sectorFloorBytes: 1 * SECTOR_SET_FLOOR_UNIT_BYTES,
  residentCap: 4,
  inflightCap: 1,
  fetchPool: 2,
  wantTexelPx: 1.25,
  releaseTexelPx: 0.8,
  cacheOnlyWarm: true,
  tierCaps: fillRateTierCaps('limited'),
};

/**
 * What a device may spend, by platform family and class. The whole of the
 * device-to-numbers mapping is these twelve cells.
 *
 * | family / class | envelope | tiles | floor | res | flight | fetch | want / rel | boot warm |
 * |---|---|---|---|---|---|---|---|---|
 * | apple / phone   | 768 | 256 | 3 sets | 16 | 2 | 6 | 1.0 / 0.65 | full   |
 * | apple / tablet  | 768 | 256 | 3 sets | 16 | 2 | 6 | 1.0 / 0.65 | full   |
 * | android/ phone  | 320 | 144 | 2 sets |  8 | 1 | 3 | 1.25 / 0.8 | cached |
 * | android/ tablet | 320 | 144 | 2 sets |  8 | 1 | 3 | 1.25 / 0.8 | cached |
 * | other  / phone  | 320 | 144 | 2 sets |  8 | 1 | 3 | 1.25 / 0.8 | cached |
 * | other  / tablet | 320 | 144 | 2 sets |  8 | 1 | 3 | 1.25 / 0.8 | cached |
 * | any    / desktop| 768 | 256 | 3 sets | 16 | 2 | 6 | 1.0 / 0.65 | full   |
 * | any    / limited| 192 |  46 | 1 set  |  4 | 1 | 2 | 1.25 / 0.8 | cached |
 *
 * MiB, except the floors, which are whole Earth sector sets because a
 * fraction of a set admits no tile.
 *
 * The two apple rows carry their measurements in their own comments; every
 * other row is what the app shipped with, kept because no device in that
 * family has been walked up to its ceiling. A row moves when a run says so.
 *
 * On the baseline the app itself holds before any of this is spent — 244 MiB
 * on a phone, read off the boot readout: at the sizes the Apple rows were
 * measured at it does not bear on them, because neither Apple device reached
 * a ceiling for it to be subtracted from. It is still inside the android and
 * other rows implicitly: 320 MiB was chosen against an app that already held
 * roughly that much, and re-deriving those rows without re-measuring them
 * would be arithmetic on an unmeasured number.
 */
export const DEVICE_PROFILES: Readonly<Record<PlatformFamily, Readonly<Record<DeviceClass, DeviceProfile>>>> = {
  apple: {
    phone: APPLE_PHONE_PROFILE,
    tablet: APPLE_TABLET_PROFILE,
    desktop: UNMEASURED_DESKTOP_PROFILE,
    limited: LIMITED_PROFILE,
  },
  android: {
    phone: UNMEASURED_TOUCH_PROFILE,
    tablet: UNMEASURED_TOUCH_PROFILE,
    desktop: UNMEASURED_DESKTOP_PROFILE,
    limited: LIMITED_PROFILE,
  },
  other: {
    phone: UNMEASURED_TOUCH_PROFILE,
    tablet: UNMEASURED_TOUCH_PROFILE,
    desktop: UNMEASURED_DESKTOP_PROFILE,
    limited: LIMITED_PROFILE,
  },
};

/** The row a class and a family land on. `limited` is the same row in every
 *  family: a software rasteriser is a fact about the renderer, and no
 *  platform measurement reaches past it. */
export function deviceProfileFor(cls: DeviceClass, family: PlatformFamily): DeviceProfile {
  return DEVICE_PROFILES[family][cls];
}

// --- The envelope arithmetic -------------------------------------------------
//
// Two managers spend one envelope: the sector streamer's per-slot ledger (with
// reservations, a dwell and a pyramid) and the colour ladder's per-material
// one. They share it through the numbers below rather than through a merged
// allocator — each keeps its own admission rules, and neither can spend the
// other's floor.
//
// The two functions here are the arithmetic; MemoryEnvelope below is what
// callers hold. They stay exported and separately test-pinned because the
// arithmetic is the part with the edge cases — a floor over the ceiling, a
// ladder over the envelope — and it is easier to state as a table than
// through an object's history.

/** What the tiles may hold right now: their own ceiling, or whatever the
 *  envelope leaves over the globe maps, whichever is less — but never below
 *  the floor, which the globe maps are not allowed to take. `liveFloorBytes`
 *  is the floor this session actually owes: zero where no body can want a
 *  tile, so a session with tiles switched off is not asked to reserve
 *  memory for them. */
export function sectorBudgetBytes(
  limits: Pick<SectorStreamerLimits, 'envelopeBytes' | 'ceilingBytes'>,
  ladderBytes: number,
  liveFloorBytes: number,
): number {
  const free = limits.envelopeBytes - Math.max(0, ladderBytes);
  const floor = Math.min(Math.max(0, liveFloorBytes), limits.ceilingBytes);
  return Math.max(0, Math.min(limits.ceilingBytes, Math.max(floor, free)));
}

/** The most the globe maps may hold: the envelope less the tiles' floor. The
 *  admission test every ladder rung passes before it is fetched and again
 *  before it is applied. */
export function ladderCeilingBytes(
  limits: Pick<SectorStreamerLimits, 'envelopeBytes' | 'ceilingBytes'>,
  liveFloorBytes: number,
): number {
  return Math.max(0, limits.envelopeBytes - Math.min(Math.max(0, liveFloorBytes), limits.ceilingBytes));
}

/**
 * The one envelope both allocators spend, as an object with one owner.
 *
 * Two managers share this device's GPU memory — the sector streamer's per-slot
 * ledger and the globe ladder's per-material one — and they meet at exactly
 * two live numbers: what the ladder is holding, and what the tiles are owed.
 * Holding those in one place is what lets either side ask "what may I spend"
 * without knowing how the other is wired, and gives the debug line and the
 * tests a single object instead of a figure assembled at each call site.
 *
 * Who writes what:
 *   ladderBytes  the ladder's live weight, pushed whenever a rung is applied,
 *                released or swapped — synchronously, so no reader can see a
 *                budget that has not been paid for yet.
 *   floorBytes   what the tiles are owed, pushed by the streamer as bodies
 *                register and unregister. Zero while no body can want a tile,
 *                so a session with tiles switched off is never asked to
 *                reserve memory nothing will spend.
 *
 * Neither side can spend the other's floor, and neither allocator's admission
 * rules live here.
 */
export class MemoryEnvelope {
  /** Sector tiles and the ladder's globe maps together may not exceed this. */
  readonly envelopeBytes: number;
  /** What the tiles alone may hold, whatever the envelope leaves free. */
  readonly ceilingBytes: number;
  private ladder = 0;
  private floor = 0;

  constructor(limits: Pick<SectorStreamerLimits, 'envelopeBytes' | 'ceilingBytes'>) {
    this.envelopeBytes = limits.envelopeBytes;
    this.ceilingBytes = limits.ceilingBytes;
  }

  /** GPU bytes the globe ladder's optional maps hold right now. */
  get ladderBytes(): number {
    return this.ladder;
  }

  /** The bytes the globe maps may not take from the tiles. */
  get floorBytes(): number {
    return this.floor;
  }

  setLadderBytes(bytes: number): void {
    this.ladder = Math.max(0, bytes);
  }

  setFloorBytes(bytes: number): void {
    this.floor = Math.max(0, bytes);
  }

  /** What the tiles may hold right now. */
  sectorBudget(): number {
    return sectorBudgetBytes(this, this.ladder, this.floor);
  }

  /** The most the globe maps may hold right now. */
  ladderCeiling(): number {
    return ladderCeilingBytes(this, this.floor);
  }

  /** The whole envelope in one line, for the `?debug=1` readout: on a phone
   *  that overlay is the only console there is. */
  figures(): {
    envelopeBytes: number;
    ceilingBytes: number;
    ladderBytes: number;
    floorBytes: number;
    sectorBudget: number;
    ladderCeiling: number;
  } {
    return {
      envelopeBytes: this.envelopeBytes,
      ceilingBytes: this.ceilingBytes,
      ladderBytes: this.ladder,
      floorBytes: this.floor,
      sectorBudget: this.sectorBudget(),
      ladderCeiling: this.ladderCeiling(),
    };
  }
}

/** One rung the planner may take back, as the ledger sees it. */
export interface ReleaseCandidate {
  /** The handle this describes, for the trace and the warning. */
  id: string;
  /** GPU bytes the rung holds now. */
  heldBytes: number;
  /** GPU bytes the tier below will hold — paid ALONGSIDE the rung from the
   *  moment the swap's fetch decodes until the high map is disposed. */
  lowBytes: number;
  /** Scene distance from the camera. The farthest map is the least missed,
   *  and is the one a return trip re-earns from the cache anyway. */
  distance: number;
}

/**
 * The rung to take back, or null. Farthest first, one at a time: a release is
 * an asynchronous swap that transiently holds the high map AND the low one,
 * so a plan that started several at once would raise the peak it exists to
 * lower. A candidate may only start when that transient itself fits the
 * envelope — the sectors are trimmed synchronously if that is what it takes,
 * which is why the transient is measured against the whole envelope rather
 * than against the ladder's ceiling.
 */
export function planRelease(
  candidates: readonly ReleaseCandidate[],
  ctx: { ladderBytes: number; envelopeBytes: number },
): ReleaseCandidate | null {
  let best: ReleaseCandidate | null = null;
  for (const c of candidates) {
    if (c.heldBytes <= c.lowBytes) continue; // nothing to gain
    if (ctx.ladderBytes + c.lowBytes > ctx.envelopeBytes) continue;
    if (!best || c.distance > best.distance) best = c;
  }
  return best;
}

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
 * Whose platform this is. Android first: an Android UA never claims to be a
 * Mac, and reading it first keeps the Apple test to what it is for. The
 * Apple test is deliberately wider than the classifier's touch tell — a
 * MacBook is an Apple device with no touchscreen at all — because the family
 * says which measurement applies, not which chassis this is.
 */
export function platformFamily(s: DeviceSignals): PlatformFamily {
  if (androidDevice(s)) return 'android';
  if (/iPad|iPhone|iPod|Macintosh|Mac OS X/.test(s.userAgent)) return 'apple';
  if (/^Mac/.test(s.platform) || s.uaPlatform === 'macOS') return 'apple';
  return 'other';
}

/** The numbers a device gets: its class, its family, and the cell where the
 *  two meet. The one call the app makes. */
export function profileForDevice(s: DeviceSignals): DeviceProfile {
  return deviceProfileFor(classifyDevice(s), platformFamily(s));
}

/**
 * The device test the app shipped with, preserved exactly: an iOS user agent,
 * a Mac platform with more than one touch point, or any touchscreen in a
 * window 1024 CSS px or narrower. Nothing calls it any more — the table above
 * chooses the numbers now — and it is kept as the reference the switch was
 * measured against: the tests run both predicates over every recorded device
 * and assert that the set of devices whose numbers move is exactly the
 * accepted list. Note the third arm measures the WINDOW, not the screen,
 * which is why a touch laptop with a narrow window used to be handed a
 * phone's memory.
 */
export function legacyTouchFirst(s: DeviceSignals): boolean {
  return (
    /iPad|iPhone|iPod/.test(s.userAgent) ||
    (s.platform === 'MacIntel' && s.maxTouchPoints > 1) ||
    (s.maxTouchPoints > 0 && s.innerWidth <= 1024)
  );
}

/** The profile the legacy test picked. Reference only; see above. */
export function legacyProfile(s: DeviceSignals): DeviceProfile {
  return legacyTouchFirst(s) ? UNMEASURED_TOUCH_PROFILE : UNMEASURED_DESKTOP_PROFILE;
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
