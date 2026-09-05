/**
 * The one durable-fetch seam for textures: start a load, and keep trying until
 * it lands (or the caller stops caring). Every texture the Planetarium streams
 * — planet base maps, Earth's detail maps, moon photos, normal maps — goes
 * through here, so a network hole at load time costs a body its photograph for
 * seconds rather than for the session.
 *
 * Failure handling is the policy in textureRetryPolicy (pure, tested there):
 * capped exponential backoff, per-URL so a flapping connection can't put every
 * body on one ladder. Wake signals — the network coming back, or the tab being
 * looked at again after a laptop sleeps — pull a pending attempt forward
 * instead of letting it wait out the cap.
 *
 * The seam only fetches. What a late texture DOES on arrival stays with the
 * caller (the colour-tier rank swap, the late-slot hand-off), so an arrival
 * five minutes in adopts through exactly the machinery a 4K upgrade uses.
 *
 * Cancelling reaches the attempt in flight, not just the ladder: the transfer
 * is aborted and the decode declined, so a caller that stops caring mid-fetch
 * costs nothing more than the bytes already on the wire.
 */
import type * as THREE from 'three';
import { debugWarn } from '../../shared/debug';
import { loadStreamedTexture } from './textureBitmapLoader';
import {
  DEFAULT_TEXTURE_RETRY_POLICY,
  newTextureRetryState,
  pendingDelayMs,
  scheduleAfterFailure,
  scheduleAfterWake,
  shouldLogFailure,
  startAttempt,
  urlSpread,
  type TextureRetryPolicy,
} from './textureRetryPolicy';

type TimerHandle = ReturnType<typeof setTimeout>;

/** Injection seam for tests: a fake loader, a hand-cranked clock and timer
 *  queue, and a wake signal the test fires itself. */
export interface TextureRetryDeps {
  load(
    url: string,
    onLoad: (tex: THREE.Texture) => void,
    onProgress: undefined,
    onError: (err: unknown) => void,
    /** Consulted by the streamed loader between the bytes landing and the
     *  decode; false once this fetch has been cancelled. */
    stillWanted?: () => boolean,
    /** Aborts the transfer of the attempt in flight. */
    signal?: AbortSignal,
  ): void;
  now(): number;
  setTimer(fn: () => void, delayMs: number): TimerHandle;
  clearTimer(handle: TimerHandle): void;
  /** Register for wake signals; returns the unsubscribe. */
  subscribeWake(fn: () => void): () => void;
  policy: TextureRetryPolicy;
}

export interface DurableTextureFetch {
  /** Stop retrying. A texture that lands after this is disposed, not
   *  delivered — the seam owns it until the hand-off. */
  cancel(): void;
}

export interface DurableTextureRequest {
  url: string;
  /** The texture landed. Fires at most once, and never after `cancel()`. */
  onLoad(tex: THREE.Texture): void;
  /** An attempt failed; the count is the rung the ladder has reached. The
   *  fetch is already scheduled to try again — a caller that has nowhere to
   *  put a late arrival cancels from here. */
  onFailure?(err: unknown, attemptsFailed: number): void;
  /** Identifies the fetch in the failure log (body name, map kind). */
  context?: Record<string, unknown>;
}

// ── Wake signals ────────────────────────────────────────────────────────────
// One pair of listeners for the whole app rather than a pair per pending
// texture: a cold start with the network down leaves a few dozen fetches
// waiting at once, and they all want the same two events.

const wakeSubscribers = new Set<() => void>();
let detachWakeListeners: (() => void) | null = null;

function fireWake(): void {
  // Copy: a subscriber that completes (or cancels) unsubscribes mid-iteration.
  for (const fn of [...wakeSubscribers]) fn();
}

function attachWakeListeners(): void {
  if (detachWakeListeners || typeof window === 'undefined' || typeof document === 'undefined') return;
  const onOnline = () => fireWake();
  // Going away is not news; coming back is. A tab hidden for an hour wakes with
  // whatever wait it was left holding, and this is what cuts it short.
  const onVisibility = () => {
    if (document.visibilityState === 'visible') fireWake();
  };
  window.addEventListener('online', onOnline);
  document.addEventListener('visibilitychange', onVisibility);
  detachWakeListeners = () => {
    window.removeEventListener('online', onOnline);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

function subscribeWakeSignals(fn: () => void): () => void {
  wakeSubscribers.add(fn);
  attachWakeListeners();
  return () => {
    wakeSubscribers.delete(fn);
    if (wakeSubscribers.size === 0 && detachWakeListeners) {
      detachWakeListeners();
      detachWakeListeners = null;
    }
  };
}

function defaultDeps(): TextureRetryDeps {
  return {
    // The probe-guarded bitmap path: decode happens off this thread and the
    // upload skips the flipY CPU repack. This seam briefly went back to the
    // HTMLImageElement loader when an A/B showed bitmaps regressing WebKit's
    // boot — the real cost was the driver's sRGB conversion inside three's
    // immutable texStorage2D allocation, which neither decode path skipped.
    // With streamed maps opting into mutable storage (texturePolicy +
    // patches/three), the bitmap path measures fastest on both engines.
    // Transport failures land in onError and climb this seam's own backoff
    // ladder, unchanged.
    load: (url, onLoad, _onProgress, onError, stillWanted, signal) =>
      loadStreamedTexture(url, onLoad, onError, stillWanted, signal),
    now: () => Date.now(),
    setTimer: (fn, delayMs) => setTimeout(fn, delayMs),
    clearTimer: (handle) => clearTimeout(handle),
    subscribeWake: subscribeWakeSignals,
    policy: DEFAULT_TEXTURE_RETRY_POLICY,
  };
}

/**
 * Fetch a texture, and keep fetching it until it lands. The first attempt is
 * dispatched immediately (a healthy load behaves like a bare loader call, at
 * most one upload-capability probe microtask later); every failure schedules
 * the next one on the backoff ladder, which never runs out.
 */
export function fetchTextureDurably(
  request: DurableTextureRequest,
  overrides: Partial<TextureRetryDeps> = {},
): DurableTextureFetch {
  const deps: TextureRetryDeps = { ...defaultDeps(), ...overrides };
  const spread = urlSpread(request.url);

  let state = newTextureRetryState();
  let timer: TimerHandle | null = null;
  let unsubscribe: (() => void) | null = null;
  let stopped = false;
  // One controller per attempt, so cancelling ends the transfer in flight
  // instead of letting a 4K map finish downloading and decode into a bitmap
  // nobody will draw. Absent where AbortController is (the DOM-free tests):
  // stillWanted alone still declines the decode there.
  let inFlight: AbortController | null = null;

  const clearPending = () => {
    if (timer !== null) {
      deps.clearTimer(timer);
      timer = null;
    }
  };

  const stop = () => {
    stopped = true;
    clearPending();
    inFlight?.abort();
    inFlight = null;
    unsubscribe?.();
    unsubscribe = null;
  };

  const arm = () => {
    clearPending();
    if (stopped) return;
    const delay = pendingDelayMs(state, deps.now());
    if (delay === null) return;
    timer = deps.setTimer(attempt, delay);
  };

  const attempt = () => {
    timer = null;
    if (stopped) return;
    state = startAttempt(state, deps.now());
    inFlight = typeof AbortController === 'function' ? new AbortController() : null;
    deps.load(
      request.url,
      (tex) => {
        if (stopped) {
          // Cancelled while this attempt was in the air. Nothing owns the
          // texture now, and three's loader cannot be aborted, so free it here
          // rather than leaking a decoded image nobody will draw.
          tex.dispose();
          return;
        }
        stop();
        request.onLoad(tex);
      },
      undefined,
      (err) => {
        if (stopped) return;
        state = scheduleAfterFailure(state, deps.now(), spread, deps.policy);
        if (shouldLogFailure(state.attemptsFailed)) {
          debugWarn('Texture load failed, retrying', {
            ...request.context,
            url: request.url,
            attempt: state.attemptsFailed,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
        request.onFailure?.(err, state.attemptsFailed);
        arm();
      },
      () => !stopped,
      inFlight?.signal,
    );
  };

  unsubscribe = deps.subscribeWake(() => {
    if (stopped) return;
    const woken = scheduleAfterWake(state, deps.now(), spread, deps.policy);
    if (woken === state) return; // nothing pending, or already sooner
    state = woken;
    arm();
  });

  attempt();

  return { cancel: stop };
}
