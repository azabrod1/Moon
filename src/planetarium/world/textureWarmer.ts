/**
 * Deferred GPU texture warm-up. three.js uploads a texture to the GPU on the
 * first frame that draws it, which lands the whole bill — synchronous image
 * decode, a 32MB-scale texSubImage2D for a 4K map (four times that for an 8K
 * one), the mipmap build — inside whatever gesture first reveals the body
 * (measured: 100–250ms freezes on landing and vantage swaps). Queueing a
 * texture here right after its image arrives moves that upload to a budgeted
 * per-frame pump on an uneventful frame instead.
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
import { smoothTraceArmed, smoothTraceEvent } from '../smoothnessTrace';

type WarmUpload = (tex: THREE.Texture) => void;

/**
 * What share of a frame the pump may spend uploading.
 *
 * The budget has to be a fraction of the frame, not a constant: 6 ms is a
 * third of a 60 Hz frame and most of a 120 Hz one, so a figure tuned on one
 * display eats the other. Measured at 120 Hz, a fixed 6 ms put the boot warm's
 * 4K maps 16-18 ms apart on adjacent frames, over two vsyncs each.
 */
export const WARM_BUDGET_FRACTION = 0.35;
/** Below this the pump cannot finish anything and the queue never drains. */
export const WARM_BUDGET_FLOOR_MS = 2;
/** The old fixed budget, which a 60 Hz frame still lands on. Never spend more. */
export const WARM_BUDGET_CAP_MS = 6;
/**
 * How long the queue may sit while the pump repays an overrun.
 *
 * An upload is unsliceable and its cost unknowable until it is paid, so the
 * pump can only choose whether to START one — the last upload of a call is
 * what overruns, and that overrun is the price of not slicing. What this
 * bounds is how often the price may be paid: the pump sits out the overrun it
 * caused, and this caps that wait, so a queue always makes progress inside a
 * quarter second however big the maps are.
 */
export const WARM_STARVE_MS = 250;

/** The pump's budget for a frame of this measured length. */
export function warmBudgetMs(frameIntervalMs: number): number {
  if (!Number.isFinite(frameIntervalMs) || frameIntervalMs <= 0) return WARM_BUDGET_CAP_MS;
  const share = frameIntervalMs * WARM_BUDGET_FRACTION;
  return Math.min(WARM_BUDGET_CAP_MS, Math.max(WARM_BUDGET_FLOOR_MS, share));
}

/**
 * Whether the pump may upload this frame. False only while it is repaying an
 * overrun — and never for longer than WARM_STARVE_MS, so a starving queue
 * always gets its forced upload through.
 */
export function warmPumpAllowed(
  nowMs: number,
  repayUntilMs: number,
  lastUploadAtMs: number | null,
): boolean {
  if (nowMs >= repayUntilMs) return true;
  return lastUploadAtMs === null || nowMs - lastUploadAtMs >= WARM_STARVE_MS;
}

let uploadFn: WarmUpload | null = null;
const queue: THREE.Texture[] = [];
// A drained texture stays resident until it is disposed, mutated (which bumps
// Texture.version), or the WebGL context is lost. Remember the uploaded
// version so repeated landed-vantage swaps do not call renderer.initTexture
// again for the same Moon albedo/normal pair every frame.
let warmedVersions = new WeakMap<THREE.Texture, number>();
// When the pump may upload again, and when it last did — the overrun ledger.
let warmRepayUntilMs = 0;
let warmLastUploadAtMs: number | null = null;
// One listener per queued texture, removed on drain or dispose, so long-lived
// textures don't retain warm-up closures for their whole life.
const disposeListeners = new Map<THREE.Texture, () => void>();
// Callers that must not draw a texture before it is resident (a streamed
// surface tile swaps onto its material only once the upload has been paid
// off-gesture) register here; the entry is cleared when the texture drains,
// is disposed, or fails — a callback never fires for a texture nobody can
// draw, and never twice.
export type WarmOutcome = 'warmed' | 'failed' | 'disposed';
const residentCallbacks = new Map<THREE.Texture, (outcome: WarmOutcome) => void>();

/** Inject the upload call (bind renderer.initTexture). Entries queued earlier wait. */
export function bindTextureWarmer(fn: WarmUpload): void {
  uploadFn = fn;
}

/**
 * Queue a texture for warm upload. Idempotent per texture; safe before bind.
 * `onOutcome` (optional) settles exactly once, synchronously, when the entry
 * leaves the queue: 'warmed' right after a successful upload — the seam a
 * caller uses to assign a map ONLY once drawing it is free — 'failed' when
 * the upload threw (the texture is not resident; drawing it would pay the
 * upload on the render path), 'disposed' when the texture was disposed while
 * queued. An already-resident texture settles 'warmed' at once; a re-queue of
 * a pending texture replaces its callback.
 */
export function queueTextureWarm(tex: THREE.Texture, onOutcome?: (outcome: WarmOutcome) => void): void {
  if (warmedVersions.get(tex) === tex.version) {
    onOutcome?.('warmed');
    return;
  }
  if (onOutcome) residentCallbacks.set(tex, onOutcome);
  if (disposeListeners.has(tex)) return;
  const onDispose = () => {
    // A disposed texture must never be warm-uploaded: initTexture would
    // allocate GPU storage that nothing references and nothing ever frees.
    disposeListeners.delete(tex);
    const cb = residentCallbacks.get(tex);
    residentCallbacks.delete(tex);
    const i = queue.indexOf(tex);
    if (i !== -1) queue.splice(i, 1);
    cb?.('disposed');
  };
  disposeListeners.set(tex, onDispose);
  tex.addEventListener('dispose', onDispose);
  queue.push(tex);
}

/**
 * Upload queued textures until the time budget is spent. Always uploads at
 * least one when possible — a single big upload is unsliceable and its cost
 * unknowable until paid — then stops once past budget, so a burst of small
 * maps drains in one call while the biggest single map (an 8K albedo, the
 * largest unsliceable upload the app has) takes its frame alone.
 */
export function pumpTextureWarmQueue(budgetMs: number): void {
  if (!uploadFn || queue.length === 0) return;
  const start = performance.now();
  // Sit out an overrun already owed, unless the queue would starve for it.
  if (!warmPumpAllowed(start, warmRepayUntilMs, warmLastUploadAtMs)) return;
  while (queue.length > 0) {
    const tex = queue.shift()!;
    const onDispose = disposeListeners.get(tex);
    if (onDispose) {
      disposeListeners.delete(tex);
      tex.removeEventListener('dispose', onDispose);
    }
    const perfUpload = import.meta.env.DEV ? surfacePerfBeginTextureUpload(tex) : null;
    // The frame trace wants this upload's own cost, not the pump call's: one
    // pump can drain several small maps, and blaming the frame for the sum
    // hides which map was the unsliceable one.
    const uploadStart = import.meta.env.DEV && smoothTraceArmed() ? performance.now() : 0;
    let uploaded = false;
    try {
      uploadFn(tex);
      uploaded = true;
    } catch (err) {
      // Fail open: drop the entry; the texture uploads lazily on first draw.
      debugWarn('Texture warm upload failed', { err: String(err) });
    } finally {
      if (import.meta.env.DEV) surfacePerfEndTextureUpload(perfUpload);
      if (import.meta.env.DEV && uploadStart) {
        const image = tex.image as { width?: number; height?: number } | undefined;
        // Compressed containers have no name and no image src; the loader
        // stamps the file on userData so the upload is still attributable.
        const source = typeof tex.userData?.sourceUrl === 'string'
          ? tex.userData.sourceUrl.split(/[/?#]/).filter(Boolean).pop()
          : '';
        smoothTraceEvent(
          'upload',
          `${tex.name || source || 'texture'} ${image?.width ?? '?'}x${image?.height ?? '?'}`,
          performance.now() - uploadStart,
        );
      }
    }
    const onOutcome = residentCallbacks.get(tex);
    residentCallbacks.delete(tex);
    if (uploaded) warmedVersions.set(tex, tex.version);
    onOutcome?.(uploaded ? 'warmed' : 'failed');
    warmLastUploadAtMs = performance.now();
    const spent = warmLastUploadAtMs - start;
    if (spent >= budgetMs) {
      // Charge the overrun forward rather than paying another next frame:
      // consecutive big maps are what turn one slow upload into a stutter.
      warmRepayUntilMs = warmLastUploadAtMs + Math.max(0, spent - budgetMs);
      return;
    }
  }
  warmRepayUntilMs = 0;
}

/** A restored WebGL context has no copy of any previously warmed texture. */
export function invalidateTextureWarmCache(): void {
  warmedVersions = new WeakMap();
}

/** Full teardown (mode dispose) and test isolation seam. Entries still
 *  queued settle 'disposed' — the pump will never upload them, and the
 *  exactly-once contract holds through a teardown too. */
export function resetTextureWarmer(): void {
  for (const [tex, onDispose] of disposeListeners) tex.removeEventListener('dispose', onDispose);
  disposeListeners.clear();
  const pending = [...residentCallbacks.values()];
  residentCallbacks.clear();
  queue.length = 0;
  uploadFn = null;
  warmRepayUntilMs = 0;
  warmLastUploadAtMs = null;
  invalidateTextureWarmCache();
  for (const cb of pending) cb('disposed');
}
