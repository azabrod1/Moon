/**
 * Sector tiles decoded to raw bytes, so their upload costs a copy.
 *
 * A 2048² tile is the biggest single upload a flown approach pays. As an
 * ImageBitmap it is a SOURCE the driver has to convert — sRGB-encode, and read
 * back from wherever the browser put the decoded image — and that conversion
 * is charged over the whole image inside the one upload call. A flown approach
 * streams about nineteen tiles in two seconds, so that cost lands once per
 * frame for two seconds, which is what a pilot feels approaching Mars.
 *
 * The same picture as raw RGBA bytes has nothing to convert: the identical
 * single call copies the buffer straight into the texture's storage. Measured
 * on ANGLE Metal with a 2048² sRGB tile under a 4× CPU throttle, uploaded
 * exactly as three uploads it (one texImage2D that allocates and fills, which
 * is what the mutableStorage opt-out buys): 7.3 ms from an ImageBitmap against
 * 1.4 ms from bytes. Same call, same pixels, same residency, a fifth of the
 * cost — the tile stops being the most expensive thing on its frame.
 *
 * Spreading the upload over frames instead was measured and lost on the
 * number that matters. Banded into eight texSubImage2D calls the same bytes
 * cost 5.5 ms in total with a 4.5 ms worst band when each band was synced,
 * and 25.4 ms issued back to back without one; either way the worst frame is
 * worse than the 1.4 ms of a single call, and no reason to prefer bands
 * survives that. So the upload stays one call and the slicer is untouched.
 *
 * What that costs is work moved off the main thread, not work removed. The
 * bitmap path decodes the WebP too; this one adds a full-size draw and a
 * full-size readback — 28.4 ms of decode plus 9.4 ms of readback per tile on
 * the same throttled silicon — and all of it runs in the worker, where a frame
 * is not waiting on it. The main thread sees a buffer arrive and hands it to
 * the GPU.
 *
 * Nothing about the picture changes. The worker flips with a canvas transform
 * so the byte order matches what `createImageBitmap(..., 'flipY')` produces
 * (sectorTileTransform.offsetY assumes that flip), the bytes stay sRGB-encoded
 * RGBA8 exactly as the bitmap upload delivered them, and residency is priced
 * the same — this trades no memory, only what the upload reads from.
 *
 * Fail-open at every step, to today's one-shot bitmap path: no worker or no
 * OffscreenCanvas, a probe that does not come back flipped, a tile whose WebP
 * header says it may carry alpha (the canvas round trip is only exact for
 * opaque images), the in-flight byte budget already spent, `?tilebytes=0`, or
 * any decode error. Each falls back to the exact path that shipped, which
 * costs a frame and never a wrong pixel.
 */
import * as THREE from 'three';
import { debugWarn } from '../../shared/debug';
import {
  decodeBitmapTexture,
  makeStreamedLoader,
  stampSource,
  type TextureLoad,
} from './textureBitmapLoader';

/**
 * Bytes one decoded tile is charged against the budget below, for its whole
 * life in RAM: the largest tile the sets cut, 2048² RGBA. A conservative
 * single figure rather than the real size, so nothing has to be trued up when
 * a smaller tile lands and no accounting depends on the decode succeeding.
 */
export const TILE_PIXEL_RESERVE_BYTES = 2048 * 2048 * 4;

/**
 * How much decoded tile RAM may be in flight at once.
 *
 * A buffer lives from the moment its decode starts until the pump has uploaded
 * it, which is several frames — and a close approach wants about nineteen
 * tiles in two seconds. The streamer's own in-flight cap (1-2 loads on every
 * device profile) already bounds this to one or two tiles; four is the
 * backstop that keeps the figure true if anything else ever streams a tile,
 * and it never binds in normal play.
 */
export const TILE_PIXEL_BUDGET_BYTES = 4 * TILE_PIXEL_RESERVE_BYTES;

/** Decoded tile bytes held right now — reserved at decode, freed at release. */
let heldBytes = 0;

/**
 * What this path has actually done, for a device that can only be questioned
 * through the debug overlay. A worker that failed to load, a probe that came
 * back wrong, or a colour set recut lossless would all leave the app running
 * the old path with no symptom but the old stutter, and no way to tell which.
 */
const counts = { decoded: 0, fellBack: 0 };
const fallbackReasons: Record<string, number> = {};
let probeVerdict: boolean | null = null;

function fellBackBecause(reason: string): void {
  counts.fellBack += 1;
  fallbackReasons[reason] = (fallbackReasons[reason] ?? 0) + 1;
}

/** How the colour tiles are really being uploaded on this device. */
export function tilePixelStats(): {
  enabled: boolean;
  probe: boolean | null;
  decoded: number;
  fellBack: number;
  reasons: Record<string, number>;
  heldBytes: number;
} {
  return {
    enabled: bytePathAllowed(),
    probe: probeVerdict,
    decoded: counts.decoded,
    fellBack: counts.fellBack,
    reasons: { ...fallbackReasons },
    heldBytes,
  };
}

/**
 * `?tilebytes=0` sends every tile down the one-shot bitmap path — the A/B for
 * tile-upload questions, the way `?sectors=0` is the A/B for tile questions at
 * all. It works in a production build on purpose: the stutter this path exists
 * to remove was reported from a phone, and a switch that only exists on a
 * development origin cannot be tried on the device that has the problem.
 * Read once, lazily: module load stays DOM-free.
 */
let bytePathEnabled: boolean | null = null;
function bytePathAllowed(): boolean {
  if (bytePathEnabled === null) {
    bytePathEnabled = !(typeof location !== 'undefined'
      && new URLSearchParams(location.search).get('tilebytes') === '0');
  }
  return bytePathEnabled;
}

/** Whether one more tile fits. Charged before the decode starts, so two tiles
 *  cannot both discover there was room for one. */
export function tilePixelBudgetAllows(held: number): boolean {
  return held + TILE_PIXEL_RESERVE_BYTES <= TILE_PIXEL_BUDGET_BYTES;
}

// ------------------------------------------------------------------ the worker

type WorkerReply =
  | { id: number; ok: true; width: number; height: number; buffer: ArrayBuffer }
  | { id: number; ok: true; probe: true; flipped: boolean }
  | { id: number; ok: false; error: string };

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, (reply: WorkerReply) => void>();

/** One worker for the session: tiles stream the whole time it is close to a
 *  body, and decodes are serial on purpose — the streamer never has more than
 *  two loads in flight, and one at a time keeps the worker holding one tile. */
function ensureWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker !== 'function' || typeof OffscreenCanvas === 'undefined') return null;
  try {
    worker = new Worker(new URL('./tilePixelWorker.ts', import.meta.url), { type: 'module' });
  } catch (err) {
    debugWarn('Tile pixel worker unavailable', { err: String(err) });
    return null;
  }
  worker.onmessage = (event: MessageEvent<WorkerReply>) => {
    const settle = pending.get(event.data.id);
    pending.delete(event.data.id);
    settle?.(event.data);
  };
  // A worker that dies takes every request with it, and a reply that cannot be
  // deserialized never reaches the handler above at all. Either way the
  // requests in flight settle as failures and the worker is dropped, so their
  // callers fall back instead of waiting for a reply that never comes — a
  // request left hanging would hold its share of the byte budget for good, and
  // four of them would turn this path off for the session.
  //
  // The instance is captured rather than read from the module: an error event
  // is dispatched as its own task, and by the time it runs a later `ask` may
  // already have built a replacement — which this would otherwise terminate.
  const dying = worker;
  const abandon = () => {
    if (worker !== dying) return;
    const dead = [...pending.values()];
    pending.clear();
    dying.terminate();
    worker = null;
    for (const settle of dead) settle({ id: 0, ok: false, error: 'worker died' });
  };
  worker.onerror = abandon;
  worker.onmessageerror = abandon;
  return worker;
}

function ask(message: { blob?: Blob; probe?: boolean }): Promise<WorkerReply> {
  const live = ensureWorker();
  if (!live) return Promise.resolve({ id: 0, ok: false, error: 'no worker' } as WorkerReply);
  const id = nextId++;
  return new Promise<WorkerReply>((resolve) => {
    pending.set(id, resolve);
    live.postMessage({ ...message, id });
  });
}

/**
 * The worker round trip, as one replaceable function.
 *
 * Injectable because the byte budget's release paths are the one place a bug
 * turns this path off for a whole session with no symptom but the old stutter
 * — four leaked reservations and every later tile takes the bitmap decoder —
 * and none of them can be driven through a real worker in a unit test.
 * Replacing it also drops the memoised probe verdict, so an injected decoder
 * is asked the capability question itself. Nothing in the app calls this.
 */
let roundTrip = ask;
export function setTilePixelRoundTrip(next: typeof ask | null): void {
  roundTrip = next ?? ask;
  probe = null;
}

/** Decoded tile bytes reserved right now. The counter the fail-open paths all
 *  have to return to zero. */
export function tilePixelHeldBytes(): number {
  return heldBytes;
}

/**
 * Whether this platform's worker really produces flipped opaque bytes.
 *
 * Observed, not sniffed, on the same 1×2 white-over-black round trip the
 * bitmap path probes with: a missing OffscreenCanvas 2D context, a draw that
 * silently fails, or a flip that does not happen all read back wrong here and
 * send every tile down the bitmap path instead.
 */
let probe: Promise<boolean> | null = null;
export function tilePixelPathUsable(): Promise<boolean> {
  probe ??= (async () => {
    const reply = await roundTrip({ probe: true });
    probeVerdict = reply.ok === true && 'probe' in reply && reply.flipped;
    return probeVerdict;
  })();
  return probe;
}

/** Start the probe now, so its worker spin-up overlaps app construction
 *  instead of landing inside the first approach that wants a tile. Skipped
 *  when `?tilebytes=0` has turned the path off, so that arm boots exactly as a
 *  build without this module would and the A/B compares two whole paths. */
export function warmTilePixelWorker(): void {
  if (!bytePathAllowed()) return;
  void tilePixelPathUsable();
}

// ------------------------------------------------------------- the byte texture

/**
 * Whether these bytes are a WebP this path may decode.
 *
 * Only simple lossy WebP (`VP8 `) has no alpha channel at all, and only an
 * opaque image survives the 2D canvas's premultiply/un-premultiply round trip
 * unchanged. The tile pipeline cuts exactly that, and this is the check that
 * keeps the claim true rather than assumed: anything else — lossless, extended,
 * a format that is not WebP — takes the bitmap path, which never reads the
 * pixels back.
 */
export async function isOpaqueWebp(blob: Blob): Promise<boolean> {
  if (blob.size < 16) return false;
  const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  const tag = (at: number) => String.fromCharCode(head[at], head[at + 1], head[at + 2], head[at + 3]);
  return tag(0) === 'RIFF' && tag(8) === 'WEBP' && tag(12) === 'VP8 ';
}

/** What a released buffer leaves behind: the image keeps its size (every byte
 *  figure already stashed was measured from it) and holds no memory. */
const NO_PIXELS = new Uint8Array(0);

/**
 * Free a tile's decoded bytes once its upload is paid, and give the budget
 * back. Idempotent — the dispose hook and the warm outcome both call it, and a
 * released texture must not be charged twice.
 *
 * Safe because a sector never re-uploads: a lost context drops every sector
 * and streams it back in, which is the same reason the bitmap path closes its
 * bitmap here.
 */
export function releaseTilePixels(tex: THREE.Texture): void {
  if (tex.userData?.ownedPixels !== true) return;
  tex.userData.ownedPixels = false;
  const image = tex.image as { data?: unknown } | undefined;
  if (image) image.data = NO_PIXELS;
  tex.userData.sourceReleased = true;
  heldBytes = Math.max(0, heldBytes - TILE_PIXEL_RESERVE_BYTES);
}

/**
 * A tile as a texture backed by bytes this app owns.
 *
 * The three fields a DataTexture defaults differently from the plain Texture
 * the bitmap path builds are set back here — mip filtering, mip generation and
 * the unpack alignment — so the two paths produce the same sampling and the
 * same GPU residency, and only what the upload reads from differs.
 *
 * The mip chain is three's own generateMipmap over the uploaded base, as it is
 * for a bitmap. Building the chain in the worker instead and uploading it
 * level by level was measured at 9.5 ms against 0 for the GPU's own call.
 */
function pixelTexture(buffer: ArrayBuffer, width: number, height: number, url: string): THREE.Texture {
  const tex = new THREE.DataTexture(
    new Uint8Array(buffer), width, height, THREE.RGBAFormat, THREE.UnsignedByteType,
  );
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  // RGBA8 rows are always a multiple of four bytes, so this is exact rather
  // than a padding allowance, and it is what every other map here uploads with.
  tex.unpackAlignment = 4;
  tex.flipY = false; // the worker's canvas transform already flipped the rows
  tex.needsUpdate = true;
  stampSource(tex, url);
  tex.userData.ownedPixels = true;
  // Marked for any consumer that reads the pixels back on the CPU, exactly as
  // the bitmap path marks its baked flip.
  tex.userData.bitmapPreFlipped = true;
  tex.addEventListener('dispose', () => releaseTilePixels(tex));
  return tex;
}

/**
 * Decode a tile to owned bytes, or fall back to today's bitmap texture.
 *
 * The budget is tested and charged in the same turn, with no await between,
 * so two tiles cannot both discover there was room for one; it is given back
 * when the buffer is. Exported for the tests that drive its release paths —
 * the loader around it is the shared one, already covered where it lives.
 */
export async function decodeTileTexture(blob: Blob, url: string): Promise<THREE.Texture> {
  if (!bytePathAllowed()) { fellBackBecause('off'); return decodeBitmapTexture(blob, url); }
  if (!await isOpaqueWebp(blob)) { fellBackBecause('notOpaqueWebp'); return decodeBitmapTexture(blob, url); }
  if (!await tilePixelPathUsable()) { fellBackBecause('noWorker'); return decodeBitmapTexture(blob, url); }
  if (!tilePixelBudgetAllows(heldBytes)) { fellBackBecause('budget'); return decodeBitmapTexture(blob, url); }
  heldBytes += TILE_PIXEL_RESERVE_BYTES;
  let reply: WorkerReply;
  try {
    reply = await roundTrip({ blob });
  } catch (err) {
    heldBytes = Math.max(0, heldBytes - TILE_PIXEL_RESERVE_BYTES);
    fellBackBecause('threw');
    throw err;
  }
  if (!reply.ok || !('buffer' in reply)) {
    heldBytes = Math.max(0, heldBytes - TILE_PIXEL_RESERVE_BYTES);
    fellBackBecause('decodeFailed');
    debugWarn('Tile pixel decode failed; using the bitmap path', {
      url, err: reply.ok ? 'no buffer' : reply.error,
    });
    return decodeBitmapTexture(blob, url);
  }
  counts.decoded += 1;
  return pixelTexture(reply.buffer, reply.width, reply.height, url);
}

/** The loader the sector streamer uses for colour TILES only. Everything else
 *  a sector loads — the relief and roughness crops, a few hundred pixels
 *  square and sub-millisecond in one shot — keeps the shared loader. */
export const loadSectorTileTexture: TextureLoad = makeStreamedLoader(decodeTileTexture);
