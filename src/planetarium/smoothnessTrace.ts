/**
 * DEV-only whole-run frame trace: the record the smoothness gate reads.
 *
 * surfacePerf answers "what did this gesture cost" — a 256-sample ring opened
 * around input windows. This answers a different question: across a whole
 * scripted run, was every frame delivered on time, and when one was not, what
 * was happening that frame. So it records EVERY frame into preallocated typed
 * arrays and never allocates on the frame path — a GC pause is one of the
 * faults it exists to catch, so the recorder must not cause one. Only the rare
 * heavy events (a tile materialising, a rung applying, a texture upload) push
 * an object, and that list is bounded.
 *
 * Frames under the arrival veil are recorded and FLAGGED, never dropped: the
 * veil is a sanctioned cut, and a gate has to be able to tell a hitch nobody
 * saw from a hitch on screen. The veil bit is written by the mode inside the
 * same frame it is read for, so a window's first frame is already marked.
 *
 * Arm it with `?smooth=1` — which takes effect at module load, before the
 * first frame, because the cold-boot question starts at frame zero — or with
 * `window.__moon.smoothStart()` for a run that begins later. A production
 * build drops every hook behind import.meta.env.DEV.
 */

/** One-word causes a frame can be tagged with. Order fixes the bit layout. */
export const SMOOTH_CAUSES = [
  'veil', // arrival veil covering the screen: a sanctioned cut
  'tile', // a sector tile materialised into a mesh
  'release', // a sector tile or its meshes were given back
  'rung', // a colour/normal tier swapped onto a material
  'upload', // the warm pump paid a GPU texture upload
  'mark', // a scripted phase marker from the harness
  'warm', // a boot-idle warm-up did something a frame could feel
] as const;
export type SmoothCause = (typeof SMOOTH_CAUSES)[number];

const CAUSE_BIT = new Map<SmoothCause, number>(
  SMOOTH_CAUSES.map((cause, i) => [cause, 1 << i]),
);

/** Decode a frame's cause bitmask back to its one-word names. */
export function causeNames(mask: number): SmoothCause[] {
  const names: SmoothCause[] = [];
  for (let i = 0; i < SMOOTH_CAUSES.length; i++) {
    if (mask & (1 << i)) names.push(SMOOTH_CAUSES[i]);
  }
  return names;
}

/** Heavy one-off events, tied to the frame they landed in. */
export interface SmoothEvent {
  frame: number;
  atMs: number;
  kind: SmoothCause;
  name: string;
  durationMs: number | null;
}

export interface SmoothLongTask {
  atMs: number;
  durationMs: number;
  name: string;
  attribution: string;
}

export interface SmoothTrace {
  environment: Record<string, unknown>;
  startedAtMs: number;
  frames: number;
  dropped: number;
  /** Per-frame columns, all the same length as `frames`. */
  atMs: number[];
  /** raf-to-raf delta; the first frame has no predecessor and reads null. */
  gapMs: (number | null)[];
  causeMask: number[];
  /** JS heap in MiB where the browser exposes it, else null. Sampled. */
  heapMB: (number | null)[];
  events: SmoothEvent[];
  longTasks: SmoothLongTask[];
}

// Five and a half minutes at 120 Hz. Long scenarios pass their own size via
// ?smoothFrames — the recorder stops at the end of the buffer rather than
// wrapping, because a ring would discard the boot and the reveal mark that
// every scenario's "after reveal" window is measured from.
const DEFAULT_MAX_FRAMES = 40_000;
const MAX_EVENTS = 8_000;
const MAX_LONG_TASKS = 2_000;
const HEAP_SAMPLE_EVERY = 15;

interface Recorder {
  startedAtMs: number;
  environment: Record<string, unknown>;
  max: number;
  count: number;
  dropped: number;
  atMs: Float64Array;
  gapMs: Float64Array;
  causeMask: Uint16Array;
  heapMB: Float32Array;
  lastRafMs: number | null;
  events: SmoothEvent[];
  eventsDropped: number;
  longTasks: SmoothLongTask[];
  observer: PerformanceObserver | null;
}

let rec: Recorder | null = null;

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Heap in MiB, or NaN where the browser does not expose it (non-Chromium). */
function heapMiB(): number {
  const mem = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
  const used = mem?.usedJSHeapSize;
  return typeof used === 'number' ? used / (1024 * 1024) : Number.NaN;
}

function observeLongTasks(target: Recorder): PerformanceObserver | null {
  if (typeof PerformanceObserver === 'undefined') return null;
  try {
    const observer = new PerformanceObserver((list) => {
      if (rec !== target) return;
      for (const entry of list.getEntries()) {
        if (target.longTasks.length >= MAX_LONG_TASKS) return;
        // Attribution is usually just the containing frame, but a same-origin
        // script name shows up often enough to be worth carrying.
        const attribution = (entry as unknown as {
          attribution?: { name?: string; containerType?: string; containerName?: string }[];
        }).attribution ?? [];
        target.longTasks.push({
          atMs: round2(entry.startTime - target.startedAtMs),
          durationMs: round2(entry.duration),
          name: entry.name,
          attribution: attribution
            .map((a) => a.containerName || a.containerType || a.name || '')
            .filter(Boolean)
            .join(',') || 'unknown',
        });
      }
    });
    observer.observe({ type: 'longtask', buffered: true });
    return observer;
  } catch {
    // longtask is unsupported on some engines; the rest of the trace stands.
    return null;
  }
}

/** Arm the recorder. Any run already in progress is discarded. */
export function smoothTraceStart(
  environment: Record<string, unknown> = {},
  maxFrames = DEFAULT_MAX_FRAMES,
): boolean {
  if (!import.meta.env.DEV) return false;
  const max = Math.max(1, Math.min(maxFrames, 400_000));
  smoothTraceClear();
  const target: Recorder = {
    startedAtMs: performance.now(),
    environment,
    max,
    count: 0,
    dropped: 0,
    atMs: new Float64Array(max),
    gapMs: new Float64Array(max),
    causeMask: new Uint16Array(max),
    heapMB: new Float32Array(max),
    lastRafMs: null,
    events: [],
    eventsDropped: 0,
    longTasks: [],
    observer: null,
  };
  target.heapMB.fill(Number.NaN);
  rec = target;
  target.observer = observeLongTasks(target);
  return true;
}

export function smoothTraceClear(): void {
  rec?.observer?.disconnect();
  rec = null;
}

/** Whether a run is recording — the cheap guard every hook site can call. */
export function smoothTraceArmed(): boolean {
  return rec !== null;
}

/**
 * Open a frame slot. Call once per requestAnimationFrame, first thing, with
 * the raf timestamp: the gap between consecutive raf timestamps is what the
 * compositor actually delivered, and reading performance.now() instead would
 * fold this recorder's own position in the frame into the number.
 */
export function smoothTraceFrameStart(rafTimestampMs: number): void {
  if (!import.meta.env.DEV) return;
  const target = rec;
  if (!target) return;
  if (target.count >= target.max) {
    target.dropped++;
    return;
  }
  const i = target.count++;
  target.atMs[i] = rafTimestampMs - target.startedAtMs;
  target.gapMs[i] = target.lastRafMs === null ? Number.NaN : rafTimestampMs - target.lastRafMs;
  target.lastRafMs = rafTimestampMs;
  target.causeMask[i] = 0;
  if (i % HEAP_SAMPLE_EVERY === 0) target.heapMB[i] = heapMiB();
}

/** Tag the open frame. Cheap enough to call unconditionally from a hot path. */
export function smoothTraceFlag(cause: SmoothCause): void {
  if (!import.meta.env.DEV) return;
  const target = rec;
  if (!target || target.count === 0) return;
  target.causeMask[target.count - 1] |= CAUSE_BIT.get(cause) ?? 0;
}

/** Write the arrival veil bit for the open frame (the mode calls this every
 *  frame, so a veil window's first and last frames are both exact). */
export function smoothTraceVeil(up: boolean): void {
  if (!import.meta.env.DEV || !up) return;
  smoothTraceFlag('veil');
}

/**
 * Record a heavy one-off inside the open frame: the flag makes it show up in
 * the frame's cause list, the event carries what and how long. Allocates one
 * small object, so only rare events may call it.
 */
export function smoothTraceEvent(
  kind: SmoothCause,
  name: string,
  durationMs: number | null = null,
): void {
  if (!import.meta.env.DEV) return;
  const target = rec;
  if (!target) return;
  smoothTraceFlag(kind);
  if (target.events.length >= MAX_EVENTS) {
    target.eventsDropped++;
    return;
  }
  target.events.push({
    frame: Math.max(0, target.count - 1),
    atMs: round2(performance.now() - target.startedAtMs),
    kind,
    name,
    durationMs: durationMs === null ? null : round2(durationMs),
  });
}

/** Read the run without ending it. */
export function smoothTraceSnapshot(): SmoothTrace | null {
  const target = rec;
  if (!target) return null;
  const n = target.count;
  const atMs: number[] = new Array(n);
  const gapMs: (number | null)[] = new Array(n);
  const causeMask: number[] = new Array(n);
  const heapMB: (number | null)[] = new Array(n);
  for (let i = 0; i < n; i++) {
    atMs[i] = round2(target.atMs[i]);
    gapMs[i] = Number.isNaN(target.gapMs[i]) ? null : round2(target.gapMs[i]);
    causeMask[i] = target.causeMask[i];
    heapMB[i] = Number.isNaN(target.heapMB[i]) ? null : round2(target.heapMB[i]);
  }
  return {
    environment: { ...target.environment, eventsDropped: target.eventsDropped },
    startedAtMs: round2(target.startedAtMs),
    frames: n,
    dropped: target.dropped,
    atMs,
    gapMs,
    causeMask,
    heapMB,
    events: target.events.slice(),
    longTasks: target.longTasks.slice(),
  };
}

/** Read the run and disarm. */
export function smoothTraceStop(): SmoothTrace | null {
  const snapshot = smoothTraceSnapshot();
  smoothTraceClear();
  return snapshot;
}

// --- Pure summary helpers. The gate tool does its own scoring in Node; these
// exist so the same definitions can be asserted in unit tests and read back
// in-page during a manual session.

export interface SmoothWindow {
  from: number;
  to: number;
}

/**
 * Contiguous runs of veiled frames, dilated by one frame on each side.
 *
 * The dilation is not slack for its own sake: the veil is raised and lowered
 * between frames, so the frame that straddles a transition is half covered
 * and cannot be scored either way honestly.
 */
export function veilWindows(causeMask: readonly number[]): SmoothWindow[] {
  const veilBit = CAUSE_BIT.get('veil') ?? 0;
  const windows: SmoothWindow[] = [];
  let start = -1;
  for (let i = 0; i <= causeMask.length; i++) {
    const veiled = i < causeMask.length && (causeMask[i] & veilBit) !== 0;
    if (veiled && start === -1) start = i;
    if (!veiled && start !== -1) {
      windows.push({ from: Math.max(0, start - 1), to: Math.min(causeMask.length - 1, i) });
      start = -1;
    }
  }
  return windows;
}

/** Whether a frame index falls inside any window. */
export function inWindows(index: number, windows: readonly SmoothWindow[]): boolean {
  return windows.some((w) => index >= w.from && index <= w.to);
}

export interface SmoothSummary {
  frames: number;
  scored: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  over33: number;
  over50: number;
}

/** Percentile by nearest-rank on a sorted ascending copy. */
export function percentile(sortedAsc: readonly number[], fraction: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.ceil(fraction * sortedAsc.length);
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, rank - 1))];
}

/**
 * Score the gaps that were on screen. Veiled frames are excluded, not because
 * they are cheap but because nothing was being shown through them.
 */
export function summarizeFrames(
  gapMs: readonly (number | null)[],
  causeMask: readonly number[],
): SmoothSummary {
  const windows = veilWindows(causeMask);
  const scored: number[] = [];
  for (let i = 0; i < gapMs.length; i++) {
    const gap = gapMs[i];
    if (gap === null || inWindows(i, windows)) continue;
    scored.push(gap);
  }
  const sorted = scored.slice().sort((a, b) => a - b);
  const sum = scored.reduce((acc, v) => acc + v, 0);
  return {
    frames: gapMs.length,
    scored: scored.length,
    meanMs: scored.length ? round2(sum / scored.length) : 0,
    p50Ms: round2(percentile(sorted, 0.5)),
    p95Ms: round2(percentile(sorted, 0.95)),
    p99Ms: round2(percentile(sorted, 0.99)),
    maxMs: round2(sorted.at(-1) ?? 0),
    over33: scored.filter((v) => v > 33).length,
    over50: scored.filter((v) => v > 50).length,
  };
}

// Arm at module load when asked, so the cold-boot run has frame zero. Reading
// the flag here rather than from the dev bridge is the whole point: the bridge
// is installed several async steps into init, long after the first frame.
if (import.meta.env.DEV && typeof location !== 'undefined') {
  const params = new URLSearchParams(location.search);
  if (params.get('smooth') === '1') {
    const asked = Number(params.get('smoothFrames'));
    smoothTraceStart(
      { armedBy: 'url', userAgent: navigator.userAgent },
      Number.isFinite(asked) && asked > 0 ? asked : DEFAULT_MAX_FRAMES,
    );
  }
}
