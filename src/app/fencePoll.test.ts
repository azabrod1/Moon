import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTaskPump, pollFence, type TaskPump } from './fencePoll';

const SIGNALED = 0x9119;
const UNSIGNALED = 0x9118;

/** A WebGL2 context with only what the loop calls, whose fence signals once
 *  `signalAtMs` has passed on the test's clock. */
function fakeGl(clock: { now: number }, signalAtMs: number) {
  const calls = { status: 0, deleted: 0 };
  const gl = {
    SIGNALED,
    SYNC_STATUS: 0x9114,
    getSyncParameter: () => {
      calls.status++;
      return clock.now >= signalAtMs ? SIGNALED : UNSIGNALED;
    },
    deleteSync: () => {
      calls.deleted++;
    },
  };
  return { gl: gl as unknown as WebGL2RenderingContext, calls };
}

/** A pump the test turns over by hand: each run is one task. */
function manualPump(): TaskPump & { pending: number; disposed: boolean; run(): boolean } {
  const pump = {
    source: 'window' as const,
    handler: null as (() => void) | null,
    pending: 0,
    disposed: false,
    post() {
      pump.pending++;
    },
    dispose() {
      pump.disposed = true;
    },
    run() {
      if (pump.pending === 0) return false;
      pump.pending--;
      pump.handler?.();
      return true;
    },
  };
  return pump;
}

const clock = { now: 0 };
beforeEach(() => {
  clock.now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** Turn the pump over, the clock stepping `stepMs` before each task. */
function drain(pump: ReturnType<typeof manualPump>, stepMs: number, max = 1000): void {
  for (let i = 0; i < max && pump.pending > 0; i++) {
    clock.now += stepMs;
    pump.run();
  }
}

describe('fencePoll', () => {
  it('reads the gap before the signalling poll from the previous poll’s ask', () => {
    const { gl } = fakeGl(clock, 10.45);
    const pump = manualPump();
    const done = vi.fn();
    clock.now = 10;
    pollFence(gl, {} as WebGLSync, 10, { pump, capMs: 50 }, done);
    // Asks at 10.2, 10.4 (unsignalled), 10.6 (signalled).
    drain(pump, 0.2);
    expect(done).toHaveBeenCalledTimes(1);
    const result = done.mock.calls[0][0];
    expect(result.polls).toBe(3);
    expect(result.signalledAtMs).toBeCloseTo(10.6, 9);
    expect(result.askedAtMs).toBeCloseTo(10.6, 9);
    expect(result.signalGapMs).toBeCloseTo(0.2, 9);
    expect(result.intervalMeanMs).toBeCloseTo(0.2, 9);
    expect(result.signalledOnFirstPoll).toBe(false);
    expect(result.capped).toBe(false);
  });

  it('runs the first poll’s gap from the submit: a fence already signalled has no finer bound', () => {
    const { gl } = fakeGl(clock, 0);
    const pump = manualPump();
    const done = vi.fn();
    clock.now = 10;
    pollFence(gl, {} as WebGLSync, 10, { pump, capMs: 50 }, done);
    drain(pump, 3);
    const result = done.mock.calls[0][0];
    expect(result.polls).toBe(1);
    expect(result.signalledOnFirstPoll).toBe(true);
    expect(result.signalGapMs).toBeCloseTo(3, 9);
    expect(result.intervalMeanMs).toBeNull();
  });

  it('caps from the moment it is told — the frame’s callback start — not from the submit', () => {
    const { gl, calls } = fakeGl(clock, Infinity);
    const pump = manualPump();
    const done = vi.fn();
    clock.now = 10;
    // The frame began at 5; the cap is 20 ms after that, so the loop gives up
    // at the first ask at or past 25, not 30.
    pollFence(gl, {} as WebGLSync, 10, { pump, capMs: 20, capFromMs: 5 }, done);
    drain(pump, 1);
    const result = done.mock.calls[0][0];
    expect(result.capped).toBe(true);
    expect(result.signalledAtMs).toBeNull();
    expect(result.signalGapMs).toBeNull();
    expect(clock.now).toBe(25);
    expect(calls.deleted).toBe(1);
    // Without a start of its own the cap runs from the submit.
    const late = manualPump();
    const doneLate = vi.fn();
    clock.now = 10;
    pollFence(gl, {} as WebGLSync, 10, { pump: late, capMs: 20 }, doneLate);
    drain(late, 1);
    expect(doneLate.mock.calls[0][0].capped).toBe(true);
    expect(clock.now).toBe(30);
  });

  it('a cancel deletes the sync, stops the loop and never reports', () => {
    const { gl, calls } = fakeGl(clock, Infinity);
    const pump = manualPump();
    const done = vi.fn();
    const cancel = pollFence(gl, {} as WebGLSync, 0, { pump, capMs: 50 }, done);
    drain(pump, 0.1, 3);
    cancel();
    expect(calls.deleted).toBe(1);
    expect(pump.handler).toBeNull();
    const asked = calls.status;
    drain(pump, 0.1);
    expect(calls.status).toBe(asked);
    expect(done).not.toHaveBeenCalled();
    // A second cancel does nothing more.
    cancel();
    expect(calls.deleted).toBe(1);
  });

  it('reuses a pump it was handed, leaving it alive for the next fence', () => {
    const { gl, calls } = fakeGl(clock, 0);
    const pump = manualPump();
    const done = vi.fn();
    pollFence(gl, {} as WebGLSync, 0, { pump, capMs: 50 }, done);
    drain(pump, 0.1);
    expect(pump.disposed).toBe(false);
    expect(pump.handler).toBeNull();
    pollFence(gl, {} as WebGLSync, clock.now, { pump, capMs: 50 }, done);
    drain(pump, 0.1);
    expect(done).toHaveBeenCalledTimes(2);
    expect(calls.deleted).toBe(2);
    expect(pump.disposed).toBe(false);
  });

  it('charges each task’s execution, entry to exit, with the moment it began', () => {
    const { gl } = fakeGl(clock, 10.25);
    const pump = manualPump();
    const tasks: Array<[number, number]> = [];
    const done = vi.fn();
    clock.now = 10;
    pollFence(gl, {} as WebGLSync, 10, { pump, capMs: 50, onTask: (ms, at) => tasks.push([ms, at]) }, done);
    drain(pump, 0.1);
    expect(tasks.map(([, at]) => Math.round(at * 10) / 10)).toEqual([10.1, 10.2, 10.3]);
    // The fake clock does not move inside a task: each costs nothing, and the
    // campaign is first entry to last exit.
    expect(tasks.every(([ms]) => ms === 0)).toBe(true);
    expect(done.mock.calls[0][0].campaignMs).toBeCloseTo(0.2, 9);
  });

  it('owns a channel pump when handed none, and closes it when done', async () => {
    const { gl } = fakeGl(clock, 0);
    const result = await new Promise<{ polls: number }>((resolve) => {
      pollFence(gl, {} as WebGLSync, 0, { source: 'channel', capMs: 50 }, resolve);
    });
    expect(result.polls).toBe(1);
  });

  it('a channel pump runs its handler once per post', async () => {
    const pump = createTaskPump('channel');
    let runs = 0;
    await new Promise<void>((resolve) => {
      pump.handler = () => {
        runs++;
        if (runs < 3) pump.post();
        else resolve();
      };
      pump.post();
    });
    expect(runs).toBe(3);
    pump.dispose();
  });
});
