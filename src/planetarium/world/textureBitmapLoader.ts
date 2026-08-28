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
 * Guarded by observation, not feature sniffing: a 1x2 readback probe must
 * come back actually inverted before any real image takes this path. Anything
 * else — API missing, option ignored, draw failed — falls closed to the
 * shared `textureLoader`, whose worst case is the old slower upload, never a
 * flipped map.
 *
 * One transfer per URL: callers that ask for the same map while it is in the
 * air share the bytes and each decode their own bitmap, so a texture stays
 * one caller's to close or dispose. The transfer is abandoned only when the
 * last of them drops it.
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

/**
 * Whether this platform can bake the vertical flip into `createImageBitmap`.
 * A 1x2 white-over-black bitmap is created with `imageOrientation: 'flipY'`
 * and read back — only the full inverted image (opaque black over opaque
 * white) counts as support: a silently failed draw reads back blank
 * [0,0,0,0], and "red < 128" alone would call that a pass. Probed lazily on
 * the first load: module load must stay DOM-free for the tests.
 */
let bitmapFlipProbe: Promise<boolean> | null = null;
function bitmapUploadUsable(): Promise<boolean> {
  bitmapFlipProbe ??= (async () => {
    try {
      if (typeof createImageBitmap !== 'function') return false;
      const sample = new ImageData(1, 2);
      sample.data.set([255, 255, 255, 255, 0, 0, 0, 255]);
      const bitmap = await createImageBitmap(sample, { imageOrientation: 'flipY' });
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
    } catch {
      return false;
    }
  })();
  return bitmapFlipProbe;
}

interface SharedFetch {
  bytes: Promise<Blob>;
  abort: AbortController;
  waiters: number;
  settled: boolean;
}

/**
 * Transfers in flight, by URL. The same map is asked for by several callers
 * at once as a matter of course — four sibling sectors sample the same crop
 * of their coarse ancestor, and a tier upgrade can want a map the boot warm
 * is already fetching — and four identical requests would each take a slot
 * out of the caller's fetch pool for one file. One transfer serves every
 * waiter; each still decodes its own bitmap, so it owns an image it may
 * close or dispose without touching anyone else's. The transfer ends only
 * when the LAST waiter drops it: one caller losing interest must not cancel
 * the bytes another is still waiting for.
 */
const sharedFetches = new Map<string, SharedFetch>();

function fetchSharedBlob(url: string, signal?: AbortSignal): Promise<Blob> {
  let entry = sharedFetches.get(url);
  if (!entry) {
    const created: SharedFetch = { bytes: null as unknown as Promise<Blob>, abort: new AbortController(), waiters: 0, settled: false };
    created.bytes = (async () => {
      try {
        const response = await (takeBootWarmResponse(url) ?? fetch(url, { signal: created.abort.signal }));
        if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
        return await response.blob();
      } finally {
        created.settled = true;
        if (sharedFetches.get(url) === created) sharedFetches.delete(url);
      }
    })();
    // Every waiter attaches its own handlers below; this keeps a failure from
    // being reported as unhandled in the turn before they do.
    created.bytes.catch(() => {});
    sharedFetches.set(url, created);
    entry = created;
  }
  const held = entry;
  held.waiters += 1;
  let dropped = false;
  const drop = () => {
    if (dropped) return;
    dropped = true;
    held.waiters -= 1;
    if (held.waiters === 0 && !held.settled) {
      if (sharedFetches.get(url) === held) sharedFetches.delete(url);
      held.abort.abort();
    }
  };
  signal?.addEventListener('abort', drop, { once: true });
  return held.bytes.then(
    (blob) => { signal?.removeEventListener('abort', drop); drop(); return blob; },
    (err) => { signal?.removeEventListener('abort', drop); drop(); throw err; },
  );
}

/** Fetch a map as an ImageBitmap with the flip baked in, wrapped in a texture
 *  that knows not to flip again. */
async function loadBitmapTexture(url: string, stillWanted?: () => boolean, signal?: AbortSignal): Promise<THREE.Texture> {
  let blob: Blob;
  try {
    blob = await fetchSharedBlob(url, signal);
  } catch (err) {
    throw new TextureTransportError(err instanceof Error ? err.message : String(err));
  }
  // The transfer is shared, so it lands even for a caller that aborted while
  // it was in the air — that caller stops here rather than decoding.
  if (signal?.aborted) {
    throw new TextureTransportError(`aborted: ${url}`);
  }
  // The bytes cannot be recalled, but the decode can be declined: an attempt
  // superseded while they were in the air stops here, before a full-size
  // bitmap (~128MB at 8K) is created for nobody. Reported as a transport
  // error: the caller's own staleness guard makes it a no-op.
  if (stillWanted && !stillWanted()) {
    throw new TextureTransportError(`superseded: ${url}`);
  }
  const bitmap = await createImageBitmap(blob, {
    imageOrientation: 'flipY',
    premultiplyAlpha: 'none',
  });
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

/** Test seam: force the probe verdict (pass null to restore the real probe). */
export function setBitmapProbeForTests(result: boolean | null): void {
  bitmapFlipProbe = result === null ? null : Promise.resolve(result);
}
