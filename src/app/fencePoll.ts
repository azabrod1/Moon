/**
 * fencePoll — the one task loop in the app that reads a WebGL2 fence.
 *
 * A fence (`fenceSync(SYNC_GPU_COMMANDS_COMPLETE)` after a frame's draws, then
 * `flush()`) signals when every command queued before it has completed on the
 * GPU. WebGL forbids a blocking wait on it (`MAX_CLIENT_WAIT_TIMEOUT_WEBGL` is
 * zero on every engine measured), so the only way to learn when it signalled
 * is to ask its status again and again. Both engines refresh a sync object's
 * cached status at most once per event-loop TASK, so asking twice inside one
 * task reads the same stale value and the resolution of the reading is the
 * task period — which is why the loop turns over on `window.postMessage` or a
 * `MessageChannel` and never on `setTimeout`, whose nested clamp is 4 ms by
 * spec and far worse on WebKit.
 *
 * The loop only reports facts: when the poll that saw the signal asked and
 * answered, how long the gap before that poll was (the reading's uncertainty —
 * the fence signalled somewhere inside it), how many polls it took and what
 * they cost. What a reading MEANS, and whether it is trusted, is the caller's
 * (app/gpuFrameClockPolicy.ts for the production sensor, app/devGpuClock.ts
 * for the DEV measurement).
 *
 * **What the loop costs** is reported as two different things, never added.
 * EXECUTION is the time inside the loop's own handler, entry to exit, on
 * every task it ran — the status call (a synchronous trip into the GPU
 * process) and the bookkeeping around it: CPU the app's main thread really
 * spent on the sensor. The CAMPAIGN is the wall time from the first task's
 * entry to the last task's exit: how long the loop kept the main thread
 * turning over, which is what holds a core awake on a phone, but which is not
 * proven delay to anything — other tasks run between the loop's own. On a
 * clock with a coarse grid (a millisecond on WebKit) one task's execution
 * reads 0 or 1, and the sum over a loop's tasks is an unbiased estimate of the
 * total.
 */

/** Where the loop's tasks come from. */
export type FencePollSource = 'window' | 'channel';

/** One poll's clock readings either side of the status call. */
interface FencePollStamp {
  before: number;
  after: number;
}

/**
 * A task source the loop can post itself onto, reusable across many fences so
 * a sensor that samples every few frames does not build a channel or add a
 * listener each time.
 */
export interface TaskPump {
  readonly source: FencePollSource;
  /** What the next task runs. One loop at a time owns it. */
  handler: (() => void) | null;
  post(): void;
  dispose(): void;
}

let pumpSerial = 0;

/**
 * `window.postMessage` wakes every `message` listener on the window — an
 * extension's content scripts included — so its messages carry a token and
 * this listener ignores every message that is not its own. A `MessageChannel`
 * is private to its two ports.
 */
export function createTaskPump(source: FencePollSource): TaskPump {
  const token = `moon-fence-poll-${++pumpSerial}`;
  const pump: TaskPump = {
    source,
    handler: null,
    post: () => {},
    dispose: () => {},
  };
  if (source === 'channel') {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => pump.handler?.();
    pump.post = () => channel.port2.postMessage(0);
    pump.dispose = () => {
      channel.port1.onmessage = null;
      channel.port1.close();
      channel.port2.close();
    };
  } else {
    const onMessage = (event: MessageEvent) => {
      if (event.source === window && event.data === token) pump.handler?.();
    };
    window.addEventListener('message', onMessage);
    pump.post = () => window.postMessage(token, '*');
    pump.dispose = () => window.removeEventListener('message', onMessage);
  }
  return pump;
}

interface FencePollOptions {
  /** The task source, where no `pump` is handed in. */
  source?: FencePollSource;
  /** A pump to reuse; the loop takes its handler and leaves it alive. */
  pump?: TaskPump;
  /** Read the status every n-th task. 2 halves the calls and the resolution. */
  stride?: number;
  /** Give up after this long past `capFromMs`: the bound that matters, since
   *  a poll loop turns tasks over far faster than a frame completes. */
  capMs: number;
  /** Where the cap is measured from; the submit when left out. */
  capFromMs?: number;
  /** Give up after this many polls — a backstop, not the bound. */
  capPolls?: number;
  /** How many raw stamps to keep in the result (0 keeps none). */
  keepStamps?: number;
  /** Each task's execution as it is spent, with the moment it began, so a
   *  caller can tell where in the frame's span it landed. */
  onTask?: (execMs: number, entryMs: number) => void;
}

interface FencePollResult {
  /** The clock right after the status call that found the fence signalled,
   *  or null when the loop gave up. */
  signalledAtMs: number | null;
  /** The clock right before that call. */
  askedAtMs: number | null;
  /** The gap before the signalling poll: from the previous poll's ask, or from
   *  the submit where it was the first. The fence signalled somewhere inside
   *  it, so it is the reading's uncertainty. */
  signalGapMs: number | null;
  polls: number;
  /** Main-thread ms inside the status calls. */
  costMs: number;
  /** Main-thread ms inside the loop's handler, every task, entry to exit. */
  execMs: number;
  /** Wall ms from the first task's entry to the last task's exit. */
  campaignMs: number;
  /** The mean and the longest gap between one poll's ask and the next's. */
  intervalMeanMs: number | null;
  intervalMaxMs: number | null;
  /** The smallest non-zero step the clock took inside the loop: its grid,
   *  read off the loop's own stamps. Every non-zero step is a whole number of
   *  grid steps, so the smallest over enough of them IS the grid; over a few
   *  it can be a stretch when other work held the loop, which is why
   *  `gridSteps` comes with it. */
  minStepMs: number | null;
  /** How many non-zero steps that smallest one was taken over. */
  gridSteps: number;
  stamps: FencePollStamp[];
  signalledOnFirstPoll: boolean;
  capped: boolean;
}

/**
 * Poll one fence's status from a task loop until it signals, the cap passes,
 * or the returned cancel is called. The sync object is deleted in every case;
 * `done` is not called after a cancel.
 */
export function pollFence(
  gl2: WebGL2RenderingContext,
  sync: WebGLSync,
  submittedAtMs: number,
  opts: FencePollOptions,
  done: (result: FencePollResult) => void,
): () => void {
  const stride = Math.max(1, Math.round(opts.stride ?? 1));
  const capPolls = Math.max(1, Math.round(opts.capPolls ?? 20000));
  const keepStamps = Math.max(0, Math.round(opts.keepStamps ?? 0));
  const deadlineMs = (opts.capFromMs ?? submittedAtMs) + opts.capMs;
  const ownsPump = opts.pump === undefined;
  const pump = opts.pump ?? createTaskPump(opts.source ?? 'window');
  const stamps: FencePollStamp[] = [];
  let polls = 0;
  let tasks = 0;
  let cancelled = false;
  let finished = false;
  let costMs = 0;
  let execMs = 0;
  let firstEntry = -1;
  let lastExit = -1;
  let intervalSum = 0;
  let intervalMax = 0;
  let minStep = Infinity;
  let gridSteps = 0;
  // The previous poll's ask (none before the first, so the interval figures
  // are poll to poll), and the last moment the loop knew the fence unsignalled
  // — the submit before the first poll.
  let prevAsk = -1;
  let prevAfter = -1;
  let lastUnsignalled = submittedAtMs;

  const release = () => {
    pump.handler = null;
    if (ownsPump) pump.dispose();
    gl2.deleteSync(sync);
  };

  const finish = (signalledAtMs: number | null, askedAtMs: number | null, capped: boolean) => {
    if (finished) return;
    finished = true;
    release();
    done({
      signalledAtMs,
      askedAtMs,
      signalGapMs: askedAtMs === null ? null : askedAtMs - lastUnsignalled,
      polls,
      costMs,
      execMs,
      campaignMs: firstEntry >= 0 && lastExit >= firstEntry ? lastExit - firstEntry : 0,
      intervalMeanMs: polls > 1 ? intervalSum / (polls - 1) : null,
      intervalMaxMs: polls > 1 ? intervalMax : null,
      minStepMs: Number.isFinite(minStep) ? minStep : null,
      gridSteps,
      stamps,
      signalledOnFirstPoll: polls === 1 && signalledAtMs !== null,
      capped,
    });
  };

  // The handler's own execution, charged as it is spent.
  const exit = (entry: number) => {
    const out = performance.now();
    lastExit = out;
    const spent = out - entry;
    execMs += spent;
    opts.onTask?.(spent, entry);
  };

  const step = () => {
    if (cancelled || finished) return;
    const entry = performance.now();
    if (firstEntry < 0) firstEntry = entry;
    tasks += 1;
    if (tasks % stride !== 0) { pump.post(); exit(entry); return; }
    const before = performance.now();
    const status = gl2.getSyncParameter(sync, gl2.SYNC_STATUS);
    const after = performance.now();
    polls += 1;
    const call = after - before;
    costMs += call;
    if (call > 0) {
      gridSteps++;
      if (call < minStep) minStep = call;
    }
    if (prevAfter >= 0) {
      const dispatch = before - prevAfter;
      if (dispatch > 0) {
        gridSteps++;
        if (dispatch < minStep) minStep = dispatch;
      }
    }
    if (prevAsk >= 0) {
      const gap = before - prevAsk;
      intervalSum += gap;
      if (gap > intervalMax) intervalMax = gap;
    }
    if (keepStamps > 0 && stamps.length < keepStamps) stamps.push({ before, after });
    if (status === gl2.SIGNALED) { exit(entry); finish(after, before, false); return; }
    prevAsk = before;
    prevAfter = after;
    lastUnsignalled = before;
    if (polls >= capPolls || before >= deadlineMs) { exit(entry); finish(null, null, true); return; }
    pump.post();
    exit(entry);
  };

  pump.handler = step;
  pump.post();
  return () => {
    if (finished || cancelled) return;
    cancelled = true;
    release();
  };
}
