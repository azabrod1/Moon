/**
 * DEV-only, low-overhead Surface-view timing trace.
 *
 * Nothing logs per frame. A bounded in-memory trace is armed explicitly via
 * `window.__moon.surfacePerf('start')`; input gestures open a short sampling
 * window around the relevant renders. Production builds fold every hook to a
 * no-op behind import.meta.env.DEV.
 */

const MAX_SAMPLES = 256;
const INPUT_FOCUS_MS = 1_500;

interface InputSample {
  phase: 'pointerdown' | 'pointerup' | 'click';
  id: string;
  atMs: number;
  eventAtMs: number;
  deliveryDelayMs: number;
  visibilityState: DocumentVisibilityState;
  hasFocus: boolean;
  sincePointerUpMs?: number;
  nextFrameAtMs?: number;
  nextFrameGapMs?: number | null;
}

interface SpanSample {
  name: string;
  atMs: number;
  durationMs: number;
  details?: Record<string, unknown>;
}

interface FrameSample {
  atMs: number;
  gapMs: number | null;
  sinceInputMs: number | null;
}

interface RenderSample {
  atMs: number;
  durationMs: number;
  programsBefore: number;
  programsAfter: number;
  texturesBefore: number;
  texturesAfter: number;
}

interface UploadSample {
  atMs: number;
  durationMs: number;
  name: string;
  width: number | null;
  height: number | null;
}

interface SurfacePerfTrace {
  startedAtMs: number;
  environment: Record<string, unknown>;
  inputs: InputSample[];
  spans: SpanSample[];
  frames: FrameSample[];
  renders: RenderSample[];
  uploads: UploadSample[];
}

export interface SurfacePerfSpanToken {
  name: string;
  startedAtMs: number;
}

export interface SurfacePerfRenderToken {
  startedAtMs: number;
  programsBefore: number;
  texturesBefore: number;
}

export interface SurfacePerfUploadToken {
  startedAtMs: number;
  name: string;
  width: number | null;
  height: number | null;
}

let trace: SurfacePerfTrace | null = null;
let focusUntilMs = 0;
let lastRafMs: number | null = null;
let lastInputMs: number | null = null;
let pendingInputFrame = false;
let inputTracingWired = false;
const pointerUpById = new Map<string, number>();

const rounded = (value: number): number => Math.round(value * 100) / 100;

function pushBounded<T>(list: T[], value: T): void {
  if (list.length === MAX_SAMPLES) list.shift();
  list.push(value);
}

function relativeMs(absoluteMs: number): number {
  return trace ? rounded(absoluteMs - trace.startedAtMs) : 0;
}

function isSurfaceControl(target: EventTarget | null): HTMLElement | null {
  const button = target instanceof Element ? target.closest<HTMLElement>('button') : null;
  if (!button?.id) return null;
  if (
    button.id === 'observatory-lookup' ||
    button.id.startsWith('surface-') ||
    /^observatory-(?:prev|next)-/.test(button.id)
  ) return button;
  return null;
}

export function installSurfacePerfInputTracing(): void {
  if (!import.meta.env.DEV || inputTracingWired) return;
  inputTracingWired = true;
  for (const phase of ['pointerdown', 'pointerup', 'click'] as const) {
    document.addEventListener(phase, (event) => {
      if (!trace) return;
      const button = isSurfaceControl(event.target);
      if (!button) return;
      const deliveredAtMs = performance.now();
      const eventAtMs = Number.isFinite(event.timeStamp) && event.timeStamp > 0
        ? event.timeStamp
        : deliveredAtMs;
      const sample: InputSample = {
        phase,
        id: button.id,
        atMs: relativeMs(deliveredAtMs),
        eventAtMs: relativeMs(eventAtMs),
        deliveryDelayMs: rounded(Math.max(0, deliveredAtMs - eventAtMs)),
        visibilityState: document.visibilityState,
        hasFocus: document.hasFocus(),
      };
      if (phase === 'pointerup') pointerUpById.set(button.id, deliveredAtMs);
      if (phase === 'pointerup' || phase === 'click') {
        lastInputMs = deliveredAtMs;
        // Surface's critical controls act on pointerup in Safari because the
        // browser can omit the subsequent click during rapid HUD changes.
        // Arm frame capture for both phases; a normal click simply refreshes
        // the same short focus window a moment later.
        pendingInputFrame = true;
        focusUntilMs = deliveredAtMs + INPUT_FOCUS_MS;
      }
      if (phase === 'click') {
        const pointerUpMs = pointerUpById.get(button.id);
        if (pointerUpMs !== undefined) sample.sincePointerUpMs = rounded(deliveredAtMs - pointerUpMs);
        // Capture listener runs before the button's target listener. The first
        // microtask therefore measures the synchronous dispatch/handler bill
        // without adding wrappers to every Surface control.
        const activeTrace = trace;
        const buttonId = button.id;
        queueMicrotask(() => {
          if (!trace || trace !== activeTrace) return;
          pushBounded(trace.spans, {
            name: `click:${buttonId}`,
            atMs: relativeMs(deliveredAtMs),
            durationMs: rounded(performance.now() - deliveredAtMs),
          });
        });
      }
      pushBounded(trace.inputs, sample);
    }, true);
  }
}

export function startSurfacePerf(environment: Record<string, unknown>): unknown {
  if (!import.meta.env.DEV) return null;
  trace = {
    startedAtMs: performance.now(),
    environment,
    inputs: [],
    spans: [],
    frames: [],
    renders: [],
    uploads: [],
  };
  focusUntilMs = 0;
  lastRafMs = null;
  lastInputMs = null;
  pendingInputFrame = false;
  pointerUpById.clear();
  return surfacePerfSnapshot();
}

export function clearSurfacePerf(): void {
  trace = null;
  focusUntilMs = 0;
  lastRafMs = null;
  lastInputMs = null;
  pendingInputFrame = false;
  pointerUpById.clear();
}

export function surfacePerfBeginSpan(name: string): SurfacePerfSpanToken | null {
  if (!import.meta.env.DEV || !trace) return null;
  const startedAtMs = performance.now();
  focusUntilMs = Math.max(focusUntilMs, startedAtMs + INPUT_FOCUS_MS);
  return { name, startedAtMs };
}

export function surfacePerfEndSpan(
  token: SurfacePerfSpanToken | null,
  details?: Record<string, unknown>,
): void {
  if (!trace || !token) return;
  const endedAtMs = performance.now();
  pushBounded(trace.spans, {
    name: token.name,
    atMs: relativeMs(token.startedAtMs),
    durationMs: rounded(endedAtMs - token.startedAtMs),
    details,
  });
}

export function surfacePerfFrameStart(rafTimestampMs: number): void {
  if (!import.meta.env.DEV || !trace) return;
  const gapMs = lastRafMs === null ? null : rounded(rafTimestampMs - lastRafMs);
  lastRafMs = rafTimestampMs;
  const isFirstFrameAfterInput = pendingInputFrame;
  if (performance.now() > focusUntilMs && !isFirstFrameAfterInput) return;
  if (isFirstFrameAfterInput) {
    pendingInputFrame = false;
    focusUntilMs = performance.now() + INPUT_FOCUS_MS;
  }
  // Resolve input→next-frame while both samples are live. Deriving this later
  // from the bounded frame ring gives old clicks a fake multi-second delay
  // once their real following frame has rolled out of the ring.
  const relativeFrameAtMs = relativeMs(rafTimestampMs);
  for (const input of trace.inputs) {
    if (
      input.phase === 'click' &&
      input.nextFrameAtMs === undefined &&
      input.atMs <= relativeFrameAtMs
    ) {
      input.nextFrameAtMs = relativeFrameAtMs;
      input.nextFrameGapMs = gapMs;
    }
  }
  pushBounded(trace.frames, {
    atMs: relativeFrameAtMs,
    gapMs,
    sinceInputMs: lastInputMs === null ? null : rounded(rafTimestampMs - lastInputMs),
  });
}

export function surfacePerfBeginRender(
  programs: number,
  textures: number,
): SurfacePerfRenderToken | null {
  if (!import.meta.env.DEV || !trace || performance.now() > focusUntilMs) return null;
  return {
    startedAtMs: performance.now(),
    programsBefore: programs,
    texturesBefore: textures,
  };
}

export function surfacePerfEndRender(
  token: SurfacePerfRenderToken | null,
  programsAfter: number,
  texturesAfter: number,
): void {
  if (!trace || !token) return;
  pushBounded(trace.renders, {
    atMs: relativeMs(token.startedAtMs),
    durationMs: rounded(performance.now() - token.startedAtMs),
    programsBefore: token.programsBefore,
    programsAfter,
    texturesBefore: token.texturesBefore,
    texturesAfter,
  });
}

function textureIdentity(tex: { name?: string; image?: unknown }): Omit<SurfacePerfUploadToken, 'startedAtMs'> {
  const image = tex.image as {
    width?: number;
    height?: number;
    currentSrc?: string;
    src?: string;
  } | undefined;
  const src = image?.currentSrc || image?.src || '';
  const basename = src ? src.split(/[/?#]/).filter(Boolean).pop() ?? '' : '';
  return {
    name: tex.name || basename || '(unnamed texture)',
    width: typeof image?.width === 'number' ? image.width : null,
    height: typeof image?.height === 'number' ? image.height : null,
  };
}

export function surfacePerfBeginTextureUpload(
  tex: { name?: string; image?: unknown },
): SurfacePerfUploadToken | null {
  if (!import.meta.env.DEV || !trace) return null;
  return { startedAtMs: performance.now(), ...textureIdentity(tex) };
}

export function surfacePerfEndTextureUpload(token: SurfacePerfUploadToken | null): void {
  if (!trace || !token) return;
  pushBounded(trace.uploads, {
    atMs: relativeMs(token.startedAtMs),
    durationMs: rounded(performance.now() - token.startedAtMs),
    name: token.name,
    width: token.width,
    height: token.height,
  });
}

function maxOf(values: number[]): number {
  return values.length ? Math.max(...values) : 0;
}

export function surfacePerfSnapshot(): unknown {
  if (!trace) return null;
  const clicks = trace.inputs.filter((sample) => sample.phase === 'click');
  const pointerUps = trace.inputs.filter((sample) => sample.phase === 'pointerup');
  // A trace can be armed at boot via ?surfacePerf=1. Keep the raw upload ring
  // intact for startup forensics, but don't attribute old boot uploads to a
  // later Surface gesture in the summary. The small lead-in catches an upload
  // that delayed delivery of the click itself.
  const gestureInputs = pointerUps.length ? pointerUps : clicks;
  const relevantUploads = gestureInputs.length
    ? trace.uploads.filter((upload) => gestureInputs.some((input) =>
      upload.atMs >= input.atMs - 50 && upload.atMs <= input.atMs + INPUT_FOCUS_MS))
    : trace.uploads;
  const followingFrameFor = (input: InputSample) => ({
    id: input.id,
    clickToFrameMs: input.nextFrameAtMs === undefined
      ? null
      : rounded(input.nextFrameAtMs - input.atMs),
    frameGapMs: input.nextFrameGapMs ?? null,
  });
  const followingFrames = clicks.map(followingFrameFor);
  const pointerUpFollowingFrames = pointerUps.map((pointerUp) => {
    return {
      id: pointerUp.id,
      pointerUpToFrameMs: pointerUp.nextFrameAtMs === undefined
        ? null
        : rounded(pointerUp.nextFrameAtMs - pointerUp.atMs),
      frameGapMs: pointerUp.nextFrameGapMs ?? null,
    };
  });
  const renderDurations = trace.renders.map((sample) => sample.durationMs);
  const uploadDurations = relevantUploads.map((sample) => sample.durationMs);
  const frameGaps = trace.frames.flatMap((sample) => sample.gapMs === null ? [] : [sample.gapMs]);
  const firstPrograms = trace.renders[0]?.programsBefore ?? Number(trace.environment.programs ?? 0);
  const lastPrograms = trace.renders.at(-1)?.programsAfter ?? firstPrograms;
  const firstTextures = trace.renders[0]?.texturesBefore ?? Number(trace.environment.textures ?? 0);
  const lastTextures = trace.renders.at(-1)?.texturesAfter ?? firstTextures;
  return {
    environment: trace.environment,
    summary: {
      clickDeliveryMaxMs: maxOf(clicks.map((sample) => sample.deliveryDelayMs)),
      pointerUpCount: pointerUps.length,
      clickCount: clicks.length,
      clicksMissingAfterPointerUp: Math.max(0, pointerUps.length - clicks.length),
      pointerUpToClickMaxMs: maxOf(clicks.flatMap((sample) =>
        sample.sincePointerUpMs === undefined ? [] : [sample.sincePointerUpMs])),
      handlers: trace.spans.map((sample) => ({ name: sample.name, durationMs: sample.durationMs })),
      renderCount: trace.renders.length,
      renderAverageMs: renderDurations.length
        ? rounded(renderDurations.reduce((sum, value) => sum + value, 0) / renderDurations.length)
        : 0,
      renderMaxMs: maxOf(renderDurations),
      followingFrames,
      pointerUpFollowingFrames,
      frameGapMaxMs: maxOf(frameGaps),
      textureUploads: relevantUploads.length,
      textureUploadTotalMs: rounded(uploadDurations.reduce((sum, value) => sum + value, 0)),
      textureUploadMaxMs: maxOf(uploadDurations),
      programDelta: lastPrograms - firstPrograms,
      textureDelta: lastTextures - firstTextures,
    },
    samples: {
      inputs: trace.inputs,
      spans: trace.spans,
      frames: trace.frames,
      renders: trace.renders,
      uploads: trace.uploads,
    },
  };
}

export function stopSurfacePerf(): unknown {
  const snapshot = surfacePerfSnapshot();
  clearSurfacePerf();
  return snapshot;
}
