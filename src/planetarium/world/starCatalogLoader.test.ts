import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadBrightStarCatalog, resetStarCatalogLoaderForTests } from './starCatalogLoader';
import { brightStarCatalog, setBrightStarCatalog } from '../data/brightStars';
import mainSource from '../../main.ts?raw';
import planetariumModeSource from '../PlanetariumMode.ts?raw';
// eslint-style note: the encoder is node-side; tests build tiny valid bins by hand.

/** A minimal valid one-star catalog bin (mirrors the parser fixture). */
function tinyBin(): ArrayBuffer {
  const buf = new ArrayBuffer(12 + 12);
  const view = new DataView(buf);
  new Uint8Array(buf).set(new TextEncoder().encode('MSTR'), 0);
  view.setUint16(4, 1, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, 1, true);
  view.setInt32(12, 1012872, true);
  view.setInt32(16, -167161, true);
  view.setInt16(20, -144, true);
  view.setInt16(22, 1, true);
  return buf;
}

function okResponse(): Response {
  return new Response(tinyBin(), { status: 200 });
}

beforeEach(() => {
  vi.useFakeTimers();
  resetStarCatalogLoaderForTests();
  // Empty the store so success is observable (no stale catalog from other suites).
  setBrightStarCatalog(null as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetStarCatalogLoaderForTests();
});

describe('boot wiring', () => {
  // A real PlanetariumMode in vitest costs a renderer, a DOM id forest and a
  // store — the harness price this repo has twice declined to pay. But the
  // load-before-consume ordering is the module's whole correctness contract,
  // and dropping either side of it would otherwise survive the suite (boots
  // only fail on slow networks, the worst kind of miss). So the two call
  // sites are pinned in source, the same way index.html's warm script is.
  it('activate awaits the catalog inside the solar-system gate', () => {
    expect(planetariumModeSource).toMatch(
      /Promise\.all\(\[\s*createSolarSystem\([\s\S]{0,400}?loadBrightStarCatalog\(\),\s*\]\)/,
    );
  });

  it('main kicks the shared load at init, rejection-guarded', () => {
    expect(mainSource).toContain('loadBrightStarCatalog().catch(() => {})');
  });
});

describe('loadBrightStarCatalog', () => {
  it('drinks the boot warm response and installs the catalog', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('__bootTexWarm', new Map([
      ['/stardata/bright-stars.v1.bin', Promise.resolve(okResponse())],
    ]));
    await loadBrightStarCatalog();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(brightStarCatalog()).toHaveLength(1);
  });

  it('shares one ladder between the init kick and activate', async () => {
    const fetchSpy = vi.fn(async () => okResponse());
    vi.stubGlobal('fetch', fetchSpy);
    const first = loadBrightStarCatalog();
    const second = loadBrightStarCatalog();
    expect(second).toBe(first);
    await first;
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('abandons a hung warm fetch at its deadline and retries fresh', async () => {
    // The warm promise never settles — the inline script's request stalled.
    vi.stubGlobal('__bootTexWarm', new Map([
      ['/stardata/bright-stars.v1.bin', new Promise<Response>(() => {})],
    ]));
    const fetchSpy = vi.fn(async () => okResponse());
    vi.stubGlobal('fetch', fetchSpy);
    const load = loadBrightStarCatalog();
    await vi.advanceTimersByTimeAsync(5000 + 300);
    await load;
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // Retries must bypass the HTTP cache: a complete-but-corrupt 200 can sit
    // there for 10 minutes, and default-mode retries would reparse it.
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cache: 'reload' }),
    );
    expect(brightStarCatalog()).toHaveLength(1);
  });

  it('retries an HTTP failure, then succeeds', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(new Response('gone', { status: 404 }))
      .mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchSpy);
    const load = loadBrightStarCatalog();
    await vi.advanceTimersByTimeAsync(300);
    await load;
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('rejects a non-200 even when its body is a parseable catalog', async () => {
    // Pins the ok-guard itself: a soft-404 or error page that happens to
    // carry valid bytes must not slip through on status alone.
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(new Response(tinyBin(), { status: 500 }))
      .mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchSpy);
    const load = loadBrightStarCatalog();
    await vi.advanceTimersByTimeAsync(300);
    await load;
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('rejects after the ladder and lets a later call start over', async () => {
    const dead = vi.fn(async () => new Response('down', { status: 503 }));
    vi.stubGlobal('fetch', dead);
    const load = loadBrightStarCatalog();
    const settled = load.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(300 + 1000);
    expect(String(await settled)).toContain('HTTP 503');
    expect(dead).toHaveBeenCalledTimes(3);
    // The memo cleared: a recovered network gets a fresh ladder.
    vi.stubGlobal('fetch', vi.fn(async () => okResponse()));
    await loadBrightStarCatalog();
    expect(brightStarCatalog()).toHaveLength(1);
  });

  it('gives up in bounded time, so a dead network reaches the boot error', async () => {
    // Worst case: warm hangs to its 5s deadline, both retries hang to abort.
    vi.stubGlobal('__bootTexWarm', new Map([
      ['/stardata/bright-stars.v1.bin', new Promise<Response>(() => {})],
    ]));
    vi.stubGlobal('fetch', vi.fn(
      (_url: string, opts?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    ));
    const load = loadBrightStarCatalog();
    const settled = load.then(() => 'resolved', () => 'rejected');
    await vi.advanceTimersByTimeAsync(14_000);
    expect(await settled).toBe('rejected');
  });
});
