/**
 * Fetches the fitted ephemeris (public/ephemeris/ephemeris.v1.bin, 1.4 MB) and
 * installs it in astronomy/fittedEphemeris.ts. One shared, memoized load:
 * main.ts kicks it at init so the fetch overlaps everything else, and
 * PlanetariumMode.activate awaits the same promise in the gate that lifts the
 * loading screen, beside the solar-system build, then samples the orbit lines
 * again: the build may have drawn them from the analytic models, thousands of
 * kilometres off their bodies.
 *
 * While it loads, index.html holds back the boot warm's durable wave (the
 * moons' maps, 10 MB the loading screen does not wait for) so it does not
 * share a slow line with this file; settling, either way, releases it.
 *
 * Unlike the star catalog, a failed load is not a boot error. The analytic
 * models are a complete answer, only a less accurate one (the Moon within
 * 2′, the giant planets within 10′), so the session runs on them — for the
 * whole session: a file that arrived later would move every body at once,
 * mid-flight. So this promise never rejects; it resolves once the file is
 * installed or once the ladder gives up.
 *
 * The first attempt drinks the boot fetch-warm started at HTML parse
 * (index.html). A download is judged by its progress, not by a deadline: on
 * a slow phone link it shares the line with the boot textures, and a fixed
 * timeout would abandon a download that was still arriving and start a
 * second one against it. It is given up when no bytes have arrived for
 * STALL_MS, or past TOTAL_MS (1.4 MB in 2 minutes is 100 kbit/s). On a link
 * that delivers nothing the fallback comes after 15 + 1 + 15 = 31 s; the star
 * catalog's own ladder has failed the boot well before that.
 */
import { FITTED_EPHEMERIS_FILE, parseFittedEphemeris, setFittedEphemeris } from '../../astronomy/fittedEphemeris';
import { claimBootWarmWave, releaseBootWarmWave, takeBootWarmResponse } from './textureBitmapLoader';
import { debugWarn } from '../../shared/debug';

const STALL_MS = 15_000;
const TOTAL_MS = 120_000;
const RETRY_BACKOFF_MS = [1_000];

let loadPromise: Promise<void> | null = null;

function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} after ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/** A response's body, read chunk by chunk: given up only when a chunk takes
 *  longer than STALL_MS to arrive or the whole read passes TOTAL_MS. */
async function readBody(response: Response): Promise<ArrayBuffer> {
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${response.url}`);
  const reader = response.body?.getReader();
  if (!reader) return withDeadline(response.arrayBuffer(), TOTAL_MS, 'ephemeris read took too long');
  const startedMs = performance.now();
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  try {
    for (;;) {
      const { done, value } = await withDeadline(reader.read(), STALL_MS, 'ephemeris download stalled');
      if (done) break;
      chunks.push(value);
      byteCount += value.byteLength;
      if (performance.now() - startedMs > TOTAL_MS) throw new Error('ephemeris download too slow');
    }
  } catch (err) {
    void reader.cancel().catch(() => {});
    throw err;
  }
  const bytes = new Uint8Array(byteCount);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

async function fetchOnce(url: string, attempt: number): Promise<ArrayBuffer> {
  // A retry bypasses the HTTP cache: if the first attempt died parsing a
  // complete-but-corrupt 200, the cache may hold those same bytes.
  const request = attempt === 0
    ? takeBootWarmResponse(url) ?? fetch(url)
    : fetch(url, { cache: 'reload' });
  return readBody(await withDeadline(request, STALL_MS, 'ephemeris request stalled'));
}

/** Load and install the ephemeris. Idempotent; never rejects. Once it has
 *  settled, either way, the boot warm's held durable wave starts (index.html):
 *  until then those maps would only slow this download down. */
export function loadFittedEphemeris(): Promise<void> {
  loadPromise ??= (async () => {
    const url = import.meta.env.BASE_URL + FITTED_EPHEMERIS_FILE;
    // This load now owns the release; index.html's safety timer would fire
    // mid-download on a slow link.
    claimBootWarmWave();
    try {
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
    } finally {
      releaseBootWarmWave();
    }
  })();
  return loadPromise;
}

/** Test seam: forget the memoized load. */
export function resetEphemerisLoaderForTests(): void {
  loadPromise = null;
}
