import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGpuFrameClock } from './gpuFrameClock';
import { CPU_PER_FRAME_MAX_MS, DUTY_START, GRID_MIN_STEPS, PRICE_BLOCK_SAMPLES, SOURCE_TRIAL_SAMPLES } from './gpuFrameClockPolicy';
import type { FencePollSource, TaskPump } from './fencePoll';

const SIGNALED = 0x9119;
const UNSIGNALED = 0x9118;
const BAR = 1000 / 60;

const clock = { now: 0 };
beforeEach(() => {
  clock.now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
});
afterEach(() => {
  vi.restoreAllMocks();
});

interface ManualPump extends TaskPump {
  pending: number;
  disposed: boolean;
  run(): boolean;
}

function manualPump(source: FencePollSource): ManualPump {
  const pump: ManualPump = {
    source,
    handler: null,
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

/**
 * A sensor on a fake WebGL2 context. Each fence signals `gpuMs` after it was
 * made; a flush costs `flushMs` of the main thread; the poll's tasks are run
 * by `settle`, the clock stepping `taskStepMs` before each.
 */
function rig(opts: { gpuMs?: number; flushMs?: number; taskStepMs?: number } = {}) {
  const gpuMs = opts.gpuMs ?? 0.5;
  const counts = { fences: 0, flushes: 0, deleted: 0 };
  const gl = {
    SIGNALED,
    SYNC_STATUS: 0x9114,
    SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
    fenceSync: () => {
      counts.fences++;
      return { signalAtMs: clock.now + gpuMs };
    },
    flush: () => {
      counts.flushes++;
      clock.now += opts.flushMs ?? 0;
    },
    getSyncParameter: (sync: { signalAtMs: number }) => (clock.now >= sync.signalAtMs ? SIGNALED : UNSIGNALED),
    deleteSync: () => {
      counts.deleted++;
    },
  } as unknown as WebGL2RenderingContext;
  const pumps: ManualPump[] = [];
  const samples: Array<{ drawSeq: number; generation: number; readingMs: number; sampledAtMs: number }> = [];
  const duties: number[] = [];
  const disabled: string[] = [];
  const sensor = createGpuFrameClock({
    gl,
    killed: false,
    onSample: (s) => samples.push(s),
    onWork: () => {},
    onDuty: (d) => duties.push(d),
    onDisabled: (r) => disabled.push(r),
    createPump: (source) => {
      const pump = manualPump(source);
      pumps.push(pump);
      return pump;
    },
  });
  let drawSeq = 0;
  const settle = () => {
    for (let i = 0; i < 10_000; i++) {
      const pump = pumps.find((p) => p.pending > 0);
      if (!pump) return;
      clock.now += opts.taskStepMs ?? 0.1;
      pump.run();
    }
  };
  /** One drawn frame at 60 fps, its poll run to the end. */
  const frame = (over: Partial<Parameters<typeof sensor.afterDraw>[0]> = {}) => {
    clock.now = Math.ceil((clock.now + 0.001) / BAR) * BAR;
    sensor.afterDraw({
      drawSeq: drawSeq++,
      callbackStartMs: clock.now,
      wanted: true,
      verifying: false,
      eligible: true,
      clean: true,
      barMs: BAR,
      generation: 7,
      ...over,
    });
    settle();
  };
  return { sensor, counts, pumps, samples, duties, disabled, frame, settle };
}

describe('the GPU frame clock', () => {
  it('fences one eligible frame in four, flushes every frame while wanted, and hands each reading its own frame', () => {
    const r = rig({ gpuMs: 5 });
    for (let i = 0; i < 16; i++) r.frame();
    expect(r.counts.fences).toBe(16 / DUTY_START);
    expect(r.counts.flushes).toBe(16);
    expect(r.counts.deleted).toBe(r.counts.fences);
    expect(r.samples.map((s) => s.drawSeq)).toEqual([0, 4, 8, 12]);
    expect(r.samples.every((s) => s.generation === 7)).toBe(true);
    // Signalled 5 ms after the fence, seen by the first poll at or after it.
    for (const s of r.samples) {
      expect(s.readingMs).toBeGreaterThanOrEqual(5 - 1e-9);
      expect(s.readingMs).toBeLessThanOrEqual(5.1 + 1e-9);
    }
  });

  it('issues no fence and no flush on a frame the controller does not want read', () => {
    const r = rig();
    for (let i = 0; i < 16; i++) r.frame({ wanted: false });
    expect(r.counts.fences).toBe(0);
    expect(r.counts.flushes).toBe(0);
  });

  it('hands nothing on until the page’s clock is known to resolve a millisecond', () => {
    // A fence already signalled when the loop first asks: one poll, no step of
    // the clock seen inside it, so no grid.
    const r = rig({ gpuMs: 0 });
    for (let i = 0; i < 8; i++) r.frame();
    expect(r.sensor.state().sampled).toBe(2);
    expect(r.sensor.state().gridMs).toBeNull();
    expect(r.samples).toEqual([]);
    // A poll that saw the clock step: a tenth of a millisecond qualifies it.
    const fine = rig({ gpuMs: 0.25 });
    fine.frame();
    expect(fine.sensor.state().gridMs).toBeCloseTo(0.1, 6);
    expect(fine.samples).toHaveLength(1);
  });

  it('turns itself off on a clock too coarse to steer by, and lets its task sources go', () => {
    const r = rig({ gpuMs: 10, taskStepMs: 2 });
    for (let i = 0; i < 4 * GRID_MIN_STEPS && r.disabled.length === 0; i++) r.frame();
    expect(r.disabled).toHaveLength(1);
    expect(r.disabled[0]).toMatch(/only resolves 2 ms/);
    expect(r.samples).toEqual([]);
    expect(r.sensor.usable).toBe(false);
    expect(r.pumps.length).toBeGreaterThan(0);
    expect(r.pumps.every((p) => p.disposed)).toBe(true);
    const fences = r.counts.fences;
    r.frame();
    expect(r.counts.fences).toBe(fences);
  });

  it('keeps one fence in flight, and counts the arm it skipped for it', () => {
    const r = rig({ gpuMs: 1000 });
    // No settling: the first fence stays out while the count runs down.
    const frame = (seq: number) => {
      clock.now += BAR;
      r.sensor.afterDraw({ drawSeq: seq, callbackStartMs: clock.now, wanted: true, verifying: false, eligible: true, clean: true, barMs: 1000, generation: 0 });
    };
    for (let i = 0; i < DUTY_START + 1; i++) frame(i);
    expect(r.counts.fences).toBe(1);
    expect(r.sensor.state().inFlight).toBe(true);
    expect(r.sensor.state().skippedArms).toBe(1);
  });

  it('samples one frame in four through a verification, whatever its duty', () => {
    const r = rig({ gpuMs: 0.5 });
    r.sensor.devSet({ duty: 16 });
    const before = r.counts.fences;
    for (let i = 0; i < 32; i++) r.frame({ verifying: true });
    expect(r.counts.fences - before).toBe(8);
    const steady = r.counts.fences;
    for (let i = 0; i < 32; i++) r.frame();
    expect(r.counts.fences - steady).toBe(2);
  });

  it('prices itself: a flush that costs a millisecond a frame backs the duty off, then turns it off, saying so', () => {
    // The fence outlasts the flush, so the loop sees the clock step.
    const r = rig({ gpuMs: 2, flushMs: 1 });
    for (let i = 0; i < 16 * PRICE_BLOCK_SAMPLES * 4 && r.disabled.length === 0; i++) r.frame();
    expect(r.duties).toEqual([8, 16]);
    expect(r.disabled).toHaveLength(1);
    expect(r.disabled[0]).toMatch(/ms of CPU a frame even at one frame in 16/);
    expect(r.sensor.state().costPerFrameMs!).toBeGreaterThan(CPU_PER_FRAME_MAX_MS);
    expect(r.pumps.every((p) => p.disposed)).toBe(true);
  });

  it('tries both task sources, keeps one and lets the other go', () => {
    const r = rig({ gpuMs: 0.5 });
    for (let i = 0; i < 2 * SOURCE_TRIAL_SAMPLES * DUTY_START + DUTY_START; i++) r.frame();
    const kept = r.sensor.state().source;
    expect(kept).not.toBeNull();
    expect(r.pumps.map((p) => p.source).sort()).toEqual(['channel', 'window']);
    for (const pump of r.pumps) expect(pump.disposed).toBe(pump.source !== kept);
    // And the one kept goes on sampling.
    const fences = r.counts.fences;
    for (let i = 0; i < 2 * DUTY_START; i++) r.frame();
    expect(r.counts.fences).toBe(fences + 2);
    expect(r.pumps).toHaveLength(2);
  });

  it('turned off from outside, it stops its poll and lets its task sources go', () => {
    const r = rig({ gpuMs: 1000 });
    r.sensor.afterDraw({ drawSeq: 0, callbackStartMs: clock.now, wanted: true, verifying: false, eligible: true, clean: true, barMs: 1000, generation: 0 });
    expect(r.sensor.state().inFlight).toBe(true);
    r.sensor.disable('the WebGL context was lost');
    expect(r.disabled).toEqual(['the WebGL context was lost']);
    expect(r.sensor.state().inFlight).toBe(false);
    expect(r.counts.deleted).toBe(1);
    expect(r.pumps.every((p) => p.disposed)).toBe(true);
  });
});
