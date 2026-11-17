import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFittedEphemeris, resetEphemerisLoaderForTests } from './ephemerisLoader';
import { fittedEphemerisInstalled, setFittedEphemeris } from '../../astronomy/fittedEphemeris';
import { installFittedEphemerisFromDisk } from '../../astronomy/fittedEphemerisTestFile';
import mainSource from '../../main.ts?raw';
import planetariumModeSource from '../PlanetariumMode.ts?raw';

const URL_PATH = '/ephemeris/ephemeris.v1.bin';

/** A minimal valid v1 file: one body, one interval of two coefficients. */
function tinyFile(): ArrayBuffer {
  const name = new TextEncoder().encode('Moon');
  const headerBytes = 8 + 1 + name.length + 30;
  const dataOffset = Math.ceil(headerBytes / 8) * 8;
  const buffer = new ArrayBuffer(dataOffset + 3 * 16);
  const view = new DataView(buffer);
  new Uint8Array(buffer).set(new TextEncoder().encode('MEPH'), 0);
  view.setUint16(4, 1, true);
  view.setUint16(6, 1, true);
  view.setUint8(8, name.length);
  new Uint8Array(buffer).set(name, 9);
  const cursor = 9 + name.length;
  view.setFloat64(cursor, 2460000.5, true);
  view.setFloat64(cursor + 8, 16, true);
  view.setUint32(cursor + 16, 1, true);
  view.setUint16(cursor + 20, 2, true);
  view.setFloat32(cursor + 22, 0.5, true);
  view.setUint32(cursor + 26, dataOffset, true);
  return buffer;
}

beforeEach(() => {
  resetEphemerisLoaderForTests();
  setFittedEphemeris(null);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetEphemerisLoaderForTests();
  // Every other suite runs on the shipped file (fittedEphemerisSetup.ts).
  installFittedEphemerisFromDisk();
});

describe('boot wiring', () => {
  // Pinned in source, as the star catalog's are: nothing may draw before the
  // file is in, so the gate that lifts the loading screen waits for it, and
  // the orbit lines the build sampled beside it are sampled again after it.
  it('waits for the ephemeris inside the gate, then resamples the orbit lines', () => {
    expect(planetariumModeSource).toMatch(
      /Promise\.all\(\[\s*createSolarSystem\([\s\S]{0,400}?loadBrightStarCatalog\(\),\s*loadFittedEphemeris\(\),\s*\]\);\s*(?:\/\/[^\n]*\n\s*)*resampleOrbitLines\(solarSystem, this\.layoutMode, initialWorldUtcMs\);/,
    );
  });

  it('main kicks the shared load at init', () => {
    expect(mainSource).toContain('void loadFittedEphemeris();');
  });
});

describe('loadFittedEphemeris', () => {
  it('drinks the boot warm response and installs the file', async () => {
    const fetchSpy = vi.fn();
    const release = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('__bootTexWarm', new Map([[URL_PATH, Promise.resolve(new Response(tinyFile()))]]));
    vi.stubGlobal('__bootWarmRelease', release);
    await loadFittedEphemeris();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fittedEphemerisInstalled()).toBe(true);
    // The held durable wave starts once the ephemeris is in.
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('resolves without installing when every attempt fails, so the session runs on the analytic models', async () => {
    const fetchSpy = vi.fn(async () => new Response('nope', { status: 503 }));
    const release = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('__bootWarmRelease', release);
    vi.useFakeTimers();
    const load = loadFittedEphemeris();
    await vi.runAllTimersAsync();
    await expect(load).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fittedEphemerisInstalled()).toBe(false);
    // Given up, the held wave starts all the same.
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('refuses a truncated file rather than installing a shorter ephemeris', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(tinyFile().slice(0, 40))));
    vi.useFakeTimers();
    const load = loadFittedEphemeris();
    await vi.runAllTimersAsync();
    await load;
    expect(fittedEphemerisInstalled()).toBe(false);
  });

  it('waits for a slow download while bytes keep arriving, past any fixed deadline', async () => {
    vi.useFakeTimers();
    const bytes = new Uint8Array(tinyFile());
    // Nine single bytes 10 s apart, then the rest: 90 s of fake time, far
    // past the old 25 s deadline, but never 15 s without data.
    const slowStream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const sent = (slowStream as unknown as { sent?: number }).sent ?? 0;
        if (sent >= Math.min(bytes.length, 9)) {
          controller.enqueue(bytes.subarray(sent));
          controller.close();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        controller.enqueue(bytes.subarray(sent, sent + 1));
        (slowStream as unknown as { sent?: number }).sent = sent + 1;
      },
    });
    vi.stubGlobal('fetch', vi.fn());
    vi.stubGlobal('__bootTexWarm', new Map([[URL_PATH, Promise.resolve(new Response(slowStream))]]));
    const load = loadFittedEphemeris();
    await vi.advanceTimersByTimeAsync(100_000);
    await load;
    expect(fittedEphemerisInstalled()).toBe(true);
  });

  it('gives up on a download that stops delivering', async () => {
    vi.useFakeTimers();
    const stalled = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) });
    vi.stubGlobal('__bootTexWarm', new Map([[URL_PATH, Promise.resolve(new Response(stalled))]]));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) }))));
    const load = loadFittedEphemeris();
    await vi.advanceTimersByTimeAsync(40_000);
    await load;
    expect(fittedEphemerisInstalled()).toBe(false);
  });
});
