/**
 * Fetches the fitted ephemeris (public/ephemeris/ephemeris.v1.bin, 1.8 MB) and
 * installs it in astronomy/fittedEphemeris.ts. One shared, memoized load:
 * main.ts kicks it at init so the fetch overlaps everything else, and
 * PlanetariumMode.activate awaits the same promise before it builds the solar
 * system. The build samples every orbit line, so the positions have to be the
 * fitted ones by then, or the lines would be drawn from the analytic models
 * and sit thousands of kilometres off their bodies until the next resample.
 *
 * Unlike the star catalog, a failed load is not a boot error. The analytic
 * models are a complete answer, only a less accurate one (the Moon within
 * 2′, the giant planets within 10′), so the session runs on them — for the
 * whole session: a file that arrived later would move every body at once,
 * mid-flight. So this promise never rejects; it resolves once the file is
 * installed or once the ladder gives up.
 *
 * The first attempt drinks the boot fetch-warm started at HTML parse
 * (index.html), which cannot be aborted from here and is abandoned at its
 * deadline. The deadlines are sized for the file on a slow phone link (1.8 MB
 * at 1 Mbit/s is 15 s), well beyond the star catalog's. Worst case about
 * 25 + 1 + 20 = 46 s before the fallback, on a link that delivers nothing.
 */
import { FITTED_EPHEMERIS_FILE, parseFittedEphemeris, setFittedEphemeris } from '../../astronomy/fittedEphemeris';
import { takeBootWarmResponse } from './textureBitmapLoader';
import { debugWarn } from '../../shared/debug';

const WARM_ATTEMPT_MS = 25_000;
const RETRY_TIMEOUT_MS = 20_000;
const RETRY_BACKOFF_MS = [1_000];

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

async function fetchOnce(url: string, attempt: number): Promise<ArrayBuffer> {
  if (attempt === 0) {
    return withDeadline((async () => {
      const response = await (takeBootWarmResponse(url) ?? fetch(url));
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      return response.arrayBuffer();
    })(), WARM_ATTEMPT_MS, 'ephemeris warm fetch');
  }
  // A retry bypasses the HTTP cache: if the first attempt died parsing a
  // complete-but-corrupt 200, the cache may hold those same bytes.
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

/** Load and install the ephemeris. Idempotent; never rejects. */
export function loadFittedEphemeris(): Promise<void> {
  loadPromise ??= (async () => {
    const url = import.meta.env.BASE_URL + FITTED_EPHEMERIS_FILE;
    for (let attempt = 0; ; attempt++) {
      try {
        setFittedEphemeris(parseFittedEphemeris(await fetchOnce(url, attempt)));
        return;
      } catch (err) {
        if (attempt >= RETRY_BACKOFF_MS.length) {
          debugWarn('Ephemeris unavailable; positions use the analytic models this session', { err: String(err) });
          return;
        }
        debugWarn('Ephemeris fetch failed; retrying', { attempt, err: String(err) });
        await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS[attempt]));
      }
    }
  })();
  return loadPromise;
}
