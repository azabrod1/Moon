/**
 * Per-mode render pass assembly. The shell composer and the no-bloom fallback
 * both take a mode's pass list (one RenderPass per scene) instead of a single
 * hardcoded scene, so a mode that owns private scenes (Descent's sky/world
 * split) renders correctly through either path. Behaviour-preserving for the
 * single-scene modes: a one-element list reduces to today's exact behaviour.
 */
import * as THREE from 'three';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { debugWarn } from '../shared/debug';

/** One scene drawn by the mode's pipeline. Later passes draw over earlier
 * ones; clearDepthBefore starts a fresh depth range (the sky/world split). */
export interface ScenePassSpec {
  scene: THREE.Scene;
  /** Clear the depth buffer before this pass (never valid on the first pass). */
  clearDepthBefore?: boolean;
}

/** DEV in vite/vitest; false (and never throws) anywhere import.meta.env is absent. */
function isDev(): boolean {
  try {
    return Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV);
  } catch {
    return false;
  }
}

/** A later pass with a non-null background repaints over the earlier (sky) pass —
 *  the world scene must keep background null (S1 checklist). Warn in DEV only. */
function warnNonNullLaterBackground(passes: ScenePassSpec[]): void {
  if (!isDev()) return;
  for (let i = 1; i < passes.length; i++) {
    if (passes[i].scene.background !== null) {
      debugWarn(`renderPipeline: pass ${i} scene has a non-null background — it repaints over the earlier pass`);
    }
  }
}

/**
 * Build the configured RenderPass list for a pass spec: the first pass keeps its
 * default full clear; later passes preserve colour and optionally clear depth.
 */
export function assembleScenePasses(passes: ScenePassSpec[], camera: THREE.Camera): RenderPass[] {
  warnNonNullLaterBackground(passes);
  return passes.map((spec, i) => {
    const pass = new RenderPass(spec.scene, camera);
    if (i > 0) {
      pass.clear = false;
      pass.clearDepth = !!spec.clearDepthBefore;
    }
    return pass;
  });
}

/**
 * No-bloom fallback equivalent of the composer's pass chain. A single pass is
 * exactly renderer.render(scene, camera) — identical to the pre-refactor path,
 * no autoClear fiddling. Multiple passes clear once, then draw each scene over
 * the last, clearing depth where the spec asks (the sky/world split).
 */
export function renderPassesDirect(
  renderer: THREE.WebGLRenderer,
  passes: ScenePassSpec[],
  camera: THREE.Camera,
): void {
  if (passes.length === 1) {
    renderer.render(passes[0].scene, camera);
    return;
  }
  const prevAutoClear = renderer.autoClear;
  renderer.autoClear = false;
  renderer.clear();
  for (const spec of passes) {
    if (spec.clearDepthBefore) renderer.clearDepth();
    renderer.render(spec.scene, camera);
  }
  renderer.autoClear = prevAutoClear;
}
