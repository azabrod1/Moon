import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGpuClock, type GpuClockName, type GpuClockResult } from './devGpuClock';
import type { TaskPump } from './fencePoll';

const SIGNALED = 0x9119;
const UNSIGNALED = 0x9118;

/** The test's own clock, which `performance.now()` reads. */
const clock = { now: 0 };

/** A WebGL2 context with what the DEV clock and its loop call. Each fence
 *  signals `fenceMs` after it was made; everything else is a no-op, and no
 *  timer extension is offered. */
function fakeGl(fenceMs: number): WebGL2RenderingContext {
  const known: Record<string, unknown> = {
    SIGNALED,
    SYNC_STATUS: 0x9114,
    SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
    fenceSync: () => ({ signalAtMs: clock.now + fenceMs }),
    getSyncParameter: (sync: { signalAtMs: number }) => (clock.now >= sync.signalAtMs ? SIGNALED : UNSIGNALED),
    getExtension: () => null,
    getParameter: () => null,
    canvas: { width: 800, height: 600 },
  };
  return new Proxy(known, {
    get(target, prop) {
      if (typeof prop === 'string' && prop in target) return target[prop];
      if (typeof prop === 'string' && /^[A-Z0-9_]+$/.test(prop)) return 0;
      return () => null;
    },
  }) as unknown as WebGL2RenderingContext;
}

/** A pump the test turns over by hand: each run is one task. */
function manualPump(): TaskPump & { pending: number; run(): boolean } {
  const pump = {
    source: 'window' as const,
    handler: null as (() => void) | null,
    pending: 0,
    post() {
      pump.pending++;
    },
    dispose() {},
    run() {
      if (pump.pending === 0) return false;
      pump.pending--;
      pump.handler?.();
      return true;
    },
  };
  return pump;
}

beforeEach(() => {
  clock.now = 0;
  // A plain replacement rather than a spy: the run ends by reading the clock
  // for its grid, hundreds of thousands of times.
  Object.defineProperty(performance, 'now', { value: () => clock.now, configurable: true, writable: true });
  vi.stubGlobal('window', { devicePixelRatio: 2, innerWidth: 800, innerHeight: 600 });
});
afterEach(() => {
  delete (performance as unknown as { now?: unknown }).now;
  vi.unstubAllGlobals();
});

/**
 * Drives a run at a steady 60 Hz: a callback every 16.67 ms, the fence loop's
 * tasks turned over between them every half millisecond. Returns the result,
 * the callbacks the run took and how many of them drew the world.
 */
async function runAt60(fenceMs: number, clocks: GpuClockName[]): Promise<{ result: GpuClockResult; callbacks: number; drawn: number }> {
  const pump = manualPump();
  const gpuClock = createGpuClock({
    gl: fakeGl(fenceMs),
    pinRatio: () => {},
    targets: () => ({}),
    createPump: () => pump,
  });
  let result: GpuClockResult | null = null;
  let callbacks = 0;
  let drawn = 0;
  const done = gpuClock.run({ frames: 12, clocks, settleFrames: 1, drainFrames: 30 }).then((r) => { result = r; });
  const period = 1000 / 60;
  for (let k = 0; k < 2000 && gpuClock.active; k++) {
    clock.now = k * period;
    callbacks++;
    gpuClock.frame(() => { drawn++; }, () => {});
    const next = (k + 1) * period;
    while (pump.pending > 0 && clock.now + 0.5 < next) {
      clock.now += 0.5;
      pump.run();
    }
  }
  await done;
  expect(result).not.toBeNull();
  return { result: result!, callbacks, drawn };
}

describe('the DEV GPU clock', () => {
  it('counts every frame it drew in the drawn rate: a 60 Hz stream with 35 ms fences reads 60, not the 20 it measured at', async () => {
    const { result } = await runAt60(35, ['fence']);
    const level = result.levels[0];
    // A fence out for 35 ms gives up two slots in three: the arm measured one
    // frame in three, and every frame was drawn.
    expect(level.skipped).toBeGreaterThan(level.frames.length);
    expect(level.drawnRateHz).not.toBeNull();
    expect(level.drawnRateHz!).toBeCloseTo(60, 0);
  });

  it('draws the timer arm’s frames where there is no timer, so every slot carries the same load', async () => {
    const { result, callbacks, drawn } = await runAt60(5, ['fence', 'timer']);
    const level = result.levels[0];
    const timer = level.frames.filter((f) => f.clock === 'timer');
    expect(timer.length).toBeGreaterThan(0);
    expect(timer.every((f) => f.capped && f.readingMs === null)).toBe(true);
    // Every callback of the run drew the world: none was a slot that drew
    // nothing.
    expect(drawn).toBe(callbacks);
    expect(result.notes.some((n) => n.includes('drawn but not measured'))).toBe(true);
  });
});
