/**
 * Fetches the bright-star catalog sidecar and installs it in the
 * data/brightStars store. One shared, memoized load: main.ts kicks it at init
 * (so the parse overlaps the solar-system build) and PlanetariumMode.activate
 * awaits the same promise inside its solar-system gate — both ride a single
 * retry ladder, never two.
 *
 * The first attempt drinks the boot fetch-warm started at HTML parse
 * (index.html warms the bin ahead of the texture wave). That request cannot
 * be aborted from here — the inline script owns it — so there is no
 * per-attempt timeout on it; a fetch hung mid-transfer belongs to the same
 * class as a hung boot texture, owned by the loading screen's 15s backstop.
 * What CAN fail fast (dead network, 404, bad bytes) gets two fresh, aborted
 * retries with short backoff; after that the load rejects, activate throws,
 * and the boot error screen shows — a sky with no stars is exactly the
 * half-loaded scene the app promises never to reveal.
 */
import { BRIGHT_STAR_BIN_FILE, parseBrightStarBin, setBrightStarCatalog } from '../data/brightStars';
import { takeBootWarmResponse } from './textureBitmapLoader';
import { debugWarn } from '../../shared/debug';

const RETRY_BACKOFF_MS = [300, 1500];
const RETRY_TIMEOUT_MS = 6000;

let loadPromise: Promise<void> | null = null;

async function fetchCatalogOnce(url: string, attempt: number): Promise<ArrayBuffer> {
  let response: Response;
  if (attempt === 0) {
    response = await (takeBootWarmResponse(url) ?? fetch(url));
  } else {
    // Retries are ours to bound: a stalled retry must not outlive the boot.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), RETRY_TIMEOUT_MS);
    try {
      response = await fetch(url, { signal: abort.signal });
    } finally {
      clearTimeout(timer);
    }
  }
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.arrayBuffer();
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
