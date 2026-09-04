/**
 * The upload-friendly texture decode path, shared by every streamed map: the
 * boot set through the durable-fetch seam (textureRetry) and the colour-tier
 * ladder (PlanetFactory). Honouring `flipY` on an HTMLImageElement texture
 * costs a synchronous CPU repack of the entire decoded image INSIDE
 * `texSubImage2D`; `createImageBitmap` with the flip baked in decodes off
 * this thread and uploads without that pass. (The other half of the upload
 * bill — the driver's sRGB conversion into an immutable texStorage2D
 * allocation — is paid by BOTH decode paths, and is what texturePolicy's
 * `mutableStorage` opt-out plus patches/three removes.)
 *
 * The bitmap is created in a dedicated worker, not here. Blink applies the
 * baked flip on the thread that called `createImageBitmap`, as the promise
 * resolves: measured at 7 ms per 2K map and 30 ms per 4K map of main-thread
 * time under a 4× CPU throttle (planning/_bitmap-cost.log), the tail of
 * every phone boot and a hitch on every tier upgrade in flight — against
 * 0.3 ms when the same call runs in a worker and the bitmap is transferred
 * back (zero-copy). A worker that cannot be made, or that fails mid-session,
 * hands the decode back to this thread with the same options.
 *
 * Guarded by observation, not feature sniffing: a 1x2 readback probe must
 * come back actually inverted before any real image takes this path — and it
 * runs through the same decoder the real images will use, so the verdict
 * covers the worker, the option and the transfer together. Anything else —
 * API missing, option ignored, draw failed — falls closed to the shared
 * `textureLoader`, whose worst case is the old slower upload, never a
 * flipped map.
 *
 * Failure taxonomy: transport errors (HTTP status, network, stream) surface
 * to the caller's onError, so retry ladders and tier cooldowns behave exactly
 * as they always did. A decode failure on a real image is different — the
 * probe passed on a sample, but this platform balked at the full-size decode
 * (size limits, memory pressure) — so one fallback load through the
 * HTMLImageElement path is spent before surfacing the error.
 */
import * as THREE from 'three';

/** The app's texture loader. Shared so every fetch carries the same settings
 *  (and so the fallback here, the retry seam, and the tier queue stand behind
 *  one loader). */
export const textureLoader = new THREE.TextureLoader();
textureLoader.crossOrigin = 'anonymous';

export type TextureLoad = (
  url: string,
  onLoad: (tex: THREE.Texture) => void,
  onError: (err: unknown) => void,
  /** Consulted between the fetch landing and the decode: a caller whose
   *  interest can lapse mid-flight (a superseded tier attempt) declines the
   *  decode here, sparing a full-size bitmap nobody will draw. The image
   *  path never needed this — its decode was always deferred to the apply
   *  callback, behind the caller's own staleness guard. */
  stillWanted?: () => boolean,
  /** Aborts the fetch itself. A caller that stops wanting a texture while
   *  its bytes are still in the air (a sector released mid-pan) ends the
   *  transfer here rather than letting it complete for nobody. The image
   *  path cannot abort; it only declines the decode. */
  signal?: AbortSignal,
) => void;

/** Thrown for transport failures — the cases where re-fetching through
 *  another decoder cannot help. */
export class TextureTransportError extends Error {}

/**
 * The boot fetch-warm handoff. index.html starts a plain fetch() for every
 * boot map at HTML parse and stashes the promises under this global — a
 * <link rel="preload" as="fetch"> would look equivalent, but WebKit never
 * matches such a preload to a later fetch() whatever the credentials mode,
 * so on Safari every boot map downloaded twice. Each entry is taken AT MOST
 * ONCE: a Response body is single-use, and a taken entry must never serve a
 * later retry (a warmed rejection falls through to the durable ladder's own
 * fresh fetch).
 */
export function takeBootWarmResponse(url: string): Promise<Response> | undefined {
  const warm = (globalThis as { __bootTexWarm?: Map<string, Promise<Response>> }).__bootTexWarm;
  const hit = warm?.get(url);
  if (hit) warm!.delete(url);
  return hit;
}

/** What `createImageBitmap` accepts from this module: the fetched bytes, or
 *  the probe's sample. Both are structured-cloneable, so a worker can take
 *  either. */
type BitmapSource = Blob | ImageData;
type BitmapDecoder = (source: BitmapSource, opts: ImageBitmapOptions) => Promise<ImageBitmap>;

/** The bitmap options every streamed map is decoded with. */
const BITMAP_OPTIONS: ImageBitmapOptions = { imageOrientation: 'flipY', premultiplyAlpha: 'none' };

/** The decode worker's whole program: one request in, one bitmap (transferred)
 *  or one error string out, matched by id. Plain script, built as a blob URL,
 *  so it needs no bundler plumbing and stays inert in the DOM-free tests. */
const DECODE_WORKER_SOURCE = `self.onmessage = async (e) => {
  const { id, source, opts } = e.data;
  try {
    const bitmap = await createImageBitmap(source, opts);
    self.postMessage({ id, bitmap }, [bitmap]);
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};`;

type DecodeReply = { id: number; bitmap?: ImageBitmap; error?: string };

/**
 * createImageBitmap hosted in a worker. Requests are matched to replies by
 * id; any worker-level failure (construction, script error, an undecodable
 * message) rejects every request in flight and retires the worker for good,
 * so the caller's fallback runs once per request, never a retry storm.
 */
export class WorkerBitmapDecoder {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, { resolve: (b: ImageBitmap) => void; reject: (e: unknown) => void }>();
  private nextId = 1;
  private retired = false;

  /** False once the worker has failed (or could never be made). */
  get usable(): boolean {
    return !this.retired;
  }

  decode(source: BitmapSource, opts: ImageBitmapOptions): Promise<ImageBitmap> {
    if (this.retired) return Promise.reject(new Error('bitmap decode worker retired'));
    return new Promise<ImageBitmap>((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      try {
        this.start().postMessage({ id, source, opts });
      } catch (err) {
        this.retire(err);
      }
    });
  }

  private start(): Worker {
    if (this.worker) return this.worker;
    const url = URL.createObjectURL(new Blob([DECODE_WORKER_SOURCE], { type: 'text/javascript' }));
    const worker = new Worker(url);
    worker.onmessage = (e: MessageEvent<DecodeReply>) => {
      const { id, bitmap, error } = e.data;
      const req = this.pending.get(id);
      if (!req) {
        // A reply nobody waits for (its request was rejected by a retire that
        // raced the worker): free the pixels rather than leak them.
        bitmap?.close();
        return;
      }
      this.pending.delete(id);
      if (bitmap) req.resolve(bitmap);
      else req.reject(new Error(error ?? 'bitmap decode failed in worker'));
    };
    worker.onerror = (e) => this.retire(e.message || e);
    worker.onmessageerror = () => this.retire(new Error('bitmap decode worker message could not be read'));
    this.worker = worker;
    return worker;
  }

  private retire(reason: unknown): void {
    this.retired = true;
    this.worker?.terminate();
    this.worker = null;
    const err = reason instanceof Error ? reason : new Error(String(reason));
    for (const req of this.pending.values()) req.reject(err);
    this.pending.clear();
  }
}

let workerDecoder: WorkerBitmapDecoder | null = null;
function workerDecode(source: BitmapSource, opts: ImageBitmapOptions): Promise<ImageBitmap> {
  workerDecoder ??= new WorkerBitmapDecoder();
  return workerDecoder.decode(source, opts);
}
const mainThreadDecode: BitmapDecoder = (source, opts) => createImageBitmap(source, opts);

/** The decoder in use: the worker while it is healthy, this thread after a
 *  worker failure (same options — the flip is honoured wherever
 *  createImageBitmap runs, the probe checked the option, not the thread). */
function currentDecoder(): BitmapDecoder {
  return workerAllowed && (workerDecoder?.usable ?? true) ? workerDecode : mainThreadDecode;
}
let workerAllowed = false;

export type BitmapDecodePath = 'unprobed' | 'worker' | 'main-thread' | 'loader';
/** DEV telemetry: which path the flip probe settled on. */
export function bitmapDecodePath(): BitmapDecodePath {
  if (bitmapFlipProbe === null || probeVerdict === null) return 'unprobed';
  if (!probeVerdict) return 'loader';
  return currentDecoder() === workerDecode ? 'worker' : 'main-thread';
}
let probeVerdict: boolean | null = null;

/** Draw a 1x2 bitmap and read it back: true only for the full inverted
 *  image (opaque black over opaque white) — a silently failed draw reads back
 *  blank [0,0,0,0], and "red < 128" alone would call that a pass. */
function readsBackInverted(bitmap: ImageBitmap): boolean {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 2;
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    ctx.drawImage(bitmap, 0, 0);
    const px = ctx.getImageData(0, 0, 1, 2).data;
    return px[0] < 128 && px[3] > 128 && px[4] > 128 && px[7] > 128;
  } finally {
    bitmap.close();
  }
}

/**
 * Whether this platform can bake the vertical flip into `createImageBitmap`.
 * A 1x2 white-over-black sample is created with `imageOrientation: 'flipY'`
 * and read back — first through the worker (which then serves every real
 * image), else on this thread. Probed lazily on the first load: module load
 * must stay DOM-free for the tests.
 */
let bitmapFlipProbe: Promise<boolean> | null = null;
function bitmapUploadUsable(): Promise<boolean> {
  bitmapFlipProbe ??= (async () => {
    try {
      if (typeof createImageBitmap !== 'function') return false;
      const sample = new ImageData(1, 2);
      sample.data.set([255, 255, 255, 255, 0, 0, 0, 255]);
      const flipOnly: ImageBitmapOptions = { imageOrientation: 'flipY' };
      if (typeof Worker === 'function') {
        try {
          if (readsBackInverted(await workerDecode(sample, flipOnly))) {
            workerAllowed = true;
            return true;
          }
        } catch {
          // The worker could not be made or failed its first job: the
          // main-thread probe below decides, and the worker stays retired.
        }
      }
      return readsBackInverted(await createImageBitmap(sample, flipOnly));
    } catch {
      return false;
    }
  })().then((ok) => {
    probeVerdict = ok;
    return ok;
  });
  return bitmapFlipProbe;
}

/** Fetch a map as an ImageBitmap with the flip baked in, wrapped in a texture
 *  that knows not to flip again. */
async function loadBitmapTexture(url: string, stillWanted?: () => boolean, signal?: AbortSignal): Promise<THREE.Texture> {
  let blob: Blob;
  try {
    const response = await (takeBootWarmResponse(url) ?? fetch(url, { signal }));
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    blob = await response.blob();
  } catch (err) {
    throw new TextureTransportError(err instanceof Error ? err.message : String(err));
  }
  // The fetch itself cannot be recalled, but the decode can be declined: an
  // attempt superseded while its bytes were in the air stops here, before a
  // full-size bitmap (~128MB at 8K) is created for nobody. Reported as a
  // transport error: the caller's own staleness guard makes it a no-op.
  if (stillWanted && !stillWanted()) {
    throw new TextureTransportError(`superseded: ${url}`);
  }
  const bitmap = await currentDecoder()(blob, BITMAP_OPTIONS);
  const tex = new THREE.Texture(bitmap);
  tex.flipY = false; // baked into the bitmap above
  tex.needsUpdate = true;
  // ImageBitmaps carry no src, so stamp the texture for the perf/debug
  // telemetry that identifies uploads by their image's URL — and mark the
  // baked flip for any consumer that reads the pixels back on the CPU.
  tex.name = url.split(/[?#]/)[0].split('/').filter(Boolean).pop() ?? url;
  tex.userData.sourceUrl = url;
  tex.userData.bitmapPreFlipped = true;
  // The GPU copy made at upload is independent of the bitmap, and an applied
  // texture must KEEP its image (three re-uploads from it after a context
  // loss) — but a disposed texture is done for good, and without this the
  // decoded bitmap (~128MB at 8K) lingers until GC notices.
  tex.addEventListener('dispose', () => bitmap.close());
  return tex;
}

/**
 * Load a texture through the bitmap path when the probe allows it, the shared
 * `textureLoader` otherwise. The seam both the durable fetch and the tier
 * ladder call.
 */
export const loadStreamedTexture: TextureLoad = (url, onLoad, onError, stillWanted, signal) => {
  // No API means no probe to wait for: fall back synchronously, preserving
  // the bare-loader timing (three's own loader also dispatches sync). This is
  // also the path the DOM-free tests drive their injected loaders through.
  if (typeof createImageBitmap !== 'function') {
    textureLoader.load(url, onLoad, undefined, onError);
    return;
  }
  bitmapUploadUsable().then((usable) => {
    // Interest can lapse while the one-time probe is still resolving; don't
    // even start the fetch for an attempt already superseded.
    if ((stillWanted && !stillWanted()) || signal?.aborted) {
      onError(new TextureTransportError(`superseded: ${url}`));
      return;
    }
    if (!usable) {
      textureLoader.load(url, onLoad, undefined, onError);
      return;
    }
    loadBitmapTexture(url, stillWanted, signal).then(onLoad, (err) => {
      if (err instanceof TextureTransportError) onError(err);
      // A decode failure spends one fallback load — but not for a caller
      // whose interest lapsed mid-decode: that would re-fetch for nobody.
      else if (stillWanted && !stillWanted()) onError(err);
      else textureLoader.load(url, onLoad, undefined, onError);
    });
  });
};

/** Start the one-time flip probe now, so its round through the microtask
 *  queue (bitmap create + canvas readback) overlaps app construction instead
 *  of gating the first streamed fetch — every boot texture waits on the
 *  verdict before its network request is even issued. Call once from app
 *  init; module load itself must stay DOM-free for the tests. */
export function warmBitmapUploadProbe(): void {
  if (typeof createImageBitmap === 'function') void bitmapUploadUsable();
}

/** Test seam: force the probe verdict (pass null to restore the real probe),
 *  which also resets the decoder choice to the main thread. */
export function setBitmapProbeForTests(result: boolean | null): void {
  bitmapFlipProbe = result === null ? null : Promise.resolve(result);
  probeVerdict = result;
  workerAllowed = false;
  workerDecoder = null;
}
