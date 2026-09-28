/**
 * The KTX2 transcoder's lifetime: made for the first compressed rung a
 * session fetches, let go once it has had nothing to do for a while.
 *
 * three's KTX2Loader transcodes on a pool of up to four workers, each running
 * the Basis transcoder in a WebAssembly instance of its own. An instance's
 * memory grows to fit the largest container it has transcoded and never
 * shrinks, so after the first 8K rungs the pool keeps that high-water mark for
 * as long as the loader lives — on an M5 Max, WebKit's "WebAssembly Memory"
 * went from 58 to 180 MiB after the first rungs and stayed there for the rest
 * of the session. How much a worker keeps is the engine's and the container's
 * business, not this module's; what is certain is that it is held for work
 * that comes in bursts. An arrival fetches its rungs within seconds of each
 * other, and after that nothing is transcoded until the next arrival, a swap
 * down under memory pressure, or a lost context's re-fetch.
 *
 * So the loader is disposed — its workers terminated, which returns their
 * memory, and its worker script's URL revoked — once no transcode has been in
 * flight for KTX2_IDLE_DISPOSE_MS, and the next rung makes a fresh one. A
 * disposed loader is never reused: the URL its workers are built from is
 * revoked, so a second life would start workers that never load and a
 * transcode that never settles. The price of a fresh one is the transcoder's
 * script and binary again (from the HTTP cache; the service worker does not
 * hold `basis/`) and a compile per worker it starts.
 *
 * Disposing also lets go of each worker's last reply. The pool keeps the
 * settled promise of the last task it gave a worker, and the reply's message
 * event keeps that transcode's transferred mip buffers alive whatever the
 * texture has done with them since — so a compressed rung the ladder has
 * trimmed down to its tail (textureLadder's releaseUpgradeSource) is only
 * really out of memory once its worker has moved on or been let go.
 *
 * The pool's size is left alone. An arrival asks for several rungs at once,
 * and a single worker would transcode them one after another, holding the
 * arrival's veil for the sum instead of the longest.
 *
 * Never disposed with a transcode in flight: every load holds a lease from
 * the moment it is asked for until its loader settles it (onLoad or onError),
 * and the idle clock only starts when the last lease is returned. A load
 * arriving while the clock runs stops it; one arriving after the dispose
 * makes the new loader. DOM-free: the factory and the timer are injected.
 */

/**
 * How long the transcoder may sit idle before it is let go.
 *
 * Long enough to cover the gaps inside one burst of rungs: an arrival's
 * landing pair climbs 4K then 8K as the glide closes in, a few seconds apart,
 * and a rung that fails is retried after 8 s, then 16 s — each of which would
 * otherwise pay the transcoder's start-up again for work that is plainly
 * still going on. Short against the minutes a player spends parked, orbiting
 * or landed after it, which is when the pool's memory is pure waste.
 */
export const KTX2_IDLE_DISPOSE_MS = 30_000;

/** The one timer this module needs. */
export interface IdleTimer {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimer: IdleTimer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** What a caller gets for one transcode: the loader to run it on, and the
 *  call that says it has settled. `release` is idempotent, because a
 *  loader's onLoad and onError can both reach it for the same load. */
export interface LoaderLease<L> {
  loader: Promise<L>;
  release(): void;
}

/** The keeper's state, for the DEV bridge and the `?debug=1` memory line. */
export interface IdleLoaderState {
  /** Transcodes asked for and not yet settled. */
  inFlight: number;
  /** Whether a loader exists (or is being made) right now. */
  alive: boolean;
  /** Loaders let go so far this session. */
  disposedCount: number;
}

export class IdleLoaderKeeper<L extends { dispose(): void }> {
  private current: Promise<L> | null = null;
  private inFlight = 0;
  private idle: unknown = null;
  private disposedCount = 0;

  constructor(
    private readonly create: () => Promise<L>,
    private readonly idleMs = KTX2_IDLE_DISPOSE_MS,
    private readonly timer: IdleTimer = realTimer,
  ) {}

  /** Take a lease for one transcode, making the loader if there is none. */
  acquire(): LoaderLease<L> {
    this.cancelIdle();
    this.inFlight++;
    if (!this.current) {
      // A factory that throws is a loader that could not be made, which the
      // caller hears through the promise like any other failure — the lease
      // it holds is still returned through release.
      try {
        this.current = this.create();
      } catch (err) {
        this.current = Promise.reject(err);
      }
    }
    let released = false;
    return {
      loader: this.current,
      release: () => {
        if (released) return;
        released = true;
        this.inFlight--;
        if (this.inFlight === 0) this.armIdle();
      },
    };
  }

  state(): IdleLoaderState {
    return { inFlight: this.inFlight, alive: this.current !== null, disposedCount: this.disposedCount };
  }

  private armIdle(): void {
    this.cancelIdle();
    this.idle = this.timer.set(() => {
      this.idle = null;
      this.letGo();
    }, this.idleMs);
  }

  private cancelIdle(): void {
    if (this.idle === null) return;
    this.timer.clear(this.idle);
    this.idle = null;
  }

  private letGo(): void {
    if (this.inFlight > 0 || !this.current) return;
    const loader = this.current;
    this.current = null;
    this.disposedCount++;
    // Every lease has been returned, so the loader's promise has settled; a
    // loader that could not be made has nothing to free, and dropping it is
    // what lets the next rung try again.
    loader.then((made) => made.dispose(), () => {});
  }
}
