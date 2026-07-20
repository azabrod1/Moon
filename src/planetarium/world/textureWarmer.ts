/**
 * Deferred GPU texture warm-up. three.js uploads a texture to the GPU on the
 * first frame that draws it, which lands the whole bill — synchronous image
 * decode, a 32MB-scale texSubImage2D for a 4K map, the mipmap build — inside
 * whatever gesture first reveals the body (measured: 100–250ms freezes on
 * landing and vantage swaps). Queueing a texture here right after its image
 * arrives moves that upload to a budgeted per-frame pump on an uneventful
 * frame instead.
 *
 * Fail-open by design: if the pump never runs, an entry is disposed before
 * its turn, or an upload throws, the texture simply uploads lazily on first
 * draw exactly as it would without this module. Nothing here may delay or
 * change what is drawn — texture assignment and mesh visibility stay the
 * callers' business.
 *
 * The upload function is injected (the mode binds renderer.initTexture) so
 * the queue is unit-testable without a GL context — the same seam pattern as
 * MoonPainter's injected paint.
 */
import * as THREE from 'three';
import { debugWarn } from '../../shared/debug';
import { surfacePerfBeginTextureUpload, surfacePerfEndTextureUpload } from '../surfacePerf';

type WarmUpload = (tex: THREE.Texture) => void;

let uploadFn: WarmUpload | null = null;
const queue: THREE.Texture[] = [];
// A drained texture stays resident until it is disposed, mutated (which bumps
// Texture.version), or the WebGL context is lost. Remember the uploaded
// version so repeated landed-vantage swaps do not call renderer.initTexture
// again for the same Moon albedo/normal pair every frame.
let warmedVersions = new WeakMap<THREE.Texture, number>();
// One listener per queued texture, removed on drain or dispose, so long-lived
// textures don't retain warm-up closures for their whole life.
const disposeListeners = new Map<THREE.Texture, () => void>();

/** Inject the upload call (bind renderer.initTexture). Entries queued earlier wait. */
export function bindTextureWarmer(fn: WarmUpload): void {
  uploadFn = fn;
}

/** Queue a texture for warm upload. Idempotent per texture; safe before bind. */
export function queueTextureWarm(tex: THREE.Texture): void {
  if (warmedVersions.get(tex) === tex.version) return;
  if (disposeListeners.has(tex)) return;
  const onDispose = () => {
    // A disposed texture must never be warm-uploaded: initTexture would
    // allocate GPU storage that nothing references and nothing ever frees.
    disposeListeners.delete(tex);
    const i = queue.indexOf(tex);
    if (i !== -1) queue.splice(i, 1);
  };
  disposeListeners.set(tex, onDispose);
  tex.addEventListener('dispose', onDispose);
  queue.push(tex);
}

/**
 * Upload queued textures until the time budget is spent. Always uploads at
 * least one when possible — a single big upload is unsliceable and its cost
 * unknowable until paid — then stops once past budget, so a burst of small
 * maps drains in one call while a 4K map takes its frame alone.
 */
export function pumpTextureWarmQueue(budgetMs: number): void {
  if (!uploadFn) return;
  const start = performance.now();
  while (queue.length > 0) {
    const tex = queue.shift()!;
    const onDispose = disposeListeners.get(tex);
    if (onDispose) {
      disposeListeners.delete(tex);
      tex.removeEventListener('dispose', onDispose);
    }
    const perfUpload = import.meta.env.DEV ? surfacePerfBeginTextureUpload(tex) : null;
    let uploaded = false;
    try {
      uploadFn(tex);
      uploaded = true;
    } catch (err) {
      // Fail open: drop the entry; the texture uploads lazily on first draw.
      debugWarn('Texture warm upload failed', { err: String(err) });
    } finally {
      if (import.meta.env.DEV) surfacePerfEndTextureUpload(perfUpload);
    }
    if (uploaded) warmedVersions.set(tex, tex.version);
    if (performance.now() - start >= budgetMs) return;
  }
}

/** A restored WebGL context has no copy of any previously warmed texture. */
export function invalidateTextureWarmCache(): void {
  warmedVersions = new WeakMap();
}

/** Full teardown (mode dispose) and test isolation seam. */
export function resetTextureWarmer(): void {
  for (const [tex, onDispose] of disposeListeners) tex.removeEventListener('dispose', onDispose);
  disposeListeners.clear();
  queue.length = 0;
  uploadFn = null;
  invalidateTextureWarmCache();
}
