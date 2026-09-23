/**
 * devGpuClock — can a WebGL2 page time its own frame's GPU cost finely enough
 * to steer by, on the device that draws it? (DEV only; reached through
 * `__moon.gpuClock()`, dead in a production build like devGpuProfile.ts.)
 *
 * The resolution controller senses only the interval between drawn frames,
 * and under vsync that interval is quantised to the display's tick: an 11 ms
 * frame and a 16 ms frame both read 16.67 ms on a 60 Hz panel, so the rule
 * cannot tell a frame with headroom from one that is about to miss, and it
 * has to wait for a miss before acting. A sub-tick reading of the frame's GPU
 * cost would let it act on headroom instead. This module measures whether
 * such a reading is available, what it resolves, and what it costs — it
 * decides nothing and steers nothing.
 *
 * The clocks are cycled frame by frame at one frozen pose, so that a device
 * heating under its own measurement drifts through all of them equally rather
 * than through one:
 *
 *  - **fence**: `fenceSync(SYNC_GPU_COMMANDS_COMPLETE)` after the frame's
 *    draws, then `flush()` (without it the fence may sit unsubmitted and
 *    never signal), then the status polled from a task loop. Both engines
 *    refresh a sync object's cached status at most once per event-loop task,
 *    so polling inside one task reads the same stale value forever and the
 *    only resolution available is the task period — which is why the loop is
 *    driven by `window.postMessage` or a `MessageChannel` and never by
 *    `setTimeout`, whose nested clamp is 4 ms by spec and far worse on
 *    WebKit. The reading is `signalled − submitted`: not the GPU's duration
 *    but the latency until completion was noticed, which is the quantity a
 *    margin-to-deadline rule would want anyway.
 *  - **fence-drained**: the same fence, but with everything the previous
 *    frames left waited out before this frame's draws are issued. A plain
 *    fence measures the latency until ALL work queued before it completes,
 *    and a renderer whose CPU is allowed to run ahead has one or two frames
 *    queued at any moment, so at a load the device cannot keep up with the
 *    plain reading grows with the backlog and is no longer the frame's cost.
 *    Draining first removes the backlog and leaves the fence's own notice
 *    lag, which is the bias a production reading would have to subtract.
 *  - **fence-start**: the same fence inserted BEFORE the draws, as a control.
 *    A fence signals when the commands QUEUED BEFORE IT complete, so this one
 *    can signal while the frame is still being drawn and its reading is not a
 *    frame cost at all. It is measured so that nobody builds on it.
 *  - **readback**: the clock devGpuProfile.ts already uses — a one-pixel
 *    `readPixels` from a private texture-backed framebuffer, where the read
 *    IS the wait. Exact, and useless in production: it is a documented
 *    implicit finish, so it deletes the CPU/GPU overlap of the frame it
 *    measures. Here it is the reference the fence readings are biased
 *    against.
 *  - **timer**: `EXT_disjoint_timer_query_webgl2` where the engine exposes
 *    it. Chromium on the Mac does; WebKit has the implementation but gates it
 *    behind a preference that is off by default, so the arm reports itself
 *    absent rather than absent-and-silent. On Metal the timer is
 *    command-buffer granular and reads high — a third opinion, not a truth.
 *
 * The load is the DEV output-ratio pin, the same one `?ratio=` writes, so one
 * run can walk a frame cost from well under the display's tick to well over
 * it without moving the camera. Every level records the pixels it was
 * measured at (`targets`), because a reading in milliseconds means nothing
 * without the frame it was taken from.
 *
 * Two deliberate omissions. The run does NOT hold the frame-rate cap open:
 * whether a poll loop starves the animation callback is one of the things
 * being measured, so the cadence is left exactly as the app would deliver it
 * and reported per frame. And no reading is ever averaged on the way in — the
 * frames are kept and summarised by gpuClockStats.ts, because a fence reading
 * carries the scheduler's noise and is only meaningful as a distribution.
 */

import {
  summarise,
  summarisePolls,
  minNonZeroDelta,
  ratePerSecond,
  intervalsOf,
  deltaOfMedians,
  type Summary,
  type PollSummary,
} from './gpuClockStats';
import { createReadbackWait } from './devGpuProfile';
import { pollFence } from './fencePoll';

export type GpuClockName = 'fence' | 'fence-drained' | 'fence-start' | 'readback' | 'timer';

export interface GpuClockPollOptions {
  /** The task source the poll loop runs on. `window.postMessage` is the fastest thing WebKit offers; a MessageChannel is the second arm. */
  source?: 'window' | 'channel';
  /** Read the status every n-th task (2 halves the IPC cost and the resolution). */
  stride?: number;
  /** Give up on a fence after this long. This is the bound that matters: a poll loop turns tasks over far faster than a frame completes. */
  capMs?: number;
  /** Give up on a fence after this many polls — a backstop, not the bound: Chromium's window.postMessage loop reaches four hundred polls inside three milliseconds, before any frame's GPU work can have finished. */
  capPolls?: number;
  /** How many of a sample frame's raw stamps to keep in the record. */
  keepStamps?: number;
}

export interface GpuClockOptions {
  /** Frames per clock per load level. */
  frames?: number;
  /** The output pixel ratios to measure at; a null entry leaves the ratio alone (the app's own). */
  ratios?: (number | null)[];
  clocks?: GpuClockName[];
  poll?: GpuClockPollOptions;
  /** Frames drawn after a ratio change before anything is measured. */
  settleFrames?: number;
  /** Frames drawn at the end of a level while outstanding polls and timer results arrive. */
  drainFrames?: number;
  /** The whole run's wall-clock limit; a run that overruns returns what it has with a note. */
  timeoutMs?: number;
}

export interface GpuClockFrame {
  level: number;
  clock: GpuClockName;
  /** The measured frame's index within the run. */
  seq: number;
  /** CPU ms spent issuing the frame's draws. */
  submitMs: number;
  /** The clock's reading: fence = noticed-signalled minus submitted, readback = the wait after the submit, timer = the GPU's own span. Null where it never arrived. */
  readingMs: number | null;
  /** The fence reading stamped when the poll ASKED rather than when it answered — the same signal without the answering call's own cost. */
  askReadingMs: number | null;
  /** The readback arm's whole span, submit included: what devGpuProfile reports as worldMs. */
  spanMs: number | null;
  /** The readback arm's pre-drain — the previous frame's residue, waited out before this frame's draws so the span is this frame's alone. */
  preDrainMs: number | null;
  polls: number;
  /** Main-thread ms this frame spent inside status calls. */
  pollCostMs: number;
  pollIntervalMeanMs: number | null;
  pollIntervalMaxMs: number | null;
  /** The very first poll after the submit already found it signalled (the frame-start control's expected shape). */
  firstPollSignalled: boolean;
  capped: boolean;
  /** ms since the previous frame the clock saw — the cadence the poll loop left behind. */
  frameIntervalMs: number | null;
}

export interface GpuClockArm {
  n: number;
  reading: Summary | null;
  askReading: Summary | null;
  submit: Summary | null;
  frameInterval: Summary | null;
  /** Polls per frame. */
  polls: Summary | null;
  /** Main-thread ms per frame spent polling. */
  pollCostMs: Summary | null;
  /** The poll interval achieved, per frame. */
  pollIntervalMs: Summary | null;
  capped: number;
  firstPollSignalled: number;
  /** This arm's median minus the readback arm's, at this load. */
  biasVsReadbackMs: number | null;
  /** This arm's median minus the timer arm's, where there is one. */
  biasVsTimerMs: number | null;
}

export interface GpuClockLevel {
  ratio: number | null;
  /** Every surface a frame is drawn into at this level, in device pixels. */
  targets: unknown;
  arms: Record<string, GpuClockArm>;
  /** Frames drawn per second while the level was measured, poll loops included. */
  drawnRateHz: number | null;
  drawnIntervalMs: Summary | null;
  /** One fence frame's raw poll stamps, kept as the evidence behind the summaries. */
  samplePolls: { before: number; after: number; signalled: boolean }[];
  samplePollSummary: PollSummary | null;
  frames: GpuClockFrame[];
  /** Frames drawn and thrown away at this level because a poll loop was still running. */
  skipped: number;
  notes: string[];
}

export interface GpuClockResult {
  at: string;
  userAgent: string;
  devicePixelRatio: number;
  viewport: { w: number; h: number };
  /** The clock every reading is a difference of: its observed grid, and what the engine's policy grid is. */
  clockGranularityMs: number | null;
  crossOriginIsolated: boolean;
  poll: Required<GpuClockPollOptions>;
  framesPerClock: number;
  /** What the engine exposes: the timer-query extension, whether it also offers a timestamp counter, the renderer string where it is unmasked, and the ceiling on a blocking client wait. */
  gpu: {
    timerQuery: boolean;
    timestampCounter: boolean | null;
    renderer: string | null;
    maxClientWaitTimeoutMs: number | null;
  };
  levels: GpuClockLevel[];
  notes: string[];
}

export interface GpuClockDeps {
  gl: WebGL2RenderingContext | WebGLRenderingContext;
  /** Pin the output pixel ratio — the load — exactly as `?ratio=` does; null hands it back. */
  pinRatio: (ratio: number | null) => void;
  /** Every surface a frame is drawn into, so a reading carries the pixels it was taken at. */
  targets: () => unknown;
}

export interface GpuClock {
  /** The animation loop calls this in place of its own draw while `active`. */
  frame: (renderWorld: () => void, renderChart: () => void) => void;
  readonly active: boolean;
  run: (opts?: GpuClockOptions) => Promise<GpuClockResult>;
}

/**
 * The observed grid of `performance.now()`: read it faster than it advances.
 *
 * Bounded by TIME and not by a sample count, because the coarser the clock
 * the more reads it takes to catch it moving — a fixed few thousand reads fit
 * inside one tick of WebKit's millisecond clock and would answer that the
 * clock never moved, which is the opposite of what it found.
 */
function clockGranularity(budgetMs = 12, maxSamples = 400000): number | null {
  const xs: number[] = [];
  const started = performance.now();
  for (let i = 0; i < maxSamples; i++) {
    const t = performance.now();
    xs.push(t);
    if (t - started >= budgetMs) break;
  }
  return minNonZeroDelta(xs);
}

export function createGpuClock(deps: GpuClockDeps): GpuClock {
  const gl = deps.gl;
  const gl2 = gl as WebGL2RenderingContext;
  let active = false;

  let opts: Required<Omit<GpuClockOptions, 'poll' | 'ratios' | 'clocks'>> & {
    poll: Required<GpuClockPollOptions>;
    ratios: (number | null)[];
    clocks: GpuClockName[];
  };
  let readback: { wait: () => void; dispose: () => void } | null = null;
  let timerExt: {
    TIME_ELAPSED_EXT: number;
    GPU_DISJOINT_EXT: number;
    queryCounterEXT?: (query: WebGLQuery, target: number) => void;
  } | null = null;

  let levels: GpuClockLevel[] = [];
  let levelIndex = 0;
  let phase: 'settle' | 'measure' | 'drain' = 'settle';
  let framesInPhase = 0;
  let measuredInLevel = 0;
  let seq = 0;
  let runStartedMs = 0;
  let lastFrameAtMs: number | null = null;
  // One stamp list per level, not one shared list: a level's drawn rate is
  // summarised again when the run ends, and a shared list would hand every
  // level the last one's cadence.
  let levelStamps: number[][] = [];
  const notes: string[] = [];
  let resolveRun: ((r: GpuClockResult) => void) | null = null;
  let rejectRun: ((e: unknown) => void) | null = null;

  /** Fence loops still running, and the timer queries still to answer. */
  let outstandingPolls = 0;
  let cancelPoll: (() => void) | null = null;
  const pendingTimers: { record: GpuClockFrame; query: WebGLQuery }[] = [];

  function level(): GpuClockLevel { return levels[levelIndex]; }

  function newFrameRecord(clock: GpuClockName, frameIntervalMs: number | null): GpuClockFrame {
    return {
      level: levelIndex,
      clock,
      seq: seq++,
      submitMs: 0,
      readingMs: null,
      askReadingMs: null,
      spanMs: null,
      preDrainMs: null,
      polls: 0,
      pollCostMs: 0,
      pollIntervalMeanMs: null,
      pollIntervalMaxMs: null,
      firstPollSignalled: false,
      capped: false,
      frameIntervalMs,
    };
  }

  function drawFence(record: GpuClockFrame, draw: () => void, mode: 'end' | 'start' | 'drained') {
    // A fence before the draws is the control: it signals when the commands
    // ALREADY queued complete, which can be while this frame is still being
    // drawn.
    const before = mode === 'start';
    if (mode === 'drained') {
      // Whatever the previous frames left is waited out first, so the fence
      // times this frame's work and not a backlog the renderer was allowed to
      // build ahead of the GPU.
      const d0 = performance.now();
      readback!.wait();
      record.preDrainMs = performance.now() - d0;
    }
    let sync: WebGLSync | null = null;
    let submittedAt = 0;
    if (before) {
      sync = gl2.fenceSync(gl2.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl2.flush();
      submittedAt = performance.now();
    }
    const t0 = performance.now();
    draw();
    const afterDraws = performance.now();
    record.submitMs = afterDraws - t0;
    if (!before) {
      sync = gl2.fenceSync(gl2.SYNC_GPU_COMMANDS_COMPLETE, 0);
      // Under rAF the frame boundary would flush anyway, but only after this
      // callback returns — the fence has to be in the driver before the poll
      // loop's first task, or the first tasks poll something unsubmitted.
      gl2.flush();
      submittedAt = performance.now();
    }
    if (!sync) {
      record.capped = true;
      level().notes.push('fenceSync returned null: the context refused a sync object.');
      return;
    }
    const keep = level().samplePolls.length === 0 && record.clock === 'fence';
    outstandingPolls += 1;
    const submitted = submittedAt;
    // The shared loop (app/fencePoll.ts), with the measurement's own options:
    // its task source, its stride and its raw stamps.
    cancelPoll = pollFence(gl2, sync, submitted, {
      source: opts.poll.source,
      stride: opts.poll.stride,
      capMs: opts.poll.capMs,
      capPolls: opts.poll.capPolls,
      keepStamps: keep ? opts.poll.keepStamps : 0,
    }, (out) => {
      outstandingPolls -= 1;
      cancelPoll = null;
      record.readingMs = out.signalledAtMs === null ? null : out.signalledAtMs - submitted;
      record.askReadingMs = out.askedAtMs === null ? null : out.askedAtMs - submitted;
      record.capped = out.capped;
      record.firstPollSignalled = out.signalledOnFirstPoll;
      record.polls = out.polls;
      record.pollCostMs = out.costMs;
      record.pollIntervalMeanMs = out.intervalMeanMs;
      record.pollIntervalMaxMs = out.intervalMaxMs;
      if (keep) {
        const lv = levels[record.level];
        lv.samplePolls = out.stamps.map((s, i) => ({
          before: Math.round((s.before - submitted) * 1000) / 1000,
          after: Math.round((s.after - submitted) * 1000) / 1000,
          signalled: i === out.stamps.length - 1 && !out.capped,
        }));
        lv.samplePollSummary = summarisePolls(out.stamps);
      }
    });
  }

  function drawReadback(record: GpuClockFrame, draw: () => void) {
    // Everything the previous frame left is waited out first, so the span is
    // this frame's own — the shape devGpuProfile measures a total frame with.
    const d0 = performance.now();
    readback!.wait();
    const drained = performance.now();
    record.preDrainMs = drained - d0;
    draw();
    const submitted = performance.now();
    record.submitMs = submitted - drained;
    readback!.wait();
    const completed = performance.now();
    record.readingMs = completed - submitted;
    record.spanMs = completed - drained;
  }

  function drawTimer(record: GpuClockFrame, draw: () => void) {
    if (!timerExt) {
      record.capped = true;
      return;
    }
    const query = gl2.createQuery();
    if (!query) { record.capped = true; return; }
    gl2.beginQuery(timerExt.TIME_ELAPSED_EXT, query);
    const t0 = performance.now();
    draw();
    gl2.endQuery(timerExt.TIME_ELAPSED_EXT);
    record.submitMs = performance.now() - t0;
    pendingTimers.push({ record, query });
  }

  function resolveTimers(force: boolean): boolean {
    if (!timerExt || pendingTimers.length === 0) return true;
    const disjoint = gl.getParameter(timerExt.GPU_DISJOINT_EXT) === true;
    if (disjoint) notes.push('The GPU timer reported a disjoint interval: its readings in this run are void.');
    let all = true;
    for (let i = pendingTimers.length - 1; i >= 0; i--) {
      const { record, query } = pendingTimers[i];
      const ready = gl2.getQueryParameter(query, gl2.QUERY_RESULT_AVAILABLE) === true;
      if (!ready && !force) { all = false; continue; }
      if (ready && !disjoint) {
        record.readingMs = Number(gl2.getQueryParameter(query, gl2.QUERY_RESULT)) / 1e6;
      } else {
        record.capped = true;
      }
      gl2.deleteQuery(query);
      pendingTimers.splice(i, 1);
    }
    return all;
  }

  function summariseLevel(lv: GpuClockLevel, stamps: readonly number[]) {
    const byClock = new Map<GpuClockName, GpuClockFrame[]>();
    for (const f of lv.frames) {
      const list = byClock.get(f.clock) ?? [];
      list.push(f);
      byClock.set(f.clock, list);
    }
    const readings = (name: GpuClockName) =>
      (byClock.get(name) ?? []).map((f) => f.readingMs).filter((v): v is number => v !== null);
    const readbackReadings = readings('readback');
    const timerReadings = readings('timer');
    for (const [name, frames] of byClock) {
      const own = frames.map((f) => f.readingMs).filter((v): v is number => v !== null);
      lv.arms[name] = {
        n: frames.length,
        reading: summarise(own),
        askReading: summarise(frames.map((f) => f.askReadingMs).filter((v): v is number => v !== null)),
        submit: summarise(frames.map((f) => f.submitMs)),
        frameInterval: summarise(frames.map((f) => f.frameIntervalMs).filter((v): v is number => v !== null)),
        polls: summarise(frames.map((f) => f.polls).filter((v) => v > 0)),
        pollCostMs: summarise(frames.filter((f) => f.polls > 0).map((f) => f.pollCostMs)),
        pollIntervalMs: summarise(frames.map((f) => f.pollIntervalMeanMs).filter((v): v is number => v !== null)),
        capped: frames.filter((f) => f.capped).length,
        firstPollSignalled: frames.filter((f) => f.firstPollSignalled).length,
        biasVsReadbackMs: name === 'readback' ? null : deltaOfMedians(own, readbackReadings),
        biasVsTimerMs: name === 'timer' ? null : deltaOfMedians(own, timerReadings),
      };
    }
    lv.drawnRateHz = ratePerSecond(stamps);
    lv.drawnIntervalMs = summarise(intervalsOf(stamps));
  }

  function finishRun() {
    resolveTimers(true);
    levels.forEach((lv, i) => summariseLevel(lv, levelStamps[i] ?? []));
    const canvas = gl.canvas as HTMLCanvasElement;
    const result: GpuClockResult = {
      at: new Date().toISOString(),
      userAgent: navigator.userAgent,
      devicePixelRatio: window.devicePixelRatio,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      clockGranularityMs: clockGranularity(),
      crossOriginIsolated: typeof crossOriginIsolated === 'boolean' ? crossOriginIsolated : false,
      poll: opts.poll,
      framesPerClock: opts.frames,
      gpu: {
        timerQuery: timerExt !== null,
        // `queryCounterEXT` is the timestamp half of the extension, which the
        // spec lets an implementation leave out while TIME_ELAPSED works.
        timestampCounter: timerExt ? typeof timerExt.queryCounterEXT === 'function' : null,
        renderer: (() => {
          const info = gl.getExtension('WEBGL_debug_renderer_info') as { UNMASKED_RENDERER_WEBGL: number } | null;
          if (!info) return gl.getParameter(gl.RENDERER) as string;
          return gl.getParameter(info.UNMASKED_RENDERER_WEBGL) as string;
        })(),
        maxClientWaitTimeoutMs: (() => {
          const ns = gl.getParameter(gl2.MAX_CLIENT_WAIT_TIMEOUT_WEBGL);
          return typeof ns === 'number' ? ns / 1e6 : null;
        })(),
      },
      levels,
      notes: [...notes, `canvas ${canvas?.width ?? 0}×${canvas?.height ?? 0}`],
    };
    const done = resolveRun;
    cleanup();
    done?.(result);
  }

  function cleanup() {
    cancelPoll?.();
    cancelPoll = null;
    outstandingPolls = 0;
    for (const { query } of pendingTimers) gl2.deleteQuery(query);
    pendingTimers.length = 0;
    readback?.dispose();
    readback = null;
    deps.pinRatio(null);
    active = false;
    resolveRun = null;
    rejectRun = null;
  }

  function advanceLevel() {
    summariseLevel(level(), levelStamps[levelIndex] ?? []);
    levelIndex += 1;
    if (levelIndex >= levels.length) { finishRun(); return; }
    measuredInLevel = 0;
    framesInPhase = 0;
    phase = 'settle';
    deps.pinRatio(levels[levelIndex].ratio);
  }

  function frame(renderWorld: () => void, renderChart: () => void) {
    const draw = () => { renderWorld(); renderChart(); };
    if (!active) { draw(); return; }
    try {
      const now = performance.now();
      const interval = lastFrameAtMs === null ? null : now - lastFrameAtMs;
      lastFrameAtMs = now;
      if (now - runStartedMs > opts.timeoutMs) {
        notes.push(`The run passed its ${Math.round(opts.timeoutMs / 1000)} s limit at level ${levelIndex}; the record is partial.`);
        draw();
        finishRun();
        return;
      }
      if (phase === 'settle') {
        draw();
        if (++framesInPhase >= opts.settleFrames) {
          framesInPhase = 0;
          phase = 'measure';
          level().targets = deps.targets();
        }
        return;
      }
      if (phase === 'drain') {
        draw();
        const timersIn = resolveTimers(false);
        const pollsIn = outstandingPolls === 0;
        if ((timersIn && pollsIn) || ++framesInPhase >= opts.drainFrames) {
          if (!timersIn || !pollsIn) {
            level().notes.push('Some readings never arrived before the level ended.');
            resolveTimers(true);
            cancelPoll?.();
            outstandingPolls = 0;
          }
          advanceLevel();
        }
        return;
      }
      // measure
      const clock = opts.clocks[measuredInLevel % opts.clocks.length];
      const fenceClock = clock !== 'readback' && clock !== 'timer';
      if (fenceClock && outstandingPolls > 0) {
        // One fence at a time, or this frame's reading would measure the last
        // frame's tail. The frame is drawn and thrown away rather than
        // charged to the arm: at a load where a poll loop outlives the frame
        // interval, consuming the slot would hand every one of this arm's
        // frames to the arm before it and leave this one with nothing.
        draw();
        level().skipped += 1;
        return;
      }
      const record = newFrameRecord(clock, interval);
      levelStamps[levelIndex].push(now);
      if (clock === 'readback') drawReadback(record, draw);
      else if (clock === 'timer') drawTimer(record, draw);
      else drawFence(record, draw, clock === 'fence-start' ? 'start' : clock === 'fence-drained' ? 'drained' : 'end');
      level().frames.push(record);
      measuredInLevel += 1;
      if (measuredInLevel >= opts.frames * opts.clocks.length) {
        framesInPhase = 0;
        phase = 'drain';
      }
    } catch (err) {
      const fail = rejectRun;
      cleanup();
      fail?.(err);
    }
  }

  function run(options: GpuClockOptions = {}): Promise<GpuClockResult> {
    if (active) return Promise.reject(new Error('A GPU clock run is already going'));
    const poll: Required<GpuClockPollOptions> = {
      source: options.poll?.source ?? 'window',
      stride: Math.max(1, Math.round(options.poll?.stride ?? 1)),
      capMs: options.poll?.capMs ?? 80,
      capPolls: Math.max(1, Math.round(options.poll?.capPolls ?? 20000)),
      keepStamps: Math.max(1, Math.round(options.poll?.keepStamps ?? 600)),
    };
    const wanted = options.clocks ?? ['fence', 'readback', 'timer'];
    opts = {
      frames: Math.max(1, Math.round(options.frames ?? 40)),
      ratios: options.ratios ?? [null],
      clocks: wanted,
      poll,
      settleFrames: Math.max(1, Math.round(options.settleFrames ?? 20)),
      drainFrames: Math.max(1, Math.round(options.drainFrames ?? 60)),
      timeoutMs: options.timeoutMs ?? 240000,
    };
    if (typeof gl2.fenceSync !== 'function') {
      return Promise.reject(new Error('This context is not WebGL2: there is no fenceSync to measure.'));
    }
    timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2') as typeof timerExt;
    notes.length = 0;
    if (!timerExt && opts.clocks.includes('timer')) {
      notes.push('EXT_disjoint_timer_query_webgl2 is absent on this engine: the timer arm has no readings (on WebKit it needs the WebGL Timer Queries feature flag).');
    }
    readback = createReadbackWait(gl);
    levels = opts.ratios.map((ratio) => ({
      ratio,
      targets: null,
      arms: {},
      drawnRateHz: null,
      drawnIntervalMs: null,
      samplePolls: [],
      samplePollSummary: null,
      frames: [],
      skipped: 0,
      notes: [],
    }));
    levelIndex = 0;
    phase = 'settle';
    framesInPhase = 0;
    measuredInLevel = 0;
    seq = 0;
    levelStamps = levels.map(() => []);
    lastFrameAtMs = null;
    runStartedMs = performance.now();
    deps.pinRatio(levels[0].ratio);
    return new Promise((resolve, reject) => {
      resolveRun = resolve;
      rejectRun = reject;
      active = true;
    });
  }

  return {
    frame,
    get active() { return active; },
    run,
  };
}
