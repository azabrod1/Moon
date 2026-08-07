import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TEXTURE_RETRY_POLICY,
  newTextureRetryState,
  pendingDelayMs,
  retryDelayMs,
  scheduleAfterFailure,
  scheduleAfterWake,
  shouldLogFailure,
  startAttempt,
  urlSpread,
  wakeStaggerMs,
  type TextureRetryState,
} from './textureRetryPolicy';

const P = DEFAULT_TEXTURE_RETRY_POLICY;
const URLS = [
  '/textures/mercury.jpg', '/textures/venus.jpg', '/textures/earth-day.jpg',
  '/textures/mars.jpg', '/textures/jupiter.jpg', '/textures/saturn.jpg',
  '/textures/uranus.jpg', '/textures/neptune.jpg', '/textures/pluto.jpg',
  '/textures/moon.jpg', '/textures/io.jpg', '/textures/europa.jpg',
  '/textures/moon-normal.png', '/textures/mars-normal.png',
];

describe('retry delays', () => {
  it('waits a beat before the first retry, then doubles', () => {
    const mid = 0.5; // the dither's neutral point
    expect(retryDelayMs(1, mid)).toBe(P.baseDelayMs);
    expect(retryDelayMs(2, mid)).toBe(P.baseDelayMs * 2);
    expect(retryDelayMs(3, mid)).toBe(P.baseDelayMs * 4);
  });

  it('never returns a wait before the first failure', () => {
    expect(retryDelayMs(0, 0.5)).toBe(0);
    expect(retryDelayMs(-3, 0.5)).toBe(0);
  });

  it('clamps an out-of-range spread instead of scaling past the dither band', () => {
    // urlSpread is total onto [0, 1), so these only arrive from a broken
    // caller — but the clamp is the contract that a bad spread cannot turn
    // the dither into an amplifier.
    expect(retryDelayMs(1, -5)).toBe(retryDelayMs(1, 0));
    expect(retryDelayMs(1, 42)).toBe(retryDelayMs(1, 1));
  });

  // A minute is the contract: long enough that a dead network costs nothing,
  // short enough that the map lands soon after the connection returns even if
  // no wake event fires (a captive-portal login, say).
  it('settles at a capped wait no matter how long the outage runs', () => {
    for (const spread of [0, 0.25, 0.5, 0.75, 0.999]) {
      for (let failures = 1; failures <= 200; failures++) {
        expect(retryDelayMs(failures, spread)).toBeLessThanOrEqual(60_000);
      }
      expect(retryDelayMs(200, spread)).toBeGreaterThanOrEqual(30_000);
    }
  });

  it('grows monotonically until it caps, and stays there', () => {
    let previous = 0;
    let capped = 0;
    for (let failures = 1; failures <= 20; failures++) {
      const delay = retryDelayMs(failures, 0.3);
      expect(delay).toBeGreaterThanOrEqual(previous);
      if (delay === previous) capped += 1;
      previous = delay;
    }
    expect(capped).toBeGreaterThan(5); // the ladder tops out rather than running away
  });

  it('never gives up: every rung schedules another attempt', () => {
    let state = newTextureRetryState();
    for (let failures = 1; failures <= 500; failures++) {
      state = scheduleAfterFailure(state, failures * 1000, 0.5);
      expect(state.nextAttemptAtMs).not.toBeNull();
    }
    expect(state.attemptsFailed).toBe(500);
  });
});

describe('per-URL dither', () => {
  it('is stable for a URL and spread across the scene', () => {
    for (const url of URLS) expect(urlSpread(url)).toBe(urlSpread(url));
    const spreads = URLS.map(urlSpread);
    expect(new Set(spreads.map((s) => Math.round(s * 20))).size).toBeGreaterThan(6);
    for (const s of spreads) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(1);
    }
  });

  // Every texture in the scene fails in the same instant when the connection
  // drops; without the dither they would then retry in one burst forever.
  it('splits a scene-wide burst of simultaneous failures across the wait', () => {
    const delays = URLS.map((url) => retryDelayMs(6, urlSpread(url)));
    const span = Math.max(...delays) - Math.min(...delays);
    expect(span).toBeGreaterThan(0.2 * Math.min(...delays));
    expect(new Set(delays).size).toBeGreaterThan(URLS.length / 2);
  });

  it('keeps the dither inside a quarter of the nominal wait', () => {
    const nominal = retryDelayMs(4, 0.5);
    for (const url of URLS) {
      const delay = retryDelayMs(4, urlSpread(url));
      expect(Math.abs(delay - nominal)).toBeLessThanOrEqual(Math.ceil(nominal * P.ditherFraction));
    }
  });
});

describe('wake signals', () => {
  function pendingAfterFailures(failures: number, spread = 0.5): TextureRetryState {
    let state = newTextureRetryState();
    for (let i = 0; i < failures; i++) {
      state = startAttempt(state, 0);
      state = scheduleAfterFailure(state, 0, spread);
    }
    return state;
  }

  it('pulls a long pending wait forward to now', () => {
    const state = pendingAfterFailures(10);
    const waitBefore = pendingDelayMs(state, 0)!;
    expect(waitBefore).toBeGreaterThan(30_000);
    // The last attempt started at 0, so the spacing floor is long spent by the
    // time a wake arrives this deep into an outage.
    const woken = scheduleAfterWake(state, 10_000, 0.5);
    expect(pendingDelayMs(woken, 10_000)!).toBeLessThanOrEqual(P.wakeStaggerMs);
  });

  it('staggers woken attempts by URL, so the scene does not fetch as one', () => {
    const staggers = URLS.map((url) => {
      const state = pendingAfterFailures(10, urlSpread(url));
      const woken = scheduleAfterWake(state, 10_000, urlSpread(url));
      return pendingDelayMs(woken, 10_000)!;
    });
    expect(new Set(staggers).size).toBeGreaterThan(URLS.length / 2);
    expect(Math.max(...staggers)).toBeLessThanOrEqual(P.wakeStaggerMs);
  });

  it('leaves an attempt that is already sooner alone', () => {
    let state = newTextureRetryState();
    state = startAttempt(state, 0);
    state = scheduleAfterFailure(state, 0, 0.5); // first retry, half a second out
    const woken = scheduleAfterWake(state, 10, 0.5);
    expect(woken).toBe(state);
  });

  it('does nothing when no attempt is pending', () => {
    const idle = newTextureRetryState();
    expect(scheduleAfterWake(idle, 5_000, 0.5)).toBe(idle);
    const inFlight = startAttempt(scheduleAfterFailure(idle, 0, 0.5), 100);
    expect(scheduleAfterWake(inFlight, 200, 0.5)).toBe(inFlight);
  });

  // Flipping browser tabs fires a visibility event every time; without the
  // spacing floor that is a fetch loop at gesture speed.
  it('holds a stream of wakes to the minimum spacing after the last attempt', () => {
    let woken = pendingAfterFailures(10); // last attempt at 0, next ~45 s out
    for (let t = 0; t < 20; t++) woken = scheduleAfterWake(woken, t * 10, 0.5);
    expect(woken.nextAttemptAtMs!).toBeGreaterThanOrEqual(P.minAttemptSpacingMs);
    expect(woken.nextAttemptAtMs!).toBeLessThan(P.minAttemptSpacingMs + P.wakeStaggerMs + 1);
  });

  it('measures the stagger from the spread, bounded by the policy', () => {
    expect(wakeStaggerMs(0)).toBe(0);
    expect(wakeStaggerMs(1)).toBe(P.wakeStaggerMs);
    expect(wakeStaggerMs(2)).toBe(P.wakeStaggerMs); // clamped, not extrapolated
    expect(wakeStaggerMs(-1)).toBe(0);
  });
});

describe('schedule bookkeeping', () => {
  it('clears the pending attempt while one is in flight', () => {
    let state = scheduleAfterFailure(newTextureRetryState(), 1_000, 0.5);
    expect(pendingDelayMs(state, 1_000)).toBe(retryDelayMs(1, 0.5));
    state = startAttempt(state, 1_400);
    expect(pendingDelayMs(state, 1_400)).toBeNull();
    expect(state.lastAttemptAtMs).toBe(1_400);
  });

  it('reports a due attempt as due now, never as negative', () => {
    const state = scheduleAfterFailure(newTextureRetryState(), 0, 0.5);
    expect(pendingDelayMs(state, 60_000)).toBe(0);
  });

  it('keeps the failure count climbing across attempts', () => {
    let state = newTextureRetryState();
    state = scheduleAfterFailure(state, 0, 0.5);
    state = startAttempt(state, 500);
    state = scheduleAfterFailure(state, 500, 0.5);
    expect(state.attemptsFailed).toBe(2);
  });
});

describe('failure logging', () => {
  it('explains the first failures, then goes quiet apart from a heartbeat', () => {
    expect([1, 2, 3].every(shouldLogFailure)).toBe(true);
    expect([4, 5, 6, 7].some(shouldLogFailure)).toBe(false);
    expect(shouldLogFailure(8)).toBe(true);
    const logged = Array.from({ length: 200 }, (_, i) => i + 1).filter(shouldLogFailure);
    expect(logged.length).toBeLessThan(30); // a session-long ladder can't bury the console
  });
});
