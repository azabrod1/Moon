/**
 * gpuFrameClock — the frame clock Dynamic steers by where the display's tick
 * cannot: when did the GPU finish the frame the app just drew?
 *
 * The resolution controller (app/resolutionController.ts) senses the interval
 * between drawn frames, and vsync rounds that to whole ticks: on a 60 Hz
 * display a 3 ms frame and a 15 ms frame both read 16.67, so the rule cannot
 * see headroom and never takes a rung above Medium there. This sensor gives it
 * a sub-tick reading on exactly those displays, and nowhere else.
 *
 * **What a reading is.** A WebGL2 fence goes in at the end of the frame's
 * draws (after the corner chart), followed by a `flush()` so it is submitted
 * at once, and a task loop (app/fencePoll.ts) asks its status until it
 * signals. The reading is the moment the loop saw it signalled less the
 * moment the frame's animation callback started — one subtraction: the time
 * the main thread spent building the frame plus however long after the
 * hand-over the GPU took to finish it. A fence signals when everything queued
 * before it has completed, so on a device that is behind a reading is the
 * latency to drain the queue, never a cost; the controller only ever holds it
 * against a bar. The reading's own meaning, its uncertainty and the sensor's
 * price are app/gpuFrameClockPolicy.ts.
 *
 * **What is thrown away, and why.** A reading whose signalling poll came
 * after a gap the clock cannot vouch for is STARVED — the main thread was
 * busy when it mattered and the reading may be late by the whole gap — and
 * never enters a statistic. A fence still unsignalled one and a quarter
 * budgets after the frame began is CAPPED: the loop stops, and the reading
 * counts as over the bar. The controller admits a reading only paired with
 * the verdict on the interval of the frame it measured: a frame whose interval
 * did not count (sliced work, a veil, a blur, a settle) says nothing about
 * what the pixels cost, and a reading from before the last rung change, ladder
 * or budget change measured another configuration.
 *
 * **When it samples.** Only where the controller will read the clock — a
 * display MEASURED to have no finer tick than the budget (a 60 Hz the frame
 * schedule merely assumed may be a 120 Hz panel), under Screen, at Dynamic, with a
 * rung above Medium to earn or one the clock already earned, and not while
 * a run of refusals at Medium has rested it (the controller's `wantsClock`)
 * — and only on frames that could count: the planetarium,
 * visible, focused, uncovered, no veil, the map closed, no DEV profile, clock
 * or sweep, the context alive. One eligible frame in the duty is fenced, the
 * first CLEAN one once the count runs out, one fence in flight. While the
 * sensor is in that state it flushes EVERY drawn frame, not only the fenced
 * ones: an explicit flush submits the frame's GPU work before the browser's
 * own rendering update, where an unflushed frame submits after it, and a
 * fenced frame alone would then overlap its GPU work with that update and
 * read optimistically. Everywhere else — a 120 Hz display, a Frame rate row,
 * a fixed level, the map, the other modes — it issues no fence and no flush,
 * and the frame is exactly what it was without it.
 *
 * **What it costs, and who pays.** Two prices (app/gpuFrameClockPolicy.ts):
 * the CPU it executes — the fence, every flush, every poll task's handler, the
 * bookkeeping — per drawn frame, and the WALL time its poll campaigns keep the
 * main thread turning over, as a share of the elapsed time. Either over its
 * bar and the duty doubles, 4 to 8 to 16; still over at 16 the sensor is off
 * for the session. A flush the engine blocks in while the GPU is behind is
 * charged to the sensor like the rest of its CPU, so a GPU-bound stretch can
 * price it off: conservative, and said so in the policy. The CPU is kept out of the app's own busy figures, which is
 * what the controller's main-thread test reads, and each stretch of it comes
 * with the moment it began, so the caller can hand the controller, as the
 * interval's `sensorMs`, only the part that ran after the next frame was due:
 * an interval the sensor really held back is excluded from the evidence about
 * pixels rather than charged to them. That can only be seen where the
 * intervals are not quantised to a display tick: on a vsync-locked display a
 * frame the sensor made late misses a whole tick, which only a tick's worth
 * of the sensor's work past the due time could explain, so there the
 * exclusion never fires and such an interval counts against the pixels — the
 * conservative direction. The rest of the loop runs in time the
 * main thread had spare between frames and delays nothing — on this project's
 * Mac in WebKit the callback after a sampled frame started no later than the
 * one after any other, at one sample in four and in sixteen, at every rung —
 * so charging it would throw away readings of frames that were merely
 * jittered by a millisecond. The campaign's wall time is never charged to a
 * frame at all — it is occupancy, not proven delay.
 *
 * **Kill switch.** `?gpuclock=0` (any build) turns it off for the session:
 * no fence, no flush, and the controller exactly as it was before there was a
 * clock. In DEV `__moon.gpuFrameClock({ on })` does the same live.
 */

import { createTaskPump, pollFence, type FencePollSource, type TaskPump } from './fencePoll';
import {
  GpuClockPolicy,
  capMsFor,
  type ClassifiedReading,
  type PriceVerdict,
} from './gpuFrameClockPolicy';

/** A finished, classified sample, tagged with the frame it measured. */
interface GpuFrameSample extends ClassifiedReading {
  /** The draw the fence closed. */
  drawSeq: number;
  /** The controller's generation at the end of that draw. */
  generation: number;
  /** When that draw's callback started. */
  sampledAtMs: number;
}

/** One drawn frame, as the sensor needs to see it at the end of its draw. */
interface GpuFrameContext {
  /** The draw's sequence number. */
  drawSeq: number;
  /** When the tick's animation callback started. */
  callbackStartMs: number;
  /** The controller will read a reading right now. */
  wanted: boolean;
  /** The controller is verifying a rung the clock earned: sample one frame in
   *  four until it is done, whatever the priced duty. */
  verifying: boolean;
  /** The frame could count: the planetarium, visible, focused, uncovered, no
   *  veil, the map closed, nothing measuring it. */
  eligible: boolean;
  /** No sliced work and no program link in this tick. */
  clean: boolean;
  /** What a frame is held to where the clock steers. */
  barMs: number;
  /** The controller's generation now, after any decision this tick applied. */
  generation: number;
}

interface GpuFrameClockDeps {
  gl: WebGLRenderingContext | WebGL2RenderingContext;
  /** `?gpuclock=0`. */
  killed: boolean;
  /** A finished sample. Called from the poll loop's task, between frames. */
  onSample: (sample: GpuFrameSample) => void;
  /** CPU the sensor executed on the main thread, as it is spent, with the
   *  moment that stretch began. */
  onWork: (ms: number, startedAtMs: number) => void;
  /** The duty moved: every reading taken at the old one is dropped. */
  onDuty?: (duty: number) => void;
  /** The sensor turned itself off for the session. */
  onDisabled?: (reason: string) => void;
  /** Where the poll loop's tasks come from: the page's own task sources,
   *  unless a test hands in a pump it runs by hand. */
  createPump?: (source: FencePollSource) => TaskPump;
}

interface GpuFrameClockState {
  /** Whether the sensor can run at all on this context. */
  available: boolean;
  /** Why it is not running, or null. */
  reason: string | null;
  duty: number;
  sampled: number;
  discardedStarved: number;
  discardedCapped: number;
  discardedInvalid: number;
  skippedArms: number;
  /** Everything the sensor executed, per sample and per drawn frame, over the
   *  last priced block. */
  costPerSampleMs: number | null;
  costPerFrameMs: number | null;
  /** The poll campaigns' wall span per sample, and as a share of the elapsed
   *  time, over the same block. */
  campaignPerSampleMs: number | null;
  campaignShare: number | null;
  /** Over the session. */
  sessionCostPerFrameMs: number | null;
  sessionCampaignShare: number | null;
  medianMs: number | null;
  p90Ms: number | null;
  starvedShare: number | null;
  disabled: string | null;
  source: FencePollSource | null;
  trialGapsMs: Record<FencePollSource, number | null>;
  gridMs: number | null;
  inFlight: boolean;
  flushEvery: boolean;
  /** DEV: sampling regardless of what the controller wants. */
  forced: boolean;
  /** DEV: sampling stopped without telling the controller. */
  muted: boolean;
}

/** One finished sample as the DEV record keeps it. */
interface GpuFrameSampleRecord {
  atMs: number;
  drawSeq: number;
  readingMs: number;
  busyMs: number;
  starved: boolean;
  capped: boolean;
  invalid: boolean;
  signalGapMs: number | null;
  polls: number;
  campaignMs: number;
  execMs: number;
  source: FencePollSource;
  duty: number;
}

interface GpuFrameClock {
  /** At the end of a drawn frame's draws. Flushes while active; fences the
   *  sampled frame. */
  afterDraw(frame: GpuFrameContext): void;
  /** The sensor may still be asked to run: false once killed, disabled, lost
   *  or without WebGL2. */
  readonly usable: boolean;
  /** Whether a frame the controller does (or does not) want read would be
   *  flushed or fenced at all — the DEV force and mute included — so the
   *  caller can skip the frame's clock work entirely when not. */
  activeFor(wanted: boolean): boolean;
  state(): GpuFrameClockState;
  /** Off for the session, with the reason. */
  disable(reason: string): void;
  /** DEV: on or off live; force samples regardless of the controller (the
   *  pixel gate's arm); mute stops sampling without telling the controller
   *  (the inject arm); flushEvery false flushes only the fenced frames (the
   *  flush A/B); duty pins one. */
  devSet(opts: { on?: boolean; force?: boolean; mute?: boolean; flushEvery?: boolean; duty?: number; record?: number }): void;
  /** DEV: the samples kept since `record` was set, and clears them. */
  devTakeSamples(): GpuFrameSampleRecord[];
}

export function createGpuFrameClock(deps: GpuFrameClockDeps): GpuFrameClock {
  const gl = deps.gl;
  const gl2 = gl as WebGL2RenderingContext;
  const webgl2 = typeof gl2.fenceSync === 'function' && typeof gl2.getSyncParameter === 'function';
  const policy = new GpuClockPolicy();
  let unavailable: string | null = deps.killed ? 'turned off by ?gpuclock=0'
    : !webgl2 ? 'this context is not WebGL2, so there is no fence to read'
      : null;
  let devOff = false;
  let forced = false;
  let muted = false;
  let flushEvery = true;
  let inFlight = false;
  let cancelPoll: (() => void) | null = null;
  let recordMax = 0;
  let recorded: GpuFrameSampleRecord[] = [];
  const pumps: Partial<Record<FencePollSource, TaskPump>> = {};

  const pumpFor = (source: FencePollSource): TaskPump => {
    let pump = pumps[source];
    if (!pump) {
      pump = (deps.createPump ?? createTaskPump)(source);
      pumps[source] = pump;
    }
    return pump;
  };

  const running = (): boolean => unavailable === null && policy.disabled === null && !devOff;

  /** Once the trial has kept one task source, the other — a window listener
   *  or a channel's two ports — has no further use for the session. */
  const releaseLoser = () => {
    const kept = policy.source;
    if (kept === null) return;
    for (const key of Object.keys(pumps) as FencePollSource[]) {
      if (key === kept) continue;
      pumps[key]?.dispose();
      delete pumps[key];
    }
  };

  const stopLoop = () => {
    cancelPoll?.();
    cancelPoll = null;
    inFlight = false;
  };

  const turnOff = (reason: string) => {
    policy.disable(reason);
    stopLoop();
    for (const key of Object.keys(pumps) as FencePollSource[]) {
      pumps[key]?.dispose();
      delete pumps[key];
    }
    deps.onDisabled?.(reason);
  };

  const onVerdict = (verdict: PriceVerdict) => {
    if (verdict === null) return;
    if (verdict.kind === 'duty') deps.onDuty?.(verdict.duty);
    else turnOff(verdict.reason);
  };

  const activeFor = (wanted: boolean): boolean => running() && (forced || (wanted && !muted));

  function afterDraw(frame: GpuFrameContext): void {
    if (!activeFor(frame.wanted)) return;
    const t0 = performance.now();
    policy.noteFrame(frame.callbackStartMs, frame.verifying);
    const armed = frame.eligible && policy.armFrame(frame.clean, inFlight, frame.verifying);
    let sync: WebGLSync | null = null;
    if (armed) sync = gl2.fenceSync(gl2.SYNC_GPU_COMMANDS_COMPLETE, 0);
    // Every frame while active, so the fenced frame is submitted at the same
    // point as every other; without a fence to submit, only while flushEvery
    // is on (the DEV A/B).
    if (armed || flushEvery) gl2.flush();
    const submittedAtMs = performance.now();
    const inTick = submittedAtMs - t0;
    policy.noteCpu(inTick, policy.inBurst(frame.verifying));
    deps.onWork(inTick, t0);
    if (!armed) return;
    if (sync === null) {
      turnOff('the context refused a sync object');
      return;
    }
    inFlight = true;
    const source = policy.nextSource();
    const drawSeq = frame.drawSeq;
    const generation = frame.generation;
    const callbackStartMs = frame.callbackStartMs;
    const burst = policy.sampleInBurst;
    cancelPoll = pollFence(gl2, sync, submittedAtMs, {
      pump: pumpFor(source),
      capMs: capMsFor(frame.barMs),
      capFromMs: callbackStartMs,
      onTask: (ms, entryMs) => {
        policy.noteCpu(ms, burst);
        deps.onWork(ms, entryMs);
      },
    }, (result) => {
      const b0 = performance.now();
      cancelPoll = null;
      inFlight = false;
      const { reading, verdict } = policy.recordSample({
        source,
        callbackStartMs,
        submittedAtMs,
        signalledAtMs: result.signalledAtMs,
        signalGapMs: result.signalGapMs,
        capped: result.capped,
        intervalMeanMs: result.intervalMeanMs,
        minStepMs: result.minStepMs,
        gridSteps: result.gridSteps,
        campaignMs: result.campaignMs,
      });
      if (recordMax > 0 && recorded.length < recordMax) {
        recorded.push({
          atMs: callbackStartMs,
          drawSeq,
          readingMs: reading.readingMs,
          busyMs: reading.busyMs,
          starved: reading.starved,
          capped: reading.capped,
          invalid: reading.invalid,
          signalGapMs: result.signalGapMs,
          polls: result.polls,
          campaignMs: result.campaignMs,
          execMs: result.execMs,
          source,
          duty: policy.duty,
        });
      }
      const grid = policy.gridVerdict();
      if (grid === 'coarse') {
        turnOff(policy.gridMs === null
          ? 'the page\'s clock never moved inside a poll'
          : `the page's clock only resolves ${Math.round(policy.gridMs * 1000) / 1000} ms`);
      } else if (verdict === null && !reading.invalid && grid === 'fine') {
        // A duty change drops every reading taken at the old duty, this one
        // with it; a sensor that priced itself out delivers nothing more; and
        // a reading from a clock whose grid is not yet known cannot steer.
        deps.onSample({ ...reading, drawSeq, generation, sampledAtMs: callbackStartMs });
      }
      onVerdict(verdict);
      releaseLoser();
      const book = performance.now() - b0;
      policy.noteCpu(book, burst);
      deps.onWork(book, b0);
    });
  }

  function state(): GpuFrameClockState {
    const recent = policy.recentStats();
    return {
      available: unavailable === null,
      reason: unavailable ?? policy.disabled ?? (devOff ? 'turned off from the bridge' : null),
      duty: policy.duty,
      sampled: policy.sampled,
      discardedStarved: policy.starvedCount,
      discardedCapped: policy.cappedCount,
      discardedInvalid: policy.invalidCount,
      skippedArms: policy.skippedArms,
      costPerSampleMs: policy.lastCpuPerSampleMs,
      costPerFrameMs: policy.lastCpuPerFrameMs,
      campaignPerSampleMs: policy.lastCampaignPerSampleMs,
      campaignShare: policy.lastCampaignShare,
      sessionCostPerFrameMs: policy.totalFrames > 0 ? policy.totalCpuMs / policy.totalFrames : null,
      sessionCampaignShare: policy.totalElapsedMs > 0 ? policy.totalCampaignMs / policy.totalElapsedMs : null,
      medianMs: recent.medianMs,
      p90Ms: recent.p90Ms,
      starvedShare: recent.starvedShare,
      disabled: policy.disabled,
      source: policy.source,
      trialGapsMs: policy.trialGaps(),
      gridMs: policy.gridMs,
      inFlight,
      flushEvery,
      forced,
      muted,
    };
  }

  return {
    afterDraw,
    get usable() { return running(); },
    activeFor,
    state,
    disable(reason: string) {
      if (unavailable !== null || policy.disabled !== null) return;
      turnOff(reason);
    },
    devSet(opts) {
      if (opts.on !== undefined) {
        devOff = !opts.on;
        if (devOff) stopLoop();
      }
      if (opts.force !== undefined) forced = opts.force;
      if (opts.mute !== undefined) {
        muted = opts.mute;
        if (muted) stopLoop();
      }
      if (opts.flushEvery !== undefined) flushEvery = opts.flushEvery;
      if (opts.duty !== undefined && Number.isFinite(opts.duty) && opts.duty >= 1) {
        policy.duty = Math.round(opts.duty);
        policy.dutyPinned = true;
        policy.resetBlock();
        stopLoop();
        deps.onDuty?.(policy.duty);
      }
      if (opts.record !== undefined) {
        recordMax = Math.max(0, Math.round(opts.record));
        recorded = [];
      }
    },
    devTakeSamples() {
      const out = recorded;
      recorded = [];
      return out;
    },
  };
}

/** `?gpuclock=0` turns the sensor off in any build. */
export function parseGpuClockParam(search: string): boolean {
  return new URLSearchParams(search).get('gpuclock') === '0';
}
