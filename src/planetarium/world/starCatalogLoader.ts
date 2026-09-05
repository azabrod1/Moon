/**
 * Fetches the bright-star catalog sidecar and installs it in the
 * data/brightStars store. One shared, memoized load: main.ts kicks it at init
 * (so the fetch overlaps the solar-system build) and PlanetariumMode.activate
 * awaits the same promise inside its solar-system gate — both ride a single
 * retry ladder, never two.
 *
 * The first attempt drinks the boot fetch-warm started at HTML parse
 * (index.html warms the bin ahead of the texture wave). That request cannot
 * be aborted from here — the inline script owns it — so it is ABANDONED at
 * its deadline instead (the promise is left to settle into the inline
 * script's own rejection guard) and bounded retries take over. Every attempt
 * carries a deadline, so a dead network reaches the boot error screen in
 * bounded time rather than sitting on "Loading…" forever: the failure UX is
 * activate throwing into the VISIBLE boot error, and a sky with no stars is
 * exactly the half-loaded scene the app promises never to reveal, so the
 * ladder must resolve or reject rather than hang.
 * Worst case ≈ 5 + 0.3 + 3.5 + 1 + 3.5 = 13.3s.
 */
import { BRIGHT_STAR_BIN_FILE, parseBrightStarBin, setBrightStarCatalog } from '../data/brightStars';
import { takeBootWarmResponse } from './textureBitmapLoader';
import { debugWarn } from '../../shared/debug';

const WARM_ATTEMPT_MS = 5000;
const RETRY_TIMEOUT_MS = 3500;
const RETRY_BACKOFF_MS = [300, 1000];

let loadPromise: Promise<void> | null = null;

function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

async function fetchCatalogOnce(url: string, attempt: number): Promise<ArrayBuffer> {
  if (attempt === 0) {
    // Neither request is abortable from here: the warmed one belongs to the
    // inline script, and the plain fetch taken when no warm entry exists is
    // started without a signal. Both are ABANDONED at the deadline — left to
    // settle wherever they settle — and the ladder moves on.
    return withDeadline((async () => {
      const response = await (takeBootWarmResponse(url) ?? fetch(url));
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      return response.arrayBuffer();
    })(), WARM_ATTEMPT_MS, 'star catalog warm fetch');
  }
  // Retries are ours to abort — the signal bounds the body read too. They
  // bypass the HTTP cache ('reload'): when the first attempt died on a
  // PARSE error, its bytes came from a complete-but-corrupt 200 the cache
  // may hold for 10 minutes, and default-mode retries would reparse that
  // same body twice and burn the whole ladder on it.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), RETRY_TIMEOUT_MS);
  try {
    const response = await fetch(url, { cache: 'reload', signal: abort.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return await response.arrayBuffer();
  } finally {
    clearTimeout(timer);
  }
}

/** Load + install the catalog. Idempotent; the memo clears only on final
 *  rejection so a later activation can try again from scratch. */
export function loadBrightStarCatalog(): Promise<void> {
  loadPromise ??= (async () => {
    const url = import.meta.env.BASE_URL + BRIGHT_STAR_BIN_FILE;
    for (let attempt = 0; ; attempt++) {
      try {
        setBrightStarCatalog(parseBrightStarBin(await fetchCatalogOnce(url, attempt)));
        return;
      } catch (err) {
        if (attempt >= RETRY_BACKOFF_MS.length) throw err;
        debugWarn('Star catalog fetch failed; retrying', { attempt, err: String(err) });
        await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS[attempt]));
      }
    }
  })().catch((err) => {
    loadPromise = null;
    throw err;
  });
  return loadPromise;
}

/** Test seam: forget the memoized load. */
export function resetStarCatalogLoaderForTests(): void {
  loadPromise = null;
}
