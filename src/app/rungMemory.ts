/**
 * The rung Dynamic remembers from one boot to the next.
 *
 * On a display whose tick is not finer than 60 fps only the GPU clock can take
 * a rung above Medium (app/resolutionController.ts), and it earns each one
 * climb by climb: about half a minute in a still view, longer while the view
 * moves. A rung the clock verified and then held for a minute on this device
 * is a fact about the device, so the next boot is told it and may climb
 * straight there once its own first reading at Medium says the room is there,
 * instead of earning it again one rung at a time. The controller decides what
 * is worth remembering and when a boot may use it; this module is where it is
 * kept, whether a stored entry still describes the machine in front of it, and
 * the mirror that writes the controller's answer back.
 *
 * ONE standalone synchronous localStorage key, in the shape of the Graphics
 * quality setting (app/qualitySetting.ts), and NOT part of the journey save:
 * New Journey must not make the device forget what it can draw. Every access
 * is wrapped, because localStorage throws in private mode and a remembered
 * rung is never worth a boot failure; an entry that cannot be read is null.
 *
 * **What an entry holds.** The scene ratio of the rung, and what the device
 * looked like when it held it: the display's calibrated tick, the output
 * ratio, the canvas's device pixels at Medium, and the GPU's renderer string —
 * a laptop with two GPUs, or one with a GPU in an enclosure, is another
 * device. How the device's frames grow with pixels is NOT kept: a boot learns
 * that for itself, and a pessimistic growth carried over would close the
 * cheaper path a boot has for its first climbs.
 *
 * **Refused, or deleted.** A boot whose configuration differs — another tick
 * (a Mac moved between its own panel and a 60 Hz monitor, Low Power Mode at
 * 30 Hz), another output ratio, a canvas more than 5 % larger (the phone's
 * toolbar moves the height 10–15 %), a ladder without that rung, another GPU —
 * refuses the entry and KEEPS it, because the configuration it describes will
 * come back. Only an entry that is wrong for every boot is deleted: another
 * version, older than thirty days or dated more than a day ahead, unreadable,
 * or still on trial (below).
 *
 * **The trial.** The risk in climbing straight to a sharper rung is a device
 * that hangs or is killed there before the rung can fail by measurement. So
 * the entry is written with `trial: true` at the moment the remembered climb
 * is applied, and the flag is cleared when the rung has been held for the
 * controller's minute, or whenever the page stops drawing cleanly — hidden
 * (`visibilitychange`) or unloaded (`pagehide`) — and marked again when it is
 * shown while the trial still stands, a restore from the back-forward cache
 * included. Hidden counts because iOS Safari evicts a background tab without
 * a `pagehide`; a page that hangs dispatches neither event, so the flag is
 * still there for the next boot. A measured failure inside that minute
 * deletes the entry, and so does the WebGL context lost, or the GPU clock
 * pricing itself off, while the page is visible and the flag stands — on
 * WebKit a GPU hang usually arrives as a context loss with the page alive on a
 * dead canvas and a reload to follow, and a rung too heavy to time prices the
 * sensor out before its readings can hand the rung back; lost while hidden,
 * it is the system reclaiming a background tab's GPU, and the entry is kept. A boot that finds the flag still set refuses and deletes
 * the entry: the boot before it neither held the rung nor stopped cleanly. A
 * trial that ends without a verdict — a pin, a level change, a new budget, a
 * lifecycle event the rung was not re-earned after, readings that never came
 * — leaves the flag for the next hide or unload to clear.
 *
 * **The mirror** is told once a frame and does nothing unless the controller's
 * `memoryVersion` moved; it compares with its own last write, never with
 * storage, and the first rung held in a session is written even when it equals
 * what is stored, so the entry's date follows the device. `stop` ends its
 * writes for the session — a DEV harness that fed the controller synthetic
 * time must not teach the next boot what that time said.
 *
 * `?rungmemory=0` turns it off. So does any URL switch that changes what a
 * pixel costs or holds the ratio for a measurement, and a `?quality=` word
 * other than dynamic: a rung remembered under them describes another
 * configuration, and a run under them must not teach the next plain boot.
 */

import type { SeedOutcome } from './resolutionController';

/** The one key the entry lives under. */
export const RUNG_MEMORY_KEY = 'planetarium-dynamic-rung';

/** What this build reads and writes. */
export const RUNG_MEMORY_VERSION = 1;

/** An entry this old describes a device that may have changed since. */
export const RUNG_MEMORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** An entry dated further ahead than this was written by a clock that was
 *  wrong, and its age cannot be judged. */
export const RUNG_MEMORY_FUTURE_MS = 24 * 60 * 60 * 1000;

/** How far the calibrated tick may be from the entry's. */
export const RUNG_MEMORY_TICK_TOLERANCE = 0.05;

/** How much larger the canvas may be than the entry's. A smaller one is less
 *  work, so it is never refused. */
export const RUNG_MEMORY_PIXELS_TOLERANCE = 1.05;

/** What a stored entry holds. */
export interface RungMemoryEntry {
  v: number;
  /** The scene ratio of the rung. */
  ratio: number;
  /** The display's calibrated tick, ms. */
  tick: number;
  /** The output ratio. */
  outputRatio: number;
  /** The canvas's device pixels at Medium: CSS width × height × output ratio². */
  pixels: number;
  /** The GPU's renderer string. */
  renderer: string;
  /** When it was written, ms since the epoch. */
  at: number;
  /** The rung is being tried by a boot that has not held it yet. */
  trial: boolean;
}

/** The device as a boot finds it: everything an entry is checked against. */
export interface RungMemoryConfig {
  tick: number;
  outputRatio: number;
  pixels: number;
  renderer: string;
}

export interface RungMemoryFacts extends RungMemoryConfig {
  /** ms since the epoch. */
  nowMs: number;
  /** The ladder Dynamic slides over, ascending, and which rung is Medium. */
  ladder: readonly number[];
  mediumIndex: number;
}

export type RungMemoryVerdict = { ok: true } | { ok: false; why: string; discard: boolean };

/** The three calls made of a store, so a test can supply one. */
export interface RungMemoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function webStorage(): RungMemoryStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function positive(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x > 0;
}

/** An entry out of a stored string, or null where it is not one. */
function parseEntry(raw: string): RungMemoryEntry | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (!positive(o.v) || !positive(o.ratio) || !positive(o.tick) || !positive(o.outputRatio)
    || !positive(o.pixels) || !positive(o.at)) return null;
  if (typeof o.renderer !== 'string' || typeof o.trial !== 'boolean') return null;
  return {
    v: o.v,
    ratio: o.ratio,
    tick: o.tick,
    outputRatio: o.outputRatio,
    pixels: o.pixels,
    renderer: o.renderer,
    at: o.at,
    trial: o.trial,
  };
}

/** What is stored: the entry, or null where there is none or it cannot be
 *  read — and `malformed` where something was stored that is not an entry,
 *  which the caller deletes. */
export function readRungMemory(storage: RungMemoryStorage | null = null): { entry: RungMemoryEntry | null; malformed: boolean } {
  const store = storage ?? webStorage();
  if (store === null) return { entry: null, malformed: false };
  let raw: string | null;
  try {
    raw = store.getItem(RUNG_MEMORY_KEY);
  } catch {
    return { entry: null, malformed: false };
  }
  if (raw === null) return { entry: null, malformed: false };
  const entry = parseEntry(raw);
  return { entry, malformed: entry === null };
}

/** Save an entry. False where it was not saved: a number that is not a
 *  finite positive one (never written, so nothing unreadable is ever stored),
 *  or a store that refused it. */
export function writeRungMemory(entry: RungMemoryEntry, storage: RungMemoryStorage | null = null): boolean {
  if (!positive(entry.v) || !positive(entry.ratio) || !positive(entry.tick) || !positive(entry.outputRatio)
    || !positive(entry.pixels) || !positive(entry.at) || typeof entry.renderer !== 'string') return false;
  const store = storage ?? webStorage();
  if (store === null) return false;
  try {
    store.setItem(RUNG_MEMORY_KEY, JSON.stringify({
      v: entry.v,
      ratio: entry.ratio,
      tick: entry.tick,
      outputRatio: entry.outputRatio,
      pixels: entry.pixels,
      renderer: entry.renderer,
      at: entry.at,
      trial: entry.trial === true,
    }));
    return true;
  } catch {
    return false;
  }
}

/** Forget the entry. */
export function clearRungMemory(storage: RungMemoryStorage | null = null): void {
  const store = storage ?? webStorage();
  if (store === null) return;
  try {
    store.removeItem(RUNG_MEMORY_KEY);
  } catch {
    /* ignore: private browsing */
  }
}

/**
 * Whether a stored entry may be used by this boot. A refusal says why, and
 * `discard` says whether the entry is wrong for every boot (delete it) or only
 * for this configuration (keep it).
 */
export function rungMemoryApplies(entry: RungMemoryEntry, facts: RungMemoryFacts): RungMemoryVerdict {
  if (entry.v !== RUNG_MEMORY_VERSION) return { ok: false, why: 'saved by another version', discard: true };
  if (facts.nowMs - entry.at > RUNG_MEMORY_MAX_AGE_MS) return { ok: false, why: 'older than 30 days', discard: true };
  if (entry.at > facts.nowMs + RUNG_MEMORY_FUTURE_MS) return { ok: false, why: 'dated in the future', discard: true };
  if (entry.trial) return { ok: false, why: 'the last boot ended while trying that rung', discard: true };
  if (entry.renderer !== facts.renderer) return { ok: false, why: 'another GPU', discard: false };
  if (Math.abs(entry.outputRatio - facts.outputRatio) > 1e-6) return { ok: false, why: 'another pixel ratio', discard: false };
  if (Math.abs(entry.tick - facts.tick) > RUNG_MEMORY_TICK_TOLERANCE * facts.tick) {
    return { ok: false, why: 'another refresh rate', discard: false };
  }
  if (facts.pixels > entry.pixels * RUNG_MEMORY_PIXELS_TOLERANCE) return { ok: false, why: 'a larger window', discard: false };
  const at = facts.ladder.findIndex((r) => Math.abs(r - entry.ratio) < 1e-6);
  if (at < 0 || at <= facts.mediumIndex) return { ok: false, why: 'not a rung above Medium here', discard: false };
  return { ok: true };
}

/** The URL switches that change what a pixel costs, or hold the ratio for a
 *  measurement. */
const MEASUREMENT_KEYS = ['msaa', 'fused', 'alloc', 'canvasaa', 'perfoff', 'ratio', 'refresh', 'envelope', 'upscale', 'sectors', 'synth'];

/** Why this boot's URL keeps the rung memory out of it — the kill switch, a
 *  measurement or render-path switch, or a fixed level — or null. */
export function rungMemoryUrlBlock(search: string): string | null {
  const params = new URLSearchParams(search);
  if (params.get('rungmemory') === '0') return 'turned off by ?rungmemory=0';
  for (const key of MEASUREMENT_KEYS) {
    if (params.has(key)) return `?${key} is in the URL`;
  }
  if (params.get('gpuclock') === '0') return '?gpuclock=0 is in the URL';
  const quality = params.get('quality');
  if (quality !== null && quality.trim().toLowerCase() !== 'dynamic') return `?quality=${quality} is in the URL`;
  return null;
}

/** What the mirror reads off the controller once a frame. */
export interface RungMemorySource {
  readonly memoryVersion: number;
  readonly memory: { readonly ratio: number } | null;
  readonly seedOutcome: SeedOutcome | null;
}

/** What one `sync` did to the store. */
export type RungMemorySync = { wrote: number } | 'dropped' | 'passed' | null;

/**
 * Writes the controller's answer back to the store. Told once a frame; does
 * nothing at all unless the controller's `memoryVersion` moved.
 */
export class RungMemoryMirror {
  private seenVersion = 0;
  private seenOutcome: SeedOutcome | null = null;
  /** The ratio this session last wrote, or null before its first write. */
  private lastWritten: number | null = null;
  /** The entry as written with the trial flag, while the flag stands. */
  private trialEntry: RungMemoryEntry | null = null;
  /** The entry the trial was marked with, kept while the flag is lifted for a
   *  hidden page so it can be marked again when the page is shown. */
  private trialBase: RungMemoryEntry | null = null;
  /** Nothing is written for the rest of the session. */
  private stopped = false;
  writes = 0;

  constructor(private readonly storage: RungMemoryStorage | null = null) {}

  /** The trial flag is standing in the store. */
  get onTrial(): boolean {
    return this.trialEntry !== null;
  }

  /**
   * Once a frame. `config` is asked only when an entry is written, and `wallMs`
   * is the entry's date. Returns what was done to the store.
   */
  sync(source: RungMemorySource, config: () => RungMemoryConfig, wallMs: number): RungMemorySync {
    if (this.stopped) return null;
    const version = source.memoryVersion;
    if (version === this.seenVersion) return null;
    this.seenVersion = version;
    const outcome = source.seedOutcome;
    const newOutcome = outcome !== this.seenOutcome;
    this.seenOutcome = outcome;
    if (newOutcome && outcome === 'dropped') {
      // A measured failure while the remembered rung was on trial: the entry
      // is wrong for this device as it is now.
      clearRungMemory(this.storage);
      this.trialEntry = null;
      this.trialBase = null;
      this.lastWritten = null;
      return 'dropped';
    }
    const memory = source.memory;
    if (memory !== null && memory.ratio !== this.lastWritten) {
      const entry: RungMemoryEntry = {
        v: RUNG_MEMORY_VERSION,
        ratio: memory.ratio,
        ...config(),
        at: wallMs,
        trial: false,
      };
      if (writeRungMemory(entry, this.storage)) this.writes++;
      this.lastWritten = memory.ratio;
      this.trialEntry = null;
      if (outcome !== 'applied') this.trialBase = null;
      return { wrote: memory.ratio };
    }
    if (newOutcome && outcome === 'passed') {
      this.trialBase = null;
      if (this.trialEntry !== null) {
        // Held for the minute: whatever else is stored stands, off trial.
        this.clearTrial();
        return 'passed';
      }
    }
    return null;
  }

  /** The remembered climb was applied: until it is held or the page unloads
   *  cleanly, a boot that finds this refuses and deletes the entry. False where
   *  the store refused the write. */
  markTrial(entry: RungMemoryEntry): boolean {
    if (this.stopped) return false;
    const onTrial = { ...entry, trial: true };
    this.trialEntry = onTrial;
    this.trialBase = { ...entry, trial: false };
    const wrote = writeRungMemory(onTrial, this.storage);
    if (wrote) this.writes++;
    return wrote;
  }

  /** The page stopped drawing cleanly — hidden, or unloaded. Whatever the
   *  controller decided since the last frame is written first — a remembered
   *  rung that failed just before is still deleted, not saved off trial — and
   *  then the trial flag goes, and nothing else changes. */
  hide(source: RungMemorySource, config: () => RungMemoryConfig, wallMs: number): void {
    if (this.stopped) return;
    this.sync(source, config, wallMs);
    if (this.trialEntry !== null) this.clearTrial();
  }

  /** The page is shown again — from a hidden tab or the back-forward cache —
   *  with the remembered rung still on trial: marked again. True where it was. */
  shown(source: RungMemorySource): boolean {
    if (this.stopped || this.trialEntry !== null || this.trialBase === null) return false;
    if (source.seedOutcome !== 'applied') {
      this.trialBase = null;
      return false;
    }
    return this.markTrial(this.trialBase);
  }

  /**
   * The rung gave out in a way the controller cannot call a verdict on: the
   * WebGL context was lost, or the GPU clock priced itself off. With the trial
   * flag standing and the page visible that is how a GPU hang or a rung too
   * heavy to time arrives, and the entry goes for good; while hidden it is the
   * system reclaiming a background tab's GPU, and the entry stays. Null where
   * no trial flag stands.
   *
   * Decided on the flag this mirror wrote, never on the controller's outcome:
   * a hang stalls the frames for seconds before the context is declared lost,
   * the first frame after the stall reads as silence, and the controller has
   * already ended the trial with no verdict by the time the loss arrives —
   * while the flag it leaves standing is exactly what says the rung was never
   * cleared.
   */
  lostAtRung(visible: boolean): 'deleted' | 'kept' | null {
    if (this.stopped) return null;
    if (!visible) return this.trialEntry !== null || this.trialBase !== null ? 'kept' : null;
    if (this.trialEntry === null) return null;
    clearRungMemory(this.storage);
    this.trialEntry = null;
    this.trialBase = null;
    this.lastWritten = null;
    // Nothing this session draws on the lost context can vouch for anything.
    this.stopped = true;
    return 'deleted';
  }

  /** No writes for the rest of the session, a `forget` excepted. A trial flag
   *  standing when it stops is not lifted by a hide or an unload either, so the
   *  next boot deletes that entry — the DEV injection that stops it leaves the
   *  memory in a state no real session reaches. */
  stop(): void {
    this.stopped = true;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  /** Delete the entry. Nothing is written again until the controller's memory
   *  moves, and then even a ratio this session wrote before. */
  forget(source: RungMemorySource): void {
    clearRungMemory(this.storage);
    this.trialEntry = null;
    this.trialBase = null;
    this.lastWritten = null;
    this.seenVersion = source.memoryVersion;
    this.seenOutcome = source.seedOutcome;
  }

  private clearTrial(): void {
    const entry = this.trialEntry;
    this.trialEntry = null;
    if (entry !== null && writeRungMemory({ ...entry, trial: false }, this.storage)) this.writes++;
  }
}
