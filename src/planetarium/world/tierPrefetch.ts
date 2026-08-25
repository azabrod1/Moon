/**
 * Opportunistic HTTP-cache warm-up for the few files an arrival veil would
 * otherwise wait on. Profiling the "Preparing <body>…" hold showed one
 * dominant cost: the destination's first colour-tier fetch, 400–900ms on
 * ordinary broadband — long enough that the veil's bounded hold often expires
 * and the body reveals on its boot map anyway. Every other covered phase
 * (moon paint, teleport, uploads) is tens of milliseconds. Fetching those few
 * files once, after boot has settled, turns every later first-visit tier
 * fetch into a disk-cache (or service-worker) hit, so the veil lifts at its
 * minimum dwell instead of its network-bound worst.
 *
 * Purely opportunistic, by design:
 * - A failure skips the file, silently and without retry. The arrival path
 *   keeps its own fetch and retry ladder; this module only makes that fetch
 *   cheap when it worked.
 * - Bytes land in the HTTP cache only — nothing is decoded or uploaded here,
 *   so it costs no memory and can never change what is on screen.
 * - Sequential, low-priority, and pausable, so it never competes with an
 *   arrival's own fetch for bandwidth.
 * - Skipped entirely on connections that asked for restraint (saveData, 2g).
 */

export interface CachePrefetchHandle {
  /** Resolves when the sweep finishes or is cancelled; never rejects. */
  readonly done: Promise<void>;
  /** Stop before the next file and abort the one in flight. */
  cancel(): void;
}

/** Connection facts the prefetch gate reads (navigator.connection's shape). */
export interface ConnectionHints {
  saveData?: boolean;
  effectiveType?: string;
}

/** Whether a connection admits speculative fetching at all. */
export function cachePrefetchAllowed(conn: ConnectionHints | undefined): boolean {
  if (!conn) return true; // no hints — assume an unmetered connection
  if (conn.saveData) return false;
  return !(conn.effectiveType ?? '').includes('2g'); // 'slow-2g' and '2g'
}

const PAUSE_POLL_MS = 500;

export function startCachePrefetch(opts: {
  urls: readonly string[];
  /** Live gate polled between files: true = hold off for now. */
  shouldPause?: () => boolean;
  /** Delay before the first fetch, so boot's tail (service-worker install,
   *  deferred UI) keeps the network to itself. */
  startDelayMs?: number;
  /** Test seams. */
  fetchFn?: (url: string, init: { signal: AbortSignal }) => Promise<{ arrayBuffer(): Promise<unknown> }>;
  delayFn?: (ms: number) => Promise<void>;
}): CachePrefetchHandle {
  const {
    urls,
    shouldPause = () => false,
    startDelayMs = 2000,
    delayFn = (ms) => new Promise((r) => setTimeout(r, ms)),
    fetchFn = (url, init) =>
      // 'low' keeps these behind anything the app asks for on its own behalf.
      fetch(url, { ...init, priority: 'low' } as RequestInit),
  } = opts;
  const abort = new AbortController();
  let cancelled = false;
  const done = (async () => {
    if (startDelayMs > 0) await delayFn(startDelayMs);
    for (const url of urls) {
      while (!cancelled && shouldPause()) await delayFn(PAUSE_POLL_MS);
      if (cancelled) return;
      try {
        // Read the body to completion — a response abandoned mid-stream may
        // never be committed to the cache, which is the whole point here.
        await (await fetchFn(url, { signal: abort.signal })).arrayBuffer();
      } catch {
        // Offline, aborted, 404 — all equally fine to skip: the arrival path
        // owns real fetching and real retries.
      }
    }
  })();
  return {
    done,
    cancel() {
      cancelled = true;
      abort.abort();
    },
  };
}
