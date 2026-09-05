/**
 * Boot shader warm-up: link every program the live render path needs while
 * the load screen still covers the canvas, so no first gesture (a landing, a
 * surface view, a moon's photo arriving) pays a shader link mid-frame.
 *
 * Three keys every program on the render target bound while it compiles:
 * into a target it builds the linear, un-tone-mapped variant the composer
 * draws; to the canvas, the sRGB tone-mapped one. The planetarium draws
 * through the composer into a linear target on float-capable GPUs and
 * straight to the canvas otherwise — so the compile here binds a target of
 * the live path's kind first. Compiling with the canvas bound on the composer
 * path handed the parallel pass a set the live path never draws, and left
 * the live set to link one blocking wait per program inside the warm-up
 * draw: ~2.3 s of frozen main thread on a cold Metal shader cache (a
 * machine's first visit, and every first visit after a deploy that changes
 * any shader), ~26 dead links on every boot.
 *
 * A link REQUEST is not a program ready to draw. `KHR_parallel_shader_compile`'s
 * COMPLETION_STATUS_KHR says the driver's link job finished; what is left — the
 * driver resolving that job, and the uniform locations three fetches one round
 * trip at a time — is paid by the first call that needs the program, which is
 * three's `onFirstUse` on its first draw. So an unprepared warm draw pays every
 * program's share on a single frame. Measured cold on an Apple GPU it is
 * 1.4-2.9 ms a program: the three the atmosphere shell adds in the boot idle
 * turned a 0.6 ms warm draw into a 4-7 ms one, and a slower GPU pays multiples
 * of that. A RESOLVE PHASE therefore sits between the compile and the draw,
 * forcing one program's share per idle frame (`resolveProgramLinks`), and the
 * draw finds nothing left.
 *
 * Contract, pinned by shaderWarmup.test.ts:
 *  - `compileAsync` runs with a `WebGLRenderTarget` bound when the live path
 *    draws through the composer, and with the canvas (null) bound otherwise
 *    (only bound-vs-canvas enters three's program key — not the target's
 *    format — so a 1×1 8-bit target keys exactly like the composer's
 *    half-float one; the compile always precedes the draw);
 *  - whatever was bound before is restored before anything else runs;
 *  - one real, 1-pixel draw of the scene goes into that same kind of target
 *    (Safari commonly lacks KHR_parallel_shader_compile, where compileAsync
 *    cannot prove that the driver linked anything — the draw forces it);
 *  - the wait on compileAsync is bounded (a hung poll must not hold boot);
 *  - the resolve phase runs between the compile and the draw, one program per
 *    frame by default and every pending program at once when the caller is
 *    behind the load screen (`resolvePerFrame: Infinity`, where a frame yielded
 *    is boot time and the work is paid under the veil either way);
 *  - every step is fail-open: a throw is reported through `onError` and boot
 *    continues, lazy first-draw compilation being the fallback.
 */
import * as THREE from 'three';

/** The slice of three's WebGLProgram the resolve phase touches. `program` is
 *  the raw GL program the driver keys its build on; `getUniforms` is three's
 *  own first-use path, which caches the uniform locations the draw would
 *  otherwise fetch. */
export interface WarmupProgram {
  /** three's `shaderName` — a material's own name, usually empty. */
  readonly name?: string;
  /** three's `shaderType` — the material class, which is what identifies a
   *  slow row when the material was never named. */
  readonly type?: string;
  readonly program?: unknown;
  getUniforms?(): unknown;
}

/** The slice of WebGLRenderer the resolve phase touches (a seam for the
 *  tests). */
export interface ProgramLinkResolver {
  getContext(): WebGLRenderingContext | WebGL2RenderingContext;
  readonly info: { readonly programs?: readonly WarmupProgram[] | null };
}

/** The slice of WebGLRenderer the warm-up touches (a seam for the tests). */
export interface ShaderWarmupRenderer extends ProgramLinkResolver {
  getRenderTarget(): THREE.WebGLRenderTarget | null;
  setRenderTarget(target: THREE.WebGLRenderTarget | null): void;
  compileAsync(scene: THREE.Object3D, camera: THREE.Camera): Promise<unknown>;
  render(scene: THREE.Object3D, camera: THREE.Camera): void;
  getViewport(target: THREE.Vector4): THREE.Vector4;
  setViewport(x: number, y: number, width: number, height: number): void;
  getScissor(target: THREE.Vector4): THREE.Vector4;
  setScissor(x: number, y: number, width: number, height: number): void;
  getScissorTest(): boolean;
  setScissorTest(enabled: boolean): void;
}

export interface ShaderWarmupOptions {
  /** True when the live path renders the scene into a render target (the
   *  composer pipeline); false when it draws straight to the canvas. */
  drawsThroughComposer: boolean;
  /** Invisible probe groups already added to the scene, carrying material
   *  variants that real meshes only reach later. Made visible for the draw. */
  probeGroups: readonly THREE.Group[];
  /** Cap on the compileAsync wait. Default 3000 ms. */
  timeoutMs?: number;
  /** How many programs the resolve phase may force per frame. Default 1 — one
   *  cost to a frame, which is the floor, a program's build being indivisible.
   *  `Infinity` resolves them all in the calling task and yields no frame:
   *  what the load screen covers, where a yielded frame is boot time and the
   *  same total work is paid either way. */
  resolvePerFrame?: number;
  onError?: (stage: 'compile' | 'resolve' | 'restore' | 'warm-draw', err: unknown) => void;
  /** Test seam: the 1×1 target bound for the compile and the draw. */
  createTarget?: () => THREE.WebGLRenderTarget;
  /** Test seam: the frame the resolve phase yields between programs. */
  nextFrame?: () => Promise<void>;
}

export interface ShaderWarmupResult {
  /** Settles once compileAsync's own poll has settled (resolves on rejection
   *  too). Nothing that would upset the poll — disposing a probe material,
   *  judging the program count — may happen before this. */
  compiled: Promise<void>;
  /** One row per program this warm-up forced, in the order they were forced.
   *  Empty when every program the compile touched was already resolved. */
  resolved: ProgramResolveTiming[];
  /** Main-thread cost of the warm draw. With the resolve phase ahead of it
   *  this is the number that says whether anything was left to pay. */
  warmDrawMs: number;
}

/** What forcing one program's link resolution cost. */
export interface ProgramResolveTiming {
  /** The program's material name, or its material type when it has none —
   *  enough to say which program a slow row belongs to. */
  name: string;
  ms: number;
}

export interface ProgramLinkResolveOptions {
  /** Programs forced per frame; default 1, `Infinity` for "all, no yield". */
  perFrame?: number;
  /** Test seam for the frame yielded between programs. */
  nextFrame?: () => Promise<void>;
  onError?: (err: unknown) => void;
}

/** Every program this session has already forced. A driver builds a program
 *  once, so a second forcing is only a wasted frame — and the phase runs again
 *  on every later warm-up, over a program list that only grows. Keyed on
 *  three's program wrapper, which lives exactly as long as the program. */
const resolvedPrograms = new WeakSet<object>();

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 16);
  });
}

/**
 * Force the driver to finish what a link request only started, one program per
 * frame.
 *
 * `compileAsync` resolving means the link JOB is done; on ANGLE/Metal the
 * program is turned into a drawable pipeline lazily, by the first call that
 * needs it. `getProgramParameter(LINK_STATUS)` is the cheapest such call, and
 * `getUniforms()` is what three's first draw would run — doing both here
 * empties the draw instead of merely moving cost inside it.
 *
 * Fail-open in every direction: a context that cannot be read, a program that
 * throws, a driver that reports nothing — none of it may stop a warm-up, whose
 * only job is to spend cost early. A program that threw is not retried: one
 * attempt per program per session, or a broken one costs a frame forever.
 */
export async function resolveProgramLinks(
  renderer: ProgramLinkResolver,
  options: ProgramLinkResolveOptions = {},
): Promise<ProgramResolveTiming[]> {
  const report = (err: unknown): void => {
    try {
      options.onError?.(err);
    } catch {
      /* reporting is best-effort */
    }
  };

  let gl: WebGLRenderingContext | WebGL2RenderingContext;
  let pending: WarmupProgram[];
  try {
    gl = renderer.getContext();
    pending = (renderer.info.programs ?? []).filter(
      (program) => !!program && !!program.program && !resolvedPrograms.has(program),
    );
  } catch (err) {
    report(err);
    return [];
  }
  if (pending.length === 0) return [];

  const asked = options.perFrame ?? 1;
  const bounded = Number.isFinite(asked);
  const perFrame = bounded ? Math.max(1, Math.floor(asked)) : pending.length;
  const yieldFrame = options.nextFrame ?? nextAnimationFrame;
  const timings: ProgramResolveTiming[] = [];

  for (let i = 0; i < pending.length; i += perFrame) {
    // A frame of its own before every group, the first included: the task that
    // awaited the compile is not the place to spend a build on.
    if (bounded) await yieldFrame();
    for (const program of pending.slice(i, i + perFrame)) {
      const started = performance.now();
      resolvedPrograms.add(program);
      try {
        gl.getProgramParameter(program.program as WebGLProgram, gl.LINK_STATUS);
        program.getUniforms?.();
      } catch (err) {
        report(err);
      }
      timings.push({ name: program.name || program.type || '', ms: performance.now() - started });
    }
  }
  return timings;
}

export async function warmUpSceneShaders(
  renderer: ShaderWarmupRenderer,
  scene: THREE.Object3D,
  camera: THREE.PerspectiveCamera,
  options: ShaderWarmupOptions,
): Promise<ShaderWarmupResult> {
  // A reporter that itself throws must not turn a fail-open step into a
  // failure (or reject `compiled`, which the caller waits on).
  const report = (stage: 'compile' | 'resolve' | 'restore' | 'warm-draw', err: unknown): void => {
    try {
      options.onError?.(stage, err);
    } catch {
      /* reporting is best-effort */
    }
  };
  const timeoutMs = options.timeoutMs ?? 3000;

  // compileAsync submits synchronously (program creation + link requests)
  // and then polls; the poll is what the returned promise tracks.
  let target: THREE.WebGLRenderTarget | null = null;
  let compiled: Promise<void> = Promise.resolve();
  const previousTarget = renderer.getRenderTarget();
  try {
    if (options.drawsThroughComposer) {
      target = (options.createTarget ?? (() => new THREE.WebGLRenderTarget(1, 1)))();
    }
    renderer.setRenderTarget(target);
    compiled = renderer.compileAsync(scene, camera).then(
      () => undefined,
      (err) => report('compile', err),
    );
  } catch (err) {
    report('compile', err);
  } finally {
    try {
      renderer.setRenderTarget(previousTarget);
    } catch (err) {
      report('restore', err);
    }
  }

  // The race only guards a hung poll — it cancels no work.
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    compiled,
    new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
  ]);
  clearTimeout(timer);

  // Resolve before the draw, never inside it: an unprepared draw is where
  // every program's deferred build lands at once (see the header).
  const resolved = await resolveProgramLinks(renderer, {
    perFrame: options.resolvePerFrame,
    nextFrame: options.nextFrame,
    onError: (err) => report('resolve', err),
  });

  const drawStarted = performance.now();
  try {
    renderWarmupDraw(renderer, scene, camera, options.probeGroups, target);
  } catch (err) {
    report('warm-draw', err);
  } finally {
    // Only the compile and the draw above use it; the poll behind `compiled`
    // checks program status alone.
    target?.dispose();
  }

  return { compiled, resolved, warmDrawMs: performance.now() - drawStarted };
}

/**
 * One 1-pixel draw of the scene (plus the probe groups) into `renderTarget`
 * — the composer's kind of target on float-capable GPUs, the canvas (null)
 * otherwise — so every program the live path needs is linked under the veil.
 * Culling is disabled for the draw so every currently visible material is
 * submitted even when its body sits behind the boot camera; the probe groups
 * are parked just in front of the camera for it. All renderer and object
 * state touched here is restored before returning.
 */
function renderWarmupDraw(
  renderer: ShaderWarmupRenderer,
  scene: THREE.Object3D,
  camera: THREE.PerspectiveCamera,
  groups: readonly THREE.Group[],
  renderTarget: THREE.WebGLRenderTarget | null,
): void {
  const prevTarget = renderer.getRenderTarget();
  const prevViewport = renderer.getViewport(new THREE.Vector4());
  const prevScissor = renderer.getScissor(new THREE.Vector4());
  const prevScissorTest = renderer.getScissorTest();
  const forward = new THREE.Vector3();
  const forcedFrustumObjects: THREE.Object3D[] = [];
  camera.updateMatrixWorld();
  camera.getWorldDirection(forward);
  const probeDistance = Math.max(camera.near * 4, 1e-6);
  for (const group of groups) {
    group.visible = true;
    group.position.copy(camera.position).addScaledVector(forward, probeDistance);
  }
  scene.traverse((obj) => {
    if (!obj.frustumCulled) return;
    forcedFrustumObjects.push(obj);
    obj.frustumCulled = false;
  });

  try {
    renderer.setRenderTarget(renderTarget);
    renderer.setViewport(0, 0, 1, 1);
    renderer.setScissor(0, 0, 1, 1);
    renderer.setScissorTest(true);
    renderer.render(scene, camera);
  } finally {
    for (const group of groups) group.visible = false;
    for (const obj of forcedFrustumObjects) obj.frustumCulled = true;
    renderer.setRenderTarget(prevTarget);
    renderer.setViewport(prevViewport.x, prevViewport.y, prevViewport.z, prevViewport.w);
    renderer.setScissor(prevScissor.x, prevScissor.y, prevScissor.z, prevScissor.w);
    renderer.setScissorTest(prevScissorTest);
  }
}
