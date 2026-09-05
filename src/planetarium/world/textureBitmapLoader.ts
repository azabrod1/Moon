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
 * hands the decode back to this thread only if this thread passed its own
 * probe — else to the shared loader. That handover covers the requests whose
 * bytes are already in hand, not only the next one: a worker retiring
 * mid-decode re-decodes here rather than paying a second download.
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
import { debugLog } from '../../shared/debug';
import { drainErrors } from '../../shared/three/glErrors';

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
  const warm = bootWarmMap();
  const hit = warm?.get(url);
  if (hit) warm!.delete(url);
  return hit;
}

function bootWarmMap(): Map<string, Promise<Response>> | undefined {
  return (globalThis as { __bootTexWarm?: Map<string, Promise<Response>> }).__bootTexWarm;
}

/** Drop a warmed response nobody is going to read. An unread Response body
 *  stays buffered by the browser for as long as the promise is reachable, so
 *  a load that ends up going through the shared loader has to cancel its warm
 *  entry rather than simply leave it in the map. */
function discardBootWarmResponse(url: string): void {
  void takeBootWarmResponse(url)?.then((r) => r.body?.cancel(), () => {}).catch(() => {});
}

/** Let go of every warm response still unclaimed. Call once boot has asked
 *  for everything it is going to ask for — every map in the warm list is
 *  requested while the solar system is built, so anything left after that is
 *  bytes nobody will read. */
export function releaseBootWarmResponses(): void {
  const warm = bootWarmMap();
  if (!warm) return;
  for (const url of [...warm.keys()]) discardBootWarmResponse(url);
  delete (globalThis as { __bootTexWarm?: unknown }).__bootTexWarm;
}

/** What `createImageBitmap` gets from this module: encoded bytes — a fetched
 *  map or the probe's PNG — which a worker takes by structured clone. */
type BitmapSource = Blob;
type BitmapDecoder = (source: BitmapSource, opts: ImageBitmapOptions) => Promise<ImageBitmap>;

/** The bitmap options every streamed map is decoded with. */
const BITMAP_OPTIONS: ImageBitmapOptions = { imageOrientation: 'flipY', premultiplyAlpha: 'none' };

/** A worker reply that never comes must not hold every later map hostage —
 *  but a slow reply is not a dead worker: a phone put in the background
 *  freezes the worker along with the page, and an 8K map on a slow phone
 *  legitimately takes seconds. So the timer raises a suspicion, not a
 *  verdict. On expiry: a hidden page re-arms (frozen alongside us); a visible
 *  page pings the worker — no answer within PING_TIMEOUT_MS retires it and
 *  rejects every request (each falls back to the shared loader); an answer
 *  re-arms once, and a second expiry with a live worker rejects that one
 *  request only, keeping the worker for the rest. */
export const DECODE_TIMEOUT_MS = 30_000;
export const PING_TIMEOUT_MS = 5_000;

/** How long the probe waits for the worker's verdict: a worker that stalls
 *  at boot without an error event would otherwise hold every boot map to
 *  the full decode timeout, past PlanetFactory's own 8 s procedural
 *  fallback. Past this the main thread is probed instead. */
export const PROBE_TIMEOUT_MS = 5_000;

/** The decode worker's whole program: one request in, one bitmap (transferred)
 *  or one error string out, matched by id. A bitmap whose transfer fails is
 *  closed here — an 8K allocation must not linger in a realm nobody can reach
 *  while the caller's fallback decodes the same map again. Plain script,
 *  built as a blob URL, so it needs no bundler plumbing and stays inert in
 *  the DOM-free tests. */
const DECODE_WORKER_SOURCE = `self.onmessage = async (e) => {
  const { id, source, opts } = e.data;
  let bitmap = null;
  try {
    bitmap = await createImageBitmap(source, opts);
    self.postMessage({ id, bitmap }, [bitmap]);
  } catch (err) {
    if (bitmap) { try { bitmap.close(); } catch {} }
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};`;

type DecodeReply = { id: number; bitmap?: ImageBitmap; error?: string };
type PendingDecode = {
  resolve: (b: ImageBitmap) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  /** The worker answered a ping after this request's first expiry. */
  pinged: boolean;
};

/**
 * createImageBitmap hosted in a worker. Requests are matched to replies by
 * id and watched by DECODE_TIMEOUT_MS (see there for what an expiry means);
 * any worker-level failure (construction, script error, an undecodable
 * message, an unanswered ping) rejects every request in flight and retires
 * the worker for good, so the caller's fallback runs once per request,
 * never a retry storm.
 */
export class WorkerBitmapDecoder {
  private worker: Worker | null = null;
  private scriptUrl: string | null = null;
  private readonly pending = new Map<number, PendingDecode>();
  /** Liveness pings in flight: id → answered. */
  private readonly pings = new Map<number, () => void>();
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
      const req: PendingDecode = { resolve, reject, timer: this.arm(id), pinged: false };
      this.pending.set(id, req);
      try {
        this.start().postMessage({ id, source, opts });
      } catch (err) {
        this.retire(err);
      }
    });
  }

  /** Terminate the worker and reject everything in flight; final. */
  retire(reason: unknown): void {
    this.retired = true;
    this.worker?.terminate();
    this.worker = null;
    this.revokeScript();
    const err = reason instanceof Error ? reason : new Error(String(reason));
    for (const req of this.pending.values()) {
      clearTimeout(req.timer);
      req.reject(err);
    }
    this.pending.clear();
    for (const answered of this.pings.values()) answered();
    this.pings.clear();
  }

  private arm(id: number): ReturnType<typeof setTimeout> {
    return setTimeout(() => this.expired(id), DECODE_TIMEOUT_MS);
  }

  private expired(id: number): void {
    const req = this.pending.get(id);
    if (!req) return;
    // Hidden page: the worker is frozen with us; the clock says nothing.
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      req.timer = this.arm(id);
      return;
    }
    if (req.pinged) {
      // The worker answered once already and this decode still has not:
      // that one image is stuck. Its caller falls back; the worker stays.
      this.pending.delete(id);
      req.reject(new Error(`bitmap decode gave up after ${2 * DECODE_TIMEOUT_MS} ms`));
      return;
    }
    req.pinged = true;
    void this.ping().then((alive) => {
      if (!this.pending.has(id)) return;
      if (alive) req.timer = this.arm(id);
      else this.retire(new Error('bitmap decode worker unresponsive'));
    });
  }

  /** Any reply to a request the worker cannot decode is proof of life. */
  private ping(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (!this.worker) {
        resolve(false);
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pings.delete(id);
        resolve(false);
      }, PING_TIMEOUT_MS);
      this.pings.set(id, () => {
        clearTimeout(timer);
        this.pings.delete(id);
        resolve(true);
      });
      try {
        this.worker.postMessage({ id, source: null, opts: {} });
      } catch {
        clearTimeout(timer);
        this.pings.delete(id);
        resolve(false);
      }
    });
  }

  private start(): Worker {
    if (this.worker) return this.worker;
    this.scriptUrl = URL.createObjectURL(new Blob([DECODE_WORKER_SOURCE], { type: 'text/javascript' }));
    const worker = new Worker(this.scriptUrl);
    worker.onmessage = (e: MessageEvent<DecodeReply>) => {
      // The first reply proves the script loaded: its URL can go.
      this.revokeScript();
      const { id, bitmap, error } = e.data;
      const answered = this.pings.get(id);
      if (answered) {
        bitmap?.close();
        answered();
        return;
      }
      const req = this.pending.get(id);
      if (!req) {
        // A reply nobody waits for (its request was rejected by a retire that
        // raced the worker): free the pixels rather than leak them.
        bitmap?.close();
        return;
      }
      this.pending.delete(id);
      clearTimeout(req.timer);
      if (bitmap) req.resolve(bitmap);
      else req.reject(new Error(error ?? 'bitmap decode failed in worker'));
    };
    worker.onerror = (e) => this.retire(new Error(e.message || 'bitmap decode worker error'));
    worker.onmessageerror = () => this.retire(new Error('bitmap decode worker message could not be read'));
    this.worker = worker;
    return worker;
  }

  private revokeScript(): void {
    if (!this.scriptUrl) return;
    URL.revokeObjectURL(this.scriptUrl);
    this.scriptUrl = null;
  }
}

let workerDecoder: WorkerBitmapDecoder | null = null;
const workerDecode: BitmapDecoder = (source, opts) => {
  workerDecoder ??= new WorkerBitmapDecoder();
  return workerDecoder.decode(source, opts);
};
const mainThreadDecode: BitmapDecoder = (source, opts) => createImageBitmap(source, opts);

/** Which realms the probe has seen honour the flip through a real upload. A
 *  realm that was never verified is never used: a worker that fails
 *  mid-session hands over to the main thread only if the main thread passed
 *  its own probe, else to the shared loader. */
const verified = { worker: false, main: false };

/** The decoder to use now, or null for the shared loader. */
function currentDecoder(): BitmapDecoder | null {
  if (verified.worker && (workerDecoder?.usable ?? true)) return workerDecode;
  if (verified.main) return mainThreadDecode;
  return null;
}

let probeVerdict: boolean | null = null;

export type BitmapDecodePath = 'unprobed' | 'worker' | 'main-thread' | 'loader';
/** DEV telemetry: which path streamed maps take right now. */
export function bitmapDecodePath(): BitmapDecodePath {
  if (probeVerdict === null) return 'unprobed';
  const decoder = currentDecoder();
  return decoder === workerDecode ? 'worker' : decoder === mainThreadDecode ? 'main-thread' : 'loader';
}

/** The probe image: a 1×2 PNG, opaque white over opaque black — an encoded
 *  Blob like every real map, so the probe exercises the decoder the maps
 *  will use, not an ImageData shortcut. */
const PROBE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAACCAYAAACZgbYnAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVQI12P4DwQMQPAfAB7rBPzHONLmAAAAAElFTkSuQmCC';
function probeBlob(): Blob {
  const bin = atob(PROBE_PNG_BASE64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bytes.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: 'image/png' });
}

/** Only the full inverted image counts — opaque black over opaque white: a
 *  silently failed draw reads back blank [0,0,0,0], and "red < 128" alone
 *  would call that a pass. */
function inverted(px: Uint8Array | Uint8ClampedArray): boolean {
  return px[0] < 128 && px[3] > 128 && px[4] > 128 && px[7] > 128;
}

/** The renderer the probe uploads through, when the app has one: the real
 *  question is whether a bitmap from this decoder reaches a WebGL texture
 *  intact, which a canvas draw cannot answer (a transferred worker bitmap
 *  has failed exactly there on some WebKit ports). Without it — tests, or a
 *  probe started before the renderer exists — a 2D canvas draw stands in. */
let probeRenderer: THREE.WebGLRenderer | null = null;

/** Upload the probe bitmap as a 1×2 texture, attach it to a framebuffer and
 *  read it back. Every binding and unpack flag it touches is restored, so
 *  three's state cache stays true. Null when the readback could not be
 *  performed at all (no complete framebuffer), so the caller can fall back to
 *  the canvas check rather than call a working decoder broken. */
function readsBackInvertedGl(renderer: THREE.WebGLRenderer, bitmap: ImageBitmap): boolean | null {
  const gl = renderer.getContext();
  const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
  const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  const prevFlip = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL) as boolean;
  const prevPremul = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL) as boolean;
  const prevColorspace = gl.getParameter(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL) as number;
  const tex = gl.createTexture();
  const fbo = gl.createFramebuffer();
  try {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    renderer.state.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return null;
    // readPixels row 0 is texture row 0, which is the image's top row: the
    // same order as a canvas getImageData, so the same check applies.
    const px = new Uint8Array(8);
    gl.readPixels(0, 0, 1, 2, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return inverted(px);
  } catch {
    return null;
  } finally {
    renderer.state.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
    gl.bindTexture(gl.TEXTURE_2D, prevTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, prevFlip);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, prevPremul);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, prevColorspace);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(tex);
    drainErrors(gl); // a failed probe must not leave an error for the next caller
  }
}

function readsBackInverted2d(bitmap: ImageBitmap): boolean {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 2;
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  ctx.drawImage(bitmap, 0, 0);
  return inverted(ctx.getImageData(0, 0, 1, 2).data);
}

/** Decode the probe image with the production options through one decoder
 *  and check the result the way a map is consumed. False on any failure or
 *  past PROBE_TIMEOUT_MS. */
async function decoderHonoursFlip(decoder: BitmapDecoder): Promise<{ ok: boolean; viaGl: boolean }> {
  let viaGl = false;
  let timedOut = false;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  const decode = decoder(probeBlob(), BITMAP_OPTIONS);
  // A decode that lands after the timeout has given up produces a bitmap
  // nobody will look at; free it rather than wait for GC.
  void decode.then((late) => { if (timedOut) late.close(); }, () => {});
  try {
    const bitmap = await Promise.race([
      decode,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => {
          timedOut = true;
          reject(new Error('probe timed out'));
        }, PROBE_TIMEOUT_MS);
      }),
    ]);
    try {
      const gl = probeRenderer ? readsBackInvertedGl(probeRenderer, bitmap) : null;
      viaGl = gl !== null;
      return { ok: gl ?? readsBackInverted2d(bitmap), viaGl };
    } finally {
      bitmap.close();
    }
  } catch {
    return { ok: false, viaGl };
  } finally {
    if (deadline !== null) clearTimeout(deadline);
  }
}

/**
 * Whether this platform can bake the vertical flip into `createImageBitmap`:
 * the probe image is decoded with the production options and read back —
 * through the worker (which then serves every real image) and on this thread
 * (the fallback realm), each verified on its own. Probed lazily on the first
 * load: module load must stay DOM-free for the tests.
 */
let bitmapFlipProbe: Promise<boolean> | null = null;
function bitmapUploadUsable(): Promise<boolean> {
  bitmapFlipProbe ??= (async () => {
    if (typeof createImageBitmap !== 'function') return false;
    // Both realms at once. They share nothing but the renderer's state cache,
    // which each probe touches and restores synchronously, and probing in
    // series cost a stalled worker's whole PROBE_TIMEOUT_MS before this thread
    // was even asked. The verdict still prefers the worker.
    const [work, main] = await Promise.all([
      typeof Worker === 'function' ? decoderHonoursFlip(workerDecode) : { ok: false, viaGl: false },
      decoderHonoursFlip(mainThreadDecode),
    ]);
    verified.worker = work.ok;
    verified.main = main.ok;
    const viaGl = work.viaGl || main.viaGl;
    // A worker that exists but failed its one job has no use: free it.
    if (typeof Worker === 'function' && !verified.worker) {
      workerDecoder?.retire(new Error('bitmap decode worker failed the flip probe'));
    }
    // One line a device report can be read from: which realms passed, and
    // whether the readback went through a real texture upload.
    debugLog('Texture bitmap probe', { worker: verified.worker, main: verified.main, viaGl });
    return verified.worker || verified.main;
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
  // Chosen now, not before the fetch: a worker that retired while the bytes
  // were in the air hands these bytes to the main thread if it is verified;
  // with no verified realm left the caller's one loader fallback takes over.
  const decoder = currentDecoder();
  if (!decoder) throw new Error(`no verified bitmap decoder for ${url}`);
  let bitmap: ImageBitmap;
  try {
    bitmap = await decoder(blob, BITMAP_OPTIONS);
  } catch (err) {
    // The bytes are already here. A worker that RETIRED while they were in
    // the air must not cost a second download when this thread passed its
    // own probe — the next map would take this thread anyway. A worker that
    // is still alive and refused this one image (an allocation failure, a
    // decode that never finished) keeps to the single loader fallback: a
    // second full-size decode of the same bytes is the cost this seam exists
    // to avoid, and it would fail the same way.
    if (decoder === mainThreadDecode || !verified.main || workerDecoder?.usable !== false) throw err;
    // The worker's failure took time; interest may have lapsed meanwhile, and
    // a full-size decode for nobody is what this seam exists to avoid.
    if ((stillWanted && !stillWanted()) || signal?.aborted) {
      throw new TextureTransportError(`superseded: ${url}`);
    }
    bitmap = await mainThreadDecode(blob, BITMAP_OPTIONS);
  }
  const tex = new THREE.Texture(bitmap);
  tex.flipY = false; // baked into the bitmap above
  tex.needsUpdate = true;
  // ImageBitmaps carry no src, so stamp the texture for the perf/debug
  // telemetry that identifies uploads by their image's URL.
  tex.name = url.split(/[?#]/)[0].split('/').filter(Boolean).pop() ?? url;
  tex.userData.sourceUrl = url;
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
    discardBootWarmResponse(url);
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
    // No verified decoder left (the worker retired and this thread never
    // passed its probe): the shared loader, before any fetch is spent.
    if (!usable || !currentDecoder()) {
      discardBootWarmResponse(url);
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
export function warmBitmapUploadProbe(renderer?: THREE.WebGLRenderer): void {
  if (renderer) probeRenderer = renderer;
  if (typeof createImageBitmap === 'function') void bitmapUploadUsable();
}

/** Test seam: force the probe verdict (pass null to restore the real probe).
 *  A forced pass verifies the main thread unless told which realms passed. */
export function setBitmapProbeForTests(result: boolean | null, realms?: { worker?: boolean; main?: boolean }): void {
  bitmapFlipProbe = result === null ? null : Promise.resolve(result);
  probeVerdict = result;
  verified.worker = realms?.worker ?? false;
  verified.main = realms?.main ?? (result === true && !realms?.worker);
  workerDecoder = null;
  probeRenderer = null;
}
