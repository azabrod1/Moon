/**
 * devGpuProfile — a GPU profile of the world frame, measured on the device
 * that draws it (DEV only; reached through `__moon.gpuProfile()`).
 *
 * The question it answers is "where do the GPU milliseconds of one frame go":
 * per composer pass, and inside the scene pass per drawn object. It is the
 * direct measurement the A/B sweeps (devPerfSweep.ts) only infer by
 * subtraction: a phone has no GPU profiler a browser page can reach, so the
 * page measures itself.
 *
 * Two clocks:
 *  - readback (the default everywhere): the CPU waits for the GPU to
 *    complete the span, and the wall time is the reading. The wait is a
 *    one-pixel readPixels from a private 1×1 framebuffer cleared after the
 *    span: a readback has to return data, so it waits for every command
 *    queued before it. `gl.finish()` is NOT that wait: Chromium implements
 *    it as a flush, and WebKit sends it to its GPU process without waiting
 *    for a reply (measured: finish returned in the CPU's submit time, and
 *    the frame's whole GPU wait landed on the next readback). A fence cannot
 *    be polled either: WebGL forbids a sync object from signalling inside
 *    the task that created it. The wait itself costs a span floor — a pass
 *    that draws nothing reads it (0.3 ms on a Mac, 0.5 ms on an iPhone).
 *  - `EXT_disjoint_timer_query_webgl2` (Chromium, on request): GPU
 *    timestamps around each span. On Metal it is command-buffer granular
 *    and reads high: every full-screen pass came out near 1.3 ms where the
 *    readback clock put them at 0.4–0.5 ms, and one query over the whole
 *    frame read 7.2 ms against a 4.7 ms wall-clock wait — while Chromium's
 *    readback readings agree with WebKit's on the same GPU to a few tenths.
 *
 * Both clocks are intrusive on a tile-based GPU (every Apple GPU): a span
 * boundary inside a render pass ends its encoder, so the next draw reopens
 * the pass and reloads the attachments. That per-boundary overhead is
 * estimated from the frames themselves — the object frames' sum against the
 * pass frames' scene pass — and subtracted per draw as `netMs`. Rankings
 * hold; the absolute per-object numbers carry that estimate's error, and an
 * object that the pass would have hidden behind another (tile-based hidden
 * surface removal works within one encoder) reads high.
 *
 * Three kinds of frame, cycled `frames` times each:
 *  - total: one span over the whole composer frame (plus the corner chart
 *    and a one-pixel readback of the canvas, which forces the canvas's own
 *    multisample resolve — the cost `antialias: true` adds at present time,
 *    invisible to every other span).
 *  - passes: one span per enabled composer pass.
 *  - objects: one span per object draw inside the scene pass, through
 *    Object3D's onBeforeRender/onAfterRender.
 * Spans never nest (a timer query cannot), hence the separate frames.
 */

import type * as THREE from 'three';

export interface GpuProfileOptions {
  /** Frames per kind (total, passes, objects). */
  frames?: number;
  /** How many object rows to keep; the rest fold into "everything else". */
  top?: number;
  /** 'timer-query' asks for the GPU timer where one exists (Chromium), to compare the two clocks on one GPU. */
  clock?: 'readback' | 'timer-query';
}

export interface PassRow { name: string; ms: number; share: number }
export interface ObjectRow { label: string; ms: number; netMs: number; draws: number; share: number }

export interface GpuProfileResult {
  clock: 'timer-query' | 'readback';
  framesPerKind: number;
  frame: {
    /** The composer frame's GPU time (query) or GPU wall from the first draw to completion (finish). */
    worldMs: number;
    /** CPU time spent issuing the frame's draws. */
    submitMs: number;
    chartMs: number;
    /** A one-pixel readback of the canvas after the frame: the canvas resolve plus the readback itself. */
    canvasReadbackMs: number;
  };
  passes: PassRow[];
  passSumMs: number;
  objects: ObjectRow[];
  objectSum: { ms: number; draws: number; scenePassMs: number; overheadPerDrawMs: number };
  notes: string[];
}

export interface GpuProfileDeps {
  gl: WebGL2RenderingContext | WebGLRenderingContext;
  /** The composer's passes in order, named for the table. */
  passes: () => readonly { name: string; pass: { render: (...args: unknown[]) => void } }[];
  /** The scene RenderPass draws; the object spans hook every renderable under it. */
  sceneRoot: () => THREE.Object3D | null;
  /** Bind the canvas as the read target (through the renderer, so its state cache stays true). */
  bindScreen: () => void;
}

export interface GpuProfiler {
  /** The animation loop calls this in place of its own draw while `active`. */
  frame: (renderWorld: () => void, renderChart: () => void) => void;
  readonly active: boolean;
  run: (opts?: GpuProfileOptions) => Promise<GpuProfileResult>;
}

interface Span { ms: number; query: WebGLQuery | null; t0: number }

interface Clock {
  mode: GpuProfileResult['clock'];
  begin: () => Span;
  end: (span: Span) => void;
  /** Wait for everything queued so far to complete (the readback wait, whichever clock is on). */
  sync: () => void;
  /** Every ended span has its reading. */
  ready: (spans: readonly Span[]) => boolean;
  /** Fill `ms` on every span; false when the GPU clock was disjoint (readings void). */
  resolve: (spans: readonly Span[]) => boolean;
  dispose: () => void;
}

function makeClock(gl: GpuProfileDeps['gl'], want: 'readback' | 'timer-query'): Clock {
  const gl2 = gl as WebGL2RenderingContext;
  // The private 1×1 target the readback wait reads from. Bound only inside
  // sync(), with the scissor and colour mask lifted for the clear and put
  // back — three's state cache never sees a change.
  const fbo = gl.createFramebuffer();
  const tex = gl.createTexture();
  const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.bindTexture(gl.TEXTURE_2D, prevTex);
  const prevFbo0 = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo0);
  const px = new Uint8Array(4);
  const sync = () => {
    const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const scissor = gl.isEnabled(gl.SCISSOR_TEST);
    const mask = gl.getParameter(gl.COLOR_WRITEMASK) as boolean[];
    const masked = !mask.every(Boolean);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    if (scissor) gl.disable(gl.SCISSOR_TEST);
    if (masked) gl.colorMask(true, true, true, true);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    if (masked) gl.colorMask(mask[0], mask[1], mask[2], mask[3]);
    if (scissor) gl.enable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
  };
  const dispose = () => { gl.deleteFramebuffer(fbo); gl.deleteTexture(tex); };
  const ext = want === 'timer-query' && typeof gl2.createQuery === 'function'
    ? gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null
    : null;
  if (ext) {
    return {
      mode: 'timer-query',
      begin: () => {
        const query = gl2.createQuery();
        gl2.beginQuery(ext.TIME_ELAPSED_EXT, query!);
        return { ms: 0, query, t0: performance.now() };
      },
      end: () => { gl2.endQuery(ext.TIME_ELAPSED_EXT); },
      sync,
      ready: (spans) => spans.every((s) => !s.query || gl2.getQueryParameter(s.query, gl2.QUERY_RESULT_AVAILABLE) === true),
      resolve: (spans) => {
        const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) === true;
        for (const s of spans) {
          if (!s.query) continue;
          s.ms = disjoint ? 0 : Number(gl2.getQueryParameter(s.query, gl2.QUERY_RESULT)) / 1e6;
          gl2.deleteQuery(s.query);
          s.query = null;
        }
        return !disjoint;
      },
      dispose,
    };
  }
  return {
    mode: 'readback',
    begin: () => { sync(); return { ms: 0, query: null, t0: performance.now() }; },
    end: (span) => { sync(); span.ms = performance.now() - span.t0; },
    sync,
    ready: () => true,
    resolve: () => true,
    dispose,
  };
}

/**
 * The row an object files under. Streamed sector tiles, body markers and
 * orbit lines are many objects that are one line item; an unnamed object is
 * named after its nearest named ancestor so "Mesh" never stands alone.
 */
export function objectLabel(o: { name: string; type: string; parent: unknown }, materialType: string): string {
  const name = o.name;
  const sector = /^(\S+) sector /.exec(name);
  if (sector) return `${sector[1]} sectors`;
  if (name.startsWith('marker-')) return 'body markers';
  if (name.startsWith('orbit-')) return 'orbit lines';
  if (name) return name;
  let parent = o.parent as { name: string; parent: unknown } | null;
  for (let i = 0; i < 6 && parent; i++) {
    if (parent.name) return `${parent.name} › ${o.type} (${materialType})`;
    parent = parent.parent as { name: string; parent: unknown } | null;
  }
  return `${o.type} (${materialType})`;
}

export interface ObjectRecord { label: string; ms: number }

/**
 * Per-object rows from the object frames. `scenePassMs` is the scene pass as
 * the pass frames measured it; what the object spans sum to beyond it is the
 * clock's own per-draw cost, spread evenly over the draws and taken back off
 * each row as `netMs`.
 */
export function rankObjects(
  records: readonly ObjectRecord[],
  frames: number,
  scenePassMs: number,
  top: number,
): { rows: ObjectRow[]; sum: GpuProfileResult['objectSum'] } {
  const byLabel = new Map<string, { ms: number; draws: number }>();
  for (const r of records) {
    const row = byLabel.get(r.label) ?? { ms: 0, draws: 0 };
    row.ms += r.ms;
    row.draws += 1;
    byLabel.set(r.label, row);
  }
  const n = Math.max(1, frames);
  const sumMs = records.reduce((a, r) => a + r.ms, 0) / n;
  const drawsPerFrame = records.length / n;
  const overhead = drawsPerFrame > 0 && scenePassMs > 0 ? Math.max(0, (sumMs - scenePassMs) / drawsPerFrame) : 0;
  const netTotal = Math.max(1e-6, sumMs - overhead * drawsPerFrame);
  const rows: ObjectRow[] = [...byLabel.entries()].map(([label, v]) => {
    const ms = v.ms / n;
    const draws = v.draws / n;
    const netMs = Math.max(0, ms - overhead * draws);
    return { label, ms, netMs, draws, share: netMs / netTotal };
  }).sort((a, b) => b.netMs - a.netMs);
  if (rows.length > top) {
    const rest = rows.splice(top);
    rows.push(rest.reduce((acc, r) => ({
      label: `everything else (${rest.length} rows)`,
      ms: acc.ms + r.ms,
      netMs: acc.netMs + r.netMs,
      draws: acc.draws + r.draws,
      share: acc.share + r.share,
    }), { label: '', ms: 0, netMs: 0, draws: 0, share: 0 }));
  }
  return { rows, sum: { ms: sumMs, draws: drawsPerFrame, scenePassMs, overheadPerDrawMs: overhead } };
}

export function rankPasses(records: readonly { name: string; ms: number }[], frames: number): { rows: PassRow[]; sumMs: number } {
  const byName = new Map<string, number>();
  const order: string[] = [];
  for (const r of records) {
    if (!byName.has(r.name)) order.push(r.name);
    byName.set(r.name, (byName.get(r.name) ?? 0) + r.ms);
  }
  const n = Math.max(1, frames);
  const sumMs = [...byName.values()].reduce((a, b) => a + b, 0) / n;
  const rows = order.map((name) => {
    const ms = byName.get(name)! / n;
    return { name, ms, share: sumMs > 0 ? ms / sumMs : 0 };
  });
  return { rows, sumMs };
}

type Renderable = THREE.Object3D & {
  onBeforeRender: (...args: unknown[]) => void;
  onAfterRender: (...args: unknown[]) => void;
};

export function createGpuProfiler(deps: GpuProfileDeps): GpuProfiler {
  let clock: Clock | null = null;
  let active = false;
  let phase: 'total' | 'passes' | 'objects' | 'drain' = 'total';
  let framesPerKind = 0;
  let top = 0;
  let frameInKind = 0;
  let resolveRun: ((r: GpuProfileResult) => void) | null = null;
  let rejectRun: ((e: unknown) => void) | null = null;

  const totals: { world: Span; submitMs: number; chart: Span; readbackMs: number }[] = [];
  const passSpans: { name: string; span: Span }[] = [];
  const objectSpans: { label: string; span: Span }[] = [];
  const pending: Span[] = [];
  const notes: string[] = [];

  // Hooks live for the run and go back to what they replaced.
  const hooked: { pass: { render: (...args: unknown[]) => void }; own: PropertyDescriptor | undefined }[] = [];
  const hookedObjects: { o: Renderable; before: PropertyDescriptor | undefined; after: PropertyDescriptor | undefined }[] = [];
  const hookedSet = new WeakSet<object>();
  const openSpans = new WeakMap<object, Span>();

  function hookPasses() {
    for (const { name, pass } of deps.passes()) {
      const own = Object.getOwnPropertyDescriptor(pass, 'render');
      const orig = pass.render;
      pass.render = function (this: unknown, ...args: unknown[]) {
        if (phase !== 'passes') { orig.apply(this, args); return; }
        const span = clock!.begin();
        orig.apply(this, args);
        clock!.end(span);
        pending.push(span);
        passSpans.push({ name, span });
      };
      hooked.push({ pass, own });
    }
  }

  function hookObjects() {
    const root = deps.sceneRoot();
    if (!root) return;
    root.traverse((node) => {
      const o = node as Renderable & { isMesh?: boolean; isPoints?: boolean; isLine?: boolean; isSprite?: boolean };
      if (!(o.isMesh || o.isPoints || o.isLine || o.isSprite) || hookedSet.has(o)) return;
      hookedSet.add(o);
      const before = Object.getOwnPropertyDescriptor(o, 'onBeforeRender');
      const after = Object.getOwnPropertyDescriptor(o, 'onAfterRender');
      const origBefore = o.onBeforeRender;
      const origAfter = o.onAfterRender;
      o.onBeforeRender = function (this: Renderable, ...args: unknown[]) {
        origBefore.apply(this, args);
        if (phase === 'objects') openSpans.set(this, clock!.begin());
      };
      o.onAfterRender = function (this: Renderable, ...args: unknown[]) {
        const span = phase === 'objects' ? openSpans.get(this) : undefined;
        if (span) {
          clock!.end(span);
          openSpans.delete(this);
          pending.push(span);
          const material = args[4] as { type?: string } | undefined;
          objectSpans.push({ label: objectLabel(this, material?.type ?? '?'), span });
        }
        origAfter.apply(this, args);
      };
      hookedObjects.push({ o, before, after });
    });
  }

  function unhook() {
    for (const { pass, own } of hooked) {
      if (own) Object.defineProperty(pass, 'render', own);
      else delete (pass as { render?: unknown }).render;
    }
    hooked.length = 0;
    for (const { o, before, after } of hookedObjects) {
      if (before) Object.defineProperty(o, 'onBeforeRender', before);
      else delete (o as { onBeforeRender?: unknown }).onBeforeRender;
      if (after) Object.defineProperty(o, 'onAfterRender', after);
      else delete (o as { onAfterRender?: unknown }).onAfterRender;
    }
    hookedObjects.length = 0;
  }

  function finishRun() {
    const ok = clock!.resolve(pending);
    if (!ok) notes.push('The GPU clock reported a disjoint interval during the run: readings are void, run it again.');
    const n = framesPerKind;
    const passRank = rankPasses(passSpans.map((p) => ({ name: p.name, ms: p.span.ms })), n);
    const scene = passRank.rows.find((r) => /RenderPass/.test(r.name));
    const objectRank = rankObjects(objectSpans.map((o) => ({ label: o.label, ms: o.span.ms })), n, scene?.ms ?? 0, top);
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const result: GpuProfileResult = {
      clock: clock!.mode,
      framesPerKind: n,
      frame: {
        worldMs: mean(totals.map((t) => t.world.ms)),
        submitMs: mean(totals.map((t) => t.submitMs)),
        chartMs: mean(totals.map((t) => t.chart.ms)),
        canvasReadbackMs: mean(totals.map((t) => t.readbackMs)),
      },
      passes: passRank.rows,
      passSumMs: passRank.sumMs,
      objects: objectRank.rows,
      objectSum: objectRank.sum,
      notes,
    };
    const done = resolveRun;
    cleanup();
    done?.(result);
  }

  function cleanup() {
    unhook();
    clock?.dispose();
    clock = null;
    active = false;
    resolveRun = null;
    rejectRun = null;
    totals.length = 0;
    passSpans.length = 0;
    objectSpans.length = 0;
    pending.length = 0;
  }

  let drainFrames = 0;
  const readbackPixel = new Uint8Array(4);

  function frame(renderWorld: () => void, renderChart: () => void) {
    if (!active) { renderWorld(); renderChart(); return; }
    try {
      if (phase === 'drain') {
        renderWorld();
        renderChart();
        if (clock!.ready(pending) || ++drainFrames > 240) {
          if (drainFrames > 240) notes.push('Some GPU timer readings never arrived; the run is partial.');
          finishRun();
        }
        return;
      }
      if (phase === 'total') {
        const world = clock!.begin();
        const t0 = performance.now();
        renderWorld();
        const submitMs = performance.now() - t0;
        clock!.end(world);
        const chart = clock!.begin();
        renderChart();
        clock!.end(chart);
        // Everything queued is complete before the canvas is read, so the
        // reading is the canvas's own resolve plus one pixel's trip back.
        const gl = deps.gl;
        deps.bindScreen();
        clock!.sync();
        const r0 = performance.now();
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, readbackPixel);
        const readbackMs = performance.now() - r0;
        pending.push(world, chart);
        totals.push({ world, submitMs, chart, readbackMs });
      } else {
        if (phase === 'objects') hookObjects();
        renderWorld();
        renderChart();
      }
      if (++frameInKind >= framesPerKind) {
        frameInKind = 0;
        phase = phase === 'total' ? 'passes' : phase === 'passes' ? 'objects' : 'drain';
        if (phase === 'drain') drainFrames = 0;
      }
    } catch (err) {
      const fail = rejectRun;
      cleanup();
      fail?.(err);
    }
  }

  function run(opts: GpuProfileOptions = {}): Promise<GpuProfileResult> {
    if (active) return Promise.reject(new Error('A GPU profile is already running'));
    framesPerKind = Math.max(1, Math.round(opts.frames ?? 12));
    top = Math.max(1, Math.round(opts.top ?? 24));
    frameInKind = 0;
    phase = 'total';
    notes.length = 0;
    clock = makeClock(deps.gl, opts.clock ?? 'readback');
    if (clock.mode === 'readback') {
      notes.push('readback clock: each span waits for the GPU; on a tile-based GPU a wait inside a pass also reopens it — netMs is the per-draw reading with that cost taken off.');
    }
    return new Promise((resolve, reject) => {
      resolveRun = resolve;
      rejectRun = reject;
      hookPasses();
      active = true;
    });
  }

  return {
    frame,
    get active() { return active; },
    run,
  };
}
