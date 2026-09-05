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
 *  - every step is fail-open: a throw is reported through `onError` and boot
 *    continues, lazy first-draw compilation being the fallback.
 */
import * as THREE from 'three';

/** The slice of WebGLRenderer the warm-up touches (a seam for the tests). */
export interface ShaderWarmupRenderer {
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
  onError?: (stage: 'compile' | 'restore' | 'warm-draw', err: unknown) => void;
  /** Test seam: the 1×1 target bound for the compile and the draw. */
  createTarget?: () => THREE.WebGLRenderTarget;
}

export interface ShaderWarmupResult {
  /** Settles once compileAsync's own poll has settled (resolves on rejection
   *  too). Nothing that would upset the poll — disposing a probe material,
   *  judging the program count — may happen before this. */
  compiled: Promise<void>;
}

export async function warmUpSceneShaders(
  renderer: ShaderWarmupRenderer,
  scene: THREE.Object3D,
  camera: THREE.PerspectiveCamera,
  options: ShaderWarmupOptions,
): Promise<ShaderWarmupResult> {
  // A reporter that itself throws must not turn a fail-open step into a
  // failure (or reject `compiled`, which the caller waits on).
  const report = (stage: 'compile' | 'restore' | 'warm-draw', err: unknown): void => {
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

  try {
    renderWarmupDraw(renderer, scene, camera, options.probeGroups, target);
  } catch (err) {
    report('warm-draw', err);
  } finally {
    // Only the compile and the draw above use it; the poll behind `compiled`
    // checks program status alone.
    target?.dispose();
  }

  return { compiled };
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
